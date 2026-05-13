import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "src/test/unit/**/*.test.ts",
      "src/test/unit/**/*.test.tsx",
      "src/components/**/__tests__/**/*.test.ts",
      "src/components/**/__tests__/**/*.test.tsx",
      "src/lib/hooks/__tests__/**/*.test.ts",
    ],
    setupFiles: ["./src/test/setup.ts"],
  },
});
