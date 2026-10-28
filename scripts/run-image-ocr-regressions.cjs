const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {DatabaseSync} = require("node:sqlite");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
let editors = [], calls = [], responder = async () => ({code: -1});
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {
        Plugin: class {},
        getAllEditor: () => editors,
        fetchSyncPost: async (...args) => { calls.push(args); return responder(...args); },
    };
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(
    fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'),
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}},
).outputText, file);
require.extensions[".scss"] = () => {};
const source = file => require(path.resolve(__dirname, "../src", file + ".ts"));
const {window} = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
Object.assign(global, {window, document: window.document, CSS: {escape: value => value}});
for (const key of ["Node", "Element", "HTMLElement", "Text", "NodeFilter", "Range", "ShadowRoot", "MutationObserver",
    "HTMLTableElement", "HTMLTableRowElement", "HTMLTableCellElement"]) global[key] = window[key];
global.getComputedStyle = window.getComputedStyle.bind(window);
window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
require(process.env.SIYUAN_LUTE_PATH || path.resolve(__dirname, "../../tmp/rich-cell-v387/lute-v388.js"));
const lute = (window.Lute ?? global.Lute).New();
lute.SetProtyleWYSIWYG(true);
const {collectSearchableBlocks, collectMindmapPreviewUnits} = source("frontend/blocks");
const {freezeBlock} = source("frontend/corpus/units");
const {invalidateImageOCRCache, resolveImageOCRUnits} = source("frontend/image-ocr");
const {imageOCRPath, isImageOCRUnit} = source("shared/image-ocr");
const {calculateSearchMatches} = source("frontend/pipeline");
const project = source("frontend/corpus/project");
const {createRangeFromBlockOffsets} = source("frontend/ranges");
const {createReplacementReasonReader} = source("frontend/replacement-reasons");
const write = source("frontend/protyle-write");
const {createReplacementUnitLookup} = source("frontend/replacement");
const {mergeVirtualTableUnits} = source("shared/table-live");
const visual = source("frontend/code-language-visual");
const {SearchBar} = source("frontend/search-bar");
const corpus = source("frontend/corpus/search");
const edit = document.createElement("div");
edit.className = "protyle";
edit.innerHTML = '<div class="protyle-content"><div class="protyle-wysiwyg"></div></div>';
document.body.append(edit);
const wysiwyg = edit.querySelector(".protyle-wysiwyg");
const content = edit.querySelector(".protyle-content");
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const ocrText = new Map([["assets/one.png", "OCRneedle twice OCRneedle"], ["assets/two.png", "another OCRneedle"]]);
const readOCR = (url, body, _headers, process, signal) => {
    if (url === "/api/asset/getImageOCRText") {
        assert.equal(process, false, "read failure must not display native error messages");
        assert.ok(!signal?.aborted);
        return {code: 0, data: {text: ocrText.get(body.path) ?? "", failed: false}};
    }
    return {code: -1};
};
async function main() {
    responder = readOCR;
    wysiwyg.innerHTML = lute.Md2BlockDOM("body OCRneedle ![alt](assets/one.png) after\n\n![other](assets/one.png) ![](assets/two.png)");
    const nativeImage = wysiwyg.querySelector(".img img");
    assert.ok(nativeImage);
    assert.equal(nativeImage.getAttribute("data-src"), "assets/one.png", "v3.8.8 renderer keeps the original OCR URL");
    nativeImage.setAttribute("src", "/api/asset/thumbnail?path=one");
    const before = wysiwyg.innerHTML;
    const blocks = collectSearchableBlocks(edit);
    assert.equal(blocks.filter(isImageOCRUnit).length, 3);
    assert.equal(imageOCRPath(blocks.find(isImageOCRUnit).unitId), "assets/one.png");
    assert.ok(blocks.filter(isImageOCRUnit).every(u => freezeBlock(u).segmentLengths === undefined));
    const found = await calculateSearchMatches({}, edit, "OCRneedle");
    const images = found.matches.filter(isImageOCRUnit);
    assert.equal(found.matches.length, 6, "body and three image occurrences are independent");
    assert.equal(images.length, 5);
    assert.deepEqual(images.map(h => [...wysiwyg.querySelectorAll(".img img")].indexOf(visual.imageOCRFrameHost(h.range))),
        [0, 0, 1, 1, 2], "one picture's OCR offsets cannot interleave with the next picture");
    assert.equal(calls.filter(([url]) => url.includes("getImageOCRText")).length, 2, "same source read once per query");
    assert.ok(images.every(hit => hit.range && !hit.replaceable && hit.replaceReason === "imageOCR"));
    assert.equal(createReplacementReasonReader()(images[0]), "imageOCR");
    assert.ok(write.isMatchContentWritable(found.matches.find(hit => !isImageOCRUnit(hit))), "ordinary body remains writable");
    assert.equal(write.isMatchContentWritable({...images[0], replaceable: true}), false);
    const original = blocks.find(u => u.unitId === images[0].unitId && u.blockId === images[0].blockId);
    assert.equal(createReplacementUnitLookup(new Map([[`${original.blockId}::${original.unitId}`, original]]))(images[0]), undefined);
    const readCount = calls.length;
    assert.equal((await write.replaceCurrentMatchInEditor(edit, {...images[0], replaceable: true}, "x")).replacedCount, 0);
    assert.equal((await write.replaceAllMatchesInEditor(edit, [{...images[0], replaceable: true}], "x")).skippedCount, 1);
    assert.equal(calls.length, readCount, "forced OCR replacement issues no reads or writes");
    assert.equal(wysiwyg.innerHTML, before);
    assert.equal((await calculateSearchMatches({}, edit, "assets/one.png")).matches.length, 0, "URL placeholder never matches");
    assert.equal((await calculateSearchMatches({}, edit, "OCRn[a-z]+", {regex: true})).matches.length, 6);
    assert.equal((await calculateSearchMatches({}, edit, "ocrneedle", {caseSensitive: true})).matches.length, 0);
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeParagraph: false})).matches.length, 0);
    const beforeOff = calls.length;
    const withoutOCR = await calculateSearchMatches({}, edit, "OCRneedle", {includeImageOCR: false});
    assert.equal(withoutOCR.matches.length, 1, "OCR off preserves ordinary body matches");
    assert.equal(withoutOCR.matches[0].replaceable, true);
    assert.equal(calls.length, beforeOff, "OCR off never reads recognition text");
    assert.equal(project.projectRanges(edit, images, {includeImageOCR: false}).filter(hit => hit.range).length, 0,
        "disabled OCR cannot rebind old image frames");
    const selectedBlock = wysiwyg.children[0];
    selectedBlock.classList.add("protyle-wysiwyg--select");
    const selectionScope = source("frontend/selection").getSelectionScope(edit, collectSearchableBlocks(edit));
    selectedBlock.classList.remove("protyle-wysiwyg--select");
    invalidateImageOCRCache();
    calls = [];
    const selected = await calculateSearchMatches({}, edit, "OCRneedle", {selectionOnly:true, selectionScope});
    assert.equal(selected.matches.length,3,"whole-block selection includes the picture's complete OCR text");
    assert.equal(calls.filter(([url])=>url.includes("getImageOCRText")).length,1,"unselected pictures are not read");
    const textRange = document.createRange();
    textRange.selectNodeContents(wysiwyg.querySelector('[contenteditable="true"]').firstChild);
    window.getSelection().addRange(textRange);
    calls = [];
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {selectionOnly:true})).matches.length,1);
    assert.equal(calls.filter(([url])=>url.includes("getImageOCRText")).length,0,"text-only selection never includes adjacent picture OCR");
    window.getSelection().removeAllRanges();
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {selectionOnly:true, selectionScope, includeImageOCR:false})).matches.length,1);
    calls = [];
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {restrictInlineTypes: ["strong"]})).matches.length, 0);
    assert.equal(calls.filter(([url]) => url.includes("getImageOCRText")).length, 0, "inline-only query does not request OCR");
    // Rebinding an unloaded image needs no OCR API or text-offset approximation.
    const rebound = project.fillLiveRanges(images.map(h => ({...h, range: undefined})), collectSearchableBlocks(edit), true);
    assert.ok(rebound.every(h => h.range));
    assert.equal(calls.length, 0);
    const changedImage = wysiwyg.querySelectorAll(".img img")[1];
    changedImage.setAttribute("data-src", "assets/new.png");
    const removedIdentity = project.projectRanges(edit, images, {includeFoldedBlocks: true});
    assert.equal(removedIdentity.filter(h => !h.range).length, 2, "different URL at same position cannot borrow old OCR highlight");
    changedImage.setAttribute("data-src", "assets/one.png");

    content.getBoundingClientRect = () => rect(10, 20, 600, 400);
    const imgs = [...wysiwyg.querySelectorAll(".img img")];
    imgs.forEach((img, i) => { img.getBoundingClientRect = () => rect(30, 50 + i * 70, 200, 60); });
    visual.applyCodeLanguageVisual(edit, images.map(h => h.range), images[0].range);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length, 3, "one frame per picture, even multiple hits");
    assert.equal(edit.querySelectorAll(".is-focus").length, 1);
    assert.equal(visual.imageOCRFrameHost(images[0].range), imgs[0]);
    assert.equal(wysiwyg.innerHTML, before, "frames do not alter note DOM");
    const bar = Object.create(SearchBar.prototype);
    Object.assign(bar, {edit, resultMatches: images, resultIndex: 1, memoUnderlineLayoutRaf: 0});
    bar.syncMemoUnderlineVisual();
    const stop = bar.stopMemoUnderlineLayoutSync;
    bar.syncMemoUnderlineVisual();
    assert.equal(bar.stopMemoUnderlineLayoutSync, stop);
    bar.resultIndex = images.length;
    bar.syncMemoUnderlineVisual();
    assert.equal(edit.querySelector(".is-focus").style.top, "170px");
    bar.resultMatches = [];
    bar.syncMemoUnderlineVisual();
    assert.equal(edit.querySelectorAll(".page-search-code-language-layer").length, 0);
    assert.equal(bar.stopMemoUnderlineLayoutSync, null);
    console.log("OCR live: native URLs, duplicate instances, literal/regex, readonly isolation, frame focus/cleanup and rebinding OK");

    // Native containers and embed copies follow their existing scope gates.
    const imageParagraph = lute.Md2BlockDOM("![](assets/one.png)");
    wysiwyg.innerHTML = '<div data-type="NodeCallout" data-node-id="callout" class="callout" fold="1"><div class="callout-content">' +
        imageParagraph + '</div></div>';
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeFoldedBlocks:true})).matches.length,2);
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeFoldedBlocks:false})).matches.length,0);
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeCallout:false})).matches.length,0);
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeFoldedBlocks:true, includeImageOCR:false})).matches.length,0);
    wysiwyg.innerHTML = '<div data-type="NodeBlockQueryEmbed" data-node-id="embed" class="render-node">' +
        imageParagraph + '</div>';
    const embedded = await calculateSearchMatches({}, edit, "OCRneedle");
    assert.equal(embedded.matches.length,2);
    assert.ok(embedded.matches.every(h=>h.unitId.startsWith("embed:") && !h.replaceable));
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeEmbedBlock:false})).matches.length,0);
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeImageOCR:false})).matches.length,0);

    // Ordinary native table: OCR must not collapse cell text or change the virtual-table overlay.
    wysiwyg.innerHTML = lute.Md2BlockDOM("| image | text |\n| --- | --- |\n| ![](assets/one.png) | ordinary |");
    const tableUnits = collectSearchableBlocks(edit);
    const tableOCR = tableUnits.find(isImageOCRUnit);
    assert.ok(tableOCR?.tableSlot && tableOCR.unitId.startsWith("table-cell:1:0:image-ocr:"));
    const tableFound = await calculateSearchMatches({}, edit, "OCRneedle");
    assert.equal(tableFound.matches.length, 2);
    assert.ok(tableFound.matches.every(h => h.range && !h.replaceable));
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeImageOCR:false})).matches.length,0);
    const frozen = tableUnits.map(u => freezeBlock(u));
    const textCell = frozen.find(u => u.text === "ordinary");
    const state = new Map([[textCell.blockId, {shownKeys: new Set(["1:1"]), liveByKey: new Map([["1:1", {...textCell, text:"edited"}]]), unstable:false}]]);
    const merged = mergeVirtualTableUnits(frozen, state);
    assert.ok(merged.units.some(u => isImageOCRUnit(u)));
    assert.ok(merged.units.some(u => u.text === "edited"), "OCR side unit does not disable existing table overlay");
    console.log("OCR tables: independent image identity and text overlay preservation OK");

    // Full document: blocks.content deliberately lacks OCR. Cold/folded matches rely on image hosts.
    const db = new DatabaseSync(":memory:");
    db.function("search_normalize", (text, sensitive) => sensitive ? String(text) : String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT, root_id TEXT, parent_id TEXT, type TEXT, subtype TEXT, content TEXT, markdown TEXT, ial TEXT, hash TEXT, updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT, block_id TEXT, root_id TEXT, type TEXT)");
    const native = document.createElement("div");
    native.innerHTML = lute.Md2BlockDOM("# Fold\n\n![](assets/one.png)\n\n![](assets/two.png)");
    const nativeBlocks = [...native.children];
    const doms = Object.fromEntries(nativeBlocks.map(el => [el.dataset.nodeId, el.outerHTML]));
    const insert = db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)");
    nativeBlocks.forEach((el,i) => insert.run(el.dataset.nodeId, "root", "root", i ? "p" : "h", i ? "" : "h1", i ? "" : "Fold",
        i ? `![](assets/${i===1?"one":"two"}.png)` : "# Fold", i ? "" : '{: fold="1"}', `hash-${i}`, "1"));
    const heading = nativeBlocks[0];
    heading.setAttribute("fold", "1");
    wysiwyg.innerHTML = heading.outerHTML;
    editors = [{protyle: {element: edit, notebookId: "", block: {id:"root", rootID:"root"}}}];
    calls = [];
    responder = async (url, body, ...rest) => {
        if (url === "/api/query/sql") return {code:0, data:db.prepare(body.stmt).all()};
        if (url === "/api/block/getDocBlocksOrders") return {code:0, data:nativeBlocks.map(el => el.dataset.nodeId)};
        if (url.includes("getHeadingChildren")) return {code:0, data:nativeBlocks.slice(1).map(el => el.dataset.nodeId)};
        if (url === "/api/block/getBlockDOMs") return {code:0, data:Object.fromEntries(body.ids.map(id => [id, doms[id]]))};
        return readOCR(url, body, ...rest);
    };
    corpus.invalidateDocumentSearchCaches();
    const search = (query, options={}) => corpus.searchCurrentDocument({}, edit, query,
        {includeAttributeView:false, includeFoldedBlocks:true, ...options});
    const cold = await search("OCRneedle");
    assert.equal(cold.matches.length, 3);
    assert.equal(cold.degraded, false);
    assert.ok(cold.matches.every(h => !h.range && !h.replaceable));
    invalidateImageOCRCache();
    calls = [];
    const disabledCold = await search("OCRneedle", {includeImageOCR:false});
    assert.equal(disabledCold.matches.length,0,"OCR off also excludes unloaded/folded image hosts");
    assert.equal(disabledCold.partial,false,"disabled OCR does not make coverage incomplete");
    assert.equal(calls.filter(([url])=>url.includes("getImageOCRText")).length,0);
    assert.equal((await search("OCRneedle")).matches.length,3,"re-enabling OCR does not reuse the disabled collection cache");
    assert.equal((await search("OCRneedle", {includeFoldedBlocks:false})).matches.length, 0);
    ocrText.set("assets/one.png", "brandNewOCR");
    invalidateImageOCRCache(); // native siyuan-image-ocr / databaseIndexCommit notification
    const fresh = await search("brandNewOCR");
    assert.equal(fresh.matches.length, 1, "OCR edits invalidate neither hash nor candidate identity; text is re-read");
    assert.equal((await search("OCRneedle")).matches.length, 1, "old OCR text is never retained by block cache");
    wysiwyg.innerHTML = nativeBlocks.map(el => el.outerHTML).join("");
    wysiwyg.firstElementChild.removeAttribute("fold");
    const mounted = project.fillLiveRanges(fresh.matches, collectSearchableBlocks(edit), true);
    assert.ok(mounted[0].range);
    console.log("OCR corpus: unloaded/folded areas, absent content index, updated OCR with unchanged hashes OK");

    const wrap = (path, i=0) => ({blockId:`b${i}`, text:path, unitId:`image-ocr:${i}:${encodeURIComponent(path)}`});
    invalidateImageOCRCache();
    let active = 0, peak = 0, releases = [];
    calls = [];
    responder = async (url, body, headers, process, signal) => {
        assert.equal(url, "/api/asset/getImageOCRText");
        active++; peak=Math.max(peak,active);
        await new Promise(resolve => releases.push(resolve));
        active--;
        return {code:0,data:{text:"ok"}};
    };
    const abort = new AbortController();
    const waiting = resolveImageOCRUnits(Array.from({length:40},(_,i)=>wrap(`assets/${i}.png`,i)), abort.signal);
    await Promise.resolve();
    assert.equal(peak,4);
    abort.abort(); releases.forEach(resolve=>resolve());
    await waiting;
    assert.equal(calls.length,4,"cancelled query stops queued reads");
    responder = async () => ({code:-1});
    const unavailable = await resolveImageOCRUnits([wrap("assets/missing.png")]);
    assert.equal(unavailable.units[0].text,"");
    assert.deepEqual(unavailable.failedIds,["b0"]);
    responder = async () => ({code:0,data:{text:"",failed:true}});
    assert.deepEqual((await resolveImageOCRUnits([wrap("assets/missing.png")])).failedIds,[],"unrecognized/failed OCR is normally empty");
    responder = async () => ({code:0,data:{text:"x".repeat(512*1024+1)}});
    assert.equal((await resolveImageOCRUnits([wrap("assets/huge.png")])).failedIds.length,1);
    responder = async () => ({code:0,data:{text:"x".repeat(100*1024)}});
    const large = await resolveImageOCRUnits(Array.from({length:60},(_,i)=>wrap("assets/repeated.png",i)));
    assert.ok(large.failedIds.length > 0, "repeated images cannot bypass the worker input budget");
    assert.ok(large.units.reduce((n,u)=>n+u.text.length*2,0)<=8*1024*1024);
    console.log("OCR reads: bounded concurrency, per-query deduplication, cancellation, failure and output budgets OK");
    db.close();
    await scopeAndProjectionRegressions();
    clippingRegressions();
    await mindmapFrameMotionRegressions();
    await cacheRegressions(wrap);
    await notificationRegressions(wrap);
    await imageMenuRegressions();
}

