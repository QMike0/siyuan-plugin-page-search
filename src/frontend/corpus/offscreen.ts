import {DIAGRAM_SUBTYPES, type DiagramSubtype} from "../renderer-adapters";

const OFFSCREEN_WIDTH_PX = 800;

type RenderMethod =
    | "mathRender"
    | "highlightRender"
    | "mermaidRender"
    | "flowchartRender"
    | "chartRender"
    | "graphvizRender"
    | "abcRender"
    | "mindmapRender"
    | "plantumlRender"
    | "htmlRender";

export type OffscreenRenderMode = "none" | "light" | "diagram";

type ProtyleRenderer = Partial<Record<RenderMethod, (el: Element) => void>>;

const LIGHT_METHODS = ["mathRender", "htmlRender"] as const;
const DIAGRAM_METHODS = [
    "mathRender",
    "mermaidRender",
    "flowchartRender",
    "chartRender",
    "graphvizRender",
    "abcRender",
    "mindmapRender",
    "plantumlRender",
] as const;

export function getProtyleRenderer(): ProtyleRenderer | null {
    const win = window as Window & {Protyle?: ProtyleRenderer;};
    return win.Protyle ?? null;
}

export function createOffscreenHost(): HTMLElement {
    const shell = document.createElement("div");
    shell.className = "page-search-offscreen";
    shell.setAttribute("data-page-search-offscreen", "1");
    shell.style.cssText = [
        "position:fixed",
        `left:-${OFFSCREEN_WIDTH_PX * 2}px`,
        "top:0",
        `width:${OFFSCREEN_WIDTH_PX}px`,
        `min-width:${OFFSCREEN_WIDTH_PX}px`,
        "pointer-events:none",
        "opacity:0",
        "z-index:-1",
    ].join(";");
    const protyle = document.createElement("div");
    protyle.className = "protyle";
    protyle.setAttribute("data-page-search-offscreen", "1");
    // 不继承真实编辑器依靠 flex/容器高度计算出来的尺寸。离屏宿主没有完整的
    // 编辑器面板层级，显式固定这条布局链，避免子节点 clientWidth 偶发为 0。
    protyle.style.cssText = `display:block;width:${OFFSCREEN_WIDTH_PX}px;min-width:${OFFSCREEN_WIDTH_PX}px`;
    const content = document.createElement("div");
    content.className = "protyle-content";
    content.style.cssText =
        `display:block;width:${OFFSCREEN_WIDTH_PX}px;min-width:${OFFSCREEN_WIDTH_PX}px;overflow:visible`;
    const wysiwyg = document.createElement("div");
    wysiwyg.className = "protyle-wysiwyg";
    wysiwyg.setAttribute("contenteditable", "false");
    wysiwyg.style.cssText = `display:block;width:${OFFSCREEN_WIDTH_PX}px;min-width:${OFFSCREEN_WIDTH_PX}px`;
    content.appendChild(wysiwyg);
    protyle.appendChild(content);
    shell.appendChild(protyle);
    document.body.appendChild(shell);
    return shell;
}

export function offscreenWysiwyg(host: HTMLElement): HTMLElement {
    return host.querySelector(".protyle-wysiwyg") as HTMLElement;
}

export function callRenders(host: Element, mode: OffscreenRenderMode = "light"): void {
    if (mode === "none") {
        return;
    }
    const renderer = getProtyleRenderer();
    if (!renderer) {
        return;
    }
    const methods = mode === "diagram" ? DIAGRAM_METHODS : LIGHT_METHODS;
    for (const method of methods) {
        const fn = renderer[method];
        if (typeof fn !== "function") {
            continue;
        }
        try {
            fn(host);
        } catch {
            // 单个渲染器失败时继续抽其余块
        }
    }
}

/**
 * 内核 getBlockDOMs 会为折叠标题下的子块保留 parent-heading 标记。
 * 那是主编辑器延迟插回子树所需的展示状态；离屏宿主永远不会执行展开事务。
 * 图表渲染器在祖先 fold=1 或零宽时只注册“展开后重试”的观察器，因而必须只在
 * 克隆上移除这些状态，并给其首个渲染宿主一个确定宽度。
 */
function prepareOffscreenDiagrams(root: ParentNode, forceRender = false): void {
    const selector = DIAGRAM_SUBTYPES.map((subtype) => `[data-subtype="${subtype}"]`).join(",");
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        let current: HTMLElement | null = el;
        while (current && current !== root) {
            current.removeAttribute("parent-heading");
            current.removeAttribute("fold");
            current = current.parentElement;
        }
        el.style.width = `${OFFSCREEN_WIDTH_PX}px`;
        el.style.minWidth = `${OFFSCREEN_WIDTH_PX}px`;
        el.style.maxWidth = "none";
        // 思源 Mermaid / flowchart 渲染器以 firstElementChild.clientWidth 判断是否
        // 延迟到展开后再画。离屏节点没有正常编辑器的布局上下文，显式给它宽度。
        // Lute 的标准 render-node 至少有一个 <div spin="1">。保守兼容缺失壳的
        // 旧/异常 DOM；只改离屏克隆，不碰编辑器里的真实块。
        let layoutProbe = el.firstElementChild as HTMLElement | null;
        if (!layoutProbe) {
            layoutProbe = document.createElement("div");
            layoutProbe.setAttribute("spin", "1");
            el.prepend(layoutProbe);
        }
        layoutProbe.style.setProperty("display", "block", "important");
        layoutProbe.style.width = `${OFFSCREEN_WIDTH_PX}px`;
        layoutProbe.style.minWidth = `${OFFSCREEN_WIDTH_PX}px`;
        layoutProbe.style.minHeight = "1px";
        // getBlockDOMs 通常给出未渲染 DOM；若某版本带了已完成输出则保留它，
        // 否则强制当前离屏周期触发 renderer，避免沿用无输出的旧标记。
        // live 折叠块可能已经留下半成品 SVG。强制刷新时先清掉旧输出，
        // 否则 waitForRender 会把半成品误认为渲染已完成。
        if (forceRender) {
            el.querySelectorAll("svg, canvas, img, .ft__error").forEach((output) => {
                if (!output.closest(".protyle-icons, .protyle-attr")) {
                    output.remove();
                }
            });
            el.removeAttribute("data-render");
        } else if (!hasDiagramOutput(el)) {
            el.removeAttribute("data-render");
        }
    });
    // Mermaid / flowchart 在异步脚本加载完成后立即读取 firstElementChild.clientWidth。
    // 在调用 renderer 前强制提交以上样式，避免首次布局仍返回 0 后进入永不触发的
    // “等待折叠展开” MutationObserver 分支。
    if (root instanceof HTMLElement) {
        void root.offsetWidth;
    }
}

