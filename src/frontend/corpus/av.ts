import type {SearchableUnit} from "../../shared";
import {avCellUnitId} from "../../shared/av-live";
import {attributeViewHtmlTexts} from "../blocks";
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
    /** Native AV search is transient DOM state, not a persisted field filter. */
    query?: string;
}

interface AvCell {
    text: string;
    snippet: string;
    texts?: string[];
}

interface AvUnitDraft {
    unitId: string;
    text: string;
    snippet?: string;
}

const cache = new Map<string, SearchableUnit[]>();
/** Actual view after the kernel's default/stale-ID fallback; dies with its cached array. */
const resolvedViews = new WeakMap<SearchableUnit[], string>();
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

export function readAvSearchQuery(element: HTMLElement): string | undefined {
    return element.querySelector('[data-type="av-search"]')?.textContent?.trim();
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

interface AvColumnInfo {
    name: string;
    hidden: boolean;
    type: string;
    dateFormat: string;
    renderTemplate: string;
    cardCheckboxName?: string;
}

function columnInfo(view: Record<string, unknown>): Map<string, AvColumnInfo> {
    const names = new Map<string, AvColumnInfo>();
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
        if (id) {
            names.set(id, {
                name,
                hidden: record.hidden === true,
                type: String(record.type ?? ""),
                dateFormat: String(record.dateFormat ?? ""),
                renderTemplate: String(record.renderTemplate ?? ""),
                cardCheckboxName: ["gallery", "kanban"].includes(String(view.type)) && view.displayFieldName !== true ?
                    name || avLanguageValue("languages.checkbox") : undefined,
            });
        }
    }
    return names;
}

