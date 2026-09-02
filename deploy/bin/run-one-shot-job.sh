#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
receipt_writer="$script_dir/write-one-shot-receipt.py"
capture_helper="$script_dir/capture-private-evidence.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
readonly operation_root
target_ref="sjcsrygkkmersoczpunh"
operation_args=("$@")

usage() {
  echo "usage: run-one-shot-job.sh RELEASE_DIR RUNTIME_ENV_DIR RECEIPT_DIR --job JOB [--acknowledge-external-delivery] [--acknowledge-paid-ai]" >&2
  exit 2
}

[[ "$#" -ge 5 ]] || usage
release_dir=$(cd -- "$1" && pwd -P)
runtime_dir=$(cd -- "$2" && pwd -P)
receipt_dir=$3
shift 3
[[ "$1" == "--job" && "$#" -ge 2 ]] || usage
job=$2
shift 2

ack_external=false
ack_paid_ai=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --acknowledge-external-delivery) ack_external=true ;;
    --acknowledge-paid-ai) ack_paid_ai=true ;;
    *) usage ;;
  esac
  shift
done

case "$job" in
  fleet.webdispecink.positions|fleet.webdispecink.catalog|fleet.commander.positions|fleet.commander.catalog|notifications.materialize|telephony.recordings.sync|telephony.transcripts.process|telephony.viptel.reconcile|infra.hetzner.audit) ;;
  *) echo "One-shot job is not allowed" >&2; exit 2 ;;
esac
[[ "$job" != "notifications.materialize" || "$ack_external" == true ]] || {
  echo "Notification test requires --acknowledge-external-delivery" >&2
  exit 2
}
[[ "$job" != "telephony.transcripts.process" || "$ack_paid_ai" == true ]] || {
  echo "Transcript test requires --acknowledge-paid-ai" >&2
  exit 2
}

