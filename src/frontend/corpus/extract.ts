import {
    isRendererUnitId,
    shouldCollectInlineMathUnits,
} from "../../shared";
import {supportsDiagramSourceSearch} from "../../shared/code-block-language";
import {
    collectSearchableBlocks,
    createRendererElementFilter,
    ownEmbeddedSearchUnit,
} from "../blocks";
import type {CollectSearchableBlocksOptions} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import {
    createEmbeddedSourceReader,
    recordEmbeddedOrder,
} from "../embedded-order";
import {isUnderNonHeadingCssFold} from "../fold-dom";
import {
    DIAGRAM_SUBTYPE_SET,
    collectRendererSearchUnits,
    isCompletedEmptyMermaid,
    rendererAdapterKind,
    type DiagramSubtype,
} from "../renderer-adapters";
import {postJson} from "./api";
import {readAvSearchQuery} from "./av";
import {resolveEmbedQuery} from "./embed-query";
import {
    createOffscreenHost,
    offscreenWysiwyg,
    renderOffscreenBlocks,
    type OffscreenRenderMode,
} from "./offscreen";
import {
    freezeBlock,
    type CachedUnit,
} from "./units";

const DOM_BATCH_SIZE = 64;
const DOM_BATCH_CONCURRENCY = 4;

export interface ExtractedUnits {
    blocks: SearchableBlock[];
    /** 渲染失败或没有取到可用 DOM 的块 */
    unrenderedIds: string[];
    missingIds: string[];
    /** 卸掉离屏宿主。替换写回前可以先用仍然连着的 textNodes。 */
    dispose: () => void;
}
async function fetchBlockDoms(
    ids: string[],
    notebookId: string,
    withEmbed: boolean,
    shouldContinue: () => boolean,
    signal?: AbortSignal,
    rootId = "",
): Promise<{doms: Record<string, string>; unresolvedEmbedIds: string[];} | null> {
    const body: Record<string, unknown> = {ids};
    if (notebookId) {
        body.notebook = notebookId;
    }
    const paths = ["/api/block/getBlockDOMs"];
    for (const path of paths) {
        if (!shouldContinue()) {
            return null;
        }
        try {
            const response = await postJson<Record<string, string>>(path, body, signal);
            if (!shouldContinue()) {
                return null;
            }
            if (response && typeof response === "object") {
                if (!withEmbed) return {doms: response, unresolvedEmbedIds: []};
                const doms: Record<string, string> = {};
                const unresolvedEmbedIds: string[] = [];
                // Bound native SQL queries separately from renderer waves.
                for (let start = 0; start < ids.length; start += 2) {
                    if (!shouldContinue() || signal?.aborted) return null;
                    const resolved = await Promise.all(
                        ids.slice(start, start + 2).map(async id => {
                            const html = response[id];
                            return {
                                id,
                                html: typeof html === "string" ?
                                    await resolveEmbedQuery(id, html, rootId, notebookId, shouldContinue, signal) :
                                    null,
                            };
                        }),
                    );
                    for (const item of resolved) {
                        if (item.html !== null) doms[item.id] = item.html;
                        else unresolvedEmbedIds.push(item.id);
                    }
                }
                return {doms, unresolvedEmbedIds};
            }
        } catch {
            // 下一种接口
        }
    }
    return null;
}
function keepOwnedUnits(blocks: SearchableBlock[], ownerId: string, embed: boolean): SearchableBlock[] {
    if (!embed) {
        return blocks.filter((block) => block.blockId === ownerId);
    }
    return blocks.map((block) => ownEmbeddedSearchUnit(block, ownerId));
}

