/** 结构和查询缓存共享跨文档字节预算；正在执行的搜索仍持有本轮快照，淘汰不影响完整性。 */
const entries = new Map<string, {bytes: number; evict: () => void;}>();
const LIMIT = 8 * 1024 * 1024;
let retained = 0;

export function forgetCacheBudget(key: string): void {
    const entry = entries.get(key);
    if (entry) retained -= entry.bytes;
    entries.delete(key);
}

export function touchCacheBudget(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entries.set(key, entry);
}

/** 少量可变元数据（围栏语言和活图表源码）增量记账，不重新扫描整篇文档。 */
export function adjustCacheBudgetBytes(key: string, delta: number): void {
    const entry = entries.get(key);
    if (!entry || delta === 0) return;
    rememberCacheBudget(key, Math.max(0, entry.bytes + delta), entry.evict);
}

export function rememberCacheBudget(key: string, bytes: number, evict: () => void): void {
    forgetCacheBudget(key);
    if (bytes > LIMIT) {
        evict();
        return;
    }
    entries.set(key, {bytes, evict});
    retained += bytes;
    for (const [oldKey, entry] of entries) {
        if (retained <= LIMIT) break;
        forgetCacheBudget(oldKey);
        entry.evict();
    }
}

export function stringListBytes(ids: readonly string[]): number {
    let bytes = 64;
    for (const id of ids) bytes += 24 + id.length * 2;
    return bytes;
}
