# 页内搜索替换

[English](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.md)|[简体中文](https://github.com/QMike0/siyuan-plugin-page-search/blob/main/README.zh-CN.md)

## 主要特性

### （1）匹配选项

- **Aa**：区分大小写
- **整词**：ASCII 词边界全词匹配
- **匹配模式**：关键字 / 正则表达式。正则替换支持 `$1`、`$&` 等
- **选区内**：仅在当前选区或块选范围内搜索
- **Aa\***：替换时保留命中的大小写形态（正则模式下不可用）

### （2）搜索范围（齿轮菜单）

![image-20260728110038465](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110038465.png)

- **是否搜索**：按类型开关是否纳入搜索——文档标题、图片标题、行内备注、段落块、标题块（一至六级）、列表块（无序 / 有序 / 任务）、公式块、代码块、表格、数据库、引述块、提示块、超级块、嵌入块、HTML、Mermaid 图等
- **折叠块内容**：是否搜索非标题折叠块内的隐藏内容
- **限制搜索**：仅在所选行内类型中搜索（可多选）；搜索框为空时可预览该类元素。关闭搜索窗后限制项会复位

### （3）页内搜索

![image-20260728110005220](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110005220.png)

- 顶栏图标或快捷键打开搜索条（默认 `Ctrl+F` / macOS `⌘F`，可在思源快捷键中修改）
- 黄标全部命中、橙标当前项；`Enter` 下一个、`Shift+Enter` 上一个、`Esc` 关闭
- 桌面端可拖动计数区移动面板；再点顶栏复位位置
- 打开时若有选区，仅预填关键词，不会自动开启「选区内」

### （4）页内替换

![image-20260728110019082](https://cdn.jsdelivr.net/gh/QMike0/pic_bed@main/img/image-20260728110019082.png)

- 默认折叠替换行，点 ⌄ 展开，或者快捷键打开替换功能区域（默认 `Ctrl+H` / macOS `⌘H`，可在思源快捷键中修改）
- 支持 替换 / 全部替换
- 写回尽量走当前文档 Protyle transaction，一般可用 `Ctrl+Z` / `Ctrl+Y`  撤销重做

部分结果可搜可高亮、但不可自动替换，例如：数据库、Mermaid、HTML 块渲染字、行内 / 块公式、跨格式拼词等。点「替换」会提示并跳到下一项；「全部替换」计入跳过。

### （5）发布与只读

发布服务、导出预览、文档只读下仍可搜索与高亮，替换按钮禁用；配置也不会写入存储（会话内开关仍可临时生效）。

## 更新日志

见 [CHANGELOG.md](https://cdn.jsdelivr.net/gh/QMike0/siyuan-plugin-page-search@main/CHANGELOG.md)

## 开发相关

1. 安装 Node.js 与 pnpm  
2. 在仓库根目录执行 `pnpm i`  
3. `pnpm run dev` 开发构建；`pnpm run build` 打包 `package.zip`  
4. `pnpm run smoke:shared` 运行共享匹配冒烟测试  

在思源 → 集市 → 已下载 中启用本插件。

## 许可证

MIT License

## 致谢

- 基于 [SiYuan plugin sample](https://github.com/siyuan-note/plugin-sample) 模板开发
- 「[siyuan-plugin-hsr-mdzz2048-fork](https://github.com/TCOTC/siyuan-plugin-hsr-mdzz2048-fork)」：为本插件提供了基本架构思路
- 「[famotime/siyuan-sou-easy](https://github.com/famotime/siyuan-sou-easy)」：为本插件提供了功能拓展思路