async function imageMenuRegressions() {
    const {DEFAULT_PREFS, coercePluginPrefs, mergePrefs} = source("shared/rpc-types");
    assert.equal(coercePluginPrefs({includeImageTitle:false}).includeImageOCR,true,"old prefs retain OCR search by default");
    let stored = DEFAULT_PREFS;
    const plugin = new (source("index").default)();
    const patches = [];
    plugin.kernel = {state:{code:2},rpc:{call:{"prefs.set":async patch=>{
        patches.push(patch); stored=mergePrefs(stored,patch); return stored;
    }}}};
    const createBar = () => {
        const bar = Object.create(SearchBar.prototype);
        Object.assign(bar,{edit,plugin,includeImageTitle:true,includeImageOCR:true,searchText:"OCRneedle",
            buildMatchSwitchMenuItem: options=>options,highlightHitResult:async()=>{}});
        return bar;
    };
    const bar = createBar(), other = createBar();
    plugin.searchBars.set(edit,bar); plugin.searchBars.set(document.createElement("div"),other);
    for (const lang of ["zh-CN","en"]) {
        plugin.i18n = JSON.parse(fs.readFileSync(path.resolve(__dirname,"../src/i18n",lang+".json"),"utf8"));
        bar.i18n = plugin.getSearchI18n();
        const menu = bar.buildImageMenuItem();
        assert.equal(menu.label,plugin.i18n.settingsIncludeImage);
        assert.equal(menu.type,"submenu");
        assert.deepEqual(menu.submenu.map(item=>item.label),[plugin.i18n.settingsIncludeImageTitle,plugin.i18n.settingsIncludeImageOCR]);
        assert.deepEqual(menu.submenu.map(item=>item.checked),[true,true]);
    }
    await bar.setIncludeImageOCR(false);
    assert.equal(stored.includeImageOCR,false,"OCR preference is saved");
    assert.equal(other.includeImageOCR,false,"other panels follow the OCR switch");
    assert.equal(stored.includeImageTitle,true,"OCR switch leaves title preference unchanged");
    await bar.setIncludeImageOCR(false);
    assert.equal(patches.length,1,"an unchanged switch does not save or refresh again");
    await bar.setIncludeImageTitle(false);
    assert.equal(stored.includeImageOCR,false,"unrelated preference changes preserve OCR off");
    assert.equal(other.includeImageTitle,false);
    assert.equal(coercePluginPrefs(JSON.parse(JSON.stringify(stored))).includeImageOCR,false,"OCR choice survives preference reload");
    await bar.setIncludeImageOCR(true);
    assert.equal(other.includeImageOCR,true);
    assert.equal(other.includeImageTitle,false,"switches remain independent");
    plugin.searchBars.clear();
    editors=[]; responder=readOCR; invalidateImageOCRCache();
    ocrText.set("assets/one.png","OCRneedle twice OCRneedle");
    wysiwyg.innerHTML=lute.Md2BlockDOM('![](assets/one.png "captionOCR")');
    assert.equal((await calculateSearchMatches({},edit,"captionOCR",{includeImageOCR:false})).matches.length,1,"OCR off preserves image titles");
    assert.equal((await calculateSearchMatches({},edit,"OCRneedle",{includeImageTitle:false})).matches.length,2,"title off preserves OCR");
    assert.equal((await calculateSearchMatches({},edit,"captionOCR",{includeImageTitle:false})).matches.length,0);
    console.log("Image menu: independent title/OCR switches, legacy defaults, persistence, panel sync and body isolation OK");
}

