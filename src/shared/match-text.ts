import {
    effectiveSearchQuery,
    ZERO_WIDTH_GLOBAL_RE,
    ZERO_WIDTH_RE,
} from "./constants";
import {isRendererUnitId} from "./renderer-units";
import {ATTRIBUTE_VIEW_TYPE} from "./replaceable";

/** 旧缓存/旧 RPC 单元兼容；新单元统一使用 renderer: 前缀。 */
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
 * VS Code / Monaco 风格单词分隔符，加上常用中文标点（空白单独视为分隔）。
 * 只在打开全字匹配时使用。
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/core/wordHelper.ts
 */
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?，。！？；：、（）【】［］｛｝《》〈〉「」『』“”‘’〔〕…—～·";

/**
 * 生成搜索关键词变体（Issue #42：空白 / 零宽字符）
 * @param allowLooseWhitespace 为 false 时不做「去全部空白」变体
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
    if (
        isRendererUnitId(unit.unitId) ||
        unit.unitId === MERMAID_UNIT_ID ||
        unit.unitId === HTML_BLOCK_UNIT_ID
    ) {
        return false;
    }
    if (!isOffsetReplaceable(unit.segmentLengths, start, end)) {
        return false;
    }
    // 跨内部标记的替换会删除该字符。搜索可保持透明，写回必须等 DOM 身份能证明它是思源标记。
    return !ZERO_WIDTH_RE.test(unit.text.slice(start, end));
}

/** 每轮匹配的单元快照只累计一次，密集命中随后二分定位；不缓存可被调用方修改的长度数组。 */
function* iterateUnitReplaceability(unit: SearchableUnit): Generator<void, (start: number, end: number) => boolean> {
    if (
        unit.blockType === ATTRIBUTE_VIEW_TYPE || isRendererUnitId(unit.unitId) ||
        unit.unitId === MERMAID_UNIT_ID || unit.unitId === HTML_BLOCK_UNIT_ID || !unit.segmentLengths?.length
    ) return () => false;
    const ends: number[] = [];
    let cursor = 0;
    let count = 0;
    for (const length of unit.segmentLengths) {
        cursor += length;
        ends.push(cursor);
        if ((++count & 4095) === 0) yield;
    }
    return (start, end) => {
        if (start < 0 || end < start) return false;
        let low = 0;
        let high = ends.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (ends[mid] < end) low = mid + 1;
            else high = mid;
        }
        return low < ends.length && start >= (low === 0 ? 0 : ends[low - 1]) &&
            !ZERO_WIDTH_RE.test(unit.text.slice(start, end));
    };
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

