/* eslint-disable no-undef -- main runs inside the shared isolated harness. */
// v3.8.10 initUI + DocumentTitleEditor structure; no notebook writes.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const harness = fs.readFileSync(path.join(__dirname, "run-code-language-regressions.cjs"), "utf8");
const setup = harness.slice(0, harness.indexOf("async function main()"));
async function main() {
    const {resolveDocRoot, resolveDocTitleInput, findDocumentBlock} = source("frontend/blocks");
    const wrapper = document.createElement("div");
    wrapper.className = "layout-tab-container";
    document.body.append(wrapper);
    wrapper.append(edit);
    // initUI places the rich title's lite Protyle before the main wysiwyg.
    const top = document.createElement("div");
    top.className = "protyle-top";
    top.innerHTML = '<div class="protyle-title"><div class="protyle-title__rich protyle" data-protyle-lite="true">' +
        '<div class="protyle-content"><div class="protyle-wysiwyg">' +
        '<div data-node-id="title-fragment" data-type="NodeParagraph">' +
        '<div class="protyle-title__input" contenteditable="true">Fixture heading</div></div></div></div></div></div>';
    content.prepend(top);
    const titleRoot = top.querySelector(".protyle-wysiwyg");
    const original = lute.Md2BlockDOM("needle first\n\nneedle second\n\nneedle unloaded\n");
    const kernel = document.createElement("div");
    kernel.innerHTML = original;
    const nodes = Array.from(kernel.children);
    const ids = nodes.map(node => node.dataset.nodeId);
    wysiwyg.innerHTML = nodes.slice(0, 2).map(node => node.outerHTML).join("");

    assert.equal(resolveDocRoot(wrapper), wysiwyg, "tab host resolves the body, not the rich title fragment");
    assert.equal(resolveDocRoot(edit), wysiwyg, "direct Protyle host resolves its own body");
    assert.equal(findDocumentBlock(wrapper, ids[0]), wysiwyg.firstElementChild);
    assert.equal(resolveDocTitleInput(wrapper), top.querySelector(".protyle-title__input"));
    assert.equal(collectSearchableBlocks(wrapper).filter(unit => unit.blockId === "title-fragment").length, 0,
        "rich title is not collected a second time as a body paragraph");

    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    for (const node of nodes) db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        node.dataset.nodeId, "root", "root", "p", "", node.textContent, lute.BlockDOM2Md(node.outerHTML), "", node.outerHTML, "1");
    editors = [{protyle: {element: edit, lute, block: {id: "root", rootID: "root"}, notebookId: ""}}];
    responder = async (url, payload) => {
        if (url === "/api/query/sql") return {code: 0, data: db.prepare(payload.stmt).all()};
        if (url === "/api/block/getDocBlocksOrders") return {code: 0, data: ids};
        if (url === "/api/block/getBlockDOMs") return {code: 0, data: Object.fromEntries(
            nodes.filter(node => payload.ids.includes(node.dataset.nodeId)).map(node => [node.dataset.nodeId, node.outerHTML]))};
        return {code: -1};
    };
    const search = () => corpus.searchCurrentDocument({}, wrapper, "needle", {includeAttributeView: false, includeFoldedBlocks: true});
    try {
        const found = await search();
        assert.equal(found.matches.length, 3, "API search still covers unloaded content");
        assert.ok(found.matches.slice(0, 2).every(hit => hit.range?.toString() === "needle"),
            "loaded body hits bind to real text despite the nested title Protyle");
        assert.equal(found.matches[2].range, undefined, "unloaded hit is not bound to the title");

        CSS.highlights = new Map();
        window.Highlight = class extends Set {};
        const beforeHighlight = wysiwyg.innerHTML;
        const bar = Object.create(SearchBar.prototype);
        Object.assign(bar, {
            edit: wrapper, resultMatches: found.matches, resultIndex: 1, searchGeneration: 1, domEpoch: 0,
            syncMemoUnderlineVisual() {}, syncReplaceButtons() {}, pauseAvWatch() {}, revealMatchTabs() {},
            unfoldAttributeViewGroup: () => false, attributeViewRangeNeedsReveal: () => false,
        });
        assert.equal(await bar.applyResultHighlightsWithBudget(found.matches), true);
        assert.equal(CSS.highlights.get(bar.componentHighlights.resultsName).size, 2, "yellow highlights cover loaded body hits");
        assert.ok(CSS.highlights.get(bar.componentHighlights.focusName).has(found.matches[0].range), "current hit is orange");
        Object.defineProperties(content, {clientHeight: {value: 400}, scrollHeight: {value: 2000}});
        content.style.overflowY = "auto";
        content.getBoundingClientRect = () => rect(0, 0, 600, 400);
        found.matches[1].range.getBoundingClientRect = () => rect(40, 900, 80, 20);
        bar.resultIndex = 2;
        await bar.scrollIntoRangesAsync(1, true);
        assert.equal(content.scrollTop, 710, "next hit scrolls the outer document, not the title editor");
        assert.equal(top.querySelector(".protyle-content").scrollTop, 0);
        assert.ok(CSS.highlights.get(bar.componentHighlights.focusName).has(found.matches[1].range));
        bar.componentHighlights.dispose();
        assert.equal(wysiwyg.innerHTML, beforeHighlight, "search, highlight and navigation do not change note content");

        wysiwyg.append(nodes[2].cloneNode(true));
        const rebound = project.fillLiveRanges(found.matches, collectSearchableBlocks(wrapper), true);
        assert.equal(rebound[2].range?.toString(), "needle", "unloaded hit rebinds after the body mounts");
        const title = await calculateSearchMatches({}, wrapper, "Fixture heading", {includeAttributeView: false});
        assert.equal(title.matches.length, 1, "title search remains a single title hit");
        assert.equal(title.matches[0].blockId, "__doc-title__");
        assert.ok(titleRoot.contains(title.matches[0].range.startContainer));

        const preview = document.createElement("div");
        preview.className = "protyle-preview";
        preview.innerHTML = '<div class="b3-typography">needle preview</div>';
        edit.append(preview);
        content.classList.add("fn__none");
        assert.equal(resolveDocRoot(wrapper), preview.firstElementChild, "preview skips the hidden body and its title fragment");
        content.classList.remove("fn__none");
        preview.remove();
        top.remove();
        assert.equal(resolveDocRoot(wrapper), wysiwyg, "v3.8.8 body without rich title keeps working");
        const offscreen = document.createElement("div");
        offscreen.dataset.pageSearchOffscreen = "true";
        offscreen.innerHTML = '<div class="protyle-wysiwyg"></div>';
        assert.equal(resolveDocRoot(offscreen), offscreen.firstElementChild, "detached extraction root keeps working");
        const hidden = edit.cloneNode(true);
        hidden.classList.add("fn__none");
        wrapper.prepend(hidden);
        assert.equal(resolveDocRoot(wrapper), wysiwyg, "hidden previous document cannot steal the active root");
    } finally {
        db.close();
        corpus.invalidateDocumentSearchCaches();
    }
    console.log("v3.8.10 rich-title/body roots: live/unloaded ranges, result/focus highlights, scrolling, preview and legacy roots OK");
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(setup + "\n" + main.toString() + "\nmain().catch(error => { console.error(error); process.exitCode = 1; });", __filename);
