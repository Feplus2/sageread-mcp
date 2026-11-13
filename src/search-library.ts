import fs from "node:fs";
import path from "node:path";
import { readBookSectionCanonical } from "./book-document.js";
import { findCanonicalMatch, parsePaperCanonical, type PaperCanonical } from "./paper-document.js";
import { searchIndexed, type IndexedChunk } from "./semantic-search.js";
import {
  decodeFallbackCursor,
  encodeFallbackCursor,
  fallbackHitCursorKey,
  searchKeywordFallback,
  type FallbackDocRef,
  type FallbackSearchResult,
  type FallbackStats,
  type SearchDocument,
} from "./search-fallback.js";

export type LibrarySource = "hybrid" | "bm25" | "keyword" | "title";
export type AnchorPrecision = "exact" | "section";

export interface LibraryReadAnchor {
  doc: string;
  heading?: string;
  spine?: number;
  fragment?: string;
  offset?: number;
}

export interface LibraryHit {
  doc: string;
  kind: "book" | "paper";
  title: string | null;
  chapter: string | null;
  snippet: string;
  chunk_id: number | null;
  similarity: number;
  source: LibrarySource;
  index: { status: "indexed" | "not_indexed"; note?: string };
  read: LibraryReadAnchor;
  anchor_precision: AnchorPrecision;
  rank?: number;
  相似度: string;
  片段: string;
  类型: "论文" | "书籍";
  标题: string | null;
  作者: string | null;
  章节: string | null;
  文件: string | null;
  块位置: string;
}

export function clipSnippet(text: string, maxChars = 400): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function similarityPercent(distance: number): { number: number; text: string } {
  const value = (1 - distance) * 100;
  return { number: Number.parseFloat(value.toFixed(1)), text: `${value.toFixed(1)}%` };
}

function paperHeadingAt(parsed: PaperCanonical, offset: number): string | null {
  for (let index = 0; index < parsed.headings.length; index += 1) {
    const heading = parsed.headings[index];
    const next = parsed.headings[index + 1];
    if (offset >= heading.start && (next == null || offset < next.start)) return heading.text;
  }
  return null;
}

function paperSectionRanges(parsed: PaperCanonical): { heading: string | null; start: number; end: number }[] {
  const ranges: { heading: string | null; start: number; end: number }[] = [];
  const first = parsed.headings[0];
  if (!first) return [{ heading: null, start: 0, end: parsed.body.length }];
  if (first.start > 0) ranges.push({ heading: null, start: 0, end: first.start });
  for (let index = 0; index < parsed.headings.length; index += 1) {
    const heading = parsed.headings[index];
    ranges.push({
      heading: heading.text,
      start: heading.contentStart,
      end: parsed.headings[index + 1]?.start ?? parsed.body.length,
    });
  }
  return ranges.filter((range) => range.end > range.start);
}

function normalizedSnippet(value: string): string {
  const trimmed = value.trimEnd();
  return (trimmed.endsWith("…") ? trimmed.slice(0, -1) : trimmed).replace(/\s+/gu, " ").trim();
}

function baseHit(
  chunk: IndexedChunk,
  kind: "book" | "paper",
  id: string,
): Omit<LibraryHit, "chapter" | "read" | "anchor_precision" | "章节"> {
  const { row } = chunk;
  const similarity = similarityPercent(row.distance);
  const snippet = clipSnippet(row.chunk_text ?? "");
  return {
    doc: `${kind}:${id}`,
    kind,
    title: row.book_title || null,
    snippet,
    chunk_id: row.id,
    similarity: similarity.number,
    source: row.searchChannel ?? "hybrid",
    index: { status: "indexed" },
    相似度: similarity.text,
    片段: snippet,
    类型: kind === "paper" ? "论文" : "书籍",
    标题: row.book_title || null,
    作者: row.book_author || null,
    文件: row.md_file_path ? path.basename(row.md_file_path) : null,
    块位置: `${row.chunk_order_in_file ?? "?"}/${row.total_chunks_in_file ?? "?"}`,
  };
}

