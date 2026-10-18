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
  setAttribute(key: string, value: string) { this.attributes[key] = value; if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value; }
  get open() { return this.hasAttribute('open'); }
  set open(value: boolean) { if (value) this.attributes.open = ''; else delete this.attributes.open; }
  rect = { top: 150, bottom: 250 };
  getBoundingClientRect() { return this.rect; }
  getClientRects() {
    let child: FakeNode = this;
    for (let parent = this.parentElement; parent; child = parent, parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !parent.open && child.tagName !== 'SUMMARY') return [];
    }
    return [this.rect];
  }
  getAttribute(key: string) { return key in this.attributes ? this.attributes[key] : null; }
  hasAttribute(key: string) { return key in this.attributes; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value: boolean) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; }
  addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: unknown[]) { for (const kid of kids) { if (kid instanceof FakeNode) { kid.remove(); kid.parentElement = this; } this.children.push(kid); } }
  replaceChildren(...kids: unknown[]) { for (const kid of [...this.children]) if (kid instanceof FakeNode) kid.remove(); this.children = []; this.append(...kids); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  insertBefore(node: FakeNode, before: unknown) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child instanceof FakeNode && child.contains(node)); }
  matches(selector: string): boolean {
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    const base = selector.replace(/\[[^\]]*\]/g, '');
    const tag = /^[a-z]+/i.exec(base)?.[0];
    const id = /#([\w-]+)/.exec(base)?.[1];
    const classes = [...base.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.getAttribute('id') === id) && classes.every((cls) => (this.getAttribute('class') || '').split(' ').includes(cls)) && attrs.every(([, name, value]) => value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
  }
  querySelectorAll(selector: string): FakeNode[] {
    if (selector.includes(', ')) return selector.split(', ').flatMap((part) => this.querySelectorAll(part));
    const parts = selector.match(/(?:\[[^\]]*\]|[^\s])+/g) || [], last = parts.pop()!;
    return this.children.flatMap((child) => child instanceof FakeNode ? nodes(child) : []).filter((node) => node.matches(last) && (!parts.length || !!node.parentElement?.closest(parts.join(' '))));
  }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): FakeNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focusCalls: ({ preventScroll?: boolean } | null)[] = [];
  onFocus?: () => void;
  focus(options?: { preventScroll?: boolean }) { this.focusCalls.push(options ?? null); this.onFocus?.(); }
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
const bootPage = (fetch: (path?: unknown, init?: unknown) => Promise<unknown> = () => new Promise<never>(() => {}), url = "/", saved: Record<string, string> = {}) => {
  const script = PAGE.match(/<script>\n("use strict";[\s\S]*?)<\/script>/)![1];
  const app = new FakeNode("div");
  const values = new Map(Object.entries(saved));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const location = new URL(url, "http://127.0.0.1");
  const events = new Map<string, (event: unknown) => void>();
  const entries: { url: string; state: unknown }[] = [{ url: location.href, state: null }];
  let position = 0;
  const history = {
    replaceState(state: unknown, _unused: string, url: string) { location.href = new URL(url, location).href; entries[position] = { url: location.href, state }; },
    pushState(state: unknown, _unused: string, url: string) { location.href = new URL(url, location).href; entries.splice(++position, entries.length, { url: location.href, state }); },
    go(delta: number) { const next = position + delta; if (next < 0 || next >= entries.length) return; position = next; location.href = entries[position].url; events.get("popstate")?.({ state: entries[position].state }); },
    back() { this.go(-1); }, forward() { this.go(1); }, get length() { return entries.length; },
  };
  let discard = true;
  const fakeDocument = {
    getElementById: () => app,
    createElement: (tag: string) => { const node = new FakeNode(tag); node.onFocus = () => { fakeDocument.activeElement = node; }; return node; },
    createElementNS: () => new FakeNode("svg"),
    activeElement: null as FakeNode | null,
    scrollMoves: [] as number[],
    body: new FakeNode("body"),
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {} }, scrollHeight: 0 },
    querySelector: (selector: string) => app.querySelector(selector),
    querySelectorAll: (selector: string) => app.querySelectorAll(selector),
  };
  const boot = new Function(
    "document", "Node", "sessionStorage", "localStorage", "location", "history",
    "addEventListener", "ResizeObserver", "fetch", "matchMedia", "setInterval", "confirm", "innerHeight", "scrollY", "scrollBy",
    `${script}\nreturn { header, turnCard, replyBlock, lastSaid, timelineTab, showFrom, jumpTo, onScroll, render, refresh, selectAgent, selectTab, destination, navigate, capabilities, location, history, setDiscard(value) { confirm = () => value; }, acceptView(next) { view = next; render(); }, startupAction, ui, document, app, unlock, submitMessage, promoteMessage, withdrawMessage, viaLabel, setRoster(entries) { token = 'test'; list = { env: 'local', agents: entries }; if (!ui.agent) ui.agent = entries[0]?.id; syncSelection(); render(); }, setView(next) { token = 'test'; ui.agent = 'shop'; list = { env: 'local', agents: [{ id: 'shop', name: 'Demo', role: 'poster' }] }; view = next; following.key = 'test shop 0'; following.up = true; } };`,
  );
  return boot(
    fakeDocument, FakeNode, storage, storage,
    location, history,
    (name: string, listener: (event: unknown) => void) => { events.set(name, listener); }, class { observe() {} disconnect() {} },
    fetch, () => ({ matches: false }), () => 0, () => discard, 800, 0, (_x: number, y: number) => { fakeDocument.scrollMoves.push(y); },
  ) as { showFrom: (i: number) => void; jumpTo: (i: number) => void; onScroll: () => void; location: URL; history: typeof history; selectTab: (tab: string) => void; setDiscard: (value: boolean) => void; acceptView: (view: unknown) => void; refresh: () => Promise<void>; selectAgent: (id: string) => void; startupAction: (action: string) => Promise<void>; setRoster: (entries: unknown[]) => void; header: () => FakeNode[]; turnCard: (turn: unknown, index: number) => FakeNode; replyBlock: (reply: unknown, key: string, live: boolean) => FakeNode; lastSaid: (turn: unknown) => string; timelineTab: () => FakeNode; render: () => void; document: typeof fakeDocument; app: FakeNode; unlock: () => FakeNode; submitMessage: (mode: string) => Promise<void>; promoteMessage: (id: string, agent: string) => Promise<void>; withdrawMessage: (id: string, agent: string) => Promise<void>; setView: (view: unknown) => void; ui: { raw: Set<string>; open: Set<string>; folds: Set<string>; checks: Set<string>; draft: string; tab: string; agent: string; capability: { screen: string; item: string; step: number }; specDraft: unknown; windowN: number; focusComposer: boolean }; viaLabel: (via: string | undefined) => string };
};

