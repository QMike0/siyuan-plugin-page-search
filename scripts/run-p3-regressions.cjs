// Direct-source multi-pane/anchor contracts; mocked layout is not real SiYuan E2E.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let lastOpenTabOptions;
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {
        getAllEditor: () => [],
        showMessage: () => {},
        openTab: async options => {
            lastOpenTabOptions = options;
            options.afterOpen?.();
        },
    };
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

async function inputNavigationRegressions() {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 400 ? 1 : ms, ...args);
    const wait = ms => new Promise(resolve => originalTimeout(resolve, ms));
    try {
        for (const kind of ["loaded", "unloaded", "folded", "database"]) {
            const bar = pipelineFixture("input-" + kind);
            last = bar.root;
            bar.isFindInputFocused = () => true;
            const content = bar.edit.querySelector('[contenteditable="true"]');
            content.textContent = "foo foo";
            const loadedMatches = textMatches("foo foo", "input-" + kind).map(match => {
                const range = document.createRange();
                range.setStart(content.firstChild, match.start);
                range.setEnd(content.firstChild, match.end);
                return {...match, range};
            });
            const target = kind === "loaded" ? loadedMatches[1] : {
                ...textMatches("foo", "offscreen")[0],
                ...(kind === "database" ? {blockType: "NodeAttributeView", unitId: "cell:group:row:column"} : {}),
            };
            bar.runSearchPipeline = async () => ({matches: kind === "loaded" ? loadedMatches : [target], error: ""});
            // A selected loaded match remains the current item rather than jumping to item 1.
            bar.getSearchAnchorRange = () => kind === "loaded" ? target.range : null;
            const navigation = [];
            bar.scrollIntoRanges = (index, scroll) => navigation.push({match: bar.resultMatches[index], scroll});
            bar.commitSearchHistory = () => {};
            let pending;
            const highlight = bar.highlightHitResult.bind(bar);
            bar.highlightHitResult = (...args) => pending = highlight(...args);
            bar.scheduleFindFromInput();
            while (!pending) await wait(1);
            await pending;
            assert.equal(navigation.length, 1, "typing reveals one current match: " + kind);
            assert.equal(navigation[0].scroll, true, "typing must scroll rather than only repaint: " + kind);
            assert.equal(navigation[0].match, bar.resultMatches[bar.resultIndex - 1]);
            assert.equal(bar.resultIndex, kind === "loaded" ? 2 : 1, "scroll follows the selected index");
            navigation.length = 0;
            await bar.highlightHitResult("foo", false);
            assert.equal(navigation.some(item => item.scroll), false, "background refresh does not move the editor");
            await bar.highlightHitResult("foo", true);
            assert.equal(navigation.some(item => item.scroll), false, "option synchronization does not move other panes");
            bar.destroy();
        }

        const cold = pipelineFixture("input-cold");
        last = cold.root;
        cold.isFindInputFocused = () => true;
        cold.runSearchPipeline = async () => ({matches: [], error: "", partial: true});
        cold.noteSearchCoverage = (_degraded, partial) => cold.backgroundIndexing = Boolean(partial);
        const navigation = [];
        cold.scrollIntoRanges = (index, scroll) => navigation.push({index, scroll});
        await cold.highlightHitResult("foo", true, false, true);
        assert.equal(navigation.length, 0, "an empty partial index has no target to reveal yet");
        cold.runSearchPipeline = async () => ({matches: textMatches("foo", "cold-target"), error: ""});
        await cold.highlightHitResult("foo", false);
        assert.deepEqual(navigation, [{index: 0, scroll: true}], "first cold-index result fulfills the pending input navigation");
        navigation.length = 0;
        await cold.highlightHitResult("foo", false);
        assert.equal(navigation.length, 0, "later index completion does not repeat automatic navigation");
        for (const reason of ["focus", "pane", "query", "no-results"]) {
            last = cold.root;
            cold.isFindInputFocused = () => true;
            cold.searchText = "foo";
            cold.runSearchPipeline = async () => ({matches: [], error: "", partial: reason !== "no-results"});
            await cold.highlightHitResult("foo", true, false, true);
            if (reason === "focus") cold.isFindInputFocused = () => false;
            if (reason === "pane") last = null;
            if (reason === "query") cold.setSearchText("bar");
            cold.runSearchPipeline = async () => ({matches: textMatches("foo", "late-target"), error: ""});
            await cold.highlightHitResult(cold.searchText, false);
            assert.equal(navigation.some(item => item.scroll), false, "pending navigation is cancelled: " + reason);
        }
        cold.destroy();

        const cancelled = pipelineFixture("input-cancelled");
        last = cancelled.root;
        cancelled.isFindInputFocused = () => true;
        let completePaint;
        let inputNavigations = 0;
        cancelled.applyResultHighlightsWithBudget = () => new Promise(resolve => completePaint = resolve);
        cancelled.runSearchPipeline = async () => ({matches: cancelled.resultMatches, error: ""});
        cancelled.scrollIntoRanges = () => inputNavigations++;
        const pending = cancelled.highlightHitResult("foo", true, false, true);
        while (!completePaint) await wait(1);
        assert.equal(inputNavigations, 1, "current match is revealed without waiting for all highlights to paint");
        cancelled.setSearchText("bar");
        completePaint(false);
        await pending;
        assert.equal(inputNavigations, 1, "cancelled painting does not repeat obsolete input navigation");
        cancelled.destroy();

        const blurred = pipelineFixture("input-blurred");
        last = blurred.root;
        blurred.isFindInputFocused = () => true;
        let completeSearch;
        blurred.runSearchPipeline = () => new Promise(resolve => completeSearch = resolve);
        blurred.scrollIntoRanges = (_index, scroll) => assert.equal(scroll, false, "leaving the input cancels automatic scrolling");
        const blurSearch = blurred.highlightHitResult("foo", true, false, true);
        blurred.isFindInputFocused = () => false;
        completeSearch({matches: blurred.resultMatches, error: ""});
        await blurSearch;
        blurred.destroy();

        const locating = fixture("input-focus");
        const input = document.createElement("input");
        locating.root.appendChild(input);
        const fold = source("frontend/fold");
        const locate = source("frontend/corpus/locate");
        const unfold = fold.unfoldPathToBlock;
        fold.unfoldPathToBlock = async () => false;
        try {
            for (const preserveFocus of [true, false]) {
                input.focus();
                await new Promise(resolve => locate.openBlockInEditor({}, "remote", resolve, locating.edit, preserveFocus));
                const action = lastOpenTabOptions.doc.action;
                assert.equal(action.includes("cb-get-focus"), !preserveFocus, "only ordinary navigation requests editor focus");
                assert.equal(action.includes("cb-get-scroll"), preserveFocus, "find-input navigation requests scrolling without focus");
                assert.equal(document.activeElement, input);
                assert.ok(action.includes("cb-get-context") && action.includes("cb-get-rootscroll"));
                assert.equal(lastOpenTabOptions.doc.zoomIn, false, "focus preservation does not enter zoom mode");
            }
        } finally {
            fold.unfoldPathToBlock = unfold;
            locating.destroy();
        }

        const queued = pipelineFixture("input-queued");
        last = queued.root;
        queued.plugin = {...host, app: {}};
        queued.isFindInputFocused = () => true;
        queued.repairHighlightRanges = () => {};
        queued.finishLocatedMatch = async () => assert.fail("an obsolete block-open callback must not finish a new query");
        delete queued.scrollIntoRanges;
        const originalOpen = locate.openBlockInEditor;
        const opens = [];
        locate.openBlockInEditor = (_app, blockId, done, _edit, preserveFocus) => opens.push({blockId, done, preserveFocus});
        try {
            queued.runSearchPipeline = async () => ({matches: textMatches("foo", "first-unloaded"), error: ""});
            await queued.highlightHitResult("foo", true, false, true);
            assert.equal(opens.length, 1);
            assert.equal(opens[0].preserveFocus, true, "automatic unloaded navigation preserves the actual find input");
            queued.setSearchText("bar");
            queued.runSearchPipeline = async () => ({
                matches: [{...textMatches("foo", "second-unloaded")[0], matchedText: "bar"}], error: "",
            });
            await queued.highlightHitResult("bar", true, false, true);
            assert.equal(opens.length, 1, "new input waits for the previous block-open operation");
            opens[0].done();
            await wait(1);
            assert.equal(opens.length, 2, "releasing the old navigation reveals the latest input target");
            assert.equal(opens[1].blockId, "second-unloaded");
            let finished = 0;
            queued.finishLocatedMatch = async () => finished++;
            await queued.highlightHitResult("bar", false);
            opens[1].done();
            await wait(1);
            assert.equal(finished, 1, "same-query background refresh still finishes the current target");
        } finally {
            locate.openBlockInEditor = originalOpen;
            queued.destroy();
        }
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log("Input navigation: loaded/offscreen/cold targets, one-shot reveal and background/cancellation boundaries OK");
}

