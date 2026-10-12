// Direct-source multi-pane/anchor contracts; mocked layout is not real SiYuan E2E.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {getAllEditor: () => [], showMessage: () => {}};
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    mod._compile(
        ts.transpileModule(fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'), {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
            fileName: file,
        }).outputText,
        file,
    );
};
const source = (file) => require(path.join(repo, "src", file + ".ts"));
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
const {SearchBar} = source("frontend/search-bar");
const {ComponentHighlights} = source("frontend/component-highlights");
const {buildListSnippet} = source("frontend/list-snippet");
const {resolveInitialMatchIndex, resolveRetainedMatchIndex, resolveRetainedMatchIndexWithBudget} = source(
    "frontend/match-anchor",
);
const {watchComponentLifecycle} = source("frontend/component-lifecycle");
const {matchTextUnitsDetailed} = source("shared/match-text");
const {DiagramSearchState} = source("frontend/diagram-search-state");
const {EmbedSearchState} = source("frontend/embed-search-state");
const {watchEditorDom} = source("frontend/editor-dom-watch");

function textMatches(text, blockId = "block", unitId) {
    return matchTextUnitsDetailed([{blockId, unitId, blockType: "NodeParagraph", blockIndex: 0, text}], "foo").hits.map(
        hit => ({
            ...hit,
            ...buildListSnippet(text, hit.start, hit.end, hit.matchedText),
        }),
    );
}
let last;
const host = {
    isLastHighlightComponent: root => root === last,
    updateLastHighlightComponent: root => {
        last = root;
    },
    onSearchComponentUnmounted: (_callback, root) => {
        if (last === root) last = null;
    },
};
function fixture(name) {
    const edit = document.createElement("div");
    edit.className = "layout-tab-container";
    edit.innerHTML =
        `<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"><div data-node-id="${name}" data-type="NodeParagraph"><div contenteditable="true">foo</div></div></div></div></div><div class="search-root"></div>`;
    document.body.appendChild(edit);
    const range = document.createRange();
    range.selectNodeContents(edit.querySelector('[contenteditable="true"]'));
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {
        edit,
        root: edit.lastElementChild,
        plugin: host,
        resultMatches: [{...textMatches("foo", name)[0], range}],
        resultIndex: 1,
        resultCount: 1,
        searchGeneration: 1,
        domEpoch: 0,
        documentEpoch: 0,
        searchText: "foo",
        tableRevealSerial: 0,
        resultHighlightPending: false,
        highlightPaintGeneration: 0,
        pendingAddedBlocks: new Set(),
        diagramSearchState: new DiagramSearchState(),
        embedSearchState: new EmbedSearchState(),
        searchesInFlight: 0,
        regexMatcher: {
            dispose: () => {},
            match: async (units, value, options) => matchTextUnitsDetailed(units, value, options),
        },
        syncMemoUnderlineVisual: () => {},
        scrollIntoRanges: () => {},
        rememberCurrentRootId: () => "",
        closeSettingsMenu: () => {},
        closeSearchMethodMenu: () => {},
        closeResultsPanel: () => {},
        teardownSelectionScopeLayoutSync: () => {},
        teardownMemoUnderlineLayoutSync: () => {},
        clearSelectionScopeVisual: () => {},
        restoreEditorFocus: () => {},
        calculateSearchResults: async () => bar.resultMatches,
    });
    return bar;
}

function pipelineFixture(name) {
    const bar = fixture(name);
    delete bar.calculateSearchResults;
    Object.assign(bar, {
        syncBackgroundCorpusRoot: () => "",
        documentSearchIndices: {activeRoot: "", consumePending: () => null},
        clearDocumentSearchIndices: () => {},
        getSearchAnchorRange: () => null,
        syncIndexingIndicator: () => {},
        updateCountLabel: () => {},
        syncReplaceButtons: () => {},
        noteSearchCoverage: () => {},
    });
    return bar;
}

