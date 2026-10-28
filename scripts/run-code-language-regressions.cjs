// Native v3.8.8 Lute DOM and display-only frames; never writes a notebook.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
let editors = [];
let apiCalls = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {
        getAllEditor: () => editors,
        fetchSyncPost: async () => { apiCalls++; return {code: -1}; },
    };
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(
    fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'),
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}},
).outputText, file);
const source = file => require(path.resolve(__dirname, "../src", file + ".ts"));
const {window} = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
Object.assign(global, {window, document: window.document, CSS: {escape: value => value}});
for (const key of ["Node", "Element", "HTMLElement", "Text", "NodeFilter", "Range", "ShadowRoot", "MutationObserver",
    "HTMLTableElement", "HTMLTableRowElement", "HTMLTableCellElement"]) global[key] = window[key];
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
const luteFile = process.env.SIYUAN_LUTE_PATH || path.resolve(__dirname, "../../tmp/rich-cell-v387/lute-v388.js");
require(luteFile);
const lute = (window.Lute ?? global.Lute).New();
lute.SetProtyleWYSIWYG(true);
const {collectSearchableBlocks} = source("frontend/blocks");
const {freezeBlock} = source("frontend/corpus/units");
const {createRangeFromBlockOffsets} = source("frontend/ranges");
const {calculateSearchMatches} = source("frontend/pipeline");
const write = source("frontend/protyle-write");
const {createReplacementUnitLookup} = source("frontend/replacement");
const {createReplacementReasonReader} = source("frontend/replacement-reasons");
const {getSelectionScope, unitKey} = source("frontend/selection");
const visual = source("frontend/code-language-visual");
const {SearchBar} = source("frontend/search-bar");
const prefs = source("shared/rpc-types");
const flags = source("shared/code-block-language");
const edit = document.createElement("div");
edit.className = "protyle";
edit.innerHTML = '<div class="protyle-content"><div class="protyle-wysiwyg"></div></div>';
document.body.append(edit);
const wysiwyg = edit.querySelector(".protyle-wysiwyg");
const content = edit.querySelector(".protyle-content");
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});

