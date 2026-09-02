import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = resolve("deploy/bin/build-input-contract.mjs");
const buildRelease = readFileSync(resolve("deploy/bin/build-release.sh"), "utf8");
const version = "hetzner-contract-test";
const targetRef = "sjcsrygkkmersoczpunh";
const appDomain = "dispecing.linkapomoci.sk";

test("release builder refuses a mismatched production hostname before Docker build", () => {
  assert.match(
    buildRelease,
    /\[\[ "\$build_next_public_app_url" == "https:\/\/dispecing\.linkapomoci\.sk" \]\]/,
  );
});

test("release builder binds a clean worktree to the expected production Git SHA", () => {
  assert.match(buildRelease, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(buildRelease, /EXPECTED_PRODUCTION_GIT_SHA is mandatory/);
  assert.match(buildRelease, /git rev-parse HEAD.*expected_production_git_sha/s);
});

test("release builder safely creates an absent ignored release parent", () => {
  assert.match(buildRelease, /release_parent=\$\(dirname "\$release_dir"\)/);
  assert.match(buildRelease, /\[\[ -d "\$release_parent" && ! -L "\$release_parent" \]\]/);
  assert.match(buildRelease, /mkdir -m 0700 "\$release_parent"/);
  assert.ok(
    buildRelease.indexOf('mkdir -m 0700 "$release_parent"')
      < buildRelease.indexOf('mkdir "$release_dir"'),
  );
});

test("release builder checksum-binds operational helpers outside the image", () => {
  assert.match(buildRelease, /release_bin_names=\(/);
  for (const helper of [
    "install-release.sh",
    "open-operation-lock.py",
    "run-one-shot-job.sh",
    "write-one-shot-receipt.py",
    "activate-after-cutover.sh",
    "activate-viptel-listener-only.sh",
    "upgrade-viptel-listener-only.sh",
    "validate-activation-inputs.py",
    "create-activation-gate.py",
    "probe-viptel-listener.sh",
    "write-viptel-listener-receipt.py",
  ]) {
    assert.match(buildRelease, new RegExp(helper.replaceAll(".", "\\.")));
  }
  assert.match(buildRelease, /checksum_files\+=\("bin\/\$bin_name"\)/);
});

function buildEnv(publicKey) {
  return {
    ...process.env,
    DEPLOYMENT_VERSION: version,
    NEXT_PUBLIC_APP_URL: `https://${appDomain}`,
    NEXT_PUBLIC_SUPABASE_URL: `https://${targetRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "maps-public-test",
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: "map-id-test",
  };
}

function writeContract(path, publicKey) {
  return spawnSync("node", [helper, "write", path, version, targetRef, appDomain], {
    encoding: "utf8",
    env: buildEnv(publicKey),
  });
}

test("build input digest changes with an exact build argument", () => {
  const root = mkdtempSync(join(tmpdir(), "motorist-build-input-"));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  const firstResult = writeContract(first, "public-key-one");
  const secondResult = writeContract(second, "public-key-two");
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.match(firstResult.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.notEqual(firstResult.stdout.trim(), secondResult.stdout.trim());
});

test("build input validation binds target public aliases to protected runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "motorist-build-input-runtime-"));
  const contract = join(root, "contract.json");
  const runtime = join(root, "web.env");
  assert.equal(writeContract(contract, "public-key-one").status, 0);
  writeFileSync(
    runtime,
    [
      `NEXT_PUBLIC_SUPABASE_URL=${JSON.stringify(`https://${targetRef}.supabase.co`)}`,
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify("public-key-one")}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${JSON.stringify("public-key-one")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const valid = spawnSync(
    "node",
    [helper, "validate", contract, version, targetRef, appDomain, runtime],
    { encoding: "utf8" },
  );
  assert.equal(valid.status, 0, valid.stderr);

  const parsed = JSON.parse(readFileSync(contract, "utf8"));
  parsed.buildArgs.NEXT_PUBLIC_SUPABASE_URL = "https://jcwbiulwuwyrnmzjjbgr.supabase.co";
  writeFileSync(contract, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  const sourceBuild = spawnSync(
    "node",
    [helper, "validate", contract, version, targetRef, appDomain, runtime],
    { encoding: "utf8" },
  );
  assert.notEqual(sourceBuild.status, 0);
});

test("build input writer refuses an unguarded source release", () => {
  const root = mkdtempSync(join(tmpdir(), "motorist-build-input-source-"));
  const result = spawnSync(
    "node",
    [helper, "write", join(root, "source.json"), version, targetRef, appDomain],
    {
      encoding: "utf8",
      env: {
        ...buildEnv("public-key-one"),
        NEXT_PUBLIC_SUPABASE_URL: "https://jcwbiulwuwyrnmzjjbgr.supabase.co",
      },
    },
  );
  assert.notEqual(result.status, 0);
});
