#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
readonly operation_root
operation_args=("$@")

usage() {
  echo "usage: activate-after-cutover.sh PRODUCTION_DIR CUTOVER_RECEIPT ACTIVATION_GATE ONE_SHOT_RECEIPT_DIR --jobs CSV [--enable-viptel-listener]" >&2
  exit 2
}

[[ "$#" -ge 6 ]] || usage
production_dir=$1
cutover_receipt=$2
activation_gate=$3
one_shot_receipt_dir=$4
shift 4

jobs=""
enable_listener=false
jobs_seen=false
approved_jobs="notifications.materialize,fleet.webdispecink.catalog,fleet.webdispecink.positions,fleet.commander.catalog,fleet.commander.positions,telephony.viptel.reconcile,telephony.recordings.sync,telephony.transcripts.process"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --jobs)
      [[ "$jobs_seen" == false && "$#" -ge 2 ]] || usage
      jobs=$2
      jobs_seen=true
      shift 2
      ;;
    --enable-viptel-listener)
      [[ "$enable_listener" == false ]] || usage
      enable_listener=true
      shift
      ;;
    *) usage ;;
  esac
done
[[ "$jobs_seen" == true ]] || usage
[[ "$jobs" == "$approved_jobs" && "$enable_listener" == true ]] || {
  echo "Activation requires the complete pre-approved job set and VIPTel listener in one receipt-bound operation" >&2
  exit 2
}
[[ -x "$validator" ]] || { echo "Activation validator is missing" >&2; exit 1; }
[[ -x "$operation_lock_helper" ]] || { echo "Operation-lock helper is missing" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }

production_dir=$(cd -- "$production_dir" && pwd -P)
[[ "$script_dir" == "$production_dir/bin" ]] || {
  echo "Activation must run from the selected production release" >&2
  exit 1
}
cutover_dir=$(cd -- "$(dirname -- "$cutover_receipt")" && pwd -P)
cutover_receipt="$cutover_dir/$(basename -- "$cutover_receipt")"
[[ "$cutover_dir" == "$operation_root" ]] || {
  echo "Cutover receipt must be stored in the operation root" >&2
  exit 1
}
gate_dir=$(cd -- "$(dirname -- "$activation_gate")" && pwd -P)
activation_gate="$gate_dir/$(basename -- "$activation_gate")"

(cd "$production_dir" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "Activation release checksum validation failed" >&2
  exit 1
}
python3 "$operation_lock_helper" prepare "$operation_root"
requested_receipt_dir=$(python3 - "$one_shot_receipt_dir" <<'PY'
import os
import sys

print(os.path.abspath(sys.argv[1]))
PY
)
receipt_parent=$(dirname -- "$requested_receipt_dir")
receipt_name=$(basename -- "$requested_receipt_dir")
[[ "$receipt_name" != "." && "$receipt_name" != ".." ]] || {
  echo "Activation evidence directory is unsafe" >&2
  exit 1
}
resolved_receipt_parent=$(cd -- "$receipt_parent" && pwd -P)
[[ "$resolved_receipt_parent" == "$receipt_parent" ]] || {
  echo "Activation evidence directory must not traverse symlinks" >&2
  exit 1
}
[[ "$resolved_receipt_parent" == "$operation_root" ]] || {
  echo "Activation evidence directory must be directly below the operation root" >&2
  exit 1
}
one_shot_receipt_dir="$resolved_receipt_parent/$receipt_name"
[[ -d "$one_shot_receipt_dir" && ! -L "$one_shot_receipt_dir" ]] || {
  echo "Activation evidence directory is unsafe" >&2
  exit 1
}
[[ "$(cd -- "$one_shot_receipt_dir" && pwd -P)" == "$one_shot_receipt_dir" ]] || {
  echo "Activation evidence directory must not traverse symlinks" >&2
  exit 1
}
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/activate-after-cutover.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"

