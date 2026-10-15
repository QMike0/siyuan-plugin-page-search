// Replay SiYuan's tree -> savedoc -> asynchronous SQL -> databaseIndexCommit order.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const {DatabaseSync} = require("node:sqlite");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let api;
let editors = [];
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {fetchSyncPost: (...args) => api(...args), getAllEditor: () => editors, showMessage: () => {}};
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) =>
    mod._compile(
        ts.transpileModule(fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'), {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
            fileName: file,
        }).outputText,
        file,
    );
const source = file => require(path.join(repo, "src", file + ".ts"));
const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = dom.window;
global.document = window.document;
for (
    const name of ["Node", "Element", "HTMLElement", "Text", "NodeFilter", "ShadowRoot", "MutationObserver", "Range"]
) {
    global[name] = window[name];
}
global.CSS = {highlights: new Map(), escape: value => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Highlight = Set;
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
const {SearchBar} = source("frontend/search-bar");
const {matchTextUnitsDetailed} = source("shared/match-text");
const {watchEditorDom} = source("frontend/editor-dom-watch");
const corpus = source("frontend/corpus/search");
const db = new DatabaseSync(":memory:");
db.function(
    "search_normalize",
    (text, sensitive, _hanSensitive) => sensitive ? String(text) : String(text).toLowerCase(),
);
db.exec(
    "CREATE TABLE blocks(id TEXT, root_id TEXT, parent_id TEXT, type TEXT, subtype TEXT, content TEXT, markdown TEXT, ial TEXT, hash TEXT, updated TEXT)",
);
const insert = db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)");
const ids = ["loaded", "unloaded", "list-child", "fold-child"];
const order = ["loaded", "unloaded", "list", "list-item", "list-child", "unchanged", "heading", "fold-child"];
const originalTimeout = window.setTimeout.bind(window);
window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 400 ? 10 : delay, ...args);
const wait = ms => new Promise(resolve => originalTimeout(resolve, ms));
async function settle() {
    const until = Date.now() + 3000;
    await wait(40);
    while ((bar.typingTimer != null || bar.searchesInFlight) && Date.now() < until) await wait(20);
    assert.ok(bar.typingTimer == null && !bar.searchesInFlight, "event-driven search finishes");
}
let sqlCalls = 0;
let domIds = [];
let doms;
let bar;
const blockDom = (id, text) =>
    `<div data-node-id="${id}" data-type="NodeParagraph"><div contenteditable="true">${text}</div><div class="protyle-attr" contenteditable="false"></div></div>`;
