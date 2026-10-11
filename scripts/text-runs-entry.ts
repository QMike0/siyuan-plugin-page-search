import {collectSearchableBlocks} from "../src/frontend/blocks";
import {collectRendererSearchUnits} from "../src/frontend/renderer-adapters";
import {selectionScopeFromTableCellText} from "../src/frontend/selection";
import {splitTextNodesAtBarriers} from "../src/frontend/text-runs";
import {
    beginTextCollection,
    omitAuthorCssHiddenText,
} from "../src/frontend/visibility";
import {
    avApiUnitShown,
    collectAvDomCoverage,
} from "../src/shared/av-live";
import {
    tableCellNodeId,
    tableCellPosition,
    tableOverlayKey,
} from "../src/shared/table-live";

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(message);
    }
}

function textsOf(html: string): Text[] {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        nodes.push(current as Text);
        current = walker.nextNode();
    }
    return nodes;
}

function joined(runs: Text[][]): string[] {
    return runs.map((run) => run.map((node) => node.nodeValue ?? "").join(""));
}

const formatted = textsOf("<div><span>foo</span><strong>bar</strong></div>");
assert(joined(splitTextNodesAtBarriers(formatted)).join("|") === "foobar", "inline formatting stays one run");

const broken = textsOf("<div><span>foo</span><br><span>bar</span></div>");
assert(joined(splitTextNodesAtBarriers(broken)).join("|") === "foo|bar", "br splits runs");

const mathHost = textsOf('<div>foo<span data-type="inline-math">δ</span>bar</div>');
const withoutMath = mathHost.filter((node) => !node.parentElement?.closest("[data-type~='inline-math']"));
assert(joined(splitTextNodesAtBarriers(withoutMath)).join("|") === "foo|bar", "inline math splits surrounding text");

const image = textsOf(
    '<div>foo<span class="img"><span> </span><span class="protyle-action__title"><span>cap</span></span></span>bar</div>',
);
const imageRuns = joined(splitTextNodesAtBarriers(image));
assert(imageRuns[0] === "foo" && imageRuns[imageRuns.length - 1] === "bar", "image does not join the words around it");
assert(
    !imageRuns.some((run) => run.includes("foobar") || run === "foo bar"),
    "image title stays off the surrounding phrase",
);

const html = textsOf("<div><p>foo</p><p>bar</p></div>");
assert(joined(splitTextNodesAtBarriers(html)).join("|") === "foo|bar", "html paragraphs stay apart");

const sameParagraph = textsOf("<p>foo<span>bar</span></p>");
assert(joined(splitTextNodesAtBarriers(sameParagraph)).join("|") === "foobar", "one paragraph stays continuous");

const cssParagraphs = textsOf('<span style="display:block">foo</span><span style="display:block">bar</span>');
assert(joined(splitTextNodesAtBarriers(cssParagraphs)).join("|") === "foo|bar", "CSS block spans stay apart");
const inlineDivs = textsOf('<div style="display:inline">foo</div><div style="display:inline">bar</div>');
assert(joined(splitTextNodesAtBarriers(inlineDivs)).join("|") === "foobar", "CSS inline divs stay continuous");
const inlineBoxes = textsOf('<span style="display:inline-block">foo</span><span>bar</span>');
assert(
    joined(splitTextNodesAtBarriers(inlineBoxes)).join("|") === "foobar",
    "inline boxes keep inline text continuous",
);
const authorStyle = document.createElement("style");
authorStyle.textContent =
    ".search-block {display:block} .search-hidden {visibility:hidden} .search-visible {visibility:visible}";
document.head.append(authorStyle);
beginTextCollection(true);
const styledBlocks = textsOf('<span class="search-block">foo</span><span class="search-block">bar</span>');
assert(joined(splitTextNodesAtBarriers(styledBlocks)).join("|") === "foo|bar", "class-based block styles split runs");
const styledRestore = textsOf('<div class="search-hidden">hidden<span class="search-visible">shown</span></div>');
assert(joined([omitAuthorCssHiddenText(styledRestore)]).join("") === "shown", "class-based visibility can be restored");
authorStyle.remove();
const restored = textsOf('<div style="visibility:hidden">hidden<span style="visibility:visible">shown</span></div>');
beginTextCollection(true);
assert(joined([omitAuthorCssHiddenText(restored)]).join("") === "shown", "descendant can restore visibility");
const cannotRestore = textsOf('<div style="display:none"><span style="visibility:visible">hidden</span></div>');
beginTextCollection(true);
assert(omitAuthorCssHiddenText(cannotRestore).length === 0, "visibility cannot restore a display:none subtree");

