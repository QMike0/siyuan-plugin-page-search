/** Frames live outside note content; neither transactions nor undo serialize them. */
const layers = new WeakMap<Element, HTMLElement>();
const LAYER = "page-search-code-language-layer";

export function clearCodeLanguageVisual(edit: Element): void {
    const layer = layers.get(edit);
    layer?.parentElement?.classList.remove("page-search-code-language-host");
    layer?.remove();
    layers.delete(edit);
}

export function codeLanguageFrameHost(range: Range): HTMLElement | null {
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>('[data-type="NodeCodeBlock"], .code-block') ?? null;
}

export function applyCodeLanguageVisual(edit: Element, ranges: readonly Range[], focus?: Range | null): void {
    const hosts = new Set<HTMLElement>();
    for (const range of ranges) {
        const host = codeLanguageFrameHost(range);
        if (host?.isConnected && edit.contains(host)) hosts.add(host);
    }
    if (!hosts.size) { clearCodeLanguageVisual(edit); return; }
    const content = hosts.values().next().value?.closest<HTMLElement>(".protyle-content");
    if (!content) { clearCodeLanguageVisual(edit); return; }
    let layer = layers.get(edit);
    if (!layer || layer.parentElement !== content) {
        clearCodeLanguageVisual(edit);
        layer = content.ownerDocument.createElement("div");
        layer.className = LAYER;
        layer.setAttribute("aria-hidden", "true");
        content.classList.add("page-search-code-language-host");
        content.appendChild(layer);
        layers.set(edit, layer);
    }
    const origin = content.getBoundingClientRect();
    // Match the host's CSS zoom without scaling the note or changing its layout.
    const scaleX = content.offsetWidth > 0 ? origin.width / content.offsetWidth : 1;
    const scaleY = content.offsetHeight > 0 ? origin.height / content.offsetHeight : 1;
    if (!(scaleX > 0 && scaleY > 0)) { layer.replaceChildren(); return; }
    const focused = focus ? codeLanguageFrameHost(focus) : null;
    const fragment = content.ownerDocument.createDocumentFragment();
    for (const host of hosts) {
        const rect = host.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < origin.top || rect.top > origin.bottom) continue;
        const frame = content.ownerDocument.createElement("div");
        frame.className = `page-search-code-language-frame${host === focused ? " is-focus" : ""}`;
        frame.style.left = `${(rect.left - origin.left) / scaleX + content.scrollLeft - content.clientLeft}px`;
        frame.style.top = `${(rect.top - origin.top) / scaleY + content.scrollTop - content.clientTop}px`;
        frame.style.width = `${rect.width / scaleX}px`;
        frame.style.height = `${rect.height / scaleY}px`;
        fragment.appendChild(frame);
    }
    layer.replaceChildren(fragment);
}
