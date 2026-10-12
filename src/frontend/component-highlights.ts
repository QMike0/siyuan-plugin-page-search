/**
 * CSS Highlight 注册表属于整个 Document，不属于 Protyle。
 * 每个搜索组件使用独立键，同页同时显示即是各组件高亮的并集；更新一个组件
 * 无须复制或重建其它窗格的 Range 集合，也不会在关闭时误删其它组件。
 */
const session = Math.random().toString(36).slice(2);
let serial = 0;

export class ComponentHighlights {
    readonly resultsName = `page-search-results-${session}-${++serial}`;
    readonly focusName = `page-search-focus-${session}-${serial}`;
    private style: HTMLStyleElement | null = null;
    private disposed = false;

    constructor(private readonly document: Document) {}

    private registry(): any {
        return ((this.document.defaultView as any)?.CSS ?? (globalThis as any).CSS)?.highlights;
    }

    private ensureStyle(): void {
        if (this.style?.isConnected) return;
        this.style = this.document.createElement("style");
        this.style.textContent = `
::highlight(${this.resultsName}) { background-color: rgb(235 235 5); color: rgb(0, 0, 0); }
::highlight(${this.focusName}) { background-color: rgb(255, 150, 50); color: rgb(0, 0, 0); }`;
        this.document.head.appendChild(this.style);
    }

    setResults(highlight: any | null): void {
        this.set(this.resultsName, highlight);
    }

    setFocus(highlight: any | null): void {
        this.set(this.focusName, highlight);
    }

    private set(name: string, highlight: any | null): void {
        if (this.disposed) return;
        const registry = this.registry();
        if (!registry) return;
        if (!highlight) registry.delete(name);
        else {
            this.ensureStyle();
            registry.set(name, highlight);
        }
    }

    appendResult(range: Range): boolean {
        const highlight = this.registry()?.get(this.resultsName);
        if (this.disposed || !highlight || typeof highlight.add !== "function") return false;
        try {
            highlight.add(range);
            return true;
        } catch {
            return false;
        }
    }

    clear(): void {
        const registry = this.registry();
        registry?.delete(this.resultsName);
        registry?.delete(this.focusName);
    }

    dispose(): void {
        this.clear();
        this.style?.remove();
        this.style = null;
        this.disposed = true;
    }
}
