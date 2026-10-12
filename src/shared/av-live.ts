/**
 * 打开着的数据库：画面单元和接口单元按行、列对齐。
 * 画面上已经有文字的格子不再叠接口结果。没有稳定 id 的可见格子则整块不并接口。
 */

export interface AvDomCoverage {
    unstable: boolean;
    cells: Set<string>;
    /** 当前视图画面上出现过的列。隐藏列和别的视图的字段不在这里。 */
    columns: Set<string>;
    title: boolean;
    viewIds: Set<string>;
    groupTitles: Set<string>;
    /** 日历卡片上没有列 id 的标题文字，同一行只用来挡一次接口单元。 */
    rowLabelText: Map<string, string>;
}

export function emptyAvDomCoverage(): AvDomCoverage {
    return {
        unstable: false,
        cells: new Set<string>(),
        columns: new Set<string>(),
        title: false,
        viewIds: new Set<string>(),
        groupTitles: new Set<string>(),
        rowLabelText: new Map<string, string>(),
    };
}

/** A row displayed in two groups owns two distinct cells. Keep ungrouped IDs compatible. */
export function avCellUnitId(row: string, col: string, group = "nogroup"): string {
    return group === "nogroup" ? `av:${row}:${col}` : `av-group:${group}:${row}:${col}`;
}

export function avApiCellPosition(unitId: string): {row: string; col: string;} | null {
    if (unitId.startsWith("av-group:")) {
        const parts = unitId.split(":");
        if (parts.length < 4 || !parts[1] || !parts[2]) return null;
        return {row: `group:${parts[1]}:${parts[2]}`, col: parts.slice(3).join(":")};
    }
    if (!unitId.startsWith("av:")) return null;
    const rest = unitId.slice(3);
    const splitAt = rest.indexOf(":");
    return splitAt > 0 ? {row: rest.slice(0, splitAt), col: rest.slice(splitAt + 1)} : null;
}

/** API and DOM spell the same AV cell differently. Split runs only alias the
 * corresponding split run, never the whole cell. */
export function avApiUnitId(unitId?: string): string | undefined {
    if (!unitId) return undefined;
    const run = /#run-\d+$/.exec(unitId)?.[0];
    if (run) {
        const base = avApiUnitId(unitId.slice(0, -run.length));
        return base && avApiCellPosition(base.replace(/^embed:[^:]+:/, "")) ? base + run : undefined;
    }
    const sourceEnd = unitId.startsWith("embed:") ? unitId.indexOf(":", 6) : -1;
    if (unitId.startsWith("embed:") && sourceEnd < 0) return undefined;
    const prefix = sourceEnd < 0 ? "" : unitId.slice(0, sourceEnd + 1);
    const local = sourceEnd < 0 ? unitId : unitId.slice(sourceEnd + 1);
    if (local === "title") return prefix + "av-title";
    if (local.startsWith("view-name:")) return prefix + "av-view:" + local.slice(10);
    if (local === "av-title" || local.startsWith("av-view:") || local.startsWith("group-title:") || avApiCellPosition(local)) return unitId;
    const cell = parseShownCell(local);
    if (!cell || cell.unstable || cell.label || cell.row.startsWith("header:")) return undefined;
    return prefix + avCellUnitId(cell.row, cell.col, cell.group);
}

export function embeddedAvApiUnitId(unitId?: string): string | undefined {
    return unitId?.startsWith("embed:") ? avApiUnitId(unitId) : undefined;
}

