import type {AvBlockRef} from "./corpus/av";
import type {ResultBlockType} from "./result-block-types";

/** 前端 DOM 搜索块（含 element / textNodes，仅浏览器侧使用） */
export interface SearchableBlock {
    /** Content block types from the text's innermost block to its outer containers. */
    blockTypes?: readonly ResultBlockType[];
    blockId: string;
    blockType: string;
    blockIndex: number;
    element: HTMLElement;
    text: string;
    textNodes: Text[];
    unitId?: string;
    /** Copied source instance within an embed; retained until ownership is rewritten. */
    embeddedSourceId?: string;
    /** 嵌入内的文字偏移到紧凑 DOM 顺序序号的快照，不保留节点。 */
    embeddedOrder?: readonly EmbeddedOrderSegment[];
    /** Cold embedded database carrier; values stay in the independently invalidated AV cache. */
    embeddedAvRef?: AvBlockRef;
    /**
     * 匹配源：
     * - inline-memo：text 来自 data-inline-memo-content
     * - inline-math：优先 KaTeX `.katex-html` 字形，冷态失败时源码单元独立标识且无 Range
     * Range 优先按 textNodes 偏移；备注对准宿主 span。
     */
    matchSource?: "text" | "inline-memo" | "inline-math" | "projection";
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

export interface EmbeddedOrderSegment {
    start: number;
    path: readonly number[];
}

export interface TableSlot {
    row: number;
    column: number;
    offset: number;
}

/**
 * 表格命中为什么不能替换。
 * table-rich：内容在 data-sy-table-cell-rich 里，改画面文字会被思源按源码重画掉。
 * table-cell-editor：格子编辑器还开着，写回会等到编辑结束才提交，中途整表刷新会丢掉。
 */
export type TableReplaceLock = "table-rich" | "table-cell-editor";

/** 带 Range 的搜索命中（高亮 / 导航） */
export interface SearchMatch {
    blockTypes?: readonly ResultBlockType[];
    id: string;
    blockId: string;
    blockType: string;
    blockIndex: number;
    unitId?: string;
    /** 同一块内的跳转顺序。表格先按格子再按格内位置，数据库先行后列。 */
    unitSeq?: number;
    /** 嵌入宿主内部的结构位置；优先于不同子单元各自从零起算的偏移。 */
    embeddedPosition?: readonly number[];
    /** View used by a cold embedded AV snapshot; prevents alias binding after a view switch. */
    embeddedAvViewId?: string;
    start: number;
    end: number;
    matchedText: string;
    replaceable: boolean;
    /** 表格格子不能替换的原因。有值时 replaceable 为 false。 */
    replaceLock?: TableReplaceLock;
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
    /** 数据库来源摘要，包含视图、列和单元格文字；跳转时不弹出。 */
    snippet?: string;
    /** 结果列表的单行摘要，独立于数据库来源摘要。 */
    listText?: string;
    /** listText 里需要标出的命中区间。 */
    listMark?: {start: number; end: number;};
    /** 摘要裁剪标志，供唯一前后文锚定；不用于替换的安全验证。 */
    listContextClipped?: number;
}
