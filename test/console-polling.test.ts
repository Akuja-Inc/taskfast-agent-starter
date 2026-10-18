import { expect, it } from "vitest";
import { foldPolls } from "../src/console-polling.js";
import type { Turn } from "../src/core/timeline.js";
import { TOOLS } from "../src/core/tools.js";

const poll = (at: number): Turn => ({
  id: `turn-${at}`, kind: "poll", at, text: "Check your marketplace work", complete: true,
  replies: [
    { text: "", tasks: [], calls: [{ id: `read-${at}`, name: "task_list", arguments: { kind: "open" }, outcome: "ok", result: '{"tasks":[]}', comparable: true }] },
    { text: "No suitable jobs. No action taken.", calls: [], tasks: [] },
  ],
});
const turns = () => [poll(1000), poll(2000), poll(3000), poll(4000)];

it("retains the first observation and groups consecutive unchanged completed checks without mutating history", () => {
  const history = turns(), before = structuredClone(history);
  expect(foldPolls(history)).toEqual([
    { kind: "turn", index: 0 },
    { kind: "unchanged", from: 1, to: 4, scope: ["Task lists"] },
  ]);
  expect(history).toEqual(before);
});

it("keeps meaningful changes even when result counts are equal", () => {
  const history = turns();
  history[2].replies[0].calls[0].result = '{"tasks":[{"id":"new","status":"open"}]}';
  history[1].replies[0].calls[0].result = '{"tasks":[{"id":"old","status":"open"}]}';
  expect(foldPolls(history).every((row) => row.kind === "turn")).toBe(true);
});

it("ends a run at an operator message, event, resumed work or other input", () => {
  for (const kind of ["operator", "event", "resume", "other"] as const) {
    const history = [...turns().slice(0, 2), { ...poll(2500), kind }, ...turns().slice(2)];
    expect(foldPolls(history)).toEqual([
      { kind: "turn", index: 0 }, { kind: "unchanged", from: 1, to: 2, scope: ["Task lists"] },
      { kind: "turn", index: 2 }, { kind: "turn", index: 3 }, { kind: "unchanged", from: 4, to: 5, scope: ["Task lists"] },
    ]);
  }
});

// buildTimeline() leaves failed, uncertain and pending calls without comparable: true.
it("leaves unsupported, non-comparable and incomplete observations visible", () => {
  const mutations: ((turn: Turn) => void)[] = [
    (turn) => { turn.complete = false; },
    (turn) => { delete turn.complete; },
    (turn) => { turn.replies[0].calls[0].name = "mcp_docs_search"; },
    (turn) => { turn.replies[0].calls[0].name = "post_task"; },
    (turn) => { turn.replies[0].calls[0].name = "remember"; },
    (turn) => { delete turn.replies[0].calls[0].result; },
    (turn) => { turn.replies[0].calls[0].comparable = false; },
    (turn) => { delete turn.replies[0].calls[0].comparable; },
    (turn) => { turn.replies = []; },
    (turn) => { turn.replies[1].text = ""; },
  ];
  for (const mutate of mutations) {
    const history = turns();
    mutate(history[1]);
    expect(foldPolls(history).slice(0, 3)).toEqual([
      { kind: "turn", index: 0 }, { kind: "turn", index: 1 }, { kind: "turn", index: 2 },
    ]);
  }
});

it("compares every response field and request argument, not a summary or count", () => {
  for (const mutation of [
    (turn: Turn) => { turn.replies[0].calls[0].arguments = { kind: "posted" }; },
    (turn: Turn) => { turn.replies[0].calls[0].result = '{"tasks":[],"cursor":"next"}'; },
    (turn: Turn) => { turn.text += " with a new goal"; },
  ]) {
    const history = turns(); mutation(history[1]);
    expect(foldPolls(history).slice(0, 3).every((row) => row.kind === "turn")).toBe(true);
  }
});

it("excludes every write, money and memory tool in the actual tool table", () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (tool.kind === "read") continue;
    const history = turns();
    for (const turn of history) turn.replies[0].calls[0].name = name;
    expect(foldPolls(history).every((row) => row.kind === "turn"), name).toBe(true);
  }
});

it("compares mixed marketplace reads and names only their checked scope", () => {
  const history = turns();
  for (const turn of history) {
    turn.replies[0].calls.push({ id: `wallet-${turn.at}`, name: "wallet_balance", arguments: {}, outcome: "ok", result: '{"balance":{"available_balance":"0x0"}}', comparable: true });
    turn.replies[0].calls.push({ id: `messages-${turn.at}`, name: "message_list", arguments: { task_id: "one-task" }, outcome: "ok", result: '{"messages":[],"meta":{"has_more":false,"next_cursor":null}}', comparable: true });
  }
  expect(foldPolls(history)[1]).toEqual({ kind: "unchanged", from: 1, to: 4, scope: ["Task lists", "Wallet balance", "Messages"] });
  history[2].replies[0].calls[1].result = '{"balance":{"available_balance":"0x1"}}';
  expect(foldPolls(history).slice(2)).toEqual([{ kind: "turn", index: 2 }, { kind: "turn", index: 3 }]);
});

it("retains task references and notices changed deadlines even when the prose repeats", () => {
  const history = turns();
  for (const turn of history) {
    turn.replies[0].calls[0] = { id: `task-${turn.at}`, name: "task_get", arguments: { task_id: "task" }, outcome: "ok", result: '{"id":"task","status":"submitted","deadline":"2026-10-19"}', comparable: true };
    turn.replies[0].tasks = [{ id: "task", via: "task_get" }];
  }
  expect(foldPolls(history)[1].kind).toBe("unchanged");
  history[2].replies[0].calls[0].result = '{"id":"task","status":"submitted","deadline":"2026-10-20"}';
  expect(foldPolls(history).slice(2)).toEqual([{ kind: "turn", index: 2 }, { kind: "turn", index: 3 }]);
});

it("keeps paraphrases and new warnings visible despite identical server responses", () => {
  for (const text of ["Nothing suitable is available. I took no action.", "No suitable jobs. Check my budget before tomorrow.", "No suitable jobs. No action taken.\n"]) {
    const history = turns(); history[1].replies[1].text = text;
    expect(foldPolls(history).slice(0, 3)).toEqual([
      { kind: "turn", index: 0 }, { kind: "turn", index: 1 }, { kind: "turn", index: 2 },
    ]);
  }
});

it("does not merge noncontiguous runs or grow a group with in-progress work", () => {
  const history = turns(); history[3].complete = false;
  expect(foldPolls(history)).toEqual([
    { kind: "turn", index: 0 }, { kind: "unchanged", from: 1, to: 3, scope: ["Task lists"] }, { kind: "turn", index: 3 },
  ]);
  history[3].complete = true;
  expect(foldPolls(history)[1]).toEqual({ kind: "unchanged", from: 1, to: 4, scope: ["Task lists"] });
});
