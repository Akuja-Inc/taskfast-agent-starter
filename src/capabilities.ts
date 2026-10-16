import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { folderFile } from "./core/folder.js";
import { loadSkills } from "./core/skills.js";
import { loadMcpConfig, parseMcpConfig, redact } from "./core/mcp-config.js";
import { discoverMcp } from "./core/mcp.js";
import type { CapabilityApply, CapabilityManagerOptions, CapabilityServer, CapabilityServerConfig, CapabilitySkill, CapabilityTest, CapabilityView } from "./capability-types.js";

export class CapabilityError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "CapabilityError"; }
}
interface FileImage { text: string; mode: number }
type Snapshot = Record<string, FileImage>;
interface Pending {
  version: 1; baseRevision: string; snapshot: Snapshot;
  requests: Record<string, { revision: string; result: CapabilityApply }>;
}
interface Journal { version: 1; before: Snapshot; after: Snapshot; requestId: string; phase: "publishing" | "committed" }
interface TestRecord { fingerprint: string; view: CapabilityTest }
interface SkillPreview { revision: string; snapshot: Snapshot; skill: CapabilitySkill }
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_FILE = 256 * 1024;
const PRIVATE = ".capabilities";
const PENDING = `${PRIVATE}/pending.json`;
const JOURNAL = `${PRIVATE}/journal.json`;
const managed = (path: string) => ["mcp.json", ".mcp.env", ".agents/provenance.json", ".agents/disabled-skills.json"].includes(path) || /^\.agents\/skills\/[a-z0-9][a-z0-9-]*\/(?:[^/]+\/)*[^/]+$/.test(path);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revision = (snapshot: Snapshot) => hash(Object.keys(snapshot).sort().map((path) => [path, snapshot[path]!.text, snapshot[path]!.mode]));
const clone = <T>(value: T): T => structuredClone(value);
function redactView(value: unknown, values: string[]): unknown {
  if (typeof value === "string") return redact(value, values);
  if (Array.isArray(value)) return value.map((item) => redactView(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactView(item, values)]));
  return value;
}
function fail(message: string): never { throw new CapabilityError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Expected an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("Unexpected request field");
}
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) return fail("Invalid text value");
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return fail("Expected boolean"); return value; }
function named(value: unknown): string { const name = text(value, 32); if (!NAME.test(name)) fail("Invalid server name"); return name; }
function skillName(value: unknown): string { const name = text(value, 64); if (!SKILL_NAME.test(name)) fail("Invalid skill name"); return name; }
function pathIn(agentDir: string, path: string): string { return folderFile({ agentDir, path, resource: "Capability file" }); }
function safeDirectory(agentDir: string, path: string): string {
  const dir = pathIn(agentDir, path);
  const parent = dirname(dir);
  if (!existsSync(dir)) {
    if (!existsSync(parent)) safeDirectory(agentDir, dirname(path));
    mkdirSync(dir, { mode: 0o700 }); syncDirectory(parent);
  }
  if (!lstatSync(dir).isDirectory()) fail("Capability directory is not a directory");
  return dir;
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
// The renamed file and its directory entry are both durable before publication advances.
function atomic(agentDir: string, path: string, file: FileImage): void {
  const destination = pathIn(agentDir, path);
  safeDirectory(agentDir, dirname(path));
  const temporary = pathIn(agentDir, `${dirname(path)}/.cap-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
  try { writeFileSync(fd, file.text, "utf8"); fchmodSync(fd, file.mode); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, destination); syncDirectory(dirname(destination)); }
  finally { rmSync(temporary, { force: true }); }
}
function privateJson(agentDir: string, path: string, value: unknown): void { atomic(agentDir, path, { text: JSON.stringify(value), mode: 0o600 }); }
function readImage(agentDir: string, path: string, privateFile = false): FileImage | undefined {
  const file = pathIn(agentDir, path);
  if (!lstatSync(file, { throwIfNoEntry: false })) return;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > (privateFile ? MAX_TOTAL * 3 : MAX_FILE)) fail("Capability input must be a bounded regular file");
    if (privateFile && (stat.mode & 0o077)) fail("Private capability input must have mode 600");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)); }
    catch { return fail("Capability input is not UTF-8"); }
    return { text: content, mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}
function validateSnapshot(value: unknown): Snapshot {
  const raw = object(value); let total = 0; let count = 0;
  const result: Snapshot = {};
  for (const [path, item] of Object.entries(raw)) {
    if (!managed(path) || path.split("/").some((part) => part === ".." || part === ".") || path.includes("\\")) fail("Invalid capability snapshot path");
    const file = object(item);
    if (typeof file.text !== "string" || Buffer.byteLength(file.text) > MAX_FILE || typeof file.mode !== "number" || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) fail("Invalid capability snapshot file");
    if (path === ".mcp.env" && (file.mode & 0o077)) fail("Invalid private file permissions");
    total += Buffer.byteLength(file.text); if (total > MAX_TOTAL || ++count > 1400) fail("Capability snapshot exceeds limits");
    result[path] = { text: file.text, mode: file.mode };
  }
  return result;
}
function actual(agentDir: string): Snapshot {
  const result: Snapshot = {};
  for (const path of ["mcp.json", ".mcp.env", ".agents/provenance.json", ".agents/disabled-skills.json"]) {
    const file = readImage(agentDir, path, path === ".mcp.env"); if (file) result[path] = file;
  }
  const walk = (path: string, depth: number) => {
    const dir = pathIn(agentDir, path); const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory() || depth > 5) fail("Invalid skill directory");
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) walk(child, depth + 1);
      else { const image = readImage(agentDir, child); if (image) result[child] = image; }
    }
  };
  walk(".agents/skills", 0);
  return validateSnapshot(result);
}
function pruneSkills(agentDir: string): void {
  const walk = (path: string) => {
    const dir = pathIn(agentDir, path); if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) walk(`${path}/${item.name}`);
    if (!readdirSync(dir).length) { rmdirSync(dir); syncDirectory(dirname(dir)); }
  };
  walk(".agents/skills");
}
function publishSnapshot(agentDir: string, snapshot: Snapshot): void {
  const current = actual(agentDir);
  for (const [path, file] of Object.entries(snapshot)) atomic(agentDir, path, file);
  for (const path of Object.keys(current)) if (!snapshot[path]) { const file = pathIn(agentDir, path); rmSync(file); syncDirectory(dirname(file)); }
  pruneSkills(agentDir);
}
function removePrivate(agentDir: string, path: string): void {
  const file = pathIn(agentDir, path); if (existsSync(file)) { rmSync(file); syncDirectory(dirname(file)); }
}
function cleanupScratch(agentDir: string): void {
  const root = pathIn(agentDir, PRIVATE); const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) fail("Private capability staging must be a directory");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > 256) fail("Too many private capability files; owner cleanup is required");
  let count = 0; let bytes = 0; let trees = 0;
  const inspect = (path: string, depth: number): void => {
    if (++count > 4096 || depth > 8) fail("Private scratch trees exceed cleanup limits; owner cleanup is required");
    const file = pathIn(agentDir, path); const item = lstatSync(file);
    if (item.isDirectory()) {
      const children = readdirSync(file); if (count + children.length > 4096) fail("Private scratch trees exceed cleanup limits; owner cleanup is required");
      for (const child of children) inspect(`${path}/${child}`, depth + 1);
    } else if (!item.isFile()) fail("Private scratch contains a nonregular file; owner cleanup is required");
    else { bytes += item.size; if (bytes > 64 * 1024 * 1024) fail("Private scratch exceeds 64 MiB; owner cleanup is required"); }
  };
  for (const entry of entries) {
    if (!/^(inspect|export)-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    if (++trees > 64) fail("Too many private scratch trees; owner cleanup is required");
    const path = `${PRIVATE}/${entry.name}`; inspect(path, 0);
    const file = pathIn(agentDir, path);
    if (Date.now() - lstatSync(file).mtimeMs > 24 * 60 * 60 * 1000) { rmSync(file, { recursive: true }); syncDirectory(root); }
  }
}
// Must run before core loaders on startup. An interrupted publication rolls back, but
// never overwrites an unrelated manual edit. Such conflicts stop that folder closed.
export function recoverCapabilities(agentDir: string): void {
  cleanupScratch(agentDir);
  const saved = readImage(agentDir, JOURNAL, true); if (!saved) return;
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(saved.text)); } catch { return fail("Invalid capability recovery journal"); }
  if (raw.version !== 1) fail("Unsupported capability recovery journal");
  if (raw.phase !== "publishing" && raw.phase !== "committed" || typeof raw.requestId !== "string") fail("Invalid capability recovery journal state");
  const before = validateSnapshot(raw.before); const after = validateSnapshot(raw.after); const current = actual(agentDir);
  if (raw.phase === "committed") {
    if (revision(current) !== revision(after)) fail("Committed capabilities conflict with a manual edit; preserve the journal");
    removePrivate(agentDir, JOURNAL); return;
  }
  for (const path of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(current)])) {
    const present = current[path];
    if (JSON.stringify(present) !== JSON.stringify(before[path]) && JSON.stringify(present) !== JSON.stringify(after[path])) fail("Capability recovery conflicts with a manual edit; preserve the journal");
  }
  publishSnapshot(agentDir, before);
  const savedPending = readImage(agentDir, PENDING, true);
  if (savedPending) {
    const pending = object(JSON.parse(savedPending.text));
    if (pending.version !== 1 || revision(validateSnapshot(pending.snapshot)) !== revision(after)) fail("Recovery draft does not match publication; preserve the journal");
    pending.baseRevision = revision(before);
    const requests = object(pending.requests);
    const row = object(requests[raw.requestId]);
    row.result = { state: "failed", requestId: raw.requestId, error: "Apply interrupted; previous configuration restored and changes remain pending" };
    privateJson(agentDir, PENDING, pending);
  }
  removePrivate(agentDir, JOURNAL);
}
function json(snapshot: Snapshot, path: string): unknown { return snapshot[path] ? JSON.parse(snapshot[path]!.text) as unknown : {}; }
function vault(snapshot: Snapshot): Record<string, string> {
  const parsed = parseEnv(snapshot[".mcp.env"]?.text ?? "");
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}
function setVault(snapshot: Snapshot, values: Record<string, string>): void {
  // Use a delimiter absent from the value. Verify Node's exact round trip rather
  // than invent dotenv escaping rules that might change private credential bytes.
  const encoded = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    if (!SECRET_NAME.test(name)) fail("Invalid credential binding name");
    const quote = ["'", '"', "`"].find((candidate) => !value.includes(candidate));
    if (!quote) fail("Credential contains unsupported quoting characters");
    const line = `${name}=${quote}${value}${quote}`;
    if (parseEnv(line)[name] !== value) fail("Credential cannot be represented without changing its bytes");
    return line;
  }).join("\n") + "\n";
  if (Buffer.byteLength(encoded) > 64 * 1024) fail("MCP credentials exceed the 64 KiB private file limit");
  snapshot[".mcp.env"] = { text: encoded, mode: snapshot[".mcp.env"]?.mode ?? 0o600 };
}
function secretInput(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  const result: Record<string, string> = {};
  const entries = Object.entries(object(input)); if (entries.length > 64) fail("Too many credentials");
  for (const [name, value] of entries) {
    if (!SECRET_NAME.test(name) || typeof value !== "string" || !value || value.length > 8192 || value.includes("\0")) fail("Invalid credential name or value");
    result[name] = value;
  }
  return result;
}
function servers(snapshot: Snapshot): Record<string, unknown> {
  const config = object(json(snapshot, "mcp.json")); return snapshot["mcp.json"] ? object(config.servers) : {};
}
function setServers(snapshot: Snapshot, entries: Record<string, unknown>): void {
  const text = JSON.stringify({ servers: entries }, null, 2) + "\n";
  if (Buffer.byteLength(text) > 128 * 1024) fail("MCP configuration exceeds the 128 KiB file limit");
  snapshot["mcp.json"] = { text, mode: snapshot["mcp.json"]?.mode ?? 0o600 };
}
function disabled(snapshot: Snapshot): string[] {
  const value = snapshot[".agents/disabled-skills.json"] ? json(snapshot, ".agents/disabled-skills.json") : [];
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) fail("Invalid disabled skill list");
  return value as string[];
}
function setDisabled(snapshot: Snapshot, names: string[]): void {
  snapshot[".agents/disabled-skills.json"] = { text: JSON.stringify([...new Set(names)].sort()) + "\n", mode: snapshot[".agents/disabled-skills.json"]?.mode ?? 0o600 };
}
function serverConfig(value: unknown): CapabilityServerConfig {
  const config = object(value); const local = "command" in config;
  fields(config, local ? ["command", "args", "cwd", "env"] : ["url", "headers"]);
  if (local) {
    const command = text(config.command, 4096);
    const args = config.args ?? [];
    if (!Array.isArray(args) || args.length > 64 || !args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"))) return fail("Invalid argument vector");
    const bindings = binding(config.env);
    return { command, args, cwd: config.cwd === undefined ? "." : text(config.cwd, 4096), env: bindings };
  }
  return { url: text(config.url, 4096), headers: binding(config.headers) };
}
function binding(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const result: Record<string, string> = {};
  for (const [target, name] of Object.entries(object(value))) result[target] = text(name);
  return result;
}
function configSecrets(config: CapabilityServerConfig): string[] { return Object.values("command" in config ? config.env ?? {} : config.headers ?? {}); }

export class CapabilityManager {
  private readonly dir: string;
  private pending: Pending | undefined;
  private state: CapabilityApply = { state: "idle" };
  private activeSnapshot: Snapshot | undefined;
  private tests = new Map<string, TestRecord>();
  private latestTest: CapabilityTest | undefined;
  private previews = new Map<string, SkillPreview>();
  private latestPreview: string | undefined;
  private initializeError: unknown;
  private recoveryBlocked = false;
  private closed = false;
  private closing = false;
  private testing: AbortController | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private applying: Promise<void> | undefined;
  private abort: AbortController | undefined;
  constructor(private readonly options: CapabilityManagerOptions) {
    this.dir = resolve(options.agentDir);
    try {
      recoverCapabilities(this.dir);
      safeDirectory(this.dir, PRIVATE);
      const file = readImage(this.dir, PENDING, true);
      if (file) {
        const saved = object(JSON.parse(file.text));
        if (saved.version !== 1 || typeof saved.baseRevision !== "string") fail("Invalid pending capabilities");
        const requests: Pending["requests"] = {};
        for (const [id, record] of Object.entries(object(saved.requests))) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || ["constructor", "prototype"].includes(id)) fail("Invalid persisted request ID");
          const row = object(record); const result = object(row.result);
          if (typeof row.revision !== "string" || !["succeeded", "failed", "cancelled", "waiting", "applying"].includes(String(result.state))) fail("Invalid apply request record");
          requests[id] = { revision: row.revision, result: clone(result) as CapabilityApply };
          if (result.state === "waiting" || result.state === "applying") requests[id]!.result = { state: "failed", requestId: id, error: "Apply interrupted; changes remain pending" };
        }
        this.pending = { version: 1, baseRevision: saved.baseRevision, snapshot: validateSnapshot(saved.snapshot), requests };
        this.state = Object.values(requests).at(-1)?.result ?? { state: "idle" };
      }
      const current = actual(this.dir);
      loadSkills(this.dir); loadMcpConfig(this.dir);
      if (options.active !== false) this.activeSnapshot = current;
    } catch (error) { this.initializeError = error; }
  }
  private check(): void {
    if (this.initializeError) throw new CapabilityError("Capabilities cannot be loaded safely; inspect the folder and private recovery files", 409);
    if (this.closed) throw new CapabilityError("Capabilities manager is closed", 409);
  }
  async markActive(): Promise<void> {
    try { this.activeSnapshot = actual(this.dir); }
    catch { this.activeSnapshot = undefined; }
  }
  markStopped(): void { this.activeSnapshot = undefined; }
  private persist(): void { if (this.pending) privateJson(this.dir, PENDING, this.pending); }
  private hasDraft(): boolean { return !!this.pending && revision(this.pending.snapshot) !== this.pending.baseRevision; }
  private draft(current: Snapshot): Pending {
    return clone(this.hasDraft() ? this.pending! : { version: 1, baseRevision: revision(current), snapshot: current, requests: this.pending?.requests ?? {} });
  }
  private async skillView(snapshot: Snapshot): Promise<CapabilitySkill[]> {
    // Validate in a private agent-local scratch folder, using the runtime's loader.
    const tmp = mkdtempSync(join(safeDirectory(this.dir, PRIVATE), "inspect-"));
    try {
      for (const [path, image] of Object.entries(snapshot)) if (path.startsWith(".agents/")) atomic(tmp, path, image);
      const all = loadSkills(tmp, { includeDisabled: true });
      const off = disabled(snapshot); const provenance = object(json(snapshot, ".agents/provenance.json"));
      return all.map((skill) => {
        const row: CapabilitySkill = { name: skill.name, description: skill.description, enabled: !off.includes(skill.name), files: [...skill.files].map(([path, text]) => ({ path, text })) };
        const source = Object.hasOwn(provenance, skill.name) ? provenance[skill.name] : undefined;
        if (source !== undefined) {
          const info = object(source); const hashes = object(info.files);
          if (typeof info.source !== "string" || typeof info.version !== "string" || !Object.values(hashes).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) fail("Invalid skill provenance");
          row.provenance = { source: info.source, version: info.version, files: hashes as Record<string, string> };
          row.modifiedFiles = [...new Set([...Object.keys(hashes), ...skill.files.keys()])].filter((path) => {
            const content = skill.files.get(path);
            return content === undefined || hashes[path] !== createHash("sha256").update(content).digest("hex");
          }).sort();
        }
        return row;
      });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  private serverView(snapshot: Snapshot): CapabilityServer[] {
    const values = vault(snapshot);
    parseMcpConfig(this.dir, snapshot["mcp.json"] ? json(snapshot, "mcp.json") : { servers: {} }, new Map(Object.entries(values)));
    return Object.entries(servers(snapshot)).map(([name, input]) => {
      const row = object(input); const { tools, enabled, ...rest } = row; const config = serverConfig(rest);
      const publicConfig = JSON.stringify([name, config, Object.keys(values), "url" in config ? decodeURIComponent(config.url) : ""]);
      if (Object.values(values).some((secret) => secret && publicConfig.includes(JSON.stringify(secret).slice(1, -1)))) fail("A public server field contains a configured credential");
      return { name, config, enabled: enabled !== false, approved: Object.entries(object(tools ?? {})).map(([name, hash]) => ({ name, hash: text(hash) })), credentials: [...new Set(configSecrets(config))].sort() };
    });
  }
  async view(): Promise<CapabilityView> {
    this.check(); const current = actual(this.dir); const selected = this.hasDraft() ? this.pending!.snapshot : current;
    const skills = await this.skillView(selected); const active = this.activeSnapshot;
    const currentValues = vault(current); const selectedValues = vault(selected);
    const publicRevision = hash({ actual: revision(current), draft: revision(selected) });
    const preview = this.latestPreview ? this.previews.get(this.latestPreview) : undefined;
    const credentialChanges: CapabilityView["credentialChanges"] = [];
    for (const name of new Set([...Object.keys(currentValues), ...Object.keys(selectedValues)])) {
      if (currentValues[name] === selectedValues[name]) continue;
      credentialChanges.push({ name, change: currentValues[name] === undefined ? "added" : selectedValues[name] === undefined ? "removed" : "replaced" });
    }
    credentialChanges.sort((a, b) => a.name.localeCompare(b.name));
    const view: CapabilityView = {
      agentDir: this.dir, revision: publicRevision, activeRevision: active ? revision(active) : null,
      skills, servers: this.serverView(selected), credentials: Object.keys(vault(selected)).sort(),
      connections: this.options.connections?.() ?? [],
      activeSkills: active ? await this.skillView(active) : [], activeServers: active ? this.serverView(active) : [], credentialChanges,
      savedSkills: await this.skillView(current), savedServers: this.serverView(current),
      ...(preview?.revision === publicRevision ? { skillPreview: { previewId: this.latestPreview!, skill: clone(preview.skill) } } : {}),
      pending: this.hasDraft(), apply: clone(this.state),
      ...(this.latestTest ? { test: clone(this.latestTest) } : {}),
    };
    // Skill text and provenance are also untrusted. Neither can echo configured secrets.
    const values = [...Object.values(vault(selected)), ...Object.values(vault(current)), ...Object.values(active ? vault(active) : {})];
    return { ...view, skills: redactView(view.skills, values) as CapabilitySkill[], activeSkills: redactView(view.activeSkills, values) as CapabilitySkill[], savedSkills: redactView(view.savedSkills, values) as CapabilitySkill[], ...(view.skillPreview ? { skillPreview: { previewId: view.skillPreview.previewId, skill: redactView(view.skillPreview.skill, values) as CapabilitySkill } } : {}) };
  }
  command(action: string, body: unknown): Promise<CapabilityView> {
    if (this.closing) return Promise.reject(new CapabilityError("Capabilities manager is closing", 409));
    const result = this.serial.then(() => this.execute(action, body)).catch((error: unknown) => {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError("Capability request failed validation or private storage access");
    });
    this.serial = result.catch(() => {}); return result;
  }
  private async execute(action: string, input: unknown): Promise<CapabilityView> {
    this.check();
    if (this.recoveryBlocked) throw new CapabilityError("Capability recovery requires owner review; preserve the journal", 409);
    const body = object(input); const current = actual(this.dir); const actualRev = revision(current);
    const rev = hash({ actual: actualRev, draft: revision(this.hasDraft() ? this.pending!.snapshot : current) });
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (action === "apply" && (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId) || ["constructor", "prototype"].includes(requestId))) fail("Invalid apply request ID");
    if (action === "apply" && requestId && this.pending && Object.hasOwn(this.pending.requests, requestId)) {
      if (this.pending.requests[requestId]!.revision !== body.revision) throw new CapabilityError("Request ID belongs to a different revision", 409);
      return this.view();
    }
    if (body.revision !== rev) throw new CapabilityError("Configuration changed; review the current revision", 409);
    if (action !== "cancel" && (this.state.state === "waiting" || this.state.state === "applying")) throw new CapabilityError("Apply is already in progress", 409);
    if (action === "cancel") {
      fields(body, ["revision", "requestId"]);
      if (this.state.state !== "waiting" || this.state.requestId !== requestId) throw new CapabilityError("Only this waiting apply can be cancelled", 409);
      this.abort?.abort(); this.state = { state: "cancelled", requestId };
      this.pending!.requests[requestId]!.result = this.state; this.persist(); return this.view();
    }
    if (action === "discard") {
      fields(body, ["revision"]); this.pending = undefined; this.state = { state: "idle" }; this.tests.clear(); this.latestTest = undefined; this.previews.clear(); this.latestPreview = undefined;
      removePrivate(this.dir, PENDING); return this.view();
    }
    const draft = this.draft(current);
    if (draft.baseRevision !== actualRev) throw new CapabilityError("Pending changes conflict with a manual edit; discard and review", 409);
    if (action === "apply") {
      fields(body, ["revision", "requestId"]); text(requestId, 128);
      if (Object.keys(draft.requests).length >= 256) fail("Too many apply requests; discard completed changes first");
      this.state = { state: "waiting", requestId }; draft.requests[requestId] = { revision: rev, result: this.state };
      this.pending = draft; this.persist(); this.abort = new AbortController();
      const signal = this.abort.signal;
      // Start on the next event-loop turn so the request always returns waiting first.
      this.applying = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.activate(requestId, current, draft.snapshot, signal));
      return this.view();
    }
    if (action === "preview-taskfast") {
      fields(body, ["revision"]);
      const snapshot: Snapshot = {}; await this.taskfastSkill(snapshot, false, true);
      const skill = (await this.skillView(snapshot))[0]!; const previewId = randomUUID();
      if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(previewId, { revision: rev, snapshot, skill }); this.latestPreview = previewId;
      return this.view();
    }
    if (action === "discard-item") {
      fields(body, ["revision", "kind", "name"]); this.discardItem(draft.snapshot, current, body.kind, body.name);
    } else if (action === "stage-skill") {
      fields(body, ["revision", "files", "replace", "enabled"]);
      await this.stageSkill(draft.snapshot, body.files, boolean(body.replace), boolean(body.enabled));
    } else if (action === "taskfast-skill") {
      fields(body, ["revision", "replace", "enabled", "previewId"]);
      if (body.previewId === undefined) await this.taskfastSkill(draft.snapshot, boolean(body.replace), boolean(body.enabled));
      else {
        const preview = this.previews.get(text(body.previewId));
        if (!preview || preview.revision !== rev) throw new CapabilityError("Skill preview is stale; inspect a fresh export", 409);
        await this.stageSkill(draft.snapshot, preview.skill.files.map((file) => ({ path: `${preview.skill.name}/${file.path}`, text: file.text })), boolean(body.replace), boolean(body.enabled));
        const provenance = object(json(draft.snapshot, ".agents/provenance.json"));
        provenance[preview.skill.name] = clone(object(json(preview.snapshot, ".agents/provenance.json"))[preview.skill.name]);
        draft.snapshot[".agents/provenance.json"] = { text: JSON.stringify(provenance, null, 2) + "\n", mode: draft.snapshot[".agents/provenance.json"]?.mode ?? 0o600 };
      }
    } else if (action === "skill") {
      fields(body, ["revision", "name", "operation"]);
      const name = skillName(body.name); const installed = await this.skillView(draft.snapshot);
      if (!installed.some((skill) => skill.name === name)) fail("Skill is not installed");
      const off = disabled(draft.snapshot).filter((item) => item !== name);
      if (body.operation === "disable") off.push(name);
      else if (body.operation === "remove") {
        for (const path of Object.keys(draft.snapshot)) if (path.startsWith(`.agents/skills/${name}/`)) delete draft.snapshot[path];
        this.removeProvenance(draft.snapshot, name);
      } else if (body.operation !== "enable") fail("Invalid skill operation");
      setDisabled(draft.snapshot, off);
    } else if (action === "remove-server") {
      fields(body, ["revision", "name"]); const entries = servers(draft.snapshot); const name = named(body.name);
      if (!Object.hasOwn(entries, name)) fail("Server is not configured"); delete entries[name]; setServers(draft.snapshot, entries);
    } else if (action === "remove-credential") {
      fields(body, ["revision", "name"]); const name = text(body.name);
      if (this.serverView(draft.snapshot).some((server) => server.credentials.includes(name))) fail("Credential is still used by a server");
      const values = vault(draft.snapshot); if (!(name in values)) fail("Credential is not configured"); delete values[name]; setVault(draft.snapshot, values);
    } else if (action === "test" || action === "server") {
      fields(body, action === "test" ? ["revision", "name", "config", "secrets", "consent"] : ["revision", "name", "config", "secrets", "enabled", "testId", "approved"]);
      const name = named(body.name); const config = serverConfig(body.config);
      const values = { ...vault(draft.snapshot), ...secretInput(body.secrets) };
      const publicFields = JSON.stringify([name, config, Object.keys(values), "url" in config ? decodeURIComponent(config.url) : ""]);
      if (Object.values(values).some((secret) => secret && publicFields.includes(JSON.stringify(secret).slice(1, -1)))) fail("Credentials cannot appear in public server fields");
      const enabled = action === "test" ? true : boolean(body.enabled);
      const parsed = parseMcpConfig(this.dir, { servers: { [name]: { ...config, tools: {}, enabled } } }, new Map(Object.entries(values)))[0];
      const fingerprint = hash({ name, config, values, revision: rev, draft: revision(draft.snapshot) });
      if (action === "test") {
        if (body.consent !== true) fail("Explicit owner consent is required before connection testing");
        let tools;
        this.testing = new AbortController();
        try { tools = await discoverMcp(parsed!, { signal: this.testing.signal }); }
        catch { throw new CapabilityError("Connection test failed; verify server configuration and credentials"); }
        finally { this.testing = undefined; }
        const view: CapabilityTest = { name, testId: randomUUID(), tools };
        if (this.tests.size >= 8) this.tests.delete(this.tests.keys().next().value!);
        this.tests.set(view.testId, { fingerprint, view }); this.latestTest = view;
        return this.view();
      }
      const tested = body.testId === undefined ? undefined : this.tests.get(text(body.testId));
      if ((enabled || body.testId !== undefined) && (!tested || tested.fingerprint !== fingerprint)) throw new CapabilityError("Test is stale; test this configuration again", 409);
      if (!Array.isArray(body.approved) || body.approved.length > 100) fail("Expected an explicit read approval list");
      if (enabled && body.approved.length === 0) fail("An enabled server needs at least one explicitly reviewed read tool");
      const approved: Record<string, string> = {};
      for (const value of body.approved) {
        const item = object(value); fields(item, ["name", "hash", "read"]);
        if (item.read !== true) fail("Each selected tool requires explicit owner read approval");
        const tool = tested?.view.tools.find((tool) => tool.name === item.name && tool.hash === item.hash);
        if (!tool || tool.blocked || tool.name in approved) fail("Tool is blocked, duplicated or was not reviewed");
        approved[tool.name] = tool.hash;
      }
      const entries = servers(draft.snapshot); entries[name] = { ...config, tools: approved, enabled };
      setServers(draft.snapshot, entries); setVault(draft.snapshot, values);
    } else fail("Unknown capability action");
    validateSnapshot(draft.snapshot); await this.skillView(draft.snapshot); this.serverView(draft.snapshot);
    this.pending = draft; this.persist(); return this.view();
  }
  private discardItem(snapshot: Snapshot, current: Snapshot, kind: unknown, inputName: unknown): void {
    const restoreFile = (path: string) => { if (current[path]) snapshot[path] = clone(current[path]); else delete snapshot[path]; };
    if (kind === "skill") {
      const name = skillName(inputName); const prefix = `.agents/skills/${name}/`;
      for (const path of Object.keys(snapshot)) if (path.startsWith(prefix)) delete snapshot[path];
      for (const [path, image] of Object.entries(current)) if (path.startsWith(prefix)) snapshot[path] = clone(image);
      const off = disabled(snapshot).filter((item) => item !== name);
      if (disabled(current).includes(name)) off.push(name);
      if (JSON.stringify(off.sort()) === JSON.stringify(disabled(current).sort())) restoreFile(".agents/disabled-skills.json");
      else setDisabled(snapshot, off);
      const provenance = object(json(snapshot, ".agents/provenance.json"));
      const original = object(json(current, ".agents/provenance.json"));
      if (Object.hasOwn(original, name)) provenance[name] = clone(original[name]); else delete provenance[name];
      if (Object.keys(provenance).length === Object.keys(original).length && Object.entries(provenance).every(([key, value]) => JSON.stringify(value) === JSON.stringify(original[key]))) restoreFile(".agents/provenance.json");
      else snapshot[".agents/provenance.json"] = { text: JSON.stringify(provenance, null, 2) + "\n", mode: snapshot[".agents/provenance.json"]?.mode ?? 0o600 };
    } else if (kind === "server") {
      const name = named(inputName); const entries = servers(snapshot); const original = servers(current);
      if (Object.hasOwn(original, name)) entries[name] = clone(original[name]); else delete entries[name];
      if (Object.keys(entries).length === Object.keys(original).length && Object.entries(entries).every(([key, value]) => JSON.stringify(value) === JSON.stringify(original[key]))) restoreFile("mcp.json");
      else setServers(snapshot, entries);
    } else if (kind === "credential") {
      const name = text(inputName); if (!SECRET_NAME.test(name)) fail("Invalid credential name");
      const values = vault(snapshot); const original = vault(current);
      if (original[name] === undefined && this.serverView(snapshot).some((server) => server.credentials.includes(name))) fail("Credential is used by a staged server; discard that server first");
      if (original[name] === undefined) delete values[name]; else values[name] = original[name];
      if (Object.keys(values).length === Object.keys(original).length && Object.entries(values).every(([key, value]) => original[key] === value)) restoreFile(".mcp.env");
      else setVault(snapshot, values);
    } else fail("Invalid discard item kind");
  }
  private removeProvenance(snapshot: Snapshot, name: string): void {
    if (!snapshot[".agents/provenance.json"]) return;
    const provenance = object(json(snapshot, ".agents/provenance.json")); delete provenance[name];
    snapshot[".agents/provenance.json"] = { text: JSON.stringify(provenance, null, 2) + "\n", mode: snapshot[".agents/provenance.json"]!.mode };
  }
  private async stageSkill(snapshot: Snapshot, input: unknown, replace: boolean, enabled: boolean): Promise<string> {
    if (!Array.isArray(input) || !input.length || input.length > 64 || Buffer.byteLength(JSON.stringify(input)) > MAX_TOTAL) return fail("Import needs 1-64 text files within 4 MiB");
    const imported: Snapshot = {}; let name: string | undefined; const paths = new Set<string>();
    for (const item of input) {
      const file = object(item); fields(file, ["path", "text"]); const path = text(file.path, 512);
      if (typeof file.text !== "string" || Buffer.byteLength(file.text) > MAX_FILE || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part.startsWith(".") || !/^[A-Za-z0-9_. -]+$/.test(part)) || ![".md", ".txt"].includes(extname(path).toLowerCase())) fail("Import only relative skill text files, not private files or scripts");
      const [folder, ...parts] = path.split("/"); const candidate = skillName(folder);
      if (!parts.length || name && name !== candidate || paths.has(path)) fail("Import exactly one skill folder without duplicate files");
      name = candidate; paths.add(path); imported[`.agents/skills/${path}`] = { text: file.text, mode: 0o600 };
    }
    if (!name) return fail("No skill to import");
    await this.skillView(imported);
    const prefix = `.agents/skills/${name}/`;
    const existing = Object.keys(snapshot).some((path) => path.startsWith(prefix));
    if (existing && !replace) fail("Skill exists; explicit replace is required");
    if (!existing && replace) fail("Cannot replace a skill that is not installed");
    for (const [path, image] of Object.entries(imported)) image.mode = snapshot[path]?.mode ?? image.mode;
    for (const path of Object.keys(snapshot)) if (path.startsWith(prefix)) delete snapshot[path];
    Object.assign(snapshot, imported); this.removeProvenance(snapshot, name);
    setDisabled(snapshot, [...disabled(snapshot).filter((item) => item !== name), ...(enabled ? [] : [name])]);
    return name;
  }
  private async taskfastSkill(snapshot: Snapshot, replace: boolean, enabled: boolean): Promise<void> {
    const tmp = mkdtempSync(join(safeDirectory(this.dir, PRIVATE), "export-"));
    try {
      const home = join(tmp, "home"); mkdirSync(home, { mode: 0o700 });
      const env = this.options.env === "production" || this.options.env === "prod" ? "prod" : this.options.env === "development" ? "local" : this.options.env;
      const options = { cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8" as const, timeout: 10_000, maxBuffer: 64 * 1024 };
      const version = spawnSync("taskfast", ["--version"], options);
      if (version.error || version.status !== 0) fail("TaskFast CLI version check failed");
      const parsedVersion = /^taskfast (\S+)\s*$/.exec(version.stdout);
      if (!parsedVersion || parsedVersion[1]!.length > 128) fail("TaskFast CLI returned an invalid version");
      const exported = spawnSync("taskfast", ["--env", env, `--config=${join(tmp, "absent.json")}`, "--no-trace", "skills", "--yes"], options);
      if (exported.error || exported.status !== 0) fail("TaskFast skill export failed");
      const skills = loadSkills(tmp);
      if (skills.length !== 1 || skills[0]!.name !== "taskfast-agent") fail("CLI did not export exactly the TaskFast skill");
      const skill = skills[0]!; const files = [...skill.files].map(([path, text]) => ({ path: `${skill.name}/${path}`, text }));
      await this.stageSkill(snapshot, files, replace, enabled);
      const provenance = object(json(snapshot, ".agents/provenance.json"));
      provenance[skill.name] = { source: "taskfast-cli", version: parsedVersion[1]!, files: Object.fromEntries([...skill.files].map(([path, text]) => [path, createHash("sha256").update(text).digest("hex")])) };
      snapshot[".agents/provenance.json"] = { text: JSON.stringify(provenance, null, 2) + "\n", mode: snapshot[".agents/provenance.json"]?.mode ?? 0o600 };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  private async activate(requestId: string, before: Snapshot, after: Snapshot, signal: AbortSignal): Promise<void> {
    let published = false;
    let committed = false;
    let registering = true;
    let onCommit: (() => Promise<void>) | undefined;
    let onFailure: ((restored: boolean) => Promise<void>) | undefined;
    let callbackStarted = false;
    const rollback = async () => {
      if (committed) throw new CapabilityError("Configuration is committed and cannot be rolled back", 409);
      if (!published) return;
      // Recovery verifies every current file against the write-ahead images.
      recoverCapabilities(this.dir); published = false;
    };
    try {
      signal.throwIfAborted();
      await this.options.activate({
        signal,
        afterCommit: (action, failure) => {
          if (!registering || onCommit) throw new CapabilityError("Register afterCommit once, during activation", 409);
          if (typeof action !== "function" || failure !== undefined && typeof failure !== "function") throw new CapabilityError("afterCommit requires callbacks");
          onCommit = action; onFailure = failure;
        },
        publish: async () => {
          if (committed) throw new CapabilityError("Configuration is already committed", 409);
          signal.throwIfAborted();
          if (published) {
            if (revision(actual(this.dir)) !== revision(after)) throw new CapabilityError("Configuration changed during activation", 409);
            return;
          }
          if (this.state.state !== "waiting") throw new CapabilityError("Apply is no longer waiting", 409);
          if (revision(actual(this.dir)) !== revision(before)) throw new CapabilityError("Configuration changed while waiting", 409);
          this.state = { state: "applying", requestId }; this.pending!.requests[requestId]!.result = this.state; this.persist();
          const journal: Journal = { version: 1, before, after, requestId, phase: "publishing" }; privateJson(this.dir, JOURNAL, journal); published = true;
          publishSnapshot(this.dir, after);
        }, rollback,
      });
      registering = false;
      if (signal.aborted && !published) return;
      if (!published) throw new Error("Activation did not publish configuration");
      if (revision(actual(this.dir)) !== revision(after)) throw new CapabilityError("Configuration changed during activation", 409);
      const success: CapabilityApply = { state: "succeeded", requestId };
      this.pending!.baseRevision = revision(after); this.pending!.snapshot = clone(after);
      this.pending!.requests[requestId]!.result = success; this.persist();
      privateJson(this.dir, JOURNAL, { version: 1, before, after, requestId, phase: "committed" } satisfies Journal);
      committed = true;
      removePrivate(this.dir, JOURNAL);
      this.tests.clear(); this.latestTest = undefined;
      // A held replacement may schedule work only after every durable commit step.
      // Keep the view applying until its release completes, blocking another mutation.
      if (onCommit) { callbackStarted = true; await onCommit(); }
      this.activeSnapshot = clone(after); this.state = success;
    } catch {
      registering = false;
      if (committed) {
        // The new registry might already have dispatched a write. Never restore old
        // configuration or claim rollback after scheduling has been released.
        this.markStopped();
        this.state = { state: "failed", requestId, error: "Configuration committed, but activation failed; agent is stopped. Retry startup without applying again" };
      }
      let restored = false;
      if (!committed) {
        try { await rollback(); restored = revision(actual(this.dir)) === revision(before); }
        catch { this.recoveryBlocked = true; this.markStopped(); }
        if (!restored) this.markStopped();
        if (this.pending) { this.pending.baseRevision = revision(before); this.pending.snapshot = clone(after); }
        if (this.state.state !== "cancelled") this.state = { state: "failed", requestId, error: this.recoveryBlocked ? "Apply and rollback failed; agent is stopped. Preserve the recovery journal for owner review" : restored ? "Apply failed; previous configuration was restored and changes remain pending" : "Apply failed; configuration changed and agent is stopped. Review the folder configuration" };
      }
      if (onFailure && !callbackStarted) {
        try { await onFailure(restored); }
        catch {
          this.recoveryBlocked = true; this.markStopped();
          this.state = { state: "failed", requestId, error: "Apply failed and activation cleanup failed; agent is stopped. Review folder ownership before retrying" };
        }
      }
      if (this.pending) {
        this.pending.requests[requestId]!.result = this.state;
        try { this.persist(); } catch { this.recoveryBlocked = true; this.markStopped(); }
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true; this.testing?.abort();
    if (this.state.state === "waiting") {
      const requestId = this.state.requestId; this.abort?.abort(); this.state = { state: "cancelled", requestId };
      if (this.pending) { this.pending.requests[requestId]!.result = this.state; this.persist(); }
    }
    await this.serial; await this.applying; this.closed = true; this.tests.clear(); this.previews.clear();
  }
}
