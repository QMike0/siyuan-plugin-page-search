import {
  normalizeRestrictInlineTypes,
  plainTextFromInlineMemoContent,
  shouldCollectBodyTextForRestrict,
  shouldCollectInlineMathUnits,
  shouldCollectInlineMemoUnits,
  type RestrictInlineType,
} from "../shared";
import type {SearchableBlock} from "./dom-types";

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/
const PREVIEW_BLOCK_ID = '__preview__'
const PREVIEW_BLOCK_TYPE = 'preview'
const ATTRIBUTE_VIEW_TYPE = 'NodeAttributeView'
const BLOCKQUOTE_TYPE = 'NodeBlockquote'
const CALLOUT_TYPE = 'NodeCallout'
/** 超级块：容器（内部子块嵌套在 .sb 内） */
const SUPER_BLOCK_TYPE = 'NodeSuperBlock'
const LIST_TYPE = 'NodeList'
const LIST_ITEM_TYPE = 'NodeListItem'
/** 段落块：叶子块（非容器） */
const PARAGRAPH_TYPE = 'NodeParagraph'
/** 标题块：非容器（子块为随后兄弟，不在 NodeHeading DOM 内） */
const HEADING_TYPE = 'NodeHeading'
const MATH_BLOCK_TYPE = 'NodeMathBlock'
/** 嵌入块：内含 .protyle-wysiwyg__embed 渲染的源块副本 */
const EMBED_BLOCK_TYPE = 'NodeBlockQueryEmbed'
const WIDGET_TYPE = 'NodeWidget'
/** HTML 块：可见字在 protyle-html open Shadow，非 light DOM */
const HTML_BLOCK_TYPE = 'NodeHTMLBlock'
const TABLE_TYPE = 'NodeTable'
const CODE_BLOCK_TYPE = 'NodeCodeBlock'
const MERMAID_SUBTYPE = 'mermaid'
/** 正文 TreeWalker 排除：属性区 / 矢量 / 公式源码区；行内公式可见字形由独立 unit 采集 */
const TEXT_NODE_EXCLUDED_CLOSEST =
  '.protyle-attr, svg, style, script, .katex-mathml, span[data-type~="inline-math"]'
/** 图片标题可见字（官方 imgTitle / `.protyle-action__title`） */
const IMAGE_TITLE_TEXT_CLOSEST = '.img .protyle-action__title'
/** Mermaid 搜索单元：源码在 data-content，无可替换 Text 节点 */
export const MERMAID_UNIT_ID = 'mermaid-source'
/**
 * HTML 块搜索单元：text 来自 protyle-html.shadowRoot 渲染可见字（非 data-content 源码）。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/stage/protyle/js/protyle-html.js
 */
export const HTML_BLOCK_UNIT_ID = 'html-block-rendered'
/** 行内备注 unitId 前缀；text 来自 data-inline-memo-content */
const INLINE_MEMO_UNIT_PREFIX = 'inline-memo:'
/** 合成块类型，便于 replaceable / 高亮分流 */
const INLINE_MEMO_BLOCK_TYPE = 'inline-memo'
/** 行内公式 unitId 前缀；text 来自 KaTeX 渲染可见文字 */
const INLINE_MATH_UNIT_PREFIX = 'inline-math:'
/** 合成块类型，便于 replaceable / 高亮分流 */
const INLINE_MATH_BLOCK_TYPE = 'inline-math'
export const DOC_TITLE_BLOCK_ID = '__doc-title__'
export const DOC_TITLE_BLOCK_TYPE = 'doc-title'
export const DOC_TITLE_UNIT_ID = 'doc-title'
const TABLE_CELL_SELECTOR = '[data-type="NodeTableCell"], .table__cell, td, th'

/** 数据库内不应参与搜索的 UI 节点（含 av__cursor 的 ZWSP，会干扰零宽变体匹配） */
const AV_EXCLUDED_CLOSEST = [
  '.protyle-attr',
  // 关闭「显示条目图标」时主键前的 .b3-menu__avemoji 带 fn__none，但仍含 emoji 文本节点；
  // 若采入会导致「test」命中落在图标/主键文本边界，Range 起点落在 fn__none 内被可见性丢弃。
  '.fn__none',
  '.b3-menu__avemoji',
  'svg',
  'style',
  'script',
  '.av__gallery-tip',
  '.av__widthdrag',
  '.av__pulse',
  '.av__cursor',
  '.av__calc',
  '.b3-chip[data-type="block-more"]',
].join(', ')

/**
 * 解析当前编辑器内的可搜索文档根（编辑态 wysiwyg / 预览态 b3-typography）
 */
function resolveDocRoot(edit: Element): HTMLElement | null {
  let docRoot = edit.querySelector(
    ':scope > .protyle:not(.fn__none) :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)',
  ) as HTMLElement | null

  if (!docRoot) {
    docRoot = edit.querySelector(
      '.protyle:not(.fn__none) :is(.protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography)',
    ) as HTMLElement | null
  }

  return docRoot
}

/**
 * 解析文档标题输入区。
 * 思源标题在 .protyle-wysiwyg 之外：.protyle-title > .protyle-title__input
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/header/Title.ts
 */
export function resolveDocTitleInput(edit: Element): HTMLElement | null {
  let titleInput = edit.querySelector(
    ':scope > .protyle:not(.fn__none) .protyle-title .protyle-title__input',
  ) as HTMLElement | null

  if (!titleInput) {
    titleInput = edit.querySelector(
      '.protyle:not(.fn__none) .protyle-title .protyle-title__input',
    ) as HTMLElement | null
  }

  // 浮窗 / 部分布局下可能只有 .protyle-title
  if (!titleInput) {
    const title = edit.querySelector(
      '.protyle:not(.fn__none) .protyle-title',
    ) as HTMLElement | null
    if (title) {
      titleInput = title.querySelector<HTMLElement>('.protyle-title__input') || title
    }
  }

  return titleInput
}

