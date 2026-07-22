import {ATTRIBUTE_VIEW_TYPE} from "./blocks";
import type {SearchableBlock} from "./dom-types";

/** 单元内文本偏移区间 [start, end) */
export interface TextOffsetRange {
    start: number;
    end: number;
}

/** unitKey → 选区内偏移区间列表 */
export type SelectionScope = Map<string, TextOffsetRange[]>;

export function unitKey(blockId: string, unitId?: string): string {
    return `${blockId}::${unitId ?? ""}`;
}

export function unitKeyOf(block: Pick<SearchableBlock, "blockId" | "unitId">): string {
    return unitKey(block.blockId, block.unitId);
}

/**
 * 整库块选后，用当前 DOM 重建该数据库下的选区单元。
 *
 * 思源切换视图 / 布局会 avRender 重建内部 DOM，cell / group / header 的 unitId
 *（含 groupId、rowId 等）会变；若继续用捕获时冻结的 unitKey 过滤，就会出现：
 * - 只能命中稳定的「数据库标题」
 * - 或只能命中部分字段值、列名 / 分组标题对不上
 *
 * 仅当 visualBlockIds 仍指向整块 NodeAttributeView 时刷新；文本选区 / 局部选区不受影响。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/render.ts
 */
export function refreshWholeAttributeViewSelectionScope(
    edit: Element,
    scope: SelectionScope,
    visualBlockIds: string[] | null | undefined,
    blocks: SearchableBlock[],
): SelectionScope {
    const wholeAvIds = collectWholeSelectedAttributeViewIds(edit, visualBlockIds);
    if (wholeAvIds.size === 0) {
        return cloneSelectionScope(scope);
    }

    const next = cloneSelectionScope(scope);
    for (const avId of wholeAvIds) {
        const prefix = `${avId}::`;
        for (const key of [...next.keys()]) {
            if (key.startsWith(prefix)) {
                next.delete(key);
            }
        }
        for (const block of blocks) {
            if (
                block.blockId !== avId
                || block.blockType !== ATTRIBUTE_VIEW_TYPE
                || block.text.length <= 0
            ) {
                continue;
            }
            next.set(unitKeyOf(block), [{start: 0, end: block.text.length}]);
        }
    }
    return next;
}

/** 从冻结的块选 id 中筛出当前仍存在的整块数据库 */
function collectWholeSelectedAttributeViewIds(
    edit: Element,
    visualBlockIds: string[] | null | undefined,
): Set<string> {
    const ids = new Set<string>();
    if (!visualBlockIds?.length) {
        return ids;
    }
    for (const id of visualBlockIds) {
        if (!id) {
            continue;
        }
        const escaped = CSS.escape(id);
        const el = edit.querySelector(
            `.protyle-wysiwyg [data-node-id="${escaped}"][data-type="${ATTRIBUTE_VIEW_TYPE}"],`
            + `.protyle-wysiwyg [data-node-id="${escaped}"].av`,
        );
        if (el) {
            ids.add(id);
        }
    }
    return ids;
}

export function getCurrentSelectionText(): string {
    return window.getSelection()?.toString() ?? "";
}

/**
 * 从当前窗口选区 / 表格框选 / 块级选中构建相对 SearchableBlock 的选区范围。
 * 键为 unitKey，与 pipeline 一致。
 *
 * 思源表格多选单元格不走原生 Selection，而是用 `.table__select` 矩形 + 几何命中；
 * mouseup 后还会 collapse 原生 Range，故必须单独采集。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/table.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/index.ts
 */
export function getSelectionScope(
    edit: Element,
    blocks: SearchableBlock[],
): SelectionScope {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const fromText = getSelectionScopeFromTextRanges(blocks, selection);
        if (fromText.size > 0) {
            return fromText;
        }
    }

    return mergeSelectionScopes(
        getSelectionScopeFromTableSelect(edit, blocks),
        getSelectionScopeFromSelectedBlocks(edit, blocks),
    );
}

/** 编辑器内是否存在有效的表格单元格框选（.table__select 有尺寸） */
export function hasActiveTableCellSelect(edit: Element): boolean {
    return getActiveTableSelectCells(edit).length > 0;
}

/**
 * 返回思源 `.table__select` 当前覆盖的单元格。
 * 仅采集 DOM 引用，不修改单元格；调用方可据此冻结视觉范围。
 */
