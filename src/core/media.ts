import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { folderFile } from "./folder.js";

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