function collectDocTitleUnit(edit: Element): SearchableBlock | null {
  const titleInput = resolveDocTitleInput(edit)
  if (!titleInput) {
    return null
  }

  const textNodes = collectDescendantTextNodes(titleInput)
  const text = textNodes.map((node) => node.nodeValue ?? '').join('')
  if (!text.trim()) {
    return null
  }

  return {
    blockId: DOC_TITLE_BLOCK_ID,
    blockType: DOC_TITLE_BLOCK_TYPE,
    blockIndex: -1,
    element: titleInput,
    text,
    textNodes,
    unitId: DOC_TITLE_UNIT_ID,
  }
}

/** 是否为文档标题合成搜索单元 */
export function isDocTitleSearchUnit(
  block: Pick<SearchableBlock, 'blockId' | 'blockType' | 'unitId'>,
): boolean {
  return block.blockId === DOC_TITLE_BLOCK_ID
    || block.blockType === DOC_TITLE_BLOCK_TYPE
    || block.unitId === DOC_TITLE_UNIT_ID
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
  /** 是否采集代码块（非 Mermaid）；默认 true */
  includeCodeBlock?: boolean;
  /** 是否采集 Mermaid 图；默认 true */
  includeMermaid?: boolean;
  /**
   * 是否采集 HTML 块（NodeHTMLBlock）Shadow 内渲染可见文字；默认 true。
   * 不搜 data-content 源码；不可替换。
   */
  includeHtmlBlock?: boolean;
  /** 是否采集行内备注（data-inline-memo-content）；默认 false */
  includeInlineMemo?: boolean;
  /**
   * 限制查找行内类型；空 / 省略 = 不限制。
   * 与 includeInlineMemo 共同决定是否采备注；仅限制备注/公式等属性类型时跳过正文。
   */
  restrictInlineTypes?: RestrictInlineType[];
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
  const includeHtmlBlock = options.includeHtmlBlock !== false;
  const includeInlineMemo = options.includeInlineMemo === true;
  // 限制未传 / 空数组：保持旧行为；非空才 normalize（含备注门闩）
  const rawRestrict = options.restrictInlineTypes;
  const restrictInlineTypes = Array.isArray(rawRestrict) && rawRestrict.length > 0
    ? normalizeRestrictInlineTypes(rawRestrict, {includeInlineMemo})
    : [];
  const collectBodyText = shouldCollectBodyTextForRestrict(restrictInlineTypes);
  const collectMemo = shouldCollectInlineMemoUnits({
    includeInlineMemo,
    restrictTypes: restrictInlineTypes,
  });
  const collectMath = shouldCollectInlineMathUnits(restrictInlineTypes);
  const docRoot = resolveDocRoot(edit)
  if (!docRoot) {
    return []
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
    includeEmbedBlock,
    includeCodeBlock,
    includeMermaid,
    includeHtmlBlock,
  }

  const blocks: SearchableBlock[] = []
  if (collectBodyText && includeDocTitle) {
    const titleUnit = collectDocTitleUnit(edit)
    if (titleUnit) {
      blocks.push(titleUnit)
    }
  }

  // 关嵌入时在去重阶段即排除嵌入 DOM，避免同 id 只保留嵌入副本而漏掉正文
  const blockElements = collectBodyText
    ? getUniqueBlockElements(docRoot, {excludeEmbed: !includeEmbedBlock})
    : []
  if (collectBodyText && blockElements.length === 0) {
    const textNodes = collectTextNodes(docRoot, null, includeImageTitle)
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    if (text) {
      blocks.push({
        blockId: PREVIEW_BLOCK_ID,
        blockType: PREVIEW_BLOCK_TYPE,
        blockIndex: 0,
        element: docRoot,
        text,
        textNodes,
      })
    }
    if (collectMemo) {
      blocks.push(...filterAttributeUnitsByIncludeGates(
        collectInlineMemoSearchUnits(docRoot),
        includeGates,
      ))
    }
    if (collectMath) {
      blocks.push(...filterAttributeUnitsByIncludeGates(
        collectInlineMathSearchUnits(docRoot),
        includeGates,
      ))
    }
    return blocks
  }

  blockElements.forEach((element, blockIndex) => {
    const blockId = element.dataset.nodeId?.trim()
    const blockType = element.dataset.type?.trim() || 'unknown'
    if (!blockId) {
      return
    }

    // 表格内部单元格/嵌套块由 NodeTable 按格拆分，避免重复采集
    if (blockType !== TABLE_TYPE) {
      const tableAncestor = element.closest<HTMLElement>(`[data-type="${TABLE_TYPE}"]`)
      if (tableAncestor && tableAncestor !== element) {
        return
      }
    }

    // 引述 / 提示 / 嵌入为容器块：关开关时跳过容器本身及其内部全部子块
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/blockRender.ts
    if (
      !includeBlockquote
      && (blockType === BLOCKQUOTE_TYPE
        || element.classList.contains('bq')
        || Boolean(element.closest(`[data-type="${BLOCKQUOTE_TYPE}"], .bq`)))
    ) {
      return
    }
    if (
      !includeCallout
      && (blockType === CALLOUT_TYPE
        || element.classList.contains('callout')
        || Boolean(element.closest(`[data-type="${CALLOUT_TYPE}"], .callout`)))
    ) {
      return
    }
    // 超级块：容器门闩，关则跳过自身及内部全部子块（与引述/提示同类）
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
    if (
      !includeSuperBlock
      && (blockType === SUPER_BLOCK_TYPE
        || element.classList.contains('sb')
        || Boolean(element.closest(`[data-type="${SUPER_BLOCK_TYPE}"], .sb`)))
    ) {
      return
    }
    // 列表：按最近 NodeList / NodeListItem 的 data-subtype（u/o/t）门闩；嵌套取最近祖先
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/search/menu.ts subTypes
    if (shouldSkipElementByListInclude(element, {
      includeListUnordered,
      includeListOrdered,
      includeListTask,
    })) {
      return
    }
    if (
      !includeEmbedBlock
      && (blockType === EMBED_BLOCK_TYPE
        || Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`)))
    ) {
      return
    }
    // 标题块级别门闩（在容器门闩之后 = AND）：仅 NodeHeading 自身 / 其 DOM 内文本；
    // 不抑制折叠展开后的兄弟段落。落在已关的引述/提示/列表/嵌入内时上面已 return。
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isContainerBlock
    if (shouldSkipElementByHeadingInclude(element, {
      includeHeadingH1,
      includeHeadingH2,
      includeHeadingH3,
      includeHeadingH4,
      includeHeadingH5,
      includeHeadingH6,
    })) {
      return
    }
    // 段落：叶子门闩。关段落时正文不采；若仍开图片标题则只采段内 `.protyle-action__title`
    if (
      (blockType === PARAGRAPH_TYPE || element.classList.contains('p'))
      && !includeParagraph
    ) {
      if (includeImageTitle) {
        blocks.push(...collectImageTitleSearchUnits(element, blockId, blockIndex))
      }
      return
    }

    if (blockType === ATTRIBUTE_VIEW_TYPE) {
      if (!includeAttributeView) {
        return
      }
      // 数据库按单元格拆成独立搜索单元，禁止跨「框」拼接匹配
      blocks.push(...collectAttributeViewSearchUnits(
        element,
        blockId,
        blockIndex,
        includeImageTitle,
        includeGates,
      ))
      return
    }

    if (blockType === TABLE_TYPE || element.classList.contains('table')) {
      if (!includeTable) {
        return
      }
      // 表格按单元格拆分，禁止「传感器」+「2026」拼成「传感器20」
      // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/table.ts
      blocks.push(...collectTableSearchUnits(
        element,
        blockId,
        blockIndex,
        includeImageTitle,
        includeGates,
      ))
      return
    }

    // Mermaid：高亮须对准渲染态 SVG/foreignObject 内文字（与 HSR 一致），
    // 不可只搜 data-content 再整块 selectNodeContents（会整图高亮）。
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mermaidRender.ts
    // @see siyuan-plugin-hsr-mdzz2048-fork Search.vue TreeWalker(SHOW_TEXT) 不过滤 svg
    if (
      blockType === CODE_BLOCK_TYPE
      && element.getAttribute('data-subtype') === MERMAID_SUBTYPE
    ) {
      if (!includeMermaid) {
        return
      }
      const mermaidUnit = collectMermaidSearchUnit(element, blockId, blockIndex)
      if (mermaidUnit) {
        blocks.push(mermaidUnit)
      }
      return
    }

    // 普通代码块（非 Mermaid）由 includeCodeBlock 控制
    if (blockType === CODE_BLOCK_TYPE && !includeCodeBlock) {
      return
    }

    // 公式块（叶子块）；勿用 data-subtype="math"（行内公式也带该属性）
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mathRender.ts
    if (blockType === MATH_BLOCK_TYPE && !includeMathBlock) {
      return
    }

    // 挂件块：内容在 iframe 内，当前不支持搜索（始终跳过）
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts isNotEditBlock
    if (blockType === WIDGET_TYPE) {
      return
    }

    // HTML 块：渲染结果在 protyle-html open Shadow，light DOM TreeWalker 采不到。
    // 专项穿透 shadowRoot；标记 HTML_BLOCK_UNIT_ID，禁止替换。
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/stage/protyle/js/protyle-html.js
    // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/htmlRender.ts
    if (blockType === HTML_BLOCK_TYPE) {
      if (!includeHtmlBlock) {
        return
      }
      const htmlUnit = collectHtmlBlockSearchUnit(element, blockId, blockIndex)
      if (htmlUnit) {
        blocks.push(htmlUnit)
      }
      return
    }

    if (blockType === CALLOUT_TYPE || element.classList.contains('callout')) {
      // Callout 标题在 .callout-title（非 contenteditable 子块），需单独采集
      // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts getCalloutInfo
      blocks.push(...collectCalloutSearchUnits(element, blockId, blockIndex, includeImageTitle))
      return
    }

    const textNodes = collectTextNodes(element, element, includeImageTitle)
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    if (!text) {
      return
    }

    blocks.push({
      blockId,
      blockType,
      blockIndex,
      element,
      text,
      textNodes,
    })
  })

  if (collectMemo) {
    blocks.push(...filterAttributeUnitsByIncludeGates(
      collectInlineMemoSearchUnits(docRoot),
      includeGates,
    ))
  }
  if (collectMath) {
    blocks.push(...filterAttributeUnitsByIncludeGates(
      collectInlineMathSearchUnits(docRoot),
      includeGates,
    ))
  }

  return blocks
}

/** 「是否查找」块级门闩：备注 / 行内公式独立采集时也须遵守 */
interface IncludeGates {
  includeAttributeView: boolean
  includeTable: boolean
  includeBlockquote: boolean
  includeCallout: boolean
  includeSuperBlock: boolean
  includeListUnordered: boolean
  includeListOrdered: boolean
  includeListTask: boolean
  includeParagraph: boolean
  includeHeadingH1: boolean
  includeHeadingH2: boolean
  includeHeadingH3: boolean
  includeHeadingH4: boolean
  includeHeadingH5: boolean
  includeHeadingH6: boolean
  includeEmbedBlock: boolean
  includeCodeBlock: boolean
  includeMermaid: boolean
  includeHtmlBlock: boolean
}

type HeadingIncludeGates = Pick<
  IncludeGates,
  | 'includeHeadingH1'
  | 'includeHeadingH2'
  | 'includeHeadingH3'
  | 'includeHeadingH4'
  | 'includeHeadingH5'
  | 'includeHeadingH6'
>

/** 标题级别：与官方 subTypes h1–h6 / data-subtype 一致 */
export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/**
 * 若元素落在 NodeHeading DOM 内（含标题块自身），返回其 data-subtype。
 * 标题不是容器：随后兄弟段落 closest 不到标题，不会被误伤。
 * 文档标题（.protyle-title）不是 NodeHeading，返回 null。
 */
export function resolveHeadingLevel(element: Element): HeadingLevel | null {
  const heading = element.closest<HTMLElement>(
    `[data-type="${HEADING_TYPE}"][data-subtype], div.h1[data-subtype], div.h2[data-subtype], div.h3[data-subtype], div.h4[data-subtype], div.h5[data-subtype], div.h6[data-subtype]`,
  )
  if (!heading) {
    return null
  }
  const sub = heading.getAttribute('data-subtype')
  if (
    sub === 'h1' || sub === 'h2' || sub === 'h3'
    || sub === 'h4' || sub === 'h5' || sub === 'h6'
  ) {
    return sub
  }
  return null
}

export function isHeadingLevelIncluded(
  level: HeadingLevel,
  gates: HeadingIncludeGates,
): boolean {
  switch (level) {
    case 'h1':
      return gates.includeHeadingH1
    case 'h2':
      return gates.includeHeadingH2
    case 'h3':
      return gates.includeHeadingH3
    case 'h4':
      return gates.includeHeadingH4
    case 'h5':
      return gates.includeHeadingH5
    case 'h6':
      return gates.includeHeadingH6
    default: {
      const _exhaustive: never = level
      return _exhaustive
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
  const level = resolveHeadingLevel(element)
  if (!level) {
    return false
  }
  return !isHeadingLevelIncluded(level, gates)
}

/** 列表 subtype：u=无序 / o=有序 / t=任务 */
export type ListSubtype = 'u' | 'o' | 't'

/**
 * 最近列表祖先的 subtype（优先 ListItem，再 List；嵌套列表取最近一层）。
 * 不在列表内则返回 null。
 */
export function resolveNearestListSubtype(element: Element): ListSubtype | null {
  const listish = element.closest<HTMLElement>(
    `[data-type="${LIST_ITEM_TYPE}"][data-subtype], [data-type="${LIST_TYPE}"][data-subtype], .li[data-subtype], .list[data-subtype]`,
  )
  if (!listish) {
    return null
  }
  const sub = listish.getAttribute('data-subtype')
  if (sub === 'u' || sub === 'o' || sub === 't') {
    return sub
  }
  return null
}

export function isListSubtypeIncluded(
  subtype: ListSubtype,
  gates: Pick<IncludeGates, 'includeListUnordered' | 'includeListOrdered' | 'includeListTask'>,
): boolean {
  if (subtype === 'u') {
    return gates.includeListUnordered
  }
  if (subtype === 'o') {
    return gates.includeListOrdered
  }
  return gates.includeListTask
}

/** 落在已关闭 subtype 的列表区内则跳过 */
export function shouldSkipElementByListInclude(
  element: Element,
  gates: Pick<IncludeGates, 'includeListUnordered' | 'includeListOrdered' | 'includeListTask'>,
): boolean {
  const subtype = resolveNearestListSubtype(element)
  if (!subtype) {
    return false
  }
  return !isListSubtypeIncluded(subtype, gates)
}

/**
 * 行内备注 / 行内公式扫整棵文档树，不会走块级 forEach 的 include* 早退。
 * 关表格 / 引述 / 提示 / 嵌入 / 数据库等时，须在此过滤其内部的属性 unit。
 */
function shouldSkipAttributeUnitByIncludeGates(element: Element, gates: IncludeGates): boolean {
  if (
    !gates.includeAttributeView
    && Boolean(element.closest(`[data-type="${ATTRIBUTE_VIEW_TYPE}"], .av`))
  ) {
    return true
  }
  if (
    !gates.includeTable
    && Boolean(element.closest(`[data-type="${TABLE_TYPE}"], .table`))
  ) {
    return true
  }
  if (
    !gates.includeBlockquote
    && Boolean(element.closest(`[data-type="${BLOCKQUOTE_TYPE}"], .bq`))
  ) {
    return true
  }
  if (
    !gates.includeCallout
    && Boolean(element.closest(`[data-type="${CALLOUT_TYPE}"], .callout`))
  ) {
    return true
  }
  if (
    !gates.includeSuperBlock
    && Boolean(element.closest(`[data-type="${SUPER_BLOCK_TYPE}"], .sb`))
  ) {
    return true
  }
  if (shouldSkipElementByListInclude(element, gates)) {
    return true
  }
  // 段落叶子门闩：备注/公式宿主落在段落 DOM 内时随 includeParagraph；
  // 图片标题在关段落时走专项 unit，不依赖本过滤。
  if (
    !gates.includeParagraph
    && Boolean(element.closest(`[data-type="${PARAGRAPH_TYPE}"], .p`))
    && !element.closest(IMAGE_TITLE_TEXT_CLOSEST)
  ) {
    return true
  }
  // 标题级别：备注/公式宿主若在某级标题 DOM 内，随该级开关；与容器门闩 AND
  if (shouldSkipElementByHeadingInclude(element, gates)) {
    return true
  }
  if (
    !gates.includeEmbedBlock
    && Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`))
  ) {
    return true
  }
  // 挂件始终不搜（含其外壳上的行内备注 / 公式宿主）
  if (Boolean(element.closest(`[data-type="${WIDGET_TYPE}"]`))) {
    return true
  }
  if (
    !gates.includeHtmlBlock
    && Boolean(element.closest(`[data-type="${HTML_BLOCK_TYPE}"]`))
  ) {
    return true
  }
  const codeBlock = element.closest<HTMLElement>(`[data-type="${CODE_BLOCK_TYPE}"]`)
  if (codeBlock) {
    const isMermaid = codeBlock.getAttribute('data-subtype') === MERMAID_SUBTYPE
    if (isMermaid && !gates.includeMermaid) {
      return true
    }
    if (!isMermaid && !gates.includeCodeBlock) {
      return true
    }
  }
  return false
}

function filterAttributeUnitsByIncludeGates(
  units: SearchableBlock[],
  gates: IncludeGates,
): SearchableBlock[] {
  return units.filter((unit) => !shouldSkipAttributeUnitByIncludeGates(unit.element, gates))
}

function isInsideEmbedBlock(element: Element): boolean {
  return Boolean(element.closest(`[data-type="${EMBED_BLOCK_TYPE}"]`))
}

function getUniqueBlockElements(
  root: ParentNode,
  options: {excludeEmbed?: boolean} = {},
): HTMLElement[] {
  const byId = new Map<string, HTMLElement>()
  const excludeEmbed = options.excludeEmbed === true

  Array.from(root.querySelectorAll<HTMLElement>('[data-node-id][data-type]')).forEach((element) => {
    const blockId = element.dataset.nodeId?.trim()
    if (!blockId) {
      return
    }
    if (excludeEmbed && isInsideEmbedBlock(element)) {
      return
    }

    const existing = byId.get(blockId)
    if (!existing || shouldPreferBlockElement(element, existing)) {
      byId.set(blockId, element)
    }
  })

  return Array.from(byId.values())
}

/** 同一 blockId 多份 DOM 时，优先已渲染/内容更完整的实例 */
function shouldPreferBlockElement(candidate: HTMLElement, existing: HTMLElement): boolean {
  const candidateRendered = candidate.getAttribute('data-render') === 'true'
  const existingRendered = existing.getAttribute('data-render') === 'true'
  if (candidateRendered !== existingRendered) {
    return candidateRendered
  }

  const candidateCells = candidate.querySelectorAll('.av__cell, .b3-chip, .av__celltext').length
  const existingCells = existing.querySelectorAll('.av__cell, .b3-chip, .av__celltext').length
  if (candidateCells !== existingCells) {
    return candidateCells > existingCells
  }

  return (candidate.textContent?.length ?? 0) > (existing.textContent?.length ?? 0)
}

/**
 * HTML 块：可见文字在 protyle-html 的 open Shadow 内。
 * 只读采集 Text，排除 script/style；不读 data-content（那是源码而非渲染结果）。
 * 标记 HTML_BLOCK_UNIT_ID，禁止替换。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/stage/protyle/js/protyle-html.js
 */
function collectHtmlBlockSearchUnit(
  htmlBlock: HTMLElement,
  blockId: string,
  blockIndex: number,
): SearchableBlock | null {
  const host = htmlBlock.querySelector('protyle-html') as HTMLElement & {
    shadowRoot?: ShadowRoot | null
  } | null
  const shadowRoot = host?.shadowRoot
  if (!shadowRoot) {
    return null
  }
  const textNodes = collectHtmlBlockRenderedTextNodes(shadowRoot)
  const text = textNodes.map((node) => node.nodeValue ?? '').join('')
  if (!text.replace(ZERO_WIDTH_RE, '').trim()) {
    return null
  }
  return {
    blockId,
    blockType: HTML_BLOCK_TYPE,
    blockIndex,
    element: htmlBlock,
    text,
    textNodes,
    unitId: HTML_BLOCK_UNIT_ID,
  }
}

/**
 * 在 protyle-html.shadowRoot 内采 Text；不进入嵌套 closed Shadow；排除 script/style。
 * 只读，不修改 Shadow DOM（避免触发脚本型 HTML 块副作用）。
 */
function collectHtmlBlockRenderedTextNodes(shadowRoot: ShadowRoot): Text[] {
  const walker = document.createTreeWalker(shadowRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }
      const parentElement = node.parentElement
      if (
        !parentElement
        || parentElement.closest('style, script, textarea, noscript')
      ) {
        return NodeFilter.FILTER_REJECT
      }
      if (!node.nodeValue.replace(ZERO_WIDTH_RE, '').length) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  return collectWalkerTextNodes(walker)
}

/**
 * Mermaid 块：思源将 data-content 渲染为 SVG（htmlLabels 时含 foreignObject）。
 * 搜索/高亮应对齐渲染后的 Text（与 HSR 全量 TreeWalker 行为一致）；
 * 普通 collectTextNodes 会因 closest(svg) 丢弃这些节点。
 * 仍标记 MERMAID_UNIT_ID，禁止替换。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mermaidRender.ts
 */
function collectMermaidSearchUnit(
  codeBlock: HTMLElement,
  blockId: string,
  blockIndex: number,
): SearchableBlock | null {
  const textNodes = collectMermaidRenderedTextNodes(codeBlock)
  const text = textNodes.map((node) => node.nodeValue ?? '').join('')
  if (!text.replace(ZERO_WIDTH_RE, '').trim()) {
    return null
  }
  return {
    blockId,
    blockType: CODE_BLOCK_TYPE,
    blockIndex,
    element: codeBlock,
    text,
    textNodes,
    unitId: MERMAID_UNIT_ID,
  }
}

/**
 * 采集 Mermaid 渲染区内的文本节点（含 svg / foreignObject），排除图标与样式。
 */
function collectMermaidRenderedTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }
      const parentElement = node.parentElement
      if (
        !parentElement
        || parentElement.closest('.protyle-attr, .protyle-icons, style, script')
      ) {
        return NodeFilter.FILTER_REJECT
      }
      // 纯零宽占位（思源 mermaidRender 插入的 ZWSP）不参与匹配
      if (!node.nodeValue.replace(ZERO_WIDTH_RE, '').length) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  return collectWalkerTextNodes(walker)
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
  const units: SearchableBlock[] = []
  const titles = Array.from(
    ownerBlock.querySelectorAll<HTMLElement>(IMAGE_TITLE_TEXT_CLOSEST),
  ).filter((title) => {
    return getOwnerBlock(title) === ownerBlock
  })
  titles.forEach((titleElement, index) => {
    const textNodes = collectDescendantTextNodes(titleElement, true)
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    if (!text) {
      return
    }
    units.push({
      blockId,
      blockType: PARAGRAPH_TYPE,
      blockIndex,
      element: titleElement,
      text,
      textNodes,
      unitId: `image-title:${index}`,
    })
  })
  return units
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
  const units: SearchableBlock[] = []

  const titleElement = calloutBlock.querySelector<HTMLElement>('.callout-title')
  if (titleElement) {
    const titleNodes = collectDescendantTextNodes(titleElement, includeImageTitle)
    const titleText = titleNodes.map((node) => node.nodeValue ?? '').join('')
    if (titleText) {
      units.push({
        blockId,
        blockType: CALLOUT_TYPE,
        blockIndex,
        element: titleElement,
        text: titleText,
        textNodes: titleNodes,
        unitId: 'callout-title',
      })
    }
  }

  // Callout 容器上可能还有标题区以外、且不属于子块的少量文本（一般为空）
  const ownedNodes = collectTextNodes(calloutBlock, calloutBlock, includeImageTitle).filter((node) => {
    return !titleElement || !titleElement.contains(node)
  })
  const ownedText = ownedNodes.map((node) => node.nodeValue ?? '').join('')
  if (ownedText.trim()) {
    units.push({
      blockId,
      blockType: CALLOUT_TYPE,
      blockIndex,
      element: calloutBlock,
      text: ownedText,
      textNodes: ownedNodes,
      unitId: 'callout-owned',
    })
  }

  return units
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
        return NodeFilter.FILTER_REJECT
      }
      const parentElement = node.parentElement
      if (!parentElement || parentElement.closest(TEXT_NODE_EXCLUDED_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }
      if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }
      // 表格/AV 格内若嵌有标题块，正文走整格采集；须按标题级别门闩剔除其文本
      if (headingGates && shouldSkipElementByHeadingInclude(parentElement, headingGates)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  return collectWalkerTextNodes(walker)
}

