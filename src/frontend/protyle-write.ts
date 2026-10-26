import type {
    IOperation,
    Protyle,
} from "siyuan";
import {errorDetails, logDebug, logError, logWarning} from "../shared/logger";
import {
    fetchSyncPost,
    getAllEditor,
} from "siyuan";
import {
    effectiveSearchQuery,
    logicalTableCells,
    tableHostOmitsRows,
} from "../shared";
import {
    ATTRIBUTE_VIEW_TYPE,
    isPreviewSyntheticBlock,
    isPreviewSyntheticBlockId,
} from "./blocks";
import {
    collectImageTitleSearchUnits,
    collectSearchableBlocks,
} from "./blocks";
import {extractUnitsFromDoms} from "./corpus/extract";
import {
    editorRootId,
    invalidateEditedDocument,
} from "./corpus/search";
import {isDocTitleMatch} from "./doc-title-replace";
import type {SearchableBlock} from "./dom-types";
import type {SearchMatch} from "./dom-types";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import type {RegexTextMatcher} from "./regex-matcher";
import {
    applyMatchesToLiveUnits,
    applyMatchesToSubmitClone,
    createReplacementUnitLookup,
    collectRegexReplacementRequests,
    createRegexReplacementPlan,
    prepareRichReplacementPlan,
    type ApplyReplacementOptions,
} from "./replacement";
import {
    confirmBlockUpdates,
    createCommitContentReader,
    type CommitObserver,
    type ReplaceCommitState,
} from "./replacement-commit";
import {unitKey} from "./selection";
import {createRegexBudget, REGEX_BUDGET_ERROR, type RegexBudget} from "../shared/regex-budget";

const DOC_TITLE_BLOCK_ID = "__doc-title__";

export interface ReplaceWriteOptions extends CommitObserver {
    preserveCase?: boolean;
    /** 正则查找：替换串展开 $1 等 */
    regex?: boolean;
    searchQuery?: string;
    caseSensitive?: boolean;
    /** 正则模板展开必须通过 SearchBar 的 Worker，禁止退回主线程 RegExp.exec。 */
    regexMatcher?: RegexTextMatcher;
    /** 查询/范围在异步准备期间改变时，提交前取消。 */
    isCurrent?: () => boolean;
}

export interface ReplaceWriteResult {
    replacedCount: number;
    skippedCount: number;
    /** 已验证目标，但 HTML 无变化，未提交事务。 */
    unchanged?: boolean;
    /** 单处替换实际写入区间的终点，用于定位原来的下一目标。 */
    replacementEnd?: number;
    /** Only confirmed content contributes to replacedCount after a submitted write. */
    commitState?: ReplaceCommitState;
    submittedCount?: number;
    error?: string;
    /** 透传标题 rename 等失败时的内核 msg */
    detail?: string;
}

/**
 * 从搜索条挂载的 edit 容器解析对应 Protyle 实例。
 * 拿不到则拒绝写回（不静默 updateBlock）。
 */
function resolveProtyleFromEdit(edit: Element): Protyle | null {
    const protyleElement = edit.classList.contains("protyle") ?
        edit as HTMLElement :
        edit.querySelector<HTMLElement>(".protyle:not(.fn__none)") ??
            edit.closest(".protyle");

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
    const root = edit.classList.contains("protyle") ?
        edit :
        edit.querySelector(".protyle:not(.fn__none)") ?? edit;

    const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"][data-type]`),
    ).filter((el) => !el.closest(".protyle-attr, .fn__none, .protyle-wysiwyg__embed"));

    if (!candidates.length) {
        return Array.from(root.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`))
            .find((el) => !el.closest(".protyle-attr, .fn__none, .protyle-wysiwyg__embed")) ?? null;
    }

    // 优先已渲染 / 内容更完整的实例（与 blocks 采集一致）
    return candidates.reduce((best, current) => {
        const bestRendered = best.getAttribute("data-render") === "true";
        const currentRendered = current.getAttribute("data-render") === "true";
        if (currentRendered !== bestRendered) {
            return currentRendered ? current : best;
        }
        return (current.textContent?.length ?? 0) > (best.textContent?.length ?? 0) ?
            current :
            best;
    });
}

function resolveSubmitBlockElements(
    edit: Element,
    blockId: string,
): HTMLElement[] {
    if (!blockId || blockId === DOC_TITLE_BLOCK_ID) {
        return [];
    }
    const root = edit.classList.contains("protyle") ?
        edit :
        edit.querySelector(".protyle:not(.fn__none)") ?? edit;
    const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"][data-type]`),
    ).filter((el) => !el.closest(".protyle-attr, .fn__none"));
    if (candidates.length) {
        return candidates;
    }
    const fallback = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    return fallback ? [fallback] : [];
}

interface SubmitBlockIndex {
    all: Map<string, HTMLElement[]>;
    preferred: Map<string, HTMLElement>;
}

/** Index live block nodes once for replace-all; per-id DOM queries become quadratic at document scale. */
function collectSubmitBlockIndex(edit: Element): SubmitBlockIndex {
    const root = edit.classList.contains("protyle") ?
        edit :
        edit.querySelector<HTMLElement>(".protyle:not(.fn__none)") ?? edit;
    const all = new Map<string, HTMLElement[]>();
    const typed = new Map<string, HTMLElement[]>();
    root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
        const id = element.getAttribute("data-node-id");
        if (!id) {
            return;
        }
        const candidates = all.get(id);
        if (candidates) {
            candidates.push(element);
        } else {
            all.set(id, [element]);
        }
        if (element.hasAttribute("data-type") && !element.closest(".protyle-attr, .fn__none")) {
            const typedCandidates = typed.get(id);
            if (typedCandidates) {
                typedCandidates.push(element);
            } else {
                typed.set(id, [element]);
            }
        }
    });
    const preferred = new Map<string, HTMLElement>();
    all.forEach((candidates, id) => {
        const typedCandidates = typed.get(id);
        const usable = typedCandidates?.length ? typedCandidates : candidates.slice(0, 1);
        all.set(id, usable);
        // Retain displayed copies for native sync/rollback, but prepare writes
        // from the document source. Embedded units have a different search owner.
        const sourceCandidates = usable.filter((element) => !element.closest(".protyle-wysiwyg__embed"));
        if (!sourceCandidates.length) return;
        const best = sourceCandidates.reduce((current, candidate) => {
            const currentRendered = current.getAttribute("data-render") === "true";
            const candidateRendered = candidate.getAttribute("data-render") === "true";
            if (currentRendered !== candidateRendered) {
                return candidateRendered ? candidate : current;
            }
            return (candidate.textContent?.length ?? 0) > (current.textContent?.length ?? 0) ? candidate : current;
        });
        if (best) preferred.set(id, best);
    });
    return {all, preferred};
}

