// `pnpm tui '<console link>'`: runs under Bun (scripts/tui.mjs). The token stays in
// memory: it is never written, logged or put in the window title.
import { spawn } from "node:child_process";
import { render } from "@opentui/solid";
import { App } from "./app.js";
import { parseLink } from "./link.js";

let link: { origin: string; token: string };
try { link = parseLink(process.argv[2], process.env.TASKFAST_CONSOLE_URL); }
catch (error) {
  process.stderr.write(`tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
// Opens task links, which are only ever the development web host's task pages.
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
await render(() => (
  <App origin={link.origin} token={link.token}
    open={(url) => spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()}
    quit={() => process.exit(0)} />
), { exitOnCtrlC: true });
