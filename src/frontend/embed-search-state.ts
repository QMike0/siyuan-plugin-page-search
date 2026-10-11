import {supportsDiagramSourceSearch} from "../shared/code-block-language";
import {
    collectSearchableBlocks,
    resolveDocRoot,
    type CollectSearchableBlocksOptions,
} from "./blocks";
import {freezeBlock} from "./corpus/units";
import type {SearchableBlock} from "./dom-types";
import {
    embeddedOwner,
    embeddedPositionAt,
} from "./embedded-order";
import {
    unitKey,
    type SelectionScope,
} from "./selection";

type UnitSnapshot = {unitId?: string; text: string; restrictions?: string;};

function sourceDiagram(block: SearchableBlock): boolean {
    return block.element.dataset.type === "NodeCodeBlock" &&
        supportsDiagramSourceSearch(block.element.dataset.subtype ?? "");
}

/** Compare searchable embed text, independently of old hits or transient renderer markup. */
export class EmbedSearchState {
    private units = new Map<string, UnitSnapshot[]>();
    private selectionUnits: Set<string> | null = null;
    private restricted = false;

    clear() {
        this.units.clear();
        this.selectionUnits = null;
        this.restricted = false;
    }

    capture(blocks: readonly SearchableBlock[], selectionScope?: SelectionScope, restricted = false) {
        this.selectionUnits = selectionScope ? new Set(selectionScope.keys()) : null;
        this.restricted = restricted;
        this.units = this.group(blocks, restricted);
    }

    changed(
        edit: Element,
        elements: ReadonlySet<HTMLElement> | null | undefined,
        options: CollectSearchableBlocksOptions,
    ): boolean {
        if (options.includeEmbedBlock === false || elements === undefined || elements?.size === 0) return false;
        const root = resolveDocRoot(edit);
        if (!root) return false;
        // The observer already bounds affected hosts. Overflow gets one debounced search.
        if (elements === null) return this.units.size > 0 || !this.selectionUnits;
        const roots = Array.from(elements).filter(element => root.contains(element));
        const next = this.group(
            roots.length ?
                collectSearchableBlocks(edit, {
                    ...options,
                    scopeRoots: roots,
                    includeDocTitle: false,
                }) :
                [],
            this.restricted,
        );
        let changed = false;
        const ids = new Set([...next.keys(), ...Array.from(elements, element => element.dataset.nodeId ?? "")]);
        for (const id of ids) {
            const before = this.units.get(id) ?? [];
            const after = next.get(id) ?? [];
            if (
                before.length !== after.length ||
                before.some((unit, index) =>
                    unit.unitId !== after[index].unitId || unit.text !== after[index].text ||
                    unit.restrictions !== after[index].restrictions
                )
            ) changed = true;
            if (after.length) this.units.set(id, after);
            else this.units.delete(id);
        }
        return changed;
    }

    private group(blocks: readonly SearchableBlock[], restricted: boolean): Map<string, UnitSnapshot[]> {
        const grouped = new Map<string, SearchableBlock[]>();
        const diagramPositions = new WeakSet<HTMLElement>();
        for (const block of blocks) {
            if (block.blockType !== "NodeBlockQueryEmbed" || !embeddedOwner(block.element)) continue;
            if (this.selectionUnits && !this.selectionUnits.has(unitKey(block.blockId, block.unitId))) continue;
            // DiagramSearchState owns label/source changes. Keep one position
            // marker here so moving an unchanged graph around text still refreshes order.
            if (sourceDiagram(block)) {
                if (diagramPositions.has(block.element)) continue;
                diagramPositions.add(block.element);
            }
            const list = grouped.get(block.blockId) ?? [];
            list.push(block);
            grouped.set(block.blockId, list);
        }
        return new Map(Array.from(grouped, ([id, list]) => {
            // Compare structural sequence rather than absolute ranks: SVG decorations
            // and unrelated labels cannot cause searches merely by shifting ranks.
            list.sort((a, b) =>
                (embeddedPositionAt(a.embeddedOrder, 0)?.[0] ?? 0) - (embeddedPositionAt(b.embeddedOrder, 0)?.[0] ?? 0)
            );
            return [
                id,
                list.map(block =>
                    sourceDiagram(block) ?
                        {
                            unitId: `diagram-position:${block.embeddedSourceId ?? block.unitId}`,
                            text: "",
                        } :
                        {
                            unitId: block.unitId,
                            text: block.text,
                            restrictions: restricted ? JSON.stringify(freezeBlock(block).restrictSpans) : undefined,
                        }
                ),
            ];
        }));
    }
}