function selectionStartIn(element: Element, start: Node): boolean {
    return element === start || element.contains(start);
}

/**
 * promiseTransaction skips every update element containing the current selection,
 * including selected children and all changed ancestors. Return all such copies so
 * a replace-all can keep the live DOM in sync without replacing the selected nodes.
 */
function selectedChangedBlocks(
    edit: Element,
    blockIds: ReadonlySet<string>,
    index: SubmitBlockIndex,
): Map<string, HTMLElement[]> {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return new Map();
    const start = selection.getRangeAt(0).startContainer;
    const selected = new Map<string, HTMLElement[]>();
    for (const id of blockIds) {
        const elements = (index.all.get(id) ?? []).filter((element) =>
            edit.contains(element) && selectionStartIn(element, start)
        );
        if (elements.length) selected.set(id, elements);
    }
    return selected;
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
    return !isEditorReplaceModeBlocked(edit) && isMatchContentWritable(match);
}

/** 统计当前搜索快照的可替命中；只检查一次编辑器模式，不重新采集块或准备事务。 */
export function countWritableMatches(edit: Element, matches: readonly SearchMatch[]): number {
    if (isEditorReplaceModeBlocked(edit)) return 0;
    let count = 0;
    for (const match of matches) {
        if (isMatchContentWritable(match)) count += 1;
    }
    return count;
}

export function isMatchContentWritable(
    match: Pick<SearchMatch, "replaceable" | "blockType" | "blockId" | "unitId">,
): boolean {
    if (!match.replaceable || match.unitId?.startsWith("embed:") || isDocTitleMatch(match)) {
        return false;
    }
    if (match.blockType === ATTRIBUTE_VIEW_TYPE || match.blockType === "NodeCustomBlock") {
        return false;
    }
    if (isPreviewSyntheticBlockId(match.blockId)) {
        return false;
    }
    return true;
}

function keepsBlockType(before: HTMLElement, after: HTMLElement): boolean {
    return (before.getAttribute("data-type") ?? "") === (after.getAttribute("data-type") ?? "");
}

/**
 * 子块写在容器内部的类型。标题不是：标题下的块是后续兄弟，内核 MoveFoldHeading 会在更新时把它们接回去。
 * 列表 / 引述 / 提示 / 超级块的折叠只是 CSS，正常时子块仍在 DOM 里。
 * 一旦界面上的这份 HTML 已经没有子块，不能拿它做 update，否则内核会卸掉折叠内容，撤销也找不到那些子块。
 * getBlockDOM 走 cleanRenderNode(node, false)，返回的是含折叠子块的完整 DOM。
 */
const FOLDED_CONTENT_CONTAINER_TYPES = new Set([
    "NodeList",
    "NodeListItem",
    "NodeBlockquote",
    "NodeCallout",
    "NodeSuperBlock",
]);

function foldedContainerOmitsChildBlocks(element: HTMLElement): boolean {
    if (element.getAttribute("fold") !== "1") {
        return false;
    }
    const type = element.getAttribute("data-type") ?? "";
    if (!FOLDED_CONTENT_CONTAINER_TYPES.has(type)) {
        return false;
    }
    return element.querySelector("[data-node-id]") === null;
}

/**
 * 思源大表把屏外行收进 data-sy-table-virtual-rows，界面上的 outerHTML 不是整张表。
 * 搜索这些表时用的是 getBlockDOM 的完整行，替换必须同一份，否则屏外单元格对不上，写回还会丢掉那些行。
 */
function editorTableOmitsRows(element: HTMLElement): boolean {
    const type = element.getAttribute("data-type") ?? "";
    if (type !== "NodeTable" && !element.classList.contains("table")) {
        return false;
    }
    if (tableHostOmitsRows(element)) {
        return true;
    }
    // 嵌套大表仍虚拟着时，外层界面 HTML 不是完整内容。替换必须走 getBlockDOM。
    return element.querySelector(
        "[data-sy-table-virtual-rows], [data-sy-table-virtual-columns], [data-sy-table-virtual-id]",
    ) !== null;
}

/** 通用事务不接受 lockType；块类型由替换前后的 DOM 检查保护。 */
function updateOperation(id: string, data: string): IOperation {
    return {action: "update", id, data};
}

function restoreOuterHtml(element: HTMLElement, html: string): void {
    const template = document.createElement("template");
    template.innerHTML = html;
    const restored = template.content.firstElementChild;
    if (restored && element.parentNode) {
        element.parentNode.replaceChild(restored, element);
    }
}

/** Restore only this call's optimistic content, never a newer edit or another editor. */
function captureLiveRollback(
    edit: Element,
    protyle: Protyle,
    updates: readonly PreparedBlockUpdate[],
    oldLiveHtml?: ReadonlyMap<HTMLElement, string>,
    submitIndex?: SubmitBlockIndex,
): () => void {
    const rootId = editorRootId(edit);
    const readContent = createCommitContentReader(protyle);
    const childPositions = new WeakMap<Element, Map<Element, number>>();
    const snapshots = updates.map((update) => {
        const elements = submitIndex ?
            submitIndex.all.get(update.id) ?? [] :
            resolveSubmitBlockElements(edit, update.id);
        return {
            id: update.id,
            expectedHTML: update.newHTML,
            entries: elements.map((element) => {
                // Native sync replaces elements in place. Keep each copy's position and old HTML together.
                const path: number[] = [];
                let current: Element | null = element;
                while (current && current !== edit) {
                    const parent: Element | null = current.parentElement;
                    if (!parent) break;
                    let positions = childPositions.get(parent);
                    if (!positions) {
                        positions = new Map(Array.from(parent.children, (child, index) => [child, index]));
                        childPositions.set(parent, positions);
                    }
                    path.push(positions.get(current)!);
                    current = parent;
                }
                return {element, path: path.reverse(), oldHTML: oldLiveHtml?.get(element) ?? element.outerHTML};
            }),
        };
    });
    return () => {
        if (!edit.isConnected || editorRootId(edit) !== rootId || resolveProtyleFromEdit(edit) !== protyle) return;
        // Restore children first, so a parent can match its submitted HTML with old children.
        for (let index = snapshots.length - 1; index >= 0; index -= 1) {
            const snapshot = snapshots[index];
            const expected = readContent(snapshot.expectedHTML);
            if (expected === undefined) continue;
            for (const entry of snapshot.entries) {
                let live: Element | undefined = entry.element;
                if (!edit.contains(live)) {
                    live = edit;
                    for (const position of entry.path) live = live?.children[position];
                }
                if (
                    live instanceof HTMLElement && live.getAttribute("data-node-id") === snapshot.id &&
                    live.outerHTML !== entry.oldHTML && readContent(live.outerHTML) === expected
                ) {
                    restoreOuterHtml(live, entry.oldHTML);
                }
            }
        }
    };
}
/** 合并父子目标的采集根，避免同一子树被重复遍历；缓存公共祖先以兼顾深层嵌套。 */
function replacementScopeRoots(targets: HTMLElement[]): HTMLElement[] {
    const roots = new Set(targets);
    const covered = new Map<Element, boolean>();
    return targets.filter((root) => {
        const ancestors: Element[] = [];
        let parent = root.parentElement;
        let hasTargetAncestor = false;
        while (parent) {
            if (roots.has(parent) || covered.get(parent) === true) {
                hasTargetAncestor = true;
                break;
            }
            if (covered.has(parent)) break;
            ancestors.push(parent);
            parent = parent.parentElement;
        }
        for (const ancestor of ancestors) covered.set(ancestor, hasTargetAncestor);
        return !hasTargetAncestor;
    });
}

