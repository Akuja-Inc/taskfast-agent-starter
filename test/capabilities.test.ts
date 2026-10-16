import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilityManager, recoverCapabilities } from "../src/capabilities.js";
import type { CapabilityActivation } from "../src/capability-types.js";
import { loadSkills } from "../src/core/skills.js";
import { loadMcpConfig } from "../src/core/mcp-config.js";
import { FIXTURE, approve, expectGone } from "./mcp-fixture.js";

const dirs: string[] = [];
const managers: CapabilityManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function folder() { const dir = mkdtempSync(join(tmpdir(), "capabilities-")); dirs.push(dir); return dir; }
function manager(dir = folder(), activate: (options: CapabilityActivation) => Promise<void> = async ({ publish }) => { await publish(); }) {
  const m = new CapabilityManager({ agentDir: dir, env: "staging", activate }); managers.push(m); return m;
}
const files = [{ path: "sample/SKILL.md", text: "---\nname: sample\ndescription: A sample skill\n---\nGuidance only." }];
async function cmd(m: CapabilityManager, action: string, body: Record<string, unknown> = {}) {
  return m.command(action, { revision: (await m.view()).revision, ...body });
}
it("stages a validated import privately, persists drafts across restart, then publishes", async () => {
  const dir = folder(); const m = manager(dir);
  const initial = await m.view();
  const staged = await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  expect(staged.skills[0]?.name).toBe("sample"); expect(staged.pending).toBe(true);
  expect(loadSkills(dir)).toEqual([]);
  await m.close();
  const reopened = manager(dir); expect((await reopened.view()).skills).toEqual(staged.skills);
  const waiting = await cmd(reopened, "apply", { requestId: "first" });
  expect(waiting.apply.state).toBe("waiting");
  await vi.waitFor(async () => expect((await reopened.view()).apply.state).toBe("succeeded"));
  expect(loadSkills(dir)[0]?.name).toBe("sample");
  expect((await reopened.view()).activeRevision).not.toBe(initial.revision);
});
it.each(["../sample/SKILL.md", "/sample/SKILL.md", "sample/.env", "sample/reference/../../SKILL.md", "sample/a\\b.md", "sample/run.sh"])("rejects private, executable or nonrelative imports: %s", async (path) => {
  const m = manager(); await expect(cmd(m, "stage-skill", { files: [...files, { path, text: "private" }], replace: false, enabled: true })).rejects.toThrow();
  expect((await m.view()).pending).toBe(false);
});
it("validates frontmatter, duplicate paths and replacement intent", async () => {
  const m = manager();
  await expect(cmd(m, "stage-skill", { files: [{ path: "sample/SKILL.md", text: "bad" }], replace: false, enabled: true })).rejects.toThrow();
  await expect(cmd(m, "stage-skill", { files: [...files, ...files], replace: false, enabled: true })).rejects.toThrow();
  await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  await expect(cmd(m, "stage-skill", { files, replace: false, enabled: true })).rejects.toThrow(/replace/i);
});
it("disables skills without deleting them and validates disabled installed content", async () => {
  const dir = folder(); const m = manager(dir);
  await cmd(m, "stage-skill", { files, replace: false, enabled: false });
  await cmd(m, "apply", { requestId: "disable" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
  expect(loadSkills(dir)).toEqual([]); expect(existsSync(join(dir, ".agents/skills/sample/SKILL.md"))).toBe(true);
  writeFileSync(join(dir, ".agents/skills/sample/SKILL.md"), "invalid");
  expect(() => loadSkills(dir)).toThrow(/frontmatter/);
});
it("requires revision and detects manual edits while retaining draft", async () => {
  const dir = folder(); const m = manager(dir); const original = await m.view();
  await expect(m.command("discard", {})).rejects.toMatchObject({ status: 409 });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers: {} }));
  await expect(m.command("apply", { revision: original.revision, requestId: "stale" })).rejects.toMatchObject({ status: 409 });
  expect((await m.view()).pending).toBe(true);
});
it("connection tests require consent, close discovery clients, and never approve hints implicitly", async () => {
  const dir = folder(); const m = manager(dir); const pid = join(dir, "pid");
  const config = { command: process.execPath, args: [FIXTURE], env: { FIXTURE_PIDFILE: "PID" } };
  await expect(cmd(m, "test", { name: "docs", config, secrets: { PID: pid } })).rejects.toThrow(/consent/i);
  const view = await cmd(m, "test", { name: "docs", config, secrets: { PID: pid }, consent: true });
  expect(view.test?.tools.find((t) => t.name === "delete")?.blocked).toBe(true);
  await expectGone(Number(readFileSync(pid, "utf8")));
  await expect(cmd(m, "server", { name: "docs", config, secrets: { PID: pid }, enabled: true, testId: view.test!.testId, approved: [{ name: "search", hash: approve("search") }] })).rejects.toThrow(/read/i);
  await cmd(m, "server", { name: "docs", config, secrets: { PID: pid }, enabled: false, testId: view.test!.testId, approved: [{ name: "search", hash: approve("search"), read: true }] });
  await cmd(m, "apply", { requestId: "server" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
  expect(loadMcpConfig(dir)).toEqual([]);
});
it("stores credentials privately, shows names only and refuses unused test approvals", async () => {
  const dir = folder(); const m = manager(dir); const secret = "private-token-567";
  const config = { command: process.execPath, args: [FIXTURE], env: { DOCS_TOKEN: "TOKEN" } };
  const tested = await cmd(m, "test", { name: "docs", config, secrets: { TOKEN: secret }, consent: true });
  const staged = await cmd(m, "server", { name: "docs", config, secrets: { TOKEN: secret }, enabled: true, testId: tested.test!.testId, approved: [{ name: "search", hash: approve("search"), read: true }] });
  expect(JSON.stringify(staged)).not.toContain(secret); expect(staged.credentials).toEqual(["TOKEN"]);
  expect(statSync(join(dir, ".capabilities/pending.json")).mode & 0o777).toBe(0o600);
  await expect(cmd(m, "remove-credential", { name: "TOKEN" })).rejects.toThrow(/used/i);
  await expect(cmd(m, "server", { name: "docs", config: { ...config, args: [FIXTURE, secret] }, secrets: { TOKEN: secret }, enabled: true, testId: tested.test!.testId, approved: [] })).rejects.toThrow();
  await cmd(m, "apply", { requestId: "secret" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
  expect(statSync(join(dir, ".mcp.env")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, "mcp.json"), "utf8")).not.toContain(secret);
});
it.each([
  { name: "private-token", config: { url: "https://example.com/mcp" }, secret: "private-token" },
  { name: "docs", config: { url: "https://example.com/mcp", headers: { "private-token": "TOKEN" } }, secret: "private-token" },
  { name: "docs", config: { command: process.execPath, args: [FIXTURE, 'sec\"ret'] }, secret: 'sec\"ret' },
  { name: "docs", config: { url: "https://example.com/private%2Ftoken" }, secret: "private/token" },
])("rejects credentials in any public server field without echoing them", async ({ name, config, secret }) => {
  const m = manager();
  const error = await cmd(m, "server", { name, config, secrets: { TOKEN: secret }, enabled: false, approved: [] }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(secret);
  expect((await m.view()).pending).toBe(false);
});
it("returns waiting promptly, retries request IDs once and only cancels waiting", async () => {
  let release: () => void = () => {}; let calls = 0;
  const m = manager(folder(), async ({ publish }) => { calls++; await new Promise<void>((resolve) => { release = resolve; }); await publish(); });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  const body = { revision: (await m.view()).revision, requestId: "waiting" };
  expect((await m.command("apply", body)).apply.state).toBe("waiting");
  await vi.waitFor(() => expect(calls).toBe(1));
  expect((await m.command("apply", body)).apply.state).toBe("waiting");
  await cmd(m, "cancel", { requestId: "waiting" }); release();
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("cancelled"));
  expect((await m.view()).pending).toBe(true);
});
it("persists successful request receipts and never repeats activation after restart", async () => {
  const dir = folder(); let calls = 0;
  const activate = async ({ publish }: { publish: () => Promise<void> }) => { calls++; await publish(); };
  const m = manager(dir, activate); await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  const body = { revision: (await m.view()).revision, requestId: "durable-retry" };
  await m.command("apply", body); await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
  await m.close(); const reopened = manager(dir, activate);
  expect((await reopened.command("apply", body)).apply.state).toBe("succeeded"); expect(calls).toBe(1);
  await expect(reopened.command("apply", { ...body, revision: (await reopened.view()).revision })).rejects.toMatchObject({ status: 409 });
});
it("cannot cancel publication and close waits for activation to finish without aborting it", async () => {
  const dir = folder(); let finish: () => void = () => {}; let aborted = false;
  const m = manager(dir, async ({ publish, signal }: { publish: () => Promise<void>; signal?: AbortSignal }) => {
    await publish(); await new Promise<void>((resolve) => { finish = resolve; }); aborted = signal?.aborted ?? false;
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: "publishing" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("applying"));
  await expect(cmd(m, "cancel", { requestId: "publishing" })).rejects.toMatchObject({ status: 409 });
  let closed = false; const closing = m.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  finish(); await closing; expect(aborted).toBe(false); expect(loadSkills(dir)[0]?.name).toBe("sample");
});
it("runs afterCommit only after the reviewed configuration and successful receipt are durable and the journal is removed", async () => {
  const dir = folder(); let callbackRan = false;
  const m = manager(dir, async ({ publish, afterCommit }) => {
    await publish();
    expect(JSON.parse(readFileSync(join(dir, ".capabilities/journal.json"), "utf8")).phase).toBe("publishing");
    afterCommit(async () => {
      expect(loadSkills(dir)[0]?.files.get("SKILL.md")).toBe(files[0]!.text);
      const receipt = JSON.parse(readFileSync(join(dir, ".capabilities/pending.json"), "utf8"));
      expect(receipt.requests.handshake.result).toEqual({ state: "succeeded", requestId: "handshake" });
      expect(existsSync(join(dir, ".capabilities/journal.json"))).toBe(false);
      callbackRan = true;
    });
    expect(callbackRan).toBe(false);
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: "handshake" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded")); expect(callbackRan).toBe(true);
});
it.each(["failed-open", "duplicate-registration", "publication-conflict"])("does not run afterCommit before commit on %s", async (failure) => {
  const dir = folder(); let callbacks = 0; const failures: boolean[] = [];
  const m = manager(dir, async ({ publish, afterCommit }) => {
    afterCommit(async () => { callbacks++; }, async (restored) => {
      failures.push(restored); expect(loadSkills(dir)).toEqual([]);
    });
    if (failure === "duplicate-registration") afterCommit(async () => { callbacks++; });
    if (failure === "publication-conflict") writeFileSync(join(dir, "mcp.json"), '{"servers":{}}');
    await publish(); throw new Error("open failed");
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: failure });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("failed"));
  expect(callbacks).toBe(0); expect(failures).toEqual([failure !== "publication-conflict"]);
  expect(loadSkills(dir)).toEqual([]); expect((await m.view()).pending).toBe(true);
});
it("cleans a dormant replacement on private commit persistence failure without releasing scheduling", async () => {
  const dir = folder(); let callbacks = 0; const failures: boolean[] = [];
  const m = manager(dir, async ({ publish, afterCommit }) => {
    await publish();
    const path = join(dir, ".capabilities/pending.json"); const previous = readFileSync(path, "utf8");
    afterCommit(async () => { callbacks++; }, async (restored) => {
      failures.push(restored); rmSync(path, { recursive: true }); writeFileSync(path, previous, { mode: 0o600 });
    });
    // Fail the receipt's atomic rename after the dormant opener returned.
    rmSync(path); mkdirSync(path);
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: "receipt-failure" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("failed"));
  expect(callbacks).toBe(0); expect(failures).toEqual([false]); expect((await m.view()).activeRevision).toBeNull();
  expect(loadSkills(dir)).toEqual([]); expect(existsSync(join(dir, ".capabilities/journal.json"))).toBe(true);
});
it("never rolls back committed configuration if afterCommit fails, and preserves a truthful stopped receipt across restart", async () => {
  const dir = folder(); let failures = 0;
  const m = manager(dir, async ({ publish, rollback, afterCommit }) => {
    await publish(); afterCommit(async () => { await rollback(); throw new Error("private scheduler failure"); }, async () => { failures++; });
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); const body = { revision: (await m.view()).revision, requestId: "committed-stop" };
  await m.command("apply", body);
  await vi.waitFor(async () => expect((await m.view()).apply).toMatchObject({ state: "failed", error: expect.stringMatching(/committed.*stopped/i) }));
  expect(loadSkills(dir)[0]?.name).toBe("sample"); expect((await m.view()).activeRevision).toBeNull(); expect((await m.view()).pending).toBe(false); expect(failures).toBe(0);
  expect(existsSync(join(dir, ".capabilities/journal.json"))).toBe(false); await m.close();
  const reopened = manager(dir); expect((await reopened.command("apply", body)).apply).toMatchObject({ state: "failed", requestId: "committed-stop" });
});
it("rolls back failed activation, preserves modes and keeps pending changes", async () => {
  const dir = folder(); writeFileSync(join(dir, "mcp.json"), '{"servers":{}}'); chmodSync(join(dir, "mcp.json"), 0o640);
  const m = manager(dir, async ({ publish }) => { await publish(); throw new Error("private failure"); });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  await cmd(m, "apply", { requestId: "fail" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("failed"));
  expect(loadSkills(dir)).toEqual([]); expect((await m.view()).pending).toBe(true);
  expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe('{"servers":{}}');
  expect(statSync(join(dir, "mcp.json")).mode & 0o777).toBe(0o640);
});
it("stages the captured CLI bundle through an isolated real export subprocess with provenance", async () => {
  const bin = folder(); const dir = folder(); const m = manager(dir);
  const bundle = join(import.meta.dirname, "fixtures/cli/skills/taskfast-agent");
  const log = join(bin, "export.json");
  writeFileSync(join(bin, "taskfast"), `#!${process.execPath}\nimport { cpSync, mkdirSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log('taskfast 0.19.7-fixture');\nelse { cpSync(${JSON.stringify(bundle)}, '.agents/skills/taskfast-agent', { recursive: true }); mkdirSync('.taskfast'); writeFileSync('.taskfast/config.json', 'must not publish'); writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env })); }\n`, { mode: 0o700 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`; process.env.CAPABILITY_TEST_HOST_SECRET = "never-inherit";
  try {
    const previewed = await cmd(m, "preview-taskfast");
    expect(previewed.pending).toBe(false); expect(previewed.skillPreview?.skill.name).toBe("taskfast-agent");
    const previewId = previewed.skillPreview!.previewId;
    await cmd(m, "stage-skill", { files, replace: false, enabled: true });
    await expect(cmd(m, "taskfast-skill", { replace: false, enabled: true, previewId })).rejects.toMatchObject({ status: 409 });
    await cmd(m, "discard-item", { kind: "skill", name: "sample" });
    expect((await m.view()).pending).toBe(false);
    writeFileSync(join(bin, "taskfast"), `#!${process.execPath}\nprocess.exit(9);\n`);
    const staged = await cmd(m, "taskfast-skill", { replace: false, enabled: true, previewId });
    expect(staged.skills[0]).toMatchObject({ name: "taskfast-agent", provenance: { source: "taskfast-cli", version: "0.19.7-fixture" } });
    expect(staged.skills[0]!.files.some((file) => file.path === "reference/WORKER.md")).toBe(true);
    expect(staged.skills[0]!.provenance!.files["SKILL.md"]).toMatch(/^[a-f0-9]{64}$/);
    expect(staged.skills[0]!.modifiedFiles).toEqual([]);
    const invocation = JSON.parse(readFileSync(log, "utf8"));
    expect(invocation.args).toContain("staging"); expect(invocation.args).toContain("--no-trace");
    expect(invocation.env.CAPABILITY_TEST_HOST_SECRET).toBeUndefined(); expect(invocation.env.TASKFAST_CONFIG).toBeUndefined();
    expect(existsSync(join(dir, ".taskfast"))).toBe(false); expect(loadSkills(dir)).toEqual([]);
    await cmd(m, "apply", { requestId: "cli" });
    await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
    const skillPath = join(dir, ".agents/skills/taskfast-agent/SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf8") + "\nOwner edit.\n");
    expect((await m.view()).skills[0]!.modifiedFiles).toEqual(["SKILL.md"]);
    expect((await m.view()).activeSkills[0]!.modifiedFiles).toEqual([]);
    expect((await m.view()).pending).toBe(false);
  } finally { process.env.PATH = path; delete process.env.CAPABILITY_TEST_HOST_SECRET; }
});
it("rejects garbage CLI version output rather than recording false provenance", async () => {
  const bin = folder(); const m = manager();
  writeFileSync(join(bin, "taskfast"), `#!${process.execPath}\nconsole.log('not a taskfast version');\n`, { mode: 0o700 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try { await expect(cmd(m, "taskfast-skill", { replace: false, enabled: true })).rejects.toThrow(/version/i); expect((await m.view()).pending).toBe(false); }
  finally { process.env.PATH = path; }
});
it("rejects malformed CLI exports without publishing private files or a partial draft", async () => {
  const bin = folder(); const m = manager();
  writeFileSync(join(bin, "taskfast"), `#!${process.execPath}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log('taskfast fixture'); else { mkdirSync('.agents/skills/taskfast-agent', { recursive: true }); writeFileSync('.agents/skills/taskfast-agent/SKILL.md', 'broken'); }\n`, { mode: 0o700 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try { await expect(cmd(m, "taskfast-skill", { replace: false, enabled: true })).rejects.toThrow(); expect((await m.view()).pending).toBe(false); }
  finally { process.env.PATH = path; }
});
it("rejects stale concurrent edits to the staged draft, without losing the first edit", async () => {
  const m = manager(); const original = await m.view();
  await m.command("stage-skill", { revision: original.revision, files, replace: false, enabled: true });
  await expect(m.command("server", { revision: original.revision, name: "offline", config: { url: "https://offline.example/mcp" }, enabled: false, approved: [] })).rejects.toMatchObject({ status: 409 });
  expect((await m.view()).skills[0]?.name).toBe("sample");
});
it("saves an offline disabled server without testing and requires reads to enable it", async () => {
  const m = manager();
  const staged = await cmd(m, "server", { name: "offline", config: { url: "https://offline.example/mcp", headers: { Authorization: "TOKEN" } }, enabled: false, approved: [] });
  expect(staged.servers[0]).toMatchObject({ name: "offline", enabled: false, approved: [] });
  const local = { command: process.execPath, args: [FIXTURE] };
  const tested = await cmd(m, "test", { name: "docs", config: local, consent: true });
  await expect(cmd(m, "server", { name: "docs", config: local, enabled: true, testId: tested.test!.testId, approved: [] })).rejects.toThrow(/at least one/i);
});
it("discards one skill's files and enabled state without losing another staged import", async () => {
  const m = manager(); await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: "base" });
  await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded"));
  await cmd(m, "stage-skill", { files: [{ path: "sample/SKILL.md", text: files[0]!.text + "\nReplacement." }], replace: true, enabled: false });
  await cmd(m, "stage-skill", { files: [{ path: "alternate/SKILL.md", text: "---\nname: alternate\ndescription: Another skill\n---\n" }], replace: false, enabled: false });
  const view = await cmd(m, "discard-item", { kind: "skill", name: "sample" });
  expect(view.skills.find((skill) => skill.name === "sample")).toMatchObject({ enabled: true, files: [{ path: "SKILL.md", text: files[0]!.text }] });
  expect(view.skills.find((skill) => skill.name === "alternate")?.enabled).toBe(false); expect(view.pending).toBe(true);
});
it("summarizes credential changes by name and discards individual items with dependency checks", async () => {
  const dir = folder(); writeFileSync(join(dir, ".mcp.env"), "TOKEN=original-token\nREMOVED=unused-old\n", { mode: 0o600 }); const m = manager(dir);
  await cmd(m, "server", { name: "offline", config: { url: "https://example.com/mcp", headers: { Authorization: "ADDED" } }, secrets: { TOKEN: "replaced-token", ADDED: "added-token" }, enabled: false, approved: [] });
  const view = await cmd(m, "remove-credential", { name: "REMOVED" });
  expect(view.credentialChanges).toEqual([{ name: "ADDED", change: "added" }, { name: "REMOVED", change: "removed" }, { name: "TOKEN", change: "replaced" }]);
  expect(JSON.stringify(view)).not.toMatch(/original-token|replaced-token|added-token|unused-old/);
  await expect(cmd(m, "discard-item", { kind: "credential", name: "ADDED" })).rejects.toThrow(/discard that server first/);
  await cmd(m, "discard-item", { kind: "server", name: "offline" });
  await cmd(m, "discard-item", { kind: "credential", name: "ADDED" });
  await cmd(m, "discard-item", { kind: "credential", name: "TOKEN" });
  const restored = await cmd(m, "discard-item", { kind: "credential", name: "REMOVED" });
  expect(restored.credentialChanges).toEqual([]); expect(restored.pending).toBe(false); expect(restored.servers).toEqual([]);
});
it("cleans only old bounded generated scratch trees and never follows their symlinks", () => {
  const dir = folder(); const privateDir = join(dir, ".capabilities"); mkdirSync(privateDir, { mode: 0o700 });
  const old = join(privateDir, "inspect-Ab1234"); const fresh = join(privateDir, "export-Cd5678");
  mkdirSync(old); mkdirSync(fresh); writeFileSync(join(old, "file.txt"), "scratch");
  const before = new Date(Date.now() - 25 * 60 * 60 * 1000); utimesSync(old, before, before);
  recoverCapabilities(dir); expect(existsSync(old)).toBe(false); expect(existsSync(fresh)).toBe(true);
  const target = folder(); writeFileSync(join(target, "keep"), "private"); symlinkSync(target, join(privateDir, "inspect-Zz1234"));
  expect(() => recoverCapabilities(dir)).toThrow(/symlink/); expect(readFileSync(join(target, "keep"), "utf8")).toBe("private");
});
it("keeps runtime snapshots separate from pending configuration and marks stopped safely", async () => {
  const m = manager(); await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  expect((await m.view()).activeSkills).toEqual([]);
  await cmd(m, "apply", { requestId: "snapshot" });
  await vi.waitFor(async () => expect((await m.view()).activeSkills[0]?.name).toBe("sample"));
  m.markStopped(); expect((await m.view()).activeRevision).toBeNull();
  await m.markActive(); expect((await m.view()).activeSkills[0]?.name).toBe("sample");
});
it("rolls back a durable partially published journal before runtime loaders and preserves the draft", async () => {
  const dir = folder(); const m = manager(dir);
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await m.close();
  const pending = JSON.parse(readFileSync(join(dir, ".capabilities/pending.json"), "utf8"));
  pending.requests.crash = { revision: pending.baseRevision, result: { state: "applying", requestId: "crash" } };
  writeFileSync(join(dir, ".capabilities/pending.json"), JSON.stringify(pending), { mode: 0o600 });
  const before = {}; const after = pending.snapshot;
  writeFileSync(join(dir, ".capabilities/journal.json"), JSON.stringify({ version: 1, before, after, phase: "publishing", requestId: "crash" }), { mode: 0o600 });
  mkdirSync(join(dir, ".agents/skills/sample"), { recursive: true });
  writeFileSync(join(dir, ".agents/skills/sample/SKILL.md"), files[0]!.text, { mode: 0o600 });
  recoverCapabilities(dir);
  expect(loadSkills(dir)).toEqual([]); expect(existsSync(join(dir, ".capabilities/journal.json"))).toBe(false);
  const reopened = manager(dir); expect((await reopened.view()).pending).toBe(true);
  expect((await reopened.view()).apply).toMatchObject({ state: "failed", requestId: "crash" });
});
it("fails closed rather than overwrite a manual edit during crash recovery", async () => {
  const dir = folder(); const m = manager(dir); await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await m.close();
  const pending = JSON.parse(readFileSync(join(dir, ".capabilities/pending.json"), "utf8"));
  writeFileSync(join(dir, ".capabilities/journal.json"), JSON.stringify({ version: 1, before: {}, after: pending.snapshot, phase: "publishing", requestId: "crash" }), { mode: 0o600 });
  writeFileSync(join(dir, "mcp.json"), '{"servers":{}}');
  expect(() => recoverCapabilities(dir)).toThrow(/conflict/i);
  expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe('{"servers":{}}');
  expect(existsSync(join(dir, ".capabilities/journal.json"))).toBe(true);
});
it("does not roll back a committed publication after a crash before journal removal", async () => {
  const dir = folder(); const m = manager(dir); await cmd(m, "stage-skill", { files, replace: false, enabled: true });
  await cmd(m, "apply", { requestId: "commit" }); await vi.waitFor(async () => expect((await m.view()).apply.state).toBe("succeeded")); await m.close();
  const pending = JSON.parse(readFileSync(join(dir, ".capabilities/pending.json"), "utf8"));
  writeFileSync(join(dir, ".capabilities/journal.json"), JSON.stringify({ version: 1, before: {}, after: pending.snapshot, phase: "committed", requestId: "commit" }), { mode: 0o600 });
  recoverCapabilities(dir); expect(loadSkills(dir)[0]?.name).toBe("sample");
});
it("leaves a truthful stopped state when rollback conflicts with a manual edit", async () => {
  const dir = folder(); const m = manager(dir, async ({ publish }) => {
    await publish(); writeFileSync(join(dir, "mcp.json"), '{"servers":{}}');
  });
  await cmd(m, "stage-skill", { files, replace: false, enabled: true }); await cmd(m, "apply", { requestId: "broken" });
  await vi.waitFor(async () => expect((await m.view()).apply).toMatchObject({ state: "failed", error: expect.stringMatching(/rollback failed/) }));
  expect((await m.view()).activeRevision).toBeNull();
  await expect(cmd(m, "discard")).rejects.toMatchObject({ status: 409 });
});
it("fails closed on symlinked private staging and configuration", async () => {
  const dir = folder(); const outside = folder(); symlinkSync(outside, join(dir, ".capabilities"));
  await expect(manager(dir).view()).rejects.toThrow();
  const other = folder(); mkdirSync(join(other, ".agents")); symlinkSync(outside, join(other, ".agents/skills"));
  await expect(manager(other).view()).rejects.toThrow();
});
