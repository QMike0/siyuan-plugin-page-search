/* eslint-disable no-undef, @typescript-eslint/no-this-alias -- main runs inside the shared isolated harness. */
// Native tabsRender structure and isolated kernel responses; never edits notes.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const harness = fs.readFileSync(path.join(__dirname, "run-code-language-regressions.cjs"), "utf8");
const setup = "const renderers = {};\n" + harness.slice(0, harness.indexOf("async function main()")).replace(
    "getAllEditor: () => editors,", "ProtyleMethod: renderers, getAllEditor: () => editors,");
async function main() {
    const style = document.createElement("style");
    style.textContent = '.tabs[data-tabs-ready="true"] > .tab-item[data-tabs-hidden="true"], ' +
        '.tabs[data-tabs-ready="true"] > .tab-item:not([data-tabs-editing="true"]) > .tab-item-info, ' +
        '.tabs[fold="1"] > .tab-item, .fn__none {display:none}';
    document.head.append(style);
    const computed = global.getComputedStyle;
    global.getComputedStyle = element => computed(element.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? element.closest(".katex-mathml") : element);
    window.Element.prototype.getClientRects = function() {
        for (let el = this; el; el = el.parentElement) if (getComputedStyle(el).display === "none") return [];
        return [rect(0, 0, 100, 20)];
    };
    const formula = (rendered = true, block = false) => "<" + (block ? 'div data-type="NodeMathBlock"' : 'span data-type="inline-math"') +
        ' data-subtype="math" data-content="\\alpha+\\alpha">' + (rendered ?
            '<span class="katex"><span class="katex-html" aria-hidden="true">α+α</span><span class="katex-mathml"><math><annotation>\\alpha+\\alpha</annotation></math></span></span>' : "") +
        (block ? "</div>" : "</span>");
    const fixture = (rendered = true) => '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" data-tabs-ready="true" tabs-active-id="B">' +
        '<div class="tabs-header">' + ["A", "B", "C"].map(id => '<button class="tabs-tab" data-tab-id="' + id + '"><span class="tabs-tab-label">before ' + formula() + " after</span></button>").join("") + "</div>" +
        ["A", "B", "C"].map(id => '<div class="tab-item" data-type="NodeTabItem" data-node-id="' + id + '" data-tabs-hidden="' + (id !== "B") + '">' +
            '<div class="tab-item-info"><div data-type="NodeParagraph" data-node-id="title' + id + '" tabs-title="true"><div class="tab-item-title" contenteditable="true">before ' + formula() + " after</div></div></div>" +
            '<div class="tab-item-content"><div data-type="NodeParagraph" data-node-id="body' + id + '"><div contenteditable="true">before ' + formula(rendered || id === "B") + " after</div></div>" +
            formula(rendered || id === "B", true).replace('data-type="NodeMathBlock"', 'data-type="NodeMathBlock" data-node-id="math' + id + '"') + "</div></div>").join("") + "</div>";
    const expected = ["A", "B", "C"].flatMap(id => ["title" + id, "body" + id, "math" + id].flatMap(id => [id, id]));
    let renders = 0;
    renderers.mathRender = root => {
        renders++;
        root.querySelectorAll('[data-subtype="math"]').forEach(el => {
            el.innerHTML = '<span class="katex"><span class="katex-html" aria-hidden="true">α+α</span></span>';
            el.setAttribute("data-render", "true");
        });
    };
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    const doms = {};
    const orders = [];
    const root = document.createElement("div"); root.innerHTML = fixture();
    root.querySelectorAll("[data-node-id]").forEach(el => {
        const id = el.dataset.nodeId;
        orders.push(id); doms[id] = el.outerHTML;
        const type = {NodeTabs: "tabs", NodeTabItem: "tab", NodeParagraph: "p", NodeMathBlock: "m"}[el.dataset.type];
        const parent = el.parentElement.closest("[data-node-id]")?.dataset.nodeId || "root";
        db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "root", parent, type, "", "α+α", "$\\alpha+\\alpha$", el.hasAttribute("tabs-title") ? 'tabs-title="true"' : "", "hash", "1");
    });
    responder = async (url, payload) => url === "/api/query/sql" ? {code: 0, data: db.prepare(payload.stmt).all()} :
        url === "/api/block/getDocBlocksOrders" ? {code: 0, data: orders} :
        url === "/api/block/getBlockDOMs" ? {code: 0, data: doms} : {code: -1};
    try {
        // Kernel DOMs contain source blocks, not the rendered navigation clones.
        // Fetching a tabs/tab container as well as its leaves used to count the
        // same source formula once per fetched ancestor.
        const savedDoms = {...doms};
        const kernelResponder = responder;
        const requestedIds = [];
        let normalizationUnavailable = false;
        responder = async (url, payload) => {
            if (url === "/api/block/getBlockDOMs") requestedIds.push(...payload.ids);
            if (normalizationUnavailable && url === "/api/query/sql" && payload.stmt.includes("search_normalize(")) return {code: -1};
            return kernelResponder(url, payload);
        };
        const unloaded = '<div data-node-id="outside" data-type="NodeParagraph">outside</div>';
        try {
            for (const id of Object.keys(doms)) {
                const node = document.createElement("div"); node.innerHTML = doms[id];
                node.querySelectorAll(".tabs-header").forEach(el => el.remove());
                node.querySelectorAll('[data-subtype="math"]').forEach(el => el.replaceChildren());
                node.querySelectorAll("[data-tabs-ready], [data-tabs-hidden]").forEach(el => {
                    el.removeAttribute("data-tabs-ready"); el.removeAttribute("data-tabs-hidden");
                });
                doms[id] = node.innerHTML;
            }
            editors = [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}];
            for (const loaded of ["unloaded", "partial", "loaded"]) for (const sourceMode of [true, false]) {
                for (const queryKind of ["literal", "regex", "unfiltered-regex", "sql-fallback"]) {
                    normalizationUnavailable = queryKind === "sql-fallback";
                    wysiwyg.innerHTML = loaded === "loaded" ? fixture(false) : loaded === "partial" ?
                        '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" tabs-active-id="B"><div class="tab-item" data-type="NodeTabItem" data-node-id="B"><div class="tab-item-content">' + doms.bodyB + "</div></div></div>" : unloaded;
                    corpus.invalidateDocumentSearchCaches(); requestedIds.length = 0;
                    const snapshot = wysiwyg.innerHTML;
                    const regex = queryKind === "regex" || queryKind === "unfiltered-regex";
                    const query = queryKind === "unfiltered-regex" ? (sourceMode ? "[l]" : "[α]") :
                        sourceMode ? (regex ? "\\\\alpha" : "\\alpha") : "α";
                    const options = {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false, regex};
                    const calls = renders;
                    const result = await calculateSearchMatches({}, edit, query, options);
                    const label = JSON.stringify({loaded, sourceMode, queryKind});
                    assert.deepEqual(result.matches.map(hit => hit.blockId), expected, label + " each real formula is counted once");
                    assert.equal(result.partial, false, label);
                    assert.equal(result.unrendered, 0, label);
                    assert.ok(result.matches.every(hit => !hit.replaceable), label + " formulas stay read-only");
                    assert.ok(requestedIds.every(id => !["tabs", "A", "B", "C"].includes(id)), label + " never fetch entire tabs subtrees");
                    assert.equal(wysiwyg.innerHTML, snapshot, label + " never edits loaded content");
                    if (sourceMode) assert.equal(renders, calls, label + " source mode never renders");
                }
            }
            normalizationUnavailable = false;
            wysiwyg.innerHTML = unloaded;
            corpus.invalidateDocumentSearchCaches();
            const options = {searchMathSource: true, includeImageOCR: false, includeAttributeView: false};
            assert.equal((await calculateSearchMatches({}, edit, "\\alpha", {...options, includeTabs: false})).matches.length, 0,
                "unloaded descendants still obey the tabs switch");
            const focused = editors[0].protyle.block;
            focused.id = "A"; focused.showAll = true;
            assert.deepEqual((await calculateSearchMatches({}, edit, "\\alpha", options)).matches.map(hit => hit.blockId), expected.slice(0, 6),
                "tab focus retains its title and body through container ancestry");
            focused.id = "root"; focused.showAll = false;
            assert.equal((await calculateSearchMatches({}, edit, "before", options)).matches.length, 6,
                "excluding source containers retains ordinary title and body text");
            const twice = document.createElement("div"); twice.innerHTML = doms.bodyA;
            twice.firstElementChild.insertAdjacentHTML("beforeend", formula(false));
            doms.bodyA = twice.innerHTML;
            for (const sourceMode of [false, true]) {
                corpus.invalidateDocumentSearchCaches();
                const result = await calculateSearchMatches({}, edit, sourceMode ? "\\alpha" : "α", {...options, searchMathSource: sourceMode});
                assert.equal(result.matches.length, 20, "identical formulas in distinct hosts remain separate");
                assert.equal(result.matches.filter(hit => hit.blockId === "bodyA").length, 4);
            }
            // Image-caption candidates use Markdown and can also include an
            // ancestor whose subtree contains both a caption and formulas.
            db.prepare("UPDATE blocks SET markdown=markdown || ? WHERE id IN ('tabs', 'A', 'bodyA')").run(
                '<span class="protyle-action__title">\\alpha caption</span>');
            try {
                for (const regex of [false, true]) {
                    corpus.invalidateDocumentSearchCaches(); requestedIds.length = 0;
                    const result = await calculateSearchMatches({}, edit, regex ? "\\\\alpha" : "\\alpha", {...options, regex});
                    assert.equal(result.matches.length, 20, "caption candidates never reintroduce container formula copies");
                    assert.ok(requestedIds.every(id => !["tabs", "A", "B", "C"].includes(id)), "all candidate routes skip known containers");
                }
            } finally {
                db.prepare("UPDATE blocks SET markdown=?").run("$\\alpha+\\alpha$");
            }
        } finally {
            Object.assign(doms, savedDoms); responder = kernelResponder; editors = [];
            corpus.invalidateDocumentSearchCaches();
        }
        // A callout owns its title; its descendant blocks are separate SQL
        // candidates. Ancestor DOM must not shadow or duplicate those roots.
        const calloutDoms = {...doms};
        const calloutWrap = body => '<div data-node-id="callout" data-type="NodeCallout" class="callout">' +
            '<div class="callout-title"><div>notice</div></div><div class="callout-content">owned-note' + body + "</div></div>";
        db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run("callout", "root", "root", "callout", "", "notice owned-note α+α", "$\\alpha+\\alpha$", "", "hash", "1");
        db.prepare("UPDATE blocks SET parent_id='callout' WHERE id='tabs'").run();
        orders.unshift("callout");
        try {
            doms.callout = calloutWrap(fixture(false));
            for (const id of Object.keys(doms)) {
                const node = document.createElement("div"); node.innerHTML = doms[id];
                node.querySelectorAll(".tabs-header").forEach(el => el.remove());
                node.querySelectorAll('[data-subtype="math"]').forEach(el => el.replaceChildren());
                node.querySelectorAll("[data-tabs-ready], [data-tabs-hidden]").forEach(el => {
                    el.removeAttribute("data-tabs-ready"); el.removeAttribute("data-tabs-hidden");
                });
                doms[id] = node.innerHTML;
            }
            const outside = '<div data-node-id="outside" data-type="NodeParagraph">outside</div>';
            editors = [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}];
            for (const loaded of ["loaded", "unloaded", "partial"]) for (const sourceMode of [true, false]) for (const regex of [false, true]) {
                wysiwyg.innerHTML = loaded === "loaded" ? calloutWrap(fixture(false)) : loaded === "partial" ? calloutWrap(
                    '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" tabs-active-id="B"><div class="tab-item" data-type="NodeTabItem" data-node-id="B"><div class="tab-item-content">' + doms.bodyB + "</div></div></div>") : outside;
                corpus.invalidateDocumentSearchCaches();
                const snapshot = wysiwyg.innerHTML;
                const options = {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false, regex};
                const result = await calculateSearchMatches({}, edit, sourceMode ? (regex ? "\\\\alpha" : "\\alpha") : "α", options);
                const label = JSON.stringify({loaded, sourceMode, regex});
                assert.deepEqual(result.matches.map(hit => hit.blockId), expected, label + " callout ancestor never adds source copies");
                assert.equal(result.partial, false, label);
                assert.equal(result.unrendered, 0, label);
                assert.ok(result.matches.every(hit => !hit.replaceable), label + " formulas remain read-only");
                assert.equal((await calculateSearchMatches({}, edit, "before", options)).matches.length, 6, label + " ordinary descendant text is retained");
                for (const query of ["notice", "owned-note"]) {
                    assert.deepEqual((await calculateSearchMatches({}, edit, query, options)).matches.map(hit => hit.blockId), ["callout"], label + " callout-owned text is retained");
                }
                assert.equal(wysiwyg.innerHTML, snapshot, label + " note DOM is unchanged");
            }
            // Independent roots must win regardless of request order, including
            // normal text, when a fetched ancestor carries a different snapshot.
            const {extractUnitsFromDoms} = source("frontend/corpus/extract");
            const authoritative = '<div data-node-id="bodyA" data-type="NodeParagraph"><div contenteditable="true">authoritative ' + formula(false) + formula(false) + "</div></div>";
            for (const ids of [["callout", "bodyA"], ["bodyA", "callout"]]) {
                const extracted = await extractUnitsFromDoms(ids, {callout: doms.callout, bodyA: authoritative}, {searchMathSource: true, includeImageOCR: false}, new Set(), "none");
                try {
                    const owned = extracted.blocks.filter(block => block.blockId === "bodyA");
                    assert.equal(owned.filter(block => block.matchSource === "inline-math").length, 2, "equal real formulas remain distinct");
                    assert.equal(owned.filter(block => block.text.includes("authoritative")).length, 1, "ordinary text belongs to the requested root");
                    assert.ok(owned.every(block => block.element.closest('[data-node-id="callout"]') === null));
                    assert.ok(extracted.blocks.some(block => block.blockId === "callout" && block.text === "notice"));
                } finally {extracted.dispose();}
            }
            wysiwyg.innerHTML = outside;
            const titled = document.createElement("div"); titled.innerHTML = doms.callout;
            titled.querySelector(".callout-title").insertAdjacentHTML("beforeend", formula(false));
            doms.callout = titled.innerHTML;
            for (const sourceMode of [false, true]) {
                corpus.invalidateDocumentSearchCaches();
                const result = await calculateSearchMatches({}, edit, sourceMode ? "\\alpha" : "α", {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false});
                assert.equal(result.matches.length, 20, "callout title formulas are not removed with child blocks");
                assert.equal(result.matches.filter(hit => hit.blockId === "callout").length, 2);
            }
            const embeddedDoms = {embed: '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' + doms.callout + doms.callout + "</div>", bodyA: authoritative};
            for (const ids of [["embed", "bodyA"], ["bodyA", "embed"]]) {
                const extracted = await extractUnitsFromDoms(ids, embeddedDoms, {searchMathSource: true, includeImageOCR: false}, new Set(["embed"]), "none");
                try {
                    const count = id => extracted.blocks.filter(block => block.blockId === id).reduce((sum, block) => sum + block.text.split("\\alpha").length - 1, 0);
                    assert.equal(count("embed"), 40, "each embedded callout retains all of its own descendants and formulas");
                    assert.equal(count("bodyA"), 4, "embedded source IDs never shadow the standalone requested root");
                } finally {extracted.dispose();}
            }
            db.prepare("UPDATE blocks SET ial='fold=\"1\"' WHERE id='callout'").run();
            for (const sourceMode of [false, true]) {
                corpus.invalidateDocumentSearchCaches();
                const options = {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false, includeFoldedBlocks: true};
                const query = sourceMode ? "\\alpha" : "α";
                assert.equal((await calculateSearchMatches({}, edit, query, options)).matches.length, 20, "folded unloaded descendants remain searchable on request");
                assert.equal((await calculateSearchMatches({}, edit, query, {...options, includeCallout: false})).matches.length, 0, "callout switch excludes its complete subtree");
                assert.equal((await calculateSearchMatches({}, edit, query, {...options, includeTabs: false})).matches.length, 2, "tabs switch retains only the callout's own formula");
            }
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        } finally {
            delete doms.callout; Object.assign(doms, calloutDoms); orders.shift();
            db.prepare("DELETE FROM blocks WHERE id='callout'").run();
            db.prepare("UPDATE blocks SET parent_id='root' WHERE id='tabs'").run();
            editors = []; corpus.invalidateDocumentSearchCaches();
        }
        const selectionApi = source("frontend/selection");
        const scopedOptions = {includeImageOCR: false, includeAttributeView: false, selectionOnly: true};
        editors = [];
        wysiwyg.innerHTML = fixture(false);
        const selectedGlyph = wysiwyg.querySelector('[data-node-id="bodyB"] .katex-html').firstChild;
        const partialRange = document.createRange(); partialRange.setStart(selectedGlyph, 0); partialRange.setEnd(selectedGlyph, 1);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(partialRange);
        const partialScope = getSelectionScope(edit, collectSearchableBlocks(edit, scopedOptions));
        // Formula host selection normally covers the whole formula. Also exercise
        // the pipeline's stricter contract for callers with frozen text offsets.
        for (const key of partialScope.keys()) partialScope.set(key, [{start: 0, end: 1}]);
        window.getSelection().removeAllRanges();
        const callsBeforeSelection = renders;
        assert.equal((await calculateSearchMatches({}, edit, "α", {...scopedOptions, selectionScope: partialScope})).matches.length, 1,
            "a frozen partial formula selection excludes unrelated pending formulas");
        assert.equal(renders, callsBeforeSelection, "partial formula search does not prepare other tabs");

        // Preparing a selected earlier formula must not move a partial selection
        // onto its sibling, even when the formulas have exactly the same text.
        const bodyA = wysiwyg.querySelector('[data-node-id="bodyA"]');
        let remappedScope;
        const mixed = await calculateSearchMatches({}, edit, "α", {...scopedOptions, selectionScope: partialScope,
            selectionHosts: [bodyA], onSelectionScopeRemapped: scope => {remappedScope = scope;}});
        assert.deepEqual(mixed.matches.map(hit => hit.blockId), ["bodyA", "bodyA", "bodyB"]);
        assert.equal((await calculateSearchMatches({}, edit, "α", {...scopedOptions, selectionScope: remappedScope})).matches.length, 3,
            "remapped scope keeps exact offsets on the next search");

        wysiwyg.innerHTML = '<div data-type="NodeParagraph" data-node-id="selected" class="protyle-wysiwyg--select">needle</div>' + fixture(false);
        const plainScope = getSelectionScope(edit, collectSearchableBlocks(edit, scopedOptions));
        const callsBeforePlain = renders;
        assert.equal((await calculateSearchMatches({}, edit, "needle", {...scopedOptions, selectionScope: plainScope})).matches.length, 1);
        assert.equal(renders, callsBeforePlain, "plain selected text never prepares unrelated tab formulas");

        wysiwyg.innerHTML = fixture(false);
        for (const id of ["bodyA", "bodyB"]) wysiwyg.querySelector('[data-node-id="' + id + '"]').classList.add("protyle-wysiwyg--select");
        const frozen = getSelectionScope(edit, collectSearchableBlocks(edit, scopedOptions));
        wysiwyg.querySelectorAll(".protyle-wysiwyg--select").forEach(el => el.classList.remove("protyle-wysiwyg--select"));
        const owner = {edit, plugin: {}, selectionOnly: true, destroyed: false, rememberedSelectionScope: frozen,
            selectionScopeVisualKind: "block", rememberedVisualBlockIds: ["bodyA", "bodyB"], rememberedTableCellRefs: [],
            resolveScopeForSearch: () => selectionApi.cloneSelectionScope(frozen), searchOptions: () => scopedOptions,
            diagramSearchState: {capture() {}}, embedSearchState: {capture() {}}};
        const selectedSnapshot = wysiwyg.innerHTML;
        for (let attempt = 0; attempt < 2; attempt++) {
            const selected = await SearchBar.prototype.runSearchPipeline.call(owner, "α", new AbortController().signal);
            assert.deepEqual(selected.matches.map(hit => hit.blockId), ["bodyA", "bodyA", "bodyB", "bodyB"], "whole-block frozen scope survives repeated searches");
            assert.equal(owner.rememberedSelectionScope, frozen, "in-flight search scope identity is preserved");
        }
        assert.equal(wysiwyg.innerHTML, selectedSnapshot, "selection preparation never edits the note");

        wysiwyg.innerHTML = fixture(false);
        wysiwyg.querySelector('[data-node-id="bodyA"]').innerHTML = formula(false);
        frozen.clear(); owner.rememberedVisualBlockIds = ["bodyA"];
        assert.equal((await SearchBar.prototype.runSearchPipeline.call(owner, "α", new AbortController().signal)).matches.length, 2,
            "a frozen whole block containing only unrendered math is searchable");
        wysiwyg.innerHTML = fixture(false);
        wysiwyg.querySelector('[data-node-id="bodyA"]').innerHTML = '<div data-type="NodeTable" data-node-id="selectedTable"><table><tbody><tr><td>' +
            formula(false) + "</td><td>" + formula(false) + "</td></tr></tbody></table></div>";
        frozen.clear(); owner.selectionScopeVisualKind = "table-cells";
        owner.rememberedTableCellRefs = [{tableBlockId: "selectedTable", rowIndex: 0, columnIndex: 0}];
        const cellSnapshot = wysiwyg.innerHTML;
        for (let attempt = 0; attempt < 2; attempt++) {
            const selected = await SearchBar.prototype.runSearchPipeline.call(owner, "α", new AbortController().signal);
            assert.equal(selected.matches.length, 2, "frozen whole-cell selection never expands to the adjacent cell");
        }
        assert.equal(wysiwyg.innerHTML, cellSnapshot);

        wysiwyg.innerHTML = fixture(false);
        const cancelledScope = new Map();
        const abortSelection = new AbortController();
        let scopeCallbacks = 0;
        const selectionRenderer = renderers.mathRender;
        renderers.mathRender = root => {selectionRenderer(root); abortSelection.abort();};
        try {
            const cancelled = await calculateSearchMatches({}, edit, "α", {...scopedOptions, selectionScope: cancelledScope,
                selectionHosts: [wysiwyg.querySelector('[data-node-id="bodyA"]')], signal: abortSelection.signal,
                onSelectionScopeRemapped: () => {scopeCallbacks++;}});
            assert.equal(cancelled.cancelled, true);
            assert.equal(scopeCallbacks, 0, "cancelled preparation never updates the owner's scope");
            assert.equal(cancelledScope.size, 0);
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        } finally {renderers.mathRender = selectionRenderer;}

        const normalRenderer = renderers.mathRender;
        try {
            for (const hidden of ['style="display:none"', 'class="fn__none"', 'style="visibility:hidden"']) {
                const output = '<span class="katex-html" aria-hidden="true"><span ' + hidden + ">hidden</span>visible</span>";
                renderers.mathRender = root => root.querySelectorAll('[data-subtype="math"]').forEach(el => {
                    el.innerHTML = output; el.setAttribute("data-render", "true");
                });
                for (const block of [false, true]) {
                    wysiwyg.innerHTML = fixture(false);
                    const targetId = block ? "mathA" : "bodyA";
                    const target = wysiwyg.querySelector('[data-node-id="' + targetId + '"]' + (block ? "" : ' [data-type="inline-math"]'));
                    for (const warm of [false, true]) {
                        if (warm) target.innerHTML = output;
                        const opts = {includeImageOCR: false, includeAttributeView: false};
                        const hiddenHits = await calculateSearchMatches({}, edit, "hidden", opts);
                        assert.equal(hiddenHits.matches.filter(hit => hit.blockId === targetId).length, 0, "cold/live hidden glyph parity: " + hidden);
                        const visibleHits = await calculateSearchMatches({}, edit, "visible", opts);
                        assert.equal(visibleHits.matches.filter(hit => hit.blockId === targetId).length, 1, "visible formula text is retained");
                    }
                }
            }
            renderers.mathRender = root => root.querySelectorAll('[data-subtype="math"]').forEach(el => {
                el.setAttribute("data-render", "true");
                if (el.getAttribute("data-content") === "needle") el.innerHTML = '<span class="katex-html">needle</span>';
                else if (el.tagName === "DIV") el.innerHTML = '<div class="ft__error">invalid TeX</div>';
                else {el.textContent = "invalid TeX"; el.classList.add("ft__error");}
            });
            wysiwyg.innerHTML = '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" tabs-active-id="other">' +
                '<div class="tab-item" data-type="NodeTabItem" data-node-id="other"></div>' +
                '<div class="tab-item" data-type="NodeTabItem" data-node-id="cold" data-tabs-hidden="true">' +
                Array.from({length: 65}, (_, i) => '<div data-type="NodeParagraph" data-node-id="p' + i + '">ordinary ' +
                    formula(false, i < 64 && i % 2 === 0).replace("\\alpha+\\alpha", i < 64 ? "\\notARealCommand" : "needle") + "</div>").join("") + "</div></div>";
            const errorFixture = wysiwyg.innerHTML;
            for (const full of [false, true]) {
                wysiwyg.innerHTML = errorFixture;
                if (full) {
                    for (const id of ["other", "cold", ...Array.from({length: 65}, (_, i) => "p" + i)]) {
                        const el = wysiwyg.querySelector('[data-node-id="' + id + '"]');
                        orders.push(id); doms[id] = el.outerHTML;
                        db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "root", id.startsWith("p") ? "cold" : "tabs", id.startsWith("p") ? "p" : "tab",
                            "", id === "p64" ? "needle" : "notARealCommand", id === "p64" ? "$needle$" : "$\\notARealCommand$", "", "hash", "1");
                    }
                }
                editors = full ? [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}] : [];
                corpus.invalidateDocumentSearchCaches();
                try {
                    const result = await calculateSearchMatches({}, edit, "needle", {includeImageOCR: false, includeAttributeView: false});
                    assert.equal(result.matches.filter(hit => hit.blockId === "p64").length, 1, "syntax errors in the first batch never hide a later valid formula");
                } finally {
                    if (full) for (const id of ["other", "cold", ...Array.from({length: 65}, (_, i) => "p" + i)]) {
                        orders.splice(orders.indexOf(id), 1); delete doms[id]; db.prepare("DELETE FROM blocks WHERE id=?").run(id);
                    }
                }
            }
        } finally {renderers.mathRender = normalRenderer; editors = [];}
        for (const full of [false, true]) for (const rendered of [true, false]) for (const sourceMode of [false, true]) {
            wysiwyg.innerHTML = fixture(rendered);
            editors = full ? [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}] : [];
            corpus.invalidateDocumentSearchCaches();
            const snapshot = wysiwyg.innerHTML;
            const calls = renders;
            const options = {searchMathSource: sourceMode, includeAttributeView: false, includeImageOCR: false};
            const query = sourceMode ? "\\alpha" : "α";
            const result = await calculateSearchMatches({}, edit, query, options);
            const label = JSON.stringify({full, rendered, sourceMode});
            if (full) {assert.equal(result.partial, false, label); assert.equal(result.unrendered, 0, label);}
            assert.deepEqual(result.matches.map(hit => hit.blockId), expected, label + " formula count/order");
            assert.ok(result.matches.every(hit => !hit.replaceable), label + " read-only formulas");
            if (sourceMode) {
                assert.equal(renders, calls, "source searches never render formulas");
                assert.equal((await calculateSearchMatches({}, edit, "α", options)).matches.length, 0, "no glyph duplicates in source mode");
            }
            const mixed = await calculateSearchMatches({}, edit, sourceMode ? "before|after|\\\\alpha" : "before|after|α", {...options, regex: true});
            assert.deepEqual(mixed.matches.map(hit => hit.blockId), ["A", "B", "C"].flatMap(id =>
                ["title" + id, "body" + id].flatMap(id => [id, id, id, id]).concat(["math" + id, "math" + id])), label + " body/formulas interleave");
            assert.equal(wysiwyg.innerHTML, snapshot, "search never changes source or navigation clones");
            const warmRenders = renders;
            await calculateSearchMatches({}, edit, query, options);
            assert.equal(renders, warmRenders, "unchanged formulas reuse text snapshots");
            for (const hit of result.matches.filter(hit => hit.blockId.startsWith("title"))) {
                assert.ok(hit.range, "title formula has a visible label range");
                assert.equal(SearchBar.prototype.rangeStillInMatchBlock.call({edit}, hit.range, hit), true);
            }
            assert.equal((await calculateSearchMatches({}, edit, query, {...options, includeTabs: false})).matches.length, 0);
            const nested = '<div class="tabs" data-type="NodeTabs" data-node-id="outer" tabs-active-id="other">' +
                '<div class="tab-item" data-node-id="other" data-type="NodeTabItem"></div>' +
                '<div class="tab-item" data-node-id="nested" data-type="NodeTabItem" data-tabs-hidden="true">' + snapshot + "</div></div>";
            if (!full) {
                wysiwyg.innerHTML = nested;
                assert.deepEqual((await calculateSearchMatches({}, edit, query, options)).matches.map(hit => hit.blockId), expected, "nested nonactive title copies counted once");
                wysiwyg.innerHTML = snapshot;
            }
            const reveal = source("frontend/tabs-reveal");
            const firstBody = wysiwyg.querySelector('[data-node-id="bodyA"]');
            reveal.revealHiddenTabs(firstBody);
            assert.deepEqual((await calculateSearchMatches({}, edit, query, options)).matches.map(hit => hit.blockId), expected, "switching panels does not change count/order");
            const switched = await calculateSearchMatches({}, edit, query, options);
            for (const hit of switched.matches.filter(hit => ["bodyA", "mathA"].includes(hit.blockId) && hit.range)) {
                assert.equal(SearchBar.prototype.rangeStillInMatchBlock.call({edit}, hit.range, hit), true, "cold formula anchors stay navigable while native rendering catches up");
            }
            wysiwyg.innerHTML = snapshot;
            wysiwyg.firstElementChild.setAttribute("fold", "1");
            assert.equal((await calculateSearchMatches({}, edit, query, {...options, includeFoldedBlocks: false})).matches.length, 0, "fold switch stays respected");
            assert.deepEqual((await calculateSearchMatches({}, edit, query, {...options, includeFoldedBlocks: true})).matches.map(hit => hit.blockId), expected, "folded tabs included on request");
            wysiwyg.innerHTML = snapshot;
            wysiwyg.firstElementChild.style.display = "none";
            assert.equal((await calculateSearchMatches({}, edit, query, options)).matches.length, 0, "author hidden tabs excluded");
        }
        const coldTitles = (formulaOnly) => {
            wysiwyg.innerHTML = fixture();
            for (const id of ["A", "B", "C"]) {
                const title = wysiwyg.querySelector('[data-node-id="title' + id + '"] .tab-item-title');
                const label = wysiwyg.querySelector('[data-tab-id="' + id + '"] .tabs-tab-label');
                if (formulaOnly) {title.innerHTML = formula(false); label.textContent = "Tab";}
                else for (const host of [title, label]) host.querySelector('[data-type="inline-math"]').replaceChildren();
            }
        };
        for (const full of [false, true]) for (const sourceMode of [false, true]) for (const formulaOnly of [false, true]) {
            editors = full ? [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}] : [];
            coldTitles(formulaOnly);
            corpus.invalidateDocumentSearchCaches();
            const snapshot = wysiwyg.innerHTML;
            const options = {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false};
            const result = await calculateSearchMatches({}, edit, sourceMode ? "\\alpha" : "α", options);
            const label = JSON.stringify({full, sourceMode, formulaOnly});
            assert.deepEqual(result.matches.map(hit => hit.blockId), expected, label + " cold title count/order");
            if (full) {
                assert.equal(result.unrendered, 0, label + " a completed title copy covers its source");
                assert.equal(result.partial, false, label);
                assert.equal(result.degraded, false, label);
            }
            assert.equal(wysiwyg.innerHTML, snapshot, "cold title rendering never mutates the note");
            if (formulaOnly) assert.equal((await calculateSearchMatches({}, edit, "Tab", options)).matches.length, 0, "native fallback labels never add artificial hits");
            for (const hit of result.matches.filter(hit => hit.blockId.startsWith("title"))) {
                assert.ok(hit.range, label + " cold title has a navigation anchor");
                assert.equal(SearchBar.prototype.rangeStillInMatchBlock.call({edit}, hit.range, hit), true, label);
                assert.equal(hit.replaceable, false, "source titles stay read-only");
                if (formulaOnly && sourceMode) assert.equal(visual.mathSourceFrameHost(hit.range)?.className, "tabs-tab-label");
            }
        }
        editors = [];
        for (const sourceMode of [false, true]) {
            const options = {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false};
            const query = sourceMode ? "\\alpha" : "α";
            wysiwyg.innerHTML = fixture();
            const result = await calculateSearchMatches({}, edit, query, options);
            const hits = result.matches.filter(hit => hit.blockId.startsWith("title"));
            const oldHeader = wysiwyg.querySelector(".tabs-header");
            oldHeader.replaceWith(oldHeader.cloneNode(true));
            for (const hit of hits) {
                const owner = wysiwyg.querySelector('[data-node-id="' + hit.blockId + '"]');
                const scoped = collectSearchableBlocks(edit, {...options, scopeRoots: [owner], skipEmbeddedOrder: true});
                assert.deepEqual(scoped.filter(unit => unit.matchSource === "inline-math").map(unit => unit.blockId), [hit.blockId], "scoped repair collects only the associated title formula");
                const rebound = project.fillLiveRanges([{...hit, range: undefined}], scoped, false)[0];
                assert.ok(rebound.range, "header rebuild preserves formula identity in scoped repair");
                assert.equal(SearchBar.prototype.rangeStillInMatchBlock.call({edit}, rebound.range, rebound), true);
                assert.ok(!oldHeader.contains(rebound.range.startContainer), "repaired range belongs to the new header");
            }
            wysiwyg.innerHTML = '<div data-type="NodeBlockQueryEmbed" data-node-id="embed">' + fixture() + fixture() + "</div>";
            const embedded = await calculateSearchMatches({}, edit, query, options);
            assert.deepEqual(embedded.matches.map(hit => hit.unitId.split(":")[1]), [...expected, ...expected.map(id => id + "@1")], "repeated embedded titles retain instance identity and interleaved order");
            assert.ok(embedded.matches.every(hit => !hit.replaceable), "embedded copies remain read-only");
            const plain = await calculateSearchMatches({}, edit, "before", options);
            assert.equal(plain.matches.length, 12, "plain title clones survive repeated source IDs in an embed");
            const mixed = await calculateSearchMatches({}, edit, sourceMode ? "before|after|\\\\alpha" : "before|after|α", {...options, regex: true});
            const oneCopy = ["A", "B", "C"].flatMap(id =>
                ["title" + id, "body" + id].flatMap(id => [id, id, id, id]).concat(["math" + id, "math" + id]));
            assert.deepEqual(mixed.matches.map(hit => hit.unitId.split(":")[1]), [...oneCopy, ...oneCopy.map(id => id + "@1")], "embedded body/formula offsets stay interleaved");
        }
        db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run("embed", "root", "root", "query_embed", "", "", "", "", "hash", "1");
        orders.push("embed");
        editors = [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}];
        try {
            for (const sourceMode of [false, true]) for (const titleState of ["warm", "cold", "fallback"]) {
                if (titleState === "warm") wysiwyg.innerHTML = fixture();
                else coldTitles(titleState === "fallback");
                const copy = wysiwyg.innerHTML;
                wysiwyg.innerHTML = '<div data-type="NodeBlockQueryEmbed" data-node-id="embed">' + copy + copy + "</div>";
                doms.embed = wysiwyg.innerHTML;
                corpus.invalidateDocumentSearchCaches();
                const result = await calculateSearchMatches({}, edit, sourceMode ? "\\alpha" : "α", {searchMathSource: sourceMode, includeImageOCR: false, includeAttributeView: false});
                const embedded = result.matches.filter(hit => hit.blockId === "embed");
                assert.deepEqual(embedded.map(hit => hit.unitId.split(":")[1]), [...expected, ...expected.map(id => id + "@1")], JSON.stringify({sourceMode, titleState}) + " full corpus embeds keep logical order through recovery/cache");
                assert.equal(result.unrendered, 0, "completed title previews do not trigger failed embed recovery");
            }
        } finally {
            orders.pop(); delete doms.embed;
            db.prepare("DELETE FROM blocks WHERE id=?").run("embed");
        }
        editors = [{protyle: {element: edit, notebookId: "", block: {id: "root", rootID: "root"}}}];
        coldTitles(false);
        const rendererBeforeFailure = renderers.mathRender;
        renderers.mathRender = () => {};
        try {
            corpus.invalidateDocumentSearchCaches();
            const failed = await calculateSearchMatches({}, edit, "α", {includeImageOCR: false, includeAttributeView: false});
            assert.ok(failed.unrendered > 0, "a genuinely failed title renderer still reports incomplete coverage");
        } finally {renderers.mathRender = rendererBeforeFailure;}
        editors = [];
        coldTitles(true);
        const sourceTitle = wysiwyg.querySelector('[data-node-id="titleB"] [data-type="inline-math"]');
        sourceTitle.style.display = "none";
        for (const sourceMode of [false, true]) {
            const result = await calculateSearchMatches({}, edit, sourceMode ? "\\alpha" : "α", {searchMathSource: sourceMode, includeImageOCR: false});
            assert.equal(result.matches.filter(hit => hit.blockId === "titleB").length, 0, "author-hidden source formula is never revived");
        }
        coldTitles(true);
        assert.equal((await calculateSearchMatches({}, edit, "\\alpha", {searchMathSource: true, includeParagraph: false, includeImageOCR: false})).matches.length, 6, "source title fallback obeys the paragraph switch");
        const {prepareTabsMath} = source("frontend/tabs-math");
        const previews = source("frontend/math-preview-cache");
        wysiwyg.innerHTML = fixture(false);
        let calls = renders;
        await prepareTabsMath(edit, {includeParagraph: false, includeMathBlock: false}, () => true);
        assert.equal(renders, calls, "excluded math never loads KaTeX");
        await prepareTabsMath(edit, {}, () => false);
        assert.equal(renders, calls, "cancelled preparation never renders");
        await prepareTabsMath(edit, {}, () => true);
        const cold = wysiwyg.querySelector('[data-node-id="bodyA"] span[data-type="inline-math"]');
        assert.equal(previews.renderedMathPreviewText(cold), "α+α");
        cold.setAttribute("data-content", "x");
        assert.equal(previews.renderedMathPreviewText(cold), undefined, "changed formula never reuses stale glyph text");
        await prepareTabsMath(edit, {}, () => true);
        assert.equal(previews.renderedMathPreviewText(cold), "α+α");
        const state = window.siyuan;
        try {
            window.siyuan = {config: {editor: {katexMacros: '{"\\\\test":"x"}'}}};
            assert.equal(previews.renderedMathPreviewText(cold), undefined, "macro changes invalidate preview text");
        } finally {window.siyuan = state;}

        wysiwyg.innerHTML = '<div class="tabs" data-type="NodeTabs"><div class="tab-item" data-type="NodeTabItem" data-node-id="many">' +
            Array.from({length: 140}, (_, i) => '<div data-type="NodeParagraph" data-node-id="p' + i + '">' + formula(false) + "</div>").join("") + "</div></div>";
        let cancelled = false;
        let largestBatch = 0;
        const renderer = renderers.mathRender;
        renderers.mathRender = root => {
            largestBatch = Math.max(largestBatch, root.querySelectorAll('[data-subtype="math"]').length);
            renderer(root); cancelled = true;
        };
        calls = renders;
        try {await prepareTabsMath(edit, {}, () => !cancelled);} finally {renderers.mathRender = renderer;}
        assert.equal(renders, calls + 1, "cancellation stops later batches");
        assert.ok(largestBatch <= 64, "bounded clone/render batch");
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0, "cancelled copies are removed");
    } finally {db.close(); editors = []; style.remove();}
    console.log("tabs math regressions passed");
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(setup + "\n" + main.toString() + "\nmain().catch(error => { console.error(error); process.exitCode = 1; });", __filename);
