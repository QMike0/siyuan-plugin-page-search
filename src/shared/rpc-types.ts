import type {MatchHit, MatchOptions, MatchTextUnitsOptions, SearchableUnit} from "./types";

/** 内核 / 前端约定的搜索请求 */
export interface MatchRequest {
    query: string;
    units: SearchableUnit[];
    /**
     * 是否贪心去重。内核默认 true（客户端通常已按单元拆分）。
     * 前端本地 fallback 做 Range 可见性过滤时应为 false。
     */
    dedupeOverlaps?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
}

/** 内核 match RPC 响应 */
export interface MatchResponse {
    hits: MatchHit[];
    /** 匹配耗时（毫秒） */
    elapsedMs: number;
    hitCount: number;
    /** 非法正则等；空或缺省表示成功 */
    error?: string;
}

/** 插件偏好（对话框位置、最近关键词、匹配范围等） */
export interface PluginPrefs {
    dialogLeft: number | null;
    dialogTop: number | null;
    lastQuery: string;
    /** 是否匹配文档内数据库（Attribute View）；默认 true */
    includeAttributeView: boolean;
    /** 是否匹配 Mermaid 图；默认 true */
    includeMermaid: boolean;
    /**
     * 是否匹配非标题 CSS 折叠块内隐藏内容；默认 false。
     * 不含折叠标题（子块已不在 DOM）。
     */
    includeFoldedBlocks: boolean;
    /** 是否匹配行内备注；默认 false */
    includeInlineMemo: boolean;
}

/** 跨窗口搜索状态同步（内核 broadcast → 前端 bind） */
export type SearchStateType = "close" | "clear";

export interface SearchStateEvent {
    type: SearchStateType;
    /** 发送端客户端 ID，接收端用于忽略回环 */
    clientId: string;
    /** 可选附带信息 */
    query?: string;
}

export const SEARCH_STATE_METHOD = "search-state";
export const SEARCH_EMIT_METHOD = "search.emit";

export const DEFAULT_PREFS: PluginPrefs = {
    dialogLeft: null,
    dialogTop: null,
    lastQuery: "",
    includeAttributeView: true,
    includeMermaid: true,
    includeFoldedBlocks: false,
    includeInlineMemo: false,
};

export const PREFS_STORAGE_PATH = "prefs.json";

export function mergePrefs(
    base: PluginPrefs,
    patch: Partial<PluginPrefs> | null | undefined,
): PluginPrefs {
    if (!patch) {
        return {...base};
    }
    return {
        dialogLeft: patch.dialogLeft !== undefined ? patch.dialogLeft : base.dialogLeft,
        dialogTop: patch.dialogTop !== undefined ? patch.dialogTop : base.dialogTop,
        lastQuery: patch.lastQuery !== undefined ? patch.lastQuery : base.lastQuery,
        includeAttributeView: patch.includeAttributeView !== undefined
            ? patch.includeAttributeView
            : base.includeAttributeView,
        includeMermaid: patch.includeMermaid !== undefined
            ? patch.includeMermaid
            : base.includeMermaid,
        includeFoldedBlocks: patch.includeFoldedBlocks !== undefined
            ? patch.includeFoldedBlocks
            : base.includeFoldedBlocks,
        includeInlineMemo: patch.includeInlineMemo !== undefined
            ? patch.includeInlineMemo
            : base.includeInlineMemo,
    };
}

export function normalizeMatchRequest(args: any[]): MatchRequest {
    if (args.length === 1 && isPlainObject(args[0])) {
        const obj = args[0] as Record<string, any>;
        const nested = isPlainObject(obj.options) ? obj.options : obj;
        return {
            query: String(obj.query ?? ""),
            units: Array.isArray(obj.units) ? obj.units : [],
            dedupeOverlaps: obj.dedupeOverlaps,
            caseSensitive: boolOrUndef(nested.caseSensitive ?? obj.caseSensitive),
            wholeWord: boolOrUndef(nested.wholeWord ?? obj.wholeWord),
            regex: boolOrUndef(nested.regex ?? obj.regex),
        };
    }

    const third = args[2];
    const fromThird = typeof third === "boolean"
        ? {dedupeOverlaps: third}
        : (isPlainObject(third) ? third as MatchTextUnitsOptions & MatchOptions : {});

    return {
        query: String(args[0] ?? ""),
        units: Array.isArray(args[1]) ? args[1] : [],
        dedupeOverlaps: fromThird.dedupeOverlaps,
        caseSensitive: boolOrUndef(fromThird.caseSensitive),
        wholeWord: boolOrUndef(fromThird.wholeWord),
        regex: boolOrUndef(fromThird.regex),
    };
}

export function matchOptionsFromRequest(request: MatchRequest): MatchTextUnitsOptions {
    return {
        dedupeOverlaps: request.dedupeOverlaps,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        regex: request.regex,
    };
}

export function normalizePrefsPatch(args: any[]): Partial<PluginPrefs> {
    if (args.length === 1 && isPlainObject(args[0])) {
        return args[0] as Partial<PluginPrefs>;
    }
    if (args.length >= 1 && isPlainObject(args[0])) {
        return args[0] as Partial<PluginPrefs>;
    }
    return {};
}

export function normalizeSearchStateEvent(args: any[]): SearchStateEvent | null {
    const raw = args.length >= 1 && isPlainObject(args[0])
        ? args[0]
        : null;
    if (!raw) {
        return null;
    }
    const type = raw.type;
    if (type !== "close" && type !== "clear") {
        return null;
    }
    return {
        type,
        clientId: String(raw.clientId ?? ""),
        query: raw.query !== undefined ? String(raw.query) : undefined,
    };
}

function boolOrUndef(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
