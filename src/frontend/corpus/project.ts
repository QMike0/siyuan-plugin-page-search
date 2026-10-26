import type {RestrictInlineType} from "../../shared";
import {avApiUnitId} from "../../shared/av-live";
import {isRendererSourceFallbackUnitId} from "../../shared/renderer-units";
import {
    collectSearchableBlocks,
    inlineMathIdentityText,
    isInlineMathSearchUnit,
    isInlineMemoSearchUnit,
} from "../blocks";
import type {SearchableBlock} from "../dom-types";
import type {SearchMatch} from "../dom-types";
import type {SearchPipelineOptions} from "../pipeline";
import {createRangeFromBlockOffsets} from "../ranges";
import {matchRangePassesRestrictInline} from "../restrict-inline-dom";
import {unitKey} from "../selection";

interface ViewportProjection {
    blocks: Map<SearchableBlock, {ids: string[]; shown: boolean;}>;
    allowFoldedHidden: boolean;
    revision: number;
}
const viewportProjections = new WeakMap<Element, ViewportProjection>();
const matchIndices = new WeakMap<SearchMatch[], Map<string, number>>();

export interface RangeProjectionUpdate {
    matches: SearchMatch[];
    /** 调用方接受结果时才提交滚动映射；准备或丢弃结果都不修改当前状态。 */
    commit: () => boolean;
}

function unchangedProjection(matches: SearchMatch[]): RangeProjectionUpdate {
    return {matches, commit: () => true};
}

async function drainWithBudget<T>(iterator: Generator<void, T>, current: () => boolean): Promise<T | undefined> {
    let started = performance.now();
    while (current()) {
        const step = iterator.next();
        if (step.done) return current() ? step.value : undefined;
        if (performance.now() - started >= 8) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            started = performance.now();
        }
    }
    return undefined;
}

function liveTextMatches(block: SearchableBlock): boolean {
    if (!block.textNodes.length) return true;
    if (!block.textNodes.every((node) => node.isConnected)) return false;
    const text = block.textNodes.map((node) => node.nodeValue ?? "").join("");
    const prefix = block.textStartOffset ?? 0;
    return (block.textStartOffset === undefined ? text : text.slice(prefix, prefix + block.text.length)) === block.text;
}

export function clearViewportProjection(edit: Element): void {
    viewportProjections.delete(edit);
}

/** 无布局/隐藏窗格时保留兼容路径。只有可靠几何信息才能延迟视口外高亮。 */
function viewportTest(edit: Element): (block: SearchableBlock) => boolean {
    const content = edit.querySelector(".protyle-content") ?? edit;
    const viewport = content.getBoundingClientRect();
    if (!(viewport.width > 0 && viewport.height > 0 && Number.isFinite(viewport.top))) return () => true;
    const shown = new Map<Element, boolean>();
    return (block) => {
        const cached = shown.get(block.element);
        if (cached !== undefined) return cached;
        const rect = block.element.getBoundingClientRect();
        const result = !(rect.width > 0 && rect.height > 0 && Number.isFinite(rect.top)) ||
            (rect.bottom >= viewport.top - 200 && rect.top <= viewport.bottom + 200);
        shown.set(block.element, result);
        return result;
    };
}

/** 只重投影进入/离开视口的单元，不重搜、不发 API，也不改变命中总数。 */
export function refreshViewportRanges(edit: Element, matches: SearchMatch[]): SearchMatch[] {
    const iterator = iterateViewportRanges(edit, matches);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value.commit() ? step.value.matches : matches;
}

/** 滚动也使用时间预算；取消时不提交半套 shown 状态或 Range。 */
export async function refreshViewportRangesWithBudget(
    edit: Element,
    matches: SearchMatch[],
    signal: AbortSignal,
): Promise<SearchMatch[]> {
    const update = await prepareViewportRangesWithBudget(edit, matches, signal);
    return !signal.aborted && update?.commit() ? update.matches : matches;
}

export async function prepareViewportRangesWithBudget(
    edit: Element,
    matches: SearchMatch[],
    signal: AbortSignal,
    shouldContinue = () => true,
): Promise<RangeProjectionUpdate | undefined> {
    const projection = viewportProjections.get(edit);
    const revision = projection?.revision;
    const iterator = iterateViewportRanges(edit, matches);
    const current = () =>
        !signal.aborted && shouldContinue() &&
        viewportProjections.get(edit) === projection && projection?.revision === revision;
    const update = await drainWithBudget(iterator, current);
    if (!update) return undefined;
    return {matches: update.matches, commit: () => current() && update.commit()};
}

