import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/__tests__/**/*.spec.ts", "src/**/__tests__/**/*.test.ts"],
    exclude: ["test/db/**", "node_modules/**"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 20000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/auth/**/*.ts",
        "src/dnc/**/*.ts",
        "src/import/**/*.ts",
        "src/statuses/**/*.ts",
        "src/reporting/**/*.ts",
        "src/scripts/**/*.ts",
      ],
      exclude: ["src/auth/lua/**", "src/auth/index.ts", "src/dnc/lua/**"],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
