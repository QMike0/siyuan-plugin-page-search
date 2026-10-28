import {resolveImageOCRUnits} from "./image-ocr";
import {isImageOCRUnit, imageOCRPath} from "../shared/image-ocr";
import {codeLanguageSearchEnabled, isCodeLanguageUnit} from "../shared/code-block-language";
import type {Plugin} from "siyuan";
import {
    ATTRIBUTE_VIEW_TYPE,
    NON_REPLACEABLE_DOM_CLOSEST,
    effectiveSearchQuery,
    isRestrictInlineActive,
    isRendererUnitId,
    shouldEnumerateRestrictInline,
    type RestrictInlineType,
} from "../shared";
import type {
    MatchHit,
    MatchOptions,
    SearchableUnit,
} from "../shared";
import {matchTextUnitsDetailed} from "../shared";
import {isRendererSourceFallbackUnitId} from "../shared/renderer-units";
import {
    CALLOUT_TYPE,
    TABLE_TYPE,
    collectSearchableBlocks,
    isDocTitleSearchUnit,
    isInactiveTabSourceElement,
    isTabsTitleSearchUnit,
    tableCellReplaceLock,
    inlineMathIdentityText,
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
    isPreviewSyntheticBlockId,
} from "./blocks";
import {editorFocusId} from "./corpus/focus";
import {searchCurrentDocument} from "./corpus/search";
import type {
    SearchableBlock,
    SearchMatch,
} from "./dom-types";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {
    compareEmbeddedPositions,
    embeddedPositionAt,
    orderEmbeddedVisualMatches,
} from "./embedded-order";
import {buildListSnippet} from "./list-snippet";
import {deferRichCellCapability, resolveRichCellCapabilities, type RichCellCapability, type RichCellSearchInfo} from "./rich-table-cell";
import {searchableTextLengths} from "./text-runs";
import {
    createRangeFromBlockOffsets,
    isRangePlainTextOnly,
} from "./ranges";
import type {RegexTextMatcher} from "./regex-matcher";
import {enumerateRestrictInlineMatches} from "./restrict-enumerate";
import {
    createDomBlockTypeReader,
    passesResultTypeFilter,
    type ResultBlockType,
} from "./result-block-types";
import {matchRangePassesRestrictInline} from "./restrict-inline-dom";
import {
    cloneSelectionScope,
    getSelectionScope,
    isMatchWithinSelection,
    unitKey,
    type SelectionScope,
} from "./selection";