validated_output=$(mktemp "$one_shot_receipt_dir/.activation-preflight.XXXXXX")
chmod 0600 "$validated_output"
rollback_armed=false
receipt_path=""
version=""
image=""
image_id=""
cutover_sha256=""
gate_sha256=""
one_shot_bindings_json=""
worker_env_sha256=""
listener_env_sha256=""
active_worker_env_sha256=""
active_listener_env_sha256=""
services=(worker)
[[ "$enable_listener" == true ]] && services+=(viptel_listener)

compose_command() {
  (
    cd "$production_dir" || exit 1
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
    cd "$production_dir" || exit 1
    export WEB_BLUE_IMAGE="$image_id"
    export WEB_GREEN_IMAGE="$image_id"
    export WORKER_IMAGE="$image_id"
    export VIPTEL_LISTENER_IMAGE="$image_id"
    timeout 90 docker compose -f compose.yml stop "${services[@]}"
  )
}

revalidate_activation_gate() {
  python3 "$validator" revalidate-gate \
    "$production_dir" "$version" "$cutover_receipt" "$activation_gate" \
    --activation-script-dir "$script_dir" \
    --expected-cutover-sha256 "$cutover_sha256" \
    --expected-gate-sha256 "$gate_sha256"
}

rollback() {
  set +e
  local disable_all_ok=false
  local flags_ok=false
  local stop_command_ok=false
  local stop_state_ok=false
  local live_zero_ok=false
  local rollback_stage=rollback_incomplete
  for _ in 1 2 3; do
    if python3 "$validator" set-controls \
      "$production_dir" "$version" \
      --jobs "" --mode disable-all >/dev/null 2>&1; then
      disable_all_ok=true
      break
    fi
    sleep 1
  done
  if python3 "$validator" set-flags \
    "$production_dir" "$version" \
    --scheduler false --listener false --force-disable >/dev/null 2>&1; then
    flags_ok=true
  fi
  if stop_services >/dev/null 2>&1; then
    stop_command_ok=true
  fi
  if verify_services_stopped; then
    stop_state_ok=true
  fi
  if python3 "$validator" live-state \
    "$production_dir" "$version" \
    --jobs "" --phase disabled --wait-seconds 0 >/dev/null 2>&1; then
    live_zero_ok=true
  fi
  if [[ "$disable_all_ok" == true \
    && "$flags_ok" == true \
    && "$stop_command_ok" == true \
    && "$stop_state_ok" == true \
    && "$live_zero_ok" == true ]]; then
    rollback_stage=rollback_complete
  else
    echo "Activation rollback is incomplete; manual intervention is required" >&2
  fi
  if [[ -n "$receipt_path" ]]; then
    if ! python3 "$validator" receipt "$receipt_path" \
      --mode append --status failure --stage "$rollback_stage" \
      --release-version "$version" --image "$image" --image-id "$image_id" \
      --jobs "$jobs" --listener "$enable_listener" \
      --cutover-sha256 "$cutover_sha256" --gate-sha256 "$gate_sha256" \
      --one-shot-bindings-json "$one_shot_bindings_json" >/dev/null 2>&1; then
      echo "Activation rollback receipt could not be finalized" >&2
    fi
  fi
}

