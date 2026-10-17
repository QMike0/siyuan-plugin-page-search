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

export function attributeViewTransactionIds(detail: unknown): string[] {
    const payload = detail as {
        data?: Array<{doOperations?: Array<{avID?: string;}>; undoOperations?: Array<{avID?: string;}>;}>;
    } | null;
    const ids = new Set<string>();
    if (Array.isArray(payload?.data)) {
        for (const tx of payload.data) {
            for (
                const op of [
                    ...(Array.isArray(tx?.doOperations) ? tx.doOperations : []),
                    ...(Array.isArray(tx?.undoOperations) ? tx.undoOperations : []),
                ]
            ) {
                if (typeof op?.avID === "string" && op.avID) ids.add(op.avID);
            }
        }
    }
    return [...ids];
}

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
            doOperations?: Array<{action?: string; avID?: string;}>;
            undoOperations?: Array<{action?: string; avID?: string;}>;
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

/** These native transactions change layout only. Mixed/unknown batches still
 * invalidate values, including when an undo operation contains a real edit. */
export function isAttrViewFoldOnlyTransaction(detail: unknown): boolean {
    const payload = detail as {
        cmd?: string;
        data?: Array<{doOperations?: Array<{action?: string;}>; undoOperations?: Array<{action?: string;}>;}>;
    } | null;
    if (payload?.cmd !== "transactions" || !Array.isArray(payload.data)) return false;
    let found = false;
    for (const tx of payload.data) {
        for (const op of [
            ...(Array.isArray(tx?.doOperations) ? tx.doOperations : []),
            ...(Array.isArray(tx?.undoOperations) ? tx.undoOperations : []),
        ]) {
            if (op?.action !== "foldAttrViewGroup" && op?.action !== "foldAttrViewGroups") return false;
            found = true;
        }
    }
    return found;
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
            doOperations?: Array<{avID?: string;}>;
            undoOperations?: Array<{avID?: string;}>;
        }>;
    };
    if (!Array.isArray(payload.data)) {
        return false;
    }
    const avIds = new Set<string>();
    for (const tx of payload.data) {
        for (
            const op of [
                ...(Array.isArray(tx?.doOperations) ? tx.doOperations : []),
                ...(Array.isArray(tx?.undoOperations) ? tx.undoOperations : []),
            ]
        ) {
            if (typeof op?.avID === "string" && op.avID) {
                avIds.add(op.avID);
            }
        }
    }
    for (const avId of avIds) {
        const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function" ?
            CSS.escape(avId) :
            avId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    onChange: (avIds?: readonly string[], invalidateValues?: boolean) => void,
    debounceMs: number = 50,
): () => void {
    let timer: number | undefined;
    let invalidateValues = false;
    let unknownAv = false;
    const changedIds = new Set<string>();
    const composing = new WeakSet<Element>();
    const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            const ids = unknownAv || !changedIds.size ? undefined : [...changedIds];
            const invalidate = invalidateValues;
            changedIds.clear();
            unknownAv = invalidateValues = false;
            onChange(ids, invalidate);
        }, debounceMs);
    };
    const queryInput = (target: EventTarget | Node | null) =>
        (target instanceof Element ? target : target instanceof Node ? target.parentElement : null)
            ?.closest('[data-type="av-search"]') ?? null;
    const onInput = (event: Event) => {
        const input = queryInput(event.target);
        if (!input) return;
        if ((event as InputEvent).isComposing) {
            composing.add(input);
            if (!invalidateValues) window.clearTimeout(timer);
        }
        if (!composing.has(input)) schedule();
    };
    const onCompositionStart = (event: Event) => {
        const input = queryInput(event.target);
        if (input) {
            composing.add(input);
            if (!invalidateValues) window.clearTimeout(timer);
        }
    };
    const onCompositionEnd = (event: Event) => {
        const input = queryInput(event.target);
        if (!input) return;
        composing.delete(input);
        schedule();
    };
    edit.addEventListener("input", onInput, true);
    // Native AV handlers stop propagation; observe in capture phase. Cut may
    // have no input event, but the debounce runs after its native text update.
    edit.addEventListener("cut", onInput, true);
    edit.addEventListener("compositionstart", onCompositionStart, true);
    edit.addEventListener("compositionend", onCompositionEnd, true);

    const observer = new MutationObserver((mutations) => {
        let changed = false;
        for (const mutation of mutations) {
            const input = mutation.type === "childList" ? queryInput(mutation.target) : null;
            if (input) {
                if (!composing.has(input)) changed = true;
                continue;
            }
            if (isStructuralAttributeViewMutation(mutation)) {
                const ids = mutatedAttributeViewIds(mutation);
                invalidateValues = changed = true;
                if (!ids?.length) unknownAv = true;
                ids?.forEach(id => changedIds.add(id));
            } else if (isAttributeViewPageSizeMutation(mutation)) {
                // "Load more" expands the API page window. Drop the previous
                // bounded cache so the newly exposed rows are fetched too.
                const ids = mutatedAttributeViewIds(mutation);
                invalidateValues = changed = true;
                if (!ids?.length) unknownAv = true;
                ids?.forEach(id => changedIds.add(id));
            }
        }
        if (changed) schedule();
    });

    observer.observe(edit, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: true,
        // data-page-size changes when the user clicks "Load more". The bounded
        // AV cache must be refreshed so the newly exposed page is fetched.
        attributeFilter: ["data-render", "data-av-id", "data-av-type", "data-page-size"],
        attributeOldValue: true,
    });

    return () => {
        window.clearTimeout(timer);
        observer.disconnect();
        edit.removeEventListener("input", onInput, true);
        edit.removeEventListener("cut", onInput, true);
        edit.removeEventListener("compositionstart", onCompositionStart, true);
        edit.removeEventListener("compositionend", onCompositionEnd, true);
    };
}

