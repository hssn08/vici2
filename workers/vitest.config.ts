// W01 — vitest config for workers package.
// Includes:
//   - src/lib/__tests__/*.test.ts  (shared lib unit tests, W01)
//   - test/**/*.test.ts            (integration + job-level tests)
// Excludes legacy node:test-format tests (R01 recording-log-writer index.test.ts).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/lib/__tests__/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: [
      "src/jobs/recording-log-writer/index.test.ts",
    ],
  },
});
