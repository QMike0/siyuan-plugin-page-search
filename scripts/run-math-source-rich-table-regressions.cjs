// Native rich-cell fixtures and isolated APIs; never opens or changes a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const harness = fs.readFileSync(path.join(__dirname, 'run-code-language-regressions.cjs'), 'utf8');
async function main() {
    for (const name of ['TextMark', 'InlineMath', 'BlockRef', 'KramdownIAL', 'HTMLTag2TextMark', 'DataTask']) lute['Set' + name](true);
    const nativeTable = require('./rich-cell-native-fixture.cjs')(lute);
    const sourceMode = {searchMathSource: true, includeFoldedBlocks: true, includeImageOCR: false, includeAttributeView: false};
    const id = '20261025000000-psrich0';
    const encode = content => Buffer.from(JSON.stringify({spec: 1, format: 'kramdown', content})).toString('base64url');
    const tableOf = rows => '<div data-type="NodeTable" data-node-id="' + id +
        '" custom-sy-table-rich="1"><div contenteditable="true"><table>' + rows.map((row, index) => {
            const section = index ? 'tbody' : 'thead';
            const tag = index ? 'td' : 'th';
            return '<' + section + '><tr>' + row.map(md => '<' + tag + ' data-sy-table-cell-rich="' + encode(md) +
                '"><div class="table__cell-rich b3-typography">' + lute.BlockDOM2HTML(lute.Md2BlockDOM(md)) + '</div></' + tag + '>').join('') +
                '</tr></' + section + '>';
        }).join('') + '</table></div></div>';
    const mount = (html, layout, markdown) => {
        wysiwyg.innerHTML = layout === 'native' ? nativeTable(html) : html;
        if (layout === 'editor') wysiwyg.querySelector('th').innerHTML =
            '<div class="table__cell-editor"><div class="protyle-wysiwyg">' + lute.Md2BlockDOM(markdown) + '</div></div>';
    };
    const formulas = '\\\\(?:alpha|beta)';
    const cases = [
        ['quote', '> before $\\alpha$\n>\n> $$\n> \\beta\n> $$', {includeBlockquote: false}],
        ['unordered', '- before $\\alpha$\n\n  $$\n  \\beta\n  $$', {includeListUnordered: false}],
        ['ordered', '1. before $\\alpha$\n\n   $$\n   \\beta\n   $$', {includeListOrdered: false}],
        ['task', '- [ ] before $\\alpha$\n\n  $$\n  \\beta\n  $$', {includeListTask: false}],
        ...Array.from({length: 6}, (_, i) => ['h' + (i + 1), '#'.repeat(i + 1) + ' before $\\alpha$',
            {['includeHeadingH' + (i + 1)]: false}]),
    ];
    const localSearch = async (pattern, options = {}) => {
        const previous = editors;
        editors = [];
        try { return await calculateSearchMatches({}, edit, pattern, {...sourceMode, regex: true, ...options}); }
        finally { editors = previous; }
    };
    for (const [label, md, off] of cases) {
        const html = tableOf([[md]]);
        for (const layout of ['static', 'native', 'editor']) {
            mount(html, layout, md);
            const snapshot = wysiwyg.innerHTML;
            const calls = apiCalls;
            assert.equal((await localSearch(formulas)).matches.length, label.startsWith('h') ? 1 : 2, label + ' ' + layout + ' enabled');
            assert.equal((await localSearch(formulas, off)).matches.length, 0, label + ' ' + layout + ' gate excludes both formula kinds');
            assert.equal((await localSearch(formulas, {includeMathBlock: false})).matches.length, 1, 'block-math gate keeps the inline formula');
            assert.equal((await localSearch(formulas, {includeTable: false})).matches.length, 0, 'table gate excludes all cell formulas');
            assert.equal(wysiwyg.innerHTML, snapshot);
            assert.equal(apiCalls, calls, 'DOM filtering does not fetch or change content');
            for (const element of wysiwyg.querySelectorAll('span[data-type~="inline-math"], [data-type="NodeMathBlock"], div.language-math')) {
                if (!element.hasAttribute('data-content')) element.setAttribute('data-content', element.textContent);
                element.dataset.subtype = 'math';
                element.innerHTML = '<span class="katex-html">' + (element.dataset.content.includes('alpha') ? 'α' : 'β') + '</span>';
                element.dataset.render = 'true';
            }
            assert.equal((await localSearch('[αβ]', {searchMathSource: false})).matches.length, label.startsWith('h') ? 1 : 2);
            assert.equal((await localSearch('[αβ]', {searchMathSource: false, ...off})).matches.length, 0, label + ' glyph gate');
        }
    }
    for (const layout of ['static', 'native', 'editor']) {
        const md = 'before $\\alpha$';
        mount(tableOf([[md]]), layout, md);
        assert.equal((await localSearch(formulas, {includeParagraph: false})).matches.length, layout === 'editor' ? 1 : 0,
            'the active cell editor keeps its existing temporary-paragraph exception');
    }

    const db = new DatabaseSync(':memory:');
    db.function('search_normalize', (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)');
    db.exec('CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
    let html = '';
    let writes = 0;
    responder = async (url, payload) => {
        if (url === '/api/query/sql') return {code: 0, data: db.prepare(payload.stmt).all()};
        if (url === '/api/block/getDocBlocksOrders') return {code: 0, data: [id]};
        if (url === '/api/block/getBlockDOMs') return {code: 0, data: {[id]: html}};
        writes++;
        throw new Error('Unexpected API ' + url);
    };
    editors = [{protyle: {element: edit, notebookId: '', block: {id: 'root', rootID: 'root'}}}];
    const setDocument = rows => {
        html = tableOf(rows);
        db.exec('DELETE FROM blocks');
        db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'root', 'root', 't', '',
            'before \\alpha \\beta after', lute.BlockDOM2StdMd(html), '', 'hash', '1');
        corpus.invalidateDocumentSearchCaches();
    };
    const search = (pattern, options = {}) => corpus.searchCurrentDocument({}, edit, pattern, {...sourceMode, regex: true, ...options});
    try {
        for (const [label, md, off] of cases) {
            setDocument([[md]]);
            for (const layout of ['unloaded', 'static', 'native', 'editor', 'folded']) {
                if (layout === 'unloaded') wysiwyg.innerHTML = '';
                else mount(html, layout === 'folded' ? 'native' : layout, md);
                if (layout === 'folded') wysiwyg.firstElementChild.setAttribute('parent-heading', '20261026000000-heading');
                corpus.invalidateDocumentSearchCaches();
                const before = await search(formulas);
                assert.equal(before.partial, false);
                assert.equal(before.matches.length, label.startsWith('h') ? 1 : 2, label + ' corpus ' + layout + ' enabled');
                const excluded = await search(formulas, off);
                assert.equal(excluded.partial, false);
                assert.equal(excluded.matches.length, 0, label + ' corpus ' + layout + ' no cold-data reintroduction');
                assert.ok(before.matches.every(hit => hit.highlightKind === 'math-source' && !hit.replaceable));
            }
        }

        const orderCases = [
            ['inline-first', 'before $\\alpha$\n\n$$\n\\beta\n$$\n\nafter', ['before', '\\alpha', '\\beta', 'after']],
            ['block-first', 'before\n\n$$\n\\beta\n$$\n\n$\\alpha$ after', ['before', '\\beta', '\\alpha', 'after']],
            ['adjacent', '$\\alpha$\n\n$$\n\\beta\n$$\n\n$$\n\\beta\n$$\n\n$\\alpha$', ['\\alpha', '\\beta', '\\beta', '\\alpha']],
            ['long-body', 'before ' + 'x'.repeat(1400) + ' $\\alpha$\n\n$$\n\\beta\n$$\n\nafter', ['before', '\\alpha', '\\beta', 'after']],
            ['multiline', 'before\nline $\\alpha$\n\n$$\n\\beta\n$$\n\nafter', ['before', '\\alpha', '\\beta', 'after']],
        ];
        const pattern = 'before|\\\\alpha|\\\\beta|after';
        for (const [label, md, expected] of orderCases) {
            setDocument([[md, md], [md, md]]);
            for (const layout of ['unloaded', 'static', 'native', 'editor', 'virtual', 'folded']) {
                if (layout === 'unloaded') wysiwyg.innerHTML = '';
                else mount(html, layout === 'virtual' || layout === 'folded' ? 'native' : layout, md);
                if (layout === 'virtual') {
                    const row = wysiwyg.querySelector('tbody tr');
                    const omitted = row.outerHTML;
                    row.innerHTML = '<td></td>';
                    row.setAttribute('data-sy-table-virtual-rows', omitted);
                }
                if (layout === 'folded') wysiwyg.firstElementChild.setAttribute('parent-heading', '20261026000000-heading');
                corpus.invalidateDocumentSearchCaches();
                const result = await search(pattern);
                assert.equal(result.partial, false);
                assert.deepEqual(result.matches.map(hit => hit.matchedText), Array(4).fill(expected).flat(), label + ' ' + layout + ' reading order');
                assert.ok(result.matches.filter(hit => hit.highlightKind === 'math-source').every(hit => !hit.replaceable));
                if (layout !== 'unloaded' && layout !== 'virtual') {
                    const local = await localSearch(pattern);
                    assert.deepEqual(local.matches.map(hit => hit.matchedText), result.matches.map(hit => hit.matchedText), 'DOM/corpus order agrees');
                    for (const hit of local.matches.filter(hit => hit.highlightKind === 'math-source')) {
                        assert.equal(write.isMatchContentWritable({...hit, replaceable: true}), false);
                    }
                }
            }
            for (const layout of ['static', 'native']) {
                mount(html, layout, md);
                wysiwyg.innerHTML = '<div data-type="NodeBlockQueryEmbed" data-node-id="embed">' + wysiwyg.innerHTML + '</div>';
                const result = await localSearch(pattern);
                assert.deepEqual(result.matches.map(hit => hit.matchedText), Array(4).fill(expected).flat(), label + ' embedded order');
                assert.ok(result.matches.every(hit => !hit.replaceable), 'embedding stays read-only');
            }
        }
        assert.equal(writes, 0, 'only read APIs are used');
    } finally { db.close(); editors = []; }

    // Build at most one order snapshot per affected cell; unrelated cells need none.
    const positions = source('frontend/embedded-order');
    const record = positions.recordEmbeddedOrder;
    // A soft-break run may start inside its first Text and continue in a mark.
    // Its later matches must keep the actual node's position in the snapshot.
    const host = document.createElement('div');
    host.innerHTML = 'prefix\nline <strong>marked</strong> tail';
    const nodes = [host.firstChild, host.querySelector('strong').firstChild, host.lastChild];
    const sliced = {element: host, textNodes: nodes, text: 'line marked tail', textStartOffset: 7};
    const positionOf = record(host, [sliced]);
    assert.deepEqual(positions.embeddedPositionAt(sliced.embeddedOrder, sliced.text.indexOf('marked')), positionOf(nodes[1]));
    assert.deepEqual(positions.embeddedPositionAt(sliced.embeddedOrder, sliced.text.indexOf('tail')), positionOf(nodes[2]));
    const samples = [];
    try {
        for (const count of [50, 100]) {
            const md = Array(count).fill('$\\alpha$\n\n$$\n\\beta\n$$').join('\n\n');
            mount(tableOf([[md, 'unrelated plain cell']]), 'native');
            let snapshots = 0;
            let units = 0;
            positions.recordEmbeddedOrder = function(root, blocks, ...args) {
                snapshots++; units += blocks.length;
                return record(root, blocks, ...args);
            };
            const snapshot = wysiwyg.innerHTML;
            const blocks = collectSearchableBlocks(edit, sourceMode);
            assert.equal(snapshots, 1, 'one affected cell is ranked once');
            assert.equal(blocks.filter(block => source('shared/math-search').isMathSourceUnit(block)).length, count * 2);
            assert.ok(units <= count * 4, 'bounded work per formula');
            assert.equal(wysiwyg.innerHTML, snapshot);
            samples.push({count, snapshots, units});
        }
        const plain = lute.Md2BlockDOM('| plain |\n| --- |\n| text |');
        wysiwyg.innerHTML = plain;
        let snapshots = 0;
        positions.recordEmbeddedOrder = function(...args) {snapshots++; return record(...args);};
        collectSearchableBlocks(edit, sourceMode);
        assert.equal(snapshots, 0, 'ordinary tables retain the existing path');
    } finally { positions.recordEmbeddedOrder = record; }
    console.log('Rich-table formulas: source gates, cold/static/native/editor consistency, mixed order, readonly and bounded per-cell work OK', samples);
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(harness.slice(0, harness.indexOf('async function main()')) + '\n' + main.toString() +
    '\nmain().catch(error => {console.error(error);process.exitCode=1;});', __filename);
