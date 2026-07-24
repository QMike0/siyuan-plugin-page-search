import {isInlineMemoSearchUnit, isInlineMathSearchUnit} from "./blocks";
import type {SearchableBlock} from "./dom-types";
import {isElementVisible, type ElementVisibilityOptions} from "./visibility";

interface TextPoint {
  node: Text
  offset: number
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
function locateTextPoint(
  textNodes: Text[],
  targetOffset: number,
  edge: "start" | "end",
): TextPoint | null {
  if (!textNodes.length) {
    return null
  }

  let cursor = 0
  for (let index = 0; index < textNodes.length; index++) {
    const textNode = textNodes[index]
    const text = textNode.nodeValue ?? ""
    const nextCursor = cursor + text.length
    const isLast = index === textNodes.length - 1

    if (edge === "start") {
      // [cursor, nextCursor)；仅末节点包含全文末尾 nextCursor
      if (
        targetOffset >= cursor
        && (targetOffset < nextCursor || (targetOffset === nextCursor && isLast))
      ) {
        return {
          node: textNode,
          offset: targetOffset - cursor,
        }
      }
    } else if (targetOffset === 0 && index === 0) {
      return {
        node: textNode,
        offset: 0,
      }
    } else if (targetOffset > cursor && targetOffset <= nextCursor) {
      // (cursor, nextCursor]；边界偏向上一节点末尾
      return {
        node: textNode,
        offset: targetOffset - cursor,
      }
    }

    cursor = nextCursor
  }

  return null
}
