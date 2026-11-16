import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifacts, clearOwnUploads, materializeArtifacts, ownUploads, MAX_AV_BYTES, MEDIA_TYPES, mediaDigest as digest, saveMedia, AV_CAP, MEDIA_FILES } from "./artifacts.js";
import type { CliResult } from "./cli.js";
import { AUDIO, FILES, VIDEO } from "../../test/fixtures/mcp/server.mjs";

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
  ["empty audio data", "audio/mpeg", "", "[audio/mpeg audio omitted]"],
  ["invalid audio base64", "audio/flac", "not*base64", "[audio/flac audio omitted]"],
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

it.each(Object.entries({ ...VIDEO, ...AUDIO, ...FILES }))("saves a %s file by its bytes with private permissions", (mimeType, bytes) => {
  const dir = agentDir();
  const ext = MEDIA_TYPES[mimeType]!.ext;
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} saved as media:${digest(bytes)}.${ext}, ${bytes.length} bytes]`);
  const path = join(dir, ".pi-state/media", `${digest(bytes)}.${ext}`);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it.each(["fffb9000", "fff39000", "ffe39000", "fffd9000"])("saves an MP3 that starts with the frame sync %s and no ID3 tag", (hex) => {
  const dir = agentDir();
  const bytes = Buffer.from(hex, "hex");
  expect(saveMedia(dir, "audio/mpeg", bytes.toString("base64"))).toBe(`[audio/mpeg saved as media:${digest(bytes)}.mp3, ${bytes.length} bytes]`);
});

it.each([
  ["video/mp4", VIDEO["video/quicktime"]],
  ["video/quicktime", VIDEO["video/mp4"]],
  ["video/webm", Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex")],
  ["video/mp4", PNG],
  ["video/webm", VIDEO["video/webm"].subarray(0, 8)],
  ["application/pdf", Buffer.from("PDF-1.7 without its percent sign")],
  ["application/msword", FILES["application/zip"]],
  ["application/zip", Buffer.from("504b0506000000000000000000000000000000000000", "hex")],
  ["application/x-tar", Buffer.alloc(512)],
  ["application/x-tar", FILES["application/x-tar"].subarray(0, 300)],
  ["application/gzip", FILES["application/pdf"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", FILES["application/msword"]],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", FILES["application/msword"]],
  ["application/vnd.ms-excel", FILES["application/zip"]],
  ["audio/mpeg", PNG],
  ["audio/mpeg", Buffer.from("feff00", "hex")],
  ["audio/mpeg", Buffer.from("fff900", "hex")],
  ["audio/mpeg", Buffer.from("ffe800", "hex")],
  ["audio/wav", AUDIO["audio/ogg"]],
  ["audio/wav", Buffer.from("RIFF\u0024\u0000\u0000\u0000AVI fmt ", "latin1")],
  ["audio/ogg", AUDIO["audio/flac"]],
  ["audio/mp4", VIDEO["video/mp4"]],
  ["audio/flac", AUDIO["audio/ogg"]],
  ["audio/flac", Buffer.alloc(0)],
])("omits bytes that do not match %s", (mimeType, bytes) => {
  const dir = agentDir();
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} ${MEDIA_TYPES[mimeType]!.kind} omitted]`);
  expect(existsSync(join(dir, ".pi-state/media"))).toBe(false);
});

it.each([
  ["video/mp4", "video", "mp4", VIDEO["video/mp4"]],
  ["audio/mpeg", "audio", "mp3", AUDIO["audio/mpeg"]],
  ["audio/flac", "audio", "flac", AUDIO["audio/flac"]],
])("captures %s at 50 MiB but omits a larger one without writing it", (mimeType, kind, ext, header) => {
  const dir = agentDir();
  const bytes = Buffer.concat([header, Buffer.alloc(MAX_AV_BYTES - header.length)]);
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toContain(`saved as media:${digest(bytes)}.${ext}`);
  const other = agentDir();
  expect(saveMedia(other, mimeType, Buffer.concat([bytes, Buffer.from([0])]).toString("base64"))).toBe(`[${mimeType} ${kind} omitted: larger than ${AV_CAP}]`);
  expect(existsSync(join(other, ".pi-state/media"))).toBe(false);
});

it.each([
  ["image/png", PNG, "image"],
  ["video/mp4", VIDEO["video/mp4"], "video"],
  ["audio/wav", AUDIO["audio/wav"], "audio"],
])("refuses a symlinked media folder for %s without saying why", (mimeType, bytes, kind) => {
  const dir = agentDir(); const elsewhere = agentDir();
  mkdirSync(join(dir, ".pi-state"));
  symlinkSync(elsewhere, join(dir, ".pi-state/media"));
  expect(saveMedia(dir, mimeType, bytes.toString("base64"))).toBe(`[${mimeType} ${kind} omitted: could not save it]`);
  expect(readdirSync(elsewhere)).toEqual([]);
});

const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const D = "0123456789abcdef";

