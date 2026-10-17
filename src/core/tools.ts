import { createHash } from "node:crypto";
import { MEDIA_PATH } from "./media.js";

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
// one, so a charged command cannot be added without being counted. bidPrice and
// submissionFee are prices the server publishes; bondStake is the bond a task's quote
// requires.
export type AmountSource = "bidPrice" | "submissionFee" | "bondStake";
type Schema = { type: "object"; properties: Record<string, { type: string; description?: string; enum?: string[]; items?: Schema }>; required: string[]; additionalProperties: false };
interface ToolBase {
  description: string;
  schema: Schema;
  args(input: Record<string, unknown>): string[];
  // Files policy writes inside the agent folder before dispatch: folder-relative paths
  // code builds, with the model's text or the bytes of a media file code saved.
  files?(input: Record<string, unknown>): ArtifactFile[];
}
export type ArtifactFile = { path: string; content: string } | { path: string; media: string; digest: string };
export type ToolSpec =
  | (ToolBase & { kind: "read" | "memory"; amount?: never; key?: never })
  | (ToolBase & { kind: "write"; amount?: never; key(input: Record<string, unknown>): string })
  // For a money tool, where its amount comes from, always read from the server: the
  // bid's price, the platform's submission fee, or a task's quoted performance bond.
  // Never free text from the model. spendAfterPreflight marks a command that can move
  // funds after its own preflight and before a refusal: policy then records a failed
  // dispatch as uncertain, because the CLI may have signed before it refused.
  | (ToolBase & { kind: "money"; amount: AmountSource; key(input: Record<string, unknown>): string; spendAfterPreflight?: true });

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
// A status filter the model names in the server's words (accepted_pending_escrow), which
// the CLI's argument parser only takes in kebab case (accepted-pending-escrow).
const oneOf = (values: string[]) => (v: unknown, n: string) => (typeof v === "string" && values.includes(v) ? v.replaceAll("_", "-") : bad(`${n} must be one of ${values.join(", ")}`));
const BID_STATUS = ["pending", "accepted_pending_escrow", "accepted", "rejected", "withdrawn"];
const TASK_KIND = ["mine", "queue", "posted"];
const MINE_STATUS = ["assigned", "in_progress", "under_review", "disputed", "remedied"];
const DISCOVER_STATUS = ["open", "bidding"];
// The pickup windows the server accepts (Task.pickup_window_hours in the app).
const PICKUP_HOURS = [1, 4, 12, 24, 72];
const hours = (v: unknown, n: string) => (typeof v === "number" && PICKUP_HOURS.includes(v) ? String(v) : bad(`${n} must be one of ${PICKUP_HOURS.join(", ")}`));
const limit = (v: unknown, n: string) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100 ? String(v) : bad(`${n} must be 1 to 100`));
const money = (v: unknown, n: string) => (typeof v === "string" && PRICE.test(v) ? v : bad(`${n} must be a decimal amount like "40.00"`));
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const s = (description: string) => ({ type: "string", description });
const obj = (properties: Schema["properties"], required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false });

