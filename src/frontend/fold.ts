import {fetchSyncPost} from "siyuan";
import {parentElementCrossingShadow} from "./dom-parent";

/**
 * 思源非标题折叠：块保留在 DOM，仅 CSS 隐藏（list / callout / bq / sb 等）。
 * 标题折叠会 removeFoldHeading 删掉子块，本插件明确不搜索、也不展开标题。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/blockFold.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/protyle/_wysiwyg.scss
 */

const HEADING_TYPE = "NodeHeading";

/** 是否落在「非标题」且 fold="1" 的祖先下（CSS 折叠容器） */
export function isUnderNonHeadingCssFold(element: Element | null): boolean {
    return Boolean(findNearestNonHeadingFoldedAncestor(element));
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

function findNearestNonHeadingFoldedAncestor(element: Element | null): HTMLElement | null {
    let current = element instanceof Element ? element : null;
    while (current) {
        if (
            current.getAttribute("fold") === "1"
            && current.getAttribute("data-type") !== HEADING_TYPE
        ) {
            return current as HTMLElement;
        }
        current = parentElementCrossingShadow(current);
    }
    return null;
}

/**
 * 展开非标题折叠块：先本地去掉 fold（立刻可见，便于滚动），再调内核持久化。
 * 对齐 setFold 对非标题走 setAttrs 的行为；不碰 NodeHeading。
 *
 * @see /api/block/unfoldBlock
 */
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
