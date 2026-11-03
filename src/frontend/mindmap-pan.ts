/**
 * 把思维导图视口外的命中滑进显示区域。
 * 位移和思源 revealNode 相同，但通过视口上的滚轮处理函数提交，
 * 这样节点和 canvas 连线一起重画。不改缩放，不展开折叠。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.9/app/src/protyle/render/listMindmap/view.ts
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
    // 先把命中移回内层视口，外层再按最终位置平移，避免内层随后把命中移出外层。
    for (const view of views) {
        panView(view, range);
    }
}

function panView(view: HTMLElement, range: Range): void {
    const viewport = view.querySelector<HTMLElement>(":scope > .mindmap-view__viewport");
    if (!viewport || view.classList.contains("mindmap-view--locked")) {
        return;
    }
    const horizontal = panDelta(viewport, range, "x");
    const vertical = panDelta(viewport, range, "y");
    if (!horizontal && !vertical) {
        return;
    }
    const wasActive = view.classList.contains("mindmap-view--active");
    // 搜索框持有焦点时原生 wheel 会忽略平移。只点击 host 本身来临时激活，
    // 不发 pointerdown、不点击节点/控件，也不调用 focus，保留搜索输入与节点选择。
    if (!wasActive) {
        view.dispatchEvent(new MouseEvent("click", {bubbles: false}));
    }
    try {
        if (horizontal) {
            // 分轴提交，避免原生边界约束将另一轴的一次平移挡住。
            dispatchWheel(viewport, -horizontal, 0, true);
        }
        const nextVertical = horizontal ? panDelta(viewport, range, "y") : vertical;
        if (nextVertical) {
            dispatchWheel(viewport, 0, -nextVertical, false);
        }
    } finally {
        if (!wasActive && view.classList.contains("mindmap-view--active")) {
            // 复用原生失焦收尾；仅通知状态，不移动实际焦点，不遗留滚轮接管状态。
            const active = view.ownerDocument.activeElement;
            view.dispatchEvent(new FocusEvent("focusout", {
                bubbles: false,
                relatedTarget: active && !view.contains(active) ? active : view.ownerDocument.body,
            }));
        }
    }
}

function panDelta(viewport: HTMLElement, range: Range, axis: "x" | "y"): number {
    const target = targetRect(viewport, range);
    const viewRect = viewport.getBoundingClientRect();
    if (!target || !viewRect.width || !viewRect.height) {
        return 0;
    }
    // 原生 wheel 的像素量是局部坐标，Rect 则已包含编辑器 zoom / 外层导图缩放。
    const scale = axis === "x" ? viewRect.width / (viewport.offsetWidth || viewRect.width) :
        viewRect.height / (viewport.offsetHeight || viewRect.height);
    const margin = PAN_MARGIN * scale;
    if (axis === "x") {
        if (target.left < viewRect.left + margin) {
            return (viewRect.left + margin - target.left) / scale;
        }
        if (target.right > viewRect.right - margin) {
            return (viewRect.right - margin - target.right) / scale;
        }
        return 0;
    }
    if (target.top < viewRect.top + margin) {
        return (viewRect.top + margin - target.top) / scale;
    }
    if (target.bottom > viewRect.bottom - margin) {
        return (viewRect.bottom - margin - target.bottom) / scale;
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
