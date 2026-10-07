import {getAllEditor} from "siyuan";
import type {Plugin} from "siyuan";
import {
    createSearchPattern,
    extractRegexLiteralGroups,
    regexPrefilterStoresPlainCache,
    avApiUnitShown,
    collectAvDomCoverage,
    isHitReplaceableByUnit,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    matchTextUnitsDetailed,
    normalizeRestrictInlineTypes,
    type SearchableUnit,
} from "../../shared";
import {
    collectSearchableBlocks,
    isInlineMathSearchUnit,
    MERMAID_UNIT_ID,
    HTML_BLOCK_UNIT_ID,
} from "../blocks";
import type {SearchMatch} from "../dom-types";
import type {SearchPipelineOptions, SearchPipelineResult} from "../pipeline";
import {invalidateAvCache, loadAvUnits, peekAvUnits, resolveMissingAvIds, type AvBlockRef} from "./av";
import {escSql, querySqlAll} from "./api";
import {fetchAndExtractUnits} from "./extract";
import {
    isAttributeViewType,
    isDiagramBlock,
    isEmbedType,
    isSpecialRenderType,
} from "./sql";
import {
    fetchBlockHashes,
    fetchContentCandidateIds,
    fetchImageTitleCandidateIds,
    fetchLiteralGroupCandidateIds,
    fetchMemoCandidateIds,
} from "./sql";
import {isBlockTypeEnabled, invalidateDocMeta, isInMindmapBlock, isInTabsBlock, loadDocMeta, type BlockMeta} from "./meta";
import {collectFocusScope, editorFocusId} from "./focus";
import {buildListSnippet} from "../list-snippet";
import {fetchDocBlocksOrders, invalidateDocOrder} from "./order";
import {projectRanges} from "./project";
import {freezeBlock, restrictSpanCovers, type CachedUnit} from "./units";
import type {OffscreenRenderMode} from "./offscreen";

const textCache = new Map<string, {hash: string; units: CachedUnit[]}>();
/** 每个文档保留的普通正文缓存条数。图表缓存不走这条名单。 */
const PLAIN_CACHE_LIMIT = 2000;
const plainCacheKeys = new Map<string, string[]>();
const jobs = new Map<string, Promise<void>>();
let corpusEpoch = 0;

export function invalidateTextCache(): void {
    textCache.clear();
    plainCacheKeys.clear();
}

export function invalidateDocumentSearchCaches(): void {
    invalidateTextCache();
    invalidateDocMeta();
    invalidateDocOrder();
    invalidateAvCache();
}

/**
 * 采集范围不同就不能共用同一份文本。
 * 只搜备注/公式，或关掉某类块时，未加载块的缓存会缺正文；全文搜索若复用它就会漏命中。
 */
function collectionScope(options: SearchPipelineOptions): string {
    const include = [
        options.includeImageTitle !== false,
        options.includeTable !== false,
        options.includeBlockquote !== false,
        options.includeCallout !== false,
        options.includeSuperBlock !== false,
        options.includeListUnordered !== false,
        options.includeListOrdered !== false,
        options.includeListTask !== false,
        options.includeParagraph !== false,
        options.includeHeadingH1 !== false,
        options.includeHeadingH2 !== false,
        options.includeHeadingH3 !== false,
        options.includeHeadingH4 !== false,
        options.includeHeadingH5 !== false,
        options.includeHeadingH6 !== false,
        options.includeMathBlock !== false,
        options.includeEmbedBlock !== false,
        options.includeCodeBlock !== false,
        options.includeMermaid !== false,
        options.includeHtmlBlock !== false,
        options.includeTabs !== false,
        options.includeMindmap !== false,
        options.includeInlineMemo === true,
    ].map((flag) => flag ? "1" : "0").join("");
    const restrict = normalizeRestrictInlineTypes(options.restrictInlineTypes, {
        includeInlineMemo: options.includeInlineMemo === true,
    }).join(",");
    return `${include}|${restrict}`;
}

function cacheKey(rootId: string, blockId: string, scope: string): string {
    return `${rootId}:${blockId}:${scope}`;
}

