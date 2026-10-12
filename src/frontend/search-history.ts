import {effectiveSearchQuery} from "../shared/constants";

/**
 * 思源本地存储键。带 local- 前缀，避免和内置键、highlight-search 的历史撞车。
 * 数据在 data/storage/local.json，默认不参与同步。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/kernel/api/storage.go
 */
export const SEARCH_HISTORY_STORAGE_KEY = "local-page-search-history";

/** 全部文档合在一起的条数上限。超出时丢掉最旧的。 */
const MAX_SEARCH_HISTORY = 100;
/** 单条关键词上限，避免把整段粘贴写进 local.json。 */
const MAX_SEARCH_HISTORY_TERM = 2000;

export interface SearchHistoryEntry {
    docId: string;
    text: string;
}

/**
 * 只有可见 Protyle 和 SearchBar 已确认的活动文档一致时，才可把查找词归属到该文档。
 * 页签切换过渡中可见 rootId 可能为空或仍指向前一篇；此时宁可稍后重试，也不能
 * 退回到 lastRootId 后读取/写入另一篇文档的历史。
 */
export function stableSearchHistoryDocId(visibleRootId: string, activeRootId: string): string {
    return visibleRootId && visibleRootId === activeRootId ? visibleRootId : "";
}

export interface SearchHistoryIo {
    /** 读内核里该键的值。失败时调用方应保持内存中的列表。 */
    read(apply: (value: unknown) => void): void;
    write(entries: readonly SearchHistoryEntry[]): void;
    remove(): void;
}

/**
 * 按文档记查找词。内存列表供方向键立即使用；写入走思源 localStorage，
 * 并且不经过 prefs.json，因此不会改掉「关掉再开只恢复输入框」的行为。
 */
export class SearchHistoryStore {
    private entries: SearchHistoryEntry[] = [];
    /** 本地 push 之后，忽略还在路上的旧读取结果。 */
    private epoch = 0;

    constructor(private readonly io: SearchHistoryIo = defaultSearchHistoryIo) {}

    load(): void {
        const cached = readWindowStorage();
        if (cached.length > 0) {
            this.entries = cached;
        }
        const epoch = this.epoch;
        try {
            this.io.read((value) => {
                if (epoch !== this.epoch || value == null) {
                    return;
                }
                this.entries = normalizeSearchHistory(value);
            });
        } catch (error) {
            console.warn("[page-search] load search history failed", error);
        }
    }

    /** 某文档下的关键词，旧在前、新在后。 */
    getForDoc(docId: string): string[] {
        if (!docId) {
            return [];
        }
        const texts: string[] = [];
        for (const entry of this.entries) {
            if (entry.docId === docId) {
                texts.push(entry.text);
            }
        }
        return texts;
    }

    /**
     * 记下一次查找。同一文档的相同词若已是该文档最新一条，则不写盘。
     * 否则把旧位置挪到末尾。
     */
    push(docId: string, text: string): void {
        if (!isRecordableQuery(docId, text)) {
            return;
        }
        let lastForDoc = -1;
        let existing = -1;
        for (let index = 0; index < this.entries.length; index += 1) {
            const entry = this.entries[index];
            if (entry.docId !== docId) {
                continue;
            }
            lastForDoc = index;
            if (entry.text === text) {
                existing = index;
            }
        }
        if (existing >= 0 && existing === lastForDoc) {
            return;
        }
        this.epoch += 1;
        if (existing >= 0) {
            this.entries.splice(existing, 1);
        }
        this.entries.push({docId, text});
        if (this.entries.length > MAX_SEARCH_HISTORY) {
            this.entries.splice(0, this.entries.length - MAX_SEARCH_HISTORY);
        }
        this.write();
    }

