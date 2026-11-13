import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { addVectorChunk, createFixtureApp, createVectorDb, McpClient, toolJson, writeEpubFixture as registerEpub } from "./test-helpers.mjs";

const paper = await import("../dist/paper-document.js").catch(() => null);
const book = await import("../dist/book-document.js").catch(() => null);
const slash = (value) => value.replace(/\\/g, "/");
const parsedFixture = `---\r\ntitle: Window fixture\r\n---\r\n# Alpha\r\nBefore\r\n$$x^2$$\r\n😀\r\n# Beta\r\n12345`;
const sectionText = `${"A".repeat(400)}😀${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(48).slice(0, 1698)}`;
const windowMarkdown = `---\ntitle: Window fixture\n---\n# Alpha\n${sectionText}\n# Beta\n12345`;

test("parsePaperCanonical removes frontmatter, normalizes CRLF/display math, and keeps UTF-16 offsets", () => {
  assert.equal(typeof paper?.parsePaperCanonical, "function", "parsePaperCanonical must exist");
  if (!paper?.parsePaperCanonical) return;
  const parsed = paper.parsePaperCanonical(parsedFixture);
  assert.equal(parsed.body, "# Alpha\nBefore\n$$\nx^2\n$$\n😀\n# Beta\n12345");
  assert.deepEqual(
    parsed.headings.map(({ text, level, start, contentStart }) => ({ text, level, start, contentStart })),
    [
      { text: "Alpha", level: 1, start: 0, contentStart: 8 },
      { text: "Beta", level: 1, start: 28, contentStart: 35 },
    ],
  );
});

test("paper heading replays three absolute canonical windows without duplication or gaps", () => {
  assert.equal(typeof paper?.readPaperWindow, "function", "readPaperWindow must exist");
  if (!paper?.readPaperWindow) return;
  const parsed = paper.parsePaperCanonical(windowMarkdown);
  const alpha = parsed.headings[0];
  const first = paper.readPaperWindow(windowMarkdown, { heading: "Alpha", after: 500 });
  const second = paper.readPaperWindow(windowMarkdown, { heading: "Alpha", offset: first.nextOffset, after: 500 });
  const third = paper.readPaperWindow(windowMarkdown, { heading: "Alpha", offset: second.nextOffset, after: 500 });
  assert.equal(first.text, sectionText.slice(0, 500));
  assert.equal(first.nextOffset, 508);
  assert.equal(second.text, sectionText.slice(500, 1000));
  assert.equal(second.nextOffset, 1008);
  assert.equal(third.text, sectionText.slice(1000, 1500));
  assert.equal(third.nextOffset, 1508);
  assert.equal(first.text + second.text + third.text, parsed.body.slice(alpha.contentStart, alpha.contentStart + 1500));
  assert.equal((first.text + second.text + third.text).split("😀").length, 2);
});

test("paper before/after, short sections, repeated text, and EOF stay within canonical bounds", () => {
  assert.equal(typeof paper?.readPaperWindow, "function", "readPaperWindow must exist");
  if (!paper?.readPaperWindow) return;
  const parsed = paper.parsePaperCanonical(windowMarkdown);
  const early = paper.readPaperWindow(windowMarkdown, { offset: 2, before: 10, after: 500 });
  assert.equal(early.text, parsed.body.slice(0, 502));
  assert.equal(early.nextOffset, 502);
  const ordinary = paper.readPaperWindow(windowMarkdown, { offset: 1000, before: 200, after: 500 });
  assert.equal(ordinary.text, parsed.body.slice(800, 1500));
  assert.equal(ordinary.nextOffset, 1500);
  const context = paper.readPaperWindow(windowMarkdown, { heading: "Alpha", offset: 1008, before: 200, after: 500 });
  assert.equal(context.text, parsed.body.slice(808, 1508));
  const short = paper.readPaperWindow(windowMarkdown, { heading: "Beta", after: 6000 });
  assert.equal(short.text, "12345");
  assert.equal(short.nextOffset, null);
  assert.equal(short.truncated, false);
  const eof = paper.readPaperWindow(windowMarkdown, { offset: parsed.body.length, before: 10, after: 500 });
  assert.equal(eof.text, parsed.body.slice(-10));
  assert.equal(eof.nextOffset, null);
  const repeated = paper.readPaperWindow(`# Same\nabc\n# Same\nabc`, { heading: "Same", after: 2 });
  const replay = paper.readPaperWindow(`# Same\nabc\n# Same\nabc`, {
    heading: "Same",
    offset: repeated.nextOffset,
    after: 2,
  });
  assert.equal(repeated.text + replay.text, "abc\n");
  assert.equal(replay.nextOffset, null);
});

