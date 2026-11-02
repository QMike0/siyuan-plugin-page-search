// Native v3.8.9 mindmap clone identities; isolated DOM/APIs, never edits notes.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL']) lute['Set' + name](true);
    const options = {searchMathSource: true, includeFoldedBlocks: true, includeAttributeView: false};
    const math = source('shared/math-search');
    const selectionApi = source('frontend/selection');
    const nativeRects = window.Element.prototype.getClientRects;
    window.Element.prototype.getClientRects = function() {
        for (let parent = this; parent; parent = parent.parentElement) {
            if (parent.hasAttribute('hidden') || getComputedStyle(parent).display === 'none') return [];
        }
        return nativeRects.call(this);
    };
    const style = document.createElement('style');
    style.textContent = '[data-mindmap-view-rendered="true"] > .mindmap-item, ' +
        '[custom-sy-list-mindmap="1"][data-mindmap-view-rendered="true"] > .li {display:none}';
    document.head.append(style);
    const fixture = (list = false) => {
        const raw = document.createElement('div');
        raw.innerHTML = lute.Md2BlockDOM('before $x+\\alpha$ middle $\\alpha$ after\n\nsecond $\\alpha$ end\n\n$$\n\\beta\n$$');
        const doms = {};
        Array.from(raw.children).forEach((block, index) => {
            block.dataset.nodeId = ['p1', 'p2', 'math'][index];
            doms[block.dataset.nodeId] = block.outerHTML;
            block.querySelectorAll('[data-type~="inline-math"]').forEach(span => {
                span.innerHTML = '<span class="katex"><span class="katex-html">α</span></span>';
            });
            if (index === 2) block.innerHTML = '<span class="katex"><span class="katex-html">β</span></span>';
        });
        const clone = raw.cloneNode(true);
        // listMindmap/view.ts preserves source identity before stripping writable identities.
        clone.querySelectorAll('.protyle-attr, .protyle-action, .protyle-icons').forEach(el => el.remove());
        clone.querySelectorAll('*').forEach(el => {
            if (el.hasAttribute('data-node-id')) {
                el.dataset.mindmapSourceId = el.dataset.nodeId;
                el.classList.add('mindmap-view__preview-block');
            }
            for (const name of ['data-node-id', 'contenteditable', 'spellcheck', 'draggable']) el.removeAttribute(name);
        });
        const root = list ? 'class="list" data-type="NodeList" data-subtype="u" custom-sy-list-mindmap="1"' : 'data-type="NodeMindmap"';
        const item = list ? 'class="li" data-type="NodeListItem" data-subtype="u"' : 'class="mindmap-item" data-type="NodeMindmapItem"';
        return {doms, html: '<div ' + root + ' data-node-id="mind" data-mindmap-view-rendered="true"><div ' + item +
            ' data-node-id="item">' + raw.innerHTML + '</div><div class="mindmap-view">' + clone.innerHTML + '</div></div>'};
    };
    const assertSources = hits => {
        assert.deepEqual(hits.map(hit => hit.blockId), ['p1', 'p1', 'p2', 'math']);
        assert.ok(hits.every(hit => hit.highlightKind === 'math-source' && !hit.replaceable));
        assert.ok(hits.every(hit => hit.range && visual.mathSourceFrameHost(hit.range)?.closest('.mindmap-view')));
    };
    const query = '\\\\(?:alpha|beta)';
    for (const list of [false, true]) {
        const map = fixture(list);
        wysiwyg.innerHTML = map.html;
        const snapshot = wysiwyg.innerHTML;
        const calls = apiCalls;
        const search = (text, more = {}) => calculateSearchMatches({}, edit, text, {...options, ...more});
        const found = await search(query, {regex: true});
        assertSources(found.matches);
        assert.equal((await search('α|β', {regex: true})).matches.length, 0, 'source mode excludes all glyph/MathML text');
        assert.equal((await search(query, {regex: true, includeMathBlock: false})).matches.length, 3);
        assert.equal((await search(query, {regex: true, includeParagraph: false})).matches.length, 1);
        assert.equal((await search(query, {regex: true, includeMindmap: false})).matches.length, 0);
        assert.equal((await search(query, {regex: true, restrictInlineTypes: ['inline-math']})).matches.length, 3);
        assert.equal((await search(query, {regex: true, resultBlockTypes: ['paragraph', 'mindmap']})).matches.length, 3);
        assert.equal((await search('before')).matches.length, 1, 'surrounding body remains searchable');
        const ordered = await search('before|\\\\alpha|middle|after', {regex: true});
        assert.deepEqual(ordered.matches.filter(hit => hit.blockId === 'p1').map(hit => hit.matchedText),
            ['before', '\\alpha', 'middle', '\\alpha', 'after']);
        const unitSources = collectSearchableBlocks(edit, options).filter(math.isMathSourceUnit);
        assert.equal(unitSources.length, 4, 'each formula is collected once');
        assert.ok(unitSources.every(unit => unit.textNodes.length === 0));
        const range = document.createRange(); range.selectNode(visual.mathSourceFrameHost(found.matches[2].range));
        window.getSelection().addRange(range);
        assert.equal((await search(query, {regex: true, selectionOnly: true})).matches.length, 1, 'canvas formula selection stays local');
        window.getSelection().removeAllRanges();
        assert.ok(found.matches.every(hit => SearchBar.prototype.rangeStillInMatchBlock.call({edit}, hit.range, hit)));
        assert.equal(apiCalls, calls, 'live source search has no additional API calls');
        assert.equal(wysiwyg.innerHTML, snapshot, 'search never mutates source or clone DOM');
        const glyphHits = (await search('α|β', {regex: true, searchMathSource: false})).matches;
        assert.deepEqual(glyphHits.map(hit => hit.blockId), ['p1', 'p1', 'p2', 'math'], 'native HTML-only glyphs counted once under their source owners');
        assert.ok(glyphHits.every(hit => hit.range && !hit.replaceable));
        const sourceUnits = collectSearchableBlocks(edit, options);
        const glyphUnits = collectSearchableBlocks(edit, {...options, searchMathSource: false});
        const formula = sourceUnits.find(unit => unit.blockId === 'p2' && math.isMathSourceUnit(unit));
        const scope = new Map([[unitKey(formula.blockId, formula.unitId), [{start: 0, end: formula.text.length}]]]);
        const glyphScope = selectionApi.remapMathSelectionScope(sourceUnits, glyphUnits, scope);
        assert.equal((await search('α', {searchMathSource: false, selectionOnly: true, selectionScope: glyphScope})).matches.length, 1,
            'switching a selected source formula to glyph mode preserves one formula');
        const roundtripScope = selectionApi.remapMathSelectionScope(glyphUnits, sourceUnits, glyphScope);
        assert.equal((await search(query, {regex: true, selectionOnly: true, selectionScope: roundtripScope})).matches.length, 1);
        assertSources((await search(query, {regex: true})).matches);
        assert.equal((await write.replaceAllMatchesInEditor(edit, found.matches, 'changed')).replacedCount, 0);
        assert.equal(apiCalls, calls, 'source formula replacements never reach write APIs');

        // A cold match must bind after the native renderer creates or rebuilds its clone.
        const hit = found.matches[2];
        const panel = {edit, searchMathSource: true, includeFoldedBlocks: true, resultMatches: [{...hit, range: undefined}],
            searchCollectOptions: () => options, queueRangeRepairBlock: () => {}, repairHighlightRanges: async () => {}};
        assert.equal(SearchBar.prototype.bindMindmapPreview.call(panel, 0), true);
        assert.ok(visual.mathSourceFrameHost(panel.resultMatches[0].range)?.closest('[data-mindmap-source-id="p2"]'));
        const blockPanel = {...panel, resultMatches: [{...found.matches[3], range: undefined}]};
        assert.equal(SearchBar.prototype.bindMindmapPreview.call(blockPanel, 0), true);
        assert.ok(visual.mathSourceFrameHost(blockPanel.resultMatches[0].range)?.matches('[data-mindmap-source-id="math"]'));
        const glyphPanel = {...panel, searchMathSource: false, resultMatches: [{...glyphHits[2], range: undefined}],
            searchCollectOptions: () => ({...options, searchMathSource: false})};
        assert.equal(SearchBar.prototype.bindMindmapPreview.call(glyphPanel, 0), true, 'glyphs also rebind via independent units');
        assert.ok(glyphPanel.resultMatches[0].range.startContainer.parentElement.closest('[data-mindmap-source-id="p2"]'));
        wysiwyg.querySelector('.mindmap-view').style.display = 'none';
        assert.equal((await search(query, {regex: true})).matches.length, 0, 'author-hidden clone does not leak formulas from its hidden source');
    }

    const map = fixture();
    const tabStyle = document.createElement('style');
    tabStyle.textContent = '.tab-item[data-tabs-hidden="true"]{display:none}';
    document.head.append(tabStyle);
    const tabs = (body, active = 'a') => '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" tabs-active-id="' + active + '">' +
        '<div class="tab-item" data-type="NodeTabItem" data-node-id="a" data-tabs-hidden="' + (active !== 'a') + '"></div>' +
        '<div class="tab-item" data-type="NodeTabItem" data-node-id="b" data-tabs-hidden="' + (active !== 'b') + '">' + body + '</div></div>';
    for (const active of ['a', 'b']) {
        wysiwyg.innerHTML = tabs(map.html, active);
        const found = await calculateSearchMatches({}, edit, query, {...options, regex: true});
        assert.deepEqual(found.matches.map(hit => hit.blockId), ['p1', 'p1', 'p2', 'math'], 'inactive tab keeps all mindmap source formulas');
        for (const searchMathSource of [false, true]) {
            const text = searchMathSource ? query : 'α|β';
            assert.equal((await calculateSearchMatches({}, edit, text, {...options, regex: true, searchMathSource, includeTabs: false})).matches.length, 0,
                'DOM fallback attribute and preview units respect the tabs gate');
            assert.equal((await calculateSearchMatches({}, edit, 'before', {...options, includeTabs: false})).matches.length, 0);
        }
    }
    wysiwyg.innerHTML = tabs(map.html);
    wysiwyg.querySelector('[data-node-id="tabs"]').setAttribute('fold', '1');
    assert.equal((await calculateSearchMatches({}, edit, query, {...options, regex: true, includeFoldedBlocks: false})).matches.length, 0);
    wysiwyg.innerHTML = tabs('<div style="display:none">' + map.html + '</div>');
    assert.equal((await calculateSearchMatches({}, edit, query, {...options, regex: true})).matches.length, 0, 'author-hidden formulas stay excluded in inactive tabs');
    wysiwyg.innerHTML = tabs(tabs(map.html, 'b'));
    assert.equal((await calculateSearchMatches({}, edit, query, {...options, regex: true})).matches.length, 4, 'active inner tab preserves formulas under an inactive outer tab');
    wysiwyg.querySelector('.mindmap-view').setAttribute('hidden', '');
    assert.equal((await calculateSearchMatches({}, edit, query, {...options, regex: true})).matches.length, 0, 'a hard hidden preview is not a native inactive tab');
    wysiwyg.innerHTML = tabs('<div data-type="NodeParagraph" data-node-id="memo"><div contenteditable="true"><span data-type="inline-memo" data-inline-memo-content="memo-word">word</span></div></div>', 'b');
    assert.equal((await calculateSearchMatches({}, edit, 'memo-word', {...options, includeInlineMemo: true})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, 'memo-word', {...options, includeInlineMemo: true, includeTabs: false})).matches.length, 0,
        'memo attributes share the same tabs gate');
    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run('mind', 'root', 'root', 'mindmap', '', '', '', '', 'hm', '1');
    insert.run('item', 'root', 'mind', 'mindmap_item', '', '', '', '', 'hi', '1');
    for (const [id, dom] of Object.entries(map.doms)) insert.run(id, 'root', 'item', id === 'math' ? 'm' : 'p', '',
        id === 'math' ? '\\beta' : 'before \\alpha middle \\alpha after', lute.BlockDOM2StdMd(dom), '', 'h' + id, '1');
    responder = async (url, payload) => url === '/api/query/sql' ? {code: 0, data: db.prepare(payload.stmt).all()} :
        url === '/api/block/getDocBlocksOrders' ? {code: 0, data: ['mind', 'item', ...Object.keys(map.doms)]} :
        url === '/api/block/getBlockDOMs' ? {code: 0, data: map.doms} : {code: -1};
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    try {
        for (const mounted of [false, true, false, true]) {
            wysiwyg.innerHTML = mounted ? map.html : '';
            corpus.invalidateDocumentSearchCaches();
            const found = await corpus.searchCurrentDocument({}, edit, query, {...options, regex: true});
            assert.equal(found.partial, false);
            assert.deepEqual(found.matches.map(hit => hit.blockId), ['p1', 'p1', 'p2', 'math']);
            if (mounted) assertSources(found.matches);
            assert.equal((await corpus.searchCurrentDocument({}, edit, 'α|β', {...options, regex: true})).matches.length, 0);
        }
        insert.run('tabs', 'root', 'root', 'tabs', '', '', '', '', 'ht', '1');
        insert.run('a', 'root', 'tabs', 'tab_item', '', '', '', '', 'ha', '1');
        insert.run('b', 'root', 'tabs', 'tab_item', '', '', '', '', 'hb', '1');
        db.exec("UPDATE blocks SET parent_id='b' WHERE id='mind'");
        for (const mounted of [false, true]) {
            wysiwyg.innerHTML = mounted ? tabs(map.html) : '';
            corpus.invalidateDocumentSearchCaches();
            const found = await corpus.searchCurrentDocument({}, edit, query, {...options, regex: true});
            assert.equal(found.partial, false);
            assert.deepEqual(found.matches.map(hit => hit.blockId), ['p1', 'p1', 'p2', 'math'], 'inactive mounted/cold corpus stays complete');
        }
    } finally { db.close(); editors = []; responder = async () => ({code: -1}); tabStyle.remove(); }

    // Displayed copies in different embeds stay separate and readonly.
    wysiwyg.innerHTML = ['e1', 'e2'].map(id => '<div data-type="NodeBlockQueryEmbed" data-node-id="' + id + '">' + map.html + '</div>').join('');
    const embedded = await calculateSearchMatches({}, edit, query, {...options, regex: true});
    assert.equal(embedded.matches.length, 8);
    assert.deepEqual(embedded.matches.map(hit => hit.blockId), [...Array(4).fill('e1'), ...Array(4).fill('e2')]);
    assert.ok(embedded.matches.every(hit => hit.range && !hit.replaceable && hit.highlightKind === 'math-source'));

    // A query may display a superblock and its child mindmap in the same embed.
    const repeated = html => '<div data-type="NodeBlockQueryEmbed" data-node-id="embed">' +
        '<div class="protyle-wysiwyg__embed"><div data-type="NodeSuperBlock" data-node-id="outer">' + html + '</div></div>' +
        '<div class="protyle-wysiwyg__embed">' + html + '</div></div>';
    wysiwyg.innerHTML = repeated(map.html);
    const copies = await calculateSearchMatches({}, edit, query, {...options, regex: true});
    assert.equal(copies.matches.length, 8, 'two displayed copies within one embed must not collapse');
    assert.equal(new Set(copies.matches.map(hit => hit.unitId)).size, 8);
    assert.equal((await calculateSearchMatches({}, edit, 'α|β', {...options, searchMathSource: false, regex: true})).matches.length, 8);
    assert.equal((await calculateSearchMatches({}, edit, 'before', options)).matches.length, 2);
    const coldMap = '<div data-type="NodeMindmap" data-node-id="mind"><div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' +
        Object.values(map.doms).join('') + '</div></div>';
    const extracted = await source('frontend/corpus/extract').extractUnitsFromDoms(['embed'], {embed: repeated(coldMap)}, options, new Set(['embed']), 'light');
    try {
        assert.deepEqual(copies.matches.map(hit => hit.unitId).sort(), extracted.blocks.filter(math.isMathSourceUnit).map(unit => unit.unitId).sort(),
            'mounted clone IDs match the cold source instances');
    } finally { extracted.dispose(); }
    const copiedHit = copies.matches.find(hit => hit.unitId.includes('p2@1'));
    assert.ok(copiedHit);
    const copiedPanel = {edit, searchMathSource: true, includeFoldedBlocks: true, resultMatches: [{...copiedHit, range: undefined}],
        searchCollectOptions: () => options, queueRangeRepairBlock: () => {}, repairHighlightRanges: async () => {}};
    assert.equal(SearchBar.prototype.bindMindmapPreview.call(copiedPanel, 0), true);
    assert.equal(copiedPanel.resultMatches[0].range.startContainer.closest('.protyle-wysiwyg__embed'), wysiwyg.querySelectorAll('.protyle-wysiwyg__embed')[1],
        'local repair binds the second displayed copy rather than the first');
    const sourceCopies = collectSearchableBlocks(edit, options);
    const glyphCopies = collectSearchableBlocks(edit, {...options, searchMathSource: false});
    const copyUnit = sourceCopies.find(unit => unit.unitId === copiedHit.unitId);
    const copyScope = new Map([[unitKey(copyUnit.blockId, copyUnit.unitId), [{start: 0, end: copyUnit.text.length}]]]);
    const copyGlyphScope = selectionApi.remapMathSelectionScope(sourceCopies, glyphCopies, copyScope);
    const selectedCopy = await calculateSearchMatches({}, edit, 'α', {...options, searchMathSource: false, selectionOnly: true, selectionScope: copyGlyphScope});
    assert.equal(selectedCopy.matches.length, 1, 'mode switches preserve the selected displayed copy');
    const sourceOf = source('frontend/embedded-order').createEmbeddedSourceReader();
    const originalQuery = window.Element.prototype.querySelectorAll;
    let identityScans = 0;
    window.Element.prototype.querySelectorAll = function(selector) {
        if (selector === '[data-node-id][data-type]') identityScans++;
        return originalQuery.call(this, selector);
    };
    try {
        const retained = collectSearchableBlocks(edit, {...options, preserveEmbedSourceIds: true}).filter(math.isMathSourceUnit);
        identityScans = 0;
        for (let repeat = 0; repeat < 200; repeat++) {
            for (const unit of retained.slice().reverse()) {
                assert.equal(sourceOf(unit.element, unit.blockId), unit.embeddedSourceId);
            }
        }
        assert.equal(identityScans, 3, 'one owner scan and one source scan per displayed canvas, independent of hit count');
    } finally { window.Element.prototype.querySelectorAll = originalQuery; }

    const embedDb = new DatabaseSync(':memory:');
    embedDb.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    embedDb.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    embedDb.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    embedDb.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)').run('embed', 'root', 'root', 'query_embed', '', 'select * from blocks', '', '', 'he', '1');
    const queryDOM = '<div data-type="NodeBlockQueryEmbed" data-node-id="embed" data-content="select * from blocks"></div>';
    responder = async (url, payload) => url === '/api/query/sql' ? {code: 0, data: embedDb.prepare(payload.stmt).all()} :
        url === '/api/block/getDocBlocksOrders' ? {code: 0, data: ['embed']} :
        url === '/api/block/getBlockDOMs' ? {code: 0, data: {embed: queryDOM}} :
        url === '/api/search/searchEmbedBlock' ? {code: 0, data: {blocks: [
            {block: {id: 'outer', content: '<div data-type="NodeSuperBlock" data-node-id="outer">' + coldMap + '</div>'}},
            {block: {id: 'mind', content: coldMap}},
        ]}} : {code: -1};
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    try {
        for (const mounted of [false, true, false]) {
            wysiwyg.innerHTML = mounted ? repeated(map.html) : '';
            corpus.invalidateDocumentSearchCaches();
            const found = await corpus.searchCurrentDocument({}, edit, query, {...options, regex: true});
            assert.equal(found.partial, false);
            assert.equal(found.matches.length, 8, 'native embed query and mounted copies agree');
            assert.deepEqual(found.matches.map(hit => hit.unitId).sort(), copies.matches.map(hit => hit.unitId).sort());
        }
    } finally { embedDb.close(); editors = []; responder = async () => ({code: -1}); }

    // Plain and rich table cells retain table ownership/coordinates in the canvas.
    const richSource = 'cell $\\alpha$ tail\n\n$$\n\\beta\n$$';
    const encoded = Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content: richSource})).toString('base64url');
    const table = document.createElement('div');
    table.innerHTML = '<div data-type="NodeTable" data-node-id="table"><table><tbody><tr><td>' +
        lute.BlockDOM2HTML(lute.Md2BlockDOM('$\\alpha$')) + '</td><td data-sy-table-cell-rich="' + encoded + '">' +
        '<div class="table__cell-rich">' + lute.Md2BlockDOM(richSource) + '</div></td></tr></tbody></table></div>';
    table.querySelectorAll('.table__cell-rich *').forEach(el => {
        el.removeAttribute('data-node-id');
        if (el.hasAttribute('data-type')) el.setAttribute('data-table-cell-node', '');
    });
    table.querySelectorAll('[data-subtype="math"]').forEach(el => {
        el.innerHTML = '<span class="katex-html">' + (el.dataset.type === 'NodeMathBlock' ? 'β' : 'α') + '</span>';
    });
    const tableClone = table.cloneNode(true);
    tableClone.querySelectorAll('*').forEach(el => {
        if (el.hasAttribute('data-node-id')) { el.dataset.mindmapSourceId = el.dataset.nodeId; el.classList.add('mindmap-view__preview-block'); }
        for (const name of ['data-node-id', 'contenteditable', 'spellcheck']) el.removeAttribute(name);
    });
    wysiwyg.innerHTML = '<div data-type="NodeMindmap" data-node-id="mind" data-mindmap-view-rendered="true"><div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' +
        table.innerHTML + '</div><div class="mindmap-view">' + tableClone.innerHTML + '</div></div>';
    const cells = await calculateSearchMatches({}, edit, query, {...options, regex: true});
    assert.equal(cells.matches.length, 3);
    assert.ok(cells.matches.every(hit => hit.blockId === 'table' && hit.highlightKind === 'math-source' && !hit.replaceable &&
        visual.mathSourceFrameHost(hit.range)?.closest('.mindmap-view')));
    const inlineCells = collectSearchableBlocks(edit, options).filter(unit => unit.matchSource === 'inline-math');
    assert.deepEqual(inlineCells.map(unit => unit.tableSlot.column), [0, 1]);
    assert.equal((await calculateSearchMatches({}, edit, query, {...options, regex: true, includeTable: false})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, 'α|β', {...options, regex: true})).matches.length, 0);

    // Nested canvases are searched/bound once and keep the inner source block identity.
    const nested = document.createElement('div'); nested.innerHTML = map.html;
    nested.querySelectorAll('[data-node-id], [data-mindmap-source-id]').forEach(el => {
        for (const name of ['data-node-id', 'data-mindmap-source-id']) if (el.hasAttribute(name)) el.setAttribute(name, 'nested-' + el.getAttribute(name));
    });
    wysiwyg.innerHTML = '<div data-type="NodeMindmap" data-node-id="outer" data-mindmap-view-rendered="true"><div class="mindmap-view">' + nested.innerHTML + '</div></div>';
    const nestedHits = await calculateSearchMatches({}, edit, query, {...options, regex: true});
    assert.equal(nestedHits.matches.length, 4);
    const nestedHit = nestedHits.matches.find(hit => hit.blockId === 'nested-p2');
    assert.ok(nestedHit);
    const nestedPanel = {edit, searchMathSource: true, includeFoldedBlocks: true, resultMatches: [{...nestedHit, range: undefined}],
        searchCollectOptions: () => options, queueRangeRepairBlock: () => {}, repairHighlightRanges: async () => {}};
    assert.equal(SearchBar.prototype.bindMindmapPreview.call(nestedPanel, 0), true);
    assert.ok(visual.mathSourceFrameHost(nestedPanel.resultMatches[0].range)?.closest('[data-mindmap-source-id="nested-p2"]'));
    style.remove();
    window.Element.prototype.getClientRects = nativeRects;
    console.log('Mindmap math: native/list clones, glyph/source counts and selection, inactive/nested tabs, author hiding, readonly frames, cold/live repeated embeds, local binding and bounded identity scans OK');
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