function createLiteralSearchPlan(keyword: string, options: MatchOptions): LiteralSearchPlan {
    return {
        caseSensitive: options.caseSensitive === true,
        variants: generateSearchVariants(keyword).map((value) => {
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
    const query = effectiveSearchQuery(keyword);
    if (!query) {
        return () => false;
    }
    if (usesRegex(options)) {
        let pattern: RegExp;
        try {
            pattern = createSearchPattern(query, options);
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
    const plan = createLiteralSearchPlan(query, options);
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
    const query = effectiveSearchQuery(keyword);
    if (!query) {
        return [];
    }
    if (usesRegex(options)) {
        return findOffsetMatchesAdvanced(blockText, query, options);
    }
    return findOffsetMatchesLegacy(blockText, query, options);
}

function findOffsetMatchesLegacy(
    blockText: string,
    keyword: string,
    options: MatchOptions = {},
): TextOffsetMatch[] {
    const plan = createLiteralSearchPlan(keyword, options);
    return findLiteralMatches(blockText, plan, options.wholeWord === true, false);
}

function findLiteralMatches(
    blockText: string,
    plan: LiteralSearchPlan,
    wholeWord: boolean,
    stopAfterFirst: boolean,
): TextOffsetMatch[] {
    return finishIterator(iterateLiteralMatches(blockText, plan, wholeWord, stopAfterFirst));
}

/** 同步与分片路径共用同一状态机，不切原文，保留 Unicode lower 和内部标记的坐标。 */
function* iterateLiteralMatches(
    blockText: string,
    plan: LiteralSearchPlan,
    wholeWord: boolean,
    stopAfterFirst: boolean,
): Generator<void, TextOffsetMatch[]> {
    const allMatches: TextOffsetMatch[] = [];
    if (!blockText || plan.variants.length === 0) {
        return allMatches;
    }
    const normalizeMarkers = ZERO_WIDTH_RE.test(blockText) ||
        plan.variants.some((variant) => ZERO_WIDTH_RE.test(variant.value));
    // 普通文本不需要 span 去重，避免给高频词的每个命中分配字符串 key。
    const visibleSpans = normalizeMarkers ? new Set<string>() : null;

    const addDirect = (startIndex: number, endIndex: number, searchStr: string): boolean => {
        if (!isWholeWordMatch(blockText, startIndex, endIndex, wholeWord)) {
            return false;
        }
        if (visibleSpans) {
            const spanKey = visibleSpanKey(blockText, startIndex, endIndex);
            if (visibleSpans.has(spanKey)) {
                return false;
            }
            visibleSpans.add(spanKey);
        }
        allMatches.push({startIndex, endIndex, searchStr});
        return stopAfterFirst;
    };
    const directView = yield* iterateSearchView(blockText, plan.caseSensitive);

    for (const variant of plan.variants) {
        const needle = plan.caseSensitive ? variant.value : variant.folded;
        if (yield* iterateLiteralOccurrences(directView, needle, variant.value, addDirect)) {
            return allMatches;
        }
    }

    if (!normalizeMarkers) {
        return yield* iterateSortedOffsets(allMatches);
    }

    const normalized = yield* iterateStrippedMarkers(blockText);
    const normalizedView = yield* iterateSearchView(normalized.text, plan.caseSensitive);
    for (const variant of plan.variants) {
        const normalizedSearchStr = variant.value.replace(ZERO_WIDTH_GLOBAL_RE, "");
        if (!normalizedSearchStr) {
            continue;
        }
        const normalizedNeedle = plan.caseSensitive ? normalizedSearchStr : normalizedSearchStr.toLowerCase();
        const stopped = yield* iterateLiteralOccurrences(
            normalizedView,
            normalizedNeedle,
            normalizedSearchStr,
            (normalizedStart, normalizedEnd) => {
                const originalStart = originalStartAt(normalized.positions, normalizedStart);
                const originalEnd = originalEndAt(normalized.positions, normalizedEnd);
                if (originalStart < 0 || originalEnd <= originalStart) {
                    return false;
                }
                if (
                    !isWholeWordMatch(
                        blockText,
                        originalStart,
                        originalEnd,
                        wholeWord,
                    )
                ) {
                    return false;
                }
                const spanKey = visibleSpanKey(blockText, originalStart, originalEnd);
                if ((visibleSpans as Set<string>).has(spanKey)) {
                    return false;
                }
                (visibleSpans as Set<string>).add(spanKey);
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

    return yield* iterateSortedOffsets(allMatches);
}

interface SearchView {
    text: string;
    /** 折叠改变长度时，将折叠后每个 code unit 映回原文范围。 */
    starts?: number[];
    ends?: number[];
    /** 极少数无法建立长度映射的运行时回退。 */
    rawFallback?: string;
}

function* iterateSearchView(text: string, caseSensitive: boolean): Generator<void, SearchView> {
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
        if ((index & 4095) < width) yield;
    }
    // 默认 Unicode lower 的上下文规则可能改字符值，但通常不改变上述分段总长度。
    // 若将来 JS 引擎出现例外，用原文 RegExp 保留正确坐标。
    if (starts.length !== folded.length) {
        return {text: folded, rawFallback: text};
    }
    return {text: folded, starts, ends};
}

/** callback 返回 true 时提前停止。 */
function* iterateLiteralOccurrences(
    view: SearchView,
    needle: string,
    searchStr: string,
    callback: (start: number, end: number, searchStr: string) => boolean,
): Generator<void, boolean> {
    if (!needle || !view.text) {
        return false;
    }
    if (view.rawFallback !== undefined) {
        const pattern = new RegExp(escapeForRegex(searchStr), "gi");
        let match = pattern.exec(view.rawFallback);
        let count = 0;
        while (match) {
            if (match[0].length > 0 && callback(match.index, match.index + match[0].length, searchStr)) {
                return true;
            }
            if (match[0].length === 0) {
                pattern.lastIndex += 1;
            }
            match = pattern.exec(view.rawFallback);
            if ((++count & 255) === 0) yield;
        }
        return false;
    }
    let start = 0;
    let count = 0;
    let scanBase = -1;
    let limit = 0;
    let scanText = "";
    while (start < view.text.length) {
        // 限定每次原生 indexOf 的扫描长度；重叠尾部只负责跨窗口命中。
        if (scanBase < 0 || start >= limit) {
            scanBase = start;
            limit = Math.min(view.text.length, start + Math.max(65536, needle.length));
            scanText = view.text.slice(scanBase, limit + needle.length - 1);
        }
        const found = scanText.indexOf(needle, start - scanBase);
        if (found < 0 || scanBase + found >= limit) {
            start = limit;
            yield;
            continue;
        }
        start = scanBase + found;
        const foldedEnd = start + needle.length;
        const originalStart = view.starts?.[start] ?? start;
        const originalEnd = view.ends?.[foldedEnd - 1] ?? foldedEnd;
        if (callback(originalStart, originalEnd, searchStr)) {
            return true;
        }
        start = foldedEnd;
        if ((++count & 255) === 0) yield;
    }
    return false;
}

function* iterateStrippedMarkers(text: string): Generator<void, {text: string; positions: number[];}> {
    let normalized = "";
    const positions: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
        if ((index & 4095) === 4095) yield;
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
    return findOffsetMatchesWithPattern(blockText, pattern, options);
}

/**
 * 零长度命中不进入结果。继续扫描时必须严格离开当前起点：
 * 非 u 模式前进一个 UTF-16 code unit；u 模式按 AdvanceStringIndex 跳过整个码点。
 * 只做 lastIndex += 1 会落在 emoji 代理对中间，带 u 的 exec 会退回同一码点并永远重入。
 */
function advanceStringIndex(text: string, index: number, unicode: boolean): number {
    if (!unicode || index < 0 || index >= text.length) {
        return index + 1;
    }
    const codePoint = text.codePointAt(index);
    return index + (codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1);
}

/**
 * RegExp 带有 lastIndex 状态，但同一查询的 pattern 可以在每个单元开始时重置后安全复用。
 * 这让整轮搜索只编译一次正则，同时保留原有的 g/u/m/s 和零长度命中语义。
 */
function findOffsetMatchesWithPattern(
    blockText: string,
    pattern: RegExp,
    options: MatchOptions,
): TextOffsetMatch[] {
    const allMatches: TextOffsetMatch[] = [];
    const unicode = pattern.unicode;
    pattern.lastIndex = 0;
    let match = pattern.exec(blockText);
    while (match) {
        const matchedText = match[0];
        if (!matchedText.length) {
            const nextIndex = advanceStringIndex(blockText, match.index, unicode);
            if (nextIndex <= match.index) {
                break;
            }
            pattern.lastIndex = nextIndex;
            match = pattern.exec(blockText);
            continue;
        }
        const startIndex = match.index;
        const endIndex = startIndex + matchedText.length;
        if (
            isWholeWordMatch(
                blockText,
                startIndex,
                endIndex,
                options.wholeWord === true,
            )
        ) {
            allMatches.push({startIndex, endIndex, searchStr: matchedText});
        }
        match = pattern.exec(blockText);
    }
    return sortOffsetMatches(allMatches);
}

export function createSearchPattern(query: string, options: MatchOptions): RegExp {
    const source = options.regex ? query : escapeForRegex(query);
    const flags = regexSearchFlags(options);
    return new RegExp(source, flags);
}

/**
 * 查找与替换捕获组展开共用的 flags。u/m/s 固定关闭，旧配置和旧 RPC 字段均不生效。
 */
export function regexSearchFlags(options: MatchOptions, global = true): string {
    let flags = global ? "g" : "";
    if (!options.caseSensitive) {
        flags += "i";
    }
    return flags;
}

export function escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 非空白、且不在默认分隔符里。汉字和带声调的字母都算词的一部分。 */
function isWordChar(ch: string): boolean {
    if (!ch || ZERO_WIDTH_RE.test(ch) || /\s/.test(ch)) {
        return false;
    }
    return WORD_SEPARATORS.indexOf(ch) < 0;
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
    let visibleStart = start;
    while (visibleStart > 0 && ZERO_WIDTH_RE.test(text.charAt(visibleStart - 1))) {
        visibleStart -= 1;
    }
    if (visibleStart > 0 && isWordChar(text.charAt(visibleStart - 1))) {
        return false;
    }
    let visibleEnd = end;
    while (visibleEnd < text.length && ZERO_WIDTH_RE.test(text.charAt(visibleEnd))) {
        visibleEnd += 1;
    }
    if (visibleEnd < text.length && isWordChar(text.charAt(visibleEnd))) {
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

function finishIterator<T>(iterator: Generator<void, T>): T {
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
}

/** 大量命中不能在最后用一次全量 sort 把前面的时间预算抵消。 */
function* iterateSortedOffsets(matches: TextOffsetMatch[]): Generator<void, TextOffsetMatch[]> {
    if (matches.length <= 4096) return sortOffsetMatches(matches);
    let ordered = true;
    for (let index = 1; index < matches.length; index++) {
        const previous = matches[index - 1];
        const current = matches[index];
        if (
            previous.startIndex > current.startIndex ||
            (previous.startIndex === current.startIndex && previous.endIndex > current.endIndex)
        ) {
            ordered = false;
            break;
        }
        if ((index & 4095) === 4095) yield;
    }
    if (ordered) return matches;
    let sorted: TextOffsetMatch[] = [];
    for (let start = 0; start < matches.length; start += 4096) {
        const chunk = sortOffsetMatches(matches.slice(start, start + 4096));
        for (const match of chunk) sorted.push(match);
        yield;
    }
    let scratch: TextOffsetMatch[] = new Array(sorted.length);
    for (let width = 4096; width < sorted.length; width *= 2) {
        for (let start = 0; start < sorted.length; start += 2 * width) {
            const middle = Math.min(start + width, sorted.length);
            const end = Math.min(start + 2 * width, sorted.length);
            let left = start;
            let right = middle;
            for (let index = start; index < end; index++) {
                const a = sorted[left];
                const b = sorted[right];
                scratch[index] = right >= end || (left < middle &&
                        (a.startIndex < b.startIndex || (a.startIndex === b.startIndex && a.endIndex <= b.endIndex))) ?
                    sorted[left++] :
                    sorted[right++];
                if ((index & 4095) === 4095) yield;
            }
        }
        [sorted, scratch] = [scratch, sorted];
    }
    return sorted;
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
    if (!units.length) return {hits: [], error: ""};
    return createTextUnitsMatcher(query, options)(units);
}

/** 分片匹配复用同一查询计划；单元之间仍保持独立偏移和去重规则。 */
export function createTextUnitsMatcher(
    query: string,
    options: MatchTextUnitsOptions = {},
): (units: SearchableUnit[]) => MatchTextUnitsResult {
    const iterate = createTextUnitsMatchIterator(query, options);
    return (units) => finishIterator(iterate(units));
}

export function createTextUnitsMatchIterator(
    query: string,
    options: MatchTextUnitsOptions = {},
): (units: SearchableUnit[]) => Generator<void, MatchTextUnitsResult> {
    const effectiveQuery = effectiveSearchQuery(query);
    if (!effectiveQuery) {
        return function*() {
            return {hits: [], error: ""};
        };
    }

    const regex = usesRegex(options);
    let literalPlan: LiteralSearchPlan | null = null;
    let regexPattern: RegExp | null = null;
    if (!regex) {
        literalPlan = createLiteralSearchPlan(effectiveQuery, options);
        if (literalPlan.variants.length === 0) {
            return function*() {
                return {hits: [], error: ""};
            };
        }
    } else {
        try {
            regexPattern = createSearchPattern(effectiveQuery, options);
        } catch (error) {
            return function*() {
                return {
                    hits: [],
                    error: error instanceof Error ? error.message : "正则表达式无效",
                };
            };
        }
    }

    const dedupeOverlaps = options.dedupeOverlaps === true;
    return function*(units) {
        const result: MatchHit[] = [];

        let unitCount = 0;
        for (const unit of units) {
            if ((++unitCount & 255) === 0) yield;
            const offsetMatches = regex ?
                findOffsetMatchesWithPattern(unit.text, regexPattern as RegExp, options) :
                yield* iterateLiteralMatches(
                    unit.text,
                    literalPlan as LiteralSearchPlan,
                    options.wholeWord === true,
                    false,
                );
            if (!offsetMatches.length) continue;
            const replaceable = yield* iterateUnitReplaceability(unit);
            // offsetMatches 已按 start/end 排序。被接受的区间两两不重叠，
            // 所以只需同最近区间的终点比较，不需要对每个命中重复扫描整个数组。
            let acceptedEnd = -1;

            let count = 0;
            for (const match of offsetMatches) {
                if ((++count & 255) === 0) yield;
                if (dedupeOverlaps && match.startIndex < acceptedEnd) {
                    continue;
                }

                if (dedupeOverlaps) {
                    acceptedEnd = match.endIndex;
                }

                result.push(offsetMatchToHit(unit, match, replaceable(match.startIndex, match.endIndex)));
            }
            yield;
        }

        return {hits: result, error: ""};
    };
}

export function offsetMatchToHit(unit: SearchableUnit, match: TextOffsetMatch, replaceable?: boolean): MatchHit {
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
        replaceable: replaceable ?? isHitReplaceableByUnit(unit, match.startIndex, match.endIndex),
    };
}
