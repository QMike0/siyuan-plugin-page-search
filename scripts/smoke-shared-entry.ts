/**
 * Shared 冒烟：匹配核 + 限制查找门闩 + 选区纯函数 + preserve-case + RPC 规范化
 */
import {
    ATTRIBUTE_VIEW_TYPE,
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    SEARCH_COUNT_SOFT_CAP,
    canRestrictInlineMemo,
    coercePluginPrefs,
    findOffsetMatchesInText,
    formatSearchCountLabel,
    generateSearchVariants,
    hasRestrictInlineType,
    isHitReplaceableByUnit,
    isOffsetReplaceable,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    matchTextUnits,
    matchTextUnitsDetailed,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeRestrictInlineTypes,
    normalizeSearchStateEvent,
    parseDataTypeTokens,
    rangeRestrictTokens,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    shouldEnumerateRestrictInline,
    toggleRestrictInlineType,
} from "../src/shared";
import {preserveReplacementCase} from "../src/frontend/preserve-case";

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(message);
    }
}

const variants = generateSearchVariants("  foo\u200B  ");
assert(variants.includes("  foo\u200B  "), "keeps original");
assert(variants.includes("foo\u200B"), "trims");
assert(variants.some((v) => !/[\u200B-\u200D\uFEFF]/.test(v)), "has no-zw variant");

const tightVariants = generateSearchVariants("a b", false);
assert(tightVariants.includes("a b"), "tight keeps spaced");
assert(!tightVariants.includes("ab"), "tight skips no-whitespace variant");

const zwText = "hello\u200Bworld";
const matches = findOffsetMatchesInText(zwText.toLowerCase(), "helloworld");
assert(matches.length >= 1, "finds zero-width-spanning match");
assert(
    matches.some((m) => m.startIndex === 0 && m.endIndex === zwText.length),
    "maps to original span",
);

const units = [
    {
        blockId: "b1",
        blockType: "p",
        blockIndex: 0,
        text: "传感器2026",
        segmentLengths: [3, 4],
    },
    {
        blockId: "b2",
        blockType: "p",
        blockIndex: 1,
        text: "传感器",
        unitId: "cell-a",
        segmentLengths: [3],
    },
    {
        blockId: "b2",
        blockType: "p",
        blockIndex: 1,
        text: "2026",
        unitId: "cell-b",
        segmentLengths: [4],
    },
];

const allHits = matchTextUnits(units, "传感器");
assert(allHits.length === 2, `expected 2 hits for 传感器, got ${allHits.length}`);

const cross = matchTextUnits(units, "传感器2026");
assert(cross.some((h) => h.blockId === "b1"), "matches within single unit text");
assert(
    !cross.some((h) => h.unitId === "cell-a" || h.unitId === "cell-b"),
    "no cross-cell false match",
);

assert(isOffsetReplaceable([3, 4], 0, 3), "replaceable in first segment");
assert(!isOffsetReplaceable([3, 4], 2, 5), "not replaceable across segments");
assert(
    cross.some((h) => h.blockId === "b1" && h.replaceable === false),
    "cross-segment hit not replaceable",
);

const deduped = matchTextUnits(
    [{blockId: "d", blockType: "p", blockIndex: 0, text: "aaa"}],
    "aa",
    {dedupeOverlaps: true},
);
assert(deduped.length === 1, `dedupe overlaps: expected 1, got ${deduped.length}`);

// --- MatchOptions: caseSensitive / wholeWord / regex ---
const caseUnits = [{
    blockId: "c1",
    blockType: "p",
    blockIndex: 0,
    text: "Foo foo FOO",
    segmentLengths: [11],
}];

const insensitive = matchTextUnits(caseUnits, "foo");
assert(insensitive.length === 3, `default case-insensitive: expected 3, got ${insensitive.length}`);

const sensitive = matchTextUnits(caseUnits, "foo", {caseSensitive: true});
assert(sensitive.length === 1 && sensitive[0].matchedText === "foo", "caseSensitive finds exact foo");

const wordUnits = [{
    blockId: "w1",
    blockType: "p",
    blockIndex: 0,
    text: "cat cats catalog",
    segmentLengths: [16],
}];
const whole = matchTextUnits(wordUnits, "cat", {wholeWord: true});
assert(whole.length === 1 && whole[0].start === 0, `wholeWord: expected 1 at start, got ${whole.length}`);

