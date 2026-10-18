// Direct contracts for temporary result type filters; mocked DOM is not a host E2E substitute.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");

const repo = path.resolve(__dirname, "..");
let lastMenu;
class FixtureMenu {
    constructor(id, close) {
        lastMenu?.close();
        this.element = document.createElement("div");
        this.element.dataset.name = id;
        this.items = [];
        this.closeCB = close;
        lastMenu = {items: this.items, close: () => this.close()};
    }
    addItem(item) {
        this.items.push(item);
        const button = document.createElement("button");
        button.textContent = item.label;
        button.addEventListener("click", event => {
            const keepOpen = item.click?.(button, event);
            if (button.parentElement && !keepOpen) this.close();
        });
        this.element.append(button);
    }
    open(position) { this.position = position; lastMenu.position = position; document.body.append(this.element); }
    close() {
        this.element.remove();
        const close = this.closeCB;
        this.closeCB = undefined;
        close?.();
    }
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {showMessage: () => {}, getAllEditor: () => [], Menu: FixtureMenu};
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".ts"] = (mod, file) => {
    mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'), {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
        fileName: file,
    }).outputText, file);
};

const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
global.window = dom.window;
global.document = dom.window.document;
global.Element = window.Element;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.ShadowRoot = window.ShadowRoot;
global.Range = window.Range;
global.CSS = {escape: value => value};
global.getComputedStyle = window.getComputedStyle.bind(window);

const types = require(path.join(repo, "src", "frontend", "result-block-types.ts"));
const {SearchBar} = require(path.join(repo, "src", "frontend", "search-bar.ts"));

assert.equal(types.passesResultTypeFilter(["paragraph", "callout"], ["paragraph"]), true);
assert.equal(types.passesResultTypeFilter(["paragraph", "callout"], ["paragraph", "callout"]), true);
assert.equal(types.passesResultTypeFilter(["paragraph"], ["paragraph", "callout"]), false);
assert.equal(types.passesResultTypeFilter(["paragraph"], []), true);
assert.equal(types.passesResultTypeFilter(["h2", "callout"], ["heading", "callout"]), true);
assert.equal(types.passesResultTypeFilter(["h2"], ["h1"]), false);
assert.equal(types.passesResultTypeFilter(["mermaid"], ["codeBlock"]), true);
assert.equal(types.passesResultTypeFilter(["mermaid"], ["code"]), false);
assert.equal(types.passesResultTypeFilter(["code"], ["codeBlock", "code"]), true);
assert.equal(types.passesResultTypeFilter(["paragraph", "ordered", "unordered"], ["list", "ordered", "unordered"]), true);
assert.equal(types.passesResultTypeFilter(["paragraph", "ordered"], ["ordered", "unordered"]), false);

const edit = document.createElement("div");
edit.innerHTML =
    "<div data-node-id=\"callout\" data-type=\"NodeCallout\">" +
    "<div data-node-id=\"paragraph\" data-type=\"NodeParagraph\"><span contenteditable=\"true\">foo</span></div>" +
    "</div>";
const paragraph = edit.querySelector('[data-node-id="paragraph"]');
const readTypes = types.createDomBlockTypeReader();
assert.deepEqual(readTypes({
    blockId: "paragraph",
    blockType: "NodeParagraph",
    blockIndex: 0,
    element: paragraph,
    text: "foo",
    textNodes: [paragraph.querySelector("span").firstChild],
}), ["paragraph", "callout"], "nested DOM path is ordered from inner to outer");

const strike = document.createElement("div");
strike.innerHTML = '<div data-node-id="plain" data-type="NodeParagraph"><span data-type="s">foo' +
    '<span data-type="inline-memo" data-content="memo">bar</span></span></div>';
const plain = {blockId: "plain", blockType: "NodeParagraph", element: strike.firstElementChild};
const inline = {...plain, element: strike.querySelector('[data-type="inline-memo"]')};
const strikeTypes = types.createDomBlockTypeReader();
assert.deepEqual(strikeTypes({...plain, element: strike.querySelector('[data-type="s"]')}), ["paragraph"],
    "strikethrough enumeration is not a super block");
