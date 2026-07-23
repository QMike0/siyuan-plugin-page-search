/**
 * 页内搜索面板相对思源全局弹层的层级。
 *
 * 思源 Dialog / Menu 通过 window.siyuan.zIndex 递增（通常 200+）。
 * 面板拖拽后若写死 9999，会压过原生搜索等对话框；齿轮菜单再 +1 更糟。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/dialog/index.ts
 */

/** 与 index.scss `.search-dialog` 默认一致；高于编辑区局部层，低于思源 Dialog */
export const PAGE_SEARCH_PANEL_Z_INDEX = 8;

/** 当前打开的 `.b3-dialog--open` 中最高 z-index；无则 null */
export function getHighestOpenDialogZIndex(): number | null {
    let highest: number | null = null;
    document.querySelectorAll<HTMLElement>(".b3-dialog--open").forEach((root) => {
        const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>(".b3-dialog"))];
        for (const el of candidates) {
            const raw = el.style.zIndex || getComputedStyle(el).zIndex;
            const z = Number.parseInt(raw, 10);
            if (!Number.isFinite(z) || z <= 0) {
                continue;
            }
            if (highest == null || z > highest) {
                highest = z;
            }
        }
    });
    return highest;
}

/**
 * 固定定位搜索窗应使用的 z-index：始终低于已打开的思源 Dialog。
 * 无 Dialog 时用 PAGE_SEARCH_PANEL_Z_INDEX。
 */
export function resolveFixedPanelZIndex(): number {
    const dialogZ = getHighestOpenDialogZIndex();
    if (dialogZ != null && dialogZ > 1) {
        return Math.max(1, dialogZ - 1);
    }
    return PAGE_SEARCH_PANEL_Z_INDEX;
}

/**
 * 齿轮菜单：至少高于搜索窗，但不强行盖过思源已为 Menu 分配的层级。
 * （旧逻辑在面板 9999 时把菜单抬到 10000，会压住原生搜索。）
 */
export function resolveSettingsMenuZIndex(panelElement: HTMLElement, menuElement: HTMLElement): number {
    const panelZ = Number.parseInt(getComputedStyle(panelElement).zIndex || "0", 10);
    const menuAssigned = Number.parseInt(menuElement.style.zIndex || "0", 10);
    const floor = Number.isFinite(panelZ) && panelZ > 0 ? panelZ + 1 : PAGE_SEARCH_PANEL_Z_INDEX + 1;
    const assigned = Number.isFinite(menuAssigned) && menuAssigned > 0 ? menuAssigned : 0;
    let z = Math.max(floor, assigned);

    const dialogZ = getHighestOpenDialogZIndex();
    if (dialogZ != null && dialogZ > 1) {
        z = Math.min(z, dialogZ - 1);
    }
    return Math.max(1, z);
}

/** 是否存在已打开的思源 Dialog（含全局搜索） */
export function hasOpenSiyuanDialog(): boolean {
    return Boolean(document.querySelector(".b3-dialog--open"));
}