/**
 * 将表格拆成按单元格的搜索单元。
 * NodeTable 下相邻 td/th 文本首尾相接，整块拼接会把「传感器」+「2026」误匹配成「传感器20」。
 *
 * 注意：不能用 `row.parentElement.children` 算行号。
 * HTML 表格常见结构是 thead/tbody 分开，表头与首行数据都会得到 rowIndex=0，
 * unitId 冲突后数据格会被跳过（表现为「列名 AAA 时首行 AAA 搜不到」）。
 */
function collectTableSearchUnits(
  tableBlock: HTMLElement,
  blockId: string,
  blockIndex: number,
  includeImageTitle = true,
  headingGates?: HeadingIncludeGates,
): SearchableBlock[] {
  const units: SearchableBlock[] = []
  const seenUnitKeys = new Set<string>()
  const rows = getTableRowElements(tableBlock)
  const cells = getTableCellElements(tableBlock, rows)

  cells.forEach((cell, index) => {
    const row = cell.closest<HTMLElement>('.table__row, tr')
    const rowIndex = row ? rows.indexOf(row) : -1
    const columnIndex = row
      ? Array.from(row.children).filter((child) => child instanceof HTMLElement && child.matches(TABLE_CELL_SELECTOR)).indexOf(cell)
      : index
    // 以全表行号+列号为主键，避免 thead/tbody 局部行号冲突；node-id 仅作辅助
    const cellId = cell.dataset.nodeId?.trim() || ''
    const unitId = cellId
      ? `table-cell:${rowIndex}:${columnIndex}:${cellId}`
      : `table-cell:${rowIndex}:${columnIndex}`
    if (seenUnitKeys.has(unitId)) {
      return
    }

    const textNodes = collectDescendantTextNodes(cell, includeImageTitle, headingGates)
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    if (!text) {
      return
    }

    seenUnitKeys.add(unitId)
    units.push({
      blockId,
      blockType: TABLE_TYPE,
      blockIndex,
      element: cell,
      text,
      textNodes,
      unitId,
    })
  })

  return units
}

