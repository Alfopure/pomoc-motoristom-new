#!/usr/bin/env bash
set -euo pipefail

target_ref="sjcsrygkkmersoczpunh"
source_ref="jcwbiulwuwyrnmzjjbgr"
operation_root="/opt/motorist/receipts"
readonly operation_root
operation_args=("$@")

usage() {
  echo "Usage: $0 RELEASE_DIR RUNTIME_ENV_DIR RECEIPT_DIR --acknowledge-real-call-window [--wait-seconds 120..1800]" >&2
  exit 2
}

[[ $# -ge 4 ]] || usage
release_argument=$1
runtime_argument=$2
receipt_argument=$3
shift 3

acknowledged=false
wait_seconds=600
while [[ $# -gt 0 ]]; do
  case "$1" in
    --acknowledge-real-call-window)
      acknowledged=true
      shift
      ;;
    --wait-seconds)
      [[ $# -ge 2 ]] || usage
      wait_seconds=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ "$acknowledged" == true ]] || {
  echo "Real inbound and outbound test-call acknowledgement is required" >&2
  exit 2
}
[[ "$wait_seconds" =~ ^[0-9]+$ ]] && (( wait_seconds >= 120 && wait_seconds <= 1800 )) || {
  echo "Call window must be between 120 and 1800 seconds" >&2
  exit 2
}

for command_name in docker python3 sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
release_dir=$(cd -- "$release_argument" && pwd -P)
runtime_dir=$(cd -- "$runtime_argument" && pwd -P)
[[ "$script_dir" == "$release_dir/bin" ]] || {
  echo "VIPTel probe is not the checksum-bound release copy" >&2
  exit 1
}
[[ -f "$runtime_dir/viptel-listener.env" ]] || {
  echo "VIPTel listener runtime is missing" >&2
  exit 1
}

receipt_writer="$script_dir/write-viptel-listener-receipt.py"
capture_helper="$script_dir/capture-private-evidence.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
[[ -x "$receipt_writer" && -x "$capture_helper" && -x "$operation_lock_helper" ]] || {
  echo "VIPTel release helpers are missing" >&2
  exit 1
}
(cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "VIPTel release checksum validation failed" >&2
  exit 1
}
python3 "$operation_lock_helper" prepare "$operation_root"

requested_receipt_dir=$(python3 - "$receipt_argument" <<'PY'
import os
import sys

print(os.path.abspath(sys.argv[1]))
PY
)
receipt_parent=$(dirname -- "$requested_receipt_dir")
receipt_name=$(basename -- "$requested_receipt_dir")
[[ "$receipt_name" != "." && "$receipt_name" != ".." ]] || {
  echo "VIPTel receipt directory is unsafe" >&2
  exit 1
}
resolved_receipt_parent=$(cd -- "$receipt_parent" && pwd -P)
[[ "$resolved_receipt_parent" == "$receipt_parent" ]] || {
  echo "VIPTel receipt directory must not traverse symlinks" >&2
  exit 1
}
[[ "$resolved_receipt_parent" == "$operation_root" ]] || {
  echo "VIPTel receipt directory must be directly below the operation root" >&2
  exit 1
}
receipt_dir="$resolved_receipt_parent/$receipt_name"
if [[ -e "$receipt_dir" || -L "$receipt_dir" ]]; then
  [[ -d "$receipt_dir" && ! -L "$receipt_dir" ]] || {
    echo "VIPTel receipt directory is unsafe" >&2
    exit 1
  }
else
  mkdir -m 0700 -- "$receipt_dir"
fi
chmod 0700 -- "$receipt_dir"
[[ "$(cd -- "$receipt_dir" && pwd -P)" == "$receipt_dir" ]] || {
  echo "VIPTel receipt directory must not traverse symlinks" >&2
  exit 1
}

if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/probe-viptel-listener.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"

private_dir=$(mktemp -d "$receipt_dir/.viptel-runtime.XXXXXX")
chmod 0700 "$private_dir"
runtime_snapshot="$private_dir/viptel-listener.env"
candidate_runtime="$private_dir/viptel-listener-candidate.env"
python3 "$capture_helper" "$runtime_dir/viptel-listener.env" "$runtime_snapshot"

probe_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
probe_id="motorist-viptel-probe-$(date -u +%Y%m%dT%H%M%SZ)-$$"
receipt_path="$receipt_dir/$(date -u +%Y%m%dT%H%M%SZ)-viptel-listener-$$.json"
receipt_armed=false
receipt_written=false
container_name="motorist-viptel-probe-$$"
container_started=false
connected=false
reconnected=false
inbound_count=0
outbound_count=0
call_window_started_at="-"
call_window_ended_at="-"
version=""
expected_image_id=""
runtime_env_sha256=""

target_state() {
  python3 - "$runtime_snapshot" "$1" "${@:2}" <<'PY'
import datetime as dt
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
ALL_JOBS = {
    "fleet.webdispecink.positions", "fleet.webdispecink.catalog",
    "fleet.commander.positions", "fleet.commander.catalog",
    "fleet.swhouse.occupancy", "fleet.swhouse.roster",
    "notifications.materialize", "telephony.recordings.sync",
    "telephony.transcripts.process", "telephony.viptel.reconcile",
    "infra.hetzner.audit",
}

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def parse_time(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "timestamp has no timezone")
    return parsed.astimezone(dt.timezone.utc)

def load_env(path):
    metadata = os.stat(path, follow_symlinks=False)
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "runtime snapshot is unsafe")
    require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "runtime snapshot is not private")
    with open(path, "r", encoding="utf-8") as source:
        contents = source.read()
    require(contents.endswith("\n") and len(contents) <= 1024 * 1024, "runtime snapshot is incomplete")
    values = {}
    for line in contents.splitlines():
        if not line:
            continue
        require("=" in line, "runtime snapshot line is invalid")
        key, encoded = line.split("=", 1)
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is not None, "runtime key is invalid")
        require(key not in values, "runtime key is duplicated")
        value = json.loads(encoded)
        require(isinstance(value, str), "runtime value is invalid")
        values[key] = value
    require(values.get("SUPABASE_PROJECT_REF") == TARGET_REF, "runtime target mismatch")
    require(values.get("SUPABASE_URL") == TARGET_URL, "runtime target URL mismatch")
    key = values.get("SUPABASE_SECRET_KEY")
    require(key and key == values.get("SUPABASE_SERVICE_ROLE_KEY"), "runtime service key aliases differ")
    return values, key

