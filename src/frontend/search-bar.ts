import {
    ATTRIBUTE_VIEW_TYPE,
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
    RESTRICT_INLINE_TYPE_ALLOWLIST,
    canRestrictInlineMemo,
    formatSearchCountLabel,
    hasRestrictInlineType,
    isRestrictInlineActive,
    normalizeRestrictInlineTypes,
    toggleRestrictInlineType,
    shouldEnumerateRestrictInline,
    type RestrictInlineType,
} from "../shared";
import type {IMenu, Plugin} from "siyuan";
import {confirm, Menu, showMessage} from "siyuan";
import {rpcEmitSearchState, rpcSetPrefs} from "./kernel-client";
import {collectSearchableBlocks, MERMAID_UNIT_ID} from "./blocks";
import {calculateSearchMatches} from "./pipeline";
import {
    isMatchWritable,
    replaceAllMatchesInEditor,
    replaceCurrentMatchInEditor,
} from "./protyle-write";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {
    cloneSelectionScope,
    getSelectionScope,
    refreshWholeAttributeViewSelectionScope,
    type SelectionScope,
} from "./selection";
import {SearchPanelFrame} from "./panel-frame";
import {
    AV_REFRESH_DEBOUNCE_MS,
    isAttrViewRelevantToEdit,
    isAttrViewWsTransaction,
    watchAttributeViewDom,
} from "./av-watch";
import {resolveInitialMatchIndex} from "./match-anchor";
import {
    applySelectionScopeVisual,
    captureSelectionScopeWithKind,
    clearSelectionScopeVisual,
    type SelectionScopeVisualKind,
    type TableCellVisualRef,
} from "./selection-scope-visual";
import {
    applyMemoUnderlineVisual,
    clearMemoUnderlineVisual,
} from "./memo-underline-visual";
import {
    collectNonHeadingFoldedAncestorIds,
    unfoldNonHeadingFoldedBlocks,
    waitForLayout,
} from "./fold";
import type {SearchMatch} from "./dom-types";

/** 限制查找菜单：类型 → 图标（对齐思源 hint/工具栏符号 id） */
const RESTRICT_INLINE_ICONS: Record<RestrictInlineType, string> = {
    "block-ref": "iconRef",
    a: "iconLink",
    strong: "iconBold",
    em: "iconItalic",
    u: "iconUnderline",
    s: "iconStrike",
    mark: "iconMark",
    sup: "iconSup",
    sub: "iconSub",
    code: "iconInlineCode",
    kbd: "iconKeymap",
    tag: "iconTag",
    "inline-math": "iconMath",
    "inline-memo": "iconM",
};

const DONE_TYPING_MS = 400;

export interface SearchBarI18n {
    searchPlaceholder: string;
    replacePlaceholder: string;
    searchPrev: string;
    searchNext: string;
    searchClose: string;
    selectionOnly: string;
    matchCase: string;
    wholeWord: string;
    useRegex: string;
    preserveCase: string;
    replaceUnsupportedHelp: string;
    replaceAction: string;
    replaceAllAction: string;
    replaceToggle: string;
    replaceCurrentUnsupported: string;
    replaceAttributeViewUnsupported: string;
    replaceMermaidUnsupported: string;
    replaceModeUnsupported: string;
    replaceAllConfirm: string;
    replaceAllConfirmTitle: string;
    replaceCurrentDone: string;
    replaceAllResult: string;
    replaceProtyleMissing: string;
    selectionOnlyNoScope: string;
    settingsTitle: string;
    settingsRestrictInline: string;
    settingsRestrictInlineHint: string;
    settingsIncludeScope: string;
    settingsIncludeScopeHint: string;
    settingsIncludeAttributeView: string;
    settingsIncludeTable: string;
    settingsIncludeBlockquote: string;
    settingsIncludeCallout: string;
    settingsIncludeMathBlock: string;
    settingsIncludeEmbedBlock: string;
    settingsIncludeWidget: string;
    settingsIncludeCodeBlock: string;
    settingsIncludeMermaid: string;
    settingsIncludeFoldedBlocks: string;
    settingsIncludeFoldedBlocksHint: string;
    settingsIncludeInlineMemo: string;
    settingsIncludeInlineMemoHint: string;
    settingsRestrictMark: string;
    settingsRestrictStrong: string;
    settingsRestrictEm: string;
    settingsRestrictU: string;
    settingsRestrictS: string;
    settingsRestrictCode: string;
    settingsRestrictKbd: string;
    settingsRestrictTag: string;
    settingsRestrictSup: string;
    settingsRestrictSub: string;
    settingsRestrictLink: string;
    settingsRestrictBlockRef: string;
    settingsRestrictInlineMath: string;
    settingsRestrictInlineMathHint: string;
    settingsRestrictInlineMemo: string;
    settingsRestrictInlineMemoHint: string;
    settingsRestrictInlineMemoOnHint: string;
    invalidRegex: string;
}

export interface SearchBarHost {
    isMobileView(): boolean;
    getClientId(): string;
    updateLastHighlightComponent(element: Element): void;
    isLastHighlightComponent(element: Element): boolean;
    closeCurrentSearchDialog(element: Element, options?: {broadcast?: boolean}): void;
    onSearchComponentMounted(callback: (event: CustomEvent) => void): void;
    onSearchComponentUnmounted(callback?: (event: CustomEvent) => void): void;
    /** 将数据库匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeAttributeView?(value: boolean, source?: SearchBar): void;
    /** 将表格匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeTable?(value: boolean, source?: SearchBar): void;
    /** 将引述块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeBlockquote?(value: boolean, source?: SearchBar): void;
    /** 将提示块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeCallout?(value: boolean, source?: SearchBar): void;
    /** 将公式块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeMathBlock?(value: boolean, source?: SearchBar): void;
    /** 将嵌入块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeEmbedBlock?(value: boolean, source?: SearchBar): void;
    /** 将挂件匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeWidget?(value: boolean, source?: SearchBar): void;
    /** 将代码块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeCodeBlock?(value: boolean, source?: SearchBar): void;
    /** 将 Mermaid 匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeMermaid?(value: boolean, source?: SearchBar): void;
    /** 将折叠块内容匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeFoldedBlocks?(value: boolean, source?: SearchBar): void;
    /** 将行内备注匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeInlineMemo?(value: boolean, source?: SearchBar): void;
    /** 将限制查找类型同步到其它已打开的搜索面板（不写 prefs） */
    syncRestrictInlineTypes?(value: RestrictInlineType[], source?: SearchBar): void;
}

type MatchOptionKey = "caseSensitive" | "wholeWord" | "regex" | "preserveCase" | "selectionOnly";

export class SearchBar {
    readonly root: HTMLElement;
    private readonly edit: Element;
    private readonly plugin: Plugin & SearchBarHost;
    private readonly i18n: SearchBarI18n;
    private readonly input: HTMLInputElement;
    private readonly replaceInput: HTMLInputElement;
    private readonly countEl: HTMLElement;
    private readonly dialog: HTMLElement;

    private searchText = "";
    private replaceText = "";
    private resultIndex = 0;
    private resultCount = 0;
    private resultMatches: SearchMatch[] = [];
    private typingTimer: number | undefined;
    private searchGeneration = 0;

    private caseSensitive = false;
    private wholeWord = false;
    private regex = false;
    private preserveCase = false;
    /** 选区内查找；打开预填关键词不会自动打开 */
    private selectionOnly = false;
    /** 是否匹配数据库；全局 prefs，默认 true */
    private includeAttributeView = true;
    /** 是否匹配表格块；全局 prefs，默认 true */
    private includeTable = true;
    /** 是否匹配引述块；全局 prefs，默认 true */
    private includeBlockquote = true;
    /** 是否匹配提示块；全局 prefs，默认 true */
    private includeCallout = true;
    /** 是否匹配公式块；全局 prefs，默认 true（不含行内公式） */
    private includeMathBlock = true;
    /** 是否匹配嵌入块；全局 prefs，默认 true */
    private includeEmbedBlock = true;
    /** 是否匹配挂件；全局 prefs，默认 true */
    private includeWidget = true;
    /** 是否匹配代码块（非 Mermaid）；全局 prefs，默认 true */
    private includeCodeBlock = true;
    /** 是否匹配 Mermaid；全局 prefs，默认 true */
    private includeMermaid = true;
    /** 是否匹配非标题折叠块内隐藏内容；全局 prefs，默认 false */
    private includeFoldedBlocks = false;
    /** 是否匹配行内备注；全局 prefs，默认 false */
    private includeInlineMemo = false;
    /** 限制查找的行内类型；空 = 不限制 */
    private restrictInlineTypes: RestrictInlineType[] = [];
    /** 替换行默认折叠（对齐 sou-easy defaultReplaceVisible=false） */
    private replaceVisible = false;
    private rememberedSelectionScope: SelectionScope = new Map();
    private selectionScopeVisualKind: SelectionScopeVisualKind | null = null;
    /** 块选冻结时的顶层块 id（空块/容器/数据库），供 --select 消失后重绘竖线 */
    private rememberedVisualBlockIds: string[] = [];
    /** 表格框选冻结时的单元格坐标；底色按格绘制、竖线按整表绘制 */
    private rememberedTableCellRefs: TableCellVisualRef[] = [];
    private replaceBusy = false;

    private readonly eventBusHandle: (event: CustomEvent) => void;
    private readonly optionButtons = new Map<MatchOptionKey, HTMLElement>();
    private replaceRow: HTMLElement | null = null;
    private replaceToggleBtn: HTMLElement | null = null;
    private replaceBtn: HTMLElement | null = null;
    private replaceAllBtn: HTMLElement | null = null;
    private panelFrame: SearchPanelFrame | null = null;
    private stopAvDomWatch: (() => void) | null = null;
    private avRefreshTimer: number | undefined;
    /** 跳转滚动期间抑制 AV DOM 观察触发的重搜，避免把索引打回 1 */
    private avWatchPausedUntil = 0;
    /** 打开面板前编辑器内选区快照；关闭时用于恢复焦点（匹配导航优先） */
    private restoreEditorRange: Range | null = null;
    /** 选区提示几何同步：滚动/缩放后按冻结 scope 重测坐标（不写内容块） */
    private stopSelectionScopeLayoutSync: (() => void) | null = null;
    private selectionScopeLayoutRaf = 0;
    /** 备注虚线下划线几何同步（叠加层随滚动重绘） */
    private stopMemoUnderlineLayoutSync: (() => void) | null = null;
    private memoUnderlineLayoutRaf = 0;
    /** 当前打开的齿轮设置菜单（关闭搜索窗时一并关掉） */
    private settingsMenu: Menu | null = null;

