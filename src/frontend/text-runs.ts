/**
 * 连续可见文字。strong / em / a / code 这类行内格式不是阻隔。
 * br、图片、行内公式，以及换了块级容器（p、div、标题、单元格）的文字不能拼成一次匹配。
 */

import {isCssHideBoundary} from "./visibility";

const FLOW_SELECTOR = "p,div,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th,figcaption,section,article";
const GAP_SELECTOR = "br,hr,img,.img,span[data-type~='inline-math']";
const FOLLOWING = 4;

export function splitTextNodesAtBarriers(nodes: readonly Text[]): Text[][] {
    if (nodes.length === 0) {
        return [];
    }
    const runs: Text[][] = [[nodes[0]]];
    for (let index = 1; index < nodes.length; index += 1) {
        const previous = nodes[index - 1];
        const current = nodes[index];
        if (visualBarrierBetween(previous, current)) {
            runs.push([current]);
        } else {
            runs[runs.length - 1].push(current);
        }
    }
    return runs;
}

function visualBarrierBetween(left: Text, right: Text): boolean {
    if (left.getRootNode() !== right.getRootNode()) {
        return true;
    }
    if (flowAncestor(left) !== flowAncestor(right)) {
        return true;
    }
    if (gapAncestor(left) !== gapAncestor(right)) {
        return true;
    }
    return gapElementBetween(left, right);
}

function flowAncestor(node: Text): Element | null {
    return node.parentElement?.closest(FLOW_SELECTOR) ?? null;
}

function gapAncestor(node: Text): Element | null {
    return node.parentElement?.closest(GAP_SELECTOR) ?? null;
}

function gapElementBetween(left: Text, right: Text): boolean {
    if (left.parentNode && left.parentNode === right.parentNode) {
        let sibling = left.nextSibling;
        while (sibling && sibling !== right) {
            if (sibling.nodeType === 1 && subtreeHasGap(sibling as Element)) {
                return true;
            }
            sibling = sibling.nextSibling;
        }
        return false;
    }
    const root = commonAncestorElement(left, right);
    if (!root) {
        return true;
    }
    const walker = left.ownerDocument.createTreeWalker(root, 1);
    let seen = 0;
    let current = walker.nextNode() as Element | null;
    while (current && seen < 4000) {
        seen += 1;
        if (!current.contains(left) && !current.contains(right) && isGapElement(current)) {
            const afterLeft = (left.compareDocumentPosition(current) & FOLLOWING) !== 0;
            const beforeRight = (current.compareDocumentPosition(right) & FOLLOWING) !== 0;
            if (afterLeft && beforeRight) {
                return true;
            }
        }
        if ((current.compareDocumentPosition(right) & 2) !== 0 && !current.contains(right)) {
            break;
        }
        current = walker.nextNode() as Element | null;
    }
    return seen >= 4000;
}

function subtreeHasGap(element: Element): boolean {
    return isGapElement(element) || Boolean(element.querySelector(GAP_SELECTOR));
}

function isGapElement(element: Element): boolean {
    return element.matches(GAP_SELECTOR) || isCssHideBoundary(element);
}

function commonAncestorElement(left: Node, right: Node): Element | null {
    const leftElement = left.parentElement;
    const rightElement = right.parentElement;
    if (!leftElement || !rightElement) {
        return null;
    }
    if (leftElement === rightElement || leftElement.contains(rightElement)) {
        return leftElement;
    }
    if (rightElement.contains(leftElement)) {
        return rightElement;
    }
    const seen = new Set<Element>();
    let cursor: Element | null = leftElement;
    while (cursor) {
        seen.add(cursor);
        cursor = cursor.parentElement;
    }
    cursor = rightElement;
    while (cursor) {
        if (seen.has(cursor)) {
            return cursor;
        }
        cursor = cursor.parentElement;
    }
    return null;
}