async function scopeAndProjectionRegressions() {
    editors = [];
    for (const name of ["TextMark", "BlockRef", "KramdownIAL", "ProtyleWYSIWYG", "HTMLTag2TextMark", "DataTask", "EnsureListItemParagraph"]) lute["Set"+name](true);
    ocrText.set("assets/one.png", "OCRneedle twice OCRneedle");
    responder = readOCR;
    invalidateImageOCRCache();
    wysiwyg.innerHTML = lute.Md2BlockDOM("| image |\n| --- |\n| ![](assets/one.png) |");
    calls = [];
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeTable:false})).matches.length, 0);
    assert.equal(calls.length, 0, "disabled table does not read OCR");
    const table = wysiwyg.firstElementChild;
    table.classList.add("protyle-wysiwyg--select");
    const selectionScope = source("frontend/selection").getSelectionScope(edit, collectSearchableBlocks(edit));
    table.classList.remove("protyle-wysiwyg--select");
    assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {selectionOnly:true, selectionScope, includeTable:false})).matches.length, 0);

    const richId = "20261025000000-abcdefg";
    const richTable = markdown => {
        const encoded = Buffer.from(JSON.stringify({spec:1, format:"kramdown", content:markdown})).toString("base64url");
        return lute.SpinBlockDOM(`<div data-type="NodeTable" data-node-id="${richId}" custom-sy-table-rich="1"><div contenteditable="true"><table><thead><tr><th data-sy-table-cell-rich="${encoded}"></th></tr></thead></table></div></div>`);
    };
    for (const [md, option] of [
        ["# heading ![](assets/one.png)", "includeHeadingH1"],
        ["- ![](assets/one.png)", "includeListUnordered"],
        ["1. ![](assets/one.png)", "includeListOrdered"],
        ["- [ ] ![](assets/one.png)", "includeListTask"],
    ]) {
        wysiwyg.innerHTML = richTable(md);
        assert.ok(wysiwyg.querySelector("img"));
        const cold = await calculateSearchMatches({}, edit, "OCRneedle");
        assert.equal(cold.matches.length, 2, "native raw rich preview includes the image");
        assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {includeImageOCR:false})).matches.length,0);
        assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {[option]:false})).matches.length, 0, option + " gates raw preview");
        const cell = wysiwyg.querySelector("[data-sy-table-cell-rich]");
        cell.innerHTML = '<div class="table__cell-rich">' + lute.Md2BlockDOM(md) + '</div>';
        cell.querySelectorAll("[data-node-id]").forEach(node => {node.removeAttribute("data-node-id"); node.setAttribute("data-table-cell-node", "");});
        const live = await calculateSearchMatches({}, edit, "OCRneedle");
        assert.deepEqual(live.matches.map(h=>h.unitId), cold.matches.map(h=>h.unitId));
        assert.equal((await calculateSearchMatches({}, edit, "OCRneedle", {[option]:false})).matches.length, 0, option + " gates hydrated preview");
        assert.ok(project.fillLiveRanges(cold.matches.map(h=>({...h,range:undefined})), collectSearchableBlocks(edit), true).every(h=>h.range));
    }
    // Hiding a preceding image by type must not change the following image's identity.
    wysiwyg.innerHTML = richTable("# ![](assets/one.png)\n\n![](assets/two.png)");
    const both = collectSearchableBlocks(edit).filter(isImageOCRUnit);
    const onlySecond = collectSearchableBlocks(edit, {includeHeadingH1:false}).filter(isImageOCRUnit);
    assert.equal(onlySecond.length,1);
    assert.equal(onlySecond[0].unitId,both[1].unitId);

    const native = document.createElement("div");
    native.innerHTML = lute.Md2BlockDOM("![](assets/one.png)");
    const paragraph = native.firstElementChild;
    paragraph.dataset.nodeId = "para";
    const preview = paragraph.cloneNode(true);
    preview.removeAttribute("data-node-id"); preview.dataset.mindmapSourceId = "para";
    const style = document.createElement("style");
    style.textContent = '[data-mindmap-view-rendered="true"] > .mindmap-item {display:none}';
    document.head.append(style);
    const mapDOM = '<div data-type="NodeMindmap" data-node-id="mind" data-mindmap-view-rendered="true"><div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' +
        paragraph.outerHTML + '</div><div class="mindmap-view">' + preview.outerHTML + '</div></div>';
    wysiwyg.innerHTML = mapDOM;
    let found = await calculateSearchMatches({},edit,"OCRneedle");
    assert.equal(found.matches.length,2,"picture-only mounted mindmap includes OCR exactly once");
    assert.ok(found.matches.every(h=>visual.imageOCRFrameHost(h.range)?.closest(".mindmap-view")));
    assert.equal((await calculateSearchMatches({},edit,"OCRneedle",{includeMindmap:false})).matches.length,0);
    assert.equal((await calculateSearchMatches({},edit,"OCRneedle",{includeParagraph:false})).matches.length,0);
    const rebound = project.fillLiveRanges(found.matches.map(h=>({...h,range:undefined})), collectMindmapPreviewUnits([edit]), true);
    assert.ok(rebound.every(h=>h.range));
    const nav = Object.create(SearchBar.prototype);
    Object.assign(nav,{edit,resultMatches:found.matches.map(h=>({...h,range:undefined})),includeFoldedBlocks:true,
        queueRangeRepairBlock:()=>{},repairHighlightRanges:async()=>{}});
    assert.equal(nav.bindMindmapPreview(0),true,"navigation rebinds the actual visible image clone");

    invalidateImageOCRCache();
    const beforeCopies = calls.length;
    wysiwyg.innerHTML = mapDOM + ["one", "two"].map(id =>
        '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-' + id + '" class="render-node">' + mapDOM + '</div>').join("");
    const copies = await calculateSearchMatches({}, edit, "OCRneedle");
    assert.equal(copies.matches.length, 6, "source and repeated embedded canvases each retain their visible image hits");
    assert.deepEqual([...new Set(copies.matches.map(hit => hit.blockId))], ["para", "embed-one", "embed-two"]);
    assert.ok(copies.matches.every(hit => hit.range && !hit.replaceable));
    assert.equal(calls.length - beforeCopies, 1, "separate canvas instances share one OCR read");
    wysiwyg.innerHTML = mapDOM;

    const db = new DatabaseSync(":memory:");
    db.function("search_normalize",(text,sensitive)=>sensitive?String(text):String(text).toLowerCase());
    db.exec("CREATE TABLE blocks(id TEXT,root_id TEXT,parent_id TEXT,type TEXT,subtype TEXT,content TEXT,markdown TEXT,ial TEXT,hash TEXT,updated TEXT)");
    db.exec("CREATE TABLE spans(id TEXT,block_id TEXT,root_id TEXT,type TEXT)");
    const insert = db.prepare("INSERT INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?)");
    insert.run("mind","root","root","mindmap","","","","","h0","1");
    insert.run("item","root","mind","mindmap_item","","","","","h1","1");
    insert.run("para","root","item","p","","","![](assets/one.png)","","h2","1");
    editors = [{protyle:{element:edit,notebookId:"",block:{id:"root",rootID:"root"}}}];
    let doms = {para:paragraph.outerHTML};
    responder = (url,body,...rest) => {
        if(url==="/api/query/sql") return {code:0,data:db.prepare(body.stmt).all()};
        if(url==="/api/block/getDocBlocksOrders") return {code:0,data:db.prepare("SELECT id FROM blocks").all().map(x=>x.id)};
        if(url==="/api/block/getBlockDOMs") return {code:0,data:Object.fromEntries(body.ids.map(id=>[id,doms[id]??""]))};
        return readOCR(url,body,...rest);
    };
    const search = (options={}) => corpus.searchCurrentDocument({},edit,"OCRneedle",{includeAttributeView:false,includeFoldedBlocks:true,...options});
    corpus.invalidateDocumentSearchCaches();
    const mounted = await search();
    assert.equal(mounted.matches.length,2);
    assert.equal(mounted.partial,false);
    assert.equal((await search({includeImageOCR:false})).matches.length,0,"OCR off excludes native mindmap projections");
    wysiwyg.innerHTML += ["one", "two"].map(id =>
        '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-' + id + '" class="render-node">' + mapDOM + '</div>').join("");
    for (const id of ["one", "two"])
        insert.run("embed-" + id,"root","root","query_embed","","","{{select * from blocks}}","","he-"+id,"1");
    corpus.invalidateDocumentSearchCaches();
    const corpusCopies = await search();
    assert.equal(corpusCopies.matches.length,6,"full corpus preserves every mounted embedded canvas instance");
    assert.equal(corpusCopies.partial,false);
    db.exec("DELETE FROM blocks WHERE type='query_embed'");
    wysiwyg.innerHTML = ""; corpus.invalidateDocumentSearchCaches();
    const offscreen = await search();
    assert.deepEqual(offscreen.matches.map(h=>h.unitId),mounted.matches.map(h=>h.unitId));
    assert.ok(offscreen.matches.every(h=>!h.range));

    const richDOM = richTable("# heading ![](assets/one.png)");
    const markdown = (lute.BlockDOM2StdMd || lute.BlockDOM2Md).call(lute,richDOM);
    assert.ok(markdown.includes("<img") && !markdown.includes("!["));
    db.exec("DELETE FROM blocks");
    insert.run(richId,"root","root","t","","heading",markdown,"","rich-hash","1");
    doms = {[richId]:richDOM};
    corpus.invalidateDocumentSearchCaches();
    found = await search();
    assert.equal(found.matches.length,2,"unloaded raw rich table remains a candidate even without indexed OCR");
    assert.equal(found.partial,false);
    assert.equal((await search({includeImageOCR:false})).matches.length,0,"OCR off excludes unloaded rich table images");
    wysiwyg.innerHTML = richDOM;
    const restored = project.fillLiveRanges(found.matches,collectSearchableBlocks(edit),true);
    assert.ok(restored.every(h=>h.range && !h.replaceable));

    // A native mindmap can project a table containing both OCR and code.
    const mixedMD = '![](assets/one.png)\n\n```python\nprint(1)\n```';
    const mixedDOM = richTable(mixedMD);
    wysiwyg.innerHTML = mixedDOM;
    const mixedTable = wysiwyg.firstElementChild;
    const mixedCell = mixedTable.querySelector('[data-sy-table-cell-rich]');
    mixedCell.innerHTML = '<div class="table__cell-rich">' + lute.Md2BlockDOM(mixedMD) + '</div>';
    mixedCell.querySelectorAll('[data-node-id]').forEach(node => {
        node.setAttribute('data-table-cell-node', ''); node.removeAttribute('data-node-id');
    });
    const mixedPreview = mixedTable.cloneNode(true);
    mixedPreview.querySelectorAll('.protyle-attr, .protyle-action').forEach(node => node.remove());
    mixedPreview.dataset.mindmapSourceId = richId; mixedPreview.removeAttribute('data-node-id');
    const mixedMap = '<div data-type="NodeMindmap" data-node-id="mind" data-mindmap-view-rendered="true"><div class="mindmap-item" data-type="NodeMindmapItem" data-node-id="item">' +
        mixedTable.outerHTML + '</div><div class="mindmap-view">' + mixedPreview.outerHTML + '</div></div>';
    db.exec('DELETE FROM blocks');
    insert.run('mind','root','root','mindmap','','','','','h0','1');
    insert.run('item','root','mind','mindmap_item','','','','','h1','1');
    insert.run(richId,'root','item','t','','print(1)',lute.BlockDOM2StdMd(mixedDOM),'','mixed','1');
    doms = {[richId]:mixedDOM};
    for (const mounted of [true, false]) {
        wysiwyg.innerHTML = mounted ? mixedMap : '';
        corpus.invalidateDocumentSearchCaches();
        const mixed = await corpus.searchCurrentDocument({}, edit, 'OCRneedle|python|print', {regex:true, includeFoldedBlocks:true});
        assert.equal(mixed.partial,false);
        assert.equal(mixed.matches.filter(h=>h.highlightKind==='image-ocr').length,2);
        assert.equal(mixed.matches.filter(h=>h.highlightKind==='code-language').length,1);
        assert.equal(mixed.matches.filter(h=>h.matchedText==='print').length,1);
        if (mounted) assert.ok(mixed.matches.filter(isImageOCRUnit).every(h=>visual.imageOCRFrameHost(h.range)?.closest('.mindmap-view')));
    }
    editors = []; responder = readOCR;
    wysiwyg.innerHTML = mixedMap + ['one','two'].map(id => '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-'+id+'">'+mixedMap+'</div>').join('');
    const mixedCopies = await calculateSearchMatches({},edit,'OCRneedle');
    assert.equal(mixedCopies.matches.length,6);
    assert.ok(mixedCopies.matches.every(h=>h.range && !h.replaceable));
    style.remove(); db.close(); editors = [];
    console.log("OCR scopes/projections: table/selection gates, rich cold/live headings/lists, stable identities, picture-only mindmap and unloaded corpus OK");
}

