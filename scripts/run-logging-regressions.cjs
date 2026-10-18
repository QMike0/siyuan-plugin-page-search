// Native Setting/store fixtures; no running notebook is modified.
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
for (const name of ["Element", "HTMLElement", "Node", "ShadowRoot", "MutationObserver"]) global[name] = window[name];
window.siyuan = {config: {}};
const messages = [];
class Setting {
    constructor(options) { this.options = options; this.items = []; }
    addItem(item) { this.items.push(item); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (request === "siyuan") return {Plugin: class {}, Setting, showMessage: (...args) => messages.push(args)};
    return originalLoad.call(this, request, parent, main);
};
require.extensions[".scss"] = () => {};
require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(
    fs.readFileSync(file, "utf8").replace(/import\.meta\.url/g, '"file:///fixture.js"'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, fileName: file},
).outputText, file);
const logger = require(path.join(repo, "src/shared/logger.ts"));
const Plugin = require(path.join(repo, "src/index.ts")).default;
const originalConsole = {debug: console.debug, warn: console.warn, error: console.error};
const logs = [];
for (const level of Object.keys(originalConsole)) console[level] = (...args) => logs.push({level, args});
const change = (input, checked) => { input.checked = checked; input.dispatchEvent(new window.Event("change")); };
const microtask = async () => { await Promise.resolve(); await Promise.resolve(); };

async function main() {
    logger.logDebug("hidden");
    assert.equal(logs.length, 0, "debug defaults to off");
    logger.logWarning("warning");
    logger.logError("error");
    assert.deepEqual(logs.map(log => log.level), ["warn", "error"]);
    logger.setDebugLogging(true);
    logger.logDebug("summary", {matches: 1775});
    assert.equal(logs.at(-1).args[0], "[page-search] summary");
    console.debug = () => { throw new Error("console hook"); };
    assert.doesNotThrow(() => logger.logDebug("safe"));
    console.debug = (...args) => logs.push({level: "debug", args});
    assert.equal(logger.errorDetails(new Error("x".repeat(1000))).message.length, 300);

    const plugin = new Plugin();
    plugin.i18n = require(path.join(repo, "src/i18n/zh-CN.json"));
    let finishRead;
    plugin.loadData = () => new Promise(resolve => { finishRead = resolve; });
    const writes = [];
    plugin.saveData = async (name, data) => { writes.push({name, data}); return {code: 0}; };
    logger.setDebugLogging(false);
    plugin.loggingSettingsReady = plugin.loadLoggingSettings();
    plugin.setupLoggingSettings();
    assert.equal(plugin.setting.items.length, 1, "one native setting only");
    const item = plugin.setting.items[0];
    let input = item.createActionElement();
    assert.equal(input.disabled, true, "initial read cannot overwrite an early edit");
    finishRead({debug: true});
    await plugin.loggingSettingsReady;
    await microtask();
    assert.equal(input.checked, true);
    assert.equal(logger.isDebugLoggingEnabled(), true);
    plugin.setting.options.confirmCallback();
    await plugin.loggingSettingsWrite;
    assert.equal(writes.length, 0, "opening settings without changes does not write");
    change(input, false);
    plugin.setting.options.confirmCallback();
    assert.equal(logger.isDebugLoggingEnabled(), false);
    await plugin.loggingSettingsWrite;
    assert.deepEqual(writes, [{name: "logging.json", data: {debug: false}}], "search preferences stay untouched");

    let finishSave;
    plugin.saveData = (name, data) => {
        writes.push({name, data});
        return new Promise(resolve => { finishSave = resolve; });
    };
    input = item.createActionElement();
    await microtask();
    change(input, true);
    plugin.setting.options.confirmCallback();
    await microtask();
    input = item.createActionElement();
    await microtask();
    change(input, false);
    plugin.setting.options.confirmCallback();
    await microtask();
    assert.equal(writes.length, 2, "second save waits for the first");
    assert.equal(logger.isDebugLoggingEnabled(), false, "latest switch applies immediately");
    finishSave({code: 0});
    for (let i = 0; i < 6; i++) await microtask();
    assert.equal(writes.length, 3);
    assert.equal(writes.at(-1).data.debug, false);
    finishSave({code: 0});
    await plugin.loggingSettingsWrite;

    plugin.saveData = async () => ({code: -1});
    change(input, true);
    plugin.setting.options.confirmCallback();
    await plugin.loggingSettingsWrite;
    assert.equal(logs.at(-1).level, "error");
    assert.equal(messages.at(-1)[2], "error", "failed save is visible");
    window.siyuan.config.readonly = true;
    plugin.saveData = async () => { throw new Error("must not write"); };
    change(input, false);
    plugin.setting.options.confirmCallback();
    await plugin.loggingSettingsWrite;
    assert.equal(logger.isDebugLoggingEnabled(), false, "readonly still allows session diagnostics");
    window.siyuan.config.readonly = false;
    window.siyuan.isPublish = true;
    plugin.loadData = async () => { throw new Error("must not read private publish data"); };
    const beforePublishLogs = logs.length;
    await plugin.loadLoggingSettings();
    assert.equal(logs.length, beforePublishLogs, "publish never requests private settings");
    window.siyuan.isPublish = false;
    plugin.loadData = () => new Promise(resolve => { finishRead = resolve; });
    plugin.loggingSettingsReady = plugin.loadLoggingSettings();
    plugin.teardownRuntime = () => {};
    plugin.onunload();
    finishRead({debug: true});
    await plugin.loggingSettingsReady;
    assert.equal(logger.isDebugLoggingEnabled(), false, "late load cannot reenable logging after unload");

    const kernelLogs = [];
    const bindings = {};
    let debug = false;
    global.siyuan = {
        plugin: {name: "page-search", version: "test", lifecycle: {}},
        event: {},
        logger: Object.fromEntries(["debug", "info", "warn"].map(level => [level, async (...args) => kernelLogs.push({level, args})])),
        storage: {
            get: async name => ({json: async () => name === "logging.json" ? {debug} : {lastQuery: "private query"}}),
            put: async () => {}, watcher: {add: async () => {}, remove: async () => {}},
        },
        rpc: {bind: async (name, handler) => { bindings[name] = handler; }, unbind: async () => {}},
    };
    require(path.join(repo, "src/kernel.ts"));
    await siyuan.plugin.lifecycle.onload();
    await bindings["prefs.set"]({includeParagraph: false});
    assert.equal(kernelLogs.length, 0, "kernel debug follows the same default-off setting");
    debug = true;
    await siyuan.event.handler({type: "fs-notify", detail: {path: "./logging.json", operation: "WRITE"}});
    await bindings["prefs.set"]({includeParagraph: true});
    assert.equal(kernelLogs.at(-1).level, "debug");
    assert.equal(JSON.stringify(kernelLogs).includes("private query"), false, "preferences are never dumped");
    await siyuan.event.handler({type: "fs-notify", detail: {path: "logging.json", operation: "REMOVE"}});
    assert.equal(logger.isDebugLoggingEnabled(), false);
    await siyuan.plugin.lifecycle.onunload();
}

main().then(() => {
    Object.assign(console, originalConsole);
    console.log("logging: native setting, default-off debug, unconditional warning/error, save ordering/failure, readonly/unload and kernel gating OK");
}).catch(error => {
    Object.assign(console, originalConsole);
    console.error(error);
    process.exitCode = 1;
}).finally(() => dom.window.close());
