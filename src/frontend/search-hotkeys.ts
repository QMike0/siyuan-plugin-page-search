import type {ICommand} from "siyuan";

type Intent = "find" | "replace";

/** Match the live plugin keymap, including disabled and multi-key bindings (SiYuan 3.8.8). */
export function getSearchHotkeyIntent(event: KeyboardEvent, name: string, commands: ICommand[]): Intent | null {
    const keymap = (window as any).siyuan?.config?.keymap?.plugin?.[name];
    for (const [langKey, intent] of [["showSearch", "find"], ["showReplace", "replace"]] as const) {
        const command = commands?.find(item => item.langKey === langKey);
        const item = keymap?.[langKey] ?? (command ? {custom: command.customHotkey ?? command.hotkey} : undefined);
        const keys = item?.bindings ?
            (item.bindings.version === 1 && Array.isArray(item.bindings.keys) ? item.bindings.keys : []) :
            [item?.custom];
        if (keys.some((key: unknown) => typeof key === "string" && matchesHotkey(key, event))) return intent;
    }
    return null;
}

function matchesHotkey(key: string, event: KeyboardEvent): boolean {
    if (!key || event.keyCode === 229) return false;
    const mac = navigator.platform.toUpperCase().includes("MAC");
    // Same non-Mac Ctrl normalization as SiYuan's normalizeShortcutKey.
    if (!mac && key.startsWith("⌃")) {
        if (key === "⌃D") return false;
        key = key.replace("⌘", "").replace("⌃", "⌘")
            .replace("⌘⇧", "⇧⌘").replace("⌘⌥⇧", "⌥⇧⌘").replace("⌘⌥", "⌥⌘");
    }
    const modifiers = key.match(/^[⌃⌥⇧⌘]*/)?.[0] ?? "";
    if (event.ctrlKey !== (mac ? modifiers.includes("⌃") : modifiers.includes("⌘")) ||
        event.metaKey !== (mac && modifiers.includes("⌘")) ||
        event.altKey !== modifiers.includes("⌥") || event.shiftKey !== modifiers.includes("⇧")) return false;
    // The host matches physical key codes, so Shift and keyboard layouts do not change the main key.
    const codes: Record<number, string> = {
        8: "⌫", 9: "⇥", 13: "↩", 19: "Pause", 20: "CapsLock", 27: "Escape", 32: " ", 33: "PageUp", 34: "PageDown",
        35: "End", 36: "Home", 37: "←", 38: "↑", 39: "→", 40: "↓", 45: "Insert", 46: "⌦",
        44: "PrintScreen", 93: "ContextMenu", 106: "*", 107: "+", 109: "-", 110: ".", 111: "/", 144: "NumLock", 145: "ScrollLock",
        186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: String.fromCharCode(92), 221: "]", 222: "'",
    };
    const eventKey = codes[event.keyCode] ??
        ((event.keyCode >= 48 && event.keyCode <= 57) || (event.keyCode >= 65 && event.keyCode <= 90) ? String.fromCharCode(event.keyCode) :
            event.keyCode >= 96 && event.keyCode <= 105 ? String(event.keyCode - 96) :
            event.keyCode >= 112 && event.keyCode <= 135 ? `F${event.keyCode - 111}` : event.key.toUpperCase());
    return key.slice(modifiers.length) === eventKey;
}

function isHidden(element: Element): boolean {
    if (element.closest(".fn__none, [hidden], [inert]")) return true;
    for (let node: Element | null = element; node; node = node.parentElement) {
        const style = (node as HTMLElement).style;
        if (style?.display === "none" || style?.visibility === "hidden") return true;
    }
    return false;
}

/** Only a visible document tab/mobile editor is a supported SearchBar host. No layout reads. */
export function getSearchProtyle(edit: Element): Element | null {
    if (!edit.isConnected || isHidden(edit)) return null;
    const candidates = edit.matches(".protyle") ? [edit] : Array.from(edit.children);
    return candidates.find(child => {
        if (!child.matches(".protyle:not([data-page-search-offscreen])") || isHidden(child)) return false;
        const root = child.querySelector(".protyle-content:not(.fn__none) .protyle-wysiwyg, .protyle-preview:not(.fn__none) .b3-typography");
        return root && !isHidden(root);
    }) ?? null;
}

export function resolveSearchHotkeyHost(target: Element | null): Element | null {
    // Dialogs retain their own shortcuts, even when focus is on a button or the backdrop.
    if (Array.from(document.querySelectorAll(".b3-dialog")).some(dialog =>
        !dialog.closest('[data-dialog-closing="true"]') && !isHidden(dialog))) return null;
    if (target?.closest(".b3-menu, [role=dialog]")) return null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
        !target.closest(".protyle, .highlight-search-result")) return null;
    const fromTarget = target?.closest(".layout-tab-container, #editor");
    if (fromTarget) return getSearchProtyle(fromTarget) ? fromTarget : null;
    // Do not redirect shortcuts in another embedded editor to a background document.
    if (target?.closest(".protyle")) return null;
    const active = document.querySelector(".layout__wnd--active > .layout-tab-container") ??
        document.querySelector("#editor");
    return active && getSearchProtyle(active) ? active : null;
}
