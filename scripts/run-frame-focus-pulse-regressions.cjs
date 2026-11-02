// Native Lute fixtures and isolated APIs; never opens or edits a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    wysiwyg.innerHTML = lute.Md2BlockDOM('$needle+needle$\n\n$$\nneedle+needle\n$$\n\n```needleneedle\nbody\n```\n\n```needleneedle\nother body\n```\n\n![](assets/pulse.png) ![](assets/pulse.png)\n\nplain needle');
    responder = async url => url === '/api/asset/getImageOCRText' ? {code: 0, data: {text: 'needle needle'}} :
        (() => {throw new Error('Unexpected API ' + url);})();
    const options = {...prefs.DEFAULT_PREFS, searchMathSource: true, includeImageOCR: true, includeFoldedBlocks: false};
    const matches = (await calculateSearchMatches({}, edit, 'needle', options)).matches;
    const hostOf = hit => visual.mathSourceFrameHost(hit.range) ?? visual.imageOCRFrameHost(hit.range) ?? visual.codeLanguageFrameHost(hit.range);
    const groups = new Map();
    for (const hit of matches.filter(hit => ['math-source', 'code-language', 'image-ocr'].includes(hit.highlightKind))) {
        const host = hostOf(hit);
        assert.ok(host);
        host.getBoundingClientRect = () => rect(20, 40 + groups.size * 20, 180, 30);
        const group = groups.get(host) ?? [];
        group.push(hit); groups.set(host, group);
    }
    assert.equal(groups.size, 6, 'inline/block math, identical labels and duplicate image URL fixtures');
    assert.ok([...groups.values()].every(group => group.length === 2));
    const plain = matches.find(hit => !['math-source', 'code-language', 'image-ocr'].includes(hit.highlightKind));
    assert.ok(plain);
    content.getBoundingClientRect = () => rect(0, 0, 600, 500);
    const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
    const originalNow = Object.getOwnPropertyDescriptor(window.performance, 'now');
    let now = 1000;
    Object.defineProperty(window.performance, 'now', {configurable: true, value: () => now});
    const focus = () => edit.querySelector('.page-search-code-language-frame.is-focus');
    const pulsing = () => edit.querySelectorAll('.page-search-code-language-frame.is-focus-pulse');
    try {
        for (const pair of groups.values()) {
            visual.clearCodeLanguageVisual(edit);
            let pending;
            const bar = Object.assign(Object.create(SearchBar.prototype), options, {edit, resultMatches: pair,
                resultIndex: 1, resultCount: 2, memoUnderlineLayoutRaf: 0,
                updateCountLabel() {}, pauseAvWatch() {}, revealMatchTabs() {}, syncReplaceButtons() {},
                clearSearchFocus() {}, applyFocusHighlight() {}, unfoldAttributeViewGroup() {return false;},
                attributeViewRangeNeedsReveal() {return false;},
                scrollIntoRanges(...args) {pending = this.scrollIntoRangesAsync(...args);},
            });
            try {
                bar.syncMemoUnderlineVisual();
                assert.equal(pulsing().length, 0, 'initial paint does not flash');
                bar.clickResultsItem(0); await pending;
                assert.equal(pulsing().length, 0, 'reselecting the current hit does not flash');
                bar.clickNext(); await pending;
                assert.equal(pulsing().length, 1, pair[0].highlightKind + ' next within one host flashes its frame');
                const firstFrame = focus();
                now += 60;
                bar.syncMemoUnderlineVisual();
                assert.equal(pulsing().length, 1, 'scroll/resize redraw preserves the ongoing pulse');
                assert.equal(focus().style.animationDelay, '-60ms', 'redraw resumes elapsed time instead of restarting');
                bar.clickLast(); await pending;
                assert.equal(pulsing().length, 1, 'previous restarts feedback');
                assert.notEqual(focus(), firstFrame);
                assert.equal(focus().style.animationDelay, '0ms');
                bar.clickResultsItem(1); await pending;
                assert.equal(pulsing().length, 1, 'result-list navigation also flashes');
                now += 200;
                bar.syncMemoUnderlineVisual();
                assert.equal(pulsing().length, 0, 'elapsed pulses are removed on redraw');
                assert.ok(focus(), 'focus stays orange after the animation');
                bar.clickLast(); await pending;
                assert.equal(pulsing().length, 1);
                const other = [...groups.values()].find(group => group[0].highlightKind === pair[0].highlightKind &&
                    hostOf(group[0]) !== hostOf(pair[0]))[0];
                bar.resultMatches = [pair[0], other]; bar.resultIndex = 1;
                bar.syncMemoUnderlineVisual();
                bar.clickNext(); await pending;
                assert.equal(pulsing().length, 0, 'different objects do not inherit an old pulse');
                bar.resultMatches = [other, plain]; bar.resultIndex = 1;
                bar.syncMemoUnderlineVisual();
                bar.clickNext(); await pending;
                assert.equal(pulsing().length, 0, 'ordinary text does not receive frame feedback');
                bar.resultMatches = pair; bar.resultIndex = 1; bar.syncMemoUnderlineVisual();
                bar.clickNext(); await pending;
                visual.clearCodeLanguageVisual(edit);
                bar.syncMemoUnderlineVisual();
                assert.equal(pulsing().length, 0, 'clearing/reopening does not revive a stale pulse');
                bar.resultIndex = 1; bar.syncMemoUnderlineVisual();
                bar.unfoldAttributeViewGroup = () => true;
                bar.clickNext();
                bar.resultIndex = 1; bar.syncMemoUnderlineVisual();
                await pending;
                assert.equal(pulsing().length, 0, 'superseded async navigation cannot flash the current target');
            } finally {bar.teardownMemoUnderlineLayoutSync(); visual.clearCodeLanguageVisual(edit);}
        }
        assert.equal(wysiwyg.innerHTML, snapshot, 'only overlay nodes are touched');
        assert.equal(apiCalls, calls, 'frame feedback issues no API requests');
        assert.equal(edit.querySelector('.page-search-code-language-layer'), null);

        // Native canvas pan/zoom redraws must resume the pulse as well.
        wysiwyg.innerHTML = '<div class="mindmap-view"><div class="mindmap-view__world">' +
            lute.Md2BlockDOM('$needle+needle$') + '</div></div>';
        const mapHit = (await calculateSearchMatches({}, edit, 'needle', options)).matches[0];
        assert.equal(mapHit.highlightKind, 'math-source');
        hostOf(mapHit).getBoundingClientRect = () => rect(20, 40, 180, 30);
        visual.applyCodeLanguageVisual(edit, [mapHit.range], mapHit.range);
        visual.pulseFrameFocus(edit);
        now += 50;
        wysiwyg.querySelector('.mindmap-view__world').style.transform = 'translate(30px, 0)';
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        assert.equal(pulsing().length, 1, 'canvas transform preserves active feedback');
        assert.equal(focus().style.animationDelay, '-50ms');
        visual.clearCodeLanguageVisual(edit);

        // Keep the existing same-memo underline feedback working.
        wysiwyg.innerHTML = '<div data-type="NodeParagraph" data-node-id="memo"><div contenteditable="true">' +
            '<span data-type="inline-memo" data-inline-memo-content="needle needle">host</span></div></div>';
        const memoMatches = (await calculateSearchMatches({}, edit, 'needle', {...options, includeInlineMemo: true})).matches;
        assert.equal(memoMatches.length, 2);
        for (const hit of memoMatches) hit.range.getClientRects = () => [rect(20, 40, 80, 20)];
        let pending;
        const memoBar = Object.assign(Object.create(SearchBar.prototype), options, {edit, resultMatches: memoMatches,
            resultIndex: 1, resultCount: 2, memoUnderlineLayoutRaf: 0,
            updateCountLabel() {}, pauseAvWatch() {}, revealMatchTabs() {}, syncReplaceButtons() {},
            clearSearchFocus() {}, unfoldAttributeViewGroup() {return false;}, attributeViewRangeNeedsReveal() {return false;},
            scrollIntoRanges(...args) {pending = this.scrollIntoRangesAsync(...args);},
        });
        try {
            memoBar.syncMemoUnderlineVisual();
            memoBar.clickNext(); await pending;
            assert.equal(edit.querySelectorAll('.page-search-memo-underline.is-focus-pulse').length, 1);
        } finally {
            memoBar.teardownMemoUnderlineLayoutSync();
            source('frontend/memo-underline-visual').clearMemoUnderlineVisual(edit);
        }
    } finally {
        visual.clearCodeLanguageVisual(edit);
        if (originalNow) Object.defineProperty(window.performance, 'now', originalNow);
        else delete window.performance.now;
    }
    const css = fs.readFileSync(path.join(__dirname, '../src/index.scss'), 'utf8');
    assert.match(css, /@keyframes page-search-frame-focus-pulse/);
    console.log('Frame feedback: native inline/block formula sources, code labels and OCR; next/previous/list, scroll/canvas timing, restart, expiry, different targets, cleanup, memo compatibility and no writes/requests OK');
}
const mod = new Module(__filename, module); mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
