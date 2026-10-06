import {openMobileFileById, openTab} from "siyuan";
import type {App, TProtyleAction} from "siyuan";
import {editorRootId} from "./search";
import {isEditorZoomed} from "./focus";
import {isUnderNonHeadingCssFold, unfoldPathToBlock} from "../fold";

/** 展开后等块插回当前编辑器的上限；常见情况在前几帧就出现 */
const UNFOLD_APPEAR_TIMEOUT_MS = 1500;
/** openTab 未回调时放开等待，避免跳转状态一直占着 */
const OPEN_TAB_TIMEOUT_MS = 2500;

function isMobile(): boolean {
    const frontEnd = (window as unknown as {siyuan?: {mobile?: boolean}}).siyuan;
    return Boolean(frontEnd?.mobile);
}

function blockInEditor(editor: ParentNode, blockId: string): HTMLElement | null {
    const node = editor.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    if (!node || node.closest("[data-page-search-offscreen]")) {
        return null;
    }
    if (isUnderNonHeadingCssFold(node)) {
        return null;
    }
    return node;
}

function waitForUnfoldedBlock(editor: ParentNode, blockId: string, timeoutMs: number): Promise<boolean> {
    if (blockInEditor(editor, blockId)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (blockInEditor(editor, blockId)) {
                resolve(true);
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                resolve(false);
                return;
            }
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
    });
}

function openTabToBlock(app: App, blockId: string): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) {
                return;
            }
            settled = true;
            resolve();
        };
        const action: TProtyleAction[] = ["cb-get-focus", "cb-get-context", "cb-get-rootscroll"];
        if (isMobile()) {
            openMobileFileById(app, blockId, action);
            window.setTimeout(done, 300);
            return;
        }
        void openTab({
            app,
            doc: {
                id: blockId,
                action,
                zoomIn: false,
            },
            removeCurrentTab: false,
            afterOpen: done,
        });
        window.setTimeout(done, OPEN_TAB_TIMEOUT_MS);
    });
}

/**
 * 先展开挡住该块的折叠标题或容器。块已经回到当前编辑器后就地定位，不再 openTab。
 * 只是窗口外未加载时才打开块，且不进入聚焦。当前已在聚焦中时也不退出聚焦。
 */
export function openBlockInEditor(
    app: App,
    blockId: string,
    afterOpen?: () => void,
    editor?: ParentNode,
): void {
    const root = editor ?? document;
    const finish = () => {
        afterOpen?.();
    };
    const rootId = root instanceof Element ? editorRootId(root) : "";
    const stayInZoom = root instanceof Element && isEditorZoomed(root);
    const openOrStay = () => {
        if (stayInZoom) {
            finish();
            return;
        }
        return openTabToBlock(app, blockId).then(finish, finish);
    };
    void unfoldPathToBlock(blockId, root, rootId).then((unfolded) => {
        if (!unfolded) {
            if (blockInEditor(root, blockId)) {
                finish();
                return;
            }
            return openOrStay();
        }
        return waitForUnfoldedBlock(root, blockId, UNFOLD_APPEAR_TIMEOUT_MS).then((appeared) => {
            if (appeared || blockInEditor(root, blockId)) {
                finish();
                return;
            }
            return openOrStay();
        }, openOrStay);
    }, openOrStay);
}

export function blockIsInEditor(edit: Element, blockId: string): boolean {
    if (!blockId || blockId === "__doc-title__") {
        return true;
    }
    const node = edit.querySelector(`[data-node-id="${CSS.escape(blockId)}"]`);
    return Boolean(node && (node as HTMLElement).clientHeight > 0);
}