def request(env, method, table, query, *, headers=None):
    _, key = env
    url = f"{TARGET_URL}/rest/v1/{table}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True, safe=",")
    request_headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(65537)
            require(len(body) <= 65536, "target response is too large")
            return response.status, response.headers, body
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit("target Data API request failed") from error

env = load_env(sys.argv[1])
mode = sys.argv[2]
arguments = sys.argv[3:]

if mode == "controls":
    require(not arguments, "controls arguments are invalid")
    status, _, body = request(env, "GET", "motorist_job_controls", [("select", "job_name,enabled")])
    require(status == 200, "job-control query failed")
    rows = json.loads(body)
    require(isinstance(rows, list), "job-control response is invalid")
    require(len(rows) == len(ALL_JOBS), "job-control count is not exact")
    require({row.get("job_name") for row in rows if isinstance(row, dict)} == ALL_JOBS, "job-control names are not exact")
    require(all(row.get("enabled") is False for row in rows), "a target job is enabled")
elif mode == "quiescent":
    require(len(arguments) == 2 and arguments[1] in ("true", "false"), "quiescent arguments are invalid")
    candidate_id, allow_candidate_value = arguments
    allow_candidate = allow_candidate_value == "true"
    status, _, body = request(
        env,
        "GET",
        "motorist_worker_status",
        [("select", "instance_id,scheduler_status,scheduler_tick_at,viptel_ws_status")],
    )
    require(status == 200, "worker-state query failed")
    rows = json.loads(body)
    require(isinstance(rows, list), "worker-state response is invalid")
    for row in rows:
        require(isinstance(row, dict), "worker-state row is invalid")
        if allow_candidate and row.get("instance_id") == candidate_id:
            require(row.get("scheduler_status") == "listener", "candidate scheduler status is unsafe")
            require(row.get("scheduler_tick_at") is None, "candidate scheduler tick is unsafe")
            require(row.get("viptel_ws_status") in ("connecting", "connected", "reconnecting"), "candidate listener state is unsafe")
            continue
        require(row.get("scheduler_status") not in ("running", "draining"), "another scheduler is active")
        require(row.get("scheduler_tick_at") is None, "another scheduler has a live tick")
        require(row.get("viptel_ws_status") == "disabled", "another VIPTel listener is active")