/** Keep carrier references, not field values, in the embed's versioned DOM cache. */
export function collectEmbeddedAvCarriers(
    owner: HTMLElement,
    options: CollectSearchableBlocksOptions,
): {blocks: SearchableBlock[]; incomplete: boolean;} {
    const blocks: SearchableBlock[] = [];
    if (options.includeAttributeView === false) return {blocks, incomplete: false};
    const accepts = createRendererElementFilter(options);
    const sourceOf = createEmbeddedSourceReader();
    let incomplete = false;
    for (const element of owner.querySelectorAll<HTMLElement>('[data-type="NodeAttributeView"]')) {
        // The carrier is only a reference to the source database.  Even a partly
        // mounted AV still needs its unloaded rows from the paged API; mounted
        // cells are filtered later from the live coverage map.
        if (!accepts(element)) continue;
        const blockId = element.dataset.nodeId?.trim();
        const avId = element.dataset.avId?.trim();
        if (!blockId || !avId) {
            incomplete = true;
            continue;
        }
        blocks.push({
            blockId,
            blockType: "NodeAttributeView",
            blockIndex: 0,
            element,
            text: "",
            textNodes: [],
            unitId: "av-carrier",
            embeddedSourceId: sourceOf(element, blockId),
            embeddedAvRef: {
                blockId,
                avId,
                updated: element.getAttribute("updated") ?? "",
                carrierViewId: element.getAttribute("custom-sy-av-view")?.trim() ||
                    element.querySelector<HTMLElement>(".av__views .item--focus")?.dataset.id?.trim() || "",
                query: readAvSearchQuery(element),
            },
        });
    }
    return {blocks, incomplete};
}

export function rendererOutputCompleted(element: HTMLElement): boolean {
    const kind = rendererAdapterKind(element);
    if (!kind || element.querySelector(".ft__error")) {
        return false;
    }
    if (kind === "math") {
        return Boolean(element.querySelector(".katex-html"));
    }
    if (kind === "html") {
        return Boolean(element.querySelector("protyle-html")?.shadowRoot);
    }
    // Official Mermaid completes empty source with a ZWSP shell rather than SVG.
    // data-render alone is insufficient for nonempty source: it is set before await render().
    if (kind === "mermaid" && isCompletedEmptyMermaid(element)) {
        return true;
    }
    return Array.from(element.querySelectorAll("svg, canvas, img")).some((output) =>
        !output.closest(".protyle-icons, .protyle-attr")
    );
}

function markUnrenderedSpecial(
    blocks: SearchableBlock[],
    unrendered: Set<string>,
    ownerId: string,
    root: ParentNode,
    expectedDiagramLanguage?: string,
    inspectInlineMath = true,
    acceptsElement: (element: HTMLElement) => boolean = () => true,
    element = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(ownerId)}"]`),
): SearchableBlock[] {
    const expectedDiagram = Boolean(expectedDiagramLanguage && DIAGRAM_SUBTYPE_SET.has(expectedDiagramLanguage));
    const failedOutput = Boolean(element?.querySelector(".ft__error"));
    if (
        element?.hasAttribute("data-content") &&
        supportsDiagramSourceSearch(expectedDiagramLanguage ?? element.dataset.subtype ?? "")
    ) {
        // 有效的空源码也是完整结果。错误 SVG 不妨碍源码搜索，不能丢掉兜底单元。
        return blocks;
    }
    if ((element && rendererAdapterKind(element)) || expectedDiagram) {
        const owned = blocks.filter((block) => block.blockId === ownerId);
        const meaningful = owned.some((block) => {
            if (expectedDiagram && !isRendererUnitId(block.unitId)) {
                return false;
            }
            return Boolean(block.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim());
        });
        const completed = element && rendererOutputCompleted(element);
        if (failedOutput || (!meaningful && !completed)) {
            unrendered.add(ownerId);
        }
    }
    if (
        inspectInlineMath && element &&
        Array.from(element.querySelectorAll<HTMLElement>('span[data-type~="inline-math"]')).some((span) =>
            Boolean(span.getAttribute("data-content")) && !span.querySelector(".katex-html") &&
            acceptsElement(span)
        )
    ) {
        unrendered.add(ownerId);
    }
    if (failedOutput) {
        return blocks.filter((block) => block.blockId !== ownerId || !isRendererUnitId(block.unitId));
    }
    return blocks;
}

