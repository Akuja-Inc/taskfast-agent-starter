import type { ToolSpec } from "../src/core/tools.js";

// Keeps the TOOLS table and the taskfast CLI from drifting apart. The CLI side is the raw
// `--help` text of every command in fixtures/cli/surface.json (re-captured with
// scripts/capture-cli-surface.mjs, never by `pnpm check`); cli-parity.test.ts runs the
// check offline. It fails when a tool passes a flag or a value the CLI's own argument
// parser refuses, and when a CLI command has neither a tool nor a reason below.

// Every CLI command no tool runs, by command or command group, with the reason.
export const EXCLUDED: Record<string, string> = {
  "init": "owner setup: wallet, webhook and funding belong to setup-agent",
  "config": "owner setup: the agent's config file is code and config, not the model's",
  "skills": "owner setup: the owner installs skills into the agent folder",
  "ping": "host health check, not marketplace work",
  "events": "the host owns event admission (ACK means durable admission), so events are not model tools",
  "webhook": "host setup: the host receives events over its own stream",
  "cast": "arbitrary contract calls and transactions do not fit the money rules; money.ts runs `cast call` only to read a token's decimals",
  "backer": "owner-level allowlist management, authenticated with a human PAT",
  "agent update-me": "max-task-budget and daily-spend-limit are owner-set guardrails; a profile-only tool needs its own decision",
  "artifact upload": "task_submit and task_remedy upload through --artifact; a lone upload is never delivered",
  "artifact delete": "policy runs it to clear the agent's own uploads before a submit with files",
  "artifact cid": "delivery by an externally pinned CID; the kit delivers the files the model writes",
  "artifact cid-status": "verdict on a CID delivery, which the kit never makes",
};

// Flags no tool passes even where a command takes them: code and config own wallets,
// keys, RPC endpoints and file paths, and the model never sees them. An amount is only
// ever the quote priceOf inserts at dispatch (stake's --amount), never a tool's args.
const NEVER = new Set(["keystore", "wallet-password-file", "wallet-address", "rpc-url", "criteria-file", "amount"]);

// Valid calls per tool that set every schema field between them, so every flag a tool
// can pass is built and checked. A new field fails the check until its sample is here.
const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "550e8400-e29b-41d4-a716-446655440001";
const files = [{ name: "results.json", content: "{}" }];
export const SAMPLES: Record<string, Record<string, unknown> | Record<string, unknown>[]> = {
  me: {},
  wallet_balance: {},
  discover: { status: "open", assignment_type: "direct", capability: "writing,research", budget_min: "10.00", budget_max: "40.00", cursor: "c2", limit: 5 },
  task_get: { task_id: T },
  task_list: { kind: "mine", status: "in_progress", cursor: "c2", limit: 5 },
  bid_list: { status: "pending", cursor: "c2", limit: 5 },
  message_list: { task_id: T, cursor: "c2", limit: 5 },
  message_conversations: { task_id: T },
  platform_config: {},
  agent_list: { capability: "writing", cursor: "c2", limit: 5 },
  agent_get: { agent_id: B },
  dispute_get: { task_id: T },
  artifact_list: { task_id: T, cursor: "c2", limit: 5 },
  artifact_get: { task_id: T, artifact_id: B },
  payment_get: { task_id: T },
  payment_list: { status: "disbursed", from: "2026-10-01", to: "2026-10-31", cursor: "c2", limit: 5 },
  // review_list takes exactly one of task_id or agent_id, so it needs two calls.
  review_list: [{ task_id: T, cursor: "c2", limit: 5 }, { agent_id: B }],
  review_create: { task_id: T, reviewee_id: B, rating: 5, comment: "Clean work" },
  bid_create: { task_id: T, price: "40.00", pitch: "I write well" },
  task_claim: { task_id: T },
  task_refuse: { task_id: T },
  task_abort: { task_id: T },
  task_concede: { task_id: T },
  bid_cancel: { bid_id: B },
  bond_post: { task_id: T },
  stake: { task_id: T },
  task_retry_fee: { task_id: T },
  task_submit: { task_id: T, summary: "Done", artifacts: files },
  task_remedy: { task_id: T, summary: "Fixed", artifacts: files },
  message_send: { task_id: T, content: "Hello" },
  task_bids: { task_id: T, cursor: "c2", limit: 5 },
  post_task: {
    title: "Title", description: "Do it", budget: "40.00", pickup_deadline_hours: 24, capabilities: "writing,research",
    criteria: [{ description: "has results", check_type: "file_exists", check_expression: "results.json", expected_value: "true" }],
    execution_deadline: "2026-10-20T17:00:00Z", venue: "tempo-zone-moderato", assignment_type: "direct", direct_agent_id: B,
  },
  task_reassign: { task_id: T, agent_id: B },
  task_open: { task_id: T },
  task_edit: { task_id: T, title: "Logo", description: "A logo", budget_max: "50.00", review_window_hours: 24, remedy_window_hours: 48 },
  task_cancel: { task_id: T },
  task_reopen: { task_id: T },
  bid_accept: { task_id: T, bid_id: B },
  bid_reject: { task_id: T, bid_id: B, reason: "Too high" },
  escrow_sign: { task_id: T, bid_id: B },
  task_approve: { task_id: T },
  task_dispute: { task_id: T, reason: "Incomplete" },
  settle: { task_id: T },
};

