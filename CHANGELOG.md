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

