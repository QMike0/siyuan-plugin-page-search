## v2.1.2 2026-10-29

- 🇨🇳 优化插件对代码块语言标签的搜索匹配，实现搜索到语言标签时高亮代码块外框、禁止替换语言标签、实现独立开关项、离屏搜索
- 🇨🇳 实现对图片OCR文本的搜索，搜索匹配到的对应图片采用黄色/橙色高亮
- 🇨🇳 适配思源笔记v3.8.8引入的页签可见性判据，优化相关搜索逻辑
- 🇺🇸 Optimize the plugin's search matching for code block language labels: highlight the code block's outer frame when a language label is matched, prevent replacement of language labels, implement a standalone toggle option, and support off-screen search
- 🇺🇸 Implement search for OCR text in images, highlighting the corresponding matched images in yellow/orange
- 🇺🇸 Adapt to the tab visibility criteria introduced in SiYuan Notes v3.8.8 and optimize the related search logic

## v2.1.1 2026-10-26

- 🇨🇳 修复被引用块替换后的结果确认误判
- 🇺🇸 Fix the false positive in result confirmation after a referenced block is replaced

## v2.1.0 2026-10-26

- 🇨🇳 支持对表格富文本单元格内容的替换/全部替换
- 🇨🇳 支持数据库不同视图下的字段名称搜索、高亮和跳转，并遵守显示字段名称、显示空字段和隐藏字段等设置
- 🇨🇳 优化搜索/替换面板的触发范围
- 🇨🇳 优化替换&全部替换在不可替换情况下的提示文本
- 🇨🇳 修复图片标题文本替换问题
- 🇨🇳 更新README，优化相关表述
- 🇺🇸 Support replacing/replace all for rich text cell content in tables
- 🇺🇸 Support field name search, highlighting, and navigation across different database views, while respecting settings such as showing field names, showing empty fields, and hiding fields
- 🇺🇸 Optimize the trigger range of the search/replace panel
- 🇺🇸 Optimize the prompt text for replace & replace all when replacement is not possible
- 🇺🇸 Fix the issue with replacing image caption text
- 🇺🇸 Update README and optimize related wording

## v2.0.2 2026-10-18

- 🇨🇳 在“是否搜索”菜单中添加自定义块的开关项
- 🇨🇳 优化搜索结果列表的展示，支持显示特定搜索结果所在内容块的类型，并可通过点击类型icon临时限定筛选对应内容块类型下的搜索结果
- 🇨🇳 添加插件日志输出
- 🇨🇳 优化内容块名称描述和icon
- 🇺🇸 Add a toggle option for custom blocks in the "Whether to search" menu
- 🇺🇸 Optimize the display of the search results list: support showing the content block type where a specific search result is located, and allow clicking the type icon to temporarily filter search results under the corresponding content block type
- 🇺🇸 Add plugin log output
- 🇺🇸 Optimize content block name descriptions and icons

## v2.0.1 2026-10-17

- 🇨🇳 按数据库已加载行数限制搜索范围，而非强行搜索数据库所有内容
- 🇨🇳 根据数据库显示行数限制只加载并索引当前页数内的行，点击`加载更多`后，自动刷新对应数据库缓存并纳入新增行
- 🇨🇳 修复数据库块导致的文档首块内容搜索出现无法屏外跳转的问题
- 🇨🇳 修复大数据库后邻近内容块中的关键词跳转问题
- 🇨🇳 去除跳转至数据库屏外关键词时会显示的右上角提示文本
- 🇨🇳 支持输入关键词后立刻跳转当前索引对应命中
- 🇺🇸 Limit search scope by the number of rows loaded in the database, rather than forcing a search across all database content
- 🇺🇸 Load and index only the rows within the current page based on the number of rows displayed in the database; after clicking `Load more`, automatically refresh the corresponding database cache and include the newly added rows
- 🇺🇸 Fix the issue where the first block of a document cannot jump off-screen when searching content caused by a database block
- 🇺🇸 Fix the keyword jump issue in adjacent content blocks after a large database
- 🇺🇸 Remove the top-right notification text that appears when jumping to an off-screen keyword in a database
- 🇺🇸 Support immediately jumping to the current index's corresponding hit after entering a keyword