const nodes = (root: FakeNode): FakeNode[] => [root, ...root.children.flatMap((child) => child instanceof FakeNode ? nodes(child) : [])];
const demoView = () => ({
  operator: { paused: true, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline: [], actions: {}, spend: {}, notes: [],
  spec: { role: 'poster', model: 'faux:test', instructions: 'You are Demo.', dials: { competence: 0.9, diligence: 0.9, priceSensitivity: 0.5, temperament: 'patient' }, limits: { dailyUsd: 50 } },
});

it("restores destination through token extraction and authentication without leaking it into navigation links", () => {
  const page = bootPage(undefined, '/agents/shop?tab=briefing#token=' + 'a'.repeat(64));
  expect(page.location.hash).toBe('');
  expect(page.location.pathname + page.location.search).toBe('/agents/shop?tab=briefing');
  expect(page.ui.agent).toBe('shop');
  expect(page.ui.tab).toBe('briefing');
  expect(page.history.length).toBe(1);
  const links = page.header().flatMap((node) => node ? nodes(node) : []).filter((node) => node.tagName === 'A');
  expect(links.every((link) => !link.getAttribute('href')?.includes('token'))).toBe(true);
  const locked = bootPage(undefined, '/agents/shop?tab=briefing');
  expect(locked.app.textContent).toContain('Unlock the console');
  expect(locked.location.search).toBe('?tab=briefing');
});

it("tracks every panel toggle, page and agent switch in browser history", () => {
  const page = bootPage(); page.setView(demoView()); page.render();
  const roster = [{ id: 'shop', state: 'ready' }, { id: 'other', state: 'starting' }];
  page.setRoster(roster);
  const turn = { id: 'stable-turn', kind: 'event', at: 123, text: 'Event', event: { event: 'task.ready' }, replies: [{ text: 'Reading', calls: [{ id: 'call-1', name: 'task_get', arguments: {}, outcome: 'pending' }], tasks: [] }] };
  const click = (root: FakeNode, cls: string) => nodes(root).find((node) => node.getAttribute('class')?.split(' ').includes(cls))!.listeners.click[0]({});
  page.acceptView({ ...demoView(), timeline: [turn] });
  click(page.app, 'calls-chip');
  expect(page.location.search).toBe('?open=stable-turn%3Acall-1');
  click(page.app, 'raw');
  expect(page.ui.raw.has('stable-turn')).toBe(true);
  expect(page.history.length).toBe(3);
  page.selectTab('briefing');
  expect(page.location.search).toContain('tab=briefing');
  page.selectAgent('other');
  expect(page.location.pathname).toBe('/agents/other');
  page.history.back();
  expect(page.location.pathname).toBe('/agents/shop');
  expect(page.ui.open.has('stable-turn:call-1')).toBe(true);
  page.history.back();
  expect(page.ui.tab).toBe('timeline');
  page.history.back();
  expect(page.ui.raw.size).toBe(0);
  expect(page.ui.open.size).toBe(1);
  page.history.back();
  expect(page.ui.open.size).toBe(0);
  page.history.forward();
  expect(page.ui.open.has('stable-turn:call-1')).toBe(true);
});

it("routes the Standing orders Briefing link through browser history", () => {
  const page = bootPage(); page.setView(demoView()); page.render();
  const link = nodes(page.app).find((node) => node.tagName === 'A' && node.textContent.includes('Edit in Briefing'))!;
  expect(link.getAttribute('href')).toBe('/agents/shop?tab=briefing');
  link.listeners.click[0]({ preventDefault() {} });
  expect(page.ui.tab).toBe('briefing');
  expect(page.location.search).toBe('?tab=briefing');
  expect(page.history.length).toBe(2);
  page.history.back();
  expect(page.ui.tab).toBe('timeline');
});

it("cancels configuration navigation and history traversal without changing URL, draft or screen", () => {
  const page = bootPage(); page.setView(demoView()); page.render();
  page.selectTab('briefing');
  const url = page.location.href;
  page.ui.specDraft = { ...demoView().spec, instructions: 'Unsaved instructions' };
  page.setDiscard(false);
  page.selectAgent('other');
  expect(page.location.href).toBe(url);
  expect(page.ui.agent).toBe('shop');
  page.history.back();
  expect(page.location.href).toBe(url);
  expect(page.ui.tab).toBe('briefing');
  expect(page.ui.specDraft).toMatchObject({ instructions: 'Unsaved instructions' });
  page.setDiscard(true);
  page.history.back();
  expect(page.ui.tab).toBe('timeline');
  expect(page.ui.specDraft).toBeNull();
});

it("restores every panel and mounts older referenced turns without trusting visible row positions", () => {
  const page = bootPage(undefined, '/agents/shop?open=old%3Acall&raw=old', { token: 'test' });
  const timeline = Array.from({ length: 30 }, (_, i) => ({ id: i ? 'turn-' + i : 'old', kind: 'event', at: i, text: 'Event ' + i, event: { event: 'event-' + i }, replies: [{ text: 'Reply', calls: [{ id: i ? 'call-' + i : 'call', name: 'me', arguments: {}, outcome: 'ok' }], tasks: [] }] }));
  page.setRoster([{ id: 'shop', state: 'ready' }]);
  page.acceptView({ ...demoView(), timeline });
  expect(page.ui.windowN).toBe(30);
  expect(page.app.textContent).toContain('event-0');
  expect(page.app.querySelector('.calls')).not.toBeNull();
  const url = page.location.href;
  page.acceptView({ ...demoView(), timeline: timeline.slice(1) });
  expect(page.app.textContent).toContain('Destination unavailable');
  expect(page.app.querySelector('.calls')).toBeNull();
  expect(page.location.href).toBe(url);
});

it("retains a linked action while its agent starts and resolves it when ready", () => {
  const page = bootPage(undefined, '/agents/shop?open=stable%3Acall', { token: 'test' });
  page.setRoster([{ id: 'shop', state: 'starting', phase: 'opening', generation: 1 }]);
  expect(page.app.textContent).toContain('Starting agent');
  expect(page.location.search).toBe('?open=stable%3Acall');
  page.setRoster([{ id: 'shop', state: 'ready', generation: 1 }]);
  page.acceptView({ ...demoView(), timeline: [{ id: 'stable', kind: 'poll', at: 1, text: 'Check', replies: [{ text: 'Read', calls: [{ id: 'call', name: 'me', arguments: {}, outcome: 'ok' }], tasks: [] }] }] });
  expect(page.app.querySelector('.calls')).not.toBeNull();
  expect(page.location.search).toBe('?open=stable%3Acall');
});

it("refuses ambiguous linked panels instead of opening a different action", () => {
  const page = bootPage(undefined, '/agents/shop?open=same%3Acall', { token: 'test' });
  const turn = { id: 'same', kind: 'poll', at: 1, text: 'Check', replies: [{ text: 'Read', calls: [{ id: 'call', name: 'me', arguments: {}, outcome: 'ok' }], tasks: [] }] };
  page.setRoster([{ id: 'shop', state: 'ready' }]);
  page.acceptView({ ...demoView(), timeline: [turn, structuredClone(turn)] });
  expect(page.app.textContent).toContain('Destination unavailable');
  expect(page.app.querySelector('.calls')).toBeNull();
  expect(page.location.search).toBe('?open=same%3Acall');
});

it("keeps malformed destinations explicit and never selects a different page", () => {
  const page = bootPage(undefined, '/agents/shop?tab=invalid', { token: 'test' });
  page.setRoster([{ id: 'shop', state: 'ready' }]); page.acceptView(demoView());
  expect(page.app.textContent).toContain('Destination unavailable');
  expect(page.location.search).toBe('?tab=invalid');
  page.selectTab('timeline');
  expect(page.location.pathname + page.location.search).toBe('/agents/shop');
});

const pollingHistory = (count: number) => Array.from({ length: count }, (_, i) => ({
  kind: 'poll', complete: true, at: 1_750_000_000_000 + i * 900_000, text: 'Check your marketplace work',
  replies: [{ text: '', tasks: [], calls: [{ id: 'read-' + i, name: 'task_list', arguments: { kind: 'open' }, outcome: 'ok', comparable: true, result: '{"tasks":[],"note":"<script>unsafe</script>"}' }] }, { text: 'No action <img src=x>.', tasks: [], calls: [] }],
}));
const openDetails = (details: FakeNode, open = true) => { details.open = open; details.listeners.toggle[0]({ target: details }); };

it("reveals a linked tool panel inside a folded check without forcing a user-closed group open on live refresh", () => {
  const page = bootPage(undefined, '/agents/shop?open=folded-2%3Aread-2', { token: 'test' });
  const timeline = pollingHistory(4).map((turn, i) => ({ ...turn, id: 'folded-' + i }));
  page.setRoster([{ id: 'shop', state: 'ready' }]);
  page.acceptView({ ...demoView(), timeline });
  const turn = page.app.querySelector('.turn[data-i="2"]')!;
  expect(turn.closest('.poll-run')!.open).toBe(true);
  expect(turn.closest('.poll-check')!.open).toBe(true);
  expect(turn.querySelector('.calls')!.getClientRects()).toHaveLength(1);
  openDetails(turn.closest('.poll-run')!, false);
  page.acceptView({ ...demoView(), timeline: structuredClone(timeline) });
  expect(page.app.querySelector('.poll-run')!.open).toBe(false);
  expect(page.location.search).toBe('?open=folded-2%3Aread-2');
});

it("folds checks into a native disclosure with original counts, checked scope and safe results", () => {
  const page = bootPage();
  const timeline = pollingHistory(4), original = structuredClone(timeline);
  page.setView({ ...demoView(), timeline }); page.render();
  const group = page.app.querySelector('details.poll-run')!;
  expect(group).not.toBeNull();
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')!.textContent).toContain('No changes3 checks');
  expect(group.querySelector('summary')!.textContent).toContain('Task lists');
  expect(group.querySelector('summary')!.textContent).toContain('Last checked');
  expect(page.app.textContent).toContain('4 turns · 4 loaded · 1 unchanged group');
  expect(page.app.querySelectorAll('.tick')).toHaveLength(4);
  openDetails(group);
  const check = group.querySelector('details.poll-check')!; openDetails(check);
  const calls = check.querySelector('.calls-chip')!; calls.focus(); calls.listeners.click[0]({});
  expect(page.app.textContent).toContain('No action <img src=x>.');
  expect(page.app.textContent).toContain('"note": "<script>unsafe</script>"');
  expect(page.document.activeElement?.getAttribute('data-focus')).toBe(calls.getAttribute('data-focus'));
  expect(page.document.activeElement).not.toBe(calls);
  expect(page.document.activeElement?.focusCalls.at(-1)).toEqual({ preventScroll: true });
  expect(page.app.querySelector('img')).toBeNull(); expect(page.app.querySelector('script')).toBeNull();
  expect(timeline).toEqual(original);
});

it("clips folds to mounted originals, uses singular checks and preserves group state when loading earlier", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(20) }); page.render();
  const group = page.app.querySelector('details.poll-run')!;
  expect(group.querySelector('summary')!.textContent).toContain('12 checks');
  expect(group.querySelectorAll('.poll-check')).toHaveLength(12);
  expect(page.app.textContent).toContain('20 turns · 12 loaded · 1 unchanged group');
  openDetails(group); page.showFrom(0);
  expect(page.app.querySelector('details.poll-run')!.open).toBe(true);
  expect(page.app.querySelector('details.poll-run summary')!.textContent).toContain('19 checks');
  page.setView({ ...demoView(), timeline: pollingHistory(2) }); page.render();
  expect(page.app.querySelector('details.poll-run summary')!.textContent).toContain('1 check');
  expect(page.app.querySelector('details.poll-run summary')!.textContent).not.toContain('1 checks');
});

