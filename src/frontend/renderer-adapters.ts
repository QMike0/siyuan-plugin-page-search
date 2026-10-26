import {
    DIAGRAM_CODE_LANGUAGES,
    DIAGRAM_CODE_LANGUAGE_SET,
    supportsDiagramSourceSearch,
} from "../shared/code-block-language";
import {ZERO_WIDTH_GLOBAL_RE} from "../shared/constants";
import {rendererUnitId} from "../shared/renderer-units";
import type {SearchableBlock} from "./dom-types";
import {isUnderNonHeadingCssFold} from "./fold-dom";
import {splitTextNodesAtBarriers} from "./text-runs";
import {
    isAuthorCssHiddenElement,
    omitAuthorCssHiddenText,
} from "./visibility";

const CODE_BLOCK_TYPE = "NodeCodeBlock";
const MATH_BLOCK_TYPE = "NodeMathBlock";
const HTML_BLOCK_TYPE = "NodeHTMLBlock";

export const DIAGRAM_SUBTYPES = DIAGRAM_CODE_LANGUAGES;

export type DiagramSubtype = (typeof DIAGRAM_SUBTYPES)[number];
export type RendererAdapterKind = DiagramSubtype | "math" | "html";

export const DIAGRAM_SUBTYPE_SET = DIAGRAM_CODE_LANGUAGE_SET;

interface RendererContext {
    blockId: string;
    blockType: string;
    blockIndex: number;
}

/** 返回块所使用的 adapter；普通正文/普通代码块返回 null。 */
export function rendererAdapterKind(element: HTMLElement): RendererAdapterKind | null {
    const blockType = element.getAttribute("data-type") ?? "";
    if (blockType === MATH_BLOCK_TYPE || element.matches("div.language-math") &&
        element.closest("[data-sy-table-cell-rich]")) {
        return "math";
    }
    if (blockType === HTML_BLOCK_TYPE) {
        return "html";
    }
    const subtype = element.getAttribute("data-subtype") ?? "";
    if (blockType === CODE_BLOCK_TYPE && DIAGRAM_SUBTYPE_SET.has(subtype)) {
        return subtype as DiagramSubtype;
    }
    return null;
}

/** Mermaid can leave its error SVG next to, rather than inside, the error message. */
export function diagramOutputFailed(element: Element): boolean {
    return Boolean(element.querySelector(".ft__error"));
}

/** Only empty Mermaid completes synchronously after setting this marker, without an SVG. */
export function isCompletedEmptyMermaid(element: Element): boolean {
    return element.getAttribute("data-subtype") === "mermaid" &&
        element.getAttribute("data-content") === "" && element.getAttribute("data-render") === "true";
}

/**
 * live DOM 与离屏 DOM 共用的 renderer 采集入口。
 * Mermaid / flowchart 优先复用正常输出；折叠/离屏本身不表示 SVG 文字不可用。
 * 缺少输出或渲染失败时立即回退源码，不触发额外渲染或等待。
 * 源码单元没有 Text 节点，不能投影到 SVG 或参与替换；其余 renderer 保持可见文字语义。
 */
export function collectRendererSearchUnits(
    element: HTMLElement,
    context: RendererContext,
    kind: RendererAdapterKind | null = rendererAdapterKind(element),
    mathSource?: string,
): SearchableBlock[] {
    if (!kind) {
        return [];
    }
    if (kind === "math") {
        return collectMathUnits(element, context, mathSource);
    }
    if (kind === "html") {
        return collectHtmlUnits(element, context);
    }
    return collectDiagramUnits(element, context, kind);
}

function collectMathUnits(element: HTMLElement, context: RendererContext, source?: string): SearchableBlock[] {
    // 思源 mathRender 使用 output="html"；只取可见字形层，避免 MathML/源码重复。
    const katexHtml = element.querySelector<HTMLElement>(".katex-html");
    if (!katexHtml) {
        const text = source ?? mathSourceFallbackText(element);
        return text && !isAuthorCssHiddenElement(element) ?
            [{
                ...context,
                element,
                text,
                textNodes: [],
                unitId: rendererUnitId("source-fallback", "math"),
            }] :
            [];
    }
    const textNodes = omitAuthorCssHiddenText(collectTextNodes(katexHtml, (parent) => {
        return !parent.closest(".katex-mathml, math, annotation, svg, style, script");
    }));
    return singleRenderedUnit(element, context, "math", textNodes);
}

/** 正常挂载公式只搜字形；离屏/折叠且没有字形时才回退原生 data-content。 */
export function mathSourceFallbackText(element: HTMLElement): string | null {
    if (!element.hasAttribute("data-content") || element.querySelector(".katex-html")) return null;
    // 数据库富文本由单元格投影管理，不能混入另一套公式源码偏移。
    if (element.closest('[data-type="NodeAttributeView"]')) return null;
    if (
        !element.closest("[data-page-search-offscreen], [parent-heading]") &&
        !isUnderNonHeadingCssFold(element)
    ) return null;
    return diagramSourceText(element);
}