async function diagramRegressions() {
    // Keep real observers/pipeline/state guards; shorten only the shared 400ms user-input delay.
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 400 ? 15 : delay, ...args);
    // Allow observer, debounce and budgeted paint turns to finish on slower hosts.
    const settle = () => new Promise(resolve => originalTimeout(resolve, 300));
    try {
        for (const language of ["mermaid", "flowchart"]) {
            const bar = pipelineFixture("dynamic-" + language);
            delete bar.runSearchPipeline;
            bar.includeFoldedBlocks = true;
            bar.resolveScopeForSearch = () => new Map();
            bar.resultMatches = [];
            bar.resultIndex = 0;
            bar.resultCount = 0;
            const wysiwyg = bar.edit.querySelector(".protyle-wysiwyg");
            wysiwyg.innerHTML =
                `<div class="li" data-node-id="container" data-type="NodeListItem" fold="1"><div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="${language}" data-content="foo foo"><div spin="1"></div></div></div>`;
            const container = wysiwyg.firstElementChild;
            let graph = wysiwyg.querySelector('[data-node-id="diagram"]');
            let refreshes = 0;
            const realHighlight = bar.highlightHitResult.bind(bar);
            bar.highlightHitResult = (...args) => {
                refreshes++;
                return realHighlight(...args);
            };
            await bar.highlightHitResult("foo", true);
            assert.equal(bar.resultCount, 2, language + " cold source is searched once");
            const stop = watchEditorDom(bar.edit, {
                knownDiagram: element => bar.diagramSearchState.knows(element),
                onMutate: () => {
                    bar.domEpoch++;
                    bar.repairRangeAbort?.abort();
                },
                onSettled: change => bar.onEditorDomSettled(change),
            }, 1);
            bar.stopEditorDomWatch = stop;
            container.setAttribute("fold", "0");
            graph.innerHTML = "<div><svg><text>foo</text></svg></div>";
            await settle();
            assert.equal(bar.resultCount, 1, language + " source 2 becomes rendered 1 without manual input");
            assert.equal(refreshes, 2, "unfold and SVG completion share one refresh");
            assert.equal(bar.diagramRefreshPending, false);
            graph.innerHTML = "<div><svg><text>foo</text></svg></div>";
            await settle();
            assert.equal(refreshes, 2, "identical SVG text only repairs Ranges");
            graph.querySelector("text").firstChild.data = "bar";
            const beforeTextChange = refreshes;
            await settle();
            assert.equal(bar.resultCount, 0, "characterData removes stale rendered matches");
            assert.equal(refreshes, beforeTextChange + 1, "Range repair and diagram refresh share one search");
            graph.querySelector("text").firstChild.data = "foo";
            await settle();
            assert.equal(bar.resultCount, 1, "zero-hit diagrams gain rendered matches");
            container.setAttribute("fold", "1");
            await settle();
            assert.equal(bar.resultCount, 2, "fold switches back to source even with retained SVG");
            graph.setAttribute("data-content", "changed");
            await settle();
            assert.equal(bar.resultCount, 0, "source attribute changes remove Range-less stale matches");
            container.setAttribute("fold", "0");
            graph.innerHTML = "<div><svg><text>foo</text></svg></div>";
            await settle();
            assert.equal(bar.resultCount, 1);
            graph.remove();
            await settle();
            assert.equal(bar.resultCount, 0, "removed diagram invalidates its live semantic snapshot");
            container.insertAdjacentHTML(
                "beforeend",
                `<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="${language}" data-content="no source hit"><div><svg><text>foo</text></svg></div></div>`,
            );
            graph = container.lastElementChild;
            await settle();
            assert.equal(bar.resultCount, 1, "first loading detects a new rendered-only hit");

            bar.locatePending = true;
            graph.querySelector("text").textContent = "foo foo";
            await settle();
            assert.equal(bar.resultCount, 1);
            assert.equal(bar.diagramRefreshPending, true, "navigation retains its pending semantic refresh");
            bar.locatePending = false;
            await bar.repairHighlightRanges();
            await settle();
            assert.equal(bar.resultCount, 2, "navigation release processes pending change");

            bar.searchesInFlight = 1;
            graph.querySelector("text").textContent = "foo";
            await settle();
            assert.equal(bar.diagramRefreshPending, true);
            bar.searchesInFlight = 0;
            bar.repairAfterSearchIfNeeded(-1);
            await settle();
            assert.equal(bar.resultCount, 1, "in-flight search release processes pending change");

            bar.replaceBusy = true;
            graph.querySelector("text").textContent = "foo foo";
            await settle();
            assert.equal(bar.diagramRefreshPending, true, "replacement retains its pending semantic refresh");
            bar.replaceBusy = false;
            bar.scheduleDiagramRefresh();
            await settle();
            assert.equal(bar.resultCount, 2, "replacement release processes pending change");

            let releaseMatch;
            const normalMatch = bar.regexMatcher.match;
            bar.regexMatcher.match = async (...args) => {
                bar.regexMatcher.match = normalMatch;
                const result = await normalMatch(...args);
                await new Promise(resolve => releaseMatch = resolve);
                return result;
            };
            const searching = bar.highlightHitResult("foo", false);
            while (!releaseMatch) await new Promise(resolve => originalTimeout(resolve, 0));
            graph.querySelector("text").textContent = "foo";
            await settle();
            assert.equal(bar.diagramRefreshPending, true);
            releaseMatch();
            await searching;
            await settle();
            assert.equal(
                bar.resultCount,
                1,
                "mutation after live collection triggers refresh after actual async search",
            );

            // A normal save/input search collects the latest state and absorbs queued work.
            graph.querySelector("text").textContent = "foo foo";
            await new Promise(resolve => originalTimeout(resolve, 5));
            await bar.highlightHitResult("foo", false);
            const afterSave = refreshes;
            await settle();
            assert.equal(refreshes, afterSave, "fresh search absorbs a queued diagram refresh");
            assert.equal(bar.searchesInFlight, 0, "indexing counter terminates");

            graph.querySelector("text").textContent = "foo";
            await new Promise(resolve => originalTimeout(resolve, 5));
            bar.setSearchText("bar");
            const beforeInput = refreshes;
            await settle();
            assert.equal(refreshes, beforeInput, "old query timer cannot run after user input");
            await bar.highlightHitResult("bar", true);
            graph.querySelector("text").textContent = "bar";
            await settle();
            assert.equal(bar.resultCount, 1, "new query receives subsequent zero-to-one change");
            bar.destroy();
            const afterDestroy = refreshes;
            graph.querySelector("text").textContent = "bar bar";
            await settle();
            assert.equal(refreshes, afterDestroy, "destroy leaves no diagram timers/observer");
        }
        const ordinary = pipelineFixture("ordinary-fold");
        ordinary.includeFoldedBlocks = true;
        let refreshes = 0;
        ordinary.highlightHitResult = async () => refreshes++;
        ordinary.onEditorDomSettled({addedInBlocks: new Set(), foldChanged: true, diagramBlocks: new Set()});
        await settle();
        assert.equal(refreshes, 0, "ordinary folding retains the cheap no-reindex path");
        ordinary.destroy();

        const {collectSearchableBlocks} = source("frontend/blocks");
        for (
            const options of [{includeMermaid: false}, {includeListOrdered: false}, {
                restrictInlineTypes: ["inline-math"],
            }]
        ) {
            const gated = fixture("gated-diagram");
            gated.edit.querySelector(".protyle-wysiwyg").innerHTML =
                '<div data-node-id="list" data-type="NodeList" data-subtype="o"><div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo foo"><div></div></div></div>';
            const graph = gated.edit.querySelector('[data-node-id="diagram"]');
            const state = new DiagramSearchState();
            state.capture(collectSearchableBlocks(gated.edit, options));
            graph.innerHTML = "<div><svg><text>foo</text></svg></div>";
            assert.equal(
                state.changed(gated.edit, new Set([graph]), options),
                false,
                "disabled diagram/container/inline gates cause no refresh",
            );
            gated.destroy();
        }
        const scoped = fixture("diagram-scopes");
        const wysiwyg = scoped.edit.querySelector(".protyle-wysiwyg");
        wysiwyg.innerHTML =
            '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo"><div><svg><text>foo</text></svg></div></div>';
        const graph = wysiwyg.firstElementChild;
        const state = new DiagramSearchState();
        const collected = collectSearchableBlocks(scoped.edit);
        state.capture(collected, new Map());
        graph.querySelector("text").textContent = "foo foo";
        assert.equal(
            state.changed(scoped.edit, new Set([graph]), {}),
            false,
            "unselected diagrams do not trigger selection-only search",
        );
        const selected = collectSearchableBlocks(scoped.edit);
        state.capture(selected, new Map([["diagram::" + selected[0].unitId, [{start: 0, end: 3}]]]));
        graph.querySelector("text").textContent = "foo";
        assert.equal(
            state.changed(scoped.edit, new Set([graph]), {}),
            true,
            "selected rendered diagram changes refresh its frozen scope",
        );
        state.capture(collectSearchableBlocks(scoped.edit));
        const inactive = document.createElement("div");
        inactive.className = "protyle fn__none";
        inactive.innerHTML =
            '<div class="protyle-wysiwyg"><div data-node-id="inactive" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo foo"><div></div></div></div>';
        scoped.edit.appendChild(inactive);
        assert.equal(
            state.changed(scoped.edit, new Set([inactive.querySelector("[data-node-id]")]), {}),
            false,
            "inactive Protyle cannot invalidate active diagram results",
        );
        assert.equal(state.changed(scoped.edit, null, {}), true, "diagram overflow requests one bounded merged search");
        state.clear();
        assert.equal(
            state.changed(scoped.edit, null, {includeMermaid: false}),
            false,
            "disabled diagram overflow does not force search",
        );
        assert.equal(state.knows(graph), false, "root reset drops old diagram identities");
        scoped.destroy();

        const headingBar = pipelineFixture("heading-diagram");
        headingBar.includeFoldedBlocks = true;
        headingBar.resolveScopeForSearch = () => new Map();
        const headingRoot = headingBar.edit.querySelector(".protyle-wysiwyg");
        headingRoot.innerHTML =
            '<div data-node-id="heading" data-type="NodeHeading" data-subtype="h1" fold="1">title</div>';
        const heading = headingRoot.firstElementChild;
        await headingBar.highlightHitResult("foo", true);
        assert.equal(headingBar.resultCount, 0);
        headingBar.stopEditorDomWatch = watchEditorDom(headingBar.edit, {
            knownDiagram: element => headingBar.diagramSearchState.knows(element),
            onMutate: () => headingBar.domEpoch++,
            onSettled: change => headingBar.onEditorDomSettled(change),
        }, 1);
        heading.setAttribute("fold", "0");
        headingRoot.insertAdjacentHTML(
            "beforeend",
            '<div data-node-id="heading-child" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo foo"><div><svg><text>foo</text></svg></div></div>',
        );
        const headingGraph = headingRoot.lastElementChild;
        await settle();
        assert.equal(headingBar.resultCount, 1, "heading children mounted as siblings refresh zero-hit results");
        headingGraph.setAttribute("parent-heading", "heading");
        await settle();
        assert.equal(headingBar.resultCount, 2, "parent-heading marker switches back to source");
        headingGraph.setAttribute("data-subtype", "graphviz");
        await settle();
        assert.equal(headingBar.resultCount, 1, "leaving a source diagram language invalidates its old identity");
        headingBar.destroy();

        const embedBar = pipelineFixture("embedded-diagram");
        embedBar.includeFoldedBlocks = true;
        embedBar.resolveScopeForSearch = () => new Map();
        const embedRoot = embedBar.edit.querySelector(".protyle-wysiwyg");
        embedRoot.innerHTML =
            '<div data-node-id="host-a" data-type="NodeBlockQueryEmbed"><div data-node-id="same-source" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo foo"><div><svg><text>foo</text></svg></div></div></div><div data-node-id="host-b" data-type="NodeBlockQueryEmbed"><div data-node-id="same-source" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="foo foo"><div><svg><text>foo</text></svg></div></div></div>';
        await embedBar.highlightHitResult("foo", true);
        assert.equal(embedBar.resultCount, 2);
        embedBar.stopEditorDomWatch = watchEditorDom(embedBar.edit, {
            knownDiagram: element => embedBar.diagramSearchState.knows(element),
            onMutate: () => embedBar.domEpoch++,
            onSettled: change => embedBar.onEditorDomSettled(change),
        }, 1);
        embedRoot.firstElementChild.querySelector("text").textContent = "foo foo";
        await settle();
        assert.equal(embedBar.resultCount, 3, "same source IDs remain isolated by embed host");
        assert.equal(embedBar.resultMatches.filter(match => match.blockId === "host-b").length, 1);
        embedBar.destroy();
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log("diagram dynamic source/rendered/zero-hit/removal/attribute refresh and debounce/lifecycle gates OK");
}

