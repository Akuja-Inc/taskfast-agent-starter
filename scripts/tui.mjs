// `pnpm tui '<console link>'` runs the terminal UI under Bun; `pnpm tui:test` typechecks
// it and runs its smoke test. Only the TUI needs Bun: pnpm agents, the build and the
// tests never do. The TUI's own pinned packages (src/tui/package.json) install here.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tui = fileURLToPath(new URL("../src/tui/", import.meta.url));
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: tui, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (spawnSync("bun", ["--version"], { stdio: "ignore" }).error) {
  process.stderr.write("The terminal UI runs under Bun. Install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash), open a new terminal, and run pnpm tui again. pnpm agents does not need Bun.\n");
  process.exit(1);
}
run("bun", ["install", "--frozen-lockfile", "--silent"]);
if (process.argv[2] === "--test") {
  run(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.json"]);
  run("bun", ["test"]);
} else {
  // The link travels in the environment, not Bun's arguments, which other local users can list.
  const link = process.argv[2] ?? process.env.TASKFAST_CONSOLE_URL;
  run("bun", ["main.tsx"], { ...process.env, ...(link === undefined ? {} : { TASKFAST_CONSOLE_URL: link }) });
}
