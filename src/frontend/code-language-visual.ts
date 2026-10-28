/** Frames live outside note content; neither transactions nor undo serialize them. */
const layers = new WeakMap<Element, HTMLElement>();
const LAYER = "page-search-code-language-layer";
const motions = new WeakMap<Element, {
    targets: Set<Element>; observer: MutationObserver; redraw: () => void; raf: number;
}>();

function clearMotionSync(edit: Element): void {
    const motion = motions.get(edit);
    if (!motion) return;
    motion.observer.disconnect();
    if (motion.raf) window.cancelAnimationFrame(motion.raf);
    motions.delete(edit);
}

function syncMindmapMotion(edit: Element, hosts: Set<HTMLElement>, redraw: () => void): void {
    const targets = new Set<Element>();
    for (const host of hosts) {
        let world = host.closest(".mindmap-view__world");
        while (world) {
            targets.add(world);
            world = world.parentElement?.closest(".mindmap-view__world") ?? null;
        }
    }
    const current = motions.get(edit);
    if (current && current.targets.size === targets.size && Array.from(targets).every(target => current.targets.has(target))) {
        current.redraw = redraw;
        return;
    }
    clearMotionSync(edit);
    if (!targets.size) return;
    const motion = {targets, redraw, raf: 0, observer: null as MutationObserver | null};
    motion.observer = new MutationObserver(() => {
        if (!motion.raf) motion.raf = window.requestAnimationFrame(() => {
            motion.raf = 0;
            motion.redraw();
        });
    });
    // Native pan/zoom changes only this transform, without a scroll or resize event.
    // Observe the relevant worlds directly; never watch every style change in the note.
    targets.forEach(target => motion.observer.observe(target, {attributes: true, attributeFilter: ["style"]}));
    motions.set(edit, motion);
}

export function clearCodeLanguageVisual(edit: Element): void {
    clearMotionSync(edit);
    const layer = layers.get(edit);
    layer?.parentElement?.classList.remove("page-search-code-language-host");
    layer?.remove();
    layers.delete(edit);
}

export function codeLanguageFrameHost(range: Range): HTMLElement | null {
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>('[data-type="NodeCodeBlock"], .code-block, pre') ?? null;
}

export function imageOCRFrameHost(range: Range): HTMLElement | null {
    if (range.collapsed || range.endContainer !== range.startContainer || range.endOffset !== range.startOffset + 1) return null;
    const node = range.startContainer;
    // OCR Range selects the img node in native BlockDOM or a rich-cell HTML preview.
    const selected = node.childNodes[range.startOffset];
    return selected instanceof HTMLElement && selected.tagName === "IMG" ? selected : null;
}

function frameHost(range: Range): HTMLElement | null {
    return imageOCRFrameHost(range) ?? codeLanguageFrameHost(range);
}

/** Overlay frames must obey the host's own scrollports, not just the editor viewport.
 * Memoize the shared ancestor chains once per draw, including their layout/style reads.
 */
function frameClipReader(content: HTMLElement, origin: DOMRect) {
    type Clip = {left: number; top: number; right: number; bottom: number;};
    const clips = new Map<Element, Clip>();
    clips.set(content, {left: origin.left, top: origin.top, right: origin.right, bottom: origin.bottom});
    const read = (element: Element): Clip => {
        const cached = clips.get(element);
        if (cached) return cached;
        const parent = element.parentElement;
        const clip = {...(parent ? read(parent) : clips.get(content)!)};
        const style = getComputedStyle(element);
        const paint = /\b(paint|strict|content)\b/.test(style.contain);
        const clipX = paint || /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX || style.overflow);
        const clipY = paint || /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY || style.overflow);
        if ((clipX || clipY) && element instanceof HTMLElement) {
            const rect = element.getBoundingClientRect();
            const sx = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
            const sy = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
            const left = rect.left + element.clientLeft * sx;
            const top = rect.top + element.clientTop * sy;
            const width = element.offsetWidth > 0 ? element.clientWidth * sx : rect.width;
            const height = element.offsetHeight > 0 ? element.clientHeight * sy : rect.height;
            if (clipX) { clip.left = Math.max(clip.left, left); clip.right = Math.min(clip.right, left + width); }
            if (clipY) { clip.top = Math.max(clip.top, top); clip.bottom = Math.min(clip.bottom, top + height); }
        }
        clips.set(element, clip);
        return clip;
    };
    return read;
}

export function applyCodeLanguageVisual(edit: Element, ranges: readonly Range[], focus?: Range | null): void {
    const hosts = new Set<HTMLElement>();
    for (const range of ranges) {
        const host = frameHost(range);
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
    const focused = focus ? frameHost(focus) : null;
    syncMindmapMotion(edit, hosts, () => applyCodeLanguageVisual(edit, ranges, focus));
    const readClip = frameClipReader(content, origin);
    const fragment = content.ownerDocument.createDocumentFragment();
    for (const host of hosts) {
        const rect = host.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < origin.top || rect.top > origin.bottom) continue;
        const clip = host.parentElement ? readClip(host.parentElement) : null;
        if (clip && (clip.left >= clip.right || clip.top >= clip.bottom ||
            rect.right <= clip.left || rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom)) continue;
        const frame = content.ownerDocument.createElement("div");
        frame.className = `page-search-code-language-frame${host === focused ? " is-focus" : ""}`;
        frame.style.left = `${(rect.left - origin.left) / scaleX + content.scrollLeft - content.clientLeft}px`;
        frame.style.top = `${(rect.top - origin.top) / scaleY + content.scrollTop - content.clientTop}px`;
        frame.style.width = `${rect.width / scaleX}px`;
        frame.style.height = `${rect.height / scaleY}px`;
        if (clip) {
            // Clip the original border, preserving its true location at a partially hidden host.
            frame.style.clipPath = `inset(${Math.max(0, clip.top - rect.top) / scaleY}px ${Math.max(0, rect.right - clip.right) / scaleX}px ${Math.max(0, rect.bottom - clip.bottom) / scaleY}px ${Math.max(0, clip.left - rect.left) / scaleX}px)`;
        }
        fragment.appendChild(frame);
    }
    layer.replaceChildren(fragment);
}
