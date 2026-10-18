// Direct-source fault injection; does not write a real notebook or exercise host keyboard history.
// Optional argument: the installed SiYuan lute.min.js, for native content normalization.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let editors = [];
let api;
const messages = [];
const hiddenMessages = [];
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {
            getAllEditor: () => editors,
            fetchSyncPost: (...args) => api(...args),
            confirm: (_title, _message, yes) => yes(),
            showMessage: (text, _timeout, type, id) => messages.push({text, type, id}),
            hideMessage: id => hiddenMessages.push(id),
        };
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    let code = fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"');
    if (file.endsWith("replacement-commit.ts")) {
        // Scale only the wait/backoff clock; keep production logic, batching and result checks.
        code = code.replace("COMMIT_WAIT_MS = 8000", "COMMIT_WAIT_MS = 300")
            .replace('notify(observer, "pending"), 500', 'notify(observer, "pending"), 30')
            .replace("let delay = 120", "let delay = 10")
            .replace("delay * 2, 1000", "delay * 2, 40");
    }
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
global.CSS = {escape: value => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() {
        return this.textContent;
    },
    configurable: true,
});
let lute;
if (process.argv[2]) {
    require(path.resolve(process.argv[2]));
    lute = (window.Lute ?? global.Lute).New();
    for (const name of ["SetTextMark", "SetBlockRef", "SetKramdownIAL", "SetProtyleWYSIWYG", "SetHTMLTag2TextMark"]) {
        lute[name](true);
    }
}
const source = file => require(path.join(repo, "src", file + ".ts"));
const write = source("frontend/protyle-write");
const commit = source("frontend/replacement-commit");
const blocks = source("frontend/blocks");
const matcher = source("shared/match-text");
const {SearchBar} = source("frontend/search-bar");
const corpus = source("frontend/corpus/search");
const id = "20261013120000-abcdefg";
const otherId = "20261013120000-hijklmn";
const referenceId = "20261012120000-opqrstu";
const paragraph = (blockId, text) =>
    `<div data-node-id="${blockId}" data-type="NodeParagraph"><div contenteditable="true">${text}</div><div class="protyle-attr"></div></div>`;
const reference = text => `<span data-type="strong block-ref" data-subtype="d" data-id="${referenceId}">${text}</span>`;
const normalize = html => lute ? lute.SpinBlockDOM(html) : html;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(contents = [paragraph(id, "foo")], mode = "success") {
    document.body.innerHTML =
        '<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"></div></div></div>';
    const edit = document.querySelector(".protyle");
    const wysiwyg = edit.querySelector(".protyle-wysiwyg");
    wysiwyg.innerHTML = contents.join("");
    const kernel = new Map(Array.from(wysiwyg.children, element => [element.dataset.nodeId, element.outerHTML]));
    const calls = [];
    const requests = [];
    let afterWriteReads = 0;
    let queued;
    const persist = operations => {
        for (const op of operations) {
            kernel.set(op.id, normalize(op.data));
            // The native tree shares children with their containing block DOM.
            for (const [parentId, html] of kernel) {
                if (parentId === op.id || !html.includes(`data-node-id="${op.id}"`)) continue;
                const parent = document.createElement("template");
                parent.innerHTML = html;
                const child = parent.content.querySelector(`[data-node-id="${op.id}"]`);
                if (child) {
                    child.outerHTML = normalize(op.data);
                    kernel.set(parentId, parent.innerHTML);
                }
            }
        }
    };
    function submit(operations, undo) {
        calls.push({operations, undo});
        if (mode === "throw-before") throw new Error("synchronous queue rejection");
        for (const op of operations) {
            const lives = mode === "throw-after-all" ?
                wysiwyg.querySelectorAll(`[data-node-id="${op.id}"]`) :
                [wysiwyg.querySelector(`[data-node-id="${op.id}"]`)].filter(Boolean);
            for (const live of lives) {
                const selection = window.getSelection();
                if (selection?.rangeCount && live.contains(selection.getRangeAt(0).startContainer)) continue;
                live.outerHTML = normalize(op.data);
            }
        }
        if (mode === "throw-after" || mode === "throw-after-all") throw new Error("native optimistic rendering failed");
        if (mode === "new-edit-then-throw") {
            wysiwyg.querySelector('[contenteditable="true"]').textContent = "new user edit";
            throw new Error("sync handler failed after a new edit");
        }
        queued = operations;
        if (mode === "success") persist(operations);
        if (mode === "partial") persist(operations.slice(0, 1));
    }
    const protyle = {
        protyle: {element: edit, notebookId: "", block: {rootID: "r", id: "r"}, disabled: false, lute},
        transaction: submit,
        updateTransactionElement: (element, before) =>
            submit(
                [{id: element.dataset.nodeId, action: "update", data: element.outerHTML}],
                [{id: element.dataset.nodeId, action: "update", data: before}],
            ),
    };
    editors = [protyle];
    api = async (url, body) => {
        requests.push({url, ids: body.ids});
        assert.ok(url.endsWith("getBlockDOMs"), "must not resend a failed write or poll hashes");
        if (queued) {
            afterWriteReads++;
            if (mode === "delayed" && afterWriteReads === 4) persist(queued);
            if (mode === "http-error") return {code: -1, msg: "request rejected"};
            if (mode === "network-error") throw new Error("HTTP disconnected");
            if (mode === "unrelated") kernel.set(id, paragraph(id, "someone else's edit"));
            if (mode === "missing") return {code: 0, data: {}};
        }
        return {code: 0, data: Object.fromEntries(body.ids.map(blockId => [blockId, kernel.get(blockId)]))};
    };
    const matches = matcher.matchTextUnitsDetailed(
        blocks.collectSearchableBlocks(edit, {includeDocTitle: false, includeInlineMemo: true, includeImageTitle: true})
            .map(unit => ({...unit, segmentLengths: unit.textNodes.map(node => node.length)})),
        "foo",
    ).hits;
    return {edit, wysiwyg, kernel, protyle, calls, requests, matches, persist: () => persist(queued)};
}
const run = (f, all, options = {}, text = "bar") =>
    all ?
        write.replaceAllMatchesInEditor(f.edit, f.matches, text, options) :
        write.replaceCurrentMatchInEditor(f.edit, f.matches[0], text, options);

function barFixture(f) {
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {
        edit: f.edit,
        plugin: {},
        searchText: "foo",
        replaceText: "bar",
        resultCount: f.matches.length,
        resultIndex: 1,
        resultMatches: f.matches,
        resultBlockTypes: [],
        resultSearchKey: "key",
        resultSelectionScope: null,
        searchGeneration: 1,
        replaceBusy: false,
        destroyed: false,
        searchCoverageIncomplete: false,
        hasCurrentSearchResults: () => true,
        hasStableReplaceAllSnapshot: () => true,
        isRestrictEnumerateMode: () => false,
        getCurrentMatch: () => f.matches[0],
        highlightHitResult: async () => {},
        clearHighlight: () => {},
        updateCountLabel: () => {},
        scrollIntoRanges: () => {},
        scheduleDiagramRefresh: () => {},
        i18n: {
            replaceAllConfirm: "{count}",
            replaceAllConfirmTitle: "replace",
            replaceCurrentDone: "SUCCESS current",
            replaceAllResult: "SUCCESS all {replacedCount}",
            replaceCommitPending: "PENDING",
            replaceCommitUnknown: "UNKNOWN {replacedCount}/{submittedCount}",
            replaceCommitFailed: "FAILED",
        },
    });
    return bar;
}

function makeDestroyable(bar) {
    Object.assign(bar, {
        root: document.createElement("div"),
        regexMatcher: {dispose: () => {}},
        backgroundCorpusRootId: "r",
        plugin: {onSearchComponentUnmounted: () => {}},
        closeSettingsMenu: () => {},
        closeSearchMethodMenu: () => {},
        teardownSelectionScopeLayoutSync: () => {},
        teardownMemoUnderlineLayoutSync: () => {},
        clearSelectionScopeVisual: () => {},
        closeResultsPanel: () => {},
        clearDiagramSearchState: () => {},
    });
    document.body.append(bar.root);
    corpus.retainBackgroundCorpusRoot("r");
    return bar;
}

