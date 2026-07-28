# In-Page Search & Replace

[简体中文](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.zh-CN.md)|[English](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.md)

## Key Features

### (1) Match options

- **Aa**: Match case
- **Whole word**: ASCII word-boundary match
- **Match mode**: Keyword / Regular expression. Regex replace supports `$1`, `$&`, etc.
- **In selection**: Search only within the current selection or block selection
- **Aa\***: Preserve the match’s letter case when replacing (unavailable in regex mode)

### (2) Search scope (gear menu)

![image-20260728110038465](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110038465.png)

- **Include in search**: Toggle which types are searched — document title, image title, inline memos, paragraph blocks, heading blocks (H1–H6), list blocks (unordered / ordered / task), math blocks, code blocks, tables, databases, blockquotes, callouts, super blocks, embeds, HTML, Mermaid, and more
- **Folded block content**: Whether to search hidden content inside non-heading folded blocks
- **Limit search**: Search only within selected inline types (multi-select). An empty query previews those hosts. Limit choices reset when the search UI closes

### (3) In-page search

![image-20260728110005220](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110005220.png)

- Open the search bar from the top-bar icon or hotkey (default `Ctrl+F` / macOS `⌘F`; changeable in SiYuan hotkeys)
- Yellow = all hits, orange = current; `Enter` next, `Shift+Enter` previous, `Esc` close
- On desktop, drag the count area to move the panel; click the top-bar icon again to reset position
- A selection on open only prefills the query; it does **not** turn on “In selection”

### (4) In-page replace

![image-20260728110019082](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110019082.png)

- The replace row is collapsed by default; click ⌄ to expand, or open the replace area with a hotkey (default `Ctrl+H` / macOS `⌘H`; changeable in SiYuan hotkeys)
- Supports Replace / Replace all
- Write-back prefers the document’s Protyle transaction, so `Ctrl+Z` / `Ctrl+Y` usually work for undo/redo

Some hits are searchable/highlightable but not auto-replaceable, e.g. databases, Mermaid, rendered HTML-block text, inline/block math, and words spanning complex marks. **Replace** tips and advances; **Replace all** counts them as skipped.

### (5) Publish & read-only

Under the publish service, export preview, or document read-only mode, find & highlight still work; replace is disabled and settings are not persisted (in-session toggles still apply locally).

## Changelog

See [CHANGELOG.md](https://cdn.jsdelivr.net/gh/QMike0/siyuan-plugin-page-search@main/CHANGELOG.md)

## Development

1. Install Node.js and pnpm  
2. Run `pnpm i` in the repo root  
3. `pnpm run dev` for development builds; `pnpm run build` to produce `package.zip`  
4. `pnpm run smoke:shared` for shared-matcher smoke tests  

Enable the plugin under SiYuan → Bazaar → Downloaded.

## License

MIT License

## Acknowledgments

- Built on the [SiYuan plugin sample](https://github.com/siyuan-note/plugin-sample) template
- “[siyuan-plugin-hsr-mdzz2048-fork](https://github.com/TCOTC/siyuan-plugin-hsr-mdzz2048-fork)”: provided the basic architecture ideas for this plugin
- “[famotime/siyuan-sou-easy](https://github.com/famotime/siyuan-sou-easy)”: provided ideas for feature extensions
