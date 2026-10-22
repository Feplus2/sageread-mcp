/**
 * 冒烟测试：以 stdio JSON-RPC 与 sageread-mcp 对话
 * 流程：initialize → notifications/initialized → tools/list → 调用现代精简集工具
 * 用法：node scripts/smoke-test.mjs [--release]
 *   默认测开发版库（--dev）；--release 测发行版库
 *   SAGEREAD_SMOKE_EMBED=1 时要求 search_library 的真实嵌入调用成功（默认只做可用性/降级检查）
 *
 * 默认集断言 tools/list 恰好为 18 个现代工具；结束时再以 SAGEREAD_MCP_LEGACY_TOOLS=1
 * 启动一次，仅断言 tools/list 额外注册了 7 个旧工具（共 25 个）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const useDev = !process.argv.includes("--release"); // 默认测开发版库
const withEmbed = process.env.SAGEREAD_SMOKE_EMBED === "1";
const serverArgs = [path.join(__dirname, "..", "dist", "index.js"), ...(useDev ? ["--dev"] : [])];

// 与 README「默认现代精简集」保持一致；启动后会从 README 解析数量并交叉断言
const MODERN_TOOLS = [
  "list_books",
  "get_book_progress",
  "get_reading_stats",
  "list_threads",
  "get_thread",
  "list_book_notes",
  "list_notes",
  "export_thread_markdown",
  "list_tags",
  "list_skills",
  "get_paper_info",
  "list_papers",
  "list_paper_folders",
  "export_paper_citation",
  "search_library",
  "get_document_info",
  "read_document",
  "get_citation_graph",
];
// 仅在 SAGEREAD_MCP_LEGACY_TOOLS=1 时注册的旧工具
const LEGACY_TOOLS = [
  "get_paper_toc",
  "read_paper",
  "read_paper_section",
  "semantic_search",
  "get_chunk_context",
  "get_book_toc",
  "read_book",
];

// README 是工具面数量的对外契约：从标题解析并断言，防止文档与实现漂移
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const readmeModernCount = Number(readme.match(/### 默认现代精简集（(\d+) 个）/)?.[1] ?? NaN);
const readmeLegacyCount = Number(readme.match(/### 旧工具（legacy，默认关闭，(\d+) 个）/)?.[1] ?? NaN);

const clients = new Set();

function cleanupAndExit(code) {
  for (const c of clients) c.close();
  process.exit(code);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n✗ 断言失败: ${msg}`);
    cleanupAndExit(1);
  }
  console.log(`✓ ${msg}`);
}

function show(title, text, limit = 600) {
  console.log(`\n===== ${title} =====\n` + text.slice(0, limit));
}

/** 一个 stdio MCP 客户端；每次检查各自起进程，保证工具面互不污染 */
class McpClient {
  constructor(env = {}) {
    this.closing = false;
    this.child = spawn(process.execPath, serverArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.on("error", (err) => {
      console.error("spawn 失败:", err);
      cleanupAndExit(1);
    });
    this.child.on("exit", (code) => {
      if (this.closing) return;
      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`server 提前退出（code=${code}）`));
      }
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  rpc(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }

  async initialize() {
    const init = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
    return init;
  }

  async listTools() {
    const res = await this.rpc("tools/list", {});
    return res.result?.tools?.map((t) => t.name) ?? [];
  }

  async callTool(name, args, timeoutMs) {
    const res = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    return { text: res.result?.content?.[0]?.text ?? "(无内容)", isError: res.result?.isError === true };
  }

  close() {
    this.closing = true;
    try {
      this.child.kill();
    } catch {
      // 已退出
    }
  }
}

// 显式关闭 legacy，保证默认断言不受调用者 shell 环境里的同名变量影响
const client = new McpClient({ SAGEREAD_MCP_LEGACY_TOOLS: "0" });
clients.add(client);

const init = await client.initialize();
console.log("✓ initialize:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);

// ---- 默认工具面：恰好现代精简集，旧工具不注册 ----
const toolNames = await client.listTools();
console.log(`✓ tools/list（默认现代集，${toolNames.length} 个）: ${toolNames.join(", ")}`);
assert(readmeModernCount === MODERN_TOOLS.length, `README 默认集数量与 smoke 常量一致（README=${readmeModernCount}, smoke=${MODERN_TOOLS.length}）`);
assert(readmeLegacyCount === LEGACY_TOOLS.length, `README legacy 数量与 smoke 常量一致（README=${readmeLegacyCount}, smoke=${LEGACY_TOOLS.length}）`);
assert(toolNames.length === MODERN_TOOLS.length, `默认 tools/list 数量为 ${MODERN_TOOLS.length}（实际 ${toolNames.length}）`);
assert(toolNames.length === readmeModernCount, `默认 tools/list 数量与 README 一致（README=${readmeModernCount}, 实际=${toolNames.length}）`);
for (const name of MODERN_TOOLS) assert(toolNames.includes(name), `默认集包含 ${name}`);
for (const name of LEGACY_TOOLS) assert(!toolNames.includes(name), `默认集不包含旧工具 ${name}`);
assert(new Set(toolNames).size === toolNames.length, "默认 tools/list 无重名工具");

const booksRes = await client.callTool("list_books", {});
show("list_books（截断）", booksRes.text);

const stats = await client.callTool("get_reading_stats", { period: "week" });
show("get_reading_stats(week)", stats.text);

const threads = await client.callTool("list_threads", {});
show("list_threads（截断）", threads.text, 500);

const firstThreadId = JSON.parse(threads.text)[0]?.id;
if (firstThreadId) {
  const thread = await client.callTool("get_thread", { threadId: firstThreadId });
  show("get_thread（截断）", thread.text, 500);
}

const starred = await client.callTool("list_threads", { starred_only: true });
show("list_threads(starred_only)", starred.text, 500);

// ---- 论文/笔记/文件夹 ----

const folders = await client.callTool("list_paper_folders", {});
show("list_paper_folders", folders.text);

// 记事本面板（notes 表）
const allNotes = await client.callTool("list_notes", {});
show("list_notes（截断）", allNotes.text, 600);

const papers = await client.callTool("list_papers", {});
show("list_papers（默认）", papers.text, 800);

// ---- P1 文档原语（DocRef）对齐 ----
const firstPaperId = (() => {
  try {
    const parsed = JSON.parse(papers.text);
    return parsed && parsed.论文 && parsed.论文[0] ? parsed.论文[0].id : null;
  } catch {
    return null;
  }
})();
if (firstPaperId) {
  const docInfo = await client.callTool("get_document_info", { doc: "paper:" + firstPaperId });
  show("get_document_info(paper)", docInfo.text, 500);
  assert(!docInfo.isError, "get_document_info(paper) 不应报错");
  const readDoc = await client.callTool("read_document", { doc: "paper:" + firstPaperId, limit: 1200 });
  show("read_document(paper)", readDoc.text, 400);
  assert(!readDoc.isError, "read_document(paper) 不应报错");
  // 用文档真实目录里的标题读一个小节（替代旧 read_paper_section；标题不写死，避免换库失效）
  let heading = null;
  try {
    const info = JSON.parse(docInfo.text);
    const toc = Array.isArray(info.目录) ? info.目录 : [];
    heading = toc.length ? toc[toc.length - 1].heading : null;
  } catch {
    // 非 JSON 或结构变化时跳过小节读取
  }
  if (heading) {
    const section = await client.callTool("read_document", { doc: "paper:" + firstPaperId, heading, limit: 800 });
    show(`read_document(paper, heading=${heading})（截断）`, section.text, 500);
    assert(!section.isError, "read_document(paper, heading) 不应报错");
  }
  const graph = await client.callTool("get_citation_graph", { doc: "paper:" + firstPaperId }, 30000);
  show("get_citation_graph(paper)", graph.text, 500);
  assert(!graph.isError, "get_citation_graph(paper) 不应报错");
}

const firstBook = (() => {
  try {
    const parsed = JSON.parse(booksRes.text);
    return parsed && parsed[0] ? parsed[0].id : null;
  } catch {
    return null;
  }
})();
if (firstBook) {
  const bookInfo = await client.callTool("get_document_info", { doc: "book:" + firstBook });
  show("get_document_info(book)", bookInfo.text, 500);
  assert(!bookInfo.isError, "get_document_info(book) 不应报错");
}

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
  ? await client.callTool("list_papers", { collection: firstFolder })
  : await client.callTool("list_papers", {});
show(`list_papers(collection=${firstFolder ?? "(无文件夹)"})`, papersInCollection.text, 800);

const papersWithAbstract = await client.callTool("list_papers", { include_abstract: true, limit: 2 });
show("list_papers(include_abstract, limit=2)（截断）", papersWithAbstract.text, 1000);

// 引用格式断言的目标论文（17 位作者 / Science 370(6517) / doi 10.1126/science.aay9972）。
// 列表顺序随导入变化，不能假设"第一篇 MARKDOWN"是它——按元数据 DOI 定位（有界探测），找不到则跳过引用断言。
const CITATION_DOI = "10.1126/science.aay9972";
const markdownBooks = JSON.parse(booksRes.text).filter((b) => b.格式 === "MARKDOWN");
const paperBook = markdownBooks[0];
let citationBook = paperBook;
let citationTargetFound = false;
for (const cand of markdownBooks.slice(0, 60)) {
  const info = await client.callTool("get_paper_info", { paper: cand.id });
  if (info.text.includes(CITATION_DOI)) {
    citationBook = cand;
    citationTargetFound = true;
    break;
  }
}
if (paperBook) {
  console.log(`\n✓ 发现 MARKDOWN 论文: ${paperBook.书名} (${paperBook.id})`);

  const info = await client.callTool("get_paper_info", { paper: paperBook.id });
  show("get_paper_info", info.text, 1200);

  const notes = await client.callTool("list_book_notes", { book: paperBook.id });
  show("list_book_notes（论文，截断）", notes.text, 800);

  const bibtex = await client.callTool("export_paper_citation", { paper: paperBook.id, format: "bibtex" });
  show("export_paper_citation(bibtex)", bibtex.text, 800);

  const gbt = await client.callTool("export_paper_citation", { paper: paperBook.id, format: "gbt7714" });
  show("export_paper_citation(gbt7714)", gbt.text, 500);

  // 新格式断言（目标论文：17 位作者、Science 370(6517)、708-711、doi 10.1126/science.aay9972；
  // citationBook 按 DOI 定位——列表第一篇随导入变化，不假设是它）
  if (!citationTargetFound) {
    console.log(`\n- 未在库中定位到引用断言目标论文（doi ${CITATION_DOI}），跳过引用格式断言`);
  } else {
    console.log(`
✓ 引用断言目标: ${citationBook.书名} (${citationBook.id})`);
    const apa = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "apa" });
    show("export_paper_citation(apa)", apa.text, 800);
    assert(apa.text.includes("Zhao, C."), "apa: 首作者缩写 Zhao, C.");
    assert(apa.text.includes("& Hu, Y.-S."), "apa: 末位作者 & Hu, Y.-S.（连字符名 Y.-S.）");
    assert((apa.text.match(/, [A-Z]\./g) || []).length === 17, "apa: 17 位作者全列");
    assert(apa.text.includes("https://doi.org/10.1126/science.aay9972"), "apa: doi 链接");

    const mla = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "mla" });
    show("export_paper_citation(mla)", mla.text, 500);
    assert(mla.text.startsWith('Zhao, Chenglong, et al. "'), "mla: 第一作者 + et al.");
    assert(mla.text.includes('"Rational Design of Layered Oxide Materials for Sodium-Ion Batteries."'), "mla: Title Case 题名（of/for 小写、Sodium-Ion 双段大写）");

    const chicago = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "chicago" });
    show("export_paper_citation(chicago)", chicago.text, 600);
    assert(chicago.text.includes("Zhao, Chenglong, Qidi Wang"), "chicago: 第一作者倒置、其余正序");
    // 现库 metadata 无卷/期/页字段（旧库有）——断言按现有数据形态
    assert(chicago.text.includes("Science (2020)."), "chicago: 刊名+年（无卷期页时降级形态）");

    const ieee = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "ieee" });
    show("export_paper_citation(ieee)", ieee.text, 500);
    assert(ieee.text.startsWith('C. Zhao, et al., "'), "ieee: >6 位作者只写第一作者 + et al.");
    assert(ieee.text.includes("doi: 10.1126/science.aay9972"), "ieee: doi 段");

    const vancouver = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "vancouver" });
    show("export_paper_citation(vancouver)", vancouver.text, 500);
    assert(vancouver.text.startsWith("Zhao C, Wang Q, Yao Z, Wang J, Sánchez-Lengeling B, Ding F, et al. Rational"), "vancouver: 前 6 位 + et al.，姓+名首字母");
    assert(vancouver.text.includes("Science. 2020."), "vancouver: 刊名+年（无卷期页时降级形态）");

    const ris = await client.callTool("export_paper_citation", { paper: citationBook.id, format: "ris" });
    show("export_paper_citation(ris)", ris.text, 900);
    assert(ris.text.startsWith("TY  - JOUR"), "ris: TY  - JOUR 开头");
    assert((ris.text.match(/^AU  - /gm) || []).length === 17, "ris: 17 行 AU");
    // 现库 metadata 无页码——SP/EP 拆分逻辑待有页码的论文回归（旧库已验证过）
    assert(ris.text.trimEnd().endsWith("ER  -"), "ris: ER 结尾");
  }
} else {
  console.log("\n- 未找到 MARKDOWN 论文，跳过 get_paper_info / list_book_notes / export_paper_citation 冒烟");
}

