import {parentElementCrossingShadow} from "./dom-parent";
import type {
    EmbeddedOrderSegment,
    SearchableBlock,
    SearchMatch,
} from "./dom-types";
import {locateTextPoint} from "./ranges";
import {searchableTextLengths} from "./text-runs";
import {tabsLabelSourceBlock} from "./tabs-title";

/** Rank the target/ancestor tree only; unrelated SVG subtrees never enter the traversal. */
export function createEmbeddedPositionReader(
    root: Node,
    targets: ReadonlySet<Node>,
): (node: Node, after?: boolean) => number[] | undefined {
    const children = new Map<Node, Node[]>([[root, []]]);
    for (const target of targets) {
        const path: Node[] = [];
        let node: Node | null = target;
        while (node && !children.has(node)) {
            path.push(node);
            node = node instanceof ShadowRoot ? node.host : node.parentNode;
        }
        if (!node) continue;
        while (path.length) {
            const child = path.pop()!;
            children.get(node)!.push(child);
            children.set(child, []);
            node = child;
        }
    }
    const ranks = new Map<Node, {before: number; after: number;}>();
    const stack: Array<{node: Node; exit: boolean;}> = [{node: root, exit: false}];
    let rank = 0;
    while (stack.length) {
        const {node, exit} = stack.pop()!;
        if (exit) {
            const position = ranks.get(node);
            if (position) position.after = rank;
            rank++;
            continue;
        }
        if (targets.has(node)) ranks.set(node, {before: rank, after: 0});
        rank++;
        stack.push({node, exit: true});
        let siblings = children.get(node)!;
        if (siblings.length > 1) {
            if (node.childNodes.length <= siblings.length * 2) {
                // Dense siblings/deep two-child chains: one local sibling scan,
                // avoiding repeated native ancestor comparisons in deep trees.
                const included = new Set(siblings);
                siblings = siblings.filter((child) => child instanceof ShadowRoot);
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    if (included.has(child)) siblings.push(child);
                }
            } else {
                siblings.sort((a, b) => {
                    // Sparse siblings: native order skips irrelevant children.
                    if (a instanceof ShadowRoot) return -1;
                    if (b instanceof ShadowRoot) return 1;
                    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
            }
        }
        for (let index = siblings.length - 1; index >= 0; index--) {
            stack.push({node: siblings[index], exit: false});
        }
    }
    return (node, after = false) => {
        const position = ranks.get(node);
        return position ? [after ? position.after : position.before] : undefined;
    };
}

export function recordEmbeddedOrder(
    root: HTMLElement,
    blocks: readonly SearchableBlock[],
    anchors: readonly Node[] = [],
): ReturnType<typeof createEmbeddedPositionReader> {
    const targets = new Set<Node>(anchors);
    for (const block of blocks) {
        targets.add(block.element);
        block.textNodes.forEach((node) => targets.add(node));
    }
    // Navigation labels precede all tab panels in the DOM, but belong at
    // their source title's position. Keep this projection in the shared
    // reader so renderer recovery and cached anchors use the same order.
    const labels = new Map<HTMLElement, {source: HTMLElement; targets: Set<Node>}>();
    for (const target of targets) {
        const element = target instanceof Element ? target : target.parentElement;
        const label = element?.closest<HTMLElement>(".tabs-header .tabs-tab-label");
        if (!label || label === root || !root.contains(label)) continue;
        let entry = labels.get(label);
        if (!entry) {
            const source = tabsLabelSourceBlock(label);
            if (!source || !root.contains(source)) continue;
            labels.set(label, entry = {source, targets: new Set()});
        }
        entry.targets.add(target);
    }
    for (const {source} of labels.values()) targets.add(source);
    const physicalPositionOf = createEmbeddedPositionReader(root, targets);
    const projected = new Map<HTMLElement, {anchor: number[]; local: ReturnType<typeof createEmbeddedPositionReader>}>();
    for (const [label, {source, targets: localTargets}] of labels) {
        const anchor = physicalPositionOf(source);
        if (anchor) projected.set(label, {anchor, local: createEmbeddedPositionReader(label, localTargets)});
    }
    const positionOf = (node: Node, after = false): number[] | undefined => {
        const element = node instanceof Element ? node : node.parentElement;
        const label = projected.size ? element?.closest<HTMLElement>(".tabs-header .tabs-tab-label") : null;
        const entry = label ? projected.get(label) : undefined;
        const local = entry?.local(node, after);
        return local ? [...entry!.anchor, ...local] : physicalPositionOf(node, after);
    };
    for (const block of blocks) {
        const order: EmbeddedOrderSegment[] = [];
        const lengths = block.textStartOffset === undefined ? undefined : searchableTextLengths(block);
        let offset = 0;
        for (const [index, node] of block.textNodes.entries()) {
            const length = lengths?.[index] ?? node.nodeValue?.length ?? 0;
            if (!length) continue;
            const path = positionOf(node);
            if (path) order.push({start: offset, path});
            offset += length;
        }
        if (order.length === 0) {
            const path = positionOf(block.element, block.matchSource === "inline-memo");
            if (path) {
                // A memo follows the visible text of its host, before the following sibling.
                order.push({start: 0, path});
            }
        }
        block.embeddedOrder = order.length ? order : undefined;
    }
    return positionOf;
}

export function embeddedPositionAt(
    order: readonly EmbeddedOrderSegment[] | undefined,
    start: number,
): readonly number[] | undefined {
    if (!order?.length) return undefined;
    let low = 0;
    let high = order.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (order[mid].start <= start) low = mid + 1;
        else high = mid;
    }
    return order[Math.max(0, low - 1)].path;
}

