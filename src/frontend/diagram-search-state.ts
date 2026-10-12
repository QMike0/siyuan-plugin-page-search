import {supportsDiagramSourceSearch} from "../shared/code-block-language";
import {
    collectSearchableBlocks,
    createRendererElementFilter,
    resolveDocRoot,
    type CollectSearchableBlocksOptions,
} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import {
    createEmbeddedSourceReader,
    embeddedOwner,
} from "./embedded-order";
import {
    unitKey,
    type SelectionScope,
} from "./selection";
import {beginTextCollection} from "./visibility";

export const SOURCE_DIAGRAM_SELECTOR =
    '[data-type="NodeCodeBlock"][data-subtype="mermaid"], [data-type="NodeCodeBlock"][data-subtype="flowchart"]';

type UnitText = {unitId: string | undefined; text: string;};

/** 只保留实际采集的图表文本，不持有 SVG/Range，也不依赖旧命中是否存在。 */
export class DiagramSearchState {
    private units = new Map<string, UnitText[]>();
    private elementKeys = new WeakMap<HTMLElement, string>();
    private selectionUnits: Set<string> | null = null;

    clear() {
        this.units.clear();
        this.elementKeys = new WeakMap();
        this.selectionUnits = null;
    }

    knows(element: HTMLElement): boolean {
        return this.elementKeys.has(element);
    }

    capture(blocks: readonly SearchableBlock[], selectionScope?: SelectionScope) {
        this.selectionUnits = selectionScope ?
            new Set(
                blocks.filter((block) =>
                    block.element.dataset.type === "NodeCodeBlock" &&
                    supportsDiagramSourceSearch(block.element.dataset.subtype ?? "") && block.textNodes.length &&
                    selectionScope.has(unitKey(block.blockId, block.unitId))
                ).map((block) => unitKey(block.blockId, block.unitId)),
            ) :
            null;
        this.units = this.group(blocks);
    }

    changed(
        edit: Element,
        elements: ReadonlySet<HTMLElement> | null,
        options: CollectSearchableBlocksOptions,
    ): boolean {
        if (elements?.size === 0) return false;
        const docRoot = resolveDocRoot(edit);
        if (!docRoot) return false;
        if (elements === null) {
            // 超限时只安排一次合并搜索，避免在观察回调里再全文采集一遍 SVG 文本。
            if (this.units.size) return true;
            if (this.selectionUnits) return false;
            beginTextCollection(options.includeFoldedBlocks !== false);
            const enabled = createRendererElementFilter(options);
            return Array.from(docRoot.querySelectorAll<HTMLElement>(SOURCE_DIAGRAM_SELECTOR)).some(enabled);
        }
        const roots = Array.from(elements).filter((element) => docRoot.contains(element));
        const next = roots.length ?
            this.group(collectSearchableBlocks(edit, {
                ...options,
                scopeRoots: roots,
                includeDocTitle: false,
                skipEmbeddedOrder: true,
            })) :
            new Map<string, UnitText[]>();
        const keys = new Set(next.keys());
        const sourceOf = createEmbeddedSourceReader();
        elements.forEach((element) => {
            const key = this.elementKeys.get(element) ?? diagramKey(element, sourceOf);
            if (key) keys.add(key);
        });
        let changed = false;
        for (const key of keys) {
            const before = this.units.get(key) ?? [];
            const after = next.get(key) ?? [];
            if (
                before.length !== after.length ||
                before.some((unit, index) => unit.unitId !== after[index].unitId || unit.text !== after[index].text)
            ) changed = true;
            if (after.length) this.units.set(key, after);
            else this.units.delete(key);
        }
        return changed;
    }

    private group(blocks: readonly SearchableBlock[]): Map<string, UnitText[]> {
        const grouped = new Map<string, UnitText[]>();
        const diagramElements = new WeakMap<HTMLElement, boolean>();
        const sourceOf = createEmbeddedSourceReader();
        for (const block of blocks) {
            let diagram = diagramElements.get(block.element);
            if (diagram === undefined) {
                diagram = block.element.dataset.type === "NodeCodeBlock" &&
                    supportsDiagramSourceSearch(block.element.dataset.subtype ?? "");
                diagramElements.set(block.element, diagram);
            }
            if (!diagram) continue;
            if (
                this.selectionUnits &&
                (!block.textNodes.length || !this.selectionUnits.has(unitKey(block.blockId, block.unitId)))
            ) continue;
            const key = diagramKey(block.element, sourceOf);
            if (!key) continue;
            this.elementKeys.set(block.element, key);
            const units = grouped.get(key) ?? [];
            units.push({unitId: block.unitId, text: block.text});
            grouped.set(key, units);
        }
        return grouped;
    }
}

function diagramKey(element: HTMLElement, sourceOf: ReturnType<typeof createEmbeddedSourceReader>): string | undefined {
    const id = element.dataset.nodeId;
    if (!id) return undefined;
    const ownerId = embeddedOwner(element)?.dataset.nodeId;
    return ownerId ? `${ownerId}\u0000${sourceOf(element) ?? id}` : id;
}