function buildUnitMap(
    blocks: SearchableBlock[],
    matches: readonly Pick<SearchMatch, "blockId" | "unitId">[],
): Map<string, SearchableBlock> {
    const map = new Map<string, SearchableBlock>();
    for (const block of blocks) {
        // Renderer copies cannot ever be a write target, even if no source unit
        // survived collection. Missing source coverage must cancel preparation.
        if (block.matchSource === "projection") continue;
        const key = unitKey(block.blockId, block.unitId);
        const previous = map.get(key);
        // A tab label / mindmap canvas was skipped above, so a surviving entry
        // is already the authoritative source unit for this identity.
        if (!previous) {
            map.set(key, block);
        }
    }
    // Paragraph-disabled searches give captions separate unit IDs/offsets.
    // Reuse the same collector only for those owners, without a second DOM/API scan.
    const imageTitleIds = new Set(
        matches.filter((match) => match.unitId?.startsWith("image-title:"))
            .map((match) => match.blockId),
    );
    if (imageTitleIds.size) {
        for (const block of blocks) {
            if (!imageTitleIds.has(block.blockId)) continue;
            const owner = block.element.closest<HTMLElement>("[data-node-id][data-type]");
            if (!owner || owner.getAttribute("data-node-id") !== block.blockId) continue;
            for (const title of collectImageTitleSearchUnits(owner, block.blockId, block.blockIndex)) {
                map.set(unitKey(title.blockId, title.unitId), title);
            }
            imageTitleIds.delete(block.blockId);
            if (!imageTitleIds.size) break;
        }
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

type PreparedReplaceOptions = ApplyReplacementOptions;

/** 准备阶段的轻量检查：不扫描目标 DOM，也不序列化块内容。 */
function createPreparationGuard(
    edit: Element,
    protyle: Protyle,
    isCurrent?: () => boolean,
): () => string | undefined {
    const rootId = editorRootId(edit);
    return () => {
        if (isCurrent && !isCurrent()) return "stale-target";
        if (isEditorReplaceModeBlocked(edit) || protyle.protyle?.disabled) {
            return "readonly-or-preview";
        }
        if (!edit.isConnected || resolveProtyleFromEdit(edit) !== protyle || editorRootId(edit) !== rootId) {
            return "stale-target";
        }
        return undefined;
    };
}

/** 异步准备只能使用开始时的编辑器和目标；提交前同步复核，不能覆盖等待期间的新编辑。 */
function createWriteGuard(
    edit: Element,
    protyle: Protyle,
    blockIds: Iterable<string>,
    isCurrent?: () => boolean,
    submitIndex?: SubmitBlockIndex,
    allowMountContents?: ReadonlyMap<string, string>,
): (allowUnverifiedMount?: boolean) => string | undefined {
    const checkCurrent = createPreparationGuard(edit, protyle, isCurrent);
    const readMountContent = createCommitContentReader(protyle, {ignoreDynamicReferenceText: true});
    const snapshots = Array.from(blockIds, (id) => {
        const element = submitIndex ? submitIndex.preferred.get(id) ?? null : resolveSubmitBlockElement(edit, id);
        const html = element?.outerHTML;
        return {id, element, html};
    });
    return (allowUnverifiedMount = false) => {
        const conflict = checkCurrent();
        if (conflict) return conflict;
        // Re-index after each boundary; fetched targets may mount before their
        // kernel snapshot is read, but must match it at the final check.
        const currentIndex = submitIndex ? collectSubmitBlockIndex(edit) : undefined;
        for (const snapshot of snapshots) {
            const current = currentIndex ?
                currentIndex.preferred.get(snapshot.id) ?? null :
                resolveSubmitBlockElement(edit, snapshot.id);
            if (current !== snapshot.element) {
                if (snapshot.element === null && allowMountContents && current) {
                    const kernelHTML = allowMountContents.get(snapshot.id);
                    // The early guard runs before the first fetched read. No
                    // live write occurs until all fetched snapshots are populated.
                    if (kernelHTML === undefined && allowUnverifiedMount) continue;
                    if (kernelHTML === undefined) return "stale-target";
                    const expected = readMountContent(kernelHTML);
                    const actual = readMountContent(current.outerHTML);
                    if (expected !== undefined && actual !== undefined && actual === expected) {
                        continue;
                    }
                    return "stale-target";
                }
                return "stale-target";
            }
            if (current?.outerHTML !== snapshot.html) {
                return "stale-target";
            }
        }
        return undefined;
    };
}

/**
 * 把捕获组/命名组展开限制在 Worker。主线程只接收纯文本计划，随后仍逐处核对文本快照。
 * 计划失败时整次替换不写入，避免“部分替换 + 用户以为已全部完成”。
 */
async function prepareRegexReplaceOptions(
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "id" | "blockId" | "unitId" | "start" | "end" | "matchedText">>,
    replacementText: string,
    options: ReplaceWriteOptions,
    checkCurrent: () => string | undefined,
    budget?: RegexBudget,
): Promise<{options: PreparedReplaceOptions; error?: string;}> {
    const base = replaceOptionsFrom(options);
    const conflict = checkCurrent();
    if (conflict) return {options: base, error: conflict};
    if (!options.regex) {
        return {options: base};
    }
    const patternSource = effectiveSearchQuery(options.searchQuery ?? "");
    if (!patternSource || !options.regexMatcher) {
        return {options: base, error: "regex-expand-failed"};
    }
    const result = await options.regexMatcher.expandReplacements(
        collectRegexReplacementRequests(unitsByKey, matches),
        patternSource,
        replacementText,
        {
            caseSensitive: options.caseSensitive === true,
        },
        undefined,
        budget,
    );
    const afterExpandConflict = checkCurrent();
    if (afterExpandConflict) return {options: base, error: afterExpandConflict};
    if (result.cancelled || result.error) {
        return {options: base, error: result.error === REGEX_BUDGET_ERROR ? "regex-budget-exceeded" : "regex-expand-failed"};
    }
    return {
        options: {
            ...base,
            regexPlan: createRegexReplacementPlan(result.expansions),
        },
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
        return {replacedCount: 0, skippedCount: 1};
    }

    const checkCurrent = createPreparationGuard(edit, protyle, options.isCurrent);
    const preparationConflict = checkCurrent();
    if (preparationConflict) {
        return {replacedCount: 0, skippedCount: 1, error: preparationConflict};
    }
    const submit = resolveSubmitBlockElement(edit, match.blockId);
    const guard = createWriteGuard(edit, protyle, [match.blockId], options.isCurrent);
    if (!submit || foldedContainerOmitsChildBlocks(submit) || editorTableOmitsRows(submit)) {
        return replaceFetchedBlockMatches(
            protyle,
            match.blockId,
            [match],
            replacementText,
            options,
            edit,
            guard,
            checkCurrent,
        );
    }

    const blocks = collectSearchableBlocks(edit, {
        includeInlineMemo: true,
        includeImageTitle: true,
        includeDocTitle: false,
        includeMindmapSourceForReplace: true,
        scopeRoots: [submit],
    })
        .filter((block) => !isPreviewSyntheticBlock(block));
    const unitsByKey = buildUnitMap(blocks, [match]);
    const unit = createReplacementUnitLookup(unitsByKey)(match);
    if (!unit) {
        return {replacedCount: 0, skippedCount: 1, error: "unit-missing"};
    }
    const preparedOptions = await prepareRegexReplaceOptions(
        unitsByKey,
        [match],
        replacementText,
        options,
        checkCurrent,
    );
    if (preparedOptions.error) {
        return {replacedCount: 0, skippedCount: 1, error: preparedOptions.error};
    }
    const conflict = guard();
    if (conflict) {
        return {replacedCount: 0, skippedCount: 1, error: conflict};
    }

    const typeBefore = submit.getAttribute("data-type");
    const oldHTML = submit.outerHTML;
    const outcome = applyMatchesToLiveUnits(
        unitsByKey,
        [match],
        replacementText,
        preparedOptions.options,
    );
    if (outcome.appliedCount === 0) {
        return {
            replacedCount: 0,
            skippedCount: Math.max(1, outcome.skippedCount),
            error: outcome.regexExpandFailedCount > 0 ?
                "regex-expand-failed" :
                outcome.richCellFailedCount ? "rich-cell-unsafe" : "apply-failed",
        };
    }
    if ((submit.getAttribute("data-type") ?? "") !== (typeBefore ?? "")) {
        restoreOuterHtml(submit, oldHTML);
        return {replacedCount: 0, skippedCount: 1};
    }

    const update: PreparedBlockUpdate = {
        id: match.blockId,
        oldHTML,
        newHTML: submit.outerHTML,
        appliedCount: outcome.appliedCount,
    };
    // The replacement is already the same text. Native updateTransaction also skips this write.
    if (update.newHTML === oldHTML) {
        return {
            replacedCount: outcome.appliedCount,
            skippedCount: outcome.skippedCount,
            commitState: "confirmed",
            unchanged: true,
            replacementEnd: outcome.replacementEnd,
        };
    }
    const rootId = editorRootId(edit);
    const rollback = captureLiveRollback(edit, protyle, [update], new Map([[submit, oldHTML]]));
    try {
        protyle.updateTransactionElement(submit, oldHTML);
    } catch (error) {
        logError("updateTransactionElement failed", errorDetails(error));
        rollback();
        invalidateEditedDocument(rootId, [match.blockId]);
        return {replacedCount: 0, skippedCount: 1, error: "transaction-failed", commitState: "failed"};
    }

    const confirmation = await confirmBlockUpdates(protyle, [update], options);
    invalidateEditedDocument(rootId, [match.blockId]);
    return {
        ...confirmation,
        skippedCount: outcome.skippedCount,
        replacementEnd: outcome.replacementEnd,
    };
}

const BLOCK_DOM_BATCH_SIZE = 64;
/** Keep read pressure aligned with corpus extraction; writes remain one native transaction. */
const BLOCK_DOM_BATCH_CONCURRENCY = 4;

interface PreparedBlockUpdate {
    id: string;
    oldHTML: string;
    newHTML: string;
    appliedCount: number;
    replacementEnd?: number;
    /** Reuse the exact plan if a fetched block mounts with the editor selection. */
    replaceOptions?: PreparedReplaceOptions;
    /** 获取时的内核底稿，可能与并入未落盘虚拟表格后的 oldHTML 不同。 */
    kernelHTML?: string;
}

interface PreparedBlockResult {
    update: PreparedBlockUpdate | null;
    skippedCount: number;
    error?: string;
}

/**
 * 父块更新会整段换掉自己的 HTML。子块 id 还在这份 HTML 里时，子块必须排在后面，
 * 否则父块里的旧子树会盖掉子块刚刚写入的文本。
 * 无法证明包含关系时保持原顺序：未加载块在前、已加载块在后，和原先的提交顺序一致。
 */
function orderBlockUpdates(updates: PreparedBlockUpdate[]): PreparedBlockUpdate[] {
    if (updates.length < 2) {
        return updates;
    }
    const byId = new Map(updates.map((update) => [update.id, update]));
    const children = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const update of updates) {
        children.set(update.id, []);
        indegree.set(update.id, 0);
    }
    const idPattern = /data-node-id="([^"]+)"/g;
    for (const update of updates) {
        const seen = new Set<string>();
        idPattern.lastIndex = 0;
        let found: RegExpExecArray | null;
        while ((found = idPattern.exec(update.newHTML)) !== null) {
            const childId = found[1];
            if (!childId || childId === update.id || !byId.has(childId) || seen.has(childId)) {
                continue;
            }
            seen.add(childId);
            children.get(update.id)?.push(childId);
            indegree.set(childId, (indegree.get(childId) ?? 0) + 1);
        }
    }

    const pending = updates.filter((update) => (indegree.get(update.id) ?? 0) === 0);
    const ordered: PreparedBlockUpdate[] = [];
    const emitted = new Set<string>();
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
        const current = pending[cursor];
        if (emitted.has(current.id)) {
            continue;
        }
        emitted.add(current.id);
        ordered.push(current);
        for (const childId of children.get(current.id) ?? []) {
            const next = (indegree.get(childId) ?? 1) - 1;
            indegree.set(childId, next);
            if (next === 0) {
                const child = byId.get(childId);
                if (child) {
                    pending.push(child);
                }
            }
        }
    }
    for (const update of updates) {
        if (!emitted.has(update.id)) {
            ordered.push(update);
        }
    }
    return ordered;
}

