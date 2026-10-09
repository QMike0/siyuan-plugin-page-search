import {collectSearchableBlocks} from "../blocks";
import type {CollectSearchableBlocksOptions} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import {rendererAdapterKind} from "../renderer-adapters";
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
): SearchableBlock[] {
    const element = blocks.find((block) => block.blockId === ownerId)?.element ??
        root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(ownerId)}"]`);
    if (element && rendererAdapterKind(element)) {
        const owned = blocks.filter((block) => block.blockId === ownerId);
        const meaningful = owned.some((block) => block.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim());
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
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
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
            await renderOffscreenBlocks(wysiwyg, mode, shouldContinue);
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
            const owned = keepOwnedUnits(collected, id, embedIds.has(id));
            const rewritten = markUnrenderedSpecial(owned, unrendered, id, wysiwyg);
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

export async function fetchAndExtractUnits(
    ids: string[],
    notebookId: string,
    options: CollectSearchableBlocksOptions,
    embedIds: ReadonlySet<string>,
    mode: OffscreenRenderMode = "light",
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
): Promise<{units: CachedUnit[]; unrenderedIds: string[];} | null> {
    const units: CachedUnit[] = [];
    const unrenderedIds: string[] = [];
    const embedList = ids.filter((id) => embedIds.has(id));
    const plainList = ids.filter((id) => !embedIds.has(id));

    const run = async (list: string[], withEmbed: boolean): Promise<boolean> => {
        const batchSize = mode === "diagram" ? 1 : DOM_BATCH_SIZE;
        const concurrency = mode === "diagram" ? 2 : DOM_BATCH_CONCURRENCY;
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
