import {ZERO_WIDTH_GLOBAL_RE, ZERO_WIDTH_RE} from "./constants";
import {ATTRIBUTE_VIEW_TYPE} from "./replaceable";

/** 与 frontend/blocks MERMAID_UNIT_ID / HTML_BLOCK_UNIT_ID 对齐 */
const MERMAID_UNIT_ID = "mermaid-source";
const HTML_BLOCK_UNIT_ID = "html-block-rendered";
import type {
    MatchHit,
    MatchOptions,
    MatchTextUnitsOptions,
    MatchTextUnitsResult,
    SearchableUnit,
    TextOffsetMatch,
} from "./types";

/**
 * VS Code / Monaco 默认单词分隔符（不含空白；空白单独视为分隔）。
 * 只在打开全字匹配时使用。
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/core/wordHelper.ts
 */
const DEFAULT_WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/**
 * 生成搜索关键词变体（Issue #42：空白 / 零宽字符）
 * @param allowLooseWhitespace 为 false 时不做「去全部空白」变体（精确/正则模式）
 */
export function generateSearchVariants(
    searchStr: string,
    allowLooseWhitespace = true,
): string[] {
    if (!searchStr) {
        return [];
    }

    const variants = [searchStr];

    const trimmed = searchStr.trim();
    if (trimmed !== searchStr) {
        variants.push(trimmed);
    }

    const noZeroWidth = searchStr.replace(ZERO_WIDTH_GLOBAL_RE, "");
    if (noZeroWidth !== searchStr) {
        variants.push(noZeroWidth);
    }

    if (allowLooseWhitespace) {
        const noWhitespace = searchStr.replace(/\s/g, "");
        if (noWhitespace !== searchStr && noWhitespace.length > 0) {
            variants.push(noWhitespace);
        }
    }

    // 仅内部标记组成的变体在 indexOf("") 循环中无法前进，也没有用户可见意义。
    return [...new Set(variants)].filter((variant) => {
        return variant.length > 0 && variant.replace(ZERO_WIDTH_GLOBAL_RE, "").length > 0;
    });
}

/**
 * 判断 [start, end) 是否完全落在某一段文本内（对应「同一 Text 节点」）。
 */
export function isOffsetReplaceable(
    segmentLengths: number[] | undefined,
    start: number,
    end: number,
): boolean {
    if (!segmentLengths?.length || start < 0 || end < start) {
        return false;
    }

    let cursor = 0;
    for (const length of segmentLengths) {
        const nextCursor = cursor + length;
        if (start >= cursor && end <= nextCursor) {
            return true;
        }
        cursor = nextCursor;
    }
    return false;
}

export function isHitReplaceableByUnit(
    unit: SearchableUnit,
    start: number,
    end: number,
): boolean {
    if (unit.blockType === ATTRIBUTE_VIEW_TYPE) {
        return false;
    }
    if (unit.unitId === MERMAID_UNIT_ID || unit.unitId === HTML_BLOCK_UNIT_ID) {
        return false;
    }
    return isOffsetReplaceable(unit.segmentLengths, start, end);
}

export function rangesOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
): boolean {
    return aStart < bEnd && aEnd > bStart;
}

function usesRegex(options: MatchOptions): boolean {
    return options.regex === true;
}

interface LiteralVariant {
    value: string;
    folded: string;
}

interface LiteralSearchPlan {
    variants: LiteralVariant[];
    caseSensitive: boolean;
}

function createLiteralSearchPlan(keyword: string, caseSensitive: boolean): LiteralSearchPlan {
    return {
        caseSensitive,
        variants: generateSearchVariants(keyword, true).map((value) => {
            const folded = value.toLowerCase();
            return {
                value,
                folded,
            };
        }),
    };
}

/**
 * 判断这段文字有没有可能命中。允许多放进一些格子，不能漏掉真正会命中的文字。
 * 正则只编译一次，避免每个单元格各建一份。
 */
