import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("retired AI copy setup exits before reading credentials or invoking tools", () => {
  const directory = mkdtempSync(join(tmpdir(), "retired-ai-setup-"));
  try {
    const marker = join(directory, "executed");
    const secrets = join(directory, "secrets");
    // Sourcing this file is itself a failure, even if no provider CLI follows.
    writeFileSync(secrets, 'printf sourced > "$EXECUTION_MARKER"\n');
    for (const tool of ["vercel", "supabase", "psql", "curl", "wget", "python3", "node"]) {
      const path = join(directory, tool);
      writeFileSync(path, '#!/bin/sh\nprintf command > "$EXECUTION_MARKER"\nexit 99\n');
      chmodSync(path, 0o755);
    }
    const result = spawnSync("/bin/bash", [fileURLToPath(new URL("../scripts/setup-ai-demo-copy.sh", import.meta.url))], {
      env: { PATH: directory, AI_DEMO_COPY_SECRETS: secrets, EXECUTION_MARKER: marker },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retired/i);
    assert.equal(existsSync(marker), false, "must not source secrets or run provider commands");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
