#!/usr/bin/env node
// Requires an offline checkout of the exact pinned vendor source. No network.
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const plugin = require("../../mobile/plugins/with-telnyx-reconnect-guard.cjs");
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("Pass the pinned checkout's TelnyxRTC/Telnyx directory.");
const client = readFileSync(join(sourceRoot, "TxClient.swift"), "utf8");
const monitor = readFileSync(join(sourceRoot, "Utils/NetworkMonitor.swift"), "utf8");
const patchedClient = plugin.patchTelnyxSource(client, "4.2.2");
const patchedMonitor = plugin.patchNetworkMonitorSource(monitor, "4.2.2");
let checks = 0;
function scenario(run) {
  const root = mkdtempSync(join(tmpdir(), "linka-sdk-install-"));
  try {
    const folder = join(root, "TelnyxRTC/TelnyxRTC/Telnyx");
    mkdirSync(join(folder, "Utils"), { recursive: true });
    const clientFile = join(folder, "TxClient.swift");
    const monitorFile = join(folder, "Utils/NetworkMonitor.swift");
    writeFileSync(clientFile, client); writeFileSync(monitorFile, monitor);
    run({ root, clientFile, monitorFile }); checks += 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
scenario(({ root, clientFile, monitorFile }) => {
  chmodSync(clientFile, 0o444); chmodSync(monitorFile, 0o444);
  plugin.patchInstalledSdk(root, "4.2.2"); plugin.patchInstalledSdk(root, "4.2.2");
  assert.equal(readFileSync(clientFile, "utf8"), patchedClient);
  assert.equal(readFileSync(monitorFile, "utf8"), patchedMonitor);
  assert.equal(statSync(clientFile).mode & 0o777, 0o444);
  assert.equal(statSync(monitorFile).mode & 0o777, 0o444);
});
scenario(({ root, clientFile, monitorFile }) => {
  writeFileSync(monitorFile, "// unexpected monitor");
  assert.throws(() => plugin.patchInstalledSdk(root, "4.2.2"), /unexpected network monitor source/);
  assert.equal(readFileSync(clientFile, "utf8"), client);
  assert.equal(readFileSync(monitorFile, "utf8"), "// unexpected monitor");
});
scenario(({ root, clientFile, monitorFile }) => {
  writeFileSync(clientFile, "// unexpected client");
  assert.throws(() => plugin.patchInstalledSdk(root, "4.2.2"), /unexpected SDK source/);
  assert.equal(readFileSync(monitorFile, "utf8"), monitor);
});
scenario(({ root, clientFile, monitorFile }) => {
  rmSync(monitorFile);
  assert.throws(() => plugin.patchInstalledSdk(root, "4.2.2"), /ENOENT/);
  assert.equal(readFileSync(clientFile, "utf8"), client);
});
scenario(({ root, clientFile, monitorFile }) => {
  assert.throws(() => plugin.patchInstalledSdk(root, "4.2.3"), /unsupported SDK version/);
  assert.equal(readFileSync(clientFile, "utf8"), client);
  assert.equal(readFileSync(monitorFile, "utf8"), monitor);
});
scenario(({ root, clientFile, monitorFile }) => {
  writeFileSync(clientFile, patchedClient);
  plugin.patchInstalledSdk(root, "4.2.2");
  assert.equal(readFileSync(clientFile, "utf8"), patchedClient);
  assert.equal(readFileSync(monitorFile, "utf8"), patchedMonitor);
});
console.log(JSON.stringify({ kind: "actual-pinned-SDK-installation-controlled-filesystem", checks, passed: true, providerNetworkingExecuted: false }));
