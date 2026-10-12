import type {Protyle} from "siyuan";
import {fetchSyncPost} from "siyuan";
import {isValidDocTitle, sanitizeDocTitle} from "../shared";
import {
    DOC_TITLE_BLOCK_ID,
    isDocTitleSearchUnit,
    resolveDocTitleInput,
} from "./blocks";
import type {SearchMatch} from "./dom-types";
import {
    applyReplacementsToString,
    type ApplyReplacementOptions,
    type ReplacementSpec,
} from "./replacement";

export interface DocTitleReplaceResult {
    replacedCount: number;
    skippedCount: number;
    error?: string;
    /** 内核返回的 msg，便于提示 */
    detail?: string;
}

export {isValidDocTitle, sanitizeDocTitle};

export function isDocTitleMatch(
    match: Pick<SearchMatch, "blockId" | "blockType" | "unitId">,
): boolean {
    return isDocTitleSearchUnit(match)
        || match.blockId === DOC_TITLE_BLOCK_ID;
}

/**
 * getAllEditor() 返回的是 Protyle 包装类；notebookId / path / disabled / rootID
 * 在内层 `protyle.protyle`（IProtyle）上。
 */
function resolveInnerProtyle(protyle: Protyle): {
    disabled: boolean;
    notebookId: string;
    path: string;
    rootId: string;
} {
    const inner = protyle?.protyle;
    return {
        disabled: Boolean(inner?.disabled),
        notebookId: String(inner?.notebookId ?? "").trim(),
        path: String(inner?.path ?? "").trim(),
        rootId: String(inner?.block?.rootID ?? "").trim(),
    };
}

/**
 * 对齐 Title.rename：只做 replaceFileName 级清洗，空串原样交给 renameDoc。
 * 内核 renameDoc0：空 title → Conf.Language(16) + custom-sy-title-empty；
 * 前端 setTitle(title, empty=true) 把输入框显示为空（placeholder），不写死「未命名」字面量。
 */
function finalizeDocTitleForApi(raw: string): string | null {
    const title = sanitizeDocTitle(raw);
    if (!isValidDocTitle(title)) {
        return null;
    }
    return title;
}

/** 空标题时 UI 显示空串，与 Title.setTitle(..., empty=true) 一致 */
function applyTitleInputDom(titleInput: HTMLElement, apiTitle: string) {
    const display = apiTitle === "" ? "" : apiTitle;
    if ((titleInput.textContent ?? "") !== display) {
        titleInput.textContent = display;
    }
}

/**
 * 将标题命中合并为一次 rename（不考虑撤销）。
 * 优先 renameDocByID（只要 rootID）；否则回退 renameDoc(notebook+path)。
 */
export async function replaceDocTitleMatchesInEditor(
    edit: Element,
    protyle: Protyle,
    matches: SearchMatch[],
    replacementText: string,
    options: ApplyReplacementOptions = {},
): Promise<DocTitleReplaceResult> {
    const titleMatches = matches.filter(isDocTitleMatch);
    if (titleMatches.length === 0) {
        return {replacedCount: 0, skippedCount: 0};
    }

    const ctx = resolveInnerProtyle(protyle);
    if (ctx.disabled) {
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "readonly-or-preview",
        };
    }

    if (!ctx.rootId && (!ctx.notebookId || !ctx.path)) {
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "title-context-missing",
        };
    }

    const titleInput = resolveDocTitleInput(edit);
    if (!titleInput) {
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "title-missing",
        };
    }

    const haystack = titleInput.textContent ?? "";
    if (!haystack) {
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "title-missing",
        };
    }

    const specs: ReplacementSpec[] = titleMatches.map((match) => ({
        start: match.start,
        end: match.end,
        matchedText: match.matchedText,
        unitId: match.unitId,
    }));

    const outcome = applyReplacementsToString(
        haystack,
        specs,
        replacementText,
        options,
    );
    if (outcome.appliedCount === 0) {
        return {
            replacedCount: 0,
            skippedCount: Math.max(outcome.skippedCount, titleMatches.length),
            error: outcome.regexExpandFailedCount > 0
                ? "regex-expand-failed"
                : "apply-failed",
        };
    }

    const apiTitle = finalizeDocTitleForApi(outcome.text);
    if (apiTitle === null) {
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "title-invalid",
        };
    }

    // 与当前输入框可见内容相同则无需 rename（含已是空标题）
    if (apiTitle === haystack || (apiTitle === "" && !haystack.trim())) {
        applyTitleInputDom(titleInput, apiTitle);
        return {
            replacedCount: outcome.appliedCount,
            skippedCount: outcome.skippedCount,
        };
    }

    try {
        const response = ctx.rootId
            ? await fetchSyncPost("/api/filetree/renameDocByID", {
                id: ctx.rootId,
                title: apiTitle,
            })
            : await fetchSyncPost("/api/filetree/renameDoc", {
                notebook: ctx.notebookId,
                path: ctx.path,
                title: apiTitle,
            });
        if (response?.code !== 0) {
            console.warn("[page-search] renameDoc failed", response);
            return {
                replacedCount: 0,
                skippedCount: titleMatches.length,
                error: "title-rename-failed",
                detail: typeof response?.msg === "string" && response.msg.trim()
                    ? response.msg.trim()
                    : undefined,
            };
        }
    } catch (error) {
        console.warn("[page-search] renameDoc threw", error);
        return {
            replacedCount: 0,
            skippedCount: titleMatches.length,
            error: "title-rename-failed",
        };
    }

    // 空标题：输入框置空（placeholder）；非空：写入清洗后标题。随后 rename 事件会再刷新。
    applyTitleInputDom(titleInput, apiTitle);

    return {
        replacedCount: outcome.appliedCount,
        skippedCount: outcome.skippedCount,
    };
}
