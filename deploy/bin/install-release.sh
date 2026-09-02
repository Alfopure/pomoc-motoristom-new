#!/usr/bin/env bash
set -euo pipefail
umask 077
installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly installer_dir
[[ -f "${installer_dir}/validate-gate-timestamp.py" \
  && -f "${installer_dir}/write-cutover-receipt.py" \
  && -f "${installer_dir}/capture-private-evidence.py" \
  && -f "${installer_dir}/open-operation-lock.py" ]] || {
  echo "Installer security helpers are missing" >&2
  exit 1
}

usage() {
  echo "usage: install-release.sh RELEASE_DIR RUNTIME_ENV_DIR CUTOVER_GATE (--probe-candidate-only|--install-after-dns-cutover)" >&2
  exit 2
}

[[ "$#" -eq 4 ]] || usage
operation_args=("$@")
case "$4" in
  --probe-candidate-only|--install-after-dns-cutover) action=$4 ;;
  *) usage ;;
esac

input_release_dir=$(cd -- "$1" && pwd -P)
input_runtime_env_dir=$(cd -- "$2" && pwd -P)
gate_dir=$(cd -- "$(dirname -- "$3")" && pwd -P)
input_gate_report="$gate_dir/$(basename -- "$3")"
[[ -f "$input_gate_report" ]] || { echo "Cutover gate report is missing" >&2; exit 1; }

operation_root="/opt/motorist/receipts"
readonly operation_root
if [[ "$action" == --install-after-dns-cutover ]]; then
  python3 "${installer_dir}/open-operation-lock.py" prepare "$operation_root"
  if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
    exec python3 "${installer_dir}/open-operation-lock.py" exec "$operation_root" -- \
      "${installer_dir}/install-release.sh" "${operation_args[@]}"
  fi
  python3 "${installer_dir}/open-operation-lock.py" verify \
    "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"
fi

validated_inputs_root="$(dirname -- "$input_release_dir")/.validated-inputs"
mkdir -p "$validated_inputs_root"
chmod 700 "$validated_inputs_root"
validated_input_dir=$(mktemp -d "$validated_inputs_root/run.XXXXXX")
chmod 700 "$validated_input_dir"
retain_validated_inputs=false
trap 'rm -rf -- "$validated_input_dir"; rmdir "$validated_inputs_root" 2>/dev/null || true' EXIT INT TERM
validated_runtime_env_dir="$validated_input_dir/runtime"
validated_release_dir="$validated_input_dir/release"
mkdir -m 700 "$validated_runtime_env_dir"
mkdir -m 700 "$validated_release_dir"
mkdir -m 700 "$validated_release_dir/bin"
gate_report="$validated_input_dir/cutover-gate.json"
python3 "${installer_dir}/capture-private-evidence.py" "$input_gate_report" "$gate_report"
for env_name in web.env worker.env viptel-listener.env caddy.env; do
  python3 "${installer_dir}/capture-private-evidence.py" \
    "$input_runtime_env_dir/$env_name" \
    "$validated_runtime_env_dir/$env_name"
done
for release_name in image.tar.gz manifest.json compose.yml Caddyfile upstream.caddy runtime-env-parser.mjs SHA256SUMS; do
  python3 "${installer_dir}/capture-private-evidence.py" \
    "$input_release_dir/$release_name" \
    "$validated_release_dir/$release_name" \
    --allow-public-source
done
for release_bin_name in \
  install-release.sh \
  validate-gate-timestamp.py \
  write-cutover-receipt.py \
  capture-private-evidence.py \
  open-operation-lock.py \
  run-one-shot-job.sh \
  write-one-shot-receipt.py \
  activate-after-cutover.sh \
  activate-telephony-background.sh \
  activate-viptel-listener-only.sh \
  handover-viptel-listener-only.sh \
  upgrade-viptel-listener-only.sh \
  stage-viptel-listener-handover.sh \
  prepare-runtime-env.mjs \
  runtime-env-contract.mjs \
  validate-activation-inputs.py \
  create-activation-gate.py \
  probe-viptel-listener.sh \
  write-viptel-listener-receipt.py; do
  python3 "${installer_dir}/capture-private-evidence.py" \
    "$input_release_dir/bin/$release_bin_name" \
    "$validated_release_dir/bin/$release_bin_name" \
    --allow-public-source
  chmod 0700 "$validated_release_dir/bin/$release_bin_name"
