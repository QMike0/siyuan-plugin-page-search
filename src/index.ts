import {getFrontend, IKernelPluginState, Plugin} from "siyuan";
import "./index.scss";
import {
    bindSearchStateListener,
    createClientId,
    isKernelRunning,
    rpcEmitSearchState,
    rpcGetPrefs,
    rpcSetPrefs,
    unbindSearchStateListener,
} from "./frontend/kernel-client";
import {SearchBar, type SearchBarHost, type SearchBarI18n} from "./frontend/search-bar";
import {isEditorReplaceModeBlocked} from "./frontend/editor-mode";
import {scrubSelectionScopePollution, clearAllSelectionScopeSessionOverlays} from "./frontend/selection-scope-visual";
import type {RestrictInlineType, SearchStateEvent} from "./shared";

export {
    findOffsetMatchesInText,
    generateSearchVariants,
    matchTextUnits,
} from "./shared";
export type {MatchHit, SearchableUnit, SearchStateEvent} from "./shared";
export {
    isKernelRunning,
    matchUnitsViaKernel,
    rpcEmitSearchState,
    rpcGetPrefs,
    rpcMatch,
    rpcSetPrefs,
} from "./frontend/kernel-client";

export const CLASS_NAME = "highlight-search-result";

export const isMobileFrontend = (): boolean => {
    const frontEnd = getFrontend();
    return frontEnd === "mobile" || frontEnd === "browser-mobile" || !!(window as any).siyuan?.mobile;
};

/**
 * 页内查找替换 — 前端插件（偏好 / 跨窗口同步 / i18n）
 */
export default class PluginPageSearch extends Plugin implements SearchBarHost {
    private isMobile = false;
    private kernelReady = false;
    private readonly clientId = createClientId();
    private searchStateHandler: ((...args: any[]) => void | Promise<void>) | null = null;

    private searchComponentCallbacks: Set<(event: CustomEvent) => void> = new Set();
    private searchBars: Map<Element, SearchBar> = new Map();
    private activeSearchComponentsCount = 0;
    private lastHighlightComponent: Element | null = null;
    private cleanupTimer: number | null = null;

    isMobileView(): boolean {
        return this.isMobile;
    }

    getClientId(): string {
        return this.clientId;
    }

    updateLastHighlightComponent(element: Element) {
        this.lastHighlightComponent = element;
    }

    isLastHighlightComponent(element: Element): boolean {
        return this.lastHighlightComponent === element;
    }

    onload() {
        this.isMobile = isMobileFrontend();
        this.kernelReady = isKernelRunning(this);

        this.addIcons(`<symbol id="iconPageSearch" viewBox="0 0 24 24">
<path fill="currentColor" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V8C21 8.55228 20.5523 9 20 9C19.4477 9 19 8.55228 19 8V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM20.1716 18.7574C20.6951 17.967 21 17.0191 21 16C21 13.2386 18.7614 11 16 11C13.2386 11 11 13.2386 11 16C11 18.7614 13.2386 21 16 21C17.0191 21 17.967 20.6951 18.7574 20.1716L21.2929 22.7071C21.6834 23.0976 22.3166 23.0976 22.7071 22.7071C23.0976 22.3166 23.0976 21.6834 22.7071 21.2929L20.1716 18.7574ZM13 16C13 14.3431 14.3431 13 16 13C17.6569 13 19 14.3431 19 16C19 17.6569 17.6569 19 16 19C14.3431 19 13 17.6569 13 16Z"/>
</symbol>`);

        const openFind = () => {
            void this.addSearchElement({intent: "find"});
        };
        const openReplace = () => {
            void this.addSearchElement({intent: "replace"});
        };
        // 思源：定义 editorCallback 等后，仅在对应焦点区域触发；callback 在其它区域作兜底。
        // 四处都挂上，避免「只有光标在编辑器里快捷键才生效」。
        this.addCommand({
            langKey: "showSearch",
            hotkey: "⌘F",
            callback: openFind,
            editorCallback: openFind,
            dockCallback: openFind,
            fileTreeCallback: openFind,
        });
        this.addCommand({
            langKey: "showReplace",
            hotkey: "⌘H",
            callback: openReplace,
            editorCallback: openReplace,
            dockCallback: openReplace,
            fileTreeCallback: openReplace,
        });

        // 只读 / 预览：焦点不在可编辑 wysiwyg，editorCallback 不触发；
        // 且存在专用 callback 时普通 callback 也不会兜底。用捕获阶段补一层。
        window.addEventListener("keydown", this.onWindowKeydownCapture, true);

        this.eventBus.on("kernel-plugin-state-change", this.onKernelPluginStateChange);
        // 清扫历史版本误写入 td/th 的选区提示 class（曾被 outerHTML 持久化进文档）
        this.eventBus.on("loaded-protyle-static", this.onProtyleLoadedScrub);
        this.bindKernelSearchState();
        scrubSelectionScopePollution();

        console.log(this.i18n.pluginOnload, {
            isMobile: this.isMobile,
            kernelReady: this.kernelReady,
            clientId: this.clientId,
        });
    }

