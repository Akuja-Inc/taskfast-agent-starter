import { expect, it } from "vitest";
import { LIVE, PAGE } from "../src/console-page.js";

// The page script expects a browser. A tiny fake DOM is enough to boot it and inspect
// the timeline it renders; every node implements only what el() and icon() call.
class FakeNode {
  tagName: string;
  attributes: Record<string, string> = {};
  children: unknown[] = [];
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return key in this.attributes ? this.attributes[key] : null; }
  hasAttribute(key: string) { return key in this.attributes; }
  addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: unknown[]) { this.children.push(...kids); }
  replaceChildren(...kids: unknown[]) { this.children = kids; }
  remove() {}
  cloneNode() {
    const copy = new FakeNode(this.tagName);
    copy.attributes = { ...this.attributes };
    copy.children = this.children.map((kid) => (kid instanceof FakeNode ? kid.cloneNode() : kid));
    return copy;
  }
  set textContent(value: string) { this.children = [value]; }
}

// Boot the page's inline script against the fake DOM and hand back its render functions.
const bootPage = () => {
  const script = PAGE.match(/<script>\n("use strict";[\s\S]*?)<\/script>/)![1];
  const app = new FakeNode("div");
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const fakeDocument = {
    getElementById: () => app,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: () => new FakeNode("svg"),
    activeElement: null,
    body: new FakeNode("body"),
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {} }, scrollHeight: 0 },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const boot = new Function(
    "document", "Node", "sessionStorage", "localStorage", "location", "history",
    "addEventListener", "ResizeObserver", "fetch", "matchMedia",
    `${script}\nreturn { turnCard, ui, viaLabel };`,
  );
  return boot(
    fakeDocument, FakeNode, storage, storage,
    { hash: "", host: "127.0.0.1", pathname: "/" }, { replaceState() {} },
    () => {}, class { observe() {} disconnect() {} },
    () => new Promise(() => {}), () => ({ matches: false }),
  ) as { turnCard: (turn: unknown, index: number) => FakeNode; ui: { raw: Set<string> }; viaLabel: (via: string | undefined) => string };
};

it("renders the event turn head as a native button", () => {
  const { turnCard, ui } = bootPage();
  const card = turnCard({ kind: "event", at: Date.now(), event: { event: "bid_accept", task_id: "t-1" }, replies: [] }, 0);
  const head = card.children[0] as FakeNode;
  expect(head.tagName).toBe("BUTTON");
  expect(head.getAttribute("type")).toBe("button");
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(head.hasAttribute("role")).toBe(false);
  expect(head.hasAttribute("tabindex")).toBe(false);
  expect(head.listeners.keydown ?? []).toHaveLength(0);
  // A native button fires click on Enter and Space by itself, so no keydown shim remains.
  head.listeners.click[0]({});
  expect(ui.raw.has("t0")).toBe(true);
});

it("keeps a non-event turn head as a plain row", () => {
  const { turnCard } = bootPage();
  const card = turnCard({ kind: "operator", at: Date.now(), text: "Hold off on new bids today", replies: [] }, 1);
  const head = card.children[0] as FakeNode;
  expect(head.tagName).toBe("DIV");
  expect(head.hasAttribute("aria-expanded")).toBe(false);
  expect(head.hasAttribute("role")).toBe(false);
  expect(head.hasAttribute("tabindex")).toBe(false);
  expect(head.listeners.click ?? []).toHaveLength(0);
});

// The fallback title-cases any action name, so VIA only keeps the entries whose label
// differs from it. The page script runs inside a TypeScript template literal: a \w that
// loses its escape reaches the browser as a plain w and this test goes red.
it("title-cases any action name with the viaLabel fallback", () => {
  const { viaLabel } = bootPage();
  expect(viaLabel("some_action")).toBe("Some Action");
  // The fallback reproduces these, so they need no VIA entry.
  expect(viaLabel("post_task")).toBe("Post Task");
  expect(viaLabel("escrow_sign")).toBe("Escrow Sign");
  // VIA keeps only the labels shorter than the fallback's.
  expect(viaLabel("bid_create")).toBe("Bid");
  expect(viaLabel("bid_accept")).toBe("Accept Bid");
  expect(viaLabel("bid_reject")).toBe("Reject Bid");
  expect(viaLabel("task_claim")).toBe("Claim");
  expect(viaLabel("task_submit")).toBe("Submit");
  // The tasks panel passes an empty via for its group cards.
  expect(viaLabel("")).toBe("");
  expect(viaLabel(undefined)).toBe("");
});

