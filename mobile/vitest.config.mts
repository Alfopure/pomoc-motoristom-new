import { defineConfig } from "vitest/config";

// Native-independent contract and persistence tests; no live provider access.

export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
