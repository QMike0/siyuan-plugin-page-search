import {isImageOCRUnit} from "../shared/image-ocr";
import {DIAGRAM_CODE_LANGUAGE_SET, isCodeLanguageUnit} from "../shared/code-block-language";
import {isRendererUnitId} from "../shared/renderer-units";
import {ZERO_WIDTH_RE} from "../shared/constants";
import type {SearchMatch} from "./dom-types";

export type ReplacementSkipReason =
    | "docTitle" | "embed" | "database" | "math" | "inlineMath" | "html" | "custom"
    | "mermaid" | "flowchart" | "graphviz" | "plantuml" | "chart" | "mindmap" | "abc"
    | "imageOCR" | "codeLanguage" | "tabsTitle" | "richCell" | "cellEditing" | "tablePending" | "marker" | "preview" | "readonly" | "complex";

/** Describe an already rejected match; never decide or broaden writability.
 * Cached metadata works offscreen. Ancestor-only fallback is cached per node;
 * no block fetching, source conversion or document traversal is needed. */
export function createReplacementReasonReader(): (match: SearchMatch) => ReplacementSkipReason {
    const domReasons = new WeakMap<Element, ReplacementSkipReason>();
    return (match) => {
        if (match.blockId === "__doc-title__" || match.blockType === "doc-title" || match.unitId === "doc-title") return "docTitle";
        if (match.unitId?.startsWith("embed:") || match.blockType === "NodeBlockQueryEmbed") return "embed";
        if (isImageOCRUnit(match)) return "imageOCR";
        if (isCodeLanguageUnit(match)) return "codeLanguage";
        if (match.blockType === "NodeAttributeView") return "database";
        if (match.blockType === "NodeCustomBlock" || match.blockTypes?.includes("custom")) return "custom";
        if (match.highlightKind === "inline-math" || match.blockType === "inline-math" || match.unitId?.startsWith("inline-math:")) return "inlineMath";
        if (match.blockType === "NodeMathBlock") return "math";
        if (match.blockType === "NodeHTMLBlock" || match.unitId === "html-block-rendered") return "html";
        if (match.unitId === "mermaid-source") return "mermaid";
        if (isRendererUnitId(match.unitId)) {
            const kind = match.unitId!.split(":", 3)[2];
            if (kind === "math" || kind === "html") return kind;
            if (DIAGRAM_CODE_LANGUAGE_SET.has(kind)) return kind as ReplacementSkipReason;
            return "preview";
        }
        if (match.replaceLock === "table-cell-editor") return "cellEditing";
        if (match.replaceLock === "table-rich") return "richCell";
        if (match.replaceReason) return match.replaceReason;
        if (ZERO_WIDTH_RE.test(match.matchedText)) return "marker";
        if (match.unitId === "diagram-rendered" || match.blockType === "preview" ||
            match.blockId === "__preview__" || match.blockId.startsWith("__preview__-")) return "preview";
        const node = match.range?.commonAncestorContainer;
        if (!node) return "complex";
        const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        if (!element) return "complex";
        const cached = domReasons.get(element);
        if (cached) return cached;
        let reason: ReplacementSkipReason = "complex";
        if (element.closest('[data-type="NodeCustomBlock"]')) reason = "custom";
        else if (element.closest('[tabs-title="true"], .tabs-header')) reason = "tabsTitle";
        else if (element.closest('[data-type~="inline-math"]')) reason = "inlineMath";
        else if (element.closest('[data-type="NodeMathBlock"], [data-subtype="math"]')) reason = "math";
        else if (element.closest('[data-type="NodeHTMLBlock"], protyle-html')) reason = "html";
        else {
            const language = element.closest('[data-type="NodeCodeBlock"]')?.getAttribute("data-subtype");
            const locked = element.closest('[contenteditable="false"]');
            const editable = element.closest('[contenteditable="true"]');
            const structural = match.blockType === "NodeTable" && element.closest('td, th, .table__cell, [data-type="NodeTableCell"]') ||
                match.blockType === "NodeCallout" && element.closest(".callout-title") || element.closest(".img .protyle-action__title");
            if (language && DIAGRAM_CODE_LANGUAGE_SET.has(language)) reason = language as ReplacementSkipReason;
            else if (element.closest(".mindmap-view")) reason = "preview";
            else if (locked && !(editable && locked.contains(editable)) && !structural) reason = "readonly";
        }
        domReasons.set(element, reason);
        return reason;
    };
}
