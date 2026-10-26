import type {SearchableBlock, TableReplaceLock} from "./dom-types";
import {isRangePlainTextOnly, locateTextPoint} from "./ranges";
import {splitTextNodesAtBarriers} from "./text-runs";
import {diagramSourceText} from "./renderer-adapters";

// SiYuan v3.8.8: tableCellRichValue.ts / tableCellRich.ts / render/av/richText.ts.
// A cell's preview is derived data. Only a verified source edit may change it.
export const RICH_CELL_ATTRIBUTE = "data-sy-table-cell-rich";
const MAX_SOURCE_LENGTH = 64 * 1024;
const MAX_OUTPUT_LENGTH = 128 * 1024;
const ALLOWED_BLOCKS = new Set([
    "NodeParagraph", "NodeHeading", "NodeList", "NodeListItem", "NodeBlockquote", "NodeCodeBlock", "NodeMathBlock",
]);
const RENDERED_LANGUAGES = new Set([
    "abc", "echarts", "flowchart", "graphviz", "infographic", "mermaid", "mindmap", "plantuml",
]);
const OMIT = '.protyle-attr, .protyle-action, .protyle-linenumber__rows, svg, style, script, .img, img, .katex, math, [data-type="NodeMathBlock"], ' +
    'span[data-type~="inline-math"], .language-math, .render-node';
type RichLute = Record<string, (...args: any[]) => any>;
let richLute: RichLute | undefined;

/** Separate instance: never change the document editor's Markdown settings. */
function getRichLute(): RichLute {
    if (richLute) return richLute;
    const factory = (window as unknown as {Lute?: {New(): RichLute;};}).Lute;
    if (!factory) throw new Error("rich-cell-lute-unavailable");
    const lute = factory.New();
    for (const name of [
        "FileAnnotationRef", "HTMLTag2TextMark", "TextMark", "InlineMathAllowDigitAfterOpenMarker",
        "ParagraphBeginningSpace", "Sanitize", "ImgPathAllowSpace", "KramdownIAL", "SuperBlock", "Callout", "Tabs",
        "InlineAsterisk", "InlineUnderscore", "Sup", "Sub", "Tag", "InlineMath", "GFMStrikethrough", "Mark",
        "Spin", "ProtyleWYSIWYG", "BlockRef", "DataTask", "ArbitraryTaskListItemMarker", "EnsureListItemParagraph",
        "CustomBlock", "GitConflict", "FullWidthStrikethrough",
    ]) lute[`Set${name}`](true);
    for (const name of [
        "Spellcheck", "ProtyleMarkNetImg", "HeadingID", "YamlFrontMatter", "HeadingAnchor", "ToC",
        "IndentCodeBlock", "Setext", "Footnotes", "LinkRef", "RenderListStyle",
        "GFMStrikethrough1", "ExportNormalizeTaskListMarker", "Emoji",
    ]) lute[`Set${name}`](false);
    lute.SetChineseParagraphBeginningSpace(true);
    lute.SetUnorderedListMarker("-");
    richLute = lute;
    return lute;
}

export function decodeRichCell(encoded: string): string {
    if (encoded.length > MAX_OUTPUT_LENGTH * 8 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new Error("rich-cell-invalid-payload");
    }
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    if (!value || Object.keys(value).length !== 3 || value.spec !== 1 || value.format !== "kramdown" ||
        typeof value.content !== "string" || value.content.includes("\0") || value.content.length > MAX_OUTPUT_LENGTH) {
        throw new Error("rich-cell-unsupported-source");
    }
    return value.content;
}

function encodeRichCell(content: string): string {
    const bytes = new TextEncoder().encode(JSON.stringify({spec: 1, format: "kramdown", content}));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseDOM(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
}

/** Protyle's image renderer inserts standalone caret placeholders next to
 * images. They are not Markdown text and are absent from static previews. */
function isImageCaretPlaceholder(node: Text): boolean {
    return node.data === "\u200b" && [node.previousSibling, node.nextSibling].some(sibling =>
        sibling instanceof HTMLElement && sibling.matches('span.img[data-type="img"]'));
}

/** Ignore layout newlines between preview blocks, never whitespace inside their text. */
function contentTextNodes(root: HTMLElement, model: boolean): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        const parent = text.parentElement;
        if (!text.data || !parent || parent.closest(OMIT) || isImageCaretPlaceholder(text)) continue;
        if (model ? !parent.closest('[contenteditable="true"]') :
            parent.matches("ul, ol, li, blockquote, .table__cell-rich, td, th, [data-type^=Node]") && /^[\r\n]+$/.test(text.data)) continue;
        nodes.push(text);
    }
    return nodes;
}

function previewText(node: Text): string {
    // Lute adds a formatting newline before a nested list, sometimes in the
    // same Text node as the preceding list-item text.
    return node.parentElement?.tagName === "LI" && node.nextSibling instanceof Element &&
        node.nextSibling.matches("ul, ol") ? node.data.replace(/\n$/, "") : node.data;
}

