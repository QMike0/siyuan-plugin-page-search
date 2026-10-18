// Direct-source DOM/transaction contracts; no real notebook writes or host keyboard E2E.
// Optional: node scripts/run-reference-replacement-regressions.cjs /path/to/siyuan/lute.min.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let editors = [];
let api = async () => ({code: 0, data: []});
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {getAllEditor: () => editors, fetchSyncPost: (...args) => api(...args)};
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    const code = fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"');
    mod._compile(
        ts.transpileModule(code, {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
            fileName: file,
        }).outputText,
        file,
    );
};
const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = dom.window;
global.document = window.document;
for (
    const key of [
        "Node",
        "Element",
        "HTMLElement",
        "HTMLImageElement",
        "Text",
        "NodeFilter",
        "ShadowRoot",
        "MutationObserver",
        "Range",
        "HTMLTableElement",
        "HTMLTableRowElement",
        "HTMLTableCellElement",
    ]
) global[key] = window[key];
global.CSS = {escape: (value) => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() {
        return this.textContent;
    },
    configurable: true,
});
const source = (file) => require(path.join(repo, "src", file + ".ts"));
const replacement = source("frontend/replacement");
const blocks = source("frontend/blocks");
const matcher = source("shared/match-text");
const write = source("frontend/protyle-write");
const blockId = "20261013120000-abcdefg";
const targetId = "20261012120000-hijklmn";
const otherId = "20261012120000-opqrstu";
const refSelector = 'span[data-type~="block-ref"]';
const isMemoMatch = match => match.unitId?.startsWith("inline-memo:") === true;
const ref = (text = "foo tail", subtype = "d", types = "strong em block-ref", id = targetId) =>
    `<span data-type="${types}" data-subtype="${subtype}" data-id="${id}" style="color: var(--b3-font-color1);"${
        types.split(" ").includes("inline-memo") ? ' data-inline-memo-content="memo foo"' : ""
    }>${text}</span>`;

function fixture(content) {
    document.body.innerHTML = "";
    const edit = document.createElement("div");
    edit.className = "protyle";
    edit.innerHTML =
        `<div class="protyle-content"><div class="protyle-wysiwyg"><div data-node-id="${blockId}" data-type="NodeParagraph"><div contenteditable="true">${content}</div><div class="protyle-attr"></div></div></div></div>`;
    document.body.append(edit);
    return {edit, block: edit.querySelector("[data-node-id]"), wysiwyg: edit.querySelector(".protyle-wysiwyg")};
}
function collect(f, query = "foo") {
    const units = blocks.collectSearchableBlocks(f.edit, {
        includeDocTitle: false,
        includeInlineMemo: true,
        includeImageTitle: true,
    });
    const unitsByKey = new Map(units.map(unit => [`${unit.blockId}::${unit.unitId ?? ""}`, unit]));
    const matches = matcher.matchTextUnitsDetailed(
        units.map(unit => ({...unit, segmentLengths: unit.textNodes.map(node => node.length)})),
        query,
    ).hits;
    return {unitsByKey, matches};
}
function apply(f, clone, text, options = {}, filter = () => true, query = "foo") {
    const {unitsByKey, matches} = collect(f, query);
    const selected = matches.filter(filter);
    assert.ok(selected.length, "fixture must have a selected match");
    const target = clone ? f.block.cloneNode(true) : f.block;
    const outcome = clone ?
        replacement.applyMatchesToSubmitClone(f.block, target, unitsByKey, selected, text, options) :
        replacement.applyMatchesToLiveUnits(unitsByKey, selected, text, options);
    return {target, outcome};
}
const attributes = element => Object.fromEntries(Array.from(element.attributes, attr => [attr.name, attr.value]));
function assertRef(element, text, subtype, before) {
    assert.equal(element.textContent, text);
    assert.equal(element.getAttribute("data-subtype"), subtype);
    if (before) assert.deepEqual(attributes(element), {...before, "data-subtype": subtype});
}
function parse(html) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder;
}