export function compareEmbeddedPositions(left: SearchMatch, right: SearchMatch): number | undefined {
    if (left.blockId !== right.blockId || !left.embeddedPosition || !right.embeddedPosition) return undefined;
    const a = left.embeddedPosition;
    const b = right.embeddedPosition;
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

/** Cache a recovered renderer's internal order independently of its mounted position. */
export function relativeEmbeddedOrder(
    order: readonly EmbeddedOrderSegment[] | undefined,
    anchor: readonly number[] | undefined,
): readonly EmbeddedOrderSegment[] | undefined {
    if (!order || !anchor) return undefined;
    return order.map((segment) => ({
        start: segment.start,
        path: [segment.path[0] - anchor[0], ...segment.path.slice(1)],
    }));
}

/** Reattach cached internal ranks to the current live anchor, without rerendering. */
export function rebaseEmbeddedOrder(
    order: readonly EmbeddedOrderSegment[] | undefined,
    anchor: readonly number[] | undefined,
): readonly EmbeddedOrderSegment[] | undefined {
    if (!order || !anchor) return undefined;
    return order.map((segment) => ({start: segment.start, path: [...anchor, ...segment.path]}));
}

export function embeddedOwner(element: Element): HTMLElement | null {
    return element.closest<HTMLElement>('[data-type="NodeBlockQueryEmbed"][data-node-id]');
}

/** Distinguish displayed copies of the same source inside a single embed.
 * Read the whole owner once, so scoped repair/selection uses the same IDs as full collection.
 */
export function createEmbeddedSourceReader(): (element: Element, sourceId?: string) => string | undefined {
    const sources = new WeakMap<Element, string>();
    const scanned = new WeakSet<HTMLElement>();
    const previewSources = new WeakMap<Element, Map<string, string>>();
    return (element, sourceId) => {
        const owner = embeddedOwner(element);
        if (!owner || owner === element) return sourceId ?? element.getAttribute("data-node-id") ?? undefined;
        if (!scanned.has(owner)) {
            scanned.add(owner);
            const counts = new Map<string, number>();
            for (const source of owner.querySelectorAll<HTMLElement>("[data-node-id][data-type]")) {
                if (embeddedOwner(source) !== owner) continue;
                const id = source.dataset.nodeId!;
                const ordinal = counts.get(id) ?? 0;
                counts.set(id, ordinal + 1);
                sources.set(
                    source,
                    source.getAttribute("data-page-search-embedded-source") ??
                        (ordinal === 0 ? id : `${id}@${ordinal}`),
                );
            }
        }
        const label = element.closest<HTMLElement>(".tabs-header .tabs-tab-label");
        const source = (label && tabsLabelSourceBlock(label)) || (sourceId ?
            element.closest(`[data-node-id="${CSS.escape(sourceId)}"][data-type]`) :
            element.closest("[data-node-id][data-type]"));
        const identity = source && sources.get(source);
        if (identity) return identity;
        // Native mindmap clones strip data-node-id. Resolve them inside their
        // own source container, keeping repeated query results distinct. Reuse
        // the owner's ordinals and cache each container once, not per formula.
        const preview = sourceId ?
            element.closest(`[data-mindmap-source-id="${CSS.escape(sourceId)}"][data-type]`) : null;
        const container = preview?.closest(".mindmap-view")?.closest("[data-node-id][data-type]");
        if (container && embeddedOwner(container) === owner) {
            let ids = previewSources.get(container);
            if (!ids) {
                ids = new Map();
                for (const block of container.querySelectorAll<HTMLElement>("[data-node-id][data-type]")) {
                    const identity = sources.get(block);
                    if (identity && !ids.has(block.dataset.nodeId!)) ids.set(block.dataset.nodeId!, identity);
                }
                previewSources.set(container, ids);
            }
            return ids.get(sourceId!) ?? sourceId;
        }
        return source ? sources.get(source) ?? sourceId : sourceId;
    };
}

const VISUAL_RECT_LIMIT = 512;
const VISUAL_SCOPE_SELECTOR = 'svg, [data-type="NodeSuperBlock"][data-sb-layout="col"]';

interface VisualContext {
    scope: Element | null;
    hidden: boolean;
    label: Element | null;
    svg: Element | null;
    block: Element | null;
}

/**
 * Only mounted special layouts have meaningful geometry. Read each bounded
 * label/block/hit rectangle once, then sort snapshots, never inside a comparator.
 * Use live units independently of viewport Range projection. Folded/cold hits
 * retain their structural slots without blocking healthy neighboring diagrams.
 */
export function orderEmbeddedVisualMatches(
    matches: SearchMatch[],
    liveBlocks: Iterable<SearchableBlock> = [],
): void {
    const hosts = new Map<string, Array<{match: SearchMatch; index: number;}>>();
    matches.forEach((match, index) => {
        if (match.blockType !== "NodeBlockQueryEmbed" || !match.embeddedPosition) return;
        const group = hosts.get(match.blockId) ?? [];
        group.push({match, index});
        hosts.set(match.blockId, group);
    });
    if (!hosts.size) return;
    const blocksByKey = new Map<string, SearchableBlock>();
    for (const block of liveBlocks) {
        if (hosts.has(block.blockId)) blocksByKey.set(`${block.blockId}\u0000${block.unitId ?? ""}`, block);
    }
    const blockOf = (match: SearchMatch) => blocksByKey.get(`${match.blockId}\u0000${match.unitId ?? ""}`);
    const elementOf = (match: SearchMatch): Element | null => {
        const block = blockOf(match);
        if (block?.element.isConnected && block.text.slice(match.start, match.end) === match.matchedText) {
            if (block.matchSource === "inline-memo" || !block.textNodes.length) return block.element;
            const node = locateTextPoint(block.textNodes, match.start, "start")?.node;
            if (node?.isConnected) {
                return node.parentElement ??
                    (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
            }
        }
        const node = match.range?.startContainer;
        return node?.isConnected ? (node instanceof Element ? node : node.parentElement) : null;
    };
    const rangeOf = (match: SearchMatch): Range | undefined => {
        if (match.range?.startContainer.isConnected) return match.range;
        const block = blockOf(match);
        if (!block?.textNodes.length || block.text.slice(match.start, match.end) !== match.matchedText) return;
        const start = locateTextPoint(block.textNodes, match.start, "start");
        const end = locateTextPoint(block.textNodes, match.end, "end");
        if (!start?.node.isConnected || !end?.node.isConnected) return;
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return range;
    };
    let remaining = VISUAL_RECT_LIMIT;
    const contextCache = new Map<Element, VisualContext>();
    const contextOf = (element: Element, root: Element): VisualContext => {
        const visited: Element[] = [];
        let current: Element | null = element;
        let context: VisualContext = {scope: null, hidden: false, label: null, svg: null, block: null};
        while (current) {
            if (contextCache.has(current)) {
                context = contextCache.get(current)!;
                break;
            }
            visited.push(current);
            if (current === root) break;
            current = parentElementCrossingShadow(current);
        }
        // Cache from ancestors to descendants, so the outer column layout wins
        // over SVGs or column layouts nested inside it.
        for (let index = visited.length - 1; index >= 0; index--) {
            const node = visited[index];
            context = {
                scope: context.scope ?? (node.matches(VISUAL_SCOPE_SELECTOR) ? node : null),
                hidden: context.hidden || node.matches('[parent-heading], [fold="1"], [data-page-search-offscreen]'),
                label: node.matches("svg text, svg foreignObject") ? node : context.label,
                svg: node.localName === "svg" ? node : context.svg,
                block: node.matches("[data-node-id][data-type]") ? node : context.block,
            };
            contextCache.set(node, context);
        }
        return contextCache.get(element)!;
    };
    for (const host of hosts.values()) {
        if (remaining === 0) break;
        let owner: HTMLElement | null = null;
        for (const {match} of host) {
            const block = blockOf(match);
            if (block?.element.isConnected) owner = embeddedOwner(block.element);
            if (!owner) {
                const node = match.range?.startContainer;
                const element = node?.isConnected ? (node instanceof Element ? node : node.parentElement) : null;
                if (element) owner = embeddedOwner(element);
            }
            if (owner) break;
        }
        // Ordinary embeds need no per-hit layout metadata at all.
        if (
            !owner?.querySelector(VISUAL_SCOPE_SELECTOR) ||
            owner.closest('[parent-heading], [fold="1"], [data-page-search-offscreen]')
        ) continue;
        const groups = new Map<
            Element,
            Array<{match: SearchMatch; index: number; anchor: Element; point: Element | SearchMatch;}>
        >();
        for (const entry of host) {
            const element = elementOf(entry.match);
            if (!element) continue;
            const context = contextOf(element, owner);
            if (context.hidden) continue;
            const scope = context.scope;
            if (!scope) continue;
            const {label, svg} = context;
            if (svg && label) {
                const group = groups.get(svg) ?? [];
                group.push({...entry, anchor: label, point: label});
                groups.set(svg, group);
            }
            // Tables, diagram labels and formula/memo hosts remain intact.
            // Ordinary paragraph hits can interleave with the neighboring column.
            if (scope.localName === "svg") continue;
            const anchor = context.block;
            if (!anchor) continue;
            const group = groups.get(scope) ?? [];
            const intact = svg ?
                anchor :
                element.closest('td, th, [data-type="NodeTable"]') ?
                anchor :
                element.closest(
                    '[data-type="NodeMathBlock"], span[data-type~="inline-math"], span[data-inline-memo-content]',
                );
            group.push({
                ...entry,
                anchor,
                point: intact ?? (blockOf(entry.match)?.textNodes.length ? entry.match : anchor),
            });
            groups.set(scope, group);
        }
        // First order each diagram's labels, then columns; the second stage keeps
        // the already ordered labels together with their owning block.
        const scopes = Array.from(groups.keys()).sort((a, b) =>
            Number(a.localName !== "svg") - Number(b.localName !== "svg")
        );
        for (const scope of scopes) {
            const group = groups.get(scope)!;
            const anchors = Array.from(new Set(group.map(({anchor}) => anchor)));
            if (anchors.length < 2 || anchors.length > remaining) continue;
            const points = Array.from(new Set(group.map(({point}) => point)));
            // Large column result sets use intact blocks rather than creating
            // unbounded Ranges. SVG label measurements stay one per label.
            const detailed = points.length <= remaining && typeof Range.prototype.getClientRects === "function";
            const keys = detailed ? points : anchors;
            const rectangles: Array<{key: Element | SearchMatch; top: number; left: number; ordinal: number;}> = [];
            for (const key of keys) {
                remaining--;
                try {
                    let rect: DOMRect | undefined;
                    if (key instanceof Element) rect = key.getBoundingClientRect();
                    else {
                        // The leading line defines reading order; do not copy
                        // all rectangles for a match spanning a long paragraph.
                        const rects = rangeOf(key)?.getClientRects();
                        if (rects?.length) rect = rects[0];
                    }
                    if (
                        !rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left) ||
                        !(rect.width > 0 && rect.height > 0)
                    ) break;
                    rectangles.push({key, top: rect.top, left: rect.left, ordinal: rectangles.length});
                } catch {
                    break;
                }
            }
            // An incomplete/zero-sized layout cannot define a safe visual order.
            if (rectangles.length !== keys.length) continue;
            rectangles.sort((a, b) => a.top - b.top || a.left - b.left || a.ordinal - b.ordinal);
            const ranks = new Map<Element | SearchMatch, number>();
            for (let start = 0; start < rectangles.length;) {
                let end = start + 1;
                // Fixed row origin keeps this grouping transitive and stable.
                while (end < rectangles.length && rectangles[end].top - rectangles[start].top <= 2) end++;
                const row = rectangles.slice(start, end).sort((a, b) =>
                    a.left - b.left || a.top - b.top || a.ordinal - b.ordinal
                );
                row.forEach(({key}, index) => ranks.set(key, start + index));
                start = end;
            }
            const ordered = group.map((entry) => ({...entry, match: matches[entry.index]})).sort((a, b) =>
                ranks.get(detailed ? a.point : a.anchor)! - ranks.get(detailed ? b.point : b.anchor)! ||
                a.index - b.index
            );
            group.forEach((entry, index) => matches[entry.index] = ordered[index].match);
        }
    }
}