function readContext(edit: Element): {rootId: string; notebookId: string} | null {
    const protyleEl = edit.classList.contains("protyle") && !edit.hasAttribute("data-page-search-offscreen")
        ? edit
        : edit.querySelector(".protyle:not(.fn__none):not([data-page-search-offscreen])");
    const editors = getAllEditor();
    const exact = protyleEl
        ? editors.find((editor) => editor?.protyle?.element === protyleEl)
        : undefined;
    const found = exact ?? editors.find((editor) => {
        const el = editor?.protyle?.element;
        return el === edit || (el instanceof Element && !el.hasAttribute("data-page-search-offscreen")
            && (el.contains(edit) || edit.contains(el)));
    });
    const rootId = found?.protyle?.block?.rootID || "";
    if (!rootId) {
        return null;
    }
    return {
        rootId,
        notebookId: found?.protyle?.notebookId || "",
    };
}

function collectOptions(options: SearchPipelineOptions) {
    return {
        includeDocTitle: options.includeDocTitle !== false,
        includeImageTitle: options.includeImageTitle !== false,
        includeAttributeView: false as const,
        includeTable: options.includeTable !== false,
        includeBlockquote: options.includeBlockquote !== false,
        includeCallout: options.includeCallout !== false,
        includeSuperBlock: options.includeSuperBlock !== false,
        includeListUnordered: options.includeListUnordered !== false,
        includeListOrdered: options.includeListOrdered !== false,
        includeListTask: options.includeListTask !== false,
        includeParagraph: options.includeParagraph !== false,
        includeHeadingH1: options.includeHeadingH1 !== false,
        includeHeadingH2: options.includeHeadingH2 !== false,
        includeHeadingH3: options.includeHeadingH3 !== false,
        includeHeadingH4: options.includeHeadingH4 !== false,
        includeHeadingH5: options.includeHeadingH5 !== false,
        includeHeadingH6: options.includeHeadingH6 !== false,
        includeMathBlock: options.includeMathBlock !== false,
        includeEmbedBlock: options.includeEmbedBlock !== false,
        includeCodeBlock: options.includeCodeBlock !== false,
        includeMermaid: options.includeMermaid !== false,
        includeHtmlBlock: options.includeHtmlBlock !== false,
        includeTabs: options.includeTabs !== false,
        includeMindmap: options.includeMindmap !== false,
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    };
}

function passesRestrict(unit: CachedUnit, start: number, end: number, options: SearchPipelineOptions): boolean {
    if (!isRestrictInlineActive(options.restrictInlineTypes)) {
        return true;
    }
    if (unit.highlightKind === "inline-memo" || unit.unitId?.startsWith("inline-memo:")) {
        return matchPassesRestrictInline({
            restrictTypes: options.restrictInlineTypes,
            attributeKind: "inline-memo",
            hostDataTypes: [],
        });
    }
    if (unit.highlightKind === "inline-math" || isInlineMathSearchUnit(unit)) {
        return matchPassesRestrictInline({
            restrictTypes: options.restrictInlineTypes,
            attributeKind: "inline-math",
            hostDataTypes: [],
        });
    }
    return restrictSpanCovers(unit.restrictSpans, options.restrictInlineTypes, start, end);
}

function remember(rootId: string, meta: BlockMeta, units: CachedUnit[], scope: string): void {
    if (!units.some((unit) => unit.text.trim())) {
        return;
    }
    textCache.set(cacheKey(rootId, meta.id, scope), {hash: meta.hash, units});
}

function cachedUnits(
    rootId: string,
    metas: BlockMeta[],
    scope: string,
): {ready: CachedUnit[]; missing: BlockMeta[]} {
    const ready: CachedUnit[] = [];
    const missing: BlockMeta[] = [];
    for (const meta of metas) {
        const key = cacheKey(rootId, meta.id, scope);
        const cached = textCache.get(key);
        if (cached && cached.hash === meta.hash && cached.units.some((unit) => unit.text.trim())) {
            ready.push(...cached.units);
            continue;
        }
        missing.push(meta);
    }
    return {ready, missing};
}