test("findCanonicalMatch maps normalized snippets to original offsets and degrades ambiguity", () => {
  assert.equal(typeof paper?.findCanonicalMatch, "function", "findCanonicalMatch must exist");
  if (!paper?.findCanonicalMatch) return;
  const canonical = "Head\nAlpha   beta\n\tgamma 😀 tail";
  assert.deepEqual(paper.findCanonicalMatch(canonical, "  Alpha beta   gamma 😀  "), {
    offset: 5,
    anchor_precision: "exact",
  });
  assert.deepEqual(paper.findCanonicalMatch(canonical, "not present"), {
    offset: null,
    anchor_precision: "section",
  });
  assert.deepEqual(paper.findCanonicalMatch("same\n\nsame", "same"), {
    offset: null,
    anchor_precision: "section",
  });
  assert.deepEqual(paper.findCanonicalMatch("Before cationic   potential after", "cationic potential …"), {
    offset: 7,
    anchor_precision: "exact",
  });
});

test("read_document MCP uses canonical paper offsets instead of raw paper.md offsets", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "paper-window", title: "Window fixture" });
    app.writeBookFile("paper-window", "paper.md", windowMarkdown);
    app.close();
    await client.initialize();
    const first = await client.callTool("read_document", {
      doc: "paper:paper-window",
      heading: "Alpha",
      after: 500,
    });
    assert.equal(first.isError, false, first.text);
    const firstBody = toolJson(first);
    assert.equal(firstBody.text ?? firstBody.文本, sectionText.slice(0, 500));
    assert.equal(firstBody.next_offset, 508);
    assert.equal(firstBody.total_chars ?? firstBody.总字符数, paper?.parsePaperCanonical?.(windowMarkdown).body.length);
    const second = await client.callTool("read_document", {
      doc: "paper:paper-window",
      heading: "Alpha",
      offset: firstBody.next_offset,
      after: 500,
    });
    assert.equal(second.isError, false, second.text);
    assert.equal(toolJson(second).text ?? toolJson(second).文本, sectionText.slice(500, 1000));
  } finally {
    await client.close();
    app.cleanup();
  }
});

