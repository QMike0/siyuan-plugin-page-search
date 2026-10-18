import type {SearchableBlock} from "./dom-types";
import type {BlockTreeLink} from "../shared/block-tree";
import {effectiveCodeBlockLanguage} from "../shared/code-block-language";

/** Same icons and labels as the search scope menu. No preferences are written here. */
export const RESULT_BLOCK_TYPES = {
    docTitle: {icon: "iconFile", label: "settingsIncludeDocTitle"},
    paragraph: {icon: "iconParagraph", label: "settingsIncludeParagraph"},
    heading: {icon: "iconHeadings", label: "settingsIncludeHeading"},
    h1: {icon: "iconHeadings", label: "settingsIncludeHeadingH1"},
    h2: {icon: "iconHeadings", label: "settingsIncludeHeadingH2"},
    h3: {icon: "iconHeadings", label: "settingsIncludeHeadingH3"},
    h4: {icon: "iconHeadings", label: "settingsIncludeHeadingH4"},
    h5: {icon: "iconHeadings", label: "settingsIncludeHeadingH5"},
    h6: {icon: "iconHeadings", label: "settingsIncludeHeadingH6"},
    list: {icon: "iconList", label: "settingsIncludeList"},
    unordered: {icon: "iconList", label: "settingsIncludeListUnordered"},
    ordered: {icon: "iconOrderedList", label: "settingsIncludeListOrdered"},
    task: {icon: "iconCheck", label: "settingsIncludeListTask"},
    math: {icon: "iconMath", label: "settingsIncludeMathBlock"},
    codeBlock: {icon: "iconCode", label: "settingsIncludeCodeBlock"},
    code: {icon: "iconCode", label: "settingsIncludePlainCodeBlock"},
    mermaid: {icon: "iconCode", label: "settingsIncludeMermaid"},
    flowchart: {icon: "iconGraph", label: "settingsIncludeFlowchart"},
    table: {icon: "iconTable", label: "settingsIncludeTable"},
    database: {icon: "iconDatabase", label: "settingsIncludeAttributeView"},
    quote: {icon: "iconQuote", label: "settingsIncludeBlockquote"},
    callout: {icon: "iconCallout", label: "settingsIncludeCallout"},
    super: {icon: "iconSuper", label: "settingsIncludeSuperBlock"},
    tabs: {icon: "iconTabs", label: "settingsIncludeTabs"},
    mindmap: {icon: "iconMindmap", label: "settingsIncludeMindmap"},
    embed: {icon: "iconSQL", label: "settingsIncludeEmbedBlock"},
    html: {icon: "iconHTML5", label: "settingsIncludeHtmlBlock"},
    custom: {icon: "iconPlugin", label: "settingsIncludeCustomBlock"},
} as const;

export type ResultBlockType = keyof typeof RESULT_BLOCK_TYPES;

export const RESULT_BLOCK_TYPE_CHILDREN: Partial<Record<ResultBlockType, readonly ResultBlockType[]>> = {
    heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
    list: ["unordered", "ordered", "task"],
    codeBlock: ["code", "mermaid", "flowchart"],
};

/** Keep exact types in the index; collapse families only for row icons and broad filters. */
export function resultBlockTypeGroup(type: ResultBlockType): ResultBlockType {
    switch (type) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
        case "unordered": case "ordered": case "task": return "list";
        case "code": case "mermaid": case "flowchart": return "codeBlock";
        default: return type;
    }
}

export function isResultBlockType(value: string): value is ResultBlockType {
    return Object.prototype.hasOwnProperty.call(RESULT_BLOCK_TYPES, value);
}

export function passesResultTypeFilter(
    types: readonly ResultBlockType[] | undefined,
    selected: readonly ResultBlockType[] | undefined,
): boolean {
    if (!selected?.length) return true;
    if (!types) return false;
    return selected.every((type) => types.some((value) => value === type || resultBlockTypeGroup(value) === type));
}

