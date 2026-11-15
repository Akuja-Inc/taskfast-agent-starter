import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { folderFile } from "./folder.js";
import type { Command } from "./policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (why: string): never => { throw new Error(why); };

// Media an approved MCP tool returns, kept as files so the model can deliver them by
// handle without ever holding their bytes or naming a path. The server stores whatever
// type the CLI reports from the file name and never checks the bytes, so these do.
export const MEDIA_PATH = ".pi-state/media";
// One base64 video fits the existing 80 MiB MCP message budget. The server's
// 200 MiB video cap is not reachable through this pinned transport and timeout.
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const VIDEO_CAP = `${MAX_VIDEO_BYTES / 1024 / 1024} MiB`;
// The one place prompts and tool descriptions state which videos the kit takes.
export const VIDEO_LIMIT = `Video capture supports MP4, WebM and MOV up to ${VIDEO_CAP} per file.`;
function ftypBrand(bytes: Buffer): string {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return "";
  const size = bytes.readUInt32BE(0);
  return size >= 16 && size <= bytes.length ? bytes.toString("latin1", 8, 12) : "";
}
const starts = (b: Buffer, hex: string) => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
export type MediaType = { ext: string; kind: "image" | "video" | "document" | "archive"; magic: (b: Buffer) => boolean };
export const MEDIA_TYPES: Record<string, MediaType> = {
  "image/png": { ext: "png", kind: "image", magic: (b) => starts(b, "89504e470d0a1a0a") },
  "image/jpeg": { ext: "jpg", kind: "image", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", kind: "image", magic: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  "image/webp": { ext: "webp", kind: "image", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  "video/mp4": { ext: "mp4", kind: "video", magic: (b) => /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(ftypBrand(b)) },
  // Signature checks, not a decoder: distinguish WebM's DocType from Matroska.
  "video/webm": { ext: "webm", kind: "video", magic: (b) => starts(b, "1a45dfa3") && b.subarray(4, 64).includes(Buffer.from("4282847765626d", "hex")) },
  "video/quicktime": { ext: "mov", kind: "video", magic: (b) => ftypBrand(b) === "qt  " },
  "application/pdf": { ext: "pdf", kind: "document", magic: (b) => starts(b, "255044462d") },
  // A compound file header is shared by .xls and .msi; the kit never opens the file.
  "application/msword": { ext: "doc", kind: "document", magic: (b) => starts(b, "d0cf11e0a1b11ae1") },
  // An empty ZIP has only an end record, so it delivers nothing and is refused.
  "application/zip": { ext: "zip", kind: "archive", magic: (b) => starts(b, "504b0304") },
  // POSIX and GNU tar mark offset 257; an old v7 tar has no mark and is refused.
  "application/x-tar": { ext: "tar", kind: "archive", magic: (b) => b.length >= 512 && b.subarray(257, 262).toString("latin1") === "ustar" },
  "application/gzip": { ext: "gz", kind: "archive", magic: (b) => starts(b, "1f8b08") },
};
const or = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : items[0]!;
// The one place prompts and tool descriptions list the binary files the kit captures.
export const MEDIA_FILES = or((["image", "video", "document", "archive"] as const).map((kind) =>
  `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} (${or(Object.values(MEDIA_TYPES).filter((type) => type.kind === kind).map((type) => `.${type.ext}`))})`));
export const mediaDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
// Own keys only, so a type such as "constructor" finds nothing.
const mediaType = (mimeType: string | undefined) => mimeType !== undefined && Object.hasOwn(MEDIA_TYPES, mimeType) ? MEDIA_TYPES[mimeType] : undefined;
export const isMediaType = (mimeType: string | undefined): mimeType is string => mediaType(mimeType) !== undefined;
// Pi hands over any image/* block, so a type outside the table is an image.
export const omittedLine = (mimeType: string, why = "") => `[${mimeType} ${mediaType(mimeType)?.kind ?? "image"} omitted${why}]`;

// Saves one media block before returning its handle. Other kinds keep the server's size
// limit; video has a lower capture cap to fit the pinned MCP transport.
export function saveMedia(agentDir: string, mimeType: string, data: string): string {
  const type = mediaType(mimeType);
  if (!type) return omittedLine(mimeType);
  const tooLarge = omittedLine(mimeType, `: larger than ${VIDEO_CAP}`);
  if (type.kind === "video" && data.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) return tooLarge;
  // Node decodes base64 leniently, skipping bad characters; only exact padded base64
  // re-encodes to the same text. A regex here could overflow on a large image.
  const bytes = Buffer.from(data, "base64");
  if (type.kind === "video" && bytes.length > MAX_VIDEO_BYTES) return tooLarge;
  if (!bytes.length || !type.magic(bytes) || bytes.toString("base64") !== data) return omittedLine(mimeType);
  const handle = `${mediaDigest(bytes)}.${type.ext}`;
  try {
    const path = folderFile({ agentDir, path: `${MEDIA_PATH}/${handle}`, resource: "media" });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Content-addressed, so a file already there holds these bytes.
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
  } catch {
    return omittedLine(mimeType, ": could not save it");
  }
  return `[${mimeType} saved as media:${handle}, ${bytes.length} bytes]`;
}

export type ArtifactFile = { path: string; content: string } | { path: string; media: string; digest: string };

// Artifacts are files the kit writes: text the model writes, or media an approved MCP
// tool returned, which code saved under .pi-state/media and named by a media: handle.
// Code stores each one under a folder it builds from the task and the bytes' digest, and
// passes that path. The model names the file, because a task's criteria can require one
// such as results.json; the name is one basename with an extension the server accepts,
// so it cannot leave its folder. The CLI picks the upload's type from that extension, so
// a media name must end in its handle's own type.
export const ARTIFACTS_PATH = ".pi-state/artifacts";
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}\.([a-z0-9]+)$/;
export const TEXT_NAMES = ["txt", "md", "csv", "json", "xml", "html", "css", "js", "svg"];
// Each binary extension a name may end in, by the media type of its file; .jpeg names a .jpg.
export const MEDIA_NAMES: Record<string, MediaType> = { ...Object.fromEntries(Object.values(MEDIA_TYPES).map((type) => [type.ext, type])), jpeg: MEDIA_TYPES["image/jpeg"]! };
const MEDIA_HANDLE = new RegExp(`^media:([0-9a-f]{16})\\.(${Object.values(MEDIA_TYPES).map((type) => type.ext).join("|")})$`);
export const NAMES = [...TEXT_NAMES, ...Object.keys(MEDIA_NAMES)].map((ext) => `.${ext}`).join(", ");
export const MAX_ARTIFACTS = 5;
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export function artifacts(v: unknown, task: string): ArtifactFile[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ARTIFACTS) bad(`artifacts must be a list of 1 to ${MAX_ARTIFACTS} files`);
  const names = new Set<string>();
  return (v as unknown[]).map((a): ArtifactFile => {
    if (a === null || typeof a !== "object" || Object.keys(a).some((k) => k !== "name" && k !== "content" && k !== "media") || ("content" in a) === ("media" in a)) bad("each artifact is { name, content } or { name, media }");
    const { name, content, media } = a as Record<string, unknown>;
    const ext = typeof name === "string" ? ARTIFACT_NAME.exec(name)?.[1] : undefined;
    if (!ext || !(TEXT_NAMES.includes(ext) || Object.hasOwn(MEDIA_NAMES, ext)) || names.has(name as string)) bad(`artifact name must be a unique file name like results.json or chart.png, ending in ${NAMES}`);
    names.add(name as string);
    if (media !== undefined) {
      const handle = typeof media === "string" ? MEDIA_HANDLE.exec(media) : null;
      if (!handle) bad(`artifact ${name as string} media must be a handle a tool result gave you, like media:0123456789abcdef.png`);
      const [, hash, type] = handle!;
      if (MEDIA_NAMES[ext!]?.ext !== type) bad(`artifact ${name as string} must end in ${Object.keys(MEDIA_NAMES).filter((n) => MEDIA_NAMES[n]!.ext === type).map((n) => `.${n}`).join(" or ")} to match its media`);
      return { path: `${ARTIFACTS_PATH}/${task}/${hash}/${name as string}`, media: `${MEDIA_PATH}/${hash}.${type}`, digest: hash! };
    }
    if (!TEXT_NAMES.includes(ext!)) bad(`artifact ${name as string} is a binary file: deliver it as { name, media } with a handle a tool result gave you`);
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : 0;
    if (bytes < 1 || bytes > MAX_ARTIFACT_BYTES) bad(`artifact ${name as string} content must be 1 to ${MAX_ARTIFACT_BYTES} bytes of text`);
    return { path: `${ARTIFACTS_PATH}/${task}/${mediaDigest(Buffer.from(content as string))}/${name as string}`, content: content as string };
  });
}

