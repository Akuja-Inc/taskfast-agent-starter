// What the terminal UI draws, worked out from one console view. Pure: no terminal,
// no network. Imports from the host are types only, so Bun loads none of it.
import type { AgentRosterEntry } from "../console-lifecycle.js";
import type { ConsoleView } from "../console.js";
import type { Call, Turn } from "../core/timeline.js";

// Escape and control sequences (OSC titles and hyperlinks, DCS, CSI, two-byte escapes),
// then any other control character but tab and newline. Server and model text pass
// through here, so a message can't move the cursor, retitle the window or add a link.
// The one link a reply can add is a markdown http(s) link, which app.tsx draws with its
// address printed beside it.
const CONTROL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][\s\S]*?(?:\x1b\\|\x07|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export const clean = (text: string): string => text.replace(CONTROL, "");

// Below this many columns the sidebar and alerts fold away behind `i` and `a`.
export const NARROW = 100;
const BANNER = {
  local: { tone: "development", text: "DEVELOPMENT · local TaskFast server · no real money" },
  staging: { tone: "staging", text: "STAGING · testnet funds" },
  prod: { tone: "production", text: "PRODUCTION · real money · every post and escrow spends USDC" },
} as const;
export const environmentBanner = (env: ConsoleView["env"]) => BANNER[env];
export function startupScreen(agent: AgentRosterEntry) {
  return {
    title: agent.state === "stopped" ? "Agent stopped" : agent.state === "starting" ? "Agent starting" : "Loading agent",
    detail: agent.state === "stopped" ? clean(agent.reason) : agent.state === "starting" && agent.phase === "waiting-for-close"
      ? "Waiting for the previous attempt to close. The store stays protected."
      : agent.state === "starting" ? "Opening the agent. Other agents can keep running." : "Loading the durable agent view.",
    action: agent.state === "stopped" ? "R retry startup" : agent.state === "starting" ? "x cancel startup" : "",
  };
}
const TAG = { poll: "POLL", event: "EVENT", operator: "YOU", resume: "RESUME", other: "INPUT" } as const;
// Which list a task joins, by the tool that touched it (as on the web page).
const GROUP: Record<string, "POSTED" | "BIDDING" | "WORKING ON"> = {
  post_task: "POSTED", bid_accept: "POSTED", bid_reject: "POSTED", escrow_sign: "POSTED",
  bid_create: "BIDDING", task_claim: "WORKING ON", task_submit: "WORKING ON",
};

const money = (n: unknown) => `$${Number(n ?? 0).toFixed(2)}`;
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);
const json = (value: unknown) => clean(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const WEB = { local: "http://localhost:4000", staging: "https://staging.taskfast.app", prod: "https://taskfast.app" } as const;
export const taskLink = (env: ConsoleView["env"], id: string) => `${WEB[env]}/tasks/${encodeURIComponent(id)}`;

function usdc(wallet: unknown): string {
  const raw = field(field(wallet, "balance"), "available_balance");
  if (typeof raw !== "string") return field(wallet, "error") ? `unavailable: ${clean(String(field(wallet, "error")))}` : "unknown";
  try { return `${(Number(BigInt(raw)) / 1e6).toFixed(2)} USDC`; } catch { return clean(raw); }
}
function task(view: ConsoleView, id: string) {
  const read = view.host?.tasks[id];
  const detail = field(read, "task") ?? read;
  if (!detail || field(read, "error")) return { title: id, summary: field(read, "error") ? `could not read: ${clean(String(field(read, "error")))}` : "" };
  const parts = [field(detail, "status"), field(detail, "budget_max") ? `budget ${money(field(detail, "budget_max"))}` : undefined, field(detail, "worker_agent_id") ? "worker assigned" : undefined];
  return { title: clean(String(field(detail, "title") ?? id)), summary: clean(parts.filter(Boolean).join(" · ")) };
}
function badge(calls: Call[]): string | undefined {
  if (!calls.length) return undefined;
  const failed = calls.filter((call) => call.outcome === "failed").length;
  const uncertain = calls.filter((call) => call.outcome === "uncertain").length;
  return [plural(calls.length, "tool call"), failed ? `${failed} failed` : "", uncertain ? `${uncertain} uncertain` : ""].filter(Boolean).join(" · ");
}
function eventTask(turn: Turn): string | undefined {
  const taskId = turn.kind === "event" ? field(turn.event, "task_id") : undefined;
  return typeof taskId === "string" ? taskId : undefined;
}
function eventLink(env: ConsoleView["env"], turn: Turn): string | undefined {
  const taskId = eventTask(turn);
  return taskId === undefined ? undefined : taskLink(env, taskId);
}
function title(turn: Turn): string {
  if (turn.kind !== "event") return clean(turn.text);
  const name = field(turn.event, "event");
  const taskId = eventTask(turn);
  return clean(`${typeof name === "string" ? name : "event"}${taskId ? ` · task ${taskId}` : ""}`);
}

export type Screen = ReturnType<typeof screen>;
export function screen(view: ConsoleView, width: number, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const op = view.operator;
  const waiting = Object.values(view.events).filter((work) => work.kind === "admitted").length + view.queuedMessages.length;
  const limits = view.spec.limits ?? {};
  const hasLimits = limits.perJobUsd !== undefined || limits.dailyUsd !== undefined;
  const wallet = usdc(view.host?.wallet);
  type SideTask = { id: string; title: string; link: string };
  const groups = { POSTED: new Map<string, SideTask>(), BIDDING: new Map<string, SideTask>(), "WORKING ON": new Map<string, SideTask>() };
  const turns = view.timeline.map((turn) => ({
    tag: TAG[turn.kind],
    at: turn.at,
    title: title(turn),
    link: eventLink(view.env, turn),
    raw: turn.kind === "event" ? json(turn.event ?? turn.text) : undefined,
    replies: turn.replies.map((reply, r) => ({
      // Keyed by the turn's timestamp plus the reply's place in it, so selection and
      // open lines reattach to the same content when the transcript window slides.
      key: `${turn.at}r${r}`,
      text: clean(reply.text),
      badge: badge(reply.calls),
      calls: reply.calls.map((call) => ({ name: clean(call.name), outcome: call.outcome, arguments: clean(JSON.stringify(call.arguments)), error: call.error === undefined ? undefined : clean(call.error) })),
      tasks: reply.tasks.map((ref) => {
        const group = GROUP[ref.via];
        const { title: name, summary } = task(view, ref.id);
        const link = taskLink(view.env, ref.id);
        if (group) groups[group].set(ref.id, { id: ref.id, title: name, link });
        return { id: ref.id, via: clean(ref.via).toUpperCase(), title: name, summary, link };
      }),
    })),
  }));
  return {
    banner: BANNER[view.env],
    state: op.paused ? `paused · ${waiting} waiting` : "running",
    frozen: op.frozen,
    narrow: width < NARROW,
    spend: {
      today: money(view.spend[today]),
      limit: limits.dailyUsd === undefined ? undefined : money(limits.dailyUsd),
      uncertain: money(Object.values(view.actions).filter((action) => action.status === "uncertain" && action.day === today).reduce((sum, action) => sum + action.amount, 0)),
    },
    attention: view.attention.map((item) => {
      if (item.kind === "uncertain") return { kind: item.kind, id: item.id, title: `UNCERTAIN ${clean(item.id)}`, detail: `${money(item.amount)} is counted as spent and will not be retried. Check the task on TaskFast, then mark it checked.`, keys: "c mark checked" };
      if (item.kind === "abandoned") {
        const name = field(item.event, "event");
        return { kind: item.kind, id: item.id, title: `ABANDONED ${clean(typeof name === "string" ? name : item.id)} · ${item.attempts} attempts failed`, detail: "Run again queues one fresh attempt.", keys: "R run again · r raw event", raw: json(item.event) };
      }
      return { kind: item.kind, id: item.id, title: `DEAD-LETTERED ${clean(item.reason)}`, detail: `The stream gave up on this event at ${clean(item.at)} and acknowledged it.`, keys: "c mark checked", raw: json(item.line) };
    }),
    turns,
    sidebar: {
      queued: view.queuedMessages.map(({ requestId, text, mode }) => ({ requestId, text: clean(text), mode, label: mode === "steer" ? "Steer" : "Follow-up" })),
      readiness: [
        { label: "Wallet balance", detail: wallet, ok: !/^0\.00 |unavailable|unknown/.test(wallet) },
        { label: "Wallet unlock file", detail: view.host?.unlockFile ? "present" : "missing · create .taskfast/wallet-password (mode 0400) in the agent folder", ok: Boolean(view.host?.unlockFile) },
        { label: "Event stream", detail: clean(view.host?.stream ?? "unknown"), ok: view.host?.stream === "connected" },
        { label: "Model", detail: clean(view.spec.model), ok: true },
        { label: "Spending limits", detail: hasLimits ? [limits.perJobUsd !== undefined ? `${money(limits.perJobUsd)} per job` : "", limits.dailyUsd !== undefined ? `${money(limits.dailyUsd)} per day` : ""].filter(Boolean).join(" · ") : "none: nothing caps commitments", ok: hasLimits },
      ],
      tasks: Object.fromEntries(Object.entries(groups).map(([name, refs]) => [name, [...refs.values()]])) as Record<keyof typeof groups, SideTask[]>,
      orders: op.orders.map(clean),
    },
  };
}