function hasDiagramOutput(node: Element): boolean {
    return Array.from(node.querySelectorAll("svg, canvas, img, .ft__error")).some((output) => {
        // renderer 会先插入带 SVG 图标的 .protyle-icons；它不是图表输出，不能据此提前结束等待。
        return !output.closest(".protyle-icons, .protyle-attr");
    });
}

const DIAGRAM_RENDER_METHOD_BY_SUBTYPE: Partial<Record<DiagramSubtype, RenderMethod>> = {
    mermaid: "mermaidRender",
    flowchart: "flowchartRender",
    chart: "chartRender",
    graphviz: "graphvizRender",
    abc: "abcRender",
    mindmap: "mindmapRender",
    plantuml: "plantumlRender",
};

function hasPendingDiagramRenderer(root: ParentNode): boolean {
    const renderer = getProtyleRenderer();
    if (!renderer) {
        return false;
    }
    return DIAGRAM_SUBTYPES.some((subtype) => {
        const method = DIAGRAM_RENDER_METHOD_BY_SUBTYPE[subtype];
        if (!method || typeof renderer[method] !== "function") {
            return false;
        }
        return Array.from(root.querySelectorAll(`[data-subtype="${subtype}"]`)).some((node) => {
            return Boolean(node.getAttribute("data-content")) && !hasDiagramOutput(node);
        });
    });
}

export async function waitForRender(
    root: ParentNode,
    timeoutMs: number,
    wait: {math?: boolean; html?: boolean; diagram?: boolean;},
    shouldContinue: () => boolean = () => true,
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!shouldContinue()) {
            return;
        }
        const pendingMath = wait.math &&
            root.querySelector('[data-subtype="math"]:not([data-render="true"])');
        const pendingDiagram = wait.diagram && DIAGRAM_SUBTYPES.some((subtype) => {
            return Array.from(root.querySelectorAll(`[data-subtype="${subtype}"]`)).some((node) => {
                // PlantUML 是 img，Chart 常为 canvas；它们没有可投影的 Text，但也不能
                // 因等待 SVG 每块白耗完整超时。空源码的 ZWSP 壳同样已经完成。
                const content = node.getAttribute("data-content") ?? "";
                return Boolean(content) && !hasDiagramOutput(node);
            });
        });
        const pendingHtml = wait.html &&
            Array.from(root.querySelectorAll("protyle-html, [data-type='NodeHTMLBlock'] protyle-html")).some((node) => {
                const host = node as HTMLElement & {shadowRoot?: ShadowRoot | null;};
                return !host.shadowRoot || !host.shadowRoot.textContent?.trim();
            });
        if (!pendingMath && !pendingDiagram && !pendingHtml) {
            return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
}

/** 公式和 HTML 走 light；图表单独走 diagram，避免一段正文被一张图拖住。 */
export async function renderOffscreenBlocks(
    wysiwyg: HTMLElement,
    mode: OffscreenRenderMode = "light",
    shouldContinue: () => boolean = () => true,
    forceDiagramRender = false,
): Promise<void> {
    if (mode === "none" || !shouldContinue()) {
        return;
    }
    if (mode === "diagram") {
        prepareOffscreenDiagrams(wysiwyg, forceDiagramRender);
    }
    callRenders(wysiwyg, mode);
    const hasDiagram = mode === "diagram" && DIAGRAM_SUBTYPES.some((subtype) => {
        return Boolean(wysiwyg.querySelector(`[data-subtype="${subtype}"]`));
    });
    const pendingDiagramRenderer = hasDiagram && hasPendingDiagramRenderer(wysiwyg);
    const hasHtml = Boolean(wysiwyg.querySelector("[data-type='NodeHTMLBlock'], protyle-html"));
    const hasMath = Boolean(wysiwyg.querySelector('[data-subtype="math"], [data-type="NodeMathBlock"]'));
    // Mermaid / flowchart retain a data-content fallback, so waiting the full CDN
    // timeout only delays the first search when the renderer is unavailable or a
    // folded clone cannot be laid out. Keep a short settle window for normal async
    // rendering while allowing the fallback to return promptly on failure.
    const timeout = pendingDiagramRenderer ? 2500 : ((hasMath || hasHtml) ? 4000 : 0);
    if (timeout > 0) {
        await waitForRender(wysiwyg, timeout, {
            math: hasMath,
            html: mode === "light" && hasHtml,
            diagram: pendingDiagramRenderer,
        }, shouldContinue);
    }
}