export function createTextMatchProbe(
    keyword: string,
    options: MatchOptions,
): (text: string) => boolean {
    const trimmed = keyword.trim();
    if (!trimmed) {
        return () => false;
    }
    if (usesRegex(options)) {
        let pattern: RegExp;
        try {
            pattern = createSearchPattern(trimmed, options);
        } catch {
            return () => false;
        }
        return (text: string) => {
            if (!text) {
                return false;
            }
            pattern.lastIndex = 0;
            return pattern.test(text);
        };
    }
    const plan = createLiteralSearchPlan(trimmed, options.caseSensitive === true);
    if (plan.variants.length === 0) {
        return () => false;
    }
    // Probe 只负责构造候选超集，wholeWord 留给最终匹配判断。
    return (text: string) => findLiteralMatches(text, plan, false, true).length > 0;
}

export function findOffsetMatchesInText(
    blockText: string,
    keyword: string,
    options: MatchOptions = {},
): TextOffsetMatch[] {
    if (usesRegex(options)) {
        return findOffsetMatchesAdvanced(blockText, keyword, options);
    }
    return findOffsetMatchesLegacy(blockText, keyword, options);
}

function findOffsetMatchesLegacy(
    blockText: string,
    keyword: string,
    options: MatchOptions = {},
): TextOffsetMatch[] {
    const plan = createLiteralSearchPlan(keyword, options.caseSensitive === true);
    return findLiteralMatches(blockText, plan, options.wholeWord === true, false);
}

function findLiteralMatches(
    blockText: string,
    plan: LiteralSearchPlan,
    wholeWord: boolean,
    stopAfterFirst: boolean,
): TextOffsetMatch[] {
    const allMatches: TextOffsetMatch[] = [];
    const visibleSpans = new Set<string>();
    if (!blockText || plan.variants.length === 0) {
        return allMatches;
    }

    const addDirect = (startIndex: number, endIndex: number, searchStr: string): boolean => {
        if (!isWholeWordMatch(blockText, startIndex, endIndex, wholeWord)) {
            return false;
        }
        const spanKey = visibleSpanKey(blockText, startIndex, endIndex);
        if (visibleSpans.has(spanKey)) {
            return false;
        }
        visibleSpans.add(spanKey);
        allMatches.push({startIndex, endIndex, searchStr});
        return stopAfterFirst;
    };
    const directView = createSearchView(blockText, plan.caseSensitive);

    for (const variant of plan.variants) {
        const needle = plan.caseSensitive ? variant.value : variant.folded;
        if (forEachLiteralOccurrence(directView, needle, variant.value, addDirect)) {
            return allMatches;
        }
    }

    if (!ZERO_WIDTH_RE.test(blockText)
        && !plan.variants.some((variant) => ZERO_WIDTH_RE.test(variant.value))) {
        return sortOffsetMatches(allMatches);
    }

    const normalized = stripInternalMarkers(blockText);
    const normalizedView = createSearchView(normalized.text, plan.caseSensitive);
    for (const variant of plan.variants) {
        const normalizedSearchStr = variant.value.replace(ZERO_WIDTH_GLOBAL_RE, "");
        if (!normalizedSearchStr) {
            continue;
        }
        const normalizedNeedle = plan.caseSensitive ? normalizedSearchStr : normalizedSearchStr.toLowerCase();
        const stopped = forEachLiteralOccurrence(
            normalizedView,
            normalizedNeedle,
            normalizedSearchStr,
            (normalizedStart, normalizedEnd) => {
                const originalStart = originalStartAt(normalized.positions, normalizedStart);
                const originalEnd = originalEndAt(normalized.positions, normalizedEnd);
                if (originalStart < 0 || originalEnd <= originalStart) {
                    return false;
                }
                if (!isWholeWordMatch(blockText, originalStart, originalEnd, wholeWord)) {
                    return false;
                }
                const spanKey = visibleSpanKey(blockText, originalStart, originalEnd);
                if (visibleSpans.has(spanKey)) {
                    return false;
                }
                visibleSpans.add(spanKey);
                allMatches.push({
                    startIndex: originalStart,
                    endIndex: originalEnd,
                    searchStr: variant.value,
                });
                return stopAfterFirst;
            },
        );
        if (stopped) {
            return allMatches;
        }
    }

    return sortOffsetMatches(allMatches);
}

interface SearchView {
    text: string;
    /** 折叠改变长度时，将折叠后每个 code unit 映回原文范围。 */
    starts?: number[];
    ends?: number[];
    /** 极少数无法建立长度映射的运行时回退。 */
    rawFallback?: string;
}

