/**
 * 思源页签块：未选中的 .tab-item 带 data-tabs-hidden="true"，CSS 为 display:none。
 * 块仍在 DOM 里，高度为 0。跳转若把它当成已显示，就不会切换页签。
 * 只改 tabs-active-id，让页签渲染器自己刷新。不写回属性，避免触发文档事务把橙色高亮冲掉。
 * 不点击页签按钮，避免把光标挪到页签开头。
 */
export function revealHiddenTabs(target: Element | null): boolean {
    if (!target || typeof target.closest !== "function") {
        return false;
    }
    const hidden: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    let item = target.closest<HTMLElement>(".tab-item");
    while (item && !seen.has(item)) {
        seen.add(item);
        if (item.getAttribute("data-tabs-hidden") === "true") {
            hidden.push(item);
        }
        item = item.parentElement?.closest<HTMLElement>(".tab-item") ?? null;
    }
    if (hidden.length === 0) {
        return false;
    }
    for (let index = hidden.length - 1; index >= 0; index--) {
        activateTabPanel(hidden[index]);
    }
    return true;
}

function activateTabPanel(item: HTMLElement): void {
    const tabs = item.parentElement;
    const id = item.getAttribute("data-node-id") || "";
    if (!tabs || !tabs.classList.contains("tabs") || !id) {
        return;
    }
    releaseFocusInsideOtherPanels(tabs, item);
    const changed = tabs.getAttribute("tabs-active-id") !== id;
    if (changed) {
        tabs.setAttribute("tabs-active-id", id);
    }
    Array.from(tabs.children).forEach((child) => {
        if (!(child instanceof HTMLElement) || !child.classList.contains("tab-item")) {
            return;
        }
        const panelId = child.getAttribute("data-node-id") || "";
        if (!panelId) {
            return;
        }
        child.setAttribute("data-tabs-hidden", panelId === id ? "false" : "true");
    });
}

/** 光标留在旧页签时，思源会推迟切换。先移开焦点，搜索框不在页签内所以不受影响。 */
function releaseFocusInsideOtherPanels(tabs: HTMLElement, target: HTMLElement): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && tabs.contains(active) && !target.contains(active)) {
        active.blur();
    }
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (anchor && tabs.contains(anchor) && !target.contains(anchor)) {
        selection.removeAllRanges();
    }
}

/**
 * 页签标题的正文在 .tab-item-info 里，界面上是 display:none。
 * 导航标签是它的克隆。高亮需要画在克隆上，但不能再算成一次命中。
 */
export function mirrorTabsTitleRange(range: Range): Range | null {
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element
        : range.startContainer.parentElement;
    const title = element?.closest<HTMLElement>('[tabs-title="true"], .tab-item-title');
    if (!title || !title.closest(".tab-item-info")) {
        return null;
    }
    if (title.clientHeight > 0 || title.getClientRects().length > 0) {
        return null;
    }
    const item = title.closest<HTMLElement>(".tab-item");
    const id = item?.getAttribute("data-node-id") || "";
    const tabs = item?.parentElement;
    if (!id || !tabs?.classList.contains("tabs")) {
        return null;
    }
    const label = tabs.querySelector<HTMLElement>(
        `:scope > .tabs-header [data-tab-id="${CSS.escape(id)}"] .tabs-tab-label`,
    );
    if (!label || label.contains(range.startContainer)) {
        return null;
    }
    const start = offsetWithin(title, range.startContainer, range.startOffset);
    const end = offsetWithin(title, range.endContainer, range.endOffset);
    if (start == null || end == null || end <= start) {
        return null;
    }
    const titleText = elementText(title);
    const labelText = elementText(label);
    if (end > labelText.length || labelText.slice(start, end) !== titleText.slice(start, end)) {
        return null;
    }
    return rangeWithin(label, start, end);
}

function offsetWithin(root: HTMLElement, container: Node, offset: number): number | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let index = 0;
    let current = walker.nextNode();
    while (current) {
        if (current === container) {
            return index + offset;
        }
        index += current.nodeValue?.length ?? 0;
        current = walker.nextNode();
    }
    return null;
}

function elementText(root: HTMLElement): string {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    let current = walker.nextNode();
    while (current) {
        text += current.nodeValue ?? "";
        current = walker.nextNode();
    }
    return text;
}

function rangeWithin(root: HTMLElement, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let index = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    let current = walker.nextNode();
    while (current) {
        const value = current.nodeValue ?? "";
        const next = index + value.length;
        if (!startNode && start >= index && start <= next) {
            startNode = current as Text;
            startOffset = start - index;
        }
        if (!endNode && end >= index && end <= next) {
            endNode = current as Text;
            endOffset = end - index;
        }
        index = next;
        current = walker.nextNode();
    }
    if (!startNode || !endNode) {
        return null;
    }
    try {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
    } catch {
        return null;
    }
}
