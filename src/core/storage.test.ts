import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, expect, it } from "vitest";
import { openAgentStorage } from "./storage.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
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
