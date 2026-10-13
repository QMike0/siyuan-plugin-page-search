/**
 * 正则替换模板展开（对齐 JS String.replace / 思源 $1 风格）。
 * 在 haystack 的 [start, end) 处重新 exec，以保留 lookaround 与捕获组。
 */

import {regexSearchFlags} from "./match-text";

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

/** 可结构化克隆的正则替换展开请求；由 Worker 执行，避免主线程 RegExp.exec 卡住界面。 */
export interface RegexReplacementUnitRequest {
    id: string;
    haystack: string;
    replacements: Array<{
        id: string;
        start: number;
        end: number;
        matchedText: string;
    }>;
}

export interface RegexReplacementExpansion {
    id: string;
    haystack: string;
    replacement: string | null;
}

/**
 * 一次处理一个文本单元中的全部命中。结果带回原始快照，主线程写回前可拒绝已漂移的内容。
 */
export function expandRegexReplacementUnits(
    units: RegexReplacementUnitRequest[],
    patternSource: string,
    template: string,
    options: Pick<ExpandRegexReplacementOptions, "caseSensitive">,
): RegexReplacementExpansion[] {
    const expansions: RegexReplacementExpansion[] = [];
    for (const unit of units) {
        for (const replacement of unit.replacements) {
            expansions.push({
                id: replacement.id,
                haystack: unit.haystack,
                replacement: expandRegexReplacement({
                    haystack: unit.haystack,
                    start: replacement.start,
                    end: replacement.end,
                    patternSource,
                    template,
                    caseSensitive: options.caseSensitive === true,
                }),
            });
        }
    }
    return expansions;
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
        !patternSource ||
        start < 0 ||
        end < start ||
        end > haystack.length
    ) {
        return null;
    }

    // 搜索阶段已经记录了原始 haystack 上的 UTF-16 偏移。替换时必须能在同一
    // haystack、同一偏移处完整复现该命中；否则 lookaround、^/$ 等
    // 上下文语义会在切片中改变，不能安全地展开 $` / $' 或捕获组。
    const match = execRegexAt(haystack, start, end, patternSource, options);

    if (!match) {
        return null;
    }

    const before = haystack.slice(0, start);
    const after = haystack.slice(end);

    return expandReplacementTemplate(template, match, match[0], before, after);
}

function execRegexAt(
    haystack: string,
    start: number,
    end: number,
    patternSource: string,
    options: ExpandRegexReplacementOptions,
): RegExpExecArray | null {
    let re: RegExp;
    try {
        re = new RegExp(
            patternSource,
            regexSearchFlags({
                regex: true,
                caseSensitive: options.caseSensitive,
            }),
        );
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

/**
 * 展开 $$ / $& / $` / $' / $n / $<name>（对齐 JS String.replace 替换串语义）。
 * $n 最多消费两位，编号不存在时回退一位；$0 保留字面量。
 * 无命名组时 $<name> 按普通文本扫描；有命名组时缺失/未匹配的组展开为空串。
 */
export function expandReplacementTemplate(
    template: string,
    match: RegExpExecArray | RegExpMatchArray,
    matchedText: string,
    before: string,
    after: string,
): string {
    const groups = (match as RegExpExecArray).groups;
    // 没有命名组时不能吞掉整个 $<...>，其中的 $1 等仍须正常展开。
    const tokens = groups ? /\$[$&`']|\$\d{1,2}|\$<[^>]*>/g : /\$[$&`']|\$\d{1,2}/g;
    return template.replace(tokens, (token) => {
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
        if (token.startsWith("$<")) {
            const name = token.slice(2, -1);
            return groups && Object.prototype.hasOwnProperty.call(groups, name) ? groups[name] ?? "" : "";
        }
        const digits = token.slice(1);
        const index = Number(digits);
        if (index > 0 && index < match.length) {
            return match[index] ?? "";
        }
        // 如只有一个捕获组，$12 = $1 + "2"；$100 = $1 + "00"。
        const first = Number(digits[0]);
        if (digits.length === 2 && first > 0 && first < match.length) {
            return (match[first] ?? "") + digits[1];
        }
        return token;
    });
}
