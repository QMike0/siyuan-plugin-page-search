import {
    ATTRIBUTE_VIEW_TYPE,
    collectTableCellSearchTextNodes,
    isAttributeInlineSearchUnit,
    tableCellSearchRoot,
} from "./blocks";
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

/**
 * 从当前窗口选区 / 单元格选中 / 块级选中构建相对 SearchableBlock 的选区范围。
 * 键为 unitKey，与 pipeline 一致。
 *
 * 文字选区优先。否则数据库格子、勾选行、画廊卡片，以及表格单元格，只收录被选中的单元。
 * 有单元格选中时不再并入整块，避免把整张表或整个数据库算进去。
 *
 * 思源 3.8.6 的表格选区在 TableControl 里，画面是 `.protyle-table-control__selection`。
 * 点到表格外会清掉它，所以表格格子要在按下「仅在选区内查找」时先快照，经 tableCells 传入。
 * 旧的 `.table__select` 仍作兜底。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/util/tableControl.ts
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/render/av/rangeSelect.ts
 */
export function getSelectionScope(
    edit: Element,
    blocks: SearchableBlock[],
    tableCells?: readonly HTMLTableCellElement[],
    includeAttributeViewCells = false,
    tableCellText?: TableCellTextSelection | null,
): SelectionScope {
    if (tableCellText) {
        const fromCellText = selectionScopeFromTableCellText(blocks, tableCellText);
        if (fromCellText.size > 0) {
            return fromCellText;
        }
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const fromText = getSelectionScopeFromTextRanges(blocks, selection);
        if (fromText.size > 0) {
            return fromText;
        }
    }

    const avHosts = includeAttributeViewCells ? collectAttributeViewSelectionHosts(edit) : [];
    const snappedCells = tableCells && tableCells.length > 0 ? tableCells : [];
    if (avHosts.length > 0 || snappedCells.length > 0) {
        return mergeSelectionScopes(
            selectionScopeFromHosts(blocks, avHosts),
            selectionScopeFromHosts(blocks, snappedCells),
        );
    }

    return mergeSelectionScopes(
        getSelectionScopeFromTableSelect(edit, blocks),
        getSelectionScopeFromSelectedBlocks(edit, blocks),
    );
}

/**
 * 数据库里当前选中的格子、整行或画廊卡片。
 * 这些 class 在点编辑器外面时还在；点进编辑器会被思源清掉。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/render/av/selectionState.ts restoreAVCellSelection
 */
export function collectAttributeViewSelectionHosts(edit: Element): HTMLElement[] {
    const hosts: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const push = (host: HTMLElement | null) => {
        if (!host || seen.has(host)) {
            return;
        }
        seen.add(host);
        hosts.push(host);
    };

    edit.querySelectorAll<HTMLElement>(
        ".protyle-wysiwyg .av__row--select, .protyle-wysiwyg .av__gallery-item--select",
    ).forEach((host) => {
        push(host);
    });
    edit.querySelectorAll<HTMLElement>(
        ".protyle-wysiwyg .av__cell--active, .protyle-wysiwyg .av__cell--select",
    ).forEach((cell) => {
        if (cell.closest(".av__row--select, .av__gallery-item--select")) {
            return;
        }
        push(cell);
    });
    return hosts;
}

/**
 * 读思源表格选区浮层，返回中心点落在浮层里的已挂载格子。
 * 浮层是 position:fixed，坐标就是视口坐标。屏外的虚拟行没有格子 DOM，也不在搜索文本里。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/util/tableControl.ts appendSelectionRect
 */
export function snapshotTableControlCells(edit: Element): HTMLTableCellElement[] {
    const overlays = edit.querySelectorAll<HTMLElement>(
        ".protyle-table-control__selection:not(.fn__none)",
    );
    if (overlays.length === 0) {
        return [];
    }
    const rects: DOMRect[] = [];
    for (let index = 0; index < overlays.length; index += 1) {
        const rect = overlays[index].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            rects.push(rect);
        }
    }
    if (rects.length === 0) {
        return [];
    }

    const cells: HTMLTableCellElement[] = [];
    const seen = new Set<HTMLTableCellElement>();
    const candidates = edit.querySelectorAll<HTMLTableCellElement>(
        ".protyle-wysiwyg td, .protyle-wysiwyg th",
    );
    for (let index = 0; index < candidates.length; index += 1) {
        const cell = candidates[index];
        if (seen.has(cell) || cell.classList.contains("fn__none")) {
            continue;
        }
        if (cell.closest("tr[data-sy-table-virtual-rows], .protyle-custom, .mindmap-view__preview-block")) {
            continue;
        }
        const rect = cell.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            continue;
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        let hit = false;
        for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
            const overlay = rects[rectIndex];
            if (x >= overlay.left && x <= overlay.right && y >= overlay.top && y <= overlay.bottom) {
                hit = true;
                break;
            }
        }
        if (!hit) {
            continue;
        }
        seen.add(cell);
        cells.push(cell);
    }
    return cells;
}

