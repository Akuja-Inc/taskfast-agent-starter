// What each key does in the terminal UI. Pure: it returns the next UI state and at
// most one effect for the app to carry out. Every change to an agent is a console API
// call; the UI never sets an amount and quitting never touches the host.
import type { AgentRosterEntry, StartupAction } from "../console-lifecycle.js";
import type { ConsoleView } from "../console.js";
import type { AgentSpec } from "../core/types.js";
import { screen } from "./screen.js";

export interface Ui {
  tab: "timeline" | "settings";
  agent: number;
  panel: "timeline" | "attention" | "queue" | "orders" | "fields";
  // Never fall back to an index when a selected message leaves during a refresh.
  queuedRequestId?: string;
  // Selected timeline item (a reply, or a turn without one) and alert.
  reply: number;
  alert: number;
  // Replies whose tool calls show, and turns or alerts whose raw event shows.
  open: string[];
  raw: string[];
  // A question waiting for y or n.
  confirm?: { kind: "freeze" } | { kind: "save"; lines: string[] };
  help: boolean;
  // Narrow terminals fold these away.
  sidebar: boolean;
  alerts: boolean;
  // Which line has the keyboard. The message composer also handles Ctrl+S.
  editing?: "message" | "order" | Field;
  messageText: string;
  // Settings: selected order and field, and the agent file being edited.
  order: number;
  field: number;
  draft?: AgentSpec;
}
export type Effect =
  | { kind: "call"; method: "POST" | "PUT" | "DELETE"; action: string; body?: unknown }
  | { kind: "notice"; text: string }
  | { kind: "message"; text: string; mode: MessageMode }
  | { kind: "open"; url: string }
  | { kind: "agent"; index: number }
  | { kind: "startup"; intent: StartupAction }
  | { kind: "retry" }
  | { kind: "quit" };
export const initialUi = (agent = 0): Ui => ({ agent, tab: "timeline", panel: "timeline", reply: 0, alert: 0, open: [], raw: [], help: false, sidebar: false, alerts: false, order: 0, field: 0, messageText: "" });

export type MessageMode = ConsoleView["queuedMessages"][number]["mode"];
export type MessageAttempt = { requestId: string; text: string; mode: MessageMode };
// A retry of the same text keeps both identity and mode, even if the other shortcut
// was used. The server might have accepted the first attempt before the link failed.
export function messageAttempt(previous: MessageAttempt | undefined, text: string, mode: MessageMode, requestId: string): MessageAttempt {
  return previous?.text === text.trim() ? previous : { requestId, text: text.trim(), mode };
}
export function messageBody(attempt: MessageAttempt) {
  return { requestId: attempt.requestId, text: attempt.text, ...(attempt.mode === "steer" ? { steer: true } : {}) };
}
const ALREADY_PLACED = "The agent already has this message.";
export function actionError(action: string, status: number | undefined, reason: string): string {
  return (action.startsWith("steer/") || action.startsWith("messages/")) && (status === 404 || status === 409) ? ALREADY_PLACED : reason;
}

// Only an acknowledged withdrawal deliberately picks a new row. An unexpected live
// disappearance keeps the stale ID guard until the user navigates to another row.
export function withdrawnSelection(ui: Ui, requestId: string, before: ConsoleView["queuedMessages"], after: ConsoleView["queuedMessages"]): Ui {
  if (ui.panel !== "queue" || ui.queuedRequestId !== requestId) return ui;
  const remaining = after.filter((row) => row.requestId !== requestId);
  const at = before.findIndex((row) => row.requestId === requestId);
  const neighbors = [...before.slice(at + 1), ...before.slice(0, Math.max(0, at)).reverse()];
  const next = neighbors.find((row) => remaining.some((visible) => visible.requestId === row.requestId)) ?? remaining[0];
  return { ...ui, panel: next ? "queue" : "timeline", queuedRequestId: next?.requestId };
}

// The agent.json fields the settings page edits, in the order it lists them. INSTRUCTIONS.md is
// multi-line text, so only the web console edits it.
export const FIELDS = ["temperament", "perJobUsd", "dailyUsd", "competence", "diligence", "priceSensitivity"] as const;
export type Field = typeof FIELDS[number];
export function fieldValue(spec: AgentSpec, field: Field): string {
  if (field === "perJobUsd" || field === "dailyUsd") return spec.limits?.[field]?.toString() ?? "";
  return String(spec.dials[field]);
}
// Sets one field on the draft. Numbers are parsed here and checked by the server's
// strict agent-file parser on save; an empty limit removes it.
export function setField(ui: Ui, view: ConsoleView, field: Field, value: string): Ui {
  const draft: AgentSpec = structuredClone(ui.draft ?? view.spec);
  if (field === "temperament") draft.dials.temperament = value as AgentSpec["dials"]["temperament"];
  else if (field === "perJobUsd" || field === "dailyUsd") {
    const limits = { ...draft.limits };
    if (value.trim() === "") delete limits[field];
    else limits[field] = Number(value);
    if (Object.keys(limits).length) draft.limits = limits;
    else delete draft.limits;
  } else draft.dials[field] = Number(value);
  return { ...ui, draft };
}

