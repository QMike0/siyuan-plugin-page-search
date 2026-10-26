import {
    isCssHideBoundary,
    textDisplay,
} from "./visibility";
import type {SearchableBlock} from "./dom-types";

/** Rich previews retain native Text nodes; a soft-break line can use a slice. */
export function searchableTextLengths(block: SearchableBlock): number[] {
    if (block.textStartOffset === undefined) return block.textNodes.map(node => node.data.length);
    let remaining = block.text.length;
    return block.textNodes.map((node, index) => {
        const length = Math.max(0, Math.min(remaining, node.data.length - (index === 0 ? block.textStartOffset! : 0)));
        remaining -= length;
        return length;
    });
}

const FLOW_SELECTOR = "p,div,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th,figcaption,section,article";
const GAP_SELECTOR = "br,hr,img,.img,span[data-type~='inline-math']";

interface TextContext {
    flow: Element | null;
    gap: Element | null;
}

/** Walk only the DOM interval covered by these nodes, once. Ordinary inline formatting is continuous. */
export function splitTextNodesAtBarriers(nodes: readonly Text[]): Text[][] {
    if (nodes.length === 0) {
        return [];
    }
    const contexts = new Map<Element, TextContext>();
    const flows = new Map<Element, boolean>();
    const isFlow = (element: Element): boolean => {
        const cached = flows.get(element);
        if (cached !== undefined) {
            return cached;
        }
        // SVG tspan belongs to its text label, regardless of SVG's display value.
        const display = element instanceof HTMLElement ? textDisplay(element) : "";
        const flow = display ?
            display === "block" || display === "flow-root" || display === "flex" || display === "grid" ||
            display === "list-item" || display.startsWith("table") || display.startsWith("block ") :
            element.matches(FLOW_SELECTOR);
        flows.set(element, flow);
        return flow;
    };
    const contextOf = (node: Text): TextContext => {
        let element = node.parentElement;
        const path: Element[] = [];
        while (element && !contexts.has(element)) {
            path.push(element);
            element = element.parentElement;
        }
        let context = element ? contexts.get(element)! : {flow: null, gap: null};
        for (let index = path.length - 1; index >= 0; index -= 1) {
            const parent = path[index];
            context = {
                flow: isFlow(parent) ? parent : context.flow,
                gap: parent.matches(GAP_SELECTOR) ? parent : context.gap,
            };
            contexts.set(parent, context);
        }
        return context;
    };
    let root = nodes[0].getRootNode();
    let walker = nodes[0].ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ALL);
    walker.currentNode = nodes[0];
    let previous = nodes[0];
    let previousContext = contextOf(previous);
    const runs: Text[][] = [[previous]];
    for (let index = 1; index < nodes.length; index += 1) {
        const target = nodes[index];
        const targetRoot = target.getRootNode();
        const context = contextOf(target);
        let barrier = previousContext.flow !== context.flow || previousContext.gap !== context.gap;
        if (targetRoot !== root || !(previous.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            barrier = true;
            root = targetRoot;
            walker = target.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ALL);
        } else {
            let current = walker.nextNode();
            while (current && current !== target) {
                if (
                    current instanceof Element && (
                        current.matches(GAP_SELECTOR) || isFlow(current) || isCssHideBoundary(current)
                    )
                ) {
                    barrier = true;
                }
                current = walker.nextNode();
            }
            if (!current) {
                barrier = true;
            }
        }
        if (barrier) {
            runs.push([target]);
        } else {
            runs[runs.length - 1].push(target);
        }
        walker.currentNode = target;
        previous = target;
        previousContext = context;
    }
    return runs;
}
