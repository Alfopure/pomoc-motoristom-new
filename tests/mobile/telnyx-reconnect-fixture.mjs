#!/usr/bin/env node
// Executes actual pinned vendor methods with controlled socket adapters in Swift.
// No provider network, microphone, APNs or CallKit is exercised.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [sourceFile, outputFile] = process.argv.slice(2);
if (!sourceFile || !outputFile) throw new Error("Usage: node telnyx-reconnect-fixture.mjs SDK-source.swift output.swift");
const source = readFileSync(sourceFile, "utf8");
function between(start, end) {
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("Vendor method boundary changed");
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const guardFields = source.includes("// LINKA lifecycle guard start")
  ? between("    // LINKA lifecycle guard start", "    // LINKA lifecycle guard end") : "";
const methods = [
  between("    public func connect(txConfig: TxConfig,", "    private func connectFromPush(txConfig: TxConfig,"),
  between("    public func disconnect() {", "    private var isCallsActive: Bool {"),
  between("    func onSocketDisconnected(reconnect: Bool, region: Region?) {", "    func onSocketError(error: Error) {"),
  between("    private func connectSocketOnly(serverConfiguration: TxServerConfiguration) throws {", "    private func performLogin(declinePush: Bool = false) {"),
  between("    public func processVoIPNotification(txConfig: TxConfig,", "    fileprivate func sendAttachCall() {"),
].join("\n");
const stubs = `import Foundation
public struct TxConfig { var token: String; public func validateParams() throws {}
 var debug = false; var forceRelayCandidate = false; var sendWebRTCStatsViaSocket = false; var useTrickleIce = false
 var enableMissedCallNotifications = false; var enableCallReports = false; var callReportInterval = 5.0
 var callReportLogLevel = "none"; var callReportMaxLogEntries = 0; var pushWhenActive = false; var pushNotificationConfig: PushConfig?
}
struct PushConfig { var pushDeviceToken: String? }
public enum Region { case auto }
public struct TxServerConfiguration {
 var signalingServer: URL; var webRTCIceServers: [String]; var environment: String; var pushMetaData: [String: Any]?; var region: Region
 public init(signalingServer: URL? = nil, webRTCIceServers: [String] = [], environment: String = "test", pushMetaData: [String: Any]? = nil, region: Region = .auto) {
  self.signalingServer = signalingServer ?? URL(string: "wss://controlled.invalid")!; self.webRTCIceServers = webRTCIceServers; self.environment = environment; self.pushMetaData = pushMetaData; self.region = region
 }
}
struct Logger { static let log = Logger(); func i(message: String) {}; func e(message: String) {} }
class Socket { static var connections = 0; weak var delegate: AnyObject?; func connect(signalingServer: URL) { Self.connections += 1 }; func disconnect(reconnect: Bool) {} }
struct FileLogger { static var isCallFromPush = false }
enum TxError: Error { case clientConfigurationFailed(reason: Reason); enum Reason { case voiceSdkIsRequired } }
enum CallState { case NEW; var isConsideredActive: Bool { false } }
class Call {
 var callState: CallState = .NEW
 func hangup() {}
 init(callId: UUID, remoteSdp: String, sessionId: String, socket: Socket, delegate: AnyObject, iceServers: [String], debug: Bool, forceRelayCandidate: Bool, sendWebRTCStatsViaSocket: Bool, useTrickleIce: Bool, enableMissedCallNotifications: Bool, enableCallReports: Bool, callReportInterval: Double, callReportLogLevel: String, callReportMaxLogEntries: Int, pushWhenActive: Bool, pushDeviceToken: String?) {}
}
class Assistant { func setSocket(_ socket: Socket?) {}; func clearAllData() {} }
class Delegate { func onSocketDisconnected() {} }
enum GatewayStates { case NOREG }
class TxClient {
 static let MAX_REGISTER_RETRY = 3; static let RECONNECT_BUFFER = 0.01
 var registerRetryCount = 0; var gatewayState: GatewayStates = .NOREG
 var txConfig: TxConfig?; var storedTxConfig: TxConfig?; var serverConfiguration = TxServerConfiguration()
 var socket: Socket?; var calls = [UUID: Call](); var socketToAppCallId = [String: String]()
 var aiAssistantManager = Assistant(); var delegate: Delegate?; var sessionId: String?
 var pendingCallDecline = false; var isReconnectPendingForCallKitDecline = false
 var pushMetaData = [String: Any](); var voiceSdkId: String?; var storedServerConfiguration: TxServerConfiguration?; var isCallFromPush = false
 enum PushCallState { case idle }; var pushCallState: PushCallState = .idle; var currentCallId = UUID()
 func isConnected() -> Bool { false }
 func clearActiveCall() {}; func stopReconnectTimeout() {}; func stopInviteTimeout() {}
 func cleanupPendingCallKitDecline(reason: String) {}; func serverConfigurationForConnection(_ config: TxServerConfiguration) -> TxServerConfiguration { config }
`;
const scenarios = `
var checks = [[String: Any]]()
func check(_ name: String, _ pass: Bool) { checks.append(["name": name, "pass": pass]) }
func pump() { RunLoop.main.run(until: Date().addingTimeInterval(0.06)) }
func connected(_ token: String = "old") -> TxClient { let client = TxClient(); try! client.connect(txConfig: TxConfig(token: token)); return client }
do {
 let client = connected(); let before = Socket.connections
 client.storedTxConfig = TxConfig(token: "push-old")
 client.onSocketDisconnected(reconnect: true, region: nil); client.disconnect(); pump()
 check("queued reconnect cannot resurrect logout", Socket.connections == before)
 check("logout erases stored credential configurations", client.txConfig == nil && client.storedTxConfig == nil)
}
do {
 let client = connected(); client.onSocketDisconnected(reconnect: true, region: nil)
 try! client.connect(txConfig: TxConfig(token: "new-account")); let before = Socket.connections; pump()
 check("new explicit login fences old reconnect", Socket.connections == before && client.txConfig?.token == "new-account")
}
do {
 let client = connected(); let before = Socket.connections
 client.onSocketDisconnected(reconnect: true, region: nil); pump()
 check("current connection still recovers", Socket.connections == before + 1 && client.txConfig?.token == "old")
}
do {
 let client = connected(); let before = Socket.connections
 client.onSocketDisconnected(reconnect: true, region: nil); client.onSocketDisconnected(reconnect: true, region: nil); pump()
 check("duplicate callbacks create one reconnect", Socket.connections == before + 1)
}
do {
 weak var retired: TxClient?
 do { let client = connected(); retired = client; client.onSocketDisconnected(reconnect: true, region: nil) }
 check("queued work does not retain retired client", retired == nil); pump()
}
do {
 let client = connected(); client.onSocketDisconnected(reconnect: true, region: nil); client.disconnect()
 try! client.connect(txConfig: TxConfig(token: "fresh")); let before = Socket.connections; pump()
 check("fresh login after logout survives stale timer", Socket.connections == before && client.txConfig?.token == "fresh")
}
do {
 let client = connected(); client.onSocketDisconnected(reconnect: true, region: nil)
 try! client.processVoIPNotification(txConfig: TxConfig(token: "push"), serverConfiguration: TxServerConfiguration(), pushMetaData: ["voice_sdk_id": "exact-push"])
 let before = Socket.connections; pump()
 check("actual PushKit entry fences old reconnect", Socket.connections == before && client.storedTxConfig?.token == "push")
}
do {
 let client = TxClient()
 try! client.processVoIPNotification(txConfig: TxConfig(token: "push"), serverConfiguration: TxServerConfiguration(), pushMetaData: ["voice_sdk_id": "exact-push"])
 client.onSocketDisconnected(reconnect: true, region: nil); let before = Socket.connections; client.disconnect(); pump()
 check("push-origin reconnect cannot survive logout", Socket.connections == before && client.storedTxConfig == nil && client.txConfig == nil)
}
let passed = checks.allSatisfy { $0["pass"] as? Bool == true }
let result: [String: Any] = ["kind": "actual-TelnyxRTC-methods-controlled-socket", "checks": checks, "passed": passed, "providerNetworkingExecuted": false]
print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
exit(passed ? 0 : 1)
`;
writeFileSync(outputFile, "// Vendor source SHA256: " + createHash("sha256").update(source).digest("hex") + "\n" + stubs + guardFields + methods + "\n}\n" + scenarios);
