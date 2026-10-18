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
function ftyp(bytes: Buffer): string {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return "";
  const size = bytes.readUInt32BE(0);
  return size >= 16 && size <= bytes.length ? bytes.toString("latin1", 8, 12) : "";
}
export const MEDIA_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", magic: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  "video/mp4": { ext: "mp4", magic: (b) => /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(ftyp(b)) },
  "video/quicktime": { ext: "mov", magic: (b) => ftyp(b) === "qt  " },
  // Signature checks, not a decoder: distinguish WebM's DocType from Matroska.
  "video/webm": { ext: "webm", magic: (b) => b.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")) && b.subarray(4, 64).includes(Buffer.from("4282847765626d", "hex")) },
};
export const mediaDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// Saves one media block before returning its handle. Images keep the server's size
// limit; video has a lower capture cap to fit the pinned MCP transport.
export function saveMedia(agentDir: string, mimeType: string, data: string): string {
  const kind = mimeType.startsWith("video/") ? "video" : "image";
  const omitted = `[${mimeType} ${kind} omitted]`;
  const type = Object.hasOwn(MEDIA_TYPES, mimeType) ? MEDIA_TYPES[mimeType] : undefined;
  if (!type) return omitted;
  const tooLarge = `[${mimeType} video omitted: larger than 50 MiB]`;
  if (kind === "video" && data.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) return tooLarge;
  // Node decodes base64 leniently, skipping bad characters; only exact padded base64
  // re-encodes to the same text. A regex here could overflow on a large image.
  const bytes = Buffer.from(data, "base64");
  if (kind === "video" && bytes.length > MAX_VIDEO_BYTES) return tooLarge;
  if (!bytes.length || bytes.toString("base64") !== data || !type.magic(bytes)) return omitted;
  const handle = `${mediaDigest(bytes)}.${type.ext}`;
  try {
    const path = folderFile({ agentDir, path: `${MEDIA_PATH}/${handle}`, resource: "media" });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Content-addressed, so a file already there holds these bytes.
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
  } catch {
    return `[${mimeType} ${kind} omitted: could not save it]`;
  }
  return `[${mimeType} saved as media:${handle}, ${bytes.length} bytes]`;
}
