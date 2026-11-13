import fs from "node:fs";
import sharp from "sharp";
import { resolveImagePathWithinRoots } from "./document-images.js";

export type ImageMcpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" };

export interface ReadImageBatchOptions {
  maxEdge?: number;
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const BATCH_DATA_URL_CHARS = 700_000;
const SUPPORTED_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "avif", "heif", "tiff", "gif"]);

interface EncodedImage {
  data: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

function isAbsoluteImagePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

async function encodeJpeg(source: Buffer, maxEdge: number, targetDataUrlChars: number): Promise<EncodedImage> {
  const metadata = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => {
    throw new Error("图片解码失败：文件不是受支持的光栅图片，或内容已损坏");
  });
  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    throw new Error("不是受支持的光栅图片（SVG 与伪造图片不予读取）");
  }
  if (!metadata.width || !metadata.height) throw new Error("无法读取图片尺寸");
  const rotated = metadata.orientation != null && metadata.orientation >= 5;
  const sourceWidth = rotated ? metadata.height : metadata.width;
  const sourceHeight = rotated ? metadata.width : metadata.height;
  const sourceEdge = Math.max(sourceWidth, sourceHeight);
  let edge = Math.min(maxEdge, sourceEdge);
  let quality = 82;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dimensions = sourceWidth >= sourceHeight ? { width: edge } : { height: edge };
    const { data, info } = await sharp(source, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ ...dimensions, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.toString("base64").length <= targetDataUrlChars) {
      return {
        data,
        width: info.width,
        height: info.height,
        downscaled: info.width < sourceWidth || info.height < sourceHeight,
      };
    }
    quality = Math.max(36, quality - 10);
    edge = Math.max(256, Math.floor(edge * 0.8));
  }
  throw new Error("图片在批量预算内仍无法有效压缩，请减少张数或降低 max_edge");
}

export async function readImageBatch(
  paths: string[],
  roots: string[],
  options: ReadImageBatchOptions = {},
): Promise<ImageMcpContent[]> {
  const maxEdge = Math.min(Math.max(options.maxEdge ?? 1024, 512), 1536);
  const targetDataUrlChars = Math.max(40_000, Math.floor((BATCH_DATA_URL_CHARS * 0.9) / paths.length));
  const content: ImageMcpContent[] = [];
  const failures: string[] = [];

  for (let index = 0; index < paths.length; index += 1) {
    const input = paths[index];
    const ordinal = `第 ${index + 1}/${paths.length} 张：`;
    try {
      if (!isAbsoluteImagePath(input)) throw new Error("需要绝对路径，不能传 Markdown 相对路径");
      const resolved = resolveImagePathWithinRoots(input, roots);
      if (!resolved) throw new Error("图片不存在，或不在当前文档及其图片缓存允许范围内");
      const descriptor = fs.openSync(resolved, "r");
      let source: Buffer;
      try {
        const before = fs.fstatSync(descriptor);
        if (before.size > MAX_SOURCE_BYTES) throw new Error("图片体积超过 20 MiB 上限");
        const buffer = Buffer.alloc(before.size + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (count === 0) break;
          bytesRead += count;
        }
        const after = fs.fstatSync(descriptor);
        if (after.size !== before.size) throw new Error("图片大小在读取过程中发生变化，请重试");
        if (bytesRead > MAX_SOURCE_BYTES) throw new Error("图片体积超过 20 MiB 上限");
        source = buffer.subarray(0, bytesRead);
      } finally {
        fs.closeSync(descriptor);
      }
      if (resolveImagePathWithinRoots(resolved, roots) !== resolved) {
        throw new Error("图片规范路径在读取过程中发生变化，请重试");
      }
      const encoded = await encodeJpeg(source, maxEdge, targetDataUrlChars);
      const sourceMb = (source.length / 1048576).toFixed(2);
      const payloadKb = Math.round(encoded.data.length / 1024);
      content.push({
        type: "text",
        text: `${ordinal}<path>${resolved}</path><type>image</type><content>image/jpeg ${encoded.width}x${encoded.height} px, ${sourceMb} MB source, payload ${payloadKb} KB${encoded.downscaled ? " (resized)" : ""}</content>\n请基于图片内容回答；引用时说明图号/所在小节，不要编造图中不存在的细节。`,
      });
      content.push({ type: "image", data: encoded.data.toString("base64"), mimeType: "image/jpeg" });
    } catch (error) {
      failures.push(`${ordinal}${input}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  if (failures.length) {
    const succeeded = content.filter((part) => part.type === "image").length;
    content.unshift({
      type: "text",
      text: succeeded
        ? `部分图片读取失败：成功 ${succeeded} 张、失败 ${failures.length} 张；详见末尾错误清单。`
        : `全部图片读取失败：共 ${failures.length} 张；详见末尾错误清单。`,
    });
    content.push({
      type: "text",
      text: `以下图片未能读取：\n${failures.join("\n")}`,
    });
  }
  return content;
}
