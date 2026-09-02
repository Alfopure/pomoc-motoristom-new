#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "Release builds require a clean tracked and untracked worktree" >&2
  exit 1
fi

build_env_file=${BUILD_ENV_FILE:-.context/secrets/vercel-production.env}
build_overrides_file=${BUILD_OVERRIDES_FILE:-}
version=${DEPLOYMENT_VERSION:-hetzner-$(git rev-parse --short=12 HEAD)}
expected_supabase_project_ref=${EXPECTED_SUPABASE_PROJECT_REF:-}
expected_production_git_sha=${EXPECTED_PRODUCTION_GIT_SHA:-}
if [[ ! "$version" =~ ^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ || "$version" == *..* ]]; then
  echo "DEPLOYMENT_VERSION has an unsafe format" >&2
  exit 1
fi
if [[ -n "$expected_supabase_project_ref" && ! "$expected_supabase_project_ref" =~ ^[a-z0-9]{20}$ ]]; then
  echo "EXPECTED_SUPABASE_PROJECT_REF has an unsafe format" >&2
  exit 1
fi
if [[ ! "$expected_production_git_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXPECTED_PRODUCTION_GIT_SHA is mandatory and must be a full Git SHA" >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$expected_production_git_sha" ]]; then
  echo "Release HEAD does not match EXPECTED_PRODUCTION_GIT_SHA" >&2
  exit 1
fi
readonly expected_supabase_project_ref
readonly expected_production_git_sha
release_dir="deploy/releases/${version}"
image="motorist-app:${version}"
release_bin_names=(
  install-release.sh
  validate-gate-timestamp.py
  write-cutover-receipt.py
  capture-private-evidence.py
  open-operation-lock.py
  run-one-shot-job.sh
  write-one-shot-receipt.py
  activate-after-cutover.sh
  activate-telephony-background.sh
  activate-viptel-listener-only.sh
  handover-viptel-listener-only.sh
  upgrade-viptel-listener-only.sh
  stage-viptel-listener-handover.sh
  prepare-runtime-env.mjs
  runtime-env-contract.mjs
  validate-activation-inputs.py
  create-activation-gate.py
  probe-viptel-listener.sh
  write-viptel-listener-receipt.py
)
release_reserved=false
release_complete=false
build_contract_created=false
build_context_helper="$repo_root/deploy/bin/compute-build-context-sha256.py"
build_input_helper="$repo_root/deploy/bin/build-input-contract.mjs"
[[ -f "$build_context_helper" ]] || { echo "Build context helper is missing" >&2; exit 1; }
[[ -f "$build_input_helper" ]] || { echo "Build input helper is missing" >&2; exit 1; }
build_contract_root="$repo_root/.context/migration/build-input-contracts"
build_contract_path="$build_contract_root/${version}.json"

cleanup_release() {
  if [[ "$release_reserved" == true && "$release_complete" != true ]]; then
    rm -f -- \
      "$release_dir/image.tar.gz" \
      "$release_dir/manifest.json" \
      "$release_dir/compose.yml" \
      "$release_dir/Caddyfile" \
      "$release_dir/upstream.caddy" \
      "$release_dir/runtime-env-parser.mjs" \
      "$release_dir/SHA256SUMS"
    for bin_name in "${release_bin_names[@]}"; do
      rm -f -- "$release_dir/bin/$bin_name"
    done
    rmdir "$release_dir/bin" 2>/dev/null || true
    rmdir "$release_dir" 2>/dev/null || true
  fi
  if [[ "$build_contract_created" == true && "$release_complete" != true ]]; then
    rm -f -- "$build_contract_path"
  fi
}
trap cleanup_release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -f "$build_env_file" ]]; then
  echo "Missing build env file: $build_env_file" >&2
  exit 1