async function paperChunkToLibraryHit(appDir: string, chunk: IndexedChunk): Promise<LibraryHit | null> {
  const id = chunk.row.paper_id;
  if (!id) return null;
  const base = baseHit(chunk, "paper", id);
  const markdown = fs.readFileSync(path.join(appDir, "books", id, "paper.md"), "utf8");
  const parsed = parsePaperCanonical(markdown);
  const content = chunk.row.chunk_text ?? "";
  const direct = findCanonicalMatch(parsed.body, content);
  let read: LibraryReadAnchor = { doc: base.doc };
  let precision: AnchorPrecision = "section";
  let chapter: string | null = null;
  if (direct.offset != null) {
    read = { doc: base.doc, offset: direct.offset };
    precision = "exact";
    chapter = paperHeadingAt(parsed, direct.offset);
  } else {
    const candidates: { heading: string; offset: number | null }[] = [];
    for (const range of paperSectionRanges(parsed)) {
      if (!range.heading) continue;
      const text = parsed.body.slice(range.start, range.end);
      const local = findCanonicalMatch(text, content);
      if (local.offset != null) {
        candidates.push({ heading: range.heading, offset: range.start + local.offset });
      } else if (
        normalizedSnippet(content) &&
        text.replace(/\s+/gu, " ").includes(normalizedSnippet(content))
      ) {
        candidates.push({ heading: range.heading, offset: null });
      }
    }
    if (candidates.length === 1) {
      const candidate = candidates[0];
      chapter = candidate.heading;
      if (candidate.offset != null) {
        read = { doc: base.doc, offset: candidate.offset };
        precision = "exact";
      } else {
        read = { doc: base.doc, heading: candidate.heading };
      }
    }
  }
  return { ...base, chapter, 章节: chapter, read, anchor_precision: precision };
}

async function bookChunkToLibraryHit(appDir: string, chunk: IndexedChunk): Promise<LibraryHit | null> {
  const id = chunk.fallbackBookId;
  if (!id) return null;
  const base = baseHit(chunk, "book", id);
  const bookDir = path.join(appDir, "books", id);
  let chapter = chunk.row.related_chapter_titles || null;
  let read: LibraryReadAnchor = chapter ? { doc: base.doc, heading: chapter } : { doc: base.doc, offset: 0 };
  let precision: AnchorPrecision = "section";
  let canonical = await readBookSectionCanonical(
    bookDir,
    chapter ? { heading: chapter } : chunk.row.md_file_path ? { file: chunk.row.md_file_path } : { spine: 0 },
  ).catch(() => null);
  if (canonical?.kind !== "ok" && chunk.row.md_file_path) {
    canonical = await readBookSectionCanonical(bookDir, { file: chunk.row.md_file_path }).catch(() => null);
  }
  if (canonical?.kind === "ok") {
    chapter = canonical.matchedTitle;
    read = {
      doc: base.doc,
      heading: canonical.matchedTitle,
      spine: canonical.spineIndex,
      ...(canonical.fragment ? { fragment: canonical.fragment } : {}),
    };
    const matched = findCanonicalMatch(canonical.text, chunk.row.chunk_text ?? "");
    if (matched.offset != null) {
      read.offset = matched.offset;
      precision = "exact";
    }
  } else if (canonical?.kind === "ambiguous") {
    read = { doc: base.doc, offset: 0 };
  }
  return { ...base, chapter, 章节: chapter, read, anchor_precision: precision };
}

export async function indexedChunkToLibraryHit(appDir: string, chunk: IndexedChunk): Promise<LibraryHit | null> {
  return chunk.row.paper_id ? paperChunkToLibraryHit(appDir, chunk) : bookChunkToLibraryHit(appDir, chunk);
}

export interface SearchLibraryOptions {
  query: string;
  scope: "all" | "papers" | "books";
  doc?: FallbackDocRef;
  collection?: string;
  paperIds?: string[];
  documents: SearchDocument[];
  topK: number;
  vectorWeight?: number;
  bm25Weight?: number;
  includeReferences?: boolean;
  cursor?: string;
}

