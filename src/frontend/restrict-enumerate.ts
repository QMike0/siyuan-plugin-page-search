/**
 * 限制查找 · 空查询枚举：按所选行内类型列出整段宿主（非关键词匹配）。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_typography.scss
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/protyle/_wysiwyg.scss
 */
import {
    INLINE_MATH_TYPE,
    ZERO_WIDTH_GLOBAL_RE,
    isRestrictInlineActive,
    normalizeRestrictInlineTypes,
    rangeRestrictTokens,
    shouldCollectInlineMemoUnits,
    type RestrictInlineType,
} from "../shared";
import {
    collectSearchableBlocks,
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
    type CollectSearchableBlocksOptions,
} from "./blocks";
import type {SearchableBlock, SearchMatch} from "./dom-types";
import {
    cloneSelectionScope,
    getSelectionScope,
    isMatchWithinSelection,
    unitKey,
    unitKeyOf,
    type SelectionScope,
} from "./selection";
import {isElementVisible} from "./visibility";

const ATTRIBUTE_VIEW_TYPE = "NodeAttributeView";
const TABLE_TYPE = "NodeTable";
const BLOCKQUOTE_TYPE = "NodeBlockquote";
const CALLOUT_TYPE = "NodeCallout";
const MATH_BLOCK_TYPE = "NodeMathBlock";
const EMBED_BLOCK_TYPE = "NodeBlockQueryEmbed";
const WIDGET_TYPE = "NodeWidget";
const HTML_BLOCK_TYPE = "NodeHTMLBlock";
const CODE_BLOCK_TYPE = "NodeCodeBlock";
const MERMAID_SUBTYPE = "mermaid";
const HOST_EXCLUDED_CLOSEST = ".protyle-attr, .fn__none, svg, style, script";

export interface RestrictEnumerateOptions extends CollectSearchableBlocksOptions {
    selectionOnly?: boolean;
    selectionScope?: SelectionScope;
    includeFoldedBlocks?: boolean;
}

interface EnumerateHostCandidate {
    element: HTMLElement;
    blockId: string;
    blockType: string;
    blockIndex: number;
    unitId: string;
    text: string;
    matchSource: "text" | "inline-memo" | "inline-math";
    /** 相对所属 SearchableBlock.text 的偏移；无所属块时用整段 [0, text.length) */
    start: number;
    end: number;
    scopeKey: string;
}

/**
 * 空查询 + 限制激活：枚举所选类型的行内宿主（元素去重；嵌套父子分别计数）。
 * 命中一律不可替换。
 */
