import type {Plugin} from "siyuan";
import type {PluginPrefs} from "../shared";
import {DEFAULT_PREFS, coercePluginPrefs} from "../shared";
import {isPluginStorageWritable} from "./editor-mode";

/** 内核 running 状态码（见 IKernelPluginState） */
const KERNEL_STATE_RUNNING = 2;

export function isKernelRunning(plugin: Plugin): boolean {
    return plugin.kernel?.state?.code === KERNEL_STATE_RUNNING;
}

export function createClientId(): string {
    return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function rpcGetPrefs(plugin: Plugin): Promise<PluginPrefs> {
    if (!isKernelRunning(plugin)) {
        return {...DEFAULT_PREFS};
    }
    try {
        const prefs = await plugin.kernel.rpc.call["prefs.get"]() as PluginPrefs;
        return coercePluginPrefs(prefs);
    } catch (error) {
        console.warn("[page-search] prefs.get failed", error);
        return {...DEFAULT_PREFS};
    }
}

export async function rpcSetPrefs(
    plugin: Plugin,
    patch: Partial<PluginPrefs>,
): Promise<PluginPrefs> {
    // 发布服务 / 全局只读：不写 petal；会话内 UI 状态由调用方本地字段维护
    if (!isPluginStorageWritable()) {
        const current = await rpcGetPrefs(plugin);
        return coercePluginPrefs({...current, ...patch});
    }
    if (!isKernelRunning(plugin)) {
        return coercePluginPrefs({...DEFAULT_PREFS, ...patch});
    }
    try {
        const prefs = await plugin.kernel.rpc.call["prefs.set"](patch) as PluginPrefs;
        return coercePluginPrefs(prefs);
    } catch (error) {
        console.warn("[page-search] prefs.set failed", error);
        return coercePluginPrefs({...DEFAULT_PREFS, ...patch});
    }
}
