# In-Page Search & Replace

[简体中文](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.zh-CN.md)|[English](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.md)

## Key Features

### (1) Match options

* **Aa**: Match case
* **Whole word**: boundaries based on whitespace, English punctuation, and common Chinese punctuation
* **Match mode**: Keyword / Regular expression. Regex replace supports `$1`, `$&`, etc.
* **Keyword matching**: Uses loose matching: queries containing text trim edge whitespace and also match a whitespace-stripped query variant; whitespace-only queries keep their original value. Retains SiYuan internal-marker handling and the Aa option, without NFC, width or simplified/traditional Chinese conversion
* **Regular expressions**: Search and replacement use JavaScript regex rules
* **In selection**: Search only within the current selection or block selection
* **Aa\***: Preserve the match’s letter case when replacing (unavailable in regex mode)

### (2) Search scope (gear menu)

![image-20261016002714516](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20261016002714516.png)

* **Include in search**: Toggle which types are searched — document title, image title, inline memos, paragraph blocks, heading blocks (H1–H6), list blocks (unordered / ordered / task), math blocks, code blocks, tables, databases, blockquotes, callouts, super blocks, embeds, custom blocks, HTML, Mermaid, and more. Embedded content can be searched and highlighted, but is not replaced
* **Folded block content**: Whether to search hidden content inside non-heading folded blocks
* **Mermaid / flowchart**: Search visible text in displayed diagrams; search source when folded, unloaded, or not successfully rendered, without offscreen diagram rendering. Source hits only navigate to the diagram block
* **Limit search**: Search only within selected inline types (multi-select). With an empty query, preview all keywords in the selected types. Limit switches reset when the search UI closes

### (3) In-page search

![image-20261016002747503](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20261016002747503.png)

* Open the search bar from the top-bar icon or hotkey (default `Ctrl+F` / macOS `⌘F`; changeable in SiYuan hotkeys)
* Yellow = all hits, orange = current; `Enter` next, `Shift+Enter` previous, `Esc` close
* Search history is kept per document; use `↑` / `↓` in the search box to browse previous queries
* When the match count flashes, it indicates that it is in the search match state. Click it to open the search results list. Each item shows a short context around the match and follows the current match; click an item to jump to that position
* In the search results list, display the icons of the blocks where each item is located on the right side, from inner to outer. Show each icon type only once, with a maximum of three icons. When there are more, a floating ellipsis can be expanded to show all icons. For heading blocks, list blocks, and code blocks, display only the major category icon; right-clicking allows selecting from the actual subcategories present in the current result. Clicking an icon temporarily filters by that type, and multiple types can be combined. Clicking a blue icon again or clicking "Clear filters" cancels the filter. Counts, jumps, and replace scope update with the filter, are cleared after closing the search panel, and are not saved as settings
* On desktop, drag the count area to move the panel; click the top-bar icon again to reset position
* A selection on open only prefills the query; it does **not** turn on “In selection”

### (4) In-page replace

![image-20261016002810292](C:\Users\Administrator.DESKTOP-J8MI5MJ\AppData\Roaming\Typora\typora-user-images\image-20261016002810292.png)

* The replace row is collapsed by default; click ⌄ to expand, or open the replace area with a hotkey (default `Ctrl+H` / macOS `⌘H`; changeable in SiYuan hotkeys)
* Supports Replace / Replace all
* Write-back prefers the document’s Protyle transaction, so `Ctrl+Z` / `Ctrl+Y` usually work for undo/redo

Some hits are searchable/highlightable but not auto-replaceable, e.g. document titles, embedded content, custom blocks, databases, Mermaid, rendered HTML-block text, inline/block math, and words spanning complex marks. **Replace** tips and advances; **Replace all** shows the replaceable count and explains what will be skipped.

### (5) Publish & read-only

Under the publish service, export preview, or document read-only mode, find & highlight still work; replace is disabled and settings are not persisted (in-session toggles still apply locally).

### (6) Debug logs

Enable **Debug logs** under SiYuan → Settings → Bazaar → Downloaded → this plugin’s settings and confirm to view search, navigation and replacement diagnostics in the console (prefix: `[page-search]`). Off by default; warnings and errors are always logged. Select the console’s **Verbose** level if debug messages are hidden.

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

* Built on the [SiYuan plugin sample](https://github.com/siyuan-note/plugin-sample) template
* “[siyuan-plugin-hsr-mdzz2048-fork](https://github.com/TCOTC/siyuan-plugin-hsr-mdzz2048-fork)”: provided the basic architecture ideas for this plugin
* “[famotime/siyuan-sou-easy](https://github.com/famotime/siyuan-sou-easy)”: provided ideas for feature extensions