assert.deepEqual(strikeTypes(inline), ["paragraph"], "inline units do not add false ancestor types");
const mountedTypes = types.createResultBlockTypeReader([plain, inline], new Map(), new Map());
assert.deepEqual(mountedTypes(plain), ["paragraph"], "an inline unit cannot contaminate its paragraph's mounted path");

const links = new Map([
    ["p", {parentId: "c", type: "p", subtype: "", ial: ""}],
    ["c", {parentId: "s", type: "callout", subtype: "", ial: ""}],
    ["s", {parentId: "doc", type: "s", subtype: "", ial: ""}],
    ["h", {parentId: "doc", type: "h", subtype: "h2", ial: ""}],
    ["code", {parentId: "doc", type: "c", subtype: "", ial: ""}],
    ["flow", {parentId: "doc", type: "c", subtype: "flowchart", ial: ""}],
]);
const unloadedTypes = types.createResultBlockTypeReader([], links, new Map([["code", {codeLanguage: "mermaid"}]]));
assert.deepEqual(unloadedTypes({blockId: "p", blockType: "NodeParagraph"}), ["paragraph", "callout", "super"],
    "unloaded SQL s still identifies real super blocks");
assert.deepEqual(unloadedTypes({blockId: "h", blockType: "NodeHeading"}), ["h2"]);
assert.deepEqual(unloadedTypes({blockId: "code", blockType: "NodeCodeBlock"}), ["mermaid"]);
assert.deepEqual(types.createResultBlockTypeReader([], links, new Map())({blockId: "flow", blockType: "NodeCodeBlock"}), ["flowchart"],
    "unloaded diagram types fall back to the SQL subtype when no language metadata is available");
const lazyElement = document.createElement("div");
lazyElement.setAttribute("data-node-id", "lazy");
lazyElement.setAttribute("data-type", "NodeParagraph");
let lazyReads = 0;
const getAttribute = lazyElement.getAttribute.bind(lazyElement);
lazyElement.getAttribute = (...args) => { lazyReads++; return getAttribute(...args); };
const lazyReader = types.createResultBlockTypeReader([
    {blockId: "lazy", blockType: "NodeParagraph", element: lazyElement},
], new Map(), new Map());
assert.equal(lazyReads, 0, "constructing the result reader does not scan mounted DOM");
assert.deepEqual(lazyReader({blockId: "lazy", blockType: "NodeParagraph"}), ["paragraph"]);
assert.ok(lazyReads > 0, "mounted DOM ancestry is read only when a result type is requested");
const convertedList = document.createElement("div");
convertedList.innerHTML = '<div data-node-id="converted" data-type="NodeList" data-subtype="u" custom-sy-list-mindmap="1"></div>';
const converted = {blockId: "converted", blockType: "NodeList", element: convertedList.firstElementChild};
const convertedLinks = new Map([["converted", {parentId: "doc", type: "l", subtype: "u", ial: 'custom-sy-list-mindmap="1"'}]]);
const coldConverted = types.createResultBlockTypeReader([], convertedLinks, new Map())(converted);
assert.deepEqual(coldConverted, ["mindmap"]);
assert.deepEqual(types.createDomBlockTypeReader()(converted), coldConverted,
    "a list rendered as a mindmap has the same type before and after mounting");
const realSuper = document.createElement("div");
realSuper.innerHTML = '<div data-type="NodeSuperBlock"><div data-type="NodeParagraph"><span data-type="s">foo</span></div></div>';
assert.deepEqual(types.createDomBlockTypeReader()({
    blockType: "NodeParagraph", element: realSuper.querySelector("span"),
}), ["paragraph", "super"], "real DOM super blocks remain recognized around strikethrough");

const embedded = document.createElement("div");
embedded.innerHTML = '<div data-type="NodeCallout"><div data-node-id="embed" data-type="NodeBlockQueryEmbed">' +
    '<div data-type="NodeList" data-subtype="o"><div data-type="NodeParagraph"><span data-type="s">foo</span>' +
    '</div></div></div></div>';
const embeddedTypes = Object.freeze(["paragraph", "ordered", "embed", "callout"]);
const embeddedUnit = {
    blockId: "embed", blockType: "NodeBlockQueryEmbed", unitId: "embed:source:text",
    element: embedded.querySelector('[data-type="NodeParagraph"]'), blockTypes: embeddedTypes,
};
assert.deepEqual(types.createDomBlockTypeReader()(embeddedUnit), embeddedTypes,
    "embed navigation ownership must not prepend an innermost embed type");
