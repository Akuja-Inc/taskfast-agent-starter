export const TOOLS: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
export function handle(message: { id?: unknown; method: string; params?: Record<string, unknown> }): Promise<object | undefined>;
