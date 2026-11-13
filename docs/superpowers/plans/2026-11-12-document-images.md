# Document Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add paper figure discovery, safe paper image-path rewriting, and real single/batch image responses for books and papers.

**Architecture:** A path/figure module owns Markdown image discovery and document-root containment. A separate binary module uses sharp to decode, resize, compress, and emit standard MCP image content. `src/index.ts` only wires DocRef resolution and tool responses.

**Tech Stack:** TypeScript, Node.js, MCP SDK, sharp, Node test runner, existing stdio fixture client.

**Spec:** `docs/superpowers/specs/2026-11-12-document-images-design.md`

## Global Constraints

- Keep version 0.3.0; do not commit, push, publish, or change vector search/canonical offsets.
- Accept at most 6 images and 20 MiB per source image; default max edge 1024, allowed input 512–1536.
- Only read the selected document directory and, for books, that book's EPUB image cache.
- Return raw base64 `image` content with `mimeType: "image/jpeg"`; no provider-specific logic.
- Preserve existing tests and the 7 legacy tools unchanged; modern tool count becomes 20 and total legacy-enabled count 27.

## Review Focus

- Percent-encoded paths, spaces, angle destinations, titles, external/data URLs: rewrite only valid local images (Task 1 tests).
- Traversal, absolute paths outside the selected doc, and symlink/junction escape: reject without returning bytes (Task 2 tests).
- Fake images, oversized files, and one bad member in a valid batch: explicit error/partial success, never silent (Task 2 tests).
- Multi-image payload and dimensions: base64 budget stays bounded and max edge is honored (Task 2 tests).
- Missing images, duplicate captions, orphan captions, and figure limits: honest metadata rather than invented paths (Task 1 tests).

---

### Task 1: Paper Image Paths and Figure Discovery

**Files:**
- Create: `src/document-images.ts`
- Modify: `src/index.ts`
- Test: `scripts/test-document-images.mjs`

**Interfaces:**
- Produces: `rewritePaperImagePaths(paperDir: string, text: string): string`
- Produces: `listPaperFigures(paperDir: string, markdown: string, maxFigures?: number): PaperFigureListing`
- Produces: `resolveImagePathWithinRoots(filePath: string, roots: string[]): string | null` for Task 2.
- MCP: `list_paper_figures({ doc })`; `read_document` paper text uses the rewriter after slicing.

- [ ] **Step 1: Write failing path/figure tests**

Create tests proving: an existing `images/fig 1.png` and percent-encoded ref become absolute; title text is preserved; missing/external/data/traversal refs stay unchanged; figure alt and following block captions attach correctly with section and canonical offset; unresolved `image_path` is `null`; orphan captions are counted; the 50-item limit sets `truncated`.

- [ ] **Step 2: Verify tests fail before implementation**

Run: `npm run build && node --test scripts/test-document-images.mjs`
Expected: FAIL because `src/document-images.ts` and `list_paper_figures` do not exist.

- [ ] **Step 3: Implement path containment, rewriting, and figure extraction**

Use the existing Markdown/HTML image shapes used by `book-document.ts`. Resolve refs after decoding, require both lexical and real paths to remain under the real paper directory, and return slashed real paths. Parse the existing paper canonical body so offsets and section headings use the established coordinate system.

- [ ] **Step 4: Wire the paper read path and figure tool**

Call the rewriter only after `readPaperWindow`; never recalculate offsets after rewriting. Register `list_paper_figures` with a required DocRef, reject non-paper refs, and return the listing without image bytes.

- [ ] **Step 5: Run the focused and existing document tests**

Run: `npm run build && node --test scripts/test-document-images.mjs && node scripts/test-document-contract.mjs`
Expected: all pass, including existing book image/window tests.

### Task 2: Safe Single/Batch Image Content

**Files:**
- Create: `src/image-content.ts`
- Modify: `src/index.ts`
- Modify: `package.json`, `package-lock.json`
- Test: `scripts/test-document-images.mjs`

**Interfaces:**
- Consumes: `resolveImagePathWithinRoots` from Task 1.
- Produces: `readImageBatch(paths: string[], roots: string[], options?: { maxEdge?: number }): Promise<ImageMcpContent[]>`.
- MCP: `read_images({ doc, paths, max_edge? })` returns mixed text/image content.

- [ ] **Step 1: Add failing MCP image tests**

Generate real PNG/JPEG fixtures with sharp. Assert one call returns a text envelope and a valid JPEG image; `max_edge: 512` is honored; two valid images return two image blocks with total base64 within budget; a missing member is reported while valid members survive; all-failed batches set `isError`; relative/outside/fake-image paths return no image bytes; seven paths fail schema validation; a book can read its own EPUB cache but not another book's cache.

- [ ] **Step 2: Verify tests fail before implementation**

Run: `npm install sharp && npm run build && node --test scripts/test-document-images.mjs`
Expected: image tests FAIL because `readImageBatch` / `read_images` do not exist. The dependency install is intentional and must remain in both manifests.

- [ ] **Step 3: Implement bounded image loading**

Read only resolved files no larger than 20 MiB. Decode with sharp using a pixel limit, reject SVG/non-raster input, auto-rotate, resize without enlargement, flatten transparency onto white, and encode JPEG. Reduce quality/dimensions until each image fits its share of the 700,000-character batch budget. Include path, dimensions, source/payload sizes, and resize status in each text envelope.

- [ ] **Step 4: Register `read_images` with document-scoped roots**

Require `doc` and 1–6 absolute paths. Allow the selected `books/<id>` tree; for books also allow only `image-cache/epub/<safeBookId>`. Return partial successes with error text; return `isError: true` only when no image can be read.

- [ ] **Step 5: Run image and document regression tests**

Run: `npm run build && node --test scripts/test-document-images.mjs && node scripts/test-document-contract.mjs`
Expected: all pass and responses contain actual MCP `image` blocks rather than file links.

### Task 3: Tool Contract, Documentation, and Full Verification

**Files:**
- Modify: `scripts/smoke-test.mjs`
- Modify: `README.md`
- Test: all existing scripts

**Interfaces:**
- Modern set is 20 tools; legacy-enabled set is 27.
- Smoke exposes complete tool content so image blocks can be asserted.

- [ ] **Step 1: Update smoke expectations and real-data image checks**

Add both new tools, assert `read_images.paths/max_edge` schema, and preserve all returned content. When a real paper figure exists, call `list_paper_figures` and `read_images`, then assert a non-empty base64 JPEG image. Update all 18/25 documentation assertions to 20/27.

- [ ] **Step 2: Update README**

Document the two tools, path/offset ordering, allowed roots, 20 MiB/6-image/700,000-character limits, JPEG conversion, partial failures, cache behavior, and the new focused test command. Keep release instructions; do not claim a release happened.

- [ ] **Step 3: Run the complete standard verification**

Run:

```bash
npm run clean && npm run build
node --test scripts/test-document-images.mjs
node scripts/test-document-contract.mjs
node scripts/test-search-library.mjs
npm run smoke
npm run smoke -- --release
npm pack --dry-run
```

Expected: every command passes. If the real data has no figures, smoke must explicitly report that image content was not exercised; do not claim that case as an image-content pass.

- [ ] **Step 4: Inspect the final workspace**

Run `git status --short`, remove only artifacts created by this task that are not deliverables, and leave pre-existing `docs/实战反馈-2026-09-30.md` and `docs/plans/` changes untouched. Do not commit or publish.
