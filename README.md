# sageread-mcp

[Better SageRead](https://github.com/Feplus2/better-sageread) 阅读数据的 MCP server（**只读**）：让任何支持 MCP 的 AI Agent 查询你的书库、阅读进度、阅读时长、划线标注、AI 对话与论文库，并对向量库做语义检索。

Better SageRead 是基于上游 [xincmm/sageread](https://github.com/xincmm/sageread) 发展的独立维护版；本 MCP 同时兼容两者的数据目录（优先读 Better SageRead，见「数据目录」一节）。

- **数据安全**：以 `readonly` 模式打开 SageRead 的 SQLite 数据库，不写入数据库；BM25 统计也实时只读计算，不写 `bm25_stats`
- **密钥不出 app**：语义检索的嵌入调用经 SageRead 本地通道转发，本进程不读取/不持有任何 API Key
- **离线可用**：应用不在运行时仍能读 SQLite、`paper.md` 与 EPUB；`search_library` 自动按标题/关键词回退，未索引文档也能搜索
- **论文支持**：完整 JSON/frontmatter 字段级元数据回退、canonical 目录与连续正文窗口、分组、标注和 8 种引用格式
- **书籍直读**：Node 直接解析 EPUB 的 OPF/spine/nav，保留公式、表格和图片；无 EPUB 时回退 mdbook 原文
- **图片直读**：论文图片清单与安全绝对路径解析；书籍/论文单图、多图经标准 MCP `image` content 返回，支持缩放与批量预算
- **混合检索**：`search_library` 合并 sqlite-vec、BM25 与关键词/标题结果，命中带可重放 `read` 锚点和有界 `next_cursor`
- **跨应用联动**：配合其他 MCP（如知识库类），可以让 Agent 完成"把某段阅读对话归档到知识库"这类操作

## 工具（tools）

0.3.0 起默认只注册 **20 个现代精简工具**，覆盖「浏览书库 → 检索内容 → 读原文/插图 → 查引用」的主路径。旧工具收进 `SAGEREAD_MCP_LEGACY_TOOLS` 开关，避免新旧工具并列造成 Agent 选择困难；迁移对照见下一节。

### 默认现代精简集（20 个）

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
| `search_library` | **统一检索**：语义 + BM25 + 关键词/标题互补，命中带 `read` 与续页游标 | `query`，`scope?`（all/papers/books，默认 all），`doc?`，`collection?`，`top_k?`（默认 6，上限 30），`vector_weight?`（0.7），`bm25_weight?`（0.3），`include_references?`（false），`cursor?` |
| `get_document_info` | 统一 DocRef 的完整元数据、目录、图表与参考文献数、索引状态；损坏元数据返回 `partial/errors` | `doc`: `book:<id>` 或 `paper:<id>` |
| `list_paper_figures` | 论文 Markdown/HTML 图片清单：路径、图注、小节、全量计数与分页 | `doc`: `paper:<id>`，`offset?`（图片序号），`limit?`（默认/上限 50） |
| `read_images` | 真正读取书籍/论文图片，返回 JPEG 图片本体与路径/尺寸信封；支持单图和多图 | `doc`，`paths`（1–6 个绝对路径），`max_edge?`（默认 1024，512–1536） |
| `read_document` | 统一 DocRef 读 canonical 窗口；返回 `read/range/text/next_offset` | `doc`，`heading?`，`file?`，`spine?`，`fragment?`，`offset?`，`before?`（上限 8000），`after?` / `limit?`（默认 6000，上限 30000） |
| `get_citation_graph` | 库内引用关系：它引用了库里哪些论文 / 库里谁引用了它（按 DOI/标题匹配 References，无需向量索引） | `doc`: `paper:<id>`，`include_cited_by?` |

论文与书籍统一用 `doc` 锚点表达：论文 `paper:<id>`、书籍 `book:<id>`；`get_document_info` 返回目录，`read_document` 按目录读正文，`search_library` 的命中结果同样带 `doc` 锚点。论文工具只支持 MARKDOWN 格式的论文书籍，`book:<id>` 指向论文或 `paper:<id>` 指向普通书籍时，DocRef 工具会返回明确的重定向提示。

### 文档坐标、元数据与图片缓存

- 所有现代 offset 都是 JavaScript UTF-16 字符坐标，`range` 为半开区间 `[start,end)`。`read` 可原样回传；续读把上次 `next_offset` 放进 `offset`，不要自行加减。
- **论文**：canonical 去除 frontmatter、统一 CRLF/CR 为 LF 并规范化 display math。`heading` 首窗从该节 `contentStart` 开始，后续 `next_offset` 始终是正文绝对坐标，并限制在该节边界；无 `heading` 时 `offset` 也是正文绝对坐标。`before/after` 可围绕命中扩窗。
- **书籍**：`heading/file/spine/fragment + offset` 使用节内 canonical；`fragment` 区分同一 XHTML 的多个 nav 锚点。无这些锚点时的显式 `offset` 使用全书 canonical，可按 spine 连续跨章读取。各节以 `\n\n` 拼接，公式、表格、图片 `src/alt` 保留。图片路径在切片之后解析，不改变 offset。全书 canonical 上限为 16M 字符，超过时请按章节读取。
- **元数据**：`metadata.json` 按字段优先，`paper.md` frontmatter 补齐缺失字段；不存在 JSON 不是错误，损坏或不可读 JSON 会进入 `partial/errors`，不会静默覆盖可用 frontmatter。
- **论文图片路径**：`read_document` 先按 canonical 切片，再把窗口内实际存在且位于论文目录内的相对图片路径改写为绝对路径；缺失文件、外部 URL、data URI 和越界路径保持原样。路径改写不影响任何 offset，但可能改变返回 `text` 的长度，因此不能再用 `range` 去切改写后的文本，续读必须重放 `read`。`list_paper_figures` 同时扫描 Markdown 与 HTML `<img>`，每条含 `image/image_path/caption/captionFrom/section/offset`；无法解析到真实文件时 `image_path=null`。`total_found` 是全量图片数，`total` 是本页数量，`offset/limit` 按图片序号分页（不是 canonical 字符坐标），`next_offset` 用于续页。`orphanCaptions` 只统计未归属且带明确编号的 Figure/Fig/图 图注样式行，不统计 Table 或普通正文句。
- **图片内容**：`read_images(doc, paths, max_edge?)` 接受 1–6 个绝对路径，论文仅限本篇目录，书籍仅限本书目录和本书 `{appDir}/image-cache/epub/<bookId>/`。同时校验词法路径与真实路径，拒绝目录穿越、symlink/junction 越界、其他书籍缓存和伪造图片。每张源图不超过 20 MiB，使用 sharp 解码、自动旋转并输出 JPEG；透明图以白色铺底。默认长边 1024，可选 512–1536；批量 base64 总预算 700,000 字符，按张数摊分并进一步压缩。每张图返回文本信封与标准 MCP `image` content，单张失败不抹掉同批成功图片；部分失败会在首条文本和末尾清单同时标明，全部失败才标记 `isError`。
- **图片缓存**：仅当返回窗口内的 EPUB 图片在 mdbook 中缺盘时，才物化该图片到 `{appDir}/image-cache/epub/<bookId>/<sha256>.<ext>`。路径由书籍与解析后的资源 href 决定，同书同资源复用；不整书预提取。响应的 `图片缓存` 披露目录与用途。缓存暂无容量/时间清理策略。Better SageRead 0.5.0 会另行负责 MCP 图片落盘与模型协议回灌，本 MCP 不判断模型视觉能力。

### 旧工具（legacy，默认关闭，7 个）

设置环境变量 `SAGEREAD_MCP_LEGACY_TOOLS=1` 后**额外**注册以下 7 个旧工具（与默认集合计 27 个），仅建议旧客户端/旧提示词兼容使用：

| 旧工具 | 说明 | 默认集替代 |
|---|---|---|
| `semantic_search` | 向量库语义检索（默认论文库） | `search_library` |
| `get_paper_toc` | 论文目录（解析 paper.md 标题层级） | `get_document_info` |
| `read_paper` | 论文正文切片（offset/limit 分段） | `read_document` |
| `read_paper_section` | 按小节标题读论文章节 | `read_document`（`heading`） |
| `get_book_toc` | 书籍（EPUB）目录（nav.md 层级） | `get_document_info` |
| `read_book` | 读取书籍某章正文（file + offset/limit） | `read_document`（`file` + `offset`） |
| `get_chunk_context` | 语义检索命中块前后各扩 radius 块；目标参数接受 `id` 或 `book_id` 别名 | `read_document`（按 `heading`/`offset` 精读；legacy 下仍可精确取块上下文） |

旧工具代码与行为全部保留，只是默认不出现在 `tools/list` 中；开关在进程启动时读取，切换后需重启 MCP 客户端。Legacy `read_paper/read_book` 仍用原始 `paper.md` / mdbook Markdown offset，与现代 canonical 坐标不互换；legacy `semantic_search` 仍默认 8 条、只走向量通道并保留旧输出，不获得现代关键词回退、混合权重或游标。

### 工具面迁移与 legacy 开关

| 旧调用（0.2.0） | 0.3.0 默认写法 |
|---|---|
| `semantic_search(query, scope, paper_id/collection/book_id, top_k)` | `search_library(query, scope, doc, collection, top_k)` |
| `read_paper(paper, offset, limit)` | `read_document(doc="paper:<id>", offset, limit)` |
| `read_paper_section(paper, heading)` | `read_document(doc="paper:<id>", heading)` |
| `get_paper_toc(paper)` | `get_document_info(doc="paper:<id>")` |
| `read_book(book, file, offset, limit)` | `read_document(doc="book:<id>", file, offset, limit)` |
| `get_book_toc(book)` | `get_document_info(doc="book:<id>")` |
| `get_chunk_context(id 或 book_id, chunk_order, radius)` | `read_document(doc=..., heading/offset)` |

- **数量约定**：默认 20 个；`SAGEREAD_MCP_LEGACY_TOOLS=1` 时 27 个（20 + 7）。`npm run smoke` 会分别断言两种模式。
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

## 检索、回退与续页

`search_library` 默认 `scope=all`，也可选 `papers/books`；`doc=paper:<id>/book:<id>` 限定单篇/单本，`collection` 过滤论文收藏。`doc` 与 `scope` 冲突、DocRef 类型错误或 cursor 用在 `doc` 模式都会明确报错。

真实嵌入通道可用时，查询文本由 **SageRead 应用内执行向量化**（当前模型与 keyring 密钥），本进程只发文本、只收回向量，API Key 不进入 MCP。应用未运行、未配置模型或设置 `SAGEREAD_DISABLE_EMBED=1` 时，不会让整个检索失败：标题/关键词通道仍返回结果，并在 `errors/警告` 与 `partial` 中披露 indexed 通道不可用。Legacy `semantic_search` 不受这个离线开关以外的回退影响，仍要求嵌入通道。

- **参数**：`top_k` 默认 6、最大 30（直接调用也强制截断）；`vector_weight=0.7`、`bm25_weight=0.3` 会归一化并参与实际评分和跨书排序；`include_references=false` 默认排除 References/参考文献。旧向量库缺少 `is_references` 列时会明确警告，不会直接 SQL 失败。
- **命中**：每条同时保留中文字段并提供 `doc/snippet/similarity/source/index/read/anchor_precision`。`source` 为 `hybrid/bm25/keyword/title`；`index` 区分 `indexed/not_indexed`；只有经验证的唯一 canonical 位置才是 `exact` 并带 offset，重复或无法验证时降级为 `section`，不伪造位置。`hit.read` 可直接传给 `read_document`，再叠加 `before/after`。
- **无向量回退**：`doc` 模式完整扫描单文档；library/all 完整发现标题，并对未索引正文做有界并发、章节数、时间和结果数限制，不无界解压全库 EPUB。`partial/truncated`、回退统计和提取错误会如实返回，indexed 通道失败不会抹掉关键词成功结果。
- **续页**：library/all 返回确定性的无状态 `next_cursor`，继续时原样回传 `cursor`。游标绑定 `query/scope/collection/include_references`，错误组合会拒绝；`doc` 模式不使用 cursor。merge/RRF 只记录实际发出的 section-aware 命中，被首页挤掉的 fallback 可在后续页补发，直到游标消失；首页与续页都保留 `partial/truncated`。
- **只读与降级**：损坏或维度不匹配的单个向量库会进入 `errors/警告`，不拖垮其它库；内部手册等无法解析为 DocRef 的命中会跳过。BM25 实时计算，不写统计缓存。
- **不要机械按分数过滤**：现代分数混合向量、BM25 与关键词/标题通道，legacy 分数来自向量距离；语义分数低也可能是正确内容，应结合片段与出处判断。

## 安装与构建

```bash
npm install
npm run clean && npm run build
node --test scripts/test-document-images.mjs  # 图片路径、清单、真实图片内容、批量预算与安全边界
node scripts/test-document-contract.mjs   # canonical、元数据、连续窗口、结构/图片
node scripts/test-search-library.mjs      # 命中扩窗、回退、参数、merge/RRF 与游标
npm run smoke                             # 开发库；默认 20 / legacy 27，并强制验证无向量回退
SAGEREAD_SMOKE_EMBED=1 npm run smoke      # 开发库真实嵌入，必须出现 hybrid 命中
npm run smoke -- --release                # 发行版库 + 无向量回退
SAGEREAD_SMOKE_EMBED=1 npm run smoke -- --release  # 发行版库真实嵌入
npm pack --dry-run                        # 检查实际发布文件
```

`npm run smoke` 默认用 `SAGEREAD_DISABLE_EMBED=1` 验证无向量路径；`SAGEREAD_SMOKE_EMBED=1` 才启用并要求真实 hybrid 命中，避免把关键词成功误当成向量成功。真实嵌入不可用时应视为对应验收未通过，不能用降级结果代替。

要求 Node.js >= 20.9.0（sharp 0.35 的运行下限）；目前仅支持 Windows（数据目录路径按 `%APPDATA%` 解析）。

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
