#!/usr/bin/env node
/**
 * sageread-mcp：SageRead 阅读数据 MCP server（只读）
 * 以 readonly 模式打开 SageRead 的 SQLite 数据库，向 AI Agent 暴露查询工具。
 * 本程序不会以任何形式写入数据库。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---------- 数据路径解析 ----------

function resolveDbPath(): string {
  if (process.env.SAGEREAD_DB_PATH) return process.env.SAGEREAD_DB_PATH;
  const dev = process.argv.includes("--dev") || process.env.SAGEREAD_DEV === "1";
  const appId = dev ? "com.xincmm.sageread.dev" : "com.xincmm.sageread";
  return path.join(os.homedir(), "AppData", "Roaming", appId, "database", "app.db");
}

const DB_PATH = resolveDbPath();
if (!fs.existsSync(DB_PATH)) {
  console.error(`[sageread-mcp] 数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

// 只读打开；fileMustExist 防止误建空库
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
console.error(`[sageread-mcp] 已连接数据库（只读）: ${DB_PATH}`);

// threads.starred 列由新版 SageRead 的迁移添加；旧库（如未升级的发行版）可能没有，防御性检测
const hasStarredColumn = (db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).some(
  (c) => c.name === "starred",
);

// threads.scope 列（'global'/'book'）同样由迁移添加
const hasScopeColumn = (db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).some(
  (c) => c.name === "scope",
);

// ---------- 类型与工具 ----------

interface BookRow {
  id: string;
  title: string;
  author: string;
  format: string;
  language: string;
  file_size: number;
  tags: string | null;
  created_at: number;
  status: string | null;
  progress_current: number | null;
  progress_total: number | null;
  last_read_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  dwell_seconds: number | null;
}

function fmtTime(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 按 id 精确匹配或书名子串（大小写不敏感）模糊找书 */
function findBook(query: string): BookRow | undefined {
  const byId = db
    .prepare(
      `SELECT b.id, b.title, b.author, b.format, b.language, b.file_size, b.tags, b.created_at,
              s.status, s.progress_current, s.progress_total, s.last_read_at, s.started_at, s.completed_at, s.dwell_seconds
       FROM books b LEFT JOIN book_status s ON s.book_id = b.id WHERE b.id = ?`,
    )
    .get(query) as BookRow | undefined;
  if (byId) return byId;
  return db
    .prepare(
      `SELECT b.id, b.title, b.author, b.format, b.language, b.file_size, b.tags, b.created_at,
              s.status, s.progress_current, s.progress_total, s.last_read_at, s.started_at, s.completed_at, s.dwell_seconds
       FROM books b LEFT JOIN book_status s ON s.book_id = b.id
       WHERE LOWER(b.title) LIKE LOWER(?) ORDER BY b.updated_at DESC LIMIT 1`,
    )
    .get(`%${query}%`) as BookRow | undefined;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function progressText(row: BookRow): string {
  const cur = row.progress_current ?? 0;
  const total = row.progress_total ?? 0;
  const pct = total > 0 ? `${Math.round((cur / total) * 100)}%` : "未知";
  return `${row.status ?? "unread"}（${pct}）`;
}

interface UIMessagePart {
  type: string;
  text?: string;
}
interface UIMessage {
  id: string;
  role: string;
  parts?: UIMessagePart[];
}

/** 把 UIMessage[] 渲染为可读文本：quote 作引用块，reasoning/tool 跳过 */
function renderMessage(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const blocks: string[] = [];
  for (const part of parts) {
    if (part?.type === "text" && part.text) {
      blocks.push(part.text.trim());
    } else if (part?.type === "quote" && part.text) {
      const quote = part.text
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
      if (quote.trim()) blocks.push(quote);
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

function getThreadById(threadId: string) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.messages, t.metadata, t.created_at, t.updated_at,
              ${hasStarredColumn ? "t.starred," : "0 AS starred,"}
              ${hasScopeColumn ? "t.scope," : "'book' AS scope,"}
              b.title AS book_title
       FROM threads t LEFT JOIN books b ON b.id = t.book_id WHERE t.id = ?`,
    )
    .get(threadId) as
    | { id: string; title: string; messages: string; metadata: string; created_at: number; updated_at: number; starred: number; scope: string; book_title: string | null }
    | undefined;
}

function parseMessages(raw: string): UIMessage[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ok(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: `错误：${message}` }], isError: true };
}

// ---------- MCP server ----------

const server = new McpServer({
  name: "sageread-mcp",
  version: "0.1.0",
});

server.tool(
  "list_books",
  "列出 SageRead 书库中的所有书籍（含阅读进度、状态、标签等），默认排除回收站中的书籍",
  { include_trashed: z.boolean().optional().describe("可选：true 时同时列出回收站中的书籍") },
  async ({ include_trashed }) => {
    let sql =
      `SELECT b.id, b.title, b.author, b.format, b.language, b.file_size, b.tags, b.created_at, b.trashed_at,
              s.status, s.progress_current, s.progress_total, s.last_read_at
       FROM books b LEFT JOIN book_status s ON s.book_id = b.id`;
    if (!include_trashed) sql += ` WHERE b.trashed_at IS NULL`;
    sql += ` ORDER BY b.updated_at DESC`;
    const rows = db.prepare(sql).all() as (BookRow & { trashed_at: number | null })[];
    return ok(
      rows.map((r) => ({
        id: r.id,
        书名: r.title,
        作者: r.author,
        格式: r.format,
        语言: r.language || null,
        文件大小: r.file_size ? `${(r.file_size / 1024 / 1024).toFixed(1)} MB` : null,
        标签: parseTags(r.tags),
        进度: progressText(r),
        最近阅读: fmtTime(r.last_read_at),
        添加时间: fmtTime(r.created_at),
        ...(r.trashed_at ? { 已删除: fmtTime(r.trashed_at) } : {}),
      })),
    );
  },
);

server.tool(
  "get_book_progress",
  "按书名（支持模糊）或 id 查询某本书的阅读进度、状态、时间线与停留时长",
  { query: z.string().describe("书名（子串即可）或书籍 id") },
  async ({ query }) => {
    const book = findBook(query);
    if (!book) return fail(`未找到匹配的书籍: ${query}`);
    return ok({
      id: book.id,
      书名: book.title,
      作者: book.author,
      格式: book.format,
      语言: book.language || null,
      标签: parseTags(book.tags),
      状态: book.status ?? "unread",
      进度: progressText(book),
      当前位置: book.progress_current ?? 0,
      总章节: book.progress_total ?? 0,
      最近阅读: fmtTime(book.last_read_at),
      开始阅读: fmtTime(book.started_at),
      完成时间: fmtTime(book.completed_at),
      当前位置停留秒数: book.dwell_seconds ?? 0,
      添加时间: fmtTime(book.created_at),
    });
  },
);

server.tool(
  "get_reading_stats",
  "统计阅读时长与次数（按今天/近7天/近30天/全部）",
  { period: z.enum(["today", "week", "month", "total"]).describe("统计周期") },
  async ({ period }) => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const since =
      period === "today" ? startOfToday : period === "week" ? now - 7 * dayMs : period === "month" ? now - 30 * dayMs : 0;

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_seconds), 0) AS seconds
         FROM reading_sessions WHERE started_at >= ?`,
      )
      .get(since) as { sessions: number; seconds: number };

    const topBooks = db
      .prepare(
        `SELECT b.title, COALESCE(SUM(s.duration_seconds), 0) AS seconds, COUNT(*) AS sessions
         FROM reading_sessions s JOIN books b ON b.id = s.book_id
         WHERE s.started_at >= ? GROUP BY s.book_id ORDER BY seconds DESC LIMIT 5`,
      )
      .all(since) as { title: string; seconds: number; sessions: number }[];

    const fmt = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.round((sec % 3600) / 60);
      return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
    };

    return ok({
      周期: period,
      总时长: fmt(summary.seconds),
      总时长秒: summary.seconds,
      阅读次数: summary.sessions,
      书籍排行: topBooks.map((b) => ({ 书名: b.title, 时长: fmt(b.seconds), 次数: b.sessions })),
    });
  },
);