function collectHtmlUnits(element: HTMLElement, context: RendererContext): SearchableBlock[] {
    // 官方 protyle-html 使用 open ShadowRoot。closed Shadow/iframe 没有可安全映射的 Text。
    const host = element.querySelector("protyle-html") as
        | (HTMLElement & {
            shadowRoot?: ShadowRoot | null;
        })
        | null;
    const shadowRoot = host?.shadowRoot;
    if (!shadowRoot) {
        return [];
    }
    // protyle-html 把 data-content 写进 open shadow 的 innerHTML。
    // 片段解析会留下 head/title 等文本，但用户代理样式不绘制它们。
    // style/script 里的注释同样不可见。canvas 的后备内容在支持 canvas 时不显示。
    const textNodes = collectTextNodes(shadowRoot, (parent) => {
        return !parent.closest(
            "style, script, textarea, noscript, title, head, template, noembed, noframes, canvas, desc, [hidden]",
        );
    });
    const runs = splitTextNodesAtBarriers(omitAuthorCssHiddenText(textNodes));
    const units: SearchableBlock[] = [];
    for (const run of runs) {
        units.push(...singleRenderedUnit(element, context, "html", run, units.length));
    }
    return units;
}

function collectDiagramUnits(
    element: HTMLElement,
    context: RendererContext,
    kind: DiagramSubtype,
): SearchableBlock[] {
    if (
        supportsDiagramSourceSearch(kind) && element.hasAttribute("data-content") &&
        (diagramOutputFailed(element) ||
            !Array.from(element.querySelectorAll("svg, canvas, img")).some((output) =>
                !output.closest(".protyle-icons, .protyle-attr")
            ))
    ) {
        if (isAuthorCssHiddenElement(element)) return [];
        const text = diagramSourceText(element);
        return text.length ?
            [{
                ...context,
                element,
                text,
                textNodes: [],
                unitId: rendererUnitId("source-fallback", kind),
            }] :
            [];
    }
    if (diagramOutputFailed(element)) {
        return [];
    }
    // 一个 SVG text / foreignObject 是一个视觉标签；同一 text 内的 tspan 仍可跨样式匹配。
    // 这样既不会把相邻标签 foo + bar 拼成 foobar，也保留单个标签内部的精确 Range。
    const boundaries = Array.from(
        element.querySelectorAll<SVGTextElement | SVGForeignObjectElement>("svg text, svg foreignObject"),
    ).filter((boundary) => {
        if (boundary.closest(".protyle-attr, .protyle-icons, .ft__error")) {
            return false;
        }
        if (boundary.localName === "text" && boundary.closest("foreignObject")) {
            return false;
        }
        const foreignObject = boundary.closest("foreignObject");
        return boundary.localName !== "foreignObject" || foreignObject === boundary;
    });

    const units: SearchableBlock[] = [];
    for (const boundary of boundaries) {
        const textNodes = omitAuthorCssHiddenText(collectTextNodes(boundary, (parent) => {
            const ariaHidden = parent.closest('[aria-hidden="true"]');
            if (ariaHidden && !parent.closest("svg")) {
                return false;
            }
            return !parent.closest(
                ".protyle-attr, .protyle-icons, style, script, textarea, noscript, title, desc, template, [hidden]",
            );
        }));
        for (const run of splitTextNodesAtBarriers(textNodes)) {
            const text = run.map((node) => node.nodeValue ?? "").join("");
            if (!meaningful(text)) {
                continue;
            }
            units.push({
                ...context,
                element,
                text,
                textNodes: run,
                unitId: rendererUnitId("rendered-text", kind, units.length),
            });
        }
    }
    return units;
}

function singleRenderedUnit(
    element: HTMLElement,
    context: RendererContext,
    kind: "math" | "html",
    textNodes: Text[],
    index = 0,
): SearchableBlock[] {
    const text = textNodes.map((node) => node.nodeValue ?? "").join("");
    if (!meaningful(text)) {
        return [];
    }
    return [{
        ...context,
        element,
        text,
        textNodes,
        unitId: rendererUnitId("rendered-text", kind, index),
    }];
}

function collectTextNodes(
    root: Node,
    acceptsParent: (parent: HTMLElement) => boolean,
): Text[] {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement ??
                (node.parentNode instanceof ShadowRoot ? node.parentNode.host as HTMLElement : null);
            if (!parent || !acceptsParent(parent)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!node.nodeValue.replace(ZERO_WIDTH_GLOBAL_RE, "").length) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let current = walker.nextNode();
    while (current) {
        textNodes.push(current as Text);
        current = walker.nextNode();
    }
    return textNodes;
}

function meaningful(text: string): boolean {
    return Boolean(text.replace(ZERO_WIDTH_GLOBAL_RE, "").trim());
}

/** 与思源图表输入一致：只解码实体，保留 HTML 形式的源码标签。 */
export function diagramSourceText(element: HTMLElement): string {
    const raw = element.getAttribute("data-content") ?? "";
    if (!raw.includes("&")) return raw;
    const lute = (window as Window & {Lute?: {UnEscapeHTMLStr?: (value: string) => string;};}).Lute;
    if (typeof lute?.UnEscapeHTMLStr === "function") {
        try {
            return lute.UnEscapeHTMLStr(raw);
        } catch {
            // 渲染库不可用时保留源码搜索，不让一次解码失败中断整条搜索链路。
        }
    }
    // textarea 脱离文档；转义 '<' 后不会创建源码里的标签或加载资源。
    const decoder = document.createElement("textarea");
    decoder.innerHTML = raw.replace(/</g, "&lt;");
    return decoder.value;
}