function avLanguageValue(path: string): string {
    let current: unknown = (globalThis as {siyuan?: unknown}).siyuan;
    for (const part of path.split(".")) {
        if (!current || typeof current !== "object") return "";
        current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : "";
}

function padDatePart(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/** 与思源 render/av/dateFormat.ts 保持相同的本地时区显示规则。 */
function formatAvDate(content: unknown, format: string, isNotTime: boolean): string {
    const timestamp = Number(content);
    if (!Number.isFinite(timestamp)) return "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return "";
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    let result: string;
    if (format === "full") {
        const template = avLanguageValue("languages._attrView.dateFormatFullTemplate");
        const months = avLanguageValue("languages._attrView.dateMonths").split("|");
        const monthName = months[month - 1] || date.toLocaleString(undefined, {month: "long"});
        result = (template || "${year}-${month}-${day}")
            .split("${year}").join(String(year))
            .split("${month}").join(monthName)
            .split("${day}").join(String(day));
    } else if (format === "month-day-year") {
        result = `${padDatePart(month)}/${padDatePart(day)}/${year}`;
    } else if (format === "day-month-year") {
        result = `${padDatePart(day)}/${padDatePart(month)}/${year}`;
    } else if (format === "year-month-day") {
        result = `${year}/${padDatePart(month)}/${padDatePart(day)}`;
    } else {
        result = `${year}-${padDatePart(month)}-${padDatePart(day)}`;
    }
    if (!isNotTime) {
        result += ` ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
    }
    return result;
}

/** cellValue.ts hasAVRenderTemplateResult; an empty rendered result must not expose raw data. */
function templateContent(value: Record<string, unknown>, column?: AvColumnInfo): string | undefined {
    if (value.type === "template") return String(asRecord(value.template)?.content ?? "");
    if (value.hasRenderTemplate || typeof value.renderedContent === "string" || column?.renderTemplate.trim()) {
        return String(value.renderedContent ?? "");
    }
    return undefined;
}

/** SiYuan imageURL.ts: HEIF is displayed as text unless the internal preview can serve it. */
function avAssetIsImage(path: string): boolean {
    let decoded = path.trim().split(/[?#]/, 1)[0].toLowerCase();
    try { decoded = decodeURIComponent(decoded).toLowerCase(); } catch { /* Native keeps an invalid URL undecoded. */ }
    if (!/\.(heic|heif)$/.test(decoded)) return true;
    try {
        const origin = typeof location === "undefined" ? "http://siyuan.invalid" : location.origin;
        const base = new URL(origin);
        const source = path.trim();
        if (/^file:/i.test(source) || /^[a-z]:[\\/]/i.test(source) || source.startsWith("\\\\")) return false;
        const url = new URL(source, base.origin + "/");
        return ["http:", "https:"].includes(base.protocol) && url.origin === base.origin &&
            decodeURIComponent(url.pathname).startsWith("/assets/") &&
            !url.searchParams.getAll("download").some(value => value.toLowerCase() === "true");
    } catch { return false; }
}

function escapeAvText(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Only types with HTML/gaps need an inert DOM parse; ordinary fields stay on the string path. */
function displayValueHtml(value: Record<string, unknown>, column?: AvColumnInfo): string | undefined {
    const template = templateContent(value, column);
    if (template !== undefined) return `<span class="av__celltext--template">${template}</span>`;
    if (value.type === "mAsset") {
        if (!Array.isArray(value.mAsset) || !value.mAsset.some(item => {
            const asset = asRecord(item);
            return asset?.type === "image" && avAssetIsImage(String(asset.content ?? ""));
        })) return undefined;
        return Array.isArray(value.mAsset) ? value.mAsset.map(item => {
            const asset = asRecord(item);
            if (!asset) return "";
            if (asset.type === "image" && avAssetIsImage(String(asset.content ?? ""))) return "<img>";
            return `<span class="b3-chip">${escapeAvText(String(asset.name || asset.content || ""))}</span>`;
        }).join("") : "";
    }
    if (value.type === "relation") {
        const items = asRecord(value.relation)?.contents;
        if (!Array.isArray(items) || !items.some(item => {
            const record = asRecord(item);
            return record?.block && templateContent(record) !== undefined;
        })) return undefined;
        return Array.isArray(items) ? items.map(item => {
            const record = asRecord(item);
            if (!record?.block) return "";
            const template = templateContent(record);
            const html = template ?? escapeAvText(String(asRecord(record.block)?.content || avLanguageValue("languages.untitled")));
            return `<span class="av__cell--relation"><span class="av__celltext">${html}</span></span>`;
        }).join("") : "";
    }
    if (value.type === "rollup") {
        const items = asRecord(value.rollup)?.contents;
        if (!Array.isArray(items)) return "";
        if (!items.some(item => ["template", "select", "mSelect", "mAsset", "relation"].includes(String(asRecord(item)?.type)))) {
            return undefined;
        }
        let html = "";
        let lastType = "";
        for (const item of items) {
            const record = asRecord(item);
            if (!record) continue;
            lastType = String(record.type);
            const nestedCell = ["template", "select", "mSelect", "mAsset", "relation"].includes(lastType);
            const piece = lastType === "checkbox" ? "<svg></svg><span class=\"fn__space\"></span>" :
                nestedCell ? displayValueHtml(record) ?? escapeAvText(displayValueText(record)) :
                escapeAvText(displayValueText(record, undefined, true));
            if (piece) html += piece + (lastType === "checkbox" ? "" : ", ");
        }
        if (lastType === "checkbox") return `<div class="fn__flex">${html}</div>`;
        return html.endsWith(", ") ? html.slice(0, -2) : html;
    }
    return undefined;
}

function displayValueText(value: Record<string, unknown>, column?: AvColumnInfo, rollup = false): string {
    const type = String(value.type ?? column?.type ?? "");
    if (["text", "block", "url", "email", "phone"].includes(type)) {
        const content = asRecord(value[type])?.content;
        return String(content || (type === "block" && rollup ? avLanguageValue("languages.untitled") : ""));
    }
    if (type === "select" || type === "mSelect") {
        const items = Array.isArray(value.mSelect) ? value.mSelect : [];
        return (type === "select" ? items.slice(0, 1) : items).map(item => String(asRecord(item)?.content ?? "")).join("");
    }
    if (type === "mAsset") {
        return Array.isArray(value.mAsset) ? value.mAsset.map(item => {
            const asset = asRecord(item);
            return String(asset?.name || asset?.content || "");
        }).join("") : "";
    }
    if (type === "relation") {
        const items = asRecord(value.relation)?.contents;
        return Array.isArray(items) ? items.map(item => {
            const record = asRecord(item);
            return record?.block ? String(asRecord(record.block)?.content || avLanguageValue("languages.untitled")) : "";
        }).join("") : "";
    }
    if (type === "rollup") {
        const items = asRecord(value.rollup)?.contents;
        if (!Array.isArray(items)) return "";
        let text = "";
        let lastType = "";
        for (const item of items) {
            const record = asRecord(item);
            if (!record) continue;
            lastType = String(record.type);
            const piece = displayValueText(record, undefined, true);
            if (piece) text += piece + ", ";
        }
        return lastType !== "checkbox" && text.endsWith(", ") ? text.slice(0, -2) : text;
    }
    if (type === "checkbox") return column?.cardCheckboxName ?? "";
    if (type === "number") {
        const number = asRecord(value.number);
        if (!number) return "";
        return String(number.formattedContent || (rollup ? number.content?.toString() : number.content) || "");
    }
    if (rollup && ["date", "created", "updated"].includes(type)) {
        const date = asRecord(value[type]);
        if (!date) return "";
        if (date.formattedContent) return String(date.formattedContent);
        // Native renderRollup replaces the first date with the end date when a range is present.
        if (!date.isNotEmpty) return "";
        return formatAvDate(date.hasEndDate && date.isNotEmpty2 ? date.content2 : date.content, "", date.isNotTime !== false);
    }
    if (type === "date") {
        const date = asRecord(value.date);
        if (!date?.isNotEmpty) return "";
        const text = formatAvDate(date.content, column?.dateFormat ?? "", date.isNotTime !== false);
        const end = date.hasEndDate && date.isNotEmpty2 ?
            formatAvDate(date.content2, column?.dateFormat ?? "", date.isNotTime !== false) : "";
        return text + end;
    }
    if (type === "created" || type === "updated") {
        const date = asRecord(value[type]);
        if (!date?.isNotEmpty) return "";
        if (date.formattedContent) return String(date.formattedContent);
        if (!date.content) return "";
        const text = formatAvDate(date.content, column?.dateFormat ?? "", date.isNotTime !== false);
        const end = date.hasEndDate && date.isNotEmpty2 && date.content2 ?
            ` → ${formatAvDate(date.content2, column?.dateFormat ?? "", date.isNotTime !== false)}` : "";
        return text + end;
    }
    return textOf(value);
}

function cellDisplay(
    cell: unknown,
    rowId: string,
    viewName: string,
    columns: ReturnType<typeof columnInfo>,
): {itemId: string; keyId: string; cell: AvCell;} | null {
    const record = asRecord(cell);
    if (!record) {
        return null;
    }
    const value = asRecord(record.value) ?? record;
    const itemId = String(record.itemID ?? record.blockID ?? value.blockID ?? value.id ?? rowId);
    const keyId = String(value.keyID ?? record.keyID ?? record.fieldID ?? "");
    // The kernel returns values for hidden fields too. Respect the selected
    // view's flags before extracting/retaining any of their text.
    const column = columns.get(keyId);
    if (column?.hidden) return null;
    const html = displayValueHtml(value, column);
    const texts = html === undefined ? undefined : attributeViewHtmlTexts(html);
    const text = texts ? texts.join("") : displayValueText(value, column);
    if (!itemId || !keyId || !text) {
        return null;
    }
    const columnName = column?.name ?? "";
    const snippet = [viewName, columnName, text].filter(Boolean).join(" · ");
    return {itemId, keyId, cell: {text, snippet, texts}};
}

function rowList(view: Record<string, unknown>): unknown[] {
    const rows = view.rows ?? view.cards;
    return Array.isArray(rows) ? rows : [];
}

function absorbRows(
    target: Map<string, AvCell>,
    view: Record<string, unknown>,
    viewName: string,
    columns: ReturnType<typeof columnInfo>,
    groupId = "nogroup",
): void {
    const put = (cell: unknown, rowId: string) => {
        const parsed = cellDisplay(cell, rowId, viewName, columns);
        if (!parsed) {
            return;
        }
        target.set(avCellUnitId(parsed.itemId, parsed.keyId, groupId), parsed.cell);
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

/** SiYuan getGroupTitleHTML: select chips have no intervening spaces;
 * checkbox groups render only an icon, all other types use the native name. */
function groupNameText(group: Record<string, unknown>): string {
    const value = asRecord(group.groupValue);
    if (value?.type === "checkbox") return "";
    if (value?.type === "select" || value?.type === "mSelect") {
        return Array.isArray(value.mSelect) ? value.mSelect.map(item => {
            const content = asRecord(item)?.content;
            return typeof content === "string" ? content : "";
        }).join("") : "";
    }
    return typeof group.name === "string" ? group.name : "";
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
    query: string,
    target: Map<string, AvCell>,
    shouldContinue: () => boolean,
    signal?: AbortSignal,
): Promise<{hideAttrViewName: boolean;} | null> {
    if (!shouldContinue()) {
        return null;
    }
    const first = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
        id: avId,
        blockID: blockId,
        viewID: viewId,
        page: 1,
        pageSize: PAGE_SIZE,
        query,
        groupPaging: {},
        createIfNotExist: false,
    }, signal);
    if (!shouldContinue()) {
        return null;
    }
    if (first === null) {
        throw new Error("renderAttributeView failed");
    }
    const firstView = asRecord(first?.view);
    if (!firstView) {
        throw new AttributeViewPageError();
    }
    const visibility = {hideAttrViewName: firstView.hideAttrViewName === true};
    const columns = columnInfo(firstView);
    const groups = groupSnapshots(firstView);
    if (groups.length > 0) {
        const progressByGroup = new Map<string, PageProgress>();
        const cellsByGroup = new Map<string, Map<string, AvCell>>();
        for (const group of groups) {
            // Native rendering omits hidden groups entirely. Folded groups are
            // separate: their rows still belong to the searchable view.
            if (group.view.groupHidden !== undefined && group.view.groupHidden !== 0) continue;
            if (!group.id || progressByGroup.has(group.id)) throw new AttributeViewPageError();
            progressByGroup.set(group.id, firstProgress(group.view));
            const cells = new Map<string, AvCell>();
            const name = groupNameText(group.view);
            if (name) cells.set(`group-title:${group.id}`, {text: name, snippet: name});
            // Native responses omit group columns/fields; metadata lives on the parent view.
            absorbRows(cells, group.view, viewName, columns, group.id);
            cellsByGroup.set(group.id, cells);
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
            if (!requested.size) {
                // Flatten only after pagination so later pages of g1 precede g2.
                for (const cells of cellsByGroup.values()) {
                    for (const [key, cell] of cells) target.set(key, cell);
                    cells.clear();
                }
                return visibility;
            }
            if (!shouldContinue()) {
                return null;
            }
            const data = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
                id: avId,
                blockID: blockId,
                viewID: viewId,
                page: 1,
                pageSize: PAGE_SIZE,
                query,
                groupPaging,
                createIfNotExist: false,
            }, signal);
            if (!shouldContinue()) {
                return null;
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
                if (group.view.groupHidden !== undefined && group.view.groupHidden !== 0) continue;
                const progress = progressByGroup.get(group.id);
                if (!progress || returned.has(group.id)) throw new AttributeViewPageError();
                returned.add(group.id);
                const value = group.view.rowCount ?? group.view.cardCount;
                if (progress.total !== undefined && Number(value) !== progress.total) {
                    throw new AttributeViewPageError();
                }
                if (requested.has(group.id)) {
                    observePage(group.view, progress);
                    absorbRows(cellsByGroup.get(group.id)!, group.view, viewName, columns, group.id);
                }
            }
            if (returned.size !== progressByGroup.size) throw new AttributeViewPageError();
        }
        throw new AttributeViewTruncatedError();
    }

    absorbRows(target, firstView, viewName, columns);
    const progress = firstProgress(firstView);
    const pageCount = Number(firstView.pageCount ?? 0) || 0;
    while (!progress.done) {
        if (progress.page >= MAX_PAGES) throw new AttributeViewTruncatedError();
        if (pageCount > 0 && progress.page >= pageCount) throw new AttributeViewPageError();
        if (!shouldContinue()) {
            return null;
        }
        progress.page += 1;
        const data = await postJson<Record<string, unknown>>("/api/av/renderAttributeView", {
            id: avId,
            blockID: blockId,
            viewID: viewId,
            page: progress.page,
            pageSize: PAGE_SIZE,
            query,
            groupPaging: {},
            createIfNotExist: false,
        }, signal);
        if (!shouldContinue()) {
            return null;
        }
        if (data === null) {
            throw new Error("renderAttributeView page failed");
        }
        const view = asRecord(data?.view);
        if (!view) {
            throw new AttributeViewPageError();
        }
        observePage(view, progress);
        absorbRows(target, view, viewName, columns);
    }
    return visibility;
}

function avInfo(data: unknown): {name: string; views: Array<{id: string; name: string;}>;} {
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
    return `${ref.blockId}:${ref.avId}:${ref.updated}:${viewId ? `view:${viewId}` : "default"}:query:${JSON.stringify(ref.query ?? "")}`;
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
    const bytes = avUnitsBytes(units) + key.length * 2;
    cachedBytes.set(key, bytes);
    retainedBytes += bytes;
    trimAvCache();
}

export function peekAvUnits(
    refs: AvBlockRef[],
    viewIds: ReadonlyMap<string, string> = new Map(),
): {units: Array<SearchableUnit & {snippet?: string;}>; missing: AvBlockRef[]; resolvedViewIds: Map<string, string>;} {
    const units: Array<SearchableUnit & {snippet?: string;}> = [];
    const missing: AvBlockRef[] = [];
    const resolvedViewIds = new Map<string, string>();
    for (const ref of refs) {
        const cached = cache.get(cacheKey(ref, selectedViewId(ref, viewIds)));
        if (cached) {
            resolvedViewIds.set(ref.blockId, resolvedViews.get(cached) ?? ref.carrierViewId);
            touchAvCache(cacheKey(ref, selectedViewId(ref, viewIds)));
            for (const unit of cached) units.push(unit);
        } else {
            missing.push(ref);
        }
    }
    return {units, missing, resolvedViewIds};
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
    // Raw keyValues contain every field and are not used for search. Read only
    // metadata here; searchable text comes from the selected rendered view.
    const info = avInfo(raw);
    const drafts: AvUnitDraft[] = [];
    // 与内核一致：过期 viewID 回退首个视图，不能把全部视图重新纳入搜索。
    const view = info.views.find((item) => item.id === viewId) ?? info.views[0];
    const visibility = await renderView(
        ref.avId,
        ref.blockId,
        view?.id ?? "",
        view?.name ?? info.name,
        ref.query ?? "",
        cells,
        canContinue,
        signal,
    );
    if (!visibility) return null;
    if (info.name && !visibility.hideAttrViewName) {
        drafts.push({unitId: "av-title", text: info.name, snippet: info.name});
    }
    if (view?.name) drafts.push({unitId: `av-view:${view.id}`, text: view.name, snippet: view.name});
    for (const [key, cell] of cells) {
        if (cell.texts && cell.texts.length > 1) {
            cell.texts.forEach((text, index) => drafts.push({unitId: `${key}#run-${index}`, text, snippet: cell.snippet}));
        } else drafts.push({unitId: key, text: cell.text, snippet: cell.snippet});
    }
    const built = toUnits(ref.blockId, drafts);
    if (!canContinue()) return null;
    resolvedViews.set(built, view?.id ?? "");
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
