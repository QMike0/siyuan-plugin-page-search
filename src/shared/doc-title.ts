/** 与思源 Constants.SIZE_TITLE 一致 */
export const DOC_TITLE_MAX_LENGTH = 512;

/**
 * 对齐思源前端 replaceFileName：去掉换行/制表，`/` → `／`，截断长度。
 * 允许返回空串（文档空标题由内核再规范化并打 titleEmpty 标记）。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/editor/rename.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/header/Title.ts Title.rename
 */
export function sanitizeDocTitle(name: string): string {
    let next = name;
    if (next.includes("/")) {
        next = next.replace(/\//g, "／");
    }
    return next
        .replace(/\r\n|\r|\n|\u2028|\u2029|\t/g, "")
        .substring(0, DOC_TITLE_MAX_LENGTH);
}

/**
 * 对齐思源 validateName：禁止换行/制表，长度 ≤ SIZE_TITLE。
 * 空串视为合法（与 Title.rename 把空 title 交给 renameDoc 一致）。
 */
export function isValidDocTitle(name: string): boolean {
    if (/\r\n|\r|\n|\u2028|\u2029|\t/.test(name)) {
        return false;
    }
    return name.length <= DOC_TITLE_MAX_LENGTH;
}