async function main() {
    const expansionMatcher = {
        expandReplacements: async (requests, pattern, template, options) => ({
            expansions: source("shared/regex-replace").expandRegexReplacementUnits(
                requests,
                pattern,
                template,
                options,
            ),
            error: "",
        }),
    };
    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const f = fixture([
                paragraph(
                    id,
                    '<span data-type="inline-memo" data-inline-memo-content="&lt;strong&gt;foo&lt;/strong&gt;">host</span>',
                ),
            ]);
            const unit = blocks.collectSearchableBlocks(f.edit, {includeDocTitle: false, includeInlineMemo: true})
                .find(unit => unit.matchSource === "inline-memo");
            f.matches = f.matches.map(hit => ({
                ...hit,
                replaceable: true,
                highlightKind: "inline-memo",
                anchorOffset: unit.anchorOffset,
            }));
            const before = f.kernel.get(id);
            if (fetched) f.wysiwyg.innerHTML = "";
            const result = await run(f, all, {}, "foo");
            assert.equal(result.unchanged, true);
            assert.equal(result.replacedCount, 1);
            assert.equal(f.calls.length, 0, "formatted memo no-op creates no history");
            assert.equal(f.kernel.get(id), before, "memo no-op preserves raw HTML formatting");
            assert.equal(f.requests.length, fetched ? 2 : 0, "authoritative no-op validation remains intact");
        }
    }
    for (const all of [false, true]) {
        for (const options of [{}, {preserveCase: true}, {regex: true, regexMatcher: expansionMatcher}]) {
            const f = fixture([paragraph(id, "foo foo")]);
            const bar = barFixture(f);
            delete bar.getCurrentMatch;
            Object.assign(bar, options, {replaceText: options.regex ? "$&" : "foo"});
            let refreshes = 0;
            bar.highlightHitResult = async () => {
                refreshes++;
            };
            if (all) await bar.clickReplaceAll();
            else await bar.clickReplace();
            assert.equal(f.calls.length, 0);
            assert.equal(refreshes, 0, "unchanged replacement skips redundant full search");
            assert.equal(bar.resultIndex, all ? 1 : 2, "single no-op advances without modifying result data");
            if (!all) {
                await bar.clickReplace();
                assert.equal(bar.resultIndex, 1, "no-op wraps to the first target");
            }
        }
    }
    const pendingNoop = barFixture(fixture());
    pendingNoop.replaceText = "foo";
    pendingNoop.replaceRefreshPending = true;
    let externalRefreshes = 0;
    pendingNoop.highlightHitResult = async () => {
        externalRefreshes++;
    };
    await pendingNoop.clickReplace();
    await delay(10);
    assert.equal(externalRefreshes, 1, "no-op keeps refreshes requested by external document events");

    for (const fetched of [false, true]) {
        for (const [query, text, regex] of [["foo", "fooX", false], ["foo", "bar", false], ["(foo)", "$1XX", true]]) {
            const f = fixture([paragraph(id, "foo foo"), paragraph(otherId, "foo")]);
            const bar = barFixture(f);
            delete bar.getCurrentMatch;
            Object.assign(bar, {searchText: query, replaceText: text, regex, regexMatcher: expansionMatcher});
            const refresh = () => {
                const host = document.createElement("div");
                host.setAttribute("data-page-search-offscreen", "true");
                host.innerHTML = '<div class="protyle-wysiwyg">' + [...f.kernel.values()].join("") + "</div>";
                document.body.append(host);
                const units = blocks.collectSearchableBlocks(host, {includeDocTitle: false});
                bar.resultMatches = matcher.matchTextUnitsDetailed(
                    units.map(unit => ({
                        ...unit,
                        segmentLengths: unit.textNodes.map(node => node.length),
                    })),
                    query,
                    {regex},
                ).hits;
                bar.resultCount = bar.resultMatches.length;
                host.remove();
            };
            bar.highlightHitResult = async () => refresh();
            refresh();
            if (fetched) f.wysiwyg.innerHTML = "";
            await bar.clickReplace();
            assert.equal(bar.getCurrentMatch().blockId, id);
            assert.equal(bar.getCurrentMatch().start, text === "bar" ? 4 : regex ? 6 : 5);
            await bar.clickReplace();
            assert.equal(bar.getCurrentMatch().blockId, otherId, "advance across blocks, including offscreen targets");
            assert.equal(f.calls.length, 2);
            assert.ok(
                f.kernel.get(id).includes(text === "bar" ? "bar bar" : regex ? "fooXX fooXX" : "fooX fooX"),
                "successive replacements process each original occurrence once",
            );
            await bar.clickReplace();
            assert.equal(bar.resultCount, text === "bar" ? 0 : 3);
            if (bar.resultCount) {
                assert.equal(bar.getCurrentMatch().blockId, id);
                assert.equal(bar.getCurrentMatch().start, 0, "last original target wraps to the first");
            }
            const firstWrite = f.calls[0];
            f.protyle.transaction(firstWrite.undo, firstWrite.operations);
            assert.ok(f.kernel.get(id).includes("foo foo"), "native undo payload remains unchanged");
        }
    }
    const nextIndex = source("frontend/match-anchor").resolveNextReplacementMatchIndex;
    const hit = (unitId, start, end = start + 3) => ({blockId: id, unitId, start, end, matchedText: "foo"});
    const oldCurrent = hit("table-cell:0:0", 0);
    const oldNext = hit("table-cell:0:1", 0);
    assert.equal(
        nextIndex([oldCurrent, oldNext], oldCurrent, oldNext, 4),
        2,
        "table cell identity beats numeric index",
    );
    const memo = {...hit("inline-memo:7", 0), highlightKind: "inline-memo", anchorOffset: 6};
    assert.equal(
        nextIndex([{...memo, unitId: "inline-memo:0", start: 4, end: 7}], memo, {...memo, start: 4, end: 7}, 3),
        1,
        "memo identity uses the owner anchor rather than global ordinal",
    );
    assert.equal(
        nextIndex([hit(undefined, 0), {...memo, anchorOffset: 7}], hit(undefined, 0), memo, 4),
        2,
        "body length change moves the next memo's host anchor",
    );
    assert.equal(
        nextIndex([hit(undefined, 0, 0), hit(undefined, 2, 2)], hit(undefined, 0, 0), hit(undefined, 2, 2), 0),
        2,
        "zero-width navigation advances to the original next boundary",
    );
    console.log("No-op memo/preserve-case/regex, no redundant refresh, identity advancement, offscreen and undo OK");

    const extract = source("frontend/corpus/extract");
    const originalExtract = extract.extractUnitsFromDoms;
    const originalCollect = blocks.collectSearchableBlocks;
    const originalClone = Node.prototype.cloneNode;

    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const f = fixture();
            if (fetched) f.wysiwyg.innerHTML = "";
            let collections = 0;
            blocks.collectSearchableBlocks = (...args) => {
                collections++;
                return originalCollect(...args);
            };
            try {
                const result = await run(f, all, {isCurrent: () => false});
                assert.equal(result.error, "stale-target");
                assert.equal(collections, 0, "an already invalid operation never collects replacement text");
                assert.equal(f.requests.length, 0, "an already invalid operation never starts a read");
                assert.equal(f.calls.length, 0);
            } finally {
                blocks.collectSearchableBlocks = originalCollect;
            }
        }
    }

    // A cancelled wave may finish its existing requests, but must not parse,
    // clone or start the next wave. Revalidation follows the same rule.
    for (const phase of ["prepare-read", "revalidate-read"]) {
        for (const change of ["query", "readonly", "root", "owner", "detach"]) {
            const f = fixture(
                Array.from(
                    {length: 257},
                    (_, index) => paragraph("20261015120000-" + index.toString(36).padStart(7, "0"), "foo"),
                ),
            );
            f.wysiwyg.innerHTML = "";
            let current = true;
            let extracted = 0;
            let cloned = 0;
            const read = api;
            const invalidateAt = phase === "prepare-read" ? 1 : 6;
            api = async (...args) => {
                const response = await read(...args);
                if (f.requests.length >= invalidateAt) {
                    if (change === "query") current = false;
                    if (change === "readonly") f.protyle.protyle.disabled = true;
                    if (change === "root") f.protyle.protyle.block.rootID = "other-doc";
                    if (change === "owner") editors = [];
                    if (change === "detach") f.edit.remove();
                }
                return response;
            };
            extract.extractUnitsFromDoms = (...args) => {
                extracted++;
                return originalExtract(...args);
            };
            Node.prototype.cloneNode = function(...args) {
                if (this instanceof Element && this.hasAttribute("data-node-id")) cloned++;
                return originalClone.apply(this, args);
            };
            try {
                const result = await run(f, true, {isCurrent: () => current});
                assert.equal(result.error, change === "readonly" ? "readonly-or-preview" : "stale-target");
                assert.equal(result.replacedCount, 0);
                assert.equal(f.calls.length, 0, "cancelled preparations never submit partial updates");
                assert.equal(
                    f.requests.length,
                    phase === "prepare-read" ? 4 : 9,
                    "cancellation stops subsequent read waves, including snapshot revalidation",
                );
                assert.equal(extracted, phase === "prepare-read" ? 0 : 5);
                assert.equal(cloned, phase === "prepare-read" ? 0 : 257);
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            } finally {
                api = read;
                extract.extractUnitsFromDoms = originalExtract;
                Node.prototype.cloneNode = originalClone;
            }
        }
    }

    // Extraction and Worker awaits are separate cancellation boundaries. In
    // either case the offscreen host must be disposed before returning.
    for (const all of [false, true]) {
        for (const phase of ["extracted", "worker"]) {
            const f = fixture(
                Array.from(
                    {length: all ? 65 : 1},
                    (_, index) => paragraph("20261015130000-" + index.toString(36).padStart(7, "0"), "foo"),
                ),
            );
            f.wysiwyg.innerHTML = "";
            let current = true;
            let extracted = 0;
            let cloned = 0;
            let workerCalls = 0;
            extract.extractUnitsFromDoms = async (...args) => {
                const result = await originalExtract(...args);
                extracted++;
                if (phase === "extracted") current = false;
                return result;
            };
            Node.prototype.cloneNode = function(...args) {
                if (this instanceof Element && this.hasAttribute("data-node-id")) cloned++;
                return originalClone.apply(this, args);
            };
            try {
                const result = await run(f, all, {
                    regex: true,
                    searchQuery: "foo",
                    isCurrent: () => current,
                    regexMatcher: {
                        expandReplacements: async requests => {
                            // replace-all also prepares an empty loaded plan first.
                            if (requests.length) {
                                workerCalls++;
                                current = false;
                            }
                            return {expansions: [], cancelled: !current, error: ""};
                        },
                    },
                });
                assert.equal(result.error, "stale-target", "cancellation is not reported as an expansion failure");
                assert.equal(extracted, 1, "later fetched batches are not extracted");
                assert.equal(workerCalls, phase === "extracted" ? 0 : 1);
                assert.equal(cloned, 0, "cancelled extraction/expansion never clones a target");
                assert.equal(f.calls.length, 0);
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            } finally {
                extract.extractUnitsFromDoms = originalExtract;
                Node.prototype.cloneNode = originalClone;
            }
        }
    }
    console.log(
        "Preparation cancellation: current/all, initial/read/extract/Worker/revalidation boundaries and host cleanup OK",
    );

    const sparse = fixture([
        paragraph(id, '<span data-type="inline-memo" data-inline-memo-content="unrelated memo">other</span>'),
        ...Array.from(
            {length: 96},
            (_, index) => paragraph("20261015140000-" + index.toString(36).padStart(7, "0"), "unrelated text"),
        ),
        paragraph(otherId, 'foo <span data-type="inline-memo" data-inline-memo-content="memo foo">anchor</span>'),
    ]);
    // MatchHit is DOM-free. Mirror the frontend's memo hydration so the
    // global memo ordinal and stable owner anchor both reach the write layer.
    const sparseUnits = originalCollect(sparse.edit, {includeDocTitle: false, includeInlineMemo: true});
    sparse.matches = sparse.matches.map(hit => {
        if (!hit.unitId?.startsWith("inline-memo:")) return hit;
        const unit = sparseUnits.find(unit => unit.blockId === hit.blockId && unit.unitId === hit.unitId);
        return {...hit, replaceable: true, highlightKind: "inline-memo", anchorOffset: unit.anchorOffset};
    });
    assert.ok(sparse.matches.some(hit => hit.unitId === "inline-memo:1"));
    const unrelatedHtml = sparse.kernel.get(id);
    let liveCollections = 0;
    blocks.collectSearchableBlocks = (edit, options) => {
        const result = originalCollect(edit, options);
        if (edit === sparse.edit) {
            liveCollections++;
            assert.deepEqual(options.scopeRoots.map(root => root.dataset.nodeId), [otherId]);
            assert.ok(result.every(unit => unit.blockId === otherId), "unrelated text units are never collected");
        }
        return result;
    };
    try {
        const result = await run(sparse, true);
        assert.equal(result.commitState, "confirmed");
        assert.equal(result.replacedCount, 2, "memo identity/anchor offsets survive narrower collection");
        assert.equal(liveCollections, 1);
        assert.equal(sparse.calls.length, 1);
        assert.equal(sparse.calls[0].operations.length, 1);
        assert.equal(sparse.kernel.get(id), unrelatedHtml);
        assert.ok(sparse.kernel.get(otherId).includes('data-inline-memo-content="memo bar"'));
        sparse.protyle.transaction(sparse.calls[0].undo, sparse.calls[0].operations);
        assert.ok(sparse.kernel.get(otherId).includes('data-inline-memo-content="memo foo"'));
    } finally {
        blocks.collectSearchableBlocks = originalCollect;
    }
    console.log(
        "Sparse loaded replacement: affected roots only, scoped memo offsets, unchanged neighbors and native undo OK",
    );

    for (const layout of ["mindmap", "tabs", "folded-list"]) {
        const child = paragraph(otherId, "foo");
        const contents = layout === "mindmap" ?
            `<div data-node-id="${id}" data-type="NodeMindmap" class="mindmap" data-mindmap-view-rendered="true">` +
            '<div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' + child + "</div>" +
            `<div class="mindmap-view"><div data-mindmap-source-id="${otherId}">foo</div></div></div>` :
            layout === "tabs" ?
            `<div data-node-id="${id}" data-type="NodeTabs" class="tabs"><div class="tab-item" data-tabs-hidden="true">` +
            '<div class="tab-item-info">' + child + "</div></div></div>" :
            `<div data-node-id="${id}" data-type="NodeListItem" class="li" fold="1"><div></div><div></div>` + child +
            "</div>";
        const f = fixture([contents]);
        const style = document.createElement("style");
        style.textContent = '.mindmap > .mindmap-item, .tabs > .tab-item[data-tabs-hidden="true"], ' +
            '.li[fold="1"] > div:nth-child(n+3) {display:none}';
        document.head.append(style);
        const units = originalCollect(f.edit, {includeDocTitle: false, includeMindmapSourceForReplace: true})
            .filter(unit => unit.blockId === otherId && unit.matchSource !== "projection");
        f.matches = matcher.matchTextUnitsDetailed(
            units.map(unit => ({
                ...unit,
                segmentLengths: unit.textNodes.map(node => node.length),
            })),
            "foo",
        ).hits;
        assert.equal(f.matches.length, 1, layout + " retains one authoritative source match");
        f.kernel.set(otherId, child);
        try {
            const result = await run(f, true);
            assert.equal(
                result.commitState,
                "confirmed",
                layout + " source remains writable after narrowing collection",
            );
            assert.equal(result.replacedCount, 1);
            assert.equal(f.calls.length, 1);
            assert.equal(f.calls[0].undo.length, 1);
            assert.ok(f.kernel.get(otherId).includes(">bar</div>"));
            f.protyle.transaction(f.calls[0].undo, f.calls[0].operations);
            assert.ok(f.kernel.get(otherId).includes(">foo</div>"));
        } finally {
            style.remove();
        }
    }

    const virtual = fixture([
        `<div data-node-id="${id}" data-type="NodeTable" class="table"><div><table>` +
        "<thead><tr><th>foo</th></tr></thead><tbody><tr><td>foo</td></tr><tr><td>keep</td></tr></tbody>" +
        '</table></div><div class="protyle-attr"></div></div>',
    ]);
    const hiddenRow = virtual.wysiwyg.querySelector("tbody tr");
    hiddenRow.setAttribute("data-sy-table-virtual-rows", hiddenRow.outerHTML);
    hiddenRow.innerHTML = "<td></td>";
    blocks.collectSearchableBlocks = (edit, options) => {
        assert.notEqual(edit, virtual.edit, "a virtual table uses full kernel DOM, not partial live collection");
        return originalCollect(edit, options);
    };
    try {
        const result = await run(virtual, true);
        assert.equal(result.commitState, "confirmed");
        assert.equal(result.replacedCount, 2, "mounted and virtualized cells both enter the replacement");
        assert.equal(virtual.calls.length, 1);
        assert.ok(virtual.kernel.get(id).includes("keep"));
        assert.ok(!virtual.calls[0].undo[0].data.includes("data-sy-table-virtual-rows"));
        virtual.protyle.transaction(virtual.calls[0].undo, virtual.calls[0].operations);
        assert.equal((virtual.kernel.get(id).match(/>foo</g) ?? []).length, 2);
    } finally {
        blocks.collectSearchableBlocks = originalCollect;
    }
    console.log("Scoped mindmap/inactive-tab/folded source writes and virtual-table full-DOM replace/undo OK");

    const regexBudget = source("shared/regex-budget");
    const expand = source("shared/regex-replace").expandRegexReplacementUnits;
    const originalBudget = regexBudget.createRegexBudget;
    try {
        for (const layout of ["live", "fetched", "mixed", "folded-heading"]) {
            for (const fits of [false, true]) {
                const contents = Array.from({length: 65}, (_,index) =>
                    paragraph(`20261013120000-${String(index).padStart(7, "0")}`, "foo"));
                const f = fixture(contents);
                if (layout === "fetched") f.wysiwyg.innerHTML = "";
                if (layout === "folded-heading") {
                    f.wysiwyg.innerHTML = `<div data-node-id="${id}" data-type="NodeHeading" fold="1">Section</div>`;
                }
                if (layout === "mixed") {
                    for (const child of [...f.wysiwyg.children].slice(1)) child.remove();
                }
                const before = f.wysiwyg.innerHTML;
                const budgets = new Set();
                regexBudget.createRegexBudget = () => ({remainingResults: fits ? 65 : 64, remainingBytes: 100000});
                const result = await run(f, true, {regex: true, searchQuery: "foo", regexMatcher: {
                    expandReplacements: async (requests, pattern, template, options, _signal, budget) => {
                        budgets.add(budget);
                        try {return {expansions: expand(requests, pattern, template, options, budget), error: ""};}
                        catch (error) {
                            if (!(error instanceof regexBudget.RegexBudgetExceeded)) throw error;
                            return {expansions: [], error: error.message};
                        }
                    },
                }});
                assert.equal(budgets.size, 1, "live and all offscreen batches share one budget");
                assert.equal(f.calls.length, fits ? 1 : 0, "budget failure cannot partially submit: " + layout);
                if (fits) {
                    assert.equal(result.replacedCount, 65);
                    assert.equal(f.calls[0].undo.length, 65, "one native transaction retains every undo operation");
                } else {
                    assert.equal(result.error, "regex-budget-exceeded");
                    assert.equal(result.replacedCount, 0);
                    assert.equal(f.wysiwyg.innerHTML, before, "no optimistic DOM writes on budget failure");
                    assert.ok([...f.kernel.values()].every(html => html.includes("foo")), "kernel content untouched");
                }
            }
        }
    } finally {regexBudget.createRegexBudget = originalBudget;}
    for (const all of [false, true]) {
        const f = fixture();
        const bar = barFixture(f);
        bar.regex = true;
        bar.regexMatcher = {expandReplacements: async () => ({expansions: [], error: regexBudget.REGEX_BUDGET_ERROR})};
        messages.length = 0;
        if (all) await bar.clickReplaceAll();
        else await bar.clickReplace();
        assert.equal(f.calls.length, 0);
        assert.ok(messages.some(message => message.text === regexBudget.REGEX_BUDGET_ERROR), "resource failure is reported explicitly");
        assert.ok(messages.every(message => !message.text?.includes("SUCCESS")), "resource rejection is never reported as success");
    }
    console.log("Regex resource limits: live/offscreen/mixed batches, atomic failure, native undo and explicit UI status OK");
    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const f = fixture();
            if (fetched) f.wysiwyg.innerHTML = "";
            const result = await run(f, all);
            assert.equal(result.commitState, "confirmed");
            assert.equal(result.replacedCount, 1);
            assert.equal(f.calls.length, 1);
            assert.equal(f.requests.length, fetched ? 3 : 1);
            assert.ok(f.calls[0].undo[0].data.includes("foo"), "native undo payload preserved");
            const noop = fixture();
            if (fetched) noop.wysiwyg.innerHTML = "";
            assert.equal((await run(noop, all, {}, "foo")).commitState, "confirmed");
            assert.equal(noop.calls.length, 0, "no-op has no redundant write/history entry");
            assert.equal(noop.requests.length, fetched ? 2 : 0, "no-op never polls for a change");
        }
    }
    console.log("Current/all × live/fetched: confirmed success, native undo and no-op paths OK");

    const selected = fixture([paragraph(id, "foo"), paragraph(otherId, "foo")]);
    const selectedText = selected.wysiwyg.querySelector(`[data-node-id="${id}"] [contenteditable="true"]`).firstChild;
    const selectedRange = document.createRange();
    selectedRange.selectNodeContents(selectedText);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(selectedRange);
    const selectedResult = await run(selected, true);
    assert.equal(selectedResult.commitState, "confirmed");
    assert.equal(selected.wysiwyg.textContent.match(/bar/g)?.length ?? 0, 2, "selected block syncs after replace-all");
    window.getSelection().removeAllRanges();
    console.log("Replace-all selected-block DOM synchronization OK");

    if (!lute) {
        const selectedContainer = fixture([
            `<div data-node-id="${id}" data-type="NodeCallout" class="callout">` +
            '<div class="callout-title">foo</div><div class="callout-content">' +
            paragraph(otherId, "foo") + '</div><div class="protyle-attr"></div></div>',
        ]);
        const nestedRange = document.createRange();
        nestedRange.selectNodeContents(selectedContainer.wysiwyg.querySelector('[contenteditable="true"]'));
        window.getSelection().addRange(nestedRange);
        blocks.collectSearchableBlocks = (edit, options) => {
            if (edit === selectedContainer.edit && options.scopeRoots.length > 1) {
                assert.fail("overlapping parent/child targets must share a single collection root");
            }
            return originalCollect(edit, options);
        };
        let containerResult;
        try {
            containerResult = await run(selectedContainer, true);
        } finally {
            blocks.collectSearchableBlocks = originalCollect;
        }
        assert.equal(containerResult.commitState, "confirmed");
        assert.equal(containerResult.replacedCount, 2);
        assert.equal(selectedContainer.wysiwyg.textContent.match(/bar/g)?.length ?? 0, 2,
            "native skips selected ancestors too; both the callout title and child must sync");
        window.getSelection().removeAllRanges();
    }

    window.getSelection().removeAllRanges();
    console.log("Selected container/child and nested content sync together OK");

    // The reported literal-search case spans 1775 blocks. Count editor-wide ID
    // scans rather than asserting a machine-dependent wall-clock threshold.
    const largeCount = lute ? 128 : 1775;
    const large = fixture(Array.from({length: largeCount}, (_, index) =>
        paragraph("20261013120000-" + index.toString(36).padStart(7, "0"), "foo")
    ));
    // Keep the host stub linear too; this case measures the plugin's own scans.
    const largeElements = new Map(Array.from(large.wysiwyg.children, element => [element.dataset.nodeId, element]));
    large.protyle.transaction = (operations, undo) => {
        large.calls.push({operations, undo});
        for (const operation of operations) {
            const template = document.createElement("template");
            template.innerHTML = normalize(operation.data);
            const replacement = template.content.firstElementChild;
            largeElements.get(operation.id).replaceWith(replacement);
            largeElements.set(operation.id, replacement);
            large.kernel.set(operation.id, replacement.outerHTML);
        }
    };
    let repeatedIdScans = 0;
    const largeQuery = large.edit.querySelectorAll.bind(large.edit);
    large.edit.querySelectorAll = (selector) => {
        if (/^\[data-node-id="/.test(selector)) repeatedIdScans++;
        return largeQuery(selector);
    };
    const largeStarted = Date.now();
    const largeResult = await run(large, true);
    assert.equal(largeResult.commitState, "confirmed");
    assert.equal(largeResult.replacedCount, largeCount);
    assert.equal(large.calls.length, 1, "large replace-all remains one native transaction");
    assert.equal(large.calls[0].undo.length, largeCount);
    assert.equal(repeatedIdScans, 0, "write guards/preparation/rollback never scan the editor once per ID");
    assert.ok(large.requests.every(request => request.ids.length <= 64));
    assert.equal(large.requests.length, Math.ceil(largeCount / 64), "confirmed blocks are read once");
    assert.equal((large.wysiwyg.textContent.match(/bar/g) ?? []).length, largeCount);
    large.protyle.transaction(large.calls[0].undo, large.calls[0].operations);
    assert.equal(
        (large.wysiwyg.textContent.match(/foo/g) ?? []).length,
        largeCount,
        "complete undo payload restores all blocks",
    );
    console.log(`${largeCount}-block literal replacement: bounded scans/read batches and complete single-transaction undo OK`, {
        elapsedMs: Date.now() - largeStarted,
    });

    // A virtualized editor can have every hit outside the live DOM. Reads may
    // overlap in bounded waves, but preparation still commits one undoable tx.
    const fetchedLarge = fixture(Array.from({length: 256}, (_, index) =>
        paragraph("20261013130000-" + index.toString(36).padStart(7, "0"), "foo")
    ));
    fetchedLarge.wysiwyg.innerHTML = "";
    const originalApi = api;
    let inflightReads = 0;
    let maxInflightReads = 0;
    api = async (_url, {ids}) => {
        inflightReads++;
        maxInflightReads = Math.max(maxInflightReads, inflightReads);
        await delay(3);
        const data = Object.fromEntries(ids.map(blockId => [blockId, fetchedLarge.kernel.get(blockId)]));
        inflightReads--;
        return {code: 0, data};
    };
    blocks.collectSearchableBlocks = (edit, options) => {
        assert.notEqual(edit, fetchedLarge.edit, "entirely offscreen replacement skips live text collection");
        return originalCollect(edit, options);
    };
    let fetchedLargeResult;
    try {
        fetchedLargeResult = await run(fetchedLarge, true);
    } finally {
        blocks.collectSearchableBlocks = originalCollect;
    }
    api = originalApi;
    assert.equal(fetchedLargeResult.commitState, "confirmed");
    assert.equal(fetchedLargeResult.replacedCount, 256);
    assert.equal(fetchedLarge.calls.length, 1, "fully fetched replace-all remains one native transaction");
    assert.equal(fetchedLarge.calls[0].undo.length, 256);
    assert.equal(maxInflightReads, 4, "unloaded block reads use the bounded four-request wave");
    assert.equal(
        fetchedLarge.calls[0].operations.length,
        256,
        "all unloaded updates enter the same transaction",
    );
    fetchedLarge.protyle.transaction(fetchedLarge.calls[0].undo, fetchedLarge.calls[0].operations);
    assert.equal(
        Array.from(fetchedLarge.kernel.values()).filter(html => html.includes(">foo<")).length,
        256,
        "unloaded replace-all keeps a complete undo payload",
    );
    console.log("Fully unloaded replace-all uses bounded read waves and one complete undoable transaction OK");

    // Native paragraph/list markup contains numbering metadata, runtime action
    // nodes and the attribute ZWSP. Unloaded paragraphs must retain their own
    // replacement offsets and native undo data outside the list container.
    const nativeParagraph = (blockId, text) =>
        `<div data-node-id="${blockId}" data-node-index="1" data-type="NodeParagraph" class="p" updated="20261014102649">` +
        `<div contenteditable="true" spellcheck="false">${text}</div>` +
        '<div class="protyle-attr" contenteditable="false">\u200b</div></div>';
    const listId = "20261014120000-aaaaaaa";
    const itemId = "20261014120000-bbbbbbb";
    for (const mixed of [false, true]) {
        const native = fixture([
            nativeParagraph(id, "foo foo"),
            `<div data-node-id="${listId}" data-type="NodeList" data-subtype="u" class="list">` +
            `<div data-node-id="${itemId}" data-type="NodeListItem" data-subtype="u" class="li">` +
            '<div class="protyle-action">1.</div>' + nativeParagraph(otherId, "foo") +
            '<div class="protyle-attr">\u200b</div></div><div class="protyle-attr">\u200b</div></div>',
        ]);
        for (const element of native.wysiwyg.querySelectorAll("[data-node-id]")) {
            native.kernel.set(element.dataset.nodeId, element.outerHTML);
        }
        native.wysiwyg.innerHTML = mixed ? nativeParagraph(id, "foo foo") : "";
        const result = await run(native, true);
        assert.equal(result.commitState, "confirmed");
        assert.equal(result.replacedCount, 3);
        assert.equal(native.calls.length, 1);
        assert.equal(native.calls[0].operations.length, 2);
        assert.ok(native.kernel.get(listId).includes(">bar</div>"), "list child and parent kernel DOM agree");
        native.protyle.transaction(native.calls[0].undo, native.calls[0].operations);
        assert.ok(native.kernel.get(listId).includes(">foo</div>"), "unloaded list child undo retains parent content");
    }
    console.log("Native paragraph/list DOM: entirely unloaded and mixed coverage replace/undo OK");

    for (const all of [false, true]) {
        const copiedOnly = fixture();
        copiedOnly.wysiwyg.innerHTML =
            `<div data-node-id="${otherId}" data-type="NodeBlockQueryEmbed">` +
            '<div class="protyle-wysiwyg__embed">' + paragraph(id, "foo") + '</div></div>';
        const result = await run(copiedOnly, all);
        assert.equal(result.commitState, "confirmed",
            "an embedded source copy must not masquerade as the unloaded document block");
        assert.equal(result.replacedCount, 1);
        assert.equal(copiedOnly.calls.length, 1);
        assert.equal(copiedOnly.requests.length, 3, "the actual unloaded source uses the fetched route");
    }
    console.log("Unloaded document source plus a mounted embedded copy uses authoritative fetched content OK");

    // With paragraph search disabled, image captions have their own unit IDs
    // and offsets. Replacement must preserve that identity when recollecting.
    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const imageTitle = fixture([paragraph(id,
                'before <span class="img" data-type="img" contenteditable="false"><span> </span><span>' +
                '<img src="assets/example.png" data-src="assets/example.png" data-title="foo">' +
                '<span class="protyle-action__title"><span>foo</span></span></span><span> </span></span> after')]);
            imageTitle.matches = matcher.matchTextUnitsDetailed(
                blocks.collectSearchableBlocks(imageTitle.edit, {includeDocTitle: false, includeParagraph: false})
                    .map(unit => ({...unit, segmentLengths: unit.textNodes.map(node => node.length)})),
                "foo",
            ).hits;
            assert.equal(imageTitle.matches.length, 1);
            assert.equal(imageTitle.matches[0].unitId, "image-title:0");
            if (fetched) imageTitle.wysiwyg.innerHTML = "";
            const mutations = new MutationObserver(() => {});
            mutations.observe(imageTitle.wysiwyg, {subtree: true, attributes: true, childList: true, characterData: true});
            const unchanged = await run(imageTitle, all, {}, "foo");
            assert.equal(unchanged.unchanged, true);
            assert.equal(imageTitle.calls.length, 0, "caption no-op has no write/history");
            assert.equal(mutations.takeRecords().length, 0, "caption no-op does not rewrite img title or text");
            mutations.disconnect();
            const result = await run(imageTitle, all);
            assert.equal(result.commitState, "confirmed", "image-title-only matches remain replaceable");
            assert.equal(result.replacedCount, 1);
            const committed = imageTitle.kernel.get(id);
            const persisted = lute ? lute.BlockDOM2StdMd(committed) : committed;
            assert.ok(
                lute ? persisted.includes('assets/example.png "bar"') : committed.includes('data-title="bar"'),
                "caption writes the replacement into the persisted image title",
            );
            assert.ok(!committed.includes('data-title="foo"'), "caption does not leave the old data-title");
            assert.ok(committed.includes("before") && committed.includes("after"), "paragraph body is preserved");
        }
    }
    console.log("Image-title-only search: current/all × live/fetched offsets and img title persistence OK");

    for (const all of [false, true]) {
        for (const change of ["render-metadata", "saved-attribute", "text"]) {
            const fetchedSnapshot = fixture([nativeParagraph(id, "foo")]);
            fetchedSnapshot.wysiwyg.innerHTML = "";
            if (!lute) fetchedSnapshot.protyle.protyle.lute = {BlockDOM2Md: html => html};
            const snapshotApi = api;
            let reads = 0;
            api = async (url, body) => {
                const response = await snapshotApi(url, body);
                if (++reads === 2) {
                    let html = response.data[id];
                    if (change === "render-metadata") {
                        html = html.replace('updated="20261014102649"',
                            'updated="20261014102650" parent-heading="heading-id"');
                    } else if (change === "saved-attribute") {
                        html = html.replace('class="p"', 'class="p" style="color: red;"');
                    } else {
                        html = html.replace(">foo</div>", ">new foo</div>");
                    }
                    response.data[id] = html;
                }
                return response;
            };
            const result = await run(fetchedSnapshot, all);
            assert.equal(fetchedSnapshot.calls.length, change === "render-metadata" ? 1 : 0,
                "fetched comparison ignores only render metadata, not saved attributes or text");
            assert.equal(result.replacedCount, change === "render-metadata" ? 1 : 0);
            api = snapshotApi;
        }
    }
    console.log("Fetched snapshot recheck tolerates render metadata and rejects saved-attribute/text changes OK");

    // Exercise the real SearchBar snapshot predicate: a normal mount changes
    // domEpoch even when the kernel snapshot and writable text are unchanged.
    for (const [phase, changed, selected] of ["before-read", "during-read"].flatMap(phase =>
        [false, true].flatMap(changed => [false, true].map(selected => [phase, changed, selected]))
    )) {
        const mounted = fixture();
        mounted.wysiwyg.innerHTML = "";
        const bar = barFixture(mounted);
        Object.assign(bar, {
            resultSearchGeneration: 1,
            domEpoch: 0,
            resultDomEpoch: 0,
            documentEpoch: 0,
            resultDocumentEpoch: 0,
        });
        delete bar.hasStableReplaceAllSnapshot;
        const mountedApi = api;
        let mountedOnce = false;
        const mount = () => {
            mountedOnce = true;
            mounted.wysiwyg.innerHTML = paragraph(id, changed ? "edited foo" : "foo");
            if (selected) {
                const range = document.createRange();
                range.selectNodeContents(mounted.wysiwyg.querySelector('[contenteditable="true"]'));
                window.getSelection().addRange(range);
            }
            bar.domEpoch++;
        };
        if (phase === "before-read") {
            const expand = source("shared/regex-replace").expandRegexReplacementUnits;
            bar.regex = true;
            bar.regexMatcher = {
                expandReplacements: async (requests, pattern, template, options) => {
                    if (!mountedOnce) mount();
                    return {expansions: expand(requests, pattern, template, options), error: ""};
                },
            };
        }
        api = async (url, body) => {
            const response = await mountedApi(url, body);
            if (!mountedOnce) mount();
            return response;
        };
        messages.length = 0;
        await bar.clickReplaceAll();
        assert.equal(mounted.calls.length, changed ? 0 : 1,
            "normal mounting is allowed; a mounted text edit still cancels before submit");
        if (!changed) assert.equal(mounted.wysiwyg.querySelector('[contenteditable="true"]').textContent, "bar",
            "a selected mounted block also receives the replacement in live DOM");
        window.getSelection().removeAllRanges();
        api = mountedApi;
    }
    console.log("SearchBar replace-all tolerates unchanged block mounting and rejects mounted edits OK");

    for (const loaded of [false, true]) {
        const f = fixture();
        if (!loaded) f.wysiwyg.innerHTML = "";
        const bar = barFixture(f);
        Object.assign(bar, {
            documentEpoch: 0, domEpoch: 0,
            rememberCurrentRootId: () => "r",
            plugin: {isLastHighlightComponent: () => false},
        });
        const read = api;
        let notified = false;
        api = async (...args) => {
            if (!notified) {
                notified = true;
                assert.equal(f.calls.length, 0, "index notification arrives during preparation");
                bar.onEventBus({detail: {cmd: "databaseIndexCommit", data: {rootIDs: ["r"], backlinkFull: false}}});
            }
            return read(...args);
        };
        let refreshes = 0;
        bar.highlightHitResult = async () => refreshes++;
        await bar.clickReplaceAll();
        assert.equal(notified, true);
        assert.equal(f.calls.length, 1, "index catch-up alone does not cancel a validated replacement");
        assert.equal(refreshes, 1, "index notification merges with the post-replacement search");
        window.clearTimeout(bar.typingTimer);
        api = read;
    }
    console.log("SQL index catch-up during loaded/fetched replace-all preparation preserves writes and merges refresh OK");

    for (const change of ["document-event", "query-generation", "replacement", "readonly", "root"]) {
        const stale = fixture();
        stale.wysiwyg.innerHTML = "";
        const bar = barFixture(stale);
        Object.assign(bar, {
            resultSearchGeneration: 1,
            domEpoch: 0,
            resultDomEpoch: 0,
            documentEpoch: 0,
            resultDocumentEpoch: 0,
        });
        delete bar.hasStableReplaceAllSnapshot;
        const staleApi = api;
        api = async (url, body) => {
            const response = await staleApi(url, body);
            if (change === "document-event") bar.documentEpoch++;
            if (change === "query-generation") bar.searchGeneration++;
            if (change === "replacement") bar.replaceText = "other";
            if (change === "readonly") stale.protyle.protyle.disabled = true;
            if (change === "root") stale.protyle.protyle.block.rootID = "other-doc";
            return response;
        };
        await bar.clickReplaceAll();
        assert.equal(stale.calls.length, 0, "replace-all preparation still rejects " + change);
        api = staleApi;
    }
    console.log("SearchBar preparation still guards document/query/replacement/readonly/navigation changes OK");

    const failedFetched = fixture(Array.from({length: 128}, (_, index) =>
        paragraph("20261013140000-" + index.toString(36).padStart(7, "0"), "foo")
    ));
    failedFetched.wysiwyg.innerHTML = "";
    const failedApi = api;
    let failedRead = false;
    api = async (_url, {ids}) => {
        await delay(1);
        if (!failedRead) {
            failedRead = true;
            return {code: -1, data: {}};
        }
        return {code: 0, data: Object.fromEntries(ids.map(blockId => [blockId, failedFetched.kernel.get(blockId)]))};
    };
    const failedFetchedResult = await run(failedFetched, true);
    api = failedApi;
    assert.equal(failedFetchedResult.replacedCount, 0, "a failed fetched read cancels the whole replace-all");
    assert.equal(failedFetched.calls.length, 0, "a failed fetched read never submits a partial transaction");
    console.log("Fetched read failure cancels replace-all before any partial write OK");

    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const dynamic = fixture([paragraph(id, reference("foo") + " | " + reference("untouched"))]);
            if (fetched) dynamic.wysiwyg.innerHTML = "";
            if (!lute) dynamic.protyle.protyle.lute = {BlockDOM2Md: html => html};
            const dynamicApi = api;
            api = async (url, body) => {
                const response = await dynamicApi(url, body);
                if (dynamic.calls.length && response.data?.[id]) {
                    response.data[id] = response.data[id].replace(">untouched</span>", ">authoritative</span>");
                }
                return response;
            };
            const result = await run(dynamic, all);
            assert.equal(
                result.commitState,
                "confirmed",
                "untouched dynamic anchor refresh does not hide a confirmed write",
            );
            assert.equal(result.replacedCount, 1);
            assert.ok(dynamic.calls[0].operations[0].data.includes('data-subtype="s"'));
            api = dynamicApi;
        }
    }
    const contentFixture = fixture();
    // A lightweight serializer covers the same normalization path when native Lute is not supplied.
    if (!lute) contentFixture.protyle.protyle.lute = {BlockDOM2Md: html => html};
    const strictReader = commit.createCommitContentReader(contentFixture.protyle);
    const confirmReader = commit.createCommitContentReader(contentFixture.protyle, {ignoreDynamicReferenceText: true});
    const untouched = paragraph(id, reference("untouched"));
    assert.equal(confirmReader(untouched), confirmReader(untouched.replace("untouched", "authoritative")));
    assert.equal(
        confirmReader(untouched),
        confirmReader(untouched.replace("untouched", "")),
        "empty derived anchors are equivalent",
    );
    assert.notEqual(
        strictReader(untouched),
        strictReader(untouched.replace("untouched", "authoritative")),
        "rollback stays strict",
    );
    for (
        const changed of [
            untouched.replace(referenceId, otherId),
            untouched.replace('data-subtype="d"', 'data-subtype="s"'),
            untouched.replace("strong block-ref", "em block-ref"),
        ]
    ) {
        assert.notEqual(
            confirmReader(untouched),
            confirmReader(changed),
            "reference ID, subtype and marks stay significant",
        );
    }
    const staticRef = untouched.replace('data-subtype="d"', 'data-subtype="s"');
    assert.notEqual(
        confirmReader(staticRef),
        confirmReader(staticRef.replace("untouched", "authoritative")),
        "static text stays strict",
    );
    const originalCreateElement = document.createElement.bind(document);
    const expectedUnsplit = confirmReader(untouched);
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    document.createElement = (...args) => {
        const element = originalCreateElement(...args);
        if (args[0] === "template") {
            Object.defineProperty(element, "innerHTML", {
                get: () => innerHTML.get.call(element),
                set: html => {
                    innerHTML.set.call(element, html);
                    const text = element.content.querySelector('span[data-subtype="d"]')?.firstChild;
                    if (text instanceof Text && text.length > 3) text.splitText(3);
                },
            });
        }
        return element;
    };
    try {
        assert.equal(
            confirmReader(untouched),
            expectedUnsplit,
            "split Text nodes normalize to one derived anchor placeholder",
        );
    } finally {
        document.createElement = originalCreateElement;
    }
    console.log("Untouched dynamic-reference refresh remains a confirmed replacement OK");

    for (const all of [false, true]) {
        const scoped = fixture(undefined, "delayed");
        scoped.protyle.protyle.notebookId = "encrypted-notebook";
        const originalApi = api;
        const originalInvalidate = corpus.invalidateEditedDocument;
        const invalidated = [];
        let reads = 0;
        api = async (url, body) => {
            assert.equal(body.notebook, "encrypted-notebook", "confirmation retains the submitted notebook scope");
            if (++reads === 1) {
                scoped.protyle.protyle.notebookId = "another-notebook";
                scoped.protyle.protyle.block.rootID = "another-document";
            }
            return originalApi(url, body);
        };
        corpus.invalidateEditedDocument = (rootId, ids) => invalidated.push({rootId, ids});
        try {
            assert.equal((await run(scoped, all)).commitState, "confirmed");
            assert.deepEqual(
                invalidated,
                [{rootId: "r", ids: [id]}],
                "invalidate the submitted document after navigation",
            );
        } finally {
            corpus.invalidateEditedDocument = originalInvalidate;
        }
    }
    console.log("Confirmation notebook scope and submitted-document cache invalidation survive navigation OK");

    for (const all of [false, true]) {
        const fetchedNotebook = fixture();
        fetchedNotebook.wysiwyg.innerHTML = "";
        fetchedNotebook.protyle.protyle.notebookId = "encrypted-fetched-notebook";
        const fetchedApi = api;
        const fetchedBodies = [];
        api = async (url, body) => {
            fetchedBodies.push(body);
            if (body.notebook !== "encrypted-fetched-notebook") return {code: 0, data: {}};
            return fetchedApi(url, body);
        };
        assert.equal((await run(fetchedNotebook, all)).commitState, "confirmed");
        assert.equal(fetchedBodies.length, 3, "same request count as ordinary fetched replacements");
        assert.ok(fetchedBodies.every(body => body.notebook === "encrypted-fetched-notebook"));

        const navigated = fixture();
        navigated.wysiwyg.innerHTML = "";
        navigated.protyle.protyle.notebookId = "original-notebook";
        const navigationApi = api;
        let navigationReads = 0;
        api = async (url, body) => {
            assert.equal(
                body.notebook,
                "original-notebook",
                "preparation and recheck keep the same scope after navigation",
            );
            if (++navigationReads === 1) {
                navigated.protyle.protyle.notebookId = "other-notebook";
                navigated.protyle.protyle.block.rootID = "other-root";
            }
            return navigationApi(url, body);
        };
        assert.equal((await run(navigated, all)).error, "stale-target");
        assert.equal(navigated.calls.length, 0);
        api = fetchedApi;
    }
    console.log("Fetched replacement and confirmation retain encrypted notebook scope OK");

    const savedWarn = console.warn;
    console.warn = () => {};
    try {
        for (const all of [false, true]) {
            for (const mode of ["throw-before", "throw-after", "new-edit-then-throw"]) {
                const f = fixture([paragraph(id, reference("foo"))], mode);
                const before = f.wysiwyg.innerHTML;
                const result = await run(f, all);
                assert.equal(result.commitState, "failed");
                assert.equal(result.replacedCount, 0);
                assert.equal(f.calls.length, 1);
                assert.equal(f.requests.length, 0, "sync errors never cause automatic re-submission");
                if (mode === "new-edit-then-throw") {
                    assert.equal(f.wysiwyg.querySelector('[contenteditable="true"]').textContent, "new user edit");
                } else {
                    assert.equal(f.wysiwyg.innerHTML, before, "live content and dynamic-ref d subtype restored");
                }
            }
            const f = fixture(undefined, "throw-before");
            f.wysiwyg.innerHTML = "";
            assert.equal((await run(f, all)).commitState, "failed");
            assert.equal(f.calls.length, 1);
            assert.equal(
                f.requests.length,
                2,
                "fetched errors keep original queue and do not POST fallback transactions",
            );
        }
        for (const mode of ["throw-before", "throw-after"]) {
            const mounted = fixture([paragraph(id, reference("foo"))], mode);
            const originalHTML = mounted.wysiwyg.innerHTML;
            mounted.wysiwyg.innerHTML = "";
            const mountedApi = api;
            api = async (url, body) => {
                const response = await mountedApi(url, body);
                if (!mounted.wysiwyg.firstElementChild) {
                    mounted.wysiwyg.innerHTML = originalHTML;
                    const range = document.createRange();
                    range.selectNodeContents(mounted.wysiwyg.querySelector('[contenteditable="true"]'));
                    window.getSelection().addRange(range);
                }
                return response;
            };
            try {
                const result = await run(mounted, true);
                assert.equal(result.commitState, "failed");
                assert.equal(mounted.calls.length, 1);
                assert.equal(mounted.requests.length, 2, "selected fetched failures never retry writes");
                assert.equal(mounted.wysiwyg.innerHTML, originalHTML,
                    "a selected block mounted during preparation restores its original dynamic reference");
            } finally {
                window.getSelection().removeAllRanges();
                api = mountedApi;
            }
        }
    } finally {
        console.warn = savedWarn;
    }
    console.log("Synchronous failures restore only optimistic content, preserve newer edits and never retry writes OK");

    console.warn = () => {};
    try {
        for (const all of [false, true]) {
            for (const newerCopy of [false, true]) {
                const duplicate = fixture([
                    paragraph(id, reference("foo")).replace(
                        'data-type="NodeParagraph"',
                        'data-type="NodeParagraph" data-copy="body"',
                    ),
                    '<div class="protyle-wysiwyg__embed">' + paragraph(id, reference("foo")).replace(
                        'data-type="NodeParagraph"',
                        'data-type="NodeParagraph" data-copy="embed"',
                    ) + "</div>",
                ], "throw-after-all");
                const duplicateBefore = Array.from(duplicate.wysiwyg.querySelectorAll(`[data-node-id="${id}"]`)).map(
                    node => node.outerHTML,
                );
                if (newerCopy) {
                    const originalSubmit = duplicate.protyle.transaction;
                    const submitWithNewerCopy = (operations, undo) => {
                        try {
                            originalSubmit(operations, undo);
                        } catch (error) {
                            duplicate.wysiwyg.querySelector('.protyle-wysiwyg__embed [contenteditable="true"]')
                                .textContent = "new copy edit";
                            throw error;
                        }
                    };
                    duplicate.protyle.transaction = submitWithNewerCopy;
                    duplicate.protyle.updateTransactionElement = (element, before) =>
                        submitWithNewerCopy(
                            [{id, action: "update", data: element.outerHTML}],
                            [{id, action: "update", data: before}],
                        );
                }
                const result = await run(duplicate, all);
                assert.equal(result.commitState, "failed");
                const after = Array.from(duplicate.wysiwyg.querySelectorAll(`[data-node-id="${id}"]`));
                assert.equal(after[0].outerHTML, duplicateBefore[0], "body copy gets its own old HTML");
                if (newerCopy) {
                    assert.equal(after[1].querySelector('[contenteditable="true"]').textContent, "new copy edit");
                } else assert.equal(after[1].outerHTML, duplicateBefore[1], "embed copy gets its own old HTML");
            }
        }
    } finally {
        console.warn = savedWarn;
    }
    console.log("Same-ID embedded copies roll back together after synchronous failure OK");

    for (const all of [false, true]) {
        for (const mode of ["kernel-rejected", "http-error", "network-error", "unrelated", "missing"]) {
            const f = fixture(undefined, mode);
            const states = [];
            const result = await run(f, all, {onCommitStateChange: state => states.push(state)});
            assert.equal(result.commitState, "unknown", mode);
            assert.equal(result.replacedCount, 0);
            assert.equal(result.submittedCount, 1);
            assert.deepEqual(states, ["pending", "unknown"]);
            assert.equal(f.calls.length, 1);
            assert.ok(f.requests.length <= 12, "bounded backoff, no high-frequency indefinite polling");
            assert.ok(f.wysiwyg.textContent.includes("bar"), "timeout must not roll back a possibly queued write");
        }
        const late = fixture(undefined, "kernel-rejected");
        assert.equal((await run(late, all)).commitState, "unknown");
        late.persist();
        assert.ok(late.kernel.get(id).includes("bar"), "late commit remains valid after timeout");
        const pending = fixture(undefined, "delayed");
        const states = [];
        assert.equal(
            (await run(pending, all, {onCommitStateChange: state => states.push(state)})).commitState,
            "confirmed",
        );
        assert.deepEqual(states, ["pending", "confirmed"]);
    }
    const partial = fixture([paragraph(id, "foo"), paragraph(otherId, "foo")], "partial");
    const partialResult = await run(partial, true);
    assert.equal(partialResult.commitState, "unknown");
    assert.equal(partialResult.replacedCount, 1);
    assert.equal(partialResult.submittedCount, 2);
    assert.deepEqual(partial.requests[0].ids, [id, otherId]);
    assert.ok(partial.requests.slice(1).every(request => request.ids.length === 1 && request.ids[0] === otherId));
    console.log("Queue/HTTP/kernel rejection, unrelated changes, partial results, delay and late commit semantics OK");

    const hanging = fixture();
    let settleRead;
    let reads = 0;
    api = () => {
        reads++;
        return new Promise(resolve => {
            settleRead = resolve;
        });
    };
    const hangStates = [];
    const hung = await run(hanging, false, {onCommitStateChange: state => hangStates.push(state)});
    assert.equal(hung.commitState, "unknown");
    assert.equal(reads, 1, "no overlapping requests while a read hangs");
    settleRead({code: 0, data: Object.fromEntries(hanging.kernel)});
    await delay(40);
    assert.deepEqual(
        hangStates,
        ["pending", "unknown"],
        "late read cannot change the returned status or emit stale messages",
    );

    const batchHost = fixture();
    const updates = Array.from({length: 130}, (_, index) => ({
        id: "batch-" + index,
        oldHTML: paragraph("batch-" + index, "foo"),
        newHTML: paragraph("batch-" + index, "bar"),
        appliedCount: 1,
    }));
    const batches = [];
    api = async (_url, {ids}) => {
        batches.push(ids);
        return {
            code: 0,
            data: Object.fromEntries(ids.map(blockId => [blockId, updates.find(u => u.id === blockId).newHTML])),
        };
    };
    const batchResult = await commit.confirmBlockUpdates(batchHost.protyle, updates, {});
    assert.equal(batchResult.commitState, "confirmed");
    assert.equal(batchResult.replacedCount, 130);
    assert.deepEqual(batches.map(batch => batch.length), [64, 64, 2]);

    const childOld = paragraph(otherId, "foo");
    const childNew = paragraph(otherId, "bar");
    const parent = text => `<div data-node-id="${id}" data-type="NodeBlockquote" class="bq">${text}</div>`;
    api = async () => ({code: 0, data: {[id]: normalize(parent(childNew)), [otherId]: normalize(childNew)}});
    assert.equal(
        (await commit.confirmBlockUpdates(batchHost.protyle, [
            {id, oldHTML: parent(childOld), newHTML: parent(childOld), appliedCount: 1},
            {id: otherId, oldHTML: childOld, newHTML: childNew, appliedCount: 1},
        ], {})).commitState,
        "confirmed",
        "parent comparison includes final child updates",
    );
    console.log("Hung reads, bounded batches, confirmed-block pruning and parent/child final content OK");

    if (lute) {
        const reader = commit.createCommitContentReader(batchHost.protyle);
        const content = paragraph(
            id,
            `<span data-type="strong em block-ref" data-subtype="s" data-id="${referenceId}">bar</span>` +
                '<span data-type="inline-memo" data-inline-memo-content="memo bar">body</span>' +
                '<span class="img" data-type="img" contenteditable="false"><span> </span><span><img src="assets/x.png" data-src="assets/x.png" data-title="bar"><span class="protyle-action__title"><span>bar</span></span></span><span> </span></span>',
        );
        assert.equal(
            reader(content),
            reader(normalize(content)),
            "render UI and added timestamps do not hide a successful write",
        );
        for (
            const changed of [
                content.replace('data-subtype="s"', 'data-subtype="d"'),
                content.replace("memo bar", "old memo"),
                content.replace('data-title="bar"', 'data-title="old"'),
                content.replace(referenceId, otherId),
            ]
        ) {
            assert.notEqual(
                reader(content),
                reader(changed),
                "persisted reference/memo/image attributes remain significant",
            );
        }
        for (
            const html of [
                `<div data-node-id="${id}" data-type="NodeTable" class="table"><div><table><thead><tr><th>bar</th></tr></thead><tbody><tr><td>body</td></tr></tbody></table></div></div>`,
                `<div data-node-id="${id}" data-type="NodeCodeBlock" class="code-block"><div class="protyle-action"><span>js</span></div><div contenteditable="true">bar</div></div>`,
                parent(paragraph(otherId, "bar")),
            ]
        ) assert.equal(reader(html), reader(normalize(html)), "native table/code/container normalization");
        console.log("Native Lute content equality: composite refs, memos, images, tables, code and containers OK");
    }

    for (const all of [false, true]) {
        for (
            const mode of [
                "success",
                "delayed",
                "throw-before",
                "throw-after",
                "kernel-rejected",
                "http-error",
                "network-error",
            ]
        ) {
            const f = fixture(undefined, mode);
            const bar = barFixture(f);
            messages.length = 0;
            console.warn = () => {};
            try {
                await (all ? bar.clickReplaceAll() : bar.clickReplace());
            } finally {
                console.warn = savedWarn;
            }
            assert.equal(bar.replaceBusy, false);
            const success = messages.some(message => message.text.startsWith("SUCCESS"));
            assert.equal(success, mode === "success" || mode === "delayed", "UI result " + mode + "/" + all);
            if (mode.startsWith("throw")) assert.ok(messages.some(message => message.text === "FAILED"));
            if (["kernel-rejected", "http-error", "network-error"].includes(mode)) {
                assert.ok(messages.some(message => message.text === "UNKNOWN 0/1"));
            }
            const pendingMessage = messages.find(message => message.text === "PENDING");
            if (pendingMessage) {
                assert.ok(hiddenMessages.includes(pendingMessage.id), "pending toast cleared at completion");
            }
        }
    }
    console.log("Actual SearchBar single/all: only confirmed writes show success; failed/unknown/pending messages OK");

    const stalePreparation = fixture();
    stalePreparation.matches[0].start = 1;
    stalePreparation.matches[0].end = 4;
    const staleBar = barFixture(stalePreparation);
    staleBar.i18n.replaceStaleTarget = "CANCELLED";
    let staleRefreshes = 0;
    staleBar.highlightHitResult = async () => staleRefreshes++;
    messages.length = 0;
    await staleBar.clickReplaceAll();
    assert.equal(stalePreparation.calls.length, 0, "failed preparation never submits a partial write");
    assert.equal(staleRefreshes, 1);
    assert.ok(messages.some(message => message.text === "CANCELLED"));
    assert.ok(
        !messages.some(message => message.text.startsWith("SUCCESS")),
        "preparation failure never shows success: 0",
    );
    console.log("SearchBar reports failed replace-all preparation as cancellation, not success: 0 OK");

    for (const all of [false, true]) {
        const f = fixture(undefined, "delayed");
        const bar = barFixture(f);
        Object.assign(bar, {
            domEpoch: 0,
            documentEpoch: 0,
            root: document.createElement("div"),
            includeAttributeView: true,
            rememberCurrentRootId: () => "r",
            plugin: {isLastHighlightComponent: () => false},
        });
        let refreshes = 0;
        bar.highlightHitResult = async () => {
            refreshes++;
            bar.searchGeneration++;
        };
        const nativeSubmit = f.protyle.transaction;
        const notifySave = (operations, undo) => {
            nativeSubmit(operations, undo);
            bar.onEventBus({detail: {cmd: "savedoc"}});
            bar.scheduleAttrViewResearch([], false);
            bar.scheduleIndexRefresh("r");
        };
        f.protyle.transaction = notifySave;
        f.protyle.updateTransactionElement = (element, before) =>
            notifySave(
                [{id: element.dataset.nodeId, action: "update", data: element.outerHTML}],
                [{id: element.dataset.nodeId, action: "update", data: before}],
            );
        const read = api;
        api = async (...args) => {
            assert.equal(refreshes, 0, "savedoc never starts a search while confirming the replacement");
            return read(...args);
        };
        await (all ? bar.clickReplaceAll() : bar.clickReplace());
        await delay(450);
        assert.equal(f.calls.length, 1);
        assert.equal(refreshes, 1, "savedoc/AV/index notifications merge into the normal completion search");
        window.clearTimeout(bar.typingTimer);
        window.clearTimeout(bar.avRefreshTimer);
        window.clearTimeout(bar.indexSettledTimer);
    }
    console.log("Replacement savedoc/AV/index notifications wait for commit and merge into one final search OK");

    for (const all of [false, true]) {
        for (const mode of ["success", "kernel-rejected"]) {
            const f = fixture(undefined, mode);
            const bar = makeDestroyable(barFixture(f));
            let refreshes = 0;
            bar.highlightHitResult = async () => {
                refreshes++;
            };
            const originalApi = api;
            let resolveRead;
            let readStarted;
            const started = new Promise(resolve => {
                readStarted = resolve;
            });
            api = (url, body) => {
                readStarted();
                return new Promise(resolve => {
                    resolveRead = () => resolve(originalApi(url, body));
                });
            };
            messages.length = 0;
            const replacing = all ? bar.clickReplaceAll() : bar.clickReplace();
            await started;
            await delay(45);
            const pendingMessage = messages.find(message => message.text === "PENDING");
            assert.ok(pendingMessage, "pending message appears while SearchBar is still open");
            bar.destroy(false);
            assert.ok(hiddenMessages.includes(pendingMessage.id), "destroy immediately clears pending toast");
            const messageCount = messages.length;
            api = originalApi;
            resolveRead();
            await replacing;
            assert.equal(f.calls.length, 1, "an already submitted transaction is not cancelled or retried");
            assert.equal(refreshes, 0, "closed SearchBar does not refresh or reacquire index ownership");
            assert.equal(bar.backgroundCorpusRootId, "", "destroyed owner stays released");
            assert.equal(messages.length, messageCount, "late confirmed/unknown results show no new messages");
            assert.equal(bar.replaceBusy, false);
        }
        const f = fixture();
        const bar = makeDestroyable(barFixture(f));
        bar.regex = true;
        let finishRegex;
        let regexStarted;
        const started = new Promise(resolve => {
            regexStarted = resolve;
        });
        bar.regexMatcher = {
            dispose: () => {},
            expandReplacements: requests => {
                regexStarted();
                return new Promise(resolve => {
                    finishRegex = () =>
                        resolve({expansions: requests.map(request => ({...request, replacement: "bar"}))});
                });
            },
        };
        let refreshes = 0;
        bar.highlightHitResult = async () => {
            refreshes++;
        };
        const replacing = all ? bar.clickReplaceAll() : bar.clickReplace();
        await started;
        bar.destroy(false);
        finishRegex();
        await replacing;
        assert.equal(f.calls.length, 0, "closing during asynchronous preparation prevents a later submit");
        assert.equal(refreshes, 0);
    }
    const closedBar = barFixture(fixture());
    closedBar.destroyed = true;
    closedBar.highlightHitResult = async () => {
        throw new Error("closed handler must not refresh");
    };
    assert.equal(
        await closedBar.handleUnconfirmedReplacement({
            commitState: "unknown",
            replacedCount: 0,
            submittedCount: 1,
            skippedCount: 0,
        }),
        true,
    );
    const refreshingBar = barFixture(fixture());
    const previousMessageCount = messages.length;
    assert.equal(
        await refreshingBar.handleUnconfirmedReplacement({
            commitState: "unknown",
            replacedCount: 0,
            submittedCount: 1,
            skippedCount: 0,
        }),
        true,
    );
    assert.equal(messages.length, previousMessageCount + 1, "unknown replacement reports without optimistic refresh");
    const failedBar = barFixture(fixture());
    failedBar.highlightHitResult = async () => {
        failedBar.destroyed = true;
    };
    const failedMessageCount = messages.length;
    assert.equal(
        await failedBar.handleUnconfirmedReplacement({
            commitState: "failed",
            replacedCount: 0,
            submittedCount: 1,
            skippedCount: 0,
        }),
        true,
    );
    assert.equal(messages.length, failedMessageCount, "closing during failed refresh suppresses the final toast");
    console.log("Unknown replacement preserves the snapshot; failed refresh remains lifecycle-safe OK");
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
