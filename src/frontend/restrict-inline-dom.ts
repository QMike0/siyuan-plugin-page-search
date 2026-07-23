/**
 * 限制查找：Range ↔ 行内 data-type 宿主判定。
 */
import {
    isRestrictInlineActive,
    matchPassesRestrictInline,
    parseDataTypeTokens,
    rangeRestrictTokens,
    type RestrictAttributeKind,
    type RestrictInlineType,
} from "../shared";

/**
 * 自节点向上找第一个带有任一限制 token 的元素；到达块根 `[data-node-id]` 后停止。
 */
function findRestrictInlineHost(
    node: Node | null,
    allowedTokens: ReadonlySet<string>,
): Element | null {
    if (!node || allowedTokens.size === 0) {
        return null;
    }
    let current: Element | null = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    while (current) {
        const tokens = parseDataTypeTokens(current.getAttribute("data-type"));
        if (tokens.some((token) => allowedTokens.has(token))) {
            return current;
        }
        if (current.hasAttribute("data-node-id")) {
            break;
        }
        current = current.parentElement;
    }
    return null;
}

/** Range 是否完全落在 host 内容内 */
function isRangeFullyWithinElement(range: Range, host: Element): boolean {
    try {
        const hostRange = range.ownerDocument?.createRange() ?? document.createRange();
        hostRange.selectNodeContents(host);
        return (
            hostRange.compareBoundaryPoints(Range.START_TO_START, range) <= 0
            && hostRange.compareBoundaryPoints(Range.END_TO_END, range) >= 0
        );
    } catch {
        return false;
    }
}

/**
 * 限制激活时：正文命中须完全落在所选行内类型宿主内（OR）；
 * 备注 / 公式属性 unit 由 matchPassesRestrictInline 按集合判定。
 */
export function matchRangePassesRestrictInline(
    range: Range,
    restrictTypes: readonly RestrictInlineType[] | null | undefined,
    options: {
        attributeKind?: RestrictAttributeKind | null;
    } = {},
): boolean {
    if (!isRestrictInlineActive(restrictTypes)) {
        return true;
    }
    if (options.attributeKind) {
        return matchPassesRestrictInline({
            restrictTypes,
            attributeKind: options.attributeKind,
            hostDataTypes: [],
        });
    }

    const allowed = rangeRestrictTokens(restrictTypes);
    if (allowed.length === 0) {
        return false;
    }
    const allowedSet = new Set<string>(allowed);
    const host = findRestrictInlineHost(range.commonAncestorContainer, allowedSet);
    if (!host || !isRangeFullyWithinElement(range, host)) {
        return false;
    }
    return matchPassesRestrictInline({
        restrictTypes,
        attributeKind: null,
        hostDataTypes: parseDataTypeTokens(host.getAttribute("data-type")),
    });
}
