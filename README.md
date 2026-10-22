# sageread-mcp

[Better SageRead](https://github.com/Feplus2/better-sageread) 阅读数据的 MCP server（**只读**）：让任何支持 MCP 的 AI Agent 查询你的书库、阅读进度、阅读时长、划线标注、AI 对话与论文库，并对向量库做语义检索。

Better SageRead 是基于上游 [xincmm/sageread](https://github.com/xincmm/sageread) 发展的独立维护版；本 MCP 同时兼容两者的数据目录（优先读 Better SageRead，见「数据目录」一节）。

- **数据安全**：以 `readonly` 模式打开 SageRead 的 SQLite 数据库，不会以任何形式写入，不影响 SageRead 运行
- **密钥不出 app**：语义检索的嵌入调用经 SageRead 本地通道转发，本进程不读取/不持有任何 API Key
- **SageRead 不在运行时只读工具可用**（数据是本地文件）；`search_library` 需应用运行（嵌入在 app 内执行）
- **论文支持**：读取论文元数据、目录、正文与分组，列出论文标注（含星标/类别/来源），导出 8 种引用格式
- **书籍直读**：`get_document_info` / `read_document` 解析 EPUB 的 mdbook 目录并直读整章正文（不再只能靠 3 块上下文拼接）
- **语义检索**：`search_library` 基于 SageRead 的向量库（sqlite-vec）对书库/论文库/跨库做统一近邻检索
- **跨应用联动**：配合其他 MCP（如知识库类），可以让 Agent 完成"把某段阅读对话归档到知识库"这类操作

## 工具（tools）

0.3.0 起默认只注册 **18 个现代精简工具**，覆盖「浏览书库 → 检索内容 → 读原文 → 查引用」的主路径。旧工具收进 `SAGEREAD_MCP_LEGACY_TOOLS` 开关，避免新旧工具并列造成 Agent 选择困难；迁移对照见下一节。

### 默认现代精简集（18 个）

| 工具 | 说明 | 参数 |
|---|---|---|
| `list_books` | 书库全部书籍（含进度状态） | `include_trashed?` |
| `get_book_progress` | 单本书进度 | `query` 书名（模糊）或 id |
| `get_reading_stats` | 阅读时长/次数统计 | `period`: today / week / month / total |
| `list_threads` | AI 对话列表 | `book?` 可按书过滤；`starred_only?` 只看星标；`scope?` 按作用域 |
| `get_thread` | 对话完整内容 | `threadId` |
| `list_book_notes` | 划线/标注/书签（论文标注含星标/类别/来源，位置渲染为可读形式） | `book`，`type?` |
| `list_notes` | 读书笔记面板的 Markdown 笔记（notes 表，与划线标注不同源），按书/星标过滤 | `book?`，`starred?` |
| `export_thread_markdown` | 对话导出为 Markdown | `threadId` |
| `list_tags` | 书库所有标签 | 无 |
| `list_skills` | AI 技能库（可选返回完整内容） | `include_content?` |
| `get_paper_info` | 论文书目元数据（frontmatter + 中文标题/摘要 + 收藏文件夹，字段保持 Pandoc/CSL 原义） | `paper` 标题（模糊）或 id |
| `list_papers` | 批量文献卡片（书目信息一览，供初筛） | `collection?`，`include_abstract?`，`limit?`（默认 50，上限 200） |
| `list_paper_folders` | 论文分组（文件夹/颜色/包含论文） | 无 |
| `export_paper_citation` | 导出参考文献引用（8 种格式，见下），单篇或整个收藏文件夹 | `paper?`，`collection?`（两者至少给一个），`format?`（默认 bibtex） |
| `search_library` | **统一检索**：书库/论文库/跨库语义检索，每条结果带统一 `doc` 锚点与片段 | `query`，`scope?`（all/papers/books，默认 all），`doc?`（`book:<id>` / `paper:<id>`），`collection?`（仅论文），`top_k?`（默认 8，上限 30） |
| `get_document_info` | 统一 DocRef 的文档信息：书籍/论文标题、目录、图表与参考文献数、**向量索引状态** | `doc`: `book:<id>` 或 `paper:<id>` |
| `read_document` | 统一 DocRef 读原文窗口：论文用 heading/offset，书籍用 heading/file + offset；返回文本、总长度与 `next_offset` | `doc`，`heading?`，`file?`，`offset?`，`limit?`（默认 6000，上限 30000） |
| `get_citation_graph` | 库内引用关系：它引用了库里哪些论文 / 库里谁引用了它（按 DOI/标题匹配 References，无需向量索引） | `doc`: `paper:<id>`，`include_cited_by?` |

论文与书籍统一用 `doc` 锚点表达：论文 `paper:<id>`、书籍 `book:<id>`；`get_document_info` 返回目录，`read_document` 按目录读正文，`search_library` 的命中结果同样带 `doc` 锚点。论文工具只支持 MARKDOWN 格式的论文书籍，`book:<id>` 指向论文或 `paper:<id>` 指向普通书籍时，DocRef 工具会返回明确的重定向提示。

### 旧工具（legacy，默认关闭，7 个）

设置环境变量 `SAGEREAD_MCP_LEGACY_TOOLS=1` 后**额外**注册以下 7 个旧工具（与默认集合计 25 个），仅建议旧客户端/旧提示词兼容使用：

| 旧工具 | 说明 | 默认集替代 |
|---|---|---|
| `semantic_search` | 向量库语义检索（默认论文库） | `search_library` |
| `get_paper_toc` | 论文目录（解析 paper.md 标题层级） | `get_document_info` |
| `read_paper` | 论文正文切片（offset/limit 分段） | `read_document` |
| `read_paper_section` | 按小节标题读论文章节 | `read_document`（`heading`） |
| `get_book_toc` | 书籍（EPUB）目录（nav.md 层级） | `get_document_info` |
| `read_book` | 读取书籍某章正文（file + offset/limit） | `read_document`（`file` + `offset`） |
| `get_chunk_context` | 语义检索命中块前后各扩 radius 块 | `read_document`（按 `heading`/`offset` 精读；legacy 下仍可精确取块上下文） |

旧工具代码与行为全部保留，只是默认不出现在 `tools/list` 中；开关在进程启动时读取，切换后需重启 MCP 客户端。

### 工具面迁移与 legacy 开关

| 旧调用（0.2.0） | 0.3.0 默认写法 |
|---|---|
| `semantic_search(query, scope, paper_id/collection/book_id, top_k)` | `search_library(query, scope, doc, collection, top_k)` |
| `read_paper(paper, offset, limit)` | `read_document(doc="paper:<id>", offset, limit)` |
| `read_paper_section(paper, heading)` | `read_document(doc="paper:<id>", heading)` |
| `get_paper_toc(paper)` | `get_document_info(doc="paper:<id>")` |
| `read_book(book, file, offset, limit)` | `read_document(doc="book:<id>", file, offset, limit)` |
| `get_book_toc(book)` | `get_document_info(doc="book:<id>")` |
| `get_chunk_context(id, chunk_order, radius)` | `read_document(doc=..., heading/offset)` |

- **数量约定**：默认 18 个；`SAGEREAD_MCP_LEGACY_TOOLS=1` 时 25 个（18 + 7）。`npm run smoke` 会分别断言两种模式。
- **启用 legacy**（Claude Desktop / Cherry Studio 等支持 `env` 的客户端）：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "npx",
      "args": ["-y", "sageread-mcp"],
      "env": { "SAGEREAD_MCP_LEGACY_TOOLS": "1" }
    }
  }
}
```

- `search_library` 是统一入口：`scope` 选库、`doc` 限定单本/单篇、`collection` 过滤论文收藏；返回的 `doc` 可直接交给 `read_document` / `get_document_info` / `get_citation_graph`。

`export_paper_citation` 的 `format` 支持 8 种格式：

- `bibtex`（默认）：`@article{}` 条目，key 为「第一作者姓+年份+标题首实词」，缺字段省略对应行
- `gbt7714`：GB/T 7714-2015 期刊格式，超 3 位作者用 et al.
- `apa`：APA 第 7 版，`Zhao, C., ... & Hu, Y.-S. (2020).` 形式，附 doi.org 链接
- `mla`：MLA 第 9 版，3 位及以上作者只写第一作者 + et al.，题名转 Title Case 加引号
- `chicago`：Chicago 参考文献表格式，第一作者倒置其余正序，超 10 位取前 7 + et al.
- `ieee`：IEEE 格式，名首字母 + 姓，超 6 位只写第一作者 + et al.
- `vancouver`：Vancouver 格式，姓 + 名首字母连写，超 6 位取前 6 + et al.，尾页缩写（708-711 → 708-11）
- `ris`：RIS 机器可读格式（Zotero/EndNote 可直接导入）

Title Case 转换（mla/chicago）做了保守处理：化学式/公式/含数字或内部大写的词（Na-ion、P2-type、$x$ 等）原样保留。

## 语义检索说明

`search_library`（legacy 下还有 `semantic_search`）需要：① SageRead 应用正在运行（启动时会写 `mcp-local.json` 本地通道凭据）；
② 已在「设置 → 向量模型」配置并选中向量模型；③ 对论文/书籍执行过向量化。

查询文本的向量化由 **SageRead 应用内执行**（用当前选中模型与 keyring 密钥），sageread-mcp 只发文本、只收回向量——**API Key 绝不进入本进程**。未启动应用/未配置模型时，工具返回带引导的降级提示而非崩溃。

- `search_library` 默认 `scope=all`（跨库）；`scope=papers/books` 只查单域；`doc=paper:<id>/book:<id>` 限定单篇/单本
- 返回每条结果的 `doc` 是统一锚点（`paper:<id>` / `book:<id>`），`片段` 是命中块内容，`下一步` 给出可直接执行的 `read_document` 调用；空结果会附 `提示`（未向量化 / 换关键词）
- `collection` 按收藏文件夹过滤论文（仅影响论文域）；显式 `doc` 与 `scope` 冲突、或指向错误类型（论文用 `book:`）时会立即报错，不会静默返回空
- 跨库检索时**空/损坏的单个向量库会被跳过**并在结果 `警告` 中列出，不会拖垮其它库；只返回能在 `books` 表解析为 DocRef 的文档，内部手册/知识库等向量目录的命中会跳过并计数
- 查询向量维度与向量索引维度不一致时，会提示在 SageRead 中重建向量索引
- **相似度数值偏低不代表没命中**：返回的「相似度」是向量距离换算值，受嵌入模型与文本长度影响很大，实测有 17% 相似度却内容完全正确的命中。**不要按相似度阈值过滤结果**，应逐条看内容与出处判断相关性

## 安装与构建

```bash
npm install
npm run build        # 产物在 dist/
npm run smoke        # 冒烟测试：默认集 18 个 + legacy 开关 25 个（连真实开发版数据库）
SAGEREAD_SMOKE_EMBED=1 npm run smoke   # 追加 search_library 的真实嵌入调用（需 SageRead 运行）
```

要求 Node.js >= 18；目前仅支持 Windows（数据目录路径按 `%APPDATA%` 解析）。

## 数据目录

- **默认自动选活动实例**：扫描 `%APPDATA%` 下所有 `com.bettersageread*` / `com.xincmm.sageread*` 数据目录（发行版目录名可能是 `com.bettersageread.app` 等变体），排除 `.bak` 备份，在含 `database\app.db` 的候选中挑「最近活动」的一个（按 `app.db` 与 `mcp-local.json` 的修改时间取较新者排序）。因此无需硬编码目录名，同时装着 Better SageRead 与上游 SageRead、或多个版本并存时也能自动连到当前在用的那个
- `--dev` 参数或 `SAGEREAD_DEV=1`：只在开发版目录（名字含 `.dev`，如 `com.bettersageread.dev`）中选活动实例
- `SAGEREAD_DB_PATH`：完全自定义 db 路径，**优先级最高**（设置后跳过上述扫描）

## 客户端配置

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "npx",
      "args": ["-y", "sageread-mcp"]
    }
  }
}
```