async function main() {
    wysiwyg.innerHTML = lute.Md2BlockDOM("```python\npython print(1)\n```\n\n```matlab\na = 1;\n```");
    const native = wysiwyg.querySelector('[data-type="NodeCodeBlock"]');
    const label = native.querySelector(".protyle-action__language");
    assert.equal(label.getAttribute("contenteditable"), "false");
    label.parentElement.style.display = "none"; // Toolbar normally hides until hover.
    const collected = collectSearchableBlocks(edit);
    const language = collected.find(unit => unit.text === "python");
    const body = collected.find(unit => unit.text.includes("print(1)"));
    assert.equal(language.unitId, "code-language");
    assert.equal(body.text, "python print(1)\n");
    assert.equal(freezeBlock(language).segmentLengths, undefined);
    assert.equal(freezeBlock(language).highlightKind, "code-language");
    assert.deepEqual(collectSearchableBlocks(edit, {includeCodeBlock: false, includeCodeLanguage: true}).map(unit => unit.text),
        ["python", "matlab"]);
    assert.deepEqual(collectSearchableBlocks(edit, {includeCodeBlock: false}), []);
    assert.ok(collectSearchableBlocks(edit, {includeCodeLanguage: false}).every(unit => unit.matchSource !== "code-language"));
    native.style.display = "none";
    assert.ok(!collectSearchableBlocks(edit).some(unit => unit.blockId === language.blockId), "author-hidden block stays excluded");
    native.style.display = "";

    const found = await calculateSearchMatches({}, edit, "python");
    assert.equal(found.matches.length, 2, "loaded fallback separates language and body");
    const [hit, bodyHit] = found.matches;
    assert.equal(hit.highlightKind, "code-language");
    assert.equal(hit.replaceable, false);
    assert.equal(bodyHit.replaceable, true);
    assert.equal(hit.range.startContainer, native, "frame range anchors visible block rather than hidden label");
    assert.equal(createReplacementReasonReader()(hit), "codeLanguage");
    const unitsByKey = new Map([[`${language.blockId}::${language.unitId}`, language]]);
    assert.equal(createReplacementUnitLookup(unitsByKey)(hit), undefined);
    const forged = {...hit, replaceable: true};
    assert.equal(write.isMatchContentWritable(forged), false, "write layer independently rejects labels");
    editors = [{protyle: {element: edit, block: {id: "r", rootID: "r"}, notebookId: "n"}}];
    assert.equal(write.countWritableMatches(edit, [hit, bodyHit]), 1, "replace-all count excludes only the language hit");
    const before = wysiwyg.innerHTML;
    const calls = apiCalls;
    assert.equal((await write.replaceCurrentMatchInEditor(edit, forged, "changed")).replacedCount, 0);
    assert.equal((await write.replaceAllMatchesInEditor(edit, [forged], "changed")).skippedCount, 1);
    assert.equal(apiCalls, calls, "rejected language edits issue no reads or transactions");
    assert.equal(wysiwyg.innerHTML, before);

    const selection = window.getSelection();
    const bodyRange = document.createRange();
    bodyRange.selectNodeContents(native.querySelector('.hljs [contenteditable="true"]'));
    selection.addRange(bodyRange);
    assert.equal(getSelectionScope(edit, collected).has(unitKey(language.blockId, language.unitId)), false,
        "selecting body text does not select its language label");
    selection.removeAllRanges();
    native.classList.add("protyle-wysiwyg--select");
    assert.equal(getSelectionScope(edit, collected).has(unitKey(language.blockId, language.unitId)), true);
    native.classList.remove("protyle-wysiwyg--select");

    for (const name of ["includeCodeBlock", "includeMermaid", "includeFlowchart"]) {
        assert.equal(prefs.coercePluginPrefs({[name]: false}).includeCodeLanguage, name !== "includeCodeBlock");
    }
    const split = prefs.coercePluginPrefs({includeCodeBlock: false, includeCodeLanguage: true});
    assert.equal(split.includeCodeBlock, false);
    assert.equal(split.includeCodeLanguage, true);
    assert.equal(prefs.mergePrefs(split, {includeCodeBlock: true}).includeCodeLanguage, true);
    assert.equal(flags.isCodeBlockLanguageEnabled("graphviz", split), false, "label switch never enables rendered diagrams");
    assert.equal(flags.isCodeBlockLanguageEnabled("python", split), true);

    content.getBoundingClientRect = () => rect(10, 20, 600, 400);
    native.getBoundingClientRect = () => rect(30, 50, 500, 100);
    const second = wysiwyg.querySelectorAll('[data-type="NodeCodeBlock"]')[1];
    second.getBoundingClientRect = () => rect(30, 200, 500, 100);
    const secondUnit = collected.find(unit => unit.text === "matlab");
    const secondRange = createRangeFromBlockOffsets(secondUnit, 0, 6);
    visual.applyCodeLanguageVisual(edit, [hit.range, hit.range, secondRange], hit.range);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length, 2, "dedupe multiple language hits per block");
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame.is-focus").length, 1);
    assert.equal(edit.querySelector(".page-search-code-language-frame").style.top, "30px");
    assert.equal(wysiwyg.innerHTML, before, "overlay never touches note DOM");
    visual.applyCodeLanguageVisual(edit, [hit.range, secondRange], secondRange);
    assert.equal(edit.querySelector(".page-search-code-language-frame.is-focus").style.top, "180px");
    second.getBoundingClientRect = () => rect(30, 600, 500, 100);
    visual.applyCodeLanguageVisual(edit, [hit.range, secondRange], hit.range);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length, 1, "only viewport frames are drawn");
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {edit, resultMatches: [hit, bodyHit], resultIndex: 1, memoUnderlineLayoutRaf: 0});
    bar.syncMemoUnderlineVisual();
    const stop = bar.stopMemoUnderlineLayoutSync;
    bar.syncMemoUnderlineVisual();
    assert.equal(bar.stopMemoUnderlineLayoutSync, stop, "redraw reuses listeners");
    bar.resultIndex = 2;
    bar.syncMemoUnderlineVisual();
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame.is-focus").length, 0);
    native.getBoundingClientRect = () => rect(30, 80, 500, 100);
    document.dispatchEvent(new window.Event("scroll"));
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    assert.equal(edit.querySelector(".page-search-code-language-frame").style.top, "60px");
    bar.resultMatches = [];
    bar.syncMemoUnderlineVisual();
    assert.equal(bar.stopMemoUnderlineLayoutSync, null);
    assert.equal(edit.querySelector(".page-search-code-language-layer"), null);
    assert.equal(content.classList.contains("page-search-code-language-host"), false);
    Object.defineProperties(content, {clientHeight: {value: 400}, scrollHeight: {value: 2000}});
    content.style.overflowY = "auto";
    native.getBoundingClientRect = () => rect(30, 800, 500, 1000);
    Object.assign(bar, {resultMatches: [hit], resultIndex: 1, includeFoldedBlocks: false});
    bar.pauseAvWatch = bar.revealMatchTabs = bar.syncReplaceButtons = bar.clearSearchFocus = () => {};
    bar.unfoldAttributeViewGroup = bar.attributeViewRangeNeedsReveal = () => false;
    await bar.scrollIntoRangesAsync(0, true);
    assert.equal(content.scrollTop, 596, "navigation centers the language toolbar, not the middle of a tall code body");
    bar.resultMatches = [];
    bar.syncMemoUnderlineVisual();
    for (const lang of ["zh-CN", "en"]) {
        bar.i18n = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/i18n", lang + ".json"), "utf8"));
        bar.buildMatchSwitchMenuItem = options => options;
        bar.includeCodeBlock = false;
        bar.includeCodeLanguage = true;
        const menu = bar.buildCodeBlockMenuItem().submenu;
        assert.equal(menu[0].label, bar.i18n.settingsIncludeCodeBody);
        assert.equal(menu[1].label, bar.i18n.settingsIncludeCodeLanguage);
        assert.equal(menu[0].checked, false);
        assert.equal(menu[1].checked, true);
        assert.equal(bar.replacementReasonLabel("codeLanguage"), bar.i18n.settingsIncludeCodeLanguage);
        bar.resultMatches = [hit, bodyHit];
        assert.ok(bar.replacementSkipDetails().includes(bar.i18n.settingsIncludeCodeLanguage),
            "replace-all confirmation explains the actual readonly language hit");
    }
    console.log("Code language: native Lute label/body, hidden toolbar, selection, prefs, readonly single/all, display frames/focus/scroll/cleanup and menus OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
