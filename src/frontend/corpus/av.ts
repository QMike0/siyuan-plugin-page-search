import type {SearchableUnit} from "../../shared";
import {postJson} from "./api";

const PAGE_SIZE = 200;
const MAX_PAGES = 500;

/** 内核没有 hasMore 字段时的本地保险上限，不能把截断结果写成完整缓存。 */
export class AttributeViewTruncatedError extends Error {
    constructor() {
        super("renderAttributeView exceeded page limit");
        this.name = "AttributeViewTruncatedError";
    }
}

/** 重复页、总数对不上或翻页期间顺序变了。不能当成完整结果写入缓存。 */
class AttributeViewPageError extends Error {
    constructor() {
        super("renderAttributeView page is incomplete");
        this.name = "AttributeViewPageError";
    }
}

export interface AvBlockRef {
    blockId: string;
    avId: string;
    updated: string;
    /** 载体块 IAL 持久化的当前视图；空值才允许兼容性全视图回退。 */
    carrierViewId: string;
}

interface AvCell {
    text: string;
    snippet: string;
}

interface AvUnitDraft {
    unitId: string;
    text: string;
    snippet?: string;
}

const cache = new Map<string, SearchableUnit[]>();
const AV_CACHE_LIMIT = 32;
const AV_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;

export function invalidateAvCacheForBlocks(blockIds: readonly string[]): void {
    if (blockIds.length === 0) {
        return;
    }
    const prefixes = blockIds.map((blockId) => `${blockId}:`);
    const doomed: string[] = [];
    for (const key of cache.keys()) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
            doomed.push(key);
        }
    }
    for (const key of doomed) {
        cache.delete(key);
    }
}

export function invalidateAvCache(): void {
    cache.clear();
}

function avUnitsBytes(units: readonly SearchableUnit[]): number {
    let bytes = 64;
    for (const unit of units) {
        bytes += 48 + unit.text.length * 2 + (unit.unitId?.length ?? 0) * 2;
    }
    return bytes;
}

function trimAvCache(): void {
    while (cache.size > AV_CACHE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest) {
            return;
        }
        cache.delete(oldest);
    }
    let bytes = 0;
    for (const units of cache.values()) {
        bytes += avUnitsBytes(units);
    }
    while (cache.size > 1 && bytes > AV_CACHE_BYTE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest) {
            return;
        }
        const removed = cache.get(oldest);
        cache.delete(oldest);
        bytes -= removed ? avUnitsBytes(removed) : 0;
    }
}

function touchAvCache(key: string): void {
    const units = cache.get(key);
    if (!units) {
        return;
    }
    cache.delete(key);
    cache.set(key, units);
}

export function readAvId(...sources: string[]): string {
    for (const source of sources) {
        const matched = /(?:data-)?av-id="([^"]+)"/.exec(source);
        if (matched?.[1]) {
            return matched[1].trim();
        }
    }
    return "";
}

export function readAvIdFromMarkdown(markdown: string): string {
    return readAvId(markdown);
}

/** IAL 和块 DOM 都使用同名属性；只接受非空、未转义的属性值。 */
export function readAvCarrierViewId(...sources: string[]): string {
    for (const source of sources) {
        const matched = /custom-sy-av-view="([^"]+)"/.exec(source);
        if (matched?.[1]) {
            return matched[1].trim();
        }
    }
    return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ?
        value as Record<string, unknown> :
        null;
}