const regexHits = matchTextUnits(
    [{blockId: "r1", blockType: "p", blockIndex: 0, text: "a1 b22 c3", segmentLengths: [9]}],
    "\\d+",
    {regex: true},
);
assert(regexHits.length === 3, `regex \\d+: expected 3, got ${regexHits.length}`);

const badRegex = matchTextUnitsDetailed(
    [{blockId: "r2", blockType: "p", blockIndex: 0, text: "x", segmentLengths: [1]}],
    "[",
    {regex: true},
);
assert(badRegex.hits.length === 0 && badRegex.error.length > 0, "invalid regex returns error");

// --- AV never replaceable ---
const avUnit = {
    blockId: "av1",
    blockType: ATTRIBUTE_VIEW_TYPE,
    blockIndex: 0,
    text: "cell",
    unitId: "c0",
    segmentLengths: [4],
};
assert(!isHitReplaceableByUnit(avUnit, 0, 4), "AV unit not replaceable by helper");
const avHits = matchTextUnits([avUnit], "cell");
assert(avHits.length === 1 && avHits[0].replaceable === false, "AV hit replaceable=false");

const named = normalizeMatchRequest([{
    query: "传感器",
    units: [units[1]],
    dedupeOverlaps: true,
    caseSensitive: true,
    wholeWord: false,
    regex: true,
}]);
assert(named.query === "传感器" && named.units.length === 1, "named match request");
assert(named.caseSensitive === true && named.regex === true, "named options");

const nested = normalizeMatchRequest([{
    query: "x",
    units: [],
    options: {caseSensitive: true, wholeWord: true},
}]);
assert(nested.caseSensitive === true && nested.wholeWord === true, "nested options object");

const positional = normalizeMatchRequest(["ab", [{blockId: "x", blockType: "p", blockIndex: 0, text: "ab"}]]);
assert(positional.query === "ab" && positional.units.length === 1, "positional match request");

const prefs = mergePrefs(DEFAULT_PREFS, {lastQuery: "hi", dialogLeft: 10});
assert(prefs.lastQuery === "hi" && prefs.dialogLeft === 10, "merge prefs");
assert(Array.isArray(prefs.restrictInlineTypes) && prefs.restrictInlineTypes.length === 0, "default restrict empty");
assert(PREFS_STORAGE_PATH === "prefs.json", "prefs path");
assert(normalizePrefsPatch([{lastQuery: "x"}]).lastQuery === "x", "prefs patch");

assert(!isRestrictInlineActive([]), "empty restrict inactive");
assert(isRestrictInlineActive(["mark"]), "non-empty restrict active");
assert(!canRestrictInlineMemo(false), "memo gate closed");
assert(canRestrictInlineMemo(true), "memo gate open");

const stripped = normalizeRestrictInlineTypes(
    ["mark", "inline-memo", "bogus", "strong"],
    {includeInlineMemo: false},
);
assert(stripped.join(",") === "strong,mark", "normalize strips memo+bogus when include off");

const withMemo = normalizeRestrictInlineTypes(
    ["inline-memo", "mark"],
    {includeInlineMemo: true},
);
assert(withMemo.join(",") === "mark,inline-memo", "normalize allowlist order");

assert(
    normalizeRestrictInlineTypes(["a", "block-ref", "code"], {includeInlineMemo: true}).join(",")
        === "block-ref,a,code",
    "block-ref sorts before link and code",
);

const blocked = toggleRestrictInlineType([], "inline-memo", true, {includeInlineMemo: false});
assert(blocked.length === 0, "cannot enable restrict memo when include off");

const gatedOff = coercePluginPrefs({
    includeInlineMemo: false,
    restrictInlineTypes: ["mark", "inline-memo"] as any,
});
assert(gatedOff.includeInlineMemo === false, "coerce include memo false");
assert(gatedOff.restrictInlineTypes.join(",") === "mark", "coerce strips restrict memo");
assert(hasRestrictInlineType(gatedOff.restrictInlineTypes, "mark"), "has mark");
assert(!hasRestrictInlineType(gatedOff.restrictInlineTypes, "inline-memo"), "no memo after gate");

