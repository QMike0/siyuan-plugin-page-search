/**
 * Shared 冒烟：匹配核 + 限制查找门闩 + 选区纯函数 + preserve-case + RPC 规范化
 */
import {
    ATTRIBUTE_VIEW_TYPE,
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    canRestrictInlineMemo,
    coercePluginPrefs,
    expandRegexReplacement,
    extractRegexLiteralGroups,
    regexPrefilterStoresPlainCache,
    avApiUnitInView,
    avApiUnitShown,
    collectAvDomCoverage,
    countVirtualTableRows,
    logicalRowOffset,
    logicalTableRows,
    createTextMatchProbe,
    findOffsetMatchesInText,
    mergeVirtualTableUnits,
    tableCellNodeId,
    tableCellPosition,
    formatSearchCountLabel,
    generateSearchVariants,
    hasRestrictInlineType,
    isHitReplaceableByUnit,
    isBlockTreeEnabled,
    isOffsetReplaceable,
    isRestrictInlineActive,
    isValidDocTitle,
    matchPassesRestrictInline,
    matchTextUnits,
    matchTextUnitsDetailed,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeRestrictInlineTypes,
    normalizeSearchStateEvent,
    parseDataTypeTokens,
    plainTextFromInlineMemoContent,
    rangeRestrictTokens,
    sanitizeDocTitle,
    sanitizeInlineMemoContentForWrite,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    shouldEnumerateRestrictInline,
    toggleRestrictInlineType,
} from "../src/shared";
import type {RegexPrefilterAtom} from "../src/shared/regex-literals";
import {preserveReplacementCase} from "../src/frontend/preserve-case";

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(message);
    }
}

const variants = generateSearchVariants("  foo\u200B  ");
assert(variants.includes("  foo\u200B  "), "keeps original");
assert(variants.includes("foo\u200B"), "trims");
assert(variants.some((v) => !/[\u200B-\u200D\u2060\uFEFF]/.test(v)), "has no-zw variant");
assert(generateSearchVariants("\u200B").length === 0, "marker-only query has no variants");
assert(generateSearchVariants("\u2060").length === 0, "word-joiner-only query has no variants");
assert(findOffsetMatchesInText("abc", "\u200B").length === 0, "marker-only query returns immediately");

const tightVariants = generateSearchVariants("a b", false);
assert(tightVariants.includes("a b"), "tight keeps spaced");
assert(!tightVariants.includes("ab"), "tight skips no-whitespace variant");

const zwText = "hello\u200Bworld";
const matches = findOffsetMatchesInText(zwText.toLowerCase(), "helloworld");
assert(matches.length >= 1, "finds zero-width-spanning match");
const tagText = "\u200b#tag#\u200b";
const tagMatches = findOffsetMatchesInText(tagText, "tag");
assert(tagMatches.length === 1, `inline tag with boundary zero-width counts once, got ${tagMatches.length}`);
const twoTags = "\u200btag\u200b and \u200btag\u200b";
assert(
    findOffsetMatchesInText(twoTags, "tag").length === 2,
    "two inline tags still count separately",
);
assert(
    matches.some((m) => m.startIndex === 0 && m.endIndex === zwText.length),
    "maps to original span",
);
const wordJoinerText = "hello\u2060world";
const wordJoinerMatches = findOffsetMatchesInText(wordJoinerText, "helloworld");
assert(
    wordJoinerMatches.length === 1
    && wordJoinerMatches[0].startIndex === 0
    && wordJoinerMatches[0].endIndex === wordJoinerText.length,
    "v3.8.6 word joiner maps back to the original span",
);

