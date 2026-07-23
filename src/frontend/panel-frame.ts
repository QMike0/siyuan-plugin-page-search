/**
 * 搜索面板拖拽 / 左侧改宽（对齐 siyuan-sou-easy use-panel-frame）。
 * 位置可持久化；宽度仅会话内有效。
 */

import {resolveFixedPanelZIndex} from "./panel-layer";

export interface PanelPosition {
    left: number;
    top: number;
}

const PANEL_MARGIN = 8;
const DEFAULT_PANEL_WIDTH = 420;
const MIN_PANEL_WIDTH = 300;

const NON_DRAG_SELECTOR = [
    "input",
    "textarea",
    "button",
    "select",
    "option",
    "a",
    '[contenteditable]:not([contenteditable="false"])',
    ".search-no-drag",
    ".search-option",
    ".search-field",
    ".search-tools",
    ".search-replace-toggle",
    ".search-resize-handle",
    "[data-action]",
    "[data-option]",
].join(", ");

export interface SearchPanelFrameOptions {
    panel: HTMLElement;
    persistPosition: (position: PanelPosition | null) => void;
    /** 移动端禁用拖拽与改宽 */
    enabled: boolean;
    /** 思源 Dialog 打开/关闭时回调（用于收起齿轮菜单等） */
    onSiyuanDialogLayerChange?: (hasOpenDialog: boolean) => void;
}

export class SearchPanelFrame {
    private readonly panel: HTMLElement;
    private readonly persistPosition: (position: PanelPosition | null) => void;
    private readonly enabled: boolean;
    private readonly onSiyuanDialogLayerChange?: (hasOpenDialog: boolean) => void;

    private panelWidth = resolveDefaultPanelWidth();
    private panelPosition: PanelPosition | null = null;
    private lastDialogOpen = false;
    private dialogLayerObserver: MutationObserver | null = null;
    private dialogLayerRaf = 0;

    private dragState: {
        pointerId: number;
        panelLeft: number;
        panelTop: number;
        startClientX: number;
        startClientY: number;
    } | null = null;

    private resizeState: {
        pointerId: number;
        panelRight: number;
        panelTop: number;
    } | null = null;

    private readonly onPanelPointerDown: (event: PointerEvent) => void;
    private readonly onResizePointerDown: (event: PointerEvent) => void;
    private readonly onPanelDoubleClick: (event: MouseEvent) => void;
    private readonly onViewportResize: () => void;

    constructor(options: SearchPanelFrameOptions) {
        this.panel = options.panel;
        this.persistPosition = options.persistPosition;
        this.enabled = options.enabled;
        this.onSiyuanDialogLayerChange = options.onSiyuanDialogLayerChange;

        this.onPanelPointerDown = (event) => this.handlePanelPointerDown(event);
        this.onResizePointerDown = (event) => this.handleResizePointerDown(event);
        this.onPanelDoubleClick = (event) => this.handlePanelDoubleClick(event);
        this.onViewportResize = () => this.syncPanelBoundsToViewport();

        this.applyStyle();
        this.startDialogLayerWatch();

        if (!this.enabled) {
            return;
        }

        this.panel.addEventListener("pointerdown", this.onPanelPointerDown);
        this.panel.addEventListener("dblclick", this.onPanelDoubleClick);
        this.panel.querySelector(".search-resize-handle")
            ?.addEventListener("pointerdown", this.onResizePointerDown as EventListener);
        window.addEventListener("resize", this.onViewportResize);
    }

    destroy() {
        this.stopDialogLayerWatch();
        this.stopPanelInteractions();
        if (!this.enabled) {
            return;
        }
        this.panel.removeEventListener("pointerdown", this.onPanelPointerDown);
        this.panel.removeEventListener("dblclick", this.onPanelDoubleClick);
        this.panel.querySelector(".search-resize-handle")
            ?.removeEventListener("pointerdown", this.onResizePointerDown as EventListener);
        window.removeEventListener("resize", this.onViewportResize);
        document.body.classList.remove("page-search-dragging", "page-search-resizing");
    }

