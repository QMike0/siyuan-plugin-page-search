export { avApiUnitInView, avApiUnitShown, collectAvDomCoverage } from "./av-live";
export { collectHeadingFoldedIds, isBlockTreeEnabled, isSelfFoldedIal } from "./block-tree";
export type { BlockAncestorIncludeFlags, BlockTreeLink, MountedHeadingFoldState } from "./block-tree";
export { effectiveSearchQuery, formatSearchCountLabel, ZERO_WIDTH_GLOBAL_RE, ZERO_WIDTH_RE } from "./constants";
export { DOC_TITLE_MAX_LENGTH, isValidDocTitle, sanitizeDocTitle } from "./doc-title";
export { plainTextFromInlineMemoContent, sanitizeInlineMemoContentForWrite } from "./inline-memo-content";
export {
    createSearchPattern,
    createTextMatchProbe,
    escapeForRegex,
    findOffsetMatchesInText,
    generateSearchVariants,
    isHitReplaceableByUnit,
    isOffsetReplaceable,
    isWholeWordMatch,
    matchTextUnits,
    matchTextUnitsDetailed,
    offsetMatchToHit,
    rangesOverlap,
    regexSearchFlags,
} from "./match-text";
export { extractRegexLiteralGroups, regexPrefilterStoresPlainCache } from "./regex-literals";
export { expandRegexReplacement, expandRegexReplacementUnits, expandReplacementTemplate } from "./regex-replace";
export type {
    ExpandRegexReplacementOptions,
    RegexReplacementExpansion,
    RegexReplacementUnitRequest,
} from "./regex-replace";
export {
    isRendererUnitFor,
    isRendererUnitId,
    RENDERER_UNIT_PREFIX,
    rendererUnitId,
    rendererUnitSource,
} from "./renderer-units";
export type { RendererUnitSource } from "./renderer-units";
export { ATTRIBUTE_VIEW_TYPE, NON_REPLACEABLE_DOM_CLOSEST } from "./replaceable";
export {
    canRestrictInlineMemo,
    hasRestrictInlineType,
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    normalizeRestrictInlineTypes,
    parseDataTypeTokens,
    rangeRestrictTokens,
    RESTRICT_INLINE_TYPE_ALLOWLIST,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    shouldEnumerateRestrictInline,
    toggleRestrictInlineType,
} from "./restrict-inline";
export type { RestrictAttributeKind, RestrictInlineType } from "./restrict-inline";
export {
    coercePluginPrefs,
    DEFAULT_PREFS,
    matchOptionsFromRequest,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeSearchStateEvent,
    PREFS_STORAGE_PATH,
    SEARCH_EMIT_METHOD,
    SEARCH_STATE_METHOD,
} from "./rpc-types";
export type { MatchRequest, MatchResponse, PluginPrefs, SearchStateEvent, SearchStateType } from "./rpc-types";
export {
    countVirtualTableRows,
    logicalRowOffset,
    logicalTableCells,
    logicalTableRows,
    mergeVirtualTableUnits,
    ownTableRows,
    TABLE_VIRTUAL_ROWS_ATTR,
    tableCellNodeId,
    tableCellPosition,
    tableHostOmitsRows,
} from "./table-live";
export type { LogicalTableLayout, LogicalTableRow } from "./table-live";
export type {
    MatchHit,
    MatchOptions,
    MatchTextUnitsOptions,
    MatchTextUnitsResult,
    SearchableUnit,
    TextOffsetMatch,
} from "./types";
