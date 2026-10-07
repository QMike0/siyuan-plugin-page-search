import {getAllEditor} from "siyuan";
import type {Plugin} from "siyuan";
import {
    createSearchPattern,
    createTextMatchProbe,
    extractRegexLiteralGroups,
    regexPrefilterStoresPlainCache,
    avApiUnitInView,
    avApiUnitShown,
    collectAvDomCoverage,
    isHitReplaceableByUnit,
    countVirtualTableRows,
    mergeVirtualTableUnits,
    tableCellPosition,
    tableHostOmitsRows,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    matchTextUnitsDetailed,
    normalizeRestrictInlineTypes,
    type SearchableUnit,
} from "../../shared";
import {
    collectSearchableBlocks,
    inlineMathIdentityText,
    isInlineMathSearchUnit,
    MERMAID_UNIT_ID,
    HTML_BLOCK_UNIT_ID,
} from "../blocks";
import type {SearchableBlock, SearchMatch} from "../dom-types";
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
const TABLE_ZW_RE = /[\u200B-\u200D\uFEFF]/g;
const TABLE_CELL_UNIT = "table-cell:";
const TABLE_CELL_ELEMENT = "td, th, [data-type=\"NodeTableCell\"], .table__cell";

function stripTableZw(text: string): string {
    return text.replace(TABLE_ZW_RE, "");
}

function isTableCellElement(element: HTMLElement): boolean {
    return element.matches(TABLE_CELL_ELEMENT);
}

function columnAmongCells(row: HTMLTableRowElement, cell: HTMLElement): number {
    const children = row.children;
    let column = 0;
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!(child instanceof HTMLElement) || !isTableCellElement(child)) {
            continue;
        }
        if (child === cell) {
            return column;
        }
        column += 1;
    }
    return -1;
}

function tableBlockElement(element: HTMLElement): HTMLElement | null {
    const host = element.closest<HTMLElement>('[data-type="NodeTable"]');
    if (host) {
        return host;
    }
    if (element.classList.contains("table")) {
        return element;
    }
    return element.closest<HTMLElement>(".table");
}

function isVirtualTablePlaceholder(element: HTMLElement): boolean {
    const row = element.closest<HTMLElement>("tr, .table__row");
    return Boolean(row && row.hasAttribute("data-sy-table-virtual-rows"));
}

/**
 * 已挂载格子的逻辑位置。占位行按属性里的 tr 个数展开，和完整表的行号对齐。
 * 不解析屏外 HTML。算不出行号时整张表退回内核。
 */
