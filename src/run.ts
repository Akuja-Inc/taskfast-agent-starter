import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PING_MS, startConsole, type ConsoleAgent, type HostFacts, type Ledger } from "./console.js";
import type { AgentRosterEntry, StartupAction } from "./console-lifecycle.js";
import { CapabilityManager, recoverCapabilities } from "./capabilities.js";
import type { CapabilityActivation } from "./capability-types.js";
import { isMarketEvent } from "./core/event.js";
import { runCli } from "./core/cli.js";
import { CleanupError } from "./core/cleanup-error.js";
import type { Command } from "./core/policy.js";
import { UUID } from "./core/tools.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "./core/agent.js";
import { startListener } from "./core/listener.js";
import { createAgentModels } from "./core/model.js";
import { agentFile, hasStaleCharacter, INSTRUCTIONS_PATH, parseAgentFile, parseAgentSpec, POLL_MINUTES, STALE_CHARACTER } from "./core/spec.js";
import { parseWalletPasswordFile } from "./core/cli.js";
import { PASSWORD_PATH, folderFile, portableFile, providerSettings } from "./core/folder.js";
import type { AgentSpec, Env, Runtime } from "./core/types.js";

export const ENVIRONMENTS = { production: "prod", staging: "staging", development: "local" } as const satisfies Record<string, Env>;
export type Environment = keyof typeof ENVIRONMENTS;
export function taskfastEnv(name: string): Env {
  const environment = Object.entries(ENVIRONMENTS).find(([key]) => key === name);
  if (!environment) throw new Error(`--env must be production, staging or development, not ${JSON.stringify(name)}`);
  return environment[1];
}
export type AgentHandle = Pick<MarketplaceAgent, "closed" | "deliver" | "ping" | "close"> & Partial<ConsoleAgent["agent"]> & Partial<Pick<MarketplaceAgent, "quiesce" | "releaseInitialHold" | "capabilityConnections">>;
export interface RunOptions {
  agentsDir: string;
  env: Env;
  walletPasswordFile?: string;
  console?: { port: number };
  command?: Command;
  openAgent?(agent: { id: string; spec: AgentSpec; runtime: Runtime; storePath: string; signal?: AbortSignal; startHeld?: boolean }): Promise<AgentHandle>;
  listen?: typeof startListener;
  signal: AbortSignal;
  log(line: string): void;
  // Explicit embedding/test override. Takes precedence over each saved agent interval.
  pingEveryMs?: number;
}

const READ_TTL_MS = 60_000;
// Slightly less than an SSE ping, so every idle ping can refresh the wallet.
const WALLET_TTL_MS = PING_MS - 1_000;
const PAYMENTS = new Set(["payment_held", "payment_released", "payment_disbursed", "dispute_resolved"]);
function moves({ actions, events }: Ledger): number {
  const settled = Object.values(actions).filter((action) => action.amount > 0 && (action.status === "done" || action.status === "uncertain"));
  const paid = Object.values(events).filter(({ event }) => isMarketEvent(event) && PAYMENTS.has(event.event));
  return settled.length + paid.length;
}
function streamStatus(line: string): HostFacts["stream"] | undefined {
  if (line === "sentinel connected" || line === "sentinel resumed") return "connected";
  if (line === "sentinel reconnecting") return "reconnecting";
  if (line === "sentinel auth_failed") return "auth failed";
  if (line.startsWith("stream exited")) return "restarting";
  return undefined;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function writeFileDurable(path: string, text: string): void {
  const temporary = `${path}.saving`;
  const file = openSync(temporary, "w");
  try { writeSync(file, text); fsyncSync(file); }
  finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); }
  finally { closeSync(directory); }
}
function deadLetter(line: string): HostFacts["deadLetters"][number] | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || typeof record.reason !== "string" || typeof record.line !== "string") return undefined;
  return { at: record.at, reason: record.reason, line: record.line };
}