function* iterateViewportRanges(edit: Element, matches: SearchMatch[]): Generator<void, RangeProjectionUpdate> {
    const projection = viewportProjections.get(edit);
    if (!projection) return unchangedProjection(matches);
    const revision = projection.revision;
    const isShown = viewportTest(edit);
    let next: SearchMatch[] | undefined;
    let indexById = matchIndices.get(matches);
    const updates: Array<[SearchableBlock, boolean]> = [];
    let steps = 0;
    for (const [block, state] of projection.blocks) {
        if ((++steps & 63) === 0) yield;
        const connected = block.element.isConnected;
        const shown = connected && isShown(block);
        if (connected && shown === state.shown) continue;
        if (shown && !liveTextMatches(block)) {
            continue;
        }
        updates.push([block, shown]);
        if (!indexById) {
            indexById = new Map();
            for (let index = 0; index < matches.length; index++) {
                indexById.set(matches[index].id, index);
                if ((index & 511) === 511) yield;
            }
            matchIndices.set(matches, indexById);
        }
        for (const id of state.ids) {
            if ((++steps & 63) === 0) yield;
            const index = indexById.get(id);
            if (index === undefined) continue;
            const match = matches[index];
            if (block.text.slice(match.start, match.end) !== match.matchedText) continue;
            const range = shown ?
                createRangeFromBlockOffsets(block, match.start, match.end, {
                    allowFoldedHidden: projection.allowFoldedHidden,
                }) ?? undefined :
                undefined;
            if (!range && !match.range) continue;
            if (!next) {
                next = [];
                for (let index = 0; index < matches.length; index++) {
                    next.push(matches[index]);
                    if ((index & 511) === 511) yield;
                }
            }
            next[index] = {...match, range};
        }
    }
    // 分片期间可能编辑或替换了 Text；不把过期快照的偏移发布到新 DOM。
    for (const [block, shown] of updates) {
        if ((++steps & 63) === 0) yield;
        if (shown && (!block.element.isConnected || !liveTextMatches(block))) return unchangedProjection(matches);
    }
    if (!updates.length) return unchangedProjection(matches);
    if (next && indexById) matchIndices.set(next, indexById);
    // 大批块的状态也在预算内准备；提交只是替换 Map，避免提交阶段又成为长任务。
    const states = new Map<SearchableBlock, {ids: string[]; shown: boolean;}>();
    for (const [block, state] of projection.blocks) {
        states.set(block, state);
        if ((++steps & 63) === 0) yield;
    }
    for (const [block, shown] of updates) {
        if (!block.element.isConnected) states.delete(block);
        else {
            const state = states.get(block);
            if (state) states.set(block, {...state, shown});
        }
        if ((++steps & 63) === 0) yield;
    }
    return {
        matches: next ?? matches,
        commit: () => {
            if (viewportProjections.get(edit) !== projection || projection.revision !== revision) return false;
            if (updates.length) {
                projection.blocks = states;
                projection.revision += 1;
            }
            return true;
        },
    };
}

