import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import * as yauzl from "yauzl";
import { readCanonicalWindow } from "./canonical-window.js";
import {
  decodeRef,
  isLocalRelativeImageRef,
  markdownImageDestination,
  slash,
  stripAngle,
  withinRoot,
} from "./document-images.js";
import { extractStructuredText } from "./structured-text.js";

export { extractStructuredText } from "./structured-text.js";

export interface BookTocEntry {
  label: string;
  href: string;
  level: number;
  spineIndex: number;
  fragment: string | null;
}

interface BookSection {
  id: string;
  archivePath: string;
  mdRelPath: string;
  filePath?: string;
  linear: boolean;
}

interface EpubArchive {
  zip: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
}

interface BookModel {
  bookDir: string;
  epubPath?: string;
  archive?: EpubArchive;
  sections: BookSection[];
  toc: BookTocEntry[];
}

export interface BookCanonicalSegment {
  spineIndex: number;
  sectionId: string;
  archivePath: string;
  mdRelPath: string;
  start: number;
  end: number;
}

export interface BookCanonicalText {
  text: string;
  totalChars: number;
  bookDir: string;
  epubPath?: string;
  segments: BookCanonicalSegment[];
  source: "epub" | "mdbook";
}

export interface BookSectionQuery {
  heading?: string;
  file?: string;
  spine?: number;
  fragment?: string | null;
}

export type BookSectionCanonical =
  | (BookCanonicalText & {
      kind: "ok";
      matchedTitle: string;
      matchKind: "heading" | "file" | "spine";
      spineIndex: number;
      fragment: string | null;
      referenceRanges: { start: number; end: number }[];
    })
  | { kind: "ambiguous"; candidates: BookTocEntry[]; total: number }
  | { kind: "none" };

export interface BookWindowOptions extends BookSectionQuery {
  offset?: number;
  before?: number;
  after?: number;
}

export interface BookWindow {
  text: string;
  start: number;
  end: number;
  totalChars: number;
  nextOffset: number | null;
  truncated: boolean;
  matchedTitle: string | null;
  spineIndex: number | null;
  fragment: string | null;
  anchor: Record<string, string | number>;
  imageSource: BookCanonicalText & { windowStart: number };
}

export interface ResolvedBookImages {
  text: string;
  materialized: string[];
  cacheDir?: string;
}

const MAX_TEXT_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MARKDOWN_IMAGE_RE =
  /(?<!\\)!\[((?:\\[\s\S]|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*"|\s+'[^']*'|\s+\([^)]*\))?)\s*\)/g;
const HTML_IMG_RE =
  /<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\bsrc\s*=\s*("([^"]*)"|'([^']*)')((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;

function zipPath(baseFile: string, ref: string): string {
  const clean = decodeRef(stripAngle(ref)).split("#")[0].split("?")[0].replace(/\\/g, "/");
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), clean)).replace(/^\.\//, "");
}

function mdRelPath(sectionId: string): string {
  const bare = sectionId.split("#")[0].replace(/\\/g, "/");
  return /\.x?html$/i.test(bare) ? bare.replace(/\.x?html$/i, ".md") : bare;
}

async function openArchive(epubPath: string): Promise<EpubArchive> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: true, autoClose: false }, (error, opened) =>
      error || !opened ? reject(error ?? new Error("无法打开 EPUB")) : resolve(opened),
    );
  });
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith("/")) entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.once("end", resolve);
    zip.once("error", reject);
    zip.readEntry();
  }).catch((error) => {
    zip.close();
    throw error;
  });
  return { zip, entries };
}

async function readEntry(archive: EpubArchive, entryPath: string, maxBytes: number): Promise<Buffer> {
  const entry = archive.entries.get(entryPath);
  if (!entry) throw new Error(`EPUB 缺少资源：${entryPath}`);
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`EPUB 资源超过有界读取上限（${entry.uncompressedSize} > ${maxBytes}）：${entryPath}`);
  }
  const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => {
    archive.zip.openReadStream(entry, (error, opened) =>
      error || !opened ? reject(error ?? new Error(`无法读取 EPUB 资源：${entryPath}`)) : resolve(opened),
    );
  });
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy(new Error(`EPUB 资源解压后超过上限：${entryPath}`));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  return Buffer.concat(chunks);
}

