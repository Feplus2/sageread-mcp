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
import { parse as parseYaml } from "yaml";
import { semanticSearch } from "./semantic-search.js";

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

// 应用数据目录（app.db 位于 {appDir}/database/app.db）；论文正文、向量库等都在 appDir 下
const APP_DIR = path.dirname(path.dirname(DB_PATH));

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

// book_notes 的 starred/category/source 三列由新版 SageRead 迁移添加；旧库没有时退回旧 SELECT
const bookNotesColumns = new Set(
  (db.prepare("PRAGMA table_info(book_notes)").all() as { name: string }[]).map((c) => c.name),
);
const hasNoteMetaColumns = ["starred", "category", "source"].every((c) => bookNotesColumns.has(c));

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

/**
 * 论文标注的 cfi 是 JSON {"v":1,"segments":[{"b":块索引,"s":起点,"e":终点}]}；
 * 能解析成该结构时渲染为可读形式，否则原样返回
 */
function renderCfi(cfi: string): string {
  try {
    const obj = JSON.parse(cfi) as { v?: number; segments?: { b?: unknown; s?: unknown; e?: unknown }[] };
    if (
      obj &&
      Array.isArray(obj.segments) &&
      obj.segments.length > 0 &&
      obj.segments.every(
        (seg) => typeof seg?.b === "number" && typeof seg?.s === "number" && typeof seg?.e === "number",
      )
    ) {
      return obj.segments.map((seg) => `论文块#${seg.b} 字符[${seg.s},${seg.e})`).join("; ");
    }
  } catch {
    // 非 JSON，按原样输出
  }
  return cfi;
}

// ---------- 论文（MARKDOWN 书籍）辅助 ----------

/** 论文正文路径：{appDir}/books/{bookId}/paper.md */
function paperMdPath(bookId: string): string {
  return path.join(APP_DIR, "books", bookId, "paper.md");
}

/** 找论文：必须是 MARKDOWN 格式的书籍，否则返回明确错误文案 */
function findPaper(query: string): { paper?: BookRow; error?: string } {
  const book = findBook(query);
  if (!book) return { error: `未找到匹配的书籍: ${query}` };
  if (book.format !== "MARKDOWN") {
    return { error: `《${book.title}》不是论文（格式为 ${book.format}）：论文工具仅支持 MARKDOWN 格式的论文书籍` };
  }
  return { paper: book };
}

/** 读取 paper.md 全文；文件缺失时返回错误文案 */
function readPaperMd(bookId: string): { content?: string; error?: string } {
  const file = paperMdPath(bookId);
  if (!fs.existsSync(file)) {
    return { error: `论文正文不存在（${file}）：该论文可能尚未完成转换，请在 SageRead 中重新打开或转换后再试` };
  }
  return { content: fs.readFileSync(file, "utf8") };
}

interface PaperHeading {
  level: number;
  text: string;
  charStart: number;
}

/** 解析 paper.md 的 ATX 标题（^#{1,6} ），返回级别/文本/起始字符位置 */
function parsePaperHeadings(content: string): PaperHeading[] {
  const headings: PaperHeading[] = [];
  const re = /^(#{1,6}) +(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    headings.push({ level: m[1].length, text: m[2].trim(), charStart: m.index });
  }
  return headings;
}

/** 解析 paper.md 顶部的 YAML frontmatter（--- 包裹）；解析失败返回空对象 */
function parsePaperFrontmatter(content: string): Record<string, unknown> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const doc: unknown = parseYaml(m[1]);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 读取 books/{bookId}/metadata.json（若存在），目前只取 title_zh/abstract_zh */
function readPaperMetaJson(bookId: string): { title_zh?: string; abstract_zh?: string } {
  const file = path.join(APP_DIR, "books", bookId, "metadata.json");
  if (!fs.existsSync(file)) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      title_zh: typeof doc.title_zh === "string" ? doc.title_zh : undefined,
      abstract_zh: typeof doc.abstract_zh === "string" ? doc.abstract_zh : undefined,
    };
  } catch {
    return {};
  }
}

/** frontmatter 作者字段归一化为字符串数组（支持 "name" 或 {name: "..."} 两种形态） */
function normalizeAuthors(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      if (typeof a === "string") return a;
      if (a !== null && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
        return (a as { name: string }).name;
      }
      return "";
    })
    .filter(Boolean);
}

/** 关键词字段归一化为字符串数组（支持数组或逗号分隔字符串） */
function normalizeKeywords(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(",").map((k) => k.trim()).filter(Boolean);
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string");
}

/** 论文所属文件夹名称列表（paper_folders JOIN folders） */
function paperFolderNames(paperId: string): string[] {
  return (
    db
      .prepare(
        `SELECT f.name FROM paper_folders pf JOIN folders f ON f.id = pf.folder_id
         WHERE pf.paper_id = ? AND f.trashed_at IS NULL ORDER BY f.name`,
      )
      .all(paperId) as { name: string }[]
  ).map((r) => r.name);
}

