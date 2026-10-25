import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readCanonicalWindow } from "./canonical-window.js";

export interface PaperCanonicalHeading {
  id: string;
  text: string;
  level: number;
  start: number;
  contentStart: number;
}

export interface PaperCanonical {
  body: string;
  headings: PaperCanonicalHeading[];
  metadata: Record<string, unknown>;
  frontmatterError?: string;
}

export interface PaperWindowOptions {
  heading?: string;
  offset?: number;
  before?: number;
  after?: number;
}

export interface PaperWindow {
  text: string;
  start: number;
  end: number;
  totalChars: number;
  nextOffset: number | null;
  truncated: boolean;
  anchor:
    | { kind: "start" }
    | { kind: "offset"; offset: number }
    | { kind: "heading"; heading: string };
}

export interface CanonicalMatch {
  offset: number | null;
  anchor_precision: "exact" | "section";
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|\r|$)/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const FENCE_RE = /^(```|~~~)/;
const MATH_SEGMENT_RE = /\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/g;

function normalizeDisplayMath(body: string): string {
  let out = body.replace(MATH_SEGMENT_RE, (segment) => segment.replace(/\\mum(?![a-zA-Z])/g, "\\mu\\mathrm{m}"));
  out = out.replace(
    /^\$\$([^$\r\n]+?)\$\$[ \t]*(\r?\n|$)/gm,
    (_match, content: string, newline?: string) => `$$\n${content.trim()}\n$$${newline ? "\n" : ""}`,
  );
  out = out.replace(
    /^(\$\$\r?\n)([^\r\n]*?\S)[ \t]+[（(](\d{1,3}[a-z]?)[)）][ \t]*\r?(\n\$\$)/gm,
    (match: string, open: string, content: string, num: string, close: string) =>
      content.includes("\\tag{") ? match : `${open}${content} \\tag{${num}}${close}`,
  );
  out = out.replace(
    /^(\$\$\r?\n)([^\r\n]*?)(\r?\n\$\$)\r?\n[（(](\d{1,3}[a-z]?)[)）][ \t]*([^\r\n]*)$/gm,
    (match: string, open: string, content: string, close: string, num: string, rest: string) => {
      if (content.includes("\\tag{")) return match;
      const tagged = `${open}${content} \\tag{${num}}${close}`;
      return rest ? `${tagged}\n\n${rest}` : tagged;
    },
  );
  return out;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\p{Pd} ]/gu, "")
    .replace(/ /g, "-");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

export function parsePaperCanonical(markdown: string): PaperCanonical {
  const match = markdown.match(FRONTMATTER_RE);
  let metadata: Record<string, unknown> = {};
  let frontmatterError: string | undefined;
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch (error) {
      frontmatterError = error instanceof Error ? error.message : String(error);
    }
  }
  const rawBody = match ? markdown.slice(match[0].length) : markdown;
  const body = normalizeDisplayMath(rawBody).replace(/\r\n?/g, "\n");
  const headings: PaperCanonicalHeading[] = [];
  const slugCount = new Map<string, number>();
  let offset = 0;
  let inFence = false;
  let fenceChar = "`";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceChar = trimmed.charAt(0);
      } else if (trimmed.startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) {
        const text = stripInlineMarkdown(headingMatch[2].replace(/[ \t]+#+[ \t]*$/, ""));
        if (text) {
          const base = slugify(text);
          const count = slugCount.get(base) ?? 0;
          slugCount.set(base, count + 1);
          headings.push({
            id: count === 0 ? base : `${base}-${count}`,
            text,
            level: headingMatch[1].length,
            start: offset,
            contentStart: offset + line.length + 1,
          });
        }
      }
    }
    offset += line.length + 1;
  }
  return { body, headings, metadata, ...(frontmatterError ? { frontmatterError } : {}) };
}

export function findPaperHeading(
  parsed: PaperCanonical,
  query: string,
): PaperCanonicalHeading | undefined {
  const value = query.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return (
    parsed.headings.find((heading) => heading.id && heading.id === value) ??
    parsed.headings.find((heading) => heading.text === value) ??
    parsed.headings.find((heading) => heading.text.toLowerCase() === lower) ??
    parsed.headings.find((heading) => heading.text.toLowerCase().includes(lower))
  );
}

export function readPaperWindow(markdown: string, options: PaperWindowOptions): PaperWindow {
  const parsed = parsePaperCanonical(markdown);
  const after = options.after ?? 6000;
  const before = Math.max(options.before ?? 0, 0);
  if (options.heading) {
    const heading = findPaperHeading(parsed, options.heading);
    if (!heading) {
      const available = parsed.headings.map((item) => item.text).slice(0, 20).join("；");
      throw new Error(`未找到标题「${options.heading}」。可用标题：${available || "（本文档没有章节标题）"}`);
    }
    const next = parsed.headings
      .slice(parsed.headings.indexOf(heading) + 1)
      .find((item) => item.level <= heading.level);
    const sectionEnd = next ? next.start : parsed.body.length;
    const window = readCanonicalWindow(parsed.body, {
      offset: options.offset ?? heading.contentStart,
      before: options.offset == null ? 0 : before,
      after,
      minStart: heading.contentStart,
      maxEnd: sectionEnd,
    });
    return {
      ...window,
      totalChars: parsed.body.length,
      anchor: { kind: "heading", heading: heading.text },
    };
  }
  const window = readCanonicalWindow(parsed.body, {
    offset: options.offset ?? 0,
    before: options.offset == null ? 0 : before,
    after,
  });
  return {
    ...window,
    totalChars: parsed.body.length,
    anchor: options.offset == null ? { kind: "start" } : { kind: "offset", offset: options.offset },
  };
}

