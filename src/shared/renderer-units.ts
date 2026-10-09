export const RENDERER_UNIT_PREFIX = "renderer:";

export type RendererUnitSource = "rendered-text" | "source-fallback" | "block-only";

/**
 * Renderer 单元 ID 同时记录匹配来源和 renderer 类型。
 * 当前只产生 rendered-text；预留其余来源是为了避免以后把源码回退或块级命中
 * 混成可逐字定位的渲染文本。
 */
export function rendererUnitId(
    source: RendererUnitSource,
    renderer: string,
    index = 0,
): string {
    return `${RENDERER_UNIT_PREFIX}${source}:${renderer}:${index}`;
}

export function rendererUnitSource(unitId: string | null | undefined): RendererUnitSource | null {
    if (!unitId?.startsWith(RENDERER_UNIT_PREFIX)) {
        return null;
    }
    const source = unitId.slice(RENDERER_UNIT_PREFIX.length).split(":", 1)[0];
    if (source === "rendered-text" || source === "source-fallback" || source === "block-only") {
        return source;
    }
    return null;
}

export function isRendererUnitId(unitId: string | null | undefined): boolean {
    return rendererUnitSource(unitId) !== null;
}

export function isRendererUnitFor(
    unitId: string | null | undefined,
    renderer: string,
): boolean {
    const source = rendererUnitSource(unitId);
    if (!unitId || !source) {
        return false;
    }
    return unitId.startsWith(`${RENDERER_UNIT_PREFIX}${source}:${renderer}:`);
}
