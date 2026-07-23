/**
 * 向上取父元素，并在 Shadow 边界处跳到 host。
 * 普通 light DOM 与 Element.parentElement 等价；HTML 块等 open shadow 内节点
 * 的 parentElement 会在 ShadowRoot 处为 null，不穿透则折叠检测 / 滚动容器会断。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/stage/protyle/js/protyle-html.js
 */
export function parentElementCrossingShadow(element: Element | null): HTMLElement | null {
    if (!element) {
        return null;
    }
    if (element.parentElement) {
        return element.parentElement;
    }
    const root = element.getRootNode();
    if (root instanceof ShadowRoot && root.host instanceof HTMLElement) {
        return root.host;
    }
    return null;
}
