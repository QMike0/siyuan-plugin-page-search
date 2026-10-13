// Direct-source fault injection; does not write a real notebook or exercise host keyboard history.
// Optional argument: the installed SiYuan lute.min.js, for native content normalization.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
let editors = [];
let api;
const messages = [];
const hiddenMessages = [];
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") {
        return {
            getAllEditor: () => editors,
            fetchSyncPost: (...args) => api(...args),
            confirm: (_title, _message, yes) => yes(),
            showMessage: (text, _timeout, type, id) => messages.push({text, type, id}),
            hideMessage: id => hiddenMessages.push(id),
        };
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    let code = fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"');
    if (file.endsWith("replacement-commit.ts")) {
        // Scale only the wait/backoff clock; keep production logic, batching and result checks.
        code = code.replace("COMMIT_WAIT_MS = 8000", "COMMIT_WAIT_MS = 300")
            .replace('notify(observer, "pending"), 500', 'notify(observer, "pending"), 30')
            .replace("let delay = 120", "let delay = 10")
            .replace("delay * 2, 1000", "delay * 2, 40");
    }
    mod._compile(
        ts.transpileModule(code, {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
            fileName: file,
        }).outputText,
        file,
    );
};
const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = dom.window;
global.document = window.document;
for (
    const key of [
        "Node",
        "Element",
        "HTMLElement",
        "HTMLImageElement",
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
global.CSS = {escape: value => value};
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() {
        return this.textContent;
    },
    configurable: true,
});
let lute;
if (process.argv[2]) {
    require(path.resolve(process.argv[2]));
    lute = (window.Lute ?? global.Lute).New();
    for (const name of ["SetTextMark", "SetBlockRef", "SetKramdownIAL", "SetProtyleWYSIWYG", "SetHTMLTag2TextMark"]) {
        lute[name](true);
    }
}
const source = file => require(path.join(repo, "src", file + ".ts"));
const write = source("frontend/protyle-write");
const commit = source("frontend/replacement-commit");
const blocks = source("frontend/blocks");
const matcher = source("shared/match-text");
const {SearchBar} = source("frontend/search-bar");
const corpus = source("frontend/corpus/search");
const id = "20261013120000-abcdefg";
const otherId = "20261013120000-hijklmn";
const referenceId = "20261012120000-opqrstu";
const paragraph = (blockId, text) =>
    `<div data-node-id="${blockId}" data-type="NodeParagraph"><div contenteditable="true">${text}</div><div class="protyle-attr"></div></div>`;
