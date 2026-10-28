/** Image identity includes its position and original URL, so rebinding cannot pick another image. */
export function imageOCRPath(unitId?: string): string | undefined {
    const match = unitId?.match(/(?:^|:)image-ocr:\d+:([^:]*)$/);
    if (!match) return undefined;
    try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

export function isImageOCRUnit(unit: {matchSource?: string; highlightKind?: string; unitId?: string;}): boolean {
    return unit.matchSource === "image-ocr" || unit.highlightKind === "image-ocr" || imageOCRPath(unit.unitId) !== undefined;
}

export function isFrameHighlight(unit: {highlightKind?: string;} | undefined): boolean {
    return unit?.highlightKind === "image-ocr" || unit?.highlightKind === "code-language";
}