export interface SearchPipelineOptions extends MatchOptions {
    /** Temporary result-list filter; independent of persisted search preferences. */
    resultBlockTypes?: readonly ResultBlockType[];
    /** 正文采集快照，包含零命中单元；用于核对异步图表渲染后的搜索语义。 */
    onLiveUnitsCollected?: (blocks: readonly SearchableBlock[]) => void;
    /** 当前搜索框的正则隔离器；未提供时保留纯函数/内核调用的同步行为。 */
    regexMatcher?: RegexTextMatcher;
    /** 新输入或销毁 SearchBar 后作废本轮正则任务。 */
    signal?: AbortSignal;
    /** 仅在选区内查找；与打开时预填选区关键词无关 */
    selectionOnly?: boolean;
    /**
     * 已冻结的选区范围。省略且 selectionOnly 时由当前选区现场采集。
     * 现场为空时可传 rememberedScope 兜底（由 SearchBar 管理）。
     */
    selectionScope?: SelectionScope;
    /** 是否匹配文档标题；默认 true；命中可走 renameDoc 替换 */
    includeDocTitle?: boolean;
    /** 是否匹配图片标题；默认 true；可走块 transaction 替换 */
    includeImageTitle?: boolean;
    /** 是否匹配数据库；默认 true */
    includeAttributeView?: boolean;
    /** 是否匹配表格块；默认 true */
    includeTable?: boolean;
    /** 是否匹配引述块及其内部；默认 true */
    includeBlockquote?: boolean;
    /** 是否匹配提示块（含标题与内部）；默认 true */
    includeCallout?: boolean;
    /** 是否匹配超级块及其内部；默认 true */
    includeSuperBlock?: boolean;
    /** 是否匹配页签块及其内部、页签标题；默认 true */
    includeTabs?: boolean;
    /** 是否匹配思维导图块及其内部；默认 true。不含代码块里的思维导图。 */
    includeMindmap?: boolean;
    /** 是否匹配无序列表及其内部；默认 true */
    includeListUnordered?: boolean;
    /** 是否匹配有序列表及其内部；默认 true */
    includeListOrdered?: boolean;
    /** 是否匹配任务列表及其内部；默认 true */
    includeListTask?: boolean;
    /** 是否匹配段落块；默认 true */
    includeParagraph?: boolean;
    includeHeadingH1?: boolean;
    includeHeadingH2?: boolean;
    includeHeadingH3?: boolean;
    includeHeadingH4?: boolean;
    includeHeadingH5?: boolean;
    includeHeadingH6?: boolean;
    /** 是否匹配公式块；默认 true；不含行内公式 */
    includeMathBlock?: boolean;
    /** 是否匹配嵌入块及其内部渲染内容；默认 true */
    includeEmbedBlock?: boolean;
    /** 是否匹配普通代码块正文；默认 true。不含 Mermaid、flowchart。 */
    includeCodeBlock?: boolean;
    /** 是否匹配普通代码块语言标签；默认随正文开关。 */
    includeCodeLanguage?: boolean;
    /** 是否匹配 Mermaid；默认 true */
    includeMermaid?: boolean;
    /** 是否匹配 flowchart；默认 true */
    includeFlowchart?: boolean;
    /** 是否匹配 HTML 块渲染可见文字；默认 true；不可替换 */
    includeHtmlBlock?: boolean;
    includeCustomBlock?: boolean;
    /**
     * 是否匹配折叠块内的隐藏内容；默认 false（与历史行为一致）。
     * 非标题 CSS 折叠与折叠标题后代都受此控制；匹配时不展开，跳转时再展开。
     */
    includeFoldedBlocks?: boolean;
    /** 是否匹配行内备注；默认 false */
    includeInlineMemo?: boolean;
    /**
     * 限制查找行内类型；空 / 省略 = 不限制。
     * 非空时仅保留落在所选 data-type 内的命中（OR）；备注 unit 另判。
     */
    restrictInlineTypes?: RestrictInlineType[];
}

export interface SearchPipelineResult {
    matches: SearchMatch[];
    /** 非法正则等；空表示成功 */
    error: string;
    /**
     * 覆盖不完整：文档接口不可用、数据库列表或代码块语言查询失败。
     * 已打开区域里的命中仍在；未加载部分不能当成已经查完。
     */
    degraded?: boolean;
    /** 图表、数据库等仍在后台补齐，当前计数还不是终稿 */
    partial?: boolean;
    /** 图表 / HTML / 公式没有可用文本，这些块未计入命中 */
    unrendered?: number;
    /** OCR read unavailable or over budget; existing note search may still be complete. */
    ocrUnavailable?: number;
    /** 属性视图达到安全分页上限，结果未写入缓存且当前覆盖不完整 */
    truncated?: number;
    /** 未完成 API 解析的数据库载体，用于定位和手动重试；不把部分结果标成完整。 */
    incompleteBlockIds?: string[];
    /** 已被较新的搜索作废；调用方应保留现有 UI 状态。 */
    cancelled?: boolean;
}

const TABLE_CELL_CLOSEST = '[data-type="NodeTableCell"], .table__cell, td, th';
const DOC_TITLE_BLOCK_ID = "__doc-title__";
const DOC_TITLE_BLOCK_TYPE = "doc-title";
const PREVIEW_BLOCK_TYPE = "preview";