async function readTextEntry(archive: EpubArchive, entryPath: string): Promise<string> {
  return (await readEntry(archive, entryPath, MAX_TEXT_ENTRY_BYTES)).toString("utf8");
}

function parseXml(source: string): Document {
  return new JSDOM(source, { contentType: "application/xhtml+xml" }).window.document;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function sectionFromArchive(model: BookModel, archivePath: string): { index: number; section: BookSection } | null {
  const index = model.sections.findIndex((section) => section.archivePath === archivePath);
  return index < 0 ? null : { index, section: model.sections[index] };
}

async function epubToc(model: BookModel, manifest: Map<string, Element>, opfPath: string): Promise<BookTocEntry[]> {
  const archive = model.archive!;
  const navItem = [...manifest.values()].find((item) =>
    (item.getAttribute("properties") ?? "").split(/\s+/).includes("nav"),
  );
  const entries: BookTocEntry[] = [];
  if (navItem) {
    const navPath = zipPath(opfPath, navItem.getAttribute("href") ?? "");
    if (archive.entries.has(navPath)) {
      const nav = parseXml(await readTextEntry(archive, navPath));
      const navRoots = Array.from(nav.getElementsByTagName("nav"));
      const root = navRoots.find((item) =>
        ["epub:type", "type", "role"].some((name) => (item.getAttribute(name) ?? "").includes("toc")),
      ) ?? navRoots[0];
      for (const anchor of Array.from(root?.getElementsByTagName("a") ?? [])) {
        const href = anchor.getAttribute("href") ?? "";
        const [file, fragment] = href.split("#");
        const target = sectionFromArchive(model, zipPath(navPath, file));
        const label = normalizedText(anchor.textContent);
        if (!target || !label) continue;
        let level = 0;
        let parent = anchor.parentElement;
        while (parent && parent !== root) {
          if (parent.localName === "ol") level += 1;
          parent = parent.parentElement;
        }
        entries.push({ label, href, level, spineIndex: target.index, fragment: fragment || null });
      }
    }
  }
  if (entries.length) return entries;
  const ncxItem = [...manifest.values()].find((item) =>
    (item.getAttribute("media-type") ?? "").includes("dtbncx"),
  );
  if (!ncxItem) return entries;
  const ncxPath = zipPath(opfPath, ncxItem.getAttribute("href") ?? "");
  if (!archive.entries.has(ncxPath)) return entries;
  const ncx = parseXml(await readTextEntry(archive, ncxPath));
  const visit = (parent: Element, level: number) => {
    for (const point of Array.from(parent.children).filter((item) => item.localName === "navPoint")) {
      const content = Array.from(point.children).find((item) => item.localName === "content");
      const label = normalizedText(
        Array.from(point.children).find((item) => item.localName === "navLabel")?.textContent,
      );
      const href = content?.getAttribute("src") ?? "";
      const [file, fragment] = href.split("#");
      const target = sectionFromArchive(model, zipPath(ncxPath, file));
      if (target && label) entries.push({ label, href, level, spineIndex: target.index, fragment: fragment || null });
      visit(point, level + 1);
    }
  };
  const navMap = Array.from(ncx.getElementsByTagName("navMap"))[0];
  if (navMap) visit(navMap, 1);
  return entries;
}

async function openEpubModel(bookDir: string): Promise<BookModel> {
  const epubPath = path.join(bookDir, "book.epub");
  const archive = await openArchive(epubPath);
  try {
    const container = parseXml(await readTextEntry(archive, "META-INF/container.xml"));
    const rootFile = Array.from(container.getElementsByTagName("rootfile"))[0]?.getAttribute("full-path");
    if (!rootFile) throw new Error("EPUB container.xml 未声明 rootfile");
    const opf = parseXml(await readTextEntry(archive, rootFile));
    const manifest = new Map<string, Element>();
    for (const item of Array.from(opf.getElementsByTagName("item"))) {
      const id = item.getAttribute("id");
      if (id) manifest.set(id, item);
    }
    const sections: BookSection[] = [];
    for (const ref of Array.from(opf.getElementsByTagName("itemref"))) {
      const item = manifest.get(ref.getAttribute("idref") ?? "");
      const href = item?.getAttribute("href");
      if (!item || !href) continue;
      const id = path.posix.normalize(href.replace(/\\/g, "/")).replace(/^\.\//, "");
      sections.push({
        id,
        archivePath: zipPath(rootFile, href),
        mdRelPath: mdRelPath(id),
        linear: ref.getAttribute("linear") !== "no",
      });
    }
    const model: BookModel = { bookDir, epubPath, archive, sections, toc: [] };
    model.toc = await epubToc(model, manifest, rootFile);
    return model;
  } catch (error) {
    archive.zip.close();
    throw error;
  }
}

function walkDirectories(root: string, maxDepth: number, visit: (directory: string) => void): void {
  if (maxDepth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  visit(root);
  for (const entry of entries) {
    if (entry.isDirectory()) walkDirectories(path.join(root, entry.name), maxDepth - 1, visit);
  }
}

function mdbookRoots(bookDir: string): string[] {
  const mdbook = path.join(bookDir, "mdbook");
  if (!fs.existsSync(mdbook)) return [];
  const roots = new Set<string>();
  walkDirectories(mdbook, 5, (directory) => {
    if (fs.existsSync(path.join(directory, "nav.md"))) roots.add(directory);
    if (path.basename(directory) === "src") roots.add(directory);
  });
  return [...roots].sort();
}

function openMdbookModel(bookDir: string): BookModel {
  const roots = mdbookRoots(bookDir);
  const root = roots.find((candidate) => fs.existsSync(path.join(candidate, "nav.md"))) ?? roots[0];
  if (!root) throw new Error(`未找到 ${bookDir} 的 book.epub 或 mdbook 正文`);
  const realRoot = fs.realpathSync(root);
  const resolveMdbookFile = (ref: string): string => {
    const candidate = path.resolve(realRoot, ref);
    const realFile = fs.realpathSync(candidate);
    if (!withinRoot(realFile, realRoot)) throw new Error(`mdbook nav 目标越出书籍目录：${ref}`);
    return realFile;
  };
  const toc: BookTocEntry[] = [];
  const sections: BookSection[] = [];
  const navPath = path.join(root, "nav.md");
  if (fs.existsSync(navPath)) {
    const re = /^(\s*)(?:(\d+)\.\s+)?\[([^\]]+)\]\(([^)]+)\)/;
    for (const line of fs.readFileSync(navPath, "utf8").split(/\r?\n/)) {
      const match = re.exec(line);
      if (!match) continue;
      const href = match[4].trim();
      const [file, fragment] = href.split("#");
      if (!file) continue;
      const filePath = resolveMdbookFile(file);
      const id = slash(path.relative(realRoot, filePath));
      const spineIndex = sections.length;
      sections.push({ id, archivePath: "", mdRelPath: mdRelPath(id), filePath, linear: true });
      toc.push({
        label: match[3].trim(),
        href,
        level: Math.floor(match[1].replace(/\t/g, "    ").length / 4) + 1,
        spineIndex,
        fragment: fragment || null,
      });
    }
  } else {
    const files: string[] = [];
    walkDirectories(root, 3, (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "nav.md") {
          files.push(path.join(directory, entry.name));
        }
      }
    });
    for (const filePath of files.sort()) {
      const id = slash(path.relative(root, filePath));
      const spineIndex = sections.length;
      sections.push({ id, archivePath: "", mdRelPath: id, filePath, linear: true });
      toc.push({ label: path.basename(id, ".md"), href: id, level: 1, spineIndex, fragment: null });
    }
  }
  if (!sections.length) throw new Error(`mdbook 没有可读取的正文：${root}`);
  return { bookDir, sections, toc };
}

