import AVFoundation
import CallKit
import PushKit
import TelnyxRTC
import UIKit

private struct PhoneError: LocalizedError {
  var errorDescription: String? { "Telefón nie je pripravený na túto akciu." }
}

/** Single native owner of signaling and audio. Credentials/push payloads stay
 * in memory. Every answer waits for the authenticated backend's exact offer.
 * No client-originated external dial exists; the server calls our operator leg. */
final class LinkaPhone: NSObject, PKPushRegistryDelegate, CXProviderDelegate, TxClientDelegate {
  static let shared = LinkaPhone()
  static var enabled: Bool {
    Bundle.main.bundleIdentifier == "sk.linkapomoci.dispecing.test"
      && Bundle.main.object(forInfoDictionaryKey: "LinkaNativeVoiceEnabled") as? Bool == true
  }
  var listener: (([String: Any]) -> Void)?
  private var provider: CXProvider?
  private let controller = CXCallController()
  private var registry: PKPushRegistry?
  private var client: TxClient?
  private var config: TxConfig?
  private var pushToken: String?
  private var ready = false
  private var audioActive = false
  private var calls = [UUID: Call]()
  private var pushes = [UUID: [String: Any]]()
  private var sessions = [UUID: String]()
  private var reported = Set<UUID>()
  private var timers = [UUID: Timer]()
  private var pendingAnswers = [UUID: CXAnswerCallAction]()
  private var expected: (controlId: String, sessionId: String, number: String)?
  private var outbound = Set<UUID>()
  private var outgoingTimer: Timer?
  private var finishedCalls = [UUID]()
  private var preparedPush: UUID?

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
  }

  func connect(token: String) throws {
    guard Self.enabled, !token.isEmpty else { throw PhoneError() }
    start()
    // A configuration is created first so SDK construction cannot enable logs.
    let options = TxConfig(token: token, pushDeviceToken: pushToken,
      pushEnvironment: .production, logLevel: .none, reconnectClient: false,
      debug: false, enableCallReports: false)
    config = options
    UserDefaults.standard.set(true, forKey: "linka.voice.enabled")
    if client == nil { client = TxClient(); client?.delegate = self }
    if let pending = pushes.first {
      if preparedPush != pending.key {
        try client?.processVoIPNotification(txConfig: options, serverConfiguration: TxServerConfiguration(), pushMetaData: pending.value)
        preparedPush = pending.key
      }
      emit(["type": "push", "callId": pending.key.uuidString, "providerLegId": pending.value["telnyx_leg_id"] as? String ?? ""])
    } else if calls.isEmpty {
      ready = false
      client?.disconnect()
      try client?.connect(txConfig: options)
    }
  }

  func disconnect() {
    UserDefaults.standard.set(false, forKey: "linka.voice.enabled")
    client?.disablePushNotifications()
    client?.disconnect()
    client = nil; config = nil; ready = false; expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil
    for id in Set(reported).union(calls.keys).union(pushes.keys) { finish(id, reason: .failed) }
    calls.removeAll(); pushes.removeAll(); sessions.removeAll(); preparedPush = nil; audioActive = false
    emit(["type": "registration", "state": "unregistered"])
  }

  func snapshot() -> [String: Any] {
    ["ready": ready, "audioActive": audioActive, "pushRegistered": pushToken != nil && ready,
     "wasEnabled": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "calls": calls.compactMap { id, call -> [String: Any]? in
       guard let session = sessions[id] else { return nil }
       return ["type": "restored", "callId": id.uuidString, "sessionId": session, "number": call.callInfo?.callerNumber ?? "",
         "state": stateName(call.callState), "outgoing": outbound.contains(id)]
     }, "pending": pushes.map { id, metadata in
      ["type": "push", "callId": id.uuidString, "providerLegId": metadata["telnyx_leg_id"] as? String ?? ""]
    }]
  }

  func authorize(callId: String, sessionId: String) throws {
    guard let id = UUID(uuidString: callId), UUID(uuidString: sessionId) != nil,
      calls[id] != nil || pushes[id] != nil else { throw PhoneError() }
    sessions[id] = sessionId
    if let action = pendingAnswers.removeValue(forKey: id) { client?.answerFromCallkit(answerAction: action) }
    if let call = calls[id] { handleAuthorized(call, id: id) }
  }

  func expectOutgoing(controlId: String, sessionId: String, number: String) throws {
    guard Self.enabled, ready, expected == nil, UUID(uuidString: sessionId) != nil else { throw PhoneError() }
    expected = (controlId, sessionId, number)
    outgoingTimer?.invalidate()
    outgoingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      guard let self, self.expected?.controlId == controlId else { return }
      self.expected = nil
      self.emit(["type": "outgoingFailed", "sessionId": sessionId])
    }
    // The SIP invite can precede the HTTP response. Match only this returned leg.
    for (id, call) in calls where call.telnyxCallControlId == controlId {
      sessions[id] = sessionId
      handleAuthorized(call, id: id)
    }
  }

  private func handleAuthorized(_ call: Call, id: UUID) {
    if let attempt = expected, call.telnyxCallControlId == attempt.controlId {
      guard !reported.contains(id) else { return }
      expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil; outbound.insert(id); reported.insert(id)
      emit(["type": "outgoing", "callId": id.uuidString, "sessionId": attempt.sessionId, "number": attempt.number])
      let action = CXStartCallAction(call: id, handle: CXHandle(type: .phoneNumber, value: attempt.number))
      controller.request(CXTransaction(action: action)) { [weak self] error in
        guard let self else { return }
        if error != nil { DispatchQueue.main.async { self.reject(callId: id.uuidString) } }
      }
    } else if !reported.contains(id) {
      reportIncoming(id, number: call.callInfo?.callerNumber, name: call.callInfo?.callerName, completion: {})
    }
  }

  func answer(callId: String) throws {
    guard let id = UUID(uuidString: callId), sessions[id] != nil, reported.contains(id) else { throw PhoneError() }
    controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { [weak self] error in
      if error != nil { DispatchQueue.main.async { self?.reject(callId: callId) } }
    }
  }
  func reject(callId: String) {
    guard let id = UUID(uuidString: callId) else { return }
    calls[id]?.hangup()
    finish(id, reason: .failed)
  }
  func end() {
    guard let id = reported.first else { return }
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      if error != nil { DispatchQueue.main.async { self?.reject(callId: id.uuidString) } }
    }
  }
  func mute(muted: Bool) throws {
    guard let id = reported.first, calls[id] != nil else { throw PhoneError() }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in }
  }
  func speaker(enabled: Bool) { if enabled { client?.setSpeaker() } else { client?.setEarpiece() } }
  func dtmf(digits: String) throws {
    guard digits.range(of: "^[0-9*#]{1,32}$", options: .regularExpression) != nil,
      let id = reported.first, let call = calls[id], call.callState == .ACTIVE else { throw PhoneError() }
    call.dtmf(dtmf: digits)
  }

  private func emit(_ event: [String: Any]) {
    if Thread.isMainThread { listener?(event) } else { DispatchQueue.main.async { [weak self] in self?.listener?(event) } }
  }
  private func reportIncoming(_ id: UUID, number: String?, name: String?, completion: @escaping () -> Void) {
    if reported.contains(id) { completion(); return }
    guard let provider else { completion(); return }
    reported.insert(id)
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .phoneNumber, value: String((number ?? "Neznámy volajúci").prefix(80)))
    update.localizedCallerName = String((name ?? "Linka pomoci").prefix(120))
    update.hasVideo = false; update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
    provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
      // PushKit completion follows the immediate native report, never a JS/network wait.
      completion()
      if error != nil { DispatchQueue.main.async { self?.reject(callId: id.uuidString) } }
    }
    timers[id] = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      guard let self, self.calls[id]?.callState != .ACTIVE else { return }
      self.reject(callId: id.uuidString)
    }
  }
  private func finish(_ id: UUID, reason: CXCallEndedReason) {
    guard reported.contains(id) || calls[id] != nil || pushes[id] != nil else { return }
    timers.removeValue(forKey: id)?.invalidate()
    pendingAnswers.removeValue(forKey: id)?.fail()
    provider?.reportCall(with: id, endedAt: Date(), reason: reason)
    reported.remove(id); pushes.removeValue(forKey: id); calls.removeValue(forKey: id)
    if preparedPush == id { preparedPush = nil }
    finishedCalls.append(id); if finishedCalls.count > 50 { finishedCalls.removeFirst() }
    let session = sessions.removeValue(forKey: id)
    let wasOutgoing = outbound.remove(id) != nil
    emit(["type": "ended", "callId": id.uuidString, "sessionId": session ?? "", "outgoing": wasOutgoing])
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    pushToken = credentials.token.map { String(format: "%02x", $0) }.joined()
    // A future connection advertises the refreshed token; no token in logs/events.
    emit(["type": "pushTokenChanged"])
  }
  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    pushToken = nil; client?.disablePushNotifications()
    emit(["type": "pushTokenChanged"])
  }
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else { completion(); return }
    let metadata = payload.dictionaryPayload["metadata"] as? [String: Any] ?? [:]
    let id = (metadata["call_id"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
    // Report every VoIP delivery, including malformed/late pushes. Invalid
    // offers are ended immediately rather than violating PushKit's report rule.
    reportIncoming(id, number: metadata["caller_number"] as? String, name: metadata["caller_name"] as? String, completion: completion)
    guard let callId = metadata["call_id"] as? String, UUID(uuidString: callId) != nil,
      let sdkId = metadata["voice_sdk_id"] as? String, !sdkId.isEmpty,
      let legId = metadata["telnyx_leg_id"] as? String, UUID(uuidString: legId) != nil,
      !finishedCalls.contains(id), reported.count == 1, calls.isEmpty || calls[id] != nil,
      UserDefaults.standard.bool(forKey: "linka.voice.enabled") else { reject(callId: id.uuidString); return }
    pushes[id] = metadata
    if let config {
      do { try client?.processVoIPNotification(txConfig: config, serverConfiguration: TxServerConfiguration(), pushMetaData: metadata); preparedPush = id }
      catch { reject(callId: id.uuidString); return }
    }
    emit(["type": "push", "callId": id.uuidString, "providerLegId": legId])
  }

  func providerDidReset(_ provider: CXProvider) { disconnect() }
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard calls[action.callUUID] != nil || pushes[action.callUUID] != nil else { action.fail(); return }
    if sessions[action.callUUID] != nil { client?.answerFromCallkit(answerAction: action) }
    else { pendingAnswers[action.callUUID] = action; emit(["type": "answerRequested", "callId": action.callUUID.uuidString]) }
  }
  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard outbound.contains(action.callUUID), let call = calls[action.callUUID], sessions[action.callUUID] != nil else { action.fail(); return }
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    call.answer(); action.fulfill()
  }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let id = action.callUUID
    // Never let an unverified push initiate SDK login through a decline.
    if pushes[id] != nil, sessions[id] != nil { client?.endCallFromCallkit(endAction: action) }
    else { calls[id]?.hangup(); action.fulfill() }
    finish(id, reason: .remoteEnded)
  }
  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let call = calls[action.callUUID] else { action.fail(); return }
    if action.isMuted { call.muteAudio() } else { call.unmuteAudio() }
    action.fulfill(); emit(["type": "muted", "muted": action.isMuted])
  }
  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    if let callAction = action as? CXCallAction { reject(callId: callAction.callUUID.uuidString) }
  }
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    audioActive = true; client?.enableAudioSession(audioSession: audioSession)
    emit(["type": "audio", "active": true])
  }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    audioActive = false; client?.disableAudioSession(audioSession: audioSession)
    emit(["type": "audio", "active": false])
  }

  func onClientReady() {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onClientReady() }; return }
    ready = true; emit(["type": "registration", "state": "registered"])
  }
  func onSocketConnected() {}
  func onSocketDisconnected() {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onSocketDisconnected() }; return }
    ready = false; emit(["type": "registration", "state": "unregistered"])
  }
  func onClientError(error: Error) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onClientError(error: error) }; return }
    ready = false; emit(["type": "registration", "state": "error"])
  }
  func onPushDisabled(success: Bool, message: String) {}
  func onSessionUpdated(sessionId: String) {}
  func onIncomingCall(call: Call) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onIncomingCall(call: call) }; return }
    guard let id = call.callInfo?.callId else { call.hangup(); return }
    guard !finishedCalls.contains(id) else { call.hangup(); return }
    calls[id] = call
    if let metadata = pushes[id], call.telnyxCallControlId?.isEmpty != false {
      emit(["type": "push", "callId": id.uuidString, "providerLegId": metadata["telnyx_leg_id"] as? String ?? ""])
      return
    }
    if let expected, expected.controlId == call.telnyxCallControlId {
      sessions[id] = expected.sessionId; handleAuthorized(call, id: id)
    } else {
      emit(["type": "incoming", "callId": id.uuidString, "callControlId": call.telnyxCallControlId ?? "",
        "number": call.callInfo?.callerNumber ?? "", "name": call.callInfo?.callerName ?? ""])
    }
  }
  func onPushCall(call: Call) { onIncomingCall(call: call) }
  func onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onRemoteCallEnded(callId: callId, reason: reason) }; return }
    finish(callId, reason: .remoteEnded)
  }
  func onCallStateUpdated(callState: CallState, callId: UUID) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onCallStateUpdated(callState: callState, callId: callId) }; return }
    if case .DONE = callState { finish(callId, reason: .remoteEnded); return }
    if case .DROPPED = callState { finish(callId, reason: .failed); return }
    if callState == .ACTIVE {
      timers.removeValue(forKey: callId)?.invalidate()
      if outbound.contains(callId) { provider?.reportOutgoingCall(with: callId, connectedAt: Date()) }
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
}
