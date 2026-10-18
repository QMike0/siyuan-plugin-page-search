import type * as kernel from "siyuan/kernel";
import {
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    mergePrefs,
    normalizePrefsPatch,
} from "./shared";
import type {PluginPrefs} from "./shared";
import {LOGGING_STORAGE_PATH, errorDetails, isDebugLoggingEnabled, setDebugLogging} from "./shared/logger";

/**
 * 页内查找替换 — 内核插件。
 *
 * RPC:
 * - prefs.get / prefs.set
 *
 * 全文匹配在前端完成，不再提供 match RPC 或 MCP page_search。
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
        const {rpc, storage, logger, plugin} = this.siyuan;
        await this.loadLoggingSettings();
        if (isDebugLoggingEnabled()) await logger.debug("[page-search] kernel onload:", plugin.name, plugin.version);

        this.prefsCache = await this.readPrefsFromStorage();

        try {
            await storage.watcher.add("./");
        } catch (error) {
            await logger.warn("[page-search] storage.watcher.add failed:", errorDetails(error));
        }

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

        if (isDebugLoggingEnabled()) await logger.debug("[page-search] kernel registered rpc");
    }

    private async onrunning(): Promise<void> {
        const {logger} = this.siyuan;
        if (isDebugLoggingEnabled()) await logger.debug("[page-search] kernel running");
    }

    private async onunload(): Promise<void> {
        const {rpc, storage, logger} = this.siyuan;
        try {
            await storage.watcher.remove("./");
        } catch (error) {
            await logger.warn("[page-search] storage.watcher.remove failed:", errorDetails(error));
        }
        for (const name of ["prefs.get", "prefs.set"]) {
            try {
                await rpc.unbind(name);
            } catch (error) {
                await logger.warn(`[page-search] rpc.unbind ${name} failed:`, errorDetails(error));
            }
        }
        if (isDebugLoggingEnabled()) await logger.debug("[page-search] kernel unload");
        setDebugLogging(false);
    }

    private async eventHandler(event: kernel.TEventMessage): Promise<void> {
        if (event.type !== "fs-notify") {
            return;
        }
        const path = String(event.detail?.path ?? "").replace(/^\.\//, "");
        if (path === LOGGING_STORAGE_PATH || path.endsWith(`/${LOGGING_STORAGE_PATH}`)) {
            if (event.detail?.operation === "REMOVE") setDebugLogging(false);
            else await this.loadLoggingSettings();
            return;
        }
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
            if (isDebugLoggingEnabled()) await this.siyuan.logger.debug("[page-search] preferences reloaded");
        } catch (error) {
            await this.siyuan.logger.warn("[page-search] prefs fs-notify reload failed:", errorDetails(error));
        }
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
        if (isDebugLoggingEnabled()) await logger.debug("[page-search] preferences saved");
        return {...this.prefsCache};
    }

    private async readPrefsFromStorage(): Promise<PluginPrefs> {
        const {storage, logger} = this.siyuan;
        try {
            const obj = await storage.get(PREFS_STORAGE_PATH);
            const raw = await obj.json();
            return mergePrefs(DEFAULT_PREFS, raw as Partial<PluginPrefs>);
        } catch {
            if (isDebugLoggingEnabled()) await logger.debug("[page-search] prefs.json missing, using defaults");
            return {...DEFAULT_PREFS};
        }
    }

    private async loadLoggingSettings(): Promise<void> {
        try {
            const stored = await this.siyuan.storage.get(LOGGING_STORAGE_PATH);
            setDebugLogging((await stored.json())?.debug === true);
        } catch {
            // Missing diagnostics settings are normal on a fresh installation.
            setDebugLogging(false);
        }
    }
}

new KernelPlugin();
