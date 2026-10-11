/**
 * 观察正文 DOM，供搜索栏补回失效的高亮 Range。
 *
 * 思源 3.8.6 里下面这些情况会整段换掉节点，旧 Range 缩成一个空点：
 * - 输入时 SpinBlockDOM 结果与现有 DOM 不同，整块重建（表格整张换掉，行级标记闭合时段落整段换掉）
 * - 撤销 / 重做按快照替换整块。savedoc 在内核重放时就推送，早于发起窗口本地回放 DOM
 * - 打开、关闭表格单元格编辑器（replaceChildren / renderTableCellRich），不产生事务
 * - 代码高亮、公式渲染、块引用锚文本回填、嵌入块渲染、大表虚拟滚动，不产生事务
 *
 * 只看 `.protyle-wysiwyg` 里面的变化。高亮层、选区竖线、搜索面板都挂在外面。
 * 属性只观察 fold 和搜索语义源；块选中、悬停等 class 抖动不会触发。
 */

import {SOURCE_DIAGRAM_SELECTOR} from "./diagram-search-state";

export interface EditorDomChange {
    /** 插入了节点的块 id：插入点的各级祖先块，以及插入节点自身和里面的块。太多时为 null。 */
    addedInBlocks: ReadonlySet<string> | null;
    /** 折叠属性改变；它不一定伴随保存或块节点增删。 */
    foldChanged: boolean;
    /** 搜索来源可能改变的 Mermaid/flowchart；独立限额，不受普通块插入量影响。 */
    diagramBlocks: ReadonlySet<HTMLElement> | null;
    /** 嵌入内容变化的宿主；与新增块数量无关，也覆盖删除和属性文字。 */
    embedBlocks: ReadonlySet<HTMLElement> | null;
}

export interface EditorDomWatchHandlers {
    /** 每批突变同步调用，只做计数。 */
    onMutate: () => void;
    /** 停止变化 debounceMs 后调用一次。 */
    onSettled: (change: EditorDomChange) => void;
    /** 语言/块类型刚被修改时，旧图表身份不能只靠当前属性判断。 */
    knownDiagram?: (element: HTMLElement) => boolean;
}

export const MAX_TOUCHED_BLOCKS = 64;
/** 一直在变时也至少隔这么久核对一次。 */
const MAX_WAIT_MS = 600;

