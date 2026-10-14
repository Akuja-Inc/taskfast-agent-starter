import { expect, it } from "vitest";
import { LIVE, PAGE } from "../src/console-page.js";

// The page script expects a browser. A tiny fake DOM is enough to boot it and inspect
// the timeline it renders; every node implements only what el() and icon() call.
class FakeNode {
  tagName: string;
  attributes: Record<string, string> = {};
  children: unknown[] = [];
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  parentElement: FakeNode | null = null;
  disabled = false;
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return key in this.attributes ? this.attributes[key] : null; }
  hasAttribute(key: string) { return key in this.attributes; }
  addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: unknown[]) { for (const kid of kids) { if (kid instanceof FakeNode) { kid.remove(); kid.parentElement = this; } this.children.push(kid); } }
  replaceChildren(...kids: unknown[]) { for (const kid of [...this.children]) if (kid instanceof FakeNode) kid.remove(); this.children = []; this.append(...kids); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  insertBefore(node: FakeNode, before: unknown) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child instanceof FakeNode && child.contains(node)); }
  matches(selector: string): boolean {
    const tag = /^[a-z]+/i.exec(selector)?.[0];
    const id = /#([\w-]+)/.exec(selector)?.[1];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.getAttribute('id') === id) && classes.every((cls) => (this.getAttribute('class') || '').split(' ').includes(cls));
  }
  querySelectorAll(selector: string): FakeNode[] {
    const parts = selector.split(' '), last = parts.pop()!;
    return this.children.flatMap((child) => child instanceof FakeNode ? nodes(child) : []).filter((node) => node.matches(last) && (!parts.length || !!node.parentElement?.closest(parts.join(' '))));
  }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): FakeNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focusCalls: ({ preventScroll?: boolean } | null)[] = [];
  focus(options?: { preventScroll?: boolean }) { this.focusCalls.push(options ?? null); }
  scrollIntoView() {}
  cloneNode() {
    const copy = new FakeNode(this.tagName);
    copy.attributes = { ...this.attributes };
    copy.children = this.children.map((kid) => (kid instanceof FakeNode ? kid.cloneNode() : kid));
    return copy;
  }
  set textContent(value: string) { this.children = [value]; }
  get textContent(): string { return this.children.map((child) => child instanceof FakeNode ? child.textContent : String(child)).join(''); }
}

// Boot the page's inline script against the fake DOM and hand back its render functions.
const bootPage = (fetch: (path?: unknown, init?: unknown) => Promise<unknown> = () => new Promise<never>(() => {})) => {
  const script = PAGE.match(/<script>\n("use strict";[\s\S]*?)<\/script>/)![1];
  const app = new FakeNode("div");
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const fakeDocument = {
    getElementById: () => app,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: () => new FakeNode("svg"),
    activeElement: null as FakeNode | null,
    body: new FakeNode("body"),
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {} }, scrollHeight: 0 },
    querySelector: (selector: string) => app.querySelector(selector),
    querySelectorAll: (selector: string) => selector === '.turn[data-i]' ? [] : app.querySelectorAll(selector),
  };
  const boot = new Function(
    "document", "Node", "sessionStorage", "localStorage", "location", "history",
    "addEventListener", "ResizeObserver", "fetch", "matchMedia",
    `${script}\nreturn { header, turnCard, timelineTab, render, ui, document, app, unlock, submitMessage, promoteMessage, viaLabel, setView(next) { token = 'test'; ui.agent = 'shop'; list = { env: 'local', agents: [{ id: 'shop', name: 'Demo', role: 'poster' }] }; view = next; following.key = 'test shop'; following.up = true; } };`,
  );
  return boot(
    fakeDocument, FakeNode, storage, storage,
    { hash: "", host: "127.0.0.1", pathname: "/" }, { replaceState() {} },
    () => {}, class { observe() {} disconnect() {} },
    fetch, () => ({ matches: false }),
  ) as { header: () => FakeNode[]; turnCard: (turn: unknown, index: number) => FakeNode; timelineTab: () => FakeNode; render: () => void; document: typeof fakeDocument; app: FakeNode; unlock: () => FakeNode; submitMessage: (mode: string) => Promise<void>; promoteMessage: (id: string, agent: string) => Promise<void>; setView: (view: unknown) => void; ui: { raw: Set<string>; draft: string; tab: string; focusComposer: boolean }; viaLabel: (via: string | undefined) => string };
};

