import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const helper = resolve("deploy/bin/open-operation-lock.py");
const fixtureParent = resolve(".context/operation-lock-tests");
const lockName = ".motorist-operation.lock";
const marker = "motorist-operation-lock/v1\n";

mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
chmodSync(fixtureParent, 0o700);

function fixture(prefix) {
  const root = mkdtempSync(join(fixtureParent, prefix));
  chmodSync(root, 0o700);
  return root;
}

const verifyClient = String.raw`
import os
import subprocess
import sys

helper, root = sys.argv[1:]
descriptor = int(os.environ["MOTORIST_OPERATION_LOCK_FD"])
result = subprocess.run(
    [sys.executable, helper, "verify", root, str(descriptor)],
    pass_fds=(descriptor,),
    check=False,
)
raise SystemExit(result.returncode)
`;

const evidenceVerifyClient = String.raw`
import os
import subprocess
import sys

helper, root, evidence = sys.argv[1:]
if os.path.commonpath((root, evidence)) != root or evidence == root:
    raise SystemExit("evidence path escaped the operation root")
descriptor = int(os.environ["MOTORIST_OPERATION_LOCK_FD"])
result = subprocess.run(
    [sys.executable, helper, "verify", root, str(descriptor)],
    pass_fds=(descriptor,),
    check=False,
)
raise SystemExit(result.returncode)
`;

function runClient(root, code = verifyClient, extra = []) {
  return spawnSync(
    "python3",
    [helper, "exec", root, "--", "python3", "-c", code, helper, root, ...extra],
    { encoding: "utf8" },
  );
}

test("operation lock is private, single-linked, marker-bound, and inherited", (t) => {
  const root = fixture("safe-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runClient(root);
  assert.equal(result.status, 0, result.stderr);
  const lock = join(root, lockName);
  const metadata = lstatSync(lock);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(readFileSync(lock, "utf8"), marker);
});

test("operation root is safely created below a private deploy-owned parent", (t) => {
  const parent = fixture("prepare-");
  const root = join(parent, "receipts");
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const result = spawnSync("python3", [helper, "prepare", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(root).isDirectory(), true);
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
});

test("operation lock refuses a symlink", (t) => {
  const root = fixture("symlink-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  writeFileSync(target, marker, { mode: 0o600 });
  symlinkSync(target, join(root, lockName));

  const result = runClient(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operation lock is unsafe/i);
  assert.equal(readFileSync(target, "utf8"), marker);
});

test("operation lock refuses a hard link", (t) => {
  const root = fixture("hardlink-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runClient(root).status, 0);
  linkSync(join(root, lockName), join(root, "second-link"));

  const result = runClient(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one link/i);
});

test("operation lock refuses truncation without repairing or overwriting it", (t) => {
  const root = fixture("truncated-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runClient(root).status, 0);
  const lock = join(root, lockName);
  writeFileSync(lock, "", { mode: 0o600 });
  chmodSync(lock, 0o600);

  const result = runClient(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /truncated or modified/i);
  assert.equal(readFileSync(lock, "utf8"), "");
});

test("operation lock refuses a receipt directory visible to the group", (t) => {
  const root = fixture("directory-mode-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o750);

  const result = runClient(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /directory permissions are unsafe/i);
  assert.equal(existsSync(join(root, lockName)), false);
});

test("one root lock excludes concurrent cutovers using two different release evidence paths", async (t) => {
  const root = fixture("exclusive-");
  const evidenceA = join(root, "evidence-a");
  const evidenceB = join(root, "evidence-b");
  mkdirSync(evidenceA, { mode: 0o700 });
  mkdirSync(evidenceB, { mode: 0o700 });
  const ready = join(evidenceA, "ready");
  const holderCode = String.raw`
import os
import subprocess
import sys
import time

helper, root, evidence, ready = sys.argv[1:]
if os.path.commonpath((root, evidence)) != root or evidence == root:
    raise SystemExit("evidence path escaped the operation root")
descriptor = int(os.environ["MOTORIST_OPERATION_LOCK_FD"])
result = subprocess.run(
    [sys.executable, helper, "verify", root, str(descriptor)],
    pass_fds=(descriptor,),
    check=False,
)
if result.returncode:
    raise SystemExit(result.returncode)
with open(ready, "x", encoding="utf-8"):
    pass
time.sleep(10)
`;
  const holder = spawn(
    "python3",
    [
      helper,
      "exec",
      root,
      "--",
      "python3",
      "-c",
      holderCode,
      helper,
      root,
      evidenceA,
      ready,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    holder.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  });

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(ready)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(existsSync(ready), true, "lock holder did not become ready");

  const contender = runClient(root, evidenceVerifyClient, [evidenceB]);
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /another motorist operation is active/i);
  holder.kill("SIGTERM");
});

test("activation, VIPTel probe, and one-shot runner use the same receipt lock", () => {
  const oneShot = readFileSync(resolve("deploy/bin/run-one-shot-job.sh"), "utf8");
  const viptel = readFileSync(resolve("deploy/bin/probe-viptel-listener.sh"), "utf8");
  const activation = readFileSync(resolve("deploy/bin/activate-after-cutover.sh"), "utf8");
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");

  for (const implementation of [oneShot, viptel]) {
    assert.match(
      implementation,
      /operation_root="\/opt\/motorist\/receipts"[\s\S]*exec "\$operation_root"[\s\S]*verify[\s\S]*"\$operation_root"/,
    );
    assert.match(implementation, /resolved_receipt_parent.*operation_root/);
  }
  assert.match(
    activation,
    /operation_root="\/opt\/motorist\/receipts"[\s\S]*exec "\$operation_root"[\s\S]*verify[\s\S]*"\$operation_root"/,
  );
  assert.match(activation, /resolved_receipt_parent.*operation_root/);
  for (const implementation of [oneShot, viptel, activation]) {
    assert.doesNotMatch(implementation, /exec\s+[0-9]+>/);
    assert.doesNotMatch(implementation, /\.one-shot\.lock|\.viptel-listener\.lock|activation\.lock/);
  }
  assert.match(
    installer,
    /operation_root="\/opt\/motorist\/receipts"[\s\S]*--install-after-dns-cutover[\s\S]*open-operation-lock\.py" prepare "\$operation_root"[\s\S]*open-operation-lock\.py" exec "\$operation_root"[\s\S]*open-operation-lock\.py" verify[\s\S]*"\$operation_root"/,
  );
  const cutoverLock = installer.indexOf('open-operation-lock.py" exec "$operation_root"');
  const inputSnapshot = installer.indexOf("validated_inputs_root=");
  assert.ok(cutoverLock >= 0 && inputSnapshot > cutoverLock);
  assert.match(
    installer,
    /if \[\[ "\$action" == --install-after-dns-cutover \]\]; then[\s\S]*open-operation-lock\.py" exec "\$operation_root"/,
  );
  assert.doesNotMatch(installer, /install -d -m 0750 "\$receipt_dir"/);
});