/** Only detached copies are moved. Keep source IDs and render at most two embedded diagrams per wave. */
async function renderEmbeddedDiagrams(
    root: HTMLElement,
    acceptsElement: (element: HTMLElement) => boolean,
    shouldContinue: () => boolean,
    forceRender: boolean,
): Promise<void> {
    const diagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-type="NodeCodeBlock"]')).filter((element) =>
        DIAGRAM_SUBTYPE_SET.has(element.dataset.subtype ?? "") &&
        !supportsDiagramSourceSearch(element.dataset.subtype ?? "") && acceptsElement(element) &&
        (!rendererOutputCompleted(element) || (forceRender && isUnderNonHeadingCssFold(element)))
    );
    if (diagrams.length === 0) {
        return;
    }
    const host = createOffscreenHost();
    const wysiwyg = offscreenWysiwyg(host);
    try {
        for (let index = 0; index < diagrams.length && shouldContinue(); index += 2) {
            const pair = diagrams.slice(index, index + 2).map((element) => {
                const place = document.createComment("page-search-diagram");
                element.replaceWith(place);
                wysiwyg.appendChild(element);
                return {element, place};
            });
            try {
                await renderOffscreenBlocks(wysiwyg, "diagram", shouldContinue, forceRender);
            } finally {
                pair.forEach(({element, place}) => place.replaceWith(element));
            }
        }
    } finally {
        host.remove();
    }
}

/**
 * 把块 DOM 挂到离屏编辑器，复用 collectSearchableBlocks。
 * 只保留该块自己的 unit；嵌入块把内部正文记在嵌入块 id 上。
 * Mermaid / flowchart 直接采集源码；其余 renderer 沿用可见 Text 采集。
 */