const nodes = (root: FakeNode): FakeNode[] => [root, ...root.children.flatMap((child) => child instanceof FakeNode ? nodes(child) : [])];
const demoView = () => ({
  operator: { paused: true, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline: [], actions: {}, spend: {}, notes: [],
  spec: { model: 'faux:test', character: { name: 'Demo' }, limits: { dailyUsd: 50 } },
});

it("Ctrl+S admits a steer and prevents Save Page rather than sending a follow-up", () => {
  const requests: { path: string; body: string }[] = [];
  const page = bootPage((path?: unknown, init?: unknown) => {
    requests.push({ path: String(path), body: (init as { body: string }).body });
    return new Promise<never>(() => {});
  });
  page.setView(demoView());
  page.ui.draft = 'Hold off on bids';
  const form = nodes(page.timelineTab()).find((node) => node.tagName === 'FORM')!;
  const textarea = nodes(form).find((node) => node.tagName === 'TEXTAREA')!;
  let prevented = false;
  textarea.listeners.keydown[0]({ key: 's', ctrlKey: true, preventDefault() { prevented = true; }, currentTarget: { form: { requestSubmit() { form.listeners.submit[0]({ preventDefault() {} }); } } } });
  expect(prevented).toBe(true);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].body)).toMatchObject({ text: 'Hold off on bids', steer: true });
});

it("keeps one in-flight admission and its initial mode when the operator changes send keys", () => {
  const requests: unknown[] = [];
  const page = bootPage((_path?: unknown, init?: unknown) => {
    requests.push(JSON.parse((init as { body: string }).body));
    return new Promise<never>(() => {});
  });
  page.setView(demoView());
  page.ui.draft = 'Same draft';
  const form = nodes(page.timelineTab()).find((node) => node.tagName === 'FORM')!;
  const textarea = nodes(form).find((node) => node.tagName === 'TEXTAREA')!;
  form.listeners.submit[0]({ preventDefault() {} });
  textarea.listeners.keydown[0]({ key: 's', metaKey: true, preventDefault() {} });
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty('steer');
});

it("shows the oldest-first mixed queue outside the sticky composer, with Steer only on follow-ups", () => {
  const page = bootPage();
  page.setView({ ...demoView(), queuedMessages: [
    { requestId: 'first', text: '<img src=x onerror=alert(1)>', mode: 'followUp' },
    { requestId: 'second', text: 'Go next', mode: 'steer' },
  ] });
  const tab = page.timelineTab();
  const all = nodes(tab);
  const queue = all.find((node) => node.getAttribute('id') === 'queued-messages');
  expect(queue).toBeDefined();
  expect(nodes(queue!).filter((node) => node.tagName === 'BUTTON')).toHaveLength(1);
  expect(nodes(queue!).filter((node) => node.getAttribute('class') === 'queue-text').map((node) => node.children)).toEqual([
    ['<img src=x onerror=alert(1)>'], ['Go next'],
  ]);
  expect(nodes(all.find((node) => node.tagName === 'FORM')!).includes(queue!)).toBe(false);
});

it("counts operator messages already in Pi's inbox in the paused waiting summary", () => {
  const page = bootPage();
  page.setView({ ...demoView(), events: { event: { kind: 'admitted' } }, queuedMessages: [
    { requestId: 'first', text: 'Queued follow-up', mode: 'followUp' },
    { requestId: 'second', text: 'Queued steer', mode: 'steer' },
  ] });
  expect(nodes(page.timelineTab()).find((node) => node.getAttribute('class') === 'note')?.textContent).toContain('3 waiting');
});

it("retains a failed send's ID and mode across retry keys, but edits create a new identity", async () => {
  const requests: { requestId: string; text: string; steer?: boolean }[] = [];
  const page = bootPage((_path, init) => { requests.push(JSON.parse((init as { body: string }).body)); return Promise.reject(new Error('offline')); });
  page.setView(demoView()); page.ui.draft = 'Original';
  await page.submitMessage('steer'); await page.submitMessage('followUp');
  expect(requests[1]).toEqual(requests[0]); expect(requests[0].steer).toBe(true);
  nodes(page.timelineTab()).find((node) => node.tagName === 'TEXTAREA')!.listeners.input[0]({ target: { value: 'Edited' } });
  await page.submitMessage('followUp');
  expect(requests[2].requestId).not.toBe(requests[0].requestId); expect(requests[2]).not.toHaveProperty('steer'); expect(page.ui.draft).toBe('Edited');
});

