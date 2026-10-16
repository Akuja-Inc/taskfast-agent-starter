import { mkdirSync, realpathSync, chmodSync, existsSync, closeSync, openSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { CleanupError } from "./cleanup-error.js";

// An independent rollback-mode database holds an OS lock for the entire ownership
// lifetime. SQLite releases it on process death; there is no stale PID file to repair.
// Do not remove either database while running, or copy a live store.
export async function openAgentStorage(file: string): Promise<Storage> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const requested = join(realpathSync(dirname(file)), basename(file));
  const path = existsSync(requested) ? realpathSync(requested) : requested;
  if (existsSync(path) && statSync(path).nlink !== 1) throw new Error("agent stores must not be hard linked");
  const owner = new DatabaseSync(`${path}.owner`);
  const closeOwner = () => { try { owner.close(); } catch (error) { throw new CleanupError(error); } };
  try {
    owner.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  } catch (error) {
    closeOwner();
    throw new Error(`agent store is already owned: ${path}`, { cause: error });
  }
  try {
    chmodSync(`${path}.owner`, 0o600);
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    chmodSync(path, 0o600); // SQLite sidecars inherit these permissions.
    const database = await openNodeSqliteDatabase(path);
    let storage: SqliteStorage;
    try {
      await database.exec("PRAGMA synchronous=FULL");
      storage = await SqliteStorage.open(database);
      chmodSync(path, 0o600);
    } catch (error) {
      try { await database.close(); } catch (cleanup) { throw new CleanupError(cleanup); }
      throw error;
    }
    let closed = false;
    // Retain the backend's methods/prototypes without replacing its implementation.
    return new Proxy(storage, {
      get(target, key) {
        if (key === "close") return async (context: Parameters<Storage["close"]>[0]) => {
          if (closed) return;
          closed = true;
          try { await target.close(context); }
          finally { closeOwner(); }
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } catch (error) {
    closeOwner();
    throw error;
  }
}