async function withBookModel<T>(bookDir: string, read: (model: BookModel) => Promise<T>): Promise<T> {
  if (!fs.existsSync(path.join(bookDir, "book.epub"))) return read(openMdbookModel(bookDir));
  const model = await openEpubModel(bookDir);
  try {
    return await read(model);
  } finally {
    model.archive?.zip.close();
  }
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function matchToc(model: BookModel, query: string): BookTocEntry[] | BookTocEntry | null {
  const needle = normalizeQuery(query);
  if (!needle) return null;
  const exact = model.toc.filter((entry) => normalizeQuery(entry.label) === needle);
  if (exact.length) return exact[0];
  const prefix = model.toc.filter((entry) => normalizeQuery(entry.label).startsWith(needle));
  if (prefix.length) return prefix[0];
  const contains = model.toc.filter((entry) => normalizeQuery(entry.label).includes(needle));
  if (contains.length > 1) return contains.sort((a, b) => a.label.length - b.label.length).slice(0, 20);
  return contains[0] ?? null;
}

function matchFile(model: BookModel, query: string): BookTocEntry[] | BookTocEntry | null {
  const needle = slash(query).toLowerCase();
  const base = path.posix.basename(needle).replace(/\.(md|x?html)$/i, "");
  const matches = model.sections.filter((section) => {
    const id = section.id.toLowerCase();
    return (
      id === needle ||
      section.archivePath.toLowerCase() === needle ||
      path.posix.basename(id).replace(/\.(md|x?html)$/i, "") === base
    );
  });
  if (matches.length === 1) {
    const spineIndex = model.sections.indexOf(matches[0]);
    return model.toc.find((entry) => entry.spineIndex === spineIndex) ?? {
      label: matches[0].id,
      href: matches[0].id,
      level: 1,
      spineIndex,
      fragment: null,
    };
  }
  if (matches.length > 1) {
    return matches.map((section) => ({
      label: section.id,
      href: section.id,
      level: 1,
      spineIndex: model.sections.indexOf(section),
      fragment: null,
    }));
  }
  return matchToc(model, query);
}

export interface BookTocInfo {
  entries: { level: number; heading: string; file: string | null; spine: number; fragment: string | null }[];
  source: "epub" | "mdbook";
}

export async function readBookToc(bookDir: string): Promise<BookTocInfo> {
  return withBookModel(bookDir, async (model) => {
    const entries = model.toc.map((entry) => ({
      level: entry.level,
      heading: entry.label,
      file: model.sections[entry.spineIndex]?.mdRelPath || null,
      spine: entry.spineIndex,
      fragment: entry.fragment,
    }));
    for (const [spine, section] of model.sections.entries()) {
      if (model.toc.some((entry) => entry.spineIndex === spine)) continue;
      entries.push({
        level: 1,
        heading: path.basename(section.id, path.extname(section.id)),
        file: section.mdRelPath || null,
        spine,
        fragment: null,
      });
    }
    return { source: model.archive ? "epub" : "mdbook", entries };
  });
}

function isReferencesHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^references\b/.test(normalized) || /^bibliography\b/.test(normalized) || normalized.includes("参考文献");
}

