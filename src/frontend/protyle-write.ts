import type {IOperation, Protyle} from "siyuan";
import {getAllEditor} from "siyuan";
import {ATTRIBUTE_VIEW_TYPE, isPreviewSyntheticBlock, isPreviewSyntheticBlockId} from "./blocks";
import {collectSearchableBlocks} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import type {SearchMatch} from "./dom-types";
import {
    isDocTitleMatch,
    replaceDocTitleMatchesInEditor,
} from "./doc-title-replace";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {
    applyMatchesToLiveUnits,
    applyMatchesToSubmitClone,
} from "./replacement";
import {unitKey} from "./selection";

const DOC_TITLE_BLOCK_ID = "__doc-title__";

export interface ReplaceWriteOptions {
    preserveCase?: boolean;
    /** 正则查找：替换串展开 $1 等 */
    regex?: boolean;
    searchQuery?: string;
    caseSensitive?: boolean;
}

export interface ReplaceWriteResult {
    replacedCount: number;
    skippedCount: number;
    error?: string;
    /** 透传标题 rename 等失败时的内核 msg */
    detail?: string;
}

/**
 * 从搜索条挂载的 edit 容器解析对应 Protyle 实例。
 * 拿不到则拒绝写回（不静默 updateBlock）。
 */
function resolveProtyleFromEdit(edit: Element): Protyle | null {
    const protyleElement = edit.classList.contains("protyle")
        ? edit as HTMLElement
        : edit.querySelector<HTMLElement>(".protyle:not(.fn__none)")
            ?? edit.closest(".protyle");

    if (!protyleElement) {
        return null;
    }

    const editors = getAllEditor();
    const matched = editors.find((editor) => {
        const el = editor?.protyle?.element;
        return el === protyleElement || (el instanceof Element && (
            el.contains(protyleElement) || protyleElement.contains(el)
        ));
    });
    return matched ?? null;
}

function resolveSubmitBlockElement(
    edit: Element,
    blockId: string,
): HTMLElement | null {
    if (!blockId || blockId === DOC_TITLE_BLOCK_ID) {
        return null;
    }
    const root = edit.classList.contains("protyle")
        ? edit
        : edit.querySelector(".protyle:not(.fn__none)") ?? edit;

    const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"][data-type]`),
    ).filter((el) => !el.closest(".protyle-attr, .fn__none"));

    if (!candidates.length) {
        return root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    }

    // 优先已渲染 / 内容更完整的实例（与 blocks 采集一致）
    return candidates.reduce((best, current) => {
        const bestRendered = best.getAttribute("data-render") === "true";
        const currentRendered = current.getAttribute("data-render") === "true";
        if (currentRendered !== bestRendered) {
            return currentRendered ? current : best;
        }
        return (current.textContent?.length ?? 0) > (best.textContent?.length ?? 0)
            ? current
            : best;
    });
}

/**
 * 是否可写回。判别顺序：
 * 1) 发布服务 / 导出预览 / 只读模式
 * 2) 命中自身 replaceable（已含数据库、公式等；文档标题在 pipeline 中可标 true）
 * 3) 预览合成块兜底
 */
export function isMatchWritable(
    edit: Element,
    match: Pick<SearchMatch, "replaceable" | "blockType" | "blockId" | "unitId">,
): boolean {
    if (isEditorReplaceModeBlocked(edit)) {
        return false;
    }
    if (!match.replaceable) {
        return false;
    }
    if (match.blockType === ATTRIBUTE_VIEW_TYPE) {
        return false;
    }
    if (isPreviewSyntheticBlockId(match.blockId)) {
        return false;
    }
    return true;
}

function buildUnitMap(blocks: SearchableBlock[]): Map<string, SearchableBlock> {
    const map = new Map<string, SearchableBlock>();
    for (const block of blocks) {
        map.set(unitKey(block.blockId, block.unitId), block);
    }
    return map;
}

function replaceOptionsFrom(
    options: ReplaceWriteOptions,
): {
    preserveCase?: boolean;
    regex?: boolean;
    searchQuery?: string;
    caseSensitive?: boolean;
} {
    return {
        preserveCase: options.preserveCase,
        regex: options.regex,
        searchQuery: options.searchQuery,
        caseSensitive: options.caseSensitive,
    };
}

/**
 * 替换单次命中。
 * - 正文：live DOM + updateTransactionElement（可 Ctrl+Z）
 * - 文档标题：renameDoc（不考虑撤销）
 */