function toSearchableUnit(block: SearchableBlock): SearchableUnit {
    // A renderer projection may split one source text run across presentational
    // spans. Its offsets are validated against the source block before commit,
    // so those visual boundaries must not make an otherwise source-backed hit
    // look non-replaceable.
    const segmentLengths = isImageOCRUnit(block) || isCodeLanguageUnit(block) ? undefined : block.element.closest('[data-type="NodeCustomBlock"]') ?
        undefined : block.matchSource === "projection" ?
        (block.text.length > 0 ? [block.text.length] : undefined) :
        searchableTextLengths(block);
    return {
        blockId: block.blockId,
        blockType: block.blockType,
        blockIndex: block.blockIndex,
        text: block.text,
        unitId: block.unitId,
        matchSource: block.matchSource,
        // Projection offsets are still useful for validating a source-backed
        // replacement. The write layer resolves the same blockId back to the
        // source DOM before committing.
        segmentLengths,
    };
}

function buildBlockMap(blocks: SearchableBlock[]): Map<string, SearchableBlock> {
    const map = new Map<string, SearchableBlock>();
    for (const block of blocks) {
        map.set(unitKey(block.blockId, block.unitId), block);
    }
    return map;
}

/**
 * 命中是否落在「虽外层 contenteditable=false、但仍可通过块 HTML 写回」的区域。
 *
 * 思源源码依据：
 * - NodeCallout 根节点显式 contenteditable=false，标题经 Alt+Enter 对话框改
 *   `.callout-title` 后对整块做 transaction（callout.ts / turnInto）。
 * - NodeTable 可编辑区在首个子节点 contenteditable 容器内；外层/移动端 wysiwyg
 *   也可能是 false，但格内文本仍应可随整表块更新。
 * - 图片 `.img` 为 contenteditable=false；标题在 `.protyle-action__title`，官方菜单
 *   改 title 后对所属块 transaction（menus/protyle.ts imgMenu），对应内核 imgTitle。
 */
function isStructurallyWritableDespiteFalseAncestor(
    element: Element,
    blockType: string,
): boolean {
    if (blockType === CALLOUT_TYPE && element.closest(".callout-title")) {
        return true;
    }
    if (blockType === TABLE_TYPE && element.closest(TABLE_CELL_CLOSEST)) {
        return true;
    }
    // 图片标题：不依赖 blockType（常在 NodeParagraph 内的 span.img）
    if (element.closest(".img .protyle-action__title")) {
        return true;
    }
    return false;
}

/**
 * 若存在 contenteditable=false 祖先，但文本仍位于其内部的 contenteditable=true
 * 编辑区中，则允许替换（常见：移动端 wysiwyg=false + 段落内 true；表格滚动容器）。
 */
function isInsideNestedEditable(element: Element): boolean {
    const falseAncestor = element.closest('[contenteditable="false"]');
    if (!falseAncestor) {
        return true;
    }
    const trueEditable = element.closest('[contenteditable="true"]');
    return Boolean(trueEditable && falseAncestor.contains(trueEditable));
}

/**
 * 元素级 replaceable（在模式级判断之后调用）：
 * 数据库 → 预览合成块 → 文档标题（rename 路径）→ 数学公式 → contenteditable 边界。
 */
function isDomReplaceable(
    range: Range,
    blockType: string,
    blockId?: string,
    projectionSourceBacked = false,
): boolean {
    if (blockType === ATTRIBUTE_VIEW_TYPE) {
        return false;
    }
    if (blockType === "NodeHTMLBlock" || blockType === "NodeCustomBlock") {
        return false;
    }
    if (
        blockType === PREVIEW_BLOCK_TYPE ||
        (blockId != null && isPreviewSyntheticBlockId(blockId))
    ) {
        return false;
    }
    // 文档标题：不走块 transaction，由 renameDoc 写回
    if (
        blockType === DOC_TITLE_BLOCK_TYPE ||
        blockId === DOC_TITLE_BLOCK_ID
    ) {
        return true;
    }

    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ?
        node as Element :
        node.parentElement;
    if (!element) {
        return false;
    }
    // Custom renderers must write through setContent, never through their rendered DOM.
    if (element.closest('[data-type="NodeCustomBlock"]')) {
        return false;
    }
    // Tab labels and mindmap canvas nodes are renderer copies. Their source
    // block is the transaction target; never serialize the copy itself.
    if (projectionSourceBacked) {
        return true;
    }
    if (element.closest(NON_REPLACEABLE_DOM_CLOSEST)) {
        return false;
    }
    // 兜底：Range 落在 Mermaid / HTML 块壳上时（Shadow 内 closest 可能穿不出）
    if (element.closest('[data-type="NodeCodeBlock"][data-subtype="mermaid"]')) {
        return false;
    }
    if (element.closest('[data-type="NodeHTMLBlock"], protyle-html')) {
        return false;
    }
    if (isStructurallyWritableDespiteFalseAncestor(element, blockType)) {
        return true;
    }
    if (!isInsideNestedEditable(element)) {
        return false;
    }
    return true;
}

