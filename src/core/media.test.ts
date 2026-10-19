import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MAX_VIDEO_BYTES, MEDIA_TYPES, mediaDigest as digest, saveMedia, VIDEO_CAP } from "./media.js";
import { VIDEO } from "../../test/fixtures/mcp/server.mjs";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-"));
  dirs.push(dir);
  return dir;
}
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR fixture")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fixture")]);

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
  ["invalid video base64", "video/mp4", "not*base64", "[video/mp4 video omitted]"],
  ["empty data", "image/png", "", "[image/png image omitted]"],
  ["unpadded base64", "image/png", PNG.toString("base64").replace(/=+$/, ""), "[image/png image omitted]"],
])("writes nothing for %s", (_n, type, data, line) => {
  const dir = agentDir();
  expect(saveMedia(dir, type, data)).toBe(line);
  expect(existsSync(join(dir, ".pi-state/media"))).toBe(false);
});

// The server, not the kit, decides how large an image may be.
it("saves an image larger than the old 8,000,000-byte upload limit", () => {
  const dir = agentDir();
  const big = Buffer.concat([PNG, Buffer.alloc(9_000_000)]);
  expect(saveMedia(dir, "image/png", big.toString("base64"))).toBe(`[image/png saved as media:${digest(big)}.png, ${big.length} bytes]`);
  expect(statSync(join(dir, ".pi-state/media", `${digest(big)}.png`)).size).toBe(big.length);
});

it.each(Object.entries(VIDEO))("saves a %s container by its bytes with private permissions", (mimeType, bytes) => {
  const dir = agentDir();
  const ext = MEDIA_TYPES[mimeType]!.ext;
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} saved as media:${digest(bytes)}.${ext}, ${bytes.length} bytes]`);
  const path = join(dir, ".pi-state/media", `${digest(bytes)}.${ext}`);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it.each([
  ["video/mp4", VIDEO["video/quicktime"]],
  ["video/quicktime", VIDEO["video/mp4"]],
  ["video/webm", Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex")],
  ["video/mp4", PNG],
  ["video/webm", VIDEO["video/webm"].subarray(0, 8)],
])("omits bytes that do not match %s", (mimeType, bytes) => {
  const dir = agentDir();
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} video omitted]`);
  expect(existsSync(join(dir, ".pi-state/media"))).toBe(false);
});

it("captures a video at 50 MiB but omits a larger one without writing it", () => {
  const dir = agentDir();
  const header = VIDEO["video/mp4"];
  const bytes = Buffer.concat([header, Buffer.alloc(MAX_VIDEO_BYTES - header.length)]);
  expect(saveMedia(dir, "video/mp4", bytes.toString("base64"))).toContain(`saved as media:${digest(bytes)}.mp4`);
  const other = agentDir();
  expect(saveMedia(other, "video/mp4", Buffer.concat([bytes, Buffer.from([0])]).toString("base64"))).toBe(`[video/mp4 video omitted: larger than ${VIDEO_CAP}]`);
  expect(existsSync(join(other, ".pi-state/media"))).toBe(false);
});

it.each([
  ["image/png", PNG, "image"],
  ["video/mp4", VIDEO["video/mp4"], "video"],
])("refuses a symlinked media folder for %s without saying why", (mimeType, bytes, kind) => {
  const dir = agentDir(); const elsewhere = agentDir();
  mkdirSync(join(dir, ".pi-state"));
  symlinkSync(elsewhere, join(dir, ".pi-state/media"));
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} ${kind} omitted: could not save it]`);
  expect(readdirSync(elsewhere)).toEqual([]);
});
