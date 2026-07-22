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
     * 匹配源：inline-memo 时 text 来自 data-inline-memo-content，
     * Range 应对准宿主 span（非整段属性字符）。
     */
    matchSource?: "text" | "inline-memo";
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
    range?: Range;
    /** 高亮样式：行内备注用独立颜色 */
    highlightKind?: "text" | "inline-memo";
}
