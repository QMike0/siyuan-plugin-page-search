import {matchTextUnitsDetailed} from "../shared/match-text";
import {expandRegexReplacementUnits} from "../shared/regex-replace";
import type {RegexReplacementUnitRequest} from "../shared/regex-replace";
import {createRegexBudget, RegexBudgetExceeded, type RegexBudget} from "../shared/regex-budget";
import type {
    MatchTextUnitsOptions,
    SearchableUnit,
} from "../shared/types";

interface RegexMatchWorkerRequest {
    id: number;
    kind: "match";
    units: SearchableUnit[];
    query: string;
    options: MatchTextUnitsOptions;
}

interface RegexExpandWorkerRequest {
    id: number;
    kind: "expand";
    units: RegexReplacementUnitRequest[];
    patternSource: string;
    template: string;
    options: Pick<MatchTextUnitsOptions, "caseSensitive">;
    budget: RegexBudget;
}

type RegexWorkerRequest = RegexMatchWorkerRequest | RegexExpandWorkerRequest;

/**
 * Worker 只处理可克隆的纯文本单元和偏移，不能也不应访问 Protyle DOM / Range。
 * 终止 Worker 是 JavaScript 中可中断灾难性回溯的可靠边界。
 */
self.addEventListener("message", (event: MessageEvent<RegexWorkerRequest>) => {
    const request = event.data;
    try {
        if (request.kind === "match") {
            const result = matchTextUnitsDetailed(request.units, request.query, request.options, createRegexBudget());
            self.postMessage({id: request.id, kind: request.kind, result});
            return;
        }
        const result = expandRegexReplacementUnits(
            request.units,
            request.patternSource,
            request.template,
            request.options,
            request.budget,
        );
        // 原文已留在主线程；字符串在本地共享引用并不能消除 postMessage 的重复序列化。
        self.postMessage({
            id: request.id,
            kind: request.kind,
            result: result.map(({id, replacement}) => ({id, replacement})),
        });
    } catch (error) {
        if (!(error instanceof RegexBudgetExceeded)) throw error;
        self.postMessage({
            id: request.id,
            kind: request.kind,
            result: request.kind === "match" ? {hits: [], error: error.message} : [],
            error: error.message,
        });
    }
});

// 监听器安装后通知主线程，下载/初始化耗时不占匹配和替换的执行预算。
self.postMessage({kind: "ready"});