export function collectAvDomCoverage(
    units: Array<{blockId: string; blockType: string; unitId?: string; text: string;}>,
): Map<string, AvDomCoverage> {
    const coverage = new Map<string, AvDomCoverage>();
    const runTexts = new Map<AvDomCoverage, Map<string, string[]>>();
    for (const unit of units) {
        if (unit.blockType !== "NodeAttributeView" || !unit.unitId) {
            continue;
        }
        let current = coverage.get(unit.blockId);
        if (!current) {
            current = emptyAvDomCoverage();
            coverage.set(unit.blockId, current);
        }
        if (/#run-\d+$/.test(unit.unitId)) {
            let grouped = runTexts.get(current);
            if (!grouped) {
                grouped = new Map<string, string[]>();
                runTexts.set(current, grouped);
            }
            const id = unit.unitId.replace(/#run-\d+$/, "");
            const texts = grouped.get(id) ?? [];
            texts.push(unit.text);
            grouped.set(id, texts);
        } else {
            noteAvDomUnit(current, unit.unitId, unit.text);
        }
    }
    for (const [current, grouped] of runTexts) {
        for (const [id, texts] of grouped) {
            noteAvDomUnit(current, id, texts.join(""));
        }
    }
    return coverage;
}

export function avApiUnitShown(
    unitId: string,
    text: string,
    coverage: AvDomCoverage,
    usedRowLabels: Set<string>,
): boolean {
    unitId = unitId.replace(/#run-\d+$/, "");
    if (coverage.unstable) {
        return true;
    }
    if (unitId === "av-title") {
        return coverage.title;
    }
    if (unitId.startsWith("av-view:")) {
        return coverage.viewIds.has(unitId.slice("av-view:".length));
    }
    if (unitId.startsWith("group-title:")) {
        return coverage.groupTitles.has(unitId.slice("group-title:".length));
    }
    const cell = avApiCellPosition(unitId);
    if (!cell) {
        return false;
    }
    const {row} = cell;
    if (coverage.cells.has(unitId)) {
        return true;
    }
    const label = coverage.rowLabelText.get(row);
    if (label && !usedRowLabels.has(row) && label === foldAvText(text)) {
        usedRowLabels.add(row);
        return true;
    }
    return false;
}

/**
 * 接口格子是否属于当前视图已经画出来的列。
 * 列表 / 日历若画面上还没有列 id，不能把主键以外的字段补进来。
 * 表头或任意可见格子出现过的列，未挂载行仍可以补。
 */
export function avApiUnitInView(
    unitId: string,
    coverage: AvDomCoverage,
    viewType: string,
): boolean {
    unitId = unitId.replace(/#run-\d+$/, "");
    if (coverage.unstable) {
        return true;
    }
    const cell = avApiCellPosition(unitId);
    if (!cell) return true;
    const {col} = cell;
    if (!col) {
        return false;
    }
    if (coverage.columns.size === 0) {
        // Native folded list groups remove their whole row/header body. The
        // selected-view API already filters hidden fields; no mounted column
        // here must not suppress every row in an otherwise visible group.
        if (viewType === "list" && coverage.groupTitles.size > 0) return true;
        return viewType !== "list" && viewType !== "calendar";
    }
    return coverage.columns.has(col);
}

function noteAvDomUnit(coverage: AvDomCoverage, unitId: string, text: string): void {
    unitId = unitId.replace(/#run-\d+$/, "");
    if (unitId === "title") {
        coverage.title = true;
        return;
    }
    if (unitId.startsWith("view-name:")) {
        const viewId = unitId.slice("view-name:".length);
        if (viewId) {
            coverage.viewIds.add(viewId);
        }
        return;
    }
    if (unitId.startsWith("group-title:")) {
        coverage.groupTitles.add(unitId.slice("group-title:".length));
        return;
    }
    const cell = parseShownCell(unitId);
    if (!cell) {
        return;
    }
    if (cell.unstable) {
        coverage.unstable = true;
        return;
    }
    if (cell.label) {
        if (!coverage.rowLabelText.has(cell.row)) {
            coverage.rowLabelText.set(cell.row, foldAvText(text));
        }
        return;
    }
    if (cell.col && cell.col.indexOf("idx-") !== 0) {
        coverage.columns.add(cell.col);
    }
    if (cell.row.startsWith("header:")) {
        return;
    }
    coverage.cells.add(avCellUnitId(cell.row, cell.col, cell.group));
}

function parseShownCell(
    unitId: string,
): {group: string; row: string; col: string; unstable: boolean; label: boolean;} | null {
    let group = "nogroup";
    let row: string;
    let col: string;
    if (unitId.startsWith("cell:")) {
        const parts = unitId.split(":");
        if (parts.length < 4) {
            return {group, row: "norow", col: "idx-", unstable: true, label: false};
        }
        group = parts[1];
        // Header row IDs contain their group: `cell:g:header:g:column`.
        const header = parts[2] === "header" && parts.length >= 5;
        row = header ? "header:" + parts[3] : parts[2];
        col = parts.slice(header ? 4 : 3).join(":");
    } else if (unitId.startsWith("calendar:")) {
        const parts = unitId.split(":");
        if (parts.length < 3) {
            return {group, row: "norow", col: "idx-", unstable: true, label: false};
        }
        row = parts[1];
        col = parts.slice(2).join(":");
    } else {
        return null;
    }
    if (!group || group.indexOf("idx-") === 0 || row === "norow" || col.indexOf("idx-") === 0) {
        return {group, row, col, unstable: true, label: false};
    }
    if (col === "title" || col === "undated") {
        return {group, row, col, unstable: false, label: true};
    }
    return {group, row, col, unstable: false, label: false};
}

function foldAvText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