    constructor(options: {
        edit: Element;
        root: HTMLElement;
        plugin: Plugin & SearchBarHost;
        i18n: SearchBarI18n;
        presetText?: string;
        /** 打开时是否展开替换行（Ctrl+H） */
        replaceVisible?: boolean;
        /** 是否匹配数据库（来自全局 prefs） */
        includeAttributeView?: boolean;
        /** 是否匹配表格块（来自全局 prefs） */
        includeTable?: boolean;
        /** 是否匹配引述块（来自全局 prefs） */
        includeBlockquote?: boolean;
        /** 是否匹配提示块（来自全局 prefs） */
        includeCallout?: boolean;
        /** 是否匹配公式块（来自全局 prefs；不含行内公式） */
        includeMathBlock?: boolean;
        /** 是否匹配嵌入块（来自全局 prefs） */
        includeEmbedBlock?: boolean;
        /** 是否匹配挂件（来自全局 prefs） */
        includeWidget?: boolean;
        /** 是否匹配代码块（来自全局 prefs） */
        includeCodeBlock?: boolean;
        /** 是否匹配 Mermaid（来自全局 prefs） */
        includeMermaid?: boolean;
        /** 是否匹配折叠块内容（来自全局 prefs） */
        includeFoldedBlocks?: boolean;
        /** 是否匹配行内备注（来自全局 prefs） */
        includeInlineMemo?: boolean;
        /** 限制查找行内类型（来自全局 prefs） */
        restrictInlineTypes?: RestrictInlineType[];
    }) {
        this.edit = options.edit;
        this.root = options.root;
        this.plugin = options.plugin;
        this.i18n = options.i18n;
        this.replaceVisible = Boolean(options.replaceVisible);
        this.includeAttributeView = options.includeAttributeView !== false;
        this.includeTable = options.includeTable !== false;
        this.includeBlockquote = options.includeBlockquote !== false;
        this.includeCallout = options.includeCallout !== false;
        this.includeMathBlock = options.includeMathBlock !== false;
        this.includeEmbedBlock = options.includeEmbedBlock !== false;
        this.includeWidget = options.includeWidget !== false;
        this.includeCodeBlock = options.includeCodeBlock !== false;
        this.includeMermaid = options.includeMermaid !== false;
        this.includeFoldedBlocks = options.includeFoldedBlocks === true;
        this.includeInlineMemo = options.includeInlineMemo === true;
        this.restrictInlineTypes = normalizeRestrictInlineTypes(
            options.restrictInlineTypes,
            {includeInlineMemo: this.includeInlineMemo},
        );
        this.eventBusHandle = (event) => this.onEventBus(event);

        this.root.innerHTML = this.buildMarkup(this.plugin.isMobileView());
        this.dialog = this.root.querySelector(".search-dialog") as HTMLElement;
        this.input = this.root.querySelector(".search-input-find") as HTMLInputElement;
        this.replaceInput = this.root.querySelector(".search-input-replace") as HTMLInputElement;
        this.countEl = this.root.querySelector(".search-count") as HTMLElement;
        this.replaceRow = this.root.querySelector(".search-row--replace");
        this.replaceToggleBtn = this.root.querySelector('[data-action="toggle-replace"]');
        this.replaceBtn = this.root.querySelector('[data-action="replace"]');
        this.replaceAllBtn = this.root.querySelector('[data-action="replace-all"]');

        for (const key of [
            "caseSensitive",
            "wholeWord",
            "regex",
            "preserveCase",
            "selectionOnly",
        ] as MatchOptionKey[]) {
            const el = this.root.querySelector(`[data-option="${key}"]`) as HTMLElement | null;
            if (el) {
                this.optionButtons.set(key, el);
            }
        }

        this.bindUi();
        this.panelFrame = new SearchPanelFrame({
            panel: this.dialog,
            enabled: !this.plugin.isMobileView(),
            persistPosition: (position) => {
                if (!position) {
                    void rpcSetPrefs(this.plugin, {dialogLeft: null, dialogTop: null});
                    return;
                }
                void rpcSetPrefs(this.plugin, {
                    dialogLeft: position.left,
                    dialogTop: position.top,
                });
            },
        });
        this.stopAvDomWatch = watchAttributeViewDom(this.edit, () => {
            this.scheduleAttrViewResearch();
        });
        this.plugin.onSearchComponentMounted(this.eventBusHandle);
        this.syncOptionButtons();
        this.syncReplaceVisibility();
        this.syncReplaceButtons();

        // 抢焦点前先记下编辑器光标，关闭时再还回去（对齐 VS Code / Cursor）
        this.captureEditorCaretIfNeeded();

        // presetText 仅预填关键词，不开启 selectionOnly
        if (options.presetText) {
            this.searchText = options.presetText;
            this.input.value = options.presetText;
            this.input.focus();
            void this.highlightHitResult(options.presetText, true);
        } else {
            this.input.focus();
            this.input.select();
            // 限制已开 + 空查询：打开即枚举行内宿主
            if (isRestrictInlineActive(this.restrictInlineTypes)) {
                void this.highlightHitResult("", true);
            }
        }
    }

    destroy() {
        clearTimeout(this.typingTimer);
        clearTimeout(this.avRefreshTimer);
        this.closeSettingsMenu();
        this.teardownSelectionScopeLayoutSync();
        this.teardownMemoUnderlineLayoutSync();
        this.clearSelectionScopeVisual();
        this.restoreEditorFocus();
        this.clearHighlight();
        this.stopAvDomWatch?.();
        this.stopAvDomWatch = null;
        this.panelFrame?.destroy();
        this.panelFrame = null;
        this.plugin.onSearchComponentUnmounted(this.eventBusHandle);
        this.root.remove();
        this.restoreEditorRange = null;
    }

    focusAndSelect() {
        this.captureEditorCaretIfNeeded();
        this.input.focus();
        this.input.select();
    }

    focusReplaceInput() {
        this.captureEditorCaretIfNeeded();
        this.replaceInput.focus();
        this.replaceInput.select();
    }

    isReplaceVisible(): boolean {
        return this.replaceVisible;
    }

    isFindInputFocused(): boolean {
        return document.activeElement === this.input;
    }

    isReplaceInputFocused(): boolean {
        return document.activeElement === this.replaceInput;
    }

    /**
     * 处理已打开面板时的 Ctrl+F / Ctrl+H。
     * - find：焦点不在查找框时聚焦查找框（不强制折叠替换行）
     * - replace：折叠则展开并聚焦替换框；已展开且焦点不在替换框则聚焦替换框
     */
    applyHotkeyIntent(intent: "find" | "replace") {
        if (intent === "replace") {
            if (!this.replaceVisible) {
                this.replaceVisible = true;
                this.syncReplaceVisibility();
                this.focusReplaceInput();
                return;
            }
            if (!this.isReplaceInputFocused()) {
                this.focusReplaceInput();
            }
            return;
        }

        if (!this.isFindInputFocused()) {
            this.focusAndSelect();
        }
    }

    /** 设置替换行展开状态 */
    setReplaceVisible(visible: boolean, focus: "find" | "replace" | "none" = "find") {
        this.replaceVisible = visible;
        this.syncReplaceVisibility();
        if (focus === "find") {
            this.focusAndSelect();
        } else if (focus === "replace") {
            this.focusReplaceInput();
        }
    }

    applyPresetAndSearch(text: string, options?: {focusFind?: boolean}) {
        this.searchText = text;
        this.input.value = text;
        void this.highlightHitResult(text, true);
        if (options?.focusFind !== false) {
            this.input.focus();
            this.input.select();
        }
    }

    /** 仅清空高亮（跨窗口 clear） */
    clearHighlightsOnly() {
        this.clearHighlight();
        this.resultMatches = [];
        this.resultCount = 0;
        this.resultIndex = 0;
        this.updateCountLabel();
        this.syncReplaceButtons();
    }

    getDialogElement(): HTMLElement {
        return this.dialog;
    }

    applySavedPosition(left: number, top: number) {
        this.panelFrame?.applySavedPosition(left, top);
    }

    resetPanelPosition() {
        this.panelFrame?.resetPosition();
    }

    private buildMarkup(mobile: boolean): string {
        const ph = escapeAttr(this.i18n.searchPlaceholder);
        const rph = escapeAttr(this.i18n.replacePlaceholder);
        return `
<div class="search-dialog">
  ${mobile ? "" : `<div class="search-resize-handle" aria-hidden="true"></div>`}
  <div class="search-dialog__rows">
    <div class="search-row search-row--find">
      <div data-action="toggle-replace" class="search-replace-toggle search-no-drag" title="${escapeAttr(this.i18n.replaceToggle)}" aria-label="${escapeAttr(this.i18n.replaceToggle)}" aria-expanded="false">${replaceToggleIcon()}</div>
      <div class="search-field">
        <input type="text" class="b3-text-field search-input-find" spellcheck="false" placeholder="${ph}" />
        <div class="search-field__toggles" role="group" aria-label="${escapeAttr(this.i18n.searchPlaceholder)}">
          <div class="search-option" data-option="caseSensitive" title="${escapeAttr(this.i18n.matchCase)}" aria-label="${escapeAttr(this.i18n.matchCase)}" role="button" tabindex="-1">Aa</div>
          <div class="search-option" data-option="wholeWord" title="${escapeAttr(this.i18n.wholeWord)}" aria-label="${escapeAttr(this.i18n.wholeWord)}" role="button" tabindex="-1">${wholeWordIcon()}</div>
          <div class="search-option" data-option="regex" title="${escapeAttr(this.i18n.useRegex)}" aria-label="${escapeAttr(this.i18n.useRegex)}" role="button" tabindex="-1">.*</div>
        </div>
      </div>
      <div class="search-row__trailing">
        <span class="search-count">0/0</span>
        <div class="search-tools">
          <div data-action="prev" title="${escapeAttr(this.i18n.searchPrev)}">${iconUse("#iconUp")}</div>
          <div data-action="next" title="${escapeAttr(this.i18n.searchNext)}">${iconUse("#iconDown")}</div>
          <div class="search-option" data-option="selectionOnly" title="${escapeAttr(this.i18n.selectionOnly)}" aria-label="${escapeAttr(this.i18n.selectionOnly)}" role="button" tabindex="-1">${selectionOnlyIcon()}</div>
          <div data-action="close" title="${escapeAttr(this.i18n.searchClose)}">${iconUse("#iconClose")}</div>
        </div>
      </div>
    </div>
    <div class="search-row search-row--replace" hidden>
      <div class="search-replace-spacer" aria-hidden="true"></div>
      <div class="search-field">
        <input type="text" class="b3-text-field search-input-replace" spellcheck="false" placeholder="${rph}" />
        <div class="search-field__toggles">
          <span class="search-replace-help search-no-drag ariaLabel" data-position="north" aria-label="${escapeAttr(this.i18n.replaceUnsupportedHelp)}" role="img">${circleQuestionIcon()}</span>
          <div class="search-option" data-option="preserveCase" title="${escapeAttr(this.i18n.preserveCase)}" aria-label="${escapeAttr(this.i18n.preserveCase)}" role="button" tabindex="-1">Aa*</div>
        </div>
      </div>
      <div class="search-row__trailing search-row__trailing--replace">
        <div class="search-tools search-tools--replace">
          <div data-action="replace" title="${escapeAttr(this.i18n.replaceAction)}" aria-label="${escapeAttr(this.i18n.replaceAction)}">${replaceOneIcon()}</div>
          <div data-action="replace-all" title="${escapeAttr(this.i18n.replaceAllAction)}" aria-label="${escapeAttr(this.i18n.replaceAllAction)}">${replaceAllIcon()}</div>
        </div>
        <span class="search-trailing-flex" aria-hidden="true"></span>
        <div class="search-tools search-tools--settings">
          <div data-action="settings" title="${escapeAttr(this.i18n.settingsTitle)}" aria-label="${escapeAttr(this.i18n.settingsTitle)}" role="button" tabindex="-1">${settingsGearIcon()}</div>
        </div>
      </div>
    </div>
  </div>
</div>`;
    }

