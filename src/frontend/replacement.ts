import type {SearchableBlock} from "./dom-types";
import type {SearchMatch} from "./dom-types";
import {preserveReplacementCase} from "./preserve-case";
import {locateRangeInSingleTextNode} from "./ranges";

export interface ReplacementSpec {
    start: number;
    end: number;
    matchedText: string;
    unitId?: string;
}

export interface ApplyReplacementOptions {
    preserveCase?: boolean;
}

export interface ApplyReplacementOutcome {
    appliedCount: number;
}

/**
 * 在已定位的 textNodes 上从后往前替换（同一单元内）。
 */
function applyReplacementsToTextNodes(
    textNodes: Text[],
    replacements: ReplacementSpec[],
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    if (!textNodes.length || !replacements.length) {
        return {appliedCount: 0};
    }

    const blockLike: SearchableBlock = {
        blockId: "",
        blockType: "",
        blockIndex: 0,
        element: (textNodes[0].parentElement ?? document.body) as HTMLElement,
        text: textNodes.map((node) => node.nodeValue ?? "").join(""),
        textNodes,
    };

    const sorted = [...replacements].sort((left, right) => right.start - left.start);
    let appliedCount = 0;

    for (const replacement of sorted) {
        const location = locateRangeInSingleTextNode(blockLike, replacement.start, replacement.end);
        if (!location) {
            continue;
        }

        const text = location.node.nodeValue ?? "";
        const currentText = text.slice(location.startOffset, location.endOffset);
        if (currentText !== replacement.matchedText) {
            continue;
        }

        const nextText = options.preserveCase
            ? preserveReplacementCase(replacementText, replacement.matchedText)
            : replacementText;

        location.node.nodeValue = [
            text.slice(0, location.startOffset),
            nextText,
            text.slice(location.endOffset),
        ].join("");
        appliedCount += 1;
    }

    return {appliedCount};
}

/**
 * 将 live 子树中的 Text 节点映射到 clone 子树上的对应 Text。
 */
function mapTextNodesToClone(
    liveRoot: Node,
    cloneRoot: Node,
    liveTextNodes: Text[],
): Text[] {
    const mapped: Text[] = [];
    for (const liveNode of liveTextNodes) {
        const path = getNodePath(liveRoot, liveNode);
        if (!path) {
            continue;
        }
        const cloneNode = followNodePath(cloneRoot, path);
        if (cloneNode?.nodeType === Node.TEXT_NODE) {
            mapped.push(cloneNode as Text);
        }
    }
    return mapped;
}

function getNodePath(root: Node, target: Node): number[] | null {
    const path: number[] = [];
    let current: Node | null = target;
    while (current && current !== root) {
        const parent = current.parentNode;
        if (!parent) {
            return null;
        }
        const index = Array.prototype.indexOf.call(parent.childNodes, current);
        if (index < 0) {
            return null;
        }
        path.unshift(index);
        current = parent;
    }
    return current === root ? path : null;
}

function followNodePath(root: Node, path: number[]): Node | null {
    let current: Node = root;
    for (const index of path) {
        const next = current.childNodes[index];
        if (!next) {
            return null;
        }
        current = next;
    }
    return current;
}

/**
 * 在提交块的 clone 上应用同一 blockId 下多个命中（可含不同 unitId）。
 * liveSubmit + units 用于把偏移映射到 clone。
 */
export function applyMatchesToSubmitClone(
    liveSubmit: HTMLElement,
    cloneSubmit: HTMLElement,
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "start" | "end" | "matchedText" | "unitId" | "blockId">>,
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    const byUnit = new Map<string, ReplacementSpec[]>();
    for (const match of matches) {
        const key = `${match.blockId}::${match.unitId ?? ""}`;
        const list = byUnit.get(key) ?? [];
        list.push({
            start: match.start,
            end: match.end,
            matchedText: match.matchedText,
            unitId: match.unitId,
        });
        byUnit.set(key, list);
    }

    let appliedCount = 0;
    for (const [key, specs] of byUnit) {
        const unit = unitsByKey.get(key);
        if (!unit) {
            continue;
        }
        if (liveSubmit !== unit.element && !liveSubmit.contains(unit.element)) {
            continue;
        }

        const unitPath = liveSubmit === unit.element
            ? []
            : getNodePath(liveSubmit, unit.element);
        if (unitPath === null) {
            continue;
        }

        const cloneUnitNode = unitPath.length === 0
            ? cloneSubmit
            : followNodePath(cloneSubmit, unitPath);
        if (!(cloneUnitNode instanceof HTMLElement)) {
            continue;
        }

        const cloneTextNodes = mapTextNodesToClone(unit.element, cloneUnitNode, unit.textNodes);
        if (!cloneTextNodes.length) {
            continue;
        }

        appliedCount += applyReplacementsToTextNodes(
            cloneTextNodes,
            specs,
            replacementText,
            options,
        ).appliedCount;
    }

    return {appliedCount};
}

/**
 * 直接在 live SearchableBlock 上替换（配合 updateTransactionElement）。
 */
export function applyMatchesToLiveUnits(
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "start" | "end" | "matchedText" | "unitId" | "blockId">>,
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    const byUnit = new Map<string, ReplacementSpec[]>();
    for (const match of matches) {
        const key = `${match.blockId}::${match.unitId ?? ""}`;
        const list = byUnit.get(key) ?? [];
        list.push({
            start: match.start,
            end: match.end,
            matchedText: match.matchedText,
            unitId: match.unitId,
        });
        byUnit.set(key, list);
    }

    let appliedCount = 0;
    for (const [key, specs] of byUnit) {
        const unit = unitsByKey.get(key);
        if (!unit) {
            continue;
        }
        appliedCount += applyReplacementsToTextNodes(
            unit.textNodes,
            specs,
            replacementText,
            options,
        ).appliedCount;
    }
    return {appliedCount};
}
