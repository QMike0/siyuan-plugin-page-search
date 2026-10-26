// Document shortcut routing fixtures; no running notebook is modified.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const repo = path.resolve(__dirname, "..");
const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.document = window.document;
for (const name of ["Element", "HTMLElement", "Node", "MutationObserver"]) global[name] = window[name];
Object.defineProperty(global, "navigator", {value: window.navigator, configurable: true});
let platform = "Win32";
Object.defineProperty(window.navigator, "platform", {get: () => platform});
const created = [];
let readPrefs = async () => ({});
class FakeSearchBar {
    constructor(options) { Object.assign(this, options); created.push(this); this.intents = []; }
    applyHotkeyIntent(intent) { this.intents.push(intent); }
    applyPresetAndSearch(text) { this.presetText = text; }
    applySavedPosition() {}
    resetPanelPosition() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {
        Plugin: class { constructor() { this.name = "page-search"; this.commands = []; } },
        Setting: class {}, getFrontend: () => "desktop", getAllEditor: () => [],
    };
    if (parent?.filename === path.join(repo, "src/index.ts")) {
        if (request === "./frontend/search-bar") return {SearchBar: FakeSearchBar};
        if (request === "./frontend/kernel-client") return {createClientId: () => "test", isKernelRunning: () => false, rpcGetPrefs: () => readPrefs()};
    }
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".scss"] = () => {};
require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(
    fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, fileName: file},
).outputText, file);
const Plugin = require(path.join(repo, "src/index.ts")).default;
const {getSearchHotkeyIntent, resolveSearchHotkeyHost} = require(path.join(repo, "src/frontend/search-hotkeys.ts"));
const plugin = new Plugin();
plugin.commands = [{langKey: "showSearch", hotkey: "⌘F", customHotkey: "⌘F"},
    {langKey: "showReplace", hotkey: "⌘H", customHotkey: "⌘H"}];
const calls = [];
plugin.addSearchElement = options => { calls.push(options); };
window.addEventListener("keydown", plugin.onWindowKeydownCapture, true);
const editor = id => '<div id="' + id + '" class="layout-tab-container"><div class="protyle">' +
    '<div class="protyle-content"><div class="protyle-wysiwyg" contenteditable="true">' +
    '<p>text</p><table><tr><td><div class="table__cell-editor"><div class="protyle">' +
    '<textarea></textarea></div></div></td></tr></table><div class="av"><input></div>' +
    '</div></div><button class="toolbar">toolbar</button></div></div>';
