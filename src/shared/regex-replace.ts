/**
 * 正则替换模板展开（对齐 JS String.replace / 思源 $1 风格）。
 * 在 haystack 的 [start, end) 处重新 exec，以保留 lookaround 与捕获组。
 */

import {regexSearchFlags} from "./match-text";
import type {MatchOptions} from "./types";

export interface ExpandRegexReplacementOptions
    extends Pick<MatchOptions, "regexUnicode" | "regexMultiline" | "regexDotAll">
{
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
    options: Pick<ExpandRegexReplacementOptions, "caseSensitive" | "regexUnicode" | "regexMultiline" | "regexDotAll">,
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
                    regexUnicode: options.regexUnicode === true,
                    regexMultiline: options.regexMultiline === true,
                    regexDotAll: options.regexDotAll === true,
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
    // haystack、同一偏移处完整复现该命中；否则 lookaround、^/$（特别是 m）等
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
                regexUnicode: options.regexUnicode,
                regexMultiline: options.regexMultiline,
                regexDotAll: options.regexDotAll,
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
