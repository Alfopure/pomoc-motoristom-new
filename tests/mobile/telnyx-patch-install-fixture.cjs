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
const call = readFileSync(join(sourceRoot, "WebRTC/Call.swift"), "utf8");
const peer = readFileSync(join(sourceRoot, "WebRTC/Peer.swift"), "utf8");
const patchedCall = plugin.patchCallSource(call, "4.2.2");
const patchedPeer = plugin.patchPeerSource(peer, "4.2.2");
const patchedClient = plugin.patchTelnyxSource(client, "4.2.2");
const patchedMonitor = plugin.patchNetworkMonitorSource(monitor, "4.2.2");
let checks = 0;
function scenario(run) {
  const root = mkdtempSync(join(tmpdir(), "linka-sdk-install-"));
  try {
    const folder = join(root, "TelnyxRTC/TelnyxRTC/Telnyx");
    mkdirSync(join(folder, "Utils"), { recursive: true });
    mkdirSync(join(folder, "WebRTC"), { recursive: true });
    const callFile = join(folder, "WebRTC/Call.swift");
    const peerFile = join(folder, "WebRTC/Peer.swift");
    writeFileSync(callFile, call); writeFileSync(peerFile, peer);
    const clientFile = join(folder, "TxClient.swift");
    const monitorFile = join(folder, "Utils/NetworkMonitor.swift");
    writeFileSync(clientFile, client); writeFileSync(monitorFile, monitor);
    run({ root, clientFile, monitorFile, callFile, peerFile }); checks += 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
scenario(({ root, clientFile, monitorFile, callFile, peerFile }) => {
  chmodSync(callFile, 0o444); chmodSync(peerFile, 0o444);
  chmodSync(clientFile, 0o444); chmodSync(monitorFile, 0o444);
  plugin.patchInstalledSdk(root, "4.2.2"); plugin.patchInstalledSdk(root, "4.2.2");
  assert.equal(readFileSync(clientFile, "utf8"), patchedClient);
  assert.equal(readFileSync(monitorFile, "utf8"), patchedMonitor);
  assert.equal(readFileSync(callFile, "utf8"), patchedCall);
  assert.equal(readFileSync(peerFile, "utf8"), patchedPeer);
  assert.equal(statSync(callFile).mode & 0o777, 0o444);
  assert.equal(statSync(peerFile).mode & 0o777, 0o444);
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
for (const [key, original] of [["callFile", call], ["peerFile", peer]]) {
  for (const missing of [false, true]) scenario(files => {
    if (missing) rmSync(files[key]); else writeFileSync(files[key], "// unknown source");
    assert.throws(() => plugin.patchInstalledSdk(files.root, "4.2.2"), missing ? /ENOENT/ : /unexpected (Call|Peer) source/);
    assert.equal(readFileSync(files.clientFile, "utf8"), client);
    assert.equal(readFileSync(files.monitorFile, "utf8"), monitor);
    const other = key === "callFile" ? "peerFile" : "callFile";
    assert.equal(readFileSync(files[other], "utf8"), key === "callFile" ? peer : call);
    if (!missing) assert.notEqual(readFileSync(files[key], "utf8"), original);
  });
}
scenario(({root, clientFile, monitorFile, callFile, peerFile}) => {
  writeFileSync(callFile, patchedCall); writeFileSync(peerFile, patchedPeer);
  plugin.patchInstalledSdk(root,"4.2.2");
  assert.equal(readFileSync(clientFile,"utf8"),patchedClient);
  assert.equal(readFileSync(monitorFile,"utf8"),patchedMonitor);
  assert.equal(readFileSync(callFile,"utf8"),patchedCall);
  assert.equal(readFileSync(peerFile,"utf8"),patchedPeer);
});
console.log(JSON.stringify({ kind: "actual-pinned-SDK-installation-controlled-filesystem", checks, passed: true, providerNetworkingExecuted: false }));