/**
 * 解析选区范围：优先用传入 scope；否则现场采集。
 * selectionOnly 且最终为空时返回 empty（调用方应得到 0 命中）。
 */
function resolveSelectionScope(
    edit: Element,
    blocks: SearchableBlock[],
    options: SearchPipelineOptions,
): SelectionScope {
    if (!options.selectionOnly) {
        return new Map();
    }
    if (options.selectionScope && options.selectionScope.size > 0) {
        return cloneSelectionScope(options.selectionScope);
    }
    const live = getSelectionScope(edit, blocks);
    if (live.size > 0) {
        return live;
    }
    return options.selectionScope ?
        cloneSelectionScope(options.selectionScope) :
        new Map();
}

/**
 * 采集 DOM 单元 → 内核/本地匹配 → 选区过滤 → 可见 Range 去重。
 * 无有效查询 + 限制激活时改为枚举行内宿主（不可替换）。纯空白按字面量搜索。
 */
export async function calculateSearchMatches(
    plugin: Plugin,
    edit: Element,
    value: string,
    options: SearchPipelineOptions = {},
): Promise<SearchPipelineResult> {
    const keyword = effectiveSearchQuery(value);

    if (keyword && options.selectionOnly !== true) {
        const full = await searchCurrentDocument(plugin, edit, value, options);
        if (full) {
            return full;
        }
        const loaded = await calculateLoadedDomMatches(plugin, edit, value, options);
        return {...filterLoadedResults(loaded, options), degraded: true};
    }

    return filterLoadedResults(await calculateLoadedDomMatches(plugin, edit, value, options), options);
}

function filterLoadedResults(result: SearchPipelineResult, options: SearchPipelineOptions): SearchPipelineResult {
    return options.resultBlockTypes?.length ? {
        ...result,
        matches: result.matches.filter((match) => passesResultTypeFilter(match.blockTypes, options.resultBlockTypes)),
    } : result;
}

/**
 * 已加载 DOM 路径：选区内搜索，以及无法调用文档 API 时的降级。
 * 空查询 + 限制激活时枚举行内宿主（只覆盖当前 DOM）。
 */
