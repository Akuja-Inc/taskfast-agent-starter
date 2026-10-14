import { follow } from "./console-live.js";

// The page runs the same stream follower as the terminal UI.
export const LIVE = follow.toString();

// The console's single page. Kept as a module because the TypeScript build copies no
// HTML. Everything from the server or the marketplace is set as text, never as markup.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent console</title>
<style>
:root { --yellow: #FFCC00; --ground: #F2F2EF; --panel: #FFFFFF; --ink: #0B0B0B; --soft: #3D3D38; --muted: #5E5E56; --hairline: rgba(11,11,11,.72); --agent: #1D4ED8; --cli: #7C3AED; --ok: #1D6B34; --warn: #B45309; --warn-bg: #FDF3E3; --bad: #B3261E; --square: #0B0B0B; --code-bg: #0B0B0B; --code-ink: #E9E7DC; --sans: "Segoe UI", Frutiger, "Frutiger Next", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, system-ui, sans-serif; accent-color: var(--agent); }
[data-theme="dark"] { --ground: #131311; --panel: #1C1C19; --ink: #F2F1EA; --soft: #C9C8BE; --muted: #A3A298; --hairline: rgba(242,241,234,.5); --agent: #7AA8FF; --cli: #B794F6; --ok: #56D364; --warn: #D29922; --warn-bg: #3A2E10; --bad: #F85149; --square: #000000; }
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
button.primary { background: #0B0B0B; border-color: #0B0B0B; color: #FFF; font-weight: 600; }
[data-theme="dark"] button.primary { background: var(--yellow); border-color: var(--yellow); color: #0B0B0B; }
input, select, textarea { padding: 10px; border: 1px solid var(--muted); border-radius: 6px; min-height: 44px; background: var(--panel); color: var(--ink); width: 100%; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--soft); }
.band { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; background: var(--yellow); color: #0B0B0B; border: 1px solid #0B0B0B; font-weight: 700; letter-spacing: .01em; padding: 8px 18px; }
.band-title { display: flex; align-items: baseline; gap: 12px; flex: 1; min-width: 0; }
.band-plate { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; height: 44px; background: var(--square); color: #FFF; font-size: 24px; }
[data-theme="dark"] .band { border-bottom: 3px solid #0B0B0B; }
.band .msg { font-weight: 500; color: rgba(11,11,11,.72); }
.banner { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; font-weight: 600; letter-spacing: .04em; padding: 6px 24px; }
.banner .host { font-weight: 400; letter-spacing: .02em; opacity: .85; font-size: 12px; }
.banner.local { background: #2E5E8C; color: #FFF; } .banner.staging { background: #F2C14E; color: #2B2000; } .banner.prod { background: var(--bad); color: #FFF; }
header { background: #0B0B0B; color: #F2F1EA; }
header .row, .page { max-width: 1280px; margin: 0 auto; padding: 10px 24px; display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
.sq.brand-sq { background: var(--yellow); color: #14532D; }
.sq.brand-sq.paused { color: #7F1D1D; }
header .rule { align-self: stretch; width: 1px; background: #4A4E55; }
header .switcher { display: inline-flex; align-items: center; gap: 6px; background: #1C1C19; border: 1px solid #4A4E55; border-radius: 6px; padding: 4px 6px 4px 4px; }
header .role-sq { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: var(--yellow); color: #0B0B0B; flex: none; }
header .switcher select { background: none; border: none; min-height: 40px; color: #F2F1EA; width: auto; }
header button { background: transparent; color: #F2F1EA; border-color: #4A4E55; }
header button.theme { padding: 0; width: 44px; justify-content: center; }
nav { display: flex; align-items: center; }
nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; color: #F2F1EA; text-decoration: none; }
nav a[aria-current="page"] { background: var(--yellow); color: #0B0B0B; font-weight: 700; }
.tufte { display: flex; height: 7px; border: 1px solid var(--hairline); background: var(--panel); }
.tufte-spent { background: var(--ink); }
.tufte-uncertain { background: var(--warn); }
.tufte-scale { display: flex; justify-content: space-between; }
.spark-row { display: flex; gap: 2px; align-items: flex-end; height: 24px; }
.spark { width: 9px; background: var(--hairline); }
.spark.today { background: var(--ink); }
.card.budget { --ink: #E9E7DC; --hairline: #4A4E55; --panel: #17191c; --muted: #A3A298; background: var(--square); border-color: var(--square); color: #E9E7DC; padding: calc(16px * 1.4) calc(18px * 1.4); }
.card.budget.frozen .num { color: var(--bad); }
.card.budget.frozen .tufte-spent { background: var(--bad); }
.card.budget.frozen .spark.today { background: var(--bad); }
.lvtoggle { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; border: 1px solid #4A4E55; border-radius: 4px; background: #17191c; cursor: pointer; font: 700 14px/1 var(--sans); letter-spacing: .04em; color: #E9E7DC; padding: 0 16px; }
.lvtoggle .track { position: relative; flex: none; width: 64px; height: 32px; border-radius: 999px; border: 1px solid #4A4E55; background: #17191c; }
.lvtoggle .knob { display: block; width: 26px; height: 26px; border-radius: 50%; background: #56D364; transform: translateX(0); transition: transform .3s cubic-bezier(.16, 1, .3, 1), background .2s; }
.lvtoggle .state-word { flex: 1; text-align: right; color: #56D364; }
.lvtoggle.frozen { border-color: var(--bad); }
.lvtoggle.frozen .track { background: #3D0E0C; border-color: var(--bad); }
.lvtoggle.frozen .knob { background: #F85149; transform: translateX(32px); }
.lvtoggle.frozen .state-word { color: #F85149; }
@media (prefers-reduced-motion: reduce) { .lvtoggle .knob { transition: none; } }
.spacer { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.frozen { background: var(--bad); color: #FFF; padding: 10px 24px; font-size: 14px; }
.page { padding: 24px; align-items: flex-start; gap: 24px; }
main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
aside { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.section { display: flex; flex-direction: column; gap: 12px; }
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
.sq { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none; background: var(--square); color: #FFF; }
[data-theme="dark"] .sq { outline: 1px solid rgba(255,255,255,.28); }
.sq svg { width: 16px; height: 16px; }
.sq.agent { background: var(--agent); } .sq.you { background: var(--yellow); color: #0B0B0B; outline: 1px solid rgba(11,11,11,.28); } .sq.cli { background: var(--cli); }
.sq.ok { background: var(--ok); } .sq.warn { background: var(--warn); } .sq.bad { background: var(--bad); }
.turn { padding: 0; gap: 0; overflow: hidden; }
/* Event heads are native buttons: reset the base button chrome so the row keeps its look. */
.turn > .head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; min-height: 0; padding: 12px 18px; border: none; border-bottom: 1px solid var(--hairline); border-radius: 0; background: var(--ground); text-align: left; }
.raw-chev { display: inline-flex; color: var(--muted); }
.head[aria-expanded="true"] .raw-chev { transform: rotate(180deg); }
.turn > .body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.small { font-size: 13px; color: var(--muted); }
.head-msg { flex: 1 1 300px; font-size: 15px; color: var(--ink); }
.reply { display: flex; flex-direction: column; gap: 6px; }
.reply-text { flex: 1 1 320px; margin: 0; line-height: 1.35; display: flex; gap: 10px; align-items: flex-start; }
.calls { display: flex; flex-direction: column; gap: 4px; font: 13px ui-monospace, monospace; }
.call { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 6px 10px; border-radius: 2px; background: var(--ground); }
.call.failed, .call.uncertain { background: var(--warn-bg); }
.call .name { flex: 1 1 240px; overflow-wrap: anywhere; }
button.calls-chip { position: relative; min-height: 28px; height: 28px; padding: 0 4px; border: none; background: none; color: var(--cli); font-size: 13px; gap: 6px; }
button.calls-chip::before { content: ""; position: absolute; left: -4px; right: -4px; top: 50%; transform: translateY(-50%); height: 44px; }
.calls-chip .num { color: var(--ink); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; animation: dotpulse 1.6s ease-in-out infinite; }
.dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
@keyframes dotpulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.68); } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.task { display: flex; flex-direction: column; gap: 2px; position: relative; padding: 6px 36px 6px 10px; border: 1px solid var(--hairline); border-radius: 2px; background: var(--panel); color: var(--ink); text-decoration: none; }
.task .go { position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; }
.monu { font-size: clamp(48px, 6vw, 64px); font-weight: 800; letter-spacing: -.02em; }
pre { margin: 0; padding: 10px 12px; border-radius: 2px; background: var(--code-bg); color: var(--code-ink); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.json { position: relative; }
.json pre { padding-right: 104px; min-height: 52px; }
.copy { position: absolute; top: 6px; right: 6px; padding: 0 10px; gap: 6px; font-size: 12px; background: #1C1C19; color: #E9E7DC; border-color: #4A4E55; }
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
if (fromLink) { store.set("token", fromLink[1]); history.replaceState(null, "", location.pathname); }
let token = store.get("token");
const ui = { agent: store.get("agent"), tab: "timeline", open: new Set(), raw: new Set(), draft: "", draftId: null, orderDraft: "", error: "", specDraft: null, reopening: false, focusComposer: true, windowN: 12 };
let list = null, view = null;

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
    el("button", { class: "copy" + (state ? " " + state : ""), type: "button", "aria-label": state ? label : "Copy JSON", onclick: async () => {
      const ok = await copyText(text);
      ui.copied = { key, state: ok ? "done" : "failed" };
      render();
      clearTimeout(ui.copiedTimer);
      ui.copiedTimer = setTimeout(() => { ui.copied = null; render(); }, 1600);
    } }, icon(state === "done" ? DONE_ICON : COPY_ICON), el("span", { text: label })),
    el("span", { class: "sr-only", role: "status", "aria-live": "polite", text: state === "done" ? "JSON copied" : state === "failed" ? "Could not copy JSON" : "" }));
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { token = null; store.drop("token"); render(); throw new Error("The console token was refused. Paste the link pnpm agents printed."); }
  if (!res.ok) { let message = res.statusText; try { message = (await res.json()).error || message; } catch {} const error = new Error(message); error.status = res.status; throw error; }
  return res.status === 204 ? null : res.json();
}
async function act(method, action, body) {
  try { ui.error = ""; await api(method, "/api/agents/" + encodeURIComponent(ui.agent) + "/" + action, body); await refresh(); }
  // A 409 says the operator acted on stale state (the orders changed): show the reason over fresh data.
  catch (error) { ui.error = error.message; if (error.status === 409) await refresh(); else render(); }
}
${LIVE}
// The stream being followed: which agent with which token, whether it is delivering,
// and how to stop it.
let following = { key: null, up: false, stop: () => {} };
async function refresh() {
  try {
    if (token) {
      list = await api("GET", "/api/agents");
      // Fall back to the first agent only when nothing is selected. A selected agent
      // missing from the list is mid save & reopen: keep the selection and say so,
      // or the console would silently switch the operator to another agent.
      if (!ui.agent) ui.agent = list.agents[0] ? list.agents[0].id : null;
      const present = ui.agent !== null && list.agents.some((a) => a.id === ui.agent);
      ui.reopening = ui.agent !== null && !present;
      const key = token && ui.agent ? token + " " + ui.agent : null;
      // The server never re-pushes identical data, so a view GET that resolves after a
      // newer stream push would overwrite it. Fetch the view only when the follower key
      // is new or the stream is known down; while it delivers, its pushes are the truth.
      if (key !== following.key || !following.up) {
        const next = present ? await api("GET", "/api/agents/" + encodeURIComponent(ui.agent)) : null;
        if (following.key !== key || !following.up) view = next;
      }
    }
  } catch (error) { ui.error = error.message; }
  const key = token && ui.agent ? token + " " + ui.agent : null;
  if (key !== following.key) {
    following.stop();
    following = { key, up: false, stop: key ? follow("/api/agents/" + encodeURIComponent(ui.agent) + "/stream", token,
      (next) => { if (following.key !== key) return; view = next; following.up = true; render(); },
      () => { if (following.key !== key) return; following.up = false; refresh(); }) : () => {} };
  }
  render();
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
// Action names read as words, not enum codes.
const VIA = { post_task: "Post Task", escrow_sign: "Escrow Sign", bid_create: "Bid", bid_accept: "Accept Bid", bid_reject: "Reject Bid", task_claim: "Claim", task_submit: "Submit" };
const viaLabel = (via) => VIA[via] || (via || "").replace(/_/g, " ").replace(/^\w| \w/g, (c) => c.toUpperCase());
function taskCard(ref) {
  const { title, summary } = taskSummary(ref.id);
  const href = taskLink(ref.id);
  const inner = [el("span", { class: "small", text: viaLabel(ref.via) + (href ? "" : " · " + ref.id) }), el("strong", { text: title }), summary ? el("span", { class: "small", text: summary }) : null, el("span", { class: "sq go" }, pict("arrow", 13))];
  return href ? el("a", { class: "task", href, target: "_blank", rel: "noopener noreferrer" }, inner) : el("div", { class: "task" }, inner);
}

function header() {
  const op = view ? view.operator : null;
  const waiting = view ? Object.values(view.events).filter((w) => w.kind === "admitted").length + op.messages.length : 0;
  const [envClass, envText] = ENV[list ? list.env : "local"];
  const dark = document.documentElement.dataset.theme === "dark";
  // The brand robot carries the run state; the role square carries what the agent does.
  const ROLE = { poster: "flag", worker: "wrench", both: "both" };
  const me = list && list.agents.find((a) => a.id === ui.agent);
  const roleGlyph = ROLE[me && me.role] || ROLE.poster;
  const roleTitle = me && me.role ? me.role : "agent role";
  return [
    el("div", { class: "banner " + envClass, role: "status" }, el("span", { text: envText }), el("span", { class: "host", text: location.host })),
    el("header", {}, el("div", { class: "row" },
      el("span", { class: "brand" }, el("span", { class: "sq brand-sq" + (op && op.paused ? " paused" : ""), title: op && op.paused ? "Paused · " + waiting + " waiting" : "Running" }, pict("agent", 16)), "Agent console", el("span", { class: "sr-only", role: "status", text: op && op.paused ? "paused · " + waiting + " waiting" : "running" })),
      el("nav", { "aria-label": "Console" },
        el("a", { href: "#", "aria-current": ui.tab === "timeline" ? "page" : null, onclick: (e) => { e.preventDefault(); ui.tab = "timeline"; render(); }, text: "Timeline" }),
        el("a", { href: "#", "aria-current": ui.tab === "briefing" ? "page" : null, onclick: (e) => { e.preventDefault(); ui.tab = "briefing"; render(); }, text: "Briefing" })),
      el("div", { class: "spacer" },
        el("span", { class: "rule" }),
        el("span", { class: "switcher" },
          el("span", { class: "role-sq", title: roleTitle }, pict(roleGlyph, 15)),
          el("select", { "aria-label": "Agent", onchange: (e) => { ui.agent = e.target.value; store.set("agent", ui.agent); ui.open.clear(); ui.raw.clear(); ui.specDraft = null; refresh(); } },
            ui.reopening ? [el("option", { value: ui.agent, selected: true, text: ui.agent + " · reopening…" })] : [],
            (list ? list.agents : []).map((a) => el("option", { value: a.id, selected: a.id === ui.agent, text: a.id + " · " + a.name })))),
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
function draftInto(text) { ui.draft = text; ui.draftId = null; ui.focusComposer = true; render(); }
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

function toggle(set, key) { if (set.has(key)) set.delete(key); else set.add(key); render(); }
// Turn origins as wayfinding pictograms: black squares, except the operator's own yellow.
const TAG = { poll: ["", "clock", "Automatic check-in"], event: ["", "bell", "Marketplace event"], operator: ["you", "person", "You"], resume: ["", "arrow", "Resumed work"], other: ["", "info", "Input"] };
const countOf = (calls, outcome) => calls.filter((c) => c.outcome === outcome).length;
// What a turn's head says: the event and its task, or the input text.
const headText = (turn) => turn.kind === "event" ? ((turn.event && turn.event.event) || "event") + (turn.event && turn.event.task_id ? " · task " + turn.event.task_id : "") : turn.text;
function turnCard(turn, index) {
  const [cls, glyph, origin] = TAG[turn.kind];
  const key = "t" + index;
  const isEvent = turn.kind === "event";
  return el("article", { class: "card turn", "data-i": index },
    el(isEvent ? "button" : "div", { class: "head" + (isEvent ? " raw" : ""), ...(isEvent ? { type: "button", "aria-expanded": String(ui.raw.has(key)), title: "Show the raw event", onclick: () => toggle(ui.raw, key) } : {}) },
      el("span", { class: "sq " + cls }, pict(glyph, 16)),
      el("span", { class: "sr-only", text: origin + ":" }),
      el("span", { class: "small mono", title: turn.at ? new Date(turn.at).toLocaleString() : "", text: rel(turn.at) }),
      el("span", { class: "head-msg", text: headText(turn) }),
      isEvent ? el("span", { class: "raw-chev" }, icon(GLYPH.chevron, 15)) : null),
    ui.raw.has(key) ? el("div", { style: "padding:0 18px 12px" }, jsonBlock("e:" + key, turn.event === undefined ? turn.text : turn.event), el("div", { class: "small", text: "Shown as plain text. HTML in marketplace content is never rendered." })) : null,
    el("div", { class: "body" }, turn.replies.length ? turn.replies.map((reply, r) => replyBlock(reply, key + "r" + r)) : el("div", { class: "small", text: "No reply yet." })));
}
function replyBlock(reply, key) {
  const failed = countOf(reply.calls, "failed");
  const uncertain = countOf(reply.calls, "uncertain");
  return el("div", { class: "reply" },
    el("div", { style: "display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start" },
      reply.text ? el("p", { class: "reply-text" }, el("span", { class: "sq agent" }, pict("agent", 16)), el("span", {}, el("span", { class: "sr-only", text: "Agent: " }), reply.text)) : el("span", { style: "flex:1 1 360px", class: "small", text: reply.calls.length ? "(tool calls only)" : "(empty reply: the model returned no text, possibly an error)" }),
      reply.calls.length ? el("button", { class: "calls-chip", "aria-expanded": String(ui.open.has(key)), "aria-label": reply.calls.length + (reply.calls.length === 1 ? " tool call" : " tool calls") + (failed ? ", " + failed + " failed" : "") + (uncertain ? ", " + uncertain + " uncertain" : ""), onclick: () => toggle(ui.open, key) },
        pict("cli", 13),
        el("span", { class: "num", text: reply.calls.length }),
        failed ? el("span", { class: "dot bad", title: failed + " failed" }) : null,
        uncertain ? el("span", { class: "dot warn", title: uncertain + " uncertain" }) : null) : null),
    ui.open.has(key) ? el("div", { class: "calls" }, reply.calls.map((call) => el("div", { class: "call " + call.outcome },
      el("span", { class: "sq cli", style: "width:20px;height:20px" }, pict("cli", 12)),
      el("span", { class: "name", text: call.name + " " + JSON.stringify(call.arguments) }),
      el("span", { style: "color:" + (call.outcome === "ok" ? "var(--ok)" : "var(--warn)"), text: call.outcome }),
      call.error ? el("div", { style: "flex-basis:100%;white-space:pre-wrap;color:var(--soft)", text: call.error }) : null))) : null,
    reply.tasks.map(taskCard));
}

const smooth = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const lastSaid = (turn) => turn.replies.map((r) => r.text).filter(Boolean).pop() || "";

// The timeline mounts only its newest turns. The rail gives each mounted turn a mark and
// compresses the rest into at most 12, each showing its most telling turn.
const RANK = { bad: 5, warn: 4, operator: 3, event: 2, resume: 2, other: 2, poll: 1 };
function hue(turn) {
  const calls = turn.replies.flatMap((r) => r.calls);
  return countOf(calls, "uncertain") ? "warn" : countOf(calls, "failed") ? "bad" : turn.kind;
}
const rank = (turn) => RANK[hue(turn)];
function timelineTurns() {
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
    return el("button", { class: "tick " + turn.kind + (h === turn.kind ? "" : " " + h), "data-i": i, tabindex: "-1", "aria-current": "false", "aria-label": (where ? where + " · " : "") + who + ", " + rel(turn.at), onclick: () => jumpTo(i), onkeydown },
      el("span", { class: "peek" }, where ? el("span", { class: "small", text: where }) : null, el("span", { class: "small mono", text: who + " · " + rel(turn.at) }), el("span", { class: "peek-text", text: said })));
  };
  return el("div", { class: "railed" },
    el("div", { class: "turns" },
      from ? el("div", { class: "card earlier" }, el("span", { class: "small", text: earlier }),
        el("button", { onclick: () => showFrom(from - 20), text: "Show " + Math.min(20, from) + " more" })) : null,
      tl.slice(from).map((t, k) => turnCard(t, from + k))),
    el("nav", { class: "rail", "aria-label": "Jump to a turn" },
      from ? el("div", { class: "rail-earlier", title: earlier + ", not loaded" }, groups.map(([pick, a, b]) => tick(pick, [a, b]))) : null,
      tl.slice(from).map((t, k) => tick(from + k))));
}
// Mount turns from index i onward, keeping the reader's place.
function showFrom(i) {
  const fromBottom = document.documentElement.scrollHeight - scrollY;
  ui.windowN = view.timeline.length - Math.max(0, i);
  render();
  scrollTo(0, document.documentElement.scrollHeight - fromBottom);
}
function jumpTo(i) {
  // A turn that was not mounted is far away: go there at once rather than glide.
  const far = i < view.timeline.length - ui.windowN;
  if (far) showFrom(i);
  document.querySelector('.turn[data-i="' + i + '"]').scrollIntoView({ block: "start", behavior: far ? "auto" : smooth() });
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
  const turns = [...document.querySelectorAll(".turn[data-i]")];
  if (!turns.length) return document.body.classList.remove("away");
  const at = turns.find((t) => t.getBoundingClientRect().bottom > 120) || turns[turns.length - 1];
  markRail(Number(at.dataset.i));
  document.body.classList.toggle("away", turns[turns.length - 1].getBoundingClientRect().bottom > innerHeight + 120);
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

function timelineTab() {
  const op = view.operator;
  const waiting = Object.values(view.events).filter((w) => w.kind === "admitted").length + op.messages.length;
  const n = view.timeline.length;
  return el("div", { class: "page" },
    el("main", {},
      op.paused ? el("div", { class: "note", role: "status" }, el("strong", { text: "Paused. " }), "New events are still received and stored, so nothing is lost. " + waiting + " waiting; they run in order when you resume. Check-ins are skipped while paused.") : null,
      attention(),
      band("Timeline", n + (n === 1 ? " turn" : " turns") + (n > ui.windowN ? " · showing the newest " + ui.windowN : "")),
      n ? timelineTurns() : el("div", { class: "small", text: "No turns yet." }),
      el("form", { class: "card composer", onsubmit: (e) => {
        e.preventDefault();
        const text = ui.draft.trim();
        if (!text) return;
        ui.draftId = ui.draftId || crypto.randomUUID();
        const sentId = ui.draftId, sentDraft = ui.draft;
        // Clear the box only when nothing new was typed while this send was in flight.
        act("POST", "messages", { requestId: sentId, text }).then(() => { if (!ui.error && ui.draftId === sentId && ui.draft === sentDraft) { ui.draft = ""; ui.draftId = null; render(); } });
      } },
        el("label", {}, el("span", { class: "sr-only", text: "Message " + (view.spec.character.name || "the agent") }),
          el("textarea", { rows: 2, "aria-label": "Message " + (view.spec.character.name || "the agent"), placeholder: 'e.g. "Post one copy-editing job under $15."', oninput: (e) => { ui.draft = e.target.value; ui.draftId = null; }, onkeydown: (e) => {
            if ((e.key === "Enter" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) { e.preventDefault(); e.currentTarget.form.requestSubmit(); }
          }, text: ui.draft })),
        el("div", { class: "samples" }, el("span", { class: "samples-label", text: "Try:" }),
          ["Post a job under $15", "Hold off on new bids today", "Summarize the last check-in"].map((s) =>
            el("button", { type: "button", class: "sample", onclick: () => draftInto(s), text: s }))),
        el("button", { type: "submit", class: "primary send", text: "Send" }),
        el("div", { class: "hint" },
          el("span", {}, el("kbd", { text: "Enter" }), " to send · ", el("kbd", { text: "Shift+Enter" }), " for a new line"),
          el("span", {}, el("kbd", { text: "Ctrl+S" }), " to steer")),
        el("button", { type: "button", class: "sq jump", "aria-label": "Jump to the newest turn", title: "Jump to the newest turn", onclick: () => toNewest(smooth()) }, pict("arrow", 16))),
      el("div", { class: "small send-note", text: "Each send carries its own ID, so a double click or a retry queues it only once." })),
    el("aside", {}, readiness(), tasksPanel(), spendPanel(),
      el("section", { class: "section" },
        band("Standing orders", "· " + op.orders.length),
        el("div", { class: "card" },
          op.orders.map((order) => el("div", { text: order })),
          el("a", { href: "#", style: "display:inline-flex;gap:6px;align-items:center", onclick: (e) => { e.preventDefault(); ui.tab = "briefing"; render(); } }, "Edit in Briefing", pict("arrow", 14))))));
}

function briefingTab() {
  const op = view.operator;
  const draft = ui.specDraft || (ui.specDraft = JSON.parse(JSON.stringify(view.spec)));
  const set = (path, value) => { let at = draft; for (const key of path.slice(0, -1)) at = at[key] = at[key] || {}; at[path[path.length - 1]] = value; render(); };
  const number = (value) => value === "" ? undefined : Number(value);
  const limitText = (value) => value === undefined ? "no limit" : money(value);
  const limitChanges = ["perJobUsd", "dailyUsd"].filter((k) => (view.spec.limits || {})[k] !== (draft.limits || {})[k]);
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
        band("agent.json", "saving reopens only this agent; the others keep running"),
        el("div", { class: "card" },
        el("label", {}, "Goals", el("textarea", { rows: 2, onchange: (e) => set(["character", "goals"], e.target.value), text: draft.character.goals })),
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
          el("button", { class: "primary", onclick: () => { if (draft.limits && Object.values(draft.limits).every((v) => v === undefined)) delete draft.limits; act("PUT", "spec", draft).then(() => { if (!ui.error) ui.specDraft = null; }); }, text: limitChanges.length ? "Confirm, save & reopen" : "Save & reopen" }),
          el("button", { onclick: () => { ui.specDraft = null; render(); }, text: "Discard" })),
        el("div", { class: "small", text: "Checked against the strict agent schema first; nothing is written if it fails. Saving while the agent is mid-turn interrupts it: a write in flight is recorded as uncertain, as after a restart." })))),
    el("aside", {}, el("section", { class: "section" },
      band("What the agent reads every turn"),
      el("div", { class: "card" }, el("pre", { text: view.prompt })))));
}

function unlock() {
  let value = "";
  return el("div", { class: "unlock" },
    el("div", { class: "brand" }, el("span", { class: "sq", style: "background:var(--yellow);color:#0B0B0B" }, pict("agent", 16)), "Agent console"),
    el("h1", { style: "margin:0", text: "Unlock the console" }),
    el("p", { style: "margin:0", text: "When pnpm agents --console starts, it prints a console link with a one-time token. Open that link, or paste the token here." }),
    el("form", { style: "display:flex;flex-direction:column;gap:12px", onsubmit: (e) => { e.preventDefault(); if (/^[0-9a-f]{64}$/.test(value.trim())) { token = value.trim(); store.set("token", token); refresh(); } else { ui.error = "That is not a console token."; render(); } } },
      el("label", {}, "Console token", el("input", { type: "password", autocomplete: "off", oninput: (e) => { value = e.target.value; } })),
      el("button", { type: "submit", class: "primary", style: "align-self:flex-start", text: "Unlock" })),
    ui.error ? el("div", { class: "error", role: "alert", text: ui.error }) : null,
    el("p", { class: "small", text: "Requests without this token, or from a page not served here, are refused. That stops other websites open in your browser from steering the agent or spending money. A new token is issued each time the host starts." }));
}

function render() {
  const activeTag = document.activeElement && document.activeElement.tagName;
  // Briefing fields and inputs keep the old protection: never rebuild under them.
  if ((activeTag === "INPUT" || activeTag === "SELECT") || (activeTag === "TEXTAREA" && ui.tab === "briefing")) return;
  // The composer may be rebuilt while focused: an empty field gets its focus back, a
  // typed draft is only protected while the operator is actually typing in it.
  const taHadFocus = activeTag === "TEXTAREA";
  if (taHadFocus && ui.draft) return;
  if (taHadFocus) ui.focusComposer = true;
  app.replaceChildren(...(!token ? [unlock()] :
    !list || (!view && !ui.reopening) ? [el("div", { class: "unlock", text: ui.error || "Loading…" })] :
    ui.reopening ? [...header(), el("div", { class: "page" },
      el("div", { class: "note", role: "status", text: ui.agent + " is saving and reopening, so it is missing from the agent list for a moment. It stays selected here; its panels return when it reappears." }),
      ui.error ? el("div", { class: "error", role: "alert", text: ui.error }) : null)] :
    [...header(), ui.error ? el("div", { class: "page" }, el("div", { class: "error", role: "alert", text: ui.error })) : null, ui.tab === "timeline" ? timelineTab() : briefingTab()].filter(Boolean)));
  // The timeline opens at its newest turn, as a chat does.
  if (toEnd && view && ui.tab === "timeline") { toEnd = false; toNewest("auto"); }
  measureComposer();
  onScroll();
  const next = document.querySelector("textarea");
  if (ui.focusComposer && next) { next.focus(); ui.focusComposer = false; }
}
refresh();
</script>
</body>
</html>
`;
