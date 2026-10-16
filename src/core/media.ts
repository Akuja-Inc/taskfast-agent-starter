import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { folderFile } from "./folder.js";

// Images an approved MCP tool returns, kept as files so the model can deliver them by
// handle without ever holding their bytes or naming a path. The server stores whatever
// type the CLI reports from the file name and never checks the bytes, so these do.
export const MEDIA_PATH = ".pi-state/media";
export const MEDIA_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", magic: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
// Under the server's 8,000,000-byte multipart limit, with room for the form around the file.
export const MAX_MEDIA_BYTES = 7 * 1024 * 1024;
export const mediaDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Saves one image from a tool result and returns the line the model reads in its place.
export function saveMedia(agentDir: string, mimeType: string, data: string): string {
  const type = MEDIA_TYPES[mimeType];
  if (!type) return `[${mimeType} image omitted]`;
  // Base64 holds 3 bytes in every 4 characters, so the text alone shows an image too large.
  if (data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) return `[${mimeType} image omitted: larger than 7 MiB]`;
  const bytes = BASE64.test(data) ? Buffer.from(data, "base64") : Buffer.alloc(0);
  if (bytes.length > MAX_MEDIA_BYTES) return `[${mimeType} image omitted: larger than 7 MiB]`;
  if (!bytes.length || !type.magic(bytes)) return `[${mimeType} image omitted]`;
  const handle = `${mediaDigest(bytes)}.${type.ext}`;
  try {
    const path = folderFile({ agentDir, path: `${MEDIA_PATH}/${handle}`, resource: "media" });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Content-addressed, so a file already there holds these bytes.
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
  } catch {
    return `[${mimeType} image omitted: could not save it]`;
  }
  return `[${mimeType} saved as media:${handle}, ${bytes.length} bytes]`;
}