elif mode == "heartbeat":
    require(len(arguments) == 3, "heartbeat arguments are invalid")
    instance_id, deployment_version, not_before = arguments
    status, _, body = request(
        env,
        "GET",
        "motorist_worker_status",
        [
            ("select", "deployment_version,heartbeat_at,scheduler_status,viptel_ws_status"),
            ("instance_id", f"eq.{instance_id}"),
        ],
    )
    require(status == 200, "heartbeat query failed")
    rows = json.loads(body)
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), "candidate heartbeat is missing")
    row = rows[0]
    require(row.get("deployment_version") == deployment_version, "candidate heartbeat release mismatch")
    require(row.get("scheduler_status") == "listener", "candidate scheduler status is unsafe")
    require(row.get("viptel_ws_status") == "connected", "candidate WebSocket is not connected")
    heartbeat = row.get("heartbeat_at")
    require(isinstance(heartbeat, str), "candidate heartbeat timestamp is missing")
    require(parse_time(heartbeat) >= parse_time(not_before), "candidate heartbeat predates its container start")
    print(heartbeat)
elif mode == "calls":
    require(len(arguments) == 2, "call-count arguments are invalid")
    since, until = arguments
    require(parse_time(since) < parse_time(until), "call-count window is invalid")
    values, _ = env
    organization_slug = values.get("MOTORIST_ORGANIZATION_SLUG")
    require(
        isinstance(organization_slug, str)
        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}[a-z0-9]", organization_slug) is not None,
        "listener organization slug is invalid",
    )

    def bounded_rows(table, query):
        status, headers, body = request(
            env,
            "GET",
            table,
            [*query, ("limit", "1000")],
            headers={"Prefer": "count=exact", "Range": "0-999"},
        )
        require(status in (200, 206), "call-evidence query failed")
        content_range = headers.get("Content-Range", "")
        match = re.fullmatch(r"(?:\*|\d+-\d+)/(\d+)", content_range)
        require(match is not None, "call-evidence response has no exact total")
        total = int(match.group(1))
        require(total < 1000, "call-evidence row bound was reached")
        rows = json.loads(body)
        require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows), "call-evidence response is invalid")
        require(len(rows) == total, "call-evidence response is incomplete")
        return rows

    organizations = bounded_rows(
        "motorist_organizations",
        [
            ("select", "id,slug,active"),
            ("slug", f"eq.{organization_slug}"),
            ("active", "eq.true"),
        ],
    )
    require(
        len(organizations) == 1
        and isinstance(organizations[0].get("id"), str)
        and organizations[0].get("slug") == organization_slug
        and organizations[0].get("active") is True,
        "listener organization is not uniquely active",
    )
    organization_id = organizations[0]["id"]

    events = bounded_rows(
        "motorist_call_events",
        [
            ("select", "call_id,event_type,organization_id"),
            ("organization_id", f"eq.{organization_id}"),
            ("provider", "eq.viptel"),
            ("handled_status", "eq.processed"),
            ("call_id", "not.is.null"),
            ("received_at", f"gte.{since}"),
            ("received_at", f"lte.{until}"),
        ],
    )
    call_lifecycle_events = {
        "call.begin",
        "call.end",
        "call.pickup",
        "call.create_response",
        "queue.join",
        "queue.left",
    }
    websocket_call_ids = {
        row.get("call_id")
        for row in events
        if row.get("organization_id") == organization_id
        and isinstance(row.get("call_id"), str)
        and row.get("event_type") in call_lifecycle_events
    }
    calls = bounded_rows(
        "motorist_calls",
        [
            ("select", "id,direction,status,organization_id"),
            ("organization_id", f"eq.{organization_id}"),
            ("provider", "eq.viptel"),
            ("created_at", f"gte.{since}"),
            ("created_at", f"lte.{until}"),
        ],
    )
    counts = {"inbound": 0, "outbound": 0}
    for row in calls:
        direction = row.get("direction")
        if (
            row.get("organization_id") == organization_id
            and row.get("status") == "ended"
            and direction in counts
            and row.get("id") in websocket_call_ids
        ):
            counts[direction] += 1
    print(counts["inbound"])
    print(counts["outbound"])