async function calculateLoadedDomMatches(
    _plugin: Plugin,
    edit: Element,
    value: string,
    options: SearchPipelineOptions,
): Promise<SearchPipelineResult> {
    const keyword = effectiveSearchQuery(value);
    const restrictInlineTypes = options.restrictInlineTypes;
    const includeDocTitle = options.includeDocTitle !== false && !editorFocusId(edit);

    if (!keyword) {
        if (!shouldEnumerateRestrictInline(value, restrictInlineTypes)) {
            return {matches: [], error: ""};
        }
        return {
            matches: enumerateRestrictInlineMatches(edit, {
                onLiveUnitsCollected: options.onLiveUnitsCollected,
                selectionOnly: options.selectionOnly,
                selectionScope: options.selectionScope,
                includeDocTitle,
                includeImageTitle: options.includeImageTitle,
                includeAttributeView: options.includeAttributeView,
                includeTable: options.includeTable,
                includeBlockquote: options.includeBlockquote,
                includeCallout: options.includeCallout,
                includeSuperBlock: options.includeSuperBlock,
                includeTabs: options.includeTabs,
                includeMindmap: options.includeMindmap,
                includeListUnordered: options.includeListUnordered,
                includeListOrdered: options.includeListOrdered,
                includeListTask: options.includeListTask,
                includeParagraph: options.includeParagraph,
                includeHeadingH1: options.includeHeadingH1,
                includeHeadingH2: options.includeHeadingH2,
                includeHeadingH3: options.includeHeadingH3,
                includeHeadingH4: options.includeHeadingH4,
                includeHeadingH5: options.includeHeadingH5,
                includeHeadingH6: options.includeHeadingH6,
                includeMathBlock: options.includeMathBlock,
                includeEmbedBlock: options.includeEmbedBlock,
                includeCodeBlock: options.includeCodeBlock,
                includeCodeLanguage: options.includeCodeLanguage,
                includeMermaid: options.includeMermaid,
                includeFlowchart: options.includeFlowchart,
                includeHtmlBlock: options.includeHtmlBlock,
                includeCustomBlock: options.includeCustomBlock,
                includeFoldedBlocks: options.includeFoldedBlocks,
                includeInlineMemo: options.includeInlineMemo,
                restrictInlineTypes,
            }),
            error: "",
        };
    }

    let blocks = collectSearchableBlocks(edit, {
        includeDocTitle,
        includeImageTitle: options.includeImageTitle !== false,
        includeAttributeView: options.includeAttributeView !== false,
        includeTable: options.includeTable !== false,
        includeBlockquote: options.includeBlockquote !== false,
        includeCallout: options.includeCallout !== false,
        includeSuperBlock: options.includeSuperBlock !== false,
        includeTabs: options.includeTabs !== false,
        includeMindmap: options.includeMindmap !== false,
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
        includeCodeLanguage: codeLanguageSearchEnabled(options),
        includeMermaid: options.includeMermaid !== false,
        includeFlowchart: options.includeFlowchart !== false,
        includeHtmlBlock: options.includeHtmlBlock !== false,
        includeCustomBlock: options.includeCustomBlock !== false,
        includeFoldedBlocks: options.includeFoldedBlocks === true,
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    });
    const selectionOnly = options.selectionOnly === true;
    const selectionScope = resolveSelectionScope(edit, blocks, options);
    // Whole-block/cell selection can include an image. Text-only selection cannot;
    // avoid reading OCR for pictures outside the selected scope.
    const selectedBlocks = selectionOnly ? blocks.filter(block =>
        !isImageOCRUnit(block) || selectionScope.has(unitKey(block.blockId, block.unitId))) : blocks;
    const ocr = await resolveImageOCRUnits(selectedBlocks, options.signal);
    if (options.signal?.aborted) return {matches: [], error: "", cancelled: true};
    blocks = ocr.units;
    options.onLiveUnitsCollected?.(blocks);
    if (!blocks.length) {
        return {matches: [], error: ""};
    }

    // A selected block/cell includes the whole image result; frozen scope lengths were
    // captured from URL placeholders before OCR was read, so expand only full selections.
    if (selectionOnly) {
        for (const block of blocks) {
            if (!isImageOCRUnit(block)) continue;
            const key = unitKey(block.blockId, block.unitId);
            const selected = selectionScope.get(key);
            if (selected?.length && selected[0].start === 0 &&
                selected[selected.length - 1].end === imageOCRPath(block.unitId)?.length) {
                selectionScope.set(key, [{start: 0, end: block.text.length}]);
            }
        }
    }
    if (selectionOnly && selectionScope.size === 0) {
        return {matches: [], error: ""};
    }

    const blockMap = buildBlockMap(blocks);
    const units = blocks.map(toSearchableUnit);

    const matchOptions = {
        dedupeOverlaps: false,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex,
    };
    const matched = options.regexMatcher ?
        await options.regexMatcher.match(units, value, matchOptions, options.signal) :
        matchTextUnitsDetailed(units, value, matchOptions);

    if ("cancelled" in matched && matched.cancelled) {
        return {matches: [], error: "", cancelled: true};
    }

    if (matched.error) {
        return {matches: [], error: matched.error};
    }

    const scopedHits = selectionOnly ?
        matched.hits.filter((hit) =>
            isMatchWithinSelection(
                unitKey(hit.blockId, hit.unitId),
                hit.start,
                hit.end,
                true,
                selectionScope,
            )
        ) :
        matched.hits;

    const richTargets = new Map<SearchableBlock, RichCellSearchInfo>();
    for (const hit of scopedHits) {
        const block = blockMap.get(unitKey(hit.blockId, hit.unitId));
        if (!block || isImageOCRUnit(block) || isCodeLanguageUnit(block) ||
            block.blockType !== TABLE_TYPE || richTargets.has(block)) continue;
        const rich = deferRichCellCapability(block);
        if (rich) richTargets.set(block, rich);
    }
    const resolved = await resolveRichCellCapabilities(richTargets.values(), () => options.signal?.aborted !== true);
    if (!resolved) return {matches: [], error: "", cancelled: true};
    const richCapabilities = new Map<SearchableBlock, RichCellCapability>();
    for (const [block, info] of richTargets) richCapabilities.set(block, resolved.get(info)!);
    return {
        matches: attachRangesToHits(blockMap, scopedHits, edit, {
            richCapabilities,
            allowFoldedHidden: options.includeFoldedBlocks === true,
            restrictInlineTypes: options.restrictInlineTypes,
            includeSourceFallback: !selectionOnly,
            resultBlockTypes: options.resultBlockTypes,
        }),
        error: "",
        ocrUnavailable: ocr.failedIds.length,
        incompleteBlockIds: ocr.failedIds,
    };
}