beginTextCollection(false);
const hiddenHost = textsOf('<div>a<span style="display:none">hidden</span>b</div>');
const visibleOnly = omitAuthorCssHiddenText(hiddenHost);
assert(joined(splitTextNodesAtBarriers(visibleOnly)).join("|") === "a|b", "loaded display:none text is not searchable");
assert(
    !visibleOnly.some((node) => (node.nodeValue ?? "").includes("hidden")),
    "hidden word is removed before matching",
);

beginTextCollection(false);
const tabHost = textsOf('<div class="fn__none"><span>tab</span></div>');
assert(
    omitAuthorCssHiddenText(tabHost).map((node) => node.nodeValue).join("") === "tab",
    "siyuan fn__none chrome is not author-hidden text",
);

assert(tableCellPosition("table-cell:0:0#run-0") === "0:0", "run suffix preserves cell coordinates");
assert(tableOverlayKey("table-cell:0:0#run-1") === "0:0#1", "run suffix preserves overlay identity");
assert(tableCellNodeId("table-cell:0:0:cell-id#run-1") === "cell-id", "run suffix is not a cell node id");

const editor = document.createElement("div");
editor.className = "protyle";
editor.innerHTML =
    '<div class="protyle-content"><div class="protyle-wysiwyg"><div data-node-id="t" data-type="NodeTable"><table><tbody><tr><td>foo<br>foo</td></tr></tbody></table></div></div></div>';
document.body.append(editor);
const tableUnits = collectSearchableBlocks(editor, {includeDocTitle: false});
const cell = editor.querySelector("td")!;
const selected = selectionScopeFromTableCellText(tableUnits, {cell, start: 3, end: 6, text: "foo", inlineMarks: []});
assert(
    selected.size === 1 && selected.has("t::table-cell:0:0#run-1"),
    "repeated cell text selects only the intended run",
);
const spanning = selectionScopeFromTableCellText(tableUnits, {cell, start: 1, end: 5, text: "oofo", inlineMarks: []});
assert(spanning.size === 2, "a cell selection can cover parts of two runs");
assert(spanning.get("t::table-cell:0:0#run-0")?.[0].start === 1, "first selected run uses local offsets");
assert(spanning.get("t::table-cell:0:0#run-1")?.[0].end === 2, "last selected run uses local offsets");

const longPrefix = textsOf("<div>" + "<span></span>".repeat(4001) + "<span>foo</span><strong>bar</strong></div>");
assert(
    joined(splitTextNodesAtBarriers(longPrefix)).join("|") === "foobar",
    "a long prefix does not create a false barrier",
);
const nestedHidden = textsOf('<div>a<section><span style="display:none">hidden</span></section>b</div>');
assert(
    joined(splitTextNodesAtBarriers(omitAuthorCssHiddenText(nestedHidden))).join("|") === "a|b",
    "nested hidden gap splits text",
);

const style = document.createElement("style");
style.textContent = '.li[fold="1"] > div:nth-child(n+3):not(.protyle-attr) {display:none}';
document.head.append(style);
const folded = textsOf(
    '<div class="li" data-type="NodeListItem" fold="1"><div></div><div>first</div><div>later<span style="display:none">hidden</span></div></div>',
);
beginTextCollection(true);
assert(
    omitAuthorCssHiddenText(folded).map((node) => node.nodeValue).join("") === "firstlater",
    "host folding does not override author hiding",
);
beginTextCollection(false);
assert(omitAuthorCssHiddenText(folded).length === 0, "folded content toggle still excludes the subtree");
style.remove();

beginTextCollection(true);
const diagram = document.createElement("div");
diagram.setAttribute("data-type", "NodeCodeBlock");
diagram.setAttribute("data-subtype", "mermaid");
diagram.innerHTML =
    '<svg><text><tspan>fo</tspan><tspan>o</tspan></text><text style="display:none">hidden</text><foreignObject><div>bar<br>baz</div></foreignObject></svg>';
document.body.append(diagram);
const context = {blockId: "d", blockType: "NodeCodeBlock", blockIndex: 0};
assert(
    collectRendererSearchUnits(diagram, context).map((unit) => unit.text).join("|") === "foo|bar|baz",
    "diagram formatting is continuous but BR and hidden labels are not",
);

