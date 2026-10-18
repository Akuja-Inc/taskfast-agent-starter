import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import { redact } from "./mcp-config.js";
import { MEDIA_TYPES } from "./media.js";

const MAX_BYTES = 32 * 1024;
const TRUNCATED = "\n[truncated]";

// media turns a direct image or embedded media blob into the line the model reads.
export function mcpOutput(result: CallToolResult, secrets: readonly string[], media = (mimeType: string, _data: string) => `[${mimeType} ${mimeType.startsWith("video/") ? "video" : "image"} omitted]`): string {
  // Pi replaces non-image blobs with placeholders. Capture approved video types
  // from the original blocks first; resource links remain text and are never fetched.
  const parts = (result.content ?? []).flatMap((block) => {
    if (block.type === "resource" && "blob" in block.resource) {
      const { mimeType, blob } = block.resource;
      if (mimeType?.startsWith("video/") && Object.hasOwn(MEDIA_TYPES, mimeType)) return [media(mimeType, blob)];
    }
    return toLlmContent({ content: [block] }).map((part) => part.type === "text" ? part.text : media(part.mimeType, part.data));
  });
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  // Redact before cutting so even a credential that crosses the boundary is removed.
  const text = redact(parts.join("\n"), secrets);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_BYTES) return text;
  let end = MAX_BYTES - Buffer.byteLength(TRUNCATED, "utf8");
  // The first excluded byte must not be a UTF-8 continuation byte.
  while ((bytes.readUInt8(end) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + TRUNCATED;
}
