/**
 * 思源行内元素使用的不可见边界字符。
 * v3.8.6 的 code / kbd / tag 同时使用 U+200B 与 U+2060；保留历史上已兼容的
 * U+200C/U+200D/U+FEFF。勿加 `g` 标志，避免 `.test` 循环中 lastIndex 副作用。
 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;

export const ZERO_WIDTH_GLOBAL_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** 格式化 `当前/总数`，始终显示完整计数。 */
export function formatSearchCountLabel(resultIndex: number, resultCount: number): string {
    return `${resultIndex}/${resultCount}`;
}