done
runtime_env_dir="$validated_runtime_env_dir"
release_dir="$validated_release_dir"

cd "$release_dir"
sha256sum -c SHA256SUMS
validated_installer_dir="$release_dir/bin"
readonly validated_installer_dir
[[ -x "$validated_installer_dir/validate-gate-timestamp.py" \
  && -x "$validated_installer_dir/write-cutover-receipt.py" \
  && -x "$validated_installer_dir/capture-private-evidence.py" \
  && -x "$validated_installer_dir/open-operation-lock.py" ]] || {
  echo "Validated installer security helpers are missing" >&2
  exit 1
}

probe_env_file="$runtime_env_dir/.web-probe-$$.env"
receipt_dir="$operation_root"
receipt_path=""
combined_gate_receipt_path=""
cutover_receipt_created=false
cutover_receipt_finalized=false
cutover_stack_touched=false
cutover_compose_healthy=false
cutover_https_healthy=false
cutover_error_stage="pre_cutover_validation"

cleanup_probe() {
  docker rm --force "${probe_container:-}" >/dev/null 2>&1 || true
  rm -f -- "$probe_env_file"
}

cleanup_inputs() {
  if [[ "$retain_validated_inputs" != true ]]; then
    rm -rf -- "$validated_input_dir"
    rmdir "$validated_inputs_root" 2>/dev/null || true
  fi
}

verify_container_image_id() {
  local container_id=$1
  local actual_container_image_id
  actual_container_image_id=$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null) || return 1
  [[ "$actual_container_image_id" == "$expected_id" ]]
}

verify_compose_service_image_id() {
  local service=$1
  local container_id
  container_id=$(docker compose -f compose.yml ps -q "$service" 2>/dev/null) || return 1
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  verify_container_image_id "$container_id"
}

require_fresh_gate_timestamp() {
  local maximum_age_seconds=1800
  [[ "$action" == --install-after-dns-cutover ]] && maximum_age_seconds=300
  python3 "${validated_installer_dir}/validate-gate-timestamp.py" "$gate_validated_at_utc" "$maximum_age_seconds"
}

validate_authoritative_dns() {
  local domain="dispecing.linkapomoci.sk"
  local zone="linkapomoci.sk"
  local expected_ipv4="195.201.36.90"
  local nameserver response
  local -a nameservers addresses recursive_addresses

  command -v dig >/dev/null 2>&1 || {
    echo "dig is required for authoritative DNS validation" >&2
    return 1
  }
  mapfile -t nameservers < <(
    dig +time=5 +tries=2 +short NS "$zone" |
      sed '/^[[:space:]]*$/d' |
      sort -u
  )
  [[ "${#nameservers[@]}" -gt 0 ]] || {
    echo "No authoritative nameservers were discovered" >&2
    return 1
  }

  for nameserver in "${nameservers[@]}"; do
    response=$(dig +time=5 +tries=2 +noall +comments +answer A "$domain" "@$nameserver") || return 1
    grep -Eq '^;; flags:.*[[:space:]]aa([[:space:];]|$)' <<<"$response" || {
      echo "A DNS response was not authoritative" >&2
      return 1
    }
    if awk '$4 == "CNAME" { found = 1 } END { exit found ? 0 : 1 }' <<<"$response"; then
      echo "Production DNS must not use a CNAME at cutover" >&2
      return 1
    fi
    mapfile -t addresses < <(awk '$4 == "A" { print $5 }' <<<"$response" | sort -u)
    [[ "${#addresses[@]}" -eq 1 && "${addresses[0]}" == "$expected_ipv4" ]] || {
      echo "An authoritative nameserver does not point exclusively to this server" >&2
      return 1
    }
  done

  mapfile -t recursive_addresses < <(dig +time=5 +tries=2 +short A "$domain" | sed '/^[[:space:]]*$/d' | sort -u)
  [[ "${#recursive_addresses[@]}" -eq 1 && "${recursive_addresses[0]}" == "$expected_ipv4" ]] || {
    echo "Public recursive DNS does not point exclusively to this server" >&2
    return 1
  }
}

