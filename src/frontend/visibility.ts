import {parentElementCrossingShadow} from "./dom-parent";
import {isUnderNonHeadingCssFold} from "./fold-dom";

const cssHideBoundaryCache = new Map<Element, boolean>();
let collectAllowsFoldedHidden = true;

/** 每次采集开始时清掉。样式会变，不能把上一次搜索的 display 留到下一次。 */
export function beginTextCollection(allowFoldedHidden: boolean): void {
    cssHideBoundaryCache.clear();
    collectAllowsFoldedHidden = allowFoldedHidden;
}

/**
 * 这个元素自己是作者写的隐藏边界，而不是被 display:none 祖先牵连。
 * 思源用 .fn__none 收起页签等界面，离屏宿主和 fold="1" 也不是正文里的隐藏字。
 */
export function isCssHideBoundary(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
        return false;
    }
    const cached = cssHideBoundaryCache.get(element);
    if (cached !== undefined) {
        return cached;
    }
    let hidden = false;
    const inlineHidden = element.hasAttribute("hidden") ||
        element.style.display === "none" ||
        element.style.visibility === "hidden";
    if (inlineHidden) {
        hidden = true;
    } else if (
        !element.classList.contains("fn__none") &&
        !element.classList.contains("katex-html") &&
        !element.hasAttribute("data-page-search-offscreen") &&
        element.getAttribute("fold") !== "1"
    ) {
        if (typeof getComputedStyle !== "function") {
            cssHideBoundaryCache.set(element, false);
            return false;
        }
        const own = getComputedStyle(element);
        const parent = parentElementCrossingShadow(element);
        const parentStyle = parent instanceof HTMLElement ? getComputedStyle(parent) : null;
        if (own.visibility === "hidden" && parentStyle?.visibility !== "hidden") {
            hidden = true;
        } else if (own.display === "none" && parentStyle?.display !== "none") {
            hidden = true;
        }
    }
    cssHideBoundaryCache.set(element, hidden);
    return hidden;
}

/** 文本落在作者 CSS 隐藏里。打开折叠块时，折叠树内的字仍保留。 */
export function isAuthorCssHiddenText(node: Text, allowFoldedHidden: boolean): boolean {
    if (allowFoldedHidden && isUnderNonHeadingCssFold(node.parentElement)) {
        return false;
    }
    let current = node.parentElement;
    while (current && current !== document.body) {
        if (current.hasAttribute("data-page-search-offscreen")) {
            break;
        }
        if (isCssHideBoundary(current)) {
            return true;
        }
        current = parentElementCrossingShadow(current);
    }
    return false;
}

export function omitAuthorCssHiddenText(nodes: readonly Text[]): Text[] {
    if (nodes.length === 0) {
        return [];
    }
    return nodes.filter((node) => !isAuthorCssHiddenText(node, collectAllowsFoldedHidden));
}

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
            '.av, .callout, .callout-title, .callout-info, .protyle-title, .protyle-title__input, [data-subtype="mermaid"], svg, foreignObject, protyle-html, [data-type="NodeHTMLBlock"], .katex-html, .mindmap-view',
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
            // 大列表用 content-visibility: auto 跳过布局，文字仍在 DOM 里，应继续高亮
            contentVisibilityAuto: true,
        } as Parameters<HTMLElement["checkVisibility"]>[0]);
    }

    if (typeof getComputedStyle !== "function") {
        return true;
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

        if (typeof getComputedStyle !== "function") {
            return true;
        }
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }

        current = parentElementCrossingShadow(current);
    }

    return true;
}
