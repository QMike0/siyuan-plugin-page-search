import type * as kernel from "siyuan/kernel";
import {
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    SEARCH_EMIT_METHOD,
    SEARCH_STATE_METHOD,
    matchOptionsFromRequest,
    matchTextUnitsDetailed,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeSearchStateEvent,
} from "./shared";
import type {MatchRequest, MatchResponse, PluginPrefs, SearchableUnit, SearchStateEvent} from "./shared";

/**
 * 页内查找替换 — 内核插件。
 *
 * RPC:
 * - match / prefs.get / prefs.set
 * - search.emit → broadcast search-state（跨窗口关闭/清空）
 *
 * MCP:
 * - page_search
 */
class KernelPlugin {
    private readonly siyuan: kernel.ISiyuan = siyuan;
    private prefsCache: PluginPrefs = {...DEFAULT_PREFS};
    /** 自身 prefs.put 后短暂忽略 fs-notify，避免读到旧文件冲掉刚写入的字段 */
    private ignorePrefsFsNotifyUntil = 0;

    constructor() {
        this.siyuan.plugin.lifecycle.onload = this.onload.bind(this);
        this.siyuan.plugin.lifecycle.onrunning = this.onrunning.bind(this);
        this.siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
        this.siyuan.event.handler = this.eventHandler.bind(this);
    }

