import {
    logicalTableRows,
    normalizeRestrictInlineTypes,
    ownTableRows,
    plainTextFromInlineMemoContent,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    TABLE_VIRTUAL_ROWS_ATTR,
    type RestrictInlineType,
} from "../shared";
import type {
    SearchableBlock,
    TableReplaceLock,
    TableSlot,
} from "./dom-types";
import {isUnderNonHeadingCssFold} from "./fold-dom";
import {
    collectRendererSearchUnits,
    rendererAdapterKind,
    type RendererAdapterKind,
} from "./renderer-adapters";
import {splitTextNodesAtBarriers} from "./text-runs";
import {
    beginTextCollection,
    omitAuthorCssHiddenText,
} from "./visibility";

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
const PREVIEW_BLOCK_ID = "__preview__";
const PREVIEW_BLOCK_TYPE = "preview";
const ATTRIBUTE_VIEW_TYPE = "NodeAttributeView";
const BLOCKQUOTE_TYPE = "NodeBlockquote";
const CALLOUT_TYPE = "NodeCallout";
/** 超级块：容器（内部子块嵌套在 .sb 内） */
const SUPER_BLOCK_TYPE = "NodeSuperBlock";
const LIST_TYPE = "NodeList";
const LIST_ITEM_TYPE = "NodeListItem";
/** 段落块：叶子块（非容器） */
const PARAGRAPH_TYPE = "NodeParagraph";
/** 标题块：非容器（子块为随后兄弟，不在 NodeHeading DOM 内） */
const HEADING_TYPE = "NodeHeading";
const MATH_BLOCK_TYPE = "NodeMathBlock";
/** 嵌入块：内含 .protyle-wysiwyg__embed 渲染的源块副本 */
const EMBED_BLOCK_TYPE = "NodeBlockQueryEmbed";
const WIDGET_TYPE = "NodeWidget";
/** HTML 块：可见字在 protyle-html open Shadow，非 light DOM */
const HTML_BLOCK_TYPE = "NodeHTMLBlock";
const TABLE_TYPE = "NodeTable";
const CODE_BLOCK_TYPE = "NodeCodeBlock";

interface RendererIncludeGates {
    includeMathBlock: boolean;
    includeHtmlBlock: boolean;
    includeCodeBlock: boolean;
    includeMermaid: boolean;
    includeFlowchart: boolean;
}

function rendererEnabled(
    kind: RendererAdapterKind,
    gates: RendererIncludeGates,
): boolean {
    if (kind === "math") {
        return gates.includeMathBlock;
    }
    if (kind === "html") {
        return gates.includeHtmlBlock;
    }
    if (kind === "mermaid") {
        return gates.includeMermaid;
    }
    if (kind === "flowchart") {
        return gates.includeFlowchart;
    }
    return gates.includeCodeBlock;
}
/**
 * 正文 TreeWalker 排除：属性区 / 矢量 / 公式。
 * 行内公式和行级公式的可见字形单独采集。若正文再走一遍 .katex，同一个词会计两次。
 * MathML / annotation 与 .katex-html 字形重复，也不能计入。
 * 页签导航 .tabs-header 是标题块的克隆，正文仍在 .tab-item-info 里，再计一次会重复。
 * 思维导图画布 .mindmap-view 是源块的副本，源块仍单独计数，不能再把副本算进导图块。
 * 有序列表项的 .protyle-action 是运行时编号，不属于正文搜索源。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.7-alpha.5/app/src/protyle/render/listMindmap/view.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mathRender.ts
 * @see https://github.com/KaTeX/KaTeX/blob/v0.16.9/src/buildTree.js
 */
const TEXT_NODE_EXCLUDED_CLOSEST =
    '.protyle-attr, svg, style, script, .katex, .katex-html, .katex-display, .katex-mathml, math, annotation, span[data-type~="inline-math"], .tabs-header, .mindmap-view, [data-type="NodeListItem"] > .protyle-action';
/** 图片标题可见字（官方 imgTitle / `.protyle-action__title`） */
const IMAGE_TITLE_TEXT_CLOSEST = ".img .protyle-action__title";
/** 行内备注 unitId 前缀；text 来自 data-inline-memo-content */
const INLINE_MEMO_UNIT_PREFIX = "inline-memo:";
/** 合成块类型，便于 replaceable / 高亮分流 */
const INLINE_MEMO_BLOCK_TYPE = "inline-memo";
/** 行内公式 unitId 前缀；text 来自 KaTeX 渲染可见文字 */
const INLINE_MATH_UNIT_PREFIX = "inline-math:";
/** 与 mathOrdinal 使用同一段可见文字，补高亮时才能和全文采集对上。 */
export function inlineMathIdentityText(text: string): string {
    return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}
/** 合成块类型，便于 replaceable / 高亮分流 */
const INLINE_MATH_BLOCK_TYPE = "inline-math";
export const DOC_TITLE_BLOCK_ID = "__doc-title__";
export const DOC_TITLE_BLOCK_TYPE = "doc-title";
export const DOC_TITLE_UNIT_ID = "doc-title";
const TABLE_CELL_SELECTOR = '[data-type="NodeTableCell"], .table__cell, td, th';
/**
 * 单元格编辑器把格子内容放进临时段落，段落 id 由 Lute.NewNodeID() 现生成，内核里没有。
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/render/tableCellRichEditor.ts
 * @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/util/tableCellRich.ts getTableCellRichBlockDOM
 */
const TABLE_CELL_EDITOR_SELECTOR = ".table__cell-editor";

/** 数据库内不应参与搜索的 UI 节点（含 av__cursor 的 ZWSP，会干扰零宽变体匹配） */
const AV_EXCLUDED_CLOSEST = [
    ".protyle-attr",
    // 关闭「显示条目图标」时主键前的 .b3-menu__avemoji 带 fn__none，但仍含 emoji 文本节点；
    // 若采入会导致「test」命中落在图标/主键文本边界，Range 起点落在 fn__none 内被可见性丢弃。
    ".fn__none",
    ".b3-menu__avemoji",
    "svg",
    "style",
    "script",
    ".av__gallery-tip",
    ".av__widthdrag",
    ".av__pulse",
    ".av__cursor",
    ".av__calc",
    '.b3-chip[data-type="block-more"]',
].join(", ");

/**
 * 解析当前编辑器内的可搜索文档根（编辑态 wysiwyg / 预览态 b3-typography）
 */
export function resolveDocRoot(edit: Element): HTMLElement | null {
    const offscreen = edit.closest("[data-page-search-offscreen]") ??
        (edit.hasAttribute("data-page-search-offscreen") ? edit : null);
    if (offscreen) {
        return offscreen.querySelector(".protyle-wysiwyg");
    }

    const protyleSelector = ".protyle:not(.fn__none):not([data-page-search-offscreen])";
    let docRoot = edit.querySelector(
        `:scope > ${protyleSelector} :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)`,
    ) as HTMLElement | null;

    if (!docRoot) {
        docRoot = edit.querySelector(
            `${protyleSelector} :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)`,
        ) as HTMLElement | null;
    }

    return docRoot;
}

/**
 * 解析文档标题输入区。
 * 思源标题在 .protyle-wysiwyg 之外：.protyle-title > .protyle-title__input
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/header/Title.ts
 */
export function resolveDocTitleInput(edit: Element): HTMLElement | null {
    let titleInput = edit.querySelector(
        ":scope > .protyle:not(.fn__none) .protyle-title .protyle-title__input",
    ) as HTMLElement | null;

    if (!titleInput) {
        titleInput = edit.querySelector(
            ".protyle:not(.fn__none) .protyle-title .protyle-title__input",
        ) as HTMLElement | null;
    }

    // 浮窗 / 部分布局下可能只有 .protyle-title
    if (!titleInput) {
        const title = edit.querySelector(
            ".protyle:not(.fn__none) .protyle-title",
        ) as HTMLElement | null;
        if (title) {
            titleInput = title.querySelector<HTMLElement>(".protyle-title__input") || title;
        }
    }

    return titleInput;
}

function collectDocTitleUnit(edit: Element): SearchableBlock | null {
    const titleInput = resolveDocTitleInput(edit);
    if (!titleInput) {
        return null;
    }

    const textNodes = collectDescendantTextNodes(titleInput);
    const text = textNodes.map((node) => node.nodeValue ?? "").join("");
    if (!text.trim()) {
        return null;
    }

    return {
        blockId: DOC_TITLE_BLOCK_ID,
        blockType: DOC_TITLE_BLOCK_TYPE,
        blockIndex: -1,
        element: titleInput,
        text,
        textNodes,
        unitId: DOC_TITLE_UNIT_ID,
    };
}

/** 是否为文档标题合成搜索单元 */
export function isDocTitleSearchUnit(
    block: Pick<SearchableBlock, "blockId" | "blockType" | "unitId">,
): boolean {
    return block.blockId === DOC_TITLE_BLOCK_ID ||
        block.blockType === DOC_TITLE_BLOCK_TYPE ||
        block.unitId === DOC_TITLE_UNIT_ID;
}

/**
 * 按块收集可搜索文本。排除 .protyle-attr，避免嵌套块重复计数。
 * 预览模式无 data-node-id 时回退为整根合成块，保证行为不回退。
 */