// A stream body that sends `chunks`, then ends unless `stay` keeps it open.
const body = (chunks: string[], stay = false) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    if (!stay) controller.close();
  },
});
const settle = () => new Promise((done) => setTimeout(done, 10));

it("isolates a viewer error, keeps the stream, and still aborts when stopped", async () => {
  const signals: AbortSignal[] = [];
  let push: ((chunk: string) => void) | undefined;
  const fetch = async (_url: string, init: { signal: AbortSignal }) => {
    signals.push(init.signal);
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk)); } }));
  };
  const noTimer = () => 0;
  const follow = new Function("fetch", "setTimeout", "setInterval", "clearInterval", `${LIVE}\nreturn follow;`)(fetch, noTimer, noTimer, noTimer);
  const views: unknown[] = [];
  let first = true;
  const stop = follow("/s", "t", (view: unknown) => {
    if (first) { first = false; throw new Error("render failed"); }
    views.push(view);
  }, () => {});
  await settle();
  const send = (chunk: string) => push!(chunk);
  send('event: view\ndata: {"n":1}\n\n');
  await settle();
  send('event: view\ndata: {"n":2}\n\n');
  await settle();
  // The first render threw, but the stream survived and the next view still rendered.
  expect(views).toEqual([{ n: 2 }]);
  stop();
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});

it("follows the event stream, polls while it is down, and stops polling when it returns", async () => {
  const requests: { url: string; authorization: string }[] = [];
  const responses = [
    new Response(body(['event: view\ndata: {"n":1}\n\n', ": ping\n\n"])),
    new Response(body(['event: view\ndata: {"n":2}\n\n'], true)),
  ];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, authorization: init.headers.authorization });
    return responses.shift()!;
  };
  const timers: { ms: number; run(): void; cleared?: boolean }[] = [];
  const setTimeout = (run: () => void, ms: number) => { timers.push({ ms, run }); return timers.length - 1; };
  const setInterval = setTimeout;
  const clearInterval = (at: number | null) => { if (at !== null && timers[at]) timers[at].cleared = true; };
  const follow = new Function("fetch", "setTimeout", "setInterval", "clearInterval", `${LIVE}\nreturn follow;`)(fetch, setTimeout, setInterval, clearInterval);

  const views: unknown[] = [];
  let polls = 0;
  const stop = follow("/api/agents/me/stream", "t0k3n", (view: unknown) => views.push(view), () => { polls++; });
  await settle();
  expect(requests).toEqual([{ url: "/api/agents/me/stream", authorization: "Bearer t0k3n" }]);
  expect(views).toEqual([{ n: 1 }]);
  // The stream ended: poll now, then every 3 s, and try the stream again in 5 s. The
  // staleness records stay behind: the test shadows no clearTimeout to retire them.
  expect(polls).toBe(1);
  expect(timers.filter((t) => t.ms !== 45_000).map(({ ms }) => ({ ms }))).toEqual([{ ms: 3000 }, { ms: 5000 }]);

  timers.filter((t) => t.ms !== 45_000)[1].run();
  await settle();
  expect(views).toEqual([{ n: 1 }, { n: 2 }]);
  // The follower took the stream back: the 3 s poll was cleared.
  expect(timers.find((t) => t.ms === 3000)?.cleared).toBe(true);
  stop();
  expect(PAGE).toContain(LIVE);
  // The page inlines this source: a closing script tag would end the script block early.
  expect(LIVE).not.toContain("</script>");
  expect(PAGE).not.toContain("setInterval(refresh");
});

it("keeps historical call dots still and pulses only the newest turn's", () => {
  // The base .dot rule carries no animation, so an idle page with old failures
  // keeps the compositor free.
  const base = /\.dot \{[^}]*\}/.exec(PAGE);
  expect(base).not.toBeNull();
  expect(base![0]).not.toContain("animation");
  // Only the newest turn's dots pulse, and prefers-reduced-motion stills them.
  expect(PAGE).toMatch(/\.dot\.live \{[^}]*animation: dotpulse/);
  expect(PAGE).toMatch(/prefers-reduced-motion: reduce\) \{ \.dot\.live \{ animation: none/);
  // replyBlock gates the live class on the newest turn of the timeline.
  expect(PAGE).toMatch(/replyBlock\(reply, key \+ "r" \+ r, index === view\.timeline\.length - 1\)/);
  expect(PAGE).toMatch(/"dot " \+ cls \+ \(live \? " live" : ""\)/);
});
