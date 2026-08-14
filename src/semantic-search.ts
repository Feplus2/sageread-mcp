/**
 * 语义检索模块：查询文本的向量化经 **SageRead 本地通道**完成（I2，密钥不出 app 进程），
 * 再用 sqlite-vec 在 vectors.sqlite 里做近邻检索。本模块只读：向量库以 readonly 模式打开，用完即关。
 *
 * 本地通道：SageRead 启动时把 {port, token} 写入 appData/mcp-local.json，
 * 本进程凭 token 调 `POST /embed`，app 用当前选中向量模型 + keyring 密钥执行嵌入，只回向量。
 * 历史背景：早期版本直读 llama-store.json 的 apiKey 自调嵌入，批次 A 密钥迁入 keyring 后
 * 该路径失效且违反“密钥不出 app”红线，故整体改道。
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";

// ---------- 本地通道（app 侧嵌入） ----------

interface LocalChannel {
  port: number;
  token: string;
}

/** 读取 SageRead 写入的本地通道凭据（app 未运行时文件不存在/陈旧，连接失败时降级提示） */
function readLocalChannel(appDir: string): LocalChannel | null {
  const file = path.join(appDir, "mcp-local.json");
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { port?: number; token?: string };
    if (typeof data.port === "number" && typeof data.token === "string" && data.token) {
      return { port: data.port, token: data.token };
    }
  } catch {
    // 文件损坏等同未启动
  }
  return null;
}

/** 经本地通道把查询文本向量化（嵌入在 app 内执行，本进程不接触任何密钥） */
async function embedViaApp(appDir: string, text: string): Promise<number[]> {
  const channel = readLocalChannel(appDir);
  if (!channel) {
    throw new Error("SageRead 未运行（未找到本地通道）：语义检索需要应用执行嵌入，请启动 SageRead 后重试");
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${channel.port}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel.token}`,
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new Error("无法连接 SageRead 本地通道（应用可能已退出）：请启动 SageRead 后重试");
  }
  const data = (await res.json().catch(() => ({}))) as { vector?: number[]; error?: string };
  if (!res.ok || !Array.isArray(data.vector) || data.vector.length === 0) {
    const reason = data.error ?? `HTTP ${res.status}`;
    if (/未启用外部向量模型|未选择向量模型/.test(reason)) {
      throw new Error(`SageRead 向量模型未就绪：${reason}（设置 → 向量模型）`);
    }
    throw new Error(`本地通道嵌入失败：${reason}`);
  }
  return data.vector;
}

// ---------- 向量库检索 ----------

interface ChunkRow {
  id: number;
  book_title: string | null;
  book_author: string | null;
  paper_id: string | null;
  md_file_path: string | null;
  file_order_in_book: number | null;
  related_chapter_titles: string | null;
  chunk_text: string | null;
  chunk_order_in_file: number | null;
  total_chunks_in_file: number | null;
  global_chunk_index: number | null;
  created_at: string | null;
  distance: number;
}

/** 从 vec0 建表 SQL 的 FLOAT[N] 解析索引维度 */
function readIndexDimension(db: Database.Database): number | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'chunk_embeddings'`)
    .get() as { sql: string | null } | undefined;
  const match = row?.sql?.match(/FLOAT\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

/** 在单个 vectors.sqlite 中做 top-k 检索，返回带 distance 的行 */
function searchVectorDb(
  dbPath: string,
  queryVector: number[],
  k: number,
): ChunkRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
    const indexDim = readIndexDimension(db);
    if (indexDim !== null && indexDim !== queryVector.length) {
      throw new Error(
        `向量索引维度 ${indexDim} 与当前嵌入模型维度 ${queryVector.length} 不一致：请在 SageRead 中对该库重建向量索引`,
      );
    }
    return db
      .prepare(
        `SELECT dc.*, ce.distance FROM chunk_embeddings ce
         JOIN document_chunks dc ON dc.id = ce.chunk_id
         WHERE ce.embedding MATCH ? AND k = ?`,
      )
      .all(JSON.stringify(queryVector), k) as ChunkRow[];
  } finally {
    db.close();
  }
}

// ---------- 对外主流程 ----------

export interface SemanticSearchOptions {
  query: string;
  scope: "papers" | "books" | "all";
  paperId?: string;
  /** 论文集合过滤（如某收藏文件夹的成员 paper_id 列表）；与 paperId 同给时取交集 */
  paperIds?: string[];
  bookId?: string;
  topK: number;
}

export interface SemanticSearchItem {
  rank: number;
  相似度: string;
  内容: string | null;
  出处: {
    书名: string | null;
    作者: string | null;
    类型: "论文" | "书籍";
    id: string | null;
    章节: string | null;
    文件: string | null;
    块位置: string;
  };
  /** 引导 Agent 用 get_chunk_context 扩展上下文的调用示例 */
  上下文提示?: string;
}

