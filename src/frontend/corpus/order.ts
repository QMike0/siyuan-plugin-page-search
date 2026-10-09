import {postJson} from "./api";

const ORDER_CACHE_TTL_MS = 1500;
const orderCache = new Map<string, {signature: string; ids: string[]; cachedAt: number;}>();
const HEADING_CHILDREN_CACHE_LIMIT = 256;
const headingChildrenCache = new Map<string, {signature: string; ids: string[];}>();

/** 只读已有文档序，不发起 getDocBlocksOrders。 */
export function peekDocOrder(rootId: string): string[] | null {
    const cached = orderCache.get(rootId);
    return cached?.ids ?? null;
}

export function invalidateDocOrder(rootId?: string): void {
    if (rootId) {
        orderCache.delete(rootId);
        for (const key of headingChildrenCache.keys()) {
            if (key.startsWith(`${rootId}:`)) {
                headingChildrenCache.delete(key);
            }
        }
        return;
    }
    orderCache.clear();
    headingChildrenCache.clear();
}

export async function fetchDocBlocksOrders(
    rootId: string,
    signature: string,
    signal?: AbortSignal,
): Promise<string[] | null> {
    const cached = orderCache.get(rootId);
    if (cached && cached.signature === signature && Date.now() - cached.cachedAt < ORDER_CACHE_TTL_MS) {
        return cached.ids;
    }
    const data = await postJson<unknown>("/api/block/getDocBlocksOrders", {id: rootId}, signal);
    if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) {
        return null;
    }
    const ids = data as string[];
    orderCache.set(rootId, {signature, ids, cachedAt: Date.now()});
    return ids;
}

/**
 * 内核按 HeadingChildren 的真实结构返回标题下辖块。只在当前已挂载且折叠的标题上调用，
 * 用来校正客户端根据 blocks.parent_id 推导时遇到的复杂容器边界。
 */
export async function fetchHeadingChildrenIds(
    rootId: string,
    headingId: string,
    signature: string,
    signal?: AbortSignal,
): Promise<string[] | null> {
    const key = `${rootId}:${headingId}`;
    const cached = headingChildrenCache.get(key);
    if (cached?.signature === signature) {
        headingChildrenCache.delete(key);
        headingChildrenCache.set(key, cached);
        return cached.ids;
    }
    const data = await postJson<unknown>("/api/block/getHeadingChildrenIDs", {id: headingId}, signal);
    if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) {
        return null;
    }
    const ids = data as string[];
    headingChildrenCache.set(key, {signature, ids});
    while (headingChildrenCache.size > HEADING_CHILDREN_CACHE_LIMIT) {
        const oldest = headingChildrenCache.keys().next().value as string | undefined;
        if (!oldest) {
            break;
        }
        headingChildrenCache.delete(oldest);
    }
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
