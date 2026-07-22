import type {SearchableBlock} from "./dom-types";

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/
const PREVIEW_BLOCK_ID = '__preview__'
const PREVIEW_BLOCK_TYPE = 'preview'
const ATTRIBUTE_VIEW_TYPE = 'NodeAttributeView'
const CALLOUT_TYPE = 'NodeCallout'
const TABLE_TYPE = 'NodeTable'
const CODE_BLOCK_TYPE = 'NodeCodeBlock'
const MERMAID_SUBTYPE = 'mermaid'
/** Mermaid 搜索单元：源码在 data-content，无可替换 Text 节点 */
export const MERMAID_UNIT_ID = 'mermaid-source'
/** 行内备注 unitId 前缀；text 来自 data-inline-memo-content */
export const INLINE_MEMO_UNIT_PREFIX = 'inline-memo:'
/** 合成块类型，便于 replaceable / 高亮分流 */
export const INLINE_MEMO_BLOCK_TYPE = 'inline-memo'
const DOC_TITLE_BLOCK_ID = '__doc-title__'
const DOC_TITLE_BLOCK_TYPE = 'doc-title'
const TABLE_CELL_SELECTOR = '[data-type="NodeTableCell"], .table__cell, td, th'

/** 数据库内不应参与搜索的 UI 节点（含 av__cursor 的 ZWSP，会干扰零宽变体匹配） */
const AV_EXCLUDED_CLOSEST = [
  '.protyle-attr',
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
export function resolveDocRoot(edit: Element): HTMLElement | null {
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
    unitId: 'doc-title',
  }
}

/**
 * 按块收集可搜索文本。排除 .protyle-attr，避免嵌套块重复计数。
 * 预览模式无 data-node-id 时回退为整根合成块，保证行为不回退。
 */
export interface CollectSearchableBlocksOptions {
  /** 是否采集数据库（Attribute View）；默认 true */
  includeAttributeView?: boolean;
  /** 是否采集 Mermaid 图；默认 true */
  includeMermaid?: boolean;
  /** 是否采集行内备注（data-inline-memo-content）；默认 false */
  includeInlineMemo?: boolean;
}

export function collectSearchableBlocks(
  edit: Element,
  options: CollectSearchableBlocksOptions = {},
): SearchableBlock[] {
  const includeAttributeView = options.includeAttributeView !== false;
  const includeMermaid = options.includeMermaid !== false;
  const includeInlineMemo = options.includeInlineMemo === true;
  const docRoot = resolveDocRoot(edit)
  if (!docRoot) {
    return []
  }

  const blocks: SearchableBlock[] = []
  const titleUnit = collectDocTitleUnit(edit)
  if (titleUnit) {
    blocks.push(titleUnit)
  }

  const blockElements = getUniqueBlockElements(docRoot)
  if (blockElements.length === 0) {
    const textNodes = collectTextNodes(docRoot, null)
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
    if (includeInlineMemo) {
      blocks.push(...collectInlineMemoSearchUnits(docRoot))
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

    if (blockType === ATTRIBUTE_VIEW_TYPE) {
      if (!includeAttributeView) {
        return
      }
      // 数据库按单元格拆成独立搜索单元，禁止跨「框」拼接匹配
      blocks.push(...collectAttributeViewSearchUnits(element, blockId, blockIndex))
      return
    }

    if (blockType === TABLE_TYPE || element.classList.contains('table')) {
      // 表格按单元格拆分，禁止「传感器」+「2026」拼成「传感器20」
      blocks.push(...collectTableSearchUnits(element, blockId, blockIndex))
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

    if (blockType === CALLOUT_TYPE || element.classList.contains('callout')) {
      // Callout 标题在 .callout-title（非 contenteditable 子块），需单独采集
      // @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts getCalloutInfo
      blocks.push(...collectCalloutSearchUnits(element, blockId, blockIndex))
      return
    }

    const textNodes = collectTextNodes(element, element)
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

  if (includeInlineMemo) {
    blocks.push(...collectInlineMemoSearchUnits(docRoot))
  }

  return blocks
}

function getUniqueBlockElements(root: ParentNode): HTMLElement[] {
  const byId = new Map<string, HTMLElement>()

  Array.from(root.querySelectorAll<HTMLElement>('[data-node-id][data-type]')).forEach((element) => {
    const blockId = element.dataset.nodeId?.trim()
    if (!blockId) {
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
 * Callout：标题在 .callout-title，正文在 .callout-content 内的子块。
 * 正文子块仍由 getUniqueBlockElements 单独收集；此处保证标题可搜。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/callout.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/wysiwyg/getBlock.ts
 */
function collectCalloutSearchUnits(
  calloutBlock: HTMLElement,
  blockId: string,
  blockIndex: number,
): SearchableBlock[] {
  const units: SearchableBlock[] = []

  const titleElement = calloutBlock.querySelector<HTMLElement>('.callout-title')
  if (titleElement) {
    const titleNodes = collectDescendantTextNodes(titleElement)
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
  const ownedNodes = collectTextNodes(calloutBlock, calloutBlock).filter((node) => {
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

/** 收集元素后代文本，仅排除 svg/style/script/protyle-attr */
function collectDescendantTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }
      const parentElement = node.parentElement
      if (!parentElement || parentElement.closest('.protyle-attr, svg, style, script')) {
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

    const textNodes = collectDescendantTextNodes(cell)
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
): SearchableBlock[] {
  const units: SearchableBlock[] = []
  const seenUnitKeys = new Set<string>()

  const pushUnit = (container: HTMLElement, unitId: string) => {
    if (seenUnitKeys.has(unitId)) {
      return
    }
    const textNodes = collectTextNodesInContainer(container, avBlock)
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
function collectTextNodesInContainer(container: HTMLElement, avBlock: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }

      const parentElement = node.parentElement
      if (!parentElement || parentElement.closest(AV_EXCLUDED_CLOSEST)) {
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
function collectTextNodes(root: HTMLElement, ownerBlock: HTMLElement | null): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.length) {
        return NodeFilter.FILTER_REJECT
      }

      const parentElement = node.parentElement
      if (!parentElement) {
        return NodeFilter.FILTER_REJECT
      }

      if (parentElement.closest('.protyle-attr, svg, style, script')) {
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

export function isPreviewSyntheticBlock(block: SearchableBlock): boolean {
  return block.blockId === PREVIEW_BLOCK_ID
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

/** 备注属性可能含已消毒 HTML；匹配用纯文本 */
function plainTextFromInlineMemoContent(raw: string): string {
  const value = raw ?? ''
  if (!value) {
    return ''
  }
  if (!/<[a-zA-Z!/?]/.test(value)) {
    return value
  }
  try {
    const template = document.createElement('template')
    template.innerHTML = value
    return template.content.textContent ?? ''
  } catch {
    return value.replace(/<[^>]*>/g, '')
  }
}

export function isInlineMemoSearchUnit(block: Pick<SearchableBlock, 'matchSource' | 'unitId'>): boolean {
  return block.matchSource === 'inline-memo'
    || Boolean(block.unitId?.startsWith(INLINE_MEMO_UNIT_PREFIX))
}

export { ZERO_WIDTH_RE, ATTRIBUTE_VIEW_TYPE, CALLOUT_TYPE, TABLE_TYPE, CODE_BLOCK_TYPE }
