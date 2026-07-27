/**
 * 数据库路径解析与只读连接。
 * 优先级：SAGEREAD_DB_PATH > --dev / SAGEREAD_DEV=1 > 发行版默认路径
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ID_RELEASE = "com.xincmm.sageread";
const APP_ID_DEV = "com.xincmm.sageread.dev";

export function resolveDbPath(argv: string[] = process.argv.slice(2)): {
  dbPath: string;
  mode: "release" | "dev" | "custom";
} {
  const envPath = process.env.SAGEREAD_DB_PATH;
  if (envPath && envPath.trim()) {
    return { dbPath: path.resolve(envPath.trim()), mode: "custom" };
  }
  const devFlag =
    argv.includes("--dev") ||
    process.env.SAGEREAD_DEV === "1" ||
    process.env.SAGEREAD_DEV === "true";
  const appId = devFlag ? APP_ID_DEV : APP_ID_RELEASE;
  // Windows: %APPDATA% = ~/AppData/Roaming
  const dbPath = path.join(os.homedir(), "AppData", "Roaming", appId, "database", "app.db");
  return { dbPath, mode: devFlag ? "dev" : "release" };
}

let db: Database.Database | null = null;

/** 懒加载只读连接；文件不存在时抛出带说明的错误（由调用方转成结构化错误返回） */
export function getDb(): Database.Database {
  if (db) return db;
  const { dbPath, mode } = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `数据库文件不存在: ${dbPath}（模式: ${mode}）。` +
        `可设置 SAGEREAD_DB_PATH 指定路径，或用 --dev / SAGEREAD_DEV=1 切换开发版。`,
    );
  }
  // readonly + fileMustExist：任何写操作都会直接报错，保证不会写坏 SageRead 数据库
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return db;
}
