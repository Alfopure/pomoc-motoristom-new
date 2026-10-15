/// <reference types="node" />
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportedConfig, Mod } from "expo/config-plugins";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/with-telnyx-reconnect-guard.cjs") as ((config: ExportedConfig) => ExportedConfig) & {
  patchTelnyxSource: (source: string, version: string) => string;
  patchNetworkMonitorSource: (source: string, version: string) => string;
  patchCallSource: (source: string, version: string) => string;
  patchPeerSource: (source: string, version: string) => string;
  patchPodfile: (source: string) => string;
  patchInstalledSdk: (podsRoot: string, version: string) => void;
};
const podfile = `platform :ios, '16.4'
target 'Linka' do
  post_install do |installer|
    react_native_post_install(installer)
  end
end
`;
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("pinned iOS voice SDK reconnect lifecycle hook", () => {
  it.each([
    { variant: "test", voice: true, go: false },
    { variant: "test", voice: false, go: true },
    { variant: "test", voice: false, go: false },
    { variant: "production", voice: false, go: false },
  ])("requires the native guard only for the explicit TEST voice build ($variant/$voice/$go)", async ({ variant, voice, go }) => {
    vi.stubEnv("APP_VARIANT", variant); vi.stubEnv("EXPO_PUBLIC_APP_ENV", variant);
    vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", voice ? "1" : "0"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", go ? "1" : "0");
    const config = (await import("../app.config")).default;
    expect(config.plugins?.includes("./plugins/with-telnyx-reconnect-guard.cjs")).toBe(voice);
    expect(config.ios?.infoPlist?.LinkaNativeVoiceEnabled).toBe(voice ? true : undefined);
  });

  it("injects one post-install guard without replacing React Native's hook", () => {
    const patched = plugin.patchPodfile(podfile);
    expect(patched).toContain("react_native_post_install(installer)");
    expect(patched.indexOf("with-telnyx-reconnect-guard.cjs")).toBeLessThan(patched.indexOf("react_native_post_install"));
    expect(patched).toContain("installer.sandbox.root.to_s");
    expect(patched).toContain("target.root_spec.version.to_s");
    expect(patched).toContain("raise 'Telnyx lifecycle patch failed");
    expect(patched.match(/post_install do/g)).toHaveLength(1);
    expect(plugin.patchPodfile(patched)).toBe(patched);
  });

  it("uses the installer-provided version without requiring generated Local Podspecs metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "linka-voice-pods-"));
    try {
      const folder = join(root, "TelnyxRTC/TelnyxRTC/Telnyx");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "TxClient.swift"), "// deliberately unreviewed source");
      expect(() => plugin.patchInstalledSdk(root, "4.2.2")).toThrow(/unexpected SDK source/);
      expect(() => plugin.patchInstalledSdk(root, "4.2.3")).toThrow(/unsupported SDK version/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["", podfile + podfile, podfile.replace("|installer|", "|another|")])("refuses unsupported CocoaPods structure", source => {
    expect(() => plugin.patchPodfile(source)).toThrow(/expected one CocoaPods/);
  });

  it("refuses a modified existing hook and preserves unrelated Podfile contents", () => {
    const patched = plugin.patchPodfile(podfile);
    expect(() => plugin.patchPodfile(patched.replace("unless system", "if system"))).toThrow(/hook changed/);
    expect(patched.slice(patched.indexOf("    react_native_post_install"))).toBe(podfile.slice(podfile.indexOf("    react_native_post_install")));
  });

  it.each(["4.2.1", "4.2.3", "4.3.0"])("requires re-review of SDK version %s", version => {
    expect(() => plugin.patchTelnyxSource("", version)).toThrow(/unsupported SDK version/);
    expect(() => plugin.patchNetworkMonitorSource("", version)).toThrow(/unsupported SDK version/);
    expect(() => plugin.patchCallSource("", version)).toThrow(/unsupported SDK version/);
    expect(() => plugin.patchPeerSource("", version)).toThrow(/unsupported SDK version/);
  });

  it.each(["", "// Modified network monitor", "    private init() {"])("rejects unknown network monitor source", source => {
    expect(() => plugin.patchNetworkMonitorSource(source, "4.2.2")).toThrow(/unexpected network monitor source/);
  });

  it.each(["", "// Modified SDK 4.2.2", "internal var txConfig: TxConfig?"])("rejects unknown source rather than applying a partial SDK patch", source => {
    expect(() => plugin.patchTelnyxSource(source, "4.2.2")).toThrow(/unexpected SDK source/);
  });

  it.each(["", "// Unknown microphone source"])("rejects unknown Call and Peer before patching", source => {
    expect(() => plugin.patchCallSource(source, "4.2.2")).toThrow(/unexpected Call source/);
    expect(() => plugin.patchPeerSource(source, "4.2.2")).toThrow(/unexpected Peer source/);
  });

  it("config registration edits only the Podfile mod, without touching installed dependencies", async () => {
    const config = plugin({ name: "Fixture", slug: "fixture" });
    const podfileMod = (config.mods!.ios! as { podfile: Mod<{ contents: string; language: "rb" }> }).podfile;
    const result = await podfileMod({ ...config, modResults: { contents: podfile, language: "rb" }, modRawConfig: config,
      modRequest: { projectRoot: "/fixture", platformProjectRoot: "/fixture/ios", platform: "ios", modName: "podfile", introspect: false } });
    expect(result.modResults.contents).toBe(plugin.patchPodfile(podfile));
    expect(config.mods?.android).toBeUndefined();
  });
});