function attachRangesToHits(
    blockMap: Map<string, SearchableBlock>,
    hits: MatchHit[],
    edit?: Element,
    visibility: {
        richCapabilities?: Map<SearchableBlock, RichCellCapability>;
        allowFoldedHidden?: boolean;
        restrictInlineTypes?: RestrictInlineType[];
        includeSourceFallback?: boolean;
        resultBlockTypes?: readonly ResultBlockType[];
    } = {},
): SearchMatch[] {
    const result: SearchMatch[] = [];
    const richSpans = new Map<SearchableBlock, RichCellCapability["writableSpans"]>();
    const tableLocks = new Map<SearchableBlock, ReturnType<typeof tableCellReplaceLock>>();
    /** 每个单元的 hits 已按偏移排序；记录最后接受的终点即可线性去重。 */
    const acceptedEndByUnit = new Map<string, number>();
    // Type ancestry is only needed for accepted hits. Keep this reader local to
    // the current collection so its WeakMap does not retain stale DOM paths.
    const readBlockTypes = createDomBlockTypeReader();
    // 1) 模式级：导出预览 / 只读 → 全部不可替
    const modeBlocked = edit ? isEditorReplaceModeBlocked(edit) : false;
    const restrictInlineTypes = visibility.restrictInlineTypes;
    // 限制关：跳过宿主判定（零额外路径）
    const restrictActive = isRestrictInlineActive(restrictInlineTypes);

    for (const hit of hits) {
        const key = unitKey(hit.blockId, hit.unitId);
        const block = blockMap.get(key);
        if (!block) {
            continue;
        }

        const acceptedEnd = acceptedEndByUnit.get(key) ?? -1;
        if (hit.start < acceptedEnd) {
            continue;
        }

        // Reject type-filtered units before constructing a Range. This keeps
        // temporary result filters cheap on large loaded documents while the
        // final result still carries the ancestry used by the result list.
        const blockTypes = visibility.resultBlockTypes?.length ? readBlockTypes(block) : undefined;
        if (!passesResultTypeFilter(blockTypes, visibility.resultBlockTypes)) {
            continue;
        }

        if (
            visibility.includeSourceFallback &&
            (!restrictActive || (isInlineMathSearchUnit(block) && restrictInlineTypes?.includes("inline-math"))) &&
            isRendererSourceFallbackUnitId(hit.unitId)
        ) {
            acceptedEndByUnit.set(key, hit.end);
            result.push({
                ...hit,
                blockTypes,
                embeddedPosition: embeddedPositionAt(block.embeddedOrder, hit.start),
                replaceable: false,
                highlightKind: isInlineMathSearchUnit(block) ? "inline-math" : "text",
                ...buildListSnippet(block.text, hit.start, hit.end, hit.matchedText),
            });
            continue;
        }
        const range = createRangeFromBlockOffsets(block, hit.start, hit.end, visibility);
        if (!range) {
            // An inactive tab source is valid document text, but its panel has
            // no paintable Range until navigation activates the tab. Keep the
            // hit so counts and replacement still work in the DOM fallback.
            if (isInactiveTabSourceElement(block.element)) {
                acceptedEndByUnit.set(key, hit.end);
                result.push({
                    ...hit,
                    blockTypes,
                    embeddedPosition: embeddedPositionAt(block.embeddedOrder, hit.start),
                    replaceable: !modeBlocked && !isDocTitleSearchUnit(block) &&
                        !isTabsTitleSearchUnit(block) && !isImageOCRUnit(block) && !isCodeLanguageUnit(block) &&
                        !isInlineMathSearchUnit(block) && !isRendererUnitId(hit.unitId) &&
                        !hit.unitId?.startsWith("embed:") && hit.replaceable,
                    replaceReason: isImageOCRUnit(block) ? "imageOCR" : isCodeLanguageUnit(block) ? "codeLanguage" : isTabsTitleSearchUnit(block) ? "tabsTitle" : undefined,
                    range: undefined,
                    highlightKind: isImageOCRUnit(block) ? "image-ocr" : isCodeLanguageUnit(block) ? "code-language" : "text",
                    ...buildListSnippet(block.text, hit.start, hit.end, hit.matchedText),
                });
            }
            continue;
        }

        const isMemo = isInlineMemoSearchUnit(block);
        const isMath = isInlineMathSearchUnit(block);
        const isDocTitle = isDocTitleSearchUnit(block);
        const isTabsTitle = isTabsTitleSearchUnit(block);
        // 限制查找：块级采集之后，仅保留落在所选行内类型内的命中（OR）；与选区过滤独立叠加
        // 文档标题不是行内类型：限制激活时自然被滤掉
        if (
            restrictActive &&
            !matchRangePassesRestrictInline(range, restrictInlineTypes, {
                attributeKind: isMemo ? "inline-memo" : (isMath ? "inline-math" : null),
            })
        ) {
            continue;
        }

        acceptedEndByUnit.set(key, hit.end);

        // 文档标题只参与查找。编辑中 Protyle 常把连续字拆成多个相邻 Text。
        // 富文本格和开着的单元格编辑器单独标原因，公式等仍走原来的不可替换。
        if (hit.blockType === TABLE_TYPE && !isImageOCRUnit(block) && !isCodeLanguageUnit(block) &&
            !isDocTitle && !isMath && !tableLocks.has(block)) {
            const rich = visibility.richCapabilities?.get(block);
            tableLocks.set(block, rich ? rich.replaceLock : tableCellReplaceLock(block.element));
            richSpans.set(block, rich?.writableSpans);
        }
        const replaceLock = tableLocks.get(block);
        const spans = richSpans.get(block);
        const projectionHost = block.element.closest(".tabs-header, .mindmap-view");
        const projectionSourceBacked = block.matchSource === "projection" &&
            Boolean(projectionHost) &&
            Boolean(
                edit?.querySelector<HTMLElement>(
                    `[data-node-id="${CSS.escape(block.blockId)}"][data-type]:not(.mindmap-view)`,
                ),
            );
        const richSpanBlocked = !replaceLock && spans !== undefined &&
            !spans.some(span => hit.start >= span.start && hit.end <= span.end);
        const replaceable = !replaceLock &&
            !richSpanBlocked &&
            !isRendererUnitId(hit.unitId) &&
            !hit.unitId?.startsWith("embed:") &&
            !isDocTitle &&
            !isTabsTitle && !isImageOCRUnit(block) && !isCodeLanguageUnit(block) &&
            !isMath &&
            !modeBlocked &&
            isDomReplaceable(range, hit.blockType, hit.blockId, projectionSourceBacked) &&
            // The projection may add presentational wrappers; the source write
            // path rechecks its own Text-node boundaries before committing.
            (isMemo || projectionSourceBacked || isRangePlainTextOnly(range));

        result.push({
            id: hit.id,
            blockId: hit.blockId,
            blockType: hit.blockType,
            blockTypes,
            blockIndex: hit.blockIndex,
            unitId: hit.unitId,
            embeddedPosition: embeddedPositionAt(block.embeddedOrder, hit.start),
            start: hit.start,
            end: hit.end,
            matchedText: hit.matchedText,
            replaceable,
            replaceReason: isImageOCRUnit(block) ? "imageOCR" : isCodeLanguageUnit(block) ? "codeLanguage" : isTabsTitle ? "tabsTitle" : richSpanBlocked ? "richCell" : undefined,
            replaceLock,
            range,
            highlightKind: isImageOCRUnit(block) ? "image-ocr" : isCodeLanguageUnit(block) ? "code-language" : isMemo ? "inline-memo" : (isMath ? "inline-math" : "text"),
            anchorOffset: isMemo ? block.anchorOffset : undefined,
            anchorEnd: isMemo ? block.anchorEnd : undefined,
            ...(isMath && block.mathOrdinal !== undefined ?
                {
                    mathOrdinal: block.mathOrdinal,
                    mathUnitText: inlineMathIdentityText(block.text),
                } :
                {}),
            ...buildListSnippet(block.text, hit.start, hit.end, hit.matchedText),
        });
    }

    // 按文档位置排序；同位置正文优先于公式/备注（导航顺序可读）
    for (const match of result) {
        const block = blockMap.get(unitKey(match.blockId, match.unitId));
        if (!match.blockTypes && block) {
            match.blockTypes = block.blockTypes ?? readBlockTypes(block);
        }
    }
    result.sort(compareSearchMatches);
    orderEmbeddedVisualMatches(result, blockMap.values());
    return result;
}

