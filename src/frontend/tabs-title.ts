/** tabsRender keeps the source title and rebuilds its ID-free navigation clone. */
export function tabsLabelSourceBlock(label: HTMLElement): HTMLElement | null {
    const tabId = label.closest("[data-tab-id]")?.getAttribute("data-tab-id");
    const tabs = label.closest('[data-type="NodeTabs"]');
    if (!tabId || !tabs) return null;
    return tabs.querySelector<HTMLElement>(`:scope > .tab-item[data-node-id="${CSS.escape(tabId)}"] > .tab-item-info > [data-node-id][tabs-title], ` +
        `:scope > .tab-item[data-node-id="${CSS.escape(tabId)}"] > .tab-item-info > [data-node-id]:has(> .tab-item-title)`);
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
                const sources = sourceBlock.querySelectorAll<HTMLElement>('span[data-type~="inline-math"][data-content]');
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