// ---- 统一检索（search_library）----
const search = await client.callTool("search_library", { query: "cationic potential", top_k: 3 }, 90000);
show("search_library(cationic potential)", search.text, 1200);
const searchReady = !search.isError;
if (search.isError) {
  assert(
    /SageRead 未运行|本地通道|向量模型|向量索引|向量库/.test(search.text),
    "search_library 不可用时返回带引导的降级提示",
  );
  console.log("- search_library 降级（需要 SageRead 运行且向量模型就绪），跳过结果断言");
} else {
  const parsed = JSON.parse(search.text);
  assert(Array.isArray(parsed.结果), "search_library 返回 结果 数组");
  assert(parsed.结果.length === parsed.结果数, "search_library 结果数与数组长度一致");
  assert(parsed.范围 === "all", "search_library 默认跨库（scope=all）");
  for (const item of parsed.结果) {
    assert(typeof item.doc === "string" && /^(book|paper):/.test(item.doc), "search_library 结果带统一 doc 锚点");
    assert(typeof item.片段 === "string" && typeof item.相似度 === "string", "search_library 结果带片段与相似度");
  }
}

// 参数校验发生在嵌入调用之前：坏 doc / doc-scope 冲突都应立即报错
const badDoc = await client.callTool("search_library", { query: "cationic potential", doc: "no-such-doc" });
show("search_library(未知名 doc，应报明确错误)", badDoc.text, 300);
assert(badDoc.isError, "search_library 对无法识别的 doc 返回错误（不发起嵌入）");
assert(badDoc.text.includes("无法识别文档引用"), "search_library doc 错误提示明确");