function highlightKindRank(kind: SearchMatch["highlightKind"]): number {
    if (kind === "inline-memo") {
        return 2;
    }
    if (kind === "inline-math") {
        return 1;
    }
    return 0;
}

function compareSearchMatches(a: SearchMatch, b: SearchMatch): number {
    if (a.blockIndex !== b.blockIndex) {
        return a.blockIndex - b.blockIndex;
    }
    const embedded = compareEmbeddedPositions(a, b);
    if (embedded !== undefined && embedded !== 0) return embedded;
    if (a.blockType !== TABLE_TYPE && isCodeLanguageUnit(a) !== isCodeLanguageUnit(b)) {
        return isCodeLanguageUnit(a) ? -1 : 1;
    }
    if (a.range && b.range && !textStartInsideMemoRange(a, b) && !textStartInsideMemoRange(b, a)) {
        try {
            const startCmp = a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
            if (startCmp !== 0) {
                return startCmp;
            }
        } catch {
            // 跨文档等异常时回退
        }
    }
    const overlap = bodyBeforeOverlappingMemo(a, b);
    if (overlap !== 0) {
        return overlap;
    }
    const leftPos = a.highlightKind === "inline-memo" ? (a.anchorOffset ?? a.start) : a.start;
    const rightPos = b.highlightKind === "inline-memo" ? (b.anchorOffset ?? b.start) : b.start;
    if (leftPos !== rightPos) {
        return leftPos - rightPos;
    }
    const kindCmp = highlightKindRank(a.highlightKind) - highlightKindRank(b.highlightKind);
    if (kindCmp !== 0) {
        return kindCmp;
    }
    if (a.start !== b.start) {
        return a.start - b.start;
    }
    return a.end - b.end;
}

/** 正文 Range 的起点落在备注宿主里。selectNodeContents 的起点在文字前面，不能因此先跳备注。 */
function textStartInsideMemoRange(memo: SearchMatch, text: SearchMatch): boolean {
    if (
        memo.highlightKind !== "inline-memo" || text.highlightKind === "inline-memo" ||
        text.highlightKind === "inline-math"
    ) {
        return false;
    }
    if (!memo.range || !text.range) {
        return false;
    }
    try {
        const startsAtOrAfter = text.range.compareBoundaryPoints(Range.START_TO_START, memo.range) >= 0;
        // END_TO_START：这段的起点相对备注宿主的终点
        const startsBeforeEnd = text.range.compareBoundaryPoints(Range.END_TO_START, memo.range) < 0;
        return startsAtOrAfter && startsBeforeEnd;
    } catch {
        return false;
    }
}

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
