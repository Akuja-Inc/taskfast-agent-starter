import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// One JSON line appended to a private file: the directory 0700, the file 0600.
export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = openSync(path, "a", 0o600);
  try {
    writeSync(file, JSON.stringify(value) + "\n");
    fsyncSync(file);
  } finally { closeSync(file); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); }
  finally { closeSync(directory); }
}