export interface CollectSearchableBlocksOptions {
    /** 是否采集文档标题（.protyle-title__input）；默认 true */
    includeDocTitle?: boolean;
    /** 是否采集图片标题（`.img .protyle-action__title`）；默认 true */
    includeImageTitle?: boolean;
    /** 是否采集数据库（Attribute View）；默认 true */
    includeAttributeView?: boolean;
    /** 是否采集表格块（NodeTable）；默认 true */
    includeTable?: boolean;
    /** 是否采集引述块（NodeBlockquote）及其内部子块；默认 true */
    includeBlockquote?: boolean;
    /** 是否采集提示块（NodeCallout，含标题与内部子块）；默认 true */
    includeCallout?: boolean;
    /** 是否采集超级块（NodeSuperBlock）及其内部子块；默认 true */
    includeSuperBlock?: boolean;
    /** 是否采集页签块（NodeTabs）及其内部、页签标题；默认 true */
    includeTabs?: boolean;
    /**
     * 是否采集思维导图块（NodeMindmap，以及 custom-sy-list-mindmap="1" 的列表）及其内部；默认 true。
     * 不含代码块子类型 mindmap。
     */
    includeMindmap?: boolean;
    /**
     * 是否采集无序列表（data-subtype=u）及其内部；默认 true。
     * 嵌套列表按最近列表祖先 subtype；三者全关 = 列表区都不采。
     */
    includeListUnordered?: boolean;
    /** 是否采集有序列表（data-subtype=o）及其内部；默认 true */
    includeListOrdered?: boolean;
    /** 是否采集任务列表（data-subtype=t）及其内部；默认 true */
    includeListTask?: boolean;
    /**
     * 是否采集段落块（NodeParagraph）；默认 true。
     * 关段落时若仍开 includeImageTitle，仍单独采集段内图片标题。
     */
    includeParagraph?: boolean;
    /**
     * 是否采集一级标题块（NodeHeading h1）；默认 true。
     * 六级独立；全关不采标题块。≠ 文档标题。标题非容器，不抑制其后兄弟块。
     */
    includeHeadingH1?: boolean;
    includeHeadingH2?: boolean;
    includeHeadingH3?: boolean;
    includeHeadingH4?: boolean;
    includeHeadingH5?: boolean;
    includeHeadingH6?: boolean;
    /** 是否采集公式块（NodeMathBlock）；默认 true；不含行内公式 */
    includeMathBlock?: boolean;
    /** 是否采集嵌入块（NodeBlockQueryEmbed）及其内部渲染内容；默认 true */
    includeEmbedBlock?: boolean;
    /** 是否采集普通代码块；默认 true。不含 Mermaid、flowchart。 */
    includeCodeBlock?: boolean;
    /** 是否采集 Mermaid 图；默认 true。不受代码块开关影响。 */
    includeMermaid?: boolean;
    /** 是否采集 flowchart 图；默认 true。不受代码块开关影响。 */
    includeFlowchart?: boolean;
    /**
     * 是否采集 HTML 块（NodeHTMLBlock）Shadow 内渲染可见文字；默认 true。
     * 不搜 data-content 源码；不可替换。
     */
    includeHtmlBlock?: boolean;
    /** 是否采集非标题折叠块中的内容；省略时保持低层采集器的历史行为（采集）。 */
    includeFoldedBlocks?: boolean;
    /** 是否采集行内备注（data-inline-memo-content）；默认 false */
    includeInlineMemo?: boolean;
    /**
     * 限制查找行内类型；空 / 省略 = 不限制。
     * 与 includeInlineMemo 共同决定是否采备注；仅限制备注/公式等属性类型时跳过正文。
     */
    restrictInlineTypes?: RestrictInlineType[];
    /**
     * 只采集这些根节点里的块。省略时采集整篇编辑器。
     * 根节点自身若是块，也会计入。
     */
    scopeRoots?: HTMLElement[];
}

