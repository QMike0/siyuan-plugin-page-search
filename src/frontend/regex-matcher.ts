import {
    createTextUnitsMatchIterator,
    matchTextUnitsDetailed,
} from "../shared/match-text";
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
const REGEX_WORKER_STARTUP_BUDGET_MS = 10000;
const REGEX_TIMEOUT_ERROR = "正则执行超时，请简化表达式";
const REGEX_WORKER_STARTUP_TIMEOUT_ERROR = "正则 Worker 加载超时，请稍后重试";
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
    timer: number | null;
    /** 就绪前保留请求；发出后立即释放，避免复用 Worker 时仍持有上一轮全文。 */
    message: Record<string, unknown> | null;
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
    private workerReady = false;
    private matchGeneration = 0;

    async match(
        units: SearchableUnit[],
        query: string,
        options: MatchTextUnitsOptions,
        signal?: AbortSignal,
    ): Promise<AsyncMatchTextUnitsResult> {
        const generation = ++this.matchGeneration;
        const cancelled = () => signal?.aborted || generation !== this.matchGeneration;
        if (cancelled()) return {hits: [], error: "", cancelled: true};
        if (!options.regex) {
            this.cancelPending();
            let chars = 0;
            for (const unit of units) chars += unit.text.length;
            if (chars < 64 * 1024 && units.length < 2000) {
                const result = matchTextUnitsDetailed(units, query, options);
                return cancelled() ? {hits: [], error: "", cancelled: true} : result;
            }
            // 大字面量仍留在主线程分片执行；Worker 只服务正则，避免普通查询受 Worker
            // 启动/序列化/超时策略影响，同时保留完全相同的匹配语义。
            const iterator = createTextUnitsMatchIterator(query, options)(units);
            let started = performance.now();
            let checkpoints = 0;
            while (true) {
                if (cancelled()) return {hits: [], error: "", cancelled: true};
                const step = iterator.next();
                if (step.done) return step.value;
                if ((++checkpoints & 255) === 0 || performance.now() - started >= 8) {
                    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                    started = performance.now();
                }
            }
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
        options: Pick<MatchTextUnitsOptions, "caseSensitive">,
        signal?: AbortSignal,
    ): Promise<AsyncRegexReplacementResult> {
        this.matchGeneration += 1;
        if (signal?.aborted) {
            return {expansions: [], error: "", cancelled: true};
        }
        return this.executeExpand(units, patternSource, template, options, signal);
    }

    dispose() {
        this.matchGeneration += 1;
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
        options: Pick<MatchTextUnitsOptions, "caseSensitive">,
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
                timer: null,
                message: {id, kind, ...payload},
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
            if (this.workerReady) {
                this.startPendingExecution(pending);
            } else {
                // Worker 的下载/初始化不占正则回溯预算；加载也有上限，不能无限闪烁。
                pending.timer = window.setTimeout(() => {
                    if (this.pending !== pending) return;
                    this.finishPending(
                        kind === "match" ?
                            {hits: [], error: REGEX_WORKER_STARTUP_TIMEOUT_ERROR} :
                            {expansions: [], error: REGEX_WORKER_STARTUP_TIMEOUT_ERROR},
                    );
                    this.terminateWorker();
                }, REGEX_WORKER_STARTUP_BUDGET_MS);
            }
        });
    }

    private startPendingExecution(pending: PendingRequest) {
        const worker = this.worker;
        if (this.pending !== pending || !worker || !this.workerReady || !pending.message) return;
        if (pending.timer !== null) window.clearTimeout(pending.timer);
        pending.timer = window.setTimeout(() => {
            if (this.pending !== pending) return;
            this.finishPending(regexTimeoutResult(pending.kind));
            this.terminateWorker();
        }, REGEX_EXECUTION_BUDGET_MS);
        const message = pending.message;
        pending.message = null;
        try {
            worker.postMessage(message);
        } catch (error) {
            this.finishPending(
                pending.kind === "match" ?
                    {hits: [], error: error instanceof Error ? error.message : "正则 Worker 无法启动"} :
                    {expansions: [], error: error instanceof Error ? error.message : "正则 Worker 无法启动"},
            );
            this.terminateWorker();
        }
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
            this.workerReady = false;
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
            kind?: WorkerTaskKind | "ready";
            result?: MatchTextUnitsResult | RegexReplacementExpansion[];
        }>,
    ) => {
        if (!this.worker || event.currentTarget !== this.worker) return;
        if (event.data?.kind === "ready") {
            if (this.workerReady) return;
            this.workerReady = true;
            if (this.pending) this.startPendingExecution(this.pending);
            return;
        }
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

    private readonly onWorkerError = (event: ErrorEvent) => {
        if (!this.worker || event.currentTarget !== this.worker) return;
        console.warn("[page-search] regex worker failed", {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
        });
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
        if (pending.timer !== null) window.clearTimeout(pending.timer);
        pending.message = null;
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
        this.workerReady = false;
    }
}