/** Identify the affected carrier, including removed shells and replaced AV IDs. */
function mutatedAttributeViewIds(mutation: MutationRecord): string[] {
    const ids = new Set<string>();
    const collect = (element: Element) => {
        const id = element.getAttribute("data-av-id");
        if (id) ids.add(id);
        element.querySelectorAll(AV_BLOCK_SELECTOR).forEach(child => {
            const id = child.getAttribute("data-av-id");
            if (id) ids.add(id);
        });
    };
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    const carrier = target?.closest(AV_BLOCK_SELECTOR);
    if (carrier?.getAttribute("data-av-id")) ids.add(carrier.getAttribute("data-av-id")!);
    else if (carrier) collect(carrier);
    else for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (node instanceof Element) collect(node);
    }
    if (mutation.attributeName === "data-av-id" && mutation.oldValue) ids.add(mutation.oldValue);
    return [...ids];
}

/**
 * 是否为需要全量重搜的结构性变更（切视图/布局/整表重渲），
 * 而非虚拟滚动在 body 内增删行。
 */
function isStructuralAttributeViewMutation(mutation: MutationRecord): boolean {
    if (mutation.type === "attributes") {
        const el = mutation.target as Element;
        if (mutation.attributeName === "data-page-size") {
            return false;
        }
        // 只关心 AV 根节点的渲染标记，避免 body 上属性抖动
        return Boolean(el.matches?.(AV_BLOCK_SELECTOR));
    }

    if (mutation.type !== "childList") {
        return false;
    }

    const parent = mutation.target instanceof Element ?
        mutation.target :
        mutation.target.parentElement;
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
            ) ||
            node.querySelector?.(
                ".av__group-title, .av__body, .av__header, .av__views",
            )
        ) {
            return true;
        }
    }

    // 父级本身是 scroll/header 容器被清空重填
    if (
        parent.matches(".av__scroll, .av__header, .av__views") ||
        parent.classList.contains("av__scroll")
    ) {
        return true;
    }

    return false;
}

function isAttributeViewPageSizeMutation(mutation: MutationRecord): boolean {
    if (mutation.type !== "attributes" || mutation.attributeName !== "data-page-size") {
        return false;
    }
    const target = mutation.target as Element;
    return Boolean(target.matches?.(".av__body[data-page-size]") && target.closest(AV_BLOCK_SELECTOR));
}
