import {ZERO_WIDTH_GLOBAL_RE, ZERO_WIDTH_RE} from "./constants";
import {ATTRIBUTE_VIEW_TYPE} from "./replaceable";

/** 与 frontend/blocks MERMAID_UNIT_ID 对齐 */
const MERMAID_UNIT_ID = "mermaid-source";
import type {
    MatchHit,
    MatchOptions,
    MatchTextUnitsOptions,
    MatchTextUnitsResult,
    SearchableUnit,
    TextOffsetMatch,
} from "./types";

const ASCII_WORD_CHAR = /[A-Za-z0-9_]/

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

    return [...new Set(variants)];
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
    if (unit.unitId === MERMAID_UNIT_ID) {
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

function usesAdvancedOptions(options: MatchOptions): boolean {
    return Boolean(options.caseSensitive || options.wholeWord || options.regex);
}

/**
 * 历史默认：小写 + 变体 indexOf（含去空白变体）。
 */
export function findOffsetMatchesInText(
    blockText: string,
    keyword: string,
    options: MatchOptions = {},
): TextOffsetMatch[] {
    if (usesAdvancedOptions(options)) {
        return findOffsetMatchesAdvanced(blockText, keyword, options);
    }
    return findOffsetMatchesLegacy(blockText, keyword);
}

function findOffsetMatchesLegacy(blockText: string, keyword: string): TextOffsetMatch[] {
    const searchVariants = generateSearchVariants(keyword, true);
    const allMatches: TextOffsetMatch[] = [];

    for (const searchStr of searchVariants) {
        let startIndex = 0;
        while ((startIndex = blockText.indexOf(searchStr, startIndex)) !== -1) {
            const endIndex = startIndex + searchStr.length;
            allMatches.push({startIndex, endIndex, searchStr});
            startIndex = endIndex;
        }

        const normalizedDocText = blockText.replace(ZERO_WIDTH_GLOBAL_RE, "");
        const normalizedSearchStr = searchStr.replace(ZERO_WIDTH_GLOBAL_RE, "");

        if (normalizedSearchStr !== searchStr || normalizedDocText !== blockText) {
            startIndex = 0;
            while ((startIndex = normalizedDocText.indexOf(normalizedSearchStr, startIndex)) !== -1) {
                const endIndex = startIndex + normalizedSearchStr.length;
                const originalStartIndex = findOriginalPosition(blockText, normalizedDocText, startIndex);
                const originalEndIndex = findOriginalPosition(blockText, normalizedDocText, endIndex);
                if (originalStartIndex !== -1 && originalEndIndex !== -1) {
                    allMatches.push({
                        startIndex: originalStartIndex,
                        endIndex: originalEndIndex,
                        searchStr,
                    });
                }
                startIndex = endIndex;
            }
        }
    }

    return sortOffsetMatches(allMatches);
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

export function isWholeWordMatch(
    text: string,
    start: number,
    end: number,
    enabled: boolean,
): boolean {
    if (!enabled) {
        return true;
    }
    const previousChar = start > 0 ? text[start - 1] : "";
    const nextChar = end < text.length ? text[end] : "";
    return !ASCII_WORD_CHAR.test(previousChar) && !ASCII_WORD_CHAR.test(nextChar);
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
 * 默认行为与历史一致；开启 caseSensitive/wholeWord/regex 时走 RegExp 路径。
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

    const advanced = usesAdvancedOptions(options);
    let keywordForLegacy = "";
    if (!advanced) {
        keywordForLegacy = trimmed.toLowerCase();
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
        const haystack = advanced ? unit.text : unit.text.toLowerCase();
        const needle = advanced ? trimmed : keywordForLegacy;
        const offsetMatches = findOffsetMatchesInText(haystack, needle, options);
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

function findOriginalPosition(
    originalText: string,
    normalizedText: string,
    normalizedIndex: number,
): number {
    let originalIndex = 0;
    let normalizedIndexCount = 0;

    while (originalIndex < originalText.length && normalizedIndexCount < normalizedIndex) {
        if (!ZERO_WIDTH_RE.test(originalText[originalIndex])) {
            normalizedIndexCount++;
        }
        originalIndex++;
    }

    if (normalizedIndexCount === normalizedIndex && originalIndex <= originalText.length) {
        const remainingOriginal = originalText.slice(originalIndex).replace(ZERO_WIDTH_GLOBAL_RE, "");
        const remainingNormalized = normalizedText.slice(normalizedIndex);

        if (
            remainingOriginal.startsWith(
                remainingNormalized.substring(
                    0,
                    Math.min(remainingOriginal.length, remainingNormalized.length),
                ),
            )
        ) {
            while (originalIndex < originalText.length && ZERO_WIDTH_RE.test(originalText[originalIndex])) {
                originalIndex++;
            }
            return originalIndex;
        }
    }

    return -1;
}
