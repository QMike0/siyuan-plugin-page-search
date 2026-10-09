import {
    effectiveSearchQuery,
    expandRegexReplacement,
    plainTextFromInlineMemoContent,
    sanitizeInlineMemoContentForWrite,
} from "../shared";
import type {
    RegexReplacementExpansion,
    RegexReplacementUnitRequest,
} from "../shared";
import {isInlineMemoSearchUnit} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import type {SearchMatch} from "./dom-types";
import {preserveReplacementCase} from "./preserve-case";
import {
    isRangePlainTextOnly,
    locateRangeInSingleTextNode,
    locateTextPoint,
} from "./ranges";

export interface ReplacementSpec {
    matchId?: string;
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
    /** 与查找相同的正则源（普通查询会 trim，纯空白查询保留原值） */
    searchQuery?: string;
    caseSensitive?: boolean;
    regexUnicode?: boolean;
    regexMultiline?: boolean;
    regexDotAll?: boolean;
    /** Worker 已准备的正则展开结果；有值时绝不在主线程重新执行 RegExp。 */
    regexPlan?: RegexReplacementPlan;
}

export interface ApplyReplacementOutcome {
    appliedCount: number;
    /** 定位失败 / 文本漂移 / 正则展开失败等跳过的条数 */
    skippedCount: number;
    /** 其中因正则模板展开失败而跳过的条数 */
    regexExpandFailedCount: number;
}

export interface RegexReplacementPlan {
    expansions: ReadonlyMap<string, RegexReplacementExpansion>;
}

/**
 * 把当前可写单元整理为 Worker 可克隆的纯文本请求。未找到单元的命中仍由原写回流程计为跳过。
 * 备注按宿主在块内的偏移对上，避免只重采当前块时全文序号错位。
 */
export interface ReplacementUnitMatch {
    blockId: string;
    unitId?: string;
    anchorOffset?: number;
    highlightKind?: SearchMatch["highlightKind"];
}

export function createReplacementUnitLookup(unitsByKey: Map<string, SearchableBlock>) {
    let memoByAnchor: Map<string, SearchableBlock> | null = null;
    const anchors = () => {
        if (memoByAnchor) {
            return memoByAnchor;
        }
        const index = new Map<string, SearchableBlock>();
        memoByAnchor = index;
        for (const unit of unitsByKey.values()) {
            if (!isInlineMemoSearchUnit(unit) || unit.anchorOffset === undefined) {
                continue;
            }
            const key = `${unit.blockId}\0${unit.anchorOffset}`;
            if (!index.has(key)) {
                index.set(key, unit);
            }
        }
        return index;
    };
    return (match: ReplacementUnitMatch): SearchableBlock | undefined => {
        const direct = unitsByKey.get(unitKeyFor(match.blockId, match.unitId));
        const memoMatch = match.highlightKind === "inline-memo" ||
            Boolean(match.unitId?.startsWith("inline-memo:")) ||
            Boolean(match.unitId?.startsWith("table-memo:"));
        if (!memoMatch || match.anchorOffset === undefined) {
            return direct;
        }
        if (
            direct &&
            direct.blockId === match.blockId &&
            isInlineMemoSearchUnit(direct) &&
            direct.anchorOffset === match.anchorOffset
        ) {
            return direct;
        }
        return anchors().get(`${match.blockId}\0${match.anchorOffset}`);
    };
}

export function collectRegexReplacementRequests(
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "id" | "blockId" | "unitId" | "start" | "end" | "matchedText"> & ReplacementUnitMatch>,
): RegexReplacementUnitRequest[] {
    const lookup = createReplacementUnitLookup(unitsByKey);
    const grouped = new Map<string, {
        unit: SearchableBlock;
        replacements: RegexReplacementUnitRequest["replacements"];
    }>();
    for (const match of matches) {
        const unit = lookup(match);
        if (!unit) {
            continue;
        }
        const key = unitKeyFor(unit.blockId, unit.unitId);
        const group = grouped.get(key) ?? {unit, replacements: []};
        group.replacements.push({
            id: match.id,
            start: match.start,
            end: match.end,
            matchedText: match.matchedText,
        });
        grouped.set(key, group);
    }
    return Array.from(grouped, ([id, group]) => ({
        id,
        haystack: replacementHaystack(group.unit),
        replacements: group.replacements,
    }));
}

export function createRegexReplacementPlan(
    expansions: RegexReplacementExpansion[],
): RegexReplacementPlan {
    return {expansions: new Map(expansions.map((item) => [item.id, item]))};
}

function unitKeyFor(blockId: string, unitId?: string): string {
    return `${blockId}::${unitId ?? ""}`;
}

