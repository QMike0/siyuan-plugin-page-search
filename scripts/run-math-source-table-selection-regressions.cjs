// Native Lute tables, isolated SQLite/APIs and actual navigation methods; never opens a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    global.Event = window.Event;
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    const options = {...prefs.DEFAULT_PREFS, searchMathSource: true, includeFoldedBlocks: true,
        includeImageOCR: false, includeAttributeView: false};
    const host = hit => hit.range && visual.mathSourceFrameHost(hit.range);
    const mode = process.argv[2];
    if (mode !== '--selection') {
        const markdown = '| header | header |\n| --- | --- |\n' + Array.from({length: 300}, (_, i) =>
            i === 0 || i === 33 ? '| before $\\alpha$ middle $\\beta$ after $\\alpha$ | $\\alpha$ |' : '| body | body |').join('\n');
        const html = lute.Md2BlockDOM(markdown);
        wysiwyg.innerHTML = html;
        const id = wysiwyg.firstElementChild.dataset.nodeId;
        const db = new DatabaseSync(':memory:');
        db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
        db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT);CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
        db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'root', 'root', 't', '',
            'before alpha beta after', markdown, '', 'hash', '1');
        responder = async (url, payload) => url === '/api/query/sql' ? {code: 0, data: db.prepare(payload.stmt).all()} :
            url === '/api/block/getDocBlocksOrders' ? {code: 0, data: [id]} :
            url === '/api/block/getBlockDOMs' ? {code: 0, data: {[id]: html}} : (() => {throw new Error('Unexpected API ' + url);})();
        editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
        const search = () => corpus.searchCurrentDocument({}, edit, '\\\\(?:alpha|beta)', {...options, regex: true});
        const mounted = () => collectSearchableBlocks(edit, options);
        const virtualize = () => {
            wysiwyg.innerHTML = html;
            const rows = [...wysiwyg.querySelectorAll('tr')].slice(1, 34);
            const omitted = rows.map(row => row.outerHTML).join('');
            rows.slice(1).forEach(row => row.remove());
            rows[0].innerHTML = '<td></td>';
            rows[0].setAttribute('data-sy-table-virtual-rows', omitted);
            return rows[0];
        };
        try {
            corpus.invalidateDocumentSearchCaches();
            const full = await search();
            assert.equal(full.partial, false);
            assert.equal(full.matches.length, 8);
            const expected = new Map(mounted().filter(unit => source('shared/math-search').isMathSourceUnit(unit))
                .map(unit => [unit.unitId, {row: unit.tableSlot.row, column: unit.tableSlot.column}]));
            for (const layout of ['virtual', 'unloaded', 'full']) {
                if (layout === 'virtual') virtualize();
                else wysiwyg.innerHTML = layout === 'unloaded' ? '' : html;
                corpus.invalidateDocumentSearchCaches();
                const snapshot = wysiwyg.innerHTML;
                const result = await search();
                assert.equal(result.partial, false);
                assert.deepEqual(result.matches.map(hit => hit.unitId), full.matches.map(hit => hit.unitId), 'cold/live identities agree');
                const live = mounted();
                const positions = new Map(live.map(unit => [unit.element, unit.tableSlot]));
                const inputs = result.matches.map(hit => ({...hit, range: undefined}));
                const targets = new Map(inputs.map(hit => [hit, {broken: true, blockShown: false}]));
                const variants = [result.matches, project.projectRanges(edit, inputs, options, live),
                    project.fillLiveRanges(inputs, live, true), project.projectLiveRanges(edit, inputs, live, true),
                    project.rebindChangedRanges(inputs, live, targets, {allowFoldedHidden: true}).matches];
                for (const matches of variants) for (const hit of matches) {
                    const target = expected.get(hit.unitId);
                    const position = positions.get(host(hit));
                    const shown = layout === 'full' || layout === 'virtual' && target.row === 34;
                    assert.equal(Boolean(hit.range), shown, layout + ' hidden formula never borrows a mounted sibling');
                    if (shown) assert.deepEqual({row: position.row, column: position.column}, target, 'Range stays in its real cell');
                    assert.equal(SearchBar.prototype.logicalRowOfMatch.call({}, hit), target.row, 'navigation knows the logical row');
                    assert.equal(hit.replaceable, false);
                    assert.equal(write.isMatchContentWritable({...hit, replaceable: true}), false, 'source stays read-only');
                }
                assert.equal(wysiwyg.innerHTML, snapshot, 'search/projection does not restore or edit rows');
            }
            // Real navigation: only the target placeholder is revealed, then the exact formula is bound.
            let placeholder = virtualize();
            const inputs = full.matches.map(hit => ({...hit, range: undefined}));
            const table = wysiwyg.firstElementChild;
            const route = Object.assign(Object.create(SearchBar.prototype), {edit, tableRevealSerial: 0,
                revealMountedAttributeViewMatch() {return false;}, bindMindmapPreview() {return false;},
                tryBindUnfoldedMatch() {return false;}, revealVirtualTableMatch(index, match, element) {this.target = {index, match, element};}});
            Object.defineProperty(table, 'clientHeight', {value: 20});
            route.revealUnloadedMatch(0, inputs[0], true);
            assert.deepEqual(route.target, {index: 0, match: inputs[0], element: table}, 'formula navigation enters the native table reveal path');
            const callsBeforeReveal = apiCalls;
            const bar = Object.assign(Object.create(SearchBar.prototype), options, {edit, resultMatches: inputs,
                searchGeneration: 1, tableRevealSerial: 1, replaceBusy: false, applyResultHighlights() {},
                scrollIntoRangesAsync() { this.scrolled = true; return Promise.resolve(); }});
            let reveals = 0;
            placeholder.scrollIntoView = () => {
                reveals++;
                const fragment = document.createElement('template');
                fragment.innerHTML = '<table><tbody>' + placeholder.getAttribute('data-sy-table-virtual-rows') + '</tbody></table>';
                placeholder.replaceWith(...fragment.content.querySelector('tbody').children);
            };
            await bar.revealVirtualTableMatch(0, inputs[0], wysiwyg.firstElementChild, 1);
            assert.equal(reveals, 1); assert.equal(bar.scrolled, true);
            assert.equal(host(inputs[0]).closest('tr'), wysiwyg.querySelectorAll('tr')[1]);
            // A cancelled reveal must not bind or initiate the second scroll.
            placeholder = virtualize(); bar.scrolled = false; bar.tableRevealSerial = 2;
            const cancelled = {...inputs[0], range: undefined}; bar.resultMatches = [cancelled];
            assert.equal(bar.tableMatchRowVirtualizedAway(cancelled), true, 'unloaded formula follows existing virtual-row handling');
            placeholder.scrollIntoView = () => {bar.tableRevealSerial++;};
            await bar.revealVirtualTableMatch(0, cancelled, wysiwyg.firstElementChild, 2);
            assert.equal(cancelled.range, undefined); assert.equal(bar.scrolled, false);
            assert.equal(await bar.prepareTableMatchRow(wysiwyg.firstElementChild,
                {...cancelled, tableSlot: {...cancelled.tableSlot, row: 500}}, bar.tableRevealSerial), 'missing');
            assert.equal(apiCalls, callsBeforeReveal, 'navigation does not fetch or expand the entire table');

            // Same text in different cells remains the same retained result after earlier rows unload.
            const anchors = source('frontend/match-anchor');
            virtualize(); editors = [];
            const local = (await calculateSearchMatches({}, edit, '\\alpha', options)).matches;
            const previous = full.matches.find(hit => expected.get(hit.unitId).row === 34 && expected.get(hit.unitId).column === 1);
            const retained = anchors.resolveRetainedMatchIndex(local, previous, 1, {previousMatches: full.matches});
            assert.equal(local[retained - 1].unitId, previous.unitId);
            assert.equal((await calculateSearchMatches({}, edit, 'before', options)).matches.filter(hit => hit.replaceable).length, 1,
                'neighboring body text stays writable');

            // Restriction enumeration and rich block formulas carry their logical row too.
            const enumerate = source('frontend/restrict-enumerate');
            const enumerated = enumerate.enumerateRestrictInlineMatches(edit, {...options, restrictInlineTypes: ['inline-math']});
            assert.equal(enumerated.length, 4);
            assert.ok(enumerated.every(hit => bar.logicalRowOfMatch(hit) === 34 && !hit.replaceable));
            const nativeTable = require('./rich-cell-native-fixture.cjs')(lute);
            const md = 'before $\\alpha$\n\n$$\n\\beta\n$$';
            const encoded = Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content: md})).toString('base64url');
            wysiwyg.innerHTML = nativeTable('<div data-type="NodeTable" data-node-id="' + id + '" custom-sy-table-rich="1">' +
                '<table><tbody><tr><td data-sy-table-cell-rich="' + encoded + '"><div class="table__cell-rich">' +
                lute.BlockDOM2HTML(lute.Md2BlockDOM(md)) + '</div></td></tr></tbody></table></div>');
            const rich = (await calculateSearchMatches({}, edit, '\\\\(?:alpha|beta)', {...options, regex: true})).matches;
            assert.equal(rich.length, 2); assert.ok(rich.every(hit => bar.logicalRowOfMatch(hit) === 0 && !hit.replaceable));
            const inline = mounted().find(unit => unit.matchSource === 'inline-math');
            const cell = wysiwyg.querySelector('td');
            cell.querySelector('.table__cell-rich').style.display = 'none';
            cell.insertAdjacentHTML('beforeend', '<div class="table__cell-editor"><div class="protyle-wysiwyg">' + lute.Md2BlockDOM(md) + '</div></div>');
            const editing = mounted().filter(unit => unit.matchSource === 'inline-math');
            assert.deepEqual(editing.map(unit => unit.unitId), [inline.unitId], 'hidden preview cannot shift the active editor formula identity');
        } finally {db.close(); editors = [];}
    }
    if (mode !== '--table') {
        const selectionApi = source('frontend/selection');
        for (const initialSource of [false, true]) for (const hidden of ['gated', 'unloaded']) {
            wysiwyg.innerHTML = lute.Md2BlockDOM('```python\npython print(1)\n```');
            const native = wysiwyg.firstElementChild;
            native.classList.add('protyle-wysiwyg--select');
            const frozen = selectionApi.getSelectionScope(edit, collectSearchableBlocks(edit, {...options, searchMathSource: initialSource}));
            native.classList.remove('protyle-wysiwyg--select');
            assert.equal(frozen.size, 2);
            for (const key of frozen.keys()) frozen.set(key, [{start: 1, end: 6}]);
            if (hidden === 'unloaded') native.remove();
            const bar = Object.assign(Object.create(SearchBar.prototype), options, {edit, searchText: 'ython', selectionOnly: true,
                searchMathSource: initialSource, includeCodeLanguage: hidden !== 'gated', rememberedSelectionScope: frozen,
                selectionScopeVisualKind: 'text', rememberedVisualBlockIds: [], rememberedAvScopeRefs: [], rememberedTableCellRefs: [],
                pendingTableCells: null, pendingTableCellText: null, setOpenMenuSwitch() {}, highlightHitResult() {return Promise.resolve();}});
            const calls = apiCalls; const snapshot = wysiwyg.innerHTML;
            for (const nextMode of [!initialSource, initialSource, !initialSource]) {
                bar.applySearchMathSource(nextMode);
                assert.deepEqual(bar.rememberedSelectionScope, frozen, 'frozen code-label/body partial offsets survive ' + hidden);
            }
            assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
            if (hidden === 'unloaded') wysiwyg.append(native);
            bar.includeCodeLanguage = true;
            const selected = await calculateSearchMatches({}, edit, 'ython', {...bar.searchOptions(), selectionOnly: true, selectionScope: bar.rememberedSelectionScope});
            assert.equal(selected.matches.length, 2);
            assert.equal((await calculateSearchMatches({}, edit, 'python', {...bar.searchOptions(), selectionOnly: true,
                selectionScope: bar.rememberedSelectionScope})).matches.length, 0, 'partial scope never widens');
        }
    }
    console.log('Math source virtual-table identity/navigation and frozen code-label selection: OK');
}
const mod = new Module(__filename, module); mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
