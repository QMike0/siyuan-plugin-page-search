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
