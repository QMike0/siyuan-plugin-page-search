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
        if (rows[index].hasAttribute("data-sy-table-virtual-rows")) {
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

function sameCellText(left: string, right: string): boolean {
    return stripZw(left) === stripZw(right);
}

function stripZw(text: string): string {
    return text.replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function unitKey(blockId: string, unitId: string | undefined): string {
    return blockId + "\u0000" + (unitId ?? "");
}

/**
 * 把虚拟表的内核单元和画面单元合成一份。
 * 画面单元不要放进 units：文字相同的格子必须留下内核单元。
 * 键是逻辑 `行:列`。画面 unitId 含占位行，行号和完整表不一致。
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
        if (!tableCellPosition(unit.unitId)) {
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
        const mark = unit.blockId + "\0" + position;
        if (handled.has(mark)) {
            continue;
        }
        const live = state.liveByKey.get(position);
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
