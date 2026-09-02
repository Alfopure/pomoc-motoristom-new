#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
service="viptel_listener"
compose_project="motorist-dispatch"
operation_args=("$@")

usage() {
  echo "usage: activate-viptel-listener-only.sh RELEASE_DIR EXPECTED_PRODUCTION_GIT_SHA" >&2
  exit 2
}

[[ "$#" -eq 2 ]] || usage
release_dir=$(cd -- "$1" && pwd -P)
expected_git_sha=$2
[[ "$expected_git_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Expected production Git SHA is invalid" >&2
  exit 2
}
[[ "$script_dir" == "$release_dir/bin" ]] || {
  echo "Listener activation must run from the selected release" >&2
  exit 1
}
[[ -x "$validator" ]] || { echo "Activation validator is missing" >&2; exit 1; }
[[ -x "$operation_lock_helper" ]] || { echo "Operation-lock helper is missing" >&2; exit 1; }
for command_name in docker python3 sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

manifest_output=$(python3 - "$release_dir/manifest.json" "$expected_git_sha" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as source:
    value = json.load(source)
expected_git_sha = sys.argv[2]
version = value.get("version")
image = value.get("image")
image_id = value.get("imageId")
git_sha = value.get("gitSha")
if not isinstance(version, str) or not re.fullmatch(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}", version):
    raise SystemExit("release version is invalid")
if image != f"motorist-app:{version}":
    raise SystemExit("release image is invalid")
if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
    raise SystemExit("release image ID is invalid")
if git_sha != expected_git_sha:
    raise SystemExit("release Git SHA does not match the deployed production commit")
if value.get("platform") != "linux/amd64" or value.get("schedulerEnabled") is not False:
    raise SystemExit("release execution contract is unsafe")
print(version)
print(image)
print(image_id)
print(git_sha)
PY
)
mapfile -t manifest <<<"$manifest_output"
[[ "${#manifest[@]}" -eq 4 ]] || { echo "Release manifest output is invalid" >&2; exit 1; }
version=${manifest[0]}
image=${manifest[1]}
image_id=${manifest[2]}
git_sha=${manifest[3]}

release_checksum_sha256=$(sha256sum "$release_dir/SHA256SUMS" | awk '{print $1}')
[[ "$release_checksum_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Listener release checksum binding is invalid" >&2
  exit 1
}
# Strictly validate the exact inventory before executing any other helper from
# the release. This prevents a truncated checksum list from authorizing an
# unbound operation-lock helper.
python3 "$validator" verify-listener-release "$release_dir" "$version" \
  --expected-git-sha "$expected_git_sha" \
  --expected-release-sha256 "$release_checksum_sha256"

python3 "$operation_lock_helper" prepare "$operation_root"
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/activate-viptel-listener-only.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"

# Lock acquisition can wait. Recheck the same exact inventory after the lock is
# held so a replaced release can never pass with a new self-consistent manifest.
python3 "$validator" verify-listener-release "$release_dir" "$version" \
  --expected-git-sha "$expected_git_sha" \
  --expected-release-sha256 "$release_checksum_sha256"

actual_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || {
  echo "Listener release image is not loaded" >&2
  exit 1
}
[[ "$actual_image_id" == "$image_id" ]] || {
  echo "Listener release image ID mismatch" >&2
  exit 1
}

compose_command() {
  (
    cd "$release_dir" || exit 1
    export WEB_BLUE_IMAGE="$image_id"
    export WEB_GREEN_IMAGE="$image_id"
    export WORKER_IMAGE="$image_id"
    export VIPTEL_LISTENER_IMAGE="$image_id"
    docker compose --project-name "$compose_project" -f compose.yml "$@"
  )
}

container_snapshot() {
  local selected_service=$1
  local container_id
  container_id=$(compose_command ps -a -q "$selected_service" 2>/dev/null) || return 1
  if [[ -z "$container_id" ]]; then
    echo absent
    return 0
  fi
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  docker inspect --format '{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' "$container_id"
}

verify_worker_unchanged() {
  local current
  current=$(container_snapshot worker) || return 1
  [[ "$current" == "$worker_container_before" ]]
}

verify_listener_running_exact_image() {
  local container_id actual_id running
  container_id=$(compose_command ps -q "$service" 2>/dev/null) || return 1
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  actual_id=$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null) || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null) || return 1
  [[ "$actual_id" == "$image_id" && "$running" == true ]]
}

