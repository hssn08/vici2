// D06 — vitest config for workers package.
// Excludes legacy node:test-format tests in src/ (R01 recording-log-writer).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["src/**/*.test.ts"],
  },
});
