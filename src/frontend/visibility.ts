import {isUnderNonHeadingCssFold} from "./fold";

export interface ElementVisibilityOptions {
    /**
     * 允许匹配「非标题 CSS 折叠」内的节点。
     * 关闭时：凡落在非标题 fold="1" 下均不可匹配（与折叠列表项关开关行为对齐）。
     * 折叠标题子块不在 DOM，不受此开关影响。
     */
    allowFoldedHidden?: boolean;
}

/**
 * 检查搜索匹配所在元素是否应计入结果。
 * 数据库（.av）内控件常用半透明/overflow，checkVisibility+opacity 会误杀单选 chip。
 */
export function isElementVisible(
    element: Element | null,
    options: ElementVisibilityOptions = {},
): boolean {
    if (!element) {
        return false;
    }

    const htmlElement = element as HTMLElement;

    if (htmlElement.tagName?.toLowerCase() === "style") {
        return false;
    }

    // 关「折叠块内容」：非标题 fold 下整棵子树都不计命中
    // （Callout/引述首段虽非 display:none，也与折叠列表项隐藏内容同样排除）
    if (
        options.allowFoldedHidden !== true
        && isUnderNonHeadingCssFold(htmlElement)
    ) {
        return false;
    }

    // 思源数据库 / Callout / 文档标题 / Mermaid(SVG)：半透明与非标准盒模型较多，避免 checkVisibility+opacity 误杀
    if (htmlElement.closest(
        '.av, .callout, .callout-title, .callout-info, .protyle-title, .protyle-title__input, [data-subtype="mermaid"], svg, foreignObject',
    )) {
        if (isLooseUiElementVisible(htmlElement)) {
            return true;
        }
        // 开开关且仍因 display:none 等不可见 → 允许折叠内隐藏节点
        return options.allowFoldedHidden === true
            && isMatchableFoldedHidden(htmlElement);
    }

    if (isStrictlyVisible(htmlElement)) {
        return true;
    }

    return options.allowFoldedHidden === true
        && isMatchableFoldedHidden(htmlElement);
}

/** 真正不可搜的壳（与折叠无关） */
function isHardHiddenShell(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none")
            || current.hasAttribute("hidden")
            || current.getAttribute("aria-hidden") === "true"
        ) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

/**
 * 不可见，但落在非标题 fold 下 → 开关打开时可计入匹配。
 * 仍排除 .fn__none 等硬隐藏。
 */
function isMatchableFoldedHidden(element: HTMLElement): boolean {
    if (isHardHiddenShell(element)) {
        return false;
    }
    return isUnderNonHeadingCssFold(element);
}

function isStrictlyVisible(htmlElement: HTMLElement): boolean {
    let current: Element | null = htmlElement;
    while (current && current !== document.body) {
        if ((current as HTMLElement).classList?.contains("fn__none")) {
            return false;
        }
        current = current.parentElement;
    }

    if (typeof htmlElement.checkVisibility === "function") {
        return htmlElement.checkVisibility({
            visibilityProperty: true,
            opacityProperty: true,
        });
    }

    const style = window.getComputedStyle(htmlElement);
    if (style.display === "none" || style.visibility === "hidden") {
        return false;
    }

    return isElementVisible(htmlElement.parentElement);
}

function isLooseUiElementVisible(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none")
            || current.hasAttribute("hidden")
            || current.getAttribute("aria-hidden") === "true"
        ) {
            return false;
        }

        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }

        current = current.parentElement;
    }

    return true;
}
