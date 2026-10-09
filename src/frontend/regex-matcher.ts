import {matchTextUnitsDetailed} from "../shared/match-text";
import type {
    RegexReplacementExpansion,
    RegexReplacementUnitRequest,
} from "../shared/regex-replace";
import type {
    MatchTextUnitsOptions,
    MatchTextUnitsResult,
    SearchableUnit,
} from "../shared/types";

const REGEX_EXECUTION_BUDGET_MS = 2500;
const REGEX_TIMEOUT_ERROR = "正则执行超时，请简化表达式";
const REGEX_WORKER_UNAVAILABLE_ERROR = "当前环境不支持正则 Worker；为避免界面卡住，未执行正则搜索";

export interface AsyncMatchTextUnitsResult extends MatchTextUnitsResult {
    /** 查询已被下一次搜索或 SearchBar 销毁作废，调用方不得更新界面。 */
    cancelled?: boolean;
}

export interface AsyncRegexReplacementResult {
    expansions: RegexReplacementExpansion[];
    error: string;
    cancelled?: boolean;
}

type WorkerTaskKind = "match" | "expand";
type WorkerTaskResult = AsyncMatchTextUnitsResult | AsyncRegexReplacementResult;

interface PendingRequest {
    id: number;
    kind: WorkerTaskKind;
    resolve: (result: WorkerTaskResult) => void;
    timer: number;
    signal?: AbortSignal;
    onAbort?: () => void;
}

const regexTimeoutResult = (kind: WorkerTaskKind): WorkerTaskResult =>
    kind === "match" ?
        {hits: [], error: REGEX_TIMEOUT_ERROR} :
        {expansions: [], error: REGEX_TIMEOUT_ERROR};

const regexCancelledResult = (kind: WorkerTaskKind): WorkerTaskResult =>
    kind === "match" ?
        {hits: [], error: "", cancelled: true} :
        {expansions: [], error: "", cancelled: true};

const regexWorkerUnavailableResult = (kind: WorkerTaskKind): WorkerTaskResult =>
    kind === "match" ?
        {hits: [], error: REGEX_WORKER_UNAVAILABLE_ERROR} :
        {expansions: [], error: REGEX_WORKER_UNAVAILABLE_ERROR};

/**
 * 每个 SearchBar 延迟创建一个 Worker，并只维持一个活动任务。
 * 输入变化会终止旧 Worker：这既中断运行中的回溯，也不会让过期任务阻塞新搜索。
 */
export class RegexTextMatcher {
    private worker: Worker | null = null;
    private pending: PendingRequest | null = null;
    private nextId = 1;
    private workerUnavailable = false;

    async match(
        units: SearchableUnit[],
        query: string,
        options: MatchTextUnitsOptions,
        signal?: AbortSignal,
    ): Promise<AsyncMatchTextUnitsResult> {
        if (!options.regex) {
            return matchTextUnitsDetailed(units, query, options);
        }
        if (signal?.aborted) {
            return {hits: [], error: "", cancelled: true};
        }
        return this.executeMatch(units, query, options, signal);
    }

    /**
     * 在同一 Worker 中准备正则替换模板。结果只含纯文本；DOM 和思源事务仍留在主线程。
     * 每个单元带回原始 haystack，写回前会据此拒绝已被用户改动的快照。
     */
    async expandReplacements(
        units: RegexReplacementUnitRequest[],
        patternSource: string,
        template: string,
        options: Pick<
            MatchTextUnitsOptions,
            "caseSensitive" | "regexUnicode" | "regexMultiline" | "regexDotAll"
        >,
        signal?: AbortSignal,
    ): Promise<AsyncRegexReplacementResult> {
        if (signal?.aborted) {
            return {expansions: [], error: "", cancelled: true};
        }
        return this.executeExpand(units, patternSource, template, options, signal);
    }

    dispose() {
        this.cancelPending();
        this.terminateWorker();
    }

    private async executeMatch(
        units: SearchableUnit[],
        query: string,
        options: MatchTextUnitsOptions,
        signal?: AbortSignal,
    ): Promise<AsyncMatchTextUnitsResult> {
        // 一个 SearchBar 的新查询总是覆盖旧查询；终止是唯一能中断 RegExp.exec 的方式。
        const result = await this.execute(
            "match",
            {units, query, options},
            signal,
        );
        return this.asMatchResult(result);
    }

    private async executeExpand(
        units: RegexReplacementUnitRequest[],
        patternSource: string,
        template: string,
        options: Pick<
            MatchTextUnitsOptions,
            "caseSensitive" | "regexUnicode" | "regexMultiline" | "regexDotAll"
        >,
        signal?: AbortSignal,
    ): Promise<AsyncRegexReplacementResult> {
        const result = await this.execute(
            "expand",
            {units, patternSource, template, options},
            signal,
        );
        return this.asExpandResult(result);
    }