    /** 按当前思源 Dialog 层级重算固定面板 z-index */
    syncLayering() {
        if (!this.panelPosition) {
            return;
        }
        this.applyStyle();
    }

    /** 恢复已保存的位置 */
    applySavedPosition(left: number, top: number) {
        this.panelPosition = this.clampPanelPosition({left, top});
        this.applyStyle();
    }

    /** 清除固定位置，回到默认布局（双击 / 顶栏重开） */
    resetPosition() {
        this.panelPosition = null;
        this.panelWidth = resolveDefaultPanelWidth();
        this.applyStyle();
        this.persistPosition(null);
    }

    private applyStyle() {
        this.panel.style.width = `${this.panelWidth}px`;
        if (!this.panelPosition) {
            this.panel.style.position = "";
            this.panel.style.left = "";
            this.panel.style.top = "";
            this.panel.style.transform = "";
            this.panel.style.zIndex = "";
            return;
        }
        this.panel.style.position = "fixed";
        this.panel.style.left = `${this.panelPosition.left}px`;
        this.panel.style.top = `${this.panelPosition.top}px`;
        this.panel.style.transform = "none";
        // 勿用 9999：会盖住思源全局搜索等 Dialog
        this.panel.style.zIndex = String(resolveFixedPanelZIndex());
    }

