import {ZERO_WIDTH_GLOBAL_RE} from "../shared/constants";
import {rendererUnitId} from "../shared/renderer-units";
import type {SearchableBlock} from "./dom-types";

const CODE_BLOCK_TYPE = "NodeCodeBlock";
const MATH_BLOCK_TYPE = "NodeMathBlock";
const HTML_BLOCK_TYPE = "NodeHTMLBlock";

export const DIAGRAM_SUBTYPES = [
    "mermaid",
    "flowchart",
    "graphviz",
    "plantuml",
    "chart",
    "mindmap",
    "abc",
] as const;

export type DiagramSubtype = (typeof DIAGRAM_SUBTYPES)[number];
export type RendererAdapterKind = DiagramSubtype | "math" | "html";

export const DIAGRAM_SUBTYPE_SET = new Set<string>(DIAGRAM_SUBTYPES);

interface RendererContext {
    blockId: string;
    blockType: string;
    blockIndex: number;
}

/** 返回块所使用的 adapter；普通正文/普通代码块返回 null。 */
export function rendererAdapterKind(element: HTMLElement): RendererAdapterKind | null {
    const blockType = element.getAttribute("data-type") ?? "";
    if (blockType === MATH_BLOCK_TYPE) {
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

/**
 * live DOM 与离屏 DOM 共用的 renderer 采集入口。
 * 返回 [] 表示 renderer 尚未产生可搜索 Text；不会用 data-content 源码冒充可见字。
 */
export function collectRendererSearchUnits(
    element: HTMLElement,
    context: RendererContext,
    kind: RendererAdapterKind | null = rendererAdapterKind(element),
): SearchableBlock[] {
    if (!kind) {
        return [];
    }
    if (kind === "math") {
        return collectMathUnits(element, context);
    }
    if (kind === "html") {
        return collectHtmlUnits(element, context);
    }
    return collectDiagramUnits(element, context, kind);
}

function collectMathUnits(element: HTMLElement, context: RendererContext): SearchableBlock[] {
    // 思源 mathRender 使用 output="html"；只取可见字形层，避免 MathML/源码重复。
    const katexHtml = element.querySelector<HTMLElement>(".katex-html");
    if (!katexHtml) {
        return [];
    }
    const textNodes = collectTextNodes(katexHtml, (parent) => {
        return !parent.closest(".katex-mathml, math, annotation, svg, style, script");
    });
    return singleRenderedUnit(element, context, "math", textNodes);
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
    return singleRenderedUnit(element, context, "html", textNodes);
}

function collectDiagramUnits(
    element: HTMLElement,
    context: RendererContext,
    kind: DiagramSubtype,
): SearchableBlock[] {
    // 一个 SVG text / foreignObject 是一个视觉标签；同一 text 内的 tspan 仍可跨样式匹配。
    // 这样既不会把相邻标签 foo + bar 拼成 foobar，也保留单个标签内部的精确 Range。
    const boundaries = Array.from(
        element.querySelectorAll<SVGTextElement | SVGForeignObjectElement>("svg text, svg foreignObject"),
    ).filter((boundary) => {
        if (boundary.closest(".protyle-attr, .protyle-icons")) {
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
        const textNodes = collectTextNodes(boundary, (parent) => {
            return !parent.closest(".protyle-attr, .protyle-icons, style, script, textarea, noscript");
        });
        const text = textNodes.map((node) => node.nodeValue ?? "").join("");
        if (!meaningful(text)) {
            continue;
        }
        units.push({
            ...context,
            element,
            text,
            textNodes,
            unitId: rendererUnitId("rendered-text", kind, units.length),
        });
    }
    return units;
}

function singleRenderedUnit(
    element: HTMLElement,
    context: RendererContext,
    kind: "math" | "html",
    textNodes: Text[],
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
        unitId: rendererUnitId("rendered-text", kind),
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
            const parent = node.parentElement;
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
