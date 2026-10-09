import {isInlineMemoSearchUnit, isInlineMathSearchUnit} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import {isElementVisible, type ElementVisibilityOptions} from "./visibility";

interface TextPoint {
  node: Text
  offset: number
}

/** 同一轮采集的多个命中共享 Text 节点累积偏移；DOM 重建会产生新的数组键。 */
const textNodeEndsCache = new WeakMap<Text[], number[]>()

function textNodeEnds(textNodes: Text[]): number[] {
  const cached = textNodeEndsCache.get(textNodes)
  if (cached) {
    return cached
  }
  const ends: number[] = []
  let cursor = 0
  for (const textNode of textNodes) {
    cursor += (textNode.nodeValue ?? "").length
    ends.push(cursor)
  }
  textNodeEndsCache.set(textNodes, ends)
  return ends
}

function upperBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] <= target) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

function lowerBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

export function locateRangeInSingleTextNode(
  block: SearchableBlock,
  start: number,
  end: number,
): { node: Text, startOffset: number, endOffset: number } | null {
  if (end > start) {
    const startPoint = locateTextPoint(block.textNodes, start, "start")
    const endPoint = locateTextPoint(block.textNodes, end, "end")
    if (startPoint && endPoint && startPoint.node === endPoint.node) {
      return {
        node: startPoint.node,
        startOffset: startPoint.offset,
        endOffset: endPoint.offset,
      }
    }
    return null
  }
  let cursor = 0
  for (const textNode of block.textNodes) {
    const text = textNode.nodeValue ?? ''
    const nextCursor = cursor + text.length
    if (start >= cursor && end <= nextCursor) {
      return {
        node: textNode,
        startOffset: start - cursor,
        endOffset: end - cursor,
      }
    }
    cursor = nextCursor
  }
  return null
}

/**
 * 行内备注命中：备注正文在属性里，Range 对准宿主 span（整段高亮，不打开浮层）。
 */
function createRangeFromInlineMemo(
  block: SearchableBlock,
  start: number,
  end: number,
  visibility: ElementVisibilityOptions = {},
): Range | null {
  if (!isInlineMemoSearchUnit(block)) {
    return null
  }
  return createRangeFromAttributeHost(block, start, end, visibility)
}

/**
 * 行内公式命中：优先按渲染 Text 节点建 Range；无 Text 时回退整段宿主。
 */
function createRangeFromInlineMath(
  block: SearchableBlock,
  start: number,
  end: number,
  visibility: ElementVisibilityOptions = {},
): Range | null {
  if (!isInlineMathSearchUnit(block)) {
    return null
  }
  return createRangeFromAttributeHost(block, start, end, visibility)
}

function createRangeFromAttributeHost(
  block: SearchableBlock,
  start: number,
  end: number,
  visibility: ElementVisibilityOptions = {},
): Range | null {
  if (start < 0 || end < start || end > block.text.length) {
    return null
  }
  if (!isElementVisible(block.element, visibility)) {
    return null
  }
  try {
    const range = document.createRange()
    range.selectNodeContents(block.element)
    return range
  } catch {
    return null
  }
}

/**
 * 由块内偏移创建 DOM Range；不可见则返回 null。
 * allowFoldedHidden：计入非标题 CSS 折叠内的命中（匹配阶段不展开）。
 * 行内备注：宿主 span；行内公式：有渲染 Text 时按偏移（更精确），否则整段宿主。
 */
export function createRangeFromBlockOffsets(
  block: SearchableBlock,
  start: number,
  end: number,
  visibility: ElementVisibilityOptions = {},
): Range | null {
  if (isInlineMemoSearchUnit(block)) {
    return createRangeFromInlineMemo(block, start, end, visibility)
  }
  // 公式已采到 katex-html Text 时走普通偏移，高亮对准可见字形而非整段源码壳
  if (isInlineMathSearchUnit(block) && !block.textNodes.length) {
    return createRangeFromInlineMath(block, start, end, visibility)
  }
  if (!block.textNodes.length || start < 0 || end < start || end > block.text.length) {
    return null
  }

  const startPoint = locateTextPoint(block.textNodes, start, "start")
  const endPoint = locateTextPoint(block.textNodes, end, "end")
  if (!startPoint || !endPoint) {
    return null
  }

  try {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)

    const startContainerElement = startPoint.node.parentElement
    const endContainerElement = endPoint.node.parentElement
    if (
      !startContainerElement
      || !endContainerElement
      || !isElementVisible(startContainerElement, visibility)
      || !isElementVisible(endContainerElement, visibility)
    ) {
      return null
    }

    return range
  } catch {
    return null
  }
}

/**
 * 将块内字符偏移映射到 Text 节点。
 * 节点边界处：start 偏向下一个节点开头，end 偏向上一个节点末尾，
 * 避免命中落在「隐藏图标文本 | 可见主键」边界时 Range 起点落在 .fn__none 内。
 */
export function locateTextPoint(
  textNodes: Text[],
  targetOffset: number,
  edge: "start" | "end",
): TextPoint | null {
  if (!textNodes.length) {
    return null
  }
  const ends = textNodeEnds(textNodes)
  const total = ends[ends.length - 1]
  if (targetOffset < 0 || targetOffset > total) {
    return null
  }
  // [cursor, nextCursor)；仅末节点包含全文末尾。end 保持落在前一个节点的边界语义。
  const index = edge === "start" ?
    (targetOffset === total ? textNodes.length - 1 : upperBound(ends, targetOffset)) :
    (targetOffset === 0 ? 0 : lowerBound(ends, targetOffset))
  if (index < 0 || index >= textNodes.length) {
    return null
  }
  const cursor = index === 0 ? 0 : ends[index - 1]
  return {
    node: textNodes[index],
    offset: targetOffset - cursor,
  }
}

/**
 * Range 内是否仅含文本（无元素节点）。
 * 用于允许「同一父级下被拆开的多个 Text」替换，同时拒绝跨越加粗/链接等结构。
 */
export function isRangePlainTextOnly(range: Range): boolean {
  if (
    range.startContainer === range.endContainer
    && range.startContainer.nodeType === Node.TEXT_NODE
  ) {
    return true
  }
  try {
    const fragment = range.cloneContents()
    for (let index = 0; index < fragment.childNodes.length; index++) {
      if (fragment.childNodes[index].nodeType === Node.ELEMENT_NODE) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
