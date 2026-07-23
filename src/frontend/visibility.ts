import {parentElementCrossingShadow} from "./dom-parent";
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

    // 思源数据库 / Callout / 文档标题 / Mermaid(SVG) / HTML 块 Shadow：半透明与非标准盒模型较多，避免 checkVisibility+opacity 误杀
    // protyle-html：渲染字在 open shadow；Element.closest 不穿 Shadow，故另判 host
    if (
        isInsideProtyleHtmlShadow(htmlElement)
        || htmlElement.closest(
            '.av, .callout, .callout-title, .callout-info, .protyle-title, .protyle-title__input, [data-subtype="mermaid"], svg, foreignObject, protyle-html, [data-type="NodeHTMLBlock"]',
        )
    ) {
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

/**
 * KaTeX `output: "html"` 时可见字形在 `.katex-html[aria-hidden="true"]`，
 * MathML 在 `.katex-mathml`（无障碍树）。页内搜匹配的是渲染可见文字，不能把该层当隐藏。
 * 否则：提示块 / 数据库等走宽松可见性时，公式块与行内公式命中会被全部丢掉。
 *
 * @see https://katex.org/docs/options.html
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mathRender.ts
 */
function isKatexDecorativeAriaHidden(element: HTMLElement): boolean {
    if (element.getAttribute("aria-hidden") !== "true") {
        return false;
    }
    return element.classList.contains("katex-html")
        || Boolean(element.closest(".katex-html"));
}

/** 是否落在思源 HTML 块 `protyle-html` 的 open shadow 内（closest 穿不出） */
function isInsideProtyleHtmlShadow(element: Element): boolean {
    const root = element.getRootNode();
    return root instanceof ShadowRoot
        && root.host instanceof HTMLElement
        && root.host.tagName.toLowerCase() === "protyle-html";
}

/** 对页内搜索而言应视为「硬隐藏」的 aria-hidden（排除 KaTeX 装饰层） */
function isSearchBlockingAriaHidden(element: HTMLElement): boolean {
    return element.getAttribute("aria-hidden") === "true"
        && !isKatexDecorativeAriaHidden(element);
}

/** 真正不可搜的壳（与折叠无关） */
function isHardHiddenShell(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none")
            || current.hasAttribute("hidden")
            || isSearchBlockingAriaHidden(current)
        ) {
            return true;
        }
        current = parentElementCrossingShadow(current);
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
        current = parentElementCrossingShadow(current);
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

    return isElementVisible(parentElementCrossingShadow(htmlElement));
}

function isLooseUiElementVisible(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none")
            || current.hasAttribute("hidden")
            || isSearchBlockingAriaHidden(current)
        ) {
            return false;
        }

        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }

        current = parentElementCrossingShadow(current);
    }

    return true;
}
