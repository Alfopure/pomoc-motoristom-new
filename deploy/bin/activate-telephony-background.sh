#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
job="telephony.viptel.reconcile"
services=(worker viptel_listener)
operation_args=("$@")

usage() {
  echo "usage: activate-telephony-background.sh RELEASE_DIR" >&2
  exit 2
}

[[ "$#" -eq 1 ]] || usage
release_dir=$(cd -- "$1" && pwd -P)
[[ "$script_dir" == "$release_dir/bin" ]] || {
  echo "Background activation must run from the selected release" >&2
  exit 1
}
[[ -x "$validator" ]] || { echo "Activation validator is missing" >&2; exit 1; }
[[ -x "$operation_lock_helper" ]] || { echo "Operation-lock helper is missing" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }

(cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "Background release checksum validation failed" >&2
  exit 1
}

python3 "$operation_lock_helper" prepare "$operation_root"
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/activate-telephony-background.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"

mapfile -t manifest < <(python3 - "$release_dir/manifest.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as source:
    value = json.load(source)
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
if not isinstance(git_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", git_sha):
    raise SystemExit("release git SHA is invalid")
print(version)
print(image)
print(image_id)
print(git_sha)
PY
)
[[ "${#manifest[@]}" -eq 4 ]] || { echo "Release manifest output is invalid" >&2; exit 1; }
version=${manifest[0]}
image=${manifest[1]}
image_id=${manifest[2]}
git_sha=${manifest[3]}

actual_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || {
  echo "Background release image is not loaded" >&2
  exit 1
}
[[ "$actual_image_id" == "$image_id" ]] || {
  echo "Background release image ID mismatch" >&2
  exit 1
}

compose_command() {
  (
    cd "$release_dir" || exit 1
    export WEB_BLUE_IMAGE="$image_id"
    export WEB_GREEN_IMAGE="$image_id"
    export WORKER_IMAGE="$image_id"
    export VIPTEL_LISTENER_IMAGE="$image_id"
    docker compose -f compose.yml "$@"
  )
}

verify_service_image() {
  local service=$1
  local container_id actual_id running
  container_id=$(compose_command ps -q "$service" 2>/dev/null) || return 1
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  actual_id=$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null) || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null) || return 1
  [[ "$actual_id" == "$image_id" && "$running" == true ]]
}

verify_services_stopped() {
  local service container_id running
  for service in "${services[@]}"; do
    container_id=$(compose_command ps -a -q "$service" 2>/dev/null) || return 1
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null) || return 1
    [[ "$running" == false ]] || return 1
  done
}

stop_services() {
  (
    cd "$release_dir" || exit 1
    export WEB_BLUE_IMAGE="$image_id"
    export WEB_GREEN_IMAGE="$image_id"
    export WORKER_IMAGE="$image_id"
    export VIPTEL_LISTENER_IMAGE="$image_id"
    timeout 90 docker compose -f compose.yml stop "${services[@]}"
  )
}

