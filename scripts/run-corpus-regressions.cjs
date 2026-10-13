// Direct-source contracts. Renderer/API fixtures do not replace real SiYuan E2E tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const {DatabaseSync} = require("node:sqlite");
const {spawnSync} = require("node:child_process");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let api;
let editors = [];
const nativeRenderMethods = {};
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {fetchSyncPost: (...args) => api(...args), getAllEditor: () => editors, ProtyleMethod: nativeRenderMethods};
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
        fileName: file,
    }).outputText;
    mod._compile(output, file);
};
const source = (file) => require(path.join(repo, "src", file + ".ts"));
const matcher = source("shared/match-text");
const {loadAvUnits} = source("frontend/corpus/av");
const hit = (text, query, options = {}) =>
    matcher.matchTextUnitsDetailed(
        [
            {blockId: "b", blockType: "NodeParagraph", blockIndex: 0, text},
        ],
        query,
        options,
    ).hits;
if (process.argv[2] === "zero") {
    let receive;
    let response;
    global.self = {
        addEventListener: (_type, handler) => {
            receive = handler;
        },
        postMessage: (result) => {
            response = result;
        },
    };
    source("frontend/regex-worker");
    for (const unicode of [false, true]) {
        for (const query of ["^", "(?=.)", "^|a", "(?=😀)|a"]) {
            const found = hit("😀a", query, {regex: true, regexUnicode: unicode});
            receive({
                data: {
                    id: 1,
                    kind: "match",
                    units: [{blockId: "b", blockType: "NodeParagraph", blockIndex: 0, text: "😀a"}],
                    query,
                    options: {regex: true, regexUnicode: unicode},
                },
            });
            assert.deepEqual(response.result.hits, found, "Worker shares zero-length behavior");
            assert.equal(found.length, query.includes("|a") ? 1 : 0);
            if (found.length) assert.equal(found[0].start, 2);
        }
    }
    process.exit(0);
}

