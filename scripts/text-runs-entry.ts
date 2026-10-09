import {collectSearchableBlocks} from "../src/frontend/blocks";
import {splitTextNodesAtBarriers} from "../src/frontend/text-runs";
import {
    beginTextCollection,
    omitAuthorCssHiddenText,
} from "../src/frontend/visibility";

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

console.log("text-runs OK");
