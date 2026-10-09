import type {BlockAncestorIncludeFlags} from "../../shared";
import {
    codeBlockLanguagesNeeded as codeBlockLanguagesNeededFor,
    effectiveCodeBlockLanguage,
    isCodeBlockLanguageEnabled,
} from "../../shared/code-block-language";
import {
    escSql,
    querySqlAll,
} from "./api";

/** 与搜索面板的块类型开关对齐，避免 corpus 反向依赖 pipeline。 */
export interface BlockIncludeFlags extends BlockAncestorIncludeFlags {
    includeImageTitle?: boolean;
    includeAttributeView?: boolean;
    includeTable?: boolean;
    includeParagraph?: boolean;
    includeHeadingH1?: boolean;
    includeHeadingH2?: boolean;
    includeHeadingH3?: boolean;
    includeHeadingH4?: boolean;
    includeHeadingH5?: boolean;
    includeHeadingH6?: boolean;
    includeMathBlock?: boolean;
    includeEmbedBlock?: boolean;
    includeCodeBlock?: boolean;
    includeMermaid?: boolean;
    includeFlowchart?: boolean;
    includeHtmlBlock?: boolean;
    includeTabs?: boolean;
    includeMindmap?: boolean;
}

/** 容器块不单独计子块正文。思维导图等新叶子类型靠排除法保留。 */

export interface BlockMeta {
    id: string;
    parentId: string;
    type: string;
    subtype: string;
    /**
     * 代码块围栏语言。思源 `blocks.subtype` 对 NodeCodeBlock 恒为空
     * （`treenode.SubTypeAbbr` 不记录语言），不能拿来区分 Mermaid / flowchart。
     * 未解析到时保持 undefined，已解析的普通代码块是空字符串。
     */
    codeLanguage?: string;
    /**
     * 围栏语言仅来自当前已挂载的编辑器 DOM。它可能尚未保存，不能按数据库 hash
     * 复用到下一轮元数据；卸载后应重新从 blocks.markdown 读取。
     */
    codeLanguageFromLive?: boolean;
    ial: string;
    hash: string;
    updated: string;
}

export interface DocMeta {
    byId: Map<string, BlockMeta>;
    /** 含容器在内的父子关系，供聚焦时收窄范围。 */
    links: Map<string, {
        parentId: string;
        type: string;
        subtype: string;
        ial: string;
        /** 容器块不进 byId，但运行时文字缓存仍需用内容版本校验。 */
        hash: string;
    }>;
    /** 块数量加最新 updated。变化后再拉 getDocBlocksOrders。 */
    signature: string;
    /** 本轮是否已经解析过代码块围栏语言。图表分流、开关和缓存共用它。 */
    codeLanguagesLoaded?: boolean;
    /**
     * getDocBlocksOrders 失败时的阅读序。
     * 同级块按块 id 排列，移动过的块可能和编辑器原文序略有差别。
     */
    fallbackOrder: string[];
}

const metaCache = new Map<string, {at: number; meta: DocMeta;}>();
const META_TTL_MS = 1500;
/** 长会话切换大量文档时，结构信息不能无限留下。当前文档刚写入，淘汰的是更早的文档。 */
const META_CACHE_LIMIT = 16;

function rememberMeta(rootId: string, entry: {at: number; meta: DocMeta;}): void {
    metaCache.delete(rootId);
    metaCache.set(rootId, entry);
    while (metaCache.size > META_CACHE_LIMIT) {
        const oldest = metaCache.keys().next().value as string | undefined;
        if (!oldest) {
            break;
        }
        metaCache.delete(oldest);
    }
}

/** 只读缓存，不因过期再查库。跳转用它猜折叠标题，猜错会退回接口。 */
export function peekDocMeta(rootId: string): DocMeta | null {
    return metaCache.get(rootId)?.meta ?? null;
}

export function invalidateDocMeta(rootId?: string): void {
    if (rootId) {
        metaCache.delete(rootId);
        return;
    }
    metaCache.clear();
}

