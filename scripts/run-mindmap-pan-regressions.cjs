// Exercise navigation against SiYuan's actual activation/wheel handlers; never opens a notebook.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const {JSDOM} = require("../../analysis/node_modules/jsdom");
const {window} = new JSDOM("<!doctype html><body><input id='search'></body>", {pretendToBeVisual: true});
for (const key of ["Node", "Element", "HTMLElement", "Range", "WheelEvent", "MouseEvent", "FocusEvent"]) {
    global[key] = window[key];
}
Object.assign(global, {window, document: window.document});
const compile = code => ts.transpileModule(code, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const nativePath = process.env.SIYUAN_MINDMAP_VIEW_PATH || path.resolve(__dirname,
    "../../tmp/v388-v389-analysis/v3.8.9-app__src__protyle__render__listMindmap__view.ts");
const nativeText = fs.readFileSync(nativePath, "utf8");
const nativeFile = ts.createSourceFile(nativePath, nativeText, ts.ScriptTarget.Latest, true);
const nativeClass = nativeFile.statements.find(node => ts.isClassDeclaration(node) && node.name.text === "ListMindmapView");
const member = name => {
    const found = nativeClass.members.find(node => node.name?.getText(nativeFile) === name);
    assert.ok(found, "native contract: " + name);
    return found.getText(nativeFile);
};
const constructor = nativeClass.members.find(ts.isConstructorDeclaration);
const binding = pattern => {
    const found = constructor.body.statements.find(node => pattern.test(node.getText(nativeFile)));
    assert.ok(found, "native event binding: " + pattern);
    return found.getText(nativeFile);
};
// Keep native handlers intact. Only canvas/layout work and irrelevant UI panels are stubbed.
const FixtureView = new Function("document", "Node", "Element", "WheelEvent", compile(`
class FixtureView {
    buttons = new Map(); inspector = {hidden: true}; interactionActive = false;
    locked = false; offsetX = 0; offsetY = 0; scale = .75; draws = 0;
    constructor(options, viewport) {
        this.options = options; this.viewport = viewport;
        ${binding(/^this\.listen\(options\.host, "click", this\.activatePointer/)}
        ${binding(/^this\.listen\(options\.host, "click", \(event: MouseEvent\)/)}
        ${binding(/^this\.listen\(options\.host, "focusout", \(event: FocusEvent\)/)}
        ${binding(/^this\.listen\(this\.viewport, "wheel", this\.wheel/)}
    }
    listen(target, type, callback, options) {target.addEventListener(type, callback, options);}
    closeInspectorPanel() {} cancelPointer() {} setPanning() {} updateSelection() {}
    queueInspectorLayout() {throw new Error("search must not request inspector focus/layout");}
    zoomAt() {throw new Error("search must not zoom");}
    boundedPan(x, y) {return {x, y};}
    draw() {this.draws++; this.options.host.dataset.pan = this.offsetX + ',' + this.offsetY;}
    ${member("activatePointer")}
    ${member("setInteractionActive")}
    ${member("isTemporaryPan")}
    ${member("wheel")}
}
return FixtureView;`))(document, Node, Element, WheelEvent);
const panModule = {exports: {}};
new Function("module", "exports", compile(fs.readFileSync(path.resolve(__dirname,
    "../src/frontend/mindmap-pan.ts"), "utf8")))(panModule, panModule.exports);
const {panMindmapIntoView} = panModule.exports;
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const search = document.getElementById("search");
search.focus(); search.setSelectionRange(0, 0);
let pointerEvents = 0;
document.addEventListener("pointerdown", () => pointerEvents++, true);
function fixture({parent = document.body, viewportRect = () => rect(0, 0, 400, 300), cssScale = 1} = {}) {
    const host = document.createElement("div"); host.className = "mindmap-view";
    host.innerHTML = '<div class="mindmap-view__viewport"><div class="mindmap-view__world"><div class="mindmap-view__node"><div class="mindmap-view__content">needle needle</div></div></div></div>';
    parent.append(host);
    const viewport = host.firstElementChild;
    viewport.getBoundingClientRect = viewportRect;
    Object.defineProperties(viewport, {
        offsetWidth: {get: () => viewportRect().width / cssScale},
        offsetHeight: {get: () => viewportRect().height / cssScale},
    });
    const view = new FixtureView({host}, viewport);
    host.scrollIntoView = () => {};
    const node = host.querySelector(".mindmap-view__node");
    const content = node.firstElementChild;
    const range = document.createRange(); range.setStart(content.firstChild, 0); range.setEnd(content.firstChild, 6);
    return {host, viewport, view, node, content, range, cssScale};
}
function visible(range, viewport) {
    const target = range.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    assert.ok(target.left >= bounds.left && target.right <= bounds.right &&
        target.top >= bounds.top && target.bottom <= bounds.bottom, JSON.stringify({target, bounds}));
}
// Inactive wheel really is ignored by the native handler, reproducing the reported failure.
const map = fixture();
let targetX = 800, targetY = 600;
map.range.getBoundingClientRect = () => rect(targetX + map.view.offsetX, targetY + map.view.offsetY, 60, 20);
map.viewport.dispatchEvent(new WheelEvent("wheel", {deltaX: 100, deltaY: 100}));
assert.equal(map.view.draws, 0);
panMindmapIntoView(map.range);
visible(map.range, map.viewport);
assert.equal(map.view.interactionActive, false, "temporary activation is restored");
assert.equal(map.host.classList.contains("mindmap-view--active"), false);
assert.equal(document.activeElement, search, "search input retains focus");
assert.equal(map.view.scale, .75);
const draws = map.view.draws;
panMindmapIntoView(map.range);
assert.equal(map.view.draws, draws, "already-visible hit needs no redraw or activation");
targetX = -600; targetY = -500;
panMindmapIntoView(map.range); visible(map.range, map.viewport);
map.view.setInteractionActive(true);
targetX = 1500; targetY = 1200;
panMindmapIntoView(map.range); visible(map.range, map.viewport);
assert.equal(map.view.interactionActive, true, "original active state is kept");
map.view.locked = true; map.host.classList.add("mindmap-view--locked");
const lockedOffset = [map.view.offsetX, map.view.offsetY];
targetX = 3000; panMindmapIntoView(map.range);
assert.deepEqual([map.view.offsetX, map.view.offsetY], lockedOffset, "lock is never bypassed");
map.host.remove();

// Wheel deltas use local viewport units, including editor zoom / an outer map's scale.
for (const cssScale of [.5, 1.5, 2]) {
    const scaled = fixture({cssScale, viewportRect: () => rect(100, 80, 400 * cssScale, 300 * cssScale)});
    scaled.range.getBoundingClientRect = () => rect(100 + (800 + scaled.view.offsetX) * cssScale,
        80 + (600 + scaled.view.offsetY) * cssScale, 60 * cssScale, 20 * cssScale);
    panMindmapIntoView(scaled.range); visible(scaled.range, scaled.viewport);
    assert.equal(scaled.view.interactionActive, false);
    scaled.host.remove();
}
// Inner panning must finish first: outer panning must use the final keyword position.
const outer = fixture();
const inner = fixture({parent: outer.content, cssScale: .75,
    viewportRect: () => rect(700 + outer.view.offsetX, 500 + outer.view.offsetY, 240, 150)});
inner.range.getBoundingClientRect = () => {
    const viewport = inner.viewport.getBoundingClientRect();
    return rect(viewport.left + (700 + inner.view.offsetX) * .75,
        viewport.top + (500 + inner.view.offsetY) * .75, 45, 15);
};
panMindmapIntoView(inner.range);
visible(inner.range, inner.viewport); visible(inner.range, outer.viewport);
assert.equal(inner.view.interactionActive, false); assert.equal(outer.view.interactionActive, false);
outer.host.remove();

// Folded/detached targets and ordinary text are left to the existing reveal/scroll paths.
const folded = fixture(); folded.node.hidden = true;
folded.range.getBoundingClientRect = () => rect(800, 600, 60, 20);
panMindmapIntoView(folded.range); assert.equal(folded.view.draws, 0);
folded.host.remove(); panMindmapIntoView(folded.range); assert.equal(folded.view.draws, 0);
const ordinary = document.createElement("p"); ordinary.textContent = "needle"; document.body.append(ordinary);
const range = document.createRange(); range.selectNodeContents(ordinary);
panMindmapIntoView(range);
assert.equal(pointerEvents, 0, "navigation never simulates pointerdown or changes block selection");
assert.equal(document.activeElement, search);
console.log("mindmap pan regressions passed (native v3.8.9 handlers)");
