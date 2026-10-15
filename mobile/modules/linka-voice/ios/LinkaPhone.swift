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
final class LinkaPhone: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = LinkaPhone()
  static var enabled: Bool {
    Bundle.main.bundleIdentifier == "sk.linkapomoci.dispecing.test"
      && Bundle.main.object(forInfoDictionaryKey: "LinkaNativeVoiceEnabled") as? Bool == true
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
  private var expected: (controlId: String, sessionId: String, number: String)?
  private var outbound = Set<UUID>()
  private var connectedOutbound = Set<UUID>()
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
      pushEnvironment: .production, logLevel: .none, reconnectClient: true,
      debug: false, enableCallReports: false)
    UserDefaults.standard.set(true, forKey: "linka.voice.enabled")
    if let pending = pushes.first {
      if preparedPush != pending.key && calls[pending.key] == nil {
        ready = false; connectingPushToken = pushToken
        replaceClient()
        try client?.processVoIPNotification(txConfig: options, serverConfiguration: TxServerConfiguration(), pushMetaData: pending.value)
        preparedPush = pending.key
      }
      answerWhenAuthorized(pending.key)
      emit(["type": "push", "callId": pending.key.uuidString, "providerLegId": pending.value["telnyx_leg_id"] as? String ?? ""])
    } else if calls.isEmpty {
      ready = false; connectingPushToken = pushToken
      replaceClient()
      try client?.connect(txConfig: options)
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

  func disconnect() {
    UserDefaults.standard.set(false, forKey: "linka.voice.enabled")
    client?.disablePushNotifications()
    clientDelegate = nil
    client?.delegate = nil
    client?.disconnect()
    client = nil; ready = false; registeredPushToken = nil; connectingPushToken = nil; expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil
    for id in Set(reported).union(calls.keys).union(pushes.keys) { finish(id, reason: .failed) }
    calls.removeAll(); pushes.removeAll(); sessions.removeAll(); preparedPush = nil; audioActive = false
    emit(["type": "registration", "state": "unregistered"])
  }

  func snapshot() -> [String: Any] {
    return ["ready": ready, "audioActive": audioActive, "preparedPushCallId": preparedPush?.uuidString as Any? ?? NSNull(), "pushRegistered": pushToken != nil && pushToken == registeredPushToken && ready,
     "wasEnabled": UserDefaults.standard.bool(forKey: "linka.voice.enabled"), "calls": Array(calls.keys).compactMap { id -> [String: Any]? in
       guard let session = sessions[id], let call = currentCall(id) ?? (recoveryTimers[id] != nil ? calls[id] : nil) else { return nil }
       return ["type": "restored", "callId": id.uuidString, "sessionId": session, "number": call.callInfo?.callerNumber ?? "",
         "state": recoveryTimers[id] != nil ? "RECONNECTING" : stateName(call.callState), "outgoing": outbound.contains(id)]
     }, "pending": pushes.map { id, metadata in
      ["type": "push", "callId": id.uuidString, "providerLegId": metadata["telnyx_leg_id"] as? String ?? ""]
    }]
  }

  func authorize(callId: String, sessionId: String, controlId: String) throws {
    guard let id = UUID(uuidString: callId), UUID(uuidString: sessionId) != nil, !controlId.isEmpty,
      !finishedCalls.contains(id), calls[id] != nil || pushes[id] != nil else { throw PhoneError() }
    guard sessions[id] == nil || (sessions[id] == sessionId && controls[id] == controlId),
      let leg = calls[id]?.telnyxLegId ?? (pushes[id]?["telnyx_leg_id"] as? String).flatMap(UUID.init(uuidString:)) else { throw PhoneError() }
    sessions[id] = sessionId; controls[id] = controlId; authorizedLegs[id] = leg
    answerWhenAuthorized(id)
    if let call = currentCall(id) { handleAuthorized(call, id: id) }
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
    if preparedPush == id, sessions[id] != nil, calls[id] == nil {
      // Decline a verified push even before its actual INVITE arrives.
      client?.endCallFromCallkit(endAction: CXEndCallAction(call: id))
    } else { callForEnding(id)?.hangup() }
    finish(id, reason: .failed)
  }
  func confirmConnected(callId: String) {
    guard let id = UUID(uuidString: callId), outbound.contains(id), sessions[id] != nil,
      currentCall(id)?.callState == .ACTIVE, !connectedOutbound.contains(id) else { return }
    connectedOutbound.insert(id)
    provider?.reportOutgoingCall(with: id, connectedAt: Date())
  }
  func end() {
    if let attempt = expected {
      expected = nil; outgoingTimer?.invalidate(); outgoingTimer = nil
      emit(["type": "outgoingFailed", "sessionId": attempt.sessionId])
    }
    guard let id = reported.first else { return }
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      if error != nil { DispatchQueue.main.async { self?.reject(callId: id.uuidString) } }
    }
  }
  func mute(muted: Bool) throws {
    guard let id = reported.first, currentCall(id) != nil else { throw PhoneError() }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in }
  }
  func speaker(enabled: Bool) { if enabled { client?.setSpeaker() } else { client?.setEarpiece() } }
  func dtmf(digits: String) throws {
    guard digits.range(of: "^[0-9*#]{1,32}$", options: .regularExpression) != nil,
      let id = reported.first, let call = currentCall(id), call.callState == .ACTIVE else { throw PhoneError() }
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
    expireUnanswered(id)
  }
  private func expireUnanswered(_ id: UUID) {
    guard timers[id] == nil else { return }
    timers[id] = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      guard let self, self.currentCall(id)?.callState != .ACTIVE else { return }
      self.reject(callId: id.uuidString)
    }
  }
  private func finish(_ id: UUID, reason: CXCallEndedReason) {
    guard reported.contains(id) || calls[id] != nil || pushes[id] != nil else { return }
    timers.removeValue(forKey: id)?.invalidate()
    recoveryTimers.removeValue(forKey: id)?.invalidate(); established.remove(id)
    failAnswer(id)
    provider?.reportCall(with: id, endedAt: Date(), reason: reason)
    reported.remove(id); pushes.removeValue(forKey: id); calls.removeValue(forKey: id); controls.removeValue(forKey: id); authorizedLegs.removeValue(forKey: id)
    if preparedPush == id { preparedPush = nil }
    finishedCalls.append(id); if finishedCalls.count > 50 { finishedCalls.removeFirst() }
    let session = sessions.removeValue(forKey: id)
    let wasOutgoing = outbound.remove(id) != nil
    connectedOutbound.remove(id)
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
    // JS refreshes the short-lived provider JWT before preparing the socket.
    // Never reuse the token from before iOS suspended the application.
    emit(["type": "push", "callId": id.uuidString, "providerLegId": legId])
  }

  func providerDidReset(_ provider: CXProvider) { disconnect() }
  // ATTACH replaces the SDK Call without an incoming callback. Resolve only
  // already tracked calls, retaining the authenticated leg/control binding.
  private func currentCall(_ id: UUID) -> Call? {
    guard let previous = calls[id], !finishedCalls.contains(id) else { return nil }
    guard sessions[id] != nil else { return previous }
    guard let call = client?.getCall(callId: id) else { failAnswer(id); return nil }
    guard call.callInfo?.callId == id, let leg = authorizedLegs[id], call.telnyxLegId == leg,
      call.telnyxCallControlId == nil || call.telnyxCallControlId == controls[id] else {
      // SDK ATTACH answers before notifying its delegate. Reject a mismatched
      // peer for this tracked UUID instead of merely hiding its controls.
      if call.callInfo?.callId == id { call.hangup() }
      finish(id, reason: .failed); return nil
    }
    if call !== previous { failAnswer(id); calls[id] = call }
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
    timers.removeValue(forKey: id)?.invalidate()
    recoveryTimers[id] = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      guard let self, self.client === client, self.sessions[id] == session else { return }
      self.callForEnding(id)?.hangup()
      self.finish(id, reason: .failed)
    }
  }
  private func failAnswer(_ id: UUID) {
    if let action = pendingAnswers.removeValue(forKey: id), !action.isComplete { action.fail() }
    if let action = answering.removeValue(forKey: id), !action.isComplete { action.fail() }
  }
  private func answerExact(_ call: Call, id: UUID, action: CXCallAction) {
    guard answering[id] == nil, let client, let session = sessions[id], let control = controls[id] else { action.fail(); return }
    answering[id] = action
    call.answer { [weak self] answered in
      DispatchQueue.main.async {
        guard let self else { if !action.isComplete { action.fail() }; return }
        guard self.client === client, self.answering[id] === action, !action.isComplete,
          self.sessions[id] == session, self.controls[id] == control,
          self.currentCall(id) === call else {
          if self.answering[id] === action { self.answering.removeValue(forKey: id) }
          if !action.isComplete { action.fail() }
          return
        }
        self.answering.removeValue(forKey: id)
        if answered { action.fulfill() }
        else { action.fail(); self.reject(callId: id.uuidString) }
      }
    }
  }
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard !finishedCalls.contains(action.callUUID), pendingAnswers[action.callUUID] == nil, answering[action.callUUID] == nil,
      calls[action.callUUID] != nil || pushes[action.callUUID] != nil else { action.fail(); return }
    pendingAnswers[action.callUUID] = action
    answerWhenAuthorized(action.callUUID)
    if pendingAnswers[action.callUUID] != nil { emit(["type": "answerRequested", "callId": action.callUUID.uuidString]) }
  }
  private func answerWhenAuthorized(_ id: UUID) {
    guard sessions[id] != nil, let action = pendingAnswers[id], let call = currentCall(id) else { return }
    pendingAnswers.removeValue(forKey: id)
    // Never hand CallKit to the SDK's global next-INVITE auto-answer path.
    answerExact(call, id: id, action: action)
  }
  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard outbound.contains(action.callUUID), let call = currentCall(action.callUUID), sessions[action.callUUID] != nil else { action.fail(); return }
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    answerExact(call, id: action.callUUID, action: action)
  }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let id = action.callUUID
    // Never let an unverified push initiate SDK login through a decline.
    if preparedPush == id, sessions[id] != nil, calls[id] == nil { client?.endCallFromCallkit(endAction: action) }
    else { callForEnding(id)?.hangup(); action.fulfill() }
    finish(id, reason: .remoteEnded)
  }
  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let call = currentCall(action.callUUID) else { action.fail(); return }
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
    ready = true; registeredPushToken = connectingPushToken; emit(["type": "registration", "state": "registered"])
  }
  func onSocketDisconnected() {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onSocketDisconnected() }; return }
    ready = false; emit(["type": "registration", "state": "unregistered"])
  }
  func onClientError(error: Error) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onClientError(error: error) }; return }
    ready = false; emit(["type": "registration", "state": "error"])
  }
  func onIncomingCall(call: Call) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onIncomingCall(call: call) }; return }
    guard let id = call.callInfo?.callId else { call.hangup(); return }
    guard !finishedCalls.contains(id) else { call.hangup(); return }
    if let metadata = pushes[id] {
      guard let pushedLeg = metadata["telnyx_leg_id"] as? String,
        let expectedLeg = UUID(uuidString: pushedLeg), call.telnyxLegId == expectedLeg else {
        call.hangup(); finish(id, reason: .failed); return
      }
    }
    if sessions[id] != nil {
      guard call.telnyxLegId == authorizedLegs[id], call.telnyxCallControlId == nil || call.telnyxCallControlId == controls[id] else {
        call.hangup(); finish(id, reason: .failed); return
      }
      if let previous = calls[id], previous !== call { failAnswer(id) }
    }
    calls[id] = call
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
    finish(callId, reason: .remoteEnded)
  }
  func onCallStateUpdated(callState: CallState, callId: UUID) {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.onCallStateUpdated(callState: callState, callId: callId) }; return }
    if finishedCalls.contains(callId) {
      // A delayed ATTACH can arrive after local cancellation while its socket
      // was recovering. It must not leave an untracked live SDK peer.
      if case .DONE = callState { return }
      client?.getCall(callId: callId)?.hangup(); return
    }
    guard calls[callId] != nil || pushes[callId] != nil else { return }
    if case .DONE = callState { finish(callId, reason: .remoteEnded); return }
    if case .DROPPED(let reason) = callState {
      guard reason == .networkLost, established.contains(callId), sessions[callId] != nil else { reject(callId: callId.uuidString); return }
      beginRecovery(callId)
    }
    if case .RECONNECTING = callState { beginRecovery(callId) }
    if sessions[callId] != nil, currentCall(callId) == nil { return }
    if callState == .ACTIVE {
      established.insert(callId)
      timers.removeValue(forKey: callId)?.invalidate()
      recoveryTimers.removeValue(forKey: callId)?.invalidate()
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
