import {getAllEditor} from "siyuan";
import type {Plugin} from "siyuan";
import {
    createSearchPattern,
    createTextMatchProbe,
    effectiveSearchQuery,
    extractRegexLiteralGroups,
    regexPrefilterStoresPlainCache,
    avApiUnitInView,
    avApiUnitShown,
    collectAvDomCoverage,
    collectHeadingFoldedIds,
    isBlockTreeEnabled,
    isHitReplaceableByUnit,
    isRendererUnitId,
    rendererUnitSource,
    isSelfFoldedIal,
    logicalTableRows,
    mergeVirtualTableUnits,
    ownTableRows,
    TABLE_VIRTUAL_ROWS_ATTR,
    tableCellPosition,
    tableOverlayKey,
    tableHostOmitsRows,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    matchTextUnitsDetailed,
    normalizeRestrictInlineTypes,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    type SearchableUnit,
} from "../../shared";
import {
    collectSearchableBlocks,
    directTableCellColumn,
    isDirectTableCell,
    inlineMathIdentityText,
    isInlineMathSearchUnit,
    resolveDocRoot,
} from "../blocks";
import type {
    SearchableBlock,
    SearchMatch,
    TableReplaceLock,
} from "../dom-types";
import {isUnderNonHeadingCssFold} from "../fold-dom";
import {buildListSnippet} from "../list-snippet";
import type {
    SearchPipelineOptions,
    SearchPipelineResult,
} from "../pipeline";
import {diagramSourceText} from "../renderer-adapters";
import {
    escSql,
    querySqlAll,
} from "./api";
import {
    AttributeViewTruncatedError,
    invalidateAvCache,
    invalidateAvCacheForBlocks,
    loadAvUnits,
    peekAvUnits,
    resolveMissingAvIds,
    type AvBlockRef,
} from "./av";
import {
    extractDiagramUnitsFromLive,
    fetchAndExtractUnits,
} from "./extract";
import {
    collectFocusScope,
    editorFocusId,
} from "./focus";
import {
    codeBlockLanguagesNeeded,
    effectiveCodeLanguage,
    ensureCodeBlockLanguages,
    isBlockTypeEnabled,
    invalidateDocMeta,
    isInMindmapBlock,
    isInTabsBlock,
    loadDocMeta,
    noteLiveCodeLanguage,
    type BlockMeta,
} from "./meta";
import type {OffscreenRenderMode} from "./offscreen";
import {
    fetchDocBlocksOrders,
    fetchHeadingChildrenIds,
    invalidateDocOrder,
} from "./order";
import {projectRanges} from "./project";
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
import {
    freezeBlock,
    restrictSpanCovers,
    type CachedUnit,
} from "./units";

interface TextCacheEntry {
    hash: string;
    units: CachedUnit[];
    /** 近似保留大小；用于跨文档的全局缓存预算。 */
    bytes: number;
    /** 渲染失败的短期负缓存；到期后允许用户下一次搜索重试。 */
    retryAfter?: number;
}

const textCache = new Map<string, TextCacheEntry>();
/** 所有文本缓存共用的 LRU。Map 的插入顺序就是从最久未使用到最新。 */
const textCacheLru = new Map<string, true>();
const embedCacheKeys = new Set<string>();
let renderSettingsStamp = "";
let textCacheBytes = 0;
/** 缓存内容主要是 UTF-16 字符串；12 MiB 让频繁切页仍有命中，同时封顶长会话内存。 */
const TEXT_CACHE_LIMIT_BYTES = 12 * 1024 * 1024;
const SPECIAL_FAILURE_RETRY_MS = 5000;
/** 特殊渲染结果跨文档、跨范围共用一份全局预算，避免长会话持续增长。 */
const SPECIAL_CACHE_LIMIT = 2000;
const specialCacheKeys = new Map<string, true>();
/** 当前搜索涉及的特殊块不能在补全过程中互相淘汰；超出预算时暂时允许软溢出。 */
const activeSpecialCacheKeys = new Set<string>();
const activeSpecialCacheKeysByRoot = new Map<string, Set<string>>();
let specialCacheTrimBlocked = false;
/** 普通正文缓存也使用跨文档全局 LRU，避免每篇文档各存一份而无限增长。 */
const PLAIN_CACHE_LIMIT = 2000;
const plainCacheKeys = new Map<string, true>();
interface CorpusJob {
    task: Promise<void>;
    epoch: number;
    rootId: string;
    controller: AbortController;
}
const jobs = new Map<string, CorpusJob>();
const corpusEpochs = new Map<string, number>();
/** 打开的查找框按文档计数；最后一个关闭时才停止该文档的后台补全。 */
const backgroundRootUsers = new Map<string, number>();
const JOB_FAILURE_RETRY_MS = 5000;
const JOB_FAILURE_LIMIT = 100;
const jobFailures = new Map<string, {rootId: string; retryAfter: number; truncated?: boolean;}>();

/**
 * 思源数据库的代码块 subtype 不含围栏语言；这里必须和开关判断使用同一有效语言。
 * 否则未挂载 Mermaid 会被当成普通代码块，错过 diagram 渲染和特殊缓存。
 */
function isSpecialRenderMeta(meta: BlockMeta): boolean {
    return isSpecialRenderType(meta.type, effectiveCodeLanguage(meta));
}

function isDiagramMeta(meta: BlockMeta): boolean {
    return isDiagramBlock(meta.type, effectiveCodeLanguage(meta));
}

function currentCorpusEpoch(rootId: string): number {
    return corpusEpochs.get(rootId) ?? 0;
}

export function invalidateTextCache(): void {
    textCache.clear();
    textCacheLru.clear();
    textCacheBytes = 0;
    specialCacheKeys.clear();
    activeSpecialCacheKeys.clear();
    activeSpecialCacheKeysByRoot.clear();
    specialCacheTrimBlocked = false;
    plainCacheKeys.clear();
    embedCacheKeys.clear();
    renderSettingsStamp = "";
}

export function invalidateDocumentSearchCaches(): void {
    // 清缓存时必须同时作废旧任务，否则旧任务完成后会把刚清掉的数据写回。
    cancelBackgroundCorpusJobs();
    invalidateTextCache();
    invalidateDocMeta();
    invalidateDocOrder();
    invalidateAvCache();
    dropQueryMemo();
    jobFailures.clear();
}

function dropTextCacheForBlocks(rootId: string, blockIds: readonly string[]): void {
    if (blockIds.length === 0) {
        return;
    }
    const ids = new Set(blockIds);
    const prefix = `${rootId}:`;
    const doomed: string[] = [];
    for (const key of textCache.keys()) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        const rest = key.slice(prefix.length);
        const splitAt = rest.indexOf(":");
        const blockId = splitAt >= 0 ? rest.slice(0, splitAt) : rest;
        if (ids.has(blockId)) {
            doomed.push(key);
        }
    }
    for (const key of doomed) {
        dropTextCache(key);
    }
}

/**
 * 块替换后只作废这篇文档的结构、嵌入缓存和候选查询。
 * 被改过的块丢掉文本和数据库单元格缓存；其余块仍按哈希复用，不重新离屏渲染。
 */
export function invalidateEditedDocument(rootId?: string, blockIds?: readonly string[]): void {
    if (!rootId) {
        invalidateDocumentSearchCaches();
        return;
    }
    cancelBackgroundCorpusJobs(rootId);
    invalidateDocMeta(rootId);
    invalidateDocOrder(rootId);
    dropEmbedRenderCaches();
    dropQueryMemo(rootId);
    if (blockIds && blockIds.length > 0) {
        dropTextCacheForBlocks(rootId, blockIds);
        invalidateAvCacheForBlocks(blockIds);
    }
}

