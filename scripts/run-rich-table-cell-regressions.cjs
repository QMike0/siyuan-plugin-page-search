// Isolated v3.8.8 Lute and DOM/transaction contracts; never writes a notebook.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
let editors = [];
let api = async () => ({code: -1});
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {getAllEditor: () => editors, fetchSyncPost: (...args) => api(...args)};
    return originalLoad.call(this, request, parent, main);
};
const {window} = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = window;
global.document = window.document;
for (const key of ["Node", "Element", "HTMLElement", "HTMLImageElement", "Text", "NodeFilter", "Range", "ShadowRoot", "MutationObserver",
    "HTMLTableElement", "HTMLTableRowElement", "HTMLTableCellElement"]) global[key] = window[key];
global.getComputedStyle = window.getComputedStyle.bind(window);
global.getSelection = window.getSelection.bind(window);
global.CSS = {escape: value => value};
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
Object.defineProperty(HTMLElement.prototype, "innerText", {get() { return this.textContent; }, configurable: true});
const luteFile = process.env.SIYUAN_LUTE_PATH || path.resolve(__dirname, "../../tmp/rich-cell-v387/lute-v388.js");
assert.ok(fs.existsSync(luteFile), "Set SIYUAN_LUTE_PATH to SiYuan v3.8.8 lute.min.js");
require(luteFile);
global.Lute = window.Lute ?? global.Lute;
window.Lute = global.Lute;
require.extensions[".ts"] = (mod, file) => {
    let code = fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"');
    if (file.endsWith("replacement-commit.ts")) code = code.replace("COMMIT_WAIT_MS = 8000", "COMMIT_WAIT_MS = 80");
    // Test-only access for counting segment lookups; no production export.
    if (file.endsWith("rich-table-cell.ts")) code += ";export {readCellModel as inspectCellModel};";
    mod._compile(ts.transpileModule(code,
        {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, file);
};
const source = file => require(path.resolve(__dirname, "../src", file + ".ts"));
const rich = source("frontend/rich-table-cell");
const blocks = source("frontend/blocks");
const {freezeBlock} = source("frontend/corpus/units");
const {matchTextUnitsDetailed} = source("shared/match-text");
const write = source("frontend/protyle-write");
const {createCommitContentReader} = source("frontend/replacement-commit");
const {calculateSearchMatches} = source("frontend/pipeline");
const encode = content => Buffer.from(JSON.stringify({spec: 1, format: "kramdown", content})).toString("base64url");
const parse = html => { const root = document.createElement("div"); root.innerHTML = html; return root; };
const lute = Lute.New();
for (const name of ["TextMark", "BlockRef", "KramdownIAL", "ProtyleWYSIWYG", "HTMLTag2TextMark", "DataTask", "EnsureListItemParagraph"]) lute[`Set${name}`](true);
const richMethodCounts = {Md2BlockDOM: 0, BlockDOM2Md: 0, SpinBlockDOM: 0};
const originalLuteNew = Lute.New;
Lute.New = (...args) => {
    const instance = originalLuteNew(...args);
    for (const name of Object.keys(richMethodCounts)) {
        const native = instance[name];
        instance[name] = (...values) => {richMethodCounts[name]++; return native(...values);};
    }
    return instance;
};
const id = "20261025000000-abcdefg";
function table(markdown, normal = "keep", secondRich = "", extra = "") {
    return lute.SpinBlockDOM(`<div data-type="NodeTable" data-node-id="${id}" custom-sy-table-rich="1"><div contenteditable="true">` +
        `<table><thead><tr><th ${rich.RICH_CELL_ATTRIBUTE}="${encode(markdown)}"></th><th>${normal}</th></tr></thead>` +
        `<tbody><tr><td ${rich.RICH_CELL_ATTRIBUTE}="${encode(secondRich)}"></td><td>${extra}</td></tr></tbody></table></div></div>`);
}
function cellFixture(markdown) { return parse(table(markdown)).querySelector("th"); }
function editsIn(cell, text) {
    const edits = [];
    for (const node of blocks.collectTableCellSearchTextNodes(cell)) for (const match of node.data.matchAll(/foo/g)) {
        edits.push({nodes: [node], start: match.index, end: match.index + 3, matchedText: "foo", text});
    }
    return edits;
}
function savedText(cell) {
    const root = parse(lute.Md2BlockDOM(rich.decodeRichCell(cell.getAttribute(rich.RICH_CELL_ATTRIBUTE))));
    return Array.from(root.querySelectorAll('[contenteditable="true"]')).map(node => node.textContent).join("");
}
const samples = [
    ["paragraph", "foo"], ["list", "- foo\n- keep"], ["nested-list", "- foo\n  - bar\n- [x] foo"],
    ["ordered-list", "3. foo\n4. keep"], ["quote", "> foo\n>\n> keep"], ["heading", "# foo\n\nkeep"],
    ["code", '```js\nfoo\nkeep\n```\n{: id="20261019000000-code001" linewrap="false" linenumber="true" ligatures="false" custom-sy-code-tab-spaces="2"}'],
    ["link", "- [foo](https://example.com/foo)"], ["mixed", "before\n\n- foo\n- keep\n\n```js\nfoo\nkeep\n```"],
    ["whitespace", "&#32;&#32;foo&#32;&#32;<br />next"], ["empty-paragraph", "first\n\n&#32;\n\nfoo"],
    ["soft-break", "first<br />foo<br />foo end"],
    ["soft-empty-lines", "foo<br /><br />foo<br />"],
    ["formula-coexist", "- foo\n\n$$\na+b\n$$"], ["entity", "foo &amp; &#42;literal&#42;"], ["emoji", "😀 foo 中文"],
];
for (const [name, markdown] of samples) for (const text of ["bar", "  **bar**  ", "new\nline", "`code` & <tag>", "", "foo"]) {
    const cell = cellFixture(markdown);
    const before = cell.outerHTML;
    assert.equal(rich.isSupportedRichCell(cell), true, name);
    const prepared = rich.prepareRichCellEdit(cell, editsIn(cell, text));
    assert.equal(cell.outerHTML, before, "preparation must not mutate live content");
    assert.ok(prepared, `${name}: ${JSON.stringify(text)}`);
    rich.publishRichCellEdit(cell, prepared);
    if (text === "foo") assert.equal(cell.outerHTML, before, "no-op must be byte-identical");
    else assert.ok(savedText(cell).includes(text), `${name}: saved literal replacement`);
    const reloaded = parse(table(rich.decodeRichCell(cell.getAttribute(rich.RICH_CELL_ATTRIBUTE)))).querySelector("th");
    assert.equal(rich.decodeRichCell(reloaded.getAttribute(rich.RICH_CELL_ATTRIBUTE)), rich.decodeRichCell(prepared.encoded),
        "native re-render preserves source (Go JSON escapes HTML characters)");
}
for (const text of ["bar", "", "foo"]) {
    const cell = cellFixture("- **foo** and foo");
    const prepared = rich.prepareRichCellEdit(cell, editsIn(cell, text));
    assert.ok(prepared); rich.publishRichCellEdit(cell, prepared);
    if (text) assert.ok(savedText(cell).includes(text));
}
// Inline-code semantic markers and unsupported structures are never guessed.
for (const markdown of ["- `foo` and foo", "| foo | bar |\n| --- | --- |\n| a | b |", "```mermaid\nfoo\n```",
    '{{select * from blocks where content="foo"}}', '<div data-type="NodeAttributeView">foo</div>', "foo\n\n---", "foo".repeat(23000)]) {
    const cell = cellFixture(markdown), before = cell.outerHTML;
    assert.equal(rich.isSupportedRichCell(cell), false, markdown.slice(0, 40));
    assert.equal(rich.prepareRichCellEdit(cell, editsIn(cell, "bar")), undefined);
    assert.equal(cell.outerHTML, before);
}
for (const value of ["!invalid!", Buffer.from(JSON.stringify({spec: 2, format: "kramdown", content: "foo"})).toString("base64url"), encode("foo\0bar")]) {
    const cell = cellFixture("foo"); cell.setAttribute(rich.RICH_CELL_ATTRIBUTE, value);
    assert.equal(rich.isSupportedRichCell(cell), false);
}
{
    const cell = cellFixture("foo"), edits = editsIn(cell, "bar");
    edits[0].nodes[0].data = "changed";
    assert.equal(rich.prepareRichCellEdit(cell, edits), undefined, "stale preview must not map by word occurrence");
}
{
    const cell = cellFixture("foo");
    assert.equal(rich.prepareRichCellEdit(cell, editsIn(cell, "x".repeat(128 * 1024 + 1))), undefined);
}
{
    const cell = cellFixture("```js\nfoo\nkeep\n```"), code = cell.querySelector("pre > code");
    code.innerHTML = '<span class="hljs-name">foo</span>\nkeep\n';
    assert.equal(rich.isSupportedRichCell(cell), true, "syntax highlighting wrappers do not change saved code");
    assert.ok(rich.prepareRichCellEdit(cell, editsIn(cell, "bar")));
    assert.equal(rich.prepareRichCellEdit(cell, editsIn(cell, "bar\n```\n# injected")), undefined,
        "a replacement must not change code into new blocks");
}
{
    const cell = cellFixture("- foo\n  - keep");
    const node = blocks.collectTableCellSearchTextNodes(cell).find(item => item.data.includes("foo"));
    const unit = {element: cell, textNodes: [node], text: node.data};
    assert.ok(rich.richCellWritableSpans(unit).every(span => span.end <= 3), "layout newlines are not source text");
    assert.equal(rich.isSupportedRichCell(cell), true);
    node.data = "changed";
    rich.beginRichCellSnapshot();
    assert.equal(rich.isSupportedRichCell(cell), false, "a new collection validates changed preview content");
}
console.log("Rich source/preview mapping, literal roundtrips, formatting guards, unsupported blocks and budgets OK");

function fixture(html, {loaded = true, virtual = false, mode = "success", selected = false} = {}) {
    document.body.innerHTML = '<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"></div></div></div>';
    const edit = document.querySelector(".protyle"), wysiwyg = edit.querySelector(".protyle-wysiwyg");
    const kernel = new Map([[id, html]]), calls = [];
    const apply = ops => {
        for (const op of ops) {
            const saved = lute.SpinBlockDOM(op.data); kernel.set(op.id, saved);
            const current = wysiwyg.querySelector(`[data-node-id="${op.id}"]`);
            if (current) current.replaceWith(parse(saved).firstElementChild);
        }
    };
    const protyle = {
        id: "rich-test-session", protyle: {element: edit, lute, block: {}, disabled: false},
        transaction(ops, undo) {
            calls.push({ops, undo});
            if (mode === "throw") throw new Error("injected queue rejection");
            if (mode !== "reject") apply(ops);
        },
        updateTransactionElement(element, oldHTML) {
            this.transaction([{action: "update", id, data: element.outerHTML}], [{action: "update", id, data: oldHTML}]);
        },
    };
    if (loaded) {
        wysiwyg.innerHTML = html;
        if (virtual) {
            const row = wysiwyg.querySelector("tbody tr"), omitted = row.outerHTML;
            row.innerHTML = "<td></td>";
            row.setAttribute("data-sy-table-virtual-rows", omitted);
        }
    }
    editors = [protyle];
    api = async (url, data) => {
        assert.equal(url, "/api/block/getBlockDOMs");
        return {code: 0, data: Object.fromEntries(data.ids.map(blockId => [blockId, kernel.get(blockId)]))};
    };
    window.getSelection().removeAllRanges();
    if (selected) {
        const range = document.createRange(); range.selectNodeContents(wysiwyg.querySelector("th").firstChild); range.collapse(true);
        window.getSelection().addRange(range);
    }
    return {edit, wysiwyg, kernel, protyle, calls, apply};
}
function collect(html, query = "foo") {
    // Matching-only fixture helper; real writable eligibility is asserted via
    // calculateSearchMatches/searchCurrentDocument below, never inferred here.
    const temp = document.createElement("div"); temp.className = "protyle";
    temp.innerHTML = `<div class="protyle-content"><div class="protyle-wysiwyg">${html}</div></div>`;
    document.body.append(temp);
    const cached = blocks.collectSearchableBlocks(temp, {includeDocTitle: false}).map(unit => freezeBlock(unit));
    const map = new Map(cached.map(unit => [`${unit.blockId}\0${unit.unitId ?? ""}`, unit]));
    const matches = matchTextUnitsDetailed(cached, query).hits.map(hit => {
        const unit = map.get(`${hit.blockId}\0${hit.unitId ?? ""}`);
        return {...hit, replaceable: hit.replaceable && !unit.replaceLock && (unit.writableSpans === undefined ||
            unit.writableSpans.some(span => hit.start >= span.start && hit.end <= span.end)), replaceLock: unit.replaceLock};
    });
    temp.remove(); return matches;
}
(async () => {
    const original = table("- foo\n  - foo\n- [x] foo\n\n```js\nfoo\n```", "foo", "# foo", "foo");
    const matches = collect(original);
    assert.equal(matches.length, 7); assert.equal(matches.every(match => match.replaceable), true);
    for (const all of [false, true]) for (const coverage of ["live", "fetched", "virtual", "selected"]) {
        const f = fixture(original, {loaded: coverage !== "fetched", virtual: coverage === "virtual", selected: coverage === "selected"});
        const result = all ? await write.replaceAllMatchesInEditor(f.edit, matches, "bar") : await write.replaceCurrentMatchInEditor(f.edit, matches[0], "bar");
        assert.equal(result.commitState, "confirmed", `${all}/${coverage}: ${JSON.stringify(result)}`);
        assert.equal(result.replacedCount, all ? 7 : 1); assert.equal(f.calls.length, 1, "one native transaction");
        assert.equal(f.calls[0].ops.length, 1, "normal/rich cells share one complete table update");
        assert.equal(collect(f.kernel.get(id)).length, all ? 0 : 6);
        const reader = createCommitContentReader(f.protyle);
        assert.notEqual(reader(original), reader(f.kernel.get(id)));
        f.apply(f.calls[0].undo); assert.equal(collect(f.kernel.get(id)).length, 7);
        assert.equal(parse(f.kernel.get(id)).querySelector("th").getAttribute(rich.RICH_CELL_ATTRIBUTE),
            parse(original).querySelector("th").getAttribute(rich.RICH_CELL_ATTRIBUTE), "undo restores source verbatim");
        f.apply(f.calls[0].ops); assert.equal(collect(f.kernel.get(id)).length, all ? 0 : 6);
    }
    {
        const f = fixture(original), result = await write.replaceAllMatchesInEditor(f.edit, matches, "foo");
        assert.equal(result.unchanged, true); assert.equal(f.calls.length, 0); assert.equal(f.kernel.get(id), original);
    }
    {
        const html = table("- **foo** and foo", "foo"), f = fixture(html);
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(html), "  **bar**  ");
        assert.equal(result.error, "rich-cell-unsafe"); assert.equal(f.calls.length, 0);
        assert.equal(f.kernel.get(id), html); assert.equal(f.wysiwyg.innerHTML, parse(html).innerHTML);
    }
    for (const mode of ["throw", "reject"]) for (const all of [false, true]) {
        const f = fixture(original, {mode});
        const result = all ? await write.replaceAllMatchesInEditor(f.edit, matches, "bar") : await write.replaceCurrentMatchInEditor(f.edit, matches[0], "bar");
        assert.equal(result.replacedCount, 0); assert.equal(result.commitState, mode === "throw" ? "failed" : "unknown");
        assert.equal(f.kernel.get(id), original); assert.equal(f.calls.length, 1);
        if (mode === "throw") assert.equal(f.wysiwyg.innerHTML, parse(original).innerHTML);
    }
    {
        const html = table("- foo", "foo"), f = fixture(html);
        const result = await calculateSearchMatches({}, f.edit, "foo", {includeDocTitle: false});
        assert.equal(result.matches.length, 2); assert.equal(result.matches.every(match => match.replaceable), true);
        f.wysiwyg.querySelector("td").appendChild(Object.assign(document.createElement("div"), {className: "table__cell-editor"}));
        assert.equal(rich.prepareRichCellEdit(f.wysiwyg.querySelector("th"), editsIn(f.wysiwyg.querySelector("th"), "bar")),
            undefined, "write preparation rechecks an editor opened after collection");
        rich.beginRichCellSnapshot();
        assert.equal(blocks.tableCellReplaceLock(f.wysiwyg.querySelector("th")), "table-cell-editor");
    }
    {
        const f = fixture(table("- foo\n".repeat(120))), host = f.wysiwyg.firstElementChild;
        const nativeQuery = host.querySelector.bind(host);
        let editorScans = 0;
        host.querySelector = selector => { if (selector === ".table__cell-editor") editorScans++; return nativeQuery(selector); };
        const units = blocks.collectSearchableBlocks(f.edit, {includeDocTitle: false});
        units.map(unit => freezeBlock(unit));
        assert.equal(editorScans, 1, "all rich runs in a collection share the table editor scan");
        assert.ok(units.length >= 120);
    }
    {
        const f = fixture(original);
        const expand = source("shared/regex-replace").expandRegexReplacement;
        const regexMatcher = {expandReplacements: async requests => ({expansions: requests.flatMap(unit =>
            unit.replacements.map(hit => ({id: hit.id, haystack: unit.haystack, replacement: expand({haystack: unit.haystack,
                start: hit.start, end: hit.end, patternSource: "f(oo)", template: "$1!", caseSensitive: false})})))})};
        const result = await write.replaceAllMatchesInEditor(f.edit, matches, "$1!", {regex: true, searchQuery: "f(oo)", regexMatcher});
        assert.equal(result.commitState, "confirmed"); assert.equal(result.replacedCount, 7);
        assert.equal(collect(f.kernel.get(id), "oo!").length, 7, "regex uses original search runs and Worker plan");
    }
    {
        const html = table("- Foo\n- FOO\n- foo"), f = fixture(html);
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(html), "bar", {preserveCase: true});
        assert.equal(result.commitState, "confirmed");
        const text = savedText(parse(f.kernel.get(id)).querySelector("th"));
        for (const value of ["Bar", "BAR", "bar"]) assert.ok(text.includes(value));
    }
    {
        const first = parse(original), second = parse(original);
        second.querySelector("th").setAttribute(rich.RICH_CELL_ATTRIBUTE, encode("new saved source"));
        const reader = createCommitContentReader({protyle: {lute: {BlockDOM2Md: () => "same derived preview"}}});
        assert.notEqual(reader(first.innerHTML), reader(second.innerHTML), "unchanged preview cannot confirm old source");
    }
    {
        // Source eligibility budgets must not break ordinary-cell writes in the same table.
        const html = table("- large &amp; " + "x".repeat(128 * 1024 + 1), "foo"), f = fixture(html);
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(html), "bar");
        assert.equal(result.commitState, "confirmed"); assert.equal(result.replacedCount, 1);
        const saved = parse(f.kernel.get(id));
        assert.equal(saved.querySelectorAll("th")[1].textContent, "bar");
        const reader = createCommitContentReader(f.protyle);
        assert.ok(reader(html));
        assert.equal(reader(html), reader(lute.SpinBlockDOM(html)), "Go JSON escaping has a canonical source signature");
        assert.equal(saved.querySelector("th").getAttribute(rich.RICH_CELL_ATTRIBUTE),
            parse(html).querySelector("th").getAttribute(rich.RICH_CELL_ATTRIBUTE));
    }
    {
        const html = table("- foo", "keep"), f = fixture(html, {virtual: true});
        const changed = parse(table("- **foo**", "keep")).querySelector("th");
        f.wysiwyg.querySelector("th").replaceWith(changed);
        const visible = f.wysiwyg.firstElementChild.outerHTML;
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(visible), "bar");
        assert.equal(result.commitState, "confirmed");
        assert.ok(parse(f.kernel.get(id)).querySelector('th strong, th [data-type~="strong"]'),
            "same text with a changed rich source keeps live formatting");
    }
    {
        const html = parse(table("- foo", "foo"));
        html.querySelector("th").setAttribute(rich.RICH_CELL_ATTRIBUTE, "!invalid!");
        const f = fixture(html.innerHTML);
        const result = await calculateSearchMatches({}, f.edit, "foo", {includeDocTitle: false});
        assert.equal(result.matches.length, 2);
        assert.equal(result.matches.filter(match => match.replaceable).length, 1, "invalid rich data stays searchable and locked");
    }
    const nativeTable = require('./rich-cell-native-fixture.cjs')(lute);
    const imageSamples = [
        'foo ![keep](assets/keep.png "caption")',
        '![keep](assets/keep.png "caption") foo',
        'foo ![keep](assets/keep.png "caption")\n\nfoo',
        'foo ![keep](assets/keep.png "caption")![other](assets/other.png)\n\nfoo',
        '![keep](assets/keep.png "caption")\n\n- foo\n- foo',
    ];
    const imageValues = html => Array.from(parse(html).querySelectorAll('img'), image =>
        ['src', 'alt', 'title'].map(name => image.getAttribute(name)));
    for (const markdown of imageSamples) {
        const html = table(markdown, 'foo');
        const rawMatches = collect(html), nativeMatches = collect(nativeTable(html));
        assert.deepEqual(nativeMatches.map(hit => [hit.unitId, hit.start, hit.end, hit.matchedText]),
            rawMatches.map(hit => [hit.unitId, hit.start, hit.end, hit.matchedText]), 'image placeholders do not shift hit identity');
        for (const all of [false, true]) for (const coverage of ['live', 'fetched', 'virtual']) for (const nativeMatch of [false, true]) {
            const f = fixture(html, {loaded: coverage !== 'fetched', virtual: coverage === 'virtual'});
            if (coverage !== 'fetched') f.wysiwyg.innerHTML = nativeTable(f.wysiwyg.innerHTML);
            if (coverage === 'live') {
                const eligible = await calculateSearchMatches({}, f.edit, 'foo', {includeDocTitle:false});
                assert.equal(eligible.matches.length, rawMatches.length);
                assert.ok(eligible.matches.every(hit => hit.replaceable), 'image-neighbor writable count');
            }
            const matches = nativeMatch ? nativeMatches : rawMatches;
            const result = all ? await write.replaceAllMatchesInEditor(f.edit, matches, 'bar') :
                await write.replaceCurrentMatchInEditor(f.edit, matches[0], 'bar');
            assert.equal(result.commitState, 'confirmed', 'image ' + all + '/' + coverage + '/' + nativeMatch + ': ' + JSON.stringify(result));
            assert.equal(result.replacedCount, all ? matches.length : 1);
            assert.equal(f.calls.length, 1, 'rich/ordinary cells remain one complete-table transaction');
            assert.deepEqual(imageValues(f.kernel.get(id)), imageValues(html), 'unmatched image metadata survives');
            assert.equal(collect(nativeTable(f.kernel.get(id))).length, all ? 0 : matches.length - 1);
            f.apply(f.calls[0].undo);
            assert.equal(parse(f.kernel.get(id)).querySelector('th').getAttribute(rich.RICH_CELL_ATTRIBUTE), encode(markdown));
            assert.equal(collect(nativeTable(f.kernel.get(id))).length, matches.length);
            f.apply(f.calls[0].ops);
            assert.equal(collect(nativeTable(f.kernel.get(id))).length, all ? 0 : matches.length - 1);
        }
    }
    for (const native of [false, true]) {
        for (const attribute of ['src', 'alt', 'title']) {
            const html = table(imageSamples[0]);
            const cell = parse(native ? nativeTable(html) : html).querySelector('th');
            rich.beginRichCellSnapshot();
            assert.equal(rich.isSupportedRichCell(cell), true);
            cell.querySelector('img').setAttribute(attribute, 'changed');
            assert.equal(rich.prepareRichCellEdit(cell, editsIn(cell, 'bar')), undefined, 'image metadata mismatch stays protected');
        }
        const html = table(imageSamples[0]), f = fixture(html);
        if (native) f.wysiwyg.innerHTML = nativeTable(html);
        const originalHTML = f.wysiwyg.innerHTML;
        const result = await write.replaceAllMatchesInEditor(f.edit, collect(native ? nativeTable(html) : html), 'foo');
        assert.equal(result.unchanged, true);
        assert.equal(f.calls.length, 0);
        assert.equal(f.wysiwyg.innerHTML, originalHTML, 'image no-op keeps the original DOM');
    }
    console.log('Image-neighbor text: static/native identity, current/all x live/fetched/virtual, metadata guards, no-op and undo/redo OK');
    const lookupCosts = [];
    for (const count of [500, 1000, 2000, 4000]) {
        const cell = parse(nativeTable(table(Array(count).fill('foo').join('<br />')))).querySelector('th');
        rich.beginRichCellSnapshot();
        const state = rich.inspectCellModel(cell);
        assert.ok(state);
        const originalSegments = state.segments;
        let visits = 0;
        state.segments = new Proxy(originalSegments, {get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
            return Reflect.get(target, key, receiver);
        }});
        const edits = editsIn(cell, 'bar');
        assert.equal(edits.length, count);
        const started = performance.now();
        const prepared = rich.prepareRichCellEdit(cell, edits);
        const elapsedMs = Math.round(performance.now() - started);
        state.segments = originalSegments;
        assert.ok(prepared);
        assert.ok(visits <= count * (Math.ceil(Math.log2(originalSegments.length)) + 2), 'ordered lookup has a logarithmic access budget');
        assert.equal((rich.decodeRichCell(prepared.encoded).match(/bar/g) ?? []).length, count);
        lookupCosts.push({count, visits, elapsedMs});
    }
    console.log('Rich per-cell ordered lookup budget OK', lookupCosts);
    const selectionApi = source('frontend/selection');
    const cellScopeVisual = source('frontend/selection-scope-visual');
    function selectCellText(cell, from, to) {
        const nodes = blocks.collectTableCellSearchTextNodes(cell);
        const point = (offset, end) => {
            let cursor = 0;
            for (const node of nodes) {
                if (offset < cursor + node.data.length || end && offset === cursor + node.data.length) return {node, offset:offset-cursor};
                cursor += node.data.length;
            }
            throw new Error('selection outside fixture');
        };
        const start = point(from,false), finish=point(to,true), range=document.createRange();
        range.setStart(start.node,start.offset); range.setEnd(finish.node,finish.offset);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        return range;
    }
    {
        const markdown = 'a<br />b<br />foo<br />foo<br />foo';
        for (const editor of [false,true]) for (const offset of [4,8,12]) for (const all of [false,true]) {
            const html=table(markdown), f=fixture(html);
            f.wysiwyg.innerHTML=nativeTable(html);
            const cell=f.wysiwyg.querySelector('th');
            if (editor) cell.innerHTML='<div class=table__cell-editor><div class=protyle-wysiwyg>' + lute.Md2BlockDOM(markdown) + '</div></div>';
            selectCellText(cell,offset,offset+3);
            const snap=selectionApi.snapshotTableCellTextSelection();
            assert.ok(snap.richText);
            if (editor) {
                cell.innerHTML=parse(nativeTable(html)).querySelector('th').innerHTML;
                window.getSelection().removeAllRanges();
            }
            const units=blocks.collectSearchableBlocks(f.edit,{includeDocTitle:false});
            const scope=selectionApi.getSelectionScope(f.edit,units,undefined,false,snap);
            const found=await calculateSearchMatches({},f.edit,'foo',{includeDocTitle:false,selectionOnly:true,selectionScope:scope});
            assert.equal(found.matches.length,1,'one selected repeated word');
            assert.equal(found.matches[0].range.startOffset,offset,'snapshot must not drift to another duplicate');
            if (!editor) {
                const direct=await calculateSearchMatches({},f.edit,'foo',{includeDocTitle:false,selectionOnly:true});
                assert.equal(direct.matches.length,1); assert.equal(direct.matches[0].range.startOffset,offset,'live slice selection');
            }
            window.getSelection().removeAllRanges();
            const result=all ? await write.replaceAllMatchesInEditor(f.edit,found.matches,'bar') :
                await write.replaceCurrentMatchInEditor(f.edit,found.matches[0],'bar');
            assert.equal(result.commitState,'confirmed'); assert.equal(result.replacedCount,1);
            const expected=['a','b','foo','foo','foo']; expected[2+(offset-4)/4]='bar';
            assert.equal(savedText(parse(f.kernel.get(id)).querySelector('th')),expected.join(String.fromCharCode(10)));
            f.apply(f.calls[0].undo);
            assert.equal(savedText(parse(f.kernel.get(id)).querySelector('th')),['a','b','foo','foo','foo'].join(String.fromCharCode(10)));
            f.apply(f.calls[0].ops);
            assert.equal(savedText(parse(f.kernel.get(id)).querySelector('th')),expected.join(String.fromCharCode(10)));
        }
        const f=fixture(table(markdown)); f.wysiwyg.innerHTML=nativeTable(f.wysiwyg.innerHTML);
        const cell=f.wysiwyg.querySelector('th');
        selectCellText(cell,5,10);
        const snap=selectionApi.snapshotTableCellTextSelection();
        let units=blocks.collectSearchableBlocks(f.edit,{includeDocTitle:false});
        const cross=selectionApi.getSelectionScope(f.edit,units,undefined,false,snap);
        assert.deepEqual([...cross.values()],[ [{start:1,end:3}], [{start:0,end:2}] ],'cross-line partial selection remains partial');
        const direct=selectionApi.getSelectionScope(f.edit,units);
        assert.deepEqual([...direct], [...cross],'live and captured soft-break selections agree');
        const text=blocks.collectTableCellSearchTextNodes(cell).find(n=>n.data.includes('foo'));
        text.data='x'+text.data.slice(1); window.getSelection().removeAllRanges();
        units=blocks.collectSearchableBlocks(f.edit,{includeDocTitle:false});
        assert.equal(selectionApi.getSelectionScope(f.edit,units,[cell],false,snap).size,0,'stale snapshot must not widen to whole cell');
        const captured=cellScopeVisual.captureSelectionScopeWithKind(f.edit,{includeDocTitle:false},[cell],false,snap);
        assert.equal(captured.scope.size,0); assert.equal(captured.kind,'text','visual capture must not widen a stale rich selection');
        console.log('Rich selection: repeated words, native/editor close, slices, partial cross-line scopes and current/all undo/redo OK');
    }
    {
        const markdown=['# foo heading','','- foo list','','```js','foo','keep','```','','before<br />foo<br />foo end'].join(String.fromCharCode(10));
        for (const before of ['static','native','editor']) for (const after of ['static','native']) for (const occurrence of [0,1,2,3,4]) {
            const html=table(markdown), f=fixture(html), cell=f.wysiwyg.querySelector('th');
            if (before==='native') cell.innerHTML=parse(nativeTable(html)).querySelector('th').innerHTML;
            if (before==='editor') cell.innerHTML='<div class=table__cell-editor><div class=protyle-wysiwyg>'+lute.Md2BlockDOM(markdown)+'</div></div>';
            const raw=blocks.collectTableCellSearchTextNodes(cell).map(node=>node.data).join('');
            const offset=[...raw.matchAll(/foo/g)][occurrence].index;
            selectCellText(cell,offset,offset+3);
            const snap=selectionApi.snapshotTableCellTextSelection();
            cell.innerHTML=parse(after==='native' ? nativeTable(html) : html).querySelector('th').innerHTML;
            // Temporary editor boundary characters must not move a saved word.
            const first=blocks.collectTableCellSearchTextNodes(cell)[0];
            first.data=String.fromCharCode(0x200b)+first.data;
            window.getSelection().removeAllRanges();
            const options={includeDocTitle:false};
            const units=blocks.collectSearchableBlocks(f.edit,options).filter(unit=>occurrence!==4 ||
                !unit.textNodes.some(node=>node.parentElement.closest('h1, [data-type=NodeHeading]')));
            const scope=selectionApi.getSelectionScope(f.edit,units,undefined,false,snap);
            const found=await calculateSearchMatches({},f.edit,'foo',{...options,selectionOnly:true,selectionScope:scope});
            const full=await calculateSearchMatches({},f.edit,'foo',options);
            const expected=full.matches[occurrence];
            assert.equal(found.matches.length,1,'selection transition '+before+'/'+after+'/'+occurrence);
            const label=before+'/'+after+'/'+occurrence;
            assert.equal(found.matches[0].range.startContainer,expected.range.startContainer,label);
            assert.equal(found.matches[0].range.startOffset,expected.range.startOffset,label);
        }
        console.log('Rich selection: static/native/editor transitions, code LF, lists, ZWSP and excluded preceding heading OK');
    }
    {
        const previousSiyuan=window.siyuan, previousHljs=window.hljs;
        window.hljs={getLanguage:()=>true,highlight:text=>{const el=document.createElement('span');el.textContent=text;return {value:el.innerHTML};}};
        const cases=[
            {name:'global',global:true,ial:''},
            {name:'explicit',global:false,ial:'linenumber="true" linewrap="false" ligatures="false" custom-sy-code-tab-spaces="4"'},
            {name:'disabled',global:true,ial:'linenumber="false"'},
        ];
        for (const settings of cases) for (const all of [false,true]) {
            window.siyuan={config:{editor:{fontSize:16,codeSyntaxHighlightLineNum:settings.global,codeLineWrap:false,codeLigatures:false}},languages:{}};
            const markdown=['foo before','{: id="20261019000000-para001"}','','```js','foo','keep','```',settings.ial ? '{: id="20261019000000-code001" '+settings.ial+'}' : ''].join(String.fromCharCode(10));
            const html=table(markdown), f=fixture(html);
            f.wysiwyg.innerHTML=nativeTable(html);
            const cell=f.wysiwyg.querySelector('th'),code=cell.querySelector('.hljs');
            Object.defineProperty(code.lastElementChild,'clientHeight',{value:20,configurable:true});
            rich.beginRichCellSnapshot(); assert.ok(rich.isSupportedRichCell(cell),'before rendering '+settings.name);
            const originalStyle=parse(lute.Md2BlockDOM(rich.decodeRichCell(cell.getAttribute(rich.RICH_CELL_ATTRIBUTE))))
                .querySelector('[data-type=NodeCodeBlock]').getAttribute('style');
            await nativeTable.renderCode(cell);
            if (settings.name!=='disabled') assert.ok(code.parentElement.style.lineHeight,'real lineNumberRender generated root style');
            rich.beginRichCellSnapshot(); assert.ok(rich.isSupportedRichCell(cell),'rendered code remains writable '+settings.name);
            const found=await calculateSearchMatches({},f.edit,'foo',{includeDocTitle:false});
            assert.equal(found.matches.length,2); assert.ok(found.matches.every(hit=>hit.replaceable),'code and same-cell paragraph remain writable');
            const target=found.matches.find(hit=>hit.range.startContainer.parentElement.closest('[data-type=NodeCodeBlock]'));
            assert.ok(target);
            const result=all ? await write.replaceAllMatchesInEditor(f.edit,found.matches,'bar') : await write.replaceCurrentMatchInEditor(f.edit,target,'bar');
            assert.equal(result.commitState,'confirmed',settings.name+' '+JSON.stringify(result)); assert.equal(result.replacedCount,all?2:1);
            const saved=rich.decodeRichCell(parse(f.kernel.get(id)).querySelector('th').getAttribute(rich.RICH_CELL_ATTRIBUTE));
            const savedCode=parse(lute.Md2BlockDOM(saved)).querySelector('[data-type=NodeCodeBlock]');
            assert.equal(savedCode.getAttribute('style'),originalStyle,'derived layout must not enter the saved source');
            for (const name of ['linenumber','linewrap','ligatures','custom-sy-code-tab-spaces']) {
                const original=parse(lute.Md2BlockDOM(markdown)).querySelector('[data-type=NodeCodeBlock]');
                assert.equal(savedCode.getAttribute(name),original.getAttribute(name),'preserve code '+name);
            }
            f.apply(f.calls[0].undo); assert.equal(collect(f.kernel.get(id)).length,2);
            f.apply(f.calls[0].ops); assert.equal(collect(f.kernel.get(id)).length,all?0:1);
        }
        window.siyuan={config:{editor:{fontSize:16,codeSyntaxHighlightLineNum:true,codeLineWrap:false,codeLigatures:false}},languages:{}};
        for (const tamper of ['color','line-height','unrendered']) {
            const cell=parse(nativeTable(table(['```js','foo','```'].join(String.fromCharCode(10))))).querySelector('th');
            const code=cell.querySelector('.hljs'); Object.defineProperty(code.lastElementChild,'clientHeight',{value:20});
            await nativeTable.renderCode(cell);
            rich.beginRichCellSnapshot(); assert.ok(rich.isSupportedRichCell(cell));
            if (tamper==='color') code.parentElement.style.color='blue';
            if (tamper==='line-height') code.parentElement.style.lineHeight='999px';
            if (tamper==='unrendered') code.removeAttribute('data-render');
            rich.beginRichCellSnapshot();
            assert.equal(rich.isSupportedRichCell(cell),false,'do not ignore unverified styles '+tamper);
            assert.equal(rich.prepareRichCellEdit(cell,editsIn(cell,'bar')),undefined);
        }
        window.siyuan=previousSiyuan; window.hljs=previousHljs;
        console.log('Native v3.8.8 lineNumberRender: global/explicit/disabled, code settings, current/all, undo/redo and tamper guards OK');
    }
    for (const [name, markdown] of samples) {
        for (const text of ['bar', '  **bar**  ', 'new' + String.fromCharCode(10) + 'line', '', 'foo']) {
            const cell = parse(nativeTable(table(markdown))).querySelector('th');
            const before = cell.outerHTML;
            rich.beginRichCellSnapshot();
            assert.equal(rich.isSupportedRichCell(cell), true, 'native/' + name);
            const prepared = rich.prepareRichCellEdit(cell, editsIn(cell, text));
            assert.ok(prepared, 'native/' + name + '/' + JSON.stringify(text));
            assert.equal(cell.outerHTML, before);
            rich.publishRichCellEdit(cell, prepared);
            if (text === 'foo') assert.equal(cell.outerHTML, before);
            else {
                assert.ok(savedText(cell).includes(text));
                assert.ok(cell.querySelector('.table__cell-rich > [data-table-cell-node]'), 'keep native preview');
            }
        }
        const raw = collect(table(markdown));
        const native = collect(nativeTable(table(markdown)));
        assert.deepEqual(native.map(x => [x.unitId, x.start, x.end, x.matchedText]), raw.map(x => [x.unitId, x.start, x.end, x.matchedText]), 'static/native identity ' + name);
    }
    for (const all of [false, true]) for (const coverage of ['live', 'fetched', 'virtual', 'selected']) {
        const html = original;
        const native = nativeTable(html);
        const matches = collect(native);
        const f = fixture(html, {loaded: coverage !== 'fetched', virtual: coverage === 'virtual'});
        if (coverage !== 'fetched') f.wysiwyg.innerHTML = nativeTable(f.wysiwyg.innerHTML);
        if (coverage === 'selected') {
            const range = document.createRange();
            range.selectNodeContents(f.wysiwyg.querySelector('.table__cell-rich')); range.collapse(true);
            window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        }
        const result = all ? await write.replaceAllMatchesInEditor(f.edit, matches, 'bar') : await write.replaceCurrentMatchInEditor(f.edit, matches[0], 'bar');
        assert.equal(result.commitState, 'confirmed', 'native ' + all + '/' + coverage + ': ' + JSON.stringify(result));
        assert.equal(result.replacedCount, all ? 7 : 1);
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ops.length, 1);
        assert.equal(collect(nativeTable(f.kernel.get(id))).length, all ? 0 : 6);
        f.apply(f.calls[0].undo); assert.equal(collect(nativeTable(f.kernel.get(id))).length, 7);
        f.apply(f.calls[0].ops); assert.equal(collect(nativeTable(f.kernel.get(id))).length, all ? 0 : 6);
    }
    {
        const f = fixture(original); f.wysiwyg.innerHTML = nativeTable(original);
        const found = await calculateSearchMatches({}, f.edit, 'foo', {includeDocTitle: false});
        assert.equal(found.matches.length, 7); assert.ok(found.matches.every(hit => hit.replaceable));
        const result = await write.replaceAllMatchesInEditor(f.edit, found.matches, 'bar');
        assert.equal(result.commitState, 'confirmed'); assert.equal(result.replacedCount, 7);
    }
    for (const all of [false, true]) for (const fetched of [false, true]) for (const nativeMatch of [false, true]) {
        const html = table('first<br />foo<br />foo end');
        const matches = collect(nativeMatch ? nativeTable(html) : html);
        const f = fixture(html, {loaded: !fetched});
        if (!fetched) f.wysiwyg.innerHTML = nativeTable(html);
        if (!fetched) {
            const found = await calculateSearchMatches({}, f.edit, 'foo', {includeDocTitle: false});
            assert.equal(found.matches.length, 2);
            assert.ok(found.matches.every(hit => hit.replaceable && hit.range.toString() === 'foo'), 'native soft-break range offsets');
        }
        const result = all ? await write.replaceAllMatchesInEditor(f.edit, matches, 'bar') :
            await write.replaceCurrentMatchInEditor(f.edit, matches[0], 'bar');
        assert.equal(result.commitState, 'confirmed', 'soft-break ' + all + '/' + fetched + '/' + nativeMatch + ': ' + JSON.stringify(result));
        assert.equal(result.replacedCount, all ? 2 : 1);
        assert.equal(collect(nativeTable(f.kernel.get(id))).length, all ? 0 : 1);
        f.apply(f.calls[0].undo); assert.equal(collect(nativeTable(f.kernel.get(id))).length, 2);
    }
    {
        const cell = parse(nativeTable(table('- [x] foo'))).querySelector('th');
        cell.querySelector('[data-type=NodeListItem]').classList.remove('protyle-task--done');
        rich.beginRichCellSnapshot();
        assert.equal(rich.isSupportedRichCell(cell), false, 'changed native task state must remain protected');
        const f = fixture(table('first<br />**foo** then foo'));
        f.wysiwyg.innerHTML = nativeTable(f.wysiwyg.innerHTML);
        const found = await calculateSearchMatches({}, f.edit, 'foo', {includeDocTitle: false, restrictInlineTypes: ['strong']});
        assert.equal(found.matches.length, 1, 'inline scope follows sliced native Text coordinates');
        assert.equal(found.matches[0].range.toString(), 'foo');
    }
    {
        const html = table('before<br />foo<br />foo end');
        const f = fixture(html, {loaded:false});
        const expand = source('shared/regex-replace').expandRegexReplacement;
        const regexMatcher = {expandReplacements:async requests=>({expansions:requests.flatMap(unit=>
            unit.replacements.map(hit=>({id:hit.id,haystack:unit.haystack,replacement:expand({haystack:unit.haystack,
                start:hit.start,end:hit.end,patternSource:'f(oo)',template:'$1!',caseSensitive:false})})))})};
        const result = await write.replaceAllMatchesInEditor(f.edit,collect(nativeTable(html)),'$1!',{regex:true,searchQuery:'f(oo)',regexMatcher});
        assert.equal(result.commitState,'confirmed'); assert.equal(result.replacedCount,2);
        assert.equal(collect(nativeTable(f.kernel.get(id)),'oo!').length,2,'native line identity survives fetched regex planning');
    }
    {
        const md = ['```js', 'foo', 'keep', '```'].join(String.fromCharCode(10));
        const cell = parse(nativeTable(table(md))).querySelector('th');
        const code = cell.querySelector('.hljs');
        code.firstElementChild.className = 'protyle-linenumber__rows';
        code.firstElementChild.textContent = 'foo';
        code.lastElementChild.setAttribute('style', 'white-space: pre; padding-left: 32px;');
        code.lastElementChild.innerHTML = '<span class=hljs-name>foo</span>' + String.fromCharCode(10) + 'keep' + String.fromCharCode(10);
        assert.equal(rich.isSupportedRichCell(cell), true);
        const prepared = rich.prepareRichCellEdit(cell, editsIn(cell, 'bar').filter(edit => !edit.nodes[0].parentElement.closest('.protyle-linenumber__rows')));
        assert.ok(prepared, 'native syntax highlighting and line numbers');
        const stale = parse(nativeTable(table('- [foo](https://example.com/a)'))).querySelector('th');
        stale.querySelector('[data-type~=a]').setAttribute('data-href','https://example.com/changed');
        rich.beginRichCellSnapshot(); assert.equal(rich.isSupportedRichCell(stale), false, 'same text does not bypass source marks');
    }
    {
        const cells = Array.from({length: 100}, (_, index) => '<td data-sy-table-cell-rich=' + encode('- target-' + index + String.fromCharCode(10) + '- keep') + '></td>');
        const html = lute.SpinBlockDOM('<div data-type=NodeTable data-node-id=' + id + '><div contenteditable=true><table><thead><tr>' + cells.join('') + '</tr></thead></table></div></div>');
        const f = fixture(html);
        Object.keys(richMethodCounts).forEach(key => richMethodCounts[key] = 0);
        const start = performance.now();
        const units = blocks.collectSearchableBlocks(f.edit, {includeDocTitle: false}).map(unit => freezeBlock(unit));
        const freezeMs = performance.now() - start;
        assert.ok(units.length >= 200);
        assert.equal(Object.values(richMethodCounts).reduce((a,b)=>a+b,0), 0, 'freeze does not model any rich cell');
        const absent = await calculateSearchMatches({}, f.edit, 'absent-keyword', {includeDocTitle: false});
        assert.equal(absent.matches.length, 0);
        assert.equal(Object.values(richMethodCounts).reduce((a,b)=>a+b,0), 0, 'zero-hit search does not convert source');
        const target = units.find(unit => unit.text === 'target-48');
        assert.ok(target.richCell);
        let resolved = await rich.resolveRichCellCapabilities([target.richCell]);
        assert.ok(resolved.get(target.richCell).writableSpans.length);
        assert.deepEqual(richMethodCounts, {Md2BlockDOM:2, BlockDOM2Md:1, SpinBlockDOM:2}, 'only one matched cell is modeled');
        await rich.resolveRichCellCapabilities([target.richCell]);
        assert.deepEqual(richMethodCounts, {Md2BlockDOM:2, BlockDOM2Md:1, SpinBlockDOM:2}, 'immutable snapshot reuse');
        const next = blocks.collectSearchableBlocks(f.edit, {includeDocTitle: false}).map(unit=>freezeBlock(unit)).find(unit=>unit.text==='target-48');
        await rich.resolveRichCellCapabilities([next.richCell]);
        assert.deepEqual(richMethodCounts, {Md2BlockDOM:2, BlockDOM2Md:1, SpinBlockDOM:2}, 'unchanged live cell reuse across collections');
        const controller = new AbortController();
        window.setTimeout(()=>controller.abort(),0);
        resolved = await rich.resolveRichCellCapabilities(units.filter(unit=>unit.richCell).map(unit=>unit.richCell), ()=>!controller.signal.aborted);
        assert.equal(resolved, undefined, 'cancel between cells, never publish incomplete capabilities');
        assert.ok(richMethodCounts.SpinBlockDOM < 200, 'cancel stops remaining source conversions');
        console.log('100 rich cells: zero source conversions for collection/no-hit search; hit-only validation/caching/cancellation OK', {freezeMs: Math.round(freezeMs)});
    }
    {
        const {DatabaseSync} = require('node:sqlite');
        const corpus = source('frontend/corpus/search');
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT);CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)');
        db.function('search_normalize', text => String(text).toLowerCase());
        db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,'rich-root','rich-root','t','','foo','foo','','hash','1');
        for (const markdown of ['first<br />foo<br />foo end', imageSamples[2], imageSamples[4]]) for (const loaded of [false, true]) {
            corpus.invalidateDocumentSearchCaches();
            const html = table(markdown);
            const f = fixture(html, {loaded});
            f.protyle.protyle.block = {id:'rich-root',rootID:'rich-root'};
            if (loaded) f.wysiwyg.innerHTML = nativeTable(html);
            api = async (url, body) => {
                if (url === '/api/query/sql') return {code:0,data:db.prepare(body.stmt).all()};
                if (url === '/api/block/getDocBlocksOrders') return {code:0,data:[id]};
                if (url === '/api/block/getBlockDOMs') return {code:0,data:{[id]:f.kernel.get(id)}};
                return {code:0,data:[]};
            };
            let found = await corpus.searchCurrentDocument({}, f.edit, 'foo', {includeDocTitle:false,includeAttributeView:false,includeFoldedBlocks:true});
            assert.equal(found.error,''); assert.equal(found.partial,false); assert.equal(found.degraded,false);
            assert.equal(found.matches.length,2); assert.ok(found.matches.every(hit=>hit.replaceable),'corpus hit-only eligibility, loaded=' + loaded);
            if (loaded) assert.ok(found.matches.every(hit=>hit.range?.toString()==='foo'),'full corpus native line ranges');
            if (markdown.includes('![')) {
                const result = await write.replaceAllMatchesInEditor(f.edit, found.matches, 'bar');
                assert.equal(result.commitState, 'confirmed');
                assert.equal(result.replacedCount, 2, 'full-document loaded/unloaded writable count agrees with submission');
                assert.deepEqual(imageValues(f.kernel.get(id)), imageValues(html));
                f.apply(f.calls[0].undo);
                corpus.invalidateDocumentSearchCaches();
                found = await corpus.searchCurrentDocument({}, f.edit, 'foo', {includeDocTitle:false,includeAttributeView:false,includeFoldedBlocks:true});
                assert.equal(found.matches.length, 2, 'full-document image-neighbor undo restores all matches');
                assert.ok(found.matches.every(hit=>hit.replaceable));
            }
            Object.keys(richMethodCounts).forEach(key=>richMethodCounts[key]=0);
            found = await corpus.searchCurrentDocument({}, f.edit, 'absent-keyword', {includeDocTitle:false,includeAttributeView:false,includeFoldedBlocks:true});
            assert.equal(found.matches.length,0);
            assert.equal(Object.values(richMethodCounts).reduce((a,b)=>a+b,0),0,'corpus no-hit search never converts rich source');
        }
        corpus.invalidateDocumentSearchCaches(); db.close();
        console.log('Full corpus: native live/static unloaded soft-break and image identity, writable counts, submission/undo and no-hit conversion budget OK');
    }
    console.log('Native v3.8.8 rich previews: literal/format/identity, current/all x live/fetched/virtual/selected, undo/redo and search OK');

    console.log("Current/all × live/fetched/virtual/selected, mixed cells, undo/redo, no-op, atomic cancel, sync/async failure and DOM search OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
