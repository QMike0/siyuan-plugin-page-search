import {collectSearchableBlocks, inlineMathIdentityText, isInlineMathSearchUnit, isInlineMemoSearchUnit} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import type {SearchMatch} from "../dom-types";
import {createRangeFromBlockOffsets} from "../ranges";
import {matchRangePassesRestrictInline} from "../restrict-inline-dom";
import {unitKey} from "../selection";
import type {SearchPipelineOptions} from "../pipeline";
import type {RestrictInlineType} from "../../shared";

/** 只给已经挂在当前编辑器里的命中补 Range。没有对应单元格 DOM 的数据库命中保持无 Range。 */
export function projectRanges(
    edit: Element,
    matches: SearchMatch[],
    options: SearchPipelineOptions,
    liveBlocks?: SearchableBlock[],
): SearchMatch[] {
    const live = liveBlocks ?? collectSearchableBlocks(edit, {
        includeDocTitle: options.includeDocTitle !== false,
        includeImageTitle: options.includeImageTitle !== false,
        includeAttributeView: false,
        includeTable: options.includeTable !== false,
        includeBlockquote: options.includeBlockquote !== false,
        includeCallout: options.includeCallout !== false,
        includeSuperBlock: options.includeSuperBlock !== false,
        includeTabs: options.includeTabs !== false,
        includeMindmap: options.includeMindmap !== false,
        includeListUnordered: options.includeListUnordered !== false,
        includeListOrdered: options.includeListOrdered !== false,
        includeListTask: options.includeListTask !== false,
        includeParagraph: options.includeParagraph !== false,
        includeHeadingH1: options.includeHeadingH1 !== false,
        includeHeadingH2: options.includeHeadingH2 !== false,
        includeHeadingH3: options.includeHeadingH3 !== false,
        includeHeadingH4: options.includeHeadingH4 !== false,
        includeHeadingH5: options.includeHeadingH5 !== false,
        includeHeadingH6: options.includeHeadingH6 !== false,
        includeMathBlock: options.includeMathBlock !== false,
        includeEmbedBlock: options.includeEmbedBlock !== false,
        includeCodeBlock: options.includeCodeBlock !== false,
        includeMermaid: options.includeMermaid !== false,
        includeHtmlBlock: options.includeHtmlBlock !== false,
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    });
    const byKey = new Map<string, SearchableBlock>();
    for (const block of live) {
        byKey.set(unitKey(block.blockId, block.unitId), block);
    }

    return matches.map((match) => {
        const block = byKey.get(unitKey(match.blockId, match.unitId));
        if (!block) {
            return {...match, range: undefined};
        }
        const range = createRangeFromBlockOffsets(block, match.start, match.end, {
            allowFoldedHidden: options.includeFoldedBlocks === true,
        }) ?? undefined;
        return {...match, range};
    });
}

/**
 * 只给 liveBlocks 里能对上的命中补 Range。
 * 对不上的保持原样，避免局部采集把文档其余高亮清掉。
 */
export function fillLiveRanges(
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    allowFoldedHidden: boolean,
): SearchMatch[] {
    if (!liveBlocks.length || !matches.length) {
        return matches;
    }
    const byKey = new Map<string, SearchableBlock>();
    for (const block of liveBlocks) {
        byKey.set(unitKey(block.blockId, block.unitId), block);
    }
    let changed = false;
    const next = matches.map((match) => {
        const block = byKey.get(unitKey(match.blockId, match.unitId));
        if (!block) {
            return match;
        }
        const range = createRangeFromBlockOffsets(block, match.start, match.end, {
            allowFoldedHidden,
        }) ?? undefined;
        if (!range) {
            return match;
        }
        changed = true;
        return {...match, range};
    });
    return changed ? next : matches;
}

export interface RebindTarget {
    /** 原来有 Range、现在已失效。 */
    broken: boolean;
    /** 块还挂在编辑器里。格子正在换编辑器、暂时没字时保留失效 Range，等下一轮。 */
    blockShown: boolean;
}

const EMBED_BLOCK_SELECTOR = '[data-type="NodeBlockQueryEmbed"]';

/**
 * DOM 重建后按原偏移补 Range。只认偏移处的文字和命中文字一样的格子或块。
 * 文字变了（输入、撤销）不补，保留失效 Range，跳转时仍走重搜。原来亮着的这类命中计入 textChanged。
 * 块已经不在画面上、或文字对上了但不可见的，清掉失效 Range，按未装载命中处理。
 * 行内公式按块内序号和整段可见文字对上，行内备注按宿主位置对上。二者的 unitId 是全文序号，
 * 只采集改过的那一块时会从 0 重计，直接拿 unitId 会补到别的公式上。
 */
