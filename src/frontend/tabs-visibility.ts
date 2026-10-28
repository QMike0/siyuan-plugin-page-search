/**
 * 与 SiYuan v3.8.8 tabsVisibility 一致：优先使用已渲染状态；尚未渲染时
 * 按 tabs-active-id 判断，选择失效则取第一个直接子页签。只读 DOM，不切换页签。
 */
export function isHiddenTabPanel(item: Element): boolean {
    const hidden = item.getAttribute("data-tabs-hidden");
    if (hidden === "true") return true;
    const tabs = item.parentElement;
    if (hidden === "false" || !tabs?.classList.contains("tabs")) return false;
    const activeId = tabs.getAttribute("tabs-active-id");
    let first: Element | null = null;
    // 仅属性尚未生成时遍历直接子项，不查询子树、不读取布局，也不缓存可变状态。
    for (const child of tabs.children) {
        if (!child.classList.contains("tab-item")) continue;
        first ??= child;
        if (child.getAttribute("data-node-id") === activeId) return child !== item;
    }
    return first !== item;
}

/** 内层活动页签仍可能被外层非活动页签隐藏，必须逐层判断。 */
export function isHiddenTabContent(element: Element | null): boolean {
    let item = element?.closest(".tab-item");
    while (item) {
        if (isHiddenTabPanel(item)) return true;
        item = item.parentElement?.closest(".tab-item");
    }
    return false;
}
