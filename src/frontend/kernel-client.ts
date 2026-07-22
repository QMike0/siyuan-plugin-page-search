import type {Plugin} from "siyuan";
import type {
    MatchHit,
    MatchOptions,
    MatchRequest,
    MatchResponse,
    PluginPrefs,
    SearchableUnit,
    SearchStateEvent,
    SearchStateType,
} from "../shared";
import {
    DEFAULT_PREFS,
    SEARCH_EMIT_METHOD,
    SEARCH_STATE_METHOD,
    matchOptionsFromRequest,
    matchTextUnitsDetailed,
    normalizeSearchStateEvent,
} from "../shared";

/** 内核 running 状态码（见 IKernelPluginState） */
export const KERNEL_STATE_RUNNING = 2;

export function isKernelRunning(plugin: Plugin): boolean {
    return plugin.kernel?.state?.code === KERNEL_STATE_RUNNING;
}

export function createClientId(): string {
    return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 通过内核 RPC 匹配；内核未就绪或调用失败时回退到本地 shared 引擎。
 */
export async function rpcMatch(
    plugin: Plugin,
    request: MatchRequest,
): Promise<MatchResponse> {
    const started = Date.now();
    const localFallback = (): MatchResponse => {
        const options = matchOptionsFromRequest(request);
        const matched = matchTextUnitsDetailed(request.units ?? [], request.query ?? "", options);
        return {
            hits: matched.hits,
            elapsedMs: Date.now() - started,
            hitCount: matched.hits.length,
            error: matched.error || undefined,
        };
    };

    if (!isKernelRunning(plugin)) {
        return localFallback();
    }

    try {
        const result = await plugin.kernel.rpc.call.match(request) as MatchResponse;
        if (!result || !Array.isArray(result.hits)) {
            return localFallback();
        }
        return {
            hits: result.hits,
            elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : Date.now() - started,
            hitCount: typeof result.hitCount === "number" ? result.hitCount : result.hits.length,
            error: typeof result.error === "string" ? result.error : undefined,
        };
    } catch (error) {
        console.warn("[page-search] rpc.match failed, using local fallback", error);
        return localFallback();
    }
}

export async function rpcGetPrefs(plugin: Plugin): Promise<PluginPrefs> {
    if (!isKernelRunning(plugin)) {
        return {...DEFAULT_PREFS};
    }
    try {
        const prefs = await plugin.kernel.rpc.call["prefs.get"]() as PluginPrefs;
        return {
            dialogLeft: prefs?.dialogLeft ?? null,
            dialogTop: prefs?.dialogTop ?? null,
            lastQuery: prefs?.lastQuery ?? "",
            includeAttributeView: prefs?.includeAttributeView !== false,
            includeMermaid: prefs?.includeMermaid !== false,
            includeFoldedBlocks: prefs?.includeFoldedBlocks === true,
            includeInlineMemo: prefs?.includeInlineMemo === true,
        };
    } catch (error) {
        console.warn("[page-search] prefs.get failed", error);
        return {...DEFAULT_PREFS};
    }
}

export async function rpcSetPrefs(
    plugin: Plugin,
    patch: Partial<PluginPrefs>,
): Promise<PluginPrefs> {
    if (!isKernelRunning(plugin)) {
        return {...DEFAULT_PREFS, ...patch};
    }
    try {
        const prefs = await plugin.kernel.rpc.call["prefs.set"](patch) as PluginPrefs;
        return {
            dialogLeft: prefs?.dialogLeft ?? null,
            dialogTop: prefs?.dialogTop ?? null,
            lastQuery: prefs?.lastQuery ?? "",
            includeAttributeView: prefs?.includeAttributeView !== false,
            includeMermaid: prefs?.includeMermaid !== false,
            includeFoldedBlocks: prefs?.includeFoldedBlocks === true,
            includeInlineMemo: prefs?.includeInlineMemo === true,
        };
    } catch (error) {
        console.warn("[page-search] prefs.set failed", error);
        return {...DEFAULT_PREFS, ...patch};
    }
}

/** 通过内核广播 search-state（关闭 / 清空高亮） */
export async function rpcEmitSearchState(
    plugin: Plugin,
    event: SearchStateEvent,
): Promise<void> {
    if (!isKernelRunning(plugin)) {
        return;
    }
    try {
        await plugin.kernel.rpc.call[SEARCH_EMIT_METHOD](event);
    } catch (error) {
        console.warn("[page-search] search.emit failed", error);
    }
}

export function bindSearchStateListener(
    plugin: Plugin,
    handler: (event: SearchStateEvent) => void | Promise<void>,
): (...args: any[]) => Promise<void> {
    const wrapped = async (...args: any[]) => {
        const event = normalizeSearchStateEvent(args)
            ?? (args.length > 0 ? normalizeSearchStateEvent([args[0]]) : null);
        if (!event) {
            return;
        }
        await handler(event);
    };
    plugin.kernel.rpc.bind(SEARCH_STATE_METHOD, wrapped);
    return wrapped;
}

export function unbindSearchStateListener(
    plugin: Plugin,
    handler: (...args: any[]) => void | Promise<void>,
): void {
    plugin.kernel.rpc.unbind(SEARCH_STATE_METHOD, handler);
}

/** 便捷：仅传 units + query + 可选匹配选项 */
export async function matchUnitsViaKernel(
    plugin: Plugin,
    query: string,
    units: SearchableUnit[],
    dedupeOverlaps = true,
    matchOptions: MatchOptions = {},
): Promise<MatchHit[]> {
    const response = await rpcMatch(plugin, {
        query,
        units,
        dedupeOverlaps,
        ...matchOptions,
    });
    return response.hits;
}

export type {MatchRequest, MatchResponse, PluginPrefs, SearchStateEvent, SearchStateType};
export {SEARCH_EMIT_METHOD, SEARCH_STATE_METHOD};
