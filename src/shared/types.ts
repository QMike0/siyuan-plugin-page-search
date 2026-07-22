/**
 * 纯文本搜索单元（无 DOM）。
 * 由前端从 Protyle 采集后传给内核 RPC，或本地 fallback 使用。
 */
export interface SearchableUnit {
    blockId: string;
    blockType: string;
    blockIndex: number;
    /** 与 segmentLengths 拼接顺序一致的纯文本 */
    text: string;
    /**
     * 同一 blockId 下的子单元（如数据库单元格）。
     * 有值时只在该单元内匹配。
     */
    unitId?: string;
    /**
     * 各 Text 节点字符长度（按拼接顺序）。
     * 用于判断 replaceable；省略则 replaceable 恒为 false。
     */
    segmentLengths?: number[];
}

/** 块内文本偏移候选（可能与其它变体重叠） */
export interface TextOffsetMatch {
    startIndex: number;
    endIndex: number;
    searchStr: string;
}

/** 纯文本匹配命中（无 Range） */
export interface MatchHit {
    id: string;
    blockId: string;
    blockType: string;
    blockIndex: number;
    unitId?: string;
    start: number;
    end: number;
    matchedText: string;
    /** 是否落在同一文本段内且非 AV（后续替换用；公式等需前端 DOM 再校验） */
    replaceable: boolean;
}

/** 匹配行为选项（与 UI / RPC 对齐） */
export interface MatchOptions {
    /** 区分大小写；默认 false（与历史行为一致：强制小写子串） */
    caseSensitive?: boolean;
    /** 全字匹配（ASCII 词边界）；默认 false */
    wholeWord?: boolean;
    /** 正则搜索（仅搜索，不做正则替换）；默认 false */
    regex?: boolean;
}

export interface MatchTextUnitsOptions extends MatchOptions {
    /**
     * 是否按偏移贪心去重（先出现优先）。
     * 前端带可见性过滤时应为 false，去重延后到 Range 成功之后。
     * 内核 RPC 在客户端已过滤单元时可设为 true。
     * @default false
     */
    dedupeOverlaps?: boolean;
}

export interface MatchTextUnitsResult {
    hits: MatchHit[];
    /** 非法正则等错误信息；空字符串表示无错误 */
    error: string;
}
