/** 前端 DOM 搜索块（含 element / textNodes，仅浏览器侧使用） */
export interface SearchableBlock {
    blockId: string;
    blockType: string;
    blockIndex: number;
    element: HTMLElement;
    text: string;
    textNodes: Text[];
    unitId?: string;
    /**
     * 匹配源：
     * - inline-memo：text 来自 data-inline-memo-content
     * - inline-math：text 来自 KaTeX `.katex-html` 渲染可见文字（非 data-content 源码）
     * Range 优先按 textNodes 偏移；备注对准宿主 span。
     */
    matchSource?: "text" | "inline-memo" | "inline-math";
    /**
     * 块内排序锚点。行内备注的 start 是备注正文里的偏移，
     * 这里记宿主 span 在块文本中的位置，跳转才按出现顺序。
     */
    anchorOffset?: number;
}

/** 带 Range 的搜索命中（高亮 / 导航） */
export interface SearchMatch {
    id: string;
    blockId: string;
    blockType: string;
    blockIndex: number;
    unitId?: string;
    start: number;
    end: number;
    matchedText: string;
    replaceable: boolean;
    /** 行内备注：宿主在块文本中的位置。缺省时用 start。 */
    anchorOffset?: number;
    range?: Range;
    /** 高亮样式：备注虚线；公式与正文同走 CSS Highlight（有渲染 Text 时按偏移，否则回退宿主） */
    highlightKind?: "text" | "inline-memo" | "inline-math";
    /** 数据库命中无法做词级高亮时，展示视图、列和单元格文字。 */
    snippet?: string;
}
