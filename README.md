# sageread-mcp

[SageRead](https://github.com/xincmm/sageread) 阅读数据的 MCP server（**只读**）：让任何支持 MCP 的 AI Agent 查询你的书库、阅读进度、阅读时长、划线标注与 AI 对话。

- **数据安全**：以 `readonly` 模式打开 SageRead 的 SQLite 数据库，不会以任何形式写入，不影响 SageRead 运行
- **SageRead 不在运行也能用**（数据是本地文件）
- **跨应用联动**：配合其他 MCP（如知识库类），可以让 Agent 完成"把某段阅读对话归档到知识库"这类操作

## 工具（tools）

| 工具 | 说明 | 参数 |
|---|---|---|
| `list_books` | 书库全部书籍（含进度状态） | 无 |
| `get_book_progress` | 单本书进度 | `query` 书名（模糊）或 id |
| `get_reading_stats` | 阅读时长/次数统计 | `period`: today / week / month / total |
| `list_threads` | AI 对话列表 | `book?` 可按书过滤；`starred_only?` 只看星标 |
| `get_thread` | 对话完整内容 | `threadId` |
| `list_book_notes` | 划线/标注/书签 | `book`，`type?` |
| `export_thread_markdown` | 对话导出为 Markdown | `threadId` |

## 安装与构建

```bash
npm install
npm run build        # 产物在 dist/
npm run smoke        # 冒烟测试（连真实数据库走一遍）
```

要求 Node.js >= 18。

## 数据目录

- 默认读**发行版**：`%APPDATA%\com.xincmm.sageread\database\app.db`
- `--dev` 参数或 `SAGEREAD_DEV=1`：读开发版（`com.xincmm.sageread.dev`）
- `SAGEREAD_DB_PATH`：完全自定义 db 路径

## 客户端配置

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "node",
      "args": ["F:/MyProjects/sageread-mcp/dist/index.js"]
    }
  }
}
```

### Cherry Studio

设置 → MCP 服务器 → 添加：

```json
{
  "mcpServers": {
    "sageread": {
      "command": "node",
      "args": ["F:/MyProjects/sageread-mcp/dist/index.js", "--dev"]
    }
  }
}
```

### Kimi CLI

见 `config.toml` 的 `mcp_servers` 一节（stdio 类型，command + args 同上）。

## 许可证

AGPL-3.0（与 SageRead 一致）
