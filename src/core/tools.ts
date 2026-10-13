import { createHash } from "node:crypto";

// The tools an agent's model can call. Each one maps to a taskfast command (or, for
// memory, to the agent's own notes). The model only fills in values: every value is
// checked here, options are passed as --name=value and positionals after --, so a
// value can never become a flag such as --env.
//
// kind: read (safe to repeat), write (runs at most once per actionKey), money (a
// write that commits funds; its amount is fixed by code and counted against the
// agent's limits), memory (changes only the agent's notes).
export type ToolKind = "read" | "write" | "money" | "memory";
// A money tool must name where its amount comes from: the type will not compile without
// one, so a charged command cannot be added without being counted.
export type AmountSource = "bidPrice" | "submissionFee";
// Who is on the other side of a write, for an agent whose host limits its
// counterparties (counterparty.ts): the task's poster, the bid's bidder, the task's
// worker, or for a message, whichever of poster and worker is not this agent. Every
// write names one (null only for a write with no counterparty yet, a post), so a new
// write cannot compile without deciding it.
export type Party = "poster" | "bidder" | "worker" | "other";
interface ToolBase {
  description: string;
  schema: { type: "object"; properties: Record<string, { type: string; description?: string; enum?: string[] }>; required: string[]; additionalProperties: false };
  args(input: Record<string, unknown>): string[];
}
export type ToolSpec =
  | (ToolBase & { kind: "read" | "memory"; amount?: never; party?: never; key?: never })
  | (ToolBase & { kind: "write"; amount?: never; party: Party | null; key(input: Record<string, unknown>): string })
  // For a money tool, where its amount comes from, always read from the server: the
  // bid's price, or the platform's submission fee. Never free text from the model.
  | (ToolBase & { kind: "money"; amount: AmountSource; party: Party | null; key(input: Record<string, unknown>): string });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE = /^\d{1,9}(\.\d{1,2})?$/;

const bad = (why: string): never => {
  throw new Error(why);
};
const uuid = (v: unknown, name: string) => (typeof v === "string" && UUID.test(v) ? v : bad(`${name} must be a UUID`));
const text = (v: unknown, name: string, max = 4000) =>
  typeof v === "string" && v.trim() && v.length <= max ? v : bad(`${name} must be non-empty text up to ${max} characters`);