/** 按 id 精确、名称精确（大小写不敏感）、名称子串的优先级找文件夹 */
function findFolder(query: string): { id: string; name: string } | undefined {
  const byId = db
    .prepare(`SELECT id, name FROM folders WHERE id = ? AND trashed_at IS NULL`)
    .get(query) as { id: string; name: string } | undefined;
  if (byId) return byId;
  const byName = db
    .prepare(`SELECT id, name FROM folders WHERE trashed_at IS NULL AND LOWER(name) = LOWER(?) LIMIT 1`)
    .get(query) as { id: string; name: string } | undefined;
  if (byName) return byName;
  return db
    .prepare(
      `SELECT id, name FROM folders WHERE trashed_at IS NULL AND LOWER(name) LIKE LOWER(?) ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(`%${query}%`) as { id: string; name: string } | undefined;
}

/** 全部可用文件夹名（用于错误提示） */
function listFolderNames(): string[] {
  return (
    db
      .prepare(`SELECT name FROM folders WHERE trashed_at IS NULL ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

// ---------- 引用格式化辅助 ----------

/** frontmatter 标量字段取字符串（number 也转），空则 null */
function fmStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v;
  if (typeof v === "number") return String(v);
  return null;
}

/** "Chenglong Zhao" → { family: "Zhao", given: "Chenglong" }（按最后一个空格分，无空格原名作 family） */
function splitName(full: string): { family: string; given: string } {
  const i = full.lastIndexOf(" ");
  if (i < 0) return { family: full, given: "" };
  return { family: full.slice(i + 1), given: full.slice(0, i) };
}

/** BibTeX 姓名："Chenglong Zhao" → "Zhao, Chenglong" */
function bibtexName(full: string): string {
  const { family, given } = splitName(full);
  return given ? `${family}, ${given}` : full;
}

/** GB/T 7714 姓名缩写："Yong-Sheng Hu" → "Hu Y S"（名取首字母大写，无空格原名照给） */
function gbtName(full: string): string {
  const { family, given } = splitName(full);
  if (!given) return full;
  const initials = given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join(" ");
  return `${family} ${initials}`;
}

/** 从日期字符串取 4 位年份，取不到返回 null */
function extractYear(date: string | null): string | null {
  return date?.match(/\d{4}/)?.[0] ?? null;
}

const BIBTEX_STOPWORDS = new Set([
  "a", "an", "the", "of", "on", "in", "for", "and", "or", "to", "with", "by", "at", "from", "as", "is",
]);

/** BibTeX key：第一作者姓小写 + 年份 + 标题首个实词小写（去标点），如 zhao2020rational */
function bibtexKey(authors: string[], year: string | null, title: string): string {
  const family = authors.length
    ? splitName(authors[0]).family.toLowerCase().replace(/[^a-z0-9]/g, "")
    : "anon";
  const word =
    title
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())
      .find((w) => w && !BIBTEX_STOPWORDS.has(w)) ?? "untitled";
  return `${family}${year ?? ""}${word}`;
}

/** 生成 BibTeX @article 条目（缺字段省略对应行） */
function formatBibtex(fm: Record<string, unknown>, authors: string[]): string {
  const title = fmStr(fm.title) ?? "";
  const year = extractYear(fmStr(fm.date));
  const keywords = normalizeKeywords(fm.keywords);
  const fields: [string, string][] = [
    ["title", title],
    ["author", authors.map(bibtexName).join(" and ")],
  ];
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const page = fmStr(fm.page);
  const doi = fmStr(fm.doi);
  if (journal) fields.push(["journal", journal]);
  if (year) fields.push(["year", year]);
  if (volume) fields.push(["volume", volume]);
  if (issue) fields.push(["number", issue]);
  if (page) fields.push(["pages", page]);
  if (doi) fields.push(["doi", doi]);
  if (keywords.length) fields.push(["keywords", keywords.join(", ")]);
  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
  return `@article{${bibtexKey(authors, year, title)},\n${body}\n}`;
}