it("keeps disclosures and focus through growth, and rail jumps reveal the original turn", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(20) }); page.render();
  const group = page.app.querySelector('details.poll-run')!; openDetails(group);
  const check = group.querySelector('.poll-check')!; openDetails(check);
  const summary = check.querySelector('summary')!; summary.focus();
  const key = summary.getAttribute('data-focus');
  page.setView({ ...demoView(), timeline: pollingHistory(21) }); page.render();
  expect(page.document.activeElement?.getAttribute('data-focus')).toBe(key);
  expect(page.document.activeElement).not.toBe(summary);
  expect(page.app.querySelector('details.poll-run')!.open).toBe(true);
  expect(page.app.querySelector('.poll-check')!.open).toBe(true);
  expect(page.app.querySelector('details.poll-run summary')!.textContent).toContain('13 checks');
  page.jumpTo(2);
  const revealed = page.app.querySelector('.turn[data-i="2"]')!;
  expect(revealed.getClientRects()).toHaveLength(1);
  expect(revealed.closest('.poll-check')!.open).toBe(true);
});

it("refreshes a focused fold summary and keeps its scroll anchor when loading older originals", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(20) }); page.render();
  const summary = page.app.querySelector('details.poll-run summary')!; summary.focus();
  summary.rect = { top: 110, bottom: 200 };
  page.showFrom(0);
  expect(page.document.scrollMoves.at(-1)).toBe(40);
  expect(page.document.activeElement?.getAttribute('data-focus')).toBe(summary.getAttribute('data-focus'));
  expect(page.document.activeElement?.textContent).toContain('19 checks');
  page.setView({ ...demoView(), timeline: pollingHistory(21) }); page.render();
  expect(page.document.activeElement?.textContent).toContain('20 checks');
});

it("marks closed groups and visible check-ins in the rail, never hidden original cards", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(20) }); page.render();
  expect(page.app.querySelector('.tick[aria-current="true"]')!.getAttribute('data-i')).toBe('8');
  const group = page.app.querySelector('.poll-run')!; openDetails(group);
  const summaries = group.querySelectorAll('summary');
  summaries[0].rect = { top: -60, bottom: -10 };
  summaries[1].rect = { top: 10, bottom: 80 };
  // Turn 8's original card still has the default visible-looking geometry, but its
  // native details parent is closed. The next check-in, not that card, is current.
  page.onScroll();
  expect(page.app.querySelector('.tick[aria-current="true"]')!.getAttribute('data-i')).toBe('9');
  openDetails(group, false); summaries[0].rect = { top: 150, bottom: 250 }; page.onScroll();
  expect(page.app.querySelector('.tick[aria-current="true"]')!.getAttribute('data-i')).toBe('8');
});

it("keeps disclosure and tool focus identities when transcript indices shift, but not when the baseline disappears", () => {
  const page = bootPage(), timeline = pollingHistory(4);
  page.setView({ ...demoView(), timeline: [{ kind: 'operator', at: 10, text: 'Start', replies: [] }, ...timeline] }); page.render();
  const group = page.app.querySelector('.poll-run')!; openDetails(group);
  const check = group.querySelector('.poll-check')!; openDetails(check);
  const calls = check.querySelector('.calls-chip')!; calls.focus(); calls.listeners.click[0]({});
  const key = page.document.activeElement?.getAttribute('data-focus');
  page.setView({ ...demoView(), timeline }); page.render();
  expect(page.app.querySelector('.poll-run')!.open).toBe(true);
  expect(page.app.querySelector('.poll-check')!.open).toBe(true);
  expect(page.document.activeElement?.getAttribute('data-focus')).toBe(key);
  expect(page.document.activeElement?.getAttribute('aria-expanded')).toBe('true');
  expect(page.app.querySelector('.poll-check .turn')!.getAttribute('data-i')).toBe('1');
  page.setView({ ...demoView(), timeline: timeline.slice(1) }); page.render();
  expect(page.app.querySelector('.poll-run')!.open).toBe(false);
  expect(page.app.querySelector('.poll-check')!.open).toBe(false);
});

