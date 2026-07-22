/** 零宽字符（与 Protyle 文档中的 ZWSP 等一致） */
export const ZERO_WIDTH_CHARS = "\u200B\u200C\u200D\uFEFF";

/** 勿加 `g` 标志，避免 `.test` 循环中 lastIndex 副作用 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;

export const ZERO_WIDTH_GLOBAL_RE = /[\u200B-\u200D\uFEFF]/g;
