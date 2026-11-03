/* eslint-disable no-undef, @typescript-eslint/no-this-alias -- main runs inside the shared isolated harness. */
// Actual v3.8.9 Lute serialization + isolated kernel/undo replay; no notebook writes.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const harness = fs.readFileSync(path.join(__dirname, "run-code-language-regressions.cjs"), "utf8");
const setup = harness.slice(0, harness.indexOf("async function main()"));
async function main() {
    for (const name of ["SetTabs", "SetKramdownIAL", "SetTextMark", "SetBlockRef", "SetHTMLTag2TextMark", "SetSpin"]) lute[name](true);
    const style = document.createElement("style");
    style.textContent = '.tabs[data-tabs-ready="true"] > .tab-item:not([data-tabs-editing="true"]) > .tab-item-info,' +
        '.tab-item[data-tabs-hidden="true"], .tabs[fold="1"] > .tab-item {display:none}';
    document.head.append(style);
    window.Element.prototype.getClientRects = function() {
        for (let node = this; node; node = node.parentElement) if (getComputedStyle(node).display === "none") return [];
        return [rect(0, 0, 100, 20)];
    };
    const {tabTitleElement, fieldTabTitleCanBeSaved} = source("frontend/tabs-title");
    const {extractUnitsFromDoms} = source("frontend/corpus/extract");
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    const kernel = document.createElement("div");
    let order = [], transactions = [], reads = [], failSubmit = false, beforeRead;
    const types = {NodeTabs: "tabs", NodeTabItem: "tab", NodeParagraph: "p", NodeHeading: "h", NodeList: "l", NodeListItem: "i", NodeMathBlock: "m", NodeCodeBlock: "c"};
    function reindex() {
        db.exec("DELETE FROM blocks"); order = [];
        for (const node of kernel.querySelectorAll("[data-node-id][data-type]")) {
            const id = node.dataset.nodeId;
            order.push(id);
            db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "root", node.parentElement.closest("[data-node-id]")?.dataset.nodeId || "root",
                types[node.dataset.type] || "p", node.dataset.subtype || "", node.textContent, lute.BlockDOM2Md(node.outerHTML),
                node.hasAttribute("tabs-title") ? 'tabs-title="true"' : "", node.outerHTML, "1");
        }
        corpus.invalidateDocumentSearchCaches();
    }
    // Same title child structure as tabsRender; br is a space in the label only.
    function render(root) {
        for (const tabs of root.querySelectorAll('.tabs[data-type="NodeTabs"]')) {
            tabs.querySelector(":scope > .tabs-header")?.remove();
            const header = document.createElement("div"); header.className = "tabs-header protyle-action";
            for (const item of tabs.querySelectorAll(":scope > .tab-item")) {
                const source = tabTitleElement(item) || item.querySelector(":scope > .tab-item-info > [tabs-title] > .tab-item-title");
                const button = document.createElement("button"); button.dataset.tabId = item.dataset.nodeId;
                const label = document.createElement("span"); label.className = "tabs-tab-label";
                label.innerHTML = source?.innerHTML || "Tab";
                label.querySelectorAll("br").forEach(br => br.replaceWith(" "));
                label.querySelectorAll("[contenteditable]").forEach(el => el.removeAttribute("contenteditable"));
                button.append(label); header.append(button);
                item.dataset.tabsHidden = String(item.dataset.nodeId !== tabs.getAttribute("tabs-active-id"));
            }
            tabs.prepend(header); tabs.dataset.tabsReady = "true";
        }
    }
    function persist(ops, live = true, replay = false) {
        for (const op of ops) {
            const normalized = op.data;
            const saved = kernel.querySelector(`[data-node-id="${op.id}"]`);
            assert.ok(saved, "transaction targets a real source block");
            // doUpdate parses BlockDOM directly; it does not spin through Markdown.
            // Native parser/export checks below validate persisted inline content.
            saved.outerHTML = normalized;
            if (live) {
                const mounted = wysiwyg.querySelector(`[data-node-id="${op.id}"]`);
                const selected = window.getSelection();
                if (mounted && !( !replay && selected.rangeCount && mounted.contains(selected.getRangeAt(0).startContainer))) mounted.outerHTML = normalized;
            }
        }
        reindex();
        if (live) render(wysiwyg);
    }
    const editor = {protyle: {element: edit, lute, notebookId: "", block: {id: "root", rootID: "root"}},
        transaction(ops, undo) {
            if (failSubmit) throw new Error("queue rejected");
            transactions.push({ops, undo}); persist(ops);
        },
        updateTransactionElement(element, old) {
            this.transaction([{id: element.dataset.nodeId, data: element.outerHTML}], [{id: element.dataset.nodeId, data: old}]);
        }};
    responder = async (url, payload) => {
        if (url === "/api/query/sql") return {code: 0, data: db.prepare(payload.stmt).all()};
        if (url === "/api/block/getDocBlocksOrders") return {code: 0, data: order};
        if (url === "/api/block/getBlockDOMs") {
            reads.push(...payload.ids);
            beforeRead?.();
            return {code: 0, data: Object.fromEntries(payload.ids.map(id => [id, kernel.querySelector(`[data-node-id="${id}"]`)?.outerHTML]))};
        }
        return {code: -1};
    };
    const options = {includeImageOCR: false, includeAttributeView: false, searchMathSource: true, includeFoldedBlocks: true};
    function fixture(form = "paragraph", mount = "loaded", nested = false, titleMarkdown = "needle A needle") {
        window.getSelection().removeAllRanges();
        kernel.innerHTML = lute.Md2BlockDOM(nested ? ":::: tabs\n@tab needle Outer\n::: tabs\n@tab needle Inner\nneedle body\n:::\n::::" :
            "::: tabs\n@tab " + titleMarkdown + "\nneedle body A\n@tab:active needle B\nneedle body B\n:::");
        if (form === "paragraph") {
            let index = 0;
            for (const item of kernel.querySelectorAll(".tab-item")) {
                const title = tabTitleElement(item);
                const p = document.createElement("div");
                p.dataset.nodeId = "20261103120000-title0" + index++;
                p.dataset.type = "NodeParagraph"; p.className = "p"; p.setAttribute("tabs-title", "true"); p.setAttribute("custom-kept", "yes");
                title.replaceWith(p);
                const editable = document.createElement("div"); editable.className = "tab-item-title callout-title";
                editable.contentEditable = "true"; editable.setAttribute("contenteditable", "true");
                editable.innerHTML = title.innerHTML; p.append(editable);
            }
        }
        reindex(); transactions = []; reads = []; failSubmit = false; beforeRead = undefined;
        wysiwyg.innerHTML = mount === "unloaded" ? '<div data-node-id="outside" data-type="NodeParagraph">outside</div>' : kernel.innerHTML;
        render(wysiwyg);
        if (mount === "folded") wysiwyg.querySelector(".tabs").setAttribute("fold", "1");
        editors = [editor];
        return kernel.innerHTML;
    }
    const search = (query = "needle", extra = {}) => calculateSearchMatches({}, edit, query, {...options, ...extra});
    try {
        for (const form of ["paragraph", "field"]) for (const mount of ["loaded", "unloaded", "folded"]) {
            const original = fixture(form, mount);
            const found = await search();
            assert.equal(found.matches.length, 5, form + mount + " source titles/body counted once");
            assert.ok(found.matches.every(hit => hit.replaceable), form + mount + " ordinary source text is writable");
            if (form === "paragraph") assert.ok(!reads.some(id => kernel.querySelector(`[data-node-id="${id}"]`)?.dataset.type === "NodeTabItem"), "independent titles do not fetch whole item subtrees");
            const titleHit = found.matches.find(hit => hit.unitId === "tabs-title");
            if (mount === "loaded") assert.equal(titleHit.range.toString(), "needle", "highlight points to visible clone");
            const single = await write.replaceCurrentMatchInEditor(edit, titleHit, "changed");
            assert.equal(single.commitState, "confirmed", JSON.stringify({form, mount, single}));
            assert.equal(single.replacedCount, 1);
            assert.equal((await search()).matches.length, 4);
            assert.equal(transactions.length, 1);
            assert.ok(!transactions[0].ops[0].data.includes("tabs-tab-label"), "navigation copy is never submitted");
            persist(transactions[0].undo, true, true); assert.equal((await search()).matches.length, 5, "undo restores all areas");
            persist(transactions[0].ops, true, true); assert.equal((await search()).matches.length, 4, "redo restores replacement");
            persist(transactions[0].undo, true, true); transactions = [];
            const all = await write.replaceAllMatchesInEditor(edit, (await search()).matches, "done");
            assert.equal(all.commitState, "confirmed", JSON.stringify({form, mount, all}));
            assert.equal(all.replacedCount, 5); assert.equal(transactions.length, 1, "one undo entry for all titles/body");
            assert.equal((await search()).matches.length, 0);
            assert.deepEqual(Array.from(kernel.querySelectorAll("[data-node-id]"), el => el.dataset.nodeId),
                Array.from((() => { const t = document.createElement("div"); t.innerHTML = original; return t; })().querySelectorAll("[data-node-id]"), el => el.dataset.nodeId), "all child IDs survive");
            persist(transactions[0].undo, true, true); assert.equal((await search()).matches.length, 5, "whole batch undo restores title/body");
            for (const title of kernel.querySelectorAll("[tabs-title]")) assert.equal(title.getAttribute("custom-kept"), "yes");
        }
        // Native export uses <a>; the title safety check must not parse it as
        // an unrecognized BlockDOM tag and cancel an otherwise safe batch.
        for (const form of ["paragraph", "field"]) for (const mount of ["loaded", "unloaded", "folded"]) {
            for (const target of ["plain", "link", "all"]) {
                const href = "https://example.com/path?q=1&value=2#part";
                fixture(form, mount, false, "needle [needle link](" + href + ' "link tip")');
                const original = kernel.innerHTML;
                const matches = (await search()).matches;
                assert.equal(matches.length, 5);
                const titles = matches.filter(hit => hit.unitId === "tabs-title");
                const result = target === "all" ? await write.replaceAllMatchesInEditor(edit, matches, "changed") :
                    await write.replaceCurrentMatchInEditor(edit, titles[target === "plain" ? 0 : 1], "changed");
                assert.equal(result.commitState, "confirmed", JSON.stringify({form, mount, target, result}));
                assert.equal(result.replacedCount, target === "all" ? 5 : 1);
                assert.equal(transactions.length, 1, "safe link title/body batch keeps one undo entry");
                const saved = document.createElement("div"); saved.innerHTML = lute.BlockDOM2RichHTML(kernel.innerHTML);
                const link = saved.querySelector(".tab-item-title a");
                assert.equal(link.getAttribute("href"), href);
                assert.equal(link.getAttribute("title"), "link tip");
                assert.equal(link.textContent, target === "plain" ? "needle link" : "changed link");
                assert.equal((await search()).matches.length, target === "all" ? 0 : 4);
                persist(transactions[0].undo, true, true);
                assert.equal(kernel.innerHTML, original, "undo keeps link destination, tooltip, text and body");
                assert.equal((await search()).matches.length, 5);
                persist(transactions[0].ops, true, true);
                assert.equal((await search()).matches.length, target === "all" ? 0 : 4);
            }
        }
        for (const href of ["siyuan://blocks/20261103120000-ref0001", "../assets/title.pdf?q=1&value=2#part"]) {
            fixture("field", "unloaded", false, "needle [link](" + href + ' "link tip")');
            assert.equal(fieldTabTitleCanBeSaved(kernel.querySelector(".tab-item"), lute), true, "link schemes and relative addresses stay valid");
            const result = await write.replaceCurrentMatchInEditor(edit, (await search()).matches[0], "changed");
            assert.equal(result.commitState, "confirmed");
            const saved = document.createElement("div"); saved.innerHTML = lute.BlockDOM2RichHTML(kernel.innerHTML);
            assert.equal(saved.querySelector(".tab-item-title a").getAttribute("href"), href, "validation never resolves relative links");
        }
        // Export HTML represents memos and compound links differently from
        // saved editor marks. Ordinary title edits must preserve those marks.
        for (const form of ["paragraph", "field"]) for (const mount of ["loaded", "unloaded", "folded"]) {
            for (const kind of ["memo", "bold-link"]) for (const target of ["plain", "marked", "all"]) {
                fixture(form, mount);
                const mark = document.createElement("span");
                mark.dataset.type = kind === "memo" ? "inline-memo" : "strong a";
                mark.textContent = "needle marked";
                if (kind === "memo") mark.dataset.inlineMemoContent = "<b>memo-key</b>";
                else {mark.dataset.href = "https://example.com/path?q=1&value=2#part"; mark.dataset.title = "link tip";}
                kernel.querySelector(".tab-item-title").replaceChildren("needle ", mark);
                reindex();
                if (mount !== "unloaded") {
                    wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
                    if (mount === "folded") wysiwyg.querySelector(".tabs").setAttribute("fold", "1");
                }
                const original = kernel.innerHTML;
                if (kind === "memo") {
                    const memos = (await search("memo-key", {includeInlineMemo: true})).matches;
                    assert.equal(memos.length, 1, "title memo is collected once from its source");
                    assert.ok(memos.every(hit => hit.replaceable), "title memo attributes use the source write path");
                }
                const hits = (await search()).matches;
                assert.equal(hits.length, 5);
                const titleHits = hits.filter(hit => hit.unitId === "tabs-title");
                const result = target === "all" ? await write.replaceAllMatchesInEditor(edit, hits, "changed") :
                    await write.replaceCurrentMatchInEditor(edit, titleHits[target === "plain" ? 0 : 1], "changed");
                assert.equal(result.commitState, "confirmed", JSON.stringify({form, mount, kind, target, result}));
                assert.equal(result.replacedCount, target === "all" ? 5 : 1);
                assert.equal(transactions.length, 1, "formatted title/body batch keeps one undo entry");
                const saved = document.createElement("div"); saved.innerHTML = lute.Md2BlockDOM(lute.BlockDOM2Md(kernel.innerHTML));
                const actual = saved.querySelector(".tab-item-title span[data-type]");
                assert.equal(actual.textContent, target === "plain" ? "needle marked" : "changed marked");
                assert.equal(actual.getAttribute("data-type"), mark.getAttribute("data-type"));
                for (const name of ["data-inline-memo-content", "data-href", "data-title"]) {
                    assert.equal(actual.getAttribute(name), mark.getAttribute(name), "native title reload preserves " + name);
                }
                assert.equal((await search()).matches.length, target === "all" ? 0 : 4);
                persist(transactions[0].undo, true, true);
                assert.equal(kernel.innerHTML, original, "undo restores original title marks and body");
                assert.equal((await search()).matches.length, 5);
                persist(transactions[0].ops, true, true);
                assert.equal((await search()).matches.length, target === "all" ? 0 : 4);
            }
        }
        // Native navigation clones retain memo attributes but have no block IDs.
        // Index the saved hosts once, in each title's own position, and project
        // each result back to its corresponding visible host, never the first tab.
        for (const form of ["paragraph", "field"]) for (const mount of ["loaded", "unloaded", "folded"]) {
            for (const mathSource of [false, true]) for (const target of ["single", "memos", "mixed"]) {
                fixture(form, mount);
                Array.from(kernel.querySelectorAll(".tab-item-title")).forEach((title, index) => {
                    title.innerHTML = `needle title ${index} <span data-type="strong inline-memo" data-inline-memo-content="&lt;b&gt;needle&lt;/b&gt;">first</span> between ` +
                        '<span data-type="inline-memo" data-inline-memo-content="&lt;i&gt;needle second&lt;/i&gt;">last</span>';
                });
                reindex();
                if (mount !== "unloaded") {
                    wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
                    if (mount === "folded") wysiwyg.querySelector(".tabs").setAttribute("fold", "1");
                }
                const original = kernel.innerHTML;
                const searchOptions = {includeInlineMemo: true, searchMathSource: mathSource};
                const hits = (await search("needle", searchOptions)).matches;
                const items = Array.from(kernel.querySelectorAll(".tab-item"));
                const titleIds = items.map(item => form === "field" ? item.dataset.nodeId : item.querySelector("[tabs-title]").dataset.nodeId);
                const bodyIds = items.map(item => item.querySelector(".tab-item-content [data-node-id]").dataset.nodeId);
                assert.deepEqual(hits.map(hit => hit.blockId), [titleIds[0], titleIds[0], titleIds[0], bodyIds[0], titleIds[1], titleIds[1], titleIds[1], bodyIds[1]],
                    "memo hits stay with their title before that tab's body");
                const memos = hits.filter(hit => hit.highlightKind === "inline-memo");
                assert.equal(memos.length, 4, "each real memo is counted once");
                assert.ok(hits.every(hit => hit.replaceable), "source title text/memos/body are writable");
                assert.notEqual(memos[0].anchorOffset, memos[1].anchorOffset, "two memos in one title keep distinct identities");
                if (mount === "loaded") for (let index = 0; index < memos.length; index++) {
                    const host = memos[index].range.commonAncestorContainer;
                    assert.equal(host.closest("[data-tab-id]").dataset.tabId, items[Math.floor(index / 2)].dataset.nodeId,
                        "each memo highlights the correct navigation label");
                    assert.equal(host.textContent, index % 2 ? "last" : "first", "same-title memo anchors do not alias");
                }
                const selected = target === "single" ? [memos[3]] : target === "memos" ? memos : hits;
                const result = target === "single" ? await write.replaceCurrentMatchInEditor(edit, selected[0], "changed") :
                    await write.replaceAllMatchesInEditor(edit, selected, "changed");
                assert.equal(result.commitState, "confirmed", JSON.stringify({form, mount, mathSource, target, result}));
                assert.equal(result.replacedCount, selected.length);
                assert.equal(transactions.length, 1, "memo/title/body batch keeps one undo entry");
                assert.ok(transactions[0].ops.every(op => !op.data.includes("tabs-tab-label")), "only saved sources are submitted");
                assert.equal((await search("needle", searchOptions)).matches.length, 8 - selected.length);
                const reloaded = document.createElement("div"); reloaded.innerHTML = lute.Md2BlockDOM(lute.BlockDOM2Md(kernel.innerHTML));
                const savedMemos = Array.from(reloaded.querySelectorAll('.tab-item-title [data-type~="inline-memo"]'));
                assert.equal(savedMemos.length, 4, "memo marks survive native reload");
                assert.equal(savedMemos[3].getAttribute("data-inline-memo-content"), "changed second");
                assert.equal(savedMemos[0].getAttribute("data-inline-memo-content"), target === "single" ? "<b>needle</b>" : "changed");
                assert.ok(savedMemos[0].matches('[data-type~="strong"]'), "host compound marks survive memo writes");
                persist(transactions[0].undo, true, true);
                assert.equal(kernel.innerHTML, original, "undo restores title memo attributes, marks and body");
                assert.equal((await search("needle", searchOptions)).matches.length, 8);
                persist(transactions[0].ops, true, true);
                assert.equal((await search("needle", searchOptions)).matches.length, 8 - selected.length);
            }
        }
        for (const form of ["paragraph", "field"]) for (const mount of ["loaded", "unloaded"]) {
            for (const replacement of ["", "$2-$1"]) {
                fixture(form, mount, true);
                const titles = Array.from(kernel.querySelectorAll(".tab-item-title"));
                for (const title of titles) title.innerHTML =
                    '<span data-type="strong inline-memo" data-inline-memo-content="needle needle">note</span> needle';
                reindex();
                if (mount === "loaded") {wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);}
                const opts = {includeInlineMemo: true};
                const original = kernel.innerHTML;
                const found = (await search("needle", opts)).matches;
                assert.equal(found.length, 7, "nested titles each have two memo hits and one text hit, plus body");
                assert.equal((await search("needle", {...opts, includeTabs: false})).matches.length, 0);
                assert.equal((await search("needle", {includeInlineMemo: false})).matches.length, 3);
                const restricted = (await search("needle", {...opts, restrictInlineTypes: ["inline-memo"]})).matches;
                assert.equal(restricted.length, 4, "memo-only restriction excludes host text and body");
                if (mount === "loaded") {
                    editors = [];
                    const fallback = (await search("needle", opts)).matches;
                    assert.deepEqual(fallback.map(hit => [hit.blockId, hit.highlightKind]), found.map(hit => [hit.blockId, hit.highlightKind]),
                        "DOM-only fallback retains source order, identity and memo kinds");
                    assert.ok(fallback.every(hit => hit.replaceable));
                    editors = [editor];
                }
                const regexOptions = replacement ? {regex: true, searchQuery: "(need)(le)", regexMatcher: {
                    expandReplacements: async (requests, pattern, template, settings) => ({
                        expansions: source("shared/regex-replace").expandRegexReplacementUnits(requests, pattern, template, settings), error: "",
                    }),
                }} : {};
                const result = await write.replaceAllMatchesInEditor(edit, restricted, replacement, regexOptions);
                assert.equal(result.commitState, "confirmed", JSON.stringify({form, mount, replacement, result}));
                assert.equal(result.replacedCount, 4);
                assert.equal((await search("needle", opts)).matches.length, 3, "memo replacement leaves title/body text unchanged");
                assert.equal(kernel.querySelectorAll('.tab-item-title [data-type~="strong"]').length, 2);
                if (!replacement) assert.equal(kernel.querySelectorAll('.tab-item-title [data-type~="inline-memo"]').length, 2,
                    "deleting only occurrences keeps remaining space as memo content");
                persist(transactions[0].undo, true, true);
                assert.equal(kernel.innerHTML, original);
                assert.equal((await search("needle", opts)).matches.length, 7);
                // Deleting the entire memo removes its token while preserving
                // the host's bold mark and the following title text.
                const whole = (await search("needle needle", opts)).matches;
                const cleared = await write.replaceAllMatchesInEditor(edit, whole, "");
                assert.equal(cleared.commitState, "confirmed", JSON.stringify({form, mount, cleared}));
                assert.equal(kernel.querySelectorAll('.tab-item-title [data-type~="inline-memo"]').length, 0);
                assert.equal(kernel.querySelectorAll('.tab-item-title [data-type="strong"]').length, 2);
                assert.equal((await search("needle", opts)).matches.length, 3);
            }
        }
        for (const form of ["paragraph", "field"]) for (const compound of [false, true]) {
            fixture(form);
            const title = kernel.querySelector(".tab-item-title");
            title.innerHTML = `<span data-type="${compound ? "strong " : ""}inline-memo" data-inline-memo-content="needle">first</span> needle ` +
                '<span data-type="inline-memo" data-inline-memo-content="needle">last</span> needle';
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const opts = {includeInlineMemo: true};
            const matches = (await search("needle", opts)).matches;
            const result = await write.replaceAllMatchesInEditor(edit, matches, "");
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, compound, result}));
            assert.equal(result.replacedCount, matches.length, "clearing memo and surrounding text in one batch stays atomic");
            assert.equal((await search("needle", opts)).matches.length, 0);
        }
        for (const form of ["paragraph", "field"]) {
            fixture(form);
            kernel.querySelector(".tab-item-title").innerHTML =
                '<span data-type="inline-memo" data-inline-memo-content="memo-key">note</span>';
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const sourceHost = wysiwyg.querySelector('.tab-item-info [data-type~="inline-memo"]');
            const labelHost = wysiwyg.querySelector('.tabs-tab-label [data-type~="inline-memo"]');
            const opts = {includeInlineMemo: true};
            labelHost.setAttribute("data-inline-memo-content", "stale");
            const stale = (await search("memo-key", opts)).matches;
            assert.equal(stale.length, 1, "stale clones never change indexed content");
            assert.ok(!stale[0].range || !stale[0].range.commonAncestorContainer.closest(".tabs-header"),
                "stale navigation labels are not used to paint a memo");
            const item = sourceHost.closest(".tab-item");
            item.dataset.tabsEditing = "true"; item.dataset.tabsHidden = "false";
            const live = (await search("memo-key", opts)).matches;
            assert.equal(live.length, 1);
            assert.equal(live[0].range.commonAncestorContainer, sourceHost, "active title editor highlights the real memo host");
            const selected = document.createRange(); selected.selectNodeContents(sourceHost);
            window.getSelection().addRange(selected);
            const result = await write.replaceCurrentMatchInEditor(edit, live[0], "changed");
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, result}));
            assert.equal((await search("memo-key", opts)).matches.length, 0);
            window.getSelection().removeAllRanges();
        }
        for (const form of ["paragraph", "field"]) {
            fixture(form);
            kernel.querySelector(".tab-item-title").innerHTML =
                '<span data-type="inline-memo" data-inline-memo-content="memo-key">note</span>';
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const opts = {includeInlineMemo: true};
            const before = (await search("memo-key", opts)).matches;
            assert.equal(before.length, 1);
            assert.equal(createReplacementReasonReader()(before[0]), "complex", "no obsolete tab-title rejection reason is assigned");
            const title = wysiwyg.querySelector(".tab-item-title");
            title.style.display = "none";
            corpus.invalidateDocumentSearchCaches();
            assert.equal((await search("memo-key", opts)).matches.length, 0, "author-hidden title memo is not revived from a navigation copy or SQL");
        }
        // Literal replacement text must still be rejected if the kernel would
        // reinterpret it as inline Markdown, even alongside supported marks.
        for (const mount of ["loaded", "unloaded"]) for (const all of [false, true]) for (const marks of [
            '<span data-type="a" data-href="https://example.com" data-title="link tip">link</span>',
            '<span data-type="inline-memo" data-inline-memo-content="memo-key">note</span>',
            '<span data-type="strong a" data-href="https://example.com">link</span>',
        ]) {
            fixture("field", mount);
            kernel.querySelector(".tab-item-title").innerHTML = "needle " + marks;
            reindex();
            if (mount !== "unloaded") {wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);}
            const original = kernel.innerHTML, live = wysiwyg.innerHTML;
            const hits = (await search()).matches;
            const result = all ? await write.replaceAllMatchesInEditor(edit, hits, "**literal** $x$") :
                await write.replaceCurrentMatchInEditor(edit, hits[0], "**literal** $x$");
            assert.equal(result.error, "tabs-title-unsafe");
            assert.equal(transactions.length, 0); assert.equal(kernel.innerHTML, original); assert.equal(wysiwyg.innerHTML, live);
        }
        for (const marks of [
            '<span data-type="strong"><span data-type="a" data-href="https://example.com">link</span></span>',
            '<span data-type="a" data-href="https://example.com"><span data-type="strong">link</span></span>',
        ]) for (const all of [false, true]) {
            fixture("field");
            kernel.querySelector(".tab-item-title").innerHTML = "needle " + marks;
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const original = kernel.innerHTML, live = wysiwyg.innerHTML;
            const hits = (await search()).matches;
            const result = all ? await write.replaceAllMatchesInEditor(edit, hits, "changed") :
                await write.replaceCurrentMatchInEditor(edit, hits[0], "changed");
            assert.equal(result.error, "tabs-title-unsafe", "unverifiable nested marks remain blocked");
            assert.equal(transactions.length, 0); assert.equal(kernel.innerHTML, original); assert.equal(wysiwyg.innerHTML, live);
        }
        for (const [html, selector, attribute, value] of [
            ['<span data-type="a" data-href="https://example.com" data-title="tip">link</span>', '[data-type~="a"]', "data-href", "https://changed.example.com"],
            ['<span data-type="a" data-href="https://example.com" data-title="tip">link</span>', '[data-type~="a"]', "data-title", "changed tip"],
            ['<span data-type="strong a" data-href="https://example.com">link</span>', '[data-type~="a"]', "data-type", "a"],
            ['<span data-type="inline-memo" data-inline-memo-content="memo-key">note</span>', '[data-type~="inline-memo"]', "data-inline-memo-content", "changed memo"],
            ['<span data-type="block-ref" data-subtype="s" data-id="20261103120000-ref0001">ref</span>', '[data-type~="block-ref"]', "data-id", "20261103120000-ref0002"],
        ]) {
            fixture("field");
            kernel.querySelector(".tab-item-title").innerHTML = "needle " + html;
            const item = kernel.querySelector(".tab-item"), original = item.outerHTML;
            assert.equal(fieldTabTitleCanBeSaved(item, lute), true, "unchanged native mark passes before fault injection");
            const changedReload = {
                Md2BlockDOM(markdown) {
                    const reloaded = document.createElement("div"); reloaded.innerHTML = lute.Md2BlockDOM(markdown);
                    const mark = reloaded.querySelector(".tab-item-title " + selector);
                    assert.ok(mark, "fault injection reaches a persisted title mark");
                    mark.setAttribute(attribute, value);
                    return reloaded.innerHTML;
                },
                BlockDOM2RichHTML: html => lute.BlockDOM2RichHTML(html),
                BlockDOM2Md: html => lute.BlockDOM2Md(html),
            };
            assert.equal(fieldTabTitleCanBeSaved(item, changedReload), false, "validation still detects changed " + attribute);
            assert.equal(item.outerHTML, original, "validation never mutates the source title or body");
        }
        for (const form of ["paragraph", "field"]) {
            fixture(form, "loaded", true);
            const result = await write.replaceAllMatchesInEditor(edit, (await search()).matches, "nested");
            assert.equal(result.replacedCount, 3, form + " nested parent/child updates");
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, result}));
            persist(transactions[0].undo, true, true); assert.equal((await search()).matches.length, 3);
        }
        for (const form of ["paragraph", "field"]) for (const all of [false, true]) {
            fixture(form, "unloaded");
            const regexOptions = {regex: true, searchQuery: "(need)(le)", regexMatcher: {
                expandReplacements: async (requests, pattern, template, settings) => ({
                    expansions: source("shared/regex-replace").expandRegexReplacementUnits(requests, pattern, template, settings), error: "",
                }),
            }};
            const hits = (await search()).matches;
            const result = all ? await write.replaceAllMatchesInEditor(edit, hits, "$2-$1", regexOptions) :
                await write.replaceCurrentMatchInEditor(edit, hits[0], "$2-$1", regexOptions);
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, all, result}));
            assert.equal(result.replacedCount, all ? 5 : 1);
            assert.ok(kernel.querySelector(".tab-item-title").textContent.startsWith("le-need"));
            persist(transactions[0].undo, true, true); assert.equal((await search()).matches.length, 5);
        }
        for (const form of ["paragraph", "field"]) {
            fixture(form);
            kernel.querySelector(".tab-item-title").innerHTML +=
                ' <span data-type="inline-memo" data-inline-memo-content="memo-key">note</span>';
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const memos = (await search("memo-key", {includeInlineMemo: true})).matches;
            assert.ok(memos.length, "title memo remains searchable");
            assert.ok(memos.every(hit => hit.replaceable), "title memo attributes use the writable source");
            const hits = (await search()).matches;
            wysiwyg.setAttribute("data-readonly", "true");
            assert.equal((await write.replaceAllMatchesInEditor(edit, hits, "blocked")).error, "readonly-or-preview");
            assert.equal((await write.replaceAllMatchesInEditor(edit, memos, "blocked")).error, "readonly-or-preview");
            assert.equal(transactions.length, 0, "read-only editor never submits title writes");
            wysiwyg.removeAttribute("data-readonly");
        }
        for (const form of ["paragraph", "field"]) {
            fixture(form);
            const item = kernel.querySelector(".tab-item");
            const title = tabTitleElement(item) || item.querySelector(".tab-item-title");
            title.innerHTML = (form === "paragraph" ? "before<br>" : "before ") + 'needle <span data-type="strong">marked</span> ' +
                '<span data-type="inline-math" data-content="needle"></span> after ' +
                '<span data-type="strong block-ref" data-subtype="d" data-id="20261103120000-ref0001">refneedle</span>';
            reindex(); wysiwyg.innerHTML = kernel.innerHTML; render(wysiwyg);
            const hits = (await search()).matches;
            const plain = hits.find(hit => hit.unitId?.startsWith("tabs-title") && hit.matchedText === "needle");
            assert.equal(plain.range.toString(), "needle", "br/format/math do not shift projection offsets");
            assert.ok(hits.some(hit => hit.highlightKind === "math-source" && !hit.replaceable), "title formulas remain read-only");
            const refHit = hits.find(hit => hit.unitId?.startsWith("tabs-title") && hit.start > plain.start);
            const result = await write.replaceCurrentMatchInEditor(edit, refHit, "NEW");
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, result}));
            assert.equal(kernel.querySelector('[data-type~="block-ref"]').dataset.subtype, "s");
            persist(transactions[0].undo, true, true);
            assert.equal(kernel.querySelector('[data-type~="block-ref"]').dataset.subtype, "d");
            assert.equal((await search("before")).matches.length, 1, "source and label never duplicate");
            const cross = (await search("e marked")).matches[0];
            assert.equal(cross.replaceable, false, "cross-mark range still rejected");
            assert.equal((await search("needle", {includeTabs: false})).matches.length, 0);
        }
        for (const form of ["paragraph", "field"]) for (const replacement of ["", "**literal** $x$ <tag> & 😀", "中文"] ) {
            fixture(form);
            const first = (await search()).matches.find(hit => hit.unitId === "tabs-title");
            const original = kernel.innerHTML;
            const result = await write.replaceCurrentMatchInEditor(edit, first, replacement);
            if (form === "field" && replacement.startsWith("**")) {
                assert.equal(result.error, "tabs-title-unsafe", "reject native reinterpretation of literal replacement text");
                assert.equal(kernel.innerHTML, original); assert.equal(transactions.length, 0);
                continue;
            }
            assert.equal(result.commitState, "confirmed", JSON.stringify({form, replacement, result}));
            const title = kernel.querySelector(".tab-item-title");
            assert.equal(title.textContent, replacement + " A needle", "replacement stays literal text");
            assert.equal(title.querySelector('[data-type="strong"], [data-type="inline-math"], tag'), null);
            const exported = document.createElement("div"); exported.innerHTML = lute.BlockDOM2RichHTML(kernel.innerHTML);
            assert.ok(exported.textContent.includes(replacement + " A needle"), "native direct parser preserves literal title text");
            fixture(form);
            // Active title editing and DOM-only fallback use the same source.
            const item = wysiwyg.querySelector(".tab-item");
            item.dataset.tabsEditing = "true"; item.dataset.tabsHidden = "false";
            editors = [];
            const fallback = await search();
            assert.equal(fallback.matches.length, 5);
            assert.ok(fallback.matches.every(hit => hit.replaceable));
            editors = [editor];
            assert.equal((await write.replaceCurrentMatchInEditor(edit, fallback.matches[0], "edited")).commitState, "confirmed");
        }
        // An entire title can be cleared without losing its body or identity.
        for (const form of ["paragraph", "field"]) {
            fixture(form);
            const first = (await search("needle A needle")).matches[0];
            assert.equal((await write.replaceCurrentMatchInEditor(edit, first, "")).commitState, "confirmed");
            assert.equal(kernel.querySelector(".tab-item-title").textContent, "");
            assert.ok(kernel.querySelector(".tab-item-content").textContent.includes("needle body A"));
            persist(transactions[0].undo, true, true);
            assert.equal((await search()).matches.length, 5);
        }
        fixture("field");
        let hit = (await search()).matches[0];
        const count = transactions.length;
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "needle")).unchanged, true);
        assert.equal(transactions.length, count, "no-op does not create history");
        const body = wysiwyg.querySelector(".tab-item-content [contenteditable]");
        body.textContent = "unsaved user body";
        const before = wysiwyg.innerHTML, savedBefore = kernel.innerHTML;
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "new")).error, "stale-target", "never overwrite unsaved body");
        assert.equal(wysiwyg.innerHTML, before); assert.equal(kernel.innerHTML, savedBefore); assert.equal(transactions.length, count);
        fixture("field"); hit = (await search()).matches[0];
        wysiwyg.querySelector(".tab-item-content").replaceChildren();
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "new")).error, "stale-target", "partial mounted item cannot replace its full kernel body");
        assert.equal(transactions.length, 0);
        fixture("field"); hit = (await search()).matches[0];
        const range = document.createRange(); range.selectNodeContents(wysiwyg.querySelector(".tab-item-content [contenteditable]"));
        window.getSelection().addRange(range);
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "new")).commitState, "confirmed", "selected child keeps item title in sync");
        assert.ok(wysiwyg.querySelector(".tab-item-title").textContent.startsWith("new"));
        fixture("field");
        const selected = document.createRange(); selected.selectNodeContents(wysiwyg.querySelector(".tab-item-content [contenteditable]"));
        window.getSelection().addRange(selected);
        assert.equal((await write.replaceAllMatchesInEditor(edit, (await search()).matches, "selected")).commitState, "confirmed");
        assert.equal((await search()).matches.length, 0, "selected parent/child copies both reflect the batch");
        persist(transactions[0].undo, true, true); window.getSelection().removeAllRanges();
        assert.equal((await search()).matches.length, 5);
        fixture("paragraph"); hit = (await search()).matches[0];
        failSubmit = true;
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "new")).commitState, "failed");
        assert.equal((await search()).matches.length, 5, "queue rejection rolls back live source");
        fixture("field"); hit = (await search()).matches[0];
        let once = false;
        beforeRead = () => { if (!once) { once = true; wysiwyg.querySelector(".tab-item-title").append(" edited"); } };
        assert.equal((await write.replaceCurrentMatchInEditor(edit, hit, "new")).error, "stale-target");
        assert.equal(transactions.length, 0, "cancel changed targets before submitting");
        // Field extraction must retain a full body for writes, but never let
        // parent copies shadow independently requested child units in search.
        fixture("field");
        const item = kernel.querySelector(".tab-item"), child = item.querySelector(".tab-item-content [data-node-id]");
        const extracted = await extractUnitsFromDoms([item.dataset.nodeId, child.dataset.nodeId],
            {[item.dataset.nodeId]: item.outerHTML, [child.dataset.nodeId]: child.outerHTML}, options, new Set(), "none");
        assert.equal(extracted.blocks.filter(unit => unit.blockId === child.dataset.nodeId).length, 1);
        extracted.dispose();
        assert.equal(document.querySelectorAll("[data-page-search-offscreen]").length, 0);
    } finally { db.close(); corpus.invalidateDocumentSearchCaches(); }
    console.log("tabs title replacement regressions passed");
}
const mod = new Module(__filename, module);
mod.filename = __filename; mod.paths = module.paths;
mod._compile(setup + "\n" + main.toString() + "\nmain().catch(error => { console.error(error); process.exitCode = 1; });", __filename);