/** 生成 GB/T 7714-2015 期刊文章条目（作者超 3 位用 et al.；缺卷/期/页相应段省略） */
function formatGbt7714(fm: Record<string, unknown>, authors: string[]): string {
  const names = authors.map(gbtName);
  const authorStr = names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al.` : names.join(", ");
  const title = fmStr(fm.title) ?? "";
  const year = extractYear(fmStr(fm.date));
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const page = fmStr(fm.page);
  const volIssue = volume ? (issue ? `${volume}(${issue})` : volume) : issue ? `(${issue})` : null;
  let ref = `${authorStr}${authorStr.endsWith(".") ? " " : ". "}${title}[J].`;
  const segs: string[] = [];
  if (journal) segs.push(journal);
  if (year) segs.push(year);
  if (volIssue) segs.push(volIssue);
  if (segs.length) {
    ref += ` ${segs.join(", ")}`;
    if (page) ref += `: ${page}`;
    ref += ".";
  }
  return ref;
}

/** APA 姓名："Yong-Sheng Hu" → "Hu, Y.-S."（连字符名各取首字母带点连写） */
function apaName(full: string): string {
  const { family, given } = splitName(full);
  if (!given) return full;
  const initials = given
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .filter(Boolean)
        .map((p) => `${p[0].toUpperCase()}.`)
        .join("-"),
    )
    .join(" ");
  return `${family}, ${initials}`;
}

/** IEEE 姓名："Chenglong Zhao" → "C. Zhao"（名首字母在前） */
function ieeeName(full: string): string {
  const { family, given } = splitName(full);
  if (!given) return full;
  const initials = given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(" ");
  return `${initials} ${family}`;
}

/** Vancouver 姓名："Yong-Sheng Hu" → "Hu YS"（姓 + 名首字母连写，无句点） */
function vancouverName(full: string): string {
  const { family, given } = splitName(full);
  if (!given) return full;
  const initials = given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join("");
  return `${family} ${initials}`;
}

/** 作者串与后文的分隔：串本身以句点结尾（如 "et al."）时只补空格 */
function authorSep(authorStr: string): string {
  return authorStr.endsWith(".") ? " " : ". ";
}

/** 拆分页码区间："708-711" → { sp: "708", ep: "711" }；单页 ep 为 null */
function splitPages(page: string | null): { sp: string; ep: string | null } | null {
  if (!page) return null;
  const m = page.match(/^\s*(\S+?)\s*[-–—]\s*(\S+)\s*$/);
  if (m) return { sp: m[1], ep: m[2] };
  return { sp: page.trim(), ep: null };
}

/** Vancouver 尾页缩写：708-711 → 708-11；123-145 → 123-45（尾页只保留与首页不同的末位数字） */
function shortenPageRange(sp: string, ep: string): string {
  let i = 0;
  while (i < sp.length && i < ep.length && sp[i] === ep[i]) i++;
  return `${sp}-${ep.slice(i) || ep}`;
}

const TITLECASE_SMALL_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "from", "by", "of", "in", "with", "as", "via",
]);

/**
 * 保守 Title Case（MLA/Chicago 用）：
 * 含数字/公式字符（[0-9${}\\]）或非首字母大写的 token 原样保留（Na-ion、P2-type、$x$、NaLi1/3Mn2/3O2）；
 * 小词（a/an/the/and/of/...）除非首末词否则小写；连字符词按段分别处理（sodium-ion → Sodium-Ion）
 */
function toTitleCase(title: string): string {
  const parts = title.split(/(\s+)/);
  const wordIndexes = parts.map((p, i) => (/\S/.test(p) ? i : -1)).filter((i) => i >= 0);
  if (!wordIndexes.length) return title;
  const first = wordIndexes[0];
  const last = wordIndexes[wordIndexes.length - 1];
  return parts
    .map((part, i) => {
      if (!/\S/.test(part)) return part;
      const isEdge = i === first || i === last;
      return part
        .split("-")
        .map((seg, j) => {
          if (!seg) return seg;
          if (/[0-9${}\\]/.test(seg) || /[A-Z]/.test(seg.slice(1))) return seg;
          const lower = seg.toLowerCase();
          if (!isEdge && TITLECASE_SMALL_WORDS.has(lower)) return lower;
          return lower[0].toUpperCase() + lower.slice(1);
        })
        .join("-");
    })
    .join("");
}

/** APA 第 7 版：Zhao, C., Wang, Q., ..., & Hu, Y.-S. (2020). Title. Science, 370(6517), 708-711. https://doi.org/... */
function formatApa(fm: Record<string, unknown>, authors: string[]): string {
  const names = authors.map(apaName);
  const authorStr =
    names.length > 20
      ? `${names.slice(0, 19).join(", ")}, ... ${names[names.length - 1]}`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`
        : (names[0] ?? "");
  const year = extractYear(fmStr(fm.date));
  const title = fmStr(fm.title) ?? "";
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const page = fmStr(fm.page);
  const doi = fmStr(fm.doi);
  let ref = `${authorStr}${year ? ` (${year}).` : "."} ${title}.`;
  if (journal) {
    ref += ` ${journal}`;
    const volIssue = volume ? (issue ? `${volume}(${issue})` : volume) : issue ? `(${issue})` : null;
    if (volIssue) ref += `, ${volIssue}`;
    if (page) ref += `, ${page}`;
    ref += ".";
  }
  if (doi) ref += ` https://doi.org/${doi}`;
  return ref;
}

