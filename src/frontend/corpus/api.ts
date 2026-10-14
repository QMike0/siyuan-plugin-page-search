import {fetchSyncPost} from "siyuan";

const PAGE_SIZE = 5000;

export function escSql(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 思源当前宿主的 fetchSyncPost 已支持第五个 AbortSignal 参数；插件 SDK 的旧声明仍
 * 只有两个参数。集中兼容 signal 和 process；普通调用保持旧版的两个参数。
 */
function postWithSignal(url: string, body: Record<string, unknown>, signal?: AbortSignal, process = true) {
    if (!signal && process) {
        return fetchSyncPost(url, body);
    }
    const post = fetchSyncPost as unknown as (
        url: string,
        data?: Record<string, unknown>,
        headers?: Record<string, string>,
        process?: boolean,
        abortSignal?: AbortSignal,
    ) => ReturnType<typeof fetchSyncPost>;
    return post(url, body, undefined, process, signal);
}

export async function querySql<T>(stmt: string, signal?: AbortSignal): Promise<T[] | null> {
    if (signal?.aborted) {
        return null;
    }
    try {
        const response = await postWithSignal("/api/query/sql", {stmt, mode: "readonly"}, signal);
        if (!response || response.code !== 0 || !Array.isArray(response.data)) {
            return null;
        }
        return response.data as T[];
    } catch {
        return null;
    }
}

/** 自带 LIMIT，并按 id 翻页，避免内核默认条数把结果截断。 */
export async function querySqlAll<T extends {id?: string;}>(
    buildStmt: (afterId: string, limit: number) => string,
    signal?: AbortSignal,
): Promise<T[] | null> {
    const rows: T[] = [];
    let afterId = "";
    for (;;) {
        if (signal?.aborted) {
            return null;
        }
        const batch = await querySql<T>(buildStmt(afterId, PAGE_SIZE), signal);
        if (!batch) {
            return null;
        }
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) {
            return rows;
        }
        const last = batch[batch.length - 1]?.id;
        if (!last || last === afterId) {
            return rows;
        }
        afterId = last;
    }
}

export async function postJson<T>(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    process = true,
): Promise<T | null> {
    if (signal?.aborted) {
        return null;
    }
    try {
        const response = await postWithSignal(url, body, signal, process);
        if (!response || response.code !== 0) {
            return null;
        }
        return response.data as T;
    } catch {
        return null;
    }
}

/** Reconcile stale SQL IDs against the kernel tree; never infer deletion from viewport DOM. */
export async function fetchSearchBlockDoms(
    ids: string[],
    notebookId = "",
    signal?: AbortSignal,
    shouldContinue: () => boolean = () => true,
): Promise<{doms: Record<string, string>; absentIds: string[];} | null> {
    if (!shouldContinue() || signal?.aborted) return null;
    const body = notebookId ? {ids, notebook: notebookId} : {ids};
    const path = "/api/block/getBlockDOMs";
    // Search owns these errors. The default processMessage would show
    // "block not found" before we can reconcile a normal deletion.
    let doms = await postJson<Record<string, string>>(path, body, signal, false);
    const absent = new Set<string>();
    const confirmAbsent = async (missing: string[]) => {
        if (!missing.length || !shouldContinue() || signal?.aborted) return;
        const exists = await postJson<Record<string, boolean>>(
            "/api/block/checkBlocksExist",
            {...body, ids: missing},
            signal,
            false,
        );
        // Omitted IDs, unsupported APIs and permission/network failures are
        // not evidence of deletion. Only explicit kernel false is accepted.
        for (const id of missing) {
            if (exists?.[id] === false) absent.add(id);
        }
    };
    if (!doms || typeof doms !== "object") {
        await confirmAbsent(ids);
        if (!shouldContinue() || signal?.aborted || !absent.size) return null;
        const remaining = ids.filter((id) => !absent.has(id));
        // One deleted ID can reject a mixed batch. Read its surviving siblings
        // once; genuine read failures still propagate for the remaining IDs.
        doms = remaining.length ?
            await postJson<Record<string, string>>(path, {...body, ids: remaining}, signal, false) :
            {};
        doms ??= {};
    }
    if (!shouldContinue() || signal?.aborted) return null;
    await confirmAbsent(ids.filter((id) => !absent.has(id) && !doms[id]));
    if (!shouldContinue() || signal?.aborted) return null;
    return {doms, absentIds: Array.from(absent)};
}