// This agent's uploads in `artifact list` output (data.artifacts[]), or null when the
// output is not that shape or an id is not a UUID.
export function ownUploads(data: unknown, agentId: string): string[] | null {
  const rows = typeof data === "object" && data !== null && "artifacts" in data ? data.artifacts : null;
  if (!Array.isArray(rows)) return null;
  const ids = rows.filter((row) => typeof row?.uploaded_by_id === "string" && row.uploaded_by_id.toLowerCase() === agentId).map((row) => row.id);
  return ids.every((id) => typeof id === "string" && UUID.test(id)) ? ids : null;
}

// Paths are content-addressed. Resolve once before reservation and dispatch these bytes.
export type ResolvedFile = { path: string; bytes: Buffer };
export function writeArtifactFiles(agentDir: string, files: ResolvedFile[]): void {
  for (const file of files) {
    const path = folderFile({ agentDir, path: file.path, resource: "artifact" });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { mode: 0o600 });
  }
}

export function materializeArtifacts(agentDir: string, files: ArtifactFile[]): ResolvedFile[] {
  const resolved = files.map((file) => {
    if ("content" in file) return { path: file.path, bytes: Buffer.from(file.content) };
    const source = folderFile({ agentDir, path: file.media, resource: "media" });
    if (!existsSync(source)) throw new Error(`media file not found: ${file.media}`);
    const bytes = readFileSync(source);
    if (mediaDigest(bytes) !== file.digest) throw new Error(`media file changed since it was saved: ${file.media}`);
    return { path: file.path, bytes };
  });
  writeArtifactFiles(agentDir, resolved);
  return resolved;
}

// Each delete is repeat-safe. Policy supplies the runtime-bound, cancellation-gated command.
// shortcut: one page of 100 uploads, page with --cursor if a task ever holds more.
export async function clearOwnUploads(task: string, agentId: string, command: (args: string[]) => ReturnType<Command>): Promise<string | null> {
  const list = await command(["artifact", "list", "--limit=100", "--", task]);
  const ids = list.outcome === "ok" ? ownUploads(list.data, agentId) : null;
  if (!ids) return `could not list earlier uploads: ${list.error ?? "unreadable artifact list"}`;
  for (const id of ids) {
    const done = await command(["artifact", "delete", "--", task, id]);
    if (done.outcome !== "ok") return `could not delete earlier upload ${id}: ${done.error ?? done.outcome}`;
  }
  return null;
}
