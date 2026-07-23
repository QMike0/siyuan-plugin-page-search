import type {MatchHit, MatchOptions, MatchTextUnitsOptions, SearchableUnit} from "./types";
import {
    normalizeRestrictInlineTypes,
    type RestrictInlineType,
} from "./restrict-inline";

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

/**
 * 插件偏好（对话框位置、最近关键词、匹配范围等）。
 *
 * 「是否查找」：include*；「限制查找」：restrictInlineTypes（空=不限制）。
 * 详见 shared/restrict-inline.ts 契约说明。
 */
export interface PluginPrefs {
    dialogLeft: number | null;
    dialogTop: number | null;
    lastQuery: string;
    /** 是否匹配文档内数据库（Attribute View）；默认 true */
    includeAttributeView: boolean;
    /** 是否匹配表格块（NodeTable）；默认 true */
    includeTable: boolean;
    /** 是否匹配引述块（NodeBlockquote）及其内部子块；默认 true */
    includeBlockquote: boolean;
    /** 是否匹配提示块（NodeCallout，含标题与内部子块）；默认 true */
    includeCallout: boolean;
    /** 是否匹配公式块（NodeMathBlock）；默认 true；不含行内公式 */
    includeMathBlock: boolean;
    /** 是否匹配嵌入块（NodeBlockQueryEmbed）及其内部渲染内容；默认 true */
    includeEmbedBlock: boolean;
    /** 是否匹配挂件块（NodeWidget）；默认 true */
    includeWidget: boolean;
    /** 是否匹配代码块（不含 Mermaid，由 includeMermaid 单独控制）；默认 true */
    includeCodeBlock: boolean;
    /** 是否匹配 Mermaid 图；默认 true */
    includeMermaid: boolean;
    /**
     * 是否匹配 HTML 块（NodeHTMLBlock）Shadow 内渲染可见文字；默认 true。
     * 匹配渲染结果而非 data-content 源码；不可替换。
     */
    includeHtmlBlock: boolean;
    /**
     * 是否匹配非标题 CSS 折叠块内隐藏内容；默认 false。
     * 不含折叠标题（子块已不在 DOM）。
     */
    includeFoldedBlocks: boolean;
    /**
     * 「是否查找 · 行内备注」：正常搜时是否纳入备注属性；默认 false。
     * 为 false 时不得保留 restrictInlineTypes 中的 inline-memo。
     */
    includeInlineMemo: boolean;
    /**
     * 「限制查找」所选行内类型；默认 []（不限制）。
     * 仅当前搜索会话内有效：关闭搜索窗时清回 []，不跨次打开恢复。
     * 非空时仅在这些类型中搜索（OR）；空查询时枚举行内宿主。
     */
    restrictInlineTypes: RestrictInlineType[];
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
    includeTable: true,
    includeBlockquote: true,
    includeCallout: true,
    includeMathBlock: true,
    includeEmbedBlock: true,
    includeWidget: true,
    includeCodeBlock: true,
    includeMermaid: true,
    includeHtmlBlock: true,
    includeFoldedBlocks: false,
    includeInlineMemo: false,
    restrictInlineTypes: [],
};

export const PREFS_STORAGE_PATH = "prefs.json";

/** 将任意 prefs 形态收成合法 PluginPrefs（含备注门闩） */
export function coercePluginPrefs(
    raw: Partial<PluginPrefs> | null | undefined,
): PluginPrefs {
    const base = {...DEFAULT_PREFS, ...(raw ?? {})};
    const includeInlineMemo = base.includeInlineMemo === true;
    return {
        dialogLeft: typeof base.dialogLeft === "number" ? base.dialogLeft : null,
        dialogTop: typeof base.dialogTop === "number" ? base.dialogTop : null,
        lastQuery: typeof base.lastQuery === "string" ? base.lastQuery : "",
        includeAttributeView: base.includeAttributeView !== false,
        includeTable: base.includeTable !== false,
        includeBlockquote: base.includeBlockquote !== false,
        includeCallout: base.includeCallout !== false,
        includeMathBlock: base.includeMathBlock !== false,
        includeEmbedBlock: base.includeEmbedBlock !== false,
        includeWidget: base.includeWidget !== false,
        includeCodeBlock: base.includeCodeBlock !== false,
        includeMermaid: base.includeMermaid !== false,
        includeHtmlBlock: base.includeHtmlBlock !== false,
        includeFoldedBlocks: base.includeFoldedBlocks === true,
        includeInlineMemo,
        restrictInlineTypes: normalizeRestrictInlineTypes(base.restrictInlineTypes, {
            includeInlineMemo,
        }),
    };
}

export function mergePrefs(
    base: PluginPrefs,
    patch: Partial<PluginPrefs> | null | undefined,
): PluginPrefs {
    if (!patch) {
        return coercePluginPrefs(base);
    }
    return coercePluginPrefs({
        dialogLeft: patch.dialogLeft !== undefined ? patch.dialogLeft : base.dialogLeft,
        dialogTop: patch.dialogTop !== undefined ? patch.dialogTop : base.dialogTop,
        lastQuery: patch.lastQuery !== undefined ? patch.lastQuery : base.lastQuery,
        includeAttributeView: patch.includeAttributeView !== undefined
            ? patch.includeAttributeView
            : base.includeAttributeView,
        includeTable: patch.includeTable !== undefined
            ? patch.includeTable
            : base.includeTable,
        includeBlockquote: patch.includeBlockquote !== undefined
            ? patch.includeBlockquote
            : base.includeBlockquote,
        includeCallout: patch.includeCallout !== undefined
            ? patch.includeCallout
            : base.includeCallout,
        includeMathBlock: patch.includeMathBlock !== undefined
            ? patch.includeMathBlock
            : base.includeMathBlock,
        includeEmbedBlock: patch.includeEmbedBlock !== undefined
            ? patch.includeEmbedBlock
            : base.includeEmbedBlock,
        includeWidget: patch.includeWidget !== undefined
            ? patch.includeWidget
            : base.includeWidget,
        includeCodeBlock: patch.includeCodeBlock !== undefined
            ? patch.includeCodeBlock
            : base.includeCodeBlock,
        includeMermaid: patch.includeMermaid !== undefined
            ? patch.includeMermaid
            : base.includeMermaid,
        includeHtmlBlock: patch.includeHtmlBlock !== undefined
            ? patch.includeHtmlBlock
            : base.includeHtmlBlock,
        includeFoldedBlocks: patch.includeFoldedBlocks !== undefined
            ? patch.includeFoldedBlocks
            : base.includeFoldedBlocks,
        includeInlineMemo: patch.includeInlineMemo !== undefined
            ? patch.includeInlineMemo
            : base.includeInlineMemo,
        restrictInlineTypes: patch.restrictInlineTypes !== undefined
            ? patch.restrictInlineTypes
            : base.restrictInlineTypes,
    });
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
