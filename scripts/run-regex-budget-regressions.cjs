// Direct-source resource/semantic checks; packaged Worker and write-path checks live in their existing suites.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    fileName: file,
}).outputText, file);
const source = name => require(path.join(__dirname, "../src/shared", name + ".ts"));
const {expandRegexReplacementUnits: expand} = source("regex-replace");
const {matchTextUnitsDetailed: search} = source("match-text");
const {createRegexBudget, consumeRegexBudget, RegexBudgetExceeded} = source("regex-budget");
const unit = text => ({blockId: "b", blockType: "NodeParagraph", blockIndex: 0, text, segmentLengths: [text.length]});
const limits = (remainingResults, remainingBytes) => ({remainingResults, remainingBytes});

// Native String.replace is the oracle, including unsupported numeric groups and unmatched branches.
for (const pattern of ["(a)|(b)", "(?<known>a)|(?<other>b)", "(?<=x)(a)", "^a|b$"]) {
    for (const text of ["a b", "xa b", "a😀b"]) {
        const hits = search([unit(text)], pattern, {regex: true}).hits;
        const templates = ["plain", "", "$$", "$&", "$`", "$'", "$01|$00|$12|$100|$99",
            "$<known>|$<other>|$<missing>|$<>|$<missing$1>|$<unclosed$1"];
        for (const template of templates) {
            const request = [{id: "u", haystack: text, replacements: hits}];
            const results = expand(request, pattern, template, {}, createRegexBudget());
            let output = "", cursor = 0;
            for (let i = 0; i < hits.length; i++) {
                output += text.slice(cursor, hits[i].start) + results[i].replacement;
                cursor = hits[i].end;
            }
            output += text.slice(cursor);
            assert.equal(output, text.replace(new RegExp(pattern, "gi"), template));
        }
    }
}

// One RegExp per unit, with deliberately unordered offsets and an intervening failed exec.
const NativeRegExp = global.RegExp;
let creations = 0;
global.RegExp = class extends NativeRegExp {
    constructor(...args) {super(...args); creations++;}
};
try {
    const requests = ["ab ab", "ab"].map((haystack, index) => ({id: String(index), haystack,
        replacements: index === 0 ? [
            {id: "late", start: 3, end: 5}, {id: "invalid", start: 2, end: 3}, {id: "early", start: 0, end: 2},
        ] : [{id: "other", start: 0, end: 2}],
    }));
    assert.deepEqual(expand(requests, "(a)(b)", "$2$1", {}).map(x => x.replacement), ["ba", null, "ba", "ba"]);
    assert.equal(creations, 2);
} finally {global.RegExp = NativeRegExp;}

const single = [{id: "u", haystack: "a", replacements: [{id: "h", start: 0, end: 1, matchedText: "a"}]}];
assert.equal(expand(single, "a", "😀", {}, limits(1, 6))[0].replacement, "😀", "UTF-16 byte boundary includes ID");
assert.throws(() => expand(single, "a", "😀", {}, limits(1, 5)), RegexBudgetExceeded);
assert.throws(() => expand(single, "a", "x", {}, limits(0, 100)), RegexBudgetExceeded);
for (const template of ["literal", "$'", "$`", "$&$&$&", "$1$1$1"]) {
    const originalReplace = String.prototype.replace;
    let allocations = 0;
    String.prototype.replace = function(...args) {
        if (String(this) === template) allocations++;
        return originalReplace.apply(this, args);
    };
    try {
        assert.throws(() => expand([{id: "u", haystack: "prefix a suffix",
            replacements: [{id: "h", start: 7, end: 8, matchedText: "a"}]}],
        "(a)", template, {}, limits(10, 2)), RegexBudgetExceeded);
        assert.equal(allocations, 0, "oversized substitution fails before String.replace builds its output");
    } finally {String.prototype.replace = originalReplace;}
}
assert.throws(() => search([unit("aaaa")], "a", {regex: true}, limits(3, 10000)), RegexBudgetExceeded);
assert.throws(() => search([unit("aaaa")], ".+", {regex: true}, limits(10, 6)), RegexBudgetExceeded);
assert.equal(search([unit("aaaa")], "a", {}, limits(0, 0)).hits.length, 4, "literal behavior remains unbounded here");
const cumulative = limits(2, 8);
expand(single, "a", "x", {}, cumulative);
expand(single, "a", "x", {}, cumulative);
assert.deepEqual(cumulative, limits(0, 0));
assert.throws(() => consumeRegexBudget(cumulative, 0, 1), RegexBudgetExceeded);
console.log("regex budget regressions OK (native templates, per-unit reuse, pre-allocation limits, cumulative and literal isolation)");