if (firstPaperId) {
  const conflict = await client.callTool("search_library", {
    query: "cationic potential",
    doc: "paper:" + firstPaperId,
    scope: "books",
  });
  show("search_library(doc/scope 冲突，应报明确错误)", conflict.text, 300);
  assert(conflict.isError && conflict.text.includes("doc 与 scope 冲突"), "search_library 校验 doc 与 scope 冲突");
}

if (withEmbed) {
  assert(searchReady, "SAGEREAD_SMOKE_EMBED=1 时 search_library 应可用（SageRead 运行且向量模型就绪）");
  const parsed = JSON.parse(search.text);
  assert(parsed.结果.length > 0, "search_library 真实嵌入应至少命中 1 条");
  // 用首条命中的 doc 锚点反向限定，验证 doc 过滤（不假设第一篇论文一定已向量化）
  const anchor = parsed.结果[0]?.doc;
  if (anchor) {
    const limited = await client.callTool(
      "search_library",
      { query: "cationic potential", doc: anchor, top_k: 2 },
      90000,
    );
    show(`search_library(doc=${anchor})`, limited.text, 800);
    assert(!limited.isError, "search_library 按 doc 反查不应报错");
    const lp = JSON.parse(limited.text);
    assert(lp.结果数 > 0, "search_library 按命中 doc 反查应仍有结果");
    for (const item of lp.结果) {
      assert(item.doc === anchor, "search_library doc 过滤只返回该文档");
    }
  }
} else {
  console.log("- 未设置 SAGEREAD_SMOKE_EMBED=1：search_library 只做可用性/降级检查（不强制要求命中）");
}