    private async onload(): Promise<void> {
        const {rpc, mcp, storage, logger, plugin} = this.siyuan;
        await logger.info("page-search kernel onload:", plugin.name, plugin.version);

        this.prefsCache = await this.readPrefsFromStorage();

        try {
            await storage.watcher.add("./");
        } catch (error) {
            await logger.warn("storage.watcher.add failed:", error);
        }

        await rpc.bind(
            "match",
            async (...args: any[]) => this.handleMatch(normalizeMatchRequest(args)),
            "Match query against searchable text units; returns hits with offsets.",
        );

        await rpc.bind(
            "prefs.get",
            async () => this.handlePrefsGet(),
            "Get plugin preferences (dialog position, last query).",
        );

        await rpc.bind(
            "prefs.set",
            async (...args: any[]) => this.handlePrefsSet(normalizePrefsPatch(args)),
            "Merge and persist plugin preferences.",
        );

        await rpc.bind(
            SEARCH_EMIT_METHOD,
            async (...args: any[]) => this.handleSearchEmit(args),
            "Broadcast search-state (close/clear) to all frontend clients.",
        );

        await mcp.registerTool(
            "page_search",
            {
                title: "Page Search",
                description:
                    "Search plain-text units (or a single text blob) with the same matcher as the page-search plugin.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Search keyword",
                        },
                        units: {
                            type: "array",
                            description: "Searchable units with blockId/text (and optional unitId/segmentLengths)",
                            items: {type: "object"},
                        },
                        text: {
                            type: "string",
                            description: "Fallback plain text when units are omitted",
                        },
                        dedupeOverlaps: {
                            type: "boolean",
                            description: "Greedy overlap dedupe (default true for MCP)",
                        },
                        caseSensitive: {
                            type: "boolean",
                            description: "Case-sensitive search (default false)",
                        },
                        wholeWord: {
                            type: "boolean",
                            description: "Whole-word match using ASCII word boundaries (default false)",
                        },
                        regex: {
                            type: "boolean",
                            description: "Treat query as RegExp for search only (default false)",
                        },
                    },
                    required: ["query"],
                    additionalProperties: false,
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        hits: {type: "array", items: {type: "object"}},
                        elapsedMs: {type: "number"},
                        hitCount: {type: "number"},
                        error: {type: "string"},
                    },
                },
            },
            async (input: Record<string, any>) => this.handleMcpPageSearch(input ?? {}),
        );

        await logger.info("page-search kernel registered rpc/mcp");
    }

    private async onrunning(): Promise<void> {
        const {logger} = this.siyuan;
        await logger.info("page-search kernel running");
    }

    private async onunload(): Promise<void> {
        const {rpc, mcp, storage, logger} = this.siyuan;
        try {
            await storage.watcher.remove("./");
        } catch (error) {
            await logger.warn("storage.watcher.remove failed:", error);
        }
        try {
            await mcp.unregisterTool("page_search");
        } catch (error) {
            await logger.warn("unregisterTool page_search failed:", error);
        }
        for (const name of ["match", "prefs.get", "prefs.set", SEARCH_EMIT_METHOD]) {
            try {
                await rpc.unbind(name);
            } catch (error) {
                await logger.warn(`rpc.unbind ${name} failed:`, error);
            }
        }
        await logger.info("page-search kernel unload");
    }

    private async eventHandler(event: kernel.TEventMessage): Promise<void> {
        if (event.type !== "fs-notify") {
            return;
        }
        const path = String(event.detail?.path ?? "").replace(/^\.\//, "");
        if (path !== PREFS_STORAGE_PATH && !path.endsWith(`/${PREFS_STORAGE_PATH}`)) {
            return;
        }
        if (Date.now() < this.ignorePrefsFsNotifyUntil) {
            return;
        }
        if (event.detail?.operation === "REMOVE") {
            this.prefsCache = {...DEFAULT_PREFS};
            return;
        }
        // 合并进当前缓存，避免旧文件缺字段（如新开关）把内存里刚写入的值冲回默认
        try {
            const obj = await this.siyuan.storage.get(PREFS_STORAGE_PATH);
            const raw = await obj.json();
            this.prefsCache = mergePrefs(this.prefsCache, raw as Partial<PluginPrefs>);
            await this.siyuan.logger.debug("prefs reloaded from fs-notify:", this.prefsCache);
        } catch (error) {
            await this.siyuan.logger.warn("prefs fs-notify reload failed:", error);
        }
    }

    private async handleMatch(request: MatchRequest): Promise<MatchResponse> {
        const {logger} = this.siyuan;
        const started = Date.now();
        const options = matchOptionsFromRequest(request);
        if (options.dedupeOverlaps === undefined) {
            options.dedupeOverlaps = true;
        }
        const matched = matchTextUnitsDetailed(request.units ?? [], request.query ?? "", options);
        const response: MatchResponse = {
            hits: matched.hits,
            elapsedMs: Date.now() - started,
            hitCount: matched.hits.length,
            error: matched.error || undefined,
        };
        await logger.debug(
            "rpc.match:",
            {query: request.query, units: request.units?.length ?? 0, ...response},
        );
        return response;
    }

    private async handlePrefsGet(): Promise<PluginPrefs> {
        return {...this.prefsCache};
    }

    private async handlePrefsSet(patch: Partial<PluginPrefs>): Promise<PluginPrefs> {
        const {storage, logger} = this.siyuan;
        this.prefsCache = mergePrefs(this.prefsCache, patch);
        // 忽略随后自身写入触发的 fs-notify（否则可能读到尚未更新完的旧 prefs.json）
        this.ignorePrefsFsNotifyUntil = Date.now() + 800;
        await storage.put(PREFS_STORAGE_PATH, JSON.stringify(this.prefsCache));
        await logger.debug("prefs.set:", this.prefsCache);
        return {...this.prefsCache};
    }

    private async handleSearchEmit(args: any[]): Promise<SearchStateEvent | null> {
        const {rpc, logger} = this.siyuan;
        const event = normalizeSearchStateEvent(args);
        if (!event) {
            await logger.warn("search.emit ignored: invalid payload", args);
            return null;
        }
        await rpc.broadcast(SEARCH_STATE_METHOD, event);
        await logger.debug("search.emit broadcast:", event);
        return event;
    }

    private async handleMcpPageSearch(input: Record<string, any>): Promise<MatchResponse> {
        const query = String(input.query ?? "");
        let units: SearchableUnit[] = Array.isArray(input.units) ? input.units : [];
        if (!units.length && typeof input.text === "string" && input.text.length > 0) {
            units = [{
                blockId: "__mcp_text__",
                blockType: "text",
                blockIndex: 0,
                text: input.text,
                segmentLengths: [input.text.length],
            }];
        }
        return this.handleMatch({
            query,
            units,
            dedupeOverlaps: input.dedupeOverlaps !== false,
            caseSensitive: typeof input.caseSensitive === "boolean" ? input.caseSensitive : undefined,
            wholeWord: typeof input.wholeWord === "boolean" ? input.wholeWord : undefined,
            regex: typeof input.regex === "boolean" ? input.regex : undefined,
        });
    }

    private async readPrefsFromStorage(): Promise<PluginPrefs> {
        const {storage, logger} = this.siyuan;
        try {
            const obj = await storage.get(PREFS_STORAGE_PATH);
            const raw = await obj.json();
            return mergePrefs(DEFAULT_PREFS, raw as Partial<PluginPrefs>);
        } catch {
            await logger.debug("prefs.json missing, using defaults");
            return {...DEFAULT_PREFS};
        }
    }
}

new KernelPlugin();
