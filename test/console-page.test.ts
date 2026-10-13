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

it("aborts a stream it stops reading, so it never holds a place on the server", async () => {
  const signals: AbortSignal[] = [];
  const fetch = async (_url: string, init: { signal: AbortSignal }) => {
    signals.push(init.signal);
    return new Response(body(['event: view\ndata: {"n":1}\n\n'], true));
  };
  const noTimer = () => 0;
  const follow = new Function("fetch", "setTimeout", "setInterval", "clearInterval", `${LIVE}\nreturn follow;`)(fetch, noTimer, noTimer, noTimer);
  follow("/s", "t", () => { throw new Error("render failed"); }, () => {});
  await settle();
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
  // The stream ended: poll now, then every 3 s, and try the stream again in 5 s.
  expect(polls).toBe(1);
  expect(timers.map(({ ms, cleared }) => ({ ms, cleared }))).toEqual([{ ms: 3000, cleared: undefined }, { ms: 5000, cleared: undefined }]);

  timers[1].run();
  await settle();
  expect(views).toEqual([{ n: 1 }, { n: 2 }]);
  expect(timers[0].cleared).toBe(true);
  stop();
  expect(PAGE).toContain(LIVE);
  expect(PAGE).not.toContain("setInterval(refresh");
});
