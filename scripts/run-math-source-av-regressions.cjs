// Read-only fixtures for source-math AV identity, visibility and native reading order.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    const opt = {searchMathSource: true, includeFoldedBlocks: true, includeImageOCR: false};
    const av = source('frontend/corpus/av');
    const avLive = source('shared/av-live');
    const anchors = source('frontend/match-anchor');
    const isSource = source('shared/math-search').isMathSourceUnit;
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL', 'HTMLTag2TextMark', 'DataTask']) lute['Set' + name](true);
    const preview = lute.BlockDOM2HTML(lute.Md2BlockDOM('before $\\alpha$ middle $\\alpha$ after\n\n$$\n\\beta\n$$\n\ntail'));
    const nativePreview = () => {
        const root = document.createElement('div'); root.innerHTML = preview;
        root.querySelectorAll('div.language-math').forEach(el => {
            el.dataset.content = el.textContent; el.dataset.subtype = 'math';
            el.className = 'render-node'; el.innerHTML = '<div class="katex-html">β</div>';
        });
        root.querySelectorAll('[data-type~="inline-math"]').forEach(el => { el.innerHTML = '<span class="katex-html">α</span>'; });
        return root.innerHTML;
    };
    const shell = (html = '', type = 'table', id = 'db') =>
        '<div class="av" data-type="NodeAttributeView" data-node-id="' + id + '" data-av-id="data" custom-sy-av-view="view" data-av-type="' + type + '">' + html + '</div>';
    const row = (id, cols = ['col'], type = 'table') => '<div class="' + (type === 'table' ? 'av__row' :
        type === 'calendar' ? 'av__calendar-item' : 'av__gallery-item') + '" data-id="' + id + '">' + cols.map(col =>
        '<div class="' + (type === 'calendar' ? 'av__calendar-field' : 'av__cell') + '" data-col-id="' + col + '">' +
        nativePreview() + '</div>').join('') + '</div>';
    const body = (rows, group = '', folded = false) => '<div class="av__body' + (folded ? ' fn__none' : '') + '"' +
        (group ? ' data-group-id="' + group + '"' : '') + '>' + rows + '</div>';
    const group = (id, rows, folded = false) => '<div class="av__group-title"><button data-type="av-group-fold" data-id="' + id +
        '"><svg></svg></button><span class="av__group-name">' + id + '</span></div>' + body(rows, id, folded);
    const host = match => match.range && visual.mathSourceFrameHost(match.range);
    const liveKey = match => avLive.avApiUnitId(match.unitId);
    wysiwyg.innerHTML = shell(group('g1', row('r0', ['c1', 'c2']) + row('r1', ['c1', 'c2'])) +
        group('g2', row('r0', ['c1', 'c2']) + row('r1', ['c1', 'c2'])));
    const initial = (await calculateSearchMatches({}, edit, '\\alpha', opt)).matches;
    assert.equal(initial.length, 16);
    const originalHosts = new Map(initial.map(hit => [liveKey(hit), host(hit)]));
    wysiwyg.querySelector('[data-group-id="g1"] [data-id="r0"]').remove();
    const live = collectSearchableBlocks(edit, opt);
    const projected = project.projectRanges(edit, initial, opt, live);
    const rebound = project.fillLiveRanges(initial.map(hit => ({...hit, range: undefined})), live, true);
    for (const matches of [projected, rebound]) for (const hit of matches) {
        const original = originalHosts.get(liveKey(hit));
        assert.equal(host(hit), original.isConnected ? original : undefined, 'unmounted row never borrows another formula');
    }
    const next = (await calculateSearchMatches({}, edit, '\\alpha', opt)).matches;
    const previous = initial.find(hit => hit.unitId.includes(':g2:r1:c2:') && hit.unitId.endsWith(':1'));
    const retained = anchors.resolveRetainedMatchIndex(next, previous, 1, {previousMatches: initial});
    assert.equal(liveKey(next[retained - 1]), liveKey(previous), 'current formula survives ordinal changes in other rows/cells/groups');
    const apiPrevious = {...previous, unitId: liveKey(previous), range: undefined, mathOrdinal: undefined, mathUnitText: undefined};
    const apiRetained = anchors.resolveRetainedMatchIndex(next, apiPrevious, 1);
    assert.equal(liveKey(next[apiRetained - 1]), liveKey(previous), 'API and mounted formula identities retain the same cell');
    // The next row insertion shifts global formula ordinals again, in the opposite direction.
    wysiwyg.querySelector('[data-group-id="g1"]').insertAdjacentHTML('afterbegin', row('extra', ['c1', 'c2']));
    const inserted = (await calculateSearchMatches({}, edit, '\\alpha', opt)).matches;
    const still = anchors.resolveRetainedMatchIndex(inserted, next[retained - 1], 1, {previousMatches: next});
    assert.equal(liveKey(inserted[still - 1]), liveKey(previous));

    const style = document.createElement('style');
    style.textContent = '.tabs > .tab-item[data-tabs-hidden="true"]{display:none}';
    document.head.append(style);
    const tabs = html => '<div class="tabs" data-node-id="tabs" data-type="NodeTabs" tabs-active-id="one">' +
        '<div class="tab-item" data-node-id="one" data-type="NodeTabItem"></div>' +
        '<div class="tab-item" data-node-id="two" data-type="NodeTabItem" data-tabs-hidden="true">' + html + '</div></div>';
    for (const nested of [false, true]) {
        wysiwyg.innerHTML = tabs(nested ? tabs(shell(body(row('r0')))) : shell(body(row('r0'))));
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', opt)).matches.length, 1, 'block source survives inactive tab CSS');
        assert.equal((await calculateSearchMatches({}, edit, '\\alpha', opt)).matches.length, 2);
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', {...opt, includeMathBlock: false})).matches.length, 0);
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', {...opt, includeFoldedBlocks: false})).matches.length, 1,
            'inactive tabs remain searchable independently of native block folding');
        wysiwyg.firstElementChild.setAttribute('fold', '1');
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', {...opt, includeFoldedBlocks: false})).matches.length, 0);
        wysiwyg.firstElementChild.removeAttribute('fold');
        const formula = wysiwyg.querySelector('div[data-subtype="math"]');
        formula.style.display = 'none';
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', opt)).matches.length, 0, 'author-hidden math stays excluded');
        formula.style.display = '';
        formula.parentElement.style.visibility = 'hidden';
        assert.equal((await calculateSearchMatches({}, edit, '\\beta', opt)).matches.length, 0);
    }
    style.remove();

    const expected = ['before', '\\alpha', 'middle', '\\alpha', 'after', '\\beta', 'tail'];
    const query = 'before|\\\\alpha|middle|after|\\\\beta|tail';
    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)');
    let doms = {};
    let grouped = false;
    let viewType = 'table';
    let reads = 0;
    let embedded = false;
    const groupIds = () => grouped ? ['g1', 'g2'] : [''];
    const ids = ['r0', 'r1', 'r2'];
    const apiRow = id => ({id, cells: [{keyID: 'col', type: 'template', template: {content: preview}}]});
    const cardRow = id => ({id, values: [{value: {keyID: 'col', type: 'template', template: {content: preview}}}]});
    const apiRows = () => viewType === 'table' ? {rowCount: 3, pageSize: 3, rows: ids.map(apiRow)} :
        {cardCount: 3, pageSize: 3, cards: ids.map(cardRow)};
    const sourceShell = () => shell('', viewType, embedded ? 'source-av' : 'db');
    responder = async (url, payload) => {
        if (url === '/api/query/sql') return {code: 0, data: db.prepare(payload.stmt).all()};
        if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: Object.keys(doms)};
        if (url === '/api/block/getBlockDOMs') return {code: 0, data: doms};
        if (url === '/api/search/searchEmbedBlock') return {code: 0, data: {blocks: [{block: {id: 'source-av', content: sourceShell()}}]}};
        if (url === '/api/av/getAttributeView') return {code: 0, data: {name: '', views: [{id: 'view', name: ''}]}};
        if (url === '/api/av/renderAttributeView') {
            reads++;
            return {code: 0, data: {viewType, view: {type: viewType, id: 'view',
                ...(viewType === 'table' ? {columns: [{id: 'col', type: 'template'}]} : {fields: [{id: 'col', type: 'template'}]}),
                ...(grouped ? {groups: ['g1', 'g2'].map(id => ({id, groupHidden: 0, ...apiRows()}))} : apiRows()),
            }}};
        }
        return {code: -1};
    };
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    const search = (more = {}, text = query) => corpus.searchCurrentDocument({}, edit, text, {...opt, regex: true, ...more});
    const settle = async (more, text) => {
        const until = Date.now() + 5000;
        let result = await search(more, text);
        while (result.partial && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 10)); result = await search(more, text);
        }
        assert.equal(result.partial, false); assert.equal(result.unrendered, 0); assert.equal(result.degraded, false);
        return result;
    };
    corpus.retainBackgroundCorpusRoot('root');
    try {
        for (embedded of [false, true]) for (viewType of ['table', 'gallery', 'kanban']) for (grouped of [false, true]) {
            av.invalidateAvCache(); corpus.invalidateDocumentSearchCaches();
            db.exec('DELETE FROM blocks');
            const ownerId = embedded ? 'embed' : 'db';
            doms = {[ownerId]: embedded ? '<div data-node-id="embed" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>' : sourceShell()};
            insert.run(ownerId, 'root', 'root', embedded ? 'query_embed' : 'av', '', embedded ? 'select * from blocks' : '',
                doms[ownerId], '', 'hash', '1');
            const mount = (rows, folded = false) => {
                const items = rows.map(id => row(id, ['col'], viewType)).join('');
                const content = groupIds().map(id => id ? group(id, items, folded) : body(items)).join('');
                wysiwyg.innerHTML = rows.length ? (embedded ? '<div data-node-id="embed" data-type="NodeBlockQueryEmbed">' : '') +
                    shell(content, viewType, embedded ? 'source-av' : 'db') + (embedded ? '</div>' : '') : '';
            };
            for (const rows of [[], ['r0', 'r2'], ['r1'], ids]) {
                mount(rows);
                const result = await settle();
                const actual = result.matches.map(hit => hit.matchedText);
                if (JSON.stringify(actual) !== JSON.stringify(Array.from({length: ids.length * groupIds().length}, () => expected).flat())) {
                    console.log(result.matches.map(hit => ({unit: hit.unitId, text: hit.matchedText, seq: hit.unitSeq, pos: hit.embeddedPosition})));
                }
                assert.deepEqual(actual, Array.from({length: ids.length * groupIds().length}, () => expected).flat(),
                    'same reading order cold/partial/full: ' + JSON.stringify({embedded, viewType, grouped, rows}));
                assert.ok(result.matches.every(hit => !hit.replaceable));
                const before = reads;
                await settle();
                assert.equal(reads, before, 'reordering never issues extra AV requests');
            }
            if (viewType === 'gallery' && grouped) {
                mount(ids, true);
                assert.deepEqual((await settle()).matches.map(hit => hit.matchedText), Array(6).fill(expected).flat(), 'folded gallery preserves order');
            }
        }
        embedded = false; grouped = false; viewType = 'table';
        av.invalidateAvCache(); corpus.invalidateDocumentSearchCaches(); db.exec('DELETE FROM blocks');
        doms = {db: sourceShell()}; insert.run('db', 'root', 'root', 'av', '', '', doms.db, '', 'hash', '1');
        document.head.append(style);
        wysiwyg.innerHTML = tabs(shell(body(row('r0'))));
        assert.equal((await settle({}, '\\\\beta')).matches.length, 3, 'hidden mounted block math and API-only rows are complete');
        assert.equal((await settle({includeFoldedBlocks: false}, '\\\\beta')).matches.length, 3);
        style.remove();
    } finally { av.releaseAvCacheOwner('root', edit); corpus.releaseBackgroundCorpusRoot('root'); db.close(); editors = []; }
    console.log('AV math source: exact row/field/group/formula anchors, retained index, inactive/nested tabs, author hiding, cold/mixed/live/embedded order and request reuse OK');
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