it("keeps a focused original visible when completion moves it into a fold", () => {
  const page = bootPage(), timeline = pollingHistory(4);
  timeline[3].complete = false;
  page.setView({ ...demoView(), timeline }); page.render();
  const calls = page.app.querySelector('.turn[data-i="3"] .calls-chip')!;
  calls.focus(); calls.listeners.click[0]({});
  const key = page.document.activeElement?.getAttribute('data-focus');
  page.setView({ ...demoView(), timeline: pollingHistory(4) }); page.render();
  expect(page.app.querySelector('.poll-run')!.open).toBe(true);
  expect(page.app.querySelector('.turn[data-i="3"]')!.closest('.poll-check')!.open).toBe(true);
  expect(page.document.activeElement?.getAttribute('data-focus')).toBe(key);
  expect(page.document.activeElement?.getClientRects()).toHaveLength(1);
});

it("preserves rail focus on Enter activation and live refresh", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(4) }); page.render();
  const tick = page.app.querySelector('.tick[data-i="2"]')!;
  tick.focus(); tick.listeners.click[0]({});
  expect(page.document.activeElement).not.toBe(tick);
  expect(page.document.activeElement?.getAttribute('class')).toContain('tick');
  expect(page.document.activeElement?.getAttribute('data-i')).toBe('2');
  page.setView({ ...demoView(), timeline: pollingHistory(5) }); page.render();
  expect(page.document.activeElement?.getAttribute('class')).toContain('tick');
  expect(page.document.activeElement?.getAttribute('data-i')).toBe('2');
});

it("clears fold and check state on generation changes and agent selection", () => {
  const page = bootPage(); page.setView({ ...demoView(), timeline: pollingHistory(3) }); page.render();
  const group = page.app.querySelector('details.poll-run')!; openDetails(group); openDetails(group.querySelector('.poll-check')!);
  expect(page.ui.folds.size).toBe(1); expect(page.ui.checks.size).toBe(1);
  page.setRoster([{ id: 'shop', state: 'ready', generation: 1 }, { id: 'other', state: 'starting', generation: 1 }]);
  expect(page.ui.folds.size).toBe(0); expect(page.ui.checks.size).toBe(0);
  page.ui.folds.add('old'); page.ui.checks.add('old'); page.selectAgent('other');
  expect(page.ui.folds.size).toBe(0); expect(page.ui.checks.size).toBe(0);
});

it("renders starting and stopped agents without fetching details or admitting a draft", async () => {
  const paths: string[] = [];
  const page = bootPage((path) => { paths.push(String(path)); return new Promise<never>(() => {}); });
  page.setRoster([{ id: 'slow', generation: 1, state: 'starting', phase: 'opening' }]);
  expect(page.app.textContent).toContain('Starting agent');
  expect(page.app.textContent).toContain('agents/slow/');
  expect(page.app.children[0]).toBeInstanceOf(FakeNode);
  expect((page.app.children[0] as FakeNode).getAttribute('class')).toBe('banner local');
  page.ui.draft = 'Retain this';
  await page.submitMessage('steer');
  expect(paths).toEqual([]);
  page.document.activeElement = page.app.querySelector('textarea');
  page.setRoster([{ id: 'slow', generation: 1, state: 'stopped', reason: '<img src=x> refused' }]);
  expect(page.app.textContent).toContain('Agent stopped');
  expect(page.app.textContent).toContain('<img src=x> refused');
  expect(page.app.querySelector('img')).toBeNull();
  expect(page.ui.draft).toBe('Retain this');
  expect(page.app.querySelector('.send')?.getAttribute('aria-disabled')).toBe('true');
});

it("acknowledges retry and cancel immediately and pins each request to its generation", async () => {
  for (const action of ['retry', 'cancel']) {
    const requests: { path: string; body: unknown }[] = [];
    let finish!: (response: Response) => void;
    const page = bootPage((path, init) => {
      if ((init as RequestInit).method === 'POST') {
        requests.push({ path: String(path), body: JSON.parse(String((init as RequestInit).body)) });
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return new Promise<never>(() => {});
    });
    page.setRoster([{ id: 'slow', generation: 7, ...(action === 'retry' ? { state: 'stopped', reason: 'Cannot connect' } : { state: 'starting', phase: 'opening' }) }]);
    const button = page.app.querySelector('.startup-action')!;
    page.document.activeElement = button;
    const pending = page.startupAction(action);
    await page.startupAction(action);
    expect(requests).toEqual([{ path: '/api/agents/slow/startup/' + action, body: { generation: 7 } }]);
    expect(page.app.querySelector('.startup-action')).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(page.app.querySelector('.startup-feedback')!.textContent).toContain('Requesting');
    finish(new Response(JSON.stringify({ error: 'stale generation' }), { status: 409 }));
    await pending;
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(page.app.querySelector('.startup-feedback')!.textContent).toContain('stale generation');
  }
});

it("switches away from a ready view immediately and keeps drafts separate by folder", () => {
  const page = bootPage();
  page.setView(demoView()); page.render(); page.ui.draft = 'Shop draft';
  page.setRoster([{ id: 'shop', state: 'ready', generation: 0 }, { id: 'slow', state: 'starting', phase: 'opening', generation: 2 }]);
  const selector = nodes(page.app).find((node) => node.getAttribute('aria-label') === 'Agent')!;
  page.document.activeElement = selector;
  page.selectAgent('slow');
  expect(page.app.textContent).not.toContain('Budget');
  expect(page.app.textContent).toContain('agents/slow/');
  expect(page.ui.draft).toBe('');
  page.ui.draft = 'Slow draft';
  page.selectAgent('shop');
  expect(page.ui.draft).toBe('Shop draft');
  page.selectAgent('slow');
  expect(page.ui.draft).toBe('Slow draft');
});

it("clears an admitted draft in its original folder after switching away", async () => {
  const roster = [{ id: 'shop', state: 'ready', generation: 0 }, { id: 'slow', state: 'starting', phase: 'opening', generation: 1 }];
  let finish!: (response: Response) => void;
  const page = bootPage((path, init) => {
    if ((init as RequestInit)?.method === 'POST') return new Promise<Response>((resolve) => { finish = resolve; });
    if (path === '/api/agents') return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: roster })));
    return new Promise<never>(() => {});
  });
  page.setView(demoView()); page.setRoster(roster); page.ui.draft = 'Send this once';
  const pending = page.submitMessage('followUp');
  page.selectAgent('slow'); page.ui.draft = 'Keep this other draft';
  finish(new Response(null, { status: 204 }));
  await pending;
  expect(page.ui.draft).toBe('Keep this other draft');
  page.selectAgent('shop');
  expect(page.ui.draft).toBe('');
});