/** savedoc 后只作废结构信息。普通正文仍按块哈希复用；嵌入块的来源不在自身哈希里，必须丢掉。 */
export function invalidateDocumentStructureCaches(rootId?: string): void {
    invalidateDocMeta(rootId);
    invalidateDocOrder(rootId);
    dropEmbedRenderCaches();
    dropQueryMemo(rootId);
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
        options.includeFlowchart !== false,
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

function textBytes(value: string | undefined): number {
    return (value?.length ?? 0) * 2;
}

/**
 * 不追求引擎对象的精确 heap size，只为 LRU 提供稳定的上界估算。
 * 文本占主要部分；偏移数组和限制范围按数字/对象的保守固定成本计入。
 */
function estimateCacheEntryBytes(hash: string, units: readonly CachedUnit[]): number {
    let bytes = 64 + textBytes(hash);
    for (const unit of units) {
        bytes += 96 +
            textBytes(unit.blockId) +
            textBytes(unit.blockType) +
            textBytes(unit.text) +
            textBytes(unit.unitId) +
            textBytes(unit.highlightKind) +
            textBytes(unit.snippet);
        bytes += (unit.segmentLengths?.length ?? 0) * 8;
        bytes += (unit.restrictSpans?.length ?? 0) * 40;
    }
    return bytes;
}

function touchTextCache(key: string): void {
    if (textCacheLru.has(key)) {
        textCacheLru.delete(key);
    }
    textCacheLru.set(key, true);
}

function dropTextCache(key: string): void {
    const cached = textCache.get(key);
    if (cached) {
        textCacheBytes = Math.max(0, textCacheBytes - cached.bytes);
        textCache.delete(key);
    }
    textCacheLru.delete(key);
    specialCacheKeys.delete(key);
    plainCacheKeys.delete(key);
    embedCacheKeys.delete(key);
}

function currentRenderSettingsStamp(): string {
    const config = (window as Window & {
        siyuan?: {config?: {appearance?: {mode?: unknown; theme?: unknown; themeDark?: unknown;};};};
    }).siyuan?.config;
    const appearance = config?.appearance;
    return `${appearance?.mode ?? ""}|${appearance?.theme ?? ""}|${appearance?.themeDark ?? ""}`;
}

/** 主题或明暗模式变化后，图表和 HTML 的可见字可能不同，不能沿用上一套渲染结果。 */
function syncRenderSettingsCache(): void {
    const next = currentRenderSettingsStamp();
    if (!renderSettingsStamp) {
        renderSettingsStamp = next;
        return;
    }
    if (next === renderSettingsStamp) {
        return;
    }
    renderSettingsStamp = next;
    for (const key of Array.from(specialCacheKeys.keys())) {
        dropTextCache(key);
    }
}

function dropEmbedRenderCaches(): void {
    for (const key of Array.from(embedCacheKeys)) {
        dropTextCache(key);
    }
}

const queryMemo = new Map<string, {signature: string; value: unknown;}>();
const QUERY_MEMO_LIMIT = 24;
/** 数据库引用查询的代数。变更前已发出的请求完成后不能再写回缓存。 */
const avRefEpoch = new Map<string, number>();

function currentAvRefEpoch(rootId: string): number {
    return avRefEpoch.get(rootId) ?? 0;
}

function pinAvRefEpoch(rootId: string): number {
    if (!avRefEpoch.has(rootId)) {
        avRefEpoch.set(rootId, 0);
    }
    return currentAvRefEpoch(rootId);
}

function bumpAvRefEpoch(rootId: string): void {
    avRefEpoch.set(rootId, currentAvRefEpoch(rootId) + 1);
}

function bumpAllAvRefEpochs(): void {
    for (const rootId of avRefEpoch.keys()) {
        bumpAvRefEpoch(rootId);
    }
}

function queryMemoKey(rootId: string, kind: string, detail = ""): string {
    return JSON.stringify([rootId, kind, detail]);
}

function readQueryMemo<T>(key: string, signature: string): T | undefined {
    const hit = queryMemo.get(key);
    if (!hit || hit.signature !== signature) {
        if (hit) {
            queryMemo.delete(key);
        }
        return undefined;
    }
    queryMemo.delete(key);
    queryMemo.set(key, hit);
    return hit.value as T;
}

function writeQueryMemo<T>(key: string, signature: string, value: T): void {
    queryMemo.delete(key);
    queryMemo.set(key, {signature, value});
    while (queryMemo.size > QUERY_MEMO_LIMIT) {
        const oldest = queryMemo.keys().next().value as string | undefined;
        if (!oldest) {
            break;
        }
        queryMemo.delete(oldest);
    }
}

/** 数据库事务或结构性重绘后只丢掉引用列表，正文候选和块文本缓存继续复用。 */
export function invalidateAttributeViewSearch(rootId: string): void {
    if (!rootId) {
        return;
    }
    // 先推进代数，再停掉这一文档未完成的数据库任务，避免旧单元格写回。
    bumpAvRefEpoch(rootId);
    const prefix = `av:${rootId}:`;
    const doomed: string[] = [];
    for (const [key, job] of jobs) {
        if (key.startsWith(prefix)) {
            job.controller.abort();
            doomed.push(key);
        }
    }
    for (const key of doomed) {
        jobs.delete(key);
        jobFailures.delete(key);
    }
    queryMemo.delete(queryMemoKey(rootId, "avrefs"));
}

function dropQueryMemo(rootId?: string): void {
    if (!rootId) {
        bumpAllAvRefEpochs();
        queryMemo.clear();
        return;
    }
    // 保存或替换会清掉引用列表。进行中的查询若在清空之后返回，不能把旧列表写回去。
    bumpAvRefEpoch(rootId);
    const prefix = `[${JSON.stringify(rootId)},`;
    for (const key of queryMemo.keys()) {
        if (key.startsWith(prefix)) {
            queryMemo.delete(key);
        }
    }
}

async function memoizedIds(
    key: string,
    signature: string,
    load: () => Promise<string[] | null>,
): Promise<string[] | null> {
    const cached = readQueryMemo<string[]>(key, signature);
    if (cached !== undefined) {
        return cached;
    }
    const ids = await load();
    // 失败和取消都是 null，不能记成“没有候选”，否则下一轮会漏召回。
    if (ids !== null) {
        writeQueryMemo(key, signature, ids);
    }
    return ids;
}

function trimTextCacheBudget(): void {
    if (textCacheBytes <= TEXT_CACHE_LIMIT_BYTES) {
        return;
    }
    for (const key of Array.from(textCacheLru.keys())) {
        if (textCacheBytes <= TEXT_CACHE_LIMIT_BYTES) {
            return;
        }
        // 正在为活动文档补全的特殊块不能中途淘汰；释放活动键时会再整理。
        if (activeSpecialCacheKeys.has(key)) {
            continue;
        }
        dropTextCache(key);
    }
}

function writeTextCache(key: string, entry: Omit<TextCacheEntry, "bytes">): void {
    dropTextCache(key);
    const cached: TextCacheEntry = {
        ...entry,
        bytes: estimateCacheEntryBytes(entry.hash, entry.units),
    };
    textCache.set(key, cached);
    textCacheBytes += cached.bytes;
    touchTextCache(key);
}

function touchSpecialCache(key: string): void {
    if (specialCacheKeys.has(key)) {
        specialCacheKeys.delete(key);
    }
    specialCacheKeys.set(key, true);
}

function pinSpecialCacheKeys(rootId: string, keys: string[]): void {
    let owned = activeSpecialCacheKeysByRoot.get(rootId);
    if (!owned) {
        owned = new Set<string>();
        activeSpecialCacheKeysByRoot.set(rootId, owned);
    }
    for (const key of keys) {
        owned.add(key);
        activeSpecialCacheKeys.add(key);
    }
}

function releaseSpecialCacheKeys(rootId: string): void {
    const owned = activeSpecialCacheKeysByRoot.get(rootId);
    if (owned) {
        for (const key of owned) {
            activeSpecialCacheKeys.delete(key);
        }
        activeSpecialCacheKeysByRoot.delete(rootId);
    }
    // 工作集已释放后立即回到全局预算；仍被其他文档使用的键会由 trimSpecialCache 跳过。
    specialCacheTrimBlocked = false;
    trimSpecialCache();
    trimTextCacheBudget();
}

function trimSpecialCache(): void {
    if (specialCacheTrimBlocked || specialCacheKeys.size <= SPECIAL_CACHE_LIMIT) {
        return;
    }
    for (const key of Array.from(specialCacheKeys.keys())) {
        if (specialCacheKeys.size <= SPECIAL_CACHE_LIMIT) {
            return;
        }
        if (activeSpecialCacheKeys.has(key)) {
            continue;
        }
        dropTextCache(key);
    }
    // 整个超额部分都属于当前工作集时保留它，避免每次写入都 O(N) 扫描。
    specialCacheTrimBlocked = specialCacheKeys.size > SPECIAL_CACHE_LIMIT;
}

function writeSpecialCache(key: string, entry: Omit<TextCacheEntry, "bytes">): void {
    writeTextCache(key, entry);
    touchSpecialCache(key);
    trimSpecialCache();
    trimTextCacheBudget();
}

function readContext(edit: Element): {rootId: string; notebookId: string;} | null {
    const protyleSelector = ".protyle:not(.fn__none):not([data-page-search-offscreen])";
    // 桌面端的 SearchBar 挂在 layout-tab-container 上。页签过渡时其中可能短暂
    // 同时保留旧/新的 Protyle；思源其它前端路径也优先取直属可见 Protyle，避免
    // querySelector 因旧的深层节点先出现而绑定到错误文档。
    const protyleEl = edit.classList.contains("protyle") &&
            !edit.classList.contains("fn__none") &&
            !edit.hasAttribute("data-page-search-offscreen") ?
        edit :
        edit.querySelector<HTMLElement>(`:scope > ${protyleSelector}`) ??
            edit.querySelector<HTMLElement>(protyleSelector);
    // 过渡帧中没有已显示的 Protyle 时，不能按 edit 容器去猜 getAllEditor()
    // 的第一项：旧页签的包装对象还在数组中，会把结果或索引归到错误文档。
    if (!protyleEl) {
        return null;
    }
    const editors = getAllEditor();
    const exact = protyleEl ?
        editors.find((editor) => editor?.protyle?.element === protyleEl) :
        undefined;
    const found = exact ?? editors.find((editor) => {
        const el = editor?.protyle?.element;
        return el instanceof Element &&
            !el.classList.contains("fn__none") &&
            !el.hasAttribute("data-page-search-offscreen") &&
            (el.contains(protyleEl) || protyleEl.contains(el));
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
        includeFlowchart: options.includeFlowchart !== false,
        includeHtmlBlock: options.includeHtmlBlock !== false,
        includeFoldedBlocks: options.includeFoldedBlocks === true,
        includeTabs: options.includeTabs !== false,
        includeMindmap: options.includeMindmap !== false,
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    };
}

/**
 * 未加载块的缓存保存原始可搜索文字，折叠只在候选阶段过滤。
 * 若把折叠开关放进缓存范围，切换开关会让同一段正文失去命中缓存并重新请求 DOM，
 * 即使当前文档已经完整加载也会出现明显的 0/0 停顿。
 */
function extractionCollectOptions(options: SearchPipelineOptions) {
    return {
        ...collectOptions(options),
        includeFoldedBlocks: true,
    };
}

/** 当前文档已挂载块的即时折叠状态；卸载的块继续使用 SQL IAL。 */
function mountedFoldState(edit: Element): {
    headings: {mountedIds: Set<string>; foldedIds: Set<string>;};
    nonHeadings: {mountedIds: Set<string>; foldedIds: Set<string>;};
} {
    const headings = {mountedIds: new Set<string>(), foldedIds: new Set<string>()};
    const nonHeadings = {mountedIds: new Set<string>(), foldedIds: new Set<string>()};
    const root = resolveDocRoot(edit);
    if (!root) {
        return {headings, nonHeadings};
    }
    root.querySelectorAll<HTMLElement>("[data-node-id][data-type]").forEach((element) => {
        // 嵌入块会把另一处文档的块副本挂进当前编辑器；它的 fold 状态不能覆盖
        // 当前文档同 ID 的 SQL 元数据。嵌入块自身仍是本文件的真实块，予以保留。
        const embed = element.closest<HTMLElement>('[data-type="NodeBlockQueryEmbed"]');
        if (embed && embed !== element) {
            return;
        }
        const id = element.dataset.nodeId?.trim();
        if (!id) {
            return;
        }
        const state = element.dataset.type === "NodeHeading" ? headings : nonHeadings;
        state.mountedIds.add(id);
        if (element.getAttribute("fold") === "1") {
            state.foldedIds.add(id);
        }
    });
    return {headings, nonHeadings};
}

/**
 * SQL IAL 在折叠手势后可能稍晚才刷新。已挂载非标题块按 DOM 覆盖该旧值，
 * 但不能把这套规则外推到未加载区域，否则会漏掉它们真实的折叠状态。
 */
function isUnderNonHeadingFold(
    id: string,
    links: ReadonlyMap<string, {parentId: string; type: string; subtype: string; ial: string;}>,
    state: {mountedIds: ReadonlySet<string>; foldedIds: ReadonlySet<string>;},
    memo: Map<string, boolean>,
    resolving: Set<string> = new Set<string>(),
): boolean {
    const known = memo.get(id);
    if (known !== undefined) {
        return known;
    }
    // blocks.parent_id 理论上是一棵树；损坏数据不能让搜索陷入递归。
    if (resolving.has(id)) {
        memo.set(id, false);
        return false;
    }
    resolving.add(id);
    const node = links.get(id);
    const selfFolded = node && node.type !== "h" && (state.mountedIds.has(id) ?
        state.foldedIds.has(id) :
        isSelfFoldedIal(node.ial));
    const value = Boolean(
        selfFolded ||
            (node?.parentId && links.has(node.parentId) &&
                isUnderNonHeadingFold(node.parentId, links, state, memo, resolving)),
    );
    resolving.delete(id);
    memo.set(id, value);
    return value;
}

/**
 * 已知处于折叠状态的标题交给内核确认下辖块；复杂容器不再靠 SQL 父子关系猜边界。
 *
 * 已挂载标题的状态来自 DOM；未挂载标题则先用 blocks.ial 找到 `fold="1"` 的
 * 标题，再由内核给出真实的 HeadingChildren。后一步不能只做已挂载标题：动态
 * 加载会卸掉折叠标题本身，而 SQL 的 parent_id 不能完整表达标题的逻辑后代。
 */
async function collectExactHeadingHiddenIds(
    rootId: string,
    signature: string,
    foldedHeadingIds: ReadonlySet<string>,
    links: ReadonlyMap<string, {parentId: string; type: string; subtype: string; ial: string;}>,
    signal?: AbortSignal,
): Promise<Set<string>> {
    const hiddenRoots = new Set<string>();
    // 调用方对当前画面里大量同时折叠的标题保留原有上限；这里的未挂载
    // 标题不截断，否则第 33 个及以后的未加载标题会重新漏进结果。四路并发
    // 既避免请求峰值，也能在被取消时尽快停下。
    const ids = Array.from(foldedHeadingIds);
    const responses: Array<{headingId: string; children: string[] | null;}> = [];
    for (let start = 0; start < ids.length; start += 4) {
        if (signal?.aborted) {
            return hiddenRoots;
        }
        const wave = await Promise.all(
            ids.slice(start, start + 4).map(async (headingId) => {
                return {
                    headingId,
                    children: await fetchHeadingChildrenIds(rootId, headingId, signature, signal),
                };
            }),
        );
        responses.push(...wave);
    }
    if (signal?.aborted) {
        return hiddenRoots;
    }
    for (const {headingId, children} of responses) {
        if (!children) {
            continue;
        }
        for (const id of children) {
            // 内核接口按版本可能包含标题自身；折叠标题自身始终可见。
            if (id && id !== headingId) {
                hiddenRoots.add(id);
            }
        }
    }
    if (hiddenRoots.size === 0) {
        return hiddenRoots;
    }
    // HeadingChildren 对容器给出根节点时，blocks 表里的后代也应一并隐藏。
    const memo = new Map<string, boolean>();
    const resolving = new Set<string>();
    const hidden = (id: string): boolean => {
        const known = memo.get(id);
        if (known !== undefined) {
            return known;
        }
        if (resolving.has(id)) {
            memo.set(id, false);
            return false;
        }
        resolving.add(id);
        const node = links.get(id);
        const value = hiddenRoots.has(id) ||
            Boolean(node?.parentId && links.has(node.parentId) && hidden(node.parentId));
        resolving.delete(id);
        memo.set(id, value);
        return value;
    };
    for (const id of links.keys()) {
        if (hidden(id)) {
            hiddenRoots.add(id);
        }
    }
    return hiddenRoots;
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
    // 成功但没有可见文字也是稳定结果；缓存空数组可避免无限重渲染。
    const key = cacheKey(rootId, meta.id, scope);
    writeSpecialCache(key, {hash: meta.hash, units});
    if (isEmbedType(meta.type)) {
        embedCacheKeys.add(key);
    }
}

function rememberUnrendered(rootId: string, meta: BlockMeta, scope: string): void {
    const key = cacheKey(rootId, meta.id, scope);
    writeSpecialCache(key, {
        hash: meta.hash,
        units: [],
        retryAfter: Date.now() + SPECIAL_FAILURE_RETRY_MS,
    });
    if (isEmbedType(meta.type)) {
        embedCacheKeys.add(key);
    }
}

function cachedUnits(
    rootId: string,
    metas: BlockMeta[],
    scope: string,
): {ready: CachedUnit[]; missing: BlockMeta[]; unrendered: number;} {
    const ready: CachedUnit[] = [];
    const missing: BlockMeta[] = [];
    let unrendered = 0;
    const now = Date.now();
    syncRenderSettingsCache();
    pinSpecialCacheKeys(rootId, metas.map((meta) => cacheKey(rootId, meta.id, scope)));
    for (const meta of metas) {
        const key = cacheKey(rootId, meta.id, scope);
        const cached = textCache.get(key);
        if (cached && cached.hash === meta.hash) {
            touchSpecialCache(key);
            touchTextCache(key);
            if (cached.retryAfter !== undefined) {
                if (cached.retryAfter > now) {
                    unrendered += 1;
                    continue;
                }
                dropTextCache(key);
            } else {
                ready.push(...cached.units);
                continue;
            }
        }
        missing.push(meta);
    }
    return {ready, missing, unrendered};
}

async function extractMetas(
    rootId: string,
    notebookId: string,
    metas: BlockMeta[],
    options: SearchPipelineOptions,
    mode: OffscreenRenderMode,
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
): Promise<{units: CachedUnit[]; unrendered: number; unrenderedIds: string[]; failed: boolean;}> {
    if (metas.length === 0) {
        return {units: [], unrendered: 0, unrenderedIds: [], failed: false};
    }
    const epoch = currentCorpusEpoch(rootId);
    const canContinue = () => shouldContinue() && !signal?.aborted;
    const scope = collectionScope(options);
    const embedIds = new Set(metas.filter((meta) => isEmbedType(meta.type)).map((meta) => meta.id));
    const codeLanguages = new Map<string, string>();
    for (const meta of metas) {
        const language = effectiveCodeLanguage(meta);
        if (meta.type === "c" && isDiagramBlock(meta.type, language)) {
            codeLanguages.set(meta.id, language);
        }
    }
    let extracted: Awaited<ReturnType<typeof fetchAndExtractUnits>>;
    try {
        extracted = await fetchAndExtractUnits(
            metas.map((meta) => meta.id),
            notebookId,
            extractionCollectOptions(options),
            embedIds,
            mode,
            canContinue,
            signal,
            codeLanguages,
        );
    } catch {
        // 渲染器异常与接口失败使用同一条有限重试路径，不能让后台任务永久停在 partial。
        extracted = null;
    }
    if (!extracted) {
        const failedIds = metas
            .filter(isSpecialRenderMeta)
            .map((meta) => meta.id);
        if (epoch === currentCorpusEpoch(rootId)) {
            for (const meta of metas) {
                if (isSpecialRenderMeta(meta)) {
                    rememberUnrendered(rootId, meta, scope);
                }
            }
        }
        return {
            units: [],
            unrendered: failedIds.length,
            unrenderedIds: failedIds,
            failed: true,
        };
    }
    const byId = new Map<string, CachedUnit[]>();
    for (const unit of extracted.units) {
        const list = byId.get(unit.blockId) ?? [];
        list.push(unit);
        byId.set(unit.blockId, list);
    }
    const units: CachedUnit[] = [];
    const keep = canContinue() && epoch === currentCorpusEpoch(rootId);
    const unrenderedIds = new Set(extracted.unrenderedIds);
    for (const meta of metas) {
        const list = byId.get(meta.id) ?? [];
        const cacheSpecial = mode !== "light" || isSpecialRenderMeta(meta);
        if (keep && cacheSpecial) {
            if (unrenderedIds.has(meta.id)) {
                rememberUnrendered(rootId, meta, scope);
            } else {
                remember(rootId, meta, list, scope);
            }
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
    return !isEmbedType(meta.type) && !isSpecialRenderMeta(meta);
}

function readPlainCache(rootId: string, blockId: string, scope: string, hash: string): CachedUnit[] | null {
    if (!hash) {
        return null;
    }
    const cached = textCache.get(cacheKey(rootId, blockId, scope));
    if (!cached || cached.hash !== hash || !cached.units.some((unit) => unit.text.trim())) {
        return null;
    }
    const key = cacheKey(rootId, blockId, scope);
    touchTextCache(key);
    if (plainCacheKeys.has(key)) {
        plainCacheKeys.delete(key);
        plainCacheKeys.set(key, true);
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
    specialCacheKeys.delete(key);
    writeTextCache(key, {hash, units: units.slice()});
    plainCacheKeys.set(key, true);
    while (plainCacheKeys.size > PLAIN_CACHE_LIMIT) {
        const dropped = plainCacheKeys.keys().next().value as string | undefined;
        if (!dropped) {
            break;
        }
        dropTextCache(dropped);
    }
    trimTextCacheBudget();
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
    mode: OffscreenRenderMode = "light",
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
): Promise<{units: CachedUnit[]; unrendered: number; failed: boolean;}> {
    if (!shouldContinue()) {
        return {units: [], unrendered: 0, failed: false};
    }
    const hashes = await fetchBlockHashes(metas.filter(canCachePlainText).map((meta) => meta.id), signal);
    const ready: CachedUnit[] = [];
    const missing: BlockMeta[] = [];
    const hashAtFetch = new Map<string, string>();
    for (const meta of metas) {
        const hash = hashes?.get(meta.id) ?? "";
        const cached = hashes && canCachePlainText(meta) ?
            readPlainCache(rootId, meta.id, scope, hash) :
            null;
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
        return {units: ready, unrendered: 0, failed: false};
    }
    const epoch = currentCorpusEpoch(rootId);
    const extracted = await extractMetas(rootId, notebookId, missing, options, mode, shouldContinue, signal);
    if (!extracted.failed && hashes && shouldContinue() && epoch === currentCorpusEpoch(rootId) && storeCache) {
        const after = await fetchBlockHashes(Array.from(hashAtFetch.keys()), signal);
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
        failed: extracted.failed,
    };
}

function pruneJobFailures(now: number): void {
    for (const [key, failure] of jobFailures) {
        if (failure.retryAfter <= now) {
            jobFailures.delete(key);
        }
    }
    while (jobFailures.size > JOB_FAILURE_LIMIT) {
        const oldest = jobFailures.keys().next().value as string | undefined;
        if (!oldest) {
            break;
        }
        jobFailures.delete(oldest);
    }
}

function startJob(
    key: string,
    rootId: string,
    work: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
): void {
    const now = Date.now();
    pruneJobFailures(now);
    const epoch = currentCorpusEpoch(rootId);
    const existing = jobs.get(key);
    if (existing) {
        // 相同文档、相同版本的工作本身就是可复用的。特别是输入过程中，多次搜索
        // 都会看到同一批未缓存图表/属性视图；重启只会重复请求与离屏渲染。
        if (existing.rootId === rootId && existing.epoch === epoch && !existing.controller.signal.aborted) {
            return;
        }
        existing.controller.abort();
        jobs.delete(key);
    }
    const previousFailure = jobFailures.get(key);
    if (previousFailure && previousFailure.retryAfter > now) {
        return;
    }
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && epoch === currentCorpusEpoch(rootId);
    const task = Promise.resolve().then(() => work(isCurrent, controller.signal)).then(() => {
        if (jobs.get(key)?.task === task) {
            jobs.delete(key);
        }
        if (isCurrent()) {
            jobFailures.delete(key);
            notifyIndexSettled(rootId);
        }
    }, (error) => {
        if (jobs.get(key)?.task === task) {
            jobs.delete(key);
        }
        if (isCurrent()) {
            jobFailures.delete(key);
            jobFailures.set(key, {
                rootId,
                retryAfter: Date.now() + JOB_FAILURE_RETRY_MS,
                truncated: error instanceof AttributeViewTruncatedError,
            });
            pruneJobFailures(Date.now());
            // 只通知一次；退避期内不会再次启动同一失败任务，避免监听器形成快速重试环。
            notifyIndexSettled(rootId);
        }
    });
    jobs.set(key, {task, epoch, rootId, controller});
}

const listeners = new Set<(rootId: string) => void>();
const warmupTimers = new Map<string, number>();
const SPECIAL_WARMUP_MS = 800;

function cancelRootBackgroundCorpusJobs(rootId: string): void {
    corpusEpochs.set(rootId, currentCorpusEpoch(rootId) + 1);
    // Promise 无法强制中断在途请求；epoch 检查会停止后续批次，也不允许旧结果写入缓存。
    for (const [key, job] of jobs) {
        if (job.rootId === rootId) {
            job.controller.abort();
            jobs.delete(key);
        }
    }
    const timer = warmupTimers.get(rootId);
    if (timer != null) {
        window.clearTimeout(timer);
        warmupTimers.delete(rootId);
    }
    releaseSpecialCacheKeys(rootId);
}

/**
 * 直接停止对应文档的后台补全。无参数保留全局清理语义。
 * 常规 SearchBar 生命周期应使用 retain/release，避免一个同文档面板关闭时中断另一个。
 */
export function cancelBackgroundCorpusJobs(rootId?: string): void {
    if (rootId) {
        cancelRootBackgroundCorpusJobs(rootId);
        return;
    }
    const roots = new Set<string>([
        ...corpusEpochs.keys(),
        ...warmupTimers.keys(),
        ...activeSpecialCacheKeysByRoot.keys(),
        ...Array.from(jobs.values(), (job) => job.rootId),
    ]);
    for (const currentRoot of roots) {
        cancelRootBackgroundCorpusJobs(currentRoot);
    }
    jobs.clear();
}

/** 声明一个查找框正在使用该文档的可复用后台索引。 */
export function retainBackgroundCorpusRoot(rootId: string): void {
    if (!rootId) {
        return;
    }
    backgroundRootUsers.set(rootId, (backgroundRootUsers.get(rootId) ?? 0) + 1);
}

/** 最后一个查找框离开文档后，才取消仍在运行的补全工作。 */
export function releaseBackgroundCorpusRoot(rootId: string): void {
    const users = backgroundRootUsers.get(rootId) ?? 0;
    if (users <= 1) {
        backgroundRootUsers.delete(rootId);
        cancelRootBackgroundCorpusJobs(rootId);
        return;
    }
    backgroundRootUsers.set(rootId, users - 1);
}

function hasBackgroundCorpusUser(rootId: string): boolean {
    return (backgroundRootUsers.get(rootId) ?? 0) > 0;
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
): {units: CachedUnit[]; unrendered: number;} {
    const scope = collectionScope(options);
    const initial = cachedUnits(rootId, metas, scope);
    if (initial.missing.length === 0) {
        return {units: initial.ready, unrendered: initial.unrendered};
    }
    const previous = warmupTimers.get(rootId);
    if (previous != null) {
        window.clearTimeout(previous);
    }
    const timer = window.setTimeout(() => {
        warmupTimers.delete(rootId);
        const missing = cachedUnits(rootId, metas, scope).missing;
        if (missing.length === 0) {
            notifyIndexSettled(rootId);
            return;
        }
        const diagrams = missing.filter(isDiagramMeta);
        const lights = missing.filter((item) => !isDiagramMeta(item));
        startJob(`special-rest:${rootId}`, rootId, async (isCurrent, signal) => {
            if (lights.length > 0) {
                await extractMetas(rootId, notebookId, lights, options, "light", isCurrent, signal);
            }
            for (let index = 0; index < diagrams.length; index += 2) {
                if (!isCurrent()) {
                    return;
                }
                const pair = diagrams.slice(index, index + 2);
                await extractMetas(rootId, notebookId, pair, options, "diagram", isCurrent, signal);
            }
        });
    }, SPECIAL_WARMUP_MS);
    warmupTimers.set(rootId, timer);
    return {units: initial.ready, unrendered: initial.unrendered};
}

function jobRunning(prefix: string): boolean {
    for (const [key, job] of jobs) {
        if (job.epoch === currentCorpusEpoch(job.rootId) && key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function jobFailed(prefix: string): boolean {
    const now = Date.now();
    pruneJobFailures(now);
    for (const [key, failure] of jobFailures) {
        if (failure.retryAfter > now && key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function jobTruncated(prefix: string): boolean {
    const now = Date.now();
    pruneJobFailures(now);
    for (const [key, failure] of jobFailures) {
        if (failure.truncated && failure.retryAfter > now && key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

type CandidateTriple = [string[] | null, string[] | null, string[] | null];

interface CandidateQuery {
    regexGroups: ReturnType<typeof extractRegexLiteralGroups>;
    /** null 表示这次正则没有可下推的字面量，调用方保持原有全量或仅备注路径。 */
    triple: Promise<CandidateTriple | null> | null;
    memoHosts: Promise<string[] | null> | null;
}

/**
 * 候选 SQL 只依赖文档签名和关键词，可以和顺序、语言查询以及同步 DOM 扫描重叠。
 * 成功结果按签名复用；失败不写入，避免把“查询失败”记成空候选。
 * 不另建文本索引：未改块已经按块哈希跳过离屏渲染，第二套索引会有召回分叉的风险。
 */
function beginCandidateQuery(input: {
    rootId: string;
    signature: string;
    keyword: string;
    caseSensitive: boolean;
    regex: boolean;
    regexUnicode: boolean;
    needContentCandidates: boolean;
    collectMemo: boolean;
    needImageTitleCandidates: boolean;
    memoOnlyRestriction: boolean;
    signal?: AbortSignal;
}): CandidateQuery {
    const memoHosts = () =>
        memoizedIds(
            queryMemoKey(input.rootId, "memo-hosts"),
            input.signature,
            () => fetchMemoCandidateIds(input.rootId, input.signal),
        );
    if (input.regex) {
        const groups = extractRegexLiteralGroups(input.keyword, input.caseSensitive, {
            unicode: input.regexUnicode,
        });
        if (!groups) {
            return {
                regexGroups: null,
                triple: null,
                memoHosts: input.memoOnlyRestriction ? memoHosts().catch((): null => null) : null,
            };
        }
        const detail = JSON.stringify(groups);
        return {
            regexGroups: groups,
            triple: Promise.all([
                input.needContentCandidates ?
                    memoizedIds(
                        queryMemoKey(input.rootId, "rg-content", `${input.caseSensitive}:${detail}`),
                        input.signature,
                        () =>
                            fetchLiteralGroupCandidateIds(
                                input.rootId,
                                groups,
                                input.caseSensitive,
                                "content",
                                input.signal,
                            ),
                    ) :
                    Promise.resolve([] as string[]),
                input.collectMemo ? memoHosts() : Promise.resolve([] as string[]),
                input.needImageTitleCandidates ?
                    memoizedIds(
                        queryMemoKey(input.rootId, "rg-title", `${input.caseSensitive}:${detail}`),
                        input.signature,
                        () =>
                            fetchLiteralGroupCandidateIds(
                                input.rootId,
                                groups,
                                input.caseSensitive,
                                "imageTitle",
                                input.signal,
                            ),
                    ) :
                    Promise.resolve([] as string[]),
            ]).catch((): null => null),
            memoHosts: null,
        };
    }
    return {
        regexGroups: null,
        triple: Promise.all([
            input.needContentCandidates ?
                memoizedIds(
                    queryMemoKey(input.rootId, "content", `${input.caseSensitive}:${input.keyword}`),
                    input.signature,
                    () => fetchContentCandidateIds(input.rootId, input.keyword, input.caseSensitive, input.signal),
                ) :
                Promise.resolve([] as string[]),
            input.collectMemo ? memoHosts() : Promise.resolve([] as string[]),
            input.needImageTitleCandidates ?
                memoizedIds(
                    queryMemoKey(input.rootId, "title", `${input.caseSensitive}:${input.keyword}`),
                    input.signature,
                    () => fetchImageTitleCandidateIds(input.rootId, input.keyword, input.caseSensitive, input.signal),
                ) :
                Promise.resolve([] as string[]),
        ]).catch((): null => null),
        memoHosts: null,
    };
}

async function loadAvRefs(
    rootId: string,
    signal?: AbortSignal,
): Promise<{refs: AvBlockRef[]; cacheable: boolean;} | null> {
    const root = escSql(rootId);
    const rows = await querySqlAll<{id: string; updated?: string; markdown?: string; ial?: string;}>(
        (afterId, limit) => {
            const after = afterId ? ` AND id > '${escSql(afterId)}'` : "";
            return `SELECT id, updated, markdown, ial FROM blocks WHERE root_id = '${root}' AND type = 'av'${after} ` +
                `ORDER BY id LIMIT ${limit}`;
        },
        signal,
    );
    if (!rows) {
        return null;
    }
    return resolveMissingAvIds(rows, signal);
}

async function loadMemoizedAvRefs(
    rootId: string,
    signature: string,
    signal?: AbortSignal,
): Promise<{refs: AvBlockRef[]; failed: boolean;}> {
    const key = queryMemoKey(rootId, "avrefs");
    const epoch = pinAvRefEpoch(rootId);
    const cached = readQueryMemo<AvBlockRef[]>(key, signature);
    if (cached !== undefined) {
        return {refs: cached, failed: false};
    }
    const loaded = await loadAvRefs(rootId, signal);
    if (!loaded) {
        return {refs: [], failed: true};
    }
    if (loaded.cacheable && signal?.aborted !== true && epoch === currentAvRefEpoch(rootId)) {
        writeQueryMemo(key, signature, loaded.refs);
    }
    return {refs: loaded.refs, failed: false};
}

/**
 * 与 highlight-search 一致：只有当前能看见的块才用编辑器里的文本。
 * 高度为 0、或落在非标题折叠里的块，DOM 里往往没有正文，必须再读 getBlockDOMs。
 */
const TABLE_ZW_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const TABLE_CELL_UNIT = "table-cell:";

function stripTableZw(text: string): string {
    return text.replace(TABLE_ZW_RE, "");
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
    return Boolean(row && row.hasAttribute(TABLE_VIRTUAL_ROWS_ATTR));
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
    const rows = ownTableRows(tableBlock);
    if (!rows) {
        return {shownKeys, rowIndex, unstable: true};
    }
    const placed = logicalTableRows(rows);
    if (!placed.stable) {
        return {shownKeys, rowIndex, unstable: true};
    }
    for (let index = 0; index < rows.length; index += 1) {
        const place = placed.rows[index];
        if (!place || place.omitted > 0) {
            continue;
        }
        const row = rows[index];
        rowIndex.set(row, place.logical);
        const children = row.children;
        let column = 0;
        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
            const child = children[childIndex];
            if (!isDirectTableCell(child)) {
                continue;
            }
            shownKeys.add(place.logical + ":" + column);
            column += 1;
        }
    }
    return {shownKeys, rowIndex, unstable: false};
}

function isVisuallyInEditor(element: HTMLElement): boolean {
    // 行内公式是 inline，clientHeight 为 0，但仍然占位。用客户区矩形判断。
    const hasBox = element.clientHeight > 0 ||
        (typeof element.getClientRects === "function" && element.getClientRects().length > 0);
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
    const cancelled = () => options.signal?.aborted === true;
    if (cancelled()) {
        return {matches: [], error: "", cancelled: true};
    }
    const context = readContext(edit);
    if (!context) {
        return null;
    }
    const keyword = effectiveSearchQuery(value);
    if (!keyword) {
        return null;
    }
    // 异步的全文查询可能在查找框关闭或切换文档后才走到后台补全分支。
    // 这时保留本次前台结果即可，不能重新启动已经取消的后台任务。
    const allowBackgroundJobs = hasBackgroundCorpusUser(context.rootId);
    if (options.regex) {
        try {
            createSearchPattern(keyword, {
                regex: true,
                caseSensitive: options.caseSensitive === true,
                regexUnicode: options.regexUnicode === true,
                regexMultiline: options.regexMultiline === true,
                regexDotAll: options.regexDotAll === true,
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

    const meta = await loadDocMeta(context.rootId, options.signal);
    if (cancelled()) {
        return {matches: [], error: "", cancelled: true};
    }
    if (!meta) {
        // 元数据失败时不能把“只查到已加载 DOM”伪装成完整结果；交给调用方走显式降级路径。
        return null;
    }
    // 围栏语言同时决定独立开关、图表渲染和缓存归类。三项都关闭时没有代码块候选，
    // 才可跳过查询；查询失败会保守走普通代码路径，下轮搜索仍可重试。
    const caseSensitive = options.caseSensitive === true;
    const keepRestrict = isRestrictInlineActive(options.restrictInlineTypes);
    // 限制只含备注时，正文、图片标题和行内公式都不会进入最终结果。
    // 不能仍按正文关键词把大量无关块取回并离屏渲染；Memo 自身的 SQL 候选
    // 已是完整超集（富文本属性可能把关键词拆开，故不能再按关键词缩窄）。
    const collectBodyText = shouldCollectBodyTextForRestrict(options.restrictInlineTypes);
    const collectMemo = shouldCollectInlineMemoUnits({
        includeInlineMemo: options.includeInlineMemo === true,
        restrictTypes: options.restrictInlineTypes,
    });
    const collectInlineMath = shouldCollectInlineMathUnits(options.restrictInlineTypes);
    const memoOnlyRestriction = collectMemo && !collectBodyText && !collectInlineMath;
    const needContentCandidates = collectBodyText || collectInlineMath;
    const needImageTitleCandidates = !keepRestrict && options.includeImageTitle !== false;
    const languagesPromise = (codeBlockLanguagesNeeded(options) ?
        ensureCodeBlockLanguages(context.rootId, meta, options.signal) :
        Promise.resolve(true)).catch((): false => false);
    const orderPromise = fetchDocBlocksOrders(context.rootId, meta.signature, options.signal)
        .catch((): null => null);
    const candidateQuery = beginCandidateQuery({
        rootId: context.rootId,
        signature: meta.signature,
        keyword,
        caseSensitive,
        regex: options.regex === true,
        regexUnicode: options.regexUnicode === true,
        needContentCandidates,
        collectMemo,
        needImageTitleCandidates,
        memoOnlyRestriction,
        signal: options.signal,
    });
    const avRefsPromise = options.includeAttributeView === false ?
        Promise.resolve({refs: [] as AvBlockRef[], failed: false}) :
        loadMemoizedAvRefs(context.rootId, meta.signature, options.signal)
            .catch((): null => null);
    const remoteOrder = await orderPromise;
    if (cancelled()) {
        return {matches: [], error: "", cancelled: true};
    }
    const reliableOrder = remoteOrder && (remoteOrder.length > 0 || meta.byId.size === 0) ?
        remoteOrder :
        null;
    const orders = reliableOrder ?? meta.fallbackOrder;
    // fallbackOrder 的同级块按 id 排列，只能用于稳定展示，不能据此推断标题折叠边界。
    // getDocBlocksOrders 不可用时保守放行，避免把实际可见块误判成隐藏而漏召回。
    // 即使允许搜索折叠内容，也要知道标题卸载了哪些后代，避免把折叠区域误判为可见。
    const mountedFolds = mountedFoldState(edit);
    const headingFoldedHidden = !reliableOrder ?
        new Set<string>() :
        collectHeadingFoldedIds(reliableOrder, meta.links, mountedFolds.headings);
    /** 包含被更外层标题遮住的标题。 */
    const foldedHeadingIds = new Set(mountedFolds.headings.foldedIds);
    const focusId = editorFocusId(edit);
    if (mountedFolds) {
        // 标题被动态卸载后已经没有 DOM 可供 mountedFoldState 读取，但它的 IAL
        // 仍能指出该标题自身折叠。getHeadingChildrenIDs 由内核树判断后代范围，
        // 能覆盖 SQL parent_id 不足以表达的标题/容器组合。
        // 当前画面可能同时挂着大量折叠标题；保留既有 32 条精确校正上限。
        // 未挂载标题没有这条精确链路就会漏召回，不能套用这个上限。
        const exactFoldedHeadingIds = new Set(Array.from(mountedFolds.headings.foldedIds).slice(0, 32));
        for (const [id, node] of meta.links) {
            if (
                node.type === "h" &&
                !mountedFolds.headings.mountedIds.has(id) &&
                isSelfFoldedIal(node.ial)
            ) {
                foldedHeadingIds.add(id);
                exactFoldedHeadingIds.add(id);
            }
        }
        const exactHeadingHidden = await collectExactHeadingHiddenIds(
            context.rootId,
            meta.signature,
            exactFoldedHeadingIds,
            meta.links,
            options.signal,
        );
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        exactHeadingHidden.forEach((id) => headingFoldedHidden.add(id));
    }
    // 折叠范围已经确定后再读编辑器。语言、候选 SQL 和数据库引用在这之前已经发出，
    // 扫描期间可以继续返回。
    const liveAll = collectSearchableBlocks(edit, {
        ...collectOptions(options),
        includeDocTitle: options.includeDocTitle !== false && !focusId,
        includeAttributeView: options.includeAttributeView !== false,
    });
    const languagesReady = await languagesPromise;
    if (cancelled()) {
        return {matches: [], error: "", cancelled: true};
    }
    // 失败时仍按普通代码块继续，但不能把这次结果说成覆盖完整。
    const languageQueryFailed = codeBlockLanguagesNeeded(options) && !languagesReady;
    const focusScope = focusId ? collectFocusScope(focusId, meta, orders) : null;
    // 聚焦但关系表里还没有这个块时，不把文档其余未加载块算进来。
    const inFocus = (id: string) => !focusId || Boolean(focusScope?.has(id));
    const orderIndex = orderIndexOf(orders);
    const scope = collectionScope(options);
    const enabledCache = new Map<string, boolean>();
    const nonHeadingFoldedCache = new Map<string, boolean>();
    const enabled = (item: BlockMeta) => {
        const known = enabledCache.get(item.id);
        if (known !== undefined) {
            return known;
        }
        const value = isBlockTreeEnabled(item.id, meta.links, options) &&
            !(options.includeTabs === false && isInTabsBlock(item.id, meta.links)) &&
            !(options.includeMindmap === false && isInMindmapBlock(item.id, meta.links)) &&
            isBlockTypeEnabled(item, options) &&
            (options.includeFoldedBlocks === true ||
                (!isUnderNonHeadingFold(item.id, meta.links, mountedFolds!.nonHeadings, nonHeadingFoldedCache) &&
                    !headingFoldedHidden.has(item.id)));
        enabledCache.set(item.id, value);
        return value;
    };

    // 数据库单元格跟 highlight-search 一样走当前编辑器里的可见文字。
    // 离屏抽取仍关掉整块拼接，避免相邻单元格粘成一次误匹配。
    // 整张表都挂在画面里时直接用这些格子，未落库的修改不必再等 getBlockDOM。
    // 虚拟大表只替换已经挂出来的格子，屏外行仍用完整表。
    const liveIds = new Set<string>();
    let units: CachedUnit[] = [];
    const foldedLiveDiagramBlocks = new Map<string, SearchableBlock>();
    const foldedLiveDiagramFallback = new Map<string, CachedUnit[]>();
    // 预筛选若执行正则，灾难性回溯仍会卡住主线程。正则模式宁可多传几个表格单元给 Worker，
    // 也不能在此处调用 RegExp.test；最终匹配仍由 Worker 给出精确结果。
    const cellMayMatch = options.regex ?
        () => true :
        createTextMatchProbe(keyword, {
            caseSensitive: options.caseSensitive === true,
            wholeWord: options.wholeWord === true,
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
    /** 当前画面已有的块文本。行级公式必须连同同一父块的普通文本一起冻结，偏移才稳定。 */
    const liveUnitsByBlockId = new Map<string, CachedUnit[]>();
    const noteLiveUnit = (block: SearchableBlock, item: BlockMeta | undefined, unit: CachedUnit) => {
        if (!item) {
            return;
        }
        const existing = liveUnitsByBlockId.get(block.blockId);
        if (existing) {
            existing.push(unit);
        } else {
            liveUnitsByBlockId.set(block.blockId, [unit]);
        }
    };
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
        const column = row instanceof HTMLTableRowElement ? directTableCellColumn(row, block.element) : -1;
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
            tableOverlayKey(block.unitId) || position,
            freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex),
        );
    };
    // folded live diagrams may consult the special cache before cachedUnits(); keep
    // theme changes from reusing SVG text generated under the previous appearance.
    syncRenderSettingsCache();
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
        // 数据库不记录代码块语言。先用编辑器 data-subtype 覆盖，
        // 否则 Mermaid / flowchart 会被普通代码块开关一起丢掉。
        if (item && noteLiveCodeLanguage(item, block.element)) {
            enabledCache.delete(item.id);
        }
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
        if (item && isSpecialRenderMeta(item) && !block.text.trim()) {
            continue;
        }
        // 非标题折叠只用 CSS 隐藏，正文和行内公式仍在 DOM 里。
        // collectSearchableBlocks 已按开关和类型门闩过滤过；开启“搜索折叠块内容”后，
        // 这里不能再以几何可见性丢掉这些已有文字，否则会先少计、再离屏重抽一次。
        const reusableFoldedLiveText = options.includeFoldedBlocks === true &&
            Boolean(block.text.trim()) &&
            isUnderNonHeadingCssFold(block.element);
        if (!isVisuallyInEditor(block.element) && !reusableFoldedLiveText) {
            continue;
        }
        liveIds.add(block.blockId);
        const frozen = freezeLive(block, orderIndex.get(block.blockId) ?? block.blockIndex);
        if (
            item &&
            isDiagramMeta(item) &&
            !memoOnlyRestriction &&
            isUnderNonHeadingCssFold(block.element)
        ) {
            const cached = textCache.get(cacheKey(context.rootId, item.id, scope));
            if (cached && cached.hash === item.hash && cached.retryAfter === undefined) {
                touchTextCache(cacheKey(context.rootId, item.id, scope));
                units.push(...cached.units);
                continue;
            }
            foldedLiveDiagramBlocks.set(block.blockId, block);
            const fallback = foldedLiveDiagramFallback.get(block.blockId);
            if (fallback) {
                fallback.push(frozen);
            } else {
                foldedLiveDiagramFallback.set(block.blockId, [frozen]);
            }
            continue;
        }
        units.push(frozen);
        noteLiveUnit(block, item, frozen);
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

    // 标题折叠会直接卸载其后代 DOM。若该后代刚刚显示过，就把已经得到的“可见文字”
    // 写入现有的版本化缓存：特殊渲染块无需等首次离屏渲染，行级公式保留与父正文相同的偏移。
    for (const [blockId, liveUnits] of liveUnitsByBlockId) {
        const item = meta.byId.get(blockId);
        if (!item) {
            continue;
        }
        if (isSpecialRenderMeta(item)) {
            remember(context.rootId, item, liveUnits, scope);
            continue;
        }
        if (canCachePlainText(item) && liveUnits.some(isInlineMathSearchUnit)) {
            rememberPlain(context.rootId, blockId, scope, item.hash, liveUnits);
        }
    }
    let unrendered = 0;
    let truncated = 0;
    let degraded = languageQueryFailed;
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
        if (isSpecialRenderMeta(item)) {
            specialTargets.push(item);
        } else {
            plainTargets.push(item);
        }
    };
    const queueRemainingSpecials = (includeDiagrams = true) => {
        const queued = new Set(specialTargets.map((item) => item.id));
        for (const item of meta.byId.values()) {
            if (!enabled(item) || liveIds.has(item.id) || queued.has(item.id) || !inFocus(item.id)) {
                continue;
            }
            if (!isSpecialRenderMeta(item)) {
                continue;
            }
            // blocks.content 包含并反转义 NodeCodeBlockCode；图表的可见标签
            // 来自这段源码，所以候选 SQL 已经是安全超集。只有公式/HTML
            // 仍可能在源码与 renderer 文字之间发生不可下推的变化。
            // 无关图表交给后台缓存会触发 Mermaid/flowchart 的异步 renderer，
            // 让每次普通搜索都长时间停在索引中；SQL 失败时走下方全量回退。
            if (!includeDiagrams && isDiagramMeta(item)) {
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
            (isSpecialRenderMeta(item) ? specialTargets : plainTargets).push(item);
        }
    };

    let prefiltered = false;
    let storePlainCache = !options.regex;
    let contentCandidateIds: Set<string> | null = null;
    if (options.regex) {
        const groups = candidateQuery.regexGroups;
        if (groups && candidateQuery.triple) {
            const triple = await candidateQuery.triple;
            if (cancelled()) {
                return {matches: [], error: "", cancelled: true};
            }
            const contentIds = triple?.[0] ?? null;
            const memoIds = triple?.[1] ?? null;
            const titleIds = triple?.[2] ?? null;
            // 空数组是“查到了但没有候选”，不能当成查询失败。
            if (contentIds !== null && memoIds !== null && titleIds !== null) {
                prefiltered = true;
                contentCandidateIds = new Set(contentIds);
                storePlainCache = regexPrefilterStoresPlainCache(groups);
                for (const id of new Set<string>([...contentIds, ...memoIds, ...titleIds])) {
                    queueUnloaded(id);
                }
                // 公式和 HTML 的可见文字可能不在 content 里，不能靠字面量丢掉。
                // 图表源码由 blocks.content 提供安全候选，只有命中的图表进入前台
                // 渲染；仅备注时 memoIds 已覆盖全部备注宿主，额外预热无备注的特殊
                // 块只会争用前台请求。
                if (!memoOnlyRestriction) {
                    queueRemainingSpecials(false);
                }
            }
        }
        if (!prefiltered) {
            // 没有可用于正则预筛的字面量时，普通正文仍只能全量抽取。
            // 但“仅备注”已知所有候选都带 data-inline-memo-content，可保持完整召回
            // 的同时避开与备注无关的块。
            if (memoOnlyRestriction) {
                const memoIds = candidateQuery.memoHosts ?
                    await candidateQuery.memoHosts :
                    await fetchMemoCandidateIds(context.rootId, options.signal);
                if (cancelled()) {
                    return {matches: [], error: "", cancelled: true};
                }
                if (memoIds) {
                    memoIds.forEach(queueUnloaded);
                } else {
                    queueEveryUnloaded();
                }
            } else {
                queueEveryUnloaded();
            }
        }
    } else {
        const triple = await candidateQuery.triple;
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        const contentIds = triple?.[0] ?? null;
        const memoIds = triple?.[1] ?? null;
        const titleIds = triple?.[2] ?? null;
        if (contentIds === null || memoIds === null || titleIds === null) {
            // SQL 不可用时由文档元数据扩大到全部未加载叶子，保持结果完整性。
            queueEveryUnloaded();
        } else {
            contentCandidateIds = new Set(contentIds);
            for (const id of new Set<string>([...contentIds, ...memoIds, ...titleIds])) {
                queueUnloaded(id);
            }
        }
        if (!memoOnlyRestriction) {
            const queuedSpecials = new Set(specialTargets.map((item) => item.id));
            const restSpecials: BlockMeta[] = [];
            for (const item of meta.byId.values()) {
                if (!enabled(item) || liveIds.has(item.id) || queuedSpecials.has(item.id) || !inFocus(item.id)) {
                    continue;
                }
                if (!isSpecialRenderMeta(item)) {
                    continue;
                }
                // 图表只在当前查询确实需要时离屏渲染。无关图表的后台预热会
                // 触发 Mermaid/flowchart 的异步脚本和布局等待，导致搜索计数
                // 长时间处于索引状态，却不会增加本次查询的召回。
                const language = effectiveCodeLanguage(item);
                if (language === "mermaid" || language === "flowchart") {
                    continue;
                }
                restSpecials.push(item);
            }
            if (restSpecials.length > 0 && allowBackgroundJobs) {
                const warmup = scheduleSpecialWarmup(context.rootId, context.notebookId, restSpecials, options);
                units.push(...warmup.units);
                unrendered += warmup.unrendered;
            }
        }
    }

    // 全文抽块的正则不写入普通正文缓存，避免把关键词缓存挤掉。
    if (plainTargets.length > 0) {
        const loaded = await loadPlainUnits(
            context.rootId,
            context.notebookId,
            plainTargets,
            options,
            scope,
            storePlainCache,
            memoOnlyRestriction ? "none" : "light",
            () => !cancelled(),
            options.signal,
        );
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        units.push(...loaded.units);
        unrendered += loaded.unrendered;
        degraded ||= loaded.failed;
    }

    const specialState = cachedUnits(context.rootId, specialTargets, scope);
    units.push(...specialState.ready);
    unrendered += specialState.unrendered;
    // Mermaid / flowchart 的可搜索文字只存在 renderer 生成的 SVG/foreignObject 中。
    // 折叠标题、折叠列表和未加载区域没有 live SVG；如果把它们全部交给后台任务，
    // 首轮搜索只能等缓存完成后再命中。候选图块在当前搜索中同步离屏渲染，保证
    // 首次搜索的召回；普通公式/HTML 及未被候选命中的特殊块仍走后台补全，避免把
    // 大量无关图表的渲染成本放到每次输入的前台路径。
    const missingDiagrams = specialState.missing.filter(isDiagramMeta);
    const specialMissing = specialState.missing.filter((item) => !isDiagramMeta(item));
    if (missingDiagrams.length > 0) {
        const rendered = await extractMetas(
            context.rootId,
            context.notebookId,
            missingDiagrams,
            options,
            "diagram",
            () => !cancelled(),
            options.signal,
        );
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        units.push(...rendered.units);
        unrendered += rendered.unrendered;
        degraded ||= rendered.failed;
    }
    if (specialMissing.length > 0 && allowBackgroundJobs) {
        startJob(`special:${context.rootId}`, context.rootId, async (isCurrent, signal) => {
            await extractMetas(context.rootId, context.notebookId, specialMissing, options, "light", isCurrent, signal);
        });
    }

    if (foldedLiveDiagramBlocks.size > 0) {
        const languages = new Map<string, string>();
        for (const id of foldedLiveDiagramBlocks.keys()) {
            const item = meta.byId.get(id);
            const language = item ? effectiveCodeLanguage(item) : "";
            if (language) {
                languages.set(id, language);
            }
        }
        const sourceProbe = !options.regex ?
            createTextMatchProbe(keyword, {
                caseSensitive: options.caseSensitive === true,
                wholeWord: options.wholeWord === true,
            }) :
            null;
        const selected = Array.from(foldedLiveDiagramBlocks.entries()).filter(([id, block]) => {
            if (contentCandidateIds === null || contentCandidateIds.has(id)) {
                return true;
            }
            if (options.regex) {
                // 没有必现字面量时无法安全地用 SQL 缩小范围；有字面量时
                // content 候选是安全超集，继续保留轻量路径。
                return candidateQuery.regexGroups === null;
            }
            // SQL 只看 blocks.content。图表源码可能含 HTML 实体或其它内核
            // 规范化差异，直接检查 data-content 可把这类折叠图表重新纳入，
            // 同时避免无关图表全部离屏渲染。
            const source = diagramSourceText(block.element);
            return source.length === 0 || Boolean(sourceProbe?.(source));
        });
        if (selected.length === 0) {
            for (const fallback of foldedLiveDiagramFallback.values()) {
                units.push(...fallback);
            }
        } else {
            const selectedIds = new Set(selected.map(([id]) => id));
            const selectedBlocks = selected.map(([, block]) => block);
            const selectedLanguages = new Map(
                selectedBlocks.map((block) => [block.blockId, languages.get(block.blockId) ?? ""]),
            );
            let refreshed: Awaited<ReturnType<typeof extractDiagramUnitsFromLive>> | null = null;
            try {
                refreshed = await extractDiagramUnitsFromLive(
                    selectedBlocks,
                    extractionCollectOptions(options),
                    selectedLanguages,
                    () => !cancelled(),
                    options.signal,
                );
            } catch {
                // 保留当前 live 文字；一次 renderer 异常不能让整个搜索链路失败。
            }
            if (cancelled()) {
                refreshed?.dispose();
                return {matches: [], error: "", cancelled: true};
            }
            try {
                const refreshedById = new Map<string, CachedUnit[]>();
                for (const unit of (refreshed?.blocks ?? []).map((block) => freezeBlock(block))) {
                    const list = refreshedById.get(unit.blockId) ?? [];
                    list.push(unit);
                    refreshedById.set(unit.blockId, list);
                }
                for (const id of foldedLiveDiagramBlocks.keys()) {
                    const full = refreshedById.get(id);
                    const fallback = foldedLiveDiagramFallback.get(id);
                    if (!selectedIds.has(id)) {
                        units.push(...(fallback ?? []));
                        continue;
                    }
                    const chosen = full && full.length > 0 ? full : (fallback ?? []);
                    units.push(...chosen);
                    const item = meta.byId.get(id);
                    const rendererFailed = refreshed?.unrenderedIds.includes(id) === true;
                    if (item && full && full.length > 0) {
                        remember(context.rootId, item, chosen, scope);
                    } else if (item && rendererFailed) {
                        rememberUnrendered(context.rootId, item, scope);
                    } else if (item && chosen.length > 0 && refreshed) {
                        // A successful fallback remains usable; exceptions are retried
                        // on the next search instead of being cached as complete output.
                        remember(context.rootId, item, chosen, scope);
                    }
                }
                unrendered += refreshed?.unrenderedIds.length ?? 0;
            } finally {
                refreshed?.dispose();
            }
        }
    }

    if (options.includeAttributeView !== false) {
        const loadedRefs = await avRefsPromise;
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        if (!loadedRefs || loadedRefs.failed) {
            degraded = true;
        }
        const refs = (loadedRefs?.refs ?? []).filter((ref) => {
            const item = meta.byId.get(ref.blockId);
            return (!item || enabled(item)) && inFocus(ref.blockId);
        });
        const avDom = collectAvDomCoverage(units);
        const usedRowLabels = new Map<string, Set<string>>();
        const avViewTypes = new Map<string, string>();
        const avViewIds = new Map<string, string>();
        for (const ref of refs) {
            if (!liveIds.has(ref.blockId)) {
                continue;
            }
            const viewId = avViewIdOf(edit, ref.blockId, avViewIds);
            if (viewId) {
                avViewIds.set(ref.blockId, viewId);
            }
        }
        const peeked = peekAvUnits(refs, avViewIds);
        for (const unit of peeked.units) {
            if (liveIds.has(unit.blockId)) {
                const coverage = avDom.get(unit.blockId);
                const viewType = avViewTypeOf(edit, unit.blockId, avViewTypes);
                // 当前视图没画出来的列不补。列表和日历通常只有主键。
                if (coverage && !avApiUnitInView(unit.unitId ?? "", coverage, viewType)) {
                    continue;
                }
                // 画面上已有文字的格子保留 Range。接口只补同一视图里没画出来的行。
                if (
                    coverage && avApiUnitShown(
                        unit.unitId ?? "",
                        unit.text,
                        coverage,
                        rowLabelSkip(usedRowLabels, unit.blockId),
                    )
                ) {
                    continue;
                }
            }
            units.push(avToCached(unit, orderIndex));
        }
        if (peeked.missing.length > 0 && allowBackgroundJobs) {
            const missing = peeked.missing;
            const avJobPrefix = `av:${context.rootId}`;
            startJob(`${avJobPrefix}:${meta.signature}`, context.rootId, async (isCurrent, signal) => {
                await loadAvUnits(missing, isCurrent, avViewIds, signal);
            });
            if (jobFailed(avJobPrefix)) {
                const unavailable = new Set(missing.map((ref) => ref.blockId)).size;
                unrendered += unavailable;
                if (jobTruncated(avJobPrefix)) {
                    truncated += unavailable;
                }
            }
        }
    }

    let tableStale = new Set<string>();
    if (virtualTables.size > 0) {
        const merged = mergeVirtualTableUnits(units, virtualTables);
        units = merged.units;
        tableStale = merged.staleKeys;
    }

    // live、缓存和离屏提取可能在同一轮为同一个块提供同一份 renderer 单元。
    // 匹配器按数组元素计数，因此这里必须在匹配前收敛单元身份。renderer 的
    // block/unit 身份代表同一视觉标签；普通单元还要把文本纳入 key。这样同一
    // 图表中不同标签即使文字相同，unitId 也不同，仍然保留各自的可见命中。
    // 若同一图表同时出现 renderer 文字和普通代码/源码兜底，只保留 renderer
    // 文字，避免异常 DOM 或重复提取把同一可见词计两次。
    units = dedupeCorpusUnits(units);

    const matchOptions = {
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex,
        regexUnicode: options.regexUnicode,
        regexMultiline: options.regexMultiline,
        regexDotAll: options.regexDotAll,
        dedupeOverlaps: false,
    };
    const matched = options.regexMatcher ?
        await options.regexMatcher.match(
            toSearchUnits(units, orderIndex),
            value,
            matchOptions,
            options.signal,
        ) :
        matchTextUnitsDetailed(toSearchUnits(units, orderIndex), value, matchOptions);
    if ("cancelled" in matched && matched.cancelled) {
        return {matches: [], error: "", cancelled: true};
    }
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
        const nonReplaceable = hit.blockId === "__doc-title__" ||
            hit.unitId === "doc-title" ||
            hit.blockType === "doc-title" ||
            hit.blockType === "NodeAttributeView" ||
            hit.blockType === "NodeMathBlock" ||
            hit.blockType === "NodeHTMLBlock" ||
            isRendererUnitId(hit.unitId) ||
            hit.unitId === "mermaid-source" ||
            hit.unitId === "html-block-rendered" ||
            hit.unitId === "diagram-rendered" ||
            isInlineMathSearchUnit(unit) ||
            hit.unitId?.startsWith("embed:");
        const replaceLock = nonReplaceable ? undefined : virtualTableReplaceLock(virtualTables, unit);
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
            replaceable:
                (nonReplaceable || Boolean(replaceLock) || tableStale.has(`${hit.blockId}\u0000${hit.unitId ?? ""}`)) ?
                    false :
                    isHitReplaceableByUnit(unit, hit.start, hit.end),
            replaceLock,
            highlightKind: unit.highlightKind,
            ...(unit.highlightKind === "inline-math" && unit.mathOrdinal !== undefined ?
                {
                    mathOrdinal: unit.mathOrdinal,
                    mathUnitText: inlineMathIdentityText(unit.text),
                } :
                {}),
            snippet: unit.snippet,
            ...buildListSnippet(unit.text, hit.start, hit.end, hit.matchedText),
            anchorOffset: unit.highlightKind === "inline-memo" ? unit.anchorOffset : undefined,
            anchorEnd: unit.highlightKind === "inline-memo" ? unit.anchorEnd : undefined,
        });
    }
    matches.sort(compareMatchOrder);

    const partial = jobRunning(`special:${context.rootId}`) ||
        jobRunning(`special-rest:${context.rootId}`) ||
        warmupTimers.has(context.rootId) ||
        jobRunning(`av:${context.rootId}`);
    return {
        matches: projectRanges(edit, matches, options, liveAll),
        error: "",
        degraded,
        partial,
        unrendered,
        truncated,
    };
}

/**
 * 文字没变时合并会留下内核单元，编辑器是否还开着只存在于画面单元上。
 * 按逻辑行列把画面上的锁定带过来。公式等本来就不能替换，不再盖上这条原因。
 */
function virtualTableReplaceLock(
    tables: ReadonlyMap<string, {unstable: boolean; liveByKey: ReadonlyMap<string, CachedUnit>;}>,
    unit: CachedUnit,
): TableReplaceLock | undefined {
    if (unit.replaceLock) {
        return unit.replaceLock;
    }
    const state = tables.get(unit.blockId);
    if (!state || state.unstable) {
        return undefined;
    }
    const position = tableOverlayKey(unit.unitId);
    if (!position) {
        return undefined;
    }
    return state.liveByKey.get(position)?.replaceLock;
}

function compareMatchOrder(left: SearchMatch, right: SearchMatch): number {
    if (left.blockIndex !== right.blockIndex) {
        return left.blockIndex - right.blockIndex;
    }
    if (
        sameStructuralBlock(left, right) &&
        left.unitSeq !== undefined &&
        right.unitSeq !== undefined &&
        left.unitSeq !== right.unitSeq
    ) {
        return left.unitSeq - right.unitSeq;
    }
    const overlap = bodyBeforeOverlappingMemo(left, right);
    if (overlap !== 0) {
        return overlap;
    }
    const leftPos = left.highlightKind === "inline-memo" ?
        (left.anchorOffset ?? left.start) :
        left.start;
    const rightPos = right.highlightKind === "inline-memo" ?
        (right.anchorOffset ?? right.start) :
        right.start;
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
    const memo = left.highlightKind === "inline-memo" ?
        left :
        (right.highlightKind === "inline-memo" ? right : null);
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
    const tablePlaces = new Map<string, Array<{key: string; row: number; column: number; index: number;}>>();
    const byIndex = new Set<string>(indexRankedTables);
    units.forEach((unit, index) => {
        const key = `${unit.blockId}\u0000${unit.unitId ?? ""}`;
        if (isRendererUnitId(unit.unitId)) {
            // 同一图表的标签各自从 0 起算偏移；用单位顺序确保冷数据导航仍按 SVG DOM 顺序。
            seq.set(key, index);
        }
        const textRun = textRunIndex(unit.unitId);
        if (
            textRun !== undefined &&
            unit.blockType !== "NodeTable" &&
            unit.blockType !== "NodeAttributeView"
        ) {
            seq.set(key, textRun);
        }
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
        const slot = unit.highlightKind === "inline-memo" ?
            2 :
            (unit.tableSlot ? 0 : 1);
        const run = tableRunIndex(unit.unitId);
        // 没切开的格子保持原来的偏移序号。切开后每一段独占一段序号，段内仍按命中位置排。
        const atInRun = run === 0 ? at : Math.min(at, 1023);
        const inner = (run === 0 ? atInRun : run * 1024 + atInRun) * TABLE_CELL_SLOT + slot;
        return rank * TABLE_CELL_SEQ_SPAN + Math.min(inner, TABLE_CELL_SEQ_SPAN - 1);
    };
}

function textRunIndex(unitId: string | undefined): number | undefined {
    const matched = /(?:^|#)run-(\d+)$/.exec(unitId ?? "");
    return matched ? Number(matched[1]) : undefined;
}

function tableRunIndex(unitId: string | undefined): number {
    return textRunIndex(unitId) ?? 0;
}

function tableCellPlace(unitId: string | undefined): {row: number; column: number;} | null {
    const position = tableCellPosition(unitId);
    if (!position) {
        return null;
    }
    const colon = position.indexOf(":");
    return {row: Number(position.slice(0, colon)), column: Number(position.slice(colon + 1))};
}

function avMatchPosition(unitId: string | undefined): {row: string; col: string;} | null {
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
    return (left.blockType === "NodeTable" || left.blockType === "NodeAttributeView") &&
        left.blockType === right.blockType;
}

function avViewTypeOf(edit: Element, blockId: string, cache: Map<string, string>): string {
    const cached = cache.get(blockId);
    if (cached !== undefined) {
        return cached;
    }
    const block = edit.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    const direct = block?.getAttribute("data-av-type") || "";
    const focused = direct ?
        "" :
        block?.querySelector(".av__views .item--focus")?.getAttribute("data-av-type") || "";
    const viewType = direct || focused;
    cache.set(blockId, viewType);
    return viewType;
}

function avViewIdOf(edit: Element, blockId: string, cache: Map<string, string>): string {
    const cached = cache.get(blockId);
    if (cached !== undefined) {
        return cached;
    }
    const block = edit.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    const selected = block?.getAttribute("custom-sy-av-view")?.trim() ||
        block?.querySelector<HTMLElement>(".av__views .item--focus")?.dataset.id?.trim() ||
        "";
    cache.set(blockId, selected);
    return selected;
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
    unit: SearchableUnit & {snippet?: string;},
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
        const isMath = unit.blockType === "NodeMathBlock" ||
            unit.highlightKind === "inline-math" ||
            Boolean(unit.unitId?.startsWith("inline-math:"));
        if (!isMath) {
            kept.push(unit);
            continue;
        }
        const text = unit.text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
        const key = `${unit.blockId}\0${text}\0${unit.mathOrdinal ?? ""}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(unit);
    }
    return kept;
}

function dedupeCorpusUnits(units: CachedUnit[]): CachedUnit[] {
    const mathDeduped = dedupeMathUnits(units);
    const rendererBlocks = new Set<string>();
    for (const unit of mathDeduped) {
        if (rendererUnitSource(unit.unitId)) {
            rendererBlocks.add(unit.blockId);
        }
    }

    const seen = new Set<string>();
    const kept: CachedUnit[] = [];
    for (const unit of mathDeduped) {
        const source = rendererUnitSource(unit.unitId);
        if (
            rendererBlocks.has(unit.blockId) &&
            unit.blockType === "NodeCodeBlock" &&
            !source
        ) {
            // renderer 单元（包括 source-fallback）已经代表了整个图表块。
            // 异常 DOM 同时留下的普通代码文本不能再参与计数，否则同一
            // 个可见标签会在 renderer 与代码文本两条路径各命中一次。
            continue;
        }
        const key = source ?
            `${unit.blockId}\0${unit.unitId}` :
            `${unit.blockId}\0${unit.unitId ?? ""}\0${unit.highlightKind}\0${unit.text}`;
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
