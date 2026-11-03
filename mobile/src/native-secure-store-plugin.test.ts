/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportedConfig } from "expo/config-plugins";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/with-draft-secure-store.cjs") as ((config: ExportedConfig) => ExportedConfig) & {
  patchSecureStoreSource: (source: string, version: string) => string;
};
const sourcePath = "android/src/main/java/expo/modules/securestore/SecureStoreModule.kt";
const originalHash = "72c670b538732977ef132759ce810c5719943ce6082195a58ad5a432d4ac1075";
const patchedHash = "00c07cddfab609e7dfc0fd5e8395f111569635f26d6666be5d489a3fe4777965";
const diskReturn = "    return prefs.edit().putString(key, encryptedItemString).commit()";
const diskGuard = `    val success = prefs.edit().putString(key, encryptedItemString).commit()
    if (!success) {
      throw WriteException("Could not persist the encrypted item to SecureStore", key, keychainService)
    }
    return success`;
const capability = '    Constant("pmDraftDiskCommitChecked") { 1 }\n';
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const installed = readFileSync(join(dirname(require.resolve("expo-secure-store/package.json")), sourcePath), "utf8");
const original = hash(installed) === patchedHash ? installed.replace(capability, "").replace(diskGuard, diskReturn) : installed;
const roots: string[] = [];
function fixture(version = "57.0.4", source = original) {
  const root = mkdtempSync(join(tmpdir(), "motorist-secure-store-plugin-")); roots.push(root);
  const moduleRoot = join(root, "node_modules/expo-secure-store");
  const file = join(moduleRoot, sourcePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(join(moduleRoot, "package.json"), JSON.stringify({ name: "expo-secure-store", version }));
  writeFileSync(file, source);
  return { root, file };
}
function configured() { return plugin({ name: "Fixture", slug: "fixture" }); }
function runMod(projectRoot: string, introspect = false, platform: "android" | "ios" = "android") {
  const config = configured();
  return config.mods!.android!.dangerous!({ ...config, modResults: {},
    modRawConfig: config, modRequest: { projectRoot, platform, introspect, platformProjectRoot: join(projectRoot, platform), modName: "dangerous" } });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pinned Android SecureStore disk acknowledgement plugin", () => {
  it("applies only native capability and exact encrypted-write guard", () => {
    expect(hash(original)).toBe(originalHash);
    const patched = plugin.patchSecureStoreSource(original, "57.0.4");
    expect(hash(patched)).toBe(patchedHash);
    expect(patched.replace(capability, "").replace(diskGuard, diskReturn)).toBe(original);
    expect(plugin.patchSecureStoreSource(patched, "57.0.4")).toBe(patched);
  });
  it.each(["57.0.3", "57.0.5", "58.0.0"])("rejects other package version %s even with matching source", version => {
    expect(() => plugin.patchSecureStoreSource(original, version)).toThrow(/version/i);
  });
  it.each([
    original + "\n", original.replace(diskReturn, diskGuard),
    original.replace('    Name("ExpoSecureStore")\n', '    Name("ExpoSecureStore")\n' + capability),
    original.replace("private suspend fun setItemImpl", "private suspend fun tamperedSetItemImpl"),
  ])("rejects partial or tampered full source", source => {
    expect(() => plugin.patchSecureStoreSource(source, "57.0.4")).toThrow(/source/i);
  });
  it("registers Android only without resolving or modifying dependencies during config evaluation", () => {
    const { file } = fixture();
    const config = configured();
    expect(config.mods?.android?.dangerous).toBeTypeOf("function");
    expect(config.mods?.ios).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  it("skips introspection and non-Android execution even with no resolvable package", async () => {
    await expect(runMod("/missing/task-fixture", true)).resolves.toBeDefined();
    await expect(runMod("/missing/task-fixture", false, "ios")).resolves.toBeDefined();
  });
  it("patches only the resolved temporary module during Android prebuild and is idempotent", async () => {
    const { root, file } = fixture();
    await runMod(root); expect(hash(readFileSync(file, "utf8"))).toBe(patchedHash);
    await runMod(root); expect(hash(readFileSync(file, "utf8"))).toBe(patchedHash);
    expect(readFileSync(join(dirname(require.resolve("expo-secure-store/package.json")), sourcePath), "utf8")).toBe(installed);
  });
  it.each([{ version: "57.0.5", source: original }, { version: "57.0.4", source: original + "\n" }])("fails prebuild without modifying unsupported fixture", async ({ version, source }) => {
    const { root, file } = fixture(version, source);
    await expect(runMod(root)).rejects.toThrow(); expect(readFileSync(file, "utf8")).toBe(source);
  });
  it("forces only SecureStore source compilation instead of its bundled Maven artifact", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.expo.autolinking.android.buildFromSource).toEqual(["expo-secure-store"]);
  });
});