function markdownReferenceRanges(text: string): { start: number; end: number }[] {
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+(.*)$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
    start: match.index ?? 0,
  }));
  return headings
    .filter((heading) => isReferencesHeading(heading.text))
    .map((heading) => {
      const next = headings.find((item) => item.start > heading.start && item.level <= heading.level);
      return { start: heading.start, end: next?.start ?? text.length };
    });
}

function domReferenceRanges(document: Document, text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (!isReferencesHeading(normalizedText(heading.textContent))) continue;
    const referenceText = extractStructuredText(document, heading).text;
    if (!referenceText) continue;
    const start = text.lastIndexOf(referenceText);
    if (start >= 0) ranges.push({ start, end: text.length });
  }
  ranges.sort((left, right) => left.start - right.start);
  return ranges.map((range, index) => ({ start: range.start, end: ranges[index + 1]?.start ?? range.end }));
}

async function readSection(
  model: BookModel,
  spineIndex: number,
  fragment: string | null,
  matchedTitle: string,
  matchKind: "heading" | "file" | "spine",
): Promise<BookSectionCanonical> {
  const section = model.sections[spineIndex];
  if (!section) return { kind: "none" };
  let text: string;
  let referenceRanges: { start: number; end: number }[];
  if (model.archive) {
    const document = parseXml(await readTextEntry(model.archive, section.archivePath));
    const anchor = fragment ? document.getElementById(fragment) : null;
    if (fragment && !anchor) throw new Error(`未找到书籍 fragment：${fragment}`);
    text = extractStructuredText(document, anchor).text;
    referenceRanges = domReferenceRanges(document, text);
  } else {
    if (!section.filePath) return { kind: "none" };
    text = fs.readFileSync(section.filePath, "utf8").replace(/\r\n?/g, "\n");
    referenceRanges = markdownReferenceRanges(text);
  }
  return {
    kind: "ok",
    text,
    totalChars: text.length,
    bookDir: model.bookDir,
    ...(model.epubPath ? { epubPath: model.epubPath } : {}),
    source: model.archive ? "epub" : "mdbook",
    matchedTitle,
    matchKind,
    spineIndex,
    fragment,
    referenceRanges,
    segments: [{
      spineIndex,
      sectionId: section.id,
      archivePath: section.archivePath,
      mdRelPath: section.mdRelPath,
      start: 0,
      end: text.length,
    }],
  };
}