const reference = text => `<span data-type="strong block-ref" data-subtype="d" data-id="${referenceId}">${text}</span>`;
const normalize = html => lute ? lute.SpinBlockDOM(html) : html;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(contents = [paragraph(id, "foo")], mode = "success") {
    document.body.innerHTML =
        '<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"></div></div></div>';
    const edit = document.querySelector(".protyle");
    const wysiwyg = edit.querySelector(".protyle-wysiwyg");
    wysiwyg.innerHTML = contents.join("");
    const kernel = new Map(Array.from(wysiwyg.children, element => [element.dataset.nodeId, element.outerHTML]));
    const calls = [];
    const requests = [];
    let afterWriteReads = 0;
    let queued;
    const persist = operations => {
        for (const op of operations) kernel.set(op.id, normalize(op.data));
    };
    function submit(operations, undo) {
        calls.push({operations, undo});
        if (mode === "throw-before") throw new Error("synchronous queue rejection");
        for (const op of operations) {
            const lives = mode === "throw-after-all" ?
                wysiwyg.querySelectorAll(`[data-node-id="${op.id}"]`) :
                [wysiwyg.querySelector(`[data-node-id="${op.id}"]`)].filter(Boolean);
            for (const live of lives) live.outerHTML = normalize(op.data);
        }
        if (mode === "throw-after" || mode === "throw-after-all") throw new Error("native optimistic rendering failed");
        if (mode === "new-edit-then-throw") {
            wysiwyg.querySelector('[contenteditable="true"]').textContent = "new user edit";
            throw new Error("sync handler failed after a new edit");
        }
        queued = operations;
        if (mode === "success") persist(operations);
        if (mode === "partial") persist(operations.slice(0, 1));
    }
    const protyle = {
        protyle: {element: edit, notebookId: "", block: {rootID: "r", id: "r"}, disabled: false, lute},
        transaction: submit,
        updateTransactionElement: (element, before) =>
            submit(
                [{id: element.dataset.nodeId, action: "update", data: element.outerHTML}],
                [{id: element.dataset.nodeId, action: "update", data: before}],
            ),
    };
    editors = [protyle];
    api = async (url, body) => {
        requests.push({url, ids: body.ids});
        assert.ok(url.endsWith("getBlockDOMs"), "must not resend a failed write or poll hashes");
        if (queued) {
            afterWriteReads++;
            if (mode === "delayed" && afterWriteReads === 4) persist(queued);
            if (mode === "http-error") return {code: -1, msg: "request rejected"};
            if (mode === "network-error") throw new Error("HTTP disconnected");
            if (mode === "unrelated") kernel.set(id, paragraph(id, "someone else's edit"));
            if (mode === "missing") return {code: 0, data: {}};
        }
        return {code: 0, data: Object.fromEntries(body.ids.map(blockId => [blockId, kernel.get(blockId)]))};
    };
    const matches = matcher.matchTextUnitsDetailed(
        blocks.collectSearchableBlocks(edit, {includeDocTitle: false, includeInlineMemo: true, includeImageTitle: true})
            .map(unit => ({...unit, segmentLengths: unit.textNodes.map(node => node.length)})),
        "foo",
    ).hits;
    return {edit, wysiwyg, kernel, protyle, calls, requests, matches, persist: () => persist(queued)};
}
const run = (f, all, options = {}, text = "bar") =>
    all ?
        write.replaceAllMatchesInEditor(f.edit, f.matches, text, options) :
        write.replaceCurrentMatchInEditor(f.edit, f.matches[0], text, options);

function barFixture(f) {
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {
        edit: f.edit,
        plugin: {},
        searchText: "foo",
        replaceText: "bar",
        resultCount: f.matches.length,
        resultIndex: 1,
        resultMatches: f.matches,
        resultSearchKey: "key",
        resultSelectionScope: null,
        searchGeneration: 1,
        replaceBusy: false,
        destroyed: false,
        searchCoverageIncomplete: false,
        hasCurrentSearchResults: () => true,
        hasStableReplaceAllSnapshot: () => true,
        isRestrictEnumerateMode: () => false,
        getCurrentMatch: () => f.matches[0],
        highlightHitResult: async () => {},
        clearHighlight: () => {},
        updateCountLabel: () => {},
        scrollIntoRanges: () => {},
        scheduleDiagramRefresh: () => {},
        i18n: {
            replaceAllConfirm: "{count}",
            replaceAllConfirmTitle: "replace",
            replaceCurrentDone: "SUCCESS current",
            replaceAllResult: "SUCCESS all {replacedCount}",
            replaceCommitPending: "PENDING",
            replaceCommitUnknown: "UNKNOWN {replacedCount}/{submittedCount}",
            replaceCommitFailed: "FAILED",
        },
    });
    return bar;
}

function makeDestroyable(bar) {
    Object.assign(bar, {
        root: document.createElement("div"),
        regexMatcher: {dispose: () => {}},
        backgroundCorpusRootId: "r",
        plugin: {onSearchComponentUnmounted: () => {}},
        closeSettingsMenu: () => {},
        closeSearchMethodMenu: () => {},
        teardownSelectionScopeLayoutSync: () => {},
        teardownMemoUnderlineLayoutSync: () => {},
        clearSelectionScopeVisual: () => {},
        closeResultsPanel: () => {},
        clearDiagramSearchState: () => {},
    });
    document.body.append(bar.root);
    corpus.retainBackgroundCorpusRoot("r");
    return bar;
}

