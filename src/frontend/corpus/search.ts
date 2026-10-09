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
    isSelfFoldedIal,
    logicalTableRows,
    mergeVirtualTableUnits,
    ownTableRows,
    TABLE_VIRTUAL_ROWS_ATTR,
    tableCellPosition,
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
import {buildListSnippet} from "../list-snippet";
import type {
    SearchPipelineOptions,
    SearchPipelineResult,
} from "../pipeline";
import {
    escSql,
    querySqlAll,
} from "./api";
import {
    AttributeViewTruncatedError,
    invalidateAvCache,
    loadAvUnits,
    peekAvUnits,
    resolveMissingAvIds,
    type AvBlockRef,
} from "./av";
import {fetchAndExtractUnits} from "./extract";
import {
    collectFocusScope,
    editorFocusId,
} from "./focus";
import {
    codeBlockLanguagesNeeded,
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
}

export function invalidateDocumentSearchCaches(): void {
    // 清缓存时必须同时作废旧任务，否则旧任务完成后会把刚清掉的数据写回。
    cancelBackgroundCorpusJobs();
    invalidateTextCache();
    invalidateDocMeta();
    invalidateDocOrder();
    invalidateAvCache();
    jobFailures.clear();
}

/** savedoc 后只作废结构信息，保留哈希校验过的正文与特殊块缓存。 */
export function invalidateDocumentStructureCaches(rootId?: string): void {
    invalidateDocMeta(rootId);
    invalidateDocOrder(rootId);
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
        bytes += unit.restrictSpans.length * 40;
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
    writeSpecialCache(cacheKey(rootId, meta.id, scope), {hash: meta.hash, units});
}