    onLayoutReady() {
        this.addTopBar({
            icon: "iconPageSearch",
            title: this.i18n.topBarTitle,
            position: "right",
            callback: () => {
                this.closePanel();
                void this.addSearchElement({isFromTopBar: true, intent: "find"});
            },
        });
    }

    onunload() {
        window.removeEventListener("keydown", this.onWindowKeydownCapture, true);
        this.closeSearchDialog();
        this.stopCleanupTimer();
        this.eventBus.off("kernel-plugin-state-change", this.onKernelPluginStateChange);
        this.eventBus.off("loaded-protyle-static", this.onProtyleLoadedScrub);
        this.unbindKernelSearchState();
        scrubSelectionScopePollution();
        clearAllSelectionScopeSessionOverlays();
        console.log(this.i18n.pluginOnunload);
    }

    uninstall() {
        window.removeEventListener("keydown", this.onWindowKeydownCapture, true);
        this.closeSearchDialog();
        this.stopCleanupTimer();
        this.eventBus.off("kernel-plugin-state-change", this.onKernelPluginStateChange);
        this.eventBus.off("loaded-protyle-static", this.onProtyleLoadedScrub);
        this.unbindKernelSearchState();
        scrubSelectionScopePollution();
        clearAllSelectionScopeSessionOverlays();
        console.log(this.i18n.pluginUninstall);
    }

    /** 文档加载后清扫误写入内容块的选区提示 class */
    private readonly onProtyleLoadedScrub = () => {
        scrubSelectionScopePollution();
    };

