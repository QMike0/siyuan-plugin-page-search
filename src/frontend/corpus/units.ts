import {
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
    RESTRICT_INLINE_TYPE_ALLOWLIST,
    parseDataTypeTokens,
    type RestrictInlineType,
} from "../../shared";
import {isInlineMathSearchUnit, isInlineMemoSearchUnit} from "../blocks";
import type {SearchableBlock, SearchMatch} from "../dom-types";

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
    restrictSpans: Array<{type: string; start: number; end: number}>;
    /** 行内备注宿主在所属块文本中的起始偏移。 */
    anchorOffset?: number;
    /** 数据库命中的视图名、列名和显示值。 */
    snippet?: string;
}

function nonReplaceable(block: SearchableBlock): boolean {
    return block.blockType === "NodeMathBlock"
        || block.blockType === "NodeHTMLBlock"
        || block.blockType === "NodeAttributeView"
        || block.unitId === "mermaid-source"
        || block.unitId === "html-block-rendered"
        || block.unitId === "diagram-rendered"
        || Boolean(block.unitId?.startsWith("inline-math:"))
        || Boolean(block.unitId?.startsWith("embed:"));
}

function collectRestrictSpans(block: SearchableBlock): CachedUnit["restrictSpans"] {
    const nodes = block.textNodes;
    let cursor = 0;
    const ranges = nodes.map((node) => {
        const start = cursor;
        const length = node.nodeValue?.length ?? 0;
        cursor += length;
        return {node, start, end: cursor};
    });
    const spans: CachedUnit["restrictSpans"] = [];
    const seen = new Set<string>();
    for (const item of ranges) {
        let element = item.node.parentElement;
        while (element && element !== block.element && !element.hasAttribute("data-node-id")) {
            for (const token of parseDataTypeTokens(element.getAttribute("data-type"))) {
                if (!HOST_TYPES.has(token)) {
                    continue;
                }
                const inside = ranges.filter((range) => element!.contains(range.node));
                if (!inside.length) {
                    continue;
                }
                const start = inside[0].start;
                const end = inside[inside.length - 1].end;
                const key = `${token}:${start}:${end}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                spans.push({type: token, start, end});
            }
            element = element.parentElement;
        }
    }
    return spans;
}

export function freezeBlock(block: SearchableBlock, blockIndex = block.blockIndex): CachedUnit {
    const lengths = nonReplaceable(block)
        ? undefined
        : block.textNodes.map((node) => node.nodeValue?.length ?? 0);
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
        restrictSpans: collectRestrictSpans(block),
        anchorOffset: block.anchorOffset,
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
    return types.some((type) => spans.some((span) => {
        return span.type === type && span.start <= start && end <= span.end;
    }));
}
