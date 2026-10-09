import {matchTextUnitsDetailed} from "../shared/match-text";
import {expandRegexReplacementUnits} from "../shared/regex-replace";
import type {RegexReplacementUnitRequest} from "../shared/regex-replace";
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
    options: Pick<MatchTextUnitsOptions, "caseSensitive" | "regexUnicode" | "regexMultiline" | "regexDotAll">;
}

type RegexWorkerRequest = RegexMatchWorkerRequest | RegexExpandWorkerRequest;

/**
 * Worker 只处理可克隆的纯文本单元和偏移，不能也不应访问 Protyle DOM / Range。
 * 终止 Worker 是 JavaScript 中可中断灾难性回溯的可靠边界。
 */
self.addEventListener("message", (event: MessageEvent<RegexWorkerRequest>) => {
    const request = event.data;
    if (request.kind === "match") {
        const result = matchTextUnitsDetailed(request.units, request.query, request.options);
        self.postMessage({id: request.id, kind: request.kind, result});
        return;
    }
    const result = expandRegexReplacementUnits(
        request.units,
        request.patternSource,
        request.template,
        request.options,
    );
    self.postMessage({id: request.id, kind: request.kind, result});
});
