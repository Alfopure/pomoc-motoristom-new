#!/usr/bin/env python3
"""Emit the actual LinkaPhone body against controlled SDK/framework adapters.
Only imports and the explicit TEST bundle gate are adapted. This tests app
lifecycle logic, not Telnyx signaling, CallKit, APNs, audio or native linkage.
Execute the emitted file with Swift 5 language mode on a Foundation toolchain.
"""
import argparse
import hashlib
import pathlib
import re

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=pathlib.Path, default=pathlib.Path('mobile/modules/linka-voice/ios/LinkaPhone.swift'))
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
source = args.source.read_text()
for signature in ['func answerWhenAuthorized(', '  func onCallStateUpdated(callState: CallState, callId: UUID) {\n    guard Thread.isMainThread', 'func snapshot()', 'func disconnect()', 'func provider(_ provider: CXProvider, perform action: CXStartCallAction)']:
    if source.count(signature) != 1:
        raise SystemExit('Required unique source method missing: ' + signature)
source = re.sub(r'^import (AVFoundation|CallKit|PushKit|TelnyxRTC|UIKit)\n', '', source, flags=re.M)
gate = '''  static var enabled: Bool {
    Bundle.main.bundleIdentifier == "sk.linkapomoci.dispecing.test"
      && Bundle.main.object(forInfoDictionaryKey: "LinkaNativeVoiceEnabled") as? Bool == true
  }'''
if source.count(gate) != 1:
    raise SystemExit('Explicit test bundle gate changed; review adapter')
source = source.replace(gate, '  static var enabled: Bool { true }')
folder = pathlib.Path(__file__).parent
header = '// Actual LinkaPhone source SHA256: ' + hashlib.sha256(args.source.read_bytes()).hexdigest() + '\n'
args.output.write_text(header + (folder / 'native-phone-stubs.swift').read_text() + '\n' + source + '\n' + (folder / 'native-phone-scenarios.swift').read_text())
