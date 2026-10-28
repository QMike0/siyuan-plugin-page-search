/** 代码块语言判断由离屏元数据、渲染分流和搜索开关共同使用，保持三者语义一致。 */
export interface CodeBlockLanguageFlags {
    includeCodeBlock?: boolean;
    includeCodeLanguage?: boolean;
    includeMermaid?: boolean;
    includeFlowchart?: boolean;
}

export const CODE_LANGUAGE_UNIT_ID = "code-language";

/** Explicit source identity survives caching, embedded ownership and DOM rebinding. */
export function isCodeLanguageUnit(unit: {matchSource?: string; highlightKind?: string; unitId?: string;}): boolean {
    return unit.matchSource === "code-language" || unit.highlightKind === "code-language" ||
        unit.unitId === CODE_LANGUAGE_UNIT_ID;
}

export function codeLanguageSearchEnabled(options: CodeBlockLanguageFlags): boolean {
    // Older callers disabling ordinary code should continue to disable its label.
    return (options.includeCodeLanguage ?? options.includeCodeBlock) !== false;
}

export const DIAGRAM_CODE_LANGUAGES = [
    "mermaid",
    "flowchart",
    "graphviz",
    "plantuml",
    "chart",
    "mindmap",
    "abc",
] as const;

export const DIAGRAM_CODE_LANGUAGE_SET = new Set<string>(DIAGRAM_CODE_LANGUAGES);

/**
 * 思源 blocks.subtype 对代码块通常为空。编辑器 data-subtype 或离屏解析到的围栏语言优先，
 * 仅在二者均未知时兼容 subtype。
 */
export function effectiveCodeBlockLanguage(type: string, subtype: string, codeLanguage?: string): string {
    return type === "c" ? (codeLanguage ?? subtype) : subtype;
}

export function isDiagramCodeLanguage(language: string): boolean {
    return DIAGRAM_CODE_LANGUAGE_SET.has(language);
}

/** 这两种图表没有正常输出时可回退源码，不调用离屏图表渲染器。 */
export function supportsDiagramSourceSearch(language: string): boolean {
    return language === "mermaid" || language === "flowchart";
}

export function isCodeBlockLanguageEnabled(language: string, options: CodeBlockLanguageFlags): boolean {
    if (language === "mermaid") {
        return options.includeMermaid !== false;
    }
    if (language === "flowchart") {
        return options.includeFlowchart !== false;
    }
    if (isDiagramCodeLanguage(language)) {
        return options.includeCodeBlock !== false;
    }
    return options.includeCodeBlock !== false || codeLanguageSearchEnabled(options);
}

/**
 * 只要有任一种代码块可能进入候选，就需要语言来选择图表渲染与专用缓存。
 * 正文、语言和两个图表开关都关闭时，可省掉围栏查询。
 */
export function codeBlockLanguagesNeeded(options: CodeBlockLanguageFlags): boolean {
    return options.includeCodeBlock !== false ||
        codeLanguageSearchEnabled(options) ||
        options.includeMermaid !== false ||
        options.includeFlowchart !== false;
}