export function collectSearchableBlocks(
    edit: Element,
    options: CollectSearchableBlocksOptions = {},
): SearchableBlock[] {
    const includeDocTitle = options.includeDocTitle !== false;
    const includeImageTitle = options.includeImageTitle !== false;
    const includeAttributeView = options.includeAttributeView !== false;
    const includeTable = options.includeTable !== false;
    const includeBlockquote = options.includeBlockquote !== false;
    const includeCallout = options.includeCallout !== false;
    const includeSuperBlock = options.includeSuperBlock !== false;
    const includeTabs = options.includeTabs !== false;
    const includeMindmap = options.includeMindmap !== false;
    const includeListUnordered = options.includeListUnordered !== false;
    const includeListOrdered = options.includeListOrdered !== false;
    const includeListTask = options.includeListTask !== false;
    const includeParagraph = options.includeParagraph !== false;
    const includeHeadingH1 = options.includeHeadingH1 !== false;
    const includeHeadingH2 = options.includeHeadingH2 !== false;
    const includeHeadingH3 = options.includeHeadingH3 !== false;
    const includeHeadingH4 = options.includeHeadingH4 !== false;
    const includeHeadingH5 = options.includeHeadingH5 !== false;
    const includeHeadingH6 = options.includeHeadingH6 !== false;
    const includeMathBlock = options.includeMathBlock !== false;
    const includeEmbedBlock = options.includeEmbedBlock !== false;
    const includeCodeBlock = options.includeCodeBlock !== false;
    const includeMermaid = options.includeMermaid !== false;
    const includeFlowchart = options.includeFlowchart !== false;
    const includeHtmlBlock = options.includeHtmlBlock !== false;
    // 这是被替换、选区可视化等低层路径共用的采集器。省略选项时保留它们
    // 原有的“完整 DOM”语义；搜索管线始终显式传入用户开关。
    const includeFoldedBlocks = options.includeFoldedBlocks !== false;
    beginTextCollection(includeFoldedBlocks);
    const includeInlineMemo = options.includeInlineMemo === true;
    // 限制未传 / 空数组：保持旧行为；非空才 normalize（含备注门闩）
    const rawRestrict = options.restrictInlineTypes;
    const restrictInlineTypes = Array.isArray(rawRestrict) && rawRestrict.length > 0 ?
        normalizeRestrictInlineTypes(rawRestrict, {includeInlineMemo}) :
        [];
    const collectBodyText = shouldCollectBodyTextForRestrict(restrictInlineTypes);
    const collectMemo = shouldCollectInlineMemoUnits({
        includeInlineMemo,
        restrictTypes: restrictInlineTypes,
    });
    const collectMath = shouldCollectInlineMathUnits(restrictInlineTypes);
    const scopeRoots = (options.scopeRoots ?? []).filter((root) => root.isConnected);
    const scoped = scopeRoots.length > 0;
    const docRoot = resolveDocRoot(edit);
    if (!scoped && !docRoot) {
        return [];
    }

    const includeGates: IncludeGates = {
        includeAttributeView,
        includeTable,
        includeBlockquote,
        includeCallout,
        includeSuperBlock,
        includeListUnordered,
        includeListOrdered,
        includeListTask,
        includeParagraph,
        includeHeadingH1,
        includeHeadingH2,
        includeHeadingH3,
        includeHeadingH4,
        includeHeadingH5,
        includeHeadingH6,
        includeMathBlock,
        includeEmbedBlock,
        includeCodeBlock,
        includeMermaid,
        includeFlowchart,
        includeHtmlBlock,
        includeMindmap,
    };

    const blocks: SearchableBlock[] = [];
    if (!scoped && collectBodyText && includeDocTitle) {
        const titleUnit = collectDocTitleUnit(edit);
        if (titleUnit) {
            blocks.push(titleUnit);
        }
    }

    // 关嵌入时在去重阶段即排除嵌入 DOM，避免同 id 只保留嵌入副本而漏掉正文
    const blockElements = !collectBodyText ?
        [] :
        scoped ?
        collectScopedBlockElements(scopeRoots, !includeEmbedBlock) :
        getUniqueBlockElements(docRoot as HTMLElement, {excludeEmbed: !includeEmbedBlock});
    if (!scoped && docRoot && collectBodyText && blockElements.length === 0) {
        const textNodes = collectTextNodes(docRoot, null, includeImageTitle);
        const text = textNodes.map((node) => node.nodeValue ?? "").join("");
        if (text) {
            blocks.push({
                blockId: PREVIEW_BLOCK_ID,
                blockType: PREVIEW_BLOCK_TYPE,
                blockIndex: 0,
                element: docRoot,
                text,
                textNodes,
            });
        }
        if (collectMemo) {
            blocks.push(...filterAttributeUnitsByIncludeGates(
                collectInlineMemoSearchUnits(docRoot, includeImageTitle),
                includeGates,
            ));
        }
        if (collectMath) {
            blocks.push(...filterAttributeUnitsByIncludeGates(
                collectInlineMathSearchUnits(docRoot),
                includeGates,
            ));
        }
        return filterFoldedSearchableBlocks(blocks, includeFoldedBlocks);
    }

    blockElements.forEach((element, blockIndex) => {
        const blockId = element.dataset.nodeId?.trim();
        const blockType = element.dataset.type?.trim() || "unknown";
        if (!blockId) {
            return;
        }

        // 非标题折叠仍保留在 DOM。这里必须在匹配前排除，否则“仅加载区”
        // 及全文索引降级路径会先生成命中、再因 Range 不可见而留下错误计数。
        // isUnderNonHeadingCssFold 故意包含自身：折叠容器的标题/首段也属于
        // 此开关控制的折叠内容，和 Range 可见性、未加载语料的过滤语义一致。
        if (!includeFoldedBlocks && isUnderNonHeadingCssFold(element)) {
            return;
        }

        // 关掉页签块时，页签标题和页签内的块都不采集
        if (!includeTabs && element.closest('[data-type="NodeTabs"]')) {
            return;
        }

        // 关掉思维导图时，导图内的源块都不采集。画布副本在后面单独收。
        if (!includeMindmap && isInsideMindmapBlock(element)) {
            return;
        }

        // 页签标题的可见文字在导航标签上。有可见标签时不再采集被隐藏的原文，避免同一个词计两次。
        if (includeTabs && hiddenTabsTitleCoveredByLabel(element)) {
            return;
        }

        // 表格内部单元格/嵌套块由 NodeTable 按格拆分，避免重复采集
        if (blockType !== TABLE_TYPE) {
            const tableAncestor = element.closest<HTMLElement>(`[data-type="${TABLE_TYPE}"]`);
            if (tableAncestor && tableAncestor !== element) {
                return;
            }
        }

        // 引述 / 提示 / 嵌入为容器块：关开关时跳过容器本身及其内部全部子块
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/blockRender.ts
        if (
            !includeBlockquote &&
            (blockType === BLOCKQUOTE_TYPE ||
                element.classList.contains("bq") ||
                Boolean(element.closest(`[data-type="${BLOCKQUOTE_TYPE}"], .bq`)))
        ) {
            return;
        }
        if (
            !includeCallout &&
            (blockType === CALLOUT_TYPE ||
                element.classList.contains("callout") ||
                Boolean(element.closest(`[data-type="${CALLOUT_TYPE}"], .callout`)))
        ) {
            return;
        }
        // 超级块：容器门闩，关则跳过自身及内部全部子块（与引述/提示同类）
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
        if (
            !includeSuperBlock &&
            (blockType === SUPER_BLOCK_TYPE ||
                element.classList.contains("sb") ||
                Boolean(element.closest(`[data-type="${SUPER_BLOCK_TYPE}"], .sb`)))
        ) {
            return;
        }
        // 列表：按最近 NodeList / NodeListItem 的 data-subtype（u/o/t）门闩；嵌套取最近祖先
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/search/menu.ts subTypes
        if (
            shouldSkipElementByListInclude(element, {
                includeListUnordered,
                includeListOrdered,
                includeListTask,
            })
        ) {
            return;
        }
        if (
            !includeEmbedBlock &&
            (blockType === EMBED_BLOCK_TYPE ||
                Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`)))
        ) {
            return;
        }
        // 标题块级别门闩（在容器门闩之后 = AND）：仅 NodeHeading 自身 / 其 DOM 内文本；
        // 不抑制折叠展开后的兄弟段落。落在已关的引述/提示/列表/嵌入内时上面已 return。
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
        if (
            shouldSkipElementByHeadingInclude(element, {
                includeHeadingH1,
                includeHeadingH2,
                includeHeadingH3,
                includeHeadingH4,
                includeHeadingH5,
                includeHeadingH6,
            })
        ) {
            return;
        }
        // 段落：叶子门闩。关段落时正文不采；若仍开图片标题则只采段内 `.protyle-action__title`
        if (
            (blockType === PARAGRAPH_TYPE || element.classList.contains("p")) &&
            !includeParagraph
        ) {
            if (includeImageTitle) {
                blocks.push(...collectImageTitleSearchUnits(element, blockId, blockIndex));
            }
            return;
        }

        if (blockType === ATTRIBUTE_VIEW_TYPE) {
            if (!includeAttributeView) {
                return;
            }
            // 数据库按单元格拆成独立搜索单元，禁止跨「框」拼接匹配
            blocks.push(...collectAttributeViewSearchUnits(
                element,
                blockId,
                blockIndex,
                includeImageTitle,
                includeGates,
            ));
            return;
        }

        if (blockType === TABLE_TYPE || element.classList.contains("table")) {
            if (!includeTable) {
                return;
            }
            // 表格按单元格拆分，禁止「传感器」+「2026」拼成「传感器20」
            // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/table.ts
            blocks.push(...collectTableSearchUnits(
                element,
                blockId,
                blockIndex,
                includeImageTitle,
                includeGates,
            ));
            return;
        }

        // 公式 / HTML / 各类图表均走同一 adapter。live 与 offscreen 因此会产生相同的
        // unitId、搜索边界和 Text 偏移；没有真实 Text 的 img/canvas 图表不回退源码。
        const rendererKind = rendererAdapterKind(element);
        if (rendererKind) {
            if (
                !rendererEnabled(rendererKind, {
                    includeMathBlock,
                    includeHtmlBlock,
                    includeCodeBlock,
                    includeMermaid,
                    includeFlowchart,
                })
            ) {
                return;
            }
            blocks.push(...collectRendererSearchUnits(element, {
                blockId,
                blockType,
                blockIndex,
            }, rendererKind));
            return;
        }

        // 普通代码块由 includeCodeBlock 控制
        if (blockType === CODE_BLOCK_TYPE && !includeCodeBlock) {
            return;
        }

        // 挂件块：内容在 iframe 内，当前不支持搜索（始终跳过）
        // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isNotEditBlock
        if (blockType === WIDGET_TYPE) {
            return;
        }

        if (blockType === CALLOUT_TYPE || element.classList.contains("callout")) {
            // Callout 标题在 .callout-title（非 contenteditable 子块），需单独采集
            // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts getCalloutInfo
            blocks.push(...collectCalloutSearchUnits(element, blockId, blockIndex, includeImageTitle));
            return;
        }

        const textNodes = collectTextNodes(element, element, includeImageTitle);
        blocks.push(...unitsFromTextNodes({
            blockId,
            blockType,
            blockIndex,
            element,
        }, textNodes));
    });

    const attributeRoots = scoped ? scopeRoots : (docRoot ? [docRoot] : []);
    if (includeTabs && collectBodyText) {
        blocks.push(...collectTabsTitleUnits(attributeRoots));
    }
    if (includeMindmap && collectBodyText) {
        blocks.push(...collectMindmapPreviewUnits(attributeRoots));
    }
    if (collectMemo) {
        attributeRoots.forEach((root) => {
            blocks.push(...filterAttributeUnitsByIncludeGates(
                collectInlineMemoSearchUnits(root, includeImageTitle),
                includeGates,
            ));
        });
    }
    if (collectMath) {
        attributeRoots.forEach((root) => {
            blocks.push(...filterAttributeUnitsByIncludeGates(
                collectInlineMathSearchUnits(root),
                includeGates,
            ));
        });
    }

    // 备注、行内公式、页签标题等独立单元不会经过上面的 blockElements 循环，
    // 因而在统一出口按其实际元素再过滤一次。
    return filterFoldedSearchableBlocks(blocks, includeFoldedBlocks);
}

function filterFoldedSearchableBlocks(
    blocks: SearchableBlock[],
    includeFoldedBlocks: boolean,
): SearchableBlock[] {
    if (includeFoldedBlocks) {
        return blocks;
    }
    return blocks.filter((block) => !isUnderNonHeadingCssFold(block.element));
}

/** 「是否查找」块级门闩：备注 / 行内公式独立采集时也须遵守 */
interface IncludeGates {
    includeAttributeView: boolean;
    includeTable: boolean;
    includeBlockquote: boolean;
    includeCallout: boolean;
    includeSuperBlock: boolean;
    includeListUnordered: boolean;
    includeListOrdered: boolean;
    includeListTask: boolean;
    includeParagraph: boolean;
    includeHeadingH1: boolean;
    includeHeadingH2: boolean;
    includeHeadingH3: boolean;
    includeHeadingH4: boolean;
    includeHeadingH5: boolean;
    includeHeadingH6: boolean;
    includeMathBlock: boolean;
    includeEmbedBlock: boolean;
    includeCodeBlock: boolean;
    includeMermaid: boolean;
    includeFlowchart: boolean;
    includeHtmlBlock: boolean;
    includeMindmap: boolean;
}

type HeadingIncludeGates = Pick<
    IncludeGates,
    | "includeHeadingH1"
    | "includeHeadingH2"
    | "includeHeadingH3"
    | "includeHeadingH4"
    | "includeHeadingH5"
    | "includeHeadingH6"
>;

/** 标题级别：与官方 subTypes h1–h6 / data-subtype 一致 */
export type HeadingLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * 若元素落在 NodeHeading DOM 内（含标题块自身），返回其 data-subtype。
 * 标题不是容器：随后兄弟段落 closest 不到标题，不会被误伤。
 * 文档标题（.protyle-title）不是 NodeHeading，返回 null。
 */
export function resolveHeadingLevel(element: Element): HeadingLevel | null {
    const heading = element.closest<HTMLElement>(
        `[data-type="${HEADING_TYPE}"][data-subtype], div.h1[data-subtype], div.h2[data-subtype], div.h3[data-subtype], div.h4[data-subtype], div.h5[data-subtype], div.h6[data-subtype]`,
    );
    if (!heading) {
        return null;
    }
    const sub = heading.getAttribute("data-subtype");
    if (
        sub === "h1" || sub === "h2" || sub === "h3" ||
        sub === "h4" || sub === "h5" || sub === "h6"
    ) {
        return sub;
    }
    return null;
}

export function isHeadingLevelIncluded(
    level: HeadingLevel,
    gates: HeadingIncludeGates,
): boolean {
    switch (level) {
        case "h1":
            return gates.includeHeadingH1;
        case "h2":
            return gates.includeHeadingH2;
        case "h3":
            return gates.includeHeadingH3;
        case "h4":
            return gates.includeHeadingH4;
        case "h5":
            return gates.includeHeadingH5;
        case "h6":
            return gates.includeHeadingH6;
        default: {
            const _exhaustive: never = level;
            return _exhaustive;
        }
    }
}

/**
 * 落在已关闭级别的标题块 DOM 内则跳过。
 * 与引述/提示/列表/嵌入等容器门闩独立，调用方须先做容器判断（AND）。
 */
export function shouldSkipElementByHeadingInclude(
    element: Element,
    gates: HeadingIncludeGates,
): boolean {
    const level = resolveHeadingLevel(element);
    if (!level) {
        return false;
    }
    return !isHeadingLevelIncluded(level, gates);
}

/** 列表 subtype：u=无序 / o=有序 / t=任务 */
export type ListSubtype = "u" | "o" | "t";

/**
 * 最近列表祖先的 subtype（优先 ListItem，再 List；嵌套列表取最近一层）。
 * 不在列表内则返回 null。
 */
export function resolveNearestListSubtype(element: Element): ListSubtype | null {
    const listish = element.closest<HTMLElement>(
        `[data-type="${LIST_ITEM_TYPE}"][data-subtype], [data-type="${LIST_TYPE}"][data-subtype], .li[data-subtype], .list[data-subtype]`,
    );
    if (!listish) {
        return null;
    }
    const sub = listish.getAttribute("data-subtype");
    if (sub === "u" || sub === "o" || sub === "t") {
        return sub;
    }
    return null;
}

export function isListSubtypeIncluded(
    subtype: ListSubtype,
    gates: Pick<IncludeGates, "includeListUnordered" | "includeListOrdered" | "includeListTask">,
): boolean {
    if (subtype === "u") {
        return gates.includeListUnordered;
    }
    if (subtype === "o") {
        return gates.includeListOrdered;
    }
    return gates.includeListTask;
}

/** 落在已关闭 subtype 的列表区内则跳过 */
export function shouldSkipElementByListInclude(
    element: Element,
    gates: Pick<IncludeGates, "includeListUnordered" | "includeListOrdered" | "includeListTask">,
): boolean {
    const subtype = resolveNearestListSubtype(element);
    if (!subtype) {
        return false;
    }
    return !isListSubtypeIncluded(subtype, gates);
}

/**
 * 行内备注 / 行内公式扫整棵文档树，不会走块级 forEach 的 include* 早退。
 * 关表格 / 引述 / 提示 / 嵌入 / 数据库等时，须在此过滤其内部的属性 unit。
 */
function shouldSkipAttributeUnitByIncludeGates(element: Element, gates: IncludeGates): boolean {
    if (
        !gates.includeAttributeView &&
        Boolean(element.closest(`[data-type="${ATTRIBUTE_VIEW_TYPE}"], .av`))
    ) {
        return true;
    }
    if (
        !gates.includeTable &&
        Boolean(element.closest(`[data-type="${TABLE_TYPE}"], .table`))
    ) {
        return true;
    }
    if (
        !gates.includeBlockquote &&
        Boolean(element.closest(`[data-type="${BLOCKQUOTE_TYPE}"], .bq`))
    ) {
        return true;
    }
    if (
        !gates.includeCallout &&
        Boolean(element.closest(`[data-type="${CALLOUT_TYPE}"], .callout`))
    ) {
        return true;
    }
    if (
        !gates.includeSuperBlock &&
        Boolean(element.closest(`[data-type="${SUPER_BLOCK_TYPE}"], .sb`))
    ) {
        return true;
    }
    if (!gates.includeMindmap && isInsideMindmapBlock(element)) {
        return true;
    }
    if (shouldSkipElementByListInclude(element, gates)) {
        return true;
    }
    // 段落叶子门闩：备注/公式宿主落在段落 DOM 内时随 includeParagraph；
    // 图片标题在关段落时走专项 unit，不依赖本过滤。
    if (
        !gates.includeParagraph &&
        isInsideParagraphBlock(element) &&
        !element.closest(IMAGE_TITLE_TEXT_CLOSEST)
    ) {
        return true;
    }
    // 标题级别：备注/公式宿主若在某级标题 DOM 内，随该级开关；与容器门闩 AND
    if (shouldSkipElementByHeadingInclude(element, gates)) {
        return true;
    }
    if (
        !gates.includeEmbedBlock &&
        Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`))
    ) {
        return true;
    }
    // 挂件始终不搜（含其外壳上的行内备注 / 公式宿主）
    if (Boolean(element.closest(`[data-type="${WIDGET_TYPE}"]`))) {
        return true;
    }
    if (
        !gates.includeHtmlBlock &&
        Boolean(element.closest(`[data-type="${HTML_BLOCK_TYPE}"]`))
    ) {
        return true;
    }
    const codeBlock = element.closest<HTMLElement>(`[data-type="${CODE_BLOCK_TYPE}"]`);
    if (codeBlock) {
        const kind = rendererAdapterKind(codeBlock);
        if (
            kind ?
                !rendererEnabled(kind, gates) :
                !gates.includeCodeBlock
        ) {
            return true;
        }
    }
    return false;
}

function filterAttributeUnitsByIncludeGates(
    units: SearchableBlock[],
    gates: IncludeGates,
): SearchableBlock[] {
    return units.filter((unit) => !shouldSkipAttributeUnitByIncludeGates(unit.element, gates));
}

function isInsideEmbedBlock(element: Element): boolean {
    return Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`));
}

/** 范围采集：计入根自身，再计入其中的子块。多个根的后代互不重叠。 */
function collectScopedBlockElements(roots: HTMLElement[], excludeEmbed: boolean): HTMLElement[] {
    const byId = new Map<string, HTMLElement>();
    const consider = (element: HTMLElement) => {
        const blockId = element.dataset.nodeId?.trim();
        if (!blockId || !element.dataset.type) {
            return;
        }
        if (excludeEmbed && isInsideEmbedBlock(element)) {
            return;
        }
        const existing = byId.get(blockId);
        if (!existing || shouldPreferBlockElement(element, existing)) {
            byId.set(blockId, element);
        }
    };
    roots.forEach((root) => {
        consider(root);
        getUniqueBlockElements(root, {excludeEmbed}).forEach(consider);
    });
    return Array.from(byId.values());
}

function getUniqueBlockElements(
    root: ParentNode,
    options: {excludeEmbed?: boolean;} = {},
): HTMLElement[] {
    const byId = new Map<string, HTMLElement>();
    const excludeEmbed = options.excludeEmbed === true;

    Array.from(root.querySelectorAll<HTMLElement>("[data-node-id][data-type]")).forEach((element) => {
        const blockId = element.dataset.nodeId?.trim();
        if (!blockId) {
            return;
        }
        if (excludeEmbed && isInsideEmbedBlock(element)) {
            return;
        }

        const existing = byId.get(blockId);
        if (!existing || shouldPreferBlockElement(element, existing)) {
            byId.set(blockId, element);
        }
    });

    return Array.from(byId.values());
}

/** 同一 blockId 多份 DOM 时，优先已渲染/内容更完整的实例 */
function shouldPreferBlockElement(candidate: HTMLElement, existing: HTMLElement): boolean {
    const candidateRendered = candidate.getAttribute("data-render") === "true";
    const existingRendered = existing.getAttribute("data-render") === "true";
    if (candidateRendered !== existingRendered) {
        return candidateRendered;
    }

    const candidateCells = candidate.querySelectorAll(".av__cell, .b3-chip, .av__celltext").length;
    const existingCells = existing.querySelectorAll(".av__cell, .b3-chip, .av__celltext").length;
    if (candidateCells !== existingCells) {
        return candidateCells > existingCells;
    }

    return (candidate.textContent?.length ?? 0) > (existing.textContent?.length ?? 0);
}

/**
 * 关段落块但仍开图片标题时：只采集块内 `.img .protyle-action__title` 可见字。
 * 每个标题一个 unit，便于替换路径按标题 DOM 写回。
 */
function collectImageTitleSearchUnits(
    ownerBlock: HTMLElement,
    blockId: string,
    blockIndex: number,
): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const titles = Array.from(
        ownerBlock.querySelectorAll<HTMLElement>(IMAGE_TITLE_TEXT_CLOSEST),
    ).filter((title) => {
        return getOwnerBlock(title) === ownerBlock;
    });
    titles.forEach((titleElement, index) => {
        const textNodes = collectDescendantTextNodes(titleElement, true);
        units.push(...unitsFromTextNodes({
            blockId,
            blockType: PARAGRAPH_TYPE,
            blockIndex,
            element: titleElement,
            unitId: `image-title:${index}`,
        }, textNodes));
    });
    return units;
}

/**
 * Callout：标题在 .callout-title，正文在 .callout-content 内的子块。
 * 正文子块仍由 getUniqueBlockElements 单独收集；此处保证标题可搜。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/callout.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts
 */
function collectCalloutSearchUnits(
    calloutBlock: HTMLElement,
    blockId: string,
    blockIndex: number,
    includeImageTitle = true,
): SearchableBlock[] {
    const units: SearchableBlock[] = [];

    const titleElement = calloutBlock.querySelector<HTMLElement>(".callout-title");
    if (titleElement) {
        const titleNodes = collectDescendantTextNodes(titleElement, includeImageTitle);
        units.push(...unitsFromTextNodes({
            blockId,
            blockType: CALLOUT_TYPE,
            blockIndex,
            element: titleElement,
            unitId: "callout-title",
        }, titleNodes));
    }

    // Callout 容器上可能还有标题区以外、且不属于子块的少量文本（一般为空）
    const ownedNodes = collectTextNodes(calloutBlock, calloutBlock, includeImageTitle).filter((node) => {
        return !titleElement || !titleElement.contains(node);
    });
    units.push(
        ...unitsFromTextNodes({
            blockId,
            blockType: CALLOUT_TYPE,
            blockIndex,
            element: calloutBlock,
            unitId: "callout-owned",
        }, ownedNodes).filter((unit) => unit.text.trim()),
    );

    return units;
}

/** 收集元素后代文本，仅排除 svg/style/script/protyle-attr（及可选的图片标题） */
function collectDescendantTextNodes(
    container: HTMLElement,
    includeImageTitle = true,
    headingGates?: HeadingIncludeGates,
): Text[] {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }
            const parentElement = node.parentElement;
            if (!parentElement || parentElement.closest(TEXT_NODE_EXCLUDED_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }
            // 表格/AV 格内若嵌有标题块，正文走整格采集；须按标题级别门闩剔除其文本
            if (headingGates && shouldSkipElementByHeadingInclude(parentElement, headingGates)) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    return collectWalkerTextNodes(walker);
}

/**
 * 将表格拆成按单元格的搜索单元。
 * NodeTable 下相邻 td/th 文本首尾相接，整块拼接会把「传感器」+「2026」误匹配成「传感器20」。
 *
 * 行号按 table.rows 的逻辑行计，不用 `row.parentElement.children`：
 * thead 和 tbody 分开时，局部行号会撞车，数据格会被跳过。
 * 大表的占位行按属性里的 tr 个数展开，不把占位行本身算成一行，
 * 这样画面 unitId 和 getBlockDOM 的完整表使用同一套行号。
 */
function collectTableSearchUnits(
    tableBlock: HTMLElement,
    blockId: string,
    blockIndex: number,
    includeImageTitle = true,
    headingGates?: HeadingIncludeGates,
): SearchableBlock[] {
    const htmlRows = ownTableRows(tableBlock);
    if (htmlRows) {
        const collected = collectHtmlTableUnits(
            htmlRows,
            blockId,
            blockIndex,
            includeImageTitle,
            headingGates,
        );
        const virtual = htmlRows.some((row) => row.hasAttribute(TABLE_VIRTUAL_ROWS_ATTR));
        if (collected.length || virtual) {
            return collected;
        }
    }
    return collectLooseTableUnits(tableBlock, blockId, blockIndex, includeImageTitle, headingGates);
}

function collectHtmlTableUnits(
    htmlRows: readonly HTMLTableRowElement[],
    blockId: string,
    blockIndex: number,
    includeImageTitle: boolean,
    headingGates?: HeadingIncludeGates,
): SearchableBlock[] {
    const placed = logicalTableRows(htmlRows);
    const units: SearchableBlock[] = [];
    const seenUnitKeys = new Set<string>();
    for (let index = 0; index < placed.rows.length; index += 1) {
        const place = placed.rows[index];
        if (place.omitted !== 0) {
            continue;
        }
        const row = htmlRows[index];
        const children = row.children;
        let column = 0;
        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
            const child = children[childIndex];
            if (!isDirectTableCell(child)) {
                continue;
            }
            pushTableCellUnit(
                units,
                seenUnitKeys,
                child,
                place.logical,
                column,
                blockId,
                blockIndex,
                includeImageTitle,
                headingGates,
            );
            column += 1;
        }
    }
    return units;
}

/** 没有 html table 时的兜底。这种结构不会被思源虚拟化，行号就是 DOM 顺序。 */
function collectLooseTableUnits(
    tableBlock: HTMLElement,
    blockId: string,
    blockIndex: number,
    includeImageTitle: boolean,
    headingGates?: HeadingIncludeGates,
): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const seenUnitKeys = new Set<string>();
    const rows = getTableRowElements(tableBlock);
    const rowIndex = new Map<HTMLElement, number>();
    for (let index = 0; index < rows.length; index += 1) {
        rowIndex.set(rows[index], index);
    }
    const cells = getTableCellElements(tableBlock, rows);
    for (let index = 0; index < cells.length; index += 1) {
        const cell = cells[index];
        const row = cell.closest<HTMLElement>(".table__row, tr");
        if (!row || row.hasAttribute(TABLE_VIRTUAL_ROWS_ATTR)) {
            continue;
        }
        const logical = rowIndex.get(row);
        const column = directTableCellColumn(row, cell);
        if (logical === undefined || column < 0) {
            continue;
        }
        pushTableCellUnit(
            units,
            seenUnitKeys,
            cell,
            logical,
            column,
            blockId,
            blockIndex,
            includeImageTitle,
            headingGates,
        );
    }
    return units;
}

function pushTableCellUnit(
    units: SearchableBlock[],
    seenUnitKeys: Set<string>,
    cell: HTMLElement,
    logicalRow: number,
    columnIndex: number,
    blockId: string,
    blockIndex: number,
    includeImageTitle: boolean,
    headingGates?: HeadingIncludeGates,
): void {
    if (logicalRow < 0 || columnIndex < 0) {
        return;
    }
    const cellId = cell.dataset.nodeId?.trim() || "";
    const unitId = cellId ?
        `table-cell:${logicalRow}:${columnIndex}:${cellId}` :
        `table-cell:${logicalRow}:${columnIndex}`;
    if (seenUnitKeys.has(unitId)) {
        return;
    }
    const textNodes = collectDescendantTextNodes(tableCellTextRoot(cell), includeImageTitle, headingGates);
    const produced = unitsFromTextNodes({
        blockId,
        blockType: TABLE_TYPE,
        blockIndex,
        element: cell,
        unitId,
    }, textNodes);
    if (produced.length === 0) {
        return;
    }
    seenUnitKeys.add(unitId);
    units.push(...produced);
}

/** 行的直接子节点里，算作单元格的元素。嵌套表的格子不在 children 里。 */
export function isDirectTableCell(element: Element): element is HTMLElement {
    return element instanceof HTMLElement && element.matches(TABLE_CELL_SELECTOR);
}

/** 格子在本行直接子单元格里的序号。嵌套表的格子不在 children 里，不会被数进来。 */
export function directTableCellColumn(row: HTMLElement, cell: HTMLElement): number {
    const children = row.children;
    let column = 0;
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!isDirectTableCell(child)) {
            continue;
        }
        if (child === cell) {
            return column;
        }
        column += 1;
    }
    return -1;
}

const RICH_TABLE_CELL_SELECTOR =
    'td[data-sy-table-cell-rich], th[data-sy-table-cell-rich], [data-type="NodeTableCell"][data-sy-table-cell-rich], .table__cell[data-sy-table-cell-rich]';

/**
 * 富文本格和正在编辑的格子不能按画面文字替换。
 * 富文本的源码在属性里，思源写回时会按属性重画。
 * 编辑器开着时，提交要等它自己结束；这之前整表被换掉，这次修改就丢了。
 */
export function tableCellReplaceLock(element: Element | null | undefined): TableReplaceLock | undefined {
    if (!element || typeof element.closest !== "function") {
        return undefined;
    }
    // 不在格子里的块到这里就结束，避免每个段落都再往下查编辑器。
    const cell = element.closest('td, th, [data-type="NodeTableCell"], .table__cell');
    if (!(cell instanceof HTMLElement)) {
        return undefined;
    }
    // 富文本属性在 td/th 上。嵌套内容也算在外层富文本格里。
    if (cell.closest(RICH_TABLE_CELL_SELECTOR)) {
        return "table-rich";
    }
    // 编辑器是格子的直接子节点。格内 span 能 closest 到它；格子单元本身只看这一层。
    if (
        element.closest(TABLE_CELL_EDITOR_SELECTOR) ||
        cell.querySelector(`:scope > ${TABLE_CELL_EDITOR_SELECTOR}`)
    ) {
        return "table-cell-editor";
    }
    return undefined;
}

/** 正在编辑的格子只取编辑区正文。工具栏和公式面板也挂在格子里，隐藏后标题字还留在 DOM 上。 */
function tableCellTextRoot(cell: HTMLElement): HTMLElement {
    const editor = cell.querySelector<HTMLElement>(`:scope > ${TABLE_CELL_EDITOR_SELECTOR}`);
    return editor?.querySelector<HTMLElement>(".protyle-wysiwyg") ?? cell;
}

/** 与表格单元格搜索单元同一套正文节点，供划选偏移对齐。 */
export function collectTableCellSearchTextNodes(cell: HTMLElement, includeImageTitle = true): Text[] {
    return collectDescendantTextNodes(tableCellTextRoot(cell), includeImageTitle);
}

export function tableCellSearchRoot(cell: HTMLElement): HTMLElement {
    return tableCellTextRoot(cell);
}

/** 当前表格内的行（文档序），排除嵌套表格中的行 */
function getTableRowElements(tableBlock: HTMLElement): HTMLElement[] {
    return Array.from(tableBlock.querySelectorAll<HTMLElement>(".table__row, tr")).filter((row) => {
        const owner = row.closest<HTMLElement>(`[data-type="${TABLE_TYPE}"]`);
        return owner === tableBlock || (!owner && tableBlock.contains(row));
    });
}

function getTableCellElements(
    tableBlock: HTMLElement,
    rows: HTMLElement[] = getTableRowElements(tableBlock),
): HTMLElement[] {
    if (rows.length) {
        const cells: HTMLElement[] = [];
        rows.forEach((row) => {
            Array.from(row.children).forEach((child) => {
                if (child instanceof HTMLElement && child.matches(TABLE_CELL_SELECTOR)) {
                    cells.push(child);
                }
            });
        });
        if (cells.length) {
            return cells;
        }
    }

    // 回退：直接取单元格，再去掉被其他单元格包含的嵌套节点
    const allCells = Array.from(tableBlock.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR));
    return allCells.filter((cell, index) => (
        !allCells.some((other, otherIndex) => otherIndex !== index && other.contains(cell))
    ));
}

/** 月历条目的阅读位置：周从上到下，一周内从左到右，同一天再从上到下。 */
function calendarEventPlace(item: HTMLElement | null): {week: number; column: number; lane: number;} {
    const weekText = item?.closest<HTMLElement>(".av__calendar-week")?.getAttribute("data-calendar-week") || "";
    const week = Number(weekText);
    return {
        week: weekText && !isNaN(week) ? week : 0,
        column: gridLineIndex(item ? item.style.gridColumn || item.getAttribute("style") || "" : "", "grid-column"),
        lane: gridLineIndex(item ? item.style.gridRow || item.getAttribute("style") || "" : "", "grid-row"),
    };
}

function gridLineIndex(value: string, token: string): number {
    const marked = value.indexOf(token);
    const source = marked >= 0 ? value.slice(marked + token.length) : value;
    let index = 0;
    while (index < source.length) {
        const code = source.charCodeAt(index);
        if (code >= 48 && code <= 57) {
            break;
        }
        index += 1;
    }
    const parsed = parseInt(source.slice(index), 10);
    return parsed > 0 ? parsed : 0;
}

/**
 * 将数据库拆成按单元格的搜索单元。
 * 思源 AV 中相邻单元格 textContent 首尾相接，整块拼接会把「传感器」+「2026」误匹配成「传感器20」。
 *
 * 分组视图跳转顺序：组标题 → 该组子表单元格 → 下一组标题 → …（而非先扫完所有组标题再扫表）。
 * DOM：av__group-title 与 av__body[data-group-id] 成对出现（renderGroupTable / renderGroupGallery）。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/cell.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/render.ts
 */
function collectAttributeViewSearchUnits(
    avBlock: HTMLElement,
    blockId: string,
    blockIndex: number,
    includeImageTitle = true,
    headingGates?: HeadingIncludeGates,
): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const seenUnitKeys = new Set<string>();

    const pushUnit = (container: HTMLElement, unitId: string) => {
        if (seenUnitKeys.has(unitId)) {
            return;
        }
        const textNodes = collectTextNodesInContainer(
            container,
            avBlock,
            includeImageTitle,
            headingGates,
        );
        const text = textNodes.map((node) => node.nodeValue ?? "").join("");
        if (!text) {
            return;
        }
        seenUnitKeys.add(unitId);
        units.push({
            blockId,
            blockType: ATTRIBUTE_VIEW_TYPE,
            blockIndex,
            element: container,
            text,
            textNodes,
            unitId,
        });
    };

    const pushCellsInRoot = (root: ParentNode) => {
        const cells = Array.from(root.querySelectorAll<HTMLElement>(".av__cell")).filter((cell) => {
            if (cell.closest(".av__row--util, .av__row--footer, .av__pulse")) {
                return false;
            }
            return true;
        });

        cells.forEach((cell, index) => {
            // 分组视图下每个子表有独立表头；必须带上 groupId，否则「日期」等列名会被去重成只剩第一组
            const groupId = cell.closest<HTMLElement>(".av__body[data-group-id], [data-group-id]")
                ?.dataset.groupId
                ?.trim() ||
                "nogroup";
            const rowElement = cell.closest<HTMLElement>(".av__row, .av__gallery-item");
            const isHeader = Boolean(
                cell.classList.contains("av__cell--header") ||
                    rowElement?.classList.contains("av__row--header"),
            );
            const rowId = rowElement?.dataset.id?.trim() ||
                (isHeader ? `header:${groupId}` : "norow");
            const colId = cell.dataset.colId?.trim() ||
                cell.dataset.fieldId?.trim() ||
                cell.dataset.keyId?.trim() ||
                cell.dataset.avKeyId?.trim() ||
                `idx-${index}`;
            pushUnit(cell, `cell:${groupId}:${rowId}:${colId}`);
        });
    };

    // 日历视图不用 .av__cell，条目在 .av__calendar-item，字段在 .av__calendar-field。
    // 思源按数据库行序输出条目，不是月历上的从左到右。这里再按格子位置排。
    // @see https://github.com/siyuan-note/siyuan/blob/v3.8.6/app/src/protyle/render/av/calendar/render.ts
    const pushCalendarItems = () => {
        const pending: Array<{
            container: HTMLElement;
            unitId: string;
            week: number;
            column: number;
            lane: number;
            index: number;
        }> = [];
        const queue = (
            container: HTMLElement,
            unitId: string,
            week: number,
            column: number,
            lane: number,
        ) => {
            pending.push({container, unitId, week, column, lane, index: pending.length});
        };
        avBlock.querySelectorAll<HTMLElement>(".av__calendar-field").forEach((field, index) => {
            if (field.closest(".av__calendar-preview, .fn__none")) {
                return;
            }
            const item = field.closest<HTMLElement>(".av__calendar-item");
            const rowId = item?.getAttribute("data-id")?.trim() ||
                item?.dataset.calendarItem?.trim() ||
                "norow";
            const colId = field.dataset.colId?.trim() ||
                field.dataset.fieldId?.trim() ||
                `idx-${index}`;
            const place = calendarEventPlace(item);
            queue(field, `calendar:${rowId}:${colId}`, place.week, place.column, place.lane);
        });
        avBlock.querySelectorAll<HTMLElement>(".av__calendar-item").forEach((item) => {
            if (item.closest(".av__calendar-preview, .fn__none")) {
                return;
            }
            if (item.querySelector(".av__calendar-field")) {
                return;
            }
            const content = item.querySelector<HTMLElement>(".av__calendar-item-content");
            if (!content) {
                return;
            }
            const rowId = item.getAttribute("data-id")?.trim() ||
                item.dataset.calendarItem?.trim() ||
                "norow";
            const place = calendarEventPlace(item);
            queue(content, `calendar:${rowId}:title`, place.week, place.column, place.lane);
        });
        avBlock.querySelectorAll<HTMLElement>(".av__calendar-undated-item .b3-menu__label").forEach((label) => {
            if (label.closest(".fn__none")) {
                return;
            }
            const item = label.closest<HTMLElement>(".av__calendar-undated-item");
            const rowId = item?.dataset.calendarUndatedRow?.trim() || "undated";
            queue(label, `calendar:${rowId}:undated`, Number.POSITIVE_INFINITY, 0, 0);
        });
        pending.sort((left, right) => {
            if (left.week !== right.week) {
                return left.week < right.week ? -1 : 1;
            }
            if (left.column !== right.column) {
                return left.column - right.column;
            }
            if (left.lane !== right.lane) {
                return left.lane - right.lane;
            }
            return left.index - right.index;
        });
        pending.forEach((item) => {
            pushUnit(item.container, item.unitId);
        });
    };

    // 标题
    const title = avBlock.querySelector<HTMLElement>(".av__title");
    if (title) {
        pushUnit(title, "title");
    }

    // 视图名称（多视图 tab）
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/render.ts
    // <span class="item__text">${escapeHtml(item.name)}</span>
    avBlock.querySelectorAll<HTMLElement>(".av__views .layout-tab-bar > .item").forEach((viewTab, index) => {
        const viewId = viewTab.dataset.id?.trim() || `idx-${index}`;
        const nameElement = viewTab.querySelector<HTMLElement>(".item__text") || viewTab;
        pushUnit(nameElement, `view-name:${viewId}`);
    });

    // 设置行「新建」、各视图「添加条目」、日历「今天 / 年月」不在单元格里。
    // @see app/src/protyle/render/av/headerEditing.ts
    // @see app/src/protyle/render/av/render.ts getTableHTMLs
    // @see app/src/protyle/render/av/calendar/render.ts
    const pushChrome = (element: HTMLElement, unitId: string) => {
        if (element.closest(".fn__none, .av__calendar-preview")) {
            return;
        }
        pushUnit(element, unitId);
    };
    avBlock.querySelectorAll<HTMLElement>('[data-type="av-add-more"]').forEach((button, index) => {
        pushChrome(button, `chrome:new:${index}`);
    });
    avBlock.querySelectorAll<HTMLElement>('[data-type="av-add-bottom"]').forEach((button, index) => {
        pushChrome(button, `chrome:add-row:${index}`);
    });
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-label").forEach((label, index) => {
        pushChrome(label, `chrome:calendar-label:${index}`);
    });
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-today").forEach((button, index) => {
        pushChrome(button, `chrome:calendar-today:${index}`);
    });
    // 表头「周一」、日期数字、ISO 周数。条目字段仍由上面的日历条目收集，这里不扫 .av__calendar-events。
    // @see app/src/protyle/render/av/calendar/render.ts
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-weekdays > div").forEach((cell, index) => {
        pushChrome(cell, `chrome:calendar-weekday:${index}`);
    });
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-day > span").forEach((day, index) => {
        const stamp = day.parentElement?.getAttribute("data-calendar-day")?.trim() || String(index);
        pushChrome(day, `chrome:calendar-day:${stamp}`);
    });
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-week-number").forEach((week, index) => {
        pushChrome(week, `chrome:calendar-week:${index}`);
    });
    avBlock.querySelectorAll<HTMLElement>(".av__calendar-more").forEach((more, index) => {
        pushChrome(more, `chrome:calendar-more:${index}`);
    });

    const groupTitles = Array.from(avBlock.querySelectorAll<HTMLElement>(".av__group-title"));
    if (groupTitles.length === 0) {
        // 未分组：整表按 DOM 顺序收集单元格，并带上日历条目
        pushCellsInRoot(avBlock);
        pushCalendarItems();
        return units;
    }

    // 分组：每个组标题后紧跟对应子表，交错收集以保证跳转顺序
    const processedBodies = new Set<Element>();
    for (let index = 0; index < groupTitles.length; index++) {
        const groupTitle = groupTitles[index];
        const groupId = resolveAvGroupId(groupTitle, index);
        pushUnit(groupTitle, `group-title:${groupId}`);

        const groupBody = resolveAvGroupBody(avBlock, groupTitle, groupId);
        if (groupBody && !processedBodies.has(groupBody)) {
            pushCellsInRoot(groupBody);
            processedBodies.add(groupBody);
        }
    }

    // 兜底：尚未处理的分组 body（如未关联标题的未分组区），避免重复扫描已处理子表
    avBlock.querySelectorAll<HTMLElement>(".av__body").forEach((body) => {
        if (!processedBodies.has(body)) {
            pushCellsInRoot(body);
            processedBodies.add(body);
        }
    });

    pushCalendarItems();
    return units;
}

/** 从分组标题解析 group id（fold 按钮 data-id） */
function resolveAvGroupId(groupTitle: HTMLElement, index: number): string {
    const foldId = groupTitle.querySelector<HTMLElement>('[data-type="av-group-fold"]')
        ?.dataset.id
        ?.trim();
    return foldId || `idx-${index}`;
}

/** 分组标题对应的 av__body（优先 data-group-id，其次紧随的兄弟节点） */
function resolveAvGroupBody(
    avBlock: HTMLElement,
    groupTitle: HTMLElement,
    groupId: string,
): HTMLElement | null {
    if (groupId && !groupId.startsWith("idx-")) {
        const byId = avBlock.querySelector<HTMLElement>(`.av__body[data-group-id="${cssEscapeAttr(groupId)}"]`);
        if (byId) {
            return byId;
        }
    }

    let sibling = groupTitle.nextElementSibling as HTMLElement | null;
    while (sibling) {
        if (sibling.classList.contains("av__body")) {
            return sibling;
        }
        if (sibling.classList.contains("av__group-title")) {
            break;
        }
        sibling = sibling.nextElementSibling as HTMLElement | null;
    }
    return null;
}

function cssEscapeAttr(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 在容器内收集可搜索文本节点（数据库单元格级） */
function collectTextNodesInContainer(
    container: HTMLElement,
    avBlock: HTMLElement,
    includeImageTitle = true,
    headingGates?: HeadingIncludeGates,
): Text[] {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }

            const parentElement = node.parentElement;
            if (!parentElement || parentElement.closest(AV_EXCLUDED_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (headingGates && shouldSkipElementByHeadingInclude(parentElement, headingGates)) {
                return NodeFilter.FILTER_REJECT;
            }

            const nearestBlock = getOwnerBlock(parentElement);
            if (nearestBlock && nearestBlock !== avBlock) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    return collectWalkerTextNodes(walker);
}

function elementHasBox(element: HTMLElement): boolean {
    return element.clientHeight > 0 ||
        (typeof element.getClientRects === "function" && element.getClientRects().length > 0);
}

function hiddenTabsTitleCoveredByLabel(element: HTMLElement): boolean {
    const info = element.closest(".tab-item-info");
    if (!info) {
        return false;
    }
    const item = info.closest<HTMLElement>(".tab-item");
    if (item?.getAttribute("data-tabs-editing") === "true") {
        return false;
    }
    const tabId = item?.getAttribute("data-node-id") || "";
    const tabs = item?.parentElement;
    if (!tabId || !tabs?.classList.contains("tabs")) {
        return false;
    }
    const label = tabs.querySelector<HTMLElement>(
        `:scope > .tabs-header [data-tab-id="${CSS.escape(tabId)}"] .tabs-tab-label`,
    );
    return Boolean(label && elementHasBox(label) && (label.textContent || "").length > 0);
}

/** 把可见的页签标题标签记到原标题块上，高亮才能画在导航栏里。 */
function collectTabsTitleUnits(roots: HTMLElement[]): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const seenTabs = new Set<HTMLElement>();
    const seenItems = new Set<string>();
    const consider = (tabs: HTMLElement | null) => {
        if (!tabs || seenTabs.has(tabs) || tabs.getAttribute("data-type") !== "NodeTabs") {
            return;
        }
        seenTabs.add(tabs);
        tabs.querySelectorAll<HTMLElement>(":scope > .tabs-header [data-tab-id]").forEach((button) => {
            const tabId = button.getAttribute("data-tab-id") || "";
            if (!tabId || seenItems.has(tabId)) {
                return;
            }
            const item = tabs.querySelector<HTMLElement>(`:scope > .tab-item[data-node-id="${CSS.escape(tabId)}"]`);
            const titleBlock = item?.querySelector<HTMLElement>(
                ':scope > .tab-item-info [tabs-title="true"][data-node-id], :scope > .tab-item-info .tab-item-title',
            );
            const blockEl = titleBlock?.closest<HTMLElement>("[data-node-id][data-type]") ?? null;
            const blockId = blockEl?.getAttribute("data-node-id") || "";
            if (!item || !blockId) {
                return;
            }
            const editing = item.getAttribute("data-tabs-editing") === "true";
            const label = button.querySelector<HTMLElement>(".tabs-tab-label");
            if (editing && blockEl && elementHasBox(blockEl)) {
                return;
            }
            if (!label || !elementHasBox(label)) {
                return;
            }
            const textNodes = collectElementTextNodes(label);
            const text = textNodes.map((node) => node.nodeValue ?? "").join("");
            if (!text) {
                return;
            }
            seenItems.add(tabId);
            units.push({
                blockId,
                blockType: blockEl?.getAttribute("data-type") || "NodeParagraph",
                blockIndex: 0,
                element: label,
                text,
                textNodes,
            });
        });
    };
    for (const root of roots) {
        if (root.getAttribute("data-type") === "NodeTabs") {
            consider(root);
        }
        root.querySelectorAll<HTMLElement>('[data-type="NodeTabs"]').forEach((tabs) => consider(tabs));
        consider(root.closest<HTMLElement>('[data-type="NodeTabs"]'));
    }
    return units;
}

function collectElementTextNodes(root: HTMLElement): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    return collectWalkerTextNodes(walker);
}

/**
 * 画布副本去掉了 data-node-id，只留 data-mindmap-source-id。
 * 用源块 id 记这一份可见文字，避免和隐藏源块、导图容器各计一次。
 */
const MINDMAP_BLOCK_SELECTOR = '[data-type="NodeMindmap"], [data-type="NodeList"][custom-sy-list-mindmap="1"]';

/** 节点落在思维导图块内。代码块子类型 mindmap 不是这种块。 */
export function isInsideMindmapBlock(element: Element): boolean {
    return Boolean(element.closest(MINDMAP_BLOCK_SELECTOR));
}

export function collectMindmapPreviewUnits(roots: HTMLElement[]): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const seen = new Set<string>();
    const views = new Set<HTMLElement>();
    for (const root of roots) {
        if (root.classList.contains("mindmap-view")) {
            views.add(root);
        }
        root.querySelectorAll<HTMLElement>(".mindmap-view").forEach((view) => views.add(view));
        const parent = root.closest<HTMLElement>(".mindmap-view");
        if (parent) {
            views.add(parent);
        }
    }
    views.forEach((view) => {
        view.querySelectorAll<HTMLElement>("[data-mindmap-source-id]").forEach((preview) => {
            const blockId = preview.getAttribute("data-mindmap-source-id") || "";
            if (!blockId || seen.has(blockId) || preview.closest("[hidden]")) {
                return;
            }
            if (!elementHasBox(preview)) {
                return;
            }
            const textNodes = collectMindmapOwnTextNodes(preview);
            const text = textNodes.map((node) => node.nodeValue ?? "").join("");
            if (!text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim()) {
                return;
            }
            seen.add(blockId);
            units.push({
                blockId,
                blockType: preview.getAttribute("data-type") || "NodeParagraph",
                blockIndex: 0,
                element: preview,
                text,
                textNodes,
            });
        });
    });
    return units;
}

function collectMindmapOwnTextNodes(preview: HTMLElement): Text[] {
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (
                !parent ||
                parent.closest(".protyle-attr, svg, style, script, .mindmap-view__fold, .mindmap-view__add-child")
            ) {
                return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest("[data-mindmap-source-id]") !== preview) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    return collectWalkerTextNodes(walker);
}

function joinTextNodes(nodes: readonly Text[]): string {
    return nodes.map((node) => node.nodeValue ?? "").join("");
}

/**
 * 没有阻隔时保持原来的单个 unit。切开后用 `#run-N` 区分，避免改掉表格行列号。
 */
function unitsFromTextNodes(
    base: Omit<SearchableBlock, "text" | "textNodes">,
    textNodes: readonly Text[],
): SearchableBlock[] {
    const visible = omitAuthorCssHiddenText(textNodes);
    const runs = splitTextNodesAtBarriers(visible).filter((run) => joinTextNodes(run).length > 0);
    if (runs.length === 0) {
        return [];
    }
    if (runs.length === 1) {
        return [{
            ...base,
            text: joinTextNodes(runs[0]),
            textNodes: runs[0],
        }];
    }
    const units: SearchableBlock[] = [];
    runs.forEach((run, index) => {
        const text = joinTextNodes(run);
        if (!text) {
            return;
        }
        units.push({
            ...base,
            text,
            textNodes: run,
            unitId: base.unitId ? `${base.unitId}#run-${index}` : `run-${index}`,
        });
    });
    return units;
}

/**
 * 收集归属当前块的文本节点。
 * ownerBlock 为 null 时表示预览合成根，收集 root 下全部合法文本。
 */
function collectTextNodes(
    root: HTMLElement,
    ownerBlock: HTMLElement | null,
    includeImageTitle = true,
): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }

            const parentElement = node.parentElement;
            if (!parentElement) {
                return NodeFilter.FILTER_REJECT;
            }

            if (parentElement.closest(TEXT_NODE_EXCLUDED_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
                return NodeFilter.FILTER_REJECT;
            }

            if (ownerBlock && !isOwnedByBlock(parentElement, ownerBlock)) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    return collectWalkerTextNodes(walker);
}

function collectWalkerTextNodes(walker: TreeWalker): Text[] {
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
        textNodes.push(currentNode as Text);
        currentNode = walker.nextNode();
    }
    return textNodes;
}