async function prepareBlockElementUpdate(
    blockId: string,
    blockEl: HTMLElement,
    oldHTML: string,
    unitsByKey: Map<string, SearchableBlock>,
    matches: SearchMatch[],
    replacementText: string,
    replaceOpts: PreparedReplaceOptions,
    checkCurrent: () => string | undefined,
    retainRichPlan = false,
): Promise<PreparedBlockResult> {
    const rich = await prepareRichReplacementPlan(unitsByKey, matches, replacementText, replaceOpts, checkCurrent);
    const error = checkCurrent() ?? rich.error;
    if (error) return {update: null, skippedCount: matches.length, error};
    // Never reuse a plan from another DOM copy (notably fetched/selected copies).
    const preparedOptions = {...replaceOpts, richPlan: rich.plan};
    const clone = blockEl.cloneNode(true) as HTMLElement;
    const outcome = applyMatchesToSubmitClone(
        blockEl,
        clone,
        unitsByKey,
        matches,
        replacementText,
        preparedOptions,
    );
    if (outcome.richCellFailedCount) {
        return {update: null, skippedCount: matches.length, error: "rich-cell-unsafe"};
    }
    if (outcome.appliedCount === 0) {
        return {
            update: null,
            skippedCount: outcome.skippedCount || matches.length,
            error: outcome.regexExpandFailedCount > 0 ? "regex-expand-failed" : "apply-failed",
        };
    }
    if (!keepsBlockType(blockEl, clone)) {
        return {update: null, skippedCount: matches.length};
    }
    return {
        update: {
            id: blockId,
            oldHTML,
            newHTML: clone.outerHTML,
            appliedCount: outcome.appliedCount,
            replacementEnd: outcome.replacementEnd,
            replaceOptions: retainRichPlan ? preparedOptions : replaceOpts,
        },
        skippedCount: outcome.skippedCount,
    };
}