/** 当前表格内的行（文档序），排除嵌套表格中的行 */
function getTableRowElements(tableBlock: HTMLElement): HTMLElement[] {
  return Array.from(tableBlock.querySelectorAll<HTMLElement>('.table__row, tr')).filter((row) => {
    const owner = row.closest<HTMLElement>(`[data-type="${TABLE_TYPE}"]`)
    return owner === tableBlock || (!owner && tableBlock.contains(row))
  })
}

function getTableCellElements(
  tableBlock: HTMLElement,
  rows: HTMLElement[] = getTableRowElements(tableBlock),
): HTMLElement[] {
  if (rows.length) {
    const cells: HTMLElement[] = []
    rows.forEach((row) => {
      Array.from(row.children).forEach((child) => {
        if (child instanceof HTMLElement && child.matches(TABLE_CELL_SELECTOR)) {
          cells.push(child)
        }
      })
    })
    if (cells.length) {
      return cells
    }
  }

  // 回退：直接取单元格，再去掉被其他单元格包含的嵌套节点
  const allCells = Array.from(tableBlock.querySelectorAll<HTMLElement>(TABLE_CELL_SELECTOR))
  return allCells.filter((cell, index) => (
    !allCells.some((other, otherIndex) => otherIndex !== index && other.contains(cell))
  ))
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
  const units: SearchableBlock[] = []
  const seenUnitKeys = new Set<string>()

  const pushUnit = (container: HTMLElement, unitId: string) => {
    if (seenUnitKeys.has(unitId)) {
      return
    }
    const textNodes = collectTextNodesInContainer(
      container,
      avBlock,
      includeImageTitle,
      headingGates,
    )
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    if (!text) {
      return
    }
    seenUnitKeys.add(unitId)
    units.push({
      blockId,
      blockType: ATTRIBUTE_VIEW_TYPE,
      blockIndex,
      element: container,
      text,
      textNodes,
      unitId,
    })
  }

  const pushCellsInRoot = (root: ParentNode) => {
    const cells = Array.from(root.querySelectorAll<HTMLElement>('.av__cell')).filter((cell) => {
      if (cell.closest('.av__row--util, .av__row--footer, .av__pulse')) {
        return false
      }
      return true
    })

    cells.forEach((cell, index) => {
      // 分组视图下每个子表有独立表头；必须带上 groupId，否则「日期」等列名会被去重成只剩第一组
      const groupId = cell.closest<HTMLElement>('.av__body[data-group-id], [data-group-id]')
        ?.dataset.groupId
        ?.trim()
        || 'nogroup'
      const rowElement = cell.closest<HTMLElement>('.av__row, .av__gallery-item')
      const isHeader = Boolean(
        cell.classList.contains('av__cell--header')
        || rowElement?.classList.contains('av__row--header'),
      )
      const rowId = rowElement?.dataset.id?.trim()
        || (isHeader ? `header:${groupId}` : 'norow')
      const colId = cell.dataset.colId?.trim()
        || cell.dataset.fieldId?.trim()
        || cell.dataset.keyId?.trim()
        || cell.dataset.avKeyId?.trim()
        || `idx-${index}`
      pushUnit(cell, `cell:${groupId}:${rowId}:${colId}`)
    })
  }

  // 标题
  const title = avBlock.querySelector<HTMLElement>('.av__title')
  if (title) {
    pushUnit(title, 'title')
  }

  // 视图名称（多视图 tab）
  // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/av/render.ts
  // <span class="item__text">${escapeHtml(item.name)}</span>
  avBlock.querySelectorAll<HTMLElement>('.av__views .layout-tab-bar > .item').forEach((viewTab, index) => {
    const viewId = viewTab.dataset.id?.trim() || `idx-${index}`
    const nameElement = viewTab.querySelector<HTMLElement>('.item__text') || viewTab
    pushUnit(nameElement, `view-name:${viewId}`)
  })

  const groupTitles = Array.from(avBlock.querySelectorAll<HTMLElement>('.av__group-title'))
  if (groupTitles.length === 0) {
    // 未分组：整表按 DOM 顺序收集单元格
    pushCellsInRoot(avBlock)
    return units
  }

  // 分组：每个组标题后紧跟对应子表，交错收集以保证跳转顺序
  const processedBodies = new Set<Element>()
  for (let index = 0; index < groupTitles.length; index++) {
    const groupTitle = groupTitles[index]
    const groupId = resolveAvGroupId(groupTitle, index)
    pushUnit(groupTitle, `group-title:${groupId}`)

    const groupBody = resolveAvGroupBody(avBlock, groupTitle, groupId)
    if (groupBody && !processedBodies.has(groupBody)) {
      pushCellsInRoot(groupBody)
      processedBodies.add(groupBody)
    }
  }

  // 兜底：尚未处理的分组 body（如未关联标题的未分组区），避免重复扫描已处理子表
  avBlock.querySelectorAll<HTMLElement>('.av__body').forEach((body) => {
    if (!processedBodies.has(body)) {
      pushCellsInRoot(body)
      processedBodies.add(body)
    }
  })

  return units
}