const includeOffClears = mergePrefs(
    coercePluginPrefs({includeInlineMemo: true, restrictInlineTypes: ["inline-memo", "em"] as any}),
    {includeInlineMemo: false},
);
assert(includeOffClears.restrictInlineTypes.join(",") === "em", "closing include clears restrict memo");

assert(parseDataTypeTokens("strong em mark").join(",") === "strong,em,mark", "parse data-type tokens");
assert(
    rangeRestrictTokens(["mark", "inline-memo", "inline-math", "strong"]).join(",") === "mark,strong",
    "range tokens drop memo+math",
);
assert(
    matchPassesRestrictInline({restrictTypes: [], attributeKind: null, hostDataTypes: []}),
    "inactive restrict keeps text",
);
assert(
    matchPassesRestrictInline({
        restrictTypes: ["mark"],
        attributeKind: null,
        hostDataTypes: ["strong", "mark"],
    }),
    "OR: mark host kept",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["mark"],
        attributeKind: null,
        hostDataTypes: ["strong"],
    }),
    "OR: strong-only rejected when only mark",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["mark"],
        attributeKind: null,
        hostDataTypes: [],
    }),
    "no host rejected when restrict on",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["inline-memo"],
        attributeKind: null,
        hostDataTypes: ["inline-memo"],
    }),
    "memo-only restrict rejects body text even on memo host",
);
assert(
    matchPassesRestrictInline({
        restrictTypes: ["inline-memo"],
        attributeKind: "inline-memo",
        hostDataTypes: [],
    }),
    "memo unit kept when memo in restrict",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["mark"],
        attributeKind: "inline-memo",
        hostDataTypes: [],
    }),
    "memo unit dropped when memo not in restrict",
);

// --- 限制侧备注采集门闩（双开关四种组合）---
assert(shouldCollectBodyTextForRestrict([]), "no restrict → collect body");
assert(shouldCollectBodyTextForRestrict(["mark"]), "mark restrict → collect body");
assert(!shouldCollectBodyTextForRestrict(["inline-memo"]), "memo-only restrict → skip body");
assert(!shouldCollectBodyTextForRestrict(["inline-math"]), "math-only restrict → skip body");
assert(
    shouldCollectBodyTextForRestrict(["strong", "inline-memo"]),
    "memo+strong → collect body",
);
assert(
    shouldCollectInlineMemoUnits({includeInlineMemo: true, restrictTypes: []}),
    "include on + no restrict → collect memo",
);
assert(
    shouldCollectInlineMemoUnits({includeInlineMemo: true, restrictTypes: ["inline-memo"]}),
    "include on + restrict memo → collect memo",
);
assert(
    !shouldCollectInlineMemoUnits({includeInlineMemo: true, restrictTypes: ["mark"]}),
    "include on + restrict mark only → skip memo",
);
assert(
    !shouldCollectInlineMemoUnits({includeInlineMemo: false, restrictTypes: ["inline-memo"]}),
    "include off → skip memo even if restrict lists it",
);
assert(
    shouldCollectInlineMemoUnits({
        includeInlineMemo: true,
        restrictTypes: ["strong", "inline-memo"],
    }),
    "include on + restrict memo∪strong → collect memo",
);

// --- 行内公式渲染文本 unit（全文也采；限制时仅含 math 才采）---
assert(shouldCollectInlineMathUnits([]), "no restrict → collect rendered math units");
assert(shouldCollectInlineMathUnits(["inline-math"]), "restrict math → collect math");
assert(!shouldCollectInlineMathUnits(["mark"]), "restrict mark only → skip math units");
assert(
    shouldCollectInlineMathUnits(["strong", "inline-math"]),
    "restrict math∪strong → collect math",
);
assert(
    matchPassesRestrictInline({
        restrictTypes: ["inline-math"],
        attributeKind: "inline-math",
        hostDataTypes: [],
    }),
    "math unit kept when math in restrict",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["mark"],
        attributeKind: "inline-math",
        hostDataTypes: [],
    }),
    "math unit dropped when math not in restrict",
);
assert(
    !matchPassesRestrictInline({
        restrictTypes: ["inline-math"],
        attributeKind: null,
        hostDataTypes: ["inline-math"],
    }),
    "math-only restrict rejects body text on math host",
);