export async function replaceCurrentMatchInEditor(
    edit: Element,
    match: SearchMatch,
    replacementText: string,
    options: ReplaceWriteOptions = {},
): Promise<ReplaceWriteResult> {
    if (isEditorReplaceModeBlocked(edit)) {
        return {replacedCount: 0, skippedCount: 1, error: "readonly-or-preview"};
    }
    if (!isMatchWritable(edit, match)) {
        return {replacedCount: 0, skippedCount: 1};
    }

    const protyle = resolveProtyleFromEdit(edit);
    if (!protyle) {
        return {replacedCount: 0, skippedCount: 1, error: "protyle-missing"};
    }
    if (protyle.protyle?.disabled) {
        return {replacedCount: 0, skippedCount: 1, error: "readonly-or-preview"};
    }

    if (isDocTitleMatch(match)) {
        return replaceDocTitleMatchesInEditor(
            edit,
            protyle,
            [match],
            replacementText,
            replaceOptionsFrom(options),
        );
    }

    const submit = resolveSubmitBlockElement(edit, match.blockId);
    if (!submit) {
        return {replacedCount: 0, skippedCount: 1, error: "block-missing"};
    }

    const blocks = collectSearchableBlocks(edit, {includeInlineMemo: true})
        .filter((block) => !isPreviewSyntheticBlock(block));
    const unitsByKey = buildUnitMap(blocks);
    const unit = unitsByKey.get(unitKey(match.blockId, match.unitId));
    if (!unit) {
        return {replacedCount: 0, skippedCount: 1, error: "unit-missing"};
    }

    const oldHTML = submit.outerHTML;
    const outcome = applyMatchesToLiveUnits(
        unitsByKey,
        [match],
        replacementText,
        replaceOptionsFrom(options),
    );
    if (outcome.appliedCount === 0) {
        return {
            replacedCount: 0,
            skippedCount: Math.max(1, outcome.skippedCount),
            error: outcome.regexExpandFailedCount > 0
                ? "regex-expand-failed"
                : "apply-failed",
        };
    }

    try {
        protyle.updateTransactionElement(submit, oldHTML);
    } catch (error) {
        console.warn("[page-search] updateTransactionElement failed", error);
        return {replacedCount: 0, skippedCount: 1, error: "transaction-failed"};
    }

    return {
        replacedCount: outcome.appliedCount,
        skippedCount: outcome.skippedCount,
    };
}

/**
 * 全部替换：标题命中单独 rename；正文按块合并为一批 transaction。
 */
export async function replaceAllMatchesInEditor(
    edit: Element,
    matches: SearchMatch[],
    replacementText: string,
    options: ReplaceWriteOptions = {},
): Promise<ReplaceWriteResult> {
    if (isEditorReplaceModeBlocked(edit)) {
        return {replacedCount: 0, skippedCount: matches.length, error: "readonly-or-preview"};
    }

    const protyle = resolveProtyleFromEdit(edit);
    if (!protyle) {
        return {replacedCount: 0, skippedCount: matches.length, error: "protyle-missing"};
    }
    if (protyle.protyle?.disabled) {
        return {replacedCount: 0, skippedCount: matches.length, error: "readonly-or-preview"};
    }

    const replaceOpts = replaceOptionsFrom(options);
    const titleMatches: SearchMatch[] = [];
    const bodyMatches: SearchMatch[] = [];
    let skippedCount = 0;

    for (const match of matches) {
        if (!isMatchWritable(edit, match)) {
            skippedCount += 1;
            continue;
        }
        if (isDocTitleMatch(match)) {
            titleMatches.push(match);
        } else {
            bodyMatches.push(match);
        }
    }

    let replacedCount = 0;
    let firstError: string | undefined;
    let firstDetail: string | undefined;

    if (titleMatches.length > 0) {
        const titleResult = await replaceDocTitleMatchesInEditor(
            edit,
            protyle,
            titleMatches,
            replacementText,
            replaceOpts,
        );
        replacedCount += titleResult.replacedCount;
        skippedCount += titleResult.skippedCount;
        if (titleResult.error && titleResult.replacedCount === 0) {
            firstError = titleResult.error;
            firstDetail = titleResult.detail;
        }
    }

    if (bodyMatches.length === 0) {
        return {
            replacedCount,
            skippedCount,
            error: replacedCount === 0 ? firstError : undefined,
            detail: replacedCount === 0 ? firstDetail : undefined,
        };
    }

    const blocks = collectSearchableBlocks(edit, {includeInlineMemo: true})
        .filter((block) => !isPreviewSyntheticBlock(block));
    const unitsByKey = buildUnitMap(blocks);

    const grouped = new Map<string, SearchMatch[]>();
    for (const match of bodyMatches) {
        const list = grouped.get(match.blockId) ?? [];
        list.push(match);
        grouped.set(match.blockId, list);
    }

    const doOperations: IOperation[] = [];
    const undoOperations: IOperation[] = [];

    for (const [blockId, blockMatches] of grouped) {
        const submit = resolveSubmitBlockElement(edit, blockId);
        if (!submit) {
            skippedCount += blockMatches.length;
            continue;
        }

        const oldHTML = submit.outerHTML;
        const clone = submit.cloneNode(true) as HTMLElement;
        const outcome = applyMatchesToSubmitClone(
            submit,
            clone,
            unitsByKey,
            blockMatches,
            replacementText,
            replaceOpts,
        );
        if (outcome.appliedCount === 0) {
            skippedCount += outcome.skippedCount || blockMatches.length;
            continue;
        }

        doOperations.push({action: "update", id: blockId, data: clone.outerHTML});
        undoOperations.push({action: "update", id: blockId, data: oldHTML});
        replacedCount += outcome.appliedCount;
        skippedCount += outcome.skippedCount;
    }

    if (doOperations.length === 0) {
        return {
            replacedCount,
            skippedCount,
            error: replacedCount === 0 ? firstError : undefined,
            detail: replacedCount === 0 ? firstDetail : undefined,
        };
    }

    try {
        protyle.transaction(doOperations, undoOperations);
    } catch (error) {
        console.warn("[page-search] transaction failed", error);
        // 标题可能已 rename 成功：保留已替换计数，正文计为跳过
        return {
            replacedCount,
            skippedCount: skippedCount + bodyMatches.length,
            error: "transaction-failed",
        };
    }

    return {replacedCount, skippedCount};
}