    /**
     * 窗口捕获阶段快捷键：
     * - Esc：搜索面板已打开且焦点不在面板内时关闭（编辑器内也能退出）
     * - Ctrl+F/H：只读 / 预览兜底（正常编辑仍走 editorCallback）
     */
    private readonly onWindowKeydownCapture = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) {
            return;
        }

        if (
            event.key === "Escape"
            && !event.ctrlKey
            && !event.metaKey
            && !event.altKey
            && !event.shiftKey
        ) {
            if (this.tryCloseSearchOnEscape(event.target)) {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }

        const mod = event.ctrlKey || event.metaKey;
        if (!mod || event.altKey || event.shiftKey) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key !== "f" && key !== "h") {
            return;
        }

        const target = event.target instanceof Element ? event.target : null;
        // 搜索面板内已有自己的快捷键处理
        if (target?.closest(`.${CLASS_NAME}`)) {
            return;
        }
        // 设置页等外部输入框：不要抢走
        if (target && isForeignTextInput(target)) {
            return;
        }

        const host = resolveHotkeyHostElement(target);
        if (!host || !isEditorReplaceModeBlocked(host)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void this.addSearchElement({intent: key === "f" ? "find" : "replace"});
    };

    /**
     * 焦点已回到编辑器等面板外区域时，Esc 仍关闭搜索窗。
     * 面板内 Esc 由 SearchBar 自行处理，此处跳过以免重复销毁。
     */
    private tryCloseSearchOnEscape(eventTarget: EventTarget | null): boolean {
        if (this.searchBars.size === 0) {
            return false;
        }

        const target = eventTarget instanceof Element ? eventTarget : null;
        if (target?.closest(`.${CLASS_NAME}`)) {
            return false;
        }
        // 思源确认框 / 菜单打开时，把 Esc 留给它们
        if (target?.closest(".b3-dialog, .b3-menu")) {
            return false;
        }

        const host = resolveHotkeyHostElement(target);
        const candidates: Element[] = [];
        for (const root of this.searchBars.keys()) {
            if (!root.isConnected) {
                continue;
            }
            if (host && (host.contains(root) || root.contains(host) || host === root.parentElement)) {
                candidates.push(root);
            }
        }

        const toClose = candidates.length > 0
            ? candidates
            : Array.from(this.searchBars.keys()).filter((root) => (
                root.isConnected && (
                    this.searchBars.size === 1
                    || Boolean(root.closest(".layout__wnd--active"))
                )
            ));

        if (toClose.length === 0) {
            return false;
        }

        for (const root of toClose) {
            this.closeCurrentSearchDialog(root, {broadcast: true});
        }
        return true;
    }

    private getSearchI18n(): SearchBarI18n {
        const t = this.i18n as Record<string, string>;
        return {
            searchPlaceholder: t.searchPlaceholder || "Find",
            replacePlaceholder: t.replacePlaceholder || "Replace with",
            searchPrev: t.searchPrev || "Previous (Shift+Enter)",
            searchNext: t.searchNext || "Next (Enter)",
            searchClose: t.searchClose || "Close",
            selectionOnly: t.selectionOnly || "Find in selection",
            matchCase: t.matchCase || "Match case",
            wholeWord: t.wholeWord || "Whole word",
            useRegex: t.useRegex || "Use regex (search only)",
            preserveCase: t.preserveCase || "Preserve case",
            replaceUnsupportedHelp: t.replaceUnsupportedHelp
                || "Replacement is unavailable in export preview or read-only mode; the document title, math formulas, databases, HTML blocks, Mermaid diagrams, and text with complex formatting also cannot be replaced",
            replaceAction: t.replaceAction || "Replace (Enter)",
            replaceAllAction: t.replaceAllAction || "Replace all (Ctrl+Alt+Enter)",
            replaceToggle: t.replaceToggle || "Expand or collapse replace row",
            replaceCurrentUnsupported: t.replaceCurrentUnsupported
                || "This match cannot be replaced directly",
            replaceAttributeViewUnsupported: t.replaceAttributeViewUnsupported
                || "Database results cannot be replaced",
            replaceMermaidUnsupported: t.replaceMermaidUnsupported
                || "Mermaid diagrams support search and highlight only, not replace",
            replaceHtmlBlockUnsupported: t.replaceHtmlBlockUnsupported
                || "HTML blocks support search and highlight of rendered text only; replacement is not supported",
            replaceModeUnsupported: t.replaceModeUnsupported
                || "Replacement is unavailable in export preview or read-only mode",
            replaceAllConfirm: t.replaceAllConfirm || "Replace {count} matches?",
            replaceAllConfirmTitle: t.replaceAllConfirmTitle || "Replace all",
            replaceCurrentDone: t.replaceCurrentDone || "Current match replaced",
            replaceAllResult: t.replaceAllResult
                || "Replacement complete: {replacedCount} replaced, {skippedCount} skipped",
            replaceProtyleMissing: t.replaceProtyleMissing
                || "Cannot find Protyle editor; replace aborted to keep undo available",
            selectionOnlyNoScope: t.selectionOnlyNoScope
                || "Selection-only mode is on, but there is no usable selection",
            settingsTitle: t.settingsTitle || "Search scope",
            settingsRestrictInline: t.settingsRestrictInline || "Limit find",
            settingsRestrictInlineHint: t.settingsRestrictInlineHint
                || "When enabled, search only within the selected inline elements (multi-select). With an empty find box, preview all matching inline elements of the selected types. Limit-find choices reset when the search UI closes",
            settingsIncludeScope: t.settingsIncludeScope || "Include in find",
            settingsIncludeScopeHint: t.settingsIncludeScopeHint
                || "Controls which block-level types (and inline memos) may be searched",
            settingsIncludeAttributeView: t.settingsIncludeAttributeView || "Database",
            settingsIncludeTable: t.settingsIncludeTable || "Table",
            settingsIncludeBlockquote: t.settingsIncludeBlockquote || "Blockquote",
            settingsIncludeCallout: t.settingsIncludeCallout || "Callout",
            settingsIncludeMathBlock: t.settingsIncludeMathBlock || "Math block",
            settingsIncludeEmbedBlock: t.settingsIncludeEmbedBlock || "Embed block",
            settingsIncludeWidget: t.settingsIncludeWidget || "Widget",
            settingsIncludeCodeBlock: t.settingsIncludeCodeBlock || "Code blocks",
            settingsIncludeMermaid: t.settingsIncludeMermaid || "Mermaid",
            settingsIncludeHtmlBlock: t.settingsIncludeHtmlBlock || "HTML block",
            settingsIncludeHtmlBlockHint: t.settingsIncludeHtmlBlockHint
                || "Match visible rendered text inside HTML blocks, not the HTML source",
            settingsIncludeFoldedBlocks: t.settingsIncludeFoldedBlocks || "Folded block content",
            settingsIncludeFoldedBlocksHint: t.settingsIncludeFoldedBlocksHint
                || "Controls whether to search hidden content inside folded blocks (excluding folded headings)",
            settingsIncludeInlineMemo: t.settingsIncludeInlineMemo || "Inline memos",
            settingsIncludeInlineMemoHint: t.settingsIncludeInlineMemoHint
                || "Matches show a yellow/orange dashed underline under the corresponding text",
            settingsRestrictBlockRef: t.settingsRestrictBlockRef || "Block ref",
            settingsRestrictLink: t.settingsRestrictLink || "Link",
            settingsRestrictStrong: t.settingsRestrictStrong || "Bold",
            settingsRestrictEm: t.settingsRestrictEm || "Italic",
            settingsRestrictU: t.settingsRestrictU || "Underline",
            settingsRestrictS: t.settingsRestrictS || "Strikethrough",
            settingsRestrictMark: t.settingsRestrictMark || "Highlight",
            settingsRestrictSup: t.settingsRestrictSup || "Superscript",
            settingsRestrictSub: t.settingsRestrictSub || "Subscript",
            settingsRestrictCode: t.settingsRestrictCode || "Inline code",
            settingsRestrictKbd: t.settingsRestrictKbd || "Keyboard",
            settingsRestrictTag: t.settingsRestrictTag || "Tag",
            settingsRestrictInlineMath: t.settingsRestrictInlineMath || "Inline math",
            settingsRestrictInlineMathHint: t.settingsRestrictInlineMathHint
                || "Match visible rendered formula text (not LaTeX source); not replaceable",
            settingsRestrictInlineMemo: t.settingsRestrictInlineMemo || "Inline memo",
            settingsRestrictInlineMemoHint: t.settingsRestrictInlineMemoHint
                || "Turn on Include in find → Inline memos first; not replaceable",
            settingsRestrictInlineMemoOnHint: t.settingsRestrictInlineMemoOnHint
                || "Turn on Include in find → Inline memos first; not replaceable",
            invalidRegex: t.invalidRegex || "Invalid regex: {error}",
        };
    }

    /** 将数据库匹配开关同步到其它已打开面板 */
    syncIncludeAttributeView(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeAttributeView(value);
        });
    }

    /** 将表格匹配开关同步到其它已打开面板 */
    syncIncludeTable(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeTable(value);
        });
    }

    /** 将引述块匹配开关同步到其它已打开面板 */
    syncIncludeBlockquote(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeBlockquote(value);
        });
    }

    /** 将提示块匹配开关同步到其它已打开面板 */
    syncIncludeCallout(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeCallout(value);
        });
    }

    /** 将公式块匹配开关同步到其它已打开面板 */
    syncIncludeMathBlock(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeMathBlock(value);
        });
    }

    /** 将嵌入块匹配开关同步到其它已打开面板 */
    syncIncludeEmbedBlock(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeEmbedBlock(value);
        });
    }

    /** 将挂件匹配开关同步到其它已打开面板 */
    syncIncludeWidget(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeWidget(value);
        });
    }

    /** 将代码块匹配开关同步到其它已打开面板 */
    syncIncludeCodeBlock(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeCodeBlock(value);
        });
    }

    /** 将 Mermaid 匹配开关同步到其它已打开面板 */
    syncIncludeMermaid(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeMermaid(value);
        });
    }

    /** 将 HTML 块匹配开关同步到其它已打开面板 */
    syncIncludeHtmlBlock(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeHtmlBlock(value);
        });
    }

    /** 将折叠块内容匹配开关同步到其它已打开面板 */
    syncIncludeFoldedBlocks(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeFoldedBlocks(value);
        });
    }

    /** 将行内备注匹配开关同步到其它已打开面板 */
    syncIncludeInlineMemo(value: boolean, source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyIncludeInlineMemo(value);
        });
    }

    /** 将限制查找类型同步到其它已打开面板 */
    syncRestrictInlineTypes(value: RestrictInlineType[], source?: SearchBar) {
        this.searchBars.forEach((bar) => {
            if (bar === source) {
                return;
            }
            bar.applyRestrictInlineTypes(value);
        });
    }

    private bindKernelSearchState() {
        if (this.searchStateHandler) {
            return;
        }
        this.searchStateHandler = bindSearchStateListener(this, async (event: SearchStateEvent) => {
            if (!event || event.clientId === this.clientId) {
                return;
            }
            if (event.type === "close") {
                this.closeSearchDialog();
                return;
            }
            if (event.type === "clear") {
                this.searchBars.forEach((bar) => bar.clearHighlightsOnly());
                this.lastHighlightComponent = null;
            }
        });
    }

    private unbindKernelSearchState() {
        if (!this.searchStateHandler) {
            return;
        }
        try {
            unbindSearchStateListener(this, this.searchStateHandler);
        } catch (error) {
            console.warn("[page-search] unbind search-state failed", error);
        }
        this.searchStateHandler = null;
    }

    private readonly onKernelPluginStateChange = ({detail}: CustomEvent<IKernelPluginState>) => {
        this.kernelReady = detail?.code === 2;
        if (this.kernelReady) {
            this.bindKernelSearchState();
        }
    };

    private cleanupInvalidComponents() {
        const invalidElements: Element[] = [];
        this.searchBars.forEach((_, element) => {
            if (!document.contains(element)) {
                invalidElements.push(element);
            }
        });

        if (invalidElements.length > 0) {
            console.warn("[page-search] cleaning unexpectedly removed search bars");
        }

        invalidElements.forEach((element) => {
            const bar = this.searchBars.get(element);
            this.searchBars.delete(element);
            if (bar) {
                try {
                    bar.destroy();
                } catch (error) {
                    console.error("[page-search] destroy invalid bar failed", error);
                    this.activeSearchComponentsCount = Math.max(0, this.activeSearchComponentsCount - 1);
                }
            } else {
                this.activeSearchComponentsCount = Math.max(0, this.activeSearchComponentsCount - 1);
            }
        });

        if (this.activeSearchComponentsCount === 0) {
            this.searchComponentCallbacks.clear();
            this.eventBusOff();
            this.lastHighlightComponent = null;
        }
    }

    private startCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.cleanupTimer = window.setInterval(() => {
            this.cleanupInvalidComponents();
        }, 30000);
    }

    private stopCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    private eventBusOn() {
        this.eventBus.on("ws-main", this.handleEventBusEvent);
        this.eventBus.on("loaded-protyle-dynamic", this.handleEventBusEvent);
        this.eventBus.on("loaded-protyle-static", this.handleEventBusEvent);
        this.eventBus.on("switch-protyle", this.handleEventBusEvent);
        this.eventBus.on("switch-protyle-mode", this.handleEventBusEvent);
    }

    private eventBusOff() {
        this.eventBus.off("ws-main", this.handleEventBusEvent);
        this.eventBus.off("loaded-protyle-dynamic", this.handleEventBusEvent);
        this.eventBus.off("loaded-protyle-static", this.handleEventBusEvent);
        this.eventBus.off("switch-protyle", this.handleEventBusEvent);
        this.eventBus.off("switch-protyle-mode", this.handleEventBusEvent);
    }

    private handleEventBusEvent = (event: CustomEvent) => {
        this.searchComponentCallbacks.forEach((callback) => {
            callback(event);
        });
    };

    onSearchComponentMounted(callback: (event: CustomEvent) => void) {
        this.searchComponentCallbacks.add(callback);
        this.activeSearchComponentsCount++;
        if (this.activeSearchComponentsCount === 1) {
            this.eventBusOn();
            this.startCleanupTimer();
        }
    }

    onSearchComponentUnmounted(callback?: (event: CustomEvent) => void) {
        if (callback) {
            this.searchComponentCallbacks.delete(callback);
        }
        this.activeSearchComponentsCount--;
        if (this.activeSearchComponentsCount === 0) {
            this.eventBusOff();
            this.stopCleanupTimer();
        }
    }

    closeSearchDialog() {
        this.searchBars.forEach((bar) => {
            try {
                bar.destroy();
            } catch (error) {
                console.error("[page-search] destroy search bar failed", error);
            }
        });
        this.searchBars.clear();
        this.activeSearchComponentsCount = 0;
        document.querySelectorAll(`.${CLASS_NAME}`).forEach((element) => {
            try {
                element.remove();
            } catch (error) {
                console.error("[page-search] remove search root failed", error);
            }
        });
        this.lastHighlightComponent = null;
        // 限制查找不持久化：关闭时清回默认空，避免下次打开带回旧勾选
        void rpcSetPrefs(this, {lastQuery: "", restrictInlineTypes: []});
    }

    closeCurrentSearchDialog(element: Element, options?: {broadcast?: boolean}) {
        const bar = this.searchBars.get(element);
        if (bar) {
            try {
                this.searchBars.delete(element);
                bar.destroy();
            } catch (error) {
                console.error("[page-search] close current search failed", error);
            }
        } else {
            try {
                element.remove();
            } catch (error) {
                console.error("[page-search] remove element failed", error);
            }
        }

        void rpcSetPrefs(this, {lastQuery: "", restrictInlineTypes: []});

        if (options?.broadcast) {
            void rpcEmitSearchState(this, {
                type: "close",
                clientId: this.clientId,
            });
        }
    }

    closePanel() {
        if (!this.isMobile) {
            return;
        }
        const menuElement = document.getElementById("menu");
        const sidebarElement = document.getElementById("sidebar");
        const modelElement = document.getElementById("model");
        if (menuElement) {
            menuElement.style.transform = "";
        }
        if (sidebarElement) {
            sidebarElement.style.transform = "";
        }
        if (modelElement) {
            modelElement.style.transform = "";
        }
        const maskElement = document.querySelector(".side-mask") as HTMLElement | null;
        if (maskElement) {
            maskElement.classList.add("fn__none");
            maskElement.style.opacity = "";
        }
        (window as any).siyuan?.menus?.menu?.remove?.();
    }

    async addSearchElement(options: {
        isFromTopBar?: boolean;
        /** find=Ctrl+F；replace=Ctrl+H */
        intent?: "find" | "replace";
    } = {}) {
        const isFromTopBar = Boolean(options.isFromTopBar);
        const intent = options.intent ?? "find";
        const replaceVisibleOnCreate = intent === "replace";
        this.cleanupInvalidComponents();

        const mobile = this.isMobile;
        let edits: NodeListOf<Element> | Element[] = mobile
            ? document.querySelectorAll("#editor")
            : document.querySelectorAll(".layout__wnd--active > .layout-tab-container");

        if (edits.length === 0) {
            const protyle = document.activeElement?.closest(".protyle");
            if (protyle) {
                edits = [protyle];
            } else {
                console.error("[page-search] no protyle found");
                return;
            }
        }

        const prefs = await rpcGetPrefs(this);
        const selectedText = this.getSelectedText();
        // 仅预填当前选区；关闭窗口时会清空 lastQuery，不再恢复历史关键词
        const initialQuery = selectedText || "";

        edits.forEach((edit) => {
            const existingElement = mobile
                ? document.querySelector(`.${CLASS_NAME}`)
                : edit.querySelector(`.${CLASS_NAME}`);

            if (!existingElement) {
                // (1) 关闭态：Ctrl+F 折叠替换；Ctrl+H 展开替换；焦点均在查找框
                const element = document.createElement("div");
                element.className = `${CLASS_NAME}${mobile ? ` ${CLASS_NAME}--mobile` : ""}`;

                if (mobile) {
                    edit.insertAdjacentElement("afterend", element);
                } else {
                    edit.appendChild(element);
                }

                const bar = new SearchBar({
                    edit,
                    root: element,
                    plugin: this,
                    i18n: this.getSearchI18n(),
                    presetText: initialQuery || undefined,
                    replaceVisible: replaceVisibleOnCreate,
                    includeAttributeView: prefs.includeAttributeView !== false,
                    includeTable: prefs.includeTable !== false,
                    includeBlockquote: prefs.includeBlockquote !== false,
                    includeCallout: prefs.includeCallout !== false,
                    includeMathBlock: prefs.includeMathBlock !== false,
                    includeEmbedBlock: prefs.includeEmbedBlock !== false,
                    includeWidget: prefs.includeWidget !== false,
                    includeCodeBlock: prefs.includeCodeBlock !== false,
                    includeMermaid: prefs.includeMermaid !== false,
                    includeHtmlBlock: prefs.includeHtmlBlock !== false,
                    includeFoldedBlocks: prefs.includeFoldedBlocks === true,
                    includeInlineMemo: prefs.includeInlineMemo === true,
                    // 限制查找仅会话内有效，打开时始终不限制
                    restrictInlineTypes: [],
                });
                this.searchBars.set(element, bar);

                if (
                    !isFromTopBar
                    && typeof prefs.dialogLeft === "number"
                    && typeof prefs.dialogTop === "number"
                ) {
                    bar.applySavedPosition(prefs.dialogLeft, prefs.dialogTop);
                }
            } else {
                const bar = this.searchBars.get(existingElement);
                if (isFromTopBar && bar) {
                    bar.resetPanelPosition();
                }
                if (!bar) {
                    const inputElement = existingElement.querySelector(
                        ".search-dialog .b3-text-field",
                    ) as HTMLInputElement | null;
                    inputElement?.focus();
                    inputElement?.select();
                    return;
                }

                if (selectedText) {
                    // 预填时不抢焦点，由 intent 决定最终落点
                    bar.applyPresetAndSearch(selectedText, {focusFind: false});
                }

                // (2)(3)(4) 已打开时的快捷键行为
                bar.applyHotkeyIntent(intent);
            }
        });
    }

    private getSelectedText(): string {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return "";
        }
        return selection.getRangeAt(0).toString().trim() || "";
    }
}

/** 当前快捷键应对准的编辑宿主（焦点处 protyle / 活动窗口） */
function resolveHotkeyHostElement(target: Element | null): Element | null {
    const fromTarget = target?.closest(".protyle")
        ?? target?.closest(".layout-tab-container");
    if (fromTarget) {
        return fromTarget;
    }
    return document.querySelector(".layout__wnd--active > .layout-tab-container")
        ?? document.querySelector(".layout__wnd--active .protyle:not(.fn__none)")
        ?? document.querySelector("#editor .protyle:not(.fn__none)");
}

/** 设置页等非文档输入区，避免抢 Ctrl+F/H */
function isForeignTextInput(el: Element): boolean {
    const tag = el.tagName;
    const isField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
        || (el as HTMLElement).isContentEditable;
    if (!isField) {
        return false;
    }
    return !el.closest(".protyle") && !el.closest(`.${CLASS_NAME}`);
}
