import type {
    IOperation,
    Protyle,
} from "siyuan";
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
import {collectSearchableBlocks} from "./blocks";
import {extractUnitsFromDoms} from "./corpus/extract";
import {invalidateDocumentSearchCaches} from "./corpus/search";
import {fetchBlockHashes} from "./corpus/sql";
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
    type RegexReplacementPlan,
} from "./replacement";
import {unitKey} from "./selection";

const DOC_TITLE_BLOCK_ID = "__doc-title__";

export interface ReplaceWriteOptions {
    preserveCase?: boolean;
    /** 正则查找：替换串展开 $1 等 */
    regex?: boolean;
    searchQuery?: string;
    caseSensitive?: boolean;
    regexUnicode?: boolean;
    regexMultiline?: boolean;
    regexDotAll?: boolean;
    /** 正则模板展开必须通过 SearchBar 的 Worker，禁止退回主线程 RegExp.exec。 */
    regexMatcher?: RegexTextMatcher;
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
        return (current.textContent?.length ?? 0) > (best.textContent?.length ?? 0) ?
            current :
            best;
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
    if (!match.replaceable || isDocTitleMatch(match)) {
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

/** 思源 3.8 的块类型锁：更新后的根类型必须和原块一致。 */
function lockedUpdate(id: string, data: string): IOperation {
    return {action: "update", id, data, lockType: true} as IOperation;
}

function restoreOuterHtml(element: HTMLElement, html: string): void {
    const template = document.createElement("template");
    template.innerHTML = html;
    const restored = template.content.firstElementChild;
    if (restored && element.parentNode) {
        element.parentNode.replaceChild(restored, element);
    }
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
    regexUnicode?: boolean;
    regexMultiline?: boolean;
    regexDotAll?: boolean;
} {
    return {
        preserveCase: options.preserveCase,
        regex: options.regex,
        searchQuery: options.searchQuery,
        caseSensitive: options.caseSensitive,
        regexUnicode: options.regexUnicode,
        regexMultiline: options.regexMultiline,
        regexDotAll: options.regexDotAll,
    };
}

type PreparedReplaceOptions = ReturnType<typeof replaceOptionsFrom> & {
    regexPlan?: RegexReplacementPlan;
};

/**
 * 把捕获组/命名组展开限制在 Worker。主线程只接收纯文本计划，随后仍逐处核对文本快照。
 * 计划失败时整次替换不写入，避免“部分替换 + 用户以为已全部完成”。
 */
async function prepareRegexReplaceOptions(
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "id" | "blockId" | "unitId" | "start" | "end" | "matchedText">>,
    replacementText: string,
    options: ReplaceWriteOptions,
): Promise<{options: PreparedReplaceOptions; error?: string;}> {
    const base = replaceOptionsFrom(options);
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
            regexUnicode: options.regexUnicode === true,
            regexMultiline: options.regexMultiline === true,
            regexDotAll: options.regexDotAll === true,
        },
    );
    if (result.cancelled || result.error) {
        return {options: base, error: "regex-expand-failed"};
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

    const submit = resolveSubmitBlockElement(edit, match.blockId);
    if (!submit || foldedContainerOmitsChildBlocks(submit) || editorTableOmitsRows(submit)) {
        return replaceFetchedBlockMatches(protyle, match.blockId, [match], replacementText, options, edit);
    }

    const blocks = collectSearchableBlocks(edit, {
        includeInlineMemo: true,
        includeImageTitle: true,
        includeDocTitle: false,
        scopeRoots: [submit],
    })
        .filter((block) => !isPreviewSyntheticBlock(block));
    const unitsByKey = buildUnitMap(blocks);
    const unit = createReplacementUnitLookup(unitsByKey)(match);
    if (!unit) {
        return {replacedCount: 0, skippedCount: 1, error: "unit-missing"};
    }
    const preparedOptions = await prepareRegexReplaceOptions(
        unitsByKey,
        [match],
        replacementText,
        options,
    );
    if (preparedOptions.error) {
        return {replacedCount: 0, skippedCount: 1, error: preparedOptions.error};
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
                "apply-failed",
        };
    }
    if ((submit.getAttribute("data-type") ?? "") !== (typeBefore ?? "")) {
        restoreOuterHtml(submit, oldHTML);
        return {replacedCount: 0, skippedCount: 1};
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

const BLOCK_DOM_BATCH_SIZE = 64;

interface PreparedBlockUpdate {
    id: string;
    oldHTML: string;
    newHTML: string;
    appliedCount: number;
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

function prepareBlockElementUpdate(
    blockId: string,
    blockEl: HTMLElement,
    oldHTML: string,
    unitsByKey: Map<string, SearchableBlock>,
    matches: SearchMatch[],
    replacementText: string,
    replaceOpts: ReturnType<typeof replaceOptionsFrom>,
): PreparedBlockResult {
    const clone = blockEl.cloneNode(true) as HTMLElement;
    const outcome = applyMatchesToSubmitClone(
        blockEl,
        clone,
        unitsByKey,
        matches,
        replacementText,
        replaceOpts,
    );
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
        },
        skippedCount: outcome.skippedCount,
    };
}

const BLOCK_COMMIT_WAIT_MS = 8000;
const BLOCK_COMMIT_POLL_MS = 80;

/**
 * protyle.transaction 把请求放进编辑器队列后就返回，不等内核写完。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/wysiwyg/transaction.ts promiseTransaction
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function blockHash(blockId: string): Promise<string> {
    const hashes = await fetchBlockHashes([blockId]);
    return hashes?.get(blockId) ?? "";
}

/**
 * 等这一笔事务落盘。previousHash 必须在调用 transaction 之前读好。
 * 事务返回时内核可能已经写完，那时再读到的是新哈希，不能当作替换前的值。
 * 哈希读不到时，再退回比对这一块的 HTML。
 */
async function waitUntilReplacementVisible(
    update: PreparedBlockUpdate,
    previousHash: string,
): Promise<void> {
    if (previousHash) {
        const deadline = Date.now() + BLOCK_COMMIT_WAIT_MS;
        while (Date.now() < deadline) {
            const after = await fetchBlockHashes([update.id]);
            const nextHash = after?.get(update.id);
            if (nextHash && nextHash !== previousHash) {
                return;
            }
            await sleep(BLOCK_COMMIT_POLL_MS);
        }
        return;
    }
    await waitUntilBlockHtmlChanges(update.id, update.oldHTML);
}

function smallestFetchedUpdate(updates: readonly PreparedBlockUpdate[]): PreparedBlockUpdate {
    return updates.reduce((best, item) => (item.newHTML.length < best.newHTML.length ? item : best));
}

async function waitUntilBlockHtmlChanges(blockId: string, previousHtml: string): Promise<void> {
    const deadline = Date.now() + BLOCK_COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
        await sleep(BLOCK_COMMIT_POLL_MS);
        try {
            const response = await fetchSyncPost("/api/block/getBlockDOMs", {ids: [blockId]});
            if (response?.code !== 0 || !response.data || typeof response.data !== "object") {
                continue;
            }
            const html = (response.data as Record<string, string>)[blockId];
            if (html !== previousHtml) {
                return;
            }
        } catch {
            // 请求还没写完时继续等到上限，避免刷新读到旧文本
        }
    }
}