async function undoSavedocRegressions() {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 400 ? 15 : ms, ...args);
    const wait = ms => new Promise(resolve => originalTimeout(resolve, ms));
    try {
        for (const timing of ["before-search", "after-search", "without-dom-change"]) {
            const bar = pipelineFixture("undo-save-" + timing);
            const content = bar.edit.querySelector('[contenteditable="true"]');
            content.textContent = "bar";
            await bar.highlightHitResult("foo", true);
            assert.equal(bar.resultCount, 0);
            let refreshes = 0;
            const highlight = bar.highlightHitResult.bind(bar);
            bar.highlightHitResult = (...args) => {
                refreshes++;
                return highlight(...args);
            };
            bar.stopEditorDomWatch = watchEditorDom(bar.edit, {
                onMutate: () => bar.domEpoch++,
                onSettled: change => bar.onEditorDomSettled(change),
            }, 1);
            bar.onEventBus({detail: {cmd: "savedoc"}});
            if (timing === "after-search") await wait(80);
            if (timing !== "without-dom-change") {
                content.textContent = "foo foo";
                await wait(150);
                assert.equal(bar.resultCount, 2, "zero old matches refresh after delayed undo DOM replay: " + timing);
            } else {
                await wait(80);
                assert.equal(refreshes, 1, "savedoc without local DOM still refreshes unloaded content");
            }
            const finished = refreshes;
            await wait(80);
            assert.equal(refreshes, finished, "undo settles without a recurring search loop");
            bar.destroy();
        }
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log("savedoc before/after search, zero-result undo DOM replay and no-DOM savedoc refresh OK");

    const bar = pipelineFixture("in-flight-deletion");
    let complete;
    let signal;
    let warnings = 0;
    bar.runSearchPipeline = (_value, abortSignal) => {
        signal = abortSignal;
        return new Promise(resolve => complete = resolve);
    };
    bar.noteSearchCoverage = () => warnings++;
    const pending = bar.highlightHitResult("foo", false);
    bar.onEventBus({detail: {cmd: "savedoc", data: {sources: [{doOperations: [{action: "delete", id: "gone"}]}]}}});
    window.clearTimeout(bar.typingTimer);
    assert.equal(signal.aborted, true, "savedoc cancels searches containing stale deletion candidates");
    complete({matches: [], error: "", degraded: true, unrendered: 1});
    await pending;
    assert.equal(warnings, 0, "an obsolete failure snapshot never produces coverage popups");
    assert.equal(bar.resultCount, 1, "an obsolete search cannot replace the displayed results");
    bar.destroy();
    console.log("savedoc during an in-flight deletion read discards old warnings/results OK");
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
            const beforeFold = refreshes;
            await settle();
            assert.equal(bar.resultCount, 1, "fold retains the existing rendered labels");
            assert.equal(refreshes, beforeFold, "CSS folding with unchanged SVG text does not restart indexing");
            graph.setAttribute("data-content", "changed");
            graph.innerHTML = '<div spin="1"></div>';
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
        assert.equal(headingBar.resultCount, 1, "parent-heading marker does not discard existing healthy SVG");
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

async function attributeViewLocateRegressions() {
    const originalRect = window.Range.prototype.getBoundingClientRect;
    const originalBridge = window.openFileByURL;
    const blockId = "20260101000000-aaaaaaa";
    const rowId = "20260101000001-aaaaaaa";
    const viewId = "20260101000002-aaaaaaa";
    const setup = (itemClass = "av__row") => {
        const bar = fixture("av-locate");
        last = bar.root;
        bar.includeAttributeView = true;
        bar.syncReplaceButtons = () => {};
        const root = bar.edit.querySelector(".protyle-wysiwyg");
        const calendar = itemClass === "av__calendar-item";
        root.innerHTML = '<div class="av" data-node-id="' + blockId +
            '" data-type="NodeAttributeView" custom-sy-av-view="' + viewId + '">' +
            '<div class="av__body"><div class="' + itemClass + '" data-id="' + rowId + '">' +
            '<div class="' + (calendar ? 'av__calendar-field' : 'av__cell') + '" data-col-id="col">foo</div></div></div></div>';
        const av = root.firstElementChild;
        const gutter = document.createElement("div");
        gutter.className = "protyle-gutters";
        gutter.innerHTML = '<button data-node-id="' + blockId + '" data-type="NodeAttributeView"><svg></svg></button>';
        root.closest(".protyle").prepend(gutter);
        Object.defineProperty(gutter.firstElementChild, "clientHeight", {value: 24});
        gutter.firstElementChild.scrollIntoView = () => assert.fail("native and local database locate must ignore the gutter");
        Object.defineProperty(av, "clientHeight", {value: 100});
        const range = document.createRange();
        range.selectNodeContents(av.querySelector(".av__cell, .av__calendar-field"));
        const unitId = calendar ? "av:" + rowId + ":col" : "cell:nogroup:" + rowId + ":col";
        bar.resultMatches = [{...textMatches("foo", blockId, unitId)[0],
            blockType: "NodeAttributeView", range}];
        return {bar, av, range};
    };
    const drain = async () => {
        for (let step = 0; step < 20; step++) await Promise.resolve();
    };
    try {
        // Keep layout off-screen until the browser can run another frame.
        // Bound the old infinite loop inside the mock so a regression fails without hanging Node.
        window.Range.prototype.getBoundingClientRect = () => ({top: 1500, bottom: 1520, left: 0, right: 100});
        const repeated = setup();
        let nativeCalls = 0;
        repeated.bar.revealMountedAttributeViewMatch = () => false;
        repeated.bar.waitForLocatedMatchRange = async () => true;
        window.openFileByURL = () => {
            nativeCalls++;
            if (nativeCalls > 4) throw new Error("test stopped repeated native locating");
            return true;
        };
        await repeated.bar.scrollIntoRangesAsync(0, true);
        await drain();
        repeated.bar.destroy();
        assert.equal(nativeCalls, 1, "one navigation cannot re-enter native locating before layout catches up");

        for (const itemClass of ["av__row", "av__gallery-item", "av__calendar-item"]) {
            for (const bridge of [true, false]) {
                const {bar, av} = setup(itemClass);
                const body = av.querySelector(".av__body");
                if (itemClass !== "av__calendar-item") {
                    body.dataset.groupId = "target";
                    bar.resultMatches[0].unitId = "cell:target:" + rowId + ":col";
                    const otherGroup = body.cloneNode(true);
                    otherGroup.dataset.groupId = "other";
                    body.before(otherGroup);
                    otherGroup.firstElementChild.scrollIntoView = () => assert.fail("same row in another group must not scroll");
                }
                const content = bar.edit.querySelector(".protyle-content");
                content.style.overflowY = "auto";
                Object.defineProperties(content, {scrollHeight: {value: 3000}, clientHeight: {value: 400}});
                content.getBoundingClientRect = () => ({top: 100, bottom: 500, left: 0, right: 800});
                window.Range.prototype.getBoundingClientRect = () => ({
                    top: 1500 - content.scrollTop, bottom: 1520 - content.scrollTop, left: 0, right: 100,
                });
                let rowScrolls = 0;
                body.querySelector("." + itemClass).scrollIntoView = () => {
                    rowScrolls++;
                    content.scrollTop = 1000;
                };
                let mountedNativeCalls = 0;
                window.openFileByURL = bridge ? () => { mountedNativeCalls++; return false; } : undefined;
                await bar.scrollIntoRangesAsync(0, true);
                assert.equal(rowScrolls, 1, "off-screen mounted " + itemClass + " is revealed directly");
                assert.equal(content.scrollTop, 1210, "Range centering follows row reveal in the editor scroller");
                assert.equal(CSS.highlights.get(bar.getComponentHighlights().focusName)?.size, 1);
                bar.resultMatches[0].range = undefined;
                await bar.scrollIntoRangesAsync(0, true);
                assert.equal(rowScrolls, 2, "a mounted item without a Range can still be revealed");
                assert.equal(bar.resultMatches[0].range?.toString(), "foo", itemClass + " binds its text without native rerender");
                assert.equal(content.scrollTop, 1210, "newly bound text receives exact centering too");
                assert.equal(mountedNativeCalls, 0, "a mounted item never asks the native bridge to rebuild the database");
                bar.destroy();
            }
        }

        // A row absent from the virtual window still needs SiYuan's locator.
        for (const completion of ["mounted", "pending", "query", "navigate"]) {
            const {bar, av} = setup();
            const body = av.querySelector(".av__body");
            const row = body.firstElementChild;
            row.remove();
            bar.resultMatches[0].range = undefined;
            window.Range.prototype.getBoundingClientRect = () => ({top: 1500, bottom: 1520, left: 0, right: 100});
            let requests = 0;
            let release;
            let centered = 0;
            const applyFocus = bar.applyFocusHighlight.bind(bar);
            bar.applyFocusHighlight = range => { centered++; applyFocus(range); };
            row.scrollIntoView = () => {};
            bar.waitForLocatedMatchRange = () => new Promise(resolve => { release = resolve; });
            window.openFileByURL = url => {
                requests++;
                if (requests > 4) throw new Error("test stopped repeated virtual locating");
                assert.equal(url, "siyuan://blocks/" + blockId + "?avItemID=" + rowId + "&avViewID=" + viewId);
                return true;
            };
            await bar.scrollIntoRangesAsync(0, true);
            assert.equal(requests, 1, "unmounted item starts one native locate request");
            if (completion !== "pending") {
                body.append(row);
                const rebound = document.createRange();
                rebound.selectNodeContents(row.querySelector(".av__cell"));
                bar.resultMatches[0].range = rebound;
            }
            if (completion === "query") bar.searchGeneration++;
            if (completion === "navigate") bar.resultIndex = 2;
            release(completion !== "pending");
            await drain();
            assert.equal(requests, 1, "native completion/timeout never starts another locate request");
            assert.equal(centered > 0, completion === "mounted", "only the still-current mounted target is centered");
            bar.destroy();
        }

        const delayed = setup();
        const body = delayed.av.querySelector(".av__body");
        const row = body.firstElementChild;
        row.remove();
        row.scrollIntoView = () => {};
        delayed.bar.resultMatches[0].range = undefined;
        delayed.bar.highlightHitResult = () => assert.fail("mounting the target must not reindex the database");
        let requests = 0;
        window.openFileByURL = () => {
            requests++;
            window.setTimeout(() => body.append(row), 10);
            return true;
        };
        await delayed.bar.scrollIntoRangesAsync(0, true);
        await new Promise(resolve => window.setTimeout(resolve, 50));
        assert.equal(requests, 1, "real observer waits for the virtual item without repeated native requests");
        assert.equal(delayed.bar.resultMatches[0].range?.toString(), "foo");
        assert.equal(delayed.bar.resultIndex, 1);
        assert.equal(delayed.bar.resultCount, 1);
        delayed.bar.destroy();

        const rejected = setup();
        rejected.bar.waitForLocatedMatchRange = () => assert.fail("rejected bridge must not start waiting");
        window.openFileByURL = () => false;
        assert.equal(rejected.bar.revealNativeAttributeViewMatch(0, rejected.bar.resultMatches[0]), false);
        rejected.bar.destroy();

        for (const grouped of [false, true]) {
            for (const allowNative of [false, true]) {
                const cold = setup();
                const body = cold.av.querySelector(".av__body");
                body.replaceChildren();
                cold.bar.resultMatches[0].range = undefined;
                if (grouped) {
                    body.dataset.groupId = "g";
                    body.insertAdjacentHTML("beforebegin", '<div class="av__group-title">group</div>');
                    cold.bar.resultMatches[0].unitId = "av-group:g:" + rowId + ":col";
                    body.previousElementSibling.scrollIntoView = () => {};
                }
                cold.av.scrollIntoView = () => {};
                cold.bar.bindUnfoldedHeadingSection = () => {};
                cold.bar.highlightHitResult = async () => {};
                cold.bar.waitForLocatedMatchRange = async () => false;
                let requests = 0;
                window.openFileByURL = () => { requests++; return true; };
                await cold.bar.finishLocatedMatch(1, true, allowNative);
                await drain();
                assert.equal(requests, allowNative ? 1 : 0, "cold carrier continues to its virtual row exactly once, respecting re-entry protection");
                cold.bar.destroy();
            }
        }

        const wrongCarrier = setup();
        wrongCarrier.av.dataset.nodeId = "20260101000000-bbbbbbb";
        wrongCarrier.bar.resultMatches[0].range = undefined;
        wrongCarrier.av.querySelector(".av__row").scrollIntoView = () => assert.fail("another carrier with the same row ID must never scroll");
        assert.equal(wrongCarrier.bar.revealMountedAttributeViewMatch(wrongCarrier.bar.resultMatches[0]), false);
        wrongCarrier.bar.destroy();

        const staleView = setup();
        const owner = document.createElement("div");
        owner.dataset.nodeId = "embed";
        owner.dataset.type = "NodeBlockQueryEmbed";
        staleView.av.replaceWith(owner);
        owner.append(staleView.av);
        Object.assign(staleView.bar.resultMatches[0], {
            blockId: "embed", blockType: "NodeBlockQueryEmbed", range: undefined,
            unitId: "embed:" + blockId + ":av:" + rowId + ":col",
            embeddedAvViewId: "20260101000000-ccccccc",
        });
        window.openFileByURL = () => assert.fail("a stale embedded view cannot activate native locating");
        assert.equal(staleView.bar.revealMountedAttributeViewMatch(staleView.bar.resultMatches[0]), false);
        assert.equal(staleView.bar.revealNativeAttributeViewMatch(0, staleView.bar.resultMatches[0]), false);
        staleView.bar.destroy();
    } finally {
        window.Range.prototype.getBoundingClientRect = originalRect;
        window.openFileByURL = originalBridge;
    }
    console.log("AV off-screen navigation: bounded native locate, mounted layouts, fallback and cancellation OK");
}

async function firstBlockNavigationRegressions() {
    const {collectSearchableBlocks, findDocumentBlock} = source("frontend/blocks");
    const {blockIsInEditor} = source("frontend/corpus/locate");
    const {projectRanges} = source("frontend/corpus/project");
    const originalRect = window.Range.prototype.getBoundingClientRect;
    const originalBridge = window.openFileByURL;
    const blockId = "20260101000000-firstaa";
    const rowId = "20260101000001-rowaaaa";
    const viewId = "20260101000002-viewaaa";
    try {
        for (const database of [false, true]) {
            for (const leading of [false, true]) {
                for (const gutterHidden of [false, true]) {
                    const bar = pipelineFixture("first-block-navigation"); last = bar.root;
                    bar.includeAttributeView = true;
                    const root = bar.edit.querySelector(".protyle-wysiwyg");
                    const av = '<div class="av" data-node-id="' + (database ? blockId : "another-av") +
                        '" data-type="NodeAttributeView" custom-sy-av-view="' + viewId + '"><div class="av__body">' +
                        '<div class="av__row" data-id="' + rowId + '"><div class="av__cell" data-col-id="col">foo</div></div></div></div>';
                    root.innerHTML = (leading ? '<div data-node-id="leading" data-type="NodeParagraph"><div contenteditable="true"></div></div>' : "") +
                        (database ? av : '<div data-node-id="' + blockId + '" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>' + av);
                    const protyle = root.closest(".protyle");
                    const gutter = document.createElement("div");
                    gutter.className = "protyle-gutters" + (gutterHidden ? " fn__none" : "");
                    gutter.innerHTML = '<button data-node-id="' + blockId + '" data-type="' +
                        (database ? "NodeAttributeView" : "NodeParagraph") + '"><svg></svg></button>';
                    protyle.prepend(gutter);
                    const button = gutter.firstElementChild;
                    Object.defineProperty(button, "clientHeight", {value: gutterHidden ? 0 : 24});
                    button.scrollIntoView = () => assert.fail("navigation must not scroll a gutter carrying the same block ID");
                    const owner = root.querySelector('[data-node-id="' + blockId + '"]');
                    Object.defineProperty(owner, "clientHeight", {value: 1800});
                    const content = root.closest(".protyle-content");
                    content.style.overflowY = "auto";
                    Object.defineProperties(content, {scrollHeight: {value: 3000}, clientHeight: {value: 400}});
                    content.getBoundingClientRect = () => ({top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400});
                    window.Range.prototype.getBoundingClientRect = () => ({
                        top: 1500 - content.scrollTop, bottom: 1520 - content.scrollTop, left: 0, right: 100, width: 100, height: 20,
                    });
                    window.openFileByURL = () => assert.fail("mounted content must not need a native database rebuild");
                    if (database) owner.querySelector(".av__row").scrollIntoView = () => { content.scrollTop = 1000; };
                    const live = collectSearchableBlocks(bar.edit, {includeAttributeView: true});
                    const unit = live.find(block => block.blockId === blockId && block.text === "foo");
                    assert.ok(unit, "the live collector indexes the screen-external target");
                    unit.element.getBoundingClientRect = () => ({
                        top: 1500 - content.scrollTop, bottom: 1520 - content.scrollTop, left: 0, right: 100, width: 100, height: 20,
                    });
                    bar.resultMatches = projectRanges(bar.edit,
                        textMatches(unit.text, unit.blockId, unit.unitId).map(match => ({...match, blockType: unit.blockType})),
                        {includeAttributeView: true}, live);
                    assert.equal(bar.resultMatches[0].range, undefined, "off-screen viewport projection leaves no live Range");
                    let navigation;
                    bar.scrollIntoRanges = (...args) => navigation = bar.scrollIntoRangesAsync(...args);
                    bar.resultIndex = 0;
                    if (gutterHidden) bar.clickLast();
                    else bar.clickNext();
                    await navigation;
                    for (let i = 0; i < 15; i++) await Promise.resolve();
                    assert.equal(bar.resultMatches[0].range?.toString(), "foo", "off-screen target binds inside the real first block");
                    assert.equal(content.scrollTop, 1210, "first and later blocks center the same matched text");
                    assert.equal(bar.resultCount, 1, "navigation never changes the search count");
                    owner.remove();
                    assert.equal(findDocumentBlock(bar.edit, blockId), null, "a retained gutter is not an unloaded/folded target");
                    assert.equal(blockIsInEditor(bar.edit, blockId), false, "gutter dimensions cannot suppress native load/unfold");
                    bar.destroy();
                }
            }
        }
        const bar = pipelineFixture("block-lookup-boundaries"); last = bar.root;
        const {edit} = bar;
        const protyle = edit.querySelector(".protyle");
        const root = edit.querySelector(".protyle-wysiwyg");
        const block = '<div data-node-id="' + blockId + '" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>';
        root.innerHTML = '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + block + '</div>' + block;
        const actual = root.lastElementChild;
        const inactive = protyle.cloneNode(true);
        inactive.classList.add("fn__none");
        edit.prepend(inactive);
        const parser = protyle.cloneNode(true);
        parser.setAttribute("data-page-search-offscreen", "true");
        edit.prepend(parser);
        assert.equal(findDocumentBlock(edit, blockId), actual, "skip inactive panes, parser DOM and embedded source copies");
        assert.equal(findDocumentBlock(protyle, blockId), actual, "a direct Protyle root remains supported");
        assert.equal(findDocumentBlock(root, blockId), actual, "a direct document root remains supported");
        assert.equal(findDocumentBlock(edit, "embed"), root.firstElementChild, "embedded matches still locate their owner");
        actual.remove();
        assert.equal(findDocumentBlock(edit, blockId), null, "an embedded source is not the unloaded main-document block");
        root.innerHTML = '<div data-node-id="heading" data-type="NodeHeading" fold="1">heading</div>' +
            '<div data-type="NodeList" fold="1">' + block + '</div>';
        const folded = root.querySelector('[data-node-id="' + blockId + '"]');
        assert.equal(findDocumentBlock(edit, blockId), folded, "folded descendants must remain available for unfold checks");
        assert.equal(findDocumentBlock(edit, "heading"), root.firstElementChild);
        protyle.querySelector(".protyle-content").classList.add("fn__none");
        const preview = document.createElement("div");
        preview.className = "protyle-preview";
        preview.innerHTML = '<div class="b3-typography">' + block + '</div>';
        protyle.append(preview);
        assert.equal(findDocumentBlock(edit, blockId), preview.firstElementChild.firstElementChild, "preview uses its active document root");
        preview.classList.add("fn__none");
        assert.equal(findDocumentBlock(edit, blockId), null, "hidden editor surfaces are not navigation targets");
        bar.destroy();
        for (const late of ["insert-block", "fill-text"]) {
            const pendingBar = pipelineFixture("late-first-block"); last = pendingBar.root;
            const body = pendingBar.edit.querySelector(".protyle-wysiwyg");
            const shell = document.createElement("div");
            shell.innerHTML = block;
            const target = shell.firstElementChild;
            body.innerHTML = "";
            const gutter = document.createElement("button");
            gutter.dataset.nodeId = blockId;
            pendingBar.edit.querySelector(".protyle").prepend(gutter);
            pendingBar.resultMatches = textMatches("foo", blockId);
            pendingBar.repairHighlightRanges = () => {};
            if (late === "fill-text") {
                target.firstElementChild.textContent = "";
                body.append(target);
            }
            const waiting = pendingBar.waitForLocatedMatchRange(1, pendingBar.resultMatches[0].id);
            if (late === "insert-block") body.append(target);
            else target.firstElementChild.textContent = "foo";
            for (let i = 0; i < 4; i++) await Promise.resolve();
            assert.equal(pendingBar.resultMatches[0].range?.toString(), "foo", "late body mutations bind without waiting for fallback polling: " + late);
            assert.equal(await waiting, true);
            pendingBar.destroy();
        }
    } finally {
        window.Range.prototype.getBoundingClientRect = originalRect;
        window.openFileByURL = originalBridge;
    }
    console.log("First-block navigation: ordinary/database, no live Range, leading paragraph and hidden/visible gutter IDs OK");
}

async function afterVirtualDatabaseNavigationRegressions() {
    const originalRect = window.Range.prototype.getBoundingClientRect;
    const originalBridge = window.openFileByURL;
    const rect = (top, height) => ({top, bottom: top + height, height, left: 0, right: 800, width: 800});
    try {
        for (const distance of [10, 150, 1000]) {
            for (const noRange of [false, true]) {
                for (const backwards of [false, true]) {
                    const bar = pipelineFixture("after-virtual-database"); last = bar.root;
                    const root = bar.edit.querySelector(".protyle-wysiwyg");
                    root.innerHTML = '<div class="av" data-node-id="database" data-type="NodeAttributeView" data-render="true" data-av-type="table" data-v-scroll="true">' +
                        '<div class="av__body" data-page-size="1000"><div class="av__row" data-id="row">row</div></div></div>' +
                        '<div data-node-id="target" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>';
                    const av = root.firstElementChild, target = root.lastElementChild;
                    const content = root.closest(".protyle-content");
                    content.style.overflowY = "auto";
                    let height = 3600, scrollTop = backwards ? 5000 : 0;
                    let fills = 0, scheduled;
                    Object.defineProperties(content, {
                        scrollHeight: {get: () => height + distance + 1000}, clientHeight: {value: 400},
                        scrollTop: {get: () => scrollTop, set: value => {
                            scrollTop = value;
                            // v3.8.7 doTrim: an ungrouped virtual body near the viewport
                            // appends up to one viewport of rows; there is no bottom spacer.
                            if (!scheduled) scheduled = window.requestAnimationFrame(() => {
                                scheduled = 0;
                                const avRect = av.getBoundingClientRect();
                                if (avRect.bottom >= 100 && avRect.top <= 500) {
                                    height += 432;
                                    fills++;
                                }
                            });
                        }},
                    });
                    content.getBoundingClientRect = () => rect(100, 400);
                    av.getBoundingClientRect = () => rect(100 - scrollTop, height);
                    const targetRect = () => rect(100 - scrollTop + height + distance, 20);
                    target.getBoundingClientRect = target.firstElementChild.getBoundingClientRect = targetRect;
                    Object.defineProperty(target, "clientHeight", {value: 20});
                    window.Range.prototype.getBoundingClientRect = targetRect;
                    window.openFileByURL = () => assert.fail("a following paragraph never starts native database locating");
                    const range = document.createRange(); range.selectNodeContents(target.firstElementChild);
                    bar.resultMatches = [{...textMatches("foo", "target")[0], range: noRange ? undefined : range}];
                    let navigation;
                    bar.scrollIntoRanges = (...args) => navigation = bar.scrollIntoRangesAsync(...args);
                    bar.resultIndex = 0;
                    if (backwards) bar.clickLast(); else bar.clickNext();
                    await navigation;
                    await new Promise(resolve => window.requestAnimationFrame(resolve));
                    assert.equal(fills, 0, "one navigation must not pull more database rows in front of the target");
                    const finalRect = bar.resultMatches[0].range.getBoundingClientRect();
                    assert.ok(finalRect.top >= 100 && finalRect.bottom <= 500, "following text stays visible after native layout");
                    assert.equal(scrollTop, distance < 200 ? 3601 : 4410, "nearby targets clear the virtual database; distant targets still center");
                    assert.equal(bar.resultCount, 1, "the navigation does not alter search coverage");
                    assert.equal(av.dataset.vScroll, "true", "native virtualization remains enabled");
                    bar.destroy();
                }
            }
        }
        for (const boundary of ["ordinary", "reserved-height", "inside-database", "another-scroller", "no-space", "no-scroll", "preceding-target"]) {
            const bar = pipelineFixture("after-av-boundary"); last = bar.root;
            const root = bar.edit.querySelector(".protyle-wysiwyg");
            root.innerHTML = '<div class="av" data-node-id="database" data-type="NodeAttributeView" data-render="true" data-v-scroll="true">' +
                '<div class="av__body"><div class="av__cell">foo</div></div></div>' +
                '<div data-node-id="target" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>';
            const av = root.firstElementChild, target = root.lastElementChild;
            const content = root.closest(".protyle-content");
            content.style.overflowY = "auto";
            content.style.overflowX = "auto";
            Object.defineProperties(content, {
                scrollHeight: {value: boundary === "no-space" ? 3900 : 5000}, clientHeight: {value: 400},
                scrollWidth: {value: 2000}, clientWidth: {value: 800},
            });
            content.getBoundingClientRect = () => rect(100, 400);
            av.getBoundingClientRect = () => rect(100 - content.scrollTop, 3600);
            window.Range.prototype.getBoundingClientRect = () => ({
                ...rect(3710 - content.scrollTop, 20), left: 1000 - content.scrollLeft, right: 1100 - content.scrollLeft,
            });
            if (boundary === "ordinary") av.removeAttribute("data-v-scroll");
            if (boundary === "reserved-height") av.firstElementChild.insertAdjacentHTML("beforeend", '<div class="av__spacer--bottom"></div>');
            if (boundary === "another-scroller") {
                const nested = document.createElement("div"); nested.className = "protyle-content";
                av.before(nested); nested.append(av);
            }
            if (boundary === "preceding-target") av.before(target);
            const range = document.createRange();
            range.selectNodeContents(boundary === "inside-database" ? av.querySelector(".av__cell") : target.firstElementChild);
            bar.resultMatches = [{...textMatches("foo", boundary === "inside-database" ? "database" : "target")[0], range}];
            bar.attributeViewRangeNeedsReveal = () => false;
            await bar.scrollIntoRangesAsync(0, boundary !== "no-scroll");
            assert.equal(content.scrollTop, boundary === "no-scroll" ? 0 : 3420, "existing centering/refresh is retained at boundary: " + boundary);
            assert.equal(content.scrollLeft, boundary === "no-scroll" ? 0 : 650, "horizontal positioning is retained: " + boundary);
            assert.equal(root.querySelectorAll("[data-node-id]").length, 2, "navigation adds no placeholder blocks");
            bar.destroy();
        }
    } finally {
        window.Range.prototype.getBoundingClientRect = originalRect;
        window.openFileByURL = originalBridge;
    }
    console.log("After-AV navigation: near/far, next/previous and live/rebound targets stay visible without growing the database OK");
}

async function avDeferredRefreshRegressions() {
    const {watchAttributeViewDom} = source("frontend/av-watch");
    const originalTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 280 ? 15 : delay, ...args);
    const settle = () => new Promise(resolve => originalTimeout(resolve, 180));
    try {
        for (const embedded of [false, true]) {
            const bar = pipelineFixture("av-deferred-refresh"); last = bar.root;
            Object.assign(bar, {includeAttributeView: true, includeEmbedBlock: true, includeFoldedBlocks: false, avWatchPausedUntil: 0});
            const root = bar.edit.querySelector(".protyle-wysiwyg");
            const row = id => '<div class="av__row" data-id="row' + id + '"><div class="av__cell" data-col-id="col">foo</div></div>';
            const avMarkup = '<div class="av" data-node-id="carrier" data-av-id="database" data-type="NodeAttributeView"><div class="av__body" data-page-size="1">' + row(1) + '</div></div>';
            root.innerHTML = embedded ? '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + avMarkup + '</div>' : avMarkup;
            const collect = source("frontend/blocks").collectSearchableBlocks;
            const projection = source("frontend/corpus/project");
            let searches = 0;
            bar.runSearchPipeline = async () => {
                searches++;
                const live = collect(bar.edit, {includeAttributeView: true, includeEmbedBlock: true});
                bar.embedSearchState.capture(live);
                return {matches: projection.projectRanges(bar.edit, live.filter(block => block.text === "foo").flatMap(block =>
                    textMatches(block.text, block.blockId, block.unitId).map(match => ({...match, blockType: block.blockType}))
                ), {}, live), error: "", degraded: false};
            };
            await bar.highlightHitResult("foo", true);
            assert.equal(bar.resultCount, 1);
            bar.stopEditorDomWatch = watchEditorDom(bar.edit, {
                onMutate: () => bar.domEpoch++, onSettled: change => bar.onEditorDomSettled(change),
            }, 1);
            const changes = [];
            bar.stopAvDomWatch = watchAttributeViewDom(bar.edit, (ids, invalidate, displayChanged) => {
                changes.push(displayChanged);
                bar.scheduleAttrViewResearch(ids, invalidate, displayChanged);
            }, 5);
            let body = root.querySelector(".av__body");
            bar.pauseAvWatch(80);
            body.dataset.pageSize = "2";
            body.insertAdjacentHTML("beforeend", row(2));
            await settle();
            assert.equal(searches, 2, "load more during navigation refreshes once after the pause");
            assert.equal(bar.resultCount, 2);
            assert.equal(changes.at(-1), true);
            const beforePaint = searches;
            bar.pauseAvWatch(80);
            const replacement = body.cloneNode(true);
            body.replaceWith(replacement);
            body = replacement;
            await settle();
            assert.equal(changes.at(-1), false, "native repaint preserves the display window identity");
            assert.equal(searches, beforePaint, "native repaint during navigation only repairs ranges");
            bar.scheduleAttrViewResearch(["database"], true);
            bar.pauseAvWatch(80);
            await settle();
            assert.equal(searches, beforePaint + 1, "pausing cannot discard an already queued real change");
            bar.pauseAvWatch(80);
            bar.scheduleAttrViewResearch(["database"], true);
            bar.scheduleAttrViewResearch(["database"], true);
            await settle();
            assert.equal(searches, beforePaint + 2, "multiple paused edits coalesce into one refresh");
            bar.scheduleAttrViewResearch(["database"], true);
            bar.searchText = "different";
            await settle();
            assert.equal(searches, beforePaint + 2, "changing the query discards an old deferred refresh");
            bar.scheduleAttrViewResearch(["database"], true);
            bar.destroy();
            await settle();
            assert.equal(searches, beforePaint + 2, "destroy cancels deferred refreshes and observers");
        }
    } finally {
        window.setTimeout = originalTimeout;
    }
    console.log("AV deferred refresh: load more, queued/merged edits, repaint isolation and lifecycle cancellation OK");
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
            for (const restrictInlineTypes of [[], ["inline-math"]]) {
                const test = setup(embedded);
                const {bar, root} = test;
                root.querySelectorAll(".av__cell").forEach(cell => cell.innerHTML =
                    '<span data-type="inline-math" data-content="x" data-render="true"><span class="katex-html">foo</span></span>');
                const options = {includeAttributeView: true, includeEmbedBlock: true, restrictInlineTypes};
                const live = source("frontend/blocks").collectSearchableBlocks(bar.edit, options);
                const formula = live.find(unit => unit.text === "foo" && unit.unitId.includes("cell:target:row:col") &&
                    unit.blockId === (embedded ? "embed" : "ordinary-av"));
                assert.ok(formula, "folded AV formula has a stable cell/group identity");
                const target = {...matchTextUnitsDetailed([formula], "foo").hits[0], replaceable: false,
                    highlightKind: restrictInlineTypes.length ? "inline-math" : "text",
                    mathOrdinal: formula.mathOrdinal, mathUnitText: "foo"};
                bar.resultMatches = [target];
                bar.searchCollectOptions = () => options;
                await bar.scrollIntoRangesAsync(0, true);
                assert.equal(test.clicks(), 1, "default/math-only formula navigation unfolds exactly its group");
                assert.equal(bar.resultMatches[0].range?.toString(), "foo");
                assert.equal(bar.resultMatches[0].range.startContainer.parentElement.closest("[data-group-id]").dataset.groupId, "target");
                bar.destroy();
            }
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
    // Exercise the real SearchBar invalidation callback, with two databases
    // sharing a root. Query identity already belongs to each AV cache key.
    const bar = fixture("query-cache");
    const queryRoot = bar.edit.querySelector(".protyle-wysiwyg");
    queryRoot.innerHTML = ["a", "b"].map(id => '<div data-type="NodeAttributeView" data-av-id="' + id + '">' +
        '<div class="av__views"><div data-type="av-search">keep</div></div><div class="av__body"></div></div>').join("");
    Object.assign(bar, {rememberCurrentRootId: () => "query-root", effectiveQuery: () => "", includeAttributeView: true});
    const refs = ["a", "b"].map(id => ({blockId: "carrier-" + id, avId: id, updated: "u", carrierViewId: "v"}));
    const apiModule = source("frontend/corpus/api");
    const oldPost = apiModule.postJson;
    let queryReads = 0;
    apiModule.postJson = async url => {
        queryReads++;
        return url.endsWith("getAttributeView") ? {name: "db", views: [{id: "v", name: "view"}]} :
            {view: {columns: [{id: "k"}], rowCount: 1, rows: [{id: "i", cells: [{value: {keyID: "k", text: {content: "foo"}}}]}]}};
    };
    const calls = [];
    const stopCacheWatch = watchAttributeViewDom(bar.edit, (ids, invalidate) => {
        calls.push({ids, invalidate});
        bar.scheduleAttrViewResearch(ids, invalidate);
    }, 5);
    const queryA = queryRoot.querySelector('[data-av-id="a"] [data-type="av-search"]');
    const waitWatch = () => new Promise(resolve => setTimeout(resolve, 20));
    const assertCached = () => assert.equal(av.peekAvUnits(refs).missing.length, 0);
    try {
        av.invalidateAvCache();
        av.pinAvCache("query-root", refs, new Map(), bar.edit);
        await av.loadAvUnits(refs);
        const beforeQuery = queryReads;
        queryA.firstChild.nodeValue = "changed";
        queryA.dispatchEvent(new window.Event("input", {bubbles: true}));
        await waitWatch();
        assert.deepEqual(calls, [{ids: undefined, invalidate: false}]);
        assertCached();
        await av.loadAvUnits(refs);
        assert.equal(queryReads, beforeQuery, "native query input retains cached values of both databases");
        // Start composing while a previous query-only debounce is pending.
        queryA.dispatchEvent(new window.Event("input", {bubbles: true}));
        queryA.dispatchEvent(new window.CompositionEvent("compositionstart", {bubbles: true}));
        queryA.textContent = "interim";
        queryA.dispatchEvent(new window.InputEvent("input", {bubbles: true, isComposing: true}));
        await waitWatch();
        assert.equal(calls.length, 1, "IME input and its childList mutation do not refresh provisional queries");
        assertCached();
        queryA.textContent = "final";
        queryA.dispatchEvent(new window.CompositionEvent("compositionend", {bubbles: true}));
        queryA.dispatchEvent(new window.InputEvent("input", {bubbles: true}));
        await waitWatch();
        assert.equal(calls.length, 2, "compositionend and final input coalesce");
        assert.equal(calls[1].invalidate, false);
        assertCached();
        queryA.firstChild.nodeValue = "cut";
        queryA.dispatchEvent(new window.Event("cut", {bubbles: true}));
        await waitWatch();
        assert.equal(calls.length, 3, "native cut refreshes without an input event");
        assertCached();
        queryA.textContent = "";
        await waitWatch();
        assert.equal(calls.length, 4);
        assertCached();
        const queryRef = {...refs[0], query: "final"};
        await av.loadAvUnits([queryRef]);
        assert.equal(queryReads, beforeQuery + 2, "new native query uses its own cache entry");
        await av.loadAvUnits([queryRef]);
        assert.equal(queryReads, beforeQuery + 2, "repeated native query reuses its entry");
        // Native avRender rebuilds the queried shell. It must not evict B.
        queryRoot.querySelector('[data-av-id="a"]').insertAdjacentHTML("beforeend", '<div class="av__header">rebuilt</div>');
        await waitWatch();
        assert.deepEqual(calls.at(-1), {ids: ["a"], invalidate: true});
        assert.equal(av.peekAvUnits([refs[0], queryRef]).missing.length, 2, "real structural changes invalidate all affected AV query variants");
        assert.equal(av.peekAvUnits([refs[1]]).missing.length, 0);
        const beforeB = queryReads;
        await av.loadAvUnits([refs[1]]);
        assert.equal(queryReads, beforeB, "query-induced rebuild of A does not reload B");
        await av.loadAvUnits([refs[0]]);
        queryA.dispatchEvent(new window.Event("input", {bubbles: true}));
        for (const shell of queryRoot.children) shell.setAttribute("data-render", "true");
        await waitWatch();
        assert.deepEqual(calls.at(-1), {ids: ["a", "b"], invalidate: true}, "mixed batches retain every structural invalidation");
        assert.equal(av.peekAvUnits(refs).missing.length, 2);
        await av.loadAvUnits(refs);
        // Replacing a whole AV ID invalidates both its previous and new values.
        queryRoot.firstElementChild.setAttribute("data-av-id", "b");
        await waitWatch();
        assert.deepEqual(new Set(calls.at(-1).ids), new Set(["a", "b"]));
        assert.equal(av.peekAvUnits(refs).missing.length, 2);
        await av.loadAvUnits(refs);
        queryRoot.insertAdjacentHTML("beforeend", '<div data-type="NodeAttributeView"><div class="av__header">unknown</div></div>');
        await waitWatch();
        assert.deepEqual(calls.at(-1), {ids: undefined, invalidate: true}, "unidentified structural change retains conservative fallback");
        assert.equal(av.peekAvUnits(refs).missing.length, 2);
    } finally {
        stopCacheWatch();
        const beforeStop = calls.length;
        queryA.textContent = "disposed";
        for (const type of ["input", "cut", "compositionstart", "compositionend"]) {
            queryA.dispatchEvent(new window.Event(type, {bubbles: true}));
        }
        await waitWatch();
        assert.equal(calls.length, beforeStop, "all query/composition listeners are disposed");
        apiModule.postJson = oldPost;
        av.releaseAvCacheOwner("query-root", bar.edit);
        av.invalidateAvCache();
        bar.destroy();
    }
    console.log("AV query/IME/cut handling, scoped cache invalidation, mixed batches and ID replacement OK");
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
    {
        const client = source("frontend/kernel-client");
        const original = client.rpcSetPrefs;
        const a = fixture("custom-switch-a");
        const b = fixture("custom-switch-b");
        const writes = [];
        const refreshes = [];
        a.includeCustomBlock = b.includeCustomBlock = true;
        a.highlightHitResult = async (query, scroll) => refreshes.push(["a", query, scroll]);
        b.highlightHitResult = async (query, scroll) => refreshes.push(["b", query, scroll]);
        a.plugin = {...host, syncIncludeCustomBlock: (value, source) => {
            assert.equal(source, a);
            b.applyIncludeCustomBlock(value);
        }};
        client.rpcSetPrefs = async (_plugin, patch) => writes.push(patch);
        try {
            await a.setIncludeCustomBlock(false);
            assert.equal(a.includeCustomBlock, false);
            assert.equal(b.includeCustomBlock, false);
            assert.deepEqual(writes, [{includeCustomBlock: false}]);
            assert.deepEqual(refreshes, [["b", "foo", true], ["a", "foo", true]]);
            await a.setIncludeCustomBlock(false);
            b.applyIncludeCustomBlock(false);
            assert.equal(writes.length, 1);
            assert.equal(refreshes.length, 2, "unchanged switches do not trigger repeated searches");
        } finally {
            client.rpcSetPrefs = original;
            a.destroy();
            b.destroy();
        }
        console.log("Custom block switch persistence and pane synchronization OK");
    }
    await inputNavigationRegressions();
    await undoSavedocRegressions();
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
    await avDeferredRefreshRegressions();
    await attributeViewLocateRegressions();
    await firstBlockNavigationRegressions();
    await afterVirtualDatabaseNavigationRegressions();
    await galleryNavigationRegressions();
    console.log(
        "p3-regressions OK (component isolation, prompt pane lifecycle, unchanged-unit/live anchors, budget/cancellation/races and existing initial position)",
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
