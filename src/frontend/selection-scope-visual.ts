import type {RestrictInlineType} from "../shared";
import {collectSearchableBlocks} from "./blocks";
import {createRangeFromBlockOffsets} from "./ranges";
import {
    getActiveTableSelectCells,
    getSelectionScope,
    hasActiveTableCellSelect,
    unitKeyOf,
    type SelectionScope,
} from "./selection";

/** 与思源 .protyle-wysiwyg--select 对齐的冻结选区提示（仅用于清扫历史污染 class，不再写入内容块） */
const SELECTION_SCOPE_BLOCK_CLASS = "page-search-sel-scope";

/**
 * 行内选区叠加层。
 * 现行：挂在 .protyle-content（与 wash/rail 同级）。
 * 历史：曾插入 [data-node-id] 首子节点，会被 updateTransaction 的 outerHTML 写进文档。
 */
const SELECTION_SCOPE_INLINE_LAYER = "page-search-sel-scope-layer";
const SELECTION_SCOPE_INLINE_RECT = "page-search-sel-scope-inline";

/**
 * 块级底色 / 行内色块 / 右侧蓝竖线：均挂在 .protyle-content 上，
 * 不进入 [data-node-id] / td / th，避免 outerHTML 写回污染文档。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/ui/initUI.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/table.ts
 */
const SELECTION_SCOPE_OVERLAY_HOST = "page-search-sel-scope-rail-host";
const SELECTION_SCOPE_RAIL_LAYER = "page-search-sel-scope-rail-layer";
const SELECTION_SCOPE_RAIL = "page-search-sel-scope-rail";
const SELECTION_SCOPE_WASH_LAYER = "page-search-sel-scope-wash-layer";
const SELECTION_SCOPE_WASH = "page-search-sel-scope-wash";

/** 连续块竖线合并：允许的纵向间隙（覆盖块间距） */
const RAIL_MERGE_Y_GAP = 8;
/** 同列判定：右侧 x 容差 */
const RAIL_MERGE_X_TOLERANCE = 6;
const RAIL_WIDTH = 2;

/** 旧版 CSS Highlight 名，清理时一并删除 */
const LEGACY_SELECTION_SCOPE_HIGHLIGHT = "page-search-sel-scope";

export type SelectionScopeVisualKind = "text" | "block" | "table-cells";

/** 冻结表格框选所需的稳定位置；不向单元格 DOM 写任何标记。 */
export interface TableCellVisualRef {
    tableBlockId: string;
    rowIndex: number;
    columnIndex: number;
    cellId?: string;
}

/**
 * 判别当前是行内文字选区还是块级/表格框选。
 * 与 getSelectionScope 一致：非空文本选区优先，否则看表格 .table__select 或 .protyle-wysiwyg--select。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/protyle/_wysiwyg.scss
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/table.ts
 */
function detectSelectionScopeKind(edit: Element): SelectionScopeVisualKind | null {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const text = selection.toString();
        if (text.length > 0) {
            return "text";
        }
    }
    // 表格单元格框选：原生 Range 已被 collapse；需与整表块选分开处理
    if (hasActiveTableCellSelect(edit)) {
        return "table-cells";
    }
    if (edit.querySelector(".protyle-wysiwyg .protyle-wysiwyg--select")) {
        return "block";
    }
    return null;
}

/**
 * 按冻结的 SelectionScope 画出选区提示；先清旧提示再画。
 * visualBlockIds：捕获时的 .protyle-wysiwyg--select 块 id（含空块/容器/数据库），
 * 冻结后 --select 消失仍可按原顶层块绘制，避免按搜索单元拆成多条竖线。
 * kind 省略时按当前 DOM 判别；失败则静默（不影响搜索）。
 */
