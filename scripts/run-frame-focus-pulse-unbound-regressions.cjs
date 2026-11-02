// Native Lute fixtures and isolated APIs; never opens or edits a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    const options = {...prefs.DEFAULT_PREFS, searchMathSource: true, includeImageOCR: true};
    responder = async url => url === '/api/asset/getImageOCRText' ? {code: 0, data: {text: 'needle needle needle'}} :
        (() => {throw new Error('Unexpected API ' + url);})();
    content.getBoundingClientRect = () => rect(0, 0, 600, 500);
    for (const markdown of ['$needle+needle+needle$', '$$\nneedle+needle+needle\n$$', '```needleneedleneedle\nbody\n```', '![](assets/unbound-pulse.png)']) {
        wysiwyg.innerHTML = lute.Md2BlockDOM(markdown);
        const initial = (await calculateSearchMatches({}, edit, 'needle', options)).matches;
        assert.equal(initial.length, 3);
        const host = visual.frameHighlightHost(initial[0].range);
        const owner = wysiwyg.firstElementChild;
        let top = 1000;
        host.getBoundingClientRect = () => rect(20, top, 180, 30);
        owner.getBoundingClientRect = () => rect(20, top, 180, 30);
        Object.defineProperty(owner, 'clientHeight', {value: 50, configurable: true});
        const projected = project.projectRanges(edit, initial, options, collectSearchableBlocks(edit, options));
        assert.ok(projected.every(hit => !hit.range), 'offscreen projection omits all ranges');
        top = 40; // Native locating mounts/scrolls the target before binding just its first hit.
        const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
        let pending;
        const bar = Object.assign(Object.create(SearchBar.prototype), options, {
            edit, resultMatches: projected, resultIndex: 1, resultCount: 3, searchGeneration: 1,
            memoUnderlineLayoutRaf: 0, highlightPaintGeneration: 0, pendingAddedBlocks: new Set(),
            updateCountLabel() {}, pauseAvWatch() {}, revealMatchTabs() {}, syncReplaceButtons() {},
            clearSearchFocus() {}, applyFocusHighlight() {}, unfoldAttributeViewGroup() {return false;},
            attributeViewRangeNeedsReveal() {return false;}, revealMountedAttributeViewMatch() {return false;},
            appendResultHighlight() {return true;}, applyResultHighlights() {}, bindMindmapPreview() {return false;},
            // First-target binding defers same-block repair. Keep that repair pending here.
            repairHighlightRanges() {return Promise.resolve();},
            scrollIntoRanges(...args) {pending = this.scrollIntoRangesAsync(...args);},
        });
        const pulsing = () => edit.querySelectorAll('.page-search-code-language-frame.is-focus-pulse').length;
        const reset = () => {
            visual.clearCodeLanguageVisual(edit);
            bar.pendingFrameFocusPulse = null;
            bar.resultMatches = projected.map(hit => ({...hit, range: undefined}));
            bar.resultIndex = 1;
            assert.equal(bar.tryBindUnfoldedMatch(1, true), true);
            assert.equal(bar.resultMatches[1].range, undefined);
            bar.syncMemoUnderlineVisual();
            assert.ok(edit.querySelector('.page-search-code-language-frame.is-focus'));
            assert.equal(pulsing(), 0);
        };
        try {
            for (const navigate of [() => bar.clickNext(), () => bar.clickLast(), () => bar.clickResultsItem(1)]) {
                reset(); navigate(); await pending; await Promise.resolve();
                const current = bar.getCurrentMatch();
                assert.ok(current.range, 'next/previous/list bind the target through the real unloaded-match path');
                assert.equal(visual.frameHighlightHost(current.range), host);
                assert.equal(pulsing(), 1, initial[0].highlightKind + ' flashes after its target receives a range');
                bar.syncMemoUnderlineVisual();
                assert.equal(bar.pendingFrameFocusPulse, null, 'navigation feedback is consumed only once');
            }

            // Keep locating pending, as native loading/virtualization does, then draw its repaired range.
            bar.scrollIntoRanges = () => {};
            reset(); bar.clickNext(); bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'no feedback before target binding');
            assert.ok(bar.pendingFrameFocusPulse, 'intermediate redraw preserves intent');
            bar.resultMatches[1].range = initial[1].range;
            bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 1, 'delayed repair draws navigation feedback');

            reset(); bar.clickNext();
            bar.resultMatches[1].range = initial[1].range;
            top = 1000; bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'clipped targets have no frame yet');
            assert.ok(bar.pendingFrameFocusPulse, 'clipping does not consume feedback');
            top = 40; bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 1, 'existing scroll redraw consumes feedback when visible');

            reset(); bar.clickNext(); bar.syncMemoUnderlineVisual(); bar.clickNext();
            bar.resultMatches[1].range = initial[1].range;
            bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'late binding of a superseded target cannot flash');
            bar.resultMatches[2].range = initial[2].range;
            bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 1, 'rapid navigation retains only the final target even through a range-less redraw');

            reset(); bar.clickNext(); bar.searchGeneration++;
            bar.resultMatches[1].range = initial[1].range; bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'new query invalidates old feedback');
            assert.equal(bar.pendingFrameFocusPulse, null);

            reset(); bar.clickNext(); bar.clickResultsItem(1);
            bar.resultMatches[1].range = initial[1].range; bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'reselecting the current hit cancels pending feedback');
            assert.equal(bar.pendingFrameFocusPulse, null);

            reset(); bar.clickNext(); bar.clearHighlight();
            bar.resultMatches[1].range = initial[1].range; bar.syncMemoUnderlineVisual();
            assert.equal(pulsing(), 0, 'closing/clearing cannot revive pending feedback');
            assert.equal(bar.pendingFrameFocusPulse, null);

            // Exercise the native-locate completion path, which deliberately passes a false pulse flag.
            reset(); bar.clickNext();
            bar.waitForLocatedMatchRange = async () => {bar.resultMatches[1].range = initial[1].range; return true;};
            bar.bindUnfoldedHeadingSection = () => {};
            await bar.finishLocatedMatch(2, true);
            assert.equal(pulsing(), 1, 'native-locate completion consumes feedback without threading a flag through loading');

            assert.equal(wysiwyg.innerHTML, snapshot, 'feedback never changes note content');
            assert.equal(apiCalls, calls, 'feedback issues no extra requests');
            reset(); bar.clickNext();
            const parent = host.parentNode; const after = host.nextSibling;
            host.remove();
            try {
                bar.syncMemoUnderlineVisual();
                assert.equal(bar.pendingFrameFocusPulse, null, 'detaching the original host cancels feedback');
                assert.equal(pulsing(), 0);
            } finally {parent.insertBefore(host, after);}
        } finally {bar.teardownMemoUnderlineLayoutSync(); visual.clearCodeLanguageVisual(edit);}
    }

    // Distinct formulas/images may share the same paragraph, and images may even share a URL.
    // Compare actual hosts after binding; a shared block/unit category is insufficient.
    for (const markdown of ['$needle+needle$ $needle+needle$', '$$\nneedle+needle\n$$\n\n$$\nneedle+needle\n$$',
        '```needleneedle\nbody\n```\n\n```needleneedle\nother\n```', '![](assets/same-pulse.png) ![](assets/same-pulse.png)']) {
        wysiwyg.innerHTML = lute.Md2BlockDOM(markdown);
        const hits = (await calculateSearchMatches({}, edit, 'needle', options)).matches;
        const first = hits[0];
        const firstHost = visual.frameHighlightHost(first.range);
        const other = hits.find(hit => visual.frameHighlightHost(hit.range) !== firstHost);
        assert.ok(other);
        firstHost.getBoundingClientRect = () => rect(20, 40, 180, 30);
        visual.frameHighlightHost(other.range).getBoundingClientRect = () => rect(20, 100, 180, 30);
        if (first.highlightKind === 'image-ocr' || firstHost.tagName === 'SPAN') {
            assert.equal(first.blockId, other.blockId, 'different hosts actually share their content block');
        }
        const bar = Object.assign(Object.create(SearchBar.prototype), options, {
            edit, resultMatches: [first, {...other, range: undefined}], resultIndex: 1, resultCount: 2,
            searchGeneration: 1, memoUnderlineLayoutRaf: 0, updateCountLabel() {}, scrollIntoRanges() {},
        });
        try {
            bar.syncMemoUnderlineVisual(); bar.clickNext(); bar.syncMemoUnderlineVisual();
            assert.ok(bar.pendingFrameFocusPulse);
            bar.resultMatches[1].range = other.range; bar.syncMemoUnderlineVisual();
            assert.equal(bar.pendingFrameFocusPulse, null);
            assert.equal(edit.querySelectorAll('.page-search-code-language-frame.is-focus-pulse').length, 0,
                'binding a different host never inherits feedback');
        } finally {bar.teardownMemoUnderlineLayoutSync(); visual.clearCodeLanguageVisual(edit);}
    }
    console.log('Deferred frame feedback: native formula/code/OCR projection, first-target binding, next/previous/list, delayed/native locating, clipping, rapid navigation, cancellation, cleanup and no writes/requests OK');
}
const mod = new Module(__filename, module); mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
