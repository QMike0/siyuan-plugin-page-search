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
global.getComputedStyle = window.getComputedStyle.bind(window);
// SiYuan runs in Chromium, where native positionNodes reflects inert into an attribute.
if (!("inert" in window.HTMLElement.prototype)) Object.defineProperty(window.HTMLElement.prototype, "inert", {
    get() {return this.hasAttribute("inert");},
    set(value) {this.toggleAttribute("inert", Boolean(value));},
});
const nativeFrames = new Map(); let nextNativeFrame = 0;
global.requestAnimationFrame = callback => {nativeFrames.set(++nextNativeFrame, callback); return nextNativeFrame;};
global.cancelAnimationFrame = id => nativeFrames.delete(id);
window.matchMedia = () => ({matches: false});
const compile = code => ts.transpileModule(code, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const nativePanPath = process.env.SIYUAN_MINDMAP_PAN_PATH || path.resolve(__dirname, "../tmp/review-mindmap-pan-native.ts");
const nativePan = {exports: {}};
new Function("module", "exports", compile(fs.readFileSync(nativePanPath, "utf8")))(nativePan, nativePan.exports);
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
const FixtureView = new Function("document", "Node", "Element", "WheelEvent", "clampMindmapPanOffset", "clampMindmapPanPosition", "layoutListMindmapSummaries", compile(`
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
    contentRectangles() {return this.rectangles || [{x:-1e6, y:-1e6, width:2e6, height:2e6}];}
    contentBounds(rects) {return {
        left: Math.min(...rects.map(r => r.x)), top: Math.min(...rects.map(r => r.y)),
        right: Math.max(...rects.map(r => r.x + r.width)), bottom: Math.max(...rects.map(r => r.y + r.height)),
    };}
    draw() {this.draws++; this.options.host.dataset.pan = this.offsetX + ',' + this.offsetY;}
    ${member("activatePointer")}
    ${member("setInteractionActive")}
    ${member("isTemporaryPan")}
    ${member("wheel")}
    ${member("boundedPan")}
    ${member("positionNodes")}
    ${member("animateFold")}
}
return FixtureView;`))(document, Node, Element, WheelEvent,
    nativePan.exports.clampMindmapPanOffset, nativePan.exports.clampMindmapPanPosition, () => new Map());
const panModule = {exports: {}};
new Function("module", "exports", compile(fs.readFileSync(path.resolve(__dirname,
    "../src/frontend/mindmap-pan.ts"), "utf8")))(panModule, panModule.exports);
const {panMindmapIntoView} = panModule.exports;
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const search = document.getElementById("search");
search.value = "needle"; search.focus(); search.setSelectionRange(2, 5);
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
        clientWidth: {get: () => viewportRect().width / cssScale},
        clientHeight: {get: () => viewportRect().height / cssScale},
    });
    const view = new FixtureView({host}, viewport);
    const wheels = [];
    viewport.addEventListener("wheel", event => wheels.push(event));
    host.scrollIntoView = () => {};
    const node = host.querySelector(".mindmap-view__node");
    const content = node.firstElementChild;
    const range = document.createRange(); range.setStart(content.firstChild, 0); range.setEnd(content.firstChild, 6);
    return {host, viewport, view, node, content, range, cssScale, wheels};
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
const nestedClip = document.createElement("div"); nestedClip.style.overflow = "hidden";
nestedClip.getBoundingClientRect = () => rect(100, 80, 200, 120); document.body.append(nestedClip);
const outer = fixture({parent: nestedClip});
const inner = fixture({parent: outer.content, cssScale: .75,
    viewportRect: () => rect(700 + outer.view.offsetX, 500 + outer.view.offsetY, 240, 150)});
inner.range.getBoundingClientRect = () => {
    const viewport = inner.viewport.getBoundingClientRect();
    return rect(viewport.left + (700 + inner.view.offsetX) * .75,
        viewport.top + (500 + inner.view.offsetY) * .75, 45, 15);
};
panMindmapIntoView(inner.range);
visible(inner.range, inner.viewport); visible(inner.range, outer.viewport);
visible(inner.range, nestedClip);
assert.equal(inner.view.interactionActive, false); assert.equal(outer.view.interactionActive, false);
nestedClip.remove();

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