    private bindUi() {
        this.input.addEventListener("input", () => {
            this.searchText = this.input.value;
            clearTimeout(this.typingTimer);
            this.typingTimer = window.setTimeout(() => {
                void this.highlightHitResult(this.searchText, true);
            }, DONE_TYPING_MS);
        });

        this.replaceInput.addEventListener("input", () => {
            this.replaceText = this.replaceInput.value;
        });

        this.input.addEventListener("keydown", (event) => this.onFindKeydown(event));
        this.replaceInput.addEventListener("keydown", (event) => this.onReplaceKeydown(event));
        // 面板内统一处理 Esc / Ctrl+F/H（焦点在按钮上时输入框监听收不到）
        this.dialog.addEventListener("keydown", (event) => this.onPanelKeydown(event));

        this.bindToolbarControl('[data-action="prev"]', () => this.clickLast(), "find");
        this.bindToolbarControl('[data-action="next"]', () => this.clickNext(), "find");
        this.bindToolbarControl('[data-action="close"]', () => this.clickClose(), "none");
        this.bindToolbarControl(
            '[data-action="toggle-replace"]',
            () => this.toggleReplaceVisible(),
            "none",
        );
        this.bindToolbarControl('[data-action="replace"]', () => {
            void this.clickReplace();
        }, "replace");
        this.bindToolbarControl('[data-action="replace-all"]', () => {
            void this.clickReplaceAll();
        }, "replace");
        this.bindToolbarControl('[data-action="settings"]', (event) => {
            this.openSettingsMenu(event.currentTarget as HTMLElement);
        }, "none");

        for (const [key, button] of this.optionButtons) {
            // pointerdown 阻止默认：避免选项按钮抢走输入框焦点
            button.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                if (key === "selectionOnly") {
                    event.stopPropagation();
                }
            });
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.toggleOption(key);
            });
        }

        this.root.querySelector(".search-replace-help")?.addEventListener("pointerdown", (event) => {
            event.preventDefault();
        });
    }

    /**
     * 工具按钮：pointerdown 时 preventDefault，保持查找/替换框焦点，
     * 否则点击后焦点落到 body，Esc 等快捷键全部失效。
     */
    private bindToolbarControl(
        selector: string,
        onClick: (event: MouseEvent) => void,
        retainFocus: "find" | "replace" | "none",
    ) {
        const el = this.root.querySelector(selector);
        if (!el) {
            return;
        }
        el.addEventListener("pointerdown", (event) => {
            event.preventDefault();
        });
        el.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick(event);
            if (retainFocus === "find") {
                this.input.focus();
            } else if (retainFocus === "replace") {
                this.replaceInput.focus();
            }
        });
    }

    private onFindKeydown(event: KeyboardEvent) {
        if (this.tryHandlePanelCommandHotkey(event) || this.tryHandlePanelEscape(event)) {
            return;
        }
        // 仅在查找输入框聚焦时生效（本监听只绑在查找框上）
        if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.clickLast();
            return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.clickNext();
        }
    }

    private onReplaceKeydown(event: KeyboardEvent) {
        if (this.tryHandlePanelCommandHotkey(event) || this.tryHandlePanelEscape(event)) {
            return;
        }
        // 仅在替换输入框聚焦时生效（本监听只绑在替换框上）
        if (event.key === "Enter" && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            void this.clickReplaceAll();
            return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            void this.clickReplace();
        }
    }

    private onPanelKeydown(event: KeyboardEvent) {
        if (this.tryHandlePanelEscape(event)) {
            return;
        }
        this.tryHandlePanelCommandHotkey(event);
    }

    private tryHandlePanelEscape(event: KeyboardEvent): boolean {
        if (event.isComposing || event.defaultPrevented) {
            return false;
        }
        if (event.key !== "Escape") {
            return false;
        }
        event.preventDefault();
        event.stopPropagation();
        this.clickClose();
        return true;
    }

    /** 面板内 Ctrl/Cmd+F、Ctrl/Cmd+H（焦点在输入框时命令回调可能不触发） */
    private tryHandlePanelCommandHotkey(event: KeyboardEvent): boolean {
        if (event.isComposing || event.defaultPrevented) {
            return false;
        }
        const mod = event.ctrlKey || event.metaKey;
        if (!mod || event.altKey || event.shiftKey) {
            return false;
        }
        const key = event.key.toLowerCase();
        if (key === "f") {
            event.preventDefault();
            event.stopPropagation();
            this.applyHotkeyIntent("find");
            return true;
        }
        if (key === "h") {
            event.preventDefault();
            event.stopPropagation();
            this.applyHotkeyIntent("replace");
            return true;
        }
        return false;
    }

    private toggleOption(key: MatchOptionKey) {
        switch (key) {
            case "caseSensitive":
                this.caseSensitive = !this.caseSensitive;
                break;
            case "wholeWord":
                this.wholeWord = !this.wholeWord;
                break;
            case "regex":
                this.regex = !this.regex;
                break;
            case "preserveCase":
                this.preserveCase = !this.preserveCase;
                this.syncOptionButtons();
                return;
            case "selectionOnly":
                this.selectionOnly = !this.selectionOnly;
                if (this.selectionOnly) {
                    this.captureSelectionScope();
                    if (
                        this.rememberedSelectionScope.size === 0
                        && this.rememberedVisualBlockIds.length === 0
                        && this.rememberedTableCellRefs.length === 0
                    ) {
                        this.clearSelectionScopeVisual();
                        showMessage(this.i18n.selectionOnlyNoScope, 3000, "info");
                    } else {
                        this.syncSelectionScopeVisual();
                    }
                } else {
                    this.rememberedSelectionScope = new Map();
                    this.selectionScopeVisualKind = null;
                    this.rememberedVisualBlockIds = [];
                    this.rememberedTableCellRefs = [];
                    this.clearSelectionScopeVisual();
                }
                break;
        }
        this.syncOptionButtons();
        void this.highlightHitResult(this.searchText, true);
    }

    private captureSelectionScope() {
        const {scope, kind, visualBlockIds, tableCellRefs} = captureSelectionScopeWithKind(this.edit, {
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeWidget: this.includeWidget,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        });
        this.rememberedSelectionScope = cloneSelectionScope(scope);
        this.selectionScopeVisualKind = kind;
        this.rememberedVisualBlockIds = visualBlockIds;
        this.rememberedTableCellRefs = tableCellRefs;
    }

    private resolveScopeForSearch(): SelectionScope {
        if (!this.selectionOnly) {
            return new Map();
        }
        const blocks = collectSearchableBlocks(this.edit, {
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeWidget: this.includeWidget,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        });
        const live = getSelectionScope(this.edit, blocks);
        if (live.size > 0) {
            // 仍有现场选区时同步提示（用户改选了范围）；光标挪走后 live 为空则保持冻结提示
            const captured = captureSelectionScopeWithKind(this.edit, {
                includeAttributeView: this.includeAttributeView,
                includeTable: this.includeTable,
                includeBlockquote: this.includeBlockquote,
                includeCallout: this.includeCallout,
                includeMathBlock: this.includeMathBlock,
                includeEmbedBlock: this.includeEmbedBlock,
                includeWidget: this.includeWidget,
                includeCodeBlock: this.includeCodeBlock,
                includeMermaid: this.includeMermaid,
                includeInlineMemo: this.includeInlineMemo,
                restrictInlineTypes: this.restrictInlineTypes,
            });
            this.selectionScopeVisualKind = captured.kind ?? this.selectionScopeVisualKind;
            this.rememberedVisualBlockIds = captured.visualBlockIds;
            this.rememberedTableCellRefs = captured.tableCellRefs;
            // 整库块选：按当前 AV DOM 刷新 unitKey（视图/布局切换后 id 会变）
            const refreshed = refreshWholeAttributeViewSelectionScope(
                this.edit,
                live,
                this.rememberedVisualBlockIds,
                blocks,
            );
            this.rememberedSelectionScope = cloneSelectionScope(refreshed);
            this.syncSelectionScopeVisual();
            return refreshed;
        }
        // 现场选区已空：保留冻结块选，并对整库 AV 用当前 DOM 重建选区键
        const refreshed = refreshWholeAttributeViewSelectionScope(
            this.edit,
            this.rememberedSelectionScope,
            this.rememberedVisualBlockIds,
            blocks,
        );
        this.rememberedSelectionScope = cloneSelectionScope(refreshed);
        return refreshed;
    }

    private syncSelectionScopeVisual() {
        if (
            !this.selectionOnly
            || (
                this.rememberedSelectionScope.size === 0
                && this.rememberedVisualBlockIds.length === 0
                && this.rememberedTableCellRefs.length === 0
            )
        ) {
            this.teardownSelectionScopeLayoutSync();
            this.clearSelectionScopeVisual();
            return;
        }
        try {
            applySelectionScopeVisual(
                this.edit,
                this.rememberedSelectionScope,
                this.selectionScopeVisualKind,
                this.rememberedVisualBlockIds,
                this.rememberedTableCellRefs,
            );
            this.setupSelectionScopeLayoutSync();
        } catch (error) {
            console.warn("[page-search] selection scope visual failed", error);
        }
    }

    private clearSelectionScopeVisual() {
        this.teardownSelectionScopeLayoutSync();
        try {
            clearSelectionScopeVisual(this.edit);
        } catch {
            // ignore
        }
    }

    /**
     * 选区提示坐标随布局变化失效：监听任意元素 scroll（捕获）与窗口/内容区尺寸变化，
     * rAF 合并后按冻结 scope 重画。只读写 .protyle-content 叠加层。
     */
    private setupSelectionScopeLayoutSync() {
        this.teardownSelectionScopeLayoutSync();

        const scheduleRedraw = () => {
            if (this.selectionScopeLayoutRaf) {
                return;
            }
            this.selectionScopeLayoutRaf = window.requestAnimationFrame(() => {
                this.selectionScopeLayoutRaf = 0;
                if (!this.selectionOnly) {
                    return;
                }
                try {
                    applySelectionScopeVisual(
                        this.edit,
                        this.rememberedSelectionScope,
                        this.selectionScopeVisualKind,
                        this.rememberedVisualBlockIds,
                        this.rememberedTableCellRefs,
                    );
                } catch (error) {
                    console.warn("[page-search] selection scope visual relayout failed", error);
                }
            });
        };

        // scroll 不冒泡，但捕获阶段可收到任意滚动目标（含表格/数据库内部滚动）
        document.addEventListener("scroll", scheduleRedraw, true);
        window.addEventListener("resize", scheduleRedraw);
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener("resize", scheduleRedraw);
        visualViewport?.addEventListener("scroll", scheduleRedraw);

        const resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => {
                scheduleRedraw();
            })
            : null;
        this.edit.querySelectorAll<HTMLElement>(
            ".protyle-content, .protyle-wysiwyg, .protyle-preview",
        ).forEach((el) => {
            resizeObserver?.observe(el);
        });

        this.stopSelectionScopeLayoutSync = () => {
            document.removeEventListener("scroll", scheduleRedraw, true);
            window.removeEventListener("resize", scheduleRedraw);
            visualViewport?.removeEventListener("resize", scheduleRedraw);
            visualViewport?.removeEventListener("scroll", scheduleRedraw);
            resizeObserver?.disconnect();
            if (this.selectionScopeLayoutRaf) {
                window.cancelAnimationFrame(this.selectionScopeLayoutRaf);
                this.selectionScopeLayoutRaf = 0;
            }
        };
    }

    private teardownSelectionScopeLayoutSync() {
        this.stopSelectionScopeLayoutSync?.();
        this.stopSelectionScopeLayoutSync = null;
    }

    private syncOptionButtons() {
        this.setOptionActive("caseSensitive", this.caseSensitive);
        this.setOptionActive("wholeWord", this.wholeWord);
        this.setOptionActive("regex", this.regex);
        this.setOptionActive("preserveCase", this.preserveCase);
        this.setOptionActive("selectionOnly", this.selectionOnly);
    }

    private setOptionActive(key: MatchOptionKey, active: boolean) {
        const button = this.optionButtons.get(key);
        button?.classList.toggle("is-active", active);
        button?.setAttribute("aria-pressed", active ? "true" : "false");
    }

    private syncReplaceButtons() {
        const enumerateMode = this.isRestrictEnumerateMode();
        const modeBlocked = isEditorReplaceModeBlocked(this.edit);
        const current = this.getCurrentMatch();
        const canReplaceCurrent = !enumerateMode
            && !modeBlocked
            && Boolean(current && isMatchWritable(this.edit, current));
        const hasWritable = !enumerateMode
            && !modeBlocked
            && this.resultMatches.some((match) => isMatchWritable(this.edit, match));
        this.replaceBtn?.classList.toggle("is-disabled", !canReplaceCurrent);
        this.replaceAllBtn?.classList.toggle("is-disabled", !hasWritable);
        this.replaceBtn?.setAttribute("aria-disabled", canReplaceCurrent ? "false" : "true");
        this.replaceAllBtn?.setAttribute("aria-disabled", hasWritable ? "false" : "true");
    }

    /** 空查询 + 限制激活：枚举行内宿主，禁用替换（仍可展开替换栏） */
    private isRestrictEnumerateMode(): boolean {
        return shouldEnumerateRestrictInline(this.searchText, this.restrictInlineTypes);
    }

    private toggleReplaceVisible() {
        this.replaceVisible = !this.replaceVisible;
        this.syncReplaceVisibility();
        if (this.replaceVisible) {
            this.replaceInput.focus();
            this.replaceInput.select();
        } else {
            this.input.focus();
        }
    }

    private syncReplaceVisibility() {
        if (this.replaceRow) {
            this.replaceRow.hidden = !this.replaceVisible;
        }
        this.dialog.classList.toggle("search-dialog--replace-visible", this.replaceVisible);
        this.replaceToggleBtn?.classList.toggle("is-expanded", this.replaceVisible);
        this.replaceToggleBtn?.setAttribute("aria-expanded", this.replaceVisible ? "true" : "false");
    }

    private getCurrentMatch(): SearchMatch | null {
        if (this.resultIndex < 1 || this.resultIndex > this.resultMatches.length) {
            return null;
        }
        return this.resultMatches[this.resultIndex - 1] ?? null;
    }

    private updateCountLabel() {
        this.countEl.textContent = formatSearchCountLabel(this.resultIndex, this.resultCount);
    }

    private async calculateSearchResults(value: string, change: boolean): Promise<SearchMatch[]> {
        const keyword = value.trim();
        if (!keyword && !isRestrictInlineActive(this.restrictInlineTypes)) {
            this.clearHighlight();
            this.resultMatches = [];
            this.resultCount = 0;
            this.resultIndex = 0;
            this.updateCountLabel();
            this.syncReplaceButtons();
            return [];
        }

        if (change) {
            this.resultIndex = 0;
            this.resultCount = 0;
            this.updateCountLabel();
        }

        const generation = ++this.searchGeneration;
        const {matches, error} = await calculateSearchMatches(this.plugin, this.edit, value, {
            caseSensitive: this.caseSensitive,
            wholeWord: this.wholeWord,
            regex: this.regex,
            selectionOnly: this.selectionOnly,
            selectionScope: this.resolveScopeForSearch(),
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeWidget: this.includeWidget,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeFoldedBlocks: this.includeFoldedBlocks,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        });
        if (generation !== this.searchGeneration) {
            return this.resultMatches;
        }

        if (error) {
            this.clearHighlight();
            this.resultMatches = [];
            this.resultCount = 0;
            this.resultIndex = 0;
            this.updateCountLabel();
            this.syncReplaceButtons();
            showMessage(this.i18n.invalidRegex.replace("{error}", error), 4000, "error");
            return [];
        }

        this.resultMatches = matches;
        this.resultCount = matches.length;
        if (change && matches.length > 0) {
            // 仅 change=true 时按光标/选区锚定；失败回退第 1 项。替换后走 keepIndex，不走这里。
            this.resultIndex = resolveInitialMatchIndex(matches, {
                anchorRange: this.getSearchAnchorRange(),
                modeBlocked: isEditorReplaceModeBlocked(this.edit),
            });
        } else if (this.resultIndex > matches.length) {
            this.resultIndex = matches.length;
        }
        this.updateCountLabel();
        this.syncReplaceButtons();
        return matches;
    }

    async highlightHitResult(value: string, change: boolean) {
        const matches = await this.calculateSearchResults(value, change);
        const trimmed = value.trim();

        // 空查询且未限制：清空高亮（旧行为）。限制激活的空查询走下方枚举高亮。
        if (!trimmed && !shouldEnumerateRestrictInline(value, this.restrictInlineTypes)) {
            this.clearHighlight();
            void rpcEmitSearchState(this.plugin, {
                type: "clear",
                clientId: this.plugin.getClientId(),
                query: "",
            });
            return;
        }

        const hasAnyRange = matches.some((match) => Boolean(match.range));
        if (!hasAnyRange) {
            this.clearHighlight();
            return;
        }

        this.clearHighlight();
        const HighlightCtor = (window as any).Highlight as {
            new (...ranges: Range[]): Highlight;
        };
        // 正文与行内公式统一黄/橙 CSS Highlight；备注仍用虚线下划线
        const textRanges: Range[] = [];
        for (const match of matches) {
            if (!match.range || match.highlightKind === "inline-memo") {
                continue;
            }
            textRanges.push(match.range);
        }
        if (typeof HighlightCtor === "function" && (CSS as any).highlights) {
            if (textRanges.length) {
                (CSS as any).highlights.set("search-results", new HighlightCtor(...textRanges));
            }
        } else if (textRanges.length) {
            console.warn("[page-search] CSS Custom Highlight API unavailable");
        }

        this.syncMemoUnderlineVisual();
        this.plugin.updateLastHighlightComponent(this.root);

        if (change && this.resultIndex >= 1) {
            this.scrollIntoRanges(this.resultIndex - 1, false);
        }
    }

    private clearHighlight() {
        const highlights = (CSS as any).highlights;
        if (highlights) {
            highlights.delete("search-results");
            highlights.delete("search-focus");
            // 旧版曾用独立 math/memo Highlight 名；清理以免残留底色
            highlights.delete("search-math-results");
            highlights.delete("search-math-focus");
            highlights.delete("search-memo-results");
            highlights.delete("search-memo-focus");
        }
        this.teardownMemoUnderlineLayoutSync();
        clearMemoUnderlineVisual(this.edit);
    }

    /** 备注命中：黄/橙虚线下划线（叠加层，不打开浮层、不污染内容 DOM） */
    private syncMemoUnderlineVisual() {
        const memoRanges: Range[] = [];
        for (const match of this.resultMatches) {
            if (match.highlightKind === "inline-memo" && match.range) {
                memoRanges.push(match.range);
            }
        }
        if (!memoRanges.length) {
            this.teardownMemoUnderlineLayoutSync();
            clearMemoUnderlineVisual(this.edit);
            return;
        }
        const focusMatch = this.getCurrentMatch();
        const focusRange = focusMatch?.highlightKind === "inline-memo"
            ? (focusMatch.range ?? null)
            : null;
        try {
            applyMemoUnderlineVisual(this.edit, memoRanges, focusRange);
        } catch (error) {
            console.warn("[page-search] memo underline visual failed", error);
            return;
        }
        if (!this.stopMemoUnderlineLayoutSync) {
            this.setupMemoUnderlineLayoutSync();
        }
    }

    private setupMemoUnderlineLayoutSync() {
        this.teardownMemoUnderlineLayoutSync();

        const scheduleRedraw = () => {
            if (this.memoUnderlineLayoutRaf) {
                return;
            }
            this.memoUnderlineLayoutRaf = window.requestAnimationFrame(() => {
                this.memoUnderlineLayoutRaf = 0;
                if (!this.resultMatches.some((m) => m.highlightKind === "inline-memo" && m.range)) {
                    return;
                }
                // 只重绘，不重建监听，避免滚动时反复 add/remove
                const memoRanges: Range[] = [];
                for (const match of this.resultMatches) {
                    if (match.highlightKind === "inline-memo" && match.range) {
                        memoRanges.push(match.range);
                    }
                }
                const focusMatch = this.getCurrentMatch();
                const focusRange = focusMatch?.highlightKind === "inline-memo"
                    ? (focusMatch.range ?? null)
                    : null;
                try {
                    applyMemoUnderlineVisual(this.edit, memoRanges, focusRange);
                } catch (error) {
                    console.warn("[page-search] memo underline relayout failed", error);
                }
            });
        };

        document.addEventListener("scroll", scheduleRedraw, true);
        window.addEventListener("resize", scheduleRedraw);
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener("resize", scheduleRedraw);
        visualViewport?.addEventListener("scroll", scheduleRedraw);

        const resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => {
                scheduleRedraw();
            })
            : null;
        this.edit.querySelectorAll<HTMLElement>(
            ".protyle-content, .protyle-wysiwyg, .protyle-preview",
        ).forEach((el) => {
            resizeObserver?.observe(el);
        });

        this.stopMemoUnderlineLayoutSync = () => {
            document.removeEventListener("scroll", scheduleRedraw, true);
            window.removeEventListener("resize", scheduleRedraw);
            visualViewport?.removeEventListener("resize", scheduleRedraw);
            visualViewport?.removeEventListener("scroll", scheduleRedraw);
            resizeObserver?.disconnect();
            if (this.memoUnderlineLayoutRaf) {
                window.cancelAnimationFrame(this.memoUnderlineLayoutRaf);
                this.memoUnderlineLayoutRaf = 0;
            }
        };
    }

    private teardownMemoUnderlineLayoutSync() {
        this.stopMemoUnderlineLayoutSync?.();
        this.stopMemoUnderlineLayoutSync = null;
    }

    private onEventBus(event: CustomEvent) {
        // 数据库事务：列改名 / 切视图 / 单元格等 → avRender 重建 DOM，需重搜
        if (
            isAttrViewWsTransaction(event.detail)
            && isAttrViewRelevantToEdit(this.edit, event.detail)
        ) {
            this.scheduleAttrViewResearch();
            return;
        }

        if (["savedoc", "rename"].includes(event.detail?.cmd)) {
            clearTimeout(this.typingTimer);
            this.typingTimer = window.setTimeout(() => {
                if (this.plugin.isLastHighlightComponent(this.root)) {
                    void this.highlightHitResult(this.searchText, false).then(() => {
                        if (this.resultIndex >= 1) {
                            this.scrollIntoRanges(this.resultIndex - 1, false);
                        }
                    });
                } else {
                    void this.calculateSearchResults(this.searchText, false);
                }
            }, DONE_TYPING_MS);
            return;
        }

        if (
            ["loaded-protyle-dynamic", "loaded-protyle-static", "switch-protyle", "switch-protyle-mode"]
                .includes(event.type)
        ) {
            const protyleElement = event.detail?.protyle?.element;
            if (!protyleElement) {
                return;
            }
            const layoutTabContainer = protyleElement.closest(".layout-tab-container");
            if (layoutTabContainer && !layoutTabContainer.contains(this.root)) {
                return;
            }
            const blockPopover = protyleElement.closest(".block__popover");
            if (blockPopover && !blockPopover.contains(this.root)) {
                return;
            }

            clearTimeout(this.typingTimer);
            this.typingTimer = window.setTimeout(() => {
                this.resultIndex = 0;
                this.updateCountLabel();
                // 文档重载后 DOM 几何变化，按冻结 scope 重画选区提示
                if (this.selectionOnly) {
                    this.syncSelectionScopeVisual();
                }
                if (this.plugin.isLastHighlightComponent(this.root)) {
                    void this.highlightHitResult(this.searchText, false);
                } else {
                    void this.calculateSearchResults(this.searchText, false);
                }
            }, DONE_TYPING_MS);
        }
    }

    /**
     * 数据库结构性重建后重新匹配并画高亮。
     * 使用 change=false 保留当前跳转索引；跳转滚动期间不响应，避免误重置到第一项。
     */
    private scheduleAttrViewResearch() {
        if (!this.includeAttributeView) {
            return;
        }
        if (!this.searchText.trim()) {
            return;
        }
        if (Date.now() < this.avWatchPausedUntil) {
            return;
        }
        window.clearTimeout(this.avRefreshTimer);
        this.avRefreshTimer = window.setTimeout(() => {
            if (Date.now() < this.avWatchPausedUntil) {
                return;
            }
            const keepIndex = this.resultIndex;
            if (this.plugin.isLastHighlightComponent(this.root)) {
                void this.highlightHitResult(this.searchText, false).then(() => {
                    if (this.resultCount === 0) {
                        return;
                    }
                    // 尽量停留在原序号；越界则夹到末项
                    this.resultIndex = Math.min(
                        Math.max(keepIndex, 1),
                        this.resultCount,
                    );
                    this.updateCountLabel();
                    this.scrollIntoRanges(this.resultIndex - 1, false);
                });
            } else {
                void this.calculateSearchResults(this.searchText, false);
            }
        }, AV_REFRESH_DEBOUNCE_MS);
    }

    private pauseAvWatch(ms: number = 600) {
        this.avWatchPausedUntil = Math.max(this.avWatchPausedUntil, Date.now() + ms);
        window.clearTimeout(this.avRefreshTimer);
    }

    private scrollIntoRanges(index: number, scroll: boolean = true) {
        void this.scrollIntoRangesAsync(index, scroll);
    }

    /**
     * 跳转命中：若开启折叠内容搜索，先展开路径上的非标题折叠块，再滚动高亮。
     * 匹配阶段不展开，避免改文档状态与性能开销。
     */
    private async scrollIntoRangesAsync(index: number, scroll: boolean = true) {
        // 滚动可能触发 AV 虚拟滚动 DOM 突变；短暂暂停观察，防止重搜重置索引
        if (scroll) {
            this.pauseAvWatch(600);
        }
        const match = this.resultMatches[index];
        const range = match?.range;
        if (!range) {
            return;
        }

        if (this.includeFoldedBlocks) {
            const ancestor = range.commonAncestorContainer;
            const fromNode = ancestor.nodeType === Node.TEXT_NODE
                ? ancestor.parentElement
                : ancestor as Element | null;
            const foldIds = collectNonHeadingFoldedAncestorIds(fromNode);
            if (foldIds.length) {
                this.pauseAvWatch(800);
                await unfoldNonHeadingFoldedBlocks(foldIds);
                await waitForLayout();
            }
        }

        if (scroll) {
            const commonAncestor = range.commonAncestorContainer;
            const ancestorElement = commonAncestor.nodeType === Node.TEXT_NODE
                ? commonAncestor.parentElement
                : commonAncestor as Element;

            if (ancestorElement) {
                const scrollContainers = findScrollContainers(ancestorElement);
                scrollContainers.forEach((container) => {
                    scrollContainerToRange(range, container);
                });
                if (scrollContainers.length === 0) {
                    const docContentElement = this.edit.querySelector(
                        ":scope > .protyle:not(.fn__none) :is(.protyle-content:not(.fn__none), .protyle-preview:not(.fn__none))",
                    ) as HTMLElement | null;
                    if (docContentElement) {
                        scrollContainerToRange(range, docContentElement);
                    }
                }
            }
        }

        const HighlightCtor = (window as any).Highlight as {
            new (...ranges: Range[]): Highlight;
        };
        if (typeof HighlightCtor === "function" && (CSS as any).highlights) {
            const highlights = (CSS as any).highlights;
            highlights.delete("search-focus");
            highlights.delete("search-math-focus"); // 旧版独立公式焦点名
            if (match.highlightKind !== "inline-memo") {
                highlights.set("search-focus", new HighlightCtor(range));
            }
            this.plugin.updateLastHighlightComponent(this.root);
        }
        this.syncMemoUnderlineVisual();
        this.syncReplaceButtons();
    }

    private clickLast() {
        if (this.resultCount === 0) {
            this.resultIndex = 0;
        } else if (this.resultIndex > 1 && this.resultIndex <= this.resultCount) {
            this.resultIndex -= 1;
        } else {
            this.resultIndex = this.resultCount;
        }
        this.updateCountLabel();
        this.scrollIntoRanges(this.resultIndex - 1);
    }

    private clickNext() {
        if (this.resultCount === 0) {
            this.resultIndex = 0;
        } else if (this.resultIndex < this.resultCount) {
            this.resultIndex += 1;
        } else {
            this.resultIndex = 1;
        }
        this.updateCountLabel();
        this.scrollIntoRanges(this.resultIndex - 1);
    }

    private clickClose() {
        this.clearHighlight();
        this.plugin.closeCurrentSearchDialog(this.root, {broadcast: true});
    }

    /**
     * 新搜索锚定用：优先打开时快照，其次一次性读取当前编辑器选区。
     * 不挂 selectionchange；焦点已在搜索框时 live selection 通常无效。
     */
    private getSearchAnchorRange(): Range | null {
        if (this.restoreEditorRange && this.isRangeStillValid(this.restoreEditorRange)) {
            return this.restoreEditorRange;
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }
        const range = selection.getRangeAt(0);
        if (!this.isRangeInEditor(range)) {
            return null;
        }
        try {
            return range.cloneRange();
        } catch {
            return null;
        }
    }

    /**
     * 仅当焦点仍在编辑器（尚未进入本面板）时更新快照，避免覆盖打开时的位置。
     */
    private captureEditorCaretIfNeeded() {
        const active = document.activeElement;
        if (active && this.root.contains(active)) {
            return;
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return;
        }
        const range = selection.getRangeAt(0);
        if (!this.isRangeInEditor(range)) {
            return;
        }
        try {
            this.restoreEditorRange = range.cloneRange();
        } catch {
            // Range 异常时保持旧快照
        }
    }

    private restoreEditorFocus() {
        const preferred = this.getPreferredRestoreRange();
        if (preferred && this.isRangeStillValid(preferred)) {
            try {
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(preferred);
            } catch {
                // 忽略失效 Range
            }
            const editable = this.findFocusableNear(preferred);
            if (editable) {
                editable.focus({preventScroll: true});
                return;
            }
        }

        const wysiwyg = this.edit.querySelector<HTMLElement>(
            ':scope > .protyle:not(.fn__none) .protyle-wysiwyg[contenteditable="true"], '
            + '.protyle:not(.fn__none) .protyle-wysiwyg[contenteditable="true"]',
        ) ?? this.edit.querySelector<HTMLElement>('[contenteditable="true"]');
        wysiwyg?.focus({preventScroll: true});
    }

    /** 已跳转到某条匹配时优先落在该匹配；否则用打开前快照 */
    private getPreferredRestoreRange(): Range | null {
        if (this.resultIndex >= 1) {
            const match = this.resultMatches[this.resultIndex - 1];
            if (match?.range && this.isRangeStillValid(match.range)) {
                return match.range;
            }
        }
        return this.restoreEditorRange;
    }

    private isRangeInEditor(range: Range): boolean {
        const node = range.commonAncestorContainer;
        const el = node.nodeType === Node.ELEMENT_NODE
            ? node as Element
            : node.parentElement;
        if (!el || this.root.contains(el)) {
            return false;
        }
        return this.edit.contains(el);
    }

    private isRangeStillValid(range: Range): boolean {
        try {
            const node = range.startContainer;
            if (!node.isConnected) {
                return false;
            }
            const el = node.nodeType === Node.ELEMENT_NODE
                ? node as Element
                : node.parentElement;
            return Boolean(el && this.edit.contains(el) && !this.root.contains(el));
        } catch {
            return false;
        }
    }

    private findFocusableNear(range: Range): HTMLElement | null {
        const node = range.startContainer;
        const el = node.nodeType === Node.ELEMENT_NODE
            ? node as Element
            : node.parentElement;
        if (!el) {
            return null;
        }
        const editable = el.closest('[contenteditable="true"]') as HTMLElement | null;
        if (editable && this.edit.contains(editable) && !this.root.contains(editable)) {
            return editable;
        }
        return null;
    }

    /**
     * 替换当前：不可替则提示并跳到下一项；可替走 Protyle transaction。
     */
    private async clickReplace() {
        if (this.replaceBusy || this.resultCount === 0 || this.isRestrictEnumerateMode()) {
            return;
        }
        if (isEditorReplaceModeBlocked(this.edit)) {
            showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
            return;
        }
        if (this.resultIndex < 1) {
            this.clickNext();
        }
        const match = this.getCurrentMatch();
        if (!match) {
            return;
        }
        if (!match.replaceable) {
            const msg = match.blockType === ATTRIBUTE_VIEW_TYPE
                ? this.i18n.replaceAttributeViewUnsupported
                : match.unitId === MERMAID_UNIT_ID
                    ? this.i18n.replaceMermaidUnsupported
                    : this.i18n.replaceCurrentUnsupported;
            showMessage(msg, 3000, "info");
            this.clickNext();
            return;
        }

        const keepIndex = this.resultIndex;
        this.replaceBusy = true;
        try {
            const result = replaceCurrentMatchInEditor(
                this.edit,
                match,
                this.replaceText,
                {preserveCase: this.preserveCase},
            );
            if (result.error === "readonly-or-preview") {
                showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
                return;
            }
            if (result.error === "protyle-missing") {
                showMessage(this.i18n.replaceProtyleMissing, 4000, "error");
                return;
            }
            if (result.replacedCount === 0) {
                showMessage(this.i18n.replaceCurrentUnsupported, 3000, "info");
                this.clickNext();
                return;
            }

            this.clearHighlight();
            // 替换后保持相对索引，不按光标重新锚定
            await this.highlightHitResult(this.searchText, false);
            if (this.resultCount > 0) {
                this.resultIndex = Math.min(keepIndex, this.resultCount);
                this.updateCountLabel();
                this.scrollIntoRanges(this.resultIndex - 1, false);
            }
            showMessage(this.i18n.replaceCurrentDone, 2000, "info");
            void rpcEmitSearchState(this.plugin, {
                type: "clear",
                clientId: this.plugin.getClientId(),
                query: this.searchText,
            });
        } finally {
            this.replaceBusy = false;
        }
    }

    private async clickReplaceAll() {
        if (this.replaceBusy || this.resultCount === 0 || this.isRestrictEnumerateMode()) {
            return;
        }
        if (isEditorReplaceModeBlocked(this.edit)) {
            showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
            return;
        }
        const confirmText = this.i18n.replaceAllConfirm.replace(
            "{count}",
            String(this.resultCount),
        );
        const confirmed = await confirmDialog(
            this.i18n.replaceAllConfirmTitle,
            confirmText,
        );
        if (!confirmed) {
            return;
        }

        this.replaceBusy = true;
        try {
            const result = replaceAllMatchesInEditor(
                this.edit,
                this.resultMatches,
                this.replaceText,
                {preserveCase: this.preserveCase},
            );
            if (result.error === "readonly-or-preview") {
                showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
                return;
            }
            if (result.error === "protyle-missing") {
                showMessage(this.i18n.replaceProtyleMissing, 4000, "error");
                return;
            }

            this.clearHighlight();
            await this.highlightHitResult(this.searchText, false);
            showMessage(
                this.i18n.replaceAllResult
                    .replace("{replacedCount}", String(result.replacedCount))
                    .replace("{skippedCount}", String(result.skippedCount)),
                4000,
                "info",
            );
            void rpcEmitSearchState(this.plugin, {
                type: "clear",
                clientId: this.plugin.getClientId(),
                query: this.searchText,
            });
        } finally {
            this.replaceBusy = false;
        }
    }

    /**
     * 思源原生 Menu + b3-switch：匹配范围设置（全局持久化）。
     * 一级：限制查找 ▸ / 是否查找 ▸ / 折叠块内容
     * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/plugin/Menu.ts
     */
    private openSettingsMenu(anchor: HTMLElement) {
        this.closeSettingsMenu();
        const menu = new Menu("page-search-settings", () => {
            if (this.settingsMenu === menu) {
                this.settingsMenu = null;
            }
        });
        this.settingsMenu = menu;
        menu.addItem({
            id: "page-search-restrict-inline",
            icon: "iconFilter",
            label: this.i18n.settingsRestrictInline,
            type: "submenu",
            submenu: this.buildRestrictInlineSubmenuItems(),
            bind: (element) => {
                this.attachMenuHelpTip(element, this.i18n.settingsRestrictInlineHint);
            },
        });
        menu.addItem({
            id: "page-search-include-scope",
            icon: "iconList",
            label: this.i18n.settingsIncludeScope,
            type: "submenu",
            submenu: [
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-inline-memo",
                    icon: "iconM",
                    label: this.i18n.settingsIncludeInlineMemo,
                    checked: this.includeInlineMemo,
                    helpTip: this.i18n.settingsIncludeInlineMemoHint,
                    onChange: (checked) => {
                        void this.setIncludeInlineMemo(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-math-block",
                    icon: "iconMath",
                    label: this.i18n.settingsIncludeMathBlock,
                    checked: this.includeMathBlock,
                    onChange: (checked) => {
                        void this.setIncludeMathBlock(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-code-block",
                    icon: "iconCode",
                    label: this.i18n.settingsIncludeCodeBlock,
                    checked: this.includeCodeBlock,
                    onChange: (checked) => {
                        void this.setIncludeCodeBlock(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-table",
                    icon: "iconTable",
                    label: this.i18n.settingsIncludeTable,
                    checked: this.includeTable,
                    onChange: (checked) => {
                        void this.setIncludeTable(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-attribute-view",
                    icon: "iconDatabase",
                    label: this.i18n.settingsIncludeAttributeView,
                    checked: this.includeAttributeView,
                    onChange: (checked) => {
                        void this.setIncludeAttributeView(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-embed-block",
                    icon: "iconSQL",
                    label: this.i18n.settingsIncludeEmbedBlock,
                    checked: this.includeEmbedBlock,
                    onChange: (checked) => {
                        void this.setIncludeEmbedBlock(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-blockquote",
                    icon: "iconQuote",
                    label: this.i18n.settingsIncludeBlockquote,
                    checked: this.includeBlockquote,
                    onChange: (checked) => {
                        void this.setIncludeBlockquote(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-callout",
                    icon: "iconCallout",
                    label: this.i18n.settingsIncludeCallout,
                    checked: this.includeCallout,
                    onChange: (checked) => {
                        void this.setIncludeCallout(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-mermaid",
                    icon: "iconCode",
                    label: this.i18n.settingsIncludeMermaid,
                    checked: this.includeMermaid,
                    onChange: (checked) => {
                        void this.setIncludeMermaid(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-widget",
                    icon: "iconBoth",
                    label: this.i18n.settingsIncludeWidget,
                    checked: this.includeWidget,
                    onChange: (checked) => {
                        void this.setIncludeWidget(checked);
                    },
                }),
            ],
            bind: (element) => {
                this.attachMenuHelpTip(element, this.i18n.settingsIncludeScopeHint);
            },
        });
        menu.addItem(this.buildMatchSwitchMenuItem({
            id: "page-search-include-folded-blocks",
            icon: "iconContract",
            label: this.i18n.settingsIncludeFoldedBlocks,
            checked: this.includeFoldedBlocks,
            helpTip: this.i18n.settingsIncludeFoldedBlocksHint,
            onChange: (checked) => {
                void this.setIncludeFoldedBlocks(checked);
            },
        }));
        const rect = anchor.getBoundingClientRect();
        menu.open({
            x: rect.left,
            y: rect.bottom,
            isLeft: true,
        });
        // 面板拖动后会设 z-index:9999，需抬高原生菜单，避免被搜索窗盖住
        const panelZ = Number.parseInt(getComputedStyle(this.dialog).zIndex || "0", 10);
        const menuZ = Number.isFinite(panelZ) && panelZ > 0 ? panelZ + 1 : 10000;
        menu.element.style.zIndex = String(menuZ);
        // 菜单挂在 document，用 data-name 标记便于样式与关闭兜底
        menu.element.setAttribute("data-name", "page-search-settings");
    }

    /** 关闭齿轮设置菜单（搜索窗销毁时必须调用，避免菜单残留） */
    private closeSettingsMenu() {
        try {
            this.settingsMenu?.close();
        } catch {
            // ignore
        }
        this.settingsMenu = null;
        // 兜底：思源 Menu 为全局单例，按 data-name 清掉本插件菜单
        try {
            const globalMenu = (window as any).siyuan?.menus?.menu;
            const el = globalMenu?.element as HTMLElement | undefined;
            if (el?.getAttribute("data-name") === "page-search-settings") {
                globalMenu.remove();
            }
        } catch {
            // ignore
        }
    }

    private buildRestrictInlineSubmenuItems(): IMenu[] {
        return RESTRICT_INLINE_TYPE_ALLOWLIST.map((type) => {
            const isMemo = type === INLINE_MEMO_TYPE;
            const isMath = type === INLINE_MATH_TYPE;
            const memoLocked = isMemo && !canRestrictInlineMemo(this.includeInlineMemo);
            let helpTip: string | undefined;
            if (memoLocked) {
                helpTip = this.i18n.settingsRestrictInlineMemoHint;
            } else if (isMemo) {
                helpTip = this.i18n.settingsRestrictInlineMemoOnHint;
            } else if (isMath) {
                helpTip = this.i18n.settingsRestrictInlineMathHint;
            }
            return this.buildMatchSwitchMenuItem({
                id: `page-search-restrict-${type}`,
                icon: RESTRICT_INLINE_ICONS[type],
                label: this.restrictInlineTypeLabel(type),
                checked: !memoLocked && hasRestrictInlineType(this.restrictInlineTypes, type),
                disabled: memoLocked,
                helpTip,
                onChange: (checked) => {
                    void this.setRestrictInlineType(type, checked);
                },
            });
        });
    }

    private restrictInlineTypeLabel(type: RestrictInlineType): string {
        switch (type) {
            case "block-ref":
                return this.i18n.settingsRestrictBlockRef;
            case "a":
                return this.i18n.settingsRestrictLink;
            case "strong":
                return this.i18n.settingsRestrictStrong;
            case "em":
                return this.i18n.settingsRestrictEm;
            case "u":
                return this.i18n.settingsRestrictU;
            case "s":
                return this.i18n.settingsRestrictS;
            case "mark":
                return this.i18n.settingsRestrictMark;
            case "sup":
                return this.i18n.settingsRestrictSup;
            case "sub":
                return this.i18n.settingsRestrictSub;
            case "code":
                return this.i18n.settingsRestrictCode;
            case "kbd":
                return this.i18n.settingsRestrictKbd;
            case "tag":
                return this.i18n.settingsRestrictTag;
            case "inline-math":
                return this.i18n.settingsRestrictInlineMath;
            case "inline-memo":
                return this.i18n.settingsRestrictInlineMemo;
            default: {
                const _exhaustive: never = type;
                return _exhaustive;
            }
        }
    }

    private attachMenuHelpTip(element: HTMLElement, helpTip: string) {
        const labelEl = element.querySelector(".b3-menu__label");
        const helpHtml = `<svg class="b3-menu__icon page-search-menu-help ariaLabel" data-position="north"`
            + ` aria-label="${escapeAttr(helpTip)}">`
            + `<use xlink:href="#iconHelp"></use></svg>`;
        if (labelEl) {
            labelEl.insertAdjacentHTML("afterend", helpHtml);
        } else {
            element.insertAdjacentHTML("beforeend", helpHtml);
        }
        element.querySelector(".page-search-menu-help")?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
    }

    private buildMatchSwitchMenuItem(options: {
        id: string;
        icon: string;
        label: string;
        checked: boolean;
        onChange: (checked: boolean) => void;
        /** 标签旁圆圈问号，悬浮显示说明（思源 ariaLabel 提示） */
        helpTip?: string;
        /** 灰显且不可切换（备注限制门闩）；运行期可改 DOM disabled */
        disabled?: boolean;
    }): IMenu {
        const {id, icon, label, checked, onChange, helpTip, disabled} = options;
        return {
            id,
            icon,
            label,
            disabled: Boolean(disabled),
            bind: (element) => {
                if (helpTip) {
                    this.attachMenuHelpTip(element, helpTip);
                }
                element.insertAdjacentHTML(
                    "beforeend",
                    `<span class="fn__flex-1"></span>`
                    + `<input class="b3-switch fn__flex-center" type="checkbox"`
                    + `${checked ? " checked" : ""}`
                    + `${disabled ? " disabled" : ""}>`,
                );
                const input = element.querySelector(".b3-switch") as HTMLInputElement | null;
                if (!input) {
                    return;
                }
                input.addEventListener("click", (event) => {
                    event.stopPropagation();
                });
                // 始终绑定：门闩可能在菜单打开后因「是否·备注」切换而变化，勿捕获初始 disabled
                input.addEventListener("change", () => {
                    if (isMenuItemDisabled(element) || input.disabled) {
                        return;
                    }
                    onChange(input.checked);
                });
            },
            click: (element, event) => {
                // 与思源 MenuItem 一致：读当前 disabled 属性（可被 syncRestrictInlineMemoMenuGate 更新）
                if (isMenuItemDisabled(element)) {
                    return true;
                }
                const target = event.target as HTMLElement | null;
                if (target?.closest(".b3-switch, .page-search-menu-help")) {
                    return true;
                }
                const input = element.querySelector(".b3-switch") as HTMLInputElement | null;
                if (!input || input.disabled) {
                    return true;
                }
                input.checked = !input.checked;
                input.dispatchEvent(new Event("change"));
                return true;
            },
        };
    }

    /**
     * 菜单仍打开时，同步「限制查找 · 行内备注」门闩 UI。
     * 思源 Menu 无 updateItem：子项在 open 时一次性构建，须直接改 DOM。
     * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/menus/Menu.ts MenuItem
     */
    private syncRestrictInlineMemoMenuGate() {
        const root = this.getOpenSettingsMenuElement();
        if (!root) {
            return;
        }
        const item = root.querySelector<HTMLElement>(
            `[data-id="page-search-restrict-${INLINE_MEMO_TYPE}"]`,
        );
        if (!item) {
            return;
        }
        const locked = !canRestrictInlineMemo(this.includeInlineMemo);
        const input = item.querySelector(".b3-switch") as HTMLInputElement | null;
        const help = item.querySelector(".page-search-menu-help");

        if (locked) {
            item.setAttribute("disabled", "disabled");
            if (input) {
                input.checked = false;
                input.disabled = true;
            }
            help?.setAttribute("aria-label", this.i18n.settingsRestrictInlineMemoHint);
            return;
        }

        item.removeAttribute("disabled");
        if (input) {
            input.disabled = false;
            input.checked = hasRestrictInlineType(this.restrictInlineTypes, INLINE_MEMO_TYPE);
        }
        help?.setAttribute("aria-label", this.i18n.settingsRestrictInlineMemoOnHint);
    }

    private getOpenSettingsMenuElement(): HTMLElement | null {
        const fromRef = this.settingsMenu?.element;
        if (fromRef?.getAttribute("data-name") === "page-search-settings") {
            return fromRef;
        }
        return document.querySelector<HTMLElement>('.b3-menu[data-name="page-search-settings"]');
    }

    /** 用户切换：写 prefs + 同步其它面板 + 重搜 */
    private async setIncludeAttributeView(value: boolean) {
        if (this.includeAttributeView === value) {
            return;
        }
        this.includeAttributeView = value;
        await rpcSetPrefs(this.plugin, {includeAttributeView: value});
        this.plugin.syncIncludeAttributeView?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeTable(value: boolean) {
        if (this.includeTable === value) {
            return;
        }
        this.includeTable = value;
        await rpcSetPrefs(this.plugin, {includeTable: value});
        this.plugin.syncIncludeTable?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeBlockquote(value: boolean) {
        if (this.includeBlockquote === value) {
            return;
        }
        this.includeBlockquote = value;
        await rpcSetPrefs(this.plugin, {includeBlockquote: value});
        this.plugin.syncIncludeBlockquote?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeCallout(value: boolean) {
        if (this.includeCallout === value) {
            return;
        }
        this.includeCallout = value;
        await rpcSetPrefs(this.plugin, {includeCallout: value});
        this.plugin.syncIncludeCallout?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeMathBlock(value: boolean) {
        if (this.includeMathBlock === value) {
            return;
        }
        this.includeMathBlock = value;
        await rpcSetPrefs(this.plugin, {includeMathBlock: value});
        this.plugin.syncIncludeMathBlock?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeEmbedBlock(value: boolean) {
        if (this.includeEmbedBlock === value) {
            return;
        }
        this.includeEmbedBlock = value;
        await rpcSetPrefs(this.plugin, {includeEmbedBlock: value});
        this.plugin.syncIncludeEmbedBlock?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeWidget(value: boolean) {
        if (this.includeWidget === value) {
            return;
        }
        this.includeWidget = value;
        await rpcSetPrefs(this.plugin, {includeWidget: value});
        this.plugin.syncIncludeWidget?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeCodeBlock(value: boolean) {
        if (this.includeCodeBlock === value) {
            return;
        }
        this.includeCodeBlock = value;
        await rpcSetPrefs(this.plugin, {includeCodeBlock: value});
        this.plugin.syncIncludeCodeBlock?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeMermaid(value: boolean) {
        if (this.includeMermaid === value) {
            return;
        }
        this.includeMermaid = value;
        await rpcSetPrefs(this.plugin, {includeMermaid: value});
        this.plugin.syncIncludeMermaid?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeFoldedBlocks(value: boolean) {
        if (this.includeFoldedBlocks === value) {
            return;
        }
        this.includeFoldedBlocks = value;
        await rpcSetPrefs(this.plugin, {includeFoldedBlocks: value});
        this.plugin.syncIncludeFoldedBlocks?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeInlineMemo(value: boolean) {
        if (this.includeInlineMemo === value) {
            return;
        }
        this.includeInlineMemo = value;
        // 关「是否·备注」时踢掉限制里的 inline-memo（与 coerce 一致）
        const restrictInlineTypes = normalizeRestrictInlineTypes(this.restrictInlineTypes, {
            includeInlineMemo: value,
        });
        this.restrictInlineTypes = restrictInlineTypes;
        await rpcSetPrefs(this.plugin, {includeInlineMemo: value});
        this.plugin.syncIncludeInlineMemo?.(value, this);
        this.plugin.syncRestrictInlineTypes?.(restrictInlineTypes, this);
        this.syncRestrictInlineMemoMenuGate();
        void this.highlightHitResult(this.searchText, true);
    }

    private setRestrictInlineType(type: RestrictInlineType, enabled: boolean) {
        const next = toggleRestrictInlineType(
            this.restrictInlineTypes,
            type,
            enabled,
            {includeInlineMemo: this.includeInlineMemo},
        );
        if (
            next.length === this.restrictInlineTypes.length
            && next.every((token, i) => token === this.restrictInlineTypes[i])
        ) {
            return;
        }
        this.restrictInlineTypes = next;
        // 限制查找仅会话内生效，不写入 prefs
        this.plugin.syncRestrictInlineTypes?.(next, this);
        void this.highlightHitResult(this.searchText, true);
    }

    /**
     * 其它面板同步过来的 prefs 值（不再写存储）。
     * 由插件 host 在 prefs 变更后调用。
     */
    applyIncludeAttributeView(value: boolean) {
        if (this.includeAttributeView === value) {
            return;
        }
        this.includeAttributeView = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeTable(value: boolean) {
        if (this.includeTable === value) {
            return;
        }
        this.includeTable = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeBlockquote(value: boolean) {
        if (this.includeBlockquote === value) {
            return;
        }
        this.includeBlockquote = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeCallout(value: boolean) {
        if (this.includeCallout === value) {
            return;
        }
        this.includeCallout = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeMathBlock(value: boolean) {
        if (this.includeMathBlock === value) {
            return;
        }
        this.includeMathBlock = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeEmbedBlock(value: boolean) {
        if (this.includeEmbedBlock === value) {
            return;
        }
        this.includeEmbedBlock = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeWidget(value: boolean) {
        if (this.includeWidget === value) {
            return;
        }
        this.includeWidget = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeCodeBlock(value: boolean) {
        if (this.includeCodeBlock === value) {
            return;
        }
        this.includeCodeBlock = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeMermaid(value: boolean) {
        if (this.includeMermaid === value) {
            return;
        }
        this.includeMermaid = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeFoldedBlocks(value: boolean) {
        if (this.includeFoldedBlocks === value) {
            return;
        }
        this.includeFoldedBlocks = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeInlineMemo(value: boolean) {
        if (this.includeInlineMemo === value) {
            return;
        }
        this.includeInlineMemo = value;
        this.restrictInlineTypes = normalizeRestrictInlineTypes(this.restrictInlineTypes, {
            includeInlineMemo: value,
        });
        this.syncRestrictInlineMemoMenuGate();
        void this.highlightHitResult(this.searchText, true);
    }

    applyRestrictInlineTypes(value: RestrictInlineType[]) {
        const next = normalizeRestrictInlineTypes(value, {
            includeInlineMemo: this.includeInlineMemo,
        });
        if (
            next.length === this.restrictInlineTypes.length
            && next.every((token, i) => token === this.restrictInlineTypes[i])
        ) {
            return;
        }
        this.restrictInlineTypes = next;
        void this.highlightHitResult(this.searchText, true);
    }
}

/** 思源内置确认框（替代 window.confirm） */
function confirmDialog(title: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        confirm(title, text, () => finish(true), () => finish(false));
    });
}

function iconUse(href: string): string {
    return `<svg class="icon--14_14"><use href="${href}"></use></svg>`;
}

/** 与思源 MenuItem 一致：button[disabled] 表示不可点 */
function isMenuItemDisabled(element: HTMLElement): boolean {
    return element.getAttribute("disabled") != null;
}

/** 展开/折叠替换行：chevron */
function replaceToggleIcon(): string {
    return `<span class="search-chevron" aria-hidden="true"></span>`;
}

function selectionOnlyIcon(): string {
    return `<svg class="icon--14_14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4" aria-hidden="true">
  <path d="M4 2.75H2.75V5" />
  <path d="M12 2.75H13.25V5" />
  <path d="M4 13.25H2.75V11" />
  <path d="M12 13.25H13.25V11" />
  <path d="M5.25 6H10.75" />
  <path d="M5.25 8H10.75" />
  <path d="M5.25 10H8.75" />
</svg>`;
}

function settingsGearIcon(): string {
    return iconUse("#iconSettings");
}

function wholeWordIcon(): string {
    return `<svg class="icon--14_14 icon--whole-word" viewBox="0 0 22 18" aria-hidden="true">
  <path d="M2.6 3.2V14.8M2.6 3.2H4.9M2.6 14.8H4.9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>
  <path d="M19.4 3.2V14.8M17.1 3.2H19.4M17.1 14.8H19.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>
  <text x="11" y="11" text-anchor="middle" fill="currentColor" font-size="8" font-family="sans-serif">ab</text>
  <path d="M7.25 13.2H14.75" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.15"/>
</svg>`;
}

function circleQuestionIcon(): string {
    // 显式 stroke 图标；思源全局 svg{fill:currentColor} 会把空心圆填成黑点，需 class + CSS 覆盖
    return `<svg class="icon--14_14 icon--help-q" viewBox="0 0 16 16" aria-hidden="true">
  <circle class="help-ring" cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.35"/>
  <path class="help-stem" d="M5.9 6.05c0-1.15.95-1.95 2.1-1.95 1.15 0 2.1.8 2.1 1.95 0 .9-.5 1.4-1.2 1.8-.55.3-.85.55-.85 1.2v.25" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
  <circle class="help-dot" cx="8" cy="11.55" r="0.85" fill="currentColor" stroke="none"/>
</svg>`;
}

/** VS Code codicon-replace */
function replaceOneIcon(): string {
    return `<svg class="icon--14_14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M3.221 3.739l2.261 2.269L7.7 3.784l-.7-.7-1.012 1.007-.008-1.6a.523.523 0 0 1 .5-.526H8V1H6.48A1.482 1.482 0 0 0 5 2.489V4.1L3.927 3.033l-.706.706zm6.67 1.794h.01c.183.311.451.467.806.467.393 0 .706-.168.94-.503.236-.335.353-.78.353-1.333 0-.511-.1-.913-.301-1.207-.201-.295-.488-.442-.86-.442-.405 0-.718.194-.938.581h-.01V1H9v4.919h.89v-.386zm-.015-1.061v-.34c0-.248.058-.448.175-.601a.54.54 0 0 1 .445-.23.49.49 0 0 1 .436.233c.104.154.155.368.155.643 0 .33-.056.587-.169.768a.524.524 0 0 1-.47.27.495.495 0 0 1-.411-.211.853.853 0 0 1-.16-.532zM9 12.769c-.256.154-.625.231-1.108.231-.563 0-1.02-.178-1.369-.533-.349-.355-.523-.813-.523-1.374 0-.648.186-1.158.56-1.53.374-.376.875-.563 1.5-.563.433 0 .746.06.94.179v.998a1.26 1.26 0 0 0-.792-.276c-.325 0-.583.1-.774.298-.19.196-.283.468-.283.816 0 .338.09.603.272.797.182.191.431.287.749.287.282 0 .558-.092.828-.276v.946zM4 7L3 8v6l1 1h7l1-1V8l-1-1H4zm0 1h7v6H4V8z"/>
</svg>`;
}

/** VS Code codicon-replace-all */
function replaceAllIcon(): string {
    return `<svg class="icon--14_14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M11.6 2.677c.147-.31.356-.465.626-.465.248 0 .44.118.573.353.134.236.201.557.201.966 0 .443-.078.798-.235 1.067-.156.268-.365.402-.627.402-.237 0-.416-.125-.537-.374h-.008v.31H11V1h.593v1.677h.008zm-.016 1.1a.78.78 0 0 0 .107.426c.071.113.163.169.274.169.136 0 .24-.072.314-.216.075-.145.113-.35.113-.615 0-.22-.035-.39-.104-.514-.067-.124-.164-.187-.29-.187-.12 0-.219.062-.297.185a.886.886 0 0 0-.117.48v.272zM4.12 7.695L2 5.568l.662-.662 1.006 1v-1.51A1.39 1.39 0 0 1 5.055 3H7.4v.905H5.055a.49.49 0 0 0-.468.493l.007 1.5.949-.944.656.656-2.08 2.085zM9.356 4.93H10V3.22C10 2.408 9.685 2 9.056 2c-.135 0-.285.024-.45.073a1.444 1.444 0 0 0-.388.167v.665c.237-.203.487-.304.75-.304.261 0 .392.156.392.469l-.6.103c-.506.086-.76.406-.76.961 0 .263.061.473.183.631A.61.61 0 0 0 8.69 5c.29 0 .509-.16.657-.48h.009v.41zm.004-1.355v.193a.75.75 0 0 1-.12.436.368.368 0 0 1-.313.17.276.276 0 0 1-.22-.095.38.38 0 0 1-.08-.248c0-.222.11-.351.332-.389l.4-.067zM7 12.93h-.644v-.41h-.009c-.148.32-.367.48-.657.48a.61.61 0 0 1-.507-.235c-.122-.158-.183-.368-.183-.63 0-.556.254-.876.76-.962l.6-.103c0-.313-.13-.47-.392-.47-.263 0-.513.102-.75.305v-.665c.095-.063.224-.119.388-.167.165-.049.315-.073.45-.073.63 0 .944.407.944 1.22v1.71zm-.64-1.162v-.193l-.4.068c-.222.037-.333.166-.333.388 0 .1.027.183.08.248a.276.276 0 0 0 .22.095.368.368 0 0 0 .312-.17c.08-.116.12-.26.12-.436zM9.262 13c.321 0 .568-.058.738-.173v-.71a.9.9 0 0 1-.552.207.619.619 0 0 1-.5-.215c-.12-.145-.181-.345-.181-.598 0-.26.063-.464.189-.612a.644.644 0 0 1 .516-.223c.194 0 .37.069.528.207v-.749c-.129-.09-.338-.134-.626-.134-.417 0-.751.14-1.001.422-.249.28-.373.662-.373 1.148 0 .42.116.764.349 1.03.232.267.537.4.913.4zM2 9l1-1h9l1 1v5l-1 1H3l-1-1V9zm1 0v5h9V9H3zm3-2l1-1h7l1 1v5l-1 1V7H6z"/>
</svg>`;
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function findScrollContainers(element: Element): HTMLElement[] {
    const containers: HTMLElement[] = [];
    let current: Element | null = element;

    while (current && current !== document.body) {
        const htmlElement = current as HTMLElement;
        const overflowY = window.getComputedStyle(htmlElement).overflowY;
        const overflowX = window.getComputedStyle(htmlElement).overflowX;
        const canScrollY = (overflowY === "auto" || overflowY === "scroll")
            && htmlElement.scrollHeight > htmlElement.clientHeight;
        const canScrollX = (overflowX === "auto" || overflowX === "scroll")
            && htmlElement.scrollWidth > htmlElement.clientWidth;
        if (canScrollY || canScrollX) {
            containers.push(htmlElement);
        }
        current = current.parentElement;
    }

    return containers;
}

function scrollContainerToRange(range: Range, container: HTMLElement) {
    const rangeRect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const containerStyle = window.getComputedStyle(container);
    const rangeCenterX = (rangeRect.left + rangeRect.right) / 2;
    const overflowY = containerStyle.overflowY;
    const overflowX = containerStyle.overflowX;
    const canScrollY = (overflowY === "auto" || overflowY === "scroll")
        && container.scrollHeight > container.clientHeight;
    const canScrollX = (overflowX === "auto" || overflowX === "scroll")
        && container.scrollWidth > container.clientWidth;

    if (canScrollY) {
        const rangeCenterY = (rangeRect.top + rangeRect.bottom) / 2;
        const rangeCenterYInContent = rangeCenterY - containerRect.top + container.scrollTop;
        const targetScrollTop = rangeCenterYInContent - container.clientHeight / 2;
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        container.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
    }

    if (canScrollX) {
        const rangeCenterXInContent = rangeCenterX - containerRect.left + container.scrollLeft;
        const targetScrollLeft = rangeCenterXInContent - container.clientWidth / 2;
        const maxScrollLeft = container.scrollWidth - container.clientWidth;
        container.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));
    }
}