/** 从分组标题解析 group id（fold 按钮 data-id） */
function resolveAvGroupId(groupTitle: HTMLElement, index: number): string {
  const foldId = groupTitle.querySelector<HTMLElement>('[data-type="av-group-fold"]')
    ?.dataset.id
    ?.trim()
  return foldId || `idx-${index}`
}

/** 分组标题对应的 av__body（优先 data-group-id，其次紧随的兄弟节点） */
function resolveAvGroupBody(
  avBlock: HTMLElement,
  groupTitle: HTMLElement,
  groupId: string,
): HTMLElement | null {
  if (groupId && !groupId.startsWith('idx-')) {
    const byId = avBlock.querySelector<HTMLElement>(`.av__body[data-group-id="${cssEscapeAttr(groupId)}"]`)
    if (byId) {
      return byId
    }
  }

  let sibling = groupTitle.nextElementSibling as HTMLElement | null
  while (sibling) {
    if (sibling.classList.contains('av__body')) {
      return sibling
    }
    if (sibling.classList.contains('av__group-title')) {
      break
    }
    sibling = sibling.nextElementSibling as HTMLElement | null
  }
  return null
}

function cssEscapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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
        return NodeFilter.FILTER_REJECT
      }

      const parentElement = node.parentElement
      if (!parentElement || parentElement.closest(AV_EXCLUDED_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }
      if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }
      if (headingGates && shouldSkipElementByHeadingInclude(parentElement, headingGates)) {
        return NodeFilter.FILTER_REJECT
      }

      const nearestBlock = getOwnerBlock(parentElement)
      if (nearestBlock && nearestBlock !== avBlock) {
        return NodeFilter.FILTER_REJECT
      }

      return NodeFilter.FILTER_ACCEPT
    },
  })

  return collectWalkerTextNodes(walker)
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
        return NodeFilter.FILTER_REJECT
      }

      const parentElement = node.parentElement
      if (!parentElement) {
        return NodeFilter.FILTER_REJECT
      }

      if (parentElement.closest(TEXT_NODE_EXCLUDED_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }
      if (!includeImageTitle && parentElement.closest(IMAGE_TITLE_TEXT_CLOSEST)) {
        return NodeFilter.FILTER_REJECT
      }

      if (ownerBlock && !isOwnedByBlock(parentElement, ownerBlock)) {
        return NodeFilter.FILTER_REJECT
      }

      return NodeFilter.FILTER_ACCEPT
    },
  })

  return collectWalkerTextNodes(walker)
}

