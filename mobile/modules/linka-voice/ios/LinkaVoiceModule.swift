import ExpoModulesCore
import UIKit
import AVFoundation

public final class LinkaVoiceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkaVoice")
    Events("onVoiceEvent")
    OnCreate {
      DispatchQueue.main.async {
        LinkaPhone.shared.listener = { [weak self] event in self?.sendEvent("onVoiceEvent", event) }
      }
    }
    OnDestroy {
      DispatchQueue.main.async { LinkaPhone.shared.listener = nil }
    }
    Function("isAvailable") { LinkaPhone.enabled }
    AsyncFunction("snapshot") { LinkaPhone.shared.snapshot() }.runOnQueue(.main)
    AsyncFunction("requestMicrophone") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { allowed in promise.resolve(allowed) }
    }.runOnQueue(.main)
    AsyncFunction("connect") { (token: String) in try LinkaPhone.shared.connect(token: token) }.runOnQueue(.main)
    AsyncFunction("disconnect") { LinkaPhone.shared.disconnect() }.runOnQueue(.main)
    AsyncFunction("authorize") { (callId: String, sessionId: String) in try LinkaPhone.shared.authorize(callId: callId, sessionId: sessionId) }.runOnQueue(.main)
    AsyncFunction("reject") { (callId: String) in LinkaPhone.shared.reject(callId: callId) }.runOnQueue(.main)
    AsyncFunction("answer") { (callId: String) in try LinkaPhone.shared.answer(callId: callId) }.runOnQueue(.main)
    AsyncFunction("expectOutgoing") { (controlId: String, sessionId: String, number: String) in
      try LinkaPhone.shared.expectOutgoing(controlId: controlId, sessionId: sessionId, number: number)
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
