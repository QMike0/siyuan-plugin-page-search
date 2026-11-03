import {
    collectKatexGlyphTextNodes,
    createRendererElementFilter,
    type CollectSearchableBlocksOptions,
} from "./blocks";
import {createOffscreenHost, offscreenWysiwyg, renderOffscreenBlocks} from "./corpus/offscreen";
import {mathPreviewStamp, needsMathPreview, rememberMathPreview} from "./math-preview-cache";
import {createTabsTitleMathReader} from "./tabs-title";
import {beginTextCollection, isAuthorCssHiddenElement, isHiddenOnlyByInactiveTab, isHiddenOnlyByTabsTitle, omitHiddenMathText} from "./visibility";

/** Native mathRender defers inactive panels. Render only missing formulas in copies.
 * Undefined means no preparation was needed; boolean records whether glyph text changed. */
export async function prepareTabsMath(
    edit: Element,
    options: CollectSearchableBlocksOptions,
    shouldContinue: () => boolean,
    acceptsScope: (element: HTMLElement) => boolean = () => true,
): Promise<boolean | undefined> {
    if (options.searchMathSource || options.includeTabs === false || !shouldContinue()) return;
    beginTextCollection(options.includeFoldedBlocks === true);
    const accepts = createRendererElementFilter(options);
    const titleMath = createTabsTitleMathReader();
    const pending = Array.from(edit.querySelectorAll<HTMLElement>(
        '[data-type="NodeTabs"] span[data-type~="inline-math"][data-content], ' +
        '[data-type="NodeTabs"] [data-type="NodeMathBlock"][data-content]',
    )).filter(element => {
        const title = titleMath(element);
        if (!acceptsScope(title?.source ?? element)) return false;
        if (element.closest(".tabs-header .tabs-tab-label") ? !title : title?.labelMath && accepts(title.labelMath)) return false;
        if (element.querySelector(".katex-html") || !needsMathPreview(element) ||
            !accepts(element)) return false;
        return !isAuthorCssHiddenElement(element) || isHiddenOnlyByInactiveTab(element) || isHiddenOnlyByTabsTitle(element);
    });
    if (!pending.length) return;
    const host = createOffscreenHost();
    const wysiwyg = offscreenWysiwyg(host);
    let changed = false;
    try {
        for (let start = 0; start < pending.length && shouldContinue(); start += 64) {
            if (start > 0) {
                await new Promise<void>(resolve => window.setTimeout(resolve, 0));
                if (!shouldContinue()) return changed;
            }
            const batch = pending.slice(start, start + 64).map(element => ({
                element, stamp: mathPreviewStamp(element), clone: element.cloneNode(true) as HTMLElement,
            }));
            // Do not carry inactive/folded ancestors into the native renderer.
            wysiwyg.replaceChildren(...batch.map(item => item.clone));
            await renderOffscreenBlocks(wysiwyg, "light", shouldContinue);
            if (!shouldContinue()) return changed;
            beginTextCollection(options.includeFoldedBlocks === true);
            let completed = 0;
            for (const {element, stamp, clone} of batch) {
                const rendered = Boolean(clone.querySelector(".katex-html"));
                const text = rendered ? omitHiddenMathText(collectKatexGlyphTextNodes(clone)).map(node => node.data).join("") : undefined;
                rememberMathPreview(element, stamp, text);
                if (rendered) changed = true;
                // Native mathRender completes invalid TeX with data-render + ft__error.
                // A batch of syntax errors says nothing about renderer availability.
                if (rendered || (clone.getAttribute("data-render") === "true" &&
                    (clone.matches(".ft__error") || clone.querySelector(".ft__error")))) completed++;
            }
            // Missing/failed renderer: avoid spending another timeout on every batch.
            if (!completed) break;
        }
    } finally {
        host.remove();
    }
    return changed;
}