let lute;
if (process.argv[2]) {
    // Lute exposes a global rather than CommonJS exports. Run with the actual host runtime.
    require(path.resolve(process.argv[2]));
    lute = (window.Lute ?? global.Lute).New();
    lute.SetTextMark(true);
    lute.SetBlockRef(true);
    lute.SetKramdownIAL(true);
    lute.SetProtyleWYSIWYG(true);
    lute.SetHTMLTag2TextMark(true);
}
function roundtrip(html, text, subtype) {
    if (!lute) return;
    const expected = parse(html).querySelector(refSelector);
    for (let repeat = 0; repeat < 2; repeat++) {
        html = lute.SpinBlockDOM(html);
        const actual = parse(html).querySelector(refSelector);
        assertRef(actual, text, subtype);
        for (const name of ["data-type", "data-id", "style", "data-inline-memo-content"]) {
            assert.equal(actual.getAttribute(name), expected.getAttribute(name), "native roundtrip preserves " + name);
        }
    }
}

async function main() {
    for (const clone of [false, true]) {
        for (const types of ["block-ref", "strong em block-ref", "block-ref strong inline-memo"]) {
            const f = fixture(ref("foo tail", "d", types) + " foo " + ref("unmatched", "d", "block-ref", otherId));
            const oldHTML = f.block.outerHTML;
            const before = attributes(f.block.querySelector(refSelector));
            const {target, outcome} = apply(f, clone, "自定义", {}, match => !isMemoMatch(match));
            assert.equal(outcome.appliedCount, 2);
            assertRef(target.querySelector(refSelector), "自定义 tail", "s", before);
            assertRef(target.querySelector(`[data-id="${otherId}"]`), "unmatched", "d");
            if (clone) assert.equal(f.block.outerHTML, oldHTML, "clone preparation leaves the live DOM intact");
            roundtrip(target.outerHTML, "自定义 tail", "s");
        }
        const many = fixture(ref("foo foo"));
        assertRef(apply(many, clone, "bar").target.querySelector(refSelector), "bar bar", "s");
        const empty = fixture(ref("foo tail"));
        assertRef(apply(empty, clone, "").target.querySelector(refSelector), " tail", "s");
        const deleted = fixture(ref("foo"));
        const deletedTarget = apply(deleted, clone, "").target;
        assertRef(deletedTarget.querySelector(refSelector), "", "s");
        if (lute) {
            assert.equal(
                parse(lute.SpinBlockDOM(deletedTarget.outerHTML)).querySelector(refSelector),
                null,
                "native normalization removes a fully deleted anchor, without leaving an ID as anchor text",
            );
        }
        for (
            const [text, options, original] of [
                ["foo", {}, "foo"],
                ["$&", {regex: true, searchQuery: "foo"}, "foo"],
                ["FOO", {preserveCase: true}, "foo"],
                ["foo", {preserveCase: true}, "FOO"],
            ]
        ) {
            const f = fixture(ref(original));
            const oldHTML = f.block.outerHTML;
            const {target, outcome} = apply(f, clone, text, options);
            assert.equal(outcome.appliedCount, 1, "no-op retains existing successful-match counting");
            assert.equal(target.outerHTML, oldHTML, "effective no-op does not freeze a dynamic reference");
        }
        const regex = fixture(ref("foo"));
        assertRef(
            apply(regex, clone, "$1-bar", {regex: true, searchQuery: "(foo)"}).target.querySelector(refSelector),
            "foo-bar",
            "s",
        );
        const planned = fixture(ref("foo"));
        const plannedMatch = collect(planned).matches[0];
        const regexPlan = replacement.createRegexReplacementPlan([
            {id: plannedMatch.id, haystack: "foo", replacement: "bar"},
        ]);
        assertRef(apply(planned, clone, "$1", {regex: true, regexPlan}).target.querySelector(refSelector), "bar", "s");
        for (const [subtype, types] of [["s", "block-ref"], ["", "block-ref"], ["d", "strong"]]) {
            const f = fixture(ref("foo", subtype, types));
            const before = attributes(f.block.querySelector("span"));
            assertRef(apply(f, clone, "bar").target.querySelector("span"), "bar", subtype, before);
        }
        const noSubtype = fixture(ref("foo").replace(' data-subtype="d"', ""));
        assert.equal(
            apply(noSubtype, clone, "bar").target.querySelector(refSelector).hasAttribute("data-subtype"),
            false,
        );
        const memo = fixture(ref("anchor", "d", "block-ref strong inline-memo"));
        const {target: memoTarget} = apply(memo, clone, "changed", {}, isMemoMatch);
        assertRef(memoTarget.querySelector(refSelector), "anchor", "d");
        assert.equal(memoTarget.querySelector(refSelector).getAttribute("data-inline-memo-content"), "memo changed");

        for (const text of ["bar", "foo"]) {
            const split = fixture(ref(""));
            split.block.querySelector(refSelector).append(
                document.createTextNode("fo"),
                document.createTextNode("o tail"),
            );
            const oldHTML = split.block.outerHTML;
            const {target, outcome} = apply(split, clone, text);
            assert.equal(outcome.appliedCount, 1, "split Text range remains replaceable");
            assertRef(target.querySelector(refSelector), text + " tail", text === "foo" ? "d" : "s");
            if (text === "foo") assert.equal(target.outerHTML, oldHTML);
        }
        for (
            const content of [
                ref("fo") + "o",
                ref("fo") + ref("o", "d", "block-ref", otherId),
                ref('fo<span data-type="strong">o</span>'),
            ]
        ) {
            const f = fixture(content);
            const before = f.block.outerHTML;
            for (const text of ["bar", "foo"]) {
                const {target, outcome} = apply(f, clone, text);
                assert.equal(outcome.appliedCount, 0, "cross-structure guard is retained, including no-op");
                assert.equal(target.outerHTML, before);
            }
        }
        const stale = fixture(ref("foo"));
        const {unitsByKey, matches} = collect(stale);
        stale.block.querySelector(refSelector).firstChild.nodeValue = "zoo";
        const target = clone ? stale.block.cloneNode(true) : stale.block;
        const outcome = clone ?
            replacement.applyMatchesToSubmitClone(stale.block, target, unitsByKey, matches, "bar") :
            replacement.applyMatchesToLiveUnits(unitsByKey, matches, "bar");
        assert.equal(outcome.appliedCount, 0);
        assertRef(target.querySelector(refSelector), "zoo", "d");
        const failedPlan = fixture(ref("foo"));
        const skipped = apply(failedPlan, clone, "bar", {regex: true, regexPlan: {expansions: new Map()}});
        assert.equal(skipped.outcome.regexExpandFailedCount, 1);
        assertRef(skipped.target.querySelector(refSelector), "foo", "d");
        const image = fixture(
            '<span class="img"><img title="foo"><span class="protyle-action__title"><span>foo</span></span></span>',
        );
        const imageResult = apply(image, clone, "bar");
        assert.equal(imageResult.target.querySelector("img").getAttribute("data-title"), "bar");
        assert.equal(imageResult.target.querySelector("img").getAttribute("title"), null);
    }
    console.log(
        "Dynamic-reference common-layer, composite marks, no-op, split Text, stale/structure, memo and image contracts OK",
    );

    // Verify the four public write routes preserve old d HTML and submit new s HTML.
    // Replaying payloads tests undo/redo data, not SiYuan's keyboard/history implementation.
    for (const fetched of [false, true]) {
        for (const all of [false, true]) {
            const f = fixture(ref("foo foo", "d", "strong block-ref inline-memo"));
            const oldHTML = f.block.outerHTML;
            const calls = [];
            let requests = 0;
            const protyle = {
                protyle: {element: f.edit, notebookId: "", block: {rootID: "r", id: "r"}, disabled: false, lute},
                transaction: (doOps, undoOps) => calls.push({doOps, undoOps}),
                updateTransactionElement: (element, before) =>
                    calls.push({
                        doOps: [{id: blockId, data: element.outerHTML, action: "update"}],
                        undoOps: [{id: blockId, data: before, action: "update"}],
                    }),
            };
            editors = [protyle];
            const matches = collect(f).matches.filter(match => !isMemoMatch(match));
            assert.equal(matches.length, 2);
            if (fetched) f.wysiwyg.innerHTML = "";
            api = async url => {
                requests++;
                if (url.endsWith("getBlockDOMs")) {
                    const submitted = calls.at(-1)?.doOps[0].data;
                    return {
                        code: 0,
                        data: {[blockId]: submitted ? (lute ? lute.SpinBlockDOM(submitted) : submitted) : oldHTML},
                    };
                }
                throw new Error("Unexpected extra API: " + url);
            };
            const result = all ?
                await write.replaceAllMatchesInEditor(f.edit, matches, "自定义") :
                await write.replaceCurrentMatchInEditor(f.edit, matches[0], "自定义");
            assert.equal(result.replacedCount, all ? 2 : 1);
            assert.equal(result.skippedCount, 0);
            assert.equal(result.commitState, "confirmed");
            assert.equal(calls.length, 1, "one original transaction, no extra reference transaction");
            assert.equal(requests, fetched ? 3 : 1, "one confirmation read; fetched paths also verify their base");
            const {doOps, undoOps} = calls[0];
            assert.equal(doOps.length, 1);
            assert.equal(undoOps.length, 1);
            assert.equal(undoOps[0].data, oldHTML);
            const newText = all ? "自定义 自定义" : "自定义 foo";
            for (
                const [ops, text, subtype] of [[doOps, newText, "s"], [undoOps, "foo foo", "d"], [doOps, newText, "s"]]
            ) {
                f.wysiwyg.innerHTML = ops[0].data;
                assertRef(f.wysiwyg.querySelector(refSelector), text, subtype);
                roundtrip(ops[0].data, text, subtype);
            }
        }
    }
    console.log("Current/all × live/fetched: confirmed content, do/undo/redo HTML and one transaction OK");

    // Observe DOM access, avoiding flaky timing assertions. Many unrelated references
    // must not add traversal to the replacement itself after units have been collected.
    for (const count of [0, 2000]) {
        const f = fixture(ref("foo") + ref("unmatched", "d", "block-ref", otherId).repeat(count));
        const {unitsByKey, matches} = collect(f);
        let lookups = 0;
        const closest = Element.prototype.closest;
        const queries = Element.prototype.querySelectorAll;
        Element.prototype.closest = function(selector) {
            if (selector.includes('data-subtype="d"')) lookups++;
            return closest.call(this, selector);
        };
        Element.prototype.querySelectorAll = () => {
            throw new Error("Replacement must not scan the document");
        };
        try {
            assert.equal(replacement.applyMatchesToLiveUnits(unitsByKey, matches, "bar").appliedCount, 1);
        } finally {
            Element.prototype.closest = closest;
            Element.prototype.querySelectorAll = queries;
        }
        assert.equal(lookups, 1, "one ancestor lookup independent of unrelated reference count");
        assertRef(f.block.querySelector(refSelector), "bar", "s");
        assert.equal(f.block.querySelectorAll('[data-subtype="d"]').length, count);
    }
    console.log("Reference replacement performs one local ancestor lookup and no document scan OK");
    console.log(
        lute ?
            "Native SiYuan Lute repeated BlockDOM roundtrip OK" :
            "Native Lute roundtrip skipped (pass lute.min.js path to enable)",
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