async function main() {
    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const f = fixture();
            if (fetched) f.wysiwyg.innerHTML = "";
            const result = await run(f, all);
            assert.equal(result.commitState, "confirmed");
            assert.equal(result.replacedCount, 1);
            assert.equal(f.calls.length, 1);
            assert.equal(f.requests.length, fetched ? 3 : 1);
            assert.ok(f.calls[0].undo[0].data.includes("foo"), "native undo payload preserved");
            const noop = fixture();
            if (fetched) noop.wysiwyg.innerHTML = "";
            assert.equal((await run(noop, all, {}, "foo")).commitState, "confirmed");
            assert.equal(noop.calls.length, 0, "no-op has no redundant write/history entry");
            assert.equal(noop.requests.length, fetched ? 2 : 0, "no-op never polls for a change");
        }
    }
    console.log("Current/all × live/fetched: confirmed success, native undo and no-op paths OK");

    for (const all of [false, true]) {
        for (const fetched of [false, true]) {
            const dynamic = fixture([paragraph(id, reference("foo") + " | " + reference("untouched"))]);
            if (fetched) dynamic.wysiwyg.innerHTML = "";
            if (!lute) dynamic.protyle.protyle.lute = {BlockDOM2Md: html => html};
            const dynamicApi = api;
            api = async (url, body) => {
                const response = await dynamicApi(url, body);
                if (dynamic.calls.length && response.data?.[id]) {
                    response.data[id] = response.data[id].replace(">untouched</span>", ">authoritative</span>");
                }
                return response;
            };
            const result = await run(dynamic, all);
            assert.equal(
                result.commitState,
                "confirmed",
                "untouched dynamic anchor refresh does not hide a confirmed write",
            );
            assert.equal(result.replacedCount, 1);
            assert.ok(dynamic.calls[0].operations[0].data.includes('data-subtype="s"'));
            api = dynamicApi;
        }
    }
    const contentFixture = fixture();
    // A lightweight serializer covers the same normalization path when native Lute is not supplied.
    if (!lute) contentFixture.protyle.protyle.lute = {BlockDOM2Md: html => html};
    const strictReader = commit.createCommitContentReader(contentFixture.protyle);
    const confirmReader = commit.createCommitContentReader(contentFixture.protyle, {ignoreDynamicReferenceText: true});
    const untouched = paragraph(id, reference("untouched"));
    assert.equal(confirmReader(untouched), confirmReader(untouched.replace("untouched", "authoritative")));
    assert.equal(
        confirmReader(untouched),
        confirmReader(untouched.replace("untouched", "")),
        "empty derived anchors are equivalent",
    );
    assert.notEqual(
        strictReader(untouched),
        strictReader(untouched.replace("untouched", "authoritative")),
        "rollback stays strict",
    );
    for (
        const changed of [
            untouched.replace(referenceId, otherId),
            untouched.replace('data-subtype="d"', 'data-subtype="s"'),
            untouched.replace("strong block-ref", "em block-ref"),
        ]
    ) {
        assert.notEqual(
            confirmReader(untouched),
            confirmReader(changed),
            "reference ID, subtype and marks stay significant",
        );
    }
    const staticRef = untouched.replace('data-subtype="d"', 'data-subtype="s"');
    assert.notEqual(
        confirmReader(staticRef),
        confirmReader(staticRef.replace("untouched", "authoritative")),
        "static text stays strict",
    );
    const originalCreateElement = document.createElement.bind(document);
    const expectedUnsplit = confirmReader(untouched);
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    document.createElement = (...args) => {
        const element = originalCreateElement(...args);
        if (args[0] === "template") {
            Object.defineProperty(element, "innerHTML", {
                get: () => innerHTML.get.call(element),
                set: html => {
                    innerHTML.set.call(element, html);
                    const text = element.content.querySelector('span[data-subtype="d"]')?.firstChild;
                    if (text instanceof Text && text.length > 3) text.splitText(3);
                },
            });
        }
        return element;
    };
    try {
        assert.equal(
            confirmReader(untouched),
            expectedUnsplit,
            "split Text nodes normalize to one derived anchor placeholder",
        );
    } finally {
        document.createElement = originalCreateElement;
    }
    console.log("Untouched dynamic-reference refresh remains a confirmed replacement OK");

    for (const all of [false, true]) {
        const scoped = fixture(undefined, "delayed");
        scoped.protyle.protyle.notebookId = "encrypted-notebook";
        const originalApi = api;
        const originalInvalidate = corpus.invalidateEditedDocument;
        const invalidated = [];
        let reads = 0;
        api = async (url, body) => {
            assert.equal(body.notebook, "encrypted-notebook", "confirmation retains the submitted notebook scope");
            if (++reads === 1) {
                scoped.protyle.protyle.notebookId = "another-notebook";
                scoped.protyle.protyle.block.rootID = "another-document";
            }
            return originalApi(url, body);
        };
        corpus.invalidateEditedDocument = (rootId, ids) => invalidated.push({rootId, ids});
        try {
            assert.equal((await run(scoped, all)).commitState, "confirmed");
            assert.deepEqual(
                invalidated,
                [{rootId: "r", ids: [id]}],
                "invalidate the submitted document after navigation",
            );
        } finally {
            corpus.invalidateEditedDocument = originalInvalidate;
        }
    }
    console.log("Confirmation notebook scope and submitted-document cache invalidation survive navigation OK");

    for (const all of [false, true]) {
        const fetchedNotebook = fixture();
        fetchedNotebook.wysiwyg.innerHTML = "";
        fetchedNotebook.protyle.protyle.notebookId = "encrypted-fetched-notebook";
        const fetchedApi = api;
        const fetchedBodies = [];
        api = async (url, body) => {
            fetchedBodies.push(body);
            if (body.notebook !== "encrypted-fetched-notebook") return {code: 0, data: {}};
            return fetchedApi(url, body);
        };
        assert.equal((await run(fetchedNotebook, all)).commitState, "confirmed");
        assert.equal(fetchedBodies.length, 3, "same request count as ordinary fetched replacements");
        assert.ok(fetchedBodies.every(body => body.notebook === "encrypted-fetched-notebook"));

        const navigated = fixture();
        navigated.wysiwyg.innerHTML = "";
        navigated.protyle.protyle.notebookId = "original-notebook";
        const navigationApi = api;
        let navigationReads = 0;
        api = async (url, body) => {
            assert.equal(
                body.notebook,
                "original-notebook",
                "preparation and recheck keep the same scope after navigation",
            );
            if (++navigationReads === 1) {
                navigated.protyle.protyle.notebookId = "other-notebook";
                navigated.protyle.protyle.block.rootID = "other-root";
            }
            return navigationApi(url, body);
        };
        assert.equal((await run(navigated, all)).error, "stale-target");
        assert.equal(navigated.calls.length, 0);
        api = fetchedApi;
    }
    console.log("Fetched replacement and confirmation retain encrypted notebook scope OK");

    const savedWarn = console.warn;
    console.warn = () => {};
    try {
        for (const all of [false, true]) {
            for (const mode of ["throw-before", "throw-after", "new-edit-then-throw"]) {
                const f = fixture([paragraph(id, reference("foo"))], mode);
                const before = f.wysiwyg.innerHTML;
                const result = await run(f, all);
                assert.equal(result.commitState, "failed");
                assert.equal(result.replacedCount, 0);
                assert.equal(f.calls.length, 1);
                assert.equal(f.requests.length, 0, "sync errors never cause automatic re-submission");
                if (mode === "new-edit-then-throw") {
                    assert.equal(f.wysiwyg.querySelector('[contenteditable="true"]').textContent, "new user edit");
                } else {
                    assert.equal(f.wysiwyg.innerHTML, before, "live content and dynamic-ref d subtype restored");
                }
            }
            const f = fixture(undefined, "throw-before");
            f.wysiwyg.innerHTML = "";
            assert.equal((await run(f, all)).commitState, "failed");
            assert.equal(f.calls.length, 1);
            assert.equal(
                f.requests.length,
                2,
                "fetched errors keep original queue and do not POST fallback transactions",
            );
        }
    } finally {
        console.warn = savedWarn;
    }
    console.log("Synchronous failures restore only optimistic content, preserve newer edits and never retry writes OK");

    console.warn = () => {};
    try {
        for (const all of [false, true]) {
            for (const newerCopy of [false, true]) {
                const duplicate = fixture([
                    paragraph(id, reference("foo")).replace(
                        'data-type="NodeParagraph"',
                        'data-type="NodeParagraph" data-copy="body"',
                    ),
                    '<div class="protyle-wysiwyg__embed">' + paragraph(id, reference("foo")).replace(
                        'data-type="NodeParagraph"',
                        'data-type="NodeParagraph" data-copy="embed"',
                    ) + "</div>",
                ], "throw-after-all");
                const duplicateBefore = Array.from(duplicate.wysiwyg.querySelectorAll(`[data-node-id="${id}"]`)).map(
                    node => node.outerHTML,
                );
                if (newerCopy) {
                    const originalSubmit = duplicate.protyle.transaction;
                    const submitWithNewerCopy = (operations, undo) => {
                        try {
                            originalSubmit(operations, undo);
                        } catch (error) {
                            duplicate.wysiwyg.querySelector('.protyle-wysiwyg__embed [contenteditable="true"]')
                                .textContent = "new copy edit";
                            throw error;
                        }
                    };
                    duplicate.protyle.transaction = submitWithNewerCopy;
                    duplicate.protyle.updateTransactionElement = (element, before) =>
                        submitWithNewerCopy(
                            [{id, action: "update", data: element.outerHTML}],
                            [{id, action: "update", data: before}],
                        );
                }
                const result = await run(duplicate, all);
                assert.equal(result.commitState, "failed");
                const after = Array.from(duplicate.wysiwyg.querySelectorAll(`[data-node-id="${id}"]`));
                assert.equal(after[0].outerHTML, duplicateBefore[0], "body copy gets its own old HTML");
                if (newerCopy) {
                    assert.equal(after[1].querySelector('[contenteditable="true"]').textContent, "new copy edit");
                } else assert.equal(after[1].outerHTML, duplicateBefore[1], "embed copy gets its own old HTML");
            }
        }
    } finally {
        console.warn = savedWarn;
    }
    console.log("Same-ID embedded copies roll back together after synchronous failure OK");

    for (const all of [false, true]) {
        for (const mode of ["kernel-rejected", "http-error", "network-error", "unrelated", "missing"]) {
            const f = fixture(undefined, mode);
            const states = [];
            const result = await run(f, all, {onCommitStateChange: state => states.push(state)});
            assert.equal(result.commitState, "unknown", mode);
            assert.equal(result.replacedCount, 0);
            assert.equal(result.submittedCount, 1);
            assert.deepEqual(states, ["pending", "unknown"]);
            assert.equal(f.calls.length, 1);
            assert.ok(f.requests.length <= 12, "bounded backoff, no high-frequency indefinite polling");
            assert.ok(f.wysiwyg.textContent.includes("bar"), "timeout must not roll back a possibly queued write");
        }
        const late = fixture(undefined, "kernel-rejected");
        assert.equal((await run(late, all)).commitState, "unknown");
        late.persist();
        assert.ok(late.kernel.get(id).includes("bar"), "late commit remains valid after timeout");
        const pending = fixture(undefined, "delayed");
        const states = [];
        assert.equal(
            (await run(pending, all, {onCommitStateChange: state => states.push(state)})).commitState,
            "confirmed",
        );
        assert.deepEqual(states, ["pending", "confirmed"]);
    }
    const partial = fixture([paragraph(id, "foo"), paragraph(otherId, "foo")], "partial");
    const partialResult = await run(partial, true);
    assert.equal(partialResult.commitState, "unknown");
    assert.equal(partialResult.replacedCount, 1);
    assert.equal(partialResult.submittedCount, 2);
    assert.deepEqual(partial.requests[0].ids, [id, otherId]);
    assert.ok(partial.requests.slice(1).every(request => request.ids.length === 1 && request.ids[0] === otherId));
    console.log("Queue/HTTP/kernel rejection, unrelated changes, partial results, delay and late commit semantics OK");

    const hanging = fixture();
    let settleRead;
    let reads = 0;
    api = () => {
        reads++;
        return new Promise(resolve => {
            settleRead = resolve;
        });
    };
    const hangStates = [];
    const hung = await run(hanging, false, {onCommitStateChange: state => hangStates.push(state)});
    assert.equal(hung.commitState, "unknown");
    assert.equal(reads, 1, "no overlapping requests while a read hangs");
    settleRead({code: 0, data: Object.fromEntries(hanging.kernel)});
    await delay(40);
    assert.deepEqual(
        hangStates,
        ["pending", "unknown"],
        "late read cannot change the returned status or emit stale messages",
    );

    const batchHost = fixture();
    const updates = Array.from({length: 130}, (_, index) => ({
        id: "batch-" + index,
        oldHTML: paragraph("batch-" + index, "foo"),
        newHTML: paragraph("batch-" + index, "bar"),
        appliedCount: 1,
    }));
    const batches = [];
    api = async (_url, {ids}) => {
        batches.push(ids);
        return {
            code: 0,
            data: Object.fromEntries(ids.map(blockId => [blockId, updates.find(u => u.id === blockId).newHTML])),
        };
    };
    const batchResult = await commit.confirmBlockUpdates(batchHost.protyle, updates, {});
    assert.equal(batchResult.commitState, "confirmed");
    assert.equal(batchResult.replacedCount, 130);
    assert.deepEqual(batches.map(batch => batch.length), [64, 64, 2]);

    const childOld = paragraph(otherId, "foo");
    const childNew = paragraph(otherId, "bar");
    const parent = text => `<div data-node-id="${id}" data-type="NodeBlockquote" class="bq">${text}</div>`;
    api = async () => ({code: 0, data: {[id]: normalize(parent(childNew)), [otherId]: normalize(childNew)}});
    assert.equal(
        (await commit.confirmBlockUpdates(batchHost.protyle, [
            {id, oldHTML: parent(childOld), newHTML: parent(childOld), appliedCount: 1},
            {id: otherId, oldHTML: childOld, newHTML: childNew, appliedCount: 1},
        ], {})).commitState,
        "confirmed",
        "parent comparison includes final child updates",
    );
    console.log("Hung reads, bounded batches, confirmed-block pruning and parent/child final content OK");

    if (lute) {
        const reader = commit.createCommitContentReader(batchHost.protyle);
        const content = paragraph(
            id,
            `<span data-type="strong em block-ref" data-subtype="s" data-id="${referenceId}">bar</span>` +
                '<span data-type="inline-memo" data-inline-memo-content="memo bar">body</span>' +
                '<span class="img" data-type="img" contenteditable="false"><span> </span><span><img src="assets/x.png" data-src="assets/x.png" title="bar"><span class="protyle-action__title"><span>bar</span></span></span><span> </span></span>',
        );
        assert.equal(
            reader(content),
            reader(normalize(content)),
            "render UI and added timestamps do not hide a successful write",
        );
        for (
            const changed of [
                content.replace('data-subtype="s"', 'data-subtype="d"'),
                content.replace("memo bar", "old memo"),
                content.replace('title="bar"', 'title="old"'),
                content.replace(referenceId, otherId),
            ]
        ) {
            assert.notEqual(
                reader(content),
                reader(changed),
                "persisted reference/memo/image attributes remain significant",
            );
        }
        for (
            const html of [
                `<div data-node-id="${id}" data-type="NodeTable" class="table"><div><table><thead><tr><th>bar</th></tr></thead><tbody><tr><td>body</td></tr></tbody></table></div></div>`,
                `<div data-node-id="${id}" data-type="NodeCodeBlock" class="code-block"><div class="protyle-action"><span>js</span></div><div contenteditable="true">bar</div></div>`,
                parent(paragraph(otherId, "bar")),
            ]
        ) assert.equal(reader(html), reader(normalize(html)), "native table/code/container normalization");
        console.log("Native Lute content equality: composite refs, memos, images, tables, code and containers OK");
    }

    for (const all of [false, true]) {
        for (
            const mode of [
                "success",
                "delayed",
                "throw-before",
                "throw-after",
                "kernel-rejected",
                "http-error",
                "network-error",
            ]
        ) {
            const f = fixture(undefined, mode);
            const bar = barFixture(f);
            messages.length = 0;
            console.warn = () => {};
            try {
                await (all ? bar.clickReplaceAll() : bar.clickReplace());
            } finally {
                console.warn = savedWarn;
            }
            assert.equal(bar.replaceBusy, false);
            const success = messages.some(message => message.text.startsWith("SUCCESS"));
            assert.equal(success, mode === "success" || mode === "delayed", "UI result " + mode + "/" + all);
            if (mode.startsWith("throw")) assert.ok(messages.some(message => message.text === "FAILED"));
            if (["kernel-rejected", "http-error", "network-error"].includes(mode)) {
                assert.ok(messages.some(message => message.text === "UNKNOWN 0/1"));
            }
            const pendingMessage = messages.find(message => message.text === "PENDING");
            if (pendingMessage) {
                assert.ok(hiddenMessages.includes(pendingMessage.id), "pending toast cleared at completion");
            }
        }
    }
    console.log("Actual SearchBar single/all: only confirmed writes show success; failed/unknown/pending messages OK");

    for (const all of [false, true]) {
        for (const mode of ["success", "kernel-rejected"]) {
            const f = fixture(undefined, mode);
            const bar = makeDestroyable(barFixture(f));
            let refreshes = 0;
            bar.highlightHitResult = async () => {
                refreshes++;
            };
            const originalApi = api;
            let resolveRead;
            let readStarted;
            const started = new Promise(resolve => {
                readStarted = resolve;
            });
            api = (url, body) => {
                readStarted();
                return new Promise(resolve => {
                    resolveRead = () => resolve(originalApi(url, body));
                });
            };
            messages.length = 0;
            const replacing = all ? bar.clickReplaceAll() : bar.clickReplace();
            await started;
            await delay(45);
            const pendingMessage = messages.find(message => message.text === "PENDING");
            assert.ok(pendingMessage, "pending message appears while SearchBar is still open");
            bar.destroy(false);
            assert.ok(hiddenMessages.includes(pendingMessage.id), "destroy immediately clears pending toast");
            const messageCount = messages.length;
            api = originalApi;
            resolveRead();
            await replacing;
            assert.equal(f.calls.length, 1, "an already submitted transaction is not cancelled or retried");
            assert.equal(refreshes, 0, "closed SearchBar does not refresh or reacquire index ownership");
            assert.equal(bar.backgroundCorpusRootId, "", "destroyed owner stays released");
            assert.equal(messages.length, messageCount, "late confirmed/unknown results show no new messages");
            assert.equal(bar.replaceBusy, false);
        }
        const f = fixture();
        const bar = makeDestroyable(barFixture(f));
        bar.regex = true;
        let finishRegex;
        let regexStarted;
        const started = new Promise(resolve => {
            regexStarted = resolve;
        });
        bar.regexMatcher = {
            dispose: () => {},
            expandReplacements: requests => {
                regexStarted();
                return new Promise(resolve => {
                    finishRegex = () =>
                        resolve({expansions: requests.map(request => ({...request, replacement: "bar"}))});
                });
            },
        };
        let refreshes = 0;
        bar.highlightHitResult = async () => {
            refreshes++;
        };
        const replacing = all ? bar.clickReplaceAll() : bar.clickReplace();
        await started;
        bar.destroy(false);
        finishRegex();
        await replacing;
        assert.equal(f.calls.length, 0, "closing during asynchronous preparation prevents a later submit");
        assert.equal(refreshes, 0);
    }
    const closedBar = barFixture(fixture());
    closedBar.destroyed = true;
    closedBar.highlightHitResult = async () => {
        throw new Error("closed handler must not refresh");
    };
    assert.equal(
        await closedBar.handleUnconfirmedReplacement({
            commitState: "unknown",
            replacedCount: 0,
            submittedCount: 1,
            skippedCount: 0,
        }),
        true,
    );
    const refreshingBar = barFixture(fixture());
    refreshingBar.highlightHitResult = async () => {
        refreshingBar.destroyed = true;
    };
    const previousMessageCount = messages.length;
    assert.equal(
        await refreshingBar.handleUnconfirmedReplacement({
            commitState: "unknown",
            replacedCount: 0,
            submittedCount: 1,
            skippedCount: 0,
        }),
        true,
    );
    assert.equal(messages.length, previousMessageCount, "closing during refresh suppresses the final toast");
    console.log("Destroyed SearchBar suppresses late replacement refreshes OK");
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
