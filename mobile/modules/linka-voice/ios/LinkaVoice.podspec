Pod::Spec.new do |s|
  s.name = 'LinkaVoice'
  s.version = '0.1.0'
  s.summary = 'Native iPhone dispatch phone'
  s.description = 'CallKit, PushKit and the Telnyx iOS voice SDK for Linka pomoci.'
  s.license = { :type => 'UNLICENSED' }
  s.author = 'Linka pomoci'
  s.homepage = 'https://test.dispecing.linkapomoci.sk'
  s.source = { :git => 'https://github.com/Alfopure/pomoc-motoristom-new.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.dependency 'TelnyxRTC', '4.2.2'
  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