export async function readBookSectionCanonical(
  bookDir: string,
  query: string | BookSectionQuery,
): Promise<BookSectionCanonical> {
  return withBookModel(bookDir, async (model) => {
    const request = typeof query === "string" ? { heading: query } : query;
    if (request.spine != null) {
      if (!Number.isInteger(request.spine) || !model.sections[request.spine]) return { kind: "none" };
      const matched = model.toc.find((entry) => entry.spineIndex === request.spine);
      return readSection(
        model,
        request.spine,
        request.fragment ?? matched?.fragment ?? null,
        matched?.label ?? `spine ${request.spine + 1}`,
        "spine",
      );
    }
    const matched = request.file ? matchFile(model, request.file) : matchToc(model, request.heading ?? "");
    if (!matched) return { kind: "none" };
    if (Array.isArray(matched)) return { kind: "ambiguous", candidates: matched, total: matched.length };
    return readSection(
      model,
      matched.spineIndex,
      request.fragment ?? matched.fragment,
      matched.label,
      request.file ? "file" : "heading",
    );
  });
}

const DEFAULT_MAX_BOOK_CHARS = 16 * 1024 * 1024;

export interface BookDocumentOptions {
  maxTotalChars?: number;
}

async function buildBookDocumentCanonical(bookDir: string, maxTotalChars: number): Promise<BookCanonicalText> {
  return withBookModel(bookDir, async (model) => {
    const segments: BookCanonicalSegment[] = [];
    let text = "";
    for (const [spineIndex, section] of model.sections.entries()) {
      if (!section.linear) continue;
      let extracted: string;
      if (model.archive) {
        const document = parseXml(await readTextEntry(model.archive, section.archivePath));
        extracted = extractStructuredText(document, null).text;
      } else {
        if (!section.filePath) continue;
        extracted = fs.readFileSync(section.filePath, "utf8").replace(/\r\n?/g, "\n").trim();
      }
      if (!extracted) continue;
      const separatorLength = segments.length ? 2 : 0;
      if (text.length + separatorLength + extracted.length > maxTotalChars) {
        throw new Error(`全书 canonical 超过有界上限（${maxTotalChars} 字符）；请按 heading/spine 分段读取`);
      }
      if (segments.length) text += "\n\n";
      const start = text.length;
      text += extracted;
      segments.push({
        spineIndex,
        sectionId: section.id,
        archivePath: section.archivePath,
        mdRelPath: section.mdRelPath,
        start,
        end: text.length,
      });
    }
    return {
      text,
      totalChars: text.length,
      bookDir,
      ...(model.epubPath ? { epubPath: model.epubPath } : {}),
      segments,
      source: model.archive ? "epub" : "mdbook",
    };
  });
}