assert.deepEqual(types.createDomBlockTypeReader()({
    ...embeddedUnit, blockTypes: undefined, element: embedded.querySelector("span"),
}), embeddedTypes, "inline enumeration without a stored path keeps the source DOM type order");
const embeddedLinks = new Map([
    ["embed", {parentId: "outer", type: "query_embed", subtype: "", ial: ""}],
    ["outer", {parentId: "doc", type: "callout", subtype: "", ial: ""}],
]);
assert.deepEqual(types.createResultBlockTypeReader([], embeddedLinks, new Map())(embeddedUnit), embeddedTypes,
    "cached/fetched embed paths retain the same source-to-owner order");

const panel = document.createElement("div");
panel.innerHTML = '<div class="search-results-panel__filters"></div><div class="search-results-panel__list"></div>';
const root = document.createElement("div");
const input = document.createElement("input");
const replaceInput = document.createElement("input");
root.append(input, replaceInput, panel);
document.body.append(root);
const bar = Object.create(SearchBar.prototype);
Object.assign(bar, {
    root,
    input,
    replaceInput,
    optionButtons: new Map(),
    plugin: {updateLastHighlightComponent: () => {}},
    resultsPanelEl: panel,
    dialog: root,
    resultsListEl: panel.querySelector(".search-results-panel__list"),
    resultBlockTypes: [],
    resultMatches: [{
        blockId: "paragraph",
        blockType: "NodeParagraph",
        blockTypes: ["paragraph", "callout"],
        matchedText: "foo",
        listText: "foo",
        listMark: {start: 0, end: 3},
    }],
    resultIndex: 1,
    resultCount: 1,
    i18n: require("../src/i18n/zh-CN.json"),
    replaceBusy: false,
    destroyed: false,
    searchText: "foo",
    highlightHitResult: async () => {},
    updateCountLabel: () => {},
    scrollIntoRanges: () => assert.fail("clicking an icon must not navigate the result"),
    closeSettingsMenu: () => {},
    closeSearchMethodMenu: () => {},
});

bar.renderResultsWindow = () => {};
bar.onResultsPanelOutsidePointerDown = bar.handleResultsPanelOutsidePointerDown.bind(bar);
bar.onDismissedResultTypeMenuClick = (event) => {
    if (!bar.resultTypeDismissedOnPointerDown) return;
    bar.resultTypeDismissedOnPointerDown = false;
    if (event.detail > 0 && event.target instanceof Node && bar.dialog.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
    }
};
bar.bindUi();
bar.renderResultTypeFilters();
assert.equal(panel.querySelector(".search-results-panel__filters").hidden, true,
    "the type filter header stays out of the way when no filter is active");
panel.querySelector(".search-results-panel__list").innerHTML = bar.formatResultsItemHtml(0);
const paragraphButton = panel.querySelector('[data-result-block-type="paragraph"]');
paragraphButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
assert.deepEqual(bar.resultBlockTypes, ["paragraph"], "first icon enables a temporary type filter");
assert.equal(panel.querySelector(".search-results-panel__filters").hidden, false,
    "the selected filter chip appears without waiting for the search refresh");

panel.querySelector(".search-results-panel__list").innerHTML = bar.formatResultsItemHtml(0);
const calloutButton = panel.querySelector('[data-result-block-type="callout"]');
calloutButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
assert.deepEqual(bar.resultBlockTypes, ["callout", "paragraph"], "multiple icons compose with AND semantics");

bar.resultCount = 0;
bar.renderResultTypeFilters();
const clearButton = panel.querySelector('[data-action="clear-result-types"]');
clearButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
assert.deepEqual(bar.resultBlockTypes, [], "a selected filter remains clearable when the result list is empty");
assert.equal(panel.querySelector(".search-results-panel__filters").hidden, true,
    "clearing filters hides the filter header");

function renderRow(blockTypes) {
    bar.resultMatches[0].blockTypes = blockTypes;
    bar.resultsListEl.innerHTML = bar.formatResultsItemHtml(0);
    return Array.from(bar.resultsListEl.querySelectorAll("[data-result-block-type]"));
}
const buttons = renderRow(["h2", "unordered", "ordered", "callout", "h1", "callout", "super", "super"]);
assert.deepEqual(buttons.map(button => button.dataset.resultBlockType), ["heading", "list", "callout", "super"],
    "row icons deduplicate families and preserve first inner-to-outer occurrence");