export function applySelectionScopeVisual(
    edit: Element,
    scope: SelectionScope,
    kind?: SelectionScopeVisualKind | null,
    visualBlockIds?: string[] | null,
    tableCellRefs?: TableCellVisualRef[] | null,
): void {
    clearSelectionScopeVisual(edit);
    const hasVisualIds = Boolean(visualBlockIds && visualBlockIds.length > 0);
    const hasTableCellRefs = Boolean(tableCellRefs && tableCellRefs.length > 0);
    if (scope.size === 0 && !hasVisualIds && !hasTableCellRefs) {
        const liveSelect = edit.querySelector(".protyle-wysiwyg .protyle-wysiwyg--select");
        if (!liveSelect) {
            return;
        }
    }

    const resolvedKind = kind ?? detectSelectionScopeKind(edit);
    if (resolvedKind === "block") {
        applyBlockScopeVisual(edit, scope, visualBlockIds);
        return;
    }
    if (resolvedKind === "table-cells") {
        applyTableCellScopeVisual(edit, scope, tableCellRefs);
        return;
    }
    if (resolvedKind === "text") {
        applyTextScopeVisual(edit, scope);
        return;
    }

    if (hasTableCellRefs) {
        applyTableCellScopeVisual(edit, scope, tableCellRefs);
    } else if (hasVisualIds || looksLikeFullBlockScope(edit, scope)) {
        applyBlockScopeVisual(edit, scope, visualBlockIds);
    } else {
        applyTextScopeVisual(edit, scope);
    }
}

export function clearSelectionScopeVisual(edit: Element): void {
    scrubSelectionScopePollution(edit);
    clearSelectionScopeInline(edit);
    clearSelectionScopeWash(edit);
    clearSelectionScopeRails(edit);
    const highlights = (CSS as unknown as {highlights?: Map<string, unknown>}).highlights;
    highlights?.delete(LEGACY_SELECTION_SCOPE_HIGHLIGHT);
    clearNativeSelectionColorVars();
}

/**
 * 清掉会话期挂在 .protyle-content 上的选区提示叠加层（不写文档）。
 * 供插件卸载等兜底；日常开关选区模式走 clearSelectionScopeVisual。
 */
export function clearAllSelectionScopeSessionOverlays(root: ParentNode = document): void {
    root.querySelectorAll(
        `.protyle-content > .${SELECTION_SCOPE_INLINE_LAYER},`
        + `.protyle-content > .${SELECTION_SCOPE_WASH_LAYER},`
        + `.protyle-content > .${SELECTION_SCOPE_RAIL_LAYER}`,
    ).forEach((el) => {
        el.remove();
    });
    root.querySelectorAll(`.${SELECTION_SCOPE_OVERLAY_HOST}`).forEach((el) => {
        el.classList.remove(SELECTION_SCOPE_OVERLAY_HOST);
    });
    clearNativeSelectionColorVars();
}

/**
 * 清扫误写入内容块的提示 class / 行内层（历史版本污染）。
 * 不发起 transaction；下次用户编辑该块写回时即可从文档中消失。
 */
export function scrubSelectionScopePollution(root: ParentNode = document): void {
    root.querySelectorAll(`.${SELECTION_SCOPE_BLOCK_CLASS}`).forEach((el) => {
        el.classList.remove(SELECTION_SCOPE_BLOCK_CLASS);
    });
    // 仅清扫内容块内部的历史层；.protyle-content 上的叠加层由 clear* 负责
    root.querySelectorAll(
        `[data-node-id] .${SELECTION_SCOPE_INLINE_LAYER},`
        + `[data-node-id] .${SELECTION_SCOPE_INLINE_RECT},`
        + `[data-node-id] .${SELECTION_SCOPE_WASH_LAYER},`
        + `[data-node-id] .${SELECTION_SCOPE_WASH},`
        + `[data-node-id] .${SELECTION_SCOPE_RAIL_LAYER},`
        + `[data-node-id] .${SELECTION_SCOPE_RAIL}`,
    ).forEach((el) => {
        el.remove();
    });
}

function applyBlockScopeVisual(
    edit: Element,
    scope: SelectionScope,
    visualBlockIds?: string[] | null,
): void {
    // 块选提示按「顶层选中块」绘制：数据库/容器只画一块底色与一条竖线，
    // 避免按搜索单元（单元格、容器内子块）各画一条。
    // @see isContainerBlock in siyuan protyle/wysiwyg/getBlock.ts
    const nodes = collectBlockVisualNodes(edit, scope, visualBlockIds);
    applySelectionScopeWash(edit, nodes);
    applySelectionScopeRails(edit, nodes);
}

/**
 * 表格单元格框选：底色只覆盖冻结的 td/th，右侧竖线仍归并到整张 NodeTable。
 * 叠加层全部位于 .protyle-content，不给单元格写 class / 子节点。
 */
