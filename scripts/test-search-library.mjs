import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  addVectorChunk,
  createFixtureApp,
  createVectorDb,
  McpClient,
  startEmbedChannel,
  toolJson,
  writeEpubFixture,
} from "./test-helpers.mjs";

const semantic = await import("../dist/semantic-search.js");

function registerPaper(app, id, body) {
  app.addBook({ id, title: id, format: "MARKDOWN", author: "Paper Author" });
  app.writeBookFile(id, "paper.md", `---\ntitle: ${id}\n---\n${body}`);
}

test("indexed paper hit replays to the true canonical match and duplicates degrade to section", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    const unique = "Unique cationic potential appears here";
    registerPaper(app, "paper-hit", `# Methods\nBefore ${unique} after\n# Other\nTail`);
    registerPaper(app, "paper-duplicate", "# One\nsame\n# Two\nsame");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "paper-hit", book_title: "paper-hit", chunk_text: unique, vector: [1, 0] });
    addVectorChunk(vectors, { id: 2, paper_id: "paper-duplicate", book_title: "paper-duplicate", chunk_text: "same", vector: [1, 0] });
    vectors.close();
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "unique", doc: "paper:paper-hit", top_k: 1 }, 30000);
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    const hit = body.结果[0];
    assert.equal(hit.doc, "paper:paper-hit");
    assert.equal(hit.source, "hybrid");
    assert.equal(hit.index.status, "indexed");
    assert.equal(hit.anchor_precision, "exact");
    assert.equal(typeof hit.read.offset, "number");
    assert.equal(hit.snippet ?? hit.片段, unique);
    const expanded = await client.callTool("read_document", { ...hit.read, before: 10, after: 200 });
    assert.equal(expanded.isError, false, expanded.text);
    assert.ok((toolJson(expanded).text ?? toolJson(expanded).文本).includes(unique));

    const duplicate = await client.callTool("search_library", { query: "same", doc: "paper:paper-duplicate", top_k: 1 }, 30000);
    assert.equal(duplicate.isError, false, duplicate.text);
    const duplicateHit = toolJson(duplicate).结果[0];
    assert.equal(duplicateHit.anchor_precision, "section");
    assert.equal(duplicateHit.read.offset, undefined);
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("indexed book hit replays through heading/spine canonical anchors", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    const unique = "unique book keyword";
    writeEpubFixture(app, "book-hit", [{
      id: "chapter.xhtml",
      label: "Chapter One",
      body: `<h1 id="chapter">Chapter One</h1><p>Before ${unique} after</p>`,
    }]);
    vectors = createVectorDb(path.join(app.appDir, "books", "book-hit", "vectors.sqlite"));
    addVectorChunk(vectors, {
      id: 1,
      book_title: "book-hit",
      md_file_path: "chapter.xhtml",
      related_chapter_titles: "Chapter One",
      chunk_text: unique,
      vector: [1, 0],
    });
    vectors.close();
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "book", doc: "book:book-hit", top_k: 1 }, 30000);
    assert.equal(response.isError, false, response.text);
    const hit = toolJson(response).结果[0];
    assert.equal(hit.doc, "book:book-hit");
    assert.equal(hit.anchor_precision, "exact");
    assert.equal(hit.read.heading, "Chapter One");
    assert.equal(hit.read.spine, 0);
    assert.equal(typeof hit.read.offset, "number");
    const expanded = await client.callTool("read_document", { ...hit.read, before: 10, after: 200 });
    assert.equal(expanded.isError, false, expanded.text);
    assert.ok((toolJson(expanded).text ?? toolJson(expanded).文本).includes(unique));
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("searchIndexed exposes neutral indexed chunks while legacy semanticSearch keeps its shape", async () => {
  assert.equal(typeof semantic.searchIndexed, "function", "searchIndexed must exist");
  if (typeof semantic.searchIndexed !== "function") return;
  const app = createFixtureApp();
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "neutral-paper", "# One\nNeutral chunk");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "neutral-paper", chunk_text: "Neutral chunk", vector: [1, 0] });
    vectors.close();
    const indexed = await semantic.searchIndexed(app.appDir, {
      query: "neutral",
      scope: "papers",
      paperId: "neutral-paper",
      topK: 8,
    });
    assert.equal(indexed.chunks.length, 1);
    assert.equal(indexed.chunks[0].row.chunk_text, "Neutral chunk");
    const legacy = await semantic.semanticSearch(app.appDir, {
      query: "neutral",
      scope: "papers",
      paperId: "neutral-paper",
      topK: 8,
    });
    assert.equal(legacy.结果[0].内容, "Neutral chunk");
    assert.equal(legacy.结果[0].read, undefined);
    assert.equal(legacy.结果[0].source, undefined);
  } finally {
    if (vectors?.open) vectors.close();
    await channel.close();
    app.cleanup();
  }
});