const fullBookCache = new Map<string, BookCanonicalText>();
const fullBookPending = new Map<string, Promise<BookCanonicalText>>();

export async function readBookDocumentCanonical(
  bookDir: string,
  options: BookDocumentOptions = {},
): Promise<BookCanonicalText> {
  const maxTotalChars = Math.max(1, options.maxTotalChars ?? DEFAULT_MAX_BOOK_CHARS);
  const cacheKey = `${bookDir}\0${maxTotalChars}`;
  const cached = fullBookCache.get(cacheKey);
  if (cached) {
    fullBookCache.delete(cacheKey);
    fullBookCache.set(cacheKey, cached);
    return cached;
  }
  const pending = fullBookPending.get(cacheKey);
  if (pending) return pending;
  const building = buildBookDocumentCanonical(bookDir, maxTotalChars);
  fullBookPending.set(cacheKey, building);
  try {
    const canonical = await building;
    fullBookCache.set(cacheKey, canonical);
    while (fullBookCache.size > 2) {
      const oldest = fullBookCache.keys().next().value;
      if (oldest === undefined) break;
      fullBookCache.delete(oldest);
    }
    return canonical;
  } finally {
    fullBookPending.delete(cacheKey);
  }
}

export async function readBookWindow(bookDir: string, options: BookWindowOptions): Promise<BookWindow> {
  const after = options.after ?? 6000;
  const before = Math.max(options.before ?? 0, 0);
  if (options.spine != null || options.heading || options.file) {
    const canonical = await readBookSectionCanonical(bookDir, options);
    if (canonical.kind === "ambiguous") {
      throw new Error(`章节匹配到 ${canonical.total} 个候选：${canonical.candidates.map((item) => item.label).join("；")}`);
    }
    if (canonical.kind === "none") throw new Error("未找到匹配的书籍章节");
    const window = readCanonicalWindow(canonical.text, {
      offset: options.offset ?? 0,
      before: options.offset == null ? 0 : before,
      after,
    });
    const anchor: Record<string, string | number> = { kind: canonical.matchKind, heading: canonical.matchedTitle };
    if (options.spine != null) anchor.spine = options.spine;
    if (options.file) anchor.file = options.file;
    if (options.fragment) anchor.fragment = options.fragment;
    return {
      ...window,
      totalChars: canonical.totalChars,
      matchedTitle: canonical.matchedTitle,
      spineIndex: canonical.spineIndex,
      fragment: canonical.fragment,
      anchor,
      imageSource: { ...canonical, windowStart: window.start },
    };
  }
  if (options.offset == null) {
    throw new Error("读书籍需要 heading、file、spine 或显式 offset 锚点（offset=0 可从全书开头读取）");
  }
  const canonical = await readBookDocumentCanonical(bookDir);
  const window = readCanonicalWindow(canonical.text, { offset: options.offset, before, after });
  return {
    ...window,
    totalChars: canonical.totalChars,
    matchedTitle: null,
    spineIndex: null,
    fragment: null,
    anchor: { kind: "offset", offset: options.offset },
    imageSource: { ...canonical, windowStart: window.start },
  };
}

