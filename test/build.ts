import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Plain Node fixtures import dist/. Build before any worker starts so a second
// compiler cannot truncate an emitted module while a fixture is importing it.
export default function buildFixtures(): void {
  const root = join(import.meta.dirname, "..");
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
    cwd: root, timeout: 90_000, stdio: "pipe",
  });
}