export async function runAgents(o: RunOptions): Promise<void> {
  const walletPasswordFile = o.walletPasswordFile === undefined ? undefined : parseWalletPasswordFile(o.walletPasswordFile);
  function findUnlockFile(agentDir: string): string | undefined {
    const local = folderFile({ agentDir, path: PASSWORD_PATH, resource: "wallet unlock file" });
    return existsSync(local) ? local : walletPasswordFile;
  }
  function selectedConfig(id: string) {
    const configPath = folderFile({ agentDir: resolve(o.agentsDir, id), path: ".taskfast/config.json", resource: "TaskFast config" });
    if (!existsSync(configPath)) throw new Error(`no ${configPath}; run \`taskfast --env ${o.env} init\` in ${join(o.agentsDir, id)}`);
    // JSON parser messages can quote credentials from this private file.
    let config: unknown;
    try { config = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("cannot read .taskfast/config.json as JSON"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("TaskFast config must be an object");
    if (!("environment" in config) || config.environment === null) throw new Error("no environment in .taskfast/config.json; set it explicitly with taskfast config set environment prod|staging|local in this folder after checking the account");
    // CLI v0.20.0 accepts production as an alias on load, but writes prod.
    const env = config.environment === "production" ? "prod" : config.environment;
    if (!(Object.values(ENVIRONMENTS) as unknown[]).includes(env)) throw new Error("invalid environment in .taskfast/config.json; expected prod, staging or local");
    if (env !== o.env) throw new Error(`configured for ${env}, selected ${o.env}`);
    return { configPath, config };
  }
  const discovered = existsSync(o.agentsDir) ? readdirSync(o.agentsDir).filter((id) => existsSync(join(o.agentsDir, id, "agent.json"))) : [];
  if (!discovered.length) throw new Error(`no agents: put one in ${o.agentsDir}/<id>/ with agent.json and ${INSTRUCTIONS_PATH} (copy a folder from examples/)`);
  const excluded: string[] = [];
  const ids = discovered.filter((id) => {
    try { selectedConfig(id); return true; }
    catch (error) { excluded.push(`${id}: ${message(error)}`); o.log(`${id}: skipped: ${message(error)}`); return false; }
  });
  if (!ids.length) throw new Error(`no agents match ${o.env}: ${excluded.join("; ")}`);
  // Re-read each folder only when its previous owner has finished closing. A bad
  // folder stops that slot, never validation or marketplace work in its siblings.
  function load(id: string) {
    const { configPath, config } = selectedConfig(id);
    const agentDir = resolve(o.agentsDir, id);
    const specPath = folderFile({ agentDir, path: "agent.json", resource: "agent specification" });
    const instructionsPath = folderFile({ agentDir, path: INSTRUCTIONS_PATH, resource: "agent instructions" });
    const raw: unknown = JSON.parse(readFileSync(specPath, "utf8"));
    const parsed = parseAgentFile(raw);
    if (hasStaleCharacter(raw)) o.log(`${id}: ${STALE_CHARACTER}`);
    if (!existsSync(instructionsPath)) throw new Error(`${id}: no ${instructionsPath}; write the agent's instructions there (see examples/)`);
    const spec = parseAgentSpec({ ...parsed, instructions: readFileSync(instructionsPath, "utf8") });
    const previous = [resolve(o.agentsDir, "..", ".pi-state", o.env, id, "state.sqlite"), resolve(".pi-state", o.env, id, "state.sqlite")];
    if (previous.some((path) => ["", ".owner", "-wal", "-shm"].some((suffix) => existsSync(path + suffix)))) throw new Error(`${id}: prior shared store exists; preserve it, do not start a blank ledger`);
    if ("keystore_path" in config && config.keystore_path !== null) portableFile({ agentDir, path: config.keystore_path, resource: "wallet reference" });
    providerSettings(agentDir);
    const file = findUnlockFile(agentDir);
    return { id, agentDir, spec, specPath, instructionsPath, storePath: folderFile({ agentDir, path: `.pi-state/${o.env}/state.sqlite`, resource: "permanent state" }), runtime: { env: o.env, configPath, ...(file === undefined ? {} : { walletPasswordFile: file }) } };
  }
  type Item = ReturnType<typeof load>;
  type Read = { at: number; moves: number; running: boolean; done: Promise<void>; value: unknown };
  type Owned = {
    item: Item; agent: AgentHandle; listener?: ReturnType<typeof startListener>;
    poll: AbortController; polling?: Promise<void>; stream: HostFacts["stream"];
    reads: Map<string, Read>; updates: Set<() => void>; active: boolean; streamsClosed?: Promise<void>;
  };
  type Slot = {
    entry: AgentRosterEntry; pending: Promise<void>; controller?: AbortController;
    owned?: Owned; cleanupFailed: boolean; editing: boolean; failure?: unknown;
    capabilities?: CapabilityManager;
    recovered?: boolean;
  };
  const slots: Slot[] = ids.map((id) => ({ entry: { id, generation: 1, state: "starting", phase: "opening" }, pending: Promise.resolve(), cleanupFailed: false, editing: false }));
  let consoleServer: Awaited<ReturnType<typeof startConsole>> | undefined;
  let shuttingDown = false;
  let opened = 0;
  const ended = () => shuttingDown || o.signal.aborted;
  const current = (slot: Slot, generation: number) => !ended() && slot.entry.generation === generation && slot.entry.state === "starting";
  const ready = (slot: Slot, generation: number) => !ended() && slot.entry.generation === generation && slot.entry.state === "ready";
  function stopped(slot: Slot, error: unknown) {
    slot.capabilities?.markStopped();
    slot.failure = error;
    slot.entry = { id: slot.entry.id, generation: slot.entry.generation, role: slot.entry.role, state: "stopped", reason: message(error) };
    o.log(`${slot.entry.id}: stopped: ${message(error)}`);
  }
  function closeStreams(owned: Owned): Promise<void> {
    owned.active = false;
    owned.poll.abort();
    return owned.streamsClosed ??= (async () => {
      await consoleServer?.closeStreams(owned.item.id);
      await owned.listener?.close();
    })();
  }
  // A cleanup error is a permanent barrier for this host. Never guess that a failed
  // close released ownership, even if the UI has already accepted a queued retry.
  async function closeOwned(slot: Slot, owned: Owned): Promise<void> {
    if (slot.owned === owned) slot.owned = undefined;
    try {
      await closeStreams(owned);
      await Promise.allSettled([...owned.reads.values()].map((read) => read.done));
      await owned.agent.close();
      await owned.polling;
    } catch (error) {
      slot.cleanupFailed = true;
      throw error;
    }
  }
  const pollIntervalMs = (spec: AgentSpec) => o.pingEveryMs ?? (spec.pollIntervalMinutes ?? POLL_MINUTES.default) * 60_000;
  async function poll(owned: Owned) {
    while (owned.active && !ended()) {
      try { await owned.agent.ping(); }
      catch (error) { o.log(`${owned.item.id}: ping failed: ${message(error)}`); }
      if (!owned.active || ended()) break;
      await sleep(pollIntervalMs(owned.item.spec), undefined, { signal: owned.poll.signal }).catch(() => {});
    }
  }
  async function start(slot: Slot, generation: number, controller: AbortController, held = false): Promise<void> {
    if (slot.cleanupFailed) throw new Error("previous cleanup failed; restart the host after checking ownership");
    selectedConfig(slot.entry.id);
    // Recover an interrupted publication only on first opening in this host. A
    // deliberate apply leaves its journal live until the new registry has opened.
    if (!slot.recovered) {
      recoverCapabilities(resolve(o.agentsDir, slot.entry.id));
      slot.recovered = true;
    }
    const item = load(slot.entry.id);
    if (!current(slot, generation)) return;
    slot.entry = { id: item.id, generation, role: item.spec.role, state: "starting", phase: "opening" };
    let agent: AgentHandle;
    try {
      agent = o.openAgent
        ? await o.openAgent({ ...item, signal: controller.signal, startHeld: held })
        : await openMarketplaceAgent({ spec: item.spec, runtime: item.runtime, storePath: item.storePath, signal: controller.signal, startHeld: held, log: (line) => o.log(`${item.id}: ${line}`) });
    } catch (error) {
      // Failed opening can still retain ownership. Preserve that barrier even if
      // cancellation or a queued retry has already replaced this generation.
      if (error instanceof CleanupError) slot.cleanupFailed = true;
      throw error;
    }
    const owned: Owned = { item, agent, poll: new AbortController(), stream: "starting", reads: new Map(), updates: new Set(), active: false };
    if (!current(slot, generation)) { await closeOwned(slot, owned); return; }
    try {
      owned.listener = (o.listen ?? startListener)({ runtime: item.runtime, deliver: (event) => agent.deliver(event), log: (line) => {
        const stream = streamStatus(line);
        if (stream) owned.stream = stream;
        o.log(`${item.id}: ${line}`);
      } });
    } catch (error) { await closeOwned(slot, owned); throw error; }
    slot.owned = owned;
    owned.active = true;
    if (!held) {
      slot.entry = { id: item.id, generation, role: item.spec.role, state: "ready" };
      void slot.capabilities?.markActive();
      opened++;
    }
    void agent.closed.then((end) => {
      if (end.reason !== "failed" || ended() || slot.owned !== owned) return;
      o.log(`${item.id}: session failed: ${message(end.error)}; stopping the agent`);
      stopped(slot, end.error);
      owned.active = false;
      slot.pending = slot.pending.then(() => closeOwned(slot, owned)).catch((error: unknown) => stopped(slot, error));
    }).catch((error: unknown) => o.log(`${item.id}: session close failed: ${message(error)}`));
    if (!held) owned.polling = poll(owned);
  }
  function schedule(slot: Slot) {
    const generation = slot.entry.generation;
    const controller = new AbortController();
    slot.controller = controller;
    slot.pending = slot.pending.then(() => {
      if (slot.entry.generation !== generation || ended()) return;
      return start(slot, generation, controller);
    }).catch((error: unknown) => {
      if (slot.entry.generation === generation || slot.cleanupFailed) stopped(slot, error);
    });
  }
  function startup({ id, generation, action }: StartupAction): boolean {
    const slot = slots.find((candidate) => candidate.entry.id === id);
    if (!slot || ended() || slot.editing || slot.entry.generation !== generation) return false;
    if (action === "cancel") {
      if (slot.entry.state !== "starting") return false;
      slot.entry = { id, generation: generation + 1, role: slot.entry.role, state: "stopped", reason: "Opening cancelled" };
      slot.controller?.abort();
      return true;
    }
    if (slot.entry.state !== "stopped" || slot.cleanupFailed) return false;
    slot.entry = { id, generation: generation + 1, role: slot.entry.role, state: "starting", phase: "waiting-for-close" };
    schedule(slot);
    return true;
  }

  // Each generation owns its read cache. Return the last known result immediately;
  // complete remote reads in the background and announce them like local commits.
  // Invalidations queue behind an existing child, preserving per-command singleflight.
  function read(owned: Owned, args: string[], ttlMs = READ_TTL_MS, moved = 0): unknown {
    const key = args.join(" ");
    const cached = owned.reads.get(key);
    if (!owned.active || ended()) return cached?.value;
    if (cached && cached.moves >= moved && (cached.running || Date.now() - cached.at < ttlMs)) return cached.value;
    const entry: Read = { at: Date.now(), moves: Math.max(moved, cached?.moves ?? 0), running: true, done: Promise.resolve(), value: cached?.value };
    owned.reads.set(key, entry);
    entry.done = (cached?.running ? cached.done : Promise.resolve()).then(async () => {
      if (!owned.active || ended()) return;
      const result = await (o.command ?? runCli)(owned.item.runtime, args);
      entry.value = result.outcome === "ok" ? result.data ?? null : { error: result.error ?? result.outcome };
      entry.running = false;
      if (owned.active && owned.reads.get(key) === entry) owned.updates.forEach((listener) => listener());
    }).catch(() => {
      if (owned.reads.get(key) === entry) owned.reads.delete(key);
    });
    return entry.value;
  }
  const deadLetterCache = new Map<string, { stat: { mtimeMs: number; size: number }; lines: HostFacts["deadLetters"] }>();
  function readDeadLetters(path: string): HostFacts["deadLetters"] {
    let stat: { mtimeMs: number; size: number };
    try { stat = statSync(path); } catch { return []; }
    const cached = deadLetterCache.get(path);
    if (cached && cached.stat.mtimeMs === stat.mtimeMs && cached.stat.size === stat.size) return cached.lines;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => deadLetter(line) ?? []);
    deadLetterCache.set(path, { stat: { mtimeMs: stat.mtimeMs, size: stat.size }, lines });
    return lines;
  }
  async function facts(owned: Owned, taskIds: string[], seen: Ledger): Promise<HostFacts> {
    const item = owned.item;
    const unlock = findUnlockFile(item.agentDir);
    return {
      unlockFile: unlock !== undefined && existsSync(unlock), stream: owned.stream,
      wallet: read(owned, ["wallet", "balance"], WALLET_TTL_MS, moves(seen)),
      tasks: Object.fromEntries(taskIds.filter((id) => UUID.test(id)).map((id) => [id, read(owned, ["task", "get", "--", id])])),
      deadLetters: readDeadLetters(join(dirname(item.runtime.configPath), "dead-letter.jsonl")),
      pollIntervalMs: pollIntervalMs(item.spec),
    };
  }
  // Settings saves and startup intents share one slot. Lock the intent before the
  // first await, and keep it locked through file rollback and ownership cleanup.
  async function reopen(slot: Slot, owned: Owned, spec: AgentSpec): Promise<void> {
    if (ended()) throw new Error("the host is shutting down; agent file not saved");
    if (slot.editing || slot.entry.state !== "ready" || slot.owned !== owned) throw new Error("agent lifecycle changed; refresh before saving");
    slot.editing = true;
    const work = async () => {
      const item = owned.item;
      selectedConfig(item.id);
      try {
        await createAgentModels(spec.model, { agentDir: item.agentDir, settings: providerSettings(item.agentDir) });
      } catch (error) { throw new Error(`agent file rejected, nothing was saved: ${message(error)}`); }
      if (ended() || slot.owned !== owned || slot.entry.state !== "ready") throw new Error("agent lifecycle changed; agent file not saved");
      const previous = { text: readFileSync(item.specPath, "utf8"), instructions: readFileSync(item.instructionsPath, "utf8") };
      writeFileDurable(item.specPath, `${JSON.stringify(agentFile(spec), null, 2)}\n`);
      try { writeFileDurable(item.instructionsPath, spec.instructions); }
      catch (error) { writeFileDurable(item.specPath, previous.text); throw error; }
      const generation = slot.entry.generation + 1;
      const controller = new AbortController();
      slot.controller = controller;
      slot.entry = { id: item.id, generation, role: spec.role, state: "starting", phase: "waiting-for-close" };
      try {
        await closeOwned(slot, owned);
        await start(slot, generation, controller);
        if (!ready(slot, generation)) throw new Error("agent lifecycle changed; agent file not saved");
      } catch (error) {
        stopped(slot, error);
        // A failed reopen leaves the slot visible and restores both files.
        writeFileDurable(item.specPath, previous.text);
        writeFileDurable(item.instructionsPath, previous.instructions);
        throw error;
      }
    };
    const result = slot.pending.then(work);
    slot.pending = result.then(() => {}, () => {});
    try { await result; }
    finally { slot.editing = false; }
  }

  // A capability apply holds only new scheduling, not durable event admission or
  // the owner's Pause choice. Publication starts only after the held run finishes.
  async function activateCapabilities(slot: Slot, change: CapabilityActivation): Promise<void> {
    if (ended() || slot.editing || slot.cleanupFailed || slot.entry.state === "starting") throw new Error("agent lifecycle changed; refresh before applying");
    slot.editing = true;
    let commitRegistered = false;
    const work = async () => {
      const owned = slot.owned;
      let release: (() => Promise<void>) | undefined;
      let published = false;
      try {
        if (owned) {
          if (!owned.agent.quiesce) throw new Error("this host cannot safely wait for idle capability activation");
          release = await owned.agent.quiesce(change.signal);
        }
        change.signal.throwIfAborted();
        if (ended() || slot.owned !== owned) throw new Error("agent lifecycle changed; nothing was applied");
        // The old registry is an immutable lifetime snapshot. Publishing while it
        // is held lets the manager forbid Cancel before ownership starts closing.
        await change.publish();
        published = true;
        const generation = slot.entry.generation + 1;
        const controller = new AbortController();
        slot.controller = controller;
        slot.entry = { id: slot.entry.id, generation, role: slot.entry.role, state: "starting", phase: "waiting-for-close" };
        if (owned) await closeOwned(slot, owned);
        await start(slot, generation, controller, true);
        const replacement = slot.owned;
        if (!replacement || replacement === owned || !current(slot, generation)) throw new Error("agent could not reopen after applying capabilities");
        if (!replacement.agent.releaseInitialHold) throw new Error("this host cannot activate a dormant capability registry");
        // Verify after asynchronous connection work, while recovery, model runs and
        // polling remain held. Only a durable commit may release this new registry.
        await change.publish();
        change.afterCommit(async () => {
          try {
            if (ended() || slot.owned !== replacement || !current(slot, generation)) throw new Error("host stopped before capability activation");
            slot.entry = { id: replacement.item.id, generation, role: replacement.item.spec.role, state: "ready" };
            await slot.capabilities?.markActive();
            await replacement.agent.releaseInitialHold?.();
            if (!ready(slot, generation)) throw new Error("agent stopped during capability activation");
            opened++;
            replacement.polling = poll(replacement);
          } catch (error) {
            stopped(slot, error);
            if (slot.owned === replacement) await closeOwned(slot, replacement);
            throw error;
          } finally { slot.editing = false; }
        }, async (restored) => {
          try {
            stopped(slot, new Error(restored ? "capability publication failed; previous configuration restored" : "capability publication failed; check the private recovery journal"));
            if (slot.owned === replacement) await closeOwned(slot, replacement);
            if (restored && !slot.cleanupFailed && !ended()) {
              const retryGeneration = slot.entry.generation + 1;
              const retryController = new AbortController();
              slot.controller = retryController;
              slot.entry = { id: slot.entry.id, generation: retryGeneration, role: slot.entry.role, state: "starting", phase: "waiting-for-close" };
              try { await start(slot, retryGeneration, retryController); }
              catch (error) { stopped(slot, error); }
            }
          } finally { slot.editing = false; }
        });
        commitRegistered = true;
      } catch (error) {
        if (published) {
          stopped(slot, error);
          const replacement = slot.owned;
          if (replacement && replacement !== owned) await closeOwned(slot, replacement);
          await change.rollback();
          // A failed close is an ownership barrier, never permission to open again.
          // Otherwise restore the previous configuration in the same durable store.
          if (!slot.cleanupFailed && !ended()) {
            const generation = slot.entry.generation + 1;
            const controller = new AbortController();
            slot.controller = controller;
            slot.entry = { id: slot.entry.id, generation, role: slot.entry.role, state: "starting", phase: "waiting-for-close" };
            try { await start(slot, generation, controller); }
            catch (recovery) { stopped(slot, recovery); }
          }
        }
        throw error;
      } finally { await release?.(); }
    };
    const result = slot.pending.then(work);
    slot.pending = result.then(() => {}, () => {});
    try { await result; }
    finally { if (!commitRegistered) slot.editing = false; }
  }

  let wake = () => {};
  const abort = new Promise<void>((resolve) => { wake = resolve; });
  const stop = () => {
    shuttingDown = true;
    for (const slot of slots) { slot.controller?.abort(); slot.owned?.poll.abort(); }
    wake();
  };
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    if (o.console) {
      for (const slot of slots) slot.capabilities = new CapabilityManager({
        agentDir: resolve(o.agentsDir, slot.entry.id), env: o.env, active: false,
        activate: (change) => activateCapabilities(slot, change),
        connections: () => slot.entry.state === "ready" ? slot.owned?.agent.capabilityConnections?.() ?? [] : [],
      });
      consoleServer = await startConsole({
        port: o.console.port, token: randomBytes(32).toString("hex"), env: o.env,
        roster: () => slots.map((slot) => ({ ...slot.entry })), startup,
        capabilities: (id) => slots.find((slot) => slot.entry.id === id)?.capabilities,
        agents: () => slots.flatMap((slot) => {
          const owned = slot.owned;
          if (!owned || !owned.active || slot.entry.state !== "ready") return [];
          const { item, agent } = owned;
          if (!agent.operator || !agent.status || !agent.transcript || !agent.changes) return [];
          const changes = agent.changes;
          return [{ id: item.id, spec: item.spec, agent: { operator: agent.operator, status: agent.status, transcript: agent.transcript, changes: (listener: () => void) => {
            const off = changes(listener);
            owned.updates.add(listener);
            return () => { owned.updates.delete(listener); off(); };
          } }, saveSpec: (next: AgentSpec) => reopen(slot, owned, next), host: (taskIds: string[], seen: Ledger) => facts(owned, taskIds, seen) }];
        }),
      });
      o.log(`console: ${consoleServer.url}`);
    }
    // Validate even a pre-aborted nonconsole invocation, without opening resources.
    if (o.signal.aborted) {
      if (!o.console) for (const slot of slots) load(slot.entry.id);
      return;
    }
    for (const slot of slots) schedule(slot);
    o.log(`running ${ids.length} agent slot(s) on ${o.env}: ${ids.join(", ")}`);
    if (!o.console) {
      await Promise.race([Promise.all(slots.map((slot) => slot.pending)), abort]);
      if (!ended() && !opened) throw new Error(`no agents opened: ${slots.map((slot) => `${slot.entry.id}: ${message(slot.failure)}`).join("; ")}`);
    }
    if (!ended()) await abort;
  } finally {
    stop();
    o.signal.removeEventListener("abort", stop);
    await consoleServer?.close();
    // Stop admission everywhere before waiting on managers, slow openings or any
    // store close. An applying agent must not keep siblings listening at shutdown.
    await Promise.allSettled(slots.flatMap((slot) => slot.owned ? [closeStreams(slot.owned)] : []));
    // Closing managers cancels only idle waits, never a running marketplace write.
    await Promise.allSettled(slots.flatMap((slot) => slot.capabilities ? [slot.capabilities.close()] : []));
    // Pending attempts own late results until cleanup finishes. Ready stores close
    // only after their event listeners; a rejected cleanup never permits a retry.
    await Promise.allSettled(slots.map((slot) => slot.pending));
    const failures = await Promise.allSettled(slots.map(async (slot) => {
      if (slot.owned) await closeOwned(slot, slot.owned);
    }));
    const failed = failures.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, env: { type: "string", default: "production" }, "wallet-password-file": { type: "string" }, console: { type: "boolean", default: false }, "console-port": { type: "string", default: "7070" } } });
  if (values.help) {
    process.stdout.write(`Usage: pnpm agents [options]

Run only agents associated with the selected TaskFast environment.
  --env production|staging|development  Select production (default), staging or development
  --console                            Open the local browser console
  --console-port <port>                 Console port (default 7070)
  --wallet-password-file <path>         Fallback for folders without their own unlock file
  --help, -h                           Show this help without opening agents

Production is real money. Mismatched agents are skipped, not retargeted.
`);
    return;
  }
  const file = values["wallet-password-file"];
  if (file !== undefined && !file) throw new Error("--wallet-password-file needs a path");
  const portText = values["console-port"];
  if (!/^\d+$/.test(portText)) throw new Error("--console-port must be a port number");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--console-port must be a port number");
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runAgents({ agentsDir: "agents", env: taskfastEnv(values.env), ...(file === undefined ? {} : { walletPasswordFile: resolve(file) }), ...(values.console ? { console: { port } } : {}), signal: stop.signal, log: (line) => process.stdout.write(`${line}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
