import {containsNodeCrossingShadow} from "./dom-parent";
import type {SearchMatch} from "./dom-types";

interface RetainedAnchorOptions {
    previousMatches?: readonly SearchMatch[];
    edit?: Element;
}

/** 同步入口供小夹具使用；搜索栏使用下方可取消的分片入口。 */
export function resolveRetainedMatchIndex(
    matches: SearchMatch[],
    previous: SearchMatch,
    currentIndex: number,
    options: RetainedAnchorOptions = {},
): number {
    const iterator = retainedMatchIndex(matches, previous, currentIndex, options);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
}

export async function resolveRetainedMatchIndexWithBudget(
    matches: SearchMatch[],
    previous: SearchMatch,
    currentIndex: number,
    options: RetainedAnchorOptions,
    isCurrent: () => boolean,
): Promise<number | undefined> {
    const iterator = retainedMatchIndex(matches, previous, currentIndex, options);
    let started = performance.now();
    while (isCurrent()) {
        const step = iterator.next();
        if (step.done) return isCurrent() ? step.value : undefined;
        if (performance.now() - started >= 8) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            started = performance.now();
        }
    }
    return undefined;
}

/** 不保存全文或额外索引。可靠 Range 优先；命中快照未变时用偏移，否则仅接受唯一前后文。 */
function* retainedMatchIndex(
    matches: SearchMatch[],
    previous: SearchMatch,
    currentIndex: number,
    options: RetainedAnchorOptions,
): Generator<void, number> {
    if (!matches.length) return 0;
    const context = matchContext(previous);
    let contextIndex = 0;
    let contextCount = 0;
    let textIndex = 0;
    let textCount = 0;
    let offsetIndex = 0;
    let unchangedIndex = 0;
    let oldCursor = 0;
    let steps = 0;
    const old = options.previousMatches;
    let unchanged = Boolean(old);
    for (let index = 0; index < matches.length; index++) {
        if ((++steps & 255) === 0) yield;
        const match = matches[index];
        if (!sameAnchorUnit(match, previous)) continue;
        // 词级 Range 已证明身份时，不再遍历旧快照。备注枚举 Range 无法区分宿主内命中。
        if (match.matchedText === previous.matchedText && sameLiveTextRange(match, previous, options.edit)) {
            return index + 1;
        }
        if (unchanged && old) {
            while (oldCursor < old.length && !sameAnchorUnit(old[oldCursor], previous)) {
                oldCursor++;
                if ((++steps & 255) === 0) yield;
            }
            const prior = old[oldCursor++];
            unchanged = Boolean(prior && sameOccurrenceSnapshot(prior, match));
        }
        if (match.start === previous.start) offsetIndex = index + 1;
        if (match.matchedText !== previous.matchedText) continue;
        if (match.start === previous.start && match.end === previous.end) unchangedIndex = index + 1;
        textCount++;
        textIndex = index + 1;
        if (!context) continue;
        if (matchesContext(match, context)) {
            contextCount++;
            contextIndex = index + 1;
        }
    }
    if (unchanged && unchangedIndex && old) {
        while (oldCursor < old.length) {
            if ((++steps & 255) === 0) yield;
            if (sameAnchorUnit(old[oldCursor++], previous)) {
                unchanged = false;
                break;
            }
        }
    }
    if (unchanged && unchangedIndex) return unchangedIndex;
    if (contextCount === 1) return contextIndex;
    // 旧调用方未携带摘要元数据时保持原有按偏移的兼容路径。
    if (previous.listContextClipped === undefined && offsetIndex) return offsetIndex;
    if (textCount === 1) return textIndex;
    return Math.min(currentIndex, matches.length);
}

function sameOccurrenceSnapshot(a: SearchMatch, b: SearchMatch): boolean {
    return a.start === b.start && a.end === b.end && a.matchedText === b.matchedText &&
        a.listText === b.listText && a.listContextClipped === b.listContextClipped &&
        a.listMark?.start === b.listMark?.start && a.listMark?.end === b.listMark?.end;
}

function sameLiveTextRange(match: SearchMatch, previous: SearchMatch, edit?: Element): boolean {
    if (!edit || match.highlightKind === "inline-memo" || previous.highlightKind === "inline-memo") return false;
    const range = match.range;
    const anchor = previous.range;
    if (!range || !anchor) return false;
    try {
        return !anchor.collapsed && anchor.startContainer.nodeType === Node.TEXT_NODE &&
            anchor.endContainer.nodeType === Node.TEXT_NODE && anchor.startContainer.isConnected &&
            anchor.endContainer.isConnected && containsNodeCrossingShadow(edit, anchor.startContainer) &&
            containsNodeCrossingShadow(edit, anchor.endContainer) &&
            range.startContainer === anchor.startContainer && range.startOffset === anchor.startOffset &&
            range.endContainer === anchor.endContainer && range.endOffset === anchor.endOffset;
    } catch {
        return false;
    }
}

function sameAnchorUnit(match: SearchMatch, previous: SearchMatch): boolean {
    if (match.blockId !== previous.blockId) return false;
    if (
        !previous.unitId?.startsWith("embed:") && previous.highlightKind === "inline-math" &&
        previous.mathOrdinal !== undefined && previous.mathUnitText !== undefined
    ) {
        return match.highlightKind === "inline-math" && match.mathOrdinal === previous.mathOrdinal &&
            match.mathUnitText === previous.mathUnitText && !match.unitId?.startsWith("embed:");
    }
    if (
        !previous.unitId?.startsWith("embed:") && !previous.unitId?.startsWith("table-memo:") &&
        previous.highlightKind === "inline-memo" && previous.anchorOffset !== undefined
    ) {
        return match.highlightKind === "inline-memo" && match.anchorOffset === previous.anchorOffset &&
            !match.unitId?.startsWith("embed:") && !match.unitId?.startsWith("table-memo:");
    }
    return match.unitId === previous.unitId;
}

function matchesContext(match: SearchMatch, context: {before: string; after: string;}): boolean {
    const clipped = match.listContextClipped;
    const mark = match.listMark;
    const text = match.listText;
    if (clipped === undefined || (clipped & 4) || !mark || !text) return false;
    return mark.start - (clipped & 1 ? 1 : 0) >= context.before.length &&
        text.length - (clipped & 2 ? 1 : 0) - mark.end >= context.after.length &&
        text.endsWith(context.before, mark.start) && text.startsWith(context.after, mark.end);
}

function matchContext(match: SearchMatch): {before: string; after: string;} | null {
    const clipped = match.listContextClipped;
    const mark = match.listMark;
    const text = match.listText;
    if (clipped === undefined || (clipped & 4) || !mark || !text) return null;
    const before = text.slice(clipped & 1 ? 1 : 0, mark.start);
    const after = text.slice(mark.end, clipped & 2 ? -1 : undefined);
    return before || after ? {before, after} : null;
}

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

function isMatchRangeUsable(match: SearchMatch): match is SearchMatch & {range: Range;} {
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
