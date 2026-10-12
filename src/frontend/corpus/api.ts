import {fetchSyncPost} from "siyuan";

const PAGE_SIZE = 5000;

export function escSql(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 思源当前宿主的 fetchSyncPost 已支持第五个 AbortSignal 参数；插件 SDK 的旧声明仍
 * 只有两个参数。集中在这里兼容调用，未传 signal 时保持旧版本完全相同的调用方式。
 */
function postWithSignal(url: string, body: Record<string, unknown>, signal?: AbortSignal) {
    if (!signal) {
        return fetchSyncPost(url, body);
    }
    const post = fetchSyncPost as unknown as (
        url: string,
        data?: Record<string, unknown>,
        headers?: Record<string, string>,
        process?: boolean,
        abortSignal?: AbortSignal,
    ) => ReturnType<typeof fetchSyncPost>;
    return post(url, body, undefined, undefined, signal);
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

export async function postJson<T>(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) {
        return null;
    }
    try {
        const response = await postWithSignal(url, body, signal);
        if (!response || response.code !== 0) {
            return null;
        }
        return response.data as T;
    } catch {
        return null;
    }
}
