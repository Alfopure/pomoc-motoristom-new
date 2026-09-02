#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="$script_dir/validate-activation-inputs.py"
capture_helper="$script_dir/capture-private-evidence.py"
operation_lock_helper="$script_dir/open-operation-lock.py"
operation_root="/opt/motorist/receipts"
release_root="/opt/motorist/releases"
compose_project="motorist-dispatch"
operation_args=("$@")

usage() {
  echo "usage: stage-viptel-listener-handover.sh RELEASE_SOURCE_DIR RUNTIME_ENV_DIR EXPECTED_PRODUCTION_GIT_SHA" >&2
  exit 2
}

[[ "$#" -eq 3 ]] || usage
source_release=$(cd -- "$1" && pwd -P)
runtime_source=$(cd -- "$2" && pwd -P)
expected_git_sha=$3
[[ "$expected_git_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Expected production Git SHA is invalid" >&2
  exit 2
}
[[ "$script_dir" == "$source_release/bin" ]] || {
  echo "VIPTel staging must run from the selected source release" >&2
  exit 1
}
[[ -x "$validator" && -x "$capture_helper" && -x "$operation_lock_helper" ]] || {
  echo "VIPTel staging security helper is missing" >&2
  exit 1
}
for command_name in docker python3 sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

manifest_output=$(python3 - "$source_release/manifest.json" "$expected_git_sha" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as source:
    value = json.load(source)
version = value.get("version")
image = value.get("image")
image_id = value.get("imageId")
if not isinstance(version, str) or re.fullmatch(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}", version) is None:
    raise SystemExit("staged release version is invalid")
if image != f"motorist-app:{version}":
    raise SystemExit("staged release image is invalid")
if not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None:
    raise SystemExit("staged release image ID is invalid")
if value.get("gitSha") != sys.argv[2]:
    raise SystemExit("staged release Git SHA mismatch")
if value.get("platform") != "linux/amd64" or value.get("schedulerEnabled") is not False:
    raise SystemExit("staged release execution contract is unsafe")
print(version)
print(image)
print(image_id)
PY
)
mapfile -t manifest <<<"$manifest_output"
[[ "${#manifest[@]}" -eq 3 ]] || {
  echo "VIPTel staging manifest output is invalid" >&2
  exit 1
}
version=${manifest[0]}
image=${manifest[1]}
image_id=${manifest[2]}
source_release_sha256=$(sha256sum "$source_release/SHA256SUMS" | awk '{print $1}')
[[ "$source_release_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "VIPTel staging release binding is invalid" >&2
  exit 1
}

verify_source_release() {
  python3 "$validator" verify-listener-release "$source_release" "$version" \
    --expected-git-sha "$expected_git_sha" \
    --expected-release-sha256 "$source_release_sha256"
}

# Strict inventory validation happens before any other release helper executes.
verify_source_release
python3 "$operation_lock_helper" prepare "$operation_root"
if [[ -z "${MOTORIST_OPERATION_LOCK_FD:-}" ]]; then
  exec python3 "$operation_lock_helper" exec "$operation_root" -- \
    "$script_dir/stage-viptel-listener-handover.sh" "${operation_args[@]}"
fi
python3 "$operation_lock_helper" verify \
  "$operation_root" "${MOTORIST_OPERATION_LOCK_FD:-}"
verify_source_release

[[ -d "$release_root" && ! -L "$release_root" \
  && "$(cd -- "$release_root" && pwd -P)" == "$release_root" ]] || {
  echo "Canonical VIPTel release root is unavailable" >&2
  exit 1
}
destination="$release_root/$version"
[[ ! -e "$destination" && ! -L "$destination" ]] || {
  echo "VIPTel candidate destination already exists" >&2
  exit 1
}

temporary=$(mktemp -d "$release_root/.stage-${version}.XXXXXX")
chmod 0700 "$temporary"
committed=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$committed" == true ]]; then
    if [[ "$destination" == "$release_root/$version" && -d "$destination" && ! -L "$destination" ]]; then
      rm -rf -- "$destination"
    fi
  elif [[ "$temporary" == "$release_root/.stage-${version}."* \
    && -d "$temporary" && ! -L "$temporary" ]]; then
    rm -rf -- "$temporary"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 0700 "$temporary/bin" "$temporary/env"
release_names_output=$(sed -n 's/^[0-9a-f]\{64\}  //p' "$source_release/SHA256SUMS")
mapfile -t release_names <<<"$release_names_output"
[[ "${#release_names[@]}" -gt 0 ]] || {
  echo "VIPTel staging release inventory is empty" >&2
  exit 1
}
for name in "${release_names[@]}"; do
  destination_parent=$(dirname -- "$temporary/$name")
  install -d -m 0700 "$destination_parent"
  python3 "$capture_helper" "$source_release/$name" "$temporary/$name" --allow-public-source
  if [[ "$name" == bin/* ]]; then chmod 0700 "$temporary/$name"; fi
done
python3 "$capture_helper" \
  "$source_release/SHA256SUMS" "$temporary/SHA256SUMS" --allow-public-source

runtime_names=(web.env worker.env viptel-listener.env caddy.env)
declare -A runtime_source_sha256=()
for name in "${runtime_names[@]}"; do
  python3 "$capture_helper" "$runtime_source/$name" "$temporary/env/$name"
  chmod 0600 "$temporary/env/$name"
  runtime_source_sha256[$name]=$(sha256sum "$runtime_source/$name" | awk '{print $1}')
  [[ "${runtime_source_sha256[$name]}" == "$(sha256sum "$temporary/env/$name" | awk '{print $1}')" ]] || {
    echo "VIPTel staged runtime snapshot mismatch" >&2
    exit 1
  }
done

python3 "$validator" verify-listener-release "$temporary" "$version" \
  --expected-git-sha "$expected_git_sha" \
  --expected-release-sha256 "$source_release_sha256"
python3 "$validator" verify-handover-stage-runtime "$temporary" "$version"
for name in "${runtime_names[@]}"; do
  [[ "${runtime_source_sha256[$name]}" == "$(sha256sum "$runtime_source/$name" | awk '{print $1}')" ]] || {
    echo "VIPTel runtime source changed while it was staged" >&2
    exit 1
  }
done
verify_source_release

(
  cd "$temporary"
  export WEB_BLUE_IMAGE="$image_id"
  export WEB_GREEN_IMAGE="$image_id"
  export WORKER_IMAGE="$image_id"
  export VIPTEL_LISTENER_IMAGE="$image_id"
  docker compose --project-name "$compose_project" -f compose.yml config --quiet
)
docker load --input "$temporary/image.tar.gz" >/dev/null
[[ "$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" == "$image_id" ]] || {
  echo "Loaded VIPTel candidate image ID mismatch" >&2
  exit 1
}

verify_source_release
[[ ! -e "$destination" && ! -L "$destination" ]] || {
  echo "VIPTel candidate destination appeared during staging" >&2
  exit 1
}
mv -T -- "$temporary" "$destination"
committed=true
[[ -d "$destination" && ! -L "$destination" \
  && "$(cd -- "$destination" && pwd -P)" == "$destination" ]] || {
  echo "VIPTel staged destination is not canonical" >&2
  exit 1
}
python3 "$validator" verify-listener-release "$destination" "$version" \
  --expected-git-sha "$expected_git_sha" \
  --expected-release-sha256 "$source_release_sha256"
python3 "$validator" verify-handover-stage-runtime "$destination" "$version"
[[ "$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" == "$image_id" ]]

receipt_path="$operation_root/viptel-listener-stage-${version}-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
python3 - \
  "$receipt_path" "$destination" "$version" "$expected_git_sha" "$image" "$image_id" \
  "$source_release_sha256" \
  "${runtime_source_sha256[web.env]}" \
  "${runtime_source_sha256[worker.env]}" \
  "${runtime_source_sha256[viptel-listener.env]}" \
  "${runtime_source_sha256[caddy.env]}" <<'PY'
import datetime as dt
import json
import os
import stat
import sys

(
    path, destination, version, git_sha, image, image_id, release_sha,
    web_sha, worker_sha, listener_sha, caddy_sha,
) = sys.argv[1:]
record = {
    "schema": "motorist-viptel-listener-stage/v1",
    "recordedAtUtc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": "success",
    "destination": destination,
    "releaseVersion": version,
    "gitSha": git_sha,
    "image": image,
    "imageId": image_id,
    "releaseChecksumSha256": release_sha,
    "runtimeSha256": {
        "web": web_sha,
        "worker": worker_sha,
        "listener": listener_sha,
        "caddy": caddy_sha,
    },
    "providerSnapshotBridgeEnabled": True,
    "personalExtensions": ["20", "21", "22", "23"],
    "servicesStarted": [],
    "existingProjectChanged": False,
}
descriptor = os.open(
    path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
with os.fdopen(descriptor, "wb") as output:
    metadata = os.fstat(output.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("VIPTel staging receipt is unsafe")
    output.write((json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    output.flush()
    os.fsync(output.fileno())
PY

committed=false
trap - EXIT INT TERM
echo "VIPTel candidate ${version} is checksum-bound at ${destination}; no Compose service was started or changed."