interface NormalizedCanonical {
  text: string;
  originalIndices: number[];
}

function normalizeWithOriginalIndices(input: string): NormalizedCanonical {
  let text = "";
  const originalIndices: number[] = [];
  let pendingSpace: number | null = null;
  for (let index = 0; index < input.length; index += 1) {
    if (/\s/u.test(input[index])) {
      if (text.length > 0 && pendingSpace == null) pendingSpace = index;
      continue;
    }
    if (pendingSpace != null) {
      text += " ";
      originalIndices.push(pendingSpace);
      pendingSpace = null;
    }
    text += input[index];
    originalIndices.push(index);
  }
  return { text, originalIndices };
}

export function findCanonicalMatch(canonical: string, snippet: string): CanonicalMatch {
  const trimmed = snippet.trimEnd();
  const unclipped = trimmed.endsWith("…") ? trimmed.slice(0, -1) : trimmed;
  const needle = normalizeWithOriginalIndices(unclipped).text;
  if (!needle) return { offset: null, anchor_precision: "section" };
  const normalized = normalizeWithOriginalIndices(canonical);
  const matchIndex = normalized.text.indexOf(needle);
  if (matchIndex < 0 || normalized.text.indexOf(needle, matchIndex + 1) >= 0) {
    return { offset: null, anchor_precision: "section" };
  }
  const lastIndex = matchIndex + needle.length - 1;
  const offset = normalized.originalIndices[matchIndex];
  const lastOriginalIndex = normalized.originalIndices[lastIndex];
  if (offset == null || lastOriginalIndex == null) return { offset: null, anchor_precision: "section" };
  const original = canonical.slice(offset, lastOriginalIndex + 1);
  if (normalizeWithOriginalIndices(original).text !== needle) {
    return { offset: null, anchor_precision: "section" };
  }
  return { offset, anchor_precision: "exact" };
}

export interface PaperDocMetadata {
  title?: string;
  authors: string[];
  date?: string;
  published?: string;
  abstract?: string;
  keywords: string[];
  volume?: string;
  issue?: string;
  page?: string;
  language?: string;
  doi?: string;
  venue?: string;
  title_zh?: string;
  abstract_zh?: string;
  raw: Record<string, unknown> | null;
  partial: boolean;
  errors: string[];
}

export function normalizeAuthors(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((author) => {
      if (typeof author === "string") return author;
      if (author !== null && typeof author === "object" && typeof (author as { name?: unknown }).name === "string") {
        return (author as { name: string }).name;
      }
      return "";
    })
    .filter(Boolean);
}

export function normalizeKeywords(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(",").map((keyword) => keyword.trim()).filter(Boolean);
  if (!Array.isArray(raw)) return [];
  return raw.filter((keyword): keyword is string => typeof keyword === "string");
}

function metadataString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function readPaperDocMetadata(paperDir: string, markdown?: string): PaperDocMetadata {
  const errors: string[] = [];
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(paperDir, "metadata.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    } else {
      errors.push("metadata.json 必须是对象");
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      errors.push(`metadata.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const source = markdown ?? fs.readFileSync(path.join(paperDir, "paper.md"), "utf8");
    const parsed = parsePaperCanonical(source);
    frontmatter = parsed.metadata;
    if (parsed.frontmatterError) errors.push(`paper.md frontmatter 解析失败：${parsed.frontmatterError}`);
  } catch (error) {
    if (!isMissingFile(error)) {
      errors.push(`paper.md 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const invalidFields = new Set<string>();
  const scalarField = (key: string): string | undefined => {
    if (Object.hasOwn(json, key)) {
      const value = metadataString(json[key]);
      if (value !== undefined) return value;
      invalidFields.add(key);
    }
    return metadataString(frontmatter[key]);
  };
  let authors = normalizeAuthors(json.author);
  if (!authors.length) {
    if (Object.hasOwn(json, "author")) invalidFields.add("author");
    authors = normalizeAuthors(frontmatter.author);
  }
  let keywords = normalizeKeywords(json.keywords);
  if (!keywords.length) {
    if (Object.hasOwn(json, "keywords")) invalidFields.add("keywords");
    keywords = normalizeKeywords(frontmatter.keywords);
  }
  let language = metadataString(json.lang ?? json.language);
  if (language === undefined) {
    if (Object.hasOwn(json, "lang") || Object.hasOwn(json, "language")) invalidFields.add("lang");
    language = metadataString(frontmatter.lang ?? frontmatter.language);
  }
  const title = scalarField("title");
  const date = scalarField("date");
  const abstract = scalarField("abstract");
  const volume = scalarField("volume");
  const issue = scalarField("issue");
  const page = scalarField("page");
  const doi = scalarField("doi");
  const venue = scalarField("container-title");
  const titleZh = scalarField("title_zh");
  const abstractZh = scalarField("abstract_zh");
  for (const field of [...invalidFields].sort()) {
    errors.push(`metadata.json 字段 ${field} 无效，已回退 frontmatter`);
  }
  const merged = { ...frontmatter, ...json };
  return {
    title,
    authors,
    date,
    published: date,
    abstract,
    keywords,
    volume,
    issue,
    page,
    language,
    doi,
    venue,
    title_zh: titleZh,
    abstract_zh: abstractZh,
    raw: Object.keys(merged).length ? merged : null,
    partial: errors.length > 0,
    errors,
  };
}