async function main() {
    const child = spawnSync(process.execPath, [__filename, "zero"], {timeout: 5000, encoding: "utf8"});
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const db = new DatabaseSync(":memory:");
    // Known Go simple-lower differences; not a complete Go/Unicode implementation.
    const goLower = (text) => Array.from(String(text)).map((c) => c === "İ" ? "i" : c.toLowerCase()).join("");
    db.function("search_normalize", (text, sensitive, hanSensitive) => {
        assert.equal(hanSensitive, 1, "candidate normalization preserves Han sensitivity");
        return sensitive ? String(text) : goLower(text);
    });
    db.exec(
        "CREATE TABLE blocks(id TEXT, root_id TEXT, parent_id TEXT, type TEXT, subtype TEXT, content TEXT, markdown TEXT, ial TEXT, hash TEXT, updated TEXT)",
    );
    db.exec("CREATE TABLE spans(id TEXT, block_id TEXT, root_id TEXT, type TEXT)");
    db.exec("CREATE INDEX idx_blocks_root_id ON blocks(root_id); CREATE INDEX idx_spans_root_id ON spans(root_id)");
    const insert = db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?)");
    const add = (id, type, content, language = "", parent = "r", ial = "") =>
        insert.run(
            id,
            "r",
            parent,
            type,
            "",
            content,
            language ? "```" + language + "\n" + content + "\n```" : content,
            ial,
            "h-" + id,
            "1",
        );
    const sql = source("frontend/corpus/sql");
    const regex = source("shared/regex-literals");
    api = async (_url, body) => ({code: 0, data: db.prepare(body.stmt).all()});
    for (
        const [text, query, options] of [
            ["İx", "\u0307", {}],
            ["İx", "\u0307x", {}],
            ["İx", "i\u0307x", {}],
            ["ΟΣ", "ος", {}],
            ["ss", "ss", {regex: true, regexUnicode: true}],
            ["s", "\\w+", {regex: true, regexUnicode: true}],
            ["😀😀", "(?:😀){2}", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["ab", "(?:😀)?ab", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["😀😀", "[😀]{2}", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["😀", "[😀]{2}", {regex: true, regexUnicode: false, caseSensitive: true}],
            ["😀😀", "(?:\\uD83D\\uDE00){2}", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["xaaab", "xa+b", {regex: true, caseSensitive: true}],
            ["xababc", "x(ab)+c", {regex: true, caseSensitive: true}],
            ["xababc", "x(ab){1,3}c", {regex: true, caseSensitive: true}],
            ["x" + "ab".repeat(10) + "c", "x(ab){10}c", {regex: true, caseSensitive: true}],
            ["x" + "ab".repeat(40) + "c", "x(ab){40}c", {regex: true, caseSensitive: true}],
            ["xabbabc", "x(ab{1,2}){2}c", {regex: true, caseSensitive: true}],
            ["ab", "[A-Za-z_]{2}", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["ab", "[a-z中]{2}", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["afoo", "[a-z。]foo", {regex: true, regexUnicode: true, caseSensitive: true}],
            [" foo", "[\\s中]foo", {regex: true, regexUnicode: true, caseSensitive: true}],
            ["afoo", "[\\D中]foo", {regex: true, regexUnicode: true, caseSensitive: true}],
        ]
    ) {
        db.exec("DELETE FROM blocks");
        add("b", "p", text);
        assert.ok(hit(text, query, options).length, "final match: " + query);
        const groups = options.regex ?
            regex.extractRegexLiteralGroups(query, options.caseSensitive === true) :
            null;
        const ids = options.regex ?
            (groups ?
                await sql.fetchLiteralGroupCandidateIds("r", groups, options.caseSensitive === true, "content") :
                ["b"]) :
            await sql.fetchContentCandidateIds("r", query, false);
        assert.ok(ids.includes("b"), "SQL superset: " + query);
    }
    console.log("Unicode termination and SQL superset OK");

    db.exec("DELETE FROM blocks; DELETE FROM spans");
    const insertMemoSpan = db.prepare("INSERT INTO spans VALUES (?,?,?,?)");
    const memoHostIds = [];
    for (let index = 0; index < 5001; index++) {
        const id = "memo-" + String(index).padStart(5, "0");
        memoHostIds.push(id);
        add(id, "p", "host<sup>(memoKeyword)</sup>");
        insertMemoSpan.run("span-" + id, id, "r", "textmark strong inline-memo");
        if (index === 0) insertMemoSpan.run("duplicate-span", id, "r", "textmark inline-memo");
    }
    add("embed", "query_embed", "select * from blocks");
    add("ordinary-sup", "p", "host<sup>memoKeyword</sup>");
    add("lookalike", "p", "host");
    insertMemoSpan.run("lookalike-span", "lookalike", "r", "textmark custom-inline-memo");
    insert.run("foreign", "other-root", "other-root", "p", "", "host", "host", "", "h", "1");
    insertMemoSpan.run("foreign-span", "foreign", "other-root", "textmark inline-memo");
    add("container", "l", "host<sup>(memoKeyword)</sup>");
    const candidateStatements = [];
    api = async (_url, body) => {
        candidateStatements.push(body.stmt);
        return {code: 0, data: db.prepare(body.stmt).all()};
    };
    assert.deepEqual(await sql.fetchMemoCandidateIds("r"), ["embed", ...memoHostIds]);
    assert.equal(candidateStatements.length, 2, "memo hosts are paged without per-host SQL");
    const plan = db.prepare("EXPLAIN QUERY PLAN " + candidateStatements[0]).all().map(row => row.detail).join("\n");
    assert.ok(plan.includes("idx_spans_root_id"), "memo span scan uses the native document index");
    assert.ok(!plan.includes("CORRELATED"), "memo span lookup is not repeated for every block");
    const cancelledMemo = new AbortController();
    cancelledMemo.abort();
    assert.equal(await sql.fetchMemoCandidateIds("r", cancelledMemo.signal), null);
    assert.equal(candidateStatements.length, 2, "cancelled memo lookup issues no SQL or fallback");
    console.log("memo candidates: native span types, pagination, deduplication and indexed document scope OK");

    const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
    global.window = dom.window;
    global.document = dom.window.document;
    for (
        const key of [
            "Node",
            "Element",
            "HTMLElement",
            "Text",
            "NodeFilter",
            "ShadowRoot",
            "MutationObserver",
            "HTMLTableElement",
            "HTMLTableRowElement",
            "HTMLTableCellElement",
            "Range",
        ]
    ) {
        global[key] = dom.window[key];
    }
    global.CSS = {escape: (value) => value};
    global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    dom.window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
    const corpus = source("frontend/corpus/search");
    const extract = source("frontend/corpus/extract");
    const edit = document.createElement("div");
    edit.className = "protyle";
    edit.innerHTML = '<div class="protyle-content"><div class="protyle-wysiwyg"></div></div>';
    document.body.append(edit);
    const wysiwyg = edit.querySelector(".protyle-wysiwyg");
    editors = [{protyle: {element: edit, notebookId: "", block: {id: "r", rootID: "r"}}}];
    let doms = {};
    let domCalls = 0;
    let domReadIds = [];
    let renderCalls = 0;
    let failSql = () => false;
    let domResponder;
    let embedResponder;
    let embedRequests = [];
    let avResponder;
    api = async (url, body, _headers, _process, signal) => {
        if (url === "/api/query/sql") {
            return failSql(body.stmt) ?
                {code: 1} :
                {code: 0, data: db.prepare(body.stmt).all()};
        }
        if (url === "/api/block/getDocBlocksOrders") {
            return {
                code: 0,
                data: db.prepare("SELECT id FROM blocks ORDER BY id").all().map((row) => row.id),
            };
        }
        if (url.includes("getHeadingChildren")) return {code: 0, data: ["b"]};
        if (url.startsWith("/api/av/") && avResponder) return avResponder(url, body, signal);
        if (url === "/api/search/searchEmbedBlock") {
            embedRequests.push(body);
            if (embedResponder) return embedResponder(body, signal);
            const template = document.createElement("template");
            template.innerHTML = doms[body.embedBlockID] ?? "";
            const owner = template.content.firstElementChild;
            return {
                code: 0,
                data: {
                    blocks: owner ?
                        [{block: {id: "fixture-source", rootID: "source-root", content: owner.innerHTML}}] :
                        [],
                },
            };
        }
        if (url.includes("getBlockDOMs")) {
            domCalls += 1;
            domReadIds.push(...body.ids);
            if (domResponder) return domResponder(body, signal);
            return {
                code: 0,
                data: Object.fromEntries(
                    body.ids.filter((id) => doms[id] !== undefined).map((id) => {
                        const template = document.createElement("template");
                        template.innerHTML = doms[id];
                        const owner = template.content.firstElementChild;
                        if (
                            owner?.matches('[data-type="NodeBlockQueryEmbed"]') && !owner.hasAttribute("data-content")
                        ) owner.setAttribute("data-content", "select * from blocks");
                        return [id, owner?.outerHTML ?? doms[id]];
                    }),
                ),
            };
        }
        return {code: 0, data: []};
    };
    const renderer = (host) => {
        renderCalls += 1;
        host.querySelectorAll('[data-subtype="graphviz"], [data-subtype="mermaid"], [data-subtype="flowchart"]')
            .forEach((block) => {
                block.innerHTML = "<div><svg><text>foo</text><text>generated</text></svg></div>";
            });
    };
    const reset = () => {
        delete nativeRenderMethods.mathRender;
        corpus.invalidateDocumentSearchCaches();
        db.exec("DELETE FROM blocks");
        db.exec("DELETE FROM spans");
        wysiwyg.innerHTML = "";
        doms = {};
        domCalls = 0;
        domReadIds = [];
        renderCalls = 0;
        failSql = () => false;
        domResponder = null;
        embedResponder = null;
        embedRequests = [];
        avResponder = null;
        window.Protyle = {graphvizRender: renderer, mermaidRender: renderer, flowchartRender: renderer};
    };
    const search = (query, options = {}) =>
        corpus.searchCurrentDocument({}, edit, query, {
            includeAttributeView: false,
            includeFoldedBlocks: true,
            ...options,
        });
    const full = (result) => {
        assert.equal(result.error, "");
        assert.equal(result.partial, false);
        assert.equal(result.degraded, false);
        assert.equal(result.unrendered, 0);
    };
    const settle = async (query, options) => {
        const until = Date.now() + 5000;
        let result = await search(query, options);
        while (result.partial && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            result = await search(query, options);
        }
        assert.equal(result.partial, false, "index must settle");
        return result;
    };
    try {
        {
            const inlineFormula =
                '<span data-type="inline-math" data-subtype="math" data-content="\\delta" contenteditable="false" class="render-node"><span></span></span>';
            const blockFormula =
                '<div data-node-id="b" data-type="NodeMathBlock" data-subtype="math" data-content="\\delta" class="render-node"><div spin="1"></div></div>';
            const asyncMathRenderer = async host => {
                renderCalls++;
                await new Promise(resolve => setTimeout(resolve, 15));
                host.querySelectorAll('[data-subtype="math"]:not([data-render="true"])').forEach(element => {
                    element.setAttribute("data-render", "true");
                    element.innerHTML = '<span class="katex"><span class="katex-mathml">sourceSecret</span>' +
                        '<span class="katex-html" aria-hidden="true"><span class="base">δ</span></span></span>';
                });
            };
            for (const options of [{}, {regex: true}]) {
                for (const inline of [false, true]) {
                    reset();
                    add("b", inline ? "p" : "m", "\\delta");
                    if (inline) db.exec("UPDATE blocks SET markdown='$\\delta$'");
                    doms.b = inline ?
                        '<div data-node-id="b" data-type="NodeParagraph">before' + inlineFormula + "after</div>" :
                        blockFormula;
                    // Public plugin API works without the export-preview window.Protyle.
                    window.Protyle = undefined;
                    nativeRenderMethods.mathRender = asyncMathRenderer;
                    const rendered = await search("δ", options);
                    full(rendered);
                    assert.equal(rendered.matches.length, 1, "first cold query sees generated glyphs absent from SQL content");
                    assert.ok(!rendered.matches[0].replaceable && !rendered.matches[0].range);
                    assert.equal((await search("delta", options)).matches.length, 0, "rendered/source are exclusive");
                    assert.equal((await search("sourceSecret", options)).matches.length, 0, "MathML is not searchable");
                    const calls = renderCalls;
                    full(await search("δ", options));
                    assert.equal(renderCalls, calls, "unchanged formula host reuses its versioned cache");
                    if (inline) {
                        assert.equal((await search("δ", {...options, restrictInlineTypes: ["inline-math"]})).matches.length, 1);
                        assert.equal((await search("δ", {...options, includeParagraph: false})).matches.length, 0);
                    } else {
                        assert.equal((await search("δ", {...options, includeMathBlock: false})).matches.length, 0);
                    }
                    // Native renderer skips stale data-render=true, so clones must clear it when output is missing.
                    reset();
                    add("a", "h", "heading", "", "r", 'fold="1"');
                    add("b", inline ? "p" : "m", "\\delta");
                    if (inline) db.exec("UPDATE blocks SET markdown='$\\delta$' WHERE id='b'");
                    wysiwyg.innerHTML =
                        '<div data-node-id="a" data-type="NodeHeading" data-subtype="h1" fold="1">heading</div>';
                    doms.b = inline ?
                        '<div data-node-id="b" data-type="NodeParagraph" parent-heading="a">' +
                        inlineFormula.replace('data-subtype="math"', 'data-render="true"') + "</div>" :
                        blockFormula.replace('data-subtype="math"', 'parent-heading="a" data-render="true"');
                    nativeRenderMethods.mathRender = asyncMathRenderer;
                    const heading = await search("δ", options);
                    full(heading);
                    assert.equal(heading.matches.length, 1);
                    assert.equal((await search("δ", {...options, includeFoldedBlocks: false})).matches.length, 0);
                }
            }
            for (const inline of [false, true]) {
                for (const failure of ["missing", "throw", "reject", "error"]) {
                    reset();
                    add("b", inline ? "p" : "m", "\\delta");
                    if (inline) db.exec("UPDATE blocks SET markdown='$\\delta$'");
                    doms.b = inline ?
                        '<div data-node-id="b" data-type="NodeParagraph">' + inlineFormula + "</div>" :
                        blockFormula;
                    if (failure === "throw") {
                        nativeRenderMethods.mathRender = () => {
                            throw new Error("unavailable");
                        };
                    }
                    if (failure === "reject") nativeRenderMethods.mathRender = () => Promise.reject(new Error("load failed"));
                    if (failure === "error") {
                        nativeRenderMethods.mathRender = host => {
                            host.querySelectorAll('[data-subtype="math"]').forEach(element => {
                                element.setAttribute("data-render", "true");
                                element.innerHTML = '<span class="ft__error">parseErrorSecret</span>';
                            });
                        };
                    }
                    const began = performance.now();
                    const fallback = await search("delta");
                    full(fallback);
                    assert.equal(fallback.matches.length, 1, `${inline ? "inline" : "block"} fallback on ${failure}`);
                    assert.ok(fallback.matches[0].unitId.includes("renderer:source-fallback:"));
                    assert.ok(!fallback.matches[0].replaceable && !fallback.matches[0].range);
                    assert.ok(performance.now() - began < 1000, "missing/rejected renderer does not wait the old four seconds");
                    assert.equal((await search("parseErrorSecret")).matches.length, 0);
                    assert.equal((await search("δ")).matches.length, 0, "source fallback cannot invent glyphs");
                    if (inline) {
                        const restricted = await search("delta", {restrictInlineTypes: ["inline-math"]});
                        full(restricted);
                        assert.equal(restricted.matches.length, 1);
                    }
                }
            }
            reset();
            add("b", "m", "\\delta");
            doms.b = blockFormula;
            let finishMath;
            nativeRenderMethods.mathRender = host =>
                new Promise(resolve => {
                    finishMath = () => {
                        host.querySelector('[data-subtype="math"]').innerHTML = '<span class="katex-html">δ</span>';
                        resolve();
                    };
                });
            const mathDeadline = performance.now();
            const timedMath = await search("delta");
            full(timedMath);
            assert.equal(timedMath.matches.length, 1);
            assert.ok(performance.now() - mathDeadline < 1800, "unsettled math has a bounded source fallback");
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            finishMath();
            // KaTeX can already exist while SiYuan is still loading mhchem.
            // Late completion must recover only that formula's source cache, on the next query.
            const readyKatex = window.katex;
            try {
                window.katex = {renderToString() {}};
                for (const location of ["block", "inline", "embed", "live-embed"]) {
                    reset();
                    const paragraph = '<div data-node-id="b" data-type="NodeParagraph">before' + inlineFormula + "after</div>";
                    const embedded = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                        paragraph.replace('data-node-id="b"', 'data-node-id="source"') + "</div>";
                    add("ordinary", "p", "ordinary");
                    doms.ordinary = '<div data-node-id="ordinary" data-type="NodeParagraph">ordinary</div>';
                    add("diagram", "c", "digraph{}", "graphviz");
                    doms.diagram = '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="digraph{}"></div>';
                    full(await search("digraph"));
                    full(await search("ordinary"));
                    add("b", location.includes("embed") ? "query_embed" : location === "block" ? "m" : "p", "\\delta");
                    if (location === "inline") db.exec("UPDATE blocks SET markdown='$\\delta$' WHERE id='b'");
                    doms.b = location.includes("embed") ? embedded : location === "block" ? blockFormula : paragraph;
                    if (location === "live-embed") wysiwyg.innerHTML = embedded;
                    corpus.invalidateDocumentStructureCaches("r");
                    const paint = host => host.querySelectorAll('[data-subtype="math"]').forEach(element => {
                        element.innerHTML = '<span class="katex-html">δ</span>';
                        element.setAttribute("data-render", "true");
                    });
                    let complete;
                    nativeRenderMethods.mathRender = host => new Promise(resolve => {
                        complete = () => { paint(host); resolve(); };
                    });
                    const began = performance.now();
                    const first = await search("delta");
                    full(first);
                    assert.equal(first.matches.length, 1, location + " initially falls back to source");
                    assert.ok(performance.now() - began < 1800);
                    assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
                    const beforeRecovery = domCalls;
                    assert.equal((await search("delta")).matches.length, 1);
                    assert.equal(domCalls, beforeRecovery, "pending source is cached without background retries");
                    const ordinaryReads = domReadIds.filter(id => id === "ordinary").length;
                    const diagramReads = domReadIds.filter(id => id === "diagram").length;
                    complete();
                    await Promise.resolve();
                    nativeRenderMethods.mathRender = paint;
                    const recovered = await search("δ");
                    full(recovered);
                    assert.equal(recovered.matches.length, 1, location + " recovers after late native completion");
                    assert.equal((await search("delta")).matches.length, 0, "recovered glyph replaces source");
                    const recoveredReads = domCalls;
                    assert.equal((await search("δ")).matches.length, 1);
                    assert.equal(domCalls, recoveredReads, "successful recovery is reused");
                    assert.equal(domReadIds.filter(id => id === "ordinary").length, ordinaryReads);
                    assert.equal(domReadIds.filter(id => id === "diagram").length, diagramReads);
                }
                for (const outcome of ["reject", "error", "clear"]) {
                    reset();
                    add("b", "m", "\\delta");
                    doms.b = blockFormula;
                    let complete;
                    nativeRenderMethods.mathRender = host => new Promise((resolve, reject) => {
                        complete = () => {
                            if (outcome === "reject") return reject(new Error("late dependency failure"));
                            host.querySelector('[data-subtype="math"]').innerHTML = outcome === "error" ?
                                '<span class="ft__error">parseErrorSecret</span>' : '<span class="katex-html">δ</span>';
                            resolve();
                        };
                    });
                    full(await search("delta"));
                    if (outcome === "clear") {
                        corpus.invalidateDocumentSearchCaches();
                        nativeRenderMethods.mathRender = host => {
                            host.querySelector('[data-subtype="math"]').innerHTML = '<span class="katex-html">newGlyph</span>';
                        };
                        assert.equal((await search("newGlyph")).matches.length, 1);
                    }
                    const reads = domCalls;
                    complete();
                    await Promise.resolve();
                    const after = await search(outcome === "clear" ? "newGlyph" : "delta");
                    full(after);
                    assert.equal(after.matches.length, 1);
                    assert.equal(domCalls, reads, "late failure/old completion cannot invalidate the current cache");
                }
                // Completion can race the post-extraction hash check, before the source cache is written.
                reset();
                add("b", "p", "\\delta");
                db.exec("UPDATE blocks SET markdown='$\\delta$'");
                doms.b = '<div data-node-id="b" data-type="NodeParagraph">' + inlineFormula + "</div>";
                let completeDuringHash;
                nativeRenderMethods.mathRender = host => new Promise(resolve => {
                    completeDuringHash = () => {
                        host.querySelector('[data-subtype="math"]').innerHTML = '<span class="katex-html">δ</span>';
                        resolve();
                    };
                });
                let hashReads = 0;
                failSql = stmt => {
                    if (/SELECT id, hash FROM blocks/.test(stmt) && ++hashReads === 2) completeDuringHash();
                    return false;
                };
                full(await search("delta"));
                assert.equal(hashReads, 2);
                nativeRenderMethods.mathRender = host => {
                    host.querySelector('[data-subtype="math"]').innerHTML = '<span class="katex-html">δ</span>';
                };
                assert.equal((await search("δ")).matches.length, 1, "completion before insertion also expires source");
            } finally {
                window.katex = readyKatex;
            }
            reset();
            add("b", "m", "\\delta");
            doms.b = blockFormula;
            const abortMath = new AbortController();
            nativeRenderMethods.mathRender = () =>
                new Promise(resolve => {
                    setTimeout(() => {
                        abortMath.abort();
                        resolve();
                    }, 10);
                });
            assert.equal((await search("δ", {signal: abortMath.signal})).cancelled, true);
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            reset();
            add("b", "query_embed", "select * from blocks");
            doms.b =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="same" data-type="NodeParagraph">' +
                inlineFormula + inlineFormula + '</div><div data-node-id="same" data-type="NodeParagraph">' + inlineFormula +
                "</div></div>";
            const embeddedFallback = await search("delta");
            full(embeddedFallback);
            assert.equal(embeddedFallback.matches.length, 3);
            assert.equal(new Set(embeddedFallback.matches.map(match => match.unitId)).size, 3);
            assert.ok(embeddedFallback.matches.every(match => !match.range && !match.replaceable));
            reset();
            add("l", "i", "", "", "r", 'fold="1"');
            add("b", "p", "old", "", "l");
            wysiwyg.innerHTML = '<div class="li" data-node-id="l" data-type="NodeListItem" data-subtype="u" fold="1">' +
                '<div></div><div></div><div data-node-id="b" data-type="NodeParagraph">' + inlineFormula + "</div></div>";
            const foldedSource = await search("delta");
            full(foldedSource);
            assert.equal(foldedSource.matches.length, 1);
            assert.equal(domCalls, 0, "folded source preserves unsaved DOM and does not fetch stale SQL");
            const foldedLiveUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeFoldedBlocks: true});
            const formulaSourceUnit = foldedLiveUnits.find(unit => unit.matchSource === "inline-math");
            assert.equal(
                source("frontend/ranges").createRangeFromBlockOffsets(formulaSourceUnit, 1, 6, {allowFoldedHidden: true}),
                null,
            );
            const foldedPipeline = await source("frontend/pipeline").calculateSearchMatches({}, edit, "delta", {
                includeFoldedBlocks: true,
                restrictInlineTypes: ["inline-math"],
            });
            assert.equal(foldedPipeline.matches.length, 1);
            assert.equal(foldedPipeline.matches[0].range, undefined);
            assert.equal((await search("delta", {includeFoldedBlocks: false})).matches.length, 0);
            const selectedFormula = await source("frontend/pipeline").calculateSearchMatches({}, edit, "delta", {
                includeFoldedBlocks: true,
                selectionOnly: true,
                selectionScope: new Map([[source("frontend/selection").unitKeyOf(formulaSourceUnit), [{start: 0, end: formulaSourceUnit.text.length}]]]),
            });
            assert.equal(selectedFormula.matches.length, 0, "selection searches cannot borrow an invisible source offset");
            wysiwyg.querySelector('[data-type="inline-math"]').innerHTML = '<span class="katex-html">δ</span>';
            assert.equal((await search("delta")).matches.length, 0);
            assert.equal((await search("δ")).matches.length, 1, "mounted glyphs replace source instead of double counting");
            // Existing database formula projection must not acquire source offsets.
            const avSource = document.createElement("div");
            avSource.dataset.type = "NodeAttributeView";
            avSource.innerHTML = '<div fold="1">' + inlineFormula + "</div>";
            assert.equal(source("frontend/renderer-adapters").mathSourceFallbackText(avSource.querySelector("span")), null);
            reset();
            add("b", "p", "\\custom");
            db.exec("UPDATE blocks SET markdown='$\\custom$'");
            doms.b = '<div data-node-id="b" data-type="NodeParagraph">' + inlineFormula.replace("delta", "custom") + "</div>";
            const oldSiyuan = window.siyuan;
            const oldKatex = window.katex;
            try {
                window.siyuan = {config: {editor: {katexMacros: "firstGlyph"}}};
                const sourceOnly = await search("custom");
                full(sourceOnly);
                assert.equal(sourceOnly.matches.length, 1);
                // A fallback retained while scripts were unavailable must not hide glyphs after KaTeX loads.
                window.katex = {renderToString() {}};
                nativeRenderMethods.mathRender = host => {
                    host.querySelectorAll('[data-subtype="math"]').forEach(element => {
                        element.innerHTML = '<span class="katex-html">' + window.siyuan.config.editor.katexMacros + "</span>";
                        element.setAttribute("data-render", "true");
                    });
                };
                assert.equal((await search("firstGlyph")).matches.length, 1);
                assert.equal((await search("custom")).matches.length, 0);
                window.siyuan.config.editor.katexMacros = "secondGlyph";
                assert.equal(
                    (await search("secondGlyph")).matches.length,
                    1,
                    "inline formula plain cache follows macro changes",
                );
                assert.equal((await search("firstGlyph")).matches.length, 0);
            } finally {
                window.siyuan = oldSiyuan;
                window.katex = oldKatex;
            }
            // A valid empty macro emits no inline-math unit, but its host still depends on macros.
            for (const mounted of [false, true]) {
                reset();
                add("b", "p", "before \\custom after");
                db.exec("UPDATE blocks SET markdown='before $\\custom$ after'");
                doms.b = '<div data-node-id="b" data-type="NodeParagraph">before' +
                    inlineFormula.replace("delta", "custom") + "after</div>";
                add("ordinary", "p", "ordinary");
                doms.ordinary = '<div data-node-id="ordinary" data-type="NodeParagraph">ordinary</div>';
                try {
                    window.siyuan = {config: {editor: {katexMacros: ""}}};
                    window.katex = {renderToString() {}};
                    nativeRenderMethods.mathRender = host => host.querySelectorAll('[data-subtype="math"]').forEach(element => {
                        element.innerHTML = '<span class="katex-html">' + window.siyuan.config.editor.katexMacros + "</span>";
                    });
                    if (mounted) {
                        wysiwyg.innerHTML = doms.b;
                        nativeRenderMethods.mathRender(wysiwyg);
                    }
                    full(await search("before"));
                    wysiwyg.innerHTML = "";
                    full(await search("ordinary"));
                    const reads = domCalls;
                    full(await search("before"));
                    assert.equal(domCalls, reads, "empty macro host retains its ordinary text cache");
                    window.siyuan.config.editor.katexMacros = "δ";
                    const changed = await search("δ");
                    full(changed);
                    assert.equal(changed.matches.length, 1, "empty macro cache follows later macro changes");
                    assert.equal(domReadIds.filter(id => id === "ordinary").length, 1, "unrelated text cache survives");
                } finally {
                    window.siyuan = oldSiyuan;
                    window.katex = oldKatex;
                }
            }
            reset();
            for (let index = 0; index < 300; index++) {
                const id = "math-" + index;
                add(id, "m", "\\text{hit}");
                doms[id] = blockFormula.replace('data-node-id="b"', `data-node-id="${id}"`).replace("delta", "text{hit}");
            }
            const manyMath = await search("hit");
            full(manyMath);
            assert.equal(manyMath.matches.length, 300);
            assert.equal(domCalls, 5, "cold formulas retain 64-block batches and do not spawn background rereads");
            const mathReads = domCalls;
            const cachedManyMath = await search("hit");
            full(cachedManyMath);
            assert.equal(cachedManyMath.matches.length, 300);
            assert.equal(domCalls, mathReads);
            reset();
            add("b", "p", "before \\delta after");
            db.exec("UPDATE blocks SET markdown='before $\\delta$ after'");
            doms.b = '<div data-node-id="b" data-type="NodeParagraph">before' + inlineFormula + "after</div>";
            nativeRenderMethods.mathRender = () => { throw new Error("excluded formula must not render"); };
            assert.equal((await search("before", {restrictInlineTypes: ["strong"]})).matches.length, 0);
            reset();
            add("b", "m", "\\text{<tag>&}");
            doms.b = blockFormula.replace("\\delta", "\\text{&amp;lt;tag&amp;gt;&amp;amp;}");
            const entityFormula = await search("<tag>&");
            full(entityFormula);
            assert.equal(entityFormula.matches.length, 1, "formula source decodes entities once like Lute.UnEscapeHTMLStr");
            assert.equal(document.querySelector("tag"), null, "source fallback never creates source markup");
            console.log(
                "native API/async cold math, standard Markdown candidates, folds, source fallback, cancellation, timeout and no duplicate/range/write OK",
            );
        }

        // Cold Mermaid/flowchart use source; their live rendered labels remain searchable.
        for (const language of ["mermaid", "flowchart"]) {
            const switchName = language === "mermaid" ? "includeMermaid" : "includeFlowchart";
            for (const options of [{}, {regex: true}]) {
                reset();
                add("b", "c", "foo foo", language);
                const sourceBlock = document.createElement("div");
                sourceBlock.dataset.nodeId = "b";
                sourceBlock.dataset.type = "NodeCodeBlock";
                sourceBlock.dataset.content = "foo foo";
                sourceBlock.innerHTML = "<div></div>";
                doms.b = sourceBlock.outerHTML;
                const cold = await search("foo", options);
                full(cold);
                assert.equal(cold.matches.length, 2);
                assert.ok(cold.matches.every(hit => hit.unitId === "renderer:source-fallback:" + language + ":0"));
                assert.ok(cold.matches.every(hit => !hit.replaceable && !hit.range));
                const reads = domCalls;
                full(await search("foo", options));
                assert.equal(domCalls, reads, "unchanged cold source reuses the hash-validated cache");
                const absent = await search("generated", options);
                full(absent);
                assert.equal(absent.matches.length, 0, "unloaded source does not invent renderer-generated labels");
                assert.equal(domCalls, reads, "unrelated source does not trigger background diagram extraction");
                const disabled = await search("foo", {...options, [switchName]: false});
                full(disabled);
                assert.equal(disabled.matches.length, 0);
                assert.equal(renderCalls, 0, "Mermaid/flowchart never call an offscreen renderer");
            }
            for (
                const [type, className, gate] of [
                    ["NodeListItem", "li", "includeListUnordered"],
                    ["NodeCallout", "callout", "includeCallout"],
                    ["NodeBlockquote", "bq", "includeBlockquote"],
                    ["NodeSuperBlock", "sb", "includeSuperBlock"],
                    ["NodeList", "list", "includeListUnordered"],
                ]
            ) {
                reset();
                const metaType = {
                    NodeListItem: "i",
                    NodeCallout: "callout",
                    NodeBlockquote: "b",
                    NodeSuperBlock: "s",
                    NodeList: "l",
                }[type];
                add("container", metaType, "", "", "r", 'fold="1"');
                add("b", "c", "old", language, "container");
                wysiwyg.innerHTML = '<div class="' + className + '" data-node-id="container" data-type="' + type +
                    '" data-subtype="u" fold="1"><div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' +
                    language +
                    '" data-content="unsaved unsaved"><div></div></div></div>';
                const folded = await search("unsaved");
                full(folded);
                assert.equal(folded.matches.length, 2, "unrendered folded source uses unsaved DOM rather than SQL");
                assert.ok(folded.matches.every(hit => !hit.range && !hit.replaceable));
                assert.equal(domCalls, 0);
                assert.equal((await search("unsaved", {includeFoldedBlocks: false})).matches.length, 0);
                assert.equal((await search("unsaved", {[gate]: false})).matches.length, 0);
                wysiwyg.querySelector('[data-node-id="b"]').setAttribute("data-content", "changed");
                assert.equal((await search("unsaved")).matches.length, 0);
                assert.equal((await search("changed")).matches.length, 1);
                const graph = wysiwyg.querySelector('[data-node-id="b"]');
                // Native Mermaid inserts the awaited SVG into the block; flowchart draws synchronously.
                // data-render alone is not completion, but an existing healthy output survives CSS folding.
                graph.innerHTML = '<div><svg><text>visible</text><foreignObject><div>visible</div></foreignObject></svg></div>';
                const visible = await search("visible");
                full(visible);
                assert.equal(visible.matches.length, 2, "folded containers reuse each SVG label once");
                assert.ok(visible.matches.every(hit => hit.range && !hit.replaceable));
                assert.equal((await search("changed")).matches.length, 0, "rendered labels exclude source fallback");
                assert.equal((await search("visible", {includeFoldedBlocks: false})).matches.length, 0);
                assert.equal((await search("visible", {[gate]: false})).matches.length, 0);
                graph.style.display = "none";
                assert.equal((await search("visible")).matches.length, 0, "author-hidden output stays excluded");
                graph.style.display = "";
                const state = new (source("frontend/diagram-search-state").DiagramSearchState)();
                state.capture(source("frontend/blocks").collectSearchableBlocks(edit, {includeFoldedBlocks: true}));
                wysiwyg.firstElementChild.setAttribute("fold", "0");
                assert.equal(state.changed(edit, new Set([graph]), {includeFoldedBlocks: true}), false,
                    "unfolding unchanged labels does not request a diagram reindex");
                assert.equal((await search("visible")).matches.length, 2);
                graph.insertAdjacentHTML("beforeend", '<div class="ft__error">failed</div>');
                const failed = await search("changed");
                full(failed);
                assert.equal(failed.matches.length, 1, "failed output falls back immediately to current source");
                assert.equal((await search("visible")).matches.length, 0, "error SVG is never combined with source");
                assert.equal(domCalls, 0);
                assert.equal(renderCalls, 0);
            }
            reset();
            add("a", "h", "heading", "", "r", 'fold="1"');
            add("b", "c", "foo", language);
            wysiwyg.innerHTML =
                '<div data-node-id="a" data-type="NodeHeading" data-subtype="h1" fold="1">heading</div>';
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" parent-heading="a" data-content="foo"><div></div></div>';
            const heading = await search("foo");
            full(heading);
            assert.equal(heading.matches.length, 1);
            assert.equal((await search("foo", {includeFoldedBlocks: false})).matches.length, 0);
            assert.equal(renderCalls, 0);

            reset();
            add("b", "c", "sourceOnly foo foo", language);
            const mounted = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="sourceOnly foo foo"><div><svg><text>foo</text><text>foo</text><text>generated</text></svg></div></div>';
            wysiwyg.innerHTML = mounted;
            const diagramState = new (source("frontend/diagram-search-state").DiagramSearchState)();
            let captured = 0;
            const rendered = await search("foo", {
                onLiveUnitsCollected: units => {
                    captured++;
                    diagramState.capture(units);
                },
            });
            full(rendered);
            assert.equal(captured, 1, "full corpus publishes its actual live unit snapshot once");
            assert.equal(rendered.matches.length, 2, "separate visible labels remain separate matches");
            assert.ok(rendered.matches.every(hit => hit.range && !hit.replaceable));
            assert.equal((await search("sourceOnly")).matches.length, 0, "normal SVG text is not mixed with source");
            assert.equal((await search("generated")).matches.length, 1);
            const liveDiagram = wysiwyg.firstElementChild;
            liveDiagram.innerHTML = "<div><svg><text>foo</text></svg></div>";
            assert.equal(diagramState.changed(edit, new Set([liveDiagram]), {includeFoldedBlocks: true}), true);
            assert.equal(
                (await search("foo")).matches.length,
                1,
                "dynamic full corpus refresh updates rendered counts",
            );
            wysiwyg.innerHTML = "";
            assert.equal(diagramState.changed(edit, new Set([liveDiagram]), {includeFoldedBlocks: true}), true);
            doms.b = mounted;
            corpus.invalidateDocumentSearchCaches();
            assert.equal((await search("sourceOnly")).matches.length, 0,
                "existing offscreen output excludes source and populates the versioned text cache");
            const unloadedAfterVisible = await search("generated");
            full(unloadedAfterVisible);
            assert.equal(
                unloadedAfterVisible.matches.length,
                1,
                "an offscreen DOM that already has output keeps its visible labels",
            );
            assert.equal((await search("sourceOnly")).matches.length, 0);
            assert.equal((await search("generated", {regex: true})).matches.length, 1,
                "regex literal candidates also retain known rendered labels absent from source");
            assert.equal((await search("generated", {[switchName]: false})).matches.length, 0);
            // Real kernel DOM normally carries only source, not the renderer's transient SVG.
            doms.b = mounted.replace(/<svg>.*?<\/svg>/, "");
            db.prepare("UPDATE blocks SET hash='new-diagram-version' WHERE id='b'").run();
            const unloadedWithoutOutput = await search("sourceOnly");
            full(unloadedWithoutOutput);
            assert.equal(unloadedWithoutOutput.matches.length, 1, "cold shell still falls back to source");
            assert.equal((await search("generated")).matches.length, 0);
            assert.equal(renderCalls, 0);

            // Native kernel DOM has no transient SVG. Reuse live labels only after source/version validation.
            for (const options of [{}, {regex: true}, {regex: true, unfiltered: true}]) {
                const query = options.unfiltered ? ".+" : "generated";
                reset();
                add("b", "c", "sourceOnly", language);
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                    '" data-content="sourceOnly"><svg><text>generated</text><text>generated</text></svg></div>';
                doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                    '" parent-heading="heading" data-content="sourceOnly"><div></div></div>';
                assert.equal((await search(query, options)).matches.length, 2);
                wysiwyg.innerHTML = "";
                const cachedLabels = await search(query, options);
                full(cachedLabels);
                assert.equal(cachedLabels.matches.length, 2, "unloaded labels absent from source survive verified reuse");
                assert.ok(cachedLabels.matches.every(hit => !hit.range && !hit.replaceable));
                assert.equal((await search("sourceOnly", options)).matches.length, 0);
                const verifiedReads = domCalls;
                assert.equal((await search(query, options)).matches.length, 2);
                assert.equal(domCalls, verifiedReads, "verified diagram snapshot does not fetch DOM again");
                db.prepare("UPDATE blocks SET hash='changed' WHERE id='b'").run();
                assert.equal((await search("generated", options)).matches.length, 0, "changed hash invalidates old labels");
                assert.equal((await search("sourceOnly", options)).matches.length, 1);
                assert.equal(renderCalls, 0);
            }
            reset();
            add("b", "c", "saved", language);
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="unsaved"><svg><text>generated</text></svg></div>';
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="saved"><div></div></div>';
            assert.equal((await search("generated")).matches.length, 1);
            wysiwyg.innerHTML = "";
            assert.equal((await search("generated")).matches.length, 0,
                "unchanged SQL hash cannot validate a diagram's unsaved source");
            assert.equal((await search("saved")).matches.length, 1);
            assert.equal(renderCalls, 0);

            reset();
            add("b", "c", "saved", language);
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="saved"><svg><text>generated</text></svg></div>';
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' +
                (language === "mermaid" ? "flowchart" : "mermaid") + '" data-content="saved"><div></div></div>';
            assert.equal((await search("generated")).matches.length, 1);
            wysiwyg.innerHTML = "";
            assert.equal((await search("generated")).matches.length, 0,
                "equal source and hash do not reuse labels from a different diagram language");
            assert.equal((await search("saved")).matches.length, 1);

            reset();
            add("b", "c", "saved", language);
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="saved"><svg><text>generated</text></svg></div>';
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="saved"><div></div></div>';
            assert.equal((await search("generated")).matches.length, 1);
            wysiwyg.innerHTML = "";
            assert.equal((await search("generated")).matches.length, 1);
            window.siyuan = {config: {appearance: {mode: 1}}};
            try {
                assert.equal((await search("generated")).matches.length, 0,
                    "render settings invalidate saved rendered snapshots");
                assert.equal((await search("saved")).matches.length, 1);
            } finally {
                delete window.siyuan;
            }
            assert.equal(renderCalls, 0);

            reset();
            add("b", "c", "foo & <b>bar</b>", language);
            const escaped = document.createElement("div");
            Object.assign(escaped.dataset, {
                nodeId: "b",
                type: "NodeCodeBlock",
                subtype: language,
                content: "foo &amp; &lt;b&gt;bar&lt;/b&gt;",
            });
            escaped.innerHTML = '<div class="ft__error"><svg><text>errorText</text></svg></div>';
            wysiwyg.appendChild(escaped);
            const entities = await search("<b>bar</b>");
            full(entities);
            assert.equal(entities.matches.length, 1, "source entities decode once without stripping HTML-like code");
            assert.equal((await search("errorText")).matches.length, 0);
            doms.b = escaped.outerHTML;
            escaped.remove();
            const coldEntities = await search("<b>bar</b>");
            full(coldEntities);
            assert.equal(coldEntities.matches.length, 1, "SQL candidates and cold source decoding agree");
            wysiwyg.appendChild(escaped);
            escaped.style.display = "none";
            assert.equal((await search("foo")).matches.length, 0, "author-hidden source remains excluded");
            escaped.style.display = "";
            escaped.setAttribute("data-content", "");
            full(await search("foo"));
            assert.equal((await search("foo")).matches.length, 0, "empty source is complete and not a render failure");

            reset();
            add("b", "c", "old", language);
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="unsaved unsaved"><div spin="1"></div></div>';
            const initialMounted = await search("unsaved", {includeCodeBlock: false});
            full(initialMounted);
            assert.equal(
                initialMounted.matches.length,
                2,
                "pending live graph reads unsaved source, independently of ordinary code gate",
            );
            assert.equal(domCalls, 0);
            corpus.invalidateDocumentSearchCaches();
            failSql = () => true;
            const degradedSource = await source("frontend/pipeline").calculateSearchMatches({}, edit, "unsaved", {
                includeFoldedBlocks: true,
                includeAttributeView: false,
            });
            assert.equal(degradedSource.degraded, true);
            assert.equal(
                degradedSource.matches.length,
                2,
                "API failure still searches mounted source in the loaded-DOM fallback",
            );
            assert.ok(degradedSource.matches.every(hit => !hit.range && !hit.replaceable));
            failSql = () => false;
            const sourceScope = new Map([[
                source("frontend/selection").unitKey("b", "renderer:source-fallback:" + language + ":0"),
                [{start: 0, end: 15}],
            ]]);
            const selectedSource = await source("frontend/pipeline").calculateSearchMatches({}, edit, "unsaved", {
                includeFoldedBlocks: true,
                includeAttributeView: false,
                selectionOnly: true,
                selectionScope: sourceScope,
            });
            assert.equal(selectedSource.matches.length, 0, "source attributes cannot invent a visual text selection");

            reset();
            add("b", "c", "foo", language);
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '"><div></div></div>';
            const missingSource = await search("foo");
            assert.equal(missingSource.matches.length, 0);
            assert.equal(
                missingSource.unrendered,
                1,
                "a genuinely missing source/output remains explicitly incomplete",
            );
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content=""><div></div></div>';
            full(await search("foo"));
            assert.equal(renderCalls, 0);

            reset();
            add("b", "query_embed", "foo");
            wysiwyg.innerHTML =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="' +
                language +
                '" data-content="foo foo"><div></div></div></div>';
            const embeddedSource = await search("foo");
            full(embeddedSource);
            assert.equal(embeddedSource.matches.length, 2);
            assert.ok(embeddedSource.matches.every(hit => hit.blockId === "b" && !hit.range && !hit.replaceable));
            assert.equal(renderCalls, 0);
            assert.equal(domCalls, 0);
            const disabledEmbed = await search("foo", {includeEmbedBlock: false});
            full(disabledEmbed);
            assert.equal(disabledEmbed.matches.length, 0);

            reset();
            add("b", "c", "foo", language);
            const controller = new AbortController();
            domResponder = async () => {
                controller.abort();
                return {
                    code: 0,
                    data: {
                        b: '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                            '" data-content="foo"><div></div></div>',
                    },
                };
            };
            assert.equal((await search("foo", {signal: controller.signal})).cancelled, true);
            const cancelledReads = domCalls;
            domResponder = null;
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="foo"><div></div></div>';
            full(await search("foo"));
            assert.ok(domCalls > cancelledReads, "cancelled source extraction never populates the cache");
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        }
        reset();
        for (let index = 0; index < 300; index++) add("irrelevant" + index, "c", "unrelated", "mermaid");
        add("needle", "c", "needle", "flowchart");
        doms.needle =
            '<div data-node-id="needle" data-type="NodeCodeBlock" data-subtype="flowchart" data-content="needle"><div></div></div>';
        const sourceNeedle = await search("needle");
        full(sourceNeedle);
        assert.equal(sourceNeedle.matches.length, 1);
        assert.equal(domCalls, 1, "candidate narrowing skips hundreds of unrelated diagram sources");
        assert.deepEqual(domReadIds, ["needle"]);
        assert.equal(renderCalls, 0);
        console.log(
            "Mermaid/flowchart source fallback, folds, unsaved edits, entities, gates, no duplicate/range/write and candidate budget OK",
        );

        for (const language of ["graphviz"]) {
            for (const options of [{}, {regex: true, regexUnicode: true}]) {
                reset();
                add("b", "c", 'graph TD; A["<b>fo</b>o"]', language);
                doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="diagram"><div></div></div>';
                const ownerless = await search("foo", options);
                // Unprefilterable regexes render all targets in the foreground.
                if (ownerless.partial) assert.equal(ownerless.matches.length, 0);
                else {
                    full(ownerless);
                    assert.equal(ownerless.matches.length, 1);
                }
                corpus.retainBackgroundCorpusRoot("r");
                const result = await settle("foo", options);
                full(result);
                assert.equal(result.matches.length, 1);
                const count = renderCalls;
                const generated = await search("generated", options);
                full(generated);
                assert.equal(generated.matches.length, 1);
                assert.equal(renderCalls, count);
                const disabled = await search("foo", {
                    ...options,
                    includeCodeBlock: false,
                });
                full(disabled);
                assert.equal(disabled.matches.length, 0);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log("unloaded Graphviz, generated labels, switches and cache OK");
        reset();
        add("a", "h", "heading", "", "r", 'fold="1"');
        add("b", "c", "foo", "graphviz");
        wysiwyg.innerHTML = '<div data-node-id="a" data-type="NodeHeading" data-subtype="h1" fold="1">heading</div>';
        doms.b =
            '<div data-node-id="b" data-type="NodeCodeBlock" parent-heading="a" data-content="foo"><div></div></div>';
        const heading = await search("foo");
        full(heading);
        assert.equal(heading.matches.length, 1);
        const closed = await search("foo", {includeFoldedBlocks: false});
        full(closed);
        assert.equal(closed.matches.length, 0);

        reset();
        add("l", "i", "", "", "r", 'fold="1"');
        add("b", "c", "foo", "graphviz", "l");
        wysiwyg.innerHTML =
            '<div class="li" data-node-id="l" data-type="NodeListItem" fold="1"><div></div><div></div><div data-node-id="b" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div><svg><text>foo</text><text>foo</text></svg></div></div></div>';
        const folded = await search("foo");
        full(folded);
        assert.equal(folded.matches.length, 1);
        const calls = renderCalls;
        assert.equal((await search("foo")).matches.length, 1);
        assert.equal(renderCalls, calls);
        const foldedGenerated = await search("generated");
        assert.equal(foldedGenerated.matches.length, 1);
        assert.equal(
            foldedGenerated.matches[0].range,
            undefined,
            "partial live SVG must not receive a mismatching cached range",
        );
        reset();
        add("l", "i", "", "", "r", 'fold="1"');
        add("b", "c", "foo", "graphviz", "l");
        wysiwyg.innerHTML =
            '<div data-node-id="l" data-type="NodeListItem" fold="1"><div data-node-id="b" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div><svg><text>foo</text></svg></div></div></div>';
        window.Protyle = {
            graphvizRender: (host) => {
                renderCalls += 1;
                host.querySelector('[data-node-id="b"]').innerHTML = "<div><svg></svg></div>";
            },
        };
        const empty = await search("foo");
        full(empty);
        assert.equal(empty.matches.length, 0);
        assert.equal((await search("foo")).matches.length, 0);
        assert.equal(renderCalls, 1);
        console.log("heading/list folds, duplicate counts and successful empty output OK");

        reset();
        add("l", "i", "", "", "r", 'fold="1"');
        add("b", "c", "old", "graphviz", "l");
        wysiwyg.innerHTML =
            '<div data-node-id="l" data-type="NodeListItem" fold="1"><div data-node-id="b" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="unsaved"><div></div></div></div>';
        window.Protyle = {
            graphvizRender: (host) => {
                renderCalls += 1;
                const block = host.querySelector('[data-node-id="b"]');
                block.innerHTML = "<div><svg><text>" + block.getAttribute("data-content") + "</text></svg></div>";
            },
        };
        const unsaved = await search("unsaved");
        full(unsaved);
        assert.equal(unsaved.matches.length, 1);
        assert.equal(domCalls, 0);
        wysiwyg.querySelector('[data-node-id="b"]').setAttribute("data-content", "changed");
        const changed = await search("changed");
        full(changed);
        assert.equal(changed.matches.length, 1);
        assert.equal(renderCalls, 2);
        assert.equal((await search("unsaved")).matches.length, 0, "same SQL hash cannot reuse stale live source");

        reset();
        add("l", "i", "", "", "r", 'fold="1"');
        add("b", "c", "foo", "graphviz", "l");
        wysiwyg.innerHTML =
            '<div data-node-id="l" data-type="NodeListItem" fold="1"><div data-node-id="b" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div><svg><text>foo</text></svg></div></div></div>';
        window.Protyle = {
            graphvizRender: () => {
                renderCalls += 1;
                throw new Error("renderer unavailable");
            },
        };
        const foldedFailure = await search("foo");
        assert.equal(foldedFailure.unrendered, 1);
        const repeatedFailure = await search("foo");
        assert.equal(repeatedFailure.unrendered, 1);
        assert.equal(repeatedFailure.partial, false);
        assert.equal(renderCalls, 1);
        console.log("mounted cold/unsaved diagrams and folded failure backoff OK");

        reset();
        add("b", "c", "foo", "graphviz");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="foo"><div></div></div>';
        let releaseRender;
        let pendingRender;
        window.Protyle = {
            graphvizRender: (host) => {
                pendingRender = new Promise((resolve) => {
                    releaseRender = resolve;
                });
                pendingRender.then(() => {
                    host.querySelector('[data-node-id="b"]').innerHTML = "<div><svg><text>foo</text></svg></div>";
                });
            },
        };
        const abortRenderer = new AbortController();
        const rendering = search("foo", {signal: abortRenderer.signal});
        while (!releaseRender) await new Promise((resolve) => setTimeout(resolve, 5));
        abortRenderer.abort();
        releaseRender();
        assert.equal((await rendering).cancelled, true);
        const rendererCallsBefore = domCalls;
        window.Protyle = {graphvizRender: renderer};
        const retryCancelled = await search("foo");
        full(retryCancelled);
        assert.equal(retryCancelled.matches.length, 1);
        assert.ok(domCalls > rendererCallsBefore, "cancelled renderer cannot write cache");

        reset();
        add("b", "c", "foo", "graphviz");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="foo"><div></div></div>';
        window.Protyle = {};
        const failed = await search("foo");
        assert.equal(failed.matches.length, 0);
        assert.equal(failed.partial, false);
        assert.equal(failed.unrendered, 1);
        await search("foo");
        assert.equal(domCalls, 1, "negative cache backs off failed render");
        reset();
        add("b", "c", "foo", "graphviz");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="foo"><div></div></div>';
        window.Protyle = {
            graphvizRender: (host) => {
                host.querySelector('[data-node-id="b"]').innerHTML =
                    '<div class="ft__error"><svg><text>foo</text></svg></div>';
            },
        };
        const errorText = await search("foo");
        assert.equal(errorText.matches.length, 0);
        assert.equal(errorText.unrendered, 1);

        reset();
        add("b", "p", "foo");
        const missing = await search("foo");
        assert.equal(missing.degraded, true);
        assert.equal(missing.unrendered, 1);
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">foo</div>';
        const recovered = await search("foo");
        full(recovered);
        assert.equal(recovered.matches.length, 1);
        reset();
        add("b", "p", "foo");
        domResponder = async () => ({code: 1});
        const apiFailure = await search("foo");
        assert.equal(apiFailure.degraded, true);
        assert.equal(apiFailure.unrendered, 1);
        console.log("missing DOM, render errors, no source fallback and retry state OK");

        reset();
        add("b", "p", "hidden");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeParagraph" style="display:none">hidden</div>';
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">hidden</div>';
        const hidden = await search("hidden");
        full(hidden);
        assert.equal(hidden.matches.length, 0);
        assert.equal(domCalls, 0);
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeParagraph"><span style="display:none">hidden</span></div>';
        const hiddenOnlyBody = await search("hidden");
        full(hiddenOnlyBody);
        assert.equal(hiddenOnlyBody.matches.length, 0);
        assert.equal(domCalls, 0);
        reset();
        add("b", "p", "foo");
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeParagraph">foo<span data-type="inline-math" data-content="x"><span></span></span></div>';
        const pendingMath = await search("foo");
        assert.equal(pendingMath.matches.length, 1);
        assert.equal(pendingMath.unrendered, 1);
        reset();
        add("x", "s", "");
        add("b", "p", "hidden", "", "x");
        wysiwyg.innerHTML = '<div data-node-id="x" data-type="NodeSuperBlock" style="display:none"></div>';
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">hidden</div>';
        const hiddenDescendant = await search("hidden");
        full(hiddenDescendant);
        assert.equal(hiddenDescendant.matches.length, 0);
        reset();
        add("b", "p", "hiddenfoo");
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeParagraph">foo<span data-type="inline-math" style="display:none"><span class="katex-html" aria-hidden="true">hidden</span></span></div>';
        assert.equal((await search("hidden")).matches.length, 0);
        reset();
        add("b", "p", "foo");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeParagraph">foo</div>';
        failSql = (stmt) => stmt.includes("substr(markdown");
        add("c", "c", "foo", "graphviz");
        assert.equal((await search("foo")).degraded, true, "language query failure propagates");
        reset();
        add("b", "p", "foo");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeParagraph">foo</div>';
        failSql = (stmt) => stmt.includes("type = 'av'");
        assert.equal((await search("foo", {includeAttributeView: true})).degraded, true, "AV query failure propagates");
        reset();
        add("b", "av", "");
        assert.equal(
            (await search("foo", {includeAttributeView: true})).degraded,
            true,
            "missing AV carrier is not full",
        );

        reset();
        add("b", "av", '<div data-av-id="av-id"></div>');
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeAttributeView" data-av-id="av-id" data-av-type="table"><div class="av__row" data-id="row"><div class="av__cell" data-col-id="col"><span style="display:none">hidden</span></div></div></div>';
        const previousApi = api;
        api = async (url, ...args) => {
            if (url === "/api/av/getAttributeView") {
                return {code: 0, data: {name: "db", views: [{id: "v", name: "table"}]}};
            }
            if (url === "/api/av/renderAttributeView") {
                return {
                    code: 0,
                    data: {
                        view: {
                            type: "table",
                            columns: [{id: "col", name: "name", type: "text"}],
                            rows: [{
                                id: "row",
                                cells: [{keyID: "col", value: {type: "text", text: {content: "hidden"}}}],
                            }],
                        },
                    },
                };
            }
            return previousApi(url, ...args);
        };
        try {
            const avValues = await loadAvUnits([{blockId: "b", avId: "av-id", updated: "1", carrierViewId: ""}]);
            assert.ok(avValues.some((unit) => unit.text === "hidden"), "API fixture contains hidden value");
            const hiddenAv = await search("hidden", {includeAttributeView: true});
            full(hiddenAv);
            assert.equal(hiddenAv.matches.length, 0, "hidden mounted AV values cannot return via API");
        } finally {
            api = previousApi;
        }

        reset();
        add("b", "p", "foo");
        const controller = new AbortController();
        domResponder = async () => {
            controller.abort();
            return {code: 0, data: {b: '<div data-node-id="b" data-type="NodeParagraph">foo</div>'}};
        };
        assert.equal((await search("foo", {signal: controller.signal})).cancelled, true);
        domResponder = null;
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">bar</div>';
        assert.equal((await search("foo")).matches.length, 0, "cancelled text is not cached");
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0, "offscreen hosts disposed");
        const extraction = await extract.extractUnitsFromDoms(["b"], {}, {}, new Set(), "none");
        assert.deepEqual(extraction.missingIds, ["b"]);
        extraction.dispose();
        for (const output of ["<svg></svg>", "<canvas></canvas>", '<img src="diagram.png">']) {
            const noText = await extract.extractUnitsFromDoms(
                ["b"],
                {
                    b: '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="graphviz"><div>' + output +
                        "</div></div>",
                },
                {},
                new Set(),
                "none",
            );
            assert.deepEqual(noText.unrenderedIds, []);
            assert.deepEqual(noText.blocks, []);
            noText.dispose();
        }
        reset();
        domResponder = async (body) =>
            body.ids.includes("bad") ?
                {code: 1} :
                {
                    code: 0,
                    data: Object.fromEntries(
                        body.ids.map((
                            id,
                        ) => [id, '<div data-node-id="' + id + '" data-type="NodeParagraph">foo</div>']),
                    ),
                };
        const batchIds = Array.from({length: 64}, (_, index) => "ok" + index).concat("bad");
        const partialBatch = await extract.fetchAndExtractUnits(batchIds, "", {}, new Set(), "none");
        assert.equal(partialBatch.units.length, 64, "successful batches survive a sibling API failure");
        assert.deepEqual(partialBatch.missingIds, ["bad"]);
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);

        reset();
        add("b", "p", "foo");
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeParagraph" style="visibility:hidden">hidden<span style="visibility:visible">foo</span></div>';
        const restoredVisibility = await search("foo");
        full(restoredVisibility);
        assert.equal(restoredVisibility.matches.length, 1, "visible descendant is searchable");
        assert.ok(restoredVisibility.matches[0].range, "visible descendant receives a range");
        const svgBlock = document.createElement("div");
        svgBlock.dataset.type = "NodeCodeBlock";
        svgBlock.dataset.subtype = "graphviz";
        svgBlock.innerHTML = '<svg><g style="visibility:hidden"><text style="visibility:visible">foo</text></g></svg>';
        wysiwyg.appendChild(svgBlock);
        source("frontend/visibility").beginTextCollection(true);
        assert.equal(
            source("frontend/renderer-adapters").collectRendererSearchUnits(svgBlock, {
                blockId: "svg",
                blockType: "NodeCodeBlock",
                blockIndex: 0,
            })[0]?.text,
            "foo",
            "SVG descendants can restore visibility",
        );

        reset();
        add("b", "p", "foo");
        db.exec("UPDATE blocks SET markdown='foo inline-math'");
        const readyMath =
            '<span data-type="inline-math" data-subtype="math" data-content="a" data-render="true"><span class="katex-html">α</span></span>';
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeParagraph">foo' + readyMath +
            '<span data-type="inline-math" data-subtype="math" data-content="x"><span></span></span></div>';
        assert.equal((await search("foo")).unrendered, 1);
        wysiwyg.innerHTML = "";
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">foo' + readyMath +
            '<span data-type="inline-math" data-subtype="math" data-content="x" data-render="true"><span class="katex-html">δ</span></span></div>';
        const recoveredMath = await search("δ");
        full(recoveredMath);
        assert.equal(recoveredMath.matches.length, 1, "unfinished live math cannot poison the plain cache");
        assert.equal(domCalls, 1);

        reset();
        add("b", "query_embed", "foo");
        doms.b =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div></div>';
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const embedded = await settle("generated");
            full(embedded);
            assert.equal(embedded.matches.length, 1, "embedded generated labels are rendered");
            assert.equal(embedded.matches[0].blockId, "b");
            assert.equal(embedded.matches[0].replaceable, false);
            const disabled = await settle("generated", {includeCodeBlock: false});
            full(disabled);
            assert.equal(disabled.matches.length, 0);
        } finally {
            corpus.releaseBackgroundCorpusRoot("r");
        }
        reset();
        window.Protyle = {};
        const embedFailure = await extract.extractUnitsFromDoms(
            ["b"],
            {
                b: '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div></div>',
            },
            {},
            new Set(["b"]),
            "light",
        );
        assert.deepEqual(embedFailure.unrenderedIds, ["b"], "child renderer failure propagates to its embed");
        embedFailure.dispose();
        const disabledEmbed = await extract.extractUnitsFromDoms(
            ["b"],
            {
                b: '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div></div>',
            },
            {includeCodeBlock: false},
            new Set(["b"]),
            "light",
        );
        assert.deepEqual(disabledEmbed.unrenderedIds, [], "disabled child does not make coverage incomplete");
        disabledEmbed.dispose();
        const embedCopies = await extract.extractUnitsFromDoms(
            ["a", "b"],
            {
                a: '<div data-node-id="a" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeParagraph">one</div></div>',
                b: '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeParagraph">two</div></div>',
            },
            {},
            new Set(["a", "b"]),
            "light",
        );
        assert.deepEqual(embedCopies.blocks.map((block) => [block.blockId, block.text]), [["a", "one"], ["b", "two"]]);
        embedCopies.dispose();
        reset();
        add("b", "query_embed", "foo");
        const mountedEmbedDom =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo" data-render="true"><div><svg><text>foo</text><text>generated</text></svg></div></div></div>';
        doms.b = mountedEmbedDom;
        wysiwyg.innerHTML = mountedEmbedDom;
        const mountedEmbed = await search("generated");
        full(mountedEmbed);
        assert.equal(mountedEmbed.matches.length, 1, "mounted embed does not duplicate detached owner results");
        assert.equal(mountedEmbed.matches[0].blockId, "b");
        assert.ok(mountedEmbed.matches[0].range, "mounted embed retains its live range");
        assert.equal(domCalls, 0, "complete mounted embed avoids kernel extraction");
        const coldEmbedDom =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div></div>';
        reset();
        add("b", "query_embed", "foo");
        wysiwyg.innerHTML = coldEmbedDom;
        window.Protyle = {graphvizRender: renderer};
        const coldMountedEmbed = await search("generated");
        full(coldMountedEmbed);
        assert.equal(coldMountedEmbed.matches.length, 1, "cold mounted embed renders its own live copy");
        assert.equal(coldMountedEmbed.matches[0].blockId, "b");
        assert.equal(domCalls, 0);
        full(await search("generated"));
        assert.equal(renderCalls, 1, "unchanged pending mounted embed reuses completed extraction");
        wysiwyg.querySelector('[data-node-id="outside"]').setAttribute("data-content", "new-source");
        full(await search("generated"));
        assert.equal(renderCalls, 2, "copied source edits invalidate the mounted embed extraction");
        reset();
        add("b", "query_embed", "foo");
        window.Protyle = {};
        wysiwyg.innerHTML = coldEmbedDom;
        const brokenMountedEmbed = await search("generated");
        assert.equal(brokenMountedEmbed.unrendered, 1, "mounted child failure cannot report full coverage");
        assert.equal((await search("generated")).unrendered, 1);
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        reset();
        add("a", "query_embed", "foo");
        add("b", "query_embed", "foo");
        add("outside", "c", "foo", "graphviz");
        wysiwyg.innerHTML = mountedEmbedDom.replace('data-node-id="b"', 'data-node-id="a"') + mountedEmbedDom +
            '<div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-render="true"><div><svg><text>generated</text></svg></div></div>';
        const distinctCopies = await search("generated");
        full(distinctCopies);
        assert.deepEqual(distinctCopies.matches.map((match) => match.blockId), ["a", "b", "outside"]);
        assert.ok(distinctCopies.matches.every((match) => match.range && !match.replaceable));
        const selectionUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeAttributeView: false});
        const selectionScope = new Map(selectionUnits.map((block) => [
            source("frontend/selection").unitKey(block.blockId, block.unitId),
            [{start: 0, end: block.text.length}],
        ]));
        const loadedCopies = await source("frontend/pipeline").calculateSearchMatches({}, edit, "generated", {
            includeFoldedBlocks: true,
            includeAttributeView: false,
            selectionOnly: true,
            selectionScope,
        });
        assert.equal(loadedCopies.matches.length, 3, "loaded-only pipeline has the same embed ownership");
        assert.ok(loadedCopies.matches.every((match) => !match.replaceable));
        const selectedSearch = async (query, options = {}) => {
            const blocks = source("frontend/blocks").collectSearchableBlocks(edit, options);
            const selectionScope = new Map(blocks.map(block => [
                source("frontend/selection").unitKey(block.blockId, block.unitId),
                [{start: 0, end: block.text.length}],
            ]));
            return source("frontend/pipeline").calculateSearchMatches({}, edit, query, {
                ...options,
                regex: true,
                selectionOnly: true,
                selectionScope,
            });
        };
        // Visual order is measured only for mounted SVG/columns with usable layout.
        const elementRect = Element.prototype.getBoundingClientRect;
        const rangeRects = Range.prototype.getClientRects;
        let rectReads = 0;
        const fixtureRect = element => {
            const key = element?.closest("[data-rect]")?.getAttribute("data-rect");
            const [top, left] = key?.split(",").map(Number) ?? [0, 0];
            rectReads++;
            return {top, left, width: 20, height: 10, bottom: top + 10, right: left + 20};
        };
        Element.prototype.getBoundingClientRect = function() {
            return fixtureRect(this);
        };
        Range.prototype.getClientRects = function() {
            return [
                fixtureRect(
                    this.startContainer instanceof Element ? this.startContainer : this.startContainer.parentElement,
                ),
            ];
        };
        try {
            reset();
            add("b", "query_embed", "hit");
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid" data-render="true" data-content="graph TB">' +
                '<svg><text data-rect="100,0">hit-bottom-2</text><text data-rect="0,0">hit-top-1</text></svg></div></div>';
            for (const selection of [false, true]) {
                const visual = selection ?
                    await selectedSearch("hit-[a-z]+-\\d+") :
                    await search("hit-[a-z]+-\\d+", {regex: true});
                assert.deepEqual(visual.matches.map(match => match.matchedText), ["hit-top-1", "hit-bottom-2"]);
            }
            const far = document.createElement("div");
            far.dataset.nodeId = "far";
            far.dataset.type = "NodeParagraph";
            far.dataset.rect = "2000,0";
            far.textContent = "hit-far-3";
            wysiwyg.firstElementChild.append(far);
            const viewportOrder = await search("hit-[a-z]+-\\d+", {regex: true});
            full(viewportOrder);
            assert.deepEqual(viewportOrder.matches.map(match => match.matchedText), [
                "hit-top-1",
                "hit-bottom-2",
                "hit-far-3",
            ], "unprojected viewport hits do not suppress live diagram ordering");
            assert.equal(viewportOrder.matches[2].range, undefined);
            far.dataset.rect = "100,0";
            const scrolledOrder = source("frontend/corpus/project").refreshViewportRanges(edit, viewportOrder.matches);
            assert.ok(scrolledOrder[2].range);
            assert.deepEqual(
                scrolledOrder.map(match => match.matchedText),
                viewportOrder.matches.map(match => match.matchedText),
            );
            const searchedAgain = await search("hit-[a-z]+-\\d+", {regex: true});
            assert.deepEqual(
                searchedAgain.matches.map(match => match.matchedText),
                viewportOrder.matches.map(match => match.matchedText),
            );
            far.remove();
            const foldedSibling = document.createElement("div");
            foldedSibling.innerHTML = '<div data-node-id="fold" data-type="NodeListItem" fold="1">' +
                '<div data-node-id="hidden" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="hit-hidden-3"></div></div>';
            wysiwyg.firstElementChild.append(foldedSibling);
            const wideQuery = await search("hit-[a-z]+-\\d+", {regex: true});
            full(wideQuery);
            assert.deepEqual(wideQuery.matches.map(match => match.matchedText), [
                "hit-top-1",
                "hit-bottom-2",
                "hit-hidden-3",
            ]);
            const narrowQuery = await search("hit-(?:top|bottom)-\\d+", {regex: true});
            assert.deepEqual(narrowQuery.matches.map(match => match.matchedText), ["hit-top-1", "hit-bottom-2"]);
            reset();
            add("b", "query_embed", "hit");
            const columnDom = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                '<div data-node-id="sb" data-type="NodeSuperBlock" data-sb-layout="col"><div data-node-id="left" data-type="NodeSuperBlock" data-sb-layout="row">' +
                '<div data-node-id="tl" data-type="NodeParagraph" data-rect="0,0">hit-topleft-1</div><div data-node-id="bl" data-type="NodeParagraph" data-rect="100,0">hit-bottomleft-3</div></div>' +
                '<div data-node-id="right" data-type="NodeSuperBlock" data-sb-layout="row"><div data-node-id="tr" data-type="NodeParagraph" data-rect="0,100">hit-topright-2</div>' +
                '<div data-node-id="br" data-type="NodeParagraph" data-rect="100,100">hit-bottomright-4</div></div></div></div>';
            wysiwyg.innerHTML = columnDom;
            const columnExpected = ["hit-topleft-1", "hit-topright-2", "hit-bottomleft-3", "hit-bottomright-4"];
            for (const selection of [false, true]) {
                const visual = selection ?
                    await selectedSearch("hit-[a-z]+-\\d+") :
                    await search("hit-[a-z]+-\\d+", {regex: true});
                assert.deepEqual(visual.matches.map(match => match.matchedText), columnExpected);
            }
            // A neighboring column can fall between two lines of one paragraph.
            const columnRangeRects = Range.prototype.getClientRects;
            Range.prototype.getClientRects = function() {
                const element = this.startContainer instanceof Element ?
                    this.startContainer :
                    this.startContainer.parentElement;
                const rect = fixtureRect(element);
                if (element?.closest('[data-node-id="multiline"]') && this.toString() === "hit-lower-3") {
                    return [{...rect, top: 100, bottom: 110}];
                }
                return [rect];
            };
            wysiwyg.innerHTML =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="cols" data-type="NodeSuperBlock" data-sb-layout="col">' +
                '<div data-node-id="multiline" data-type="NodeParagraph" data-rect="0,0">hit-upper-1<br>hit-lower-3</div>' +
                '<div data-node-id="neighbor" data-type="NodeParagraph" data-rect="50,100">hit-right-2</div></div></div>';
            try {
                for (const selection of [false, true]) {
                    const multiline = selection ?
                        await selectedSearch("hit-[a-z]+-\\d+") :
                        await search("hit-[a-z]+-\\d+", {regex: true});
                    assert.deepEqual(multiline.matches.map(match => match.matchedText), [
                        "hit-upper-1",
                        "hit-right-2",
                        "hit-lower-3",
                    ]);
                }
            } finally {
                Range.prototype.getClientRects = columnRangeRects;
            }
            wysiwyg.innerHTML =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="cols" data-type="NodeSuperBlock" data-sb-layout="col">' +
                '<div data-node-id="leftmixed" data-type="NodeParagraph" data-rect="0,0">hit-upper-1 ' +
                '<span data-type="inline-memo" data-inline-memo-content="hit-memo-3" data-rect="0,40">hit-host-2</span>' +
                '<span data-type="inline-math" data-content="x" data-render="true" data-rect="100,0"><span class="katex-html">hit-math-5</span></span>' +
                '<span data-rect="100,40">hit-lower-6</span></div><div data-node-id="rightmixed" data-type="NodeParagraph" data-rect="50,100">hit-right-4</div></div></div>';
            for (const selection of [false, true]) {
                const mixedColumns = selection ?
                    await selectedSearch("hit-[a-z]+-\\d+", {includeInlineMemo: true}) :
                    await search("hit-[a-z]+-\\d+", {regex: true, includeInlineMemo: true});
                assert.deepEqual(mixedColumns.matches.map(match => match.matchedText), [
                    "hit-upper-1",
                    "hit-host-2",
                    "hit-memo-3",
                    "hit-right-4",
                    "hit-math-5",
                    "hit-lower-6",
                ], "line geometry preserves memo host/content and formula ordering");
            }
            wysiwyg.innerHTML = columnDom;
            const structuralExpected = ["hit-topleft-1", "hit-bottomleft-3", "hit-topright-2", "hit-bottomright-4"];
            wysiwyg.firstElementChild.setAttribute("fold", "1");
            const foldedColumns = await search("hit-[a-z]+-\\d+", {regex: true});
            assert.deepEqual(foldedColumns.matches.map(match => match.matchedText), structuralExpected);
            wysiwyg.firstElementChild.removeAttribute("fold");
            const foldedHost = document.createElement("div");
            foldedHost.dataset.type = "NodeListItem";
            foldedHost.setAttribute("fold", "1");
            wysiwyg.firstElementChild.replaceWith(foldedHost);
            foldedHost.innerHTML = columnDom;
            const ancestorFolded = await search("hit-[a-z]+-\\d+", {regex: true});
            assert.deepEqual(ancestorFolded.matches.map(match => match.matchedText), structuralExpected);
            reset();
            add("b", "query_embed", "hit");
            doms.b = columnDom;
            const coldColumns = await settle("hit-[a-z]+-\\d+", {regex: true});
            assert.deepEqual(coldColumns.matches.map(match => match.matchedText), structuralExpected);
            rectReads = 0;
            source("frontend/embedded-order").orderEmbeddedVisualMatches(coldColumns.matches);
            assert.equal(rectReads, 0, "cold ordering adds no layout reads or rendering");
            // Many hits in one diagram label require only one rectangle per label.
            reset();
            add("b", "query_embed", "hit");
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid" data-render="true" data-content="graph TB">' +
                '<svg><text data-rect="100,0">' + "hit ".repeat(200) +
                '</text><text data-rect="0,0">hit</text></svg></div></div>';
            const manyHits = await selectedSearch("hit");
            rectReads = 0;
            source("frontend/embedded-order").orderEmbeddedVisualMatches(manyHits.matches);
            assert.equal(rectReads, 2);
            assert.equal(manyHits.matches.length, 201);
            // Above the global measurement budget, keep the deterministic structural order.
            wysiwyg.innerHTML =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="mermaid" data-render="true" data-content="graph TB"><svg>' +
                Array.from(
                    {length: 513},
                    (_, index) => '<text data-rect="' + (513 - index) + ',0">hit-' + index + "</text>",
                ).join("") + "</svg></div></div>";
            const boundedVisual = await selectedSearch("hit-\\d+");
            rectReads = 0;
            source("frontend/embedded-order").orderEmbeddedVisualMatches(boundedVisual.matches);
            assert.equal(rectReads, 0);
            assert.equal(boundedVisual.matches[0].matchedText, "hit-0");
        } finally {
            Element.prototype.getBoundingClientRect = elementRect;
            if (rangeRects) Range.prototype.getClientRects = rangeRects;
            else delete Range.prototype.getClientRects;
        }
        // Copied blocks share one navigation owner, but retain their DOM reading order.
        // Each unit starts its own offsets at zero; those offsets cannot order siblings.
        const mixedEmbedDom =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="protyle-wysiwyg__embed">' +
            '<div data-node-id="p-first" data-type="NodeParagraph">prefix hit-body-1 ' +
            '<span data-type="inline-math" data-content="x" data-render="true"><span class="katex-html">hit-math-2</span></span>' +
            ' hit-body-3 <span data-type="inline-memo" data-inline-memo-content="hit-memo-5">hit-host-4</span> hit-body-6</div>' +
            '<div data-node-id="c-middle" data-type="NodeCallout"><div class="callout-title">hit-title-7</div>' +
            '<div data-node-id="p-callout" data-type="NodeParagraph">hit-callout-8</div></div>' +
            '<div data-node-id="t-last" data-type="NodeTable"><div><table><tbody><tr><td>hit-cell-9 ' +
            '<span data-type="inline-math" data-content="y" data-render="true"><span class="katex-html">hit-cellmath-10</span></span>' +
            " hit-cell-11</td><td>hit-cell-12</td></tr><tr><td>hit-cell-13</td><td>hit-cell-14</td></tr></tbody></table></div></div>" +
            '<div data-node-id="p-last" data-type="NodeParagraph">hit-last-15</div></div></div>';
        const mixedExpected = [
            "hit-body-1",
            "hit-math-2",
            "hit-body-3",
            "hit-host-4",
            "hit-memo-5",
            "hit-body-6",
            "hit-title-7",
            "hit-callout-8",
            "hit-cell-9",
            "hit-cellmath-10",
            "hit-cell-11",
            "hit-cell-12",
            "hit-cell-13",
            "hit-cell-14",
            "hit-last-15",
        ];
        reset();
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML = mixedEmbedDom;
        const mixedLive = await search("hit-[a-z]+-\\d+", {regex: true, includeInlineMemo: true});
        full(mixedLive);
        assert.deepEqual(
            mixedLive.matches.map(match => match.matchedText),
            mixedExpected,
            "live embed follows copied DOM order",
        );
        assert.ok(mixedLive.matches.every(match => match.range && !match.replaceable));
        const mixedUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeInlineMemo: true});
        const mixedScope = new Map(mixedUnits.map(block => [
            source("frontend/selection").unitKey(block.blockId, block.unitId),
            [{start: 0, end: block.text.length}],
        ]));
        const mixedSelection = await source("frontend/pipeline").calculateSearchMatches({}, edit, "hit-[a-z]+-\\d+", {
            regex: true,
            includeFoldedBlocks: true,
            includeInlineMemo: true,
            selectionOnly: true,
            selectionScope: mixedScope,
        });
        assert.deepEqual(
            mixedSelection.matches.map(match => match.matchedText),
            mixedExpected,
            "selection pipeline uses the same order",
        );
        const mixedFiltered = await search("hit-[a-z]+-\\d+", {
            regex: true,
            includeInlineMemo: true,
            includeTable: false,
        });
        full(mixedFiltered);
        assert.deepEqual(
            mixedFiltered.matches.map(match => match.matchedText),
            mixedExpected.filter(text => !text.startsWith("hit-cell")),
        );
        // A later copied source ID must not inherit the first embed's index in an attribute-only search.
        reset();
        add("a", "query_embed", "hit");
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML = mixedEmbedDom.replace('data-node-id="b"', 'data-node-id="a"') + mixedEmbedDom;
        const duplicateUnits = source("frontend/blocks").collectSearchableBlocks(edit, {
            restrictInlineTypes: ["inline-math"],
        });
        const duplicateScope = new Map(duplicateUnits.map(block => [
            source("frontend/selection").unitKey(block.blockId, block.unitId),
            [{start: 0, end: block.text.length}],
        ]));
        const duplicateSelection = await source("frontend/pipeline").calculateSearchMatches(
            {},
            edit,
            "hit-[a-z]+-\\d+",
            {
                regex: true,
                restrictInlineTypes: ["inline-math"],
                selectionOnly: true,
                selectionScope: duplicateScope,
            },
        );
        assert.deepEqual(duplicateSelection.matches.map(match => [match.blockId, match.matchedText]), [
            ["a", "hit-math-2"],
            ["a", "hit-cellmath-10"],
            ["b", "hit-math-2"],
            ["b", "hit-cellmath-10"],
        ]);
        reset();
        add("b", "query_embed", "hit");
        doms.b = mixedEmbedDom;
        const mixedCold = await settle("hit-[a-z]+-\\d+", {regex: true, includeInlineMemo: true});
        full(mixedCold);
        assert.deepEqual(
            mixedCold.matches.map(match => match.matchedText),
            mixedExpected,
            "cold embed follows the same order",
        );
        const mixedCached = await search("hit-[a-z]+-\\d+", {regex: true, includeInlineMemo: true});
        full(mixedCached);
        assert.deepEqual(
            mixedCached.matches.map(match => match.matchedText),
            mixedExpected,
            "cached embed keeps structural positions",
        );
        // Renderer recovery removes healthy sibling renderers from its detached copy.
        // Rebase recovered positions onto live anchors before merging the two snapshots.
        reset();
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
            '<div data-node-id="healthy" data-type="NodeCodeBlock" data-subtype="graphviz" data-render="true"><svg><text>hit-healthy-1</text></svg></div>' +
            '<div data-node-id="between" data-type="NodeParagraph">hit-between-2</div>' +
            '<div data-node-id="pending" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="hit"></div>' +
            '<div data-node-id="after" data-type="NodeParagraph">hit-after-4</div></div>';
        let recoveryCalls = 0;
        const recoveryRenderer = host => {
            recoveryCalls++;
            host.querySelectorAll('[data-subtype="graphviz"]').forEach(block => {
                block.innerHTML = "<svg><text>hit-recovered-3</text></svg>";
            });
        };
        window.Protyle.graphvizRender = recoveryRenderer;
        for (let attempt = 0; attempt < 2; attempt++) {
            const recoveredOrder = await search("hit-[a-z]+-\\d+", {regex: true});
            full(recoveredOrder);
            assert.deepEqual(recoveredOrder.matches.map(match => match.matchedText), [
                "hit-healthy-1",
                "hit-between-2",
                "hit-recovered-3",
                "hit-after-4",
            ], "merged live/recovered/cached renderer order remains stable");
        }
        assert.equal(recoveryCalls, 1);
        const decorations = document.createElementNS("http://www.w3.org/2000/svg", "g");
        decorations.innerHTML = "<path></path><path></path>";
        wysiwyg.querySelector('[data-node-id="healthy"] svg').prepend(decorations);
        full(await search("hit-[a-z]+-\\d+", {regex: true}));
        assert.equal(recoveryCalls, 1, "healthy SVG shape changes cannot invalidate recovery content");
        const pendingRenderer = wysiwyg.querySelector('[data-node-id="pending"]');
        const gap = document.createElement("div");
        gap.textContent = "hit-gap-0";
        pendingRenderer.before(gap);
        const movedRecovery = await search("hit-[a-z]+-\\d+", {regex: true});
        full(movedRecovery);
        assert.deepEqual(movedRecovery.matches.map(match => match.matchedText), [
            "hit-healthy-1",
            "hit-between-2",
            "hit-gap-0",
            "hit-recovered-3",
            "hit-after-4",
        ], "recovery cache updates its position when non-block siblings shift its DOM position");
        assert.equal(recoveryCalls, 1, "a position-only change reuses recovered content");
        pendingRenderer.before(wysiwyg.querySelector('[data-node-id="after"]'));
        const movedBlockOrder = await search("hit-[a-z]+-\\d+", {regex: true});
        full(movedBlockOrder);
        assert.deepEqual(movedBlockOrder.matches.map(match => match.matchedText), [
            "hit-healthy-1",
            "hit-between-2",
            "hit-gap-0",
            "hit-after-4",
            "hit-recovered-3",
        ]);
        assert.equal(recoveryCalls, 1, "block reordering only updates the recovery anchor");
        pendingRenderer.innerHTML = "<svg><text>hit-recovered-3</text></svg>";
        const mountedRecovery = await search("hit-[a-z]+-\\d+", {regex: true});
        assert.deepEqual(
            mountedRecovery.matches.map(match => match.matchedText),
            movedBlockOrder.matches.map(match => match.matchedText),
        );
        assert.ok(mountedRecovery.matches.every(match => match.range));
        reset();
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
            '<div data-node-id="firstpending" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="first"></div>' +
            '<div data-node-id="secondpending" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="second"></div></div>';
        let pairRecoveryCalls = 0;
        window.Protyle.graphvizRender = host => {
            pairRecoveryCalls++;
            host.querySelectorAll('[data-subtype="graphviz"]').forEach(element => {
                element.innerHTML = "<svg><text>hit-" + element.dataset.content + "-1</text></svg>";
            });
        };
        const firstPair = await search("hit-[a-z]+-\\d+", {regex: true});
        full(firstPair);
        assert.deepEqual(firstPair.matches.map(match => match.matchedText), ["hit-first-1", "hit-second-1"]);
        const pairCalls = pairRecoveryCalls;
        wysiwyg.firstElementChild.prepend(wysiwyg.querySelector('[data-node-id="secondpending"]'));
        const reorderedPair = await search("hit-[a-z]+-\\d+", {regex: true});
        full(reorderedPair);
        assert.deepEqual(reorderedPair.matches.map(match => match.matchedText), ["hit-second-1", "hit-first-1"]);
        assert.equal(pairRecoveryCalls, pairCalls, "reordered renderer keys reuse content at their new anchors");
        reset();
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
            '<div data-node-id="h" data-type="NodeHTMLBlock"><protyle-html></protyle-html></div>' +
            '<div data-node-id="p" data-type="NodeParagraph">hit-after-3</div></div>';
        const htmlHost = wysiwyg.querySelector("protyle-html");
        const shadow = htmlHost.shadowRoot ?? htmlHost.attachShadow({mode: "open"});
        shadow.innerHTML = "<div>prefix hit-shadow-1</div><div>hit-shadow-2</div>";
        const shadowOrder = await search("hit-[a-z]+-\\d+", {regex: true});
        full(shadowOrder);
        assert.deepEqual(shadowOrder.matches.map(match => match.matchedText), [
            "hit-shadow-1",
            "hit-shadow-2",
            "hit-after-3",
        ]);
        // Reading each reached parent's sibling list once must remain linear for a large embed.
        const siblingDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling");
        const siblingReads = [];
        try {
            for (const size of [1000, 2000]) {
                const root = document.createElement("div");
                root.innerHTML = "<span>hit</span>".repeat(size);
                const blocks = Array.from(root.children, element => ({element, textNodes: [element.firstChild]}));
                let reads = 0;
                Object.defineProperty(Node.prototype, "nextSibling", {
                    ...siblingDescriptor,
                    get() {
                        reads++;
                        return siblingDescriptor.get.call(this);
                    },
                });
                source("frontend/embedded-order").recordEmbeddedOrder(root, blocks);
                siblingReads.push(reads);
                Object.defineProperty(Node.prototype, "nextSibling", siblingDescriptor);
                assert.equal(blocks.length, size);
            }
            assert.ok(siblingReads[1] <= siblingReads[0] * 2.1, "large embedded sibling indexing remains linear");
        } finally {
            Object.defineProperty(Node.prototype, "nextSibling", siblingDescriptor);
        }
        const deepReads = [];
        const parentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode");
        for (const depth of [200, 1000]) {
            const root = document.createElement("div");
            const blocks = [];
            let parent = root;
            for (let index = 0; index < depth; index++) {
                const child = document.createElement("span");
                const text = document.createTextNode("hit");
                parent.append(text, child);
                blocks.push({element: parent, textNodes: [text]});
                parent = child;
            }
            let reads = 0;
            Object.defineProperty(Node.prototype, "parentNode", {
                ...parentDescriptor,
                get() {
                    reads++;
                    return parentDescriptor.get.call(this);
                },
            });
            try {
                source("frontend/embedded-order").recordEmbeddedOrder(root, blocks);
            } finally {
                Object.defineProperty(Node.prototype, "parentNode", parentDescriptor);
            }
            const numbers = blocks.reduce((total, block) => total + block.embeddedOrder[0].path.length, 0);
            assert.equal(numbers, depth, "deep units store one rank each, not complete ancestor paths");
            assert.ok(reads <= depth * 3, "deep ordering cannot repeatedly climb ancestors");
            deepReads.push(reads);
        }
        const sparseReads = [];
        const nextDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling");
        const previousDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "previousSibling");
        for (const size of [1000, 10000, 50000]) {
            const root = document.createElement("div");
            root.innerHTML = "<div><svg>" + "<g><path></path></g>".repeat(size) + "</svg></div><p>hit</p>";
            let reads = 0;
            for (
                const [name, descriptor] of [["nextSibling", nextDescriptor], ["previousSibling", previousDescriptor], [
                    "parentNode",
                    parentDescriptor,
                ]]
            ) {
                Object.defineProperty(Node.prototype, name, {
                    ...descriptor,
                    get() {
                        reads++;
                        return descriptor.get.call(this);
                    },
                });
            }
            try {
                const block = {element: root.lastChild, textNodes: [root.lastChild.firstChild]};
                source("frontend/embedded-order").recordEmbeddedOrder(root, [block]);
                assert.ok(block.embeddedOrder.length);
            } finally {
                Object.defineProperty(Node.prototype, "nextSibling", nextDescriptor);
                Object.defineProperty(Node.prototype, "previousSibling", previousDescriptor);
                Object.defineProperty(Node.prototype, "parentNode", parentDescriptor);
            }
            assert.ok(reads < 20, "a sparse target cannot traverse unrelated SVG descendants");
            sparseReads.push(reads);
        }
        console.log("sparse unrelated SVG ordering reads OK", sparseReads);
        console.log("visual/bounded/deep embedded order OK", deepReads);
        console.log("embedded mixed/cold/selection/recovery/shadow order and linear sibling indexing OK", siblingReads);
        reset();
        add("b", "query_embed", "foo");
        doms.b = mountedEmbedDom;
        wysiwyg.innerHTML = mountedEmbedDom.replace(
            'data-node-id="outside"',
            'style="display:none" data-node-id="outside"',
        );
        const hiddenEmbedded = await search("generated");
        full(hiddenEmbedded);
        assert.equal(hiddenEmbedded.matches.length, 0, "author-hidden embedded children cannot return via kernel DOM");
        assert.equal(domCalls, 0);
        reset();
        add("b", "query_embed", "foo");
        const inlineFormula =
            '<span data-type="inline-math" data-subtype="math" data-content="a" data-render="true"><span class="katex-html">α</span></span>';
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="p1" data-type="NodeParagraph">' +
            inlineFormula + '</div><div data-node-id="p2" data-type="NodeParagraph">' + inlineFormula + "</div></div>";
        const embeddedMath = await search("α");
        full(embeddedMath);
        assert.equal(embeddedMath.matches.length, 2);
        assert.notEqual(embeddedMath.matches[0].range.startContainer, embeddedMath.matches[1].range.startContainer);
        const mathUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeAttributeView: false});
        const reboundMath = source("frontend/corpus/project").rebindChangedRanges(
            embeddedMath.matches,
            mathUnits,
            new Map(embeddedMath.matches.map((match) => [match, {broken: true, blockShown: true}])),
            {allowFoldedHidden: true},
        );
        assert.notEqual(
            reboundMath.matches[0].range.startContainer,
            reboundMath.matches[1].range.startContainer,
            "same formula in different embedded source blocks keeps its own range",
        );
        reset();
        add("b", "query_embed", "foo");
        doms.b =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="li" data-node-id="li" data-type="NodeListItem" fold="1"><div></div><div></div>' +
            '<div data-node-id="outside" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div></div></div>';
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const withoutFold = await settle("generated", {includeFoldedBlocks: false});
            full(withoutFold);
            assert.equal(withoutFold.matches.length, 0);
            const withFold = await settle("generated", {includeFoldedBlocks: true});
            full(withFold);
            assert.equal(
                withFold.matches.length,
                1,
                "folded-content cache scope cannot reuse the disabled empty result",
            );
        } finally {
            corpus.releaseBackgroundCorpusRoot("r");
        }
        // A failed child cannot suppress a healthy sibling; nested container gates
        // apply to rendering and coverage, and embedded waves remain bounded.
        reset();
        let pendingEmbedded = 0;
        let peakEmbedded = 0;
        const embeddedWaves = [];
        window.Protyle = {
            graphvizRender: (host) => {
                const diagrams = Array.from(host.querySelectorAll('[data-subtype="graphviz"]'));
                embeddedWaves.push(diagrams.length);
                pendingEmbedded += diagrams.length;
                peakEmbedded = Math.max(peakEmbedded, pendingEmbedded);
                window.setTimeout(() => {
                    diagrams.forEach((diagram) => {
                        diagram.innerHTML = diagram.dataset.nodeId === "d0" ?
                            '<div class="ft__error"><svg><text>error</text></svg></div>' :
                            "<div><svg><text>" + diagram.dataset.nodeId + "</text></svg></div>";
                    });
                    pendingEmbedded -= diagrams.length;
                }, 10);
            },
        };
        const diagramDom = (id) =>
            '<div data-node-id="' + id +
            '" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="foo"><div></div></div>';
        const boundedEmbed = await extract.extractUnitsFromDoms(
            ["b"],
            {
                b: '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                    Array.from({length: 5}, (_, index) => diagramDom("d" + index)).join("") +
                    '<div data-node-id="q" data-type="NodeBlockquote">' + diagramDom("disabled") + "</div></div>",
            },
            {includeBlockquote: false},
            new Set(["b"]),
            "light",
        );
        assert.deepEqual(embeddedWaves, [2, 2, 1]);
        assert.equal(peakEmbedded, 2);
        assert.deepEqual(boundedEmbed.unrenderedIds, ["b"]);
        assert.deepEqual(boundedEmbed.blocks.map((block) => block.text), ["d1", "d2", "d3", "d4"]);
        boundedEmbed.dispose();
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        reset();
        add("b", "c", "foo", "graphviz");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="foo"><div></div></div>';
        const gates = [];
        let beginRender;
        const began = new Promise((resolve) => {
            beginRender = resolve;
        });
        window.Protyle = {
            graphvizRender: (host) => {
                renderCalls += 1;
                gates.push(() => {
                    host.querySelector('[data-node-id="b"]').innerHTML =
                        "<div><svg><text>foo</text><text>generated</text></svg></div>";
                });
                beginRender();
            },
        };
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const warming = await search("generated");
            assert.equal(warming.partial, true);
            await began;
            const controller = new AbortController();
            const joined = search("foo", {signal: controller.signal});
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(renderCalls, 1, "foreground reuses the background diagram render");
            assert.equal(domCalls, 1);
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 1);
            controller.abort();
            assert.equal((await joined).cancelled, true, "one waiter can cancel independently");
            gates[0]();
            const reused = await settle("generated");
            full(reused);
            assert.equal(reused.matches.length, 1, "cancelled waiter does not cancel the background owner");
            assert.equal(renderCalls, 1);
        } finally {
            corpus.releaseBackgroundCorpusRoot("r");
        }
        for (const cancelBoth of [false, true]) {
            reset();
            add("b", "c", "foo", "graphviz");
            doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-content="foo"><div></div></div>';
            let finish;
            let started;
            const rendering = new Promise((resolve) => {
                started = resolve;
            });
            window.Protyle = {
                graphvizRender: (host) => {
                    renderCalls += 1;
                    finish = () => {
                        host.querySelector('[data-node-id="b"]').innerHTML = "<div><svg><text>foo</text></svg></div>";
                    };
                    started();
                },
            };
            const firstController = new AbortController();
            const secondController = new AbortController();
            const first = search("foo", {signal: firstController.signal});
            await rendering;
            const second = search("foo", {signal: secondController.signal});
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(renderCalls, 1);
            assert.equal(domCalls, 1, "overlapping foreground queries share one DOM request");
            firstController.abort();
            assert.equal((await first).cancelled, true);
            if (cancelBoth) {
                secondController.abort();
                assert.equal((await second).cancelled, true);
            } else {
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 1);
                finish();
                const surviving = await second;
                full(surviving);
                assert.equal(surviving.matches.length, 1, "creator cancellation preserves its surviving waiter");
            }
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0, "last owner disposes its host");
            if (cancelBoth) {
                window.Protyle = {graphvizRender: renderer};
                full(await search("foo"));
                assert.equal(domCalls, 2, "fully cancelled flight leaves no successful or failed cache entry");
            }
        }
        reset();
        add("b", "p", "xaaab");
        doms.b = '<div data-node-id="b" data-type="NodeParagraph">xaaab</div>';
        const repeatedRegex = await search("xa+b", {regex: true, caseSensitive: true});
        full(repeatedRegex);
        assert.equal(repeatedRegex.matches.length, 1, "corpus SQL cannot exclude variable quantifier matches");
        // A native query can display a container and its child, so source IDs can
        // repeat inside one owner. Both visible instances must remain searchable.
        reset();
        add("b", "query_embed", "foo");
        const repeatedBody =
            '<div data-node-id="same" data-type="NodeParagraph"><div contenteditable="true">foo <span data-type="inline-math" data-content="alpha"><span class="katex-html">α</span></span><span data-type="inline-memo" data-inline-memo-content="memo">note</span></div></div>';
        const repeatDom = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="protyle-wysiwyg__embed">' +
            repeatedBody + '</div><div class="protyle-wysiwyg__embed">' + repeatedBody + "</div></div>";
        wysiwyg.innerHTML = repeatDom;
        for (const query of ["foo", "α", "memo"]) {
            const result = await search(query, {includeInlineMemo: true});
            full(result);
            assert.equal(result.matches.length, 2, "visible copied " + query + " is counted twice");
            assert.notEqual(result.matches[0].unitId, result.matches[1].unitId);
            assert.ok(result.matches.every(match => match.range && !match.replaceable));
            assert.notEqual(result.matches[0].range.startContainer, result.matches[1].range.startContainer);
            const blocks = source("frontend/blocks").collectSearchableBlocks(edit, {includeInlineMemo: true});
            const rebind = source("frontend/corpus/project").rebindChangedRanges(
                result.matches,
                blocks,
                new Map(result.matches.map(match => [match, {broken: true, blockShown: true}])),
                {allowFoldedHidden: true},
            );
            assert.notEqual(rebind.matches[0].range.startContainer, rebind.matches[1].range.startContainer);
            const second = blocks.filter(block =>
                block.element.closest(".protyle-wysiwyg__embed") === wysiwyg.firstElementChild.lastElementChild
            );
            const scope = new Map(
                second.map(
                    block => [source("frontend/selection").unitKey(block.blockId, block.unitId), [{
                        start: 0,
                        end: block.text.length,
                    }]],
                ),
            );
            const selected = await source("frontend/pipeline").calculateSearchMatches({}, edit, query, {
                selectionOnly: true,
                selectionScope: scope,
                includeInlineMemo: true,
            });
            assert.equal(selected.matches.length, 1, "selection on second copy never includes first");
        }
        doms.b = repeatDom;
        wysiwyg.innerHTML = "";
        const coldCopies = await search("foo");
        full(coldCopies);
        assert.equal(coldCopies.matches.length, 2);
        assert.equal((await search("foo")).matches.length, 2, "cache preserves instance identity");
        // Recovering one copy must not inherit the healthy copy's ID after pruning.
        reset();
        add("b", "query_embed", "hit");
        wysiwyg.innerHTML =
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="same" data-type="NodeCodeBlock" data-subtype="graphviz"><svg><text>hit-first</text></svg></div><div data-node-id="same" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="hit"></div></div>';
        window.Protyle.graphvizRender = host =>
            host.querySelectorAll('[data-subtype="graphviz"]').forEach(element => {
                element.innerHTML = "<svg><text>hit-second</text></svg>";
            });
        const repeatedRecovery = await search("hit-[a-z]+", {regex: true});
        full(repeatedRecovery);
        assert.deepEqual(repeatedRecovery.matches.map(match => match.matchedText), ["hit-first", "hit-second"]);
        assert.notEqual(repeatedRecovery.matches[0].unitId, repeatedRecovery.matches[1].unitId);
        assert.deepEqual(
            (await search("hit-[a-z]+", {regex: true})).matches.map(match => match.unitId),
            repeatedRecovery.matches.map(match => match.unitId),
        );
        reset();
        add("b", "query_embed", "alpha");
        const healthyMath =
            '<div data-node-id="same" data-type="NodeParagraph"><span data-type="inline-math" data-subtype="math" data-content="alpha" data-render="true"><span class="katex-html">α</span></span></div>';
        const pendingMathCopy = healthyMath.replace(' data-render="true"', "").replace(
            '<span class="katex-html">α</span>',
            "",
        );
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + healthyMath + pendingMathCopy +
            "</div>";
        window.Protyle.mathRender = host =>
            host.querySelectorAll('[data-type="inline-math"]:not([data-render="true"])').forEach(element => {
                element.innerHTML = '<span class="katex-html">α</span>';
                element.setAttribute("data-render", "true");
            });
        const recoveredMathCopies = await search("α");
        full(recoveredMathCopies);
        assert.equal(
            recoveredMathCopies.matches.length,
            2,
            "pending formula never merges with its healthy source copy",
        );
        assert.notEqual(recoveredMathCopies.matches[0].unitId, recoveredMathCopies.matches[1].unitId);
        assert.deepEqual(
            (await search("α")).matches.map(match => match.unitId),
            recoveredMathCopies.matches.map(match => match.unitId),
        );
        for (const language of ["mermaid", "flowchart"]) {
            reset();
            add("b", "query_embed", "sourceHit");
            const graph = '<div data-node-id="same" data-type="NodeCodeBlock" data-subtype="' + language +
                '" data-content="sourceHit"><svg><text>visibleHit</text></svg></div>';
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + graph + graph + "</div>";
            const liveGraphs = await search("visibleHit");
            full(liveGraphs);
            assert.equal(liveGraphs.matches.length, 2);
            assert.notEqual(liveGraphs.matches[0].unitId, liveGraphs.matches[1].unitId);
            const state = new (source("frontend/diagram-search-state").DiagramSearchState)();
            state.capture(source("frontend/blocks").collectSearchableBlocks(edit));
            const secondGraph = wysiwyg.firstElementChild.lastElementChild;
            secondGraph.querySelector("text").textContent = "changedHit";
            assert.equal(state.changed(edit, new Set([secondGraph]), {includeFoldedBlocks: true}), true);
            assert.equal(
                (await search("visibleHit")).matches.length,
                1,
                "changing second source copy leaves first visible graph searchable",
            );
            assert.equal((await search("changedHit")).matches.length, 1);
            wysiwyg.firstElementChild.setAttribute("fold", "1");
            const foldedGraphs = await search("visibleHit");
            full(foldedGraphs);
            assert.equal(foldedGraphs.matches.length, 1, "folded copies retain their rendered labels");
            assert.equal((await search("sourceHit")).matches.length, 0);
            doms.b = wysiwyg.innerHTML;
            wysiwyg.innerHTML = "";
            assert.equal(
                (await search("visibleHit")).matches.length,
                1,
                "offscreen query preserves existing graph output per copy",
            );
            assert.equal((await search("changedHit")).matches.length, 1);
            assert.equal((await search("sourceHit")).matches.length, 0);
            assert.equal(renderCalls, 0, "copied Mermaid/flowchart never offscreen-render");
        }
        // Concurrent panes share a native query, so a second failure cannot overwrite success.
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        const secondEdit = edit.cloneNode(true);
        document.body.appendChild(secondEdit);
        editors.push({protyle: {element: secondEdit, notebookId: "", block: {id: "r", rootID: "r"}}});
        let bothDomsRead;
        const domBarrier = new Promise(resolve => bothDomsRead = resolve);
        domResponder = async () => {
            if (domCalls === 2) bothDomsRead();
            await domBarrier;
            return {code: 0, data: doms};
        };
        let finishSharedQuery;
        let sharedQueryEntered;
        const sharedQueryStarted = new Promise(resolve => sharedQueryEntered = resolve);
        embedResponder = async () => {
            if (embedRequests.length > 1) return {code: -1};
            sharedQueryEntered();
            return new Promise(resolve =>
                finishSharedQuery = () =>
                    resolve({
                        code: 0,
                        data: {
                            blocks: [{
                                block: {
                                    id: "source",
                                    content: '<div data-node-id="source" data-type="NodeParagraph">sharedKeyword</div>',
                                },
                            }],
                        },
                    })
            );
        };
        try {
            const first = search("sharedKeyword");
            const second = corpus.searchCurrentDocument({}, secondEdit, "sharedKeyword", {
                includeAttributeView: false,
                includeFoldedBlocks: true,
            });
            await sharedQueryStarted;
            finishSharedQuery();
            const results = await Promise.all([first, second]);
            for (const result of results) {
                full(result);
                assert.equal(result.matches.length, 1);
            }
            full(await search("sharedKeyword"));
            assert.equal((await search("sharedKeyword")).matches.length, 1);
            assert.equal(embedRequests.length, 1, "shared successful query stays cached in both panes");
        } finally {
            editors = editors.filter(editor => editor.protyle.element !== secondEdit);
            secondEdit.remove();
        }
        // A later pane can miss the native flight while the first response is still rendering.
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        const lateEdit = edit.cloneNode(true);
        document.body.appendChild(lateEdit);
        editors.push({protyle: {element: lateEdit, notebookId: "", block: {id: "r", rootID: "r"}}});
        let rendererEntered;
        let finishRenderer;
        const rendererStarted = new Promise(resolve => rendererEntered = resolve);
        window.Protyle.graphvizRender = async host => {
            rendererEntered();
            await new Promise(resolve => finishRenderer = resolve);
            host.querySelectorAll('[data-subtype="graphviz"]').forEach(graph => {
                graph.innerHTML = "<svg><text>lateKeyword</text></svg>";
            });
        };
        let failureEntered;
        let finishFailure;
        const failureStarted = new Promise(resolve => failureEntered = resolve);
        embedResponder = async () => {
            if (embedRequests.length === 1) {
                return {
                    code: 0,
                    data: {
                        blocks: [{
                            block: {
                                id: "source",
                                content:
                                    '<div data-node-id="source" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="graph"><div></div></div>',
                            },
                        }],
                    },
                };
            }
            failureEntered();
            return new Promise(resolve => finishFailure = () => resolve({code: -1}));
        };
        try {
            const first = search("lateKeyword");
            await rendererStarted;
            const late = corpus.searchCurrentDocument({}, lateEdit, "lateKeyword", {
                includeAttributeView: false,
                includeFoldedBlocks: true,
            });
            await failureStarted;
            finishRenderer();
            assert.equal((await first).matches.length, 1);
            finishFailure();
            assert.equal((await late).unrendered, 1);
            const reused = await search("lateKeyword");
            full(reused);
            assert.equal(reused.matches.length, 1, "late failed extraction cannot overwrite complete embed cache");
            assert.equal(embedRequests.length, 2);
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        } finally {
            editors = editors.filter(editor => editor.protyle.element !== lateEdit);
            lateEdit.remove();
        }
        const {resolveEmbedQuery} = source("frontend/corpus/embed-query");
        for (const cancelBoth of [false, true]) {
            reset();
            const html =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
            let release;
            let entered;
            let nativeSignal;
            const started = new Promise(resolve => entered = resolve);
            embedResponder = async (_body, signal) => {
                nativeSignal = signal;
                entered();
                return new Promise(resolve => release = () => resolve({code: 0, data: {blocks: []}}));
            };
            const firstController = new AbortController();
            const secondController = new AbortController();
            const first = resolveEmbedQuery("b", html, "r", "", () => true, firstController.signal);
            const second = resolveEmbedQuery("b", html, "r", "", () => true, secondController.signal);
            await started;
            firstController.abort();
            assert.equal(await first, null);
            assert.equal(nativeSignal.aborted, false, "one pane cannot abort the other's native query");
            if (cancelBoth) {
                secondController.abort();
                assert.equal(await second, null);
                assert.equal(nativeSignal.aborted, true, "last consumer aborts the native query");
            }
            release();
            if (!cancelBoth) assert.ok(await second);
            assert.equal(embedRequests.length, 1);
            embedResponder = async () => ({code: 0, data: {blocks: []}});
            assert.ok(await resolveEmbedQuery("b", html, "r", "", () => true));
            assert.equal(embedRequests.length, 2, "settled/cancelled flights retain no response cache");
        }
        reset();
        embedResponder = async () => ({code: 0, data: {blocks: []}});
        const queryHtml = (stmt, mode = "0") =>
            '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="' +
            stmt + '" custom-heading-mode="' + mode + '"></div>';
        await Promise.all([
            resolveEmbedQuery("b", queryHtml("select * from blocks"), "r", "", () => true),
            resolveEmbedQuery("b", queryHtml("select * from blocks where type='p'"), "r", "", () => true),
            resolveEmbedQuery("b", queryHtml("select * from blocks", "1"), "r", "", () => true),
            resolveEmbedQuery("b", queryHtml("select * from blocks"), "other-root", "", () => true),
            resolveEmbedQuery("b", queryHtml("select * from blocks"), "r", "encrypted-box", () => true),
        ]);
        assert.equal(embedRequests.length, 5, "SQL, heading mode, root and notebook isolate native flights");
        console.log("embedded native query sharing, cancellation isolation and request identity OK");
        // Cold embedded databases use AV pagination, without rendering or caching field values as embed text.
        const avModule = source("frontend/corpus/av");
        const avShell = (view = "v") =>
            '<div data-node-id="source-av" data-type="NodeAttributeView" data-av-id="av-id" custom-sy-av-view="' +
            view + '" data-av-type="table"><div></div></div>';
        const embedShell = id =>
            '<div data-node-id="' + id +
            '" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        const avRaw = {name: "database", views: [{id: "v", name: "table"}, {id: "v2", name: "other"}]};
        // Default AV search uses cell runs; inline restrictions use independent
        // math units. Neither path should duplicate glyphs or expose MathML.
        const avFormula = '<span data-type="inline-math" data-subtype="math" data-content="\\alpha" data-render="true">' +
            '<span class="katex"><span class="katex-mathml">mathmlSecret</span>' +
            '<span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">α</span></span>' +
            '<span class="base"><span class="mord">α</span></span></span></span></span>';
        for (const embedded of [false, true]) {
            for (const folded of [false, true]) {
                reset();
                const shell = (embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"'))
                    .replace('data-av-type="table"', 'data-av-type="gallery"');
                add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
                doms.b = embedded ? embedShell("b") : shell;
                if (embedded) embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
                avResponder = async url => ({code: 0, data: url.endsWith("getAttributeView") ? avRaw : {view: {
                    type: "gallery", fields: [{id: "col", type: "text"}],
                    groups: [{id: "g", groupHidden: 0, cardCount: 1,
                        cards: [{id: "row", values: [{value: {keyID: "col", type: "text", text: {content: "storedSecret"}}}]}]}],
                }}});
                const cell = '<div class="av__cell" data-col-id="col"><div class="av__celltext av__celltext--rich b3-typography">' +
                    '<p>beforeKeyword' + avFormula + 'middleKeyword' + avFormula + 'afterKeyword</p>' +
                    // Block math in a rich preview has no NodeMathBlock owner;
                    // the ordinary cell collector must still retain its glyphs.
                    '<div data-subtype="math"><span class="katex"><span class="katex-mathml">mathmlSecret</span>' +
                    '<span class="katex-html">β</span></span></div></div></div>';
                const content = '<div class="av__group-title"><span data-type="av-group-fold" data-id="g"></span></div>' +
                    '<div class="av__body' + (folded ? ' fn__none' : '') + '" data-group-id="g">' +
                    '<div class="av__gallery-item" data-id="row">' + cell + '</div></div>';
                wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                    shell.replace("<div></div>", content) + (embedded ? "</div>" : "");
                corpus.retainBackgroundCorpusRoot("r");
                try {
                    const options = {includeAttributeView: true};
                    const result = await settle("α", options);
                    full(result);
                    assert.equal(result.matches.length, 2, "two real formulas, no cell/glyph duplication");
                    assert.ok(result.matches.every(match => !match.replaceable));
                    const mathOnly = await search("α", {...options, restrictInlineTypes: ["inline-math"]});
                    assert.equal(mathOnly.matches.length, 2);
                    assert.ok(mathOnly.matches.every(match => match.highlightKind === "inline-math" && !match.replaceable));
                    assert.ok(mathOnly.matches.every(match => match.unitId.includes("cell:g:row:col:inline-math:")),
                        "math-only units retain the target group and cell identity");
                    assert.equal((await search("α", {...options, restrictInlineTypes: ["inline-math", "strong"]})).matches.length, 2,
                        "mixed inline restrictions still collect each formula exactly once");
                    assert.equal((await search("α", {...options, restrictInlineTypes: ["strong"]})).matches.length, 0);
                    assert.equal((await search("α", {includeAttributeView: false})).matches.length, 0);
                    const ordered = await search("Keyword|α|β", {...options, regex: true});
                    assert.deepEqual(ordered.matches.map(match => match.matchedText), ["Keyword", "α", "Keyword", "α", "Keyword", "β"],
                        "formula deduplication preserves cell reading order");
                    for (const query of ["beforeKeyword", "middleKeyword", "afterKeyword", "β"]) {
                        assert.equal((await search(query, options)).matches.length, 1, "surrounding text and block math retained: " + query);
                    }
                    for (const query of ["mathmlSecret", "storedSecret", "beforeKeywordmiddleKeyword"]) {
                        assert.equal((await search(query, options)).matches.length, 0, "hidden source and cross-formula text excluded: " + query);
                    }
                    if (folded) wysiwyg.querySelector(".av__body").classList.remove("fn__none");
                    const rebound = source("frontend/corpus/project").fillLiveRanges(result.matches,
                        source("frontend/blocks").collectSearchableBlocks(edit, options), true);
                    assert.ok(rebound.every(match => match.range?.toString() === "α"), "formula offsets bind after group expansion");
                    // A separately hidden UI ancestor still excludes its formula.
                    wysiwyg.querySelector(".av__body").classList.add("fn__none");
                    wysiwyg.querySelector(".av__celltext").classList.add("fn__none");
                    assert.equal((await search("α", options)).matches.length, 0);
                } finally {
                    avModule.releaseAvCacheOwner("r", edit);
                    corpus.releaseBackgroundCorpusRoot("r");
                }
            }
        }
        assert.deepEqual(source("frontend/blocks").attributeViewHtmlTexts(avFormula), ["α"],
            "inert API template glyphs remain searchable without MathML or a live formula collector");
        assert.deepEqual(source("frontend/blocks").attributeViewHtmlTexts('<math>mathmlSecret</math><annotation>annotationSecret</annotation>'), []);
        assert.deepEqual(source("frontend/blocks").attributeViewHtmlTexts('<span data-type="inline-math">templateKeyword</span>'), ["templateKeyword"],
            "unrendered template spans retain their actual visible fallback text");
        console.log("ordinary/embedded AV inline math counts, folded groups, restrictions and block-math coverage OK");
        // Native kanban titles have no fold button: the ID is on their parent.
        for (const embedded of [false, true]) {
            reset();
            const shell = (embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"'))
                .replace('data-av-type="table"', 'data-av-type="kanban"');
            add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
            doms.b = embedded ? embedShell("b") : shell;
            if (embedded) embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
            let reads = 0;
            avResponder = async url => {
                reads++;
                return {code: 0, data: url.endsWith("getAttributeView") ? avRaw : {view: {
                    type: "kanban", fields: [{id: "col", type: "select"}],
                    groups: ["g1", "g2"].map(id => ({
                        id, groupHidden: 0, groupValue: {type: "select", mSelect: [{content: "categoryKeyword"}]},
                        cardCount: 1, cards: [{id: "row", values: [{value: {
                            keyID: "col", type: "select", mSelect: [{content: "categoryKeyword"}],
                        }}]}],
                    })),
                }}};
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const options = {includeAttributeView: true};
                const cold = await settle("categoryKeyword", options);
                full(cold);
                assert.equal(cold.matches.length, 4, "two titles and two visible card fields");
                const beforeMount = reads;
                const content = ["g1", "g2"].map(id => '<div class="av__kanban-group" data-group-id="' + id + '">' +
                    '<div class="av__group-title"><span class="av__group-name"><span class="b3-chip">categoryKeyword</span></span>' +
                    '<span class="av__group-counter">1</span></div><div class="av__body" data-group-id="' + id + '">' +
                    '<div class="av__gallery-item" data-id="row"><div class="av__cell" data-field-id="col">' +
                    '<span class="b3-chip">categoryKeyword</span></div></div></div></div>').join("");
                wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                    shell.replace("<div></div>", content) + (embedded ? "</div>" : "");
                const mounted = await search("categoryKeyword", options);
                full(mounted);
                assert.equal(mounted.matches.length, 4, "native kanban IDs suppress API copies, not real repeated labels");
                assert.ok(mounted.matches.every(match => match.range && !match.replaceable));
                assert.deepEqual(mounted.matches.map(match => match.unitId.replace(/^embed:[^:]+:/, "")), [
                    "group-title:g1", "cell:g1:row:col", "group-title:g2", "cell:g2:row:col",
                ]);
                const rebound = source("frontend/corpus/project").fillLiveRanges(cold.matches,
                    source("frontend/blocks").collectSearchableBlocks(edit, options), true);
                assert.ok(rebound.every(match => match.range), "cold titles and card fields bind to native kanban DOM");
                assert.equal((await search("^1$", {...options, regex: true})).matches.length, 2);
                wysiwyg.innerHTML = "";
                assert.equal((await search("categoryKeyword", options)).matches.length, 4);
                assert.equal(reads, beforeMount, "kanban mount/unmount needs no extra requests");
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log("ordinary/embedded native kanban title identity, counts, ranges and cache transitions OK");
        for (const embedded of [false, true]) {
            reset();
            const cases = [
                {id: "template", type: "text", text: {content: "rawSecret"}, hasRenderTemplate: true,
                    renderedContent: '<span title="attributeSecret">shownKeyword</span><script>scriptSecret</script><span style="display:none">cssSecret</span>',
                    html: '<span title="attributeSecret">shownKeyword</span><script>scriptSecret</script><span style="display:none">cssSecret</span>'},
                {id: "emptyTemplate", type: "text", text: {content: "rawSecret"}, renderedContent: "", html: ""},
                {id: "columnTemplate", type: "text", text: {content: "rawSecret"}, column: {renderTemplate: "{{.}}"}, html: ""},
                {id: "templateType", type: "template", template: {content: "<b>templateKeyword</b>"}, html: "<b>templateKeyword</b>"},
                {id: "templateRuns", type: "text", hasRenderTemplate: true, renderedContent: "oneKeyword<br>twoKeyword",
                    html: "oneKeyword<br>twoKeyword"},
                {id: "asset", type: "mAsset", mAsset: [
                    {type: "file", name: "fileKeyword.pdf", content: "assets/pathSecret.pdf"},
                    {type: "image", name: "imageSecret", content: "assets/imageSecret.png"},
                ], html: '<span class="b3-chip">fileKeyword.pdf</span><img src="assets/imageSecret.png">'},
                {id: "assetRuns", type: "mAsset", mAsset: [
                    {type: "file", name: "beforeKeyword", content: "assets/pathSecret.pdf"},
                    {type: "image", content: "assets/imageSecret.png"},
                    {type: "file", name: "afterKeyword", content: "assets/pathSecret.pdf"},
                ], html: '<span>beforeKeyword</span><img src="assets/imageSecret.png"><span>afterKeyword</span>'},
                {id: "select", type: "select", mSelect: [{content: "firstKeyword"}, {content: "selectSecret"}],
                    html: '<span class="b3-chip">firstKeyword</span>'},
                {id: "multi", type: "mSelect", mSelect: [{content: "firstKeyword"}, {content: "secondKeyword"}],
                    html: '<span class="b3-chip">firstKeyword</span><span class="b3-chip">secondKeyword</span>'},
                {id: "relation", type: "relation", relation: {contents: [
                    {type: "block", block: {content: "firstKeyword"}}, {type: "block", block: {content: "secondKeyword"}},
                ]}, html: '<span class="av__celltext">firstKeyword</span><span class="av__celltext">secondKeyword</span>'},
                {id: "relationRuns", type: "relation", relation: {contents: [
                    {type: "block", block: {content: "rawSecret"}, renderedContent: "oneKeyword<br>twoKeyword"},
                ]}, html: '<span class="av__cell--relation"><span class="av__celltext av__celltext--template">oneKeyword<br>twoKeyword</span></span>'},
                {id: "rollup", type: "rollup", rollup: {contents: [
                    {type: "text", text: {content: "firstKeyword"}}, {type: "number", number: {content: 0}},
                    {type: "mSelect", mSelect: [{content: "secondKeyword"}, {content: "thirdKeyword"}]},
                ]}, html: 'firstKeyword, 0, <span class="b3-chip">secondKeyword</span><span class="b3-chip">thirdKeyword</span>'},
            ];
            const shell = embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"');
            add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
            doms.b = embedded ? embedShell("b") : shell;
            if (embedded) embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
            avResponder = async url => ({code: 0, data: url.endsWith("getAttributeView") ? avRaw : {view: {
                type: "table", columns: cases.map(item => ({id: item.id, type: item.type, ...item.column})), rowCount: 1,
                rows: [{id: "row", cells: cases.map(({html, column, id, ...value}) => ({value: {keyID: id, ...value}}))}],
            }}});
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const options = {includeAttributeView: true};
                const cold = await settle("Keyword", options);
                full(cold);
                assert.equal(cold.matches.length, 17, "native display values, not underlying source/attributes");
                for (const query of ["Secret", "oneKeywordtwoKeyword", "beforeKeywordafterKeyword", "<b>"]) {
                    assert.equal((await search(query, options)).matches.length, 0, "non-visible/cross-barrier text: " + query);
                }
                const content = '<div class="av__row" data-id="row">' + cases.map(item =>
                    '<div class="av__cell" data-col-id="' + item.id + '">' + item.html + '</div>').join("") + '</div>';
                wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                    shell.replace("<div></div>", content) + (embedded ? "</div>" : "");
                const live = source("frontend/blocks").collectSearchableBlocks(edit, options);
                const mounted = await search("Keyword", options);
                full(mounted);
                assert.equal(mounted.matches.length, cold.matches.length);
                const rebound = source("frontend/corpus/project").fillLiveRanges(cold.matches, live, true);
                assert.ok(rebound.every(match => match.range?.toString() === "Keyword"), "all native offsets bind after mounting");
                assert.ok(mounted.matches.every(match => match.range && !match.replaceable));
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log("ordinary/embedded AV templates, assets, select, relation, rollup and native offsets OK");
        let templateUpgrades = 0;
        window.customElements.define("av-search-contract", class extends HTMLElement {
            constructor() { super(); templateUpgrades++; }
        });
        assert.deepEqual(source("frontend/blocks").attributeViewHtmlTexts(
            '<av-search-contract>safeKeyword</av-search-contract><img src="http://invalid.test/asset">' +
            '<script>secret</script><iframe>secret</iframe><template>secret</template>'
        ), ["safeKeyword"]);
        assert.equal(templateUpgrades, 0, "template extraction does not upgrade custom elements or mount HTML");
        for (const embedded of [false, true]) {
            reset();
            const shell = embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"');
            add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
            doms.b = embedded ? embedShell("b") : shell;
            if (embedded) embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
            const requests = [];
            avResponder = async (url, body) => {
                if (url.endsWith("getAttributeView")) return {code: 0, data: avRaw};
                requests.push(body);
                const query = body.query || "";
                const count = query ? 201 : 202;
                const start = (body.page - 1) * 200;
                return {code: 0, data: {view: {
                    type: "table", columns: [{id: "col", type: "text"}], rowCount: count,
                    rows: Array.from({length: Math.min(count - start, 200)}, (_, index) => ({
                        id: "row" + (start + index), cells: [{value: {keyID: "col", type: "text",
                            text: {content: query || start + index < 201 ? "keepKeyword" : "filteredSecret"}}}],
                    })),
                }}};
            };
            const mount = query => {
                const content = '<div class="av__header"><div data-type="av-search" contenteditable="plaintext-only">' + query + '</div></div>';
                wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                    shell.replace("<div></div>", content) + (embedded ? "</div>" : "");
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const options = {includeAttributeView: true};
                // Warm the unfiltered cache first; it must never leak into a filtered DOM copy.
                full(await settle("filteredSecret", options));
                requests.length = 0;
                mount("  keep  ");
                const filtered = await settle("filteredSecret", options);
                full(filtered);
                assert.equal(filtered.matches.length, 0, "native query excludes hidden rows from API completion");
                assert.equal(requests.length, 2);
                assert.ok(requests.every(body => body.query === "keep"), "all pages retain native trimmed query");
                assert.equal((await search("keepKeyword", options)).matches.length, 201);
                mount("other");
                assert.equal((await settle("keepKeyword", options)).matches.length, 201);
                assert.ok(requests.slice(-2).every(body => body.query === "other"));
                mount("");
                assert.equal((await settle("filteredSecret", options)).matches.length, 1, "clearing query restores unfiltered cache");
                assert.equal(renderCalls, 0);
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log("ordinary/embedded native AV search query pagination, cache isolation and clear/change OK");
        const avPage = (values) => ({
            code: 0,
            data: {
                view: {
                    type: "table",
                    rowCount: values.length,
                    columns: [{id: "col", name: "column", type: "text"}],
                    rows: values.map((value, index) => ({
                        id: "row" + index,
                        cells: [{keyID: "col", value: {type: "text", text: {content: value}}}],
                    })),
                },
            },
        });
        // The native render response includes hidden values; only its field metadata
        // determines what the selected view actually displays, even before mounting.
        for (const embedded of [false, true]) {
            for (const layout of ["table", "list", "gallery", "kanban", "calendar"]) {
                for (const foldedParent of ["none", "heading", "list", "callout"]) {
                    reset();
                    const parent = ["list", "callout"].includes(foldedParent) ? "container" : "r";
                    if (foldedParent === "heading") add("a", "h", "title", "h1", "r", 'fold="1"');
                    if (parent !== "r") {
                        add("container", foldedParent === "list" ? "l" : "callout", "", "u", "r", 'fold="1"');
                    }
                    const shell = avShell().replace('data-node-id="source-av"', 'data-node-id="b"')
                        .replace('data-av-type="table"', 'data-av-type="' + layout + '"');
                    add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell, "", parent);
                    doms.b = embedded ? embedShell("b") : shell;
                    if (embedded) {
                        embedResponder = async () => ({
                            code: 0,
                            data: {blocks: [{block: {id: "source-av", content: avShell()}}]},
                        });
                    }
                    const columns = [
                        {id: "primary", type: "block", name: "", hidden: false},
                        {id: "visible", type: "text", name: "", hidden: false},
                        {id: "hidden", type: "text", name: "", hidden: true},
                    ];
                    const cells = columns.map(column => ({
                        keyID: column.id,
                        value: {keyID: column.id, type: "text", text: {content: column.id + "Keyword"}},
                    }));
                    const cards = ["gallery", "kanban"].includes(layout);
                    const page = {
                        type: layout,
                        [cards ? "fields" : "columns"]: columns,
                        [cards ? "cardCount" : "rowCount"]: 1,
                        [cards ? "cards" : "rows"]: [{id: "row0", [cards ? "values" : "cells"]: cells}],
                    };
                    let reads = 0;
                    avResponder = async url => {
                        reads++;
                        return {code: 0, data: url.endsWith("getAttributeView") ? avRaw : {view: page}};
                    };
                    corpus.retainBackgroundCorpusRoot("r");
                    try {
                        const cold = await settle("Keyword", {includeAttributeView: true});
                        full(cold);
                        assert.equal(cold.matches.length, 2, embedded + "/" + layout + "/" + foldedParent);
                        assert.equal((await search("hiddenKeyword", {includeAttributeView: true})).matches.length, 0);
                        const beforeMount = reads;
                        const live = (embedded ? avShell() : shell).replace(
                            "<div></div>",
                            '<div class="av__row" data-id="row0">' + ["primary", "visible"].map(id =>
                                '<div class="av__cell" data-col-id="' + id + '">' + id + "Keyword</div>"
                            ).join("") + "</div>",
                        );
                        wysiwyg.innerHTML = embedded ?
                            '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + live + "</div>" :
                            live;
                        const hot = await search("Keyword", {includeAttributeView: true});
                        full(hot);
                        assert.equal(hot.matches.length, 2, "mounted visible fields agree with cold values");
                        wysiwyg.innerHTML = "";
                        const unmounted = await search("Keyword", {includeAttributeView: true});
                        full(unmounted);
                        assert.equal(unmounted.matches.length, 2);
                        assert.equal(
                            reads,
                            beforeMount,
                            "mount transitions reuse filtered values without more requests",
                        );
                        assert.equal(renderCalls, 0);
                        if (layout === "table" && foldedParent === "none") {
                            columns[2].hidden = false;
                            corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                            const revealed = await settle("hiddenKeyword", {includeAttributeView: true});
                            full(revealed);
                            assert.equal(
                                revealed.matches.length,
                                1,
                                "field visibility changes invalidate cached filtering",
                            );
                            columns[2].hidden = true;
                            corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                            const hiddenAgain = await settle("hiddenKeyword", {includeAttributeView: true});
                            full(hiddenAgain);
                            assert.equal(hiddenAgain.matches.length, 0);
                        }
                    } finally {
                        avModule.releaseAvCacheOwner("r", edit);
                        corpus.releaseBackgroundCorpusRoot("r");
                    }
                }
            }
        }
        console.log("ordinary/embedded AV hidden fields: all layouts, cold/folded/mounted transitions OK");

        // SiYuan returns hidden groups and a database name even when the selected
        // view does not paint them. Ordinary and embedded carriers share these rules.
        for (const embedded of [false, true]) {
            for (const foldedParent of ["none", "heading", "list", "callout"]) {
                reset();
                const parent = ["list", "callout"].includes(foldedParent) ? "container" : "r";
                if (foldedParent === "heading") add("a", "h", "title", "h1", "r", 'fold="1"');
                if (parent !== "r") {
                    add("container", foldedParent === "list" ? "l" : "callout", "", "u", "r", 'fold="1"');
                }
                const shell = embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"');
                add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell, "", parent);
                doms.b = embedded ? embedShell("b") : shell;
                if (embedded) {
                    embedResponder = async () => ({
                        code: 0,
                        data: {blocks: [{block: {id: "source-av", content: shell}}]},
                    });
                }
                const page = {
                    type: "table",
                    hideAttrViewName: true,
                    columns: [{id: "col", hidden: false}],
                    groups: [
                        ...["visible", "folded", "hidden"].map(id => ({
                            id,
                            groupHidden: id === "hidden" ? 2 : 0,
                            groupFolded: id === "folded",
                            rowCount: 1,
                            columns: null,
                            rows: [{id: "row0", cells: [{value: {keyID: "col", text: {content: id + "Keyword"}}}]}],
                        })),
                        {id: "empty-hidden", groupHidden: 1, rowCount: 0, rows: []},
                    ],
                };
                let reads = 0;
                avResponder = async url => {
                    reads++;
                    return {
                        code: 0,
                        data: url.endsWith("getAttributeView") ? {...avRaw, name: "titleKeyword"} : {view: page},
                    };
                };
                corpus.retainBackgroundCorpusRoot("r");
                try {
                    const coldTitle = await settle("titleKeyword", {includeAttributeView: true});
                    full(coldTitle);
                    assert.equal(
                        coldTitle.matches.length,
                        0,
                        "hidden title must not match: " + embedded + "/" + foldedParent,
                    );
                    const cold = await search("Keyword", {includeAttributeView: true});
                    full(cold);
                    assert.deepEqual(cold.matches.map(match => match.matchedText), ["Keyword", "Keyword"]);
                    assert.equal((await search("hiddenKeyword", {includeAttributeView: true})).matches.length, 0);
                    assert.equal((await search("foldedKeyword", {includeAttributeView: true})).matches.length, 1);
                    const beforeMount = reads;
                    const live = shell.replace(
                        "<div></div>",
                        '<div class="av__title fn__none">titleKeyword</div>' +
                            '<div class="av__body" data-group-id="visible"><div class="av__row" data-id="row0">' +
                            '<div class="av__cell" data-col-id="col">visibleKeyword</div></div></div>' +
                            '<div class="av__body fn__none" data-group-id="folded"></div>',
                    );
                    wysiwyg.innerHTML = embedded ?
                        '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + live + "</div>" :
                        live;
                    const hot = await search("Keyword", {includeAttributeView: true});
                    full(hot);
                    assert.equal(hot.matches.length, 2, "native mounted view agrees with cold visibility");
                    assert.equal(
                        hot.matches.filter(match => match.range).length,
                        1,
                        "only unfolded group binds a live Range",
                    );
                    wysiwyg.innerHTML = "";
                    assert.equal((await search("Keyword", {includeAttributeView: true})).matches.length, 2);
                    assert.equal(reads, beforeMount, "mount/unmount adds no API requests");
                    assert.equal(renderCalls, 0, "database visibility requires no offscreen rendering");
                    page.hideAttrViewName = false;
                    page.groups[2].groupHidden = 0;
                    corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                    const revealed = await settle("Keyword", {includeAttributeView: true});
                    full(revealed);
                    assert.equal(revealed.matches.length, 4, "visibility changes refresh title and group filtering");
                    page.hideAttrViewName = true;
                    page.groups[2].groupHidden = 2;
                    corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                    const hiddenAgain = await settle("Keyword", {includeAttributeView: true});
                    full(hiddenAgain);
                    assert.equal(hiddenAgain.matches.length, 2);
                } finally {
                    avModule.releaseAvCacheOwner("r", edit);
                    corpus.releaseBackgroundCorpusRoot("r");
                }
            }
        }
        console.log("ordinary/embedded AV hidden groups/title: cold, folded, mounted, cache transitions and ranges OK");

        // Native folded galleries retain card DOM, while later cards are paged
        // through the API. The same row in two groups remains two instances.
        const galleryRects = Element.prototype.getClientRects;
        Element.prototype.getClientRects = function() {
            return this.closest('.av__body.fn__none') ? [] : galleryRects.call(this);
        };
        for (const embedded of [false, true]) {
            reset();
            const shell = (embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"'))
                .replace('data-av-type="table"', 'data-av-type="gallery"');
            add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
            doms.b = embedded ? embedShell("b") : shell;
            if (embedded) embedResponder = async () => ({
                code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]},
            });
            let reads = 0;
            avResponder = async (url, data) => {
                reads++;
                if (url.endsWith("getAttributeView")) return {code: 0, data: avRaw};
                const page = data.groupPaging.folded?.page ?? 1;
                return {code: 0, data: {view: {
                    type: "gallery",
                    columns: [{id: "col"}, {id: "secret", hidden: true}],
                    groups: ["folded", "visible", "hidden"].map(id => ({
                        id, name: id + "NameKeyword", groupValue: {type: "text"},
                        groupHidden: id === "hidden" ? 2 : 0, groupFolded: id === "folded",
                        cardCount: id === "folded" ? 201 : 1,
                        cards: Array.from({length: id === "folded" ? (page === 1 ? 200 : 1) : 1}, (_, index) => ({
                            id: "row" + (id === "folded" ? (page - 1) * 200 + index : 0),
                            values: [
                                {keyID: "col", type: "text", text: {content: "galleryKeyword"}},
                                {keyID: "secret", type: "text", text: {content: "secretKeyword"}},
                            ],
                        })),
                    })),
                }}};
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const options = {includeAttributeView: true, includeFoldedBlocks: true};
                const cold = await settle("galleryKeyword", options);
                full(cold);
                assert.equal(cold.matches.length, 202, "all pages of visible and folded groups are searched");
                const withoutDocumentFolds = {...options, includeFoldedBlocks: false};
                assert.equal((await search("galleryKeyword", withoutDocumentFolds)).matches.length, 202,
                    "database group folding is independent of the document fold switch");
                assert.equal((await search("secretKeyword", options)).matches.length, 0);
                assert.equal((await search("NameKeyword", options)).matches.length, 2, "cold visible group names are searchable");
                const beforeMount = reads;
                const groupHTML = (id, folded) =>
                    '<div class="av__group-title"><button data-type="av-group-fold" data-id="' + id +
                    '"><svg class="' + (folded ? "" : "av__group-arrow--open") + '"></svg></button>' +
                    '<span class="av__group-name">' + id + 'NameKeyword</span><span class="av__group-counter">1</span></div>' +
                    '<div class="av__body' + (folded ? " fn__none" : "") + '" data-group-id="' + id + '">' +
                    '<div class="av__gallery-item" data-id="row0"><div class="av__cell" data-field-id="col">' +
                    'galleryKeyword<span class="fn__none">uiKeyword</span><span style="display:none">cssKeyword</span>' +
                    '</div></div></div>';
                wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                    shell.replace("<div></div>", groupHTML("folded", true) + groupHTML("visible", false)) +
                    (embedded ? "</div>" : "");
                const collect = () => source("frontend/blocks").collectSearchableBlocks(edit, options);
                const projection = source("frontend/corpus/project");
                const mounted = await search("galleryKeyword", options);
                full(mounted);
                assert.equal(mounted.matches.length, 202, "folded mounted cards must not erase API matches");
                assert.equal(mounted.matches.filter(match => match.range).length, 1);
                const mountedWithoutDocumentFolds = await search("galleryKeyword", withoutDocumentFolds);
                full(mountedWithoutDocumentFolds);
                assert.equal(mountedWithoutDocumentFolds.matches.length, 202,
                    "disabling document folds must not silently discard mounted folded cards");
                assert.equal(mountedWithoutDocumentFolds.matches.filter(match => match.range).length, 1);
                const ordered = await search("NameKeyword|galleryKeyword", {...options, regex: true});
                assert.equal(ordered.matches.length, 204, "mounted names and cells do not duplicate API results");
                assert.ok(ordered.matches[0].unitId.endsWith("group-title:folded"));
                assert.ok(ordered.matches[202].unitId.endsWith("group-title:visible"), "folded rows precede the next group title");
                assert.equal((await search("NameKeyword", options)).matches.filter(match => match.range).length, 2);
                assert.equal((await search("uiKeyword|cssKeyword", {...options, regex: true})).matches.length, 0);
                const foldedBody = wysiwyg.querySelector('.av__body[data-group-id="folded"]');
                foldedBody.classList.remove("fn__none");
                const rebound = projection.fillLiveRanges(cold.matches, collect(), true);
                assert.equal(rebound.filter(match => match.range).length, 2, "ordinary and embedded cold IDs bind after unfolding");
                assert.equal(rebound[0].range.toString(), "galleryKeyword");
                assert.equal(rebound[0].range.startContainer.parentElement.closest("[data-group-id]").dataset.groupId, "folded");
                assert.equal(rebound[201].range.startContainer.parentElement.closest("[data-group-id]").dataset.groupId, "visible");
                assert.equal((await search("galleryKeyword", options)).matches.length, 202);
                foldedBody.classList.add("fn__none");
                const refolded = projection.rebindChangedRanges(rebound, collect(),
                    new Map(rebound.map(match => [match, {broken: true, blockShown: true}])),
                    {allowFoldedHidden: true});
                assert.equal(refolded.matches[0].range, undefined, "refolding releases invisible Ranges");
                assert.equal(refolded.matches.length, 202);
                assert.equal((await search("galleryKeyword", options)).matches.length, 202);
                const cell = foldedBody.querySelector(".av__cell");
                cell.textContent = "localKeyword";
                assert.equal((await search("galleryKeyword", options)).matches.length, 201, "folded pending edits win over API");
                assert.equal((await search("localKeyword", options)).matches.length, 1);
                assert.equal((await search("galleryKeyword", withoutDocumentFolds)).matches.length, 201);
                assert.equal((await search("localKeyword", withoutDocumentFolds)).matches.length, 1,
                    "folded live pending edits remain authoritative with the document fold switch off");
                cell.textContent = "";
                assert.equal((await search("galleryKeyword", options)).matches.length, 201, "empty folded cells keep coverage");
                assert.equal((await search("galleryKeyword", withoutDocumentFolds)).matches.length, 201);
                wysiwyg.innerHTML = "";
                assert.equal((await search("galleryKeyword", options)).matches.length, 202);
                assert.equal((await search("galleryKeyword", withoutDocumentFolds)).matches.length, 202);
                assert.equal(reads, beforeMount, "mount, fold, edit and unmount reuse current-view cache");
                assert.equal(renderCalls, 0, "complete gallery search never renders offscreen cards");
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log("ordinary/embedded folded gallery: full pagination, stable counts, aliases, hidden text and local edits OK");
        Element.prototype.getClientRects = galleryRects;

        for (const embedded of [false, true]) {
            for (const layout of ["table", "list"]) {
                reset();
                const shell = (embedded ? avShell() : avShell().replace('data-node-id="source-av"', 'data-node-id="b"'))
                    .replace('data-av-type="table"', 'data-av-type="' + layout + '"');
                add("b", embedded ? "query_embed" : "av", embedded ? "select * from blocks" : shell);
                doms.b = embedded ? embedShell("b") : shell;
                if (embedded) embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
                let checkboxGroups = false;
                avResponder = async url => ({code: 0, data: url.endsWith("getAttributeView") ? avRaw : {view: {
                    type: layout, columns: [{id: "col"}, {id: "secret", hidden: true}],
                    groups: ["g1", "g2"].map(id => ({
                        id, name: id + "Keyword", groupValue: {type: checkboxGroups ? "checkbox" : "text"}, groupHidden: 0, groupFolded: true,
                        rowCount: 1, rows: [{id: "row", cells: [
                            {value: {keyID: "col", text: {content: id + "Keyword"}}},
                            {value: {keyID: "secret", text: {content: "secretKeyword"}}},
                        ]}],
                    })),
                }}});
                corpus.retainBackgroundCorpusRoot("r");
                try {
                    const options = {includeAttributeView: true, includeFoldedBlocks: true};
                    const cold = await settle("Keyword", options);
                    assert.equal(cold.matches.length, 4);
                    const groupHTML = id => '<div class="av__group-title"><button data-type="av-group-fold" data-id="' + id +
                        '"><svg></svg></button><span class="av__group-name">' + id + 'Keyword</span></div>' +
                        '<div class="av__body fn__none" data-group-id="' + id + '"></div>';
                    wysiwyg.innerHTML = (embedded ? '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' : "") +
                        shell.replace("<div></div>", groupHTML("g1") + groupHTML("g2")) + (embedded ? "</div>" : "");
                    const folded = await search("Keyword", options);
                    full(folded);
                    assert.equal(folded.matches.length, 4, layout + " empty folded bodies retain all visible-field rows");
                    assert.deepEqual(folded.matches.map(match => match.unitId.replace(/^embed:[^:]+:/, "")), [
                        "group-title:g1", "av-group:g1:row:col", "group-title:g2", "av-group:g2:row:col",
                    ], "a group title is immediately followed by its own entries");
                    assert.equal(folded.matches.filter(match => match.range).length, 2);
                    assert.equal((await search("secretKeyword", options)).matches.length, 0);
                    checkboxGroups = true;
                    wysiwyg.querySelectorAll(".av__group-name").forEach(name => name.replaceChildren());
                    wysiwyg.querySelectorAll(".av__group-title").forEach(title =>
                        title.insertAdjacentHTML("beforeend", '<span class="av__group-counter">1</span>')
                    );
                    corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                    const checkbox = await settle("^1$|Keyword", {...options, regex: true});
                    full(checkbox);
                    assert.deepEqual(checkbox.matches.map(match => match.unitId.replace(/^embed:[^:]+:/, "")), [
                        "group-counter:g1", "av-group:g1:row:col", "group-counter:g2", "av-group:g2:row:col",
                    ], "icon-only group titles/counters anchor their own unloaded entries");
                    const secondBody = wysiwyg.querySelector('.av__body[data-group-id="g2"]');
                    secondBody.classList.remove("fn__none");
                    secondBody.innerHTML = '<div class="av__row" data-id="row"><div class="av__cell" data-col-id="col">g2Keyword</div></div>';
                    const mixed = await search("^1$|Keyword", {...options, regex: true});
                    full(mixed);
                    assert.deepEqual(mixed.matches.map(match => match.unitId.replace(/^embed:[^:]+:/, "")), [
                        "group-counter:g1", "av-group:g1:row:col", "group-counter:g2", "cell:g2:row:col",
                    ], "a folded icon-only group's entries precede the next mounted group title");
                } finally {
                    avModule.releaseAvCacheOwner("r", edit);
                    corpus.releaseBackgroundCorpusRoot("r");
                }
            }
        }
        console.log("ordinary/embedded folded table/list: group names, empty bodies, visibility and navigation order OK");

        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = embedShell("b");
        embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: avShell()}}]}});
        avResponder = async url => ({
            code: 0,
            data: url.endsWith("getAttributeView") ? avRaw : {
                view: {
                    type: "table",
                    columns: [{id: "col", hidden: false}, {id: "hidden", hidden: true}],
                    groups: ["g1", "g2"].map(id => ({
                        id,
                        columns: null, // Kernel omits redundant per-group field metadata.
                        rowCount: 1,
                        rows: [{
                            id: "row0",
                            cells: [
                                {value: {keyID: "col", text: {content: "groupKeyword"}}},
                                {value: {keyID: "hidden", text: {content: "hiddenKeyword"}}},
                            ],
                        }],
                    })),
                },
            },
        });
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const cold = await settle("groupKeyword", {includeAttributeView: true});
            full(cold);
            assert.deepEqual(cold.matches.map(match => match.unitId), [
                "embed:source-av:av-group:g1:row0:col",
                "embed:source-av:av-group:g2:row0:col",
            ], "same source row displayed in two groups has two search instances");
            assert.equal((await search("hiddenKeyword", {includeAttributeView: true})).matches.length, 0);
            const groupHTML = id =>
                '<div class="av__body" data-group-id="' + id + '"><div class="av__row" data-id="row0">' +
                '<div class="av__cell" data-col-id="col">groupKeyword</div></div></div>';
            const mount = ids => {
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                    avShell().replace("<div></div>", ids.map(groupHTML).join("")) + "</div>";
                return source("frontend/blocks").collectSearchableBlocks(edit, {includeAttributeView: true});
            };
            const allLive = mount(["g1", "g2"]);
            const hot = await search("groupKeyword", {includeAttributeView: true});
            full(hot);
            assert.equal(hot.matches.length, 2);
            assert.ok(hot.matches.every(match => match.range));
            const rebound = source("frontend/corpus/project").fillLiveRanges(cold.matches, allLive, true);
            assert.deepEqual(
                rebound.map(match =>
                    match.range?.startContainer.parentElement.closest("[data-group-id]").dataset.groupId
                ),
                ["g1", "g2"],
                "each cold group binds to its own mounted instance",
            );
            const state = new (source("frontend/embed-search-state").EmbedSearchState)();
            state.capture(allLive);
            for (const remaining of ["g1", "g2"]) {
                mount([remaining]);
                const partialMount = await search("groupKeyword", {includeAttributeView: true});
                full(partialMount);
                assert.equal(partialMount.matches.length, 2, "unmounted group is supplemented independently");
                assert.equal(partialMount.matches.filter(match => match.range).length, 1);
                assert.equal(partialMount.matches[0].unitId.includes("g1"), true, "group order remains stable");
                const owner = wysiwyg.firstElementChild;
                assert.equal(
                    state.changed(edit, new Set([owner]), {includeAttributeView: true}, new Set([owner])),
                    false,
                );
                const cell = owner.querySelector(".av__cell");
                cell.textContent = "localKeyword";
                const edited = await search("groupKeyword", {includeAttributeView: true});
                assert.equal(edited.matches.length, 1, "local edit suppresses only its own group API instance");
                assert.equal((await search("localKeyword", {includeAttributeView: true})).matches.length, 1);
                state.capture(mount(["g1", "g2"]));
            }
            wysiwyg.innerHTML = "";
            assert.equal((await search("groupKeyword", {includeAttributeView: true})).matches.length, 2);
        } finally {
            avModule.releaseAvCacheOwner("r", edit);
            corpus.releaseBackgroundCorpusRoot("r");
        }
        console.log("embedded AV group identity, visibility, order, range repair and virtual mounting OK");
        for (const foldedParent of ["none", "heading", "list", "callout"]) {
            reset();
            const parent = foldedParent === "list" || foldedParent === "callout" ? "container" : "r";
            if (foldedParent === "heading") add("a", "h", "title", "h1", "r", 'fold="1"');
            if (parent !== "r") {
                add("container", foldedParent === "list" ? "l" : "callout", "", "u", "r", 'fold="1"');
            }
            add("b", "query_embed", "select * from blocks", "", parent);
            doms.b = embedShell("b");
            const body = '<div data-node-id="before" data-type="NodeParagraph">beforeKeyword</div>' + avShell() +
                '<div data-node-id="after" data-type="NodeParagraph">afterKeyword</div>';
            embedResponder = async () => ({
                code: 0,
                data: {
                    blocks: [{
                        block: {
                            id: "source-container",
                            rootID: "source-root",
                            content: body,
                        },
                    }],
                },
            });
            let value = "embeddedKeyword";
            let avReads = 0;
            avResponder = async (url, request) => {
                avReads++;
                if (url === "/api/av/getAttributeView") return {code: 0, data: avRaw};
                assert.equal(request.blockID, "source-av", "AV API uses the source carrier, not its embed host");
                assert.equal(request.viewID, "v");
                assert.equal(request.createIfNotExist, false);
                return avPage([value, value]);
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                // Switching from AV-disabled cache must still discover the carrier.
                full(await search("embeddedKeyword", {includeAttributeView: false}));
                assert.equal(avReads, 0);
                const initial = await search("embeddedKeyword", {includeAttributeView: true});
                assert.equal(initial.partial, true, "unloaded AV values cannot report complete coverage");
                const cold = await settle("Keyword", {includeAttributeView: true});
                full(cold);
                assert.deepEqual(cold.matches.map(match => match.matchedText), [
                    "Keyword",
                    "Keyword",
                    "Keyword",
                    "Keyword",
                ]);
                assert.deepEqual(cold.matches.map(match => match.unitId.includes("source-av")), [
                    false,
                    true,
                    true,
                    false,
                ]);
                assert.ok(cold.matches.every(match => match.blockId === "b" && !match.replaceable && !match.range));
                const reads = avReads;
                full(await search("absent", {includeAttributeView: true}));
                assert.equal(avReads, reads, "keyword changes reuse the AV cache");
                assert.equal(renderCalls, 0, "embedded AV never invokes an offscreen renderer");
                assert.equal(
                    avModule.rootUsesAttributeViews("r", ["av-id"]),
                    true,
                    "cold carrier receives AV transactions",
                );
                value = "changedKeyword";
                corpus.invalidateAttributeViewSearch("r", ["av-id"]);
                const changed = await settle("changedKeyword", {includeAttributeView: true});
                full(changed);
                assert.equal(changed.matches.length, 2);
                const metadataCold = await search("database|table", {includeAttributeView: true, regex: true});
                assert.equal(metadataCold.matches.length, 2);
                assert.equal((await search("embeddedKeyword", {includeAttributeView: true})).matches.length, 0);
                assert.equal(
                    embedRequests.length,
                    2,
                    "AV transactions refresh values without re-running native embed SQL",
                );
                full(await search("changedKeyword", {includeAttributeView: false}));
                assert.equal((await search("changedKeyword", {includeAttributeView: false})).matches.length, 0);
                if (foldedParent !== "none") {
                    assert.equal(
                        (await search("changedKeyword", {
                            includeAttributeView: true,
                            includeFoldedBlocks: false,
                        })).matches.length,
                        0,
                    );
                }
                const beforeRestriction = avReads;
                const restricted = await search("changedKeyword", {
                    includeAttributeView: true,
                    includeInlineMemo: true,
                    restrictInlineTypes: ["inline-memo"],
                });
                full(restricted);
                assert.equal(restricted.matches.length, 0);
                assert.equal(avReads, beforeRestriction, "memo-only search cannot load embedded AV values");
                // Healthy text and recovered renderers must share the AV shell's rank frame.
                const pendingGraph =
                    '<div data-node-id="graph" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="graph"><div></div></div>';
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                    '<div data-node-id="before" data-type="NodeParagraph">beforeKeyword</div>' + avShell() +
                    pendingGraph + '<div data-node-id="after" data-type="NodeParagraph">afterKeyword</div></div>';
                window.Protyle.graphvizRender = host =>
                    host.querySelectorAll('[data-subtype="graphviz"]').forEach(graph => {
                        graph.innerHTML = "<svg><text>graphKeyword</text></svg>";
                    });
                const mixed = await settle("Keyword", {includeAttributeView: true});
                full(mixed);
                assert.deepEqual(
                    mixed.matches.map(match =>
                        match.unitId.includes("source-av") ?
                            "av" :
                            match.unitId.includes("graph") ?
                            "graph" :
                            match.unitId.includes("before") ?
                            "before" :
                            "after"
                    ),
                    ["before", "av", "av", "graph", "after"],
                );
                assert.deepEqual(
                    (await search("Keyword", {includeAttributeView: true})).matches.map(match => match.unitId),
                    mixed.matches.map(match => match.unitId),
                    "cached renderer and AV shell retain shared order",
                );
                const live = avShell().replace(
                    "<div></div>",
                    '<div class="av__row" data-id="row0"><div class="av__cell" data-col-id="col">changedKeyword</div></div>' +
                        '<div class="av__row" data-id="row1"><div class="av__cell" data-col-id="col">changedKeyword</div></div>',
                );
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + body + "</div>";
                const pendingMounted = await settle("changedKeyword", {includeAttributeView: true});
                full(pendingMounted);
                assert.equal(
                    pendingMounted.matches.length,
                    2,
                    "mounted AV shell beside healthy text still loads values",
                );
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + live + "</div>";
                const mounted = await search("changedKeyword", {includeAttributeView: true});
                full(mounted);
                assert.equal(mounted.matches.length, 2, "mounted and cold cell counts agree");
                assert.ok(mounted.matches.every(match => match.range && match.blockId === "b" && !match.replaceable));
                const liveUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeAttributeView: true});
                const projection = source("frontend/corpus/project");
                const rebound = projection.fillLiveRanges(changed.matches, liveUnits, true);
                assert.ok(rebound.every(match => match.range), "cold API cells rebind to mounted DOM identities");
                const avElement = wysiwyg.querySelector('[data-type="NodeAttributeView"]');
                avElement.setAttribute("custom-sy-av-view", "v2");
                assert.ok(
                    projection.fillLiveRanges(changed.matches, liveUnits, true).every(match => !match.range),
                    "cold view cannot bind to the same row/column in a different view",
                );
                assert.ok(
                    projection.fillLiveRanges(
                        mounted.matches.map(match => ({...match, range: undefined})),
                        liveUnits,
                        true,
                    )
                        .every(match => !match.range),
                    "hot unit IDs must also verify their original view",
                );
                avElement.setAttribute("custom-sy-av-view", "v");
                avElement.insertAdjacentHTML(
                    "afterbegin",
                    '<div class="av__title">database</div><div class="av__views"><div class="layout-tab-bar">' +
                        '<div class="item" data-id="v"><span class="item__text">table</span></div></div></div>',
                );
                assert.ok(
                    projection.fillLiveRanges(
                        metadataCold.matches,
                        source("frontend/blocks").collectSearchableBlocks(edit),
                        true,
                    ).every(match => match.range),
                    "cold database title and view names rebind independently of cells",
                );
                assert.ok(
                    projection.projectLiveRanges(edit, changed.matches, liveUnits, true).every(match => match.range),
                );
                const repaired = projection.rebindChangedRanges(
                    changed.matches,
                    liveUnits,
                    new Map(changed.matches.map(match => [match, {broken: false, blockShown: true}])),
                    {allowFoldedHidden: true},
                );
                assert.ok(repaired.matches.every(match => match.range), "observer repair uses the same safe aliases");
                assert.equal(
                    source("frontend/match-anchor").resolveRetainedMatchIndex(mounted.matches, changed.matches[1], 1, {
                        previousMatches: changed.matches,
                    }),
                    2,
                    "cold-to-live identity retains the second row",
                );
                const wrongCopy = liveUnits.map(block => ({
                    ...block,
                    unitId: block.unitId.replace("source-av:", "source-av@1:"),
                }));
                assert.ok(projection.fillLiveRanges(changed.matches, wrongCopy, true).every(match => !match.range));
                const groupedCopies = ["g1", "g2"].flatMap(group =>
                    liveUnits.map(block => ({
                        ...block,
                        unitId: block.unitId.replace("cell:nogroup:", "cell:" + group + ":"),
                    }))
                );
                assert.ok(
                    projection.fillLiveRanges(changed.matches, groupedCopies, true).every(match => !match.range),
                    "ambiguous group copies cannot borrow another cell's Range",
                );
                assert.ok(
                    projection.fillLiveRanges(
                        changed.matches,
                        liveUnits.map(block => ({...block, unitId: block.unitId + "#run-0"})),
                        true,
                    )
                        .every(match => !match.range),
                    "split text runs cannot reuse whole-cell offsets",
                );
                for (const mountedPart of ["title", "header", "row0", "row1", "hidden", "empty", "unsaved"]) {
                    const content = mountedPart === "title" ?
                        '<div class="av__title">database</div>' :
                        mountedPart === "header" ?
                        '<div class="av__row av__row--header"><div class="av__cell av__cell--header" data-col-id="col">column</div></div>' :
                        '<div class="av__row" data-id="' + (mountedPart === "row1" ? "row1" : "row0") +
                        '"><div class="av__cell" data-col-id="col"' +
                        (mountedPart === "hidden" ? ' style="display:none"' : "") + ">" +
                        (mountedPart === "empty" ? "" : mountedPart === "unsaved" ? "localKeyword" : "changedKeyword") +
                        "</div></div>";
                    wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                        avShell().replace("<div></div>", content) + "</div>";
                    const partialMounted = await search("changedKeyword", {includeAttributeView: true});
                    full(partialMounted);
                    assert.equal(
                        partialMounted.matches.length,
                        ["title", "header", "row0", "row1"].includes(mountedPart) ? 2 : 1,
                        mountedPart + " supplements only unmounted cells",
                    );
                    if (mountedPart === "row0" || mountedPart === "row1") {
                        assert.equal(partialMounted.matches.filter(match => match.range).length, 1);
                        assert.equal(
                            partialMounted.matches[0].unitId.includes("row0"),
                            true,
                            "API row order is preserved",
                        );
                    }
                    if (mountedPart === "unsaved") {
                        assert.equal((await search("localKeyword", {includeAttributeView: true})).matches.length, 1);
                    }
                }
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        for (const viewIdentity of ["default", "stale", "unnamed"]) {
            reset();
            add("b", "query_embed", "select * from blocks");
            doms.b = embedShell("b");
            const shell = viewIdentity === "default" ?
                avShell().replace('custom-sy-av-view="v"', "") :
                avShell(viewIdentity === "stale" ? "deleted-view" : "v");
            embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: shell}}]}});
            avResponder = async url =>
                url === "/api/av/getAttributeView" ?
                    {
                        code: 0,
                        data: {name: "database", views: [{id: "v", name: viewIdentity === "unnamed" ? "" : "table"}]},
                    } :
                    avPage(["viewKeyword"]);
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const cold = await settle("viewKeyword", {includeAttributeView: true});
                full(cold);
                assert.equal(cold.matches[0].embeddedAvViewId, "v", "actual resolved view survives " + viewIdentity);
                const live = avShell("v2").replace(
                    "<div></div>",
                    '<div class="av__row" data-id="row0"><div class="av__cell" data-col-id="col">viewKeyword</div></div>',
                );
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + live + "</div>";
                const units = source("frontend/blocks").collectSearchableBlocks(edit);
                assert.ok(
                    source("frontend/corpus/project").fillLiveRanges(cold.matches, units, true).every(match =>
                        !match.range
                    ),
                );
                wysiwyg.querySelector('[data-type="NodeAttributeView"]').setAttribute("custom-sy-av-view", "v");
                assert.ok(
                    source("frontend/corpus/project").fillLiveRanges(cold.matches, units, true).every(match =>
                        match.range
                    ),
                );
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        for (const differentViews of [false, true]) {
            reset();
            add("a", "query_embed", "select * from blocks");
            add("b", "query_embed", "select * from blocks");
            doms.a = embedShell("a");
            doms.b = embedShell("b");
            embedResponder = async request => ({
                code: 0,
                data: {
                    blocks: [
                        {
                            block: {
                                id: "source-av",
                                content: avShell(),
                            },
                        },
                        ...(request.embedBlockID === "b" ?
                            [{
                                block: {
                                    id: "source-av",
                                    content: avShell(differentViews ? "v2" : "v"),
                                },
                            }] :
                            []),
                    ],
                },
            });
            let renderReads = 0;
            avResponder = async (url, request) => {
                if (url === "/api/av/getAttributeView") return {code: 0, data: avRaw};
                renderReads++;
                return avPage([request.viewID === "v2" ? "otherKeyword" : "sharedKeyword"]);
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const copies = await settle("Keyword", {includeAttributeView: true});
                full(copies);
                assert.equal(copies.matches.length, 3, "same source retains all three displayed copies");
                assert.deepEqual(copies.matches.map(match => match.blockId), ["a", "b", "b"]);
                assert.equal(new Set(copies.matches.map(match => match.blockId + ":" + match.unitId)).size, 3);
                assert.equal(renderReads, differentViews ? 2 : 1, "only identical carrier views share pagination");
                assert.equal(
                    (await search("sharedKeyword", {includeAttributeView: true})).matches.length,
                    differentViews ? 2 : 3,
                );
                assert.equal(
                    (await search("otherKeyword", {includeAttributeView: true})).matches.length,
                    differentViews ? 1 : 0,
                );
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        for (const failure of ["api", "page", "truncated", "hidden", "disabled-container", "missing-id"]) {
            reset();
            add("b", "query_embed", "select * from blocks");
            doms.b = embedShell("b");
            let carrier = avShell();
            if (failure === "hidden") carrier = carrier.replace('data-av-type="table"', 'style="display:none"');
            if (failure === "missing-id") carrier = carrier.replace('data-av-id="av-id"', "");
            if (failure === "disabled-container") {
                carrier = '<div data-node-id="list" data-type="NodeList" data-subtype="u">' + carrier + "</div>";
            }
            embedResponder = async () => ({code: 0, data: {blocks: [{block: {id: "source-av", content: carrier}}]}});
            let avReads = 0;
            avResponder = async (url, request) => {
                avReads++;
                if (failure === "api") return {code: -1};
                if (url === "/api/av/getAttributeView") return {code: 0, data: avRaw};
                if (failure === "truncated") {
                    return {
                        code: 0,
                        data: {
                            view: {
                                type: "table",
                                rowCount: 100001,
                                rows: Array.from({length: request.pageSize}, (_item, index) => ({
                                    id: "row-" + request.page + "-" + index,
                                    cells: [],
                                })),
                            },
                        },
                    };
                }
                return {code: 0, data: {view: {type: "table", rowCount: 2, rows: []}}};
            };
            corpus.retainBackgroundCorpusRoot("r");
            try {
                const options = {includeAttributeView: true, includeListUnordered: failure !== "disabled-container"};
                const result = await settle("Keyword", options);
                assert.equal(result.matches.length, 0);
                assert.equal(result.unrendered, ["api", "page", "truncated", "missing-id"].includes(failure) ? 1 : 0);
                assert.equal(result.truncated, failure === "truncated" ? 1 : 0);
                if (["api", "page", "truncated"].includes(failure)) {
                    assert.deepEqual(result.incompleteBlockIds, ["b"], "failure coverage belongs to the embed host");
                    const before = avReads;
                    await search("otherKeyword", options);
                    assert.equal(avReads, before, "embedded AV failures use the existing finite backoff");
                } else {
                    assert.equal(avReads, 0, "filtered/malformed carriers cannot issue AV requests");
                }
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            } finally {
                avModule.releaseAvCacheOwner("r", edit);
                corpus.releaseBackgroundCorpusRoot("r");
            }
        }
        console.log(
            "embedded AV cold/folded/live counts, view/copy isolation, cache/transaction/gates/failure coverage OK",
        );
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = embedShell("b");
        const manyCarriers = Array.from(
            {length: 40},
            (_item, index) =>
                avShell().replace("source-av", "source-av-" + index).replace('av-id"', "av-id-" + index + '"'),
        );
        embedResponder = async () => ({
            code: 0,
            data: {
                blocks: [{
                    block: {
                        id: "source-container",
                        content: manyCarriers.join(""),
                    },
                }],
            },
        });
        let manyReads = 0;
        avResponder = async url => {
            manyReads++;
            return url === "/api/av/getAttributeView" ? {code: 0, data: avRaw} : avPage(["manyKeyword"]);
        };
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const many = await settle("manyKeyword", {includeAttributeView: true});
            full(many);
            assert.equal(many.matches.length, 40, "embedded AV workset can exceed the 32-carrier cache limit");
            assert.equal(manyReads, 80);
            full(await search("manyKeyword", {includeAttributeView: true}));
            assert.equal(manyReads, 80, "pinned embedded workset cannot evict itself into endless indexing");
        } finally {
            avModule.releaseAvCacheOwner("r", edit);
            corpus.releaseBackgroundCorpusRoot("r");
        }
        assert.equal(
            avModule.rootUsesAttributeViews("r", ["av-id-0"]),
            false,
            "closing search releases embedded AV ownership",
        );
        console.log("embedded AV oversized workset completes once and releases its cache pins OK");
        // Native API honors effective heading mode, order and root/self exclusions.
        for (const mode of [0, 1, 2]) {
            reset();
            add("b", "query_embed", "select * from blocks");
            doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" custom-heading-mode="' + mode +
                '" data-content="select * from blocks"></div>';
            const heading = '<div data-node-id="heading" data-type="NodeHeading" data-subtype="h1">headingOnly</div>';
            const child = '<div data-node-id="child" data-type="NodeParagraph">childOnly</div>';
            embedResponder = async body => {
                assert.equal(body.headingMode, mode);
                assert.deepEqual(body.excludeIDs, ["b", "r"]);
                assert.equal(body.notebook, "");
                assert.equal(body.breadcrumb, false);
                return {
                    code: 0,
                    data: {
                        blocks: [{
                            block: {
                                id: "heading",
                                content: mode === 1 ? heading : mode === 2 ? child : heading + child,
                            },
                        }],
                    },
                };
            };
            const cold = await search("Only");
            full(cold);
            assert.equal(cold.matches.length, mode === 0 ? 2 : 1);
            assert.equal(embedRequests.length, 1);
            full(await search("Only"));
            assert.equal(embedRequests.length, 1, "unchanged native query is cached");
            wysiwyg.innerHTML =
                '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="protyle-wysiwyg__embed">' +
                (mode === 1 ? heading : mode === 2 ? child : heading + child) + "</div></div>";
            const live = await search("Only");
            assert.deepEqual(live.matches.map(match => match.unitId), cold.matches.map(match => match.unitId));
        }
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        window.siyuan = {config: {editor: {headingEmbedMode: 1}}};
        embedResponder = async body => ({
            code: 0,
            data: {
                blocks: [{
                    block: {
                        id: "mode",
                        content: '<div data-node-id="mode" data-type="NodeParagraph">mode-' + body.headingMode +
                            "</div>",
                    },
                }],
            },
        });
        assert.equal((await search("mode-1")).matches.length, 1);
        window.siyuan.config.editor.headingEmbedMode = 2;
        assert.equal((await search("mode-2")).matches.length, 1, "default setting invalidates cold cache");
        assert.equal(embedRequests.length, 2);
        delete window.siyuan;
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        embedResponder = async () => ({code: 0, data: {blocks: []}});
        full(await search("foo"));
        full(await search("other"));
        assert.equal(embedRequests.length, 1, "successful empty native results are cached across keywords");
        reset();
        add("b", "query_embed", "select * from blocks");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        let finishQuery;
        let queryStarted;
        const startedQuery = new Promise(resolve => queryStarted = resolve);
        embedResponder = async () => {
            queryStarted();
            return new Promise(resolve =>
                finishQuery = () =>
                    resolve({
                        code: 0,
                        data: {
                            blocks: [{
                                block: {
                                    id: "late",
                                    content: '<div data-node-id="late" data-type="NodeParagraph">foo</div>',
                                },
                            }],
                        },
                    })
            );
        };
        const embedController = new AbortController();
        const cancelledQuery = search("foo", {signal: embedController.signal});
        await startedQuery;
        embedController.abort();
        finishQuery();
        assert.equal((await cancelledQuery).cancelled, true);
        embedResponder = async () => ({code: 0, data: {blocks: []}});
        full(await search("foo"));
        assert.equal(embedRequests.length, 2, "cancelled native query cannot leave success/failure cache");
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        reset();
        for (let i = 0; i < 7; i++) {
            add("b" + i, "query_embed", "select * from blocks");
            doms["b" + i] = '<div data-node-id="b' + i +
                '" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        }
        let concurrentQueries = 0;
        let maxQueries = 0;
        embedResponder = async () => {
            concurrentQueries++;
            maxQueries = Math.max(maxQueries, concurrentQueries);
            await new Promise(resolve => setTimeout(resolve, 5));
            concurrentQueries--;
            return {code: 0, data: {blocks: []}};
        };
        full(await search("foo"));
        assert.equal(embedRequests.length, 7);
        assert.equal(maxQueries, 2, "native queries stay within the two-host budget");
        reset();
        add("b", "query_embed", "foo");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="//!js foo"></div>';
        assert.equal((await search("foo")).unrendered, 1, "cold JS remains explicitly incomplete without execution");
        assert.equal(embedRequests.length, 0);
        reset();
        add("b", "query_embed", "foo");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
        embedResponder = async () => ({code: -1});
        const queryFailed = await search("foo");
        assert.equal(queryFailed.unrendered, 1, "native query failure cannot use mismatched export expansion");
        const failedRequests = embedRequests.length;
        await search("foo");
        assert.equal(embedRequests.length, failedRequests, "failed native query uses finite backoff");
        console.log(
            "embedded repeated instance text/math/memo/selection/recovery and native cold query modes/cache/failure OK",
        );
        // A source save can arrive while the embed API is reading. The host's
        // hash remains unchanged, and the invalidation applies across roots.
        for (const outcome of ["success", "empty", "failure"]) {
            for (const finishOldFirst of [true, false]) {
                reset();
                add("b", "query_embed", "select * from blocks");
                add("p", "p", "plainKeyword");
                doms.b =
                    '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
                doms.p = '<div data-node-id="p" data-type="NodeParagraph">plainKeyword</div>';
                let finishOld;
                let queryStarted;
                const started = new Promise(resolve => queryStarted = resolve);
                embedResponder = async () => {
                    queryStarted();
                    return new Promise(resolve =>
                        finishOld = () =>
                            resolve(
                                outcome === "failure" ? {code: -1} : {
                                    code: 0,
                                    data: {
                                        blocks: outcome === "empty" ? [] : [{
                                            block: {
                                                id: "source",
                                                content:
                                                    '<div data-node-id="source" data-type="NodeParagraph">oldKeyword</div>',
                                            },
                                        }],
                                    },
                                },
                            )
                    );
                };
                const oldSearch = search("Keyword");
                await started;
                corpus.invalidateDocumentStructureCaches(finishOldFirst ? "r" : "source-root");
                embedResponder = async () => ({
                    code: 0,
                    data: {
                        blocks: [{
                            block: {
                                id: "source",
                                content: '<div data-node-id="source" data-type="NodeParagraph">newKeyword</div>',
                            },
                        }],
                    },
                });
                let oldResult;
                if (finishOldFirst) {
                    finishOld();
                    oldResult = await oldSearch;
                }
                const fresh = await search("newKeyword");
                full(fresh);
                assert.equal(fresh.matches.length, 1, outcome + " cannot leave stale success or failure cache");
                if (!finishOldFirst) {
                    finishOld();
                    oldResult = await oldSearch;
                }
                assert.ok(oldResult.matches.every(match => match.blockId === "p"), "invalidated embed text is omitted");
                assert.equal(oldResult.unrendered, 1, "discarded embed snapshot reports incomplete coverage");
                full(await search("newKeyword"));
                assert.equal(
                    (await search("oldKeyword")).matches.length,
                    0,
                    "late old result cannot replace fresh cache",
                );
                assert.equal(embedRequests.length, 2, "fresh native result remains cached");
                const plain = await search("plainKeyword");
                full(plain);
                assert.equal(plain.matches.length, 1, "source save preserves ordinary text");
                const plainReads = domReadIds.filter(id => id === "p").length;
                // An API-failed batch already declines plain-cache writes. A save
                // must not change that policy or discard an otherwise healthy cache.
                assert.equal(plainReads, outcome === "failure" ? 2 : 1, "ordinary hash cache policy is preserved");
                full(await search("plainKeyword"));
                assert.equal(domReadIds.filter(id => id === "p").length, plainReads, "ordinary cache stays reusable");
            }
        }
        console.log(
            "embedded save/query race success/empty/failure, cross-root invalidation and plain cache isolation OK",
        );
        for (const output of ["success", "failure"]) {
            reset();
            add("b", "query_embed", "select * from blocks");
            wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' +
                '<div data-node-id="source" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="graph"><div></div></div></div>';
            let finishOld;
            let renderStarted;
            const started = new Promise(resolve => renderStarted = resolve);
            window.Protyle.graphvizRender = host => {
                renderCalls++;
                const block = host.querySelector('[data-subtype="graphviz"]');
                if (!block) return;
                finishOld = () =>
                    block.innerHTML = output === "failure" ?
                        '<div class="ft__error">error</div>' :
                        "<svg><text>oldKeyword</text></svg>";
                renderStarted();
            };
            const oldRecovery = search("oldKeyword");
            await started;
            corpus.invalidateDocumentStructureCaches("source-root");
            window.Protyle.graphvizRender = host => {
                renderCalls++;
                host.querySelector('[data-subtype="graphviz"]').innerHTML = "<svg><text>newKeyword</text></svg>";
            };
            const fresh = await search("newKeyword");
            full(fresh);
            assert.equal(fresh.matches.length, 1);
            finishOld();
            const oldResult = await oldRecovery;
            assert.equal(oldResult.matches.length, 0, "invalidated recovery output is omitted");
            assert.equal(oldResult.unrendered, 1);
            const retained = await search("newKeyword");
            full(retained);
            assert.equal(retained.matches.length, 1, "late recovery cannot overwrite or back off the fresh cache");
            assert.equal(renderCalls, 2, "fresh recovery remains cached");
            assert.equal(domCalls, 0, "mounted recovery keeps its live source");
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        }
        console.log("embedded save/recovery race success/failure, cache reuse and host cleanup OK");
        for (const foldedParent of [null, "heading", "list"]) {
            for (const [query, regexMode] of [["memoKeyword", false], ["memoKeyword", true], [".+", true]]) {
                reset();
                if (foldedParent === "heading") {
                    add("a", "h", "heading", "", "r", 'fold="1"');
                    wysiwyg.innerHTML =
                        '<div class="h1" data-node-id="a" data-type="NodeHeading" data-subtype="h1" fold="1"><div contenteditable="true">heading</div></div>';
                } else if (foldedParent === "list") {
                    add("l", "i", "", "", "r", 'fold="1"');
                    wysiwyg.innerHTML = '<div class="li" data-node-id="l" data-type="NodeListItem" fold="1"></div>';
                }
                add("b", "p", "host", "", foldedParent === "list" ? "l" : foldedParent === "heading" ? "a" : "r");
                // SiYuan buildBlockFromNode uses ExportNodeStdMd, NOT the
                // document FormatRenderer. A real memo loses its DOM attribute
                // in blocks.markdown and keeps its type in the spans table.
                db.prepare("UPDATE blocks SET markdown = ? WHERE id = 'b'").run("host<sup>(memoKeyword)</sup>");
                db.prepare("INSERT INTO spans VALUES (?,?,?,?)").run(
                    "memo-span",
                    "b",
                    "r",
                    "textmark strong inline-memo",
                );
                db.prepare("INSERT INTO spans VALUES (?,?,?,?)").run(
                    "memo-span-copy",
                    "b",
                    "r",
                    "textmark inline-memo",
                );
                add("p", "p", "memoKeyword");
                add("diagram", "c", "memoKeyword", "graphviz");
                doms.b = '<div class="p" data-node-id="b" data-type="NodeParagraph"' +
                    (foldedParent === "heading" ? ' parent-heading="a"' : "") +
                    '><div contenteditable="true"><span data-type="inline-memo" data-inline-memo-content="memoKeyword">host</span></div><div class="protyle-attr" contenteditable="false"></div></div>';
                const options = {regex: regexMode, includeInlineMemo: true, restrictInlineTypes: ["inline-memo"]};
                const cold = await search(query, options);
                full(cold);
                assert.equal(cold.matches.length, 1, "cold ordinary memo is recalled: " + foldedParent + "/" + query);
                assert.equal(cold.matches[0].highlightKind, "inline-memo");
                assert.equal(cold.matches[0].replaceable, true, "ordinary memo replacement identity is preserved");
                assert.deepEqual(domReadIds, ["b"], "memo-only search does not load unrelated text or diagrams");
                assert.equal(renderCalls, 0);
                const again = await source("frontend/pipeline").calculateSearchMatches({}, edit, query, {
                    includeAttributeView: false,
                    includeFoldedBlocks: true,
                    ...options,
                });
                full(again);
                assert.equal(again.matches.length, 1, "production pipeline retains cold memo hits");
                assert.deepEqual(domReadIds, ["b"], "unchanged memo host reuses its hash cache");
                const disabled = await search(query, {...options, includeParagraph: false});
                full(disabled);
                assert.equal(disabled.matches.length, 0);
                if (foldedParent) {
                    const hidden = await search(query, {...options, includeFoldedBlocks: false});
                    full(hidden);
                    assert.equal(hidden.matches.length, 0, "folded memo gate still applies");
                }
                const disabledMemo = await search("memoKeyword", {
                    ...options,
                    includeInlineMemo: false,
                    restrictInlineTypes: [],
                    includeParagraph: false,
                    includeImageTitle: false,
                    includeCodeBlock: false,
                });
                full(disabledMemo);
                assert.ok(disabledMemo.matches.every(match => match.highlightKind !== "inline-memo"));
            }
        }
        console.log("ordinary cold/folded memo-only literal/regex, pipeline, cache, replacement and gates OK");
        for (const indexed of [true, false]) {
            reset();
            for (
                const [id, type, markdown, blockDOM] of [
                    [
                        "b",
                        "p",
                        "host<sup>(<b>memo</b>Keyword)</sup>",
                        '<div class="p" data-node-id="b" data-type="NodeParagraph"><div contenteditable="true"><span data-type="strong inline-memo" data-inline-memo-content="&lt;b&gt;memo&lt;/b&gt;Keyword">host</span></div></div>',
                    ],
                    [
                        "h",
                        "h",
                        "# 文字<sup>（memoKeyword）</sup>",
                        '<div class="h1" data-node-id="h" data-type="NodeHeading" data-subtype="h1"><div contenteditable="true"><span data-type="inline-memo" data-inline-memo-content="memoKeyword">文字</span></div></div>',
                    ],
                    [
                        "t",
                        "t",
                        "| host<sup>(memoKeyword)</sup> |",
                        '<div class="table" data-node-id="t" data-type="NodeTable"><table><tbody><tr><td><span data-type="inline-memo" data-inline-memo-content="memoKeyword">host</span></td></tr></tbody></table></div>',
                    ],
                ]
            ) {
                add(id, type, "host");
                db.prepare("UPDATE blocks SET markdown = ? WHERE id = ?").run(markdown, id);
                insertMemoSpan.run("memo-" + id, id, "r", "textmark inline-memo");
                doms[id] = blockDOM;
            }
            // Ordinary superscripts are never real memo units, even when the
            // fallback uses <sup> as a conservative candidate marker.
            add("sup", "p", "host<sup>memoKeyword</sup>");
            doms.sup =
                '<div data-node-id="sup" data-type="NodeParagraph"><div contenteditable="true">host<sup>memoKeyword</sup></div></div>';
            if (!indexed) failSql = stmt => stmt.includes("FROM spans");
            const options = {includeInlineMemo: true, restrictInlineTypes: ["inline-memo"]};
            for (const [query, regexMode] of [["memoKeyword", false], ["memoKeyword", true], [".+", true]]) {
                const found = await search(query, {...options, regex: regexMode});
                full(found);
                assert.deepEqual(found.matches.map(match => match.blockId), ["b", "h", "t"]);
                assert.ok(found.matches.every(match => match.highlightKind === "inline-memo"));
            }
            assert.deepEqual(Array.from(new Set(domReadIds)), indexed ? ["b", "h", "t"] : ["b", "h", "sup", "t"]);
            assert.equal(domReadIds.filter(id => id !== "sup").length, 3, "real memo hosts reuse their hash cache");
            assert.equal(renderCalls, 0, "indexed/fallback memo extraction is render-free");
            assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        }
        console.log("memo rich text, Chinese/ASCII export, heading/table hosts and index-failure fallback OK");
        for (const foldedParent of [null, "heading", "list"]) {
            for (const [query, regexMode] of [["memoKeyword", false], ["memoKeyword", true], [".+", true]]) {
                reset();
                if (foldedParent === "heading") {
                    add("a", "h", "heading", "", "r", 'fold="1"');
                    wysiwyg.innerHTML =
                        '<div data-node-id="a" data-type="NodeHeading" data-subtype="h1" fold="1">heading</div>';
                } else if (foldedParent === "list") {
                    add("l", "i", "", "", "r", 'fold="1"');
                    wysiwyg.innerHTML = '<div data-node-id="l" data-type="NodeListItem" fold="1"></div>';
                }
                add("b", "query_embed", "select * from blocks", "", foldedParent === "list" ? "l" : "r");
                // Include unrelated ordinary content and a pending renderer: memo
                // candidates must not broaden to all body text or render diagrams.
                add("p", "p", "memoKeyword");
                const embedSourceDOM =
                    '<div class="p" data-node-id="source" data-type="NodeParagraph"><div contenteditable="true"><span data-type="inline-memo" data-inline-memo-content="memoKeyword">note</span></div></div>' +
                    '<div data-node-id="diagram" data-type="NodeCodeBlock" data-subtype="graphviz" data-content="memoKeyword"><div></div></div>';
                // A real cold embed DOM contains only its query; copied memo
                // attributes come from searchEmbedBlock's native result DOM.
                doms.b =
                    '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"></div>';
                embedResponder = async () => ({
                    code: 0,
                    data: {blocks: [{block: {id: "source", rootID: "source-root", content: embedSourceDOM}}]},
                });
                const options = {
                    regex: regexMode,
                    includeInlineMemo: true,
                    restrictInlineTypes: ["inline-memo"],
                };
                const cold = await search(query, options);
                full(cold);
                assert.equal(cold.matches.length, 1, "cold embedded memo is recalled: " + foldedParent + "/" + query);
                assert.equal(cold.matches[0].highlightKind, "inline-memo");
                assert.equal(cold.matches[0].replaceable, false);
                assert.equal(embedRequests.length, 1);
                assert.deepEqual(domReadIds, ["b"], "memo-only query does not load unrelated ordinary text");
                assert.equal(renderCalls, 0, "memo-only extraction does not render unrelated diagrams");
                full(await search(query, options));
                assert.equal(embedRequests.length, 1, "memo-only native results are cached");
                const disabled = await search(query, {...options, includeEmbedBlock: false});
                full(disabled);
                assert.equal(disabled.matches.length, 0);
                assert.equal(embedRequests.length, 1, "disabled embeds cannot issue native queries");
                if (foldedParent) {
                    const hidden = await search(query, {...options, includeFoldedBlocks: false});
                    full(hidden);
                    assert.equal(hidden.matches.length, 0, "folded embed visibility gate still applies");
                    assert.equal(embedRequests.length, 1);
                }
                wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + embedSourceDOM +
                    "</div>";
                const live = await search(query, options);
                full(live);
                assert.deepEqual(live.matches.map(match => match.unitId), cold.matches.map(match => match.unitId));
                assert.equal(embedRequests.length, 1, "live memo avoids native queries");
                assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
            }
        }
        console.log(
            "embedded memo-only literal/regex cold/live, folded/disabled gates, cache and no unrelated render/read OK",
        );
        console.log("visibility overrides, incomplete math cache and embedded renderer coverage OK");
        console.log("author hiding, ancestor hiding, coverage failures and cancellation OK");
    } finally {
        corpus.invalidateDocumentSearchCaches();
        dom.window.close();
        db.close();
    }
    console.log("corpus-regressions OK (mocked SiYuan renderers/APIs)");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
