import {fetchSyncPost} from "siyuan";
import {collectSearchableBlocks} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import type {CollectSearchableBlocksOptions} from "../blocks";
import {DIAGRAM_SUBTYPE_SET, createOffscreenHost, offscreenWysiwyg, renderOffscreenBlocks, type OffscreenRenderMode} from "./offscreen";
import {freezeBlock, type CachedUnit} from "./units";

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
): Promise<Record<string, string> | null> {
    const body: Record<string, unknown> = {ids};
    if (notebookId) {
        body.notebook = notebookId;
    }
    const paths = withEmbed
        ? ["/api/block/getBlockDOMsWithEmbed", "/api/block/getBlockDOMs"]
        : ["/api/block/getBlockDOMs"];
    for (const path of paths) {
        try {
            const response = await fetchSyncPost(path, body);
            if (response?.code === 0 && response.data && typeof response.data === "object") {
                return response.data as Record<string, string>;
            }
        } catch {
            // 下一种接口
        }
    }
    return null;
}

function diagramTextUnit(element: HTMLElement, blockId: string, blockIndex: number): SearchableBlock | null {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent || parent.closest(".protyle-attr, .protyle-icons, style, script")) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!parent.closest("svg, foreignObject")) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let current = walker.nextNode();
    while (current) {
        nodes.push(current as Text);
        current = walker.nextNode();
    }
    const text = nodes.map((node) => node.nodeValue ?? "").join("");
    if (!text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) {
        return null;
    }
    return {
        blockId,
        blockType: "NodeCodeBlock",
        blockIndex,
        element,
        text,
        textNodes: nodes,
        unitId: "diagram-rendered",
    };
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

function rewriteSpecialUnits(blocks: SearchableBlock[], unrendered: Set<string>, ownerId: string): SearchableBlock[] {
    const element = blocks.find((block) => block.blockId === ownerId)?.element
        ?? document.querySelector<HTMLElement>(`[data-page-search-offscreen] [data-node-id="${CSS.escape(ownerId)}"]`);
    const subtype = element?.getAttribute("data-subtype") ?? "";
    const type = element?.getAttribute("data-type") ?? "";
    if (DIAGRAM_SUBTYPE_SET.has(subtype) && subtype !== "mermaid") {
        const rendered = element ? diagramTextUnit(element, ownerId, 0) : null;
        if (!rendered) {
            unrendered.add(ownerId);
            return blocks.filter((block) => block.blockId !== ownerId);
        }
        return blocks.filter((block) => block.blockId !== ownerId).concat(rendered);
    }
    if (subtype === "mermaid" || type === "NodeHTMLBlock" || type === "NodeMathBlock") {
        const owned = blocks.filter((block) => block.blockId === ownerId);
        const meaningful = owned.some((block) => block.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim());
        if (!meaningful) {
            unrendered.add(ownerId);
        }
    }
    return blocks;
}

/**
 * 把块 DOM 挂到离屏编辑器，复用 collectSearchableBlocks。
 * 只保留该块自己的 unit；嵌入块把内部正文记在嵌入块 id 上。
 * 图表 / HTML / 公式没有渲染可见字时不回退源码。
 */
export async function extractUnitsFromDoms(
    ids: string[],
    doms: Record<string, string>,
    options: CollectSearchableBlocksOptions,
    embedIds: ReadonlySet<string>,
    mode: OffscreenRenderMode = "light",
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
                wysiwyg.appendChild(node);
            }
        }
        if (mode !== "none") {
            await renderOffscreenBlocks(wysiwyg, mode);
        }
        const collected = collectSearchableBlocks(host, {
            ...options,
            includeDocTitle: false,
            includeAttributeView: false,
        });
        const unrendered = new Set<string>();
        for (const id of ids) {
            const owned = keepOwnedUnits(collected, id, embedIds.has(id));
            const rewritten = rewriteSpecialUnits(owned, unrendered, id);
            for (const block of rewritten) {
                if (!block.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) {
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

export async function fetchAndExtractUnits(
    ids: string[],
    notebookId: string,
    options: CollectSearchableBlocksOptions,
    embedIds: ReadonlySet<string>,
    mode: OffscreenRenderMode = "light",
): Promise<{units: CachedUnit[]; unrenderedIds: string[]} | null> {
    const units: CachedUnit[] = [];
    const unrenderedIds: string[] = [];
    const embedList = ids.filter((id) => embedIds.has(id));
    const plainList = ids.filter((id) => !embedIds.has(id));

    const run = async (list: string[], withEmbed: boolean): Promise<boolean> => {
        const batchSize = mode === "diagram" ? 1 : DOM_BATCH_SIZE;
        const concurrency = mode === "diagram" ? 2 : DOM_BATCH_CONCURRENCY;
        for (let i = 0; i < list.length; i += batchSize * concurrency) {
            const wave = list.slice(i, i + batchSize * concurrency);
            const batches: string[][] = [];
            for (let j = 0; j < wave.length; j += batchSize) {
                batches.push(wave.slice(j, j + batchSize));
            }
            const results = await Promise.all(batches.map(async (batch) => {
                const doms = await fetchBlockDoms(batch, notebookId, withEmbed);
                if (!doms) {
                    return null;
                }
                return extractUnitsFromDoms(batch, doms, options, embedIds, mode);
            }));
            for (const result of results) {
                if (!result) {
                    return false;
                }
                units.push(...result.blocks.map((block) => freezeBlock(block)));
                unrenderedIds.push(...result.unrenderedIds);
                result.dispose();
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
