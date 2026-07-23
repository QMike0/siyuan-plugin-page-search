export {SEARCH_COUNT_SOFT_CAP, ZERO_WIDTH_GLOBAL_RE, ZERO_WIDTH_RE, formatSearchCountLabel} from "./constants";
export {
    createSearchPattern,
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
} from "./match-text";
export {
    ATTRIBUTE_VIEW_TYPE,
    NON_REPLACEABLE_DOM_CLOSEST,
} from "./replaceable";
export {
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    SEARCH_EMIT_METHOD,
    SEARCH_STATE_METHOD,
    coercePluginPrefs,
    matchOptionsFromRequest,
    mergePrefs,
    normalizeMatchRequest,
    normalizePrefsPatch,
    normalizeSearchStateEvent,
} from "./rpc-types";
export type {
    MatchHit,
    MatchOptions,
    MatchTextUnitsOptions,
    MatchTextUnitsResult,
    SearchableUnit,
    TextOffsetMatch,
} from "./types";
export type {
    MatchRequest,
    MatchResponse,
    PluginPrefs,
    SearchStateEvent,
    SearchStateType,
} from "./rpc-types";
export {
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
    RESTRICT_INLINE_TYPE_ALLOWLIST,
    canRestrictInlineMemo,
    hasRestrictInlineType,
    isRestrictInlineActive,
    matchPassesRestrictInline,
    normalizeRestrictInlineTypes,
    parseDataTypeTokens,
    rangeRestrictTokens,
    shouldCollectBodyTextForRestrict,
    shouldCollectInlineMathUnits,
    shouldCollectInlineMemoUnits,
    shouldEnumerateRestrictInline,
    toggleRestrictInlineType,
} from "./restrict-inline";
export type {RestrictAttributeKind, RestrictInlineType} from "./restrict-inline";
