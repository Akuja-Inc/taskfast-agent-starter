// What each key does in the terminal UI. Pure: it returns the next UI state and at
// most one effect for the app to carry out. Every change to an agent is a console API
// call; the UI never sets an amount and quitting never touches the host.
import type { ConsoleView } from "../console.js";
import type { AgentSpec } from "../core/types.js";
import { screen } from "./screen.js";

export interface Ui {
  tab: "timeline" | "briefing";
  agent: number;
  panel: "timeline" | "attention" | "sidebar" | "orders" | "fields";
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
  // Which line has the keyboard: keys go to it, not here, until enter or escape.
  editing?: "message" | "order" | Field;
  // Briefing: selected order and field, and the agent file being edited.
  order: number;
  field: number;
  draft?: AgentSpec;
}
export type Effect =
  | { kind: "call"; method: "POST" | "PUT" | "DELETE"; action: string; body?: unknown }
  | { kind: "open"; url: string }
  | { kind: "agent"; index: number }
  | { kind: "retry" }
  | { kind: "quit" };
export const initialUi = (agent = 0): Ui => ({ agent, tab: "timeline", panel: "timeline", reply: 0, alert: 0, open: [], raw: [], help: false, sidebar: false, alerts: false, order: 0, field: 0 });

// The agent-file fields the briefing edits, in the order it lists them.
export const FIELDS = ["goals", "temperament", "perJobUsd", "dailyUsd", "competence", "diligence", "priceSensitivity"] as const;
export type Field = typeof FIELDS[number];
export function fieldValue(spec: AgentSpec, field: Field): string {
  if (field === "goals") return spec.character.goals;
  if (field === "perJobUsd" || field === "dailyUsd") return spec.limits?.[field]?.toString() ?? "";
  return String(spec.dials[field]);
}
// Sets one field on the draft. Numbers are parsed here and checked by the server's
// strict agent-file parser on save; an empty limit removes it.
export function setField(ui: Ui, view: ConsoleView, field: Field, value: string): Ui {
  const draft: AgentSpec = structuredClone(ui.draft ?? view.spec);
  if (field === "goals") draft.character.goals = value;
  else if (field === "temperament") draft.dials.temperament = value as AgentSpec["dials"]["temperament"];
  else if (field === "perJobUsd" || field === "dailyUsd") {
    const limits = { ...draft.limits };
    if (value.trim() === "") delete limits[field];
    else limits[field] = Number(value);
    if (Object.keys(limits).length) draft.limits = limits;
    else delete draft.limits;
  } else draft.dials[field] = Number(value);
  return { ...ui, draft };
}

const money = (n: number | undefined) => (n === undefined ? "none" : `$${n.toFixed(2)}`);
const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);
const clamp = (n: number, count: number) => Math.max(0, Math.min(n, count - 1));
const PANELS: Ui["panel"][] = ["timeline", "attention", "sidebar"];

export function press(ui: Ui, key: string, view: ConsoleView | undefined, agents: number): { ui: Ui; effect?: Effect } {
  // Can't reach the console: only retry and quit.
  if (!view) return { ui, effect: key === "r" ? { kind: "retry" } : key === "q" ? { kind: "quit" } : undefined };
  const call = (method: "POST" | "PUT" | "DELETE", action: string, body?: unknown): Effect => ({ kind: "call", method, action, ...(body === undefined ? {} : { body }) });
  if (ui.confirm) {
    if (key === "y") {
      const effect = ui.confirm.kind === "freeze" ? call("POST", "frozen", { value: true }) : call("PUT", "spec", ui.draft);
      return { ui: { ...ui, confirm: undefined, draft: ui.confirm.kind === "save" ? undefined : ui.draft }, effect };
    }
    return { ui: key === "n" || key === "escape" ? { ...ui, confirm: undefined } : ui };
  }
  if (ui.help && key !== "q") return { ui: key === "?" || key === "escape" ? { ...ui, help: false } : ui };
  const drawn = screen(view, 0);
  const items = drawn.turns.flatMap((turn, t): { t: number; reply?: typeof turn.replies[number] }[] => (turn.replies.length ? turn.replies.map((reply) => ({ t, reply })) : [{ t }]));
  const selected = items[clamp(ui.reply, items.length)];
  const alert = drawn.attention[clamp(ui.alert, drawn.attention.length)];
  const move = (by: number) => (ui.tab === "briefing"
    ? (ui.panel === "orders" ? { ...ui, order: clamp(ui.order + by, view.operator.orders.length) } : { ...ui, field: clamp(ui.field + by, FIELDS.length) })
    : ui.panel === "attention" ? { ...ui, alert: clamp(ui.alert + by, drawn.attention.length) } : { ...ui, reply: clamp(ui.reply + by, items.length) });
  switch (key) {
    case "q": return { ui, effect: { kind: "quit" } };
    case "?": return { ui: { ...ui, help: true } };
    case "1": return { ui: { ...ui, tab: "timeline", panel: "timeline" } };
    case "2": return { ui: { ...ui, tab: "briefing", panel: "orders" } };
    case "<": case ">": {
      const index = (ui.agent + (key === ">" ? 1 : -1) + agents) % agents;
      return { ui: initialUi(index), effect: { kind: "agent", index } };
    }
    case "tab": {
      if (ui.tab === "briefing") return { ui: { ...ui, panel: ui.panel === "orders" ? "fields" : "orders" } };
      return { ui: { ...ui, panel: PANELS[(PANELS.indexOf(ui.panel) + 1) % PANELS.length] } };
    }
    case "j": case "down": return { ui: move(1) };
    case "k": case "up": return { ui: move(-1) };
    case "g": return { ui: move(-Infinity) };
    case "G": return { ui: move(Infinity) };
    case "p": return { ui, effect: call("POST", "paused", { value: !view.operator.paused }) };
    case "f": return view.operator.frozen ? { ui, effect: call("POST", "frozen", { value: false }) } : { ui: { ...ui, confirm: { kind: "freeze" } } };
    case "m": return { ui: { ...ui, tab: "timeline", editing: "message" } };
    case "escape": return { ui: { ...ui, editing: undefined, draft: undefined } };
  }
  if (ui.tab === "briefing") {
    if (key === "a") return { ui: { ...ui, editing: "order" } };
    if (key === "d" && view.operator.orders.length) return { ui, effect: call("DELETE", `orders/${clamp(ui.order, view.operator.orders.length)}`) };
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
    case "i": return { ui: { ...ui, sidebar: !ui.sidebar } };
    case "a": return { ui: { ...ui, alerts: !ui.alerts } };
    case "c": return alert && alert.kind !== "abandoned" ? { ui, effect: call("POST", "checked", { id: alert.id }) } : { ui };
    case "R": return alert?.kind === "abandoned" ? { ui, effect: call("POST", "retry", { eventId: alert.id }) } : { ui };
    case "r":
      if (ui.panel === "attention") return { ui: alert?.raw ? { ...ui, raw: toggle(ui.raw, `alert:${alert.id}`) } : ui };
      return { ui: selected && drawn.turns[selected.t].raw ? { ...ui, raw: toggle(ui.raw, `turn:${selected.t}`) } : ui };
    case "enter": return { ui: selected?.reply?.badge ? { ...ui, open: toggle(ui.open, selected.reply.key) } : ui };
    case "o": {
      const link = selected?.reply?.tasks.find((task) => task.link)?.link;
      return link ? { ui, effect: { kind: "open", url: link } } : { ui };
    }
  }
  return { ui };
}