function fixture() {
    document.body.innerHTML = '<div class="layout__wnd layout__wnd--active">' + editor("doc") + '</div>' +
        '<button id="tree">tree</button><input id="foreign"><div contenteditable="true" id="external"><span>text</span></div>';
    window.siyuan = {config: {keymap: {plugin: {}}}};
    platform = "Win32";
    calls.length = 0;
    return document.getElementById("doc");
}
function press(target, extra = {}, intercepted = true) {
    const event = new window.KeyboardEvent("keydown", {key: "f", keyCode: 70, ctrlKey: true,
        bubbles: true, cancelable: true, ...extra});
    const count = calls.length;
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, intercepted, "shortcut consumption: " + target.outerHTML?.slice(0, 75));
    assert.equal(calls.length - count, intercepted && !extra.repeat ? 1 : 0, "one open per shortcut");
    return event;
}
async function main() {
    let edit = fixture();
    for (const target of [document.body, document.getElementById("tree"), edit.querySelector("p"),
        edit.querySelector("td"), edit.querySelector("textarea"), edit.querySelector(".av input"), edit.querySelector(".toolbar")]) {
        press(target);
        assert.equal(calls.at(-1).target, edit);
        press(target, {key: "h", keyCode: 72});
        assert.equal(calls.at(-1).intent, "replace");
    }
    let reachedCell = false;
    edit.querySelector("td").addEventListener("keydown", event => { reachedCell = true; event.stopPropagation(); });
    press(edit.querySelector("textarea"));
    assert.equal(reachedCell, false, "capture precedes rich-cell event forwarding");
    let nativeCalls = 0;
    const nativeWindowHandler = () => { nativeCalls++; };
    window.addEventListener("keydown", nativeWindowHandler);
    press(window);
    assert.equal(nativeCalls, 0, "window-target events must not run the native command a second time");
    window.removeEventListener("keydown", nativeWindowHandler);
    press(document.body, {repeat: true});
    for (const extra of [{shiftKey: true}, {altKey: true}, {metaKey: true}, {ctrlKey: false}, {isComposing: true}, {keyCode: 229}]) {
        press(document.body, extra, false);
    }
    const prevented = new window.KeyboardEvent("keydown", {key: "f", keyCode: 70, ctrlKey: true, bubbles: true, cancelable: true});
    prevented.preventDefault();
    const before = calls.length;
    document.body.dispatchEvent(prevented);
    assert.equal(calls.length, before);
    for (const target of [document.querySelector("#foreign"), document.querySelector("#external span")]) press(target, {}, false);
    const panel = document.createElement("div");
    panel.className = "highlight-search-result";
    panel.innerHTML = "<input>";
    edit.append(panel);
    press(panel.firstChild, {}, false);
    panel.remove();

    const dialog = document.createElement("div");
    dialog.innerHTML = '<div class="b3-dialog"><div role="dialog"><button>settings</button><input></div></div>';
    document.body.append(dialog);
    for (const target of [document.body, dialog.querySelector("button"), dialog.querySelector("input"), edit.querySelector("p")]) {
        press(target, {}, false);
    }
    dialog.dataset.dialogClosing = "true";
    press(document.body);
    dialog.removeAttribute("data-dialog-closing");
    dialog.classList.add("fn__none");
    press(document.body);
    dialog.remove();
    const menu = document.createElement("div");
    menu.className = "b3-menu";
    document.body.append(menu);
    press(menu, {}, false);
    menu.remove();

    edit.querySelector(".protyle").classList.add("fn__none");
    press(document.body, {}, false);
    edit.querySelector(".protyle").classList.remove("fn__none");
    edit.querySelector(".protyle-wysiwyg").dataset.readonly = "true";
    press(document.body);
    edit.querySelector(".protyle-content").classList.add("fn__none");
    edit.querySelector(".protyle").insertAdjacentHTML("beforeend", '<div class="protyle-preview"><div class="b3-typography">preview</div></div>');
    press(document.body);
    const pane = document.createElement("div");
    pane.className = "layout__wnd";
    pane.innerHTML = editor("second");
    document.body.append(pane);
    press(pane.querySelector("p"));
    assert.equal(calls.at(-1).target.id, "second", "actual event document wins in a split");
    pane.querySelector(".protyle").classList.add("fn__none");
    press(pane.querySelector(".layout-tab-container"), {}, false);
    edit.innerHTML = '<div class="search__header">global search</div>';
    press(document.body, {}, false);
    edit = fixture();
    const mobile = document.createElement("div");
    mobile.id = "editor";
    mobile.innerHTML = edit.innerHTML;
    document.body.replaceChildren(mobile);
    press(mobile.querySelector("p"));
    assert.equal(calls.at(-1).target, mobile);
    mobile.innerHTML = mobile.firstElementChild.innerHTML;
    mobile.classList.add("protyle");
    press(mobile.querySelector("p"));
    assert.equal(calls.at(-1).target, mobile, "native mobile Protyle is the editor element itself");
    mobile.classList.add("fn__none");
    press(document.body, {}, false);

    edit = fixture();
    const config = window.siyuan.config.keymap.plugin;
    config[plugin.name] = {showSearch: {custom: "⇧⌘K"}, showReplace: {custom: ""}};
    press(document.body, {}, false);
    press(document.body, {key: "h", keyCode: 72}, false);
    press(document.body, {key: "K", keyCode: 75, shiftKey: true});
    config[plugin.name].showSearch = {bindings: {version: 1, keys: ["⌘F", "F8"]}};
    press(document.body);
    press(document.body, {key: "F8", keyCode: 119, ctrlKey: false});
    config[plugin.name].showSearch.bindings.keys = [];
    press(document.body, {}, false);
    config[plugin.name].showSearch = {bindings: {version: 2, keys: ["⌘F"]}, custom: "⌘F"};
    press(document.body, {}, false);
    delete config[plugin.name];
    platform = "MacIntel";
    press(document.body, {}, false);
    press(document.body, {ctrlKey: false, metaKey: true});
    press(document.body, {metaKey: true}, false);
    platform = "Win32";
    config[plugin.name] = {showSearch: {custom: "⌥⇧⌘;"}};
    press(document.body, {key: ":", keyCode: 186, altKey: true, shiftKey: true});
    config[plugin.name].showSearch.custom = "⌃⇧K";
    press(document.body, {key: "K", keyCode: 75, shiftKey: true});
    const originalQuery = document.querySelector;
    document.querySelector = () => { throw new Error("unrelated keystroke must not scan DOM"); };
    assert.equal(getSearchHotkeyIntent(new window.KeyboardEvent("keydown", {key: "a", keyCode: 65}), plugin.name, plugin.commands), null);
    document.querySelector = originalQuery;

    // Real opening path: stale async requests must not focus another tab or a background editor.
    window.removeEventListener("keydown", plugin.onWindowKeydownCapture, true);
    const opening = new Plugin();
    opening.cleanupInvalidComponents = () => {};
    opening.getSearchI18n = () => ({});
    let finish;
    readPrefs = () => new Promise(resolve => { finish = resolve; });
    for (const change of ["dialog", "hidden", "detach", "switch", "pane", "unload"]) {
        edit = fixture();
        created.length = 0;
        const pending = opening.addSearchElement({target: edit, intent: "replace"});
        if (change === "dialog") document.body.insertAdjacentHTML("beforeend", '<div class="b3-dialog">settings</div>');
        if (change === "hidden") edit.classList.add("fn__none");
        if (change === "detach") edit.remove();
        if (change === "switch") edit.innerHTML = editor("new");
        if (change === "pane") edit.parentElement.classList.remove("layout__wnd--active");
        if (change === "unload") {
            opening.eventBus = {off() {}};
            opening.closeSearchDialog = () => {};
            opening.stopCleanupTimer = () => {};
            opening.teardownRuntime();
        }
        finish({});
        await pending;
        assert.equal(created.length, 0, "cancel stale open: " + change);
    }
    edit = fixture();
    created.length = 0;
    const find = opening.addSearchElement({target: edit, intent: "find"});
    const finishFind = finish;
    const replace = opening.addSearchElement({target: edit, intent: "replace"});
    finish({});
    await replace;
    finishFind({});
    await find;
    assert.equal(created.length, 1, "latest opening wins");
    assert.equal(created[0].replaceVisible, true);
    readPrefs = async () => ({});
    await opening.addSearchElement({target: edit, intent: "find"});
    assert.equal(created.length, 1, "existing panel is reused");
    assert.deepEqual(created[0].intents, ["find"]);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#external span"));
    window.getSelection().addRange(range);
    assert.equal(opening.getSelectedText(edit), "", "foreign selection is not used as the query");
    range.selectNodeContents(edit.querySelector("p"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    assert.equal(opening.getSelectedText(edit), "text");
    assert.equal(resolveSearchHotkeyHost(edit), edit);
    // Native command callbacks use the same guarded path and the editor supplied by SiYuan.
    const registered = new Plugin();
    registered.loadLoggingSettings = async () => {};
    registered.setupLoggingSettings = () => {};
    registered.bindSearchHistory = () => {};
    registered.addIcons = () => {};
    registered.cleanupInvalidComponents = () => {};
    registered.getSearchI18n = () => ({});
    registered.eventBus = {on() {}, off() {}};
    registered.addCommand = command => registered.commands.push(command);
    const history = require(path.join(repo, "src/frontend/search-history.ts")).searchHistory;
    const savedHistoryLoad = history.load;
    history.load = () => {};
    registered.onload();
    history.load = savedHistoryLoad;
    const search = registered.commands.find(command => command.langKey === "showSearch");
    const replacement = registered.commands.find(command => command.langKey === "showReplace");
    const secondPane = document.createElement("div");
    secondPane.className = "layout__wnd";
    secondPane.innerHTML = editor("command-doc");
    document.body.append(secondPane);
    created.length = 0;
    search.editorCallback({element: secondPane.querySelector(".protyle")});
    await Promise.resolve();
    assert.equal(created[0].edit.id, "command-doc");
    created.length = 0;
    document.body.insertAdjacentHTML("beforeend", '<div class="b3-dialog"><button>settings</button></div>');
    for (const command of [search, replacement]) {
        command.callback();
        command.editorCallback({element: edit.querySelector(".protyle")});
        command.dockCallback(document.body);
        command.fileTreeCallback({});
    }
    await Promise.resolve();
    assert.equal(created.length, 0, "native callbacks cannot bypass a settings dialog");
    window.removeEventListener("keydown", registered.onWindowKeydownCapture, true);
    console.log("Search shortcuts: document/table/AV/readonly/preview/splits/mobile, modal and foreign-input guards, live keymaps/platforms, one-shot routing and stale async opens OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