async function extractMetas(
    rootId: string,
    notebookId: string,
    metas: BlockMeta[],
    options: SearchPipelineOptions,
    mode: OffscreenRenderMode,
): Promise<{units: CachedUnit[]; unrendered: number; unrenderedIds: string[]; failed: boolean}> {
    if (metas.length === 0) {
        return {units: [], unrendered: 0, unrenderedIds: [], failed: false};
    }
    const epoch = corpusEpoch;
    const scope = collectionScope(options);
    const embedIds = new Set(metas.filter((meta) => isEmbedType(meta.type)).map((meta) => meta.id));
    const extracted = await fetchAndExtractUnits(
        metas.map((meta) => meta.id),
        notebookId,
        collectOptions(options),
        embedIds,
        mode,
    );
    if (!extracted) {
        return {units: [], unrendered: 0, unrenderedIds: [], failed: true};
    }
    const byId = new Map<string, CachedUnit[]>();
    for (const unit of extracted.units) {
        const list = byId.get(unit.blockId) ?? [];
        list.push(unit);
        byId.set(unit.blockId, list);
    }
    const units: CachedUnit[] = [];
    const keep = epoch === corpusEpoch;
    for (const meta of metas) {
        const list = byId.get(meta.id) ?? [];
        if (keep && mode !== "light") {
            remember(rootId, meta, list, scope);
        }
        units.push(...list);
    }
    return {
        units,
        unrendered: extracted.unrenderedIds.length,
        unrenderedIds: extracted.unrenderedIds,
        failed: false,
    };
}

function canCachePlainText(meta: BlockMeta): boolean {
    return !isEmbedType(meta.type) && !isSpecialRenderType(meta.type, meta.subtype);
}

function readPlainCache(rootId: string, blockId: string, scope: string, hash: string): CachedUnit[] | null {
    if (!hash) {
        return null;
    }
    const cached = textCache.get(cacheKey(rootId, blockId, scope));
    if (!cached || cached.hash !== hash || !cached.units.some((unit) => unit.text.trim())) {
        return null;
    }
    return cached.units;
}

function rememberPlain(
    rootId: string,
    blockId: string,
    scope: string,
    hash: string,
    units: CachedUnit[],
): void {
    if (!hash || !units.some((unit) => unit.text.trim())) {
        return;
    }
    const key = cacheKey(rootId, blockId, scope);
    textCache.set(key, {hash, units: units.slice()});
    const order = plainCacheKeys.get(rootId) ?? [];
    const existing = order.indexOf(key);
    if (existing >= 0) {
        order.splice(existing, 1);
    }
    order.push(key);
    while (order.length > PLAIN_CACHE_LIMIT) {
        const dropped = order.shift();
        if (dropped) {
            textCache.delete(dropped);
        }
    }
    plainCacheKeys.set(rootId, order);
}

/**
 * 未加载普通正文：哈希未变则复用上次抽出的文字。
 * 嵌入块、公式、图表和 HTML 不进这份缓存。哈希查询失败时全部重抽且不写入。
 */
