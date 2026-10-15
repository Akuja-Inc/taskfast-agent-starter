import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import type { ConsoleView } from "../src/console.js";
import { initialOperator, MESSAGE_PREFIX } from "../src/core/operator.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { buildTimeline } from "../src/core/timeline.js";
import { actionError, initialUi, messageAttempt, messageBody, press, setField, withdrawnSelection, type Effect, type Ui } from "../src/tui/keys.js";
import { parseLink } from "../src/tui/link.js";
import { clean, screen } from "../src/tui/screen.js";
import { example } from "./example.js";

const token = "c".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-13T12:00:00Z");
const result = (id: string, name: string, body: unknown): Message => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(body) }], isError: false, timestamp: 2 });

// One poster agent's view as the console sends it: a check-in with four tool calls
// (one failed), an event whose one call is uncertain, and a message from the user.
function fixtureView(env: ConsoleView["env"] = "local"): ConsoleView {
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
    id: "me", env, queuedMessages: [],
    spec: parseAgentSpec(example("brisk-poster")),
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

it("shows queued modes safely and steers only a deliberately selected request ID", () => {
  const view = fixtureView();
  view.queuedMessages = [
    { requestId: "old", text: "Wait\x1b[2J for the answer", mode: "followUp" },
    { requestId: "chosen", text: "Change direction", mode: "followUp" },
    { requestId: "direct", text: "Already steering", mode: "steer" },
  ];
  const drawn = screen(view, 90, NOW);
  expect(drawn.sidebar.queued).toEqual([
    { requestId: "old", text: "Wait for the answer", mode: "followUp", label: "Follow-up" },
    { requestId: "chosen", text: "Change direction", mode: "followUp", label: "Follow-up" },
    { requestId: "direct", text: "Already steering", mode: "steer", label: "Steer" },
  ]);
  expect(drawn.state).toBe("paused · 4 waiting");
  const k = keys(view);
  expect(k.run("s")).toEqual([]);
  k.run("tab", "tab", "j");
  expect(k.ui).toMatchObject({ panel: "queue", queuedRequestId: "chosen", sidebar: true });
  // The earlier row leaves, shifting indices. Selection still names the same message.
  view.queuedMessages.shift();
  expect(k.run("s")).toEqual([{ kind: "call", method: "POST", action: "steer/chosen" }]);
  view.queuedMessages.shift();
  expect(k.run("s")).toEqual([{ kind: "notice", text: "The agent already has this message." }]); // Never promote the row that took its index.
  k.run("j");
  expect(k.ui.queuedRequestId).toBe("direct");
  expect(k.run("s")).toEqual([]);
  k.run("i");
  expect(k.ui).toMatchObject({ panel: "timeline", sidebar: false });
});

it("navigates a queue loaded after focus without inventing a selection on refresh", () => {
  const view = fixtureView();
  const k = keys(view);
  k.run("tab", "tab");
  expect(k.ui).toMatchObject({ panel: "queue", sidebar: true });
  expect(k.ui.queuedRequestId).toBeUndefined();
  view.queuedMessages = [
    { requestId: "first", text: "First", mode: "followUp" },
    { requestId: "second", text: "Second", mode: "followUp" },
  ];
  expect(k.run("s")).toEqual([]);
  k.run("G");
  expect(k.ui.queuedRequestId).toBe("second");
  k.run("k");
  expect(k.ui.queuedRequestId).toBe("first");
  k.run("j", "g");
  expect(k.ui.queuedRequestId).toBe("first");
  view.queuedMessages = [];
  expect(k.run("s")).toEqual([{ kind: "notice", text: "The agent already has this message." }]);
  expect(k.ui.queuedRequestId).toBe("first");
});

it("sends follow-ups with Enter and steers with Ctrl+S only in the Timeline composer", () => {
  const view = fixtureView();
  const editing: Ui = { ...initialUi(), editing: "message", messageText: "  Recheck the deadline.  " };
  expect(press(editing, "enter", view, 1).effect).toEqual({ kind: "message", text: "Recheck the deadline.", mode: "followUp" });
  expect(press(editing, "ctrl+s", view, 1).effect).toEqual({ kind: "message", text: "Recheck the deadline.", mode: "steer" });
  expect(press({ ...editing, messageText: " " }, "ctrl+s", view, 1).effect).toBeUndefined();
  expect(press(initialUi(), "ctrl+s", view, 1).effect).toBeUndefined();
  expect(press(editing, "s", view, 1).effect).toBeUndefined();
  const briefing = setField({ ...initialUi(), tab: "briefing" }, view, "dailyUsd", "25");
  expect(press(briefing, "ctrl+s", view, 1).ui.confirm).toEqual({ kind: "save", lines: ["Daily limit $50.00 → $25.00"] });
});

it("keeps the attempted message ID and mode on retry, never sends steer:false", () => {
  const first = messageAttempt(undefined, "  Same message ", "steer", "original");
  const retry = messageAttempt(first, "Same message", "followUp", "unused");
  expect(retry).toEqual({ requestId: "original", text: "Same message", mode: "steer" });
  expect(messageBody(retry)).toEqual({ requestId: "original", text: "Same message", steer: true });
  const followUp = messageAttempt(undefined, "Next run", "followUp", "next");
  expect(messageBody(messageAttempt(followUp, "Next run", "steer", "unused"))).toEqual({ requestId: "next", text: "Next run" });
  expect(messageAttempt(first, "Changed text", "followUp", "new")).toEqual({ requestId: "new", text: "Changed text", mode: "followUp" });
});

it("withdraws either queued mode by selected ID, never a replacement row", () => {
  const view = fixtureView();
  view.queuedMessages = [
    { requestId: "earlier", text: "Earlier", mode: "followUp" },
    { requestId: "chosen / id", text: "Chosen", mode: "followUp" },
    { requestId: "steer", text: "Steer", mode: "steer" },
  ];
  const k = keys(view);
  expect(k.run("w")).toEqual([]);
  k.run("tab", "tab", "j");
  view.queuedMessages.shift();
  expect(k.run("w")).toEqual([{ kind: "call", method: "DELETE", action: "messages/chosen%20%2F%20id" }]);
  view.queuedMessages.shift();
  expect(k.run("w")).toEqual([{ kind: "notice", text: "The agent already has this message." }]);
  expect(k.ui.queuedRequestId).toBe("chosen / id");
  k.run("j");
  expect(k.run("w")).toEqual([{ kind: "call", method: "DELETE", action: "messages/steer" }]);
  expect(press({ ...k.ui, tab: "briefing" }, "w", view, 1).effect).toBeUndefined();
  expect(press({ ...k.ui, editing: "message", messageText: "draft" }, "w", view, 1).effect).toBeUndefined();
});

it("moves successful withdrawal focus to a visible neighbor or the timeline, without overriding navigation", () => {
  const before: ConsoleView["queuedMessages"] = [
    { requestId: "first", text: "First", mode: "followUp" },
    { requestId: "middle", text: "Middle", mode: "steer" },
    { requestId: "last", text: "Last", mode: "followUp" },
  ];
  const ui: Ui = { ...initialUi(), panel: "queue", sidebar: true, queuedRequestId: "middle" };
  const after = before.filter((row) => row.requestId !== "middle");
  expect(withdrawnSelection(ui, "middle", before, after)).toMatchObject({ panel: "queue", queuedRequestId: "last" });
  // Live updates may have removed both the selected row and its next neighbor before the ACK.
  expect(withdrawnSelection(ui, "middle", before, after.slice(0, 1))).toMatchObject({ panel: "queue", queuedRequestId: "first" });
  expect(withdrawnSelection({ ...ui, queuedRequestId: "last" }, "last", before, after.slice(0, 1))).toMatchObject({ queuedRequestId: "first" });
  expect(withdrawnSelection(ui, "middle", before, [])).toMatchObject({ panel: "timeline", queuedRequestId: undefined });
  const moved = { ...ui, queuedRequestId: "first" };
  expect(withdrawnSelection(moved, "middle", before, after)).toEqual(moved);
  const timeline: Ui = { ...ui, panel: "timeline" };
  expect(withdrawnSelection(timeline, "middle", before, after)).toEqual(timeline);
});

it("turns only promotion and withdrawal 404 and 409 races into the exact late-message notice", () => {
  for (const status of [404, 409]) {
    expect(actionError("steer/selected-id", status, "Queued message not found.")).toBe("The agent already has this message.");
    expect(actionError("messages/selected-id", status, "Cannot withdraw.")).toBe("The agent already has this message.");
  }
  expect(actionError("messages/selected-id", undefined, "Connection lost")).toBe("Connection lost");
  expect(actionError("messages/selected-id", 500, "Try again")).toBe("Try again");
  expect(actionError("orders/1", 404, "Order missing")).toBe("Order missing");
  expect(actionError("steer/selected-id", 500, "Try again")).toBe("Try again");
});

it("keys replies by turn time and place, so they hold when the transcript window slides", () => {
  const view = fixtureView();
  const slid = screen({ ...view, timeline: view.timeline.slice(1) }, 120, NOW);
  expect(slid.turns[0].replies[0].key).toBe(screen(view, 120, NOW).turns[1].replies[0].key);
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
  expect(k.ui.open).toEqual([`${Date.parse("2026-10-13T09:00:00Z")}r0`]);
  expect(k.run("o")).toEqual([{ kind: "open", url: `http://localhost:4000/tasks/${TASK}` }]);
  k.run("j", "j", "r");
  expect(k.ui.reply).toBe(2);
  expect(k.ui.raw).toContain(`turn:${Date.parse("2026-10-13T10:00:00Z")}`);
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
  expect(k.run("q")).toEqual([]); // Printable input is not a global shortcut.
  expect(k.run("escape", "q")).toEqual([{ kind: "quit" }]);
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
  ui = setField(ui, view, "temperament", "curt");
  expect(ui.draft).toMatchObject({ dials: { temperament: "curt" }, limits: { perJobUsd: 30, dailyUsd: 50 }, instructions: view.spec.instructions });
  const saving = keys(view, ui);
  expect(saving.run("ctrl+s")).toEqual([]);
  expect(saving.ui.confirm).toEqual({ kind: "save", lines: ["Per job limit $20.00 → $30.00"] });
  expect(saving.run("y")).toEqual([{ kind: "call", method: "PUT", action: "spec", body: ui.draft }]);
  // The draft stays until the server accepts it, so a refused save loses nothing.
  expect(saving.ui.draft).toEqual(ui.draft);

  const typo = keys(view, setField(k.ui, view, "perJobUsd", "abc"));
  typo.run("ctrl+s");
  expect(typo.ui.confirm).toEqual({ kind: "save", lines: ["Per job limit $20.00 → invalid"] });

  // Escape on the timeline closes lines; only the briefing's escape discards its draft.
  const away = keys(view, { ...setField(k.ui, view, "temperament", "curt"), tab: "timeline" });
  away.run("escape");
  expect(away.ui.draft?.dials.temperament).toBe("curt");

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

it("strips escapes from tool names and host facts too", () => {
  const view = fixtureView();
  view.timeline[0].replies[0].calls[0].name = "task_list\x1b]0;pwned\x07";
  view.host = { ...view.host!, stream: "connected\x1b[2J" as never };
  view.spec = { ...view.spec, model: "anthropic:x\x1b]8;;https://evil.example\x1b\\" };
  const drawn = screen(view, 120, NOW);
  expect(drawn.turns[0].replies[0].calls[0].name).toBe("task_list");
  expect(drawn.sidebar.readiness.find((check) => check.label === "Event stream")?.detail).toBe("connected");
  expect(drawn.sidebar.readiness.find((check) => check.label === "Model")?.detail).toBe("anthropic:x");
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
