/**
 * 行内备注命中提示：在 .protyle-content 上叠虚线下划线，不改内容块 DOM。
 *
 * 思源正文下划线 / 行内备注本身用 border-bottom（紧贴字形盒底）：
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_typography.scss
 *   span[data-type~="u"] { border-bottom: 1px solid; }
 *   span[data-type~="inline-memo"] { border-bottom: 2px solid var(--b3-card-info-color); }
 * 本叠加层再下沉一点并用虚线，与 Ctrl+U / 备注固有下划线区分。
 */

export const MEMO_UNDERLINE_HOST = "page-search-memo-underline-host";
export const MEMO_UNDERLINE_LAYER = "page-search-memo-underline-layer";
export const MEMO_UNDERLINE = "page-search-memo-underline";

/** 相对 clientRect.bottom 再下沉的像素，避开思源 u / inline-memo 的 border-bottom */
const UNDERLINE_OFFSET_PX = 4;

/**
 * 清除备注虚线叠加层（仅 .protyle-content 直接子层）。
 */
export function clearMemoUnderlineVisual(edit: Element): void {
    edit.querySelectorAll(
        `.protyle-content > .${MEMO_UNDERLINE_LAYER}`,
    ).forEach((el) => {
        el.remove();
    });
    edit.querySelectorAll(`.protyle-content.${MEMO_UNDERLINE_HOST}`).forEach((el) => {
        el.classList.remove(MEMO_UNDERLINE_HOST);
    });
}

/**
 * 为备注命中 Range（通常为宿主 span 内容）绘制黄/橙虚线下划线。
 * focusRange 若能匹配某条 result，对应线段用橙色（当前项），其余黄色。
 */
export function applyMemoUnderlineVisual(
    edit: Element,
    resultRanges: Range[],
    focusRange: Range | null,
): void {
    clearMemoUnderlineVisual(edit);
    if (!resultRanges.length) {
        return;
    }

    const hintNode = resultRanges[0]?.commonAncestorContainer;
    const hintEl = hintNode
        ? (hintNode.nodeType === Node.ELEMENT_NODE
            ? hintNode as Element
            : hintNode.parentElement)
        : null;
    const content = resolveProtyleContent(edit, hintEl);
    if (!content) {
        return;
    }

    content.classList.add(MEMO_UNDERLINE_HOST);
    const layer = ensureOverlayLayer(content);
    const contentRect = content.getBoundingClientRect();

    // key → 是否 focus；同位置优先保留 focus（橙）
    const segments = new Map<string, {left: number; top: number; width: number; focus: boolean}>();

    for (const range of resultRanges) {
        const isFocus = focusRange ? rangesEqual(range, focusRange) : false;
        let clientRects: DOMRect[];
        try {
            clientRects = Array.from(range.getClientRects());
        } catch {
            continue;
        }

        for (const rect of clientRects) {
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }
            const left = Math.round(rect.left - contentRect.left + content.scrollLeft);
            const top = Math.round(
                rect.bottom - contentRect.top + content.scrollTop + UNDERLINE_OFFSET_PX,
            );
            const width = Math.round(rect.width);
            const key = `${left},${top},${width}`;
            const existing = segments.get(key);
            if (existing) {
                existing.focus = existing.focus || isFocus;
            } else {
                segments.set(key, {left, top, width, focus: isFocus});
            }
        }
    }

    for (const segment of segments.values()) {
            const line = document.createElement("div");
            line.className = segment.focus
                ? `${MEMO_UNDERLINE} is-focus`
                : MEMO_UNDERLINE;
            line.style.left = `${segment.left}px`;
            line.style.top = `${segment.top}px`;
            line.style.width = `${segment.width}px`;
            layer.appendChild(line);
    }
}

function rangesEqual(a: Range, b: Range): boolean {
    try {
        return a.compareBoundaryPoints(Range.START_TO_START, b) === 0
            && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
    } catch {
        return a === b;
    }
}

function resolveProtyleContent(edit: Element, hint?: Element | null): HTMLElement | null {
    const fromHint = hint?.closest<HTMLElement>(".protyle-content");
    if (fromHint && edit.contains(fromHint)) {
        return fromHint;
    }
    return edit.querySelector<HTMLElement>(
        ":scope > .protyle:not(.fn__none) .protyle-content:not(.fn__none)",
    ) ?? edit.querySelector<HTMLElement>(".protyle:not(.fn__none) .protyle-content:not(.fn__none)")
        ?? edit.querySelector<HTMLElement>(".protyle-content");
}

function ensureOverlayLayer(content: HTMLElement): HTMLElement {
    let layer = content.querySelector<HTMLElement>(`:scope > .${MEMO_UNDERLINE_LAYER}`);
    if (!layer) {
        layer = document.createElement("div");
        layer.className = MEMO_UNDERLINE_LAYER;
        layer.setAttribute("aria-hidden", "true");
        const wysiwyg = content.querySelector(":scope > .protyle-wysiwyg");
        if (wysiwyg) {
            wysiwyg.insertAdjacentElement("afterend", layer);
        } else {
            content.appendChild(layer);
        }
    } else {
        layer.replaceChildren();
    }
    return layer;
}