async function embedRefreshRegressions() {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 400 ? 15 : delay, ...args);
    const settle = () => new Promise(resolve => originalTimeout(resolve, 300));
    const child = '<div data-node-id="source" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>';
    try {
        for (
            const scenario of [
                "initial-empty",
                "added",
                "removed",
                "formula",
                "large",
                "busy",
                "same-text",
                "disabled",
                "memo",
                "restricted",
                "enumerate",
            ]
        ) {
            const bar = pipelineFixture("embed-refresh-" + scenario);
            bar.restrictInlineTypes = [];
            bar.includeFoldedBlocks = false;
            bar.includeEmbedBlock = scenario !== "disabled";
            const root = bar.edit.querySelector(".protyle-wysiwyg");
            root.innerHTML =
                '<div data-node-id="embed" data-type="NodeBlockQueryEmbed"><div class="protyle-wysiwyg__embed">' +
                (["initial-empty", "formula", "large", "busy"].includes(scenario) ? "" : child) + "</div></div>";
            const body = root.firstElementChild.firstElementChild;
            if (scenario === "formula") {
                body.innerHTML =
                    '<div data-node-id="source" data-type="NodeParagraph"><span data-type="inline-math" data-content="alpha"></span></div>';
            }
            if (scenario === "memo") {
                bar.includeInlineMemo = true;
                body.innerHTML =
                    '<div data-node-id="source" data-type="NodeParagraph"><span data-type="inline-memo" data-inline-memo-content="other">note</span></div>';
            }
            if (scenario === "restricted" || scenario === "enumerate") {
                bar.restrictInlineTypes = ["strong"];
                body.innerHTML =
                    '<div data-node-id="source" data-type="NodeParagraph"><span data-type="em">foo</span></div>';
            }
            bar.searchText = scenario === "formula" ? "α" : "foo";
            if (scenario === "enumerate") bar.searchText = "";
            let searches = 0;
            const highlight = bar.highlightHitResult.bind(bar);
            bar.highlightHitResult = (...args) => {
                searches++;
                return highlight(...args);
            };
            await bar.highlightHitResult(bar.searchText, true);
            bar.stopEditorDomWatch = watchEditorDom(bar.edit, {
                knownDiagram: element => bar.diagramSearchState.knows(element),
                onMutate: () => {
                    bar.domEpoch++;
                    bar.repairRangeAbort?.abort();
                },
                onSettled: change => bar.onEditorDomSettled(change),
            }, 1);
            if (scenario === "busy") bar.locatePending = true;
            if (["initial-empty", "busy", "same-text", "disabled"].includes(scenario)) body.innerHTML = child;
            if (scenario === "added") {
                body.insertAdjacentHTML("beforeend", child.replace('data-node-id="source"', 'data-node-id="other"'));
            }
            if (scenario === "removed") body.replaceChildren();
            if (scenario === "formula") body.querySelector("span").innerHTML = '<span class="katex-html">α</span>';
            if (scenario === "memo") body.querySelector("span").setAttribute("data-inline-memo-content", "foo");
            if (scenario === "restricted" || scenario === "enumerate") {
                body.querySelector("span").setAttribute("data-type", "strong");
            }
            if (scenario === "large") {
                body.innerHTML = Array.from(
                    {length: 70},
                    (_, i) => child.replace('data-node-id="source"', 'data-node-id="source-' + i + '"'),
                ).join("");
            }
            await settle();
            if (scenario === "busy") {
                assert.equal(bar.resultCount, 0);
                assert.equal(bar.diagramRefreshPending, true, "busy embed refresh is retained");
                bar.locatePending = false;
                await bar.repairHighlightRanges();
                await settle();
            }
            const expected = scenario === "removed" || scenario === "disabled" ?
                0 :
                scenario === "large" ?
                70 :
                scenario === "added" ?
                2 :
                1;
            assert.equal(bar.resultCount, expected, scenario + " refreshes without manual input");
            assert.equal(
                searches,
                scenario === "same-text" || scenario === "disabled" ? 1 : 2,
                "semantic change gets one merged search",
            );
            assert.ok(bar.resultMatches.every(match => !match.replaceable));
            bar.destroy();
        }
        const scoped = pipelineFixture("embed-selection");
        scoped.selectionOnly = true;
        scoped.includeFoldedBlocks = false;
        const scopedRoot = scoped.edit.querySelector(".protyle-wysiwyg");
        scopedRoot.innerHTML = '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + child + child + "</div>";
        const scopeUnits = source("frontend/blocks").collectSearchableBlocks(scoped.edit);
        const selected = scopeUnits.find(block => block.embeddedSourceId === "source@1");
        scoped.rememberedSelectionScope = new Map([[
            source("frontend/selection").unitKey(selected.blockId, selected.unitId),
            [{start: 0, end: 3}],
        ]]);
        scoped.resolveScopeForSearch = () => scoped.rememberedSelectionScope;
        await scoped.highlightHitResult("foo", true);
        assert.equal(scoped.resultCount, 1);
        let selectionSearches = 0;
        const highlightScoped = scoped.highlightHitResult.bind(scoped);
        scoped.highlightHitResult = (...args) => {
            selectionSearches++;
            return highlightScoped(...args);
        };
        scoped.stopEditorDomWatch = watchEditorDom(scoped.edit, {
            knownDiagram: element => scoped.diagramSearchState.knows(element),
            onMutate: () => scoped.domEpoch++,
            onSettled: change => scoped.onEditorDomSettled(change),
        }, 1);
        scopedRoot.firstElementChild.firstElementChild.querySelector("[contenteditable]").textContent = "outside";
        await settle();
        assert.equal(selectionSearches, 0, "outside copied unit cannot trigger selected embed refresh");
        assert.equal(scoped.resultCount, 1);
        scoped.destroy();
        const reordered = pipelineFixture("embed-reordered");
        reordered.includeFoldedBlocks = false;
        const reorderedRoot = reordered.edit.querySelector(".protyle-wysiwyg");
        reorderedRoot.innerHTML = '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + child +
            '<div data-node-id="graph" data-type="NodeCodeBlock" data-subtype="mermaid"><svg><text>foo</text></svg></div></div>';
        await reordered.highlightHitResult("foo", true);
        const oldSequence = reordered.resultMatches.map(match => match.unitId);
        reordered.stopEditorDomWatch = watchEditorDom(reordered.edit, {
            knownDiagram: element => reordered.diagramSearchState.knows(element),
            onMutate: () => reordered.domEpoch++,
            onSettled: change => reordered.onEditorDomSettled(change),
        }, 1);
        const reorderedOwner = reorderedRoot.firstElementChild;
        reorderedOwner.prepend(reorderedOwner.lastElementChild);
        await settle();
        assert.deepEqual(
            reordered.resultMatches.map(match => match.unitId),
            oldSequence.reverse(),
            "moving an unchanged diagram before text updates embedded navigation order",
        );
        reordered.destroy();
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log("embedded async text/formula/zero-hit/removal, merged overflow, busy and identical/disabled gates OK");
}

