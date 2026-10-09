import {DIAGRAM_SUBTYPES} from "../renderer-adapters";

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
        "pointer-events:none",
        "opacity:1",
        "z-index:-1",
    ].join(";");
    const protyle = document.createElement("div");
    protyle.className = "protyle";
    protyle.setAttribute("data-page-search-offscreen", "1");
    const content = document.createElement("div");
    content.className = "protyle-content";
    const wysiwyg = document.createElement("div");
    wysiwyg.className = "protyle-wysiwyg";
    wysiwyg.setAttribute("contenteditable", "false");
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

function widenDiagrams(root: ParentNode): void {
    const selector = DIAGRAM_SUBTYPES.map((subtype) => `[data-subtype="${subtype}"]`).join(",");
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        el.style.width = `${OFFSCREEN_WIDTH_PX}px`;
        el.style.maxWidth = "none";
    });
}

function hasDiagramOutput(node: Element): boolean {
    return Array.from(node.querySelectorAll("svg, canvas, img, .ft__error")).some((output) => {
        // renderer 会先插入带 SVG 图标的 .protyle-icons；它不是图表输出，不能据此提前结束等待。
        return !output.closest(".protyle-icons, .protyle-attr");
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
): Promise<void> {
    if (mode === "none" || !shouldContinue()) {
        return;
    }
    if (mode === "diagram") {
        widenDiagrams(wysiwyg);
    }
    callRenders(wysiwyg, mode);
    const hasDiagram = mode === "diagram" && DIAGRAM_SUBTYPES.some((subtype) => {
        return Boolean(wysiwyg.querySelector(`[data-subtype="${subtype}"]`));
    });
    const hasHtml = Boolean(wysiwyg.querySelector("[data-type='NodeHTMLBlock'], protyle-html"));
    const hasMath = Boolean(wysiwyg.querySelector('[data-subtype="math"], [data-type="NodeMathBlock"]'));
    const timeout = hasDiagram ? 6000 : ((hasMath || hasHtml) ? 4000 : 0);
    if (timeout > 0) {
        await waitForRender(wysiwyg, timeout, {
            math: hasMath,
            html: mode === "light" && hasHtml,
            diagram: hasDiagram,
        }, shouldContinue);
    }
}
