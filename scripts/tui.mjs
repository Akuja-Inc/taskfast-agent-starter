// `pnpm tui '<console link>'` runs the terminal UI under Bun; `pnpm tui:test` runs its
// smoke test. Only the TUI needs Bun: pnpm agents, the build and the tests never do.
// The TUI's own pinned packages (src/tui/package.json) are installed on first use.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tui = fileURLToPath(new URL("../src/tui/", import.meta.url));
const bun = (args) => spawnSync("bun", args, { cwd: tui, stdio: "inherit" });
if (spawnSync("bun", ["--version"], { stdio: "ignore" }).error) {
  process.stderr.write("The terminal UI runs under Bun. Install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash), open a new terminal, and run pnpm tui again. pnpm agents does not need Bun.\n");
  process.exit(1);
}
if (!existsSync(new URL("../src/tui/node_modules/@opentui/solid/package.json", import.meta.url))) {
  const installed = bun(["install", "--frozen-lockfile"]);
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}
process.exit(bun(process.argv[2] === "--test" ? ["test"] : ["main.tsx", ...process.argv.slice(2)]).status ?? 1);