export function watchEditorDom(
    edit: Element,
    handlers: EditorDomWatchHandlers,
    debounceMs = 120,
): () => void {
    let timer: number | undefined;
    let pendingSince = 0;
    let touched: Set<string> | null = new Set();
    let foldChanged = false;
    let diagramBlocks: Set<HTMLElement> | null = new Set();
    let scannedDiagramTrees = new WeakSet<Element>();
    let embedBlocks: Set<HTMLElement> | null = new Set();
    let scannedEmbedTrees = new WeakSet<Element>();

    const noteEmbedTree = (element: Element) => {
        if (!embedBlocks) return;
        const owner = element.closest<HTMLElement>(EMBED_BLOCK_SELECTOR);
        if (owner) embedBlocks.add(owner);
        else if (!scannedEmbedTrees.has(element)) {
            scannedEmbedTrees.add(element);
            for (const embed of element.querySelectorAll<HTMLElement>(EMBED_BLOCK_SELECTOR)) {
                embedBlocks.add(embed);
                if (embedBlocks.size > MAX_TOUCHED_BLOCKS) break;
            }
        }
        if (embedBlocks.size > MAX_TOUCHED_BLOCKS) embedBlocks = null;
    };

    const noteDiagramTree = (element: Element) => {
        if (!diagramBlocks) return;
        if (
            element instanceof HTMLElement &&
            (element.matches(SOURCE_DIAGRAM_SELECTOR) || handlers.knownDiagram?.(element))
        ) {
            diagramBlocks.add(element);
            if (diagramBlocks.size > MAX_TOUCHED_BLOCKS) diagramBlocks = null;
            return;
        }
        if (scannedDiagramTrees.has(element)) return;
        scannedDiagramTrees.add(element);
        for (const diagram of element.querySelectorAll<HTMLElement>(SOURCE_DIAGRAM_SELECTOR)) {
            diagramBlocks.add(diagram);
            if (diagramBlocks.size > MAX_TOUCHED_BLOCKS) break;
        }
        if (diagramBlocks.size > MAX_TOUCHED_BLOCKS) diagramBlocks = null;
    };

    const flush = () => {
        const change: EditorDomChange = {addedInBlocks: touched, foldChanged, diagramBlocks, embedBlocks};
        touched = new Set();
        foldChanged = false;
        diagramBlocks = new Set();
        scannedDiagramTrees = new WeakSet();
        embedBlocks = new Set();
        scannedEmbedTrees = new WeakSet();
        pendingSince = 0;
        handlers.onSettled(change);
    };

    const observer = new MutationObserver((records) => {
        let relevant = false;
        for (const record of records) {
            const target = record.target.nodeType === Node.ELEMENT_NODE ?
                record.target as Element :
                record.target.parentElement;
            if (!target || !target.closest(".protyle-wysiwyg")) {
                continue;
            }
            relevant = true;
            // SVG 子树只记最近的图表块；不在每个路径/标签突变上扫描整张图。
            const code = target.closest<HTMLElement>('[data-type="NodeCodeBlock"]');
            if (!code || !(code.matches(SOURCE_DIAGRAM_SELECTOR) || handlers.knownDiagram?.(code))) {
                if (
                    target.closest(EMBED_BLOCK_SELECTOR) &&
                    !target.closest(".protyle-icons, .protyle-attr, .protyle-cursor")
                ) noteEmbedTree(target);
            }
            if (code && (code.matches(SOURCE_DIAGRAM_SELECTOR) || handlers.knownDiagram?.(code))) {
                if (diagramBlocks) {
                    diagramBlocks.add(code);
                    if (diagramBlocks.size > MAX_TOUCHED_BLOCKS) diagramBlocks = null;
                }
            }
            if (record.type === "attributes") {
                // 思源切换非标题折叠时只改 fold 属性；标题折叠通常还会卸载后代。
                // 这两种变化都不能依赖 savedoc，否则关闭“折叠块内容”时计数会停留旧值。
                if (record.attributeName === "fold") {
                    foldChanged = true;
                }
                if (
                    record.attributeName === "fold" || record.attributeName === "parent-heading" ||
                    record.attributeName === "data-type" || record.attributeName === "data-subtype"
                ) noteDiagramTree(target);
                continue;
            }
            if (record.type === "childList" && !code) {
                for (const nodes of [record.addedNodes, record.removedNodes]) {
                    for (const node of nodes) {
                        if (node instanceof Element) noteDiagramTree(node);
                        if (node instanceof Element) noteEmbedTree(node);
                        if (!diagramBlocks && !embedBlocks) break;
                    }
                    if (!diagramBlocks && !embedBlocks) break;
                }
            }
            if (record.type !== "childList" || record.addedNodes.length === 0) {
                continue;
            }
            if (!touched) {
                continue;
            }
            if (!addTouchedBlockIds(target, record.addedNodes, touched)) {
                touched = null;
            }
        }
        if (!relevant) {
            return;
        }
        handlers.onMutate();
        const now = Date.now();
        if (!pendingSince) {
            pendingSince = now;
        }
        window.clearTimeout(timer);
        timer = window.setTimeout(flush, Math.max(0, Math.min(debounceMs, pendingSince + MAX_WAIT_MS - now)));
    });

    observer.observe(edit, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        // 备注正文和公式源码存在属性而非 Text 中，全部替换快照也必须感知这些变化。
        attributeFilter: [
            "fold",
            "parent-heading",
            "data-type",
            "data-subtype",
            "data-content",
            "data-inline-memo-content",
        ],
    });

    return () => {
        window.clearTimeout(timer);
        observer.disconnect();
    };
}

/**
 * 祖先块要一直记到顶：单元格编辑器里的临时段落 id 不在命中里，命中记在外面的表格上。
 * 顶层块直接插在 `.protyle-wysiwyg` 下，插入点没有块，要看插入节点自身和里面的块。
 * 超过上限返回 false。
 */
const EMBED_BLOCK_SELECTOR = '[data-type="NodeBlockQueryEmbed"]';

function addTouchedBlockIds(target: Element, added: NodeList, into: Set<string>): boolean {
    let block = target.closest("[data-node-id]");
    while (block) {
        const id = block.getAttribute("data-node-id");
        if (id) {
            into.add(id);
        }
        block = block.parentElement?.closest("[data-node-id]") ?? null;
    }
    for (let index = 0; index < added.length; index += 1) {
        const node = added[index];
        if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
        }
        const element = node as Element;
        const ownId = element.getAttribute("data-node-id");
        if (ownId) {
            into.add(ownId);
        }
        const inner = element.querySelectorAll("[data-node-id]");
        for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
            const id = inner[innerIndex].getAttribute("data-node-id");
            if (id) {
                into.add(id);
            }
            if (into.size > MAX_TOUCHED_BLOCKS) {
                return false;
            }
        }
    }
    return into.size <= MAX_TOUCHED_BLOCKS;
}
