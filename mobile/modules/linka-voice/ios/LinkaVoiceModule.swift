import ExpoModulesCore
import UIKit
import AVFoundation

public final class LinkaVoiceModule: Module {
  private let listenerOwner = UUID()
  public func definition() -> ModuleDefinition {
    Name("LinkaVoice")
    Events("onVoiceEvent")
    OnCreate {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        LinkaPhone.shared.listen(owner: self.listenerOwner) { [weak self] event in self?.sendEvent("onVoiceEvent", event) }
      }
    }
    OnDestroy {
      let owner = self.listenerOwner
      DispatchQueue.main.async { LinkaPhone.shared.stopListening(owner: owner) }
    }
    Function("isAvailable") { LinkaPhone.enabled }
    AsyncFunction("snapshot") { LinkaPhone.shared.snapshot() }.runOnQueue(.main)
    AsyncFunction("clearPushRejection") { (id: String) in LinkaPhone.shared.clearPushRejection(id: id) }.runOnQueue(.main)
    AsyncFunction("requestMicrophone") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { allowed in promise.resolve(allowed) }
    }.runOnQueue(.main)
    AsyncFunction("connect") { (token: String) in try LinkaPhone.shared.connect(token: token) }.runOnQueue(.main)
    // The reason only names the caller in the device log; older bundles omit it.
    AsyncFunction("disconnect") { (reason: String?) in LinkaPhone.shared.disconnect(reason: reason ?? "js") }.runOnQueue(.main)
    // A JS device-log line; LinkaPhone.diag sanitizes it again and touches no phone state.
    Function("debug") { (event: String, fields: [String: String]) in LinkaPhone.diag("js." + event, fields) }
    AsyncFunction("diagnosticEvents") { LinkaPhone.diagnosticEvents() }
    AsyncFunction("clearDiagnosticEvents") { (upToId: Int) in LinkaPhone.clearDiagnosticEvents(upToId: upToId) }
    AsyncFunction("authorize") { (callId: String, sessionId: String, controlId: String) in try LinkaPhone.shared.authorize(callId: callId, sessionId: sessionId, controlId: controlId) }.runOnQueue(.main)
    AsyncFunction("reject") { (callId: String) in LinkaPhone.shared.reject(callId: callId) }.runOnQueue(.main)
    AsyncFunction("answer") { (callId: String) in try LinkaPhone.shared.answer(callId: callId) }.runOnQueue(.main)
    AsyncFunction("expectOutgoing") { (controlId: String, sessionId: String, number: String, genericHandle: Bool) in
      try LinkaPhone.shared.expectOutgoing(controlId: controlId, sessionId: sessionId, number: number, genericHandle: genericHandle)
    }.runOnQueue(.main)
    AsyncFunction("confirmConnected") { (callId: String) in LinkaPhone.shared.confirmConnected(callId: callId) }.runOnQueue(.main)
    AsyncFunction("requestHold") { (callId: String, held: Bool) in try LinkaPhone.shared.requestHold(callId: callId, held: held) }.runOnQueue(.main)
    AsyncFunction("claimHold") { (callId: String, actionId: String) in LinkaPhone.shared.claimHold(callId: callId, actionId: actionId) }.runOnQueue(.main)
    AsyncFunction("syncMedia") { (callId: String, sessionId: String, controlId: String, state: String, version: Int, canHold: Bool) in
      try LinkaPhone.shared.syncMedia(callId: callId, sessionId: sessionId, controlId: controlId, state: state, version: version, canHold: canHold)
    }.runOnQueue(.main)
    AsyncFunction("resolveHold") { (callId: String, sessionId: String, controlId: String, actionId: String, outcome: String, state: String, version: Int, canHold: Bool) in
      try LinkaPhone.shared.resolveHold(callId: callId, sessionId: sessionId, controlId: controlId, actionId: actionId, outcome: outcome, state: state, version: version, canHold: canHold)
    }.runOnQueue(.main)
    AsyncFunction("end") { LinkaPhone.shared.end() }.runOnQueue(.main)
    AsyncFunction("mute") { (muted: Bool) in try LinkaPhone.shared.mute(muted: muted) }.runOnQueue(.main)
    AsyncFunction("speaker") { (enabled: Bool) in LinkaPhone.shared.speaker(enabled: enabled) }.runOnQueue(.main)
    AsyncFunction("dtmf") { (digits: String) in try LinkaPhone.shared.dtmf(digits: digits) }.runOnQueue(.main)
  }
}

/** Construct PushKit/CallKit during native launch, before the JS bridge exists. */
public final class LinkaVoiceAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if LinkaPhone.enabled { LinkaPhone.shared.start() }
    return true
  }
}
