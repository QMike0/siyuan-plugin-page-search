[中文](./README.zh-CN.md)

# In-Page Find & Replace

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
| `.*` | Regex **search only** (no regex replace / no capture groups) |
| In selection | Limit find to the current selection (or block selection); independent of “prefill query from selection on open” |
| `Aa*` | Preserve case of the match when replacing (foo→bar, FOO→BAR, Foo→Bar) |

Opening the bar with a selection only prefills the query; it does **not** turn on “In selection”.

### Coverage

Paragraphs, document title, table cells, attribute views (search/highlight), callout titles, preview mode, popovers, and multi-tab.

## Replace and undo

Writes go through the current document’s **Protyle transaction** (`updateTransactionElement` / batched `transaction`), so **Ctrl+Z / Ctrl+Y** work when a Protyle instance is available.

- **Replace all** merges into one transaction for a single undo step  
- **No Protyle**: replace is aborted with a message — never a silent kernel `updateBlock` (no false sense of undo)  
- **Loaded DOM only**: off-screen / unloaded blocks are out of scope for this release  

### Not auto-replaceable (still searchable / highlightable)

| Kind | Notes |
|------|-------|
| Attribute view (AV) | Never replaced |
| Cross-Text / complex marks | e.g. plain + **bold** spanning one word → `replaceable=false` |
| Math / render-only | Inline math, block math, etc. |
| Document title field | Not written via block transactions yet |
| Preview synthetic block | Skipped when there is no stable block id |

Note: SiYuan sets Callout roots to `contenteditable="false"` (title edited via dialog). Tables may also sit under false containers. This plugin still allows **callout titles** and **table cells** to be updated via whole-block HTML transactions (same path SiYuan uses).

**Replace** on a non-replaceable hit shows a tip and advances; **Replace all** counts them as skipped.

### Tables and callouts

- **Tables**: match/replace per cell (no cross-cell); submit updates the whole `NodeTable` block HTML  
- **Callout titles**: same order as other units; write-back updates the whole `NodeCallout` (including `.callout-title`)  

## Preferences (kernel storage)

Stored in `prefs.json`:

| Field | Meaning |
|------|---------|
| `dialogLeft` / `dialogTop` | Dragged position (cleared when resetting via top bar) |

Closing the search bar clears the query; reopening only prefills from the current selection.

## Kernel features

| Feature | Description |
|---------|-------------|
| RPC `match` | Match plain-text units (`caseSensitive` / `wholeWord` / `regex`) |
| RPC `prefs.get` / `prefs.set` | Read/write preferences |
| RPC `search.emit` | Broadcast `search-state` (`close` / `clear`) across windows |
| MCP `page_search` | Same matcher; accepts `units` or plain `text` |

Falls back to local `matchTextUnits` when the kernel is unavailable.

## Explicitly out of scope

- Regex replace capture groups (`$1`, etc.)  
- Replacing attribute-view cells  
- Default kernel `updateBlock` write-back (no undo)  
- Replacing blocks that are not loaded in the current Protyle DOM  

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

Phases 0–5 complete: scaffold, shared matcher, kernel RPC/MCP, selection-only find, search/replace UI, undoable Protyle write-back, docs and regression checklist.