const STRUCTURED_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="chapter">Structured chapter</h1>
<p>Energy <math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math> and <math xmlns="http://www.w3.org/1998/Math/MathML" alttext="a+b"><mi>ignored</mi></math>.</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mi>U</mi><annotation encoding="application/x-tex">U=\\sum_i m_i</annotation></semantics></math>
<figure><img src="../images/in-window.png" alt="Plot A"/><figcaption>Caption</figcaption></figure>
<table><tbody>
<tr><th>Name</th><th>Formula</th><th>Note</th></tr>
<tr><td rowspan="2">A|B</td><td><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></td><td>one<br/>two</td></tr>
<tr><td colspan="2"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mi>y</mi><annotation encoding="application/x-tex">y=1</annotation></semantics></math> tail</td></tr>
</tbody></table>
</body></html>`;

test("book structured extraction preserves TeX, tables, and image src/alt", () => {
  assert.equal(typeof book?.extractStructuredText, "function", "extractStructuredText must exist");
  if (!book?.extractStructuredText) return;
  const document = new JSDOM(STRUCTURED_XHTML, { contentType: "application/xhtml+xml" }).window.document;
  const structured = book.extractStructuredText(document, null).text;
  assert.ok(structured.includes("Energy $E=mc^2$ and $a+b$."), structured);
  assert.ok(structured.includes("$$\nU=\\sum_i m_i\n$$"), structured);
  assert.ok(structured.includes("![Plot A](../images/in-window.png)"), structured);
  assert.ok(structured.includes("| A\\|B | $x^2$ | one two |"), structured);
  assert.ok(structured.includes("| | $y=1$ tail | |"), structured);
  assert.ok(structured.includes("| Name | Formula | Note |\n| --- | --- | --- |"), structured);
});

test("book section and full-document canonical preserve spine boundaries and UTF-16 offsets", async () => {
  assert.equal(typeof book?.readBookSectionCanonical, "function", "readBookSectionCanonical must exist");
  assert.equal(typeof book?.readBookDocumentCanonical, "function", "readBookDocumentCanonical must exist");
  if (!book?.readBookSectionCanonical || !book?.readBookDocumentCanonical) return;
  const app = createFixtureApp();
  try {
    const alpha = `Alpha 😀 ${"a".repeat(550)}`;
    const beta = `Beta ${"b".repeat(550)}`;
    registerEpub(app, "absolute-book", [
      { id: "one.xhtml", label: "One", body: `<p id="chapter">${alpha}</p>` },
      { id: "two.xhtml", label: "Two", body: `<p id="chapter">${beta}</p>` },
    ]);
    const dir = path.join(app.appDir, "books", "absolute-book");
    const one = await book.readBookSectionCanonical(dir, { heading: "One" });
    const two = await book.readBookSectionCanonical(dir, { spine: 1 });
    assert.equal(one.kind, "ok");
    assert.equal(one.text, alpha);
    assert.equal(two.kind, "ok");
    assert.equal(two.text, beta);
    const full = await book.readBookDocumentCanonical(dir);
    assert.equal(full.text, `${alpha}\n\n${beta}`);
    assert.equal(full.totalChars, full.text.length);
    assert.equal(full.segments.length, 2);
    assert.equal(full.segments[1].start, alpha.length + 2);
  } finally {
    app.cleanup();
  }
});

test("read_document MCP supports full-book absolute windows across spine", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    const alpha = `Alpha 😀 ${"a".repeat(550)}`;
    const beta = `Beta ${"b".repeat(550)}`;
    const expected = `${alpha}\n\n${beta}`;
    registerEpub(app, "absolute-book", [
      { id: "one.xhtml", label: "One", body: `<p id="chapter">${alpha}</p>` },
      { id: "two.xhtml", label: "Two", body: `<p id="chapter">${beta}</p>` },
    ]);
    app.close();
    await client.initialize();
    const first = await client.callTool("read_document", { doc: "book:absolute-book", offset: 0, after: 500 });
    assert.equal(first.isError, false, first.text);
    const firstBody = toolJson(first);
    assert.equal(firstBody.text ?? firstBody.文本, expected.slice(0, 500));
    const second = await client.callTool("read_document", {
      doc: "book:absolute-book",
      offset: firstBody.next_offset,
      after: 500,
    });
    const third = await client.callTool("read_document", {
      doc: "book:absolute-book",
      offset: toolJson(second).next_offset,
      after: 500,
    });
    assert.equal(toolJson(second).text ?? toolJson(second).文本, expected.slice(500, 1000));
    assert.equal(toolJson(third).text ?? toolJson(third).文本, expected.slice(1000));
    assert.equal(toolJson(third).next_offset, null);
    assert.equal((firstBody.text ?? firstBody.文本) + (toolJson(second).text ?? toolJson(second).文本) + (toolJson(third).text ?? toolJson(third).文本), expected);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("book image resolution uses each occurrence's spine before top-level fallback", async () => {
  assert.equal(typeof book?.readBookDocumentCanonical, "function");
  assert.equal(typeof book?.resolveBookWindowImages, "function", "resolveBookWindowImages must exist");
  if (!book?.readBookDocumentCanonical || !book?.resolveBookWindowImages) return;
  const app = createFixtureApp();
  try {
    registerEpub(app, "segment-images-book", [
      { id: "one/chapter.xhtml", label: "One", body: `<p id="chapter"><img src="images/shared.png" alt="One"/></p>` },
      { id: "two/chapter.xhtml", label: "Two", body: `<p id="chapter"><img src="images/shared.png" alt="Two"/></p>` },
    ]);
    const root = path.join(app.appDir, "books", "segment-images-book");
    const one = path.join(root, "mdbook", "book", "src", "one", "images", "shared.png");
    const two = path.join(root, "mdbook", "book", "src", "two", "images", "shared.png");
    app.writeBookFile("segment-images-book", "mdbook/book/src/one/images/shared.png", Buffer.from([1]));
    app.writeBookFile("segment-images-book", "mdbook/book/src/two/images/shared.png", Buffer.from([2]));
    app.writeBookFile("segment-images-book", "images/shared.png", Buffer.from([99]));
    const full = await book.readBookDocumentCanonical(root);
    const resolved = await book.resolveBookWindowImages(root, full.text, { ...full, windowStart: 0 });
    const slash = (value) => value.replace(/\\/g, "/");
    assert.equal(resolved.text, `![One](${slash(one)})\n\n![Two](${slash(two)})`);
    assert.ok(fs.existsSync(one) && fs.existsSync(two));
    assert.ok(!resolved.text.includes(slash(path.join(root, "images", "shared.png"))));
  } finally {
    app.cleanup();
  }
});

test("read_document materializes only missing images in the returned book window", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    registerEpub(app, "book-window", [{
      id: "text/chapter.xhtml",
      label: "Chapter One",
      body: `<h1 id="chapter">Chapter One</h1><p>Intro</p><p><img src="../images/in-window.png" alt="Window"/></p><p>${"A".repeat(700)}</p><p><img src="../images/outside.png" alt="Outside"/></p><p>${"B".repeat(700)}</p>`,
      entries: {
        "OEBPS/images/in-window.png": png,
        "OEBPS/images/outside.png": Buffer.from([9, 9, 9]),
      },
    }]);
    app.close();
    await client.initialize();
    const response = await client.callTool("read_document", { doc: "book:book-window", heading: "Chapter One", after: 500 });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    const text = body.text ?? body.文本;
    assert.equal(body.next_offset, 500);
    const imagePath = /!\[Window\]\(([^)]+)\)/.exec(text)?.[1] ?? "";
    assert.ok(imagePath.includes("/image-cache/epub/book-window/"), text.slice(0, 400));
    assert.ok(fs.readFileSync(imagePath).equals(png));
    assert.ok(!text.includes("Outside"));
    const cacheDir = path.join(app.appDir, "image-cache", "epub", "book-window");
    assert.equal(fs.readdirSync(cacheDir).length, 1);
    assert.equal(body.图片缓存?.目录?.replace(/\\/g, "/"), cacheDir.replace(/\\/g, "/"));
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("legacy read_book keeps raw Markdown offsets and output shape", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath, { SAGEREAD_MCP_LEGACY_TOOLS: "1" });
  try {
    app.addBook({ id: "legacy-book", format: "EPUB" });
    app.writeBookFile("legacy-book", "mdbook/book/src/EPUB/nav.md", "[Raw](Text/raw.md)");
    app.writeBookFile("legacy-book", "mdbook/book/src/EPUB/Text/raw.md", "ABCDEF");
    app.close();
    await client.initialize();
    const response = await client.callTool("read_book", { book: "legacy-book", file: "raw.md", offset: 2, limit: 2 });
    assert.equal(response.isError, false, response.text);
    assert.ok(response.text.includes("本章共 6 字符"));
    assert.ok(response.text.includes("CD"));
    assert.ok(!response.text.includes("next_offset"));
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("get_document_info exposes EPUB nav labels and spine anchors without mdbook", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    registerEpub(app, "toc-book", [
      { id: "one.xhtml", label: "One", body: `<p id="chapter">Alpha</p>` },
      { id: "two.xhtml", label: "Two", body: `<p id="chapter">Beta</p>` },
    ]);
    app.close();
    await client.initialize();
    const response = await client.callTool("get_document_info", { doc: "book:toc-book" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.equal(body.目录条数, 2);
    assert.deepEqual(
      body.目录.map((entry) => ({ heading: entry.heading, spine: entry.spine })),
      [
        { heading: "One", spine: 0 },
        { heading: "Two", spine: 1 },
      ],
    );
  } finally {
    await client.close();
    app.cleanup();
  }
});

const FULL_FRONTMATTER = `---\ntitle: Frontmatter title\nauthor:\n  - Suchona Akter\n  - name: Mohammad R. Momeni\ndate: "2010"\nabstract: A complete frontmatter abstract with enough detail to verify that the full value is preserved rather than truncated during metadata loading.\nkeywords: alpha, beta\nvolume: "8"\nissue: "2"\npage: 10-20\ndoi: 10.1000/frontmatter\ncontainer-title: Journal of Frontmatter\nlang: en\n---\n# Abstract\nBody`;

