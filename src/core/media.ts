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
export const mediaDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// Saves one image from a tool result and returns the line the model reads in its place.
// The server sets the size limit: an upload over it is refused like any other known
// refusal, and the next submit clears what it left on the task.
export function saveMedia(agentDir: string, mimeType: string, data: string): string {
  const type = MEDIA_TYPES[mimeType];
  if (!type) return `[${mimeType} image omitted]`;
  // Node decodes base64 leniently, skipping bad characters; only exact padded base64
  // re-encodes to the same text. A regex here could overflow on a large image.
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.toString("base64") !== data || !type.magic(bytes)) return `[${mimeType} image omitted]`;
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
