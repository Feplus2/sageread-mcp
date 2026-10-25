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
  if (process.env.SAGEREAD_DISABLE_EMBED === "1") return null;
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

export interface ChunkRow {
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
  searchChannel?: "hybrid" | "bm25";
}

/** 从 vec0 建表 SQL 的 FLOAT[N] 解析索引维度 */
function readIndexDimension(db: Database.Database): number | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'chunk_embeddings'`)
    .get() as { sql: string | null } | undefined;
  const match = row?.sql?.match(/FLOAT\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

interface HybridSearchOptions {
  query: string;
  vectorWeight: number;
  bm25Weight: number;
  includeReferences: boolean;
}

interface ScoredChunk {
  row: ChunkRow;
  score: number;
}

function normalizeScores(rows: ScoredChunk[], preserveUniform = false): number[] {
  if (!rows.length) return [];
  const scores = rows.map((item) => item.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (Math.abs(max - min) < Number.EPSILON) {
    return preserveUniform ? scores.map((score) => Math.max(0, score)) : scores.map(() => 1);
  }
  return scores.map((score) => (score - min) / (max - min));
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 1)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

function termFrequency(term: string, text: string): number {
  const foldedText = text.toLowerCase();
  const foldedTerm = term.toLowerCase();
  let count = 0;
  let offset = 0;
  while ((offset = foldedText.indexOf(foldedTerm, offset)) >= 0) {
    count += 1;
    offset += foldedTerm.length;
  }
  return count;
}

function searchBm25(
  db: Database.Database,
  query: string,
  limit: number,
  excludeReferences: boolean,
): ScoredChunk[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const stats = db
    .prepare("SELECT COUNT(*) AS total_docs, AVG(LENGTH(chunk_text)) AS avg_length FROM document_chunks")
    .get() as { total_docs: number; avg_length: number | null };
  if (!stats.total_docs) return [];
  const scores = new Map<number, number>();
  const referenceFilter = excludeReferences ? " AND is_references = 0" : "";
  for (const term of terms) {
    const rows = db
      .prepare(
        `SELECT id, chunk_text, LENGTH(chunk_text) AS doc_length FROM document_chunks
         WHERE (LOWER(chunk_text) LIKE ? OR LOWER(related_chapter_titles) LIKE ? OR LOWER(book_title) LIKE ?)${referenceFilter}`,
      )
      .all(`%${term}%`, `%${term}%`, `%${term}%`) as {
      id: number;
      chunk_text: string | null;
      doc_length: number;
    }[];
    const matching = rows
      .map((row) => ({ ...row, tf: termFrequency(term, row.chunk_text ?? "") }))
      .filter((row) => row.tf > 0);
    const df = matching.length;
    if (!df) continue;
    const idfArg = (stats.total_docs - df + 0.5) / (df + 0.5);
    const idf = idfArg > 0 ? Math.log(idfArg) : 0;
    const averageLength = stats.avg_length && stats.avg_length > 0 ? stats.avg_length : 1;
    for (const row of matching) {
      const numerator = row.tf * 2.2;
      const denominator = row.tf + 1.2 * (0.25 + 0.75 * (row.doc_length / averageLength));
      scores.set(row.id, (scores.get(row.id) ?? 0) + idf * (numerator / denominator));
    }
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit);
  const statement = db.prepare("SELECT dc.*, 0 AS distance FROM document_chunks dc WHERE dc.id = ?");
  return ranked.flatMap(([id, score]) => {
    const row = statement.get(id) as ChunkRow | undefined;
    return row ? [{ row, score }] : [];
  });
}

function combineHybrid(
  vectorRows: ScoredChunk[],
  bm25Rows: ScoredChunk[],
  vectorWeight: number,
  bm25Weight: number,
  limit: number,
): ChunkRow[] {
  const normalizedVector = normalizeScores(vectorRows, true);
  const normalizedBm25 = normalizeScores(bm25Rows);
  const rows = new Map<number, { row: ChunkRow; vector?: number; bm25?: number; order: number }>();
  vectorRows.forEach((item, index) => {
    rows.set(item.row.id, { row: item.row, vector: normalizedVector[index], order: index });
  });
  bm25Rows.forEach((item, index) => {
    const existing = rows.get(item.row.id);
    if (existing) existing.bm25 = normalizedBm25[index];
    else rows.set(item.row.id, { row: item.row, bm25: normalizedBm25[index], order: vectorRows.length + index });
  });
  return [...rows.values()]
    .map((item) => ({
      ...item,
      combined: vectorWeight * (item.vector ?? 0) + bm25Weight * (item.bm25 ?? 0),
    }))
    .sort((left, right) => right.combined - left.combined || left.order - right.order)
    .slice(0, limit)
    .map((item) => ({
      ...item.row,
      distance: 1 - item.combined,
      searchChannel: item.bm25 !== undefined && bm25Weight > 0
        ? item.vector !== undefined && vectorWeight > 0 ? "hybrid" : "bm25"
        : "hybrid",
    }));
}

function searchVectorDb(
  dbPath: string,
  queryVector: number[],
  k: number,
  hybrid?: HybridSearchOptions,
  warnings: string[] = [],
): ChunkRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
    const hasEmbeddingTable = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'`)
      .get() as { ok: number } | undefined;
    if (!hasEmbeddingTable) {
      throw new Error("向量库缺少 chunk_embeddings 表（可能尚未完成向量化或索引已损坏）");
    }
    const indexDim = readIndexDimension(db);
    if (indexDim !== null && indexDim !== queryVector.length) {
      throw new Error(
        `向量索引维度 ${indexDim} 与当前嵌入模型维度 ${queryVector.length} 不一致：请在 SageRead 中对该库重建向量索引`,
      );
    }
    const hasReferencesColumn = (db.prepare("PRAGMA table_info(document_chunks)").all() as { name: string }[])
      .some((column) => column.name === "is_references");
    const excludeReferences = hybrid ? !hybrid.includeReferences : false;
    if (excludeReferences && !hasReferencesColumn) {
      warnings.push("旧向量库缺少 is_references 列：无法排除索引参考文献，已保留全部索引命中并继续关键词回退");
    }
    const referenceFilter = excludeReferences && hasReferencesColumn ? " AND dc.is_references = 0" : "";
    const candidateLimit = hybrid ? k * 2 : k;
    const vectorRows = hybrid?.vectorWeight === 0
      ? []
      : (db
          .prepare(
            `SELECT dc.*, ce.distance FROM chunk_embeddings ce
             JOIN document_chunks dc ON dc.id = ce.chunk_id
             WHERE ce.embedding MATCH ? AND k = ?${referenceFilter}`,
          )
          .all(JSON.stringify(queryVector), candidateLimit) as ChunkRow[]);
    if (!hybrid) return vectorRows;
    const scoredVector = vectorRows.map((row) => ({ row, score: 1 - row.distance }));
    const scoredBm25 = hybrid.bm25Weight === 0
      ? []
      : searchBm25(db, hybrid.query, candidateLimit, excludeReferences && hasReferencesColumn);
    return combineHybrid(scoredVector, scoredBm25, hybrid.vectorWeight, hybrid.bm25Weight, k);
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
  vectorWeight?: number;
  bm25Weight?: number;
  includeReferences?: boolean;
  strict?: boolean;
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
  /** 跨库检索时被跳过的不可用向量库（单库损坏不影响其它库返回） */
  警告?: string[];
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
      ? { 上下文提示: `get_chunk_context(id='${id}', chunk_order=${row.chunk_order_in_file})` }
      : {}),
  };
}

