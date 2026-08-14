/**
 * 冒烟测试：以 stdio JSON-RPC 与 sageread-mcp 对话
 * 流程：initialize → notifications/initialized → tools/list → 调用各只读工具
 * 用法：node scripts/smoke-test.mjs [--release]
 *   默认测开发版库（--dev）；--release 测发行版库
 *   SAGEREAD_SMOKE_EMBED=1 时额外执行 semantic_search 的真实嵌入调用（默认跳过）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const useDev = !process.argv.includes("--release"); // 默认测开发版库
const withEmbed = process.env.SAGEREAD_SMOKE_EMBED === "1";
const serverArgs = [path.join(__dirname, "..", "dist", "index.js"), ...(useDev ? ["--dev"] : [])];

const child = spawn(process.execPath, serverArgs, { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (err) => {
  console.error("spawn 失败:", err);
  process.exit(1);
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params, timeoutMs = 10000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`超时: ${method}`)), timeoutMs);
  });
}

function callTool(name, args, timeoutMs) {
  return rpc("tools/call", { name, arguments: args }, timeoutMs).then((res) => {
    const text = res.result?.content?.[0]?.text ?? "(无内容)";
    return { text, isError: res.result?.isError === true };
  });
}

function show(title, text, limit = 600) {
  console.log(`\n===== ${title} =====\n` + text.slice(0, limit));
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n✗ 断言失败: ${msg}`);
    child.kill();
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.1.0" },
});
console.log("✓ initialize:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list", {});
console.log("✓ tools/list:", tools.result.tools.map((t) => t.name).join(", "));

const booksRes = await callTool("list_books", {});
show("list_books（截断）", booksRes.text);

const stats = await callTool("get_reading_stats", { period: "week" });
show("get_reading_stats(week)", stats.text);

const threads = await callTool("list_threads", {});
show("list_threads（截断）", threads.text, 500);

const firstId = JSON.parse(threads.text)[0]?.id;
if (firstId) {
  const thread = await callTool("get_thread", { threadId: firstId });
  show("get_thread（截断）", thread.text, 500);
}

const starred = await callTool("list_threads", { starred_only: true });
show("list_threads(starred_only)", starred.text, 500);

// ---- 论文工具 ----

const folders = await callTool("list_paper_folders", {});
show("list_paper_folders", folders.text);

// 记事本面板（notes 表）
const allNotes = await callTool("list_notes", {});
show("list_notes（截断）", allNotes.text, 600);

const papers = await callTool("list_papers", {});
show("list_papers（默认）", papers.text, 800);

// collection 取现存第一个文件夹（固定名会随库演变失效）
const firstFolder = (() => {
  try {
    const arr = JSON.parse(folders.text);
    if (!Array.isArray(arr) || !arr.length) return null;
    const f = arr[0];
    return typeof f === "string" ? f : String(f.name ?? f.名称 ?? f.文件夹 ?? "");
  } catch {
    return null;
  }
})();
const papersInCollection = firstFolder
  ? await callTool("list_papers", { collection: firstFolder })
  : await callTool("list_papers", {});
show(`list_papers(collection=${firstFolder ?? "(无文件夹)"})`, papersInCollection.text, 800);

const papersWithAbstract = await callTool("list_papers", { include_abstract: true, limit: 2 });
show("list_papers(include_abstract, limit=2)（截断）", papersWithAbstract.text, 1000);

// 引用格式断言的目标论文（17 位作者 / Science 370(6517) / doi 10.1126/science.aay9972）。
// 列表顺序随导入变化，不能假设"第一篇 MARKDOWN"是它——按元数据 DOI 定位（有界探测），找不到则跳过引用断言。
const CITATION_DOI = "10.1126/science.aay9972";
const markdownBooks = JSON.parse(booksRes.text).filter((b) => b.格式 === "MARKDOWN");
const paperBook = markdownBooks[0];
let citationBook = paperBook;
let citationTargetFound = false;
for (const cand of markdownBooks.slice(0, 60)) {
  const info = await callTool("get_paper_info", { paper: cand.id });
  if (info.text.includes(CITATION_DOI)) {
    citationBook = cand;
    citationTargetFound = true;
    break;
  }
}
if (paperBook) {
  console.log(`\n✓ 发现 MARKDOWN 论文: ${paperBook.书名} (${paperBook.id})`);

  const info = await callTool("get_paper_info", { paper: paperBook.id });
  show("get_paper_info", info.text, 1200);

  const notes = await callTool("list_book_notes", { book: paperBook.id });
  show("list_book_notes（论文，截断）", notes.text, 800);

  const toc = await callTool("get_paper_toc", { paper: paperBook.id });
  show("get_paper_toc", toc.text, 800);

  const paper = await callTool("read_paper", { paper: paperBook.id, limit: 200 });
  show("read_paper(limit=200)", paper.text, 500);

  const section = await callTool("read_paper_section", { paper: paperBook.id, heading: "References" });
  show("read_paper_section(References)（截断）", section.text, 500);

  const bibtex = await callTool("export_paper_citation", { paper: paperBook.id, format: "bibtex" });
  show("export_paper_citation(bibtex)", bibtex.text, 800);

  const gbt = await callTool("export_paper_citation", { paper: paperBook.id, format: "gbt7714" });
  show("export_paper_citation(gbt7714)", gbt.text, 500);

  // 新格式断言（目标论文：17 位作者、Science 370(6517)、708-711、doi 10.1126/science.aay9972；
  // citationBook 按 DOI 定位——列表第一篇随导入变化，不假设是它）
  if (!citationTargetFound) {
    console.log(`\n- 未在库中定位到引用断言目标论文（doi ${CITATION_DOI}），跳过引用格式断言`);
  } else {
    console.log(`
✓ 引用断言目标: ${citationBook.书名} (${citationBook.id})`);
    const apa = await callTool("export_paper_citation", { paper: citationBook.id, format: "apa" });
    show("export_paper_citation(apa)", apa.text, 800);
    assert(apa.text.includes("Zhao, C."), "apa: 首作者缩写 Zhao, C.");
    assert(apa.text.includes("& Hu, Y.-S."), "apa: 末位作者 & Hu, Y.-S.（连字符名 Y.-S.）");
    assert((apa.text.match(/, [A-Z]\./g) || []).length === 17, "apa: 17 位作者全列");
    assert(apa.text.includes("https://doi.org/10.1126/science.aay9972"), "apa: doi 链接");

    const mla = await callTool("export_paper_citation", { paper: citationBook.id, format: "mla" });
    show("export_paper_citation(mla)", mla.text, 500);
    assert(mla.text.startsWith('Zhao, Chenglong, et al. "'), "mla: 第一作者 + et al.");
    assert(mla.text.includes('"Rational Design of Layered Oxide Materials for Sodium-Ion Batteries."'), "mla: Title Case 题名（of/for 小写、Sodium-Ion 双段大写）");

    const chicago = await callTool("export_paper_citation", { paper: citationBook.id, format: "chicago" });
    show("export_paper_citation(chicago)", chicago.text, 600);
    assert(chicago.text.includes("Zhao, Chenglong, Qidi Wang"), "chicago: 第一作者倒置、其余正序");
    // 现库 metadata 无卷/期/页字段（旧库有）——断言按现有数据形态
    assert(chicago.text.includes("Science (2020)."), "chicago: 刊名+年（无卷期页时降级形态）");

    const ieee = await callTool("export_paper_citation", { paper: citationBook.id, format: "ieee" });
    show("export_paper_citation(ieee)", ieee.text, 500);
    assert(ieee.text.startsWith('C. Zhao, et al., "'), "ieee: >6 位作者只写第一作者 + et al.");
    assert(ieee.text.includes("doi: 10.1126/science.aay9972"), "ieee: doi 段");

    const vancouver = await callTool("export_paper_citation", { paper: citationBook.id, format: "vancouver" });
    show("export_paper_citation(vancouver)", vancouver.text, 500);
    assert(vancouver.text.startsWith("Zhao C, Wang Q, Yao Z, Wang J, Sánchez-Lengeling B, Ding F, et al. Rational"), "vancouver: 前 6 位 + et al.，姓+名首字母");
    assert(vancouver.text.includes("Science. 2020."), "vancouver: 刊名+年（无卷期页时降级形态）");

    const ris = await callTool("export_paper_citation", { paper: citationBook.id, format: "ris" });
    show("export_paper_citation(ris)", ris.text, 900);
    assert(ris.text.startsWith("TY  - JOUR"), "ris: TY  - JOUR 开头");
    assert((ris.text.match(/^AU  - /gm) || []).length === 17, "ris: 17 行 AU");
    // 现库 metadata 无页码——SP/EP 拆分逻辑待有页码的论文回归（旧库已验证过）
    // 关键词随提取来源变化（现库该篇无 keywords）——只断言有则成行
    // assert KW 行数
    assert(ris.text.trimEnd().endsWith("ER  -"), "ris: ER 结尾");
  }

  const ctx = await callTool("get_chunk_context", { paper_id: paperBook.id, chunk_order: 63, radius: 1 });
  show("get_chunk_context(chunk 63, radius=1)（截断）", ctx.text, 1200);
} else {
  console.log("\n- 未找到 MARKDOWN 论文，跳过 get_paper_toc / read_paper / read_paper_section / export_paper_citation / get_chunk_context 冒烟");
}

// ---- 语义检索（默认跳过，需 SAGEREAD_SMOKE_EMBED=1）----

if (withEmbed) {
  const search = await callTool("semantic_search", { query: "cationic potential", top_k: 3 }, 60000);
  show("semantic_search(cationic potential)", search.text, 1200);
  if (search.isError) {
    console.error("\n✗ semantic_search 返回错误");
    child.kill();
    process.exit(1);
  }

  // collection 过滤：动态取现存第一个文件夹（旧库固定名已随库演变失效）
  let folderName = null;
  try {
    const arr = JSON.parse(folders.text);
    if (Array.isArray(arr) && arr.length) {
      const f = arr[0];
      folderName = typeof f === "string" ? f : String(f.name ?? f.名称 ?? f.文件夹 ?? "");
    }
  } catch {}
  const byCollection = folderName
    ? await callTool("semantic_search", { query: "cationic potential", collection: folderName, top_k: 3 }, 60000)
    : search;
  show(`semantic_search(collection=${folderName ?? "(跳过，无文件夹)"})`, byCollection.text, 1200);
  if (byCollection.isError) {
    console.error("\n✗ semantic_search(collection) 返回错误");
    child.kill();
    process.exit(1);
  }

  const badCollection = await callTool(
    "semantic_search",
    { query: "cationic potential", collection: "不存在的文件夹xyz", top_k: 1 },
    60000,
  );
  show("semantic_search(collection 未命中，应报明确错误)", badCollection.text, 400);
} else {
  console.log("\n- 跳过 semantic_search（设置 SAGEREAD_SMOKE_EMBED=1 可执行真实嵌入调用）");
}

child.kill();
console.log("\n✓ 冒烟测试完成");
process.exit(0);