interface CellModel {
    epoch: number;
    encoded: string;
    model: HTMLElement;
    previewNodes: Text[];
    previewSignature: string;
    native: boolean;
    codeLineHeightLayouts?: ReadonlySet<number>;
    offsets: Map<Text, {start: number; text: string; index: number;}>;
    segments: Array<{start: number; end: number; sourceStart: number;}>;
}
const models = new WeakMap<HTMLElement, CellModel>();
const unsupportedModels = new WeakMap<HTMLElement, {encoded: string; signature: string; epoch: number;}>();
const editingTables = new WeakMap<Element, {epoch: number; editing: boolean;}>();
let collectionEpoch = 0;

/** A cell can produce hundreds of search runs. Validate its preview once per
 * collection, then reuse the mapping. Writes always force fresh validation. */
export function beginRichCellSnapshot(): void {
    collectionEpoch += 1;
}

/** Collections run synchronously; do not rescan the whole table for each run. */
export function richCellHasActiveEditor(cell: HTMLElement, verify = false): boolean {
    const table = cell.closest('[data-type="NodeTable"]') ?? cell;
    const cached = editingTables.get(table);
    if (!verify && cached?.epoch === collectionEpoch) return cached.editing;
    const editing = Boolean(table.querySelector(".table__cell-editor"));
    editingTables.set(table, {epoch: collectionEpoch, editing});
    return editing;
}

function readCellModel(cell: HTMLElement, verify = false): CellModel | undefined {
    const encoded = cell.getAttribute(RICH_CELL_ATTRIBUTE);
    if (!encoded || richCellHasActiveEditor(cell, verify)) return undefined;
    let previewSignature: string | undefined;
    try {
        if (encoded.length > MAX_SOURCE_LENGTH * 8) return undefined;
        const cached = models.get(cell);
        const unsupported = unsupportedModels.get(cell);
        if (!verify) {
            if (cached?.encoded === encoded && cached.epoch === collectionEpoch) return cached;
            if (unsupported?.encoded === encoded && unsupported.epoch === collectionEpoch) return undefined;
        }
        const source = decodeRichCell(encoded);
        if (source.length > MAX_SOURCE_LENGTH || cell.querySelectorAll("*").length > 4000) return undefined;
        const previewNodes = contentTextNodes(cell, false);
        const native = Boolean(cell.querySelector(".table__cell-rich > [data-type^=Node]"));
        const codeLineHeightLayouts = native ? nativeCodeLineHeightLayouts(cell) : undefined;
        previewSignature = native ? nativePreviewSemantics(cell, codeLineHeightLayouts) : previewSemantics(cell);
        if (unsupported?.encoded === encoded && unsupported.signature === previewSignature) {
            unsupported.epoch = collectionEpoch;
            return undefined;
        }
        if (cached?.encoded === encoded && cached.previewSignature === previewSignature &&
            previewNodes.length === cached.previewNodes.length && previewNodes.every((node, index) =>
                cached.previewNodes[index] === node && cached.offsets.get(node)?.text === node.data)) {
            cached.epoch = collectionEpoch;
            return cached;
        }
        const lute = getRichLute();
        const model = parseDOM(lute.Md2BlockDOM(source));
        if (model.querySelectorAll("*").length > 4000 || model.querySelector("script, iframe, table")) {
            throw new Error("rich-cell-unsupported-structure");
        }
        for (const block of Array.from(model.querySelectorAll<HTMLElement>('[data-type^="Node"]'))) {
            const type = block.dataset.type;
            const language = (block.querySelector(".protyle-action__language")?.textContent?.trim().toLowerCase() ?? "").split(/\s+/, 1)[0];
            if (!ALLOWED_BLOCKS.has(type) || type === "NodeHeading" && !/^h[1-6]$/.test(block.dataset.subtype ?? "") ||
                Array.from(block.attributes).some(attr => attr.name.startsWith("custom-") &&
                    !(type === "NodeCodeBlock" && attr.name === "custom-sy-code-tab-spaces")) || type === "NodeCodeBlock" &&
                (block.classList.contains("render-node") || RENDERED_LANGUAGES.has(language))) {
                throw new Error("rich-cell-unsupported-block");
            }
        }
        const sourceNodes = contentTextNodes(model, true);
        if (sourceNodes.length > 512) throw new Error("rich-cell-too-many-text-nodes");
        // Soft breaks have no Text node in the preview. Keep source offsets on
        // either side separate; a match may never cross such a boundary.
        const segments: CellModel["segments"] = [];
        let projected = "";
        let sourceStart = 0;
        for (const node of sourceNodes) {
            const pieces = node.parentElement?.closest('[data-type="NodeCodeBlock"]') ? [node.data] : node.data.split("\n");
            for (const [index, piece] of pieces.entries()) {
                // Static previews use BR for soft breaks; native previews keep
                // the LF in a Text node. Keep the LF outside writable spans.
                if (native && index > 0) projected += "\n";
                segments.push({start: projected.length, end: projected.length + piece.length, sourceStart});
                projected += piece;
                sourceStart += piece.length + (pieces.length > 1 ? 1 : 0);
            }
            if (pieces.length > 1) sourceStart -= 1;
        }
        const baseline = serializeModel(model);
        const normalized = parseDOM(lute.Md2BlockDOM(baseline));
        if (projected !== previewNodes.map(previewText).join("") ||
            (native ? previewSignature !== nativePreviewSemantics(model, codeLineHeightLayouts) :
                previewSignature !== previewSemantics(renderPreview(encoded))) ||
            semantics(model) !== semantics(normalized) ||
            (native ? previewSignature !== nativePreviewSemantics(normalized, codeLineHeightLayouts) :
                previewSignature !== previewSemantics(renderPreview(encodeRichCell(baseline))))) {
            throw new Error("rich-cell-preview-source-mismatch");
        }
        const offsets: CellModel["offsets"] = new Map();
        let start = 0;
        for (const node of previewNodes) {
            offsets.set(node, {start, text: node.data, index: offsets.size});
            start += previewText(node).length;
        }
        const state = {encoded, model, offsets, segments, previewNodes, previewSignature, native, codeLineHeightLayouts, epoch: collectionEpoch};
        models.set(cell, state);
        unsupportedModels.delete(cell);
        return state;
    } catch {
        models.delete(cell);
        if (previewSignature !== undefined && richLute) unsupportedModels.set(cell, {encoded, signature: previewSignature, epoch: collectionEpoch});
        return undefined;
    }
}