async function fetchBlockHtmlBatch(ids: string[], notebook = ""): Promise<Map<string, string>> {
    const htmlById = new Map<string, string>();
    let data: Record<string, string> | null = null;
    try {
        const response = await fetchSyncPost(
            "/api/block/getBlockDOMs",
            notebook ? {ids, notebook} : {ids},
        );
        if (response?.code === 0 && response.data && typeof response.data === "object") {
            data = response.data as Record<string, string>;
        }
    } catch {
        data = null;
    }
    if (!data) {
        return htmlById;
    }
    for (const id of ids) {
        const html = data[id];
        if (html) {
            htmlById.set(id, html);
        }
    }
    return htmlById;
}

const CELL_CONTENT_ATTRS = ["data-sy-table-cell-rich", "data-sy-table-cell-inline", "contenteditable"];

function cellPlainText(cell: HTMLElement): string {
    const editor = cell.querySelector(":scope > .table__cell-editor .protyle-wysiwyg");
    const root = editor instanceof HTMLElement ? editor : cell;
    return (root.textContent ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function copyMountedCell(target: HTMLElement, source: HTMLElement): void {
    target.innerHTML = source.innerHTML;
    for (let index = 0; index < CELL_CONTENT_ATTRS.length; index += 1) {
        const name = CELL_CONTENT_ATTRS[index];
        const value = source.getAttribute(name);
        if (value === null) {
            target.removeAttribute(name);
        } else {
            target.setAttribute(name, value);
        }
    }
}

/**
 * 把画面上已经改过、内核 HTML 还没跟上的格子抄进底稿。
 * 编辑器还开着并且文字已经不同时返回 false，调用方放弃这张表，避免把编辑器界面写进去。
 */
function overlayMountedVirtualCells(kernel: HTMLElement, live: HTMLElement): boolean {
    const liveCells = logicalTableCells(live);
    const kernelCells = logicalTableCells(kernel);
    if (!liveCells || !kernelCells) {
        return true;
    }
    for (const [position, liveCell] of liveCells) {
        const kernelCell = kernelCells.get(position);
        if (!kernelCell) {
            continue;
        }
        if (cellPlainText(liveCell) === cellPlainText(kernelCell) &&
            CELL_CONTENT_ATTRS.every(name => liveCell.getAttribute(name) === kernelCell.getAttribute(name))) {
            continue;
        }
        if (liveCell.querySelector(":scope > .table__cell-editor")) {
            return false;
        }
        copyMountedCell(kernelCell, liveCell);
    }
    return true;
}

function liveVirtualTable(root: ParentNode, blockId: string): HTMLElement | null {
    const nodes = root.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.closest("[data-page-search-offscreen], .protyle-wysiwyg__embed")) {
            continue;
        }
        if (editorTableOmitsRows(node)) {
            return node;
        }
    }
    return null;
}

/** 虚拟表用内核 HTML 做底稿前，先并入画面上未落盘的格子。冲突时 conflict 为 true。 */
function mergeKernelHtmlWithLiveTable(
    liveRoot: ParentNode | null,
    blockId: string,
    kernelHtml: string,
): {html: string; conflict: boolean;} {
    if (!liveRoot) {
        return {html: kernelHtml, conflict: false};
    }
    const live = liveVirtualTable(liveRoot, blockId);
    if (!live) {
        return {html: kernelHtml, conflict: false};
    }
    const template = document.createElement("template");
    template.innerHTML = kernelHtml;
    const kernel = template.content.firstElementChild;
    if (!(kernel instanceof HTMLElement)) {
        return {html: kernelHtml, conflict: false};
    }
    if (!overlayMountedVirtualCells(kernel, live)) {
        return {html: kernelHtml, conflict: true};
    }
    return {html: kernel.outerHTML, conflict: false};
}