    private startDialogLayerWatch() {
        if (typeof MutationObserver !== "function") {
            return;
        }
        this.lastDialogOpen = Boolean(document.querySelector(".b3-dialog--open"));
        this.dialogLayerObserver = new MutationObserver(() => {
            // Dialog 挂在 body；class/z-index 变更较频繁，合并到一帧
            if (this.dialogLayerRaf) {
                return;
            }
            this.dialogLayerRaf = window.requestAnimationFrame(() => {
                this.dialogLayerRaf = 0;
                this.onDialogLayerMutation();
            });
        });
        // 思源 Dialog：body.append 后异步加 b3-dialog--open，并写入 style.zIndex
        this.dialogLayerObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"],
        });
    }

    private stopDialogLayerWatch() {
        this.dialogLayerObserver?.disconnect();
        this.dialogLayerObserver = null;
        if (this.dialogLayerRaf) {
            window.cancelAnimationFrame(this.dialogLayerRaf);
            this.dialogLayerRaf = 0;
        }
    }

    private onDialogLayerMutation() {
        const hasOpen = Boolean(document.querySelector(".b3-dialog--open"));
        if (this.panelPosition) {
            this.applyStyle();
        }
        if (hasOpen === this.lastDialogOpen) {
            return;
        }
        this.lastDialogOpen = hasOpen;
        this.onSiyuanDialogLayerChange?.(hasOpen);
    }

    private handlePanelPointerDown(event: PointerEvent) {
        if (event.button !== 0 || !canStartPanelDrag(event.target)) {
            return;
        }
        event.preventDefault();
        this.startDrag(event);
    }

    private handleResizePointerDown(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.startResize(event);
    }

    private handlePanelDoubleClick(event: MouseEvent) {
        if (!canStartPanelDrag(event.target)) {
            return;
        }
        this.resetPosition();
    }

    private startDrag(event: PointerEvent) {
        this.stopResize();
        const rect = this.panel.getBoundingClientRect();
        this.panelPosition = {left: rect.left, top: rect.top};
        this.panelWidth = clampPanelWidth(rect.width);
        this.applyStyle();

        this.dragState = {
            pointerId: event.pointerId,
            panelLeft: rect.left,
            panelTop: rect.top,
            startClientX: event.clientX,
            startClientY: event.clientY,
        };

        document.body.classList.add("page-search-dragging");
        window.addEventListener("pointermove", this.onDragMove);
        window.addEventListener("pointerup", this.stopDrag);
        window.addEventListener("pointercancel", this.stopDrag);
    }

    private startResize(event: PointerEvent) {
        this.stopDrag();
        const rect = this.panel.getBoundingClientRect();
        const width = clampPanelWidth(rect.width);
        this.panelWidth = width;
        this.panelPosition = {
            left: rect.right - width,
            top: rect.top,
        };
        this.applyStyle();

        this.resizeState = {
            pointerId: event.pointerId,
            panelRight: rect.right,
            panelTop: rect.top,
        };

        document.body.classList.add("page-search-resizing");
        window.addEventListener("pointermove", this.onResizeMove);
        window.addEventListener("pointerup", this.stopResize);
        window.addEventListener("pointercancel", this.stopResize);
    }

    private readonly onDragMove = (event: PointerEvent) => {
        if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
            return;
        }
        const nextLeft = this.dragState.panelLeft + (event.clientX - this.dragState.startClientX);
        const nextTop = this.dragState.panelTop + (event.clientY - this.dragState.startClientY);
        this.panelPosition = this.clampPanelPosition({left: nextLeft, top: nextTop});
        this.applyStyle();
    };

    private readonly stopDrag = (event?: PointerEvent) => {
        if (event && this.dragState && event.pointerId !== this.dragState.pointerId) {
            return;
        }
        this.dragState = null;
        document.body.classList.remove("page-search-dragging");
        window.removeEventListener("pointermove", this.onDragMove);
        window.removeEventListener("pointerup", this.stopDrag);
        window.removeEventListener("pointercancel", this.stopDrag);
        this.persistPosition(this.panelPosition);
    };

    private readonly onResizeMove = (event: PointerEvent) => {
        if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
            return;
        }
        const nextWidth = clampPanelWidth(this.resizeState.panelRight - event.clientX);
        const nextLeft = this.resizeState.panelRight - nextWidth;
        this.panelWidth = nextWidth;
        this.panelPosition = this.clampPanelPosition(
            {left: nextLeft, top: this.resizeState.panelTop},
            nextWidth,
        );
        this.applyStyle();
    };

    private readonly stopResize = (event?: PointerEvent) => {
        if (event && this.resizeState && event.pointerId !== this.resizeState.pointerId) {
            return;
        }
        this.resizeState = null;
        document.body.classList.remove("page-search-resizing");
        window.removeEventListener("pointermove", this.onResizeMove);
        window.removeEventListener("pointerup", this.stopResize);
        window.removeEventListener("pointercancel", this.stopResize);
        this.persistPosition(this.panelPosition);
    };

    private stopPanelInteractions() {
        this.stopDrag();
        this.stopResize();
    }

    private syncPanelBoundsToViewport() {
        this.panelWidth = clampPanelWidth(this.panelWidth);
        if (this.panelPosition) {
            this.panelPosition = this.clampPanelPosition(this.panelPosition);
        }
        this.applyStyle();
    }

    private clampPanelPosition(position: PanelPosition, width = this.panelWidth): PanelPosition {
        const panelHeight = this.panel.offsetHeight || 0;
        const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
        const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - panelHeight - PANEL_MARGIN);
        return {
            left: clamp(position.left, PANEL_MARGIN, maxLeft),
            top: clamp(position.top, PANEL_MARGIN, maxTop),
        };
    }
}

function canStartPanelDrag(target: EventTarget | null): boolean {
    const element = resolveEventElement(target);
    if (!element) {
        return true;
    }
    return !element.closest(NON_DRAG_SELECTOR);
}

function resolveEventElement(target: EventTarget | null): Element | null {
    if (target instanceof Element) {
        return target;
    }
    if (target instanceof Node) {
        return target.parentElement;
    }
    return null;
}

function resolveDefaultPanelWidth(): number {
    if (typeof window === "undefined") {
        return DEFAULT_PANEL_WIDTH;
    }
    const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2);
    return clamp(DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, maxWidth);
}

function clampPanelWidth(width: number): number {
    const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2);
    return clamp(width, MIN_PANEL_WIDTH, maxWidth);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
