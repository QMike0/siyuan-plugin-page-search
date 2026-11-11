/* eslint-disable no-undef -- main runs inside the shared isolated harness. */
// Native title fragment + isolated viewport/selection contracts; no notebook writes.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const harness = fs.readFileSync(path.join(__dirname, "run-code-language-regressions.cjs"), "utf8");
const setup = harness.slice(0, harness.indexOf("async function main()"));
async function main() {
    const selection = source("frontend/selection");
    const wrapper = document.createElement("div");
    wrapper.className = "layout-tab-container";
    document.body.append(wrapper);
    wrapper.append(edit);
    const top = document.createElement("div");
    top.className = "protyle-top";
    content.prepend(top);
    const mount = html => {
        top.innerHTML = '<div class="protyle-title"><div class="protyle protyle-title__rich" data-protyle-lite="true">' +
            '<div class="protyle-content"><div class="protyle-wysiwyg"><div data-type="NodeParagraph" data-node-id="title-temporary">' +
            '<div class="protyle-title__input" contenteditable="true">' + html + "</div></div></div></div></div></div>";
        return top.querySelector(".protyle-title__input");
    };
    const formula = '<span data-type="inline-math" data-subtype="math" data-content="\\alpha+\\alpha">' +
        '<span class="katex"><span class="katex-html">α+α</span></span></span>';
    const nativeImage = document.createElement("div");
    nativeImage.innerHTML = lute.Md2BlockDOM("![picture](assets/title-navigation.png)\n");
    const image = nativeImage.querySelector("[contenteditable]").innerHTML;
    const html = "needle " + formula +
        ' <span data-type="inline-memo" data-inline-memo-content="memo needle">note</span> ' + image;
    wysiwyg.innerHTML = lute.Md2BlockDOM("body needle\n");
    responder = async url => url === "/api/asset/getImageOCRText" ?
        {code: 0, data: {text: "ocr needle"}} : {code: -1};
    const search = (query, options = {}) => calculateSearchMatches({}, wrapper, query, {includeAttributeView: false, ...options});
    Object.defineProperties(content, {
        clientHeight: {value: 400}, scrollHeight: {value: 4000},
        clientWidth: {value: 600}, scrollWidth: {value: 600},
    });
    content.style.overflowY = "auto";
    content.getBoundingClientRect = () => rect(0, 0, 600, 400);
    window.Range.prototype.getBoundingClientRect = () => rect(30, 30 - content.scrollTop, 80, 20);
    CSS.highlights = new Map();
    window.Highlight = class extends Set {};
    for (const sourceMode of [false, true]) {
        const title = mount(html);
        const options = {includeDocTitle: true, includeInlineMemo: true, searchMathSource: sourceMode};
        const found = await search(sourceMode ? "needle|alpha" : "needle|α", {...options, regex: true});
        const live = collectSearchableBlocks(wrapper, options);
        const titleUnits = live.filter(unit => unit.blockId === "__doc-title__");
        for (const unit of titleUnits) unit.element.getBoundingClientRect = () => rect(20, 30 - content.scrollTop, 500, 40);
        const snapshot = edit.innerHTML;
        const calls = apiCalls;
        const bodyQuery = wysiwyg.querySelectorAll;
        wysiwyg.querySelectorAll = () => { throw new Error("title navigation must not recollect body blocks"); };
        const bar = Object.create(SearchBar.prototype);
        Object.assign(bar, {
            edit: wrapper, includeDocTitle: true, includeInlineMemo: true, searchMathSource: sourceMode,
            includeFoldedBlocks: false, searchGeneration: 1, domEpoch: 0,
            searchCollectOptions: () => options, pauseAvWatch() {}, syncMemoUnderlineVisual() {}, syncReplaceButtons() {},
            revealMatchTabs() {}, unfoldAttributeViewGroup: () => false, attributeViewRangeNeedsReveal: () => false,
        });
        for (const [index, hit] of found.matches.entries()) {
            if (hit.blockId !== "__doc-title__") continue;
            content.scrollTop = 1200;
            bar.resultMatches = project.projectRanges(wrapper, found.matches, options, live);
            bar.resultIndex = index + 1;
            assert.equal(bar.resultMatches[index].range, undefined, "offscreen title keeps viewport projection enabled");
            await bar.scrollIntoRangesAsync(index, true);
            const current = bar.resultMatches[index];
            assert.ok(current.range, `${hit.highlightKind} title target binds on demand`);
            assert.equal(content.scrollTop, 0, "navigation scrolls the main document back to the title");
            assert.equal(title.closest(".protyle-content").scrollTop, 0, "inner title editor is not the scroll target");
            assert.equal(current.id, hit.id);
            assert.equal(current.replaceable, false);
            if (hit.highlightKind === "math-source") assert.ok(visual.mathSourceFrameHost(current.range));
            else if (hit.highlightKind === "image-ocr") assert.equal(visual.imageOCRFrameHost(current.range), title.querySelector("img"));
            else if (hit.highlightKind === "inline-memo") assert.ok(current.range.startContainer.matches('[data-type~="inline-memo"]'));
            else {
                assert.equal(current.range.toString(), hit.matchedText);
                assert.ok(CSS.highlights.get(bar.componentHighlights.focusName).has(current.range), "rebound text is orange");
            }
            assert.equal(bar.resultMatches.filter(match => match.blockId === "__doc-title__" && match.range).length, 1,
                "only the target gets a Range before viewport painting catches up");
            assert.equal(bar.resultMatches.length, found.matches.length);
            assert.equal(edit.innerHTML, snapshot, "navigation never edits title or body content");
        }
        content.scrollTop = 1200;
        bar.resultMatches = project.projectRanges(wrapper, found.matches, options, live);
        bar.resultIndex = 1;
        await bar.scrollIntoRangesAsync(0, false);
        assert.equal(bar.resultMatches[0].range, undefined, "background refresh does not reveal offscreen titles");
        bar.includeDocTitle = false;
        await bar.scrollIntoRangesAsync(0, true);
        assert.equal(content.scrollTop, 1200, "disabled title search prevents deferred navigation");
        bar.includeDocTitle = true;
        bar.destroyed = true;
        await bar.scrollIntoRangesAsync(0, true);
        assert.equal(content.scrollTop, 1200, "a closed panel cannot reveal a title");
        bar.destroyed = false;
        mount("edited " + formula);
        await bar.scrollIntoRangesAsync(0, true);
        assert.equal(content.scrollTop, 1200, "changed target text cannot borrow the old match offset");
        assert.equal(apiCalls, calls, "navigation does not read OCR/title APIs or submit transactions");
        assert.equal(title.innerHTML, new window.DOMParser().parseFromString(snapshot, "text/html").querySelector(".protyle-title__input").innerHTML);
        wysiwyg.querySelectorAll = bodyQuery;
        bar.componentHighlights?.dispose();
    }

    // Frozen title text remains selected when a type gate hides it during a mode switch.
    const title = mount("needle " + formula + " needle");
    const selected = document.createRange();
    selected.selectNodeContents(title);
    window.getSelection().addRange(selected);
    const all = collectSearchableBlocks(wrapper);
    const scope = getSelectionScope(wrapper, all);
    window.getSelection().removeAllRanges();
    const bodyScope = selection.selectionScopeFromHosts(all, [wysiwyg.firstElementChild]);
    for (const [key, ranges] of bodyScope) scope.set(key, ranges);
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {
        edit: wrapper, selectionOnly: true, includeDocTitle: true, searchMathSource: false,
        restrictInlineTypes: ["inline-math"], rememberedSelectionScope: scope,
        resolveScopeForSearch() { return this.rememberedSelectionScope; },
        searchOptions() { return {includeDocTitle: this.includeDocTitle, searchMathSource: this.searchMathSource,
            restrictInlineTypes: this.restrictInlineTypes}; },
        setOpenMenuSwitch() {}, highlightHitResult: async () => {},
    });
    const snapshot = title.innerHTML;
    const calls = apiCalls;
    for (const mode of [true, false]) {
        bar.restrictInlineTypes = ["inline-math"];
        bar.applySearchMathSource(mode);
        assert.equal((await search("needle", {...bar.searchOptions(), selectionOnly: true,
            selectionScope: bar.rememberedSelectionScope})).matches.length, 0, "preservation does not bypass the type gate");
        bar.restrictInlineTypes = [];
        const found = await search("needle", {...bar.searchOptions(), selectionOnly: true,
            selectionScope: bar.rememberedSelectionScope});
        assert.equal(found.matches.filter(hit => hit.blockId === "__doc-title__").length, 2,
            "clearing the type restriction restores both selected title text runs");
        assert.equal(found.matches.filter(hit => hit.blockId !== "__doc-title__").length, 1,
            "ordinary body selection keeps its existing behavior");
    }
    const titleText = all.find(unit => unit.blockId === "__doc-title__" && unit.text.startsWith("needle"));
    const partial = new Map([[unitKey(titleText.blockId, titleText.unitId), [{start: 0, end: 3}]]]);
    for (const mode of [true, false]) {
        const before = collectSearchableBlocks(wrapper, {restrictInlineTypes: ["inline-math"], searchMathSource: !mode});
        const after = collectSearchableBlocks(wrapper, {restrictInlineTypes: ["inline-math"], searchMathSource: mode});
        const bodyQuery = wysiwyg.querySelectorAll;
        wysiwyg.querySelectorAll = () => { throw new Error("title scope verification must not recollect body blocks"); };
        const remapped = selection.remapMathSelectionScope(before, after, partial, {edit: wrapper});
        wysiwyg.querySelectorAll = bodyQuery;
        assert.deepEqual([...remapped], [...partial], "partial offsets stay exact and are cloned");
        assert.notEqual(remapped.get([...partial.keys()][0])[0], [...partial.values()][0][0]);
        assert.equal((await search("needle", {selectionOnly: true, selectionScope: remapped})).matches.length, 0);
        assert.equal((await search("nee", {selectionOnly: true, selectionScope: remapped})).matches.length, 1,
            "another identical title word remains outside the original selection");
    }
    bar.rememberedSelectionScope = scope;
    bar.includeDocTitle = false;
    bar.applySearchMathSource(true);
    assert.equal((await search("needle", {...bar.searchOptions(), selectionOnly: true,
        selectionScope: bar.rememberedSelectionScope})).matches.filter(hit => hit.blockId === "__doc-title__").length, 0);
    bar.includeDocTitle = true;
    assert.equal((await search("needle", {...bar.searchOptions(), selectionOnly: true,
        selectionScope: bar.rememberedSelectionScope})).matches.filter(hit => hit.blockId === "__doc-title__").length, 2);
    const invalid = new Map([
        ["__doc-title__::doc-title#run-999", [{start: 0, end: 1}]],
        [unitKey(titleText.blockId, titleText.unitId), [{start: 0, end: titleText.text.length + 1}]],
        ["other-block::doc-title", [{start: 0, end: 1}]],
    ]);
    assert.equal(selection.remapMathSelectionScope([], [], invalid, {edit: wrapper}).size, 0,
        "missing hosts, invalid bounds and unrelated IDs cannot extend the frozen selection");
    top.firstElementChild.remove();
    assert.equal(selection.remapMathSelectionScope([], [], partial, {edit: wrapper}).size, 0,
        "a removed title cannot restore a frozen text selection");
    assert.equal(apiCalls, calls);
    assert.equal(title.innerHTML, snapshot);
    console.log("Rich title boundaries: offscreen text/math/memo/OCR navigation, gates/stale targets, exact frozen text selection and mode switches OK");
}
const mod = new Module(__filename, module);
mod.filename = __filename;
mod.paths = module.paths;
mod._compile(setup + "\n" + main.toString() + "\nmain().catch(error => { console.error(error); process.exitCode = 1; });", __filename);