describe("artifact validation", () => {
  it("accepts five text files at exactly 256 KiB each and omitted artifacts", () => {
    const content = "é".repeat(131072);
    const files = artifacts(Array.from({ length: 5 }, (_, i) => ({ name: `part${i}.txt`, content })), T);
    expect(files).toHaveLength(5);
    expect(materializeArtifacts(agentDir(), files).every((file) => file.bytes.length === 262144)).toBe(true);
    expect(artifacts(undefined, T)).toEqual([]);
  });
  it.each([
    ["a path", { name: "../results.json", content: "x" }, /artifact name/],
    ["a folder", { name: "out/results.json", content: "x" }, /artifact name/],
    ["a hidden file", { name: ".env.txt", content: "x" }, /artifact name/],
    ["a flag", { name: "--env=prod.txt", content: "x" }, /artifact name/],
    ["a type the CLI cannot upload", { name: "voice.aac", media: `media:${D}.mp3` }, /artifact name/],
    ["a Word name for a PDF", { name: "letter.docx", media: `media:${D}.pdf` }, /letter.docx must end in .pdf/],
    ["an Excel name for a Word file", { name: "sheet.xlsx", media: `media:${D}.docx` }, /sheet.xlsx must end in .docx/],
    ["a legacy Excel name for a spreadsheet", { name: "sheet.xls", media: `media:${D}.xlsx` }, /sheet.xls must end in .xlsx/],
    ["audio text from the model", { name: "voice.mp3", content: "x" }, /voice.mp3 is a binary file: deliver it as \{ name, media \}/],
    ["an audio type mismatch", { name: "voice.wav", media: `media:${D}.mp3` }, /voice.wav must end in .mp3/],
    ["a video name for audio", { name: "clip.mp4", media: `media:${D}.m4a` }, /clip.mp4 must end in .m4a/],
    ["PDF text from the model", { name: "report.pdf", content: "x" }, /report.pdf is a binary file: deliver it as \{ name, media \}/],
    ["a document type mismatch", { name: "report.doc", media: `media:${D}.pdf` }, /report.doc must end in .pdf/],
    ["an archive named for a tarball", { name: "bundle.tar", media: `media:${D}.gz` }, /bundle.tar must end in .gz/],
    ["empty content", { name: "a.txt", content: "" }, /a.txt content must be 1 to 262144 bytes/],
    ["content over 256 KiB", { name: "a.txt", content: "é".repeat(131073) }, /content must be 1 to 262144 bytes/],
    ["an extra field", { name: "a.txt", content: "x", path: "/etc/passwd" }, /each artifact is \{ name, content \}/],
    ["both content and media", { name: "logo.png", content: "x", media: `media:${D}.png` }, /each artifact is \{ name, content \} or \{ name, media \}/],
    ["neither content nor media", { name: "a.txt" }, /each artifact is \{ name, content \} or \{ name, media \}/],
    ["image text from the model", { name: "logo.png", content: "x" }, /logo.png is a binary file: deliver it as \{ name, media \}/],
    ["video text from the model", { name: "clip.mp4", content: "x" }, /deliver it as \{ name, media \}/],
    ["a video type mismatch", { name: "clip.mov", media: `media:${D}.mp4` }, /clip.mov must end in .mp4/],
    ["an image name for a video", { name: "clip.png", media: `media:${D}.webm` }, /clip.png must end in .webm/],
    ["a path-shaped video handle", { name: "clip.mp4", media: "media:../clip.mp4" }, /media must be a handle/],
    ["a media path", { name: "logo.png", media: ".pi-state/media/0123456789abcdef.png" }, /media must be a handle/],
    ["a traversing handle", { name: "logo.png", media: "media:../x.png" }, /media must be a handle/],
    ["a short digest", { name: "logo.png", media: "media:abc.png" }, /media must be a handle/],
    ["an absolute path", { name: "logo.png", media: "/etc/passwd" }, /media must be a handle/],
    ["a handle for another type", { name: "logo.jpg", media: `media:${D}.png` }, /logo.jpg must end in .png to match its media/],
    ["a text name for media", { name: "notes.txt", media: `media:${D}.png` }, /notes.txt must end in .png/],
  ])("refuses an artifact with %s", (_n, artifact, why) => {
    expect(() => artifacts([artifact], T)).toThrow(why);
  });

  it.each(["report.docx", "sheet.xlsx", "old.xls", "voice.mp3", "voice.wav", "voice.ogg", "voice.m4a", "voice.flac"])("names a handle's own type for %s", (name) => {
    const ext = name.split(".")[1]!;
    const [file] = artifacts([{ name, media: `media:${D}.${ext}` }], T);
    expect(file).toEqual({ path: `.pi-state/artifacts/${T}/${D}/${name}`, media: `.pi-state/media/${D}.${ext}`, digest: D });
  });

  it("lists the new types for the model", () => {
    expect(MEDIA_FILES).toContain("a document (.pdf, .doc, .docx, .xls or .xlsx)");
    expect(MEDIA_FILES).toContain("an audio (.mp3, .wav, .ogg, .m4a or .flac)");
  });

  it("refuses an empty list, more than five files and repeated names", () => {
    const file = (n: number) => ({ name: `part${n}.txt`, content: "x" });
    expect(() => artifacts([], T)).toThrow(/1 to 5 files/);
    expect(() => artifacts([1, 2, 3, 4, 5, 6].map(file), T)).toThrow(/1 to 5 files/);
    expect(() => artifacts([file(1), file(1)], T)).toThrow(/unique/);
  });

  it("reads this agent's own uploads from real `taskfast artifact list` output", () => {
    const me = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const row = (id: string, by: string) => ({ id, uploaded_by_id: by });
    const other = "550e8400-e29b-41d4-a716-446655440009";
    expect(ownUploads({ artifacts: [row(other, T), row("550e8400-e29b-41d4-a716-446655440001", me.toUpperCase())] }, me)).toEqual(["550e8400-e29b-41d4-a716-446655440001"]);
    expect(ownUploads({ artifacts: [row("--env=prod", me)] }, me)).toBeNull();
    expect(ownUploads({ data: [] }, me)).toBeNull();
  });
});

