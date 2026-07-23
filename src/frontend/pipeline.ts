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
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
} from "./blocks";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {createRangeFromBlockOffsets} from "./ranges";
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
    /** 是否匹配数据库；默认 true */
    includeAttributeView?: boolean;
    /** 是否匹配代码块（非 Mermaid）；默认 true */
    includeCodeBlock?: boolean;
    /** 是否匹配 Mermaid；默认 true */
    includeMermaid?: boolean;
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
const PREVIEW_BLOCK_ID = "__preview__";
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
 * 数据库 → 文档标题/预览合成块 → 数学公式 → contenteditable 边界。
 */
function isDomReplaceable(
    range: Range,
    blockType: string,
    blockId?: string,
): boolean {
    if (blockType === ATTRIBUTE_VIEW_TYPE) {
        return false;
    }
    if (
        blockType === PREVIEW_BLOCK_TYPE
        || blockId === PREVIEW_BLOCK_ID
        || blockType === DOC_TITLE_BLOCK_TYPE
        || blockId === DOC_TITLE_BLOCK_ID
    ) {
        return false;
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
    // 兜底：Range 落在 Mermaid 渲染壳上时（无 Text 命中路径）
    if (element.closest(`[data-type="NodeCodeBlock"][data-subtype="mermaid"]`)) {
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
                includeAttributeView: options.includeAttributeView,
                includeCodeBlock: options.includeCodeBlock,
                includeMermaid: options.includeMermaid,
                includeFoldedBlocks: options.includeFoldedBlocks,
                includeInlineMemo: options.includeInlineMemo,
                restrictInlineTypes,
            }),
            error: "",
        };
    }

    const blocks = collectSearchableBlocks(edit, {
        includeAttributeView: options.includeAttributeView !== false,
        includeCodeBlock: options.includeCodeBlock !== false,
        includeMermaid: options.includeMermaid !== false,
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
        // 限制查找：块级采集之后，仅保留落在所选行内类型内的命中（OR）；与选区过滤独立叠加
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

        // 2) 元素级：数据库 / 标题 / 公式等；行内备注与行内公式只搜不替
        const replaceable = !isMemo
            && !isMath
            && !modeBlocked
            && hit.replaceable
            && isDomReplaceable(range, hit.blockType, hit.blockId);

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