async function embeddedAvMountRegressions() {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 400 ? 15 : delay, ...args);
    const settle = () => new Promise(resolve => originalTimeout(resolve, 300));
    const row = id =>
        '<div class="av__row" data-id="row' + id + '"><div class="av__cell" data-col-id="col">foo</div></div>';
    try {
        for (const mode of ["full", "groups", "degraded", "selection"]) {
            const fullCoverage = mode === "full" || mode === "groups";
            const mountedBody = () =>
                mode === "groups" ?
                    '<div class="av__items">' + [0, 1, 2].map(index =>
                        '<div class="av__body" data-group-id="g' + index + '">' +
                        (index === 0 ? row(0) : "") + "</div>"
                    ).join("") + "</div>" :
                    '<div class="av__body">' + row(0) + "</div>";
            const bar = pipelineFixture("embed-av-mount-" + mode);
            bar.avWatchPausedUntil = 0;
            bar.restrictInlineTypes = [];
            bar.includeAttributeView = true;
            bar.selectionOnly = mode === "selection";
            bar.resolveScopeForSearch = () => new Map();
            const root = bar.edit.querySelector(".protyle-wysiwyg");
            root.innerHTML = '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' +
                '<div data-node-id="source-av" data-type="NodeAttributeView" data-av-id="av-id">' +
                '<div class="av__title">database</div>' + mountedBody() + "</div></div>";
            const body = root.querySelector(mode === "groups" ? ".av__items" : ".av__body");
            const fullMatches = [0, 1, 2].map(index => ({
                ...textMatches(
                    "foo",
                    "embed",
                    mode === "groups" ?
                        "embed:source-av:av-group:g" + index + ":row0:col" :
                        "embed:source-av:av:row" + index + ":col",
                )[0],
                blockType: "NodeBlockQueryEmbed",
                replaceable: false,
            }));
            const collect = source("frontend/blocks").collectSearchableBlocks;
            const projection = source("frontend/corpus/project");
            bar.runSearchPipeline = async () => {
                const live = collect(bar.edit, {includeAttributeView: true});
                bar.embedSearchState.capture(live);
                bar.diagramRefreshPending = false;
                return {
                    matches: fullCoverage ?
                        projection.projectRanges(bar.edit, fullMatches, {}, live) :
                        projection.projectRanges(
                            bar.edit,
                            live.filter(block => block.text === "foo").flatMap(block =>
                                textMatches(block.text, block.blockId, block.unitId)
                            ),
                            {},
                            live,
                        ),
                    error: "",
                    degraded: mode === "degraded",
                };
            };
            let searches = 0;
            const highlight = bar.highlightHitResult.bind(bar);
            bar.highlightHitResult = (...args) => {
                searches++;
                return highlight(...args);
            };
            await bar.highlightHitResult("foo", true);
            bar.stopEditorDomWatch = watchEditorDom(bar.edit, {
                onMutate: () => {
                    bar.domEpoch++;
                    bar.repairRangeAbort?.abort();
                },
                onSettled: change => bar.onEditorDomSettled(change),
            }, 1);
            for (const index of [1, 2]) {
                bar.pauseAvWatch(2000);
                if (mode === "groups") {
                    body.querySelectorAll(".av__body").forEach((group, groupIndex) => {
                        group.innerHTML = '<div class="av__spacer"></div>' +
                            (groupIndex === index ? row(0).replace(">foo<", "><") : "");
                    });
                } else {
                    body.innerHTML = '<div class="av__spacer"></div>' + row(index).replace(">foo<", "><");
                }
                body.querySelector(".av__cell").insertAdjacentHTML("beforeend", '<span class="av__rich">foo</span>');
                await settle();
                assert.equal(
                    searches,
                    fullCoverage ? 1 : index + 1,
                    mode + " virtual mounts refresh only when needed",
                );
                if (fullCoverage) {
                    assert.equal(bar.resultCount, 3, "virtual rows do not alter full API coverage");
                    assert.equal(bar.resultMatches[index].range?.toString(), "foo", "new row receives its cold Range");
                    assert.ok(
                        bar.resultMatches.filter((_match, rowIndex) => rowIndex !== index).every(match => !match.range),
                        "unmounted AV cells release detached ranges rather than retaining old row trees",
                    );
                }
            }
            const beforeMixed = searches;
            body.querySelector(".av__rich").firstChild.data = "changed";
            const additional = mode === "groups" ? body.querySelector('[data-group-id="g1"]') : body;
            additional.insertAdjacentHTML("beforeend", row(mode === "groups" ? 0 : 1));
            await settle();
            assert.equal(searches, beforeMixed + 1, "mixed virtual mounts and retained-row edits still refresh");
            const beforeTextEdit = searches;
            body.querySelector(".av__rich").firstChild.data = "bar";
            await settle();
            assert.equal(searches, beforeTextEdit + 1, "real cell text edits still refresh during navigation pause");
            const beforeTitleEdit = searches;
            root.querySelector(".av__title").firstChild.data = "changed";
            await settle();
            assert.equal(searches, beforeTitleEdit + 1, "database title edits are not virtual mounts");
            const beforeRemoval = searches;
            root.querySelector('[data-type="NodeAttributeView"]').remove();
            await settle();
            assert.equal(searches, beforeRemoval + 1, "removing the carrier still refreshes the embed");
            bar.destroy();
        }
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log(
        "embedded AV virtual mounts repair only full-coverage ranges; edits, degraded and selection still refresh OK",
    );
}

async function galleryNavigationRegressions() {
    const originalRect = window.Range.prototype.getBoundingClientRect;
    window.Range.prototype.getBoundingClientRect = () => ({top: 0, bottom: 20, left: 0, right: 100});
    const markup = (id = "source-av") =>
        '<div class="av" data-node-id="' + id + '" data-type="NodeAttributeView" custom-sy-av-view="v">' +
        ["target", "other"].map(group =>
            '<div class="av__group-title"><button data-type="av-group-fold" data-id="' + group +
            '"><svg></svg></button><span class="av__group-name">foo</span></div><div class="av__body fn__none" data-group-id="' + group +
            '"><div class="av__gallery-item" data-id="row"><div class="av__cell" data-field-id="col">foo</div></div></div>'
        ).join("") + '</div>';
    const setup = (embedded, local = "av-group:target:row:col", mounted = true) => {
        const bar = fixture("gallery-nav");
        last = bar.root;
        Object.assign(bar, {
            includeFoldedBlocks: true, includeAttributeView: true, includeEmbedBlock: true,
            avWatchPausedUntil: 0, indexResetPausedUntil: 0,
            repairHighlightRanges: () => {}, syncReplaceButtons: () => {},
            bindUnfoldedHeadingSection: () => {},
        });
        const root = bar.edit.querySelector(".protyle-wysiwyg");
        root.innerHTML = mounted ? (embedded ?
            '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + markup() + '</div>' +
            '<div data-node-id="other-embed" data-type="NodeBlockQueryEmbed">' + markup() + '</div>' :
            markup("ordinary-av")) : "";
        if (local.endsWith("#run-0")) {
            // Split-run identities require a genuinely split DOM cell.
            root.querySelectorAll(".av__cell").forEach(cell => cell.innerHTML = "foo<br>tail");
        }
        bar.resultMatches = [{
            ...textMatches("foo", embedded ? "embed" : "ordinary-av", embedded ? "embed:source-av:" + local : local)[0],
            blockType: embedded ? "NodeBlockQueryEmbed" : "NodeAttributeView", replaceable: false,
            embeddedAvViewId: embedded ? "v" : undefined,
        }];
        let clicks = 0;
        let groupScrolls = 0;
        const wire = () => {
            root.querySelectorAll('[data-type="NodeAttributeView"]').forEach(av => {
                Object.defineProperty(av, "clientHeight", {value: 100});
                av.scrollIntoView = () => assert.fail("group navigation should scroll its group, not the entire database");
            });
            root.querySelectorAll(".av__group-title").forEach(title => title.scrollIntoView = () => groupScrolls++);
            root.querySelectorAll('[data-type="av-group-fold"]').forEach(fold => fold.addEventListener("click", () => {
                clicks++;
                fold.firstElementChild.classList.add("av__group-arrow--open");
                fold.closest(".av__group-title").nextElementSibling.classList.remove("fn__none");
            }));
        };
        wire();
        return {bar, root, wire, clicks: () => clicks, groupScrolls: () => groupScrolls};
    };
    try {
        for (const embedded of [false, true]) {
            for (const local of ["group-title:target", "av-group:target:row:col", "cell:target:row:col", "cell:target:row:col#run-0"]) {
                const test = setup(embedded, local);
                const {bar, root} = test;
                await bar.scrollIntoRangesAsync(0, false);
                assert.equal(test.clicks(), 0, "painting alone never unfolds a group");
                await bar.scrollIntoRangesAsync(0, true);
                assert.equal(test.clicks(), 1, "exactly the target native fold control is clicked");
                assert.equal(bar.resultMatches[0].range?.toString(), "foo", `${embedded}:${local}`);
                if (local !== "group-title:target") {
                    assert.equal(bar.resultMatches[0].range.startContainer.parentElement.closest("[data-group-id]").dataset.groupId, "target");
                }
                assert.equal(CSS.highlights.get(bar.getComponentHighlights().focusName)?.size, 1);
                assert.ok(root.querySelector('.av__body[data-group-id="other"]').classList.contains("fn__none"));
                if (embedded) assert.ok(root.querySelector('[data-node-id="other-embed"] .av__body').classList.contains("fn__none"));
                await bar.scrollIntoRangesAsync(0, true);
                assert.equal(test.clicks(), 1, "revisiting an unfolded group never toggles it closed");
                bar.destroy();
            }
            const virtual = setup(embedded, "av-group:target:unmounted:col");
            if (embedded) Object.defineProperty(virtual.root.firstElementChild, "clientHeight", {value: 100});
            await virtual.bar.scrollIntoRangesAsync(0, true);
            assert.equal(virtual.clicks(), 1);
            assert.equal(virtual.groupScrolls(), 1, "unmounted cards fall back to the target group");
            assert.equal(virtual.bar.resultMatches.length, 1, "unmounted cards retain their search result");
            assert.equal(virtual.bar.resultMatches[0].range, undefined);
            assert.equal(CSS.highlights.has(virtual.bar.getComponentHighlights().focusName), false);
            virtual.bar.destroy();
        }
        const duplicate = setup(true);
        const copied = duplicate.root.querySelector('[data-node-id="source-av"]').cloneNode(true);
        duplicate.root.firstElementChild.append(copied);
        duplicate.wire();
        duplicate.bar.resultMatches[0].unitId = "embed:source-av@1:av-group:target:row:col";
        await duplicate.bar.scrollIntoRangesAsync(0, true);
        assert.equal(duplicate.clicks(), 1, "duplicate source copies use their displayed instance ID");
        assert.ok(duplicate.root.firstElementChild.firstElementChild.querySelector('.av__body').classList.contains("fn__none"));
        assert.equal(duplicate.bar.resultMatches[0].range?.startContainer.parentElement.closest('[data-node-id="source-av"]'), copied);
        duplicate.bar.destroy();

        for (const layout of ["table", "list"]) {
            const asyncTable = setup(false);
            const asyncAv = asyncTable.root.firstElementChild;
            asyncAv.dataset.avType = layout;
            const asyncBody = asyncAv.querySelector('.av__body[data-group-id="target"]');
            asyncBody.replaceChildren();
            asyncAv.querySelector('[data-type="av-group-fold"]').addEventListener("click", () => {
                window.setTimeout(() => {
                    asyncBody.innerHTML = '<div class="av__row" data-id="row"><div class="av__cell" data-col-id="col">foo</div></div>';
                }, 30);
            });
            await asyncTable.bar.scrollIntoRangesAsync(0, true);
            assert.equal(asyncTable.bar.resultMatches[0].range?.toString(), "foo", "native async " + layout + " mounting binds without reindex");
            assert.equal(CSS.highlights.get(asyncTable.bar.getComponentHighlights().focusName)?.size, 1);
            asyncTable.bar.destroy();
        }
        for (const embedded of [false, true]) {
            const sequence = setup(embedded, "group-title:target");
            const titleMatch = sequence.bar.resultMatches[0];
            const rowMatch = {...textMatches("foo", titleMatch.blockId,
                embedded ? "embed:source-av:av-group:target:row:col" : "av-group:target:row:col")[0],
                blockType: titleMatch.blockType, replaceable: false, embeddedAvViewId: titleMatch.embeddedAvViewId};
            sequence.bar.resultMatches.push(rowMatch);
            sequence.bar.resultCount = 2;
            await sequence.bar.scrollIntoRangesAsync(0, true);
            assert.equal(sequence.clicks(), 1);
            const targetBody = sequence.bar.attributeViewGroupBody(titleMatch);
            const targetFold = targetBody.previousElementSibling.querySelector('[data-type="av-group-fold"]');
            targetBody.classList.add("fn__none");
            targetFold.firstElementChild.classList.remove("av__group-arrow--open");
            sequence.bar.resultIndex = 2;
            await sequence.bar.scrollIntoRangesAsync(1, true);
            assert.equal(sequence.clicks(), 2, "title-to-entry navigation unfolds a refolded target group");
            assert.equal(sequence.bar.resultMatches[1].range?.toString(), "foo");
            assert.equal(sequence.bar.resultMatches[1].range.startContainer.parentElement.closest("[data-group-id]"), targetBody);
            sequence.bar.destroy();
        }

        const wrongView = setup(true);
        wrongView.bar.resultMatches[0].embeddedAvViewId = "different-view";
        assert.equal(wrongView.bar.unfoldAttributeViewGroup(wrongView.bar.resultMatches[0]), false);
        assert.equal(wrongView.clicks(), 0, "stale-view matches cannot expand the new view");
        wrongView.bar.destroy();

        const loadedLater = setup(false, "av-group:target:row:col", false);
        const later = loadedLater.bar.finishLocatedMatch(1, true);
        window.setTimeout(() => {
            loadedLater.root.innerHTML = markup("ordinary-av");
            loadedLater.wire();
        }, 10);
        await later;
        assert.equal(loadedLater.clicks(), 1, "after outer-block loading the target group is unfolded");
        assert.equal(loadedLater.bar.resultMatches[0].range?.toString(), "foo");
        loadedLater.bar.destroy();

        for (const cancel of ["query", "navigate"]) {
            const test = setup(false, "av-group:target:row:col", false);
            test.bar.highlightHitResult = async () => assert.fail("cancelled locating must not reindex");
            const waiting = test.bar.finishLocatedMatch(1, true);
            window.setTimeout(() => {
                if (cancel === "query") test.bar.searchGeneration++;
                else test.bar.resultIndex = 2;
                test.root.innerHTML = markup("ordinary-av");
                test.wire();
            }, 10);
            await waiting;
            assert.equal(test.clicks(), 0, "cancelled locating cannot unfold the old target");
            test.bar.destroy();
        }
        const cancelledScroll = setup(false);
        const scrolling = cancelledScroll.bar.scrollIntoRangesAsync(0, true);
        cancelledScroll.bar.searchGeneration++;
        await scrolling;
        assert.equal(cancelledScroll.bar.resultMatches[0].range, undefined, "old layout waits cannot paint the new query");
        cancelledScroll.bar.destroy();
    } finally {
        window.Range.prototype.getBoundingClientRect = originalRect;
    }
    console.log("ordinary/embedded gallery navigation: native unfold, exact highlight, late loading, virtual fallback and cancellation OK");
}