// --- 回归契约（限制关 = 旧行为门闩）---
assert(!isRestrictInlineActive(undefined as any), "undefined restrict inactive");
assert(!isRestrictInlineActive(null as any), "null restrict inactive");
assert(
    matchPassesRestrictInline({
        restrictTypes: [],
        attributeKind: "inline-math",
        hostDataTypes: [],
    }),
    "restrict off: filter keeps any hit",
);
assert(
    shouldCollectBodyTextForRestrict([]) && shouldCollectInlineMathUnits([]),
    "restrict off: body + rendered math units",
);
assert(
    !shouldCollectInlineMemoUnits({includeInlineMemo: false, restrictTypes: []}),
    "restrict off: memo still gated by include",
);
assert(
    shouldCollectInlineMemoUnits({includeInlineMemo: true, restrictTypes: []}),
    "restrict off: include on collects memo",
);

assert(!shouldEnumerateRestrictInline("", []), "empty query without restrict → no enumerate");
assert(!shouldEnumerateRestrictInline("", undefined), "undefined restrict → no enumerate");
assert(shouldEnumerateRestrictInline("", ["strong"]), "empty + restrict → enumerate");
assert(shouldEnumerateRestrictInline("  ", ["mark"]), "whitespace-only query → enumerate");
assert(!shouldEnumerateRestrictInline("foo", ["strong"]), "keyword + restrict → keyword mode");
assert(SEARCH_COUNT_SOFT_CAP === 999, "soft cap 999");
assert(formatSearchCountLabel(1, 10) === "1/10", "count below soft cap");
assert(formatSearchCountLabel(3, 1000) === "3/999+", "count above soft cap shows N+");
assert(formatSearchCountLabel(1200, 1500) === "1200/999+", "index can exceed soft cap display");

const state = normalizeSearchStateEvent([{type: "close", clientId: "c1"}]);
assert(state?.type === "close" && state.clientId === "c1", "search-state event");
assert(normalizeSearchStateEvent([{type: "nope"}]) === null, "rejects bad search-state");

// --- selection scope helpers（无 DOM）---
import {
    isMatchWithinSelection,
    isRangeContained,
    mergeTextOffsetRanges,
    unitKey,
} from "../src/frontend/selection";

assert(unitKey("b1") === "b1::", "unitKey without unitId");
assert(unitKey("b1", "cell-a") === "b1::cell-a", "unitKey with unitId");

assert(isRangeContained({start: 2, end: 8}, 3, 7), "contained inside");
assert(!isRangeContained({start: 2, end: 8}, 1, 4), "not contained when starts early");
assert(!isRangeContained({start: 2, end: 8}, 5, 9), "not contained when ends late");

const scope = new Map([
    ["b1::", [{start: 0, end: 5}, {start: 10, end: 15}]],
]);
assert(isMatchWithinSelection("b1::", 1, 4, true, scope), "hit inside first range");
assert(isMatchWithinSelection("b1::", 11, 14, true, scope), "hit inside second range");
assert(!isMatchWithinSelection("b1::", 4, 8, true, scope), "hit crossing ranges rejected");
assert(isMatchWithinSelection("b1::", 0, 100, false, scope), "selectionOnly off always true");
assert(!isMatchWithinSelection("other::", 0, 1, true, scope), "unknown unit empty");

const merged = mergeTextOffsetRanges([
    {start: 5, end: 8},
    {start: 0, end: 3},
    {start: 2, end: 6},
    {start: 10, end: 12},
]);
assert(
    merged.length === 2
    && merged[0].start === 0 && merged[0].end === 8
    && merged[1].start === 10 && merged[1].end === 12,
    "merge overlapping offset ranges",
);

// --- preserve-case ---
assert(preserveReplacementCase("bar", "FOO") === "BAR", "preserve upper");
assert(preserveReplacementCase("BAR", "foo") === "bar", "preserve lower");
assert(preserveReplacementCase("bar", "Foo") === "Bar", "preserve title");
assert(preserveReplacementCase("baz", "传感器") === "baz", "cjk unchanged");

console.log("smoke:shared OK (match + restrict + selection + preserve-case)");