server.tool(
  "list_threads",
  "列出 AI 对话（可按书籍、星标、作用域过滤）：id、标题、消息数、作用域、更新时间",
  {
    book: z.string().optional().describe("可选：书名（模糊）或书籍 id，限定只看某书的对话"),
    starred_only: z.boolean().optional().describe("可选：true 时只列出星标对话"),
    scope: z.enum(["global", "book"]).optional().describe("可选：按作用域过滤（global=全局助手, book=阅读助手）"),
  },
  async ({ book, starred_only, scope }) => {
    if (starred_only && !hasStarredColumn) {
      return fail("当前数据库没有 starred 字段（该 SageRead 版本不支持对话星标，或迁移未执行）");
    }
    if (scope && !hasScopeColumn) {
      return fail("当前数据库没有 scope 字段（该 SageRead 版本不支持对话作用域，或迁移未执行）");
    }
    let sql = `SELECT t.id, t.title, json_array_length(t.messages) AS msg_count, t.created_at, t.updated_at, b.title AS book_title
               ${hasStarredColumn ? ", t.starred" : ", 0 AS starred"}
               ${hasScopeColumn ? ", t.scope" : ", 'book' AS scope"}
               FROM threads t LEFT JOIN books b ON b.id = t.book_id`;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    if (book) {
      const found = findBook(book);
      if (!found) return fail(`未找到匹配的书籍: ${book}`);
      conditions.push(`t.book_id = ?`);
      params.push(found.id);
    }
    if (starred_only) {
      conditions.push(`t.starred = 1`);
    }
    if (scope) {
      conditions.push(`t.scope = ?`);
      params.push(scope);
    }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY t.updated_at DESC`;
    const rows = db.prepare(sql).all(...params) as {
      id: string;
      title: string;
      msg_count: number;
      created_at: number;
      updated_at: number;
      book_title: string | null;
      starred: number;
      scope: string;
    }[];
    return ok(
      rows.map((r) => ({
        id: r.id,
        标题: r.title,
        所属书籍: r.book_title ?? "（全局对话）",
        作用域: r.scope === "global" ? "全局助手" : "阅读助手",
        星标: r.starred === 1,
        消息数: r.msg_count,
        创建时间: fmtTime(r.created_at),
        更新时间: fmtTime(r.updated_at),
      })),
    );
  },
);

server.tool(
  "get_thread",
  "读取单个 AI 对话的完整内容（用户与 AI 的问答全文，含作用域与语义上下文）",
  { threadId: z.string().describe("对话 id（从 list_threads 获取）") },
  async ({ threadId }) => {
    const thread = getThreadById(threadId);
    if (!thread) return fail(`未找到对话: ${threadId}`);
    const messages = parseMessages(thread.messages);
    const body = messages
      .map((m) => {
        const text = renderMessage(m);
        return text ? `【${m.role === "user" ? "用户" : "AI"}】\n${text}` : null;
      })
      .filter(Boolean)
      .join("\n\n");
    // 解析 metadata 中的语义上下文
    let semanticContext: string | undefined;
    try {
      const meta = JSON.parse(thread.metadata || "{}");
      semanticContext = meta.semanticContext || undefined;
    } catch { /* ignore */ }
    const header = [
      `对话「${thread.title}」${thread.book_title ? `（《${thread.book_title}》）` : ""}`,
      `作用域：${thread.scope === "global" ? "全局助手" : "阅读助手"}`,
      `创建时间：${fmtTime(thread.created_at)}｜更新时间：${fmtTime(thread.updated_at)}`,
      `共 ${messages.length} 条消息`,
      ...(semanticContext ? [`语义上下文：${semanticContext}`] : []),
    ].join("\n");
    return ok(`${header}\n\n${body}`);
  },
);

server.tool(
  "list_book_notes",
  "列出某本书的划线、标注与书签（文本、笔记、颜色、类型、上下文）",
  {
    book: z.string().describe("书名（模糊）或书籍 id"),
    type: z.enum(["bookmark", "annotation", "excerpt"]).optional().describe("可选：按类型过滤"),
  },
  async ({ book, type }) => {
    const found = findBook(book);
    if (!found) return fail(`未找到匹配的书籍: ${book}`);
    let sql = `SELECT type, cfi, text, note, color, style, context_before, context_after, created_at FROM book_notes WHERE book_id = ?`;
    const params: string[] = [found.id];
    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all(...params) as {
      type: string;
      cfi: string;
      text: string | null;
      note: string;
      color: string | null;
      style: string | null;
      context_before: string | null;
      context_after: string | null;
      created_at: number;
    }[];
    if (!rows.length) return ok(`《${found.title}》没有匹配的标注记录`);
    return ok(
      rows.map((r) => ({
        类型: r.type,
        位置: r.cfi,
        划线文本: r.text,
        前文: r.context_before || null,
        后文: r.context_after || null,
        笔记: r.note || null,
        颜色: r.color,
        样式: r.style,
        时间: fmtTime(r.created_at),
      })),
    );
  },
);

server.tool(
  "export_thread_markdown",
  "把单个 AI 对话导出为 Markdown 文本（可直接交给其他工具保存/归档）",
  { threadId: z.string().describe("对话 id（从 list_threads 获取）") },
  async ({ threadId }) => {
    const thread = getThreadById(threadId);
    if (!thread) return fail(`未找到对话: ${threadId}`);
    const messages = parseMessages(thread.messages);
    const lines: string[] = [
      `# ${thread.title}`,
      "",
      ...(thread.book_title ? [`- 书名：《${thread.book_title}》`] : []),
      `- 导出时间：${fmtTime(Date.now())}`,
      `- 消息数：${messages.length}`,
      "",
      "---",
      "",
    ];
    for (const m of messages) {
      const text = renderMessage(m);
      if (!text) continue;
      lines.push(m.role === "user" ? "## 🧑 用户" : "## 🤖 AI", "", text, "");
    }
    return ok(lines.join("\n"));
  },
);