    private execute(
        kind: WorkerTaskKind,
        payload: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<WorkerTaskResult> {
        // 新任务覆盖旧任务；terminate 是中断灾难性回溯的可靠边界。
        this.cancelPending();
        const worker = this.ensureWorker();
        if (!worker) {
            return Promise.resolve(regexWorkerUnavailableResult(kind));
        }
        return new Promise<WorkerTaskResult>((resolve) => {
            const id = this.nextId++;
            const pending: PendingRequest = {
                id,
                kind,
                resolve,
                timer: window.setTimeout(() => {
                    if (this.pending?.id !== id) {
                        return;
                    }
                    this.finishPending(regexTimeoutResult(kind));
                    this.terminateWorker();
                }, REGEX_EXECUTION_BUDGET_MS),
                signal,
            };
            if (signal) {
                pending.onAbort = () => {
                    if (this.pending?.id !== id) {
                        return;
                    }
                    this.finishPending(regexCancelledResult(kind));
                    this.terminateWorker();
                };
                signal.addEventListener("abort", pending.onAbort, {once: true});
            }
            this.pending = pending;
            try {
                worker.postMessage({id, kind, ...payload});
            } catch (error) {
                this.finishPending(
                    kind === "match" ?
                        {hits: [], error: error instanceof Error ? error.message : "正则 Worker 无法启动"} :
                        {expansions: [], error: error instanceof Error ? error.message : "正则 Worker 无法启动"},
                );
                this.terminateWorker();
            }
        });
    }

    private asMatchResult(result: WorkerTaskResult): AsyncMatchTextUnitsResult {
        return "hits" in result ? result : {hits: [], error: "正则 Worker 返回了无效结果"};
    }

    private asExpandResult(result: WorkerTaskResult): AsyncRegexReplacementResult {
        return "expansions" in result ? result : {expansions: [], error: "正则 Worker 返回了无效结果"};
    }

    private ensureWorker(): Worker | null {
        if (this.worker) {
            return this.worker;
        }
        if (this.workerUnavailable || typeof Worker !== "function") {
            return null;
        }
        try {
            // webpack 5 识别此固定形式并将 worker 作为插件 dist 资源打包。
            const worker = new Worker(
                new URL(
                    /* webpackChunkName: "page-search-regex-worker" */
                    "./regex-worker.ts",
                    import.meta.url,
                ),
            );
            worker.addEventListener("message", this.onWorkerMessage);
            worker.addEventListener("error", this.onWorkerError);
            this.worker = worker;
            return worker;
        } catch (error) {
            this.workerUnavailable = true;
            console.warn("[page-search] regex worker unavailable; regex search is disabled to protect the UI", error);
            return null;
        }
    }

    private readonly onWorkerMessage = (
        event: MessageEvent<{
            id?: number;
            kind?: WorkerTaskKind;
            result?: MatchTextUnitsResult | RegexReplacementExpansion[];
        }>,
    ) => {
        const pending = this.pending;
        if (!pending || event.data?.id !== pending.id || event.data?.kind !== pending.kind) {
            return;
        }
        const result = event.data.result;
        if (pending.kind === "match") {
            this.finishPending(
                result && !Array.isArray(result) && Array.isArray(result.hits) ?
                    result :
                    {hits: [], error: "正则 Worker 返回了无效结果"},
            );
            return;
        }
        this.finishPending(
            Array.isArray(result) ?
                {expansions: result, error: ""} :
                {expansions: [], error: "正则 Worker 返回了无效结果"},
        );
    };

    private readonly onWorkerError = () => {
        if (this.pending) {
            this.finishPending(
                this.pending.kind === "match" ?
                    {hits: [], error: "正则 Worker 执行失败"} :
                    {expansions: [], error: "正则 Worker 执行失败"},
            );
        }
        this.terminateWorker();
    };

    private cancelPending() {
        if (!this.pending) {
            return;
        }
        this.finishPending(regexCancelledResult(this.pending.kind));
        this.terminateWorker();
    }

    private finishPending(result: WorkerTaskResult) {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.pending = null;
        window.clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
        pending.resolve(result);
    }

    private terminateWorker() {
        if (!this.worker) {
            return;
        }
        this.worker.removeEventListener("message", this.onWorkerMessage);
        this.worker.removeEventListener("error", this.onWorkerError);
        this.worker.terminate();
        this.worker = null;
    }
}
