[中文](./README.zh-CN.md)

# In-Page Search & Replace

Search and highlight matches in the current SiYuan document (CSS Custom Highlight), with in-page replace.

Built on the official [plugin-sample](https://github.com/siyuan-note/plugin-sample) (Webpack + frontend `index.js` + kernel `kernel.js`).

## Requirements

- SiYuan **≥ 3.7.0** (kernel plugin runtime)
- Node.js ≥ 24, pnpm

## Usage

1. Enable the plugin, then open search via the top-bar icon or hotkey  
2. Type a query (400ms debounce); yellow = all hits, orange = current focus  
3. `Enter` next / `Shift+Enter` previous / `Esc` close  
4. The replace row is collapsed by default; click the chevron to expand (Replace / Skip / Replace all)  
5. On desktop, drag the count label to move the bar; clicking the top-bar icon resets position  

Default hotkey: `Ctrl+Shift+Alt+F` (macOS: `⌥⇧⌘F`).

### Options

| Control | Effect |
|---------|--------|
| `Aa` | Match case |
| Whole word | ASCII word-boundary match |
| Method button | Opens a menu to choose **Keyword** or **Regular expression** (mutually exclusive). The icon follows the current mode (Exact / Regex). With regex, the replace box accepts `$1` / `$2` / `$&` / `$$` (`Aa*` disabled; failed expansions are skipped). The choice is saved in prefs and restored when reopening |
| In selection | Limit search to the current selection (or block selection); independent of “prefill query from selection on open” |
| `Aa*` | Preserve case of the match when replacing (foo→bar, FOO→BAR, Foo→Bar) |

Opening the bar with a selection only prefills the query; it does **not** turn on “In selection”.

### Coverage

Paragraphs, document title, table cells, attribute views (search/highlight), callout titles, preview mode, popovers, and multi-tab.

Gear menu:

| Group | Role |
|------|------|
| **Include in search** | Whether to include document title, image title, inline memos, databases, tables, blockquotes, callouts, math blocks, embed blocks, code blocks, Mermaid, HTML blocks |
| **Folded block content** | Match hidden content in non-heading folded blocks (independent of Limit search) |
| **Limit search** | Search only within selected inline types (OR; all off = no limit). Empty search box previews all hosts of selected types (not replaceable; counts over 999 show as `999+` while still highlighting all). Order: block ref, link, bold, italic, underline, strike, highlight, superscript, subscript, inline code, keyboard, tag, inline math, inline memo. Stacks with Search in selection |

Notes:

- **Inline memos**: Include = search memo attributes in full-document mode; Limit search → Inline memo = include them in the OR set (requires Include first); dashed underline on hits; replace updates only `data-inline-memo-content` (not host visible text) via Protyle transaction (Ctrl+Z)
- **Inline math**: matches KaTeX **rendered visible text** (not `data-content` LaTeX, so “d” won’t hit `\delta`); separate units cover body and table formulas; yellow/orange highlight; not replaceable
- With Limit search off, behavior matches the previous release (AV / code / Mermaid / fold / memo underlines unchanged)

## Replace and undo

Writes go through the current document’s **Protyle transaction** (`updateTransactionElement` / batched `transaction`), so **Ctrl+Z / Ctrl+Y** work when a Protyle instance is available.

- **Replace all** merges into one transaction for a single undo step  
- **No Protyle**: replace is aborted with a message — never a silent kernel `updateBlock` (no false sense of undo)  
- **Loaded DOM only**: off-screen / unloaded blocks are out of scope for this release  
- **Regex replace**: with regex search on, the replace string is a `$n` template (e.g. find `(\d+)-(\d+)`, replace `$2/$1`); without regex, replace stays literal  
- **Document title**: searchable & replaceable (toggle under Include in search); write-back uses `/api/filetree/renameDocByID` (or `renameDoc`) (**not** Ctrl+Z); replace-all merges title hits into one rename, separate from body transactions; empty result matches SiYuan: send `""` to the API so the kernel stores Language(16) with `custom-sy-title-empty`, while the title input shows empty (placeholder)  
- **Inline memos**: attribute write-back with the owning block’s transaction (undoable); empty-query restrict preview stays non-replaceable  

### Not auto-replaceable (still searchable / highlightable)

| Kind | Notes |
|------|-------|
| Attribute view (AV) | Never replaced |
| Mermaid / HTML block | Search & highlight rendered text only |
| Cross-Text / complex marks | e.g. plain + **bold** spanning one word → `replaceable=false` |
| Math / render-only | Inline math, block math, etc. |
| Preview synthetic block | Skipped when there is no stable block id |

Note: SiYuan sets Callout roots to `contenteditable="false"` (title edited via dialog). Tables may also sit under false containers. Image `.img` wrappers are likewise false, with the caption in `.protyle-action__title`. This plugin still allows **callout titles**, **table cells**, and **image titles** to be updated via whole-block HTML transactions (same path SiYuan uses; Ctrl+Z supported).

**Replace** on a non-replaceable hit shows a tip and advances; **Replace all** counts them as skipped.

### Tables and callouts

- **Tables**: match/replace per cell (no cross-cell); submit updates the whole `NodeTable` block HTML  
- **Callout titles**: same order as other units; write-back updates the whole `NodeCallout` (including `.callout-title`)  

## Publish mode

With `disabledInPublish: false`, the plugin **still loads** under the publish service (find & highlight work), but all writes are blocked:

| Capability | Publish |
|------------|---------|
| Search / highlight / next-prev | ✅ |
| Expand replace row / type replacement | ✅ (replace row is not hidden) |
| Replace / replace-all / document write-back | ❌ Buttons disabled; click shows a notice |
| Persisting prefs (`prefs.json` position, type toggles, search method) | ❌ No petal writes; in-session toggles still apply locally |

Gate: `window.siyuan.isPublish` (same condition as SiYuan rejecting `saveData`/`removeData`). Export preview and read-only use the same “block replace, keep replace row” policy.

## Preferences (kernel storage)

Stored at `data/storage/petal/<plugin>/prefs.json` (same path for kernel `storage.put` and frontend `removeData`):

| Field | Meaning |
|------|---------|
| `dialogLeft` / `dialogTop` | Dragged position (cleared when resetting via top bar) |
| `includeDocTitle` / `includeImageTitle` / `includeAttributeView` / `includeTable` / `includeListUnordered` / `includeListOrdered` / `includeListTask` / `includeHeadingH1`–`H6` / `includeBlockquote` / `includeCallout` / `includeSuperBlock` / `includeMathBlock` / `includeEmbedBlock` / `includeCodeBlock` / `includeMermaid` / `includeHtmlBlock` | Include in search (default on; list/heading subtypes independent — all off skips that area; document title / image title searchable & replaceable by default) |
| `includeFoldedBlocks` / `includeInlineMemo` | Folded blocks / inline memos (default off) |
| `useRegex` | Search method: `false`=keyword, `true`=regular expression (default keyword; kept across reopen) |
| `restrictInlineTypes` | Limit-find types (session only; cleared when search UI closes) |

Closing the search bar clears the query; reopening only prefills from the current selection.

## Lifecycle & uninstall

| Hook | When | Behavior |
|------|------|----------|
| `onunload` | Disable, app close, before uninstall, sync reload | Tear down hotkeys / search bar / listeners; **keep** `prefs.json` |
| `uninstall` | Real uninstall from bazaar/settings (not reload) | `removeData("prefs.json")` deletes preferences |

SiYuan uninstall order: `onunload` → `kernel.destroy` → `uninstall`. Reinstall starts from defaults.

## Kernel features

| Feature | Description |
|---------|-------------|
| RPC `match` | Match plain-text units (`caseSensitive` / `wholeWord` / `regex`) |
| RPC `prefs.get` / `prefs.set` | Read/write preferences |
| RPC `search.emit` | Broadcast `search-state` (`close` / `clear`) across windows |
| MCP `page_search` | Same matcher; accepts `units` or plain `text` |

Falls back to local `matchTextUnits` when the kernel is unavailable.

## Explicitly out of scope

- Replacing attribute-view cells  
- Default kernel `updateBlock` write-back (no undo)  
- Replacing blocks that are not loaded in the current Protyle DOM  
- Workspace-wide AST `/api/search/findReplace` (in-page DOM + Protyle transactions instead)  

## Regression checklist

- [ ] Table header vs first data row with the same text: both findable; replace only the target cell  
- [ ] Callout title find/replace (when replaceable); order matches other hits  
- [ ] Text next to math is findable; math itself is not replaceable  
- [ ] Word spanning bold: highlightable; replace disabled or skipped on click  
- [ ] Multi-tab: close/clear sync via `search-state`; highlights can clear after replace  
- [ ] After replace, **Ctrl+Z / Ctrl+Y** undo/redo (when Protyle is available)  
- [ ] “In selection” stays independent of open-time query prefill  
- [ ] Invalid regex shows an error and does not paint bad highlights  

## Develop

```bash
pnpm i
pnpm run dev
pnpm run smoke:shared
pnpm run build
```

## Status

Phases 0–5 complete: scaffold, shared matcher, kernel RPC/MCP, selection-only search, search/replace UI, undoable Protyle write-back, docs and regression checklist.
