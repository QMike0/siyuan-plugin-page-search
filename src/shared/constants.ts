/** 勿加 `g` 标志，避免 `.test` 循环中 lastIndex 副作用 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;

export const ZERO_WIDTH_GLOBAL_RE = /[\u200B-\u200D\uFEFF]/g;

/** 格式化 `当前/总数`，始终显示完整计数。 */
export function formatSearchCountLabel(resultIndex: number, resultCount: number): string {
    return `${resultIndex}/${resultCount}`;
}
