import type {Protyle} from "siyuan";
import {fetchSyncPost} from "siyuan";

export type ReplaceCommitState = "pending" | "confirmed" | "failed" | "unknown";

export interface CommitUpdate {
    id: string;
    oldHTML: string;
    newHTML: string;
    appliedCount: number;
}

export interface CommitObserver {
    onCommitStateChange?: (state: ReplaceCommitState) => void;
}

const COMMIT_WAIT_MS = 8000;
const COMMIT_BATCH_SIZE = 64;

function notify(observer: CommitObserver, state: ReplaceCommitState): void {
    try {
        observer.onCommitStateChange?.(state);
    } catch {
        // A notification must never affect a transaction or its confirmation.
    }
}

/** Use the editor's serializer: rendered UI and persisted content have different HTML. */
export function createCommitContentReader(protyle: Protyle): (html: string) => string | undefined {
    const lute = protyle.protyle?.lute;
    return (html) => {
        if (!lute?.BlockDOM2Md) return html;
        try {
            const template = document.createElement("template");
            template.innerHTML = html;
            // The kernel changes timestamps and adds folded-heading context on render.
            template.content.querySelectorAll("[data-node-id]").forEach((element) => {
                element.removeAttribute("updated");
                element.removeAttribute("parent-heading");
                if (element.getAttribute("data-type") === "NodeTable" && element.getAttribute("colgroup") === "") {
                    element.removeAttribute("colgroup");
                }
            });
            // Rendering adds a colgroup even when no column widths have been saved.
            template.content.querySelectorAll("colgroup").forEach((element) => {
                if (
                    element.attributes.length === 0 &&
                    Array.from(element.children).every((child) =>
                        child.tagName === "COL" && child.attributes.length === 0
                    )
                ) {
                    element.remove();
                }
            });
            const markdown = lute.BlockDOM2Md(template.innerHTML);
            return markdown || undefined;
        } catch {
            // Failure to read content is not evidence that the write succeeded.
            return undefined;
        }
    };
}

/** Parent updates precede child updates in the same transaction. Compare the final tree. */
async function finalUpdateHtml(updates: readonly CommitUpdate[]): Promise<Map<string, string>> {
    if (updates.length === 1) return new Map([[updates[0].id, updates[0].newHTML]]);
    const finalHtml = new Map<string, string>();
    const yieldWork = contentWorkYield();
    for (let index = updates.length - 1; index >= 0; index -= 1) {
        const update = updates[index];
        const template = document.createElement("template");
        template.innerHTML = update.newHTML;
        const root = template.content.firstElementChild;
        root?.querySelectorAll("[data-node-id]").forEach((element) => {
            if (!root.contains(element)) return;
            const childHtml = finalHtml.get(element.getAttribute("data-node-id") ?? "");
            if (!childHtml) return;
            const child = document.createElement("template");
            child.innerHTML = childHtml;
            element.replaceWith(child.content);
        });
        finalHtml.set(update.id, template.innerHTML);
        const pause = yieldWork();
        if (pause) await pause;
    }
    return finalHtml;
}

/** Keep large replace-all verification from monopolizing the editor's main thread. */
function contentWorkYield(): () => Promise<void> | undefined {
    let started = Date.now();
    return () => {
        if (Date.now() - started < 8) return undefined;
        return new Promise((resolve) =>
            window.setTimeout(() => {
                started = Date.now();
                resolve();
            }, 0)
        );
    };
}

/**
 * Public Protyle methods return void after enqueueing, and the queue hides failures.
 * Even /api/transactions code 0 does not prove that every kernel operation committed.
 * Read all affected blocks, with bounded polling and no retry of the write itself.
 */
export async function confirmBlockUpdates(
    protyle: Protyle,
    updates: readonly CommitUpdate[],
    observer: CommitObserver,
): Promise<{commitState: ReplaceCommitState; replacedCount: number; submittedCount: number;}> {
    const readContent = createCommitContentReader(protyle);
    // Encrypted notebooks require an explicit notebook scope; keep the submission's scope.
    const notebook = protyle.protyle?.notebookId;
    const pending = new Map<string, {update: CommitUpdate; expected?: string; lastHtml?: string;}>();
    const submittedCount = updates.reduce((count, update) => count + update.appliedCount, 0);
    let replacedCount = 0;
    // Fast commits need only their completion message; slower queues show pending explicitly.
    const pendingMessage = window.setTimeout(() => notify(observer, "pending"), 500);
    try {
        const finalHtml = await finalUpdateHtml(updates);
        const yieldWork = contentWorkYield();
        for (const update of updates) {
            pending.set(update.id, {update, expected: readContent(finalHtml.get(update.id) ?? update.newHTML)});
            const pause = yieldWork();
            if (pause) await pause;
        }
        const deadline = Date.now() + COMMIT_WAIT_MS;
        let delay = 120;
        while (pending.size && Date.now() < deadline) {
            const ids = Array.from(pending.keys());
            for (let index = 0; index < ids.length && Date.now() < deadline; index += COMMIT_BATCH_SIZE) {
                const batch = ids.slice(index, index + COMMIT_BATCH_SIZE);
                const remaining = deadline - Date.now();
                let timeout: number | undefined;
                // fetchSyncPost has no cancellation option. A hung read ends this wait;
                // do not create overlapping requests while the original is unresolved.
                const response = await Promise.race([
                    Promise.resolve().then(() =>
                        fetchSyncPost("/api/block/getBlockDOMs", notebook ? {ids: batch, notebook} : {ids: batch})
                    )
                        .catch((): undefined => undefined),
                    new Promise<undefined>((resolve) => {
                        timeout = window.setTimeout(() => resolve(undefined), remaining);
                    }),
                ]).finally(() => window.clearTimeout(timeout));
                if (response?.code !== 0 || !response.data || typeof response.data !== "object") continue;
                const data = response.data as Record<string, unknown>;
                for (const id of batch) {
                    const item = pending.get(id);
                    const html = data[id];
                    if (!item || typeof html !== "string" || !html || html === item.lastHtml) continue;
                    item.lastHtml = html;
                    if (item.expected !== undefined && readContent(html) === item.expected) {
                        replacedCount += item.update.appliedCount;
                        pending.delete(id);
                    }
                    const pause = yieldWork();
                    if (pause) await pause;
                }
            }
            if (!pending.size || Date.now() >= deadline) break;
            await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(delay, deadline - Date.now())));
            delay = Math.min(delay * 2, 1000);
        }
    } finally {
        window.clearTimeout(pendingMessage);
    }
    const commitState = pending.size ? "unknown" : "confirmed";
    notify(observer, commitState);
    return {commitState, replacedCount, submittedCount};
}
