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
    /** 备注宿主在所属块文本里的结束偏移，不含终点。 */
    anchorEnd?: number;
    /** 表格里的行内公式或备注所在的格子，offset 是它在格子文字里的位置。跳转时插在这一格的命中之间。 */
    tableSlot?: TableSlot;
    /** 同一宿主块里同样内容的第几个行内公式。块的重复副本序号相同，去重只去掉副本。 */
    mathOrdinal?: number;
}

export interface TableSlot {
    row: number;
    column: number;
    offset: number;
}

/** 带 Range 的搜索命中（高亮 / 导航） */
export interface SearchMatch {
    id: string;
    blockId: string;
    blockType: string;
    blockIndex: number;
    unitId?: string;
    /** 同一块内的跳转顺序。表格先按格子再按格内位置，数据库先行后列。 */
    unitSeq?: number;
    start: number;
    end: number;
    matchedText: string;
    replaceable: boolean;
    /** 行内备注：宿主在块文本中的位置。缺省时用 start。 */
    anchorOffset?: number;
    /** 行内备注宿主在块文本中的结束位置，不含终点。和 anchorOffset 一起判断正文是否落在这段宿主里。 */
    anchorEnd?: number;
    range?: Range;
    /** 高亮样式：备注虚线；公式与正文同走 CSS Highlight（有渲染 Text 时按偏移，否则回退宿主） */
    highlightKind?: "text" | "inline-memo" | "inline-math";
    /**
     * 行内公式在所属块里的序号，和 mathUnitText 一起用。
     * unitId 是全文采集序号，只采集改过的块时会从 0 重计，不能用来补高亮。
     */
    mathOrdinal?: number;
    /** 行内公式整段可见文字（去掉零宽字符），与采集 mathOrdinal 时的口径一致。 */
    mathUnitText?: string;
    /** 数据库命中无法做词级高亮时，展示视图、列和单元格文字。跳转时可能弹出提示。 */
    snippet?: string;
    /** 结果列表的单行摘要。与 snippet 分开，避免每次跳转都弹提示。 */
    listText?: string;
    /** listText 里需要标出的命中区间。 */
    listMark?: {start: number; end: number};
}