export interface RichCellSearchInfo {
    snapshot?: {encoded: string; html: string;};
    segments?: Array<{start: number; offset: number; length: number;}>;
    replaceLock?: TableReplaceLock;
}
export interface RichCellCapability {
    replaceLock?: TableReplaceLock;
    writableSpans?: Array<{start: number; end: number;}>;
}
interface RichProjection {
    epoch: number;
    offsets: Map<Text, number>;
    searchOffsets: Map<Text, number>;
    snapshot?: NonNullable<RichCellSearchInfo["snapshot"]>;
}
const projections = new WeakMap<HTMLElement, RichProjection>();
const frozenPreviews = new WeakMap<HTMLElement, NonNullable<RichCellSearchInfo["snapshot"]>>();
const searchCapabilities = new WeakMap<NonNullable<RichCellSearchInfo["snapshot"]>, Array<{start: number; end: number;}> | false>();

function richProjection(cell: HTMLElement): RichProjection {
    const cached = projections.get(cell);
    if (cached?.epoch === collectionEpoch) return cached;
    const offsets = new Map<Text, number>();
    const searchOffsets = new Map<Text, number>();
    let offset = 0;
    let searchOffset = 0;
    for (const node of contentTextNodes(cell, false)) {
        offsets.set(node, offset);
        searchOffsets.set(node, searchOffset);
        const text = previewText(node);
        offset += text.length;
        searchOffset += node.parentElement?.closest('[data-type="NodeCodeBlock"], pre') ? text.length : text.replace(/\n/g, "").length;
    }
    const value = {epoch: collectionEpoch, offsets, searchOffsets};
    projections.set(cell, value);
    return value;
}

/** Freeze only text coordinates and one shared immutable preview per cell.
 * No Lute conversion until this cell actually contributes a search hit. */
export function deferRichCellCapability(block: SearchableBlock): RichCellSearchInfo | undefined {
    const cell = block.element.closest<HTMLElement>(`[${RICH_CELL_ATTRIBUTE}]`);
    if (!cell) return undefined;
    if (richCellHasActiveEditor(cell)) return {replaceLock: "table-cell-editor"};
    if (cell !== block.element || block.matchSource && block.matchSource !== "text") return {replaceLock: "table-rich"};
    const encoded = cell.getAttribute(RICH_CELL_ATTRIBUTE)!;
    if (encoded.length > MAX_SOURCE_LENGTH * 8) return {replaceLock: "table-rich"};
    const projection = richProjection(cell);
    if (!projection.snapshot) {
        const html = cell.innerHTML;
        if (html.length > MAX_OUTPUT_LENGTH * 16) return {replaceLock: "table-rich"};
        const previous = frozenPreviews.get(cell);
        projection.snapshot = previous?.encoded === encoded && previous.html === html ? previous : {encoded, html};
        frozenPreviews.set(cell, projection.snapshot);
    }
    const segments: NonNullable<RichCellSearchInfo["segments"]> = [];
    let offset = 0;
    const prefix = block.textStartOffset ?? 0;
    for (const node of block.textNodes) {
        const start = projection.offsets.get(node);
        const from = Math.max(offset, prefix);
        const to = Math.min(offset + previewText(node).length, prefix + block.text.length);
        if (start !== undefined && to > from) segments.push({start: start + from - offset, offset: from - prefix, length: to - from});
        offset += node.data.length;
    }
    return {snapshot: projection.snapshot, segments};
}

