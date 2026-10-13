// Follows one agent's event stream with fetch, which, unlike EventSource, can send the
// token in a header. While the stream is down it polls every 3 s and tries the stream
// again every 5 s. Calling the returned function stops both. The page embeds this
// function's source, so it uses only browser globals and closes over nothing.
export function follow(path: string, token: string, onView: (view: unknown) => void, poll: () => void): () => void {
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
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = /^data: (.*)$/m.exec(block);
          if (block.startsWith("event: view") && data) onView(JSON.parse(data[1]));
        }
      }
    } catch {}
    if (stopped) return;
    if (polling === null) { polling = setInterval(poll, 3000); poll(); }
    setTimeout(connect, 5000);
  }
  void connect();
  return () => { stopped = true; controller?.abort(); clearInterval(polling ?? undefined); };
}