// Diagonal destinations must use native simultaneous pan constraints, not a sequence of single-axis clamps.
const nativeLayoutPath = process.env.SIYUAN_MINDMAP_LAYOUT_PATH || path.resolve(__dirname, "../tmp/review-mindmap-layout-native.ts");
const nativeLayout = {exports: {}};
new Function("module", "exports", compile(fs.readFileSync(nativeLayoutPath, "utf8")))(nativeLayout, nativeLayout.exports);
const leaf = id => ({id, width: 100, height: 40, children: []});
for (const siblings of [5, 10, 20]) {
    const tree = leaf("root");
    tree.children = Array.from({length: siblings}, (_, index) => {
        const branch = leaf("b" + index); let at = branch;
        if (index === siblings - 1) for (let depth = 0; depth < 8; depth++) {
            const child = leaf("b" + index + "d" + depth); at.children.push(child); at = child;
        }
        return branch;
    });
    const nodes = nativeLayout.exports.layoutListMindmap(tree).nodes;
    const natural = fixture(); natural.view.scale = 1; natural.view.rectangles = [...nodes.values()];
    const root = nodes.get("root");
    natural.view.offsetX = 200 - root.x - root.width / 2;
    natural.view.offsetY = 150 - root.y - root.height / 2;
    const target = nodes.get("b" + (siblings - 1) + "d7");
    natural.range.getBoundingClientRect = () => rect(target.x + natural.view.offsetX + 10, target.y + natural.view.offsetY + 10, 60, 20);
    panMindmapIntoView(natural.range); visible(natural.range, natural.viewport);
    assert.equal(natural.wheels.length, 1, "one native draw per view, including diagonal destinations");
    natural.host.remove();
}
const diagonal = fixture(); diagonal.view.scale = 1;
diagonal.view.rectangles = [{x:0,y:0,width:100,height:60}, {x:1000,y:1000,width:100,height:60}];
diagonal.range.getBoundingClientRect = () => rect(1000 + diagonal.view.offsetX, 1000 + diagonal.view.offsetY, 60, 20);
panMindmapIntoView(diagonal.range); visible(diagonal.range, diagonal.viewport);
assert.equal(diagonal.wheels.length, 1); diagonal.host.remove();

// The outer map must reveal in the editor's actual screen region, not merely its full 1200px viewport.
const editor = document.createElement("div"); editor.className = "protyle-content"; editor.style.overflow = "auto";
editor.getBoundingClientRect = () => rect(0, 100, 400, 300); document.body.append(editor);
const tall = fixture({parent: editor, viewportRect: () => rect(0, -350, 400, 1200)});
for (const y of [-250, 750]) {
    tall.range.getBoundingClientRect = () => rect(100, y + tall.view.offsetY, 60, 20);
    panMindmapIntoView(tall.range); visible(tall.range, editor);
}
const tallDraws = tall.view.draws;
panMindmapIntoView(tall.range); assert.equal(tall.view.draws, tallDraws, "visible keyword does not keep redrawing a tall map");
editor.remove();

// Client-area clipping must account for borders, scrollbars and editor CSS scale.
for (const cssScale of [.5, 1, 2]) {
    const clip = document.createElement("div"); clip.style.overflow = "auto";
    clip.getBoundingClientRect = () => rect(60, 50, 440 * cssScale, 260 * cssScale);
    Object.defineProperties(clip, {
        offsetWidth: {value: 440}, offsetHeight: {value: 260},
        clientLeft: {value: 10}, clientTop: {value: 10},
        clientWidth: {value: 400}, clientHeight: {value: 220},
    });
    document.body.append(clip);
    const clipped = fixture({parent: clip, cssScale, viewportRect: () => rect(0, 0, 800 * cssScale, 600 * cssScale)});
    clipped.range.getBoundingClientRect = () => rect((1000 + clipped.view.offsetX) * cssScale,
        (1000 + clipped.view.offsetY) * cssScale, 60 * cssScale, 20 * cssScale);
    panMindmapIntoView(clipped.range);
    visible(clipped.range, {getBoundingClientRect: () => rect(60 + 10 * cssScale, 50 + 10 * cssScale,
        400 * cssScale, 220 * cssScale)});
    const draws = clipped.view.draws;
    panMindmapIntoView(clipped.range); assert.equal(clipped.view.draws, draws);
    clip.remove();
}
const screenDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
Object.defineProperty(window, "visualViewport", {configurable: true,
    value: {offsetLeft: 50, offsetTop: 80, width: 250, height: 180}});
