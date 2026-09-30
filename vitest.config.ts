import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // `dist/` holds compiled copies of the same test files; without this the
    // suite runs each test twice (once stale) and reports inflated counts.
    exclude: ["node_modules/**", "dist/**"],
    // Redis-backed integration tests talk to a real server.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