function collectWalkerTextNodes(walker: TreeWalker): Text[] {
  const textNodes: Text[] = []
  let currentNode = walker.nextNode()
  while (currentNode) {
    textNodes.push(currentNode as Text)
    currentNode = walker.nextNode()
  }
  return textNodes
}

function getOwnerBlock(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('[data-node-id][data-type]')
}

function isOwnedByBlock(element: Element, ownerBlock: HTMLElement): boolean {
  // 仅归属最近的 [data-node-id] 祖先，避免表格块与单元格重复计数
  return getOwnerBlock(element) === ownerBlock
}

/** 预览合成块，或无归属宿主时的备注/公式伪 id（`__preview__-memo-N` 等） */
export function isPreviewSyntheticBlockId(blockId: string): boolean {
  return blockId === PREVIEW_BLOCK_ID
    || blockId.startsWith(`${PREVIEW_BLOCK_ID}-`)
}

export function isPreviewSyntheticBlock(block: SearchableBlock): boolean {
  return isPreviewSyntheticBlockId(block.blockId)
}

/**
 * 采集行内备注：备注正文在 data-inline-memo-content，不在 Text 节点。
 * 每个 span 一个独立单元；高亮时对准宿主 span。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/toolbar/InlineMemo.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/block/popover.ts
 */
