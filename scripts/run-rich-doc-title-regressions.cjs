/* eslint-disable no-undef -- main runs inside the shared isolated harness. */
// v3.8.10 DocumentTitleEditor: one inline paragraph in a nested lite Protyle.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const harness = fs.readFileSync(path.join(__dirname, "run-code-language-regressions.cjs"), "utf8");
const setup = "const renderers = {};\n" + harness.slice(0, harness.indexOf("async function main()")).replace(
    "getAllEditor: () => editors,", "ProtyleMethod: renderers, getAllEditor: () => editors,");
async function main() {
    const computed = global.getComputedStyle;
    global.getComputedStyle = element => computed(element.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? element.closest(".katex-mathml") : element);
    const {resolveDocTitleInput} = source("frontend/blocks");
    const {watchEditorDom} = source("frontend/editor-dom-watch");
    const wrapper = document.createElement("div");
    wrapper.className = "layout-tab-container";
    document.body.append(wrapper);
    wrapper.append(edit);
    const top = document.createElement("div");
    top.className = "protyle-top";
    content.prepend(top);
    const formula = (rendered = true) => '<span data-type="inline-math" data-subtype="math" data-content="\\alpha+\\alpha">' +
        (rendered ? '<span class="katex"><span class="katex-html" aria-hidden="true">α+α</span>' +
            '<span class="katex-mathml"><math><annotation>\\alpha+\\alpha</annotation></math></span></span>' : "") + "</span>";
    const mount = html => {
        if (!top.firstElementChild) top.innerHTML = '<div class="protyle-title"></div>';
        top.firstElementChild.innerHTML = '<div class="protyle protyle-title__rich" data-protyle-lite="true">' +
            '<div class="protyle-content"><div class="protyle-wysiwyg"><div data-type="NodeParagraph" data-node-id="temporary-title">' +
            '<div class="protyle-title__input" contenteditable="true">' + html + "</div></div></div></div></div>";
        return resolveDocTitleInput(wrapper);
    };
    const html = '<span data-type="strong">needle</span> left' + formula() +
        'right <span data-type="inline-memo" data-inline-memo-content="memo needle">host</span> ' + formula();
    let title = mount(html);
    wysiwyg.innerHTML = lute.Md2BlockDOM("body needle\n");
    const bodyId = wysiwyg.firstElementChild.dataset.nodeId;
    const search = (query, options = {}) => calculateSearchMatches({}, wrapper, query, {includeAttributeView: false, ...options});
    const snapshot = edit.innerHTML;
    const calls = apiCalls;
    const visible = await search("α");
    assert.equal(visible.matches.length, 4, "each visible title glyph is counted once, excluding MathML/source");
    assert.ok(visible.matches.every(hit => hit.blockId === "__doc-title__" && hit.blockType === "doc-title" &&
        hit.highlightKind === "inline-math" && hit.range?.toString() === "α" && !hit.replaceable));
    assert.deepEqual(visible.matches.map(hit => hit.mathOrdinal), [0, 0, 1, 1]);
    const tex = await search("\\alpha", {searchMathSource: true});
    assert.equal(tex.matches.length, 4);
    assert.ok(tex.matches.every(hit => hit.highlightKind === "math-source" && visual.mathSourceFrameHost(hit.range)));
    assert.equal((await search("\\alpha")).matches.length, 0, "visible mode does not match TeX annotations");
    assert.equal((await search("α", {searchMathSource: true})).matches.length, 0, "source mode does not count glyphs");
    assert.equal((await search("leftright")).matches.length, 0, "no false match across an excluded formula");
    assert.deepEqual((await search("needle", {includeInlineMemo: true})).matches.map(hit => hit.blockId),
        ["__doc-title__", "__doc-title__", bodyId]);
    assert.equal((await search("memo", {includeInlineMemo: false})).matches.length, 0);
    const memos = await search("memo", {includeInlineMemo: true, restrictInlineTypes: ["inline-memo"]});
    assert.equal(memos.matches.length, 1);
    assert.equal(memos.matches[0].highlightKind, "inline-memo");
    assert.ok(title.contains(memos.matches[0].range.commonAncestorContainer));
    const kinds = await search("", {restrictInlineTypes: ["inline-math"]});
    assert.equal(kinds.matches.length, 2, "empty-query math enumeration includes title formulas");
    assert.ok(kinds.matches.every(hit => hit.blockId === "__doc-title__"));
    const bold = await search("needle", {restrictInlineTypes: ["strong"]});
    assert.deepEqual(bold.matches.map(hit => hit.blockId), ["__doc-title__"]);
    assert.equal((await search("", {restrictInlineTypes: ["strong"]})).matches.length, 1);
    assert.equal((await search("α", {includeDocTitle: false})).matches.length, 0);
    assert.equal((await search("α", {includeParagraph: false, includeMathBlock: false})).matches.length, 4,
        "the title's temporary paragraph does not inherit body block switches");
    assert.equal((await search("", {includeParagraph: false, restrictInlineTypes: ["strong"]})).matches.length, 1);
    const range = document.createRange();
    range.selectNodeContents(title.querySelector('[data-type="strong"]'));
    window.getSelection().addRange(range);
    assert.deepEqual((await search("needle", {selectionOnly: true})).matches.map(hit => hit.blockId), ["__doc-title__"]);
    window.getSelection().removeAllRanges();
    const all = await search("needle", {includeInlineMemo: true});
    assert.equal(write.countWritableMatches(wrapper, all.matches.filter(hit => hit.blockId === "__doc-title__")), 0);
    for (const hit of [...all.matches, ...tex.matches].filter(hit => hit.blockId === "__doc-title__")) {
        assert.equal(write.isMatchContentWritable({...hit, replaceable: true}), false);
        assert.equal(createReplacementReasonReader()(hit), "docTitle");
    }
    assert.equal(edit.innerHTML, snapshot, "search and formula preparation do not mutate the title or body");
    assert.equal(apiCalls, calls, "mounted titles require no additional title requests");

    // Pure formula titles and split text runs still participate in format enumeration.
    mount(formula());
    assert.equal((await search("α")).matches.length, 2);
    assert.equal((await search("", {restrictInlineTypes: ["inline-math"]})).matches.length, 1);
    mount("left" + formula() + '<span data-type="strong">needle</span><br>right');
    assert.equal((await search("", {restrictInlineTypes: ["strong"]})).matches[0]?.blockId, "__doc-title__");
    assert.equal((await search("needleright")).matches.length, 0);
    mount("   ");
    assert.equal((await search(" +", {regex: true})).matches.filter(hit => hit.blockId === "__doc-title__").length, 0);
    const native = document.createElement("div");
    native.innerHTML = lute.Md2BlockDOM("**needle** [link](https://example.com/hidden-target) `code`\n");
    mount(native.querySelector('[data-type="NodeParagraph"] > [contenteditable]').innerHTML);
    assert.equal((await search("needle|link|code", {regex: true})).matches.filter(hit => hit.blockId === "__doc-title__").length, 3);
    assert.equal((await search("hidden-target")).matches.length, 0, "link destinations are not title text");

    // A decorated formula must still use the selected formula representation.
    const decoratedFormula = formula().replace('data-type="inline-math"', 'data-type="strong inline-math"');
    title = mount(decoratedFormula + decoratedFormula);
    for (const sourceMode of [true, false]) {
        const options = {restrictInlineTypes: ["strong", "inline-math"], searchMathSource: sourceMode};
        const enumerated = await search("", options);
        assert.equal(enumerated.matches.length, 2);
        assert.ok(enumerated.matches.every(hit => hit.highlightKind === (sourceMode ? "math-source" : "inline-math")));
        assert.ok(enumerated.matches.every(hit => hit.matchedText === (sourceMode ? "\\alpha+\\alpha" : "α+α")));
        const selected = document.createRange();
        selected.selectNode(title.lastElementChild);
        window.getSelection().addRange(selected);
        assert.equal((await search("", {...options, selectionOnly: true})).matches.length, 1);
        window.getSelection().removeAllRanges();
    }
    const originalBody = wysiwyg.innerHTML;
    wysiwyg.innerHTML = lute.Md2BlockDOM("body\n");
    wysiwyg.querySelector("[contenteditable]").innerHTML = decoratedFormula;
    assert.equal((await search("", {includeDocTitle: false, restrictInlineTypes: ["strong", "inline-math"],
        searchMathSource: true})).matches[0]?.highlightKind, "math-source", "body formulas retain the same dedicated path");
    wysiwyg.innerHTML = originalBody;

    // Title OCR reuses the existing read-only, cached image pipeline.
    const imageDOM = document.createElement("div");
    imageDOM.innerHTML = lute.Md2BlockDOM("![image caption](assets/rich-title-regression.png)\n");
    const imageHTML = imageDOM.querySelector("[contenteditable]").innerHTML;
    title = mount(imageHTML);
    const imageSnapshot = title.innerHTML;
    let ocrReads = 0;
    responder = async url => {
        if (url === "/api/asset/getImageOCRText") {
            ocrReads++;
            return {code: 0, data: {text: "rich-title-image-ocr"}};
        }
        return {code: -1};
    };
    assert.equal((await search("rich-title-image-ocr", {includeDocTitle: false})).matches.length, 0);
    assert.equal((await search("rich-title-image-ocr", {includeImageOCR: false})).matches.length, 0);
    assert.equal((await search("", {restrictInlineTypes: ["strong"]})).matches.length, 0);
    assert.equal(ocrReads, 0, "disabled/unrelated scopes do not read title OCR");
    const ocr = await search("rich-title-image-ocr", {includeParagraph: false, includeImageTitle: false});
    assert.equal(ocr.matches.length, 1);
    assert.equal(ocrReads, 1);
    assert.equal(ocr.matches[0].blockId, "__doc-title__");
    assert.equal(ocr.matches[0].highlightKind, "image-ocr");
    assert.equal(ocr.matches[0].replaceable, false);
    assert.equal(visual.imageOCRFrameHost(ocr.matches[0].range), title.querySelector(".img img"));
    const imageSelection = document.createRange();
    imageSelection.selectNode(title.querySelector(".img"));
    window.getSelection().addRange(imageSelection);
    assert.equal((await search("rich-title-image-ocr", {selectionOnly: true})).matches.length, 0,
        "text-only selections do not implicitly include image OCR");
    window.getSelection().removeAllRanges();
    const imageScope = source("frontend/selection").selectionScopeFromHosts(collectSearchableBlocks(wrapper), [title]);
    assert.equal((await search("rich-title-image-ocr", {selectionOnly: true, selectionScope: imageScope})).matches.length, 1);
    await search("rich-title-image-ocr");
    assert.equal(ocrReads, 1, "repeat searches share the existing OCR cache");
    assert.equal(title.innerHTML, imageSnapshot, "OCR does not modify the title");

    let renders = 0;
    renderers.mathRender = root => {
        renders++;
        root.querySelectorAll('[data-type="inline-math"]').forEach(el => {
            el.innerHTML = '<span class="katex"><span class="katex-html" aria-hidden="true">α+α</span></span>';
            el.setAttribute("data-render", "true");
        });
    };
    title = mount(formula(false));
    const coldDOM = title.innerHTML;
    await search("α", {includeDocTitle: false});
    assert.equal(renders, 0, "disabled title search does not render hidden formula copies");
    assert.equal((await search("α", {includeTabs: false})).matches.length, 2, "cold title renders independently of tabs");
    assert.equal(renders, 1);
    assert.equal(title.innerHTML, coldDOM, "cold rendering uses only detached copies");
    await search("α");
    assert.equal(renders, 1, "unchanged source reuses the preview cache");

    // Rich title source refresh replaces the whole fragment outside the body wysiwyg.
    let mutations = 0;
    let settles = 0;
    let change;
    const stop = watchEditorDom(wrapper, {onMutate: () => mutations++, onSettled: value => { settles++; change = value; }}, 0);
    try {
        mount(html);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(mutations, 1, "title-fragment replacement invalidates live ranges");
        assert.equal(settles, 1);
        assert.equal(change.docTitleChanged, true);
        const bar = Object.create(SearchBar.prototype);
        let refreshed = 0;
        Object.assign(bar, {edit: wrapper, includeDocTitle: true, noteAddedBlocks() {},
            effectiveQuery: () => "needle", isRestrictEnumerateMode: () => false, canPaintHighlights: () => true,
            scheduleDomRefresh: () => refreshed++, searchCollectOptions: () => ({}),
            diagramSearchState: {changed: () => false}, embedSearchState: {changed: () => false},
            scheduleDiagramRefresh() { if (this.diagramRefreshPending) { refreshed++; this.diagramRefreshPending = false; } },
            repairHighlightRanges() {},
        });
        bar.onEditorDomSettled(change);
        assert.equal(refreshed, 1, "fragment refresh requests a new search, including newly added title hits");
        bar.includeDocTitle = false;
        bar.onEditorDomSettled(change);
        assert.equal(refreshed, 1, "disabled title search does not request extra searches");
    } finally { stop(); }

    // Pending title changes survive locating/replacement/search without polling.
    const delay = () => new Promise(resolve => setTimeout(resolve, 450));
    const pendingBar = Object.create(SearchBar.prototype);
    let refreshed = 0;
    Object.assign(pendingBar, {edit: wrapper, includeDocTitle: true, searchGeneration: 1, docTitleChangeSerial: 0,
        searchesInFlight: 0, replaceBusy: false, locatePending: false, resultMatches: [],
        pendingAddedBlocks: new Set(), searchText: "needle", effectiveQuery: () => "needle",
        isRestrictEnumerateMode: () => false, canPaintHighlights: () => !pendingBar.destroyed,
        searchResultKey: () => pendingBar.searchText, noteAddedBlocks() {}, searchCollectOptions: () => ({}),
        diagramSearchState: {changed: () => false, clear() {}, capture() {}},
        embedSearchState: {changed: () => false, clear() {}, capture() {}},
        highlightHitResult: async () => { refreshed++; pendingBar.diagramRefreshPending = false; },
    });
    const titleChange = {docTitleChanged: true, addedInBlocks: new Set(), diagramBlocks: new Set(), embedBlocks: new Set()};
    for (const busy of ["locatePending", "replaceBusy", "searchesInFlight"]) {
        pendingBar[busy] = busy === "searchesInFlight" ? 1 : true;
        pendingBar.onEditorDomSettled(titleChange);
        pendingBar.onEditorDomSettled(titleChange);
        await delay();
        const beforeRefresh = refreshed;
        assert.equal(pendingBar.diagramRefreshPending, true, `${busy} retains a title refresh request`);
        assert.equal(pendingBar.diagramRefreshTimer, undefined, "busy refresh does not poll");
        pendingBar[busy] = busy === "searchesInFlight" ? 0 : false;
        if (busy === "replaceBusy") pendingBar.finishReplacementRefresh();
        else await pendingBar.repairHighlightRanges(); // also called on native locating completion
        await delay();
        assert.equal(refreshed, beforeRefresh + 1, `${busy} completion runs one merged refresh`);
    }
    pendingBar.onEditorDomSettled(titleChange);
    pendingBar.searchText = "other query";
    const beforeQueryChange = refreshed;
    await delay();
    assert.equal(refreshed, beforeQueryChange, "obsolete query timers cannot restart a search");
    pendingBar.clearDiagramSearchState();
    // A mutation during an awaited OCR read happens after title units were collected.
    source("frontend/image-ocr").invalidateImageOCRCache();
    mount(imageHTML);
    pendingBar.resolveScopeForSearch = () => new Map();
    pendingBar.searchOptions = () => ({includeAttributeView: false});
    responder = async url => {
        if (url === "/api/asset/getImageOCRText") {
            mount("new title needle");
            pendingBar.onEditorDomSettled(titleChange);
            return {code: 0, data: {text: "rich-title-image-ocr"}};
        }
        return {code: -1};
    };
    await pendingBar.runSearchPipeline("needle", new AbortController().signal);
    assert.equal(pendingBar.diagramRefreshPending, true, "live-unit callback must not consume a newer title change");
    pendingBar.scheduleDiagramRefresh(); // calculateSearchResults finally releases the pending search
    await delay();
    assert.equal(refreshed, beforeQueryChange + 1);
    pendingBar.onEditorDomSettled(titleChange);
    pendingBar.destroyed = true;
    pendingBar.clearDiagramSearchState();
    await delay();
    assert.equal(refreshed, beforeQueryChange + 1, "closing the panel cancels pending refreshes");

    mount(html);

    // Exercise the full API corpus, including title source changes while body caches stay warm.
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run(bodyId, "root", "root", "p", "", "body needle", "body needle", "", "hash", "1");
    editors = [{protyle: {element: edit, lute, block: {id: "root", rootID: "root"}, notebookId: "n"}}];
    const urls = [];
    responder = async (url, payload) => {
        urls.push(url);
        if (url === "/api/query/sql") return {code: 0, data: db.prepare(payload.stmt).all()};
        if (url === "/api/block/getDocBlocksOrders") return {code: 0, data: [bodyId]};
        if (url === "/api/block/getBlockDOMs") return {code: 0, data: {[bodyId]: wysiwyg.firstElementChild.outerHTML}};
        if (url === "/api/asset/getImageOCRText") return {code: 0, data: {text: "rich-title-image-ocr"}};
        return {code: -1};
    };
    try {
        const options = {includeAttributeView: false, includeInlineMemo: true};
        const found = await corpus.searchCurrentDocument({}, wrapper, "needle|α", {...options, regex: true});
        assert.equal(found.matches.length, 7);
        assert.deepEqual(found.matches.map(hit => hit.highlightKind),
            ["text", "inline-math", "inline-math", "inline-memo", "inline-math", "inline-math", "text"]);
        assert.ok(found.matches.filter(hit => hit.blockId === "__doc-title__").every(hit => hit.range && !hit.replaceable));
        assert.ok(found.matches.filter(hit => hit.blockId === "__doc-title__").every(hit => hit.blockTypes.join() === "docTitle"));
        const titleHits = found.matches.filter(hit => hit.blockId === "__doc-title__");
        mount(html);
        const rebound = project.fillLiveRanges(titleHits, collectSearchableBlocks(wrapper, options), true);
        assert.ok(rebound.every(hit => hit.range && resolveDocTitleInput(wrapper).contains(hit.range.commonAncestorContainer)));
        assert.equal((await corpus.searchCurrentDocument({}, wrapper, "\\alpha", {...options, searchMathSource: true})).matches.length, 4);
        for (const sameText of [false, true]) {
            const memoHTML = ["one", sameText ? "one" : "two"].map(note =>
                formula().replace('data-type="inline-math"',
                    `data-type="inline-memo inline-math" data-inline-memo-content="memo-${note}"`)).join("");
            mount(memoHTML);
            const memoHits = (await corpus.searchCurrentDocument({}, wrapper, "memo-", options)).matches;
            assert.equal(memoHits.length, 2);
            title = mount(memoHTML); // native applyValue replaces the entire title fragment
            const live = collectSearchableBlocks(wrapper, options);
            const filled = project.fillLiveRanges(memoHits, live, true);
            const repaired = project.rebindChangedRanges(memoHits, live,
                new Map(memoHits.map(hit => [hit, {broken: true, blockShown: true}])), {allowFoldedHidden: false});
            for (const hits of [filled, repaired.matches]) {
                assert.deepEqual(hits.map(hit => hit.range?.startContainer), [...title.children],
                    "each composite title memo binds its own host even when text anchors collide");
                assert.ok(hits.every(hit => !hit.replaceable && !write.isMatchContentWritable({...hit, replaceable: true})));
            }
        }
        title = mount(imageHTML);
        const titleOCR = await corpus.searchCurrentDocument({}, wrapper, "rich-title-image-ocr", options);
        assert.equal(titleOCR.matches.length, 1);
        assert.equal(titleOCR.matches[0].highlightKind, "image-ocr");
        assert.ok(titleOCR.matches[0].range && !titleOCR.matches[0].replaceable);
        title = mount('<span data-type="strong">unsaved draft</span>');
        assert.equal((await corpus.searchCurrentDocument({}, wrapper, "unsaved draft", options)).matches.length, 1,
            "live draft wins over any persisted title summary");
        assert.ok(!urls.includes("/api/block/getDocTitle"));
    } finally {
        db.close();
        corpus.invalidateDocumentSearchCaches();
    }
    console.log("Rich document titles: inline text/math/memos, source mode, ordering, switches/selection, readonly, cold render, refresh and corpus projection OK");
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(setup + "\n" + main.toString() + "\nmain().catch(error => { console.error(error); process.exitCode = 1; });", __filename);
