/** Text from detached native rendering; never keep cloned DOM or edit a formula. */
interface MathPreviewStamp {source: string | null; macros: string | undefined;}
const previews = new WeakMap<HTMLElement, {stamp: MathPreviewStamp; text?: string; retryAfter: number;}>();

function mathMacros(): string | undefined {
    return (window as Window & {siyuan?: {config?: {editor?: {katexMacros?: string;};};};})
        .siyuan?.config?.editor?.katexMacros;
}

export function mathPreviewStamp(element: HTMLElement): MathPreviewStamp {
    return {source: element.getAttribute("data-content"), macros: mathMacros()};
}

function stampMatches(element: HTMLElement, stamp: MathPreviewStamp): boolean {
    return stamp.source === element.getAttribute("data-content") && stamp.macros === mathMacros();
}

export function renderedMathPreviewText(element: HTMLElement): string | undefined {
    const entry = previews.get(element);
    return entry && stampMatches(element, entry.stamp) ? entry.text : undefined;
}

export function needsMathPreview(element: HTMLElement): boolean {
    const entry = previews.get(element);
    return !entry || !stampMatches(element, entry.stamp) ||
        (entry.text === undefined && entry.retryAfter <= Date.now());
}

export function rememberMathPreview(element: HTMLElement, stamp: MathPreviewStamp, text?: string): void {
    if (stampMatches(element, stamp)) {
        previews.set(element, {stamp, text, retryAfter: Date.now() + 2000});
    }
}