/** Results are published only after hit cells have been validated. Cache pure
 * ranges, never detached DOM; yield between cells and abandon cancelled work. */
export async function resolveRichCellCapabilities(
    infos: Iterable<RichCellSearchInfo>,
    isCurrent: () => boolean = () => true,
): Promise<Map<RichCellSearchInfo, RichCellCapability> | undefined> {
    const result = new Map<RichCellSearchInfo, RichCellCapability>();
    let started = Date.now();
    for (const info of infos) {
        if (result.has(info)) continue;
        if (Date.now() - started >= 8) {
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
            started = Date.now();
        }
        if (!isCurrent()) return undefined;
        const snapshot = info.snapshot;
        if (!snapshot) {
            result.set(info, {replaceLock: info.replaceLock, writableSpans: []});
            continue;
        }
        let ranges = searchCapabilities.get(snapshot);
        if (ranges === undefined) {
            const cell = document.createElement("td");
            cell.setAttribute(RICH_CELL_ATTRIBUTE, snapshot.encoded);
            cell.innerHTML = snapshot.html;
            const state = readCellModel(cell);
            ranges = state ? state.segments.map(({start, end}) => ({start, end})) : false;
            searchCapabilities.set(snapshot, ranges);
        }
        if (!ranges) {
            result.set(info, {replaceLock: "table-rich", writableSpans: []});
            continue;
        }
        const writableSpans: NonNullable<RichCellCapability["writableSpans"]> = [];
        for (const piece of info.segments ?? []) {
            let low = 0;
            let high = ranges.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (ranges[middle].end <= piece.start) low = middle + 1;
                else high = middle;
            }
            for (let index = low; index < ranges.length; index += 1) {
                const range = ranges[index];
                if (range.start >= piece.start + piece.length) break;
                const start = Math.max(range.start, piece.start);
                const end = Math.min(range.end, piece.start + piece.length);
                if (end > start) writableSpans.push({start: piece.offset + start - piece.start, end: piece.offset + end - piece.start});
            }
        }
        result.set(info, {writableSpans});
    }
    return isCurrent() ? result : undefined;
}

export function isSupportedRichCell(cell: HTMLElement): boolean {
    return Boolean(readCellModel(cell));
}

export function richCellWritableSpans(block: SearchableBlock): Array<{start: number; end: number;}> | undefined {
    const cell = block.element.closest<HTMLElement>(`[${RICH_CELL_ATTRIBUTE}]`);
    if (!cell) return undefined;
    if (cell !== block.element || block.matchSource && block.matchSource !== "text") return [];
    const state = readCellModel(block.element);
    if (!state) return [];
    const spans: Array<{start: number; end: number;}> = [];
    let offset = 0;
    for (const node of block.textNodes) {
        const mapped = state.offsets.get(node);
        if (mapped && mapped.text === node.data) {
            const mappedEnd = mapped.start + previewText(node).length;
            let low = 0;
            let high = state.segments.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (state.segments[middle].end <= mapped.start) low = middle + 1;
                else high = middle;
            }
            for (let index = low; index < state.segments.length; index += 1) {
                const segment = state.segments[index];
                if (segment.start >= mappedEnd) break;
                const start = Math.max(mapped.start, segment.start);
                const end = Math.min(mappedEnd, segment.end);
                const prefix = block.textStartOffset ?? 0;
                const from = Math.max(0, offset + start - mapped.start - prefix);
                const to = Math.min(block.text.length, offset + end - mapped.start - prefix);
                if (to > from) spans.push({start: from, end: to});
            }
        }
        offset += node.data.length;
    }
    return spans;
}

/** Ignore generated identities/UI only; keep every persisted mark, URL, style and code setting. */
function semantics(root: HTMLElement): string {
    const ignored = new Set(["data-node-id", "data-node-index", "updated", "class", "spellcheck", "contenteditable"]);
    const visit = (node: Node): unknown[] => {
        if (node.nodeType === Node.TEXT_NODE) return [node.nodeValue ?? ""];
        if (!(node instanceof HTMLElement) || node.matches(".protyle-attr, .protyle-action, wbr")) return [];
        const children = mergeText(Array.from(node.childNodes).flatMap(visit));
        const attrs = Array.from(node.attributes).filter(attr => !ignored.has(attr.name) &&
            !(attr.name === "data-marker" && node.dataset.subtype !== "o"))
            .sort((a, b) => a.name.localeCompare(b.name)).map(attr => [attr.name, attr.value]);
        if (node.matches('span[data-type="text"], span[data-type="backslash"]') && attrs.length === 1) return children;
        if (node.tagName === "SPAN" && children.every(child => child === "") && !node.hasAttribute("data-content")) return [];
        if (node.tagName === "BR") return ["\n"];
        if (node.matches('[data-type="NodeParagraph"] > [contenteditable="true"]') &&
            children.length <= 1 && ["", " ", "\u200b"].includes(String(children[0] ?? ""))) children.length = 0;
        const language = node.dataset.type === "NodeCodeBlock" ?
            node.querySelector(".protyle-action__language")?.textContent ?? "" : "";
        const task = node.dataset.type === "NodeListItem" && node.classList.contains("protyle-task--done");
        return [[node.tagName, attrs, language, task, children]];
    };
    return JSON.stringify(mergeText(Array.from(root.childNodes).flatMap(visit)));
}

