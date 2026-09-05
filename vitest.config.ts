import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    exclude: ["tests/**/*.test.mjs", "e2e/**", ".context/**", "**/node_modules/**", "**/.next/**"],
  },
});