it("Enter and Send follow up, while Shift+Enter and IME Enter do not submit", () => {
  const requests: unknown[] = [];
  const page = bootPage((_path, init) => { requests.push(JSON.parse((init as { body: string }).body)); return new Promise<never>(() => {}); });
  page.setView(demoView()); page.ui.draft = 'Follow up';
  const form = nodes(page.timelineTab()).find((node) => node.tagName === 'FORM')!;
  const textarea = nodes(form).find((node) => node.tagName === 'TEXTAREA')!;
  const key = (extra: object) => textarea.listeners.keydown[0]({ key: 'Enter', preventDefault() {}, currentTarget: { form: { requestSubmit() { form.listeners.submit[0]({ preventDefault() {} }); } } }, ...extra });
  key({ shiftKey: true }); key({ isComposing: true }); expect(requests).toHaveLength(0);
  key({}); form.listeners.submit[0]({ preventDefault() {} });
  expect(requests).toHaveLength(1); expect(requests[0]).not.toHaveProperty('steer');
});

it("updates queues while typing without replacing the textarea or stable queue controls", () => {
  const page = bootPage(), followUp = { requestId: 'first', text: 'Oldest', mode: 'followUp' };
  page.setView({ ...demoView(), queuedMessages: [followUp] }); page.render();
  const textarea = page.app.querySelector('textarea')!, originalButton = page.app.querySelector('.queue-promote');
  page.document.activeElement = textarea; page.ui.draft = 'Typing a new draft'; textarea.value = page.ui.draft; textarea.selectionStart = 4; textarea.selectionEnd = 9;
  page.setView({ ...demoView(), queuedMessages: [followUp, { requestId: 'second', text: 'New steer', mode: 'steer' }] }); page.render();
  expect(page.app.querySelectorAll('.queue-row')).toHaveLength(2); expect(page.app.querySelector('.queue-promote')).toBe(originalButton);
  expect(page.app.querySelector('textarea')).toBe(textarea); expect(page.document.activeElement).toBe(textarea);
  expect([textarea.value, textarea.selectionStart, textarea.selectionEnd]).toEqual(['Typing a new draft', 4, 9]);
  page.setView(demoView()); page.render(); expect(page.app.querySelectorAll('.queue-row')).toHaveLength(0);
  expect(page.app.querySelector('.queue-empty')?.textContent).toBe('No queued messages.');
});

it("serializes paused promotion and reports placement and stale-row races as notices", async () => {
  for (const status of [409, 404]) {
    const requests: string[] = []; let resolve!: (response: Response) => void;
    const page = bootPage((path, init) => {
      if ((init as { method: string }).method === 'POST') { requests.push(String(path)); return new Promise<Response>((done) => { resolve = done; }); }
      return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
    });
    page.setView({ ...demoView(), queuedMessages: [{ requestId: 'stable/id', text: 'Visible', mode: 'followUp' }] }); page.render(); page.ui.draft = 'Unrelated draft';
    const first = page.promoteMessage('stable/id', 'shop'), second = page.promoteMessage('stable/id', 'shop');
    expect(requests).toEqual(['/api/agents/shop/steer/stable%2Fid']); expect(page.app.querySelector('.queue-promote')?.disabled).toBe(true);
    resolve(new Response(JSON.stringify({ error: status === 409 ? 'The agent already has this message.' : 'Unknown message' }), { status })); await Promise.all([first, second]);
    expect(page.app.querySelector('.queue-notice')?.textContent).toBe('The agent already has this message.');
    expect(page.app.querySelector('.message-status')?.textContent).toBe(''); expect(page.ui.draft).toBe('Unrelated draft');
  }
});

it("keeps failed promotions retryable without marking the draft send failed", async () => {
  let posts = 0;
  const page = bootPage((_path, init) => { if ((init as { method: string }).method === 'POST') { posts++; return Promise.reject(new Error('offline')); } return new Promise<never>(() => {}); });
  page.setView({ ...demoView(), queuedMessages: [{ requestId: 'first', text: 'Visible', mode: 'followUp' }] }); page.render();
  await page.promoteMessage('first', 'shop'); expect(page.app.querySelector('.queue-error')?.textContent).toContain('Could not steer this message. Try again.');
  expect(page.app.querySelector('.queue-promote')?.disabled).toBe(false); expect(page.app.querySelector('.message-status')?.textContent).toBe('');
  await page.promoteMessage('first', 'shop'); expect(posts).toBe(2);
});

