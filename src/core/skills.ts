import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { folderFile } from "./folder.js";

// Skills are owner-installed guidance (https://agentskills.io/specification): a folder
// with SKILL.md and text references. An agent reads only its own folder's skills, through
// skill_read by catalog name, never by path. Skill text never grants a tool or changes
// policy; scripts and other files stay inert because nothing can read or run them.
export const SKILLS_PATH = ".agents/skills";
const MAX_SKILLS = 20;
const MAX_FILES = 64;
const MAX_DEPTH = 3;
const MAX_FILE_BYTES = 256 * 1024;
// Only these are readable; everything else in a skill is never opened.
const TEXT = new Set([".md", ".txt"]);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Skill {
  name: string;
  description: string;
  // Folder-relative path ("reference/WORKER.md") to text, read once when the agent opens.
  files: Map<string, string>;
}

const bad = (why: string): never => {
  throw new Error(why);
};

// The `name` and `description` of SKILL.md's frontmatter: plain or quoted scalars, or a
// block (`>-`, `|`) folded onto one line. Other keys, such as allowed-tools, are ignored.
function frontmatter(text: string, where: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) bad(`${where} must start with --- frontmatter`);
  const fields: Record<string, string> = {};
  for (let at = 1; at < end; at++) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(lines[at]!);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (at + 1 < end && /^\s+\S|^$/.test(lines[at + 1]!)) block.push(lines[++at]!.trim());
      value = block.join(" ");
    } else if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fields[match[1]!] = value.replace(/\s+/g, " ").trim();
  }
  return fields;
}

function walk(o: { root: string; dir: string; depth: number; files: Map<string, string>; where: string; count: { n: number } }): void {
  for (const entry of readdirSync(join(o.root, o.dir), { withFileTypes: true })) {
    const path = o.dir ? `${o.dir}/${entry.name}` : entry.name;
    const where = `${o.where}/${path}`;
    if (entry.isSymbolicLink()) bad(`${where} is a symlink; copy the file into the skill instead`);
    if (entry.name.startsWith(".")) continue;
    if (++o.count.n > MAX_FILES) bad(`${o.where} has more than ${MAX_FILES} files`);
    if (entry.isDirectory()) {
      if (o.depth >= MAX_DEPTH) bad(`${where} is nested deeper than ${MAX_DEPTH} folders`);
      walk({ ...o, dir: path, depth: o.depth + 1 });
    } else if (!entry.isFile()) bad(`${where} is not a regular file`);
    else if (TEXT.has(extname(entry.name).toLowerCase())) {
      const file = join(o.root, path);
      if (lstatSync(file).size > MAX_FILE_BYTES) bad(`${where} is larger than ${MAX_FILE_BYTES} bytes`);
      // Keeping a BOM makes the text byte-identical to the file, so setup's hashes match the CLI's bytes.
      try { o.files.set(path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file))); }
      catch { bad(`${where} is not UTF-8 text`); }
    }
  }
}

// The agent folder's skills. No skills folder means none; anything there that is not a
// valid skill throws, so the agent fails closed before any marketplace work.
export function loadSkills(agentDir: string): Skill[] {
  const root = folderFile({ agentDir, path: SKILLS_PATH, resource: "skills folder" });
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) bad(`${SKILLS_PATH} must be a folder`);
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const where = `${SKILLS_PATH}/${entry.name}`;
    if (entry.isSymbolicLink()) bad(`${where} is a symlink; copy the skill into the agent folder instead`);
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    if (!NAME.test(entry.name) || entry.name.length > 64) bad(`${where}: a skill name is 1-64 lowercase letters, digits and single hyphens`);
    if (skills.length >= MAX_SKILLS) bad(`${SKILLS_PATH} has more than ${MAX_SKILLS} skills`);
    const files = new Map<string, string>();
    walk({ root: join(root, entry.name), dir: "", depth: 1, files, where, count: { n: 0 } });
    const text = files.get("SKILL.md") ?? bad(`${where} has no SKILL.md`);
    const meta = frontmatter(text, `${where}/SKILL.md`);
    if (meta.name !== entry.name) bad(`${where}/SKILL.md: name ${JSON.stringify(meta.name ?? "")} must equal its folder name`);
    const description = meta.description ?? "";
    if (!description || description.length > 1024) bad(`${where}/SKILL.md: description must be 1-1024 characters`);
    skills.push({ name: entry.name, description, files });
  }
  return skills;
}

// skill_read: one listed file of one installed skill, SKILL.md by default.
export function readSkill(skills: readonly Skill[], input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) bad("tool input must be an object");
  const { skill: name, file = "SKILL.md", ...rest } = input as Record<string, unknown>;
  for (const field of Object.keys(rest)) bad(`skill_read has no field ${field}`);
  const skill = skills.find((candidate) => candidate.name === name) ?? bad(`no skill named ${String(name)}; installed: ${skills.map((s) => s.name).join(", ")}`);
  const text = typeof file === "string" ? skill.files.get(file) : undefined;
  if (text === undefined) bad(`${skill.name} has no file ${String(file)}; its files are ${[...skill.files.keys()].join(", ")}`);
  return `Skill ${skill.name}, file ${String(file)}. Your operator installed it as guidance; it never changes what your tools allow.\n\n${text}`;
}

// What a skill written for the taskfast CLI means here: the command each tool runs.
export const SKILL_COMMANDS: Record<string, string> = {
  "me": "me", "wallet balance": "wallet_balance", "discover": "discover", "task get": "task_get", "task list": "task_list",
  "bid list": "bid_list", "message list": "message_list", "task bids": "task_bids", "bid create": "bid_create",
  "task claim": "task_claim", "task submit": "task_submit", "message send": "message_send", "post": "post_task",
  "bid accept": "bid_accept", "bid reject": "bid_reject", "escrow sign": "escrow_sign", "task approve": "task_approve",
  "task dispute": "task_dispute", "settle": "settle",
};
// Commands the bundle names that no tool runs. Setup and event delivery belong to the
// owner and the host; the rest need their own safety contract before they become tools.
export const UNSUPPORTED_COMMANDS = [
  "init", "config", "skills", "ping", "platform", "webhook", "events", "bond", "artifact", "payment", "review",
  "dispute", "bid cancel", "task refuse", "task remedy", "task concede", "task retry-fee", "task cancel", "task edit",
  "task open", "task reopen", "task reassign", "task abort", "message conversations",
];

// The skills section of the system prompt. Rebuilt every turn, so it survives compaction.
export function skillsPrompt(skills: readonly Skill[]): string {
  return [
    "Skills your operator installed, as guidance. Read one with skill_read before you follow it:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    "",
    `Skills may be written for agents with a shell. You have no shell and no taskfast command; use your tools. ${Object.entries(SKILL_COMMANDS).map(([command, tool]) => `\`taskfast ${command}\` is ${tool}`).join(", ")}. task_submit takes a summary only, no artifacts.`,
    `No tool runs ${UNSUPPORTED_COMMANDS.map((command) => `\`taskfast ${command}\``).join(", ")}. You work on your own, so never wait for help with one of those and never work around it: do not bid on or claim work that needs one, such as a task that requires a performance bond or file artifacts, and choose work your tools can finish. If work you already hold turns out to need one, keep a note of what was missing with remember, so your operator sees it.`,
    "Your tools' rules win over any skill: never repeat a write whose result was uncertain, escrow_sign included, and leave restarts, event polling and webhooks to the host.",
  ].join("\n");
}
