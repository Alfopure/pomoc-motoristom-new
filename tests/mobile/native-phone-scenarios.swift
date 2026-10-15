var checks: [[String: Any]] = []
func check(_ name: String, _ condition: Bool) { checks.append(["name": name, "pass": condition]) }
func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
let session = UUID().uuidString
func phone() -> LinkaPhone { let owner = LinkaPhone(); try! owner.connect(token: "fixture-memory-token"); owner.onClientReady(); return owner }
func incoming(_ owner: LinkaPhone, _ id: UUID = UUID(), leg: UUID = UUID()) -> Call {
  let call = Call(id, leg: leg); TxClient.last.registry[id] = call; owner.onIncomingCall(call: call)
  try! owner.authorize(callId: id.uuidString, sessionId: session, controlId: "fixture-control")
  return call
}
do {
  let owner = LinkaPhone(), previousClient = TxClient.last
  let permissions: [(AVAuthorizationStatus, String)] = [(.notDetermined, "undetermined"), (.denied, "denied"), (.restricted, "denied"), (.authorized, "granted")]
  for (permission, expected) in permissions {
    AVCaptureDevice.status = permission
    check("snapshot microphone permission \(permission)", owner.snapshot()["microphonePermission"] as? String == expected)
  }
  AVCaptureDevice.status = .denied
  check("snapshot reflects Settings revocation on same native owner", owner.snapshot()["microphonePermission"] as? String == "denied")
  check("permission snapshot only queries audio authorization", AVCaptureDevice.reads == Array(repeating: .audio, count: 5))
  check("permission snapshot never prompts or connects SDK", AVCaptureDevice.requests == 0 && AVAudioSession.requests == 0 && TxClient.last === previousClient)
  check("permission result does not imply push registration", owner.snapshot()["pushRegistered"] as? Bool == false)
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  let action = CXAnswerCallAction(call: id); owner.provider(CXProvider.last, perform: action)
  owner.reject(callId: id.uuidString)
  check("cancel promptly fails in-flight answer", action.failures == 1)
  call.completeAnswer(true); drain()
  check("late cancelled SDP never fulfills", action.fulfills == 0 && action.failures == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  let action = CXAnswerCallAction(call: id); owner.provider(CXProvider.last, perform: action)
  owner.disconnect(); try! owner.connect(token: "next-account-memory-token")
  call.completeAnswer(true); drain()
  check("old client completion cannot fulfill after account disconnect", action.fulfills == 0 && action.failures == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let old = incoming(owner, id)
  let replacement = Call(id, leg: old.telnyxLegId!); replacement.callState = .ACTIVE; TxClient.last.registry[id] = replacement
  // SDK ATTACH replaces its registry entry without onIncomingCall/onPushCall.
  owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  owner.provider(CXProvider.last, perform: CXSetMutedCallAction(call: id, muted: true)); try? owner.dtmf(digits: "5")
  owner.provider(CXProvider.last, perform: CXEndCallAction(call: id))
  check("reattach controls current exact SDK Call", replacement.mutes == 1 && replacement.tones == 1 && replacement.hangs == 1 && old.mutes == 0 && old.hangs == 0)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let old = incoming(owner, id)
  let foreign = Call(id, leg: UUID()); foreign.callState = .ACTIVE; TxClient.last.registry[id] = foreign
  let action = CXSetMutedCallAction(call: id, muted: true); owner.provider(CXProvider.last, perform: action)
  check("different provider leg never inherits authorization", action.failures == 1 && foreign.mutes == 0 && old.mutes == 0)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let old = incoming(owner, id)
  let action = CXAnswerCallAction(call: id); owner.provider(CXProvider.last, perform: action)
  let current = Call(id, leg: old.telnyxLegId!); current.callState = .ACTIVE; TxClient.last.registry[id] = current
  owner.onCallStateUpdated(callState: .ACTIVE, callId: id); old.completeAnswer(false); drain()
  check("stale SDP failure does not hang up reattached winner", current.hangs == 0 && action.fulfills == 0 && action.failures == 1)
  let mute = CXSetMutedCallAction(call: id, muted: true); owner.provider(CXProvider.last, perform: mute)
  check("reattached winner remains controllable after stale completion", current.mutes == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); try! owner.expectOutgoing(controlId: "fixture-control", sessionId: session, number: "fixture")
  let call = incoming(owner, id)
  let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "fixture")); owner.provider(CXProvider.last, perform: action)
  owner.reject(callId: id.uuidString); check("cancel promptly fails in-flight outgoing start", action.failures == 1)
  call.completeAnswer(true); drain(); check("late outgoing SDP never fulfills", action.fulfills == 0 && action.failures == 1)
  owner.disconnect()
}
do {
  let owner = phone(); check("pinned guarded SDK automatic reconnection enabled", TxClient.last.config?.reconnectClient == true); owner.disconnect()
}
do {
  let owner = phone(), id = UUID(), leg = UUID()
  let payload = PKPushPayload(["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture", "telnyx_leg_id": leg.uuidString]])
  owner.pushRegistry(PKPushRegistry(queue: .main), didReceiveIncomingPushWith: payload, for: .voIP, completion: {})
  let action = CXAnswerCallAction(call: id); owner.provider(CXProvider.last, perform: action)
  try! owner.connect(token: "fresh-push-token")
  check("push preparation exposes only its exact ID", owner.snapshot()["preparedPushCallId"] as? String == id.uuidString)
  let call = Call(id, leg: leg); TxClient.last.registry[id] = call; owner.onIncomingCall(call: call)
  check("CallKit answer waits for backend authorization", call.answerCount == 0 && !action.isComplete)
  try! owner.authorize(callId: id.uuidString, sessionId: session, controlId: "fixture-control")
  check("authorized push answers actual matching INVITE", call.answerCount == 1)
  call.completeAnswer(true); drain(); check("matching answer completes exactly once", action.fulfills == 1 && action.failures == 0)
  call.completeAnswer(true); drain(); check("duplicate SDK completion cannot fulfill twice", action.fulfills == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let old = incoming(owner, id)
  let current = Call(id, leg: old.telnyxLegId!); current.callState = .ACTIVE; TxClient.last.registry[id] = current
  let restored = owner.snapshot()["calls"] as? [[String: Any]]
  check("snapshot resolves ATTACH replacement before a delegate callback", restored?.first?["state"] as? String == "ACTIVE")
  current.telnyxCallControlId = "foreign-control"
  let mute = CXSetMutedCallAction(call: id, muted: true); owner.provider(CXProvider.last, perform: mute)
  check("same UUID and leg with foreign control cannot inherit authorization", mute.failures == 1 && current.mutes == 0)
  let unknown = UUID(); TxClient.last.registry[unknown] = Call(unknown, leg: UUID())
  let unknownAction = CXAnswerCallAction(call: unknown); owner.provider(CXProvider.last, perform: unknownAction)
  check("untracked SDK call is never adopted", unknownAction.failures == 1 && TxClient.last.registry[unknown]!.answerCount == 0)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  let first = CXAnswerCallAction(call: id), duplicate = CXAnswerCallAction(call: id)
  owner.provider(CXProvider.last, perform: first); owner.provider(CXProvider.last, perform: duplicate)
  check("duplicate CallKit action cannot replace pending owner", duplicate.failures == 1 && call.answerCount == 1)
  owner.provider(CXProvider.last, timedOutPerforming: first)
  check("CallKit timeout fails original action promptly", first.failures == 1)
  call.completeAnswer(false); drain(); check("late timeout failure remains single completion", first.failures == 1 && first.fulfills == 0)
  owner.disconnect()
}
do {
  let owner = phone(); let oldDelegate = TxClient.last.delegate!
  var incomingEvents = 0; owner.listen(owner: UUID()) { event in if event["type"] as? String == "incoming" { incomingEvents += 1 } }
  owner.disconnect(); try! owner.connect(token: "next-account-token")
  oldDelegate.onIncomingCall(call: Call(UUID(), leg: UUID())); drain()
  check("queued delegate from previous account cannot deliver an INVITE", incomingEvents == 0)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  call.callState = .ACTIVE; owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  call.callState = .DROPPED(reason: .networkLost); owner.onCallStateUpdated(callState: call.callState, callId: id)
  check("network loss retains authorized established call", (owner.snapshot()["calls"] as? [[String: Any]])?.first?["sessionId"] as? String == session)
  TxClient.last.registry.removeValue(forKey: id)
  check("temporary SDK absence retains recovery session for JS restoration", (owner.snapshot()["calls"] as? [[String: Any]])?.first?["state"] as? String == "RECONNECTING")
  let current = Call(id, leg: call.telnyxLegId!); current.callState = .ACTIVE; TxClient.last.registry[id] = current
  owner.onCallStateUpdated(callState: .ACTIVE, callId: id); Timer.fire(30)
  let action = CXSetMutedCallAction(call: id, muted: true); owner.provider(CXProvider.last, perform: action)
  check("reattach ACTIVE cancels recovery deadline and restores controls", current.hangs == 0 && action.fulfills == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  call.callState = .ACTIVE; owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  call.callState = .DROPPED(reason: .networkLost); owner.onCallStateUpdated(callState: call.callState, callId: id)
  let deadlineCount = Timer.scheduled.filter { $0.valid && $0.interval == 30 }.count
  owner.onCallStateUpdated(callState: .RECONNECTING(reason: .networkSwitch), callId: id)
  check("repeated recovery callbacks do not extend native deadline", deadlineCount == 1 && Timer.scheduled.filter { $0.valid && $0.interval == 30 }.count == 1)
  Timer.fire(30)
  check("native recovery deadline hangs up before releasing owned call", call.hangs == 1 && (owner.snapshot()["calls"] as? [[String: Any]])?.isEmpty == true)
  let late = Call(id, leg: call.telnyxLegId!); late.callState = .ACTIVE; TxClient.last.registry[id] = late
  owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  check("late ATTACH after recovery expiry cannot become orphaned active call", late.hangs == 1)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  call.callState = .ACTIVE; owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  owner.onCallStateUpdated(callState: .RECONNECTING(reason: .networkSwitch), callId: id)
  owner.onCallStateUpdated(callState: .DONE(), callId: id)
  check("terminal DONE cancels native recovery deadline immediately", Timer.scheduled.filter { $0.valid && $0.interval == 30 }.isEmpty && (owner.snapshot()["calls"] as? [[String: Any]])?.isEmpty == true)
  owner.disconnect()
}
for mismatch in ["leg", "control"] {
  let owner = phone(), id = UUID(); let previous = incoming(owner, id)
  previous.callState = .ACTIVE; owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  owner.onCallStateUpdated(callState: .RECONNECTING(reason: .networkSwitch), callId: id)
  let candidate = Call(id, leg: mismatch == "leg" ? UUID() : previous.telnyxLegId!)
  candidate.callState = .ACTIVE
  if mismatch == "control" { candidate.telnyxCallControlId = "foreign-control" }
  TxClient.last.registry[id] = candidate
  // SDK acceptReAttach can activate media before its state callback reaches us.
  owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  check("unauthorized ATTACH \(mismatch) peer is ended", candidate.hangs == 1)
  check("definitive ATTACH \(mismatch) mismatch cannot masquerade as temporary absence", (owner.snapshot()["calls"] as? [[String: Any]])?.isEmpty == true)
  owner.disconnect()
}
let passed = checks.allSatisfy { $0["pass"] as? Bool == true }
let report: [String: Any] = ["kind": "actual-LinkaPhone-methods-controlled-frameworks", "passed": passed, "checks": checks, "physicalDevice": false, "sdkNetworkingExecuted": false]
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
if !passed { exit(1) }