function rememberUnrendered(rootId: string, meta: BlockMeta, scope: string): void {
    writeSpecialCache(cacheKey(rootId, meta.id, scope), {
        hash: meta.hash,
        units: [],
        retryAfter: Date.now() + SPECIAL_FAILURE_RETRY_MS,
    });
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
        );
    } catch {
        // 渲染器异常与接口失败使用同一条有限重试路径，不能让后台任务永久停在 partial。
        extracted = null;
    }
    if (!extracted) {
        const failedIds = metas
            .filter((meta) => isSpecialRenderType(meta.type, meta.subtype))
            .map((meta) => meta.id);
        if (epoch === currentCorpusEpoch(rootId)) {
            for (const meta of metas) {
                if (isSpecialRenderType(meta.type, meta.subtype)) {
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
        const cacheSpecial = mode !== "light" || isSpecialRenderType(meta.type, meta.subtype);
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
        const diagrams = missing.filter((item) => isDiagramBlock(item.type, item.subtype));
        const lights = missing.filter((item) => !isDiagramBlock(item.type, item.subtype));
        startJob(`special-rest:${rootId}`, rootId, async (isCurrent, signal) => {
            if (lights.length > 0) {
                await extractMetas(rootId, notebookId, lights, options, "light", isCurrent, signal);
            }
            for (let index = 0; index < diagrams.length; index += 2) {
                if (!isCurrent()) {
                    return;
                }
                const pair = diagrams.slice(index, index + 2);
                await Promise.all(pair.map((item) => {
                    return extractMetas(rootId, notebookId, [item], options, "diagram", isCurrent, signal);
                }));
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

async function loadAvRefs(rootId: string, signal?: AbortSignal): Promise<AvBlockRef[]> {
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
        return [];
    }
    return resolveMissingAvIds(rows, signal);
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
    // 三个开关一致时语言不影响结果，不读 markdown。不一致时才补围栏语言，
    // 这样关掉普通代码块不会把未加载的 Mermaid / flowchart 一起排除。
    if (codeBlockLanguagesNeeded(options)) {
        await ensureCodeBlockLanguages(context.rootId, meta, options.signal);
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
    }
    const remoteOrder = await fetchDocBlocksOrders(context.rootId, meta.signature, options.signal);
    if (cancelled()) {
        return {matches: [], error: "", cancelled: true};
    }
    const reliableOrder = remoteOrder && (remoteOrder.length > 0 || meta.byId.size === 0) ?
        remoteOrder :
        null;
    const orders = reliableOrder ?? meta.fallbackOrder;
    // fallbackOrder 的同级块按 id 排列，只能用于稳定展示，不能据此推断标题折叠边界。
    // getDocBlocksOrders 不可用时保守放行，避免把实际可见块误判成隐藏而漏召回。
    const mountedFolds = options.includeFoldedBlocks === true ? null : mountedFoldState(edit);
    const headingFoldedHidden = options.includeFoldedBlocks === true || !reliableOrder ?
        new Set<string>() :
        collectHeadingFoldedIds(reliableOrder, meta.links, mountedFolds?.headings);
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
    const focusId = editorFocusId(edit);
    const focusScope = focusId ? collectFocusScope(focusId, meta, orders) : null;
    // 聚焦但关系表里还没有这个块时，不把文档其余未加载块算进来。
    const inFocus = (id: string) => !focusId || Boolean(focusScope?.has(id));
    const orderIndex = orderIndexOf(orders);
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
    const liveAll = collectSearchableBlocks(edit, {
        ...collectOptions(options),
        includeDocTitle: options.includeDocTitle !== false && !focusId,
        includeAttributeView: options.includeAttributeView !== false,
    });
    const liveIds = new Set<string>();
    let units: CachedUnit[] = [];
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
    let truncated = 0;
    let degraded = false;
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
                needContentCandidates ?
                    fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "content", options.signal) :
                    Promise.resolve([] as string[]),
                collectMemo ?
                    fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "memo", options.signal) :
                    Promise.resolve([] as string[]),
                needImageTitleCandidates ?
                    fetchLiteralGroupCandidateIds(context.rootId, groups, caseSensitive, "imageTitle", options.signal) :
                    Promise.resolve([] as string[]),
            ]);
            if (cancelled()) {
                return {matches: [], error: "", cancelled: true};
            }
            if (contentIds && memoIds && titleIds) {
                prefiltered = true;
                storePlainCache = regexPrefilterStoresPlainCache(groups);
                for (const id of new Set<string>([...contentIds, ...memoIds, ...titleIds])) {
                    queueUnloaded(id);
                }
                // 公式、图表、HTML 的可见文字常常不在 content 里，不能靠字面量丢掉。
                // 仅备注时 memoIds 已覆盖全部备注宿主，额外预热无备注的特殊块只会争用前台请求。
                if (!memoOnlyRestriction) {
                    queueRemainingSpecials();
                }
            }
        }
        if (!prefiltered) {
            // 没有可用于正则预筛的字面量时，普通正文仍只能全量抽取。
            // 但“仅备注”已知所有候选都带 data-inline-memo-content，可保持完整召回
            // 的同时避开与备注无关的块。
            if (memoOnlyRestriction) {
                const memoIds = await fetchMemoCandidateIds(context.rootId, options.signal);
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
        const [contentIds, memoIds, titleIds] = await Promise.all([
            needContentCandidates ?
                fetchContentCandidateIds(context.rootId, keyword, caseSensitive, options.signal) :
                Promise.resolve([] as string[]),
            collectMemo ?
                fetchMemoCandidateIds(context.rootId, options.signal) :
                Promise.resolve([] as string[]),
            needImageTitleCandidates ?
                fetchImageTitleCandidateIds(context.rootId, keyword, caseSensitive, options.signal) :
                Promise.resolve([] as string[]),
        ]);
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
        if (!contentIds || !memoIds || !titleIds) {
            // SQL 不可用时由文档元数据扩大到全部未加载叶子，保持结果完整性。
            queueEveryUnloaded();
        } else {
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
                if (!isSpecialRenderType(item.type, item.subtype)) {
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
    const specialMissing = specialState.missing;
    if (specialMissing.length > 0 && allowBackgroundJobs) {
        const diagrams = specialMissing.filter((item) => isDiagramBlock(item.type, item.subtype));
        const lights = specialMissing.filter((item) => !isDiagramBlock(item.type, item.subtype));
        startJob(`special:${context.rootId}`, context.rootId, async (isCurrent, signal) => {
            await extractMetas(context.rootId, context.notebookId, lights, options, "light", isCurrent, signal);
            for (let index = 0; index < diagrams.length; index += 2) {
                if (!isCurrent()) {
                    return;
                }
                const pair = diagrams.slice(index, index + 2);
                await Promise.all(pair.map((item) => {
                    return extractMetas(
                        context.rootId,
                        context.notebookId,
                        [item],
                        options,
                        "diagram",
                        isCurrent,
                        signal,
                    );
                }));
            }
        });
    }

    if (options.includeAttributeView !== false) {
        const refs = (await loadAvRefs(context.rootId, options.signal)).filter((ref) => {
            const item = meta.byId.get(ref.blockId);
            return (!item || enabled(item)) && inFocus(ref.blockId);
        });
        if (cancelled()) {
            return {matches: [], error: "", cancelled: true};
        }
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
            toSearchUnits(dedupeMathUnits(units), orderIndex),
            value,
            matchOptions,
            options.signal,
        ) :
        matchTextUnitsDetailed(toSearchUnits(dedupeMathUnits(units), orderIndex), value, matchOptions);
    if (matched.cancelled) {
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
    const position = tableCellPosition(unit.unitId);
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
        const inner = at * TABLE_CELL_SLOT + slot;
        return rank * TABLE_CELL_SEQ_SPAN + Math.min(inner, TABLE_CELL_SEQ_SPAN - 1);
    };
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