async function avFoldCacheRegressions() {
    const av = source("frontend/corpus/av");
    const {isAttrViewFoldOnlyTransaction, watchAttributeViewDom} = source("frontend/av-watch");
    const queryHost = document.createElement("div");
    queryHost.innerHTML = '<div data-type="NodeAttributeView"><div data-type="av-search">keep</div>' +
        '<div class="av__kanban"><div class="av__body"><div class="av__cell">value</div></div></div></div>';
    document.body.appendChild(queryHost);
    let changes = 0;
    const stopQueryWatch = watchAttributeViewDom(queryHost, () => changes++, 5);
    const input = queryHost.querySelector('[data-type="av-search"]');
    const cell = queryHost.querySelector(".av__cell");
    try {
        input.firstChild.nodeValue = "other";
        input.dispatchEvent(new window.Event("input", {bubbles: true}));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(changes, 1, "native contenteditable input refreshes AV query completion");
        input.textContent = "";
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(changes, 2, "native query clearing also refreshes");
        cell.textContent = "changed";
        cell.dispatchEvent(new window.Event("input", {bubbles: true}));
        queryHost.querySelector(".av__body").insertAdjacentHTML("beforeend", '<div class="av__cell">virtual</div>');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(changes, 2, "card edits/virtual mounts do not enter the structural query watcher");
    } finally {
        stopQueryWatch();
    }
    input.textContent = "after-stop";
    input.dispatchEvent(new window.Event("input", {bubbles: true}));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(changes, 2, "query watcher releases input and mutation subscriptions");
    queryHost.remove();
    console.log("AV native query input/clear refresh, virtual-mount isolation and listener disposal OK");
    const fold = {action: "foldAttrViewGroup", avID: "a"};
    const edit = {action: "updateAttrViewCell", avID: "a"};
    const event = (doOperations, undoOperations = []) => ({cmd: "transactions", data: [{doOperations, undoOperations}]});
    for (const detail of [event([fold]), event([{...fold, action: "foldAttrViewGroups"}], [fold])]) {
        assert.equal(isAttrViewFoldOnlyTransaction(detail), true);
    }
    for (const detail of [null, {}, event([]), event([fold, edit]), event([fold], [edit]), event([{action: "unknown"}])]) {
        assert.equal(isAttrViewFoldOnlyTransaction(detail), false, "mixed/unknown/empty transactions retain invalidation");
    }
    const oldLoad = Module._load;
    const oldScss = require.extensions[".scss"];
    Module._load = function(request, parent, main) {
        const loaded = oldLoad.call(this, request, parent, main);
        return request === "siyuan" ? {...loaded, Plugin: class {}} : loaded;
    };
    require.extensions[".scss"] = () => {};
    try {
        const plugin = new (source("index").default)();
        const bar = fixture("fold-cache");
        bar.edit.querySelector(".protyle-wysiwyg").innerHTML = '<div data-type="NodeAttributeView" data-av-id="a"></div>';
        Object.assign(bar, {
            includeAttributeView: true, avWatchPausedUntil: 0,
            highlightHitResult: async () => bar.resultMatches,
        });
        const ref = {blockId: "b", avId: "a", updated: "u", carrierViewId: "v"};
        const apiModule = source("frontend/corpus/api");
        const oldPost = apiModule.postJson;
        let reads = 0;
        apiModule.postJson = async url => {
            reads++;
            return url.endsWith("getAttributeView") ? {name: "db", views: [{id: "v", name: "view"}]} :
                {view: {columns: [{id: "k"}], rowCount: 1, rows: [{id: "i", cells: [{value: {keyID: "k", text: {content: "foo"}}}]}]}};
        };
        try {
            for (const detail of [event([fold]), event([fold, edit]), event([fold], [edit])]) {
                av.invalidateAvCache();
                await av.loadAvUnits([ref]);
                const before = reads;
                plugin.onSearchHistoryBroadcast({detail});
                bar.onEventBus({detail});
                assert.equal(av.peekAvUnits([ref]).missing.length, isAttrViewFoldOnlyTransaction(detail) ? 0 : 1);
                if (isAttrViewFoldOnlyTransaction(detail)) {
                    await av.loadAvUnits([ref]);
                    assert.equal(reads, before, "fold-only broadcast and active-search refresh reuse the full text cache");
                }
                window.clearTimeout(bar.avRefreshTimer);
            }
        } finally {
            apiModule.postJson = oldPost;
            bar.destroy();
            av.invalidateAvCache();
        }
    } finally {
        Module._load = oldLoad;
        if (oldScss) require.extensions[".scss"] = oldScss;
        else delete require.extensions[".scss"];
    }
    console.log("AV fold-only native broadcasts preserve cache; mixed edits and undo invalidate it OK");
}