const ancestorLinks = new Map([
    ["quote", {parentId: "root", type: "b", subtype: "", ial: ""}],
    ["list", {parentId: "quote", type: "l", subtype: "t", ial: ""}],
    ["item", {parentId: "list", type: "i", subtype: "t", ial: ""}],
    ["leaf", {parentId: "item", type: "p", subtype: "", ial: ""}],
]);
assert(
    !isBlockTreeEnabled("leaf", ancestorLinks, {includeBlockquote: false}),
    "cold leaf follows disabled blockquote ancestor",
);
assert(
    !isBlockTreeEnabled("leaf", ancestorLinks, {includeListTask: false}),
    "cold leaf follows disabled task-list ancestor",
);
assert(
    isBlockTreeEnabled("leaf", ancestorLinks, {includeBlockquote: true, includeListTask: true}),
    "cold leaf stays enabled when all ancestors are enabled",
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

const orthogonalUnits = [{
    blockId: "orthogonal",
    blockType: "p",
    blockIndex: 0,
    text: "a b ab a\u200Bb",
    segmentLengths: [12],
}];
const sensitiveLoose = matchTextUnits(orthogonalUnits, "a b", {caseSensitive: true});
assert(sensitiveLoose.length === 3, `caseSensitive keeps loose variants, got ${sensitiveLoose.length}`);
const wholeLoose = matchTextUnits(orthogonalUnits, "a b", {wholeWord: true});
assert(wholeLoose.length === 3, `wholeWord keeps loose variants, got ${wholeLoose.length}`);

const unicodeOffset = matchTextUnits(
    [{blockId: "unicode", blockType: "p", blockIndex: 0, text: "İx", segmentLengths: [2]}],
    "x",
);
assert(
    unicodeOffset.length === 1
    && unicodeOffset[0].start === 1
    && unicodeOffset[0].end === 2
    && unicodeOffset[0].matchedText === "x",
    "case folding keeps original UTF-16 offsets",
);

const wordUnits = [{
    blockId: "w1",
    blockType: "p",
    blockIndex: 0,
    text: "cat cats catalog",
    segmentLengths: [16],
}];
const whole = matchTextUnits(wordUnits, "cat", {wholeWord: true});
assert(whole.length === 1 && whole[0].start === 0, `wholeWord: expected 1 at start, got ${whole.length}`);

const cjkUnits = [{
    blockId: "w2",
    blockType: "p",
    blockIndex: 0,
    text: "中国 中",
    segmentLengths: [4],
}];
const cjkOpen = matchTextUnits(cjkUnits, "中");
assert(cjkOpen.length === 2, `wholeWord off keeps both 中, got ${cjkOpen.length}`);
const cjkWhole = matchTextUnits(cjkUnits, "中", {wholeWord: true});
assert(cjkWhole.length === 1 && cjkWhole[0].start === 3, `wholeWord CJK boundary, got ${cjkWhole.length}`);

const accentWhole = matchTextUnits(
    [{blockId: "w3", blockType: "p", blockIndex: 0, text: "café caf", segmentLengths: [8]}],
    "caf",
    {wholeWord: true},
);
assert(accentWhole.length === 1 && accentWhole[0].start === 5, `wholeWord accent, got ${accentWhole.length}`);

const hyphenWhole = matchTextUnits(
    [{blockId: "w4", blockType: "p", blockIndex: 0, text: "hello-world", segmentLengths: [11]}],
    "hello",
    {wholeWord: true},
);
assert(hyphenWhole.length === 1 && hyphenWhole[0].start === 0, `wholeWord hyphen separator, got ${hyphenWhole.length}`);

const underscoreWhole = matchTextUnits(
    [{blockId: "w5", blockType: "p", blockIndex: 0, text: "foo_bar foo", segmentLengths: [11]}],
    "foo",
    {wholeWord: true},
);
assert(underscoreWhole.length === 1 && underscoreWhole[0].start === 8, `wholeWord underscore stays inside the word, got ${underscoreWhole.length}`);

const zeroWidthWhole = matchTextUnits(
    [{blockId: "w6", blockType: "p", blockIndex: 0, text: "\u200bcat", segmentLengths: [4]}],
    "cat",
    {wholeWord: true},
);
assert(zeroWidthWhole.length === 1 && zeroWidthWhole[0].start === 1, `wholeWord ignores adjacent zero-width, got ${zeroWidthWhole.length}`);

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

function atomLabel(atom: RegexPrefilterAtom): string {
    if (atom.kind === "lit") {
        return atom.text;
    }
    return atom.kind === "digit" ? "#d" : "#w";
}
function literalKey(groups: RegexPrefilterAtom[][] | null): string {
    if (!groups) {
        return "none";
    }
    return groups.map((group) => group.map(atomLabel).slice().sort().join("+")).sort().join("|");
}
const lit = (text: string): RegexPrefilterAtom => ({kind: "lit", text});
const digit: RegexPrefilterAtom = {kind: "digit"};
const word: RegexPrefilterAtom = {kind: "word"};
function assertLiterals(pattern: string, expected: RegexPrefilterAtom[][] | null, caseSensitive = true) {
    const actual = extractRegexLiteralGroups(pattern, caseSensitive);
    assert(
        literalKey(actual) === literalKey(expected),
        `regex literals ${pattern}: expected ${literalKey(expected)}, got ${literalKey(actual)}`,
    );
}
assertLiterals("foo", [[lit("foo")]]);
assertLiterals("foo.*bar", [[lit("foo"), lit("bar")]]);
assertLiterals("foo|bar", [[lit("foo")], [lit("bar")]]);
assertLiterals("https?://", [[lit("http"), lit("://")]]);
assertLiterals("\\d+", [[digit]]);
assertLiterals("foo|\\d+", [[lit("foo")], [digit]]);
assertLiterals("中\\d+", [[lit("中"), digit]]);
assertLiterals("a\\d+", [[digit]]);
assertLiterals("(foo|bar)baz", [[lit("foo"), lit("baz")], [lit("bar"), lit("baz")]]);
assertLiterals("(?:foo){2}", [[lit("foofoo")]]);
assertLiterals("^foo$", [[lit("foo")]]);
assertLiterals("(?=foo)bar", [[lit("bar")]]);
assertLiterals("[0-9]+", [[digit]]);
assertLiterals("[0-9a]+", null);
assertLiterals("[a0-9]", null);
assertLiterals("[\\d.]", null);
assertLiterals("[a]", null);
assertLiterals("\\w+", [[word]]);
assertLiterals(".*", null);
assertLiterals("foo|.*", null);
assertLiterals("colou?r", [[lit("colo")]]);
assertLiterals("ab?", null);
assertLiterals("École", [[lit("École")]]);
assertLiterals("École", null, false);
assertLiterals("fooÉ", null, false);
assertLiterals("中文", [[lit("中文")]], false);
assertLiterals("foo", [[lit("foo")]], false);
assert(!regexPrefilterStoresPlainCache([[digit]]), "digit-only prefilter does not fill the plain cache");
assert(!regexPrefilterStoresPlainCache([[lit("foo")], [digit]]), "a digit branch does not fill the plain cache");
assert(regexPrefilterStoresPlainCache([[lit("中"), digit]]), "a literal plus digit may use the plain cache");

const shownCell = collectAvDomCoverage([{
    blockId: "db",
    blockType: "NodeAttributeView",
    unitId: "cell:nogroup:row1:col1",
    text: "已显示",
}]);
const shown = shownCell.get("db");
assert(Boolean(shown), "av coverage exists");
const usedRows = new Set<string>();
assert(
    shown ? avApiUnitShown("av:row1:col1", "已显示", shown, usedRows) : false,
    "visible cell is not added again from the api",
);
assert(
    shown ? !avApiUnitShown("av:row2:col1", "未挂载", shown, usedRows) : true,
    "unmounted row is kept",
);
assert(
    shown ? avApiUnitInView("av:row2:col1", shown, "table") : false,
    "unmounted row of a visible column stays in a table view",
);
assert(
    shown ? !avApiUnitInView("av:row2:colHidden", shown, "list") : true,
    "list view does not add a column that is not on screen",
);
assert(
    shown ? !avApiUnitInView("av:row1:colHidden", shown, "calendar") : true,
    "calendar view does not add a field that is not on the card",
);
const unstable = collectAvDomCoverage([{
    blockId: "db",
    blockType: "NodeAttributeView",
    unitId: "cell:nogroup:norow:idx-0",
    text: "无 id",
}]).get("db");
assert(
    unstable ? avApiUnitShown("av:row9:col9", "别处", unstable, new Set<string>()) : false,
    "unstable visible cell blocks the api merge",
);

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

// --- HTML block unit never replaceable ---
const htmlUnit = {
    blockId: "html1",
    blockType: "NodeHTMLBlock",
    blockIndex: 0,
    text: "hello html",
    unitId: "html-block-rendered",
    segmentLengths: [10],
};
assert(!isHitReplaceableByUnit(htmlUnit, 0, 5), "HTML block unit not replaceable");
const htmlHits = matchTextUnits([htmlUnit], "hello");
assert(htmlHits.length === 1 && htmlHits[0].replaceable === false, "HTML hit replaceable=false");
assert(DEFAULT_PREFS.includeHtmlBlock === true, "includeHtmlBlock defaults on");
assert(coercePluginPrefs({}).includeHtmlBlock === true, "coerce includeHtmlBlock default on");
assert(coercePluginPrefs({includeHtmlBlock: false}).includeHtmlBlock === false, "coerce includeHtmlBlock off");
assert(DEFAULT_PREFS.includeDocTitle === true, "includeDocTitle defaults on");
assert(DEFAULT_PREFS.includeImageTitle === true, "includeImageTitle defaults on");
assert(coercePluginPrefs({}).includeDocTitle === true, "coerce includeDocTitle default on");
assert(coercePluginPrefs({}).includeImageTitle === true, "coerce includeImageTitle default on");
assert(coercePluginPrefs({includeDocTitle: false}).includeDocTitle === false, "coerce includeDocTitle off");
assert(coercePluginPrefs({includeImageTitle: false}).includeImageTitle === false, "coerce includeImageTitle off");
assert(
    mergePrefs(DEFAULT_PREFS, {includeDocTitle: false}).includeDocTitle === false,
    "merge includeDocTitle off",
);
assert(
    mergePrefs(DEFAULT_PREFS, {includeImageTitle: false}).includeImageTitle === false,
    "merge includeImageTitle off",
);
assert(DEFAULT_PREFS.includeListUnordered === true, "includeListUnordered defaults on");
assert(DEFAULT_PREFS.includeListOrdered === true, "includeListOrdered defaults on");
assert(DEFAULT_PREFS.includeListTask === true, "includeListTask defaults on");
assert(coercePluginPrefs({}).includeListUnordered === true, "coerce includeListUnordered default on");
assert(coercePluginPrefs({includeListUnordered: false}).includeListUnordered === false, "coerce includeListUnordered off");
assert(
    mergePrefs(DEFAULT_PREFS, {
        includeListUnordered: false,
        includeListOrdered: false,
        includeListTask: false,
    }).includeListTask === false,
    "merge list includes all off",
);
assert(DEFAULT_PREFS.includeHeadingH1 === true, "includeHeadingH1 defaults on");
assert(DEFAULT_PREFS.includeHeadingH6 === true, "includeHeadingH6 defaults on");
assert(coercePluginPrefs({}).includeHeadingH2 === true, "coerce includeHeadingH2 default on");
assert(coercePluginPrefs({includeHeadingH3: false}).includeHeadingH3 === false, "coerce includeHeadingH3 off");
assert(
    mergePrefs(DEFAULT_PREFS, {
        includeHeadingH1: false,
        includeHeadingH2: false,
        includeHeadingH3: false,
        includeHeadingH4: false,
        includeHeadingH5: false,
        includeHeadingH6: false,
    }).includeHeadingH6 === false,
    "merge heading includes all off",
);
assert(DEFAULT_PREFS.includeSuperBlock === true, "includeSuperBlock defaults on");
assert(coercePluginPrefs({}).includeSuperBlock === true, "coerce includeSuperBlock default on");
assert(coercePluginPrefs({includeSuperBlock: false}).includeSuperBlock === false, "coerce includeSuperBlock off");
assert(
    mergePrefs(DEFAULT_PREFS, {includeSuperBlock: false}).includeSuperBlock === false,
    "merge includeSuperBlock off",
);
assert(DEFAULT_PREFS.includeParagraph === true, "includeParagraph defaults on");
assert(coercePluginPrefs({}).includeParagraph === true, "coerce includeParagraph default on");
assert(coercePluginPrefs({includeParagraph: false}).includeParagraph === false, "coerce includeParagraph off");
assert(
    mergePrefs(DEFAULT_PREFS, {includeParagraph: false}).includeParagraph === false,
    "merge includeParagraph off",
);
assert(DEFAULT_PREFS.useRegex === false, "useRegex defaults off (keyword)");
assert(coercePluginPrefs({}).useRegex === false, "coerce useRegex default off");
assert(coercePluginPrefs({useRegex: true}).useRegex === true, "coerce useRegex on");
assert(
    mergePrefs(DEFAULT_PREFS, {useRegex: true}).useRegex === true,
    "merge prefs useRegex",
);

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
assert(formatSearchCountLabel(1, 10) === "1/10", "count label");
assert(formatSearchCountLabel(3, 1000) === "3/1000", "count above 999 shows full total");
assert(formatSearchCountLabel(1200, 1500) === "1200/1500", "full count for large results");

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

const dateHaystack = "date 2024-01-02 end";
assert(
    expandRegexReplacement({
        haystack: dateHaystack,
        start: 5,
        end: 15,
        patternSource: "(\\d{4})-(\\d{2})-(\\d{2})",
        template: "$2/$3/$1",
    }) === "01/02/2024",
    "regex replace capture groups",
);
assert(
    expandRegexReplacement({
        haystack: "ab",
        start: 0,
        end: 2,
        patternSource: "(a)(b)",
        template: "$$ $& $1",
    }) === "$ ab a",
    "regex replace $$ and $&",
);
assert(
    expandRegexReplacement({
        haystack: "x一y",
        start: 0,
        end: 3,
        patternSource: "([^一])一([^一])",
        template: "$1-$2",
    }) === "x-y",
    "regex replace like official sample",
);
assert(
    expandRegexReplacement({
        haystack: "pre foobar post",
        start: 4,
        end: 7,
        patternSource: "(?<=pre )foo(?=bar)",
        template: "FOO",
    }) === "FOO",
    "regex replace keeps lookaround via haystack exec",
);
assert(
    expandRegexReplacement({
        haystack: "abc",
        start: 0,
        end: 3,
        patternSource: "no-match-here",
        template: "$1",
    }) === null,
    "regex expand failure returns null (skip, do not write literal $1)",
);
assert(
    expandRegexReplacement({
        haystack: "ab",
        start: 0,
        end: 2,
        patternSource: "",
        template: "$1",
    }) === null,
    "empty pattern expand returns null",
);

// 用户场景：中文引号捕获组 → 【$1】
assert(
    expandRegexReplacement({
        haystack: "「思源笔记」",
        start: 0,
        end: 6,
        patternSource: "「([^」]*)」",
        template: "【$1】",
    }) === "【思源笔记】",
    "CJK quote capture $1 => 【思源笔记】",
);
assert(
    expandRegexReplacement({
        haystack: "「111」",
        start: 0,
        end: 5,
        patternSource: "「([^」]*)」",
        template: "【$1】",
    }) === "【111】",
    "CJK quote capture $1 => 【111】",
);
assert(
    expandRegexReplacement({
        haystack: "前「test」后",
        start: 1,
        end: 7,
        patternSource: "「([^」]*)」",
        template: "【$1】",
    }) === "【test】",
    "CJK quote capture $1 mid-string => 【test】",
);
// 无捕获组时保留字面 $1（对齐 JS）；与「组存在但匹配空」的【】区分开
assert(
    expandRegexReplacement({
        haystack: "「思源笔记」",
        start: 0,
        end: 6,
        patternSource: "「[^」]*」",
        template: "【$1】",
    }) === "【$1】",
    "no capturing group => keep literal $1",
);
assert(
    expandRegexReplacement({
        haystack: "「」",
        start: 0,
        end: 2,
        patternSource: "「([^」]*)」",
        template: "【$1】",
    }) === "【】",
    "capturing group matched empty => 【】",
);

assert(sanitizeDocTitle("a/b") === "a／b", "sanitize title slash");
assert(sanitizeDocTitle("a\nb") === "ab", "sanitize title newline");
assert(sanitizeDocTitle("") === "", "sanitize keeps empty string for renameDoc");
assert(isValidDocTitle("ok"), "valid title");
assert(isValidDocTitle(""), "empty title is valid for API");
assert(!isValidDocTitle("bad\n"), "invalid title newline");

// --- 行内备注属性纯文本（替换坐标系）---
assert(plainTextFromInlineMemoContent("plain memo") === "plain memo", "memo plain passthrough");
assert(plainTextFromInlineMemoContent("a <b>x</b> c") === "a x c", "memo strips tags");
assert(plainTextFromInlineMemoContent("") === "", "memo empty");
assert(sanitizeInlineMemoContentForWrite("keep") === "keep", "memo sanitize noop without DOMPurify");

assert(tableCellPosition("table-cell:1:2") === "1:2", "table cell position without node id");
assert(tableCellPosition("table-cell:1:2:abc") === "1:2", "table cell position ignores node id");
assert(tableCellNodeId("table-cell:1:2:abc") === "abc", "table cell id");
assert(tableCellNodeId("table-cell:1:2") === "", "table cell without id");
assert(tableCellNodeId("table-cell:1:2:a:b") === "a:b", "table cell id may contain colons");
assert(countVirtualTableRows("<tr><td>a</td></tr><tr><td>b</td></tr>") === 2, "count omitted rows");
assert(countVirtualTableRows("<tr><td>&lt;tr</td></tr>") === 1, "escaped tr in a cell is not a row");
assert(countVirtualTableRows("") === 0, "empty placeholder has no rows");
assert(countVirtualTableRows("<TR><td></td></TR>") === 1, "uppercase row tag still counts");

const tableRow = (virtualHtml: string | null) => ({
    getAttribute(name: string) {
        return name === "data-sy-table-virtual-rows" ? virtualHtml : null;
    },
});
const logicalRows = logicalTableRows([
    tableRow(null),
    tableRow("<tr><td>a</td></tr><tr><td>b</td></tr>"),
    tableRow(null),
]);
assert(logicalRows.stable, "placeholder with two rows stays countable");
assert(logicalRows.rows.length === 3, "logical layout keeps every dom row");
assert(logicalRows.rows[0].logical === 0 && logicalRows.rows[0].omitted === 0, "first mounted row is logical 0");
assert(logicalRows.rows[1].logical === 1 && logicalRows.rows[1].omitted === 2, "placeholder covers the next two logical rows");
assert(logicalRows.rows[2].logical === 3 && logicalRows.rows[2].omitted === 0, "row after a placeholder keeps the full-table index");
assert(logicalRowOffset(logicalRows.rows, 2) === 1, "a hidden row maps onto its placeholder");
assert(logicalRowOffset(logicalRows.rows, 3) === 2, "a mounted row maps onto itself");
assert(logicalRowOffset(logicalRows.rows, 4) === -1, "a row past the table is not invented");
const brokenRows = logicalTableRows([tableRow(null), tableRow("")]);
assert(!brokenRows.stable && brokenRows.rows.length === 1, "an unreadable placeholder stops the count");
assert(brokenRows.rows[0].logical === 0, "rows before the bad placeholder keep their index");

const looseProbe = createTextMatchProbe("ab", {});
assert(looseProbe("a\u200bb"), "probe sees a match across a zero-width char");
assert(!looseProbe("zz"), "probe rejects a miss");
const spacedProbe = createTextMatchProbe("foo bar", {});
assert(spacedProbe("foobar"), "probe keeps the no-whitespace variant");
assert(spacedProbe("foo bar"), "probe keeps the original keyword");
const wholeProbe = createTextMatchProbe("cat", {wholeWord: true});
assert(wholeProbe("catalog"), "whole-word probe may over-include");
assert(
    findOffsetMatchesInText("catalog", "cat", {wholeWord: true}).length === 0,
    "whole-word matcher still rejects catalog",
);

const tableCell = (unitId: string, text: string) => ({
    blockId: "t",
    blockType: "NodeTable",
    unitId,
    text,
});
const kernelCellA = tableCell("table-cell:0:0", "旧");
const kernelCellB = tableCell("table-cell:0:1", "保持");
const liveCellA = tableCell("table-cell:4:0", "新");
const liveCellB = tableCell("table-cell:4:1", "保\u200b持");
const liveCellE = tableCell("table-cell:8:0", "刚输入");
const tableMerged = mergeVirtualTableUnits(
    [
        kernelCellA,
        {blockId: "p", blockType: "NodeParagraph", text: "段落"},
        kernelCellB,
        tableCell("table-cell:1:0", "将被清空"),
        tableCell("table-cell:9:0", "屏外"),
    ],
    new Map([["t", {
        shownKeys: new Set(["0:0", "0:1", "1:0", "5:0"]),
        liveByKey: new Map([
            ["0:0", liveCellA],
            ["0:1", liveCellB],
            ["5:0", liveCellE],
        ]),
        unstable: false,
    }]]),
);
const tableTexts = tableMerged.units.map((unit) => unit.text);
assert(tableTexts.indexOf("新") >= 0, "edited virtual cell uses the live text");
assert(tableTexts.indexOf("旧") < 0, "edited virtual cell drops the kernel text");
assert(tableMerged.units.indexOf(kernelCellB) >= 0, "unchanged virtual cell keeps the kernel unit");
assert(tableTexts.indexOf("将被清空") < 0, "cleared virtual cell drops the kernel text");
assert(tableTexts.indexOf("屏外") >= 0, "unmounted virtual row stays on the kernel text");
assert(tableTexts.indexOf("刚输入") >= 0, "new virtual cell text is searchable before commit");
assert(tableTexts.indexOf("段落") >= 0, "virtual table merge keeps other blocks");
assert(tableMerged.staleKeys.has("t\u0000table-cell:4:0"), "edited virtual cell is not replaceable from the old html");
assert(!tableMerged.staleKeys.has("t\u0000table-cell:0:1"), "unchanged virtual cell stays replaceable");
assert(tableMerged.staleKeys.has("t\u0000table-cell:8:0"), "cell missing from the kernel is not replaceable yet");

const unstableTable = mergeVirtualTableUnits(
    [tableCell("not-a-cell", "无位置"), tableCell("table-cell:0:0", "有")],
    new Map([["t", {
        shownKeys: new Set(["0:0"]),
        liveByKey: new Map([["0:0", tableCell("table-cell:3:0", "改")]]),
        unstable: false,
    }]]),
);
assert(unstableTable.units.map((unit) => unit.text).indexOf("改") < 0, "a cell without a row and column keeps the kernel text");
assert(unstableTable.staleKeys.size === 0, "kernel-only table does not mark cells stale");

const memoTable = mergeVirtualTableUnits(
    [
        tableCell("table-cell:0:0", "旧"),
        {blockId: "t", blockType: "NodeTable", unitId: "table-memo:0:0:1", text: "备注"},
        {blockId: "t", blockType: "NodeTable", unitId: "inline-math:0", text: "公式"},
    ],
    new Map([["t", {
        shownKeys: new Set(["0:0"]),
        liveByKey: new Map([["0:0", tableCell("table-cell:0:0", "新")]]),
        unstable: false,
    }]]),
);
assert(memoTable.units.map((unit) => unit.text).indexOf("新") >= 0, "a memo in the table still uses the live cell text");
assert(memoTable.units.map((unit) => unit.text).indexOf("备注") >= 0, "table memo stays searchable");
assert(memoTable.staleKeys.has("t\u0000table-cell:0:0"), "edited cell stays non-replaceable when the table also has a memo");

console.log("smoke:shared OK (match + restrict + selection + preserve-case + regex-replace + doc-title + inline-memo)");