export async function extractUnitsFromDoms(
    ids: string[],
    doms: Record<string, string>,
    options: CollectSearchableBlocksOptions,
    embedIds: ReadonlySet<string>,
    mode: OffscreenRenderMode = "light",
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
    codeLanguages?: ReadonlyMap<string, string>,
    forceDiagramRender = false,
    recoveryAttribute?: string,
): Promise<ExtractedUnits> {
    const blocks: SearchableBlock[] = [];
    const unrenderedIds: string[] = [];
    const missingIds: string[] = [];
    if (ids.length === 0) {
        return {blocks, unrenderedIds, missingIds, dispose: () => undefined};
    }

    const host = createOffscreenHost();
    const wysiwyg = offscreenWysiwyg(host);
    const acceptsRenderer = createRendererElementFilter(options);
    const acceptsElement = (element: HTMLElement) =>
        acceptsRenderer(element) &&
        (!recoveryAttribute || element.hasAttribute(recoveryAttribute));
    try {
        for (const id of ids) {
            const html = doms[id];
            if (!html) {
                missingIds.push(id);
                continue;
            }
            const wrap = document.createElement("div");
            wrap.innerHTML = html;
            const node = wrap.firstElementChild;
            if (node) {
                const language = codeLanguages?.get(id);
                // blocks.subtype 不保存代码语言。即使搜索元数据已经识别出 Mermaid，
                // getBlockDOMs 返回的根 DOM 在部分路径中仍可能没有 data-subtype；
                // 思源 renderer 只按这个属性选块，所以要把同一有效语言带到离屏克隆。
                if (language && DIAGRAM_SUBTYPE_SET.has(language)) {
                    const codeBlock = node.matches(`[data-node-id="${CSS.escape(id)}"][data-type="NodeCodeBlock"]`) ?
                        node as HTMLElement :
                        node.querySelector<HTMLElement>(
                            `[data-node-id="${CSS.escape(id)}"][data-type="NodeCodeBlock"]`,
                        );
                    if (codeBlock && !codeBlock.getAttribute("data-subtype")) {
                        codeBlock.setAttribute("data-subtype", language);
                    }
                }
                wysiwyg.appendChild(node);
            } else {
                missingIds.push(id);
            }
        }
        if (mode !== "none") {
            await renderOffscreenBlocks(wysiwyg, mode, shouldContinue, forceDiagramRender);
            if (embedIds.size > 0 && mode === "light" && shouldContinue()) {
                for (const id of ids) {
                    if (!embedIds.has(id) || !shouldContinue()) {
                        continue;
                    }
                    const owner = wysiwyg.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
                    if (owner) {
                        await renderEmbeddedDiagrams(owner, acceptsElement, shouldContinue, forceDiagramRender);
                    }
                }
            }
        }
        if (!shouldContinue()) {
            return {blocks, unrenderedIds, missingIds, dispose: () => host.remove()};
        }
        const collected = collectSearchableBlocks(host, {
            ...options,
            includeDocTitle: false,
            includeAttributeView: false,
            includeEmbedBlock: false,
        });
        const unrendered = new Set<string>(missingIds);
        for (const id of ids) {
            if (unrendered.has(id)) {
                continue;
            }
            const owner = wysiwyg.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
            if (!owner) {
                missingIds.push(id);
                unrendered.add(id);
                continue;
            }
            // Collect each embed independently: source IDs can repeat in sibling embeds.
            let sourceBlocks = embedIds.has(id) ?
                collectSearchableBlocks(host, {
                    ...options,
                    scopeRoots: [owner],
                    preserveEmbedSourceIds: true,
                    includeDocTitle: false,
                    includeAttributeView: false,
                }) :
                collected;
            if (embedIds.has(id) && options.includeAttributeView !== false && !recoveryAttribute) {
                const carriers = collectEmbeddedAvCarriers(owner, options);
                if (carriers.incomplete) unrendered.add(id);
                if (carriers.blocks.length) {
                    sourceBlocks.push(...carriers.blocks);
                    recordEmbeddedOrder(owner, sourceBlocks);
                }
            }
            if (embedIds.has(id) && mode !== "none") {
                const incomplete = new Set<string>();
                const bySource = new Map<HTMLElement, SearchableBlock[]>();
                for (const block of sourceBlocks) {
                    const source = block.element.closest<HTMLElement>("[data-node-id][data-type]");
                    if (!source) continue;
                    const list = bySource.get(source) ?? [];
                    list.push(block);
                    bySource.set(source, list);
                }
                const rejected = new Set<SearchableBlock>();
                owner.querySelectorAll<HTMLElement>("[data-node-id][data-type]").forEach((child) => {
                    if (!rendererAdapterKind(child) || !acceptsElement(child)) {
                        return;
                    }
                    const owned = bySource.get(child) ?? [];
                    const kept = new Set(markUnrenderedSpecial(
                        owned,
                        incomplete,
                        child.dataset.nodeId!,
                        owner,
                        undefined,
                        shouldCollectInlineMathUnits(options.restrictInlineTypes),
                        acceptsElement,
                        child,
                    ));
                    owned.forEach((block) => {
                        if (!kept.has(block)) {
                            rejected.add(block);
                        }
                    });
                });
                sourceBlocks = sourceBlocks.filter((block) => !rejected.has(block));
                if (incomplete.size > 0) {
                    unrendered.add(id);
                }
            }
            let owned = keepOwnedUnits(sourceBlocks, id, embedIds.has(id));
            const language = codeLanguages?.get(id);
            // 某些内核版本返回的代码块 DOM 没有 data-subtype。上面已尽量补到
            // 克隆节点，但若结构异常导致采集器仍看不到它，直接按已确认的围栏
            // 语言再跑一次 adapter，保持 renderer 身份和正文排除规则一致。
            if (
                language && DIAGRAM_SUBTYPE_SET.has(language) &&
                !owned.some((block) => isRendererUnitId(block.unitId))
            ) {
                const element = wysiwyg.querySelector<HTMLElement>(
                    `[data-node-id="${CSS.escape(id)}"]`,
                );
                if (element) {
                    owned = owned.concat(collectRendererSearchUnits(element, {
                        blockId: id,
                        blockType: element.getAttribute("data-type") ?? "NodeCodeBlock",
                        blockIndex: 0,
                    }, language as DiagramSubtype));
                }
            }
            const rewritten = markUnrenderedSpecial(
                owned,
                unrendered,
                id,
                wysiwyg,
                language,
                mode !== "none" && shouldCollectInlineMathUnits(options.restrictInlineTypes),
                acceptsElement,
            );
            for (const block of rewritten) {
                const text = block.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
                // 普通 Text 的空白可被精确搜索；renderer 的缩进/装饰空白仍按 meaningful 规则过滤。
                const ordinaryText = (!block.matchSource || block.matchSource === "text") &&
                    !isRendererUnitId(block.unitId) &&
                    (block.blockType === "NodeParagraph" || block.blockType === "NodeHeading" ||
                        block.blockType === "NodeCodeBlock" || block.blockType === "NodeTable");
                if (!block.embeddedAvRef && !(ordinaryText ? text.length : text.trim().length)) {
                    continue;
                }
                blocks.push(block);
            }
        }
        unrenderedIds.push(...unrendered);
        return {blocks, unrenderedIds, missingIds, dispose: () => host.remove()};
    } catch (error) {
        host.remove();
        throw error;
    }
}