function setTree(text, mounted = true) {
    doms = Object.fromEntries(ids.map(id => [id, blockDom(id, text)]));
    doms.unchanged = blockDom("unchanged", "foo");
    const content = bar.edit.querySelector('[data-node-id="loaded"] [contenteditable]');
    if (mounted && content) content.textContent = text;
}
function setSql(text) {
    // Keep updated and block count equal: timestamp/count signatures cannot identify undo.
    db.prepare("UPDATE blocks SET content=?, markdown=?, hash=? WHERE id IN (?,?,?,?)")
        .run(text, text, "hash-" + text, ...ids);
}
function savedoc(container = false) {
    bar.onEventBus({
        detail: {
            cmd: "savedoc",
            data: {
                rootID: "r",
                type: "tx",
                sources: [{
                    doOperations: (container ? ["loaded", "unloaded", "list", "fold-child"] : ids).map(id => ({
                        action: "update",
                        id,
                    })),
                }],
            },
        },
    });
}
function indexCommit(roots = ["r"], extra = {}) {
    bar.onEventBus({
        detail: {
            cmd: "databaseIndexCommit",
            data: {rootIDs: roots, backlinkChanged: true, backlinkFull: false, ...extra},
        },
    });
}
function fixture() {
    corpus.invalidateDocumentSearchCaches();
    db.exec("DELETE FROM blocks");
    for (const id of order) {
        const type = id === "list" ? "l" : id === "list-item" ? "i" : id === "heading" ? "h" : "p";
        const parent = id === "list-item" ? "list" : id === "list-child" ? "list-item" : "r";
        insert.run(
            id,
            "r",
            parent,
            type,
            "",
            type === "p" ? "foo" : "",
            "",
            id === "heading" ? 'fold="1"' : "",
            "hash-foo",
            "same-second",
        );
    }
    const edit = document.createElement("div");
    edit.className = "layout-tab-container";
    edit.innerHTML = `<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg">${
        blockDom("loaded", "foo")
    }<div data-node-id="heading" data-type="NodeHeading" fold="1">heading</div></div></div></div><div class="search-root"></div>`;
    document.body.appendChild(edit);
    editors = [{protyle: {element: edit.querySelector(".protyle"), notebookId: "", block: {id: "r", rootID: "r"}}}];
    bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {
        edit,
        root: edit.lastElementChild,
        plugin: {isLastHighlightComponent: () => false},
        i18n: {},
        searchText: "foo",
        resultMatches: [],
        resultCount: 0,
        resultIndex: 0,
        searchGeneration: 0,
        domEpoch: 0,
        documentEpoch: 0,
        searchesInFlight: 0,
        includeAttributeView: false,
        includeFoldedBlocks: true,
        pendingDocumentCountDisplay: null,
        regexMatcher: {match: async (units, query, options) => matchTextUnitsDetailed(units, query, options)},
        syncBackgroundCorpusRoot: () => "r",
        rememberCurrentRootId: () => "r",
        documentSearchIndices: {activeRoot: "r", consumePending: () => null},
        clearDocumentSearchIndices: () => {},
        getSearchAnchorRange: () => null,
        syncIndexingIndicator: () => {},
        updateCountLabel: () => {},
        syncReplaceButtons: () => {},
        noteSearchCoverage: (degraded, partial, unrendered) => {
            assert.ok(!degraded && !partial && !unrendered, "healthy undo is a complete search");
        },
        clearHighlight: () => {},
        scheduleDiagramRefresh: () => {},
        onLiveUnitsCollected: () => {},
        repairAfterSearchIfNeeded: () => {},
        applyResultHighlightsWithBudget: async () => true,
        scrollIntoRanges: () => {},
    });
    // Preserve the real search pipeline and savedoc/DOM replay guards; avoid unrelated renderer state.
    bar.runSearchPipeline = (value, signal) =>
        source("frontend/pipeline").calculateSearchMatches({}, edit, value, {
            includeAttributeView: false,
            includeFoldedBlocks: bar.includeFoldedBlocks,
            regex: bar.regex,
            signal,
        });
    sqlCalls = 0;
    domIds = [];
    setTree("foo");
    return bar;
}
api = async (url, body) => {
    if (url === "/api/query/sql") {
        sqlCalls++;
        return {code: 0, data: db.prepare(body.stmt).all()};
    }
    if (url === "/api/block/getDocBlocksOrders") return {code: 0, data: order};
    if (url.includes("getHeadingChildren")) return {code: 0, data: ["fold-child"]};
    if (url === "/api/block/getBlockDOMs") {
        domIds.push(...body.ids);
        return {code: 0, data: Object.fromEntries(body.ids.filter(id => doms[id]).map(id => [id, doms[id]]))};
    }
    throw new Error("Unexpected API: " + url);
};
async function main() {
    for (const regex of [false, true]) {
        for (const staleReplaceSql of [false, true]) {
            fixture();
            bar.regex = regex;
            await bar.highlightHitResult("foo", true);
            assert.equal(bar.resultCount, 5, "initial loaded/unloaded/list/folded/unchanged matches");
            setTree("bar");
            if (!staleReplaceSql) setSql("bar");
            savedoc(true);
            // The real writer invalidates its submitted block IDs after confirmation.
            corpus.invalidateEditedDocument("r", ids);
            await settle();
            assert.equal(bar.resultCount, 1, "replace-all removes only writable targets");
            // Simulate Ctrl+Z after the completed plugin refresh, before SQL catches up.
            setSql("bar");
            savedoc(true);
            setTree("foo");
            bar.domEpoch++;
            await settle();
            assert.equal(
                bar.resultCount,
                2,
                `the stale SQL snapshot reproduces loaded-only undo count (${regex}/${staleReplaceSql})`,
            );
            setSql("foo");
            domIds = [];
            if (staleReplaceSql) indexCommit([], {backlinkFull: true});
            else indexCommit();
            await settle();
            assert.equal(bar.resultCount, 5, "SQL commit restores all offscreen undo matches");
            assert.ok(!domIds.includes("unchanged"), "unchanged offscreen blocks reuse their cache");
            assert.ok(domIds.includes("list-child"), "updating a list invalidates descendant text caches");
            const countCalls = sqlCalls;
            indexCommit(["other-document"]);
            indexCommit([], {backlinkChanged: false});
            await wait(80);
            assert.equal(sqlCalls, countCalls, "unrelated/empty index commits do not rescan this document");
            await wait(80);
            assert.equal(sqlCalls, countCalls, "refresh settles without polling");
            bar.includeFoldedBlocks = false;
            await bar.highlightHitResult("foo", false);
            assert.equal(bar.resultCount, 4, "folded content option still controls the scope");
            setTree("bar");
            savedoc(true);
            setSql("bar");
            indexCommit();
            await settle();
            assert.equal(bar.resultCount, 1, "redo removes offscreen matches again");
            bar.edit.remove();
        }
    }
    console.log(
        "Replace-all -> undo/redo: literal/regex, stale candidates/hashes, list descendants, unloaded/folded scope, cache reuse and bounded refresh OK",
    );

    for (const lateDom of [false, true]) {
        fixture();
        if (!lateDom) bar.edit.querySelector('[data-node-id="loaded"]').remove();
        Object.assign(bar, {
            pendingAddedBlocks: new Set(),
            diagramSearchState: {changed: () => false},
            embedSearchState: {changed: () => false},
            repairHighlightRanges: async () => {},
        });
        const stop = watchEditorDom(bar.edit, {
            onMutate: () => bar.domEpoch++,
            onSettled: change => bar.onEditorDomSettled(change),
        }, 1);
        await bar.highlightHitResult("foo", true);
        setTree("bar");
        setSql("bar");
        savedoc();
        await settle();
        assert.equal(bar.resultCount, 1);
        setTree("foo", false);
        savedoc();
        await settle();
        setSql("foo");
        indexCommit();
        await settle();
        assert.equal(bar.resultCount, lateDom ? 4 : 5, "SQL commit restores offscreen blocks without local DOM replay");
        if (lateDom) {
            setTree("foo");
            await settle();
            assert.equal(bar.resultCount, 5, "DOM replay after SQL refresh retains the full document count");
        }
        stop();
        bar.edit.remove();
    }
    console.log(
        "SQL index commit before local undo DOM replay, entirely unloaded targets and folded heading children OK",
    );

    fixture();
    setTree("bar");
    setSql("bar");
    await bar.highlightHitResult("foo", true);
    setTree("foo");
    savedoc();
    window.clearTimeout(bar.typingTimer);
    bar.typingTimer = undefined;
    const read = api;
    let finish;
    let started;
    const blocked = new Promise(resolve => started = resolve);
    let hold = true;
    api = async (...args) => {
        const response = await read(...args);
        if (hold && args[0] === "/api/query/sql" && args[1].stmt.startsWith("SELECT id FROM blocks")) {
            hold = false;
            started();
            await new Promise(resolve => finish = resolve);
        }
        return response;
    };
    const pending = bar.highlightHitResult("foo", false);
    await blocked;
    setSql("foo");
    indexCommit();
    finish();
    await pending;
    await settle();
    assert.equal(bar.resultCount, 5, "a late pre-commit candidate read cannot overwrite/cache stale undo results");
    api = read;
    bar.edit.remove();
    console.log("SQL index commit aborts in-flight stale candidate reads and guards cache publication OK");

    fixture();
    order.push("embed");
    insert.run("embed", "r", "r", "query_embed", "", "", "select * from blocks", "", "embed-hash", "same-second");
    doms.embed = '<div data-node-id="embed" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
    let embedReads = 0;
    const embedApi = api;
    api = async (url, ...args) => {
        if (url !== "/api/search/searchEmbedBlock") return embedApi(url, ...args);
        embedReads++;
        // Dynamic queries can produce a different derived SQL index on every read.
        const text = (embedReads === 1 ? "foo" : "foo foo") + " " + embedReads;
        db.prepare("UPDATE blocks SET content=? WHERE id='embed'").run(text);
        originalTimeout(() => indexCommit(), 40);
        return {
            code: 0,
            data: {
                blocks: [{
                    block: {
                        id: "embed-source",
                        rootID: "source-root",
                        content: blockDom("embed-source", text),
                    },
                }],
            },
        };
    };
    await bar.highlightHitResult("foo", true);
    await wait(200);
    await settle();
    assert.equal(bar.resultCount, 6);
    assert.equal(embedReads, 1, "derived index commits reuse the embed query cache instead of feeding a query loop");
    savedoc();
    await wait(200);
    await settle();
    assert.equal(bar.resultCount, 7, "actual content saves still refresh embed query results");
    assert.equal(embedReads, 2, "the refreshed embed's own index commit does not query it again");
    api = embedApi;
    order.pop();
    bar.edit.remove();
    console.log(
        "Dynamic embedded queries: derived SQL commits do not cause repeated requests; actual savedoc still refreshes content OK",
    );
}
main().then(() => {
    db.close();
    window.close();
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
    window.close();
});
