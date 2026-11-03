/** Both native title forms write through their real block, never the navigation clone. */
export function tabTitleElement(block: Element): HTMLElement | null {
    if (block.getAttribute("data-type") === "NodeTabItem") {
        return block.querySelector<HTMLElement>(":scope > .tab-item-info > .tab-item-title");
    }
    return block.matches('[tabs-title="true"]') || block.closest(".tab-item-info") ?
        block.querySelector<HTMLElement>(":scope > .tab-item-title") : null;
}

export function isTabsTitleTextUnit(unit: {unitId?: string;}): boolean {
    return /(?:^|:)tabs-title(?:#run-\d+)?$/.test(unit.unitId ?? "");
}

/** Field titles are reparsed as inline Markdown by the kernel. Reject a write
 * if that would reinterpret literal replacement text or change untouched marks.
 * Rebuild only the saved title using the native parser and editor renderer. */
export function fieldTabTitleCanBeSaved(item: HTMLElement, lute: {
    BlockDOM2RichHTML?: (html: string) => string;
    BlockDOM2Md?: (html: string) => string;
    Md2BlockDOM?: (markdown: string) => string;
}): boolean {
    const title = tabTitleElement(item);
    if (!title || !lute?.BlockDOM2RichHTML || !lute.BlockDOM2Md || !lute.Md2BlockDOM) return false;
    // The paragraph parser also drops nested link marks; it cannot prove that
    // those marks survive. Native editor marks are normally flattened.
    if (title.querySelector(':scope [data-type~="a"] [data-type], :scope [data-type] [data-type~="a"]')) return false;
    try {
        const parsed = document.createElement("div");
        // Standard HTML export changes memo/link representations. Read the
        // native saved field instead, retaining its editor mark attributes.
        // The comparison-only wrapper is deterministic; no body is included.
        const markdown = lute.BlockDOM2Md('<div data-type="NodeTabs" class="tabs" data-node-id="20261103000000-pgsrch0">' +
            '<div data-type="NodeTabItem" class="tab-item" data-node-id="20261103000000-pgsrch1"><div class="tab-item-info">' +
            title.outerHTML + '</div><div class="tab-item-content"></div></div></div>');
        parsed.innerHTML = lute.Md2BlockDOM(markdown);
        const actual = parsed.querySelector(".tab-item-title");
        if (!actual) return false;
        // Read both through the same paragraph parser. Rich HTML distinguishes
        // literal Markdown from formatting; Markdown also retains reference/
        // memo identities omitted from standard HTML.
        const paragraph = (html: string) => '<div data-type="NodeParagraph"><div contenteditable="true">' + html + "</div></div>";
        const expected = paragraph(title.innerHTML);
        const saved = paragraph(actual.innerHTML);
        return lute.BlockDOM2RichHTML(expected) === lute.BlockDOM2RichHTML(saved) &&
            lute.BlockDOM2Md(expected) === lute.BlockDOM2Md(saved);
    } catch { return false; }
}

/** tabsRender keeps the source title and rebuilds its ID-free navigation clone. */
export function tabsLabelSourceBlock(label: HTMLElement): HTMLElement | null {
    const tabId = label.closest("[data-tab-id]")?.getAttribute("data-tab-id");
    const tabs = label.closest('[data-type="NodeTabs"]');
    if (!tabId || !tabs) return null;
    const item = tabs.querySelector<HTMLElement>(`:scope > .tab-item[data-node-id="${CSS.escape(tabId)}"]`);
    return item?.querySelector<HTMLElement>(":scope > .tab-item-info > [data-node-id][tabs-title], " +
        ":scope > .tab-item-info > [data-node-id]:has(> .tab-item-title)") ??
        (item && tabTitleElement(item) ? item : null);
}

export function tabsSourceTitleLabel(element: HTMLElement): HTMLElement | null {
    const info = element.closest(".tab-item-info");
    const item = info?.parentElement;
    const tabs = item?.parentElement;
    const id = item?.getAttribute("data-node-id");
    if (!id || !item?.classList.contains("tab-item") || !tabs?.classList.contains("tabs") ||
        item.getAttribute("data-tabs-editing") === "true") return null;
    return tabs.querySelector<HTMLElement>(`:scope > .tabs-header [data-tab-id="${CSS.escape(id)}"] .tabs-tab-label`);
}

interface TabsTitleMath {
    sourceBlock: HTMLElement;
    source: HTMLElement;
    label: HTMLElement;
    labelMath?: HTMLElement;
}

/** Collection-local snapshots: a generic "Tab" label never stands in for a formula.
 * Match by formula position AND source, so stale navigation clones cannot add hits.
 */
export function createTabsTitleMathReader(): (element: HTMLElement) => TabsTitleMath | undefined {
    const links = new WeakMap<HTMLElement, TabsTitleMath>();
    const scanned = new WeakSet<HTMLElement>();
    return element => {
        if (links.has(element)) return links.get(element);
        const label = element.closest<HTMLElement>(".tabs-header .tabs-tab-label") ?? tabsSourceTitleLabel(element);
        if (!label) return undefined;
        if (!scanned.has(label)) {
            scanned.add(label);
            const sourceBlock = tabsLabelSourceBlock(label);
            if (sourceBlock && sourceBlock.closest(".tab-item")?.getAttribute("data-tabs-editing") !== "true") {
                const sources: NodeListOf<HTMLElement> | HTMLElement[] = tabTitleElement(sourceBlock)?.querySelectorAll<HTMLElement>('span[data-type~="inline-math"][data-content]') ?? [];
                const copies = label.querySelectorAll<HTMLElement>('span[data-type~="inline-math"][data-content]');
                sources.forEach((source, index) => {
                    const copy = copies[index];
                    const labelMath = copy?.getAttribute("data-content") === source.getAttribute("data-content") ? copy : undefined;
                    const link = {sourceBlock, source, label, labelMath};
                    links.set(source, link);
                    if (labelMath) links.set(labelMath, link);
                });
            }
        }
        return links.get(element);
    };
}

/** Clone children keep their positions, including br -> Text(" "). Map endpoints
 * structurally so line breaks/formula glyphs never shift a later plain-text hit. */
export function projectTabsTitleTextNode(node: Text, label: HTMLElement): Text | null {
    const projected = projectTabsTitleNode(node, label);
    return projected instanceof Text && projected.data === node.data ? projected : null;
}

/** Memo attributes belong to the saved title; only their underline uses the clone. */
export function projectTabsTitleMemoHost(host: HTMLElement): HTMLElement | null {
    const label = tabsSourceTitleLabel(host);
    const projected = label && projectTabsTitleNode(host, label);
    return projected instanceof HTMLElement && projected.matches('span[data-type~="inline-memo"]') &&
        projected.getAttribute("data-inline-memo-content") === host.getAttribute("data-inline-memo-content") ? projected : null;
}

function projectTabsTitleNode(node: Node, label: HTMLElement): Node | null {
    const title = node.parentElement?.closest(".tab-item-title");
    if (!title) return null;
    const path: number[] = [];
    let current: Node = node;
    while (current !== title) {
        const parent = current.parentNode;
        if (!parent) return null;
        path.push(Array.prototype.indexOf.call(parent.childNodes, current));
        current = parent;
    }
    current = label;
    for (let index = path.length - 1; index >= 0; index--) {
        const child = current.childNodes[path[index]];
        if (!child) return null;
        current = child;
    }
    return current;
}
