import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { readBookSectionCanonical, readBookToc } from "./book-document.js";
import { parsePaperCanonical, type PaperCanonical } from "./paper-document.js";
import type { AnchorPrecision, LibraryHit, LibraryReadAnchor, LibrarySource } from "./search-library.js";

function clipSnippet(text: string, maxChars = 400): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export interface SearchDocument {
  id: string;
  title: string;
  author: string | null;
  format: string;
}

export interface FallbackDocRef {
  kind: "book" | "paper";
  id: string;
}

interface DocumentDescriptor {
  doc: FallbackDocRef;
  title: string;
  author: string | null;
  indexed: boolean;
  errors: string[];
}

export interface FallbackStats {
  candidate_documents: number;
  scanned_documents: number;
  title_documents: number;
  scanned_sections: number;
  errors: number;
  partial: boolean;
  truncated: boolean;
}

export interface FallbackCursor {
  v: 1;
  kind: "book" | "paper";
  query: string;
  scope: string;
  collection: string | null;
  includeReferences: boolean;
  offset: number;
  section: number;
  titleOffset: number;
  pending: LibraryHit[];
  partial: boolean;
  truncated: boolean;
}

export interface FallbackCursorPage {
  state: FallbackCursor;
  startOffset: number;
  hasMore: boolean;
}

export interface FallbackSearchResult {
  hits: LibraryHit[];
  partial: boolean;
  truncated: boolean;
  stats: FallbackStats;
  errors: string[];
  state: FallbackCursor;
  nextCursor?: FallbackCursorPage;
}

export interface KeywordFallbackOptions {
  appDir: string;
  documents: SearchDocument[];
  kind: "book" | "paper";
  target?: FallbackDocRef;
  query: string;
  scope: string;
  collection?: string;
  paperIds?: string[];
  topK: number;
  includeReferences: boolean;
  cursor?: string;
}

const MAX_LIBRARY_BOOK_SECTIONS = 24;
const BOOK_SCAN_DURATION_MS = 1200;
const LIBRARY_SCAN_BUDGET_MS = 5000;
const MAX_PENDING_HITS = 30;
const MAX_CURSOR_CHARS = 65536;

function terms(query: string): string[] {
  return query.trim().split(/\s+/u).map((term) => term.trim()).filter(Boolean);
}

function findInsensitive(text: string, query: string, from = 0): number | null {
  if (!query) return null;
  const foldedText = text.toLowerCase();
  const foldedQuery = query.toLowerCase();
  let at = foldedText.indexOf(foldedQuery, Math.max(0, from));
  while (at >= 0) {
    if (text.slice(at, at + query.length).toLowerCase() === foldedQuery) return at;
    at = foldedText.indexOf(foldedQuery, at + 1);
  }
  return null;
}

function keywordMatch(text: string, query: string): number | null {
  const queryTerms = terms(query);
  if (!queryTerms.length) return null;
  const offsets: number[] = [];
  for (const term of queryTerms) {
    const offset = findInsensitive(text, term);
    if (offset == null) return null;
    offsets.push(offset);
  }
  return Math.min(...offsets);
}

function matchesTitle(title: string, query: string): boolean {
  const folded = title.toLowerCase();
  return terms(query).every((term) => folded.includes(term.toLowerCase()));
}