export function enumerateRestrictInlineMatches(
    edit: Element,
    options: RestrictEnumerateOptions = {},
): SearchMatch[] {
    const includeInlineMemo = options.includeInlineMemo === true;
    const restrictTypes = normalizeRestrictInlineTypes(options.restrictInlineTypes, {
        includeInlineMemo,
    });
    if (!isRestrictInlineActive(restrictTypes)) {
        return [];
    }

    const includeAttributeView = options.includeAttributeView !== false;
    const includeTable = options.includeTable !== false;
    const includeBlockquote = options.includeBlockquote !== false;
    const includeCallout = options.includeCallout !== false;
    const includeMathBlock = options.includeMathBlock !== false;
    const includeEmbedBlock = options.includeEmbedBlock !== false;
    const includeWidget = options.includeWidget !== false;
    const includeCodeBlock = options.includeCodeBlock !== false;
    const includeMermaid = options.includeMermaid !== false;
    const includeHtmlBlock = options.includeHtmlBlock !== false;
    const allowFoldedHidden = options.includeFoldedBlocks === true;
    const selectionOnly = options.selectionOnly === true;

    // 选区偏移与 blockIndex：用「不限制」采集，保证正文块完整
    const scopeBlocks = collectSearchableBlocks(edit, {
        includeAttributeView,
        includeTable,
        includeBlockquote,
        includeCallout,
        includeMathBlock,
        includeEmbedBlock,
        includeWidget,
        includeCodeBlock,
        includeMermaid,
        includeHtmlBlock,
        includeInlineMemo,
        restrictInlineTypes: [],
    });
    const selectionScope = resolveEnumerateSelectionScope(edit, scopeBlocks, options);
    if (selectionOnly && selectionScope.size === 0) {
        return [];
    }

    const blockByKey = new Map<string, SearchableBlock>();
    for (const block of scopeBlocks) {
        blockByKey.set(unitKeyOf(block), block);
    }

    const ownerIndexById = new Map<string, number>();
    for (const block of scopeBlocks) {
        if (!block.unitId && block.blockId && !ownerIndexById.has(block.blockId)) {
            ownerIndexById.set(block.blockId, block.blockIndex);
        }
    }

    const docRoots = collectEnumerateRoots(edit);
    const seenHosts = new Set<Element>();
    const candidates: EnumerateHostCandidate[] = [];
    let hostSerial = 0;
    const titleBlock = blockByKey.get(unitKey("__doc-title__", "doc-title"));

    const textTokens = rangeRestrictTokens(restrictTypes);
    for (const root of docRoots) {
        for (const token of textTokens) {
            const spans = root.querySelectorAll<HTMLElement>(
                `span[data-type~="${cssEscapeAttr(token)}"]`,
            );
            for (const span of spans) {
                if (seenHosts.has(span)) {
                    continue;
                }
                if (span.closest(HOST_EXCLUDED_CLOSEST)) {
                    continue;
                }
                if (shouldSkipHostByIncludeGates(span, {
                    includeAttributeView,
                    includeTable,
                    includeBlockquote,
                    includeCallout,
                    includeMathBlock,
                    includeEmbedBlock,
                    includeWidget,
                    includeCodeBlock,
                    includeMermaid,
                    includeHtmlBlock,
                })) {
                    continue;
                }
                if (!isElementVisible(span, {allowFoldedHidden})) {
                    continue;
                }
                const visible = visibleTextOf(span);
                if (!visible) {
                    continue;
                }

                const owner = span.closest<HTMLElement>("[data-node-id][data-type]");
                // 取包含宿主的最深 SearchableBlock（表格单元格 / Callout unit 等带 unitId）
                const ownerBlock = findDeepestOwningBlock(scopeBlocks, span)
                    ?? (titleBlock && titleBlock.element.contains(span) ? titleBlock : undefined);
                let offsets = ownerBlock
                    ? getHostOffsetsInBlock(ownerBlock, span)
                    : {start: 0, end: visible.length};
                if (!offsets) {
                    // 选区内依赖块内偏移；无法定位时跳过，避免错滤
                    if (selectionOnly) {
                        continue;
                    }
                    offsets = {start: 0, end: visible.length};
                }

                const blockId = ownerBlock?.blockId
                    || owner?.dataset.nodeId?.trim()
                    || `__restrict-host-${hostSerial}`;
                const blockType = ownerBlock?.blockType
                    || owner?.dataset.type?.trim()
                    || "unknown";
                const blockIndex = ownerBlock?.blockIndex
                    ?? (owner?.dataset.nodeId
                        ? (ownerIndexById.get(owner.dataset.nodeId.trim()) ?? hostSerial)
                        : hostSerial);
                const scopeKey = ownerBlock
                    ? unitKeyOf(ownerBlock)
                    : unitKey(blockId);

                seenHosts.add(span);
                candidates.push({
                    element: span,
                    blockId,
                    blockType,
                    blockIndex,
                    unitId: `restrict-host:${hostSerial}`,
                    text: visible,
                    matchSource: "text",
                    start: offsets.start,
                    end: offsets.end,
                    scopeKey,
                });
                hostSerial += 1;
            }
        }
    }

    if (shouldCollectInlineMemoUnits({includeInlineMemo, restrictTypes})) {
        for (const block of scopeBlocks) {
            if (!isInlineMemoSearchUnit(block)) {
                continue;
            }
            if (seenHosts.has(block.element)) {
                continue;
            }
            if (!isElementVisible(block.element, {allowFoldedHidden})) {
                continue;
            }
            const visible = block.text.replace(ZERO_WIDTH_GLOBAL_RE, "").trim();
            if (!visible) {
                continue;
            }
            seenHosts.add(block.element);
            candidates.push({
                element: block.element,
                blockId: block.blockId,
                blockType: block.blockType,
                blockIndex: block.blockIndex,
                unitId: block.unitId || `restrict-memo:${hostSerial}`,
                text: block.text,
                matchSource: "inline-memo",
                start: 0,
                end: block.text.length,
                scopeKey: unitKeyOf(block),
            });
            hostSerial += 1;
        }
    }

    if (restrictTypes.includes(INLINE_MATH_TYPE)) {
        for (const block of scopeBlocks) {
            if (!isInlineMathSearchUnit(block)) {
                continue;
            }
            if (seenHosts.has(block.element)) {
                continue;
            }
            if (!isElementVisible(block.element, {allowFoldedHidden})) {
                continue;
            }
            const visible = block.text.replace(ZERO_WIDTH_GLOBAL_RE, "").trim();
            if (!visible) {
                continue;
            }
            seenHosts.add(block.element);
            candidates.push({
                element: block.element,
                blockId: block.blockId,
                blockType: block.blockType,
                blockIndex: block.blockIndex,
                unitId: block.unitId || `restrict-math:${hostSerial}`,
                text: block.text,
                matchSource: "inline-math",
                start: 0,
                end: block.text.length,
                scopeKey: unitKeyOf(block),
            });
            hostSerial += 1;
        }
    }

    const matches: SearchMatch[] = [];
    for (const candidate of candidates) {
        if (
            !isMatchWithinSelection(
                candidate.scopeKey,
                candidate.start,
                candidate.end,
                selectionOnly,
                selectionScope,
            )
        ) {
            continue;
        }

        let range: Range | null = null;
        try {
            range = document.createRange();
            range.selectNodeContents(candidate.element);
        } catch {
            range = null;
        }
        if (!range) {
            continue;
        }

        matches.push({
            id: `${candidate.blockId}:${candidate.unitId}:0:${candidate.end}`,
            blockId: candidate.blockId,
            blockType: candidate.blockType,
            blockIndex: candidate.blockIndex,
            unitId: candidate.unitId,
            start: candidate.start,
            end: candidate.end,
            matchedText: candidate.text,
            replaceable: false,
            range,
            highlightKind: candidate.matchSource === "inline-memo"
                ? "inline-memo"
                : (candidate.matchSource === "inline-math" ? "inline-math" : "text"),
        });
    }

    matches.sort(compareEnumerateMatches);
    return matches;
}