function collectInlineMemoSearchUnits(docRoot: HTMLElement): SearchableBlock[] {
  const units: SearchableBlock[] = []
  // ~= 匹配 data-type 空格分隔 token，避免扫全站 span
  const spans = Array.from(
    docRoot.querySelectorAll<HTMLElement>('span[data-type~="inline-memo"]'),
  )
  const ownerIndexById = new Map<string, number>()
  Array.from(docRoot.querySelectorAll<HTMLElement>('[data-node-id][data-type]')).forEach((el, index) => {
    const id = el.dataset.nodeId?.trim()
    if (id && !ownerIndexById.has(id)) {
      ownerIndexById.set(id, index)
    }
  })
  let memoIndex = 0

  for (const span of spans) {
    if (span.closest('.protyle-attr, .fn__none')) {
      continue
    }

    const raw = span.getAttribute('data-inline-memo-content') ?? ''
    const text = plainTextFromInlineMemoContent(raw)
    if (!text) {
      continue
    }

    const owner = getOwnerBlock(span)
    const blockId = owner?.dataset.nodeId?.trim()
      || `${PREVIEW_BLOCK_ID}-memo-${memoIndex}`
    const blockType = owner?.dataset.type?.trim() || INLINE_MEMO_BLOCK_TYPE
    const blockIndex = owner?.dataset.nodeId
      ? (ownerIndexById.get(owner.dataset.nodeId.trim()) ?? memoIndex)
      : memoIndex

    units.push({
      blockId,
      blockType,
      blockIndex,
      element: span,
      text,
      textNodes: [],
      unitId: `${INLINE_MEMO_UNIT_PREFIX}${memoIndex}`,
      matchSource: 'inline-memo',
    })
    memoIndex += 1
  }

  return units
}

