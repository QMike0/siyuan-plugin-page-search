/**
 * 一个搜索栏会跟随同一编辑窗的页签复用。只保存每篇文档的计数快照，
 * 不保存 SearchMatch / Range，后两者会在 Protyle 切换或重渲染后失效。
 */
export interface DocumentSearchIndexSnapshot {
    index: number;
    count: number;
}

export class DocumentSearchIndexMemory {
    private activeRootId: string;
    private pendingRootId = "";
    private readonly snapshots = new Map<string, DocumentSearchIndexSnapshot>();

    constructor(rootId = "") {
        this.activeRootId = rootId;
    }

    get activeRoot(): string {
        return this.activeRootId;
    }

    /**
     * 保存离开文档的序号，并标记进入文档需要在下一次完整匹配后恢复。
     * @returns 是否真的切换了文档
     */
    activate(
        rootId: string,
        currentIndex: number,
        currentCount: number,
        currentResultConfirmed = true,
    ): boolean {
        if (!rootId || rootId === this.activeRootId) {
            return false;
        }
        // 切回一篇已访问文档后，界面会先借用它的旧快照显示序号，真实命中
        // 尚未重建。这时 resultIndex/resultCount 是临时的 0/0，绝不能写回该文档；
        // 否则快速连续切换会把原先保存的第 x 项覆盖掉。
        if (this.activeRootId && currentResultConfirmed) {
            this.snapshots.set(this.activeRootId, normalizeSnapshot(currentIndex, currentCount));
        }
        this.activeRootId = rootId;
        this.pendingRootId = rootId;
        return true;
    }

    /** 当前文档的已确认序号；仅在本轮结果已被接受后写入。 */
    remember(index: number, count: number): void {
        if (this.activeRootId) {
            this.snapshots.set(this.activeRootId, normalizeSnapshot(index, count));
        }
    }

    /** 用于匹配尚未完成时保持计数标签稳定；不能用于导航或替换。 */
    pendingSnapshot(rootId: string): DocumentSearchIndexSnapshot | null {
        if (!rootId || rootId !== this.pendingRootId) {
            return null;
        }
        return this.snapshots.get(rootId) ?? {index: 0, count: 0};
    }

    /**
     * 只消费一次切换时保存的序号。未访问过的文档以 0 开始。
     * 返回 null 表示这不是一次文档切换后的首次结果。
     */
    consumePending(rootId: string): DocumentSearchIndexSnapshot | null {
        if (!rootId || rootId !== this.pendingRootId) {
            return null;
        }
        this.pendingRootId = "";
        return this.snapshots.get(rootId) ?? {index: 0, count: 0};
    }

    /** 换关键词或匹配语义后，所有文档的旧序号都不再适用。 */
    clear(): void {
        this.snapshots.clear();
        this.pendingRootId = "";
    }
}

function normalizeSnapshot(index: number, count: number): DocumentSearchIndexSnapshot {
    const normalizedCount = normalizeCount(count);
    return {
        index: Math.min(normalizedCount, normalizeCount(index)),
        count: normalizedCount,
    };
}

function normalizeCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