client.close();
clients.delete(client);

// ---- legacy 开关：旧工具仍可注册（只查 tools/list）----
const legacy = new McpClient({ SAGEREAD_MCP_LEGACY_TOOLS: "1" });
clients.add(legacy);
try {
  await legacy.initialize();
  const legacyNames = await legacy.listTools();
  console.log(`✓ tools/list（SAGEREAD_MCP_LEGACY_TOOLS=1，${legacyNames.length} 个）: ${legacyNames.join(", ")}`);
  assert(
    legacyNames.length === MODERN_TOOLS.length + LEGACY_TOOLS.length,
    `legacy 模式 tools/list 数量为 ${MODERN_TOOLS.length + LEGACY_TOOLS.length}（实际 ${legacyNames.length}）`,
  );
  for (const name of MODERN_TOOLS) assert(legacyNames.includes(name), `legacy 模式仍包含现代工具 ${name}`);
  for (const name of LEGACY_TOOLS) assert(legacyNames.includes(name), `legacy 模式注册旧工具 ${name}`);
  assert(new Set(legacyNames).size === legacyNames.length, "legacy 模式 tools/list 无重名工具");
} finally {
  legacy.close();
  clients.delete(legacy);
}

console.log("\n✓ 冒烟测试完成");
process.exit(0);