function mergeText(values: unknown[]): unknown[] {
    const result: unknown[] = [];
    for (const value of values) {
        if (typeof value === "string" && typeof result[result.length - 1] === "string") {
            result[result.length - 1] += value;
        } else if (value !== "") result.push(value);
    }
    return result;
}

/** Native previews retain the BlockDOM structure, without document identities.
 * Ignore only host-generated controls/highlighting; persisted marks and block
 * attributes must still agree with the source model. */
function nativeCodeLineHeightLayouts(root: HTMLElement): ReadonlySet<number> {
    const editor = (window as unknown as {siyuan?: {config?: {editor?: {
        fontSize?: number; codeSyntaxHighlightLineNum?: boolean;
    };};};}).siyuan?.config?.editor;
    const layouts = new Set<number>();
    root.querySelectorAll<HTMLElement>('[data-type="NodeCodeBlock"]').forEach((node, index) => {
        const lineNumber = node.getAttribute("linenumber");
        const code = node.querySelector(":scope > .hljs");
        if (lineNumber === "false" || lineNumber !== "true" && !editor?.codeSyntaxHighlightLineNum ||
            code?.getAttribute("data-render") !== "true" || !code.firstElementChild?.classList.contains("protyle-linenumber__rows")) return;
        const fontSize = parseInt(node.style.fontSize) || editor?.fontSize;
        // v3.8.8 lineNumberRender writes exactly this derived root style.
        if (Number.isFinite(fontSize) && fontSize > 0 && !node.style.getPropertyPriority("line-height") &&
            node.style.lineHeight === `${(fontSize * 1.625 * 0.85).toFixed(0)}px`) layouts.add(index);
    });
    return layouts;
}

function nativePreviewSemantics(root: HTMLElement, codeLineHeightLayouts?: ReadonlySet<number>): string {
    const ignored = new Set([
        "id", "data-node-id", "data-node-index", "updated", "class", "spellcheck", "contenteditable", "draggable",
        "data-table-cell-node", "data-table-cell-content", "data-render", "data-protyle-lite-render",
    ]);
    let codeIndex = 0;
    const visit = (node: Node): unknown[] => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.parentElement?.matches(".table__cell-rich, [data-type^=Node]") && /^[\r\n]+$/.test(node.nodeValue ?? "")) return [];
            return [node.nodeValue ?? ""];
        }
        if (!(node instanceof HTMLElement) || node.matches(".protyle-attr, .protyle-action, .protyle-linenumber__rows, wbr")) return [];
        if (node.matches(".table__cell-rich")) return mergeText(Array.from(node.childNodes).flatMap(visit));
        const derivedLineHeight = node.dataset.type === "NodeCodeBlock" && codeLineHeightLayouts?.has(codeIndex++);
        const attrs = Array.from(node.attributes).filter(attr => !ignored.has(attr.name) &&
            !(attr.name === "data-task" && node.dataset.type === "NodeListItem") &&
            !(attr.name === "data-marker" && node.dataset.subtype !== "o"))
            .sort((a, b) => a.name.localeCompare(b.name)).flatMap(attr => {
                if (attr.name !== "style" || !derivedLineHeight) return [[attr.name, attr.value]];
                const style = document.createElement("span").style;
                style.cssText = attr.value;
                style.removeProperty("line-height");
                return style.cssText ? [[attr.name, style.cssText]] : [];
            });
        if (node.dataset.type === "NodeCodeBlock") {
            const body = node.querySelector(":scope > .hljs")?.lastElementChild;
            if (!body || Array.from(body.querySelectorAll("*")).some(child =>
                child.tagName !== "SPAN" || child.hasAttribute("data-type"))) return [["invalid-code-preview"]];
            return [[node.tagName, attrs, node.querySelector(".protyle-action__language")?.textContent ?? "", body.textContent]];
        }
        if (node.dataset.type === "NodeMathBlock" || node.matches('span[data-type~="inline-math"]')) {
            return [[node.tagName, attrs]];
        }
        const children = mergeText(Array.from(node.childNodes).flatMap(visit));
        if (node.matches('span[data-type="text"], span[data-type="backslash"]') && attrs.length === 1) return children;
        if (node.tagName === "SPAN" && !children.length && !node.hasAttribute("data-content")) return [];
        if (node.tagName === "BR") return ["\n"];
        if (node.parentElement?.dataset.type === "NodeParagraph" && children.length <= 1 &&
            ["", " ", "\u200b"].includes(String(children[0] ?? ""))) children.length = 0;
        // The host sanitizer drops data-task; task completion survives in this class.
        const task = node.dataset.type === "NodeListItem" && node.classList.contains("protyle-task--done");
        return [[node.tagName, attrs, task, children]];
    };
    // Layout identity belongs in the cache key, including when line numbers toggle.
    return JSON.stringify([Array.from(codeLineHeightLayouts ?? []), mergeText(Array.from(root.childNodes).flatMap(visit))]);
}

