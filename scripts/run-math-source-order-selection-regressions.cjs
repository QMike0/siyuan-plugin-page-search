// Native Lute fixtures and isolated APIs; never reads or edits real notes.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    const selectionApi = source('frontend/selection');
    const sourceMode = {searchMathSource: true, includeFoldedBlocks: true, includeAttributeView: false};
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    const markdown = 'before $x+\\alpha$ middle $\\alpha$ after';
    const html = lute.Md2BlockDOM(markdown);
    const root = document.createElement('div'); root.innerHTML = html;
    const id = root.firstElementChild.dataset.nodeId;
    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'root', 'root', 'p', '',
        'before α middle α after', markdown, '', 'hash', '1');
    responder = async (url, payload) => url === '/api/query/sql' ? {code: 0, data: db.prepare(payload.stmt).all()} :
        url === '/api/block/getDocBlocksOrders' ? {code: 0, data: [id]} :
        url === '/api/block/getBlockDOMs' ? {code: 0, data: {[id]: html}} : {code: -1};
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    try {
        for (const mounted of [false, true]) for (const folded of [false, true]) {
            wysiwyg.innerHTML = mounted ? html : '';
            if (mounted && folded) wysiwyg.firstElementChild.setAttribute('fold', '1');
            corpus.invalidateDocumentSearchCaches();
            const search = (text, more) => corpus.searchCurrentDocument({}, edit, text, {...sourceMode, ...more});
            const literal = await search('\\alpha');
            assert.equal(literal.partial, false);
            assert.deepEqual(literal.matches.map(hit => hit.start), [2, 0], 'formula position precedes source-string offset');
            const mixed = await search('before|\\\\alpha|middle|after', {regex: true});
            assert.deepEqual(mixed.matches.map(hit => hit.matchedText), ['before', '\\alpha', 'middle', '\\alpha', 'after'],
                'body and formulas interleave in native reading order');
            assert.ok(literal.matches.every(hit => !hit.replaceable && hit.highlightKind === 'math-source'));
            if (mounted && !folded) {
                const local = await calculateSearchMatches({}, edit, 'before|\\\\alpha|middle|after', {...sourceMode, regex: true});
                assert.deepEqual(local.matches.map(hit => hit.matchedText), mixed.matches.map(hit => hit.matchedText));
            }
        }
        // A plain cell can have two formulas at the same body-text offset.
        // Their source-local match offsets must not reverse navigation order.
        const tableMarkdown = '| before $long+\\alpha$<br />$\\alpha$ after | before $long+\\alpha$<br />$\\alpha$ after |\n| --- | --- |\n| before $long+\\alpha$<br />$\\alpha$ after | before $long+\\alpha$<br />$\\alpha$ after |';
        const tableHTML = lute.Md2BlockDOM(tableMarkdown);
        root.innerHTML = tableHTML;
        const tableId = root.firstElementChild.dataset.nodeId;
        db.exec('DELETE FROM blocks');
        db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)').run(tableId, 'root', 'root', 't', '',
            'before \\alpha \\alpha after', tableMarkdown, '', 'table-hash', '1');
        responder = async (url, payload) => url === '/api/query/sql' ? {code: 0, data: db.prepare(payload.stmt).all()} :
            url === '/api/block/getDocBlocksOrders' ? {code: 0, data: [tableId]} :
            url === '/api/block/getBlockDOMs' ? {code: 0, data: {[tableId]: tableHTML}} : {code: -1};
        for (const layout of ['unloaded', 'live', 'virtual', 'folded']) {
            wysiwyg.innerHTML = layout === 'unloaded' ? '' : tableHTML;
            if (layout === 'virtual') {
                const row = wysiwyg.querySelector('tbody tr');
                const omitted = row.outerHTML;
                row.innerHTML = '<td></td>'; row.setAttribute('data-sy-table-virtual-rows', omitted);
            }
            if (layout === 'folded') wysiwyg.firstElementChild.setAttribute('parent-heading', '20261026000000-heading');
            corpus.invalidateDocumentSearchCaches();
            const snapshot = wysiwyg.innerHTML;
            const result = await corpus.searchCurrentDocument({}, edit, '\\alpha', sourceMode);
            assert.equal(result.partial, false);
            assert.deepEqual(result.matches.map(hit => hit.start), [5, 0, 5, 0, 5, 0, 5, 0], 'plain table ' + layout + ' formula order');
            assert.ok(result.matches.every(hit => !hit.replaceable && hit.highlightKind === 'math-source'));
            const mixed = await corpus.searchCurrentDocument({}, edit, 'before|\\\\alpha|after', {...sourceMode, regex: true});
            assert.deepEqual(mixed.matches.map(hit => hit.matchedText), Array(4).fill(['before', '\\alpha', '\\alpha', 'after']).flat());
            if (layout === 'live') {
                editors = [];
                try {
                    const local = await calculateSearchMatches({}, edit, '\\alpha', sourceMode);
                    assert.deepEqual(local.matches.map(hit => hit.start), result.matches.map(hit => hit.start));
                    assert.equal((await calculateSearchMatches({}, edit, 'before', sourceMode)).matches.filter(hit => hit.replaceable).length, 4);
                } finally { editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}]; }
            }
            assert.equal(wysiwyg.innerHTML, snapshot, 'ordering never edits the table');
        }
    } finally { db.close(); editors = []; }

    // The real mode-switch entry point must retain frozen ordinary text when
    // its type is temporarily excluded or its editor DOM has been unloaded.
    for (const initialSource of [false, true]) for (const hidden of ['unloaded', 'gated']) {
        wysiwyg.innerHTML = lute.Md2BlockDOM('needle first\n\n## needle second');
        const nodes = [...wysiwyg.children];
        const options = {...prefs.DEFAULT_PREFS, includeAttributeView: false, includeImageOCR: false, searchMathSource: initialSource};
        const range = document.createRange(); range.selectNodeContents(wysiwyg);
        window.getSelection().addRange(range);
        const frozen = selectionApi.getSelectionScope(edit, collectSearchableBlocks(edit, options));
        window.getSelection().removeAllRanges();
        assert.equal(frozen.size, 2);
        // Keep a partial range: retaining a frozen scope must never expand it.
        for (const key of frozen.keys()) frozen.set(key, [{start: 1, end: 6}]);
        if (hidden === 'unloaded') nodes[0].remove();
        const panel = Object.assign(Object.create(SearchBar.prototype), options, {
            edit, searchText: 'needle', selectionOnly: true, rememberedSelectionScope: frozen,
            selectionScopeVisualKind: 'text', rememberedVisualBlockIds: [], rememberedAvScopeRefs: [], rememberedTableCellRefs: [],
            pendingTableCells: null, pendingTableCellText: null,
            setOpenMenuSwitch() {}, highlightHitResult() {return Promise.resolve();},
        });
        if (hidden === 'gated') {panel.includeParagraph = false; panel.includeHeadingH2 = false;}
        const calls = apiCalls; const snapshot = wysiwyg.innerHTML;
        for (const mode of [!initialSource, initialSource, !initialSource]) {
            panel.applySearchMathSource(mode);
            assert.deepEqual(panel.rememberedSelectionScope, frozen, hidden + ' preserves exact frozen ranges in both directions');
        }
        assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
        if (hidden === 'unloaded') wysiwyg.insertBefore(nodes[0], wysiwyg.firstChild);
        panel.includeParagraph = true; panel.includeHeadingH2 = true;
        const selected = await calculateSearchMatches({}, edit, 'eedle', {...panel.searchOptions(), selectionOnly: true,
            selectionScope: panel.rememberedSelectionScope});
        assert.equal(selected.matches.length, 2, 'restored text keeps the selected hits');
        assert.equal((await calculateSearchMatches({}, edit, 'needle', {...panel.searchOptions(), selectionOnly: true,
            selectionScope: panel.rememberedSelectionScope})).matches.length, 0, 'partial selection never widens');
    }
    const ambiguous = new Map(['inline-math:0', 'inline-math:source:0', 'cell:group:row:col', 'cell:group:row:col#run-0',
        'renderer:source:math:0'].map(id => [unitKey('block', id), [{start: 0, end: 1}]]));
    assert.equal(selectionApi.remapMathSelectionScope([], [], ambiguous).size, 0,
        'unavailable formula ordinals and representation-dependent AV runs are never guessed');
    for (const md of ['needle $x$ needle', '| needle $x$ needle |\n| --- |\n| needle |']) {
        wysiwyg.innerHTML = lute.Md2BlockDOM(md);
        const body = collectSearchableBlocks(edit, sourceMode).filter(block => block.text.includes('needle'));
        const frozen = new Map(body.map(block => [unitKey(block.blockId, block.unitId), [{start: 1, end: 6}]]));
        assert.ok([...frozen.keys()].some(key => /run-\d+/.test(key)), 'fixture has split body runs');
        const calls = apiCalls; const snapshot = wysiwyg.innerHTML;
        const kept = selectionApi.remapMathSelectionScope([], [], frozen);
        assert.deepEqual(kept, frozen, 'unavailable paragraph/table body runs keep their actual IDs and partial ranges');
        kept.values().next().value[0].start = 0;
        assert.equal(frozen.values().next().value[0].start, 1, 'retained ranges are cloned');
        assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
    }

    const positions = source('frontend/embedded-order');
    const record = positions.recordEmbeddedOrder;
    const tableWork = [];
    try {
        for (const count of [50, 100]) {
            wysiwyg.innerHTML = lute.Md2BlockDOM('| ' + Array(count).fill('$\\alpha$').join('<br />') + ' | plain |\n| --- | --- |\n| text | text |');
            let snapshots = 0; let visited = 0;
            positions.recordEmbeddedOrder = function(host, blocks, ...args) {
                snapshots++; visited += blocks.length; return record(host, blocks, ...args);
            };
            const snapshot = wysiwyg.innerHTML; const calls = apiCalls;
            const blocks = collectSearchableBlocks(edit, sourceMode);
            assert.equal(snapshots, 1, 'one snapshot per affected plain cell, none for unrelated cells');
            assert.equal(blocks.filter(block => source('shared/math-search').isMathSourceUnit(block)).length, count);
            assert.ok(visited <= count * 2, 'plain-cell work stays bounded per formula');
            assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
            tableWork.push({count, snapshots, visited});
        }
        wysiwyg.innerHTML = lute.Md2BlockDOM('| plain |\n| --- |\n| text |');
        let snapshots = 0;
        positions.recordEmbeddedOrder = function(...args) {snapshots++; return record(...args);};
        collectSearchableBlocks(edit, sourceMode);
        assert.equal(snapshots, 0, 'formula-free tables do not take the extra path');
    } finally { positions.recordEmbeddedOrder = record; }

    const mountCell = html => {
        wysiwyg.innerHTML = '<div data-type="NodeAttributeView" data-node-id="db"><div class="av__body"><div class="av__row" data-id="row"><div class="av__cell" data-col-id="col">' + html + '</div></div></div></div>';
        wysiwyg.querySelectorAll('[data-type~="inline-math"]').forEach(el => {
            el.innerHTML = '<span class="katex-html">x</span>'; el.dataset.render = 'true';
        });
    };
    mountCell(lute.BlockDOM2HTML(lute.Md2BlockDOM('A $x$xx')));
    const glyphs = collectSearchableBlocks(edit);
    const sources = collectSearchableBlocks(edit, {searchMathSource: true});
    const glyph = glyphs.find(block => block.textNodes[0]?.parentElement.closest('[data-type~="inline-math"]'));
    const body = sources.find(block => block.text === 'xx');
    const scopeOf = (unit, start = 0, end = unit.text.length) => new Map([[unitKey(unit.blockId, unit.unitId), [{start, end}]]]);
    const sourceScope = selectionApi.remapMathSelectionScope(glyphs, sources, scopeOf(glyph));
    const sourceHits = await calculateSearchMatches({}, edit, 'x', {searchMathSource: true, selectionOnly: true, selectionScope: sourceScope});
    assert.equal(sourceHits.matches.length, 1);
    assert.equal(sourceHits.matches[0].highlightKind, 'math-source', 'formula selection never becomes equal body text');
    const bodyScope = selectionApi.remapMathSelectionScope(sources, glyphs, scopeOf(body, 1, 2));
    const bodyHits = await calculateSearchMatches({}, edit, 'x', {selectionOnly: true, selectionScope: bodyScope});
    assert.equal(bodyHits.matches.length, 1);
    assert.ok(!bodyHits.matches[0].range.startContainer.parentElement.closest('[data-type~="inline-math"]'));
    assert.equal(bodyHits.matches[0].range.startOffset, 1, 'partial plain-text selection keeps its actual node offset');
    // Exact text collisions are the case that defeats the old text-only fast path.
    mountCell(lute.BlockDOM2HTML(lute.Md2BlockDOM('A $x$x')));
    const sameGlyphs = collectSearchableBlocks(edit);
    const sameSources = collectSearchableBlocks(edit, {searchMathSource: true});
    const sameGlyph = sameGlyphs.find(block => block.text === 'x' && block.textNodes[0]?.parentElement.closest('[data-type~="inline-math"]'));
    const sameBody = sameSources.find(block => block.text === 'x' && block.textNodes.length);
    const toSource = selectionApi.remapMathSelectionScope(sameGlyphs, sameSources, scopeOf(sameGlyph));
    const selectedSource = (await calculateSearchMatches({}, edit, 'x', {searchMathSource: true, selectionOnly: true, selectionScope: toSource})).matches;
    assert.equal(selectedSource.length, 1); assert.equal(selectedSource[0].highlightKind, 'math-source');
    const toGlyph = selectionApi.remapMathSelectionScope(sameSources, sameGlyphs, scopeOf(sameBody));
    const selectedBody = (await calculateSearchMatches({}, edit, 'x', {selectionOnly: true, selectionScope: toGlyph})).matches;
    assert.equal(selectedBody.length, 1);
    assert.ok(!selectedBody[0].range.startContainer.parentElement.closest('[data-type~="inline-math"]'));

    // Shared Text slices keep disjoint partial intervals when run IDs change.
    const text = document.createTextNode('abcdef');
    const cell = wysiwyg.querySelector('.av__cell'); cell.replaceChildren(text);
    const base = {blockId: 'db', blockType: 'NodeAttributeView', blockIndex: 0, element: cell, textNodes: [text]};
    const oldWhole = {...base, unitId: 'old', text: 'abcdef'};
    const slices = [{...base, unitId: 'a', text: 'abc', textStartOffset: 0},
        {...base, unitId: 'b', text: 'def', textStartOffset: 3}];
    const disjoint = new Map([[unitKey('db', 'old'), [{start: 1, end: 2}, {start: 4, end: 6}]]]);
    const sliced = selectionApi.remapMathSelectionScope([oldWhole], slices, disjoint);
    assert.deepEqual(sliced, new Map([[unitKey('db', 'a'), [{start: 1, end: 2}]],
        [unitKey('db', 'b'), [{start: 1, end: 3}]]]));
    assert.deepEqual(selectionApi.remapMathSelectionScope(slices, [oldWhole], sliced), disjoint);

    const point = window.Range.prototype.comparePoint;
    const intersects = window.Range.prototype.intersectsNode;
    const work = [];
    try {
        for (const count of [100, 200]) {
            mountCell(lute.BlockDOM2HTML(lute.Md2BlockDOM(Array(count).fill('$x$').join('\n\n'))));
            const before = collectSearchableBlocks(edit, {searchMathSource: true});
            const after = collectSearchableBlocks(edit);
            const all = new Map(before.filter(block => block.text).map(block => [unitKey(block.blockId, block.unitId), [{start: 0, end: block.text.length}]]));
            let reads = 0;
            window.Range.prototype.comparePoint = function(...args) { reads++; return point.apply(this, args); };
            window.Range.prototype.intersectsNode = function(...args) { reads++; return intersects.apply(this, args); };
            const calls = apiCalls; const snapshot = wysiwyg.innerHTML;
            const mapped = selectionApi.remapMathSelectionScope(before, after, all);
            const returned = selectionApi.remapMathSelectionScope(after, before, mapped);
            const formulaCount = (await calculateSearchMatches({}, edit, 'x', {searchMathSource: true, selectionOnly: true, selectionScope: returned})).matches.length;
            assert.equal(formulaCount, count);
            assert.ok(reads <= count * 8, 'same-cell mode switching has no quadratic Range comparison loop: ' + reads);
            assert.equal(apiCalls, calls); assert.equal(wysiwyg.innerHTML, snapshot);
            work.push({count, reads});
        }
    } finally { window.Range.prototype.comparePoint = point; window.Range.prototype.intersectsNode = intersects; }
    console.log('Math source order/selection: cold/live/virtual/folded plain-table order, gated/unloaded frozen body ranges, native equal-text and partial selections, bounded work and no writes OK', {work, tableWork});
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