const screenMap = fixture({viewportRect: () => rect(0, 0, 1000, 1200)});
screenMap.range.getBoundingClientRect = () => rect(800 + screenMap.view.offsetX, 900 + screenMap.view.offsetY, 60, 20);
panMindmapIntoView(screenMap.range);
visible(screenMap.range, {getBoundingClientRect: () => rect(50, 80, 250, 180)});
screenMap.host.remove();
if (screenDescriptor) Object.defineProperty(window, "visualViewport", screenDescriptor);
else delete window.visualViewport;

// Match native revealNode's control avoidance, including wrapped toolbar groups and scaled editors.
for (const cssScale of [.5, 1, 2]) {
    const overlay = fixture({cssScale, viewportRect: () => rect(0, 0, 400 * cssScale, 300 * cssScale)});
    const toolbar = document.createElement("div"); toolbar.className = "mindmap-view__toolbar"; toolbar.style.opacity = "1";
    const group = document.createElement("div"); group.className = "mindmap-view__toolbar-group";
    group.getBoundingClientRect = () => rect(280 * cssScale, 0, 120 * cssScale, 40 * cssScale);
    toolbar.append(group); overlay.host.append(toolbar);
    overlay.range.getBoundingClientRect = () => rect(300 * cssScale, (16 + overlay.view.offsetY) * cssScale, 60 * cssScale, 20 * cssScale);
    panMindmapIntoView(overlay.range);
    assert.ok(overlay.range.getBoundingClientRect().top >= group.getBoundingClientRect().bottom,
        "keyword is below a visible toolbar");
    assert.equal(overlay.wheels.length, 1);
    const inspector = document.createElement("div"); inspector.className = "mindmap-view__inspector";
    inspector.getBoundingClientRect = () => rect(280 * cssScale, 240 * cssScale, 120 * cssScale, 60 * cssScale);
    overlay.host.append(inspector); overlay.view.inspector = inspector; overlay.view.setInteractionActive(true);
    overlay.range.getBoundingClientRect = () => rect(300 * cssScale, (270 + overlay.view.offsetY) * cssScale, 60 * cssScale, 20 * cssScale);
    panMindmapIntoView(overlay.range);
    assert.ok(overlay.range.getBoundingClientRect().bottom <= inspector.getBoundingClientRect().top,
        "keyword is above the original active inspector");
    overlay.host.remove();
}
const controls = fixture();
const toolbar = document.createElement("div"); toolbar.className = "mindmap-view__toolbar";
const group = document.createElement("div"); group.className = "mindmap-view__toolbar-group";
group.getBoundingClientRect = () => rect(280, 0, 120, 40); toolbar.append(group); controls.host.append(toolbar);
controls.range.getBoundingClientRect = () => rect(300 + controls.view.offsetX, 16 + controls.view.offsetY, 60, 20);
for (const element of [toolbar, group]) {
    for (const [property, value] of [["opacity", "0"], ["display", "none"], ["visibility", "hidden"]]) {
        element.style[property] = value;
        panMindmapIntoView(controls.range);
        assert.equal(controls.wheels.length, 0, "hidden controls do not move a visible keyword");
        element.style[property] = "";
    }
    element.hidden = true; panMindmapIntoView(controls.range);
    assert.equal(controls.wheels.length, 0); element.hidden = false;
}
group.getBoundingClientRect = () => rect(0, 0, 80, 40);
panMindmapIntoView(controls.range);
assert.equal(controls.wheels.length, 0, "controls beside the keyword do not force vertical movement");
const popup = document.createElement("div"); popup.className = "mindmap-view__zoom-actions";
popup.getBoundingClientRect = () => rect(280, 0, 120, 100); toolbar.append(popup);
panMindmapIntoView(controls.range);
assert.ok(controls.range.getBoundingClientRect().top >= 100, "visible zoom popup is also avoided");
assert.equal(controls.wheels.length, 1); controls.host.remove();

