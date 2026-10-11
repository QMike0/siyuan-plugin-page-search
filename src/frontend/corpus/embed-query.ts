import {diagramSourceText} from "../renderer-adapters";
import {postJson} from "./api";

interface EmbedResult {
    block: {id: string; rootID?: string; content: string;};
}

/** Use the same query endpoint as blockRender.ts, not the export DOM expansion.
 * The kernel enforces read-only SQL, result limits and publish/notebook access.
 */
export async function resolveEmbedQuery(
    id: string,
    html: string,
    rootId: string,
    notebookId: string,
    shouldContinue: () => boolean,
    signal?: AbortSignal,
): Promise<string | null> {
    const template = document.createElement("template");
    template.innerHTML = html;
    const owner = template.content.firstElementChild as HTMLElement | null;
    if (
        !owner?.matches('[data-type="NodeBlockQueryEmbed"]') || owner.dataset.nodeId !== id ||
        !owner.hasAttribute("data-content")
    ) return null;
    const stmt = diagramSourceText(owner);
    if (!shouldContinue() || signal?.aborted) return null;
    if (!stmt.trim()) {
        owner.replaceChildren();
        return owner.outerHTML;
    }
    // Custom JS may perform writes. Search never replays it; already mounted
    // results are still searched by the live path.
    if (stmt.startsWith("//!js") || !rootId) return null;
    const custom = owner.getAttribute("custom-heading-mode");
    const configured = window.siyuan?.config?.editor?.headingEmbedMode;
    const headingMode = custom === "0" || custom === "1" || custom === "2" ?
        Number(custom) :
        configured === 1 || configured === 2 ?
        configured :
        0;
    const response = await postJson<{blocks: EmbedResult[];}>("/api/search/searchEmbedBlock", {
        embedBlockID: id,
        stmt,
        headingMode,
        breadcrumb: false,
        excludeIDs: [id, rootId],
        notebook: notebookId,
    }, signal);
    if (!shouldContinue() || signal?.aborted || !Array.isArray(response?.blocks)) return null;
    const children: HTMLElement[] = [];
    for (const entry of response.blocks) {
        const block = entry?.block;
        if (!block || typeof block.id !== "string" || typeof block.content !== "string") return null;
        const wrapper = document.createElement("div");
        wrapper.className = "protyle-wysiwyg__embed";
        wrapper.dataset.id = block.id;
        if (block.rootID) wrapper.dataset.rootId = block.rootID;
        // Keep HTML inert until the normal bounded extraction/rendering path.
        const content = document.createElement("template");
        content.innerHTML = block.content;
        wrapper.append(content.content);
        children.push(wrapper);
    }
    owner.replaceChildren(...children);
    return owner.outerHTML;
}
