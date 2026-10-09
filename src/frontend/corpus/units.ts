import {
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
    RESTRICT_INLINE_TYPE_ALLOWLIST,
    isRendererUnitId,
    parseDataTypeTokens,
    type RestrictInlineType,
} from "../../shared";
import {
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
    tableCellReplaceLock,
} from "../blocks";
import type {
    SearchableBlock,
    SearchMatch,
    TableReplaceLock,
    TableSlot,
} from "../dom-types";

const HOST_TYPES = new Set<string>(
    RESTRICT_INLINE_TYPE_ALLOWLIST.filter((token) => token !== INLINE_MATH_TYPE && token !== INLINE_MEMO_TYPE),
);

/** 会话缓存用的纯文本单元，不保留 DOM 节点。 */
export interface CachedUnit {
    blockId: string;
    blockType: string;
    blockIndex: number;
    text: string;
    unitId?: string;
    segmentLengths?: number[];
    highlightKind: NonNullable<SearchMatch["highlightKind"]>;
    /** 行内类型宿主在单元文本中的覆盖区间。限制查找不再依赖已卸载的节点。 */
    restrictSpans: Array<{type: string; start: number; end: number;}>;
    /** 行内备注宿主在所属块文本中的起始偏移。 */
    anchorOffset?: number;
    /** 行内备注宿主在所属块文本中的结束偏移。 */
    anchorEnd?: number;
    /** 数据库命中的视图名、列名和显示值。 */
    snippet?: string;
    tableSlot?: TableSlot;
    mathOrdinal?: number;
    /** 富文本格或正在编辑的格子。命中仍可搜索，但不能替换。 */
    replaceLock?: TableReplaceLock;
}

function nonReplaceable(block: SearchableBlock): boolean {
    return block.blockType === "NodeMathBlock" ||
        block.blockType === "NodeHTMLBlock" ||
        block.blockType === "NodeAttributeView" ||
        isRendererUnitId(block.unitId) ||
        block.unitId === "mermaid-source" ||
        block.unitId === "html-block-rendered" ||
        block.unitId === "diagram-rendered" ||
        Boolean(block.unitId?.startsWith("inline-math:")) ||
        Boolean(block.unitId?.startsWith("embed:"));
}

function hostTokensOf(element: Element): string[] {
    const tokens = parseDataTypeTokens(element.getAttribute("data-type"));
    const hosts: string[] = [];
    for (const token of tokens) {
        if (HOST_TYPES.has(token)) {
            hosts.push(token);
        }
    }
    return hosts;
}

/**
 * 每个文本节点只沿祖先走一趟。
 * 思源行内格式是 span[data-type]，不含 data-node-id；走到块根或带 data-node-id 的节点为止。
 * 区间仍覆盖该元素下、本单元文本里的全部节点，和原先 contains 扫出来的首尾偏移一致。
 */
function collectRestrictSpans(block: SearchableBlock): CachedUnit["restrictSpans"] {
    const nodes = block.textNodes;
    if (nodes.length === 0) {
        return [];
    }
    const bounds = new Map<Element, {start: number; end: number; reached: boolean;}>();
    const tokensOf = new Map<Element, string[]>();
    const reachedOrder: Element[] = [];
    let cursor = 0;
    for (const node of nodes) {
        const start = cursor;
        const length = node.nodeValue?.length ?? 0;
        const end = start + length;
        cursor = end;
        let element = node.parentElement;
        let blocked = false;
        while (element && element !== block.element) {
            if (!blocked && element.hasAttribute("data-node-id")) {
                blocked = true;
            }
            let tokens = tokensOf.get(element);
            if (!tokens) {
                tokens = hostTokensOf(element);
                tokensOf.set(element, tokens);
            }
            if (tokens.length > 0) {
                const bound = bounds.get(element);
                if (!bound) {
                    bounds.set(element, {start, end, reached: !blocked});
                    if (!blocked) {
                        reachedOrder.push(element);
                    }
                } else {
                    if (start < bound.start) {
                        bound.start = start;
                    }
                    if (end > bound.end) {
                        bound.end = end;
                    }
                    if (!blocked && !bound.reached) {
                        bound.reached = true;
                        reachedOrder.push(element);
                    }
                }
            }
            if (element.hasAttribute("data-node-id")) {
                blocked = true;
            }
            element = element.parentElement;
        }
    }
    const spans: CachedUnit["restrictSpans"] = [];
    const seen = new Set<string>();
    for (const element of reachedOrder) {
        const bound = bounds.get(element);
        const tokens = tokensOf.get(element);
        if (!bound?.reached || !tokens?.length) {
            continue;
        }
        for (const token of tokens) {
            const key = `${token}:${bound.start}:${bound.end}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            spans.push({type: token, start: bound.start, end: bound.end});
        }
    }
    return spans;
}

export function freezeBlock(
    block: SearchableBlock,
    blockIndex = block.blockIndex,
    includeRestrict = true,
): CachedUnit {
    const blocked = nonReplaceable(block);
    // 备注正文在属性里，没有 Text 节点。整段属性是一个可替换片段。
    const lengths = blocked ?
        undefined :
        (isInlineMemoSearchUnit(block) ?
            (block.text.length > 0 ? [block.text.length] : undefined) :
            block.textNodes.map((node) => node.nodeValue?.length ?? 0));
    const replaceLock = block.blockType === "NodeTable" ? tableCellReplaceLock(block.element) : undefined;
    let highlightKind: CachedUnit["highlightKind"] = "text";
    if (isInlineMemoSearchUnit(block)) {
        highlightKind = "inline-memo";
    } else if (isInlineMathSearchUnit(block)) {
        highlightKind = "inline-math";
    }
    return {
        blockId: block.blockId,
        blockType: block.blockType,
        blockIndex,
        text: block.text,
        unitId: block.unitId,
        segmentLengths: lengths?.some((length) => length > 0) ? lengths : undefined,
        highlightKind,
        restrictSpans: includeRestrict ? collectRestrictSpans(block) : [],
        anchorOffset: block.anchorOffset,
        anchorEnd: block.anchorEnd,
        tableSlot: block.tableSlot,
        mathOrdinal: block.mathOrdinal,
        replaceLock,
    };
}

export function restrictSpanCovers(
    spans: CachedUnit["restrictSpans"],
    types: readonly RestrictInlineType[] | null | undefined,
    start: number,
    end: number,
): boolean {
    if (!types?.length) {
        return true;
    }
    return types.some((type) =>
        spans.some((span) => {
            return span.type === type && span.start <= start && end <= span.end;
        })
    );
}
