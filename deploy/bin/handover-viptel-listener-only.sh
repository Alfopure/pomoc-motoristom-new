#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
compose_project="motorist-dispatch"
service="viptel_listener"
preserved_jobs="telephony.viptel.reconcile"
operation_args=("$@")

usage() {
  echo "usage: handover-viptel-listener-only.sh OLD_RELEASE_DIR NEW_RELEASE_DIR EXPECTED_OLD_GIT_SHA EXPECTED_PRODUCTION_GIT_SHA" >&2
  exit 2
}

[[ "$#" -eq 4 ]] || usage
old_release_dir=$(cd -- "$1" && pwd -P)
new_release_dir=$(cd -- "$2" && pwd -P)
expected_old_git_sha=$3
expected_new_git_sha=$4
[[ "$expected_old_git_sha" =~ ^[0-9a-f]{40}$ \
  && "$expected_new_git_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "A handover Git SHA is invalid" >&2
  exit 2
}
[[ "$script_dir" == "$new_release_dir/bin" ]] || {
  echo "VIPTel handover must run from the selected new release" >&2
  exit 1
}
[[ "$old_release_dir" != "$new_release_dir" ]] || {
  echo "VIPTel handover requires distinct old and new releases" >&2
  exit 1
}
[[ -x "$validator" && -x "$operation_lock_helper" ]] || {
  echo "VIPTel handover security helper is missing" >&2
  exit 1
}
for command_name in docker python3 sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

release_fields_output=$(python3 - \
  "$old_release_dir/manifest.json" "$expected_old_git_sha" \
  "$new_release_dir/manifest.json" "$expected_new_git_sha" <<'PY'
import json
import re
import sys

pattern = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
for path, expected_git_sha in ((sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])):
    with open(path, "r", encoding="utf-8") as source:
        value = json.load(source)
    version = value.get("version")
    image = value.get("image")
    image_id = value.get("imageId")
    if not isinstance(version, str) or pattern.fullmatch(version) is None:
        raise SystemExit("handover release version is invalid")
    if image != f"motorist-app:{version}":
        raise SystemExit("handover release image is invalid")
    if not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None:
        raise SystemExit("handover release image ID is invalid")
    if value.get("gitSha") != expected_git_sha:
        raise SystemExit("handover release Git SHA mismatch")
    if value.get("platform") != "linux/amd64" or value.get("schedulerEnabled") is not False:
        raise SystemExit("handover release execution contract is unsafe")
    print(version)
    print(image)
    print(image_id)
    print(expected_git_sha)
PY
)
release_fields=()
while IFS= read -r release_field; do
  release_fields[${#release_fields[@]}]=$release_field
done <<<"$release_fields_output"
[[ "${#release_fields[@]}" -eq 8 ]] || {
  echo "VIPTel handover release output is invalid" >&2
  exit 1
}
old_version=${release_fields[0]}
old_image=${release_fields[1]}
old_image_id=${release_fields[2]}
old_git_sha=${release_fields[3]}
new_version=${release_fields[4]}
new_image=${release_fields[5]}
new_image_id=${release_fields[6]}
new_git_sha=${release_fields[7]}
[[ "$old_version" != "$new_version" && "$old_image_id" != "$new_image_id" ]] || {
  echo "VIPTel handover candidate is not a distinct release image" >&2
  exit 1
}

old_release_sha256=$(sha256sum "$old_release_dir/SHA256SUMS" | awk '{print $1}')
new_release_sha256=$(sha256sum "$new_release_dir/SHA256SUMS" | awk '{print $1}')
[[ "$old_release_sha256" =~ ^[0-9a-f]{64}$ \
  && "$new_release_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "VIPTel handover checksum binding is invalid" >&2
  exit 1
}

verify_release_bindings() {
  python3 "$validator" verify-handover-release "$old_release_dir" "$old_version" \
    --expected-git-sha "$old_git_sha" \
    --expected-release-sha256 "$old_release_sha256"
  python3 "$validator" verify-listener-release "$new_release_dir" "$new_version" \
    --expected-git-sha "$new_git_sha" \
    --expected-release-sha256 "$new_release_sha256"
}

verify_checksum_bindings_without_helpers() {
  [[ "$(sha256sum "$old_release_dir/SHA256SUMS" 2>/dev/null | awk '{print $1}')" == "$old_release_sha256" \
    && "$(sha256sum "$new_release_dir/SHA256SUMS" 2>/dev/null | awk '{print $1}')" == "$new_release_sha256" ]] \
    && (cd "$old_release_dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1) \
    && (cd "$new_release_dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
}

# Validate both inventories before executing another bundled helper.
verify_release_bindings
python3 "$operation_lock_helper" prepare "$operation_root"
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/handover-viptel-listener-only.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"
verify_release_bindings

[[ "$(docker image inspect --format '{{.Id}}' "$old_image" 2>/dev/null)" == "$old_image_id" ]] || {
  echo "Exact old VIPTel image is unavailable" >&2
  exit 1
}
[[ "$(docker image inspect --format '{{.Id}}' "$new_image" 2>/dev/null)" == "$new_image_id" ]] || {
  echo "Exact new VIPTel image is unavailable" >&2
  exit 1
}

compose_for() {
  local selected_release=$1
  local selected_image_id=$2
  shift 2
  (
    cd "$selected_release" || exit 1
    export WEB_BLUE_IMAGE="$selected_image_id"
    export WEB_GREEN_IMAGE="$selected_image_id"
    export WORKER_IMAGE="$selected_image_id"
    export VIPTEL_LISTENER_IMAGE="$selected_image_id"
    docker compose --project-name "$compose_project" -f compose.yml "$@"
  )
}

container_id() {
  compose_for "$new_release_dir" "$new_image_id" ps -a -q "$1" 2>/dev/null
}

container_snapshot() {
  local selected_service=$1
  local id
  id=$(container_id "$selected_service") || return 1
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  docker inspect --format \
    '{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' \
    "$id"
}

container_runtime_source() {
  local id=$1
  docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/run/secrets/runtime_env"}}{{.Source}}{{end}}{{end}}' \
    "$id"
}

verify_service() {
  local selected_service=$1
  local expected_image_id=$2
  local expected_runtime_source=$3
  local id actual_image running runtime_source
  id=$(container_id "$selected_service") || return 1
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  actual_image=$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null) || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
  runtime_source=$(container_runtime_source "$id" 2>/dev/null) || return 1
  [[ "$actual_image" == "$expected_image_id" \
    && "$running" == true \
    && "$runtime_source" == "$expected_runtime_source" ]]
}

start_listener_from() {
  local selected_release=$1
  local selected_image_id=$2
  (
    cd "$selected_release" || exit 1
    export WEB_BLUE_IMAGE="$selected_image_id"
    export WEB_GREEN_IMAGE="$selected_image_id"
    export WORKER_IMAGE="$selected_image_id"
    export VIPTEL_LISTENER_IMAGE="$selected_image_id"
    timeout 180 docker compose --project-name "$compose_project" -f compose.yml up \
      -d --no-deps --force-recreate "$service" >/dev/null
  )
}

old_worker_runtime="$old_release_dir/env/worker.env"
old_listener_runtime="$old_release_dir/env/viptel-listener.env"
new_listener_runtime="$new_release_dir/env/viptel-listener.env"
worker_container_before=$(container_snapshot worker) || {
  echo "Running worker container could not be captured" >&2
  exit 1
}
old_listener_container_before=$(container_snapshot "$service") || {
  echo "Running old listener container could not be captured" >&2
  exit 1
}
worker_container_sha256=$(printf '%s' "$worker_container_before" | sha256sum | awk '{print $1}')
old_listener_container_sha256=$(printf '%s' "$old_listener_container_before" | sha256sum | awk '{print $1}')
worker_runtime_sha256=$(sha256sum "$old_worker_runtime" | awk '{print $1}')
old_listener_runtime_sha256=$(sha256sum "$old_listener_runtime" | awk '{print $1}')
new_listener_runtime_before_sha256=$(sha256sum "$new_listener_runtime" | awk '{print $1}')
for binding in \
  "$worker_container_sha256" \
  "$old_listener_container_sha256" \
  "$worker_runtime_sha256" \
  "$old_listener_runtime_sha256" \
  "$new_listener_runtime_before_sha256"; do
  [[ "$binding" =~ ^[0-9a-f]{64}$ ]] || {
    echo "VIPTel handover runtime binding is invalid" >&2
    exit 1
  }
done

verify_worker_unchanged() {
  local current
  current=$(container_snapshot worker) || return 1
  [[ "$current" == "$worker_container_before" ]] \
    && verify_service worker "$old_image_id" "$old_worker_runtime" \
    && [[ "$(sha256sum "$old_worker_runtime" 2>/dev/null | awk '{print $1}')" == "$worker_runtime_sha256" ]]
}

verify_old_listener_exact() {
  local current
  current=$(container_snapshot "$service") || return 1
  [[ "$current" == "$old_listener_container_before" ]] \
    && verify_service "$service" "$old_image_id" "$old_listener_runtime"
}

verify_preserved_control_state() {
  python3 "$validator" controls-state "$old_release_dir" "$old_version" \
    --jobs "$preserved_jobs"
}

verify_runtime_bindings() {
  python3 "$validator" verify-handover-old-runtime "$old_release_dir" "$old_version" \
    --expected-worker-sha256 "$worker_runtime_sha256" \
    --expected-listener-sha256 "$old_listener_runtime_sha256"
  python3 "$validator" verify-handover-new-runtime "$new_release_dir" "$new_version" \
    --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
    --enabled false
}

verify_worker_unchanged || {
  echo "Existing worker does not match the exact old release" >&2
  exit 1
}
verify_old_listener_exact || {
  echo "Existing listener does not match the exact old release" >&2
  exit 1
}
verify_runtime_bindings
verify_preserved_control_state
python3 "$validator" handover-state "$old_release_dir" "$old_version" \
  --worker-version "$old_version" \
  --listener-version "$old_version" \
  --jobs "$preserved_jobs" \
  --wait-seconds 0

write_receipt() {
  local mode=$1
  local status=$2
  local stage=$3
  local active_listener_version=$4
  local new_listener_enabled=$5
  local worker_unchanged=$6
  local scheduler_preserved=$7
  local new_runtime_after=$8
  python3 - \
    "$receipt_path" "$mode" "$status" "$stage" "$active_listener_version" \
    "$new_listener_enabled" "$worker_unchanged" "$scheduler_preserved" \
    "$new_runtime_after" \
    "$old_version" "$old_image" "$old_image_id" "$old_git_sha" "$old_release_sha256" \
    "$new_version" "$new_image" "$new_image_id" "$new_git_sha" "$new_release_sha256" \
    "$worker_container_sha256" "$worker_runtime_sha256" \
    "$old_listener_container_sha256" "$old_listener_runtime_sha256" \
    "$new_listener_runtime_before_sha256" <<'PY'
import datetime as dt
import hashlib
import json
import os
import re
import stat
import sys

(
    path, mode, status, stage, active_version, new_enabled, worker_unchanged,
    scheduler_preserved, new_runtime_after,
    old_version, old_image, old_image_id, old_git, old_release_sha,
    new_version, new_image, new_image_id, new_git, new_release_sha,
    worker_container_sha, worker_runtime_sha, old_listener_container_sha,
    old_listener_runtime_sha, new_listener_runtime_before,
) = sys.argv[1:]

truth = {"true": True, "false": False, "unknown": None}
if new_enabled not in truth or worker_unchanged not in truth or scheduler_preserved not in truth:
    raise SystemExit("handover receipt truth value is invalid")
if active_version not in (old_version, new_version, "unknown"):
    raise SystemExit("handover receipt active release is invalid")
if new_runtime_after != "unknown" and re.fullmatch(r"[0-9a-f]{64}", new_runtime_after) is None:
    raise SystemExit("handover receipt runtime binding is invalid")
allowed = {
    ("create", "in_progress", "handover_started", old_version, "false", "true", "true"),
    ("append", "success", "handover_complete", new_version, "true", "true", "true"),
    ("append", "failure", "rollback_complete", old_version, "false", "true", "true"),
    ("append", "failure", "rollback_incomplete", "unknown", "unknown", "unknown", "unknown"),
}
transition = (
    mode, status, stage, active_version, new_enabled,
    worker_unchanged, scheduler_preserved,
)
if transition not in allowed:
    raise SystemExit("handover receipt transition is invalid")
record = {
    "schema": "motorist-viptel-listener-handover/v1",
    "recordedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": status,
    "stage": stage,
    "oldReleaseVersion": old_version,
    "oldImage": old_image,
    "oldImageId": old_image_id,
    "oldGitSha": old_git,
    "oldReleaseChecksumSha256": old_release_sha,
    "newReleaseVersion": new_version,
    "newImage": new_image,
    "newImageId": new_image_id,
    "newGitSha": new_git,
    "newReleaseChecksumSha256": new_release_sha,
    "workerContainerSnapshotSha256": worker_container_sha,
    "workerRuntimeSha256": worker_runtime_sha,
    "oldListenerContainerSnapshotSha256": old_listener_container_sha,
    "oldListenerRuntimeSha256": old_listener_runtime_sha,
    "newListenerRuntimeBeforeSha256": new_listener_runtime_before,
    "newListenerRuntimeAfterSha256": None if new_runtime_after == "unknown" else new_runtime_after,
    "providerSnapshotBridgeEnabled": True,
    "personalExtensions": ["20", "21", "22", "23"],
    "preservedJobs": ["telephony.viptel.reconcile"],
    "workerUnchanged": truth[worker_unchanged],
    "schedulerAndControlsPreserved": truth[scheduler_preserved],
    "activeListenerReleaseVersion": None if active_version == "unknown" else active_version,
    "newListenerEnabled": truth[new_enabled],
    "webDeploymentChanged": False,
    "previousRecordSha256": None,
}
flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
if mode == "create":
    descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
elif mode == "append":
    descriptor = os.open(path, os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0))
else:
    raise SystemExit("handover receipt mode is invalid")
with os.fdopen(descriptor, "r+b" if mode == "append" else "wb") as output:
    metadata = os.fstat(output.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("handover receipt is unsafe")
    if mode == "append":
        output.seek(0)
        first_line = output.read()
        if not first_line.endswith(b"\n") or len(first_line.splitlines()) != 1:
            raise SystemExit("handover receipt chain is invalid")
        first = json.loads(first_line)
        if set(first) != set(record):
            raise SystemExit("handover receipt fields changed")
        if not (
            first.get("status") == "in_progress"
            and first.get("stage") == "handover_started"
            and first.get("activeListenerReleaseVersion") == old_version
            and first.get("newListenerEnabled") is False
            and first.get("workerUnchanged") is True
            and first.get("schedulerAndControlsPreserved") is True
            and first.get("previousRecordSha256") is None
        ):
            raise SystemExit("handover receipt initial record is invalid")
        identity = (
            "schema", "oldReleaseVersion", "oldImage", "oldImageId", "oldGitSha",
            "oldReleaseChecksumSha256", "newReleaseVersion", "newImage", "newImageId",
            "newGitSha", "newReleaseChecksumSha256", "workerContainerSnapshotSha256",
            "workerRuntimeSha256", "oldListenerContainerSnapshotSha256",
            "oldListenerRuntimeSha256", "newListenerRuntimeBeforeSha256",
            "providerSnapshotBridgeEnabled", "personalExtensions", "preservedJobs",
            "webDeploymentChanged",
        )
        if any(first.get(key) != record.get(key) for key in identity):
            raise SystemExit("handover receipt identity changed")
        record["previousRecordSha256"] = hashlib.sha256(first_line).hexdigest()
        output.seek(0, os.SEEK_END)
    output.write((json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    output.flush()
    os.fsync(output.fileno())
PY
}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_path="$operation_root/viptel-listener-handover-${old_version}-to-${new_version}-${timestamp}-$$.jsonl"
write_receipt create in_progress handover_started "$old_version" false true true \
  "$new_listener_runtime_before_sha256"

rollback_armed=true
listener_touched=false
active_new_listener_runtime_sha256=unknown

rollback() {
  set +e
  local flags_ok=false
  local listener_ok=false
  local worker_ok=false
  local controls_ok=false
  local releases_ok=false
  local runtimes_ok=false
  local state_ok=false
  local new_runtime_after=unknown
  if verify_checksum_bindings_without_helpers \
    && verify_release_bindings >/dev/null 2>&1; then
    releases_ok=true
  fi
  if [[ "$releases_ok" == true ]] \
    && python3 "$validator" verify-handover-old-runtime "$old_release_dir" "$old_version" \
      --expected-worker-sha256 "$worker_runtime_sha256" \
      --expected-listener-sha256 "$old_listener_runtime_sha256" >/dev/null 2>&1; then
    runtimes_ok=true
  fi
  if [[ "$releases_ok" == true ]] \
    && python3 "$validator" set-handover-listener-flags "$new_release_dir" "$new_version" \
    --enabled false --force-disable >/dev/null 2>&1; then
    flags_ok=true
    new_runtime_after=$(sha256sum "$new_listener_runtime" 2>/dev/null | awk '{print $1}')
  fi
  if [[ "$listener_touched" == true ]]; then
    if [[ "$releases_ok" == true && "$runtimes_ok" == true ]] \
      && start_listener_from "$old_release_dir" "$old_image_id" >/dev/null 2>&1 \
      && verify_service "$service" "$old_image_id" "$old_listener_runtime"; then
      listener_ok=true
    fi
  elif verify_old_listener_exact; then
    listener_ok=true
  fi
  if verify_worker_unchanged; then worker_ok=true; fi
  if verify_preserved_control_state >/dev/null 2>&1; then controls_ok=true; fi
  if python3 "$validator" handover-state "$old_release_dir" "$old_version" \
    --worker-version "$old_version" \
    --listener-version "$old_version" \
    --jobs "$preserved_jobs" \
    --wait-seconds 120 >/dev/null 2>&1; then
    state_ok=true
  fi
  if [[ "$flags_ok" == true && "$listener_ok" == true && "$worker_ok" == true \
    && "$controls_ok" == true && "$releases_ok" == true && "$runtimes_ok" == true \
    && "$state_ok" == true ]]; then
    write_receipt append failure rollback_complete "$old_version" false true true \
      "$new_runtime_after" || true
  else
    echo "VIPTel listener handover rollback is incomplete; manual intervention is required" >&2
    write_receipt append failure rollback_incomplete unknown unknown unknown unknown \
      "$new_runtime_after" || true
  fi
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$rollback_armed" == true ]]; then rollback; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Final compare-and-swap checks immediately before the only service mutation.
verify_release_bindings
verify_worker_unchanged
verify_old_listener_exact
verify_runtime_bindings
verify_preserved_control_state
python3 "$validator" handover-state "$old_release_dir" "$old_version" \
  --worker-version "$old_version" \
  --listener-version "$old_version" \
  --jobs "$preserved_jobs" \
  --wait-seconds 0

active_new_listener_runtime_sha256=$(
  python3 "$validator" set-handover-listener-flags "$new_release_dir" "$new_version" \
    --enabled true \
    --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
    --output hash
)
[[ "$active_new_listener_runtime_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "New VIPTel listener runtime binding is invalid" >&2
  exit 1
}
python3 "$validator" verify-handover-new-runtime "$new_release_dir" "$new_version" \
  --expected-listener-sha256 "$active_new_listener_runtime_sha256" \
  --enabled true
verify_worker_unchanged
verify_preserved_control_state

listener_touched=true
start_listener_from "$new_release_dir" "$new_image_id"
verify_service "$service" "$new_image_id" "$new_listener_runtime" || {
  echo "New VIPTel listener does not use the exact candidate image and runtime" >&2
  exit 1
}
verify_worker_unchanged || {
  echo "Worker changed during VIPTel listener handover" >&2
  exit 1
}
[[ "$(sha256sum "$old_listener_runtime" | awk '{print $1}')" == "$old_listener_runtime_sha256" ]] || {
  echo "Old VIPTel runtime changed during handover" >&2
  exit 1
}
verify_preserved_control_state
python3 "$validator" handover-state "$old_release_dir" "$old_version" \
  --worker-version "$old_version" \
  --listener-version "$new_version" \
  --jobs "$preserved_jobs" \
  --wait-seconds 120

# Recheck every preserved boundary immediately before recording success.
verify_release_bindings
verify_service "$service" "$new_image_id" "$new_listener_runtime"
verify_worker_unchanged
[[ "$(sha256sum "$old_listener_runtime" | awk '{print $1}')" == "$old_listener_runtime_sha256" ]]
python3 "$validator" verify-handover-new-runtime "$new_release_dir" "$new_version" \
  --expected-listener-sha256 "$active_new_listener_runtime_sha256" \
  --enabled true
verify_preserved_control_state
python3 "$validator" handover-state "$old_release_dir" "$old_version" \
  --worker-version "$old_version" \
  --listener-version "$new_version" \
  --jobs "$preserved_jobs" \
  --wait-seconds 0

write_receipt append success handover_complete "$new_version" true true true \
  "$active_new_listener_runtime_sha256"
rollback_armed=false
trap - EXIT INT TERM
echo "VIPTel listener handover completed; the exact worker, scheduler, reconciliation control, and web deployment were preserved."
