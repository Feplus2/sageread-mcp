import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createFixtureApp, McpClient, toolJson } from "./test-helpers.mjs";

const documentImages = await import("../dist/document-images.js").catch(() => null);
const slash = (value) => value.replace(/\\/g, "/");

function requireModule() {
  assert.equal(typeof documentImages?.rewritePaperImagePaths, "function", "rewritePaperImagePaths must exist");
  assert.equal(typeof documentImages?.listPaperFigures, "function", "listPaperFigures must exist");
  assert.equal(typeof documentImages?.resolveImagePathWithinRoots, "function", "resolveImagePathWithinRoots must exist");
  return documentImages;
}

test("paper image paths rewrite only existing local images after URI decoding", () => {
  const { rewritePaperImagePaths, resolveImagePathWithinRoots } = requireModule();
  const app = createFixtureApp();
  try {
    app.addBook({ id: "paper-paths" });
    app.writeBookFile("paper-paths", "images/fig 1.png", Buffer.from([1]));
    app.writeBookFile("paper-paths", "paper.md", "placeholder");
    app.writeBookFile("paper-paths", "../outside.png", Buffer.from([2]));
    const paperDir = path.join(app.appDir, "books", "paper-paths");
    const absolute = slash(path.join(paperDir, "images", "fig 1.png"));
    const input = [
      "![Alt](images/fig%201.png \"Figure title\")",
      "![Space](<images/fig 1.png>)",
      "<img src=\"images/fig%201.png\" alt=\"Alt\">",
      "<img alt=\"a > b\" src=\"images/fig%201.png\">",
      "![Missing](images/missing.png)",
      "![External](https://example.com/a.png)",
      "![Data](data:image/png;base64,AAAA)",
      "![Escape](../outside.png)",
      "![EncodedEscape](..%2Foutside.png)",
    ].join("\n");
    const output = rewritePaperImagePaths(paperDir, input);
    assert.ok(output.includes(`![Alt](<${absolute}> "Figure title")`), output);
    assert.ok(output.includes(`![Space](<${absolute}>)`), output);
    assert.ok(output.includes(`<img src="${absolute}" alt="Alt">`), output);
    assert.ok(output.includes(`<img alt="a > b" src="${absolute}">`), output);
    assert.ok(output.includes("![Missing](images/missing.png)"), output);
    assert.ok(output.includes("![External](https://example.com/a.png)"), output);
    assert.ok(output.includes("![Data](data:image/png;base64,AAAA)"), output);
    assert.ok(output.includes("![Escape](../outside.png)"), output);
    assert.ok(output.includes("![EncodedEscape](..%2Foutside.png)"), output);
    assert.equal(resolveImagePathWithinRoots(path.join(paperDir, "..", "outside.png"), [paperDir]), null);
  } finally {
    app.cleanup();
  }
});

test("paper figure discovery attaches captions, sections, canonical offsets, and honest missing paths", () => {
  const { listPaperFigures } = requireModule();
  const app = createFixtureApp();
  try {
    app.addBook({ id: "paper-figures" });
    app.writeBookFile("paper-figures", "images/a.png", Buffer.from([1]));
    const markdown = `---\ntitle: Figures\n---\n# Intro\n![Figure 1](images/a.png)\nFigure 1. Full caption.\n![Alt B](images/b.png)\n# Next\nFigure 9. Orphan caption.`;
    const listing = listPaperFigures(path.join(app.appDir, "books", "paper-figures"), markdown);
    assert.equal(listing.total, 2);
    assert.equal(listing.truncated, false);
    assert.equal(listing.orphanCaptions, 1);
    assert.equal(listing.figures[0].caption, "Figure 1. Full caption.");
    assert.equal(listing.figures[0].captionFrom, "block");
    assert.equal(listing.figures[0].section, "Intro");
    assert.equal(listing.figures[0].image_path, slash(path.join(app.appDir, "books", "paper-figures", "images", "a.png")));
    assert.equal(listing.figures[1].caption, "Alt B");
    assert.equal(listing.figures[1].captionFrom, "alt");
    assert.equal(listing.figures[1].image_path, null);
    const canonicalBody = markdown.slice(markdown.indexOf("# Intro"));
    assert.equal(listing.figures[0].offset, canonicalBody.indexOf("!["));
    assert.equal(listing.figures[1].offset, canonicalBody.indexOf("![Alt B]"));
  } finally {
    app.cleanup();
  }
});

