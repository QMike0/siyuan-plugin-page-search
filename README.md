# In-Page Search & Replace for SiYuan

[简体中文](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.zh-CN.md) | [English](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.md)

A search and replacement plugin for the document currently open in SiYuan. It supports keyword and regular-expression search, block-type filters, off-screen content, and both single and bulk replacement.

## Quick start

1. Enable the plugin under **Bazaar → Downloaded** in SiYuan.
2. Click the top-bar icon, or press `Ctrl+F` (`⌘F` on macOS), to open the search bar.
3. Enter a query and use `Enter` / `Shift+Enter` to move between matches.
4. Expand the replacement row, or press `Ctrl+H` (`⌘H` on macOS), to enter replacement text.

## In-page search

In-page search works on the document shown by the current editor. Matches are highlighted in the editor: orange marks the current match and yellow marks the other matches.

Image OCR text already recognized or saved in SiYuan is searchable. Matched images have yellow frames; the current result has an orange frame. Search does not run OCR, and OCR text cannot be replaced. Coverage follows the image's block type and scope options, including folded content.

![image-20261016002747503](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20261016002747503.png)

### Search methods

The method menu provides two modes:

* **Keyword**: normal text matching. Text queries ignore leading and trailing whitespace and also try a whitespace-stripped variant. The matcher does not perform Simplified/Traditional Chinese, full-width/half-width, or NFC conversion.
* **Regular expression**: JavaScript regular-expression rules. Regex replacement supports `$1`, `$&`, and similar replacement templates.

Other options:

* **Aa**: match case.
* **Whole word**: use whitespace, English punctuation, and common Chinese punctuation as boundaries.
* **Aa\***: preserve the case pattern of the match during replacement; unavailable in regex mode.
* **In selection**: search only within the current text selection or block selection.

### Search scope

![image-20261016002714516](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20261016002714516.png)

The **Include in search** menu controls which block types are searched:

* document titles, image titles, and inline memos;
* paragraph blocks, heading blocks H1–H6, and unordered/ordered/task list blocks;
* math blocks, plain code bodies, code language labels, Mermaid, and flowchart;
* table blocks, database blocks, blockquotes, callouts, super blocks, tabs, and mind maps;
* embed blocks, HTML blocks, and custom blocks.

Here:

* **Image title** means the caption text below an image. It does not mean a SiYuan window title or a document title in the document tab bar.
* Tabs search both opened and unopened tab panels. When a match is inside an unopened panel, the plugin activates that panel before locating the match.
* Database search follows the number of rows currently displayed. Rows beyond the current page are not counted; clicking **Load more** refreshes the index so newly displayed rows can be searched.

**Limit search** temporarily narrows the search to selected inline types, such as links, bold text, code, inline math, or inline memos. Counts, navigation, and replacement scope follow the filter. When an inline type is selected and the search box is empty, the plugin can preview all keywords of that type. These limits reset when the search window closes.

**Folded block content** controls whether hidden content inside non-heading folded blocks is searched. When enabled, matching content inside folded mind-map child nodes can still be found; when disabled, hidden content is excluded.

For content that is unloaded, folded, or simply outside the viewport, the plugin uses SiYuan source data when available instead of requiring the whole document to be scrolled into view. If the current environment cannot query part of the unloaded content, the search state reports incomplete coverage.

### Search results, history, and other

* A flashing match count indicates that the search is actively matching.
* Click the match count to open the results list. Each item shows context around the match.
* `Enter` goes to the next match, `Shift+Enter` to the previous match, and `Esc` closes the search bar.
* Each result shows block-type icons on the right. Each type appears once, with at most three icons; hover the ellipsis to expand the full list. Heading, list, and code blocks show their major category icon, and the context menu can choose among the subcategories present in the current result. Clicking an icon temporarily filters by type; multiple types can be combined. Click **Clear filters** to restore all results.
* Search history is kept per document. Use `↑` / `↓` in the search box to browse it.
* On desktop, drag the count area to move the panel; click the top-bar icon again to restore its default position.
* A selection present when the search bar opens only prefills the query; it does not enable **In selection**.

## In-page replace

Replacement uses the current search results but follows separate write rules. Before writing, the plugin rechecks each target so that edits made while searching cannot silently overwrite newer content.

![image-20261016002810292](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20261016002810292.png)

### Replace the current match

**Replace** changes only the current match and then advances to the next one. If the match is read-only, spans complex formatting, or has changed since the search, the plugin reports it and skips the write.

### Replace all

**Replace all** first shows the scope, the number of writable matches, and the number that will be skipped. After confirmation, the plugin prepares all targets and tries to submit content-block changes as one SiYuan transaction:

* it does not start while indexing is incomplete;
* it cancels and refreshes the results if a target changes during preparation;
* loaded, off-screen, folded, and source-fetched blocks use the same replacement rules;
* content-block changes normally support SiYuan `Ctrl+Z` / `Ctrl+Y` undo and redo.

### Writable and search-only content

Usually writable:

* text in ordinary editable blocks;
* image titles;
* inline memos;
* ordinary table cells and safely writable paragraphs, headings, lists, blockquotes, and plain code inside rich-text table cells;
* writable source text in tabs and mind maps;
* text in off-screen, folded, or unloaded areas when complete source data is available.

Searchable and highlightable but unsupported by replacement include:

* document titles;
* database content;
* embedded content;
* formulas, rendered Mermaid, and rendered HTML-block text;
* plugin-rendered custom blocks;
* tab titles inside tabs blocks;
* plain-code language labels (such as Python or MATLAB); matching blocks have a yellow frame, with an orange frame for the current result;
* matches spanning complex marks, read-only regions, or content whose original source cannot be confirmed.

**Replace all** reports these skipped items in its confirmation and result message.

## Publish and read-only modes

Search and highlighting remain available in publish service, export preview, and read-only mode, but replacement is disabled. Scope switches can still be used temporarily in the current session and are not persisted.

## Debug logs

Enable **Debug logs** under **Settings → Bazaar → Downloaded → this plugin’s settings** to view search, indexing, navigation, and replacement diagnostics in the console. Messages use the `[page-search]` prefix. Warnings and errors are always logged; if debug messages are hidden, enable the console’s **Verbose** level.

## Development

1. Install Node.js and pnpm.
2. Run `pnpm i` in the repository root.
3. Run `pnpm run dev` for development builds or `pnpm run build` to create `package.zip`.
4. Run `pnpm run smoke:shared` for shared matcher smoke tests.

## Changelog

See [CHANGELOG.md](https://cdn.jsdelivr.net/gh/QMike0/siyuan-plugin-page-search@main/CHANGELOG.md).

## License

MIT License

## Acknowledgments

* Built on the [SiYuan plugin sample](https://github.com/siyuan-note/plugin-sample) template.
* [siyuan-plugin-hsr-mdzz2048-fork](https://github.com/TCOTC/siyuan-plugin-hsr-mdzz2048-fork) provided the basic architecture ideas.
* [famotime/siyuan-sou-easy](https://github.com/famotime/siyuan-sou-easy) provided ideas for feature extensions.