const oversized = fixture();
oversized.range.getBoundingClientRect = () => rect(1000 + oversized.view.offsetX, 1000 + oversized.view.offsetY, 600, 500);
panMindmapIntoView(oversized.range); panMindmapIntoView(oversized.range);
assert.equal(oversized.range.getBoundingClientRect().left, 16);
assert.equal(oversized.range.getBoundingClientRect().top, 16);
assert.equal(oversized.wheels.length, 1, "oversized hit keeps its beginning visible without oscillating");
oversized.host.remove();
const hiddenClip = document.createElement("div"); hiddenClip.style.overflow = "hidden";
hiddenClip.getBoundingClientRect = () => rect(0, 0, 0, 0); document.body.append(hiddenClip);
const hiddenMap = fixture({parent: hiddenClip}); hiddenMap.range.getBoundingClientRect = () => rect(800, 600, 60, 20);
panMindmapIntoView(hiddenMap.range); assert.equal(hiddenMap.wheels.length, 0);
hiddenClip.remove();

// Native wheel finalizes fold animation before applying deltas. Read geometry after that finalization.
function animatedFixture({expanding = true, active = false, cssScale = 1, progress = 0,
    targetId = "child4", initiallyVisible = false, ...options} = {}) {
    const tree = leaf("r"); tree.children = Array.from({length: 5}, (_, index) => leaf("child" + index));
    tree.children[0].children = Array.from({length: 15}, (_, index) => leaf("grand" + index));
    tree.children[0].collapsed = true;
    const collapsed = nativeLayout.exports.layoutListMindmap(tree);
    tree.children[0].collapsed = false;
    const expanded = nativeLayout.exports.layoutListMindmap(tree);
    const previous = expanding ? collapsed : expanded, next = expanding ? expanded : collapsed;
    const animated = fixture({cssScale, viewportRect: () => rect(0, 0, 400 * cssScale, 300 * cssScale), ...options});
    const view = animated.view;
    view.scale = 1; view.positions = next.nodes; view.edges = next.edges;
    view.summaryPositions = new Map(); view.relationRoutes = new Map(); view.nodeElements = new Map();
    const world = animated.viewport.firstElementChild;
    for (const [id] of expanded.nodes) {
        const node = id === targetId ? animated.node : document.createElement("div");
        node.className = "mindmap-view__node"; node.dataset.mindmapId = id;
        if (node.parentElement !== world) world.append(node);
        view.nodeElements.set(id, node);
    }
    view.model = {root: tree, nodes: new Map([...expanded.nodes].map(([id, value]) => [id, {...value}]))};
    Object.defineProperty(view, "rectangles", {get: () => [...view.positions.values()]});
    const offset = initiallyVisible ? 190 - previous.nodes.get(targetId).y : 0;
    view.offsetY = offset + previous.nodes.get("child0").y - next.nodes.get("child0").y;
    animated.range.getBoundingClientRect = () => {
        const position = view.positions.get(targetId), box = animated.viewport.getBoundingClientRect();
        return position && !animated.node.hidden ? rect(box.left + (position.x + view.offsetX + 10) * cssScale,
            box.top + (position.y + view.offsetY + 10) * cssScale, 60 * cssScale, 20 * cssScale) : rect(0, 0, 0, 0);
    };
    view.setInteractionActive(active); view.selectedId = targetId;
    view.animateFold(previous.nodes, previous.edges, {x: 0, y: offset}, new Map());
    if (progress) {
        const frame = [...nativeFrames].at(-1); nativeFrames.delete(frame[0]);
        frame[1](performance.now() + progress);
    }
    return animated;
}
for (const expanding of [true, false]) for (const active of [false, true]) {
    for (const progress of [0, 100]) for (const cssScale of [.5, 1, 2]) {
        for (const initiallyVisible of [false, true]) {
            const animated = animatedFixture({expanding, active, progress, cssScale, initiallyVisible});
            assert.ok(animated.host.querySelector(".mindmap-view__node[inert]"), "actual native animation marker exists");
            if (initiallyVisible && !progress) visible(animated.range, animated.viewport);
            panMindmapIntoView(animated.range);
            assert.equal(animated.view.stopFoldAnimation, undefined, "animation is finalized before target geometry is used");
            visible(animated.range, animated.viewport);
            assert.equal(animated.view.interactionActive, active);
            assert.equal(animated.view.selectedId, "child4");
            assert.equal(animated.view.scale, 1);
            assert.equal(animated.wheels.filter(event => !event.deltaX && !event.deltaY).length, 1);
            assert.ok(animated.wheels.length <= 2, "at most one animation-finalizing event and one joint pan");
            const draws = animated.view.draws, wheels = animated.wheels.length;
            panMindmapIntoView(animated.range);
            assert.equal(animated.view.draws, draws, "stable visible hit has no extra redraw");
            assert.equal(animated.wheels.length, wheels, "stable hit sends no animation probe");
            assert.equal(document.activeElement, search);
            animated.host.remove();
        }
    }
}
const entering = animatedFixture({targetId: "grand14"});
panMindmapIntoView(entering.range); visible(entering.range, entering.viewport);
assert.equal(entering.node.inert, false, "an entering keyword is revealed at its final node position");
entering.host.remove();
const leaving = animatedFixture({targetId: "grand14", expanding: false});
panMindmapIntoView(leaving.range);
assert.equal(leaving.node.hidden, true, "navigation does not reopen a collapsing branch");
assert.equal(leaving.wheels.length, 1); leaving.host.remove();
const lockedAnimation = animatedFixture(); lockedAnimation.host.classList.add("mindmap-view--locked"); lockedAnimation.view.locked = true;
panMindmapIntoView(lockedAnimation.range);
assert.equal(lockedAnimation.wheels.length, 0, "locked animation is not interrupted");
assert.ok(lockedAnimation.view.stopFoldAnimation); lockedAnimation.view.stopFoldAnimation(); lockedAnimation.host.remove();
const detachedAnimation = animatedFixture(); detachedAnimation.host.remove();
panMindmapIntoView(detachedAnimation.range);
assert.equal(detachedAnimation.wheels.length, 0); detachedAnimation.view.stopFoldAnimation();