function textOf(value: unknown): string {
    if (value == null) {
        return "";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => textOf(item)).filter(Boolean).join(" ");
    }
    const record = asRecord(value);
    if (!record) {
        return "";
    }
    if (typeof record.content === "string" && record.content) {
        return record.content;
    }
    const parts: string[] = [];
    for (
        const key of [
            "text",
            "block",
            "number",
            "date",
            "url",
            "email",
            "phone",
            "template",
            "rollup",
            "mSelect",
            "mAsset",
            "relation",
            "checkbox",
        ]
    ) {
        if (key in record) {
            const piece = textOf(record[key]);
            if (piece) {
                parts.push(piece);
            }
        }
    }
    if (typeof record.content2 === "string" && record.content2) {
        parts.push(record.content2);
    }
    if (Array.isArray(record.contents)) {
        parts.push(textOf(record.contents));
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

function columnNames(view: Record<string, unknown>): Map<string, string> {
    const names = new Map<string, string>();
    const columns = view.columns ?? view.fields ?? view.cols;
    if (!Array.isArray(columns)) {
        return names;
    }
    for (const column of columns) {
        const record = asRecord(column);
        if (!record) {
            continue;
        }
        const id = String(record.id ?? record.keyID ?? "");
        const name = String(record.name ?? "");
        if (id && name) {
            names.set(id, name);
        }
    }
    return names;
}

function cellDisplay(
    cell: unknown,
    rowId: string,
    viewName: string,
    columns: Map<string, string>,
): {itemId: string; keyId: string; cell: AvCell;} | null {
    const record = asRecord(cell);
    if (!record) {
        return null;
    }
    const value = asRecord(record.value) ?? record;
    const itemId = String(record.itemID ?? record.blockID ?? value.blockID ?? value.id ?? rowId);
    const keyId = String(value.keyID ?? record.keyID ?? record.fieldID ?? "");
    const text = textOf(value);
    if (!itemId || !keyId || !text) {
        return null;
    }
    const columnName = columns.get(keyId) ?? "";
    const snippet = [viewName, columnName, text].filter(Boolean).join(" · ");
    return {itemId, keyId, cell: {text, snippet}};
}

function rowList(view: Record<string, unknown>): unknown[] {
    const rows = view.rows ?? view.cards;
    return Array.isArray(rows) ? rows : [];
}

function cellKey(itemId: string, keyId: string): string {
    return `${itemId}:${keyId}`;
}

function absorbRows(
    target: Map<string, AvCell>,
    view: Record<string, unknown>,
    viewName: string,
    overwrite: boolean,
): void {
    const columns = columnNames(view);
    const put = (cell: unknown, rowId: string) => {
        const parsed = cellDisplay(cell, rowId, viewName, columns);
        if (!parsed) {
            return;
        }
        const key = cellKey(parsed.itemId, parsed.keyId);
        if (overwrite || !target.has(key)) {
            target.set(key, parsed.cell);
        }
    };
    for (const row of rowList(view)) {
        const record = asRecord(row);
        if (!record) {
            continue;
        }
        const rowId = String(record.id ?? "");
        const cells = record.cells ?? record.values;
        if (!Array.isArray(cells)) {
            continue;
        }
        for (const cell of cells) {
            put(cell, rowId);
        }
    }
    if (!Array.isArray(view.groups)) {
        return;
    }
    for (const group of view.groups) {
        const record = asRecord(group);
        if (!record) {
            continue;
        }
        absorbRows(target, record, viewName, overwrite);
    }
}

function groupSnapshots(view: Record<string, unknown>): Array<{id: string; rows: number; total: number;}> {
    if (!Array.isArray(view.groups)) {
        return [];
    }
    const snapshots: Array<{id: string; rows: number; total: number;}> = [];
    for (const group of view.groups) {
        const record = asRecord(group);
        if (!record) {
            continue;
        }
        const id = String(record.id ?? record.groupID ?? "");
        snapshots.push({
            id,
            rows: rowList(record).length,
            total: Number(record.rowCount ?? record.cardCount ?? 0) || 0,
        });
    }
    return snapshots;
}

function pageDone(shown: number, total: number, accumulated: number): boolean {
    // 这一页或累计行数已经盖住声明的总数时结束。
    // 短页只有在内核没给总数时才表示末页，避免总数还没到就当成读完。
    if (total > 0 && (accumulated >= total || shown >= total)) {
        return true;
    }
    if (total > 0) {
        return false;
    }
    return shown < PAGE_SIZE;
}

function subtreeRowIds(view: Record<string, unknown>): string[] {
    const ids: string[] = [];
    for (const row of rowList(view)) {
        const id = String(asRecord(row)?.id ?? "");
        if (id) {
            ids.push(id);
        }
    }
    if (!Array.isArray(view.groups)) {
        return ids;
    }
    for (const group of view.groups) {
        const record = asRecord(group);
        if (record) {
            ids.push(...subtreeRowIds(record));
        }
    }
    return ids;
}

function groupSubtreeIds(view: Record<string, unknown>, groupIds: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    if (!Array.isArray(view.groups)) {
        return ids;
    }
    for (const group of view.groups) {
        const record = asRecord(group);
        if (!record) {
            continue;
        }
        const id = String(record.id ?? record.groupID ?? "");
        if (!groupIds.has(id)) {
            continue;
        }
        ids.push(...subtreeRowIds(record));
    }
    return ids;
}

/** 同一页里重复的行号只计一次。跨页又出现，说明翻页窗口变了。 */
function observeRowIds(ids: readonly string[], seen: Set<string>): {fresh: number; duplicate: number;} {
    const local = new Set<string>();
    let fresh = 0;
    let duplicate = 0;
    for (const id of ids) {
        if (!id || local.has(id)) {
            continue;
        }
        local.add(id);
        if (seen.has(id)) {
            duplicate += 1;
            continue;
        }
        seen.add(id);
        fresh += 1;
    }
    return {fresh, duplicate};
}

function assertFreshPage(stats: {fresh: number; duplicate: number;}): void {
    if (stats.fresh === 0 || stats.duplicate > 0) {
        throw new AttributeViewPageError();
    }
}

function assertSameTotal(previous: number, next: number): void {
    if (previous > 0 && next > 0 && previous !== next) {
        throw new AttributeViewPageError();
    }
}

async function renderView(
    avId: string,
    blockId: string,
    viewId: string,
    viewName: string,
    target: Map<string, AvCell>,
    shouldContinue: () => boolean,
    signal?: AbortSignal,
): Promise<boolean> {
    if (!shouldContinue()) {
        return false;
    }
    const first = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
        id: avId,
        blockID: blockId,
        viewID: viewId,
        page: 1,
        pageSize: PAGE_SIZE,
        query: "",
        groupPaging: {},
        createIfNotExist: false,
    }, signal);
    if (!shouldContinue()) {
        return false;
    }
    if (first === null) {
        throw new Error("renderAttributeView failed");
    }
    const firstView = asRecord(first?.view);
    if (!firstView) {
        return true;
    }
    const seenRows = new Set<string>();
    observeRowIds(subtreeRowIds(firstView), seenRows);
    absorbRows(target, firstView, viewName, true);
    const groups = groupSnapshots(firstView);
    if (groups.length > 0) {
        const pages = new Map<string, number>();
        const seenInGroup = new Map<string, number>();
        for (const group of groups) {
            if (group.id) {
                pages.set(group.id, 1);
                seenInGroup.set(group.id, group.rows);
            }
        }
        for (let round = 0; round < MAX_PAGES; round += 1) {
            const groupPaging: Record<string, {page: number; pageSize: number;}> = {};
            const requested = new Set<string>();
            let pending = false;
            for (const group of groups) {
                if (!group.id) {
                    continue;
                }
                const seen = seenInGroup.get(group.id) ?? group.rows;
                if (!pageDone(group.rows, group.total, seen) && group.rows > 0) {
                    const page = pages.get(group.id) ?? 1;
                    pages.set(group.id, page + 1);
                    groupPaging[group.id] = {page: page + 1, pageSize: PAGE_SIZE};
                    requested.add(group.id);
                    pending = true;
                }
            }
            if (!pending) {
                for (const group of groups) {
                    if (!group.id) {
                        continue;
                    }
                    const seen = seenInGroup.get(group.id) ?? group.rows;
                    if (!pageDone(group.rows, group.total, seen)) {
                        throw new AttributeViewPageError();
                    }
                }
                return true;
            }
            if (!shouldContinue()) {
                return false;
            }
            const previousTotals = new Map(groups.map((group) => [group.id, group.total]));
            const data = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
                id: avId,
                blockID: blockId,
                viewID: viewId,
                page: 1,
                pageSize: PAGE_SIZE,
                query: "",
                groupPaging,
                createIfNotExist: false,
            }, signal);
            if (!shouldContinue()) {
                return false;
            }
            if (data === null) {
                throw new Error("renderAttributeView page failed");
            }
            const view = asRecord(data?.view);
            if (!view) {
                throw new AttributeViewPageError();
            }
            const scoped = groupSubtreeIds(view, requested);
            const stats = observeRowIds(scoped.length > 0 ? scoped : subtreeRowIds(view), seenRows);
            if (scoped.length > 0) {
                assertFreshPage(stats);
            } else if (stats.fresh === 0) {
                throw new AttributeViewPageError();
            }
            const next = groupSnapshots(view);
            for (const group of next) {
                assertSameTotal(previousTotals.get(group.id) ?? 0, group.total);
                if (group.id && requested.has(group.id)) {
                    seenInGroup.set(group.id, (seenInGroup.get(group.id) ?? 0) + group.rows);
                }
            }
            absorbRows(target, view, viewName, true);
            groups.splice(0, groups.length, ...next.filter((group) => pages.has(group.id)));
            if (!groups.length) {
                throw new AttributeViewPageError();
            }
        }
        throw new AttributeViewTruncatedError();
    }

    let page = 1;
    let rows = rowList(firstView).length;
    let total = Number(firstView.rowCount ?? firstView.cardCount ?? 0) || 0;
    const pageCount = Number(firstView.pageCount ?? 0) || 0;
    while (!pageDone(rows, total, seenRows.size) && (pageCount === 0 || page < pageCount) && page < MAX_PAGES) {
        if (!shouldContinue()) {
            return false;
        }
        page += 1;
        const data = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
            id: avId,
            blockID: blockId,
            viewID: viewId,
            page,
            pageSize: PAGE_SIZE,
            query: "",
            groupPaging: {},
            createIfNotExist: false,
        }, signal);
        if (!shouldContinue()) {
            return false;
        }
        if (data === null) {
            throw new Error("renderAttributeView page failed");
        }
        const view = asRecord(data?.view);
        if (!view) {
            throw new AttributeViewPageError();
        }
        const nextTotal = Number(view.rowCount ?? view.cardCount ?? 0) || 0;
        assertSameTotal(total, nextTotal);
        if (nextTotal > 0) {
            total = nextTotal;
        }
        assertFreshPage(observeRowIds(subtreeRowIds(view), seenRows));
        absorbRows(target, view, viewName, true);
        rows = rowList(view).length;
    }
    if (!pageDone(rows, total, seenRows.size)) {
        if (page >= MAX_PAGES) {
            throw new AttributeViewTruncatedError();
        }
        throw new AttributeViewPageError();
    }
    return true;
}

