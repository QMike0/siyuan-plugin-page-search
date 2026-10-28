import {
    generateSearchVariants,
    effectiveSearchQuery,
    searchNormalizeFoldIsSuperset,
    ZERO_WIDTH_GLOBAL_RE,
} from "../../shared";
import {isDiagramCodeLanguage} from "../../shared/code-block-language";
import type {RegexPrefilterAtom} from "../../shared/regex-literals";
import {
    escSql,
    querySql,
    querySqlAll,
} from "./api";
import {isContainerType} from "./meta";

// Fence info is outside blocks.content. Normalize only a bounded prefix;
// an unusually long fence/leading whitespace stays a candidate, avoiding false negatives.
const CODE_FENCE_SQL = "ltrim(substr(markdown, 1, 256), char(10) || char(13))";

function codeLanguageCandidatePredicate(predicate: string): string {
    return `(type = 'c' AND (instr(${CODE_FENCE_SQL}, char(10)) = 0 OR ${predicate}))`;
}

const CONTAINER_SQL = ["d", "l", "i", "b", "s", "mindmap", "mindmap_item"].map((type) => `'${type}'`).join(", ");

const INTERNAL_MARKER_CODES = [0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF];

function stripMarkerSql(column: string): string {
    return INTERNAL_MARKER_CODES.reduce((value, code) => {
        return `replace(${value}, char(${code}), '')`;
    }, column);
}

function hasMarkerSql(column: string): string {
    return `(${INTERNAL_MARKER_CODES.map((code) => `instr(${column}, char(${code})) > 0`).join(" OR ")})`;
}

/**
 * 与最终字面量匹配保持候选超集：查询空白变体、正文内部标记和 Unicode 大小写。
 * search_normalize 是思源 v3.8.6 原生搜索注册的 SQLite 函数；hanSensitive=1
 * 只折叠大小写，不在候选阶段额外扩大简繁语义。
 */
function literalCandidatePredicate(
    column: string,
    needle: string,
    caseSensitive: boolean,
): string {
    const variants = generateSearchVariants(effectiveSearchQuery(needle), true);
    if (variants.length === 0) {
        return "0";
    }
    const fold = (value: string) => caseSensitive ? value : `search_normalize(${value}, 0, 1)`;
    const rawColumn = fold(column);
    const normalizedColumn = fold(stripMarkerSql(column));
    const checks = new Set<string>();
    for (const variant of variants) {
        const literal = `'${escSql(variant)}'`;
        checks.add(`instr(${rawColumn}, ${fold(literal)}) > 0`);
        const normalized = variant.replace(ZERO_WIDTH_GLOBAL_RE, "");
        if (normalized) {
            const normalizedLiteral = `'${escSql(normalized)}'`;
            checks.add(`(${hasMarkerSql(column)} AND instr(${normalizedColumn}, ${fold(normalizedLiteral)}) > 0)`);
        }
    }
    return `(${Array.from(checks).join(" OR ")})`;
}

async function queryLiteralCandidates(
    rootId: string,
    scope: string,
    predicate: string,
    signal?: AbortSignal,
): Promise<string[] | null> {
    const root = escSql(rootId);
    let rows = await querySqlAll<{id: string;}>((afterId, limit) => {
        const after = afterId ? `AND id > '${escSql(afterId)}' ` : "";
        return `SELECT id FROM blocks WHERE root_id = '${root}' ${scope}${after}` +
            `AND ${predicate} ORDER BY id LIMIT ${limit}`;
    }, signal);
    if (!rows) {
        // 自定义规范化函数在异常环境不可用时宁可扩大候选，不能静默漏掉未加载块。
        rows = await querySqlAll<{id: string;}>((afterId, limit) => {
            const after = afterId ? `AND id > '${escSql(afterId)}' ` : "";
            return `SELECT id FROM blocks WHERE root_id = '${root}' ${scope}${after}` +
                `ORDER BY id LIMIT ${limit}`;
        }, signal);
    }
    if (!rows) {
        return null;
    }
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id);
}

async function queryScopedCandidates(rootId: string, scope: string, signal?: AbortSignal): Promise<string[] | null> {
    const root = escSql(rootId);
    const rows = await querySqlAll<{id: string;}>((afterId, limit) => {
        const after = afterId ? `AND id > '${escSql(afterId)}' ` : "";
        return `SELECT id FROM blocks WHERE root_id = '${root}' ${scope}${after}` +
            `ORDER BY id LIMIT ${limit}`;
    }, signal);
    if (!rows) {
        return null;
    }
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id);
}

