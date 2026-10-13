import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import type { ConsoleView } from "../src/console.js";
import { initialOperator, MESSAGE_PREFIX } from "../src/core/operator.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { buildTimeline } from "../src/core/timeline.js";
import { initialUi, press, setField, type Effect, type Ui } from "../src/tui/keys.js";
import { parseLink } from "../src/tui/link.js";
import { clean, screen } from "../src/tui/screen.js";

const token = "c".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-13T12:00:00Z");
const result = (id: string, name: string, body: unknown): Message => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(body) }], isError: false, timestamp: 2 });

// One poster agent's view as the console sends it: a check-in with four tool calls
// (one failed), an event whose one call is uncertain, and a message from the user.
export function fixtureView(env: ConsoleView["env"] = "local"): ConsoleView {
  const transcript: Message[] = [
    { role: "user", content: "Check your marketplace work in your poster role.", timestamp: Date.parse("2026-10-13T09:00:00Z") },
    fauxAssistantMessage([
      fauxToolCall("task_list", {}, { id: "a" }), fauxToolCall("post_task", { title: "Edit a page" }, { id: "b" }),
      fauxToolCall("escrow_sign", { task_id: TASK }, { id: "c" }), fauxToolCall("message_send", { task_id: TASK, content: "Hi" }, { id: "d" }),
    ], { stopReason: "toolUse" }),
    result("a", "task_list", { tasks: [] }), result("b", "post_task", { task: { id: TASK } }),
    result("c", "escrow_sign", { failed: "insufficient balance" }), result("d", "message_send", {}),
    fauxAssistantMessage("Posted the job.\x1b]0;pwned\x07"),
    { role: "user", content: `Marketplace event:\n${JSON.stringify({ event_id: "e1", event: "bid.created", task_id: TASK })}`, timestamp: Date.parse("2026-10-13T10:00:00Z") },
    fauxAssistantMessage([fauxToolCall("bid_accept", { task_id: TASK, bid_id: "b1" }, { id: "e" })], { stopReason: "toolUse" }),
    result("e", "bid_accept", { uncertain: "timed out" }),
    { role: "user", content: `${MESSAGE_PREFIX}Post one more job.`, timestamp: Date.parse("2026-10-13T11:00:00Z") },
  ];
  return {
    id: "me", env,
    spec: parseAgentSpec(JSON.parse(readFileSync(new URL("../examples/brisk-poster.json", import.meta.url), "utf8"))),
    operator: { ...initialOperator(), paused: true, orders: ["Keep every job under $15."] },
    attention: [
      { kind: "uncertain", id: `bid_accept:${TASK}`, at: "2026-10-13T10:00:01Z", amount: 15 },
      { kind: "abandoned", id: "stuck", attempts: 6, event: { event_id: "stuck", event: "payment_signature_required" } },
      { kind: "dead-letter", id: "dead-letter:bad-1", at: "2026-10-13T08:00:00Z", reason: "no event name\x1b[2J", line: "{\"event_id\":\"bad-1\"}" },
    ],
    events: { "event:e2": { kind: "admitted", event: { event_id: "e2", event: "task.updated" }, attempt: 0 } },
    actions: { [`bid_accept:${TASK}`]: { status: "uncertain", at: "2026-10-13T10:00:01Z", amount: 15, day: "2026-10-13" } } as ConsoleView["actions"],
    spend: { "2026-10-13": 15 },
    notes: [], prompt: "You are a poster.",
    timeline: buildTimeline(transcript),
    host: {
      unlockFile: false, stream: "connected",
      wallet: { balance: { available_balance: "0x1312d00" } },
      tasks: { [TASK]: { task: { id: TASK, title: "Edit a page\x1b[2J", status: "open", budget_max: "15.00" } } },
    },
  };
}

