export const TOOLS: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
export const PNG: string;
export const VIDEO: { "video/mp4": Buffer; "video/webm": Buffer; "video/quicktime": Buffer };
export const FILES: { "application/pdf": Buffer; "application/msword": Buffer; "application/zip": Buffer; "application/x-tar": Buffer; "application/gzip": Buffer };
export function handle(message: { id?: unknown; method: string; params?: Record<string, unknown> }): Promise<object | undefined>;