function clippingRegressions() {
    wysiwyg.innerHTML = lute.Md2BlockDOM("| image |\n| --- |\n| ![](assets/one.png) |");
    const image = wysiwyg.querySelector("img");
    const clipper = image.closest('[data-type="NodeTable"]').firstElementChild;
    clipper.style.overflow = "auto";
    let reads = 0;
    clipper.getBoundingClientRect = () => {reads++;return rect(20,40,300,200);};
    content.getBoundingClientRect = () => rect(0,0,600,400);
    const range = document.createRange();range.selectNode(image);
    image.getBoundingClientRect = () => rect(400,80,80,60);
    visual.applyCodeLanguageVisual(edit,[range]);
    assert.equal(edit.querySelectorAll(".page-search-code-language-frame").length,0,"fully clipped image has no stray frame");
    image.getBoundingClientRect = () => rect(300,80,80,60);
    visual.applyCodeLanguageVisual(edit,[range],range);
    let frame = edit.querySelector(".page-search-code-language-frame");
    assert.equal(frame.style.left,"300px");
    assert.equal(frame.style.width,"80px","partial clip keeps the original border position");
    assert.equal(frame.style.clipPath,"inset(0px 60px 0px 0px)");
    image.getBoundingClientRect = () => rect(50,220,80,60);
    visual.applyCodeLanguageVisual(edit,[range]);
    assert.equal(edit.querySelector(".page-search-code-language-frame").style.clipPath,"inset(0px 0px 40px 0px)");
    const ranges = [range];
    for(let i=0;i<24;i++) {
        const copy = image.cloneNode(true);image.parentElement.append(copy);
        copy.getBoundingClientRect = () => rect(50,80,80,60);
        const r = document.createRange();r.selectNode(copy);ranges.push(r);
    }
    reads = 0;
    visual.applyCodeLanguageVisual(edit,ranges);
    assert.equal(reads,1,"shared scrollport geometry is read once per draw");
    visual.clearCodeLanguageVisual(edit);
    console.log("OCR frames: horizontal/vertical clipping, partial original border and shared-ancestor layout budget OK");
}

