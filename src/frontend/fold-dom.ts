import {parentElementCrossingShadow} from "./dom-parent";

const HEADING_TYPE = "NodeHeading";

/**
 * 仅依据已挂载 DOM 判断是否落在非标题折叠树中。
 * 保持在独立模块，使低层 DOM 采集不必引入折叠展开所需的内核 API。
 */
export function isUnderNonHeadingCssFold(element: Element | null): boolean {
    let current = element instanceof Element ? element : null;
    while (current) {
        if (
            current.getAttribute("fold") === "1" &&
            current.getAttribute("data-type") !== HEADING_TYPE
        ) {
            return true;
        }
        current = parentElementCrossingShadow(current);
    }
    return false;
}

/** Native AV gallery bodies keep their cards while folded.  Their lack of a
 * client rect is a layout state, not author-hidden text. */
export function foldedAttributeViewGroupBody(element: Element | null): HTMLElement | null {
    const body = element?.closest<HTMLElement>(".av__body[data-group-id].fn__none");
    const fold = body?.previousElementSibling?.querySelector<HTMLElement>('[data-type="av-group-fold"]');
    return body && fold?.dataset.id === body.dataset.groupId ? body : null;
}
