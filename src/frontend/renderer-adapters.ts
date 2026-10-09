import {
    DIAGRAM_CODE_LANGUAGES,
    DIAGRAM_CODE_LANGUAGE_SET,
} from "../shared/code-block-language";
import {ZERO_WIDTH_GLOBAL_RE} from "../shared/constants";
import {rendererUnitId} from "../shared/renderer-units";
import type {SearchableBlock} from "./dom-types";
import {splitTextNodesAtBarriers} from "./text-runs";
import {omitAuthorCssHiddenText} from "./visibility";

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
 * Mermaid / flowchart 没有 renderer 文本时会返回一个明确标记的源码兜底单元；
 * 其他 renderer 仍返回 []，不会把源码误当成公式或 HTML 的可见字。
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
        const textNodes = omitAuthorCssHiddenText(collectTextNodes(boundary, (parent) => {
            const ariaHidden = parent.closest('[aria-hidden="true"]');
            if (ariaHidden && !parent.closest("svg")) {
                return false;
            }
            return !parent.closest(
                ".protyle-attr, .protyle-icons, style, script, textarea, noscript, title, desc, template, [hidden]",
            );
        }));
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
    if (units.length === 0 && (kind === "mermaid" || kind === "flowchart")) {
        // Mermaid / flowchart 的源码通常包含节点标签；当思源 renderer 尚未挂载
        // SVG（例如首次打开的折叠块）时，保留一份不可定位的源码单元，避免整块
        // 被误报为“未完成解析”。有 SVG 时仍只使用真正的可见文字，避免重复命中。
        const source = diagramSourceText(element);
        if (meaningful(source)) {
            units.push({
                ...context,
                element,
                text: source,
                textNodes: [],
                // 源码只是召回兜底，不能按普通正文定位或替换；沿用统一
                // renderer 单元标识也能让缓存、跳转和替换门闩保持一致。
                unitId: rendererUnitId("source-fallback", kind),
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

/** 返回图表块里的源码文本，用于 renderer 尚未完成时的召回候选判断。 */
export function diagramSourceText(element: HTMLElement): string {
    const raw = element.getAttribute("data-content");
    if (!raw) {
        return "";
    }
    const lute = (window as Window & {Lute?: {UnEscapeHTMLStr?: (value: string) => string;};}).Lute;
    if (typeof lute?.UnEscapeHTMLStr === "function") {
        try {
            return lute.UnEscapeHTMLStr(raw);
        } catch {
            // DOM decoding below is sufficient for ordinary entities.
        }
    }
    const textarea = document.createElement("textarea");
    textarea.innerHTML = raw;
    return textarea.value;
}
