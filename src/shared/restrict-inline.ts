/**
 * 限制查找（行内类型）与「是否查找」的边界契约。
 *
 * 1. `restrictInlineTypes` 为空 → 不限制（在「是否查找」允许的块范围内全文搜）。
 * 2. 非空 → 仅匹配所选行内类型；多选为 OR（`data-type` 可叠加，如 strong+mark 两边都算）。
 * 3. 处理顺序：块级 include*（是否查找）→ 行内 restrict（限制查找）。
 * 4. 不含彩色字/背景（`data-type~="text"` + style），不进白名单。
 * 5. 行内备注双开关（不重复）：
 *    - `includeInlineMemo`（是否查找）：正常搜时是否纳入备注属性文本。
 *    - `'inline-memo' ∈ restrictInlineTypes`（限制查找）：限制模式下备注是否进入 OR 集合。
 *    - 门闩：`includeInlineMemo === false` 时限制项不可开；normalize 时踢掉 `inline-memo`。
 * 6. 行内公式：匹配 KaTeX 渲染可见文本（`.katex-html`），排除含源码的 `.katex-mathml`；
 *    不搜 `data-content` LaTeX（避免 “d” 命中 `\delta`）。全文与「限制·公式」均走渲染文本。
 * 7. 空查询 + 限制激活 → 枚举所选类型的整段行内宿主（元素去重、嵌套父子分别计）；
 *    不可替换。限制关 + 空查询 → 仍为 0。
 *
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_typography.scss
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/toolbar/index.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/render/mathRender.ts
 */

export const INLINE_MEMO_TYPE = "inline-memo";
export const INLINE_MATH_TYPE = "inline-math";
/** 块引用（工具栏「引用」） */
const BLOCK_REF_TYPE = "block-ref";

/**
 * 允许写入 `restrictInlineTypes` 的 token；顺序即菜单展示顺序。
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/hint/extend.ts
 * @see https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/toolbar/index.ts
 */
export const RESTRICT_INLINE_TYPE_ALLOWLIST = [
    BLOCK_REF_TYPE,
    "a",
    "strong",
    "em",
    "u",
    "s",
    "mark",
    "sup",
    "sub",
    "code",
    "kbd",
    "tag",
    INLINE_MATH_TYPE,
    INLINE_MEMO_TYPE,
] as const;

export type RestrictInlineType = (typeof RESTRICT_INLINE_TYPE_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(RESTRICT_INLINE_TYPE_ALLOWLIST);

/** 是否处于「限制查找」生效状态（数组非空） */
export function isRestrictInlineActive(
    types: readonly string[] | null | undefined,
): boolean {
    return Array.isArray(types) && types.length > 0;
}

/**
 * 空查询 + 限制激活 → 走行内宿主枚举（非关键词匹配）。
 * 限制关或有关键词时返回 false。
 */
export function shouldEnumerateRestrictInline(
    query: string,
    restrictTypes: readonly string[] | null | undefined,
): boolean {
    return !String(query ?? "").trim() && isRestrictInlineActive(restrictTypes);
}

/** 「是否查找 · 行内备注」开启时，才允许开「限制查找 · 行内备注」 */
export function canRestrictInlineMemo(includeInlineMemo: boolean): boolean {
    return includeInlineMemo === true;
}

/**
 * 规范化限制类型列表：去重、滤白名单、按 allowlist 排序；
 * `includeInlineMemo === false` 时移除 `inline-memo`。
 */
export function normalizeRestrictInlineTypes(
    raw: unknown,
    options: {includeInlineMemo: boolean},
): RestrictInlineType[] {
    const seen = new Set<RestrictInlineType>();
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item !== "string") {
                continue;
            }
            const token = item.trim();
            if (!ALLOWLIST_SET.has(token)) {
                continue;
            }
            if (token === INLINE_MEMO_TYPE && !canRestrictInlineMemo(options.includeInlineMemo)) {
                continue;
            }
            seen.add(token as RestrictInlineType);
        }
    }

    return RESTRICT_INLINE_TYPE_ALLOWLIST.filter((token) => seen.has(token));
}

/**
 * 切换某一限制类型；违反备注门闩时开启无效（返回原列表规范化结果）。
 */
export function toggleRestrictInlineType(
    current: readonly string[] | null | undefined,
    type: RestrictInlineType,
    enabled: boolean,
    options: {includeInlineMemo: boolean},
): RestrictInlineType[] {
    if (type === INLINE_MEMO_TYPE && enabled && !canRestrictInlineMemo(options.includeInlineMemo)) {
        return normalizeRestrictInlineTypes(current, options);
    }
    const set = new Set(
        normalizeRestrictInlineTypes(current, options),
    );
    if (enabled) {
        set.add(type);
    } else {
        set.delete(type);
    }
    return normalizeRestrictInlineTypes(Array.from(set), options);
}