async function anchorRegressions() {
    const repeated = textMatches("foo ".repeat(100), "repeat");
    const earlier = textMatches("foo", "earlier");
    const prefixed = [...earlier, ...repeated.map(match => ({...match}))];
    assert.equal(
        resolveRetainedMatchIndex(prefixed, repeated[50], 51, {previousMatches: repeated}),
        52,
        "an unchanged unit retains the occurrence after an earlier block gains a hit",
    );
    assert.equal(
        resolveRetainedMatchIndex(repeated, prefixed[51], 52, {previousMatches: prefixed}),
        51,
        "an unchanged unit retains the occurrence after an earlier block loses a hit",
    );
    const original = textMatches("head foo target tail");
    const inserted = textMatches("head foo inserted---- head foo target tail");
    assert.equal(
        resolveRetainedMatchIndex(inserted, original[0], 1, {previousMatches: original}),
        2,
        "changed occurrence snapshots still require unique context, not the old offset",
    );

    const live = fixture("live-anchor");
    const liveText = live.edit.querySelector('[contenteditable="true"]').firstChild;
    const liveRange = document.createRange();
    liveRange.selectNodeContents(liveText);
    const liveMatch = {...textMatches("foo", "live-anchor")[0], range: liveRange};
    const unreadOld = new Proxy([liveMatch], {
        get(target, key) {
            if (/^\d+$/.test(String(key))) throw new Error("reliable Range must not scan old snapshots");
            return Reflect.get(target, key);
        },
    });
    assert.equal(
        resolveRetainedMatchIndex([], liveMatch, 1, {previousMatches: unreadOld}),
        0,
        "empty results do not scan the previous occurrence list",
    );
    assert.equal(
        await resolveRetainedMatchIndexWithBudget([liveMatch], liveMatch, 1, {
            previousMatches: unreadOld,
            edit: live.edit,
        }, () => true),
        1,
    );
    liveText.textContent = "foo ".repeat(100);
    const liveRepeated = textMatches(liveText.textContent, "live-anchor");
    const shiftedRange = document.createRange();
    shiftedRange.setStart(liveText, liveRepeated[50].start);
    shiftedRange.setEnd(liveText, liveRepeated[50].end);
    const shiftedPrevious = {...liveRepeated[50], range: shiftedRange};
    liveText.insertData(0, "foo ");
    const shiftedNext = textMatches(liveText.textContent, "live-anchor").map(match => {
        const range = document.createRange();
        range.setStart(liveText, match.start);
        range.setEnd(liveText, match.end);
        return {...match, range};
    });
    assert.equal(
        resolveRetainedMatchIndex(shiftedNext, shiftedPrevious, 51, {
            previousMatches: liveRepeated,
            edit: live.edit,
        }),
        52,
        "live text endpoints retain repeated occurrences when insertData moves their offsets",
    );
    const memoPrevious = {...original[0], highlightKind: "inline-memo", anchorOffset: 0, range: liveRange};
    const memoNext = inserted.map(match => ({
        ...match,
        highlightKind: "inline-memo",
        anchorOffset: 0,
        range: liveRange,
    }));
    assert.equal(
        resolveRetainedMatchIndex(memoNext, memoPrevious, 1, {previousMatches: [memoPrevious], edit: live.edit}),
        2,
        "attribute-host memo Ranges do not identify individual occurrences",
    );
    live.destroy();

    const originalPerformance = global.performance;
    let time = 0;
    global.performance = {now: () => time += 10};
    try {
        const dense = Array.from({length: 12000}, (_, index) => ({...earlier[0], blockId: "other-" + index}));
        dense.push(original[0]);
        let timerRan = false;
        window.setTimeout(() => timerRan = true, 0);
        assert.equal(
            await resolveRetainedMatchIndexWithBudget(dense, original[0], 1, {}, () => true),
            dense.length,
        );
        assert.equal(timerRan, true, "dense retained-anchor scans yield to browser timers");
        let reads = 0;
        let current = true;
        const tracked = new Proxy(dense, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++;
                return Reflect.get(target, key);
            },
        });
        window.setTimeout(() => current = false, 0);
        assert.equal(
            await resolveRetainedMatchIndexWithBudget(tracked, original[0], 1, {}, () => current),
            undefined,
        );
        const cancelledReads = reads;
        assert.ok(reads < dense.length / 2, "cancellation stops before completing the dense scan");
        await new Promise(resolve => window.setTimeout(resolve, 0));
        assert.equal(reads, cancelledReads, "cancelled scans retain no background iterator work");

        // The old-unit snapshot walk must yield as well, even when there is only one new hit.
        reads = 0;
        current = true;
        window.setTimeout(() => current = false, 0);
        assert.equal(
            await resolveRetainedMatchIndexWithBudget([original[0]], original[0], 1, {
                previousMatches: tracked,
            }, () => current),
            undefined,
        );
        assert.ok(reads < dense.length / 2);

        const superseded = pipelineFixture("superseded-anchor");
        superseded.resultMatches = original;
        superseded.runSearchPipeline = async () => ({matches: dense});
        const stale = superseded.calculateSearchResults("foo", false);
        const newest = textMatches("foo fresh", "fresh");
        await new Promise(resolve => window.setTimeout(resolve, 0));
        superseded.searchText = "fresh";
        superseded.runSearchPipeline = async () => ({matches: newest});
        assert.equal(await superseded.calculateSearchResults("fresh", true), newest);
        assert.deepEqual(await stale, [], "superseded anchor cannot publish stale results");
        assert.equal(superseded.resultMatches, newest);
        assert.equal(superseded.resultCount, newest.length);
        assert.equal(superseded.searchesInFlight, 0, "anchor cancellation releases the indexing indicator counter");
        assert.equal(superseded.searchAbortController, null);
        superseded.destroy();

        const navigating = pipelineFixture("navigating-anchor");
        navigating.resultMatches = repeated;
        navigating.resultIndex = 51;
        const updated = [...dense.slice(0, -1), ...prefixed];
        navigating.runSearchPipeline = async () => ({matches: updated});
        window.setTimeout(() => navigating.resultIndex = 61, 0);
        await navigating.calculateSearchResults("foo", false);
        assert.equal(navigating.resultIndex, 12062, "yielded anchor retries use the user's latest current occurrence");
        assert.equal(navigating.searchesInFlight, 0);
        navigating.destroy();
    } finally {
        global.performance = originalPerformance;
    }
}