elif mode == "cleanup":
    require(len(arguments) == 2, "cleanup arguments are invalid")
    instance_id, deployment_version = arguments
    status, _, body = request(
        env,
        "GET",
        "motorist_worker_status",
        [("select", "deployment_version"), ("instance_id", f"eq.{instance_id}")],
    )
    require(status == 200, "candidate cleanup preflight failed")
    rows = json.loads(body)
    require(isinstance(rows, list) and len(rows) <= 1, "candidate cleanup identity is ambiguous")
    if rows:
        require(rows[0].get("deployment_version") == deployment_version, "candidate cleanup release mismatch")
        status, _, _ = request(
            env,
            "DELETE",
            "motorist_worker_status",
            [("instance_id", f"eq.{instance_id}"), ("deployment_version", f"eq.{deployment_version}")],
            headers={"Prefer": "return=minimal"},
        )
        require(status == 204, "candidate cleanup failed")
else:
    raise SystemExit("unknown target-state operation")
PY
}

cleanup() {
  exit_status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$container_started" == true ]]; then
    timeout 60 docker stop --time 45 "$container_name" >/dev/null 2>&1 || true
    docker rm --force "$container_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$version" ]]; then
    target_state cleanup "$probe_id" "$version" >/dev/null 2>&1 || true
    target_state controls >/dev/null 2>&1 || exit_status=1
    target_state quiescent "$probe_id" false >/dev/null 2>&1 || exit_status=1
  fi
  if [[ "$receipt_armed" == true && "$receipt_written" != true ]]; then
    receipt_window_started_at=$call_window_started_at
    [[ "$call_window_ended_at" != "-" ]] || receipt_window_started_at="-"
    "$receipt_writer" \
      "$receipt_path" "$version" "$expected_image_id" "$runtime_env_sha256" \
      failed "$connected" "$reconnected" "$inbound_count" "$outbound_count" \
      "$probe_started_at" "$receipt_window_started_at" "$call_window_ended_at" >/dev/null 2>&1 || true
  fi
  rm -f -- "$candidate_runtime" "$runtime_snapshot"
  rmdir -- "$private_dir" >/dev/null 2>&1 || true
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

readarray -t validated < <(python3 - \
  "$release_dir/manifest.json" "$runtime_snapshot" "$candidate_runtime" "$probe_id" \
  "$target_ref" "$source_ref" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
import urllib.parse

manifest_path, source_env_path, candidate_env_path, instance_id, target_ref, source_ref = sys.argv[1:]
target_url = f"https://{target_ref}.supabase.co"

def require(condition, message):
    if not condition:
        raise SystemExit(message)

manifest_metadata = os.stat(manifest_path, follow_symlinks=False)
require(stat.S_ISREG(manifest_metadata.st_mode) and manifest_metadata.st_nlink == 1, "release manifest is unsafe")
with open(manifest_path, "r", encoding="utf-8") as source:
    manifest = json.load(source)
version = manifest.get("version")
image = manifest.get("image")
image_id = manifest.get("imageId")
require(isinstance(version, str) and re.fullmatch(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}", version), "release version is invalid")
require(image == f"motorist-app:{version}", "release image mismatch")
require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "release image ID is invalid")
require(manifest.get("platform") == "linux/amd64", "release platform mismatch")
require(manifest.get("schedulerEnabled") is False, "release scheduler contract is unsafe")

env_metadata = os.stat(source_env_path, follow_symlinks=False)
require(stat.S_ISREG(env_metadata.st_mode) and env_metadata.st_nlink == 1, "listener runtime is unsafe")
require(stat.S_IMODE(env_metadata.st_mode) & 0o077 == 0, "listener runtime is not private")
with open(source_env_path, "rb") as source:
    env_bytes = source.read()
require(env_bytes.endswith(b"\n") and len(env_bytes) <= 1024 * 1024, "listener runtime is incomplete")
try:
    env_text = env_bytes.decode("utf-8")
except UnicodeDecodeError as error:
    raise SystemExit("listener runtime is not UTF-8") from error
env = {}
for number, line in enumerate(env_text.splitlines(), 1):
    if not line:
        continue
    require("=" in line, f"listener runtime line {number} is invalid")
    key, encoded = line.split("=", 1)
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is not None, "listener runtime key is invalid")
    require(key not in env, "listener runtime key is duplicated")
    value = json.loads(encoded)
    require(isinstance(value, str) and "\0" not in value, "listener runtime value is invalid")
    env[key] = value

