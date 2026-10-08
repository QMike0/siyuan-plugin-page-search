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
    logicalRowOffset,
    logicalTableRows,
    ownTableRows,
    shouldEnumerateRestrictInline,
    tableCellPosition,
    type RestrictInlineType,
} from "../shared";
import type {IMenu, Plugin} from "siyuan";
import {confirm, Menu, showMessage} from "siyuan";
import {rpcSetPrefs} from "./kernel-client";
import {
    collectSearchableBlocks,
    collectMindmapPreviewUnits,
    HTML_BLOCK_UNIT_ID,
    MERMAID_UNIT_ID,
    resolveDocRoot,
    TABLE_TYPE,
    type CollectSearchableBlocksOptions,
} from "./blocks";
import {parentElementCrossingShadow} from "./dom-parent";
import {calculateSearchMatches, type SearchPipelineResult} from "./pipeline";
import {createRangeFromBlockOffsets} from "./ranges";
import {fillLiveRanges, rebindChangedRanges, type RebindTarget} from "./corpus/project";
import {MAX_TOUCHED_BLOCKS, watchEditorDom, type EditorDomChange} from "./editor-dom-watch";
import {blockIsInEditor, openBlockInEditor} from "./corpus/locate";
import {revealHiddenTabs, mirrorTabsTitleRange} from "./tabs-reveal";
import {panMindmapIntoView} from "./mindmap-pan";
import {cancelBackgroundCorpusJobs, editorRootId, invalidateDocumentSearchCaches, subscribeIndexSettled} from "./corpus/search";
import {
    isMatchWritable,
    replaceAllMatchesInEditor,
    replaceCurrentMatchInEditor,
} from "./protyle-write";
import {isEditorReplaceModeBlocked} from "./editor-mode";
import {
    cloneSelectionScope,
    getSelectionScope,
    mergeSelectionScopes,
    refreshWholeAttributeViewSelectionScope,
    selectionScopeFromHosts,
    snapshotTableCellTextSelection,
    snapshotTableControlCells,
    type SelectionScope,
    type TableCellTextSelection,
} from "./selection";
import {SearchPanelFrame} from "./panel-frame";
import {resolveSettingsMenuZIndex} from "./panel-layer";
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
    elementsForTableCellRefs,
    type AvScopeVisualRef,
    type SelectionScopeVisualKind,
    type TableCellVisualRef,
} from "./selection-scope-visual";
import {
    applyMemoUnderlineVisual,
    clearMemoUnderlineVisual,
    pulseMemoFocusUnderline,
} from "./memo-underline-visual";
import type {SearchableBlock, SearchMatch} from "./dom-types";
import {
    clearNonHeadingFoldLocally,
    collectNonHeadingFoldedAncestorIds,
    consumeUnfoldedOuterHeadingId,
    isUnderNonHeadingCssFold,
    listBlocksUnfoldedAfterHeading,
    unfoldNonHeadingFoldedBlocks,
    waitForLayout,
} from "./fold";

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
/** 补 Range 时按块采集的上限，超过就整篇采集一次。 */
const MAX_SCOPED_REPAIR_BLOCKS = 64;

/**
 * Range 还连在文档上、没有缩成空点。思源换掉节点时，旧 Range 会缩到父节点上。
 * 备注 Range 选的是宿主内容，宿主还在就算有效。
 */
function rangeStillPainted(match: SearchMatch): boolean {
    const range = match.range;
    if (!range) {
        return false;
    }
    try {
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
            return false;
        }
    } catch {
        return false;
    }
    if (!range.collapsed || match.end <= match.start) {
        return true;
    }
    if (match.highlightKind !== "inline-memo") {
        return false;
    }
    const host = range.startContainer;
    return host.nodeType === Node.ELEMENT_NODE
        && (host as Element).matches(`[data-type~="${INLINE_MEMO_TYPE}"]`);
}

/**
 * 命中很多时不能把全部 Range 一次传给构造函数，参数个数超过引擎上限会整轮高亮失败。
 * 先建空的 Highlight，再逐个 add。
 */
function newHighlight(ranges: readonly Range[]): any | null {
    const HighlightCtor = (window as any).Highlight;
    if (typeof HighlightCtor !== "function" || !(CSS as any).highlights) {
        return null;
    }
    try {
        const highlight = new HighlightCtor();
        if (typeof highlight.add === "function") {
            for (let index = 0; index < ranges.length; index += 1) {
                highlight.add(ranges[index]);
            }
            return highlight;
        }
    } catch {
        // 空构造不可用时退回分批传入
    }
    return new HighlightCtor(...ranges.slice(0, 4096));
}

/** 结果列表：固定行高，只渲染视口附近的行。 */
const RESULTS_ITEM_HEIGHT = 26;
const RESULTS_LIST_PADDING = 4;
const RESULTS_MAX_HEIGHT = 240;
const RESULTS_OVERSCAN = 5;

/** 「是否搜索 · 标题」级别 1–6（对应 data-subtype h1–h6） */
export type HeadingIncludeLevel = 1 | 2 | 3 | 4 | 5 | 6;

const HEADING_INCLUDE_LEVELS: HeadingIncludeLevel[] = [1, 2, 3, 4, 5, 6];

function headingIncludePrefKey(
    level: HeadingIncludeLevel,
): `includeHeadingH${HeadingIncludeLevel}` {
    return `includeHeadingH${level}`;
}

export interface SearchBarI18n {
    searchPlaceholder: string;
    replacePlaceholder: string;
    searchPrev: string;
    searchNext: string;
    searchClose: string;
    selectionOnly: string;
    matchCase: string;
    wholeWord: string;
    /** 查找方法：关键字 */
    searchMethodKeyword: string;
    /** 查找方法：正则表达式 */
    searchMethodRegex: string;
    preserveCase: string;
    /** 正则开启时 Aa* 的禁用说明 */
    preserveCaseDisabledByRegex: string;
    replaceUnsupportedHelp: string;
    replaceAction: string;
    replaceAllAction: string;
    replaceToggle: string;
    replaceCurrentUnsupported: string;
    /** 单次正则替换：模板展开失败并跳过 */
    replaceRegexExpandFailed: string;
    replaceAttributeViewUnsupported: string;
    replaceMermaidUnsupported: string;
    replaceHtmlBlockUnsupported: string;
    /** 富文本单元格：源码在属性里，改画面文字不会被保存 */
    replaceTableRichUnsupported: string;
    /** 单元格编辑器还开着 */
    replaceTableCellEditingUnsupported: string;
    /** 同一张虚拟表里另有格子还在编辑，写回会盖掉它 */
    replaceTablePendingEdit: string;
    replaceModeUnsupported: string;
    /** 文档标题替换失败（重命名校验/接口） */
    replaceDocTitleFailed: string;
    /** 文档标题替换结果为空 */
    replaceDocTitleEmpty: string;
    replaceAllConfirm: string;
    replaceAllConfirmTitle: string;
    replaceCurrentDone: string;
    replaceAllResult: string;
    replaceProtyleMissing: string;
    selectionOnlyNoScope: string;
    /** 发布或预览无法调用文档 API 时的说明 */
    searchDegradedLoadedOnly?: string;
    /** 正则或渲染缓存仍在补齐。仅给屏幕阅读器，界面上改为计数闪烁。 */
    searchPartialIndexing?: string;
    searchIndexingBadge?: string;
    /** 结果列表按钮的悬浮说明 */
    resultsPanelToggle?: string;
    resultsPanelEmpty?: string;
    replaceDocTitleUnsupported?: string;
    /** 渲染失败未计入的块数 */
    searchUnrendered?: string;
    settingsTitle: string;
    settingsRestrictInline: string;
    settingsRestrictInlineHint: string;
    settingsIncludeScope: string;
    settingsIncludeScopeHint: string;
    settingsIncludeDocTitle: string;
    settingsIncludeDocTitleHint: string;
    settingsIncludeImageTitle: string;
    settingsIncludeAttributeView: string;
    settingsIncludeTable: string;
    settingsIncludeBlockquote: string;
    settingsIncludeCallout: string;
    settingsIncludeSuperBlock: string;
    settingsIncludeTabs: string;
    settingsIncludeMindmap: string;
    settingsIncludeList: string;
    settingsIncludeListUnordered: string;
    settingsIncludeListOrdered: string;
    settingsIncludeListTask: string;
    settingsIncludeParagraph: string;
    settingsIncludeHeading: string;
    settingsIncludeHeadingH1: string;
    settingsIncludeHeadingH2: string;
    settingsIncludeHeadingH3: string;
    settingsIncludeHeadingH4: string;
    settingsIncludeHeadingH5: string;
    settingsIncludeHeadingH6: string;
    settingsIncludeMathBlock: string;
    settingsIncludeEmbedBlock: string;
    settingsIncludeCodeBlock: string;
    settingsIncludeMermaid: string;
    settingsIncludeHtmlBlock: string;
    settingsIncludeHtmlBlockHint: string;
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
    closeCurrentSearchDialog(element: Element): void;
    onSearchComponentMounted(callback: (event: CustomEvent) => void): void;
    onSearchComponentUnmounted(callback?: (event: CustomEvent) => void): void;
    /** 将文档标题匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeDocTitle?(value: boolean, source?: SearchBar): void;
    /** 将图片标题匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeImageTitle?(value: boolean, source?: SearchBar): void;
    /** 将数据库匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeAttributeView?(value: boolean, source?: SearchBar): void;
    /** 将表格匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeTable?(value: boolean, source?: SearchBar): void;
    /** 将引述块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeBlockquote?(value: boolean, source?: SearchBar): void;
    /** 将提示块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeCallout?(value: boolean, source?: SearchBar): void;
    /** 将超级块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeSuperBlock?(value: boolean, source?: SearchBar): void;
    /** 将页签块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeTabs?(value: boolean, source?: SearchBar): void;
    /** 将思维导图块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeMindmap?(value: boolean, source?: SearchBar): void;
    /** 将无序列表匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeListUnordered?(value: boolean, source?: SearchBar): void;
    /** 将有序列表匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeListOrdered?(value: boolean, source?: SearchBar): void;
    /** 将任务列表匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeListTask?(value: boolean, source?: SearchBar): void;
    /** 将段落块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeParagraph?(value: boolean, source?: SearchBar): void;
    /** 将标题级别（1–6）匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeHeadingLevel?(level: HeadingIncludeLevel, value: boolean, source?: SearchBar): void;
    /** 将公式块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeMathBlock?(value: boolean, source?: SearchBar): void;
    /** 将嵌入块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeEmbedBlock?(value: boolean, source?: SearchBar): void;
    /** 将代码块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeCodeBlock?(value: boolean, source?: SearchBar): void;
    /** 将 Mermaid 匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeMermaid?(value: boolean, source?: SearchBar): void;
    /** 将 HTML 块匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeHtmlBlock?(value: boolean, source?: SearchBar): void;
    /** 将折叠块内容匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeFoldedBlocks?(value: boolean, source?: SearchBar): void;
    /** 将行内备注匹配开关同步到其它已打开的搜索面板（不写 prefs） */
    syncIncludeInlineMemo?(value: boolean, source?: SearchBar): void;
    /** 将限制查找类型同步到其它已打开的搜索面板（不写 prefs） */
    syncRestrictInlineTypes?(value: RestrictInlineType[], source?: SearchBar): void;
    /** 将查找方法（关键字/正则）同步到其它已打开的搜索面板（不写 prefs） */
    syncUseRegex?(value: boolean, source?: SearchBar): void;
}

type MatchOptionKey = "caseSensitive" | "wholeWord" | "preserveCase" | "selectionOnly";

function avScopeRefKey(ref: AvScopeVisualRef): string {
    return `${ref.kind}\0${ref.avBlockId}\0${ref.groupId}\0${ref.rowId}\0${ref.colId ?? ""}`;
}

export class SearchBar {
    readonly root: HTMLElement;
    private readonly edit: Element;
    private readonly plugin: Plugin & SearchBarHost;
    private readonly i18n: SearchBarI18n;
    private readonly input: HTMLInputElement;
    private readonly replaceInput: HTMLInputElement;
    private readonly countEl: HTMLElement;
    private readonly indexStatusEl: HTMLElement;
    private readonly dialog: HTMLElement;