export async function loadDocMeta(rootId: string, signal?: AbortSignal): Promise<DocMeta | null> {
    if (signal?.aborted) {
        return null;
    }
    const cached = metaCache.get(rootId);
    if (cached && Date.now() - cached.at < META_TTL_MS) {
        rememberMeta(rootId, cached);
        return cached.meta;
    }
    const root = escSql(rootId);
    const rows = await querySqlAll<{
        id: string;
        parent_id?: string;
        type?: string;
        subtype?: string;
        ial?: string;
        hash?: string;
        updated?: string;
    }>((afterId, limit) => {
        const after = afterId ? ` AND id > '${escSql(afterId)}'` : "";
        return `SELECT id, parent_id, type, subtype, ial, hash, updated FROM blocks WHERE root_id = '${root}'${after} ` +
            `ORDER BY id LIMIT ${limit}`;
    }, signal);
    if (!rows) {
        return null;
    }

    const byId = new Map<string, BlockMeta>();
    const parentById = new Map<string, {
        parentId: string;
        type: string;
        subtype: string;
        ial: string;
        hash: string;
    }>();
    let maxUpdated = "";
    let codeLanguagesComplete = true;
    for (const row of rows) {
        if (!row.id) {
            continue;
        }
        const updated = String(row.updated ?? "");
        if (updated > maxUpdated) {
            maxUpdated = updated;
        }
        const type = String(row.type ?? "");
        const meta: BlockMeta = {
            id: row.id,
            parentId: String(row.parent_id ?? ""),
            type,
            subtype: String(row.subtype ?? ""),
            ial: String(row.ial ?? ""),
            hash: String(row.hash ?? ""),
            updated,
        };
        // 元数据 1.5 秒过期后仍可复用未改代码块的围栏语言，避免连续输入反复扫描整篇文档。
        // hash 为空时不猜；围栏或内容变更后 hash 变化，下一次会重新读取 markdown。
        const previous = cached?.meta.byId.get(meta.id);
        if (
            type === "c" &&
            meta.hash &&
            previous?.hash === meta.hash &&
            previous.codeLanguage !== undefined &&
            !previous.codeLanguageFromLive
        ) {
            meta.codeLanguage = previous.codeLanguage;
        }
        if (type === "c" && meta.codeLanguage === undefined) {
            codeLanguagesComplete = false;
        }
        parentById.set(row.id, {
            parentId: meta.parentId,
            type: meta.type,
            subtype: meta.subtype,
            ial: meta.ial,
            hash: meta.hash,
        });
        if (!isContainerType(type)) {
            byId.set(row.id, meta);
        }
    }

    const meta: DocMeta = {
        byId,
        links: parentById,
        signature: `${rows.length}:${maxUpdated}`,
        fallbackOrder: buildFallbackOrder(
            rootId,
            rows.map((row) => ({
                id: row.id,
                parentId: String(row.parent_id ?? ""),
                type: String(row.type ?? ""),
            })),
        ),
    };
    if (codeLanguagesComplete) {
        meta.codeLanguagesLoaded = true;
    }
    const cachedAt = Date.now();
    rememberMeta(rootId, {at: cachedAt, meta});
    return meta;
}

function buildFallbackOrder(
    rootId: string,
    rows: Array<{id: string; parentId: string; type: string;}>,
): string[] {
    const children = new Map<string, string[]>();
    const types = new Map<string, string>();
    for (const row of rows) {
        if (!row.id || row.id === rootId) {
            continue;
        }
        types.set(row.id, row.type);
        const parent = row.parentId || rootId;
        const list = children.get(parent) ?? [];
        list.push(row.id);
        children.set(parent, list);
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
        const kids = children.get(id);
        if (!kids) {
            return;
        }
        for (const child of kids) {
            if (seen.has(child)) {
                continue;
            }
            seen.add(child);
            if (types.get(child) !== "d") {
                ordered.push(child);
            }
            walk(child);
        }
    };
    walk(rootId);
    for (const row of rows) {
        if (!row.id || seen.has(row.id) || row.type === "d" || row.id === rootId) {
            continue;
        }
        seen.add(row.id);
        ordered.push(row.id);
        walk(row.id);
    }
    return ordered;
}

export function isContainerType(type: string): boolean {
    return type === "d" || type === "l" || type === "i" || type === "b" || type === "s" ||
        type === "mindmap" || type === "mindmap_item";
}

export function codeBlockLanguagesNeeded(options: BlockIncludeFlags): boolean {
    return codeBlockLanguagesNeededFor(options);
}

/**
 * 给未挂到编辑器上的代码块补围栏语言。
 * 思源 `blocks.markdown` 由 Protyle 导出，围栏在首行（前面可能有一个换行）。
 * 失败不写入完成标记，下次搜索可以再试；已由编辑器 data-subtype 写过的语言不覆盖。
 */
export async function ensureCodeBlockLanguages(
    rootId: string,
    meta: DocMeta,
    signal?: AbortSignal,
): Promise<boolean> {
    if (meta.codeLanguagesLoaded) {
        return true;
    }
    if (signal?.aborted) {
        return false;
    }
    let hasCodeBlock = false;
    for (const item of meta.byId.values()) {
        if (item.type === "c") {
            hasCodeBlock = true;
            break;
        }
    }
    if (!hasCodeBlock) {
        meta.codeLanguagesLoaded = true;
        return true;
    }
    const root = escSql(rootId);
    const fences = await querySqlAll<{id: string; fence?: string;}>((afterId, limit) => {
        const after = afterId ? ` AND id > '${escSql(afterId)}'` : "";
        return "SELECT id, substr(markdown, 1, 80) AS fence FROM blocks " +
            `WHERE root_id = '${root}' AND type = 'c'${after} ORDER BY id LIMIT ${limit}`;
    }, signal);
    if (signal?.aborted || !fences) {
        return false;
    }
    for (const row of fences) {
        const item = row.id ? meta.byId.get(row.id) : undefined;
        if (item && item.codeLanguage === undefined) {
            item.codeLanguage = codeFenceLanguage(String(row.fence ?? ""));
            item.codeLanguageFromLive = false;
        }
    }
    meta.codeLanguagesLoaded = true;
    return true;
}

