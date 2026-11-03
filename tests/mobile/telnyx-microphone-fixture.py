#!/usr/bin/env python3
"""Execute extracted pinned Call/Peer bodies with controlled WebRTC tracks.
No real media, network, provider or CallKit. Missing baseline fields are explicit
unsupported adapters; actual method logic is never rewritten.
"""
import argparse,hashlib,pathlib
p=argparse.ArgumentParser();p.add_argument('--client',type=pathlib.Path,required=True);p.add_argument('--call',type=pathlib.Path,required=True);p.add_argument('--peer',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args()
client=a.client.read_text();call=a.call.read_text();peer=a.peer.read_text()
def method(s,start):
 if s.count(start)!=1: raise SystemExit('Non-unique source boundary: '+start)
 i=s.index(start);j=s.index('{',i);depth=1;k=j+1
 while depth:
  if s[k]=='{':depth+=1
  if s[k]=='}':depth-=1
  k+=1
 return s[i:k]
patched='internal final class LinkaMicrophoneIntent' in peer
intent=method(peer,'internal final class LinkaMicrophoneIntent') if patched else 'internal final class LinkaMicrophoneIntent {} // Explicit absent-baseline field adapter.'
# Actual vendor ATTACH inheritance block, with a tiny surrounding argument harness.
inherit=''
if '// LINKA ATTACH microphone intent' in client:
 start=client.index('        // LINKA ATTACH microphone intent');end=client.index('        self.calls[appFacingCallId] = call',start);inherit=client[start:end]
peer_methods='\n'.join(method(peer,x) for x in ['    private func createMediaSenders()', '    private func setTrackEnabled<T:', '    func muteUnmuteAudio(mute:', '    private func performMuteUnmuteSequence('])
call_methods='\n'.join(method(call,x) for x in ['    public func muteAudio()', '    public func unmuteAudio()', '    internal func acceptReAttach('])
setup='''import Foundation
class RTCMediaStreamTrack { var history = [Bool](); var onEnabled: ((Bool)->Void)?; var isEnabled = true { didSet { history.append(isEnabled); onEnabled?(isEnabled) } } }
class RTCAudioTrack: RTCMediaStreamTrack {}
class Sender { var track: RTCMediaStreamTrack?; init(_ track:RTCMediaStreamTrack){self.track=track} }
class Transceiver { var sender:Sender; init(_ track:RTCMediaStreamTrack){sender=Sender(track)} }
enum Semantics { case planB, unifiedPlan }
class Configuration { var sdpSemantics = Semantics.unifiedPlan }
class Connection { var configuration=Configuration(); var transceivers=[Transceiver](); var senders=[Sender](); func add(_ track:RTCMediaStreamTrack,streamIds:[String]) { transceivers.append(Transceiver(track));senders.append(Sender(track)) } }
class Stream { func addAudioTrack(_ track:RTCAudioTrack) {} }
class Factory { func mediaStream(withStreamId:String)->Stream {Stream()} }
class Logger { static let log=Logger();func i(message:String){};func e(message:String){} }
struct CallInfo { let callId:UUID }
struct Reporter { var reportId:UUID?;func dispose(){} }
'''
peer_class='''class Peer {
 static let factory=Factory();var connection:Connection?=Connection(); var _localStream:Stream?;var localAudioTrack:RTCAudioTrack?
 var delegate:Call?;var socket:String?;var sessionId:String?;var callId:String?
 private let linkaMicrophoneIntent:LinkaMicrophoneIntent
 init(iceServers:[String],isAttach:Bool=false,forceRelayCandidate:Bool=false,useTrickleIce:Bool=false,isAnswering:Bool=false,linkaMicrophoneIntent:LinkaMicrophoneIntent=LinkaMicrophoneIntent()) {
  self.linkaMicrophoneIntent=linkaMicrophoneIntent;createMediaSenders()
 }
 static var onCreatedTrack: ((RTCAudioTrack)->Void)?
 func createAudioTrack()->RTCAudioTrack { let track=RTCAudioTrack();Peer.onCreatedTrack?(track);return track }
 func dispose(){};func answer(callLegId:String,completion:(String?,Error?)->Void){ completion("controlled-sdp",nil) }
 func resetAVAudioSessionBuffers(preserveSpeakerState:Bool,wasSpeakerActive:Bool){}
 func runRecovery(_ step:Int=1) { let tracks=connection!.transceivers.compactMap{$0.sender.track as? RTCAudioTrack}; performMuteUnmuteSequence(audioTracks:tracks,originalStates:tracks.map{$0.isEnabled},step:step) }
 func recoveryPulse() {setTrackEnabled(RTCAudioTrack.self,isEnabled:true)}
'''+peer_methods+'\n}\n'
call_class='''class Call {
 var linkaMicrophoneIntent=LinkaMicrophoneIntent()
 var peer:Peer?; var remoteSdp:String?="controlled-offer";var statsReporter:Reporter?;var enableQualityMetrics=false;var answerCustomHeaders=[String:String]()
 var useTrickleIce=false;var iceServers=[String]();var forceRelayCandidate=false;var socket:String?;var sessionId:String?;var signalingCallId=UUID();var telnyxLegId:UUID?;var callInfo:CallInfo?
 init(_ id:UUID,_ leg:UUID){ callInfo=CallInfo(callId:id);telnyxLegId=leg }
 func configureStatsReporter(reportID:UUID?){};func startStatsReporter(){};func setupPeerEventLogging(){};func incomingOffer(sdp:String){}
'''+call_methods+'\n}\n'
client_class='''class Client { var calls=[UUID:Call]()
 func attach(_ appFacingCallId:UUID,_ call:Call) { let isAttach=true; _ = isAttach
'''+inherit+'''
  self.calls[appFacingCallId]=call
  call.acceptReAttach(peer:nil)
 }
}
'''
scenarios='''var checks=[[String:Any]]()
func check(_ name:String,_ pass:Bool){checks.append(["name":name,"pass":pass])}
func pump(){RunLoop.main.run(until:Date().addingTimeInterval(0.7))}
func track(_ call:Call)->RTCAudioTrack {call.peer!.localAudioTrack!}
let client=Client(),id=UUID(),leg=UUID()
let old=Call(id,leg);old.muteAudio();client.calls[id]=old
let attached=Call(id,leg);client.attach(id,attached)
check("actual ATTACH inherits muted intent before track attachment",!track(attached).isEnabled && !track(attached).history.contains(true))
old.unmuteAudio();check("old/new ATTACH peer shares live unmute intent",track(attached).isEnabled)
old.muteAudio();check("late old-peer mute immediately gates new track",!track(attached).isEnabled)
track(attached).history=[];attached.peer!.recoveryPulse();attached.peer!.runRecovery();pump()
check("actual recovery sequence never enables muted track",!track(attached).history.contains(true))
attached.unmuteAudio();attached.peer!.runRecovery();attached.muteAudio();track(attached).history=[];pump()
check("mute during recovery beats stale saved unmuted state",!track(attached).isEnabled && !track(attached).history.contains(true))
attached.peer!.runRecovery();attached.unmuteAudio();pump()
check("explicit unmute during recovery is not undone by stale saved mute",track(attached).isEnabled)
for foreign in [true,false] {
 let target=foreign ? id : UUID(); let next=Call(target,UUID());client.attach(target,next)
 check("unverified ATTACH defaults muted \\(foreign)",!track(next).isEnabled && !track(next).history.contains(true))
}
let initial=Call(UUID(),UUID());initial.muteAudio();initial.acceptReAttach(peer:nil)
check("actual Call mute before Peer survives creation",!track(initial).isEnabled)
let ordinary=Call(UUID(),UUID());ordinary.acceptReAttach(peer:nil)
check("ordinary nonprivate Peer remains audio enabled",track(ordinary).isEnabled)
let wrongId=Call(UUID(),leg);wrongId.acceptReAttach(peer:nil);client.calls[id]=wrongId
let sameLegWrongIdentity=Call(id,leg);client.attach(id,sameLegWrongIdentity)
check("same leg with foreign previous app identity defaults muted",!track(sameLegWrongIdentity).isEnabled)
let liveOld=Call(UUID(),UUID());liveOld.acceptReAttach(peer:nil);liveOld.muteAudio()
let liveId=liveOld.callInfo!.callId;client.calls[liveId]=liveOld
let liveNew=Call(liveId,liveOld.telnyxLegId!);client.attach(liveId,liveNew)
liveNew.unmuteAudio();liveOld.muteAudio()
check("both retained live peers obey shared latest mute",!track(liveOld).isEnabled && !track(liveNew).isEnabled)
liveNew.peer!.connection!.configuration.sdpSemantics = .planB
liveNew.unmuteAudio();liveNew.muteAudio()
check("Plan B sender respects effective mute intent",!track(liveNew).isEnabled)
liveNew.peer!.runRecovery(4)
check("recovery final restore cannot overwrite current mute",!track(liveNew).isEnabled)
let interleaved=Call(UUID(),UUID());interleaved.acceptReAttach(peer:nil);interleaved.muteAudio()
track(interleaved).onEnabled = { enabled in
 if enabled { track(interleaved).onEnabled=nil;interleaved.muteAudio() }
}
interleaved.unmuteAudio()
check("newer mute during older unmute cannot be overwritten by a second intent write",!track(interleaved).isEnabled)
track(liveOld).onEnabled = { enabled in
 if enabled { track(liveOld).onEnabled=nil;liveOld.muteAudio() }
}
liveNew.unmuteAudio()
check("newer recursive mute applies to every retained peer in older unmute loop",!track(liveOld).isEnabled && !track(liveNew).isEnabled)
let registering=Call(UUID(),UUID())
Peer.onCreatedTrack = { track in
 track.onEnabled = { enabled in
  if enabled { track.onEnabled=nil;registering.muteAudio() }
 }
}
registering.acceptReAttach(peer:nil);Peer.onCreatedTrack=nil
check("recursive mute during first registration includes the new track",!track(registering).isEnabled)
let passed=checks.allSatisfy{$0["pass"] as? Bool == true}
print(String(data:try! JSONSerialization.data(withJSONObject:["checks":checks,"passed":passed,"physicalAudio":false,"sourceMethodsExecuted":true],options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
if !passed {exit(1)}
'''
header='// Actual vendor source hashes: '+str({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in [a.client,a.call,a.peer]})+'\n'
a.output.write_text(header+setup+intent+'\n'+peer_class+call_class+client_class+scenarios)