export function rebindChangedRanges(
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    targets: ReadonlyMap<SearchMatch, RebindTarget>,
    options: {allowFoldedHidden: boolean; restrictInlineTypes?: RestrictInlineType[]},
): {matches: SearchMatch[]; changed: boolean; textChanged: number} {
    if (!targets.size) {
        return {matches, changed: false, textChanged: 0};
    }
    const byKey = new Map<string, SearchableBlock[]>();
    const mathByKey = new Map<string, SearchableBlock[]>();
    const memoByKey = new Map<string, SearchableBlock[]>();
    for (const block of liveBlocks) {
        pushLiveUnit(byKey, unitKey(block.blockId, block.unitId), block);
        if (isInlineMathSearchUnit(block) && block.mathOrdinal !== undefined) {
            pushLiveUnit(
                mathByKey,
                `${block.blockId}\0${block.mathOrdinal}\0${inlineMathIdentityText(block.text)}`,
                block,
            );
        }
        if (isInlineMemoSearchUnit(block) && block.anchorOffset !== undefined) {
            pushLiveUnit(memoByKey, `${block.blockId}\0${block.anchorOffset}`, block);
        }
    }
    let changed = false;
    let textChanged = 0;
    const next = matches.map((match) => {
        const target = targets.get(match);
        if (!target) {
            return match;
        }
        const candidates = rankedLiveUnits(match, byKey, mathByKey, memoByKey);
        if (!candidates.length) {
            if (target.broken && !target.blockShown) {
                changed = true;
                return {...match, range: undefined};
            }
            return match;
        }
        // 正文副本排在前面。它文字变了就停，不用嵌入里的旧文字顶上。
        // 正文折着、建不出 Range 时，再试嵌入里的可见副本。
        let hiddenCopy = false;
        for (let index = 0; index < candidates.length; index += 1) {
            const block = candidates[index];
            if (block.text.slice(match.start, match.end) !== match.matchedText) {
                if (target.broken) {
                    textChanged += 1;
                }
                return match;
            }
            const range = createRangeFromBlockOffsets(block, match.start, match.end, {
                allowFoldedHidden: options.allowFoldedHidden,
            });
            if (!range) {
                hiddenCopy = true;
                continue;
            }
            const attributeKind = isInlineMemoSearchUnit(block)
                ? "inline-memo"
                : (isInlineMathSearchUnit(block) ? "inline-math" : null);
            if (!matchRangePassesRestrictInline(range, options.restrictInlineTypes, {attributeKind})) {
                if (target.broken) {
                    textChanged += 1;
                }
                return match;
            }
            changed = true;
            return {...match, range};
        }
        if (target.broken && hiddenCopy) {
            changed = true;
            return {...match, range: undefined};
        }
        return match;
    });
    return {matches: changed ? next : matches, changed, textChanged};
}

/**
 * 思源嵌入块渲染出的子块带着原来的 data-node-id，和正文是两份 DOM。
 * 连通的正文优先；正文建不出 Range 时再试嵌入副本。
 */
function liveUnitRank(block: SearchableBlock): number {
    let rank = block.element.isConnected ? 2 : 0;
    if (!block.element.closest(EMBED_BLOCK_SELECTOR)) {
        rank += 1;
    }
    return rank;
}

function pushLiveUnit(into: Map<string, SearchableBlock[]>, key: string, block: SearchableBlock) {
    const list = into.get(key);
    if (list) {
        list.push(block);
        return;
    }
    into.set(key, [block]);
}

function rankedLiveUnits(
    match: SearchMatch,
    byKey: ReadonlyMap<string, SearchableBlock[]>,
    mathByKey: ReadonlyMap<string, SearchableBlock[]>,
    memoByKey: ReadonlyMap<string, SearchableBlock[]>,
): SearchableBlock[] {
    let list: SearchableBlock[] | undefined;
    if (
        match.highlightKind === "inline-math"
        && match.mathOrdinal !== undefined
        && match.mathUnitText !== undefined
    ) {
        list = mathByKey.get(`${match.blockId}\0${match.mathOrdinal}\0${match.mathUnitText}`);
    } else if (match.highlightKind === "inline-memo" && match.anchorOffset !== undefined) {
        list = memoByKey.get(`${match.blockId}\0${match.anchorOffset}`);
    } else {
        list = byKey.get(unitKey(match.blockId, match.unitId));
    }
    if (!list || list.length <= 1) {
        return list ?? [];
    }
    return list.slice().sort((left, right) => liveUnitRank(right) - liveUnitRank(left));
}