async function lifecycleRegressions() {
    const tick = () => new Promise(resolve => window.setTimeout(resolve, 0));
    const a = fixture("lifecycle-A");
    const b = fixture("lifecycle-B");
    const sourceWrapper = document.createElement("section");
    document.body.appendChild(sourceWrapper);
    sourceWrapper.appendChild(a.edit);
    const htmlHost = document.createElement("div");
    htmlHost.dataset.nodeId = "shadow-life";
    a.edit.querySelector(".protyle-wysiwyg").appendChild(htmlHost);
    const shadow = htmlHost.attachShadow({mode: "open"});
    const shadowText = document.createTextNode("foo");
    shadow.appendChild(shadowText);
    const range = document.createRange();
    range.selectNodeContents(shadowText);
    a.resultMatches = [{...textMatches("foo", "shadow-life")[0], range}];
    last = b.root;
    await Promise.all([a.highlightHitResult("foo", false), b.highlightHitResult("foo", false)]);
    const aNames = a.getComponentHighlights();
    const bNames = b.getComponentHighlights();
    const bResults = CSS.highlights.get(bNames.resultsName);
    const bFocus = CSS.highlights.get(bNames.focusName);
    let detaches = 0;
    let restoredFocus = 0;
    a.plugin = {...host, onSearchComponentDetached: () => detaches++};
    a.restoreEditorFocus = () => restoredFocus++;
    a.watchComponentMount();
    b.watchComponentMount();
    // Moving an ancestor in one batch must preserve A and reattach observation to its new ancestry.
    const newWrapper = document.createElement("section");
    document.body.appendChild(newWrapper);
    newWrapper.appendChild(a.edit);
    sourceWrapper.remove();
    await tick();
    assert.equal(detaches, 0);
    assert.equal(a.destroyed, undefined);
    assert.equal(CSS.highlights.get(aNames.resultsName).has(range), true);
    b.edit.appendChild(a.edit.querySelector(".protyle"));
    await tick();
    assert.equal(range.startContainer.isConnected, true);
    assert.equal(range.toString(), "foo");
    assert.equal(a.destroyed, undefined, "source component survives while its pane remains open");
    assert.equal(CSS.highlights.has(aNames.resultsName), false, "moving the Protyle clears already registered Ranges");
    assert.equal(CSS.highlights.has(aNames.focusName), false);
    assert.equal(CSS.highlights.get(bNames.resultsName), bResults);
    assert.equal(CSS.highlights.get(bNames.focusName), bFocus);
    assert.equal(a.domEpoch, 1, "editor moves cancel staged projection and paint snapshots");
    const stylesBeforeDetach = document.head.querySelectorAll("style").length;
    newWrapper.remove();
    await tick();
    assert.equal(detaches, 1, "the observer follows new ancestors and closes promptly, without a 30s timer");
    assert.equal(a.destroyed, true);
    assert.equal(restoredFocus, 0, "automatic pane cleanup does not focus the moved editor");
    assert.equal(a.stopComponentLifecycleWatch, null);
    assert.equal(document.head.querySelectorAll("style").length, stylesBeforeDetach - 1);
    assert.equal(CSS.highlights.get(bNames.resultsName), bResults);
    assert.equal(last, b.root);
    a.destroy();
    assert.equal(detaches, 1);
    b.destroy();
    assert.equal(CSS.highlights.size, 0);

    const closing = fixture("closing-source");
    const destination = fixture("closing-destination");
    const closingHost = closing.edit.querySelector('[contenteditable="true"]');
    const closingShadow = closingHost.attachShadow({mode: "open"});
    const closingText = document.createTextNode("foo");
    closingShadow.appendChild(closingText);
    const closingRange = document.createRange();
    closingRange.selectNodeContents(closingText);
    closing.resultMatches[0].range = closingRange;
    await closing.applyResultHighlightsWithBudget(closing.resultMatches);
    const closingNames = closing.getComponentHighlights();
    closing.watchComponentMount();
    destination.edit.appendChild(closing.edit.querySelector(".protyle"));
    closing.edit.remove();
    await tick();
    assert.equal(closingRange.startContainer.isConnected, true);
    assert.equal(closingRange.toString(), "foo");
    assert.equal(closing.destroyed, true, "same-batch moveTab and source-pane removal also destroy the source bar");
    assert.equal(CSS.highlights.has(closingNames.resultsName), false);
    assert.equal(CSS.highlights.has(closingNames.focusName), false);
    destination.destroy();

    const c = fixture("content-lifecycle");
    const owner = c.edit.querySelector(".protyle");
    let ownerReads = 0;
    let unexpected = 0;
    const stop = watchComponentLifecycle(c.edit, c.root, {
        editorOwner: () => {
            ownerReads++;
            return owner;
        },
        detached: () => unexpected++,
        editorMoved: () => unexpected++,
    });
    const content = c.edit.querySelector('[contenteditable="true"]');
    content.appendChild(document.createTextNode(" renderer update"));
    content.setAttribute("data-render", "ready");
    await tick();
    assert.equal(ownerReads, 0, "deep content/renderer changes do not enter the layout observer");
    stop();
    stop();
    c.edit.remove();
    await tick();
    assert.equal(unexpected, 0, "stopped lifecycle observers do not deliver late callbacks");
    c.destroy(false);

    // Mobile mounts the bar beside .protyle rather than inside it.
    const mobileParent = document.createElement("section");
    const mobileEdit = document.createElement("div");
    const mobileRoot = document.createElement("div");
    mobileParent.append(mobileEdit, mobileRoot);
    document.body.appendChild(mobileParent);
    let mobileDetached = 0;
    const stopMobile = watchComponentLifecycle(mobileEdit, mobileRoot, {
        editorOwner: () => mobileEdit,
        editorMoved: () => unexpected++,
        detached: () => mobileDetached++,
    });
    mobileParent.remove();
    await tick();
    assert.equal(mobileDetached, 1, "sibling bar/editor mounts are also observed");
    stopMobile();
    assert.equal(unexpected, 0);
}
async function main() {
    for (const unitId of ["renderer:source-fallback:mermaid:0", "embed:source:renderer:source-fallback:flowchart:0"]) {
        const sourceBar = fixture("source-owner");
        sourceBar.resultMatches = [{...textMatches("foo", "source-owner", unitId)[0], replaceable: false}];
        let sourceScrolls = 0;
        let clearedFocus = 0;
        sourceBar.edit.querySelector('[data-node-id="source-owner"]').scrollIntoView = () => sourceScrolls++;
        sourceBar.clearSearchFocus = () => clearedFocus++;
        sourceBar.waitForLocatedMatchRange = async () => assert.fail("source navigation must not wait for SVG offsets");
        sourceBar.highlightHitResult = async () => assert.fail("source navigation must not restart indexing");
        sourceBar.updateCountLabel = () => {};
        await sourceBar.finishLocatedMatch(1, true);
        assert.equal(sourceScrolls, 1, "source and embedded source navigate to their owning block");
        assert.equal(clearedFocus, 1);
        sourceBar.resultIndex = -1;
        await sourceBar.finishLocatedMatch(1, false);
        assert.equal(sourceBar.resultIndex, 1, "source navigation restores a temporarily unset result index");
        assert.equal(sourceScrolls, 1, "highlight-only refresh does not scroll or unfold source hits");
        assert.equal(sourceBar.resultMatches[0].range, undefined);
        sourceBar.destroy();
    }
    const a = fixture("A");
    const b = fixture("B");
    last = b.root;
    await Promise.all([a.highlightHitResult("foo", false), b.highlightHitResult("foo", false)]);
    const aNames = a.getComponentHighlights();
    const bNames = b.getComponentHighlights();
    assert.notEqual(aNames.resultsName, bNames.resultsName);
    assert.equal(CSS.highlights.get(aNames.resultsName).size, 1);
    const bResults = CSS.highlights.get(bNames.resultsName);
    const bFocus = CSS.highlights.get(bNames.focusName);
    assert.equal(bResults.size, 1);
    assert.equal(CSS.highlights.get(aNames.focusName).size, 1);
    assert.equal(bFocus.size, 1);
    assert.equal(last, b.root, "background painting does not steal navigation ownership");
    let inactiveScrolls = 0;
    a.scrollIntoRanges = () => {
        inactiveScrolls++;
    };
    a.onEventBus({detail: {cmd: "savedoc"}});
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(CSS.highlights.get(aNames.resultsName).size, 1, "inactive pane repaints after savedoc");
    assert.equal(CSS.highlights.get(bNames.resultsName), bResults);
    assert.equal(last, b.root);
    assert.equal(inactiveScrolls, 0, "inactive savedoc repaint does not navigate");
    a.clearSearchFocus();
    assert.equal(CSS.highlights.get(bNames.focusName), bFocus, "memo focus cleanup is component-local");
    a.clearHighlight();
    assert.equal(CSS.highlights.has(aNames.resultsName), false);
    assert.equal(
        CSS.highlights.get(bNames.resultsName),
        bResults,
        "clearing A leaves B's exact Highlight object untouched",
    );
    await a.highlightHitResult("foo", false);
    const range = a.resultMatches[0].range;
    a.resultMatches = Array.from({length: 256}, (_, index) => ({...a.resultMatches[0], id: "dense-" + index, range}));
    const originalPerformance = global.performance;
    let time = 0;
    global.performance = {now: () => time += 10};
    const cancelled = a.applyResultHighlightsWithBudget(a.resultMatches);
    a.domEpoch++;
    assert.equal(await cancelled, false);
    assert.equal(CSS.highlights.get(bNames.resultsName), bResults, "cancelled paint cannot affect another pane");
    const beforeStyles = document.head.querySelectorAll("style").length;
    const disposedPaint = a.applyResultHighlightsWithBudget(a.resultMatches);
    a.destroy();
    a.destroy();
    assert.equal(await disposedPaint, false, "closed component cannot publish late paint");
    assert.equal(document.head.querySelectorAll("style").length, beforeStyles - 1);
    assert.equal(CSS.highlights.get(bNames.resultsName), bResults, "closing inactive A preserves B");
    assert.equal(last, b.root);
    global.performance = originalPerformance;
    b.onEventBus({detail: {cmd: "savedoc"}});
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(CSS.highlights.get(bNames.resultsName).size, 1);
    b.destroy();
    assert.equal(last, null);
    assert.equal(CSS.highlights.size, 0);
    assert.equal(document.head.querySelectorAll("style").length, 0);
    assert.equal(a.canPaintHighlights(), false);

    const movedFrom = fixture("moved");
    const movedTo = fixture("destination");
    const movedBlock = movedFrom.edit.querySelector('[data-node-id="moved"]');
    movedTo.edit.querySelector(".protyle-wysiwyg").appendChild(movedBlock);
    // A connected range pointing at a moved editor is never this component's paint source.
    const movedRange = document.createRange();
    movedRange.selectNodeContents(movedBlock.querySelector('[contenteditable="true"]'));
    movedFrom.resultMatches[0].range = movedRange;
    await movedFrom.applyResultHighlightsWithBudget(movedFrom.resultMatches);
    const movedNames = movedFrom.getComponentHighlights();
    assert.equal(CSS.highlights.has(movedNames.resultsName), false);
    assert.equal(CSS.highlights.has(movedNames.focusName), false);
    assert.equal(movedFrom.appendResultHighlight(movedFrom.resultMatches[0]), false);
    assert.equal(movedFrom.rangeStillInMatchBlock(movedRange, movedFrom.resultMatches[0]), false);
    const htmlHost = document.createElement("div");
    htmlHost.dataset.nodeId = "html";
    movedFrom.edit.querySelector(".protyle-wysiwyg").appendChild(htmlHost);
    const shadow = htmlHost.attachShadow({mode: "open"});
    const shadowText = document.createTextNode("foo");
    shadow.appendChild(shadowText);
    const shadowRange = document.createRange();
    shadowRange.selectNodeContents(shadowText);
    movedFrom.resultMatches = [{...textMatches("foo", "html")[0], range: shadowRange}];
    await movedFrom.applyResultHighlightsWithBudget(movedFrom.resultMatches);
    assert.equal(
        CSS.highlights.get(movedNames.resultsName).has(shadowRange),
        true,
        "ownership check preserves HTML Shadow DOM ranges",
    );
    assert.equal(CSS.highlights.get(movedNames.focusName).has(shadowRange), true);
    movedFrom.root.remove();
    assert.equal(
        await movedFrom.applyResultHighlightsWithBudget(movedFrom.resultMatches),
        false,
        "detached root cancels painting without requiring destroy",
    );
    movedFrom.destroy();
    movedTo.destroy();
    assert.equal(CSS.highlights.size, 0);

    for (let index = 0; index < 200; index++) {
        const component = new ComponentHighlights(document);
        component.setResults(new Set([range]));
        component.setFocus(new Set([range]));
        component.dispose();
    }
    assert.equal(CSS.highlights.size, 0, "component lifecycle leaves no global Range references");
    assert.equal(document.head.querySelectorAll("style").length, 0);
    const beforeUnsupported = CSS.highlights;
    delete CSS.highlights;
    const unsupported = new ComponentHighlights(document);
    unsupported.setResults(new Set([range]));
    unsupported.dispose();
    assert.equal(document.head.querySelectorAll("style").length, 0, "unsupported API does not allocate styles");
    CSS.highlights = beforeUnsupported;

    const original = textMatches("head foo target tail");
    const inserted = textMatches("head foo inserted---- head foo target tail");
    assert.equal(inserted[0].start, original[0].start, "fixture reproduces a misleading same-offset occurrence");
    assert.equal(
        resolveRetainedMatchIndex(inserted, original[0], 1),
        2,
        "unique context wins over misleading old offset",
    );
    const retainedBar = fixture("retained");
    retainedBar.resultMatches = original;
    delete retainedBar.calculateSearchResults;
    Object.assign(retainedBar, {
        syncBackgroundCorpusRoot: () => "",
        documentSearchIndices: {activeRoot: "", consumePending: () => null},
        syncIndexingIndicator: () => {},
        updateCountLabel: () => {},
        syncReplaceButtons: () => {},
        noteSearchCoverage: () => {},
        runSearchPipeline: async () => ({matches: inserted}),
    });
    assert.equal(await retainedBar.calculateSearchResults("foo", false), inserted);
    assert.equal(retainedBar.resultIndex, 2, "real SearchBar refresh uses the retained context anchor");
    retainedBar.destroy();
    const padded = "x".repeat(30) + " foo target " + "z".repeat(30) + " foo other " + "q".repeat(30);
    const oldPadded = textMatches(padded);
    const prefixed = textMatches("foo new " + padded);
    assert.equal(
        resolveRetainedMatchIndex(prefixed, oldPadded[1], 2),
        3,
        "clipped bounded context survives earlier insertion",
    );
    assert.equal(
        resolveRetainedMatchIndex(oldPadded, prefixed[2], 3),
        2,
        "earlier deletion retains the original occurrence",
    );
    const repetitive = textMatches("foo ".repeat(100));
    const previous = repetitive[50];
    assert.equal(resolveRetainedMatchIndex(repetitive, previous, 51), 51, "indistinguishable contexts do not guess");
    const legacy = {...previous};
    delete legacy.listContextClipped;
    assert.equal(resolveRetainedMatchIndex(repetitive, legacy, 1), 51, "legacy matches preserve offset fallback");
    assert.equal(resolveRetainedMatchIndex(textMatches("foo", "other"), original[0], 5), 1, "no cross-block guessing");
    const formula = {
        ...original[0],
        unitId: "inline-math:42",
        highlightKind: "inline-math",
        mathOrdinal: 0,
        mathUnitText: "foo",
    };
    assert.equal(
        resolveRetainedMatchIndex([{...formula, unitId: "inline-math:0"}], formula, 0),
        1,
        "formula physical identity survives renumbering",
    );
    const long = buildListSnippet("a".repeat(100), 0, 90);
    assert.equal(long.listContextClipped & 4, 4, "truncated match cannot masquerade as adjacent context");
    const longPrevious = {...original[0], ...long, matchedText: "a".repeat(90)};
    const longNext = [{...longPrevious}, {...longPrevious, start: 120, end: 210}];
    assert.equal(
        resolveRetainedMatchIndex(longNext, longPrevious, 2),
        2,
        "truncated context does not trust a misleading old offset",
    );
    const literalEllipsis = textMatches("…head foo tail…");
    assert.equal(literalEllipsis[0].listContextClipped, 0, "literal ellipses are not clipping markers");
    const mono = fixture("cursor");
    const cursorContent = mono.edit.querySelector('[contenteditable="true"]');
    cursorContent.textContent = "foo xx foo yy foo";
    const cursorText = cursorContent.firstChild;
    mono.resultMatches = textMatches(cursorText.textContent, "cursor").map(match => {
        const range = document.createRange();
        range.setStart(cursorText, match.start);
        range.setEnd(cursorText, match.end);
        return {...match, range};
    });
    const anchor = document.createRange();
    anchor.setStart(cursorText, 8);
    anchor.setEnd(cursorText, 10);
    assert.equal(
        resolveInitialMatchIndex(mono.resultMatches, {anchorRange: anchor, modeBlocked: false}),
        2,
        "existing selection-covering initial position is unchanged",
    );
    anchor.setStart(cursorText, 12);
    anchor.collapse(true);
    assert.equal(
        resolveInitialMatchIndex(mono.resultMatches, {anchorRange: anchor, modeBlocked: false}),
        2,
        "existing caret-nearest initial position is unchanged",
    );
    assert.equal(resolveInitialMatchIndex(mono.resultMatches, {anchorRange: anchor, modeBlocked: true}), 1);
    anchor.setStart(cursorText, 0);
    anchor.collapse(true);
    assert.equal(resolveInitialMatchIndex(mono.resultMatches, {anchorRange: anchor, modeBlocked: false}), 1);
    assert.equal(resolveInitialMatchIndex(mono.resultMatches, {anchorRange: null, modeBlocked: false}), 1);
    mono.destroy();
    await anchorRegressions();
    await lifecycleRegressions();
    await diagramRegressions();
    await embedRefreshRegressions();
    await embeddedAvMountRegressions();
    await avFoldCacheRegressions();
    await galleryNavigationRegressions();
    console.log(
        "p3-regressions OK (component isolation, prompt pane lifecycle, unchanged-unit/live anchors, budget/cancellation/races and existing initial position)",
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