function indexMountedTableRows(tableBlock: HTMLElement): {
    shownKeys: Set<string>;
    rowIndex: Map<HTMLTableRowElement, number>;
    unstable: boolean;
} {
    const shownKeys = new Set<string>();
    const rowIndex = new Map<HTMLTableRowElement, number>();
    const tables = tableBlock.querySelectorAll("table");
    let table: HTMLTableElement | null = null;
    for (let index = 0; index < tables.length; index += 1) {
        const candidate = tables[index];
        if (candidate instanceof HTMLTableElement
            && candidate.closest('[data-type="NodeTable"]') === tableBlock) {
            table = candidate;
            break;
        }
    }
    if (!table && tableBlock instanceof HTMLTableElement) {
        table = tableBlock;
    }
    if (!table) {
        return {shownKeys, rowIndex, unstable: true};
    }
    const rows = table.rows;
    let logical = 0;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const source = row.getAttribute("data-sy-table-virtual-rows");
        if (source !== null) {
            const count = countVirtualTableRows(source);
            if (count <= 0) {
                return {shownKeys, rowIndex, unstable: true};
            }
            logical += count;
            continue;
        }
        rowIndex.set(row, logical);
        const children = row.children;
        let column = 0;
        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
            const child = children[childIndex];
            if (!(child instanceof HTMLElement) || !isTableCellElement(child)) {
                continue;
            }
            shownKeys.add(logical + ":" + column);
            column += 1;
        }
        logical += 1;
    }
    return {shownKeys, rowIndex, unstable: false};
}

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
    // 整张表都挂在画面里时直接用这些格子，未落库的修改不必再等 getBlockDOM。
    // 虚拟大表只替换已经挂出来的格子，屏外行仍用完整表。
    const liveAll = collectSearchableBlocks(edit, {
        ...collectOptions(options),
        includeDocTitle: options.includeDocTitle !== false && !focusId,
        includeAttributeView: options.includeAttributeView !== false,
    });
    const liveIds = new Set<string>();
    let units: CachedUnit[] = [];
    const keepRestrict = isRestrictInlineActive(options.restrictInlineTypes);
    const cellMayMatch = createTextMatchProbe(keyword, {
        caseSensitive: options.caseSensitive === true,
        wholeWord: options.wholeWord === true,
        regex: options.regex === true,
    });
    const freezeLive = (block: SearchableBlock, blockIndex = block.blockIndex) => {
        return freezeBlock(block, blockIndex, keepRestrict);
    };
    const virtualTables = new Map<string, {
        shownKeys: Set<string>;
        liveByKey: Map<string, CachedUnit>;
        rowIndex: Map<HTMLTableRowElement, number>;
        unstable: boolean;
    }>();
    const mountedTableUnits: CachedUnit[] = [];
    const visibleMountedTables = new Set<string>();
    const hiddenMountedTables = new Set<string>();
    const kernelOnlyTables = new Set<string>();
    const tableOmitsRows = new Map<string, boolean>();
    const rememberVirtualTableCell = (table: HTMLElement, block: SearchableBlock) => {
        if (kernelOnlyTables.has(block.blockId)) {
            return;
        }
        let state = virtualTables.get(block.blockId);
        if (!state) {
            const inspected = indexMountedTableRows(table);
            if (inspected.unstable) {
                kernelOnlyTables.add(block.blockId);
                return;
            }
            state = {
                shownKeys: inspected.shownKeys,
                liveByKey: new Map<string, CachedUnit>(),
                rowIndex: inspected.rowIndex,
                unstable: false,
            };
            virtualTables.set(block.blockId, state);
        }
        const row = block.element.closest("tr");
        const logicalRow = row instanceof HTMLTableRowElement ? state.rowIndex.get(row) : undefined;
        const column = row instanceof HTMLTableRowElement ? columnAmongCells(row, block.element) : -1;
        if (logicalRow === undefined || column < 0) {
            if (stripTableZw(block.text)) {
                virtualTables.delete(block.blockId);
                kernelOnlyTables.add(block.blockId);
            }
            return;
        }
        const position = logicalRow + ":" + column;
        state.shownKeys.add(position);
        if (!cellMayMatch(block.text)) {
            return;
        }
        state.liveByKey.set(
            position,
            freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex),
        );
    };
    for (const block of liveAll) {
        if (block.blockId === "__doc-title__") {
            if (focusId) {
                continue;
            }
            units.push(freezeLive(block, -1));
            continue;
        }
        if (focusScope && meta.links.has(block.blockId) && !focusScope.has(block.blockId)) {
            continue;
        }
        const item = meta.byId.get(block.blockId);
        if (item && item.type === "t") {
            if (!enabled(item) || isVirtualTablePlaceholder(block.element)) {
                continue;
            }
            const table = tableBlockElement(block.element);
            if (!table) {
                continue;
            }
            let omits = tableOmitsRows.get(block.blockId);
            if (omits === undefined) {
                omits = tableHostOmitsRows(table);
                tableOmitsRows.set(block.blockId, omits);
            }
            const isCell = Boolean(block.unitId && block.unitId.indexOf(TABLE_CELL_UNIT) === 0);
            if (!isCell) {
                if (omits || !isVisuallyInEditor(block.element)) {
                    continue;
                }
                visibleMountedTables.add(block.blockId);
                if (!cellMayMatch(block.text)) {
                    continue;
                }
                mountedTableUnits.push(freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex));
                continue;
            }
            if (!isVisuallyInEditor(block.element)) {
                if (!omits) {
                    hiddenMountedTables.add(block.blockId);
                }
                continue;
            }
            if (omits) {
                rememberVirtualTableCell(table, block);
                continue;
            }
            visibleMountedTables.add(block.blockId);
            if (!cellMayMatch(block.text)) {
                continue;
            }
            mountedTableUnits.push(freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex));
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
        units.push(freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex));
    }
    for (const tableId of visibleMountedTables) {
        if (!hiddenMountedTables.has(tableId)) {
            liveIds.add(tableId);
        }
    }
    for (const unit of mountedTableUnits) {
        if (liveIds.has(unit.blockId)) {
            units.push(unit);
        }
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
        const avViewTypes = new Map<string, string>();
        for (const unit of peeked.units) {
            if (liveIds.has(unit.blockId)) {
                const coverage = avDom.get(unit.blockId);
                const viewType = avViewTypeOf(edit, unit.blockId, avViewTypes);
                // 当前视图没画出来的列不补。列表和日历通常只有主键。
                if (coverage && !avApiUnitInView(unit.unitId ?? "", coverage, viewType)) {
                    continue;
                }
                // 画面上已有文字的格子保留 Range。接口只补同一视图里没画出来的行。
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

    let tableStale = new Set<string>();
    if (virtualTables.size > 0) {
        const merged = mergeVirtualTableUnits(units, virtualTables);
        units = merged.units;
        tableStale = merged.staleKeys;
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
    const navSeq = structuralNavSeq(units, new Set(virtualTables.keys()));
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
            unitSeq: navSeq(unit, hit.start),
            start: hit.start,
            end: hit.end,
            matchedText: hit.matchedText,
            replaceable: (nonReplaceable || tableStale.has(`${hit.blockId}\u0000${hit.unitId ?? ""}`))
                ? false
                : isHitReplaceableByUnit(unit, hit.start, hit.end),
            highlightKind: unit.highlightKind,
            ...(unit.highlightKind === "inline-math" && unit.mathOrdinal !== undefined
                ? {
                    mathOrdinal: unit.mathOrdinal,
                    mathUnitText: inlineMathIdentityText(unit.text),
                }
                : {}),
            snippet: unit.snippet,
            ...buildListSnippet(unit.text, hit.start, hit.end, hit.matchedText),
            anchorOffset: unit.highlightKind === "inline-memo" ? unit.anchorOffset : undefined,
            anchorEnd: unit.highlightKind === "inline-memo" ? unit.anchorEnd : undefined,
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
    if (sameStructuralBlock(left, right)
        && left.unitSeq !== undefined
        && right.unitSeq !== undefined
        && left.unitSeq !== right.unitSeq) {
        return left.unitSeq - right.unitSeq;
    }
    const overlap = bodyBeforeOverlappingMemo(left, right);
    if (overlap !== 0) {
        return overlap;
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

/**
 * 正文命中落在备注宿主里时，正文排在这条备注前面。
 * 宿主起点若停在零宽占位上，会比可见字更靠前，不能因此先跳进备注。
 */
function bodyBeforeOverlappingMemo(left: SearchMatch, right: SearchMatch): number {
    if (left.blockId !== right.blockId) {
        return 0;
    }
    const memo = left.highlightKind === "inline-memo"
        ? left
        : (right.highlightKind === "inline-memo" ? right : null);
    const text = memo === left ? right : left;
    if (!memo || text.highlightKind === "inline-memo" || text.highlightKind === "inline-math") {
        return 0;
    }
    const anchor = memo.anchorOffset;
    const anchorEnd = memo.anchorEnd;
    if (anchor === undefined || anchorEnd === undefined || !(text.start < anchorEnd && text.end > anchor)) {
        return 0;
    }
    return memo === left ? 1 : -1;
}

/**
 * 表格里每个格子占的序号宽度。同一格内按出现位置排，每个偏移占 3 个槽：
 * 公式、正文、备注。同一位置先公式，再正文，再行内备注。
 */
const TABLE_CELL_SEQ_SPAN = 2097152;
const TABLE_CELL_SLOT = 3;

/**
 * 表格先按格子再按格内位置，格内公式和备注插到它在格子文字里的位置；数据库先行后列。
 * indexRankedTables 里的大表混着屏上格子和内核格子，行号口径不同，仍按 units 的顺序。
 */
function structuralNavSeq(
    units: CachedUnit[],
    indexRankedTables: ReadonlySet<string>,
): (unit: CachedUnit, start: number) => number | undefined {
    const seq = new Map<string, number>();
    const rowRank = new Map<string, number>();
    const colRank = new Map<string, number>();
    const nextRow = new Map<string, number>();
    const nextCol = new Map<string, number>();
    const tableRank = new Map<string, number>();
    const tablePlaces = new Map<string, Array<{key: string; row: number; column: number; index: number}>>();
    const byIndex = new Set<string>(indexRankedTables);
    units.forEach((unit, index) => {
        const key = `${unit.blockId}\u0000${unit.unitId ?? ""}`;
        if (unit.blockType === "NodeTable") {
            tableRank.set(key, index);
            const place = unit.tableSlot ?? tableCellPlace(unit.unitId);
            if (!place) {
                byIndex.add(unit.blockId);
                return;
            }
            let places = tablePlaces.get(unit.blockId);
            if (!places) {
                places = [];
                tablePlaces.set(unit.blockId, places);
            }
            places.push({key, row: place.row, column: place.column, index});
            return;
        }
        if (unit.blockType !== "NodeAttributeView") {
            return;
        }
        const pos = avMatchPosition(unit.unitId);
        if (!pos) {
            const cursor = nextRow.get(unit.blockId) ?? 0;
            seq.set(key, cursor * 1000);
            nextRow.set(unit.blockId, cursor + 1);
            return;
        }
        const rowKey = unit.blockId + "\0" + pos.row;
        if (!rowRank.has(rowKey)) {
            const cursor = nextRow.get(unit.blockId) ?? 0;
            rowRank.set(rowKey, cursor);
            nextRow.set(unit.blockId, cursor + 1);
        }
        const colKey = rowKey + "\0" + pos.col;
        if (!colRank.has(colKey)) {
            const cursor = nextCol.get(rowKey) ?? 0;
            colRank.set(colKey, cursor);
            nextCol.set(rowKey, cursor + 1);
        }
        seq.set(key, (rowRank.get(rowKey) ?? 0) * 1000 + (colRank.get(colKey) ?? 0));
    });
    tablePlaces.forEach((places, blockId) => {
        if (byIndex.has(blockId)) {
            return;
        }
        places.sort((a, b) => a.row - b.row || a.column - b.column || a.index - b.index);
        let rank = -1;
        let lastRow = -1;
        let lastColumn = -1;
        for (const place of places) {
            if (place.row !== lastRow || place.column !== lastColumn) {
                rank += 1;
                lastRow = place.row;
                lastColumn = place.column;
            }
            tableRank.set(place.key, rank);
        }
    });
    return (unit, start) => {
        const key = `${unit.blockId}\u0000${unit.unitId ?? ""}`;
        if (unit.blockType !== "NodeTable") {
            return seq.get(key);
        }
        const rank = tableRank.get(key);
        if (rank === undefined) {
            return undefined;
        }
        const at = unit.tableSlot ? unit.tableSlot.offset : start;
        const slot = unit.highlightKind === "inline-memo"
            ? 2
            : (unit.tableSlot ? 0 : 1);
        const inner = at * TABLE_CELL_SLOT + slot;
        return rank * TABLE_CELL_SEQ_SPAN + Math.min(inner, TABLE_CELL_SEQ_SPAN - 1);
    };
}

function tableCellPlace(unitId: string | undefined): {row: number; column: number} | null {
    const position = tableCellPosition(unitId);
    if (!position) {
        return null;
    }
    const colon = position.indexOf(":");
    return {row: Number(position.slice(0, colon)), column: Number(position.slice(colon + 1))};
}

function avMatchPosition(unitId: string | undefined): {row: string; col: string} | null {
    if (!unitId) {
        return null;
    }
    if (unitId.startsWith("cell:")) {
        const parts = unitId.split(":");
        if (parts.length < 4 || !parts[2]) {
            return null;
        }
        return {row: parts[2], col: parts.slice(3).join(":")};
    }
    if (unitId.startsWith("calendar:")) {
        const parts = unitId.split(":");
        if (parts.length < 3 || !parts[1]) {
            return null;
        }
        return {row: parts[1], col: parts.slice(2).join(":")};
    }
    if (unitId.startsWith("av:")) {
        const rest = unitId.slice(3);
        const splitAt = rest.indexOf(":");
        if (splitAt <= 0) {
            return null;
        }
        return {row: rest.slice(0, splitAt), col: rest.slice(splitAt + 1)};
    }
    return null;
}

function sameStructuralBlock(left: SearchMatch, right: SearchMatch): boolean {
    return (left.blockType === "NodeTable" || left.blockType === "NodeAttributeView")
        && left.blockType === right.blockType;
}

function avViewTypeOf(edit: Element, blockId: string, cache: Map<string, string>): string {
    const cached = cache.get(blockId);
    if (cached !== undefined) {
        return cached;
    }
    const block = edit.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    const direct = block?.getAttribute("data-av-type") || "";
    const focused = direct
        ? ""
        : block?.querySelector(".av__views .item--focus")?.getAttribute("data-av-type") || "";
    const viewType = direct || focused;
    cache.set(blockId, viewType);
    return viewType;
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
        const key = `${unit.blockId}\0${text}\0${unit.mathOrdinal ?? ""}`;
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