/** Stable rich-cell offsets exclude static HTML layout newlines. They survive
 * the host switching between saved HTML and native BlockDOM previews. */
export function richCellSearchRuns(cell: HTMLElement, nodes: Text[]): Array<{nodes: Text[]; text: string; offset: number; nodeOffset: number;}> | undefined {
    if (!cell.hasAttribute(RICH_CELL_ATTRIBUTE) || richCellHasActiveEditor(cell)) return undefined;
    const {searchOffsets} = richProjection(cell);
    const body = nodes.filter(node => !isImageCaretPlaceholder(node) && !node.parentElement?.closest('.protyle-linenumber__rows, [data-type="NodeMathBlock"], .language-math') &&
        !(node.parentElement?.matches("ul, ol, li, blockquote, .table__cell-rich, td, th, [data-type^=Node]") && /^[\r\n]+$/.test(node.data)));
    const result: Array<{nodes: Text[]; text: string; offset: number; nodeOffset: number;}> = [];
    let renderedOffset = MAX_OUTPUT_LENGTH * 16;
    for (const run of splitTextNodesAtBarriers(body)) {
        const text = run.map(previewText).join("");
        const lines = run[0].parentElement?.closest('[data-type="NodeCodeBlock"], pre') ? [text] : text.split("\n");
        const base = searchOffsets.get(run[0]) ?? renderedOffset;
        renderedOffset += text.length + 1;
        let cursor = 0;
        let logical = 0;
        let first = 0;
        let nodeStart = 0;
        for (const line of lines) {
            while (first < run.length && nodeStart + run[first].data.length <= cursor) nodeStart += run[first++].data.length;
            if (line && first < run.length) {
                let end = first;
                let endOffset = nodeStart + run[end].data.length;
                while (endOffset < cursor + line.length && end + 1 < run.length) endOffset += run[++end].data.length;
                result.push({nodes: run.slice(first, end + 1), text: line, offset: base + logical, nodeOffset: cursor - nodeStart});
            }
            cursor += line.length + 1;
            logical += line.length;
        }
    }
    return result;
}

/** Math has independent read-only units, never writable body offsets. Walk
 * once per cell so many formulas do not repeatedly rescan preceding text. */
export function richCellMathBlocks(cell: HTMLElement): Array<{element: HTMLElement; offset: number; source: string;}> {
    if (!cell.hasAttribute(RICH_CELL_ATTRIBUTE)) return [];
    const root = tableMathRoot(cell);
    if (!root.querySelector('[data-type="NodeMathBlock"], div.language-math')) return [];
    const {searchOffsets} = richProjection(cell);
    const found: ReturnType<typeof richCellMathBlocks> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node instanceof HTMLElement && node.matches('[data-type="NodeMathBlock"], div.language-math')) {
            found.push({element: node, offset, source: node.hasAttribute("data-content") ?
                diagramSourceText(node) : node.textContent ?? ""});
        } else if (node instanceof Text) {
            const start = searchOffsets.get(node);
            if (start !== undefined) offset = start + (node.parentElement?.closest('[data-type="NodeCodeBlock"], pre') ?
                previewText(node).length : previewText(node).replace(/\n/g, "").length);
        }
    }
    return found;
}

function tableMathRoot(cell: HTMLElement): HTMLElement {
    return cell.querySelector<HTMLElement>(".table__cell-editor .protyle-wysiwyg") ?? cell;
}

/** Compare the source projection with the real preview, including block/mark
 * boundaries. Syntax highlighting is the only wrapper we flatten here. */