const money = (n: number | undefined) => (n === undefined ? "none" : Number.isFinite(n) ? `$${n.toFixed(2)}` : "invalid");
const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);
const clamp = (n: number, count: number) => Math.max(0, Math.min(n, count - 1));
const PANELS: Ui["panel"][] = ["timeline", "attention", "queue"];

export function press(ui: Ui, key: string, view: ConsoleView | undefined, agents: number, lifecycle?: AgentRosterEntry, busy = false): { ui: Ui; effect?: Effect } {
  if (!view) {
    if (ui.editing === "message") {
      if (key === "escape") return { ui: { ...ui, editing: undefined } };
      return { ui, effect: key === "enter" || key === "ctrl+s" ? { kind: "notice", text: "Not queued: the agent is not ready. Your draft is kept." } : undefined };
    }
    if ((key === "<" || key === ">") && agents > 0) {
      const index = (ui.agent + (key === ">" ? 1 : -1) + agents) % agents;
      return { ui: initialUi(index), effect: { kind: "agent", index } };
    }
    if (key === "?" || key === "escape") return { ui: { ...ui, help: key === "?" ? !ui.help : false } };
    if (!busy && lifecycle && ((key === "x" && lifecycle.state === "starting") || (key === "R" && lifecycle.state === "stopped"))) {
      return { ui, effect: { kind: "startup", intent: { id: lifecycle.id, generation: lifecycle.generation, action: key === "x" ? "cancel" : "retry" } } };
    }
    return { ui, effect: key === "r" ? { kind: "retry" } : key === "q" ? { kind: "quit" } : key === "m" || key === "ctrl+s" || (key === "enter" && !!ui.messageText.trim()) ? { kind: "notice", text: "Not queued: the agent is not ready. Your draft is kept." } : undefined };
  }
  const call = (method: "POST" | "PUT" | "DELETE", action: string, body?: unknown): Effect => ({ kind: "call", method, action, ...(body === undefined ? {} : { body }) });
  if (ui.confirm) {
    if (key === "y") {
      const effect = ui.confirm.kind === "freeze" ? call("POST", "frozen", { value: true }) : call("PUT", "spec", ui.draft);
      return { ui: { ...ui, confirm: undefined }, effect };
    }
    return { ui: key === "n" || key === "escape" ? { ...ui, confirm: undefined } : ui };
  }
  if (ui.help && key !== "q") return { ui: key === "?" || key === "escape" ? { ...ui, help: false } : ui };
  if (ui.tab === "timeline" && ui.editing === "message") {
    if (key === "escape") return { ui: { ...ui, editing: undefined } };
    const text = ui.messageText.trim();
    if (text && (key === "enter" || key === "ctrl+s")) return { ui, effect: { kind: "message", text, mode: key === "ctrl+s" ? "steer" : "followUp" } };
    return { ui };
  }
  const drawn = screen(view, 0);
  const items = drawn.turns.flatMap((turn): { turn: typeof turn; reply?: typeof turn.replies[number] }[] => (turn.replies.length ? turn.replies.map((reply) => ({ turn, reply })) : [{ turn }]));
  const selected = items[clamp(ui.reply, items.length)];
  const alert = drawn.attention[clamp(ui.alert, drawn.attention.length)];
  const queue = view.queuedMessages;
  const moveQueue = (by: number): Ui => {
    const at = queue.findIndex((message) => message.requestId === ui.queuedRequestId);
    const from = at < 0 ? (by < 0 ? queue.length : -1) : at;
    return { ...ui, queuedRequestId: queue[clamp(from + by, queue.length)]?.requestId };
  };
  const move = (by: number) => (ui.tab === "settings"
    ? (ui.panel === "orders" ? { ...ui, order: clamp(ui.order + by, view.operator.orders.length) } : { ...ui, field: clamp(ui.field + by, FIELDS.length) })
    : ui.panel === "queue" ? moveQueue(by)
    : ui.panel === "attention" ? { ...ui, alert: clamp(ui.alert + by, drawn.attention.length) } : { ...ui, reply: clamp(ui.reply + by, items.length) });
  switch (key) {
    case "q": return { ui, effect: { kind: "quit" } };
    case "?": return { ui: { ...ui, help: true } };
    case "1": return { ui: { ...ui, tab: "timeline", panel: "timeline" } };
    case "2": return { ui: { ...ui, tab: "settings", panel: "orders" } };
    case "<": case ">": {
      const index = (ui.agent + (key === ">" ? 1 : -1) + agents) % agents;
      return { ui: initialUi(index), effect: { kind: "agent", index } };
    }
    case "tab": {
      if (ui.tab === "settings") return { ui: { ...ui, panel: ui.panel === "orders" ? "fields" : "orders" } };
      const panel = PANELS[(PANELS.indexOf(ui.panel) + 1) % PANELS.length];
      return { ui: { ...ui, panel, ...(panel === "queue" ? { sidebar: true, queuedRequestId: ui.queuedRequestId ?? queue[0]?.requestId } : {}) } };
    }
    case "j": case "down": return { ui: move(1) };
    case "k": case "up": return { ui: move(-1) };
    case "g": return { ui: move(-Infinity) };
    case "G": return { ui: move(Infinity) };
    case "p": return { ui, effect: call("POST", "paused", { value: !view.operator.paused }) };
    case "f": return view.operator.frozen ? { ui, effect: call("POST", "frozen", { value: false }) } : { ui: { ...ui, confirm: { kind: "freeze" } } };
    case "m": return { ui: { ...ui, tab: "timeline", editing: "message" } };
    case "escape": return { ui: { ...ui, editing: undefined, draft: ui.tab === "settings" ? undefined : ui.draft } };
  }
  if (ui.tab === "settings") {
    if (key === "a") return { ui: { ...ui, editing: "order" } };
    if (key === "d" && view.operator.orders.length) {
      const at = clamp(ui.order, view.operator.orders.length);
      // The server removes only the order the TUI shows at that index.
      return { ui, effect: call("DELETE", `orders/${at}`, { expect: view.operator.orders[at] }) };
    }
    if (key === "enter" && ui.panel === "fields") return { ui: { ...ui, editing: FIELDS[ui.field] } };
    if (key === "ctrl+s" && ui.draft) {
      const before = view.spec.limits ?? {};
      const after = ui.draft.limits ?? {};
      const lines = (["perJobUsd", "dailyUsd"] as const).filter((limit) => before[limit] !== after[limit])
        .map((limit) => `${limit === "perJobUsd" ? "Per job" : "Daily"} limit ${money(before[limit])} → ${money(after[limit])}`);
      return { ui: { ...ui, confirm: { kind: "save", lines } } };
    }
    return { ui };
  }
  switch (key) {
    case "i": return { ui: { ...ui, sidebar: !ui.sidebar, panel: ui.sidebar && ui.panel === "queue" ? "timeline" : ui.panel } };
    case "s": case "w": {
      const message = ui.panel === "queue" ? queue.find((item) => item.requestId === ui.queuedRequestId) : undefined;
      if (ui.panel === "queue" && ui.queuedRequestId && !message) return { ui, effect: { kind: "notice", text: ALREADY_PLACED } };
      if (!message) return { ui };
      if (key === "w") return { ui, effect: call("DELETE", `messages/${encodeURIComponent(message.requestId)}`) };
      return message.mode === "followUp" ? { ui, effect: call("POST", `steer/${encodeURIComponent(message.requestId)}`) } : { ui };
    }
    case "a": return { ui: { ...ui, alerts: !ui.alerts } };
    case "c": return alert && alert.kind !== "abandoned" ? { ui, effect: call("POST", "checked", { id: alert.id }) } : { ui };
    case "R": return alert?.kind === "abandoned" ? { ui, effect: call("POST", "retry", { eventId: alert.id }) } : { ui };
    case "r":
      if (ui.panel === "attention") return { ui: alert?.raw ? { ...ui, raw: toggle(ui.raw, `alert:${alert.id}`) } : ui };
      return { ui: selected && selected.turn.raw ? { ...ui, raw: toggle(ui.raw, `turn:${selected.turn.at}`) } : ui };
    case "enter": return { ui: selected?.reply?.badge ? { ...ui, open: toggle(ui.open, selected.reply.key) } : ui };
    case "o": {
      const link = selected?.reply?.tasks[0]?.link ?? selected?.turn.link;
      return link ? { ui, effect: { kind: "open", url: link } } : { ui };
    }
  }
  return { ui };
}