require(env.get("SUPABASE_PROJECT_REF") == target_ref, "listener target ref mismatch")
require(env.get("SUPABASE_URL") == target_url, "listener target URL mismatch")
require(env.get("NEXT_PUBLIC_SUPABASE_URL") == target_url, "listener public target URL mismatch")
require(env.get("DEPLOYMENT_VERSION") == version, "listener release mismatch")
require(env.get("NODE_ENV") == "production", "listener NODE_ENV mismatch")
require(env.get("MOTORIST_DEV_AUTH_BYPASS") == "false", "listener auth bypass is unsafe")
require(env.get("VIPTEL_LISTENER_ENABLED") == "false", "production listener must remain disabled")
require(env.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel", "production listener identity mismatch")
require(not any(key.startswith("SCHEDULER_") for key in env), "listener runtime contains scheduler state")
require(all(source_ref not in value for value in env.values()), "source project ref is present in listener runtime")
require(env.get("SUPABASE_SECRET_KEY") and env.get("SUPABASE_SECRET_KEY") == env.get("SUPABASE_SERVICE_ROLE_KEY"), "listener service key aliases differ")
require(bool(env.get("VIPTEL_USERNAME")) and bool(env.get("VIPTEL_PASSWORD")), "VIPTel credentials are missing")
rest_url = urllib.parse.urlparse(env.get("VIPTEL_REST_BASE_URL", ""))
ws_url = urllib.parse.urlparse(env.get("VIPTEL_WEBSOCKET_URL", ""))
require(rest_url.scheme == "https" and bool(rest_url.netloc), "VIPTel REST URL is invalid")
require(ws_url.scheme == "wss" and bool(ws_url.netloc), "VIPTel WebSocket URL is invalid")

candidate = dict(env)
candidate["VIPTEL_LISTENER_ENABLED"] = "true"
candidate["VIPTEL_LISTENER_INSTANCE_ID"] = instance_id
candidate["VIPTEL_RECONCILE_ON_CONNECT"] = "true"
candidate["VIPTEL_HEALTHCHECKS_PING_URL"] = ""
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(candidate_env_path, flags, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
    metadata = os.fstat(destination.fileno())
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "candidate runtime is unsafe")
    require(stat.S_IMODE(metadata.st_mode) == 0o600, "candidate runtime is not mode 0600")
    for key in sorted(candidate):
        destination.write(f"{key}={json.dumps(candidate[key], ensure_ascii=True)}\n")
    destination.flush()
    os.fsync(destination.fileno())

print(version)
print(image)
print(image_id)
print(hashlib.sha256(env_bytes).hexdigest())
PY
)
[[ "${#validated[@]}" -eq 4 ]] || {
  echo "VIPTel candidate preflight failed" >&2
  exit 1
}
version=${validated[0]}
image=${validated[1]}
expected_image_id=${validated[2]}
runtime_env_sha256=${validated[3]}

target_state controls
target_state quiescent "$probe_id" false
actual_image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$actual_image_id" == "$expected_image_id" ]] || {
  echo "Loaded VIPTel image ID mismatch" >&2
  exit 1
}
receipt_armed=true