verify_listener_stopped() {
  local container_id running
  container_id=$(compose_command ps -a -q "$service" 2>/dev/null) || return 1
  [[ -z "$container_id" ]] && return 0
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null) || return 1
  [[ "$running" == false ]]
}

stop_listener() {
  (
    cd "$release_dir" || exit 1
    export WEB_BLUE_IMAGE="$image_id"
    export WEB_GREEN_IMAGE="$image_id"
    export WORKER_IMAGE="$image_id"
    export VIPTEL_LISTENER_IMAGE="$image_id"
    timeout 90 docker compose --project-name "$compose_project" -f compose.yml stop "$service"
  )
}

write_receipt() {
  local mode=$1
  local status=$2
  local stage=$3
  local listener_enabled=$4
  local runtime_after_sha256=$5
  python3 - "$receipt_path" "$mode" "$status" "$stage" "$listener_enabled" \
    "$runtime_after_sha256" "$version" "$image" "$image_id" "$git_sha" \
    "$release_checksum_sha256" "$listener_env_sha256" <<'PY'
import datetime as dt
import hashlib
import json
import os
import re
import stat
import sys

(path, mode, status, stage, enabled_value, runtime_after, version, image,
 image_id, git_sha, release_sha, runtime_before) = sys.argv[1:]
if enabled_value not in ("true", "false", "unknown"):
    raise SystemExit("receipt listener state is invalid")
if runtime_after != "unknown" and re.fullmatch(r"[0-9a-f]{64}", runtime_after) is None:
    raise SystemExit("receipt runtime fingerprint is invalid")
allowed_transition = {
    ("create", "in_progress", "activation_started", "false"),
    ("append", "success", "activation_complete", "true"),
    ("append", "failure", "rollback_complete", "false"),
    ("append", "failure", "rollback_incomplete", "unknown"),
}
if (mode, status, stage, enabled_value) not in allowed_transition:
    raise SystemExit("listener activation receipt transition is invalid")
record = {
    "schema": "motorist-viptel-listener-only-activation/v1",
    "recordedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": status,
    "stage": stage,
    "releaseVersion": version,
    "image": image,
    "imageId": image_id,
    "gitSha": git_sha,
    "releaseChecksumSha256": release_sha,
    "listenerRuntimeBeforeSha256": runtime_before,
    "listenerRuntimeAfterSha256": None if runtime_after == "unknown" else runtime_after,
    "service": "viptel_listener",
    "listenerEnabled": None if enabled_value == "unknown" else enabled_value == "true",
    "liveMutationsEnabled": None if enabled_value == "unknown" else enabled_value == "true",
    "workerStarted": False,
    "schedulerEnabled": False,
    "enabledJobs": [],
    "webDeploymentChanged": False,
    "previousRecordSha256": None,
}
flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
if mode == "create":
    descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
elif mode == "append":
    descriptor = os.open(path, os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0))
else:
    raise SystemExit("receipt mode is invalid")