async function mindmapFrameMotionRegressions() {
    wysiwyg.innerHTML = '<div class="mindmap-view"><div class="mindmap-view__viewport" style="overflow:hidden"><div class="mindmap-view__world"><span class="img"><img src="assets/one.png"></span></div></div></div>';
    const viewport=wysiwyg.querySelector(".mindmap-view__viewport");
    const world=wysiwyg.querySelector(".mindmap-view__world");
    viewport.getBoundingClientRect=()=>rect(20,20,400,300);
    const image=world.querySelector("img");
    let left=50,reads=0;
    image.getBoundingClientRect=()=>{reads++;return rect(left,50,60,50);};
    const range=document.createRange();range.selectNode(image);
    visual.applyCodeLanguageVisual(edit,[range],range);
    assert.equal(edit.querySelector(".page-search-code-language-frame").style.left,"50px");
    left=120;world.style.transform="translate(70px, 0px) scale(1)";
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(edit.querySelector(".page-search-code-language-frame").style.left,"120px","frame follows native transform without scroll/resize");
    assert.ok(edit.querySelector(".page-search-code-language-frame").classList.contains("is-focus"));
    const before=reads;world.style.transform="scale(2)";
    await Promise.resolve();
    visual.clearCodeLanguageVisual(edit);
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(reads,before,"clearing frames cancels pending transform redraw");
    world.style.transform="scale(1)";
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(reads,before,"clearing frames disconnects the targeted observer");
    console.log("OCR mindmap frames: native transform tracking, focus preservation, pending-frame cancellation and observer cleanup OK");
}

