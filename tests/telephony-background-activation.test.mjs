import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const activation = readFileSync(resolve("deploy/bin/activate-telephony-background.sh"), "utf8");
const listenerOnlyActivation = readFileSync(resolve("deploy/bin/activate-viptel-listener-only.sh"), "utf8");
const validator = readFileSync(resolve("deploy/bin/validate-activation-inputs.py"), "utf8");
const releaseBuilder = readFileSync(resolve("deploy/bin/build-release.sh"), "utf8");

test("telephony background activation is scoped away from the web stack", () => {
  assert.match(activation, /job="telephony\.viptel\.reconcile"/);
  assert.match(activation, /services=\(worker viptel_listener\)/);
  assert.match(activation, /docker compose -f compose\.yml up[\s\\]+-d --no-deps --force-recreate/);
  assert.doesNotMatch(activation, /docker compose[^\n]*up[^\n]*(?:web_blue|web_green|caddy)/);
  assert.match(activation, /"webDeploymentChanged": False/);
});

test("telephony background activation fails closed and rolls back only its own job", () => {
  const controlsCheck = activation.indexOf('controls-state "$release_dir" "$version" --jobs ""');
  const flagMutation = activation.indexOf('set-flags "$release_dir" "$version"');
  assert.ok(controlsCheck >= 0 && flagMutation > controlsCheck);
  assert.match(activation, /--jobs "\$job" --mode disable/);
  assert.doesNotMatch(activation, /--mode disable-all/);
  assert.match(activation, /rollback_stage=rollback_incomplete/);
  assert.match(activation, /rollback_stage=rollback_complete/);
  assert.match(activation, /sha256sum -c SHA256SUMS/);
});

test("release integrity and validator include the background activator", () => {
  assert.match(releaseBuilder, /activate-telephony-background\.sh/);
  assert.match(releaseBuilder, /activate-viptel-listener-only\.sh/);
  assert.match(releaseBuilder, /handover-viptel-listener-only\.sh/);
  assert.match(releaseBuilder, /upgrade-viptel-listener-only\.sh/);
  assert.match(releaseBuilder, /stage-viptel-listener-handover\.sh/);
  assert.match(releaseBuilder, /prepare-runtime-env\.mjs/);
  assert.match(releaseBuilder, /runtime-env-contract\.mjs/);
  assert.match(validator, /"bin\/activate-telephony-background\.sh"/);
  assert.match(validator, /"bin\/activate-viptel-listener-only\.sh"/);
  assert.match(validator, /"bin\/handover-viptel-listener-only\.sh"/);
  assert.match(validator, /"bin\/upgrade-viptel-listener-only\.sh"/);
  assert.match(validator, /"bin\/stage-viptel-listener-handover\.sh"/);
  assert.match(validator, /"bin\/prepare-runtime-env\.mjs"/);
  assert.match(validator, /"bin\/runtime-env-contract\.mjs"/);
  assert.match(validator, /choices=\("enable", "disable", "disable-all"\)/);
  assert.match(validator, /def controls_state\(/);
});

test("listener-only activation cannot enable a worker, scheduler, or job", () => {
  assert.match(listenerOnlyActivation, /service="viptel_listener"/);
  assert.match(listenerOnlyActivation, /--enabled true/);
  assert.match(listenerOnlyActivation, /--jobs ""/);
  assert.doesNotMatch(listenerOnlyActivation, /set-controls|--scheduler true|--mode enable/);
  assert.doesNotMatch(listenerOnlyActivation, /services=\([^)]*worker/);
});

test("activation accepts the millisecond UTC timestamps written by runtime heartbeats", () => {
  assert.match(validator, /\\d\{1,6\}/);
  assert.match(validator, /Z\|\\\+00:00/);
  assert.match(validator, /datetime\.fromisoformat/);
});