fi
if (( (8#$(stat -f '%Lp' "$build_env_file") & 8#077) != 0 )); then
  echo "Build env file must have mode 0600 or stricter" >&2
  exit 1
fi
if [[ -n "$build_overrides_file" ]]; then
  [[ -f "$build_overrides_file" ]] || { echo "Missing build overrides file: $build_overrides_file" >&2; exit 1; }
  if (( (8#$(stat -f '%Lp' "$build_overrides_file") & 8#077) != 0 )); then
    echo "Build overrides file must have mode 0600 or stricter" >&2
    exit 1
  fi
fi
[[ ! -e "$release_dir" ]] || { echo "Release directory already exists: $release_dir" >&2; exit 1; }

pnpm lint
pnpm typecheck
pnpm test

# Vercel CLI produces a shell-compatible dotenv file. Only NEXT_PUBLIC_* values
# are passed to docker build; server secrets never enter build args or layers.
source "$build_env_file"
if [[ -n "$build_overrides_file" ]]; then
  source "$build_overrides_file"
fi

if [[ -z "$expected_supabase_project_ref" ]]; then
  echo "EXPECTED_SUPABASE_PROJECT_REF is mandatory for every release" >&2
  exit 1
fi
build_next_public_app_url=${NEXT_PUBLIC_APP_URL:-https://dispecing.linkapomoci.sk}
build_next_public_supabase_url=${NEXT_PUBLIC_SUPABASE_URL:-${SUPABASE_URL:-}}
build_next_public_publishable_key=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_PUBLISHABLE_KEY:-}}
build_next_public_anon_key=${NEXT_PUBLIC_SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}
build_google_maps_browser_key=${NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY:-}
build_google_maps_map_id=${NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID:-}
[[ "$build_next_public_app_url" == "https://dispecing.linkapomoci.sk" ]] || {
  echo "NEXT_PUBLIC_APP_URL does not match the production hostname" >&2
  exit 1
}
if [[ -n "$expected_supabase_project_ref" ]]; then
  expected_supabase_url="https://${expected_supabase_project_ref}.supabase.co"
  [[ "${SUPABASE_URL:-}" == "$expected_supabase_url" ]] || {
    echo "SUPABASE_URL does not match the expected project" >&2
    exit 1
  }
  [[ "${NEXT_PUBLIC_SUPABASE_URL:-}" == "$expected_supabase_url" ]] || {
    echo "NEXT_PUBLIC_SUPABASE_URL does not match the expected project" >&2
    exit 1
  }
  [[ "${SUPABASE_PROJECT_REF:-}" == "$expected_supabase_project_ref" ]] || {
    echo "SUPABASE_PROJECT_REF does not match the expected project" >&2
    exit 1
  }
  [[ -z "${SUPABASE_JWT_SECRET:-}" ]] || {
    echo "SUPABASE_JWT_SECRET must not enter a target release" >&2
    exit 1
  }
  [[ -n "$build_next_public_publishable_key" ]] || {
    echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing" >&2
    exit 1
  }
  [[ "$build_next_public_anon_key" == "$build_next_public_publishable_key" ]] || {
    echo "Public Supabase build aliases differ" >&2
    exit 1
  }
fi

release_parent=$(dirname "$release_dir")
if [[ -e "$release_parent" || -L "$release_parent" ]]; then
  [[ -d "$release_parent" && ! -L "$release_parent" ]] || {
    echo "Release parent is not a safe directory: $release_parent" >&2
    exit 1
  }
else
  mkdir -m 0700 "$release_parent"
fi
mkdir "$release_dir"
release_reserved=true
mkdir -p "$build_contract_root"
chmod 700 "$build_contract_root"
[[ ! -e "$build_contract_path" && ! -L "$build_contract_path" ]] || {
  echo "Build input contract already exists: $build_contract_path" >&2
  exit 1
}
build_contract_created=true
build_args_sha256=$(
  DEPLOYMENT_VERSION="$version" \
  NEXT_PUBLIC_APP_URL="$build_next_public_app_url" \
  NEXT_PUBLIC_SUPABASE_URL="$build_next_public_supabase_url" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$build_next_public_publishable_key" \
  NEXT_PUBLIC_SUPABASE_ANON_KEY="$build_next_public_anon_key" \
  NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY="$build_google_maps_browser_key" \
  NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID="$build_google_maps_map_id" \
    node "$build_input_helper" write \
      "$build_contract_path" \
      "$version" \
      "$expected_supabase_project_ref" \
      "dispecing.linkapomoci.sk"
)
[[ "$build_args_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Build argument hash is invalid" >&2
  exit 1
}
input_context_sha256=$(python3 "$build_context_helper" "$repo_root")
[[ "$input_context_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Build context hash is invalid" >&2
  exit 1
}

docker build \
  --platform linux/amd64 \
  --tag "$image" \
  --build-arg "DEPLOYMENT_VERSION=${version}" \
  --build-arg "NEXT_PUBLIC_APP_URL=${build_next_public_app_url}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_URL=${build_next_public_supabase_url}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${build_next_public_publishable_key}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=${build_next_public_anon_key}" \
  --build-arg "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=${build_google_maps_browser_key}" \
  --build-arg "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=${build_google_maps_map_id}" \
  .

post_build_context_sha256=$(python3 "$build_context_helper" "$repo_root")
[[ "$post_build_context_sha256" == "$input_context_sha256" ]] || {
  echo "Build inputs changed while the image was building" >&2
  exit 1
}

docker save "$image" | gzip -9 >"$release_dir/image.tar.gz"

image_id=$(docker image inspect --format '{{.Id}}' "$image")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat >"$release_dir/manifest.json" <<EOF
{
  "version": "${version}",
  "gitSha": "$(git rev-parse HEAD)",
  "image": "${image}",
  "imageId": "${image_id}",
  "buildContextSha256": "${input_context_sha256}",
  "buildArgsSha256": "${build_args_sha256}",
  "platform": "linux/amd64",
  "createdAt": "${created_at}",
  "schedulerEnabled": false
}
EOF

cp deploy/compose.yml deploy/Caddyfile deploy/upstream.caddy deploy/runtime-env-parser.mjs "$release_dir/"
mkdir "$release_dir/bin"
for bin_name in "${release_bin_names[@]}"; do
  install -m 0755 "deploy/bin/$bin_name" "$release_dir/bin/$bin_name"
done
(
  cd "$release_dir"
  checksum_files=(image.tar.gz manifest.json compose.yml Caddyfile upstream.caddy runtime-env-parser.mjs)
  for bin_name in "${release_bin_names[@]}"; do
    checksum_files+=("bin/$bin_name")
  done
  shasum -a 256 "${checksum_files[@]}" >SHA256SUMS
)

echo "Release ready: $release_dir"
echo "Image: $image_id"
release_complete=true
trap - EXIT INT TERM