it("draws a view: banner, state, alerts, badges, task cards, sidebar", () => {
  const drawn = screen(fixtureView(), 120, NOW);
  expect(drawn.banner).toEqual({ tone: "development", text: "DEVELOPMENT · local TaskFast server · no real money" });
  expect(drawn.state).toBe("paused · 1 waiting");
  expect(drawn.spend).toEqual({ today: "$15.00", limit: "$50.00", uncertain: "$15.00" });
  expect(drawn.narrow).toBe(false);

  expect(drawn.attention.map(({ kind, title, keys }) => ({ kind, title, keys }))).toEqual([
    { kind: "uncertain", title: `UNCERTAIN ${`bid_accept:${TASK}`}`, keys: "c mark checked" },
    { kind: "abandoned", title: "ABANDONED payment_signature_required · 6 attempts failed", keys: "R run again · r raw event" },
    { kind: "dead-letter", title: "DEAD-LETTERED no event name", keys: "c mark checked" },
  ]);
  expect(drawn.attention[1].raw).toBe(JSON.stringify({ event_id: "stuck", event: "payment_signature_required" }, null, 2));

  expect(drawn.turns.map((turn) => turn.tag)).toEqual(["POLL", "EVENT", "YOU"]);
  expect(drawn.turns[1].title).toBe(`bid.created · task ${TASK}`);
  const [check, done] = drawn.turns[0].replies;
  expect(check.badge).toBe("4 tool calls · 1 failed");
  expect(check.calls.find((call) => call.name === "escrow_sign")).toMatchObject({ outcome: "failed", error: "insufficient balance" });
  expect(check.tasks).toEqual([{ id: TASK, via: "POST_TASK", title: "Edit a page", summary: "open · budget $15.00", link: `http://localhost:4000/tasks/${TASK}` }]);
  expect(done.text).toBe("Posted the job.");
  expect(done.badge).toBeUndefined();
  expect(drawn.turns[1].replies[0].badge).toBe("1 tool call · 1 uncertain");
  expect(drawn.turns[2].replies).toEqual([]);

  expect(drawn.sidebar.readiness).toEqual([
    { label: "Wallet balance", detail: "20.00 USDC", ok: true },
    { label: "Wallet unlock file", detail: "missing · create .taskfast/wallet-password (mode 0400) in the agent folder", ok: false },
    { label: "Event stream", detail: "connected", ok: true },
    { label: "Model", detail: "anthropic:claude-haiku-5-5", ok: true },
    { label: "Spending limits", detail: "$20.00 per job · $50.00 per day", ok: true },
  ]);
  expect(drawn.sidebar.tasks).toEqual({ POSTED: [{ id: TASK, title: "Edit a page" }], BIDDING: [], "WORKING ON": [] });
  expect(drawn.sidebar.orders).toEqual(["Keep every job under $15."]);
});

// Presses keys in order against one view; returns every effect they asked for.
function keys(view: ConsoleView, start: Ui = initialUi()) {
  let ui = start;
  return {
    get ui() { return ui; },
    run(...names: string[]): Effect[] {
      const effects: Effect[] = [];
      for (const name of names) {
        const next = press(ui, name, view, 2);
        ui = next.ui;
        if (next.effect) effects.push(next.effect);
      }
      return effects;
    },
  };
}

it("turns timeline keys into console actions, and asks y/n before freezing", () => {
  const view = fixtureView();
  const k = keys(view);
  expect(k.run("p")).toEqual([{ kind: "call", method: "POST", action: "paused", body: { value: false } }]);
  expect(k.run("f")).toEqual([]);
  expect(k.ui.confirm).toMatchObject({ kind: "freeze" });
  expect(k.run("n")).toEqual([]);
  expect(k.ui.confirm).toBeUndefined();
  expect(k.run("f", "y")).toEqual([{ kind: "call", method: "POST", action: "frozen", body: { value: true } }]);
  expect(keys({ ...view, operator: { ...view.operator, frozen: true } }).run("f")).toEqual([{ kind: "call", method: "POST", action: "frozen", body: { value: false } }]);

  // Alerts: c and R act on the selected one; tab moves to the alerts panel, where r shows the raw event.
  expect(k.run("c")).toEqual([{ kind: "call", method: "POST", action: "checked", body: { id: `bid_accept:${TASK}` } }]);
  expect(k.run("tab", "j", "R")).toEqual([{ kind: "call", method: "POST", action: "retry", body: { eventId: "stuck" } }]);
  k.run("r");
  expect(k.ui.raw).toContain("alert:stuck");
  expect(k.run("j", "c")).toEqual([{ kind: "call", method: "POST", action: "checked", body: { id: "dead-letter:bad-1" } }]);

  // Timeline: j/k move between replies, enter shows tool calls, o opens the task, r the raw event.
  k.run("tab", "tab");
  expect(k.ui.panel).toBe("timeline");
  k.run("enter");
  expect(k.ui.open).toEqual(["t0r0"]);
  expect(k.run("o")).toEqual([{ kind: "open", url: `http://localhost:4000/tasks/${TASK}` }]);
  k.run("j", "j", "r");
  expect(k.ui.reply).toBe(2);
  expect(k.ui.raw).toContain("turn:1");
  k.run("G");
  expect(k.ui.reply).toBe(3);
  k.run("g");
  expect(k.ui.reply).toBe(0);

  expect(k.run(">")).toEqual([{ kind: "agent", index: 1 }]);
  expect(k.run(">")).toEqual([{ kind: "agent", index: 0 }]);
  expect(k.run("<")).toEqual([{ kind: "agent", index: 1 }]);
  k.run("?");
  expect(k.ui.help).toBe(true);
  k.run("?", "i", "a", "m");
  expect(k.ui).toMatchObject({ help: false, sidebar: true, alerts: true, editing: "message" });
  expect(k.run("q")).toEqual([{ kind: "quit" }]);
});

