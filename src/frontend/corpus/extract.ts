import {isRendererUnitId} from "../../shared";
import {collectSearchableBlocks} from "../blocks";
import type {CollectSearchableBlocksOptions} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import {
    DIAGRAM_SUBTYPE_SET,
    collectRendererSearchUnits,
    rendererAdapterKind,
    type DiagramSubtype,
} from "../renderer-adapters";
import {postJson} from "./api";
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
    /** 渲染失败、且不回退源码的块 */
    unrenderedIds: string[];
    /** 卸掉离屏宿主。替换写回前可以先用仍然连着的 textNodes。 */
    dispose: () => void;
}
async function fetchBlockDoms(
    ids: string[],
    notebookId: string,
    withEmbed: boolean,
    shouldContinue: () => boolean,
    signal?: AbortSignal,
): Promise<Record<string, string> | null> {
    const body: Record<string, unknown> = {ids};
    if (notebookId) {
        body.notebook = notebookId;
    }
    const paths = withEmbed ?
        ["/api/block/getBlockDOMsWithEmbed", "/api/block/getBlockDOMs"] :
        ["/api/block/getBlockDOMs"];
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
                return response;
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
    return blocks.map((block) => {
        if (block.blockId === ownerId) {
            return block;
        }
        return {
            ...block,
            blockId: ownerId,
            blockType: "NodeBlockQueryEmbed",
            unitId: `embed:${block.blockId}:${block.unitId ?? "text"}`,
            textNodes: [],
        };
    });
}

function markUnrenderedSpecial(
    blocks: SearchableBlock[],
    unrendered: Set<string>,
    ownerId: string,
    root: ParentNode,
    expectedDiagramLanguage?: string,
): SearchableBlock[] {
    const element = blocks.find((block) => block.blockId === ownerId)?.element ??
        root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(ownerId)}"]`);
    const expectedDiagram = Boolean(expectedDiagramLanguage && DIAGRAM_SUBTYPE_SET.has(expectedDiagramLanguage));
    if ((element && rendererAdapterKind(element)) || expectedDiagram) {
        const owned = blocks.filter((block) => block.blockId === ownerId);
        const meaningful = owned.some((block) => {
            if (expectedDiagram && !isRendererUnitId(block.unitId)) {
                return false;
            }
            return Boolean(block.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim());
        });
        if (!meaningful) {
            unrendered.add(ownerId);
        }
    }
    return blocks;
}

/**
 * 把块 DOM 挂到离屏编辑器，复用 collectSearchableBlocks。
 * 只保留该块自己的 unit；嵌入块把内部正文记在嵌入块 id 上。
 * HTML / 公式没有渲染可见字时不回退源码；Mermaid / flowchart 由 adapter
 * 提供不可定位的 data-content 兜底，避免首次折叠块直接丢失召回。
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
): Promise<ExtractedUnits> {
    const blocks: SearchableBlock[] = [];
    const unrenderedIds: string[] = [];
    if (ids.length === 0) {
        return {blocks, unrenderedIds, dispose: () => undefined};
    }

    const host = createOffscreenHost();
    const wysiwyg = offscreenWysiwyg(host);
    try {
        for (const id of ids) {
            const html = doms[id];
            if (!html) {
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
            }
        }
        if (mode !== "none") {
            await renderOffscreenBlocks(wysiwyg, mode, shouldContinue, forceDiagramRender);
        }
        if (!shouldContinue()) {
            return {blocks, unrenderedIds, dispose: () => host.remove()};
        }
        const collected = collectSearchableBlocks(host, {
            ...options,
            includeDocTitle: false,
            includeAttributeView: false,
        });
        const unrendered = new Set<string>();
        for (const id of ids) {
            let owned = keepOwnedUnits(collected, id, embedIds.has(id));
            const language = codeLanguages?.get(id);
            // 某些内核版本返回的代码块 DOM 没有 data-subtype。上面已尽量补到
            // 克隆节点，但若结构异常导致采集器仍看不到它，直接按已确认的围栏
            // 语言再跑一次 adapter，至少保留 Mermaid/flowchart 的源码召回单元。
            if (language && DIAGRAM_SUBTYPE_SET.has(language) &&
                !owned.some((block) => isRendererUnitId(block.unitId))) {
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
            const rewritten = markUnrenderedSpecial(owned, unrendered, id, wysiwyg, language);
            for (const block of rewritten) {
                if (!block.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim()) {
                    continue;
                }
                blocks.push(block);
            }
        }
        unrenderedIds.push(...unrendered);
        return {blocks, unrenderedIds, dispose: () => host.remove()};
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
): Promise<{units: CachedUnit[]; unrenderedIds: string[];} | null> {
    const units: CachedUnit[] = [];
    const unrenderedIds: string[] = [];
    const embedList = ids.filter((id) => embedIds.has(id));
    const plainList = ids.filter((id) => !embedIds.has(id));

    const run = async (list: string[], withEmbed: boolean): Promise<boolean> => {
        // 搜索调度本来就以两个图表为一组。放进同一个宿主可合并 getBlockDOMs、
        // Protyle 初始化和等待周期；仍保持每批仅两个，避免大型 SVG 同时占用主线程。
        const batchSize = mode === "diagram" ? 2 : DOM_BATCH_SIZE;
        const concurrency = mode === "diagram" ? 1 : DOM_BATCH_CONCURRENCY;
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
                    const doms = await fetchBlockDoms(batch, notebookId, withEmbed, shouldContinue, signal);
                    if (!doms) {
                        return null;
                    }
                    const extracted = await extractUnitsFromDoms(
                        batch,
                        doms,
                        options,
                        embedIds,
                        mode,
                        shouldContinue,
                        signal,
                        codeLanguages,
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
            let complete = true;
            for (const result of results) {
                if (!result) {
                    complete = false;
                    continue;
                }
                try {
                    units.push(...result.blocks.map((block) => freezeBlock(block)));
                    unrenderedIds.push(...result.unrenderedIds);
                } finally {
                    result.dispose();
                }
            }
            if (!complete) {
                return false;
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
    return {units, unrenderedIds};
}