[[ -x "$receipt_writer" ]] || { echo "One-shot receipt writer is missing" >&2; exit 1; }
[[ -x "$capture_helper" ]] || { echo "Private runtime capture helper is missing" >&2; exit 1; }
[[ -x "$operation_lock_helper" ]] || { echo "Operation-lock helper is missing" >&2; exit 1; }
[[ -f "$release_dir/manifest.json" && -f "$runtime_dir/worker.env" ]] || {
  echo "Release manifest or worker runtime is missing" >&2
  exit 1
}
[[ "$script_dir" == "$release_dir/bin" ]] || {
  echo "One-shot runner is not the checksum-bound release copy" >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
(cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "One-shot release checksum validation failed" >&2
  exit 1
}
python3 "$operation_lock_helper" prepare "$operation_root"

requested_receipt_dir=$(python3 - "$receipt_dir" <<'PY'
import os
import sys

print(os.path.abspath(sys.argv[1]))
PY
)
receipt_parent=$(dirname -- "$requested_receipt_dir")
receipt_name=$(basename -- "$requested_receipt_dir")
[[ "$receipt_name" != "." && "$receipt_name" != ".." ]] || {
  echo "One-shot receipt directory is unsafe" >&2
  exit 1
}
resolved_receipt_parent=$(cd -- "$receipt_parent" && pwd -P)
[[ "$resolved_receipt_parent" == "$receipt_parent" ]] || {
  echo "One-shot receipt directory must not traverse symlinks" >&2
  exit 1
}
[[ "$resolved_receipt_parent" == "$operation_root" ]] || {
  echo "One-shot receipt directory must be directly below the operation root" >&2
  exit 1
}
receipt_dir="$resolved_receipt_parent/$receipt_name"
if [[ -e "$receipt_dir" || -L "$receipt_dir" ]]; then
  [[ -d "$receipt_dir" && ! -L "$receipt_dir" ]] || {
    echo "One-shot receipt directory is unsafe" >&2
    exit 1
  }
else
  mkdir -m 0700 -- "$receipt_dir"
fi
chmod 0700 -- "$receipt_dir"
[[ "$(cd -- "$receipt_dir" && pwd -P)" == "$receipt_dir" ]] || {
  echo "One-shot receipt directory must not traverse symlinks" >&2
  exit 1
}
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/run-one-shot-job.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"

runtime_snapshot_dir=$(mktemp -d "$receipt_dir/.runtime.XXXXXX")
chmod 0700 "$runtime_snapshot_dir"
runtime_snapshot="$runtime_snapshot_dir/worker.env"
result_file=""
container_name=""
receipt_armed=false
receipt_written=false
receipt_path=""
version=""
expected_image_id=""
runtime_env_sha256=""

write_failed_receipt() {
  [[ "$receipt_armed" == true && "$receipt_written" != true ]] || return 0
  python3 - "$result_file" "$job" <<'PY'
import json
import os
import stat
import sys

path, job = sys.argv[1:]
flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(path, flags)
with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
    metadata = os.fstat(destination.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SystemExit("one-shot failure result is unsafe")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise SystemExit("one-shot failure result is not private")
    result = {
        "schema": "motorist-one-shot/v1",
        "ok": False,
        "job": job,
        "status": "failed",
        "summary": {},
    }
    destination.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
    destination.flush()
    os.fsync(destination.fileno())
PY
  python3 "$receipt_writer" \
    "$receipt_path" "$result_file" "$version" "$expected_image_id" "$job" \
    "$runtime_env_sha256"
  receipt_written=true
}

cleanup() {
  exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$container_name" ]]; then
    docker rm --force "$container_name" >/dev/null 2>&1 || true
  fi
  if [[ "$receipt_armed" == true && "$receipt_written" != true ]]; then
    write_failed_receipt >/dev/null 2>&1 || true
  fi
  [[ -z "$result_file" ]] || rm -f -- "$result_file"
  rm -f -- "$runtime_snapshot"
  rmdir -- "$runtime_snapshot_dir" 2>/dev/null || true
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$capture_helper" "$runtime_dir/worker.env" "$runtime_snapshot"

readarray -t validated < <(python3 - "$release_dir/manifest.json" "$runtime_snapshot" "$target_ref" <<'PY'
import json
import hashlib
import os
import re
import stat
import sys

manifest_path, env_path, target_ref = sys.argv[1:]
source_ref = "jcwbiulwuwyrnmzjjbgr"

def require(condition, message):
    if not condition:
        raise SystemExit(message)

for path, expected_public in ((manifest_path, True), (env_path, False)):
    metadata = os.stat(path, follow_symlinks=False)
    require(stat.S_ISREG(metadata.st_mode), f"{path} is not a regular file")
    require(metadata.st_nlink == 1, f"{path} has multiple links")
    if not expected_public:
        require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{path} is not private")

with open(manifest_path, encoding="utf-8") as source:
    manifest = json.load(source)
version = manifest.get("version")
image = manifest.get("image")
image_id = manifest.get("imageId")
require(isinstance(version, str) and re.fullmatch(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}", version), "invalid release version")
require(image == f"motorist-app:{version}", "release image mismatch")
require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "release image ID is invalid")

env = {}
with open(env_path, "rb") as source:
    env_bytes = source.read()
require(len(env_bytes) <= 1024 * 1024, "worker env is too large")
try:
    env_text = env_bytes.decode("utf-8")
except UnicodeDecodeError as error:
    raise SystemExit("worker env is not UTF-8") from error
for number, raw_line in enumerate(env_text.splitlines(keepends=True), 1):
    line = raw_line.rstrip("\n")
    if not line:
        continue
    require("=" in line, f"invalid worker env line {number}")
    key, encoded = line.split("=", 1)
    require(key not in env, "duplicate worker env key")
    value = json.loads(encoded)
    require(isinstance(value, str), "worker env value is not a string")
    env[key] = value
target_url = f"https://{target_ref}.supabase.co"
require(env.get("SUPABASE_PROJECT_REF") == target_ref, "worker target ref mismatch")
require(env.get("SUPABASE_URL") == target_url, "worker target URL mismatch")
require(env.get("NEXT_PUBLIC_SUPABASE_URL") == target_url, "worker public target URL mismatch")
require(env.get("DEPLOYMENT_VERSION") == version, "worker release version mismatch")
require(env.get("SCHEDULER_ENABLED") == "false", "scheduler must remain disabled")
require(all(source_ref not in value for value in env.values()), "source ref is present in worker runtime")
print(version)
print(image)
print(image_id)
print(hashlib.sha256(env_bytes).hexdigest())
PY
)
[[ "${#validated[@]}" -eq 4 ]] || { echo "One-shot preflight failed" >&2; exit 1; }
version=${validated[0]}
image=${validated[1]}
expected_image_id=${validated[2]}
runtime_env_sha256=${validated[3]}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
safe_job=${job//./_}
receipt_path="$receipt_dir/${timestamp}-${safe_job}-$$.json"
result_file=$(mktemp "$receipt_dir/.result.XXXXXX")
container_name="motorist-one-shot-${safe_job//_/-}-$$"
receipt_armed=true

actual_image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$actual_image_id" == "$expected_image_id" ]] || { echo "Loaded image ID mismatch" >&2; exit 1; }

target_is_quiescent() {
  python3 - "$runtime_snapshot" <<'PY'
import datetime as dt
import concurrent.futures
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

TARGET_REF = "sjcsrygkkmersoczpunh"
TARGET_URL = f"https://{TARGET_REF}.supabase.co"
EXPECTED_JOBS = (
    "fleet.webdispecink.positions",
    "fleet.webdispecink.catalog",
    "fleet.commander.positions",
    "fleet.commander.catalog",
    "fleet.swhouse.occupancy",
    "fleet.swhouse.roster",
    "notifications.materialize",
    "telephony.recordings.sync",
    "telephony.transcripts.process",
    "telephony.viptel.reconcile",
    "infra.hetzner.audit",
)
EXPECTED_RUNTIME_IDENTITIES = (
    "motorist-prod-01",
    "motorist-prod-01-viptel",
)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def load_runtime(path):
    metadata = os.stat(path, follow_symlinks=False)
    require(
        stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
        "runtime snapshot is unsafe",
    )
    require(
        stat.S_IMODE(metadata.st_mode) & 0o077 == 0,
        "runtime snapshot is not private",
    )
    with open(path, "r", encoding="utf-8") as source:
        contents = source.read()
    require(
        contents.endswith("\n") and len(contents) <= 1024 * 1024,
        "runtime snapshot is incomplete",
    )
    values = {}
    for line in contents.splitlines():
        if not line:
            continue
        require("=" in line, "runtime snapshot line is invalid")
        key, encoded = line.split("=", 1)
        require(
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is not None,
            "runtime key is invalid",
        )
        require(key not in values, "runtime key is duplicated")
        value = json.loads(encoded)
        require(isinstance(value, str), "runtime value is invalid")
        values[key] = value
    require(values.get("SUPABASE_PROJECT_REF") == TARGET_REF, "runtime target mismatch")
    require(values.get("SUPABASE_URL") == TARGET_URL, "runtime target URL mismatch")
    service_key = values.get("SUPABASE_SECRET_KEY")
    require(
        service_key and service_key == values.get("SUPABASE_SERVICE_ROLE_KEY"),
        "runtime service key aliases differ",
    )
    return service_key


def exact_count(service_key, table, filters=()):
    query = [("select", "id")]
    if table == "motorist_job_controls":
        query = [("select", "job_name")]
    elif table == "motorist_worker_status":
        query = [("select", "instance_id")]
    query.extend(filters)
    url = f"{TARGET_URL}/rest/v1/{table}?" + urllib.parse.urlencode(
        query, doseq=True, safe=",().:*"
    )
    request = urllib.request.Request(
        url,
        method="HEAD",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Accept": "application/json",
            "Prefer": "count=exact",
            "Range": "0-0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            require(response.status in (200, 206), "target aggregate query failed")
            require(not response.read(1), "target aggregate query returned a body")
            content_range = response.headers.get("Content-Range", "")
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise SystemExit("target aggregate query failed") from error
    match = re.fullmatch(r"(?:\*|\d+-\d+)/(\d+)", content_range)
    require(match is not None, "target aggregate query has no exact total")
    return int(match.group(1))


service_key = load_runtime(sys.argv[1])
expected_jobs_filter = "in.(" + ",".join(EXPECTED_JOBS) + ")"
expected_identities_filter = "in.(" + ",".join(EXPECTED_RUNTIME_IDENTITIES) + ")"
fresh_after = (
    dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=90)
).strftime("%Y-%m-%dT%H:%M:%SZ")
checks = (
    ("motorist_job_controls", (), len(EXPECTED_JOBS), "target job-control count is not exact"),
    (
        "motorist_job_controls",
        (("job_name", expected_jobs_filter),),
        len(EXPECTED_JOBS),
        "target job-control names are not exact",
    ),
    ("motorist_job_controls", (("enabled", "eq.true"),), 0, "a target job is enabled"),
    (
        "motorist_worker_status",
        (("instance_id", f"not.{expected_identities_filter}"),),
        0,
        "an unexpected target runtime identity exists",
    ),
    (
        "motorist_worker_status",
        (("instance_id", "eq.motorist-prod-01"), ("scheduler_status", "neq.disabled")),
        0,
        "target worker scheduler state is active or unknown",
    ),
    (
        "motorist_worker_status",
        (("instance_id", "eq.motorist-prod-01-viptel"), ("scheduler_status", "neq.listener")),
        0,
        "target listener scheduler state is unknown",
    ),
    (
        "motorist_worker_status",
        (("scheduler_tick_at", "not.is.null"),),
        0,
        "a target scheduler tick is active",
    ),
    (
        "motorist_worker_status",
        (("viptel_ws_status", "neq.disabled"),),
        0,
        "a target listener is active",
    ),
    (
        "motorist_worker_status",
        (("heartbeat_at", f"gte.{fresh_after}"),),
        0,
        "a target worker or listener runtime has a fresh heartbeat",
    ),
)
with concurrent.futures.ThreadPoolExecutor(max_workers=len(checks)) as executor:
    pending = [
        (executor.submit(exact_count, service_key, table, filters), expected, message)
        for table, filters, expected, message in checks
    ]
    for future, expected, message in pending:
        require(future.result() == expected, message)
PY
}

if ! target_is_quiescent; then
  write_failed_receipt
  echo "One-shot target is not quiescent; private failure receipt was retained" >&2
  exit 1
fi

command=(
  node runtime-entrypoint.mjs one-shot
  --job "$job"
  --expected-project-ref "$target_ref"
  --acknowledge-target-writes
)
[[ "$ack_external" == true ]] && command+=(--acknowledge-external-delivery)
[[ "$ack_paid_ai" == true ]] && command+=(--acknowledge-paid-ai)

set +e
timeout --signal=TERM --kill-after=15s 10m docker run --rm \
  --name "$container_name" \
  --platform linux/amd64 \
  --read-only \
  --tmpfs /tmp:size=128m,mode=1777 \
  --cap-drop ALL \
  --cap-add DAC_OVERRIDE \
  --cap-add SETGID \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --memory 1g \
  --cpus 1.25 \
  --mount "type=bind,source=${runtime_snapshot},target=/run/secrets/runtime_env,readonly" \
  "$expected_image_id" "${command[@]}" >"$result_file" 2>/dev/null
run_status=$?
set -e

if ! target_is_quiescent; then
  write_failed_receipt
  echo "One-shot target changed or became active; private failure receipt was retained" >&2
  exit 1
fi

if [[ "$run_status" -ne 0 && ! -s "$result_file" ]]; then
  write_failed_receipt
  echo "One-shot container failed before producing a safe result" >&2
  exit "$run_status"
fi
python3 "$receipt_writer" \
  "$receipt_path" "$result_file" "$version" "$expected_image_id" "$job" \
  "$runtime_env_sha256"
receipt_written=true
result_ok=$(python3 - "$receipt_path" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    print("true" if json.load(source).get("ok") is True else "false")
PY
)
[[ "$run_status" -eq 0 && "$result_ok" == true ]] || {
  echo "One-shot job did not pass; private receipt was retained" >&2
  [[ "$run_status" -ne 0 ]] && exit "$run_status"
  exit 1
}

cleanup_status=0
trap - EXIT INT TERM
docker rm --force "$container_name" >/dev/null 2>&1 || true
container_name=""
rm -f -- "$result_file" || cleanup_status=1
result_file=""
rm -f -- "$runtime_snapshot" || cleanup_status=1
rmdir -- "$runtime_snapshot_dir" || cleanup_status=1
[[ "$cleanup_status" -eq 0 ]] || {
  echo "One-shot cleanup failed after the immutable receipt was written" >&2
  exit 1
}
echo "One-shot job passed; private receipt: $receipt_path"
