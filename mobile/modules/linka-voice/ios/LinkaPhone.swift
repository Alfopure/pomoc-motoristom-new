import AVFoundation
import CallKit
import PushKit
import TelnyxRTC
import UIKit
import os

private struct PhoneError: LocalizedError {
  var errorDescription: String? { "Telefón nie je pripravený na túto akciu." }
}

/** Single native owner of signaling and audio. Credentials/push payloads stay
 * in memory. Every answer waits for the authenticated backend's exact offer.
 * No client-originated external dial exists; the server calls our operator leg. */
final class LinkaPhone: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = LinkaPhone()
  static var enabled: Bool {
    ["sk.linkapomoci.dispecing", "sk.linkapomoci.dispecing.test"].contains(Bundle.main.bundleIdentifier ?? "")
      && Bundle.main.object(forInfoDictionaryKey: "LinkaNativeVoiceEnabled") as? Bool == true
  }
  // Device log for a USB syslog capture (subsystem sk.linkapomoci.voice). Lines are
  // public, so they carry only reason codes, flags, counts, key names and 8-character
  // app IDs: never a phone number, name, token or push payload value.
  private static let log = os.Logger(subsystem: "sk.linkapomoci.voice", category: "phone")
  private static let diagAllowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:,-")
  /** Keeps [A-Za-z0-9_.:,-]; a phone-number-like run of 7+ digits is redacted. */
  private static func diagText(_ text: String, _ limit: Int) -> String {
    let kept = String(text.unicodeScalars.filter { diagAllowed.contains($0) })
    return kept.range(of: "[0-9]([._:,-]?[0-9]){6,}", options: .regularExpression) == nil ? String(kept.prefix(limit)) : "redacted"
  }
  /** One `event key=value` line; JS lines arrive here too, prefixed "js.". The same
   * event enters the ring below, which the app uploads, so a test needs no cable. */
  static func diag(_ event: String, _ fields: [String: Any] = [:]) {
    let pairs = fields.sorted { $0.key < $1.key }.prefix(32).map { key, value -> (String, String) in
      let text: String
      switch value {
      case let flag as Bool: text = flag ? "true" : "false"
      case let count as Int: text = String(count)
      case let id as UUID: text = String(id.uuidString.prefix(8)).lowercased()
      case let names as [String]: text = names.isEmpty ? "none" : diagText(names.joined(separator: ","), 400)
      case let code as String: text = diagText(code, 64)
      case let error as Error: text = diagText((error as NSError).domain, 60) + ":" + String((error as NSError).code)
      default: text = "none"
      }
      return (diagText(key, 32), text)
    }
    let name = diagText(event, 48)
    let line = ([name] + pairs.map { $0.0 + "=" + $0.1 }).joined(separator: " ")
    log.notice("\(line, privacy: .public)")
    ringLock.lock(); defer { ringLock.unlock() }
    loadRing()
    ring.append(["id": ringNextId, "at": Int(Date().timeIntervalSince1970 * 1000), "event": name,
      "fields": Dictionary(pairs, uniquingKeysWith: { first, _ in first })])
    ringNextId += 1
    if ring.count > 300 { ring.removeFirst(ring.count - 300) }
    persistRing()
  }
  private func diag(_ event: String, _ fields: [String: Any] = [:]) { Self.diag(event, fields) }
  // The last 300 events, also in a file of the app container: an iOS kill or relaunch
  // keeps them until the app uploads them. Guarded by ringLock; diag runs on any thread.
  private static let ringLock = NSLock()
  private static let ringQueue = DispatchQueue(label: "sk.linkapomoci.voice.diagnostics")
  private static var ring = [[String: Any]](), ringLoaded = false, ringNextId = 1, ringWriting = false
  /** Another file is read afresh on the next access. */
  static var diagnosticFile = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
    .appendingPathComponent("linka-voice-diagnostics.json") {
    didSet { ringLock.lock(); ringLoaded = false; ring = []; ringLock.unlock() }
  }
  private static func loadRing() {
    guard !ringLoaded else { return }
    ringLoaded = true
    let stored = diagnosticFile.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]] ?? []
    ring = Array(stored.filter { $0["id"] is Int && $0["at"] is Int && $0["event"] is String && $0["fields"] is [String: String] }.suffix(300))
    ringNextId = (ring.compactMap { $0["id"] as? Int }.max() ?? 0) + 1
  }
  /** Coalesced, off the caller's thread; the ring itself is current at once. */
  private static func persistRing() {
    guard !ringWriting, let file = diagnosticFile else { return }
    ringWriting = true
    ringQueue.asyncAfter(deadline: .now() + 0.5) {
      ringLock.lock()
      let events = ring; ringWriting = false
      ringLock.unlock()
      if let data = try? JSONSerialization.data(withJSONObject: events) { try? data.write(to: file, options: .atomic) }
    }
  }
  /** Oldest first: `{id, at, event, fields}` with the same sanitized values as the log lines. */
  static func diagnosticEvents() -> [[String: Any]] {
    ringLock.lock(); defer { ringLock.unlock() }
    loadRing(); return ring
  }
  /** Forgets the events the server accepted, up to and including `upToId`. */
  static func clearDiagnosticEvents(upToId: Int) {
    ringLock.lock(); defer { ringLock.unlock() }
    loadRing(); ring.removeAll { ($0["id"] as? Int ?? 0) <= upToId }; persistRing()
  }
  /** Side-effect-free inputs of the hold guards. */
  private func holdFlags(_ id: UUID) -> [String: Any] {
    ["call": id, "ready": ready, "client": client != nil, "session": sessions[id] != nil, "established": established.contains(id),
     "recovering": recoveryTimers[id] != nil, "media": media[id]?.state ?? "none", "can_hold": media[id]?.canHold ?? false,
     "version": media[id]?.version ?? -1, "pending_hold": holds[id] != nil, "mirror": mirrors[id] != nil, "requested": requestedHolds[id] != nil,
     "system_held": systemHeld.contains(id), "sdk_state": calls[id].map { stateName($0.callState) } ?? "none", "holdable": reportedHoldable[id] as Any]
  }
  private var listener: (([String: Any]) -> Void)?
  private var listenerOwner: UUID?
  func listen(owner: UUID, callback: @escaping ([String: Any]) -> Void) { listenerOwner = owner; listener = callback }
  func stopListening(owner: UUID) {
    guard listenerOwner == owner else { return }
    listenerOwner = nil; listener = nil
  }
  private var provider: CXProvider?
  private let controller = CXCallController()
  private var registry: PKPushRegistry?
  private var client: TxClient?
  private var clientDelegate: ClientDelegate?
  private var pushToken: String?
  private var registeredPushToken: String?
  private var connectingPushToken: String?
  private var ready = false
  private var audioActive = false
  private var calls = [UUID: Call]()
  private var pushes = [UUID: [String: Any]]()
  private var sessions = [UUID: String]()
  private var controls = [UUID: String]()
  private var authorizedLegs = [UUID: UUID]()
  private var reported = Set<UUID>()
  private var timers = [UUID: Timer]()
  private var recoveryTimers = [UUID: Timer]()
  private var established = Set<UUID>()
  private var pendingAnswers = [UUID: CXAnswerCallAction]()
  private var answering = [UUID: CXCallAction]()
  private var expected: (controlId: String, sessionId: String, number: String, handleType: CXHandle.HandleType)?
  private var outgoingLabels = [UUID: String]()
  private var outbound = Set<UUID>()
  private var connectedOutbound = Set<UUID>()
  private var outgoingTimer: Timer?
  private var finishedCalls = [UUID]()
  private var preparedPush: UUID?
  /** A push refused before JS listened (cold launch) is still reported from the snapshot. */
  private var lastPushRejection: [String: Any]?

  // Server media and CallKit state are separate. SDK ACTIVE/HELD cannot prove
  // conference media, and a historical receipt cannot override current media.
  private struct Media {
    var state: String
    var version: Int
    var canHold: Bool
  }
  private final class HoldCommand {
    let actionId: UUID
    let held: Bool
    let version: Int
    let session: String
    let control: String
    let client: TxClient
    let call: Call
    var action: CXSetHeldCallAction?
    var phase = "unclaimed"
    init(_ action: CXSetHeldCallAction, version: Int, session: String, control: String, client: TxClient, call: Call) {
      actionId = action.uuid; held = action.isOnHold; self.version = version
      self.session = session; self.control = control; self.client = client; self.call = call; self.action = action
    }
  }
  private struct HoldMirror {
    let action: CXSetHeldCallAction
    let client: TxClient
    let call: Call
    let version: Int
    let session: String
    let control: String
  }
  private var media = [UUID: Media]()
  private var reportedHoldable = [UUID: Bool]()
  private var holds = [UUID: HoldCommand]()
  private var holdTimers = [UUID: Timer]()
  private var mirrors = [UUID: HoldMirror]()
  private var mirrorTimers = [UUID: Timer]()
  private var requestedHolds = [UUID: CXSetHeldCallAction]()
  private var systemHeld = Set<UUID>()
  private var userMuted = Set<UUID>()
  private var privacyHold = Set<UUID>()

  private func holdEvent(_ id: UUID, _ command: HoldCommand) -> [String: Any] {
    ["type": "heldRequested", "callId": id.uuidString, "sessionId": command.session,
     "callControlId": command.control, "actionId": command.actionId.uuidString,
     "held": command.held, "expectedVersion": command.version, "phase": command.phase,
     "actionLive": command.action.map { !$0.isComplete && $0.timeoutDate > Date() } ?? false]
  }
  private func mirrorEvent(_ type: String, _ id: UUID, _ mirror: HoldMirror) -> [String: Any] {
    ["type": type, "callId": id.uuidString, "sessionId": mirror.session, "callControlId": mirror.control,
     "actionId": mirror.action.uuid.uuidString, "expectedVersion": mirror.version, "held": mirror.action.isOnHold]
  }
  private func failLive(_ action: CXAction) {
    if !action.isComplete && action.timeoutDate > Date() { action.fail() }
  }
  private func applyMicrophone(_ id: UUID, _ call: Call) {
    if userMuted.contains(id) || privacyHold.contains(id) { call.muteAudio() }
    else if call.isMuted { call.unmuteAudio() }
  }
  private func refreshPrivacy(_ id: UUID, _ call: Call) {
    let state = media[id]?.state
    let blocked = holds[id] != nil || mirrors[id] != nil || systemHeld.contains(id)
      || state == "held" || state == "pending" || (state == "unavailable" && privacyHold.contains(id))
    let wasBlocked = privacyHold.contains(id)
    if blocked { privacyHold.insert(id) } else { privacyHold.remove(id) }
    if wasBlocked != blocked || (state == "active" && !blocked) { applyMicrophone(id, call) }
  }
  private func updateHoldCapability(_ id: UUID) {
    let holdable = ready && established.contains(id) && recoveryTimers[id] == nil
      && media[id]?.canHold == true && ["active", "held"].contains(media[id]?.state ?? "")
      && holds[id] == nil && mirrors[id] == nil
      && systemHeld.contains(id) == (media[id]?.state == "held")
    // The status poll repeats this every 2 s; CallKit hears only a change.
    guard reportedHoldable[id] != holdable else { return }
    reportedHoldable[id] = holdable
    diag("callkit.update", holdFlags(id))
    let update = CXCallUpdate()
    update.supportsHolding = holdable
    provider?.reportCall(with: id, updated: update)
  }
  private func exactMediaCall(_ callId: String, _ sessionId: String, _ controlId: String) throws -> (UUID, Call) {
    guard let id = UUID(uuidString: callId), sessions[id] == sessionId, controls[id] == controlId,
      established.contains(id), let call = currentCall(id) else { throw PhoneError() }
    return (id, call)
  }
  private func acceptMedia(_ id: UUID, state: String, version: Int, canHold: Bool) throws -> Bool {
    guard ["active", "held", "pending", "unavailable"].contains(state), version >= 0, version <= 9_007_199_254_740_991 else { throw PhoneError() }
    if let previous = media[id] {
      if version < previous.version { return false }
      if version == previous.version, ["active", "held"].contains(previous.state), state != previous.state, state != "unavailable" {
        // Effect receipts can settle pending at the same session revision; the
        // reverse transition or opposite settled result is stale/contradictory.
        return false
      }
    }
    media[id] = Media(state: state, version: version, canHold: canHold)
    return true
  }
  func requestHold(callId: String, held: Bool) throws {
    guard ready, let id = UUID(uuidString: callId), let call = currentCall(id), established.contains(id), recoveryTimers[id] == nil,
      media[id]?.canHold == true, media[id]?.state == (held ? "active" : "held"),
      holds[id] == nil, mirrors[id] == nil, requestedHolds[id] == nil, systemHeld.contains(id) == !held, call.callState == .ACTIVE else {
      diag("hold.request", (UUID(uuidString: callId).map(holdFlags) ?? [:]).merging(["result": "refused", "held": held]) { $1 })
      throw PhoneError()
    }
    let action = CXSetHeldCallAction(call: id, onHold: held)
    requestedHolds[id] = action
    diag("hold.request", holdFlags(id).merging(["result": "requested", "held": held, "action": action.uuid]) { $1 })
    holdTimers[id] = Timer.scheduledTimer(withTimeInterval: min(12, max(0, action.timeoutDate.timeIntervalSinceNow)), repeats: false) { [weak self] _ in
      guard let self, self.requestedHolds[id] === action else { return }
      self.requestedHolds.removeValue(forKey: id); self.holdTimers.removeValue(forKey: id)?.invalidate()
      self.failLive(action)
      LinkaPhone.diag("hold.cancelled", ["call": id, "action": action.uuid, "reason": "request_timeout"])
      self.emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": action.uuid.uuidString])
    }
    controller.request(CXTransaction(action: action)) { [weak self] error in
      LinkaPhone.diag("callkit.request", ["action": "hold", "call": id, "held": held, "error": error as Any])
      guard error != nil else { return }
      DispatchQueue.main.async {
        guard let self, self.requestedHolds[id] === action else { return }
        self.requestedHolds.removeValue(forKey: id); self.holdTimers.removeValue(forKey: id)?.invalidate()
        LinkaPhone.diag("hold.cancelled", ["call": id, "action": action.uuid, "reason": "transaction_error"])
        self.emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": action.uuid.uuidString])
      }
    }
  }
  func claimHold(callId: String, actionId: String) -> Bool {
    guard ready, let id = UUID(uuidString: callId), let uuid = UUID(uuidString: actionId),
      let command = holds[id], command.actionId == uuid, command.phase == "unclaimed",
      let action = command.action, !action.isComplete, action.timeoutDate > Date(),
      client === command.client, sessions[id] == command.session, controls[id] == command.control,
      currentCall(id) === command.call, holds[id] === command, recoveryTimers[id] == nil else {
      let id = UUID(uuidString: callId)
      diag("hold.claim", ["result": "refused", "call": id as Any, "phase": id.flatMap { holds[$0]?.phase } ?? "none", "ready": ready])
      return false
    }
    command.phase = "dispatched"
    diag("hold.claim", ["result": "ok", "call": id, "held": command.held])
    return true
  }
  func syncMedia(callId: String, sessionId: String, controlId: String, state: String, version: Int, canHold: Bool) throws {
    guard let match = try? exactMediaCall(callId, sessionId, controlId) else {
      diag("hold.media", ["result": "unknown_call", "call": UUID(uuidString: callId) as Any]); throw PhoneError()
    }
    let (id, call) = match, previous = media[id]
    guard try acceptMedia(id, state: state, version: version, canHold: canHold) else {
      diag("hold.media", ["result": "stale", "call": id, "state": state, "version": version]); return
    }
    if previous?.state != state || previous?.version != version || previous?.canHold != canHold {
      diag("hold.media", ["result": "changed", "call": id, "state": state, "version": version, "can_hold": canHold])
    }
    refreshPrivacy(id, call); mirrorMedia(id, call); updateHoldCapability(id)
  }
  func resolveHold(callId: String, sessionId: String, controlId: String, actionId: String, outcome: String, state: String, version: Int, canHold: Bool) throws {
    guard ["confirmed", "rejected", "uncertain"].contains(outcome), let uuid = UUID(uuidString: actionId) else { throw PhoneError() }
    let (id, call) = try exactMediaCall(callId, sessionId, controlId)
    guard let command = holds[id], command.actionId == uuid, command.phase != "unclaimed" else {
      diag("hold.resolve", ["result": "unknown_command", "call": id, "outcome": outcome]); throw PhoneError()
    }
    _ = try acceptMedia(id, state: state, version: version, canHold: canHold)
    diag("hold.resolve", ["result": "ok", "call": id, "outcome": outcome, "state": state, "version": version, "action_live": command.action != nil])
    if outcome == "uncertain" {
      command.phase = "uncertain"; refreshPrivacy(id, call); updateHoldCapability(id); return
    }
    if let action = command.action {
      if outcome == "confirmed", client === command.client, call === command.call,
        media[id]?.state == (command.held ? "held" : "active"), media[id]!.version >= command.version,
        !action.isComplete, action.timeoutDate > Date() {
        action.fulfill()
        if command.held { systemHeld.insert(id) } else { systemHeld.remove(id) }
      } else { failLive(action) }
    }
    holds.removeValue(forKey: id); holdTimers.removeValue(forKey: id)?.invalidate()
    refreshPrivacy(id, call); mirrorMedia(id, call); updateHoldCapability(id)
  }
  private func detachHold(_ id: UUID, timedOut: Bool = false) {
    guard let command = holds[id] else { return }
    diag("hold.detach", ["call": id, "phase": command.phase, "timed_out": timedOut])
    if let action = command.action, !timedOut { failLive(action) }
    command.action = nil; holdTimers.removeValue(forKey: id)?.invalidate()
    if command.phase == "unclaimed" {
      holds.removeValue(forKey: id)
      diag("hold.cancelled", ["call": id, "action": command.actionId, "reason": "detached_unclaimed"])
      emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": command.actionId.uuidString])
    } else { command.phase = "uncertain"; emit(holdEvent(id, command)) }
    if let call = calls[id] { refreshPrivacy(id, call) }
    updateHoldCapability(id)
  }
  private func failMirror(_ id: UUID, timedOut: Bool = false) {
    guard let mirror = mirrors.removeValue(forKey: id) else { return }
    diag("hold.mirror_failed", ["call": id, "held": mirror.action.isOnHold, "version": mirror.version, "timed_out": timedOut])
    mirrorTimers.removeValue(forKey: id)?.invalidate()
    if !timedOut { failLive(mirror.action) }
    // Keep the barrier until an explicit fresh sync successfully reconciles.
    privacyHold.insert(id); if let call = calls[id] { applyMicrophone(id, call) }
    emit(mirrorEvent("holdSyncFailed", id, mirror))
    updateHoldCapability(id)
  }
  private func mirrorMedia(_ id: UUID, _ call: Call) {
    guard holds[id] == nil, let state = media[id], ["active", "held"].contains(state.state), let client,
      let session = sessions[id], let control = controls[id],
      recoveryTimers[id] == nil else { return }
    let held = state.state == "held"
    if let mirror = mirrors[id] {
      if mirror.version == state.version && mirror.action.isOnHold == held { emit(mirrorEvent("holdSyncPending", id, mirror)); return }
      failMirror(id)
    }
    guard systemHeld.contains(id) != held else { refreshPrivacy(id, call); return }
    let action = CXSetHeldCallAction(call: id, onHold: held)
    mirrorActionIds[action.uuid] = id
    let mirror = HoldMirror(action: action, client: client, call: call, version: state.version, session: session, control: control)
    mirrors[id] = mirror
    privacyHold.insert(id); applyMicrophone(id, call)
    mirrorTimers[id] = Timer.scheduledTimer(withTimeInterval: min(12, max(0, action.timeoutDate.timeIntervalSinceNow)), repeats: false) { [weak self] _ in
      guard self?.mirrors[id]?.action === action else { return }; self?.failMirror(id)
    }
    emit(mirrorEvent("holdSyncPending", id, mirror))
    diag("hold.mirror_request", ["call": id, "held": held, "version": state.version])
    controller.request(CXTransaction(action: action)) { [weak self] error in
      LinkaPhone.diag("callkit.request", ["action": "hold_mirror", "call": id, "held": held, "error": error as Any])
      guard error != nil else { return }
      DispatchQueue.main.async { if self?.mirrors[id]?.action === action { self?.failMirror(id) } }
    }
  }
  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    let id = action.callUUID
    if let mirror = mirrors[id], mirror.action === action {
      guard client === mirror.client, sessions[id] == mirror.session, controls[id] == mirror.control,
        currentCall(id) === mirror.call, mirrors[id]?.action === action,
        recoveryTimers[id] == nil, media[id]?.version == mirror.version,
        media[id]?.state == (action.isOnHold ? "held" : "active"), holds[id] == nil,
        !action.isComplete, action.timeoutDate > Date() else { diag("callkit.held", ["call": id, "result": "mirror_refused", "on_hold": action.isOnHold]); failMirror(id); return }
      mirrors.removeValue(forKey: id); mirrorTimers.removeValue(forKey: id)?.invalidate()
      action.fulfill()
      diag("callkit.held", ["call": id, "result": "mirror_ok", "on_hold": action.isOnHold])
      if action.isOnHold { systemHeld.insert(id) } else { systemHeld.remove(id) }
      refreshPrivacy(id, mirror.call); updateHoldCapability(id)
      emit(mirrorEvent("holdSynced", id, mirror)); return
    }
    // A stale mirror callback is not a new user command.
    guard mirrorActionIds[action.uuid] == nil else { diag("callkit.held", ["call": id, "result": "stale_mirror"]); failLive(action); return }
    guard requestedHolds[id] == nil || requestedHolds[id] === action else {
      diag("callkit.held", ["call": id, "result": "competing", "on_hold": action.isOnHold])
      diag("hold.cancelled", ["call": id, "action": action.uuid, "reason": "competing"])
      failLive(action); emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": action.uuid.uuidString]); return
    }
    let ownRequest = requestedHolds[id] === action
    if requestedHolds[id] === action { requestedHolds.removeValue(forKey: id); holdTimers.removeValue(forKey: id)?.invalidate() }
    guard ready, holds[id] == nil, mirrors[id] == nil, let client, let session = sessions[id], let control = controls[id],
      let call = currentCall(id), established.contains(id), recoveryTimers[id] == nil,
      call.callState == .ACTIVE, let state = media[id], state.canHold,
      state.state == (action.isOnHold ? "active" : "held"), systemHeld.contains(id) == !action.isOnHold, !action.isComplete, action.timeoutDate > Date() else {
      diag("callkit.held", holdFlags(id).merging(["result": "refused", "on_hold": action.isOnHold, "own_request": ownRequest,
        "action_live": !action.isComplete && action.timeoutDate > Date()]) { $1 })
      diag("hold.cancelled", ["call": id, "action": action.uuid, "reason": "refused"])
      failLive(action); emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": action.uuid.uuidString]); return
    }
    let command = HoldCommand(action, version: state.version, session: session, control: control, client: client, call: call)
    diag("callkit.held", ["call": id, "result": "command", "on_hold": action.isOnHold, "version": state.version, "own_request": ownRequest, "action": action.uuid])
    holds[id] = command; refreshPrivacy(id, call); updateHoldCapability(id)
    holdTimers[id] = Timer.scheduledTimer(withTimeInterval: min(12, max(0, action.timeoutDate.timeIntervalSinceNow)), repeats: false) { [weak self] _ in
      guard self?.holds[id] === command else { return }; self?.detachHold(id)
    }
    emit(holdEvent(id, command))
  }
  private var mirrorActionIds = [UUID: UUID]()

  func start() {
    guard Self.enabled, provider == nil else { return }
    let settings = CXProviderConfiguration()
    settings.supportsVideo = false
    settings.supportedHandleTypes = [.phoneNumber, .generic]
    settings.maximumCallGroups = 1
    settings.maximumCallsPerCallGroup = 1
    let provider = CXProvider(configuration: settings)
    provider.setDelegate(self, queue: .main)
    self.provider = provider
    // The simulator build proves linkage, not ringing or APNs delivery.
    #if !targetEnvironment(simulator)
    registry = PKPushRegistry(queue: .main)
    registry?.delegate = self
    registry?.desiredPushTypes = [.voIP]
    #endif
    diag("phone.start", ["pushkit": registry != nil])
  }

  func connect(token: String) throws {
    guard Self.enabled, !token.isEmpty else { diag("phone.connect", ["result": "refused", "enabled": Self.enabled]); throw PhoneError() }
    start()
    // A configuration is created first so SDK construction cannot enable logs.
    let options = TxConfig(token: token, pushDeviceToken: pushToken,
      pushEnvironment: .production, logLevel: .none, reconnectClient: true,
      debug: false, enableCallReports: false)
    diag("voice.enabled", ["value": true, "was": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "source": "connect"])
    UserDefaults.standard.set(true, forKey: "linka.voice.enabled")
    let prepare = pushes.first.map { preparedPush != $0.key && calls[$0.key] == nil } ?? false
    diag("phone.connect", ["path": pushes.isEmpty ? calls.isEmpty ? "login" : "kept" : "push", "replaced": pushes.isEmpty ? calls.isEmpty : prepare,
      "call": pushes.first?.key as Any, "pushes": pushes.count, "calls": calls.count, "prepared": preparedPush != nil,
      "had_client": client != nil, "push_token": pushToken != nil])
    if let pending = pushes.first {
      if preparedPush != pending.key && calls[pending.key] == nil {
        ready = false; connectingPushToken = pushToken
        replaceClient()
        do { try client?.processVoIPNotification(txConfig: options, serverConfiguration: TxServerConfiguration(), pushMetaData: pending.value) }
        catch { diag("phone.connect_error", ["path": "push", "call": pending.key, "error": error]); throw error }
        preparedPush = pending.key
      }
      answerWhenAuthorized(pending.key)
      emit(["type": "push", "callId": pending.key.uuidString, "providerLegId": pending.value["telnyx_leg_id"] as? String ?? ""])
    } else if calls.isEmpty {
      ready = false; connectingPushToken = pushToken
      replaceClient()
      do { try client?.connect(txConfig: options) } catch { diag("phone.connect_error", ["path": "login", "error": error]); throw error }
    }
  }

  private func replaceClient() {
    clientDelegate = nil
    client?.delegate = nil
    client?.disconnect()
    let next = TxClient()
    let delegate = ClientDelegate(owner: self)
    clientDelegate = delegate; next.delegate = delegate; client = next
  }

  // SDK callbacks may already be queued when an account disconnects or a
  // connection is replaced. Only the current client's callbacks may reach UI.
  private final class ClientDelegate: NSObject, TxClientDelegate {
    weak var owner: LinkaPhone?
    init(owner: LinkaPhone) { self.owner = owner; super.init() }
    private func deliver(_ body: @escaping (LinkaPhone) -> Void) {
      DispatchQueue.main.async { [weak self] in
        guard let self, let owner = self.owner, owner.clientDelegate === self else { return }
        body(owner)
      }
    }
    func onClientReady() { deliver { $0.onClientReady() } }
    func onSocketConnected() {}
    func onSocketDisconnected() { deliver { $0.onSocketDisconnected() } }
    func onClientError(error: Error) { deliver { $0.onClientError(error: error) } }
    func onPushDisabled(success: Bool, message: String) {}
    func onSessionUpdated(sessionId: String) {}
    func onIncomingCall(call: Call) { deliver { $0.onIncomingCall(call: call) } }
    func onPushCall(call: Call) { deliver { $0.onIncomingCall(call: call) } }
    func onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?) { deliver { $0.onRemoteCallEnded(callId: callId, reason: reason) } }
    func onCallStateUpdated(callState: CallState, callId: UUID) { deliver { $0.onCallStateUpdated(callState: callState, callId: callId) } }
  }

  /** `reason` names the caller in the device log: a JS reason code, "provider_reset" or "native". */
  func disconnect(reason: String = "native") {
    diag("phone.disconnect", ["reason": reason, "calls": calls.count, "reported": reported.count, "pushes": pushes.count, "had_client": client != nil])
    diag("voice.enabled", ["value": false, "was": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "source": "disconnect"])
    UserDefaults.standard.set(false, forKey: "linka.voice.enabled")
    client?.disablePushNotifications()
    clientDelegate = nil
    client?.delegate = nil
    client?.disconnect()
    client = nil; ready = false; registeredPushToken = nil; connectingPushToken = nil; expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil
    for id in Set(reported).union(calls.keys).union(pushes.keys) { finish(id, reason: .failed, source: "disconnect") }
    calls.removeAll(); pushes.removeAll(); sessions.removeAll(); preparedPush = nil; audioActive = false
    emit(["type": "registration", "state": "unregistered"])
  }

  func snapshot() -> [String: Any] {
    return ["ready": ready, "audioActive": audioActive, "microphonePermission": microphonePermission(), "preparedPushCallId": preparedPush?.uuidString as Any? ?? NSNull(), "pushRejection": lastPushRejection as Any? ?? NSNull(), "pushRegistered": pushToken != nil && pushToken == registeredPushToken && ready,
     "wasEnabled": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "calls": Array(calls.keys).compactMap { id -> [String: Any]? in
       guard let session = sessions[id], let call = currentCall(id) ?? (recoveryTimers[id] != nil ? calls[id] : nil) else { return nil }
       return ["type": "restored", "callId": id.uuidString, "sessionId": session, "callControlId": controls[id] ?? "", "muted": userMuted.contains(id), "privacyHold": privacyHold.contains(id), "systemHeld": systemHeld.contains(id), "media": media[id].map { ["state": $0.state, "version": $0.version, "canHold": $0.canHold] as [String: Any] } as Any? ?? NSNull(), "number": outgoingLabels[id] ?? call.callInfo?.callerNumber ?? "",
         "state": recoveryTimers[id] != nil ? "RECONNECTING" : stateName(call.callState), "outgoing": outbound.contains(id)]
     }, "pendingSyncs": mirrors.map { mirrorEvent("holdSyncPending", $0.key, $0.value) }, "pendingHolds": holds.map { holdEvent($0.key, $0.value) }, "pending": pushes.map { id, metadata in
      ["type": "push", "callId": id.uuidString, "providerLegId": metadata["telnyx_leg_id"] as? String ?? ""]
    }]
  }

  private func microphonePermission() -> String {
    // Read current OS permission without prompting or activating audio.
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "undetermined"
    @unknown default: return "unknown"
    }
  }

  func authorize(callId: String, sessionId: String, controlId: String) throws {
    guard let id = UUID(uuidString: callId), UUID(uuidString: sessionId) != nil, !controlId.isEmpty,
      !finishedCalls.contains(id), calls[id] != nil || pushes[id] != nil else {
      let id = UUID(uuidString: callId)
      diag("call.authorize", ["result": "unknown_call", "call": id as Any, "finished": id.map { finishedCalls.contains($0) } ?? false,
        "invite": id.map { calls[$0] != nil } ?? false, "pushed": id.map { pushes[$0] != nil } ?? false])
      throw PhoneError()
    }
    guard sessions[id] == nil || (sessions[id] == sessionId && controls[id] == controlId),
      let leg = calls[id]?.telnyxLegId ?? (pushes[id]?["telnyx_leg_id"] as? String).flatMap(UUID.init(uuidString:)) else {
      diag("call.authorize", ["result": "mismatch", "call": id, "rebind": sessions[id] != nil, "invite": calls[id] != nil, "leg": calls[id]?.telnyxLegId != nil])
      throw PhoneError()
    }
    sessions[id] = sessionId; controls[id] = controlId; authorizedLegs[id] = leg
    diag("call.authorize", ["result": "ok", "call": id, "invite": calls[id] != nil, "answer_pending": pendingAnswers[id] != nil, "reported": reported.contains(id)])
    answerWhenAuthorized(id)
    if let call = currentCall(id) { handleAuthorized(call, id: id) }
  }

  func expectOutgoing(controlId: String, sessionId: String, number: String, genericHandle: Bool = false) throws {
    guard Self.enabled, ready, expected == nil, UUID(uuidString: sessionId) != nil else {
      diag("call.expect_outgoing", ["result": "refused", "ready": ready, "busy": expected != nil]); throw PhoneError()
    }
    expected = (controlId, sessionId, genericHandle ? String(number.prefix(120)) : number, genericHandle ? .generic : .phoneNumber)
    diag("call.expect_outgoing", ["result": "ok", "generic": genericHandle, "early_invites": calls.keys.filter { controls[$0] == controlId }.count])
    outgoingTimer?.invalidate()
    outgoingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      guard let self, self.expected?.controlId == controlId else { return }
      self.expected = nil
      LinkaPhone.diag("call.outgoing_timeout")
      self.emit(["type": "outgoingFailed", "sessionId": sessionId])
    }
    // The SIP invite can precede the HTTP response. Match only this returned leg.
    for (id, call) in calls where controls[id] == controlId {
      sessions[id] = sessionId
      handleAuthorized(call, id: id)
    }
  }

  private func handleAuthorized(_ call: Call, id: UUID) {
    if let attempt = expected, controls[id] == attempt.controlId, sessions[id] == attempt.sessionId {
      guard !reported.contains(id) else { return }
      expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil; outbound.insert(id); reported.insert(id)
      expireUnanswered(id)
      if attempt.handleType == .generic { outgoingLabels[id] = attempt.number }
      diag("call.outgoing", ["call": id, "generic": attempt.handleType == .generic])
      emit(["type": "outgoing", "callId": id.uuidString, "sessionId": attempt.sessionId, "callControlId": attempt.controlId, "number": attempt.number])
      let action = CXStartCallAction(call: id, handle: CXHandle(type: attempt.handleType, value: attempt.number))
      controller.request(CXTransaction(action: action)) { [weak self] error in
        LinkaPhone.diag("callkit.request", ["action": "start", "call": id, "error": error as Any])
        guard let self else { return }
        if error != nil { DispatchQueue.main.async { self.reject(callId: id.uuidString, source: "start_request_error") } }
      }
    } else if !reported.contains(id) {
      reportIncoming(id, number: call.callInfo?.callerNumber, name: call.callInfo?.callerName, completion: {})
    }
  }

  func answer(callId: String) throws {
    guard let id = UUID(uuidString: callId), sessions[id] != nil, reported.contains(id) else {
      diag("call.answer", ["result": "refused", "call": UUID(uuidString: callId) as Any]); throw PhoneError()
    }
    controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { [weak self] error in
      LinkaPhone.diag("callkit.request", ["action": "answer", "call": id, "error": error as Any])
      if error != nil { DispatchQueue.main.async { self?.reject(callId: callId, source: "answer_request_error") } }
    }
  }
  /** `source` names the caller in the device log; the JS bridge passes none. */
  func reject(callId: String, source: String = "js") {
    guard let id = UUID(uuidString: callId) else { diag("call.reject", ["source": source, "valid": false]); return }
    diag("call.reject", ["call": id, "source": source, "prepared": preparedPush == id && calls[id] == nil, "invite": calls[id] != nil,
      "reported": reported.contains(id), "established": established.contains(id)])
    if preparedPush == id, calls[id] == nil {
      // A push names no leg, so it is prepared before authorization. Decline it
      // through the SDK's decline_push login even before its INVITE; a later
      // INVITE for this finished call is hung up on arrival.
      client?.endCallFromCallkit(endAction: CXEndCallAction(call: id))
    } else { callForEnding(id)?.hangup() }
    finish(id, reason: .failed, source: source)
  }
  func confirmConnected(callId: String) {
    guard let id = UUID(uuidString: callId), outbound.contains(id), sessions[id] != nil,
      currentCall(id)?.callState == .ACTIVE, !connectedOutbound.contains(id) else { return }
    connectedOutbound.insert(id)
    diag("callkit.outgoing_connected", ["call": id])
    provider?.reportOutgoingCall(with: id, connectedAt: Date())
  }
  func end() {
    diag("call.end", ["expected": expected != nil, "call": reported.first as Any])
    if let attempt = expected {
      expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil
      emit(["type": "outgoingFailed", "sessionId": attempt.sessionId])
    }
    guard let id = reported.first else { return }
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      LinkaPhone.diag("callkit.request", ["action": "end", "call": id, "error": error as Any])
      if error != nil { DispatchQueue.main.async { self?.reject(callId: id.uuidString, source: "end_request_error") } }
    }
  }
  func mute(muted: Bool) throws {
    guard let id = reported.first, currentCall(id) != nil else { diag("call.mute", ["result": "refused"]); throw PhoneError() }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { error in
      LinkaPhone.diag("callkit.request", ["action": "mute", "call": id, "muted": muted, "error": error as Any])
    }
  }
  func speaker(enabled: Bool) { if enabled { client?.setSpeaker() } else { client?.setEarpiece() } }
  func dtmf(digits: String) throws {
    guard digits.range(of: "^[0-9*#]{1,32}$", options: .regularExpression) != nil,
      let id = reported.first, let call = currentCall(id), call.callState == .ACTIVE, !privacyHold.contains(id) else { throw PhoneError() }
    call.dtmf(dtmf: digits)
  }

  private func emit(_ event: [String: Any]) {
    diag("emit", ["type": event["type"] as? String ?? "none", "listener": listener != nil])
    if Thread.isMainThread { listener?(event) } else { DispatchQueue.main.async { [weak self] in self?.listener?(event) } }
  }
  private func reportIncoming(_ id: UUID, number: String?, name: String?, completion: @escaping () -> Void) {
    if reported.contains(id) { diag("callkit.report_incoming", ["call": id, "result": "already_reported"]); completion(); return }
    guard let provider else { diag("callkit.report_incoming", ["call": id, "result": "no_provider"]); completion(); return }
    reported.insert(id)
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .phoneNumber, value: String((number ?? "Neznámy volajúci").prefix(80)))
    update.localizedCallerName = String((name ?? "Linka pomoci").prefix(120))
    update.hasVideo = false; update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
    diag("callkit.report_incoming", ["call": id, "result": "sent", "has_number": number != nil, "has_name": name != nil, "holdable": false, "reported": reported.count])
    provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
      LinkaPhone.diag("callkit.report_incoming", ["call": id, "result": error == nil ? "ok" : "error", "error": error as Any])
      // PushKit completion follows the immediate native report, never a JS/network wait.
      completion()
      // A capability report sent before CallKit knew the call is not suppressed later.
      DispatchQueue.main.async { if error != nil { self?.reject(callId: id.uuidString, source: "report_incoming_error") } else { self?.reportedHoldable.removeValue(forKey: id) } }
    }
    expireUnanswered(id)
  }
  private func expireUnanswered(_ id: UUID) {
    guard timers[id] == nil else { return }
    timers[id] = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      guard let self, self.currentCall(id)?.callState != .ACTIVE else { return }
      self.reject(callId: id.uuidString, source: "unanswered_timeout")
    }
  }
  private func finish(_ id: UUID, reason: CXCallEndedReason, source: String) {
    guard reported.contains(id) || calls[id] != nil || pushes[id] != nil else { return }
    diag("call.finish", ["call": id, "reason": endedName(reason), "source": source, "reported": reported.contains(id), "invite": calls[id] != nil,
      "pushed": pushes[id] != nil, "established": established.contains(id), "answering": answering[id] != nil, "authorized": sessions[id] != nil])
    timers.removeValue(forKey: id)?.invalidate()
    recoveryTimers.removeValue(forKey: id)?.invalidate(); established.remove(id)
    failAnswer(id)
    detachHold(id); failMirror(id)
    holdTimers.removeValue(forKey: id)?.invalidate()
    mirrorActionIds = mirrorActionIds.filter { $0.value != id }
    holds.removeValue(forKey: id); media.removeValue(forKey: id); reportedHoldable.removeValue(forKey: id); systemHeld.remove(id); userMuted.remove(id); privacyHold.remove(id)
    if let request = requestedHolds.removeValue(forKey: id) { failLive(request); emit(["type": "heldCancelled", "callId": id.uuidString, "actionId": request.uuid.uuidString]) }
    provider?.reportCall(with: id, endedAt: Date(), reason: reason)
    reported.remove(id); pushes.removeValue(forKey: id); calls.removeValue(forKey: id); controls.removeValue(forKey: id); authorizedLegs.removeValue(forKey: id)
    if preparedPush == id { preparedPush = nil }
    finishedCalls.append(id); if finishedCalls.count > 50 { finishedCalls.removeFirst() }
    let session = sessions.removeValue(forKey: id)
    let wasOutgoing = outbound.remove(id) != nil
    connectedOutbound.remove(id); outgoingLabels.removeValue(forKey: id)
    emit(["type": "ended", "callId": id.uuidString, "sessionId": session ?? "", "outgoing": wasOutgoing])
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    diag("pushkit.token", ["changed": token != pushToken])
    pushToken = token
    // A future connection advertises the refreshed token; no token in logs/events.
    emit(["type": "pushTokenChanged"])
  }
  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    diag("pushkit.token_invalidated")
    pushToken = nil; client?.disablePushNotifications()
    emit(["type": "pushTokenChanged"])
  }
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else { diag("push.received", ["type": "other"]); completion(); return }
    let metadata = payload.dictionaryPayload["metadata"] as? [String: Any] ?? [:]
    let callId = (metadata["call_id"] as? String).flatMap(UUID.init(uuidString:))
    // Telnyx also pushes "Missed call!" / "Answered Elsewhere" for an offer that
    // ended before this phone answered. It ends that call; it is never a new one.
    let alert = (payload.dictionaryPayload["aps"] as? [String: Any])?["alert"] as? String
    let cleanup: CXCallEndedReason? = alert == "Missed call!" ? .unanswered : alert == "Answered Elsewhere" ? .answeredElsewhere : nil
    // Key names and flags only; the values (caller, IDs, tokens) never reach the log.
    diag("push.received", ["type": "voip", "call": callId as Any, "cleanup": cleanup != nil,
      "alert": alert.map { ["Incoming call!", "Missed call!", "Answered Elsewhere"].contains($0) ? "known" : "unknown" } ?? "none",
      "keys": metadata.keys.sorted(), "payload_keys": payload.dictionaryPayload.keys.map { String(describing: $0) }.sorted(),
      "has_call_id": metadata["call_id"] != nil, "call_id_valid": callId != nil,
      "has_voice_sdk_id": !(metadata["voice_sdk_id"] as? String ?? "").isEmpty, "has_leg_id": metadata["telnyx_leg_id"] != nil,
      "enabled": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "reported": reported.count, "calls": calls.count,
      "pushes": pushes.count, "finished": callId.map { finishedCalls.contains($0) } ?? false, "prepared": preparedPush != nil,
      "ready": ready, "client": client != nil, "listener": listener != nil])
    if let cleanup { endFromPush(callId, reason: cleanup, completion: completion); return }
    let id = callId ?? UUID()
    // Report every VoIP delivery, including malformed/late pushes. Invalid
    // offers are ended immediately rather than violating PushKit's report rule.
    reportIncoming(id, number: metadata["caller_number"] as? String, name: metadata["caller_name"] as? String, completion: completion)
    // Telnyx push metadata names the call and SDK session, not the provider leg:
    // SDK 4.2.2 reads telnyx_leg_id only from the INVITE, matched by call_id.
    let refusal: String? = callId == nil ? "missing_call_id" : (metadata["voice_sdk_id"] as? String ?? "").isEmpty ? "missing_voice_sdk_id"
      : finishedCalls.contains(id) ? "finished_call" : reported.count != 1 || !(calls.isEmpty || calls[id] != nil) ? "another_call"
      : !UserDefaults.standard.bool(forKey: "linka.voice.enabled") ? "voice_disabled" : nil
    if let refusal {
      // Key names only, never a value: the next device test shows what arrived.
      var rejection: [String: Any] = ["type": "pushRejected", "id": UUID().uuidString, "reason": refusal,
        "keys": metadata.keys.sorted().prefix(30).map { String($0.prefix(40)) },
        "payloadKeys": payload.dictionaryPayload.keys.map { String(String(describing: $0).prefix(40)) }.sorted().prefix(30).map { $0 }]
      // Whether an alert text is one Telnyx documents, so a new cleanup text shows up.
      if let alert { rejection["alertKnown"] = ["Incoming call!", "Missed call!", "Answered Elsewhere"].contains(alert) }
      diag("push.refused", ["reason": refusal, "call": id, "reported": reported.count, "calls": calls.count, "own_invite": calls[id] != nil,
        "enabled": UserDefaults.standard.bool(forKey: "linka.voice.enabled")])
      lastPushRejection = rejection; emit(rejection)
      reject(callId: id.uuidString, source: "push_refused"); return
    }
    pushes[id] = metadata
    diag("push.accepted", ["call": id, "pushes": pushes.count, "listener": listener != nil])
    // JS refreshes the short-lived provider JWT before preparing the socket.
    // Never reuse the token from before iOS suspended the application.
    emit(["type": "push", "callId": id.uuidString, "providerLegId": metadata["telnyx_leg_id"] as? String ?? ""])
  }
  /** JS reported this refusal; a remount or another login does not report it again. */
  func clearPushRejection(id: String) {
    if lastPushRejection?["id"] as? String == id { lastPushRejection = nil }
  }
  /** Ends a known, not yet answered offer, then satisfies PushKit with a
   * placeholder call ended at once, as Telnyx's SDK demo does. Apple requires a
   * report for every VoIP push, so this happens even during an established call:
   * iOS may briefly show call waiting and keep a blank Recents entry. */
  private func endFromPush(_ id: UUID?, reason: CXCallEndedReason, completion: @escaping () -> Void) {
    // A late notice about the offer never ends a call this phone answered.
    diag("push.cleanup", ["call": id as Any, "reason": endedName(reason), "established": id.map { established.contains($0) } ?? false,
      "tracked": id.map { reported.contains($0) || calls[$0] != nil || pushes[$0] != nil } ?? false])
    if let id, !established.contains(id), answering[id] == nil, reported.contains(id) || calls[id] != nil || pushes[id] != nil {
      callForEnding(id)?.hangup(); finish(id, reason: reason, source: "push_cleanup")
    }
    guard let provider else { completion(); return }
    let placeholder = UUID(), update = CXCallUpdate(), name = endedName(reason)
    update.remoteHandle = CXHandle(type: .generic, value: " ")
    update.hasVideo = false; update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
    provider.reportNewIncomingCall(with: placeholder, update: update) { error in
      LinkaPhone.diag("callkit.placeholder", ["reason": name, "error": error as Any])
      completion()
      provider.reportCall(with: placeholder, endedAt: Date(), reason: reason)
    }
  }

  func providerDidReset(_ provider: CXProvider) { diag("callkit.reset"); disconnect(reason: "provider_reset") }
  // ATTACH replaces the SDK Call without an incoming callback. Resolve only
  // already tracked calls, retaining the authenticated leg/control binding.
  private func currentCall(_ id: UUID) -> Call? {
    guard let previous = calls[id], !finishedCalls.contains(id) else { return nil }
    guard sessions[id] != nil else { return previous }
    guard let call = client?.getCall(callId: id) else { failAnswer(id); detachHold(id); failMirror(id); return nil }
    guard call.callInfo?.callId == id, let leg = authorizedLegs[id], call.telnyxLegId == leg,
      call.telnyxCallControlId == nil || call.telnyxCallControlId == controls[id] else {
      // SDK ATTACH answers before notifying its delegate. Reject a mismatched
      // peer for this tracked UUID instead of merely hiding its controls.
      if call.callInfo?.callId == id { call.hangup() }
      finish(id, reason: .failed, source: "attach_mismatch"); return nil
    }
    if call !== previous { failAnswer(id); detachHold(id); failMirror(id); calls[id] = call; applyMicrophone(id, call) }
    return call
  }
  private func callForEnding(_ id: UUID) -> Call? {
    if let call = currentCall(id) { return call }
    // During ATTACH the registry may temporarily have no entry. End only the
    // retained authorized call, never an unrelated replacement in that slot.
    guard recoveryTimers[id] != nil, client?.getCall(callId: id) == nil else { return nil }
    return calls[id]
  }
  private func beginRecovery(_ id: UUID) {
    guard established.contains(id), let session = sessions[id], let client, recoveryTimers[id] == nil else { return }
    diag("call.recovery", ["call": id])
    timers.removeValue(forKey: id)?.invalidate()
    detachHold(id); failMirror(id)
    recoveryTimers[id] = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      guard let self, self.client === client, self.sessions[id] == session else { return }
      self.callForEnding(id)?.hangup()
      self.finish(id, reason: .failed, source: "recovery_timeout")
    }
  }
  private func failAnswer(_ id: UUID) {
    if let action = pendingAnswers.removeValue(forKey: id), !action.isComplete { action.fail() }
    if let action = answering.removeValue(forKey: id), !action.isComplete { action.fail() }
  }
  private func answerExact(_ call: Call, id: UUID, action: CXCallAction) {
    guard answering[id] == nil, let client, let session = sessions[id], let control = controls[id] else {
      diag("call.answer_sdk", ["call": id, "result": "refused", "answering": answering[id] != nil, "client": client != nil]); action.fail(); return
    }
    answering[id] = action
    diag("call.answer_sdk", ["call": id, "result": "started", "outgoing": action is CXStartCallAction])
    call.answer { [weak self] answered in
      DispatchQueue.main.async {
        guard let self else { if !action.isComplete { action.fail() }; return }
        guard self.client === client, self.answering[id] === action, !action.isComplete,
          self.sessions[id] == session, self.controls[id] == control,
          self.currentCall(id) === call else {
          LinkaPhone.diag("call.answer_sdk", ["call": id, "result": "stale", "answered": answered])
          if self.answering[id] === action { self.answering.removeValue(forKey: id) }
          if !action.isComplete { action.fail() }
          return
        }
        self.answering.removeValue(forKey: id)
        LinkaPhone.diag("call.answer_sdk", ["call": id, "result": answered ? "answered" : "failed"])
        if answered { action.fulfill() }
        else { action.fail(); self.reject(callId: id.uuidString, source: "answer_failed") }
      }
    }
  }
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard !finishedCalls.contains(action.callUUID), pendingAnswers[action.callUUID] == nil, answering[action.callUUID] == nil,
      calls[action.callUUID] != nil || pushes[action.callUUID] != nil else {
      let id = action.callUUID
      diag("callkit.answer", ["call": id, "result": "refused", "finished": finishedCalls.contains(id), "pending": pendingAnswers[id] != nil,
        "answering": answering[id] != nil, "invite": calls[id] != nil, "pushed": pushes[id] != nil])
      action.fail(); return
    }
    pendingAnswers[action.callUUID] = action
    answerWhenAuthorized(action.callUUID)
    diag("callkit.answer", ["call": action.callUUID, "result": pendingAnswers[action.callUUID] != nil ? "awaiting_authorization" : "answering",
      "authorized": sessions[action.callUUID] != nil, "invite": calls[action.callUUID] != nil])
    if pendingAnswers[action.callUUID] != nil { emit(["type": "answerRequested", "callId": action.callUUID.uuidString]) }
  }
  private func answerWhenAuthorized(_ id: UUID) {
    guard sessions[id] != nil, let action = pendingAnswers[id], let call = currentCall(id) else { return }
    pendingAnswers.removeValue(forKey: id)
    // Never hand CallKit to the SDK's global next-INVITE auto-answer path.
    answerExact(call, id: id, action: action)
  }
  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard outbound.contains(action.callUUID), let call = currentCall(action.callUUID), sessions[action.callUUID] != nil else {
      diag("callkit.start", ["call": action.callUUID, "result": "refused", "outbound": outbound.contains(action.callUUID), "authorized": sessions[action.callUUID] != nil])
      action.fail(); return
    }
    diag("callkit.start", ["call": action.callUUID, "result": "started"])
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    // CallKit knows the call only now; an earlier capability report may have been lost.
    reportedHoldable.removeValue(forKey: action.callUUID); updateHoldCapability(action.callUUID)
    answerExact(call, id: action.callUUID, action: action)
  }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let id = action.callUUID
    diag("callkit.end", ["call": id, "prepared": preparedPush == id && calls[id] == nil, "invite": calls[id] != nil,
      "reported": reported.contains(id), "established": established.contains(id)])
    // A prepared push (our own fresh login) is declined through the SDK even
    // before its INVITE; the decline_push login never answers.
    if preparedPush == id, calls[id] == nil { client?.endCallFromCallkit(endAction: action) }
    else { callForEnding(id)?.hangup(); action.fulfill() }
    finish(id, reason: .remoteEnded, source: "callkit_end")
  }
  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let call = currentCall(action.callUUID) else { diag("callkit.mute", ["call": action.callUUID, "result": "refused"]); action.fail(); return }
    diag("callkit.mute", ["call": action.callUUID, "result": "ok", "muted": action.isMuted])
    if action.isMuted { userMuted.insert(action.callUUID) } else { userMuted.remove(action.callUUID) }
    applyMicrophone(action.callUUID, call)
    action.fulfill(); emit(["type": "muted", "muted": action.isMuted])
  }
  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    diag("callkit.timeout", ["action": String(describing: type(of: action)), "call": (action as? CXCallAction)?.callUUID as Any])
    if let held = action as? CXSetHeldCallAction {
      if mirrors[held.callUUID]?.action === held { failMirror(held.callUUID, timedOut: true) }
      else if holds[held.callUUID]?.action === held { detachHold(held.callUUID, timedOut: true) }
      else if requestedHolds[held.callUUID] === held {
        requestedHolds.removeValue(forKey: held.callUUID); holdTimers.removeValue(forKey: held.callUUID)?.invalidate()
        diag("hold.cancelled", ["call": held.callUUID, "action": held.uuid, "reason": "callkit_timeout"])
        emit(["type": "heldCancelled", "callId": held.callUUID.uuidString, "actionId": held.uuid.uuidString])
      }
      return
    }
    if let callAction = action as? CXCallAction { reject(callId: callAction.callUUID.uuidString, source: "callkit_timeout") }
  }
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    diag("callkit.audio", ["active": true, "client": client != nil])
    audioActive = true; client?.enableAudioSession(audioSession: audioSession)
    emit(["type": "audio", "active": true])
  }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    diag("callkit.audio", ["active": false, "client": client != nil])
    audioActive = false; client?.disableAudioSession(audioSession: audioSession)
    emit(["type": "audio", "active": false])
  }

  func onClientReady() {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onClientReady() }; return }
    diag("sdk.ready", ["reported": reported.count, "push_token": connectingPushToken != nil])
    ready = true; registeredPushToken = connectingPushToken
    for id in reported { updateHoldCapability(id) }
    emit(["type": "registration", "state": "registered"])
  }
  func onSocketDisconnected() {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onSocketDisconnected() }; return }
    diag("sdk.socket_disconnected", ["reported": reported.count, "was_ready": ready])
    ready = false
    for id in reported { detachHold(id); failMirror(id); updateHoldCapability(id) }
    emit(["type": "registration", "state": "unregistered"])
  }
  func onClientError(error: Error) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onClientError(error: error) }; return }
    diag("sdk.error", ["error": error, "reported": reported.count, "was_ready": ready])
    ready = false
    for id in reported { detachHold(id); failMirror(id); updateHoldCapability(id) }
    emit(["type": "registration", "state": "error"])
  }
  func onIncomingCall(call: Call) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onIncomingCall(call: call) }; return }
    guard let id = call.callInfo?.callId else { diag("sdk.invite", ["result": "no_call_id"]); call.hangup(); return }
    diag("sdk.invite", ["call": id, "finished": finishedCalls.contains(id), "pushed": pushes[id] != nil,
      "pushed_leg": !(pushes[id]?["telnyx_leg_id"] as? String ?? "").isEmpty, "authorized": sessions[id] != nil, "known": calls[id] != nil,
      "reported": reported.contains(id), "leg": call.telnyxLegId != nil, "control": call.telnyxCallControlId != nil, "state": stateName(call.callState)])
    guard !finishedCalls.contains(id) else { call.hangup(); return }
    // The INVITE answers its push by call_id, as in the SDK. Telnyx push metadata
    // names no leg; a leg it does name must be exactly this INVITE's.
    if let pushedLeg = pushes[id]?["telnyx_leg_id"] as? String, !pushedLeg.isEmpty {
      guard let expectedLeg = UUID(uuidString: pushedLeg), call.telnyxLegId == expectedLeg else {
        call.hangup(); finish(id, reason: .failed, source: "invite_push_leg_mismatch"); return
      }
    }
    if sessions[id] != nil {
      guard call.telnyxLegId == authorizedLegs[id], call.telnyxCallControlId == nil || call.telnyxCallControlId == controls[id] else {
        call.hangup(); finish(id, reason: .failed, source: "invite_authorized_mismatch"); return
      }
      if let previous = calls[id], previous !== call { failAnswer(id); detachHold(id); failMirror(id) }
    }
    calls[id] = call
    if sessions[id] != nil { applyMicrophone(id, call) }
    expireUnanswered(id)
    if sessions[id] != nil {
      handleAuthorized(call, id: id)
      answerWhenAuthorized(id)
    } else {
      // 4.2.2 populates telnyxCallControlId only after ANSWER. The leg UUID is
      // present on INVITE and is resolved to its control ID by our backend.
      emit(["type": "incoming", "callId": id.uuidString,
        "providerLegId": call.telnyxLegId?.uuidString ?? "",
        "number": call.callInfo?.callerNumber ?? "", "name": call.callInfo?.callerName ?? ""])
    }
  }
  func onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onRemoteCallEnded(callId: callId, reason: reason) }; return }
    diag("sdk.remote_ended", ["call": callId, "has_reason": reason != nil, "tracked": calls[callId] != nil || pushes[callId] != nil])
    finish(callId, reason: .remoteEnded, source: "remote_ended")
  }
  func onCallStateUpdated(callState: CallState, callId: UUID) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onCallStateUpdated(callState: callState, callId: callId) }; return }
    diag("sdk.state", ["call": callId, "state": stateName(callState), "finished": finishedCalls.contains(callId),
      "tracked": calls[callId] != nil || pushes[callId] != nil, "authorized": sessions[callId] != nil, "established": established.contains(callId)])
    if finishedCalls.contains(callId) {
      // A delayed ATTACH can arrive after local cancellation while its socket
      // was recovering. It must not leave an untracked live SDK peer.
      if case .DONE = callState { return }
      client?.getCall(callId: callId)?.hangup(); return
    }
    guard calls[callId] != nil || pushes[callId] != nil else { return }
    if case .DONE = callState { finish(callId, reason: .remoteEnded, source: "sdk_done"); return }
    if case .DROPPED(let reason) = callState {
      guard reason == .networkLost, established.contains(callId), sessions[callId] != nil else { reject(callId: callId.uuidString, source: "sdk_dropped"); return }
      beginRecovery(callId)
    }
    if case .RECONNECTING = callState { beginRecovery(callId) }
    if sessions[callId] != nil, currentCall(callId) == nil { return }
    if callState == .ACTIVE {
      established.insert(callId)
      timers.removeValue(forKey: callId)?.invalidate()
      recoveryTimers.removeValue(forKey: callId)?.invalidate()
      updateHoldCapability(callId)
    }
    emit(["type": "callState", "callId": callId.uuidString, "state": stateName(callState),
      "sessionId": sessions[callId] ?? ""])
  }
  private func stateName(_ callState: CallState) -> String {
    switch callState {
    case .NEW: return "NEW"
    case .CONNECTING: return "CONNECTING"
    case .RINGING: return "RINGING"
    case .ACTIVE: return "ACTIVE"
    case .HELD: return "HELD"
    case .RECONNECTING: return "RECONNECTING"
    case .DONE: return "DONE"
    case .DROPPED: return "DROPPED"
    }
  }
  private func endedName(_ reason: CXCallEndedReason) -> String {
    switch reason {
    case .failed: return "failed"
    case .remoteEnded: return "remote_ended"
    case .unanswered: return "unanswered"
    case .answeredElsewhere: return "answered_elsewhere"
    default: return "other"
    }
  }
}