const htmlBlock = document.createElement("div");
htmlBlock.setAttribute("data-type", "NodeHTMLBlock");
const htmlHost = document.createElement("protyle-html");
htmlHost.attachShadow({mode: "open"}).innerHTML =
    '<p>foo<strong>bar</strong></p><p>baz</p><span style="display:none">hidden</span>';
htmlBlock.append(htmlHost);
document.body.append(htmlBlock);
assert(
    collectRendererSearchUnits(htmlBlock, context).map((unit) => unit.text).join("|") === "foobar|baz",
    "HTML shadow paragraphs preserve run boundaries",
);
htmlHost.shadowRoot!.innerHTML = 'direct<br>text<span style="display:none">hidden</span>';
beginTextCollection(true);
assert(
    collectRendererSearchUnits(htmlBlock, context).map((unit) => unit.text).join("|") === "direct|text",
    "direct shadow Text remains searchable and respects BR",
);
htmlBlock.style.display = "none";
beginTextCollection(true);
assert(collectRendererSearchUnits(htmlBlock, context).length === 0, "hidden HTML host hides direct shadow Text");
htmlBlock.style.display = "";

editor.querySelector(".protyle-wysiwyg")!.innerHTML =
    '<div data-node-id="av" data-type="NodeAttributeView"><div class="av__row" data-id="r"><div class="av__cell" data-col-id="c"><span style="display:none">hidden</span></div><div class="av__cell" data-col-id="c2">foo<br>bar</div></div></div>';
const avUnits = collectSearchableBlocks(editor, {includeAttributeView: true, includeFoldedBlocks: true});
const avCoverage = collectAvDomCoverage(avUnits).get("av")!;
assert(avApiUnitShown("av:r:c", "hidden", avCoverage, new Set()), "empty hidden AV cell still blocks its API value");
assert(avApiUnitShown("av:r:c2", "foobar", avCoverage, new Set()), "AV run suffix retains API cell coverage");
const calendarCoverage = collectAvDomCoverage([
    {blockId: "cal", blockType: "NodeAttributeView", unitId: "calendar:r:title#run-0", text: "foo"},
    {blockId: "cal", blockType: "NodeAttributeView", unitId: "calendar:r:title#run-1", text: "bar"},
]).get("cal")!;
assert(
    avApiUnitShown("av:r:primary", "foobar", calendarCoverage, new Set()),
    "calendar label coverage uses the whole label, not its first run",
);
assert(
    avUnits.filter((unit) => unit.text).map((unit) => unit.text).join("|") === "foo|bar",
    "AV does not merge across BR",
);

editor.querySelector(".protyle-wysiwyg")!.innerHTML =
    '<span>foo</span><br><span>bar</span><span style="display:none">hidden</span>';
assert(
    collectSearchableBlocks(editor, {includeDocTitle: false}).map((unit) => unit.text).join("|") === "foo|bar",
    "no-ID preview preserves visibility and BR",
);
editor.querySelector(".protyle-wysiwyg")!.innerHTML =
    '<div data-type="NodeMindmap" data-node-id="m"><div class="mindmap-view"><div data-mindmap-source-id="s">foo<strong>bar</strong><br>baz<span style="display:none">hidden</span></div></div></div>';
for (const preview of editor.querySelectorAll<HTMLElement>("[data-mindmap-source-id]")) {
    preview.getClientRects = () => [{width: 100, height: 20} as DOMRect] as unknown as DOMRectList;
}
assert(
    collectSearchableBlocks(editor, {includeDocTitle: false}).filter((unit) => unit.blockId === "s").map((unit) =>
        unit.text
    ).join("|") === "foobar|baz",
    "mindmap surface preserves runs",
);

const visits: number[] = [];
for (const size of [100, 200, 400]) {
    const dense = textsOf("<div>" + "<span>x</span>".repeat(size) + "</div>");
    const createWalker = document.createTreeWalker.bind(document);
    let count = 0;
    document.createTreeWalker = ((...args: Parameters<Document["createTreeWalker"]>) => {
        const walker = createWalker(...args);
        const next = walker.nextNode.bind(walker);
        walker.nextNode = () => {
            count += 1;
            return next();
        };
        return walker;
    }) as Document["createTreeWalker"];
    try {
        assert(splitTextNodesAtBarriers(dense).length === 1, "dense inline formatting remains continuous");
    } finally {
        document.createTreeWalker = createWalker;
    }
    visits.push(count);
    assert(count <= size * 3, "run scanner visits grow linearly");
}
console.log("run scanner visits (100/200/400):", visits.join("/"));

console.log("text-runs OK");
