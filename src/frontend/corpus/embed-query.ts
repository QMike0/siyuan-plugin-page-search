import {diagramSourceText} from "../renderer-adapters";
import {postJson} from "./api";

interface EmbedResult {
    block: {id: string; rootID?: string; content: string;};
}

interface EmbedFlight {
    controller: AbortController;
    consumers: Set<() => boolean>;
    task: Promise<{blocks: EmbedResult[];} | null>;
}
const flights = new Map<string, EmbedFlight>();

/** A source save can change query results without changing the embed's own hash. */
export function invalidateEmbedQueries(): void {
    // Existing readers still finish their snapshot; the corpus epoch discards it.
    // Turning a save into an API failure would also suppress unrelated plain-text cache writes.
    flights.clear();
}

async function queryEmbed(
    body: {embedBlockID: string; stmt: string; headingMode: number; excludeIDs: string[]; notebook: string;},
    current: () => boolean,
    signal?: AbortSignal,
): Promise<{blocks: EmbedResult[];} | null> {
    const key = JSON.stringify(body);
    let flight = flights.get(key);
    if (flight && !Array.from(flight.consumers).some((consumer) => consumer())) {
        flights.delete(key);
        flight.controller.abort();
        flight = undefined;
    }
    if (!flight) {
        flight = {controller: new AbortController(), consumers: new Set(), task: Promise.resolve(null)};
        const created = flight;
        flights.set(key, created);
        // Register the first consumer before dispatching the shared native query.
        created.task = Promise.resolve().then(() =>
            created.controller.signal.aborted ?
                null :
                postJson<{blocks: EmbedResult[];}>("/api/search/searchEmbedBlock", {
                    ...body,
                    breadcrumb: false,
                }, created.controller.signal)
        ).finally(() => {
            if (flights.get(key) === created) flights.delete(key);
        });
    }
    const owned = flight;
    const consumer = () => current() && !signal?.aborted;
    owned.consumers.add(consumer);
    const release = () => {
        owned.consumers.delete(consumer);
        if (!Array.from(owned.consumers).some((item) => item())) {
            if (flights.get(key) === owned) flights.delete(key);
            owned.controller.abort();
        }
    };
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<null>((resolve) => {
        cancel = () => {
            release();
            resolve(null);
        };
        signal?.addEventListener("abort", cancel, {once: true});
        if (!consumer()) cancel();
    });
    try {
        const result = await Promise.race([owned.task, cancelled]);
        return consumer() && !owned.controller.signal.aborted ? result : null;
    } finally {
        if (cancel) signal?.removeEventListener("abort", cancel);
        release();
    }
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
    const response = await queryEmbed(
        {
            embedBlockID: id,
            stmt,
            headingMode,
            excludeIDs: [id, rootId],
            notebook: notebookId,
        },
        shouldContinue,
        signal,
    );
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
