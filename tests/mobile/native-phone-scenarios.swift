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
  var events: [[String: Any]] = []; owner.listen(owner: UUID()) { events.append($0) }
  // Telnyx VoIP push metadata documented for SDK 4.2.2: no provider leg.
  let payload = PKPushPayload(["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture", "caller_name": "fixture", "caller_number": "fixture"]])
  owner.pushRegistry(PKPushRegistry(queue: .main), didReceiveIncomingPushWith: payload, for: .voIP, completion: {})
  check("documented push without a leg is kept, never ended", !events.contains { $0["type"] as? String == "ended" }
    && events.contains { $0["type"] as? String == "push" && $0["callId"] as? String == id.uuidString && $0["providerLegId"] as? String == "" })
  let action = CXAnswerCallAction(call: id); owner.provider(CXProvider.last, perform: action)
  try! owner.connect(token: "fresh-push-token")
  check("push preparation exposes only its exact ID", owner.snapshot()["preparedPushCallId"] as? String == id.uuidString)
  let call = Call(id, leg: leg); TxClient.last.registry[id] = call; owner.onIncomingCall(call: call)
  check("push INVITE emits incoming with its own leg", events.contains { $0["type"] as? String == "incoming" && $0["callId"] as? String == id.uuidString && $0["providerLegId"] as? String == leg.uuidString }
    && !events.contains { $0["type"] as? String == "ended" })
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
// Exercise actual outgoing-handle construction, never an emulated handle factory.
for generic in [false, true] {
  let owner = phone(), id = UUID()
  var outgoingEvents: [[String: Any]] = []
  owner.listen(owner: UUID()) { event in if event["type"] as? String == "outgoing" { outgoingEvents.append(event) } }
  CXCallController.transactions = []
  let label = generic ? "Kolega Žaneta " + String(repeating: "á", count: 140) : "+421900000123"
  let expectedLabel = generic ? String(label.prefix(120)) : label
  try! fixtureExpectOutgoing(owner, controlId: "fixture-control", sessionId: session, number: label, genericHandle: generic)
  check("outgoing expectation does not create SDK call or CallKit start \(generic)", TxClient.last.registry.isEmpty && CXCallController.transactions.isEmpty)
  let call = incoming(owner, id)
  let starts = CXCallController.transactions.compactMap { $0.action as? CXStartCallAction }
  check("actual outgoing handle kind \(generic)", starts.count == 1 && starts.first?.handle.type == (generic ? .generic : .phoneNumber))
  check("actual outgoing handle bounded display label \(generic)", starts.first?.handle.value == expectedLabel)
  check("outgoing event preserves display label \(generic)", outgoingEvents.first?["number"] as? String == expectedLabel)
  if generic {
    check("generic outgoing snapshot preserves peer label", (owner.snapshot()["calls"] as? [[String: Any]])?.first?["number"] as? String == expectedLabel)
  }
  check("outgoing handle does not answer before CallKit action \(generic)", call.answerCount == 0)
  check("provider supports both explicit handle kinds \(generic)", CXProvider.last.configuration.supportedHandleTypes == [.generic, .phoneNumber])
  owner.disconnect()
  check("outgoing label removed with call on disconnect \(generic)", (owner.snapshot()["calls"] as? [[String: Any]])?.isEmpty == true)
}
do {
  let owner = phone(); CXCallController.transactions = []
  try! owner.expectOutgoing(controlId: "fixture-control", sessionId: session, number: "+421900000123")
  _ = incoming(owner)
  check("omitted generic flag retains external phoneNumber handle", (CXCallController.transactions.first?.action as? CXStartCallAction)?.handle.type == .phoneNumber)
  owner.disconnect()
}
for mismatch in ["control", "session"] {
  let owner = phone(), id = UUID(); CXCallController.transactions = []
  try! fixtureExpectOutgoing(owner, controlId: "fixture-control", sessionId: session, number: "Kolega", genericHandle: true)
  let call = Call(id, leg: UUID()); TxClient.last.registry[id] = call; owner.onIncomingCall(call: call)
  try! owner.authorize(callId: id.uuidString, sessionId: mismatch == "session" ? UUID().uuidString : session,
    controlId: mismatch == "control" ? "other-control" : "fixture-control")
  check("mismatched \(mismatch) cannot start colleague handle", !CXCallController.transactions.contains { $0.action is CXStartCallAction } && call.answerCount == 0)
  owner.disconnect()
}
// Server-mediated hold: controlled CallKit boundary, no HTTP/provider emulation.
func heldRows(_ owner: LinkaPhone) -> [[String: Any]] { owner.snapshot()["pendingHolds"] as? [[String: Any]] ?? [] }
func media(_ owner: LinkaPhone, _ id: UUID, _ state: String, _ version: Int = 1, _ capable: Bool = true) {
  try! owner.syncMedia(callId: id.uuidString, sessionId: session, controlId: "fixture-control", state: state, version: version, canHold: capable)
}
func settle(_ owner: LinkaPhone, _ id: UUID, _ action: CXSetHeldCallAction, _ outcome: String, _ state: String, _ version: Int = 2) {
  try! owner.resolveHold(callId: id.uuidString, sessionId: session, controlId: "fixture-control", actionId: action.uuid.uuidString, outcome: outcome, state: state, version: version, canHold: true)
}
func activeFixture() -> (LinkaPhone, UUID, Call) {
  let owner = phone(), id = UUID(); let call = incoming(owner, id)
  call.callState = .ACTIVE; owner.onCallStateUpdated(callState: .ACTIVE, callId: id)
  CXCallController.transactions = []; return (owner, id, call)
}
do {
  let (owner,id,call) = activeFixture()
  let disabled = CXSetHeldCallAction(call:id,onHold:true); owner.provider(CXProvider.last,perform:disabled)
  check("hold disabled before authoritative capability", disabled.failures == 1 && !call.isMuted)
  media(owner,id,"active")
  check("exact accepted capability reported to CallKit", CXProvider.last.updates[id]?.supportsHolding == true)
  var events:[[String:Any]]=[]; owner.listen(owner:UUID()) { events.append($0) }
  let action = CXSetHeldCallAction(call:id,onHold:true); owner.provider(CXProvider.last,perform:action)
  check("hold waits server and immediately gates microphone", !action.isComplete && call.isMuted && heldRows(owner).first?["expectedVersion"] as? Int == 1)
  check("heldRequested carries exact immutable identity", events.contains { $0["type"] as? String == "heldRequested" && $0["actionId"] as? String == action.uuid.uuidString && $0["callControlId"] as? String == "fixture-control" })
  check("initial hold dispatch claimed exactly once", owner.claimHold(callId:id.uuidString,actionId:action.uuid.uuidString) && !owner.claimHold(callId:id.uuidString,actionId:action.uuid.uuidString))
  media(owner,id,"active")
  check("old active status cannot release claimed privacy", call.isMuted && !action.isComplete)
  let opposite = CXSetHeldCallAction(call:id,onHold:false); owner.provider(CXProvider.last,perform:opposite)
  check("opposite command cannot replace pending UUID", opposite.failures == 1 && heldRows(owner).first?["actionId"] as? String == action.uuid.uuidString)
  settle(owner,id,action,"uncertain","pending")
  check("uncertain media never fulfills action", action.fulfills == 0 && call.isMuted)
  settle(owner,id,action,"confirmed","held")
  check("same-version provider convergence fulfills hold", action.fulfills == 1 && call.isMuted && heldRows(owner).isEmpty)
  let resume = CXSetHeldCallAction(call:id,onHold:false); owner.provider(CXProvider.last,perform:resume)
  _ = owner.claimHold(callId:id.uuidString,actionId:resume.uuid.uuidString)
  settle(owner,id,resume,"uncertain","pending",3)
  check("resume lost response retains microphone privacy", call.isMuted && resume.fulfills == 0)
  settle(owner,id,resume,"confirmed","active",3)
  check("confirmed resume releases privacy after CallKit completion", resume.fulfills == 1 && !call.isMuted)
  owner.disconnect()
}
for claimed in [false,true] {
  let (owner,id,call) = activeFixture(); media(owner,id,"active")
  let action = CXSetHeldCallAction(call:id,onHold:true); owner.provider(CXProvider.last,perform:action)
  if claimed { _ = owner.claimHold(callId:id.uuidString,actionId:action.uuid.uuidString) }
  action.timeoutDate = Date().addingTimeInterval(-1)
  owner.provider(CXProvider.last,timedOutPerforming:action)
  check("system hold timeout never completes expired action \(claimed)", action.fulfills == 0 && action.failures == 0)
  check("system hold timeout never ends call \(claimed)", call.hangs == 0 && (owner.snapshot()["calls"] as? [[String:Any]])?.count == 1)
  check("expired unclaimed action cannot start HTTP \(claimed)", !owner.claimHold(callId:id.uuidString,actionId:action.uuid.uuidString))
  check("only claimed timeout retains exact uncertainty \(claimed)", claimed ? heldRows(owner).first?["phase"] as? String == "uncertain" : heldRows(owner).isEmpty)
  if claimed { settle(owner,id,action,"confirmed","held"); check("late receipt never fulfills expired system action", action.fulfills == 0 && call.isMuted) }
  owner.disconnect()
}
do {
  let (owner,id,call) = activeFixture(); media(owner,id,"active")
  let mute = CXSetMutedCallAction(call:id,muted:true); owner.provider(CXProvider.last,perform:mute)
  media(owner,id,"held",2)
  let mirror = CXCallController.transactions.last?.action as? CXSetHeldCallAction
  if let mirror { owner.provider(CXProvider.last,perform:mirror) }
  check("server hold mirror has no dispatch command", mirror?.fulfills == 1 && heldRows(owner).isEmpty)
  media(owner,id,"active",3)
  if let resume = CXCallController.transactions.last?.action as? CXSetHeldCallAction { owner.provider(CXProvider.last,perform:resume) }
  check("server resume preserves user mute preference", call.isMuted && (owner.snapshot()["calls"] as? [[String:Any]])?.first?["muted"] as? Bool == true)
  owner.disconnect()
}
do {
  let (owner,id,old) = activeFixture(); media(owner,id,"active")
  let action = CXSetHeldCallAction(call:id,onHold:true); owner.provider(CXProvider.last,perform:action)
  _ = owner.claimHold(callId:id.uuidString,actionId:action.uuid.uuidString)
  let replacement = Call(id,leg:old.telnyxLegId!); replacement.callState = .ACTIVE; TxClient.last.registry[id] = replacement
  owner.onCallStateUpdated(callState:.ACTIVE,callId:id)
  settle(owner,id,action,"confirmed","held")
  check("ATTACH cannot fulfill old peer held action", action.fulfills == 0 && action.failures == 1)
  check("ATTACH current peer receives privacy gate", replacement.isMuted)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"unavailable",0,false)
  check("unsupported internal hold leaves ordinary microphone usable", !call.isMuted && CXProvider.last.updates[id]?.supportsHolding == false)
  media(owner,id,"active",1)
  let hold=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:hold)
  _=owner.claimHold(callId:id.uuidString,actionId:hold.uuid.uuidString)
  media(owner,id,"unavailable",1,false)
  check("unavailable after dispatched hold preserves privacy",call.isMuted)
  settle(owner,id,hold,"rejected","active",2)
  check("definite rejection restores active microphone and fails action",!call.isMuted && hold.failures == 1 && heldRows(owner).isEmpty)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  let hold=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:hold)
  _=owner.claimHold(callId:id.uuidString,actionId:hold.uuid.uuidString)
  owner.onSocketDisconnected()
  check("socket loss promptly fails live hold but retains UUID",hold.failures == 1 && heldRows(owner).first?["actionId"] as? String == hold.uuid.uuidString && call.isMuted)
  check("socket loss disables new CallKit hold capability",CXProvider.last.updates[id]?.supportsHolding == false)
  owner.onClientReady();settle(owner,id,hold,"confirmed","held")
  check("receipt after disconnected action never fulfills old action",hold.fulfills == 0 && call.isMuted)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  var events=[[String:Any]]();owner.listen(owner:UUID()){events.append($0)}
  let hold=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:hold)
  Timer.fire(12)
  check("bounded local unclaimed timeout fails before Apple deadline",hold.failures == 1 && hold.fulfills == 0 && !call.isMuted)
  check("unclaimed timeout clears JS requesting with exact cancellation",events.contains{$0["type"] as? String == "heldCancelled" && $0["actionId"] as? String == hold.uuid.uuidString})
  check("unclaimed local timeout never ends call",call.hangs == 0 && heldRows(owner).isEmpty)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  let hold=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:hold)
  _=owner.claimHold(callId:id.uuidString,actionId:hold.uuid.uuidString)
  Timer.fire(12)
  check("bounded claimed timeout retains immutable uncertainty",hold.failures == 1 && heldRows(owner).first?["phase"] as? String == "uncertain" && call.isMuted)
  settle(owner,id,hold,"confirmed","active",3)
  check("historical accepted hold does not claim current held media",hold.fulfills == 0 && !call.isMuted && heldRows(owner).isEmpty)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  var events=[[String:Any]]();owner.listen(owner:UUID()){events.append($0)}
  CXCallController.requestError=NSError(domain:"controlled-denial",code:1)
  try! owner.requestHold(callId:id.uuidString,held:true);drain()
  check("CallKit transaction rejection emits cancellation without media command",events.contains{$0["type"] as? String == "heldCancelled"} && heldRows(owner).isEmpty && !call.isMuted)
  CXCallController.requestError=nil
  try! owner.requestHold(callId:id.uuidString,held:true);Timer.fire(12)
  check("accepted transaction with no delegate delivery has bounded cancellation",events.filter{$0["type"] as? String == "heldCancelled"}.count == 2 && heldRows(owner).isEmpty)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  var events=[[String:Any]]();owner.listen(owner:UUID()){events.append($0)}
  media(owner,id,"held",2)
  let old=CXCallController.transactions.last!.action as! CXSetHeldCallAction
  media(owner,id,"active",3)
  owner.provider(CXProvider.last,perform:old)
  check("stale mirror callback never becomes new provider command",old.fulfills == 0 && heldRows(owner).isEmpty && !events.contains{$0["type"] as? String == "heldRequested"})
  check("new active media ignores older held revision",!call.isMuted)
  media(owner,id,"held",2)
  check("older media cannot re-enable hold privacy",!call.isMuted)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  media(owner,id,"held",2)
  let hold=CXCallController.transactions.last!.action as! CXSetHeldCallAction;owner.provider(CXProvider.last,perform:hold)
  let userUnmute=CXSetMutedCallAction(call:id,muted:false);owner.provider(CXProvider.last,perform:userUnmute)
  check("CallKit unmute cannot bypass held privacy or alter user preference",call.isMuted && (owner.snapshot()["calls"] as? [[String:Any]])?.first?["muted"] as? Bool == false)
  CXCallController.requestError=NSError(domain:"controlled-mirror-denial",code:1)
  media(owner,id,"active",3);drain()
  check("resume mirror failure preserves held microphone barrier",call.isMuted)
  CXCallController.requestError=nil;media(owner,id,"active",3)
  let retry=CXCallController.transactions.last!.action as! CXSetHeldCallAction;owner.provider(CXProvider.last,perform:retry)
  check("same-version fresh mirror retry releases only after CallKit success",retry.fulfills == 1 && !call.isMuted)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  let hold=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:hold)
  _=owner.claimHold(callId:id.uuidString,actionId:hold.uuid.uuidString)
  var rejected=0
  for (sid,control,action) in [(UUID().uuidString,"fixture-control",hold.uuid.uuidString),(session,"foreign",hold.uuid.uuidString),(session,"fixture-control",UUID().uuidString)] {
    do {try owner.resolveHold(callId:id.uuidString,sessionId:sid,controlId:control,actionId:action,outcome:"confirmed",state:"active",version:2,canHold:true)} catch {rejected += 1}
  }
  check("foreign session control or command cannot release privacy",rejected == 3 && call.isMuted && !hold.isComplete)
  owner.disconnect()
  check("disconnect promptly fails hold and removes ledger",hold.failures == 1 && heldRows(owner).isEmpty)
  do {try owner.resolveHold(callId:id.uuidString,sessionId:session,controlId:"fixture-control",actionId:hold.uuid.uuidString,outcome:"confirmed",state:"held",version:2,canHold:true)} catch {}
  check("late disconnected receipt cannot fulfill action",hold.fulfills == 0)
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  try! owner.requestHold(callId:id.uuidString,held:true)
  let requested=CXCallController.transactions.last!.action as! CXSetHeldCallAction
  let competing=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:competing)
  owner.provider(CXProvider.last,perform:requested)
  _=owner.claimHold(callId:id.uuidString,actionId:requested.uuid.uuidString)
  Timer.fire(12)
  check("competing system action cannot steal queued request or timeout",competing.failures == 1 && requested.failures == 1 && heldRows(owner).first?["phase"] as? String == "uncertain")
  var blocked=false;do {try owner.dtmf(digits:"1")} catch {blocked=true}
  check("native DTMF cannot bypass uncertain hold privacy",blocked && call.tones == 0)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  var events=[[String:Any]]();owner.listen(owner:UUID()){events.append($0)}
  media(owner,id,"held",2)
  let action=CXCallController.transactions.last!.action as! CXSetHeldCallAction
  let pending=(owner.snapshot()["pendingSyncs"] as? [[String:Any]])?.first
  check("mirror pending snapshot preserves exact private reconciliation identity",pending?["actionId"] as? String == action.uuid.uuidString && pending?["sessionId"] as? String == session && pending?["callControlId"] as? String == "fixture-control" && pending?["expectedVersion"] as? Int == 2)
  events=[];media(owner,id,"held",2)
  check("lost mirror event recovers from repeated same-version sync",events.count == 1 && events.first?["type"] as? String == "holdSyncPending" && events.first?["actionId"] as? String == action.uuid.uuidString)
  check("pending mirror never claims native synchronization early",!events.contains{$0["type"] as? String == "holdSynced"} && call.isMuted)
  owner.provider(CXProvider.last,perform:action)
  check("only fulfilled exact mirror emits holdSynced",events.last?["type"] as? String == "holdSynced" && events.last?["actionId"] as? String == action.uuid.uuidString && action.fulfills == 1 && (owner.snapshot()["pendingSyncs"] as? [[String:Any]])?.isEmpty == true)
  check("lost completion event recoverable through exact native held snapshot",(owner.snapshot()["calls"] as? [[String:Any]])?.first?["systemHeld"] as? Bool == true && (owner.snapshot()["calls"] as? [[String:Any]])?.first?["privacyHold"] as? Bool == true)

  media(owner,id,"active",3)
  let resume=CXCallController.transactions.last!.action as! CXSetHeldCallAction
  resume.timeoutDate=Date().addingTimeInterval(-1);owner.provider(CXProvider.last,timedOutPerforming:resume)
  check("mirror timeout failure carries exact identity and keeps privacy",events.last?["type"] as? String == "holdSyncFailed" && events.last?["sessionId"] as? String == session && events.last?["actionId"] as? String == resume.uuid.uuidString && call.isMuted && resume.failures == 0)
  owner.provider(CXProvider.last,perform:resume)
  check("late expired mirror cannot emit success or server command",events.last?["type"] as? String == "holdSyncFailed" && !events.contains{$0["type"] as? String == "heldRequested"})
  owner.disconnect()
}
for viaApp in [false,true] {
  let (owner,id,_)=activeFixture();media(owner,id,"active")
  CXCallController.requestError=NSError(domain:"controlled-mirror-denial",code:1)
  media(owner,id,"held",2);drain();CXCallController.requestError=nil
  check("failed mirror keeps holding capability disabled until CallKit agrees \(viaApp)",CXProvider.last.updates[id]?.supportsHolding == false)
  if viaApp {
    var denied=false;do {try owner.requestHold(callId:id.uuidString,held:false)} catch {denied=true}
    check("app cannot issue opposite provider command across unresolved system mismatch",denied)
  } else {
    let system=CXSetHeldCallAction(call:id,onHold:false);owner.provider(CXProvider.last,perform:system)
    check("system cannot issue opposite provider command across unresolved mismatch",system.failures == 1 && heldRows(owner).isEmpty)
  }
  owner.disconnect()
}
do {
  let owner=phone(),id=UUID()
  let actual=Call(id,leg:UUID());actual.isMuted=true
  TxClient.last.registry[id]=actual;owner.onIncomingCall(call:actual)
  try! owner.authorize(callId:id.uuidString,sessionId:session,controlId:"fixture-control")
  actual.callState = .ACTIVE;owner.onCallStateUpdated(callState:.ACTIVE,callId:id)
  let stayedPrivate=actual.isMuted
  media(owner,id,"active")
  check("unknown ATTACH default mute releases only on first authoritative active media",stayedPrivate && !actual.isMuted)
  owner.disconnect()
}
do {
  let owner=phone(),id=UUID()
  let call=Call(id,leg:UUID());call.isMuted=true
  TxClient.last.registry[id]=call;owner.onIncomingCall(call:call)
  try! owner.authorize(callId:id.uuidString,sessionId:session,controlId:"fixture-control")
  call.callState = .ACTIVE;owner.onCallStateUpdated(callState:.ACTIVE,callId:id)
  media(owner,id,"unavailable",1,false)
  check("unavailable internal media cannot release unknown initial SDK mute",call.isMuted)
  media(owner,id,"active",2,false)
  check("positive internal active media releases initial mute without granting hold",!call.isMuted && CXProvider.last.updates[id]?.supportsHolding == false)
  let action=CXSetHeldCallAction(call:id,onHold:true);owner.provider(CXProvider.last,perform:action)
  check("positive internal audio still rejects system hold",action.failures == 1 && heldRows(owner).isEmpty)
  owner.disconnect()
}
do {
  let (owner,id,call)=activeFixture();media(owner,id,"active")
  media(owner,id,"held",2)
  let mirror=CXCallController.transactions.last!.action as! CXSetHeldCallAction
  owner.provider(CXProvider.last,perform:mirror)
  media(owner,id,"unavailable",3,false)
  check("unavailable media cannot release settled held privacy",call.isMuted && (owner.snapshot()["calls"] as? [[String:Any]])?.first?["privacyHold"] as? Bool == true)
  owner.disconnect()
}
func push(_ owner: LinkaPhone, _ payload: [String: Any], completion: @escaping () -> Void = {}) {
  owner.pushRegistry(PKPushRegistry(queue: .main), didReceiveIncomingPushWith: PKPushPayload(payload), for: .voIP, completion: completion)
}
do {
  let owner = phone(), id = UUID()
  push(owner, ["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture", "telnyx_leg_id": UUID().uuidString]])
  let call = Call(id, leg: UUID()); TxClient.last.registry[id] = call; owner.onIncomingCall(call: call)
  check("a leg named by the push must be the INVITE's", call.hangs == 1 && CXProvider.last.ended[id] == .failed)
  owner.disconnect()
}
let cleanups: [(String, CXCallEndedReason)] = [("Missed call!", .unanswered), ("Answered Elsewhere", .answeredElsewhere)]
for (alert, reason) in cleanups {
  let owner = phone(), id = UUID()
  var events: [[String: Any]] = []; owner.listen(owner: UUID()) { events.append($0) }
  push(owner, ["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture"]])
  var completed = false
  push(owner, ["aps": ["alert": alert], "metadata": ["call_id": id.uuidString]]) { completed = true }
  check("\(alert) push ends its known offer with its reason", CXProvider.last.ended[id] == reason
    && events.contains { $0["type"] as? String == "ended" && $0["callId"] as? String == id.uuidString })
  let placeholder = CXProvider.last.incoming.last!
  check("\(alert) push reports and ends one placeholder for PushKit", completed && CXProvider.last.incoming.count == 2 && placeholder != id && CXProvider.last.ended[placeholder] == reason)
  check("\(alert) push never reports a failed call", !CXProvider.last.ended.values.contains(.failed) && !events.contains { $0["type"] as? String == "pushRejected" })
  owner.disconnect()
}
do {
  let owner = phone(); var completed = false
  push(owner, ["aps": ["alert": "Missed call!"], "metadata": ["call_id": UUID().uuidString]]) { completed = true }
  check("missed-call push for an unknown call only satisfies PushKit", completed && CXProvider.last.incoming.count == 1 && CXProvider.last.ended.count == 1 && !CXProvider.last.ended.values.contains(.failed))
  owner.disconnect()
}
do {
  let (owner, id, call) = activeFixture()
  push(owner, ["aps": ["alert": "Answered Elsewhere"], "metadata": ["call_id": id.uuidString]])
  check("late answered-elsewhere push never ends an established call", call.hangs == 0 && CXProvider.last.ended[id] == nil && (owner.snapshot()["calls"] as? [[String: Any]])?.count == 1)
  owner.disconnect()
}
do {
  let owner = phone(); var events: [[String: Any]] = []; owner.listen(owner: UUID()) { events.append($0) }
  push(owner, ["aps": ["alert": "Incoming call!"], "metadata": ["call_id": UUID().uuidString, "caller_number": "+421900000999"]])
  let rejected = events.first { $0["type"] as? String == "pushRejected" }
  check("refused push names its reason and key names", rejected?["reason"] as? String == "missing_voice_sdk_id"
    && rejected?["keys"] as? [String] == ["call_id", "caller_number"] && rejected?["payloadKeys"] as? [String] == ["aps", "metadata"] && rejected?["alertKnown"] as? Bool == true)
  check("refused push diagnostics carry no metadata value", rejected != nil && !String(describing: rejected!).contains("+421900000999"))
  check("refused push stays readable for a cold launch", rejected?["id"] != nil && (owner.snapshot()["pushRejection"] as? [String: Any])?["id"] as? String == rejected?["id"] as? String)
  owner.clearPushRejection(id: UUID().uuidString)
  check("another report cannot forget this refusal", (owner.snapshot()["pushRejection"] as? [String: Any])?["id"] as? String == rejected?["id"] as? String)
  owner.clearPushRejection(id: rejected?["id"] as? String ?? "")
  check("a reported refusal is forgotten natively", owner.snapshot()["pushRejection"] is NSNull)
  events = []
  push(owner, ["aps": ["alert": "Call ended elsewhere"], "metadata": ["call_id": UUID().uuidString]])
  push(owner, ["metadata": ["call_id": UUID().uuidString]])
  let refusals = events.filter { $0["type"] as? String == "pushRejected" }
  check("an unrecognised alert text is flagged without its value", refusals.count == 2 && refusals[0]["alertKnown"] as? Bool == false
    && !String(describing: refusals[0]).contains("Call ended elsewhere") && refusals[1]["alertKnown"] == nil)
  owner.disconnect()
}
for viaApp in [false, true] {
  let owner = phone(), id = UUID()
  var events: [[String: Any]] = []; owner.listen(owner: UUID()) { events.append($0) }
  push(owner, ["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture"]])
  try! owner.connect(token: "fresh-push-token")
  let client = TxClient.last!
  if viaApp { owner.reject(callId: id.uuidString) } else {
    let end = CXEndCallAction(call: id); owner.provider(CXProvider.last, perform: end)
    check("declined prepared push completes its CallKit action \(viaApp)", end.fulfills == 1 && end.failures == 0)
  }
  check("decline before the INVITE reaches Telnyx through the SDK \(viaApp)", client.declines == [id])
  let call = Call(id, leg: UUID()); client.registry[id] = call; owner.onIncomingCall(call: call)
  check("an INVITE for a declined call is hung up at once \(viaApp)", call.hangs == 1 && call.answerCount == 0
    && !events.contains { $0["type"] as? String == "incoming" })
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID()
  push(owner, ["metadata": ["call_id": id.uuidString, "voice_sdk_id": "fixture"]])
  owner.onClientReady()
  let sent = CXProvider.last.updateCount
  owner.onClientReady()
  check("an unchanged capability is not repeated while CallKit confirms the call", CXProvider.last.updateCount == sent)
  drain(); owner.onClientReady()
  check("CallKit hears the capability again once it confirmed the incoming call", CXProvider.last.updateCount == sent + 1 && CXProvider.last.updates[id]?.supportsHolding == false)
  owner.disconnect()
}
do {
  let owner = phone(), id = UUID()
  try! owner.expectOutgoing(controlId: "fixture-control", sessionId: session, number: "+421900000123")
  _ = incoming(owner, id)
  owner.onClientReady()
  let sent = CXProvider.last.updateCount
  owner.provider(CXProvider.last, perform: CXStartCallAction(call: id, handle: CXHandle(type: .phoneNumber, value: "+421900000123")))
  check("CallKit hears the capability once it starts the outgoing call", CXProvider.last.updateCount == sent + 1 && CXProvider.last.updates[id]?.supportsHolding == false)
  owner.disconnect()
}
do {
  let (owner, id, _) = activeFixture(); media(owner, id, "active")
  let sent = CXProvider.last.updateCount
  for _ in 0..<5 { media(owner, id, "active") }
  check("unchanged media sends no repeated CallKit update", CXProvider.last.updateCount == sent && CXProvider.last.updates[id]?.supportsHolding == true)
  media(owner, id, "active", 2, false)
  check("a changed hold capability is reported once", CXProvider.last.updateCount == sent + 1 && CXProvider.last.updates[id]?.supportsHolding == false)
  owner.disconnect()
}
let passed = checks.allSatisfy { $0["pass"] as? Bool == true }
let report: [String: Any] = ["kind": "actual-LinkaPhone-methods-controlled-frameworks", "passed": passed, "checks": checks, "physicalDevice": false, "sdkNetworkingExecuted": false]
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
if !passed { exit(1) }