/**
 * 分页查出全部候选。
 * 规范化查询失败，或 JS/Go 大小写无法证明是超集时，扩大到同范围全部块。
 * 两次查询都失败才返回 null。
 */
export async function fetchContentCandidateIds(
    rootId: string,
    needle: string,
    caseSensitive: boolean,
    signal?: AbortSignal,
    includeCodeLanguage = true,
): Promise<string[] | null> {
    if (!caseSensitive && !searchNormalizeFoldIsSuperset(needle)) {
        return queryScopedCandidates(
            rootId,
            `AND type NOT IN (${CONTAINER_SQL}) `,
            signal,
        );
    }
    const predicate = literalCandidatePredicate("content", needle, caseSensitive);
    const codeLanguage = includeCodeLanguage ?
        ` OR ${codeLanguageCandidatePredicate(literalCandidatePredicate(CODE_FENCE_SQL, needle, caseSensitive))}` : "";
    return queryLiteralCandidates(
        rootId,
        `AND type NOT IN (${CONTAINER_SQL}) `,
        `(${predicate}${codeLanguage} OR type IN ('query_embed', 'm') OR instr(markdown, 'inline-math') > 0 OR instr(markdown, '$') > 0)`,
        signal,
    );
}

export async function fetchMemoCandidateIds(rootId: string, signal?: AbortSignal): Promise<string[] | null> {
    // 思源 buildBlockFromNode 用 ExportNodeStdMd 入库：备注变成 <sup>…</sup>，
    // 不保留 data-inline-memo-content。spans.type 才保留 inline-memo 类型，
    // 用同文档的行级索引找宿主，不能按备注关键词或 DOM 属性缩窄候选。
    // IN 子查询只按有索引的 root_id 扫一次行级索引；分页和去重仍由 blocks.id 控制。
    const root = escSql(rootId);
    const leafScope = `AND type NOT IN (${CONTAINER_SQL}) `;
    const ids = await queryScopedCandidates(
        rootId,
        "AND (type = 'query_embed' OR " +
            `id IN (SELECT block_id FROM spans WHERE root_id = '${root}' ` +
            "AND (type LIKE '% inline-memo' OR type LIKE '% inline-memo %')) OR " +
            "instr(markdown, 'data-inline-memo-content') > 0) ",
        signal,
    );
    if (ids !== null) return ids;
    // 行级索引查询不可用时兼容标准导出和旧 DOM Markdown；sup 仅扩大候选，
    // 最终仍从块 DOM 的真实备注属性提取，不把普通上标当成备注。
    // 嵌入宿主的 Markdown 只有查询语句，备注来自查询结果，始终保留为候选。
    return queryScopedCandidates(
        rootId,
        leafScope + "AND (type = 'query_embed' OR instr(markdown, '<sup>') > 0 OR " +
            "instr(markdown, 'data-inline-memo-content') > 0) ",
        signal,
    );
}

