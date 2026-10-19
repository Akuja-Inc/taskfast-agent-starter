export const TOOLS: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
export const PNG: string;
export const VIDEO: { "video/mp4": Buffer; "video/webm": Buffer; "video/quicktime": Buffer };
export function handle(message: { id?: unknown; method: string; params?: Record<string, unknown> }): Promise<object | undefined>;