/**
 * 折叠提示/列表中的图表可能仍挂在编辑器里，但 renderer 只留下了部分 SVG。
 * 复制当前 live DOM（而不是重新取内核 DOM）可以保留未保存修改，同时在离屏宿主
 * 中强制完整渲染；失败时调用方仍可回退到原 live 单元。
 */
export async function extractDiagramUnitsFromLive(
    blocks: readonly SearchableBlock[],
    options: CollectSearchableBlocksOptions,
    codeLanguages?: ReadonlyMap<string, string>,
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
): Promise<ExtractedUnits> {
    const doms: Record<string, string> = {};
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
        const id = block.blockId?.trim();
        if (!id || seen.has(id) || !block.element.outerHTML) {
            continue;
        }
        seen.add(id);
        ids.push(id);
        doms[id] = block.element.outerHTML;
    }
    return extractUnitsFromDoms(
        ids,
        doms,
        options,
        new Set<string>(),
        "diagram",
        shouldContinue,
        signal,
        codeLanguages,
        true,
    );
}

export async function fetchAndExtractUnits(
    ids: string[],
    notebookId: string,
    options: CollectSearchableBlocksOptions,
    embedIds: ReadonlySet<string>,
    mode: OffscreenRenderMode = "light",
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
    codeLanguages?: ReadonlyMap<string, string>,
    rootId = "",
): Promise<{units: CachedUnit[]; unrenderedIds: string[]; missingIds: string[];} | null> {
    const units: CachedUnit[] = [];
    const unrenderedIds: string[] = [];
    const missingIds: string[] = [];
    const embedList = ids.filter((id) => embedIds.has(id));
    const plainList = ids.filter((id) => !embedIds.has(id));

    const run = async (list: string[], withEmbed: boolean): Promise<boolean> => {
        // 搜索调度本来就以两个图表为一组。放进同一个宿主可合并 getBlockDOMs、
        // Protyle 初始化和等待周期；仍保持每批仅两个，避免大型 SVG 同时占用主线程。
        const batchSize = mode === "diagram" ? 2 : DOM_BATCH_SIZE;
        // Embedded DOM may contain many diagrams; don't multiply the two-diagram waves by four batches.
        const concurrency = mode === "diagram" || withEmbed ? 1 : DOM_BATCH_CONCURRENCY;
        for (let i = 0; i < list.length; i += batchSize * concurrency) {
            if (!shouldContinue()) {
                return false;
            }
            const wave = list.slice(i, i + batchSize * concurrency);
            const batches: string[][] = [];
            for (let j = 0; j < wave.length; j += batchSize) {
                batches.push(wave.slice(j, j + batchSize));
            }
            const results = await Promise.all(batches.map(async (batch) => {
                if (!shouldContinue()) {
                    return null;
                }
                try {
                    const fetched = await fetchBlockDoms(batch, notebookId, withEmbed, shouldContinue, signal, rootId);
                    if (!fetched) {
                        return null;
                    }
                    const extracted = await extractUnitsFromDoms(
                        batch,
                        fetched.doms,
                        options,
                        embedIds,
                        mode,
                        shouldContinue,
                        signal,
                        codeLanguages,
                    );
                    extracted.unrenderedIds = Array.from(
                        new Set([...extracted.unrenderedIds, ...fetched.unresolvedEmbedIds]),
                    );
                    if (shouldContinue()) {
                        return extracted;
                    }
                    // 取消可能恰好落在离屏提取完成之后。此时结果不会进入 wave 的
                    // 统一释放分支，必须在这里归还宿主，避免遗留在 document.body。
                    extracted.dispose();
                    return null;
                } catch {
                    return null;
                }
            }));
            if (!shouldContinue()) {
                for (const result of results) {
                    result?.dispose();
                }
                return false;
            }
            for (let index = 0; index < results.length; index += 1) {
                const result = results[index];
                if (!result) {
                    missingIds.push(...batches[index]);
                    unrenderedIds.push(...batches[index]);
                    continue;
                }
                try {
                    units.push(...result.blocks.map((block) => freezeBlock(block)));
                    unrenderedIds.push(...result.unrenderedIds);
                    missingIds.push(...result.missingIds);
                } finally {
                    result.dispose();
                }
            }
        }
        return true;
    };

    if (!await run(plainList, false)) {
        return null;
    }
    if (!await run(embedList, true)) {
        return null;
    }
    return {units, unrenderedIds, missingIds};
}
