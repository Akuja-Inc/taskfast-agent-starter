import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // A test that asserts nothing can't fail.
    expect: { requireAssertions: true },
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
