// v3.8.8 native source fixture. Optional drawing hooks are stubbed; never opens a notebook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
module.exports = function nativeRichPreview(lute) {
const parse = html => {const root = document.createElement('div'); root.innerHTML = html; return root;};
const nativeDir = process.env.SIYUAN_RICH_SOURCE_DIR || path.resolve(__dirname, '../../tmp/rich-cell-v387');
const nativeCache = new Map();
function nativeModule(name) {
    if (nativeCache.has(name)) return nativeCache.get(name);
    const filename = path.join(nativeDir, name);
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = module.paths;
    mod.require = request => {
        if (request.endsWith('/richTextValue')) return nativeModule('v388-richTextValue.ts');
        if (request.endsWith('/av/richText')) return nativeModule('v388-richText.ts');
        if (request.endsWith('/tableCellRichValue')) return nativeModule('v388-tableCellRichValue.ts');
        if (request.endsWith('/fontFamilyCore')) return {getInlineFontFamilyName: value => value, getInlineFontFamilyStyle: value => value};
        if (request.endsWith('/constants')) return {Constants: {CUSTOM_SY_CODE_TAB_SPACES: 'custom-sy-code-tab-spaces', PROTYLE_CDN: ''}};
        if (request.endsWith('/addScript')) return {addScript: async () => {}};
        if (request.endsWith('/selectionOffsets')) return {};
        if (request.endsWith('/getBlock')) return {};
        if (request === './util') return {setCodeTheme: () => {}};
        if (request.endsWith('/foldedContent')) return {isFoldedRenderContent: () => false};
        if (request.endsWith('/codeBlockUtil')) return {CODE_TAB_SPACE_VALUES: [2, 4, 8]};
        if (request.endsWith('/setLute')) return {getAgentLute: () => lute};
        if (request.endsWith('/inlineElementBoundary')) return {restoreInlineElementBoundaries: () => {}};
        if (request.endsWith('/inlineElementMarker')) return {getTextWithoutSemanticMarkers: node => node.textContent};
        if (request.endsWith('/tableVirtualizationDOM')) return {};
        if (request.endsWith('/highlightRender')) return {highlightRender: () => {}};
        if (request.endsWith('/mathRender')) return {mathRender: () => {}};
        if (request.endsWith('/escape')) return {escapeHtml: value => value};
        throw new Error('Unexpected native dependency ' + request);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
        {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
    nativeCache.set(name, mod.exports);
    return mod.exports;
}
const {getTableCellRichBlockDOM} = nativeModule('tableCellRich-v388.ts');
// v3.8.8 renderer identity/editability transform; plain content needs no math/highlighting.
function nativePreview(cell) {
    const preview = cell.querySelector('.table__cell-rich');
    if (!preview) return;
    const template = document.createElement('template');
    template.innerHTML = getTableCellRichBlockDOM(cell);
    template.content.querySelectorAll('*').forEach(node => {
        if (node.hasAttribute('data-node-id')) node.setAttribute('data-table-cell-node', '');
        if (node.hasAttribute('spellcheck')) node.setAttribute('data-table-cell-content', '');
        for (const attr of ['id', 'data-node-id', 'data-node-index', 'updated', 'spellcheck', 'draggable']) node.removeAttribute(attr);
        if (node.hasAttribute('contenteditable')) node.setAttribute('contenteditable', 'false');
    });
    preview.replaceChildren(template.content);
    preview.classList.remove('b3-typography');
    preview.dataset.protyleLiteRender = 'safe';
}
function nativeTable(html) {
    const root = parse(html);
    root.querySelectorAll('[data-sy-table-cell-rich]').forEach(nativePreview);
    return root.innerHTML;
}
// Run the actual v3.8.8 highlighting/line-number code, with asset loading
// stubbed. Its two script promises do not make highlightRender awaitable.
nativeTable.renderCode = async root => {
    nativeModule('highlightRender-v388.ts').highlightRender(root);
    await Promise.resolve();
    await Promise.resolve();
};

return nativeTable;
};
