import {escSql, querySqlAll} from "./api";

/** 与搜索面板的块类型开关对齐，避免 corpus 反向依赖 pipeline。 */
export interface BlockIncludeFlags {
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
    ial: string;
    hash: string;
    updated: string;
}

export interface DocMeta {
    byId: Map<string, BlockMeta>;
    /** 非标题 fold="1" 的后代块 */
    foldedHidden: Set<string>;
    /** 含容器在内的父子关系，供聚焦时收窄范围。 */
    links: Map<string, {parentId: string; type: string; subtype: string; ial: string}>;
    /** 块数量加最新 updated。变化后再拉 getDocBlocksOrders。 */
    signature: string;
    /**
     * getDocBlocksOrders 失败时的阅读序。
     * 同级块按块 id 排列，移动过的块可能和编辑器原文序略有差别。
     */
    fallbackOrder: string[];
}

const metaCache = new Map<string, {at: number; meta: DocMeta}>();
const META_TTL_MS = 1500;

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

export async function loadDocMeta(rootId: string): Promise<DocMeta | null> {
    const cached = metaCache.get(rootId);
    if (cached && Date.now() - cached.at < META_TTL_MS) {
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
        return `SELECT id, parent_id, type, subtype, ial, hash, updated FROM blocks `
            + `WHERE root_id = '${root}'${after} ORDER BY id LIMIT ${limit}`;
    });
    if (!rows) {
        return null;
    }

    const byId = new Map<string, BlockMeta>();
    const parentById = new Map<string, {parentId: string; type: string; subtype: string; ial: string}>();
    let maxUpdated = "";
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
        parentById.set(row.id, {
            parentId: meta.parentId,
            type: meta.type,
            subtype: meta.subtype,
            ial: meta.ial,
        });
        if (!isContainerType(type)) {
            byId.set(row.id, meta);
        }
    }

    const foldedHidden = new Set<string>();
    for (const [id] of byId) {
        if (isUnderNonHeadingFold(id, parentById)) {
            foldedHidden.add(id);
        }
    }

    const meta: DocMeta = {
        byId,
        foldedHidden,
        links: parentById,
        signature: `${rows.length}:${maxUpdated}`,
        fallbackOrder: buildFallbackOrder(rootId, rows.map((row) => ({
            id: row.id,
            parentId: String(row.parent_id ?? ""),
            type: String(row.type ?? ""),
        }))),
    };
    metaCache.set(rootId, {at: Date.now(), meta});
    return meta;
}

function buildFallbackOrder(
    rootId: string,
    rows: Array<{id: string; parentId: string; type: string}>,
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

function isFoldedIal(ial: string): boolean {
    return /(?:^|\s)fold="1"/.test(ial);
}

function isUnderNonHeadingFold(
    id: string,
    parentById: Map<string, {parentId: string; type: string; subtype: string; ial: string}>,
): boolean {
    const seen = new Set<string>();
    let current = parentById.get(id)?.parentId ?? "";
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = parentById.get(current);
        if (!node) {
            break;
        }
        if (isFoldedIal(node.ial) && node.type !== "h") {
            return true;
        }
        current = node.parentId;
    }
    return false;
}

export function isContainerType(type: string): boolean {
    return type === "d" || type === "l" || type === "i" || type === "b" || type === "s"
        || type === "mindmap" || type === "mindmap_item";
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
        if (subtype === "mermaid") {
            return options.includeMermaid !== false;
        }
        if (subtype === "flowchart" || subtype === "graphviz" || subtype === "plantuml"
            || subtype === "chart" || subtype === "mindmap" || subtype === "abc") {
            return options.includeMermaid !== false || options.includeCodeBlock !== false;
        }
        return options.includeCodeBlock !== false;
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
    links: Map<string, {parentId: string; type: string; ial?: string}>,
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
    links: Map<string, {parentId: string; type: string}>,
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