function absorbRaw(
    target: Map<string, AvCell>,
    data: unknown,
): {name: string; views: Array<{id: string; name: string;}>;} {
    const root = asRecord(data);
    const av = asRecord(root?.av) ?? root;
    const name = typeof av?.name === "string" ? av.name : "";
    const views: Array<{id: string; name: string;}> = [];
    if (Array.isArray(av?.views)) {
        for (const view of av.views) {
            const record = asRecord(view);
            if (!record?.id) {
                continue;
            }
            views.push({id: String(record.id), name: String(record.name ?? "")});
        }
    }
    const keyValues = av?.keyValues;
    if (!Array.isArray(keyValues)) {
        return {name, views};
    }
    for (const entry of keyValues) {
        const record = asRecord(entry);
        const key = asRecord(record?.key);
        const keyId = String(key?.id ?? "");
        const columnName = String(key?.name ?? "");
        const values = record?.values;
        if (!keyId || !Array.isArray(values)) {
            continue;
        }
        for (const value of values) {
            const item = asRecord(value);
            const itemId = String(item?.blockID ?? item?.blockId ?? "");
            const text = textOf(item);
            if (!itemId || !text) {
                continue;
            }
            const mapKey = cellKey(itemId, keyId);
            if (target.has(mapKey)) {
                continue;
            }
            target.set(mapKey, {
                text,
                snippet: [columnName, text].filter(Boolean).join(" · "),
            });
        }
    }
    return {name, views};
}