/** 只给已经挂在当前编辑器里的命中补 Range。没有对应单元格 DOM 的数据库命中保持无 Range。 */
function createRangeProjection(
    edit: Element,
    options: SearchPipelineOptions,
    liveBlocks?: SearchableBlock[],
    projectAll = false,
): {
    projection: ViewportProjection;
    resolve: (match: SearchMatch) => SearchableBlock | undefined;
    project: (match: SearchMatch) => SearchMatch;
} {
    const live = liveBlocks ?? collectSearchableBlocks(edit, {
        skipEmbeddedOrder: true,
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
        includeFlowchart: options.includeFlowchart !== false,
        includeHtmlBlock: options.includeHtmlBlock !== false,
        includeCustomBlock: options.includeCustomBlock !== false,
        includeFoldedBlocks: options.includeFoldedBlocks === true,
        includeInlineMemo: options.includeInlineMemo === true,
        restrictInlineTypes: options.restrictInlineTypes,
    });
    const byKey = new Map<string, SearchableBlock>();
    const embeddedAvByKey = new Map<string, SearchableBlock[]>();
    const mathByKey = new Map<string, SearchableBlock[]>();
    const memoByKey = new Map<string, SearchableBlock>();
    for (const block of live) {
        const key = unitKey(block.blockId, block.unitId);
        const existing = byKey.get(key);
        if (!existing || liveUnitRank(block) > liveUnitRank(existing)) byKey.set(key, block);
        const avKey = avApiUnitId(block.unitId);
        if (avKey && avKey !== block.unitId && block.element.closest('[data-type="NodeAttributeView"]')) {
            pushLiveUnit(embeddedAvByKey, unitKey(block.blockId, avKey), block);
        }
        if (isInlineMathSearchUnit(block) && block.mathOrdinal !== undefined) {
            const key = `${block.blockId}\0${block.mathOrdinal}\0${inlineMathIdentityText(block.text)}`;
            const candidates = mathByKey.get(key);
            if (candidates) {
                candidates.push(block);
            } else {
                mathByKey.set(key, [block]);
            }
        }
        if (
            isInlineMemoSearchUnit(block) && block.anchorOffset !== undefined &&
            !block.unitId?.startsWith("table-memo:")
        ) {
            const key = `${block.blockId}\0${block.anchorOffset}`;
            const existing = memoByKey.get(key);
            if (!existing || liveUnitRank(block) > liveUnitRank(existing)) memoByKey.set(key, block);
        }
    }

    const isShown = projectAll ? () => true : viewportTest(edit);
    const projection: ViewportProjection = {
        blocks: new Map(),
        allowFoldedHidden: options.includeFoldedBlocks === true,
        revision: 0,
    };
    const resolve = (match: SearchMatch): SearchableBlock | undefined => {
        if (isRendererSourceFallbackUnitId(match.unitId)) return undefined;
        let block: SearchableBlock | undefined;
        // 行级公式的 unitId 是全文采集序号；局部补绑（例如标题展开后）会从 0
        // 重新编号。优先使用所属块内序号和可见文字，避免碰巧相同的 unitId 指向另一条公式。
        if (
            !match.unitId?.startsWith("embed:") && match.highlightKind === "inline-math" &&
            match.mathOrdinal !== undefined &&
            match.mathUnitText !== undefined
        ) {
            block = mathByKey.get(
                `${match.blockId}\0${match.mathOrdinal}\0${match.mathUnitText}`,
            )?.[0];
        } else if (
            !match.unitId?.startsWith("embed:") && !match.unitId?.startsWith("table-memo:") &&
            match.highlightKind === "inline-memo" && match.anchorOffset !== undefined
        ) {
            block = memoByKey.get(`${match.blockId}\0${match.anchorOffset}`);
        }
        if (!block) {
            block = byKey.get(unitKey(match.blockId, match.unitId));
        }
        if (!block) {
            const candidates = embeddedAvByKey.get(unitKey(match.blockId, match.unitId));
            // Only a unique unsplit cell in the same group may borrow its Range;
            // offset/text checks still happen below.
            if (candidates?.length === 1 && embeddedAvViewMatches(match, candidates[0])) block = candidates[0];
        }
        return block && embeddedAvViewMatches(match, block) ? block : undefined;
    };
    const project = (match: SearchMatch): SearchMatch => {
        const block = resolve(match);
        if (!block) {
            return {...match, range: undefined};
        }
        if (block.text.slice(match.start, match.end) !== match.matchedText) {
            return {...match, range: undefined};
        }
        const shown = isShown(block);
        const state = projection.blocks.get(block);
        if (state) state.ids.push(match.id);
        else projection.blocks.set(block, {ids: [match.id], shown});
        if (!shown) return {...match, range: undefined};
        const range = createRangeFromBlockOffsets(block, match.start, match.end, {
            allowFoldedHidden: options.includeFoldedBlocks === true,
        }, match.range) ?? undefined;
        return {...match, range};
    };
    return {projection, resolve, project};
}

export function projectRanges(
    edit: Element,
    matches: SearchMatch[],
    options: SearchPipelineOptions,
    liveBlocks?: SearchableBlock[],
): SearchMatch[] {
    const prepared = createRangeProjection(edit, options, liveBlocks);
    const projected = matches.map(prepared.project);
    viewportProjections.set(edit, prepared.projection);
    return projected;
}

/** 局部 DOM 重建后替换对应块的滚动映射，避免继续持有旧节点或漏补新节点的高亮。 */
export function projectLiveRanges(
    edit: Element,
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    allowFoldedHidden: boolean,
): SearchMatch[] {
    const iterator = iterateLiveRanges(edit, matches, liveBlocks, allowFoldedHidden);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value.commit() ? step.value.matches : matches;
}