function createSearchView(text: string, caseSensitive: boolean): SearchView {
    if (caseSensitive) {
        return {text};
    }
    const folded = text.toLowerCase();
    if (folded.length === text.length) {
        return {text: folded};
    }
    const starts: number[] = [];
    const ends: number[] = [];
    for (let index = 0; index < text.length;) {
        const codePoint = text.codePointAt(index) as number;
        const raw = String.fromCodePoint(codePoint);
        const width = raw.length;
        const foldedPiece = raw.toLowerCase();
        for (let offset = 0; offset < foldedPiece.length; offset += 1) {
            starts.push(index);
            ends.push(index + width);
        }
        index += width;
    }
    // 默认 Unicode lower 的上下文规则可能改字符值，但通常不改变上述分段总长度。
    // 若将来 JS 引擎出现例外，用原文 RegExp 保留正确坐标。
    if (starts.length !== folded.length) {
        return {text: folded, rawFallback: text};
    }
    return {text: folded, starts, ends};
}

/** callback 返回 true 时提前停止。 */
function forEachLiteralOccurrence(
    view: SearchView,
    needle: string,
    searchStr: string,
    callback: (start: number, end: number, searchStr: string) => boolean,
): boolean {
    if (!needle || !view.text) {
        return false;
    }
    if (view.rawFallback !== undefined) {
        const pattern = new RegExp(escapeForRegex(searchStr), "gi");
        let match = pattern.exec(view.rawFallback);
        while (match) {
            if (match[0].length > 0 && callback(match.index, match.index + match[0].length, searchStr)) {
                return true;
            }
            if (match[0].length === 0) {
                pattern.lastIndex += 1;
            }
            match = pattern.exec(view.rawFallback);
        }
        return false;
    }
    let start = 0;
    while ((start = view.text.indexOf(needle, start)) !== -1) {
        const foldedEnd = start + needle.length;
        const originalStart = view.starts?.[start] ?? start;
        const originalEnd = view.ends?.[foldedEnd - 1] ?? foldedEnd;
        if (callback(originalStart, originalEnd, searchStr)) {
            return true;
        }
        start = foldedEnd;
    }
    return false;
}

function stripInternalMarkers(text: string): {text: string; positions: number[]} {
    let normalized = "";
    const positions: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
        if (ZERO_WIDTH_RE.test(text.charAt(index))) {
            continue;
        }
        normalized += text.charAt(index);
        positions.push(index);
    }
    return {text: normalized, positions};
}

function originalStartAt(positions: readonly number[], normalizedIndex: number): number {
    return normalizedIndex >= 0 && normalizedIndex < positions.length ? positions[normalizedIndex] : -1;
}

function originalEndAt(positions: readonly number[], normalizedIndex: number): number {
    if (normalizedIndex <= 0 || normalizedIndex > positions.length) {
        return -1;
    }
    return positions[normalizedIndex - 1] + 1;
}

/** 去掉两端内部标记后，用原文坐标形成稳定去重键。 */
function visibleSpanKey(text: string, start: number, end: number): string {
    const visibleStart = skipZeroWidthForward(text, start);
    const visibleEnd = skipZeroWidthBackward(text, end);
    return `${visibleStart}:${visibleEnd}`;
}

function skipZeroWidthForward(text: string, index: number): number {
    while (index < text.length && ZERO_WIDTH_RE.test(text.charAt(index))) {
        index += 1;
    }
    return index;
}

function skipZeroWidthBackward(text: string, index: number): number {
    while (index > 0 && ZERO_WIDTH_RE.test(text.charAt(index - 1))) {
        index -= 1;
    }
    return index;
}

function findOffsetMatchesAdvanced(
    blockText: string,
    keyword: string,
    options: MatchOptions,
): TextOffsetMatch[] {
    const pattern = createSearchPattern(keyword, options);
    const allMatches: TextOffsetMatch[] = [];
    pattern.lastIndex = 0;
    let match = pattern.exec(blockText);
    while (match) {
        const matchedText = match[0];
        if (!matchedText.length) {
            pattern.lastIndex += 1;
            match = pattern.exec(blockText);
            continue;
        }
        const startIndex = match.index;
        const endIndex = startIndex + matchedText.length;
        if (isWholeWordMatch(blockText, startIndex, endIndex, options.wholeWord === true)) {
            allMatches.push({startIndex, endIndex, searchStr: matchedText});
        }
        match = pattern.exec(blockText);
    }
    return sortOffsetMatches(allMatches);
}

