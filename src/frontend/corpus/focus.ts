import {getAllEditor} from "siyuan";
import type {DocMeta} from "./meta";

/**
 * 面包屑聚焦时 protyle.block.id 是当前块，rootID 仍是文档。
 * 未聚焦返回空字符串。
 */
export function editorFocusId(edit: Element): string {
    const protyleEl = edit.classList.contains("protyle") && !edit.hasAttribute("data-page-search-offscreen")
        ? edit
        : edit.querySelector(".protyle:not(.fn__none):not([data-page-search-offscreen])");
    const editors = getAllEditor();
    const exact = protyleEl
        ? editors.find((editor) => editor?.protyle?.element === protyleEl)
        : undefined;
    const found = exact ?? editors.find((editor) => {
        const el = editor?.protyle?.element;
        return el === edit || (el instanceof Element && !el.hasAttribute("data-page-search-offscreen")
            && (el.contains(edit) || edit.contains(el)));
    });
    const block = found?.protyle?.block;
    const id = block?.id?.trim() || "";
    const rootId = block?.rootID?.trim() || "";
    // 大文档滚动也会把 block.id 改成视口里的块，但 showAll 仍为 false。
    // 只有面包屑聚焦才会 showAll，且 id 不是文档根。
    if (!block?.showAll || !id || !rootId || id === rootId) {
        return "";
    }
    return id;
}

export function isEditorZoomed(edit: Element): boolean {
    return editorFocusId(edit) !== "";
}

function headingLevel(subtype: string): number {
    const matched = /^h?([1-6])$/.exec(subtype);
    return matched ? Number(matched[1]) : 6;
}

/**
 * 聚焦块及其内容。
 * 列表、引述、提示、超级块走父子关系。
 * 标题再按文档序带上后续兄弟，直到同级或更高级标题。
 * 关系表里还没有这个块时返回 null。
 */
export function collectFocusScope(
    focusId: string,
    meta: Pick<DocMeta, "links"> | null | undefined,
    order: string[],
): Set<string> | null {
    const links = meta?.links;
    if (!focusId || !links || !links.has(focusId)) {
        return null;
    }
    const children = new Map<string, string[]>();
    links.forEach((link, id) => {
        const parent = link.parentId;
        if (!parent) {
            return;
        }
        const list = children.get(parent);
        if (list) {
            list.push(id);
        } else {
            children.set(parent, [id]);
        }
    });
    const scope = new Set<string>();
    const addTree = (id: string) => {
        if (!id || scope.has(id)) {
            return;
        }
        scope.add(id);
        const kids = children.get(id);
        if (!kids) {
            return;
        }
        for (const kid of kids) {
            addTree(kid);
        }
    };
    addTree(focusId);
    const focus = links.get(focusId);
    if (focus?.type !== "h") {
        return scope;
    }
    const level = headingLevel(focus.subtype);
    const parent = focus.parentId;
    const siblings = children.get(parent) ?? [];
    const siblingIds = new Set(siblings);
    const topMemo = new Map<string, string | null>();
    const topSibling = (id: string): string | null => {
        const cached = topMemo.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const path: string[] = [];
        const seen = new Set<string>();
        let current = id;
        let result: string | null = null;
        while (current && !seen.has(current)) {
            const known = topMemo.get(current);
            if (known !== undefined) {
                result = known;
                break;
            }
            if (siblingIds.has(current)) {
                result = current;
                break;
            }
            seen.add(current);
            path.push(current);
            const next = links.get(current)?.parentId ?? "";
            if (!next || next === current) {
                result = null;
                break;
            }
            current = next;
        }
        for (const step of path) {
            topMemo.set(step, result);
        }
        topMemo.set(id, result);
        return result;
    };
    const takeAfterHeading = (ids: string[], from: number) => {
        let started = false;
        const added = new Set<string>();
        for (let index = from; index < ids.length; index++) {
            const id = ids[index];
            const sibling = siblingIds.has(id) ? id : topSibling(id);
            // 标题自己的子孙会沿父链回到这个标题，不能把它当成结束边界。
            if (sibling === focusId) {
                started = true;
                continue;
            }
            if (!sibling || !started || added.has(sibling)) {
                continue;
            }
            const node = links.get(sibling);
            if (node?.type === "h" && headingLevel(node.subtype) <= level) {
                break;
            }
            added.add(sibling);
            addTree(sibling);
        }
    };
    const from = order.indexOf(focusId);
    if (from >= 0) {
        takeAfterHeading(order, from);
    } else {
        takeAfterHeading(siblings, 0);
    }
    return scope;
}
