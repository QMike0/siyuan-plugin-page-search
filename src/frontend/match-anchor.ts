import type {SearchMatch} from "./dom-types";

/**
 * 新一轮搜索（change=true）时解析初始当前项（1-based）。
 *
 * 约束：
 * - 只读 / 预览 / 无锚点 / Range 失效 → 回退 1
 * - 非空选区优先命中覆盖该选区的匹配（对齐 VS Code 预填）
 * - 否则：光标及之前第一个（文档序上最近的「≤ 光标」）；若无则光标后最近一个
 * - 尽力而为，异常一律回退 1
 */
export function resolveInitialMatchIndex(
    matches: SearchMatch[],
    options: {
        anchorRange: Range | null;
        modeBlocked: boolean;
    },
): number {
    if (matches.length === 0) {
        return 0;
    }
    if (options.modeBlocked) {
        return 1;
    }

    const anchor = options.anchorRange;
    if (!anchor || !isUsableRange(anchor)) {
        return 1;
    }

    try {
        if (!anchor.collapsed) {
            const selectionHit = findMatchCoveringAnchor(matches, anchor);
            if (selectionHit >= 1) {
                return selectionHit;
            }
        }

        const atOrBefore = findLastMatchAtOrBefore(matches, anchor);
        if (atOrBefore >= 1) {
            return atOrBefore;
        }

        const after = findFirstMatchAfter(matches, anchor);
        if (after >= 1) {
            return after;
        }
    } catch {
        // compareBoundaryPoints 等异常时回退
    }

    return 1;
}

function isUsableRange(range: Range): boolean {
    try {
        return Boolean(range.startContainer?.isConnected && range.endContainer?.isConnected);
    } catch {
        return false;
    }
}

function isMatchRangeUsable(match: SearchMatch): match is SearchMatch & {range: Range} {
    return Boolean(match.range && isUsableRange(match.range));
}

/** 选区被某条匹配覆盖，或选区覆盖某条匹配 */
function findMatchCoveringAnchor(matches: SearchMatch[], anchor: Range): number {
    for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i];
        if (!isMatchRangeUsable(match)) {
            continue;
        }
        try {
            const startCmp = match.range.compareBoundaryPoints(Range.START_TO_START, anchor);
            const endCmp = match.range.compareBoundaryPoints(Range.END_TO_END, anchor);
            // 匹配 ⊇ 选区，或选区 ⊇ 匹配
            if ((startCmp <= 0 && endCmp >= 0) || (startCmp >= 0 && endCmp <= 0)) {
                return i + 1;
            }
        } catch {
            continue;
        }
    }
    return 0;
}

/** 光标及之前：文档序上最后一个起点 ≤ 锚点起点的匹配 */
function findLastMatchAtOrBefore(matches: SearchMatch[], anchor: Range): number {
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const match = matches[i];
        if (!isMatchRangeUsable(match)) {
            continue;
        }
        try {
            if (match.range.compareBoundaryPoints(Range.START_TO_START, anchor) <= 0) {
                return i + 1;
            }
        } catch {
            continue;
        }
    }
    return 0;
}

/** 光标之后：第一个起点 > 锚点起点的匹配 */
function findFirstMatchAfter(matches: SearchMatch[], anchor: Range): number {
    for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i];
        if (!isMatchRangeUsable(match)) {
            continue;
        }
        try {
            if (match.range.compareBoundaryPoints(Range.START_TO_START, anchor) > 0) {
                return i + 1;
            }
        } catch {
            continue;
        }
    }
    return 0;
}
