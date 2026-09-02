#!/bin/zsh

set -euo pipefail
umask 077

readonly RCLONE_IMAGE="rclone/rclone:1.71.2"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly LIST_DIGEST_HELPER="${ROOT_DIR}/deploy/bin/digest-private-path-list.mjs"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

[[ "$#" -eq 1 && "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ"
snapshot_id="$1"
[[ "$(jq -r '.snapshotId' "${POLICY}")" == "${snapshot_id}" ]] || die "Continuity policy nesedí."

typeset -a base_anchors watermark_anchors existing_storage_anchors
base_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
existing_storage_anchors=("${CONTINUITY_ROOT}"/live-storage-${snapshot_id}-*(N/))
(( ${#base_anchors[@]} == 1 )) || die "Base continuity anchor nie je jednoznačný."
(( ${#existing_storage_anchors[@]} == 0 )) || die "Live Storage anchor už existuje."
base_anchor="${base_anchors[1]}"
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${POLICY}" \
  "${base_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."

[[ -r "${SECRET_FILE}" ]] || die "Chýba privátny migration secret súbor."
(( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) == 0 )) || die "Migration secret súbor nie je private."
source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${SOURCE_STORAGE_ENDPOINT:?SOURCE_STORAGE_ENDPOINT chýba}"
: "${SOURCE_STORAGE_REGION:?SOURCE_STORAGE_REGION chýba}"
: "${SOURCE_STORAGE_ACCESS_KEY_ID:?SOURCE_STORAGE_ACCESS_KEY_ID chýba}"
: "${SOURCE_STORAGE_SECRET_ACCESS_KEY:?SOURCE_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_ENDPOINT:?TARGET_STORAGE_ENDPOINT chýba}"
: "${TARGET_STORAGE_REGION:?TARGET_STORAGE_REGION chýba}"
: "${TARGET_STORAGE_ACCESS_KEY_ID:?TARGET_STORAGE_ACCESS_KEY_ID chýba}"
: "${TARGET_STORAGE_SECRET_ACCESS_KEY:?TARGET_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_AUTH_MODE:?TARGET_STORAGE_AUTH_MODE chýba}"
TARGET_STORAGE_SESSION_TOKEN="${TARGET_STORAGE_SESSION_TOKEN:-}"
[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" && "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Project ref nesedí."
[[ "${SOURCE_STORAGE_ENDPOINT}" == "https://${EXPECTED_SOURCE_REF}.storage.supabase.co/storage/v1/s3" ]] || die "Source Storage endpoint nesedí."
[[ "${TARGET_STORAGE_ENDPOINT}" == "https://${EXPECTED_TARGET_REF}.storage.supabase.co/storage/v1/s3" ]] || die "Target Storage endpoint nesedí."

source_state="$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" || \
  die "Source freeze sa nepodarilo read-only overiť."
[[ "${source_state}" == 'on|0' ]] || die "Source nie je frozen on|0."

capture_id="$(date -u +%Y%m%dT%H%M%SZ)"
anchor_dir="${CONTINUITY_ROOT}/live-storage-${snapshot_id}-${capture_id}"
mkdir "${anchor_dir}" || die "Storage anchor adresár už existuje."
chmod 700 "${anchor_dir}"
anchor_complete=false
work_dir="$(mktemp -d "${CONTINUITY_ROOT}/.storage-anchor.XXXXXX")"
chmod 700 "${work_dir}"
cleanup() {
  rm -rf -- "${work_dir}"
  if [[ "${anchor_complete}" != true ]]; then
    rm -rf -- "${anchor_dir}"
  fi
  unset SOURCE_STORAGE_ACCESS_KEY_ID SOURCE_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_ACCESS_KEY_ID
  unset TARGET_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_SESSION_TOKEN SOURCE_SUPABASE_ACCESS_TOKEN
}
trap cleanup EXIT INT TERM

rclone_config="${work_dir}/rclone.conf"
{
  print -- '[source]'
  print -- 'type = s3'
  print -- 'provider = Other'
  print -- 'env_auth = false'
  printf 'access_key_id = %s\n' "${SOURCE_STORAGE_ACCESS_KEY_ID}"
  printf 'secret_access_key = %s\n' "${SOURCE_STORAGE_SECRET_ACCESS_KEY}"
  printf 'endpoint = %s\n' "${SOURCE_STORAGE_ENDPOINT}"
  printf 'region = %s\n' "${SOURCE_STORAGE_REGION}"
  print -- 'acl = private'
  print -- 'no_check_bucket = true'
  print
  print -- '[target]'
  print -- 'type = s3'
  print -- 'provider = Other'
  print -- 'env_auth = false'
  printf 'access_key_id = %s\n' "${TARGET_STORAGE_ACCESS_KEY_ID}"
  printf 'secret_access_key = %s\n' "${TARGET_STORAGE_SECRET_ACCESS_KEY}"
  [[ "${TARGET_STORAGE_AUTH_MODE}" != session_token ]] || printf 'session_token = %s\n' "${TARGET_STORAGE_SESSION_TOKEN}"
  printf 'endpoint = %s\n' "${TARGET_STORAGE_ENDPOINT}"
  printf 'region = %s\n' "${TARGET_STORAGE_REGION}"
  print -- 'acl = private'
  print -- 'no_check_bucket = true'
} > "${rclone_config}"
chmod 600 "${rclone_config}"

rclone_run() {
  migration_docker_run --rm \
    --mount "type=bind,source=${rclone_config},target=/config/rclone/rclone.conf,readonly" \
    --mount "type=bind,source=${work_dir},target=/work" \
    "${RCLONE_IMAGE}" "$@"
}

bucket="$(jq -er '.storage.onlyLiveGrowthBucket' "${POLICY}")"
print -- "Ukotvujem iba target-only Storage payloady; žiadne objekty sa nemenia..."
rclone_run check "source:${bucket}" "target:${bucket}" --one-way --download --checkers 8 >/dev/null 2>&1 || \
  die "Source Storage baseline na targete nesedí."
rclone_run lsf --files-only --recursive "source:${bucket}" > "${work_dir}/source.txt"
rclone_run lsf --files-only --recursive "target:${bucket}" > "${work_dir}/target.txt"
LC_ALL=C sort -u "${work_dir}/source.txt" -o "${work_dir}/source.txt"
LC_ALL=C sort -u "${work_dir}/target.txt" -o "${work_dir}/target.txt"
comm -13 "${work_dir}/source.txt" "${work_dir}/target.txt" > "${work_dir}/target-only.txt"
chmod 600 "${work_dir}"/*.txt
target_only_summary="$(node "${LIST_DIGEST_HELPER}" "${work_dir}/target-only.txt")" || die "Target-only path katalóg je neplatný."
target_only_count="$(jq -r '.count' <<< "${target_only_summary}")"
(( target_only_count >= 156 )) || die "Target-only live payloadov je menej než už overený Rentals stav."
rclone_run hashsum SHA-256 "target:${bucket}" --download --files-from /work/target-only.txt > "${work_dir}/target-only.sha256"
LC_ALL=C sort -u "${work_dir}/target-only.sha256" -o "${work_dir}/target-only.sha256"
chmod 600 "${work_dir}/target-only.sha256"
[[ "$(wc -l < "${work_dir}/target-only.sha256" | tr -d ' ')" == "${target_only_count}" ]] || \
  die "Nie každý target-only payload má content checksum."

install -m 0600 "${work_dir}/target-only.txt" "${anchor_dir}/target-only.txt"
install -m 0600 "${work_dir}/target-only.sha256" "${anchor_dir}/target-only.sha256"
names_sha256="$(shasum -a 256 "${anchor_dir}/target-only.txt" | awk '{print $1}')"
content_sha256="$(shasum -a 256 "${anchor_dir}/target-only.sha256" | awk '{print $1}')"
manifest_temp="$(mktemp "${anchor_dir}/.manifest.XXXXXX")"
jq -n \
  --arg snapshotId "${snapshot_id}" \
  --arg sourceProjectRef "${EXPECTED_SOURCE_REF}" \
  --arg targetProjectRef "${EXPECTED_TARGET_REF}" \
  --arg capturedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg continuityPolicySha256 "$(shasum -a 256 "${POLICY}" | awk '{print $1}')" \
  --arg baseContinuityAnchorSha256 "$(shasum -a 256 "${base_anchor}" | awk '{print $1}')" \
  --arg liveWatermarkAnchorSha256 "$(shasum -a 256 "${watermark_anchor}" | awk '{print $1}')" \
  --arg namesSha256 "${names_sha256}" \
  --arg contentSha256 "${content_sha256}" \
  --argjson targetOnlyCount "${target_only_count}" \
  '{schemaVersion: 1, $snapshotId, $sourceProjectRef, $targetProjectRef, $capturedAtUtc,
    $continuityPolicySha256, $baseContinuityAnchorSha256, $liveWatermarkAnchorSha256,
    targetOnlyPayloadCount: $targetOnlyCount, targetOnlyNamesSha256: $namesSha256,
    targetOnlyContentCatalogSha256: $contentSha256,
    sourceBaselineContentVerified: true,
    privacy: "Counts and evidence hashes only; private companion catalogs contain object paths and content hashes."}' \
  > "${manifest_temp}"
chmod 600 "${manifest_temp}"
ln "${manifest_temp}" "${anchor_dir}/manifest.json" || die "Storage anchor manifest už existuje."
rm "${manifest_temp}"
anchor_complete=true
print -- "Live Storage anchor vytvorený; target-only payloady: ${target_only_count}."
