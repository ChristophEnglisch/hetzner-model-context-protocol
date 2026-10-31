import { defineConfig } from "vitest/config";

// Teststufe 2 (01 §9.5): runs against the built dist/index.js; `npm run test:contract` builds first.
export default defineConfig({
  test: {
    include: ["tests/contract/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
