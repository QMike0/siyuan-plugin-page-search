import {postJson} from "./api";

const orderCache = new Map<string, {signature: string; ids: string[]}>();

/** 只读已有文档序，不发起 getDocBlocksOrders。 */
export function peekDocOrder(rootId: string): string[] | null {
    const cached = orderCache.get(rootId);
    return cached?.ids ?? null;
}

export function invalidateDocOrder(rootId?: string): void {
    if (rootId) {
        orderCache.delete(rootId);
        return;
    }
    orderCache.clear();
}

export async function fetchDocBlocksOrders(rootId: string, signature: string): Promise<string[] | null> {
    const cached = orderCache.get(rootId);
    if (cached && cached.signature === signature) {
        return cached.ids;
    }
    const data = await postJson<unknown>("/api/block/getDocBlocksOrders", {id: rootId});
    if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) {
        return null;
    }
    const ids = data as string[];
    orderCache.set(rootId, {signature, ids});
    return ids;
}

/** 单次扫描文档序。不在序里的 id（例如文档标题）保持调用方给定的相对位置。 */
export function orderIdsByDocOrder(ids: string[], docOrder: string[]): string[] {
    if (ids.length <= 1 || docOrder.length === 0) {
        return ids;
    }
    const needed = new Set(ids);
    const ordered: string[] = [];
    const title = ids.filter((id) => id === "__doc-title__");
    for (const id of title) {
        if (needed.delete(id)) {
            ordered.push(id);
        }
    }
    for (const id of docOrder) {
        if (!needed.has(id)) {
            continue;
        }
        ordered.push(id);
        needed.delete(id);
        if (needed.size === 0) {
            break;
        }
    }
    if (needed.size > 0) {
        for (const id of ids) {
            if (needed.has(id)) {
                ordered.push(id);
            }
        }
    }
    return ordered;
}
