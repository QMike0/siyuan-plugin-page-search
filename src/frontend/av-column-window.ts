/** v3.8.10 columnVirtualScroll.ts retains complete headers while detaching data
 * cells. Reveal by scrolling that header's column, letting SiYuan mount its own
 * saved cell nodes; never reconstruct cells or disable the native window. */
export function virtualAvColumnMissing(row: HTMLElement | null, columnId: string): boolean {
    return Boolean(row?.closest('.av[data-av-type="table"]') && row.querySelector(":scope > .av__column-spacer") &&
        !row.querySelector(`.av__cell[data-col-id="${CSS.escape(columnId)}"]`));
}

export function revealVirtualAvColumn(row: HTMLElement, columnId: string): void {
    if (!virtualAvColumnMissing(row, columnId)) return;
    const body = row.closest<HTMLElement>(".av__body");
    const header = body?.querySelector<HTMLElement>(".av__row--header");
    const column = header?.querySelector<HTMLElement>(`.av__cell[data-col-id="${CSS.escape(columnId)}"]`);
    const scroll = row.closest<HTMLElement>(".av__scroll");
    if (!body || !header || !column || !scroll || scroll.clientWidth <= 0 || scroll.offsetWidth <= 0) return;
    const viewport = scroll.getBoundingClientRect();
    const scale = viewport.width / scroll.offsetWidth;
    const target = column.getBoundingClientRect();
    if (!Number.isFinite(scale) || scale <= 0 || target.width <= 0) return;
    const sticky = body.classList.contains("av__body--unfreeze") ? null :
        header.querySelector<HTMLElement>(".av__colsticky");
    const left = Math.max(viewport.left + scroll.clientLeft * scale, sticky?.getBoundingClientRect().right ?? -Infinity);
    const right = viewport.left + (scroll.clientLeft + scroll.clientWidth) * scale;
    if (right <= left || (target.left >= left && target.right <= right)) return;
    const next = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth,
        scroll.scrollLeft + (target.left - left) / scale));
    if (Number.isFinite(next) && Math.abs(next - scroll.scrollLeft) > 0.5) scroll.scrollLeft = next;
}
