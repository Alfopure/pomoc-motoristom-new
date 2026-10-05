import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Hash application inputs, not Git commits or environment-specific secrets.
// A merge/rebuild of identical code keeps its release code on TEST and production.
const applicationInputs = [
  "src", "public", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "next.config.ts", "tsconfig.json", "postcss.config.mjs", "vercel.json",
];

export function appBuildMetadata(root = process.cwd(), now = new Date()) {
  const files: string[] = [];
  function collect(relativePath: string) {
    if (/(^|\/)(__tests__|test)(\/|$)|\.(test|spec)\.[^/]+$/.test(relativePath)) return;
    const absolutePath = join(root, relativePath);
    if (!existsSync(absolutePath)) return;
    if (statSync(absolutePath).isDirectory()) {
      for (const entry of readdirSync(absolutePath)) collect(`${relativePath}/${entry}`);
    } else {
      files.push(relativePath);
    }
  }
  for (const input of applicationInputs) collect(input);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const content = readFileSync(join(root, file));
    hash.update(`${file}\0${content.byteLength}\0`).update(content);
  }
  return { code: hash.digest("hex").slice(0, 12), builtAt: now.toISOString() };
}