/** MLA 第 9 版：Zhao, Chenglong, et al. "Title Case." Science, vol. 370, no. 6517, 2020, pp. 708-711. */
function formatMla(fm: Record<string, unknown>, authors: string[]): string {
  const authorStr =
    authors.length >= 3
      ? `${bibtexName(authors[0])}, et al.`
      : authors.length === 2
        ? `${bibtexName(authors[0])}, and ${authors[1]}`
        : bibtexName(authors[0]);
  const title = toTitleCase(fmStr(fm.title) ?? "");
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const year = extractYear(fmStr(fm.date));
  const page = fmStr(fm.page);
  let ref = `${authorStr}${authorSep(authorStr)}"${title}."`;
  const segs: string[] = [];
  if (journal) segs.push(journal);
  if (volume) segs.push(`vol. ${volume}`);
  if (issue) segs.push(`no. ${issue}`);
  if (year) segs.push(year);
  if (page) segs.push(`pp. ${page}`);
  if (segs.length) ref += ` ${segs.join(", ")}.`;
  return ref;
}

/** Chicago 参考文献表：Zhao, Chenglong, Qidi Wang, et al. "Title." Science 370, no. 6517 (2020): 708-711. https://doi.org/... */
function formatChicago(fm: Record<string, unknown>, authors: string[]): string {
  const listed = authors.length > 10 ? authors.slice(0, 7) : authors;
  let authorStr = [bibtexName(listed[0]), ...listed.slice(1)].join(", ");
  if (authors.length > 10) authorStr += ", et al.";
  const title = toTitleCase(fmStr(fm.title) ?? "");
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const year = extractYear(fmStr(fm.date));
  const page = fmStr(fm.page);
  const doi = fmStr(fm.doi);
  let ref = `${authorStr}${authorSep(authorStr)}"${title}."`;
  if (journal) {
    ref += ` ${journal}`;
    if (volume) ref += ` ${volume}`;
    if (issue) ref += `, no. ${issue}`;
    if (year) ref += ` (${year})`;
    if (page) ref += `: ${page}`;
    ref += ".";
  } else if (year) {
    ref += ` (${year}).`;
  }
  if (doi) ref += ` https://doi.org/${doi}`;
  return ref;
}

/** IEEE：C. Zhao, et al., "Title," Science, vol. 370, no. 6517, pp. 708-711, 2020, doi: ... （>6 位作者只写第一作者 + et al.） */
function formatIeee(fm: Record<string, unknown>, authors: string[]): string {
  const authorStr =
    authors.length > 6 ? `${ieeeName(authors[0])}, et al.` : authors.map(ieeeName).join(", ");
  const title = fmStr(fm.title) ?? "";
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const year = extractYear(fmStr(fm.date));
  const page = fmStr(fm.page);
  const doi = fmStr(fm.doi);
  let ref = `${authorStr}, "${title},"`;
  if (journal) ref += ` ${journal}`;
  if (volume) ref += `, vol. ${volume}`;
  if (issue) ref += `, no. ${issue}`;
  if (page) ref += `, pp. ${page}`;
  if (year) ref += `, ${year}`;
  if (doi) ref += `, doi: ${doi}`;
  ref += ".";
  return ref;
}

/** Vancouver：Zhao C, Wang Q, et al. Title. Science. 2020;370(6517):708-11.（>6 位前 6 + et al.；尾页缩写） */
function formatVancouver(fm: Record<string, unknown>, authors: string[]): string {
  const names = authors.map(vancouverName);
  const authorStr = names.length > 6 ? `${names.slice(0, 6).join(", ")}, et al.` : names.join(", ");
  const title = fmStr(fm.title) ?? "";
  const journal = fmStr(fm["container-title"]);
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const year = extractYear(fmStr(fm.date));
  const pages = splitPages(fmStr(fm.page));
  let ref = `${authorStr}${authorSep(authorStr)}${title}.`;
  if (journal) {
    ref += ` ${journal}.`;
    let tail = "";
    if (year) tail += year;
    if (volume) tail += `;${issue ? `${volume}(${issue})` : volume}`;
    if (pages) tail += `:${pages.ep ? shortenPageRange(pages.sp, pages.ep) : pages.sp}`;
    if (tail) ref += ` ${tail}.`;
  }
  return ref;
}