async function cacheRegressions(wrap) {
    invalidateImageOCRCache();calls=[];
    responder = () => ({code:0,data:{text:""}});
    const empty = Array.from({length:400},(_,i)=>wrap(`assets/cache-${i}.png`,i));
    await resolveImageOCRUnits(empty);await resolveImageOCRUnits(empty);
    assert.equal(calls.length,400,"repeated searches reuse empty OCR, not just matches");
    const now = Date.now;
    try {
        const later = now()+10001;Date.now=()=>later;
        await resolveImageOCRUnits([empty[0]]);
        assert.equal(calls.length,401,"cache expires without needing timers");
    } finally {Date.now=now;}
    invalidateImageOCRCache();calls=[];
    await resolveImageOCRUnits([wrap("assets/alias.png"),wrap("assets/alias.png#x"),wrap("assets/alias.png?style=x")]);
    assert.equal(calls.length,3,"legacy OCR aliases retain their exact request URL");
    responder=()=>({code:-1});calls=[];
    await resolveImageOCRUnits([wrap("assets/error.png")]);await resolveImageOCRUnits([wrap("assets/error.png")]);
    assert.equal(calls.length,2,"API errors never enter the cache");

    invalidateImageOCRCache();calls=[];
    let release;
    responder=()=>new Promise(resolve=>{release=()=>resolve({code:0,data:{text:"stale"}});});
    const stale = resolveImageOCRUnits([wrap("assets/race.png")]);
    invalidateImageOCRCache();release();
    const invalidated = await stale;
    assert.equal(invalidated.units[0].text,"");assert.deepEqual(invalidated.failedIds,["b0"]);
    responder=()=>({code:0,data:{text:"fresh"}});
    assert.equal((await resolveImageOCRUnits([wrap("assets/race.png")])).units[0].text,"fresh");
    assert.equal(calls.length,2,"invalidated in-flight response cannot resurrect stale OCR");

    invalidateImageOCRCache();calls=[];
    responder=()=>new Promise(resolve=>{release=()=>resolve({code:0,data:{text:"unchanged document"}});});
    const foreignCommit = resolveImageOCRUnits([wrap("assets/foreign.png")]);
    invalidateImageOCRCache(false);release();
    assert.deepEqual((await foreignCommit).failedIds,[],"another document's SQL commit does not cause a false OCR failure");
    responder=()=>({code:0,data:{text:"fresh"}});
    await resolveImageOCRUnits([wrap("assets/foreign.png")]);
    assert.equal(calls.length,2,"reads started before a foreign commit still cannot repopulate the cleared cache");

    invalidateImageOCRCache();calls=[];responder=()=>({code:0,data:{text:""}});
    await resolveImageOCRUnits(Array.from({length:1025},(_,i)=>wrap(`assets/entry-${i}.png`,i)));
    await resolveImageOCRUnits([wrap("assets/entry-0.png")]);
    assert.equal(calls.length,1026,"entry count is bounded");
    invalidateImageOCRCache();calls=[];responder=()=>({code:0,data:{text:"x".repeat(512*1024)}});
    await resolveImageOCRUnits(Array.from({length:5},(_,i)=>wrap(`assets/bytes-${i}.png`,i)));
    await resolveImageOCRUnits([wrap("assets/bytes-0.png")]);
    assert.equal(calls.length,6,"cached text bytes are bounded independently of entry count");
    console.log("OCR cache: empty-result reuse, expiry, exact aliases, errors, invalidation races and entry/byte bounds OK");
}