docker run --detach --rm \
  --name "$container_name" \
  --label motorist.probe=viptel-listener \
  --platform linux/amd64 \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL \
  --cap-add DAC_OVERRIDE \
  --cap-add SETGID \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --cpus 0.75 \
  --log-driver none \
  --mount "type=bind,source=${candidate_runtime},target=/run/secrets/runtime_env,readonly" \
  "$expected_image_id" node runtime-entrypoint.mjs viptel-listener >/dev/null
container_started=true
[[ "$(docker inspect --format '{{.Image}}' "$container_name")" == "$expected_image_id" ]] || {
  echo "VIPTel candidate container image mismatch" >&2
  exit 1
}

wait_for_connection() {
  not_before=$1
  deadline=$(( $(date +%s) + 90 ))
  while (( $(date +%s) <= deadline )); do
    if heartbeat=$(target_state heartbeat "$probe_id" "$version" "$not_before" 2>/dev/null); then
      [[ -n "$heartbeat" ]] && return 0
    fi
    sleep 2
  done
  return 1
}

first_started_at=$(docker inspect --format '{{.State.StartedAt}}' "$container_name")
wait_for_connection "$first_started_at" || {
  echo "VIPTel candidate did not establish a verified WebSocket connection" >&2
  exit 1
}
connected=true

call_window_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "VIPTel je pripojený. Teraz počas ${wait_seconds} sekúnd urobte 1 reálny prichádzajúci a 1 reálny odchádzajúci testovací hovor."
deadline=$(( $(date +%s) + wait_seconds ))
next_notice=$(( $(date +%s) + 30 ))
while (( $(date +%s) <= deadline )); do
  target_state controls
  target_state quiescent "$probe_id" true
  if (( $(date +%s) >= next_notice )); then
    echo "Testovacie okno stále beží; produkčný listener aj plánovač zostávajú vypnuté."
    next_notice=$(( $(date +%s) + 30 ))
  fi
  sleep 5
done
call_window_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

target_state controls
target_state quiescent "$probe_id" true
timeout 75 docker restart --time 45 "$container_name" >/dev/null || {
  echo "VIPTel candidate restart failed" >&2
  exit 1
}
[[ "$(docker inspect --format '{{.Image}}' "$container_name")" == "$expected_image_id" ]] || {
  echo "Restarted VIPTel candidate image mismatch" >&2
  exit 1
}
second_started_at=$(docker inspect --format '{{.State.StartedAt}}' "$container_name")
[[ "$second_started_at" != "$first_started_at" ]] || {
  echo "VIPTel candidate did not restart" >&2
  exit 1
}
wait_for_connection "$second_started_at" || {
  echo "VIPTel candidate did not reconnect after restart" >&2
  exit 1
}
reconnected=true

reconciliation_deadline=$(( $(date +%s) + 90 ))
while (( $(date +%s) <= reconciliation_deadline )); do
  target_state controls
  target_state quiescent "$probe_id" true
  readarray -t call_counts < <(target_state calls "$call_window_started_at" "$call_window_ended_at")
  [[ "${#call_counts[@]}" -eq 2 ]] || {
    echo "VIPTel call evidence query failed" >&2
    exit 1
  }
  inbound_count=${call_counts[0]}
  outbound_count=${call_counts[1]}
  if (( inbound_count > 0 && outbound_count > 0 )); then
    break
  fi
  sleep 2
done
(( inbound_count > 0 && outbound_count > 0 )) || {
  echo "VIPTel CDR a WebSocket dôkazy nepotvrdili oba reálne smery" >&2
  exit 1
}
target_state controls

timeout 60 docker stop --time 45 "$container_name" >/dev/null
container_started=false
docker rm --force "$container_name" >/dev/null 2>&1 || true
target_state cleanup "$probe_id" "$version"
target_state controls
target_state quiescent "$probe_id" false

"$receipt_writer" \
  "$receipt_path" "$version" "$expected_image_id" "$runtime_env_sha256" \
  success true true "$inbound_count" "$outbound_count" \
  "$probe_started_at" "$call_window_started_at" "$call_window_ended_at"
receipt_written=true
rm -f -- "$candidate_runtime" "$runtime_snapshot"
rmdir -- "$private_dir"
trap - EXIT INT TERM
echo "VIPTel candidate probe prešiel; súkromný receipt: $receipt_path"
