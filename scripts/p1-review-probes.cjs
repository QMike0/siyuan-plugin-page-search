// P1 regression contracts. Reuse the source fixture, including isolated Unicode checks.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const fixture = path.join(__dirname, "run-corpus-regressions.cjs");
const code = fs.readFileSync(fixture, "utf8").replace(/\r\n/g, "\n");
const marker = '    try {\n        for (const language of ["mermaid", "flowchart"]) {';
if (!code.includes(marker)) throw new Error("Review fixture insertion point changed");
const probes = `    try {
        for (const [text, pattern] of [["ab", "[a-z中]{2}"], ["ab", "[A-Za-z_]{2}"], ["afoo", "[a-z。]foo"]]) {
            reset();
            add("b", "p", text);
            const groups = regex.extractRegexLiteralGroups(pattern, true, {unicode: true});
            const candidates = groups ? await sql.fetchLiteralGroupCandidateIds("r", groups, true, "content") : ["b"];
            const finalHits = hit(text, pattern, {regex: true, regexUnicode: true, caseSensitive: true});
            doms.b = '<div data-node-id="b" data-type="NodeParagraph">' + text + '</div>';
            const documentResult = await search(pattern, {regex: true, regexUnicode: true, caseSensitive: true});
            console.log("mixed character range SQL superset", JSON.stringify({text, pattern, groups, candidates, finalHits: finalHits.length, documentHits: documentResult.matches.length}));
            assert.equal(finalHits.length, 1);
            assert.equal(candidates.includes("b"), true, "mixed character ranges must preserve the candidate superset");
            assert.equal(documentResult.matches.length, 1);
            full(documentResult);
        }

        reset();
        add("b", "query_embed", "ordinary");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="text" data-type="NodeParagraph">ordinary</div><div data-node-id="bad" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="broken"><div></div></div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            host.querySelector('[data-node-id="bad"]').innerHTML = '<div class="ft__error">failed</div>';
        }};
        const first = await search("ordinary");
        const second = await search("ordinary");
        console.log("mounted embed partial output", JSON.stringify({
            first: {count: first.matches.length, unrendered: first.unrendered},
            second: {count: second.matches.length, unrendered: second.unrendered}, renderCalls,
        }));
        assert.equal(first.matches.length, 1);
        assert.equal(second.matches.length, 1, "negative cache retains healthy live siblings");
        assert.equal(second.unrendered, 1);
        assert.equal(renderCalls, 1, "failure backoff is preserved");

        reset();
        add("b", "query_embed", "ordinary");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="text" data-type="NodeParagraph"><span class="label">ordinary</span></div><div data-node-id="cold" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="diagram"><div></div></div></div>';
        window.Protyle = {mermaidRender: renderer};
        const beforeHide = await search("ordinary");
        wysiwyg.querySelector(".label").style.display = "none";
        const liveAfterHide = source("frontend/blocks").collectSearchableBlocks(edit, {includeFoldedBlocks: true});
        const afterHide = await search("ordinary");
        console.log("mounted embed cached visibility", JSON.stringify({
            before: beforeHide.matches.length,
            liveHiddenMatches: liveAfterHide.filter((block) => block.text.includes("ordinary")).length,
            after: afterHide.matches.length, rangeCount: afterHide.matches.filter((match) => match.range).length,
            partial: afterHide.partial, unrendered: afterHide.unrendered, renderCalls,
        }));
        assert.equal(beforeHide.matches.length, 1);
        assert.equal(liveAfterHide.filter((block) => block.text.includes("ordinary")).length, 0);
        assert.equal(afterHide.matches.length, 0, "embed cache cannot reintroduce hidden text");
        assert.equal(renderCalls, 1, "ordinary visibility changes do not rerender healthy diagrams");

        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="li" data-node-id="list" data-type="NodeListItem"><div data-node-id="text" data-type="NodeParagraph">ordinary</div></div><div data-node-id="cold" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="diagram"><div></div></div></div>';
        window.Protyle = {mermaidRender: renderer};
        const beforeFold = await search("ordinary", {includeFoldedBlocks: false});
        wysiwyg.querySelector('[data-node-id="list"]').setAttribute("fold", "1");
        const afterFold = await search("ordinary", {includeFoldedBlocks: false});
        console.log("mounted embed inner fold", JSON.stringify({
            before: beforeFold.matches.length, after: afterFold.matches.length,
            rangeCount: afterFold.matches.filter((match) => match.range).length,
            partial: afterFold.partial, unrendered: afterFold.unrendered, renderCalls,
        }));
        assert.equal(afterFold.matches.length, 0, "live fold gates remain authoritative");

        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="text" data-type="NodeParagraph">foobar</div><div data-node-id="cold" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="diagram"><div></div></div></div>';
        window.Protyle = {mermaidRender: renderer};
        const beforeBreak = await search("foobar");
        wysiwyg.querySelector('[data-node-id="text"]').innerHTML = "foo<br>bar";
        const afterBreak = await search("foobar");
        console.log("mounted embed changed text run", JSON.stringify({
            before: beforeBreak.matches.length, after: afterBreak.matches.length,
            partial: afterBreak.partial, unrendered: afterBreak.unrendered, renderCalls,
        }));
        assert.equal(afterBreak.matches.length, 0, "embed cache preserves current BR barriers");
        assert.equal((await search("foo")).matches.filter((match) => match.unitId.startsWith("embed:text:")).length, 1);
        assert.equal((await search("bar")).matches.length, 1);
        assert.equal(renderCalls, 1, "ordinary structure changes do not rerender the pending diagram");

        reset();
        add("b", "query_embed", "query");
        const healthyDiagrams = Array.from({length: 20}, (_, index) => '<div data-node-id="good-' + index + '" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="good-' + index + '" data-render="true"><div><svg><text>ready</text></svg></div></div>').join("");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed">' + healthyDiagrams + '<div data-node-id="bad" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="broken"><div></div></div></div>';
        let healthyRerendered = 0;
        window.Protyle = {mermaidRender: (host) => host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
            if (block.getAttribute("data-render") === "true") return;
            if (block.dataset.nodeId === "bad") block.innerHTML = '<div class="ft__error">failed</div>';
            else { healthyRerendered += 1; block.innerHTML = '<div><svg><text>ready</text></svg></div>'; }
            block.setAttribute("data-render", "true");
        })};
        const readySiblings = await search("ready");
        console.log("mounted embed healthy diagram rerenders", JSON.stringify({
            healthyRerendered, count: readySiblings.matches.length, unrendered: readySiblings.unrendered,
        }));
        assert.equal(healthyRerendered, 0, "one failed child must not rerender complete siblings");
        assert.equal(readySiblings.matches.length, 20);
        assert.equal((await search("ready")).matches.length, 20);
        assert.equal(healthyRerendered, 0);

        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div class="li" data-node-id="li" data-type="NodeListItem" fold="1"><div></div><div></div><div data-node-id="folded" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="diagram" data-render="true"><div><svg><text>stale</text><text>stale</text></svg></div></div></div><div data-node-id="ready" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="ready" data-render="true"><div><svg><text>ready</text></svg></div></div></div>';
        window.Protyle = {mermaidRender: renderer};
        const foldedEmbed = await search("generated");
        full(foldedEmbed);
        assert.equal(foldedEmbed.matches.length, 1, "folded partial output still requires full recovery");
        assert.equal((await search("stale")).matches.length, 0);
        assert.equal((await search("ready")).matches.length, 1);
        assert.equal(renderCalls, 1);
        full(await search("generated", {includeFoldedBlocks: false}));
        assert.equal((await search("generated", {includeFoldedBlocks: false})).matches.length, 0);

        // Retain successful output alongside a failed child. Mounted recovery
        // uses backoff; unloaded query embeds deliberately fetch fresh dependencies.
        for (const mounted of [false, true]) {
            reset();
            add("b", "query_embed", "query");
            const partialEmbed = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="text" data-type="NodeParagraph">ordinary</div><div data-node-id="good" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="good"><div></div></div><div data-node-id="bad" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="broken"><div></div></div></div>';
            if (mounted) wysiwyg.innerHTML = partialEmbed;
            else doms.b = partialEmbed;
            window.Protyle = {mermaidRender: (host) => {
                renderCalls += 1;
                host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
                    block.innerHTML = block.dataset.nodeId === "bad" ? '<div class="ft__error">failed</div>' : '<div><svg><text>recovered</text></svg></div>';
                    block.setAttribute("data-render", "true");
                });
            }};
            if (!mounted) corpus.retainBackgroundCorpusRoot("r");
            try {
                const recovered = mounted ? await search("recovered") : await settle("recovered");
                assert.equal(recovered.matches.length, 1);
                assert.equal(recovered.unrendered, 1);
                const renderCount = renderCalls;
                assert.equal((await search("recovered")).matches.length, 1);
                assert.equal((await search("ordinary")).matches.length, 1);
                if (mounted) assert.equal(renderCalls, renderCount, "partial cache retains successes without retry storms");
            } finally {
                if (!mounted) corpus.releaseBackgroundCorpusRoot("r");
            }
        }

        reset();
        add("b", "query_embed", "query");
        const readyFormula = '<span data-type="inline-math" data-subtype="math" data-content="a" data-render="true"><span class="katex-html">α</span></span>';
        const coldFormula = '<span data-type="inline-math" data-subtype="math" data-content="a"><span></span></span>';
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="text" data-type="NodeParagraph">foo' + coldFormula + readyFormula + 'bar</div></div>';
        window.Protyle = {mathRender: (host) => {
            renderCalls += 1;
            host.querySelectorAll('span[data-type~="inline-math"]:not([data-render="true"])').forEach((span) => {
                span.setAttribute("data-render", "true");
                span.innerHTML = '<span class="katex-html">α</span>';
            });
        }};
        const sameFormulas = await search("α");
        full(sameFormulas);
        assert.equal(sameFormulas.matches.length, 2);
        assert.notEqual(sameFormulas.matches[0].unitId, sameFormulas.matches[1].unitId, "pending formula cannot collide with identical ready sibling");
        assert.equal(sameFormulas.matches.filter((match) => match.range).length, 1, "only the ready sibling has live glyph coordinates");
        assert.equal((await search("foobar")).matches.length, 0);
        assert.equal((await search("α")).matches.length, 2);
        assert.equal(renderCalls, 1);
        wysiwyg.querySelector('[data-node-id="text"]').dataset.nodeId = "new-text";
        const movedFormulaOwner = await search("α");
        full(movedFormulaOwner);
        assert.equal(movedFormulaOwner.matches.length, 2);
        assert.ok(movedFormulaOwner.matches.every((match) => match.unitId.startsWith("embed:new-text:")), "cached recovery follows source owner identity");

        // A healthy HTML sibling must not be reconstructed/upgraded when only a
        // different diagram needs recovery. Mimic official observed data-content.
        let htmlUpgrades = 0;
        window.customElements.define("protyle-html", class extends window.HTMLElement {
            static get observedAttributes() { return ["data-content"]; }
            constructor() { super(); this.attachShadow({mode: "open"}); }
            attributeChangedCallback(_name, _oldValue, newValue) {
                htmlUpgrades += 1;
                this.shadowRoot.innerHTML = newValue || "";
            }
        });
        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="html" data-type="NodeHTMLBlock" data-render="true"><protyle-html data-content="ordinary"></protyle-html></div><div data-node-id="cold" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="diagram"><div></div></div></div>';
        const upgradesBefore = htmlUpgrades;
        const healthyHtml = await search("ordinary");
        full(healthyHtml);
        assert.equal(healthyHtml.matches.length, 1);
        assert.ok(healthyHtml.matches[0].range);
        assert.equal(htmlUpgrades, upgradesBefore, "healthy HTML sibling is not reexecuted");

        reset();
        add("b", "c", "", "mermaid");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content=""><div spin="1"></div></div>';
        // Official Mermaid renderer successfully returns a ZWSP shell for empty source.
        window.Protyle = {mermaidRender: (host) => host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
            block.setAttribute("data-render", "true");
            block.innerHTML = '<div><span style="position:absolute;width:1px">&#8203;</span></div>';
        })};
        const emptySource = await search("ordinary");
        console.log("successful empty Mermaid source", JSON.stringify({
            count: emptySource.matches.length, partial: emptySource.partial,
            degraded: emptySource.degraded, unrendered: emptySource.unrendered,
        }));
        full(emptySource);
        assert.equal(extract.rendererOutputCompleted(wysiwyg.firstElementChild), false, "live empty source without completion is still pending");
        const incompleteDiagram = document.createElement("div");
        incompleteDiagram.dataset.type = "NodeCodeBlock";
        incompleteDiagram.dataset.subtype = "mermaid";
        incompleteDiagram.dataset.content = "nonempty";
        incompleteDiagram.dataset.render = "true";
        assert.equal(extract.rendererOutputCompleted(incompleteDiagram), false, "data-render precedes async output for nonempty Mermaid");
        incompleteDiagram.dataset.content = "";
        assert.equal(extract.rendererOutputCompleted(incompleteDiagram), true);
        incompleteDiagram.innerHTML = '<div class="ft__error">failed</div>';
        assert.equal(extract.rendererOutputCompleted(incompleteDiagram), false);

        reset();
        add("b", "html", "ordinary");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeHTMLBlock"><protyle-html></protyle-html></div>';
        const shadowHost = wysiwyg.querySelector("protyle-html");
        (shadowHost.shadowRoot || shadowHost.attachShadow({mode: "open"})).textContent = "ordinary";
        const directShadow = await search("ordinary");
        const shadowUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeFoldedBlocks: true});
        const directSelection = await source("frontend/pipeline").calculateSearchMatches({}, edit, "ordinary", {
            selectionOnly: true,
            selectionScope: new Map(shadowUnits.map((block) => [source("frontend/selection").unitKey(block.blockId, block.unitId), [{start: 0, end: block.text.length}]])),
            includeFoldedBlocks: true,
        });
        console.log("direct HTML shadow Text range parity", JSON.stringify({
            fullCount: directShadow.matches.length,
            rangeCount: directShadow.matches.filter((match) => match.range).length,
            selectionCount: directSelection.matches.length,
        }));
        full(directShadow);
        assert.equal(directShadow.matches.length, 1);
        assert.equal(directShadow.matches.filter((match) => match.range).length, 1);
        assert.equal(directSelection.matches.length, 1, "direct shadow Text supports selection ranges");

        reset();
        add("b", "query_embed", "query");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed" data-content="select * from blocks"><div spin="1"></div></div>';
        const probePreviousApi = api;
        api = async (url, ...args) => url.endsWith("getBlockDOMsWithEmbed") ? {code: 1} : probePreviousApi(url, ...args);
        try {
            const fallback = await search("ordinary");
            console.log("embed WithEmbed failure/plain fallback", JSON.stringify({
                count: fallback.matches.length, partial: fallback.partial,
                degraded: fallback.degraded, unrendered: fallback.unrendered, domCalls,
            }));
            assert.equal(fallback.unrendered, 1, "ordinary embed shells do not prove query success");
            assert.equal(fallback.partial, false, "failure must settle rather than remain indexing");
        } finally { api = probePreviousApi; }
        reset();
        add("b", "query_embed", "query");
        doms.b = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div spin="1"></div></div>';
        const successfulEmptyQuery = await search("ordinary");
        full(successfulEmptyQuery);
        assert.equal(successfulEmptyQuery.matches.length, 0, "successful empty query remains complete");
        assert.equal(document.querySelectorAll(".page-search-offscreen").length, 0);
        console.log("p1 regression contracts OK (mocked renderers/APIs)");
        return;
        for (const language of ["mermaid", "flowchart"]) {`;
const mod = new Module(fixture, module);
mod.filename = fixture;
mod.paths = Module._nodeModulePaths(path.dirname(fixture));
mod._compile(code.replace(marker, probes), fixture);