function literalGroupPredicate(
    groups: RegexPrefilterAtom[][],
    rawColumn: string,
    caseSensitive: boolean,
): string {
    const parts = groups.map((group) => {
        const checks = group.map((atom) => atomPredicate(atom, rawColumn, caseSensitive));
        return checks.length === 1 ? checks[0] : `(${checks.join(" AND ")})`;
    });
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

function atomPredicate(
    atom: RegexPrefilterAtom,
    rawColumn: string,
    caseSensitive: boolean,
): string {
    if (atom.kind === "digit") {
        return `${rawColumn} GLOB '*[0-9]*'`;
    }
    if (atom.kind === "word") {
        return `${rawColumn} GLOB '*[A-Za-z0-9_]*'`;
    }
    const fold = (value: string) => caseSensitive ? value : `search_normalize(${value}, 0, 1)`;
    const literal = `'${escSql(atom.text)}'`;
    const rawCheck = `instr(${fold(rawColumn)}, ${fold(literal)}) > 0`;
    const normalized = atom.text.replace(ZERO_WIDTH_GLOBAL_RE, "");
    if (!normalized) {
        return rawCheck;
    }
    const normalizedLiteral = `'${escSql(normalized)}'`;
    return `(${rawCheck} OR (${hasMarkerSql(rawColumn)} AND ` +
        `instr(${fold(stripMarkerSql(rawColumn))}, ${fold(normalizedLiteral)}) > 0))`;
}

/**
 * 正则预筛。groups 外层是或、内层是且。
 * 返回 null 表示查询失败，调用方应退回全文抽块。
 * 正文查询还会带上嵌入块，以及含行内公式的块：这些正文不一定出现在 content 里。
 */
export async function fetchLiteralGroupCandidateIds(
    rootId: string,
    groups: RegexPrefilterAtom[][],
    caseSensitive: boolean,
    kind: "content" | "memo" | "imageTitle",
    signal?: AbortSignal,
    includeCodeLanguage = true,
): Promise<string[] | null> {
    if (kind === "memo") {
        // 正则的必现字面量同样不能安全地在带 HTML 的 Memo 原文上预筛。
        return fetchMemoCandidateIds(rootId, signal);
    }
    if (groups.length === 0) {
        return [];
    }
    const root = escSql(rootId);
    let rawColumn = "content";
    let scope = `AND type NOT IN (${CONTAINER_SQL}) `;
    // ExportNodeStdMd 将行级公式导出成 $…$，不会保留 inline-math DOM 属性。
    // 公式可见字形不一定出现在 content 中（如 \\delta → δ），候选必须保留宿主。
    let extra = " OR type IN ('query_embed', 'm') OR instr(markdown, 'inline-math') > 0 OR instr(markdown, '$') > 0";
    if (kind === "imageTitle") {
        rawColumn = "markdown";
        scope = "AND instr(markdown, 'protyle-action__title') > 0 ";
        extra = "";
    }
    const predicate = literalGroupPredicate(groups, rawColumn, caseSensitive);
    if (kind === "content" && includeCodeLanguage) {
        extra += ` OR ${codeLanguageCandidatePredicate(literalGroupPredicate(groups, CODE_FENCE_SQL, caseSensitive))}`;
    }
    const rows = await querySqlAll<{id: string;}>((afterId, limit) => {
        const after = afterId ? `AND id > '${escSql(afterId)}' ` : "";
        return `SELECT id FROM blocks WHERE root_id = '${root}' ` +
            scope +
            after +
            `AND (${predicate}${extra}) ` +
            `ORDER BY id LIMIT ${limit}`;
    }, signal);
    if (!rows) {
        return null;
    }
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id);
}

export async function fetchImageTitleCandidateIds(
    rootId: string,
    needle: string,
    caseSensitive: boolean,
    signal?: AbortSignal,
): Promise<string[] | null> {
    if (!caseSensitive && !searchNormalizeFoldIsSuperset(needle)) {
        return queryScopedCandidates(
            rootId,
            "AND instr(markdown, 'protyle-action__title') > 0 ",
            signal,
        );
    }
    return queryLiteralCandidates(
        rootId,
        "AND instr(markdown, 'protyle-action__title') > 0 ",
        literalCandidatePredicate("markdown", needle, caseSensitive),
        signal,
    );
}

const HASH_ID_CHUNK = 400;

/** 直接读当前哈希，不走文档元数据缓存。查询失败返回 null。 */
export async function fetchBlockHashes(ids: string[], signal?: AbortSignal): Promise<Map<string, string> | null> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        unique.push(id);
    }
    const hashes = new Map<string, string>();
    if (unique.length === 0) {
        return hashes;
    }
    for (let index = 0; index < unique.length; index += HASH_ID_CHUNK) {
        if (signal?.aborted) {
            return null;
        }
        const list = unique.slice(index, index + HASH_ID_CHUNK)
            .map((id) => `'${escSql(id)}'`)
            .join(", ");
        const rows = await querySql<{id?: string; hash?: string;}>(
            `SELECT id, hash FROM blocks WHERE id IN (${list})`,
            signal,
        );
        if (!rows) {
            return null;
        }
        for (const row of rows) {
            if (!row.id) {
                continue;
            }
            hashes.set(row.id, String(row.hash ?? ""));
        }
    }
    return hashes;
}

export function isSpecialRenderType(type: string, subtype: string): boolean {
    if (type === "html" || type === "m") {
        return true;
    }
    if (type === "c" && isDiagramCodeLanguage(subtype)) {
        return true;
    }
    return false;
}

export function isDiagramBlock(type: string, subtype: string): boolean {
    return type === "c" && isDiagramCodeLanguage(subtype);
}

export function isEmbedType(type: string): boolean {
    return type === "query_embed";
}

export function isAttributeViewType(type: string): boolean {
    return type === "av";
}

export function shouldSkipAsContainer(type: string): boolean {
    return isContainerType(type);
}