// Finish only the current layer's animation, with inner navigation complete before the outer layer moves.
for (const animateOuter of [false, true]) {
    const clip = document.createElement("div"); clip.style.overflow = "hidden";
    clip.getBoundingClientRect = () => rect(50, 30, 300, 240); document.body.append(clip);
    const parent = animatedFixture({parent: clip});
    if (!animateOuter) parent.view.stopFoldAnimation();
    const nested = animatedFixture({parent: parent.content, cssScale: .75,
        viewportRect: () => {
            const position = parent.view.positions.get("child4");
            return rect(position.x + parent.view.offsetX, position.y + parent.view.offsetY, 240, 150);
        }});
    // A real parent node includes the nested map's rendered dimensions in its layout bounds.
    for (const positions of [parent.view.positions]) {
        const position = positions.get("child4"); position.width = 240; position.height = 150;
    }
    const stopOuter = parent.view.stopFoldAnimation;
    if (stopOuter) parent.view.stopFoldAnimation = () => {
        assert.equal(nested.view.stopFoldAnimation, undefined, "inner animation finishes before outer animation");
        stopOuter();
    };
    panMindmapIntoView(nested.range);
    visible(nested.range, nested.viewport); visible(nested.range, parent.viewport); visible(nested.range, clip);
    assert.equal(nested.wheels.filter(event => !event.deltaX && !event.deltaY).length, 1);
    assert.equal(parent.wheels.filter(event => !event.deltaX && !event.deltaY).length, Number(animateOuter),
        "inner inert nodes never trigger an animation probe on a stable outer map");
    assert.equal(nested.view.interactionActive, false); assert.equal(parent.view.interactionActive, false);
    clip.remove();
}
assert.equal(nativeFrames.size, 0, "no stale native animation frame remains after navigation");
assert.equal(document.activeElement, search);
assert.deepEqual([search.selectionStart, search.selectionEnd], [2, 5], "search selection is preserved");
assert.equal(pointerEvents, 0, "no pointer edits even with clip/overlay handling");
console.log("Mindmap navigation: native activation/wheel/bounds/layout/fold animation, diagonal single draw, zoom/nesting, editor clipping, controls, lock/focus and no pointer edits OK");
