// The terminal UI: one console client drawn with OpenTUI. It reads and acts only through
// the host's console API; what to draw comes from screen.ts and what keys do from keys.ts.
import type { KeyEvent } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ConsoleView } from "../console.js";
import { follow } from "../console-live.js";
import { markdown, type Block, type List, type Run } from "../console-markdown.js";
import { actionError, FIELDS, fieldValue, initialUi, messageAttempt, messageBody, press, setField, withdrawnSelection, type Effect, type Field, type MessageAttempt, type MessageMode, type Ui } from "./keys.js";
import { clean, environmentBanner, screen, startupScreen, type Screen } from "./screen.js";
import { roster, sameAgent, startupAllowed, type Listing } from "./link.js";

const TONE = { development: "#1d4ed8", staging: "#b45309", production: "#b91c1c" };
const OUTCOME = { ok: "#22c55e", failed: "#f59e0b", uncertain: "#f59e0b", pending: "#9ca3af" };
const TAG = { POLL: "#9ca3af", EVENT: "#a78bfa", YOU: "#60a5fa", RESUME: "#9ca3af", INPUT: "#9ca3af" };
const MUTED = "#9ca3af";
const ACCENT = "#60a5fa";
const WARN = "#f59e0b";
const BAD = "#ef4444";
const OK = "#22c55e";
const SELECTED = "#1f2937";
const CODE = { fg: "#e9e7dc", bg: "#2a2d31" };
const LABEL: Record<Field, string> = { temperament: "Temperament", perJobUsd: "Per job limit ($)", dailyUsd: "Daily limit ($)", competence: "Competence", diligence: "Diligence", priceSensitivity: "Price sensitivity" };
export const HELP: [string, string][] = [
  ["1 / 2", "Timeline / Briefing"], ["j / k", "next / previous reply, alert, queued message, order or field"], ["g / G", "top / bottom"],
  ["tab", "next panel (Timeline / alerts / queued messages; opens narrow sidebar)"], ["< / >", "previous / next agent"], ["enter", "show tool calls (Briefing: edit the field)"],
  ["r", "raw event"], ["o", "open the task"], ["m", "write a message: Enter follow-up / Ctrl+S steer after this tool round"], ["s", "steer the selected queued follow-up (Tab to focus the queue)"], ["w", "withdraw the selected queued follow-up or steer"], ["p", "pause / resume"],
  ["f", "freeze spending (asks y/n) / unfreeze"], ["c", "mark the alert checked"], ["R", "ready: run an abandoned event again; stopped: retry startup"], ["x", "starting: cancel startup (not a running agent)"],
  ["a", "show alerts (Briefing: add a standing order)"], ["d", "Briefing: delete the standing order"],
  ["ctrl+s", "Timeline composer: steer; Briefing: save and reopen (asks y/n)"], ["esc", "discard the draft, close a line"],
  ["i", "show the sidebar"], ["?", "this help"], ["q", "quit the TUI; the agents keep running"],
];

// A coloured span. @opentui/solid sets only href and style on text nodes, so fg and bg
// must ride in style; as plain props they were silently dropped.
function Span(p: { fg?: string; bg?: string; children?: JSX.Element }) {
  return <span style={{ fg: p.fg, bg: p.bg }}>{p.children}</span>;
}

// A reply's markdown (console-markdown.ts, parsed after clean()) as styled runs. Code wears
// Code Ink on a dark plate; a link also shows its address, because its words can lie.
function Runs(p: { runs: Run[] }) {
  return <>{p.runs.map((run) => {
    let node: JSX.Element = run.code ? <Span {...CODE}>{run.text}</Span> : run.text;
    if (run.em) node = <i>{node}</i>;
    if (run.strong) node = <b>{node}</b>;
    return run.href ? <><a href={run.href}>{node}</a><Span fg={MUTED}>{` (${run.href})`}</Span></> : node;
  })}</>;
}
function Items(p: { list: List; depth: number }) {
  return <For each={p.list.items}>{(item, n) => <>
    <text>{"  ".repeat(p.depth)}<Span fg={MUTED}>{p.list.start === undefined ? "• " : `${p.list.start + n()}. `}</Span><Runs runs={item.runs} /></text>
    {item.list ? <Items list={item.list} depth={p.depth + 1} /> : null}
  </>}</For>;
}
function Blocks(p: { blocks: Block[] }) {
  return <For each={p.blocks}>{(block) => block.kind === "code"
    ? <box backgroundColor={CODE.bg} paddingX={1}><text fg={CODE.fg} wrapMode="char">{block.text}</text></box>
    : block.kind === "list" ? <Items list={block} depth={0} /> : <text><Runs runs={block.runs} /></text>}</For>;
}