function getOwnerBlock(element: Element): HTMLElement | null {
    return element.closest<HTMLElement>("[data-node-id][data-type]");
}

function isOwnedByBlock(element: Element, ownerBlock: HTMLElement): boolean {
    // 仅归属最近的 [data-node-id] 祖先，避免表格块与单元格重复计数
    return getOwnerBlock(element) === ownerBlock;
}

/** 单元格编辑器的临时段落不算段落块，格子里的内容只随表格开关。 */
export function isInsideParagraphBlock(element: Element): boolean {
    const paragraph = element.closest(`[data-type="${PARAGRAPH_TYPE}"], .p`);
    return Boolean(paragraph && !paragraph.closest(TABLE_CELL_EDITOR_SELECTOR));
}

/** 行内公式、备注归属的块。单元格编辑器里的临时段落不算，记到外面的表格上。 */
export function searchOwnerBlock(element: Element): HTMLElement | null {
    let owner = getOwnerBlock(element);
    let editor = owner?.closest(TABLE_CELL_EDITOR_SELECTOR);
    while (owner && editor) {
        owner = getOwnerBlock(editor);
        editor = owner?.closest(TABLE_CELL_EDITOR_SELECTOR);
    }
    return owner;
}

interface TableSlotCache {
    rows: Map<HTMLElement, Map<Element, number>>;
    cellText: Map<HTMLElement, Text[]>;
}

