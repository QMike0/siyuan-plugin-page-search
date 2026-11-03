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
        panView(view, range, view === frame);
    }
}

function panView(view: HTMLElement, range: Range, outermost: boolean): void {
    const viewport = view.querySelector<HTMLElement>(":scope > .mindmap-view__viewport");
    if (!viewport || view.classList.contains("mindmap-view--locked")) {
        return;
    }
    // 原生 positionNodes 只给折叠动画中增减的节点设置 inert。仅检查本层，
    // 不让内层动画提前触发外层 wheel；即使命中暂时可见，也须按动画最终位置定位。
    const animating = Boolean(view.querySelector(
        ":scope > .mindmap-view__viewport > .mindmap-view__world > .mindmap-view__node[inert]",
    ));
    let delta = animating ? null : panDelta(view, viewport, range, outermost);
    if (!animating && (!delta || (!delta.x && !delta.y))) {
        return;
    }
    const wasActive = view.classList.contains("mindmap-view--active");
    // 搜索框持有焦点时原生 wheel 会忽略平移。只点击 host 本身来临时激活，
    // 不发 pointerdown、不点击节点/控件，也不调用 focus，保留搜索输入与节点选择。
    if (!wasActive) {
        view.dispatchEvent(new MouseEvent("click", {bubbles: false}));
    }
    try {
        if (animating) {
            // wheel 会同步结束原生折叠动画；零位移只收尾，之后再读取最终布局，
            // 避免原先算出的位移在收尾重排后失效。稳定状态不发送此事件。
            dispatchWheel(viewport, 0, 0);
            delta = panDelta(view, viewport, range, outermost);
        }
        // 同次提交双轴，与 revealNode 一致；分轴会被原生单轴边界限制挡在斜向目标之外。
        if (delta && (delta.x || delta.y)) {
            dispatchWheel(viewport, -delta.x, -delta.y);
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

function panDelta(view: HTMLElement, viewport: HTMLElement, range: Range, outermost: boolean): {x: number, y: number} | null {
    const target = targetRect(viewport, range);
    const viewRect = viewport.getBoundingClientRect();
    if (!target || !viewRect.width || !viewRect.height) {
        return null;
    }
    // 原生 wheel 的像素量是局部坐标，Rect 则已包含编辑器 zoom / 外层导图缩放。
    const scaleX = viewRect.width / (viewport.offsetWidth || viewRect.width);
    const scaleY = viewRect.height / (viewport.offsetHeight || viewRect.height);
    // 内层导图可能整体在屏外，须先按自己的视口定位，再由外层移入编辑器的显示区域。
    const bounds = outermost ? visibleBounds(view, viewRect) : viewRect;
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
        return null;
    }
    const marginX = PAN_MARGIN * scaleX;
    const marginY = PAN_MARGIN * scaleY;
    const left = bounds.left + marginX;
    const right = bounds.right - marginX;
    const x = target.left < left ? left - target.left :
        target.right > right ? Math.max(left - target.left, right - target.right) : 0;
    let top = bounds.top + marginY;
    let bottom = bounds.bottom - marginY;
    // 与原生 revealNode 相同，只避让横向定位后仍遮住命中的可见控件。
    const toolbar = view.querySelector<HTMLElement>(":scope > .mindmap-view__toolbar");
    if (toolbar && isVisibleControl(toolbar)) {
        toolbar.querySelectorAll<HTMLElement>(".mindmap-view__toolbar-group, .mindmap-view__zoom-actions").forEach(control => {
            if (!isVisibleControl(control)) {
                return;
            }
            const box = control.getBoundingClientRect();
            if (box.width && box.height && box.bottom > bounds.top && box.top < bounds.bottom &&
                target.left + x < box.right && target.right + x > box.left) {
                top = Math.max(top, box.bottom + marginY);
            }
        });
    }
    const inspector = view.querySelector<HTMLElement>(":scope > .mindmap-view__inspector");
    if (inspector && isVisibleControl(inspector)) {
        const box = inspector.getBoundingClientRect();
        if (box.width && box.height && box.bottom > bounds.top && box.top < bounds.bottom &&
            target.left + x < box.right && target.right + x > box.left) {
            bottom = Math.min(bottom, box.top - marginY);
        }
    }
    const y = target.top < top ? top - target.top :
        target.bottom > bottom ? Math.max(top - target.top, bottom - target.bottom) : 0;
    return {x: x / scaleX, y: y / scaleY};
}

function visibleBounds(view: HTMLElement, rect: DOMRect): Pick<DOMRect, "left" | "right" | "top" | "bottom"> {
    const win = view.ownerDocument.defaultView;
    const screen = win?.visualViewport;
    const bounds = {
        left: Math.max(rect.left, screen?.offsetLeft ?? 0),
        right: Math.min(rect.right, (screen?.offsetLeft ?? 0) + (screen?.width ?? win?.innerWidth ?? rect.right)),
        top: Math.max(rect.top, screen?.offsetTop ?? 0),
        bottom: Math.min(rect.bottom, (screen?.offsetTop ?? 0) + (screen?.height ?? win?.innerHeight ?? rect.bottom)),
    };
    // 只检查当前导图的祖先，不遍历文档。裁切边界采用 client 区域，排除边框和滚动条。
    for (let parent = view.parentElement; parent && win; parent = parent.parentElement) {
        const style = win.getComputedStyle(parent);
        const paint = /\b(paint|strict|content)\b/.test(style.contain);
        const clipX = paint || /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX || style.overflow);
        const clipY = paint || /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY || style.overflow);
        if (!clipX && !clipY) {
            continue;
        }
        const box = parent.getBoundingClientRect();
        if (clipX) {
            const scale = box.width / (parent.offsetWidth || box.width || 1);
            const left = box.left + parent.clientLeft * scale;
            bounds.left = Math.max(bounds.left, left);
            bounds.right = Math.min(bounds.right, parent.offsetWidth ? left + parent.clientWidth * scale : box.right);
        }
        if (clipY) {
            const scale = box.height / (parent.offsetHeight || box.height || 1);
            const top = box.top + parent.clientTop * scale;
            bounds.top = Math.max(bounds.top, top);
            bounds.bottom = Math.min(bounds.bottom, parent.offsetHeight ? top + parent.clientHeight * scale : box.bottom);
        }
    }
    return bounds;
}

function isVisibleControl(element: HTMLElement): boolean {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
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

function dispatchWheel(viewport: HTMLElement, deltaX: number, deltaY: number): void {
    viewport.dispatchEvent(new WheelEvent("wheel", {
        // 不冒泡，避免外层导图的视口把同一次位移再吃一遍。
        bubbles: false,
        cancelable: true,
        deltaX,
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        shiftKey: false,
        ctrlKey: false,
    }));
}