async function loadPlainUnits(
    rootId: string,
    notebookId: string,
    metas: BlockMeta[],
    options: SearchPipelineOptions,
    scope: string,
    storeCache: boolean,
): Promise<{units: CachedUnit[]; unrendered: number}> {
    const hashes = await fetchBlockHashes(metas.filter(canCachePlainText).map((meta) => meta.id));
    const ready: CachedUnit[] = [];
    const missing: BlockMeta[] = [];
    const hashAtFetch = new Map<string, string>();
    for (const meta of metas) {
        const hash = hashes?.get(meta.id) ?? "";
        const cached = hashes && canCachePlainText(meta)
            ? readPlainCache(rootId, meta.id, scope, hash)
            : null;
        if (cached) {
            ready.push(...cached);
            continue;
        }
        missing.push(meta);
        if (hashes && hash && canCachePlainText(meta)) {
            hashAtFetch.set(meta.id, hash);
        }
    }
    if (missing.length === 0) {
        return {units: ready, unrendered: 0};
    }
    const epoch = corpusEpoch;
    const extracted = await extractMetas(rootId, notebookId, missing, options, "light");
    if (!extracted.failed && hashes && epoch === corpusEpoch && storeCache) {
        const after = await fetchBlockHashes(Array.from(hashAtFetch.keys()));
        if (after) {
            const byId = new Map<string, CachedUnit[]>();
            for (const unit of extracted.units) {
                const list = byId.get(unit.blockId) ?? [];
                list.push(unit);
                byId.set(unit.blockId, list);
            }
            const failed = new Set(extracted.unrenderedIds);
            for (const [id, hash] of hashAtFetch) {
                if (failed.has(id) || after.get(id) !== hash) {
                    continue;
                }
                rememberPlain(rootId, id, scope, hash, byId.get(id) ?? []);
            }
        }
    }
    return {
        units: ready.concat(extracted.units),
        unrendered: extracted.unrendered,
    };
}

function startJob(key: string, rootId: string, work: () => Promise<void>): void {
    const epoch = corpusEpoch;
    const task = work().then(() => {
        if (jobs.get(key) === task) {
            jobs.delete(key);
        }
        if (epoch === corpusEpoch) {
            notifyIndexSettled(rootId);
        }
    }, () => {
        if (jobs.get(key) === task) {
            jobs.delete(key);
        }
    });
    jobs.set(key, task);
}

const listeners = new Set<(rootId: string) => void>();
const warmupTimers = new Map<string, number>();
const SPECIAL_WARMUP_MS = 800;

/** 关掉搜索框或开始下一次搜索时，停掉上一轮后台拉取，避免它占住接口或在结束后用旧结果覆盖。 */
export function cancelBackgroundCorpusJobs(): void {
    corpusEpoch += 1;
    for (const timer of warmupTimers.values()) {
        window.clearTimeout(timer);
    }
    warmupTimers.clear();
}