function groupReplacementSpecs(
    unitsByKey: Map<string, SearchableBlock>,
    matches: Array<Pick<SearchMatch, "id" | "start" | "end" | "matchedText"> & ReplacementUnitMatch>,
): {byUnit: Map<SearchableBlock, ReplacementSpec[]>; skippedCount: number;} {
    const lookup = createReplacementUnitLookup(unitsByKey);
    const byUnit = new Map<SearchableBlock, ReplacementSpec[]>();
    let skippedCount = 0;
    for (const match of matches) {
        const unit = lookup(match);
        if (!unit) {
            skippedCount += 1;
            continue;
        }
        const list = byUnit.get(unit) ?? [];
        list.push({
            matchId: match.id,
            start: match.start,
            end: match.end,
            matchedText: match.matchedText,
            unitId: unit.unitId,
        });
        byUnit.set(unit, list);
    }
    return {byUnit, skippedCount};
}

function replacementHaystack(unit: SearchableBlock): string {
    if (isInlineMemoSearchUnit(unit)) {
        return plainTextFromInlineMemoContent(
            unit.element.getAttribute("data-inline-memo-content") ?? "",
        );
    }
    return unit.textNodes.map((node) => node.nodeValue ?? "").join("");
}

function resolveReplacementText(
    haystack: string,
    spec: ReplacementSpec,
    replacementText: string,
    options: ApplyReplacementOptions,
): string | null {
    if (options.regex) {
        if (options.regexPlan) {
            const planned = spec.matchId ? options.regexPlan.expansions.get(spec.matchId) : undefined;
            return planned?.haystack === haystack ? planned.replacement : null;
        }
        const patternSource = effectiveSearchQuery(options.searchQuery ?? "");
        if (!patternSource) {
            return null;
        }
        return expandRegexReplacement({
            haystack,
            start: spec.start,
            end: spec.end,
            patternSource,
            caseSensitive: options.caseSensitive === true,
            regexUnicode: options.regexUnicode === true,
            regexMultiline: options.regexMultiline === true,
            regexDotAll: options.regexDotAll === true,
            template: replacementText,
        });
    }
    if (options.preserveCase) {
        return preserveReplacementCase(replacementText, spec.matchedText);
    }
    return replacementText;
}

/**
 * 在纯字符串上从后往前应用替换（不改 DOM）。
 * 用于文档标题：先算出完整新标题，再走 renameDoc。
 */
