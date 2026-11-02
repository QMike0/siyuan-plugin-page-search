/** Source units have their own identity; they must never become rendered-text fallbacks. */
export function isMathSourceUnit(unit: {unitId?: string;}): boolean {
    const id = unit.unitId?.replace(/^embed:[^:]+:/, "") ?? "";
    return id.startsWith("renderer:source:math:") || id.startsWith("inline-math:source:") ||
        /:(?:inline|block)-math:source:\d+$/.test(id);
}

/** These table formulas keep cell-local identities when earlier rows are unloaded. */
export function isTableMathSourceUnit(unit: {blockType?: string; unitId?: string;}): boolean {
    return unit.blockType === "NodeTable" && Boolean(
        unit.unitId?.startsWith("inline-math:source:table-cell:") ||
        unit.unitId?.startsWith("renderer:source:math:") && unit.unitId.includes(":table-cell:"),
    );
}
