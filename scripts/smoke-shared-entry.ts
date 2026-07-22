/**
 * Phase 1–4 冒烟：shared 匹配核 + 选区纯函数 + preserve-case + RPC 规范化
 */
import {
    ATTRIBUTE_VIEW_TYPE,
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    findOffsetMatchesInText,
    generateSearchVariants,
    isHitReplaceableByUnit,
    isOffsetReplaceable,
    matchTextUnits,
    matchTextUnitsDetailed,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeSearchStateEvent,
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
assert(PREFS_STORAGE_PATH === "prefs.json", "prefs path");
assert(normalizePrefsPatch([{lastQuery: "x"}]).lastQuery === "x", "prefs patch");

const state = normalizeSearchStateEvent([{type: "close", clientId: "c1"}]);
assert(state?.type === "close" && state.clientId === "c1", "search-state event");
assert(normalizeSearchStateEvent([{type: "nope"}]) === null, "rejects bad search-state");

// --- Phase 2: selection scope helpers（无 DOM）---
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

// --- Phase 4: preserve-case ---
assert(preserveReplacementCase("bar", "FOO") === "BAR", "preserve upper");
assert(preserveReplacementCase("BAR", "foo") === "bar", "preserve lower");
assert(preserveReplacementCase("bar", "Foo") === "Bar", "preserve title");
assert(preserveReplacementCase("baz", "传感器") === "baz", "cjk unchanged");

console.log("smoke:shared OK (Phase 1–4: match + selection + preserve-case)");