/** 同一格子内的文字划选。编辑器关闭后 Range 会失效，所以提前记下偏移。 */
export interface TableCellTextSelection {
    cell: HTMLTableCellElement;
    start: number;
    end: number;
    /** 去掉零宽字符后的正文，用来核对写回后的格子文本。 */
    text: string;
    inlineMarks: ReadonlyArray<{kind: "math" | "memo"; index: number}>;
}

/**
 * 划选两端都在同一个 td/th 里时，按搜索用的正文节点记下偏移。
 * 必须在单元格编辑器的 document pointerdown 调用 finish() 之前读取。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/render/tableCellRichEditor.ts
 */
export function snapshotTableCellTextSelection(includeImageTitle = true): TableCellTextSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }
    const range = selection.getRangeAt(0);
    const startCell = tableCellFromNode(range.startContainer);
    const endCell = tableCellFromNode(range.endContainer);
    if (!startCell || startCell !== endCell) {
        return null;
    }

    const textNodes = collectTableCellSearchTextNodes(startCell, includeImageTitle);
    const pieces = mergeTextOffsetRanges(getIntersectedTextRanges(textNodes, range));
    const start = pieces.length > 0 ? pieces[0].start : 0;
    const end = pieces.length > 0 ? pieces[pieces.length - 1].end : 0;
    let selected = "";
    if (end > start) {
        let cursor = 0;
        for (let index = 0; index < textNodes.length; index += 1) {
            const text = textNodes[index].nodeValue ?? "";
            const next = cursor + text.length;
            if (next > start && cursor < end) {
                selected += text.slice(Math.max(0, start - cursor), Math.min(text.length, end - cursor));
            }
            cursor = next;
        }
        selected = stripZwsp(selected);
    }
    const inlineMarks = inlineMarksInRange(startCell, range);
    if (end <= start && inlineMarks.length === 0) {
        return null;
    }
    return {cell: startCell, start, end, text: selected, inlineMarks};
}

/** 把划选偏移对到当前搜索单元。对不上选中文字时不猜范围。 */
export function selectionScopeFromTableCellText(
    blocks: readonly SearchableBlock[],
    snap: TableCellTextSelection,
): SelectionScope {
    const scope: SelectionScope = new Map();
    if (!snap.cell.isConnected) {
        return scope;
    }
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.element !== snap.cell || isAttributeInlineSearchUnit(block) || block.text.length <= 0) {
            continue;
        }
        const range = reconcileCellTextRange(block.text, snap.start, snap.end, snap.text);
        if (!range) {
            continue;
        }
        scope.set(unitKeyOf(block), [range]);
    }
    if (snap.inlineMarks.length === 0) {
        return scope;
    }
    const mathHosts = inlineHostsInCell(snap.cell, "math");
    const memoHosts = inlineHostsInCell(snap.cell, "memo");
    for (let markIndex = 0; markIndex < snap.inlineMarks.length; markIndex += 1) {
        const mark = snap.inlineMarks[markIndex];
        const host = (mark.kind === "math" ? mathHosts : memoHosts)[mark.index];
        if (!host) {
            continue;
        }
        for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index];
            if (block.element !== host || block.text.length <= 0) {
                continue;
            }
            scope.set(unitKeyOf(block), [{start: 0, end: block.text.length}]);
        }
    }
    return scope;
}

function tableCellFromNode(node: Node): HTMLTableCellElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const cell = element?.closest("td, th");
    if (!(cell instanceof HTMLTableCellElement)) {
        return null;
    }
    if (cell.closest(".protyle-custom, .mindmap-view__preview-block")) {
        return null;
    }
    return cell;
}

function inlineMarksInRange(
    cell: HTMLTableCellElement,
    range: Range,
): Array<{kind: "math" | "memo"; index: number}> {
    const marks: Array<{kind: "math" | "memo"; index: number}> = [];
    const kinds: Array<"math" | "memo"> = ["math", "memo"];
    for (let kindIndex = 0; kindIndex < kinds.length; kindIndex += 1) {
        const kind = kinds[kindIndex];
        const hosts = inlineHostsInCell(cell, kind);
        for (let index = 0; index < hosts.length; index += 1) {
            if (!rangeIntersectsElement(range, hosts[index])) {
                continue;
            }
            marks.push({kind, index});
        }
    }
    return marks;
}

function inlineHostsInCell(cell: HTMLTableCellElement, kind: "math" | "memo"): HTMLElement[] {
    const root = tableCellSearchRoot(cell);
    const selector = kind === "math"
        ? "span[data-type~=\"inline-math\"]"
        : "span[data-type~=\"inline-memo\"]";
    const hosts: HTMLElement[] = [];
    const found = root.querySelectorAll<HTMLElement>(selector);
    for (let index = 0; index < found.length; index += 1) {
        const host = found[index];
        if (host.closest(".protyle-attr, .fn__none")) {
            continue;
        }
        hosts.push(host);
    }
    return hosts;
}

function rangeIntersectsElement(range: Range, element: Element): boolean {
    try {
        return typeof range.intersectsNode === "function" && range.intersectsNode(element);
    } catch {
        return false;
    }
}