## v2.0.0 2026-10-16

- 🇨🇳 对插件进行了完全重构
- 🇺🇸 The plugin has been completely refactored.

## v1.0.4 2026-07-30

- 🇨🇳 更换顶栏图标
- 🇨🇳 更新README.md
- 🇺🇸 Replace top bar icons
- 🇺🇸 Update README.md

## v1.0.3 2026-07-28

- 🇨🇳 实现正则替换
- 🇨🇳 优化搜索模式切换为菜单形式，当前支持「关键字」和「正则表达式」
- 🇨🇳 「是否搜索」中新增对列表块、标题块、超级块、段落块的筛选
- 🇨🇳 新增对文档标题、行内备注、图片标题的替换支持
- 🇨🇳 优化同一备注宿主上的多处命中时的关键词跳转切换动画
- 🇨🇳 删除挂件搜索相关代码逻辑，默认无法搜索挂件中的可见文字（类似于IFRAME）
- 🇨🇳 优化搜索窗口输入框文本的缓存机制
- 🇺🇸 Implement regex replacement
- 🇺🇸 Optimize search mode switching as a menu, currently supporting 「Keyword」 and 「Regular Expression」
- 🇺🇸 Add filtering for list blocks, heading blocks, super blocks, and paragraph blocks under 「Search Scope」
- 🇺🇸 Add replacement support for document titles, inline annotations, and image captions
- 🇺🇸 Optimize the keyword navigation transition animation when multiple matches are found on the same annotation host
- 🇺🇸 Remove code logic related to widget search; widgets (similar to IFRAME) are no longer searchable by default for visible text
- 🇺🇸 Optimize the cache mechanism for input text in the search window

## v1.0.2 2026-07-24

- 🇨🇳 修复关闭数据库「显示条目图标」会导致的主键文字匹配问题
- 🇨🇳 明确插件卸载机制，卸载时自动删除配置文件
- 🇨🇳 发布模式下禁用替换及配置持久化
- 🇺🇸 Fixed an issue where disabling "Show Entry Icons" in the database would cause primary key text matching problems
- 🇺🇸 Clarified plugin uninstallation mechanism, now automatically removes configuration files upon uninstallation
- 🇺🇸 Disabled replacement and configuration persistence in release mode

## v1.0.1 2026-07-23

- 🇨🇳 新增菜单「限制查找」，支持对行内元素的筛选与空查询预览，并更新相关配套功能
- 🇨🇳 扩展菜单「是否查找」，已支持对行内备注、公式块、代码块、表格、数据库、引述块、提示块、嵌入块、HTML块、挂件的开关控制
- 🇨🇳 优化对数学公式的（按渲染文字）匹配机制
- 🇨🇳 实现行内备注的虚线高亮提示
- 🇨🇳 修复搜索窗盖住思源 Dialog 的层级问题
- 🇺🇸 Added menu "Restrict Search" with support for inline element filtering and empty query preview, along with updates to related supporting features
- 🇺🇸 Extended menu "Search Scope" to support toggle controls for inline annotations, formula blocks, code blocks, tables, databases, block quotes, hint blocks, embed blocks, HTML blocks, and widgets
- 🇺🇸 Optimized matching mechanism for mathematical formulas (based on rendered text)
- 🇺🇸 Implemented dotted underline highlight for inline annotations
- 🇺🇸 Fixed z-index issue where the search window would overlay SiYuan's Dialog boxes

## v1.0.0 2026-07-22

- 🇨🇳 实现了 VSCode 形式的查找、替换功能，并基于思源笔记内容块的特点进行了优化
- 🇺🇸 Implemented VSCode-style find and replace functionality, with optimizations based on the characteristics of SiYuan note content blocks.

