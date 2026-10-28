// Native v3.8.8 Lute DOM and display-only frames; never writes a notebook.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {DatabaseSync} = require("node:sqlite");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
let editors = [];
let apiCalls = 0;
let responder = async () => ({code: -1});
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {
        getAllEditor: () => editors,
        fetchSyncPost: async (...args) => { apiCalls++; return responder(...args); },
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
const corpus = source("frontend/corpus/search");
const project = source("frontend/corpus/project");
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
    await nestedCodeRegressions();
    await corpusCodeRegressions();
    await mindmapTableCodeRegressions();
    codeClippingRegressions();
}

const richId = "20261025000000-abcdefg";
function richTable(markdown) {
    const encoded = Buffer.from(JSON.stringify({spec: 1, format: "kramdown", content: markdown})).toString("base64url");
    return lute.SpinBlockDOM('<div data-type="NodeTable" data-node-id="' + richId +
        '" custom-sy-table-rich="1"><div contenteditable="true"><table><thead><tr><th data-sy-table-cell-rich="' +
        encoded + '"></th></tr></thead></table></div></div>');
}
function hydrateRichCells() {
    wysiwyg.querySelectorAll("[data-sy-table-cell-rich]").forEach(cell => {
        const markdown = JSON.parse(Buffer.from(cell.getAttribute("data-sy-table-cell-rich"), "base64url").toString()).content;
        cell.innerHTML = '<div class="table__cell-rich">' + lute.Md2BlockDOM(markdown) + '</div>';
        cell.querySelectorAll("*").forEach(node => {
            if (node.hasAttribute("data-node-id")) node.setAttribute("data-table-cell-node", "");
            for (const name of ["id", "data-node-id", "data-node-index", "updated", "spellcheck", "draggable"])
                node.removeAttribute(name);
            if (node.hasAttribute("contenteditable")) node.setAttribute("contenteditable", "false");
        });
    });
}
function mindmapCode(markdown = "```python\nprint(1)\n```", id = "code") {
    const container = document.createElement("div");
    container.innerHTML = lute.Md2BlockDOM(markdown);
    const code = container.firstElementChild;
    code.dataset.nodeId = id;
    const preview = code.cloneNode(true);
    preview.querySelectorAll(".protyle-action, .protyle-attr").forEach(node => node.remove());
    preview.dataset.mindmapSourceId = id;
    preview.removeAttribute("data-node-id");
    return {code: code.outerHTML, html: '<div data-type="NodeMindmap" data-node-id="mind" data-mindmap-view-rendered="true">' +
        '<div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' + code.outerHTML +
        '</div><div class="mindmap-view">' + preview.outerHTML + '</div></div>'};
}
// Apply the same identity/control stripping as v3.8.8 listMindmap/view.ts.
function mindmapTable(markdown) {
    wysiwyg.innerHTML = richTable(markdown);
    hydrateRichCells();
    const table = wysiwyg.firstElementChild;
    const preview = table.cloneNode(true);
    preview.querySelectorAll('.protyle-attr, .protyle-action:not(.li[data-table-cell-node] > .protyle-action), .protyle-action__table, .protyle-icons')
        .forEach(node => node.remove());
    [preview, ...preview.querySelectorAll('*')].forEach(node => {
        if (node.hasAttribute('data-node-id')) node.dataset.mindmapSourceId = node.dataset.nodeId;
        for (const name of ['contenteditable', 'data-node-id', 'spellcheck', 'draggable']) node.removeAttribute(name);
    });
    return '<div data-type="NodeMindmap" data-node-id="mind" data-mindmap-view-rendered="true">' +
        '<div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' + table.outerHTML +
        '</div><div class="mindmap-view">' + preview.outerHTML + '</div></div>';
}
async function nestedCodeRegressions() {
    for (const name of ["TextMark", "BlockRef", "KramdownIAL", "HTMLTag2TextMark", "DataTask", "EnsureListItemParagraph"])
        lute["Set" + name](true);
    const markdown = "before\n\n```python\nprint(1)\n```\n\nafter\n\n```python\nprint(2)\n```";
    wysiwyg.innerHTML = richTable(markdown);
    const cold = await calculateSearchMatches({}, edit, "python");
    assert.equal(cold.matches.length, 2, "rich static PRE/CODE labels are searchable");
    assert.ok(cold.matches.every(hit => hit.range && !hit.replaceable && hit.replaceReason === "codeLanguage"));
    assert.ok(cold.matches.every(hit => hit.blockTypes.includes("code")));
    assert.equal((await calculateSearchMatches({}, edit, "print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 2);
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeCodeLanguage: false})).matches.length, 0);
    const after = await calculateSearchMatches({}, edit, "after", {includeCodeBlock: false, includeCodeLanguage: true});
    assert.equal(after.matches.length, 1);
    assert.equal(after.matches[0].replaceable, true, "filtering code preserves following rich text source offsets");
    assert.equal(visual.codeLanguageFrameHost(cold.matches[0].range).tagName, "PRE");
    hydrateRichCells();
    const live = await calculateSearchMatches({}, edit, "python");
    assert.deepEqual(live.matches.map(hit => hit.unitId), cold.matches.map(hit => hit.unitId), "rich hydration retains language identity");
    const rebound = project.fillLiveRanges(cold.matches, collectSearchableBlocks(edit), true);
    assert.ok(rebound.every(hit => visual.codeLanguageFrameHost(hit.range)?.dataset.type === "NodeCodeBlock"));
    assert.equal((await calculateSearchMatches({}, edit, "print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    const ordered = await calculateSearchMatches({}, edit, "before|python|after", {regex: true});
    assert.deepEqual(ordered.matches.map(hit => hit.matchedText), ["before", "python", "after", "python"], "labels retain their cell source order");
    assert.ok(ordered.matches.filter(hit => hit.highlightKind !== "code-language").every(hit => !hit.blockTypes.includes("code")),
        "new labels must not classify unrelated table text as code");
    const filtered = await calculateSearchMatches({}, edit, "before|python|after", {regex: true, resultBlockTypes: ["code"]});
    assert.deepEqual(filtered.matches.map(hit => hit.matchedText), ["python", "python"]);
    const liveUnits = collectSearchableBlocks(edit);
    const labels = liveUnits.filter(unit => unit.matchSource === "code-language");
    const selection = window.getSelection();
    const bodyRange = document.createRange();
    bodyRange.selectNodeContents(wysiwyg.querySelector(".hljs").lastElementChild);
    selection.addRange(bodyRange);
    assert.ok(labels.every(unit => !getSelectionScope(edit, liveUnits).has(unitKey(unit.blockId, unit.unitId))),
        "selecting rich code body does not select its language metadata");
    selection.removeAllRanges();
    const selectedCell = wysiwyg.querySelector("[data-sy-table-cell-rich]");
    const cellScope = getSelectionScope(edit, liveUnits, [selectedCell]);
    assert.ok(labels.every(unit => cellScope.has(unitKey(unit.blockId, unit.unitId))), "selecting a whole cell includes its labels");
    const calls = apiCalls;
    const html = wysiwyg.innerHTML;
    assert.equal((await write.replaceCurrentMatchInEditor(edit, {...live.matches[0], replaceable: true}, "changed")).replacedCount, 0);
    assert.equal((await write.replaceAllMatchesInEditor(edit, live.matches.map(hit => ({...hit, replaceable: true})), "changed")).skippedCount, 2);
    assert.equal(apiCalls, calls);
    assert.equal(wysiwyg.innerHTML, html);
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeTable: false})).matches.length, 0);
    const preview = selectedCell.innerHTML;
    selectedCell.innerHTML += '<div class="table__cell-editor"><div class="protyle-wysiwyg">' + preview + '</div></div>';
    const editing = await calculateSearchMatches({}, edit, "python");
    assert.deepEqual(editing.matches.map(hit => hit.unitId), live.matches.map(hit => hit.unitId));
    assert.ok(editing.matches.every(hit => hit.range.startContainer.closest(".table__cell-editor")), "active editor contributes one label per code block");
    assert.equal((await calculateSearchMatches({}, edit, "print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    wysiwyg.innerHTML = richTable("> ```python\n> print(1)\n> ```");
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeBlockquote: false})).matches.length, 0);
    const quoted = await calculateSearchMatches({}, edit, "python", {resultBlockTypes: ["code", "quote", "table"]});
    assert.equal(quoted.matches.length, 1, "cold rich labels keep their internal quote ancestry");
    assert.deepEqual(quoted.matches[0].blockTypes, ["code", "quote", "table"]);
    hydrateRichCells();
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeBlockquote: false})).matches.length, 0);
    assert.deepEqual((await calculateSearchMatches({}, edit, "python")).matches[0].blockTypes, quoted.matches[0].blockTypes);
    for (const [md, expected] of [
        ['1. item\n\n   ```python\n   print(1)\n   ```', ['code', 'ordered', 'table']],
        ['- [ ] item\n\n  ```python\n  print(1)\n  ```', ['code', 'task', 'table']],
        ['# first\n\n## second\n\n```python\nprint(1)\n```', ['code', 'h2', 'h1', 'table']],
    ]) {
        wysiwyg.innerHTML = richTable(md);
        const raw = await calculateSearchMatches({}, edit, 'python');
        assert.equal(raw.matches.length, 1);
        assert.deepEqual(raw.matches[0].blockTypes, expected);
        hydrateRichCells();
        assert.deepEqual((await calculateSearchMatches({}, edit, 'python')).matches[0].blockTypes, expected,
            'native rich preview retains semantic list/heading ancestry');
    }

    const style = document.createElement("style");
    style.textContent = '[data-mindmap-view-rendered="true"] > .mindmap-item {display:none}';
    document.head.append(style);
    const map = mindmapCode();
    wysiwyg.innerHTML = map.html;
    const found = await calculateSearchMatches({}, edit, "python");
    assert.equal(found.matches.length, 1, "mindmap recovers a label from its hidden native source");
    assert.ok(found.matches[0].range.startContainer.closest(".mindmap-view"));
    assert.equal(found.matches[0].replaceable, false);
    assert.equal((await calculateSearchMatches({}, edit, "print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeCodeLanguage: false})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, "python", {includeMindmap: false})).matches.length, 0);
    wysiwyg.innerHTML = ["one", "two"].map(id => '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-' + id +
        '" class="render-node">' + map.html + '</div>').join("");
    const embedded = await calculateSearchMatches({}, edit, "python");
    assert.deepEqual(embedded.matches.map(hit => hit.blockId), ["embed-one", "embed-two"]);
    assert.ok(embedded.matches.every(hit => !hit.replaceable && hit.highlightKind === "code-language"));
    style.remove();
    console.log("Code language nested DOM: rich cold/live identities, readonly labels, body gates, source order, native mindmap and repeated embeds OK");
}
async function mindmapTableCodeRegressions() {
    const markdown = 'before\n\n> ```python\n> print(1)\n> ```\n\nafter\n\n```matlab\na = 1;\n```';
    const rawTable = richTable(markdown);
    const map = mindmapTable(markdown);
    const style = document.createElement('style');
    style.textContent = '[data-mindmap-view-rendered="true"] > .mindmap-item {display:none}';
    document.head.append(style);
    wysiwyg.innerHTML = map;
    const found = await calculateSearchMatches({}, edit, 'python|matlab', {regex: true});
    assert.equal(found.matches.length, 2, "projected rich tables retain both language labels");
    assert.ok(found.matches.every(hit => hit.range && !hit.replaceable && hit.highlightKind === 'code-language'));
    assert.ok(found.matches.every(hit => visual.codeLanguageFrameHost(hit.range)?.closest('.mindmap-view')));
    content.getBoundingClientRect = () => rect(0, 0, 600, 400);
    found.matches.forEach((hit, index) => visual.codeLanguageFrameHost(hit.range).getBoundingClientRect = () => rect(20, 30 + index * 100, 300, 60));
    const noteDOM = wysiwyg.innerHTML;
    visual.applyCodeLanguageVisual(edit, found.matches.map(hit => hit.range), found.matches[0].range);
    assert.equal(edit.querySelectorAll('.page-search-code-language-frame').length,2);
    assert.equal(edit.querySelectorAll('.page-search-code-language-frame.is-focus').length,1);
    assert.equal(wysiwyg.innerHTML,noteDOM,'canvas language frames never enter the note DOM');
    visual.clearCodeLanguageVisual(edit);
    assert.equal((await calculateSearchMatches({}, edit, 'python', {resultBlockTypes: ['code', 'quote', 'mindmap']})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, 'print', {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, 'python', {includeCodeLanguage: false})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, 'print', {includeTable: false})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, 'python', {includeBlockquote: false})).matches.length, 0);
    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run('mind', 'root', 'root', 'mindmap', '', '', '', '', 'h0', '1');
    insert.run('item', 'root', 'mind', 'mindmap_item', '', '', '', '', 'h1', '1');
    insert.run(richId, 'root', 'item', 't', '', 'before print(1) after a = 1;', lute.BlockDOM2StdMd(rawTable), '', 'h2', '1');
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    responder = async (url, body) => {
        if (url === '/api/query/sql') return {code: 0, data: db.prepare(body.stmt).all()};
        if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: ['mind', 'item', richId]};
        if (url === '/api/block/getBlockDOMs') return {code: 0, data: {[richId]: rawTable}};
        return {code: -1};
    };
    const search = (query, options = {}) => corpus.searchCurrentDocument({}, edit, query,
        {includeAttributeView: false, includeFoldedBlocks: true, ...options});
    let canonical;
    for (const state of ['mounted', 'unloaded', 'remounted']) {
        wysiwyg.innerHTML = state === 'unloaded' ? '' : map;
        corpus.invalidateDocumentSearchCaches();
        const result = await search('python|print|matlab', {regex: true});
        assert.equal(result.partial, false);
        assert.deepEqual(result.matches.map(hit => hit.matchedText), ['python', 'print', 'matlab'], state + ' counts source/preview once');
        const ids = result.matches.map(hit => hit.unitId);
        if (canonical) assert.deepEqual(ids, canonical, state + ' retains cell identities');
        else canonical = ids;
        assert.equal((await search('python', {resultBlockTypes: ['code', 'quote', 'mindmap']})).matches.length, 1);
        assert.equal((await search('print', {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
        assert.equal((await search('python', {includeCodeLanguage: false})).matches.length, 0);
        assert.equal((await search('print', {includeTable: false})).matches.length, 0);
        if (state !== 'unloaded') {
            const labels = result.matches.filter(hit => hit.highlightKind === 'code-language');
            assert.ok(labels.every(hit => visual.codeLanguageFrameHost(hit.range)?.closest('.mindmap-view')));
            assert.ok(labels.every(hit => !hit.replaceable));
            for (const label of labels) {
                const frozen = freezeBlock(collectSearchableBlocks(edit).find(unit => unit.unitId === label.unitId));
                assert.equal(frozen.richCell, undefined, 'readonly labels never serialize or validate a writable rich-cell snapshot');
            }
            const rebound = project.fillLiveRanges(result.matches, collectSearchableBlocks(edit), true);
            assert.ok(rebound.every(hit => hit.range), 'canonical body offsets bind to the visible table too');
        }
    }
    editors = []; responder = async () => ({code: -1});
    wysiwyg.innerHTML = ['one', 'two'].map(id => '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-' + id + '">' + map + '</div>').join('');
    const embeds = await calculateSearchMatches({}, edit, 'python');
    assert.deepEqual(embeds.matches.map(hit => hit.blockId), ['embed-one', 'embed-two']);
    assert.ok(embeds.matches.every(hit => !hit.replaceable && hit.range));
    // Language ancestry collection must not rescan document siblings per table.
    wysiwyg.innerHTML = Array.from({length: 80}, (_, index) => rawTable.replace(richId, richId + index)).join('');
    const getChildren = Object.getOwnPropertyDescriptor(window.Element.prototype, 'children').get;
    let siblingReads = 0;
    Object.defineProperty(wysiwyg, 'children', {configurable: true, get() { siblingReads++; return getChildren.call(this); }});
    const many = collectSearchableBlocks(edit);
    assert.equal(many.filter(unit => unit.matchSource === 'code-language').length, 160);
    assert.ok(siblingReads <= 2, 'all table labels share the document sibling/heading scan');
    delete wysiwyg.children;
    style.remove(); db.close(); editors = []; responder = async () => ({code: -1});
    console.log('Mindmap rich tables: canonical counts/offsets, readonly language frames, gates, quote ancestry, cold/mounted transitions and repeated embeds OK');
}
async function corpusCodeRegressions() {
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    const insert = db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)");
    const map = mindmapCode();
    const style = document.createElement("style");
    style.textContent = '[data-mindmap-view-rendered="true"] > .mindmap-item {display:none}';
    document.head.append(style);
    let doms = {code: map.code};
    responder = async (url, body) => {
        if (url === "/api/query/sql") return {code: 0, data: db.prepare(body.stmt).all()};
        if (url === "/api/block/getDocBlocksOrders") return {code: 0, data: Object.keys(doms)};
        if (url === "/api/block/getBlockDOMs") return {code: 0, data: doms};
        return {code: -1};
    };
    editors = [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}];
    const search = (query, options = {}) => corpus.searchCurrentDocument({}, edit, query,
        {includeAttributeView: false, includeFoldedBlocks: true, ...options});
    insert.run("mind", "root", "root", "mindmap", "", "print(1)", "", "", "h0", "1");
    insert.run("item", "root", "mind", "mindmap_item", "", "print(1)", "", "", "h1", "1");
    insert.run("code", "root", "item", "c", "", "print(1)", "```python\nprint(1)\n```", "", "h2", "1");
    wysiwyg.innerHTML = map.html;
    corpus.invalidateDocumentSearchCaches();
    const mounted = await search("python");
    assert.equal(mounted.matches.length, 1);
    assert.equal(mounted.partial, false);
    assert.equal((await search("print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    wysiwyg.innerHTML = "";
    corpus.invalidateDocumentSearchCaches();
    const cold = await search("python");
    assert.deepEqual(cold.matches.map(hit => hit.unitId), mounted.matches.map(hit => hit.unitId));
    assert.equal(cold.partial, false);

    const table = richTable("before\n\n```python\nprint(1)\n```\n\nafter");
    db.exec("DELETE FROM blocks");
    insert.run(richId, "root", "root", "t", "", "before print(1) after", lute.BlockDOM2StdMd(table), "", "ht", "1");
    doms = {[richId]: table};
    corpus.invalidateDocumentSearchCaches();
    const unloaded = await search("python");
    assert.equal(unloaded.matches.length, 1, "cold rich labels remain candidates when blocks.content omits the language");
    assert.ok(!unloaded.matches[0].range && !unloaded.matches[0].replaceable);
    assert.ok(unloaded.matches[0].blockTypes.includes("code"));
    assert.equal((await search("print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    const coldOrder = await search("before|python|after", {regex: true});
    assert.deepEqual(coldOrder.matches.map(hit => hit.matchedText), ["before", "python", "after"]);
    wysiwyg.innerHTML = table;
    const omittedRow = wysiwyg.querySelector("tr");
    const savedRow = omittedRow.outerHTML;
    omittedRow.innerHTML = "<th></th>";
    omittedRow.setAttribute("data-sy-table-virtual-rows", savedRow);
    corpus.invalidateDocumentSearchCaches();
    const virtual = await search("python");
    assert.deepEqual(virtual.matches.map(hit => hit.unitId), unloaded.matches.map(hit => hit.unitId));
    assert.equal(virtual.partial, false);
    assert.ok(!virtual.matches[0].range);
    wysiwyg.innerHTML = table;
    hydrateRichCells();
    corpus.invalidateDocumentSearchCaches();
    const live = await search("python");
    assert.deepEqual(live.matches.map(hit => hit.unitId), unloaded.matches.map(hit => hit.unitId));
    assert.ok(live.matches.every(hit => hit.range && !hit.replaceable));
    assert.equal((await search("print", {includeCodeBlock: false, includeCodeLanguage: true})).matches.length, 0);
    const ordered = await search("before|python|after", {regex: true});
    assert.deepEqual(ordered.matches.map(hit => hit.matchedText), ["before", "python", "after"]);
    assert.ok(ordered.matches.filter(hit => hit.highlightKind !== "code-language").every(hit => !hit.blockTypes.includes("code")));
    assert.deepEqual((await search("before|python|after", {regex: true, resultBlockTypes: ["code"]})).matches.map(hit => hit.matchedText), ["python"]);
    style.remove(); db.close(); editors = []; responder = async () => ({code: -1});
    console.log("Code language corpus: unloaded/mounted mindmap, cold/native rich tables, complete counts, body gates and source order OK");
}
function codeClippingRegressions() {
    wysiwyg.innerHTML = '<div style="overflow:hidden">' + lute.Md2BlockDOM("```python\nprint(1)\n```") + '</div>';
    const clipper = wysiwyg.firstElementChild;
    const code = clipper.firstElementChild;
    let reads = 0;
    clipper.getBoundingClientRect = () => { reads++; return rect(20, 40, 300, 100); };
    content.getBoundingClientRect = () => rect(0, 0, 600, 400);
    const unit = collectSearchableBlocks(edit).find(unit => unit.matchSource === "code-language");
    const range = createRangeFromBlockOffsets(unit, 0, 6);
    code.getBoundingClientRect = () => rect(30, 200, 200, 60);
    visual.applyCodeLanguageVisual(edit, [range]);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length, 0);
    code.getBoundingClientRect = () => rect(30, 100, 350, 100);
    visual.applyCodeLanguageVisual(edit, [range], range);
    const frame = edit.querySelector(".page-search-code-language-frame");
    assert.equal(frame.style.clipPath, "inset(0px 60px 60px 0px)");
    assert.ok(frame.classList.contains("is-focus"));
    const ranges = [range];
    for (let index = 0; index < 24; index++) {
        const copy = code.cloneNode(true);
        clipper.append(copy);
        copy.getBoundingClientRect = () => rect(30, 100, 350, 100);
        const copiedRange = document.createRange();
        copiedRange.selectNodeContents(copy);
        ranges.push(copiedRange);
    }
    reads = 0;
    visual.applyCodeLanguageVisual(edit, ranges);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length, 25);
    assert.equal(reads, 1, "many code frames read their common scrollport geometry only once");
    visual.clearCodeLanguageVisual(edit);
    console.log("Code language frames: nested clipping, original border/focus and shared geometry reads OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
