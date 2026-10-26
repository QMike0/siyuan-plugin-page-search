// Isolated regressions: never reads or modifies a real notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-rich-table-cell-regressions.cjs'), 'utf8');
global.__richMathRenderers = {};
const setup = harness.slice(0, harness.indexOf('const samples =')).replace(
    'return {getAllEditor:', 'return {ProtyleMethod: global.__richMathRenderers, getAllEditor:');
const fixtures = harness.slice(harness.indexOf('function fixture('), harness.indexOf('(async () => {'));
async function tests() {
    const nativeTable = require('./rich-cell-native-fixture.cjs')(lute);
    const selectionApi = source('frontend/selection');
    const extract = source('frontend/corpus/extract');
    const options = {includeDocTitle: false};
    const markdown = 'before foo\n\n$$\nformulaNeedle + a & b\n$$\n\nafter foo';
    const html = table(markdown, 'foo', '$$\nformulaNeedle\n$$', 'foo');
    const mathSelector = '[data-type="NodeMathBlock"], div.language-math';
    const fakeRender = root => root.querySelectorAll('[data-subtype="math"]').forEach(el => {
        const value = source('frontend/renderer-adapters').diagramSourceText(el);
        el.innerHTML = '<div class="katex"><span class="katex-html"></span><span class="katex-mathml"></span></div>';
        el.querySelector('.katex-html').textContent = value;
        el.querySelector('.katex-mathml').textContent = value;
        el.setAttribute('data-render', 'true');
    });
    for (const preview of ['static', 'native', 'editor']) for (const rendered of [false, true]) {
        const f = fixture(html);
        if (preview !== 'static') f.wysiwyg.innerHTML = nativeTable(html);
        if (preview === 'editor') f.wysiwyg.querySelector('th').innerHTML =
            '<div class="table__cell-editor"><div class="protyle-wysiwyg">' + lute.Md2BlockDOM(markdown) + '</div></div>';
        if (rendered) f.wysiwyg.querySelectorAll(mathSelector).forEach(el => {
            if (!el.hasAttribute('data-content')) el.setAttribute('data-content', el.textContent);
            el.dataset.subtype = 'math';
        });
        if (rendered) fakeRender(f.wysiwyg);
        const original = f.wysiwyg.innerHTML;
        Object.keys(richMethodCounts).forEach(key => richMethodCounts[key] = 0);
        const found = await calculateSearchMatches({}, f.edit, 'formulaNeedle', options);
        assert.equal(found.matches.length, 2, 'math source/glyph is collected exactly once per cell');
        assert.ok(found.matches.every(hit => !hit.replaceable && hit.unitId.startsWith('renderer:')));
        assert.equal(Object.values(richMethodCounts).reduce((a, b) => a + b, 0), 0, 'readonly math matching never converts rich-cell source');
        if (rendered) assert.ok(found.matches.every(hit => hit.range?.toString() === 'formulaNeedle'));
        const off = await calculateSearchMatches({}, f.edit, 'formulaNeedle', {...options, includeMathBlock: false});
        assert.equal(off.matches.length, 0, 'math switch controls block math inside rich cells');
        assert.equal(f.wysiwyg.innerHTML, original, 'search never changes the live preview');
        const blocked = await write.replaceAllMatchesInEditor(f.edit, found.matches, 'changed');
        assert.equal(blocked.replacedCount, 0); assert.equal(f.calls.length, 0);
        if (rendered) {
            const cell = f.wysiwyg.querySelector('th');
            const range = document.createRange(); range.selectNodeContents(cell);
            window.getSelection().addRange(range);
            const snap = selectionApi.snapshotTableCellTextSelection();
            const units = blocks.collectSearchableBlocks(f.edit, options);
            const scope = selectionApi.selectionScopeFromTableCellText(units, snap);
            const selected = await calculateSearchMatches({}, f.edit, 'formulaNeedle', {...options, selectionOnly: true, selectionScope: scope});
            assert.equal(selected.matches.length, 1, 'selected rich-cell formula stays searchable');
            window.getSelection().removeAllRanges();
        }
    }
    let mathRenderCalls = 0;
    global.__richMathRenderers.mathRender = root => {mathRenderCalls++; fakeRender(root);};
    for (const mode of ['none', 'light']) for (const enabled of [false, true]) {
        const extracted = await extract.extractUnitsFromDoms([id], {[id]: html}, {...options, includeMathBlock: enabled}, new Set(), mode);
        try {
            assert.deepEqual(extracted.missingIds, []); assert.deepEqual(extracted.unrenderedIds, []);
            const formulas = extracted.blocks.filter(unit => unit.unitId.startsWith('renderer:') && unit.text.includes('formulaNeedle'));
            assert.equal(formulas.length, enabled ? 2 : 0, mode + ': unloaded math');
            assert.equal(new Set(formulas.map(unit => unit.unitId)).size, formulas.length, 'different cell identities');
            if (enabled && mode === 'light') assert.ok(formulas.every(unit => unit.textNodes.length));
            const cell = extracted.blocks.find(unit => unit.element.hasAttribute(rich.RICH_CELL_ATTRIBUTE))?.element;
            if (enabled && mode === 'light' && cell) assert.equal(rich.isSupportedRichCell(cell), true, 'offline math render preserves neighboring text eligibility');
        } finally {extracted.dispose();}
    }
    assert.ok(mathRenderCalls > 0);
    {
        const {DatabaseSync} = require('node:sqlite');
        const corpus = source('frontend/corpus/search');
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT);CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
        db.function('search_normalize', text => String(text).toLowerCase());
        db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 'math-root', 'math-root', 't', '', 'formulaNeedle', markdown, '', 'hash', '1');
        for (const coverage of ['live', 'static', 'fetched', 'virtual', 'folded']) {
            corpus.invalidateDocumentSearchCaches();
            const f = fixture(html, {loaded: coverage !== 'fetched', virtual: coverage === 'virtual'});
            f.protyle.protyle.block = {id: 'math-root', rootID: 'math-root'};
            if (coverage === 'live' || coverage === 'folded') {
                f.wysiwyg.innerHTML = nativeTable(html); fakeRender(f.wysiwyg);
            }
            if (coverage === 'folded') f.wysiwyg.firstElementChild.setAttribute('parent-heading', '20261026000000-heading');
            api = async (url, data) => {
                if (url === '/api/query/sql') return {code: 0, data: db.prepare(data.stmt).all()};
                if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: [id]};
                if (url === '/api/block/getBlockDOMs') return {code: 0, data: {[id]: f.kernel.get(id)}};
                return {code: 0, data: []};
            };
            const before = f.wysiwyg.innerHTML;
            const result = await corpus.searchCurrentDocument({}, f.edit, 'formulaNeedle', {...options, includeAttributeView: false, includeFoldedBlocks: true});
            assert.equal(result.error, '', coverage); assert.equal(result.partial, false, coverage); assert.equal(result.degraded, false, coverage);
            assert.equal(result.matches.length, 2, coverage + ': complete math corpus');
            assert.ok(result.matches.every(hit => !hit.replaceable));
            const off = await corpus.searchCurrentDocument({}, f.edit, 'formulaNeedle', {...options, includeAttributeView: false, includeFoldedBlocks: true, includeMathBlock: false});
            assert.equal(off.matches.length, 0, coverage + ': math switch');
            assert.equal(f.wysiwyg.innerHTML, before, 'full corpus does not change live content');
        }
        const orderedSource = 'formulaNeedle0\n\n$$\nformulaNeedle1\n$$\n\nformulaNeedle2\n\n$$\nlongprefix formulaNeedle3\n$$\n\n$$\nformulaNeedle4\n$$\n\nformulaNeedle5';
        for (const loaded of [false, true]) for (const prefixLength of [0, 1200]) {
            corpus.invalidateDocumentSearchCaches();
            const orderedHTML = table('x'.repeat(prefixLength) + orderedSource), f = fixture(orderedHTML, {loaded});
            f.protyle.protyle.block = {id: 'math-root', rootID: 'math-root'};
            if (loaded) {f.wysiwyg.innerHTML = nativeTable(orderedHTML); fakeRender(f.wysiwyg);}
            api = async (url, data) => {
                if (url === '/api/query/sql') return {code: 0, data: db.prepare(data.stmt).all()};
                if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: [id]};
                if (url === '/api/block/getBlockDOMs') return {code: 0, data: {[id]: f.kernel.get(id)}};
                return {code: 0, data: []};
            };
            const result = await corpus.searchCurrentDocument({}, f.edit, 'formulaNeedle', {...options, includeAttributeView: false});
            assert.deepEqual(result.matches.map(hit => /formulaNeedle(\d)/.exec(hit.listText)?.[1]), ['0', '1', '2', '3', '4', '5'], 'body and consecutive formulas retain document navigation order');
        }
        corpus.invalidateDocumentSearchCaches(); db.close();
    }
    for (const coverage of ['live', 'fetched', 'virtual', 'selected']) for (const all of [false, true]) {
        const f = fixture(html, {loaded: coverage !== 'fetched', virtual: coverage === 'virtual', selected: coverage === 'selected'});
        if (coverage === 'live' || coverage === 'selected') f.wysiwyg.innerHTML = nativeTable(html);
        const writable = collect(html, 'foo').filter(hit => hit.replaceable);
        const result = all ? await write.replaceAllMatchesInEditor(f.edit, writable, 'bar') :
            await write.replaceCurrentMatchInEditor(f.edit, writable[0], 'bar');
        assert.equal(result.commitState, 'confirmed', coverage + ': ' + JSON.stringify(result));
        const saved = rich.decodeRichCell(parse(f.kernel.get(id)).querySelector('th').getAttribute(rich.RICH_CELL_ATTRIBUTE));
        assert.ok(saved.includes('formulaNeedle + a & b'));
        f.apply(f.calls[0].undo);
        assert.equal(rich.decodeRichCell(parse(f.kernel.get(id)).querySelector('th').getAttribute(rich.RICH_CELL_ATTRIBUTE)), markdown);
    }
    console.log('Rich formulas: static/native, source/glyph, selection, switch, readonly, unloaded and text-neighbor undo OK');
    function manyCells(count = 100) {
        const rows = Array.from({length: count}, () => '<tr><td data-sy-table-cell-rich="' + encode('- foo') + '"></td></tr>').join('');
        return lute.SpinBlockDOM('<div data-type="NodeTable" data-node-id="' + id + '" custom-sy-table-rich="1"><div contenteditable="true"><table><thead><tr><th>keep</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>');
    }
    const costs = [];
    for (const coverage of ['live', 'selected', 'fetched', 'virtual']) {
        const html = manyCells();
        const f = fixture(html, {loaded: coverage !== 'fetched', virtual: coverage === 'virtual'});
        if (coverage === 'live' || coverage === 'selected') f.wysiwyg.innerHTML = nativeTable(html);
        if (coverage === 'selected') {
            const range = document.createRange(); range.selectNodeContents(f.wysiwyg.querySelector('td')); range.collapse(true);
            window.getSelection().addRange(range);
        }
        const hits = collect(html);
        Object.keys(richMethodCounts).forEach(key => richMethodCounts[key] = 0);
        let yielded = false, yieldedAtSubmit, submittedMs;
        const started = performance.now();
        const timer = setTimeout(() => {yielded = true;}, 0);
        const transaction = f.protyle.transaction.bind(f.protyle);
        f.protyle.transaction = (...args) => {yieldedAtSubmit = yielded; submittedMs = performance.now() - started; return transaction(...args);};
        const result = await write.replaceAllMatchesInEditor(f.edit, hits, 'bar');
        clearTimeout(timer);
        assert.equal(result.commitState, 'confirmed'); assert.equal(result.replacedCount, 100);
        assert.equal(yieldedAtSubmit, true, coverage + ': UI timer runs before submit');
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ops.length, 1, 'one complete-table transaction');
        f.apply(f.calls[0].undo); assert.equal(collect(f.kernel.get(id)).length, 100);
        f.apply(f.calls[0].ops); assert.equal(collect(f.kernel.get(id)).length, 0);
        costs.push({coverage, submittedMs: Math.round(submittedMs), yieldedAtSubmit, ...richMethodCounts});
    }
    for (const change of ['cancel', 'edit', 'readonly', 'detach', 'selection', 'kernel']) {
        const html = manyCells(), f = fixture(html, {loaded: change !== 'kernel'});
        if (change !== 'kernel') f.wysiwyg.innerHTML = nativeTable(html);
        if (change === 'selection') {
            const range = document.createRange(); range.selectNodeContents(f.wysiwyg.querySelector('td')); range.collapse(true);
            window.getSelection().addRange(range);
        }
        let current = true;
        const timer = setTimeout(() => {
            if (change === 'cancel') current = false;
            if (change === 'edit') f.wysiwyg.querySelector('td').append('new edit');
            if (change === 'readonly') f.protyle.protyle.disabled = true;
            if (change === 'detach') f.edit.remove();
            if (change === 'kernel') f.kernel.set(id, table('new kernel edit'));
        }, 0);
        Object.keys(richMethodCounts).forEach(key => richMethodCounts[key] = 0);
        let selectionTimer;
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(html), 'bar', {isCurrent: () => {
            if (change === 'selection' && !selectionTimer && richMethodCounts.BlockDOM2Md > 200) {
                selectionTimer = setTimeout(() => window.getSelection().removeAllRanges(), 0);
            }
            return current;
        }});
        clearTimeout(timer);
        clearTimeout(selectionTimer);
        assert.equal(result.replacedCount, 0, change); assert.equal(f.calls.length, 0, change + ': no partial submit');
        if (change === 'cancel' || change === 'readonly' || change === 'detach') assert.ok(richMethodCounts.BlockDOM2Md < 100, 'early exit stops remaining conversions');
        if (change === 'edit') assert.ok(f.wysiwyg.querySelector('td').textContent.includes('new edit'), 'never restore over a new live edit');
        assert.equal(f.kernel.get(id), change === 'kernel' ? table('new kernel edit') : html);
    }
    fs.writeFileSync(path.resolve(__dirname, '../../analysis/rich-cell-preparation-math-afterfix-2026-10-26.json'), JSON.stringify({costs}, null, 2));
    console.log('Preparation: yields, cancellation/edit/readonly/detach/selection/kernel guards, one undo/redo OK', costs);
}
const filename = path.join(__dirname, '__rich-cell-preparation-math.cjs');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(__dirname);
mod._compile(setup + fixtures + '(' + tests.toString() + ')().catch(error => {console.error(error); process.exitCode = 1;});', filename);
