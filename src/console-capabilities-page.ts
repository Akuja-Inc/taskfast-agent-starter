/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ConsoleDestination } from "./console-navigation.js";
import type { CapabilityApproval, CapabilityFile, CapabilityServerConfig, CapabilityTest, CapabilityView } from "./capability-types.js";

/** Browser uploads keep their directory structure. The server validates the same bytes again. */
export async function readCapabilityFolder(files: readonly Pick<File, "name" | "size" | "webkitRelativePath" | "arrayBuffer">[]): Promise<{ name: string; description: string; files: CapabilityFile[] }> {
  if (!files.length || files.length > 64) throw new Error("Choose a folder containing 1–64 text files.");
  const result: CapabilityFile[] = [], seen = new Set<string>();
  let root = "", total = 0;
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2) throw new Error(file.name + ": the browser did not supply a folder path. Use a browser with directory upload support.");
    const folder = parts.shift()!;
    if (!root) root = folder;
    if (folder !== root) throw new Error(file.name + ": choose one skill folder at a time.");
    const path = parts.join("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[\\\u0000-\u001f:]/.test(part)) || parts.length > 3) throw new Error(path + ": unsafe, private or too deeply nested path.");
    if (!/\.(md|txt)$/i.test(path)) throw new Error(path + ": only .md and .txt files can be imported. Remove scripts, private files and other formats from a copy of the folder first.");
    if (seen.has(path)) throw new Error(path + ": duplicate path.");
    seen.add(path);
    if (file.size > 256 * 1024) throw new Error(path + ": exceeds the 256 KiB file limit.");
    total += file.size;
    if (total > 1024 * 1024) throw new Error(path + ": the folder exceeds the 1 MiB upload limit.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error(path + ": cannot read this file as UTF-8 text."); }
    if (text.includes("\u0000")) throw new Error(path + ": binary text is not supported.");
    result.push({ path, text });
  }
  const main = result.find((file) => file.path === "SKILL.md");
  if (!main) throw new Error("SKILL.md: required at the top of the selected folder.");
  const lines = main.text.split(/\r?\n/), end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error("SKILL.md: must start with --- metadata and a closing --- line.");
  const fields: Record<string, string> = {};
  for (let index = 1; index < end; index++) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < end && /^\s+\S|^$/.test(lines[index + 1]!)) block.push(lines[++index]!.trim());
      value = block.join(" ");
    } else if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fields[match[1]!] = value.replace(/\s+/g, " ").trim();
  }
  const name = fields.name || "", description = fields.description || "";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64 || name !== root) throw new Error("SKILL.md: name must match the selected folder and use 1–64 lowercase letters, digits and single hyphens.");
  if (!description || description.length > 1024) throw new Error("SKILL.md: description must contain 1–1024 characters.");
  return { name, description, files: result };
}

export const CAPABILITIES_CSS = `
header nav { flex-wrap:wrap; max-width:100%; }
.cap-page { display:block; width:100%; }
.cap-page h1 { font-size:28px; line-height:1.2; margin:0; }
.cap-page h2 { font-size:20px; margin:0; }
.cap-page h3 { font-size:17px; margin:0; }
.cap-page p { margin:0; max-width:75ch; }
.cap-page .band { position:static; }
.cap-identity { display:flex; flex-direction:column; gap:6px; margin-bottom:20px; overflow-wrap:anywhere; }
.cap-columns { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; }
.cap-section { min-width:0; background:var(--panel); border:1px solid var(--hairline); }
.cap-section .band { border-top:0; border-left:0; border-right:0; }
.cap-toolbar, .cap-actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.cap-toolbar { padding:16px 18px; }
.cap-row { padding:16px 18px; border-top:1px solid var(--hairline); display:flex; flex-direction:column; gap:8px; overflow-wrap:anywhere; }
.cap-row .cap-actions { justify-content:space-between; }
.cap-empty { padding:18px; color:var(--muted); }
.cap-detail { display:flex; flex-direction:column; gap:20px; background:var(--panel); border:1px solid var(--hairline); padding:24px; }
.cap-detail > form { display:flex; flex-direction:column; gap:20px; }
.cap-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.cap-form-grid > .cap-wide { grid-column:1 / -1; }
.cap-fields { display:flex; flex-direction:column; gap:12px; }
.cap-binding { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; align-items:end; gap:10px; }
.cap-arg { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:end; }
.cap-check { flex-direction:row; align-items:center; min-height:44px; font-size:15px; color:var(--ink); }
.cap-check input { width:22px; height:22px; min-height:22px; flex:none; }
.cap-page fieldset { margin:0; padding:16px; border:1px solid var(--hairline); min-width:0; }
.cap-page legend { padding:0 6px; font-weight:600; }
.cap-preview { max-height:400px; overflow:auto; }
.cap-pending { margin-top:24px; border:1px solid var(--hairline); background:var(--panel); padding:18px; display:flex; flex-direction:column; gap:12px; min-width:0; overflow-wrap:anywhere; }
.cap-status { white-space:pre-wrap; overflow-wrap:anywhere; }
.cap-status:empty, .cap-error:empty { display:none; }
.cap-error { white-space:pre-wrap; overflow-wrap:anywhere; }
.cap-steps { display:flex; flex-wrap:wrap; gap:8px 20px; padding:0; margin:0; list-style:none; color:var(--muted); }
.cap-steps [aria-current=step] { color:var(--ink); font-weight:700; text-decoration:underline; text-underline-offset:5px; }
.cap-page details > summary { min-height:44px; padding:10px 0; cursor:pointer; }
.cap-review-item { border-top:1px solid var(--hairline); padding-top:18px; display:flex; flex-direction:column; gap:12px; }
.cap-review-item h4 { font-size:16px; margin:0; }
.cap-comparison { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
.cap-page button:disabled { cursor:not-allowed; }
@media(max-width:700px) { .cap-columns,.cap-form-grid,.cap-comparison { grid-template-columns:minmax(0,1fr); } .cap-form-grid > .cap-wide { grid-column:auto; } .cap-binding { grid-template-columns:minmax(0,1fr); } .cap-detail { padding:16px; } .cap-page { padding:20px 16px; } }
`;

/** Destination identity only. Never serialize editor fields, credentials or approvals. */
type CapabilityRoute = ConsoleDestination["capability"];

