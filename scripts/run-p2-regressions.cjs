// Source contracts against SiYuan's pagination/transaction semantics; not a host E2E substitute.
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
let editorReads = 0;
let confirmAction = (yes) => yes();
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {
            fetchSyncPost: (...args) => api(...args),
            getAllEditor: () => {
                editorReads++;
                return editors;
            },
            confirm: (title, text, yes, no) => confirmAction(yes, no, text, title),
            showMessage: () => {},
            hideMessage: () => {},
        };
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    const code = fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"');
    mod._compile(
        ts.transpileModule(
            code + (file.endsWith(path.join("corpus", "search.ts")) ?
                "\nexport const auditSpecialCache = () => ({bytes: textCacheBytes, pins: activeSpecialCacheKeys.size});\nexport const auditMemoizedIds = memoizedIds;" :
                ""),
            {
                compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
                fileName: file,
            },
        ).outputText,
        file,
    );
};
const source = (file) => require(path.join(repo, "src", file + ".ts"));
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
        "Range",
        "HTMLTableElement",
        "HTMLTableRowElement",
        "HTMLTableCellElement",
    ]
) global[key] = window[key];
global.CSS = {escape: (value) => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
const matcher = source("shared/match-text");
const av = source("frontend/corpus/av");
const units = source("frontend/corpus/units");
const project = source("frontend/corpus/project");
const blocks = source("frontend/blocks");
const write = source("frontend/protyle-write");
const corpus = source("frontend/corpus/search");
const ref = (blockId = "b", avId = "a") => ({blockId, avId, updated: "1", carrierViewId: "v"});
const row = (id, text = id) => ({id, cells: [{value: {keyID: "k", text: {content: text}}}]});
const view = (rows, total = rows.length) => ({rows, rowCount: total, columns: [{id: "k", name: "column"}]});
const raw = {name: "database", views: [{id: "v", name: "view"}]};

async function main() {
    // Native renderCell formats number/date text before painting. Cold matching
    // must use that same text, not stored timestamps or unformatted numbers.
    const stamp = new Date(2026, 9, 12, 9, 5).valueOf();
    const endStamp = new Date(2026, 9, 13, 10, 6).valueOf();
    const languageBefore = global.siyuan;
    global.siyuan = {
        languages: {
            _attrView: {
                dateFormatFullTemplate: "${year}年${month}${day}日",
                dateMonths: "一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月",
            },
        },
    };
    try {
        const cases = [
            ["number", "", {content: 1200, formattedContent: "1,200", isNotEmpty: true}, "1,200"],
            ["number", "", {content: 0, formattedContent: "0", isNotEmpty: true}, "0"],
            ["number", "", {content: 8, formattedContent: "8"}, "8"],
            ["number", "", {content: 0, isNotEmpty: false}, ""],
            ["date", "", {content: stamp, isNotEmpty: true}, "2026-10-12"],
            ["date", "year-month-day", {content: stamp, isNotEmpty: true, isNotTime: false}, "2026/10/12 09:05"],
            ["date", "month-day-year", {content: stamp, isNotEmpty: true, isNotTime: true}, "10/12/2026"],
            ["date", "day-month-year", {content: stamp, isNotEmpty: true, isNotTime: true}, "12/10/2026"],
            ["date", "full", {content: stamp, isNotEmpty: true, isNotTime: true}, "2026年十月12日"],
            [
                "date",
                "",
                {content: stamp, content2: endStamp, hasEndDate: true, isNotEmpty: true, isNotEmpty2: true},
                "2026-10-122026-10-13",
            ],
            ["created", "full", {content: stamp, isNotEmpty: true, formattedContent: "原生时间"}, "原生时间"],
            ["updated", "day-month-year", {content: stamp, isNotEmpty: true}, "12/10/2026"],
            ["updated", "", {content: 0, isNotEmpty: true}, ""],
            ["rollup", "", {
                contents: [
                    {type: "number", number: {content: 0}},
                    {type: "date", date: {content: stamp, isNotEmpty: true}},
                    {type: "checkbox", checkbox: {checked: true}},
                ],
            }, "0, 2026-10-12, "],
            ["rollup", "", {
                contents: [
                    {
                        type: "date",
                        date: {
                            content: stamp,
                            content2: endStamp,
                            hasEndDate: true,
                            isNotEmpty: true,
                            isNotEmpty2: true,
                        },
                    },
                ],
            }, "2026-10-13"],
        ];
        for (const [type, dateFormat, value, expected] of cases) {
            av.invalidateAvCache();
            api = async url => ({
                code: 0,
                data: url.endsWith("getAttributeView") ? raw : {
                    view: {
                        columns: [{id: "k", type, dateFormat}, {id: "hidden", type, dateFormat, hidden: true}],
                        rowCount: 1,
                        rows: [{
                            id: "row",
                            cells: [
                                {value: {keyID: "k", type, [type]: value}},
                                {value: {keyID: "hidden", type, [type]: value}},
                            ],
                        }],
                    },
                },
            });
            const cells = (await av.loadAvUnits([ref()])).filter(unit => unit.unitId.startsWith("av:"));
            assert.deepEqual(cells.map(cell => cell.text), expected ? [expected] : [], type + "/" + dateFormat);
            if (expected) {
                const host = document.createElement("div");
                host.innerHTML =
                    '<div class="av" data-node-id="b" data-type="NodeAttributeView"><div class="av__row" data-id="row"><div class="av__cell" data-col-id="k"></div></div></div>';
                host.querySelector(".av__cell").textContent = expected;
                document.body.appendChild(host);
                const live = blocks.collectSearchableBlocks(host, {
                    includeAttributeView: true,
                    scopeRoots: [host.firstElementChild],
                });
                const hits = matcher.matchTextUnitsDetailed(cells, expected).hits;
                const rebound = project.fillLiveRanges(hits, live, true);
                assert.equal(
                    rebound[0].range?.toString(),
                    hits[0].matchedText,
                    "formatted cold offset binds to native DOM",
                );
                host.remove();
            }
        }
    } finally {
        global.siyuan = languageBefore;
        av.invalidateAvCache();
    }
    console.log("AV native number/date display and cold-to-DOM offsets OK");
    const originalHtmlTexts = blocks.attributeViewHtmlTexts;
    let htmlParses = 0;
    blocks.attributeViewHtmlTexts = (...args) => {
        htmlParses++;
        return originalHtmlTexts(...args);
    };
    try {
        api = async url => ({
            code: 0,
            data: url.endsWith("getAttributeView") ? raw : {
                view: {
                    rowCount: 1,
                    columns: [],
                    rows: [{
                        id: "i",
                        cells: Array.from({length: 3000}, (_, index) => ({
                            value: {
                                keyID: "k" + index,
                                ...[
                                    {
                                        type: "mAsset",
                                        mAsset: [{type: "file", name: "fileKeyword", content: "assets/hidden.pdf"}],
                                    },
                                    {
                                        type: "relation",
                                        relation: {contents: [{type: "block", block: {content: "relationKeyword"}}]},
                                    },
                                    {
                                        type: "rollup",
                                        rollup: {
                                            contents: [{type: "number", number: {content: 0}}, {
                                                type: "text",
                                                text: {content: "rollupKeyword"},
                                            }],
                                        },
                                    },
                                ][index % 3],
                            },
                        })),
                    }],
                },
            },
        });
        const compound = await av.loadAvUnits([ref()]);
        assert.equal(compound.filter(unit => unit.unitId.startsWith("av:")).length, 3000);
        assert.equal(
            htmlParses,
            0,
            "ordinary files/relations/rollups keep the string path, without per-cell DOM parsing",
        );
    } finally {
        blocks.attributeViewHtmlTexts = originalHtmlTexts;
        av.invalidateAvCache();
    }
    const metaModule = source("frontend/corpus/meta");
    const orderModule = source("frontend/corpus/order");
    for (const invalidation of ["root", "all", "other", "abort"]) {
        metaModule.invalidateDocMeta();
        orderModule.invalidateDocOrder();
        const replies = [];
        api = async (url) =>
            await new Promise((resolve) => {
                replies.push(() =>
                    resolve({
                        code: 0,
                        data: url.endsWith("sql") ?
                            [{id: "b", parent_id: "r", type: "p", hash: "old", updated: "1"}] :
                            ["old-b"],
                    })
                );
            });
        const controller = new AbortController();
        const pending = [
            metaModule.loadDocMeta("r", controller.signal),
            orderModule.fetchDocBlocksOrders("r", "1:1", controller.signal),
            orderModule.fetchHeadingChildrenIds("r", "h", "1:1", controller.signal),
        ];
        if (invalidation === "abort") controller.abort();
        else {
            const root = invalidation === "all" ? undefined : invalidation === "other" ? "unrelated" : "r";
            metaModule.invalidateDocMeta(root);
            orderModule.invalidateDocOrder(root);
        }
        replies.forEach((reply) => reply());
        const results = await Promise.all(pending);
        if (invalidation === "other") assert.ok(results.every(Boolean));
        else {
            assert.deepEqual(results, [null, null, null], "invalidated/aborted snapshots cannot repopulate caches");
            assert.equal(metaModule.peekDocMeta("r"), null);
            assert.equal(orderModule.peekDocOrder("r"), null);
        }
    }
    metaModule.invalidateDocMeta();
    orderModule.invalidateDocOrder();
    let oldMetaReply;
    api = async () =>
        await new Promise((resolve) => {
            oldMetaReply = () => resolve({code: 0, data: [{id: "b", type: "p", hash: "old", updated: "1"}]});
        });
    const oldMeta = metaModule.loadDocMeta("r");
    metaModule.invalidateDocMeta("r");
    api = async () => ({code: 0, data: [{id: "b", type: "p", hash: "new", updated: "2"}]});
    await metaModule.loadDocMeta("r");
    oldMetaReply();
    assert.equal(await oldMeta, null);
    assert.equal(metaModule.peekDocMeta("r").byId.get("b").hash, "new", "late old read does not overwrite newer cache");
    metaModule.invalidateDocMeta();
    const {CacheReadGuards} = source("frontend/corpus/cache-read-guard");
    const guards = new CacheReadGuards();
    for (let i = 0; i < 3000; i++) guards.begin("r" + i).release();
    assert.equal(guards.reads.size, 0, "closed documents do not leave guard entries");
    let oldCandidatesReply;
    const candidateKey = JSON.stringify(["r", "content", "foo"]);
    const oldCandidates = corpus.auditMemoizedIds("r", candidateKey, "same-signature", () =>
        new Promise((resolve) => {
            oldCandidatesReply = () => resolve(["old"]);
        }));
    corpus.invalidateDocumentStructureCaches("r");
    await corpus.auditMemoizedIds("r", candidateKey, "same-signature", async () => ["new"]);
    oldCandidatesReply();
    assert.equal(await oldCandidates, null);
    assert.deepEqual(
        await corpus.auditMemoizedIds("r", candidateKey, "same-signature", () => {
            throw new Error("new candidate cache should be retained");
        }),
        ["new"],
    );
    console.log("P2 in-flight meta/order/heading invalidation, cancellation and guard cleanup OK");
    let renders = 0;
    let display = "old";
    api = async (url) => ({code: 0, data: url.endsWith("getAttributeView") ? raw : {view: view([row("i", display)])}});
    const refs = Array.from({length: 33}, (_, index) => ref("b" + index, "a" + index));
    av.pinAvCache("r", refs, new Map());
    const responding = api;
    api = async (...args) => {
        if (args[0].endsWith("renderAttributeView")) renders++;
        return responding(...args);
    };
    await av.loadAvUnits(refs);
    assert.equal(av.peekAvUnits(refs).missing.length, 0, "33-carrier working set converges");
    await av.loadAvUnits(refs);
    assert.equal(renders, 33, "stable query performs no more render APIs");
    display = "new";
    av.invalidateAvCacheForIds(["a0"]);
    assert.equal(av.peekAvUnits(refs).missing.length, 1, "only changed database invalidates");
    await av.loadAvUnits([refs[0]]);
    assert.ok(av.peekAvUnits([refs[0]]).units.some((unit) => unit.text === "new"));
    av.releaseAvCache("r");
    assert.ok(av.peekAvUnits(refs).missing.length > 0, "released working set returns to LRU cap");
    av.invalidateAvCache();
    console.log("P2 AV working set, exact invalidation and release OK");

    const leftOwner = {};
    const rightOwner = {};
    const multiRefs = Array.from({length: 20}, (_, index) => ref("pane" + index, "db" + index));
    api = async (url, body) => ({
        code: 0,
        data: url.endsWith("getAttributeView") ?
            {name: "database", views: [{id: "left", name: "left"}, {id: "right", name: "right"}]} :
            {view: view([row("i", body.viewID)])},
    });
    const leftViews = new Map(multiRefs.map((item) => [item.blockId, "left"]));
    const rightViews = new Map(multiRefs.map((item) => [item.blockId, "right"]));
    av.pinAvCache("r", multiRefs, leftViews, leftOwner);
    av.pinAvCache("r", multiRefs, rightViews, rightOwner);
    await av.loadAvUnits(multiRefs, () => true, leftViews);
    await av.loadAvUnits(multiRefs, () => true, rightViews);
    assert.equal(av.peekAvUnits(multiRefs, leftViews).missing.length, 0);
    assert.equal(av.peekAvUnits(multiRefs, rightViews).missing.length, 0);
    av.releaseAvCacheOwner("r", leftOwner);
    assert.equal(av.peekAvUnits(multiRefs, rightViews).missing.length, 0, "other pane keeps its working set");
    av.releaseAvCacheOwner("r", rightOwner);
    assert.ok(av.peekAvUnits(multiRefs, leftViews).missing.length > 0, "released view does not stay pinned");
    av.invalidateAvCache();
    const revisionRefs = [{...ref(), updated: "old"}, {...ref(), updated: "new"}];
    await av.loadAvUnits([revisionRefs[0]]);
    await av.loadAvUnits([revisionRefs[1]]);
    assert.equal(av.peekAvUnits([revisionRefs[0]]).missing.length, 1, "old revision evicted");
    assert.equal(av.peekAvUnits([revisionRefs[1]]).missing.length, 0);
    av.invalidateAvCache();
    const budget = source("frontend/corpus/cache-budget");
    const evictions = [];
    for (const id of ["a", "b"]) budget.rememberCacheBudget("probe:" + id, 3 * 1024 * 1024, () => evictions.push(id));
    budget.touchCacheBudget("probe:a");
    budget.rememberCacheBudget("probe:c", 3 * 1024 * 1024, () => evictions.push("c"));
    assert.deepEqual(evictions, ["b"], "shared byte budget evicts least recently used cache");
    budget.forgetCacheBudget("probe:a");
    budget.forgetCacheBudget("probe:c");
    budget.rememberCacheBudget("probe:oversized", 9 * 1024 * 1024, () => evictions.push("oversized"));
    assert.deepEqual(evictions, ["b", "oversized"]);
    console.log("P2 multiview ownership, revision eviction and shared budget OK");

    // Different worksets share an overlapping carrier. Cancellation belongs to each consumer.
    for (const cancellation of ["none", "first", "last", "invalidate"]) {
        av.invalidateAvCache();
        let release;
        let entered;
        const started = new Promise((resolve) => {
            entered = resolve;
        });
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let rawCalls = 0;
        let renderCalls = 0;
        api = async (url) => {
            if (url.endsWith("getAttributeView")) {
                rawCalls++;
                entered();
                await gate;
                return {code: 0, data: raw};
            }
            renderCalls++;
            return {code: 0, data: {view: view([row("i")])}};
        };
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();
        const one = av.loadAvUnits([ref("a", "db-a")], () => true, new Map(), firstAbort.signal);
        await started;
        const two = av.loadAvUnits([ref("a", "db-a"), ref("b", "db-b")], () => true, new Map(), secondAbort.signal);
        await Promise.resolve();
        if (cancellation !== "none") firstAbort.abort();
        if (cancellation === "last") secondAbort.abort();
        if (cancellation === "invalidate") av.invalidateAvCacheForIds(["db-a"]);
        release();
        const results = await Promise.all([one, two]);
        assert.equal(rawCalls, cancellation === "last" || cancellation === "invalidate" ? 1 : 2);
        assert.equal(renderCalls, cancellation === "last" || cancellation === "invalidate" ? 0 : 2);
        if (cancellation === "first") {
            assert.equal(results[0].length, 0);
            assert.ok(results[1].length > 0, "remaining consumer completes shared carrier");
        }
        if (cancellation === "last" || cancellation === "invalidate") {
            assert.equal(av.peekAvUnits([ref("a", "db-a")]).missing.length, 1, "cancelled flight never caches");
            await av.loadAvUnits([ref("a", "db-a")]);
            assert.equal(av.peekAvUnits([ref("a", "db-a")]).missing.length, 0, "new flight retries");
        }
    }
    av.invalidateAvCache();
    console.log("P2 overlapping AV flights, independent/last cancellation, exact invalidation and retry OK");
    let concurrentRaw = 0;
    let concurrentRender = 0;
    api = async (url, body) => {
        if (url.endsWith("getAttributeView")) {
            concurrentRaw++;
            await Promise.resolve();
            return {
                code: 0,
                data: {name: "database", views: [{id: "left", name: "left"}, {id: "right", name: "right"}]},
            };
        }
        concurrentRender++;
        return {code: 0, data: {view: view([row("i", body.viewID)])}};
    };
    const concurrentViews = await Promise.all(
        ["left", "right"].map((id) => av.loadAvUnits([ref()], () => true, new Map([["b", id]]))),
    );
    assert.equal(concurrentRaw, 2, "different views never share a carrier flight");
    assert.equal(concurrentRender, 2);
    assert.ok(concurrentViews[0].some((unit) => unit.text === "left"));
    assert.ok(concurrentViews[1].some((unit) => unit.text === "right"));
    av.invalidateAvCache();
    let failCarrier = true;
    api = async (url, body) => ({
        code: 0,
        data: url.endsWith("getAttributeView") ?
            raw :
            failCarrier && body.id === "db-a" ?
            {} :
            {view: view([row("i")])},
    });
    const failedFlights = await Promise.allSettled([
        av.loadAvUnits([ref("a", "db-a")]),
        av.loadAvUnits([ref("a", "db-a"), ref("b", "db-b")]),
    ]);
    for (const result of failedFlights) {
        assert.equal(result.status, "rejected");
        assert.deepEqual(result.reason.failedBlockIds, ["a"]);
    }
    assert.equal(av.peekAvUnits([ref("b", "db-b")]).missing.length, 0, "shared failure preserves independent carrier");
    failCarrier = false;
    await av.loadAvUnits([ref("a", "db-a")]);
    assert.equal(av.peekAvUnits([ref("a", "db-a")]).missing.length, 0, "failed flight can retry");
    av.invalidateAvCache();

    const pageRows = Array.from({length: 200}, (_, i) => row("i" + i));
    async function checkPages(response, failure = false) {
        av.invalidateAvCache();
        api = async (url, body) => ({code: 0, data: url.endsWith("getAttributeView") ? raw : response(body)});
        if (failure) {
            await assert.rejects(av.loadAvUnits([ref()]));
            assert.equal(av.peekAvUnits([ref()]).missing.length, 1, "failed page is not complete cache");
            return;
        }
        return av.loadAvUnits([ref()]);
    }
    await checkPages(() => ({}), true);
    await checkPages(() => ({view: view([row("i"), row("i")], 2)}), true);
    await checkPages((body) => ({view: view(body.page === 1 ? pageRows : [row("i0")], 201)}), true);
    await checkPages(
        (body) => ({view: view(body.page === 1 ? pageRows : [row("last")], body.page === 1 ? 201 : 202)}),
        true,
    );
    const complete = await checkPages((body) => ({view: view(body.page === 1 ? pageRows : [row("last")], 201)}));
    assert.equal(complete.filter((unit) => unit.unitId.startsWith("av:")).length, 201);
    const calendar = await checkPages(() => ({view: {...view(pageRows.concat([row("last")]), 201), type: "calendar"}}));
    assert.equal(
        calendar.filter((unit) => unit.unitId.startsWith("av:")).length,
        201,
        "calendar returns all rows without pagination",
    );
    const grouped = (body) => ({
        view: {
            columns: [{id: "k", name: "column"}],
            groups: [
                {id: "g1", ...view(body.groupPaging.g1 ? [row("last")] : pageRows, 201), columns: null},
                {id: "g2", ...view([row("last")], 1), columns: null},
            ],
        },
    });
    const groupComplete = await checkPages(grouped);
    assert.equal(
        groupComplete.filter((unit) => unit.unitId.startsWith("av-group:")).length,
        202,
        "same row in multiple groups retains each displayed instance",
    );
    assert.deepEqual(
        groupComplete.slice(-2).map(unit => unit.unitId),
        ["av-group:g1:last:k", "av-group:g2:last:k"],
        "all pages of the first group precede the next group",
    );
    await checkPages((body) => {
        const data = grouped(body);
        if (body.groupPaging.g1) data.view.groups.pop();
        return data;
    }, true);
    await checkPages((body) => {
        const data = grouped(body);
        if (body.groupPaging.g1) data.view.groups.shift();
        return data;
    }, true);
    await checkPages((body) => {
        const data = grouped(body);
        if (body.groupPaging.g1) data.view.groups[0].rowCount = 202;
        return data;
    }, true);
    let visibleGroupRequests = 0;
    const visibleGroups = await checkPages(body => {
        visibleGroupRequests++;
        assert.equal(body.groupPaging.hidden, undefined, "hidden group never requests another page");
        return {
            view: {
                columns: [{id: "k"}],
                groups: [
                    {id: "hidden", groupHidden: 2, ...view(pageRows, 201), columns: null},
                    {id: "visible", groupHidden: 0, ...view([row("i", "visible")]), columns: null},
                    {id: "folded", groupHidden: 0, groupFolded: true, ...view([row("i", "folded")]), columns: null},
                ],
            },
        };
    });
    assert.equal(visibleGroupRequests, 1, "201 hidden rows need no additional request");
    assert.deepEqual(
        visibleGroups.filter(unit => unit.unitId.startsWith("av-group:")).map(unit => [unit.unitId, unit.text]),
        [["av-group:visible:i:k", "visible"], ["av-group:folded:i:k", "folded"]],
        "hidden groups are excluded while visible folded groups keep their search instances",
    );
    const namedGroups = await checkPages(() => ({
        view: {
            columns: [{id: "k"}],
            groups: [
                {id: "text", name: " 文本组 ", groupValue: {type: "text"}, ...view([row("i", "body")])},
                {
                    id: "multi",
                    name: "not-visible",
                    groupValue: {type: "mSelect", mSelect: [{content: "甲"}, {content: "乙"}]},
                    ...view([]),
                },
                {
                    id: "select",
                    name: "not-visible",
                    groupValue: {type: "select", mSelect: [{content: "选项"}]},
                    ...view([]),
                },
                {
                    id: "check",
                    name: "not-visible",
                    groupValue: {type: "checkbox", checkbox: {checked: true}},
                    ...view([]),
                },
                {id: "hidden", name: "not-visible", groupHidden: 2, ...view([])},
            ],
        },
    }));
    assert.deepEqual(
        namedGroups.filter(unit => unit.unitId.startsWith("group-title:")).map(unit => [unit.unitId, unit.text]),
        [
            ["group-title:text", " 文本组 "],
            ["group-title:multi", "甲乙"],
            ["group-title:select", "选项"],
        ],
        "group names follow native chips/icons/visibility, preserving offsets and whitespace",
    );
    assert.ok(
        namedGroups.findIndex(unit => unit.unitId === "group-title:text") <
            namedGroups.findIndex(unit => unit.unitId === "av-group:text:i:k"),
        "group names precede their own rows",
    );
    const hiddenGroups = [1, 2].map(groupHidden => {
        const group = {id: "hidden" + groupHidden, groupHidden, rowCount: groupHidden === 1 ? 0 : 201};
        Object.defineProperty(group, "rows", {
            get: () => {
                throw new Error("hidden group rows were traversed");
            },
        });
        return group;
    });
    const allHidden = await checkPages(() => ({view: {groups: hiddenGroups}}));
    assert.deepEqual(allHidden.map(unit => unit.unitId), ["av-title", "av-view:v"], "all-hidden view completes");
    const mixedHidden = await checkPages(body => ({
        view: {
            columns: [{id: "k", name: "column"}],
            groups: [...hiddenGroups, ...grouped(body).view.groups],
        },
    }));
    assert.deepEqual(mixedHidden, groupComplete, "hidden groups do not disturb visible pagination or order");
    for (const transition of ["hide", "reveal"]) {
        await checkPages(body => {
            const data = grouped(body);
            if (transition === "hide" && body.groupPaging.g1) data.view.groups[0].groupHidden = 2;
            if (transition === "reveal") {
                data.view.groups.push({
                    id: "new-visible",
                    groupHidden: body.groupPaging.g1 ? 0 : 2,
                    ...view([row("i")]),
                });
            }
            return data;
        }, true);
    }
    console.log(
        "P2 hidden/empty-hidden groups skip traversal and pagination; folded groups, order and visibility races OK",
    );
    for (const layout of ["table", "list", "gallery", "kanban", "calendar"]) {
        for (const selected of ["v", "v2", "", "deleted-view"]) {
            av.invalidateAvCache();
            let titleRequests = 0;
            const carrier = {...ref(), carrierViewId: selected};
            api = async (url, body) => {
                titleRequests++;
                if (url.endsWith("getAttributeView")) {
                    return {
                        code: 0,
                        data: {name: "database", views: [{id: "v", name: "view"}, {id: "v2", name: "other"}]},
                    };
                }
                assert.equal(body.viewID, selected === "v2" ? "v2" : "v");
                return {
                    code: 0,
                    data: {view: {...view([row("i", "cell")]), type: layout, hideAttrViewName: body.viewID === "v"}},
                };
            };
            const titleUnits = await av.loadAvUnits([carrier]);
            assert.deepEqual(
                titleUnits.map(unit => unit.unitId),
                selected === "v2" ? ["av-title", "av-view:v2", "av:i:k"] : ["av-view:v", "av:i:k"],
                "title visibility follows the selected/fallback rendered view: " + layout + "/" + selected,
            );
            await av.loadAvUnits([carrier]);
            assert.equal(titleRequests, 2, "name visibility reuses render metadata and cache");
        }
    }
    av.invalidateAvCache();
    api = async url => ({
        code: 0,
        data: url.endsWith("getAttributeView") ?
            {name: "database", views: []} :
            {view: {...view([]), hideAttrViewName: true}},
    });
    assert.deepEqual(
        await av.loadAvUnits([ref()]),
        [],
        "fallback render without view metadata also excludes hidden title",
    );
    console.log("P2 AV title visibility: all layouts, selected/default/stale/empty view, ordering and cache OK");
    const controller = new AbortController();
    av.invalidateAvCache();
    api = async (url, body) => {
        if (url.endsWith("getAttributeView")) return {code: 0, data: raw};
        controller.abort();
        return {code: 0, data: {view: view(pageRows, 201)}};
    };
    await av.loadAvUnits([ref()], () => true, new Map(), controller.signal);
    assert.equal(av.peekAvUnits([ref()]).missing.length, 1);
    for (const invalidate of [() => av.invalidateAvCacheForIds(["a"]), () => av.invalidateAvCache()]) {
        av.invalidateAvCache();
        api = async (url) => {
            if (url.endsWith("getAttributeView")) return {code: 0, data: raw};
            invalidate();
            return {code: 0, data: {view: view([row("i")])}};
        };
        await av.loadAvUnits([ref()]);
        assert.equal(av.peekAvUnits([ref()]).missing.length, 1, "late invalidated task cannot refill cache");
    }
    console.log("P2 AV missing view, duplicate rows, totals, group independence/completeness and cancellation OK");

    av.invalidateAvCache();
    const hiddenValue = {keyID: "hidden"};
    Object.defineProperty(hiddenValue, "text", {
        get: () => {
            throw new Error("hidden value was traversed");
        },
    });
    const rawMetadata = {...raw};
    Object.defineProperty(rawMetadata, "keyValues", {
        get: () => {
            throw new Error("raw values were traversed");
        },
    });
    api = async url => ({
        code: 0,
        data: url.endsWith("getAttributeView") ? rawMetadata : {
            view: {
                ...view([{id: "i", cells: [row("i", "visible").cells[0], {value: hiddenValue}]}]),
                columns: [{id: "k", hidden: false}, {id: "hidden", hidden: true}],
            },
        },
    });
    const filtered = await av.loadAvUnits([ref()]);
    assert.deepEqual(filtered.filter(unit => unit.unitId.startsWith("av:")).map(unit => unit.text), ["visible"]);
    console.log("P2 hidden/raw values skip text extraction and retention OK");

    av.invalidateAvCache();
    av.pinAvCache("large", [ref()], new Map());
    const denseRows = Array.from({length: 2000}, (_, index) => ({
        id: "dense" + index,
        cells: Array.from({length: 70}, (_, col) => ({value: {keyID: "k" + col, text: {content: "x"}}})),
    }));
    api = async (url) => ({
        code: 0,
        data: url.endsWith("getAttributeView") ? raw : {view: {...view(denseRows), type: "calendar"}},
    });
    assert.equal((await av.loadAvUnits([ref()])).filter((unit) => unit.unitId.startsWith("av:")).length, 140000);
    assert.equal(
        av.peekAvUnits([ref()]).units.length,
        140002,
        "large cell arrays do not exceed spread argument limits",
    );
    av.releaseAvCache("large");
    assert.equal(av.peekAvUnits([ref()]).missing.length, 1, "large active workset is evicted after release");
    av.invalidateAvCache();
    console.log("P2 140000-cell load/cache and release OK");

    for (const lengths of [[1, 0, 1], [0, 2, 0], [1, 1, 1], [3], [0]]) {
        const text = "a".repeat(lengths.reduce((sum, value) => sum + value, 0));
        const unit = {blockId: "b", blockType: "NodeParagraph", blockIndex: 0, text, segmentLengths: lengths};
        for (let width = 1; width <= text.length; width++) {
            const hits = matcher.matchTextUnitsDetailed([unit], "a".repeat(width), {caseSensitive: true}).hits;
            for (const hit of hits) {
                assert.equal(hit.replaceable, matcher.isHitReplaceableByUnit(unit, hit.start, hit.end));
            }
        }
    }
    const spans = [{type: "strong", start: 0, end: 10}, {type: "strong", start: 2, end: 3}, {
        type: "strong",
        start: 10,
        end: 12,
    }, {type: "em", start: 1, end: 11}];
    for (let start = 0; start <= 12; start++) {
        for (let end = start + 1; end <= 13; end++) {
            for (const types of [["strong"], ["em"], ["strong", "em"]]) {
                const expected = spans.some((span) =>
                    types.includes(span.type) && span.start <= start && span.end >= end
                );
                assert.equal(units.restrictSpanCovers(spans, types, start, end), expected);
            }
        }
    }
    const accesses = (size) => {
        let reads = 0;
        const lengths = new Proxy(Array(size).fill(1), {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++;
                return Reflect.get(target, key);
            },
        });
        const input = {
            blockId: "b",
            blockType: "NodeParagraph",
            blockIndex: 0,
            text: "a".repeat(size),
            segmentLengths: lengths,
        };
        assert.equal(matcher.matchTextUnitsDetailed([input], "a").hits.length, size);
        let spanReads = 0;
        const dense = Array.from({length: size}, (_, i) => ({
            get type() {
                spanReads++;
                return "strong";
            },
            start: i,
            end: i + 1,
        }));
        for (let i = 0; i < size; i++) assert.equal(units.restrictSpanCovers(dense, ["strong"], i, i + 1), true);
        return {reads, spanReads};
    };
    const small = accesses(1000);
    const large = accesses(2000);
    assert.ok(
        large.reads <= small.reads * 2.1 && large.spanReads <= small.spanReads * 2.1,
        "dense-hit setup is linear, not quadratic",
    );
    console.log("P2 replaceability/restrict parity and linear source reads OK", {small, large});

    const edit = document.createElement("div");
    edit.className = "protyle";
    edit.innerHTML = '<div class="protyle-content"><div class="protyle-wysiwyg"></div></div>';
    document.body.append(edit);
    const wysiwyg = edit.querySelector(".protyle-wysiwyg");
    let commits = 0;
    const writtenHtml = new Map();
    const protyle = {
        protyle: {element: edit, notebookId: "", block: {rootID: "r", id: "r"}, disabled: false},
        transaction: (operations) => {
            commits++;
            for (const operation of operations) writtenHtml.set(operation.id, operation.data);
        },
        updateTransactionElement: (element) => {
            commits++;
            writtenHtml.set(element.getAttribute("data-node-id"), element.outerHTML);
        },
    };
    editors = [protyle];
    const html = '<div data-node-id="b" data-type="NodeParagraph"><div contenteditable="true">foo</div></div>';
    const committedDomApi = async (_url, body) => ({
        code: 0,
        data: Object.fromEntries(body.ids.map(id => [id, writtenHtml.get(id) ?? html])),
    });
    api = committedDomApi;
    function liveMatches() {
        const live = blocks.collectSearchableBlocks(edit, {includeDocTitle: false});
        return matcher.matchTextUnitsDetailed(
            live.map((block) => ({...block, segmentLengths: block.textNodes.map((node) => node.length)})),
            "foo",
        ).hits;
    }
    const expand = source("shared/regex-replace").expandRegexReplacementUnits;
    for (const all of [false, true]) {
        for (const change of ["readonly", "text", "root", "node", "query", "none"]) {
            wysiwyg.innerHTML = html;
            protyle.protyle.disabled = false;
            protyle.protyle.block.rootID = "r";
            const before = commits;
            const matches = liveMatches();
            assert.equal(matches.length, 1);
            const options = {
                isCurrent: () => !queryChanged,
                regex: true,
                searchQuery: "foo",
                regexMatcher: {
                    expandReplacements: async (requests, pattern, template, options) => {
                        await Promise.resolve();
                        if (change === "readonly") protyle.protyle.disabled = true;
                        if (change === "text") {
                            wysiwyg.querySelector('[contenteditable="true"]').textContent = "new edit foo";
                        }
                        if (change === "root") protyle.protyle.block.rootID = "other";
                        if (change === "node") wysiwyg.innerHTML = html;
                        if (change === "query") queryChanged = true;
                        return {expansions: expand(requests, pattern, template, options), error: ""};
                    },
                },
            };
            let queryChanged = false;
            const result = all ?
                await write.replaceAllMatchesInEditor(edit, matches, "bar", options) :
                await write.replaceCurrentMatchInEditor(edit, matches[0], "bar", options);
            assert.equal(commits - before, change === "none" ? 1 : 0, "write guard " + change + "/" + all);
            assert.equal(result.replacedCount, change === "none" ? 1 : 0);
            if (change === "text") assert.ok(wysiwyg.textContent.includes("new edit foo"));
        }
    }
    protyle.protyle.disabled = false;
    protyle.protyle.block.rootID = "r";
    for (const changed of [false, true]) {
        wysiwyg.innerHTML = html;
        const matches = liveMatches();
        wysiwyg.innerHTML = "";
        let reads = 0;
        const before = commits;
        api = async (url) => {
            if (url.includes("getBlockDOMs")) {
                return {
                    code: 0,
                    data: {
                        b: commits > before ?
                            writtenHtml.get("b") :
                            changed && ++reads > 1 ?
                            html.replace("foo", "new foo") :
                            html,
                    },
                };
            }
            if (url.includes("sql")) return {code: 0, data: [{id: "b", hash: commits === before ? "before" : "after"}]};
            return {code: 0, data: []};
        };
        const result = await write.replaceAllMatchesInEditor(edit, matches, "bar");
        assert.equal(result.replacedCount, changed ? 0 : 1, "fetched kernel snapshot checked before transaction");
        assert.equal(commits - before, changed ? 0 : 1);
    }
    console.log("P2 single/all write guards, readonly, root/node identity, edits and fetched snapshot OK");
    api = committedDomApi;

    const {SearchBar} = source("frontend/search-bar");
    function searchBarFixture(reset = true) {
        if (reset) wysiwyg.innerHTML = html;
        const bar = Object.create(SearchBar.prototype);
        Object.assign(bar, {
            edit,
            plugin: {isLastHighlightComponent: () => false},
            searchText: "foo",
            replaceText: "zap",
            resultCount: 1,
            resultIndex: 1,
            resultMatches: liveMatches(),
            resultSelectionScope: null,
            searchGeneration: 1,
            resultSearchGeneration: 1,
            domEpoch: 0,
            resultDomEpoch: 0,
            documentEpoch: 0,
            resultDocumentEpoch: 0,
            restrictInlineTypes: [],
            replaceBusy: false,
            searchCoverageIncomplete: false,
            replaceBtn: document.createElement("button"),
            replaceAllBtn: document.createElement("button"),
            i18n: {
                replaceAllConfirm: "{count}",
                replaceAllConfirmTitle: "replace",
                replaceAllResult: "{replacedCount}",
            },
            documentSearchIndices: {clear: () => {}},
            syncIndexingIndicator: () => {},
            highlightHitResult: async () => {},
            clearHighlight: () => {},
            updateCountLabel: () => {},
            scrollIntoRanges: () => {},
        });
        bar.resultSearchKey = bar.searchResultKey();
        return bar;
    }
    const writableMatch = searchBarFixture().resultMatches[0];
    const nonWritableMatches = [
        {...writableMatch, id: "title", blockId: "__doc-title__", blockType: "doc-title", replaceable: true},
        {...writableMatch, id: "av", blockId: "av", blockType: "NodeAttributeView", replaceable: true},
        {...writableMatch, id: "preview", blockId: "__preview__", replaceable: true},
        {...writableMatch, id: "math", blockId: "math", blockType: "NodeMathBlock", replaceable: false},
        {...writableMatch, id: "rich", blockId: "rich", replaceable: false, replaceLock: "table-rich"},
        {...writableMatch, id: "editing", blockId: "editing", replaceable: false, replaceLock: "table-cell-editor"},
        {...writableMatch, id: "embed", blockId: "embed", unitId: "embed:source", replaceable: true},
        {...writableMatch, id: "complex", blockId: "complex", replaceable: false},
    ];
    const mixedMatches = [writableMatch, ...nonWritableMatches];
    assert.equal(write.countWritableMatches(edit, mixedMatches), 1);
    assert.equal(write.isMatchWritable(edit, mixedMatches.find(match => match.id === "embed")), false,
        "embedded matches stay unwritable even if an upstream path marks them replaceable");
    assert.equal(
        write.countWritableMatches(edit, mixedMatches),
        mixedMatches.filter(match => write.isMatchWritable(edit, match)).length,
        "confirmation and writer share the content eligibility policy",
    );
    assert.equal(
        write.countWritableMatches(edit, [{...writableMatch, range: undefined}]),
        1,
        "unloaded/folded matches remain eligible without a live Range",
    );
    const beforeCountReads = editorReads;
    assert.equal(write.countWritableMatches(edit, new Array(20000).fill(writableMatch)), 20000);
    assert.equal(editorReads - beforeCountReads, 1, "counting checks editor mode once, not once per match");
    protyle.protyle.disabled = true;
    assert.equal(write.countWritableMatches(edit, mixedMatches), 0, "readonly mode has no writable matches");
    protyle.protyle.disabled = false;

    for (const language of ["zh-CN", "en"]) {
        const text = JSON.parse(fs.readFileSync(path.join(repo, "src/i18n", language + ".json"), "utf8"));
        for (const scope of ["document", "focus", "selection"]) {
            const bar = searchBarFixture();
            bar.i18n = text;
            bar.resultMatches = mixedMatches;
            bar.resultCount = mixedMatches.length;
            protyle.protyle.block.id = scope === "focus" ? "b" : "r";
            protyle.protyle.block.showAll = scope === "focus";
            if (scope === "selection") {
                bar.selectionOnly = true;
                bar.rememberedSelectionScope = new Map();
                bar.resultSelectionScope = bar.rememberedSelectionScope;
                bar.resultSearchKey = bar.searchResultKey();
            }
            let confirmation;
            confirmAction = (_yes, no, message, title) => {
                confirmation = {message, title};
                no();
            };
            const before = commits;
            const previousApi = api;
            api = () => {
                throw new Error("confirmation must not fetch or prepare replacement DOM");
            };
            try {
                await bar.clickReplaceAll();
            } finally {
                api = previousApi;
                protyle.protyle.block.id = "r";
                protyle.protyle.block.showAll = false;
            }
            const scopeText = text["replaceAllScope" + scope[0].toUpperCase() + scope.slice(1)];
            assert.deepEqual(confirmation, {
                title: text.replaceAllConfirmTitle,
                message: text.replaceAllConfirm
                    .replace("{scope}", scopeText)
                    .replace("{matchCount}", "9")
                    .replace("{count}", "1")
                    .replace("{skippedCount}", "8"),
            }, "localized confirmation describes the actual eligible count and scope");
            assert.equal(commits, before, "cancelled confirmation does not write");
        }
    }
    const unsupportedAll = searchBarFixture();
    unsupportedAll.resultMatches = nonWritableMatches;
    unsupportedAll.resultCount = nonWritableMatches.length;
    unsupportedAll.syncReplaceButtons();
    assert.equal(unsupportedAll.replaceAllBtn.getAttribute("aria-disabled"), "true");
    confirmAction = () => {
        throw new Error("zero eligible matches must not open a confirmation");
    };
    const beforeUnsupportedAll = commits;
    await unsupportedAll.clickReplaceAll();
    assert.equal(commits, beforeUnsupportedAll);
    confirmAction = (yes) => yes();
    const mixedAll = searchBarFixture();
    mixedAll.resultMatches = [mixedAll.resultMatches[0], ...nonWritableMatches];
    mixedAll.resultCount = mixedAll.resultMatches.length;
    const beforeMixedAll = commits;
    await mixedAll.clickReplaceAll();
    assert.equal(commits - beforeMixedAll, 1, "mixed results keep the existing single transaction behavior");
    assert.match(writtenHtml.get("b"), /zap/);
    assert.equal(writtenHtml.has("av"), false, "unsupported results never enter the transaction");
    console.log("P2 replacement confirmation: writable/skip counts, scopes, locales and one mode check OK");
    for (const all of [false, true]) {
        for (const change of ["input", "option", "root", "generation"]) {
            const bar = searchBarFixture();
            const before = commits;
            if (change === "input") bar.setSearchText("different");
            if (change === "option") bar.wholeWord = true;
            if (change === "root") protyle.protyle.block.rootID = "other";
            if (change === "generation") bar.searchGeneration++;
            bar.syncReplaceButtons();
            assert.equal(bar.replaceBtn.getAttribute("aria-disabled"), "true");
            await (all ? bar.clickReplaceAll() : bar.clickReplace());
            assert.equal(commits, before, "stale SearchBar results never write: " + change);
            protyle.protyle.block.rootID = "r";
        }
    }
    const confirming = searchBarFixture();
    const beforeConfirmation = commits;
    confirmAction = (yes) => {
        confirming.setSearchText("different");
        yes();
    };
    await confirming.clickReplaceAll();
    assert.equal(commits, beforeConfirmation, "query changes in confirmation cancel all replacement");
    for (const change of ["same-block", "new-block", "source-attribute", "savedoc"]) {
        const staleAll = searchBarFixture();
        const before = commits;
        let refreshed = 0;
        staleAll.highlightHitResult = async () => {
            refreshed++;
        };
        const stop = source("frontend/editor-dom-watch").watchEditorDom(edit, {
            onMutate: () => {
                staleAll.domEpoch++;
            },
            onSettled: () => {},
        }, 120);
        confirmAction = (yes) => {
            if (change === "same-block") wysiwyg.querySelector('[contenteditable="true"]').append(" foo");
            if (change === "new-block") wysiwyg.insertAdjacentHTML("beforeend", html.replaceAll('"b"', '"new"'));
            if (change === "source-attribute") {
                wysiwyg.firstElementChild.setAttribute("data-inline-memo-content", "foo foo");
            }
            if (change === "savedoc") staleAll.onEventBus({detail: {cmd: "savedoc"}});
            Promise.resolve().then(yes);
        };
        await staleAll.clickReplaceAll();
        stop();
        window.clearTimeout(staleAll.typingTimer);
        assert.equal(commits, before, "changed complete snapshot is rejected: " + change);
        assert.equal(refreshed, 1, "stale snapshot requests refresh");
    }
    const recoverableAll = searchBarFixture();
    let recoverableRefreshes = 0;
    recoverableAll.highlightHitResult = async () => {
        recoverableRefreshes++;
        recoverableAll.searchGeneration++;
        recoverableAll.resultSearchGeneration = recoverableAll.searchGeneration;
        recoverableAll.resultDomEpoch = recoverableAll.domEpoch;
        recoverableAll.resultDocumentEpoch = recoverableAll.documentEpoch;
    };
    const beforeRecoverable = commits;
    confirmAction = (yes) => {
        // A delayed savedoc for the edit made before opening the dialog.
        recoverableAll.documentEpoch++;
        yes();
    };
    await recoverableAll.clickReplaceAll();
    assert.equal(recoverableRefreshes, 2, "delayed savedoc refreshes before writing and once after");
    assert.equal(commits - beforeRecoverable, 1, "delayed savedoc does not reject an otherwise stable replacement");
    const interruptedRecovery = searchBarFixture();
    let interruptedRefreshes = 0;
    interruptedRecovery.highlightHitResult = async () => {
        interruptedRefreshes++;
        if (interruptedRefreshes === 1) {
            // The v3.8.7 index commit arrives while the recovery search is reading.
            interruptedRecovery.documentEpoch++;
            return;
        }
        interruptedRecovery.searchGeneration++;
        interruptedRecovery.resultSearchGeneration = interruptedRecovery.searchGeneration;
        interruptedRecovery.resultDomEpoch = interruptedRecovery.domEpoch;
        interruptedRecovery.resultDocumentEpoch = interruptedRecovery.documentEpoch;
    };
    const beforeInterrupted = commits;
    confirmAction = (yes) => {
        interruptedRecovery.documentEpoch++;
        yes();
    };
    await interruptedRecovery.clickReplaceAll();
    assert.equal(interruptedRefreshes, 3, "an index event during recovery gets one bounded retry plus the final refresh");
    assert.equal(commits - beforeInterrupted, 1, "recovery retry writes only after a stable snapshot");
    confirmAction = (yes) => yes();
    const renderedBeforeAll = searchBarFixture();
    renderedBeforeAll.domEpoch++;
    let beforeAllRefreshes = 0;
    renderedBeforeAll.highlightHitResult = async () => {
        beforeAllRefreshes++;
        renderedBeforeAll.resultDomEpoch = renderedBeforeAll.domEpoch;
    };
    const beforeRenderedAll = commits;
    await renderedBeforeAll.clickReplaceAll();
    assert.equal(beforeAllRefreshes, 2, "one preparation refresh plus the normal post-write refresh");
    assert.equal(commits - beforeRenderedAll, 1, "stable refreshed snapshot remains replaceable");
    const partialBar = searchBarFixture();
    partialBar.searchCoverageIncomplete = true;
    const beforeSingle = commits;
    partialBar.syncReplaceButtons();
    assert.equal(partialBar.replaceBtn.getAttribute("aria-disabled"), "false");
    assert.equal(partialBar.replaceAllBtn.getAttribute("aria-disabled"), "true");
    await partialBar.clickReplace();
    assert.equal(commits - beforeSingle, 1, "valid single remains writable under unrelated partial coverage");
    console.log("P2 actual SearchBar debounce/options/root/confirmation gates and partial single replacement OK");
    const selectionBar = searchBarFixture();
    const selectionRefs = Array.from({length: 33}, (_, i) => ref("sele-b" + i, "sele-av" + i));
    const beforeSelectionApi = api;
    api = async (url) => ({code: 0, data: url.endsWith("getAttributeView") ? raw : {view: view([row("i")])}});
    av.pinAvCache("r", selectionRefs, new Map(), edit);
    await av.loadAvUnits(selectionRefs);
    assert.equal(av.peekAvUnits(selectionRefs).missing.length, 0);
    api = beforeSelectionApi;
    selectionBar.selectionOnly = true;
    selectionBar.searchesInFlight = 0;
    selectionBar.syncBackgroundCorpusRoot = () => "r";
    selectionBar.documentSearchIndices.activeRoot = "r";
    selectionBar.documentSearchIndices.consumePending = () => null;
    selectionBar.noteSearchCoverage = () => {};
    selectionBar.runSearchPipeline = () => {
        selectionBar.rememberedSelectionScope = new Map([["b", [{start: 0, end: 3}]]]);
        return Promise.resolve({matches: liveMatches(), error: ""});
    };
    assert.equal(
        (await selectionBar.calculateSearchResults("foo", false)).length,
        1,
        "newly captured selection is accepted",
    );
    assert.equal(selectionBar.hasCurrentSearchResults(), true);
    assert.ok(av.peekAvUnits(selectionRefs).missing.length > 0, "selection-only releases full-document AV pins");
    av.invalidateAvCache();

    const locating = searchBarFixture();
    locating.plugin.app = {};
    const locateModule = source("frontend/corpus/locate");
    const originalOpen = locateModule.openBlockInEditor;
    locateModule.openBlockInEditor = (_app, _id, done) => done();
    locating.highlightHitResult = async () => {
        locating.resultMatches = [];
        locating.resultCount = 0;
    };
    locating.pauseIndexReset = () => {};
    const beforeLocate = commits;
    try {
        await locating.clickReplace();
        assert.equal(commits, beforeLocate, "missing target after async locate never falls back to old match");
    } finally {
        locateModule.openBlockInEditor = originalOpen;
    }
    for (const all of [false, true]) {
        const preparing = searchBarFixture();
        preparing.regex = true;
        preparing.resultSearchKey = preparing.searchResultKey();
        preparing.regexMatcher = {
            expandReplacements: async (requests, pattern, template, options) => {
                preparing.setSearchText("different");
                return {expansions: expand(requests, pattern, template, options), error: ""};
            },
        };
        const before = commits;
        await (all ? preparing.clickReplaceAll() : preparing.clickReplace());
        assert.equal(commits, before, "actual SearchBar cancels query changed during write preparation");
        assert.equal(wysiwyg.textContent, "foo");
    }

    wysiwyg.innerHTML = html + html.replaceAll('"b"', '"c"');
    const content = edit.querySelector(".protyle-content");
    content.getBoundingClientRect = () => ({top: 0, bottom: 300, width: 600, height: 300});
    const a = wysiwyg.children[0];
    const b = wysiwyg.children[1];
    let scroll = false;
    a.getBoundingClientRect = a.firstElementChild.getBoundingClientRect = () => ({
        top: scroll ? -1000 : 20,
        bottom: scroll ? -980 : 40,
        width: 100,
        height: 20,
    });
    b.getBoundingClientRect = b.firstElementChild.getBoundingClientRect = () => ({
        top: scroll ? 20 : 1000,
        bottom: scroll ? 40 : 1020,
        width: 100,
        height: 20,
    });
    let projected = project.projectRanges(
        edit,
        liveMatches(),
        {},
        blocks.collectSearchableBlocks(edit, {includeDocTitle: false}),
    );
    assert.equal(projected.length, 2);
    assert.equal(projected.filter((match) => match.range).length, 1);
    scroll = true;
    projected = project.refreshViewportRanges(edit, projected);
    assert.equal(projected.length, 2);
    assert.equal(projected.filter((match) => match.range).length, 1);
    assert.equal(projected.find((match) => match.range).blockId, "c");
    assert.equal(project.refreshViewportRanges(edit, projected), projected, "unchanged scroll does not rebuild ranges");
    const replacement = b.cloneNode(true);
    b.replaceWith(replacement);
    replacement.getBoundingClientRect = replacement.firstElementChild.getBoundingClientRect = () => ({
        top: scroll ? 20 : 1000,
        bottom: scroll ? 40 : 1020,
        width: 100,
        height: 20,
    });
    projected = project.projectLiveRanges(
        edit,
        projected,
        blocks.collectSearchableBlocks(edit, {
            includeDocTitle: false,
            scopeRoots: [replacement],
        }),
        false,
    );
    assert.equal(projected.find((match) => match.blockId === "c").range.startContainer.isConnected, true);
    scroll = false;
    projected = project.refreshViewportRanges(edit, projected);
    assert.equal(projected.find((match) => match.blockId === "c").range, undefined);
    scroll = true;
    projected = project.refreshViewportRanges(edit, projected);
    assert.equal(
        projected.find((match) => match.blockId === "c").range.startContainer.parentElement,
        replacement.firstElementChild,
    );
    project.clearViewportProjection(edit);
    console.log("P2 viewport count preservation, scroll fill, DOM rebind and range release OK");

    wysiwyg.innerHTML = '<div data-node-id="e" data-type="NodeBlockQueryEmbed">' + html +
        html.replaceAll('"b"', '"c"') + "</div>";
    const embedded = blocks.collectSearchableBlocks(edit, {includeDocTitle: false});
    const embedHits = matcher.matchTextUnitsDetailed(
        embedded.map((block) => ({...block, segmentLengths: block.textNodes.map((node) => node.length)})),
        "foo",
    ).hits;
    let embedProjected = project.projectRanges(edit, embedHits, {}, embedded);
    assert.equal(embedProjected.filter((match) => match.range).length, 2);
    embedProjected = project.projectLiveRanges(
        edit,
        embedProjected,
        blocks.collectSearchableBlocks(edit, {
            includeDocTitle: false,
            scopeRoots: [wysiwyg.querySelector('[data-node-id="b"]')],
        }),
        false,
    );
    assert.equal(
        embedProjected.filter((match) => match.range).length,
        2,
        "partial embedded unit rebind preserves counterpart",
    );
    project.clearViewportProjection(edit);

    wysiwyg.innerHTML = html;
    const tall = wysiwyg.firstElementChild;
    tall.firstElementChild.textContent = "foo ".repeat(4000);
    let top = 1000;
    tall.getBoundingClientRect = tall.firstElementChild.getBoundingClientRect = () => ({
        top,
        bottom: top + 10000,
        width: 100,
        height: 10000,
    });
    let dense = project.projectRanges(
        edit,
        liveMatches(),
        {},
        blocks.collectSearchableBlocks(edit, {includeDocTitle: false}),
    );
    assert.equal(dense.filter((match) => match.range).length, 0);
    top = 20;
    const viewportPerformance = global.performance;
    let viewportElapsed = 0;
    global.performance = {now: () => ++viewportElapsed};
    let scrollTimer = false;
    setTimeout(() => {
        scrollTimer = true;
    }, 0);
    dense = await project.refreshViewportRangesWithBudget(edit, dense, new AbortController().signal);
    assert.equal(scrollTimer, true, "one tall unit yields while projecting dense hits");
    assert.equal(dense.filter((match) => match.range).length, 4000);
    global.performance = viewportPerformance;
    const highlighted = searchBarFixture(false);
    highlighted.resultMatches = dense;
    highlighted.plugin = {updateLastHighlightComponent: () => {}};
    highlighted.syncMemoUnderlineVisual = highlighted.applyFocusHighlight = highlighted.clearSearchFocus = () => {};
    CSS.highlights = new Map();
    window.Highlight = Set;
    const highlightPerformance = global.performance;
    let highlightElapsed = 0;
    global.performance = {now: () => ++highlightElapsed * 10};
    let paintTimer = false;
    setTimeout(() => {
        paintTimer = true;
    }, 0);
    assert.equal(await highlighted.applyResultHighlightsWithBudget(dense), true);
    assert.equal(paintTimer, true, "dense Highlight construction yields");
    const highlightedResultsName = highlighted.getComponentHighlights().resultsName;
    assert.equal(CSS.highlights.get(highlightedResultsName).size, 4000);
    const committedHighlight = CSS.highlights.get(highlightedResultsName);
    const stalePaint = highlighted.applyResultHighlightsWithBudget(dense);
    highlighted.searchGeneration++;
    assert.equal(await stalePaint, false);
    assert.equal(
        CSS.highlights.get(highlightedResultsName),
        committedHighlight,
        "cancelled highlight never publishes partial set",
    );
    highlighted.searchGeneration--;
    highlighted.plugin.isLastHighlightComponent = () => true;
    highlighted.pendingAddedBlocks = new Set();
    highlighted.searchesInFlight = 0;
    highlighted.domEpoch = 0;
    highlighted.teardownMemoUnderlineLayoutSync = () => {};
    highlighted.calculateSearchResults = async () => highlighted.resultMatches;
    delete highlighted.clearHighlight;
    const unrelated = document.createElement("div");
    unrelated.dataset.nodeId = "other";
    unrelated.dataset.type = "NodeParagraph";
    wysiwyg.append(unrelated);
    let settledRepair;
    const stopPaintWatch = source("frontend/editor-dom-watch").watchEditorDom(edit, {
        onMutate: () => {
            highlighted.domEpoch++;
            highlighted.repairRangeAbort?.abort();
        },
        onSettled: change => {
            highlighted.noteAddedBlocks(change);
            settledRepair = highlighted.repairHighlightRanges();
        },
    }, 1);
    setTimeout(() => {
        unrelated.textContent = "rendered";
    }, 0);
    await SearchBar.prototype.highlightHitResult.call(highlighted, "foo", false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(settledRepair, "host DOM completion reaches settled repair");
    await settledRepair;
    stopPaintWatch();
    assert.equal(
        CSS.highlights.get(highlightedResultsName).size,
        4000,
        "cancelled initial paint is restored even with valid ranges",
    );
    let ownsHighlight = true;
    highlighted.plugin.updateLastHighlightComponent = () => {
        ownsHighlight = true;
    };
    highlighted.plugin.isLastHighlightComponent = () => ownsHighlight;
    setTimeout(() => {
        ownsHighlight = false;
    }, 0);
    await SearchBar.prototype.highlightHitResult.call(highlighted, "foo", false);
    assert.equal(
        CSS.highlights.get(highlightedResultsName).size,
        4000,
        "staged initial paint completes its own component when another pane becomes active",
    );
    assert.equal(ownsHighlight, false, "cancelled painting preserves the new highlight owner");
    highlighted.plugin.updateLastHighlightComponent = () => {};
    highlighted.plugin.isLastHighlightComponent = () => true;

    const replacementContent = tall.firstElementChild.cloneNode(true);
    tall.firstElementChild.replaceWith(replacementContent);
    replacementContent.getBoundingClientRect = tall.getBoundingClientRect;
    highlighted.pendingAddedBlocks = new Set(["b"]);
    let localTimer = false;
    setTimeout(() => {
        localTimer = true;
    }, 0);
    let localRangeCount = 0;
    const createRange = document.createRange.bind(document);
    document.createRange = () => {
        localRangeCount++;
        return createRange();
    };
    await highlighted.repairHighlightRanges();
    document.createRange = createRange;
    assert.equal(localTimer, true, "dense local DOM repair yields to input/timers");
    assert.equal(highlighted.resultMatches.filter((match) => match.range?.startContainer.isConnected).length, 4000);
    assert.equal(localRangeCount, 4000, "local reprojection reuses exactly bound ranges");
    highlighted.resultMatches = highlighted.resultMatches.map((match) => ({...match, range: undefined}));
    let navigationRangeCount = 0;
    document.createRange = () => {
        navigationRangeCount++;
        return createRange();
    };
    assert.equal(highlighted.tryBindUnfoldedMatch(1, true), true);
    document.createRange = createRange;
    assert.equal(navigationRangeCount, 1, "first navigation binds only the current dense-block occurrence");
    highlighted.resultMatches = highlighted.resultMatches.map((match) => ({...match, range: undefined}));
    highlighted.pendingAddedBlocks = new Set(["b"]);
    const cancelledRepair = highlighted.repairHighlightRanges();
    highlighted.domEpoch++;
    highlighted.repairRangeAbort.abort();
    await cancelledRepair;
    assert.equal(
        highlighted.resultMatches.some((match) => match.range),
        false,
        "cancelled local repair never publishes partial ranges",
    );
    assert.ok(highlighted.pendingAddedBlocks.has("b"), "cancelled repair restores unbound block IDs");
    const supersededRepair = highlighted.repairHighlightRanges();
    const takeoverRepair = highlighted.repairHighlightRanges();
    await Promise.all([supersededRepair, takeoverRepair]);
    assert.equal(
        highlighted.resultMatches.filter((match) => match.range).length,
        4000,
        "new repair takes over the previous pending scope",
    );
    assert.equal(
        highlighted.pendingAddedBlocks.size,
        0,
        "late cancelled finally cannot reinsert already consumed scope",
    );
    highlighted.resultMatches = highlighted.resultMatches.map((match) => ({...match, range: undefined}));
    highlighted.pendingAddedBlocks = new Set(["b"]);
    const oldQueryRepair = highlighted.repairHighlightRanges();
    highlighted.searchGeneration++;
    highlighted.resultMatches = highlighted.resultMatches.slice();
    highlighted.pendingAddedBlocks = new Set(["other"]);
    const newQueryRepair = highlighted.repairHighlightRanges();
    await Promise.all([oldQueryRepair, newQueryRepair]);
    assert.equal(
        highlighted.resultMatches.some((match) => match.range),
        false,
        "new query does not inherit the old repair scope",
    );
    assert.equal(highlighted.pendingAddedBlocks.size, 0, "old query cannot restore stale pending scope");
    highlighted.pendingAddedBlocks = new Set(["b"]);
    await highlighted.repairHighlightRanges();
    const stableNavigationMatch = highlighted.resultMatches[0];
    assert.equal(highlighted.tryBindUnfoldedMatch(1, true), true);
    assert.equal(
        highlighted.resultMatches[0],
        stableNavigationMatch,
        "already bound navigation preserves match identity",
    );

    highlighted.resultMatches = highlighted.resultMatches.map((match, index) =>
        index ? match : {...match, range: undefined}
    );
    const navigatedPaint = highlighted.applyResultHighlightsWithBudget(highlighted.resultMatches);
    assert.equal(highlighted.tryBindUnfoldedMatch(1, true), true);
    assert.equal(
        await navigatedPaint,
        false,
        "navigation cannot let a staged old highlight drop the newly bound range",
    );
    await highlighted.repairHighlightRanges();
    assert.equal(CSS.highlights.get(highlightedResultsName).size, 4000, "navigation recovery retains every highlight");

    highlighted.resultMatches = highlighted.resultMatches.map((match) => ({...match, range: undefined}));
    highlighted.pendingAddedBlocks = new Set(["b"]);
    const repairJobs = [];
    const repairMethod = highlighted.repairHighlightRanges;
    highlighted.repairHighlightRanges = () => {
        const job = repairMethod.call(highlighted);
        repairJobs.push(job);
        return job;
    };
    const interleavedRepair = highlighted.repairHighlightRanges();
    // 模拟滚动投影在局部修复分片期间接受同一查询的新结果数组。
    highlighted.resultMatches = highlighted.resultMatches.slice();
    await interleavedRepair;
    assert.equal(
        repairJobs.length,
        2,
        "accepted viewport results restart interrupted local repair without another DOM event",
    );
    await repairJobs[1];
    delete highlighted.repairHighlightRanges;
    assert.equal(highlighted.resultMatches.filter((match) => match.range).length, 4000);
    assert.equal(highlighted.pendingAddedBlocks.size, 0, "viewport/repair interleaving consumes the pending scope");
    dense = highlighted.resultMatches;
    console.log("P2 cancelled initial paint recovery and dense local repair budgeting/reuse OK");
    global.performance = highlightPerformance;
    delete CSS.highlights;
    delete window.Highlight;
    top = 1000;
    const scrollAbort = new AbortController();
    const scrollPerformance = global.performance;
    let scrollElapsed = 0;
    global.performance = {now: () => ++scrollElapsed};
    const stoppedScroll = project.refreshViewportRangesWithBudget(edit, dense, scrollAbort.signal);
    scrollAbort.abort();
    assert.equal((await stoppedScroll) === dense, true, "cancelled scroll keeps original ranges and shown states");
    global.performance = scrollPerformance;
    dense = await project.refreshViewportRangesWithBudget(edit, dense, new AbortController().signal);
    assert.equal(dense.filter((match) => match.range).length, 0);
    top = 20;
    const discarded = await project.prepareViewportRangesWithBudget(edit, dense, new AbortController().signal);
    assert.equal(discarded.matches.filter((match) => match.range).length, 4000);
    const accepted = await project.prepareViewportRangesWithBudget(edit, dense, new AbortController().signal);
    assert.equal(
        accepted.matches.filter((match) => match.range).length,
        4000,
        "discarded preparation does not advance shown state",
    );
    assert.equal(accepted.commit(), true);
    assert.equal(discarded.commit(), false, "older projection transaction cannot commit after newer acceptance");
    dense = accepted.matches;
    project.clearViewportProjection(edit);
    console.log("P2 partial embed mapping, tall unit scroll budgeting and cancellation OK");
    const memoHost = document.createElement("span");
    memoHost.setAttribute("data-type", "inline-memo");
    tall.firstElementChild.append(memoHost);
    const memoMatch = {
        id: "memo",
        blockId: "b",
        unitId: "inline-memo:99",
        highlightKind: "inline-memo",
        anchorOffset: 5,
        start: 0,
        end: 3,
        matchedText: "foo",
    };
    const memoBlock = {
        blockId: "b",
        unitId: "inline-memo:0",
        anchorOffset: 5,
        text: "foo",
        textNodes: [],
        element: memoHost,
    };
    assert.equal(
        project.fillLiveRanges([memoMatch], [memoBlock], false)[0].range.startContainer,
        memoHost,
        "one-match navigation preserves memo anchor identity despite local numbering",
    );

    const {RegexTextMatcher} = source("frontend/regex-matcher");
    global.Worker = class {
        constructor() {
            throw new Error("literal matching must not start Worker");
        }
    };
    const input = Array.from(
        {length: 2200},
        (_, i) => ({
            blockId: "b" + i,
            blockType: "NodeParagraph",
            blockIndex: i,
            text: "İx a\u200Bb",
            segmentLengths: [7],
        }),
    );
    const asyncMatcher = new RegexTextMatcher();
    for (const query of ["a b", "\u0307x", "x"]) {
        const options = {dedupeOverlaps: false};
        const expected = matcher.matchTextUnitsDetailed(input, query, options);
        assert.deepEqual(
            await asyncMatcher.match(input, query, options),
            expected,
            "large literal chunks have identical semantics",
        );
    }
    // Deterministic elapsed time forces a pending slice; wall-clock speed is not a cancellation contract.
    const realPerformance = global.performance;
    let elapsed = 0;
    global.performance = {now: () => ++elapsed};
    try {
        const abort = new AbortController();
        const pending = asyncMatcher.match(input, "x", {}, abort.signal);
        abort.abort();
        assert.equal((await pending).cancelled, true);
        assert.equal((await asyncMatcher.match(input.slice(0, 1), "x", {}, abort.signal)).cancelled, true);
        const superseded = asyncMatcher.match(input, "x", {});
        await asyncMatcher.match(input.slice(0, 1), "x", {});
        assert.equal((await superseded).cancelled, true);
        const disposed = asyncMatcher.match(input, "x", {});
        asyncMatcher.dispose();
        assert.equal((await disposed).cancelled, true);
    } finally {
        global.performance = realPerformance;
    }
    global.Worker = undefined;
    console.log("P2 large literal chunk parity, abort, new-query and dispose cancellation OK");

    const giant = [{
        blockId: "giant",
        blockType: "NodeParagraph",
        blockIndex: 0,
        text: "a ".repeat(150000),
        segmentLengths: [300000],
    }];
    let literalTimer = false;
    setTimeout(() => {
        literalTimer = true;
    }, 0);
    const giantResult = await asyncMatcher.match(giant, "a", {});
    assert.equal(literalTimer, true, "single giant literal unit yields before finishing");
    assert.deepEqual(giantResult, matcher.matchTextUnitsDetailed(giant, "a", {}));
    const boundaries = [{...giant[0], text: "Σ" + "Α".repeat(65535) + "Σ İx a\u200Bb ".repeat(24000)}];
    for (const query of ["ΑΣ", "\u0307x", "a b", "Σ", "x"]) {
        for (const wholeWord of [false, true]) {
            const options = {wholeWord, dedupeOverlaps: true};
            assert.deepEqual(
                await asyncMatcher.match(boundaries, query, options),
                matcher.matchTextUnitsDetailed(boundaries, query, options),
            );
        }
    }
    const giantAbort = new AbortController();
    const cancelledGiant = asyncMatcher.match(giant, "a", {}, giantAbort.signal);
    giantAbort.abort();
    assert.equal((await cancelledGiant).cancelled, true);
    console.log("P2 single giant literal, window boundaries, Unicode/marker parity and cancellation OK");

    // Exercise retry and render-setting invalidation through the actual corpus pipeline.
    corpus.invalidateDocumentSearchCaches();
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (value, sensitive) => sensitive ? String(value) : String(value).toLowerCase());
    db.exec(
        "CREATE TABLE blocks(id TEXT, root_id TEXT, parent_id TEXT, type TEXT, subtype TEXT, content TEXT, markdown TEXT, ial TEXT, hash TEXT, updated TEXT)",
    );
    const add = db.prepare("INSERT INTO blocks VALUES (?, 'r', 'r', ?, '', ?, ?, '', 'hash', '1')");
    wysiwyg.innerHTML = "";
    const doms = {};
    let avFail = true;
    let rendersAfterFailure = 0;
    api = async (url, body) => {
        if (url.endsWith("sql")) return {code: 0, data: db.prepare(body.stmt).all()};
        if (url.endsWith("getDocBlocksOrders")) {
            return {
                code: 0,
                data: db.prepare("SELECT id FROM blocks ORDER BY id").all().map((item) => item.id),
            };
        }
        if (url.endsWith("getBlockDOMs")) {
            return {code: 0, data: Object.fromEntries(body.ids.map((id) => [id, doms[id]]))};
        }
        if (url.endsWith("getAttributeView")) return {code: 0, data: raw};
        if (url.endsWith("renderAttributeView")) {
            rendersAfterFailure++;
            return {code: 0, data: avFail && body.id === "broken" ? {} : {view: view([row("i", "findme")])}};
        }
        return {code: 0, data: []};
    };
    add.run("a", "av", '<div data-av-id="broken"></div>', '<div data-av-id="broken"></div>');
    add.run("b", "av", '<div data-av-id="healthy"></div>', '<div data-av-id="healthy"></div>');
    corpus.retainBackgroundCorpusRoot("r");
    const search = (query, options = {}) =>
        corpus.searchCurrentDocument({}, edit, query, {includeDocTitle: false, includeFoldedBlocks: true, ...options});
    const settled = async (query, options) => {
        let result = await search(query, options);
        for (let tries = 0; result.partial && tries < 30; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            result = await search(query, options);
        }
        assert.equal(result.partial, false);
        return result;
    };
    const failed = await settled("findme");
    assert.deepEqual(failed.incompleteBlockIds, ["a"]);
    assert.equal(failed.matches.length, 1, "healthy AV after failed carrier still completes");
    const healthy = {...ref("b", "healthy"), carrierViewId: ""};
    assert.equal(av.peekAvUnits([healthy]).missing.length, 0);
    const beforeRetry = rendersAfterFailure;
    avFail = false;
    corpus.retryIncompleteCorpus("r");
    const retried = await settled("findme");
    assert.equal(retried.matches.length, 2);
    assert.deepEqual(retried.incompleteBlockIds, []);
    assert.equal(rendersAfterFailure - beforeRetry, 1, "retry preserves healthy cache");
    corpus.releaseBackgroundCorpusRoot("r");
    corpus.invalidateDocumentSearchCaches();
    db.exec("DELETE FROM blocks");
    add.run("m", "m", "\\custom", "$$\\custom$$");
    doms.m =
        '<div data-node-id="m" data-type="NodeMathBlock" data-subtype="math" data-content="custom"><div></div></div>';
    let mathRenders = 0;
    window.siyuan = {config: {editor: {katexMacros: "old"}}};
    window.Protyle = {
        mathRender: (host) => {
            mathRenders++;
            host.querySelectorAll('[data-type="NodeMathBlock"]').forEach((element) => {
                element.innerHTML = '<span class="katex-html">' + window.siyuan.config.editor.katexMacros + "</span>";
                element.setAttribute("data-render", "true");
            });
        },
    };
    corpus.retainBackgroundCorpusRoot("r");
    assert.equal((await settled("old", {includeAttributeView: false})).matches.length, 1);
    const oldRenders = mathRenders;
    window.siyuan.config.editor.katexMacros = "new";
    assert.equal((await settled("new", {includeAttributeView: false})).matches.length, 1);
    assert.ok(mathRenders > oldRenders, "macro change invalidates unloaded rendered text");
    assert.equal((await settled("old", {includeAttributeView: false})).matches.length, 0);
    window.siyuan.config.editor.katexMacros = "X".repeat(820000);
    for (let index = 0; index < 8; index++) {
        await settled("no-match", {
            includeAttributeView: false,
            includeImageTitle: Boolean(index & 1),
            includeHeadingH1: Boolean(index & 2),
            includeHeadingH2: Boolean(index & 4),
        });
        assert.equal(corpus.auditSpecialCache().pins, 1, "only latest editor scope remains pinned");
    }
    assert.ok(corpus.auditSpecialCache().bytes <= 12 * 1024 * 1024, "obsolete scopes obey global budget");
    const otherEdit = edit.cloneNode(true);
    document.body.append(otherEdit);
    const otherProtyle = {protyle: {...protyle.protyle, element: otherEdit}};
    editors.push(otherProtyle);
    corpus.retainBackgroundCorpusRoot("r");
    await corpus.searchCurrentDocument({}, otherEdit, "no-match", {
        includeDocTitle: false,
        includeAttributeView: false,
        includeFoldedBlocks: true,
        includeImageTitle: false,
    });
    assert.equal(corpus.auditSpecialCache().pins, 2, "two panes keep distinct current scopes");
    corpus.releaseSpecialCacheOwner("r", edit);
    assert.equal(corpus.auditSpecialCache().pins, 1, "release one pane preserves other scope");
    corpus.releaseBackgroundCorpusRoot("r");
    corpus.releaseSpecialCacheOwner("r", otherEdit);
    assert.equal(corpus.auditSpecialCache().pins, 0);
    otherEdit.remove();
    editors.pop();
    corpus.releaseBackgroundCorpusRoot("r");
    db.close();
    console.log("P2 failed carrier isolation/retry and KaTeX settings invalidation OK");
    corpus.invalidateDocumentSearchCaches();
    dom.window.close();
    console.log("p2-regressions OK (mocked APIs/layout)");
}
main().catch((error) => {
    console.error(error);
    dom.window.close();
    process.exitCode = 1;
});