function createTableSlotCache(): TableSlotCache {
    return {rows: new Map(), cellText: new Map()};
}

/** 和 collectTableSearchUnits 同一套逻辑行号。占位行不进入这张表。 */
function logicalRowIndexes(table: HTMLElement): Map<Element, number> {
    const indexes = new Map<Element, number>();
    const htmlRows = ownTableRows(table);
    if (htmlRows) {
        const placed = logicalTableRows(htmlRows);
        for (let index = 0; index < placed.rows.length; index += 1) {
            const place = placed.rows[index];
            if (place.omitted === 0) {
                indexes.set(htmlRows[index], place.logical);
            }
        }
        return indexes;
    }
    getTableRowElements(table).forEach((item, index) => {
        if (!item.hasAttribute(TABLE_VIRTUAL_ROWS_ATTR)) {
            indexes.set(item, index);
        }
    });
    return indexes;
}

/** 行列号与 collectTableSearchUnits 的 unitId 一致，offset 按格子正文计。 */
function tableSlotOf(host: HTMLElement, table: HTMLElement, cache: TableSlotCache): TableSlot | undefined {
    const cell = host.closest<HTMLElement>(TABLE_CELL_SELECTOR);
    if (!cell || cell.closest(`[data-type="${TABLE_TYPE}"]`) !== table) {
        return undefined;
    }
    const row = cell.closest<HTMLElement>(".table__row, tr");
    if (!row) {
        return undefined;
    }
    let rowIndexes = cache.rows.get(table);
    if (!rowIndexes) {
        rowIndexes = logicalRowIndexes(table);
        cache.rows.set(table, rowIndexes);
    }
    const rowIndex = rowIndexes.get(row);
    const column = directTableCellColumn(row, cell);
    if (rowIndex === undefined || column < 0) {
        return undefined;
    }
    let nodes = cache.cellText.get(cell);
    if (!nodes) {
        nodes = collectDescendantTextNodes(tableCellTextRoot(cell));
        cache.cellText.set(cell, nodes);
    }
    let offset = 0;
    let index = 0;
    for (; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (host.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) {
            offset += node.nodeValue?.length ?? 0;
            continue;
        }
        break;
    }
    for (; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!host.contains(node)) {
            break;
        }
        const value = node.nodeValue ?? "";
        const skipped = leadingZeroWidthLength(value);
        offset += skipped;
        if (skipped < value.length) {
            break;
        }
    }
    return {row: rowIndex, column, offset};
}

