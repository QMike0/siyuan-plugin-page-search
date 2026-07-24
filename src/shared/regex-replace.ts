/**
 * 正则替换模板展开（对齐 JS String.replace / 思源 $1 风格）。
 * 在 haystack 的 [start, end) 处重新 exec，以保留 lookaround 与捕获组。
 */

export interface ExpandRegexReplacementOptions {
    haystack: string;
    start: number;
    end: number;
    /** 与查找时相同的正则源（不含 flags） */
    patternSource: string;
    caseSensitive?: boolean;
    /** 替换模板：支持 $$ $& $` $' $n $<name> */
    template: string;
}

/**
 * 将替换模板按「正则查找」语义展开。
 * @returns 展开后的文本；无法在偏移处还原捕获组时返回 null（调用方应跳过该命中）。
 */
export function expandRegexReplacement(options: ExpandRegexReplacementOptions): string | null {
    const haystack = options.haystack;
    const start = options.start;
    const end = options.end;
    const template = options.template;
    const patternSource = options.patternSource;
    const caseSensitive = options.caseSensitive === true;

    if (
        !patternSource
        || start < 0
        || end < start
        || end > haystack.length
    ) {
        return null;
    }

    const matchedSlice = haystack.slice(start, end);
    const match = execRegexAt(haystack, start, end, patternSource, caseSensitive)
        ?? execRegexOnSlice(matchedSlice, patternSource, caseSensitive);

    if (!match) {
        return null;
    }

    const before = typeof match.index === "number"
        ? haystack.slice(0, match.index)
        : haystack.slice(0, start);
    const after = typeof match.index === "number"
        ? haystack.slice(match.index + match[0].length)
        : haystack.slice(end);

    return expandReplacementTemplate(template, match, match[0], before, after);
}

function execRegexAt(
    haystack: string,
    start: number,
    end: number,
    patternSource: string,
    caseSensitive: boolean,
): RegExpExecArray | null {
    let re: RegExp;
    try {
        re = new RegExp(patternSource, caseSensitive ? "g" : "gi");
    } catch {
        return null;
    }
    re.lastIndex = start;
    const match = re.exec(haystack);
    if (!match || match.index !== start) {
        return null;
    }
    if (match.index + match[0].length !== end || match[0] !== haystack.slice(start, end)) {
        return null;
    }
    return match;
}

function execRegexOnSlice(
    matchedSlice: string,
    patternSource: string,
    caseSensitive: boolean,
): RegExpExecArray | null {
    let re: RegExp;
    try {
        // 锚定整段命中，避免局部二次匹配跑偏
        re = new RegExp(`^(?:${patternSource})$`, caseSensitive ? "" : "i");
    } catch {
        return null;
    }
    return re.exec(matchedSlice);
}

/**
 * 展开 $$ / $& / $` / $' / $n / $<name>（对齐 JS String.replace 替换串语义）。
 * 不存在的 $n / $<name> 保留字面量；已参与但未匹配的捕获组展开为空串。
 */
export function expandReplacementTemplate(
    template: string,
    match: RegExpExecArray | RegExpMatchArray,
    matchedText: string,
    before: string,
    after: string,
): string {
    return template.replace(
        /\$\$|\$&|\$`|\$'|\$<([^>]+)>|\$(\d{1,3})/g,
        (token, named?: string, digits?: string) => {
            if (token === "$$") {
                return "$";
            }
            if (token === "$&") {
                return matchedText;
            }
            if (token === "$`") {
                return before;
            }
            if (token === "$'") {
                return after;
            }
            // 以 token 形态分流，避免未参与的备选捕获组在部分引擎里不是 undefined
            if (token.startsWith("$<") && token.endsWith(">")) {
                const name = named ?? token.slice(2, -1);
                const groups = (match as RegExpExecArray).groups;
                if (!groups || !Object.prototype.hasOwnProperty.call(groups, name)) {
                    return token;
                }
                return groups[name] ?? "";
            }
            if (digits !== undefined) {
                const index = Number(digits);
                // JS：$0 不是特殊替换；仅 $1…$99，且仅当该编号捕获组存在时展开
                if (index < 1 || index > 99) {
                    return token;
                }
                if (index >= match.length) {
                    return token;
                }
                return match[index] ?? "";
            }
            return token;
        },
    );
}
