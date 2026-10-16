import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CapabilityManager } from "../src/capabilities.js";

it("keeps pending removals reviewable after a stopped-agent refresh without leaking saved skill text credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-saved-view-"));
  const secret = "synthetic-private-fixture-value";
  mkdirSync(join(dir, ".agents/skills/research"), { recursive: true });
  writeFileSync(join(dir, ".agents/skills/research/SKILL.md"), `---\nname: research\ndescription: Read references\n---\nDo not expose ${secret}.\n`);
  writeFileSync(join(dir, ".mcp.env"), `SOURCE_TOKEN='${secret}'\n`, { mode: 0o600 });
  const options = { agentDir: dir, env: "local", active: false, activate: async () => {} };
  let manager = new CapabilityManager(options);
  try {
    const initial = await manager.view();
    await manager.command("skill", { revision: initial.revision, name: "research", operation: "remove" });
    await manager.close();
    manager = new CapabilityManager(options);
    const refreshed = await manager.view();
    expect(refreshed.activeRevision).toBeNull();
    expect(refreshed.activeSkills).toEqual([]);
    expect(refreshed.skills).toEqual([]);
    expect(refreshed.savedSkills?.map(({ name }) => name)).toEqual(["research"]);
    expect(JSON.stringify(refreshed)).not.toContain(secret);
    expect(refreshed.savedSkills?.[0]?.files[0]?.text).toContain("[redacted]");
    const restored = await manager.command("discard-item", { revision: refreshed.revision, kind: "skill", name: "research" });
    expect(restored.pending).toBe(false);
    expect(restored.skills.map(({ name }) => name)).toEqual(["research"]);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
