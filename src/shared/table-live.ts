/**
 * 虚拟大表：画面上的格子和 getBlockDOM 的完整表按逻辑行号、列号对齐。
 * 思源单元格是普通 td/th，没有 data-node-id。
 * 占位行属性里是被收起的 tr，只数行，不解析成搜索文本。
 * 文字相同留下内核单元，替换才能对上完整 HTML。
 * 文字不同的格子用画面单元，并记入 staleKeys，这次不能替换。
 */

export interface VirtualTableLiveState<T extends {unitId?: string; text: string}> {
    /** 已挂载格子的 `行:列`，含已经清空、以及这次关键词对不上的格子。 */
    shownKeys: ReadonlySet<string>;
    /** 画面上还有文字、并且可能命中的格子。键是逻辑位置，不是画面 unitId。 */
    liveByKey: ReadonlyMap<string, T>;
    unstable: boolean;
}

const TABLE_CELL_PREFIX = "table-cell:";
/** 思源把屏外行的 outerHTML 收在这个属性里，占位行本身不是数据行。 */
export const TABLE_VIRTUAL_ROWS_ATTR = "data-sy-table-virtual-rows";

/**
 * 占位行属性是若干行 outerHTML 拼起来的。
 * 虚拟化的表没有嵌套表，用户输入的 `<tr` 会被转义，因此按标签计数即可。
 * 单次扫描，不分配小写副本，也不把这段 HTML 解析成 DOM。
 */
export function countVirtualTableRows(html: string): number {
    if (!html) {
        return 0;
    }
    let count = 0;
    const end = html.length - 3;
    for (let index = 0; index <= end; index += 1) {
        if (html.charCodeAt(index) !== 60) {
            continue;
        }
        const second = html.charCodeAt(index + 1);
        const third = html.charCodeAt(index + 2);
        const isTr = (second === 116 || second === 84) && (third === 114 || third === 82);
        if (!isTr) {
            continue;
        }
        const next = html.charCodeAt(index + 3);
        if (next === 62 || next === 47 || next === 32 || next === 9 || next === 10 || next === 13) {
            count += 1;
            index += 2;
        }
    }
    return count;
}

function ownHtmlTable(element: HTMLElement): HTMLTableElement | null {
    if (element instanceof HTMLTableElement) {
        return element;
    }
    const tables = element.querySelectorAll("table");
    for (let index = 0; index < tables.length; index += 1) {
        const table = tables[index];
        if (!(table instanceof HTMLTableElement)) {
            continue;
        }
        const host = table.closest<HTMLElement>('[data-type="NodeTable"]');
        if (host === element) {
            return table;
        }
    }
    return null;
}

/**
 * 只看这张表自己的 table。嵌套表上的占位属性不算到外层。
 * table.rows 不含嵌套表的行，也不把屏外 HTML 解析进 DOM。
 */
export function tableHostOmitsRows(element: HTMLElement): boolean {
    const table = ownHtmlTable(element);
    if (!table) {
        return element.hasAttribute("data-sy-table-virtual-id")
            || element.hasAttribute("data-sy-table-virtual-rows")
            || element.hasAttribute("data-sy-table-virtual-columns");
    }
    if (table.hasAttribute("data-sy-table-virtual-id")) {
        return true;
    }
    const rows = table.rows;
    for (let index = 0; index < rows.length; index += 1) {
        if (rows[index].hasAttribute(TABLE_VIRTUAL_ROWS_ATTR)) {
            return true;
        }
    }
    const children = table.children;
    for (let index = 0; index < children.length; index += 1) {
        if (children[index].hasAttribute("data-sy-table-virtual-columns")) {
            return true;
        }
    }
    return false;
}

/** 虚拟表合并用的格子键。同一格被 br、公式或图片切开时，用 `#run-N` 区分，避免后一段被前一段盖掉。 */
export function tableOverlayKey(unitId: string | undefined): string {
    const position = tableCellPosition(unitId);
    if (!position) {
        return "";
    }
    const run = /#run-(\d+)$/.exec(unitId ?? "");
    return run ? `${position}#${run[1]}` : position;
}

