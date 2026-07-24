import type {SearchableBlock} from "./dom-types";
import type {SearchMatch} from "./dom-types";
import {expandRegexReplacement} from "../shared";
import {preserveReplacementCase} from "./preserve-case";
import {
    isRangePlainTextOnly,
    locateRangeInSingleTextNode,
    locateTextPoint,
} from "./ranges";

export interface ReplacementSpec {
    start: number;
    end: number;
    matchedText: string;
    unitId?: string;
}

export interface ApplyReplacementOptions {
    preserveCase?: boolean;
    /**
     * 正则查找模式：替换串按 $1/$2/$& 等展开。
     * 开启时忽略 preserveCase，避免改写捕获组结果。
     */
    regex?: boolean;
    /** 与查找相同的正则源（会 trim，与 match 引擎一致） */
    searchQuery?: string;
    caseSensitive?: boolean;
}

export interface ApplyReplacementOutcome {
    appliedCount: number;
    /** 定位失败 / 文本漂移 / 正则展开失败等跳过的条数 */
    skippedCount: number;
    /** 其中因正则模板展开失败而跳过的条数 */
    regexExpandFailedCount: number;
}

function resolveReplacementText(
    haystack: string,
    spec: ReplacementSpec,
    replacementText: string,
    options: ApplyReplacementOptions,
): string | null {
    if (options.regex) {
        const patternSource = (options.searchQuery ?? "").trim();
        if (!patternSource) {
            return null;
        }
        return expandRegexReplacement({
            haystack,
            start: spec.start,
            end: spec.end,
            patternSource,
            caseSensitive: options.caseSensitive === true,
            template: replacementText,
        });
    }
    if (options.preserveCase) {
        return preserveReplacementCase(replacementText, spec.matchedText);
    }
    return replacementText;
}

/**
 * 在已定位的 textNodes 上从后往前替换（同一单元内）。
 * 优先单 Text 节点；若命中跨多个纯 Text 拆分节点（编辑中未合并），用 Range 删除后插入。
 */
function applyReplacementsToTextNodes(
    textNodes: Text[],
    replacements: ReplacementSpec[],
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    if (!textNodes.length || !replacements.length) {
        return {
            appliedCount: 0,
            skippedCount: replacements.length,
            regexExpandFailedCount: 0,
        };
    }

    const haystack = textNodes.map((node) => node.nodeValue ?? "").join("");
    const blockLike: SearchableBlock = {
        blockId: "",
        blockType: "",
        blockIndex: 0,
        element: (textNodes[0].parentElement ?? document.body) as HTMLElement,
        text: haystack,
        textNodes,
    };

    const sorted = [...replacements].sort((left, right) => right.start - left.start);
    let appliedCount = 0;
    let skippedCount = 0;
    let regexExpandFailedCount = 0;

    for (const replacement of sorted) {
        const nextText = resolveReplacementText(
            haystack,
            replacement,
            replacementText,
            options,
        );
        if (nextText === null) {
            skippedCount += 1;
            if (options.regex) {
                regexExpandFailedCount += 1;
            }
            continue;
        }

        if (applyReplacementToTextNodes(blockLike, textNodes, replacement, nextText)) {
            appliedCount += 1;
        } else {
            skippedCount += 1;
        }
    }

    return {appliedCount, skippedCount, regexExpandFailedCount};
}

/**
 * 将 nextText 写入 [start,end)。单节点直接改 nodeValue；多节点纯文本用 Range。
 */
function applyReplacementToTextNodes(
    blockLike: SearchableBlock,
    textNodes: Text[],
    replacement: ReplacementSpec,
    nextText: string,
): boolean {
    const single = locateRangeInSingleTextNode(
        blockLike,
        replacement.start,
        replacement.end,
    );
    if (single) {
        const text = single.node.nodeValue ?? "";
        const currentText = text.slice(single.startOffset, single.endOffset);
        if (currentText !== replacement.matchedText) {
            return false;
        }
        single.node.nodeValue = [
            text.slice(0, single.startOffset),
            nextText,
            text.slice(single.endOffset),
        ].join("");
        return true;
    }

    const startPoint = locateTextPoint(textNodes, replacement.start, "start");
    const endPoint = locateTextPoint(textNodes, replacement.end, "end");
    if (!startPoint || !endPoint) {
        return false;
    }

    try {
        const range = document.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
        if (range.toString() !== replacement.matchedText) {
            return false;
        }
        if (!isRangePlainTextOnly(range)) {
            return false;
        }
        range.deleteContents();
        range.insertNode(document.createTextNode(nextText));
        return true;
    } catch {
        return false;
    }
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
    let skippedCount = 0;
    let regexExpandFailedCount = 0;
    for (const [key, specs] of byUnit) {
        const unit = unitsByKey.get(key);
        if (!unit) {
            skippedCount += specs.length;
            continue;
        }
        if (liveSubmit !== unit.element && !liveSubmit.contains(unit.element)) {
            skippedCount += specs.length;
            continue;
        }

        const unitPath = liveSubmit === unit.element
            ? []
            : getNodePath(liveSubmit, unit.element);
        if (unitPath === null) {
            skippedCount += specs.length;
            continue;
        }

        const cloneUnitNode = unitPath.length === 0
            ? cloneSubmit
            : followNodePath(cloneSubmit, unitPath);
        if (!(cloneUnitNode instanceof HTMLElement)) {
            skippedCount += specs.length;
            continue;
        }

        const cloneTextNodes = mapTextNodesToClone(unit.element, cloneUnitNode, unit.textNodes);
        if (!cloneTextNodes.length) {
            skippedCount += specs.length;
            continue;
        }

        const outcome = applyReplacementsToTextNodes(
            cloneTextNodes,
            specs,
            replacementText,
            options,
        );
        appliedCount += outcome.appliedCount;
        skippedCount += outcome.skippedCount;
        regexExpandFailedCount += outcome.regexExpandFailedCount;
    }

    return {appliedCount, skippedCount, regexExpandFailedCount};
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
    let skippedCount = 0;
    let regexExpandFailedCount = 0;
    for (const [key, specs] of byUnit) {
        const unit = unitsByKey.get(key);
        if (!unit) {
            skippedCount += specs.length;
            continue;
        }
        const outcome = applyReplacementsToTextNodes(
            unit.textNodes,
            specs,
            replacementText,
            options,
        );
        appliedCount += outcome.appliedCount;
        skippedCount += outcome.skippedCount;
        regexExpandFailedCount += outcome.regexExpandFailedCount;
    }
    return {appliedCount, skippedCount, regexExpandFailedCount};
}