export async function prepareLiveRangesWithBudget(
    edit: Element,
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    allowFoldedHidden: boolean,
    current: () => boolean,
): Promise<RangeProjectionUpdate | undefined> {
    const update = await drainWithBudget(iterateLiveRanges(edit, matches, liveBlocks, allowFoldedHidden), current);
    return update ? {matches: update.matches, commit: () => current() && update.commit()} : undefined;
}

function* iterateLiveRanges(
    edit: Element,
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    allowFoldedHidden: boolean,
): Generator<void, RangeProjectionUpdate> {
    const projection = viewportProjections.get(edit);
    if (!liveBlocks.length) return unchangedProjection(matches);
    const revision = projection?.revision;
    const prepared = createRangeProjection(edit, {includeFoldedBlocks: allowFoldedHidden}, liveBlocks);
    const rebound = new Set<string>();
    const projected: SearchMatch[] = [];
    let steps = 0;
    for (const match of matches) {
        if (prepared.resolve(match)) {
            rebound.add(match.id);
            projected.push(prepared.project(match));
        } else projected.push(match);
        if ((++steps & 63) === 0) yield;
    }
    const states = new Map<SearchableBlock, {ids: string[]; shown: boolean;}>();
    // 同一个嵌入 owner 可含多个源单元；局部采集只迁移对得上的命中。
    for (const [block, state] of projection?.blocks ?? []) {
        if (!block.element.isConnected) continue;
        const ids: string[] = [];
        for (const id of state.ids) {
            if (!rebound.has(id)) ids.push(id);
            if ((++steps & 63) === 0) yield;
        }
        if (ids.length) states.set(block, {...state, ids});
        if ((++steps & 63) === 0) yield;
    }
    for (const [block, state] of prepared.projection.blocks) {
        states.set(block, state);
        if ((++steps & 63) === 0) yield;
    }
    return {
        matches: projected,
        commit: () => {
            if (viewportProjections.get(edit) !== projection || projection?.revision !== revision) return false;
            viewportProjections.set(edit, {
                blocks: states,
                allowFoldedHidden,
                revision: (revision ?? 0) + 1,
            });
            return true;
        },
    };
}

/** 全文投影分阶段让出事件循环；取消的旧查询不覆盖当前文档的滚动映射。 */
export async function projectRangesWithBudget(
    edit: Element,
    matches: SearchMatch[],
    options: SearchPipelineOptions,
    liveBlocks: SearchableBlock[],
): Promise<SearchMatch[]> {
    const prepared = createRangeProjection(edit, options, liveBlocks);
    const projected: SearchMatch[] = [];
    let started = performance.now();
    for (let index = 0; index < matches.length; index += 1) {
        if (options.signal?.aborted) return [];
        projected.push(prepared.project(matches[index]));
        if ((index & 63) === 63 && performance.now() - started >= 8) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            started = performance.now();
        }
    }
    if (!options.signal?.aborted) viewportProjections.set(edit, prepared.projection);
    return projected;
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
    // 导航目标可能尚在视口外，仍需立刻补一条 Range 才能滚到它。
    // 和全文投影共用公式、备注及正文副本身份解析，快速路径也保持这些规则。
    const prepared = createRangeProjection(
        liveBlocks[0].element,
        {includeFoldedBlocks: allowFoldedHidden},
        liveBlocks,
        true,
    );
    let changed = false;
    const next = matches.map((match) => {
        const projected = prepared.project(match);
        if (!projected.range || projected.range === match.range) return match;
        changed = true;
        return projected;
    });
    return changed ? next : matches;
}

export interface RebindTarget {
    /** 原来有 Range、现在已失效。 */
    broken: boolean;
    /** 块还挂在编辑器里。格子正在换编辑器、暂时没字时保留失效 Range，等下一轮。 */
    blockShown: boolean;
}

interface RebindResult {
    matches: SearchMatch[];
    changed: boolean;
    textChanged: number;
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
    options: {allowFoldedHidden: boolean; restrictInlineTypes?: RestrictInlineType[];},
): RebindResult {
    const iterator = iterateChangedRanges(matches, liveBlocks, targets, options);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
}

export async function rebindChangedRangesWithBudget(
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    targets: ReadonlyMap<SearchMatch, RebindTarget>,
    options: {allowFoldedHidden: boolean; restrictInlineTypes?: RestrictInlineType[];},
    current: () => boolean,
): Promise<RebindResult | undefined> {
    return drainWithBudget(iterateChangedRanges(matches, liveBlocks, targets, options), current);
}

