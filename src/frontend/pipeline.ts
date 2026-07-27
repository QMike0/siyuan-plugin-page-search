import type {Plugin} from "siyuan";
import {
    ATTRIBUTE_VIEW_TYPE,
    NON_REPLACEABLE_DOM_CLOSEST,
    isRestrictInlineActive,
    rangesOverlap,
    shouldEnumerateRestrictInline,
    type RestrictInlineType,
} from "../shared";
import type {MatchHit, MatchOptions, SearchableUnit} from "../shared";
import {rpcMatch} from "./kernel-client";
import {
    CALLOUT_TYPE,
    TABLE_TYPE,
    collectSearchableBlocks,
    isDocTitleSearchUnit,
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
    isPreviewSyntheticBlockId,
} from "./blocks";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {createRangeFromBlockOffsets, isRangePlainTextOnly} from "./ranges";
import {matchRangePassesRestrictInline} from "./restrict-inline-dom";
import {enumerateRestrictInlineMatches} from "./restrict-enumerate";
import type {SearchableBlock, SearchMatch} from "./dom-types";
import {
    cloneSelectionScope,
    getSelectionScope,
    isMatchWithinSelection,
    unitKey,
    type SelectionScope,
} from "./selection";

export interface SearchPipelineOptions extends MatchOptions {
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
    /** 是否匹配无序列表及其内部；默认 true */
    includeListUnordered?: boolean;
    /** 是否匹配有序列表及其内部；默认 true */
    includeListOrdered?: boolean;
    /** 是否匹配任务列表及其内部；默认 true */
    includeListTask?: boolean;
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
    /** 是否匹配代码块（非 Mermaid）；默认 true */
    includeCodeBlock?: boolean;
    /** 是否匹配 Mermaid；默认 true */
    includeMermaid?: boolean;
    /** 是否匹配 HTML 块渲染可见文字；默认 true；不可替换 */
    includeHtmlBlock?: boolean;
    /**
     * 是否匹配非标题 CSS 折叠块内的隐藏内容；默认 false（与历史行为一致）。
     * 匹配时不展开；跳转时再展开。
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
}

const TABLE_CELL_CLOSEST = '[data-type="NodeTableCell"], .table__cell, td, th';
const DOC_TITLE_BLOCK_ID = "__doc-title__";
const DOC_TITLE_BLOCK_TYPE = "doc-title";
const PREVIEW_BLOCK_TYPE = "preview";

function toSearchableUnit(block: SearchableBlock): SearchableUnit {
    return {
        blockId: block.blockId,
        blockType: block.blockType,
        blockIndex: block.blockIndex,
        text: block.text,
        unitId: block.unitId,
        segmentLengths: block.textNodes.map((node) => node.nodeValue?.length ?? 0),
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
): boolean {
    if (blockType === ATTRIBUTE_VIEW_TYPE) {
        return false;
    }
    if (blockType === "NodeHTMLBlock") {
        return false;
    }
    if (
        blockType === PREVIEW_BLOCK_TYPE
        || (blockId != null && isPreviewSyntheticBlockId(blockId))
    ) {
        return false;
    }
    // 文档标题：不走块 transaction，由 renameDoc 写回
    if (
        blockType === DOC_TITLE_BLOCK_TYPE
        || blockId === DOC_TITLE_BLOCK_ID
    ) {
        return true;
    }

    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    if (!element) {
        return false;
    }
    if (element.closest(NON_REPLACEABLE_DOM_CLOSEST)) {
        return false;
    }
    // 兜底：Range 落在 Mermaid / HTML 块壳上时（Shadow 内 closest 可能穿不出）
    if (element.closest(`[data-type="NodeCodeBlock"][data-subtype="mermaid"]`)) {
        return false;
    }
    if (element.closest(`[data-type="NodeHTMLBlock"], protyle-html`)) {
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
    return options.selectionScope
        ? cloneSelectionScope(options.selectionScope)
        : new Map();
}

/**
 * 采集 DOM 单元 → 内核/本地匹配 → 选区过滤 → 可见 Range 去重。
 * 空查询 + 限制激活时改为枚举行内宿主（不可替换）。
 */
export async function calculateSearchMatches(
    plugin: Plugin,
    edit: Element,
    value: string,
    options: SearchPipelineOptions = {},
): Promise<SearchPipelineResult> {
    const keyword = value.trim();
    const restrictInlineTypes = options.restrictInlineTypes;

    if (!keyword) {
        if (!shouldEnumerateRestrictInline(value, restrictInlineTypes)) {
            return {matches: [], error: ""};
        }
        return {
            matches: enumerateRestrictInlineMatches(edit, {
                selectionOnly: options.selectionOnly,
                selectionScope: options.selectionScope,
                includeDocTitle: options.includeDocTitle,
                includeImageTitle: options.includeImageTitle,
                includeAttributeView: options.includeAttributeView,
                includeTable: options.includeTable,
                includeBlockquote: options.includeBlockquote,
                includeCallout: options.includeCallout,
                includeSuperBlock: options.includeSuperBlock,
                includeListUnordered: options.includeListUnordered,
                includeListOrdered: options.includeListOrdered,
                includeListTask: options.includeListTask,
                includeHeadingH1: options.includeHeadingH1,
                includeHeadingH2: options.includeHeadingH2,
                includeHeadingH3: options.includeHeadingH3,
                includeHeadingH4: options.includeHeadingH4,
                includeHeadingH5: options.includeHeadingH5,
                includeHeadingH6: options.includeHeadingH6,
                includeMathBlock: options.includeMathBlock,
                includeEmbedBlock: options.includeEmbedBlock,
                includeCodeBlock: options.includeCodeBlock,
                includeMermaid: options.includeMermaid,
                includeHtmlBlock: options.includeHtmlBlock,
                includeFoldedBlocks: options.includeFoldedBlocks,
                includeInlineMemo: options.includeInlineMemo,
                restrictInlineTypes,
            }),
            error: "",
        };
    }

    const blocks = collectSearchableBlocks(edit, {
        includeDocTitle: options.includeDocTitle !== false,
        includeImageTitle: options.includeImageTitle !== false,
        includeAttributeView: options.includeAttributeView !== false,
        includeTable: options.includeTable !== false,
        includeBlockquote: options.includeBlockquote !== false,
        includeCallout: options.includeCallout !== false,
        includeSuperBlock: options.includeSuperBlock !== false,
        includeListUnordered: options.includeListUnordered !== false,
        includeListOrdered: options.includeListOrdered !== false,
        includeListTask: options.includeListTask !== false,
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
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    });
    if (!blocks.length) {
        return {matches: [], error: ""};
    }

    const selectionOnly = options.selectionOnly === true;
    const selectionScope = resolveSelectionScope(edit, blocks, options);
    if (selectionOnly && selectionScope.size === 0) {
        return {matches: [], error: ""};
    }

    const blockMap = buildBlockMap(blocks);
    const units = blocks.map(toSearchableUnit);

    // 前端负责可见性过滤，内核侧不要贪心去重
    const response = await rpcMatch(plugin, {
        query: value,
        units,
        dedupeOverlaps: false,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex,
    });

    if (response.error) {
        return {matches: [], error: response.error};
    }

    const scopedHits = selectionOnly
        ? response.hits.filter((hit) =>
            isMatchWithinSelection(
                unitKey(hit.blockId, hit.unitId),
                hit.start,
                hit.end,
                true,
                selectionScope,
            )
        )
        : response.hits;

    return {
        matches: attachRangesToHits(blockMap, scopedHits, edit, {
            allowFoldedHidden: options.includeFoldedBlocks === true,
            restrictInlineTypes: options.restrictInlineTypes,
        }),
        error: "",
    };
}

function attachRangesToHits(
    blockMap: Map<string, SearchableBlock>,
    hits: MatchHit[],
    edit?: Element,
    visibility: {
        allowFoldedHidden?: boolean;
        restrictInlineTypes?: RestrictInlineType[];
    } = {},
): SearchMatch[] {
    const result: SearchMatch[] = [];
    const acceptedByUnit = new Map<string, Array<{start: number; end: number}>>();
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

        const accepted = acceptedByUnit.get(key) ?? [];
        if (accepted.some((range) => rangesOverlap(hit.start, hit.end, range.start, range.end))) {
            continue;
        }

        const range = createRangeFromBlockOffsets(block, hit.start, hit.end, visibility);
        if (!range) {
            continue;
        }

        const isMemo = isInlineMemoSearchUnit(block);
        const isMath = isInlineMathSearchUnit(block);
        const isDocTitle = isDocTitleSearchUnit(block);
        // 限制查找：块级采集之后，仅保留落在所选行内类型内的命中（OR）；与选区过滤独立叠加
        // 文档标题不是行内类型：限制激活时自然被滤掉
        if (
            restrictActive
            && !matchRangePassesRestrictInline(range, restrictInlineTypes, {
                attributeKind: isMemo ? "inline-memo" : (isMath ? "inline-math" : null),
            })
        ) {
            continue;
        }

        accepted.push({start: hit.start, end: hit.end});
        acceptedByUnit.set(key, accepted);

        // 2) 元素级：数据库 / 公式等不可替；行内备注改属性，不要求 Range 纯 Text
        // 文档标题：可替（renameDoc）；编辑中 Protyle 常把连续字拆成多个相邻 Text
        const replaceable = !isMath
            && !modeBlocked
            && isDomReplaceable(range, hit.blockType, hit.blockId)
            && (isMemo || isDocTitle || isRangePlainTextOnly(range));

        result.push({
            id: hit.id,
            blockId: hit.blockId,
            blockType: hit.blockType,
            blockIndex: hit.blockIndex,
            unitId: hit.unitId,
            start: hit.start,
            end: hit.end,
            matchedText: hit.matchedText,
            replaceable,
            range,
            highlightKind: isMemo ? "inline-memo" : (isMath ? "inline-math" : "text"),
        });
    }

    // 按文档位置排序；同位置正文优先于公式/备注（导航顺序可读）
    result.sort(compareSearchMatches);
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
    if (a.range && b.range) {
        try {
            const startCmp = a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
            if (startCmp !== 0) {
                return startCmp;
            }
        } catch {
            // 跨文档等异常时回退
        }
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
