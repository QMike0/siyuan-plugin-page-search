/**
 * 把思维导图视口外的命中滑进显示区域。
 * 位移和思源 revealNode 相同，但通过视口上的滚轮处理函数提交，
 * 这样节点和 canvas 连线一起重画。不改缩放，不展开折叠。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.7-alpha.5/app/src/protyle/render/listMindmap/view.ts
 */
const PAN_MARGIN = 16;

export function panMindmapIntoView(range: Range): void {
    const origin = rangeOrigin(range);
    if (!origin) {
        return;
    }
    const views: HTMLElement[] = [];
    let view = origin.closest<HTMLElement>(".mindmap-view");
    while (view) {
        views.push(view);
        view = view.parentElement?.closest<HTMLElement>(".mindmap-view") ?? null;
    }
    if (!views.length) {
        return;
    }
    const frame = views[views.length - 1];
    const node = origin.closest<HTMLElement>(".mindmap-view__node");
    if (node?.hidden) {
        frame.scrollIntoView({block: "center", inline: "nearest"});
        return;
    }
    frame.scrollIntoView({block: "center", inline: "nearest"});
    for (let index = views.length - 1; index >= 0; index--) {
        panView(views[index], range);
    }
}

function panView(view: HTMLElement, range: Range): void {
    const viewport = view.querySelector<HTMLElement>(":scope > .mindmap-view__viewport");
    if (!viewport) {
        return;
    }
    const horizontal = panDelta(viewport, range, "x");
    if (horizontal) {
        // shift 只改水平偏移。垂直被边界挡住时，思源会整次放弃，所以分开送。
        dispatchWheel(viewport, -horizontal, 0, true);
    }
    const vertical = panDelta(viewport, range, "y");
    if (vertical) {
        dispatchWheel(viewport, 0, -vertical, false);
    }
}

function panDelta(viewport: HTMLElement, range: Range, axis: "x" | "y"): number {
    const target = targetRect(viewport, range);
    const viewRect = viewport.getBoundingClientRect();
    if (!target || !viewRect.width || !viewRect.height) {
        return 0;
    }
    if (axis === "x") {
        if (target.left < viewRect.left + PAN_MARGIN) {
            return viewRect.left + PAN_MARGIN - target.left;
        }
        if (target.right > viewRect.right - PAN_MARGIN) {
            return viewRect.right - PAN_MARGIN - target.right;
        }
        return 0;
    }
    if (target.top < viewRect.top + PAN_MARGIN) {
        return viewRect.top + PAN_MARGIN - target.top;
    }
    if (target.bottom > viewRect.bottom - PAN_MARGIN) {
        return viewRect.bottom - PAN_MARGIN - target.bottom;
    }
    return 0;
}

function targetRect(viewport: HTMLElement, range: Range): DOMRect | null {
    const origin = rangeOrigin(range);
    if (!origin || !viewport.contains(origin)) {
        return null;
    }
    const node = origin.closest<HTMLElement>(".mindmap-view__node");
    if (!node || node.hidden || !viewport.contains(node)) {
        return null;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return rect;
    }
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) {
        return null;
    }
    return box;
}

function rangeOrigin(range: Range): Element | null {
    const container = range.startContainer;
    if (!container.isConnected) {
        return null;
    }
    return container.nodeType === Node.ELEMENT_NODE
        ? container as Element
        : container.parentElement;
}

function dispatchWheel(viewport: HTMLElement, deltaX: number, deltaY: number, shiftKey: boolean): void {
    if (!deltaX && !deltaY) {
        return;
    }
    viewport.dispatchEvent(new WheelEvent("wheel", {
        // 不冒泡，避免外层导图的视口把同一次位移再吃一遍。
        bubbles: false,
        cancelable: true,
        deltaX,
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        shiftKey,
        ctrlKey: false,
    }));
}