/** 预览合成块，或无归属宿主时的备注/公式伪 id（`__preview__-memo-N` 等） */
export function isPreviewSyntheticBlockId(blockId: string): boolean {
    return blockId === PREVIEW_BLOCK_ID ||
        blockId.startsWith(`${PREVIEW_BLOCK_ID}-`);
}

export function isPreviewSyntheticBlock(block: SearchableBlock): boolean {
    return isPreviewSyntheticBlockId(block.blockId);
}

/**
 * 采集行内备注：备注正文在 data-inline-memo-content，不在 Text 节点。
 * 每个 span 一个独立单元；高亮时对准宿主 span。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/toolbar/InlineMemo.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/block/popover.ts
 */
function collectInlineMemoSearchUnits(docRoot: HTMLElement, includeImageTitle = true): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    // ~= 匹配 data-type 空格分隔 token，避免扫全站 span
    const spans = Array.from(
        docRoot.querySelectorAll<HTMLElement>('span[data-type~="inline-memo"]'),
    );
    const ownerIndexById = new Map<string, number>();
    Array.from(docRoot.querySelectorAll<HTMLElement>("[data-node-id][data-type]")).forEach((el, index) => {
        const id = el.dataset.nodeId?.trim();
        if (id && !ownerIndexById.has(id)) {
            ownerIndexById.set(id, index);
        }
    });
    const textNodesByOwner = new Map<HTMLElement, Text[]>();
    const slotCache = createTableSlotCache();
    const hostSpans = memoHostSpansByOwner(spans, includeImageTitle);
    let memoIndex = 0;

    for (const span of spans) {
        if (span.closest(".protyle-attr, .fn__none")) {
            continue;
        }

        const raw = span.getAttribute("data-inline-memo-content") ?? "";
        const text = plainTextFromInlineMemoContent(raw);
        if (!text) {
            continue;
        }

        const owner = searchOwnerBlock(span);
        const blockId = owner?.dataset.nodeId?.trim() ||
            `${PREVIEW_BLOCK_ID}-memo-${memoIndex}`;
        const blockType = owner?.dataset.type?.trim() || INLINE_MEMO_BLOCK_TYPE;
        const blockIndex = owner?.dataset.nodeId ?
            (ownerIndexById.get(owner.dataset.nodeId.trim()) ?? memoIndex) :
            memoIndex;
        const tableSlot = blockType === TABLE_TYPE && owner ? tableSlotOf(span, owner, slotCache) : undefined;
        const hostSpan = owner ?
            (hostSpans.get(owner)?.get(span) ?? memoHostSpan(owner, span, includeImageTitle, textNodesByOwner)) :
            {start: 0, end: 0};
        // 表格备注用逻辑行列加格内偏移。全文序号在内核整表和画面已挂出行之间对不上。
        const unitId = tableSlot ?
            `table-memo:${tableSlot.row}:${tableSlot.column}:${tableSlot.offset}` :
            `${INLINE_MEMO_UNIT_PREFIX}${memoIndex}`;

        units.push({
            blockId,
            blockType,
            blockIndex,
            element: span,
            text,
            textNodes: [],
            unitId,
            matchSource: "inline-memo",
            anchorOffset: hostSpan.start,
            anchorEnd: hostSpan.end,
            tableSlot,
        });
        memoIndex += 1;
    }

    return units;
}

