/**
 * 思源行内元素使用的不可见边界字符。
 * v3.8.6 的 code / kbd / tag 同时使用 U+200B 与 U+2060；保留历史上已兼容的
 * U+200C/U+200D/U+FEFF。勿加 `g` 标志，避免 `.test` 循环中 lastIndex 副作用。
 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;

export const ZERO_WIDTH_GLOBAL_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * 解析实际用于匹配的查询文本。
 *
 * 普通查询保持历史行为：忽略首尾空白；查询本身只有空白时则保留原值，
 * 以便精确查找空格、Tab、全角空格等字符。只含思源行内边界标记的输入
 * 没有用户可见含义，仍按空查询处理。
 */
export function effectiveSearchQuery(value: string): string {
    if (!value || value.replace(ZERO_WIDTH_GLOBAL_RE, "").length === 0) {
        return "";
    }

    const trimmed = value.trim();
    if (trimmed.replace(ZERO_WIDTH_GLOBAL_RE, "").length > 0) {
        return trimmed;
    }

    return value;
}

/** 格式化 `当前/总数`，始终显示完整计数。 */
export function formatSearchCountLabel(resultIndex: number, resultCount: number): string {
    return `${resultIndex}/${resultCount}`;
}
