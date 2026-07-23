/** 勿加 `g` 标志，避免 `.test` 循环中 lastIndex 副作用 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;

export const ZERO_WIDTH_GLOBAL_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * 查找结果计数展示软上限。
 * 仍全量高亮与导航；总数超过时显示为 `N+`。
 * 取 999：贴近常见「999+」心智，且 Electron/CSS Highlight 在该量级下通常可接受。
 */
export const SEARCH_COUNT_SOFT_CAP = 999;

/** 格式化 `当前/总数`；总数超过软上限时显示 `N+` */
export function formatSearchCountLabel(
    resultIndex: number,
    resultCount: number,
    softCap: number = SEARCH_COUNT_SOFT_CAP,
): string {
    if (resultCount > softCap) {
        return `${resultIndex}/${softCap}+`;
    }
    return `${resultIndex}/${resultCount}`;
}