// Artifacts are files the kit writes: text the model writes, or an image an approved MCP
// tool returned, which code saved under .pi-state/media and named by a media: handle.
// Code stores each one under a folder it builds from the task and the bytes' digest, and
// passes that path. The model names the file, because a task's criteria can require one
// such as results.json; the name is one basename with an extension the server accepts,
// so it cannot leave its folder. The CLI picks the upload's type from that extension, so
// a media name must end in its handle's own image type.
export const ARTIFACTS_PATH = ".pi-state/artifacts";
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}\.([a-z]+)$/;
const TEXT_NAMES = ["txt", "md", "csv", "json", "xml", "html", "css", "js", "svg"];
// Each image extension a name may end in, by the extension of its media file.
const IMAGE_NAMES: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };
const MEDIA_HANDLE = /^media:([0-9a-f]{16})\.(png|jpg|gif|webp)$/;
const NAMES = [...TEXT_NAMES, ...Object.keys(IMAGE_NAMES)].map((ext) => `.${ext}`).join(", ");
const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BYTES = 256 * 1024;
function artifacts(v: unknown, task: string): ArtifactFile[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ARTIFACTS) bad(`artifacts must be a list of 1 to ${MAX_ARTIFACTS} files`);
  const names = new Set<string>();
  return (v as unknown[]).map((a): ArtifactFile => {
    if (a === null || typeof a !== "object" || Object.keys(a).some((k) => k !== "name" && k !== "content" && k !== "media") || ("content" in a) === ("media" in a)) bad("each artifact is { name, content } or { name, media }");
    const { name, content, media } = a as Record<string, unknown>;
    const ext = typeof name === "string" ? ARTIFACT_NAME.exec(name)?.[1] : undefined;
    if (!ext || !(TEXT_NAMES.includes(ext) || Object.hasOwn(IMAGE_NAMES, ext)) || names.has(name as string)) bad(`artifact name must be a unique file name like results.json or chart.png, ending in ${NAMES}`);
    names.add(name as string);
    if (media !== undefined) {
      const handle = typeof media === "string" ? MEDIA_HANDLE.exec(media) : null;
      if (!handle) bad(`artifact ${name as string} media must be a handle a tool result gave you, like media:0123456789abcdef.png`);
      const [, hash, type] = handle!;
      if (IMAGE_NAMES[ext!] !== type) bad(`artifact ${name as string} must end in .${type}${type === "jpg" ? " or .jpeg" : ""} to match its media`);
      return { path: `${ARTIFACTS_PATH}/${task}/${hash}/${name as string}`, media: `${MEDIA_PATH}/${hash}.${type}`, digest: hash! };
    }
    if (!TEXT_NAMES.includes(ext!)) bad(`artifact ${name as string} is an image: deliver it as { name, media } with a handle a tool result gave you`);
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : 0;
    if (bytes < 1 || bytes > MAX_ARTIFACT_BYTES) bad(`artifact ${name as string} content must be 1 to ${MAX_ARTIFACT_BYTES} bytes of text`);
    return { path: `${ARTIFACTS_PATH}/${task}/${digest(content as string)}/${name as string}`, content: content as string };
  });
}
const artifactFiles = (i: Record<string, unknown>) => artifacts(i.artifacts, uuid(i.task_id, "task_id"));
const artifactList = {
  type: "array",
  description: `optional files to deliver, at most ${MAX_ARTIFACTS}: each is text you write (up to 256 KiB, SVG included) as { name, content }, or an image a tool result saved as media:<file> as { name, media }. You cannot make PNG, JPEG, GIF or WebP bytes yourself; deliver one only by its handle`,
  items: obj({
    name: s(`file name a criterion may require, e.g. results.json or chart.png; ends in ${NAMES}`),
    content: s("the file's full text, for a text file"),
    media: s("for an image, the handle a tool result gave you, e.g. media:0123456789abcdef.png"),
  }, ["name"]),
};
// The CLI uploads each file, then submits exactly those uploads.
const deliver = (command: string) => (i: Record<string, unknown>) =>
  ["task", command, `--summary=${text(i.summary, "summary")}`, ...artifactFiles(i).map((f) => `--artifact=${f.path}`), "--", uuid(i.task_id, "task_id")];

// This agent's uploads in `artifact list` output (data.artifacts[]), or null when the
// output is not that shape or an id is not a UUID.
export function ownUploads(data: unknown, agentId: string): string[] | null {
  const rows = typeof data === "object" && data !== null && "artifacts" in data ? data.artifacts : null;
  if (!Array.isArray(rows)) return null;
  const ids = rows.filter((row) => typeof row?.uploaded_by_id === "string" && row.uploaded_by_id.toLowerCase() === agentId).map((row) => row.id);
  return ids.every((id) => typeof id === "string" && UUID.test(id)) ? ids : null;
}