const word = (v: unknown, name: string) => (typeof v === "string" && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : bad(`${name} must be a single word`));
const opt = (name: string, v: unknown, check: (v: unknown, n: string) => string) => (v === undefined ? [] : [`--${name}=${check(v, name)}`]);
// The pickup windows the server accepts (Task.pickup_window_hours in the app).
const PICKUP_HOURS = [1, 4, 12, 24, 72];
const hours = (v: unknown, n: string) => (typeof v === "number" && PICKUP_HOURS.includes(v) ? String(v) : bad(`${n} must be one of ${PICKUP_HOURS.join(", ")}`));
const limit = (v: unknown, n: string) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100 ? String(v) : bad(`${n} must be 1 to 100`));
const money = (v: unknown, n: string) => (typeof v === "string" && PRICE.test(v) ? v : bad(`${n} must be a decimal amount like "40.00"`));
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const s = (description: string) => ({ type: "string", description });
const obj = (properties: ToolSpec["schema"]["properties"], required: string[] = []): ToolSpec["schema"] => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: Record<string, ToolSpec> = {
  me: { kind: "read", description: "Your own agent profile and whether you are ready to work.", schema: obj({}), args: () => ["me"] },
  wallet_balance: { kind: "read", description: "Your wallet balance.", schema: obj({}), args: () => ["wallet", "balance"] },
  discover: {
    kind: "read",
    description: "Browse open tasks on the marketplace.",
    schema: obj({ status: s("task status filter"), capability: s("capability filter"), budget_min: s("minimum budget, e.g. 10.00"), budget_max: s("maximum budget"), limit: { type: "number", description: "1-100" } }),
    args: (i) => ["discover", ...opt("status", i.status, word), ...opt("capability", i.capability, word), ...opt("budget-min", i.budget_min, money), ...opt("budget-max", i.budget_max, money), ...opt("limit", i.limit, limit)],
  },
  task_get: { kind: "read", description: "Full detail of one task.", schema: obj({ task_id: s("task UUID") }, ["task_id"]), args: (i) => ["task", "get", "--", uuid(i.task_id, "task_id")] },
  task_list: {
    kind: "read",
    description: "Tasks you are involved in.",
    schema: obj({ kind: s("which collection, e.g. mine or assigned"), status: s("status filter"), limit: { type: "number", description: "1-100" } }),
    args: (i) => ["task", "list", ...opt("kind", i.kind, word), ...opt("status", i.status, word), ...opt("limit", i.limit, limit)],
  },
  bid_list: {
    kind: "read",
    description: "Bids you have placed.",
    schema: obj({ status: { type: "string", enum: ["pending", "accepted_pending_escrow", "accepted", "rejected", "withdrawn"] } }),
    args: (i) => ["bid", "list", ...opt("status", i.status, word)],
  },
  message_list: { kind: "read", description: "Messages on one task.", schema: obj({ task_id: s("task UUID") }, ["task_id"]), args: (i) => ["message", "list", "--", uuid(i.task_id, "task_id")] },

  bid_create: {
    kind: "write",
    description: "Bid on an open task. One bid per task.",
    schema: obj({ task_id: s("task UUID"), price: s('your price, e.g. "40.00"'), pitch: s("why you fit, in your own words") }, ["task_id", "price"]),
    args: (i) => ["bid", "create", `--price=${money(i.price, "price")}`, ...opt("pitch", i.pitch, (v, n) => text(v, n, 2000)), "--", uuid(i.task_id, "task_id")],
    key: (i) => `bid:${uuid(i.task_id, "task_id")}`,
    party: "poster",
  },
  task_claim: {
    kind: "write",
    description: "Start work on a task assigned to you.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["task", "claim", "--", uuid(i.task_id, "task_id")],
    key: (i) => `claim:${uuid(i.task_id, "task_id")}`,
    party: "poster",
  },
  task_submit: {
    kind: "write",
    description: "Submit your finished work on a task, with a summary.",
    schema: obj({ task_id: s("task UUID"), summary: s("what you delivered") }, ["task_id", "summary"]),
    args: (i) => ["task", "submit", `--summary=${text(i.summary, "summary")}`, "--", uuid(i.task_id, "task_id")],
    key: (i) => `submit:${uuid(i.task_id, "task_id")}`,
    party: "poster",
  },
  message_send: {
    kind: "write",
    description: "Send a message on a task.",
    schema: obj({ task_id: s("task UUID"), content: s("the message") }, ["task_id", "content"]),
    args: (i) => ["message", "send", `--content=${text(i.content, "content")}`, "--", uuid(i.task_id, "task_id")],
    key: (i) => `message:${uuid(i.task_id, "task_id")}:${digest(text(i.content, "content"))}`,
    party: "other",
  },

  task_bids: {
    kind: "read",
    description: "Bids received on one of your tasks.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["task", "bids", "--", uuid(i.task_id, "task_id")],
  },

  // A post commits no budget, which is paid later through escrow_sign; it charges the
  // platform's submission fee, so that fee is what it counts against the limits.
  post_task: {
    kind: "money",
    description: "Post a new task for others to bid on. Posting costs the platform's submission fee; you pay a bid's price later, when you fund its escrow.",
    schema: obj({ title: s("short title"), description: s("what you need done"), budget: s('the most you will pay, e.g. "40.00"'), pickup_deadline_hours: { type: "number", description: "hours until someone must pick it up: 1, 4, 12, 24 or 72" } }, ["title", "description", "budget", "pickup_deadline_hours"]),
    args: (i) => ["post", `--title=${text(i.title, "title", 200)}`, `--description=${text(i.description, "description")}`, `--budget=${money(i.budget, "budget")}`, `--pickup-deadline-hours=${hours(i.pickup_deadline_hours, "pickup_deadline_hours")}`, "--yes"],
    key: (i) => `post:${digest(`${text(i.title, "title", 200)}\n${text(i.description, "description")}`)}`,
    amount: "submissionFee",
    party: null,
  },
  // bid_accept and bid_reject take the task as well as the bid: the CLI cannot read a bid
  // by its id, so the bidder (party) is found among the task's bids.
  bid_accept: {
    kind: "write",
    description: "Accept a bid on your task. You fund its escrow afterwards with escrow_sign.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID") }, ["task_id", "bid_id"]),
    args: (i) => ["bid", "accept", "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `accept:${uuid(i.bid_id, "bid_id")}`,
    party: "bidder",
  },
  bid_reject: {
    kind: "write",
    description: "Turn down a bid on your task.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID"), reason: s("optional reason") }, ["task_id", "bid_id"]),
    args: (i) => ["bid", "reject", ...opt("reason", i.reason, (v, n) => text(v, n, 500)), "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `reject:${uuid(i.bid_id, "bid_id")}`,
    party: "bidder",
  },
  escrow_sign: {
    kind: "money",
    description: "Fund the escrow for a bid you accepted. Commits the bid's price.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID") }, ["task_id", "bid_id"]),
    args: (i) => ["escrow", "sign", "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `escrow:${uuid(i.bid_id, "bid_id")}`,
    party: "bidder",
    amount: "bidPrice",
  },
  task_approve: {
    kind: "write",
    description: "Approve the work submitted on your task. Releases the escrowed payment.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["task", "approve", "--", uuid(i.task_id, "task_id")],
    key: (i) => `approve:${uuid(i.task_id, "task_id")}`,
    party: "worker",
  },
  task_dispute: {
    kind: "write",
    description: "Dispute the work submitted on your task, with your reason.",
    schema: obj({ task_id: s("task UUID"), reason: s("why the work falls short") }, ["task_id", "reason"]),
    args: (i) => ["task", "dispute", `--reason=${text(i.reason, "reason", 2000)}`, "--", uuid(i.task_id, "task_id")],
    key: (i) => `dispute:${uuid(i.task_id, "task_id")}`,
    party: "worker",
  },
  settle: {
    kind: "write",
    description: "Settle a completed task so the payment is distributed.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["settle", "--yes", "--", uuid(i.task_id, "task_id")],
    key: (i) => `settle:${uuid(i.task_id, "task_id")}`,
    party: "worker",
  },

  remember: { kind: "memory", description: "Keep a note for later turns.", schema: obj({ note: s("the note") }, ["note"]), args: (i) => (text(i.note, "note"), []) },
  forget: { kind: "memory", description: "Drop one of your notes by its number.", schema: obj({ index: { type: "number", description: "note number" } }, ["index"]), args: (i) => (Number.isInteger(i.index) && (i.index as number) >= 0 ? [] : bad("index must be a non-negative integer")) },
};

// Validates a tool call from the model. Returns the command args and action key, or
// throws with a message the model can read and correct.
export function prepare(tool: string, input: unknown): { spec: ToolSpec; args: string[]; key: string | null; input: Record<string, unknown> } {
  const spec = Object.hasOwn(TOOLS, tool) ? TOOLS[tool]! : bad(`no tool named ${tool}`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) bad("tool input must be an object");
  const i = { ...(input as Record<string, unknown>) };
  for (const k of Object.keys(i)) {
    if (!Object.hasOwn(spec.schema.properties, k)) bad(`${tool} has no field ${k}`);
    // UUID case is not marketplace identity. Normalize before both key construction
    // and the policy reads, so a fresh model call cannot vary casing to run twice.
    if (k === "task_id" || k === "bid_id") i[k] = uuid(i[k], k).toLowerCase();
  }
  return { spec, args: spec.args(i), key: spec.key ? spec.key(i) : null, input: i };
}