export interface IndexedChunk {
  row: ChunkRow;
  fallbackBookId?: string;
}

export interface SearchIndexedResult {
  chunks: IndexedChunk[];
  warnings: string[];
}

export async function searchIndexed(
  appDir: string,
  options: SemanticSearchOptions,
): Promise<SearchIndexedResult> {
  const { query, scope, paperId, paperIds, bookId, topK } = options;

  // I2：嵌入经 SageRead 本地通道（app 用自己的 keyring 密钥执行，本进程不碰密钥）；
  // app 未运行/向量模型未配置时 embedViaApp 抛带引导的降级错误
  const queryVector = await embedViaApp(appDir, query);

  const rows: { row: ChunkRow; fallbackBookId?: string }[] = [];
  // 跨库检索时单个库不可用（空库/维度不一致等）只跳过并记录，不让整次检索失败
  const warnings: string[] = [];
  const hybrid = options.vectorWeight != null || options.bm25Weight != null || options.includeReferences != null
    ? {
        query,
        vectorWeight: options.vectorWeight ?? 0.7,
        bm25Weight: options.bm25Weight ?? 0.3,
        includeReferences: options.includeReferences ?? false,
      }
    : undefined;

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
      try {
        const needFilter = paperId !== undefined || paperIds !== undefined;
        const k = needFilter ? Math.max(topK * 10, 100) : topK;
        let found = searchVectorDb(papersDb, queryVector, k, hybrid, warnings);
        if (paperIds !== undefined) {
          const set = new Set(paperIds);
          found = found.filter((r) => r.paper_id !== null && set.has(r.paper_id));
        }
        if (paperId) found = found.filter((r) => r.paper_id === paperId);
        if (needFilter) found = found.slice(0, topK);
        rows.push(...found.map((row) => ({ row })));
      } catch (err) {
        // 只查论文库时保持原行为（明确报错）；跨库（all）时论文库坏了仍返回书籍结果
        if (scope === "papers" || options.strict) throw err;
        warnings.push(`论文库检索失败，已跳过：${err instanceof Error ? err.message : String(err)}`);
      }
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
      try {
        const found = searchVectorDb(dbPath, queryVector, topK, hybrid, warnings);
        rows.push(...found.map((row) => ({ row, fallbackBookId: dir })));
      } catch (err) {
        // 显式指定单本书时保持明确报错；枚举书库/跨库时跳过坏库并继续
        if (bookId || options.strict) throw err;
        warnings.push(`书籍 ${dir} 的向量库检索失败，已跳过：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!anyDb && scope === "books" && !bookId) {
      throw new Error("没有任何书籍的向量库：请先在 SageRead 里对书籍执行向量化后再试");
    }
  }

  rows.sort((a, b) => a.row.distance - b.row.distance);
  return { chunks: rows.slice(0, topK), warnings };
}

export async function semanticSearch(
  appDir: string,
  options: SemanticSearchOptions,
): Promise<SemanticSearchResult> {
  const result = await searchIndexed(appDir, { ...options, strict: true });
  const items = result.chunks.map(({ row, fallbackBookId }, index) => toItem(row, index + 1, fallbackBookId));
  return {
    查询: options.query,
    范围: options.scope,
    结果数: items.length,
    结果: items,
  };
}