export function getActiveTableSelectCells(edit: Element): HTMLTableCellElement[] {
    return collectActiveTableSelectCells(edit);
}

export function cloneSelectionScope(scope: SelectionScope): SelectionScope {
    const cloned: SelectionScope = new Map();
    for (const [key, ranges] of scope) {
        cloned.set(key, ranges.map((range) => ({...range})));
    }
    return cloned;
}

/** 命中 [start, end) 是否完全落在选区某一段内 */
export function isMatchWithinSelection(
    key: string,
    start: number,
    end: number,
    selectionOnly: boolean,
    selectionScope: SelectionScope,
): boolean {
    if (!selectionOnly) {
        return true;
    }
    const ranges = selectionScope.get(key) ?? [];
    return ranges.some((range) => isRangeContained(range, start, end));
}

export function isRangeContained(
    range: TextOffsetRange,
    start: number,
    end: number,
): boolean {
    return start >= range.start && end <= range.end;
}

export function mergeTextOffsetRanges(ranges: TextOffsetRange[]): TextOffsetRange[] {
    const sorted = [...ranges].sort((left, right) => left.start - right.start);
    const merged: TextOffsetRange[] = [];

    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || range.start > previous.end) {
            merged.push({...range});
            continue;
        }
        previous.end = Math.max(previous.end, range.end);
    }

    return merged;
}

function getSelectionScopeFromTextRanges(
    blocks: SearchableBlock[],
    selection: Selection,
): SelectionScope {
    const scope: SelectionScope = new Map();

    for (const block of blocks) {
        const ranges = getSelectionRangesWithinUnit(block, selection);
        if (!ranges.length) {
            continue;
        }
        scope.set(unitKeyOf(block), ranges);
    }

    return scope;
}

/**
 * 块级选中（.protyle-wysiwyg--select）：整单元纳入选区。
 */
function getSelectionScopeFromSelectedBlocks(
    edit: Element,
    blocks: SearchableBlock[],
): SelectionScope {
    const scope: SelectionScope = new Map();
    const selectedElements = Array.from(
        edit.querySelectorAll<HTMLElement>(".protyle-wysiwyg .protyle-wysiwyg--select"),
    );
    if (!selectedElements.length) {
        return scope;
    }

    for (const block of blocks) {
        if (block.text.length <= 0) {
            continue;
        }
        const covered = selectedElements.some((selected) =>
            selected === block.element
            || selected.contains(block.element)
            || block.element.contains(selected)
        );
        if (!covered) {
            continue;
        }
        scope.set(unitKeyOf(block), [{start: 0, end: block.text.length}]);
    }

    return scope;
}

/**
 * 思源表格 `.table__select` 框选：将命中的 td/th 对应搜索单元整段纳入选区。
 * 对齐 clearTableCell / isIncludeCell 的几何判定。
 */
function getSelectionScopeFromTableSelect(
    edit: Element,
    blocks: SearchableBlock[],
): SelectionScope {
    const scope: SelectionScope = new Map();
    const selectedCells = collectActiveTableSelectCells(edit);
    if (!selectedCells.length) {
        return scope;
    }

    for (const block of blocks) {
        if (block.text.length <= 0) {
            continue;
        }
        const covered = selectedCells.some((cell) =>
            cell === block.element
            || cell.contains(block.element)
            || block.element.contains(cell)
        );
        if (!covered) {
            continue;
        }
        scope.set(unitKeyOf(block), [{start: 0, end: block.text.length}]);
    }

    return scope;
}

function collectActiveTableSelectCells(edit: Element): HTMLTableCellElement[] {
    const cells: HTMLTableCellElement[] = [];
    const tables = edit.querySelectorAll<HTMLElement>(
        '.protyle-wysiwyg [data-type="NodeTable"], .protyle-wysiwyg .table',
    );

    tables.forEach((tableBlock) => {
        const tableSelectElement = tableBlock.querySelector<HTMLElement>(":scope .table__select");
        if (!isActiveTableSelect(tableSelectElement)) {
            return;
        }
        const scrollLeft = (tableBlock.firstElementChild as HTMLElement | null)?.scrollLeft ?? 0;
        const scrollTop = tableBlock.querySelector("table")?.scrollTop ?? 0;

        tableBlock.querySelectorAll("th, td").forEach((item) => {
            const cell = item as HTMLTableCellElement;
            if (cell.classList.contains("fn__none")) {
                return;
            }
            // 嵌套表：只认属于当前 NodeTable 的格子
            const owner = cell.closest<HTMLElement>('[data-type="NodeTable"], .table');
            if (owner && owner !== tableBlock) {
                return;
            }
            if (isIncludeTableCell({
                tableSelectElement: tableSelectElement!,
                scrollLeft,
                scrollTop,
                item: cell,
            })) {
                cells.push(cell);
            }
        });
    });

    return cells;
}

