/**
 * 打开着的数据库：画面单元和接口单元按行、列对齐。
 * 画面上已经有文字的格子不再叠接口结果。没有稳定 id 的可见格子则整块不并接口。
 */

export interface AvDomCoverage {
    unstable: boolean;
    cells: Set<string>;
    title: boolean;
    viewIds: Set<string>;
    /** 日历卡片上没有列 id 的标题文字，同一行只用来挡一次接口单元。 */
    rowLabelText: Map<string, string>;
}

export function emptyAvDomCoverage(): AvDomCoverage {
    return {
        unstable: false,
        cells: new Set<string>(),
        title: false,
        viewIds: new Set<string>(),
        rowLabelText: new Map<string, string>(),
    };
}

export function collectAvDomCoverage(
    units: Array<{blockId: string; blockType: string; unitId?: string; text: string}>,
): Map<string, AvDomCoverage> {
    const coverage = new Map<string, AvDomCoverage>();
    for (const unit of units) {
        if (unit.blockType !== "NodeAttributeView" || !unit.unitId) {
            continue;
        }
        let current = coverage.get(unit.blockId);
        if (!current) {
            current = emptyAvDomCoverage();
            coverage.set(unit.blockId, current);
        }
        noteAvDomUnit(current, unit.unitId, unit.text);
    }
    return coverage;
}

export function avApiUnitShown(
    unitId: string,
    text: string,
    coverage: AvDomCoverage,
    usedRowLabels: Set<string>,
): boolean {
    if (coverage.unstable) {
        return true;
    }
    if (unitId === "av-title") {
        return coverage.title;
    }
    if (unitId.startsWith("av-view:")) {
        return coverage.viewIds.has(unitId.slice("av-view:".length));
    }
    if (!unitId.startsWith("av:")) {
        return false;
    }
    const rest = unitId.slice(3);
    const splitAt = rest.indexOf(":");
    if (splitAt <= 0) {
        return false;
    }
    const row = rest.slice(0, splitAt);
    const col = rest.slice(splitAt + 1);
    if (coverage.cells.has(row + ":" + col)) {
        return true;
    }
    const label = coverage.rowLabelText.get(row);
    const folded = foldAvText(text);
    if (label && label === folded && !usedRowLabels.has(row)) {
        usedRowLabels.add(row);
        return true;
    }
    return false;
}

function noteAvDomUnit(coverage: AvDomCoverage, unitId: string, text: string): void {
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
    if (cell.row.startsWith("header:")) {
        return;
    }
    coverage.cells.add(cell.row + ":" + cell.col);
}

function parseShownCell(unitId: string): {row: string; col: string; unstable: boolean; label: boolean} | null {
    let row = "";
    let col = "";
    if (unitId.startsWith("cell:")) {
        const parts = unitId.split(":");
        if (parts.length < 4) {
            return {row: "norow", col: "idx-", unstable: true, label: false};
        }
        row = parts[2];
        col = parts.slice(3).join(":");
    } else if (unitId.startsWith("calendar:")) {
        const parts = unitId.split(":");
        if (parts.length < 3) {
            return {row: "norow", col: "idx-", unstable: true, label: false};
        }
        row = parts[1];
        col = parts.slice(2).join(":");
    } else {
        return null;
    }
    if (row === "norow" || col.indexOf("idx-") === 0) {
        return {row, col, unstable: true, label: false};
    }
    if (col === "title" || col === "undated") {
        return {row, col, unstable: false, label: true};
    }
    return {row, col, unstable: false, label: false};
}

function foldAvText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