function previewSemantics(root: HTMLElement): string {
    const visit = (node: Node): unknown[] => {
        if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentElement;
            if (parent?.matches("ul, ol, li, blockquote, .table__cell-rich, td, th") && /^[\r\n]+$/.test(node.nodeValue ?? "")) return [];
            return [previewText(node as Text)];
        }
        if (!(node instanceof HTMLElement)) return [];
        if (node.matches(".katex, svg, .protyle-attr, .protyle-action")) return [];
        if (node.matches('.language-math, span[data-type~="inline-math"]')) {
            return [["math", node.hasAttribute("data-content") ?
                diagramSourceText(node) : node.textContent]];
        }
        const children = mergeText(Array.from(node.childNodes).flatMap(visit));
        if (node.matches(".table__cell-rich") || node.tagName === "SPAN" &&
            node.closest("pre > code") && !node.hasAttribute("data-type")) return children;
        if (node.tagName === "BR") return ["\n"];
        if (node.matches("span, a") && !children.length) return [];
        if (node.matches("p, li") && children.length <= 1 && ["", " ", "\u200b"].includes(String(children[0] ?? ""))) children.length = 0;
        if (node.tagName === "LI" && node.querySelector(":scope > input[data-task]") &&
            children.length === 2 && children[1] === " ") children.pop();
        // Lute's BlockDOM serializer normalizes tight nested lists to a
        // paragraph wrapper. The source still has the same single paragraph;
        // keep multiple paragraphs distinct.
        if (node.tagName === "P" && node.parentElement?.tagName === "LI" &&
            node.parentElement.querySelectorAll(":scope > p").length === 1 &&
            Array.from(node.attributes).every(attr => attr.name === "class" && attr.value === "indent--2")) return children;
        const attrs = Array.from(node.attributes).filter(attr =>
            !["contenteditable", "spellcheck", "data-render"].includes(attr.name) &&
            (attr.name !== "class" || !node.matches("code, p.indent--2")))
            .sort((a, b) => a.name.localeCompare(b.name)).map(attr => [attr.name, attr.value]);
        return [[node.tagName, attrs, children]];
    };
    return JSON.stringify(mergeText(Array.from(root.childNodes).flatMap(visit)));
}

function renderPreview(encoded: string): HTMLElement {
    const preview = parseDOM(getRichLute().SpinBlockDOM(
        '<div data-type="NodeTable" data-node-id="20261025000000-psrich0"><div contenteditable="true">' +
        `<table><thead><tr><th ${RICH_CELL_ATTRIBUTE}="${encoded}"></th></tr></thead></table></div></div>`,
    )).querySelector("th");
    if (!preview) throw new Error("rich-cell-preview-unavailable");
    return preview;
}

