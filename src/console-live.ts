// Follows one agent's event stream with fetch, which, unlike EventSource, can send the
// token in a header. While the stream is down it polls every 3 s and tries the stream
// again every 5 s. Calling the returned function stops both. The page embeds this
// function's source, so it uses only browser globals and closes over nothing.
export function follow(path: string, token: string, onView: (view: unknown) => void, poll: () => void): () => void {
  // 3x the server's 15 s ping: a healthy stream always has traffic before this fires.
  const STALE_MS = 45_000;
  let stopped = false;
  let controller: AbortController | null = null;
  let polling: ReturnType<typeof setInterval> | null = null;
  async function connect() {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetch(path, { headers: { authorization: "Bearer " + token }, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(res.statusText);
      clearInterval(polling ?? undefined);
      polling = null;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        // A half-open socket never resolves read(), so race it against a timer; the abort
        // rejects the read into the catch below, which ends the request and goes onDown.
        const stale = setTimeout(() => controller?.abort(), STALE_MS);
        let read;
        try { read = await reader.read(); } finally { clearTimeout(stale); }
        if (read.done) break;
        buffer += read.value;
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = /^data: (.*)$/m.exec(block);
          // One malformed block or a throwing viewer must not tear down a healthy stream.
          if (block.startsWith("event: view") && data) try { onView(JSON.parse(data[1])); } catch {}
        }
      }
    } catch {}
    // Whatever ended the read, end the request too, so it can't hold a stream place.
    controller.abort();
    if (stopped) return;
    if (polling === null) { polling = setInterval(poll, 3000); poll(); }
    setTimeout(connect, 5000);
  }
  void connect();
  return () => { stopped = true; controller?.abort(); clearInterval(polling ?? undefined); };
}