async function notificationRegressions(wrap) {
    const nativeClear = global.clearTimeout;
    // Browser clearTimeout and window.setTimeout share one ID space; emulate it in JSDOM.
    global.clearTimeout = handle => typeof handle === "number" ? window.clearTimeout(handle) : nativeClear(handle);
    try {
    const plugin = new (source("index").default)();
    const bar = Object.create(SearchBar.prototype);
    let refreshes=0,aborts=0;
    Object.assign(bar,{edit,documentEpoch:0,domEpoch:0,replaceBusy:false,searchText:"OCRneedle",
        searchAbortController:{abort:()=>aborts++},rememberCurrentRootId:()=>"root",
        plugin:{isLastHighlightComponent:()=>false},highlightHitResult:async()=>{refreshes++;}});
    plugin.searchComponentCallbacks.add(event=>bar.onEventBus(event));
    const path=wrap("assets/notification.png");
    invalidateImageOCRCache();calls=[];responder=()=>({code:0,data:{text:"first"}});
    await resolveImageOCRUnits([path]);
    plugin.onSearchHistoryBroadcast({detail:{cmd:"databaseIndexCommit",data:{rootIDs:[]}}});
    await resolveImageOCRUnits([path]);
    assert.equal(calls.length,1,"empty SQL commit preserves cache");
    plugin.onSearchHistoryBroadcast({detail:{cmd:"databaseIndexCommit",data:{rootIDs:["root"]}}});
    responder=()=>({code:0,data:{text:"second"}});
    assert.equal((await resolveImageOCRUnits([path])).units[0].text,"second");
    const event = new window.CustomEvent("siyuan-image-ocr",{detail:{path:"assets/notification.png"}});
    window.addEventListener("siyuan-image-ocr",plugin.onImageOCRChanged);
    window.dispatchEvent(event);window.dispatchEvent(event);
    assert.equal(aborts,2,"native OCR updates cancel active searches");
    await new Promise(resolve=>window.setTimeout(resolve,450));
    assert.equal(refreshes,1,"repeated native OCR events share the existing search debounce");
    responder=()=>({code:0,data:{text:"third"}});
    assert.equal((await resolveImageOCRUnits([path])).units[0].text,"third");
    bar.replaceBusy=true;plugin.onImageOCRChanged(event);
    assert.equal(bar.replaceRefreshPending,true,"OCR update defers refresh during replacement");
    bar.includeImageOCR=false;
    const beforeDisabledEvent=aborts;
    plugin.onImageOCRChanged(event);
    assert.equal(aborts,beforeDisabledEvent,"OCR notifications do not restart searches when OCR is off");
    plugin.searchComponentCallbacks.clear();
    Object.assign(plugin,{eventBus:{on:()=>{},off:()=>{}},startCleanupTimer:()=>{},stopCleanupTimer:()=>{},closeSearchDialog:()=>{}});
    const beforeOpen = calls.length;
    plugin.onSearchComponentMounted(()=>{});
    await resolveImageOCRUnits([path]);
    assert.equal(calls.length,beforeOpen+1,"first panel open starts a fresh OCR session");
    plugin.teardownRuntime();
    await resolveImageOCRUnits([path]);
    const afterUnload = calls.length;
    window.dispatchEvent(event);
    await resolveImageOCRUnits([path]);
    assert.equal(calls.length,afterUnload,"plugin unload detaches the native OCR listener");
    console.log("OCR notifications: empty/meaningful SQL commits, native-event cache refresh, cancellation, debounce and replacement deferral OK");
    } finally {global.clearTimeout=nativeClear;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