test("paper figure discovery reports the full count and paginates by figure offset", () => {
  const { listPaperFigures } = requireModule();
  const app = createFixtureApp();
  try {
    const markdown = Array.from({ length: 55 }, (_, index) => `![Figure ${index + 1}](images/${index}.png)`).join("\n");
    const first = listPaperFigures(path.join(app.appDir, "books", "paper-limit"), markdown, { limit: 50 });
    assert.equal(first.figures.length, 50);
    assert.equal(first.total, 50);
    assert.equal(first.total_found, 55);
    assert.equal(first.next_offset, 50);
    assert.equal(first.truncated, true);
    const second = listPaperFigures(path.join(app.appDir, "books", "paper-limit"), markdown, {
      limit: 50,
      offset: first.next_offset,
    });
    assert.equal(second.total, 5);
    assert.equal(second.total_found, 55);
    assert.equal(second.next_offset, null);
    assert.equal(second.truncated, false);
  } finally {
    app.cleanup();
  }
});

test("MCP rewrites paper read windows and lists figures through DocRef", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-mcp", title: "Paper images" });
    app.addBook({ id: "ordinary-book", format: "EPUB" });
    app.writeBookFile("paper-mcp", "images/a.png", Buffer.from([1]));
    app.writeBookFile("paper-mcp", "paper.md", "# Intro\n![Figure 1](images/a.png)\nFigure 1. Caption.\n<img alt=\"Figure 2\" src=\"images/a.png\" data-note=\"a > b\">\nFigure 2. HTML caption.");
    app.close();
    await client.initialize();
    const read = await client.callTool("read_document", { doc: "paper:paper-mcp", offset: 0, after: 1000 });
    assert.equal(read.isError, false, read.text);
    const readBody = toolJson(read);
    assert.ok(readBody.text.includes(slash(path.join(app.appDir, "books", "paper-mcp", "images", "a.png"))), readBody.text);
    assert.equal(readBody.range.start, 0);
    assert.equal(readBody.next_offset, null);
    assert.equal(readBody.range.end, "# Intro\n![Figure 1](images/a.png)\nFigure 1. Caption.\n<img alt=\"Figure 2\" src=\"images/a.png\" data-note=\"a > b\">\nFigure 2. HTML caption.".length);
    const info = await client.callTool("get_document_info", { doc: "paper:paper-mcp" });
    assert.equal(toolJson(info).图表数, 2);

    const response = await client.callTool("list_paper_figures", { doc: "paper:paper-mcp" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.equal(body.doc, "paper:paper-mcp");
    assert.equal(body.total, 2);
    assert.equal(body.total_found, 2);
    assert.equal(body.figures[0].caption, "Figure 1. Caption.");
    assert.equal(body.figures[0].section, "Intro");

    const wrongKind = await client.callTool("list_paper_figures", { doc: "book:ordinary-book" });
    assert.equal(wrongKind.isError, true);
    assert.ok(wrongKind.text.includes("仅支持论文"), wrongKind.text);
  } finally {
    await client.close();
    app.cleanup();
  }
});

function imageParts(response) {
  return (response.raw.result?.content ?? []).filter((part) => part.type === "image");
}

