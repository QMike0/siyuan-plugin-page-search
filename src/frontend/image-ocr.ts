import {imageOCRPath} from "../shared/image-ocr";
import {postJson} from "./corpus/api";

const cache = new Map<string, {text: string; expires: number; bytes: number;}>();
const CACHE_TTL = 10000;
const CACHE_BYTES = 4 * 1024 * 1024;
let cacheBytes = 0;
let generation = 0;
let readGeneration = 0;

/** OCR edits do not change block hashes. Invalidate on the native OCR event/index commit. */
export function invalidateImageOCRCache(cancelReads = true): void {
    generation++;
    // SQL commits are global; SearchBar cancels only the affected document's query.
    // Other documents may finish their reads, but must never repopulate this cache.
    if (cancelReads) readGeneration++;
    cache.clear();
    cacheBytes = 0;
}

function cachedText(path: string): string | undefined {
    const entry = cache.get(path);
    if (!entry) return undefined;
    cache.delete(path);
    if (entry.expires <= Date.now()) {
        cacheBytes -= entry.bytes;
        return undefined;
    }
    cache.set(path, entry);
    return entry.text;
}

function rememberText(path: string, text: string): void {
    const bytes = (path.length + text.length) * 2;
    if (bytes > CACHE_BYTES) return;
    const old = cache.get(path);
    if (old) cacheBytes -= old.bytes;
    cache.delete(path);
    cache.set(path, {text, expires: Date.now() + CACHE_TTL, bytes});
    cacheBytes += bytes;
    while (cache.size > 1024 || cacheBytes > CACHE_BYTES) {
        const key = cache.keys().next().value!;
        cacheBytes -= cache.get(key)!.bytes;
        cache.delete(key);
    }
}

/** Read existing results only. Never call /api/asset/ocr or download an image.
 * Short, bounded session cache includes empty results, never API errors.
 * Keep exact URLs: the kernel also supports legacy, non-normalized OCR aliases.
 * Clone OCR units so text caches keep the URL placeholder rather than stale recognized text.
 */
export async function resolveImageOCRUnits<T extends {unitId?: string; blockId: string; text: string;}>(
    units: T[], signal?: AbortSignal,
): Promise<{units: T[]; failedIds: string[];}> {
    const paths = new Map<string, string>();
    for (const unit of units) {
        const path = imageOCRPath(unit.unitId);
        if (path !== undefined) paths.set(path, "");
    }
    if (!paths.size) return {units, failedIds: []};
    const pending = Array.from(paths.keys());
    const failed = new Set<string>();
    const startedGeneration = generation;
    const startedReadGeneration = readGeneration;
    let next = 0;
    let bytes = 0;
    await Promise.all(Array.from({length: Math.min(4, pending.length)}, async () => {
        while (!signal?.aborted && startedReadGeneration === readGeneration && next < pending.length) {
            const path = pending[next++];
            const cached = cachedText(path);
            const data = cached !== undefined ? {text: cached} : await postJson<{text?: string; failed?: boolean;}>(
                "/api/asset/getImageOCRText", {path}, signal, false,
            );
            if (signal?.aborted || startedReadGeneration !== readGeneration) return;
            // Limit retained/output text, never truncate a result into a purportedly complete search.
            const text = typeof data?.text === "string" ? data.text : "";
            if (!data || typeof data.text !== "string" || text.length > 512 * 1024 ||
                bytes + text.length * 2 > 8 * 1024 * 1024) {
                failed.add(path);
                continue;
            }
            bytes += text.length * 2;
            paths.set(path, text);
            if (cached === undefined && startedGeneration === generation) rememberText(path, text);
        }
    }));
    const failedIds = new Set<string>();
    let outputBytes = 0;
    const resolved = units.map(unit => {
        const path = imageOCRPath(unit.unitId);
        if (path === undefined) return unit;
        let text = paths.get(path) ?? "";
        outputBytes += text.length * 2;
        if (startedReadGeneration !== readGeneration || failed.has(path) || outputBytes > 8 * 1024 * 1024) {
            failedIds.add(unit.blockId);
            text = "";
        }
        return {...unit, text};
    });
    return {units: resolved, failedIds: Array.from(failedIds)};
}