export const TOOLS: Record<string, ToolSpec> = {
  me: { kind: "read", description: "Your own agent profile and whether you are ready to work.", schema: obj({}), args: () => ["me"] },
  wallet_balance: { kind: "read", description: "Your wallet balance.", schema: obj({}), args: () => ["wallet", "balance"] },
  discover: {
    kind: "read",
    description: "Browse open tasks on the marketplace.",
    schema: obj({ status: { type: "string", enum: DISCOVER_STATUS, description: "open (taking bids) or bidding (has bids, none accepted); both when omitted" }, capability: s("capability filter"), budget_min: s("minimum budget, e.g. 10.00"), budget_max: s("maximum budget"), limit: { type: "number", description: "1-100" } }),
    args: (i) => ["discover", ...opt("status", i.status, oneOf(DISCOVER_STATUS)), ...opt("capability", i.capability, word), ...opt("budget-min", i.budget_min, money), ...opt("budget-max", i.budget_max, money), ...opt("limit", i.limit, limit)],
  },
  task_get: { kind: "read", description: "Full detail of one task.", schema: obj({ task_id: s("task UUID") }, ["task_id"]), args: (i) => ["task", "get", "--", uuid(i.task_id, "task_id")] },
  task_list: {
    kind: "read",
    description: "Tasks you are involved in.",
    schema: obj({
      kind: { type: "string", enum: TASK_KIND, description: "mine: tasks assigned to you (the default); queue: assigned but not yet claimed; posted: tasks you posted" },
      status: { type: "string", enum: MINE_STATUS, description: "only with kind mine; omit it for all your active tasks" },
      limit: { type: "number", description: "1-100" },
    }),
    args: (i) => {
      if (i.status !== undefined && i.kind !== undefined && i.kind !== "mine") bad("status filters only kind mine");
      return ["task", "list", ...opt("kind", i.kind, oneOf(TASK_KIND)), ...opt("status", i.status, oneOf(MINE_STATUS)), ...opt("limit", i.limit, limit)];
    },
  },
  bid_list: {
    kind: "read",
    description: "Bids you have placed.",
    schema: obj({ status: { type: "string", enum: BID_STATUS } }),
    args: (i) => ["bid", "list", ...opt("status", i.status, oneOf(BID_STATUS))],
  },
  message_list: { kind: "read", description: "Messages on one task.", schema: obj({ task_id: s("task UUID") }, ["task_id"]), args: (i) => ["message", "list", "--", uuid(i.task_id, "task_id")] },

  bid_create: {
    kind: "write",
    description: "Bid on an open task. One bid per task.",
    schema: obj({ task_id: s("task UUID"), price: s('your price, e.g. "40.00"'), pitch: s("why you fit, in your own words") }, ["task_id", "price"]),
    args: (i) => ["bid", "create", `--price=${money(i.price, "price")}`, ...opt("pitch", i.pitch, (v, n) => text(v, n, 2000)), "--", uuid(i.task_id, "task_id")],
    key: (i) => `bid:${uuid(i.task_id, "task_id")}`,
  },
  task_claim: {
    kind: "write",
    description: "Start work on a task assigned to you.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["task", "claim", "--", uuid(i.task_id, "task_id")],
    key: (i) => `claim:${uuid(i.task_id, "task_id")}`,
  },
  // A stake-tier task (worth $1 or more) needs this before task_claim can succeed. The
  // CLI quotes the stake, approves the token if needed, posts TaskBond.post and reports,
  // in one command. The deployment's task_bond_contract and default token are its own
  // defaults, so no address comes from the model or from an agent setting.
  bond_post: {
    kind: "money",
    description: "Post the performance bond a stake-tier task needs before you can claim it. Spends the stake the server quotes; the bond returns after clean settlement.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["bond", "post", "--", uuid(i.task_id, "task_id")],
    key: (i) => `bond:${uuid(i.task_id, "task_id")}`,
    amount: "bondStake",
    spendAfterPreflight: true,
  },
  // Stored calls hold summary-only submits, so artifacts stays optional and the key per task.
  task_submit: {
    kind: "write",
    description: "Submit your finished work on a task, with a summary and any files it needs.",
    schema: obj({ task_id: s("task UUID"), summary: s("what you delivered"), artifacts: artifactList }, ["task_id", "summary"]),
    args: deliver("submit"),
    files: artifactFiles,
    key: (i) => `submit:${uuid(i.task_id, "task_id")}`,
  },
  // The server allows a few remedies per dispute, so each different remedy is its own action.
  task_remedy: {
    kind: "write",
    description: "Resubmit revised work on a task disputed against you, with a summary and any files it needs.",
    schema: obj({ task_id: s("task UUID"), summary: s("what you changed and delivered"), artifacts: artifactList }, ["task_id", "summary"]),
    args: deliver("remedy"),
    files: artifactFiles,
    key: (i) => `remedy:${uuid(i.task_id, "task_id")}:${digest(JSON.stringify([text(i.summary, "summary"), artifactFiles(i).map((f) => f.path)]))}`,
  },
  message_send: {
    kind: "write",
    description: "Send a message on a task.",
    schema: obj({ task_id: s("task UUID"), content: s("the message") }, ["task_id", "content"]),
    args: (i) => ["message", "send", `--content=${text(i.content, "content")}`, "--", uuid(i.task_id, "task_id")],
    key: (i) => `message:${uuid(i.task_id, "task_id")}:${digest(text(i.content, "content"))}`,
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
  },
  // bid_accept and bid_reject run on the bid alone but keep task_id in their schema:
  // stored conversations hold calls with it, and recovery must still accept them.
  bid_accept: {
    kind: "write",
    description: "Accept a bid on your task. You fund its escrow afterwards with escrow_sign.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID") }, ["task_id", "bid_id"]),
    args: (i) => ["bid", "accept", "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `accept:${uuid(i.bid_id, "bid_id")}`,
  },
  bid_reject: {
    kind: "write",
    description: "Turn down a bid on your task.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID"), reason: s("optional reason") }, ["task_id", "bid_id"]),
    args: (i) => ["bid", "reject", ...opt("reason", i.reason, (v, n) => text(v, n, 500)), "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `reject:${uuid(i.bid_id, "bid_id")}`,
  },
  escrow_sign: {
    kind: "money",
    description: "Fund the escrow for a bid you accepted. Commits the bid's price.",
    schema: obj({ task_id: s("task UUID"), bid_id: s("bid UUID") }, ["task_id", "bid_id"]),
    args: (i) => ["escrow", "sign", "--", uuid(i.bid_id, "bid_id")],
    key: (i) => `escrow:${uuid(i.bid_id, "bid_id")}`,
    amount: "bidPrice",
  },
  task_approve: {
    kind: "write",
    description: "Approve the work submitted on your task. Releases the escrowed payment.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["task", "approve", "--", uuid(i.task_id, "task_id")],
    key: (i) => `approve:${uuid(i.task_id, "task_id")}`,
  },
  task_dispute: {
    kind: "write",
    description: "Dispute the work submitted on your task, with your reason.",
    schema: obj({ task_id: s("task UUID"), reason: s("why the work falls short") }, ["task_id", "reason"]),
    args: (i) => ["task", "dispute", `--reason=${text(i.reason, "reason", 2000)}`, "--", uuid(i.task_id, "task_id")],
    key: (i) => `dispute:${uuid(i.task_id, "task_id")}`,
  },
  settle: {
    kind: "write",
    description: "Settle a completed task so the payment is distributed.",
    schema: obj({ task_id: s("task UUID") }, ["task_id"]),
    args: (i) => ["settle", "--yes", "--", uuid(i.task_id, "task_id")],
    key: (i) => `settle:${uuid(i.task_id, "task_id")}`,
  },

  remember: { kind: "memory", description: "Keep a note for later turns.", schema: obj({ note: s("the note") }, ["note"]), args: (i) => (text(i.note, "note"), []) },
  forget: { kind: "memory", description: "Drop one of your notes by its number.", schema: obj({ index: { type: "number", description: "note number" } }, ["index"]), args: (i) => (Number.isInteger(i.index) && (i.index as number) >= 0 ? [] : bad("index must be a non-negative integer")) },
};

// Validates a tool call from the model. Returns the command args and action key, or
// throws with a message the model can read and correct.
export function prepare(tool: string, input: unknown): { spec: ToolSpec; args: string[]; key: string | null; files: ArtifactFile[]; input: Record<string, unknown> } {
  const spec = Object.hasOwn(TOOLS, tool) ? TOOLS[tool]! : bad(`no tool named ${tool}`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) bad("tool input must be an object");
  const i = { ...(input as Record<string, unknown>) };
  for (const k of Object.keys(i)) {
    if (!Object.hasOwn(spec.schema.properties, k)) bad(`${tool} has no field ${k}`);
    // UUID case is not marketplace identity. Normalize before both key construction
    // and the policy reads, so a fresh model call cannot vary casing to run twice.
    if (k === "task_id" || k === "bid_id") i[k] = uuid(i[k], k).toLowerCase();
  }
  return { spec, args: spec.args(i), key: spec.key ? spec.key(i) : null, files: spec.files ? spec.files(i) : [], input: i };
}
