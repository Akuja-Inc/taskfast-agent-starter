// Prototype only: serves this checkout's built console page and forwards /api to a
// running console, so page changes can be judged against live data without a second
// host. Run `pnpm build`, then `node scripts/preview-console.mjs`, and open the printed
// URL with the running console's #token=... fragment. Reloads pick up each new build.
import { createServer, request } from "node:http";
import { statSync } from "node:fs";

const page = new URL("../dist/src/console-page.js", import.meta.url);
const upstream = "127.0.0.1:" + (process.env.CONSOLE_PORT || "7070");
const port = Number(process.env.PREVIEW_PORT || 7071);

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const { PAGE } = await import(page.href + "?v=" + statSync(page).mtimeMs);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(PAGE);
  }
  // The console refuses foreign Host and Origin headers, so present its own.
  const headers = { ...req.headers, host: upstream, ...(req.headers.origin ? { origin: "http://" + upstream } : {}) };
  const [hostname, upPort] = upstream.split(":");
  const out = request({ hostname, port: upPort, path: req.url, method: req.method, headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  out.on("error", (error) => { res.writeHead(502, { "content-type": "text/plain" }); res.end(String(error)); });
  req.pipe(out);
}).listen(port, "127.0.0.1", () => console.log("preview: http://127.0.0.1:" + port + "/ (append the console's #token=...)"));