it("edits the briefing: orders, fields, and save only after y/n, with spending changes spelled out", () => {
  const view = fixtureView();
  const k = keys(view);
  k.run("2");
  expect(k.ui.tab).toBe("briefing");
  k.run("a");
  expect(k.ui.editing).toBe("order");
  expect(k.run("d")).toEqual([{ kind: "call", method: "DELETE", action: "orders/0" }]);

  let ui = setField(k.ui, view, "perJobUsd", "30");
  ui = setField(ui, view, "goals", "get photo edits done");
  expect(ui.draft).toMatchObject({ character: { goals: "get photo edits done" }, limits: { perJobUsd: 30, dailyUsd: 50 } });
  const saving = keys(view, ui);
  expect(saving.run("ctrl+s")).toEqual([]);
  expect(saving.ui.confirm).toEqual({ kind: "save", lines: ["Per job limit $20.00 → $30.00"] });
  expect(saving.run("y")).toEqual([{ kind: "call", method: "PUT", action: "spec", body: ui.draft }]);
  expect(saving.ui.draft).toBeUndefined();

  const discarding = keys(view, setField(k.ui, view, "dailyUsd", ""));
  expect(discarding.ui.draft?.limits).toEqual({ perJobUsd: 20 });
  discarding.run("escape");
  expect(discarding.ui.draft).toBeUndefined();
  expect(discarding.run("1", "q")).toEqual([{ kind: "quit" }]);
});

it("offers retry and quit when the console can't be reached", () => {
  expect(press(initialUi(), "r", undefined, 0).effect).toEqual({ kind: "retry" });
  expect(press(initialUi(), "q", undefined, 0).effect).toEqual({ kind: "quit" });
  expect(press(initialUi(), "p", undefined, 0).effect).toBeUndefined();
});

it("links tasks only in development, flags production, and stacks below 100 columns", () => {
  const production = screen(fixtureView("prod"), 99, NOW);
  expect(production.banner.tone).toBe("production");
  expect(production.narrow).toBe(true);
  expect(production.turns[0].replies[0].tasks[0].link).toBeUndefined();
  expect(screen(fixtureView("staging"), 100, NOW)).toMatchObject({ banner: { tone: "staging" }, narrow: false });
});

it("strips escape and control sequences from marketplace and model text", () => {
  const hostile = [
    "Done\x1b[2J\x1b[H",                                  // clear screen, cursor home
    "\x1b]0;pwned title\x07",                            // window title (BEL)
    "\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\", // OSC 8 hyperlink (ST)
    "\x9b31mred\x9bm",                                   // 8-bit CSI
    "bell\x07 back\x08 nul\x00 del\x7f",
    "\x1bPq#0;2;0;0;0\x1b\\",                            // DCS
    "\x1b7saved\x1b8",                                   // save/restore cursor
  ].join("");
  expect(clean(hostile)).toBe("Doneclickredbell back nul delsaved");
  expect(clean("line one\nline two\ttabbed · café ✓")).toBe("line one\nline two\ttabbed · café ✓");
});

it("takes the console link from the argument or TASKFAST_CONSOLE_URL, and never repeats the token", () => {
  expect(parseLink(`http://127.0.0.1:7070/#token=${token}`, undefined)).toEqual({ origin: "http://127.0.0.1:7070", token });
  expect(parseLink(undefined, `http://localhost:7071/#token=${token}`)).toEqual({ origin: "http://localhost:7071", token });
  expect(parseLink(`http://127.0.0.1:7070/#token=${token}`, "http://127.0.0.1:1/#token=x")).toMatchObject({ origin: "http://127.0.0.1:7070" });
  const refusals = [
    [undefined, undefined],
    ["not a link", undefined],
    [`http://127.0.0.1:7070/`, undefined],
    [`http://127.0.0.1:7070/?token=${token}`, undefined],
    [`http://evil.example:7070/#token=${token}`, undefined],
    [`https://127.0.0.1:7070/#token=${token}`, undefined],
    [`http://127.0.0.1:7070/#token=${token.slice(1)}`, undefined],
  ] as const;
  for (const [arg, env] of refusals) {
    let message = "";
    try { parseLink(arg, env); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/pnpm tui/);
    expect(message).not.toContain(token.slice(0, 16));
  }
});
