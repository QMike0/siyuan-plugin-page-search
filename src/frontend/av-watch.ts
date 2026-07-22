/**
 * 思源数据库（Attribute View）变更侦测。
 *
 * 背景（参考 siyuan 源码）：
 * - 列改名 / 切视图等走 ws-main `cmd: "transactions"`，action 含 AttrView
 * - 布局切换走 protyle `refreshAttributeView`，插件通常收不到 ws-main
 * - avRender 会重建子树，CSS Highlight Range 失效
 * - 分组/大表还有虚拟滚动：在 `.av__body` 内增删行，不应触发「全量重搜」，
 *   否则跳转时会把 resultIndex 打回 1
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/transaction.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/render.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/virtualScroll.ts
 */

/** 覆盖 refreshAV debounce(100ms) + 渲染耗时 */
export const AV_REFRESH_DEBOUNCE_MS = 280;

const AV_BLOCK_SELECTOR = '[data-type="NodeAttributeView"], .av[data-av-id]';

/** 虚拟滚动 / 行级更新发生在这些容器内，跳转时会频繁突变 */
const AV_VIRTUAL_SCROLL_INNER = ".av__body, .av__gallery, .av__kanban, .av__row, .av__gallery-item";

/**
 * 判断 ws-main 事件是否为 Attribute View 相关事务。
 */
export function isAttrViewWsTransaction(detail: unknown): boolean {
    if (!detail || typeof detail !== "object") {
        return false;
    }
    const payload = detail as {
        cmd?: string;
        data?: Array<{
            doOperations?: Array<{action?: string; avID?: string}>;
            undoOperations?: Array<{action?: string; avID?: string}>;
        }>;
    };
    if (payload.cmd !== "transactions" || !Array.isArray(payload.data)) {
        return false;
    }

    for (const tx of payload.data) {
        const ops = [
            ...(Array.isArray(tx?.doOperations) ? tx.doOperations : []),
            ...(Array.isArray(tx?.undoOperations) ? tx.undoOperations : []),
        ];
        for (const op of ops) {
            if (typeof op?.action === "string" && /attrview/i.test(op.action)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 当前编辑区内是否存在（或事务涉及）可观察的数据库块。
 */
export function isAttrViewRelevantToEdit(edit: Element, detail?: unknown): boolean {
    if (edit.querySelector(AV_BLOCK_SELECTOR)) {
        return true;
    }
    if (!detail || typeof detail !== "object") {
        return false;
    }
    const payload = detail as {
        data?: Array<{
            doOperations?: Array<{avID?: string}>;
            undoOperations?: Array<{avID?: string}>;
        }>;
    };
    if (!Array.isArray(payload.data)) {
        return false;
    }
    const avIds = new Set<string>();
    for (const tx of payload.data) {
        for (const op of [
            ...(Array.isArray(tx?.doOperations) ? tx.doOperations : []),
            ...(Array.isArray(tx?.undoOperations) ? tx.undoOperations : []),
        ]) {
            if (typeof op?.avID === "string" && op.avID) {
                avIds.add(op.avID);
            }
        }
    }
    for (const avId of avIds) {
        const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(avId)
            : avId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        if (edit.querySelector(`[data-av-id="${safeId}"]`)) {
            return true;
        }
    }
    return false;
}

/**
 * 观察编辑区内数据库「结构性」DOM 重建（布局切换等）。
 * 忽略 `.av__body` 内虚拟滚动带来的行级突变，避免跳转时误触发重搜。
 */
export function watchAttributeViewDom(
    edit: Element,
    onChange: () => void,
    debounceMs: number = 50,
): () => void {
    let timer: number | undefined;
    const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => onChange(), debounceMs);
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (isStructuralAttributeViewMutation(mutation)) {
                schedule();
                return;
            }
        }
    });

    observer.observe(edit, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: true,
        // 仅根级渲染标记；不要监听 data-page-size（滚动加载会改）
        attributeFilter: ["data-render", "data-av-id", "data-av-type"],
    });

    return () => {
        window.clearTimeout(timer);
        observer.disconnect();
    };
}

/**
 * 是否为需要全量重搜的结构性变更（切视图/布局/整表重渲），
 * 而非虚拟滚动在 body 内增删行。
 */
export function isStructuralAttributeViewMutation(mutation: MutationRecord): boolean {
    if (mutation.type === "attributes") {
        const el = mutation.target as Element;
        // 只关心 AV 根节点的渲染标记，避免 body 上属性抖动
        return Boolean(el.matches?.(AV_BLOCK_SELECTOR));
    }

    if (mutation.type !== "childList") {
        return false;
    }

    const parent = mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
    if (!parent) {
        return false;
    }

    // 虚拟滚动：在 body/画廊/行内部增删节点 → 忽略
    if (parent.closest(AV_VIRTUAL_SCROLL_INNER)) {
        return false;
    }

    if (!parent.closest(AV_BLOCK_SELECTOR) && !parent.matches?.(AV_BLOCK_SELECTOR)) {
        // 可能是整块 AV 被替换
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (!(node instanceof Element)) {
                continue;
            }
            if (node.matches(AV_BLOCK_SELECTOR) || node.querySelector(AV_BLOCK_SELECTOR)) {
                return true;
            }
        }
        return false;
    }

    // AV 外壳内：组标题 / body 整段 / header / 视图 tab 变化 → 结构性
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (!(node instanceof Element)) {
            continue;
        }
        if (
            node.matches(
                `${AV_BLOCK_SELECTOR}, .av__group-title, .av__body, .av__header, .av__views, .av__scroll`,
            )
            || node.querySelector?.(
                ".av__group-title, .av__body, .av__header, .av__views",
            )
        ) {
            return true;
        }
    }

    // 父级本身是 scroll/header 容器被清空重填
    if (
        parent.matches(".av__scroll, .av__header, .av__views")
        || parent.classList.contains("av__scroll")
    ) {
        return true;
    }

    return false;
}
