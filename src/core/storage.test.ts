import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CleanupError } from "./cleanup-error.js";
import { openAgentStorage } from "./storage.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
it("marks cleanup failure when storage initialization never returns a handle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-storage-cleanup-"));
  dirs.push(dir);
  const open = vi.spyOn(SqliteStorage, "open").mockRejectedValueOnce(new Error("initialization failed"));
  const original = DatabaseSync.prototype.close;
  const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function (this: DatabaseSync) {
    original.call(this);
    throw new Error("database close failed");
  });
  try { await expect(openAgentStorage(join(dir, "state.sqlite"))).rejects.toBeInstanceOf(CleanupError); }
  finally { close.mockRestore(); open.mockRestore(); }
});

it("rejects competing owners and releases ownership on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-storage-"));
  dirs.push(dir);
  const first = await openAgentStorage(join(dir, "state.sqlite"));
  try {
    await expect(openAgentStorage(join(dir, "state.sqlite"))).rejects.toThrow(/already owned/);
  } finally {
    await first.close(BACKGROUND_CONTEXT);
  }
  const reopened = await openAgentStorage(join(dir, "state.sqlite"));
  await reopened.close(BACKGROUND_CONTEXT);
});