write_receipt() {
  local mode=$1
  local status=$2
  local stage=$3
  python3 - "$receipt_path" "$mode" "$status" "$stage" \
    "$version" "$image" "$image_id" "$git_sha" "$release_checksum_sha256" <<'PY'
import datetime as dt
import hashlib
import json
import os
import stat
import sys

path, mode, status, stage, version, image, image_id, git_sha, release_sha = sys.argv[1:]
record = {
    "schema": "motorist-telephony-background-activation/v1",
    "recordedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": status,
    "stage": stage,
    "releaseVersion": version,
    "image": image,
    "imageId": image_id,
    "gitSha": git_sha,
    "releaseChecksumSha256": release_sha,
    "jobs": ["telephony.viptel.reconcile"],
    "viptelListenerEnabled": True,
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
        raise SystemExit("activation receipt is unsafe")
    if mode == "append":
        output.seek(0)
        first_line = output.read()
        if not first_line.endswith(b"\n") or len(first_line.splitlines()) != 1:
            raise SystemExit("activation receipt chain is invalid")
        record["previousRecordSha256"] = hashlib.sha256(first_line).hexdigest()
        output.seek(0, os.SEEK_END)
    output.write((json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    output.flush()
    os.fsync(output.fileno())
PY
}

for service in "${services[@]}"; do
  existing_id=$(compose_command ps -a -q "$service" 2>/dev/null || true)
  if [[ -n "$existing_id" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$existing_id")" == true ]]; then
    echo "A telephony background service is already running; refusing an unreviewed replacement" >&2
    exit 1
  fi
done

python3 "$validator" controls-state "$release_dir" "$version" --jobs ""
worker_env_sha256=$(sha256sum "$release_dir/env/worker.env" | awk '{print $1}')
listener_env_sha256=$(sha256sum "$release_dir/env/viptel-listener.env" | awk '{print $1}')
release_checksum_sha256=$(sha256sum "$release_dir/SHA256SUMS" | awk '{print $1}')
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_path="$operation_root/telephony-background-${version}-${timestamp}-$$.jsonl"
write_receipt create in_progress activation_started

rollback_armed=true
rollback() {
  set +e
  local controls_ok=false
  local flags_ok=false
  local stop_ok=false
  local stopped_ok=false
  local rollback_stage=rollback_incomplete
  if python3 "$validator" set-controls "$release_dir" "$version" \
    --jobs "$job" --mode disable >/dev/null 2>&1; then
    controls_ok=true
  fi
  if python3 "$validator" set-flags "$release_dir" "$version" \
    --scheduler false --listener false --force-disable >/dev/null 2>&1; then
    flags_ok=true
  fi
  if stop_services >/dev/null 2>&1; then
    stop_ok=true
  fi
  if verify_services_stopped; then
    stopped_ok=true
  fi
  if [[ "$controls_ok" == true && "$flags_ok" == true && "$stop_ok" == true && "$stopped_ok" == true ]]; then
    rollback_stage=rollback_complete
  else
    echo "Telephony background rollback is incomplete; manual intervention is required" >&2
  fi
  write_receipt append failure "$rollback_stage" || true
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

mapfile -t active_runtime_hashes < <(
  python3 "$validator" set-flags "$release_dir" "$version" \
    --scheduler true --listener true \
    --expected-worker-sha256 "$worker_env_sha256" \
    --expected-listener-sha256 "$listener_env_sha256" \
    --output lines
)
[[ "${#active_runtime_hashes[@]}" -eq 2 ]] || {
  echo "Runtime flag update did not return exact fingerprints" >&2
  exit 1
}
active_worker_env_sha256=${active_runtime_hashes[0]}
active_listener_env_sha256=${active_runtime_hashes[1]}
python3 "$validator" verify-runtime "$release_dir" "$version" \
  --expected-worker-sha256 "$active_worker_env_sha256" \
  --expected-listener-sha256 "$active_listener_env_sha256"

(
  cd "$release_dir"
  export WEB_BLUE_IMAGE="$image_id"
  export WEB_GREEN_IMAGE="$image_id"
  export WORKER_IMAGE="$image_id"
  export VIPTEL_LISTENER_IMAGE="$image_id"
  timeout 180 docker compose -f compose.yml up \
    -d --no-deps --force-recreate "${services[@]}" >/dev/null
)
for service in "${services[@]}"; do
  verify_service_image "$service" || {
    echo "Activated $service does not use the approved release image" >&2
    exit 1
  }
done

python3 "$validator" live-state "$release_dir" "$version" \
  --jobs "" --phase started --wait-seconds 120 --require-listener
python3 "$validator" set-controls "$release_dir" "$version" \
  --jobs "$job" --mode enable
python3 "$validator" live-state "$release_dir" "$version" \
  --jobs "$job" --phase enabled --wait-seconds 30 --require-listener
python3 "$validator" verify-runtime "$release_dir" "$version" \
  --expected-worker-sha256 "$active_worker_env_sha256" \
  --expected-listener-sha256 "$active_listener_env_sha256"

write_receipt append success activation_complete
rollback_armed=false
trap - EXIT INT TERM
echo "VIPTel listener and telephony reconciliation are active; the web deployment was not changed."
