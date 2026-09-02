#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly PUBLIC_SQL="${ROOT_DIR}/deploy/supabase/public-live-continuity-readonly.sql"
readonly AUTH_SQL="${ROOT_DIR}/deploy/supabase/auth-live-continuity-readonly.sql"
readonly POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly ANCHOR_HELPER="${ROOT_DIR}/deploy/bin/create-live-watermark-anchor.mjs"
readonly TRANSITION_HELPER="${ROOT_DIR}/deploy/bin/create-live-transition-receipt.mjs"
readonly FREEZE_BINDING_HELPER="${ROOT_DIR}/deploy/bin/validate-freeze-anchor-binding.mjs"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

if [[ "$#" -ne 1 ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ"
fi

snapshot_id="$1"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || die "Snapshot ID má neplatný tvar."
policy_version="$(jq -er '.schemaVersion | select(. >= 3)' "${POLICY}")" || die "Continuity policy je staršia než v3."
[[ "$(jq -r '.snapshotId' "${POLICY}")" == "${snapshot_id}" ]] || die "Continuity policy patrí inému snapshotu."
snapshot_cutoff="$(jq -er '.snapshotCutoffUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${POLICY}")" || \
  die "Continuity policy nemá platný cutoff."

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
snapshot_manifest="${SNAPSHOT_ROOT}/${snapshot_id}/MANIFEST"

typeset -a base_anchors watermark_anchors
base_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
(( ${#base_anchors[@]} == 1 )) || die "Base continuity anchor nie je jednoznačný."
(( ${#watermark_anchors[@]} == policy_version - 1 )) || die "Nový watermark možno vytvoriť iba nad úplným predchádzajúcim reťazcom."
base_anchor="${base_anchors[1]}"
freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${POLICY}" \
    "${base_anchor}" \
    "${freeze_receipt}" \
    "${snapshot_manifest}"
)" || die "Source freeze evidence nie je naviazané na immutable continuity anchor."
jq -e '
  select(.status == "pass_freeze_anchor_binding")
  | .operationalBaselineUtc
  | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' <<< "${freeze_binding_json}" >/dev/null || die "Freeze binding helper nevrátil platný operational baseline."
previous_watermark=""
for anchor in "${watermark_anchors[@]}"; do
  if [[ "$(jq -r '.schemaVersion' "${anchor}")" == $((policy_version - 1)) ]]; then
    [[ -z "${previous_watermark}" ]] || die "Predchádzajúci watermark nie je jednoznačný."
    previous_watermark="${anchor}"
  fi
done
[[ -n "${previous_watermark}" ]] || die "Predchádzajúci watermark chýba."
previous_watermark_utc="$(jq -er '.watermarkUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${previous_watermark}")" || \
  die "Predchádzajúci watermark nemá platný čas."
superseded_policy_relative="$(jq -er '
  .supersedesPolicyPath
  | select(test("^deploy/supabase/live-target-continuity-policy-v[0-9]+[.]json$"))
' "${POLICY}")" || die "Continuity policy nemá platnú predchádzajúcu policy cestu."
superseded_policy="${ROOT_DIR}/${superseded_policy_relative}"
previous_watermark_resolution="$(
  node "${WATERMARK_RESOLVER}" \
    "${superseded_policy}" \
    "${base_anchor}" \
    "${watermark_anchors[@]}"
)" || die "Predchádzajúci watermark reťazec nemá platný immutable trust root."
resolved_previous_watermark="$(jq -er '.currentPath' <<< "${previous_watermark_resolution}")" || \
  die "Predchádzajúci watermark resolver nevrátil current path."
[[ "${resolved_previous_watermark:A}" == "${previous_watermark:A}" ]] || \
  die "Predchádzajúci watermark sa nezhoduje s overeným trust root reťazcom."

[[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
(( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) == 0 )) || die "Migračný secret súbor nie je private."
source "${SECRET_FILE}"
: "${TARGET_DB_URL:?TARGET_DB_URL chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
[[ "${SOURCE_PROJECT_REF:-}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source projekt nesedí."
[[ "${TARGET_PROJECT_REF:-}" == "${EXPECTED_TARGET_REF}" ]] || die "Target projekt nesedí."
[[ "$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" == on\|0 ]] || \
  die "Source už nie je frozen on|0."

libpq_prepare_credentials "${TARGET_DB_URL}" "${ROOT_DIR}/.context/secrets" watermark-current || \
  die "Target DB credential príprava zlyhala."
temp_dir="$(mktemp -d "${CONTINUITY_ROOT}/.watermark-v${policy_version}.XXXXXX")"
chmod 700 "${temp_dir}"
cleanup() {
  libpq_cleanup_credentials
  rm -rf -- "${temp_dir}"
}
trap cleanup EXIT INT TERM

run_query() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

capture_id="$(date -u +%Y%m%dT%H%M%SZ)"
watermark_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
public_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${watermark_utc}'/g" -e 's/__LIVE_VALIDATION_MODE__/full/g' "${PUBLIC_SQL}")"
auth_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${watermark_utc}'/g" "${AUTH_SQL}")"
previous_public_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${previous_watermark_utc}'/g" -e 's/__LIVE_VALIDATION_MODE__/bounded/g' "${PUBLIC_SQL}")"
previous_auth_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${previous_watermark_utc}'/g" "${AUTH_SQL}")"
public_file="${temp_dir}/public.json"
source_public_file="${temp_dir}/source-public.json"
auth_file="${temp_dir}/auth.json"
source_auth_file="${temp_dir}/source-auth.json"
previous_public_file="${temp_dir}/previous-public.json"
previous_auth_file="${temp_dir}/previous-auth.json"
print -r -- "${public_query}" | run_query | jq -e 'if type == "object" then . else error("invalid public evidence") end' > "${public_file}"
print -r -- "${public_query}" | management_api_readonly_json "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}" | \
  jq -e 'if length == 1 and (.[0].continuity | type) == "object" then .[0].continuity else error("invalid source public evidence") end' > "${source_public_file}"
print -r -- "${auth_query}" | run_query | jq -e 'if type == "object" then . else error("invalid Auth evidence") end' > "${auth_file}"
print -r -- "${auth_query}" | management_api_readonly_json "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}" | \
  jq -e 'if length == 1 and (.[0].continuity | type) == "object" then .[0].continuity else error("invalid source Auth evidence") end' > "${source_auth_file}"
print -r -- "${previous_public_query}" | run_query | jq -e 'if type == "object" then . else error("invalid previous public evidence") end' > "${previous_public_file}"
print -r -- "${previous_auth_query}" | run_query | jq -e 'if type == "object" then . else error("invalid previous Auth evidence") end' > "${previous_auth_file}"
chmod 600 \
  "${public_file}" \
  "${source_public_file}" \
  "${auth_file}" \
  "${source_auth_file}" \
  "${previous_public_file}" \
  "${previous_auth_file}"
unset public_query auth_query previous_public_query previous_auth_query

closing_freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${POLICY}" \
    "${base_anchor}" \
    "${freeze_receipt}" \
    "${snapshot_manifest}"
)" || die "Source freeze evidence sa počas capture prestalo viazať na immutable continuity anchor."
[[ "${closing_freeze_binding_json}" == "${freeze_binding_json}" ]] || \
  die "Source freeze evidence sa počas capture zmenilo."

output="${CONTINUITY_ROOT}/live-watermark-${snapshot_id}-${capture_id}.json"
transition_receipt="${CONTINUITY_ROOT}/live-transition-${snapshot_id}-${capture_id}.json"
node "${TRANSITION_HELPER}" \
  "${source_public_file}" \
  "${public_file}" \
  "${POLICY}" \
  "${previous_watermark}" \
  "${transition_receipt}"
export MIGRATION_ARCHIVE_PASSPHRASE
node "${ANCHOR_HELPER}" \
  "${public_file}" \
  "${auth_file}" \
  "${previous_public_file}" \
  "${previous_auth_file}" \
  "${source_public_file}" \
  "${source_auth_file}" \
  "${POLICY}" \
  "${base_anchor}" \
  "${previous_watermark}" \
  "${transition_receipt}" \
  "${output}"
chmod 600 "${transition_receipt}" "${output}"
unset TARGET_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN MIGRATION_ARCHIVE_PASSPHRASE
print -- "V${policy_version} transition receipt a live watermark boli vytvorené append-only; source ani target neboli zmenené."