export function createSearchPattern(query: string, options: MatchOptions): RegExp {
    const source = options.regex ? query : escapeForRegex(query);
    const flags = options.caseSensitive ? "g" : "gi";
    return new RegExp(source, flags);
}

export function escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 非空白、且不在默认分隔符里。汉字和带声调的字母都算词的一部分。 */
function isWordChar(ch: string): boolean {
    if (!ch || ZERO_WIDTH_RE.test(ch) || /\s/.test(ch)) {
        return false;
    }
    return DEFAULT_WORD_SEPARATORS.indexOf(ch) < 0;
}

export function isWholeWordMatch(
    text: string,
    start: number,
    end: number,
    enabled: boolean,
): boolean {
    if (!enabled) {
        return true;
    }
    if (start < 0 || end > text.length || start >= end) {
        return false;
    }
    if (start > 0 && isWordChar(text.charAt(start - 1))) {
        return false;
    }
    if (end < text.length && isWordChar(text.charAt(end))) {
        return false;
    }
    return true;
}

function sortOffsetMatches(allMatches: TextOffsetMatch[]): TextOffsetMatch[] {
    allMatches.sort((a, b) => {
        if (a.startIndex !== b.startIndex) {
            return a.startIndex - b.startIndex;
        }
        return (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex);
    });
    return allMatches;
}

/**
 * 对多个纯文本单元执行匹配，返回 MatchHit[]（无 DOM Range）。
 * 默认行为与历史一致；大小写和全字只控制各自维度，正则单独走 RegExp 路径。
 */
export function matchTextUnits(
    units: SearchableUnit[],
    query: string,
    options: MatchTextUnitsOptions = {},
): MatchHit[] {
    return matchTextUnitsDetailed(units, query, options).hits;
}

export function matchTextUnitsDetailed(
    units: SearchableUnit[],
    query: string,
    options: MatchTextUnitsOptions = {},
): MatchTextUnitsResult {
    const trimmed = query.trim();
    if (!trimmed || !units.length) {
        return {hits: [], error: ""};
    }

    const regex = usesRegex(options);
    let literalPlan: LiteralSearchPlan | null = null;
    if (!regex) {
        literalPlan = createLiteralSearchPlan(trimmed, options.caseSensitive === true);
        if (literalPlan.variants.length === 0) {
            return {hits: [], error: ""};
        }
    } else {
        try {
            createSearchPattern(trimmed, options);
        } catch (error) {
            return {
                hits: [],
                error: error instanceof Error ? error.message : "正则表达式无效",
            };
        }
    }

    const dedupeOverlaps = options.dedupeOverlaps === true;
    const result: MatchHit[] = [];

    for (const unit of units) {
        const offsetMatches = regex
            ? findOffsetMatchesAdvanced(unit.text, trimmed, options)
            : findLiteralMatches(unit.text, literalPlan as LiteralSearchPlan, options.wholeWord === true, false);
        const acceptedRanges: Array<{start: number; end: number}> = [];

        for (const match of offsetMatches) {
            if (
                dedupeOverlaps
                && acceptedRanges.some((range) =>
                    rangesOverlap(match.startIndex, match.endIndex, range.start, range.end)
                )
            ) {
                continue;
            }

            if (dedupeOverlaps) {
                acceptedRanges.push({start: match.startIndex, end: match.endIndex});
            }

            result.push(offsetMatchToHit(unit, match));
        }
    }

    return {hits: result, error: ""};
}

export function offsetMatchToHit(unit: SearchableUnit, match: TextOffsetMatch): MatchHit {
    const unitPrefix = unit.unitId ? `${unit.unitId}:` : "";
    return {
        id: `${unit.blockId}:${unitPrefix}${match.startIndex}:${match.endIndex}`,
        blockId: unit.blockId,
        blockType: unit.blockType,
        blockIndex: unit.blockIndex,
        unitId: unit.unitId,
        start: match.startIndex,
        end: match.endIndex,
        matchedText: unit.text.slice(match.startIndex, match.endIndex),
        replaceable: isHitReplaceableByUnit(unit, match.startIndex, match.endIndex),
    };
}