// Printable keys by what they type (so shift+r is "R"), the rest by name.
function keyName(e: KeyEvent): string {
  if (e.ctrl) return `ctrl+${e.name}`;
  if (e.name === "return" || e.name === "enter") return "enter";
  if (e.sequence.length === 1 && e.sequence >= "!" && e.sequence <= "~") return e.sequence;
  return e.name;
}
class ApiError extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const time = (ms: number) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");
const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

export interface AppProps { origin: string; token: string; open(url: string): void; quit(): void }
export function App(p: AppProps) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const [list, setList] = createSignal<Listing>();
  const [view, setView] = createSignal<ConsoleView>();
  const [down, setDown] = createSignal<string>();
  const [notice, showNotice] = createSignal("");
  const setNotice = (text: string) => showNotice(clean(text));
  const [ui, setUi] = createSignal<Ui>(initialUi());
  // Retries keep identity AND mode. Scope attempts and in-flight guards to the agent.
  const attempts = new Map<string, MessageAttempt>();
  const pending = new Set<string>();
  const withdrawalAttempts = new Set<string>();
  let stop = () => {};
  // Retry and agent switches fire unawaited connects; each is numbered so a stale one
  // can't assign its follow later or overwrite the newer agent's view.
  let gen = 0;
  let closed = false;
  let polling = false;
  const [selectedId, setSelectedId] = createSignal<string>();
  const [startupBusy, setStartupBusy] = createSignal(new Set<string>());
  const drafts = new Map<string, Pick<Ui, "messageText" | "draft">>();
  onCleanup(() => { closed = true; gen++; stop(); clearInterval(rosterTimer); });

  async function api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(p.origin + path, { method, headers: { authorization: `Bearer ${p.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) throw new Error("the console refused the token. A restarted host prints a new link.");
    if (!res.ok) {
      let reason = res.statusText;
      try { reason = ((await res.json()) as { error?: string }).error ?? reason; } catch {}
      throw new ApiError(res.status, reason);
    }
    return res.status === 204 ? null : res.json();
  }
  const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;
  const agent = () => list()?.agents.find((entry) => entry.id === selectedId());
  const agentId = () => agent()?.id;
  const current = (entry: Pick<NonNullable<ReturnType<typeof agent>>, "id" | "generation"> | undefined, epoch: number) => !closed && gen === epoch && sameAgent(entry, agent());
  const busy = () => startupBusy().has(`${agent()?.id}/${agent()?.generation}`);
  function connect() {
    const g = ++gen;
    stop();
    setView(undefined);
    setDown(undefined);
    setUi({ ...ui(), confirm: undefined, editing: undefined });
    const entry = agent();
    if (entry?.state !== "ready") return;
    const accept = (next: unknown) => { if (current(entry, g)) { setView(next as ConsoleView); setDown(undefined); } };
    const fail = (error: unknown) => { if (current(entry, g)) { setView(undefined); setDown(message(error)); } };
    void api("GET", agentPath(entry.id)).then((next) => {
      if (!current(entry, g)) return;
      accept(next);
      stop = follow(p.origin + agentPath(entry.id) + "/stream", p.token, accept, () => {
        if (current(entry, g)) void api("GET", agentPath(entry.id)).then(accept, fail);
      });
    }, fail);
  }
  // Roster polling never waits for a selected agent's view or stream to open.
  async function pollRoster() {
    if (polling || closed) return;
    polling = true;
    try {
      const listing = roster(await api("GET", "/api/agents"));
      if (closed) return;
      const before = agent();
      const next = listing.agents.find((entry) => entry.id === selectedId()) ?? listing.agents[0];
      if (before && before.id !== next?.id) drafts.set(before.id, { messageText: ui().messageText, draft: ui().draft });
      setList(listing);
      setSelectedId(next?.id);
      const index = Math.max(0, listing.agents.findIndex((entry) => entry.id === next?.id));
      setUi(before?.id !== next?.id ? { ...initialUi(index), ...drafts.get(next?.id ?? "") } : { ...ui(), agent: index });
      if (!sameAgent(before, next) || before?.state !== next?.state) connect();
      if (!next) setDown("the host shows no agents");
      else if (next.state !== "ready") setDown(undefined);
    } catch (error) { if (!closed) setDown(message(error)); }
    finally { polling = false; }
  }
  const rosterTimer = setInterval(() => { void pollRoster(); }, 1000);
  void pollRoster();

  async function run(effect: Effect) {
    if (effect.kind === "notice") return setNotice(effect.text);
    if (effect.kind === "message") return sendMessage(effect.text, effect.mode);
    if (effect.kind === "quit") { stop(); renderer.destroy(); return p.quit(); }
    if (effect.kind === "open") return p.open(effect.url);
    if (effect.kind === "retry") { connect(); return pollRoster(); }
    if (effect.kind === "agent") {
      setSelectedId(list()?.agents[effect.index]?.id);
      setUi({ ...ui(), ...drafts.get(agentId() ?? "") });
      setNotice("");
      return connect();
    }
    if (effect.kind === "startup") {
      const { intent } = effect;
      if (!startupAllowed(intent, agent()) || busy()) return;
      const key = `${intent.id}/${intent.generation}`, epoch = gen;
      setStartupBusy(new Set([...startupBusy(), key]));
      try {
        await api("POST", `${agentPath(intent.id)}/startup/${intent.action}`, { generation: intent.generation });
        if (current(intent, epoch)) setNotice("Startup request accepted. Watching for the new state.");
      } catch (error) { if (current(intent, epoch)) setNotice(message(error)); }
      finally { setStartupBusy(new Set([...startupBusy()].filter((item) => item !== key))); void pollRoster(); }
      return;
    }
    const entry = agent(), epoch = gen;
    const id = entry?.id;
    if (!id || entry?.state !== "ready" || !view()) return setNotice("Not sent: the agent is not ready.");
    const actionKey = `${id}/${effect.method}/${effect.action}`;
    if (pending.has(actionKey)) return;
    pending.add(actionKey);
    const withdrawal = effect.method === "DELETE" && effect.action.startsWith("messages/")
      ? { requestId: decodeURIComponent(effect.action.slice("messages/".length)), before: view()?.queuedMessages ?? [] }
      : undefined;
    if (withdrawal) withdrawalAttempts.add(`${id}/${withdrawal.requestId}`);
    try {
      setNotice("");
      await api(effect.method, `${agentPath(id)}/${effect.action}`, effect.body);
      if (!current(entry, epoch)) return;
      if (withdrawal) {
        // The stream may remove the row before the response, or arrive just after it.
        // Remove it locally on ACK too, so the next selected ID is already visible.
        const current = view();
        const after = (current?.queuedMessages ?? []).filter((row) => row.requestId !== withdrawal.requestId);
        setUi(withdrawnSelection(ui(), withdrawal.requestId, withdrawal.before, after));
        if (current) setView({ ...current, queuedMessages: after });
        setNotice("Message withdrawn.");
      }
      if (effect.action.startsWith("steer/")) setNotice("Message set to Steer.");
      if (effect.action === "spec") {
        setUi({ ...ui(), draft: undefined });
        setNotice("Saved. Only this agent reopened.");
      }
    } catch (error) {
      if (current(entry, epoch)) setNotice(actionError(effect.action, error instanceof ApiError ? error.status : undefined, message(error)));
    } finally { pending.delete(actionKey); }
  }
  async function sendMessage(text: string, mode: MessageMode) {
    const entry = agent(), epoch = gen;
    const id = entry?.id;
    if (!id || entry?.state !== "ready" || !view()) return setNotice("Not queued: the agent is not ready. Your draft is kept.");
    if (!text.trim() || pending.has(`${id}/message`)) return;
    const attempt = messageAttempt(attempts.get(id), text, mode, crypto.randomUUID());
    attempts.set(id, attempt);
    pending.add(`${id}/message`);
    try {
      await api("POST", `${agentPath(id)}/messages`, messageBody(attempt));
      attempts.delete(id);
      // Admission belongs to this agent even if selection changed while awaiting ACK.
      // Keep the Briefing draft, other agents' drafts and any newer message text.
      const saved = drafts.get(id);
      if (saved?.messageText.trim() === attempt.text) drafts.set(id, { ...saved, messageText: "" });
      if (!closed && agentId() === id && ui().messageText.trim() === attempt.text) setUi({ ...ui(), editing: undefined, messageText: "" });
      if (!current(entry, epoch)) return;
      setNotice(attempt.mode === "steer" ? "Steer queued; read after the current tool round, or on resume." : "Follow-up queued; read on the next run, or on resume.");
    } catch (error) { if (current(entry, epoch)) setNotice(message(error)); }
    finally { pending.delete(`${id}/message`); }
  }
  async function sendOrder(text: string) {
    const entry = agent(), epoch = gen;
    const id = entry?.id;
    if (!id || entry?.state !== "ready" || !view() || !text.trim()) return;
    try { await api("POST", `${agentPath(id)}/orders`, { text: text.trim() }); }
    catch (error) { if (current(entry, epoch)) setNotice(message(error)); }
  }
  // Leaves the line after this key event, so its enter isn't also read as a command.
  const done = () => setTimeout(() => setUi({ ...ui(), editing: undefined }), 0);

  useKeyboard((event) => {
    const key = keyName(event);
    const id = agentId();
    if (id) drafts.set(id, { messageText: ui().messageText, draft: ui().draft });
    if (ui().editing) {
      if (ui().editing === "message" && ui().tab === "timeline" && (key === "ctrl+s" || key === "enter")) {
        // Global listeners run before focused renderables. Consume the shortcut so
        // OpenTUI neither swallows Ctrl+S nor inserts its control byte into the draft.
        event.preventDefault();
        const next = press(ui(), key, view(), list()?.agents.length ?? 0, agent(), busy());
        if (next.effect) void run(next.effect);
      } else if (key === "escape") { event.preventDefault(); setUi({ ...ui(), editing: undefined }); }
      return;
    }
    const next = press(ui(), key, view(), list()?.agents.length ?? 0, agent(), busy());
    // A line opened by this key gets the keyboard after it, so the key isn't typed into it.
    if (next.ui.editing) {
      const entry = agent(), epoch = gen;
      setTimeout(() => { if (current(entry, epoch)) setUi(next.ui); }, 0);
    }
    else setUi(next.ui);
    if (next.effect) void run(next.effect);
  });

  const drawn = createMemo(() => { const current = view(); return current && screen(current, dims().width); });
  const narrow = () => drawn()?.narrow ?? false;
  const items = createMemo(() => (drawn()?.turns ?? []).flatMap((turn) => (turn.replies.length ? turn.replies.map((reply) => reply.key) : [`turn${turn.at}`])));
  const selected = () => items()[Math.max(0, Math.min(ui().reply, items().length - 1))];
  let scroll: ScrollBoxRenderable | undefined;
  let sidebarScroll: ScrollBoxRenderable | undefined;
  createEffect(() => { const key = selected(); if (key && scroll) scroll.scrollChildIntoView(key); });
  createEffect(() => {
    const id = ui().queuedRequestId;
    const present = drawn()?.sidebar.queued.some((row) => row.requestId === id);
    if (ui().panel === "queue" && present && sidebarScroll) sidebarScroll.scrollChildIntoView(`queue-${id}`);
  });
  const startup = () => { const entry = agent(); return entry && startupScreen(entry); };
  const banner = () => { const listing = list(); return listing && environmentBanner(listing.env); };
  const draft = () => ui().draft ?? view()?.spec;
  // A stream can confirm removal before DELETE replies, or after its reply is
  // lost. Leave a vanished withdrawal target on a visible, non-destructive panel.
  createEffect(() => {
    const selected = ui().queuedRequestId, current = view();
    if (ui().panel === "queue" && selected && withdrawalAttempts.has(`${agentId()}/${selected}`)
      && current && !current.queuedMessages.some((row) => row.requestId === selected)) {
      setUi({ ...ui(), panel: "timeline", queuedRequestId: undefined });
    }
  });
  const queueSelected = (requestId: string) => ui().panel === "queue" && ui().queuedRequestId === requestId;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={drawn()} fallback={
        <box flexDirection="column" flexGrow={1}>
          <Show when={banner()}>{(b: () => NonNullable<ReturnType<typeof banner>>) => <box flexShrink={0} backgroundColor={TONE[b().tone]} paddingX={1}><text fg="#ffffff"><b>{b().text}</b></text></box>}</Show>
          <box flexDirection="column" border borderColor={down() || agent()?.state === "stopped" ? BAD : MUTED} title={` ${down() ? "Can't reach the console" : startup()?.title ?? "Connecting"} `} padding={1} margin={1}>
            <text><b>{clean(agentId() ?? "Console")}</b>{agent()?.role ? ` (${clean(agent()?.role ?? "")})` : ""}</text>
            <text>{startup()?.detail ?? `Connecting to ${p.origin}…`}</text>
            <Show when={down()}><text fg={BAD}>{clean(down() ?? "")}</text></Show>
            <Show when={!agent()}><text fg={MUTED}>{`Console: ${p.origin}. Is pnpm agents --console still running? A restarted host prints a new link with a new token.`}</text></Show>
            <text>{busy() ? "Sending startup request…" : startup()?.action}</text>
            <text fg={MUTED}>Messages are not queued until this agent is ready.</text>
            <Show when={ui().messageText || ui().draft}><text fg={WARN}>Your unsent draft is kept in memory.</text></Show>
            <text><b>&lt; / &gt;</b> switch agent · <b>?</b> help</text>
            <text><b>r</b> retry · <b>q</b> quit</text>
            <Show when={notice()}><text fg={WARN}>{notice()}</text></Show>
          </box>
          <Show when={ui().help}><box flexDirection="column" paddingX={2}>
            <text>Starting: x cancels startup. Stopped: R retries startup.</text>
            <text>Ready: R retries an abandoned event. Other controls require a ready view.</text>
            <text>&lt; / &gt; switches agents even while this agent waits. ? or esc closes help.</text>
          </box></Show>
        </box>
      }>
        {(s: () => Screen) => (
          <>
            <box height={1} flexShrink={0} backgroundColor={TONE[s().banner.tone]} paddingX={1}><text fg="#ffffff"><b>{s().banner.text}</b></text></box>
            <box height={1} paddingX={1}>
              <text>
                <Span fg={MUTED}>‹ </Span><b>{clean(agent()?.id ?? "")}</b>{` (${clean(agent()?.role ?? "")})`}<Span fg={MUTED}> ›   </Span>
                <Span fg={ui().tab === "timeline" ? ACCENT : MUTED}>{ui().tab === "timeline" ? "[1 Timeline]" : " 1 Timeline "}</Span>
                <Span fg={ui().tab === "briefing" ? ACCENT : MUTED}>{ui().tab === "briefing" ? "[2 Briefing]" : " 2 Briefing "}</Span>
                <Span fg={view()?.operator.paused ? WARN : OK}>{`   ● ${s().state}`}</Span>
                {`   spend ${s().spend.today}${s().spend.limit ? ` of ${s().spend.limit}` : ""}`}<Span fg={MUTED}>{"   ? help"}</Span>
              </text>
            </box>
            <Show when={s().frozen}>
              <box height={1} flexShrink={0} backgroundColor="#7f1d1d" paddingX={1}><text fg="#ffffff"><b>SPENDING FROZEN</b>{"  post_task and escrow_sign are refused before anything is reserved · f unfreezes"}</text></box>
            </Show>
            <Show when={view()?.operator.paused}>
              <box height={1} paddingX={1}><text fg={WARN}>{`Paused: events are still received and stored. ${s().state.replace("paused · ", "")}; steers run before follow-ups on resume (p).`}</text></box>
            </Show>
            <Show when={ui().confirm}>
              {(confirm: () => NonNullable<Ui["confirm"]>) => (
                <box flexDirection="column" flexShrink={0} border borderColor={WARN} title=" Confirm " paddingX={1}>
                  <Show when={confirm().kind === "freeze"} fallback={<text>Save agent.json and reopen only this agent? Saving mid-turn records a write in flight as uncertain.</text>}>
                    <text>Freeze spending? post_task and escrow_sign will be refused before anything is reserved.</text>
                  </Show>
                  <For each={(() => { const c = confirm(); return c.kind === "save" ? c.lines : []; })()}>{(line) => <text fg={WARN}>{`Confirm spending change: ${line}`}</text>}</For>
                  <text><b>y</b> yes · <b>n</b> no</text>
                </box>
              )}
            </Show>
            <Show when={ui().help}>
              <box flexDirection="column" border borderColor={ACCENT} title=" Keys " paddingX={1} flexGrow={1}>
                <For each={HELP}>{([keys, what]) => <text><Span fg={ACCENT}>{keys.padEnd(8)}</Span>{what}</text>}</For>
                <text fg={MUTED}>The mouse toggles tool-call badges and scrolls. ? or esc closes this.</text>
              </box>
            </Show>
            <Show when={!ui().help && ui().tab === "timeline"}>
              <box flexDirection={narrow() ? "column" : "row"} flexGrow={1} minHeight={0}>
                <box flexDirection="column" flexGrow={1} minHeight={5}>
                  <Show when={s().attention.length > 0 && (!narrow() || ui().alerts)}>
                    <box flexDirection="column" flexShrink={0} border borderColor={ui().panel === "attention" ? ACCENT : WARN} title={` Needs attention · ${s().attention.length} `} paddingX={1}>
                      <For each={s().attention}>{(item, at) => (
                        <box flexDirection="column">
                          <text>
                            {at() === Math.min(ui().alert, s().attention.length - 1) ? (ui().panel === "attention" ? "▶ " : "› ") : "  "}
                            <Span fg={item.kind === "uncertain" ? WARN : BAD}>{item.title}</Span><Span fg={MUTED}>{`   ${item.keys}`}</Span>
                          </text>
                          <text fg={MUTED}>{`    ${item.detail}`}</text>
                          <Show when={item.raw && ui().raw.includes(`alert:${item.id}`)}><text fg={MUTED}>{item.raw}</text></Show>
                        </box>
                      )}</For>
                    </box>
                  </Show>
                  <scrollbox ref={(box: ScrollBoxRenderable) => { scroll = box; }} flexGrow={1} border borderColor={ui().panel === "timeline" ? ACCENT : MUTED} title=" Timeline " stickyScroll stickyStart="bottom">
                    <For each={s().turns}>{(turn) => (
                      <box flexDirection="column" paddingX={1} marginBottom={1}>
                        <text><Span fg={TAG[turn.tag]}><b>{turn.tag}</b></Span><Span fg={MUTED}>{`  ${time(turn.at)}  `}</Span>{turn.title}</text>
                        <Show when={turn.raw && ui().raw.includes(`turn:${turn.at}`)}>
                          <box border borderColor={MUTED} title=" raw event · plain text " paddingX={1}><text fg={MUTED}>{turn.raw}</text></box>
                        </Show>
                        <Show when={!turn.replies.length}>
                          <box id={`turn${turn.at}`} backgroundColor={selected() === `turn${turn.at}` ? SELECTED : undefined}><text fg={MUTED}>{`${selected() === `turn${turn.at}` ? "▶ " : "  "}No reply yet.`}</text></box>
                        </Show>
                        <For each={turn.replies}>{(reply) => {
                          const open = () => ui().open.includes(reply.key);
                          const mark = () => (selected() === reply.key ? "▶ " : "  ");
                          // A leading paragraph shares the name's line; the other blocks sit under it.
                          const blocks = markdown(reply.text), lead = blocks[0]?.kind === "p" ? blocks[0] : undefined, rest = lead ? blocks.slice(1) : blocks;
                          return (
                            <box id={reply.key} flexDirection="column" backgroundColor={selected() === reply.key ? SELECTED : undefined}>
                              <text>{mark()}<Span fg={ACCENT}>{`${clean(view()?.id ?? "Agent")} — `}</Span>{lead ? <Runs runs={lead.runs} /> : blocks.length ? "" : reply.calls.length ? "(tool calls only)" : "(empty reply: the model returned no text, possibly an error)"}</text>
                              <Show when={rest.length}>
                                <box flexDirection="column" paddingLeft={4}><Blocks blocks={rest} /></box>
                              </Show>
                              <Show when={reply.badge}>
                                <box onMouseDown={() => setUi({ ...ui(), open: toggle(ui().open, reply.key) })}>
                                  <text fg={/failed|uncertain/.test(reply.badge ?? "") ? WARN : MUTED}>{`    [${open() ? "▾" : "▸"} ${reply.badge}]`}</text>
                                </box>
                              </Show>
                              <Show when={open()}>
                                <For each={reply.calls}>{(call) => (
                                  <text>{"      "}<Span fg={OUTCOME[call.outcome]}>{call.outcome.padEnd(10)}</Span>{`${call.name} ${call.arguments.slice(0, 80)}`}<Span fg={MUTED}>{call.error ? `  ${call.error}` : ""}</Span></text>
                                )}</For>
                              </Show>
                              <For each={reply.tasks}>{(task) => (
                                <text>{"    "}<Span fg={MUTED}>{`${task.via}  `}</Span><b>{task.title}</b><Span fg={MUTED}>{task.summary ? `  ${task.summary}  ` : "  "}</Span>
                                  <Show when={task.link} fallback={<Span fg={MUTED}>{task.id}</Span>}><a href={task.link!}>{task.link}</a></Show>
                                </text>
                              )}</For>
                            </box>
                          );
                        }}</For>
                      </box>
                    )}</For>
                  </scrollbox>
                  <box height={3} flexShrink={0} border borderColor={ui().editing === "message" ? ACCENT : MUTED} title=" Message · Enter follow-up · Ctrl+S steer " paddingX={1}>
                    <Show when={ui().editing === "message"} fallback={<text fg={MUTED}>{`m to write to ${clean(view()?.id ?? "the agent")}; Enter next run / Ctrl+S after tool round`}</text>}>
                      <input focused placeholder="Your message to the agent" value={ui().messageText} onInput={(text: string) => setUi({ ...ui(), messageText: text })} />
                    </Show>
                  </box>
                </box>
                <Show when={!narrow() || ui().sidebar}>
                  <scrollbox ref={(box: ScrollBoxRenderable) => { sidebarScroll = box; }} flexShrink={0} height={narrow() ? "50%" : undefined} width={narrow() ? "100%" : 42} border borderColor={ui().panel === "queue" ? ACCENT : MUTED} title=" Agent " paddingX={1}>
                    <text fg={ui().panel === "queue" ? ACCENT : undefined}><b>{`Queued messages · ${s().sidebar.queued.length}`}</b></text>
                    <text fg={MUTED}>Tab focus · j/k select · w withdraw</text>
                    <For each={s().sidebar.queued} fallback={<text fg={MUTED}>None waiting.</text>}>{(row) => (
                      <box id={`queue-${row.requestId}`} flexDirection="column" backgroundColor={queueSelected(row.requestId) ? SELECTED : undefined}>
                        <text><Span fg={ACCENT}>{`${queueSelected(row.requestId) ? "▶ " : "  "}${row.label}`}</Span><Span fg={MUTED}>{row.mode === "followUp" ? " · s steer · w withdraw" : " · w withdraw"}</Span></text>
                        <text>{row.text}</text>
                      </box>
                    )}</For>
                    <Show when={ui().panel === "queue" && ui().queuedRequestId && !s().sidebar.queued.some((row) => row.requestId === ui().queuedRequestId)}><text fg={MUTED}>Selected message left the queue. j/k selects another.</text></Show>
                    <text> </text>
                    <text><b>Ready to work? </b><Span fg={s().sidebar.readiness.some((check) => !check.ok) ? WARN : OK}>{(() => { const n = s().sidebar.readiness.filter((check) => !check.ok).length; return n ? `${n} problem${n === 1 ? "" : "s"}` : "yes"; })()}</Span></text>
                    <For each={s().sidebar.readiness}>{(check) => <text><Span fg={check.ok ? OK : WARN}>{check.ok ? "✓ " : "✗ "}</Span>{`${check.label}: `}<Span fg={MUTED}>{check.detail}</Span></text>}</For>
                    <text> </text>
                    <text><b>Tasks</b></text>
                    <For each={Object.entries(s().sidebar.tasks)}>{([group, refs]) => (
                      <box flexDirection="column">
                        <text fg={MUTED}>{`${group} · ${refs.length}`}</text>
                        <For each={refs}>{(ref) => <text>{`  ${ref.title}`}</text>}</For>
                      </box>
                    )}</For>
                    <text> </text>
                    <text><b>Spend today (UTC) </b>{`${s().spend.today}${s().spend.limit ? ` of ${s().spend.limit}` : ""}`}</text>
                    <Show when={s().spend.uncertain !== "$0.00"}><text fg={WARN}>{`includes ${s().spend.uncertain} uncertain`}</text></Show>
                    <text> </text>
                    <text><b>{`Standing orders · ${s().sidebar.orders.length}`}</b></text>
                    <For each={s().sidebar.orders}>{(order) => <text fg={MUTED}>{`• ${order}`}</text>}</For>
                  </scrollbox>
                </Show>
              </box>
            </Show>
            <Show when={!ui().help && ui().tab === "briefing"}>
              <box flexDirection={narrow() ? "column" : "row"} flexGrow={1}>
                <box flexDirection="column" flexGrow={1}>
                  <box flexDirection="column" border borderColor={ui().panel === "orders" ? ACCENT : MUTED} title=" Standing orders · a add · d delete " paddingX={1}>
                    <For each={s().sidebar.orders} fallback={<text fg={MUTED}>None yet. The agent reads these on every turn and can't remove them.</text>}>
                      {(order, at) => <text>{`${ui().panel === "orders" && at() === ui().order ? "▶ " : "  "}${at() + 1}. ${order}`}</text>}
                    </For>
                    <Show when={ui().editing === "order"}>
                      <input focused placeholder="New standing order; enter adds it" onSubmit={(text: unknown) => { void sendOrder(String(text)); done(); }} />
                    </Show>
                  </box>
                  <box flexDirection="column" border borderColor={ui().panel === "fields" ? ACCENT : MUTED} title=" agent.json · enter edit · ctrl+s save & reopen · esc discard " paddingX={1}>
                    <For each={[...FIELDS]}>{(field, at) => (
                      <box flexDirection="row" height={1}>
                        <text>{`${ui().panel === "fields" && at() === ui().field ? "▶ " : "  "}${LABEL[field].padEnd(20)}`}</text>
                        <Show when={ui().editing === field} fallback={
                          <text fg={view() && draft() && fieldValue(draft()!, field) !== fieldValue(view()!.spec, field) ? WARN : undefined}>{clean(draft() ? fieldValue(draft()!, field) || "none" : "")}</text>
                        }>
                          <input focused flexGrow={1} value={draft() ? fieldValue(draft()!, field) : ""} onSubmit={(value: unknown) => { const current = view(); if (current) setUi(setField(ui(), current, field, String(value))); done(); }} />
                        </Show>
                      </box>
                    )}</For>
                    <Show when={ui().draft}><text fg={WARN}>Unsaved changes · ctrl+s saves and reopens only this agent · esc discards</text></Show>
                    <text fg={MUTED}>Checked against the strict agent schema first; nothing is written if it fails.</text>
                  </box>
                </box>
                <scrollbox border borderColor={MUTED} title=" What the agent reads every turn " width={narrow() ? "100%" : "45%"} flexGrow={narrow() ? 1 : 0}>
                  <text fg={MUTED}>{clean(view()?.prompt ?? "")}</text>
                </scrollbox>
              </box>
            </Show>
            <box height={1} paddingX={1}>
              <text fg={notice() ? WARN : MUTED}>{notice() || (ui().tab === "briefing"
                ? "tab orders/fields · j/k move · a add · d delete · enter edit · ctrl+s save · esc discard · 1 timeline · ? help · q quit"
                : narrow()
                ? `i sidebar · Tab queue · s steer · w withdraw · a alerts (${s().attention.length}) · m message · p pause · ? help · q quit`
                : "j/k move · enter calls · r raw · o open · m message · Tab queue · s steer · w withdraw · p pause · f freeze · ? help · q quit")}</text>
            </box>
          </>
        )}
      </Show>
    </box>
  );
}