async function prepareFetchedBlockUpdates(
    matchesById: Map<string, SearchMatch[]>,
    replacementText: string,
    options: ReplaceWriteOptions,
    liveRoot: ParentNode | null,
    checkCurrent: () => string | undefined,
    notebook = "",
    budget: RegexBudget | undefined = options.regex ? createRegexBudget() : undefined,
): Promise<{updates: PreparedBlockUpdate[]; skippedCount: number; error?: string; fatal?: boolean;}> {
    const ids = Array.from(matchesById.keys());
    const totalMatches = Array.from(matchesById.values()).reduce((count, items) => count + items.length, 0);
    const cancelled = (error: string) => ({updates: [], skippedCount: totalMatches, error, fatal: true});
    const updates: PreparedBlockUpdate[] = [];
    let skippedCount = 0;
    let error: string | undefined;
    if (ids.length === 0) {
        return {updates, skippedCount};
    }

    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += BLOCK_DOM_BATCH_SIZE) {
        batches.push(ids.slice(index, index + BLOCK_DOM_BATCH_SIZE));
    }
    // Reads are independent and read-only. Keep the wave bounded so a large
    // document does not serialize dozens of kernel renders or flood the API.
    for (let waveStart = 0; waveStart < batches.length; waveStart += BLOCK_DOM_BATCH_CONCURRENCY) {
        const conflict = checkCurrent();
        if (conflict) return cancelled(conflict);
        const wave = batches.slice(waveStart, waveStart + BLOCK_DOM_BATCH_CONCURRENCY);
        const htmlResults = await Promise.all(wave.map((batch) => fetchBlockHtmlBatch(batch, notebook)));
        const afterReadConflict = checkCurrent();
        if (afterReadConflict) return cancelled(afterReadConflict);
        for (let waveIndex = 0; waveIndex < wave.length; waveIndex += 1) {
            const batchConflict = checkCurrent();
            if (batchConflict) return cancelled(batchConflict);
            const batch = wave[waveIndex];
            const htmlById = htmlResults[waveIndex];
            const present: string[] = [];
            const doms: Record<string, string> = {};
            for (const id of batch) {
                const html = htmlById.get(id);
                const blockMatches = matchesById.get(id) ?? [];
                if (!html) {
                    skippedCount += blockMatches.length;
                    error ??= "block-missing";
                    continue;
                }
                const merged = mergeKernelHtmlWithLiveTable(liveRoot, id, html);
                if (merged.conflict) {
                    skippedCount += blockMatches.length;
                    error ??= "table-pending-edit";
                    continue;
                }
                present.push(id);
                doms[id] = merged.html;
            }
            if (present.length === 0) {
                continue;
            }

            let extracted: Awaited<ReturnType<typeof extractUnitsFromDoms>> | null = null;
            try {
                extracted = await extractUnitsFromDoms(
                    present,
                    doms,
                    {
                        includeInlineMemo: true,
                        includeImageTitle: true,
                        includeDocTitle: false,
                        includeMindmapSourceForReplace: true,
                    },
                    new Set(),
                    "none",
                    () => !checkCurrent(),
                );
            } catch (extractError) {
                const conflict = checkCurrent();
                if (conflict) return cancelled(conflict);
                logWarning("prepare unloaded replace failed", errorDetails(extractError));
                for (const id of present) {
                    skippedCount += matchesById.get(id)?.length ?? 0;
                }
                error ??= "block-missing";
                continue;
            }

            try {
                const conflict = checkCurrent();
                if (conflict) return cancelled(conflict);
                const batchMatches = present.flatMap((id) => matchesById.get(id) ?? []);
                const unitsByKey = buildUnitMap(extracted.blocks, batchMatches);
                const preparedOptions = await prepareRegexReplaceOptions(
                    unitsByKey,
                    batchMatches,
                    replacementText,
                    options,
                    checkCurrent,
                    budget,
                );
                const preparationError = checkCurrent() ?? preparedOptions.error;
                if (preparationError) return cancelled(preparationError);
                for (const id of present) {
                    const blockMatches = matchesById.get(id) ?? [];
                    const unit = extracted.blocks.find((block) => block.blockId === id);
                    const blockEl = unit?.element.closest<HTMLElement>(
                        `[data-node-id="${CSS.escape(id)}"]`,
                    ) ?? unit?.element ?? null;
                    if (!blockEl) {
                        skippedCount += blockMatches.length;
                        error ??= "block-missing";
                        continue;
                    }
                    const prepared = await prepareBlockElementUpdate(
                        id,
                        blockEl,
                        doms[id],
                        unitsByKey,
                        blockMatches,
                        replacementText,
                        preparedOptions.options,
                        checkCurrent,
                    );
                    const preparationConflict = checkCurrent();
                    if (preparationConflict) return cancelled(preparationConflict);
                    skippedCount += prepared.skippedCount;
                    if (prepared.update) {
                        prepared.update.kernelHTML = htmlById.get(id);
                        updates.push(prepared.update);
                    } else if (prepared.error) {
                        error ??= prepared.error;
                    }
                }
            } finally {
                extracted.dispose();
            }
        }
    }
    return {updates, skippedCount, error};
}