/** `table-cell:行:列` 或 `table-cell:行:列:单元格id` 里的逻辑位置。对不上时返回空串。 */
export function tableCellPosition(unitId: string | undefined): string {
    if (!unitId || unitId.indexOf(TABLE_CELL_PREFIX) !== 0) {
        return "";
    }
    const rowStart = TABLE_CELL_PREFIX.length;
    const rowEnd = unitId.indexOf(":", rowStart);
    if (rowEnd <= rowStart) {
        return "";
    }
    const colEnd = unitId.indexOf(":", rowEnd + 1);
    const colStart = rowEnd + 1;
    const colStop = colEnd < 0 ? unitId.length : colEnd;
    if (colStop <= colStart) {
        return "";
    }
    const row = unitId.slice(rowStart, rowEnd);
    const col = unitId.slice(colStart, colStop);
    if (!isDigits(row) || !isDigits(col)) {
        return "";
    }
    return row + ":" + col;
}

/** `table-cell:行:列:单元格id` 里的单元格 id。没有 id 时返回空串。 */
export function tableCellNodeId(unitId: string | undefined): string {
    if (!tableCellPosition(unitId) || !unitId) {
        return "";
    }
    const rowStart = TABLE_CELL_PREFIX.length;
    const rowEnd = unitId.indexOf(":", rowStart);
    const colEnd = unitId.indexOf(":", rowEnd + 1);
    if (colEnd < 0 || colEnd >= unitId.length - 1) {
        return "";
    }
    return unitId.slice(colEnd + 1);
}

function isDigits(value: string): boolean {
    if (!value) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) {
            return false;
        }
    }
    return true;
}

function isVirtualTableSideUnit(unitId: string | undefined): boolean {
    if (!unitId) {
        return false;
    }
    return unitId.startsWith("inline-memo:")
        || unitId.startsWith("inline-math:")
        || unitId.startsWith("table-memo:");
}

function sameCellText(left: string, right: string): boolean {
    return stripZw(left) === stripZw(right);
}

function stripZw(text: string): string {
    return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function unitKey(blockId: string, unitId: string | undefined): string {
    return blockId + "\u0000" + (unitId ?? "");
}

export interface LogicalTableRow {
    /** 这一 DOM 行对应的逻辑行号。占位行是它收起的第一行。 */
    logical: number;
    /** 占位行收起的行数。0 表示这一行就在画面上。 */
    omitted: number;
}

export interface LogicalTableLayout {
    rows: LogicalTableRow[];
    /** 某个占位行数不清时为 false。此时 rows 只保留它之前的行，后面的行号不再使用。 */
    stable: boolean;
}

/**
 * 把画面上的 tr 换成完整表的行号。
 * 占位行按属性里的 tr 个数展开，本身不占一个数据行。
 * 数不清时停住：前缀仍然和完整表对齐，后面的行不猜。
 */
export function logicalTableRows(rows: readonly {getAttribute(name: string): string | null}[]): LogicalTableLayout {
    const placed: LogicalTableRow[] = [];
    let logical = 0;
    for (let index = 0; index < rows.length; index += 1) {
        const source = rows[index].getAttribute(TABLE_VIRTUAL_ROWS_ATTR);
        if (source !== null) {
            const count = countVirtualTableRows(source);
            if (count <= 0) {
                return {rows: placed, stable: false};
            }
            placed.push({logical, omitted: count});
            logical += count;
            continue;
        }
        placed.push({logical, omitted: 0});
        logical += 1;
    }
    return {rows: placed, stable: true};
}

/** 逻辑行号落在哪一个 DOM 行上。找不到时返回 -1。 */
export function logicalRowOffset(rows: readonly LogicalTableRow[], logicalRow: number): number {
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const span = row.omitted > 0 ? row.omitted : 1;
        if (logicalRow >= row.logical && logicalRow < row.logical + span) {
            return index;
        }
    }
    return -1;
}