assert.deepEqual(buttons.map(button => button.title), ["标题块", "列表块", "提示块", "超级块"],
    "hover names match the scope menu, including grouped types");
assert.ok(buttons.every(button => button.getAttribute("aria-label")), "icon-only controls retain accessible names");
assert.equal(bar.resultsListEl.querySelectorAll(".search-results-panel__type--extra").length, 1);
const more = bar.resultsListEl.querySelector(".search-results-panel__types-more");
assert.ok(more, "more than three deduplicated types have an overflow button");
const overflowRow = more.closest(".search-results-panel__item");
buttons[0].dispatchEvent(new window.MouseEvent("pointerover", {bubbles: true}));
assert.equal(overflowRow.classList.contains("is-types-expanded"), false, "ordinary icons do not expand the row");
more.querySelector("svg").dispatchEvent(new window.MouseEvent("pointerover", {bubbles: true}));
assert.equal(overflowRow.classList.contains("is-types-expanded"), true, "hovering the ellipsis expands its row");
more.dispatchEvent(new window.MouseEvent("pointerout", {bubbles: true, relatedTarget: buttons[0]}));
assert.equal(overflowRow.classList.contains("is-types-expanded"), true, "moving inside the row keeps all types available");
buttons[0].dispatchEvent(new window.MouseEvent("pointerout", {bubbles: true, relatedTarget: input}));
assert.equal(overflowRow.classList.contains("is-types-expanded"), false, "leaving the whole row collapses its icons");
more.click();
assert.equal(overflowRow.classList.contains("is-types-expanded"), true, "the overflow also supports keyboard activation");
assert.equal(document.activeElement, buttons[3], "keyboard expansion focuses the first extra icon");
assert.deepEqual(bar.resultBlockTypes, [], "expansion does not filter or navigate");
const listButton = buttons[1];
listButton.dispatchEvent(new window.MouseEvent("mouseover", {bubbles: true}));
assert.equal(lastMenu, undefined, "hover does not open a type menu");
listButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
assert.deepEqual(bar.resultBlockTypes, ["list"], "left click filters the entire list family");
const context = new window.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 42, clientY: 73});
const rightDown = new window.MouseEvent("pointerdown", {bubbles: true, cancelable: true, button: 2});
listButton.dispatchEvent(rightDown);
assert.equal(rightDown.defaultPrevented, false, "right-click pointerdown preserves native context-menu dispatch");
listButton.querySelector("use").dispatchEvent(context);
assert.equal(context.defaultPrevented, true);
assert.deepEqual(lastMenu.position, {x: 42, y: 73, isLeft: true});
assert.deepEqual(lastMenu.items.map(({label, icon}) => ({label, icon})), [
    {label: "无序列表", icon: "iconList"},
    {label: "有序列表", icon: "iconOrderedList"},
], "only subtypes present in this result are offered, with scope-menu labels and icons");
lastMenu.items[1].click();
assert.deepEqual(bar.resultBlockTypes, ["ordered"], "an exact subtype replaces its redundant broad family filter");
assert.equal(bar.resultTypeMenu, null, "choosing a subtype closes and releases its menu");
let row = renderRow(["paragraph", "ordered", "unordered"]);
assert.equal(row[1].classList.contains("is-selected"), true, "a subtype makes its family icon blue");
row[1].dispatchEvent(new window.MouseEvent("contextmenu", {bubbles: true, cancelable: true}));
assert.equal(lastMenu.items[1].checked, true);
lastMenu.items[0].click();
assert.deepEqual(bar.resultBlockTypes, ["ordered", "unordered"], "nested list subtypes retain AND composition");
bar.renderResultTypeFilters();
panel.querySelector('.search-results-panel__chips [data-result-block-type="ordered"]').click();
assert.deepEqual(bar.resultBlockTypes, ["unordered"], "a subtype chip only clears itself");
row = renderRow(["paragraph", "ordered", "unordered"]);
row[1].click();
assert.deepEqual(bar.resultBlockTypes, [], "clicking a blue family icon clears its subtype filters");