function indexStatus(appDir: string, doc: FallbackDocRef): { indexed: boolean; error?: string } {
  const dbPath = doc.kind === "paper"
    ? path.join(appDir, "papers", "vectors.sqlite")
    : path.join(appDir, "books", doc.id, "vectors.sqlite");
  if (!fs.existsSync(dbPath)) return { indexed: false };
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = doc.kind === "paper"
      ? db.prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE paper_id = ?").get(doc.id) as { n: number }
      : db.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number };
    return { indexed: row.n > 0 };
  } catch (error) {
    return { indexed: false, error: `索引状态读取失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    db?.close();
  }
}

function describeDocuments(options: KeywordFallbackOptions): { documents: DocumentDescriptor[]; errors: string[] } {
  const errors: string[] = [];
  const documents = options.documents
    .filter((document) => options.target
      ? document.id === options.target.id
      : options.kind === "paper" ? document.format === "MARKDOWN" : document.format !== "MARKDOWN")
    .filter((document) => options.kind !== "paper" || !options.paperIds || options.paperIds.includes(document.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((document) => {
      const status = indexStatus(options.appDir, { kind: options.kind, id: document.id });
      if (status.error) errors.push(`${document.id}: ${status.error}`);
      return {
        doc: { kind: options.kind, id: document.id },
        title: document.title || document.id,
        author: document.author,
        indexed: status.indexed,
        errors: status.error ? [status.error] : [],
      };
    });
  return { documents, errors };
}

function makeHit(
  descriptor: DocumentDescriptor,
  source: LibrarySource,
  similarity: number,
  snippet: string,
  read: LibraryReadAnchor,
  precision: AnchorPrecision,
  chapter: string | null,
): LibraryHit {
  const doc = `${descriptor.doc.kind}:${descriptor.doc.id}`;
  return {
    doc,
    kind: descriptor.doc.kind,
    title: descriptor.title,
    chapter,
    snippet: clipSnippet(snippet),
    chunk_id: null,
    similarity,
    source,
    index: {
      status: descriptor.indexed ? "indexed" : "not_indexed",
      ...(descriptor.errors.length ? { note: descriptor.errors.join("；") } : {}),
    },
    read,
    anchor_precision: precision,
    相似度: `${similarity.toFixed(1)}%`,
    片段: clipSnippet(snippet),
    类型: descriptor.doc.kind === "paper" ? "论文" : "书籍",
    标题: descriptor.title,
    作者: descriptor.author,
    章节: chapter,
    文件: descriptor.doc.kind === "paper" ? "paper.md" : null,
    块位置: "?/?",
  };
}

function titleHit(descriptor: DocumentDescriptor): LibraryHit {
  const doc = `${descriptor.doc.kind}:${descriptor.doc.id}`;
  return makeHit(descriptor, "title", 100, descriptor.title, { doc, offset: 0 }, "section", null);
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
  const first = parsed.headings[0];
  if (!first) return [{ heading: null, start: 0, end: parsed.body.length }];
  const ranges: { heading: string | null; start: number; end: number }[] = [];
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

function isReferencesHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^references\b/.test(normalized) || /^bibliography\b/.test(normalized) || normalized.includes("参考文献");
}

function referenceRanges(parsed: PaperCanonical): { start: number; end: number }[] {
  return parsed.headings
    .filter((heading) => isReferencesHeading(heading.text))
    .map((heading) => {
      const index = parsed.headings.indexOf(heading);
      const next = parsed.headings.slice(index + 1).find((item) => item.level <= heading.level);
      return { start: heading.start, end: next?.start ?? parsed.body.length };
    });
}

function searchPaperDocument(
  descriptor: DocumentDescriptor,
  appDir: string,
  query: string,
  includeReferences: boolean,
): LibraryHit[] {
  const markdown = fs.readFileSync(path.join(appDir, "books", descriptor.doc.id, "paper.md"), "utf8");
  const parsed = parsePaperCanonical(markdown);
  const excluded = includeReferences ? [] : referenceRanges(parsed);
  const doc = `${descriptor.doc.kind}:${descriptor.doc.id}`;
  const hits: LibraryHit[] = [];
  for (const range of paperSectionRanges(parsed)) {
    if (excluded.some((reference) => range.start >= reference.start && range.start < reference.end)) continue;
    const text = parsed.body.slice(range.start, range.end);
    const localOffset = keywordMatch(text, query);
    if (localOffset == null) continue;
    const offset = range.start + localOffset;
    hits.push(makeHit(
      descriptor,
      "keyword",
      80,
      parsed.body.slice(Math.max(range.start, offset - 160), Math.min(range.end, offset + 240)),
      { doc, offset },
      "exact",
      range.heading ?? paperHeadingAt(parsed, offset),
    ));
  }
  return hits;
}

async function searchBookDocument(
  descriptor: DocumentDescriptor,
  appDir: string,
  query: string,
  topK: number,
  includeReferences: boolean,
  bounded: boolean,
): Promise<{ hits: LibraryHit[]; scannedSections: number; partial: boolean }> {
  const bookDir = path.join(appDir, "books", descriptor.doc.id);
  const toc = await readBookToc(bookDir);
  const doc = `${descriptor.doc.kind}:${descriptor.doc.id}`;
  const hits: LibraryHit[] = [];
  const started = Date.now();
  let scannedSections = 0;
  let partial = false;
  for (const entry of toc.entries) {
    if (bounded && (scannedSections >= MAX_LIBRARY_BOOK_SECTIONS || Date.now() - started > BOOK_SCAN_DURATION_MS)) {
      partial = true;
      break;
    }
    const canonical = await readBookSectionCanonical(bookDir, { spine: entry.spine, fragment: entry.fragment });
    if (canonical.kind !== "ok") throw new Error(`无法读取书籍章节：${descriptor.doc.id} spine=${entry.spine}`);
    scannedSections += 1;
    const localOffset = keywordMatch(canonical.text, query);
    if (
      !includeReferences &&
      (isReferencesHeading(canonical.matchedTitle) ||
        canonical.referenceRanges.some((range) => localOffset != null && localOffset >= range.start && localOffset < range.end))
    ) continue;
    const headingMatch = matchesTitle(canonical.matchedTitle, query);
    if (localOffset == null && !headingMatch) continue;
    const isTitle = headingMatch;
    const read: LibraryReadAnchor = {
      doc,
      heading: canonical.matchedTitle,
      spine: entry.spine,
      ...(canonical.fragment ? { fragment: canonical.fragment } : {}),
    };
    let precision: AnchorPrecision = "section";
    if (localOffset != null) {
      read.offset = localOffset;
      precision = "exact";
    }
    hits.push(makeHit(
      descriptor,
      isTitle ? "title" : "keyword",
      isTitle ? 90 : 80,
      localOffset == null
        ? canonical.matchedTitle
        : canonical.text.slice(Math.max(0, localOffset - 160), localOffset + 240),
      read,
      precision,
      canonical.matchedTitle,
    ));
    if (bounded && hits.length >= topK) {
      if (scannedSections < toc.entries.length) partial = true;
      break;
    }
  }
  return { hits, scannedSections, partial };
}

export function fallbackHitCursorKey(hit: LibraryHit): string {
  if (typeof hit.read.offset === "number") {
    if (hit.kind === "book") {
      return `${hit.doc}|spine:${hit.read.spine ?? ""}|heading:${hit.read.heading ?? ""}|fragment:${hit.read.fragment ?? ""}|${hit.read.offset}`;
    }
    return `${hit.doc}|${hit.read.offset}`;
  }
  return `${hit.doc}|heading:${hit.read.heading ?? ""}|spine:${hit.read.spine ?? ""}|fragment:${hit.read.fragment ?? ""}`;
}

export function encodeFallbackCursor(state: FallbackCursor): string {
  if (state.pending && state.pending.length > MAX_PENDING_HITS) {
    throw new Error(`检索 cursor pending 超过上限 ${MAX_PENDING_HITS}`);
  }
  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_CURSOR_CHARS) {
    throw new Error(`检索 cursor 序列化大小超过上限 ${MAX_CURSOR_CHARS}`);
  }
  return encodeURIComponent(serialized);
}

export function decodeFallbackCursor(options: Pick<
  KeywordFallbackOptions,
  "kind" | "query" | "scope" | "collection" | "includeReferences" | "cursor"
>): FallbackCursor {
  const collection = options.collection ?? null;
  if (!options.cursor) {
    return {
      v: 1,
      kind: options.kind,
      query: options.query,
      scope: options.scope,
      collection,
      includeReferences: options.includeReferences,
      offset: 0,
      section: 0,
      titleOffset: 0,
      pending: [],
      partial: false,
      truncated: false,
    };
  }
  try {
    if (options.cursor.length > MAX_CURSOR_CHARS * 3) throw new Error("cursor encoded size exceeds limit");
    const parsed = JSON.parse(decodeURIComponent(options.cursor)) as Partial<FallbackCursor> & { seen?: unknown };
    const validPosition = (value: unknown): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (parsed.seen !== undefined) throw new Error("legacy seen cursor is unsafe; restart the search");
    if (
      parsed.v !== 1 ||
      parsed.kind !== options.kind ||
      parsed.query !== options.query ||
      parsed.scope !== options.scope ||
      (parsed.collection ?? null) !== collection ||
      parsed.includeReferences !== options.includeReferences ||
      !validPosition(parsed.offset) ||
      !validPosition(parsed.section) ||
      !validPosition(parsed.titleOffset) ||
      !Array.isArray(parsed.pending) ||
      parsed.pending.length > MAX_PENDING_HITS ||
      !parsed.pending.every((hit) =>
        hit && typeof hit.doc === "string" && hit.read && typeof hit.read.doc === "string")
    ) {
      throw new Error("cursor shape/query/scope/collection mismatch");
    }
    return {
      v: 1,
      kind: options.kind,
      query: options.query,
      scope: options.scope,
      collection,
      includeReferences: options.includeReferences,
      offset: parsed.offset,
      section: parsed.section,
      titleOffset: parsed.titleOffset,
      pending: parsed.pending,
      partial: parsed.partial === true,
      truncated: parsed.truncated === true,
    };
  } catch (error) {
    throw new Error(`检索 cursor 无效或与当前查询不匹配: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sortAndClip(hits: LibraryHit[], topK: number): { hits: LibraryHit[]; truncated: boolean } {
  const sorted = hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => right.hit.similarity - left.hit.similarity || left.index - right.index)
    .map(({ hit }) => hit);
  return { hits: sorted.slice(0, topK), truncated: sorted.length > topK };
}

export async function searchKeywordFallback(options: KeywordFallbackOptions): Promise<FallbackSearchResult> {
  const targetMode = options.target != null;
  if (targetMode && options.cursor) throw new Error("current/doc 不支持 library/all cursor；请省略 cursor 重试");
  const cursor = decodeFallbackCursor(options);
  if (cursor.pending.length) {
    const hits = cursor.pending.slice(0, options.topK);
    const overflow = cursor.pending.slice(options.topK);
    const state: FallbackCursor = { ...cursor, pending: overflow };
    const truncated = cursor.truncated || overflow.length > 0;
    return {
      hits,
      partial: cursor.partial,
      truncated,
      stats: {
        candidate_documents: 0,
        scanned_documents: 0,
        title_documents: 0,
        scanned_sections: 0,
        errors: 0,
        partial: cursor.partial,
        truncated,
      },
      errors: [],
      state,
      nextCursor: overflow.length
        ? { state, startOffset: cursor.offset, hasMore: true }
        : undefined,
    };
  }

  const discovery = describeDocuments(options);
  const descriptors = discovery.documents;
  const titleMatches = descriptors.filter((item) => matchesTitle(item.title, options.query));
  const candidates = targetMode ? descriptors : descriptors.filter((item) => !item.indexed);
  const initialErrors = [
    ...discovery.errors,
    ...descriptors.flatMap((descriptor) => descriptor.errors),
  ];

  if (targetMode) {
    const descriptor = descriptors[0];
    let bodyHits: LibraryHit[] = [];
    let scannedSections = 0;
    let partial = initialErrors.length > 0;
    const errors = [...initialErrors];
    if (descriptor) {
      try {
        if (options.kind === "paper") {
          bodyHits = searchPaperDocument(descriptor, options.appDir, options.query, options.includeReferences);
        } else {
          const outcome = await searchBookDocument(
            descriptor,
            options.appDir,
            options.query,
            options.topK,
            options.includeReferences,
            false,
          );
          bodyHits = outcome.hits;
          scannedSections = outcome.scannedSections;
          partial ||= outcome.partial;
        }
      } catch (error) {
        errors.push(`${descriptor.doc.id}: ${error instanceof Error ? error.message : String(error)}`);
        partial = true;
      }
    }
    const clipped = sortAndClip([...titleMatches.map(titleHit), ...bodyHits], options.topK);
    const uniqueErrors = [...new Set(errors)];
    partial ||= uniqueErrors.length > 0;
    const truncated = clipped.truncated || partial;
    const state: FallbackCursor = {
      ...cursor,
      offset: candidates.length,
      section: 0,
      titleOffset: titleMatches.length,
      pending: [],
      partial,
      truncated,
    };
    return {
      hits: clipped.hits,
      partial,
      truncated,
      stats: {
        candidate_documents: candidates.length,
        scanned_documents: descriptor ? 1 : 0,
        title_documents: descriptors.length,
        scanned_sections: scannedSections,
        errors: uniqueErrors.length,
        partial,
        truncated,
      },
      errors: uniqueErrors,
      state,
    };
  }

  const hits: LibraryHit[] = [];
  const errors = [...initialErrors];
  const scannedDocuments = new Set<number>();
  const started = Date.now();
  let scannedSections = 0;
  let stopped = false;
  let offset = Math.min(cursor.offset, candidates.length);
  let section = cursor.section;
  let titleOffset = Math.min(cursor.titleOffset, titleMatches.length);

  while (hits.length < options.topK && titleOffset < titleMatches.length) {
    hits.push(titleHit(titleMatches[titleOffset]));
    titleOffset += 1;
  }

  while (hits.length < options.topK && offset < candidates.length && !stopped) {
    const documentIndex = offset;
    const descriptor = candidates[documentIndex];
    if (Date.now() - started > LIBRARY_SCAN_BUDGET_MS) {
      stopped = true;
      break;
    }
    try {
      if (options.kind === "paper") {
        const markdown = fs.readFileSync(path.join(options.appDir, "books", descriptor.doc.id, "paper.md"), "utf8");
        const parsed = parsePaperCanonical(markdown);
        const ranges = paperSectionRanges(parsed);
        const excluded = options.includeReferences ? [] : referenceRanges(parsed);
        const doc = `paper:${descriptor.doc.id}`;
        scannedDocuments.add(documentIndex);
        let advanced = false;
        for (let index = section; index < ranges.length; index += 1) {
          if (Date.now() - started > LIBRARY_SCAN_BUDGET_MS) {
            stopped = true;
            break;
          }
          const range = ranges[index];
          if (excluded.some((reference) => range.start >= reference.start && range.start < reference.end)) continue;
          const text = parsed.body.slice(range.start, range.end);
          const localOffset = keywordMatch(text, options.query);
          if (localOffset == null) continue;
          const absolute = range.start + localOffset;
          hits.push(makeHit(
            descriptor,
            "keyword",
            80,
            parsed.body.slice(Math.max(range.start, absolute - 160), Math.min(range.end, absolute + 240)),
            { doc, offset: absolute },
            "exact",
            range.heading ?? paperHeadingAt(parsed, absolute),
          ));
          section = index + 1;
          if (section >= ranges.length) {
            offset += 1;
            section = 0;
          }
          advanced = true;
          break;
        }
        if (!advanced && !stopped) {
          offset += 1;
          section = 0;
        }
      } else {
        const bookDir = path.join(options.appDir, "books", descriptor.doc.id);
        const toc = await readBookToc(bookDir);
        const doc = `book:${descriptor.doc.id}`;
        scannedDocuments.add(documentIndex);
        let advanced = false;
        for (let index = section; index < toc.entries.length; index += 1) {
          if (scannedSections >= MAX_LIBRARY_BOOK_SECTIONS || Date.now() - started > BOOK_SCAN_DURATION_MS) {
            stopped = true;
            break;
          }
          const entry = toc.entries[index];
          const canonical = await readBookSectionCanonical(bookDir, { spine: entry.spine, fragment: entry.fragment });
          if (canonical.kind !== "ok") throw new Error(`无法读取书籍章节：${descriptor.doc.id} spine=${entry.spine}`);
          scannedSections += 1;
          const localOffset = keywordMatch(canonical.text, options.query);
          if (
            !options.includeReferences &&
            (isReferencesHeading(canonical.matchedTitle) ||
              canonical.referenceRanges.some((range) =>
                localOffset != null && localOffset >= range.start && localOffset < range.end))
          ) continue;
          const headingMatch = matchesTitle(canonical.matchedTitle, options.query);
          if (localOffset == null && !headingMatch) continue;
          const read: LibraryReadAnchor = {
            doc,
            heading: canonical.matchedTitle,
            spine: entry.spine,
            ...(canonical.fragment ? { fragment: canonical.fragment } : {}),
          };
          let precision: "exact" | "section" = "section";
          if (localOffset != null) {
            read.offset = localOffset;
            precision = "exact";
          }
          hits.push(makeHit(
            descriptor,
            headingMatch ? "title" : "keyword",
            headingMatch ? 90 : 80,
            localOffset == null
              ? canonical.matchedTitle
              : canonical.text.slice(Math.max(0, localOffset - 160), localOffset + 240),
            read,
            precision,
            canonical.matchedTitle,
          ));
          section = index + 1;
          if (section >= toc.entries.length) {
            offset += 1;
            section = 0;
          }
          advanced = true;
          break;
        }
        if (!advanced && !stopped) {
          offset += 1;
          section = 0;
        }
      }
    } catch (error) {
      scannedDocuments.add(documentIndex);
      errors.push(`${descriptor.doc.id}: ${error instanceof Error ? error.message : String(error)}`);
      offset += 1;
      section = 0;
    }
  }

  const remaining = titleOffset < titleMatches.length || offset < candidates.length;
  const uniqueErrors = [...new Set(errors)];
  const partial = cursor.partial || stopped || remaining || uniqueErrors.length > 0;
  const truncated = cursor.truncated || partial;
  const state: FallbackCursor = {
    ...cursor,
    offset,
    section,
    titleOffset,
    pending: [],
    partial,
    truncated,
  };
  const nextCursor = remaining ? { state, startOffset: cursor.offset, hasMore: true } : undefined;
  return {
    hits,
    partial,
    truncated,
    stats: {
      candidate_documents: candidates.length,
      scanned_documents: scannedDocuments.size,
      title_documents: descriptors.length,
      scanned_sections: scannedSections,
      errors: uniqueErrors.length,
      partial,
      truncated,
    },
    errors: uniqueErrors,
    state,
    nextCursor,
  };
}