function reconcileCellTextRange(
    blockText: string,
    start: number,
    end: number,
    selected: string,
): TextOffsetRange | null {
    if (selected.length === 0) {
        return null;
    }
    if (start >= 0 && end > start && end <= blockText.length
        && stripZwsp(blockText.slice(start, end)) === selected) {
        return {start, end};
    }
    return findClosestText(blockText, selected, start);
}

function findClosestText(text: string, needle: string, hint: number): TextOffsetRange | null {
    const rawAt: number[] = [];
    let stripped = "";
    for (let index = 0; index < text.length; index += 1) {
        if (isZwsp(text.charCodeAt(index))) {
            continue;
        }
        rawAt.push(index);
        stripped += text.charAt(index);
    }
    let from = 0;
    let best: TextOffsetRange | null = null;
    let bestDistance = -1;
    while (from <= stripped.length - needle.length) {
        const at = stripped.indexOf(needle, from);
        if (at < 0 || at + needle.length > rawAt.length) {
            break;
        }
        const rawStart = rawAt[at];
        const rawEnd = rawAt[at + needle.length - 1] + 1;
        const distance = rawStart > hint ? rawStart - hint : hint - rawStart;
        if (!best || distance < bestDistance) {
            best = {start: rawStart, end: rawEnd};
            bestDistance = distance;
        }
        if (distance === 0) {
            break;
        }
        from = at + 1;
    }
    return best;
}

function stripZwsp(value: string): string {
    let out = "";
    for (let index = 0; index < value.length; index += 1) {
        if (isZwsp(value.charCodeAt(index))) {
            continue;
        }
        out += value.charAt(index);
    }
    return out;
}

function isZwsp(code: number): boolean {
    return code === 0x200B || code === 0x200C || code === 0x200D || code === 0x2060 || code === 0xFEFF;
}

/**
 * 宿主本身或其内部的搜索单元整段入选。不把包住宿主的父块算进去。
 * 从单元往父节点走，避免选中很多格子时对全部单元做两两包含判断。
 */
export function selectionScopeFromHosts(
    blocks: readonly SearchableBlock[],
    hosts: readonly HTMLElement[],
): SelectionScope {
    const scope: SelectionScope = new Map();
    if (hosts.length === 0) {
        return scope;
    }
    const hostSet = new Set<HTMLElement>();
    for (let index = 0; index < hosts.length; index += 1) {
        hostSet.add(hosts[index]);
    }
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.text.length <= 0 || !elementInsideHost(block.element, hostSet)) {
            continue;
        }
        scope.set(unitKeyOf(block), [{start: 0, end: block.text.length}]);
    }
    return scope;
}

function elementInsideHost(element: HTMLElement, hostSet: Set<HTMLElement>): boolean {
    let current: HTMLElement | null = element;
    while (current) {
        if (hostSet.has(current)) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
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
 * 3.8.6 拖选结束后会删掉这块浮层，正常路径走 snapshotTableControlCells。
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

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.text.length <= 0) {
            continue;
        }
        let covered = false;
        for (let cellIndex = 0; cellIndex < selectedCells.length; cellIndex += 1) {
            const cell = selectedCells[cellIndex];
            if (
                cell === block.element
                || cell.contains(block.element)
                || block.element.contains(cell)
            ) {
                covered = true;
                break;
            }
        }
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

export function mergeSelectionScopes(
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
    // 备注 / 公式：text 在属性里，无 textNodes；选区与宿主 span 相交则整段属性文本入选
    if (isAttributeInlineSearchUnit(block)) {
        return getSelectionRangesForAttributeHost(block, selection);
    }
    if (!block.textNodes.length) {
        return [];
    }

    const ranges: TextOffsetRange[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
        ranges.push(...getIntersectedTextRanges(block.textNodes, selection.getRangeAt(index)));
    }
    return mergeTextOffsetRanges(ranges);
}

/**
 * 属性型 unit：选区与宿主元素相交 → 纳入完整属性文本偏移。
 * 与限制过滤叠加：pipeline 先 scope 再 restrict。
 */
function getSelectionRangesForAttributeHost(
    block: SearchableBlock,
    selection: Selection,
): TextOffsetRange[] {
    if (block.text.length <= 0) {
        return [];
    }
    for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        if (selectionRangeIntersectsElement(range, block.element)) {
            return [{start: 0, end: block.text.length}];
        }
    }
    return [];
}

function selectionRangeIntersectsElement(range: Range, element: Element): boolean {
    try {
        if (typeof range.intersectsNode === "function") {
            return range.intersectsNode(element);
        }
    } catch {
        // fall through
    }
    try {
        const hostRange = range.ownerDocument?.createRange() ?? document.createRange();
        hostRange.selectNodeContents(element);
        return (
            range.compareBoundaryPoints(Range.END_TO_START, hostRange) < 0
            && range.compareBoundaryPoints(Range.START_TO_END, hostRange) > 0
        );
    } catch {
        return false;
    }
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
