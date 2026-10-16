import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import { redact } from "./mcp-config.js";

const MAX_BYTES = 32 * 1024;
const TRUNCATED = "\n[truncated]";

// image turns an image block (direct or an embedded blob) into the line the model reads.
export function mcpOutput(result: CallToolResult, secrets: readonly string[], image = (mimeType: string, _data: string) => `[${mimeType} image omitted]`): string {
  // Convert only the blocks: append structured data ourselves, including when blocks are empty.
  const parts = toLlmContent({ content: result.content }).map((part) =>
    part.type === "text" ? part.text : image(part.mimeType, part.data),
  );
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