export function hasRestrictInlineType(
    types: readonly string[] | null | undefined,
    type: RestrictInlineType,
): boolean {
    return Array.isArray(types) && types.includes(type);
}

/**
 * 拆分 `data-type`（空格分隔，可叠加）。
 * @see siyuan typography：`span[data-type~="strong"]` 等
 */
export function parseDataTypeTokens(dataType: string | null | undefined): string[] {
    if (!dataType) {
        return [];
    }
    return dataType.split(/\s+/).filter(Boolean);
}

/** 属性型特殊行内（不走正文 Range 宿主过滤） */
export type RestrictAttributeKind = typeof INLINE_MEMO_TYPE | typeof INLINE_MATH_TYPE;

/**
 * 参与「正文 Range 是否落在限制宿主内」判定的 token。
 * `inline-memo` / `inline-math` 为独立属性 unit，不进此列表。
 */
export function rangeRestrictTokens(
    types: readonly RestrictInlineType[] | null | undefined,
): RestrictInlineType[] {
    if (!Array.isArray(types) || types.length === 0) {
        return [];
    }
    return types.filter(
        (token) => token !== INLINE_MEMO_TYPE && token !== INLINE_MATH_TYPE,
    );
}

/**
 * 限制查找命中是否保留（纯逻辑，供 pipeline / 冒烟复用）。
 *
 * - 未激活 → 一律保留
 * - 备注 / 公式属性 unit → 仅当对应 token 在限制集合中
 * - 正文命中 → 宿主 `data-type` 与「文本类限制 token」有交集（OR）
 */
export function matchPassesRestrictInline(options: {
    restrictTypes: readonly RestrictInlineType[] | null | undefined;
    /** 属性型 unit；与正文互斥 */
    attributeKind?: RestrictAttributeKind | null;
    /** 命中所在限制宿主的 data-type tokens；无宿主时为空 */
    hostDataTypes: readonly string[];
}): boolean {
    const restrictTypes = options.restrictTypes;
    if (!isRestrictInlineActive(restrictTypes)) {
        return true;
    }
    const attributeKind = options.attributeKind ?? null;
    if (attributeKind) {
        return hasRestrictInlineType(restrictTypes, attributeKind);
    }
    const allowed = rangeRestrictTokens(restrictTypes);
    if (allowed.length === 0) {
        return false;
    }
    const host = options.hostDataTypes;
    if (!host.length) {
        return false;
    }
    const allowedSet = new Set<string>(allowed);
    return host.some((token) => allowedSet.has(token));
}

/**
 * 是否采集正文/块级 Text 单元。
 * 限制仅含备注/公式等属性类型（无 mark/strong/…）时跳过正文。
 */
export function shouldCollectBodyTextForRestrict(
    restrictTypes: readonly RestrictInlineType[] | null | undefined,
): boolean {
    if (!isRestrictInlineActive(restrictTypes)) {
        return true;
    }
    return rangeRestrictTokens(restrictTypes).length > 0;
}

/**
 * 是否采集行内备注属性单元。
 *
 * 双开关四种组合：
 * 1. 是否开 + 限制未激活 → 采（全文含备注）
 * 2. 是否开 + 限制含 memo → 采（OR 含备注）
 * 3. 是否开 + 限制不含 memo → 不采
 * 4. 是否关 → 不采（限制侧 memo 已被 normalize 踢掉）
 */
export function shouldCollectInlineMemoUnits(options: {
    includeInlineMemo: boolean;
    restrictTypes: readonly RestrictInlineType[] | null | undefined;
}): boolean {
    if (!options.includeInlineMemo) {
        return false;
    }
    if (!isRestrictInlineActive(options.restrictTypes)) {
        return true;
    }
    return hasRestrictInlineType(options.restrictTypes, INLINE_MEMO_TYPE);
}

/**
 * 行内公式独立 unit 采集门闩。
 * - 不限制：采集（渲染可见文本并入页内搜；正文 walker 已排除公式以免重复）
 * - 限制激活：仅当集合含 `inline-math`
 *
 * 匹配对象是 KaTeX 渲染字形，不是 data-content 源码。
 */
export function shouldCollectInlineMathUnits(
    restrictTypes: readonly RestrictInlineType[] | null | undefined,
): boolean {
    if (!isRestrictInlineActive(restrictTypes)) {
        return true;
    }
    return hasRestrictInlineType(restrictTypes, INLINE_MATH_TYPE);
}
