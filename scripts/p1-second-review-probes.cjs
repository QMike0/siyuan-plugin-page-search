// P1 source regression contracts, with mocked SiYuan APIs and renderers.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const fixture = path.join(__dirname, "run-corpus-regressions.cjs");
const code = fs.readFileSync(fixture, "utf8").replace(/\r\n/g, "\n");
const marker = '    try {\n        for (const language of ["mermaid", "flowchart"]) {';
if (!code.includes(marker)) throw new Error("Fixture insertion point changed");
const probes = `    try {
        const compact = (result) => ({count: result.matches.length, partial: result.partial, degraded: result.degraded, unrendered: result.unrendered, units: result.matches.map((match) => match.unitId)});
        const slash = String.fromCharCode(92);
        for (const [text, pattern] of [
            [slash + "c0foo", slash + "c0foo"],
            [String.fromCharCode(1) + "foo", "[" + slash + "1]foo"],
            [String.fromCharCode(8) + "foo", "[" + slash + "10]foo"],
            [String.fromCharCode(16) + "foo", "[" + slash + "c0]foo"],
            [String.fromCharCode(31) + "foo", "[" + slash + "c_]foo"],
            [String.fromCharCode(1) + "foo", slash + "cAfoo"],
            [String.fromCharCode(1) + "foo", "[" + slash + "cA]foo"],
            ["8foo", "[" + slash + "8]foo"],
            ["afoo", "[a" + slash + "1]foo"],
        ]) {
            reset();
            add("b", "p", text);
            const groups = regex.extractRegexLiteralGroups(pattern, true, {unicode: false});
            const candidates = groups ? await sql.fetchLiteralGroupCandidateIds("r", groups, true, "content") : ["b"];
            console.log("legacy regex SQL superset", JSON.stringify({pattern, text, groups, candidates, finalHits: hit(text, pattern, {regex: true, regexUnicode: false, caseSensitive: true}).length}));
            assert.equal(hit(text, pattern, {regex: true, regexUnicode: false, caseSensitive: true}).length, 1);
            assert.ok(candidates.includes("b"), "legacy escape cannot exclude a final match");
            if (pattern === "[" + slash + "1]foo") assert.deepEqual(groups, [[{kind: "lit", text: "foo"}]], "retain the safe suffix prefilter");
            if (pattern === slash + "c0foo") {
                doms.b = '<div data-node-id="b" data-type="NodeParagraph">' + text + '</div>';
                const regexOptions = {regex: true, regexUnicode: false, caseSensitive: true};
                const unloaded = await search(pattern, regexOptions);
                full(unloaded);
                assert.equal(unloaded.matches.length, 1);
                console.log("unloaded legacy regex document", JSON.stringify(compact(unloaded)));
                wysiwyg.innerHTML = doms.b;
                const loaded = await search(pattern, regexOptions);
                full(loaded);
                assert.equal(loaded.matches.length, 1);
                console.log("live legacy regex document", JSON.stringify(compact(loaded)));
            }
        }
        reset();
        add("b", "c", "broken", "mermaid");
        // Official Mermaid catch inserts an error SVG next to .ft__error.
        const errorDom = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="broken" data-render="true"><div><svg><text>Syntax error</text></svg><div class="fn__hr"></div><div class="ft__error">failed</div></div></div>';
        wysiwyg.innerHTML = errorDom;
        doms.b = errorDom;
        const failedLive = await search("Syntax error");
        assert.equal(failedLive.matches.length, 0);
        assert.equal(failedLive.unrendered, 1);
        assert.equal(failedLive.partial, false);
        assert.equal(renderCalls, 0, "do not rerender an explicit mounted failure on every query");
        console.log("live failed Mermaid", JSON.stringify(compact(failedLive)));
        const failedUnits = source("frontend/blocks").collectSearchableBlocks(edit, {includeFoldedBlocks: true});
        const failedSelection = await source("frontend/pipeline").calculateSearchMatches({}, edit, "Syntax error", {
            selectionOnly: true,
            selectionScope: new Map(failedUnits.map((block) => [source("frontend/selection").unitKey(block.blockId, block.unitId), [{start: 0, end: block.text.length}]])),
            includeFoldedBlocks: true,
        });
        console.log("selection failed Mermaid", JSON.stringify(compact(failedSelection)));
        assert.equal(failedSelection.matches.length, 0);
        wysiwyg.innerHTML = "";
        const failedCached = await search("Syntax error");
        assert.equal(failedCached.matches.length, 0);
        assert.equal(failedCached.unrendered, 1);
        assert.equal(domCalls, 0, "failed live output enters the existing bounded negative cache");
        console.log("cached failed Mermaid after unload", JSON.stringify(compact(failedCached)));

        reset();
        add("b", "c", "same", "mermaid");
        const goodDom = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="same" data-render="true"><div><svg><text>healthy</text></svg></div></div>';
        wysiwyg.innerHTML = goodDom;
        full(await search("healthy"));
        assert.equal((await search("healthy")).matches.length, 1);
        wysiwyg.querySelector('[data-node-id="b"]').innerHTML = '<div><svg><text>healthy</text><text>Syntax error</text></svg><div class="ft__error">failed</div></div>';
        const becameFailed = await search("healthy");
        assert.equal(becameFailed.matches.length, 0);
        assert.equal(becameFailed.unrendered, 1);
        const failedHtml = wysiwyg.innerHTML;
        wysiwyg.innerHTML = "";
        const staleCache = await search("healthy");
        assert.equal(staleCache.matches.length, 0, "failure replaces an older successful cache of the same source");
        assert.equal(staleCache.unrendered, 1);
        wysiwyg.innerHTML = failedHtml;
        const disabledFailure = await search("healthy", {includeMermaid: false});
        full(disabledFailure);
        assert.equal(disabledFailure.matches.length, 0);
        wysiwyg.querySelector('[data-node-id="b"]').style.display = "none";
        full(await search("healthy"));
        wysiwyg.innerHTML = goodDom;
        const recoveredHealthy = await search("healthy");
        full(recoveredHealthy);
        assert.equal(recoveredHealthy.matches.length, 1, "healthy live output overrides prior failure");
        wysiwyg.innerHTML = "";
        full(await search("healthy"));
        assert.equal((await search("healthy")).matches.length, 1);
        assert.equal(renderCalls, 0);
        console.log("Mermaid success/failure/recovery cache transitions and gates OK");

        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="p" data-type="NodeParagraph">ordinary</div><div data-node-id="cold" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="same" data-render="true"><div></div></div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            host.querySelector('[data-node-id="cold"]').innerHTML = '<div><svg><text>recovered</text></svg></div>';
        }};
        assert.equal((await search("recovered")).matches.length, 1);
        wysiwyg.querySelector('[data-node-id="cold"]').innerHTML = '<div><svg><text>Syntax error</text></svg><div class="ft__error">failed</div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            host.querySelector('[data-node-id="cold"]').innerHTML = '<div><svg><text>Syntax error</text></svg><div class="ft__error">failed</div></div>';
        }};
        const embedBecameFailed = await search("recovered");
        assert.equal(embedBecameFailed.matches.length, 0, "embed recovery cache cannot hide a new explicit renderer failure");
        assert.equal(embedBecameFailed.unrendered, 1);
        assert.equal((await search("ordinary")).matches.length, 1);
        assert.equal((await search("Syntax error")).matches.length, 0);
        assert.equal(renderCalls, 2, "embed failure stays under existing retry backoff");
        console.log("embed recovered output becoming failure with unchanged source attributes OK");

        reset();
        add("b", "c", "broken", "mermaid");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content="broken"><div></div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
                block.setAttribute("data-render", "true");
                block.innerHTML = '<div><svg><text>Syntax error</text></svg><div class="ft__error">failed</div></div>';
            });
        }};
        const offscreenFailed = await search("^|Syntax error", {regex: true});
        assert.equal(offscreenFailed.matches.length, 0);
        assert.equal(offscreenFailed.unrendered, 1);
        console.log("offscreen failed Mermaid control", JSON.stringify(compact(offscreenFailed)));

        reset();
        add("l", "i", "", "", "r", 'fold="1"');
        add("b", "c", "broken", "mermaid", "l");
        wysiwyg.innerHTML = '<div data-node-id="l" data-type="NodeListItem" fold="1">' + errorDom + '</div>';
        window.Protyle = {mermaidRender: () => { renderCalls += 1; throw new Error("renderer unavailable"); }};
        const failedFolded = await search("Syntax error");
        assert.equal(failedFolded.matches.length, 0);
        assert.equal(failedFolded.unrendered, 1);
        assert.equal(renderCalls, 0);
        full(await search("Syntax error", {includeFoldedBlocks: false}));
        assert.equal((await search("Syntax error")).unrendered, 1);
        assert.equal(renderCalls, 0);
        console.log("folded failed Mermaid fallback", JSON.stringify({...compact(failedFolded), renderCalls}));

        reset();
        add("b", "m", "broken");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeMathBlock" data-subtype="math" data-content="broken" data-render="true"><div><div class="ft__error">failed</div></div></div>';
        doms.b = wysiwyg.innerHTML;
        window.Protyle = {mathRender: () => {}};
        console.log("live failed block math control", JSON.stringify(compact(await search("failed"))));

        reset();
        add("b", "query_embed", "query");
        // Renderer dependencies can include inline styles and structural content
        // inside a folded/pending block, while root attributes remain unchanged.
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="p" data-type="NodeParagraph"><span data-type="strong"><span data-type="inline-math" data-subtype="math" data-content="a"><span></span></span></span></div></div>';
        window.Protyle = {mathRender: (host) => {
            renderCalls += 1;
            host.querySelectorAll('span[data-type~="inline-math"]').forEach((span) => {
                span.setAttribute("data-render", "true");
                span.innerHTML = '<span class="katex-html">α</span>';
            });
        }};
        console.log("recovered formula in strong", JSON.stringify(compact(await search("α", {restrictInlineTypes: ["strong", "inline-math"]}))));

        reset();
        add("b", "c", "", "mermaid");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content=""><div></div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            window.setTimeout(() => host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
                block.setAttribute("data-render", "true");
                block.innerHTML = '<div><span>&#8203;</span></div>';
            }), 10);
        }};
        const asyncEmpty = await search("^|ordinary", {regex: true});
        full(asyncEmpty);
        assert.equal(asyncEmpty.matches.length, 0);
        console.log("asynchronous empty Mermaid", JSON.stringify({...compact(asyncEmpty), renderCalls, domCalls}));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const asyncEmptyAgain = await search("^|ordinary", {regex: true});
        full(asyncEmptyAgain);
        assert.equal(renderCalls, 1, "completed empty output is positively cached");
        assert.equal(domCalls, 1);
        console.log("asynchronous empty Mermaid second search", JSON.stringify({...compact(asyncEmptyAgain), renderCalls, domCalls}));

        reset();
        add("b", "c", "", "mermaid");
        add("p", "p", "ordinary");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content=""><div></div></div>';
        wysiwyg.innerHTML = '<div data-node-id="p" data-type="NodeParagraph">ordinary</div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            const blocks = Array.from(host.querySelectorAll('[data-subtype="mermaid"]'));
            window.setTimeout(() => blocks.forEach((block) => {
                block.setAttribute("data-render", "true");
                block.innerHTML = '<div><span>&#8203;</span></div>';
            }), 10);
        }};
        corpus.retainBackgroundCorpusRoot("r");
        try {
            const ordinaryWithEmpty = await settle("ordinary");
            full(ordinaryWithEmpty);
            assert.equal(ordinaryWithEmpty.matches.length, 1);
            assert.equal(renderCalls, 1);
            console.log("ordinary query with asynchronous empty Mermaid", JSON.stringify({...compact(ordinaryWithEmpty), renderCalls, domCalls}));
        } finally {
            corpus.releaseBackgroundCorpusRoot("r");
        }

        reset();
        add("b", "c", "", "mermaid");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content=""><div></div></div>';
        window.Protyle = {mermaidRender: (host) => {
            renderCalls += 1;
            host.querySelectorAll('[data-subtype="mermaid"]').forEach((block) => {
                block.setAttribute("data-render", "true");
                block.innerHTML = '<div><span>&#8203;</span></div>';
            });
        }};
        const syncEmpty = await search("^|ordinary", {regex: true});
        full(syncEmpty);
        assert.equal(syncEmpty.matches.length, 0);
        console.log("synchronous empty Mermaid control", JSON.stringify({...compact(syncEmpty), renderCalls, domCalls}));

        const offscreen = source("frontend/corpus/offscreen");
        const makeDiagramHost = (language, content, ready = false) => {
            const host = offscreen.createOffscreenHost();
            const body = offscreen.offscreenWysiwyg(host);
            body.innerHTML = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + language + '" data-content="' + content + '"' + (ready ? ' data-render="true"' : '') + '><div></div></div>';
            return {host, body};
        };
        // Empty SVG-less Mermaid that is already complete must not load/render again.
        reset();
        const completedEmpty = makeDiagramHost("mermaid", "", true);
        let emptyRerenders = 0;
        window.Protyle = {mermaidRender: (host) => {
            emptyRerenders += host.querySelectorAll('[data-subtype="mermaid"]:not([data-render="true"])').length;
        }};
        try {
            await offscreen.renderOffscreenBlocks(completedEmpty.body, "diagram");
            assert.equal(extract.rendererOutputCompleted(completedEmpty.body.firstElementChild), true);
            assert.equal(emptyRerenders, 0);
        } finally { completedEmpty.host.remove(); }

        reset();
        let waitCount = 0;
        const actualSetTimeout = window.setTimeout;
        window.setTimeout = (...args) => { waitCount += 1; return actualSetTimeout(...args); };
        try {
            for (const [language, available] of [["flowchart", true], ["mermaid", false]]) {
                const emptyHost = makeDiagramHost(language, "");
                window.Protyle = available ? {flowchartRender: () => {}} : {};
                try { await offscreen.renderOffscreenBlocks(emptyHost.body, "diagram"); }
                finally { emptyHost.host.remove(); }
            }
            assert.equal(waitCount, 0, "no new timeout for empty other diagram types or unavailable renderers");
        } finally { window.setTimeout = actualSetTimeout; }

        reset();
        const pendingNonempty = makeDiagramHost("mermaid", "nonempty");
        window.Protyle = {mermaidRender: (host) => {
            const block = host.firstElementChild;
            block.setAttribute("data-render", "true");
            window.setTimeout(() => { block.innerHTML = '<div><svg><text>later</text></svg></div>'; }, 10);
        }};
        try {
            await offscreen.renderOffscreenBlocks(pendingNonempty.body, "diagram");
            assert.equal(pendingNonempty.body.querySelector("svg text").textContent, "later", "nonempty data-render cannot bypass pending SVG wait");
        } finally { pendingNonempty.host.remove(); }

        reset();
        add("b", "c", "", "mermaid");
        doms.b = '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="mermaid" data-content=""><div></div></div>';
        window.Protyle = {mermaidRender: () => { renderCalls += 1; }};
        const emptyAbort = new AbortController();
        const abortTimer = setTimeout(() => emptyAbort.abort(), 20);
        try {
            const cancelledEmpty = await search("^|ordinary", {regex: true, signal: emptyAbort.signal});
            assert.equal(cancelledEmpty.cancelled, true);
            assert.equal(document.querySelectorAll('[data-page-search-offscreen="1"]').length, 0);
            window.Protyle = {mermaidRender: (host) => host.querySelector('[data-subtype="mermaid"]').setAttribute("data-render", "true")};
            full(await search("^|ordinary", {regex: true}));
        } finally { clearTimeout(abortTimer); }
        console.log("empty completion, nonempty async output, wait budget and cancellation OK");

        reset();
        add("b", "query_embed", "query");
        wysiwyg.innerHTML = '<div data-node-id="b" data-type="NodeBlockQueryEmbed"><div data-node-id="p" data-type="NodeParagraph"><span data-type="inline-math" data-subtype="math" data-content="a"><span></span></span></div></div>';
        window.Protyle = {mathRender: (host) => host.querySelectorAll('span[data-type~="inline-math"]').forEach((span) => {
            span.setAttribute("data-render", "true");
            span.innerHTML = '<span class="katex-html">α</span>';
        })};
        console.log("formula before hiding output", JSON.stringify(compact(await search("α"))));
        wysiwyg.querySelector('span[data-type~="inline-math"]').innerHTML = '<span class="katex-html" style="display:none">α</span>';
        console.log("formula output hidden", JSON.stringify(compact(await search("α"))));

        reset();
        const subtypePairs = [["mermaid", "flowchart"], ["flowchart", "mermaid"]];
        for (const [metaLanguage, domLanguage] of subtypePairs) {
            add("b", "c", "foo", metaLanguage);
            const collected = await extract.extractUnitsFromDoms(["b"], {b: '<div data-node-id="b" data-type="NodeCodeBlock" data-subtype="' + domLanguage + '" data-content="foo"><div></div></div>'}, {}, new Set(), "diagram", () => true, undefined, new Map([["b", metaLanguage]]));
            console.log("DOM/SQL language divergence", JSON.stringify({metaLanguage, domLanguage, text: collected.blocks.map((block) => block.text), units: collected.blocks.map((block) => block.unitId), unrendered: collected.unrenderedIds}));
            collected.dispose();
            reset();
        }
        console.log("second review probes completed");
        return;
        for (const language of ["mermaid", "flowchart"]) {`;
const mod = new Module(fixture, module);
mod.filename = fixture;
mod.paths = Module._nodeModulePaths(path.dirname(fixture));
mod._compile(code.replace(marker, probes), fixture);
