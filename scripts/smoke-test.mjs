/**
 * 冒烟测试：以 stdio JSON-RPC 与 sageread-mcp 对话
 * 流程：initialize → notifications/initialized → tools/list → 调用 list_books / get_reading_stats / list_threads / get_thread
 * 用法：node scripts/smoke-test.mjs [--dev]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const useDev = process.argv.includes("--dev") || true; // 默认测开发版库
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

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`超时: ${method}`)), 10000);
  });
}

function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args }).then((res) => {
    const text = res.result?.content?.[0]?.text ?? "(无内容)";
    return text;
  });
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

const books = await callTool("list_books", {});
console.log("\n===== list_books（截断）=====\n" + books.slice(0, 600));

const stats = await callTool("get_reading_stats", { period: "week" });
console.log("\n===== get_reading_stats(week) =====\n" + stats);

const threads = await callTool("list_threads", {});
console.log("\n===== list_threads（截断）=====\n" + threads.slice(0, 500));

const firstId = JSON.parse(threads)[0]?.id;
if (firstId) {
  const thread = await callTool("get_thread", { threadId: firstId });
  console.log("\n===== get_thread（截断）=====\n" + thread.slice(0, 500));
}

const starred = await callTool("list_threads", { starred_only: true });
console.log("\n===== list_threads(starred_only) =====\n" + starred.slice(0, 500));

child.kill();
console.log("\n✓ 冒烟测试完成");
process.exit(0);
