import type { CallToolResult } from "@earendil-works/pi-mcp";
import { expect, it } from "vitest";
import { mcpOutput } from "./mcp-output.js";

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const MAX_BYTES = 32 * 1024;

it("preserves structured content alongside a distinct textual summary", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "Found one document." }],
    structuredContent: { documentId: 42 },
  };
  expect(mcpOutput(result, [])).toBe('Found one document.\n{\n  "documentId": 42\n}');
});

it("emits structured-only results once, including arrays and null", () => {
  expect(mcpOutput({ content: [], structuredContent: { count: 1 } }, [])).toBe('{\n  "count": 1\n}');
  expect(mcpOutput({ content: [], structuredContent: [1, 2] }, [])).toBe('[\n  1,\n  2\n]');
  expect(mcpOutput({ content: [], structuredContent: null }, [])).toBe("null");
  expect(mcpOutput({ content: [] }, [])).toBe("");
});

it("redacts synthetic credential values in raw text and structured results", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "token test-token-123 then Bearer test-header" }],
    structuredContent: { credential: "test-token-123" },
  };
  expect(mcpOutput(result, ["test-token-123", "Bearer test-header"])).toBe(
    'token [redacted] then [redacted]\n{\n  "credential": "[redacted]"\n}',
  );
});

it("keeps normal text and omits direct and embedded image data", () => {
  expect(mcpOutput({ content: [
    { type: "text", text: "Preview:" },
    { type: "image", mimeType: "image/png", data: "private-image-bytes" },
    { type: "resource", resource: { uri: "file:///preview", mimeType: "image/jpeg", blob: "private-blob" } },
  ] }, [])).toBe("Preview:\n[image/png image omitted]\n[image/jpeg image omitted]");
});

it("leaves an exact 32 KiB result intact and includes the marker within the cap", () => {
  const exact = "a".repeat(MAX_BYTES);
  expect(mcpOutput(textResult(exact), [])).toBe(exact);
  const output = mcpOutput(textResult(`${exact}b`), []);
  expect(output).toBe(`${"a".repeat(32756)}\n[truncated]`);
  expect(Buffer.byteLength(output, "utf8")).toBe(MAX_BYTES);
});

it.each(["é", "界", "😀"])("truncates %s at a complete UTF-8 codepoint", (character) => {
  const output = mcpOutput(textResult(character.repeat(MAX_BYTES)), []);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  expect(output).toMatch(/\[truncated\]$/);
  expect(output).not.toContain("\ufffd");
  expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
  const prefix = output.slice(0, -"\n[truncated]".length);
  expect(prefix.length).toBeGreaterThan(0);
  expect([...prefix].every((point) => point === character)).toBe(true);
});

it.each(["\ud800", "\udc00"])("counts lone surrogate %j by its UTF-8 encoded size", (surrogate) => {
  const output = mcpOutput(textResult(`${surrogate}界`.repeat(MAX_BYTES)), []);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  expect(output).toMatch(/\[truncated\]$/);
});

it("does not split an astral surrogate pair at the last available byte", () => {
  const prefix = "a".repeat(32755);
  expect(mcpOutput(textResult(`${prefix}😀${"z".repeat(20)}`), [])).toBe(`${prefix}\n[truncated]`);
});

it("redacts a synthetic secret crossing the cap before truncating", () => {
  const secret = "synthetic-credential-that-crosses-the-boundary";
  const prefix = "a".repeat(32745);
  expect(mcpOutput(textResult(`${prefix}${secret}`), [secret])).toBe(`${prefix}[redacted]`);
  const output = mcpOutput(textResult(`${prefix}${secret}${"z".repeat(100)}`), [secret]);
  expect(output).toBe(`${prefix}[redacted]z\n[truncated]`);
  expect(Buffer.byteLength(output, "utf8")).toBe(MAX_BYTES);
});

it("caps the expanded redaction text, not just the original text", () => {
  const output = mcpOutput(textResult("s".repeat(4000)), ["s"]);
  expect(output).not.toContain("s");
  expect(output).toMatch(/\[truncated\]$/);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
});

it("formats error results as text without changing their error flag", () => {
  const result: CallToolResult = { ...textResult("Failed: test-token-123"), isError: true };
  expect(mcpOutput(result, ["test-token-123"])).toBe("Failed: [redacted]");
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "Failed: test-token-123" }]);
});