export function isInlineMemoSearchUnit(block: Pick<SearchableBlock, 'matchSource' | 'unitId'>): boolean {
  return block.matchSource === 'inline-memo'
    || Boolean(block.unitId?.startsWith(INLINE_MEMO_UNIT_PREFIX))
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
  const units: SearchableBlock[] = []
  const spans = Array.from(
    docRoot.querySelectorAll<HTMLElement>('span[data-type~="inline-math"]'),
  )
  const ownerIndexById = new Map<string, number>()
  Array.from(docRoot.querySelectorAll<HTMLElement>('[data-node-id][data-type]')).forEach((el, index) => {
    const id = el.dataset.nodeId?.trim()
    if (id && !ownerIndexById.has(id)) {
      ownerIndexById.set(id, index)
    }
  })
  let mathIndex = 0

  for (const span of spans) {
    if (span.closest('.protyle-attr, .fn__none')) {
      continue
    }

    const textNodes = collectInlineMathRenderedTextNodes(span)
    const text = textNodes.map((node) => node.nodeValue ?? '').join('')
    // 仅零宽占位则跳过（思源在公式旁插入 ZWSP）
    if (!text.replace(ZERO_WIDTH_RE, '').length) {
      continue
    }

    const owner = getOwnerBlock(span)
    const blockId = owner?.dataset.nodeId?.trim()
      || `${PREVIEW_BLOCK_ID}-math-${mathIndex}`
    const blockType = owner?.dataset.type?.trim() || INLINE_MATH_BLOCK_TYPE
    const blockIndex = owner?.dataset.nodeId
      ? (ownerIndexById.get(owner.dataset.nodeId.trim()) ?? mathIndex)
      : mathIndex

    units.push({
      blockId,
      blockType,
      blockIndex,
      element: span,
      text,
      textNodes,
      unitId: `${INLINE_MATH_UNIT_PREFIX}${mathIndex}`,
      matchSource: 'inline-math',
    })
    mathIndex += 1
  }

  return units
}

/**
 * 只取渲染层文字；排除 MathML / annotation（其中含 TeX 源码）。
 */
function collectInlineMathRenderedTextNodes(span: HTMLElement): Text[] {
  const htmlRoot = span.querySelector<HTMLElement>('.katex-html')
  const root = htmlRoot ?? span
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }
      const parentElement = node.parentElement
      if (
        !parentElement
        || parentElement.closest('.katex-mathml, annotation, svg, style, script')
      ) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  return collectWalkerTextNodes(walker)
}

export function isInlineMathSearchUnit(block: Pick<SearchableBlock, 'matchSource' | 'unitId'>): boolean {
  return block.matchSource === 'inline-math'
    || Boolean(block.unitId?.startsWith(INLINE_MATH_UNIT_PREFIX))
}

/** 备注或公式等属性型 unit（Range 对准宿主；公式不可替，备注可走属性写回） */
export function isAttributeInlineSearchUnit(
  block: Pick<SearchableBlock, 'matchSource' | 'unitId'>,
): boolean {
  return isInlineMemoSearchUnit(block) || isInlineMathSearchUnit(block)
}

export {
  ATTRIBUTE_VIEW_TYPE,
  BLOCKQUOTE_TYPE,
  CALLOUT_TYPE,
  EMBED_BLOCK_TYPE,
  MATH_BLOCK_TYPE,
  TABLE_TYPE,
}
