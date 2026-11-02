// Native Lute fixtures and isolated APIs; never reads or edits a real notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
const setup = 'const renderers = {};\n' + harness.slice(0, harness.indexOf('async function main()')).replace(
    'getAllEditor: () => editors,', 'ProtyleMethod: renderers, getAllEditor: () => editors,');
async function main() {
    const math = source('shared/math-search');
    const extract = source('frontend/corpus/extract');
    const av = source('frontend/corpus/av');
    const avLive = source('shared/av-live');
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL', 'HTMLTag2TextMark', 'DataTask']) lute['Set' + name](true);
    const md = 'before $\\alpha+\\frac{a}{b}$ after\n\n$$\n\\alpha+\\frac{a}{b}\n$$';
    const fakeRender = root => root.querySelectorAll('[data-subtype="math"]').forEach(el => {
        el.innerHTML = '<span class="katex"><span class="katex-html">αab</span><span class="katex-mathml">duplicate</span></span>';
        el.setAttribute('data-render', 'true');
    });
    wysiwyg.innerHTML = lute.Md2BlockDOM(md);
    fakeRender(wysiwyg);
    const original = wysiwyg.innerHTML;
    assert.equal((await calculateSearchMatches({}, edit, 'α')).matches.length, 2);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha')).matches.length, 0);
    const options = {searchMathSource: true};
    const scopeApi = source('frontend/selection');
    const found = await calculateSearchMatches({}, edit, '\\alpha', options);
    assert.equal(found.matches.length, 2);
    assert.ok(found.matches.every(hit => hit.highlightKind === 'math-source' && !hit.replaceable && hit.range));
    for (const hit of found.matches) {
        assert.equal(SearchBar.prototype.rangeStillInMatchBlock.call({edit}, hit.range, hit), true, 'selected formula Range remains valid for navigation');
        assert.equal(write.isMatchContentWritable({...hit, replaceable: true}), false);
    }
    assert.equal((await calculateSearchMatches({}, edit, 'α', options)).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, '\\\\(?:alpha|frac)', {...options, regex: true})).matches.length, 4);
    const units = collectSearchableBlocks(edit, options);
    for (const unit of units.filter(math.isMathSourceUnit)) {
        assert.equal(unit.text, '\\alpha+\\frac{a}{b}');
        assert.equal(unit.textNodes.length, 0);
        assert.equal(freezeBlock(unit).highlightKind, 'math-source');
    }
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, includeMathBlock: false})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, restrictInlineTypes: ['inline-math']})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, 'before', options)).matches.length, 1);
    assert.equal(wysiwyg.innerHTML, original);
    const calls = apiCalls;
    for (const hit of found.matches) assert.equal((await write.replaceCurrentMatchInEditor(edit, {...hit, replaceable: true}, 'changed')).replacedCount, 0);
    assert.equal((await write.replaceAllMatchesInEditor(edit, found.matches, 'changed')).replacedCount, 0);
    assert.equal(apiCalls, calls, 'source matches do not reach write APIs');
    const range = document.createRange(); range.selectNode(wysiwyg.querySelector('[data-type="NodeMathBlock"]'));
    window.getSelection().addRange(range);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, selectionOnly: true})).matches.length, 1);
    window.getSelection().removeAllRanges();
    const visibleUnits = collectSearchableBlocks(edit);
    const selectedUnit = visibleUnits.find(u => u.matchSource === 'inline-math');
    const frozen = new Map([[unitKey(selectedUnit.blockId, selectedUnit.unitId), [{start: 0, end: selectedUnit.text.length}]]]);
    const rebound = scopeApi.remapMathSelectionScope(visibleUnits, units, frozen);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, selectionOnly: true, selectionScope: rebound})).matches.length, 1);
    const reverse = scopeApi.remapMathSelectionScope(units, visibleUnits, rebound);
    assert.deepEqual(reverse, frozen, 'mode switching preserves the frozen formula host without broadening selection');
    const enumerated = await calculateSearchMatches({}, edit, '', {...options, restrictInlineTypes: ['inline-math']});
    assert.equal(enumerated.matches.length, 1);
    assert.equal(enumerated.matches[0].highlightKind, 'math-source');
    content.getBoundingClientRect = () => rect(0, 0, 600, 400);
    for (const [i, hit] of found.matches.entries()) {
        const el = hit.range.startContainer.childNodes[hit.range.startOffset];
        el.getBoundingClientRect = () => rect(30, 50 + i * 80, 80, 30);
    }
    visual.applyCodeLanguageVisual(edit, found.matches.map(hit => hit.range), found.matches[0].range);
    assert.equal(edit.querySelectorAll('.page-search-code-language-frame').length, 2);
    assert.equal(edit.querySelectorAll('.page-search-code-language-frame.is-focus').length, 1);
    visual.clearCodeLanguageVisual(edit);
    wysiwyg.innerHTML = lute.Md2BlockDOM(Array.from({length: 250}, () => 'before $\\alpha$ after').join('\n\n'));
    fakeRender(wysiwyg);
    const manyVisible = collectSearchableBlocks(edit);
    const manySource = collectSearchableBlocks(edit, options);
    const manyScope = new Map(manyVisible.filter(unit => unit.matchSource === 'inline-math').map(unit =>
        [unitKey(unit.blockId, unit.unitId), [{start: 0, end: unit.text.length}]]));
    const intersects = window.Range.prototype.intersectsNode;
    let intersectionChecks = 0;
    window.Range.prototype.intersectsNode = function(node) { intersectionChecks++; return intersects.call(this, node); };
    try {
        const mapped = scopeApi.remapMathSelectionScope(manyVisible, manySource, manyScope);
        assert.equal(mapped.size, 250);
        assert.ok(intersectionChecks <= 500, 'large formula selections map locally without quadratic Range comparisons');
    } finally { window.Range.prototype.intersectsNode = intersects; }
    wysiwyg.innerHTML = lute.Md2BlockDOM('$a < b + c & d$');
    assert.equal(collectSearchableBlocks(edit, options).find(math.isMathSourceUnit).text, 'a < b + c & d', 'decode entities exactly once like native mathRender');
    wysiwyg.innerHTML = '<div class="tabs" data-type="NodeTabs" data-node-id="tabs" tabs-active-id="one">' +
        '<div class="tab-item" data-node-id="one" data-type="NodeTabItem"></div>' +
        '<div class="tab-item" data-node-id="two" data-type="NodeTabItem">' + original + '</div></div>';
    const style = document.createElement('style');
    style.textContent = '.tabs > .tab-item[data-tabs-hidden="true"] {display:none} .tabs[fold="1"] > .tab-item {display:none}';
    document.head.append(style);
    for (const hidden of [false, true]) {
        if (hidden) wysiwyg.querySelector('[data-node-id="two"]').dataset.tabsHidden = 'true';
        assert.equal((await calculateSearchMatches({}, edit, '\\alpha', options)).matches.length, 2, 'nonactive tabs ' + hidden + ' ' + JSON.stringify(collectSearchableBlocks(edit, options).map(u => [u.unitId, u.text])));
    }
    wysiwyg.firstElementChild.setAttribute('fold', '1');
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, includeFoldedBlocks: true})).matches.length, 2);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, includeFoldedBlocks: false})).matches.length, 0);
    wysiwyg.firstElementChild.style.display = 'none';
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, includeFoldedBlocks: true})).matches.length, 0, 'author hiding stays excluded');
    style.remove();

    let renders = 0;
    renderers.mathRender = root => { renders++; fakeRender(root); };
    const cold = lute.Md2BlockDOM(md);
    const box = document.createElement('div'); box.innerHTML = cold;
    const doms = Object.fromEntries(Array.from(box.children).map(el => [el.dataset.nodeId, el.outerHTML]));
    const ids = Object.keys(doms);
    let read = await extract.extractUnitsFromDoms(ids, doms, options, new Set(), 'light');
    try {
        assert.equal(renders, 0, 'source extraction never loads or waits for KaTeX');
        assert.deepEqual(read.unrenderedIds, []);
        assert.equal(read.blocks.filter(math.isMathSourceUnit).length, 2);
    } finally { read.dispose(); }
    read = await extract.extractUnitsFromDoms(ids, doms, {}, new Set(), 'light');
    try { assert.ok(renders > 0); assert.equal(read.blocks.filter(math.isMathSourceUnit).length, 0); }
    finally { read.dispose(); }
    const embeds = Object.fromEntries(['embed1', 'embed2'].map(id => [id,
        '<div data-type="NodeBlockQueryEmbed" data-node-id="' + id + '">' + cold + '</div>']));
    read = await extract.extractUnitsFromDoms(Object.keys(embeds), embeds, options, new Set(Object.keys(embeds)), 'light');
    try {
        const formulas = read.blocks.filter(math.isMathSourceUnit);
        assert.equal(formulas.length, 4, 'each embed retains its source formula identities');
        assert.ok(formulas.every(u => freezeBlock(u).highlightKind === 'math-source'));
        assert.deepEqual(read.unrenderedIds, []);
    } finally { read.dispose(); }

    // Repeated formulas in different cells retain separate units and selection identities.
    const richSource = 'before $\\alpha$\n\n$$\n\\alpha\n$$\n\nafter';
    const encode = text => Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content: text})).toString('base64url');
    const richHtml = lute.BlockDOM2HTML(lute.Md2BlockDOM(richSource));
    wysiwyg.innerHTML = '<div data-type="NodeTable" data-node-id="table"><table><tbody><tr>' +
        [0, 1].map(() => '<td data-sy-table-cell-rich="' + encode(richSource) + '">' + richHtml + '</td>').join('') + '</tr></tbody></table></div>';
    const richHits = await calculateSearchMatches({}, edit, '\\alpha', options);
    assert.equal(richHits.matches.length, 4, JSON.stringify({html: richHtml, units: collectSearchableBlocks(edit, options).map(u => [u.unitId, u.text])}));
    assert.ok(richHits.matches.every(hit => !hit.replaceable && hit.range && hit.highlightKind === 'math-source'));

    // Both loaded native rich cells and unloaded API previews use exact cell/formula aliases.
    const avId = 'db';
    const avMarkdown = 'before $\\alpha$ after\n\n$$\n\\alpha\n$$';
    const avHtml = lute.BlockDOM2HTML(lute.Md2BlockDOM(avMarkdown));
    const ref = {blockId: avId, avId: 'data', updated: '1', carrierViewId: 'view', searchMathSource: true};
    responder = async url => url === '/api/av/getAttributeView' ? {code: 0, data: {name: '', views: [{id: 'view', name: ''}]}} :
        url === '/api/av/renderAttributeView' ? {code: 0, data: {viewType: 'table', view: {
            id: 'view', rowCount: 1, columns: [{id: 'col', name: 'Field', type: 'template'}],
            rows: [{id: 'row', cells: [{keyID: 'col', type: 'template', template: {
                content: avHtml,
            }}]}],
        }}} : {code: -1};
    const apiUnits = await av.loadAvUnits([ref]);
    const apiMath = apiUnits.filter(math.isMathSourceUnit);
    assert.equal(apiMath.length, 2, 'API preview includes inline and block formula sources');
    assert.equal(apiMath[0].text, '\\alpha');
    assert.equal(av.peekAvUnits([{...ref, searchMathSource: false}]).missing.length, 1, 'AV caches isolate modes');
    wysiwyg.innerHTML = '<div data-type="NodeAttributeView" data-node-id="db"><div class="av__body"><div class="av__row" data-id="row">' +
        '<div class="av__cell" data-col-id="col">' + avHtml + '</div></div></div></div>';
    // Native prepareAVRichTextPreviewHTML turns static math into render nodes.
    wysiwyg.querySelectorAll('div.language-math').forEach(el => {
        el.dataset.content = el.textContent; el.dataset.subtype = 'math';
        el.className = 'render-node'; el.innerHTML = '<div></div>';
    });
    fakeRender(wysiwyg);
    const avUnits = collectSearchableBlocks(edit, options);
    const liveMath = avUnits.filter(math.isMathSourceUnit);
    assert.equal(liveMath.length, 2);
    for (const unit of liveMath) {
        const apiUnit = apiMath.find(other => other.unitId === avLive.avApiUnitId(unit.unitId));
        assert.ok(apiUnit); assert.equal(apiUnit.text, unit.text);
        const hit = project.projectRanges(edit, [{id: 'a', ...apiUnit, start: 0, end: 6, matchedText: '\\alpha', replaceable: false,
            highlightKind: 'math-source'}], options, avUnits)[0];
        assert.equal(hit.range?.startContainer.nodeType, 1);
        assert.equal(visual.mathSourceFrameHost(hit.range), unit.element);
    }
    assert.equal((await calculateSearchMatches({}, edit, 'α', options)).matches.length, 0, 'source mode excludes AV block and inline glyphs');
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, includeMathBlock: false})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, restrictInlineTypes: ['inline-math']})).matches.length, 1);
    const avGlyphUnits = collectSearchableBlocks(edit);
    const avGlyph = avGlyphUnits.find(unit => unit.textNodes.length && unit.text.includes('α'));
    assert.ok(avGlyph);
    const glyphStart = avGlyph.text.indexOf('α');
    const avFrozen = new Map([[unitKey(avGlyph.blockId, avGlyph.unitId), [{start: glyphStart, end: glyphStart + 1}]]]);
    const avMapped = scopeApi.remapMathSelectionScope(avGlyphUnits, avUnits, avFrozen);
    assert.equal((await calculateSearchMatches({}, edit, '\\alpha', {...options, selectionOnly: true, selectionScope: avMapped})).matches.length, 1,
        'selected AV inline glyph becomes only its source formula');
    const avReverse = scopeApi.remapMathSelectionScope(avUnits, avGlyphUnits, avMapped);
    assert.equal((await calculateSearchMatches({}, edit, 'α', {selectionOnly: true, selectionScope: avReverse})).matches.length, 1);
    assert.equal((await calculateSearchMatches({}, edit, 'before', {selectionOnly: true, selectionScope: avReverse})).matches.length, 0,
        'AV formula selection never expands to surrounding cell text');
    const cov = avLive.collectAvDomCoverage(avUnits).get('db');
    assert.equal(avLive.avApiUnitShown(apiMath[0].unitId, apiMath[0].text, cov, new Set()), true);
    assert.equal(avLive.avApiUnitInView(apiMath[0].unitId, cov, 'table'), true);
    assert.equal(avLive.avApiUnitShown(apiMath[1].unitId, apiMath[1].text, cov, new Set()), true);
    const avResponder = responder;
    const liveAv = wysiwyg.innerHTML;
    av.invalidateAvCache();

    // Cold/loaded/folded corpus and switching back must not reuse the other representation.
    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)');
    ids.forEach((id, i) => insert.run(id, 'root', 'root', i ? 'm' : 'p', '', 'αab', i ? '\\alpha+\\frac{a}{b}' : '$\\alpha+\\frac{a}{b}$', '', 'hash', '1'));
    responder = async (url, body) => {
        if (url === '/api/query/sql') return {code: 0, data: db.prepare(body.stmt).all()};
        if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: ids};
        if (url === '/api/block/getBlockDOMs') return {code: 0, data: doms};
        return {code: -1};
    };
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    wysiwyg.innerHTML = '';
    corpus.invalidateDocumentSearchCaches();
    const search = (query, more = {}) => corpus.searchCurrentDocument({}, edit, query, {includeAttributeView: false, includeFoldedBlocks: true, ...more});
    renders = 0;
    let result = await search('\\alpha', options);
    assert.equal(result.matches.length, 2); assert.equal(result.unrendered, 0); assert.equal(result.partial, false);
    assert.equal(renders, 0);
    assert.ok(result.matches.every(hit => !hit.replaceable && hit.highlightKind === 'math-source'));
    assert.equal((await search('α')).matches.length, 2);
    assert.equal((await search('\\alpha', options)).matches.length, 2);
    wysiwyg.innerHTML = cold; fakeRender(wysiwyg);
    result = await search('\\alpha', options);
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every(hit => hit.range && hit.highlightKind === 'math-source'));
    wysiwyg.firstElementChild.setAttribute('fold', '1');
    assert.equal((await search('\\alpha', options)).matches.length, 2);
    const avShell = '<div data-type="NodeAttributeView" data-node-id="db" data-av-id="data" custom-sy-av-view="view" data-av-type="table"><div></div></div>';
    insert.run('db', 'root', 'root', 'av', '', '', avShell, '', 'av-hash', '1');
    doms.db = avShell;
    const documentResponder = responder;
    responder = async (url, body) => url.startsWith('/api/av/') ? avResponder(url, body) :
        url === '/api/block/getDocBlocksOrders' ? {code: 0, data: [...ids, 'db']} : documentResponder(url, body);
    corpus.invalidateDocumentSearchCaches();
    corpus.retainBackgroundCorpusRoot('root');
    try {
        for (const mounted of [false, true]) {
            wysiwyg.innerHTML = mounted ? cold + liveAv.replace('data-node-id="db"',
                'data-node-id="db" data-av-id="data" custom-sy-av-view="view" data-av-type="table"') : '';
            for (const includeMathBlock of [true, false]) {
                const more = {...options, includeAttributeView: true, includeMathBlock};
                const until = Date.now() + 3000;
                let indexed = await search('\\alpha', more);
                while (indexed.partial && Date.now() < until) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    indexed = await search('\\alpha', more);
                }
                assert.equal(indexed.partial, false, 'full-document AV source indexing settles');
                assert.equal(indexed.matches.length, includeMathBlock ? 4 : 2, 'cold/live AV and block-math gate: ' + mounted);
                assert.ok(indexed.matches.every(hit => hit.highlightKind === 'math-source' && !hit.replaceable));
                if (mounted) assert.ok(indexed.matches.every(hit => hit.range), 'loaded AV sources bind without duplication');
            }
        }
    } finally {
        av.releaseAvCacheOwner('root', edit);
        corpus.releaseBackgroundCorpusRoot('root');
    }
    db.close(); editors = [];
    assert.equal(prefs.DEFAULT_PREFS.searchMathSource, false);
    assert.equal(prefs.coercePluginPrefs({searchMathSource: 'true'}).searchMathSource, false);
    assert.equal(prefs.mergePrefs(prefs.DEFAULT_PREFS, {searchMathSource: true}).searchMathSource, true);
    let refreshes = 0;
    const panel = {searchMathSource: false, selectionOnly: false, searchText: '\\alpha',
        setOpenMenuSwitch: () => {}, highlightHitResult: () => {refreshes++; return Promise.resolve();}};
    SearchBar.prototype.applySearchMathSource.call(panel, true);
    SearchBar.prototype.applySearchMathSource.call(panel, true);
    assert.equal(refreshes, 1, 'panel sync only refreshes when mode changes');
    console.log('Math source: native TeX/glyph isolation, literal/regex, frames, readonly, selection, rich tables, AV aliases/cache, unloaded/loaded corpus and render-free source mode OK');
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(setup + '\n' + main.toString() + '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