    private searchText = "";
    private replaceText = "";
    private resultIndex = 0;
    private resultCount = 0;
    private resultMatches: SearchMatch[] = [];
    private degradedNotified = false;
    private unrenderedNotified = false;
    private indexSettledTimer: number | null = null;
    private unsubscribeIndexSettled: (() => void) | null = null;
    private locatePending = false;
    /** 跳到大表屏外行时的等待序号。新的跳转会作废上一次。 */
    private tableRevealSerial = 0;
    private staleRefreshPending = false;
    private typingTimer: number | undefined;
    private searchGeneration = 0;

    private caseSensitive = false;
    private wholeWord = false;
    private regex = false;
    private preserveCase = false;
    /** 选区内查找；打开预填关键词不会自动打开 */
    private selectionOnly = false;
    /** 是否匹配文档标题；全局 prefs，默认 true */
    private includeDocTitle = true;
    /** 是否匹配图片标题；全局 prefs，默认 true */
    private includeImageTitle = true;
    /** 是否匹配数据库；全局 prefs，默认 true */
    private includeAttributeView = true;
    /** 是否匹配表格块；全局 prefs，默认 true */
    private includeTable = true;
    /** 是否匹配引述块；全局 prefs，默认 true */
    private includeBlockquote = true;
    /** 是否匹配提示块；全局 prefs，默认 true */
    private includeCallout = true;
    /** 是否匹配超级块；全局 prefs，默认 true */
    private includeSuperBlock = true;
    /** 是否匹配页签块；全局 prefs，默认 true */
    private includeTabs = true;
    /** 是否匹配思维导图块；全局 prefs，默认 true */
    private includeMindmap = true;
    /** 是否匹配无序列表；全局 prefs，默认 true */
    private includeListUnordered = true;
    /** 是否匹配有序列表；全局 prefs，默认 true */
    private includeListOrdered = true;
    /** 是否匹配任务列表；全局 prefs，默认 true */
    private includeListTask = true;
    /** 是否匹配段落块；全局 prefs，默认 true */
    private includeParagraph = true;
    /** 是否匹配各级标题块；全局 prefs，默认 true（≠ 文档标题） */
    private includeHeadingH1 = true;
    private includeHeadingH2 = true;
    private includeHeadingH3 = true;
    private includeHeadingH4 = true;
    private includeHeadingH5 = true;
    private includeHeadingH6 = true;
    /** 是否匹配公式块；全局 prefs，默认 true（不含行内公式） */
    private includeMathBlock = true;
    /** 是否匹配嵌入块；全局 prefs，默认 true */
    private includeEmbedBlock = true;
    /** 是否匹配代码块（非 Mermaid）；全局 prefs，默认 true */
    private includeCodeBlock = true;
    /** 是否匹配 Mermaid；全局 prefs，默认 true */
    private includeMermaid = true;
    /** 是否匹配 HTML 块渲染可见文字；全局 prefs，默认 true */
    private includeHtmlBlock = true;
    /** 是否匹配非标题折叠块内隐藏内容；全局 prefs，默认 false */
    private includeFoldedBlocks = true;
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
    /** 表格框选冻结时的单元格坐标。按下选区按钮时从浮层快照，之后浮层会被思源清掉。 */
    private rememberedTableCellRefs: TableCellVisualRef[] = [];
    /** 数据库格子、勾选行、画廊卡片的冻结坐标。 */
    private rememberedAvScopeRefs: AvScopeVisualRef[] = [];
    /** window 捕获阶段记下的表格格子。click 时思源已经清掉浮层。 */
    private pendingTableCells: HTMLTableCellElement[] | null = null;
    /** 格子内文字划选。编辑器在 document 捕获阶段关闭后，现场 Range 会失效。 */
    private pendingTableCellText: TableCellTextSelection | null = null;
    private readonly onCaptureSelectionPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            this.pendingTableCells = null;
            this.pendingTableCellText = null;
            return;
        }
        const button = target.closest("[data-option=\"selectionOnly\"]");
        if (!button || !this.root.contains(button)) {
            this.pendingTableCells = null;
            this.pendingTableCellText = null;
            return;
        }
        this.pendingTableCellText = snapshotTableCellTextSelection(this.includeImageTitle);
        this.pendingTableCells = snapshotTableControlCells(this.edit);
    };
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
    private stopEditorDomWatch: (() => void) | null = null;
    /** 正文 DOM 突变计数。搜索期间变过，结果里的 Range 可能落在旧节点上。 */
    private domEpoch = 0;
    /** 最近一次搜索开始时的 domEpoch。 */
    private searchEpoch = 0;
    private searchesInFlight = 0;
    private repairAfterSearch = false;
    /** 还没核对过的插入节点所在块。null 表示变动太大，按整篇核对。 */
    private pendingAddedBlocks: Set<string> | null = new Set();
    /** 嵌入块一次渲染出太多子块，补 Range 盖不住，等停下来重搜一次。 */
    private embedRefreshPending = false;
    private domRefreshTimer: number | undefined;
    /** 跳转滚动期间抑制 AV DOM 观察触发的重搜，避免把索引打回 1 */
    private avWatchPausedUntil = 0;
    /** 折叠展开或装载块期间，禁止把当前序号清成 0 */
    private indexResetPausedUntil = 0;
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
    /** 关键字 / 正则表达式方法菜单（对齐官方搜索 method 菜单） */
    private methodMenu: Menu | null = null;
    private searchMethodBtn: HTMLElement | null = null;
    private resultsPanelEl: HTMLElement | null = null;
    private resultsListEl: HTMLElement | null = null;
    private resultsPanelOpen = false;
    private resultsScrollLock = false;
    private resultsScrollRaf = 0;
    private readonly onResultsListScroll = () => {
        if (this.resultsScrollLock || !this.resultsPanelOpen || this.resultCount === 0 || !this.resultsListEl) {
            return;
        }
        if (this.resultsScrollRaf) {
            return;
        }
        this.resultsScrollRaf = window.requestAnimationFrame(() => {
            this.resultsScrollRaf = 0;
            this.renderResultsWindow(this.resultsListEl?.scrollTop ?? 0);
        });
    };
    private readonly onResultsPanelOutsidePointerDown = (event: PointerEvent) => {
        if (!this.resultsPanelOpen) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Node) || this.dialog.contains(target)) {
            return;
        }
        this.closeResultsPanel();
    };

    constructor(options: {
        edit: Element;
        root: HTMLElement;
        plugin: Plugin & SearchBarHost;
        i18n: SearchBarI18n;
        presetText?: string;
        /** 打开时预填替换框（会话恢复；不触发搜索） */
        presetReplaceText?: string;
        /**
         * 预填查找词后是否全选。
         * 选区带入时一般不选；会话恢复 / 空框打开时全选便于覆盖输入。
         */
        selectSearchOnOpen?: boolean;
        /** 打开时是否展开替换行（Ctrl+H） */
        replaceVisible?: boolean;
        /** 是否匹配文档标题（来自全局 prefs） */
        includeDocTitle?: boolean;
        /** 是否匹配图片标题（来自全局 prefs） */
        includeImageTitle?: boolean;
        /** 是否匹配数据库（来自全局 prefs） */
        includeAttributeView?: boolean;
        /** 是否匹配表格块（来自全局 prefs） */
        includeTable?: boolean;
        /** 是否匹配引述块（来自全局 prefs） */
        includeBlockquote?: boolean;
        /** 是否匹配提示块（来自全局 prefs） */
        includeCallout?: boolean;
        /** 是否匹配超级块（来自全局 prefs） */
        includeSuperBlock?: boolean;
        /** 是否匹配页签块（来自全局 prefs） */
        includeTabs?: boolean;
        /** 是否匹配思维导图块（来自全局 prefs） */
        includeMindmap?: boolean;
        /** 是否匹配无序列表（来自全局 prefs） */
        includeListUnordered?: boolean;
        /** 是否匹配有序列表（来自全局 prefs） */
        includeListOrdered?: boolean;
        /** 是否匹配任务列表（来自全局 prefs） */
        includeListTask?: boolean;
        /** 是否匹配段落块（来自全局 prefs） */
        includeParagraph?: boolean;
        includeHeadingH1?: boolean;
        includeHeadingH2?: boolean;
        includeHeadingH3?: boolean;
        includeHeadingH4?: boolean;
        includeHeadingH5?: boolean;
        includeHeadingH6?: boolean;
        /** 是否匹配公式块（来自全局 prefs；不含行内公式） */
        includeMathBlock?: boolean;
        /** 是否匹配嵌入块（来自全局 prefs） */
        includeEmbedBlock?: boolean;
        /** 是否匹配代码块（来自全局 prefs） */
        includeCodeBlock?: boolean;
        /** 是否匹配 Mermaid（来自全局 prefs） */
        includeMermaid?: boolean;
        /** 是否匹配 HTML 块渲染可见文字（来自全局 prefs） */
        includeHtmlBlock?: boolean;
        /** 是否匹配折叠块内容（来自全局 prefs） */
        includeFoldedBlocks?: boolean;
        /** 是否匹配行内备注（来自全局 prefs） */
        includeInlineMemo?: boolean;
        /** 限制查找行内类型（来自全局 prefs） */
        restrictInlineTypes?: RestrictInlineType[];
        /** 查找方法是否为正则（来自全局 prefs；默认关键字） */
        useRegex?: boolean;
    }) {
        this.edit = options.edit;
        this.unsubscribeIndexSettled = subscribeIndexSettled((rootId) => {
            this.scheduleIndexRefresh(rootId);
        });
        this.root = options.root;
        this.plugin = options.plugin;
        this.i18n = options.i18n;
        this.replaceVisible = Boolean(options.replaceVisible);
        this.regex = options.useRegex === true;
        this.includeDocTitle = options.includeDocTitle !== false;
        this.includeImageTitle = options.includeImageTitle !== false;
        this.includeAttributeView = options.includeAttributeView !== false;
        this.includeTable = options.includeTable !== false;
        this.includeBlockquote = options.includeBlockquote !== false;
        this.includeCallout = options.includeCallout !== false;
        this.includeSuperBlock = options.includeSuperBlock !== false;
        this.includeTabs = options.includeTabs !== false;
        this.includeMindmap = options.includeMindmap !== false;
        this.includeListUnordered = options.includeListUnordered !== false;
        this.includeListOrdered = options.includeListOrdered !== false;
        this.includeListTask = options.includeListTask !== false;
        this.includeParagraph = options.includeParagraph !== false;
        this.includeHeadingH1 = options.includeHeadingH1 !== false;
        this.includeHeadingH2 = options.includeHeadingH2 !== false;
        this.includeHeadingH3 = options.includeHeadingH3 !== false;
        this.includeHeadingH4 = options.includeHeadingH4 !== false;
        this.includeHeadingH5 = options.includeHeadingH5 !== false;
        this.includeHeadingH6 = options.includeHeadingH6 !== false;
        this.includeMathBlock = options.includeMathBlock !== false;
        this.includeEmbedBlock = options.includeEmbedBlock !== false;
        this.includeCodeBlock = options.includeCodeBlock !== false;
        this.includeMermaid = options.includeMermaid !== false;
        this.includeHtmlBlock = options.includeHtmlBlock !== false;
        this.includeFoldedBlocks = options.includeFoldedBlocks !== false;
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
        this.indexStatusEl = this.root.querySelector(".search-index-status") as HTMLElement;
        this.resultsPanelEl = this.root.querySelector(".search-results-panel");
        this.resultsListEl = this.root.querySelector(".search-results-panel__list");
        this.replaceRow = this.root.querySelector(".search-row--replace");
        this.replaceToggleBtn = this.root.querySelector('[data-action="toggle-replace"]');
        this.replaceBtn = this.root.querySelector('[data-action="replace"]');
        this.replaceAllBtn = this.root.querySelector('[data-action="replace-all"]');
        this.searchMethodBtn = this.root.querySelector('[data-action="search-method"]');

        for (const key of [
            "caseSensitive",
            "wholeWord",
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
            onSiyuanDialogLayerChange: (hasOpenDialog) => {
                // 原生搜索/设置等 Dialog 打开时收起插件菜单，避免压在 Dialog 上
                if (hasOpenDialog) {
                    this.closeSettingsMenu();
                    this.closeSearchMethodMenu();
                }
            },
        });
        this.stopAvDomWatch = watchAttributeViewDom(this.edit, () => {
            this.scheduleAttrViewResearch();
        });
        this.stopEditorDomWatch = watchEditorDom(this.edit, {
            onMutate: () => {
                this.domEpoch += 1;
            },
            onSettled: (change) => {
                this.noteAddedBlocks(change);
                this.repairHighlightRanges();
            },
        });
        this.plugin.onSearchComponentMounted(this.eventBusHandle);
        this.syncOptionButtons();
        this.syncReplaceVisibility();
        this.syncReplaceButtons();

        // 抢焦点前先记下编辑器光标，关闭时再还回去（对齐 VS Code / Cursor）
        this.captureEditorCaretIfNeeded();

        if (options.presetReplaceText) {
            this.replaceText = options.presetReplaceText;
            this.replaceInput.value = options.presetReplaceText;
        }

        // presetText 预填关键词；selectSearchOnOpen 控制是否全选
        if (options.presetText) {
            this.searchText = options.presetText;
            this.input.value = options.presetText;
            this.input.focus();
            if (options.selectSearchOnOpen !== false) {
                this.input.select();
            }
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

    /** 当前查找框文案（关闭会话恢复用） */
    getSearchText(): string {
        return this.input?.value ?? this.searchText;
    }

    /** 当前替换框文案（关闭会话恢复用） */
    getReplaceText(): string {
        return this.replaceInput?.value ?? this.replaceText;
    }

    destroy() {
        // 关掉面板时作废还在等大表分段挂出的跳转，避免关闭后仍滚动正文。
        this.tableRevealSerial += 1;
        cancelBackgroundCorpusJobs();
        clearTimeout(this.typingTimer);
        clearTimeout(this.avRefreshTimer);
        clearTimeout(this.domRefreshTimer);
        this.stopEditorDomWatch?.();
        this.stopEditorDomWatch = null;
        if (this.indexSettledTimer != null) {
            window.clearTimeout(this.indexSettledTimer);
            this.indexSettledTimer = null;
        }
        this.unsubscribeIndexSettled?.();
        this.unsubscribeIndexSettled = null;
        this.closeSettingsMenu();
        this.closeSearchMethodMenu();
        this.teardownSelectionScopeLayoutSync();
        this.teardownMemoUnderlineLayoutSync();
        this.clearSelectionScopeVisual();
        this.restoreEditorFocus();
        this.clearHighlight();
        this.closeResultsPanel();
        document.removeEventListener("pointerdown", this.onResultsPanelOutsidePointerDown, true);
        window.removeEventListener("pointerdown", this.onCaptureSelectionPointerDown, true);
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
          <div class="search-option search-method-trigger" data-action="search-method" data-method="keyword" title="${escapeAttr(this.i18n.searchMethodKeyword)}" aria-label="${escapeAttr(this.i18n.searchMethodKeyword)}" aria-haspopup="menu" aria-expanded="false" role="button" tabindex="-1">${iconUse("#iconExact")}</div>
        </div>
      </div>
      <div class="search-row__trailing">
        <div class="search-count search-no-drag ariaLabel" data-action="results" data-position="north" role="button" tabindex="-1" aria-expanded="false" aria-label="${escapeAttr(this.i18n.resultsPanelToggle ?? "搜索结果列表")}">0/0</div>
        <span class="search-index-status" aria-live="polite"></span>
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
  <div class="search-results-panel search-no-drag" hidden>
    <div class="search-results-panel__list" role="listbox"></div>
  </div>
</div>`;
    }

    private bindUi() {
        this.input.addEventListener("input", () => {
            this.searchText = this.input.value;
            clearTimeout(this.typingTimer);
            this.typingTimer = window.setTimeout(() => {
                this.typingTimer = undefined;
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

        this.bindToolbarControl('[data-action="results"]', () => {
            this.toggleResultsPanel();
        }, "find");
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
        this.bindToolbarControl('[data-action="search-method"]', (event) => {
            this.openSearchMethodMenu(event.currentTarget as HTMLElement);
        }, "find");

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
        this.resultsListEl?.addEventListener("click", (event) => {
            const target = event.target instanceof Element
                ? event.target.closest<HTMLElement>(".search-results-panel__item")
                : null;
            if (!target) {
                return;
            }
            const index = Number(target.dataset.index);
            if (!Number.isInteger(index)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.clickResultsItem(index);
        });
        this.resultsListEl?.addEventListener("scroll", this.onResultsListScroll);
        document.addEventListener("pointerdown", this.onResultsPanelOutsidePointerDown, true);
        window.addEventListener("pointerdown", this.onCaptureSelectionPointerDown, true);
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
        if (this.resultsPanelOpen) {
            this.closeResultsPanel();
            return true;
        }
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
            case "preserveCase":
                if (this.regex) {
                    return;
                }
                this.preserveCase = !this.preserveCase;
                this.syncOptionButtons();
                return;
            case "selectionOnly":
                this.selectionOnly = !this.selectionOnly;
                if (this.selectionOnly) {
                    this.captureSelectionScope(
                        this.pendingTableCells ?? undefined,
                        this.pendingTableCellText,
                    );
                    if (!this.hasRememberedScopeVisual()) {
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
                    this.rememberedAvScopeRefs = [];
                    this.pendingTableCells = null;
                    this.pendingTableCellText = null;
                    this.clearSelectionScopeVisual();
                }
                break;
        }
        this.syncOptionButtons();
        void this.highlightHitResult(this.searchText, true);
        this.pendingTableCells = null;
        this.pendingTableCellText = null;
    }

    private hasRememberedScopeVisual(): boolean {
        return this.rememberedSelectionScope.size > 0
            || this.rememberedVisualBlockIds.length > 0
            || this.rememberedTableCellRefs.length > 0
            || this.rememberedAvScopeRefs.length > 0;
    }

    private avScopeRefsSame(next: readonly AvScopeVisualRef[]): boolean {
        const previous = this.rememberedAvScopeRefs;
        if (previous.length !== next.length) {
            return false;
        }
        const keys = new Set<string>();
        for (let index = 0; index < previous.length; index += 1) {
            keys.add(avScopeRefKey(previous[index]));
        }
        for (let index = 0; index < next.length; index += 1) {
            if (!keys.has(avScopeRefKey(next[index]))) {
                return false;
            }
        }
        return true;
    }

    private captureSelectionScope(
        tableCells?: readonly HTMLTableCellElement[],
        tableCellText?: TableCellTextSelection | null,
    ) {
        const {scope, kind, visualBlockIds, tableCellRefs, avScopeRefs} = captureSelectionScopeWithKind(this.edit, {
            includeDocTitle: this.includeDocTitle,
            includeImageTitle: this.includeImageTitle,
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeSuperBlock: this.includeSuperBlock,
            includeTabs: this.includeTabs,
            includeMindmap: this.includeMindmap,
            includeListUnordered: this.includeListUnordered,
            includeListOrdered: this.includeListOrdered,
            includeListTask: this.includeListTask,
            includeParagraph: this.includeParagraph,
            includeHeadingH1: this.includeHeadingH1,
            includeHeadingH2: this.includeHeadingH2,
            includeHeadingH3: this.includeHeadingH3,
            includeHeadingH4: this.includeHeadingH4,
            includeHeadingH5: this.includeHeadingH5,
            includeHeadingH6: this.includeHeadingH6,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeHtmlBlock: this.includeHtmlBlock,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        }, tableCells, true, tableCellText);
        this.rememberedSelectionScope = cloneSelectionScope(scope);
        this.selectionScopeVisualKind = kind;
        this.rememberedVisualBlockIds = visualBlockIds;
        this.rememberedTableCellRefs = tableCellRefs;
        this.rememberedAvScopeRefs = avScopeRefs;
    }

    private resolveScopeForSearch(): SelectionScope {
        if (!this.selectionOnly) {
            return new Map();
        }
        const blocks = collectSearchableBlocks(this.edit, {
            includeDocTitle: this.includeDocTitle,
            includeImageTitle: this.includeImageTitle,
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeSuperBlock: this.includeSuperBlock,
            includeTabs: this.includeTabs,
            includeMindmap: this.includeMindmap,
            includeListUnordered: this.includeListUnordered,
            includeListOrdered: this.includeListOrdered,
            includeListTask: this.includeListTask,
            includeParagraph: this.includeParagraph,
            includeHeadingH1: this.includeHeadingH1,
            includeHeadingH2: this.includeHeadingH2,
            includeHeadingH3: this.includeHeadingH3,
            includeHeadingH4: this.includeHeadingH4,
            includeHeadingH5: this.includeHeadingH5,
            includeHeadingH6: this.includeHeadingH6,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeHtmlBlock: this.includeHtmlBlock,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        });
        const pendingCells = this.pendingTableCells && this.pendingTableCells.length > 0
            ? this.pendingTableCells
            : undefined;
        const pendingCellText = this.pendingTableCellText;
        // 已经是整块选区时，不因随后点中的数据库格子把范围收成那一格。
        const followCellSelection = Boolean(pendingCells)
            || this.selectionScopeVisualKind === "table-cells"
            || this.rememberedAvScopeRefs.length > 0;
        const live = getSelectionScope(
            this.edit,
            blocks,
            pendingCells,
            followCellSelection,
            pendingCellText,
        );
        if (live.size > 0) {
            // 仍有现场选区时同步提示（用户改选了范围）；光标挪走后 live 为空则保持冻结提示。
            // 表格浮层在按下按钮时就被清掉，所以这里把刚快照的格子再并进去。
            const captured = captureSelectionScopeWithKind(this.edit, {
                includeDocTitle: this.includeDocTitle,
                includeImageTitle: this.includeImageTitle,
                includeAttributeView: this.includeAttributeView,
                includeTable: this.includeTable,
                includeBlockquote: this.includeBlockquote,
                includeCallout: this.includeCallout,
                includeSuperBlock: this.includeSuperBlock,
                includeTabs: this.includeTabs,
                includeMindmap: this.includeMindmap,
                includeListUnordered: this.includeListUnordered,
                includeListOrdered: this.includeListOrdered,
                includeListTask: this.includeListTask,
                includeParagraph: this.includeParagraph,
                includeHeadingH1: this.includeHeadingH1,
                includeHeadingH2: this.includeHeadingH2,
                includeHeadingH3: this.includeHeadingH3,
                includeHeadingH4: this.includeHeadingH4,
                includeHeadingH5: this.includeHeadingH5,
                includeHeadingH6: this.includeHeadingH6,
                includeMathBlock: this.includeMathBlock,
                includeEmbedBlock: this.includeEmbedBlock,
                includeCodeBlock: this.includeCodeBlock,
                includeMermaid: this.includeMermaid,
                includeHtmlBlock: this.includeHtmlBlock,
                includeInlineMemo: this.includeInlineMemo,
                restrictInlineTypes: this.restrictInlineTypes,
            }, pendingCells, followCellSelection, pendingCellText);
            let scope = captured.scope;
            let tableRefs = captured.tableCellRefs;
            // 数据库选区没变时，补回同时冻结的表格格子，避免打字把表格丢掉。
            // 数据库又选了别的格子时，只跟新的数据库选区，不再并上一次的表格。
            if (
                captured.kind === "table-cells"
                && !pendingCells
                && this.rememberedTableCellRefs.length > 0
                && this.rememberedAvScopeRefs.length > 0
                && this.avScopeRefsSame(captured.avScopeRefs)
            ) {
                const keptCells = elementsForTableCellRefs(this.edit, this.rememberedTableCellRefs);
                if (keptCells.length > 0) {
                    scope = mergeSelectionScopes(scope, selectionScopeFromHosts(blocks, keptCells));
                    tableRefs = this.rememberedTableCellRefs.slice();
                }
            }
            this.selectionScopeVisualKind = captured.kind ?? this.selectionScopeVisualKind;
            this.rememberedVisualBlockIds = captured.visualBlockIds;
            this.rememberedTableCellRefs = tableRefs;
            this.rememberedAvScopeRefs = captured.avScopeRefs;
            // 整库块选才按当前 AV DOM 刷新 unitKey。格子选区的 visualBlockIds 是空的，不会扩成整库。
            const refreshed = refreshWholeAttributeViewSelectionScope(
                this.edit,
                scope,
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
        if (!this.selectionOnly || !this.hasRememberedScopeVisual()) {
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
                this.rememberedAvScopeRefs,
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
                        this.rememberedAvScopeRefs,
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
        this.setOptionActive("preserveCase", this.preserveCase && !this.regex);
        this.setOptionActive("selectionOnly", this.selectionOnly);
        this.syncSearchMethodTrigger();
        this.syncPreserveCaseAvailability();
    }

    /**
     * 触发器图标/文案随当前方法变化（关键字 = Exact，正则 = Regex），对齐官方搜索栏。
     */
    private syncSearchMethodTrigger() {
        const button = this.searchMethodBtn;
        if (!button) {
            return;
        }
        const label = this.regex
            ? this.i18n.searchMethodRegex
            : this.i18n.searchMethodKeyword;
        button.dataset.method = this.regex ? "regex" : "keyword";
        button.setAttribute("title", label);
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-expanded", this.methodMenu ? "true" : "false");
        button.innerHTML = this.regex
            ? iconUse("#iconRegex")
            : iconUse("#iconExact");
    }

    /** 正则开启时灰显 Aa*（捕获组替换与保留大小写互斥） */
    private syncPreserveCaseAvailability() {
        const button = this.optionButtons.get("preserveCase");
        if (!button) {
            return;
        }
        const disabled = this.regex;
        button.classList.toggle("is-disabled", disabled);
        button.setAttribute("aria-disabled", disabled ? "true" : "false");
        const tip = disabled
            ? (this.i18n.preserveCaseDisabledByRegex || this.i18n.preserveCase)
            : this.i18n.preserveCase;
        button.setAttribute("title", tip);
        button.setAttribute("aria-label", tip);
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

    private updateCountLabel(scrollPanelToActive = false) {
        this.countEl.textContent = formatSearchCountLabel(this.resultIndex, this.resultCount);
        if (this.resultsPanelOpen) {
            this.renderResultsPanel(scrollPanelToActive);
        }
    }

    private toggleResultsPanel() {
        if (this.resultsPanelOpen) {
            this.closeResultsPanel();
            return;
        }
        if (!this.resultsPanelEl || !this.resultsListEl) {
            return;
        }
        this.resultsPanelOpen = true;
        this.resultsPanelEl.hidden = false;
        this.countEl.setAttribute("aria-expanded", "true");
        this.renderResultsPanel(true);
    }

    private closeResultsPanel() {
        if (this.resultsScrollRaf) {
            window.cancelAnimationFrame(this.resultsScrollRaf);
            this.resultsScrollRaf = 0;
        }
        this.resultsPanelOpen = false;
        this.countEl?.setAttribute("aria-expanded", "false");
        if (this.resultsPanelEl) {
            this.resultsPanelEl.hidden = true;
        }
        if (this.resultsListEl) {
            this.resultsScrollLock = true;
            this.resultsListEl.innerHTML = "";
            this.resultsListEl.scrollTop = 0;
            this.resultsScrollLock = false;
        }
    }

    private clickResultsItem(index: number) {
        if (index < 0 || index >= this.resultMatches.length) {
            return;
        }
        const previous = this.getCurrentMatch();
        this.resultIndex = index + 1;
        this.updateCountLabel(false);
        const next = this.resultMatches[index];
        this.scrollIntoRanges(
            index,
            true,
            shouldPulseMemoFocusOnNavigate(previous, next),
        );
    }

    private escapeResultsText(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    private formatResultsItemHtml(index: number): string {
        const match = this.resultMatches[index];
        const plain = match?.listText || match?.matchedText || match?.blockId || "";
        const active = index + 1 === this.resultIndex ? " search-results-panel__item--active" : "";
        const title = this.escapeResultsText(plain).replace(/"/g, "&quot;");
        const mark = match?.listMark;
        let body = this.escapeResultsText(plain);
        if (mark && mark.start >= 0 && mark.end <= plain.length && mark.start < mark.end) {
            body = this.escapeResultsText(plain.slice(0, mark.start))
                + `<mark>${this.escapeResultsText(plain.slice(mark.start, mark.end))}</mark>`
                + this.escapeResultsText(plain.slice(mark.end));
        }
        return `<div class="search-results-panel__item${active}" role="option" data-index="${index}" title="${title}">${body}</div>`;
    }

    private resultsContentHeight(): number {
        return RESULTS_LIST_PADDING * 2 + this.resultCount * RESULTS_ITEM_HEIGHT;
    }

    private resultsViewportHeight(): number {
        const measured = this.resultsListEl?.clientHeight ?? 0;
        if (measured > 0) {
            return measured;
        }
        return Math.min(RESULTS_MAX_HEIGHT, this.resultsContentHeight());
    }

    private activeResultsScrollTop(): number {
        const list = this.resultsListEl;
        if (!list || this.resultIndex < 1 || this.resultCount === 0) {
            return list?.scrollTop ?? 0;
        }
        const itemTop = RESULTS_LIST_PADDING + (this.resultIndex - 1) * RESULTS_ITEM_HEIGHT;
        const viewportHeight = this.resultsViewportHeight();
        const contentHeight = list.scrollHeight > 0 ? list.scrollHeight : this.resultsContentHeight();
        const maxScroll = Math.max(0, contentHeight - viewportHeight);
        const next = itemTop - (viewportHeight - RESULTS_ITEM_HEIGHT) / 2;
        return Math.max(0, Math.min(next, maxScroll));
    }

    /** 只画视口附近的行。列表关闭时不调用。 */
    private renderResultsWindow(scrollTop: number) {
        const list = this.resultsListEl;
        if (!list) {
            return;
        }
        const count = this.resultCount;
        const viewportHeight = this.resultsViewportHeight();
        const contentScrollTop = Math.max(0, scrollTop - RESULTS_LIST_PADDING);
        const startIndex = Math.max(0, Math.floor(contentScrollTop / RESULTS_ITEM_HEIGHT) - RESULTS_OVERSCAN);
        const visibleCount = Math.ceil(viewportHeight / RESULTS_ITEM_HEIGHT) + RESULTS_OVERSCAN * 2;
        const endIndex = Math.min(count, startIndex + visibleCount);
        const topSpacerHeight = RESULTS_LIST_PADDING + startIndex * RESULTS_ITEM_HEIGHT;
        const bottomSpacerHeight = RESULTS_LIST_PADDING + (count - endIndex) * RESULTS_ITEM_HEIGHT;
        const items: string[] = [];
        for (let index = startIndex; index < endIndex; index++) {
            items.push(this.formatResultsItemHtml(index));
        }
        this.resultsScrollLock = true;
        list.innerHTML = `<div class="search-results-panel__spacer" style="height:${topSpacerHeight}px"></div>`
            + items.join("")
            + `<div class="search-results-panel__spacer" style="height:${bottomSpacerHeight}px"></div>`;
        list.scrollTop = scrollTop;
        this.resultsScrollLock = false;
    }

    private renderResultsPanel(scrollToActive: boolean) {
        const list = this.resultsListEl;
        if (!this.resultsPanelOpen || !list) {
            return;
        }
        if (this.resultsScrollRaf) {
            window.cancelAnimationFrame(this.resultsScrollRaf);
            this.resultsScrollRaf = 0;
        }
        if (this.resultCount === 0) {
            const emptyText = this.escapeResultsText(this.i18n.resultsPanelEmpty ?? "无匹配结果");
            this.resultsScrollLock = true;
            list.scrollTop = 0;
            list.innerHTML = `<div class="search-results-panel__empty">${emptyText}</div>`;
            this.resultsScrollLock = false;
            return;
        }
        this.renderResultsWindow(list.scrollTop);
        if (!scrollToActive) {
            return;
        }
        const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
        const scrollTop = Math.min(this.activeResultsScrollTop(), maxScroll);
        this.renderResultsWindow(scrollTop);
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
        this.searchEpoch = this.domEpoch;
        this.searchesInFlight += 1;
        let result: SearchPipelineResult;
        try {
            result = await this.runSearchPipeline(value);
        } finally {
            this.searchesInFlight -= 1;
        }
        const {matches, error, degraded, partial, unrendered} = result;
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

        const previous = change ? undefined : this.resultMatches[this.resultIndex - 1];
        this.resultMatches = matches;
        this.resultCount = matches.length;
        this.noteSearchCoverage(degraded, partial, unrendered);
        if (change && matches.length > 0) {
            // 仅 change=true 时按光标/选区锚定；失败回退第 1 项。替换后走 keepIndex，不走这里。
            this.resultIndex = resolveInitialMatchIndex(matches, {
                anchorRange: this.getSearchAnchorRange(),
                modeBlocked: isEditorReplaceModeBlocked(this.edit),
            });
        } else if (previous) {
            const kept = matches.findIndex((match) => {
                return match.blockId === previous.blockId
                    && match.unitId === previous.unitId
                    && match.start === previous.start;
            });
            if (kept >= 0) {
                this.resultIndex = kept + 1;
            } else if (this.resultIndex > matches.length) {
                this.resultIndex = matches.length;
            }
        } else if (this.resultIndex > matches.length) {
            this.resultIndex = matches.length;
        }
        this.updateCountLabel(true);
        this.syncReplaceButtons();
        return matches;
    }

    private runSearchPipeline(value: string): Promise<SearchPipelineResult> {
        return calculateSearchMatches(this.plugin, this.edit, value, {
            caseSensitive: this.caseSensitive,
            wholeWord: this.wholeWord,
            regex: this.regex,
            selectionOnly: this.selectionOnly,
            selectionScope: this.resolveScopeForSearch(),
            includeDocTitle: this.includeDocTitle,
            includeImageTitle: this.includeImageTitle,
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeSuperBlock: this.includeSuperBlock,
            includeTabs: this.includeTabs,
            includeMindmap: this.includeMindmap,
            includeListUnordered: this.includeListUnordered,
            includeListOrdered: this.includeListOrdered,
            includeListTask: this.includeListTask,
            includeParagraph: this.includeParagraph,
            includeHeadingH1: this.includeHeadingH1,
            includeHeadingH2: this.includeHeadingH2,
            includeHeadingH3: this.includeHeadingH3,
            includeHeadingH4: this.includeHeadingH4,
            includeHeadingH5: this.includeHeadingH5,
            includeHeadingH6: this.includeHeadingH6,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeHtmlBlock: this.includeHtmlBlock,
            includeFoldedBlocks: this.includeFoldedBlocks,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        });
    }

    private noteSearchCoverage(degraded?: boolean, partial?: boolean, unrendered?: number) {
        if (degraded && !this.degradedNotified) {
            this.degradedNotified = true;
            showMessage(
                this.i18n.searchDegradedLoadedOnly
                    ?? "当前环境不能读取未加载内容，结果只包含已加载区域",
                5000,
                "info",
            );
        }
        const indexing = Boolean(partial);
        this.countEl.classList.toggle("is-indexing", indexing);
        this.indexStatusEl.textContent = indexing
            ? (this.i18n.searchIndexingBadge ?? "索引中")
            : "";
        if (unrendered && unrendered > 0 && !this.unrenderedNotified) {
            this.unrenderedNotified = true;
            showMessage(
                (this.i18n.searchUnrendered ?? "有 {count} 个块渲染失败，未计入")
                    .replace("{count}", String(unrendered)),
                5000,
                "info",
            );
        }
    }

    /** 后台索引结束时合并成一次刷新，避免补图期间反复全量搜索。 */
    private scheduleIndexRefresh(rootId: string) {
        if (!this.searchText.trim() || editorRootId(this.edit) !== rootId) {
            return;
        }
        if (this.indexSettledTimer != null) {
            window.clearTimeout(this.indexSettledTimer);
        }
        this.indexSettledTimer = window.setTimeout(() => {
            this.indexSettledTimer = null;
            void this.highlightHitResult(this.searchText, false);
        }, 80);
    }

    async highlightHitResult(value: string, change: boolean) {
        const epoch = this.domEpoch;
        const matches = await this.calculateSearchResults(value, change);
        const trimmed = value.trim();

        // 空查询且未限制：清空高亮（旧行为）。限制激活的空查询走下方枚举高亮。
        // 保持原有高亮归属。清空时改归属的话，别的窗口之后只更新计数、不再重画。
        if (!trimmed && !shouldEnumerateRestrictInline(value, this.restrictInlineTypes)) {
            this.clearHighlight();
            return;
        }

        const hasAnyRange = matches.some((match) => Boolean(match.range));
        if (!hasAnyRange) {
            this.clearHighlight();
            this.plugin.updateLastHighlightComponent(this.root);
            this.repairAfterSearchIfNeeded(epoch);
            return;
        }

        this.clearHighlight();
        // 正文与行内公式统一黄/橙 CSS Highlight；备注仍用虚线下划线
        const textRanges: Range[] = [];
        for (const match of matches) {
            if (!match.range || match.highlightKind === "inline-memo") {
                continue;
            }
            textRanges.push(match.range);
            const mirror = mirrorTabsTitleRange(match.range);
            if (mirror) {
                textRanges.push(mirror);
            }
        }
        if (textRanges.length) {
            const highlight = newHighlight(textRanges);
            if (highlight) {
                (CSS as any).highlights.set("search-results", highlight);
            } else {
                console.warn("[page-search] CSS Custom Highlight API unavailable");
            }
        }

        this.syncMemoUnderlineVisual();
        this.plugin.updateLastHighlightComponent(this.root);
        this.repairAfterSearchIfNeeded(epoch);

        if (change && this.resultIndex >= 1) {
            this.scrollIntoRanges(this.resultIndex - 1, false);
        } else if (Date.now() < this.indexResetPausedUntil) {
            const current = this.getCurrentMatch();
            if (current?.range && current.highlightKind !== "inline-memo") {
                this.applyFocusHighlight(current.range);
            } else if (current?.highlightKind === "inline-memo") {
                this.clearSearchFocus();
            }
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
                this.typingTimer = undefined;
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
                this.typingTimer = undefined;
                const preserveIndex = event.type === "loaded-protyle-dynamic"
                    || this.locatePending
                    || Date.now() < this.indexResetPausedUntil;
                if (!preserveIndex) {
                    this.resultIndex = 0;
                    this.updateCountLabel();
                }
                // 文档重载后 DOM 几何变化，按冻结 scope 重画选区提示
                if (this.selectionOnly) {
                    this.syncSelectionScopeVisual();
                }
                // 折叠展开后的刷新由跳转自己做一次；这里并行重搜会抢走序号
                if (this.locatePending) {
                    return;
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

    private pauseIndexReset(ms: number) {
        this.indexResetPausedUntil = Math.max(this.indexResetPausedUntil, Date.now() + ms);
    }

    /**
     * 大表屏外行没有格子 DOM。先把盖住它的占位行滚进视口，等思源把这一段挂出来，再按逻辑行号补 Range。
     * 普通表的行本来就在，这里只是补一次对得上文字的 Range。
     */
    private async revealVirtualTableMatch(
        index: number,
        match: SearchMatch,
        table: HTMLElement,
        serial: number,
    ) {
        const generation = this.searchGeneration;
        const mounted = await this.prepareTableMatchRow(table, match, serial);
        if (serial !== this.tableRevealSerial || generation !== this.searchGeneration || this.replaceBusy) {
            return;
        }
        if (mounted === "ready" && this.bindShownTableMatch(index, match, table)) {
            await this.scrollIntoRangesAsync(index, true, false, false, false);
            return;
        }
        if (mounted !== "pending") {
            table.scrollIntoView({block: "center", inline: "nearest"});
        }
    }

    /** ready：目标行已在画面上。pending：只滚到了占位行，分段还没挂出来。missing：对不上行。 */
    private async prepareTableMatchRow(
        table: HTMLElement,
        match: SearchMatch,
        serial: number,
    ): Promise<"missing" | "ready" | "pending"> {
        const logicalRow = this.logicalRowOfMatch(match);
        if (logicalRow === null) {
            return "missing";
        }
        const located = this.locateLogicalTableRow(table, logicalRow);
        if (!located) {
            return "missing";
        }
        if (!located.placeholder) {
            return "ready";
        }
        located.row.scrollIntoView({block: "center", inline: "nearest"});
        // 占位行已经在视口里时，scrollIntoView 不会再触发滚动。补一次 scroll，让思源虚拟化把这一段挂出来。
        located.row.dispatchEvent(new Event("scroll"));
        const appeared = await this.waitForLogicalTableRow(table, logicalRow, serial, 1000);
        if (serial !== this.tableRevealSerial) {
            return "pending";
        }
        return appeared ? "ready" : "pending";
    }

    /** 表格命中的逻辑行号。不是表格格子时返回 null。 */
    private logicalRowOfMatch(match: SearchMatch): number | null {
        if (match.blockType !== TABLE_TYPE) {
            return null;
        }
        const position = tableCellPosition(match.unitId);
        if (!position) {
            return null;
        }
        const colon = position.indexOf(":");
        const logicalRow = Number(position.slice(0, colon));
        if (!Number.isInteger(logicalRow) || logicalRow < 0) {
            return null;
        }
        return logicalRow;
    }

    /**
     * 这一行被思源收进占位行，表节点还在，格子 DOM 已经卸掉。
     * 旧偏移仍然对得上完整表，不必为了跳转整篇重搜。
     * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/wysiwyg/tableVirtualization.ts refresh
     */
    private tableMatchRowVirtualizedAway(match: SearchMatch): boolean {
        const logicalRow = this.logicalRowOfMatch(match);
        if (logicalRow === null || !match.blockId) {
            return false;
        }
        const table = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(match.blockId)}"]`,
        );
        if (!table) {
            return false;
        }
        return this.locateLogicalTableRow(table, logicalRow)?.placeholder === true;
    }

    private locateLogicalTableRow(
        table: HTMLElement,
        logicalRow: number,
    ): {row: HTMLElement; placeholder: boolean} | null {
        if (!table.isConnected) {
            return null;
        }
        const rows = ownTableRows(table);
        if (!rows) {
            return null;
        }
        const placed = logicalTableRows(rows);
        const offset = logicalRowOffset(placed.rows, logicalRow);
        if (offset < 0) {
            return null;
        }
        return {row: rows[offset], placeholder: placed.rows[offset].omitted > 0};
    }

    private waitForLogicalTableRow(
        table: HTMLElement,
        logicalRow: number,
        serial: number,
        timeoutMs: number,
    ): Promise<boolean> {
        const started = Date.now();
        return new Promise((resolve) => {
            const tick = () => {
                if (serial !== this.tableRevealSerial) {
                    resolve(false);
                    return;
                }
                const located = this.locateLogicalTableRow(table, logicalRow);
                if (located && !located.placeholder) {
                    resolve(true);
                    return;
                }
                if (!table.isConnected || Date.now() - started >= timeoutMs) {
                    resolve(false);
                    return;
                }
                window.requestAnimationFrame(tick);
            };
            window.requestAnimationFrame(tick);
        });
    }

    /** 只补这一条，并且偏移处的文字必须还是命中文字。对不上就保持没有 Range。 */
    private bindShownTableMatch(index: number, match: SearchMatch, table: HTMLElement): boolean {
        const host = table.isConnected
            ? table
            : this.edit.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(match.blockId)}"]`);
        if (!host?.isConnected) {
            return false;
        }
        const live = collectSearchableBlocks(this.edit, {
            ...this.searchCollectOptions(),
            includeDocTitle: false,
            scopeRoots: [host],
        });
        const block = live.find((item) => item.blockId === match.blockId && item.unitId === match.unitId);
        if (!block || block.text.slice(match.start, match.end) !== match.matchedText) {
            return false;
        }
        const range = createRangeFromBlockOffsets(block, match.start, match.end, {
            allowFoldedHidden: this.includeFoldedBlocks,
        });
        if (!range) {
            return false;
        }
        const current = this.resultMatches[index];
        if (!current || current.id !== match.id) {
            return false;
        }
        current.range = range;
        this.applyResultHighlights();
        return true;
    }

    private revealUnloadedMatch(index: number, match: SearchMatch | undefined, scroll: boolean) {
        if (!match || match.blockId === "__doc-title__") {
            return;
        }
        if (scroll && match.snippet) {
            showMessage(match.snippet, 4000, "info");
        }
        const existing = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(match.blockId)}"]`,
        );
        if (existing && revealHiddenTabs(existing)) {
            void existing.offsetHeight;
        }
        if (!match.range && this.bindMindmapPreview(index)) {
            void this.scrollIntoRangesAsync(index, scroll, false, false, false).then(() => {
                window.requestAnimationFrame(() => this.applyResultHighlights());
            });
            return;
        }
        const shown = existing
            && existing.clientHeight > 0
            && !isUnderNonHeadingCssFold(existing);
        if (shown && !match.range && this.tryBindUnfoldedMatch(index + 1)) {
            void this.scrollIntoRangesAsync(index, scroll, false, false, false).then(() => {
                window.requestAnimationFrame(() => this.applyResultHighlights());
            });
            return;
        }
        const renderedMindmap = existing?.closest<HTMLElement>("[data-mindmap-view-rendered=\"true\"]");
        if (!shown && renderedMindmap) {
            renderedMindmap.querySelector<HTMLElement>(":scope > .mindmap-view")
                ?.scrollIntoView({block: "center", inline: "nearest"});
            return;
        }
        if (shown && existing && match.blockType === TABLE_TYPE && tableCellPosition(match.unitId)) {
            const serial = ++this.tableRevealSerial;
            void this.revealVirtualTableMatch(index, match, existing, serial);
            return;
        }
        if (shown || (match.blockType === ATTRIBUTE_VIEW_TYPE && existing)) {
            existing?.scrollIntoView({block: "center", inline: "nearest"});
            return;
        }
        if (this.locatePending) {
            return;
        }
        const app = (this.plugin as unknown as Plugin).app;
        if (!app) {
            return;
        }
        this.locatePending = true;
        const keepIndex = this.resultIndex >= 1 ? this.resultIndex : index + 1;
        this.pauseIndexReset(4000);
        openBlockInEditor(app, match.blockId, () => {
            const finish = this.finishLocatedMatch(keepIndex, scroll);
            const release = () => {
                this.locatePending = false;
                this.pauseIndexReset(800);
            };
            finish.then(release, release);
        }, this.edit);
    }

    /**
     * 折叠块插回当前文档后停在原来的那一条。
     * 先给当前命中补高亮并滚动；标题下其余命中下一帧再补，对不上才整篇重搜。
     */
    private async finishLocatedMatch(keepIndex: number, scroll: boolean) {
        const index = this.resultIndex >= 1 && this.resultIndex <= this.resultMatches.length
            ? this.resultIndex
            : keepIndex;
        if (index >= 1 && this.tryBindUnfoldedMatch(index)) {
            if (this.resultIndex < 1) {
                this.resultIndex = Math.min(index, this.resultMatches.length);
                this.updateCountLabel();
            }
            if (scroll) {
                await this.scrollIntoRangesAsync(index - 1, true, false, true, false);
            }
            await new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => resolve());
            });
            this.bindUnfoldedHeadingSection();
            return;
        }
        consumeUnfoldedOuterHeadingId();
        await this.highlightHitResult(this.searchText, false);
        if (this.resultIndex < 1 && keepIndex >= 1 && this.resultCount > 0) {
            this.resultIndex = Math.min(keepIndex, this.resultCount);
            this.updateCountLabel();
        }
        if (!scroll || this.resultIndex < 1) {
            return;
        }
        const current = this.resultMatches[this.resultIndex - 1];
        if (current?.range) {
            await this.scrollIntoRangesAsync(this.resultIndex - 1, true, false, false, false);
            return;
        }
        if (!current?.blockId) {
            return;
        }
        this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(current.blockId)}"]`,
        )?.scrollIntoView({block: "center", inline: "nearest"});
    }

    /** 画布副本没有 data-node-id。按源块 id 把 Range 绑到当前可见节点上。 */
    private bindMindmapPreview(index: number): boolean {
        const match = this.resultMatches[index];
        if (!match?.blockId || !(this.edit instanceof HTMLElement) || !this.edit.querySelector(".mindmap-view")) {
            return false;
        }
        const units = collectMindmapPreviewUnits([this.edit]).filter((unit) => unit.blockId === match.blockId);
        if (!units.length) {
            return false;
        }
        this.resultMatches = fillLiveRanges(this.resultMatches, units, this.includeFoldedBlocks);
        return Boolean(this.resultMatches[index]?.range);
    }

    /** 当前这条已经在编辑器里时，只采集这一块并补上 Range，不重搜全文 */
    private tryBindUnfoldedMatch(index: number): boolean {
        const match = this.resultMatches[index - 1];
        if (!match || match.blockId === "__doc-title__") {
            return false;
        }
        const owner = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(match.blockId)}"]`,
        );
        if (!owner) {
            return false;
        }
        if (revealHiddenTabs(owner)) {
            void owner.offsetHeight;
        }
        const live = collectSearchableBlocks(this.edit, {
            ...this.searchCollectOptions(),
            includeDocTitle: false,
            scopeRoots: [owner],
        });
        this.resultMatches = fillLiveRanges(this.resultMatches, live, this.includeFoldedBlocks);
        let current = this.resultMatches[index - 1];
        if (!current?.range && this.bindMindmapPreview(index - 1)) {
            current = this.resultMatches[index - 1];
        }
        if (!current?.range) {
            return false;
        }
        if (current.highlightKind !== "inline-memo") {
            this.applyFocusHighlight(current.range);
        }
        return true;
    }

    /** 折叠标题刚展开的那一段：只采集这些块，给已有命中补高亮 */
    private bindUnfoldedHeadingSection() {
        const headingId = consumeUnfoldedOuterHeadingId();
        if (!headingId) {
            return;
        }
        const heading = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(headingId)}"]`,
        );
        if (!heading) {
            return;
        }
        const roots = listBlocksUnfoldedAfterHeading(heading);
        if (!roots.length) {
            return;
        }
        const live = collectSearchableBlocks(this.edit, {
            ...this.searchCollectOptions(),
            includeDocTitle: false,
            scopeRoots: roots,
        });
        this.resultMatches = fillLiveRanges(this.resultMatches, live, this.includeFoldedBlocks);
        this.applyResultHighlights();
    }

    private searchCollectOptions(): CollectSearchableBlocksOptions {
        return {
            includeDocTitle: this.includeDocTitle,
            includeImageTitle: this.includeImageTitle,
            includeAttributeView: this.includeAttributeView,
            includeTable: this.includeTable,
            includeBlockquote: this.includeBlockquote,
            includeCallout: this.includeCallout,
            includeSuperBlock: this.includeSuperBlock,
            includeTabs: this.includeTabs,
            includeMindmap: this.includeMindmap,
            includeListUnordered: this.includeListUnordered,
            includeListOrdered: this.includeListOrdered,
            includeListTask: this.includeListTask,
            includeParagraph: this.includeParagraph,
            includeHeadingH1: this.includeHeadingH1,
            includeHeadingH2: this.includeHeadingH2,
            includeHeadingH3: this.includeHeadingH3,
            includeHeadingH4: this.includeHeadingH4,
            includeHeadingH5: this.includeHeadingH5,
            includeHeadingH6: this.includeHeadingH6,
            includeMathBlock: this.includeMathBlock,
            includeEmbedBlock: this.includeEmbedBlock,
            includeCodeBlock: this.includeCodeBlock,
            includeMermaid: this.includeMermaid,
            includeHtmlBlock: this.includeHtmlBlock,
            includeInlineMemo: this.includeInlineMemo,
            restrictInlineTypes: this.restrictInlineTypes,
        };
    }

    /** 用当前命中上的 Range 重画高亮，不清除还没补上的命中 */
    private applyResultHighlights() {
        const HighlightCtor = (window as any).Highlight as {
            new (...ranges: Range[]): Highlight;
        };
        if (typeof HighlightCtor !== "function" || !(CSS as any).highlights) {
            this.syncMemoUnderlineVisual();
            return;
        }
        const textRanges: Range[] = [];
        for (const match of this.resultMatches) {
            if (!match.range || match.highlightKind === "inline-memo") {
                continue;
            }
            try {
                if (!match.range.startContainer.isConnected) {
                    continue;
                }
            } catch {
                continue;
            }
            textRanges.push(match.range);
            const mirror = mirrorTabsTitleRange(match.range);
            if (mirror) {
                textRanges.push(mirror);
            }
        }
        if (textRanges.length) {
            const highlight = newHighlight(textRanges);
            if (!highlight) {
                this.syncMemoUnderlineVisual();
                return;
            }
            (CSS as any).highlights.set("search-results", highlight);
        } else {
            (CSS as any).highlights.delete("search-results");
        }
        const current = this.getCurrentMatch();
        if (current?.range && current.highlightKind !== "inline-memo") {
            this.applyFocusHighlight(current.range);
        } else if (current?.highlightKind === "inline-memo") {
            this.clearSearchFocus();
        }
        this.syncMemoUnderlineVisual();
        this.plugin.updateLastHighlightComponent(this.root);
    }

    private noteAddedBlocks(change: EditorDomChange) {
        if (change.embedOverflow) {
            this.embedRefreshPending = true;
        }
        const pending = this.pendingAddedBlocks;
        if (!pending) {
            return;
        }
        if (!change.addedInBlocks) {
            this.pendingAddedBlocks = null;
            return;
        }
        change.addedInBlocks.forEach((id) => pending.add(id));
        if (pending.size > MAX_TOUCHED_BLOCKS) {
            this.pendingAddedBlocks = null;
        }
    }

    /**
     * 搜索进行时正文变过，结果里的 Range 可能建在已经换掉的节点上。
     * 期间记下的插入块在这里核对；还没停下来的变化，稍后由 DOM 观察再核对。
     */
    private repairAfterSearchIfNeeded(epoch: number) {
        if (!this.repairAfterSearch && this.domEpoch === epoch) {
            return;
        }
        this.repairAfterSearch = false;
        this.repairHighlightRanges();
    }

    /**
     * 思源换掉正文节点后，按原偏移把 Range 补到新节点上，不等 savedoc 重搜。
     * 原来亮着、偏移处文字变了的不补，安排一次重搜。开关单元格编辑器不产生事务，收不到 savedoc。
     * 没有 Range 的命中，只在所在块插入了节点时核对：大表虚拟滚动挂出新行、嵌入块渲染完成等。
     */
    private repairHighlightRanges() {
        if (this.replaceBusy || this.locatePending || !this.plugin.isLastHighlightComponent(this.root)) {
            this.pendingAddedBlocks = new Set();
            this.embedRefreshPending = false;
            return;
        }
        if (this.searchesInFlight > 0) {
            this.repairAfterSearch = true;
            return;
        }
        const embedRefresh = this.embedRefreshPending;
        this.embedRefreshPending = false;
        if (!this.resultMatches.length) {
            this.pendingAddedBlocks = new Set();
            this.scheduleEmbedRepair(embedRefresh);
            return;
        }
        const added = this.pendingAddedBlocks;
        this.pendingAddedBlocks = new Set();
        const wholeDocument = added === null;
        const targets = new Map<SearchMatch, RebindTarget>();
        const blockIds = new Set<string>();
        let brokenCount = 0;
        for (const match of this.resultMatches) {
            // 文档标题在正文外面，改名走 savedoc / rename 重搜
            if (!wholeDocument && match.blockId === "__doc-title__") {
                continue;
            }
            const broken = Boolean(match.range) && !rangeStillPainted(match);
            if (broken) {
                brokenCount += 1;
            } else if (match.range || !(added === null || added.has(match.blockId))) {
                continue;
            }
            targets.set(match, {broken, blockShown: false});
            blockIds.add(match.blockId);
        }
        // 只插入了大量块（滚动装载、文档重载）由 loaded-protyle 事件重搜。
        // 嵌入块溢出不走那条事件，单独重搜一次。
        if (!targets.size || (wholeDocument && brokenCount === 0)) {
            this.scheduleEmbedRepair(embedRefresh);
            return;
        }
        if (this.isRestrictEnumerateMode()) {
            // 枚举结果的 unitId 按出现序号编，换过节点后对不回去，直接重新枚举。
            // 嵌入溢出走保存刷新同一个计时器，避免和动态加载各搜一遍。
            if (!this.scheduleEmbedRepair(embedRefresh) && brokenCount > 0) {
                this.scheduleDomRefresh();
            }
            return;
        }
        const docRoot = resolveDocRoot(this.edit);
        if (!docRoot) {
            this.scheduleEmbedRepair(embedRefresh);
            return;
        }

        const shown = new Set<string>();
        let live: SearchableBlock[];
        if (wholeDocument || blockIds.size > MAX_SCOPED_REPAIR_BLOCKS) {
            live = collectSearchableBlocks(this.edit, this.searchCollectOptions());
            if (brokenCount > 0) {
                docRoot.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
                    const id = element.getAttribute("data-node-id");
                    if (id && blockIds.has(id)) {
                        shown.add(id);
                    }
                });
            }
        } else {
            const roots: HTMLElement[] = [];
            for (const id of blockIds) {
                docRoot.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`).forEach((element) => {
                    roots.push(element);
                    shown.add(id);
                });
            }
            live = roots.length
                ? collectSearchableBlocks(this.edit, {
                    ...this.searchCollectOptions(),
                    includeDocTitle: false,
                    scopeRoots: roots,
                })
                : [];
        }
        for (const [match, target] of targets) {
            target.blockShown = shown.has(match.blockId);
        }

        const rebound = rebindChangedRanges(this.resultMatches, live, targets, {
            allowFoldedHidden: this.includeFoldedBlocks,
            restrictInlineTypes: this.restrictInlineTypes,
        });
        if (rebound.changed) {
            this.resultMatches = rebound.matches;
            this.applyResultHighlights();
            this.syncReplaceButtons();
        }
        if (!this.scheduleEmbedRepair(embedRefresh) && rebound.textChanged > 0) {
            this.scheduleDomRefresh();
        }
    }

    /**
     * 嵌入块内部一次渲染出太多子块时，并进输入框 / 保存 / 动态加载共用的那次刷新。
     * 已经排上了就不再另开计时器。返回 true 表示这次全文刷新已经覆盖嵌入。
     */
    private scheduleEmbedRepair(embedRefresh: boolean): boolean {
        if (!embedRefresh) {
            return false;
        }
        if (!this.searchText.trim() && !this.isRestrictEnumerateMode()) {
            return false;
        }
        if (this.typingTimer != null) {
            return true;
        }
        this.typingTimer = window.setTimeout(() => {
            this.typingTimer = undefined;
            if (this.replaceBusy || this.locatePending || !this.plugin.isLastHighlightComponent(this.root)) {
                return;
            }
            void this.highlightHitResult(this.searchText, false).then(() => {
                if (this.resultIndex >= 1) {
                    this.scrollIntoRanges(this.resultIndex - 1, false);
                }
            });
        }, DONE_TYPING_MS);
        return true;
    }

    /**
     * 节点换过、偏移处文字也变了时重搜一次。
     * 编辑会带来 savedoc 刷新；它先跑了就不再重复。撤销的 savedoc 早于本地回放，单元格编辑器开关没有 savedoc。
     */
    private scheduleDomRefresh() {
        window.clearTimeout(this.domRefreshTimer);
        const generation = this.searchGeneration;
        this.domRefreshTimer = window.setTimeout(() => {
            if (this.searchGeneration !== generation) {
                return;
            }
            if (this.replaceBusy || this.locatePending || !this.plugin.isLastHighlightComponent(this.root)) {
                return;
            }
            void this.highlightHitResult(this.searchText, false).then(() => {
                if (this.resultIndex >= 1) {
                    this.scrollIntoRanges(this.resultIndex - 1, false);
                }
            });
        }, DONE_TYPING_MS);
    }

    private scrollIntoRanges(index: number, scroll: boolean = true, pulseMemoFocus = false) {
        void this.scrollIntoRangesAsync(index, scroll, pulseMemoFocus);
    }

    /**
     * 折叠标题删块后，Range 仍可能连在文首。只有起点还在原块里才算有效。
     * 思源开关单元格编辑器会整格换掉子节点，Range 缩成格子开头的空点，也算失效。
     */
    private rangeStillInMatchBlock(range: Range, match: SearchMatch): boolean {
        const blockId = match.blockId;
        let node: Node | null = null;
        try {
            node = range.startContainer;
            if (!node?.isConnected) {
                return false;
            }
        } catch {
            return false;
        }
        if (!blockId || blockId === "__doc-title__") {
            return true;
        }
        if (range.collapsed && match.end > match.start && match.highlightKind !== "inline-memo") {
            return false;
        }
        const selector = `[data-node-id="${CSS.escape(blockId)}"]`;
        let element: Element | null = node.nodeType === Node.ELEMENT_NODE
            ? node as Element
            : node.parentElement;
        while (element) {
            if (element.getAttribute("data-mindmap-source-id") === blockId || element.matches(selector)) {
                return true;
            }
            element = parentElementCrossingShadow(element);
        }
        return false;
    }

    private matchBlockShown(match: SearchMatch): boolean {
        if (!match.blockId || match.blockId === "__doc-title__") {
            return false;
        }
        const block = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(match.blockId)}"]`,
        );
        return Boolean(block && block.clientHeight > 0 && !isUnderNonHeadingCssFold(block));
    }

    /** 重搜一遍再跳到当前序号。重搜期间用户继续翻页时，以最后的序号为准。 */
    private async refreshStaleMatch(pulseMemoFocus: boolean) {
        if (this.staleRefreshPending) {
            return;
        }
        this.staleRefreshPending = true;
        try {
            await this.highlightHitResult(this.searchText, false);
        } finally {
            this.staleRefreshPending = false;
        }
        if (this.resultIndex >= 1 && this.resultIndex <= this.resultMatches.length) {
            await this.scrollIntoRangesAsync(this.resultIndex - 1, true, pulseMemoFocus, false, false);
        }
    }

    /** 当前命中立刻标成橙色。标题展开路径在滚动之前调用。 */
    private applyFocusHighlight(range: Range) {
        const HighlightCtor = (window as any).Highlight as {
            new (...ranges: Range[]): Highlight;
        };
        if (typeof HighlightCtor !== "function" || !(CSS as any).highlights) {
            return;
        }
        const ranges = [range];
        const mirror = mirrorTabsTitleRange(range);
        if (mirror) {
            ranges.push(mirror);
        }
        const highlight = newHighlight(ranges);
        if (!highlight) {
            return;
        }
        const highlights = (CSS as any).highlights;
        highlights.delete("search-focus");
        highlights.delete("search-math-focus");
        highlights.set("search-focus", highlight);
        this.plugin.updateLastHighlightComponent(this.root);
    }

    /** 当前项是备注虚线时，去掉正文上的橙色，让它回到 search-results 的黄色。 */
    private clearSearchFocus() {
        const highlights = (CSS as any).highlights;
        if (!highlights) {
            return;
        }
        highlights.delete("search-focus");
        highlights.delete("search-math-focus");
    }

    /**
     * 跳转命中：已在编辑器里的折叠列表/提示先展开再滚动。
     * 折叠标题下的命中不在 DOM 里，展开后仍停在当前序号，不进入聚焦。
     * immediate：标题刚展开时先上橙色并立刻滚动，折叠持久化放到后台。
     * scroll 为 false 时只刷新高亮，不展开用户刚刚折叠的块。
     */
    private async scrollIntoRangesAsync(
        index: number,
        scroll: boolean = true,
        pulseMemoFocus = false,
        immediate = false,
        refreshStale = true,
    ) {
        // 滚动可能触发 AV 虚拟滚动 DOM 突变；短暂暂停观察，防止重搜重置索引
        if (scroll) {
            this.pauseAvWatch(600);
        }
        const match = this.resultMatches[index];
        if (scroll) {
            this.revealMatchTabs(match);
        }
        let range = match?.range;
        // 折叠标题会删掉后面的块，浏览器把旧 Range 缩到文首。跳转时不能再滚到那里。
        if (range && match && !this.rangeStillInMatchBlock(range, match)) {
            match.range = undefined;
            range = undefined;
            // 块还在画面上，只是块内 DOM 被重建，格内文字也可能改过，旧偏移不能再用来补 Range。
            // 大表只是把这一行收进占位行，文字没变。直接挂出分段，不整篇重搜。
            if (
                scroll
                && refreshStale
                && this.matchBlockShown(match)
                && !this.tableMatchRowVirtualizedAway(match)
            ) {
                await this.refreshStaleMatch(pulseMemoFocus);
                return;
            }
        }
        if (!range) {
            if (!scroll) {
                return;
            }
            this.revealUnloadedMatch(index, match, scroll);
            return;
        }
        if (immediate && match.highlightKind !== "inline-memo") {
            this.applyFocusHighlight(range);
        }

        let backgroundFoldIds: string[] = [];
        if (scroll && this.includeFoldedBlocks) {
            const ancestor = range.commonAncestorContainer;
            const fromNode = ancestor.nodeType === Node.TEXT_NODE
                ? ancestor.parentElement
                : ancestor as Element | null;
            const foldIds = collectNonHeadingFoldedAncestorIds(fromNode);
            if (foldIds.length && immediate) {
                clearNonHeadingFoldLocally(foldIds);
                const host = range.startContainer.nodeType === Node.ELEMENT_NODE
                    ? range.startContainer as HTMLElement
                    : range.startContainer.parentElement;
                if (host) {
                    void host.offsetHeight;
                }
                backgroundFoldIds = foldIds;
            } else if (foldIds.length) {
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

            if (ancestorElement?.closest(".mindmap-view")) {
                panMindmapIntoView(range);
            } else if (ancestorElement) {
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

        if (match.highlightKind !== "inline-memo") {
            this.applyFocusHighlight(range);
        } else {
            this.clearSearchFocus();
        }
        if (backgroundFoldIds.length) {
            void unfoldNonHeadingFoldedBlocks(backgroundFoldIds);
        }
        this.syncMemoUnderlineVisual();
        // 异步展开折叠后索引可能已变；仅当仍停在本次目标命中时才脉冲
        if (
            pulseMemoFocus
            && match.highlightKind === "inline-memo"
            && this.getCurrentMatch()?.id === match.id
        ) {
            pulseMemoFocusUnderline(this.edit);
        }
        this.syncReplaceButtons();
    }

    /** 命中在未选中的页签里时先切换页签，再滚动。保存刷新走 scroll=false，不会切页签。 */
    private revealMatchTabs(match: SearchMatch | undefined) {
        if (!match?.blockId || match.blockId === "__doc-title__") {
            return;
        }
        const host = this.edit.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(match.blockId)}"]`,
        );
        if (host && revealHiddenTabs(host)) {
            void host.offsetHeight;
        }
    }

    private clickLast() {
        const prevMatch = this.getCurrentMatch();
        if (this.resultCount === 0) {
            this.resultIndex = 0;
        } else if (this.resultIndex > 1 && this.resultIndex <= this.resultCount) {
            this.resultIndex -= 1;
        } else {
            this.resultIndex = this.resultCount;
        }
        this.updateCountLabel(true);
        const nextMatch = this.resultMatches[this.resultIndex - 1];
        this.scrollIntoRanges(
            this.resultIndex - 1,
            true,
            shouldPulseMemoFocusOnNavigate(prevMatch, nextMatch),
        );
    }

    private clickNext() {
        const prevMatch = this.getCurrentMatch();
        if (this.resultCount === 0) {
            this.resultIndex = 0;
        } else if (this.resultIndex < this.resultCount) {
            this.resultIndex += 1;
        } else {
            this.resultIndex = 1;
        }
        this.updateCountLabel(true);
        const nextMatch = this.resultMatches[this.resultIndex - 1];
        this.scrollIntoRanges(
            this.resultIndex - 1,
            true,
            shouldPulseMemoFocusOnNavigate(prevMatch, nextMatch),
        );
    }

    private clickClose() {
        this.clearHighlight();
        this.plugin.closeCurrentSearchDialog(this.root);
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

    /** 不可替换时的提示。表格两类单独说明，其余保持原来的文案。 */
    private unsupportedReplaceMessage(match: SearchMatch): string {
        if (match.blockType === ATTRIBUTE_VIEW_TYPE) {
            return this.i18n.replaceAttributeViewUnsupported;
        }
        if (match.unitId === MERMAID_UNIT_ID) {
            return this.i18n.replaceMermaidUnsupported;
        }
        if (match.unitId === HTML_BLOCK_UNIT_ID) {
            return this.i18n.replaceHtmlBlockUnsupported;
        }
        if (match.replaceLock === "table-rich") {
            return this.i18n.replaceTableRichUnsupported;
        }
        if (match.replaceLock === "table-cell-editor") {
            return this.i18n.replaceTableCellEditingUnsupported;
        }
        return this.i18n.replaceCurrentUnsupported;
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
        if (match.blockId === "__doc-title__" || match.blockType === "doc-title" || match.unitId === "doc-title") {
            showMessage(this.i18n.replaceDocTitleUnsupported ?? "文档标题仅支持搜索，不参与替换", 3000, "info");
            this.clickNext();
            return;
        }
        if (!match.replaceable) {
            showMessage(this.unsupportedReplaceMessage(match), 3000, "info");
            this.clickNext();
            return;
        }

        const keepIndex = this.resultIndex;
        this.replaceBusy = true;
        try {
            let current = match;
            if (!current.range && !blockIsInEditor(this.edit, current.blockId)) {
                const app = (this.plugin as unknown as Plugin).app;
                if (app) {
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const done = () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            resolve();
                        };
                        this.pauseIndexReset(4500);
                        openBlockInEditor(app, current.blockId, done, this.edit);
                        window.setTimeout(done, 4500);
                    });
                    await this.highlightHitResult(this.searchText, false);
                    current = this.getCurrentMatch() ?? current;
                }
            }
            const result = await replaceCurrentMatchInEditor(
                this.edit,
                current,
                this.replaceText,
                {
                    preserveCase: this.preserveCase,
                    regex: this.regex,
                    searchQuery: this.searchText,
                    caseSensitive: this.caseSensitive,
                },
            );
            if (result.error === "readonly-or-preview") {
                showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
                return;
            }
            if (result.error === "protyle-missing") {
                showMessage(this.i18n.replaceProtyleMissing, 4000, "error");
                return;
            }
            if (result.error === "regex-expand-failed") {
                showMessage(this.i18n.replaceRegexExpandFailed, 3000, "info");
                this.clickNext();
                return;
            }
            if (result.error === "table-pending-edit") {
                showMessage(this.i18n.replaceTablePendingEdit, 4000, "info");
                return;
            }
            if (result.error === "title-invalid") {
                showMessage(this.i18n.replaceDocTitleEmpty, 3000, "info");
                this.clickNext();
                return;
            }
            if (
                result.error === "title-context-missing"
                || result.error === "title-rename-failed"
                || result.error === "title-missing"
            ) {
                showMessage(this.formatDocTitleReplaceError(result.detail), 4000, "error");
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
            invalidateDocumentSearchCaches();
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
            const result = await replaceAllMatchesInEditor(
                this.edit,
                this.resultMatches,
                this.replaceText,
                {
                    preserveCase: this.preserveCase,
                    regex: this.regex,
                    searchQuery: this.searchText,
                    caseSensitive: this.caseSensitive,
                },
            );
            if (result.error === "readonly-or-preview") {
                showMessage(this.i18n.replaceModeUnsupported, 3000, "info");
                return;
            }
            if (result.error === "protyle-missing") {
                showMessage(this.i18n.replaceProtyleMissing, 4000, "error");
                return;
            }
            if (result.replacedCount === 0 && result.error === "table-pending-edit") {
                showMessage(this.i18n.replaceTablePendingEdit, 4000, "info");
                return;
            }
            if (
                result.replacedCount === 0
                && result.error === "title-invalid"
            ) {
                showMessage(this.i18n.replaceDocTitleEmpty, 3000, "info");
                return;
            }
            if (
                result.replacedCount === 0
                && (
                    result.error === "title-rename-failed"
                    || result.error === "title-missing"
                    || result.error === "title-context-missing"
                )
            ) {
                showMessage(this.formatDocTitleReplaceError(result.detail), 4000, "error");
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
            invalidateDocumentSearchCaches();
        } finally {
            this.replaceBusy = false;
        }
    }

    /** 标题重命名失败：有内核 msg 时追加一行，避免只剩笼统文案 */
    private formatDocTitleReplaceError(detail?: string): string {
        const base = this.i18n.replaceDocTitleFailed;
        const msg = detail?.trim();
        if (!msg) {
            return base;
        }
        return `${base}：${msg}`;
    }

    /**
     * 思源原生 Menu + b3-switch：搜索范围设置（全局持久化）。
     * 一级：是否搜索 ▸ / 折叠块内容 / 限制搜索 ▸
     * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/plugin/Menu.ts
     */
    private openSettingsMenu(anchor: HTMLElement) {
        this.closeSearchMethodMenu();
        this.closeSettingsMenu();
        const menu = new Menu("page-search-settings", () => {
            if (this.settingsMenu === menu) {
                this.settingsMenu = null;
            }
        });
        this.settingsMenu = menu;
        menu.addItem({
            id: "page-search-include-scope",
            icon: "iconFilter",
            label: this.i18n.settingsIncludeScope,
            type: "submenu",
            submenu: [
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-doc-title",
                    icon: "iconFile",
                    label: this.i18n.settingsIncludeDocTitle,
                    checked: this.includeDocTitle,
                    helpTip: this.i18n.settingsIncludeDocTitleHint,
                    onChange: (checked) => {
                        void this.setIncludeDocTitle(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-image-title",
                    icon: "iconImage",
                    label: this.i18n.settingsIncludeImageTitle,
                    checked: this.includeImageTitle,
                    onChange: (checked) => {
                        void this.setIncludeImageTitle(checked);
                    },
                }),
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
                    id: "page-search-include-paragraph",
                    icon: "iconParagraph",
                    label: this.i18n.settingsIncludeParagraph,
                    checked: this.includeParagraph,
                    onChange: (checked) => {
                        void this.setIncludeParagraph(checked);
                    },
                }),
                {
                    id: "page-search-include-heading",
                    icon: "iconHeadings",
                    label: this.i18n.settingsIncludeHeading,
                    type: "submenu",
                    submenu: HEADING_INCLUDE_LEVELS.map((level) => {
                        const key = headingIncludePrefKey(level);
                        const labelKey = `settingsIncludeHeadingH${level}` as const;
                        return this.buildMatchSwitchMenuItem({
                            id: `page-search-include-heading-h${level}`,
                            icon: "iconHeadings",
                            label: this.i18n[labelKey],
                            checked: this[key],
                            onChange: (checked) => {
                                void this.setIncludeHeadingLevel(level, checked);
                            },
                        });
                    }),
                },
                {
                    id: "page-search-include-list",
                    icon: "iconList",
                    label: this.i18n.settingsIncludeList,
                    type: "submenu",
                    submenu: [
                        this.buildMatchSwitchMenuItem({
                            id: "page-search-include-list-unordered",
                            icon: "iconList",
                            label: this.i18n.settingsIncludeListUnordered,
                            checked: this.includeListUnordered,
                            onChange: (checked) => {
                                void this.setIncludeListUnordered(checked);
                            },
                        }),
                        this.buildMatchSwitchMenuItem({
                            id: "page-search-include-list-ordered",
                            icon: "iconOrderedList",
                            label: this.i18n.settingsIncludeListOrdered,
                            checked: this.includeListOrdered,
                            onChange: (checked) => {
                                void this.setIncludeListOrdered(checked);
                            },
                        }),
                        this.buildMatchSwitchMenuItem({
                            id: "page-search-include-list-task",
                            icon: "iconCheck",
                            label: this.i18n.settingsIncludeListTask,
                            checked: this.includeListTask,
                            onChange: (checked) => {
                                void this.setIncludeListTask(checked);
                            },
                        }),
                    ],
                },
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
                    id: "page-search-include-super-block",
                    icon: "iconSuper",
                    label: this.i18n.settingsIncludeSuperBlock,
                    checked: this.includeSuperBlock,
                    onChange: (checked) => {
                        void this.setIncludeSuperBlock(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-tabs",
                    icon: "iconTabs",
                    label: this.i18n.settingsIncludeTabs,
                    checked: this.includeTabs,
                    onChange: (checked) => {
                        void this.setIncludeTabs(checked);
                    },
                }),
                this.buildMatchSwitchMenuItem({
                    id: "page-search-include-mindmap",
                    icon: "iconMindmap",
                    label: this.i18n.settingsIncludeMindmap,
                    checked: this.includeMindmap,
                    onChange: (checked) => {
                        void this.setIncludeMindmap(checked);
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
                    id: "page-search-include-html-block",
                    icon: "iconHTML5",
                    label: this.i18n.settingsIncludeHtmlBlock,
                    checked: this.includeHtmlBlock,
                    helpTip: this.i18n.settingsIncludeHtmlBlockHint,
                    onChange: (checked) => {
                        void this.setIncludeHtmlBlock(checked);
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
        menu.addItem({
            id: "page-search-restrict-inline",
            icon: "iconList",
            label: this.i18n.settingsRestrictInline,
            type: "submenu",
            submenu: this.buildRestrictInlineSubmenuItems(),
            bind: (element) => {
                this.attachMenuHelpTip(element, this.i18n.settingsRestrictInlineHint);
            },
        });
        const rect = anchor.getBoundingClientRect();
        menu.open({
            x: rect.left,
            y: rect.bottom,
            isLeft: true,
        });
        // 仅保证菜单高于搜索窗；保留思源为 Menu 分配的层级，且不超过已打开 Dialog
        menu.element.style.zIndex = String(
            resolveSettingsMenuZIndex(this.dialog, menu.element),
        );
        // 菜单挂在 document，用 data-name 标记便于样式与关闭兜底
        menu.element.setAttribute("data-name", "page-search-settings");
    }

    /**
     * 查找方法菜单：关键字 / 正则表达式（互斥，对齐官方 queryMenu）。
     * 再次点击触发器则关闭；选中当前项仅关菜单不翻转。
     */
    private openSearchMethodMenu(anchor: HTMLElement) {
        if (this.methodMenu) {
            this.closeSearchMethodMenu();
            return;
        }
        this.closeSettingsMenu();
        const menu = new Menu("page-search-method", () => {
            if (this.methodMenu === menu) {
                this.methodMenu = null;
            }
            this.syncSearchMethodTrigger();
        });
        this.methodMenu = menu;
        menu.addItem({
            id: "page-search-method-keyword",
            icon: "iconExact",
            label: this.i18n.searchMethodKeyword,
            current: !this.regex,
            click: () => {
                void this.setSearchMethod(false);
            },
        });
        menu.addItem({
            id: "page-search-method-regex",
            icon: "iconRegex",
            label: this.i18n.searchMethodRegex,
            current: this.regex,
            click: () => {
                void this.setSearchMethod(true);
            },
        });
        const rect = anchor.getBoundingClientRect();
        menu.open({
            x: rect.left,
            y: rect.bottom,
            isLeft: true,
        });
        menu.element.style.zIndex = String(
            resolveSettingsMenuZIndex(this.dialog, menu.element),
        );
        menu.element.setAttribute("data-name", "page-search-method");
        this.syncSearchMethodTrigger();
    }

    private closeSearchMethodMenu() {
        try {
            this.methodMenu?.close();
        } catch {
            // ignore
        }
        this.methodMenu = null;
        try {
            const globalMenu = (window as any).siyuan?.menus?.menu;
            const el = globalMenu?.element as HTMLElement | undefined;
            if (el?.getAttribute("data-name") === "page-search-method") {
                globalMenu.remove();
            }
        } catch {
            // ignore
        }
        this.syncSearchMethodTrigger();
    }

    /** 互斥设置查找方法；写 prefs + 同步其它面板；值未变则不重搜 */
    private async setSearchMethod(useRegex: boolean) {
        this.closeSearchMethodMenu();
        if (this.regex === useRegex) {
            return;
        }
        this.regex = useRegex;
        this.syncOptionButtons();
        await rpcSetPrefs(this.plugin, {useRegex});
        this.plugin.syncUseRegex?.(useRegex, this);
        void this.highlightHitResult(this.searchText, true);
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
    private async setIncludeDocTitle(value: boolean) {
        if (this.includeDocTitle === value) {
            return;
        }
        this.includeDocTitle = value;
        await rpcSetPrefs(this.plugin, {includeDocTitle: value});
        this.plugin.syncIncludeDocTitle?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeImageTitle(value: boolean) {
        if (this.includeImageTitle === value) {
            return;
        }
        this.includeImageTitle = value;
        await rpcSetPrefs(this.plugin, {includeImageTitle: value});
        this.plugin.syncIncludeImageTitle?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

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

    private async setIncludeSuperBlock(value: boolean) {
        if (this.includeSuperBlock === value) {
            return;
        }
        this.includeSuperBlock = value;
        await rpcSetPrefs(this.plugin, {includeSuperBlock: value});
        this.plugin.syncIncludeSuperBlock?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeTabs(value: boolean) {
        if (this.includeTabs === value) {
            return;
        }
        this.includeTabs = value;
        await rpcSetPrefs(this.plugin, {includeTabs: value});
        this.plugin.syncIncludeTabs?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeMindmap(value: boolean) {
        if (this.includeMindmap === value) {
            return;
        }
        this.includeMindmap = value;
        await rpcSetPrefs(this.plugin, {includeMindmap: value});
        this.plugin.syncIncludeMindmap?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeListUnordered(value: boolean) {
        if (this.includeListUnordered === value) {
            return;
        }
        this.includeListUnordered = value;
        await rpcSetPrefs(this.plugin, {includeListUnordered: value});
        this.plugin.syncIncludeListUnordered?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeListOrdered(value: boolean) {
        if (this.includeListOrdered === value) {
            return;
        }
        this.includeListOrdered = value;
        await rpcSetPrefs(this.plugin, {includeListOrdered: value});
        this.plugin.syncIncludeListOrdered?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeListTask(value: boolean) {
        if (this.includeListTask === value) {
            return;
        }
        this.includeListTask = value;
        await rpcSetPrefs(this.plugin, {includeListTask: value});
        this.plugin.syncIncludeListTask?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeParagraph(value: boolean) {
        if (this.includeParagraph === value) {
            return;
        }
        this.includeParagraph = value;
        await rpcSetPrefs(this.plugin, {includeParagraph: value});
        this.plugin.syncIncludeParagraph?.(value, this);
        void this.highlightHitResult(this.searchText, true);
    }

    private async setIncludeHeadingLevel(level: HeadingIncludeLevel, value: boolean) {
        const key = headingIncludePrefKey(level);
        if (this[key] === value) {
            return;
        }
        this[key] = value;
        await rpcSetPrefs(this.plugin, {[key]: value});
        this.plugin.syncIncludeHeadingLevel?.(level, value, this);
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

    private async setIncludeHtmlBlock(value: boolean) {
        if (this.includeHtmlBlock === value) {
            return;
        }
        this.includeHtmlBlock = value;
        await rpcSetPrefs(this.plugin, {includeHtmlBlock: value});
        this.plugin.syncIncludeHtmlBlock?.(value, this);
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
    applyIncludeDocTitle(value: boolean) {
        if (this.includeDocTitle === value) {
            return;
        }
        this.includeDocTitle = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeImageTitle(value: boolean) {
        if (this.includeImageTitle === value) {
            return;
        }
        this.includeImageTitle = value;
        void this.highlightHitResult(this.searchText, true);
    }

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

    applyIncludeSuperBlock(value: boolean) {
        if (this.includeSuperBlock === value) {
            return;
        }
        this.includeSuperBlock = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeTabs(value: boolean) {
        if (this.includeTabs === value) {
            return;
        }
        this.includeTabs = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeMindmap(value: boolean) {
        if (this.includeMindmap === value) {
            return;
        }
        this.includeMindmap = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeListUnordered(value: boolean) {
        if (this.includeListUnordered === value) {
            return;
        }
        this.includeListUnordered = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeListOrdered(value: boolean) {
        if (this.includeListOrdered === value) {
            return;
        }
        this.includeListOrdered = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeListTask(value: boolean) {
        if (this.includeListTask === value) {
            return;
        }
        this.includeListTask = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeParagraph(value: boolean) {
        if (this.includeParagraph === value) {
            return;
        }
        this.includeParagraph = value;
        void this.highlightHitResult(this.searchText, true);
    }

    applyIncludeHeadingLevel(level: HeadingIncludeLevel, value: boolean) {
        const key = headingIncludePrefKey(level);
        if (this[key] === value) {
            return;
        }
        this[key] = value;
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

    applyIncludeHtmlBlock(value: boolean) {
        if (this.includeHtmlBlock === value) {
            return;
        }
        this.includeHtmlBlock = value;
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

    /**
     * 其它面板同步过来的查找方法（不再写存储）。
     */
    applyUseRegex(value: boolean) {
        if (this.regex === value) {
            return;
        }
        this.regex = value;
        this.closeSearchMethodMenu();
        this.syncOptionButtons();
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

/**
 * 同一行内备注宿主上、不同属性偏移命中之间导航时，虚线焦点色不变，需短脉冲提示。
 * 仅看 highlightKind + unitId（或 Range 边界）；不碰内容 DOM。
 */
function shouldPulseMemoFocusOnNavigate(
    prev: SearchMatch | null | undefined,
    next: SearchMatch | null | undefined,
): boolean {
    if (!prev || !next) {
        return false;
    }
    if (prev.highlightKind !== "inline-memo" || next.highlightKind !== "inline-memo") {
        return false;
    }
    if (prev.id === next.id) {
        return false;
    }
    if (prev.start === next.start && prev.end === next.end) {
        return false;
    }
    if (prev.unitId && next.unitId) {
        return prev.unitId === next.unitId;
    }
    if (prev.range && next.range) {
        try {
            return prev.range.compareBoundaryPoints(Range.START_TO_START, next.range) === 0
                && prev.range.compareBoundaryPoints(Range.END_TO_END, next.range) === 0;
        } catch {
            return false;
        }
    }
    return false;
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
        current = parentElementCrossingShadow(current);
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
