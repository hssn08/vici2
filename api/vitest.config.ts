import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/__tests__/**/*.spec.ts"],
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
      include: ["src/auth/**/*.ts"],
      exclude: ["src/auth/lua/**", "src/auth/index.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