    /** 其它窗口写入同一键时合并过来。本窗口自己的写入已被内核排除。 */
    acceptBroadcast(detail: unknown): void {
        if (!detail || typeof detail !== "object") {
            return;
        }
        const payload = detail as {cmd?: string; data?: {key?: string; val?: unknown;};};
        if (payload.cmd !== "setLocalStorageVal" || payload.data?.key !== SEARCH_HISTORY_STORAGE_KEY) {
            return;
        }
        this.epoch += 1;
        this.entries = normalizeSearchHistory(payload.data.val);
        const storage = windowStorage();
        if (storage) {
            storage[SEARCH_HISTORY_STORAGE_KEY] = this.entries;
        }
    }

    removePersisted(): void {
        this.epoch += 1;
        this.entries = [];
        const storage = windowStorage();
        if (storage && SEARCH_HISTORY_STORAGE_KEY in storage) {
            delete storage[SEARCH_HISTORY_STORAGE_KEY];
        }
        try {
            this.io.remove();
        } catch (error) {
            console.warn("[page-search] remove search history failed", error);
        }
    }

    private write(): void {
        if (isStorageReadonly()) {
            return;
        }
        const snapshot = this.entries.map((entry) => ({docId: entry.docId, text: entry.text}));
        const storage = windowStorage();
        if (storage) {
            storage[SEARCH_HISTORY_STORAGE_KEY] = snapshot;
        }
        try {
            this.io.write(snapshot);
        } catch (error) {
            console.warn("[page-search] save search history failed", error);
        }
    }
}

export function normalizeSearchHistory(data: unknown): SearchHistoryEntry[] {
    if (!Array.isArray(data)) {
        return [];
    }
    const entries: SearchHistoryEntry[] = [];
    for (const item of data) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const entry = item as {docId?: unknown; text?: unknown;};
        if (typeof entry.docId !== "string" || typeof entry.text !== "string") {
            continue;
        }
        if (!isRecordableQuery(entry.docId, entry.text)) {
            continue;
        }
        entries.push({docId: entry.docId, text: entry.text});
    }
    if (entries.length > MAX_SEARCH_HISTORY) {
        return entries.slice(entries.length - MAX_SEARCH_HISTORY);
    }
    return entries;
}

function isRecordableQuery(docId: string, text: string): boolean {
    return Boolean(
        docId &&
            text &&
            text.length <= MAX_SEARCH_HISTORY_TERM &&
            effectiveSearchQuery(text),
    );
}

function windowStorage(): Record<string, unknown> | null {
    if (typeof window === "undefined") {
        return null;
    }
    const storage = (window as unknown as {siyuan?: {storage?: Record<string, unknown>;};}).siyuan?.storage;
    return storage && typeof storage === "object" ? storage : null;
}

function readWindowStorage(): SearchHistoryEntry[] {
    return normalizeSearchHistory(windowStorage()?.[SEARCH_HISTORY_STORAGE_KEY]);
}

function isStorageReadonly(): boolean {
    if (typeof window === "undefined") {
        return false;
    }
    const siyuan = (window as unknown as {
        siyuan?: {isPublish?: boolean; config?: {readonly?: boolean;};};
    }).siyuan;
    return Boolean(siyuan?.isPublish || siyuan?.config?.readonly);
}

const noopSearchHistoryIo: SearchHistoryIo = {
    read: () => undefined,
    write: () => undefined,
    remove: () => undefined,
};

let boundSearchHistoryIo: SearchHistoryIo = noopSearchHistoryIo;

const defaultSearchHistoryIo: SearchHistoryIo = {
    read: (apply) => boundSearchHistoryIo.read(apply),
    write: (entries) => boundSearchHistoryIo.write(entries),
    remove: () => boundSearchHistoryIo.remove(),
};

/** 由插件入口接上思源 fetchPost。测试和未接内核时保持空实现。 */
export function bindSearchHistoryIo(io: SearchHistoryIo): void {
    boundSearchHistoryIo = io;
}

export const searchHistory = new SearchHistoryStore();
