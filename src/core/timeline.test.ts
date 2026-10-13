import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { buildTimeline } from "./timeline.js";

const task = "11111111-1111-4111-8111-111111111111";
const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const result = (toolCallId: string, toolName: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 });

// foo's first development run, then an operator message that posts, then a worker's message.
const transcript: Message[] = [
  user("Check your marketplace work in your poster role and pursue your current goals: get small jobs done fast at a fair price.", 1000),
  fauxAssistantMessage([fauxText("I'll check my current state first."), fauxToolCall("me", {}, { id: "c1" }), fauxToolCall("wallet_balance", {}, { id: "c2" })], { stopReason: "toolUse" }),
  result("c1", "me", '{"profile":{"id":"33333333-3333-4333-8333-333333333333"}}'),
  result("c2", "wallet_balance", '{"balance":{"available_balance":"0x0"}}'),
  fauxAssistantMessage([fauxToolCall("task_list", { kind: "poster" }, { id: "c3" }), fauxToolCall("task_list", { kind: "posted" }, { id: "c4" })], { stopReason: "toolUse" }),
  result("c3", "task_list", '{"error":"Command failed: invalid value \'poster\' for \'--kind <KIND>\'"}'),
  result("c4", "task_list", '{"kind":"posted","tasks":[]}'),
  fauxAssistantMessage("Wallet unfunded, so I can't post until it's funded."),
  user("Message from your operator:\nThe wallet is funded now. Post one job under $15.", 2000),
  fauxAssistantMessage([fauxToolCall("post_task", { title: "Edit a page", description: "Copy edit it.", budget: "15.00", pickup_deadline_hours: 24 }, { id: "c5" })], { stopReason: "toolUse" }),
  result("c5", "post_task", JSON.stringify({ task: { id: task, status: "open" } })),
  fauxAssistantMessage("Posted it."),
  user(`Marketplace event:\n${JSON.stringify({ event_id: "e1", event: "message_received", task_id: task })}`, 3000),
  fauxAssistantMessage([fauxToolCall("message_send", { task_id: task, content: "About 1,500 words." }, { id: "c6" })], { stopReason: "toolUse" }),
  result("c6", "message_send", '{"uncertain":"timed out"}'),
  fauxAssistantMessage("Answered."),
];

it("groups a transcript into turns by what started them, with each reply's tool calls and tasks", () => {
  const turns = buildTimeline(transcript);
  expect(turns.map((turn) => [turn.kind, turn.at])).toEqual([["poll", 1000], ["operator", 2000], ["event", 3000]]);
  expect(turns[1].text).toBe("The wallet is funded now. Post one job under $15.");
  expect(turns[2].event).toEqual({ event_id: "e1", event: "message_received", task_id: task });

  const [checked, listed, reported] = turns[0].replies;
  expect(checked.text).toBe("I'll check my current state first.");
  expect(checked.calls.map((call) => [call.name, call.outcome])).toEqual([["me", "ok"], ["wallet_balance", "ok"]]);
  expect(listed.text).toBe("");
  expect(listed.calls.map((call) => [call.name, call.outcome])).toEqual([["task_list", "failed"], ["task_list", "ok"]]);
  expect(listed.calls[0].error).toContain("invalid value 'poster'");
  expect(reported).toMatchObject({ text: "Wallet unfunded, so I can't post until it's funded.", calls: [], tasks: [] });

  expect(turns[1].replies[0].tasks).toEqual([{ id: task, via: "post_task" }]);
  expect(turns[2].replies[0].tasks).toEqual([{ id: task, via: "message_send" }]);
  expect(turns[2].replies[0].calls[0].outcome).toBe("uncertain");
});

it("shows a skipped repeat of an uncertain write as uncertain, while a skipped repeat of a done write stays ok", () => {
  const turns = buildTimeline([
    user("Check your marketplace work", 1000),
    fauxAssistantMessage([
      fauxToolCall("post_task", { title: "Edit a page" }, { id: "c1" }),
      fauxToolCall("post_task", { title: "Edit another page" }, { id: "c2" }),
    ], { stopReason: "toolUse" }),
    result("c1", "post_task", JSON.stringify({ skipped: "outcome unknown; read the current state", at: "2026-10-13T12:00:00.000Z" })),
    result("c2", "post_task", JSON.stringify({ skipped: "already done", at: "2026-10-13T12:00:00.000Z" })),
  ]);
  const [unknown, done] = turns[0].replies[0].calls;
  expect(unknown.outcome).toBe("uncertain");
  expect(unknown.error).toBe("outcome unknown; read the current state");
  expect(done.outcome).toBe("ok");
  expect(done.error).toBeUndefined();
});

it("parses the tool's JSON when the stored result carries a second diagnostics text part", () => {
  const body = JSON.stringify({ task: { id: task, status: "open" } });
  const stored: ToolResultMessage = {
    role: "toolResult", toolCallId: "c1", toolName: "post_task", isError: false, timestamp: 0,
    content: [{ type: "text", text: body }, { type: "text", text: "[warn] Output truncated to its beginning: 0 lines, 4 bytes dropped" }],
  };
  const turns = buildTimeline([
    user("Message from your operator:\nPost it.", 1000),
    fauxAssistantMessage([fauxToolCall("post_task", { title: "Edit a page" }, { id: "c1" })], { stopReason: "toolUse" }),
    stored,
  ]);
  const call = turns[0].replies[0].calls[0];
  expect(call.outcome).toBe("ok");
  expect(call.result).toBe(body);
  expect(turns[0].replies[0].tasks).toEqual([{ id: task, via: "post_task" }]);
});