it("polls the roster while a selected detail is hung and ignores its late response after cancellation", async () => {
  let roster: { id: string; state: string; generation: number; reason?: string }[] = [{ id: 'shop', state: 'ready', generation: 3 }];
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const paths: string[] = [];
  const page = bootPage((path, init) => {
    paths.push(String(path));
    if (path === '/api/agents') return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: roster })));
    if (path === '/api/agents/shop') { signal = (init as RequestInit).signal; return new Promise<Response>((resolve) => { finish = resolve; }); }
    return new Promise<never>(() => {});
  });
  page.setRoster(roster);
  await page.refresh();
  roster = [{ id: 'shop', state: 'stopped', generation: 4, reason: 'Cancelled' }];
  await page.refresh();
  expect(paths.filter((path) => path === '/api/agents')).toHaveLength(2);
  expect(signal?.aborted).toBe(true);
  finish(new Response(JSON.stringify(demoView())));
  await settle();
  expect(page.app.textContent).toContain('Agent stopped');
  expect(page.app.textContent).not.toContain('Budget');
});

it("refreshes roster labels without replacing a focused ready draft", () => {
  const page = bootPage(); page.setView(demoView()); page.render();
  const textarea = page.app.querySelector('textarea')!;
  page.document.activeElement = textarea; textarea.value = page.ui.draft = 'Keep typing';
  textarea.selectionStart = 2; textarea.selectionEnd = 6;
  page.setRoster([{ id: 'shop', state: 'ready', generation: 0 }, { id: 'other', state: 'stopped', generation: 2, reason: 'Failed' }]);
  expect(page.app.querySelector('textarea')).toBe(textarea);
  expect([textarea.value, textarea.selectionStart, textarea.selectionEnd]).toEqual(['Keep typing', 2, 6]);
  expect(page.app.textContent).toContain('other · stopped');
});

it("keeps a missing selected folder instead of silently showing another agent", () => {
  const page = bootPage(); page.setView(demoView()); page.render(); page.ui.draft = 'Shop only';
  page.setRoster([{ id: 'other', state: 'ready', generation: 1 }]);
  expect(page.app.textContent).toContain('agents/shop/');
  expect(page.app.textContent).toContain('Agent unavailable');
  expect(page.app.textContent).not.toContain('Budget');
  expect(page.ui.draft).toBe('Shop only');
});

it("ignores a late SSE view from an older generation", async () => {
  let push!: (chunk: string) => void;
  const page = bootPage((path) => String(path).endsWith('/stream') ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk)); } }))) : new Promise<never>(() => {}));
  page.setRoster([{ id: 'shop', state: 'ready', generation: 1 }]);
  await settle();
  page.setRoster([{ id: 'shop', state: 'stopped', generation: 2, reason: 'Cancelled' }]);
  push('event: view\ndata: ' + JSON.stringify(demoView()) + '\n\n');
  await settle();
  expect(page.app.textContent).toContain('Agent stopped');
  expect(page.app.textContent).not.toContain('Budget');
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
  expect(nodes(queue!).filter((node) => node.tagName === 'BUTTON')).toHaveLength(3);
  expect(queue!.querySelectorAll('.queue-promote')).toHaveLength(1);
  expect(queue!.querySelectorAll('.queue-withdraw')).toHaveLength(2);
  for (const row of queue!.querySelectorAll('.queue-row')) {
    const withdraw = row.querySelector('.queue-withdraw')!;
    expect(withdraw.textContent).toBe('Withdraw');
    expect(withdraw.getAttribute('type')).toBe('button');
    expect(withdraw.getAttribute('aria-describedby')).toBe(row.querySelector('.queue-text')!.getAttribute('id'));
    expect(withdraw.getAttribute('aria-disabled')).toBe('false');
  }
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
  expect(page.app.querySelector('#queued-messages')?.hidden).toBe(true); expect(page.app.querySelector('textarea')).toBe(textarea);
});

it("hides the queued-messages band while the queue is empty, keeps the notice visible and moves focus to the composer", () => {
  const page = bootPage(), followUp = { requestId: 'first', text: 'Oldest', mode: 'followUp' };
  page.setView(demoView()); page.render();
  const section = page.app.querySelector('#queued-messages')!, textarea = page.app.querySelector('textarea')!;
  expect(section.hidden).toBe(true); expect(section.textContent).not.toContain('No queued messages.');
  expect(section.contains(page.app.querySelector('.queue-notice'))).toBe(false);
  page.document.activeElement = textarea; page.ui.draft = 'Typing';
  page.setView({ ...demoView(), queuedMessages: [followUp] }); page.render();
  expect(page.app.querySelector('#queued-messages')).toBe(section); expect(section.hidden).toBe(false); expect(section.querySelector('.band')).toBeNull();
  page.document.activeElement = page.app.querySelector('.queue-promote'); const focused = textarea.focusCalls.length;
  page.setView(demoView()); page.render();
  expect(textarea.focusCalls).toHaveLength(focused + 1); expect(page.app.querySelector('#queued-messages')?.hidden).toBe(true);
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
    expect(requests).toEqual(['/api/agents/shop/steer/stable%2Fid']); expect(page.app.querySelector('.queue-promote')?.getAttribute('aria-disabled')).toBe('true');
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
  expect(page.app.querySelector('.queue-promote')?.getAttribute('aria-disabled')).toBe('false'); expect(page.app.querySelector('.message-status')?.textContent).toBe('');
  await page.promoteMessage('first', 'shop'); expect(posts).toBe(2);
});

it("withdraws either queue mode with one body-free DELETE and preserves an edited composer", async () => {
  for (const mode of ['followUp', 'steer']) {
    const requests: { path: string; init: RequestInit }[] = []; let finish!: (response: Response) => void;
    const page = bootPage((path, init) => {
      const request = init as RequestInit;
      if (request.method === 'DELETE') { requests.push({ path: String(path), init: request }); return new Promise<Response>((resolve) => { finish = resolve; }); }
      return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
    });
    const message = { requestId: 'stable/id', text: 'Withdraw this', mode };
    page.setView({ ...demoView(), queuedMessages: [message] }); page.render();
    const textarea = page.app.querySelector('form.composer textarea')!, button = page.app.querySelector('.queue-withdraw')!;
    page.document.activeElement = textarea; textarea.value = page.ui.draft = 'Unrelated draft'; textarea.selectionStart = 2; textarea.selectionEnd = 6;
    const first = page.withdrawMessage('stable/id', 'shop'), second = page.withdrawMessage('stable/id', 'shop');
    button.listeners.click[0]({});
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/agents/shop/messages/stable%2Fid');
    expect(requests[0].init.body).toBeUndefined(); expect(requests[0].init.headers).not.toHaveProperty('content-type');
    expect(button.getAttribute('aria-disabled')).toBe('true'); expect(button.disabled).toBe(false); expect(button.textContent).toBe('Withdrawing…');
    textarea.listeners.input[0]({ target: { value: 'Newer draft' } }); textarea.value = 'Newer draft';
    finish(new Response(null, { status: 204 })); await Promise.all([first, second]);
    expect(page.app.querySelector('.queue-notice')?.textContent).toBe('Message withdrawn.');
    expect(page.app.querySelector('.message-status')?.textContent).toBe('');
    expect(page.ui.draft).toBe('Newer draft'); expect(page.app.querySelector('textarea')).toBe(textarea);
    expect([textarea.value, textarea.selectionStart, textarea.selectionEnd]).toEqual(['Newer draft', 2, 6]);
    await page.withdrawMessage('stable/id', 'shop'); expect(requests).toHaveLength(1);
    page.setView(demoView()); page.render(); expect(page.app.querySelectorAll('.queue-row')).toHaveLength(0);
  }
});