export function applyReplacementsToString(
    haystack: string,
    replacements: ReplacementSpec[],
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome & {text: string;} {
    if (!replacements.length) {
        return {
            text: haystack,
            appliedCount: 0,
            skippedCount: 0,
            regexExpandFailedCount: 0,
        };
    }

    const sorted = [...replacements].sort((left, right) => right.start - left.start);
    let text = haystack;
    let appliedCount = 0;
    let skippedCount = 0;
    let regexExpandFailedCount = 0;

    for (const replacement of sorted) {
        if (
            replacement.start < 0 ||
            replacement.end > haystack.length ||
            replacement.start > replacement.end ||
            haystack.slice(replacement.start, replacement.end) !== replacement.matchedText
        ) {
            skippedCount += 1;
            continue;
        }

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

        // 从后往前改：高 offset 不受此前替换长度变化影响
        text = text.slice(0, replacement.start) + nextText + text.slice(replacement.end);
        appliedCount += 1;
    }

    return {text, appliedCount, skippedCount, regexExpandFailedCount};
}

/**
 * 行内备注：在 data-inline-memo-content 的纯文本视图上替换，再写回属性。
 *
 * 刻意不改宿主 span 可见字（与内核 findReplace 同时改 TextMarkTextContent 不同）：
 * 本插件备注命中与正文命中分属不同 unit，宿主字可单独搜替，避免一次替换双改、导航到虚线命中却改了正文。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/kernel/model/search.go inline-memo
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/toolbar/index.ts showRender
 */
export function applyReplacementsToInlineMemoElement(
    host: HTMLElement,
    replacements: ReplacementSpec[],
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    if (!replacements.length) {
        return {appliedCount: 0, skippedCount: 0, regexExpandFailedCount: 0};
    }
    if (!host.matches('span[data-type~="inline-memo"]')) {
        return {
            appliedCount: 0,
            skippedCount: replacements.length,
            regexExpandFailedCount: 0,
        };
    }

    const raw = host.getAttribute("data-inline-memo-content") ?? "";
    const haystack = plainTextFromInlineMemoContent(raw);
    const outcome = applyReplacementsToString(
        haystack,
        replacements,
        replacementText,
        options,
    );
    if (outcome.appliedCount === 0) {
        return {
            appliedCount: 0,
            skippedCount: outcome.skippedCount,
            regexExpandFailedCount: outcome.regexExpandFailedCount,
        };
    }

    writeInlineMemoContent(host, outcome.text);
    return {
        appliedCount: outcome.appliedCount,
        skippedCount: outcome.skippedCount,
        regexExpandFailedCount: outcome.regexExpandFailedCount,
    };
}

/**
 * 在已定位的 textNodes 上从后往前替换（同一单元内）。
 * 优先单 Text 节点；若命中跨多个纯 Text 拆分节点（编辑中未合并），用 Range 删除后插入。
 */
/**
 * 与思源备注浮层关闭时一致：空内容卸掉标记，其余只写回属性。
 * 宿主里的可见字不动。
 */
function writeInlineMemoContent(host: HTMLElement, text: string): void {
    const written = text ? sanitizeInlineMemoContentForWrite(text) : "";
    if (written) {
        host.setAttribute("data-inline-memo-content", written);
        return;
    }
    const types = (host.getAttribute("data-type") ?? "")
        .split(/\s+/)
        .filter((token) => token && token !== "inline-memo");
    if (types.length === 0) {
        const parent = host.parentNode;
        if (!parent) {
            return;
        }
        while (host.firstChild) {
            parent.insertBefore(host.firstChild, host);
        }
        host.remove();
        return;
    }
    host.setAttribute("data-type", types.join(" "));
    host.removeAttribute("data-inline-memo-content");
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

    // 图片标题：可见字改完后同步 img[title]，对齐官方 imgMenu（menus/protyle.ts）
    if (appliedCount > 0) {
        syncImageTitleAttributeFromTextNodes(textNodes);
    }

    return {appliedCount, skippedCount, regexExpandFailedCount};
}

/**
 * 若本次替换落在图片标题区，把 `.protyle-action__title > span` 的全文写回 `img[title]`。
 * 仅改已在 mutation 中的节点所属子树，不另开编辑器 API。
 */
function syncImageTitleAttributeFromTextNodes(textNodes: Text[]): void {
    const seen = new Set<HTMLElement>();
    for (const node of textNodes) {
        const titleInner = node.parentElement
            ?.closest(".img .protyle-action__title")
            ?.querySelector<HTMLElement>(":scope > span");
        if (!titleInner || seen.has(titleInner)) {
            continue;
        }
        seen.add(titleInner);
        const img = titleInner.closest(".img")?.querySelector("img");
        if (!(img instanceof HTMLImageElement)) {
            continue;
        }
        img.setAttribute("title", titleInner.innerText);
    }
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
    matches: Array<Pick<SearchMatch, "id" | "start" | "end" | "matchedText" | "unitId" | "blockId"> & ReplacementUnitMatch>,
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    const grouped = groupReplacementSpecs(unitsByKey, matches);
    let appliedCount = 0;
    let skippedCount = grouped.skippedCount;
    let regexExpandFailedCount = 0;
    for (const [unit, specs] of grouped.byUnit) {
        if (liveSubmit !== unit.element && !liveSubmit.contains(unit.element)) {
            skippedCount += specs.length;
            continue;
        }

        const unitPath = liveSubmit === unit.element ?
            [] :
            getNodePath(liveSubmit, unit.element);
        if (unitPath === null) {
            skippedCount += specs.length;
            continue;
        }

        const cloneUnitNode = unitPath.length === 0 ?
            cloneSubmit :
            followNodePath(cloneSubmit, unitPath);
        if (!(cloneUnitNode instanceof HTMLElement)) {
            skippedCount += specs.length;
            continue;
        }

        if (isInlineMemoSearchUnit(unit)) {
            const outcome = applyReplacementsToInlineMemoElement(
                cloneUnitNode,
                specs,
                replacementText,
                options,
            );
            appliedCount += outcome.appliedCount;
            skippedCount += outcome.skippedCount;
            regexExpandFailedCount += outcome.regexExpandFailedCount;
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
    matches: Array<Pick<SearchMatch, "id" | "start" | "end" | "matchedText" | "unitId" | "blockId"> & ReplacementUnitMatch>,
    replacementText: string,
    options: ApplyReplacementOptions = {},
): ApplyReplacementOutcome {
    const grouped = groupReplacementSpecs(unitsByKey, matches);
    let appliedCount = 0;
    let skippedCount = grouped.skippedCount;
    let regexExpandFailedCount = 0;
    for (const [unit, specs] of grouped.byUnit) {
        if (isInlineMemoSearchUnit(unit)) {
            const outcome = applyReplacementsToInlineMemoElement(
                unit.element,
                specs,
                replacementText,
                options,
            );
            appliedCount += outcome.appliedCount;
            skippedCount += outcome.skippedCount;
            regexExpandFailedCount += outcome.regexExpandFailedCount;
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