for (const [family, leaves, labels] of [
    ["heading", ["h3", "h1"], ["一级标题", "三级标题"]],
    ["codeBlock", ["mermaid", "code", "flowchart"], ["普通代码块", "Mermaid", "flowchart"]],
    ["codeBlock", ["mermaid", "mermaid"], ["Mermaid"]],
    ["list", ["task"], ["任务列表"]],
]) {
    const [button] = renderRow(leaves);
    assert.equal(button.dataset.resultBlockType, family);
    assert.equal(button.querySelector("use").getAttribute("href"), "#" + types.RESULT_BLOCK_TYPES[family].icon);
    assert.equal(bar.resultsListEl.querySelector(".search-results-panel__types-more"), null,
        "three or fewer grouped types have no overflow affordance");
    button.dispatchEvent(new window.MouseEvent("contextmenu", {bubbles: true, cancelable: true}));
    assert.deepEqual(lastMenu.items.map(item => item.label), labels);
    const menu = bar.resultTypeMenu;
    bar.closeResultsPanel();
    assert.equal(bar.resultTypeMenu, null);
    assert.equal(menu.element.isConnected, false, "closing results also closes its native menu");
}

function openSubtypeMenu(focusInput) {
    focusInput.focus();
    const [button] = renderRow(["ordered"]);
    // A right-click can move focus to the icon before contextmenu is dispatched.
    button.focus();
    button.dispatchEvent(new window.MouseEvent("contextmenu", {bubbles: true, cancelable: true}));
    const menu = bar.resultTypeMenu;
    const item = menu.element.querySelector("button");
    item.focus(); // Native menu buttons receive focus on mouse-down.
    return {menu, item};
}
const keyboardActions = [];
bar.clickNext = () => keyboardActions.push("next");
bar.clickLast = () => keyboardActions.push("previous");
bar.clickReplace = () => keyboardActions.push("replace");
input.value = "foo";
input.setSelectionRange(1, 2);
bar.resultsPanelOpen = true;
let subtypeMenu = openSubtypeMenu(input);
subtypeMenu.item.click();
assert.equal(document.activeElement, input, "selecting a subtype restores the previously focused search input");
assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2], "restoring input focus preserves its text selection");
assert.equal(subtypeMenu.menu.element.isConnected, false);
input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Enter", shiftKey: true, bubbles: true, cancelable: true}));
assert.deepEqual(keyboardActions, ["next", "previous"], "Enter and Shift+Enter work immediately after subtype selection");
input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
assert.equal(bar.resultsPanelOpen, false, "Escape can immediately close the result list after subtype selection");

replaceInput.value = "bar";
replaceInput.setSelectionRange(2, 3);
subtypeMenu = openSubtypeMenu(replaceInput);
subtypeMenu.item.click();
assert.equal(document.activeElement, replaceInput, "the replace input is restored when it was the original focus");
assert.deepEqual([replaceInput.selectionStart, replaceInput.selectionEnd], [2, 3]);
replaceInput.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
assert.equal(keyboardActions.at(-1), "replace", "restoring the replace input preserves its Enter action");

const outsideInput = document.createElement("input");
document.body.append(outsideInput);
subtypeMenu = openSubtypeMenu(input);
outsideInput.focus();
bar.closeResultTypeMenu();
assert.equal(document.activeElement, outsideInput, "closing a menu without choosing a subtype never steals outside focus");

bar.resultsPanelOpen = true;
subtypeMenu = openSubtypeMenu(input);
outsideInput.dispatchEvent(new window.MouseEvent("pointerdown", {bubbles: true, button: 0}));
assert.equal(bar.resultTypeMenu, null, "the first outside pointer closes the subtype menu");
assert.equal(bar.resultsPanelOpen, true, "the first outside pointer preserves the results panel");
outsideInput.dispatchEvent(new window.MouseEvent("click", {bubbles: true, detail: 1}));
outsideInput.dispatchEvent(new window.MouseEvent("pointerdown", {bubbles: true, button: 0}));
assert.equal(bar.resultsPanelOpen, false, "a second outside pointer closes the results panel");

