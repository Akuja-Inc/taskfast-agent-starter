import { expect, it } from "vitest";
import { LIVE, PAGE } from "../src/console-page.js";

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