test("unindexed paper searches keyword/title without any vector channel and expands the hit", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    registerPaper(app, "paper-fallback", "# Methods\nA fallback keyword appears in canonical text.\n# References\nOther");
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "fallback keyword", doc: "paper:paper-fallback" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    const hit = body.结果[0];
    assert.ok(hit, "expected a keyword hit");
    assert.equal(hit.source, "keyword");
    assert.equal(hit.index.status, "not_indexed");
    assert.equal(hit.anchor_precision, "exact");
    assert.equal(typeof hit.read.offset, "number");
    assert.equal(body.partial, true);
    assert.ok(body.errors.length > 0 || body.警告.length > 0);
    const expanded = await client.callTool("read_document", { ...hit.read, before: 10, after: 200 });
    assert.ok((toolJson(expanded).text ?? toolJson(expanded).文本).includes("fallback keyword"));

    const title = await client.callTool("search_library", { query: "paper-fallback", doc: "paper:paper-fallback" });
    assert.equal(title.isError, false, title.text);
    assert.equal(toolJson(title).结果[0].source, "title");
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("unindexed book and all-scope fallback return replayable canonical hits", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    writeEpubFixture(app, "book-fallback", [{
      id: "chapter.xhtml",
      label: "Fallback Chapter",
      body: `<h1 id="chapter">Fallback Chapter</h1><p>A shared needle and fallback book keyword.</p>`,
    }]);
    registerPaper(app, "all-paper", "# One\nA shared needle in a paper.");
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "fallback keyword", doc: "book:book-fallback" });
    assert.equal(response.isError, false, response.text);
    const hit = toolJson(response).结果[0];
    assert.ok(hit, "expected a keyword hit");
    assert.equal(hit.source, "keyword");
    assert.equal(hit.index.status, "not_indexed");
    assert.equal(hit.anchor_precision, "exact");
    assert.equal(hit.read.spine, 0);
    const expanded = await client.callTool("read_document", { ...hit.read, before: 10, after: 200 });
    assert.ok((toolJson(expanded).text ?? toolJson(expanded).文本).includes("fallback book keyword"));

    const all = await client.callTool("search_library", { query: "shared needle", scope: "all", top_k: 10 });
    assert.equal(all.isError, false, all.text);
    const hits = toolJson(all).结果;
    assert.ok(hits.some((item) => item.doc === "book:book-fallback"));
    assert.ok(hits.some((item) => item.doc === "paper:all-paper"));
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("library fallback paginates bounded scans until every paper is covered", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    for (let index = 0; index < 9; index += 1) {
      registerPaper(app, `paper-${index}`, `# Section\nneedle in document ${index}`);
    }
    app.close();
    await client.initialize();
    const first = await client.callTool("search_library", { query: "needle", scope: "papers", top_k: 8 });
    assert.equal(first.isError, false, first.text);
    const firstBody = toolJson(first);
    assert.equal(firstBody.结果.length, 8);
    assert.equal(firstBody.partial, true);
    assert.equal(firstBody.truncated, true);
    assert.equal(typeof firstBody.next_cursor, "string");
    const second = await client.callTool("search_library", {
      query: "needle",
      scope: "papers",
      top_k: 8,
      cursor: firstBody.next_cursor,
    });
    assert.equal(second.isError, false, second.text);
    const secondBody = toolJson(second);
    assert.equal(secondBody.结果.length, 1);
    assert.equal(secondBody.partial, true);
    assert.equal(secondBody.truncated, true);
    assert.equal(secondBody.next_cursor ?? null, null);
    const keys = [...firstBody.结果, ...secondBody.结果].map((hit) => `${hit.doc}|${hit.read.offset}`);
    assert.equal(new Set(keys).size, 9);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("fallback keeps title hits while extraction errors are disclosed as partial", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    app.addBook({ id: "broken-title", title: "broken-title", format: "MARKDOWN" });
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "broken-title", doc: "paper:broken-title" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.ok(body.结果[0], "expected the title hit to survive extraction failure");
    assert.equal(body.结果[0].source, "title");
    assert.equal(body.partial, true);
    assert.ok(body.errors.length > 0);
    assert.ok(body.fallback.paper.errors > 0);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("search_library defaults to six results and exposes effective search config", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    for (let index = 0; index < 7; index += 1) registerPaper(app, `default-${index}`, "# One\nneedle");
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "needle", scope: "papers" });
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.equal(body.结果.length, 6);
    assert.deepEqual(body.search_config, { top_k: 6, vector_weight: 0.7, bm25_weight: 0.3, include_references: false });
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("vector and BM25 weights change indexed paper ranking", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "weighted-paper", "# One\nAlpha unrelated\nzebra zebra");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "weighted-paper", chunk_text: "Alpha unrelated", vector: [1, 0] });
    addVectorChunk(vectors, { id: 2, paper_id: "weighted-paper", chunk_text: "zebra zebra", vector: [0, 1] });
    vectors.close();
    app.close();
    await client.initialize();
    const vectorFirst = await client.callTool("search_library", {
      query: "zebra",
      doc: "paper:weighted-paper",
      top_k: 1,
      vector_weight: 1,
      bm25_weight: 0,
    }, 30000);
    assert.equal(vectorFirst.isError, false, vectorFirst.text);
    assert.equal(toolJson(vectorFirst).结果[0].片段, "Alpha unrelated");
    const bm25First = await client.callTool("search_library", {
      query: "zebra",
      doc: "paper:weighted-paper",
      top_k: 1,
      vector_weight: 0,
      bm25_weight: 1,
    }, 30000);
    assert.equal(bm25First.isError, false, bm25First.text);
    assert.equal(toolJson(bm25First).结果[0].片段, "zebra zebra");
    assert.equal(toolJson(bm25First).结果[0].source, "bm25");
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("weights also change ranking across separate book vector databases", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let firstVectors;
  let secondVectors;
  try {
    writeEpubFixture(app, "vector-book", [{ id: "one.xhtml", label: "One", body: `<p id="chapter">Alpha unrelated</p>` }]);
    writeEpubFixture(app, "keyword-book", [{ id: "one.xhtml", label: "One", body: `<p id="chapter">zebra zebra</p>` }]);
    firstVectors = createVectorDb(path.join(app.appDir, "books", "vector-book", "vectors.sqlite"));
    addVectorChunk(firstVectors, { id: 1, book_title: "vector-book", related_chapter_titles: "One", chunk_text: "Alpha unrelated", vector: [1, 0] });
    secondVectors = createVectorDb(path.join(app.appDir, "books", "keyword-book", "vectors.sqlite"));
    addVectorChunk(secondVectors, { id: 1, book_title: "keyword-book", related_chapter_titles: "One", chunk_text: "zebra zebra", vector: [0, 1] });
    firstVectors.close();
    secondVectors.close();
    app.close();
    await client.initialize();
    const vectorFirst = await client.callTool("search_library", {
      query: "zebra",
      scope: "books",
      top_k: 1,
      vector_weight: 1,
      bm25_weight: 0,
    }, 30000);
    assert.equal(toolJson(vectorFirst).结果[0].doc, "book:vector-book");
    const bm25First = await client.callTool("search_library", {
      query: "zebra",
      scope: "books",
      top_k: 1,
      vector_weight: 0,
      bm25_weight: 1,
    }, 30000);
    assert.equal(bm25First.isError, false, bm25First.text);
    assert.equal(toolJson(bm25First).结果[0].doc, "book:keyword-book");
  } finally {
    if (firstVectors?.open) firstVectors.close();
    if (secondVectors?.open) secondVectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("include_references changes actual indexed and fallback results", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "references-paper", "# Body\ncitation body\n# References\ncitation reference");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "references-paper", chunk_text: "citation body", is_references: false, vector: [1, 0] });
    addVectorChunk(vectors, { id: 2, paper_id: "references-paper", chunk_text: "citation reference", is_references: true, vector: [0.9, 0.1] });
    vectors.close();
    app.close();
    await client.initialize();
    const excluded = await client.callTool("search_library", { query: "citation", doc: "paper:references-paper", top_k: 10 }, 30000);
    assert.equal(excluded.isError, false, excluded.text);
    assert.deepEqual(toolJson(excluded).结果.map((hit) => hit.片段), ["citation body"]);
    const included = await client.callTool("search_library", {
      query: "citation",
      doc: "paper:references-paper",
      top_k: 10,
      include_references: true,
    }, 30000);
    assert.equal(included.isError, false, included.text);
    assert.deepEqual(new Set(toolJson(included).结果.map((hit) => hit.片段)), new Set(["citation body", "citation reference"]));
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("legacy vector schema without is_references gets an explicit fallback warning", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "old-schema", "# Body\nlegacy citation");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"), { referencesColumn: false });
    addVectorChunk(vectors, { id: 1, paper_id: "old-schema", chunk_text: "legacy citation", vector: [1, 0] });
    vectors.close();
    app.close();
    await client.initialize();
    const response = await client.callTool("search_library", { query: "legacy", doc: "paper:old-schema" }, 30000);
    assert.equal(response.isError, false, response.text);
    const body = toolJson(response);
    assert.ok(body.结果.length > 0);
    assert.ok(body.errors.some((message) => message.includes("is_references")), body.errors);
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("direct searchLibrary clamps topK above thirty", async () => {
  const { searchLibrary } = await import("../dist/search-library.js");
  const app = createFixtureApp();
  try {
    for (let index = 0; index < 31; index += 1) registerPaper(app, `needle-${index}`, "# One\nbody");
    const documents = app.db.prepare("SELECT id, title, author, format FROM books WHERE trashed_at IS NULL ORDER BY id").all();
    const result = await searchLibrary(app.appDir, {
      query: "needle",
      scope: "papers",
      documents,
      topK: 99,
      includeReferences: false,
    });
    assert.equal(result.results.length, 30);
    assert.ok(result.search_config, "searchLibrary must return its effective search_config");
    assert.equal(result.search_config.top_k, 30);
    const zeroWeights = await searchLibrary(app.appDir, {
      query: "needle",
      scope: "papers",
      documents,
      topK: 1,
      vectorWeight: 0,
      bm25Weight: 0,
      includeReferences: false,
    });
    assert.equal(zeroWeights.search_config.vector_weight, 0.7);
    assert.equal(zeroWeights.search_config.bm25_weight, 0.3);
  } finally {
    app.cleanup();
  }
});

