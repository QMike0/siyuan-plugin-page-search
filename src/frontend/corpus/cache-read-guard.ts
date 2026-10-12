/** 只跟踪在途读取；不为已关闭文档永久保留 epoch 条目。 */
export class CacheReadGuards {
    private readonly reads = new Map<string, Set<{valid: boolean;}>>();

    begin(rootId: string): {current: () => boolean; release: () => void;} {
        const state = {valid: true};
        const readers = this.reads.get(rootId) ?? new Set<{valid: boolean;}>();
        readers.add(state);
        this.reads.set(rootId, readers);
        return {
            current: () => state.valid,
            release: () => {
                readers.delete(state);
                if (!readers.size) this.reads.delete(rootId);
            },
        };
    }

    invalidate(rootId?: string): void {
        if (rootId) {
            for (const state of this.reads.get(rootId) ?? []) state.valid = false;
        } else {
            for (const readers of this.reads.values()) for (const state of readers) state.valid = false;
        }
    }
}
