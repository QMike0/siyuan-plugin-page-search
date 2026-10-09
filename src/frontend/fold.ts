import {fetchSyncPost} from "siyuan";
import {escSql, querySql} from "./corpus/api";
import {peekDocMeta} from "./corpus/meta";
import {peekDocOrder} from "./corpus/order";
import {parentElementCrossingShadow} from "./dom-parent";
import {isUnderNonHeadingCssFold} from "./fold-dom";

export {isUnderNonHeadingCssFold} from "./fold-dom";

/**
 * 思源非标题折叠：块保留在 DOM，仅 CSS 隐藏（list / callout / bq / sb 等）。
 * 标题折叠会把后续块从界面拿掉。跳转时两类都展开，不进入聚焦。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/blockFold.ts
 * @see /api/block/unfoldBlock
 */

const HEADING_TYPE = "NodeHeading";

/** 本次展开路径上最外层折叠标题；供跳转只补这一段的高亮 */
let unfoldedOuterHeadingId = "";

export function consumeUnfoldedOuterHeadingId(): string {
    const id = unfoldedOuterHeadingId;
    unfoldedOuterHeadingId = "";
    return id;
}

function headingRank(element: Element): number | null {
    if (element.getAttribute("data-type") !== HEADING_TYPE) {
        return null;
    }
    const sub = element.getAttribute("data-subtype") ?? "";
    const matched = /^h([1-6])$/.exec(sub);
    return matched ? Number(matched[1]) : null;
}

/** 标题折叠展开后，跟在该标题后、直到同级或更高级标题之前的顶层块 */
export function listBlocksUnfoldedAfterHeading(heading: HTMLElement): HTMLElement[] {
    const level = headingRank(heading);
    if (level == null) {
        return [];
    }
    const roots: HTMLElement[] = [];
    let sibling = heading.nextElementSibling;
    while (sibling) {
        const rank = headingRank(sibling);
        if (rank != null && rank <= level) {
            break;
        }
        if (sibling instanceof HTMLElement) {
            roots.push(sibling);
        }
        sibling = sibling.nextElementSibling;
    }
    return roots;
}

/**
 * 自内向外收集需展开的非标题折叠祖先 id（数组末项为最外层）。
 * 跳转时从外到内展开更稳。
 * 祖先遍历穿透 open Shadow（HTML 块 protyle-html），否则折叠容器检测会断在边界。
 */
export function collectNonHeadingFoldedAncestorIds(element: Element | null): string[] {
    const ids: string[] = [];
    let current = element instanceof Element ? element : null;
    while (current) {
        if (
            current.getAttribute("fold") === "1"
            && current.getAttribute("data-type") !== HEADING_TYPE
        ) {
            const id = current.getAttribute("data-node-id")?.trim();
            if (id && !ids.includes(id)) {
                ids.push(id);
            }
        }
        current = parentElementCrossingShadow(current);
    }
    return ids.reverse();
}

function isSelfFoldedIal(ial: string): boolean {
    if (!hasOwnFold(ial)) {
        return false;
    }
    return !/heading-fold="1"/.test(ial);
}

/** fold="1"，不把 heading-fold="1" 当成自身折叠 */
function hasOwnFold(ial: string): boolean {
    return /(?:^|[\s{])fold="1"/.test(ial);
}

function headingLevel(subtype: string): number | null {
    const matched = /^h([1-6])$/.exec(subtype);
    return matched ? Number(matched[1]) : null;
}

/**
 * 用搜索时已经载入的文档序和块属性，找出包住该块的折叠标题，外层在前。
 * 没有缓存或块不在文档序里时返回 null，调用方走原来的接口。
 */
function foldedHeadingChain(rootId: string, blockId: string): string[] | null {
    if (!rootId) {
        return null;
    }
    const meta = peekDocMeta(rootId);
    const order = peekDocOrder(rootId);
    if (!meta || !order || order.length === 0) {
        return null;
    }
    const index = order.indexOf(blockId);
    if (index < 0) {
        return null;
    }
    const innerFirst: string[] = [];
    let minLevel = 7;
    for (let i = index - 1; i >= 0; i -= 1) {
        const id = order[i];
        const node = meta.byId.get(id);
        if (!node || node.type !== "h") {
            continue;
        }
        const level = headingLevel(node.subtype);
        if (level == null || level >= minLevel) {
            continue;
        }
        if (hasOwnFold(node.ial)) {
            innerFirst.push(id);
        }
        minLevel = level;
        if (level === 1) {
            break;
        }
    }
    innerFirst.reverse();
    return innerFirst;
}

function headingNeedsUnfold(editor: ParentNode | undefined, headingId: string): boolean {
    const root = editor ?? document;
    const node = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(headingId)}"]`);
    if (!node || node.closest("[data-page-search-offscreen]")) {
        return true;
    }
    return node.getAttribute("fold") === "1";
}

async function isBlockFolded(blockId: string): Promise<boolean> {
    try {
        const response = await fetchSyncPost("/api/block/checkBlockFold", {id: blockId});
        return Boolean(response?.code === 0 && response.data?.isFolded);
    } catch {
        return false;
    }
}

async function outermostFoldedHeading(blockId: string): Promise<string | null> {
    try {
        const response = await fetchSyncPost("/api/block/getUnfoldedParentID", {id: blockId});
        const parentId = response?.code === 0 ? String(response.data?.parentID ?? "") : "";
        if (!parentId || parentId === blockId) {
            return null;
        }
        return parentId;
    } catch {
        return null;
    }
}