it("clears only the admitted draft after 204 and keeps a newer edit intact", async () => {
  let finish!: (response: Response) => void;
  const page = bootPage((_path, init) => (init as { method: string }).method === 'POST'
    ? new Promise<Response>((resolve) => { finish = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] }))));
  page.setView(demoView()); page.render();
  const textarea = page.app.querySelector('textarea')!;
  page.document.activeElement = textarea; page.ui.draft = 'First'; textarea.value = 'First';
  const first = page.submitMessage('followUp');
  textarea.listeners.input[0]({ target: { value: 'Newer edit' } }); textarea.value = 'Newer edit';
  finish(new Response(null, { status: 204 })); await first;
  expect(page.ui.draft).toBe('Newer edit'); expect(textarea.value).toBe('Newer edit');
  const next = page.submitMessage('steer'); finish(new Response(null, { status: 204 })); await next;
  expect(page.ui.draft).toBe(''); expect(textarea.value).toBe('');
});

it("does not freeze non-queue live updates when the focused composer has no draft", () => {
  const page = bootPage(); page.setView(demoView()); page.render();
  page.document.activeElement = page.app.querySelector('textarea');
  expect(page.app.querySelector('.note')?.textContent).toContain('Paused.');
  page.setView({ ...demoView(), operator: { paused: false, frozen: false, messages: [], orders: [] } }); page.render();
  expect(page.app.querySelector('.note')).toBeNull();
});

// gh#30: a rebuild that only hands the composer its focus back must not scroll the
// page, so an operator reading the timeline keeps their place on every stream push.
it("gives the composer its focus back without scrolling on a rebuild", () => {
  const page = bootPage();
  page.setView(demoView());
  page.render();
  page.document.activeElement = page.app.querySelector('form.composer textarea');
  page.setView(demoView());
  page.render();
  const next = page.app.querySelector('form.composer textarea')!;
  expect(next).not.toBe(page.document.activeElement);
  expect(next.focusCalls).toEqual([{ preventScroll: true }]);
});

// A deliberate ask for the composer (the sample prompts and the Fix this buttons go
// through draftInto) still scrolls it into view.
it("scrolls the composer into view when a sample prompt drafts a message", () => {
  const page = bootPage();
  page.setView(demoView());
  page.render();
  page.app.querySelectorAll('.sample')[0].listeners.click[0]({});
  expect(page.ui.draft).toBe('Post a job under $15');
  expect(page.app.querySelector('form.composer textarea')!.focusCalls).toEqual([{ preventScroll: false }]);
});

// gh#30: a bare "textarea" query lands on the Briefing tab's Goals field, so a pending
// composer focus must wait for the timeline's composer instead.
it("keeps a pending composer focus away from the Briefing tab's Goals field", () => {
  const page = bootPage();
  page.setView({ ...demoView(), prompt: 'You are Demo.', spec: { model: 'faux:test', character: { name: 'Demo', goals: 'Win copy-editing jobs' }, dials: { temperament: 'patient', competence: 0.5, diligence: 0.5, priceSensitivity: 0.5 }, limits: { dailyUsd: 50 } } });
  page.render();
  page.ui.focusComposer = true;
  page.ui.tab = 'briefing';
  page.render();
  expect(page.app.querySelector('textarea')!.focusCalls).toEqual([]);
  page.ui.tab = 'timeline';
  page.render();
  expect(page.app.querySelector('form.composer textarea')!.focusCalls).toEqual([{ preventScroll: true }]);
});

it("pins queue prose below its mode even without a promotion button", () => {
  expect(PAGE).toContain('.queue-mode, .queue-text { grid-column: 1; }');
});

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

// Every yellow square is the shared .sq.you: no hand copies of its look.
it("renders the header role square with the shared .sq.you classes", () => {
  const { header } = bootPage();
  const row = header()[1].children[0] as FakeNode;
  const spacer = row.children[2] as FakeNode;
  const switcher = spacer.children[1] as FakeNode;
  const roleSq = switcher.children[0] as FakeNode;
  expect(roleSq.getAttribute("class")).toBe("sq you");
  expect(roleSq.hasAttribute("style")).toBe(false);
});

it("renders the unlock brand square with the shared .sq.you classes", () => {
  const { unlock } = bootPage();
  const brand = unlock().children[0] as FakeNode;
  const square = brand.children[0] as FakeNode;
  expect(square.getAttribute("class")).toBe("sq you");
  expect(square.hasAttribute("style")).toBe(false);
});

it("has no hand-copied role-sq rule left in the page", () => {
  expect(PAGE).not.toContain("role-sq");
});