function typeOf(type: string, subtype = "", ial = ""): ResultBlockType | undefined {
    switch (type) {
        case "doc-title": return "docTitle";
        case "p": case "NodeParagraph": return "paragraph";
        case "h": case "NodeHeading": return /^h[1-6]$/.test(subtype) ? subtype as ResultBlockType : undefined;
        case "l": case "NodeList":
            if (/custom-sy-list-mindmap[=\s"':]+1/.test(ial)) return "mindmap";
            return subtype === "o" ? "ordered" : subtype === "t" ? "task" : "unordered";
        // List items, tab panels and mindmap nodes belong to their enclosing container.
        case "m": case "NodeMathBlock": return "math";
        case "c": case "NodeCodeBlock":
            return subtype === "mermaid" ? "mermaid" : subtype === "flowchart" ? "flowchart" : "code";
        case "t": case "NodeTable": return "table";
        case "av": case "NodeAttributeView": return "database";
        case "b": case "NodeBlockquote": return "quote";
        case "callout": case "NodeCallout": return "callout";
        case "s": case "NodeSuperBlock": return "super";
        case "tabs": case "NodeTabs": return "tabs";
        case "mindmap": case "NodeMindmap": return "mindmap";
        case "query_embed": case "NodeBlockQueryEmbed": return "embed";
        case "html": case "NodeHTMLBlock": return "html";
        case "custom": case "NodeCustomBlock": return "custom";
    }
}

function parentElement(element: Element): Element | null {
    return element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ?
        (element.getRootNode() as ShadowRoot).host : null);
}

/** One walk per DOM element, shared by all cells/text runs in a collection. */
export function createDomBlockTypeReader(
    outsideMountedRoot?: (id: string) => readonly ResultBlockType[],
): (block: SearchableBlock) => readonly ResultBlockType[] {
    const paths = new WeakMap<Element, readonly ResultBlockType[]>();
    const read = (element: Element | null): readonly ResultBlockType[] => {
        const chain: Element[] = [];
        while (element && !paths.has(element)) {
            chain.push(element);
            element = parentElement(element);
        }
        let path = element ? paths.get(element)! : [];
        for (let index = chain.length - 1; index >= 0; index--) {
            const node = chain[index];
            const id = node.getAttribute("data-node-id");
            // A focused editor can mount a child without its enclosing containers.
            if (!path.length && id && outsideMountedRoot) path = outsideMountedRoot(id);
            // SQL abbreviations are not DOM block names: inline data-type="s" is strikethrough.
            const domType = node.getAttribute("data-type") ?? "";
            const key = domType.startsWith("Node") ?
                typeOf(domType, node.getAttribute("data-subtype") ?? "",
                    node.getAttribute("custom-sy-list-mindmap") === "1" ? 'custom-sy-list-mindmap="1"' : "") : undefined;
            if (key) path = [key, ...path];
            paths.set(node, path);
        }
        return path;
    };
    return (block) => {
        if (block.blockType === "doc-title") return ["docTitle"];
        // Embedded units use the embed's ID/type for navigation, but their
        // text still belongs to the source blocks inside that owner.
        if (block.blockType === "NodeBlockQueryEmbed") {
            return block.blockTypes?.length ? block.blockTypes : read(block.element);
        }
        const path = read(block.element);
        // Renderer projections can have a paragraph source outside their visual host.
        const leaf = typeOf(block.blockType, block.element.getAttribute("data-subtype") ?? "",
            block.element.getAttribute("custom-sy-list-mindmap") === "1" ? 'custom-sy-list-mindmap="1"' : "");
        return leaf && path[0] !== leaf && block.blockType !== "NodeCodeBlock" ? [leaf, ...path] : path;
    };
}

/** Resolve unloaded ancestry from the existing document metadata; no extra API calls. */
export function createResultBlockTypeReader(
    live: readonly SearchableBlock[],
    links: ReadonlyMap<string, BlockTreeLink>,
    codeLanguages: ReadonlyMap<string, {codeLanguage?: string;}>,
): (unit: {blockId: string; blockType: string; blockTypes?: readonly ResultBlockType[];}) => readonly ResultBlockType[] {
    const paths = new Map<string, readonly ResultBlockType[]>();
    const read = (id: string): readonly ResultBlockType[] => {
        const cached = paths.get(id);
        if (cached) return cached;
        const chain: Array<{id: string; key?: ResultBlockType;}> = [];
        const seen = new Set<string>();
        let current = id;
        let tail: readonly ResultBlockType[] = [];
        while (current && !seen.has(current)) {
            seen.add(current);
            const known = paths.get(current);
            if (known) { tail = known; break; }
            const link = links.get(current);
            if (!link) break;
            chain.push({id: current, key: typeOf(link.type,
                link.type === "c" ? effectiveCodeBlockLanguage(
                    link.type,
                    link.subtype,
                    codeLanguages.get(current)?.codeLanguage,
                ) : link.subtype, link.ial)});
            current = link.parentId;
        }
        for (let index = chain.length - 1; index >= 0; index--) {
            const node = chain[index];
            if (node.key) tail = [node.key, ...tail];
            paths.set(node.id, tail);
        }
        return tail;
    };
    // Keep one representative per mounted block, but resolve its DOM ancestry only
    // when a hit actually needs its type path. This avoids a second full DOM walk
    // for searches whose matches are entirely off-screen or empty.
    const mounted = new Map<string, SearchableBlock>();
    const domTypes = createDomBlockTypeReader((id) => read(links.get(id)?.parentId ?? ""));
    for (const block of live) {
        if (block.unitId?.startsWith("embed:")) continue;
        if (!mounted.has(block.blockId)) mounted.set(block.blockId, block);
    }
    return (unit) => {
        const mountedBlock = mounted.get(unit.blockId);
        let path: readonly ResultBlockType[];
        if (mountedBlock) {
            // Canvas/header copies omit source containers. The metadata has the real ancestry.
            path = mountedBlock.matchSource === "projection" && links.has(mountedBlock.blockId) ?
                read(mountedBlock.blockId) : domTypes(mountedBlock);
        } else {
            path = read(unit.blockId);
        }
        if (!path.length) {
            const key = typeOf(unit.blockType);
            path = key ? [key] : [];
        }
        if (unit.blockType === "NodeBlockQueryEmbed" && unit.blockTypes?.length) {
            const boundary = unit.blockTypes.indexOf("embed");
            return [...unit.blockTypes.slice(0, boundary < 0 ? unit.blockTypes.length : boundary), ...path];
        }
        return path;
    };
}