function applyTableCellScopeVisual(
    edit: Element,
    scope: SelectionScope,
    refs?: TableCellVisualRef[] | null,
): void {
    const cells = resolveTableCellVisualElements(edit, scope, refs);
    applySelectionScopeWash(edit, cells);
    applySelectionScopeRails(edit, cells);
}

/** 捕获当前 `.table__select` 命中的单元格位置，供光标移动后重建视觉提示。 */
function captureTableCellVisualRefs(edit: Element): TableCellVisualRef[] {
    const refs: TableCellVisualRef[] = [];
    const seen = new Set<string>();

    for (const cell of getActiveTableSelectCells(edit)) {
        const table = cell.closest<HTMLElement>('[data-type="NodeTable"], .table');
        const tableBlockId = table?.getAttribute("data-node-id")?.trim();
        const row = cell.closest<HTMLElement>(".table__row, tr");
        if (!table || !tableBlockId || !row) {
            continue;
        }
        const rows = getOwnedTableRows(table);
        const rowIndex = rows.indexOf(row);
        const columnIndex = getOwnedRowCells(row).indexOf(cell);
        if (rowIndex < 0 || columnIndex < 0) {
            continue;
        }
        const key = `${tableBlockId}:${rowIndex}:${columnIndex}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const cellId = cell.getAttribute("data-node-id")?.trim();
        refs.push({
            tableBlockId,
            rowIndex,
            columnIndex,
            ...(cellId ? {cellId} : {}),
        });
    }
    return refs;
}

function resolveTableCellVisualElements(
    edit: Element,
    scope: SelectionScope,
    refs?: TableCellVisualRef[] | null,
): HTMLElement[] {
    const cells: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const push = (cell: HTMLElement | null) => {
        if (!cell || seen.has(cell)) {
            return;
        }
        seen.add(cell);
        cells.push(cell);
    };

    for (const ref of refs ?? []) {
        const table = edit.querySelector<HTMLElement>(
            `.protyle-wysiwyg [data-node-id="${cssEscapeAttr(ref.tableBlockId)}"][data-type="NodeTable"],`
            + `.protyle-wysiwyg .table[data-node-id="${cssEscapeAttr(ref.tableBlockId)}"]`,
        );
        if (!table) {
            continue;
        }
        if (ref.cellId) {
            const byId = table.querySelector<HTMLElement>(
                `[data-node-id="${cssEscapeAttr(ref.cellId)}"]`,
            );
            if (byId?.matches("td, th, .table__cell")) {
                push(byId);
                continue;
            }
        }
        const row = getOwnedTableRows(table)[ref.rowIndex];
        push(row ? getOwnedRowCells(row)[ref.columnIndex] ?? null : null);
    }

    if (cells.length > 0) {
        return cells;
    }

    // 旧状态或 DOM 重建后无 refs 时，按冻结 scope 回放非空单元格。
    const scopedKeys = new Set(scope.keys());
    for (const block of collectSearchableBlocks(edit)) {
        if (!scopedKeys.has(unitKeyOf(block))) {
            continue;
        }
        if (block.element.matches("td, th, .table__cell")) {
            push(block.element);
        }
    }
    return cells;
}

function getOwnedTableRows(table: HTMLElement): HTMLElement[] {
    return Array.from(table.querySelectorAll<HTMLElement>(".table__row, tr")).filter((row) => {
        const owner = row.closest<HTMLElement>('[data-type="NodeTable"], .table');
        return owner === table || (!owner && table.contains(row));
    });
}

function getOwnedRowCells(row: HTMLElement): HTMLElement[] {
    return Array.from(row.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && child.matches("td, th, .table__cell")
    );
}

/**
 * 捕获当前块选的 data-node-id（含空块、容器、数据库），供冻结后重绘。
 * 不读/写内容，仅记录 id。
 */
function captureSelectedBlockIds(edit: Element): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    edit.querySelectorAll<HTMLElement>(".protyle-wysiwyg .protyle-wysiwyg--select").forEach((el) => {
        const id = el.getAttribute("data-node-id")?.trim();
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        ids.push(id);
    });
    return ids;
}

/**
 * 块选视觉节点优先级：
 * 1. 冻结时记录的顶层块 id（空块/容器/数据库）
 * 2. 现场 .protyle-wysiwyg--select
 * 3. 从 scope 搜索单元上溯宿主后去重
 */
function collectBlockVisualNodes(
    edit: Element,
    scope: SelectionScope,
    visualBlockIds?: string[] | null,
): HTMLElement[] {
    if (visualBlockIds && visualBlockIds.length > 0) {
        const fromIds: HTMLElement[] = [];
        for (const id of visualBlockIds) {
            const el = edit.querySelector<HTMLElement>(
                `.protyle-wysiwyg [data-node-id="${cssEscapeAttr(id)}"]`,
            );
            if (el) {
                fromIds.push(el);
            }
        }
        if (fromIds.length > 0) {
            return collapseToOutermostHosts(fromIds.map((el) => resolveVisualHostElement(el)));
        }
    }

    const selected = Array.from(
        edit.querySelectorAll<HTMLElement>(".protyle-wysiwyg .protyle-wysiwyg--select"),
    );
    if (selected.length > 0) {
        return collapseToOutermostHosts(selected.map((el) => resolveVisualHostElement(el)));
    }

    const hosts: HTMLElement[] = [];
    const scopedKeys = new Set(scope.keys());
    if (scopedKeys.size > 0) {
        const blocks = collectSearchableBlocks(edit);
        for (const block of blocks) {
            if (!scopedKeys.has(unitKeyOf(block))) {
                continue;
            }
            hosts.push(resolveVisualHostElement(block.element));
        }
    }
    return collapseToOutermostHosts(hosts);
}

function cssEscapeAttr(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 将搜索单元 / 任意节点归并到「选区提示」宿主块：
 * - 表格单元格 → NodeTable
 * - 数据库内部（.av__cell 等）→ NodeAttributeView
 * - Callout 标题等非 node 节点 → 所属 NodeCallout
 * - 其余 → 最近的 [data-node-id][data-type]
 * 不修改这些元素，仅用于几何量测。
 */
function resolveVisualHostElement(node: HTMLElement): HTMLElement {
    const tag = node.tagName;
    if (tag === "TD" || tag === "TH" || node.classList.contains("table__cell")) {
        return node.closest<HTMLElement>('[data-type="NodeTable"], .table') ?? node;
    }
    if (node.getAttribute("data-type") === "NodeTable" || node.classList.contains("table")) {
        return node;
    }

    const av = node.closest<HTMLElement>('[data-type="NodeAttributeView"]');
    if (av) {
        return av;
    }

    const callout = node.closest<HTMLElement>('[data-type="NodeCallout"], .callout');
    if (callout && (node.classList.contains("callout-title") || !node.hasAttribute("data-node-id"))) {
        return callout;
    }

    const block = node.closest<HTMLElement>("[data-node-id][data-type]");
    return block ?? node;
}

/** 去掉被其它宿主包含的节点，保证容器/数据库只保留最外层一条 */
function collapseToOutermostHosts(nodes: Array<HTMLElement | null | undefined>): HTMLElement[] {
    const unique: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const node of nodes) {
        if (!node || seen.has(node)) {
            continue;
        }
        seen.add(node);
        unique.push(node);
    }
    return unique.filter((host) =>
        !unique.some((other) => other !== host && other.contains(host))
    );
}

/**
 * 行内冻结提示：用 Range.getClientRects() 在 .protyle-content 上叠绝对定位色块。
 * 不插入内容块 DOM，避免 updateTransaction(outerHTML) 持久化污染。
 * CSS Highlight 按字形盒绘制偏窄；叠加层可拉到 line-height。
 */
function applyTextScopeVisual(edit: Element, scope: SelectionScope): void {
    const ranges = collectTextScopeRanges(edit, scope);
    if (ranges.length === 0) {
        return;
    }

    const hintBlock = resolveBlockHost(ranges[0], edit);
    const content = resolveProtyleContent(edit, hintBlock);
    if (!content) {
        return;
    }

    applyNativeSelectionColorsToRoot();
    clearSelectionScopeInline(edit);

    const contentRect = content.getBoundingClientRect();
    content.classList.add(SELECTION_SCOPE_OVERLAY_HOST);

    const layer = ensureContentOverlayLayer(content, SELECTION_SCOPE_INLINE_LAYER);

    const railBlockSet = new Set<HTMLElement>();

    for (const range of ranges) {
        const block = resolveBlockHost(range, edit);
        if (block) {
            railBlockSet.add(block);
        }

        let clientRects: DOMRect[];
        try {
            clientRects = Array.from(range.getClientRects());
        } catch {
            continue;
        }

        for (const rect of clientRects) {
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }
            const box = expandRectToLineBox(rect, range);
            const div = document.createElement("div");
            div.className = SELECTION_SCOPE_INLINE_RECT;
            div.style.left = `${Math.round(box.left - contentRect.left + content.scrollLeft)}px`;
            div.style.top = `${Math.round(box.top - contentRect.top + content.scrollTop)}px`;
            div.style.width = `${Math.round(box.width)}px`;
            div.style.height = `${Math.round(box.height)}px`;
            layer.appendChild(div);
        }
    }

    applySelectionScopeRails(edit, Array.from(railBlockSet));
}

function collectTextScopeRanges(edit: Element, scope: SelectionScope): Range[] {
    const blocks = collectSearchableBlocks(edit);
    const blockMap = new Map(blocks.map((block) => [unitKeyOf(block), block]));
    const ranges: Range[] = [];

    for (const [key, offsets] of scope) {
        const block = blockMap.get(key);
        if (!block) {
            continue;
        }
        for (const offset of offsets) {
            const range = createRangeFromBlockOffsets(block, offset.start, offset.end);
            if (range) {
                ranges.push(range);
            }
        }
    }

    if (ranges.length > 0) {
        return ranges;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return ranges;
    }
    try {
        for (let i = 0; i < selection.rangeCount; i += 1) {
            const live = selection.getRangeAt(i);
            const ancestor = live.commonAncestorContainer;
            const el = ancestor.nodeType === Node.ELEMENT_NODE
                ? ancestor as Element
                : ancestor.parentElement;
            if (el && edit.contains(el)) {
                ranges.push(live.cloneRange());
            }
        }
    } catch {
        // ignore
    }
    return ranges;
}

function resolveBlockHost(range: Range, edit: Element): HTMLElement | null {
    const node = range.commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    const block = el?.closest<HTMLElement>("[data-node-id][data-type]");
    if (!block || !edit.contains(block)) {
        return null;
    }
    return block;
}

/**
 * 块级/单元格底色：叠加在 .protyle-content，不改内容块 DOM。
 */
function applySelectionScopeWash(edit: Element, nodes: HTMLElement[]): void {
    clearSelectionScopeWash(edit);
    if (nodes.length === 0) {
        return;
    }

    const content = resolveProtyleContent(edit, nodes[0]);
    if (!content) {
        return;
    }

    const contentRect = content.getBoundingClientRect();
    content.classList.add(SELECTION_SCOPE_OVERLAY_HOST);

    const layer = ensureContentOverlayLayer(content, SELECTION_SCOPE_WASH_LAYER);

    for (const node of nodes) {
        if (!content.contains(node)) {
            continue;
        }
        const rect = node.getBoundingClientRect();
        const height = Math.max(rect.height, estimateBlockMinHeight(node));
        if (rect.width <= 0 || height <= 0) {
            continue;
        }
        const div = document.createElement("div");
        div.className = SELECTION_SCOPE_WASH;
        div.style.left = `${Math.round(rect.left - contentRect.left + content.scrollLeft)}px`;
        div.style.top = `${Math.round(rect.top - contentRect.top + content.scrollTop)}px`;
        div.style.width = `${Math.round(rect.width)}px`;
        div.style.height = `${Math.round(height)}px`;
        layer.appendChild(div);
    }
}

function clearSelectionScopeInline(edit: Element): void {
    // 只清 .protyle-content 直接子层；块内历史污染由 scrub 处理
    edit.querySelectorAll(`.protyle-content > .${SELECTION_SCOPE_INLINE_LAYER}`).forEach((el) => {
        el.remove();
    });
    releaseOverlayHostIfIdle(edit);
}

function clearSelectionScopeWash(edit: Element): void {
    edit.querySelectorAll(`.${SELECTION_SCOPE_WASH_LAYER}`).forEach((el) => {
        el.remove();
    });
    releaseOverlayHostIfIdle(edit);
}

function releaseOverlayHostIfIdle(edit: Element): void {
    edit.querySelectorAll(`.${SELECTION_SCOPE_OVERLAY_HOST}`).forEach((el) => {
        const busy = el.querySelector(
            `.${SELECTION_SCOPE_RAIL_LAYER}, .${SELECTION_SCOPE_WASH_LAYER}, :scope > .${SELECTION_SCOPE_INLINE_LAYER}`,
        );
        if (!busy) {
            el.classList.remove(SELECTION_SCOPE_OVERLAY_HOST);
        }
    });
}

/**
 * 在内容块与编辑器右边界之间绘制蓝色竖线。
 * - 宿主归并：表格→整表、数据库→整库、容器内子单元→外层容器；再去掉被包含的子孙
 * - X 统一落在 wysiwyg padding 右侧空隙（不跟各块右缘），保证缩进不同的相邻块能纵向合并
 * - 空块：用 line-height 兜底高度，避免 height=0 时有底色无竖线
 * 宿主为 .protyle-content（滚动容器），不写入内容块。
 * @see isContainerBlock / setPadding in siyuan-note/siyuan
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/ui/initUI.ts
 */
function applySelectionScopeRails(edit: Element, blocks: HTMLElement[]): void {
    clearSelectionScopeRails(edit);
    const railHosts = collapseToOutermostHosts(
        blocks.map((block) => resolveVisualHostElement(block)),
    );
    if (railHosts.length === 0) {
        return;
    }

    const content = resolveProtyleContent(edit, railHosts[0]);
    const wysiwyg = resolveWysiwyg(edit, content);
    if (!content || !wysiwyg) {
        return;
    }

    const contentRect = content.getBoundingClientRect();
    const wysiwygRect = wysiwyg.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(wysiwyg).paddingRight) || 0;
    // 内容区右缘（padding 内侧）与 wysiwyg 外缘之间是 setPadding 留出的右侧空隙
    const contentBoxRight = wysiwygRect.right - padRight;
    const editorRight = wysiwygRect.right;
    const gapLeft = contentBoxRight;
    const gapRight = Math.max(editorRight, gapLeft + RAIL_WIDTH + 4);
    const gap = gapRight - gapLeft;
    // 所有竖线共用同一 X，避免缩进/窄块导致无法 merge
    const lineLeftClient = gapLeft + Math.min(Math.max(gap * 0.35, 4), Math.max(gap - 4, 4));
    const lineLeft = lineLeftClient - contentRect.left + content.scrollLeft;

    type RailSeed = {top: number; bottom: number; left: number};
    const seeds: RailSeed[] = [];

    for (const block of railHosts) {
        if (!content.contains(block)) {
            continue;
        }
        const rect = block.getBoundingClientRect();
        const height = Math.max(rect.height, estimateBlockMinHeight(block));
        if (height <= 0) {
            continue;
        }
        const top = rect.top - contentRect.top + content.scrollTop;
        seeds.push({
            top,
            bottom: top + height,
            left: lineLeft,
        });
    }

    if (seeds.length === 0) {
        return;
    }

    const merged = mergeContinuousRails(seeds);
    content.classList.add(SELECTION_SCOPE_OVERLAY_HOST);

    const layer = ensureContentOverlayLayer(content, SELECTION_SCOPE_RAIL_LAYER);

    for (const rail of merged) {
        const height = rail.bottom - rail.top;
        if (height <= 0) {
            continue;
        }
        const div = document.createElement("div");
        div.className = SELECTION_SCOPE_RAIL;
        div.style.left = `${Math.round(rail.left)}px`;
        div.style.top = `${Math.round(rail.top)}px`;
        div.style.height = `${Math.round(height)}px`;
        div.style.width = `${RAIL_WIDTH}px`;
        layer.appendChild(div);
    }
}

function clearSelectionScopeRails(edit: Element): void {
    edit.querySelectorAll(`.${SELECTION_SCOPE_RAIL_LAYER}`).forEach((el) => {
        el.remove();
    });
    releaseOverlayHostIfIdle(edit);
}

/** 空块等 getBoundingClientRect().height 过小时，用行高兜底竖线高度 */
function estimateBlockMinHeight(block: HTMLElement): number {
    try {
        const cs = getComputedStyle(block);
        const lh = cs.lineHeight;
        if (lh && lh !== "normal") {
            const parsed = parseFloat(lh);
            if (!Number.isNaN(parsed) && parsed > 0) {
                return parsed;
            }
        }
        const fontSize = parseFloat(cs.fontSize);
        if (!Number.isNaN(fontSize) && fontSize > 0) {
            return fontSize * 1.25;
        }
    } catch {
        // ignore
    }
    return 0;
}

function resolveProtyleContent(edit: Element, hint?: HTMLElement | null): HTMLElement | null {
    const fromHint = hint?.closest<HTMLElement>(".protyle-content");
    if (fromHint && edit.contains(fromHint)) {
        return fromHint;
    }
    return edit.querySelector<HTMLElement>(
        ":scope > .protyle:not(.fn__none) .protyle-content:not(.fn__none)",
    ) ?? edit.querySelector<HTMLElement>(".protyle:not(.fn__none) .protyle-content:not(.fn__none)")
        ?? edit.querySelector<HTMLElement>(".protyle-content");
}

function resolveWysiwyg(edit: Element, content: HTMLElement | null): HTMLElement | null {
    if (content) {
        const local = content.querySelector<HTMLElement>(".protyle-wysiwyg");
        if (local) {
            return local;
        }
    }
    return edit.querySelector<HTMLElement>(
        ".protyle:not(.fn__none) .protyle-content:not(.fn__none) .protyle-wysiwyg",
    ) ?? edit.querySelector<HTMLElement>(".protyle-wysiwyg");
}

/**
 * 在 .protyle-content 上挂叠加层：放在 .protyle-wysiwyg 之后，
 * 避免抢占 firstElementChild（思源 initUI 用其挂 .protyle-top / 背景 / 标题），
 * 也不进入 wysiwyg（避免 lastElementChild / outerHTML 写回）。
 */
function ensureContentOverlayLayer(content: HTMLElement, className: string): HTMLElement {
    let layer = content.querySelector<HTMLElement>(`:scope > .${className}`);
    if (!layer) {
        layer = document.createElement("div");
        layer.className = className;
        layer.setAttribute("aria-hidden", "true");
        const wysiwyg = content.querySelector(":scope > .protyle-wysiwyg");
        if (wysiwyg) {
            wysiwyg.insertAdjacentElement("afterend", layer);
        } else {
            content.appendChild(layer);
        }
    } else {
        layer.replaceChildren();
    }
    return layer;
}

/** 按文档从上到下合并完全连续的竖线片段 */
function mergeContinuousRails(
    seeds: Array<{top: number; bottom: number; left: number}>,
): Array<{top: number; bottom: number; left: number}> {
    const sorted = seeds.slice().sort((a, b) => a.top - b.top || a.left - b.left);
    const out: Array<{top: number; bottom: number; left: number}> = [];
    for (const seed of sorted) {
        const prev = out[out.length - 1];
        if (
            prev
            && Math.abs(prev.left - seed.left) <= RAIL_MERGE_X_TOLERANCE
            && seed.top <= prev.bottom + RAIL_MERGE_Y_GAP
        ) {
            prev.bottom = Math.max(prev.bottom, seed.bottom);
            prev.left = (prev.left + seed.left) / 2;
            continue;
        }
        out.push({...seed});
    }
    return out;
}

/** 将 clientRect 纵向扩展到接近行盒高度（原生 ::selection 量级） */
function expandRectToLineBox(
    rect: DOMRect,
    range: Range,
): {left: number; top: number; width: number; height: number} {
    let targetHeight = rect.height;
    try {
        const node = range.startContainer;
        const el = node.nodeType === Node.ELEMENT_NODE
            ? node as Element
            : node.parentElement;
        if (el) {
            const cs = getComputedStyle(el);
            const lh = cs.lineHeight;
            if (lh && lh !== "normal") {
                const parsed = parseFloat(lh);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    targetHeight = Math.max(targetHeight, parsed);
                }
            } else {
                const fontSize = parseFloat(cs.fontSize);
                if (!Number.isNaN(fontSize) && fontSize > 0) {
                    // CSS normal ≈ 1.2；略放大以贴近 Chromium 选区行盒
                    targetHeight = Math.max(targetHeight, fontSize * 1.25);
                }
            }
        }
    } catch {
        // keep rect.height
    }

    // 即使已接近 line-height，再轻微外扩 1px，避免视觉上仍偏「贴字」
    targetHeight = Math.max(targetHeight, rect.height) + 2;
    const extra = Math.max(0, targetHeight - rect.height);
    const pad = extra / 2;
    return {
        left: rect.left,
        top: rect.top - pad,
        width: rect.width,
        height: rect.height + extra,
    };
}

/** 采样结果缓存，避免每次画行内提示都改动 window.getSelection() */
let cachedNativeSelectionBackground: string | null | undefined;

/**
 * 采样浏览器原生 ::selection 背景色，写入 CSS 变量。
 * 思源主题通常不覆盖 ::selection，默认即系统 Highlight。
 */
function applyNativeSelectionColorsToRoot(): void {
    const root = document.documentElement;
    if (cachedNativeSelectionBackground === undefined) {
        cachedNativeSelectionBackground = sampleNativeSelectionBackground();
    }
    const sampled = cachedNativeSelectionBackground;
    if (sampled) {
        root.style.setProperty("--page-search-inline-sel-bg", sampled);
        return;
    }
    root.style.setProperty("--page-search-inline-sel-bg", "Highlight");
}

function clearNativeSelectionColorVars(): void {
    document.documentElement.style.removeProperty("--page-search-inline-sel-bg");
}

function sampleNativeSelectionBackground(): string | null {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;";
    const span = document.createElement("span");
    span.textContent = "Hg";
    host.appendChild(span);
    document.body.appendChild(host);

    const selection = window.getSelection();
    const saved: Range[] = [];
    if (selection) {
        for (let i = 0; i < selection.rangeCount; i += 1) {
            try {
                saved.push(selection.getRangeAt(i).cloneRange());
            } catch {
                // ignore
            }
        }
    }

    try {
        const range = document.createRange();
        range.selectNodeContents(span);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const backgroundColor = getComputedStyle(span, "::selection").backgroundColor;
        if (
            !backgroundColor
            || backgroundColor === "transparent"
            || backgroundColor === "rgba(0, 0, 0, 0)"
        ) {
            return null;
        }
        return backgroundColor;
    } catch {
        return null;
    } finally {
        try {
            selection?.removeAllRanges();
            for (const savedRange of saved) {
                selection?.addRange(savedRange);
            }
        } catch {
            // ignore
        }
        host.remove();
    }
}

function looksLikeFullBlockScope(edit: Element, scope: SelectionScope): boolean {
    if (edit.querySelector(".protyle-wysiwyg .protyle-wysiwyg--select")) {
        return true;
    }
    const blocks = collectSearchableBlocks(edit);
    const blockMap = new Map(blocks.map((block) => [unitKeyOf(block), block]));
    let full = 0;
    for (const [key, offsets] of scope) {
        const block = blockMap.get(key);
        if (!block || block.text.length === 0) {
            continue;
        }
        if (offsets.some((r) => r.start === 0 && r.end >= block.text.length)) {
            full += 1;
        }
    }
    return full > 0 && full === scope.size;
}

/** 采集 scope 并返回 kind，供开启「仅在选区内查找」时一次完成 */
export function captureSelectionScopeWithKind(
    edit: Element,
    options?: {
        includeAttributeView?: boolean;
        includeTable?: boolean;
        includeBlockquote?: boolean;
        includeCallout?: boolean;
        includeMathBlock?: boolean;
        includeEmbedBlock?: boolean;
        includeWidget?: boolean;
        includeCodeBlock?: boolean;
        includeMermaid?: boolean;
        includeInlineMemo?: boolean;
        restrictInlineTypes?: RestrictInlineType[];
    },
): {
    scope: SelectionScope;
    kind: SelectionScopeVisualKind | null;
    visualBlockIds: string[];
    tableCellRefs: TableCellVisualRef[];
} {
    const blocks = collectSearchableBlocks(edit, {
        includeAttributeView: options?.includeAttributeView !== false,
        includeTable: options?.includeTable !== false,
        includeBlockquote: options?.includeBlockquote !== false,
        includeCallout: options?.includeCallout !== false,
        includeMathBlock: options?.includeMathBlock !== false,
        includeEmbedBlock: options?.includeEmbedBlock !== false,
        includeWidget: options?.includeWidget !== false,
        includeCodeBlock: options?.includeCodeBlock !== false,
        includeMermaid: options?.includeMermaid !== false,
        includeInlineMemo: options?.includeInlineMemo === true,
        restrictInlineTypes: options?.restrictInlineTypes,
    });
    const kind = detectSelectionScopeKind(edit);
    const scope = getSelectionScope(edit, blocks);
    const visualBlockIds = kind === "text" ? [] : captureSelectedBlockIds(edit);
    const tableCellRefs = kind === "table-cells" ? captureTableCellVisualRefs(edit) : [];
    return {scope, kind, visualBlockIds, tableCellRefs};
}