`--dev` 仅当你使用开发版数据目录时加（放在 args 末尾）。

### Cherry Studio

设置 → MCP 服务器 → 添加：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "npx",
      "args": ["-y", "sageread-mcp"]
    }
  }
}
```

### 从源码构建（备选）

```bash
git clone https://github.com/Feplus2/sageread-mcp.git
cd sageread-mcp
npm install
npm run build
```

然后以 `node` 直接启动（路径按实际位置替换）：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "node",
      "args": ["<path-to>/sageread-mcp/dist/index.js"]
    }
  }
}
```

### Kimi CLI

见 `config.toml` 的 `mcp_servers` 一节（stdio 类型，command + args 同上）。

### 无 MCP 客户端时直接驱动 stdio（进阶）

本 server 是标准 stdio JSON-RPC，任何能起子进程、按行读写 stdin/stdout 的 Agent 都能直接驱动（`initialize` → `notifications/initialized` → `tools/list` / `tools/call`）。

- **Windows 注意**：部分 Agent 环境（如经 Git Bash / Python 调用）里的 `node` 是 shell/cmd shim，用 `CreateProcess` 直接执行会报 `WinError 2`。此时需经 `cmd /c node ...` 包装，或在 `command` 里写 `node` 的绝对真实路径（`where node` 查）。
- 不想依赖自动扫描时，用 `SAGEREAD_DB_PATH` 显式指定 db 路径最稳妥（`search_library` 会据此反推 app 数据目录去找 `mcp-local.json`）。

## 许可证

MIT