finish() {
  status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$rollback_armed" == true ]]; then
    rollback
  fi
  rm -f -- "$validated_output"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

preflight_command=(
  python3 "$validator" preflight
  "$production_dir" "$cutover_receipt" "$activation_gate" "$one_shot_receipt_dir"
  --activation-script-dir "$script_dir" --jobs "$jobs" --output lines
)
[[ "$enable_listener" == true ]] && preflight_command+=(--enable-viptel-listener)
"${preflight_command[@]}" >"$validated_output"
mapfile -t validated <"$validated_output"
[[ "${#validated[@]}" -eq 10 ]] || {
  echo "Activation preflight returned an invalid result" >&2
  exit 1
}
version=${validated[0]}
image=${validated[1]}
image_id=${validated[2]}
cutover_sha256=${validated[5]}
gate_sha256=${validated[6]}
one_shot_bindings_json=${validated[7]}
worker_env_sha256=${validated[8]}
listener_env_sha256=${validated[9]}
[[ "${validated[3]}" == "$jobs" && "${validated[4]}" == "$enable_listener" ]] || {
  echo "Activation preflight selection mismatch" >&2
  exit 1
}
rm -f -- "$validated_output"

actual_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || {
  echo "Approved release image is not loaded" >&2
  exit 1
}
[[ "$actual_image_id" == "$image_id" ]] || {
  echo "Approved release image ID mismatch" >&2
  exit 1
}

python3 "$validator" live-state \
  "$production_dir" "$version" \
  --jobs "" --phase disabled --wait-seconds 0

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_path="$cutover_dir/activation-${version}-${timestamp}-$$.jsonl"
python3 "$validator" receipt "$receipt_path" \
  --mode create --status in_progress --stage activation_started \
  --release-version "$version" --image "$image" --image-id "$image_id" \
  --jobs "$jobs" --listener "$enable_listener" \
  --cutover-sha256 "$cutover_sha256" --gate-sha256 "$gate_sha256" \
  --one-shot-bindings-json "$one_shot_bindings_json"
rollback_armed=true

revalidate_activation_gate
mapfile -t active_runtime_hashes < <(
  python3 "$validator" set-flags \
    "$production_dir" "$version" \
    --scheduler true --listener "$enable_listener" \
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
python3 "$validator" verify-runtime \
  "$production_dir" "$version" \
  --expected-worker-sha256 "$active_worker_env_sha256" \
  --expected-listener-sha256 "$active_listener_env_sha256"

(
  cd "$production_dir"
  export WEB_BLUE_IMAGE="$image_id"
  export WEB_GREEN_IMAGE="$image_id"
  export WORKER_IMAGE="$image_id"
  export VIPTEL_LISTENER_IMAGE="$image_id"
  timeout 180 docker compose -f compose.yml up \
    -d --no-deps --force-recreate "${services[@]}" >/dev/null 2>&1
) || {
  echo "Worker activation failed" >&2
  exit 1
}

for service in "${services[@]}"; do
  verify_service_image "$service" || {
    echo "Activated service image ID does not match the approved release" >&2
    exit 1
  }
done

started_args=(
  python3 "$validator" live-state
  "$production_dir" "$version"
  --jobs "" --phase started --wait-seconds 120
)
[[ "$enable_listener" == true ]] && started_args+=(--require-listener)
"${started_args[@]}"

python3 "$validator" verify-runtime \
  "$production_dir" "$version" \
  --expected-worker-sha256 "$active_worker_env_sha256" \
  --expected-listener-sha256 "$active_listener_env_sha256"

if [[ -n "$jobs" ]]; then
  revalidate_activation_gate
  python3 "$validator" set-controls \
    "$production_dir" "$version" \
    --jobs "$jobs" --mode enable
fi

enabled_args=(
  python3 "$validator" live-state
  "$production_dir" "$version"
  --jobs "$jobs" --phase enabled --wait-seconds 30
)
[[ "$enable_listener" == true ]] && enabled_args+=(--require-listener)
"${enabled_args[@]}"

python3 "$validator" receipt "$receipt_path" \
  --mode append --status success --stage activation_complete \
  --release-version "$version" --image "$image" --image-id "$image_id" \
  --jobs "$jobs" --listener "$enable_listener" \
  --cutover-sha256 "$cutover_sha256" --gate-sha256 "$gate_sha256" \
  --one-shot-bindings-json "$one_shot_bindings_json"
rollback_armed=false
trap - EXIT INT TERM
rm -f -- "$validated_output"
echo "Approved jobs are active and the private activation receipt is complete."
