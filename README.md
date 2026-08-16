# sageread-mcp

[Better SageRead](https://github.com/Feplus2/better-sageread) 阅读数据的 MCP server（**只读**）：让任何支持 MCP 的 AI Agent 查询你的书库、阅读进度、阅读时长、划线标注、AI 对话与论文库，并对向量库做语义检索。

Better SageRead 是基于上游 [xincmm/sageread](https://github.com/xincmm/sageread) 发展的独立维护版；本 MCP 同时兼容两者的数据目录（优先读 Better SageRead，见「数据目录」一节）。

- **数据安全**：以 `readonly` 模式打开 SageRead 的 SQLite 数据库，不会以任何形式写入，不影响 SageRead 运行
- **密钥不出 app**：语义检索的嵌入调用经 SageRead 本地通道转发，本进程不读取/不持有任何 API Key
- **SageRead 不在运行时只读工具可用**（数据是本地文件）；`semantic_search` 需应用运行（嵌入在 app 内执行）
- **论文支持**：读取论文目录、正文与分组，列出论文标注（含星标/类别/来源）
- **语义检索**：基于 SageRead 的向量库（sqlite-vec）做自然语言近邻检索
- **跨应用联动**：配合其他 MCP（如知识库类），可以让 Agent 完成"把某段阅读对话归档到知识库"这类操作

## 工具（tools）

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
| `get_paper_toc` | 论文目录（解析 paper.md 的标题层级） | `paper` 标题（模糊）或 id |
| `read_paper` | 论文正文切片（offset/limit 分段阅读） | `paper`，`offset?`，`limit?`（默认 30000，上限 60000） |
| `read_paper_section` | 按小节标题读论文章节（超 30000 字符截断并标注小节总长度） | `paper`，`heading` |
| `list_paper_folders` | 论文分组（文件夹/颜色/包含论文） | 无 |
| `list_papers` | 批量文献卡片（书目信息一览，供初筛） | `collection?`，`include_abstract?`，`limit?`（默认 50，上限 200） |
| `export_paper_citation` | 导出参考文献引用（8 种格式，见下），单篇或整个收藏文件夹 | `paper?`，`collection?`（两者至少给一个），`format?`（默认 bibtex） |
| `semantic_search` | 向量库语义检索（默认论文库） | `query`，`scope?`（papers/books/all），`paper_id?`，`collection?`（收藏文件夹过滤），`book_id?`，`top_k?`（默认 8，上限 30） |
| `get_chunk_context` | 取语义检索命中块的上下文（前后各扩 radius 块，当前块有标记） | `paper_id`，`chunk_order`，`radius?`（默认 1，上限 3） |

论文工具（`get_paper_info` / `get_paper_toc` / `read_paper` / `read_paper_section`）仅支持 MARKDOWN 格式的论文书籍，其他格式会返回明确错误。

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

`semantic_search` 需要：① SageRead 应用正在运行（启动时会写 `mcp-local.json` 本地通道凭据）；
② 已在「设置 → 向量模型」配置并选中向量模型；③ 对论文/书籍执行过向量化。

查询文本的向量化由 **SageRead 应用内执行**（用当前选中模型与 keyring 密钥），sageread-mcp 只发文本、只收回向量——**API Key 绝不进入本进程**。未启动应用/未配置模型时，工具返回带引导的降级提示而非崩溃。

- 查询向量维度与向量索引维度不一致时，会提示在 SageRead 中重建向量索引
- `collection` 按收藏文件夹过滤论文（仅影响论文域），与 `paper_id` 同给时取交集

## 安装与构建

```bash
npm install
npm run build        # 产物在 dist/
npm run smoke        # 冒烟测试（连真实开发版数据库走一遍）
SAGEREAD_SMOKE_EMBED=1 npm run smoke   # 追加 semantic_search 的真实嵌入调用
```

要求 Node.js >= 18；目前仅支持 Windows（数据目录路径按 `%APPDATA%` 解析）。

## 数据目录

- 默认读 **Better SageRead 发行版**：`%APPDATA%\com.bettersageread\database\app.db`；不存在时回退上游 SageRead（`com.xincmm.sageread`）
- `--dev` 参数或 `SAGEREAD_DEV=1`：读开发版（`com.bettersageread.dev`，回退 `com.xincmm.sageread.dev`）
- `SAGEREAD_DB_PATH`：完全自定义 db 路径

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

## 许可证

MIT
