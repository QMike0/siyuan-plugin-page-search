/** 插件保护限额，不是思源内核上限。文本按 UTF-16 两字节保守计量；对象开销另限条数。 */
export const REGEX_MAX_TEXT_BYTES = 64 * 1024 * 1024;
export const REGEX_MAX_RESULTS = 250_000;
export const REGEX_BUDGET_ERROR = "正则处理的数据量过大，请缩小搜索范围或减少匹配及替换输出。";

export interface RegexBudget {
    remainingResults: number;
    remainingBytes: number;
}

export function createRegexBudget(): RegexBudget {
    return {remainingResults: REGEX_MAX_RESULTS, remainingBytes: REGEX_MAX_TEXT_BYTES};
}

export class RegexBudgetExceeded extends Error {
    constructor() {
        super(REGEX_BUDGET_ERROR);
    }
}

export function consumeRegexBudget(budget: RegexBudget, characters: number, results = 0): void {
    const bytes = characters * 2;
    if (results > budget.remainingResults || bytes > budget.remainingBytes) {
        throw new RegexBudgetExceeded();
    }
    budget.remainingResults -= results;
    budget.remainingBytes -= bytes;
}