/**
 * 这块表格自己的 table.rows。嵌套表的行不算进来，和思源虚拟化用的行集合一致。
 * 没有 html table 时返回 null，调用方再走宽松的 tr 扫描。
 */
/**
 * 已挂载格子的逻辑位置。占位行不产生格子。
 * 行号数不清时返回 null，调用方继续用内核 HTML，不猜位置。
 */
export function logicalTableCells(tableBlock: HTMLElement): Map<string, HTMLTableCellElement> | null {
    const rows = ownTableRows(tableBlock);
    if (!rows) {
        return null;
    }
    const placed = logicalTableRows(rows);
    if (!placed.stable) {
        return null;
    }
    const cells = new Map<string, HTMLTableCellElement>();
    for (let index = 0; index < placed.rows.length; index += 1) {
        const place = placed.rows[index];
        if (!place || place.omitted !== 0) {
            continue;
        }
        const children = rows[index].children;
        let column = 0;
        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
            const child = children[childIndex];
            if (!(child instanceof HTMLTableCellElement)) {
                continue;
            }
            cells.set(place.logical + ":" + column, child);
            column += 1;
        }
    }
    return cells;
}

export function ownTableRows(element: HTMLElement): HTMLTableRowElement[] | null {
    const table = ownHtmlTable(element);
    if (!table) {
        return null;
    }
    return Array.from(table.rows);
}

/**
 * 把虚拟表的内核单元和画面单元合成一份。
 * 画面单元不要放进 units：文字相同的格子必须留下内核单元。
 * 键是逻辑 `行:列`。对齐用这个键，不拿 unitId 里的字面行号互相比。
 */
export function mergeVirtualTableUnits<T extends {
    blockId: string;
    blockType: string;
    unitId?: string;
    text: string;
}>(
    units: readonly T[],
    virtual: ReadonlyMap<string, VirtualTableLiveState<T>>,
): {units: T[]; staleKeys: Set<string>} {
    if (virtual.size === 0) {
        return {units: units as T[], staleKeys: new Set()};
    }

    const unstable = new Set<string>();
    for (const [blockId, state] of virtual) {
        if (state.unstable) {
            unstable.add(blockId);
        }
    }
    for (const unit of units) {
        if (unstable.has(unit.blockId) || !virtual.has(unit.blockId)) {
            continue;
        }
        if (unit.blockType !== "NodeTable") {
            continue;
        }
        // 备注和公式不是格子。它们的 unitId 没有行列号，不能因此放弃整张表的画面文字。
        if (!tableCellPosition(unit.unitId) && !isVirtualTableSideUnit(unit.unitId)) {
            unstable.add(unit.blockId);
        }
    }

    const staleKeys = new Set<string>();
    const handled = new Set<string>();
    const next: T[] = [];

    for (const unit of units) {
        const state = virtual.get(unit.blockId);
        const overlay = Boolean(state) && !unstable.has(unit.blockId);
        if (!overlay || !state) {
            next.push(unit);
            continue;
        }
        if (unit.blockType !== "NodeTable") {
            next.push(unit);
            continue;
        }
        const position = tableCellPosition(unit.unitId);
        if (!position || !state.shownKeys.has(position)) {
            next.push(unit);
            continue;
        }
        const overlayKey = tableOverlayKey(unit.unitId);
        const mark = unit.blockId + "\0" + overlayKey;
        if (handled.has(mark)) {
            continue;
        }
        const live = state.liveByKey.get(overlayKey);
        if (live && unit === live) {
            continue;
        }
        handled.add(mark);
        if (!live || sameCellText(live.text, unit.text)) {
            if (live) {
                next.push(unit);
            }
            continue;
        }
        staleKeys.add(unitKey(unit.blockId, live.unitId));
        next.push(live);
    }

    for (const [blockId, state] of virtual) {
        if (unstable.has(blockId)) {
            continue;
        }
        for (const [position, live] of state.liveByKey) {
            const mark = blockId + "\0" + position;
            if (handled.has(mark)) {
                continue;
            }
            staleKeys.add(unitKey(blockId, live.unitId));
            next.push(live);
        }
    }
    return {units: next, staleKeys};
}
