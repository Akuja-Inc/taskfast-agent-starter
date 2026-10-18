import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ownUploads, prepare, TOOLS } from "./tools.js";

const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("prepare", () => {
  it("builds each command with options as --name=value and positionals after --", () => {
    expect(prepare("task_get", { task_id: T }).args).toEqual(["task", "get", "--", T]);
    expect(prepare("bid_create", { task_id: T, price: "40.00", pitch: "I do this daily" }).args).toEqual(["bid", "create", "--price=40.00", "--pitch=I do this daily", "--", T]);
    expect(prepare("task_submit", { task_id: T, summary: "Done: 12 pages" }).args).toEqual(["task", "submit", "--summary=Done: 12 pages", "--", T]);
    expect(prepare("message_send", { task_id: T, content: "Two questions" }).args).toEqual(["message", "send", "--content=Two questions", "--", T]);
    expect(prepare("discover", { capability: "writing", budget_max: "50", limit: 10 }).args).toEqual(["discover", "--capability=writing", "--budget-max=50", "--limit=10"]);
    expect(prepare("wallet_balance", {}).args).toEqual(["wallet", "balance"]);
  });

  it("keeps a value that looks like a flag inside its own option", () => {
    const { args } = prepare("message_send", { task_id: T, content: "--env prod" });
    expect(args).toContain("--content=--env prod");
    expect(args.filter((a) => a === "--env" || a === "prod")).toEqual([]);
  });

  it.each([
    ["a task id that is a flag", "task_get", { task_id: "--env=prod" }, /task_id must be a UUID/],
    ["a task id that is not a UUID", "task_claim", { task_id: "t-1" }, /task_id must be a UUID/],
    ["a price with letters", "bid_create", { task_id: T, price: "40 USD" }, /decimal amount/],
    ["a limit over 100", "discover", { limit: 500 }, /1 to 100/],
    ["a status with spaces", "task_list", { status: "in progress" }, /must be one of assigned, in_progress/],
    ["a task collection the CLI does not list", "task_list", { kind: "assigned" }, /must be one of mine, queue, posted/],
    ["a status filter on another collection", "task_list", { kind: "posted", status: "assigned" }, /status filters only kind mine/],
    ["a discover status the CLI does not list", "discover", { status: "assigned" }, /must be one of open, bidding/],
    ["an assignment type the CLI does not list", "discover", { assignment_type: "auction" }, /must be one of open, direct/],
    ["an empty capability between commas", "discover", { capability: "writing,,research" }, /capability must be a single word/],
    ["a cursor with spaces", "bid_list", { cursor: "next page" }, /next_cursor a previous page returned/],
    ["an empty cursor", "task_bids", { task_id: T, cursor: "" }, /next_cursor a previous page returned/],
    ["a page size over 100", "message_list", { task_id: T, limit: 101 }, /1 to 100/],
    ["an empty summary", "task_submit", { task_id: T, summary: "  " }, /non-empty text/],
    ["an unknown field", "task_get", { task_id: T, env: "prod" }, /has no field env/],
    ["an unknown tool", "withdraw_all", {}, /no tool named withdraw_all/],
    ["a non-object input", "task_get", [T], /must be an object/],
    ["an inherited tool name", "toString", {}, /no tool named toString/],
  ])("refuses %s", (_n, tool, input, why) => {
    expect(() => prepare(tool, input)).toThrow(why);
  });

  it("passes a status filter in the CLI's kebab case (the server's words are checked against the contract in test/tools-contract.test.ts)", () => {
    expect(prepare("bid_list", { status: "accepted_pending_escrow" }).args).toEqual(["bid", "list", "--status=accepted-pending-escrow"]);
    expect(prepare("task_list", { kind: "mine", status: "under_review" }).args).toEqual(["task", "list", "--kind=mine", "--status=under-review"]);
  });

  it("reads past the first page with the cursor a list returned, before the positionals", () => {
    const next = "eyJpZCI6IjQyIn0=";
    expect(prepare("task_bids", { task_id: T, cursor: next, limit: 100 }).args).toEqual(["task", "bids", `--cursor=${next}`, "--limit=100", "--", T]);
    expect(prepare("message_list", { task_id: T, cursor: next }).args).toEqual(["message", "list", `--cursor=${next}`, "--", T]);
    expect(prepare("bid_list", { cursor: next, limit: 5 }).args).toEqual(["bid", "list", `--cursor=${next}`, "--limit=5"]);
    expect(prepare("task_list", { kind: "posted", cursor: next }).args).toEqual(["task", "list", "--kind=posted", `--cursor=${next}`]);
    expect(prepare("discover", { cursor: next }).args).toEqual(["discover", `--cursor=${next}`]);
  });

  it("filters discover by assignment type and by every capability a task must require", () => {
    expect(prepare("discover", { assignment_type: "direct", capability: "writing, research" }).args).toEqual(["discover", "--assignment-type=direct", "--capability=writing", "--capability=research"]);
    // A stored call with one tag still runs as it did.
    expect(prepare("discover", { capability: "writing" }).args).toEqual(["discover", "--capability=writing"]);
  });

  it("keys each write so it can run once: per task, or per task and message text", () => {
    expect(prepare("bid_create", { task_id: T, price: "40.00" }).key).toBe(`bid:${T}`);
    expect(prepare("bid_create", { task_id: T, price: "55.00" }).key).toBe(`bid:${T}`);
    expect(prepare("task_claim", { task_id: T }).key).toBe(`claim:${T}`);
    expect(prepare("task_submit", { task_id: T, summary: "a" }).key).toBe(`submit:${T}`);
    const m1 = prepare("message_send", { task_id: T, content: "hello" }).key;
    expect(m1).toMatch(new RegExp(`^message:${T}:[0-9a-f]{16}$`));
    expect(prepare("message_send", { task_id: T, content: "hello" }).key).toBe(m1);
    expect(prepare("message_send", { task_id: T, content: "hello again" }).key).not.toBe(m1);
    expect(prepare("task_get", { task_id: T }).key).toBeNull();
  });

  it("marks exactly the five tools that commit funds as money, each with a code-side amount source", () => {
    const money = Object.entries(TOOLS).filter(([, t]) => t.kind === "money");
    expect(money.map(([n, t]) => [n, t.amount])).toEqual([["bond_post", "bondStake"], ["stake", "stakeQuote"], ["post_task", "submissionFee"], ["task_retry_fee", "submissionFee"], ["escrow_sign", "bidPrice"]]);
    // The model cannot name a stake: code passes the quote as --amount.
    expect(Object.keys(TOOLS.stake!.schema.properties)).toEqual(["task_id"]);
    expect(prepare("stake", { task_id: T })).toMatchObject({ args: ["stake", "--", T], key: `stake:${T}` });
    expect(prepare("task_retry_fee", { task_id: T })).toMatchObject({ args: ["task", "retry-fee", "--", T], key: `retry-fee:${T}` });
    expect(Object.values(TOOLS).filter((t) => t.kind !== "money").every((t) => t.amount === undefined)).toBe(true);
    // The model cannot hand escrow a price: the tool has no such field.
    expect(Object.keys(TOOLS.escrow_sign!.schema.properties)).toEqual(["task_id", "bid_id"]);
    // A bond post can sign before it refuses, so its failures must stay uncertain.
    expect(Object.entries(TOOLS).filter(([, t]) => t.kind === "money" && t.spendAfterPreflight === true).map(([n]) => n)).toEqual(["bond_post"]);
  });

  it("builds the reads a poster and a worker need, ids after --", () => {
    const A = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("platform_config", {}).args).toEqual(["platform", "config"]);
    expect(prepare("message_conversations", { task_id: T }).args).toEqual(["message", "conversations", "--", T]);
    expect(prepare("agent_list", { capability: "writing", limit: 10 }).args).toEqual(["agent", "list", "--capability=writing", "--limit=10"]);
    expect(prepare("agent_get", { agent_id: A.toUpperCase() }).args).toEqual(["agent", "get", "--", A]);
    expect(prepare("dispute_get", { task_id: T }).args).toEqual(["dispute", "--", T]);
    expect(prepare("artifact_list", { task_id: T, cursor: "c2" }).args).toEqual(["artifact", "list", "--cursor=c2", "--", T]);
    expect(prepare("artifact_get", { task_id: T, artifact_id: A }).args).toEqual(["artifact", "get", "--", T, A]);
    expect(prepare("payment_get", { task_id: T }).args).toEqual(["payment", "get", "--", T]);
    expect(prepare("payment_list", { status: "disbursed", from: "2026-10-01", to: "2026-10-31" }).args).toEqual(["payment", "list", "--status=disbursed", "--from=2026-10-01", "--to=2026-10-31"]);
    expect(prepare("review_list", { agent_id: A }).args).toEqual(["review", "list", `--agent=${A}`]);
    expect(prepare("review_list", { task_id: T, limit: 5 }).args).toEqual(["review", "list", `--task=${T}`, "--limit=5"]);
    for (const tool of ["platform_config", "agent_list", "agent_get", "dispute_get", "artifact_list", "artifact_get", "payment_get", "payment_list", "review_list", "message_conversations"]) expect(TOOLS[tool]!.kind).toBe("read");
  });

  it("writes one review per task and reviewee", () => {
    const A = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("review_create", { task_id: T, reviewee_id: A.toUpperCase(), rating: 5, comment: "Clean, on time" })).toMatchObject({
      args: ["review", "create", `--reviewee-id=${A}`, "--rating=5", "--comment=Clean, on time", "--", T],
      key: `review:${T}:${A}`,
    });
  });

  it.each([
    ["a review list with both a task and an agent", "review_list", { task_id: T, agent_id: T }, /exactly one of task_id or agent_id/],
    ["a review list with neither", "review_list", {}, /exactly one of task_id or agent_id/],
    ["a rating of 6 stars", "review_create", { task_id: T, reviewee_id: T, rating: 6, comment: "x" }, /1 to 5/],
    ["a half-star rating", "review_create", { task_id: T, reviewee_id: T, rating: 4.5, comment: "x" }, /1 to 5/],
    ["an empty review", "review_create", { task_id: T, reviewee_id: T, rating: 4, comment: " " }, /comment must be non-empty/],
    ["a payment date that is not a day", "payment_list", { from: "October" }, /from must be a date/],
    ["a payment date that does not exist", "payment_list", { to: "2026-02-30" }, /to must be a date/],
    ["a payment status the CLI does not list", "payment_list", { status: "settled" }, /must be one of pending, disbursed, held, failed/],
    ["an artifact id that is a flag", "artifact_get", { task_id: T, artifact_id: "--env=prod" }, /artifact_id must be a UUID/],
  ])("refuses %s", (_n, tool, input, why) => {
    expect(() => prepare(tool, input)).toThrow(why);
  });

  it("builds the worker lifecycle commands, each once per task or bid", () => {
    const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("task_refuse", { task_id: T })).toMatchObject({ args: ["task", "refuse", "--", T], key: `refuse:${T}` });
    expect(prepare("task_abort", { task_id: T })).toMatchObject({ args: ["task", "abort", "--", T], key: `abort:${T}` });
    expect(prepare("task_concede", { task_id: T })).toMatchObject({ args: ["task", "concede", "--", T], key: `concede:${T}` });
    expect(prepare("bid_cancel", { bid_id: B.toUpperCase() })).toMatchObject({ args: ["bid", "cancel", "--", B], key: `withdraw:${B}` });
    expect(() => prepare("bid_cancel", { bid_id: "--env=prod" })).toThrow(/bid_id must be a UUID/);
  });

  it("builds the worker commands", () => {
    expect(prepare("task_claim", { task_id: T }).args).toEqual(["task", "claim", "--", T]);
    expect(prepare("bond_post", { task_id: T }).args).toEqual(["bond", "post", "--", T]);
    expect(prepare("bond_post", { task_id: T }).key).toBe(`bond:${T}`);
    expect(Object.keys(TOOLS.bond_post!.schema.properties)).toEqual(["task_id"]);
  });

  it("builds the poster commands", () => {
    const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("post_task", { title: "Logo", description: "A logo for a bakery", budget: "40.00", pickup_deadline_hours: 24 }).args).toEqual(["post", "--title=Logo", "--description=A logo for a bakery", "--budget=40.00", "--pickup-deadline-hours=24", "--yes"]);
    expect(prepare("escrow_sign", { task_id: T, bid_id: B }).args).toEqual(["escrow", "sign", "--", B]);
    expect(prepare("escrow_sign", { task_id: T, bid_id: B }).key).toBe(`escrow:${B}`);
    expect(prepare("bid_accept", { bid_id: B }).args).toEqual(["bid", "accept", "--", B]);
    expect(prepare("bid_reject", { bid_id: B, reason: "out of budget" }).args).toEqual(["bid", "reject", "--reason=out of budget", "--", B]);
    expect(prepare("task_approve", { task_id: T }).args).toEqual(["task", "approve", "--", T]);
    expect(prepare("task_dispute", { task_id: T, reason: "missing pages" }).args).toEqual(["task", "dispute", "--reason=missing pages", "--", T]);
    expect(prepare("settle", { task_id: T }).args).toEqual(["settle", "--yes", "--", T]);
    expect(prepare("task_bids", { task_id: T }).args).toEqual(["task", "bids", "--", T]);
  });

  const post = { title: "Logo", description: "A logo for a bakery", budget: "40.00", pickup_deadline_hours: 24 };
  const gate = { description: "has results", check_type: "file_exists", check_expression: "results.json", expected_value: "true" };

  it("posts a direct task with capabilities, criteria, a deadline and a venue, each as its own option", () => {
    const A = "9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D";
    const { args, key } = prepare("post_task", { ...post, capabilities: "design, branding", criteria: [gate, { ...gate, check_type: "json_schema", check_expression: '{"type":"object"}', target_artifact_pattern: "*.json" }], execution_deadline: "2026-10-20T17:00:00Z", venue: "tempo-zone-moderato", assignment_type: "direct", direct_agent_id: A });
    expect(args).toEqual([
      "post", "--title=Logo", "--description=A logo for a bakery", "--budget=40.00", "--pickup-deadline-hours=24", "--capabilities=design,branding",
      `--criterion=${JSON.stringify({ ...gate, target_artifact_pattern: null })}`,
      `--criterion=${JSON.stringify({ ...gate, check_type: "json_schema", check_expression: '{"type":"object"}', target_artifact_pattern: "*.json" })}`,
      "--execution-deadline=2026-10-20T17:00:00Z", "--venue=tempo-zone-moderato", "--assignment-type=direct", `--direct-agent-id=${A.toLowerCase()}`, "--yes",
    ]);
    // The same title and description are the same post, whatever else changed.
    expect(key).toBe(prepare("post_task", post).key);
  });

  it("builds the direct task commands, keyed by task and new agent", () => {
    const A = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("task_reassign", { task_id: T, agent_id: A.toUpperCase() })).toMatchObject({ args: ["task", "reassign", `--agent-id=${A}`, "--", T], key: `reassign:${T}:${A}` });
    expect(prepare("task_open", { task_id: T })).toMatchObject({ args: ["task", "open", "--", T], key: `open:${T}` });
  });

  it("builds the poster lifecycle commands, one edit action per different change", () => {
    expect(prepare("task_edit", { task_id: T, budget_max: "55.00", review_window_hours: 12 }).args).toEqual(["task", "edit", "--budget-max=55.00", "--review-window-hours=12", "--", T]);
    expect(prepare("task_edit", { task_id: T, title: "New", description: "Text", remedy_window_hours: 72 }).args).toEqual(["task", "edit", "--title=New", "--description=Text", "--remedy-window-hours=72", "--", T]);
    const key = prepare("task_edit", { task_id: T, budget_max: "55.00" }).key;
    expect(key).toBe(prepare("task_edit", { task_id: T, budget_max: "55.00" }).key);
    expect(key).not.toBe(prepare("task_edit", { task_id: T, budget_max: "60.00" }).key);
    expect(prepare("task_cancel", { task_id: T })).toMatchObject({ args: ["task", "cancel", "--", T], key: `cancel:${T}` });
    expect(prepare("task_reopen", { task_id: T })).toMatchObject({ args: ["task", "reopen", "--", T], key: `reopen:${T}` });
    expect(() => prepare("task_edit", { task_id: T })).toThrow(/at least one field/);
    expect(() => prepare("task_edit", { task_id: T, review_window_hours: 96 })).toThrow(/review-window-hours must be 1 to 72/);
    expect(() => prepare("task_edit", { task_id: T, budget_max: "a lot" })).toThrow(/decimal amount/);
  });

  it.each([
    ["a budget with letters", { title: "x", description: "y", budget: "lots", pickup_deadline_hours: 24 }, /decimal amount/],
    ["a pickup window the server does not offer", { title: "x", description: "y", budget: "10.00", pickup_deadline_hours: 48 }, /one of 1, 4, 12, 24, 72/],
    ["an empty title", { title: " ", description: "y", budget: "10.00", pickup_deadline_hours: 24 }, /title must be non-empty/],
    ["a direct task with no agent", { ...post, assignment_type: "direct" }, /direct_agent_id goes with assignment_type direct/],
    ["an agent on an open task", { ...post, direct_agent_id: T }, /direct_agent_id goes with assignment_type direct/],
    ["a direct agent that is not a UUID", { ...post, assignment_type: "direct", direct_agent_id: "--env=prod" }, /direct_agent_id must be a UUID/],
    ["a capability with spaces", { ...post, capabilities: "data entry" }, /capabilities must be a single word/],
    ["a deadline that is not RFC 3339", { ...post, execution_deadline: "next Friday" }, /RFC 3339/],
    ["a deadline on a day that does not exist", { ...post, execution_deadline: "2026-02-31T10:00:00Z" }, /RFC 3339/],
    ["a deadline in a month that does not exist", { ...post, execution_deadline: "2026-13-01T10:00:00Z" }, /RFC 3339/],
    ["a venue with spaces", { ...post, venue: "tempo zone" }, /venue must be a single word/],
    ["an empty criteria list", { ...post, criteria: [] }, /criteria must be a list of 1 to 10/],
    ["a criterion with an unknown check type", { ...post, criteria: [{ ...gate, check_type: "ai_judge" }] }, /check_type must be one of json_schema/],
    ["a criterion with an extra field", { ...post, criteria: [{ ...gate, path: "/etc/passwd" }] }, /each criterion is/],
    ["a criterion missing its expected value", { ...post, criteria: [{ ...gate, expected_value: undefined }] }, /expected_value must be non-empty/],
  ])("refuses a post with %s", (_n, input, why) => {
    expect(() => prepare("post_task", input)).toThrow(why);
  });

  it("names the right id in a bad bid id error", () => {
    expect(() => prepare("bid_accept", { bid_id: "--env=prod" })).toThrow(/bid_id must be a UUID/);
  });
});