function resolveEnumerateSelectionScope(
    edit: Element,
    blocks: SearchableBlock[],
    options: RestrictEnumerateOptions,
): SelectionScope {
    if (!options.selectionOnly) {
        return new Map();
    }
    if (options.selectionScope && options.selectionScope.size > 0) {
        return cloneSelectionScope(options.selectionScope);
    }
    const live = getSelectionScope(edit, blocks);
    if (live.size > 0) {
        return live;
    }
    return options.selectionScope
        ? cloneSelectionScope(options.selectionScope)
        : new Map();
}

function collectEnumerateRoots(edit: Element): HTMLElement[] {
    const roots: HTMLElement[] = [];
    const docRoot = edit.querySelector<HTMLElement>(
        ":scope > .protyle:not(.fn__none) :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)",
    ) ?? edit.querySelector<HTMLElement>(
        ".protyle:not(.fn__none) :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)",
    );
    if (docRoot) {
        roots.push(docRoot);
    }

    const titleInput = edit.querySelector<HTMLElement>(
        ":scope > .protyle:not(.fn__none) .protyle-title .protyle-title__input",
    ) ?? edit.querySelector<HTMLElement>(
        ".protyle:not(.fn__none) .protyle-title .protyle-title__input",
    );
    if (titleInput && !roots.some((root) => root.contains(titleInput))) {
        roots.push(titleInput);
    }
    return roots;
}