/** 后台索引结束时通知一次。搜索栏用来刷新结果，不再轮询。 */
export function subscribeIndexSettled(listener: (rootId: string) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function notifyIndexSettled(rootId: string): void {
    for (const listener of listeners) {
        try {
            listener(rootId);
        } catch (error) {
            console.warn("[page-search] index settled listener failed", error);
        }
    }
}

export function editorRootId(edit: Element): string {
    return readContext(edit)?.rootId ?? "";
}

function scheduleSpecialWarmup(
    rootId: string,
    notebookId: string,
    metas: BlockMeta[],
    options: SearchPipelineOptions,
): void {
    const previous = warmupTimers.get(rootId);
    if (previous != null) {
        window.clearTimeout(previous);
    }
    const timer = window.setTimeout(() => {
        warmupTimers.delete(rootId);
        const missing = cachedUnits(rootId, metas, collectionScope(options)).missing;
        if (missing.length === 0) {
            return;
        }
        const diagrams = missing.filter((item) => isDiagramBlock(item.type, item.subtype));
        const lights = missing.filter((item) => !isDiagramBlock(item.type, item.subtype));
        startJob(`special-rest:${rootId}`, rootId, async () => {
            if (lights.length > 0) {
                await extractMetas(rootId, notebookId, lights, options, "light");
            }
            for (let index = 0; index < diagrams.length; index += 2) {
                const pair = diagrams.slice(index, index + 2);
                await Promise.all(pair.map((item) => {
                    return extractMetas(rootId, notebookId, [item], options, "diagram");
                }));
            }
        });
    }, SPECIAL_WARMUP_MS);
    warmupTimers.set(rootId, timer);
}

function jobRunning(prefix: string): boolean {
    for (const key of jobs.keys()) {
        if (key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

async function loadAvRefs(rootId: string): Promise<AvBlockRef[]> {
    const root = escSql(rootId);
    const rows = await querySqlAll<{id: string; updated?: string; markdown?: string; ial?: string}>((afterId, limit) => {
        const after = afterId ? ` AND id > '${escSql(afterId)}'` : "";
        return `SELECT id, updated, markdown, ial FROM blocks WHERE root_id = '${root}' AND type = 'av'${after} `
            + `ORDER BY id LIMIT ${limit}`;
    });
    if (!rows) {
        return [];
    }
    return resolveMissingAvIds(rows);
}

/**
 * 与 highlight-search 一致：只有当前能看见的块才用编辑器里的文本。
 * 高度为 0、或落在非标题折叠里的块，DOM 里往往没有正文，必须再读 getBlockDOMs。
 */
function isVisuallyInEditor(element: HTMLElement): boolean {
    // 行内公式是 inline，clientHeight 为 0，但仍然占位。用客户区矩形判断。
    const hasBox = element.clientHeight > 0
        || (typeof element.getClientRects === "function" && element.getClientRects().length > 0);
    if (!hasBox) {
        return false;
    }
    let parent: HTMLElement | null = element.parentElement;
    while (parent) {
        if (parent.getAttribute("fold") === "1" && parent.getAttribute("data-type") !== "NodeHeading") {
            return false;
        }
        if (parent.classList.contains("protyle-wysiwyg")) {
            break;
        }
        parent = parent.parentElement;
    }
    return true;
}

function orderIndexOf(order: string[]): Map<string, number> {
    const index = new Map<string, number>();
    order.forEach((id, position) => index.set(id, position));
    return index;
}

/**
 * 当前文档全文搜索。API 不可用时返回 null，调用方降级为已加载 DOM。
 * 正文先返回；图表和数据库在后台补进缓存，下一轮搜索再并入。
 */
export async function searchCurrentDocument(
    _plugin: Plugin,
    edit: Element,
    value: string,
    options: SearchPipelineOptions,
): Promise<SearchPipelineResult | null> {
    cancelBackgroundCorpusJobs();
    const context = readContext(edit);
    if (!context) {
        return null;
    }
    const keyword = value.trim();
    if (!keyword) {
        return null;
    }
    if (options.regex) {
        try {
            createSearchPattern(keyword, {
                regex: true,
                caseSensitive: options.caseSensitive === true,
            });
        } catch (error) {
            return {
                matches: [],
                error: error instanceof Error ? error.message : "正则表达式无效",
                degraded: false,
                partial: false,
                unrendered: 0,
            };
        }
    }

    const meta = await loadDocMeta(context.rootId) ?? {
        byId: new Map<string, BlockMeta>(),
        foldedHidden: new Set<string>(),
        links: new Map(),
        signature: "",
        fallbackOrder: [] as string[],
    };
    const remoteOrder = await fetchDocBlocksOrders(context.rootId, meta.signature);
    const orders = remoteOrder && (remoteOrder.length > 0 || meta.byId.size === 0)
        ? remoteOrder
        : meta.fallbackOrder;
    const focusId = editorFocusId(edit);
    const focusScope = focusId ? collectFocusScope(focusId, meta, orders) : null;
    // 聚焦但关系表里还没有这个块时，不把文档其余未加载块算进来。
    const inFocus = (id: string) => !focusId || Boolean(focusScope?.has(id));
    const orderIndex = orderIndexOf(orders);
    const enabled = (item: BlockMeta) => {
        if (options.includeTabs === false && isInTabsBlock(item.id, meta.links)) {
            return false;
        }
        if (options.includeMindmap === false && isInMindmapBlock(item.id, meta.links)) {
            return false;
        }
        if (!isBlockTypeEnabled(item, options)) {
            return false;
        }
        return options.includeFoldedBlocks === true || !meta.foldedHidden.has(item.id);
    };

    // 数据库单元格跟 highlight-search 一样走当前编辑器里的可见文字。
    // 离屏抽取仍关掉整块拼接，避免相邻单元格粘成一次误匹配。
    const liveAll = collectSearchableBlocks(edit, {
        ...collectOptions(options),
        includeDocTitle: options.includeDocTitle !== false && !focusId,
        includeAttributeView: options.includeAttributeView !== false,
    });
    const liveIds = new Set<string>();
    const units: CachedUnit[] = [];
    for (const block of liveAll) {
        if (block.blockId === "__doc-title__") {
            if (focusId) {
                continue;
            }
            units.push(freezeBlock(block, -1));
            continue;
        }
        if (focusScope && meta.links.has(block.blockId) && !focusScope.has(block.blockId)) {
            continue;
        }
        const item = meta.byId.get(block.blockId);
        // 表格仍走完整块 DOM。数据库已按单元格拆开，看得见的直接参加本次匹配。
        if (item && item.type === "t") {
            continue;
        }
        if (item && !enabled(item)) {
            continue;
        }
        if (item && isSpecialRenderType(item.type, item.subtype) && !block.text.trim()) {
            continue;
        }
        if (!isVisuallyInEditor(block.element)) {
            continue;
        }
        liveIds.add(block.blockId);
        units.push(freezeBlock(block, orderIndex.get(block.blockId) ?? block.blockIndex));
    }

    let unrendered = 0;
    const caseSensitive = options.caseSensitive === true;
    const plainTargets: BlockMeta[] = [];
    const specialTargets: BlockMeta[] = [];

    const queueUnloaded = (id: string) => {
        if (liveIds.has(id) || !inFocus(id)) {
            return;
        }
        const item = meta.byId.get(id) ?? {
            id,
            parentId: "",
            type: "",
            subtype: "",
            ial: "",
            hash: "",
            updated: "",
        };
        if (meta.byId.has(id) && (!enabled(item) || isAttributeViewType(item.type))) {
            return;
        }
        if (isSpecialRenderType(item.type, item.subtype)) {
            specialTargets.push(item);
        } else {
            plainTargets.push(item);
        }
    };
    const queueRemainingSpecials = () => {
        const queued = new Set(specialTargets.map((item) => item.id));
        for (const item of meta.byId.values()) {
            if (!enabled(item) || liveIds.has(item.id) || queued.has(item.id) || !inFocus(item.id)) {
                continue;
            }
            if (!isSpecialRenderType(item.type, item.subtype)) {
                continue;
            }
            specialTargets.push(item);
        }
    };

    const queueEveryUnloaded = () => {
        for (const item of meta.byId.values()) {
            if (!enabled(item) || isAttributeViewType(item.type) || liveIds.has(item.id) || !inFocus(item.id)) {
                continue;
            }
            (isSpecialRenderType(item.type, item.subtype) ? specialTargets : plainTargets).push(item);
        }
    };

    let prefiltered = false;
    let storePlainCache = !options.regex;
    if (options.regex) {
        const groups = extractRegexLiteralGroups(keyword, caseSensitive);
        if (groups) {
            const [contentIds, memoIds, titleIds] = await Promise.all([
                fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "content"),
                options.includeInlineMemo === true
                    ? fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "memo")
                    : Promise.resolve([] as string[]),
                options.includeImageTitle !== false
                    ? fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "imageTitle")
                    : Promise.resolve([] as string[]),
            ]);
            if (contentIds && memoIds && titleIds) {
                prefiltered = true;
                storePlainCache = regexPrefilterStoresPlainCache(groups);
                for (const id of new Set<string>([...contentIds, ...memoIds, ...titleIds])) {
                    queueUnloaded(id);
                }
                // 公式、图表、HTML 的可见文字常常不在 content 里，不能靠字面量丢掉。
                queueRemainingSpecials();
            }
        }
        if (!prefiltered) {
            queueEveryUnloaded();
        }
    } else {
        const [contentIds, memoIds, titleIds] = await Promise.all([
            fetchContentCandidateIds(context.rootId, keyword, caseSensitive),
            options.includeInlineMemo === true
                ? fetchMemoCandidateIds(context.rootId, keyword, caseSensitive)
                : Promise.resolve([] as string[]),
            options.includeImageTitle !== false
                ? fetchImageTitleCandidateIds(context.rootId, keyword, caseSensitive)
                : Promise.resolve([] as string[]),
        ]);
        for (const id of new Set<string>([...contentIds, ...memoIds, ...titleIds])) {
            queueUnloaded(id);
        }
        const queuedSpecials = new Set(specialTargets.map((item) => item.id));
        const restSpecials: BlockMeta[] = [];
        for (const item of meta.byId.values()) {
            if (!enabled(item) || liveIds.has(item.id) || queuedSpecials.has(item.id) || !inFocus(item.id)) {
                continue;
            }
            if (!isSpecialRenderType(item.type, item.subtype)) {
                continue;
            }
            restSpecials.push(item);
        }
        if (restSpecials.length > 0) {
            scheduleSpecialWarmup(context.rootId, context.notebookId, restSpecials, options);
        }
    }

    const scope = collectionScope(options);
    // 全文抽块的正则不写入普通正文缓存，避免把关键词缓存挤掉。
    if (plainTargets.length > 0) {
        const loaded = await loadPlainUnits(
            context.rootId,
            context.notebookId,
            plainTargets,
            options,
            scope,
            storePlainCache,
        );
        units.push(...loaded.units);
        unrendered += loaded.unrendered;
    }

    const specialState = cachedUnits(context.rootId, specialTargets, scope);
    units.push(...specialState.ready);
    const specialMissing = specialState.missing;
    if (specialMissing.length > 0) {
        const diagrams = specialMissing.filter((item) => isDiagramBlock(item.type, item.subtype));
        const lights = specialMissing.filter((item) => !isDiagramBlock(item.type, item.subtype));
        startJob(`special:${context.rootId}`, context.rootId, async () => {
            await extractMetas(context.rootId, context.notebookId, lights, options, "light");
            for (let index = 0; index < diagrams.length; index += 2) {
                const pair = diagrams.slice(index, index + 2);
                await Promise.all(pair.map((item) => {
                    return extractMetas(context.rootId, context.notebookId, [item], options, "diagram");
                }));
            }
        });
    }

    if (options.includeAttributeView !== false) {
        const refs = (await loadAvRefs(context.rootId)).filter((ref) => {
            const item = meta.byId.get(ref.blockId);
            return (!item || enabled(item)) && inFocus(ref.blockId);
        });
        const peeked = peekAvUnits(refs);
        const avDom = collectAvDomCoverage(units);
        const usedRowLabels = new Map<string, Set<string>>();
        for (const unit of peeked.units) {
            if (liveIds.has(unit.blockId)) {
                const coverage = avDom.get(unit.blockId);
                // 画面上已有文字的格子保留 Range。接口只补没画出来的行、日历收起事件和图标格。
                if (coverage && avApiUnitShown(
                    unit.unitId ?? "",
                    unit.text,
                    coverage,
                    rowLabelSkip(usedRowLabels, unit.blockId),
                )) {
                    continue;
                }
            }
            units.push(avToCached(unit, orderIndex));
        }
        if (peeked.missing.length > 0) {
            const missing = peeked.missing;
            startJob(`av:${context.rootId}:${meta.signature}`, context.rootId, async () => {
                await loadAvUnits(missing);
            });
        }
    }

    const matched = matchTextUnitsDetailed(toSearchUnits(dedupeMathUnits(units), orderIndex), value, {
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex,
        dedupeOverlaps: false,
    });
    if (matched.error) {
        return {matches: [], error: matched.error, degraded: false, partial: false, unrendered: 0};
    }

    const byKey = new Map<string, CachedUnit>();
    for (const unit of units) {
        byKey.set(`${unit.blockId}\u0000${unit.unitId ?? ""}`, unit);
    }
    const matches: SearchMatch[] = [];
    for (const hit of matched.hits) {
        const unit = byKey.get(`${hit.blockId}\u0000${hit.unitId ?? ""}`);
        if (!unit || !passesRestrict(unit, hit.start, hit.end, options)) {
            continue;
        }
        const nonReplaceable = hit.blockId === "__doc-title__"
            || hit.unitId === "doc-title"
            || hit.blockType === "doc-title"
            || hit.blockType === "NodeAttributeView"
            || hit.blockType === "NodeMathBlock"
            || hit.blockType === "NodeHTMLBlock"
            || hit.unitId === MERMAID_UNIT_ID
            || hit.unitId === HTML_BLOCK_UNIT_ID
            || hit.unitId === "diagram-rendered"
            || isInlineMathSearchUnit(unit)
            || hit.unitId?.startsWith("embed:");
        matches.push({
            id: hit.id,
            blockId: hit.blockId,
            blockType: hit.blockType,
            blockIndex: orderIndex.get(hit.blockId) ?? (hit.blockId === "__doc-title__" ? -1 : hit.blockIndex),
            unitId: hit.unitId,
            start: hit.start,
            end: hit.end,
            matchedText: hit.matchedText,
            replaceable: nonReplaceable ? false : isHitReplaceableByUnit(unit, hit.start, hit.end),
            highlightKind: unit.highlightKind,
            snippet: unit.snippet,
            ...buildListSnippet(unit.text, hit.start, hit.end, hit.matchedText),
            anchorOffset: unit.highlightKind === "inline-memo" ? unit.anchorOffset : undefined,
        });
    }
    matches.sort(compareMatchOrder);

    const partial = jobRunning(`special:${context.rootId}`)
        || jobRunning(`av:${context.rootId}`);
    return {
        matches: projectRanges(edit, matches, options, liveAll),
        error: "",
        degraded: false,
        partial,
        unrendered,
    };
}

function compareMatchOrder(left: SearchMatch, right: SearchMatch): number {
    if (left.blockIndex !== right.blockIndex) {
        return left.blockIndex - right.blockIndex;
    }
    const leftPos = left.highlightKind === "inline-memo"
        ? (left.anchorOffset ?? left.start)
        : left.start;
    const rightPos = right.highlightKind === "inline-memo"
        ? (right.anchorOffset ?? right.start)
        : right.start;
    if (leftPos !== rightPos) {
        return leftPos - rightPos;
    }
    const leftKind = left.highlightKind === "inline-memo" ? 1 : 0;
    const rightKind = right.highlightKind === "inline-memo" ? 1 : 0;
    if (leftKind !== rightKind) {
        return leftKind - rightKind;
    }
    if (left.start !== right.start) {
        return left.start - right.start;
    }
    return left.end - right.end;
}

function rowLabelSkip(sets: Map<string, Set<string>>, blockId: string): Set<string> {
    let current = sets.get(blockId);
    if (!current) {
        current = new Set<string>();
        sets.set(blockId, current);
    }
    return current;
}

function avToCached(
    unit: SearchableUnit & {snippet?: string},
    orderIndex: Map<string, number>,
): CachedUnit {
    return {
        blockId: unit.blockId,
        blockType: unit.blockType,
        blockIndex: orderIndex.get(unit.blockId) ?? 0,
        text: unit.text,
        unitId: unit.unitId,
        highlightKind: "text",
        restrictSpans: [],
        snippet: unit.snippet,
    };
}

function dedupeMathUnits(units: CachedUnit[]): CachedUnit[] {
    const seen = new Set<string>();
    const kept: CachedUnit[] = [];
    for (const unit of units) {
        const isMath = unit.blockType === "NodeMathBlock"
            || unit.highlightKind === "inline-math"
            || Boolean(unit.unitId?.startsWith("inline-math:"));
        if (!isMath) {
            kept.push(unit);
            continue;
        }
        const text = unit.text.replace(/[\u200B-\u200D\uFEFF]/g, "");
        const key = `${unit.blockId}\0${text}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(unit);
    }
    return kept;
}

function toSearchUnits(units: CachedUnit[], orderIndex: Map<string, number>): SearchableUnit[] {
    return units.map((unit) => ({
        blockId: unit.blockId,
        blockType: unit.blockType,
        blockIndex: unit.blockId === "__doc-title__" ? -1 : (orderIndex.get(unit.blockId) ?? unit.blockIndex),
        text: unit.text,
        unitId: unit.unitId,
        segmentLengths: unit.segmentLengths,
    }));
}