/** RIS（Zotero/EndNote 可导入）：TY/TI/AU（每位一行，倒置）/T2/PY/VL/IS/SP/EP/DO/KW（每个一行）/ER */
function formatRis(fm: Record<string, unknown>, authors: string[]): string {
  const lines = [`TY  - JOUR`, `TI  - ${fmStr(fm.title) ?? ""}`];
  for (const a of authors) lines.push(`AU  - ${bibtexName(a)}`);
  const journal = fmStr(fm["container-title"]);
  const year = extractYear(fmStr(fm.date));
  const volume = fmStr(fm.volume);
  const issue = fmStr(fm.issue);
  const pages = splitPages(fmStr(fm.page));
  const doi = fmStr(fm.doi);
  if (journal) lines.push(`T2  - ${journal}`);
  if (year) lines.push(`PY  - ${year}`);
  if (volume) lines.push(`VL  - ${volume}`);
  if (issue) lines.push(`IS  - ${issue}`);
  if (pages) {
    lines.push(`SP  - ${pages.sp}`);
    if (pages.ep) lines.push(`EP  - ${pages.ep}`);
  }
  if (doi) lines.push(`DO  - ${doi}`);
  for (const k of normalizeKeywords(fm.keywords)) lines.push(`KW  - ${k}`);
  lines.push(`ER  - `);
  return lines.join("\n");
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
    let sql = `SELECT type, cfi, text, note, color, style, context_before, context_after, created_at
               ${hasNoteMetaColumns ? ", starred, category, source" : ""}
               FROM book_notes WHERE book_id = ?`;
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
      starred?: number;
      category?: string | null;
      source?: string | null;
    }[];
    if (!rows.length) return ok(`《${found.title}》没有匹配的标注记录`);
    return ok(
      rows.map((r) => ({
        类型: r.type,
        位置: renderCfi(r.cfi),
        划线文本: r.text,
        前文: r.context_before || null,
        后文: r.context_after || null,
        笔记: r.note || null,
        颜色: r.color,
        样式: r.style,
        ...(hasNoteMetaColumns
          ? { 星标: r.starred === 1, 类别: r.category ?? null, 来源: r.source ?? null }
          : {}),
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

// ---------- 论文工具 ----------

server.tool(
  "get_paper_info",
  "获取论文的书目元数据（paper.md 的 YAML frontmatter + metadata.json 的中文标题/摘要 + 收藏文件夹），字段保持 Pandoc/CSL 原义，适合文献筛选与引用列表",
  { paper: z.string().describe("论文标题（模糊）或论文 id") },
  async ({ paper }) => {
    const { paper: found, error } = findPaper(paper);
    if (!found) return fail(error!);
    const { content, error: readError } = readPaperMd(found.id);
    if (content === undefined) return fail(readError!);
    const fm = parsePaperFrontmatter(content);
    const metaZh = readPaperMetaJson(found.id);
    const authors = normalizeAuthors(fm.author);
    const keywords = normalizeKeywords(fm.keywords);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);
    return ok({
      id: found.id,
      书名: str(fm.title) ?? found.title,
      作者: authors.length ? authors : null,
      日期: str(fm.date),
      期刊: str(fm["container-title"]),
      卷: str(fm.volume),
      期: str(fm.issue),
      页: str(fm.page),
      DOI: str(fm.doi),
      关键词: keywords.length ? keywords : null,
      摘要: str(fm.abstract),
      中文标题: metaZh.title_zh ?? null,
      中文摘要: metaZh.abstract_zh ?? null,
      收藏: paperFolderNames(found.id),
    });
  },
);

server.tool(
  "get_paper_toc",
  "获取论文的目录结构（解析 paper.md 的 Markdown 标题，按层级缩进展示）",
  { paper: z.string().describe("论文标题（模糊）或论文 id") },
  async ({ paper }) => {
    const { paper: found, error } = findPaper(paper);
    if (!found) return fail(error!);
    const { content, error: readError } = readPaperMd(found.id);
    if (content === undefined) return fail(readError!);
    const headings = parsePaperHeadings(content);
    if (!headings.length) return ok(`《${found.title}》的 paper.md 中没有 Markdown 标题`);
    const lines = headings.map(
      (h) => `${"  ".repeat(h.level - 1)}H${h.level} ${h.text}`,
    );
    return ok(`《${found.title}》目录（共 ${headings.length} 个标题）：\n${lines.join("\n")}`);
  },
);

server.tool(
  "read_paper",
  "读取论文正文（paper.md 的字符切片，用 offset/limit 分段阅读长文）",
  {
    paper: z.string().describe("论文标题（模糊）或论文 id"),
    offset: z.number().int().min(0).optional().describe("可选：起始字符位置，默认 0"),
    limit: z.number().int().min(1).max(60000).optional().describe("可选：读取字符数，默认 30000，上限 60000"),
  },
  async ({ paper, offset, limit }) => {
    const { paper: found, error } = findPaper(paper);
    if (!found) return fail(error!);
    const { content, error: readError } = readPaperMd(found.id);
    if (content === undefined) return fail(readError!);
    const start = offset ?? 0;
    const size = limit ?? 30000;
    if (start >= content.length) {
      return fail(`offset ${start} 超出全文长度（共 ${content.length} 字符）`);
    }
    const slice = content.slice(start, start + size);
    const truncated = start + size < content.length;
    return ok(
      slice + (truncated ? `\n\n(已截断，下一 offset=${start + size}，全文共 ${content.length} 字符)` : ""),
    );
  },
);

server.tool(
  "read_paper_section",
  "按小节标题读取论文的对应章节内容（标题子串匹配，截 30000 字符）",
  {
    paper: z.string().describe("论文标题（模糊）或论文 id"),
    heading: z.string().describe("小节标题（子串匹配第一个命中的 Markdown 标题）"),
  },
  async ({ paper, heading }) => {
    const { paper: found, error } = findPaper(paper);
    if (!found) return fail(error!);
    const { content, error: readError } = readPaperMd(found.id);
    if (content === undefined) return fail(readError!);
    const headings = parsePaperHeadings(content);
    const needle = heading.toLowerCase();
    const target = headings.find((h) => h.text.toLowerCase().includes(needle));
    if (!target) {
      const available = headings.length
        ? headings.map((h) => `${"  ".repeat(h.level - 1)}- ${h.text}`).join("\n")
        : "（本文没有任何 Markdown 标题）";
      return fail(`未找到匹配标题「${heading}」的小节，可选标题：\n${available}`);
    }
    // 到下一个同级或更高级标题前为止
    const next = headings.find((h) => h.charStart > target.charStart && h.level <= target.level);
    const section = content.slice(target.charStart, next ? next.charStart : content.length);
    const truncated = section.length > 30000;
    return ok(
      section.slice(0, 30000) + (truncated ? `\n\n(已截断，本小节共 ${section.length} 字符)` : ""),
    );
  },
);

server.tool(
  "list_paper_folders",
  "列出论文分组（文件夹）：名称、颜色、包含的论文 id 与标题",
  {},
  async () => {
    const folderColumns = new Set(
      (db.prepare("PRAGMA table_info(folders)").all() as { name: string }[]).map((c) => c.name),
    );
    const hasColor = folderColumns.has("color");
    const rows = db
      .prepare(
        `SELECT f.id AS folder_id, f.name AS folder_name,
                ${hasColor ? "f.color AS folder_color," : "NULL AS folder_color,"}
                pf.paper_id, b.title AS paper_title
         FROM paper_folders pf
         JOIN folders f ON f.id = pf.folder_id
         LEFT JOIN books b ON b.id = pf.paper_id
         WHERE f.trashed_at IS NULL
         ORDER BY f.name, pf.paper_id`,
      )
      .all() as {
      folder_id: string;
      folder_name: string;
      folder_color: string | null;
      paper_id: string;
      paper_title: string | null;
    }[];
    if (!rows.length) return ok("暂无论文分组（还没有论文被放入文件夹）");
    const grouped = new Map<string, { 名称: string; 颜色: string | null; 论文: { id: string; 标题: string | null }[] }>();
    for (const r of rows) {
      let g = grouped.get(r.folder_id);
      if (!g) {
        g = { 名称: r.folder_name, 颜色: r.folder_color, 论文: [] };
        grouped.set(r.folder_id, g);
      }
      g.论文.push({ id: r.paper_id, 标题: r.paper_title ?? "（未知论文）" });
    }
    return ok([...grouped.values()]);
  },
);

server.tool(
  "list_papers",
  "批量列出论文文献卡片（书目信息一览，供初筛；默认不含摘要）",
  {
    collection: z.string().optional().describe("可选：文件夹名（子串）或 id，只列出该收藏内的论文"),
    include_abstract: z.boolean().optional().describe("可选：true 时每篇附摘要与中摘要（各截 300 字符），默认 false"),
    limit: z.number().int().min(1).max(200).optional().describe("可选：最多返回篇数，默认 50，上限 200"),
  },
  async ({ collection, include_abstract, limit }) => {
    let collectionIds: Set<string> | undefined;
    if (collection) {
      const folder = findFolder(collection);
      if (!folder) {
        const names = listFolderNames();
        return fail(
          `未找到匹配的文件夹: ${collection}${names.length ? `，可选文件夹：${names.join("、")}` : "（当前没有任何文件夹）"}`,
        );
      }
      collectionIds = new Set(
        (
          db.prepare(`SELECT paper_id FROM paper_folders WHERE folder_id = ?`).all(folder.id) as {
            paper_id: string;
          }[]
        ).map((r) => r.paper_id),
      );
    }
    const rows = db
      .prepare(
        `SELECT id, title, author FROM books WHERE format = 'MARKDOWN' AND trashed_at IS NULL ORDER BY updated_at DESC`,
      )
      .all() as { id: string; title: string; author: string | null }[];
    const matched = collectionIds ? rows.filter((r) => collectionIds.has(r.id)) : rows;
    const max = limit ?? 50;
    const shown = matched.slice(0, max);
    const cards = shown.map((row) => {
      const folders = paperFolderNames(row.id);
      // paper.md 读取失败时降级为只给 books 表字段，不中断
      const { content } = readPaperMd(row.id);
      if (content === undefined) {
        return {
          id: row.id,
          书名: row.title,
          作者: row.author || null,
          日期: null,
          期刊: null,
          DOI: null,
          关键词: null,
          中文标题: null,
          收藏: folders,
          备注: "paper.md 缺失，仅给出书库字段",
        };
      }
      const fm = parsePaperFrontmatter(content);
      const metaZh = readPaperMetaJson(row.id);
      const authors = normalizeAuthors(fm.author);
      const keywords = normalizeKeywords(fm.keywords);
      const authorText =
        authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.length ? authors.join(", ") : null;
      const cut = (s: string | undefined | null) => (s ? s.slice(0, 300) + (s.length > 300 ? "…" : "") : null);
      return {
        id: row.id,
        书名: fmStr(fm.title) ?? row.title,
        作者: authorText,
        日期: fmStr(fm.date),
        期刊: fmStr(fm["container-title"]),
        DOI: fmStr(fm.doi),
        关键词: keywords.length ? keywords : null,
        中文标题: metaZh.title_zh ?? null,
        收藏: folders,
        ...(include_abstract ? { 摘要: cut(fmStr(fm.abstract)), 中文摘要: cut(metaZh.abstract_zh) } : {}),
      };
    });
    return ok({ 说明: `共 ${matched.length} 篇，已显示 ${cards.length} 篇`, 论文: cards });
  },
);

server.tool(
  "export_paper_citation",
  "导出论文的参考文献引用文本（bibtex / gbt7714 / apa / mla / chicago / ieee / vancouver / ris 期刊格式），可指定单篇或整个收藏文件夹，结果可直接复制进参考文献列表",
  {
    paper: z.string().optional().describe("可选：论文标题（模糊）或论文 id；与 collection 同时给时优先"),
    collection: z.string().optional().describe("可选：文件夹名（子串）或 id，导出整个收藏的论文"),
    format: z
      .enum(["bibtex", "gbt7714", "apa", "mla", "chicago", "ieee", "vancouver", "ris"])
      .optional()
      .describe("可选：引用格式，默认 bibtex"),
  },
  async ({ paper, collection, format }) => {
    if (!paper && !collection) {
      return fail("paper 与 collection 至少给一个");
    }
    let targets: { id: string; title: string }[] = [];
    if (paper) {
      const { paper: found, error } = findPaper(paper);
      if (!found) return fail(error!);
      targets = [{ id: found.id, title: found.title }];
    } else {
      const folder = findFolder(collection!);
      if (!folder) {
        const names = listFolderNames();
        return fail(
          `未找到匹配的文件夹: ${collection}${names.length ? `，可选文件夹：${names.join("、")}` : "（当前没有任何文件夹）"}`,
        );
      }
      targets = db
        .prepare(
          `SELECT b.id, b.title FROM paper_folders pf JOIN books b ON b.id = pf.paper_id
           WHERE pf.folder_id = ? AND b.format = 'MARKDOWN' AND b.trashed_at IS NULL ORDER BY b.title`,
        )
        .all(folder.id) as { id: string; title: string }[];
      if (!targets.length) return ok(`文件夹「${folder.name}」内没有论文`);
    }
    const refs: string[] = [];
    let skipped = 0;
    for (const t of targets) {
      const { content } = readPaperMd(t.id);
      const fm = content !== undefined ? parsePaperFrontmatter(content) : {};
      const authors = normalizeAuthors(fm.author);
      // 缺关键字段（无 title 或 author）的篇目跳过
      if (!fmStr(fm.title) || !authors.length) {
        skipped++;
        continue;
      }
      switch (format ?? "bibtex") {
        case "gbt7714":
          refs.push(formatGbt7714(fm, authors));
          break;
        case "apa":
          refs.push(formatApa(fm, authors));
          break;
        case "mla":
          refs.push(formatMla(fm, authors));
          break;
        case "chicago":
          refs.push(formatChicago(fm, authors));
          break;
        case "ieee":
          refs.push(formatIeee(fm, authors));
          break;
        case "vancouver":
          refs.push(formatVancouver(fm, authors));
          break;
        case "ris":
          refs.push(formatRis(fm, authors));
          break;
        default:
          refs.push(formatBibtex(fm, authors));
      }
    }
    const body = refs.length ? refs.join("\n\n") : "（没有可导出的引用）";
    return ok(body + (skipped ? `\n\n（跳过 ${skipped} 篇缺少 title/author 的论文）` : ""));
  },
);

// ---------- 语义检索 ----------

server.tool(
  "semantic_search",
  "对 SageRead 向量库做语义检索（默认论文库；需已配置嵌入模型，未配置时返回降级提示）",
  {
    query: z.string().describe("查询文本（自然语言，将以当前嵌入模型向量化后做近邻检索）"),
    scope: z.enum(["papers", "books", "all"]).optional().describe("可选：检索范围（papers=论文库, books=书籍库, all=全部），默认 papers"),
    paper_id: z.string().optional().describe("可选：限定单篇论文 id（仅对论文库生效）"),
    collection: z.string().optional().describe("可选：限定某个收藏文件夹内的论文（文件夹名子串或 id，仅对论文域生效；与 paper_id 同给时取交集）"),
    book_id: z.string().optional().describe("可选：限定单本书 id（仅对书籍库生效）"),
    top_k: z.number().int().min(1).max(30).optional().describe("可选：返回条数，默认 8，上限 30"),
  },
  async ({ query, scope, paper_id, collection, book_id, top_k }) => {
    try {
      // collection → 文件夹成员 paper_id 集合（scope=books 时无意义，忽略）
      let paperIds: string[] | undefined;
      if (collection && (scope ?? "papers") !== "books") {
        const folder = findFolder(collection);
        if (!folder) {
          const names = listFolderNames();
          return fail(
            `未找到匹配的文件夹: ${collection}${names.length ? `，可选文件夹：${names.join("、")}` : "（当前没有任何文件夹）"}`,
          );
        }
        paperIds = (
          db.prepare(`SELECT paper_id FROM paper_folders WHERE folder_id = ?`).all(folder.id) as {
            paper_id: string;
          }[]
        ).map((r) => r.paper_id);
      }
      const result = await semanticSearch(APP_DIR, {
        query,
        scope: scope ?? "papers",
        paperId: paper_id,
        paperIds,
        bookId: book_id,
        topK: top_k ?? 8,
      });
      return ok(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "get_chunk_context",
  "按块序号取语义检索命中块的上下文（前后各扩 radius 块拼接，当前块有标记）；论文与书籍均支持",
  {
    paper_id: z.string().describe("论文/书籍 id 或书名（模糊）；对应 semantic_search 结果 出处.id"),
    chunk_order: z.number().int().min(0).describe("命中块的序号（semantic_search 结果 块位置 的分子，即 chunk_order_in_file）"),
    radius: z.number().int().min(0).max(3).optional().describe("可选：前后各扩几块，默认 1，上限 3"),
  },
  async ({ paper_id, chunk_order, radius }) => {
    const found = findBook(paper_id);
    if (!found) return fail(`未找到匹配的书籍: ${paper_id}`);
    const r = radius ?? 1;
    const isPaper = found.format === "MARKDOWN";
    // 论文共用 {appDir}/papers/vectors.sqlite；书籍一书一库
    const dbPath = isPaper
      ? path.join(APP_DIR, "papers", "vectors.sqlite")
      : path.join(APP_DIR, "books", found.id, "vectors.sqlite");
    if (!fs.existsSync(dbPath)) {
      return fail(`向量库不存在（${dbPath}）：请先在 SageRead 里对该${isPaper ? "论文" : "书籍"}执行向量化后再试`);
    }
    const vdb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      interface ChunkContextRow {
        chunk_order_in_file: number;
        total_chunks_in_file: number | null;
        md_file_path: string | null;
        chunk_text: string | null;
      }
      // 先定位目标块（书籍库可能有多个 md 文件，用其 md_file_path 约束区间，避免跨文件拼接）
      const target = (
        isPaper
          ? vdb
              .prepare(
                `SELECT chunk_order_in_file, total_chunks_in_file, md_file_path, chunk_text
                 FROM document_chunks WHERE paper_id = ? AND chunk_order_in_file = ?`,
              )
              .all(found.id, chunk_order)
          : vdb
              .prepare(
                `SELECT chunk_order_in_file, total_chunks_in_file, md_file_path, chunk_text
                 FROM document_chunks WHERE chunk_order_in_file = ?`,
              )
              .all(chunk_order)
      )[0] as ChunkContextRow | undefined;
      if (!target) return fail(`未找到块 ${chunk_order}：该向量库中没有此序号的块`);
      const rows = (
        isPaper
          ? vdb
              .prepare(
                `SELECT chunk_order_in_file, total_chunks_in_file, md_file_path, chunk_text
                 FROM document_chunks
                 WHERE paper_id = ? AND md_file_path IS ? AND chunk_order_in_file BETWEEN ? AND ?
                 ORDER BY chunk_order_in_file`,
              )
              .all(found.id, target.md_file_path, chunk_order - r, chunk_order + r)
          : vdb
              .prepare(
                `SELECT chunk_order_in_file, total_chunks_in_file, md_file_path, chunk_text
                 FROM document_chunks
                 WHERE md_file_path IS ? AND chunk_order_in_file BETWEEN ? AND ?
                 ORDER BY chunk_order_in_file`,
              )
              .all(target.md_file_path, chunk_order - r, chunk_order + r)
      ) as ChunkContextRow[];
      const total = target.total_chunks_in_file ?? "?";
      const header = `《${found.title}》块上下文（当前块 ${chunk_order}/${total}，前后各扩 ${r} 块，共 ${rows.length} 块）：`;
      const body = rows
        .map((row) =>
          row.chunk_order_in_file === chunk_order
            ? `>>> 【当前块 ${row.chunk_order_in_file}/${row.total_chunks_in_file ?? "?"}】<<<\n${row.chunk_text ?? ""}`
            : `【块 ${row.chunk_order_in_file}/${row.total_chunks_in_file ?? "?"}】\n${row.chunk_text ?? ""}`,
        )
        .join("\n\n");
      return ok(`${header}\n\n${body}`);
    } finally {
      vdb.close();
    }
  },
);

// ---------- 启动 ----------

const transport = new StdioServerTransport();
await server.connect(transport);
