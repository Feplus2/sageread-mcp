import fs from "node:fs";
import path from "node:path";
import { parsePaperCanonical } from "./paper-document.js";

const MARKDOWN_IMAGE_RE =
  /(?<!\\)!\[((?:\\[\s\S]|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*"|\s+'[^']*'|\s+\([^)]*\))?)\s*\)/g;
const HTML_IMG_RE =
  /<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\bsrc\s*=\s*("([^"]*)"|'([^']*)')((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const CAPTION_RE = /^(?:figure|fig|table|图|表)\s*[.．:：]?\s*[（(]?\d+/i;
const ORPHAN_EN_CAPTION_RE = /^(?:figure|fig)\s*[.．:：]?\s*[（(]?\d+[a-z]?\s*[.．:：]/i;
const ORPHAN_ZH_CAPTION_RE = /^图\s*[.．:：]?\s*[（(]?\d+[a-z]?(?:\s|$)/;
const PANEL_RE = /^[（(]?[A-Za-z][)）]?$/;

export interface PaperFigure {
  image: string;
  image_path: string | null;
  caption: string;
  captionFrom: "alt" | "block" | null;
  section: string | null;
  offset: number;
}

export interface PaperFigureListing {
  total: number;
  total_found: number;
  truncated: boolean;
  offset: number;
  limit: number;
  next_offset: number | null;
  orphanCaptions: number;
  figures: PaperFigure[];
}

export interface PaperFigureListOptions {
  offset?: number;
  limit?: number;
}

interface ImageOccurrence {
  ref: string;
  index: number;
  key: string;
  alt: string;
  raw: string;
}

export function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

export function stripAngle(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

export function decodeRef(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function isLocalRelativeImageRef(ref: string): boolean {
  const value = stripAngle(ref);
  if (!value || value.startsWith("#")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

export function withinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolveImagePathWithinRoots(filePath: string, roots: string[]): string | null {
  const candidate = path.resolve(filePath);
  for (const root of roots) {
    const lexicalRoot = path.resolve(root);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(lexicalRoot);
    } catch {
      continue;
    }
    if (!withinRoot(candidate, lexicalRoot) && !withinRoot(candidate, realRoot)) continue;
    try {
      const realCandidate = fs.realpathSync(candidate);
      if (!withinRoot(realCandidate, realRoot) || !fs.statSync(realCandidate).isFile()) continue;
      return slash(realCandidate);
    } catch {
      continue;
    }
  }
  return null;
}

export function markdownImageDestination(value: string): string {
  if (!/[\s()<>]/.test(value)) return value;
  return `<${value.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

function resolvePaperImagePath(paperDir: string, ref: string): string | null {
  if (!isLocalRelativeImageRef(ref)) return null;
  const clean = decodeRef(stripAngle(ref));
  return resolveImagePathWithinRoots(path.resolve(paperDir, clean), [paperDir]);
}

function imageOccurrences(text: string): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = [];
  let markdownOrdinal = 0;
  let htmlOrdinal = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  HTML_IMG_RE.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    occurrences.push({
      ref: match[2],
      index: match.index ?? 0,
      key: `markdown:${markdownOrdinal++}`,
      alt: match[1],
      raw: match[0],
    });
  }
  for (const match of text.matchAll(HTML_IMG_RE)) {
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(match[0]);
    occurrences.push({
      ref: match[3] ?? match[4] ?? "",
      index: match.index ?? 0,
      key: `html:${htmlOrdinal++}`,
      alt: alt?.[2] ?? alt?.[3] ?? "",
      raw: match[0],
    });
  }
  return occurrences.sort((left, right) => left.index - right.index);
}

function rewriteImagePaths(text: string, resolve: (ref: string) => string | null): string {
  const resolved = new Map<string, string>();
  const byRef = new Map<string, string | null>();
  for (const occurrence of imageOccurrences(text)) {
    if (!isLocalRelativeImageRef(occurrence.ref)) continue;
    const ref = stripAngle(occurrence.ref);
    if (!byRef.has(ref)) byRef.set(ref, resolve(ref));
    const absolute = byRef.get(ref);
    if (absolute) resolved.set(occurrence.key, absolute);
  }
  if (!resolved.size) return text;
  let markdownOrdinal = 0;
  let htmlOrdinal = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  HTML_IMG_RE.lastIndex = 0;
  const withMarkdown = text.replace(MARKDOWN_IMAGE_RE, (whole, alt: string, _destination: string, title = "") => {
    const absolute = resolved.get(`markdown:${markdownOrdinal++}`);
    if (!absolute) return whole;
    return `![${alt}](${markdownImageDestination(absolute)}${title ? ` ${title.trim()}` : ""})`;
  });
  return withMarkdown.replace(
    HTML_IMG_RE,
    (whole, before: string, quoted: string, _double?: string, _single?: string, after = "") => {
      const absolute = resolved.get(`html:${htmlOrdinal++}`);
      if (!absolute) return whole;
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `<img${before}src=${quote}${absolute}${quote}${after}>`;
    },
  );
}

export function rewritePaperImagePaths(paperDir: string, text: string): string {
  if (!text || (!text.includes("![") && !/<img/i.test(text))) return text;
  return rewriteImagePaths(text, (ref) => resolvePaperImagePath(paperDir, ref));
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isImageOnlyLine(line: string): boolean {
  const occurrences = imageOccurrences(line);
  if (!occurrences.length) return false;
  let remainder = line;
  for (const occurrence of [...occurrences].sort((left, right) => right.index - left.index)) {
    remainder = remainder.slice(0, occurrence.index) + remainder.slice(occurrence.index + occurrence.raw.length);
  }
  return remainder.trim() === "";
}

function isOrphanFigureCaption(line: string): boolean {
  return ORPHAN_EN_CAPTION_RE.test(line) || ORPHAN_ZH_CAPTION_RE.test(line);
}

export function listPaperFigures(
  paperDir: string,
  markdown: string,
  options: PaperFigureListOptions = {},
): PaperFigureListing {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 50);
  const parsed = parsePaperCanonical(markdown);
  const body = parsed.body;
  const lines = body.split("\n");
  const lineOffsets: number[] = [];
  let nextOffset = 0;
  for (const line of lines) {
    lineOffsets.push(nextOffset);
    nextOffset += line.length + 1;
  }
  const figures: PaperFigure[] = [];
  const usedCaptionLines = new Set<number>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const occurrence of imageOccurrences(lines[lineIndex])) {
      const source = stripAngle(occurrence.ref);
      if (!isLocalRelativeImageRef(source)) continue;
      const canonicalOffset = lineOffsets[lineIndex] + occurrence.index;
      const alt = collapse(occurrence.alt);
      let caption = alt;
      let captionFrom: PaperFigure["captionFrom"] = alt ? "alt" : null;
      const labelOnly = alt.length <= 20 && CAPTION_RE.test(alt);
      for (let probeIndex = lineIndex + 1; probeIndex <= Math.min(lineIndex + 8, lines.length - 1); probeIndex += 1) {
        if (parsed.headings.some((heading) => heading.start === lineOffsets[probeIndex])) break;
        const probe = lines[probeIndex].trim();
        if (!probe || PANEL_RE.test(probe) || isImageOnlyLine(probe)) continue;
        if (CAPTION_RE.test(probe)) {
          usedCaptionLines.add(probeIndex);
          if (!alt || labelOnly) {
            caption = collapse(probe);
            captionFrom = "block";
          }
        }
        break;
      }
      const heading = [...parsed.headings].reverse().find((candidate) => candidate.start <= canonicalOffset);
      figures.push({
        image: source,
        image_path: resolvePaperImagePath(paperDir, source),
        caption,
        captionFrom,
        section: heading?.text ?? null,
        offset: canonicalOffset,
      });
    }
  }

  let orphanCaptions = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (isOrphanFigureCaption(lines[index].trim()) && !usedCaptionLines.has(index)) orphanCaptions += 1;
  }
  const page = figures.slice(offset, offset + limit);
  const nextFigureOffset = offset + page.length < figures.length ? offset + page.length : null;
  return {
    total: page.length,
    total_found: figures.length,
    truncated: nextFigureOffset !== null,
    offset,
    limit,
    next_offset: nextFigureOffset,
    orphanCaptions,
    figures: page,
  };
}