bar.resultsPanelOpen = true;
subtypeMenu = openSubtypeMenu(input);
const menuButton = subtypeMenu.item;
menuButton.dispatchEvent(new window.MouseEvent("pointerdown", {bubbles: true, button: 0}));
assert.equal(bar.resultTypeMenu, subtypeMenu.menu, "a pointer inside the menu does not dismiss it");
const filtersBeforeDismiss = bar.resultBlockTypes.slice();
const typeButton = bar.resultsListEl.querySelector("[data-result-block-type]");
typeButton.dispatchEvent(new window.MouseEvent("pointerdown", {bubbles: true, button: 0}));
typeButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true, detail: 1}));
assert.equal(bar.resultTypeMenu, null, "clicking the panel dismisses the menu first");
assert.equal(bar.resultsPanelOpen, true);
assert.deepEqual(bar.resultBlockTypes, filtersBeforeDismiss, "the dismissing click does not also toggle a type");
typeButton.dispatchEvent(new window.MouseEvent("pointerdown", {bubbles: true, button: 0}));
typeButton.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true, detail: 1}));
assert.notDeepEqual(bar.resultBlockTypes, filtersBeforeDismiss, "the following click acts normally");

subtypeMenu = openSubtypeMenu(input);
input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
assert.equal(bar.resultTypeMenu, null, "Escape dismisses the subtype menu first");
assert.equal(bar.resultsPanelOpen, true, "the first Escape preserves the results panel");
input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
assert.equal(bar.resultsPanelOpen, false, "the next Escape closes the results panel");

const snippetMatch = {
    ...bar.resultMatches[0], listText: "0123456789😀abcdefghijklmnfooXYZ<tail>",
    listMark: {start: 26, end: 29},
};
bar.resultMatches[0] = snippetMatch;
const originalSnippet = JSON.stringify(snippetMatch);
bar.resultsListEl.innerHTML = bar.formatResultsItemHtml(0);
const shownText = bar.resultsListEl.querySelector(".search-results-panel__text");
assert.equal(shownText.querySelector("mark").textContent, "foo");
assert.equal(shownText.firstChild.textContent, "…ghijklmn", "only eight context characters precede the highlighted keyword");
assert.equal(shownText.title, snippetMatch.listText, "the full snippet remains available on hover");
assert.equal(shownText.lastChild.textContent, "XYZ<tail>", "display truncation still escapes markup");
assert.equal(JSON.stringify(snippetMatch), originalSnippet, "display cropping never changes navigation text or offsets");
snippetMatch.listMark = {start: 19, end: 22};
bar.resultsListEl.innerHTML = bar.formatResultsItemHtml(0);
assert.ok(bar.resultsListEl.querySelector(".search-results-panel__text").firstChild.textContent.startsWith("…😀"),
    "prefix cropping does not split a surrogate pair");
for (const blockedState of ["replaceBusy", "destroyed"]) {
    subtypeMenu = openSubtypeMenu(input);
    const selected = bar.resultBlockTypes.slice();
    bar[blockedState] = true;
    subtypeMenu.item.click();
    assert.deepEqual(bar.resultBlockTypes, selected, "a stale menu action cannot change filters while blocked");
    assert.notEqual(document.activeElement, input, "a blocked menu action cannot restore focus to a closing/busy panel");
    bar[blockedState] = false;
}
outsideInput.remove();
document.removeEventListener("pointerdown", bar.onResultsPanelOutsidePointerDown, true);
root.remove();

