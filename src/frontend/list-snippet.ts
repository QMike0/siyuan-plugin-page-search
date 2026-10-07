/** 命中两侧保留的上下文字数。列表行只存这一小段，不保留整块文本。 */
const LIST_SNIPPET_RADIUS = 24;
/** 单条命中本身最多带入列表的字数，避免超长匹配占内存。 */
const LIST_SNIPPET_MATCH_CAP = 48;

export interface ListSnippet {
    listText: string;
    listMark?: {start: number; end: number};
}

/**
 * 从已经拿到的单元文本切一行摘要。
 * 不写入 SearchMatch.snippet：那个字段会在跳转时弹出提示。
 */
export function buildListSnippet(content: string, start: number, end: number, fallback = ""): ListSnippet {
    const made = sliceListSnippet(content ?? "", start, end);
    if (made.text) {
        if (made.markEnd > made.markStart) {
            return {
                listText: made.text,
                listMark: {start: made.markStart, end: made.markEnd},
            };
        }
        return {listText: made.text};
    }
    const plain = collapseWs(fallback).text.trim();
    if (!plain) {
        return {listText: ""};
    }
    const visible = plain.length > LIST_SNIPPET_MATCH_CAP
        ? `${plain.slice(0, LIST_SNIPPET_MATCH_CAP)}…`
        : plain;
    return {
        listText: visible,
        listMark: {start: 0, end: Math.min(LIST_SNIPPET_MATCH_CAP, plain.length)},
    };
}

function isListSpace(char: string): boolean {
    return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\v";
}

function collapseWs(raw: string): {text: string; map: number[]} {
    const map = new Array<number>(raw.length + 1);
    let text = "";
    let lastWasSpace = false;
    for (let index = 0; index < raw.length; index++) {
        map[index] = text.length;
        const char = raw[index];
        if (isListSpace(char)) {
            if (!lastWasSpace && text.length > 0) {
                text += " ";
                lastWasSpace = true;
            }
            continue;
        }
        text += char;
        lastWasSpace = false;
    }
    map[raw.length] = text.length;
    return {text, map};
}

function sliceListSnippet(content: string, start: number, end: number): {text: string; markStart: number; markEnd: number} {
    const length = content.length;
    const safeStart = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, length));
    const safeEnd = Math.max(safeStart, Math.min(Number.isFinite(end) ? end : safeStart, length));
    const shownEnd = Math.min(safeEnd, safeStart + LIST_SNIPPET_MATCH_CAP);
    const sliceStart = Math.max(0, safeStart - LIST_SNIPPET_RADIUS);
    const sliceEnd = Math.min(length, shownEnd + LIST_SNIPPET_RADIUS);
    const raw = content.slice(sliceStart, sliceEnd);
    const localStart = safeStart - sliceStart;
    const localEnd = shownEnd - sliceStart;
    const collapsed = collapseWs(raw);
    let trimStart = 0;
    let trimmedEnd = collapsed.text.length;
    while (trimStart < trimmedEnd && collapsed.text[trimStart] === " ") {
        trimStart += 1;
    }
    while (trimmedEnd > trimStart && collapsed.text[trimmedEnd - 1] === " ") {
        trimmedEnd -= 1;
    }
    let text = collapsed.text.slice(trimStart, trimmedEnd);
    let markStart = (collapsed.map[localStart] ?? 0) - trimStart;
    let markEnd = (collapsed.map[localEnd] ?? trimStart) - trimStart;
    markStart = Math.max(0, Math.min(markStart, text.length));
    markEnd = Math.max(markStart, Math.min(markEnd, text.length));
    if (sliceStart > 0 && text.length > 0) {
        text = `…${text}`;
        markStart += 1;
        markEnd += 1;
    }
    if (text.length > 0 && (sliceEnd < length || shownEnd < safeEnd)) {
        text = `${text}…`;
    }
    return {text, markStart, markEnd};
}
