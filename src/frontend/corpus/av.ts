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

/** 保留成功载体的缓存，只把失败载体与截断状态传给搜索覆盖检查。 */
export class AttributeViewLoadError extends Error {
    constructor(readonly failedBlockIds: string[], readonly truncatedBlockIds: string[]) {
        super("attribute view loading is incomplete");
        this.name = "AttributeViewLoadError";
    }
}

export interface AvBlockRef {
    blockId: string;
    avId: string;
    updated: string;
    /** 载体块 IAL 持久化的当前视图；空值使用默认首个可用视图。 */
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
const cachedBytes = new Map<string, number>();
const cacheKeysByCarrier = new Map<string, Set<string>>();
const pinnedAvKeys = new Set<string>();
const unpinnedAvKeys = new Map<string, true>();
let retainedBytes = 0;

function dropAvCache(key: string): void {
    retainedBytes -= cachedBytes.get(key) ?? 0;
    cachedBytes.delete(key);
    cache.delete(key);
    unpinnedAvKeys.delete(key);
    const prefix = key.split(":").slice(0, 2).join(":") + ":";
    const keys = cacheKeysByCarrier.get(prefix);
    keys?.delete(key);
    if (keys?.size === 0) cacheKeysByCarrier.delete(prefix);
}
const AV_CACHE_LIMIT = 32;
const AV_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;
const activeKeysByRoot = new Map<string, Set<string>>();
const activeOwnersByRoot = new Map<string, Map<object | string, Set<string>>>();
let cacheRevision = 0;
const activeLoads = new Set<{refs: AvBlockRef[]; invalidated: boolean;}>();
interface CarrierFlight {
    ref: AvBlockRef;
    controller: AbortController;
    consumers: Set<() => boolean>;
    task: Promise<SearchableUnit[] | null>;
}
const carrierFlights = new Map<string, CarrierFlight>();

function abortCarrierFlights(matches: (ref: AvBlockRef) => boolean): void {
    for (const [key, flight] of carrierFlights) {
        if (matches(flight.ref)) {
            carrierFlights.delete(key);
            flight.controller.abort();
        }
    }
}

/** 只在工作集变更时重算所有权；写入时不重复扫描整篇文档的锁定缓存。 */
function syncAvCacheOwnership(): void {
    pinnedAvKeys.clear();
    for (const keys of activeKeysByRoot.values()) for (const key of keys) pinnedAvKeys.add(key);
    unpinnedAvKeys.clear();
    for (const key of cache.keys()) if (!pinnedAvKeys.has(key)) unpinnedAvKeys.set(key, true);
    trimAvCache();
}

/** 活动搜索的完整工作集允许暂时超过预算，否则 33 个载体会在 32 项缓存中循环补全。 */
export function pinAvCache(
    rootId: string,
    refs: AvBlockRef[],
    viewIds: ReadonlyMap<string, string>,
    owner: object | string = rootId,
): void {
    const owners = activeOwnersByRoot.get(rootId) ?? new Map<object | string, Set<string>>();
    owners.set(owner, new Set(refs.map((ref) => cacheKey(ref, selectedViewId(ref, viewIds)))));
    activeOwnersByRoot.set(rootId, owners);
    const owned = new Set<string>();
    for (const keys of owners.values()) for (const key of keys) owned.add(key);
    activeKeysByRoot.set(rootId, owned);
    syncAvCacheOwnership();
}

export function releaseAvCache(rootId: string): void {
    activeKeysByRoot.delete(rootId);
    activeOwnersByRoot.delete(rootId);
    syncAvCacheOwnership();
}

export function releaseAvCacheOwner(rootId: string, owner: object): void {
    const owners = activeOwnersByRoot.get(rootId);
    if (!owners?.delete(owner)) return;
    if (!owners.size) {
        releaseAvCache(rootId);
        return;
    }
    const keys = new Set<string>();
    for (const owned of owners.values()) for (const key of owned) keys.add(key);
    activeKeysByRoot.set(rootId, keys);
    syncAvCacheOwnership();
}

export function invalidateAvCacheForIds(avIds: readonly string[]): void {
    const ids = new Set(avIds);
    abortCarrierFlights((ref) => ids.has(ref.avId));
    for (const load of activeLoads) {
        if (load.refs.some((ref) => ids.has(ref.avId))) load.invalidated = true;
    }
    for (const key of cache.keys()) {
        if (ids.has(key.split(":")[1])) {
            dropAvCache(key);
        }
    }
}

export function rootUsesAttributeViews(rootId: string, avIds: readonly string[]): boolean {
    const ids = new Set(avIds);
    for (const key of activeKeysByRoot.get(rootId) ?? []) {
        if (ids.has(key.split(":")[1])) return true;
    }
    return false;
}

export function invalidateAvCacheForRoot(rootId: string): void {
    const keys = activeKeysByRoot.get(rootId) ?? new Set<string>();
    const blockIds = new Set(Array.from(keys, (key) => key.split(":")[0]));
    invalidateAvCacheForBlocks(Array.from(blockIds));
}

export function invalidateAvCacheForBlocks(blockIds: readonly string[]): void {
    if (blockIds.length === 0) {
        return;
    }
    const ids = new Set(blockIds);
    abortCarrierFlights((ref) => ids.has(ref.blockId));
    for (const load of activeLoads) {
        if (load.refs.some((ref) => ids.has(ref.blockId))) load.invalidated = true;
    }
    for (const key of cache.keys()) {
        if (ids.has(key.split(":")[0])) dropAvCache(key);
    }
}

export function invalidateAvCache(): void {
    cacheRevision += 1;
    abortCarrierFlights(() => true);
    cache.clear();
    cachedBytes.clear();
    cacheKeysByCarrier.clear();
    pinnedAvKeys.clear();
    unpinnedAvKeys.clear();
    retainedBytes = 0;
    activeKeysByRoot.clear();
    activeOwnersByRoot.clear();
}

function avUnitsBytes(units: readonly SearchableUnit[]): number {
    let bytes = 64;
    for (const unit of units) {
        bytes += 48 + unit.text.length * 2 + (unit.unitId?.length ?? 0) * 2 +
            ((unit as SearchableUnit & {snippet?: string;}).snippet?.length ?? 0) * 2;
    }
    return bytes;
}

function trimAvCache(): void {
    if (cache.size <= AV_CACHE_LIMIT && retainedBytes <= AV_CACHE_BYTE_LIMIT) return;
    for (const key of unpinnedAvKeys.keys()) {
        if (cache.size <= AV_CACHE_LIMIT && retainedBytes <= AV_CACHE_BYTE_LIMIT) {
            return;
        }
        dropAvCache(key);
    }
}

function touchAvCache(key: string): void {
    const units = cache.get(key);
    if (!units) {
        return;
    }
    cache.delete(key);
    cache.set(key, units);
    if (unpinnedAvKeys.delete(key)) unpinnedAvKeys.set(key, true);
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
    const text = asRecord(record.text);
    if (typeof text?.content === "string") {
        // 思源普通文本单元格直接渲染 text.content，不裁剪/压缩字段值。
        // 多选、关联等复合值继续使用下面的历史分隔规则。
        return text.content;
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

function groupSnapshots(view: Record<string, unknown>): Array<{id: string; view: Record<string, unknown>;}> {
    if (!Array.isArray(view.groups)) {
        return [];
    }
    const snapshots: Array<{id: string; view: Record<string, unknown>;}> = [];
    for (const group of view.groups) {
        const record = asRecord(group);
        if (!record) {
            continue;
        }
        const id = String(record.id ?? record.groupID ?? "");
        snapshots.push({id, view: record});
    }
    return snapshots;
}

interface PageProgress {
    page: number;
    seen: Set<string>;
    total?: number;
    done: boolean;
}

function observePage(view: Record<string, unknown>, progress: PageProgress): void {
    const value = view.rowCount ?? view.cardCount;
    const total = value === undefined ? undefined : Number(value);
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) throw new AttributeViewPageError();
    if (progress.total !== undefined && total !== progress.total) throw new AttributeViewPageError();
    progress.total = total;
    const rows = rowList(view);
    for (const row of rows) {
        const id = String(asRecord(row)?.id ?? "");
        // 一页内和同一组跨页都不应重复。跨组的合法重复由各组独立 seen 接受。
        if (!id || progress.seen.has(id)) throw new AttributeViewPageError();
        progress.seen.add(id);
    }
    if (total !== undefined && progress.seen.size > total) throw new AttributeViewPageError();
    progress.done = total === undefined ? rows.length < PAGE_SIZE : progress.seen.size === total;
    if (!progress.done && rows.length < PAGE_SIZE) throw new AttributeViewPageError();
}

function firstProgress(view: Record<string, unknown>): PageProgress {
    const progress: PageProgress = {page: 1, seen: new Set(), done: false};
    observePage(view, progress);
    return progress;
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
        throw new AttributeViewPageError();
    }
    absorbRows(target, firstView, viewName, true);
    const groups = groupSnapshots(firstView);
    if (groups.length > 0) {
        const progressByGroup = new Map<string, PageProgress>();
        for (const group of groups) {
            if (!group.id || progressByGroup.has(group.id)) throw new AttributeViewPageError();
            progressByGroup.set(group.id, firstProgress(group.view));
        }
        for (let round = 0; round < MAX_PAGES; round += 1) {
            const groupPaging: Record<string, {page: number; pageSize: number;}> = {};
            const requested = new Set<string>();
            for (const [id, progress] of progressByGroup) {
                if (!progress.done) {
                    if (progress.page >= MAX_PAGES) throw new AttributeViewTruncatedError();
                    progress.page += 1;
                    groupPaging[id] = {page: progress.page, pageSize: PAGE_SIZE};
                    requested.add(id);
                }
            }
            if (!requested.size) return true;
            if (!shouldContinue()) {
                return false;
            }
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
            const next = groupSnapshots(view);
            const returned = new Set<string>();
            for (const group of next) {
                const progress = progressByGroup.get(group.id);
                if (!progress || returned.has(group.id)) throw new AttributeViewPageError();
                returned.add(group.id);
                const value = group.view.rowCount ?? group.view.cardCount;
                if (progress.total !== undefined && Number(value) !== progress.total) {
                    throw new AttributeViewPageError();
                }
                if (requested.has(group.id)) observePage(group.view, progress);
            }
            if (returned.size !== progressByGroup.size) throw new AttributeViewPageError();
            absorbRows(target, view, viewName, true);
        }
        throw new AttributeViewTruncatedError();
    }

    const progress = firstProgress(firstView);
    const pageCount = Number(firstView.pageCount ?? 0) || 0;
    while (!progress.done) {
        if (progress.page >= MAX_PAGES) throw new AttributeViewTruncatedError();
        if (pageCount > 0 && progress.page >= pageCount) throw new AttributeViewPageError();
        if (!shouldContinue()) {
            return false;
        }
        progress.page += 1;
        const data = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
            id: avId,
            blockID: blockId,
            viewID: viewId,
            page: progress.page,
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
        observePage(view, progress);
        absorbRows(target, view, viewName, true);
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
    for (const key of cacheKeysByCarrier.get(prefix) ?? []) {
        if (!key.startsWith(`${prefix}${ref.updated}:`)) {
            dropAvCache(key);
        }
    }
    const key = cacheKey(ref, viewId);
    dropAvCache(key);
    cache.set(key, units);
    const keys = cacheKeysByCarrier.get(prefix) ?? new Set<string>();
    keys.add(key);
    cacheKeysByCarrier.set(prefix, keys);
    if (!pinnedAvKeys.has(key)) unpinnedAvKeys.set(key, true);
    const bytes = avUnitsBytes(units);
    cachedBytes.set(key, bytes);
    retainedBytes += bytes;
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
            for (const unit of cached) units.push(unit);
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
    const revision = cacheRevision;
    const load = {refs, invalidated: false};
    activeLoads.add(load);
    const canContinue = () =>
        shouldContinue() && signal?.aborted !== true && revision === cacheRevision && !load.invalidated;
    const units: Array<SearchableUnit & {snippet?: string;}> = [];
    const failedBlockIds: string[] = [];
    const truncatedBlockIds: string[] = [];
    try {
        for (const ref of refs) {
            try {
                if (!canContinue()) {
                    return units;
                }
                const viewId = selectedViewId(ref, viewIds);
                const key = cacheKey(ref, viewId);
                const cached = cache.get(key);
                if (cached) {
                    touchAvCache(key);
                    for (const unit of cached) units.push(unit);
                    continue;
                }
                const built = await consumeAvCarrier(ref, viewId, canContinue, signal);
                if (!canContinue()) {
                    return units;
                }
                if (!built) return units;
                for (const unit of built) units.push(unit);
            } catch (error) {
                if (!canContinue()) return units;
                // 一个失败数据库不能阻止其后的独立载体完成；成功缓存仍可供重试复用。
                failedBlockIds.push(ref.blockId);
                if (error instanceof AttributeViewTruncatedError) truncatedBlockIds.push(ref.blockId);
            }
        }
        if (failedBlockIds.length) throw new AttributeViewLoadError(failedBlockIds, truncatedBlockIds);
        return units;
    } finally {
        activeLoads.delete(load);
    }
}

/** 工作集可不同，但同载体、同版本、同视图的分页只执行一次。 */
async function consumeAvCarrier(
    ref: AvBlockRef,
    viewId: string,
    current: () => boolean,
    signal?: AbortSignal,
): Promise<SearchableUnit[] | null> {
    const key = cacheKey(ref, viewId);
    let flight = carrierFlights.get(key);
    if (flight && !Array.from(flight.consumers).some((consumer) => consumer())) {
        carrierFlights.delete(key);
        flight.controller.abort();
        flight = undefined;
    }
    if (!flight) {
        const revision = cacheRevision;
        flight = {ref: {...ref}, controller: new AbortController(), consumers: new Set(), task: Promise.resolve(null)};
        const created = flight;
        const canContinue = () =>
            !created.controller.signal.aborted && revision === cacheRevision &&
            carrierFlights.get(key) === created && Array.from(created.consumers).some((consumer) => consumer());
        carrierFlights.set(key, created);
        // 微任务启动，让首个消费者先登记，避免尚无人认领时误判为取消。
        created.task = Promise.resolve().then(() =>
            loadAvCarrier(created.ref, viewId, canContinue, created.controller.signal)
        )
            .finally(() => {
                if (carrierFlights.get(key) === created) carrierFlights.delete(key);
            });
    }
    const owned = flight;
    // 每次调用拥有独立身份，即使调用方传入了同一个回调，也不能互相释放。
    const consumer = () => current();
    owned.consumers.add(consumer);
    let cancel: (() => void) | undefined;
    const release = () => {
        owned.consumers.delete(consumer);
        if (!Array.from(owned.consumers).some((item) => item())) {
            if (carrierFlights.get(key) === owned) carrierFlights.delete(key);
            owned.controller.abort();
        }
    };
    const cancelled = new Promise<null>((resolve) => {
        cancel = () => {
            release();
            resolve(null);
        };
        signal?.addEventListener("abort", cancel, {once: true});
        if (signal?.aborted) cancel();
    });
    try {
        return await Promise.race([owned.task, cancelled]);
    } finally {
        if (cancel) signal?.removeEventListener("abort", cancel);
        release();
    }
}

async function loadAvCarrier(
    ref: AvBlockRef,
    viewId: string,
    canContinue: () => boolean,
    signal: AbortSignal,
): Promise<SearchableUnit[] | null> {
    if (!canContinue()) return null;
    const cells = new Map<string, AvCell>();
    const raw = await postJson<unknown>("/api/av/getAttributeView", {id: ref.avId}, signal);
    if (!canContinue()) return null;
    if (raw === null) throw new Error("getAttributeView failed");
    const info = absorbRaw(new Map(), raw);
    const drafts: AvUnitDraft[] = [];
    if (info.name) drafts.push({unitId: "av-title", text: info.name, snippet: info.name});
    const views = viewId ? info.views.filter((view) => view.id === viewId) : info.views.slice(0, 1);
    // 与内核一致：过期 viewID 回退首个视图，不能把全部视图重新纳入搜索。
    if (viewId && !views.length && info.views[0]) views.push(info.views[0]);
    for (const view of views) {
        if (view.name) drafts.push({unitId: `av-view:${view.id}`, text: view.name, snippet: view.name});
        if (!await renderView(ref.avId, ref.blockId, view.id, view.name, cells, canContinue, signal)) return null;
    }
    if (!views.length && !await renderView(ref.avId, ref.blockId, "", info.name, cells, canContinue, signal)) {
        return null;
    }
    for (const [key, cell] of cells) drafts.push({unitId: `av:${key}`, text: cell.text, snippet: cell.snippet});
    const built = toUnits(ref.blockId, drafts);
    if (!canContinue()) return null;
    replaceCachedUnits(ref, viewId, built);
    return built;
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
        let complete = true;
        const rowsById = new Map(rows.map((row) => [row.id, row]));
        for (const id of missing) {
            const avId = readAvId(String(doms[id] ?? ""));
            if (!avId) {
                complete = false;
                continue;
            }
            const row = rowsById.get(id);
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
        return {refs, cacheable: complete};
    } catch {
        return {refs, cacheable: false};
    }
}