async function pipelineRegressions() {
    for (const name of ["NodeFilter", "Text", "HTMLTableElement", "HTMLTableRowElement", "HTMLTableCellElement"]) {
        global[name] = window[name];
    }
    window.Element.prototype.getClientRects = () => [{width: 100, height: 20}];
    window.Range.prototype.getClientRects = () => [{width: 100, height: 20}];
    const {calculateSearchMatches} = require("../src/frontend/pipeline.ts");
    const {collectSearchableBlocks} = require("../src/frontend/blocks.ts");
    const editor = document.createElement("div");
    editor.innerHTML = "<div class=\"protyle\"><div class=\"protyle-content\"><div class=\"protyle-wysiwyg\">" +
        "<div data-node-id=\"plain\" data-type=\"NodeParagraph\"><div contenteditable=\"true\"><span data-type=\"s\">foo</span></div></div>" +
        "<div data-type=\"NodeList\" data-subtype=\"o\"><div data-type=\"NodeListItem\">" +
        "<div data-node-id=\"listed\" data-type=\"NodeParagraph\"><div contenteditable=\"true\"><span data-type=\"s\">foo</span></div></div>" +
        "</div></div></div></div></div>";
    const collected = collectSearchableBlocks(editor, {includeDocTitle: false});
    assert.ok(collected.length > 0);
    assert.ok(collected.every(block => block.blockTypes === undefined),
        "ordinary live blocks defer type ancestry until a hit is accepted");
    document.body.append(editor);
    const options = {includeDocTitle: false, restrictInlineTypes: ["s"]};
    const all = await calculateSearchMatches({}, editor, "", options);
    assert.deepEqual(all.matches.map(match => match.blockTypes), [["paragraph"], ["paragraph", "ordered"]]);
    const falseSuper = await calculateSearchMatches({}, editor, "", {...options, resultBlockTypes: ["super"]});
    assert.equal(falseSuper.matches.length, 0, "actual strikethrough search no longer leaks into the super filter");
    const grouped = await calculateSearchMatches({}, editor, "", {...options, resultBlockTypes: ["paragraph", "list"]});
    assert.deepEqual(grouped.matches.map(match => match.blockId), ["listed"], "actual enumeration respects broad AND filters");
    const exact = await calculateSearchMatches({}, editor, "", {...options, resultBlockTypes: ["unordered"]});
    assert.equal(exact.matches.length, 0, "exact subtype filters remain narrow");
    editor.remove();

    editor.innerHTML = '<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg">' +
        '<div data-node-id="outer" data-type="NodeCallout"><div data-node-id="embed" data-type="NodeBlockQueryEmbed">' +
        '<div class="protyle-wysiwyg__embed"><div data-node-id="list" data-type="NodeList" data-subtype="o">' +
        '<div data-node-id="item" data-type="NodeListItem"><div data-node-id="source" data-type="NodeParagraph">' +
        '<div contenteditable="true"><span data-type="s">foo</span></div></div></div></div></div></div></div></div></div></div>';
    document.body.append(editor);
    const {unitKeyOf} = require("../src/frontend/selection.ts");
    const embeddedBlocks = collectSearchableBlocks(editor, {includeDocTitle: false});
    assert.equal(embeddedBlocks.length, 1);
    const selectionScope = new Map(embeddedBlocks.map(block => [unitKeyOf(block), [{start: 0, end: block.text.length}]]));
    for (const selectionOnly of [true, false]) {
        const searchOptions = {includeDocTitle: false, selectionOnly, selectionScope};
        for (const resultBlockTypes of [[], ["paragraph", "list", "embed", "callout"], ["ordered", "embed"]]) {
            const result = await calculateSearchMatches({}, editor, "foo", {...searchOptions, resultBlockTypes});
            assert.equal(result.matches.length, 1, "embedded text stays searchable before and after filtering");
            assert.deepEqual(result.matches[0].blockTypes, embeddedTypes,
                "selection and degraded keyword searches keep the inner-to-outer embed path after filtering");
            assert.equal(result.matches[0].replaceable, false, "embedded results never become writable through filtering");
            assert.equal(result.degraded === true, !selectionOnly);
        }
        const enumeration = await calculateSearchMatches({}, editor, "", {
            ...searchOptions, restrictInlineTypes: ["s"], resultBlockTypes: ["paragraph", "embed"],
        });
        assert.equal(enumeration.matches.length, 1);
        assert.deepEqual(enumeration.matches[0].blockTypes, embeddedTypes,
            "empty-query inline enumeration retains the same embedded icon order");
        assert.equal(enumeration.matches[0].replaceable, false);
        const excluded = await calculateSearchMatches({}, editor, "foo", {...searchOptions, resultBlockTypes: ["unordered"]});
        assert.equal(excluded.matches.length, 0, "exact embedded list subtypes remain narrow");
    }
    editor.remove();
}
pipelineRegressions().then(() => {
    console.log("result type filters: DOM/SQL identity, unloaded/embedded ancestry, grouped icons, right-click subtypes, AND, input focus/keyboard and menu cleanup OK");
}).catch(error => { console.error(error); process.exitCode = 1; });