describe("materializeArtifacts", () => {
  it("resolves exact bytes, writes private files, and tolerates repeated writes", () => {
    const dir = agentDir();
    saveMedia(dir, "image/png", PNG.toString("base64"));
    const plan = artifacts([{ name: "logo.png", media: `media:${digest(PNG)}.png` }, { name: "notes.txt", content: "héllo\n" }], T);
    const files = materializeArtifacts(dir, plan);
    expect(files.map((file) => file.bytes)).toEqual([PNG, Buffer.from("héllo\n")]);
    expect(materializeArtifacts(dir, plan)).toEqual(files);
    for (const file of files) {
      expect(readFileSync(join(dir, file.path))).toEqual(file.bytes);
      expect(statSync(join(dir, file.path)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, file.path, "..")).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses missing or changed media with the original messages", () => {
    const dir = agentDir();
    const media = `.pi-state/media/${digest(PNG)}.png`;
    const plan = artifacts([{ name: "logo.png", media: `media:${digest(PNG)}.png` }], T);
    expect(() => materializeArtifacts(dir, plan)).toThrow(`media file not found: ${media}`);
    saveMedia(dir, "image/png", PNG.toString("base64"));
    writeFileSync(join(dir, media), "changed");
    expect(() => materializeArtifacts(dir, plan)).toThrow(`media file changed since it was saved: ${media}`);
    expect(existsSync(join(dir, plan[0]!.path))).toBe(false);
  });

  it("refuses unsafe media and artifact paths without writing outside the folder", () => {
    const dir = agentDir(), outside = agentDir();
    mkdirSync(join(dir, ".pi-state"));
    symlinkSync(outside, join(dir, ".pi-state/media"));
    const plan = artifacts([{ name: "logo.png", media: `media:${digest(PNG)}.png` }], T);
    expect(() => materializeArtifacts(dir, plan)).toThrow("media must not use a symlink");
    for (const path of ["../escape.txt", join(outside, "escape.txt")]) {
      expect(() => materializeArtifacts(dir, [{ path, content: "no" }])).toThrow("artifact must refer to a file inside the agent folder");
    }
    symlinkSync(outside, join(dir, ".pi-state/artifacts"));
    expect(() => materializeArtifacts(dir, artifacts([{ name: "a.txt", content: "no" }], T))).toThrow("artifact must not use a symlink");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("clearOwnUploads", () => {
  const me = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const ids = ["550e8400-e29b-41d4-a716-446655440001", "550e8400-e29b-41d4-a716-446655440002"];
  const listing: CliResult = { outcome: "ok", data: { artifacts: [
    { id: T, uploaded_by_id: T },
    ...ids.map((id) => ({ id, uploaded_by_id: me.toUpperCase() })),
  ] } };
  function command(replies: CliResult[]) {
    const calls: string[][] = [];
    return { calls, run: async (args: string[]): Promise<CliResult> => {
      calls.push(args);
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected command");
      return reply;
    } };
  }
  it("lists only this agent's uploads and deletes each in order", async () => {
    const { calls, run } = command([listing, { outcome: "ok" }, { outcome: "ok" }]);
    expect(await clearOwnUploads(T, me, run)).toBeNull();
    expect(calls).toEqual([["artifact", "list", "--limit=100", "--", T], ...ids.map((id) => ["artifact", "delete", "--", T, id])]);
  });
  it.each([
    { outcome: "failed", error: "refused" },
    { outcome: "uncertain", error: "timeout" },
    { outcome: "ok", data: null },
    { outcome: "ok", data: { artifacts: [{ id: "--bad", uploaded_by_id: me }] } },
  ] satisfies CliResult[])("stops on a malformed or non-ok list: %j", async (reply) => {
    const { calls, run } = command([reply]);
    expect(await clearOwnUploads(T, me, run)).toBe(`could not list earlier uploads: ${"error" in reply ? reply.error : "unreadable artifact list"}`);
    expect(calls).toHaveLength(1);
  });
  it.each(["failed", "uncertain"] as const)("stops at the first %s delete", async (outcome) => {
    const { calls, run } = command([listing, { outcome, error: "stopped" }]);
    expect(await clearOwnUploads(T, me, run)).toBe(`could not delete earlier upload ${ids[0]}: stopped`);
    expect(calls).toHaveLength(2);
  });
});
