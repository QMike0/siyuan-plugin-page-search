/**
 * 行内备注 data-inline-memo-content 的纯文本视图。
 * 属性偶发含已消毒 HTML 时，匹配/替换坐标系用剥标签后的纯文本（与 DOM 采集一致）。
 */
export function plainTextFromInlineMemoContent(raw: string): string {
    const value = raw ?? "";
    if (!value) {
        return "";
    }
    if (!/<[a-zA-Z!/?]/.test(value)) {
        return value;
    }
    return value.replace(/<[^>]*>/g, "");
}

/**
 * 写回前尽量对齐思源编辑浮层：有 DOMPurify 时消毒，否则原样写入
 *（setAttribute + outerHTML 序列化本身已做属性转义）。
 */
export function sanitizeInlineMemoContentForWrite(text: string): string {
    const purify = typeof globalThis !== "undefined"
        ? (globalThis as {DOMPurify?: {sanitize?: (input: string) => string}}).DOMPurify
        : undefined;
    if (purify && typeof purify.sanitize === "function") {
        try {
            return purify.sanitize(text);
        } catch {
            return text;
        }
    }
    return text;
}
