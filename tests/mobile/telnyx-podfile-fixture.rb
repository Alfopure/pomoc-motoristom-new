# Executes the generated Podfile hook with controlled CocoaPods objects.
# The process invocation is recorded, not executed; no provider or real pods.
require 'json'
require 'pathname'

podfile = File.expand_path(ARGV.fetch(0))
contents = File.read(podfile)
Spec = Struct.new(:name, :version)
PodTarget = Struct.new(:root_spec)
Sandbox = Struct.new(:root)
Installer = Struct.new(:pod_targets, :sandbox)

def platform(*); end
def target(*); yield; end
def post_install; yield $fixture_installer; end
def react_native_post_install(*); end
def system(*args)
  $fixture_commands << args
  $fixture_child_success
end

checks = []
[
  ['pinned SDK', ['4.2.2'], true, true],
  ['deduplicated SDK targets', ['4.2.2', '4.2.2'], true, true],
  ['missing SDK fails closed', [], false, true],
  ['different SDK fails closed', ['4.2.3'], false, true],
  ['mixed SDK versions fail closed', ['4.2.2', '4.2.3'], false, true],
  ['failed source patch fails build', ['4.2.2'], false, false]
].each do |name, versions, expected_success, child_success|
  $fixture_commands = []
  $fixture_child_success = child_success
  targets = [PodTarget.new(Spec.new('UnrelatedPod', '1.0'))] + versions.map { |v| PodTarget.new(Spec.new('TelnyxRTC', v)) }
  root = Pathname.new('/controlled pods with spaces')
  $fixture_installer = Installer.new(targets, Sandbox.new(root))
  begin
    eval(contents, TOPLEVEL_BINDING, podfile)
    success = true
  rescue StandardError
    success = false
  end
  expected_command = ['node', File.expand_path('../plugins/with-telnyx-reconnect-guard.cjs', File.dirname(podfile)), root.to_s, '4.2.2']
  expected_commands = versions.uniq == ['4.2.2'] ? [expected_command] : []
  checks << { name: name, pass: success == expected_success && $fixture_commands == expected_commands }
end
passed = checks.all? { |row| row[:pass] }
puts JSON.pretty_generate(kind: 'generated-Podfile-controlled-CocoaPods', checks: checks, passed: passed, realCocoaPods: false)
exit(passed ? 0 : 1)
