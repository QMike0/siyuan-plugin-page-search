// Real source functions + SQLite/jsdom contracts; not a SiYuan client E2E test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {DatabaseSync} = require("node:sqlite");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let api;
let editors = [];
const menus = [];
class Menu {
    constructor() {
        this.items = [];
        this.element = document.createElement("div");
        menus.push(this);
    }
    addItem(item) {
        this.items.push(item);
    }
    addSeparator() {}
    open() {}
    close() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {fetchSyncPost: (...args) => api(...args), getAllEditor: () => editors, showMessage: () => {}, Menu};
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    mod._compile(
        ts.transpileModule(fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'), {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
            fileName: file,
        }).outputText,
        file,
    );
};
const source = (file) => require(path.join(repo, "src", file + ".ts"));
const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = dom.window;
global.document = window.document;
for (
    const name of [
        "Node",
        "Element",
        "HTMLElement",
        "Text",
        "NodeFilter",
        "ShadowRoot",
        "MutationObserver",
        "Range",
        "HTMLTableElement",
        "HTMLTableRowElement",
        "HTMLTableCellElement",
    ]
) {
    global[name] = window[name];
}
global.CSS = {escape: value => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
Element.prototype.getClientRects = () => [{width: 100, height: 20}];
Range.prototype.getClientRects = () => [{width: 100, height: 20}];
const matcher = source("shared/match-text");
const {effectiveSearchQuery} = source("shared/constants");
const prefs = source("shared/rpc-types");
const {expandRegexReplacement} = source("shared/regex-replace");
const {RegexTextMatcher} = source("frontend/regex-matcher");
const {SearchBar} = source("frontend/search-bar");
const {calculateSearchMatches} = source("frontend/pipeline");
const corpus = source("frontend/corpus/search");
const blocks = source("frontend/blocks");
const write = source("frontend/protyle-write");
const sql = source("frontend/corpus/sql");
const av = source("frontend/corpus/av");
const extraction = source("frontend/corpus/extract");
const unit = text => ({blockId: "b", blockType: "NodeParagraph", blockIndex: 0, text, segmentLengths: [text.length]});
const hits = (text, query, options = {}) => matcher.matchTextUnitsDetailed([unit(text)], query, options).hits;

async function main() {
    assert.equal(effectiveSearchQuery("  foo  "), "foo");
    assert.equal(effectiveSearchQuery("\u200B\u2060"), "");
    assert.deepEqual(matcher.generateSearchVariants(" foo ", false), [" foo ", "foo"]);
    assert.deepEqual(matcher.generateSearchVariants("foo bar"), ["foo bar", "foobar"]);
    assert.equal(hits("foo bar foobar", "foo bar").length, 2);
    assert.equal(hits("Foo foo FOO", " foo ").length, 3);
    assert.equal(hits("Foo foo FOO", " foo ", {caseSensitive: true}).length, 1);
    assert.equal(hits("foo bar foobar", "foo bar", {wholeWord: true}).length, 2);
    for (const space of [" ", "\t", "\n", "\u00A0", "\u3000"]) {
        const text = "foo|" + space + "foo" + space + "|foo";
        assert.equal(hits(text, space + "foo" + space).length, 3, "padded text query uses loose trimming");
        assert.equal(hits(text, space).length, 2, "pure whitespace stays searchable");
    }
    assert.equal(hits("   ", "  ").length, 1, "pure whitespace retains the full query run");
    const marked = hits("x fo\u2060o y", " foo ");
    assert.deepEqual(marked.map(hit => [hit.start, hit.end, hit.matchedText, hit.replaceable]), [
        [2, 6, "fo\u2060o", false],
    ]);
    assert.deepEqual(hits(" İx ", " i\u0307x ").map(hit => [hit.start, hit.end, hit.matchedText]), [[1, 3, "İx"]]);
    assert.equal(hits("é Ａ 搜尋", "e\u0301").length, 0);
    assert.equal(hits("é Ａ 搜尋", "A").length, 0);
    assert.equal(hits("é Ａ 搜尋", "搜寻").length, 0);
    for (const separator of "，。！？；：、（）【】［］｛｝《》〈〉「」『』“”‘’〔〕…—～·") {
        const text = separator + "你好" + separator;
        assert.equal(hits(text, "你好", {wholeWord: true}).length, 1, "Chinese punctuation is a built-in boundary");
        assert.equal(hits(text, "你好", {regex: true, wholeWord: true}).length, 1);
    }
    for (const text of ["你好世界", "你好_世界", "世界\u2060你好"]) {
        assert.equal(hits(text, "你好", {wholeWord: true}).length, 0);
    }
    assert.equal(hits("foo\u2060bar", "foo", {wholeWord: true}).length, 0);
    assert.equal(hits("x(foo)y", "(foo)", {wholeWord: true}).length, 0, "outer word boundary behavior is retained");
    const probe = matcher.createTextMatchProbe(" foo bar ", {});
    assert.equal(probe("foobar"), true);
    assert.equal(probe("foo bar"), true);
    assert.equal(probe("unrelated"), false);
    const oldOptions = {literalMatchMode: "exact", chinesePunctuationBoundary: false};
    assert.deepEqual(hits("foo bar foobar", " foo bar ", oldOptions), hits("foo bar foobar", "foo bar"));
    assert.equal(hits("你好，世界", "你好", {...oldOptions, wholeWord: true}).length, 1);

    const denseText = " foo bar，".repeat(12000);
    const asyncMatcher = new RegexTextMatcher();
    for (const query of [" foo bar ", "foo", " "]) {
        const options = {wholeWord: query !== " "};
        assert.deepEqual(
            await asyncMatcher.match([unit(denseText)], query, options),
            matcher.matchTextUnitsDetailed([unit(denseText)], query, options),
        );
    }
    let receive;
    let response;
    global.self = {addEventListener: (_type, handler) => receive = handler, postMessage: value => response = value};
    source("frontend/regex-worker");
    for (const regex of [false, true]) {
        const options = {regex, wholeWord: true};
        receive({data: {id: 1, kind: "match", units: [unit("你好，世界")], query: "你好", options}});
        assert.deepEqual(response.result.hits, hits("你好，世界", "你好", options));
    }
    asyncMatcher.dispose();
    console.log(
        "literal options: loose variants, whitespace, markers, offsets, built-in boundaries and chunk/Worker parity OK",
    );

    const regexOptions = {regex: true, regexUnicode: true, regexMultiline: true, regexDotAll: true};
    for (
        const value of [
            prefs.DEFAULT_PREFS,
            prefs.coercePluginPrefs({...oldOptions, ...regexOptions}),
            prefs.mergePrefs(prefs.DEFAULT_PREFS, {...oldOptions, ...regexOptions}),
        ]
    ) {
        assert.equal(Object.hasOwn(value, "literalMatchMode"), false);
        assert.equal(Object.hasOwn(value, "chinesePunctuationBoundary"), false);
        for (const key of ["regexUnicode", "regexMultiline", "regexDotAll"]) {
            assert.equal(Object.hasOwn(value, key), false, "removed flags are not persisted");
        }
    }
    for (
        const args of [
            [{query: " foo ", units: [], options: {...oldOptions, ...regexOptions}}],
            [{query: " foo ", units: [], ...regexOptions}],
            [" foo ", [], {...oldOptions, ...regexOptions}],
        ]
    ) {
        const request = prefs.normalizeMatchRequest(args);
        assert.equal(Object.hasOwn(request, "literalMatchMode"), false);
        assert.equal(Object.hasOwn(request, "chinesePunctuationBoundary"), false);
        assert.deepEqual(prefs.matchOptionsFromRequest(request), {
            dedupeOverlaps: undefined,
            caseSensitive: undefined,
            wholeWord: undefined,
            regex: true,
        });
        for (const key of ["regexUnicode", "regexMultiline", "regexDotAll"]) {
            assert.equal(Object.hasOwn(request, key), false, "old RPC flags are discarded");
        }
    }
    const legacyEscape = matcher.matchTextUnitsDetailed([unit("a")], "\\a", {regex: true});
    assert.equal(legacyEscape.hits.length, 1);
    assert.deepEqual(matcher.matchTextUnitsDetailed([unit("a")], "\\a", regexOptions), legacyEscape);
    assert.equal(expandRegexReplacement({haystack: "a", start: 0, end: 1, patternSource: "\\a", template: "X"}), "X");
    assert.equal(
        expandRegexReplacement({
            haystack: "a",
            start: 0,
            end: 1,
            patternSource: "\\a",
            template: "X",
            regexUnicode: true,
        }),
        "X",
    );
    for (
        const [text, pattern, expected] of [
            ["bar\nfoo\nbaz", "^(foo)$", []],
            ["foo\nbar", "foo(.)bar", []],
            ["😀", "(.)", ["\uD83D", "\uDE00"]],
        ]
    ) {
        const options = {...regexOptions, caseSensitive: true};
        const found = hits(text, pattern, options);
        assert.deepEqual(found.map(hit => hit.matchedText), expected);
        const disabled = hits(text, pattern, {regex: true, caseSensitive: true});
        assert.deepEqual(found, disabled, "old flags cannot change matching semantics");
        receive({data: {id: 2, kind: "match", units: [unit(text)], query: pattern, options}});
        assert.deepEqual(response.result.hits, disabled, "Worker ignores old flags too");
        for (const hit of found) {
            assert.equal(
                expandRegexReplacement({
                    haystack: text,
                    start: hit.start,
                    end: hit.end,
                    patternSource: pattern,
                    template: "[$1]",
                    ...options,
                }),
                "[" + hit.matchedText + "]",
                "replacement uses the same disabled flags and UTF-16 offsets",
            );
        }
    }
    assert.equal(hits("A a", "a", regexOptions).length, 2);
    assert.equal(hits("A a", "a", {...regexOptions, caseSensitive: true}).length, 1);
    assert.equal(
        matcher.matchTextUnitsDetailed(
            [{...unit("foo"), unitId: "a"}, {...unit("bar"), unitId: "b"}],
            "foo.*bar",
            {regex: true, regexDotAll: true},
        ).hits.length,
        0,
        "dotAll cannot cross text units",
    );
    console.log(
        "literal options: old prefs/RPC fields ignored; regex defaults and search/replacement semantics retained",
    );

    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive, hanSensitive) => {
        assert.equal(hanSensitive, 1);
        return sensitive ? String(text) : Array.from(String(text)).map(c => c === "İ" ? "i" : c.toLowerCase()).join("");
    });
    db.exec(
        "CREATE TABLE blocks(id TEXT, root_id TEXT, parent_id TEXT, type TEXT, subtype TEXT, content TEXT, markdown TEXT, ial TEXT, hash TEXT, updated TEXT)",
    );
    const insert = db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)");
    const doms = {};
    const html = (id, text) =>
        '<div data-node-id="' + id + '" data-type="NodeParagraph"><div contenteditable="true">' + text + "</div></div>";
    const add = (id, text, content = text) => {
        insert.run(id, "r", "r", "p", "", content, content, "", "h-" + id, "1");
        doms[id] = html(id, text);
    };
    add("a", "foo bar foobar");
    add("b", "  foo  foobar foo bar  ");
    add("c", "你好，世界");
    add("d", "中 foo 文");
    add("e", " fo\u2060o ");
    add("f", " İx ");
    add("g", '<span data-type="strong"> foo </span>', " foo ");
    add("spaces", "   ");
    add("tabs", "\t\t");
    add("lines", "bar\nfoo\nbaz");
    add("dotall", "foo\nbar");
    let candidateCalls = 0;
    let domCalls = 0;
    let domBlockReads = 0;
    api = async (url, body) => {
        if (url.endsWith("/sql")) {
            if (/SELECT id FROM blocks/.test(body.stmt) && /instr\(.*content/.test(body.stmt)) candidateCalls++;
            return {code: 0, data: db.prepare(body.stmt).all()};
        }
        if (url.endsWith("getDocBlocksOrders")) {
            const rootIds = new Set(
                db.prepare("SELECT id FROM blocks WHERE root_id = ?").all(body.id).map(row => row.id),
            );
            return {code: 0, data: Object.keys(doms).filter(id => rootIds.has(id))};
        }
        if (url.includes("getBlockDOMs")) {
            domCalls++;
            domBlockReads += body.ids.length;
            return {code: 0, data: Object.fromEntries(body.ids.map(id => [id, doms[id]]))};
        }
        return {code: 0, data: []};
    };
    // Test a renderer-inserted edge space separately: generated spaces are absent from source content.
    insert.run("autospace", "auto", "auto", "p", "", "中foo文", "中foo文", "", "h", "1");
    assert.ok((await sql.fetchContentCandidateIds("auto", " foo ", true)).includes("autospace"));
    assert.ok((await sql.fetchContentCandidateIds("r", " i\u0307x ", false)).includes("f"));
    const blankDoms = {
        code:
            '<div data-node-id="code" data-type="NodeCodeBlock" data-subtype="javascript"><div contenteditable="true">   </div></div>',
        heading:
            '<div data-node-id="heading" data-type="NodeHeading" data-subtype="h1"><div contenteditable="true"> \t </div></div>',
        table:
            '<div data-node-id="table" data-type="NodeTable"><table><tbody><tr><td>   </td></tr></tbody></table></div>',
        diagram:
            '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid"><div><svg><text>   </text></svg></div></div>',
    };
    const blankExtracted = await extraction.extractUnitsFromDoms(
        Object.keys(blankDoms),
        blankDoms,
        {includeDocTitle: false},
        new Set(),
        "none",
    );
    try {
        for (const blockId of ["code", "heading", "table"]) {
            assert.ok(blankExtracted.blocks.some(block => block.blockId === blockId && block.text.length));
        }
        assert.ok(!blankExtracted.blocks.some(block => block.blockId === "diagram"));
    } finally {
        blankExtracted.dispose();
    }
    const edit = document.createElement("div");
    edit.className = "protyle";
    edit.innerHTML = '<div class="protyle-content"><div class="protyle-wysiwyg"></div></div>';
    document.body.appendChild(edit);
    const wysiwyg = edit.querySelector(".protyle-wysiwyg");
    let commits = 0;
    const protyle = {
        protyle: {element: edit, notebookId: "", block: {rootID: "r", id: "r"}, disabled: false},
        transaction: () => commits++,
        updateTransactionElement: () => commits++,
    };
    editors = [protyle];
    const search = (query, options = {}) =>
        corpus.searchCurrentDocument({}, edit, query, {
            includeAttributeView: false,
            includeDocTitle: false,
            includeFoldedBlocks: true,
            ...options,
        });
    const compact = matches => matches.map(hit => [hit.blockId, hit.start, hit.end, hit.matchedText]);
    for (
        const [query, options] of [
            [" foo ", {}],
            ["foo bar", {}],
            [" ", {}],
            ["\t", {}],
            [" foo ", {wholeWord: true}],
            ["你好", {wholeWord: true}],
            ["你好", {wholeWord: true, regex: true}],
            [" foo ", {restrictInlineTypes: ["strong"]}],
            ["foo", regexOptions],
            ["^bar", regexOptions],
            ["foo([\\s\\S])bar", regexOptions],
        ]
    ) {
        corpus.invalidateDocumentSearchCaches();
        wysiwyg.innerHTML = "";
        const cold = await search(query, options);
        assert.equal(cold.partial, false);
        assert.equal(cold.degraded, false);
        assert.ok(cold.matches.length > 0);
        wysiwyg.innerHTML = Object.values(doms).join("");
        const loaded = await search(query, options);
        assert.deepEqual(compact(cold.matches), compact(loaded.matches), "loaded/unloaded matching and offsets agree");
        assert.ok(loaded.matches.every(hit => hit.range.toString() === hit.matchedText));
        const liveBlocks = blocks.collectSearchableBlocks(edit, {includeDocTitle: false});
        const selectionScope = new Map(
            liveBlocks.map(
                block => [block.blockId + "::" + (block.unitId ?? ""), [{start: 0, end: block.text.length}]],
            ),
        );
        const selection = await calculateSearchMatches({}, edit, query, {
            includeDocTitle: false,
            selectionOnly: true,
            selectionScope,
            ...options,
        });
        assert.deepEqual(
            compact(selection.matches),
            compact(loaded.matches),
            "selection path shares matching semantics",
        );
    }
    for (const [query, blockId] of [["^(foo)$", "lines"], ["foo(.)bar", "dotall"]]) {
        corpus.invalidateDocumentSearchCaches();
        wysiwyg.innerHTML = "";
        const cold = await search(query, regexOptions);
        assert.ok(!cold.matches.some(hit => hit.blockId === blockId), "old flags stay disabled in unloaded content");
        assert.equal(cold.partial, false);
        wysiwyg.innerHTML = Object.values(doms).join("");
        const loaded = await search(query, regexOptions);
        assert.ok(!loaded.matches.some(hit => hit.blockId === blockId), "old flags stay disabled in loaded content");
        assert.deepEqual(compact(cold.matches), compact(loaded.matches));
        assert.deepEqual(compact(loaded.matches), compact((await search(query, {regex: true})).matches));
        assert.equal(loaded.partial, false);
    }
    corpus.invalidateDocumentSearchCaches();
    wysiwyg.innerHTML = "";
    const loose = await search("foo");
    const beforeCandidates = candidateCalls;
    const beforeDoms = domCalls;
    const padded = await search(" foo ");
    assert.deepEqual(compact(padded.matches), compact(loose.matches));
    assert.equal(candidateCalls, beforeCandidates, "padded query reuses candidate cache");
    assert.equal(domCalls, beforeDoms, "padded query reuses extraction cache");
    for (const [query, blockId, count] of [[" ", "spaces", 3], ["\t", "tabs", 2]]) {
        corpus.invalidateDocumentSearchCaches();
        const cold = await search(query);
        assert.equal(cold.matches.filter(hit => hit.blockId === blockId).length, count);
        const reads = domBlockReads;
        const warm = await search(query);
        assert.deepEqual(compact(warm.matches), compact(cold.matches));
        assert.equal(domBlockReads, reads, "pure-whitespace text uses hash-validated cache");
    }
    for (let i = 0; i < 1000; i++) {
        const id = "perf-" + String(i).padStart(4, "0");
        insert.run(id, "perf", "perf", "p", "", "unrelated content", "unrelated content", "", "h", "1");
        doms[id] = html(id, "unrelated content");
    }
    insert.run("perf-hit", "perf", "perf", "p", "", "needle", "needle", "", "h", "1");
    doms["perf-hit"] = html("perf-hit", "needle");
    protyle.protyle.block.rootID = "perf";
    protyle.protyle.block.id = "perf";
    corpus.invalidateDocumentSearchCaches();
    const perfReads = domBlockReads;
    const perfResult = await search(" needle ", {caseSensitive: true});
    assert.equal(perfResult.matches.length, 1);
    assert.equal(perfResult.partial, false);
    assert.equal(domBlockReads - perfReads, 1, "one hit does not extract 1000 unrelated blocks");
    corpus.invalidateDocumentSearchCaches();
    const regexReads = domBlockReads;
    const regexPerfResult = await search("needle", {...regexOptions, caseSensitive: true});
    assert.equal(regexPerfResult.matches.length, 1);
    assert.equal(regexPerfResult.partial, false);
    assert.equal(domBlockReads - regexReads, 1, "old u flag does not disable selective regex candidate filtering");
    protyle.protyle.block.rootID = "r";
    protyle.protyle.block.id = "r";
    corpus.invalidateDocumentSearchCaches();

    wysiwyg.innerHTML = html("b", "foo| foo |foo");
    const selected = await calculateSearchMatches({}, edit, " foo ", {
        includeDocTitle: false,
        selectionOnly: true,
        selectionScope: new Map([["b::", [{start: 4, end: 9}]]]),
    });
    assert.equal(selected.matches.length, 1);
    assert.equal(selected.matches[0].matchedText, "foo");
    const replaced = await write.replaceCurrentMatchInEditor(edit, selected.matches[0], "X");
    assert.equal(replaced.replacedCount, 1);
    assert.equal(commits, 1);
    assert.equal(
        wysiwyg.textContent,
        "foo| X |foo",
        "loose replacement uses original offsets and keeps unmatched edge spaces",
    );
    console.log(
        "literal options: SQL/cache, loaded/unloaded/selection/restrict, bounded offscreen work and replacement OK",
    );

    const bar = Object.create(SearchBar.prototype);
    const searchButton = document.createElement("button");
    Object.assign(bar, {
        edit,
        dialog: document.createElement("div"),
        searchMethodBtn: searchButton,
        ...regexOptions,
        regex: false,
        wholeWord: true,
        searchText: " foo ",
        closeSettingsMenu: () => {},
        i18n: JSON.parse(fs.readFileSync(path.join(repo, "src/i18n/en.json"), "utf8")),
    });
    assert.equal(bar.effectiveQuery(), "foo");
    assert.equal(Object.hasOwn(bar.searchOptions(), "literalMatchMode"), false);
    assert.equal(Object.hasOwn(bar.searchOptions(), "chinesePunctuationBoundary"), false);
    for (const key of ["regexUnicode", "regexMultiline", "regexDotAll"]) {
        assert.equal(Object.hasOwn(bar.searchOptions(), key), false, "stale panel state is not forwarded");
    }
    for (const regex of [false, true]) {
        bar.regex = regex;
        bar.openSearchMethodMenu(searchButton);
        const menu = menus.at(-1);
        assert.deepEqual(menu.items.map(item => item.id), [
            "page-search-method-keyword",
            "page-search-method-regex",
        ]);
        assert.ok(menu.items.every(item => !item.submenu), "no independent regex flag controls");
        bar.closeSearchMethodMenu();
    }
    console.log(
        "literal options: menu contains only search modes; u/m/s controls removed and stale panel flags ignored",
    );
    const databaseText = " foo  bar \t";
    const originalApi = api;
    api = async (url, body) => {
        if (url.endsWith("getAttributeView")) return {code: 0, data: {name: "db", views: [{id: "v", name: "view"}]}};
        if (url.endsWith("renderAttributeView")) {
            return {
                code: 0,
                data: {
                    view: {
                        type: "table",
                        columns: [{id: "k", name: "column"}],
                        rowCount: 1,
                        rows: [{
                            id: "row",
                            cells: [
                                {value: {keyID: "k", text: {content: databaseText}}},
                                {value: {keyID: "multi", mSelect: [{content: " A  B "}, {content: " C  D "}]}},
                            ],
                        }],
                    },
                },
            };
        }
        return originalApi(url, body);
    };
    av.invalidateAvCache();
    const avRef = {blockId: "avb", avId: "av-id", updated: "1", carrierViewId: "v"};
    const allApiUnits = await av.loadAvUnits([avRef]);
    assert.equal(allApiUnits.find(unit => unit.unitId === "av:row:multi").text, "A B C D");
    const apiUnits = allApiUnits.filter(unit => unit.unitId === "av:row:k");
    assert.equal(apiUnits[0].text, databaseText);
    const avHtml = '<div data-node-id="avb" data-type="NodeAttributeView" data-av-id="av-id" data-av-type="table" ' +
        'custom-sy-av-view="v"><div class="av__row" data-id="row"><div class="av__cell" data-col-id="k">' +
        '<span class="av__celltext">' + databaseText + "</span></div></div></div>";
    wysiwyg.innerHTML = avHtml;
    const liveUnits = blocks.collectSearchableBlocks(edit, {includeDocTitle: false});
    assert.equal(liveUnits.find(unit => unit.unitId === "cell:nogroup:row:k").text, databaseText);
    for (const query of [databaseText, "  ", "bar \t"]) {
        const apiHits = matcher.matchTextUnitsDetailed(apiUnits, query, {}).hits;
        const liveHits = matcher.matchTextUnitsDetailed(liveUnits, query, {}).hits;
        assert.ok(apiHits.length > 0);
        assert.deepEqual(apiHits.map(hit => [hit.start, hit.end]), liveHits.map(hit => [hit.start, hit.end]));
        assert.ok(apiHits.every(hit => !hit.replaceable));
    }
    insert.run("avb", "r", "r", "av", "", "db", avHtml, 'custom-sy-av-view="v"', "h-avb", "1");
    doms.avb = avHtml;
    corpus.invalidateDocumentSearchCaches();
    wysiwyg.innerHTML = "";
    corpus.retainBackgroundCorpusRoot("r");
    let unsubscribe;
    const settled = new Promise(resolve => {
        unsubscribe = corpus.subscribeIndexSettled(root => {
            if (root === "r") resolve();
        });
    });
    let settleTimer;
    try {
        const initialAv = await search(databaseText, {includeAttributeView: true});
        assert.equal(initialAv.partial, true, "cold API cells use the existing asynchronous index");
        await Promise.race([
            settled,
            new Promise((_, reject) => {
                settleTimer = setTimeout(() => reject(new Error("AV index did not settle")), 3000);
            }),
        ]);
    } finally {
        clearTimeout(settleTimer);
        unsubscribe();
    }
    const coldAv = await search(databaseText, {includeAttributeView: true});
    assert.equal(coldAv.partial, false);
    assert.equal(coldAv.matches.filter(hit => hit.blockId === "avb").length, 1);
    wysiwyg.innerHTML = avHtml;
    const loadedAv = await search(databaseText, {includeAttributeView: true});
    assert.deepEqual(
        loadedAv.matches.map(hit => [hit.start, hit.end, hit.matchedText]),
        coldAv.matches.map(hit => [hit.start, hit.end, hit.matchedText]),
        "full search preserves AV whitespace through API, DOM projection and dedupe",
    );
    corpus.releaseBackgroundCorpusRoot("r");
    av.invalidateAvCache();
    console.log("literal options: AV raw whitespace and loaded/unloaded offsets/count parity OK");
    db.close();
    console.log("literal-options-regressions OK");
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
