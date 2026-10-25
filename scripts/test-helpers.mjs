import { spawn } from "node:child_process";
import http from "node:http";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createFixtureApp() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sageread-mcp-test-"));
  const appDir = path.join(tempRoot, "app");
  const databaseDir = path.join(appDir, "database");
  fs.mkdirSync(databaseDir, { recursive: true });
  const dbPath = path.join(databaseDir, "app.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT DEFAULT '',
      format TEXT NOT NULL,
      language TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      tags TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      trashed_at INTEGER
    );
    CREATE TABLE book_status (
      book_id TEXT PRIMARY KEY,
      status TEXT,
      progress_current INTEGER,
      progress_total INTEGER,
      last_read_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      dwell_seconds INTEGER
    );
    CREATE TABLE threads (id TEXT PRIMARY KEY, starred INTEGER DEFAULT 0, scope TEXT DEFAULT 'book');
    CREATE TABLE book_notes (starred INTEGER DEFAULT 0, category TEXT, source TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, trashed_at INTEGER, updated_at INTEGER DEFAULT 0);
    CREATE TABLE paper_folders (paper_id TEXT, folder_id TEXT);
  `);
  return {
    appDir,
    dbPath,
    db,
    addBook({ id, title = id, format = "MARKDOWN", author = "" }) {
      db.prepare("INSERT INTO books (id, title, author, format) VALUES (?, ?, ?, ?)").run(id, title, author, format);
      fs.mkdirSync(path.join(appDir, "books", id), { recursive: true });
    },
    writeBookFile(id, name, content) {
      const target = path.join(appDir, "books", id, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    close() {
      if (db.open) db.close();
    },
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export class McpClient {
  constructor(dbPath, env = {}) {
    this.child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, SAGEREAD_DB_PATH: dbPath, SAGEREAD_MCP_LEGACY_TOOLS: "0", ...env },
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.closing = false;
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (!this.closing) this.rejectAll(new Error(`MCP server exited early: ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  rpc(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize() {
    const response = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1.0.0" },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return response;
  }

  async callTool(name, args, timeoutMs) {
    const response = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    return {
      text: response.result?.content?.[0]?.text ?? response.error?.message ?? "(无内容)",
      isError: response.result?.isError === true || Boolean(response.error),
      raw: response,
    };
  }

  async close() {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill();
    await exited;
  }
}

export function toolJson(response) {
  return JSON.parse(response.text);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeZip(file, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(20, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...localParts, ...centralParts, end]));
}

export function writeEpubFixture(app, id, sections) {
  app.addBook({ id, title: id, format: "EPUB" });
  const manifest = sections
    .map((section, index) => `<item id="s${index}" href="${section.id}" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = sections.map((_, index) => `<itemref idref="s${index}"/>`).join("");
  const navItems = sections
    .flatMap((section) => section.nav ?? [{ href: `${section.id}#chapter`, label: section.label }])
    .map((entry) => `<li><a href="${entry.href}">${entry.label}</a></li>`)
    .join("");
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>${manifest}</manifest><spine>${spine}</spine></package>`,
    "OEBPS/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navItems}</ol></nav></body></html>`,
  };
  for (const section of sections) {
    entries[`OEBPS/${section.id}`] = `<html xmlns="http://www.w3.org/1999/xhtml"><body>${section.body}</body></html>`;
  }
  Object.assign(entries, ...sections.map((section) => section.entries ?? {}));
  writeZip(path.join(app.appDir, "books", id, "book.epub"), entries);
}

export function createVectorDb(file, { referencesColumn = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY,
      book_title TEXT,
      book_author TEXT,
      paper_id TEXT,
      md_file_path TEXT,
      file_order_in_book INTEGER,
      related_chapter_titles TEXT,
      chunk_text TEXT,
      chunk_order_in_file INTEGER,
      total_chunks_in_file INTEGER,
      global_chunk_index INTEGER,
      created_at TEXT
      ${referencesColumn ? ", is_references INTEGER DEFAULT 0" : ""}
    );
    CREATE VIRTUAL TABLE chunk_embeddings USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[2]
    );
  `);
  return db;
}

export function addVectorChunk(db, chunk) {
  const columns = new Set(db.prepare("PRAGMA table_info(document_chunks)").all().map((column) => column.name));
  const inserted = db.prepare("INSERT INTO chunk_embeddings (embedding) VALUES (?)").run(
    JSON.stringify(chunk.vector ?? [1, 0]),
  );
  const id = Number(inserted.lastInsertRowid);
  const row = {
    id,
    book_title: chunk.book_title ?? "Fixture",
    book_author: chunk.book_author ?? "Author",
    paper_id: chunk.paper_id ?? "",
    md_file_path: chunk.md_file_path ?? "paper.md",
    file_order_in_book: chunk.file_order_in_book ?? 0,
    related_chapter_titles: chunk.related_chapter_titles ?? "",
    chunk_text: chunk.chunk_text,
    chunk_order_in_file: chunk.chunk_order_in_file ?? 0,
    total_chunks_in_file: chunk.total_chunks_in_file ?? 1,
    global_chunk_index: chunk.global_chunk_index ?? chunk.id ?? id,
    created_at: chunk.created_at ?? "2026-01-01",
    ...(columns.has("is_references") ? { is_references: chunk.is_references ? 1 : 0 } : {}),
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO document_chunks (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(
    ...names.map((name) => row[name]),
  );
  return id;
}

export async function startEmbedChannel(appDir, vector = [1, 0]) {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/embed" || request.headers.authorization !== "Bearer test-token") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const query = JSON.parse(body || "{}").text ?? "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ vector: typeof vector === "function" ? vector(query) : vector }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(appDir, "mcp-local.json"), JSON.stringify({ port, token: "test-token" }));
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