function isActiveTableSelect(el: HTMLElement | null): el is HTMLElement {
    if (!el) {
        return false;
    }
    // 思源以 style + clientWidth 判定框选是否有效
    return Boolean(el.getAttribute("style")) && el.clientWidth > 0;
}

/**
 * @see isIncludeCell in siyuan app/src/protyle/util/table.ts
 */
function isIncludeTableCell(options: {
    tableSelectElement: HTMLElement;
    scrollLeft: number;
    scrollTop: number;
    item: HTMLTableCellElement;
}): boolean {
    const {tableSelectElement, scrollLeft, scrollTop, item} = options;
    return item.offsetLeft + 6 > tableSelectElement.offsetLeft + scrollLeft
        && item.offsetLeft + item.clientWidth - 6
            < tableSelectElement.offsetLeft + scrollLeft + tableSelectElement.clientWidth
        && item.offsetTop + 6 > tableSelectElement.offsetTop + scrollTop
        && item.offsetTop + item.clientHeight - 6
            < tableSelectElement.offsetTop + scrollTop + tableSelectElement.clientHeight;
}

function mergeSelectionScopes(
    ...scopes: SelectionScope[]
): SelectionScope {
    const merged: SelectionScope = new Map();
    for (const scope of scopes) {
        for (const [key, ranges] of scope) {
            const existing = merged.get(key);
            if (!existing) {
                merged.set(key, ranges.map((range) => ({...range})));
                continue;
            }
            merged.set(key, mergeTextOffsetRanges([
                ...existing,
                ...ranges.map((range) => ({...range})),
            ]));
        }
    }
    return merged;
}

function getSelectionRangesWithinUnit(
    block: SearchableBlock,
    selection: Selection,
): TextOffsetRange[] {
    if (!block.textNodes.length) {
        return [];
    }

    const ranges: TextOffsetRange[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
        ranges.push(...getIntersectedTextRanges(block.textNodes, selection.getRangeAt(index)));
    }
    return mergeTextOffsetRanges(ranges);
}

function getIntersectedTextRanges(textNodes: Text[], selectionRange: Range): TextOffsetRange[] {
    const ranges: TextOffsetRange[] = [];
    let cursor = 0;

    for (const textNode of textNodes) {
        const text = textNode.nodeValue ?? "";
        const nextCursor = cursor + text.length;
        if (!text.length) {
            cursor = nextCursor;
            continue;
        }

        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(textNode);

        let startRelation: number;
        let endRelation: number;
        try {
            startRelation = nodeRange.comparePoint(
                selectionRange.startContainer,
                selectionRange.startOffset,
            );
            endRelation = nodeRange.comparePoint(
                selectionRange.endContainer,
                selectionRange.endOffset,
            );
        } catch {
            cursor = nextCursor;
            continue;
        }

        // comparePoint: -1 在前，0 内，1 在后
        if (startRelation === 1 || endRelation === -1) {
            cursor = nextCursor;
            continue;
        }

        const start = startRelation === -1
            ? 0
            : measureTextOffset(nodeRange, selectionRange.startContainer, selectionRange.startOffset);
        const end = endRelation === 1
            ? text.length
            : measureTextOffset(nodeRange, selectionRange.endContainer, selectionRange.endOffset);

        if (end > start) {
            ranges.push({
                start: cursor + start,
                end: cursor + end,
            });
        }

        cursor = nextCursor;
    }

    return ranges;
}

function measureTextOffset(baseRange: Range, container: Node, offset: number): number {
    try {
        const range = document.createRange();
        range.setStart(baseRange.startContainer, baseRange.startOffset);
        range.setEnd(container, offset);
        return range.toString().length;
    } catch {
        return 0;
    }
}
