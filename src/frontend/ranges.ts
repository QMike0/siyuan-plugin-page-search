import {isInlineMemoSearchUnit} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import {isElementVisible, type ElementVisibilityOptions} from "./visibility";

interface TextPoint {
  node: Text
  offset: number
}

/**
 * 判断块内 [start, end) 是否落在同一 Text 节点（后续替换前置条件）
 */
export function isRangeReplaceable(block: SearchableBlock, start: number, end: number): boolean {
  return Boolean(locateRangeInSingleTextNode(block, start, end))
}

export function locateRangeInSingleTextNode(
  block: SearchableBlock,
  start: number,
  end: number,
): { node: Text, startOffset: number, endOffset: number } | null {
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
export function createRangeFromInlineMemo(
  block: SearchableBlock,
  start: number,
  end: number,
  visibility: ElementVisibilityOptions = {},
): Range | null {
  if (!isInlineMemoSearchUnit(block)) {
    return null
  }
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
 * 行内备注走 createRangeFromInlineMemo。
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
  if (!block.textNodes.length || start < 0 || end < start || end > block.text.length) {
    return null
  }

  const startPoint = locateTextPoint(block.textNodes, start)
  const endPoint = locateTextPoint(block.textNodes, end)
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

function locateTextPoint(textNodes: Text[], targetOffset: number): TextPoint | null {
  let cursor = 0

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    const nextCursor = cursor + text.length
    if (targetOffset >= cursor && targetOffset <= nextCursor) {
      return {
        node: textNode,
        offset: targetOffset - cursor,
      }
    }
    cursor = nextCursor
  }

  const lastNode = textNodes[textNodes.length - 1]
  if (!lastNode) {
    return null
  }

  const lastLength = lastNode.nodeValue?.length ?? 0
  if (targetOffset === cursor) {
    return {
      node: lastNode,
      offset: lastLength,
    }
  }

  return null
}