async function fetchBlockHtmlBatch(ids: string[]): Promise<Map<string, string>> {
    const htmlById = new Map<string, string>();
    let data: Record<string, string> | null = null;
    try {
        const response = await fetchSyncPost("/api/block/getBlockDOMs", {ids});
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
        if (cellPlainText(liveCell) === cellPlainText(kernelCell)) {
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
): Promise<{updates: PreparedBlockUpdate[]; skippedCount: number; error?: string; fatal?: boolean;}> {
    const ids = Array.from(matchesById.keys());
    const totalMatches = Array.from(matchesById.values()).reduce((count, items) => count + items.length, 0);
    const updates: PreparedBlockUpdate[] = [];
    let skippedCount = 0;
    let error: string | undefined;
    if (ids.length === 0) {
        return {updates, skippedCount};
    }

    for (let index = 0; index < ids.length; index += BLOCK_DOM_BATCH_SIZE) {
        const batch = ids.slice(index, index + BLOCK_DOM_BATCH_SIZE);
        const htmlById = await fetchBlockHtmlBatch(batch);
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
                {includeInlineMemo: true, includeImageTitle: true, includeDocTitle: false},
                new Set(),
                "none",
            );
        } catch (extractError) {
            console.warn("[page-search] prepare unloaded replace failed", extractError);
            for (const id of present) {
                skippedCount += matchesById.get(id)?.length ?? 0;
            }
            error ??= "block-missing";
            continue;
        }

        try {
            const unitsByKey = buildUnitMap(extracted.blocks);
            const batchMatches = present.flatMap((id) => matchesById.get(id) ?? []);
            const preparedOptions = await prepareRegexReplaceOptions(
                unitsByKey,
                batchMatches,
                replacementText,
                options,
            );
            if (preparedOptions.error) {
                return {
                    updates: [],
                    skippedCount: totalMatches,
                    error: preparedOptions.error,
                    fatal: true,
                };
            }
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
                const prepared = prepareBlockElementUpdate(
                    id,
                    blockEl,
                    doms[id],
                    unitsByKey,
                    blockMatches,
                    replacementText,
                    preparedOptions.options,
                );
                skippedCount += prepared.skippedCount;
                if (prepared.update) {
                    updates.push(prepared.update);
                } else if (prepared.error) {
                    error ??= prepared.error;
                }
            }
        } finally {
            extracted.dispose();
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

    const bodyMatches: SearchMatch[] = [];
    let skippedCount = 0;

    for (const match of matches) {
        if (!isMatchWritable(edit, match)) {
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

    const blocks = collectSearchableBlocks(edit, {
        includeInlineMemo: true,
        includeImageTitle: true,
    })
        .filter((block) => !isPreviewSyntheticBlock(block));
    const unitsByKey = buildUnitMap(blocks);
    const loadedOptions = await prepareRegexReplaceOptions(
        unitsByKey,
        bodyMatches,
        replacementText,
        options,
    );
    if (loadedOptions.error) {
        return {
            replacedCount: 0,
            skippedCount: skippedCount + bodyMatches.length,
            error: loadedOptions.error,
        };
    }

    const grouped = new Map<string, SearchMatch[]>();
    for (const match of bodyMatches) {
        const list = grouped.get(match.blockId) ?? [];
        list.push(match);
        grouped.set(match.blockId, list);
    }

    const skippedBeforeBody = skippedCount;
    const loadedUpdates: PreparedBlockUpdate[] = [];
    const unloadedMatches = new Map<string, SearchMatch[]>();
    let bodySkipped = 0;

    for (const [blockId, blockMatches] of grouped) {
        const submit = resolveSubmitBlockElement(edit, blockId);
        // 折叠容器或缺行大表不用界面上的残缺 HTML，改走 getBlockDOM。
        if (!submit || foldedContainerOmitsChildBlocks(submit) || editorTableOmitsRows(submit)) {
            unloadedMatches.set(blockId, blockMatches);
            continue;
        }
        const prepared = prepareBlockElementUpdate(
            blockId,
            submit,
            submit.outerHTML,
            unitsByKey,
            blockMatches,
            replacementText,
            loadedOptions.options,
        );
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
    );
    bodySkipped += fetched.skippedCount;
    if (fetched.fatal) {
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodyMatches.length,
            error: fetched.error,
        };
    }
    if (fetched.error) {
        firstError ??= fetched.error;
    }

    const ordered = orderBlockUpdates([...fetched.updates, ...loadedUpdates]);
    if (ordered.length === 0) {
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodySkipped,
            error: firstError,
        };
    }

    const probe = fetched.updates.length > 0 ? smallestFetchedUpdate(fetched.updates) : undefined;
    // 同一笔事务一起落盘。哈希要在入队前记下，探测最小的那一块。
    const previousHash = probe ? await blockHash(probe.id) : "";
    try {
        protyle.transaction(
            ordered.map((update) => lockedUpdate(update.id, update.newHTML)),
            ordered.map((update) => lockedUpdate(update.id, update.oldHTML)),
        );
    } catch (error) {
        console.warn("[page-search] transaction failed", error);
        return {
            replacedCount: 0,
            skippedCount: skippedBeforeBody + bodyMatches.length,
            error: "transaction-failed",
        };
    }

    if (probe) {
        await waitUntilReplacementVisible(probe, previousHash);
        invalidateDocumentSearchCaches();
    }

    return {
        replacedCount: ordered.reduce((count, update) => count + update.appliedCount, 0),
        skippedCount: skippedBeforeBody + bodySkipped,
    };
}

async function commitBlockHtml(
    protyle: Protyle,
    blockId: string,
    oldHTML: string,
    newHTML: string,
): Promise<boolean> {
    try {
        protyle.transaction(
            [lockedUpdate(blockId, newHTML)],
            [lockedUpdate(blockId, oldHTML)],
        );
        return true;
    } catch (error) {
        console.warn("[page-search] transaction failed, trying /api/transactions", error);
    }
    try {
        const response = await fetchSyncPost("/api/transactions", {
            session: "page-search",
            app: "page-search",
            transactions: [{
                doOperations: [lockedUpdate(blockId, newHTML)],
                undoOperations: [lockedUpdate(blockId, oldHTML)],
            }],
        });
        return response?.code === 0;
    } catch {
        return false;
    }
}

/** 单条替换：块不在当前 DOM 时单独提交，仍是一次 Ctrl+Z。全部替换不走这里。 */
async function replaceFetchedBlockMatches(
    protyle: Protyle,
    blockId: string,
    matches: SearchMatch[],
    replacementText: string,
    options: ReplaceWriteOptions,
    liveRoot: ParentNode,
): Promise<ReplaceWriteResult> {
    const prepared = await prepareFetchedBlockUpdates(
        new Map([[blockId, matches]]),
        replacementText,
        options,
        liveRoot,
    );
    const update = prepared.updates[0];
    if (!update) {
        return {
            replacedCount: 0,
            skippedCount: Math.max(matches.length, prepared.skippedCount),
            error: prepared.error ?? "apply-failed",
        };
    }
    const previousHash = await blockHash(update.id);
    const committed = await commitBlockHtml(protyle, update.id, update.oldHTML, update.newHTML);
    if (!committed) {
        return {replacedCount: 0, skippedCount: matches.length, error: "transaction-failed"};
    }
    await waitUntilReplacementVisible(update, previousHash);
    invalidateDocumentSearchCaches();
    return {replacedCount: update.appliedCount, skippedCount: prepared.skippedCount};
}
