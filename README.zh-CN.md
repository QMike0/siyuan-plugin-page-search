[English](./README.md)

# 页内查找替换

在当前思源文档内搜索并高亮匹配结果（CSS Custom Highlight），支持页内替换。

基于官方 [plugin-sample](https://github.com/siyuan-note/plugin-sample)（Webpack + 前端 `index.js` + 内核 `kernel.js`）。

## 环境要求

- 思源笔记 **≥ 3.7.0**（需内核插件运行时）
- Node.js ≥ 24、pnpm

## 使用

1. 启用插件后，点击顶栏搜索图标，或使用快捷键打开搜索条  
2. 输入关键词（400ms 防抖），黄色高亮全部结果，橙色为当前焦点  
3. `Enter` 下一个 / `Shift+Enter` 上一个 / `Esc` 关闭  
4. 默认仅显示查找行；点击 ⌄ 展开替换行（替换 / 跳过 / 全部替换）  
5. 桌面端拖动「计数」区域可移动搜索条；再次点顶栏会复位位置  

默认快捷键：`Ctrl+Shift+Alt+F`（macOS：`⌥⇧⌘F`），可在思源快捷键设置中修改。

### 选项开关

| 开关 | 作用 |
|------|------|
| `Aa` | 区分大小写 |
| 整词 | ASCII 词边界全词匹配 |
| `.*` | 正则**搜索**（不做正则替换 / 无捕获组） |
| 选区内 | 仅在当前选区（或块级选中）内查找；与「打开时预填选区文字」无关 |
| `Aa*` | 替换时保留命中大小写形态（如 foo→bar、FOO→BAR、Foo→Bar） |

打开搜索条时若有选区，只会预填关键词，**不会**自动开启「选区内」。

### 搜索范围

段落、文档标题、表格单元格、数据库（可搜可高亮）、Callout 标题、预览模式、浮窗与多页签。

齿轮菜单：

| 分组 | 作用 |
|------|------|
| **限制查找** | 仅在所选行内类型中查找（多选 OR；全关=不限制）。查找框为空时预览所选类型的全部行内宿主（不可替换；计数超过 999 显示为 `999+` 仍全量高亮）。类型顺序：引用、链接、粗体、斜体、下划线、删除线、高亮、上标、下标、行级代码、键盘、标签、行级公式、行内备注。可与「选区内」同时生效 |
| **是否查找** | 是否纳入行内备注、数据库、代码块、Mermaid |
| **折叠块内容** | 是否匹配非标题折叠块内隐藏内容（与限制查找独立） |

补充：

- **行内备注**：是否查找 = 全文是否搜备注属性；限制查找·备注 = 限制模式下是否纳入 OR（需先开是否查找）
- **行内公式**：匹配 KaTeX **渲染可见文字**（非 `data-content` 源码，避免 “d” 误中 `\delta`）；正文/表格靠独立 unit 覆盖（含表内公式）；高亮黄/橙，不可替换
- 关限制查找时行为与旧版一致（AV / 代码块 / Mermaid / 折叠 / 备注虚线不受影响）

## 替换与撤销

写回优先走当前文档的 **Protyle transaction**（`updateTransactionElement` / 批量 `transaction`），因此在拿到编辑器实例时可使用 **Ctrl+Z / Ctrl+Y** 撤销与重做。

- **全部替换**：同一文档合并为一批操作，便于一次撤销整批  
- **拿不到 Protyle**：中止替换并提示，**不会**静默调用内核 `updateBlock`（避免误以为可撤销）  
- **仅当前已打开 / 已加载的 DOM**：离屏未渲染块不在本阶段范围内  

### 不可自动替换（可搜、可高亮）

| 类型 | 说明 |
|------|------|
| 数据库（AV） | 永不替换 |
| 跨 Text / 复杂格式 | 如普通字 + **加粗** 拼成一词 → `replaceable=false` |
| 公式 / 只读渲染 | 行内公式、块公式等 |
| 文档标题区 | 当前不走块 transaction 写回 |
| 预览合成块 | 无稳定块 ID 时跳过写回 |

说明：Callout 根节点在思源中为 `contenteditable=false`（标题经对话框编辑），表格也可能落在 false 容器内；插件仍允许对 **Callout 标题** 与 **表格单元格** 做整块 HTML 写回（与思源自身 transaction 一致）。

点「替换」遇到不可替项会提示并跳到下一项；「全部替换」会计入 skipped。

### 表格与 Callout

- **表格**：按单元格匹配与替换，不跨格；提交时更新整张 `NodeTable` 块 HTML  
- **Callout 标题**：与其它可替单元同一顺序；写回更新整块 `NodeCallout`（含 `.callout-title`）  

## 偏好（内核 storage）

保存在插件存储 `prefs.json`：

| 字段 | 说明 |
|------|------|
| `dialogLeft` / `dialogTop` | 拖拽后的固定位置（点顶栏复位会清空） |
| `includeAttributeView` / `includeCodeBlock` / `includeMermaid` | 是否查找（默认开） |
| `includeFoldedBlocks` / `includeInlineMemo` | 折叠块 / 行内备注（默认关） |
| `restrictInlineTypes` | 限制查找类型（会话内；关闭搜索窗后清回空） |

关闭搜索窗口时会清空关键词；再次打开仅在有选区时预填。

## 内核能力

| 能力 | 说明 |
|------|------|
| RPC `match` | 对纯文本 units 做匹配（支持 `caseSensitive` / `wholeWord` / `regex`） |
| RPC `prefs.get` / `prefs.set` | 读写偏好 |
| RPC `search.emit` | 广播 `search-state`（`close` / `clear`），多窗口同步关闭或清空高亮 |
| MCP `page_search` | 与 `match` 同一引擎；可传 `units` 或纯 `text` |

前端在内核未就绪时会自动回退到本地 `matchTextUnits`。

## 明确不做

- 正则替换捕获组（`$1` 等）  
- 数据库单元格替换  
- 默认内核 `updateBlock` 写回（无 Undo）  
- 未打开文档的离屏块替换  

## 回归检查清单

建议在真实文档中核对：

- [ ] 表格列名与首行同文：两者都能搜到；替换只改目标格  
- [ ] Callout 标题可搜可替（可替时），顺序与正文命中一致  
- [ ] 公式旁普通文本可搜；公式本身不可替  
- [ ] 跨加粗词：可高亮，替换按钮禁用或点按时跳过  
- [ ] 多页签：关闭/清空会经 `search-state` 同步；替换后其它页签高亮可清  
- [ ] 替换后 **Ctrl+Z / Ctrl+Y** 可回退（Protyle 可用时）  
- [ ] 「选区内」与打开预填关键词互不影响  
- [ ] 非法正则有错误提示，不产生错误高亮  

## 开发

```bash
pnpm i
pnpm run dev
pnpm run smoke:shared   # 共享匹配核 + 选区/大小写冒烟
pnpm run build          # 生成 package.zip
```

在思源 → 集市 → 已下载 中启用本插件。

## 状态

Phase 0–5 已完成：脚手架、shared 匹配、内核 RPC/MCP、选区内查找、搜/替 UI、Protyle 可撤销写回、文档与回归清单。