function toUnits(blockId: string, drafts: AvUnitDraft[]): Array<SearchableUnit & {snippet?: string;}> {
    return drafts.map((draft) => ({
        blockId,
        blockType: "NodeAttributeView",
        blockIndex: 0,
        text: draft.text,
        unitId: draft.unitId,
        snippet: draft.snippet,
    }));
}

/** 打开中的数据库按载体 viewID 缓存；未挂载时按内核规则使用默认首个可用视图。 */
function cacheKey(ref: AvBlockRef, viewId = ""): string {
    return `${ref.blockId}:${ref.avId}:${ref.updated}:${viewId ? `view:${viewId}` : "default"}`;
}

function selectedViewId(ref: AvBlockRef, viewIds: ReadonlyMap<string, string>): string {
    return viewIds.get(ref.blockId) ?? ref.carrierViewId;
}

function replaceCachedUnits(ref: AvBlockRef, viewId: string, units: SearchableUnit[]): void {
    // updated 变了也要清掉同一数据库的旧视图，避免长会话留下过期单元格文字。
    const prefix = `${ref.blockId}:${ref.avId}:`;
    for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
    cache.set(cacheKey(ref, viewId), units);
    trimAvCache();
}

export function peekAvUnits(
    refs: AvBlockRef[],
    viewIds: ReadonlyMap<string, string> = new Map(),
): {units: Array<SearchableUnit & {snippet?: string;}>; missing: AvBlockRef[];} {
    const units: Array<SearchableUnit & {snippet?: string;}> = [];
    const missing: AvBlockRef[] = [];
    for (const ref of refs) {
        const cached = cache.get(cacheKey(ref, selectedViewId(ref, viewIds)));
        if (cached) {
            touchAvCache(cacheKey(ref, selectedViewId(ref, viewIds)));
            units.push(...cached);
        } else {
            missing.push(ref);
        }
    }
    return {units, missing};
}

