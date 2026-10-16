import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MAX_MEDIA_BYTES, saveMedia } from "./media.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-"));
  dirs.push(dir);
  return dir;
}
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR fixture")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fixture")]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

it("saves an image under .pi-state/media by its bytes and tells the model its handle", () => {
  const dir = agentDir();
  expect(saveMedia(dir, "image/png", PNG.toString("base64"))).toBe(`[image/png saved as media:${digest(PNG)}.png, ${PNG.length} bytes]`);
  const path = join(dir, ".pi-state/media", `${digest(PNG)}.png`);
  expect(readFileSync(path).equals(PNG)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, ".pi-state/media")).mode & 0o777).toBe(0o700);
  // The same bytes again name the same file.
  expect(saveMedia(dir, "image/png", PNG.toString("base64"))).toContain(`media:${digest(PNG)}.png`);
  expect(saveMedia(dir, "image/jpeg", JPEG.toString("base64"))).toContain(`media:${digest(JPEG)}.jpg`);
});

it.each([
  ["a type the server cannot take as an image", "image/svg+xml", PNG.toString("base64"), "[image/svg+xml image omitted]"],
  ["bytes that are not the declared type", "image/png", JPEG.toString("base64"), "[image/png image omitted]"],
  ["invalid base64", "image/png", "not*base64", "[image/png image omitted]"],
  ["empty data", "image/png", "", "[image/png image omitted]"],
  ["an image over 7 MiB", "image/png", Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES)]).toString("base64"), "[image/png image omitted: larger than 7 MiB]"],
])("writes nothing for %s", (_n, type, data, line) => {
  const dir = agentDir();
  expect(saveMedia(dir, type, data)).toBe(line);
  expect(existsSync(join(dir, ".pi-state/media"))).toBe(false);
});

it("refuses a symlinked media folder without saying why", () => {
  const dir = agentDir(); const elsewhere = agentDir();
  mkdirSync(join(dir, ".pi-state"));
  symlinkSync(elsewhere, join(dir, ".pi-state/media"));
  expect(saveMedia(dir, "image/png", PNG.toString("base64"))).toBe("[image/png image omitted: could not save it]");
  expect(readdirSync(elsewhere)).toEqual([]);
});
