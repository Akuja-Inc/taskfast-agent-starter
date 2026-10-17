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

  it("marks exactly the three tools that commit funds as money, each with a code-side amount source", () => {
    const money = Object.entries(TOOLS).filter(([, t]) => t.kind === "money");
    expect(money.map(([n, t]) => [n, t.amount])).toEqual([["bond_post", "bondStake"], ["post_task", "submissionFee"], ["escrow_sign", "bidPrice"]]);
    expect(Object.values(TOOLS).filter((t) => t.kind !== "money").every((t) => t.amount === undefined)).toBe(true);
    // The model cannot hand escrow a price: the tool has no such field.
    expect(Object.keys(TOOLS.escrow_sign!.schema.properties)).toEqual(["task_id", "bid_id"]);
    // A bond post can sign before it refuses, so its failures must stay uncertain.
    expect(Object.entries(TOOLS).filter(([, t]) => t.kind === "money" && t.spendAfterPreflight === true).map(([n]) => n)).toEqual(["bond_post"]);
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

  it.each([
    ["a budget with letters", { title: "x", description: "y", budget: "lots", pickup_deadline_hours: 24 }, /decimal amount/],
    ["a pickup window the server does not offer", { title: "x", description: "y", budget: "10.00", pickup_deadline_hours: 48 }, /one of 1, 4, 12, 24, 72/],
    ["an empty title", { title: " ", description: "y", budget: "10.00", pickup_deadline_hours: 24 }, /title must be non-empty/],
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
