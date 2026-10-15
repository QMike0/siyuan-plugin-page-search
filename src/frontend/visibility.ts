import {parentElementCrossingShadow} from "./dom-parent";
import {isUnderNonHeadingCssFold} from "./fold-dom";

interface TextStyle {
    display: string;
    displayHidden: boolean;
    visibilityHidden: boolean;
}
let textStyleCache = new WeakMap<Element, TextStyle>();
let collectAllowsFoldedHidden = true;
let collectIncludesMindmapSource = false;

/** 每次采集开始时清掉。样式会变，不能把上一次搜索的 display 留到下一次。 */
export function beginTextCollection(allowFoldedHidden: boolean, includeMindmapSource?: boolean): void {
    textStyleCache = new WeakMap<Element, TextStyle>();
    collectAllowsFoldedHidden = allowFoldedHidden;
    if (includeMindmapSource !== undefined) {
        collectIncludesMindmapSource = includeMindmapSource;
    }
}

/** Native _mindmap-view.scss hides these source items while painting clones. */
function isMindmapSourceHideBoundary(element: Element): boolean {
    if (element.hasAttribute("hidden") || (element as HTMLElement).style?.display === "none") return false;
    const parent = element.parentElement;
    if (parent?.getAttribute("data-mindmap-view-rendered") !== "true") return false;
    return (parent.getAttribute("data-type") === "NodeMindmap" &&
        element.matches('.mindmap-item[data-type="NodeMindmapItem"][data-node-id]')) ||
        (parent.getAttribute("data-type") === "NodeList" &&
            parent.getAttribute("custom-sy-list-mindmap") === "1" &&
            element.getAttribute("data-type") === "NodeListItem");
}

function isMindmapSourceDescendant(element: Element | null): boolean {
    if (!element?.closest("[data-mindmap-view-rendered=\"true\"]")) {
        return false;
    }
    let current = element;
    while (current && current !== document.body) {
        if (isMindmapSourceHideBoundary(current)) {
            return true;
        }
        current = parentElementCrossingShadow(current);
    }
    return false;
}

function isAuthorCssHiddenExceptMindmapSource(element: Element | null): boolean {
    if (element && textStyle(element).visibilityHidden) {
        return true;
    }
    let current = element;
    while (current && current !== document.body) {
        if (current.hasAttribute("data-page-search-offscreen")) {
            break;
        }
        if (
            current.classList.contains("fn__none") || current.hasAttribute("hidden") ||
            current.getAttribute("aria-hidden") === "true"
        ) {
            return true;
        }
        if (textStyle(current).displayHidden && !isMindmapSourceHideBoundary(current)) {
            return true;
        }
        current = parentElementCrossingShadow(current);
    }
    return false;
}

/** Replacement collection ignores only native mindmap source hiding, never author CSS. */
export function isCollectedTextHidden(node: Text): boolean {
    if (!collectIncludesMindmapSource && !isMindmapSourceDescendant(node.parentElement)) {
        return isAuthorCssHiddenText(node, collectAllowsFoldedHidden);
    }
    const parent = node.parentElement;
    if (!collectAllowsFoldedHidden && isUnderNonHeadingCssFold(parent)) return true;
    if (parent && textStyle(parent).visibilityHidden) return true;
    let current: Element | null = parent;
    while (current && current !== document.body) {
        if (current.hasAttribute("data-page-search-offscreen")) break;
        if (
            current.classList.contains("fn__none") || current.hasAttribute("hidden") ||
            current.getAttribute("aria-hidden") === "true"
        ) return true;
        if (textStyle(current).displayHidden && !isMindmapSourceHideBoundary(current)) return true;
        current = parentElementCrossingShadow(current);
    }
    return false;
}

/**
 * 这个元素自己是作者写的隐藏边界，而不是被 display:none 祖先牵连。
 * 思源用 .fn__none 收起页签等界面，离屏宿主和 fold="1" 也不是正文里的隐藏字。
 */
export function isCssHideBoundary(element: Element): boolean {
    const style = textStyle(element);
    return style.displayHidden || style.visibilityHidden;
}

/** Shared within one collection; CSS layout and hiding need only one style read per element. */
export function textDisplay(element: Element): string {
    return textStyle(element).display;
}

function textStyle(element: Element): TextStyle {
    const cached = textStyleCache.get(element);
    if (cached) {
        return cached;
    }
    const inlineStyle = (element as HTMLElement).style;
    const own = typeof getComputedStyle === "function" ? getComputedStyle(element) : inlineStyle;
    const display = own?.display ?? "";
    const uiShell = element.classList.contains("fn__none") || element.hasAttribute("data-page-search-offscreen");
    const style = {
        display,
        displayHidden: element.hasAttribute("hidden") || inlineStyle?.display === "none" ||
            (!uiShell && display === "none" && !isSiyuanFoldDisplayBoundary(element)),
        visibilityHidden: own?.visibility === "hidden" || own?.visibility === "collapse",
    };
    textStyleCache.set(element, style);
    return style;
}

/**
 * SiYuan's native folded-block CSS boundaries.
 *
 * These elements are `display:none` only because their owning block has
 * `fold="1"`; when the search option allows folded content, they must not be
 * treated as author-hidden text.  Keep real hidden shells (`.fn__none`,
 * `hidden`, `aria-hidden`) outside this list.
 *
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.7/app/src/assets/scss/protyle/_wysiwyg.scss
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.7/app/src/assets/scss/protyle/_tabs.scss
 */