it("keeps offline withdrawal retryable with the same ID, including a lost success acknowledgement", async () => {
  const paths: string[] = [];
  const page = bootPage((path, init) => {
    if ((init as RequestInit).method === 'DELETE') {
      paths.push(String(path));
      return paths.length === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
  });
  page.setView({ ...demoView(), queuedMessages: [{ requestId: 'first', text: 'Visible', mode: 'steer' }] }); page.render();
  const button = page.app.querySelector('.queue-withdraw')!; page.document.activeElement = button;
  await page.withdrawMessage('first', 'shop');
  expect(page.app.querySelector('.queue-error')?.textContent).toContain('Could not withdraw this message. Try again. offline');
  expect(page.app.querySelector('.queue-withdraw')).toBe(button); expect(button.getAttribute('aria-disabled')).toBe('false');
  expect(page.app.querySelector('.message-status')?.textContent).toBe('');
  await page.withdrawMessage('first', 'shop');
  expect(paths).toEqual(['/api/agents/shop/messages/first', '/api/agents/shop/messages/first']);
  expect(page.app.querySelector('.queue-error')?.textContent).toBe('');
  expect(page.app.querySelector('.queue-notice')?.textContent).toBe('Message withdrawn.');
});

it("leaves a failed composer's draft, retry identity and feedback untouched by withdrawal", async () => {
  const sends: unknown[] = [];
  const page = bootPage((_path, init) => {
    const request = init as RequestInit;
    if (request.method === 'POST') { sends.push(JSON.parse(String(request.body))); return Promise.reject(new Error('send offline')); }
    if (request.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
  });
  page.setView({ ...demoView(), queuedMessages: [{ requestId: 'queued', text: 'Old message', mode: 'followUp' }] }); page.render();
  const textarea = page.app.querySelector('form.composer textarea')!; page.document.activeElement = textarea;
  textarea.value = page.ui.draft = 'Retry this draft';
  await page.submitMessage('steer');
  const feedback = page.app.querySelector('.message-status')!.textContent;
  await page.withdrawMessage('queued', 'shop');
  expect(page.ui.draft).toBe('Retry this draft'); expect(textarea.value).toBe('Retry this draft');
  expect(page.app.querySelector('.message-status')?.textContent).toBe(feedback);
  await page.submitMessage('followUp'); expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]);
});

it("keeps focus on the composer when a withdrawal view arrives before its acknowledgement", async () => {
  let finish!: (response: Response) => void;
  const page = bootPage((_path, init) => (init as RequestInit).method === 'DELETE'
    ? new Promise<Response>((resolve) => { finish = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] }))));
  page.setView({ ...demoView(), queuedMessages: [{ requestId: 'only', text: 'Only', mode: 'steer' }] }); page.render();
  page.document.activeElement = page.app.querySelector('.queue-withdraw');
  const pending = page.withdrawMessage('only', 'shop');
  page.setView(demoView()); page.render();
  expect(page.document.activeElement).toBe(page.app.querySelector('form.composer textarea'));
  finish(new Response(null, { status: 204 })); await pending;
  expect(page.app.querySelectorAll('.queue-row')).toHaveLength(0);
  expect(page.app.querySelector('.queue-notice')?.textContent).toBe('Message withdrawn.');
  expect(page.document.activeElement).toBe(page.app.querySelector('form.composer textarea'));
});

it("reports withdrawal placement and stale-row races as the same notice as steering", async () => {
  for (const status of [404, 409]) {
    let deletes = 0;
    const page = bootPage((_path, init) => {
      if ((init as RequestInit).method === 'DELETE') { deletes++; return Promise.resolve(new Response(JSON.stringify({ error: 'Unknown or placed message' }), { status })); }
      return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
    });
    page.setView({ ...demoView(), queuedMessages: [{ requestId: 'first', text: 'Visible', mode: 'steer' }] }); page.render();
    page.ui.draft = 'Do not change this';
    await page.withdrawMessage('first', 'shop'); await page.withdrawMessage('first', 'shop');
    expect(deletes).toBe(1); expect(page.app.querySelector('.queue-notice')?.textContent).toBe('The agent already has this message.');
    expect(page.app.querySelector('.queue-error')?.textContent).toBe(''); expect(page.app.querySelector('.message-status')?.textContent).toBe('');
    expect(page.ui.draft).toBe('Do not change this');
  }
});

it("serializes steering and withdrawal of the same row in either order", async () => {
  for (const firstAction of ['steer', 'withdraw']) {
    const methods: string[] = []; let finish!: (response: Response) => void;
    const page = bootPage((_path, init) => {
      const method = (init as RequestInit).method!;
      if (method !== 'GET') { methods.push(method); return new Promise<Response>((resolve) => { finish = resolve; }); }
      return Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] })));
    });
    page.setView({ ...demoView(), queuedMessages: [{ requestId: 'first', text: 'Visible', mode: 'followUp' }] }); page.render();
    page.document.activeElement = page.app.querySelector(firstAction === 'steer' ? '.queue-promote' : '.queue-withdraw');
    const pending = firstAction === 'steer' ? page.promoteMessage('first', 'shop') : page.withdrawMessage('first', 'shop');
    await (firstAction === 'steer' ? page.withdrawMessage('first', 'shop') : page.promoteMessage('first', 'shop'));
    expect(methods).toEqual([firstAction === 'steer' ? 'POST' : 'DELETE']);
    expect(page.app.querySelector('.queue-promote')?.getAttribute('aria-disabled')).toBe('true');
    expect(page.app.querySelector('.queue-withdraw')?.getAttribute('aria-disabled')).toBe('true');
    finish(new Response(null, { status: 204 })); await pending;
    if (firstAction === 'steer') expect(page.app.querySelector('.queue-withdraw')?.getAttribute('aria-disabled')).toBe('false');
  }
});

it("moves focus to the nearest surviving Withdraw control when a queued row disappears", () => {
  for (const index of [0, 1, 2]) {
    const page = bootPage(), messages = ['first', 'second', 'third'].map((requestId) => ({ requestId, text: requestId, mode: 'steer' }));
    page.setView({ ...demoView(), queuedMessages: messages }); page.render();
    const rows = page.app.querySelectorAll('.queue-row'), remaining = messages.filter((_, i) => i !== index);
    const next = rows[index + 1] || rows[index - 1], control = next.querySelector('.queue-withdraw')!;
    page.document.activeElement = rows[index].querySelector('.queue-withdraw');
    page.setView({ ...demoView(), queuedMessages: remaining }); page.render();
    expect(page.app.querySelectorAll('.queue-row')).toHaveLength(2);
    expect(page.document.activeElement).toBe(control); expect(page.app.contains(control)).toBe(true);
    expect(control.focusCalls).toEqual([{ preventScroll: true }]);
    expect(page.app.querySelector('#queued-messages')!.focusCalls).toEqual([]);
  }
});

it("moves focus from the last withdrawn row to the visible composer, not a section", () => {
  const page = bootPage(); page.setView({ ...demoView(), queuedMessages: [{ requestId: 'only', text: 'Only', mode: 'steer' }] }); page.render();
  const section = page.app.querySelector('#queued-messages')!;
  page.document.activeElement = page.app.querySelector('.queue-withdraw');
  page.setView(demoView()); page.render();
  expect(page.app.querySelector('#queued-messages')?.hidden).toBe(true);
  expect(page.document.activeElement).toBe(page.app.querySelector('form.composer textarea'));
  expect(page.document.activeElement?.tagName).toBe('TEXTAREA'); expect(section.focusCalls).toEqual([]);
});

