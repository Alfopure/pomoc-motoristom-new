#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
release_root="/opt/motorist/releases"
compose_project="motorist-dispatch"
service="viptel_listener"
preserved_jobs="telephony.viptel.reconcile"
operation_args=("$@")

usage() {
  echo "usage: upgrade-viptel-listener-only.sh WORKER_RELEASE_DIR OLD_LISTENER_RELEASE_DIR NEW_LISTENER_RELEASE_DIR EXPECTED_WORKER_GIT_SHA EXPECTED_OLD_LISTENER_GIT_SHA EXPECTED_PRODUCTION_GIT_SHA" >&2
  exit 2
}

[[ "$#" -eq 6 ]] || usage
worker_release_dir=$(cd -- "$1" && pwd -P)
old_listener_release_dir=$(cd -- "$2" && pwd -P)
new_listener_release_dir=$(cd -- "$3" && pwd -P)
expected_worker_git_sha=$4
expected_old_listener_git_sha=$5
expected_new_listener_git_sha=$6
for expected_git_sha in \
  "$expected_worker_git_sha" \
  "$expected_old_listener_git_sha" \
  "$expected_new_listener_git_sha"; do
  [[ "$expected_git_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "A VIPTel listener upgrade Git SHA is invalid" >&2
    exit 2
  }
done
[[ "$script_dir" == "$new_listener_release_dir/bin" ]] || {
  echo "VIPTel listener upgrade must run from the selected new listener release" >&2
  exit 1
}
[[ "$worker_release_dir" != "$old_listener_release_dir" \
  && "$worker_release_dir" != "$new_listener_release_dir" \
  && "$old_listener_release_dir" != "$new_listener_release_dir" ]] || {
  echo "VIPTel listener upgrade requires three distinct release directories" >&2
  exit 1
}
[[ -x "$validator" && -x "$operation_lock_helper" ]] || {
  echo "VIPTel listener upgrade security helper is missing" >&2
  exit 1
}
for command_name in docker python3 sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

release_fields_output=$(python3 - \
  "$worker_release_dir/manifest.json" "$expected_worker_git_sha" \
  "$old_listener_release_dir/manifest.json" "$expected_old_listener_git_sha" \
  "$new_listener_release_dir/manifest.json" "$expected_new_listener_git_sha" <<'PY'
import json
import re
import sys

pattern = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
arguments = sys.argv[1:]
for index in range(0, len(arguments), 2):
    path = arguments[index]
    expected_git_sha = arguments[index + 1]
    with open(path, "r", encoding="utf-8") as source:
        value = json.load(source)
    version = value.get("version")
    image = value.get("image")
    image_id = value.get("imageId")
    if not isinstance(version, str) or pattern.fullmatch(version) is None:
        raise SystemExit("listener upgrade release version is invalid")
    if image != f"motorist-app:{version}":
        raise SystemExit("listener upgrade release image is invalid")
    if not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None:
        raise SystemExit("listener upgrade release image ID is invalid")
    if value.get("gitSha") != expected_git_sha:
        raise SystemExit("listener upgrade release Git SHA mismatch")
    if value.get("platform") != "linux/amd64" or value.get("schedulerEnabled") is not False:
        raise SystemExit("listener upgrade release execution contract is unsafe")
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
[[ "${#release_fields[@]}" -eq 12 ]] || {
  echo "VIPTel listener upgrade release output is invalid" >&2
  exit 1
}
worker_version=${release_fields[0]}
worker_image=${release_fields[1]}
worker_image_id=${release_fields[2]}
worker_git_sha=${release_fields[3]}
old_listener_version=${release_fields[4]}
old_listener_image=${release_fields[5]}
old_listener_image_id=${release_fields[6]}
old_listener_git_sha=${release_fields[7]}
new_listener_version=${release_fields[8]}
new_listener_image=${release_fields[9]}
new_listener_image_id=${release_fields[10]}
new_listener_git_sha=${release_fields[11]}
[[ "$worker_version" != "$old_listener_version" \
  && "$worker_version" != "$new_listener_version" \
  && "$old_listener_version" != "$new_listener_version" \
  && "$worker_image_id" != "$old_listener_image_id" \
  && "$worker_image_id" != "$new_listener_image_id" \
  && "$old_listener_image_id" != "$new_listener_image_id" ]] || {
  echo "VIPTel listener upgrade requires three distinct release and image identities" >&2
  exit 1
}

[[ -d "$release_root" && ! -L "$release_root" \
  && "$(cd -- "$release_root" && pwd -P)" == "$release_root" ]] || {
  echo "Canonical VIPTel release root is unavailable" >&2
  exit 1
}
verify_release_location() {
  local selected_release=$1
  local selected_version=$2
  [[ -d "$selected_release" && ! -L "$selected_release" \
    && "${selected_release%/*}" == "$release_root" \
    && "${selected_release##*/}" == "$selected_version" \
    && "$(cd -- "$selected_release" && pwd -P)" == "$selected_release" ]]
}
verify_release_location "$worker_release_dir" "$worker_version" \
  && verify_release_location "$old_listener_release_dir" "$old_listener_version" \
  && verify_release_location "$new_listener_release_dir" "$new_listener_version" || {
  echo "VIPTel listener upgrade releases must be canonical version-named children of the release root" >&2
  exit 1
}

worker_release_sha256=$(sha256sum "$worker_release_dir/SHA256SUMS" | awk '{print $1}')
old_listener_release_sha256=$(sha256sum "$old_listener_release_dir/SHA256SUMS" | awk '{print $1}')
new_listener_release_sha256=$(sha256sum "$new_listener_release_dir/SHA256SUMS" | awk '{print $1}')
for release_sha256 in \
  "$worker_release_sha256" \
  "$old_listener_release_sha256" \
  "$new_listener_release_sha256"; do
  [[ "$release_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "VIPTel listener upgrade checksum binding is invalid" >&2
    exit 1
  }
done

verify_release_bindings() {
  python3 "$validator" verify-handover-release "$worker_release_dir" "$worker_version" \
    --expected-git-sha "$worker_git_sha" \
    --expected-release-sha256 "$worker_release_sha256"
  python3 "$validator" verify-handover-release "$old_listener_release_dir" "$old_listener_version" \
    --expected-git-sha "$old_listener_git_sha" \
    --expected-release-sha256 "$old_listener_release_sha256"
  python3 "$validator" verify-listener-release "$new_listener_release_dir" "$new_listener_version" \
    --expected-git-sha "$new_listener_git_sha" \
    --expected-release-sha256 "$new_listener_release_sha256"
}

verify_checksum_binding_without_helpers() {
  local selected_release=$1
  local expected_release_sha256=$2
  [[ "$(sha256sum "$selected_release/SHA256SUMS" 2>/dev/null | awk '{print $1}')" \
    == "$expected_release_sha256" ]] \
    && (cd "$selected_release" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
}

verify_checksum_bindings_without_helpers() {
  verify_checksum_binding_without_helpers "$worker_release_dir" "$worker_release_sha256" \
    && verify_checksum_binding_without_helpers \
      "$old_listener_release_dir" "$old_listener_release_sha256" \
    && verify_checksum_binding_without_helpers \
      "$new_listener_release_dir" "$new_listener_release_sha256"
}

# Bind every immutable release before executing another bundled helper.
verify_release_bindings
python3 "$operation_lock_helper" prepare "$operation_root"
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/upgrade-viptel-listener-only.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"
verify_release_bindings

for image_binding in \
  "$worker_image|$worker_image_id|Exact preserved worker image is unavailable" \
  "$old_listener_image|$old_listener_image_id|Exact old VIPTel listener image is unavailable" \
  "$new_listener_image|$new_listener_image_id|Exact new VIPTel listener image is unavailable"; do
  IFS='|' read -r selected_image selected_image_id error_message <<<"$image_binding"
  [[ "$(docker image inspect --format '{{.Id}}' "$selected_image" 2>/dev/null)" == "$selected_image_id" ]] || {
    echo "$error_message" >&2
    exit 1
  }
done

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
  compose_for "$new_listener_release_dir" "$new_listener_image_id" ps -a -q "$1" 2>/dev/null
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

stop_current_listener() {
  local id
  local running
  id=$(container_id "$service" 2>/dev/null) \
    || id=${active_candidate_container_id:-unknown}
  [[ -n "$id" ]] || return 0
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  timeout 60 docker stop --time 30 "$id" >/dev/null || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
  [[ "$running" == false ]]
}

kill_current_candidate_listener() {
  local id
  local image_id running
  id=$(container_id "$service" 2>/dev/null) \
    || id=${active_candidate_container_id:-unknown}
  [[ -n "$id" ]] || return 0
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  image_id=$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null) || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
  [[ "$image_id" == "$new_listener_image_id" ]] || return 0
  [[ "$running" == true ]] || return 0
  timeout 30 docker kill "$id" >/dev/null || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
  [[ "$running" == false ]]
}

verify_no_running_candidate_listener() {
  local id running image_id
  id=$(container_id "$service" 2>/dev/null) || return 1
  [[ -n "$id" ]] || return 0
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
  image_id=$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null) || return 1
  [[ "$running" != true || "$image_id" != "$new_listener_image_id" ]]
}

contain_candidate_listener() {
  local attempt
  for attempt in 1 2 3; do
    if verify_no_running_candidate_listener; then return 0; fi
    stop_current_listener >/dev/null 2>&1 || true
    if verify_no_running_candidate_listener; then return 0; fi
    kill_current_candidate_listener >/dev/null 2>&1 || true
    if verify_no_running_candidate_listener; then return 0; fi
  done
  return 1
}

utc_boundary() {
  python3 - <<'PY'
import datetime as dt
print(dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"))
PY
}

worker_runtime="$worker_release_dir/env/worker.env"
old_listener_runtime="$old_listener_release_dir/env/viptel-listener.env"
new_listener_runtime="$new_listener_release_dir/env/viptel-listener.env"
worker_container_before=$(container_snapshot worker) || {
  echo "Running preserved worker container could not be captured" >&2
  exit 1
}
old_listener_container_before=$(container_snapshot "$service") || {
  echo "Running old VIPTel listener container could not be captured" >&2
  exit 1
}
worker_container_sha256=$(printf '%s' "$worker_container_before" | sha256sum | awk '{print $1}')
old_listener_container_sha256=$(printf '%s' "$old_listener_container_before" | sha256sum | awk '{print $1}')
worker_runtime_sha256=$(sha256sum "$worker_runtime" | awk '{print $1}')
old_listener_runtime_sha256=$(sha256sum "$old_listener_runtime" | awk '{print $1}')
new_listener_runtime_before_sha256=$(sha256sum "$new_listener_runtime" | awk '{print $1}')
for runtime_binding in \
  "$worker_container_sha256" \
  "$old_listener_container_sha256" \
  "$worker_runtime_sha256" \
  "$old_listener_runtime_sha256" \
  "$new_listener_runtime_before_sha256"; do
  [[ "$runtime_binding" =~ ^[0-9a-f]{64}$ ]] || {
    echo "VIPTel listener upgrade runtime binding is invalid" >&2
    exit 1
  }
done

verify_worker_unchanged() {
  local current
  current=$(container_snapshot worker) || return 1
  [[ "$current" == "$worker_container_before" ]] \
    && verify_service worker "$worker_image_id" "$worker_runtime" \
    && [[ "$(sha256sum "$worker_runtime" 2>/dev/null | awk '{print $1}')" == "$worker_runtime_sha256" ]]
}

verify_old_listener_exact() {
  local current
  current=$(container_snapshot "$service") || return 1
  [[ "$current" == "$old_listener_container_before" ]] \
    && verify_service "$service" "$old_listener_image_id" "$old_listener_runtime"
}

verify_runtime_bindings() {
  python3 "$validator" verify-handover-worker-runtime "$worker_release_dir" "$worker_version" \
    --expected-worker-sha256 "$worker_runtime_sha256"
  python3 "$validator" verify-handover-listener-runtime \
    "$old_listener_release_dir" "$old_listener_version" \
    --expected-listener-sha256 "$old_listener_runtime_sha256" \
    --enabled true
  python3 "$validator" verify-handover-listener-runtime \
    "$new_listener_release_dir" "$new_listener_version" \
    --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
    --enabled false
}

verify_handover_state() {
  local expected_listener_version=$1
  local wait_seconds=$2
  local listener_not_before=${3:-}
  local state_arguments=(
    handover-state "$worker_release_dir" "$worker_version"
    --worker-version "$worker_version"
    --listener-version "$expected_listener_version"
    --jobs "$preserved_jobs"
    --wait-seconds "$wait_seconds"
  )
  if [[ -n "$listener_not_before" ]]; then
    state_arguments+=(--listener-not-before-utc "$listener_not_before")
  fi
  python3 "$validator" "${state_arguments[@]}"
}

verify_worker_unchanged || {
  echo "Existing worker does not match the exact preserved worker release" >&2
  exit 1
}
verify_old_listener_exact || {
  echo "Existing VIPTel listener does not match the exact old listener release" >&2
  exit 1
}
verify_runtime_bindings
verify_handover_state "$old_listener_version" 0

write_receipt() {
  local mode=$1
  local status=$2
  local stage=$3
  local active_listener_version=$4
  local new_listener_enabled=$5
  local worker_unchanged=$6
  local scheduler_preserved=$7
  local new_runtime_after=$8
  local new_listener_not_before=$9
  local rollback_listener_not_before=${10}
  python3 - \
    "$receipt_path" "$mode" "$status" "$stage" "$active_listener_version" \
    "$new_listener_enabled" "$worker_unchanged" "$scheduler_preserved" \
    "$new_runtime_after" "$new_listener_not_before" "$rollback_listener_not_before" \
    "$worker_release_dir" "$worker_version" "$worker_image" "$worker_image_id" \
    "$worker_git_sha" "$worker_release_sha256" \
    "$old_listener_release_dir" "$old_listener_version" "$old_listener_image" \
    "$old_listener_image_id" "$old_listener_git_sha" "$old_listener_release_sha256" \
    "$new_listener_release_dir" "$new_listener_version" "$new_listener_image" \
    "$new_listener_image_id" "$new_listener_git_sha" "$new_listener_release_sha256" \
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
    scheduler_preserved, new_runtime_after, new_not_before, rollback_not_before,
    worker_dir, worker_version, worker_image, worker_image_id, worker_git,
    worker_release_sha, old_dir, old_version, old_image, old_image_id, old_git,
    old_release_sha, new_dir, new_version, new_image, new_image_id, new_git,
    new_release_sha, worker_container_sha, worker_runtime_sha,
    old_listener_container_sha, old_listener_runtime_sha, new_runtime_before,
) = sys.argv[1:]

truth = {"true": True, "false": False, "unknown": None}
if new_enabled not in truth or worker_unchanged not in truth or scheduler_preserved not in truth:
    raise SystemExit("listener upgrade receipt truth value is invalid")
if active_version not in (old_version, new_version, "unknown"):
    raise SystemExit("listener upgrade receipt active release is invalid")
for value in (new_runtime_after,):
    if value != "unknown" and re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise SystemExit("listener upgrade receipt runtime binding is invalid")
timestamp_pattern = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z"
)
for value in (new_not_before, rollback_not_before):
    if value != "unknown" and timestamp_pattern.fullmatch(value) is None:
        raise SystemExit("listener upgrade receipt heartbeat boundary is invalid")
allowed = {
    ("create", "in_progress", "upgrade_started", old_version, "false", "true", "true"),
    ("append", "success", "upgrade_complete", new_version, "true", "true", "true"),
    ("append", "failure", "rollback_complete", old_version, "false", "true", "true"),
    ("append", "failure", "rollback_incomplete", "unknown", "unknown", "unknown", "unknown"),
}
transition = (
    mode, status, stage, active_version, new_enabled,
    worker_unchanged, scheduler_preserved,
)
if transition not in allowed:
    raise SystemExit("listener upgrade receipt transition is invalid")
record = {
    "schema": "motorist-viptel-listener-upgrade/v1",
    "recordedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": status,
    "stage": stage,
    "workerReleaseDir": worker_dir,
    "workerReleaseVersion": worker_version,
    "workerImage": worker_image,
    "workerImageId": worker_image_id,
    "workerGitSha": worker_git,
    "workerReleaseChecksumSha256": worker_release_sha,
    "oldListenerReleaseDir": old_dir,
    "oldListenerReleaseVersion": old_version,
    "oldListenerImage": old_image,
    "oldListenerImageId": old_image_id,
    "oldListenerGitSha": old_git,
    "oldListenerReleaseChecksumSha256": old_release_sha,
    "newListenerReleaseDir": new_dir,
    "newListenerReleaseVersion": new_version,
    "newListenerImage": new_image,
    "newListenerImageId": new_image_id,
    "newListenerGitSha": new_git,
    "newListenerReleaseChecksumSha256": new_release_sha,
    "workerContainerSnapshotSha256": worker_container_sha,
    "workerRuntimeSha256": worker_runtime_sha,
    "oldListenerContainerSnapshotSha256": old_listener_container_sha,
    "oldListenerRuntimeSha256": old_listener_runtime_sha,
    "newListenerRuntimeBeforeSha256": new_runtime_before,
    "newListenerRuntimeAfterSha256": None if new_runtime_after == "unknown" else new_runtime_after,
    "newListenerHeartbeatNotBeforeUtc": None if new_not_before == "unknown" else new_not_before,
    "rollbackListenerHeartbeatNotBeforeUtc": (
        None if rollback_not_before == "unknown" else rollback_not_before
    ),
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
    raise SystemExit("listener upgrade receipt mode is invalid")
with os.fdopen(descriptor, "r+b" if mode == "append" else "wb") as output:
    metadata = os.fstat(output.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("listener upgrade receipt is unsafe")
    if mode == "append":
        output.seek(0)
        contents = output.read()
        last_newline = contents.rfind(b"\n")
        if last_newline < 0:
            raise SystemExit("listener upgrade receipt chain is invalid")
        complete_payload = contents[: last_newline + 1]
        trailing_fragment = contents[last_newline + 1 :]
        lines = complete_payload.splitlines(keepends=True)
        if len(lines) not in (1, 2):
            raise SystemExit("listener upgrade receipt chain is invalid")
        first_line = lines[0]
        first = json.loads(first_line)
        if set(first) != set(record):
            raise SystemExit("listener upgrade receipt fields changed")
        if not (
            first.get("status") == "in_progress"
            and first.get("stage") == "upgrade_started"
            and first.get("activeListenerReleaseVersion") == old_version
            and first.get("newListenerEnabled") is False
            and first.get("workerUnchanged") is True
            and first.get("schedulerAndControlsPreserved") is True
            and first.get("newListenerRuntimeAfterSha256") == new_runtime_before
            and first.get("newListenerHeartbeatNotBeforeUtc") is None
            and first.get("rollbackListenerHeartbeatNotBeforeUtc") is None
            and first.get("previousRecordSha256") is None
        ):
            raise SystemExit("listener upgrade receipt initial record is invalid")
        identity = (
            "schema", "workerReleaseDir", "workerReleaseVersion", "workerImage",
            "workerImageId", "workerGitSha", "workerReleaseChecksumSha256",
            "oldListenerReleaseDir", "oldListenerReleaseVersion", "oldListenerImage",
            "oldListenerImageId", "oldListenerGitSha", "oldListenerReleaseChecksumSha256",
            "newListenerReleaseDir", "newListenerReleaseVersion", "newListenerImage",
            "newListenerImageId", "newListenerGitSha", "newListenerReleaseChecksumSha256",
            "workerContainerSnapshotSha256", "workerRuntimeSha256",
            "oldListenerContainerSnapshotSha256", "oldListenerRuntimeSha256",
            "newListenerRuntimeBeforeSha256", "providerSnapshotBridgeEnabled",
            "personalExtensions", "preservedJobs", "webDeploymentChanged",
        )
        if any(first.get(key) != record.get(key) for key in identity):
            raise SystemExit("listener upgrade receipt identity changed")

        if trailing_fragment:
            if status != "failure" or len(lines) != 1:
                raise SystemExit("listener upgrade receipt trailing fragment is unsafe")
            # A failed terminal append may leave bytes after the valid initial
            # line. Only rollback may discard that unparseable fragment.
            output.seek(len(complete_payload))
            output.truncate()
            output.flush()
            os.fsync(output.fileno())

        previous_line = first_line
        if len(lines) == 2:
            if status != "failure":
                raise SystemExit("listener upgrade receipt already has a terminal record")
            success_line = lines[1]
            success = json.loads(success_line)
            if set(success) != set(record):
                raise SystemExit("listener upgrade receipt success fields changed")
            if any(success.get(key) != record.get(key) for key in identity):
                raise SystemExit("listener upgrade receipt success identity changed")
            if not (
                success.get("status") == "success"
                and success.get("stage") == "upgrade_complete"
                and success.get("activeListenerReleaseVersion") == new_version
                and success.get("newListenerEnabled") is True
                and success.get("workerUnchanged") is True
                and success.get("schedulerAndControlsPreserved") is True
                and success.get("newListenerRuntimeAfterSha256") is not None
                and success.get("newListenerHeartbeatNotBeforeUtc") is not None
                and success.get("rollbackListenerHeartbeatNotBeforeUtc") is None
                and success.get("previousRecordSha256")
                == hashlib.sha256(first_line).hexdigest()
            ):
                raise SystemExit("listener upgrade receipt success record is invalid")
            previous_line = success_line

        record["previousRecordSha256"] = hashlib.sha256(previous_line).hexdigest()
        output.seek(0, os.SEEK_END)
    output.write((json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    output.flush()
    os.fsync(output.fileno())
PY
}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_path="$operation_root/viptel-listener-upgrade-${old_listener_version}-to-${new_listener_version}-${timestamp}-$$.jsonl"
write_receipt create in_progress upgrade_started "$old_listener_version" false true true \
  "$new_listener_runtime_before_sha256" unknown unknown

rollback_armed=true
listener_touched=false
active_new_listener_runtime_sha256=unknown
active_candidate_container_id=unknown
new_listener_not_before=unknown
rollback_listener_not_before=unknown

rollback() {
  set +e
  local worker_release_ok=false
  local old_listener_release_ok=false
  local new_listener_release_ok=false
  local old_listener_runtime_ok=false
  local candidate_contained=false
  local containment_flags_ok=false
  local containment_listener_ok=false
  local terminal_releases_ok=false
  local terminal_runtimes_ok=false
  local terminal_flags_ok=false
  local terminal_listener_ok=false
  local terminal_worker_ok=false
  local terminal_state_ok=false
  local new_runtime_after=unknown

  # Stop the live candidate process before relying on on-disk flag changes.
  # The listener reads its activation flags at process startup, so changing the
  # private env file alone cannot contain an already-running candidate.
  if [[ "$listener_touched" == true ]] && contain_candidate_listener; then
    candidate_contained=true
  fi

  # Establish independent containment authorities. A broken preserved-worker
  # inventory must never prevent disabling the exact candidate or restoring
  # an independently exact old listener.
  if verify_checksum_binding_without_helpers \
    "$worker_release_dir" "$worker_release_sha256"; then
    worker_release_ok=true
  fi
  if verify_checksum_binding_without_helpers \
    "$old_listener_release_dir" "$old_listener_release_sha256"; then
    old_listener_release_ok=true
  fi
  if verify_checksum_binding_without_helpers \
    "$new_listener_release_dir" "$new_listener_release_sha256"; then
    new_listener_release_ok=true
  fi
  if [[ "$(sha256sum "$old_listener_runtime" 2>/dev/null | awk '{print $1}')" \
    == "$old_listener_runtime_sha256" ]]; then
    old_listener_runtime_ok=true
  fi

  if [[ "$new_listener_release_ok" == true ]] \
    && new_runtime_after=$(python3 "$validator" set-handover-listener-flags \
      "$new_listener_release_dir" "$new_listener_version" \
      --enabled false --force-disable --output hash 2>/dev/null) \
    && [[ "$new_runtime_after" == "$new_listener_runtime_before_sha256" ]] \
    && python3 "$validator" verify-handover-listener-runtime \
      "$new_listener_release_dir" "$new_listener_version" \
      --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
      --enabled false >/dev/null 2>&1; then
    containment_flags_ok=true
  fi
  if [[ "$listener_touched" == true ]]; then
    if [[ "$candidate_contained" == true ]] \
      && verify_no_running_candidate_listener; then
      rollback_listener_not_before=$(utc_boundary 2>/dev/null) \
        || rollback_listener_not_before=unknown
      if [[ "$old_listener_release_ok" == true && "$old_listener_runtime_ok" == true \
        && "$rollback_listener_not_before" != unknown ]]; then
        if start_listener_from \
          "$old_listener_release_dir" "$old_listener_image_id" >/dev/null 2>&1 \
          && verify_service "$service" "$old_listener_image_id" "$old_listener_runtime"; then
          if [[ "$new_listener_release_ok" == true ]] \
            && verify_handover_state "$old_listener_version" 120 \
              "$rollback_listener_not_before" >/dev/null 2>&1; then
            containment_listener_ok=true
          else
            # A listener can be replaced again while the health wait is in
            # progress. Treat every failed wait as a failed restore and repeat
            # containment; an exact old listener is preserved by the image check.
            containment_listener_ok=false
            if contain_candidate_listener; then
              candidate_contained=true
            else
              candidate_contained=false
            fi
          fi
        else
          # A failed restore may have restarted or recreated the candidate.
          # Re-run bounded stop/kill containment before recording failure.
          if contain_candidate_listener; then
            candidate_contained=true
          else
            candidate_contained=false
          fi
        fi
      fi
    else
      candidate_contained=false
    fi
  elif verify_old_listener_exact; then
    containment_listener_ok=true
    candidate_contained=true
  fi

  # Even an incomplete old-listener restore must never leave the candidate
  # image running. Continue terminal proof only after this containment check.
  if [[ "$listener_touched" == true ]] \
    && ! verify_no_running_candidate_listener; then
    candidate_contained=false
  fi

  # Terminal proof is deliberately repeated after the potentially 120-second
  # rollback health wait. Containment alone is never enough to claim success.
  if verify_checksum_bindings_without_helpers \
    && verify_release_bindings >/dev/null 2>&1; then
    terminal_releases_ok=true
  fi
  if [[ "$worker_release_ok" == true && "$old_listener_release_ok" == true \
    && "$new_listener_release_ok" == true ]] \
    && python3 "$validator" verify-handover-worker-runtime \
      "$worker_release_dir" "$worker_version" \
      --expected-worker-sha256 "$worker_runtime_sha256" >/dev/null 2>&1 \
    && python3 "$validator" verify-handover-listener-runtime \
      "$old_listener_release_dir" "$old_listener_version" \
      --expected-listener-sha256 "$old_listener_runtime_sha256" \
      --enabled true >/dev/null 2>&1 \
    && python3 "$validator" verify-handover-listener-runtime \
      "$new_listener_release_dir" "$new_listener_version" \
      --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
      --enabled false >/dev/null 2>&1; then
    terminal_runtimes_ok=true
  fi
  new_runtime_after=$(sha256sum "$new_listener_runtime" 2>/dev/null | awk '{print $1}') \
    || new_runtime_after=unknown
  [[ "$new_runtime_after" =~ ^[0-9a-f]{64}$ ]] || new_runtime_after=unknown
  if [[ "$containment_flags_ok" == true \
    && "$new_runtime_after" == "$new_listener_runtime_before_sha256" ]]; then
    terminal_flags_ok=true
  fi
  if [[ "$containment_listener_ok" == true ]]; then
    if [[ "$listener_touched" == true ]] \
      && verify_service "$service" "$old_listener_image_id" "$old_listener_runtime"; then
      terminal_listener_ok=true
    elif [[ "$listener_touched" == false ]] && verify_old_listener_exact; then
      terminal_listener_ok=true
    fi
  fi
  if verify_worker_unchanged; then terminal_worker_ok=true; fi
  if [[ "$new_listener_release_ok" == true ]]; then
    if [[ "$listener_touched" == true && "$rollback_listener_not_before" != unknown ]] \
      && verify_handover_state "$old_listener_version" 0 \
        "$rollback_listener_not_before" >/dev/null 2>&1; then
      terminal_state_ok=true
    elif [[ "$listener_touched" == false ]] \
      && verify_handover_state "$old_listener_version" 0 >/dev/null 2>&1; then
      terminal_state_ok=true
    fi
  fi

  if [[ "$candidate_contained" == true \
    && "$terminal_releases_ok" == true && "$terminal_runtimes_ok" == true \
    && "$terminal_flags_ok" == true && "$terminal_listener_ok" == true \
    && "$terminal_worker_ok" == true && "$terminal_state_ok" == true ]]; then
    write_receipt append failure rollback_complete "$old_listener_version" false true true \
      "$new_runtime_after" "$new_listener_not_before" "$rollback_listener_not_before" || true
  else
    echo "VIPTel listener upgrade rollback is incomplete; manual intervention is required" >&2
    write_receipt append failure rollback_incomplete unknown unknown unknown unknown \
      "$new_runtime_after" "$new_listener_not_before" "$rollback_listener_not_before" || true
  fi
}

finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 && "$rollback_armed" == true ]]; then rollback; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Final compare-and-swap checks immediately before the only service mutation.
verify_release_bindings
verify_worker_unchanged
verify_old_listener_exact
verify_runtime_bindings
verify_handover_state "$old_listener_version" 0

active_new_listener_runtime_sha256=$(
  python3 "$validator" set-handover-listener-flags \
    "$new_listener_release_dir" "$new_listener_version" \
    --enabled true \
    --expected-listener-sha256 "$new_listener_runtime_before_sha256" \
    --output hash
)
[[ "$active_new_listener_runtime_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "New VIPTel listener runtime binding is invalid" >&2
  exit 1
}
python3 "$validator" verify-handover-listener-runtime \
  "$new_listener_release_dir" "$new_listener_version" \
  --expected-listener-sha256 "$active_new_listener_runtime_sha256" \
  --enabled true
verify_worker_unchanged
verify_old_listener_exact
verify_handover_state "$old_listener_version" 0

new_listener_not_before=$(utc_boundary)
[[ "$new_listener_not_before" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$ ]] || {
  echo "New VIPTel listener heartbeat boundary is invalid" >&2
  exit 1
}
listener_touched=true
start_listener_from "$new_listener_release_dir" "$new_listener_image_id"
verify_service "$service" "$new_listener_image_id" "$new_listener_runtime" || {
  echo "New VIPTel listener does not use the exact candidate image and runtime" >&2
  exit 1
}
active_candidate_container_id=$(container_id "$service")
[[ "$active_candidate_container_id" =~ ^[0-9a-f]{12,64}$ ]] || {
  echo "New VIPTel listener container identity is invalid" >&2
  exit 1
}
verify_worker_unchanged || {
  echo "Worker changed during VIPTel listener upgrade" >&2
  exit 1
}
[[ "$(sha256sum "$old_listener_runtime" | awk '{print $1}')" == "$old_listener_runtime_sha256" ]] || {
  echo "Old VIPTel listener runtime changed during upgrade" >&2
  exit 1
}
verify_handover_state "$new_listener_version" 120 "$new_listener_not_before"

# Recheck every preserved boundary immediately before recording success.
verify_release_bindings
verify_service "$service" "$new_listener_image_id" "$new_listener_runtime"
verify_worker_unchanged
[[ "$(sha256sum "$old_listener_runtime" | awk '{print $1}')" == "$old_listener_runtime_sha256" ]]
python3 "$validator" verify-handover-listener-runtime \
  "$new_listener_release_dir" "$new_listener_version" \
  --expected-listener-sha256 "$active_new_listener_runtime_sha256" \
  --enabled true
verify_handover_state "$new_listener_version" 0 "$new_listener_not_before"

# Ignore operator interrupts only across the tiny durable-commit/disarm window.
# EXIT remains armed, so a receipt write failure still performs full rollback.
trap '' HUP INT TERM
write_receipt append success upgrade_complete "$new_listener_version" true true true \
  "$active_new_listener_runtime_sha256" "$new_listener_not_before" unknown
rollback_armed=false
trap - EXIT HUP INT TERM
echo "VIPTel listener upgrade completed; the exact worker, scheduler, reconciliation control, and web deployment were preserved."