/**
 * 全部替换：文档标题不参与。
 * 正文不论是否已在编辑器里，都合成一笔 transaction。
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
    const notebook = protyle.protyle?.notebookId ?? "";

    const bodyMatches: SearchMatch[] = [];
    let skippedCount = 0;

    for (const match of matches) {
        if (!isMatchContentWritable(match)) {
            skippedCount += 1;
            continue;
        }
        bodyMatches.push(match);
    }

    let firstError: string | undefined;

    if (bodyMatches.length === 0) {
        return {
            replacedCount: 0,
            skippedCount,
            error: undefined,
        };
    }

    const checkCurrent = createPreparationGuard(edit, protyle, options.isCurrent);
    const preparationConflict = checkCurrent();
    if (preparationConflict) {
        return {replacedCount: 0, skippedCount: matches.length, error: preparationConflict};
    }
    const submitIndex = collectSubmitBlockIndex(edit);
    const fetchedMountContents = new Map<string, string>();

    const guard = createWriteGuard(
        edit,
        protyle,
        new Set(bodyMatches.map((match) => match.blockId)),
        options.isCurrent,
        submitIndex,
        fetchedMountContents,
    );

    const grouped = new Map<string, SearchMatch[]>();
    for (const match of bodyMatches) {
        const list = grouped.get(match.blockId) ?? [];
        list.push(match);
        grouped.set(match.blockId, list);
    }
    const unloadedMatches = new Map<string, SearchMatch[]>();
    const loadedMatches: SearchMatch[] = [];
    const loadedRoots: HTMLElement[] = [];
    for (const [blockId, blockMatches] of grouped) {
        const submit = submitIndex.preferred.get(blockId);
        // 折叠容器或缺行大表只准备内核底稿，避免同一命中重复展开、重复扣预算。
        if (!submit || foldedContainerOmitsChildBlocks(submit) || editorTableOmitsRows(submit)) {
            unloadedMatches.set(blockId, blockMatches);
        } else {
            loadedRoots.push(submit);
            for (const match of blockMatches) loadedMatches.push(match);
        }
    }

    // 空 scopeRoots 会回退到整篇采集；全部离屏时必须直接跳过 live 文本采集。
    const blocks = loadedRoots.length ?
        collectSearchableBlocks(edit, {
            includeInlineMemo: true,
            includeImageTitle: true,
            includeDocTitle: false,
            includeMindmapSourceForReplace: true,
            scopeRoots: replacementScopeRoots(loadedRoots),
        })
            .filter((block) => !isPreviewSyntheticBlock(block)) :
        [];
    const unitsByKey = buildUnitMap(blocks, loadedMatches);
    // 同一次全部替换共用输出预算，离屏/折叠区域的每个读取批次不能重新获得额度。
    const regexBudget = options.regex ? createRegexBudget() : undefined;
    const loadedOptions = await prepareRegexReplaceOptions(
        unitsByKey,
        loadedMatches,
        replacementText,
        options,
        checkCurrent,
        regexBudget,
    );
    if (loadedOptions.error) {
        return {
            replacedCount: 0,
            skippedCount: skippedCount + bodyMatches.length,
            error: loadedOptions.error,
        };
    }
    const loadedConflict = guard(true);
    if (loadedConflict) {
        logWarning("replace-all cancelled", {
            stage: "loaded-guard",
            error: loadedConflict,
            liveBlocks: submitIndex.preferred.size,
            matches: bodyMatches.length,
        });
        return {replacedCount: 0, skippedCount: matches.length, error: loadedConflict};
    }

    const skippedBeforeBody = skippedCount;
    const loadedUpdates: PreparedBlockUpdate[] = [];
    let bodySkipped = 0;

    for (const [blockId, blockMatches] of grouped) {
        if (unloadedMatches.has(blockId)) continue;
        const submit = submitIndex.preferred.get(blockId)!;
        const prepared = await prepareBlockElementUpdate(
            blockId,
            submit,
            submit.outerHTML,
            unitsByKey,
            blockMatches,
            replacementText,
            loadedOptions.options,
            checkCurrent,
        );
        const preparationConflict = checkCurrent();
        if (preparationConflict) return {replacedCount: 0, skippedCount: matches.length, error: preparationConflict};
        bodySkipped += prepared.skippedCount;
        if (prepared.update) {
            loadedUpdates.push(prepared.update);
        } else if (prepared.error) {
            firstError ??= prepared.error;
        }
    }

    const fetched = await prepareFetchedBlockUpdates(
        unloadedMatches,
        replacementText,
        options,
        edit,
        checkCurrent,
        notebook,
        regexBudget,
    );
    bodySkipped += fetched.skippedCount;
    const fetchedConflict = checkCurrent();
    if (fetchedConflict || fetched.fatal) {
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodyMatches.length,
            error: fetchedConflict ?? fetched.error,
        };
    }
    if (fetched.error) {
        firstError ??= fetched.error;
    }
    fetched.updates.forEach((update) => {
        if (update.kernelHTML !== undefined) fetchedMountContents.set(update.id, update.kernelHTML);
    });
    // 搜索时标为可替换的目标现在准备失败，说明快照已陈旧或覆盖丢失；全部替换不得部分提交。
    if (bodySkipped > 0) {
        logWarning("replace-all cancelled", {
            stage: "block-preparation",
            bodySkipped,
            firstError,
            loadedUpdates: loadedUpdates.length,
            fetchedUpdates: fetched.updates.length,
            unloadedIds: unloadedMatches.size,
        });
        return {replacedCount: 0, skippedCount: matches.length, error: firstError ?? "stale-target"};
    }

    const ordered = orderBlockUpdates([...fetched.updates, ...loadedUpdates]);
    if (ordered.length === 0) {
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodySkipped,
            error: firstError,
        };
    }

    const conflict = guard();
    if (conflict) {
        logWarning("replace-all cancelled", {
            stage: "final-guard",
            error: conflict,
            updates: ordered.length,
            fetched: fetched.updates.length,
        });
        return {replacedCount: 0, skippedCount: matches.length, error: conflict};
    }
    const changed = ordered.filter((update) => update.newHTML !== update.oldHTML);
    const unchangedCount = ordered.reduce(
        (count, update) => count + (update.newHTML === update.oldHTML ? update.appliedCount : 0),
        0,
    );
    if (!changed.length) {
        const kernelCurrent = await fetchedUpdatesUnchanged(fetched.updates, checkCurrent, notebook, protyle);
        const finalConflict = guard() ?? (kernelCurrent ? undefined : "stale-target");
        if (finalConflict) return {replacedCount: 0, skippedCount: matches.length, error: finalConflict};
        return {replacedCount: unchangedCount, skippedCount, commitState: "confirmed", unchanged: true};
    }
    const rootId = editorRootId(edit);
    const submitIndexBeforeCommit = collectSubmitBlockIndex(edit);
    const changedIds = new Set(changed.map((update) => update.id));
    const selectedBlocks = selectedChangedBlocks(edit, changedIds, submitIndexBeforeCommit);
    const liveRollbackHtml = new Map<HTMLElement, string>();
    const selectedPlans: Array<{
        element: HTMLElement;
        units: Map<string, SearchableBlock>;
        matches: SearchMatch[];
        appliedCount: number;
        options: PreparedReplaceOptions;
    }> = [];
    // Validate every selected copy before touching live content. Only complete
    // mounted fetched blocks may use the plan; missing rows/children stay guarded.
    for (const update of changed) {
        const selectedCopies = selectedBlocks.get(update.id);
        const selectedMatches = grouped.get(update.id);
        if (!selectedCopies?.length || !selectedMatches?.length) continue;
        if (
            update.kernelHTML !== undefined &&
            selectedCopies.some((element) => foldedContainerOmitsChildBlocks(element) || editorTableOmitsRows(element))
        ) {
            return {replacedCount: 0, skippedCount: matches.length, error: "stale-target"};
        }
        const replaceOptions = update.replaceOptions ?? loadedOptions.options;
        for (const selectedBlock of selectedCopies) {
            const localBlocks = collectSearchableBlocks(edit, {
                includeInlineMemo: true,
                includeImageTitle: true,
                includeDocTitle: false,
                includeMindmapSourceForReplace: true,
                scopeRoots: [selectedBlock],
            }).filter((block) => !isPreviewSyntheticBlock(block));
            const localUnits = buildUnitMap(localBlocks, selectedMatches);
            liveRollbackHtml.set(selectedBlock, selectedBlock.outerHTML);
            const prepared = await prepareBlockElementUpdate(
                update.id,
                selectedBlock,
                selectedBlock.outerHTML,
                localUnits,
                selectedMatches,
                replacementText,
                replaceOptions,
                checkCurrent,
                true,
            );
            if (prepared.update?.appliedCount !== update.appliedCount || prepared.skippedCount) {
                return {replacedCount: 0, skippedCount: matches.length, error: "stale-target"};
            }
            selectedPlans.push({
                element: selectedBlock,
                units: localUnits,
                matches: selectedMatches,
                appliedCount: update.appliedCount,
                options: prepared.update!.replaceOptions!,
            });
        }
    }
    // Async preparation may have yielded while selected copies were validated.
    // Re-read fetched authority and all live snapshots once, then publish and
    // submit without any further await. Never overwrite intervening edits.
    const kernelCurrent = await fetchedUpdatesUnchanged(fetched.updates, checkCurrent, notebook, protyle);
    const finalConflict = guard() ?? (kernelCurrent ? undefined : "stale-target");
    if (finalConflict || Array.from(liveRollbackHtml).some(([element, html]) =>
        !edit.contains(element) || element.outerHTML !== html)) {
        return {replacedCount: 0, skippedCount: matches.length, error: finalConflict ?? "stale-target"};
    }
    const currentSelected = selectedChangedBlocks(edit, changedIds, collectSubmitBlockIndex(edit));
    if (currentSelected.size !== selectedBlocks.size || Array.from(selectedBlocks).some(([id, copies]) =>
        copies.length !== currentSelected.get(id)?.length || copies.some(element => !currentSelected.get(id)?.includes(element)))) {
        return {replacedCount: 0, skippedCount: matches.length, error: "stale-target"};
    }
    const rollback = captureLiveRollback(
        edit,
        protyle,
        changed,
        liveRollbackHtml,
        submitIndexBeforeCommit,
    );
    for (const plan of selectedPlans) {
        const liveOutcome = applyMatchesToLiveUnits(
            plan.units,
            plan.matches,
            replacementText,
            plan.options,
        );
        if (liveOutcome.appliedCount !== plan.appliedCount || liveOutcome.skippedCount) {
            // No await or native submit occurred: all snapshots still belong to
            // this synchronous preparation. Parents restore their whole subtree.
            for (const [element, html] of liveRollbackHtml) {
                if (edit.contains(element)) restoreOuterHtml(element, html);
            }
            return {replacedCount: 0, skippedCount: matches.length, error: "stale-target"};
        }
    }
    try {
        logDebug("replace-all transaction submit", {blocks: changed.length, fetchedBlocks: fetched.updates.length});
        protyle.transaction(
            changed.map((update) => updateOperation(update.id, update.newHTML)),
            changed.map((update) => updateOperation(update.id, update.oldHTML)),
        );
    } catch (error) {
        logError("transaction failed", errorDetails(error));
        rollback();
        invalidateEditedDocument(rootId, changed.map((update) => update.id));
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodyMatches.length,
            error: "transaction-failed",
            commitState: "failed",
        };
    }

    const confirmation = await confirmBlockUpdates(protyle, changed, options);
    invalidateEditedDocument(rootId, changed.map((update) => update.id));

    return {
        ...confirmation,
        replacedCount: confirmation.replacedCount + unchangedCount,
        submittedCount: confirmation.submittedCount + unchangedCount,
        skippedCount: skippedBeforeBody + bodySkipped,
    };
}

/** getBlockDOMs 是 cleanRenderNode 底稿；无法再次确认或底稿改变时保守拒绝写回。 */
async function fetchedUpdatesUnchanged(
    updates: readonly PreparedBlockUpdate[],
    checkCurrent: () => string | undefined,
    notebook = "",
    protyle?: Protyle,
): Promise<boolean> {
    const readContent = protyle ? createCommitContentReader(protyle) : undefined;
    const equal = (left: string | undefined, right: string | undefined): boolean => {
        if (left === undefined || right === undefined) return left === right;
        if (left === right) return true;
        if (!readContent) return left === right;
        const leftContent = readContent(left);
        const rightContent = readContent(right);
        return leftContent !== undefined && rightContent !== undefined ?
            leftContent === rightContent :
            left === right;
    };
    const batches: PreparedBlockUpdate[][] = [];
    for (let index = 0; index < updates.length; index += BLOCK_DOM_BATCH_SIZE) {
        batches.push([...updates.slice(index, index + BLOCK_DOM_BATCH_SIZE)]);
    }
    for (let waveStart = 0; waveStart < batches.length; waveStart += BLOCK_DOM_BATCH_CONCURRENCY) {
        if (checkCurrent()) return false;
        const wave = batches.slice(waveStart, waveStart + BLOCK_DOM_BATCH_CONCURRENCY);
        const currentResults = await Promise.all(
            wave.map((batch) => fetchBlockHtmlBatch(batch.map((update) => update.id), notebook)),
        );
        if (checkCurrent()) return false;
        for (let waveIndex = 0; waveIndex < wave.length; waveIndex += 1) {
            const batch = wave[waveIndex];
            const current = currentResults[waveIndex];
            if (batch.some((update) => !equal(current.get(update.id), update.kernelHTML))) {
                return false;
            }
        }
    }
    return true;
}