/**
 * 同一宿主块里的备注一次扫完。
 * 先只走每条备注自己的文字，再沿块的文本节点记偏移，避免每条备注都从块头重扫。
 */
function memoHostSpansByOwner(
    spans: readonly HTMLElement[],
    includeImageTitle: boolean,
): Map<HTMLElement, Map<HTMLElement, {start: number; end: number;}>> {
    const byOwner = new Map<HTMLElement, HTMLElement[]>();
    for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        if (span.closest(".protyle-attr, .fn__none")) {
            continue;
        }
        const owner = searchOwnerBlock(span);
        if (!owner) {
            continue;
        }
        const list = byOwner.get(owner);
        if (list) {
            list.push(span);
            continue;
        }
        byOwner.set(owner, [span]);
    }
    const result = new Map<HTMLElement, Map<HTMLElement, {start: number; end: number;}>>();
    for (const [owner, list] of byOwner) {
        result.set(owner, memoHostSpansInOwner(owner, list, includeImageTitle));
    }
    return result;
}

function memoHostSpansInOwner(
    owner: HTMLElement,
    spans: readonly HTMLElement[],
    includeImageTitle: boolean,
): Map<HTMLElement, {start: number; end: number;}> {
    const nodeHost = new Map<Text, HTMLElement>();
    for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        while (current) {
            const text = current as Text;
            const existing = nodeHost.get(text);
            // 嵌套时保留更内层的备注。
            if (!existing || existing.contains(span)) {
                nodeHost.set(text, span);
            }
            current = walker.nextNode();
        }
    }
    const nodes = collectTextNodes(owner, owner, includeImageTitle);
    const spansOut = new Map<HTMLElement, {start: number; end: number;}>();
    const startOf = new Map<HTMLElement, number>();
    let offset = 0;
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const value = node.nodeValue ?? "";
        const span = nodeHost.get(node);
        if (span) {
            if (!startOf.has(span)) {
                startOf.set(span, offset + leadingZeroWidthLength(value));
            }
            offset += value.length;
            const start = startOf.get(span);
            if (start !== undefined) {
                spansOut.set(span, {start, end: offset});
            }
            continue;
        }
        offset += value.length;
    }
    return spansOut;
}

