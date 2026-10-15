// Controlled framework boundary; no networking, device permissions or audio.
import Foundation
// Deterministic native timer adapter: actual callback bodies are unchanged.
class Timer {
  static var scheduled: [Timer] = []; let interval: TimeInterval; let callback: (Timer) -> Void; var valid = true
  init(_ interval: TimeInterval, callback: @escaping (Timer) -> Void) { self.interval = interval; self.callback = callback }
  static func scheduledTimer(withTimeInterval interval: TimeInterval, repeats: Bool, block: @escaping (Timer) -> Void) -> Timer { let timer = Timer(interval, callback: block); scheduled.append(timer); return timer }
  func invalidate() { valid = false }
  static func fire(_ interval: TimeInterval) { let timers = scheduled.filter { $0.valid && $0.interval == interval }; for timer in timers { timer.valid = false; timer.callback(timer) } }
}
enum AVAuthorizationStatus { case authorized, denied, restricted, notDetermined }
enum AVMediaType: Equatable { case audio, video }
class AVCaptureDevice {
  static var status = AVAuthorizationStatus.notDetermined
  static var reads: [AVMediaType] = []
  static var requests = 0
  static func authorizationStatus(for mediaType: AVMediaType) -> AVAuthorizationStatus { reads.append(mediaType); return status }
  static func requestAccess(for mediaType: AVMediaType, completionHandler: (Bool) -> Void) { requests += 1; completionHandler(status == .authorized) }
}
class AVAudioSession {
  static var requests = 0
  static func sharedInstance() -> AVAudioSession { AVAudioSession() }
  func requestRecordPermission(_ response: (Bool) -> Void) { Self.requests += 1; response(false) }
}
protocol PKPushRegistryDelegate: AnyObject {}
struct PKPushType: Hashable { static let voIP = PKPushType() }
class PKPushRegistry { weak var delegate: PKPushRegistryDelegate?; var desiredPushTypes: Set<PKPushType>?; init(queue: DispatchQueue) {} }
class PKPushCredentials { var token = Data() }
class PKPushPayload { var dictionaryPayload: [String: Any]; init(_ data: [String: Any]) { dictionaryPayload = data } }
protocol CXProviderDelegate: AnyObject {}
class CXHandle { enum HandleType: Hashable { case phoneNumber, generic }; init(type: HandleType, value: String) {} }
class CXProviderConfiguration { var supportsVideo = false; var supportedHandleTypes: Set<CXHandle.HandleType> = []; var maximumCallGroups = 1; var maximumCallsPerCallGroup = 1 }
enum CXCallEndedReason { case failed, remoteEnded }
class CXCallUpdate { var remoteHandle: CXHandle?; var localizedCallerName: String?; var hasVideo = false; var supportsHolding = false; var supportsGrouping = false; var supportsUngrouping = false }
class CXAction { var isComplete = false; var fulfills = 0; var failures = 0; func fulfill() { fulfills += 1; isComplete = true }; func fail() { failures += 1; isComplete = true } }
class CXCallAction: CXAction { let callUUID: UUID; init(call: UUID) { callUUID = call } }
class CXAnswerCallAction: CXCallAction {}
class CXEndCallAction: CXCallAction {}
class CXStartCallAction: CXCallAction { init(call: UUID, handle: CXHandle) { super.init(call: call) } }
class CXSetMutedCallAction: CXCallAction { let isMuted: Bool; init(call: UUID, muted: Bool) { isMuted = muted; super.init(call: call) } }
class CXTransaction { let action: CXAction; init(action: CXAction) { self.action = action } }
class CXCallController { func request(_ transaction: CXTransaction, completion: @escaping (Error?) -> Void) { completion(nil) } }
class CXProvider { static var last: CXProvider!; init(configuration: CXProviderConfiguration) { Self.last = self }; func setDelegate(_ delegate: CXProviderDelegate, queue: DispatchQueue) {}; func reportNewIncomingCall(with: UUID, update: CXCallUpdate, completion: @escaping (Error?) -> Void) { completion(nil) }; func reportCall(with: UUID, endedAt: Date, reason: CXCallEndedReason) {}; func reportOutgoingCall(with: UUID, startedConnectingAt: Date) {}; func reportOutgoingCall(with: UUID, connectedAt: Date) {} }
struct CallTerminationReason: Equatable {}
enum CallState: Equatable { case NEW, CONNECTING, RINGING, ACTIVE, HELD; case DONE(reason: CallTerminationReason? = nil), RECONNECTING(reason: Reason), DROPPED(reason: Reason); enum Reason { case networkSwitch, networkLost } }
struct CallInfo { let callId: UUID; var callerNumber: String? = "fixture"; var callerName: String? = "fixture" }
class Call {
  var callInfo: CallInfo?; var telnyxLegId: UUID?; var telnyxCallControlId: String?; var callState = CallState.RINGING
  var answerCount = 0, hangs = 0, mutes = 0, tones = 0; var answerCompletion: ((Bool) -> Void)?
  init(_ id: UUID, leg: UUID) { callInfo = CallInfo(callId: id); telnyxLegId = leg }
  func answer(completion: @escaping (Bool) -> Void) { answerCount += 1; answerCompletion = completion }
  func completeAnswer(_ success: Bool) { if success { callState = .ACTIVE }; answerCompletion?(success) }
  func hangup() { hangs += 1; callState = .DONE() }
  func muteAudio() { mutes += 1 }; func unmuteAudio() { mutes -= 1 }; func dtmf(dtmf: String) { tones += 1 }
}
struct TxConfig { enum PushEnvironment { case production }; enum LogLevel { case none }; let reconnectClient: Bool; init(token: String, pushDeviceToken: String?, pushEnvironment: PushEnvironment, logLevel: LogLevel, reconnectClient: Bool, debug: Bool, enableCallReports: Bool) { self.reconnectClient = reconnectClient } }
struct TxServerConfiguration {}
protocol TxClientDelegate: AnyObject { func onClientReady(); func onSocketConnected(); func onSocketDisconnected(); func onClientError(error: Error); func onPushDisabled(success: Bool, message: String); func onSessionUpdated(sessionId: String); func onIncomingCall(call: Call); func onPushCall(call: Call); func onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?); func onCallStateUpdated(callState: CallState, callId: UUID) }
class TxClient {
  static var last: TxClient!; weak var delegate: TxClientDelegate?; var registry: [UUID: Call] = [:]; var config: TxConfig?
  init() { Self.last = self }
  func connect(txConfig: TxConfig) throws { config = txConfig }
  func processVoIPNotification(txConfig: TxConfig, serverConfiguration: TxServerConfiguration, pushMetaData: [String: Any]) throws { config = txConfig }
  func getCall(callId: UUID) -> Call? { registry[callId] }
  func disconnect() {}; func disablePushNotifications() {}; func endCallFromCallkit(endAction: CXEndCallAction) { endAction.fulfill() }
  func setSpeaker() {}; func setEarpiece() {}; func enableAudioSession(audioSession: AVAudioSession) {}; func disableAudioSession(audioSession: AVAudioSession) {}
}