/** 单条替换：块不在当前 DOM 时单独提交，仍是一次 Ctrl+Z。全部替换不走这里。 */
async function replaceFetchedBlockMatches(
    protyle: Protyle,
    blockId: string,
    matches: SearchMatch[],
    replacementText: string,
    options: ReplaceWriteOptions,
    liveRoot: Element,
    guard: () => string | undefined,
    checkCurrent: () => string | undefined,
): Promise<ReplaceWriteResult> {
    const notebook = protyle.protyle?.notebookId ?? "";
    const prepared = await prepareFetchedBlockUpdates(
        new Map([[blockId, matches]]),
        replacementText,
        options,
        liveRoot,
        checkCurrent,
        notebook,
    );
    const update = prepared.updates[0];
    if (!update) {
        return {
            replacedCount: 0,
            skippedCount: Math.max(matches.length, prepared.skippedCount),
            error: prepared.error ?? "apply-failed",
        };
    }
    const kernelCurrent = await fetchedUpdatesUnchanged(prepared.updates, checkCurrent, notebook, protyle);
    const conflict = guard() ?? (kernelCurrent ? undefined : "stale-target");
    if (conflict) {
        return {replacedCount: 0, skippedCount: matches.length, error: conflict};
    }
    if (update.newHTML === update.oldHTML) {
        return {
            replacedCount: update.appliedCount,
            skippedCount: prepared.skippedCount,
            commitState: "confirmed",
            unchanged: true,
            replacementEnd: update.replacementEnd,
        };
    }
    const rootId = protyle.protyle?.block?.rootID;
    const rollback = captureLiveRollback(liveRoot, protyle, [update]);
    try {
        protyle.transaction(
            [updateOperation(update.id, update.newHTML)],
            [updateOperation(update.id, update.oldHTML)],
        );
    } catch (error) {
        logError("transaction failed", errorDetails(error));
        rollback();
        invalidateEditedDocument(rootId, [update.id]);
        return {replacedCount: 0, skippedCount: matches.length, error: "transaction-failed", commitState: "failed"};
    }
    const confirmation = await confirmBlockUpdates(protyle, [update], options);
    invalidateEditedDocument(rootId, [update.id]);
    return {...confirmation, skippedCount: prepared.skippedCount, replacementEnd: update.replacementEnd};
}