it("moves focus from a promoted Steer control to that row's Withdraw control", () => {
  const page = bootPage(), message = { requestId: 'only', text: 'Only', mode: 'followUp' };
  page.setView({ ...demoView(), queuedMessages: [message] }); page.render();
  const withdraw = page.app.querySelector('.queue-withdraw')!;
  page.document.activeElement = page.app.querySelector('.queue-promote');
  page.setView({ ...demoView(), queuedMessages: [{ ...message, mode: 'steer' }] }); page.render();
  expect(page.app.querySelector('.queue-promote')).toBeNull(); expect(page.document.activeElement).toBe(withdraw);
});

it("stacks queue actions beside prose and moves the group below it on phones", () => {
  expect(PAGE).toMatch(/\.queue-actions \{[^}]*grid-column: 2;[^}]*flex-direction: column;/);
  expect(PAGE).toMatch(/@media \(max-width: 640px\) \{[^}]*\.queue-row \{ grid-template-columns: minmax\(0, 1fr\); \}[^}]*\.queue-actions \{ grid-column: 1; grid-row: 3;[^}]*flex-direction: row;/);
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
  expect(next).toBe(page.document.activeElement);
  expect(next.focusCalls).toEqual([{ preventScroll: true }]);
});

// A deliberate ask for the composer (the sample prompts and the Fix this buttons go
// through draftInto) still scrolls it into view.
it("scrolls the composer into view when a sample prompt drafts a message", () => {
  const page = bootPage();
  page.setView(demoView());
  page.render();
  const sample = page.app.querySelectorAll('.sample')[0];
  page.document.activeElement = sample;
  sample.listeners.click[0]({});
  expect(page.ui.draft).toBe('Post a job under $15');
  expect(page.app.querySelector('form.composer textarea')!.focusCalls).toEqual([{ preventScroll: false }]);
});

// gh#30: a bare "textarea" query lands on the Briefing tab's instructions field, so a pending
// composer focus must wait for the timeline's composer instead.
it("keeps a pending composer focus away from the Briefing tab's instructions field", () => {
  const page = bootPage();
  page.setView({ ...demoView(), prompt: 'You are Demo.', spec: { model: 'faux:test', instructions: 'You are Demo.\n\nWhat you want right now: Win copy-editing jobs.', dials: { temperament: 'patient', competence: 0.5, diligence: 0.5, priceSensitivity: 0.5 }, limits: { dailyUsd: 50 } } });
  page.render();
  page.ui.focusComposer = true;
  page.document.activeElement = page.app.querySelector('nav a');
  page.ui.tab = 'briefing';
  page.render();
  expect(page.app.querySelector('textarea')!.focusCalls).toEqual([]);
  page.ui.tab = 'timeline';
  page.render();
  expect(page.app.querySelector('form.composer textarea')!.focusCalls).toEqual([{ preventScroll: true }]);
});

it("shows the default or saved polling interval in Briefing and saves it with the spec", async () => {
  for (const interval of [undefined, 1, 1440]) {
    const requests: unknown[] = [];
    const page = bootPage((_path, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)));
      return new Promise<never>(() => {});
    });
    page.setView({ ...demoView(), spec: { ...demoView().spec, pollIntervalMinutes: interval, dials: { temperament: 'patient' } } });
    page.ui.tab = 'briefing'; page.render();
    const input = nodes(page.app).find((node) => node.getAttribute('id') === 'poll-interval')!;
    expect(input).toBeDefined();
    expect(input.getAttribute('value')).toBe(String(interval ?? 15));
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('1440');
    expect(input.getAttribute('step')).toBe('1');
    expect(input.getAttribute('aria-describedby')).toBe('poll-interval-help');
    input.listeners.change[0]({ target: { value: '7' } });
    nodes(page.app).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Save & reopen')!.listeners.click[0]({});
    expect(requests).toEqual([expect.objectContaining({ pollIntervalMinutes: 7 })]);
  }
});

it("names an active host polling override without changing the saved interval", () => {
  const page = bootPage();
  page.setView({ ...demoView(), host: { pollIntervalMs: 500 }, spec: { ...demoView().spec, pollIntervalMinutes: 7, dials: { temperament: 'patient' } } });
  page.ui.tab = 'briefing'; page.render();
  expect(nodes(page.app).find((node) => node.getAttribute('id') === 'poll-interval')!.getAttribute('value')).toBe('7');
  expect(page.app.textContent).toContain('Host override active: the current delay is 0.5 seconds. Saving does not change the override.');
});

it("rejects invalid polling drafts before sending a save request", () => {
  for (const value of ['', '0', '-1', '1.5', '1441', 'NaN', 'Infinity']) {
    const requests: unknown[] = [];
    const page = bootPage((path) => { requests.push(path); return new Promise<never>(() => {}); });
    page.setView({ ...demoView(), spec: { ...demoView().spec, dials: { temperament: 'patient' } } });
    page.ui.tab = 'briefing'; page.render();
    const input = nodes(page.app).find((node) => node.getAttribute('id') === 'poll-interval')!;
    input.listeners.change[0]({ target: { value } });
    nodes(page.app).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Save & reopen')!.listeners.click[0]({});
    expect(requests).toEqual([]);
    expect(page.app.textContent).toContain('Check-for-work interval must be a whole number from 1 to 1440 minutes.');
  }
});

it("pins queue prose below its mode even without a promotion button", () => {
  expect(PAGE).toContain('.queue-mode, .queue-text { grid-column: 1; }');
});