// ---------- 启动 ----------

server.tool(
  "list_tags",
  "列出书库中所有标签（名称、颜色）",
  {},
  async () => {
    const rows = db
      .prepare(`SELECT id, name, color, created_at FROM tags ORDER BY updated_at DESC`)
      .all() as { id: string; name: string; color: string | null; created_at: number }[];
    if (!rows.length) return ok("暂无标签");
    return ok(
      rows.map((r) => ({
        id: r.id,
        名称: r.name,
        颜色: r.color,
        创建时间: fmtTime(r.created_at),
      })),
    );
  },
);

server.tool(
  "list_notes",
  "列出独立笔记（支持 Markdown，可关联书籍），可按书籍过滤",
  {
    book: z.string().optional().describe("可选：书名（模糊）或书籍 id，只列出关联该书的笔记"),
  },
  async ({ book }) => {
    let sql = `SELECT n.id, n.title, n.content, n.book_id, n.book_meta, n.created_at, n.updated_at, b.title AS book_title
               FROM notes n LEFT JOIN books b ON b.id = n.book_id`;
    const params: string[] = [];
    if (book) {
      const found = findBook(book);
      if (!found) return fail(`未找到匹配的书籍: ${book}`);
      sql += ` WHERE n.book_id = ?`;
      params.push(found.id);
    }
    sql += ` ORDER BY n.updated_at DESC`;
    const rows = db.prepare(sql).all(...params) as {
      id: string;
      title: string | null;
      content: string | null;
      book_id: string | null;
      book_meta: string | null;
      created_at: number;
      updated_at: number;
      book_title: string | null;
    }[];
    if (!rows.length) return ok("没有匹配的笔记");
    return ok(
      rows.map((r) => ({
        id: r.id,
        标题: r.title || "（无标题）",
        内容预览: r.content ? r.content.slice(0, 200) + (r.content.length > 200 ? "…" : "") : null,
        关联书籍: r.book_title ?? null,
        创建时间: fmtTime(r.created_at),
        更新时间: fmtTime(r.updated_at),
      })),
    );
  },
);

