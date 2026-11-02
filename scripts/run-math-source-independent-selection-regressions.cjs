// Native selection capture and real mode switching with isolated APIs; never opens a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    const capture = source('frontend/selection-scope-visual');
    const selectionApi = source('frontend/selection');
    const blocksApi = source('frontend/blocks');
    const nativeTable = require('./rich-cell-native-fixture.cjs')(lute);
    const md = '```python\npython print(1)\n```';
    const encode = Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content: md})).toString('base64url');
    const memo = '<span data-type="inline-memo" data-inline-memo-content="needle">body</span>';
    const paragraph = (id, text) => '<div data-type="NodeParagraph" data-node-id="' + id + '"><div contenteditable="true">' + text + '</div></div>';
    const table = text => '<div data-type="NodeTable" data-node-id="20261103000000-audit00"><table><tbody><tr><td>' + text + '</td></tr></tbody></table></div>';
    const cases = [
        ['rich-code-language', nativeTable('<div data-type="NodeTable" data-node-id="20261103000000-audit00" custom-sy-table-rich="1">' +
            '<table><tbody><tr><td data-sy-table-cell-rich="' + encode + '"><div class="table__cell-rich">' +
            lute.BlockDOM2HTML(lute.Md2BlockDOM(md)) + '</div></td></tr></tbody></table></div>'), 'includeCodeLanguage', 'python', 2],
        ['image-ocr', lute.Md2BlockDOM('![caption](assets/audit.png)\n\nneedle'), 'includeImageOCR', 'needle', 2],
        ['inline-memo', paragraph('20261103000000-audit01', memo), 'includeInlineMemo', 'needle', 1],
        ['table-memo', table(memo), 'includeInlineMemo', 'needle', 1],
        ['table-image-ocr', table('<span class="img"><img src="assets/audit.png"></span>'), 'includeImageOCR', 'needle', 1],
        ['embedded-memo', '<div data-node-id="20261103000000-audit02" data-type="NodeBlockQueryEmbed">' + paragraph('20261103000000-audit03', memo) + '</div>', 'includeInlineMemo', 'needle', 1],
    ];
    const panel = (options, captured, text) => Object.assign(Object.create(SearchBar.prototype), options, {
        edit, searchText: text, selectionOnly: true, rememberedSelectionScope: captured.scope, selectionScopeVisualKind: captured.kind,
        rememberedVisualBlockIds: captured.visualBlockIds, rememberedAvScopeRefs: captured.avScopeRefs,
        rememberedTableCellRefs: captured.tableCellRefs, pendingTableCells: null, pendingTableCellText: null,
        setOpenMenuSwitch() {}, highlightHitResult() {return Promise.resolve();},
    });
    const search = (bar, text) => calculateSearchMatches({}, edit, text, {...bar.searchOptions(), selectionOnly: true,
        selectionScope: bar.resolveScopeForSearch()});
    for (const [label, html, gate, needle, count] of cases) for (const initialSource of [false, true]) {
        wysiwyg.innerHTML = html;
        for (const child of wysiwyg.children) child.classList.add('protyle-wysiwyg--select');
        const options = {...prefs.DEFAULT_PREFS, searchMathSource: initialSource, includeImageOCR: true, includeInlineMemo: true};
        const captured = capture.captureSelectionScopeWithKind(edit, options);
        for (const child of wysiwyg.children) child.classList.remove('protyle-wysiwyg--select');
        responder = async url => url === '/api/asset/getImageOCRText' ? {code: 0, data: {text: 'needle'}} : (() => {throw new Error('Unexpected API ' + url);})();
        const bar = panel(options, captured, needle);
        assert.equal((await search(bar, needle)).matches.length, count, label + ' fixture');
        const frozen = selectionApi.cloneSelectionScope(bar.rememberedSelectionScope);
        const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
        bar[gate] = false;
        for (const nextMode of [!initialSource, initialSource, !initialSource]) {
            bar.applySearchMathSource(nextMode);
            assert.deepEqual(bar.rememberedSelectionScope, frozen, label + ' survives the disabled gate in both directions');
        }
        assert.equal(apiCalls, calls, 'mode switching does not request OCR or call the kernel');
        assert.equal(wysiwyg.innerHTML, snapshot, 'mode switching does not change note content or render formulas');
        assert.equal((await search(bar, needle)).matches.length, label === 'rich-code-language' || label === 'image-ocr' ? 1 : 0,
            'retaining the frozen scope never enables a disabled search type');
        bar[gate] = true;
        assert.equal((await search(bar, needle)).matches.length, count, label + ' restored count');
    }

    // A partial memo selection stays partial; another same-text memo is not selected.
    wysiwyg.innerHTML = paragraph('20261103000000-audit04', memo + ' ' + memo);
    const options = {...prefs.DEFAULT_PREFS, includeInlineMemo: true, includeImageOCR: false};
    const units = collectSearchableBlocks(edit, options).filter(block => block.matchSource === 'inline-memo');
    const frozen = new Map([[unitKey(units[0].blockId, units[0].unitId), [{start: 1, end: 5}]]]);
    const bar = panel(options, {scope: frozen, kind: 'text', visualBlockIds: [], avScopeRefs: [], tableCellRefs: []}, 'eedl');
    bar.includeInlineMemo = false;
    bar.applySearchMathSource(true); bar.applySearchMathSource(false);
    assert.deepEqual(bar.rememberedSelectionScope, frozen);
    bar.includeInlineMemo = true;
    assert.equal((await search(bar, 'eedl')).matches.length, 1);
    assert.equal((await search(bar, 'needle')).matches.length, 0, 'memo scope does not widen to the entire attribute');

    // Removed/unloaded memo ordinals cannot be guessed from another owner's equal text.
    wysiwyg.innerHTML = paragraph('20261103000000-audit05', memo);
    bar.rememberedSelectionScope = frozen; bar.includeInlineMemo = false;
    bar.applySearchMathSource(true);
    assert.equal(bar.rememberedSelectionScope.size, 0, 'unavailable memo host is never rebound by a naked ordinal');
    const unavailable = new Map(['inline-memo:0', 'inline-math:0', 'inline-math:source:0', 'cell:g:r:c#run-0'].map(id =>
        [unitKey('gone', id), [{start: 0, end: 1}]]));
    assert.equal(selectionApi.remapMathSelectionScope([], [], unavailable, {edit}).size, 0);

    // Stable label/image identities keep exact disjoint offsets even while unloaded.
    const stable = new Map(['code-language:table-cell:34:1:0', 'embed:source:code-language:table-cell:34:1:0',
        'image-ocr:0:assets%2Faudit.png', 'table-cell:34:1:image-ocr:0:assets%2Faudit.png'].map(id =>
        [unitKey('gone', id), [{start: 1, end: 2}, {start: 4, end: 6}]]));
    const kept = selectionApi.remapMathSelectionScope([], [], stable, {edit});
    assert.deepEqual(kept, stable);
    kept.values().next().value[0].start = 0;
    assert.equal(stable.values().next().value[0].start, 1, 'frozen ranges are cloned');

    // Supplementary memo collection is conditional and batched, never once per selected memo.
    const collect = blocksApi.collectFrozenMemoSelectionUnits;
    let reads = 0;
    blocksApi.collectFrozenMemoSelectionUnits = (...args) => {reads++; return collect(...args);};
    try {
        selectionApi.remapMathSelectionScope([], [], stable, {edit});
        assert.equal(reads, 0, 'image/label-only scopes need no supplementary traversal');
        wysiwyg.innerHTML = paragraph('20261103000000-audit06', Array(150).fill(memo).join(' '));
        const memos = collectSearchableBlocks(edit, options).filter(block => block.matchSource === 'inline-memo');
        const scope = new Map(memos.map(block => [unitKey(block.blockId, block.unitId), [{start: 1, end: 5}]]));
        const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
        assert.deepEqual(selectionApi.remapMathSelectionScope([], [], scope, {edit}), scope);
        assert.equal(reads, 1, 'one supplementary scan for all missing memo hosts');
        assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
        selectionApi.remapMathSelectionScope(memos, memos, scope, {edit});
        assert.equal(reads, 1, 'already-collected memo hosts use the existing fast path');
    } finally {blocksApi.collectFrozenMemoSelectionUnits = collect;}
    // The targeted fallback retains the full collector's identities when
    // unrelated/hidden/empty memos precede it, or native previews and repeated
    // embedded copies change ownership and text offsets.
    const nested = '<span data-type="inline-memo" data-inline-memo-content="outer">\u200b' +
        '<span data-type="inline-memo" data-inline-memo-content="inner">\u200b</span>tail</span>';
    const tricky = memo + ' ' + nested + '<span data-type="inline-memo" data-inline-memo-content="empty-host"></span>' +
        '<span class="fn__none" data-type="inline-memo" data-inline-memo-content="hidden">hidden</span>' +
        '<span data-type="inline-memo" data-inline-memo-content="&lt;b&gt;&lt;/b&gt;">empty-note</span>' +
        '<span class="img"><img src="assets/audit.png"><span class="protyle-action__title">caption</span></span>' + memo;
    const richMarkdown = '<span data-type="inline-memo" data-inline-memo-content="rich">body</span>\n\n' +
        '> <span data-type="inline-memo" data-inline-memo-content="quote">quote body</span>';
    const richValue = Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content: richMarkdown})).toString('base64url');
    const rich = nativeTable(table('').replace('<td>', '<td data-sy-table-cell-rich="' + richValue + '"><div class="table__cell-rich"></div>'));
    const embed = (id, content) => '<div data-type="NodeBlockQueryEmbed" data-node-id="' + id + '">' + content + '</div>';
    const identity = block => ({blockId: block.blockId, blockType: block.blockType, unitId: block.unitId, text: block.text,
        anchorOffset: block.anchorOffset, anchorEnd: block.anchorEnd, tableSlot: block.tableSlot,
        embeddedSourceId: block.embeddedSourceId, element: block.element});
    for (const [label, html] of [
        ['global-ordinal', paragraph('noise', memo) + paragraph('selected', tricky)],
        ['nested-table', table(tricky)],
        ['native-rich-table', rich],
        ['active-rich-editor', rich.replace('</td>', '<div class="table__cell-editor table__cell--inline"><div class="protyle-wysiwyg">' +
            paragraph('temporary', tricky) + '</div></div></td>')],
        ['embedded-copies', embed('embed-a', paragraph('same', tricky) + paragraph('same', tricky)) +
            embed('embed-b', paragraph('same', tricky))],
        ['embedded-table-copies', embed('embed-a', table(tricky) + table(tricky)) + embed('embed-b', table(tricky))],
        ['preview', '<div>' + tricky + '</div>'],
    ]) for (const includeImageTitle of [false, true]) {
        wysiwyg.innerHTML = html;
        if (label === 'nested-table') {
            const row = wysiwyg.querySelector('tr');
            const placeholder = document.createElement('tr');
            placeholder.innerHTML = '<td>placeholder</td>';
            placeholder.setAttribute('data-sy-table-virtual-rows', '<tr><td>omitted1</td></tr><tr><td>omitted2</td></tr>');
            row.before(placeholder);
        }
        const units = collectSearchableBlocks(edit, {...options, includeImageTitle, skipEmbeddedOrder: true})
            .filter(block => block.matchSource === 'inline-memo');
        assert.ok(units.length >= 2, label + ' fixture must contain multiple real memos');
        const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
        for (const subset of [units, [units[units.length - 1]]]) {
            const keys = new Set(subset.map(block => unitKey(block.blockId, block.unitId)));
            const expected = units.filter(block => keys.has(unitKey(block.blockId, block.unitId)));
            assert.deepEqual(collect(edit, keys, includeImageTitle).map(identity), expected.map(identity), label + ' exact frozen identities');
        }
        assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
    }

    // Real block capture: an unrelated, disabled table must not be processed just
    // to retain the selected paragraph's memo while switching formula modes.
    const compare = Node.prototype.compareDocumentPosition;
    const work = [];
    try {
        for (const count of [100, 200]) {
            wysiwyg.innerHTML = paragraph('selected', memo) + table(Array(count).fill(memo).join(' '));
            wysiwyg.firstElementChild.classList.add('protyle-wysiwyg--select');
            const opts = {...options, includeTable: false};
            const captured = capture.captureSelectionScopeWithKind(edit, opts);
            wysiwyg.firstElementChild.classList.remove('protyle-wysiwyg--select');
            const bar = panel(opts, captured, 'needle');
            bar.includeInlineMemo = false;
            const frozen = selectionApi.cloneSelectionScope(captured.scope);
            const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
            let comparisons = 0;
            Node.prototype.compareDocumentPosition = function(...args) {comparisons++; return compare.apply(this, args);};
            bar.applySearchMathSource(true); bar.applySearchMathSource(false);
            Node.prototype.compareDocumentPosition = compare;
            assert.deepEqual(bar.rememberedSelectionScope, frozen);
            assert.equal(comparisons, 0, 'unrelated table memos need no table-position comparisons');
            assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
            assert.equal((await search(bar, 'needle')).matches.length, 0, 'disabled memos stay disabled');
            bar.includeInlineMemo = true;
            assert.equal((await search(bar, 'needle')).matches.length, 1);
            work.push({case: 'unrelated-table', count, comparisons});
        }
        // A selected table can contain many memos in one cell. Their identities,
        // anchors and logical slots must agree with ordinary collection, with
        // bounded position comparisons rather than a prefix scan per memo.
        for (const count of [100, 200]) {
            wysiwyg.innerHTML = table(Array(count).fill(memo).join(' '));
            const units = collectSearchableBlocks(edit, options).filter(block => block.matchSource === 'inline-memo');
            const keys = new Set(units.map(block => unitKey(block.blockId, block.unitId)));
            const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
            let comparisons = 0;
            Node.prototype.compareDocumentPosition = function(...args) {comparisons++; return compare.apply(this, args);};
            const verified = collect(edit, keys);
            Node.prototype.compareDocumentPosition = compare;
            assert.deepEqual(verified, units, 'target table identities and offsets retain the existing contract');
            assert.ok(comparisons <= count * 4, 'target table memo offsets are computed in one forward pass: ' + comparisons);
            assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
            work.push({case: 'selected-table', count, comparisons});
        }
    } finally {Node.prototype.compareDocumentPosition = compare;}
    console.log('Formula-mode independent frozen selections: native block capture, OCR/rich labels/memos/embeds, both directions, partial offsets, gates, host checks and bounded reads OK', work);
}
const mod = new Module(__filename, module); mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