async function outermostFoldedContainer(blockId: string): Promise<string | null> {
    let current = blockId;
    let found: string | null = null;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
        seen.add(current);
        const rows = await querySql<{id?: string; parent_id?: string; type?: string; ial?: string}>(
            `SELECT id, parent_id, type, ial FROM blocks WHERE id = '${escSql(current)}' LIMIT 1`,
        );
        const row = rows?.[0];
        if (!row?.id || row.type === "d") {
            break;
        }
        if (row.id !== blockId && row.type !== "h" && isSelfFoldedIal(row.ial ?? "")) {
            found = row.id;
        }
        current = row.parent_id ?? "";
    }
    return found;
}

async function unfoldBlockById(blockId: string): Promise<void> {
    const nodes = document.querySelectorAll<HTMLElement>(
        `[data-node-id="${CSS.escape(blockId)}"]`,
    );
    nodes.forEach((node) => {
        if (node.getAttribute("data-type") !== HEADING_TYPE && node.getAttribute("fold") === "1") {
            node.removeAttribute("fold");
        }
    });
    try {
        await fetchSyncPost("/api/block/unfoldBlock", {id: blockId});
    } catch (error) {
        console.warn("[page-search] unfold block failed", blockId, error);
    }
}

/** 目标块已经在编辑器里且没被列表/提示等挡住时，不必再请求折叠状态 */
function blockShownInEditor(editor: ParentNode | undefined, blockId: string): boolean {
    const root = editor ?? document;
    const node = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"]`);
    if (!node || node.closest("[data-page-search-offscreen]")) {
        return false;
    }
    return !isUnderNonHeadingCssFold(node);
}

/**
 * 跳转前展开挡住该块的折叠标题和折叠容器，从外向内，不进入聚焦。
 * 返回是否真正展开过；未折叠时立即返回，避免无谓等待。
 * 块已经回到 editor 后不再补一次 checkBlockFold。
 */
export async function unfoldPathToBlock(
    blockId: string,
    editor?: ParentNode,
    rootId?: string,
): Promise<boolean> {
    const target = blockId.trim();
    unfoldedOuterHeadingId = "";
    if (!target) {
        return false;
    }
    let unfolded = false;
    let previous = "";
    const chain = foldedHeadingChain(rootId ?? "", target);
    if (chain && chain.length) {
        for (const headingId of chain) {
            if (blockShownInEditor(editor, target)) {
                return unfolded;
            }
            if (!headingNeedsUnfold(editor, headingId)) {
                continue;
            }
            if (!unfoldedOuterHeadingId) {
                unfoldedOuterHeadingId = headingId;
            }
            previous = headingId;
            await unfoldBlockById(headingId);
            unfolded = true;
        }
        if (blockShownInEditor(editor, target)) {
            return true;
        }
        previous = "";
    }
    for (let step = 0; step < 24; step += 1) {
        if (blockShownInEditor(editor, target)) {
            return unfolded;
        }
        if (!await isBlockFolded(target)) {
            return unfolded;
        }
        const heading = await outermostFoldedHeading(target);
        if (heading && !unfoldedOuterHeadingId) {
            unfoldedOuterHeadingId = heading;
        }
        const container = heading ? null : await outermostFoldedContainer(target);
        const unfoldId = heading || container || target;
        if (!unfoldId || unfoldId === previous) {
            return unfolded;
        }
        previous = unfoldId;
        await unfoldBlockById(unfoldId);
        unfolded = true;
        if (unfoldId === target) {
            return true;
        }
    }
    return unfolded;
}

/**
 * 展开非标题折叠块：先本地去掉 fold（立刻可见，便于滚动），再调内核持久化。
 * clearNonHeadingFoldLocally 只做本地这一步，方便先滚动再后台持久化。
 *
 * @see /api/block/unfoldBlock
 */
export function clearNonHeadingFoldLocally(blockIds: string[]): void {
    const unique = [...new Set(blockIds.map((id) => id.trim()).filter(Boolean))];
    unique.forEach((id) => {
        document.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`).forEach((node) => {
            if (node.getAttribute("data-type") === HEADING_TYPE) {
                return;
            }
            if (node.getAttribute("fold") === "1") {
                node.removeAttribute("fold");
            }
        });
    });
}

export async function unfoldNonHeadingFoldedBlocks(blockIds: string[]): Promise<boolean> {
    const unique = [...new Set(blockIds.map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) {
        return false;
    }

    let touched = false;
    for (const id of unique) {
        const nodes = document.querySelectorAll<HTMLElement>(
            `[data-node-id="${CSS.escape(id)}"]`,
        );
        let isHeading = false;
        nodes.forEach((node) => {
            if (node.getAttribute("data-type") === HEADING_TYPE) {
                isHeading = true;
                return;
            }
            if (node.getAttribute("fold") === "1") {
                node.removeAttribute("fold");
                touched = true;
            }
        });
        if (isHeading) {
            continue;
        }

        try {
            const response = await fetchSyncPost("/api/block/unfoldBlock", {id});
            if (response?.code === 0) {
                touched = true;
                continue;
            }
        } catch {
            // fallback below
        }

        try {
            const response = await fetchSyncPost("/api/attr/setBlockAttrs", {
                id,
                attrs: {fold: ""},
            });
            if (response?.code === 0) {
                touched = true;
            }
        } catch (error) {
            console.warn("[page-search] unfold folded block failed", id, error);
        }
    }
    return touched;
}

/** 等一帧布局，供展开后 scrollIntoView */
export function waitForLayout(): Promise<void> {
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
}
