import { capabilitiesPage, CAPABILITIES_CSS, readCapabilityFolder } from "./console-capabilities-page.js";
import { follow } from "./console-live.js";
import { consoleNavigation } from "./console-navigation.js";
import { markdown } from "./console-markdown.js";
import { foldPolls } from "./console-polling.js";
import { MAX_INSTRUCTIONS, POLL_MINUTES } from "./core/spec.js";

// The page runs the same stream follower and markdown subset as the terminal UI.
export const LIVE = follow.toString();
const MARKDOWN = markdown.toString();
const FOLD_POLLS = foldPolls.toString();

// The console's single page. Kept as a module because the TypeScript build copies no
// HTML. Everything from the server or the marketplace is set as text, never as markup.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent console</title>
<style>
:root { --yellow: #FFCC00; --ground: #F2F2EF; --panel: #FFFFFF; --ink: #0B0B0B; --soft: #3D3D38; --muted: #5E5E56; --hairline: rgba(11,11,11,.72); --agent: #1D4ED8; --cli: #7C3AED; --ok: #1D6B34; --warn: #B45309; --warn-bg: #FDF3E3; --bad: #B3261E; --square: #0B0B0B; --code-bg: #0B0B0B; --code-ink: #E9E7DC; --chrome-line: #4A4E55; --chrome-well: #17191c; --chrome-panel: #1C1C19; --chrome-text: #F2F1EA; --chrome-ok: #56D364; --chrome-bad: #F85149; --primary-bg: #0B0B0B; --primary-ink: #FFF; --band-rule: 1px solid #0B0B0B; --sq-ring: none; --sans: "Segoe UI", Frutiger, "Frutiger Next", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, system-ui, sans-serif; accent-color: var(--agent); }
[data-theme="dark"] { --ground: #131311; --panel: var(--chrome-panel); --ink: var(--chrome-text); --soft: #C9C8BE; --muted: #A3A298; --hairline: rgba(242,241,234,.5); --agent: #7AA8FF; --cli: #B794F6; --ok: var(--chrome-ok); --warn: #D29922; --warn-bg: #3A2E10; --bad: var(--chrome-bad); --square: #000000; --primary-bg: var(--yellow); --primary-ink: #0B0B0B; --band-rule: 3px solid #0B0B0B; --sq-ring: 1px solid rgba(255,255,255,.28); }
* { box-sizing: border-box; }
html { scrollbar-color: var(--muted) var(--ground); }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.45 var(--sans); caret-color: var(--agent); }
::selection { background: var(--yellow); color: #0B0B0B; }
code, pre, .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
.num { font-variant-numeric: tabular-nums; }
a { color: var(--agent); text-underline-offset: 3px; }
button, input, select, textarea { font: inherit; }
:focus-visible { outline: 2px solid var(--agent); outline-offset: 2px; }
button { min-height: 44px; padding: 0 16px; border-radius: 6px; border: 1px solid var(--ink); background: var(--panel); color: var(--ink); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
button.primary { background: var(--primary-bg); border-color: var(--primary-bg); color: var(--primary-ink); font-weight: 600; }
input, select, textarea { padding: 10px; border: 1px solid var(--muted); border-radius: 6px; min-height: 44px; background: var(--panel); color: var(--ink); width: 100%; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--soft); }
.band { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; background: var(--yellow); color: #0B0B0B; border: 1px solid #0B0B0B; border-bottom: var(--band-rule); font-weight: 700; letter-spacing: .01em; padding: 8px 18px; }
.band-title { display: flex; align-items: baseline; gap: 12px; flex: 1; min-width: 0; }
.band-plate { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; height: 44px; background: var(--square); color: #FFF; font-size: 24px; }
.band .msg { font-weight: 500; color: rgba(11,11,11,.72); }
.banner { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; font-weight: 600; letter-spacing: .04em; padding: 6px 24px; }
.banner .host { font-weight: 400; letter-spacing: .02em; opacity: .85; font-size: 12px; }
.banner.local { background: #2E5E8C; color: #FFF; } .banner.staging { background: #F2C14E; color: #2B2000; } .banner.prod { background: var(--bad); color: #FFF; }
header { background: #0B0B0B; color: var(--chrome-text); }
header .row, .page { max-width: 1280px; margin: 0 auto; padding: 10px 24px; display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
.sq.brand-sq { background: var(--yellow); color: #14532D; }
.sq.brand-sq.paused { color: #7F1D1D; }
header .rule { align-self: stretch; width: 1px; background: var(--chrome-line); }
header .switcher { display: inline-flex; align-items: center; gap: 6px; background: var(--chrome-panel); border: 1px solid var(--chrome-line); border-radius: 6px; padding: 4px 6px 4px 4px; }
header .switcher select { background: none; border: none; min-height: 40px; color: var(--chrome-text); width: auto; }
header button { background: transparent; color: var(--chrome-text); border-color: var(--chrome-line); }
header button.theme { padding: 0; width: 44px; justify-content: center; }
nav { display: flex; align-items: center; }
nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; color: var(--chrome-text); text-decoration: none; }
nav a[aria-current="page"] { background: var(--yellow); color: #0B0B0B; font-weight: 700; }
.tufte { display: flex; height: 7px; border: 1px solid var(--hairline); background: var(--panel); }
.tufte-spent { background: var(--ink); }
.tufte-uncertain { background: var(--warn); }
.tufte-scale { display: flex; justify-content: space-between; }
.spark-row { display: flex; gap: 2px; align-items: flex-end; height: 24px; }
.spark { width: 9px; background: var(--hairline); }
.spark.today { background: var(--ink); }
.card.budget { --ink: var(--code-ink); --hairline: var(--chrome-line); --panel: var(--chrome-well); --muted: #A3A298; background: var(--square); border-color: var(--square); color: var(--code-ink); padding: calc(16px * 1.4) calc(18px * 1.4); }
.card.budget.frozen .num { color: var(--bad); }
.card.budget.frozen .tufte-spent { background: var(--bad); }
.card.budget.frozen .spark.today { background: var(--bad); }
.lvtoggle { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; border: 1px solid var(--chrome-line); border-radius: 4px; background: var(--chrome-well); cursor: pointer; font: 700 14px/1 var(--sans); letter-spacing: .04em; color: var(--code-ink); padding: 0 16px; }
.lvtoggle .track { position: relative; flex: none; width: 64px; height: 32px; border-radius: 999px; border: 1px solid var(--chrome-line); background: var(--chrome-well); }
.lvtoggle .knob { display: block; width: 26px; height: 26px; border-radius: 50%; background: var(--chrome-ok); transform: translateX(0); transition: transform .3s cubic-bezier(.16, 1, .3, 1), background .2s; }
.lvtoggle .state-word { flex: 1; text-align: right; color: var(--chrome-ok); }
.lvtoggle.frozen { border-color: var(--bad); }
.lvtoggle.frozen .track { background: #3D0E0C; border-color: var(--bad); }
.lvtoggle.frozen .knob { background: var(--chrome-bad); transform: translateX(32px); }
.lvtoggle.frozen .state-word { color: var(--chrome-bad); }
@media (prefers-reduced-motion: reduce) { .lvtoggle .knob { transition: none; } }
.spacer { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.frozen { background: var(--bad); color: #FFF; padding: 10px 24px; font-size: 14px; }
.page { padding: 24px; align-items: flex-start; gap: 24px; }
main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
aside { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.section { display: flex; flex-direction: column; gap: 12px; }
[hidden] { display: none !important; }
.card { background: var(--panel); border: 1px solid var(--hairline); border-radius: 2px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.card.attn { border-color: var(--warn); }
.attn-head { display: flex; gap: 10px; align-items: center; }
.attn-actions { flex: none; margin-left: auto; display: inline-flex; gap: 8px; }
.attn-actions .sq { border: none; }
.attn-actions .sq.fix { background: var(--warn); }
.attn-actions .sq.fix:hover { background: var(--bad); }
.attn-actions .sq.dismiss:hover { color: var(--warn); }
.note { padding: 12px 16px; border-radius: 2px; background: var(--warn-bg); border: 1px solid var(--warn); color: var(--ink); font-size: 14px; }
.tag { font: 700 11px/1 var(--sans); letter-spacing: .07em; text-transform: uppercase; padding: 5px 8px; border-radius: 2px; background: var(--square); color: #FFF; }
.tag.warn { background: var(--warn); } .tag.bad { background: var(--bad); }
.sq { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none; background: var(--square); color: #FFF; outline: var(--sq-ring); }
.sq svg { width: 16px; height: 16px; }
.sq.agent { background: var(--agent); } .sq.you { background: var(--yellow); color: #0B0B0B; outline: 1px solid rgba(11,11,11,.28); } .sq.cli { background: var(--cli); }
.sq.ok { background: var(--ok); } .sq.warn { background: var(--warn); } .sq.bad { background: var(--bad); }
.turn { padding: 0; gap: 0; overflow: hidden; }
/* Event heads are native buttons: reset the base button chrome so the row keeps its look. */
.turn > .head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; min-height: 0; padding: 12px 18px; border: none; border-bottom: 1px solid var(--hairline); border-radius: 0; background: var(--ground); text-align: left; }
.raw-chev { display: inline-flex; color: var(--muted); }
.head[aria-expanded="true"] .raw-chev { transform: rotate(180deg); }
.turn > .body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.poll-run { border: 1px solid var(--hairline); border-radius: 2px; background: var(--panel); min-width: 0; }
.poll-run > summary, .poll-check > summary { list-style: none; display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 12px 18px; cursor: pointer; scroll-margin-top: var(--under-band); }
.poll-run summary::-webkit-details-marker { display: none; }
.poll-run summary .raw-chev { margin-left: auto; flex: none; }
.poll-run[open] > summary > .raw-chev, .poll-check[open] > summary > .raw-chev { transform: rotate(180deg); }
.poll-heading { min-width: 0; flex: 1; }
.poll-title { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.poll-meta, .poll-scope { display: block; margin-top: 4px; overflow-wrap: anywhere; }
.poll-check { border-top: 1px solid var(--hairline); }
.poll-check > summary { flex-wrap: wrap; background: var(--ground); }
.poll-check > .turn { border: none; border-top: 1px solid var(--hairline); border-radius: 0; }
.call-result { flex-basis: 100%; min-width: 0; }
.band .msg { overflow-wrap: anywhere; }
@media (max-width: 640px) { .band { flex-wrap: wrap; } .poll-run > summary, .poll-check > summary { padding: 12px; } }
.small { font-size: 13px; color: var(--muted); }
.head-msg { flex: 1 1 300px; font-size: 15px; color: var(--ink); }
.reply { display: flex; flex-direction: column; gap: 6px; }
.reply-text { flex: 1 1 320px; margin: 0; line-height: 1.35; display: flex; gap: 10px; align-items: flex-start; }
/* Reply markdown: tight blocks, the model's newlines kept, code on the Sign Black plate. */
.md { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.md p, .md ul, .md ol { margin: 0; }
.md p, .md li { white-space: pre-line; overflow-wrap: anywhere; }
.md ul, .md ol { padding-left: 22px; display: flex; flex-direction: column; gap: 2px; }
.md li::marker { color: var(--muted); }
.md li > ul, .md li > ol { margin-top: 2px; }
.md code { font-size: 13px; padding: 1px 5px; border-radius: 2px; background: var(--code-bg); color: var(--code-ink); }
.md table { border-collapse: collapse; }
.md th, .md td { padding: 3px 10px; border: 1px solid var(--hairline); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.md th { font-weight: 600; background: var(--ground); }
.calls { display: flex; flex-direction: column; gap: 4px; font: 13px ui-monospace, monospace; }
.call { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 6px 10px; border-radius: 2px; background: var(--ground); }
.call.failed, .call.uncertain { background: var(--warn-bg); }
.call .name { flex: 1 1 240px; overflow-wrap: anywhere; }
button.calls-chip { position: relative; min-height: 28px; height: 28px; padding: 0 4px; border: none; background: none; color: var(--cli); font-size: 13px; gap: 6px; }
button.calls-chip::before { content: ""; position: absolute; left: -4px; right: -4px; top: 50%; transform: translateY(-50%); height: 44px; }
.calls-chip .num { color: var(--ink); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
/* Only the newest turn's dots pulse: a historical failure stands still, so an idle page keeps the compositor free. */
.dot.live { animation: dotpulse 1.6s ease-in-out infinite; }
@keyframes dotpulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.68); } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } }
.task { display: flex; flex-direction: column; gap: 2px; position: relative; padding: 6px 36px 6px 10px; border: 1px solid var(--hairline); border-radius: 2px; background: var(--panel); color: var(--ink); text-decoration: none; }
.task .go { position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; }
.monu { font-size: clamp(48px, 6vw, 64px); font-weight: 800; letter-spacing: -.02em; }
pre { margin: 0; padding: 10px 12px; border-radius: 2px; background: var(--code-bg); color: var(--code-ink); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.json { position: relative; }
.json pre { padding-right: 104px; min-height: 52px; }
.copy { position: absolute; top: 6px; right: 6px; padding: 0 10px; gap: 6px; font-size: 12px; background: var(--chrome-panel); color: var(--code-ink); border-color: var(--chrome-line); }
.copy:hover { background: #2A2D31; }
.copy.done { background: var(--ok); border-color: var(--ok); color: #FFF; }
.copy.failed { background: var(--bad); border-color: var(--bad); color: #FFF; }
.check { display: flex; gap: 10px; align-items: center; }
.check .word { font-weight: 700; min-width: 5em; } .check .word.ok { color: var(--ok); } .check .word.warn { color: var(--warn); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 640px) { .grid { grid-template-columns: minmax(0, 1fr); } }
form.inline { display: flex; flex-direction: row; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
form.inline label { flex: 1 1 280px; }
.samples { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.samples-label { font-size: 12px; color: var(--muted); }
.sample { border: 1px dashed var(--muted); border-radius: 999px; background: none; color: var(--soft); padding: 4px 12px; min-height: 30px; font-size: 13px; }
.sample:hover { border-style: solid; color: var(--ink); }
.hint { display: flex; justify-content: flex-end; gap: 14px; font-size: 12px; color: var(--muted); }
kbd { font: 600 11px ui-monospace, monospace; background: var(--ground); border: 1px solid var(--hairline); border-bottom-width: 2px; border-radius: 3px; padding: 1px 5px; color: var(--soft); }
textarea::placeholder { color: var(--muted); }
.queue-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: start; background: var(--ground); border-style: dashed; color: var(--soft); }
.queue-row::before { content: "Queued"; content: "Queued" / ""; grid-column: 1; grid-row: 1; justify-self: end; align-self: center; font-size: 24px; font-weight: 700; line-height: 1; color: var(--muted); opacity: .2; pointer-events: none; }
.queue-mode, .queue-text { grid-column: 1; }
.queue-mode { grid-row: 1; padding-right: 104px; font-size: 13px; font-weight: 700; }
.queue-when { font-weight: 400; color: var(--muted); }
.queue-text { grid-row: 2; }
.queue-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.queue-actions { grid-column: 2; grid-row: 1 / 3; display: flex; flex-direction: column; gap: 8px; }
.queue-actions button { justify-content: center; }
@media (max-width: 640px) { .queue-row { grid-template-columns: minmax(0, 1fr); } .queue-actions { grid-column: 1; grid-row: 3; flex-direction: row; flex-wrap: wrap; } }
.queue-error { grid-column: 1 / -1; }
.queue-error:empty, .queue-notice:empty { display: none; }
button:disabled, button[aria-disabled="true"] { cursor: wait; opacity: .6; }
.startup { overflow-wrap: anywhere; }
.startup-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.startup-feedback:empty { display: none; }
header .switcher, header .spacer { min-width: 0; max-width: 100%; }
header .switcher select { min-width: 0; max-width: 100%; }
.sq.brand-sq.unready { color: #0B0B0B; }
.error { color: var(--bad); font-size: 14px; }
.unlock { max-width: 560px; margin: 0 auto; padding: 72px 24px; display: flex; flex-direction: column; gap: 16px; }
/* The rail: marks beside the turns, sized from --composer-space to end above the pinned composer. --under-band clears the sticky band. */
.railed { --under-band: 56px; display: grid; grid-template-columns: minmax(0, 1fr) 30px; gap: 12px; align-items: start; }
.railed > .turns { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.turn { scroll-margin-top: var(--under-band); }
.rail { position: sticky; top: var(--under-band); height: calc(100vh - var(--under-band) - var(--composer-space, 240px) - 16px); min-height: 120px; display: flex; flex-direction: column; gap: 1px; }
/* The rail passes under the band like content, and rises above it only while a peek is open. */
.rail:hover, .rail:focus-within { z-index: 3; }
.rail-earlier { flex: none; display: flex; flex-direction: column; gap: 2px; padding-bottom: 6px; margin-bottom: 5px; border-bottom: 1px dashed var(--muted); }
.rail-earlier button.tick { flex: 0 0 4px; max-height: none; }
button.tick { position: relative; flex: 1 1 0; min-height: 1px; max-height: 14px; padding: 0; border: none; border-radius: 0; background: none; justify-content: flex-end; align-items: stretch; }
.tick::after { content: ""; width: 12px; background: var(--ink); }
.tick.poll::after { background: var(--muted); opacity: .45; }
.tick.operator::after { width: 24px; background: var(--yellow); outline: 1px solid #0B0B0B; outline-offset: -1px; }
.tick.bad::after, .tick.warn::after { width: 18px; opacity: 1; }
.tick.bad::after { background: var(--bad); } .tick.warn::after { background: var(--warn); }
.tick:hover::after, .tick[aria-current="true"]::after { width: 30px; opacity: 1; }
.tick[aria-current="true"]:not(.operator)::after { background: var(--ink); }
.tick:focus-visible { outline-offset: 0; }
.peek { display: none; position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%); width: max-content; max-width: 320px; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--hairline); color: var(--ink); font-size: 13px; text-align: left; z-index: 4; pointer-events: none; }
.peek-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.tick:hover .peek, .tick:focus-visible .peek { display: flex; }
.card.earlier { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
/* The composer stays on the bottom edge while the timeline scrolls under it. */
form.composer { position: sticky; bottom: 0; z-index: 3; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 10px; align-items: end; }
form.composer > label { grid-column: 1; }
form.composer button.send { grid-column: 2; grid-row: 1; justify-content: center; }
form.composer .samples, form.composer .hint { grid-column: 1 / -1; }
/* A pictogram square (.sq) sized as a control. */
button.jump { display: none; position: absolute; left: 50%; top: -58px; transform: translateX(-50%); width: 44px; height: 44px; padding: 0; border-radius: 0; border-color: var(--square); }
button.jump svg { transform: rotate(90deg); }
body.away button.jump { display: inline-flex; }
@media (max-width: 640px) { .railed { grid-template-columns: minmax(0, 1fr); } .rail { display: none; } form.composer .samples, form.composer .hint { display: none; } }
${CAPABILITIES_CSS}
</style>
<script>try{var t=localStorage.getItem("tf-theme");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;}catch(e){}</script>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
const app = document.getElementById("app");
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, drop: (k) => { try { sessionStorage.removeItem(k); } catch {} } };
const fromLink = /^#token=([0-9a-f]{64})$/.exec(location.hash);
if (fromLink) { store.set("token", fromLink[1]); history.replaceState(history.state, "", location.pathname + (location.search || "")); }
const destinations = (${consoleNavigation.toString()})();
const initialDestination = destinations.read(location.pathname, location.search || "");
let navigationIndex = history.state && Number.isInteger(history.state.consoleNavigation) ? history.state.consoleNavigation : 0;
let revertingNavigation = false;
let navigationUrl = location.pathname + (location.search || "");
history.replaceState({ consoleNavigation: navigationIndex }, "", navigationUrl);
let token = store.get("token");
const ui = { agent: initialDestination.agent || (initialDestination.invalid ? null : store.get("agent")), tab: initialDestination.tab, capability: initialDestination.capability, invalidDestination: initialDestination.invalid, open: new Set(initialDestination.open), raw: new Set(initialDestination.raw), folds: new Set(), checks: new Set(), draft: "", attempt: null, messageError: "", promotions: new Map(), withdrawals: new Map(), notices: new Map(), orderDraft: "", error: "", specDraft: null, reopening: false, focusComposer: true, scrollComposer: false, windowN: 12 };
let revealLinkedPanels = true;
let list = null, view = null;
const drafts = new Map(), startupRequests = new Map();
const selected = () => list && list.agents.find((a) => a.id === ui.agent);
const stateOf = (entry) => entry ? entry.state || "ready" : "missing";
const generationOf = (entry) => entry ? entry.generation || 0 : 0;
const ready = () => stateOf(selected()) === "ready";
const selectionKey = () => token && ready() ? token + " " + ui.agent + " " + generationOf(selected()) : null;
function selectAgent(id) {
  if (id === ui.agent) return;
  if (!navigate({ ...destination(), agent: id, open: [], raw: [], capability: destinations.empty().capability, invalid: false })) {
    const selector = document.querySelector('select[aria-label="Agent"]'); if (selector) selector.value = ui.agent;
  }
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
// Stroke icons drawn as SVG, which document.createElement cannot make. Pictograms in
// squares are solid silhouettes (solid: true), the wayfinding mark material.
function icon(paths, size, solid) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attrs = { width: size || 14, height: size || 14, viewBox: "0 0 24 24", "aria-hidden": "true", ...(solid
    ? { fill: "currentColor", "fill-rule": "evenodd", stroke: "none" }
    : { fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }) };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}
const COPY_ICON = ["M9 9h11v11H9z", "M5 15H4V4h11v1"];
const DONE_ICON = ["M5 12l5 5 9-10"];
// Solid pictograms for the black squares: one silhouette per meaning.
const ICON = {
  check: ["M9.55 15.85 4.2 10.5l1.4-1.4 3.95 3.95L18.4 4.2l1.4 1.4z"],
  exclaim: ["M11 4h2v10h-2zM11 17h2v2h-2z"],
  bell: ["M12 22a2.5 2.5 0 002.45-2h-4.9A2.5 2.5 0 0012 22zM18 15v-4a6 6 0 10-12 0v4l-2 2h16z"],
  clock: ["M12 2a10 10 0 100 20 10 10 0 000-20zM11 6h2v5.3l4.2 2.5-1 1.7-5.2-3.1z"],
  person: ["M12 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zm0 2c-4.2 0-8 2.1-8 5V22h16v-3.5c0-2.9-3.8-5-8-5z"],
  agent: ["M12 1a1 1 0 00-1 1v2.1A7.5 7.5 0 004.5 11.5V17a4 4 0 004 4h7a4 4 0 004-4v-5.5A7.5 7.5 0 0013 4.1V2a1 1 0 00-1-1zM8.5 12h2.2v2.4H8.5zM13.3 12h2.2v2.4h-2.2z"],
  cli: ["M4 3h16a1 1 0 011 1v5a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm1.5 2v2h2V5h-2zM4 13h16a1 1 0 011 1v5a1 1 0 01-1 1H4a1 1 0 01-1-1v-5a1 1 0 011-1zm1.5 2v2h2v-2h-2z"],
  arrow: ["M13 4l8 8-8 8-1.4-1.4L17.2 13H3v-2h14.2l-5.6-5.6z"],
  info: ["M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v2h-2zm0 4h2v6h-2z"],
  flag: ["M5 2h2v20H5V2zm4 1h11l-2.5 4L20 11H9V3z"],
  both: ["M10 4H3v7h2V7.4L9.6 12 5 16.6V14H1v7h7v-2H4.4L9 14.4 13.6 19 11 21h7v-7h-2v2.6L11.4 12 16 7.4V10h2V3h-7v1z"],
  wrench: ["M22 6.5a5.5 5.5 0 01-7.6 5.07L8 18l-2.5 2.5a2.12 2.12 0 01-3-3L5 15l6.43-6.4A5.5 5.5 0 0117.5 1l-3 3 2.5 2.5 3-3c.33.63.5 1.32.5 2z"],
  x: ["M5.7 4.3L4.3 5.7 10.6 12l-6.3 6.3 1.4 1.4L12 13.4l6.3 6.3 1.4-1.4L13.4 12l6.3-6.3-1.4-1.4L12 10.6z"],
};
// Stroke glyphs for plain controls outside pictogram squares.
const GLYPH = {
  sun: ["M12 17a5 5 0 100-10 5 5 0 000 10z", "M12 1v2", "M12 21v2", "M4.2 4.2l1.4 1.4", "M18.4 18.4l1.4 1.4", "M1 12h2", "M21 12h2", "M4.2 19.8l1.4-1.4", "M18.4 5.6l1.4-1.4"],
  moon: ["M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"],
  chevron: ["M6 9l6 6 6-6"],
};
// Built once per name and size, then cloned: render() rebuilds the page on every push.
const picts = {};
const pict = (name, size) => (picts[name + size] ||= icon(ICON[name], size, true)).cloneNode(true);
const band = (title, msg) => el("div", { class: "band" }, el("span", { text: title }), msg === undefined ? null : el("span", { class: "msg", text: msg }));
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Fallback for browsers that refuse the async clipboard here.
  const area = el("textarea", { style: "position:fixed;opacity:0", readonly: true, text });
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  return ok;
}
// Every JSON block the page shows: pretty-printed, as text, with a copy button.
function jsonBlock(key, value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (typeof value === "string") { try { text = JSON.stringify(JSON.parse(value), null, 2); } catch {} }
  const state = ui.copied && ui.copied.key === key ? ui.copied.state : null;
  const label = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return el("div", { class: "json" },
    el("pre", { text }),
    el("button", { class: "copy" + (state ? " " + state : ""), "data-focus": "copy:" + key, type: "button", "aria-label": state ? label : "Copy JSON", onclick: async () => {
      const ok = await copyText(text);
      ui.copied = { key, state: ok ? "done" : "failed" };
      render();
      clearTimeout(ui.copiedTimer);
      ui.copiedTimer = setTimeout(() => { ui.copied = null; render(); }, 1600);
    } }, icon(state === "done" ? DONE_ICON : COPY_ICON), el("span", { text: label })),
    el("span", { class: "sr-only", role: "status", "aria-live": "polite", text: state === "done" ? "JSON copied" : state === "failed" ? "Could not copy JSON" : "" }));
}
async function api(method, path, body, signal) {
  const res = await fetch(path, { method, signal, headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { capabilities.clear(); token = null; store.drop("token"); render(); throw new Error("The console token was refused. Paste the link pnpm agents printed."); }
  if (!res.ok) {
    let message = res.statusText, safeCapability = false;
    try {
      const payload = await res.json();
      if (payload && typeof payload.error === "string" && payload.error.length <= 4096) {
        message = payload.error;
        // This route returns only redacted CapabilityError details or a fixed generic error.
        safeCapability = path.startsWith("/api/agents/") && path.split("/")[4] === "capabilities" && path.split("/").length <= 6 && (res.headers.get("content-type") || "").startsWith("application/json");
      }
    } catch {}
    const error = new Error(message); error.status = res.status; error.safeCapability = safeCapability; throw error;
  }
  return res.status === 204 ? null : res.json();
}
async function act(method, action, body) {
  try { ui.error = ""; await api(method, "/api/agents/" + encodeURIComponent(ui.agent) + "/" + action, body); await refresh(); }
  // A 409 says the operator acted on stale state (the orders changed): show the reason over fresh data.
  catch (error) { ui.error = error.message; if (error.status === 409) await refresh(); else render(); }
}
${LIVE}
${MARKDOWN}
${FOLD_POLLS}
const capabilities = (${capabilitiesPage.toString()})({ el, api, readFolder: ${readCapabilityFolder.toString()}, navigate: (route) => {
  ui.capability = route;
  writeDestination();
} });
function destination() {
  return { agent: ui.agent, tab: ui.tab, open: [...ui.open], raw: [...ui.raw], capability: ui.capability, invalid: ui.invalidDestination };
}
function writeDestination(replace = false) {
  const url = destinations.href(destination());
  if (url === navigationUrl) return;
  if (!replace) navigationIndex++;
  history[replace ? "replaceState" : "pushState"]({ consoleNavigation: navigationIndex }, "", url);
  navigationUrl = url;
}
function briefingDirty() { return !!ui.specDraft && !!view && JSON.stringify(ui.specDraft) !== JSON.stringify(view.spec); }
function navigate(next, traversed = false) {
  const leaving = next.agent !== ui.agent || next.tab !== ui.tab || JSON.stringify(next.capability) !== JSON.stringify(ui.capability) || next.invalid !== ui.invalidDestination;
  if (leaving) {
    if (briefingDirty() && !confirm("Discard unsaved Briefing edits?")) return false;
    if (!capabilities.leave()) return false;
    ui.specDraft = null;
  }
  if (next.agent !== ui.agent) {
    drafts.set(ui.agent, { draft: ui.draft, attempt: ui.attempt, messageError: ui.messageError });
    Object.assign(ui, drafts.get(next.agent) || { draft: "", attempt: null, messageError: "" });
    ui.agent = next.agent;
    if (ui.agent) store.set("agent", ui.agent); else store.drop("agent");
    view = null;
    ui.windowN = 12;
    ui.folds.clear(); ui.checks.clear();
  }
  ui.tab = next.tab; ui.capability = next.capability; ui.invalidDestination = next.invalid;
  ui.open = new Set(next.open); ui.raw = new Set(next.raw); ui.error = "";
  toEnd = false; revealLinkedPanels = true;
  if (!traversed) writeDestination();
  syncSelection(); render(true); void refresh();
  return true;
}
addEventListener("popstate", (event) => {
  if (revertingNavigation) { revertingNavigation = false; return; }
  const index = event.state && Number.isInteger(event.state.consoleNavigation) ? event.state.consoleNavigation : 0;
  const url = location.pathname + (location.search || "");
  const next = destinations.read(location.pathname, location.search || "");
  if (navigate(next, true)) { navigationIndex = index; navigationUrl = url; }
  else if (index !== navigationIndex) { revertingNavigation = true; history.go(navigationIndex - index); }
  else history.replaceState({ consoleNavigation: navigationIndex }, "", navigationUrl);
});
addEventListener("beforeunload", (event) => { if (briefingDirty()) { event.preventDefault(); event.returnValue = true; } });
function selectTab(tab) {
  if (tab === ui.tab && !ui.invalidDestination) return;
  if (!navigate({ ...destination(), tab, capability: destinations.empty().capability, invalid: false })) return;
  document.querySelector(tab === "capabilities" ? "#capabilities-root h1" : 'nav a[aria-current="page"]')?.focus({ preventScroll: true });
}
function followTab(event, tab) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault(); selectTab(tab);
}
// Every link that leaves the console opens a new tab that cannot reach back into this one.
const AWAY = { target: "_blank", rel: "noopener noreferrer" };
// A reply's markdown, built node by node: no markup string from the model reaches the DOM.
function mdRuns(runs) {
  return runs.map((run) => {
    let node = run.code ? el("code", { text: run.text }) : run.text;
    if (run.em) node = el("em", {}, node);
    if (run.strong) node = el("strong", {}, node);
    // Link text can lie, so the full address rides on the title.
    return run.href ? el("a", { href: run.href, title: run.href, ...AWAY }, node) : node;
  });
}
const mdList = (list) => el(list.start === undefined ? "ul" : "ol", { start: list.start !== 1 ? list.start : null }, list.items.map((item) => el("li", {}, mdRuns(item.runs), item.list ? mdList(item.list) : null)));
const mdTable = (t) => el("table", {},
  el("thead", {}, el("tr", {}, t.head.map((runs) => el("th", {}, mdRuns(runs))))),
  el("tbody", {}, t.rows.map((row) => el("tr", {}, row.map((runs) => el("td", {}, mdRuns(runs)))))));
const mdBlock = (block) => block.kind === "code" ? el("pre", { text: block.text })
  : block.kind === "list" ? mdList(block)
  : block.kind === "table" ? mdTable(block)
  : el("p", {}, mdRuns(block.runs));
// The same words with the markers gone, for the rail's peek.
const plain = (node) => node.text !== undefined ? node.text
  : node.head ? [node.head, ...node.rows].flat().map((cell) => cell.map(plain).join("")).join(" ")
  : node.runs ? node.runs.map(plain).join("") + (node.list ? " " + plain(node.list) : "") : node.items.map(plain).join(" ");
// The stream being followed: which agent with which token, whether it is delivering,
// and how to stop it.
let following = { key: null, up: false, stop: () => {} };
let detailRequest = null, rosterRequest = null;
function syncSelection() {
  const key = selectionKey();
  ui.reopening = !!ui.agent && !selected();
  if (key === following.key) return;
  following.stop();
  if (detailRequest) detailRequest.abort();
  detailRequest = null; view = null;
  // Explicit URL references survive startup and generation changes; opaque IDs prevent row drift.
  ui.folds.clear(); ui.checks.clear(); revealLinkedPanels = true;
  ui.windowN = 12; timelineLength = 0; toEnd = !ui.open.size && !ui.raw.size;
  following = { key, up: false, stop: () => {} };
  if (key) following.stop = follow("/api/agents/" + encodeURIComponent(ui.agent) + "/stream", token,
    (next) => { if (selectionKey() !== key || following.key !== key) return; view = next; following.up = true; render(); },
    () => { if (selectionKey() !== key || following.key !== key) return; following.up = false; refreshDetail(); });
}
async function refreshDetail() {
  const key = selectionKey();
  if (!key || following.up || detailRequest) return;
  const controller = new AbortController();
  detailRequest = controller;
  try {
    const next = await api("GET", "/api/agents/" + encodeURIComponent(ui.agent), undefined, controller.signal);
    if (!controller.signal.aborted && selectionKey() === key && following.key === key && !following.up) { view = next; render(); }
  } catch (error) {
    if (!controller.signal.aborted && selectionKey() === key) { ui.error = error.message; render(); }
  } finally { if (detailRequest === controller) detailRequest = null; }
}
// Roster polling never awaits a view or MCP. Even a hung detail request cannot
// hide another agent's startup outcome or keep a cancelled generation on screen.
async function refresh() {
  if (!token || rosterRequest) { render(); return; }
  const auth = token;
  const controller = new AbortController();
  rosterRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const next = await api("GET", "/api/agents", undefined, controller.signal);
    if (token !== auth) return;
    const changed = JSON.stringify(list) !== JSON.stringify(next);
    list = next;
    if (!ui.agent && !ui.invalidDestination) ui.agent = list.agents[0] ? list.agents[0].id : null;
    if (!ui.invalidDestination) writeDestination(true);
    syncSelection();
    if (changed) render();
    void refreshDetail();
  } catch (error) { if (token === auth) { ui.error = controller.signal.aborted ? "Cannot refresh agent status. Retrying…" : error.message; render(); } }
  finally { clearTimeout(timeout); if (rosterRequest === controller) rosterRequest = null; }
}
async function startupAction(action) {
  const entry = selected();
  if (!entry || (action === "retry" ? stateOf(entry) !== "stopped" : stateOf(entry) !== "starting")) return;
  const key = entry.id + "/" + generationOf(entry);
  if (startupRequests.get(key)?.pending) return;
  const state = { pending: true, text: action === "retry" ? "Requesting retry…" : "Requesting cancellation…" };
  startupRequests.set(key, state);
  updateStartupStatus();
  try {
    await api("POST", "/api/agents/" + encodeURIComponent(entry.id) + "/startup/" + action, { generation: generationOf(entry) });
    state.text = action === "retry" ? "Retry accepted. Waiting for startup status." : "Cancellation accepted. Waiting for startup status.";
  } catch (error) { state.text = "Request not confirmed. " + error.message; }
  finally { state.pending = false; updateStartupStatus(); void refresh(); }
}
function updateStartupStatus() {
  const state = startupRequests.get(ui.agent + "/" + generationOf(selected()));
  const feedback = document.querySelector(".startup-feedback"), button = document.querySelector(".startup-action");
  if (feedback) feedback.textContent = state ? state.text : "";
  if (button) button.setAttribute("aria-disabled", String(!!state?.pending));
}
function startupPanel() {
  const entry = selected(), state = stateOf(entry);
  const title = state === "starting" ? "Starting agent" : state === "stopped" ? "Agent stopped" : state === "ready" ? "Loading agent" : ui.agent ? "Agent unavailable" : "No agents found";
  const reason = state === "stopped" ? entry.reason : state === "starting" ? (entry.phase === "waiting-for-close" ? "Waiting for the previous attempt to close before starting." : "Opening the agent and checking its configured capabilities.") : state === "ready" ? "Waiting for this agent's view." : list && ui.agent ? "Destination unavailable. This agent is not in the host's roster. Choose another agent in the selector. The requested URL has been kept." : "Waiting for the host's agent roster. Other agents remain available in the selector.";
  return el("div", { class: "page startup" }, el("main", {},
    band(title),
    el("section", { class: "card", "aria-label": "Agent startup" },
      el("strong", { class: "mono", text: ui.agent ? "agents/" + ui.agent + "/" : "agents/" }),
      el("div", { role: "status", text: reason }),
      el("div", { class: "small", text: "Messages cannot be sent until this agent is ready. Your draft stays in this browser tab; it has not been queued." }),
      el("div", { class: "startup-actions" },
        state === "stopped" || state === "starting" ? el("button", { type: "button", class: "startup-action", "aria-disabled": "false", onclick: () => startupAction(state === "stopped" ? "retry" : "cancel"), text: state === "stopped" ? "Retry startup" : "Cancel startup" }) : null),
      el("div", { class: "small startup-feedback", role: "status", "aria-live": "polite" })),
    ui.tab === "timeline" && ui.agent ? el("form", { class: "card composer", onsubmit: (e) => { e.preventDefault(); } },
      el("label", {}, "Draft for " + ui.agent, el("textarea", { rows: 3, "aria-label": "Message " + ui.agent, "aria-describedby": "startup-draft-note", text: ui.draft, oninput: (e) => { ui.draft = e.target.value; ui.attempt = null; }, onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" || e.key === "Enter" && !e.shiftKey && !e.isComposing) e.preventDefault(); } })),
      el("button", { type: "button", class: "primary send", "aria-disabled": "true", text: "Send" }),
      el("div", { class: "small", id: "startup-draft-note", style: "grid-column:1 / -1", text: "Not sent. Waiting for this agent to be ready." })) : null));
}

const ENV = { local: ["local", "DEVELOPMENT · local TaskFast server · no real money"], staging: ["staging", "STAGING · testnet funds"], prod: ["prod", "PRODUCTION · real money · every post and escrow spends USDC"] };
// Times in the console are relative; absolute values ride on title attributes.
const rel = (ms) => {
  const diff = ms - Date.now(), abs = Math.abs(diff);
  if (abs < 45000) return "just now";
  const unit = abs < 3600000 ? [Math.round(abs / 60000), "m"] : abs < 86400000 ? [Math.round(abs / 3600000), "h"] : abs < 604800000 ? [Math.round(abs / 86400000), "d"] : null;
  if (!unit) return new Date(ms).toLocaleDateString();
  return diff >= 0 ? "in " + unit[0] + unit[1] : unit[0] + unit[1] + " ago";
};
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
  // TaskDetail fields in the CLI's vendored OpenAPI spec.
  const parts = [task.status, task.budget_max ? "budget " + money(task.budget_max) : null, task.worker_agent_id ? "worker assigned" : null,
    task.execution_deadline ? "due " + rel(Date.parse(task.execution_deadline)) : null, !task.worker_agent_id && task.pickup_deadline ? "pickup by " + rel(Date.parse(task.pickup_deadline)) : null];
  return { title: task.title || id, summary: parts.filter(Boolean).join(" · ") };
}
// Action names read as words, not enum codes. VIA holds only the labels the fallback
// cannot reach; the escape is doubled so the browser receives \w, not a plain w.
const VIA = { bid_create: "Bid", bid_accept: "Accept Bid", bid_reject: "Reject Bid", task_claim: "Claim", task_submit: "Submit" };
const viaLabel = (via) => VIA[via] || (via || "").replace(/_/g, " ").replace(/^\\w| \\w/g, (c) => c.toUpperCase());
function taskCard(ref) {
  const { title, summary } = taskSummary(ref.id);
  const href = taskLink(ref.id);
  const inner = [el("span", { class: "small", text: viaLabel(ref.via) + (href ? "" : " · " + ref.id) }), el("strong", { text: title }), summary ? el("span", { class: "small", text: summary }) : null, el("span", { class: "sq go" }, pict("arrow", 13))];
  return href ? el("a", { class: "task", href, ...AWAY }, inner) : el("div", { class: "task" }, inner);
}

function header() {
  const op = ready() && view ? view.operator : null;
  const waiting = op ? Object.values(view.events).filter((w) => w.kind === "admitted").length + op.messages.length : 0;
  const [envClass, envText] = list ? ENV[list.env] : ["", "Environment pending · waiting for host"];
  const dark = document.documentElement.dataset.theme === "dark";
  // The brand robot carries the run state; the role square carries what the agent does.
  const ROLE = { poster: "flag", worker: "wrench", both: "both" };
  const me = list && list.agents.find((a) => a.id === ui.agent);
  const roleGlyph = ROLE[me && me.role] || ROLE.poster;
  const roleTitle = me && me.role ? me.role : "agent role";
  const stateText = !ready() || !view ? (stateOf(me) === "starting" ? "Starting" : stateOf(me) === "stopped" ? "Stopped" : "Waiting for agent") : op.paused ? "Paused · " + waiting + " waiting" : "Running";
  return [
    el("div", { class: "banner " + envClass, role: "status" }, el("span", { text: envText }), el("span", { class: "host", text: location.host })),
    el("header", {}, el("div", { class: "row" },
      el("span", { class: "brand" }, el("span", { class: "sq brand-sq" + (!op ? " unready" : op.paused ? " paused" : ""), title: stateText }, pict("agent", 16)), "Agent console", el("span", { class: "sr-only", role: "status", text: stateText.toLowerCase() })),
      el("nav", { "aria-label": "Console" },
        el("a", { href: destinations.href({ ...destination(), tab: "timeline", capability: destinations.empty().capability }), "aria-current": ui.tab === "timeline" ? "page" : null, onclick: (e) => followTab(e, "timeline"), text: "Timeline" }),
        el("a", { href: destinations.href({ ...destination(), tab: "briefing", capability: destinations.empty().capability }), "aria-current": ui.tab === "briefing" ? "page" : null, onclick: (e) => followTab(e, "briefing"), text: "Briefing" }),
        el("a", { href: destinations.href({ ...destination(), tab: "capabilities", capability: destinations.empty().capability }), "aria-current": ui.tab === "capabilities" ? "page" : null, onclick: (e) => followTab(e, "capabilities"), text: "Capabilities" })),
      el("div", { class: "spacer" },
        el("span", { class: "rule" }),
        el("span", { class: "switcher" },
          el("span", { class: "sq you", title: roleTitle }, pict(roleGlyph, 15)),
          el("select", { "aria-label": "Agent", onchange: (e) => selectAgent(e.target.value) },
            ui.reopening ? [el("option", { value: ui.agent, selected: true, text: ui.agent + " · reopening…" })] : [],
            (list ? list.agents : []).map((a) => el("option", { value: a.id, selected: a.id === ui.agent, text: a.id + (a.role ? " · " + a.role : "") + (stateOf(a) === "ready" ? "" : " · " + stateOf(a)) })))),
        el("button", { class: "theme", "aria-label": dark ? "Switch to the light theme" : "Switch to the dark theme", title: dark ? "Switch to the light theme" : "Switch to the dark theme", onclick: () => {
          const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
          document.documentElement.dataset.theme = next;
          try { localStorage.setItem("tf-theme", next); } catch {}
          render();
        } }, icon(dark ? GLYPH.sun : GLYPH.moon, 18)),
        op ? el("button", { "aria-pressed": String(op.paused), onclick: () => act("POST", "paused", { value: !op.paused }), text: op.paused ? "Resume" : "Pause" }) : null))),
    op && op.frozen ? el("div", { class: "frozen", role: "alert" }, el("strong", { text: "Spending is frozen. " }), "post_task and escrow_sign are refused before anything is reserved. Reads and messages continue; an action already reserved finishes.") : null,
  ];
}

// One ghost help + one ghost close per alert, at the tag row's right end. Help drafts
// a fix-it message into the composer; close clears the alert only (never the ledger).
function draftInto(text) {
  if (ui.draft !== text) ui.attempt = null;
  ui.draft = text;
  ui.messageError = "";
  const textarea = document.querySelector("form.composer textarea");
  if (textarea) textarea.value = text;
  // The operator asked for the composer: its focus scrolls it into view. A rebuild
  // that only restores focus does not scroll (render reads scrollComposer).
  ui.focusComposer = true;
  ui.scrollComposer = true;
  render();
  if (textarea) { textarea.focus(); ui.focusComposer = ui.scrollComposer = false; }
}
function attnActions(id, draftFix) {
  return el("span", { class: "attn-actions" },
    el("button", { class: "sq fix", title: "Drafts a fix-it message into the composer", "aria-label": "Fix this", onclick: draftFix }, pict("wrench", 13)),
    el("button", { class: "sq dismiss", title: "Mark checked", "aria-label": "Mark checked", onclick: () => act("POST", "checked", { id }) }, pict("x", 13)));
}
function attention() {
  if (!view.attention.length) return null;
  return el("section", { class: "section", "aria-labelledby": "attention" },
    el("div", { class: "band", id: "attention" },
      el("span", { class: "band-title" }, el("span", { text: "Needs your attention" }), el("span", { class: "msg", text: "holds until you dismiss it" })),
      el("span", { class: "band-plate num", text: view.attention.length })),
    view.attention.map((item) => {
      if (item.kind === "uncertain") return el("div", { class: "card attn" },
        el("div", { class: "attn-head" }, el("span", { class: "sq warn" }, pict("exclaim", 16)), el("span", { class: "tag warn", text: "UNCERTAIN" }), el("strong", { class: "mono", text: item.id }),
          attnActions(item.id, () => draftInto("The action " + item.id + " is uncertain and counted as spent. Read the current marketplace state, tell me whether it reached the server, and do not repeat the write."))),
        el("div", { text: money(item.amount) + " is counted as spent and the agent will not retry it. The command may or may not have reached the server." }));
      if (item.kind === "abandoned") return el("div", { class: "card attn" },
        el("div", { class: "attn-head" }, el("span", { class: "sq bad" }, pict("exclaim", 16)), el("span", { class: "tag bad", text: "ABANDONED" }), el("strong", { text: (item.event && item.event.event) || item.id }), el("span", { class: "small", text: " · " + item.attempts + " attempts failed" })),
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          el("button", { class: "primary", onclick: () => act("POST", "retry", { eventId: item.id }), text: "Run again" }),
          el("button", { "aria-expanded": String(ui.raw.has("a:" + item.id)), onclick: () => { toggle(ui.raw, "a:" + item.id); }, text: "Raw event" })),
        ui.raw.has("a:" + item.id) ? jsonBlock("a:" + item.id, item.event) : null,
        el("div", { class: "small", text: "Run again queues one fresh attempt. Writes already made stay blocked from repeating." }));
      return el("div", { class: "card attn" },
        el("div", { class: "attn-head" }, el("span", { class: "sq bad" }, pict("exclaim", 16)), el("span", { class: "tag bad", text: "DEAD-LETTERED" }), el("strong", { text: item.reason }),
          attnActions(item.id, () => draftInto("A marketplace event was dead-lettered (" + item.reason + ") and will not be redelivered. Read the current marketplace state and continue from where it stopped."))),
        el("div", { class: "small", text: "The stream gave up on this event " + rel(Date.parse(item.at)) + " and acknowledged it, so the server will not send it again." }),
        jsonBlock("d:" + item.id, item.line));
    }));
}

function toggle(set, key) { if (set.has(key)) set.delete(key); else set.add(key); writeDestination(); render(); }
const turnKey = (turn, index) => turnIdentity(turn, index);
const replyKey = (turn, index, reply, r) => reply.calls.length ? turnKey(turn, index) + ":" + reply.calls[0].id : turnKey(turn, index) + "r" + r;
// References use immutable input and call identities, never their current row number.
function resolvePanels() {
  const open = new Map(), raw = new Map();
  view.timeline.forEach((turn, i) => {
    if (turn.kind === "event") { const key = turnKey(turn, i); raw.set(key, [...raw.get(key) || [], i]); }
    turn.replies.forEach((reply, r) => { if (reply.calls.length) { const key = replyKey(turn, i, reply, r); open.set(key, [...open.get(key) || [], i]); } });
  });
  for (const item of view.attention) if (item.kind === "abandoned") raw.set("a:" + item.id, [-1]);
  let missing = false;
  for (const [keys, available] of [[ui.open, open], [ui.raw, raw]]) for (const key of keys) {
    const matches = available.get(key);
    if (!matches || matches.length !== 1) missing = true;
    else if (matches[0] >= 0) {
      const i = matches[0];
      ui.windowN = Math.max(ui.windowN, view.timeline.length - i);
      if (revealLinkedPanels) {
        const row = foldPolls(view.timeline).find((row) => row.kind === "unchanged" && row.from <= i && i < row.to);
        if (row) { ui.folds.add(turnIdentity(view.timeline[row.from], row.from)); ui.checks.add(turnIdentity(view.timeline[i], i)); }
      }
    }
  }
  revealLinkedPanels = false;
  return missing;
}
function unavailableDestination() {
  return el("section", { class: "card", role: "status", "aria-label": "Destination unavailable" },
    el("h2", { text: "Destination unavailable" }),
    el("p", { text: "This link is invalid, or a requested action is no longer available in the current history. The requested URL has been kept. Choose an agent or page, or open its current timeline." }),
    el("button", { onclick: () => navigate({ ...destination(), tab: "timeline", open: [], raw: [], capability: destinations.empty().capability, invalid: false }), text: "Open current timeline" }));
}
// Turn origins as wayfinding pictograms: black squares, except the operator's own yellow.
const TAG = { poll: ["", "clock", "Automatic check-in"], event: ["", "bell", "Marketplace event"], operator: ["you", "person", "You"], resume: ["", "arrow", "Resumed work"], other: ["", "info", "Input"] };
const countOf = (calls, outcome) => calls.filter((c) => c.outcome === outcome).length;
// What a turn's head says: the event and its task, or the input text.
const headText = (turn) => turn.kind === "event" ? ((turn.event && turn.event.event) || "event") + (turn.event && turn.event.task_id ? " · task " + turn.event.task_id : "") : turn.text;
function turnCard(turn, index) {
  const [cls, glyph, origin] = TAG[turn.kind];
  const key = turnKey(turn, index);
  const isEvent = turn.kind === "event";
  return el("article", { class: "card turn", "data-i": index, "data-timeline-anchor": "turn:" + turnIdentity(turn, index) },
    el(isEvent ? "button" : "div", { class: "head" + (isEvent ? " raw" : ""), ...(isEvent ? { type: "button", "data-focus": "raw:" + key, "aria-expanded": String(ui.raw.has(key)), title: "Show the raw event", onclick: () => toggle(ui.raw, key) } : {}) },
      el("span", { class: "sq " + cls }, pict(glyph, 16)),
      el("span", { class: "sr-only", text: origin + ":" }),
      el("span", { class: "small mono", title: turn.at ? new Date(turn.at).toLocaleString() : "", text: rel(turn.at) }),
      el("span", { class: "head-msg", text: headText(turn) }),
      isEvent ? el("span", { class: "raw-chev" }, icon(GLYPH.chevron, 15)) : null),
    ui.raw.has(key) ? el("div", { style: "padding:0 18px 12px" }, jsonBlock("e:" + key, turn.event === undefined ? turn.text : turn.event), el("div", { class: "small", text: "Shown as plain text. HTML in marketplace content is never rendered." })) : null,
    el("div", { class: "body" }, turn.replies.length ? turn.replies.map((reply, r) => replyBlock(reply, replyKey(turn, index, reply, r), index === view.timeline.length - 1)) : el("div", { class: "small", text: "No reply yet." })));
}
// live marks the newest turn: its call dots pulse so current failures stay visible,
// while an idle page's history stands still.
function replyBlock(reply, key, live) {
  const failed = countOf(reply.calls, "failed");
  const uncertain = countOf(reply.calls, "uncertain");
  const dot = (cls, n, label) => el("span", { class: "dot " + cls + (live ? " live" : ""), title: n + " " + label });
  return el("div", { class: "reply" },
    el("div", { style: "display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start" },
      reply.text ? el("div", { class: "reply-text" }, el("span", { class: "sq agent" }, pict("agent", 16)), el("span", { class: "sr-only", text: "Agent: " }), el("div", { class: "md" }, markdown(reply.text).map(mdBlock))) : el("span", { style: "flex:1 1 360px", class: "small", text: reply.calls.length ? "(tool calls only)" : "(empty reply: the model returned no text, possibly an error)" }),
      reply.calls.length ? el("button", { class: "calls-chip", "data-focus": "calls:" + key, "aria-expanded": String(ui.open.has(key)), "aria-label": reply.calls.length + (reply.calls.length === 1 ? " tool call" : " tool calls") + (failed ? ", " + failed + " failed" : "") + (uncertain ? ", " + uncertain + " uncertain" : ""), onclick: () => toggle(ui.open, key) },
        pict("cli", 13),
        el("span", { class: "num", text: reply.calls.length }),
        failed ? dot("bad", failed, "failed") : null,
        uncertain ? dot("warn", uncertain, "uncertain") : null) : null),
    ui.open.has(key) ? el("div", { class: "calls" }, reply.calls.map((call, c) => el("div", { class: "call " + call.outcome },
      el("span", { class: "sq cli", style: "width:20px;height:20px" }, pict("cli", 12)),
      el("span", { class: "name", text: call.name + " " + JSON.stringify(call.arguments) }),
      el("span", { style: "color:" + (call.outcome === "ok" ? "var(--ok)" : "var(--warn)"), text: call.outcome }),
      call.error ? el("div", { style: "flex-basis:100%;white-space:pre-wrap;color:var(--soft)", text: call.error }) : null,
      call.result !== undefined ? el("div", { class: "call-result" }, el("div", { class: "small", text: "Result" }), jsonBlock(key + "c" + c, call.result)) : null))) : null,
    reply.tasks.map(taskCard));
}

const smooth = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const lastSaid = (turn) => { const r = turn.replies.findLast((r) => r.text); return r ? markdown(r.text).map(plain).join(" ") : ""; };

// The timeline mounts only its newest turns. The rail gives each mounted turn a mark and
// compresses the rest into at most 12, each showing its most telling turn.
const RANK = { bad: 5, warn: 4, operator: 3, event: 2, resume: 2, other: 2, poll: 1 };
function hue(turn) {
  const calls = turn.replies.flatMap((r) => r.calls);
  return countOf(calls, "uncertain") ? "warn" : countOf(calls, "failed") ? "bad" : turn.kind;
}
const rank = (turn) => RANK[hue(turn)];
// Keep identities tied to the original run start, not the clipped window or run end.
function turnIdentity(turn, index) {
  const call = turn.replies.flatMap((reply) => reply.calls)[0];
  return turn.id || JSON.stringify([turn.at, call ? call.id : index]);
}
function timelineRows() {
  const from = Math.max(0, view.timeline.length - ui.windowN);
  return foldPolls(view.timeline).flatMap((row) => row.kind === "turn"
    ? row.index < from ? [] : [row]
    : row.to <= from ? [] : [{ ...row, start: row.from, from: Math.max(from, row.from) }]);
}
function rememberDisclosure(node, set, key) {
  node.addEventListener("toggle", (event) => {
    // Ignore nested toggles and the queued toggle event from a replaced node.
    if (event.target !== node || !app.contains(node)) return;
    if (node.open) set.add(key); else set.delete(key);
    onScroll();
  });
  return node;
}
const checkedAt = (at) => at ? new Date(at).toLocaleString() : "Unknown time";
function pollRun(row) {
  const tl = view.timeline, key = turnIdentity(tl[row.start], row.start), count = row.to - row.from;
  const first = tl[row.from], last = tl[row.to - 1];
  const summary = el("summary", { "data-focus": "fold:" + key, "data-timeline-anchor": "fold:" + key, "data-i": row.from },
    el("span", { class: "sq", "aria-hidden": "true" }, pict("clock", 16)),
    el("span", { class: "poll-heading" },
      el("span", { class: "poll-title" }, el("strong", { text: "No changes" }), el("span", { class: "num", text: count + (count === 1 ? " check" : " checks") })),
      el("span", { class: "poll-meta small mono", text: checkedAt(first.at) + " – " + checkedAt(last.at) + " · Last checked " + rel(last.at) }),
      el("span", { class: "poll-scope small", text: row.scope.join(", ") + " unchanged" })),
    el("span", { class: "raw-chev", "aria-hidden": "true" }, icon(GLYPH.chevron, 15)));
  return rememberDisclosure(el("details", { class: "poll-run", open: ui.folds.has(key) }, summary,
    tl.slice(row.from, row.to).map((turn, offset) => {
      const index = row.from + offset, checkKey = turnIdentity(turn, index);
      return rememberDisclosure(el("details", { class: "poll-check", open: ui.checks.has(checkKey) },
        el("summary", { "data-focus": "check:" + checkKey, "data-timeline-anchor": "check:" + checkKey, "data-i": index },
          el("span", { class: "mono small", text: checkedAt(turn.at) }), el("span", { text: "Check-in" }),
          el("span", { class: "raw-chev", "aria-hidden": "true" }, icon(GLYPH.chevron, 15))),
        turnCard(turn, index)), ui.checks, checkKey);
    })), ui.folds, key);
}
function timelineTurns(rows) {
  const tl = view.timeline, from = Math.max(0, tl.length - ui.windowN);
  const earlier = from + (from === 1 ? " earlier turn" : " earlier turns");
  const size = Math.ceil(from / 12), groups = [];
  for (let a = 0; a < from; a += size) {
    const b = Math.min(from, a + size);
    let pick = a, best = rank(tl[a]);
    for (let i = a + 1; i < b; i++) { const r = rank(tl[i]); if (r > best) { pick = i; best = r; } }
    groups.push([pick, a, b]);
  }
  const tick = (i, span) => {
    const turn = tl[i], who = TAG[turn.kind][2], h = hue(turn);
    const said = turn.kind === "operator" || turn.kind === "event" ? headText(turn) : lastSaid(turn) || "(no reply text)";
    const where = span && span[1] - span[0] > 1 ? "Turns " + (span[0] + 1) + "–" + span[1] + " of " + tl.length + ", not loaded" : "";
    const onkeydown = (e) => {
      const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!d || !tl[i + d]) return;
      e.preventDefault();
      jumpTo(i + d);
      document.querySelector('.tick[data-i="' + (i + d) + '"]').focus();
    };
    // markRail() picks the one current mark, which is also the rail's one tab stop.
    return el("button", { class: "tick " + turn.kind + (h === turn.kind ? "" : " " + h), "data-i": i, "data-focus": "tick:" + turnIdentity(turn, i), tabindex: "-1", "aria-current": "false", "aria-label": (where ? where + " · " : "") + who + ", " + rel(turn.at), onclick: () => jumpTo(i), onkeydown },
      el("span", { class: "peek" }, where ? el("span", { class: "small", text: where }) : null, el("span", { class: "small mono", text: who + " · " + rel(turn.at) }), el("span", { class: "peek-text", text: said })));
  };
  return el("div", { class: "railed" },
    el("div", { class: "turns" },
      from ? el("div", { class: "card earlier" }, el("span", { class: "small", text: earlier }),
        el("button", { onclick: () => showFrom(from - 20), text: "Show " + Math.min(20, from) + " more" })) : null,
      rows.map((row) => row.kind === "turn" ? turnCard(tl[row.index], row.index) : pollRun(row))),
    el("nav", { class: "rail", "aria-label": "Jump to a turn" },
      from ? el("div", { class: "rail-earlier", title: earlier + ", not loaded" }, groups.map(([pick, a, b]) => tick(pick, [a, b]))) : null,
      tl.slice(from).map((t, k) => tick(from + k))));
}
// Mount turns from index i onward, keeping the reader's place.
function showFrom(i) {
  ui.windowN = view.timeline.length - Math.max(0, i);
  render();
}
function jumpTo(i) {
  // A turn that was not mounted is far away: go there at once rather than glide.
  const far = i < view.timeline.length - ui.windowN;
  const row = foldPolls(view.timeline).find((row) => row.kind === "unchanged" && row.from <= i && i < row.to);
  if (row) {
    ui.folds.add(turnIdentity(view.timeline[row.from], row.from));
    ui.checks.add(turnIdentity(view.timeline[i], i));
  }
  if (far) showFrom(i); else if (row) render();
  document.querySelector('.turn[data-i="' + i + '"]')?.scrollIntoView({ block: "start", behavior: far ? "auto" : smooth() });
  markRail(i);
}
function markRail(i) {
  const old = document.querySelector('.tick[aria-current="true"]'), next = document.querySelector('.tick[data-i="' + i + '"]');
  if (!next || next === old) return;
  if (old) { old.setAttribute("aria-current", "false"); old.tabIndex = -1; }
  next.setAttribute("aria-current", "true");
  next.tabIndex = 0;
}
const toNewest = (behavior) => { const end = document.querySelector(".send-note"); if (end) end.scrollIntoView({ block: "end", behavior }); };

// The rail must end above the pinned composer even at the page end, where the send note
// and page gap follow it. Their heights change as chips wrap or the field is resized,
// and render() replaces both, so measureComposer() re-observes them.
let composerSpace = "";
const composerSize = new ResizeObserver(() => {
  const form = document.querySelector("form.composer"), note = document.querySelector(".send-note");
  if (!form || !note) return;
  // The note is never sticky, so its box shows what really follows the composer: to the
  // page end, or to the end of the column plus the page gap when the sidebar wraps below.
  const noteTop = note.getBoundingClientRect().top + scrollY;
  const mainEnd = note.closest("main").getBoundingClientRect().bottom + scrollY + 24;
  const space = Math.ceil(form.offsetHeight + Math.min(document.documentElement.scrollHeight, mainEnd) - noteTop + 16) + "px";
  if (space !== composerSpace) document.documentElement.style.setProperty("--composer-space", composerSpace = space);
});
function measureComposer() {
  composerSize.disconnect();
  for (const node of document.querySelectorAll("form.composer, .send-note")) composerSize.observe(node);
}
// render() rebuilds the page on every push, so scroll-driven marks are reapplied to
// whatever is mounted. ponytail: linear scan of mounted turns per frame; the window
// keeps that small unless the operator loads the whole history.
let scrollFrame = 0, toEnd = true;
addEventListener("scroll", () => { scrollFrame ||= requestAnimationFrame(onScroll); }, { passive: true });
function onScroll() {
  scrollFrame = 0;
  const turns = visibleTimeline();
  if (!turns.length) return document.body.classList.remove("away");
  const at = turns.find((t) => t.getBoundingClientRect().bottom > 120) || turns[turns.length - 1];
  markRail(Number(at.dataset.i));
  document.body.classList.toggle("away", turns[turns.length - 1].getBoundingClientRect().bottom > innerHeight + 120);
}

// Summaries stand in for hidden originals. Expanded cards participate only when
// they have layout boxes, so closed details never steal the rail's current mark.
function visibleTimeline() {
  return [...document.querySelectorAll("[data-timeline-anchor]")].filter((node) => node.getClientRects().length);
}
function readingAnchor() {
  const visible = visibleTimeline();
  const node = visible.find((node) => node.getBoundingClientRect().bottom > 120);
  return node ? { key: node.getAttribute("data-timeline-anchor"), top: node.getBoundingClientRect().top } : null;
}
function restoreReading(anchor) {
  if (!anchor) return;
  const node = visibleTimeline().find((node) => node.getAttribute("data-timeline-anchor") === anchor.key);
  if (node) scrollBy(0, node.getBoundingClientRect().top - anchor.top);
}
// A completing check can move the focused tool control into a new fold. Reveal
// that original before restoring focus, without reopening a summary just closed.
function revealFocusedControl(node) {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    if ((!parent.matches(".poll-run") && !parent.matches(".poll-check")) || parent.children[0] === node) continue;
    parent.open = true;
    const focus = parent.querySelector("summary").getAttribute("data-focus");
    if (focus.startsWith("fold:")) ui.folds.add(focus.slice(5));
    else if (focus.startsWith("check:")) ui.checks.add(focus.slice(6));
  }
}

function readiness() {
  const host = view.host || {};
  const limits = view.spec.limits || {};
  const checks = [
    ["Wallet balance", usdc(host.wallet), /^0\\.00 |unavailable|unknown/.test(usdc(host.wallet)) ? false : true],
    ["Wallet unlock file", host.unlockFile ? "present" : "missing · create .taskfast/wallet-password (mode 0400) in the agent folder", !!host.unlockFile],
    ["Event stream", host.stream || "unknown", host.stream === "connected"],
    ["Model", view.spec.model + (view.timeline.length ? " · last turn " + rel(view.timeline[view.timeline.length - 1].at) : " · no turns yet"), true],
    ["Spending limits", limits.perJobUsd !== undefined || limits.dailyUsd !== undefined ? [limits.perJobUsd !== undefined ? money(limits.perJobUsd) + " per job" : null, limits.dailyUsd !== undefined ? money(limits.dailyUsd) + " per day" : null].filter(Boolean).join(" · ") : "none: nothing caps commitments", limits.perJobUsd !== undefined || limits.dailyUsd !== undefined],
  ];
  const problems = checks.filter((c) => !c[2]).length;
  return el("section", { class: "section" },
    band("Ready to work?", problems ? problems + (problems === 1 ? " problem" : " problems") : "yes"),
    el("div", { class: "card" }, checks.map(([label, detail, ok]) => el("div", { class: "check" },
      el("span", { class: "sq " + (ok ? "ok" : "warn") }, pict(ok ? "check" : "exclaim", 16)),
      el("div", {}, el("div", { style: "font-weight:500" }, el("span", { class: "word " + (ok ? "ok" : "warn"), text: ok ? "OK" : "Problem" }), " · " + label), el("div", { class: "small", text: detail }))))));
}
function tasksPanel() {
  const groups = { POSTED: new Map(), BIDDING: new Map(), "WORKING ON": new Map() };
  const via = { post_task: "POSTED", bid_accept: "POSTED", bid_reject: "POSTED", escrow_sign: "POSTED", bid_create: "BIDDING", task_claim: "WORKING ON", task_submit: "WORKING ON" };
  for (const turn of view.timeline) for (const reply of turn.replies) for (const ref of reply.tasks) if (via[ref.via]) groups[via[ref.via]].set(ref.id, { ...ref, via: via[ref.via] });
  const total = Object.values(groups).reduce((n, g) => n + g.size, 0);
  return el("section", { class: "section" },
    band("Tasks", total + " in play"),
    el("div", { class: "card" }, Object.entries(groups).map(([name, refs]) => el("div", { style: "display:flex;flex-direction:column;gap:6px" },
      el("div", { class: "small", style: "font-weight:600", text: name + " · " + refs.size }),
      [...refs.values()].map((ref) => taskCard({ id: ref.id, via: "" }))))));
}
function spendPanel() {
  const spent = view.spend[today()] || 0;
  const limit = view.spec.limits && view.spec.limits.dailyUsd;
  const uncertain = Object.values(view.actions).filter((a) => a.status === "uncertain" && a.day === today()).reduce((sum, a) => sum + a.amount, 0);
  const op = view.operator;
  const safe = limit > 0 ? limit : Math.max(spent, 0.01);
  const bar = (w, cls) => el("span", { class: cls, style: "width:" + Math.min(100, (w / safe) * 100) + "%" });
  const sparkDays = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (6 - i));
    const k = d.toISOString().slice(0, 10);
    return { k, v: view.spend[k] || 0, today: i === 6 };
  });
  const sparkMax = Math.max(limit || 0, ...sparkDays.map((d) => d.v), 0.01);
  return el("section", { class: "section" },
    band("Budget", "UTC · resets midnight"),
    el("div", { class: "card budget" + (op.frozen ? " frozen" : "") },
      el("div", { class: "monu num" }, money(spent)),
      limit !== undefined ? el("div", { class: "tufte", role: "img", "aria-label": money(spent) + " of " + money(limit) + " spent today, " + money(uncertain) + " uncertain" },
        bar(spent - uncertain, "tufte-spent"),
        bar(uncertain, "tufte-uncertain")) : null,
      limit !== undefined ? el("div", { class: "tufte-scale small" }, el("span", { text: "$0" }), el("span", { text: money(limit) + " daily limit" })) : el("div", { class: "small", text: "No daily limit: nothing caps commitments" }),
      el("div", { class: "spark-row", role: "img", "aria-label": "Daily spend, last 7 days UTC" },
        sparkDays.map((d) => el("span", { class: "spark" + (d.today ? " today" : ""), style: "height:" + Math.max(2, Math.round((d.v / sparkMax) * 24)) + "px", title: d.k + " · " + money(d.v) }))),
      uncertain ? el("div", { class: "small", text: "Includes " + money(uncertain) + " uncertain" }) : null,
      el("button", { class: "lvtoggle" + (op.frozen ? " frozen" : ""), "aria-pressed": String(op.frozen), "aria-label": op.frozen ? "Unfreeze spending" : "Freeze spending", title: op.frozen ? "Unfreeze spending" : "Freeze spending", onclick: () => act("POST", "frozen", { value: !op.frozen }) },
        el("span", { class: "track" }, el("span", { class: "knob" })),
        el("span", { class: "state-word", text: op.frozen ? "FROZEN" : "READY" }))));
}

async function submitMessage(mode) {
  if (!ready() || !view) { ui.messageError = "Not sent. Waiting for this agent to be ready."; updateMessageStatus(); return; }
  const text = ui.draft.trim();
  if (!text) return;
  // Identity includes the first mode and the owning agent, not whichever key retries it.
  const attempt = ui.attempt || (ui.attempt = { requestId: crypto.randomUUID(), agent: ui.agent, draft: ui.draft, text, mode, pending: false });
  if (attempt.pending) return;
  attempt.pending = true;
  ui.messageError = "";
  updateMessageStatus();
  try {
    await api("POST", "/api/agents/" + encodeURIComponent(attempt.agent) + "/messages", { requestId: attempt.requestId, text: attempt.text, ...(attempt.mode === "steer" ? { steer: true } : {}) });
    // An edited draft belongs to a new send. Never clear it on an older admission.
    if (ui.attempt === attempt && ui.agent === attempt.agent && ui.draft === attempt.draft) {
      ui.draft = ""; ui.attempt = null;
      const textarea = document.querySelector("form.composer textarea");
      if (textarea) textarea.value = "";
    }
    const saved = drafts.get(attempt.agent);
    if (saved && saved.attempt === attempt && saved.draft === attempt.draft) drafts.set(attempt.agent, { draft: "", attempt: null, messageError: "" });
    await refresh();
  } catch (error) {
    const failure = "Message not confirmed. Retry keeps its ID and " + modeLabel(attempt.mode) + " mode. " + error.message;
    if (ui.attempt === attempt && ui.agent === attempt.agent) ui.messageError = failure;
    const saved = drafts.get(attempt.agent);
    if (saved && saved.attempt === attempt) saved.messageError = failure;
  } finally { attempt.pending = false; render(); }
}
const modeLabel = (mode) => mode === "steer" ? "Steer" : "Follow-up";
function updateMessageStatus() {
  const status = document.querySelector(".message-status");
  if (status) { status.textContent = ui.messageError || (ui.attempt && ui.attempt.pending ? "Sending " + modeLabel(ui.attempt.mode) + "…" : ""); status.className = "message-status " + (ui.messageError ? "error" : "small"); }
  const send = document.querySelector("form.composer .send");
  if (send) send.setAttribute("aria-disabled", String(!ready() || !view || !!(ui.attempt && ui.attempt.pending)));
}

const promotionKey = (agent, requestId) => agent + "/" + requestId;
async function promoteMessage(requestId, agent) {
  const key = promotionKey(agent, requestId);
  const previous = ui.promotions.get(key);
  const withdrawal = ui.withdrawals.get(key);
  if ((previous && (previous.pending || previous.done)) || (withdrawal && (withdrawal.pending || withdrawal.done))) return;
  if (withdrawal) withdrawal.error = "";
  const state = { pending: true, done: false, error: "" };
  ui.promotions.set(key, state);
  ui.notices.delete(agent);
  render();
  try {
    await api("POST", "/api/agents/" + encodeURIComponent(agent) + "/steer/" + encodeURIComponent(requestId));
    state.done = true;
    ui.notices.set(agent, "Changed to a steer.");
    await refresh();
  } catch (error) {
    // This ID came from a visible follow-up. A 404 means it left the queue before
    // the click arrived, just like the placement race reported with 409.
    if (error.status === 409 || error.status === 404) {
      state.done = true;
      ui.notices.set(agent, "The agent already has this message.");
      await refresh();
    } else state.error = "Could not steer this message. Try again. " + error.message;
  } finally { state.pending = false; render(); }
}
async function withdrawMessage(requestId, agent) {
  const key = promotionKey(agent, requestId);
  const previous = ui.withdrawals.get(key), promotion = ui.promotions.get(key);
  if ((previous && (previous.pending || previous.done)) || (promotion && promotion.pending)) return;
  if (promotion) promotion.error = "";
  const state = { pending: true, done: false, error: "" };
  ui.withdrawals.set(key, state);
  ui.notices.delete(agent);
  render();
  try {
    await api("DELETE", "/api/agents/" + encodeURIComponent(agent) + "/messages/" + encodeURIComponent(requestId));
    state.done = true;
    ui.notices.set(agent, "Message withdrawn.");
    await refresh();
  } catch (error) {
    // Placement may win before this visible row's withdrawal reaches the host.
    if (error.status === 409 || error.status === 404) {
      state.done = true;
      ui.notices.set(agent, "The agent already has this message.");
      await refresh();
    } else state.error = "Could not withdraw this message. Try again. " + error.message;
  } finally { state.pending = false; render(); }
}
let queueTextIds = 0;
function queueRow(message) {
  const row = el("div", { class: "card queue-row", role: "listitem", "data-request-id": message.requestId },
    el("div", { class: "queue-mode" }), el("div", { class: "queue-text", id: "queue-text-" + ++queueTextIds }),
    el("div", { class: "queue-actions" }), el("div", { class: "error queue-error", role: "status" }));
  updateQueueRow(row, message);
  return row;
}
// The mode line says when the message reaches the agent. The watermark is hidden
// from screen readers, so "Queued" is spoken from here instead.
function updateQueueRow(row, message) {
  const when = view.operator.paused ? "waits until you resume" : message.mode === "steer" ? "reaches the agent after its current tool round" : "waits for the agent's next run";
  row.querySelector(".queue-mode").replaceChildren(el("span", { class: "sr-only", text: "Queued " }), modeLabel(message.mode), el("span", { class: "queue-when", text: " · " + when }));
  const text = row.querySelector(".queue-text");
  if (text.textContent !== message.text) text.textContent = message.text;
  const key = promotionKey(ui.agent, message.requestId), agent = ui.agent;
  const state = ui.promotions.get(key), withdrawal = ui.withdrawals.get(key);
  row.querySelector(".queue-error").textContent = (withdrawal && withdrawal.error) || (state && state.error) || "";
  const actions = row.querySelector(".queue-actions");
  let withdraw = row.querySelector(".queue-withdraw");
  if (!withdraw) {
    withdraw = el("button", { type: "button", class: "queue-withdraw", "aria-describedby": text.getAttribute("id"), onclick: () => withdrawMessage(message.requestId, agent) });
    actions.append(withdraw);
  }
  withdraw.textContent = withdrawal && withdrawal.pending ? "Withdrawing…" : withdrawal && withdrawal.done ? "Withdrawn" : "Withdraw";
  withdraw.setAttribute("aria-disabled", String(!!((withdrawal && (withdrawal.pending || withdrawal.done)) || (state && state.pending))));
  let button = row.querySelector(".queue-promote");
  if (message.mode === "followUp") {
    if (!button) { button = el("button", { type: "button", class: "queue-promote", "aria-describedby": text.getAttribute("id"), onclick: () => promoteMessage(message.requestId, agent) }); actions.insertBefore(button, withdraw); }
    button.textContent = state && state.pending ? "Steering…" : state && state.done ? "Sent" : "Steer";
    // aria-disabled keeps focused controls in the keyboard order. Both handlers
    // ignore duplicate clicks and serialize this row's two actions.
    button.setAttribute("aria-disabled", String(!!((state && (state.pending || state.done)) || (withdrawal && (withdrawal.pending || withdrawal.done)))));
  } else if (button) { if (document.activeElement === button) withdraw.focus({ preventScroll: true }); button.remove(); }
}
// No band: each waiting row is muted and marked "Queued" at its top right. The
// section stays in the page, hidden while empty, so a stream update can fill it in
// place. The notice sits outside it and stays visible.
function queuedMessages() {
  const queue = view.queuedMessages;
  return [el("section", { class: "section", id: "queued-messages", "data-agent": ui.agent, tabindex: "-1", "aria-label": "Queued messages", hidden: !queue.length },
    el("div", { class: "section queued-rows", role: "list" }, queue.map(queueRow))),
    el("div", { class: "small queue-notice", role: "status", "aria-live": "polite", text: ui.notices.get(ui.agent) || "" })];
}
function updateQueuedMessages() {
  const section = document.querySelector("#queued-messages");
  if (!section || !view || ui.tab !== "timeline" || section.getAttribute("data-agent") !== ui.agent) return;
  const rows = section.querySelector(".queued-rows"), queue = view.queuedMessages;
  const oldRows = [...rows.children], focusedIndex = oldRows.findIndex((row) => row.contains(document.activeElement));
  const existing = new Map(oldRows.map((row) => [row.getAttribute("data-request-id"), row]));
  const ids = new Set(queue.map((message) => message.requestId));
  const focusRemoved = focusedIndex >= 0 && !ids.has(oldRows[focusedIndex].getAttribute("data-request-id"));
  for (const [id, row] of existing) if (!ids.has(id)) row.remove();
  queue.forEach((message, index) => {
    const row = existing.get(message.requestId) || queueRow(message);
    updateQueueRow(row, message);
    if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] || null);
  });
  section.hidden = !queue.length;
  // Recover focus only when its row left the queue. Prefer the next row, then
  // the previous one, and never strand focus on a section or a hidden control.
  if (focusRemoved) {
    const neighbor = rows.children[Math.min(focusedIndex, rows.children.length - 1)];
    const control = neighbor ? neighbor.querySelector(".queue-withdraw") : document.querySelector("form.composer textarea");
    if (control) control.focus({ preventScroll: true });
  }
  document.querySelector(".queue-notice").textContent = ui.notices.get(ui.agent) || "";
}

function timelineTab() {
  const op = view.operator;
  const waiting = Object.values(view.events).filter((w) => w.kind === "admitted").length + view.queuedMessages.length;
  const n = view.timeline.length, rows = timelineRows(), groups = rows.filter((row) => row.kind === "unchanged").length;
  return el("div", { class: "page" },
    el("main", {},
      op.paused ? el("div", { class: "note", role: "status" }, el("strong", { text: "Paused. " }), "New events are still received and stored, so nothing is lost. " + waiting + " waiting; they run in order when you resume. Check-ins are skipped while paused.") : null,
      attention(),
      band("Timeline", n + (n === 1 ? " turn" : " turns") + " · " + Math.min(n, ui.windowN) + " loaded · " + groups + (groups === 1 ? " unchanged group" : " unchanged groups")),
      n ? timelineTurns(rows) : el("div", { class: "small", text: "No turns yet." }),
      queuedMessages(),
      el("form", { class: "card composer", onsubmit: (e) => {
        e.preventDefault();
        submitMessage("followUp");
      } },
        el("label", {}, el("span", { class: "sr-only", text: "Message " + view.id }),
          el("textarea", { rows: 2, "aria-label": "Message " + view.id, placeholder: 'e.g. "Post one copy-editing job under $15."', oninput: (e) => { if (ui.draft !== e.target.value) ui.attempt = null; ui.draft = e.target.value; ui.messageError = ""; updateMessageStatus(); }, onkeydown: (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); submitMessage("steer"); }
            else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); }
          }, text: ui.draft })),
        el("div", { class: "samples" }, el("span", { class: "samples-label", text: "Try:" }),
          ["Post a job under $15", "Hold off on new bids today", "Summarize the last check-in"].map((s) =>
            el("button", { type: "button", class: "sample", onclick: () => draftInto(s), text: s }))),
        el("button", { type: "submit", class: "primary send", text: "Send" }),
        el("div", { class: "hint" },
          el("span", {}, el("kbd", { text: "Enter" }), " follow-up · ", el("kbd", { text: "Shift+Enter" }), " for a new line"),
          el("span", {}, el("kbd", { text: "Ctrl/Cmd+S" }), " steer")),
        el("button", { type: "button", class: "sq jump", "aria-label": "Jump to the newest turn", title: "Jump to the newest turn", onclick: () => toNewest(smooth()) }, pict("arrow", 16))),
      el("div", { class: "small send-note" },
        el("div", { class: "message-status", role: "status", "aria-live": "polite" }),
        "Each send carries its own ID and mode, so a double click or a retry queues it only once.")),
    el("aside", {}, readiness(), tasksPanel(), spendPanel(),
      el("section", { class: "section" },
        band("Standing orders", "· " + op.orders.length),
        el("div", { class: "card" },
          op.orders.map((order) => el("div", { text: order })),
          el("a", { href: destinations.href({ ...destination(), tab: "briefing", capability: destinations.empty().capability }), style: "display:inline-flex;gap:6px;align-items:center", onclick: (e) => followTab(e, "briefing") }, "Edit in Briefing", pict("arrow", 14))))));
}

function briefingTab() {
  const op = view.operator;
  const draft = ui.specDraft || (ui.specDraft = JSON.parse(JSON.stringify(view.spec)));
  const set = (path, value) => { let at = draft; for (const key of path.slice(0, -1)) at = at[key] = at[key] || {}; at[path[path.length - 1]] = value; render(); };
  const number = (value) => value === "" ? undefined : Number(value);
  const limitText = (value) => value === undefined ? "no limit" : money(value);
  const limitChanges = ["perJobUsd", "dailyUsd"].filter((k) => (view.spec.limits || {})[k] !== (draft.limits || {})[k]);
  function saveBriefing() {
    const minutes = draft.pollIntervalMinutes ?? ${POLL_MINUTES.default};
    if (!Number.isInteger(minutes) || minutes < ${POLL_MINUTES.min} || minutes > ${POLL_MINUTES.max}) {
      ui.error = "Check-for-work interval must be a whole number from ${POLL_MINUTES.min} to ${POLL_MINUTES.max} minutes.";
      render(true);
      return;
    }
    if (draft.limits && Object.values(draft.limits).every((v) => v === undefined)) delete draft.limits;
    act("PUT", "spec", draft).then(() => { if (!ui.error) ui.specDraft = null; });
  }
  return el("div", { class: "page" },
    el("main", {},
      el("section", { class: "section" },
        band("Standing orders", "live from the next turn · the agent cannot remove these"),
        el("div", { class: "card" },
        el("ol", { style: "margin:0;padding-left:22px;display:flex;flex-direction:column;gap:8px" },
          op.orders.map((order, index) => el("li", {}, el("div", { style: "display:flex;gap:12px;align-items:center;justify-content:space-between" }, el("span", { text: order }),
            // Removal pins the exact text shown; the server refuses with a 409 when that index no longer holds it.
            el("button", { "aria-label": "Remove order " + (index + 1), onclick: () => act("DELETE", "orders/" + index, { expect: order }), text: "Remove" }))))),
        el("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); const text = ui.orderDraft.trim(); if (text) act("POST", "orders", { text }).then(() => { if (!ui.error) { ui.orderDraft = ""; render(); } }); } },
          el("label", {}, "New order", el("input", { type: "text", value: ui.orderDraft, oninput: (e) => { ui.orderDraft = e.target.value; } })),
          el("button", { type: "submit", class: "primary", text: "Add" })),
        el("div", { class: "small", text: "The agent's own notes: " + (view.notes.length ? view.notes.join(" · ") : "none yet.") }))),
      el("section", { class: "section" },
        band("INSTRUCTIONS.md and agent.json", "saving reopens only this agent; the others keep running"),
        el("div", { class: "card" },
        el("label", {}, "Instructions (INSTRUCTIONS.md): who the agent is, its business, goals and budget", el("textarea", { rows: 8, maxlength: ${MAX_INSTRUCTIONS}, onchange: (e) => set(["instructions"], e.target.value), text: draft.instructions })),
        el("label", {}, "Check for work every (minutes)", el("input", { id: "poll-interval", type: "number", min: ${POLL_MINUTES.min}, max: ${POLL_MINUTES.max}, step: 1, required: true, "aria-describedby": "poll-interval-help", value: draft.pollIntervalMinutes ?? ${POLL_MINUTES.default}, onchange: (e) => set(["pollIntervalMinutes"], Number(e.target.value)) })),
        el("div", { id: "poll-interval-help", class: "small" }, "Whole minutes from 1 to 1,440; default 15. The delay starts after each check. Shorter intervals may increase model usage. Marketplace events still arrive independently.",
          view.host?.pollIntervalMs !== undefined && view.host.pollIntervalMs !== (view.spec.pollIntervalMinutes ?? ${POLL_MINUTES.default}) * 60000
            ? el("div", { text: "Host override active: the current delay is " + view.host.pollIntervalMs / 1000 + " seconds. Saving does not change the override." }) : null),
        el("div", { class: "grid" },
          el("label", {}, "Temperament", el("select", { onchange: (e) => set(["dials", "temperament"], e.target.value) },
            ["patient", "brisk", "exacting", "easygoing", "curt"].map((t) => el("option", { value: t, selected: draft.dials.temperament === t, text: t })))),
          el("label", {}, "Per job limit ($)", el("input", { type: "number", min: 0, step: "0.01", value: (draft.limits || {}).perJobUsd ?? "", onchange: (e) => set(["limits", "perJobUsd"], number(e.target.value)) })),
          el("label", {}, "Daily limit ($)", el("input", { type: "number", min: 0, step: "0.01", value: (draft.limits || {}).dailyUsd ?? "", onchange: (e) => set(["limits", "dailyUsd"], number(e.target.value)) })),
          ["competence", "diligence", "priceSensitivity"].map((dial) => el("label", {}, dial + " " + draft.dials[dial],
            el("input", { type: "range", min: 0, max: 1, step: "0.1", value: draft.dials[dial], onchange: (e) => set(["dials", dial], Number(e.target.value)) })))),
        limitChanges.length ? el("div", { class: "note", role: "group" }, el("strong", { text: "Confirm spending change" }),
          limitChanges.map((k) => el("div", { class: "mono", text: (k === "dailyUsd" ? "Daily limit " : "Per job limit ") + limitText((view.spec.limits || {})[k]) + " → " + limitText((draft.limits || {})[k]) })),
          el("div", { class: "small", text: "Takes effect when the agent reopens. Spending already counted today still counts." })) : null,
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          el("button", { class: "primary", onclick: saveBriefing, text: limitChanges.length ? "Confirm, save & reopen" : "Save & reopen" }),
          el("button", { onclick: () => { ui.specDraft = null; render(); }, text: "Discard" })),
        el("div", { class: "small", text: "Checked against the strict agent schema first; nothing is written if it fails. If the agent cannot reopen, both files go back to what they were. Saving while the agent is mid-turn interrupts it: a write in flight is recorded as uncertain, as after a restart." })))),
    el("aside", {}, el("section", { class: "section" },
      band("What the agent reads every turn"),
      el("div", { class: "card" }, el("pre", { text: view.prompt })))));
}

function unlock() {
  let value = "";
  return el("div", { class: "unlock" },
    el("div", { class: "brand" }, el("span", { class: "sq you" }, pict("agent", 16)), "Agent console"),
    el("h1", { style: "margin:0", text: "Unlock the console" }),
    el("p", { style: "margin:0", text: "When pnpm agents --console starts, it prints a console link with a one-time token. Open that link, or paste the token here." }),
    el("form", { style: "display:flex;flex-direction:column;gap:12px", onsubmit: (e) => { e.preventDefault(); if (/^[0-9a-f]{64}$/.test(value.trim())) { token = value.trim(); store.set("token", token); refresh(); } else { ui.error = "That is not a console token."; render(); } } },
      el("label", {}, "Console token", el("input", { type: "password", autocomplete: "off", oninput: (e) => { value = e.target.value; } })),
      el("button", { type: "submit", class: "primary", style: "align-self:flex-start", text: "Unlock" })),
    ui.error ? el("div", { class: "error", role: "alert", text: ui.error }) : null,
    el("p", { class: "small", text: "Requests without this token, or from a page not served here, are refused. That stops other websites open in your browser from steering the agent or spending money. A new token is issued each time the host starts." }));
}

let renderedSelection = null, timelineLength = 0;
function render(force = false) {
  const entry = selected();
  const current = [token, ui.agent, stateOf(entry), generationOf(entry), entry?.phase, entry?.reason, !!view].join("/");
  const changed = force || current !== renderedSelection;
  // Reconcile queue rows by ID before protecting the active editor. A stream push
  // must not hide a promotion or consume the composer's focus and selection.
  updateQueuedMessages();
  updateMessageStatus();
  updateStartupStatus();
  // Keep roster labels fresh even while the operator edits a protected draft.
  const selector = document.querySelector('select[aria-label="Agent"]');
  if (selector && list) {
    const options = (ui.reopening ? [{ id: ui.agent, state: "missing" }] : []).concat(list.agents);
    const signature = JSON.stringify(options);
    if (selector.dataset.roster !== signature) {
      selector.replaceChildren(...options.map((a) => el("option", { value: a.id, selected: a.id === ui.agent, text: a.id + (a.role ? " · " + a.role : "") + (stateOf(a) === "ready" ? "" : " · " + stateOf(a)) })));
      selector.dataset.roster = signature;
    }
  }
  const capRoot = document.querySelector("#capabilities-root");
  if (!force && token && ui.tab === "capabilities" && capRoot && capRoot.getAttribute("data-agent") === ui.agent) {
    // Host pushes update the chrome, never the capability editor or its focused controls.
    const chrome = document.querySelector("header");
    if (chrome && !chrome.contains(document.activeElement)) {
      const next = header().find((node) => node.tagName === "HEADER");
      if (next) chrome.replaceChildren(...next.children);
    }
    renderedSelection = current;
    return;
  }
  const activeTag = document.activeElement && document.activeElement.tagName;
  // Keep keyboard focus on stable queue controls as well as on the editor.
  const queue = document.querySelector("#queued-messages");
  const timeline = token && ready() && view && !ui.reopening && ui.tab === "timeline";
  if (!changed && timeline && queue && queue.contains(document.activeElement)) return;
  // Briefing fields and inputs keep the old protection: never rebuild under them.
  if (!changed && ((activeTag === "INPUT" || activeTag === "SELECT") || (activeTag === "TEXTAREA" && ui.tab === "briefing"))) return;
  // Queue and admission feedback update above without rebuilding a typed draft.
  // An empty composer keeps the existing full live refresh and gets focus back.
  const taHadFocus = activeTag === "TEXTAREA";
  if (!changed && taHadFocus && ui.draft && ui.tab === "timeline") return;
  if (taHadFocus) ui.focusComposer = true;
  const focused = !changed && document.activeElement?.getAttribute("data-focus");
  const anchor = !changed && timeline && !toEnd ? readingAnchor() : null;
  // Preserve the mounted start as new turns arrive, including an opened check at
  // the window boundary. Explicit earlier loading remains measured in originals.
  if (!changed && timeline) ui.windowN += Math.max(0, view.timeline.length - timelineLength);
  timelineLength = timeline ? view.timeline.length : 0;
  renderedSelection = current;
  const missingPanels = ready() && view && ui.tab === "timeline" ? resolvePanels() : false;
  app.replaceChildren(...(!token ? [unlock()] :
    [...header(), ui.error ? el("div", { class: "page" }, el("div", { class: "error", role: "alert", text: ui.error })) : null,
      ui.invalidDestination ? el("div", { class: "page" }, unavailableDestination()) : ui.tab === "capabilities" && ui.agent && selected() ? capabilities.mount(ui.agent, selected().name || ui.agent, ui.capability) : !ready() || !view ? startupPanel() : ui.tab === "timeline" ? missingPanels ? el("div", { class: "page" }, unavailableDestination()) : timelineTab() : briefingTab()].filter(Boolean)));
  updateStartupStatus();
  if (activeTag === "SELECT" && changed) document.querySelector('select[aria-label="Agent"]')?.focus({ preventScroll: true });
  // The timeline opens at its newest turn, as a chat does.
  if (toEnd && view && ui.tab === "timeline") { toEnd = false; if (!ui.open.size && !ui.raw.size) toNewest("auto"); }
  updateMessageStatus();
  measureComposer();
  const restored = focused && [...document.querySelectorAll("[data-focus]")].find((node) => node.getAttribute("data-focus") === focused);
  if (restored) revealFocusedControl(restored);
  restoreReading(anchor);
  onScroll();
  if (restored) { restored.focus({ preventScroll: true }); ui.focusComposer = false; }
  // Only the composer's own textarea: a bare "textarea" query can land on a Briefing
  // field. Restored focus keeps the reader's scroll position; a deliberate ask
  // (draftInto) scrolls the composer into view.
  const next = document.querySelector("form.composer textarea");
  if (ui.focusComposer && next) {
    next.focus({ preventScroll: !ui.scrollComposer });
    ui.focusComposer = ui.scrollComposer = false;
  }
}
// Catch Save Page even when Send or a queue control has keyboard focus. The
// textarea handles its own shortcut first; defaultPrevented avoids a second send.
addEventListener("keydown", (e) => {
  if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && token && view && ui.tab === "timeline") { e.preventDefault(); submitMessage("steer"); }
});
render();
refresh();
setInterval(() => { void refresh(); if (token && ui.tab === "capabilities") void capabilities.poll(); }, 1000);
</script>
</body>
</html>
`;