function registerPaper(app, id, markdown = FULL_FRONTMATTER, metadata) {
  app.addBook({ id, title: `Database ${id}` });
  app.writeBookFile(id, "paper.md", markdown);
  if (metadata !== undefined) {
    app.writeBookFile(id, "metadata.json", typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  }
}

test("paper metadata loads complete JSON fields and mixed author shapes", () => {
  assert.equal(typeof paper?.readPaperDocMetadata, "function", "readPaperDocMetadata must exist");
  if (!paper?.readPaperDocMetadata) return;
  const app = createFixtureApp();
  try {
    const authors = ["Alice String", "Bob Object", ...Array.from({ length: 14 }, (_, index) => `Author ${index + 3}`)];
    registerPaper(app, "standard-paper", FULL_FRONTMATTER, {
      title: "Standard paper",
      author: ["Alice String", { name: "Bob Object", affiliation: "Lab" }, ...authors.slice(2)],
      date: "2024-05",
      abstract: "A complete abstract.",
      keywords: ["alpha", "beta"],
      volume: "12",
      issue: "3",
      page: "101–119",
      doi: "10.1000/test",
      "container-title": "Journal of Tests",
      lang: "en",
      title_zh: "中文标题",
      abstract_zh: "中文摘要",
    });
    const metadata = paper.readPaperDocMetadata(path.join(app.appDir, "books", "standard-paper"));
    assert.deepEqual(metadata.authors, authors);
    assert.equal(metadata.date, "2024-05");
    assert.equal(metadata.published, "2024-05");
    assert.equal(metadata.abstract, "A complete abstract.");
    assert.deepEqual(metadata.keywords, ["alpha", "beta"]);
    assert.equal(metadata.volume, "12");
    assert.equal(metadata.issue, "3");
    assert.equal(metadata.page, "101–119");
    assert.equal(metadata.venue, "Journal of Tests");
    assert.equal(metadata.doi, "10.1000/test");
    assert.equal(metadata.language, "en");
    assert.equal(metadata.title_zh, "中文标题");
    assert.equal(metadata.abstract_zh, "中文摘要");
    assert.equal(metadata.partial, false);
    assert.deepEqual(metadata.errors, []);
  } finally {
    app.cleanup();
  }
});

test("paper metadata falls back per field while preserving JSON priority", () => {
  assert.equal(typeof paper?.readPaperDocMetadata, "function");
  if (!paper?.readPaperDocMetadata) return;
  const app = createFixtureApp();
  try {
    registerPaper(app, "frontmatter-paper");
    const fallback = paper.readPaperDocMetadata(path.join(app.appDir, "books", "frontmatter-paper"));
    assert.equal(fallback.title, "Frontmatter title");
    assert.deepEqual(fallback.authors, ["Suchona Akter", "Mohammad R. Momeni"]);
    assert.equal(fallback.date, "2010");
    assert.ok(fallback.abstract.length > 100);
    assert.deepEqual(fallback.keywords, ["alpha", "beta"]);
    assert.equal(fallback.volume, "8");
    assert.equal(fallback.partial, false);
    assert.deepEqual(fallback.errors, []);

    registerPaper(app, "partial-paper", FULL_FRONTMATTER, {
      title: "JSON title wins",
      author: [{ name: "JSON Author" }],
    });
    const partial = paper.readPaperDocMetadata(path.join(app.appDir, "books", "partial-paper"));
    assert.equal(partial.title, "JSON title wins");
    assert.deepEqual(partial.authors, ["JSON Author"]);
    assert.equal(partial.date, "2010");
    assert.ok(partial.abstract.length > 100);
    assert.equal(partial.venue, "Journal of Frontmatter");
  } finally {
    app.cleanup();
  }
});

test("damaged paper metadata produces partial diagnostics without hiding frontmatter", () => {
  assert.equal(typeof paper?.readPaperDocMetadata, "function");
  if (!paper?.readPaperDocMetadata) return;
  const app = createFixtureApp();
  try {
    registerPaper(app, "damaged-paper", FULL_FRONTMATTER, "{not-json");
    const damaged = paper.readPaperDocMetadata(path.join(app.appDir, "books", "damaged-paper"));
    assert.equal(damaged.title, "Frontmatter title");
    assert.deepEqual(damaged.authors, ["Suchona Akter", "Mohammad R. Momeni"]);
    assert.equal(damaged.partial, true);
    assert.ok(damaged.errors.some((message) => message.includes("metadata.json")), damaged.errors);
  } finally {
    app.cleanup();
  }
});

test("get_document_info returns standard paper metadata and compatibility aliases", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    registerPaper(app, "info-paper", FULL_FRONTMATTER, {
      title: "JSON paper title",
      author: ["Alice String", { name: "Bob Object" }],
      date: "2024-05",
      abstract: "A complete abstract.",
      keywords: ["alpha", "beta"],
      volume: "12",
      issue: "3",
      page: "101–119",
      doi: "10.1000/test",
      "container-title": "Journal of Tests",
      lang: "en",
      title_zh: "中文标题",
      abstract_zh: "中文摘要",
    });
    app.close();
    await client.initialize();
    const response = await client.callTool("get_document_info", { doc: "paper:info-paper" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.equal(body.标题, "JSON paper title");
    assert.equal(body.作者, "Alice String, Bob Object");
    assert.equal(body.中文标题, "中文标题");
    assert.equal(body.中文摘要, "中文摘要");
    assert.deepEqual(body.metadata?.authors, ["Alice String", "Bob Object"]);
    assert.equal(body.metadata?.date, "2024-05");
    assert.equal(body.metadata?.published, "2024-05");
    assert.equal(body.metadata?.abstract, "A complete abstract.");
    assert.deepEqual(body.metadata?.keywords, ["alpha", "beta"]);
    assert.equal(body.metadata?.volume, "12");
    assert.equal(body.metadata?.issue, "3");
    assert.equal(body.metadata?.page, "101–119");
    assert.equal(body.metadata?.language, "en");
    assert.equal(body.metadata?.venue, "Journal of Tests");
    assert.equal(body.partial, false);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("mdbook nav cannot escape the book directory", async () => {
  const app = createFixtureApp();
  try {
    app.addBook({ id: "traversal-book", format: "EPUB" });
    const sentinel = path.join(app.appDir, "outside-secret.md");
    fs.writeFileSync(sentinel, "SENTINEL");
    app.writeBookFile("traversal-book", "mdbook/book/src/EPUB/nav.md", `[Escape](${sentinel.replace(/\\/g, "/")})`);
    app.writeBookFile("traversal-book", "mdbook/book/src/EPUB/Text/ok.md", "ok");
    await assert.rejects(
      book.readBookDocumentCanonical(path.join(app.appDir, "books", "traversal-book")),
      /越出|outside|目录/,
    );
  } finally {
    app.cleanup();
  }
});

test("full-book canonical enforces an aggregate character bound", async () => {
  const app = createFixtureApp();
  try {
    registerEpub(app, "aggregate-book", [
      { id: "one.xhtml", label: "One", body: `<p id="chapter">${"A".repeat(80)}</p>` },
      { id: "two.xhtml", label: "Two", body: `<p id="chapter">${"B".repeat(80)}</p>` },
    ]);
    await assert.rejects(
      book.readBookDocumentCanonical(path.join(app.appDir, "books", "aggregate-book"), { maxTotalChars: 100 }),
      /上限|bound|100/,
    );
  } finally {
    app.cleanup();
  }
});

test("null and wrong-type JSON fields fall back to frontmatter with diagnostics", () => {
  const app = createFixtureApp();
  try {
    registerPaper(app, "invalid-fields", FULL_FRONTMATTER, {
      title: null,
      author: { wrong: "shape" },
      date: 2024,
      keywords: null,
    });
    const metadata = paper.readPaperDocMetadata(path.join(app.appDir, "books", "invalid-fields"));
    assert.equal(metadata.title, "Frontmatter title");
    assert.deepEqual(metadata.authors, ["Suchona Akter", "Mohammad R. Momeni"]);
    assert.equal(metadata.date, "2024");
    assert.deepEqual(metadata.keywords, ["alpha", "beta"]);
    assert.equal(metadata.partial, true);
    assert.ok(metadata.errors.some((message) => message.includes("title")));
    assert.ok(metadata.errors.some((message) => message.includes("author")));
  } finally {
    app.cleanup();
  }
});

test("References heading is not counted as an entry and ref_index starts at one", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    registerPaper(app, "cited-paper", `---\ntitle: Cited paper\ndoi: 10.1000/cited\n---\n# Body\nText`);
    registerPaper(app, "citing-paper", `---\ntitle: Citing paper\n---\n# Body\nText\n# References\n[1] Cited paper. https://doi.org/10.1000/cited`);
    app.close();
    await client.initialize();
    const info = await client.callTool("get_document_info", { doc: "paper:citing-paper" });
    assert.equal(info.isError, false, info.text);
    assert.equal(toolJson(info).参考文献数, 1);
    const graph = await client.callTool("get_citation_graph", { doc: "paper:citing-paper" });
    assert.equal(graph.isError, false, graph.text);
    assert.equal(toolJson(graph).引用了库内[0].ref_index, 1);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("book image resolution accepts legitimate directories beginning with two dots", async () => {
  assert.equal(typeof book?.readBookDocumentCanonical, "function");
  assert.equal(typeof book?.resolveBookWindowImages, "function");
  if (!book?.readBookDocumentCanonical || !book?.resolveBookWindowImages) return;
  const app = createFixtureApp();
  try {
    app.addBook({ id: "dot-directory-book", format: "EPUB" });
    app.writeBookFile("dot-directory-book", "..foo/image.png", Buffer.from([1]));
    const root = path.join(app.appDir, "books", "dot-directory-book");
    const text = "![Dot](..foo/image.png)";
    const source = { text, totalChars: text.length, bookDir: root, segments: [], source: "mdbook", windowStart: 0 };
    const resolved = await book.resolveBookWindowImages(root, text, source);
    assert.ok(resolved.text.includes(slash(path.join(root, "..foo", "image.png"))), resolved.text);
  } finally {
    app.cleanup();
  }
});

test("legacy get_chunk_context accepts book_id as a backwards-compatible alias", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath, { SAGEREAD_MCP_LEGACY_TOOLS: "1" });
  let vectors;
  try {
    app.addBook({ id: "legacy-alias-book", format: "EPUB" });
    vectors = createVectorDb(path.join(app.appDir, "books", "legacy-alias-book", "vectors.sqlite"));
    addVectorChunk(vectors, {
      book_title: "legacy-alias-book",
      md_file_path: "part.md",
      chunk_order_in_file: 7,
      total_chunks_in_file: 8,
      chunk_text: "legacy alias context",
    });
    vectors.close();
    app.close();
    await client.initialize();
    const response = await client.callTool("get_chunk_context", { book_id: "legacy-alias-book", chunk_order: 7, radius: 0 });
    assert.equal(response.isError, false, response.text);
    assert.ok(response.text.includes("legacy alias context"), response.text);
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    app.cleanup();
  }
});