/**
 * 备注宿主在所属块已采集文本中的区间。
 * 思源给行级代码/标签/备注光标留的零宽字符算在宿主开头，可见字从它后面算起。
 */
function memoHostSpan(
    owner: HTMLElement,
    span: HTMLElement,
    includeImageTitle: boolean,
    cache: Map<HTMLElement, Text[]>,
): {start: number; end: number;} {
    let nodes = cache.get(owner);
    if (!nodes) {
        nodes = collectTextNodes(owner, owner, includeImageTitle);
        cache.set(owner, nodes);
    }
    let offset = 0;
    let start = -1;
    for (const node of nodes) {
        const value = node.nodeValue ?? "";
        if (span.contains(node)) {
            if (start < 0) {
                start = offset + leadingZeroWidthLength(value);
            }
            offset += value.length;
            continue;
        }
        if (start >= 0) {
            return {start, end: offset};
        }
        if (span.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return {start: offset, end: offset};
        }
        offset += value.length;
    }
    if (start >= 0) {
        return {start, end: offset};
    }
    return {start: offset, end: offset};
}

function leadingZeroWidthLength(value: string): number {
    let index = 0;
    while (index < value.length && /[\u200B-\u200D\uFEFF\u2060]/.test(value.charAt(index))) {
        index += 1;
    }
    return index;
}

export function isInlineMemoSearchUnit(block: Pick<SearchableBlock, "matchSource" | "unitId">): boolean {
    return block.matchSource === "inline-memo" ||
        Boolean(block.unitId?.startsWith(INLINE_MEMO_UNIT_PREFIX));
}

/**
 * 采集行内公式：匹配 KaTeX **渲染可见文本**（`.katex-html`），不搜 `data-content` LaTeX 源。
 * 否则搜 “d” 会命中 `\delta` / `\lambda` 等源码字母。
 * 正文/表格 TreeWalker 仍排除整段 inline-math，避免与独立 unit 重复计数；
 * 表内 / 引述 / 提示等内的公式靠本函数扫到，再由 include* 门闩过滤。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mathRender.ts
 *   `output: "html"` → 可见在 `.katex-html`；`.katex-mathml` 含源码 annotation，必须排除
 */
function collectInlineMathSearchUnits(docRoot: HTMLElement): SearchableBlock[] {
    const units: SearchableBlock[] = [];
    const spans = Array.from(
        docRoot.querySelectorAll<HTMLElement>('span[data-type~="inline-math"]'),
    );
    const ownerIndexById = new Map<string, number>();
    Array.from(docRoot.querySelectorAll<HTMLElement>("[data-node-id][data-type]")).forEach((el, index) => {
        const id = el.dataset.nodeId?.trim();
        if (id && !ownerIndexById.has(id)) {
            ownerIndexById.set(id, index);
        }
    });
    const slotCache = createTableSlotCache();
    const ordinals = new Map<HTMLElement, Map<string, number>>();
    let mathIndex = 0;

    for (const span of spans) {
        if (span.closest(".protyle-attr, .fn__none")) {
            continue;
        }

        const textNodes = collectKatexGlyphTextNodes(span);
        const text = textNodes.map((node) => node.nodeValue ?? "").join("");
        // 仅零宽占位则跳过（思源在公式旁插入 ZWSP）
        if (!text.replace(ZERO_WIDTH_RE, "").length) {
            continue;
        }

        const owner = searchOwnerBlock(span);
        const blockId = owner?.dataset.nodeId?.trim() ||
            `${PREVIEW_BLOCK_ID}-math-${mathIndex}`;
        const blockType = owner?.dataset.type?.trim() || INLINE_MATH_BLOCK_TYPE;
        const blockIndex = owner?.dataset.nodeId ?
            (ownerIndexById.get(owner.dataset.nodeId.trim()) ?? mathIndex) :
            mathIndex;
        let mathOrdinal: number | undefined;
        if (owner) {
            let seen = ordinals.get(owner);
            if (!seen) {
                seen = new Map<string, number>();
                ordinals.set(owner, seen);
            }
            const visible = inlineMathIdentityText(text);
            mathOrdinal = seen.get(visible) ?? 0;
            seen.set(visible, mathOrdinal + 1);
        }

        units.push({
            blockId,
            blockType,
            blockIndex,
            element: span,
            text,
            textNodes,
            unitId: `${INLINE_MATH_UNIT_PREFIX}${mathIndex}`,
            matchSource: "inline-math",
            tableSlot: blockType === TABLE_TYPE && owner ? tableSlotOf(span, owner, slotCache) : undefined,
            mathOrdinal,
        });
        mathIndex += 1;
    }

    return units;
}

/**
 * 只取第一个 .katex-html 里的可见字形。
 * 同一行若被拆成内容相同的多个 .base，只留一份，避免行级公式把同一个词计两次。
 * 不走正文排除列表，否则 .katex 会被整段丢掉。
 */
function collectKatexGlyphTextNodes(spanOrHtml: HTMLElement): Text[] {
    const htmlRoot = spanOrHtml.classList.contains("katex-html") ?
        spanOrHtml :
        spanOrHtml.querySelector<HTMLElement>(".katex-html");
    if (!htmlRoot) {
        return [];
    }
    const bases = Array.from(htmlRoot.querySelectorAll<HTMLElement>(":scope > .base"));
    const roots = bases.length ? bases : [htmlRoot];
    const seen = new Set<string>();
    const nodes: Text[] = [];
    for (const root of roots) {
        const part = walkKatexGlyphTextNodes(root);
        const text = part.map((node) => node.nodeValue ?? "").join("").replace(ZERO_WIDTH_RE, "").trim();
        if (!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        nodes.push(...part);
    }
    return nodes;
}

function walkKatexGlyphTextNodes(root: HTMLElement): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!(node instanceof Text) || !node.nodeValue?.length) {
                return NodeFilter.FILTER_REJECT;
            }
            if (!node.nodeValue.replace(ZERO_WIDTH_RE, "").length) {
                return NodeFilter.FILTER_REJECT;
            }
            const parentElement = node.parentElement;
            if (
                !parentElement ||
                parentElement.closest(".katex-mathml, math, annotation, svg, style, script")
            ) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    return collectWalkerTextNodes(walker);
}

export function isInlineMathSearchUnit(block: Pick<SearchableBlock, "matchSource" | "unitId">): boolean {
    return block.matchSource === "inline-math" ||
        Boolean(block.unitId?.startsWith(INLINE_MATH_UNIT_PREFIX));
}

/** 备注或公式等属性型 unit（Range 对准宿主；公式不可替，备注可走属性写回） */
export function isAttributeInlineSearchUnit(
    block: Pick<SearchableBlock, "matchSource" | "unitId">,
): boolean {
    return isInlineMemoSearchUnit(block) || isInlineMathSearchUnit(block);
}

export { ATTRIBUTE_VIEW_TYPE, BLOCKQUOTE_TYPE, CALLOUT_TYPE, EMBED_BLOCK_TYPE, MATH_BLOCK_TYPE, TABLE_TYPE };
