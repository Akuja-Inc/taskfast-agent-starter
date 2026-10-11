import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One JSON line appended to a private file: the directory 0700, the file 0600.
export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}
