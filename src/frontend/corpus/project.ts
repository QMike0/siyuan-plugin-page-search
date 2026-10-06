import {collectSearchableBlocks} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import type {SearchMatch} from "../dom-types";
import {createRangeFromBlockOffsets} from "../ranges";
import {unitKey} from "../selection";
import type {SearchPipelineOptions} from "../pipeline";

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