describe("artifacts", () => {
  const results = { name: "results.json", content: '{"results":[1,2,3]}\n' };
  const at = (name: string, content: string) => `.pi-state/artifacts/${T}/${createHash("sha256").update(content).digest("hex").slice(0, 16)}/${name}`;
  const D = "0123456789abcdef";

  it("writes each file under a folder code chooses and passes its path as an option before --", () => {
    const call = prepare("task_submit", { task_id: T.toUpperCase(), summary: "Delivered", artifacts: [results, { name: "notes.md", content: "# Notes" }] });
    expect(call.files).toEqual([{ path: at("results.json", results.content), content: results.content }, { path: at("notes.md", "# Notes"), content: "# Notes" }]);
    expect(call.args).toEqual(["task", "submit", "--summary=Delivered", `--artifact=${at("results.json", results.content)}`, `--artifact=${at("notes.md", "# Notes")}`, "--", T]);
    expect(call.key).toBe(`submit:${T}`);
    expect(prepare("task_remedy", { task_id: T, summary: "Revised", artifacts: [results] }).args).toEqual(["task", "remedy", "--summary=Revised", `--artifact=${at("results.json", results.content)}`, "--", T]);
  });

  it("keeps a stored summary-only submit valid, with no files", () => {
    expect(prepare("task_submit", { task_id: T, summary: "Done" }).files).toEqual([]);
    expect(TOOLS.task_submit!.schema.required).toEqual(["task_id", "summary"]);
  });

  it("keys a remedy by its content, so a changed remedy is a new action", () => {
    const key = prepare("task_remedy", { task_id: T, summary: "Revised", artifacts: [results] }).key;
    expect(key).toMatch(new RegExp(`^remedy:${T}:[0-9a-f]{16}$`));
    expect(prepare("task_remedy", { task_id: T, summary: "Revised", artifacts: [results] }).key).toBe(key);
    expect(prepare("task_remedy", { task_id: T, summary: "Revised", artifacts: [{ ...results, content: "{}" }] }).key).not.toBe(key);
    expect(prepare("task_remedy", { task_id: T, summary: "Revised again", artifacts: [results] }).key).not.toBe(key);
  });

  it.each([
    ["a path", { name: "../results.json", content: "x" }, /artifact name/],
    ["a folder", { name: "out/results.json", content: "x" }, /artifact name/],
    ["a hidden file", { name: ".env.txt", content: "x" }, /artifact name/],
    ["a flag", { name: "--env=prod.txt", content: "x" }, /artifact name/],
    ["a binary type", { name: "report.pdf", content: "x" }, /artifact name/],
    ["empty content", { name: "a.txt", content: "" }, /a.txt content must be 1 to 262144 bytes/],
    ["content over 256 KiB", { name: "a.txt", content: "é".repeat(131073) }, /content must be 1 to 262144 bytes/],
    ["an extra field", { name: "a.txt", content: "x", path: "/etc/passwd" }, /each artifact is \{ name, content \}/],
    ["both content and media", { name: "logo.png", content: "x", media: `media:${D}.png` }, /each artifact is \{ name, content \} or \{ name, media \}/],
    ["neither content nor media", { name: "a.txt" }, /each artifact is \{ name, content \} or \{ name, media \}/],
    ["image text from the model", { name: "logo.png", content: "x" }, /logo.png is an image: deliver it as \{ name, media \}/],
    ["video text from the model", { name: "clip.mp4", content: "x" }, /deliver it as \{ name, media \}/],
    ["a video type mismatch", { name: "clip.mov", media: `media:${D}.mp4` }, /clip.mov must end in .mp4/],
    ["an image name for a video", { name: "clip.png", media: `media:${D}.webm` }, /clip.png must end in .webm/],
    ["a path-shaped video handle", { name: "clip.mp4", media: "media:../clip.mp4" }, /media must be a handle/],
    ["a media path", { name: "logo.png", media: ".pi-state/media/0123456789abcdef.png" }, /media must be a handle/],
    ["a traversing handle", { name: "logo.png", media: "media:../x.png" }, /media must be a handle/],
    ["a short digest", { name: "logo.png", media: "media:abc.png" }, /media must be a handle/],
    ["an absolute path", { name: "logo.png", media: "/etc/passwd" }, /media must be a handle/],
    ["a handle for another type", { name: "logo.jpg", media: `media:${D}.png` }, /logo.jpg must end in .png to match its media/],
    ["a text name for media", { name: "notes.txt", media: `media:${D}.png` }, /notes.txt must end in .png/],
  ])("refuses an artifact with %s", (_n, artifact, why) => {
    expect(() => prepare("task_submit", { task_id: T, summary: "Done", artifacts: [artifact] })).toThrow(why);
  });

  it("delivers an SVG the model writes as text", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(prepare("task_submit", { task_id: T, summary: "Done", artifacts: [{ name: "diagram.svg", content: svg }] }).files).toEqual([{ path: at("diagram.svg", svg), content: svg }]);
  });

  it("delivers a saved image by its handle, beside text, under a folder named by its bytes", () => {
    const call = prepare("task_submit", { task_id: T, summary: "Done", artifacts: [{ name: "logo.png", media: `media:${D}.png` }, { name: "photo.jpeg", media: `media:${D}.jpg` }, results] });
    expect(call.files).toEqual([
      { path: `.pi-state/artifacts/${T}/${D}/logo.png`, media: `.pi-state/media/${D}.png`, digest: D },
      { path: `.pi-state/artifacts/${T}/${D}/photo.jpeg`, media: `.pi-state/media/${D}.jpg`, digest: D },
      { path: at("results.json", results.content), content: results.content },
    ]);
    expect(call.args).toEqual(["task", "submit", "--summary=Done", `--artifact=.pi-state/artifacts/${T}/${D}/logo.png`, `--artifact=.pi-state/artifacts/${T}/${D}/photo.jpeg`, `--artifact=${at("results.json", results.content)}`, "--", T]);
  });

  it.each(["mp4", "webm", "mov"])("delivers a saved %s video beside text and images, with stable remedy keys", (ext) => {
    const video = { name: `clip.${ext}`, media: `media:${D}.${ext}` };
    const path = `.pi-state/artifacts/${T}/${D}/clip.${ext}`;
    const input = { task_id: T, summary: "Done", artifacts: [video, { name: "logo.png", media: `media:${D}.png` }, results] };
    const call = prepare("task_submit", input);
    expect(call.files[0]).toEqual({ path, media: `.pi-state/media/${D}.${ext}`, digest: D });
    expect(call.args).toContain(`--artifact=${path}`);
    const key = prepare("task_remedy", input).key;
    expect(prepare("task_remedy", input).key).toBe(key);
    expect(prepare("task_remedy", { ...input, artifacts: [{ ...video, media: `media:${"f".repeat(16)}.${ext}` }] }).key).not.toBe(key);
  });

  it("keys a remedy with media by the image's bytes", () => {
    const remedy = (media: string) => prepare("task_remedy", { task_id: T, summary: "Revised", artifacts: [{ name: "logo.png", media }] }).key;
    expect(remedy(`media:${D}.png`)).toBe(remedy(`media:${D}.png`));
    expect(remedy(`media:${"f".repeat(16)}.png`)).not.toBe(remedy(`media:${D}.png`));
  });

  it("lets the model leave out content for a media artifact, and keeps { name, content } valid", () => {
    expect(TOOLS.task_submit!.schema.properties.artifacts!.items!.required).toEqual(["name"]);
    expect(Object.keys(TOOLS.task_remedy!.schema.properties.artifacts!.items!.properties)).toEqual(["name", "content", "media"]);
  });

  it("refuses an empty list, more than five files and repeated names", () => {
    const file = (n: number) => ({ name: `part${n}.txt`, content: "x" });
    expect(() => prepare("task_submit", { task_id: T, summary: "Done", artifacts: [] })).toThrow(/1 to 5 files/);
    expect(() => prepare("task_submit", { task_id: T, summary: "Done", artifacts: [1, 2, 3, 4, 5, 6].map(file) })).toThrow(/1 to 5 files/);
    expect(() => prepare("task_submit", { task_id: T, summary: "Done", artifacts: [file(1), file(1)] })).toThrow(/unique/);
  });

  it("reads this agent's own uploads from real `taskfast artifact list` output", () => {
    const me = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const row = (id: string, by: string) => ({ id, uploaded_by_id: by });
    const other = "550e8400-e29b-41d4-a716-446655440009";
    expect(ownUploads({ artifacts: [row(other, T), row("550e8400-e29b-41d4-a716-446655440001", me.toUpperCase())] }, me)).toEqual(["550e8400-e29b-41d4-a716-446655440001"]);
    expect(ownUploads({ artifacts: [row("--env=prod", me)] }, me)).toBeNull();
    expect(ownUploads({ data: [] }, me)).toBeNull();
  });
});
