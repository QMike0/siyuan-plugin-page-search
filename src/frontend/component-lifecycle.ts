import {containsNodeCrossingShadow} from "./dom-parent";

/**
 * Wnd.moveTab 直接迁移 Protyle，最后一个页签移走后还会移除原 Wnd。
 * 正文观察器不覆盖这些边界。这里只观察祖先的直接 childList，既能发现整窗格
 * 移除，又不会因输入、公式渲染或高亮层内部变化而扫描全文。
 */
export function watchComponentLifecycle(
    edit: Element,
    root: Element,
    handlers: {
        editorOwner: () => Element | null;
        detached: () => void;
        editorMoved: () => void;
    },
): () => void {
    let stopped = false;
    let targets = new Set<Node>();
    const stop = () => {
        stopped = true;
        observer.disconnect();
        targets.clear();
    };
    const observeParents = () => {
        const next = new Set<Node>();
        for (const from of [edit, root.parentNode]) {
            let node: Node | null = from;
            while (node) {
                next.add(node);
                node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
            }
        }
        if (next.size === targets.size && [...next].every((node) => targets.has(node))) return;
        observer.disconnect();
        for (const node of next) observer.observe(node, {childList: true});
        targets = next;
    };
    const observer = new MutationObserver(() => {
        if (stopped) return;
        // 同一批 remove + append 的布局搬迁已经恢复连接，不误判为关闭。
        if (!edit.isConnected || !root.isConnected) {
            stop();
            handlers.detached();
            return;
        }
        const owner = handlers.editorOwner();
        if (owner && !containsNodeCrossingShadow(edit, owner)) handlers.editorMoved();
        if (!stopped) observeParents();
    });
    observeParents();
    return stop;
}