function shouldSkipHostByIncludeGates(
    host: Element,
    options: {
        includeAttributeView: boolean;
        includeTable: boolean;
        includeBlockquote: boolean;
        includeCallout: boolean;
        includeMathBlock: boolean;
        includeEmbedBlock: boolean;
        includeWidget: boolean;
        includeCodeBlock: boolean;
        includeMermaid: boolean;
        includeHtmlBlock: boolean;
    },
): boolean {
    const owner = host.closest<HTMLElement>("[data-node-id][data-type]");
    if (!owner) {
        return false;
    }
    const blockType = owner.dataset.type?.trim() || "";
    if (blockType === ATTRIBUTE_VIEW_TYPE && !options.includeAttributeView) {
        return true;
    }
    if (
        !options.includeTable
        && (blockType === TABLE_TYPE
            || owner.classList.contains("table")
            || Boolean(host.closest(`[data-type="${TABLE_TYPE}"], .table`)))
    ) {
        return true;
    }
    if (
        !options.includeBlockquote
        && Boolean(host.closest(`[data-type="${BLOCKQUOTE_TYPE}"], .bq`))
    ) {
        return true;
    }
    if (
        !options.includeCallout
        && Boolean(host.closest(`[data-type="${CALLOUT_TYPE}"], .callout`))
    ) {
        return true;
    }
    // 仅公式块；勿用 data-subtype="math"（行内公式亦有该属性）
    if (
        !options.includeMathBlock
        && Boolean(host.closest(`[data-type="${MATH_BLOCK_TYPE}"]`))
    ) {
        return true;
    }
    if (
        !options.includeEmbedBlock
        && Boolean(host.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`))
    ) {
        return true;
    }
    if (
        !options.includeWidget
        && Boolean(host.closest(`[data-type="${WIDGET_TYPE}"]`))
    ) {
        return true;
    }
    if (
        !options.includeHtmlBlock
        && Boolean(host.closest(`[data-type="${HTML_BLOCK_TYPE}"]`))
    ) {
        return true;
    }
    if (blockType === CODE_BLOCK_TYPE) {
        const isMermaid = owner.getAttribute("data-subtype") === MERMAID_SUBTYPE;
        if (isMermaid && !options.includeMermaid) {
            return true;
        }
        if (!isMermaid && !options.includeCodeBlock) {
            return true;
        }
    }
    if (host.closest(`[data-type="${CODE_BLOCK_TYPE}"][data-subtype="${MERMAID_SUBTYPE}"]`)
        && !options.includeMermaid) {
        return true;
    }
    return false;
}

function visibleTextOf(element: Element): string {
    return (element.textContent ?? "").replace(ZERO_WIDTH_GLOBAL_RE, "").trim();
}

/**
 * 包含 host 的最深可搜索单元（优先表格单元格 / AV 单元等带 unitId 的块）。
 * 排除备注/公式属性 unit，避免文本宿主误挂到属性单元上。
 */
function findDeepestOwningBlock(
    blocks: SearchableBlock[],
    host: Element,
): SearchableBlock | undefined {
    let best: SearchableBlock | undefined;
    for (const block of blocks) {
        if (block.matchSource === "inline-memo" || block.matchSource === "inline-math") {
            continue;
        }
        if (block.element !== host && !block.element.contains(host)) {
            continue;
        }
        if (!best || best.element.contains(block.element)) {
            best = block;
        }
    }
    return best;
}

function getHostOffsetsInBlock(
    block: SearchableBlock,
    host: Element,
): {start: number; end: number} | null {
    let cursor = 0;
    let start = -1;
    let end = -1;
    for (const textNode of block.textNodes) {
        const length = textNode.nodeValue?.length ?? 0;
        if (host.contains(textNode)) {
            if (start < 0) {
                start = cursor;
            }
            end = cursor + length;
        }
        cursor += length;
    }
    if (start < 0 || end < start) {
        return null;
    }
    return {start, end};
}

function cssEscapeAttr(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
}

function highlightKindRank(kind: SearchMatch["highlightKind"]): number {
    if (kind === "inline-memo") {
        return 2;
    }
    if (kind === "inline-math") {
        return 1;
    }
    return 0;
}

function compareEnumerateMatches(a: SearchMatch, b: SearchMatch): number {
    if (a.blockIndex !== b.blockIndex) {
        return a.blockIndex - b.blockIndex;
    }
    if (a.range && b.range) {
        try {
            const startCmp = a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
            if (startCmp !== 0) {
                return startCmp;
            }
        } catch {
            // ignore
        }
    }
    const kindCmp = highlightKindRank(a.highlightKind) - highlightKindRank(b.highlightKind);
    if (kindCmp !== 0) {
        return kindCmp;
    }
    if (a.start !== b.start) {
        return a.start - b.start;
    }
    return a.end - b.end;
}