function resolveDiskImage(bookDir: string, ref: string, relativeMdPath?: string): string | null {
  const cleanRef = decodeRef(stripAngle(ref));
  const candidates: string[] = [];
  if (relativeMdPath) {
    const relativeDir = path.posix.dirname(slash(relativeMdPath));
    for (const root of mdbookRoots(bookDir)) {
      candidates.push(path.resolve(root, relativeDir === "." ? "" : relativeDir, cleanRef));
    }
  }
  candidates.push(path.resolve(bookDir, cleanRef));
  for (const candidate of candidates) {
    if (withinRoot(candidate, bookDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return slash(candidate);
    }
  }
  return null;
}

function segmentAt(source: BookCanonicalText & { windowStart?: number }, position: number): BookCanonicalSegment | null {
  return (
    source.segments.find((segment) => position >= segment.start && position < segment.end) ??
    source.segments.find((segment) => position >= segment.start && position <= segment.end) ??
    null
  );
}

export async function resolveBookWindowImages(
  bookDir: string,
  text: string,
  source: BookCanonicalText & { windowStart?: number },
): Promise<ResolvedBookImages> {
  if (!text || (!text.includes("![") && !/<img/i.test(text))) return { text, materialized: [] };
  const occurrences: { ref: string; index: number; key: string }[] = [];
  let markdownOrdinal = 0;
  let htmlOrdinal = 0;
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    occurrences.push({ ref: match[2], index: match.index ?? 0, key: `markdown:${markdownOrdinal++}` });
  }
  for (const match of text.matchAll(HTML_IMG_RE)) {
    occurrences.push({ ref: match[3] ?? match[4] ?? "", index: match.index ?? 0, key: `html:${htmlOrdinal++}` });
  }
  const resolved = new Map<string, string>();
  const materialized: string[] = [];
  let cacheDir: string | undefined;
  let archive: EpubArchive | undefined;
  try {
    for (const occurrence of occurrences) {
      if (!isLocalRelativeImageRef(occurrence.ref)) continue;
      const ref = stripAngle(occurrence.ref);
      const segment = segmentAt(source, (source.windowStart ?? 0) + occurrence.index);
      let absolute = resolveDiskImage(bookDir, ref, segment?.mdRelPath);
      if (!absolute && source.epubPath && segment?.archivePath) {
        const href = zipPath(segment.archivePath, ref);
        const bookId = path.basename(bookDir);
        const hash = createHash("sha256").update(`${bookId}\0${href}`).digest("hex");
        const extension = /(?:\.[a-z0-9]{1,8})$/i.exec(href)?.[0].toLowerCase() ?? ".img";
        const safeBookId = bookId.replace(/[^A-Za-z0-9_-]/g, "_");
        cacheDir = path.join(path.dirname(path.dirname(bookDir)), "image-cache", "epub", safeBookId);
        const target = path.join(cacheDir, `${hash}${extension}`);
        try {
          if (!fs.existsSync(target)) {
            archive ??= await openArchive(source.epubPath);
            const bytes = await readEntry(archive, href, MAX_IMAGE_BYTES);
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(target, bytes);
          }
          absolute = slash(target);
          materialized.push(absolute);
        } catch {
          absolute = null;
        }
      }
      if (absolute) resolved.set(occurrence.key, absolute);
    }
  } finally {
    archive?.zip.close();
  }
  if (!resolved.size) return { text, materialized, ...(cacheDir ? { cacheDir: slash(cacheDir) } : {}) };
  let changed = false;
  markdownOrdinal = 0;
  htmlOrdinal = 0;
  const withMarkdown = text.replace(MARKDOWN_IMAGE_RE, (whole, alt: string, _destination: string, title = "") => {
    const absolute = resolved.get(`markdown:${markdownOrdinal++}`);
    if (!absolute) return whole;
    changed = true;
    return `![${alt}](${markdownImageDestination(absolute)}${title ? ` ${title.trim()}` : ""})`;
  });
  const rewritten = withMarkdown.replace(
    HTML_IMG_RE,
    (whole, before: string, quoted: string, _double?: string, _single?: string, after = "") => {
      const absolute = resolved.get(`html:${htmlOrdinal++}`);
      if (!absolute) return whole;
      changed = true;
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `<img${before}src=${quote}${absolute}${quote}${after}>`;
    },
  );
  return {
    text: changed ? rewritten : text,
    materialized,
    ...(cacheDir ? { cacheDir: slash(cacheDir) } : {}),
  };
}