function isSiyuanFoldDisplayBoundary(element: Element): boolean {
    return element.matches(
        '.li[fold="1"] > div:nth-child(n+3):not(.protyle-attr), ' +
            '.bq[fold="1"] > [data-node-id] ~ [data-node-id], ' +
            '.callout[fold="1"] > .callout-content, ' +
            '.callout[fold="1"] > .callout-content > [data-node-id] ~ [data-node-id], ' +
            '.tabs[fold="1"] > .tab-item',
    );
}

/** 文本落在作者 CSS 隐藏里。打开折叠块时，折叠树内的字仍保留。 */
export function isAuthorCssHiddenText(node: Text, allowFoldedHidden: boolean): boolean {
    const parent = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
    if (!allowFoldedHidden && isUnderNonHeadingCssFold(parent)) {
        return true;
    }
    return isAuthorCssHiddenElement(parent);
}

export function isAuthorCssHiddenElement(element: Element | null): boolean {
    // visibility is inherited but a descendant can restore visible. display:none
    // hides the entire subtree and cannot be restored by a descendant.
    if (element && textStyle(element).visibilityHidden) {
        return true;
    }
    let current = element;
    while (current && current !== document.body) {
        if (current.hasAttribute("data-page-search-offscreen")) {
            break;
        }
        if (textStyle(current).displayHidden) {
            return true;
        }
        current = parentElementCrossingShadow(current);
    }
    return false;
}

/** A mounted hidden block must not be reintroduced via detached kernel DOM. */
export function collectAuthorHiddenBlockIds(root: ParentNode): Set<string> {
    const hidden = new Set<string>();
    const visible = new Set<string>();
    root.querySelectorAll<HTMLElement>("[data-node-id][data-type], [data-mindmap-source-id]").forEach((element) => {
        // Embedded copies have a different search owner from their source block.
        const embed = element.closest('[data-type="NodeBlockQueryEmbed"]');
        if (embed && embed !== element) {
            return;
        }
        const id = element.dataset.mindmapSourceId || element.dataset.nodeId;
        if (id) {
            (isAuthorCssHiddenExceptMindmapSource(element) ? hidden : visible).add(id);
        }
    });
    visible.forEach((id) => hidden.delete(id));
    return hidden;
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
        options.allowFoldedHidden !== true &&
        isUnderNonHeadingCssFold(htmlElement)
    ) {
        return false;
    }

    // 思源数据库 / Callout / 文档标题 / Mermaid(SVG) / HTML 块 Shadow：半透明与非标准盒模型较多，避免 checkVisibility+opacity 误杀
    // protyle-html：渲染字在 open shadow；Element.closest 不穿 Shadow，故另判 host
    if (
        isInsideProtyleHtmlShadow(htmlElement) ||
        htmlElement.closest(
            '.av, .callout, .callout-title, .callout-info, .protyle-title, .protyle-title__input, [data-subtype="mermaid"], svg, foreignObject, protyle-html, [data-type="NodeHTMLBlock"], .katex-html, .mindmap-view',
        )
    ) {
        if (isLooseUiElementVisible(htmlElement)) {
            return true;
        }
        // 开开关且仍因 display:none 等不可见 → 允许折叠内隐藏节点
        return options.allowFoldedHidden === true &&
            isMatchableFoldedHidden(htmlElement);
    }

    if (isStrictlyVisible(htmlElement)) {
        return true;
    }

    return options.allowFoldedHidden === true &&
        isMatchableFoldedHidden(htmlElement);
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
    return element.classList.contains("katex-html") ||
        Boolean(element.closest(".katex-html"));
}

/** 是否落在思源 HTML 块 `protyle-html` 的 open shadow 内（closest 穿不出） */
function isInsideProtyleHtmlShadow(element: Element): boolean {
    const root = element.getRootNode();
    return root instanceof ShadowRoot &&
        root.host instanceof HTMLElement &&
        root.host.tagName.toLowerCase() === "protyle-html";
}

/** 对页内搜索而言应视为「硬隐藏」的 aria-hidden（排除 KaTeX 装饰层） */
function isSearchBlockingAriaHidden(element: HTMLElement): boolean {
    return element.getAttribute("aria-hidden") === "true" &&
        !isKatexDecorativeAriaHidden(element);
}

/** 真正不可搜的壳（与折叠无关） */
function isHardHiddenShell(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none") ||
            current.hasAttribute("hidden") ||
            isSearchBlockingAriaHidden(current)
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
    return isUnderNonHeadingCssFold(element) && !isAuthorCssHiddenElement(element);
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
        return htmlElement.checkVisibility(
            {
                visibilityProperty: true,
                opacityProperty: true,
                // 大列表用 content-visibility: auto 跳过布局，文字仍在 DOM 里，应继续高亮
                contentVisibilityAuto: true,
            } as Parameters<HTMLElement["checkVisibility"]>[0],
        );
    }

    if (typeof getComputedStyle !== "function") {
        return true;
    }

    return !isAuthorCssHiddenElement(htmlElement);
}

function isLooseUiElementVisible(element: HTMLElement): boolean {
    if (typeof getComputedStyle === "function") {
        const visibility = getComputedStyle(element).visibility;
        if (visibility === "hidden" || visibility === "collapse") {
            return false;
        }
    }
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
        if (
            current.classList.contains("fn__none") ||
            current.hasAttribute("hidden") ||
            isSearchBlockingAriaHidden(current)
        ) {
            return false;
        }

        if (typeof getComputedStyle !== "function") {
            return true;
        }
        const style = window.getComputedStyle(current);
        if (style.display === "none") {
            return false;
        }

        current = parentElementCrossingShadow(current);
    }

    return true;
}