export interface SemanticSearchResult {
  查询: string;
  范围: string;
  结果数: number;
  结果: SemanticSearchItem[];
}

const CONTENT_MAX = 800;

function toItem(row: ChunkRow, rank: number, fallbackBookId?: string): SemanticSearchItem {
  const text = row.chunk_text ?? null;
  const id = row.paper_id || fallbackBookId || null;
  return {
    rank,
    相似度: `${((1 - row.distance) * 100).toFixed(1)}%`,
    内容: text ? text.slice(0, CONTENT_MAX) + (text.length > CONTENT_MAX ? "…" : "") : null,
    出处: {
      书名: row.book_title,
      作者: row.book_author,
      类型: row.paper_id ? "论文" : "书籍",
      id,
      章节: row.related_chapter_titles,
      文件: row.md_file_path,
      块位置: `${row.chunk_order_in_file ?? "?"}/${row.total_chunks_in_file ?? "?"}`,
    },
    ...(id !== null && typeof row.chunk_order_in_file === "number"
      ? { 上下文提示: `get_chunk_context(paper_id='${id}', chunk_order=${row.chunk_order_in_file})` }
      : {}),
  };
}

export async function semanticSearch(
  appDir: string,
  options: SemanticSearchOptions,
): Promise<SemanticSearchResult> {
  const { query, scope, paperId, paperIds, bookId, topK } = options;

  // I2：嵌入经 SageRead 本地通道（app 用自己的 keyring 密钥执行，本进程不碰密钥）；
  // app 未运行/向量模型未配置时 embedViaApp 抛带引导的降级错误
  const queryVector = await embedViaApp(appDir, query);

  const rows: { row: ChunkRow; fallbackBookId?: string }[] = [];

  // 论文库：多论文共存一库；按 paper_id / 文件夹集合过滤时 k 放大（vec0 MATCH 是全局 top-k）
  if (scope === "papers" || scope === "all") {
    const papersDb = path.join(appDir, "papers", "vectors.sqlite");
    // paperId 与集合同给时取交集：paperId 不在集合内 → 论文域空结果
    const intersectEmpty = paperId !== undefined && paperIds !== undefined && !paperIds.includes(paperId);
    if (!fs.existsSync(papersDb)) {
      if (scope === "papers") {
        throw new Error(
          `论文向量库不存在（${papersDb}）：请先在 SageRead 里对论文执行向量化后再试`,
        );
      }
    } else if (!intersectEmpty) {
      const needFilter = paperId !== undefined || paperIds !== undefined;
      const k = needFilter ? Math.max(topK * 10, 100) : topK;
      let found = searchVectorDb(papersDb, queryVector, k);
      if (paperIds !== undefined) {
        const set = new Set(paperIds);
        found = found.filter((r) => r.paper_id !== null && set.has(r.paper_id));
      }
      if (paperId) found = found.filter((r) => r.paper_id === paperId);
      if (needFilter) found = found.slice(0, topK);
      rows.push(...found.map((row) => ({ row })));
    }
  }

  // 书籍库：一书一库；未指定 bookId 时枚举所有含 vectors.sqlite 的书籍目录
  if (scope === "books" || scope === "all") {
    const booksRoot = path.join(appDir, "books");
    const bookDirs = bookId
      ? [bookId]
      : fs.existsSync(booksRoot)
        ? fs
            .readdirSync(booksRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(booksRoot, d.name, "vectors.sqlite")))
            .map((d) => d.name)
        : [];
    if (bookId) {
      const dbPath = path.join(booksRoot, bookId, "vectors.sqlite");
      if (!fs.existsSync(dbPath)) {
        throw new Error(
          `书籍向量库不存在（${dbPath}）：请先在 SageRead 里对该书执行向量化后再试`,
        );
      }
    }
    let anyDb = false;
    for (const dir of bookDirs) {
      const dbPath = path.join(booksRoot, dir, "vectors.sqlite");
      if (!fs.existsSync(dbPath)) continue;
      anyDb = true;
      const found = searchVectorDb(dbPath, queryVector, topK);
      rows.push(...found.map((row) => ({ row, fallbackBookId: dir })));
    }
    if (!anyDb && scope === "books" && !bookId) {
      throw new Error("没有任何书籍的向量库：请先在 SageRead 里对书籍执行向量化后再试");
    }
  }

  rows.sort((a, b) => a.row.distance - b.row.distance);
  const items = rows.slice(0, topK).map(({ row, fallbackBookId }, i) => toItem(row, i + 1, fallbackBookId));

  return { 查询: query, 范围: scope, 结果数: items.length, 结果: items };
}