/** Native rich-cell whitespace/literal protection, applied to a private source-model clone. */
function serializeModel(model: HTMLElement): string {
    const root = model.cloneNode(true) as HTMLElement;
    root.querySelectorAll("wbr, .protyle-attr, .protyle-icons").forEach(node => node.remove());
    let prefix = "SYTABLECELLWHITESPACE";
    while (root.innerHTML.includes(prefix)) prefix += "X";
    const whitespace: string[] = [];
    const protect = (value: string) => {
        const token = `${prefix}${whitespace.length}END`;
        whitespace.push(Array.from(value, character => character === "\n" ? "<br />" :
            `&#${character.codePointAt(0)};`).join(""));
        return token;
    };
    if (root.childElementCount > 1 || root.querySelector('[data-type="NodeList"]')) {
        root.querySelectorAll('[data-type="NodeParagraph"] > [contenteditable="true"]').forEach(paragraph => {
            if (!paragraph.innerHTML.replace(/\u200b/g, "").trim()) paragraph.textContent = protect(" ");
        });
    }
    root.querySelectorAll("br").forEach(br => {
        if (!br.closest('[data-type="NodeCodeBlock"], [data-type="NodeMathBlock"], .img')) br.replaceWith(protect("\n"));
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        if (text.parentElement?.closest('[contenteditable="true"]') &&
            !text.parentElement.closest('[data-type="NodeCodeBlock"], [data-type="NodeMathBlock"], .img')) {
            // Entity tokens also protect literal punctuation inside marks; plain
            // Markdown escaping there can accidentally close bold/link syntax.
            if (!text.parentElement.closest('span[data-type~="code"]')) {
                text.data = text.data.replace(/^[ \t]+|[ \t]+$|\n|[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, protect);
            }
        }
    }
    // As in v3.8.8, code settings need adjacent block IDs for unambiguous IAL.
    const keepIds = Boolean(root.querySelector('[data-type="NodeCodeBlock"]:is([linewrap], [ligatures], [linenumber], [custom-sy-code-tab-spaces])')) ||
        Array.from(root.querySelectorAll('[data-type="NodeParagraph"] > [contenteditable="true"]'))
            .some(paragraph => paragraph.textContent === "");
    root.querySelectorAll("[data-node-id], [data-node-index], [updated]").forEach(node => {
        if (!keepIds) node.removeAttribute("data-node-id");
        node.removeAttribute("data-node-index");
        node.removeAttribute("updated");
    });
    return getRichLute().BlockDOM2Md(root.innerHTML).trim().replace(new RegExp(`${prefix}(\\d+)END`, "g"),
        (_token: string, index: string) => whitespace[Number(index)]);
}

export interface RichCellEdit {
    nodes: Text[];
    nodeOffset?: number;
    start: number;
    end: number;
    matchedText: string;
    text: string;
}

/** All edits in a cell use original offsets; render/serialize once, then publish atomically. */
export function prepareRichCellEdit(cell: HTMLElement, edits: RichCellEdit[]): {encoded: string; html: string;} | undefined {
    const state = readCellModel(cell, true);
    if (!state || !edits.length) return undefined;
    try {
        const model = state.model.cloneNode(true) as HTMLElement;
        const sourceNodes = contentTextNodes(model, true);
        const sourceText = sourceNodes.map(node => node.data).join("");
        const expectedPreview = cell.cloneNode(true) as HTMLElement;
        const expectedNodes = contentTextNodes(expectedPreview, false);
        const mapped = edits.map(edit => {
            const start = locateTextPoint(edit.nodes, edit.start + (edit.nodeOffset ?? 0), "start");
            const end = locateTextPoint(edit.nodes, edit.end + (edit.nodeOffset ?? 0), "end");
            const first = start && state.offsets.get(start.node);
            const last = end && state.offsets.get(end.node);
            if (!first || !last || start.node !== end.node || first.text !== start.node.data || last.text !== end.node.data) throw new Error("stale-rich-cell");
            const projectedStart = first.start + start.offset;
            const projectedEnd = last.start + end.offset;
            let low = 0;
            let high = state.segments.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (state.segments[middle].end <= projectedStart) low = middle + 1;
                else high = middle;
            }
            const segment = state.segments[low];
            if (!segment || projectedEnd <= projectedStart || projectedStart < segment.start || projectedEnd > segment.end) {
                throw new Error("rich-cell-range-crosses-structure");
            }
            return {...edit, previewIndex: first.index, previewStart: start.offset, previewEnd: end.offset,
                start: segment.sourceStart + projectedStart - segment.start,
                end: segment.sourceStart + projectedEnd - segment.start};
        }).sort((a, b) => b.start - a.start);
        let boundary = sourceText.length;
        let outputLength = sourceText.length;
        for (const edit of mapped) {
            if (edit.end <= edit.start || edit.end > boundary || sourceText.slice(edit.start, edit.end) !== edit.matchedText || edit.text.includes("\0")) return undefined;
            boundary = edit.start;
            outputLength += edit.text.length - (edit.end - edit.start);
            if (outputLength > MAX_OUTPUT_LENGTH) return undefined;
        }
        if (mapped.every(edit => edit.text === edit.matchedText)) return {encoded: state.encoded, html: cell.innerHTML};
        for (const edit of mapped) {
            const start = locateTextPoint(sourceNodes, edit.start, "start");
            const end = locateTextPoint(sourceNodes, edit.end, "end");
            if (!start || !end) return undefined;
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            if (!isRangePlainTextOnly(range) || range.toString() !== edit.matchedText) return undefined;
            if (edit.text === edit.matchedText) continue;
            const expectedNode = expectedNodes[edit.previewIndex];
            expectedNode.data = expectedNode.data.slice(0, edit.previewStart) + edit.text + expectedNode.data.slice(edit.previewEnd);
            const reference = start.node.parentElement?.closest('span[data-type~="block-ref"][data-subtype="d"]');
            if (start.node === end.node) {
                start.node.data = start.node.data.slice(0, start.offset) + edit.text + start.node.data.slice(end.offset);
            } else {
                range.deleteContents();
                range.insertNode(document.createTextNode(edit.text));
            }
            reference?.setAttribute("data-subtype", "s");
            if (reference) expectedNode.parentElement?.closest('span[data-type~="block-ref"][data-subtype="d"]')?.setAttribute("data-subtype", "s");
        }
        const markdown = serializeModel(model);
        if (markdown.length > MAX_OUTPUT_LENGTH) return undefined;
        const lute = getRichLute();
        if (semantics(model) !== semantics(parseDOM(lute.Md2BlockDOM(markdown)))) return undefined;
        const encoded = encodeRichCell(markdown);
        if (state.native) {
            if (nativePreviewSemantics(expectedPreview, state.codeLineHeightLayouts) !==
                nativePreviewSemantics(parseDOM(lute.Md2BlockDOM(markdown)), state.codeLineHeightLayouts)) return undefined;
            return {encoded, html: expectedPreview.innerHTML};
        }
        const preview = renderPreview(encoded);
        if (previewSemantics(expectedPreview) !== previewSemantics(preview)) return undefined;
        return {encoded, html: preview.innerHTML};
    } catch {
        return undefined;
    }
}

export function publishRichCellEdit(cell: HTMLElement, prepared: {encoded: string; html: string;}): void {
    if (cell.getAttribute(RICH_CELL_ATTRIBUTE) === prepared.encoded) return;
    cell.setAttribute(RICH_CELL_ATTRIBUTE, prepared.encoded);
    cell.removeAttribute("data-sy-table-cell-inline");
    cell.setAttribute("contenteditable", "false");
    cell.innerHTML = prepared.html;
    cell.closest('[data-type="NodeTable"]')?.setAttribute("custom-sy-table-rich", "1");
    models.delete(cell);
    unsupportedModels.delete(cell);
}
