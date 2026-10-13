// The console's single page. Kept as a module because the TypeScript build copies no
// HTML. Everything from the server or the marketplace is set as text, never as markup.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent console</title>
<style>
:root { --ground: #F3F4F2; --card: #FFFFFF; --ink: #17181A; --soft: #3B3F45; --muted: #5A5F66; --line: #DCDED9; --accent: #1F5FBF; --warn: #8A4205; --warn-bg: #FBEEE3; --bad: #B3261E; --ok: #1D6B34; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
a { color: var(--accent); }
button, input, select, textarea { font: inherit; }
button { min-height: 44px; padding: 0 16px; border-radius: 6px; border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #FFF; font-weight: 600; }
button.chip { min-height: 32px; padding: 0 10px; border-radius: 999px; border-color: #C9CCC6; font-size: 13px; }
input, select, textarea { padding: 10px; border: 1px solid #C9CCC6; border-radius: 6px; min-height: 44px; background: #FFF; color: var(--ink); width: 100%; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--soft); }
.banner { font-size: 13px; font-weight: 600; letter-spacing: .04em; padding: 6px 24px; }
.banner.local { background: #2E5E8C; color: #FFF; } .banner.staging { background: #F2C14E; color: #2B2000; } .banner.prod { background: var(--bad); color: #FFF; }
header { background: var(--ink); color: var(--ground); }
header .row, .page { max-width: 1280px; margin: 0 auto; padding: 10px 24px; display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; }
header select { background: #24262A; color: var(--ground); border-color: #4A4E55; width: auto; }
header button { background: transparent; color: var(--ground); border-color: #4A4E55; }
header button[aria-pressed="true"].freeze { background: var(--bad); border-color: var(--bad); }
nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; border-radius: 6px; color: var(--ground); text-decoration: none; }
nav a[aria-current="page"] { background: var(--ground); color: var(--ink); font-weight: 600; }
.status { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: #2E3A2F; color: #BFE3C2; }
.status.paused { background: #4A3A12; color: #F7DE9C; }
.spacer { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.frozen { background: #FBE4E1; color: #6E1A13; padding: 10px 24px; font-size: 14px; }
.page { padding: 24px; align-items: flex-start; gap: 24px; }
main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
aside { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.card h2 { margin: 0; font-size: 15px; }
.attention { border: 2px solid #B8620A; }
.note { padding: 12px 16px; border-radius: 10px; background: #FBF0D2; border: 1px solid #E5CF8F; font-size: 14px; }
.tag { font: 500 12px ui-monospace, monospace; letter-spacing: .04em; padding: 3px 8px; border-radius: 4px; background: #E3E6EA; color: #2E3338; }
.tag.event { background: #FBF0D2; color: #6B4A00; } .tag.operator { background: #DCE7F7; color: #163F80; } .tag.warn { background: var(--warn-bg); color: var(--warn); } .tag.bad { background: #F6DCD9; color: #6E1A13; }
.turn { padding: 0; gap: 0; overflow: hidden; }
.turn > .head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 18px; border-bottom: 1px solid #ECEDEA; background: #FAFAF8; }
.turn > .body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.small { font-size: 13px; color: var(--muted); }
.calls { display: flex; flex-direction: column; gap: 4px; font: 13px ui-monospace, monospace; }
.call { display: flex; flex-wrap: wrap; gap: 12px; padding: 6px 10px; border-radius: 6px; background: #F6F7F5; }
.call.failed, .call.uncertain { background: var(--warn-bg); }
.call .name { flex: 1 1 240px; overflow-wrap: anywhere; }
.badge-fail { padding: 1px 7px; border-radius: 999px; background: #B8620A; color: #FFF; font-size: 12px; margin-left: 6px; }
.task { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border: 1px solid #C9D6EC; border-radius: 8px; background: #F4F7FC; color: var(--ink); text-decoration: none; }
pre { margin: 0; padding: 10px 12px; border-radius: 6px; background: var(--ink); color: #D7DADF; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.check { display: flex; gap: 10px; align-items: flex-start; }
.check .mark { font-weight: 700; min-width: 5em; } .check .mark.ok { color: var(--ok); } .check .mark.bad { color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 640px) { .grid { grid-template-columns: minmax(0, 1fr); } }
form.inline { display: flex; flex-direction: row; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
form.inline label { flex: 1 1 280px; }
.error { color: var(--bad); font-size: 14px; }
.unlock { max-width: 560px; margin: 0 auto; padding: 72px 24px; display: flex; flex-direction: column; gap: 16px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
const app = document.getElementById("app");
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
const fromLink = /^#token=([0-9a-f]{64})$/.exec(location.hash);
if (fromLink) { store.set("token", fromLink[1]); history.replaceState(null, "", location.pathname); }
let token = store.get("token");
const ui = { agent: store.get("agent"), tab: "timeline", open: new Set(), raw: new Set(), draft: "", draftId: null, error: "", specDraft: null };
let list = null, view = null;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { token = null; render(); throw new Error("The console token was refused. Paste the link pnpm agents printed."); }
  if (!res.ok) { let message = res.statusText; try { message = (await res.json()).error || message; } catch {} throw new Error(message); }
  return res.status === 204 ? null : res.json();
}
async function act(method, action, body) {
  try { ui.error = ""; await api(method, "/api/agents/" + encodeURIComponent(ui.agent) + "/" + action, body); await refresh(); }
  catch (error) { ui.error = error.message; render(); }
}
async function refresh() {
  if (!token) return render();
  try {
    list = await api("GET", "/api/agents");
    if (!list.agents.some((a) => a.id === ui.agent)) ui.agent = list.agents[0] ? list.agents[0].id : null;
    view = ui.agent ? await api("GET", "/api/agents/" + encodeURIComponent(ui.agent)) : null;
  } catch (error) { ui.error = error.message; }
  render();
}

const ENV = { local: ["local", "DEVELOPMENT · local TaskFast server · no real money"], staging: ["staging", "STAGING · testnet funds"], prod: ["prod", "PRODUCTION · real money · every post and escrow spends USDC"] };
const time = (ms) => ms ? new Date(ms).toLocaleTimeString() : "";
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => "$" + Number(n || 0).toFixed(2);
function taskLink(id) { return list && list.env === "local" ? "http://localhost:4000/tasks/" + encodeURIComponent(id) : null; }
function usdc(wallet) {
  const raw = wallet && wallet.balance && wallet.balance.available_balance;
  if (typeof raw !== "string") return wallet && wallet.error ? "unavailable: " + wallet.error : "unknown";
  try { return (Number(BigInt(raw)) / 1e6).toFixed(2) + " USDC"; } catch { return raw; }
}
function taskSummary(id) {
  const read = view.host && view.host.tasks[id];
  const task = read && (read.task || read);
  if (!task || read.error) return { title: id, summary: read && read.error ? "Could not read: " + read.error : "" };
  const parts = [task.status, task.budget_max ? "budget " + money(task.budget_max) : null, task.bid_count !== undefined ? task.bid_count + " bids" : null, task.assignee_name || task.assigned_agent_name ? "assigned to " + (task.assignee_name || task.assigned_agent_name) : null, task.deadline || task.due_at ? "due " + (task.deadline || task.due_at) : null];
  return { title: task.title || id, summary: parts.filter(Boolean).join(" · ") };
}
function taskCard(ref) {
  const { title, summary } = taskSummary(ref.id);
  const href = taskLink(ref.id);
  const inner = [el("span", { class: "small", text: (ref.via || "").toUpperCase() + (href ? "" : " · " + ref.id) }), el("strong", { text: title }), summary ? el("span", { class: "small", text: summary }) : null];
  return href ? el("a", { class: "task", href, target: "_blank", rel: "noopener noreferrer" }, inner) : el("div", { class: "task" }, inner);
}

function header() {
  const op = view ? view.operator : null;
  const waiting = view ? Object.values(view.events).filter((w) => w.kind === "admitted").length + op.messages.length : 0;
  const [envClass, envText] = ENV[list ? list.env : "local"];
  return [
    el("div", { class: "banner " + envClass, role: "status", text: envText }),
    el("header", {}, el("div", { class: "row" },
      el("span", { class: "mono", text: location.host }),
      el("label", { style: "flex-direction:row;align-items:center;color:inherit" }, "Agent",
        el("select", { onchange: (e) => { ui.agent = e.target.value; store.set("agent", ui.agent); ui.open.clear(); ui.raw.clear(); ui.specDraft = null; refresh(); } },
          (list ? list.agents : []).map((a) => el("option", { value: a.id, selected: a.id === ui.agent, text: a.id + " · " + a.name + " (" + a.role + ")" })))),
      el("nav", { "aria-label": "Console" },
        el("a", { href: "#", "aria-current": ui.tab === "timeline" ? "page" : null, onclick: (e) => { e.preventDefault(); ui.tab = "timeline"; render(); }, text: "Timeline" }),
        el("a", { href: "#", "aria-current": ui.tab === "briefing" ? "page" : null, onclick: (e) => { e.preventDefault(); ui.tab = "briefing"; render(); }, text: "Briefing" })),
      op ? el("span", { class: "status" + (op.paused ? " paused" : ""), text: op.paused ? "paused · " + waiting + " waiting" : "running" }) : null,
      op ? el("div", { class: "spacer" },
        el("button", { class: "freeze", "aria-pressed": String(op.frozen), onclick: () => act("POST", "frozen", { value: !op.frozen }), text: op.frozen ? "Unfreeze spending" : "Freeze spending" }),
        el("button", { "aria-pressed": String(op.paused), onclick: () => act("POST", "paused", { value: !op.paused }), text: op.paused ? "Resume" : "Pause" })) : null)),
    op && op.frozen ? el("div", { class: "frozen", role: "alert" }, el("strong", { text: "Spending is frozen. " }), "post_task and escrow_sign are refused before anything is reserved. Reads and messages continue; an action already reserved finishes.") : null,
  ];
}

function attention() {
  if (!view.attention.length) return null;
  return el("section", { class: "card attention", "aria-labelledby": "attention" },
    el("h2", { id: "attention", text: "Needs your attention · " + view.attention.length }),
    view.attention.map((item) => {
      if (item.kind === "uncertain") return el("div", { class: "card" },
        el("div", {}, el("span", { class: "tag warn", text: "UNCERTAIN" }), " ", el("strong", { class: "mono", text: item.id })),
        el("div", { text: money(item.amount) + " is counted as spent and the agent will not retry it. The command may or may not have reached the server: check the task on TaskFast, then mark it checked." }),
        el("div", {}, el("button", { onclick: () => act("POST", "checked", { id: item.id }), text: "Mark checked" })),
        el("div", { class: "small", text: "Marking it checked only clears this alert. The ledger keeps the action as uncertain, so it can never run twice." }));
      if (item.kind === "abandoned") return el("div", { class: "card" },
        el("div", {}, el("span", { class: "tag bad", text: "ABANDONED" }), " ", el("strong", { text: (item.event && item.event.event) || item.id }), el("span", { class: "small", text: " · " + item.attempts + " attempts failed" })),
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          el("button", { class: "primary", onclick: () => act("POST", "retry", { eventId: item.id }), text: "Run again" }),
          el("button", { "aria-expanded": String(ui.raw.has("a:" + item.id)), onclick: () => { toggle(ui.raw, "a:" + item.id); }, text: "Raw event" })),
        ui.raw.has("a:" + item.id) ? el("pre", { text: JSON.stringify(item.event, null, 2) }) : null,
        el("div", { class: "small", text: "Run again queues one fresh attempt. Writes already made stay blocked from repeating." }));
      return el("div", { class: "card" },
        el("div", {}, el("span", { class: "tag bad", text: "DEAD-LETTERED" }), " ", el("strong", { text: item.reason })),
        el("div", { class: "small", text: "The stream gave up on this event at " + item.at + " and acknowledged it, so the server will not send it again." }),
        el("pre", { text: item.line }),
        el("div", {}, el("button", { onclick: () => act("POST", "checked", { id: item.id }), text: "Mark checked" })));
    }));
}

function toggle(set, key) { if (set.has(key)) set.delete(key); else set.add(key); render(); }
const TAG = { poll: ["POLL", ""], event: ["EVENT", "event"], operator: ["YOU", "operator"], resume: ["RESUME", ""], other: ["INPUT", ""] };
function turnCard(turn, index) {
  const [label, cls] = TAG[turn.kind];
  const key = "t" + index;
  const eventName = turn.event && turn.event.event;
  return el("article", { class: "card turn" },
    el("div", { class: "head" },
      el("span", { class: "tag " + cls, text: label }),
      el("span", { class: "small mono", text: time(turn.at) }),
      el("span", { style: "flex:1 1 300px;font-size:14px;color:var(--soft)", text: turn.kind === "event" ? (eventName || "event") + (turn.event && turn.event.task_id ? " · task " + turn.event.task_id : "") : turn.text }),
      turn.kind === "event" ? el("button", { class: "chip", "aria-expanded": String(ui.raw.has(key)), onclick: () => toggle(ui.raw, key), text: "Raw event" }) : null),
    ui.raw.has(key) ? el("div", { style: "padding:0 18px 12px" }, el("pre", { text: JSON.stringify(turn.event, null, 2) || turn.text }), el("div", { class: "small", text: "Shown as plain text. HTML in marketplace content is never rendered." })) : null,
    el("div", { class: "body" }, turn.replies.length ? turn.replies.map((reply, r) => replyBlock(reply, key + "r" + r)) : el("div", { class: "small", text: "No reply yet." })));
}
function replyBlock(reply, key) {
  const failed = reply.calls.filter((c) => c.outcome === "failed").length;
  const uncertain = reply.calls.filter((c) => c.outcome === "uncertain").length;
  return el("div", { style: "display:flex;flex-direction:column;gap:8px" },
    el("div", { style: "display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start" },
      reply.text ? el("p", { style: "flex:1 1 360px;margin:0" }, el("strong", { text: (view.spec.character.name || "Agent") + " — " }), reply.text) : el("span", { style: "flex:1 1 360px", class: "small", text: reply.calls.length ? "(tool calls only)" : "(empty reply: the model returned no text, possibly an error)" }),
      reply.calls.length ? el("button", { class: "chip", "aria-expanded": String(ui.open.has(key)), onclick: () => toggle(ui.open, key) },
        reply.calls.length + (reply.calls.length === 1 ? " tool call" : " tool calls"),
        failed ? el("span", { class: "badge-fail", text: failed + " failed" }) : null,
        uncertain ? el("span", { class: "badge-fail", text: uncertain + " uncertain" }) : null) : null),
    ui.open.has(key) ? el("div", { class: "calls" }, reply.calls.map((call) => el("div", { class: "call " + call.outcome },
      el("span", { class: "name", text: call.name + " " + JSON.stringify(call.arguments) }),
      el("span", { style: "color:" + (call.outcome === "ok" ? "var(--ok)" : "var(--warn)"), text: call.outcome }),
      call.error ? el("div", { style: "flex-basis:100%;white-space:pre-wrap;color:var(--soft)", text: call.error }) : null))) : null,
    reply.tasks.map(taskCard));
}

function readiness() {
  const host = view.host || {};
  const limits = view.spec.limits || {};
  const checks = [
    ["Wallet balance", usdc(host.wallet), /^0\\.00 |unavailable|unknown/.test(usdc(host.wallet)) ? false : true],
    ["Wallet unlock file", host.unlockFile ? "present" : "missing · create .taskfast/wallet-password (mode 0400) in the agent folder", !!host.unlockFile],
    ["Event stream", host.stream || "unknown", host.stream === "connected"],
    ["Model", view.spec.model + (view.timeline.length ? " · last turn " + time(view.timeline[view.timeline.length - 1].at) : " · no turns yet"), true],
    ["Spending limits", limits.perJobUsd !== undefined || limits.dailyUsd !== undefined ? [limits.perJobUsd !== undefined ? money(limits.perJobUsd) + " per job" : null, limits.dailyUsd !== undefined ? money(limits.dailyUsd) + " per day" : null].filter(Boolean).join(" · ") : "none: nothing caps commitments", limits.perJobUsd !== undefined || limits.dailyUsd !== undefined],
  ];
  const problems = checks.filter((c) => !c[2]).length;
  return el("section", { class: "card" },
    el("h2", {}, "Ready to work? ", el("span", { style: "color:" + (problems ? "var(--warn)" : "var(--ok)"), text: problems ? problems + (problems === 1 ? " problem" : " problems") : "yes" })),
    checks.map(([label, detail, ok]) => el("div", { class: "check" },
      el("span", { class: "mark " + (ok ? "ok" : "bad"), text: ok ? "OK" : "Problem" }),
      el("div", {}, el("div", { style: "font-weight:500", text: label }), el("div", { class: "small", text: detail })))));
}
function tasksPanel() {
  const groups = { POSTED: new Map(), BIDDING: new Map(), "WORKING ON": new Map() };
  const via = { post_task: "POSTED", bid_accept: "POSTED", bid_reject: "POSTED", escrow_sign: "POSTED", bid_create: "BIDDING", task_claim: "WORKING ON", task_submit: "WORKING ON" };
  for (const turn of view.timeline) for (const reply of turn.replies) for (const ref of reply.tasks) if (via[ref.via]) groups[via[ref.via]].set(ref.id, { ...ref, via: via[ref.via] });
  return el("section", { class: "card" }, el("h2", { text: "Tasks" }),
    Object.entries(groups).map(([name, refs]) => el("div", { style: "display:flex;flex-direction:column;gap:6px" },
      el("div", { class: "small", style: "font-weight:600", text: name + " · " + refs.size }),
      [...refs.values()].map((ref) => taskCard({ id: ref.id, via: "" })))));
}
function spendPanel() {
  const spent = view.spend[today()] || 0;
  const limit = view.spec.limits && view.spec.limits.dailyUsd;
  const uncertain = Object.values(view.actions).filter((a) => a.status === "uncertain" && a.day === today()).reduce((sum, a) => sum + a.amount, 0);
  return el("section", { class: "card" }, el("h2", { text: "Spend today (UTC)" }),
    el("div", { style: "font-size:26px;font-weight:600" }, money(spent), limit !== undefined ? el("span", { class: "small", text: " of " + money(limit) }) : null),
    uncertain ? el("div", { class: "small", text: "Includes " + money(uncertain) + " uncertain" }) : null);
}

function timelineTab() {
  const op = view.operator;
  const waiting = Object.values(view.events).filter((w) => w.kind === "admitted").length + op.messages.length;
  return el("div", { class: "page" },
    el("main", {},
      op.paused ? el("div", { class: "note", role: "status" }, el("strong", { text: "Paused. " }), "New events are still received and stored, so nothing is lost. " + waiting + " waiting; they run in order when you resume. Check-ins are skipped while paused.") : null,
      attention(),
      el("h1", { style: "margin:8px 0 0;font-size:22px", text: "Timeline" }),
      view.timeline.length ? view.timeline.map(turnCard) : el("div", { class: "small", text: "No turns yet." }),
      el("form", { class: "card inline", onsubmit: (e) => {
        e.preventDefault();
        const text = ui.draft.trim();
        if (!text) return;
        ui.draftId = ui.draftId || crypto.randomUUID();
        act("POST", "messages", { requestId: ui.draftId, text }).then(() => { if (!ui.error) { ui.draft = ""; ui.draftId = null; render(); } });
      } },
        el("label", {}, "Message " + (view.spec.character.name || "the agent"),
          el("textarea", { rows: 2, oninput: (e) => { ui.draft = e.target.value; ui.draftId = null; }, text: ui.draft })),
        el("button", { type: "submit", class: "primary", text: "Send" })),
      el("div", { class: "small", text: "Each send carries its own ID, so a double click or a retry queues it only once." })),
    el("aside", {}, readiness(), tasksPanel(), spendPanel(),
      el("section", { class: "card" }, el("h2", { text: "Standing orders · " + op.orders.length }),
        op.orders.map((order) => el("div", { text: order })),
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); ui.tab = "briefing"; render(); }, text: "Edit in Briefing" }))));
}

function briefingTab() {
  const op = view.operator;
  const draft = ui.specDraft || (ui.specDraft = JSON.parse(JSON.stringify(view.spec)));
  const set = (path, value) => { let at = draft; for (const key of path.slice(0, -1)) at = at[key] = at[key] || {}; at[path[path.length - 1]] = value; render(); };
  const number = (value) => value === "" ? undefined : Number(value);
  const limitChanges = ["perJobUsd", "dailyUsd"].filter((k) => (view.spec.limits || {})[k] !== (draft.limits || {})[k]);
  let orderText = "";
  return el("div", { class: "page" },
    el("main", {},
      el("section", { class: "card" },
        el("h2", {}, "Standing orders ", el("span", { class: "small", text: "· live from the next turn · the agent cannot remove these" })),
        el("ol", { style: "margin:0;padding-left:22px;display:flex;flex-direction:column;gap:8px" },
          op.orders.map((order, index) => el("li", {}, el("div", { style: "display:flex;gap:12px;align-items:center;justify-content:space-between" }, el("span", { text: order }),
            el("button", { "aria-label": "Remove order " + (index + 1), onclick: () => act("DELETE", "orders/" + index), text: "Remove" }))))),
        el("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); if (orderText.trim()) act("POST", "orders", { text: orderText.trim() }); } },
          el("label", {}, "New order", el("input", { type: "text", oninput: (e) => { orderText = e.target.value; } })),
          el("button", { type: "submit", class: "primary", text: "Add" })),
        el("div", { class: "small", text: "The agent's own notes: " + (view.notes.length ? view.notes.join(" · ") : "none yet.") })),
      el("section", { class: "card" },
        el("h2", {}, "agent.json ", el("span", { class: "small", text: "· saving reopens only this agent; the others keep running" })),
        el("label", {}, "Goals", el("textarea", { rows: 2, onchange: (e) => set(["character", "goals"], e.target.value), text: draft.character.goals })),
        el("div", { class: "grid" },
          el("label", {}, "Temperament", el("select", { onchange: (e) => set(["dials", "temperament"], e.target.value) },
            ["patient", "brisk", "exacting", "easygoing", "curt"].map((t) => el("option", { value: t, selected: draft.dials.temperament === t, text: t })))),
          el("label", {}, "Per job limit ($)", el("input", { type: "number", min: 0, step: "0.01", value: (draft.limits || {}).perJobUsd ?? "", onchange: (e) => set(["limits", "perJobUsd"], number(e.target.value)) })),
          el("label", {}, "Daily limit ($)", el("input", { type: "number", min: 0, step: "0.01", value: (draft.limits || {}).dailyUsd ?? "", onchange: (e) => set(["limits", "dailyUsd"], number(e.target.value)) })),
          ["competence", "diligence", "priceSensitivity"].map((dial) => el("label", {}, dial + " " + draft.dials[dial],
            el("input", { type: "range", min: 0, max: 1, step: "0.1", value: draft.dials[dial], onchange: (e) => set(["dials", dial], Number(e.target.value)) })))),
        limitChanges.length ? el("div", { class: "note", role: "group" }, el("strong", { text: "Confirm spending change" }),
          limitChanges.map((k) => el("div", { class: "mono", text: (k === "dailyUsd" ? "Daily limit " : "Per job limit ") + money((view.spec.limits || {})[k]) + " → " + money((draft.limits || {})[k]) })),
          el("div", { class: "small", text: "Takes effect when the agent reopens. Spending already counted today still counts." })) : null,
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          el("button", { class: "primary", onclick: () => { if (draft.limits && Object.values(draft.limits).every((v) => v === undefined)) delete draft.limits; act("PUT", "spec", draft).then(() => { if (!ui.error) ui.specDraft = null; }); }, text: limitChanges.length ? "Confirm, save & reopen" : "Save & reopen" }),
          el("button", { onclick: () => { ui.specDraft = null; render(); }, text: "Discard" })),
        el("div", { class: "small", text: "Checked against the strict agent schema first; nothing is written if it fails." }))),
    el("aside", {}, el("section", { class: "card" }, el("h2", { text: "What the agent reads every turn" }), el("pre", { text: view.prompt }))));
}

function unlock() {
  let value = "";
  return el("div", { class: "unlock" },
    el("h1", { style: "margin:0", text: "Unlock the console" }),
    el("p", { style: "margin:0", text: "When pnpm agents --console starts, it prints a console link with a one-time token. Open that link, or paste the token here." }),
    el("form", { style: "display:flex;flex-direction:column;gap:12px", onsubmit: (e) => { e.preventDefault(); if (/^[0-9a-f]{64}$/.test(value.trim())) { token = value.trim(); store.set("token", token); refresh(); } else { ui.error = "That is not a console token."; render(); } } },
      el("label", {}, "Console token", el("input", { type: "password", autocomplete: "off", oninput: (e) => { value = e.target.value; } })),
      el("button", { type: "submit", class: "primary", style: "align-self:flex-start", text: "Unlock" })),
    ui.error ? el("div", { class: "error", role: "alert", text: ui.error }) : null,
    el("p", { class: "small", text: "Requests without this token, or from a page not served here, are refused. That stops other websites open in your browser from steering the agent or spending money. A new token is issued each time the host starts." }));
}

function render() {
  const focused = document.activeElement && document.activeElement.tagName;
  if (focused === "INPUT" || focused === "TEXTAREA" || focused === "SELECT") return;
  app.replaceChildren(...(!token ? [unlock()] : !list || !view ? [el("div", { class: "unlock", text: ui.error || "Loading…" })] :
    [...header(), ui.error ? el("div", { class: "page" }, el("div", { class: "error", role: "alert", text: ui.error })) : null, ui.tab === "timeline" ? timelineTab() : briefingTab()].filter(Boolean)));
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;