/**
 * 围栏语言。思源导出的 markdown 可能先有换行，语言在 ``` 或 ~~~ 之后。
 * 只认第一个词，和编辑器 data-subtype 的取值方式一致。
 */
export function codeFenceLanguage(markdownHead: string): string {
    const line = markdownHead.replace(/^[\s\uFEFF]+/, "").split(/\r?\n/, 1)[0] ?? "";
    return /^(?:`{3,}|~{3,})([^\s`~]*)/.exec(line)?.[1] ?? "";
}

/**
 * 代码块分类唯一使用的有效语言：已挂载块的 data-subtype 优先，其次是围栏语言，
 * 最后才兼容未来内核可能写入的 blocks.subtype。
 */
export function effectiveCodeLanguage(meta: Pick<BlockMeta, "type" | "subtype" | "codeLanguage">): string {
    return effectiveCodeBlockLanguage(meta.type, meta.subtype, meta.codeLanguage);
}

const CODE_BLOCK_DOM_TYPE = "NodeCodeBlock";

/**
 * 已挂到编辑器上的代码块以 data-subtype 为准。
 * 数据库 subtype 为空，围栏查询也可能落后于未保存的语言切换。
 * 返回 true 表示语言变了，调用方需要丢掉按旧语言记下的开关结果。
 */
export function noteLiveCodeLanguage(meta: BlockMeta, element: HTMLElement): boolean {
    if (meta.type !== "c") {
        return false;
    }
    const host = element.getAttribute("data-type") === CODE_BLOCK_DOM_TYPE ?
        element :
        element.closest<HTMLElement>(`[data-type="${CODE_BLOCK_DOM_TYPE}"]`);
    if (!host) {
        return false;
    }
    const language = host.getAttribute("data-subtype") ?? "";
    const changed = meta.codeLanguage !== language;
    if (!changed && meta.codeLanguageFromLive) {
        return false;
    }
    meta.codeLanguage = language;
    meta.codeLanguageFromLive = true;
    return changed;
}

/** 用户关掉的块类型不进入候选。标题级别、列表子类型按 subtype 判断。 */
export function isBlockTypeEnabled(meta: BlockMeta, options: BlockIncludeFlags): boolean {
    const type = meta.type;
    const subtype = meta.subtype;
    if (type === "p" && options.includeParagraph === false) {
        return options.includeImageTitle !== false;
    }
    if (type === "h") {
        const level = subtype.replace(/^h/, "");
        const flags: Record<string, boolean | undefined> = {
            "1": options.includeHeadingH1,
            "2": options.includeHeadingH2,
            "3": options.includeHeadingH3,
            "4": options.includeHeadingH4,
            "5": options.includeHeadingH5,
            "6": options.includeHeadingH6,
        };
        return flags[level] !== false;
    }
    if (type === "t" && options.includeTable === false) {
        return false;
    }
    if (type === "m" && options.includeMathBlock === false) {
        return false;
    }
    if (type === "html" && options.includeHtmlBlock === false) {
        return false;
    }
    if (type === "av" && options.includeAttributeView === false) {
        return false;
    }
    if (type === "query_embed" && options.includeEmbedBlock === false) {
        return false;
    }
    if (type === "mindmap" || type === "mindmap_item") {
        return options.includeMindmap !== false;
    }
    if (type === "c") {
        const language = effectiveCodeLanguage(meta);
        return isCodeBlockLanguageEnabled(language, options);
    }
    if ((type === "tabs" || type === "tab") && options.includeTabs === false) {
        return false;
    }
    return true;
}

const LIST_MINDMAP_IAL = /(?:^|\s)custom-sy-list-mindmap="1"/;

/** 块自身或祖先是思维导图，或是已转成思维导图的列表。只在关闭思维导图搜索时调用。 */
export function isInMindmapBlock(
    id: string,
    links: Map<string, {parentId: string; type: string; ial?: string;}>,
): boolean {
    const seen = new Set<string>();
    let current = id;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = links.get(current);
        if (!node) {
            return false;
        }
        if (node.type === "mindmap" || node.type === "mindmap_item") {
            return true;
        }
        if (node.type === "l" && LIST_MINDMAP_IAL.test(node.ial || "")) {
            return true;
        }
        current = node.parentId;
    }
    return false;
}

/** 块自身或祖先是页签块 / 页签项。只在关闭页签搜索时调用。 */
export function isInTabsBlock(
    id: string,
    links: Map<string, {parentId: string; type: string;}>,
): boolean {
    const seen = new Set<string>();
    let current = id;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = links.get(current);
        if (!node) {
            return false;
        }
        if (node.type === "tabs" || node.type === "tab") {
            return true;
        }
        current = node.parentId;
    }
    return false;
}
