import {escSql, querySql} from "./api";
import {isContainerType} from "./meta";

const CONTAINER_SQL = ["d", "l", "i", "b", "s", "mindmap", "mindmap_item"].map((type) => `'${type}'`).join(", ");

function needleLiteral(needle: string, caseSensitive: boolean): {haystack: string; lit: string} {
    return {
        haystack: caseSensitive ? "content" : "lower(content)",
        lit: escSql(caseSensitive ? needle : needle.toLowerCase()),
    };
}

const SQL_CANDIDATE_LIMIT = 100000;

/** 一次查出候选。失败返回空数组，不把整次搜索打成「只搜已加载」。 */
export async function fetchContentCandidateIds(
    rootId: string,
    needle: string,
    caseSensitive: boolean,
): Promise<string[]> {
    const root = escSql(rootId);
    const {haystack, lit} = needleLiteral(needle, caseSensitive);
    const rows = await querySql<{id: string}>(
        `SELECT id FROM blocks WHERE root_id = '${root}' `
        + `AND type NOT IN (${CONTAINER_SQL}) `
        + `AND instr(${haystack}, '${lit}') > 0 `
        + `LIMIT ${SQL_CANDIDATE_LIMIT}`,
    );
    if (!rows) {
        return [];
    }
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id);
}

export async function fetchMemoCandidateIds(
    rootId: string,
    needle: string,
    caseSensitive: boolean,
): Promise<string[]> {
    const root = escSql(rootId);
    const lit = escSql(caseSensitive ? needle : needle.toLowerCase());
    const column = caseSensitive ? "markdown" : "lower(markdown)";
    const rows = await querySql<{id: string}>(
        `SELECT id FROM blocks WHERE root_id = '${root}' `
        + `AND instr(markdown, 'data-inline-memo-content') > 0 `
        + `AND instr(${column}, '${lit}') > 0 `
        + `LIMIT ${SQL_CANDIDATE_LIMIT}`,
    );
    if (!rows) {
        return [];
    }
    return rows.map((row) => row.id).filter(Boolean);
}

function literalGroupPredicate(groups: string[][], column: string, caseSensitive: boolean): string {
    const parts = groups.map((group) => {
        const checks = group.map((literal) => {
            const lit = escSql(caseSensitive ? literal : literal.toLowerCase());
            return `instr(${column}, '${lit}') > 0`;
        });
        return checks.length === 1 ? checks[0] : `(${checks.join(" AND ")})`;
    });
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * 正则预筛。groups 外层是或、内层是且。
 * 返回 null 表示查询失败，调用方应退回全文抽块。
 * 正文查询还会带上嵌入块，以及含行内公式的块：这些正文不一定出现在 content 里。
 */
export async function fetchLiteralGroupCandidateIds(
    rootId: string,
    groups: string[][],
    caseSensitive: boolean,
    kind: "content" | "memo" | "imageTitle",
): Promise<string[] | null> {
    if (groups.length === 0) {
        return [];
    }
    const root = escSql(rootId);
    const lowered = !caseSensitive;
    let column = lowered ? "lower(content)" : "content";
    let scope = `AND type NOT IN (${CONTAINER_SQL}) `;
    let extra = " OR type = 'query_embed' OR instr(markdown, 'inline-math') > 0";
    if (kind === "memo") {
        column = lowered ? "lower(markdown)" : "markdown";
        scope = "AND instr(markdown, 'data-inline-memo-content') > 0 ";
        extra = "";
    } else if (kind === "imageTitle") {
        column = lowered ? "lower(markdown)" : "markdown";
        scope = "AND instr(markdown, 'protyle-action__title') > 0 ";
        extra = "";
    }
    const predicate = literalGroupPredicate(groups, column, caseSensitive);
    const rows = await querySql<{id: string}>(
        `SELECT id FROM blocks WHERE root_id = '${root}' `
        + scope
        + `AND (${predicate}${extra}) `
        + `LIMIT ${SQL_CANDIDATE_LIMIT}`,
    );
    if (!rows) {
        return null;
    }
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id);
}

export async function fetchImageTitleCandidateIds(
    rootId: string,
    needle: string,
    caseSensitive: boolean,
): Promise<string[]> {
    const root = escSql(rootId);
    const lit = escSql(caseSensitive ? needle : needle.toLowerCase());
    const column = caseSensitive ? "markdown" : "lower(markdown)";
    const rows = await querySql<{id: string}>(
        `SELECT id FROM blocks WHERE root_id = '${root}' `
        + `AND instr(markdown, 'protyle-action__title') > 0 `
        + `AND instr(${column}, '${lit}') > 0 `
        + `LIMIT ${SQL_CANDIDATE_LIMIT}`,
    );
    if (!rows) {
        return [];
    }
    return rows.map((row) => row.id).filter(Boolean);
}

export function isSpecialRenderType(type: string, subtype: string): boolean {
    if (type === "html" || type === "m") {
        return true;
    }
    if (type === "c" && (
        subtype === "mermaid"
        || subtype === "flowchart"
        || subtype === "graphviz"
        || subtype === "plantuml"
        || subtype === "chart"
        || subtype === "mindmap"
        || subtype === "abc"
    )) {
        return true;
    }
    return false;
}

export function isDiagramBlock(type: string, subtype: string): boolean {
    return type === "c" && (
        subtype === "mermaid"
        || subtype === "flowchart"
        || subtype === "graphviz"
        || subtype === "plantuml"
        || subtype === "chart"
        || subtype === "mindmap"
        || subtype === "abc"
    );
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
