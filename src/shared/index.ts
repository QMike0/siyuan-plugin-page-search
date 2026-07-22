export {ZERO_WIDTH_CHARS, ZERO_WIDTH_GLOBAL_RE, ZERO_WIDTH_RE} from "./constants";
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
    MERMAID_DOM_CLOSEST,
    NON_REPLACEABLE_DOM_CLOSEST,
} from "./replaceable";
export {
    DEFAULT_PREFS,
    PREFS_STORAGE_PATH,
    SEARCH_EMIT_METHOD,
    SEARCH_STATE_METHOD,
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