function textParts(response) {
  return (response.raw.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function pngFixture(width = 1200, height = 700, color = { r: 240, g: 240, b: 240 }) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="#2255aa"/><text x="70" y="140" font-size="52" fill="white">Figure</text></svg>`), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

test("read_images returns a real JPEG MCP image and honors max_edge", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-image-content" });
    const source = await pngFixture();
    app.writeBookFile("paper-image-content", "images/source.png", source);
    app.close();
    await client.initialize();
    const absolute = path.join(app.appDir, "books", "paper-image-content", "images", "source.png");
    const response = await client.callTool("read_images", {
      doc: "paper:paper-image-content",
      paths: [absolute],
      max_edge: 512,
    }, 30000);
    assert.equal(response.isError, false, response.text);
    const images = imageParts(response);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/jpeg");
    assert.ok(!images[0].data.startsWith("data:"));
    const metadata = await sharp(Buffer.from(images[0].data, "base64")).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.ok(Math.max(metadata.width, metadata.height) <= 512);
    assert.ok(textParts(response).includes(slash(absolute)), textParts(response));
    assert.ok(textParts(response).includes("image/jpeg"), textParts(response));
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("read_images keeps valid batch members within budget and reports failures honestly", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-batch" });
    app.addBook({ id: "outside-doc" });
    const first = await pngFixture(1000, 900);
    const second = await sharp(await pngFixture(900, 800, { r: 220, g: 230, b: 245 })).jpeg().toBuffer();
    app.writeBookFile("paper-batch", "images/a.png", first);
    app.writeBookFile("paper-batch", "images/b.jpg", second);
    app.writeBookFile("paper-batch", "images/fake.png", "not an image");
    app.writeBookFile("outside-doc", "images/outside.png", first);
    const paperDir = path.join(app.appDir, "books", "paper-batch");
    const a = path.join(paperDir, "images", "a.png");
    const b = path.join(paperDir, "images", "b.jpg");
    const missing = path.join(paperDir, "images", "missing.png");
    const fake = path.join(paperDir, "images", "fake.png");
    const outside = path.join(app.appDir, "books", "outside-doc", "images", "outside.png");
    app.close();
    await client.initialize();

    const response = await client.callTool("read_images", {
      doc: "paper:paper-batch",
      paths: [a, missing, b],
      max_edge: 512,
    }, 30000);
    assert.equal(response.isError, false, response.text);
    assert.ok(response.raw.result.content[0].text.includes("部分图片读取失败"), response.raw.result.content[0].text);
    const images = imageParts(response);
    assert.equal(images.length, 2);
    assert.ok(images.reduce((sum, image) => sum + image.data.length, 0) <= 700000);
    assert.ok(textParts(response).includes("missing.png"), textParts(response));

    const allFailed = await client.callTool("read_images", {
      doc: "paper:paper-batch",
      paths: ["images/a.png", fake, outside],
    }, 30000);
    assert.equal(allFailed.isError, true);
    assert.equal(imageParts(allFailed).length, 0);
    assert.ok(textParts(allFailed).includes("绝对路径"), textParts(allFailed));
    assert.ok(textParts(allFailed).includes("fake.png"), textParts(allFailed));
    assert.ok(textParts(allFailed).includes("图片解码失败"), textParts(allFailed));
    assert.ok(textParts(allFailed).includes("outside.png"), textParts(allFailed));

    const tooMany = await client.callTool("read_images", {
      doc: "paper:paper-batch",
      paths: Array(7).fill(a),
    });
    assert.equal(tooMany.isError, true);
    assert.equal(imageParts(tooMany).length, 0);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("read_images rejects symlink escapes and sources over twenty MiB", async (t) => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-guard" });
    app.addBook({ id: "other-doc" });
    const source = await pngFixture(100, 100);
    app.writeBookFile("other-doc", "outside.png", source);
    const paperDir = path.join(app.appDir, "books", "paper-guard");
    const outside = path.join(app.appDir, "books", "other-doc", "outside.png");
    const link = path.join(paperDir, "images", "link.png");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link, "file");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("symlink creation is unavailable on this Windows account");
      } else {
        throw error;
      }
    }
    const big = path.join(paperDir, "images", "big.png");
    fs.writeFileSync(big, Buffer.from([0]));
    fs.truncateSync(big, 20 * 1024 * 1024 + 1);
    app.close();
    await client.initialize();
    const paths = fs.existsSync(link) ? [link, big] : [big];
    const response = await client.callTool("read_images", { doc: "paper:paper-guard", paths }, 30000);
    assert.equal(response.isError, true);
    assert.equal(imageParts(response).length, 0);
    assert.ok(textParts(response).includes("20"), textParts(response));
    if (fs.existsSync(link)) assert.ok(textParts(response).includes("link.png"), textParts(response));
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("book image reads allow only that book's EPUB cache", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "book-one", format: "EPUB" });
    app.addBook({ id: "book-two", format: "EPUB" });
    const cacheDir = path.join(app.appDir, "image-cache", "epub", "book-one");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, "figure.png");
    fs.writeFileSync(cached, await pngFixture(200, 100));
    app.close();
    await client.initialize();
    const allowed = await client.callTool("read_images", { doc: "book:book-one", paths: [cached] }, 30000);
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(imageParts(allowed).length, 1);
    const denied = await client.callTool("read_images", { doc: "book:book-two", paths: [cached] }, 30000);
    assert.equal(denied.isError, true);
    assert.equal(imageParts(denied).length, 0);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("figure paths remain readable when the document root is a junction", async (t) => {
  const { listPaperFigures } = requireModule();
  const { readImageBatch } = await import("../dist/image-content.js");
  const app = createFixtureApp();
  try {
    app.addBook({ id: "paper-junction" });
    const paperDir = path.join(app.appDir, "books", "paper-junction");
    app.writeBookFile("paper-junction", "images/a.png", await pngFixture(120, 80));
    const alias = path.join(app.appDir, "paper-alias");
    try {
      fs.symlinkSync(paperDir, alias, "junction");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        return t.skip("junction creation is unavailable on this Windows account");
      }
      throw error;
    }
    const listing = listPaperFigures(alias, "# Intro\n![Figure 1](images/a.png)");
    assert.equal(listing.figures[0].image_path, slash(path.join(paperDir, "images", "a.png")));
    const content = await readImageBatch([listing.figures[0].image_path], [alias], { maxEdge: 512 });
    assert.equal(content.filter((part) => part.type === "image").length, 1, content.map((part) => part.text).join("\n"));
  } finally {
    app.cleanup();
  }
});

test("figure discovery includes HTML images and uses precise caption ownership", () => {
  const { listPaperFigures } = requireModule();
  const app = createFixtureApp();
  try {
    app.addBook({ id: "paper-html-figures" });
    app.writeBookFile("paper-html-figures", "images/a.png", Buffer.from([1]));
    const markdown = [
      "# Intro",
      "<img alt=\"Figure 2\" src=\"images/a.png\" data-note=\"a > b\">",
      "Figure 2. HTML caption.",
      "![Descriptive alt](images/a.png)",
      "Figure 3. Descriptive caption.",
      "Table 8. A table caption is not an orphan figure caption.",
      "Fig. 7 illustrates a result rather than captions it.",
      "Figure 9. Actually orphaned.",
    ].join("\n");
    const listing = listPaperFigures(path.join(app.appDir, "books", "paper-html-figures"), markdown);
    assert.equal(listing.total_found, 2);
    assert.equal(listing.figures[0].caption, "Figure 2. HTML caption.");
    assert.equal(listing.figures[0].captionFrom, "block");
    assert.equal(listing.figures[1].caption, "Descriptive alt");
    assert.equal(listing.figures[1].captionFrom, "alt");
    assert.equal(listing.orphanCaptions, 1);
  } finally {
    app.cleanup();
  }
});

test("six images stay within the batch budget and transparency flattens onto white", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-six" });
    const transparent = await sharp({
      create: { width: 900, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: Buffer.from('<svg width="900" height="700"><rect x="100" y="100" width="500" height="300" fill="#cc2244"/></svg>'), top: 0, left: 0 }])
      .png()
      .toBuffer();
    const paths = [];
    for (let index = 0; index < 6; index += 1) {
      const name = `images/${index}.png`;
      app.writeBookFile("paper-six", name, transparent);
      paths.push(path.join(app.appDir, "books", "paper-six", name));
    }
    app.close();
    await client.initialize();
    const response = await client.callTool("read_images", { doc: "paper:paper-six", paths }, 30000);
    assert.equal(response.isError, false, response.text);
    const images = imageParts(response);
    assert.equal(images.length, 6);
    assert.ok(images.reduce((sum, image) => sum + image.data.length, 0) <= 700000);
    const { data, info } = await sharp(Buffer.from(images[0].data, "base64")).raw().toBuffer({ resolveWithObject: true });
    const pixel = (info.width * 5 + 5) * info.channels;
    assert.ok(data[pixel] >= 250 && data[pixel + 1] >= 250 && data[pixel + 2] >= 250, "transparent corner must become white");
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("read_images applies EXIF orientation before reporting dimensions", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-exif" });
    const source = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#336699" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    app.writeBookFile("paper-exif", "images/oriented.jpg", source);
    app.close();
    await client.initialize();
    const absolute = path.join(app.appDir, "books", "paper-exif", "images", "oriented.jpg");
    const response = await client.callTool("read_images", { doc: "paper:paper-exif", paths: [absolute] }, 30000);
    assert.equal(response.isError, false, response.text);
    const metadata = await sharp(Buffer.from(imageParts(response)[0].data, "base64")).metadata();
    assert.equal(metadata.width, 100);
    assert.equal(metadata.height, 200);
  } finally {
    await client.close();
    app.cleanup();
  }
});
