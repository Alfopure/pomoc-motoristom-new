const { createHash } = require("node:crypto");
const { chmodSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { withPodfile } = require("expo/config-plugins");

// TelnyxRTC 4.2.2 / commit 651f9152974d469349af7e79801a70812ffbf098 (MIT).
// Its delayed reconnect can outlive disconnect(), and a shared monitor is stopped
// when a retired client deinitializes, including after a replacement was created.
// Keep the patch pinned until the upstream lifecycle fix is independently tested.
const VERSION = "4.2.2";
const ORIGINAL_SHA256 = "06fba6adc8283a5337e88c4c74059099e856b7bdc3d7198416b1d2a74ab8b9e0";
const PATCHED_SHA256 = "7d0866800c32eafa9ab814f2f15bf7d4264b836aeb7d7f1eef10cdc660e780e9";
const ORIGINAL_MONITOR_SHA256 = "c1aa459d44428d3fffea1ecdeacf165212571e4a76a64796e0fd33876449185b";
const PATCHED_MONITOR_SHA256 = "a4eee64b6cbf480848106528411e7babeb3512e3c02433d718173ff5d74bf49f";
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
    private let linkaNetworkMonitor = NetworkMonitor()
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
                do {`)
    .replaceAll("NetworkMonitor.shared", "self.linkaNetworkMonitor")
    .replace(`        self.calls[appFacingCallId] = call
`, `        // LINKA ATTACH microphone intent precedes Peer construction/answer.
        if isAttach {
            if let previous = self.calls[appFacingCallId],
               previous.callInfo?.callId == appFacingCallId,
               previous.telnyxLegId == call.telnyxLegId, call.telnyxLegId != nil {
                call.linkaMicrophoneIntent = previous.linkaMicrophoneIntent
            } else {
                call.linkaMicrophoneIntent.setMuted(true)
            }
        }
        self.calls[appFacingCallId] = call
`);
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
  const root = join(podsRoot, "TelnyxRTC/TelnyxRTC/Telnyx");
  // Validate all four complete sources before changing any downloaded file.
  const clientFile = join(root, "TxClient.swift");
  const client = readFileSync(clientFile, "utf8");
  const patchedClient = patchTelnyxSource(client, version);
  const monitorFile = join(root, "Utils/NetworkMonitor.swift");
  const monitor = readFileSync(monitorFile, "utf8");
  const patchedMonitor = patchNetworkMonitorSource(monitor, version);
  const callFile = join(root, "WebRTC/Call.swift");
  const call = readFileSync(callFile, "utf8");
  const patchedCall = patchCallSource(call, version);
  const peerFile = join(root, "WebRTC/Peer.swift");
  const peer = readFileSync(peerFile, "utf8");
  const patchedPeer = patchPeerSource(peer, version);
  for (const [file, original, patched] of [[clientFile, client, patchedClient], [monitorFile, monitor, patchedMonitor], [callFile, call, patchedCall], [peerFile, peer, patchedPeer]]) {
    if (patched === original) continue;
    const mode = statSync(file).mode;
    // CocoaPods may make downloaded sources read-only; restore its exact mode.
    chmodSync(file, mode | 0o200);
    try { writeFileSync(file, patched); } finally { chmodSync(file, mode); }
  }
}

function patchNetworkMonitorSource(source, version) {
  if (version !== VERSION) throw new Error("Telnyx lifecycle guard: unsupported SDK version; review the patch before upgrading.");
  const current = hash(source);
  if (current === PATCHED_MONITOR_SHA256) return source;
  if (current !== ORIGINAL_MONITOR_SHA256) throw new Error("Telnyx lifecycle guard: unexpected network monitor source; refusing an unreviewed patch.");
  const patched = source.replace("    private init() {", "    init() {");
  if (hash(patched) !== PATCHED_MONITOR_SHA256) throw new Error("Telnyx lifecycle guard: unexpected transformed network monitor source " + hash(patched));
  return patched;
}

const ORIGINAL_CALL_SHA256 = "9ab32559aff47dc8f2619fb643146c27186b141107c6c88e636230878a572689";
const PATCHED_CALL_SHA256 = "27b62d74a5ba94e5cc005d49fe9812caf222b9625ccb970e3138e12a3a39aa88";
function patchCallSource(source, version) {
  if (version !== VERSION) throw new Error("Telnyx microphone guard: unsupported SDK version.");
  if (hash(source) === PATCHED_CALL_SHA256) return source;
  if (hash(source) !== ORIGINAL_CALL_SHA256) throw new Error("Telnyx microphone guard: unexpected Call source.");
  const patched = source
    .replaceAll("    public var isMuted: Bool {", `    internal var linkaMicrophoneIntent = LinkaMicrophoneIntent()

    public var isMuted: Bool {`)
    .replaceAll("isAnswering: false)", "isAnswering: false, linkaMicrophoneIntent: self.linkaMicrophoneIntent)")
    .replaceAll("isAnswering: true)", "isAnswering: true, linkaMicrophoneIntent: self.linkaMicrophoneIntent)")
    .replaceAll("        self.peer?.muteUnmuteAudio(mute: true)", `        self.linkaMicrophoneIntent.setMuted(true)`)
    .replaceAll("        self.peer?.muteUnmuteAudio(mute: false)", `        self.linkaMicrophoneIntent.setMuted(false)`);
  if (hash(patched) !== PATCHED_CALL_SHA256) throw new Error("Telnyx microphone guard: transformed Call source mismatch.");
  return patched;
}

const ORIGINAL_PEER_SHA256 = "70a5e42e4bfe44906c926dbf987e814caac14545f64f35779179fc33a745e42e";
const PATCHED_PEER_SHA256 = "62b8fc68135503c6d7a7519f89b1350bfc1ba2c63f7956c9e2b15d4134566caf";
function patchPeerSource(source, version) {
  if (version !== VERSION) throw new Error("Telnyx microphone guard: unsupported SDK version.");
  if (hash(source) === PATCHED_PEER_SHA256) return source;
  if (hash(source) !== ORIGINAL_PEER_SHA256) throw new Error("Telnyx microphone guard: unexpected Peer source.");
  const patched = source
    .replaceAll("class Peer : NSObject, WebRTCEventHandler {", `// LINKA microphone intent: shared by old/new ATTACH peers. Track registration
// and recovery writes serialize with user/privacy mute, before any track is sent.
internal final class LinkaMicrophoneIntent {
    private final class Track {
        weak var value: RTCAudioTrack?
        init(_ value: RTCAudioTrack) { self.value = value }
    }
    private let lock = NSRecursiveLock()
    private var muted = false
    private var tracks = [Track]()
    func withState(_ body: (Bool) -> Void) {
        lock.lock(); defer { lock.unlock() }; body(muted)
    }
    func setMuted(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        muted = value
        tracks.removeAll { $0.value == nil }
        for track in tracks { track.value?.isEnabled = !muted }
    }
    func register(_ track: RTCAudioTrack) {
        lock.lock(); defer { lock.unlock() }
        tracks.append(Track(track))
        track.isEnabled = !muted
    }
}
// LINKA microphone intent end

class Peer : NSObject, WebRTCEventHandler {`)
    .replaceAll("    required init(iceServers:", `    private let linkaMicrophoneIntent: LinkaMicrophoneIntent

    required init(iceServers:`)
    .replaceAll("                  isAnswering: Bool = false) {", `                  isAnswering: Bool = false,
                  linkaMicrophoneIntent: LinkaMicrophoneIntent = LinkaMicrophoneIntent()) {
        self.linkaMicrophoneIntent = linkaMicrophoneIntent`)
    .replaceAll("        self.localAudioTrack = audioTrack", `        self.linkaMicrophoneIntent.register(audioTrack)
        self.localAudioTrack = audioTrack`)
    .replaceAll("        self.muteUnmuteAudio(mute: false)", "        // Initial audio state was installed before attaching the track.")
    .replaceAll(`            .forEach {
                $0.isEnabled = isEnabled
                Logger.log.i(message:"setTrackEnabled IsEnabled: \\(isEnabled)")
            }`, `            .forEach { track in
                self.linkaMicrophoneIntent.withState { muted in
                    if let audio = track as? RTCAudioTrack { audio.isEnabled = isEnabled && !muted }
                    else { track.isEnabled = isEnabled }
                }
                Logger.log.i(message:"setTrackEnabled IsEnabled: \\(isEnabled)")
            }`)
    .replaceAll("    func muteUnmuteAudio(mute: Bool) {", `    func muteUnmuteAudio(mute: Bool) {
        self.linkaMicrophoneIntent.setMuted(mute)
        self.linkaMicrophoneIntent.withState { currentMuted in`)
    .replaceAll("                    $0.isEnabled = !mute // disable/enable RTCAudioTrack", "                    $0.isEnabled = !currentMuted // disable/enable RTCAudioTrack")
    .replaceAll("            self.setTrackEnabled(RTCAudioTrack.self, isEnabled: !mute)", "            self.setTrackEnabled(RTCAudioTrack.self, isEnabled: !currentMuted)")
    .replaceAll("        Logger.log.i(message: \"[ACM_RESET] Peer:: Audio track \\(mute ? \"muted\" : \"unmuted\")\")", `        Logger.log.i(message: "[ACM_RESET] Peer:: Audio track \\(mute ? "muted" : "unmuted")")
        }`)
    .replaceAll("                    track.isEnabled = originalStates[index]", "                    self.linkaMicrophoneIntent.withState { track.isEnabled = !$0 }")
    .replaceAll("        audioTracks.forEach { $0.isEnabled = !isMute }", `        self.linkaMicrophoneIntent.withState { muted in
            audioTracks.forEach { $0.isEnabled = !isMute && !muted }
        }`);
  if (hash(patched) !== PATCHED_PEER_SHA256) throw new Error("Telnyx microphone guard: transformed Peer source mismatch.");
  return patched;
}

function withTelnyxReconnectGuard(config) {
  return withPodfile(config, mod => {
    mod.modResults.contents = patchPodfile(mod.modResults.contents);
    return mod;
  });
}

module.exports = withTelnyxReconnectGuard;
module.exports.patchTelnyxSource = patchTelnyxSource;
module.exports.patchNetworkMonitorSource = patchNetworkMonitorSource;
module.exports.patchCallSource = patchCallSource;
module.exports.patchPeerSource = patchPeerSource;
module.exports.patchPodfile = patchPodfile;
module.exports.patchInstalledSdk = patchInstalledSdk;
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error("Expected the CocoaPods sandbox root and installer-resolved SDK version.");
  patchInstalledSdk(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ guard: "Linka Telnyx lifecycle", sdk: VERSION, sourceSha256: PATCHED_SHA256, monitorSha256: PATCHED_MONITOR_SHA256, callSha256: PATCHED_CALL_SHA256, peerSha256: PATCHED_PEER_SHA256 }));
}