export async function loadAvUnits(
    refs: AvBlockRef[],
    shouldContinue: () => boolean = () => true,
    viewIds: ReadonlyMap<string, string> = new Map(),
    signal?: AbortSignal,
): Promise<Array<SearchableUnit & {snippet?: string;}>> {
    const units: Array<SearchableUnit & {snippet?: string;}> = [];
    for (const ref of refs) {
        if (!shouldContinue()) {
            return units;
        }
        const viewId = selectedViewId(ref, viewIds);
        const key = cacheKey(ref, viewId);
        const cached = cache.get(key);
        if (cached) {
            touchAvCache(key);
            units.push(...cached);
            continue;
        }
        const cells = new Map<string, AvCell>();
        const raw = await postJson<unknown>("/api/av/getAttributeView", {id: ref.avId}, signal);
        if (!shouldContinue()) {
            return units;
        }
        if (raw === null) {
            throw new Error("getAttributeView failed");
        }
        const info = absorbRaw(new Map(), raw);
        const drafts: AvUnitDraft[] = [];
        if (info.name) {
            drafts.push({unitId: "av-title", text: info.name, snippet: info.name});
        }
        const views = viewId ?
            info.views.filter((view) => view.id === viewId) :
            info.views.slice(0, 1);
        // 载体写入过期 viewID 时，内核会退回该数据库的首个可用视图。这里采用相同
        // 的单视图回退，不能退化成全库并把隐藏列/筛选外行重新纳入搜索。
        if (viewId && views.length === 0) {
            const fallback = info.views[0];
            if (fallback) {
                views.push(fallback);
            }
        }
        for (const view of views) {
            if (view.name) {
                drafts.push({unitId: `av-view:${view.id}`, text: view.name, snippet: view.name});
            }
            if (!await renderView(ref.avId, ref.blockId, view.id, view.name, cells, shouldContinue, signal)) {
                // 取消时分页还没结束。不写入这一库，避免把半截单元格当成完整缓存。
                return units;
            }
        }
        if (views.length === 0) {
            if (!await renderView(ref.avId, ref.blockId, "", info.name, cells, shouldContinue, signal)) {
                return units;
            }
        }
        for (const [key, cell] of cells) {
            drafts.push({unitId: `av:${key}`, text: cell.text, snippet: cell.snippet});
        }
        const built = toUnits(ref.blockId, drafts);
        replaceCachedUnits(ref, viewId, built);
        units.push(...built);
    }
    return units;
}

export async function resolveMissingAvIds(
    rows: Array<{id: string; updated?: string; markdown?: string; ial?: string;}>,
    signal?: AbortSignal,
): Promise<{refs: AvBlockRef[]; cacheable: boolean;}> {
    const refs: AvBlockRef[] = [];
    const missing: string[] = [];
    for (const row of rows) {
        if (!row.id) {
            continue;
        }
        const avId = readAvId(String(row.markdown ?? ""), String(row.ial ?? ""));
        if (avId) {
            refs.push({
                blockId: row.id,
                avId,
                updated: String(row.updated ?? ""),
                carrierViewId: readAvCarrierViewId(String(row.ial ?? ""), String(row.markdown ?? "")),
            });
        } else {
            missing.push(row.id);
        }
    }
    if (missing.length === 0) {
        return {refs, cacheable: true};
    }
    try {
        const doms = await postJson<Record<string, string>>("/api/block/getBlockDOMs", {ids: missing}, signal);
        if (!doms) {
            // 这一轮仍用已经解析出的引用；补全失败的结果不能写入缓存。
            return {refs, cacheable: false};
        }
        for (const id of missing) {
            const avId = readAvId(String(doms[id] ?? ""));
            if (!avId) {
                continue;
            }
            const row = rows.find((item) => item.id === id);
            refs.push({
                blockId: id,
                avId,
                updated: String(row?.updated ?? ""),
                carrierViewId: readAvCarrierViewId(
                    String(row?.ial ?? ""),
                    String(row?.markdown ?? ""),
                    String(doms[id] ?? ""),
                ),
            });
        }
    } catch {
        return {refs, cacheable: false};
    }
    return {refs, cacheable: true};
}
