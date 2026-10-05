import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appBuildMetadata } from "./app-release";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "motorist-release-"));
  roots.push(root);
  function write(file: string, content: string) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  write("src/app/page.tsx", "application");
  write("public/sw.js", "worker");
  write("package.json", '{"dependencies":{}}');
  return { root, write };
}

describe("cross-environment release identity", () => {
  it("keeps the code through merges/rebuilds while recording each build date", () => {
    const app = fixture();
    const test = appBuildMetadata(app.root, new Date("2026-10-05T08:00:00Z"));
    app.write(".git/HEAD", "different-production-merge");
    app.write(".env.local", "MOTORIST_APP_ENV=production\nPRIVATE_KEY=secret");
    const production = appBuildMetadata(app.root, new Date("2026-10-06T09:00:00Z"));
    expect(production.code).toBe(test.code);
    expect(test.code).toMatch(/^[a-f0-9]{12}$/);
    expect(production.builtAt).not.toBe(test.builtAt);
  });

  it.each(["src/app/page.tsx", "public/sw.js", "package.json", "next.config.ts", "scripts/build.mjs"])(
    "changes the version when the application input %s changes", file => {
      const app = fixture();
      const previous = appBuildMetadata(app.root).code;
      app.write(file, "changed application input");
      expect(appBuildMetadata(app.root).code).not.toBe(previous);
    },
  );

  it("ignores documentation, tests and unrelated applications", () => {
    const app = fixture();
    const previous = appBuildMetadata(app.root).code;
    for (const file of ["AGENTS.md", "docs/release.md", "src/test/stubs.ts", "src/app/page.test.tsx", "scripts/app-release.test.ts", "e2e/update.spec.ts", "apps/testovanie/page.tsx"]) {
      app.write(file, "non-application change");
    }
    expect(appBuildMetadata(app.root).code).toBe(previous);
  });

  it("detects renames and deletions as well as changed file content", () => {
    const app = fixture();
    const previous = appBuildMetadata(app.root).code;
    app.write("src/app/renamed.tsx", "application");
    rmSync(join(app.root, "src/app/page.tsx"));
    const renamed = appBuildMetadata(app.root).code;
    expect(renamed).not.toBe(previous);
    rmSync(join(app.root, "public/sw.js"));
    expect(appBuildMetadata(app.root).code).not.toBe(renamed);
  });
});