/** This function is serialized into the single console page. Keep its dependencies explicit. */
export function capabilitiesPage(deps: {
  el: (tag: string, attrs: Record<string, unknown>, ...children: unknown[]) => HTMLElement;
  api: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<CapabilityView>;
  readFolder: typeof readCapabilityFolder;
  navigate: (route: CapabilityRoute) => void;
}) {
  const { el, api, readFolder } = deps;
  type Upload = Awaited<ReturnType<typeof readFolder>>;
  type Binding = { target: string; name: string; value: string; configured: boolean };
  type Editor = { name: string; transport: "remote" | "local"; url: string; command: string; args: string[]; cwd: string; bindings: Binding[]; step: number; consent: boolean; test: CapabilityTest | null; approved: Set<string>; revision: string };
  type State = { id: string; name: string; root: HTMLElement; body: HTMLElement; feedback: HTMLElement; pending: HTMLElement; data: CapabilityView | null; screen: CapabilityRoute["screen"]; item: string; step: number; dirty: boolean; busy: boolean; loading: boolean; revision: string; editor: Editor | null; upload: Upload | null; preview: (NonNullable<CapabilityView["skillPreview"]> & { revision: string }) | null; epoch: number; scroll: number; origin: string; error: string; notice: string; filter: string; requestId: string | null; readVersion: number };
  const states = new Map<string, State>();
  let current: State | null = null;
  function route(): CapabilityRoute {
    const s = current;
    if (!s) return { screen: "overview", item: "", step: 0 };
    return { screen: s.screen, item: ["skill", "server", "credential", "import"].includes(s.screen) ? s.item : "", step: s.screen === "server" ? s.editor?.step ?? s.step : 0 };
  }
  function navigate(s: State) { if (current === s) deps.navigate(route()); }
  function serverStep(s: State, editor: Editor, step: number) {
    editor.step = step; draw(s); navigate(s);
  }
  const button = (text: string, action: () => void, attrs: Record<string, unknown> = {}) => el("button", { type: "button", text, onclick: action, ...attrs });
  const disable = (node: HTMLElement, value: boolean) => { if (value) node.setAttribute("disabled", ""); else node.removeAttribute("disabled"); };
  const para = (text: string, cls = "small") => el("p", { class: cls, text });
  const title = (text: string) => el("h2", { tabindex: "-1", text });
  const group = (...children: unknown[]) => el("div", { class: "cap-actions" }, ...children);
  const check = (text: string, checked: boolean, action: (value: boolean) => void, disabled = false) => el("label", { class: "cap-check" }, el("input", { type: "checkbox", checked, disabled, onchange: (event: Event) => { if (event.target instanceof HTMLInputElement) action(event.target.checked); } }), text);
  const field = (text: string, value: string, change: (value: string) => void, attrs: Record<string, unknown> = {}) => el("label", {}, text, el("input", { value, type: "text", "data-field-label": text, autocomplete: "off", oninput: (event: Event) => { if (event.target instanceof HTMLInputElement) change(event.target.value); }, ...attrs }));
  const path = (s: State, action = "") => "/api/agents/" + encodeURIComponent(s.id) + "/capabilities" + (action ? "/" + action : "");
  const locked = (s: State) => s.busy || s.data?.apply.state === "waiting" || s.data?.apply.state === "applying";
  function message(s: State) {
    s.feedback.replaceChildren(
      el("div", { class: "error cap-error", id: "capability-field-error", role: "alert", text: s.error }),
      el("div", { class: "small cap-status", role: "status", "aria-live": "polite", text: s.notice }));
  }
  function receive(s: State, data: CapabilityView) {
    s.data = data;
    if (data.apply.state !== "idle") s.requestId = data.apply.requestId;
    for (const node of s.root.querySelectorAll<HTMLElement>(".cap-health")) node.textContent = connectionStatus(data, node.getAttribute("data-server") || "");
    pending(s);
  }
  async function load(s: State, redraw = false) {
    if (s.loading) return;
    s.loading = true;
    const version = s.readVersion;
    try {
      const oldRevision = s.data?.revision, oldApply = s.data?.apply.state;
      const data = await api("GET", path(s));
      if (version !== s.readVersion) return;
      receive(s, data);
      if (current !== s) return;
      if (oldRevision && oldRevision !== data.revision && s.screen !== "overview") { s.error = "Configuration changed since this detail page opened. Back to capabilities and review the current revision. Unsaved fields have not been replaced."; message(s); }
      if (redraw || !oldRevision || (s.screen === "overview" && oldRevision !== data.revision && !s.root.contains(document.activeElement))) draw(s);
      // Apply progress is independent of the editor. Never replace a focused form.
      if (oldApply !== data.apply.state && data.apply.state === "succeeded") { s.notice = "Applied. Active revision: " + (data.activeRevision || "none") + ". Check the agent's running or stopped status in the header."; message(s); }
    } catch { if (current === s) { s.error = "Cannot load capabilities. Check the console connection and retry."; message(s); if (!s.data) draw(s); } }
    finally { s.loading = false; }
  }
  async function command(s: State, action: string, body: Record<string, unknown> = {}, options: { stay?: boolean; revision?: string } = {}) {
    if (!s.data || s.busy) return null;
    if (locked(s) && action !== "cancel") { s.error = "Capability apply is " + s.data.apply.state + ". Cancel a waiting request or wait for publication to finish before editing pending changes."; message(s); return null; }
    const epoch = s.epoch, revision = options.revision || s.revision || s.data.revision;
    s.readVersion++;
    s.busy = true; s.error = ""; s.notice = action === "test" ? "Testing connection and discovering tools. No sample tools are called." : action === "preview-taskfast" ? "Reading the installed CLI bundle into temporary preview storage. No pending changes are being saved." : "Saving request…";
    message(s); pending(s);
    try {
      const data = await api("POST", path(s, action), { ...body, revision });
      receive(s, data);
      // A result belongs only to this agent and this editor session.
      if (current !== s || s.epoch !== epoch) return null;
      s.notice = action === "test" ? "Test passed; not active. Review tools individually." : action === "preview-taskfast" ? "Preview ready. No capability changes have been staged or activated." : "Request saved. Nothing changes until apply completes.";
      s.busy = false; s.revision = data.revision;
      if (!options.stay) { abandon(s); s.screen = "overview"; s.revision = data.revision; draw(s); ((s.origin ? s.root.querySelector<HTMLElement>("#" + s.origin) : null) || s.root.querySelector<HTMLElement>("h1"))?.focus({ preventScroll: true }); navigate(s); }
      message(s);
      return data;
    } catch (error) {
      if (current === s && s.epoch === epoch) {
        // Only this same-origin route's bounded, redacted JSON errors are safe to display.
        // Network/transport exceptions are never echoed, even if they contain a credential.
        const status = error instanceof Error && "status" in error ? error.status : undefined;
        const detail = error instanceof Error && "safeCapability" in error && error.safeCapability === true ? error.message : "";
        s.error = status === 409 ? "Configuration changed. Return to capabilities, refresh and review this revision before trying again." + (detail ? " " + detail : "") : detail || (action === "test" ? "Connection test failed. Check the destination, executable and credential bindings, then retry. Credential values are never shown." : "Request not confirmed. Refresh to check the actual state before retrying.");
        message(s);
        if (action === "stage-skill") {
          const picker = s.body.querySelector<HTMLInputElement>('input[type="file"]');
          if (picker) { picker.setAttribute("aria-invalid", "true"); picker.setAttribute("aria-describedby", "capability-field-error"); picker.focus(); }
        }
        void load(s);
      }
      return null;
    } finally { s.busy = false; pending(s); }
  }
  function abandon(s: State) {
    for (const input of s.root.querySelectorAll<HTMLInputElement>('input[type="password"]')) { input.value = ""; input.removeAttribute("value"); }
    s.epoch++; s.editor?.bindings.forEach((binding) => { binding.value = ""; }); s.editor = null; s.upload = null; s.preview = null; s.dirty = false;
  }
  function leave() {
    if (!current) return true;
    if (current.busy || current.dirty) { if (!confirm("Leave unsaved capability edits for " + current.name + "? New credential entries and test approvals will be cleared. Saved pending changes remain with this agent.")) return false; }
    abandon(current);
    if (current.screen === "server" || current.screen === "import" || current.screen === "taskfast") current.screen = "overview";
    current = null;
    return true;
  }
  function show(s: State, { screen, item, step }: CapabilityRoute) {
    abandon(s); s.screen = screen; s.item = item; s.step = step; s.revision = s.data?.revision || ""; s.error = ""; s.notice = "";
  }
  function go(s: State, screen: State["screen"], item = "", origin = "") {
    if (s.dirty && !confirm("Discard unsaved edits? New credential entries and test approvals will be cleared.")) return;
    if (s.screen === "overview") { s.scroll = window.scrollY; s.origin = origin; }
    show(s, { screen, item, step: 0 });
    draw(s);
    if (screen === "overview") {
      window.scrollTo({ top: s.scroll });
      ((s.origin ? s.root.querySelector<HTMLElement>("#" + s.origin) : null) || s.root.querySelector<HTMLElement>("h1"))?.focus({ preventScroll: true });
    } else { window.scrollTo({ top: 0 }); s.body.querySelector<HTMLElement>("h2")?.focus(); }
    navigate(s);
  }
  function pending(s: State) {
    const data = s.data;
    if (!data) { s.pending.hidden = true; return; }
    s.pending.hidden = false;
    const signature = JSON.stringify([data.revision, data.activeRevision, data.pending, data.apply, s.busy]);
    if (s.pending.dataset.signature === signature) return;
    s.pending.dataset.signature = signature;
    const focused = s.pending.contains(document.activeElement) ? document.activeElement?.textContent : null;
    const state = data.apply.state;
    const progress = state === "waiting" ? "Waiting for idle. This agent finishes its current run; new runs wait. You can cancel this apply request." : state === "applying" ? "Applying. Publishing and reopening only this agent. Publication cannot be cancelled." : state === "failed" ? "Apply failed. " + data.apply.error + " Active revision: " + (data.activeRevision || "none") + ". Check the agent's running or stopped status before retrying." : state === "succeeded" ? "Applied. Active revision: " + (data.activeRevision || "none") : state === "cancelled" ? "Apply cancelled. Pending changes remain." : data.pending ? "Pending changes. The active configuration has not changed." : "No pending changes.";
    s.pending.replaceChildren(el("strong", { text: progress }), para("Active revision: " + (data.activeRevision || "none") + " · Reviewed revision: " + data.revision),
      group(data.pending ? button("Review changes", () => go(s, "review"), { disabled: s.busy || state === "applying" || state === "waiting" }) : null,
        data.pending && !locked(s) ? button("Discard pending changes", () => { if (confirm("Discard all saved pending capability changes for " + s.name + "? Private staged credentials will be removed.")) void command(s, "discard", {}, { revision: data.revision }); }) : null,
        state === "waiting" ? button("Cancel waiting apply", () => { void command(s, "cancel", { requestId: data.apply.state !== "idle" ? data.apply.requestId : "" }, { stay: true, revision: data.revision }); }, { disabled: s.busy }) : null));
    if (focused) {
      const next = [...s.pending.querySelectorAll("button")].find((node) => node.textContent === focused);
      if (next) next.focus({ preventScroll: true });
      else { s.pending.setAttribute("tabindex", "-1"); s.pending.focus({ preventScroll: true }); }
    }
  }
  const savedSkills = (data: CapabilityView) => data.savedSkills ?? data.activeSkills;
  const savedServers = (data: CapabilityView) => data.savedServers ?? data.activeServers;
  function connectionStatus(data: CapabilityView, name: string) {
    const connection = data.connections?.find((item) => item.name === name);
    return "Connection: " + (connection ? connection.state === "connected" ? "Connected" : "Disconnected" : data.activeRevision && data.activeServers.some((server) => server.name === name && server.enabled) ? "Unknown" : "Not active");
  }
  function health(s: State, name: string) { return el("span", { class: "small cap-health", "data-server": name, text: connectionStatus(s.data!, name) }); }
  function overview(s: State) {
    const data = s.data!;
    const access = (name: string, enabled: boolean, kind: "skill" | "server") => {
      const before = (kind === "skill" ? savedSkills(data) : savedServers(data)).find((item) => item.name === name);
      const active = (kind === "skill" ? data.activeSkills : data.activeServers).find((item) => item.name === name);
      const after = (kind === "skill" ? data.skills : data.servers).find((item) => item.name === name);
      const change = data.pending && JSON.stringify(before) !== JSON.stringify(after);
      const now = data.activeRevision === null ? "Not loaded" : !active ? "Not installed" : active.enabled ? "Enabled" : "Disabled";
      const saved = !before ? "Not installed" : before.enabled ? "Enabled" : "Disabled";
      return "Active now: " + now + " · Saved on disk: " + saved + (change ? " → After apply: " + (enabled ? "Enabled" : "Disabled") + " · Pending change" : " · No pending item change");
    };
    const row = (name: string, enabled: boolean, source: string, kind: "skill" | "server") => el("article", { class: "cap-row", "data-cap-name": name },
      el("h3", { text: name }), para(source), kind === "server" ? health(s, name) : null,
      kind === "server" ? para(data.test?.name === name ? "Last discovery: Passed; not a live connection check or activation." : "Last discovery: No result in this host session.") : null, group(el("span", { text: access(name, enabled, kind) }), button(kind === "skill" ? "Inspect" : "Manage", () => go(s, kind, name, "cap-" + kind + "-" + name), { id: "cap-" + kind + "-" + name, "aria-label": (kind === "skill" ? "Inspect skill " : "Manage server ") + name, disabled: locked(s) })));
    const columns = el("div", { class: "cap-columns" },
      el("section", { class: "cap-section", "aria-label": "Skills" }, el("div", { class: "band", text: "Skills" }),
        el("div", { class: "cap-toolbar" }, button(data.skills.some((skill) => skill.name === "taskfast-agent") ? "Review TaskFast replacement" : "Add TaskFast skill", () => { void taskfast(s); }, { disabled: locked(s) }), button("Import folder", () => go(s, "import"), { disabled: locked(s) })),
        para("Guidance, not permission. Existing TaskFast tools work without a skill.", "cap-empty"),
        data.skills.length ? data.skills.map((skill) => row(skill.name, skill.enabled, skill.description + " · " + (skill.provenance ? skill.provenance.source + " " + skill.provenance.version : "Owner-imported folder"), "skill")) : para("No skills installed. Import a folder or add the installed CLI's TaskFast bundle.", "cap-empty")),
      el("section", { class: "cap-section", "aria-label": "MCP servers" }, el("div", { class: "band", text: "MCP servers" }),
        el("div", { class: "cap-toolbar" }, button("Add MCP server", () => go(s, "server"), { disabled: locked(s) })),
        para("Tool access and connection tests are separate. A passing test does not activate a server.", "cap-empty"),
        data.servers.length ? data.servers.map((server) => row(server.name, server.enabled, ("url" in server.config ? server.config.url : server.config.command) + " · " + server.approved.length + " approved tools", "server")) : para("No MCP servers configured. Add a remote server or an installed local program.", "cap-empty")));
    const filter = field("Filter skills and servers", s.filter, (value) => { s.filter = value; for (const element of columns.querySelectorAll<HTMLElement>("[data-cap-name]")) element.hidden = !data.pending && !element.textContent?.toLowerCase().includes(value.toLowerCase()); });
    const removed = [...savedSkills(data).filter((item) => !data.skills.some((after) => after.name === item.name)).map((item) => "Skill " + item.name), ...savedServers(data).filter((item) => !data.servers.some((after) => after.name === item.name)).map((item) => "Server " + item.name)];
    s.body.append(data.skills.length + data.servers.length > 8 ? filter : nullNode(), columns, removed.length ? el("div", { class: "note" }, el("strong", { text: "Pending removal" }), ...removed.map((name) => para(name + ": Saved on disk → Removed after apply"))) : nullNode(),
      data.credentials.length ? el("details", {}, el("summary", { text: "Configured credential bindings · names only" }), para("Removing a connection or binding does not silently delete its saved value. Remove unused credentials explicitly; bindings used by another server are protected."),
        ...data.credentials.map((name) => { const used = data.servers.some((server) => server.credentials.includes(name)); return group(para(name + " · Configured" + (used ? " · In use" : " · Unused")), button("Stage removal of " + name, () => { if (confirm("Remove unused private credential " + name + " from " + s.name + " after apply?")) void command(s, "remove-credential", { name }, { revision: data.revision }); }, { disabled: used || locked(s) })); })) : nullNode());
  }
  function nullNode() { return document.createTextNode(""); }
  async function taskfast(s: State) {
    const epoch = s.epoch;
    go(s, "taskfast");
    if (s.epoch === epoch || s.screen !== "taskfast") return;
    const data = await command(s, "preview-taskfast", {}, { stay: true, revision: s.revision });
    if (data?.skillPreview && current === s) { s.preview = { ...data.skillPreview, revision: data.revision }; draw(s); }
  }
  function taskfastPreview(s: State) {
    const preview = s.preview;
    s.body.append(title("Preview TaskFast skill"), para("Read the installed CLI bundle into temporary private storage for review. Preview does not change this agent's pending or active configuration. No account setup, software download or automatic update.", ""));
    if (!preview) { s.body.append(para("TaskFast previews are temporary and cannot be restored after leaving or reloading this page. Use the button below to explicitly read and validate the installed bundle again before choosing whether to stage it."), button("Read installed CLI bundle", () => { void taskfast(s); }, { disabled: locked(s) })); return; }
    const bundle = preview.skill, proposed = s.data!.skills.find((skill) => skill.name === bundle.name);
    const existing = proposed || savedSkills(s.data!).find((skill) => skill.name === bundle.name);
    let replace = false, enabled = existing?.enabled ?? true;
    s.body.append(el("h3", { text: bundle.name }), para(bundle.description, ""), para("Source: " + (bundle.provenance?.source || "installed TaskFast CLI") + " · Version: " + (bundle.provenance?.version || "not supplied")),
      bundle.provenance ? el("details", {}, el("summary", { text: "Preview provenance and file fingerprints" }), el("pre", { text: JSON.stringify(bundle.provenance, null, 2) })) : nullNode(), compatibility(),
      existing ? el("div", { class: "cap-comparison" }, el("section", {}, el("h3", { text: "Installed now · " + (existing.provenance?.version || "owner copy") }), para(existing.modifiedFiles?.length ? "Owner edits detected: " + existing.modifiedFiles.join(", ") : "Review recorded fingerprints below for owner edits."), filesPreview(existing.files, existing.provenance?.files)), el("section", {}, el("h3", { text: "Exact cached CLI preview · " + (bundle.provenance?.version || "unknown version") }), filesPreview(bundle.files, bundle.provenance?.files))) : filesPreview(bundle.files, bundle.provenance?.files));
    const stage = (enable: boolean) => { if (existing && !replace) return; void command(s, "taskfast-skill", { previewId: preview.previewId, replace: !!proposed, enabled: enable }, { revision: preview.revision }); };
    if (existing) {
      const save = button("Stage explicit replacement", () => stage(enabled), { class: "primary", disabled: true });
      s.body.append(check("Explicitly replace this agent's installed bundle, including owner edits", false, (value) => { replace = value; s.dirty = true; disable(save, !value || locked(s)); }),
        check("Enable after apply", enabled, (value) => { enabled = value; s.dirty = true; }), para("The existing enabled state is preserved unless you change it. Replacement stages exactly the cached files shown here."), save);
    } else s.body.append(group(button("Add and enable after apply", () => stage(true), { class: "primary", disabled: locked(s) }), button("Add disabled", () => stage(false), { disabled: locked(s) })));
  }
  function filesPreview(files: CapabilityFile[], hashes?: Record<string, string>) {
    return el("div", { class: "cap-fields" }, files.map((file) => {
      const status = para(hashes ? "Checking recorded provenance…" : "Owner-supplied text");
      if (hashes && file.text.includes("[redacted]")) status.textContent = "Preview contains redacted text. Browser fingerprint comparison is unavailable.";
      else if (hashes) {
        void crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.text)).then((digest) => {
          const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          status.textContent = !hashes[file.path] ? "Not in the recorded CLI bundle" : hashes[file.path] === actual ? "Matches recorded CLI fingerprint" : "Owner edits detected: differs from recorded CLI fingerprint";
        }).catch(() => { status.textContent = "Could not verify recorded fingerprint in this browser."; });
      }
      return el("details", {}, el("summary", { text: file.path }), status, el("pre", { class: "cap-preview", text: file.text }));
    }));
  }
  function compatibility() { return el("div", { class: "note" }, para("Skills add guidance only. No shell, scripts, raw HTML or remote images execute. They never change tool permissions or marketplace policy.", ""), para("Use the agent's existing TaskFast tools. File artifacts, payments, reviews, account setup, webhooks and CLI-only task changes remain unavailable. The agent must not claim work that needs an unavailable command."), para("Disabling or removing a skill cannot erase instructions already loaded into conversation history.")); }
  function skill(s: State) {
    const after = s.data!.skills.find((item) => item.name === s.item);
    // draw() shows "Destination unavailable" for a skill that no longer exists.
    const installed = (after || savedSkills(s.data!).find((item) => item.name === s.item))!;
    const active = s.data!.activeSkills.find((item) => item.name === installed.name);
    const saved = savedSkills(s.data!).find((item) => item.name === installed.name);
    if (!after) {
      s.body.append(title(installed.name), para("Active now: " + (active ? active.enabled ? "Enabled" : "Disabled" : "Not loaded") + ". Saved on disk: Installed."), para("Removal staged. This agent keeps its loaded conversation history. Discard this change to restore the saved disk copy, or import a new bundle with the same name.", "note"), filesPreview(installed.files, installed.provenance?.files), group(button("Discard this change", () => { void discardItem(s, "skill", installed.name); }, { disabled: locked(s) }), button("Replace from folder", () => go(s, "import", installed.name), { disabled: locked(s) })));
      return;
    }
    s.body.append(title(installed.name), para(installed.description, ""), para(installed.provenance ? "Source: " + installed.provenance.source + " · Version: " + installed.provenance.version : "Source: owner-imported folder"),
      installed.provenance ? el("details", {}, el("summary", { text: "Provenance and file fingerprints" }), el("pre", { text: JSON.stringify(installed.provenance, null, 2) })) : nullNode(),
      para("Active now: " + (active ? active.enabled ? "Enabled" : "Disabled" : "Not loaded") + " · Saved on disk: " + (saved ? saved.enabled ? "Enabled" : "Disabled" : "Not installed") + " · After apply: " + (installed.enabled ? "Enabled" : "Disabled")), compatibility(), saved && JSON.stringify(saved.files) !== JSON.stringify(installed.files) ? el("div", { class: "cap-comparison" }, el("section", {}, el("h3", { text: "Saved on disk" }), filesPreview(saved.files, saved.provenance?.files)), el("section", {}, el("h3", { text: "After apply" }), filesPreview(installed.files, installed.provenance?.files))) : filesPreview(installed.files, installed.provenance?.files),
      group(button(installed.enabled ? "Stage disable" : "Stage enable", () => { void command(s, "skill", { name: installed.name, operation: installed.enabled ? "disable" : "enable" }); }, { disabled: locked(s) }),
        button("Replace from folder", () => go(s, "import", installed.name), { disabled: locked(s) }),
        installed.name === "taskfast-agent" ? button("Review CLI bundle replacement", () => { void taskfast(s); }, { disabled: locked(s) }) : null,
        button("Stage removal", () => { if (confirm("Remove only " + s.name + "'s installed copy of " + installed.name + " after apply? Loaded conversation history is retained.")) void command(s, "skill", { name: installed.name, operation: "remove" }); }, { disabled: locked(s) })));
  }
  function importer(s: State) {
    s.body.append(title(s.item ? "Replace skill from folder" : "Import a skill folder"), para("Choose one local folder with SKILL.md at its root. Keep only .md and .txt files. Up to 64 files, 256 KiB per file and 1 MiB total. Nested paths stay intact.", ""), para("Browsers cannot attest symlink provenance. Import a copied text-only folder; the server validates destination paths and refuses unsafe files."));
    const picker = el("input", { type: "file", webkitdirectory: true, multiple: true, "aria-label": "Skill folder", onchange: async (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.files) return;
      const files = [...event.target.files], epoch = ++s.epoch;
      s.upload = null; s.dirty = false; s.error = ""; s.notice = "Reading and validating folder…"; draw(s);
      try {
        const upload = await readFolder(files);
        if (current !== s || s.epoch !== epoch) return;
        if (s.item && upload.name !== s.item) throw new Error("SKILL.md: replacement name must be " + s.item + ".");
        s.upload = upload; s.dirty = true; s.notice = "Folder validated locally. Review each file before staging."; draw(s);
      } catch (error) { if (current === s && s.epoch === epoch) {
        s.upload = null; s.notice = ""; s.error = error instanceof Error ? error.message : "Cannot read this folder."; draw(s);
        const invalid = s.body.querySelector<HTMLInputElement>('input[type="file"]');
        if (invalid) { invalid.setAttribute("aria-invalid", "true"); invalid.setAttribute("aria-describedby", "capability-field-error"); invalid.focus(); }
      } }
    } });
    s.body.append(para("Folder uploads are temporary and cannot be restored after leaving or reloading this page. Choose the folder again to preview its files. No files are staged automatically."), el("label", {}, "Choose folder", picker));
    const upload = s.upload;
    if (!upload) return;
    const proposed = s.data!.skills.find((item) => item.name === upload.name);
    const existing = proposed || savedSkills(s.data!).find((item) => item.name === upload.name);
    let replace = false, enabled = existing?.enabled ?? true;
    s.body.append(el("h3", { text: upload.name }), para(upload.description, ""), compatibility(),
      existing ? el("div", { class: "cap-comparison" }, el("div", {}, el("h3", { text: "Installed files" }), filesPreview(existing.files, existing.provenance?.files)), el("div", {}, el("h3", { text: "Replacement files" }), filesPreview(upload.files))) : filesPreview(upload.files));
    if (existing) s.body.append(check("Explicitly replace this agent's existing bundle, including owner edits", false, (value) => { replace = value; disable(save, !value); }));
    s.body.append(check("Enable after apply", enabled, (value) => { enabled = value; }));
    const save = button(existing ? "Stage explicit replacement" : "Stage imported skill", () => { if (!existing || replace) void command(s, "stage-skill", { files: upload.files.map((file) => ({ path: upload.name + "/" + file.path, text: file.text })), replace: !!proposed && replace, enabled }); }, { class: "primary", disabled: !!existing });
    s.body.append(save);
  }
  function makeEditor(s: State): Editor {
    const server = s.data!.servers.find((item) => item.name === s.item) || savedServers(s.data!).find((item) => item.name === s.item), config = server?.config;
    return { name: server?.name || "", transport: config && "command" in config ? "local" : "remote", url: config && "url" in config ? config.url : "", command: config && "command" in config ? config.command : "", args: config && "command" in config ? [...config.args || []] : [], cwd: config && "command" in config ? config.cwd || "." : ".", bindings: Object.entries(config ? "command" in config ? config.env || {} : config.headers || {} : {}).map(([target, name]) => ({ target, name, value: "", configured: s.data!.credentials.includes(name) })), step: s.step, consent: false, test: null, approved: new Set(), revision: s.revision || s.data!.revision };
  }
  function configOf(editor: Editor): CapabilityServerConfig {
    const bindings = Object.fromEntries(editor.bindings.map((binding) => [binding.target, binding.name]));
    return editor.transport === "remote" ? { url: editor.url, headers: bindings } : { command: editor.command, args: [...editor.args], cwd: editor.cwd, env: bindings };
  }
  function secretsOf(editor: Editor) { return Object.fromEntries(editor.bindings.filter((binding) => binding.value).map((binding) => [binding.name, binding.value])); }
  function validation(editor: Editor) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(editor.name)) return "Server name: use 1–32 lowercase letters, digits and hyphens.";
    if (editor.transport === "local") {
      if (!editor.command.startsWith("/") || /[\r\n\u0000]/.test(editor.command)) return "Installed executable: enter an absolute executable path, not a shell command.";
      if (editor.cwd.startsWith("/") || editor.cwd.split(/[\\/]/).some((part) => part === "..") || /[\r\n\u0000]/.test(editor.cwd)) return "Working directory: use a path inside the agent folder, or . for its root.";
      if (editor.args.length > 64 || editor.args.some((arg) => arg.length > 4096 || /[\u0000\r\n]/.test(arg))) return "Arguments: use up to 64 rows, each at most 4096 characters, without newlines.";
    } else {
      try { const url = new URL(editor.url); if (url.username || url.password || url.hash || url.search || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return "Remote URL: use HTTPS (HTTP only for loopback), without credentials, query parameters or fragments."; }
      catch { return "Remote URL: enter a complete HTTPS destination."; }
    }
    const targets = new Set(), names = new Set();
    for (const binding of editor.bindings) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(binding.name)) return "Credential binding: use an uppercase environment-style name.";
      if (editor.transport === "local" ? !/^[A-Z][A-Z0-9_]*$/.test(binding.target) || ["PATH", "HOME"].includes(binding.target) : !/^[A-Za-z0-9-]{1,64}$/.test(binding.target)) return "Credential destination: use a valid header name or uppercase environment variable. PATH and HOME belong to the host.";
      if (targets.has(binding.target) || names.has(binding.name)) return "Credential bindings: each destination and binding name must be unique.";
      if (!binding.value && !binding.configured) return "Credential binding " + binding.name + ": enter a new value or use an existing configured name.";
      targets.add(binding.target); names.add(binding.name);
    }
    const publicFields = JSON.stringify(editor.transport === "remote" ? [editor.name, editor.url] : [editor.name, editor.command, editor.args, editor.cwd]);
    if (editor.bindings.some((binding) => binding.value && publicFields.includes(JSON.stringify(binding.value).slice(1, -1)))) return "Connection details: keep credential values out of names, URLs, executable paths, arguments and working directories. Use the named credential bindings instead.";
    return "";
  }
  function invalidate(s: State, editor: Editor) { s.epoch++; s.dirty = true; editor.test = null; editor.approved.clear(); editor.consent = false; }
  function execution(s: State, editor: Editor) {
    return el("div", { class: "note" }, el("strong", { text: editor.transport === "remote" ? "Remote destination" : "Local execution, not a sandbox" }),
      el("pre", { text: editor.transport === "remote" ? "URL: " + editor.url : "Executable: " + editor.command + "\nArguments (one JSON string per row):\n" + editor.args.map((arg) => JSON.stringify(arg)).join("\n") + "\nWorking directory: " + s.data!.agentDir + (editor.cwd === "." ? "" : "/" + editor.cwd) }),
      para("Credential bindings: " + (editor.bindings.map((binding) => binding.target + " ← " + binding.name + (binding.value ? " (new value)" : " (Configured)")).join(", ") || "none")),
      para(editor.transport === "local" ? "Testing starts real code with the host user's privileges. Only PATH, HOME and these bindings are inherited. Agent scope is not a sandbox." : "Testing contacts this destination and sends these credential bindings. No automatic OAuth or legacy SSE."),
      para("Discovery lists tools only. Cancel cannot undo process or network effects. Applying an enabled connection may start this program or contact this destination again."));
  }
  function connection(s: State, editor: Editor) {
    const controls = el("div", { class: "cap-fields" });
    controls.append(field("Server name", editor.name, (value) => { editor.name = value; invalidate(s, editor); }, { readonly: !!s.item }),
      el("label", {}, "Connection type", el("select", { onchange: (event: Event) => { if (!(event.target instanceof HTMLSelectElement)) return; editor.transport = event.target.value === "local" ? "local" : "remote"; editor.bindings.forEach((binding) => { binding.value = ""; }); editor.bindings = []; invalidate(s, editor); draw(s); } }, el("option", { value: "remote", selected: editor.transport === "remote", text: "Remote server · Streamable HTTP" }), el("option", { value: "local", selected: editor.transport === "local", text: "Local program · stdio" }))));
    if (editor.transport === "remote") controls.append(field("Remote URL", editor.url, (value) => { editor.url = value; invalidate(s, editor); }, { type: "url", placeholder: "https://…" }));
    else {
      controls.append(field("Installed executable (absolute path)", editor.command, (value) => { editor.command = value; invalidate(s, editor); }, { placeholder: "/absolute/path/to/program" }),
        para("No shell command, package installer or software download. Keep credentials out of arguments."),
        el("fieldset", {}, el("legend", { text: "Arguments · one argument per row" }),
          el("div", { class: "cap-fields" }, editor.args.map((arg, index) => el("div", { class: "cap-arg" }, field("Argument " + (index + 1), arg, (value) => { editor.args[index] = value; invalidate(s, editor); }), button("Remove argument " + (index + 1), () => { editor.args.splice(index, 1); invalidate(s, editor); draw(s); }))), button("Add argument", () => { editor.args.push(""); invalidate(s, editor); draw(s); }))),
        field("Working directory (relative to this agent folder)", editor.cwd, (value) => { editor.cwd = value; invalidate(s, editor); }), para("Agent folder: " + s.data!.agentDir));
    }
    controls.append(el("fieldset", {}, el("legend", { text: "Credential bindings" }), para("Saved values only show Configured. Type a replacement to rotate a value; values are never revealed, copied or saved in browser storage."),
      el("div", { class: "cap-fields" }, editor.bindings.map((binding, index) => el("div", { class: "cap-binding" },
        field(editor.transport === "local" ? "Environment variable" : "HTTP header", binding.target, (value) => { binding.target = value; invalidate(s, editor); }),
        el("div", { class: "cap-fields" }, field("Private binding name", binding.name, (value) => { binding.name = value; binding.configured = s.data!.credentials.includes(value); invalidate(s, editor); }), field(binding.configured ? "Configured · enter replacement" : "New credential value", binding.value, (value) => { binding.value = value; invalidate(s, editor); }, { type: "password", autocomplete: "new-password", spellcheck: "false" })),
        button("Remove binding " + (index + 1), () => { binding.value = ""; editor.bindings.splice(index, 1); invalidate(s, editor); draw(s); }))), button("Add credential binding", () => { editor.bindings.push({ target: "", name: "", value: "", configured: false }); invalidate(s, editor); draw(s); }))));
    controls.append(button("Continue to test and review tools", () => {
      s.error = validation(editor);
      if (s.error) {
        message(s);
        const prefix = s.error.split(":")[0]!;
        const target = [...s.body.querySelectorAll<HTMLInputElement>("input")].find((node) => node.getAttribute("data-field-label")?.startsWith(prefix)) || s.body.querySelector<HTMLInputElement>(".cap-binding input");
        if (target) { target.setAttribute("aria-invalid", "true"); target.setAttribute("aria-describedby", "capability-field-error"); target.focus(); }
        return;
      }
      serverStep(s, editor, 1); s.body.querySelector<HTMLElement>("h2")?.focus();
    }, { class: "primary", disabled: s.busy }));
    return controls;
  }
  function testTools(s: State, editor: Editor) {
    const tools = el("div", { class: "cap-fields" }, execution(s, editor),
      check(editor.transport === "local" ? "I consent to starting exactly this executable with these arguments, directory and credential bindings for discovery." : "I consent to contacting exactly this destination and sending these credential bindings for discovery.", editor.consent, (value) => { editor.consent = value; disable(testButton, !value || s.busy); }));
    const testButton = button(editor.test ? "Retest connection" : "Test connection", async () => {
      if (!editor.consent || s.busy) return;
      const epoch = s.epoch; disable(testButton, true);
      const data = await command(s, "test", { name: editor.name, config: configOf(editor), secrets: secretsOf(editor), consent: true }, { stay: true, revision: editor.revision });
      if (current !== s || epoch !== s.epoch) return;
      editor.approved.clear(); editor.test = data?.test?.name === editor.name ? data.test : null;
      if (!editor.test) { disable(testButton, false); return; }
      // Tests are revision-bound. A successful discovery may update private staging.
      editor.revision = data!.revision; s.revision = data!.revision;
      draw(s);
    }, { disabled: !editor.consent || s.busy });
    tools.append(testButton, para("Only individually reviewed read tools can be approved. Server read-only labels are claims, not a guarantee. Reads can disclose task content and incur costs outside TaskFast spending limits."));
    if (editor.test) {
      tools.append(el("strong", { text: "Test passed; not active" }));
      if (!editor.test.tools.length) tools.append(para("This server returned no tools. You may save it disabled."));
      for (const tool of editor.test.tools) {
        const panel = el("fieldset", {}, el("legend", { text: tool.name }), para(tool.description, ""),
          el("details", {}, el("summary", { text: "Review input and output schemas" }), el("pre", { text: JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }, null, 2) })),
          el("details", {}, el("summary", { text: "Server claims · not independently verified" }), el("pre", { text: JSON.stringify(tool.annotations ?? {}, null, 2) })), para("Definition fingerprint: " + tool.hash));
        panel.append(tool.blocked ? para("Unavailable: known write or unsafe tool. It cannot be approved.", "error") : check("I reviewed this contract and approve " + tool.name + " as a read", editor.approved.has(tool.name), (value) => { if (value) editor.approved.add(tool.name); else editor.approved.delete(tool.name); s.dirty = true; }));
        tools.append(panel);
      }
    }
    tools.append(group(button("Back to connection", () => { serverStep(s, editor, 0); }), button("Continue to review and save", () => { serverStep(s, editor, 2); }, { class: "primary", disabled: s.busy })));
    return tools;
  }
  function saveServer(s: State, editor: Editor) {
    const approved: CapabilityApproval[] = (editor.test?.tools || []).filter((tool) => !tool.blocked && editor.approved.has(tool.name)).map((tool) => ({ name: tool.name, hash: tool.hash, read: true }));
    const tested = !!editor.test;
    const save = async (enabled: boolean) => {
      if (s.busy || (enabled && (!tested || !approved.length))) return;
      const data = await command(s, "server", { name: editor.name, config: configOf(editor), secrets: secretsOf(editor), enabled, testId: editor.test?.testId, approved: enabled ? approved : [] }, { revision: editor.revision });
      if (data) editor.bindings.forEach((binding) => { binding.value = ""; });
    };
    return el("div", { class: "cap-fields" }, execution(s, editor),
      para("Tool access after apply: " + (approved.map((tool) => tool.name).join(", ") || "none"), ""),
      para(tested ? "Only these reviewed fingerprints will be saved. Later new or changed tools require a new review." : "Not tested. Only Save disabled is available."),
      para("Credential changes: " + (editor.bindings.filter((binding) => binding.value).map((binding) => binding.name + (binding.configured ? " · Replaced" : " · Added")).join(", ") || "none")),
      group(button("Back to test and review tools", () => { serverStep(s, editor, 1); }), button("Save disabled", () => { void save(false); }, { disabled: s.busy }), button("Save and enable after apply", () => { void save(true); }, { class: "primary", disabled: s.busy || !tested || !approved.length })));
  }
  function server(s: State) {
    const editor = s.editor || (s.editor = makeEditor(s));
    const after = s.data!.servers.find((item) => item.name === s.item);
    const installed = after || savedServers(s.data!).find((item) => item.name === s.item);
    const active = s.data!.activeServers.find((item) => item.name === s.item);
    if (installed && !after) s.body.append(para("Removal staged. Saving this form restores a connection to pending changes. Discard the removal in Review changes to restore its saved disk configuration.", "note"));
    s.body.append(title(installed ? "Manage " + installed.name : "Add MCP server"),
      installed ? para("Saved on disk: " + (savedServers(s.data!).some((item) => item.name === installed.name) ? "Installed" : "Not installed") + " · Active now: " + (active ? active.enabled ? "Configured enabled" : "Configured disabled" : "Not loaded") + ". Saved configuration does not imply a live connection.") : nullNode(),
      para(installed ? (installed.enabled ? "Configured access: enabled" : "Configured access: disabled") + " · " + installed.approved.length + " approved tools. Editing requires a fresh test and renewed review before enabling." : "Configure a connection, consent to discovery, then review each tool. Nothing is approved by default.", ""),
      el("ol", { class: "cap-steps", "aria-label": "Server setup steps" }, ["Connection", "Test and review tools", "Review and save"].map((label, index) => el("li", { "aria-current": editor.step === index ? "step" : null, text: (index + 1) + ". " + label }))),
      editor.step === 0 ? connection(s, editor) : editor.step === 1 ? testTools(s, editor) : saveServer(s, editor));
    if (installed) s.body.append(health(s, installed.name), para(editor.test ? "Last discovery: Passed for this form. Still not activation." : "Last discovery: No current test for this form. Existing access is not approval of edited settings."), group(after?.enabled ? button("Stage disable without editing", () => {
      if (s.dirty && !confirm("Discard unsaved connection and credential edits and stage disable?")) return;
      void command(s, "server", { name: installed.name, config: installed.config, secrets: {}, enabled: false, approved: [] });
    }, { disabled: locked(s) }) : null, button("Stage server removal", () => { if (confirm("Remove server " + installed.name + " from " + s.name + " after apply? Shared credential values are retained, not silently deleted.")) void command(s, "remove-server", { name: installed.name }); }, { disabled: locked(s) })));
  }
  async function discardItem(s: State, kind: "skill" | "server" | "credential", name: string) {
    const data = await command(s, "discard-item", { kind, name }, { stay: true, revision: s.revision });
    if (!data || current !== s) return;
    abandon(s); s.screen = "review"; s.revision = data.revision; draw(s); s.body.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true }); navigate(s);
  }
  function credential(s: State) {
    const data = s.data!, name = s.item;
    const related = [...new Set([...data.servers, ...savedServers(data)].filter((server) => server.credentials.includes(name)).map((server) => server.name))];
    s.body.append(title("Manage credential binding " + name), para("Only the binding name is visible. Replace a value in a server's Connection step. New entries stay masked and require a new test before enabling tools.", ""),
      para("Removing a binding from a connection does not delete its private value. A credential used by another server cannot be removed."),
      related.length ? group(...related.map((server) => button("Edit server " + server, () => go(s, "server", server)))) : para("No connection currently refers to this binding. To replace or use it, add a named credential binding on a server. To undo a pending addition or removal, choose Discard this change in Review changes."),
      group(button("Add MCP server", () => go(s, "server")), button("Stage removal of " + name, () => { if (confirm("Remove unused credential " + name + " from " + s.name + " after apply?")) void command(s, "remove-credential", { name }); }, { disabled: locked(s) || !data.credentials.includes(name) || data.servers.some((server) => server.credentials.includes(name)) })));
  }
  function reviewItems(s: State) {
    const data = s.data!;
    const names = (before: readonly { name: string }[], after: readonly { name: string }[]) => [...new Set([...before, ...after].map((item) => item.name))].sort();
    const state = (item: { enabled: boolean } | undefined) => !item ? "Not installed" : item.enabled ? "Enabled" : "Disabled";
    const controls = (kind: "skill" | "server" | "credential", name: string, changed: boolean) => group(
      button("Edit", () => go(s, kind, name), { "aria-label": "Edit " + kind + " " + name, disabled: locked(s) }),
      data.pending && changed ? button("Discard this change", () => { void discardItem(s, kind, name); }, { "aria-label": "Discard " + kind + " change " + name, disabled: locked(s) }) : null);
    const skillNames = names(savedSkills(data), data.skills), serverNames = names(savedServers(data), data.servers);
    const skills = el("section", { class: "cap-fields", "aria-label": "Review skills" }, el("h3", { text: "Skills" }));
    for (const name of skillNames) {
      const before = savedSkills(data).find((item) => item.name === name), after = data.skills.find((item) => item.name === name), active = data.activeSkills.find((item) => item.name === name);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      skills.append(el("article", { class: "cap-review-item", "data-review-kind": "skill", "data-review-name": name }, el("h4", { text: name }),
        para("Active now: " + (data.activeRevision ? state(active) : "Not loaded") + ". Saved installation is separate from loaded instructions."),
        para("Saved on disk: " + state(before) + " → After apply: " + (!after ? "Removed" : state(after)), ""),
        el("div", { class: "cap-comparison" }, el("div", {}, para("Saved on disk · " + (before?.provenance?.version || "no recorded CLI version")), before ? filesPreview(before.files, before.provenance?.files) : para("No saved bundle")),
          el("div", {}, para("After apply · " + (after?.provenance?.version || "no recorded CLI version")), after ? filesPreview(after.files, after.provenance?.files) : para("Bundle removed"))), controls("skill", name, changed)));
    }
    if (!skillNames.length) skills.append(para("No skills before or after apply."));
    const servers = el("section", { class: "cap-fields", "aria-label": "Review servers and tool access" }, el("h3", { text: "Servers and tool access" }));
    for (const name of serverNames) {
      const before = savedServers(data).find((item) => item.name === name), after = data.servers.find((item) => item.name === name), active = data.activeServers.find((item) => item.name === name);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const tools = el("div", { class: "cap-fields" }, el("strong", { text: "Exact approved-tool fingerprint changes" }));
      const toolNames = names(before?.approved || [], after?.approved || []);
      for (const toolName of toolNames) {
        const oldHash = before?.approved.find((tool) => tool.name === toolName)?.hash, newHash = after?.approved.find((tool) => tool.name === toolName)?.hash;
        const change = oldHash === newHash ? "Unchanged" : !oldHash ? "Added" : !newHash ? "Removed" : "Replaced";
        tools.append(el("div", {}, para(toolName + " · " + change), el("pre", { text: "Saved hash: " + (oldHash || "none") + "\nAfter apply hash: " + (newHash || "none") + "\nRuntime-active hash: " + (active?.approved.find((tool) => tool.name === toolName)?.hash || "none") })));
      }
      if (!toolNames.length) tools.append(para("No approved tools before or after apply."));
      servers.append(el("article", { class: "cap-review-item", "data-review-kind": "server", "data-review-name": name }, el("h4", { text: name }),
        para("Active now: " + (data.activeRevision ? state(active) : "Not loaded") + ". A saved server is not necessarily connected or active."),
        para("Saved on disk: " + state(before) + " → After apply: " + (!after ? "Removed" : state(after)), ""),
        el("div", { class: "cap-comparison" }, el("div", {}, para("Saved connection"), before ? el("pre", { text: JSON.stringify(before.config, null, 2) }) : para("No saved server")), el("div", {}, para("After apply connection"), after ? el("pre", { text: JSON.stringify(after.config, null, 2) }) : para("Server removed"))),
        para("Runtime configured tool exposure: " + (active?.enabled ? "enabled" : "none") + ". Saved contract: " + (before?.enabled ? "enabled" : "disabled or absent") + " → After apply: " + (after?.enabled ? "enabled for only the reviewed fingerprints below" : "none")), health(s, name), tools, controls("server", name, changed)));
    }
    if (!serverNames.length) servers.append(para("No servers before or after apply."));
    const credentials = el("section", { class: "cap-fields", "aria-label": "Review credential changes" }, el("h3", { text: "Credentials · names and operations only" }));
    for (const item of data.credentialChanges) {
      const label = item.change === "added" ? "Added" : item.change === "replaced" ? "Replaced" : "Removed";
      credentials.append(el("article", { class: "cap-review-item", "data-review-kind": "credential", "data-review-name": item.name }, el("h4", { text: item.name + " · " + label }),
        para(item.change === "added" ? "Not configured → Configured" : item.change === "removed" ? "Configured → Removed" : "Configured → Replaced with a new private value"), controls("credential", item.name, true)));
    }
    if (!data.credentialChanges.length) credentials.append(para("No credential values added, replaced or removed."));
    credentials.append(para("Configured binding names after apply: " + (data.credentials.join(", ") || "none") + ". Values are never returned to the browser."));
    return el("div", { class: "cap-fields" }, skills, servers, credentials);
  }
  function review(s: State) {
    const data = s.data!;
    s.revision = data.revision;
    s.body.append(title("Review capability changes"), para("This configuration belongs to " + s.name + "'s folder, shared across environments. Other environments, including production, read it on their next open.", "note"),
      para("Review saved on-disk configuration → After apply, with runtime Active now shown separately. Saved installation does not mean a stopped agent has loaded it. The model never approves a tool or credential change."),
      para("Active revision: " + (data.activeRevision || "none") + " → Reviewed after-apply revision: " + data.revision), reviewItems(s),
      para("Applying can run each enabled local program again, or contact each remote destination with its configured bindings. Local programs run unsandboxed. Approved reads can disclose task content or incur costs outside TaskFast limits. Disabled or removed skills cannot erase loaded conversation history.", "note"),
      para("Apply waits for this agent's current run without interrupting marketplace writes. Only this agent reopens. Conversation, admitted events, action ledger and spending records are retained."));
    let consent = false;
    const apply = button("Apply when idle", () => {
      if (!consent || locked(s)) return;
      const requestId = s.requestId && data.apply.state === "idle" ? s.requestId : crypto.randomUUID(); s.requestId = requestId;
      void command(s, "apply", { requestId }, { stay: true, revision: data.revision });
    }, { class: "primary", disabled: true });
    s.body.append(check("I reviewed this revision and consent to the enabled connections running again on reopen.", false, (value) => { consent = value; disable(apply, !value || !data.pending || locked(s)); }), group(apply, button("Back to edit pending items", () => go(s, "overview"))));
  }
  function draw(s: State) {
    s.body.setAttribute("class", s.screen === "overview" ? "cap-fields" : "cap-detail");
    s.body.replaceChildren(); message(s); pending(s);
    if (!s.data) { s.body.append(title(s.error ? "Capabilities unavailable" : "Loading capabilities…"), button("Retry loading capabilities", () => { s.error = ""; void load(s, true); })); return; }
    if (s.screen !== "overview") s.body.append(button("Back to capabilities", () => go(s, "overview")));
    const skillExists = [...s.data.skills, ...savedSkills(s.data)].some((item) => item.name === s.item);
    const serverExists = [...s.data.servers, ...savedServers(s.data)].some((item) => item.name === s.item);
    const credentialExists = s.data.credentials.includes(s.item) || s.data.credentialChanges.some((item) => item.name === s.item);
    if ((s.screen === "skill" && !skillExists) || (s.screen === "import" && s.item && !skillExists) || (s.screen === "server" && s.item && !serverExists) || (s.screen === "credential" && !credentialExists)) {
      s.body.append(title("Destination unavailable"), para("This selected capability no longer exists in the current configuration. Back to capabilities to choose an available item."));
      return;
    }
    if (s.screen === "server" && !s.item && s.step > 0 && !s.editor) {
      s.body.append(title("Destination unavailable"), para("This setup step needed an unsaved connection. Links do not contain form fields or credentials. Start a new connection to enter them again."), button("Start new connection", () => go(s, "server")));
      return;
    }
    switch (s.screen) {
      case "overview": overview(s); break;
      case "skill": skill(s); break;
      case "import": importer(s); break;
      case "server": server(s); break;
      case "review": review(s); break;
      case "taskfast": taskfastPreview(s); break;
      case "credential": credential(s); break;
    }
  }
  function mount(id: string, name: string, destination?: CapabilityRoute) {
    let s = states.get(id);
    if (!s) {
      const body = el("div", { class: "cap-fields" }), feedback = el("div", {}), bar = el("section", { class: "cap-pending", "aria-label": "Pending capability changes", hidden: true });
      const root = el("div", { id: "capabilities-root", class: "page cap-page", "data-agent": id }, el("div", { class: "cap-identity" }, el("h1", { tabindex: "-1", text: "Capabilities · " + name }), para("Agent folder: agents/" + id + "/", "mono"), para("Manage this agent only. Configuration is shared across environments; staging edits are not staging-only.")), feedback, body, bar);
      s = { id, name, root, body, feedback, pending: bar, data: null, screen: "overview", item: "", step: 0, dirty: false, busy: false, loading: false, revision: "", editor: null, upload: null, preview: null, epoch: 0, scroll: 0, origin: "", error: "", notice: "", filter: "", requestId: null, readVersion: 0 };
      states.set(id, s);
    }
    if (current !== s) {
      if (destination) show(s, destination);
      current = s; draw(s);
    }
    void load(s); return s.root;
  }
  addEventListener("beforeunload", (event) => { if (current?.dirty) { event.preventDefault(); event.returnValue = true; } });
  return { mount, leave, clear: () => { for (const state of states.values()) abandon(state); states.clear(); current = null; }, poll: () => current ? load(current) : Promise.resolve(), selected: () => current?.id };
}
