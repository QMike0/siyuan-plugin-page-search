import {fetchSyncPost} from "siyuan";

const PAGE_SIZE = 5000;

export function escSql(value: string): string {
    return value.replace(/'/g, "''");
}

export async function querySql<T>(stmt: string): Promise<T[] | null> {
    try {
        const response = await fetchSyncPost("/api/query/sql", {stmt, mode: "readonly"});
        if (!response || response.code !== 0 || !Array.isArray(response.data)) {
            return null;
        }
        return response.data as T[];
    } catch {
        return null;
    }
}

/** 自带 LIMIT，并按 id 翻页，避免内核默认条数把结果截断。 */
export async function querySqlAll<T extends {id?: string}>(
    buildStmt: (afterId: string, limit: number) => string,
): Promise<T[] | null> {
    const rows: T[] = [];
    let afterId = "";
    for (;;) {
        const batch = await querySql<T>(buildStmt(afterId, PAGE_SIZE));
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

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T | null> {
    try {
        const response = await fetchSyncPost(url, body);
        if (!response || response.code !== 0) {
            return null;
        }
        return response.data as T;
    } catch {
        return null;
    }
}