it("marks each queued row with a muted sentence-case Queued that screen readers skip and text never runs under", () => {
  expect(PAGE).toMatch(/\.queue-row \{[^}]*background: var\(--ground\); border-style: dashed; color: var\(--soft\);/);
  expect(PAGE).toMatch(/\.queue-row::before \{ content: "Queued"; content: "Queued" \/ ""; grid-column: 1; grid-row: 1; justify-self: end;[^}]*font-size: 24px;/);
  expect(PAGE).not.toMatch(/\.queue-row::before \{[^}]*text-transform/);
  expect(PAGE).toMatch(/\.queue-mode \{ grid-row: 1; padding-right: 104px;/);
});

it("says when each queued message runs, lists the rows and keeps focus on Steer while it is promoted", async () => {
  let resolve!: (response: Response) => void;
  const page = bootPage((_path, init) => (init as { method: string }).method === 'POST'
    ? new Promise<Response>((done) => { resolve = done; })
    : Promise.resolve(new Response(JSON.stringify({ env: 'local', agents: [{ id: 'shop' }] }))));
  const queued =[{ requestId: 'first', text: 'Hold the photo task', mode: 'followUp' }, { requestId: 'second', text: 'Skip big bids', mode: 'steer' }];
  page.setView({ ...demoView(), queuedMessages: queued }); page.render();
  const modes = page.app.querySelectorAll('.queue-mode').map((node) => node.textContent);
  expect(modes).toEqual(['Queued Follow-up · waits until you resume', 'Queued Steer · waits until you resume']);
  page.setView({ ...demoView(), operator: { ...demoView().operator, paused: false }, queuedMessages: queued }); page.render();
  expect(page.app.querySelectorAll('.queue-when').map((node) => node.textContent)).toEqual([" · waits for the agent's next run", ' · reaches the agent after its current tool round']);
  expect(page.app.querySelector('.queued-rows')?.getAttribute('role')).toBe('list');
  expect(page.app.querySelectorAll('.queue-row').map((row) => row.getAttribute('role'))).toEqual(['listitem', 'listitem']);
  const button = page.app.querySelector('.queue-promote')!;
  expect(button.getAttribute('aria-label')).toBeNull();
  expect(button.getAttribute('aria-describedby')).toBe(page.app.querySelector('.queue-text')?.getAttribute('id'));
  page.document.activeElement = button;
  const promotion = page.promoteMessage('first', 'shop');
  expect(page.app.querySelector('.queue-promote')).toBe(button); expect(button.getAttribute('aria-disabled')).toBe('true'); expect(button.textContent).toBe('Steering…');
  resolve(new Response(null, { status: 204 })); await promotion;
  expect(page.app.querySelector('.queue-notice')?.textContent).toBe('Changed to a steer.');
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
  expect(ui.raw.size).toBe(1);
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
  expect(PAGE.includes('replyBlock(reply, replyKey(turn, index, reply, r), index === view.timeline.length - 1)')).toBe(true);
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

// Theme differences belong to the two token blocks only: one :root, one
// [data-theme="dark"]. A per-element dark rule means retuning a theme takes a hunt.
it("keeps every theme difference inside the two token blocks", () => {
  expect(PAGE.match(/\[data-theme="dark"][^,{]*\{/g)).toEqual(['[data-theme="dark"] {']);
});

// The always-dark chrome (header, budget card, freeze toggle, copy button) names its
// palette once in :root; every use references the token.
it("names each dark-chrome colour exactly once", () => {
  for (const hex of ["#4A4E55", "#F2F1EA", "#E9E7DC", "#17191c", "#1C1C19", "#56D364", "#F85149"]) {
    expect(PAGE.split(hex).length - 1, hex).toBe(1);
  }
});

// Elements print as tags and text is escaped, so a <script> element and the words
// "<script>" can never look alike.
const html = (node: unknown): string => node instanceof FakeNode
  ? `<${node.tagName.toLowerCase()}${Object.entries(node.attributes).map(([k, v]) => ` ${k}="${v}"`).join("")}>${node.children.map(html).join("")}</${node.tagName.toLowerCase()}>`
  : String(node).replace(/</g, "&lt;");
// A reply's rendered markdown, without its div.md wrapper.
const mdOf = ({ replyBlock }: ReturnType<typeof bootPage>) => (text: string) => html(replyBlock({ text, calls: [], tasks: [] }, "k", false).querySelector("div.md")).replace(/^<div class="md">|<\/div>$/g, "");

it("renders a reply's markdown subset node by node and leaves raw HTML and unsafe links as text", () => {
  const page = bootPage(), { lastSaid } = page, md = mdOf(page);
  const link = 'href="https://example.com/a?b=1" title="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer"';
  expect(md("Hello **bold**, *it* and `id_1` in [docs](https://example.com/a?b=1).\nnext line")).toBe(`<p>Hello <strong>bold</strong>, <em>it</em> and <code>id_1</code> in <a ${link}>docs</a>.\nnext line</p>`);
  expect(md("### Plan\n- one\n  - nested\n- two\n\n3. three\n4. four")).toBe('<p><strong>Plan</strong></p><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>');
  expect(md("```js\nconst a = 1 < 2;\n```\nafter")).toBe("<pre>const a = 1 &lt; 2;</pre><p>after</p>");
  expect(md("<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))")).toBe("<p>&lt;script>alert(1)&lt;/script> &lt;img src=x onerror=alert(1)> [x](javascript:alert(1))</p>");
  expect(md("snake_case_id, _id alone, 2 * 3 * 4 and \\*kept\\*")).toBe("<p>snake_case_id, _id alone, 2 * 3 * 4 and *kept*</p>");
  // A reply still streaming closes its open emphasis, code span and fence instead of showing markers.
  expect(md("Total **so far")).toBe("<p>Total <strong>so far</strong></p>");
  expect(md("Run `task get")).toBe("<p>Run <code>task get</code></p>");
  expect(md("Output:\n```\nline one")).toBe("<p>Output:</p><pre>line one</pre>");
  expect(md("Intro with **")).toBe("<p>Intro with </p>");
  expect(md("**bold words*")).toBe("<p><strong>bold words</strong></p>");
  // Only the block that ends the text can still be streaming; finished blocks keep unmatched markers.
  expect(md("*draft note\nscore 2 **\n\n- item *open\n\nlast *word")).toBe("<p>*draft note\nscore 2 **</p><ul><li>item *open</li></ul><p>last <em>word</em></p>");
  expect(md("## **Plan** here")).toBe("<p><strong>Plan</strong><strong> here</strong></p>");
  // No images: the syntax stays text, so nothing links to or fetches the address.
  expect(md("![chart](https://example.com/c.png)")).toBe("<p>![chart](https://example.com/c.png)</p>");
  expect(md("0. zero\n1. one")).toBe('<ol start="0"><li>zero</li><li>one</li></ol>');
  // Prose that only looks like markup stays prose.
  expect(md("Sales grew in\n2024. Then 5*3 units\n***\nend")).toBe("<p>Sales grew in\n2024. Then 5*3 units</p><p>end</p>");
  // The peek row reads the words without the markers.
  expect(lastSaid({ replies: [{ text: "**Bid** on `t-1`:\n- [docs](https://example.com) ok" }] })).toBe("Bid on t-1: docs ok");
});

it("renders a reply's markdown table node by node and keeps near-tables as text", () => {
  const page = bootPage(), { lastSaid } = page, md = mdOf(page);
  const th = (...cells: string[]) => `<tr>${cells.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const tr = (...cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  const table = (head: string, ...rows: string[]) => `<table><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`;
  // A table parses from a header line with a pipe and a delimiter row of the same cell count.
  expect(md("| What | Value |\n| --- | --- |\n| bid | `44444444` |\n| fee | **0.25 USDC** |")).toBe(
    table(th("What", "Value"), tr("bid", "<code>44444444</code>"), tr("fee", "<strong>0.25 USDC</strong>")),
  );
  // Outer pipes are optional, colons in the delimiter only mark alignment, and the table may interrupt a paragraph.
  expect(md("Review:\na | b\n:-: | ---:\n1 | 2")).toBe(`<p>Review:</p>${table(th("a", "b"), tr("1", "2"))}`);
  // Short rows pad and long rows trim to the header's cell count.
  expect(md("| a | b | c |\n| --- | --- | --- |\n| 1 |\n| x | y | z | extra |")).toBe(table(th("a", "b", "c"), tr("1", "", ""), tr("x", "y", "z")));
  // A blank line or a line without a pipe ends the rows; the table may end the text mid-stream.
  expect(md("| a | b |\n| - | - |\n| 1 | 2 |\nplain")).toBe(`${table(th("a", "b"), tr("1", "2"))}<p>plain</p>`);
  expect(md("| a | b |\n| --- | --- |")).toBe(table(th("a", "b")));
  // An escaped pipe stays inside its cell.
  expect(md("| a \\| b | c |\n| --- | --- |")).toBe(table(th("a | b", "c")));
  // Near-tables stay prose: no pipe in the header line, a different cell count, or a stray delimiter row.
  expect(md("Head\n---\ntext")).toBe("<p>Head</p><p>text</p>");
  expect(md("| a | b |\n| --- | --- | --- |")).toBe("<p>| a | b |\n| --- | --- | --- |</p>");
  expect(md("| --- | --- |")).toBe("<p>| --- | --- |</p>");
  // The peek row reads the table's words without the pipes.
  expect(lastSaid({ replies: [{ text: "| Bid | `t-1` |\n| --- | --- |" }] })).toBe("Bid t-1");
});