server.tool(
  "get_note",
  "获取单条笔记的完整内容（Markdown 格式）",
  { noteId: z.string().describe("笔记 id（从 list_notes 获取）") },
  async ({ noteId }) => {
    const row = db
      .prepare(
        `SELECT n.id, n.title, n.content, n.book_id, n.book_meta, n.created_at, n.updated_at, b.title AS book_title
         FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.id = ?`,
      )
      .get(noteId) as {
      id: string;
      title: string | null;
      content: string | null;
      book_id: string | null;
      book_meta: string | null;
      created_at: number;
      updated_at: number;
      book_title: string | null;
    } | undefined;
    if (!row) return fail(`未找到笔记: ${noteId}`);
    const header = [
      `笔记：${row.title || "（无标题）"}`,
      ...(row.book_title ? [`关联书籍：《${row.book_title}》`] : []),
      `创建：${fmtTime(row.created_at)}｜更新：${fmtTime(row.updated_at)}`,
    ].join("\n");
    return ok(`${header}\n${"=".repeat(40)}\n${row.content || "（无内容）"}`);
  },
);

server.tool(
  "list_skills",
  "列出 AI 技能库（系统/用户自定义技能，含名称、作用域、启用状态），可选查看完整内容",
  { include_content: z.boolean().optional().describe("可选：true 时返回技能完整内容（Markdown）") },
  async ({ include_content }) => {
    const rows = db
      .prepare(`SELECT id, name, content, is_active, is_system, scope, created_at, updated_at FROM skills ORDER BY is_system DESC, updated_at DESC`)
      .all() as {
      id: string;
      name: string;
      content: string;
      is_active: number;
      is_system: number;
      scope: string;
      created_at: number;
      updated_at: number;
    }[];
    if (!rows.length) return ok("暂无技能");
    return ok(
      rows.map((r) => ({
        id: r.id,
        名称: r.name,
        类型: r.is_system ? "系统" : "用户",
        作用域: r.scope === "reader" ? "阅读助手" : r.scope === "central" ? "全局助手" : "两者",
        启用: r.is_active === 1,
        更新时间: fmtTime(r.updated_at),
        ...(include_content ? { 内容: r.content } : {}),
      })),
    );
  },
);

// ---------- 启动 ----------

const transport = new StdioServerTransport();
await server.connect(transport);