async function searchPage(client, args) {
  const response = await client.callTool("search_library", args, 30000);
  assert.equal(response.isError, false, response.text);
  return toolJson(response);
}

test("ordinary merge emits dropped fallback hits on a later page without replaying indexed hits", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "p-indexed", "# One\nneedle indexed");
    registerPaper(app, "p-fallback", "# One\nneedle fallback");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "p-indexed", chunk_text: "needle indexed", vector: [1, 0] });
    vectors.close();
    app.close();
    await client.initialize();
    const first = await searchPage(client, { query: "needle", scope: "papers", top_k: 1 });
    assert.equal(first.结果[0].doc, "paper:p-indexed");
    assert.equal(typeof first.next_cursor, "string");
    const second = await searchPage(client, { query: "needle", scope: "papers", top_k: 1, cursor: first.next_cursor });
    assert.equal(second.结果[0].doc, "paper:p-fallback");
    assert.equal(second.next_cursor ?? null, null);
    assert.deepEqual(
      [...first.结果, ...second.结果].map((hit) => hit.doc),
      ["paper:p-indexed", "paper:p-fallback"],
    );
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("merge deduplicates the same paper canonical offset even when snippets differ", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "dedup-paper", "# One\nbefore needle after");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "dedup-paper", chunk_text: "needle", vector: [1, 0] });
    vectors.close();
    app.close();
    await client.initialize();
    const body = await searchPage(client, { query: "needle", doc: "paper:dedup-paper", top_k: 10 });
    assert.equal(body.结果.length, 1, JSON.stringify(body.结果.map((hit) => ({ read: hit.read, snippet: hit.片段 }))));
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("book cursor keys keep same-offset hits from different sections", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    writeEpubFixture(app, "section-keys", [
      { id: "one.xhtml", label: "One", body: `<p id="chapter">needle one</p>` },
      { id: "two.xhtml", label: "Two", body: `<p id="chapter">needle two</p>` },
    ]);
    app.close();
    await client.initialize();
    const body = await searchPage(client, { query: "needle", doc: "book:section-keys", top_k: 10 });
    assert.equal(body.结果.length, 2);
    assert.deepEqual(
      new Set(body.结果.map((hit) => `${hit.read.spine}|${hit.read.offset}`)),
      new Set(["0|0", "1|0"]),
    );
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("cross-library RRF eventually emits hits dropped from both channels", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let paperVectors;
  try {
    registerPaper(app, "p-indexed", "# One\nneedle paper indexed");
    registerPaper(app, "p-fallback", "# One\nneedle paper fallback");
    writeEpubFixture(app, "b-fallback", [{ id: "one.xhtml", label: "One", body: `<p id="chapter">needle book fallback</p>` }]);
    paperVectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(paperVectors, { id: 1, paper_id: "p-indexed", chunk_text: "needle paper indexed", vector: [1, 0] });
    paperVectors.close();
    app.close();
    await client.initialize();
    const first = await searchPage(client, { query: "needle", scope: "all", top_k: 1 });
    assert.equal(first.结果[0].doc, "paper:p-indexed");
    const firstChannels = JSON.parse(first.next_cursor);
    assert.equal(typeof firstChannels.paper, "string");
    assert.equal(typeof firstChannels.book, "string");
    const second = await searchPage(client, { query: "needle", scope: "all", top_k: 1, cursor: first.next_cursor });
    assert.equal(second.结果[0].doc, "paper:p-fallback");
    const secondChannels = JSON.parse(second.next_cursor);
    assert.equal(secondChannels.paper ?? null, null);
    assert.equal(typeof secondChannels.book, "string");
    const third = await searchPage(client, { query: "needle", scope: "all", top_k: 1, cursor: second.next_cursor });
    assert.equal(third.结果[0].doc, "book:b-fallback");
    assert.equal(third.next_cursor ?? null, null);
    assert.deepEqual(
      new Set([...first.结果, ...second.结果, ...third.结果].map((hit) => hit.doc)),
      new Set(["paper:p-indexed", "paper:p-fallback", "book:b-fallback"]),
    );
  } finally {
    if (paperVectors?.open) paperVectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("cursors reject doc mode and query/scope/collection mismatches", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    registerPaper(app, "cursor-0", "# One\nneedle zero");
    registerPaper(app, "cursor-1", "# One\nneedle one");
    app.db.prepare("INSERT INTO folders (id, name) VALUES (?, ?), (?, ?)").run("f1", "one", "f2", "two");
    app.db.prepare("INSERT INTO paper_folders (paper_id, folder_id) VALUES (?, ?), (?, ?)").run("cursor-0", "f1", "cursor-1", "f1");
    app.db.prepare("INSERT INTO paper_folders (paper_id, folder_id) VALUES (?, ?)").run("cursor-0", "f2");
    app.close();
    await client.initialize();
    const first = await searchPage(client, { query: "needle", scope: "papers", collection: "one", top_k: 1 });
    assert.equal(typeof first.next_cursor, "string");
    for (const args of [
      { query: "needle", doc: "paper:cursor-0", cursor: first.next_cursor },
      { query: "different", scope: "papers", collection: "one", top_k: 1, cursor: first.next_cursor },
      { query: "needle", scope: "all", collection: "one", top_k: 1, cursor: first.next_cursor },
      { query: "needle", scope: "papers", collection: "two", top_k: 1, cursor: first.next_cursor },
    ]) {
      const response = await client.callTool("search_library", args);
      assert.equal(response.isError, true, JSON.stringify(args));
    }
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("multi-section book scans drain through bounded cursors without duplicates", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    writeEpubFixture(app, "long-book", Array.from({ length: 30 }, (_, index) => ({
      id: `chapter-${index}.xhtml`,
      label: `Chapter ${index}`,
      body: `<p id="chapter">needle section ${index}</p>`,
    })));
    app.close();
    await client.initialize();
    const hits = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const body = await searchPage(client, { query: "needle", scope: "books", top_k: 2, ...(cursor ? { cursor } : {}) });
      hits.push(...body.结果);
      if (body.next_cursor == null) {
        cursor = null;
        break;
      }
      cursor = body.next_cursor;
      assert.ok(cursor.length <= 65536, `cursor grew beyond 64 KiB on page ${page}`);
    }
    assert.equal(hits.length, 30, JSON.stringify(hits.map((hit) => hit.read)));
    assert.equal(new Set(hits.map((hit) => `${hit.doc}|${hit.read.spine}|${hit.read.offset}`)).size, 30);
    assert.equal(cursor, null);
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("cursor encoding rejects oversized state instead of growing without bound", async () => {
  const { encodeFallbackCursor } = await import("../dist/search-fallback.js");
  const state = {
    v: 1,
    kind: "paper",
    query: "needle",
    scope: "papers",
    collection: null,
    includeReferences: false,
    offset: 0,
    seen: Array.from({ length: 10000 }, (_, index) => `paper:${index}|${index}`),
    partial: true,
    truncated: true,
  };
  assert.throws(() => encodeFallbackCursor(state), /上限|大小|65536|cursor/i);
});

test("indexed book hits preserve nav fragments and recover from stale chapter metadata", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    writeEpubFixture(app, "fragment-book", [{
      id: "chapter.xhtml",
      label: "Chapter",
      nav: [
        { href: "chapter.xhtml#chapter", label: "Chapter" },
        { href: "chapter.xhtml#later", label: "References" },
      ],
      body: `<h1 id="chapter">Chapter</h1><p>first body</p><h2 id="later">References</h2><p>needle later</p>`,
    }]);
    vectors = createVectorDb(path.join(app.appDir, "books", "fragment-book", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, book_title: "fragment-book", related_chapter_titles: "References", md_file_path: "chapter.xhtml", chunk_text: "needle later", vector: [1, 0] });
    addVectorChunk(vectors, { id: 2, book_title: "fragment-book", related_chapter_titles: "Stale", md_file_path: "chapter.xhtml", chunk_text: "first body", vector: [0.9, 0.1] });
    vectors.close();
    app.close();
    await client.initialize();
    const info = await client.callTool("get_document_info", { doc: "book:fragment-book" });
    const toc = toolJson(info).目录;
    assert.ok(toc.some((entry) => entry.heading === "References" && entry.fragment === "later"), JSON.stringify(toc));
    const fragment = await searchPage(client, { query: "needle", doc: "book:fragment-book" });
    const fragmentHit = fragment.结果.find((hit) => hit.chunk_id === 1);
    assert.equal(fragmentHit.read.fragment, "later");
    const fragmentRead = await client.callTool("read_document", { ...fragmentHit.read, after: 200 });
    assert.ok((toolJson(fragmentRead).text ?? toolJson(fragmentRead).文本).includes("needle later"));

    const stale = await searchPage(client, { query: "first", doc: "book:fragment-book" });
    const staleHit = stale.结果.find((hit) => hit.chunk_id === 2);
    assert.equal(staleHit.read.heading, "Chapter");
    assert.notEqual(staleHit.read.heading, "Stale");
    const staleRead = await client.callTool("read_document", { ...staleHit.read, after: 200 });
    assert.ok((toolJson(staleRead).text ?? toolJson(staleRead).文本).includes("first body"));
  } finally {
    if (vectors?.open) vectors.close();
    await client.close();
    await channel.close();
    app.cleanup();
  }
});

test("book include_references respects nav fragments and internal reference headings", async () => {
  const app = createFixtureApp();
  const client = new McpClient(app.dbPath);
  try {
    writeEpubFixture(app, "fragment-book", [{
      id: "chapter.xhtml",
      label: "Chapter",
      nav: [
        { href: "chapter.xhtml#chapter", label: "Chapter" },
        { href: "chapter.xhtml#later", label: "References" },
      ],
      body: `<h1 id="chapter">Chapter</h1><p>Nothing</p><h2 id="later">References</h2><p>needle later</p>`,
    }]);
    writeEpubFixture(app, "internal-references", [{
      id: "chapter.xhtml",
      label: "Chapter",
      body: `<h1 id="chapter">Chapter</h1><p>Nothing</p><h2 id="references">References</h2><p>needle internal</p>`,
    }]);
    app.close();
    await client.initialize();
    for (const [doc, query] of [["book:fragment-book", "needle later"], ["book:internal-references", "needle internal"]]) {
      const excluded = await searchPage(client, { query, doc, include_references: false });
      assert.equal(excluded.结果.length, 0, `${doc} should exclude references`);
      const included = await searchPage(client, { query, doc, include_references: true });
      assert.ok(included.结果.length > 0, `${doc} should include references`);
    }
  } finally {
    await client.close();
    app.cleanup();
  }
});

test("legacy semanticSearch keeps strict all-scope vector database failures", async () => {
  const app = createFixtureApp();
  const channel = await startEmbedChannel(app.appDir);
  let vectors;
  try {
    registerPaper(app, "strict-paper", "# One\nstrict text");
    vectors = createVectorDb(path.join(app.appDir, "papers", "vectors.sqlite"));
    addVectorChunk(vectors, { id: 1, paper_id: "strict-paper", chunk_text: "strict text", vector: [1, 0] });
    vectors.close();
    writeEpubFixture(app, "broken-book", [{ id: "one.xhtml", label: "One", body: `<p id="chapter">Text</p>` }]);
    app.writeBookFile("broken-book", "vectors.sqlite", "not a sqlite database");
    await assert.rejects(
      semantic.semanticSearch(app.appDir, { query: "strict", scope: "all", topK: 8 }),
      /检索失败|向量库|database|file is not a database/i,
    );
  } finally {
    if (vectors?.open) vectors.close();
    await channel.close();
    app.cleanup();
  }
});
