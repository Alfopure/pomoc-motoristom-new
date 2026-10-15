const { createHash } = require("node:crypto");
const { chmodSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { withPodfile } = require("expo/config-plugins");

// TelnyxRTC 4.2.2 / commit 651f9152974d469349af7e79801a70812ffbf098 (MIT).
// Its delayed reconnect retains the client and can reconnect after disconnect().
// Keep the patch pinned until the upstream lifecycle fix is independently tested.
const VERSION = "4.2.2";
const ORIGINAL_SHA256 = "06fba6adc8283a5337e88c4c74059099e856b7bdc3d7198416b1d2a74ab8b9e0";
const PATCHED_SHA256 = "3951eb7d498ec70897e2de11c1c48d65df26a6199977310a71a36059154efb73";
const MARKER = "# Linka Telnyx lifecycle guard";
const hook = `${MARKER}
    telnyx_versions = installer.pod_targets.select { |target| target.root_spec.name == 'TelnyxRTC' }
      .map { |target| target.root_spec.version.to_s }.uniq
    raise 'Expected pinned TelnyxRTC ${VERSION} from CocoaPods installer.' unless telnyx_versions == ['${VERSION}']
    guard_script = File.expand_path('../plugins/with-telnyx-reconnect-guard.cjs', __dir__)
    unless system('node', guard_script, installer.sandbox.root.to_s, telnyx_versions.fetch(0))
      raise 'Telnyx lifecycle patch failed; refusing an unguarded native phone build.'
    end`;
const hash = source => createHash("sha256").update(source).digest("hex");

function patchTelnyxSource(source, version) {
  if (version !== VERSION) throw new Error("Telnyx lifecycle guard: unsupported SDK version; review the patch before upgrading.");
  const current = hash(source);
  if (current === PATCHED_SHA256) return source;
  if (current !== ORIGINAL_SHA256) throw new Error("Telnyx lifecycle guard: unexpected SDK source; refusing a partial or unreviewed patch.");
  const patched = source
    .replace("    internal var txConfig: TxConfig?\n", `    internal var txConfig: TxConfig?
    // LINKA lifecycle guard start
    private let linkaConnectionLock = NSRecursiveLock()
    private var linkaConnectionGeneration: UInt64 = 0
    // LINKA lifecycle guard end
`)
    .replaceAll("        try txConfig.validateParams()\n", `        try txConfig.validateParams()
        self.linkaConnectionLock.lock()
        defer { self.linkaConnectionLock.unlock() }
        self.linkaConnectionGeneration &+= 1
`)
    .replace("    public func disconnect() {\n", `    public func disconnect() {
        self.linkaConnectionLock.lock()
        defer { self.linkaConnectionLock.unlock() }
        self.linkaConnectionGeneration &+= 1
        self.txConfig = nil
        self.storedTxConfig = nil
`)
    .replace("    private func connectSocketOnly(serverConfiguration: TxServerConfiguration) throws {\n", `    private func connectSocketOnly(serverConfiguration: TxServerConfiguration) throws {
        self.linkaConnectionLock.lock()
        defer { self.linkaConnectionLock.unlock() }
        self.linkaConnectionGeneration &+= 1
`)
    .replace('        let rtc_id = (pushMetaData["voice_sdk_id"] as? String)', `        self.linkaConnectionLock.lock()
        defer { self.linkaConnectionLock.unlock() }
        self.linkaConnectionGeneration &+= 1
        let rtc_id = (pushMetaData["voice_sdk_id"] as? String)`)
    .replace(`            DispatchQueue.main.asyncAfter(deadline: .now() + TxClient.RECONNECT_BUFFER) {
                do {`, `            self.linkaConnectionLock.lock()
            let generation = self.linkaConnectionGeneration
            self.linkaConnectionLock.unlock()
            DispatchQueue.main.asyncAfter(deadline: .now() + TxClient.RECONNECT_BUFFER) { [weak self] in
                guard let self = self else { return }
                self.linkaConnectionLock.lock()
                defer { self.linkaConnectionLock.unlock() }
                guard self.linkaConnectionGeneration == generation else { return }
                do {`);
  if (hash(patched) !== PATCHED_SHA256) throw new Error("Telnyx lifecycle guard: unexpected transformed source " + hash(patched));
  return patched;
}

function patchPodfile(contents) {
  if (contents.includes(MARKER)) {
    if (contents.split(hook).length !== 2) throw new Error("Telnyx lifecycle guard: existing Podfile hook changed.");
    return contents;
  }
  const postInstall = /^([ \t]*)post_install do \|installer\|[ \t]*$/gm;
  if ([...contents.matchAll(postInstall)].length !== 1) throw new Error("Telnyx lifecycle guard: expected one CocoaPods post_install hook.");
  return contents.replace(postInstall, match => match + "\n    " + hook);
}

function patchInstalledSdk(podsRoot, version) {
  const file = join(podsRoot, "TelnyxRTC/TelnyxRTC/Telnyx/TxClient.swift");
  const original = readFileSync(file, "utf8");
  const patched = patchTelnyxSource(original, version);
  if (patched !== original) {
    const mode = statSync(file).mode;
    // CocoaPods may make downloaded sources read-only; restore its exact mode.
    chmodSync(file, mode | 0o200);
    try { writeFileSync(file, patched); } finally { chmodSync(file, mode); }
  }
}

function withTelnyxReconnectGuard(config) {
  return withPodfile(config, mod => {
    mod.modResults.contents = patchPodfile(mod.modResults.contents);
    return mod;
  });
}

module.exports = withTelnyxReconnectGuard;
module.exports.patchTelnyxSource = patchTelnyxSource;
module.exports.patchPodfile = patchPodfile;
module.exports.patchInstalledSdk = patchInstalledSdk;
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error("Expected the CocoaPods sandbox root and installer-resolved SDK version.");
  patchInstalledSdk(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ guard: "Linka Telnyx lifecycle", sdk: VERSION, sourceSha256: PATCHED_SHA256 }));
}