function* iterateChangedRanges(
    matches: SearchMatch[],
    liveBlocks: SearchableBlock[],
    targets: ReadonlyMap<SearchMatch, RebindTarget>,
    options: {allowFoldedHidden: boolean; restrictInlineTypes?: RestrictInlineType[];},
): Generator<void, RebindResult> {
    if (!targets.size) {
        return {matches, changed: false, textChanged: 0};
    }
    const byKey = new Map<string, SearchableBlock[]>();
    const embeddedAvByKey = new Map<string, SearchableBlock[]>();
    const mathByKey = new Map<string, SearchableBlock[]>();
    const memoByKey = new Map<string, SearchableBlock[]>();
    let steps = 0;
    for (const block of liveBlocks) {
        pushLiveUnit(byKey, unitKey(block.blockId, block.unitId), block);
        const avKey = avApiUnitId(block.unitId);
        if (avKey && avKey !== block.unitId && block.element.closest('[data-type="NodeAttributeView"]')) {
            pushLiveUnit(embeddedAvByKey, unitKey(block.blockId, avKey), block);
        }
        if (isInlineMathSearchUnit(block) && block.mathOrdinal !== undefined) {
            pushLiveUnit(
                mathByKey,
                `${block.blockId}\0${block.mathOrdinal}\0${inlineMathIdentityText(block.text)}`,
                block,
            );
        }
        if (
            isInlineMemoSearchUnit(block) &&
            block.anchorOffset !== undefined &&
            !block.unitId?.startsWith("table-memo:")
        ) {
            pushLiveUnit(memoByKey, `${block.blockId}\0${block.anchorOffset}`, block);
        }
        if ((++steps & 63) === 0) yield;
    }
    let changed = false;
    let textChanged = 0;
    const rebind = (match: SearchMatch): SearchMatch => {
        const target = targets.get(match);
        if (!target) {
            return match;
        }
        let candidates = rankedLiveUnits(match, byKey, mathByKey, memoByKey).filter(block =>
            embeddedAvViewMatches(match, block)
        );
        if (!candidates.length) {
            const aliases = embeddedAvByKey.get(unitKey(match.blockId, match.unitId));
            if (aliases?.length === 1 && embeddedAvViewMatches(match, aliases[0])) candidates = aliases;
        }
        if (!candidates.length) {
            if (target.broken && (!target.blockShown || avApiUnitId(match.unitId))) {
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
            const attributeKind = isInlineMemoSearchUnit(block) ?
                "inline-memo" :
                (isInlineMathSearchUnit(block) ? "inline-math" : null);
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
    };
    const next: SearchMatch[] = [];
    for (const match of matches) {
        next.push(rebind(match));
        if ((++steps & 63) === 0) yield;
    }
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
    // Mindmap/tab projections are the only live copy that can paint a match
    // while the source block is hidden. Prefer that copy for Range projection;
    // replacement still resolves the same blockId back to the source DOM.
    if (block.matchSource === "projection") {
        rank += 2;
    }
    return rank;
}

function embeddedAvViewMatches(match: SearchMatch, block: SearchableBlock): boolean {
    if (!match.embeddedAvViewId) return true;
    const av = block.element.closest('[data-type="NodeAttributeView"]');
    const view = av?.getAttribute("custom-sy-av-view")?.trim() ||
        av?.querySelector<HTMLElement>(".av__views .item--focus")?.dataset.id?.trim() || "";
    return view === match.embeddedAvViewId;
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
    if (isRendererSourceFallbackUnitId(match.unitId)) return [];
    let list: SearchableBlock[] | undefined;
    if (
        !match.unitId?.startsWith("embed:") && match.highlightKind === "inline-math" &&
        match.mathOrdinal !== undefined &&
        match.mathUnitText !== undefined
    ) {
        list = mathByKey.get(`${match.blockId}\0${match.mathOrdinal}\0${match.mathUnitText}`);
    } else if (match.highlightKind === "inline-memo" && match.unitId?.startsWith("table-memo:")) {
        // 表格备注的 unitId 是逻辑行列加格内偏移，不随全文序号变化。
        list = byKey.get(unitKey(match.blockId, match.unitId));
    } else if (
        !match.unitId?.startsWith("embed:") && match.highlightKind === "inline-memo" && match.anchorOffset !== undefined
    ) {
        list = memoByKey.get(`${match.blockId}\0${match.anchorOffset}`);
    } else {
        list = byKey.get(unitKey(match.blockId, match.unitId));
    }
    if (!list || list.length <= 1) {
        return list ?? [];
    }
    return list.slice().sort((left, right) => liveUnitRank(right) - liveUnitRank(left));
}