export interface SearchLibraryResult {
  results: LibraryHit[];
  total: number;
  book_total?: number;
  paper_total?: number;
  partial: boolean;
  truncated: boolean;
  fallback: Partial<Record<"book" | "paper", FallbackStats | null>>;
  search_config: {
    top_k: number;
    vector_weight: number;
    bm25_weight: number;
    include_references: boolean;
  };
  next_cursor?: string;
  errors: string[];
  note?: string;
}

interface IndexedOutcome {
  hits: LibraryHit[];
  warnings: string[];
}

interface MergedHits {
  hits: LibraryHit[];
  truncated: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hitKey(hit: LibraryHit): string {
  return fallbackHitCursorKey(hit);
}

function mergeHits(indexed: LibraryHit[], fallback: LibraryHit[], topK: number): MergedHits {
  const seen = new Set<string>();
  const merged = [...indexed, ...fallback]
    .filter((hit) => {
      const key = hitKey(hit);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => right.hit.similarity - left.hit.similarity || left.index - right.index)
    .map(({ hit }) => hit);
  return { hits: merged.slice(0, topK), truncated: merged.length > topK };
}

function mergeByRrf(paperResults: LibraryHit[], bookResults: LibraryHit[], topK: number): LibraryHit[] {
  return [
    ...paperResults.map((item, index) => ({ ...item, kind: "paper" as const, rank: index + 1 })),
    ...bookResults.map((item, index) => ({ ...item, kind: "book" as const, rank: index + 1 })),
  ]
    .map((item) => ({ ...item, rrf: 1 / (60 + item.rank) }))
    .sort((left, right) => right.rrf - left.rrf)
    .slice(0, topK)
    .map(({ rank: _rank, rrf: _rrf, ...item }) => item);
}

function finalizeFallbackCursor(
  options: SearchLibraryOptions,
  fallback: FallbackSearchResult | null,
  emittedHits: LibraryHit[],
  previousCursor: string | undefined,
  kind: "book" | "paper",
): string | undefined {
  if (!fallback) return undefined;
  void previousCursor;
  void kind;
  const finalKeys = new Set(emittedHits.map(fallbackHitCursorKey));
  const dropped = fallback.hits.filter((hit) => !finalKeys.has(fallbackHitCursorKey(hit)));
  const state = { ...(fallback.nextCursor?.state ?? fallback.state) };
  state.pending = [...dropped, ...state.pending];
  if (!fallback.nextCursor && state.pending.length === 0) return undefined;
  return encodeFallbackCursor(state);
}

interface CursorChannels {
  paper?: string | null;
  book?: string | null;
}

function parseCursorChannels(input: string | undefined, kind?: "book" | "paper"): CursorChannels {
  if (!input) return {};
  if (kind) return { [kind]: input };
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cursor must be an object");
    for (const [key, value] of Object.entries(parsed)) {
      if ((key !== "paper" && key !== "book") || (value !== null && typeof value !== "string")) {
        throw new Error("unknown cursor channel");
      }
    }
    return parsed as CursorChannels;
  } catch (error) {
    throw new Error(`跨库检索 cursor 无效: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function searchLibrary(appDir: string, options: SearchLibraryOptions): Promise<SearchLibraryResult> {
  const vectorWeight = options.vectorWeight ?? 0.7;
  const bm25Weight = options.bm25Weight ?? 0.3;
  const weightTotal = vectorWeight + bm25Weight;
  options = {
    ...options,
    topK: Math.min(Math.max(options.topK ?? 6, 1), 30),
    vectorWeight: weightTotal > 0 ? vectorWeight / weightTotal : 0.7,
    bm25Weight: weightTotal > 0 ? bm25Weight / weightTotal : 0.3,
  };
  const includeReferences = options.includeReferences ?? false;
  const searchConfig = {
    top_k: options.topK,
    vector_weight: options.vectorWeight ?? 0.7,
    bm25_weight: options.bm25Weight ?? 0.3,
    include_references: includeReferences,
  };
  const allowedIds = new Set(options.documents.map((document) => document.id));

  const indexedForKind = async (kind: "book" | "paper", single?: FallbackDocRef): Promise<IndexedOutcome> => {
    const result = await searchIndexed(appDir, {
      query: options.query,
      scope: kind === "paper" ? "papers" : "books",
      paperId: single?.kind === "paper" ? single.id : undefined,
      paperIds: kind === "paper" ? options.paperIds : undefined,
      bookId: single?.kind === "book" ? single.id : undefined,
      topK: options.topK,
      vectorWeight: options.vectorWeight,
      bm25Weight: options.bm25Weight,
      includeReferences,
    });
    const warnings = [...result.warnings];
    const hits: LibraryHit[] = [];
    let skippedInternal = 0;
    for (const chunk of result.chunks) {
      const id = chunk.row.paper_id || chunk.fallbackBookId;
      if (!id || !allowedIds.has(id)) {
        skippedInternal += 1;
        continue;
      }
      const hit = await indexedChunkToLibraryHit(appDir, chunk);
      if (hit) hits.push(hit);
    }
    if (skippedInternal) warnings.push(`已跳过 ${skippedInternal} 条非书库文档的命中（内部手册/知识库等）`);
    return { hits, warnings };
  };

  const fallbackForKind = (kind: "book" | "paper", single?: FallbackDocRef, cursor?: string) =>
    searchKeywordFallback({
      appDir,
      documents: options.documents,
      kind,
      target: single,
      query: options.query,
      scope: options.scope,
      collection: options.collection,
      paperIds: options.paperIds,
      topK: options.topK,
      includeReferences,
      cursor,
    });

  const searchOneKind = async (
    kind: "book" | "paper",
    single: FallbackDocRef | undefined,
    channelCursor?: string,
  ): Promise<SearchLibraryResult> => {
    const continuing = typeof channelCursor === "string";
    const [indexedSettled, fallbackSettled] = await Promise.allSettled([
      continuing ? Promise.resolve({ hits: [], warnings: [] } as IndexedOutcome) : indexedForKind(kind, single),
      fallbackForKind(kind, single, channelCursor),
    ]);
    const indexed = indexedSettled.status === "fulfilled" ? indexedSettled.value : { hits: [], warnings: [] };
    const fallback = fallbackSettled.status === "fulfilled" ? fallbackSettled.value : null;
    const merged = mergeHits(indexed.hits, fallback?.hits ?? [], options.topK);
    const errors = [
      ...indexed.warnings,
      ...(indexedSettled.status === "rejected" ? [`索引检索失败：${errorText(indexedSettled.reason)}`] : []),
      ...(fallbackSettled.status === "rejected" ? [`关键词回退失败：${errorText(fallbackSettled.reason)}`] : []),
      ...(fallback?.errors ?? []),
    ];
    const nextCursor = finalizeFallbackCursor(options, fallback, merged.hits, channelCursor, kind);
    return {
      results: merged.hits,
      total: merged.hits.length,
      partial: indexedSettled.status === "rejected" || (fallback?.partial ?? fallbackSettled.status === "rejected"),
      truncated: merged.truncated || (fallback?.truncated ?? false),
      fallback: { [kind]: fallback?.stats ?? null },
      search_config: searchConfig,
      next_cursor: nextCursor,
      errors: uniqueStrings(errors),
      note: merged.hits.length ? undefined : "没有命中：换关键词，或用 get_document_info 看目录后 read_document 精读。",
    };
  };

  const validateChannelCursor = (kind: "book" | "paper", cursor: string | undefined) => {
    if (cursor) {
      decodeFallbackCursor({
        kind,
        query: options.query,
        scope: options.scope,
        collection: options.collection,
        includeReferences,
        cursor,
      });
    }
  };

  if (options.doc) {
    if (options.cursor) throw new Error("current/doc 不支持 library/all cursor；请省略 cursor 重试");
    return searchOneKind(options.doc.kind, options.doc);
  }
  if (options.scope === "papers" || options.scope === "books") {
    const kind = options.scope === "papers" ? "paper" : "book";
    const channelCursor = parseCursorChannels(options.cursor, kind)[kind] ?? undefined;
    validateChannelCursor(kind, channelCursor);
    return searchOneKind(kind, undefined, channelCursor);
  }

  const channels = parseCursorChannels(options.cursor);
  validateChannelCursor("paper", channels.paper ?? undefined);
  validateChannelCursor("book", channels.book ?? undefined);
  const paperActive = channels.paper !== null;
  const bookActive = channels.book !== null;
  const paperContinuing = typeof channels.paper === "string";
  const bookContinuing = typeof channels.book === "string";
  const [paperSettled, bookSettled, paperFallbackSettled, bookFallbackSettled] = await Promise.allSettled([
    paperActive && !paperContinuing ? indexedForKind("paper") : Promise.resolve({ hits: [], warnings: [] } as IndexedOutcome),
    bookActive && !bookContinuing ? indexedForKind("book") : Promise.resolve({ hits: [], warnings: [] } as IndexedOutcome),
    paperActive ? fallbackForKind("paper", undefined, channels.paper ?? undefined) : Promise.resolve(null),
    bookActive ? fallbackForKind("book", undefined, channels.book ?? undefined) : Promise.resolve(null),
  ]);
  const paperIndexed = paperSettled.status === "fulfilled" ? paperSettled.value : { hits: [], warnings: [] };
  const bookIndexed = bookSettled.status === "fulfilled" ? bookSettled.value : { hits: [], warnings: [] };
  const paperFallback = paperFallbackSettled.status === "fulfilled" ? paperFallbackSettled.value : null;
  const bookFallback = bookFallbackSettled.status === "fulfilled" ? bookFallbackSettled.value : null;
  const paperMerged = mergeHits(paperIndexed.hits, paperFallback?.hits ?? [], options.topK);
  const bookMerged = mergeHits(bookIndexed.hits, bookFallback?.hits ?? [], options.topK);
  const merged = mergeByRrf(paperMerged.hits, bookMerged.hits, options.topK);
  const paperNextCursor = paperActive
    ? finalizeFallbackCursor(options, paperFallback, merged.filter((hit) => hit.kind === "paper"), channels.paper ?? undefined, "paper")
    : undefined;
  const bookNextCursor = bookActive
    ? finalizeFallbackCursor(options, bookFallback, merged.filter((hit) => hit.kind === "book"), channels.book ?? undefined, "book")
    : undefined;
  const errors = uniqueStrings([
    ...paperIndexed.warnings,
    ...bookIndexed.warnings,
    ...(paperSettled.status === "rejected" ? [`论文库检索失败：${errorText(paperSettled.reason)}`] : []),
    ...(bookSettled.status === "rejected" ? [`书库检索失败：${errorText(bookSettled.reason)}`] : []),
    ...(paperFallbackSettled.status === "rejected" ? [`论文关键词回退失败：${errorText(paperFallbackSettled.reason)}`] : []),
    ...(bookFallbackSettled.status === "rejected" ? [`书籍关键词回退失败：${errorText(bookFallbackSettled.reason)}`] : []),
    ...(paperFallback?.errors ?? []),
    ...(bookFallback?.errors ?? []),
  ]);
  return {
    results: merged,
    total: merged.length,
    paper_total: paperMerged.hits.length,
    book_total: bookMerged.hits.length,
    partial:
      paperSettled.status === "rejected" ||
      bookSettled.status === "rejected" ||
      (paperFallback?.partial ?? paperFallbackSettled.status === "rejected") ||
      (bookFallback?.partial ?? bookFallbackSettled.status === "rejected"),
    truncated:
      paperMerged.truncated ||
      bookMerged.truncated ||
      (paperFallback?.truncated ?? false) ||
      (bookFallback?.truncated ?? false) ||
      paperMerged.hits.length + bookMerged.hits.length > options.topK,
    fallback: { paper: paperFallback?.stats ?? null, book: bookFallback?.stats ?? null },
    search_config: searchConfig,
    next_cursor:
      paperNextCursor || bookNextCursor
        ? JSON.stringify({ paper: paperNextCursor ?? null, book: bookNextCursor ?? null })
        : undefined,
    errors,
    note: merged.length ? undefined : "跨库没有命中：换关键词，或指定 doc 检索。",
  };
}