write_cutover_receipt() {
  local write_mode=$1
  local status=$2
  local stage=$3
  local compose_healthy=$4
  local https_healthy=$5
  local stack_removed=$6

  python3 "${validated_installer_dir}/write-cutover-receipt.py" \
    "$receipt_path" \
    "$write_mode" \
    "$status" \
    "$stage" \
    "$version" \
    "$image" \
    "$expected_id" \
    "$build_context_sha256" \
    "$build_args_sha256" \
    "$checksums_sha256" \
    "$gate_snapshot_id" \
    "$gate_run_id" \
    "$gate_report_sha256" \
    "$continuity_policy_sha256" \
    "$continuity_anchor_sha256" \
    "$live_watermark_anchor_sha256" \
    "$live_storage_anchor_sha256" \
    "$live_storage_transition_manifest_sha256" \
    "$component_report_sha256_json" \
    "$gate_validated_at_utc" \
    "$compose_healthy" \
    "$https_healthy" \
    "$stack_removed"
}

cleanup() {
  local exit_code=$?
  local stack_removed=false
  trap - EXIT
  set +e
  cleanup_probe

  if [[ "$exit_code" -ne 0 && "$cutover_receipt_created" == true && "$cutover_receipt_finalized" != true ]]; then
    if [[ "$cutover_stack_touched" == true ]]; then
      if docker compose -f compose.yml down --remove-orphans >/dev/null 2>&1; then
        stack_removed=true
      fi
    fi
    write_cutover_receipt \
      append \
      failure \
      "$cutover_error_stage" \
      "$cutover_compose_healthy" \
      "$cutover_https_healthy" \
      "$stack_removed" || echo "WARNING: failed to append the cutover failure receipt" >&2
  fi

  cleanup_inputs

  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

readarray -t validated_fields < <(python3 - \
  "$release_dir" \
  "$runtime_env_dir" \
  "$gate_report" \
  "$action" \
  "$probe_env_file" <<'PY'
import hashlib
import datetime
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request

release_dir, runtime_dir, gate_path, action, probe_env_path = sys.argv[1:]
source_ref = "jcwbiulwuwyrnmzjjbgr"
target_ref = "sjcsrygkkmersoczpunh"
target_url = f"https://{target_ref}.supabase.co"
app_domain = "dispecing.linkapomoci.sk"
release_pattern = re.compile(r"^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
snapshot_pattern = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
gate_run_pattern = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$")
image_id_pattern = re.compile(r"^sha256:[0-9a-f]{64}$")
sha256_pattern = re.compile(r"^[0-9a-f]{64}$")
env_key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
utc_timestamp_pattern = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
maximum_gate_age_seconds = 30 * 60 if action == "--probe-candidate-only" else 5 * 60


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def require_private_file(path):
    metadata = os.stat(path, follow_symlinks=False)
    require(stat.S_ISREG(metadata.st_mode), f"{path} is not a regular file")
    require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{path} must have mode 0600 or stricter")


def parse_env(path):
    require_private_file(path)
    parsed = {}
    with open(path, encoding="utf-8") as env_file:
        for line_number, raw_line in enumerate(env_file, 1):
            line = raw_line.rstrip("\n")
            if not line:
                continue
            require("=" in line, f"{path}:{line_number} is not KEY=value")
            key, encoded_value = line.split("=", 1)
            require(env_key_pattern.fullmatch(key), f"{path}:{line_number} has an invalid key")
            require(key not in parsed, f"{path} contains duplicate key {key}")
            try:
                value = json.loads(encoded_value)
            except json.JSONDecodeError as error:
                raise SystemExit(f"{path}:{line_number} is not a JSON-quoted value") from error
            require(isinstance(value, str), f"{path}:{line_number} value must be a string")
            parsed[key] = value
    return parsed


def validate_shared(env, version):
    require(env.get("SUPABASE_PROJECT_REF") == target_ref, "runtime project ref mismatch")
    require(env.get("NEXT_PUBLIC_SUPABASE_URL") == target_url, "public Supabase URL mismatch")
    require(env.get("SUPABASE_URL") == target_url, "server Supabase URL mismatch")
    require(env.get("DEPLOYMENT_VERSION") == version, "runtime release version mismatch")
    require(env.get("NODE_ENV") == "production", "NODE_ENV must be production")
    require(env.get("MOTORIST_DEV_AUTH_BYPASS") == "false", "development auth bypass must be disabled")
    require(env.get("APP_BASE_URL") == f"https://{app_domain}", "APP_BASE_URL mismatch")
    require(env.get("PUBLIC_APP_URL") == f"https://{app_domain}", "PUBLIC_APP_URL mismatch")
    for forbidden in ("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", "SUPABASE_JWT_SECRET", "VERCEL"):
        require(forbidden not in env, f"forbidden runtime variable {forbidden}")
    require(all(source_ref not in value for value in env.values()), "source project ref is present in runtime env")
    public_aliases = (
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
    )
    server_aliases = ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    require(all(env.get(key) for key in public_aliases), "public key alias is missing")
    require(all(env.get(key) for key in server_aliases), "server key alias is missing")
    require(len({env[key] for key in public_aliases}) == 1, "public key aliases differ")
    require(len({env[key] for key in server_aliases}) == 1, "server key aliases differ")
    require(env[public_aliases[0]] != env[server_aliases[0]], "public and server keys must differ")


def request_status(url, headers):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


manifest_path = os.path.join(release_dir, "manifest.json")
checksums_path = os.path.join(release_dir, "SHA256SUMS")
with open(manifest_path, encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
with open(gate_path, "rb") as gate_file:
    gate_bytes = gate_file.read()
gate = json.loads(gate_bytes)
require_private_file(gate_path)
gate_report_sha256 = hashlib.sha256(gate_bytes).hexdigest()

version = manifest.get("version")
image = manifest.get("image")
image_id = manifest.get("imageId")
build_context_sha256 = manifest.get("buildContextSha256")
build_args_sha256 = manifest.get("buildArgsSha256")
require(isinstance(version, str) and release_pattern.fullmatch(version) and ".." not in version, "invalid release version")
require(image == f"motorist-app:{version}", "release image name mismatch")
require(isinstance(image_id, str) and image_id_pattern.fullmatch(image_id), "invalid release image ID")
require(isinstance(build_context_sha256, str) and sha256_pattern.fullmatch(build_context_sha256), "invalid release build context hash")
require(isinstance(build_args_sha256, str) and sha256_pattern.fullmatch(build_args_sha256), "invalid release build argument hash")
require(manifest.get("platform") == "linux/amd64", "release platform mismatch")
require(manifest.get("schedulerEnabled") is False, "release scheduler must be disabled")

with open(checksums_path, "rb") as checksums_file:
    checksums_sha256 = hashlib.sha256(checksums_file.read()).hexdigest()
require(gate.get("gate_status") == "pass_predeployment", "cutover gate did not pass")
require(gate.get("failures") == [], "cutover gate contains failures")
require(snapshot_pattern.fullmatch(gate.get("snapshot_id", "")), "cutover gate snapshot is invalid")
require(gate.get("source_project_ref") == source_ref, "cutover gate source ref mismatch")
require(gate.get("target_project_ref") == target_ref, "cutover gate target ref mismatch")
require(gate.get("release_version") == version, "cutover gate release mismatch")
require(gate.get("image_id") == image_id, "cutover gate image ID mismatch")
require(gate.get("build_context_sha256") == build_context_sha256, "cutover gate build context mismatch")
require(gate.get("build_args_sha256") == build_args_sha256, "cutover gate build argument mismatch")
require(gate.get("sha256sums_sha256") == checksums_sha256, "cutover gate checksum binding mismatch")
continuity_policy_sha256 = gate.get("continuity_policy_sha256")
continuity_anchor_sha256 = gate.get("continuity_anchor_sha256")
live_watermark_anchor_sha256 = gate.get("live_watermark_anchor_sha256")
live_storage_anchor_sha256 = gate.get("live_storage_anchor_sha256")
live_storage_transition_manifest_sha256 = gate.get("live_storage_transition_manifest_sha256")
require(isinstance(continuity_policy_sha256, str) and sha256_pattern.fullmatch(continuity_policy_sha256), "continuity policy binding is invalid")
require(isinstance(continuity_anchor_sha256, str) and sha256_pattern.fullmatch(continuity_anchor_sha256), "continuity anchor binding is invalid")
require(isinstance(live_watermark_anchor_sha256, str) and sha256_pattern.fullmatch(live_watermark_anchor_sha256), "live watermark anchor binding is invalid")
require(isinstance(live_storage_anchor_sha256, str) and sha256_pattern.fullmatch(live_storage_anchor_sha256), "live Storage anchor binding is invalid")
require(isinstance(live_storage_transition_manifest_sha256, str) and sha256_pattern.fullmatch(live_storage_transition_manifest_sha256), "live Storage transition manifest binding is invalid")
gate_run_id = gate.get("gate_run_id")
require(isinstance(gate_run_id, str) and gate_run_pattern.fullmatch(gate_run_id), "cutover gate run ID is invalid")
require(isinstance(gate.get("auth_redirect_receipt_sha256"), str) and sha256_pattern.fullmatch(gate["auth_redirect_receipt_sha256"]), "Auth redirect receipt binding is invalid")
require(isinstance(gate.get("rentals_vercel_env_receipt_sha256"), str) and sha256_pattern.fullmatch(gate["rentals_vercel_env_receipt_sha256"]), "Rentals env receipt binding is invalid")
component_hashes = gate.get("component_report_sha256")
require(isinstance(component_hashes, dict) and sorted(component_hashes) == ["application", "auth", "config", "database", "storage"], "component report hash set is invalid")
require(all(isinstance(value, str) and sha256_pattern.fullmatch(value) for value in component_hashes.values()), "component report hash is invalid")
component_report_sha256_json = json.dumps(component_hashes, sort_keys=True, separators=(",", ":"))
require(gate.get("source_write_freeze_active") is True, "cutover gate source freeze is inactive")
require(gate.get("source_deleted") is False, "cutover gate source deletion state is invalid")
require(gate.get("target_jobs_active") is False, "cutover gate target jobs are active")
require(gate.get("scheduler_enabled") is False, "cutover gate scheduler is active")
require(gate.get("production_cutover_performed") is False, "cutover gate was already consumed")

gate_validated_at_utc = gate.get("validated_at_utc")
gate_started_at_utc = gate.get("gate_started_at_utc")
gate_completed_at_utc = gate.get("completed_at_utc")
require(
    isinstance(gate_validated_at_utc, str) and utc_timestamp_pattern.fullmatch(gate_validated_at_utc),
    "cutover gate validated_at_utc is not a strict UTC timestamp",
)
try:
    gate_validated_at = datetime.datetime.strptime(
        gate_validated_at_utc,
        "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
except ValueError as error:
    raise SystemExit("cutover gate validated_at_utc is invalid") from error
try:
    gate_started_at = datetime.datetime.strptime(
        gate_started_at_utc,
        "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
    gate_completed_at = datetime.datetime.strptime(
        gate_completed_at_utc,
        "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
except (TypeError, ValueError) as error:
    raise SystemExit("cutover gate evidence window timestamps are invalid") from error
try:
    operational_state_validated_at = datetime.datetime.strptime(
        gate.get("operational_state_validated_at_utc"),
        "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
except (TypeError, ValueError) as error:
    raise SystemExit("cutover gate operational timestamp is invalid") from error
gate_run_duration_seconds = gate.get("gate_run_duration_seconds")
maximum_component_age_seconds = gate.get("maximum_component_age_seconds")
require(type(gate_run_duration_seconds) is int, "cutover gate run duration is invalid")
require(type(maximum_component_age_seconds) is int, "cutover gate component age is invalid")
require(gate.get("component_evidence_count") == 6, "cutover gate component evidence count is invalid")
require(
    gate_started_at <= gate_validated_at <= gate_completed_at,
    "cutover gate evidence timestamps are out of order",
)
require(
    gate_started_at <= operational_state_validated_at <= gate_completed_at,
    "cutover gate operational evidence is out of order",
)
require(
    gate_completed_at <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=5),
    "cutover gate completion timestamp is in the future",
)
require(
    gate_run_duration_seconds == int((gate_completed_at - gate_started_at).total_seconds()),
    "cutover gate run duration does not match its timestamps",
)
require(
    maximum_component_age_seconds == int((gate_completed_at - gate_validated_at).total_seconds()),
    "cutover gate component age does not match its timestamps",
)
require(0 <= gate_run_duration_seconds <= 30 * 60, "cutover gate run exceeded 30 minutes")
require(
    0 <= maximum_component_age_seconds <= 30 * 60,
    "cutover gate component evidence exceeded 30 minutes",
)
gate_age_seconds = (datetime.datetime.now(datetime.timezone.utc) - gate_validated_at).total_seconds()
require(gate_age_seconds >= 0, "cutover gate timestamp is in the future")
require(gate_age_seconds <= maximum_gate_age_seconds, "cutover gate is older than the allowed action window")

web = parse_env(os.path.join(runtime_dir, "web.env"))
worker = parse_env(os.path.join(runtime_dir, "worker.env"))
listener = parse_env(os.path.join(runtime_dir, "viptel-listener.env"))
caddy = parse_env(os.path.join(runtime_dir, "caddy.env"))
validate_shared(web, version)
validate_shared(worker, version)
validate_shared(listener, version)
require("SCHEDULER_ENABLED" not in web, "web env must not contain scheduler state")
require(worker.get("SCHEDULER_ENABLED") == "false", "worker scheduler must be disabled")
require(worker.get("WORKER_INSTANCE_ID") == "motorist-prod-01", "worker instance mismatch")
require(listener.get("VIPTEL_LISTENER_ENABLED") == "false", "VIPTel listener must start disabled")
require(listener.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel", "VIPTel listener instance mismatch")
require(caddy.get("APP_DOMAIN") == app_domain, "Caddy domain mismatch")
require(bool(caddy.get("ACME_EMAIL")), "Caddy ACME email is missing")
require(all(source_ref not in value for value in caddy.values()), "source project ref is present in Caddy env")

public_key = web["SUPABASE_PUBLISHABLE_KEY"]
secret_key = web["SUPABASE_SECRET_KEY"]
require(request_status(f"{target_url}/auth/v1/settings", {"apikey": public_key}) == 200, "target Auth key probe failed")
require(
    request_status(
        f"{target_url}/rest/v1/motorist_profiles?select=id",
        {
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Range": "0-0",
            "Prefer": "count=exact",
        },
    ) == 206,
    "target Data API key probe failed",
)
require(
    request_status(
        f"{target_url}/storage/v1/bucket",
        {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
    ) == 200,
    "target Storage key probe failed",
)

if action == "--probe-candidate-only":
    descriptor = os.open(probe_env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as probe_file:
        for key, value in web.items():
            require(not any(character in value for character in ("\r", "\n", "\0")), f"{key} cannot be represented in Docker env")
            probe_file.write(f"{key}={json.dumps(value, ensure_ascii=True)}\n")

print(version)
print(image)
print(image_id)
print(build_context_sha256)
print(build_args_sha256)
print(checksums_sha256)
print(gate["snapshot_id"])
print(gate_run_id)
print(gate_report_sha256)
print(continuity_policy_sha256)
print(continuity_anchor_sha256)
print(live_watermark_anchor_sha256)
print(live_storage_anchor_sha256)
print(live_storage_transition_manifest_sha256)
print(component_report_sha256_json)
print(gate_validated_at_utc)
PY
)
[[ "${#validated_fields[@]}" -eq 16 ]] || { echo "Release/gate/runtime validation failed" >&2; exit 1; }
version=${validated_fields[0]}
image=${validated_fields[1]}
expected_id=${validated_fields[2]}
build_context_sha256=${validated_fields[3]}
build_args_sha256=${validated_fields[4]}
checksums_sha256=${validated_fields[5]}
gate_snapshot_id=${validated_fields[6]}
gate_run_id=${validated_fields[7]}
gate_report_sha256=${validated_fields[8]}
continuity_policy_sha256=${validated_fields[9]}
continuity_anchor_sha256=${validated_fields[10]}
live_watermark_anchor_sha256=${validated_fields[11]}
live_storage_anchor_sha256=${validated_fields[12]}
live_storage_transition_manifest_sha256=${validated_fields[13]}
component_report_sha256_json=${validated_fields[14]}
gate_validated_at_utc=${validated_fields[15]}

if [[ "$action" == --install-after-dns-cutover ]]; then
  receipt_path="$receipt_dir/cutover-${version}.jsonl"
  combined_gate_receipt_path="$receipt_dir/cutover-${version}.combined-gate.json"
  if [[ -e "$receipt_path" || -L "$receipt_path" \
    || -e "$combined_gate_receipt_path" || -L "$combined_gate_receipt_path" ]]; then
    echo "Cutover evidence for this release already exists; refusing a repeated attempt" >&2
    exit 1
  fi
  if docker ps -a --filter label=com.docker.compose.project=motorist-dispatch --format '{{.ID}}' | grep -q .; then
    echo "An existing motorist-dispatch stack is present; this first-cutover installer refuses an unsafe replacement" >&2
    exit 1
  fi
fi

gzip -dc image.tar.gz | docker load >/dev/null
actual_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$actual_id" == "$expected_id" ]] || { echo "Image digest mismatch" >&2; exit 1; }
set +e
docker run --rm --entrypoint sh "$expected_id" -c \
  "grep -r -F -- 'jcwbiulwuwyrnmzjjbgr' /app >/dev/null 2>&1"
source_client_asset_status=$?
docker run --rm --entrypoint sh "$expected_id" -c \
  "grep -r -F -- 'sjcsrygkkmersoczpunh' /app/.next/static >/dev/null 2>&1"
target_client_asset_status=$?
set -e
if [[ "$source_client_asset_status" -ne 1 || "$target_client_asset_status" -ne 0 ]]; then
  echo "Compiled client assets do not exclusively reference the target project" >&2
  exit 1
fi

require_fresh_gate_timestamp

if [[ "$action" == --probe-candidate-only ]]; then
  probe_container="motorist-candidate-probe-${version//[^A-Za-z0-9_.-]/-}"
  docker run --detach --rm \
    --name "$probe_container" \
    --platform linux/amd64 \
    --read-only \
    --tmpfs /tmp:size=64m,mode=1777 \
    --tmpfs /app/.next/cache:size=128m,mode=0700,uid=1001,gid=1001 \
    --cap-drop ALL \
    --cap-add DAC_OVERRIDE \
    --cap-add SETGID \
    --cap-add SETUID \
    --security-opt no-new-privileges:true \
    --pids-limit 256 \
    --memory 1g \
    --cpus 1.25 \
    --mount "type=bind,source=${probe_env_file},target=/run/secrets/runtime_env,readonly" \
    --publish 127.0.0.1::3000 \
    "$expected_id" >/dev/null
  verify_container_image_id "$probe_container" || {
    echo "Candidate container image ID mismatch" >&2
    exit 1
  }
  probe_port=$(docker port "$probe_container" 3000/tcp | sed -n 's/.*://p' | tail -n 1)
  [[ "$probe_port" =~ ^[0-9]+$ ]] || { echo "Candidate loopback port was not published" >&2; exit 1; }
  python3 - "$probe_port" "$version" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

port, version = sys.argv[1:]
base_url = f"http://127.0.0.1:{port}"
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health/live", timeout=5) as response:
            payload = json.load(response)
        if response.status == 200 and payload.get("status") == "live" and payload.get("version") == version:
            break
    except (OSError, ValueError, urllib.error.URLError):
        pass
    time.sleep(1)
else:
    raise SystemExit("candidate liveness probe timed out")

for _ in range(5):
    with urllib.request.urlopen(f"{base_url}/api/health/ready", timeout=5) as response:
        payload = json.load(response)
    if response.status != 200 or payload.get("status") != "ready" or payload.get("version") != version:
        raise SystemExit("candidate readiness probe failed")
    time.sleep(1)
PY
  cleanup_probe
  cleanup_inputs
  trap - EXIT INT TERM
  echo "Release ${version} is staged and passed a private candidate probe; production is unchanged."
  exit 0
fi

validate_authoritative_dns || {
  echo "Production DNS does not point to this server; refusing cutover" >&2
  exit 1
}

if docker ps -a --filter label=com.docker.compose.project=motorist-dispatch --format '{{.ID}}' | grep -q .; then
  echo "An existing motorist-dispatch stack is present; this first-cutover installer refuses an unsafe replacement" >&2
  exit 1
fi

python3 "$validated_installer_dir/open-operation-lock.py" verify \
  "$receipt_dir" "${MOTORIST_OPERATION_LOCK_FD:-}"
[[ "$(cd -- "$receipt_dir" && pwd -P)" == "$receipt_dir" ]] || {
  echo "Cutover receipt directory must not traverse symlinks" >&2
  exit 1
}
require_fresh_gate_timestamp
python3 "$validated_installer_dir/capture-private-evidence.py" \
  "$gate_report" \
  "$combined_gate_receipt_path"
preserved_gate_sha256=$(sha256sum -- "$combined_gate_receipt_path" | awk '{print $1}')
[[ "$preserved_gate_sha256" == "$gate_report_sha256" ]] || {
  echo "Preserved cutover gate checksum mismatch" >&2
  exit 1
}
cutover_error_stage="cutover_started"
write_cutover_receipt create in_progress cutover_started false false false
cutover_receipt_created=true

cutover_error_stage="runtime_env_install"
install -d -m 0750 env
install -m 0600 "$runtime_env_dir/web.env" env/web.env
install -m 0600 "$runtime_env_dir/worker.env" env/worker.env
install -m 0600 "$runtime_env_dir/viptel-listener.env" env/viptel-listener.env
install -m 0600 "$runtime_env_dir/caddy.env" env/caddy.env

export WEB_BLUE_IMAGE="$expected_id"
export WEB_GREEN_IMAGE="$expected_id"
export WORKER_IMAGE="$expected_id"
export VIPTEL_LISTENER_IMAGE="$expected_id"
cutover_error_stage="compose_config"
docker compose -f compose.yml config --quiet
cutover_error_stage="compose_start"
cutover_stack_touched=true
if ! timeout 210 docker compose -f compose.yml up -d --wait --wait-timeout 180 web_blue web_green caddy worker viptel_listener; then
  echo "Initial production stack failed to become healthy and was removed" >&2
  exit 1
fi
for app_service in web_blue web_green worker viptel_listener; do
  verify_compose_service_image_id "$app_service" || {
    echo "A production app container image ID does not match the approved release" >&2
    exit 1
  }
done
cutover_compose_healthy=true

cutover_error_stage="https_health"
https_ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error \
    --resolve "dispecing.linkapomoci.sk:443:127.0.0.1" \
    "https://dispecing.linkapomoci.sk/api/health/live" >/dev/null \
    && curl --fail --silent --show-error \
      --resolve "dispecing.linkapomoci.sk:443:127.0.0.1" \
      "https://dispecing.linkapomoci.sk/api/health/ready" >/dev/null; then
    https_ready=true
    break
  fi
  sleep 2
done
if [[ "$https_ready" != true ]]; then
  echo "Public HTTPS health checks failed and the initial stack was removed" >&2
  exit 1
fi
cutover_https_healthy=true

cutover_error_stage="receipt_finalize"
write_cutover_receipt append success cutover_complete true true false
cutover_receipt_finalized=true
retain_validated_inputs=true
cleanup_inputs
trap - EXIT INT TERM
echo "Release ${version} is healthy on production HTTPS; scheduler remains disabled."