with os.fdopen(descriptor, "r+b" if mode == "append" else "wb") as output:
    metadata = os.fstat(output.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("listener activation receipt is unsafe")
    if mode == "append":
        output.seek(0)
        first_line = output.read()
        if not first_line.endswith(b"\n") or len(first_line.splitlines()) != 1:
            raise SystemExit("listener activation receipt chain is invalid")
        first = json.loads(first_line)
        if set(first) != set(record):
            raise SystemExit("listener activation receipt fields changed")
        if not (
            first.get("status") == "in_progress"
            and first.get("stage") == "activation_started"
            and first.get("listenerEnabled") is False
            and first.get("liveMutationsEnabled") is False
            and first.get("listenerRuntimeAfterSha256")
                == first.get("listenerRuntimeBeforeSha256")
            and first.get("previousRecordSha256") is None
        ):
            raise SystemExit("listener activation receipt initial record is invalid")
        identity = (
            "schema", "releaseVersion", "image", "imageId", "gitSha",
            "releaseChecksumSha256", "listenerRuntimeBeforeSha256", "service",
            "workerStarted", "schedulerEnabled", "enabledJobs", "webDeploymentChanged",
        )
        if any(first.get(key) != record.get(key) for key in identity):
            raise SystemExit("listener activation receipt identity changed")
        record["previousRecordSha256"] = hashlib.sha256(first_line).hexdigest()
        output.seek(0, os.SEEK_END)
    output.write((json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    output.flush()
    os.fsync(output.fileno())
PY
}

worker_container_before=$(container_snapshot worker) || {
  echo "Worker container state could not be inspected" >&2
  exit 1
}
existing_listener=$(container_snapshot "$service") || {
  echo "Listener container state could not be inspected" >&2
  exit 1
}
worker_state_args=()
if [[ "$worker_container_before" == *'|true|'* ]]; then
  [[ "$worker_container_before" == *"|${image_id}|true|"* ]] || {
    echo "Running disabled worker does not use the selected release image" >&2
    exit 1
  }
  worker_state_args+=(--require-fresh-disabled-worker)
fi
listener_baseline_args=()
if [[ "$existing_listener" == *'|true|'* ]]; then
  [[ "$existing_listener" == *"|${image_id}|true|"* ]] || {
    echo "Running disabled listener does not use the selected release image" >&2
    exit 1
  }
  listener_baseline_args+=(--require-fresh-disabled-listener)
fi

worker_env_sha256=$(sha256sum "$release_dir/env/worker.env" | awk '{print $1}')
listener_env_sha256=$(sha256sum "$release_dir/env/viptel-listener.env" | awk '{print $1}')
python3 "$validator" verify-listener-runtime "$release_dir" "$version" \
  --expected-listener-sha256 "$listener_env_sha256" --enabled false --require-authority
python3 "$validator" controls-state "$release_dir" "$version" --jobs ""
python3 "$validator" listener-only-state "$release_dir" "$version" \
  --phase disabled --wait-seconds 0 \
  "${worker_state_args[@]}" "${listener_baseline_args[@]}"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_path="$operation_root/viptel-listener-only-${version}-${timestamp}-$$.jsonl"
write_receipt create in_progress activation_started false "$listener_env_sha256"

rollback_armed=true
rollback() {
  set +e
  local flags_ok=false
  local stop_ok=false
  local stopped_ok=false
  local worker_ok=false
  local controls_ok=false
  local state_ok=false
  local runtime_after=unknown
  local receipt_listener_state=unknown
  local rollback_stage=rollback_incomplete
  if python3 "$validator" set-listener-flags "$release_dir" "$version" \
    --enabled false --force-disable >/dev/null 2>&1; then
    flags_ok=true
    runtime_after=$(sha256sum "$release_dir/env/viptel-listener.env" 2>/dev/null | awk '{print $1}')
  fi
  if stop_listener >/dev/null 2>&1; then
    stop_ok=true
  fi
  if verify_listener_stopped; then
    stopped_ok=true
  fi
  if verify_worker_unchanged \
    && [[ "$(sha256sum "$release_dir/env/worker.env" 2>/dev/null | awk '{print $1}')" == "$worker_env_sha256" ]]; then
    worker_ok=true
  fi
  if python3 "$validator" controls-state "$release_dir" "$version" --jobs "" >/dev/null 2>&1; then
    controls_ok=true
  fi
  if python3 "$validator" listener-only-state "$release_dir" "$version" \
    --phase disabled --wait-seconds 60 \
    "${worker_state_args[@]}" >/dev/null 2>&1; then
    state_ok=true
  fi
  if [[ "$flags_ok" == true && "$stop_ok" == true && "$stopped_ok" == true \
    && "$worker_ok" == true && "$controls_ok" == true && "$state_ok" == true ]]; then
    rollback_stage=rollback_complete
    receipt_listener_state=false
  else
    echo "VIPTel listener-only rollback is incomplete; manual intervention is required" >&2
  fi
  write_receipt append failure "$rollback_stage" "$receipt_listener_state" "$runtime_after" || true
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$rollback_armed" == true ]]; then
    rollback
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Revalidate every externally mutable precondition immediately before changing
# the listener runtime. The worker runtime and all job controls stay untouched.
(cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "Listener release changed after preflight" >&2
  exit 1
}
python3 "$validator" verify-listener-release "$release_dir" "$version" \
  --expected-git-sha "$expected_git_sha" \
  --expected-release-sha256 "$release_checksum_sha256"
python3 "$validator" controls-state "$release_dir" "$version" --jobs ""
python3 "$validator" listener-only-state "$release_dir" "$version" \
  --phase disabled --wait-seconds 0 \
  "${worker_state_args[@]}" "${listener_baseline_args[@]}"
active_listener_env_sha256=$(
  python3 "$validator" set-listener-flags "$release_dir" "$version" \
    --enabled true --expected-listener-sha256 "$listener_env_sha256" --output hash
)
[[ "$active_listener_env_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Listener runtime flag update did not return an exact fingerprint" >&2
  exit 1
}
python3 "$validator" verify-listener-runtime "$release_dir" "$version" \
  --expected-listener-sha256 "$active_listener_env_sha256" --enabled true --require-authority
[[ "$(sha256sum "$release_dir/env/worker.env" | awk '{print $1}')" == "$worker_env_sha256" ]] || {
  echo "Worker runtime changed during listener-only activation" >&2
  exit 1
}

(
  cd "$release_dir"
  export WEB_BLUE_IMAGE="$image_id"
  export WEB_GREEN_IMAGE="$image_id"
  export WORKER_IMAGE="$image_id"
  export VIPTEL_LISTENER_IMAGE="$image_id"
  timeout 180 docker compose --project-name "$compose_project" -f compose.yml up \
    -d --no-deps --force-recreate "$service" >/dev/null
)
verify_listener_running_exact_image || {
  echo "Activated listener does not use the approved release image" >&2
  exit 1
}
verify_worker_unchanged || {
  echo "Worker state changed during listener-only activation" >&2
  exit 1
}
python3 "$validator" listener-only-state "$release_dir" "$version" \
  --phase started --wait-seconds 120 "${worker_state_args[@]}"
python3 "$validator" controls-state "$release_dir" "$version" --jobs ""
python3 "$validator" verify-listener-runtime "$release_dir" "$version" \
  --expected-listener-sha256 "$active_listener_env_sha256" --enabled true --require-authority
[[ "$(sha256sum "$release_dir/env/worker.env" | awk '{print $1}')" == "$worker_env_sha256" ]] || {
  echo "Worker runtime changed during listener-only activation" >&2
  exit 1
}
verify_worker_unchanged || {
  echo "Worker state changed during listener-only activation" >&2
  exit 1
}
verify_listener_running_exact_image || {
  echo "Listener stopped or changed image before activation completed" >&2
  exit 1
}
python3 "$validator" listener-only-state "$release_dir" "$version" \
  --phase started --wait-seconds 0 "${worker_state_args[@]}"

write_receipt append success activation_complete true "$active_listener_env_sha256"
rollback_armed=false
trap - EXIT INT TERM
echo "VIPTel listener is active from the exact production release; worker, scheduler, jobs, and web were not changed."
