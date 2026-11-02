import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * The telephony suites once more with the call-speed switches that have
 * shipped turned on (`pnpm test:latency-flags`). The default run keeps them
 * off, which is the contract every switch must preserve; this run proves the
 * journeys still hold with them on. Tests that state the switch-off contract
 * pin their flags explicitly. Add each stage's switches when it ships.
 */
export default mergeConfig(base, defineConfig({
  test: {
    env: {
      TELEPHONY_LATENCY_FLAGS: JSON.stringify({
        internal_lean_path: true, bridged_observation_fast: true, claim_holding_drain: true, fresh_after_write: true,
      }),
    },
    include: ["src/server/telephony", "src/app/api/telephony", "src/server/mobile", "src/components/dispatch", "src/lib/telephony"]
      .map(directory => `${directory}/**/*.{test,spec}.?(c|m)[jt]s?(x)`),
  },
}));