// A command's own options (the CLI's global ones removed), each with the values its
// parser accepts, or null when it takes any value.
export interface CliCommand { leaf: boolean; options: Map<string, string[] | null> }

// Long help gives each option a block: its line, then indented text where clap lists the
// values either inline or one per line under "Possible values:".
const optionsOf = (help: string) =>
  new Map(help.split(/\n(?= +(?:-\w, )?--[a-z0-9-])/).slice(1).map((block) => {
    const name = /^ +(?:-\w, )?--([a-z0-9-]+)/.exec(block)![1]!;
    const inline = /\[possible values: ([^\]]+)\]/.exec(block)?.[1]!.split(", ");
    const listed = /Possible values:\n/.test(block) ? [...block.matchAll(/^ +- ([a-z0-9-]+):/gm)].map((m) => m[1]!) : undefined;
    return [name, inline ?? listed ?? null] as const;
  }));

export function parseSurface(help: Record<string, string>): Map<string, CliCommand> {
  const global = optionsOf(help[""] ?? "");
  return new Map(Object.entries(help).filter(([path]) => path).map(([path, text]) => {
    const options = optionsOf(text);
    for (const name of global.keys()) options.delete(name);
    return [path, { leaf: !text.includes("\nCommands:\n"), options }];
  }));
}

// Whether an entry naming a command or a command group covers `path`.
export const excludedBy = (path: string, key: string) => path === key || path.startsWith(`${key} `);

export function parityProblems(tools: Record<string, ToolSpec>, surface: Map<string, CliCommand>, excluded = EXCLUDED, samples = SAMPLES): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  // The command one built call runs, and each flag and value it passes.
  const check = (tool: string, input: Record<string, unknown>) => {
    let args: string[];
    try { args = tools[tool]!.args(input); }
    catch (e) { return problems.push(`${tool}: refuses ${JSON.stringify(input)}: ${(e as Error).message}`); }
    const end = args.includes("--") ? args.indexOf("--") : args.length;
    const flag = args.findIndex((a) => a.startsWith("-"));
    const start = flag < 0 ? end : flag;
    const path = args.slice(0, start).join(" ");
    const command = surface.get(path);
    if (!command?.leaf) return problems.push(`${tool}: \`taskfast ${path}\` is not a CLI command`);
    used.add(path);
    for (const arg of args.slice(start, end)) {
      const [, name, value] = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(arg) ?? [];
      if (!name) problems.push(`${tool}: passes ${JSON.stringify(arg)}, which is not a --name=value option`);
      else if (NEVER.has(name)) problems.push(`${tool}: passes --${name}, which code and config own`);
      else if (!command.options.has(name)) problems.push(`${tool}: \`taskfast ${path}\` has no --${name}`);
      else {
        const values = command.options.get(name);
        if (values && (value === undefined || !values.includes(value))) problems.push(`${tool}: passes --${name}=${value}, but the CLI accepts only ${values.join(", ")}`);
        const field = name.replaceAll("-", "_");
        const prop = tools[tool]!.schema.properties[field];
        if (values && prop && !prop.enum) problems.push(`${tool}: ${field} is free text, but --${name} accepts only ${values.join(", ")}`);
      }
    }
  };

  for (const [tool, spec] of Object.entries(tools)) {
    if (spec.kind === "memory") continue;
    // Fields that exclude each other take one call each; together they set every field.
    const calls = [samples[tool] ?? []].flat();
    const sample = calls[0];
    const fields = Object.keys(spec.schema.properties);
    if (!sample || fields.some((f) => !calls.some((call) => f in call))) {
      problems.push(`${tool}: SAMPLES needs a call that sets every field (${fields.join(", ")})`);
      continue;
    }
    for (const call of calls) check(tool, call);
    // Every advertised value, on its own beside the required fields, or in the full
    // sample when it needs a partner field (assignment_type direct and direct_agent_id).
    const required = Object.fromEntries(spec.schema.required.map((f) => [f, sample[f]]));
    const builds = (input: Record<string, unknown>) => { try { spec.args(input); return true; } catch { return false; } };
    for (const [field, prop] of Object.entries(spec.schema.properties)) {
      for (const value of prop.enum ?? []) check(tool, builds({ ...required, [field]: value }) ? { ...required, [field]: value } : { ...sample, [field]: value });
    }
  }

  for (const [path, command] of surface) {
    if (command.leaf && !used.has(path) && !Object.keys(excluded).some((key) => excludedBy(path, key))) problems.push(`\`taskfast ${path}\` has no tool and no reason in EXCLUDED`);
  }
  for (const key of Object.keys(excluded)) {
    const paths = [...surface.keys()].filter((path) => excludedBy(path, key));
    if (paths.length === 0) problems.push(`EXCLUDED names \`taskfast ${key}\`, which the CLI does not have`);
    for (const path of paths.filter((p) => used.has(p))) problems.push(`EXCLUDED names \`taskfast ${path}\`, which a tool runs`);
  }
  return [...new Set(problems)];
}
