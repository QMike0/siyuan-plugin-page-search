/** 与 frontend/blocks 中 ATTRIBUTE_VIEW_TYPE 一致 */
export const ATTRIBUTE_VIEW_TYPE = "NodeAttributeView";

/** Mermaid 等图表代码块：仅搜索 data-content，不可替换 */
const MERMAID_DOM_CLOSEST = '[data-subtype="mermaid"]';

/**
 * 命中 Text 若落在这些祖先内则不可替换（前端 DOM 校验）。
 * 不含普通加粗/链接等可编辑 inline。
 */
export const NON_REPLACEABLE_DOM_CLOSEST = [
    '[data-type~="inline-math"]',
    '[data-subtype="math"]',
    MERMAID_DOM_CLOSEST,
].join(", ");
