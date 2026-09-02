#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly EXPECTED_AUTH_SCHEMA_TABLE_COUNT=23
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly RESTORE_ROOT="${ROOT_DIR}/.context/migration/restore-receipts"
readonly REPORT_ROOT="${ROOT_DIR}/.context/migration/validation"
readonly INVENTORY_SQL="${ROOT_DIR}/deploy/supabase/auth-live-continuity-readonly.sql"
readonly CONTINUITY_POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_VALIDATOR="${ROOT_DIR}/deploy/bin/validate-live-target-continuity.mjs"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

run_sql() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

prepare_side() {
  local side="$1"
  local database_url="$2"
  if ! libpq_prepare_credentials \
    "${database_url}" \
    "${ROOT_DIR}/.context/secrets" \
    "auth-parity-${side}"; then
    die "${side} DB URL sa nepodarilo bezpečne rozdeliť."
  fi
}

if [[ "$#" -ne 1 || ! "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ"
fi
snapshot_id="$1"

[[ -r "${INVENTORY_SQL}" && -r "${CONTINUITY_POLICY}" && -r "${CONTINUITY_VALIDATOR}" && -r "${WATERMARK_RESOLVER}" ]] || \
  die "Chýba Auth continuity policy, SQL alebo validátor."
[[ "$(jq -r '.snapshotId' "${CONTINUITY_POLICY}")" == "${snapshot_id}" ]] || \
  die "Continuity policy nepatrí tomuto snapshotu."
snapshot_cutoff="$(jq -er '.snapshotCutoffUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${CONTINUITY_POLICY}")" || \
  die "Continuity policy nemá platný UTC cutoff."
typeset -a continuity_anchors watermark_anchors
continuity_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
(( ${#continuity_anchors[@]} == 1 )) || die "Očakáva sa práve jeden continuity anchor."
continuity_anchor="${continuity_anchors[1]}"
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."
(( (8#$(stat -f '%Lp' "${continuity_anchor}") & 8#077) == 0 )) || die "Continuity anchor musí byť private."
(( (8#$(stat -f '%Lp' "${watermark_anchor}") & 8#077) == 0 )) || die "Live watermark anchor musí byť private."
continuity_policy_sha256="$(jq -er '.policySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil current policy hash."
root_policy_sha256="$(jq -er '.rootPolicySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil root policy hash."
continuity_anchor_sha256="$(shasum -a 256 "${continuity_anchor}" | awk '{print $1}')"
watermark_anchor_sha256="$(jq -er '.currentSha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil current anchor hash."
watermark_utc="$(jq -er '.watermarkUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${watermark_anchor}")" || \
  die "Live watermark anchor nemá platný UTC čas."
live_continuity_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e 's/__LIVE_WATERMARK__/pg_catalog.transaction_timestamp()/g' "${INVENTORY_SQL}")"
previous_continuity_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${watermark_utc}'/g" "${INVENTORY_SQL}")"
jq -e --arg snapshot_id "${snapshot_id}" --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" --arg policy_sha256 "${root_policy_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .sourceFrozen == true
  and .targetJobsMustRemainDisabled == true
  and .evidence.continuityPolicySha256 == $policy_sha256
' "${continuity_anchor}" >/dev/null || die "Continuity anchor nesedí s policy alebo projektmi."
jq -e --arg snapshot_id "${snapshot_id}" --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" --arg policy_sha256 "${continuity_policy_sha256}" \
  --arg base_sha256 "${continuity_anchor_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
' "${watermark_anchor}" >/dev/null || die "Live watermark anchor nesedí s continuity trust root."

[[ -r "${SECRET_FILE}" ]] || die "Chýba bezpečný migračný secret súbor."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi
source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${TARGET_DB_URL:?TARGET_DB_URL chýba}"

source_validation_mode="${SOURCE_DB_VALIDATION_MODE:-database_url}"
case "${source_validation_mode}" in
  management_api_read_only)
    : "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
    ;;
  database_url)
    : "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
    ;;
  *)
    die "Nepodporovaný SOURCE_DB_VALIDATION_MODE; cutover je zakázaný."
    ;;
esac

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
if [[ "${source_validation_mode}" == database_url ]]; then
  [[ "${SOURCE_DB_URL}" != "${TARGET_DB_URL}" ]] || die "Source a target DB URL nesmú byť rovnaké."
  libpq_url_matches_project "${SOURCE_DB_URL}" "${EXPECTED_SOURCE_REF}" "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
    die "Source DB URL nepatrí očakávanému projektu."
fi
libpq_url_matches_project "${TARGET_DB_URL}" "${EXPECTED_TARGET_REF}" "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Target DB URL nepatrí očakávanému projektu."

manifest_file="${SNAPSHOT_ROOT}/${snapshot_id}/MANIFEST"
freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
restore_receipt="${RESTORE_ROOT}/${snapshot_id}.env"
[[ -r "${manifest_file}" && -r "${freeze_receipt}" && -r "${restore_receipt}" ]] || \
  die "Chýba DB snapshot manifest, source freeze receipt alebo target restore receipt."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
if (( (8#$(stat -f '%Lp' "${restore_receipt}") & 8#077) != 0 )); then
  die "Target restore receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^source_project_ref=//p' "${manifest_file}")" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "DB snapshot source ref nesedí."
[[ "$(sed -n 's/^snapshot_id=//p' "${manifest_file}")" == "${snapshot_id}" ]] || \
  die "DB snapshot ID nesedí."
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt už nie je frozen."
[[ "$(sed -n 's/^snapshot_id=//p' "${freeze_receipt}")" == "${snapshot_id}" ]] || \
  die "Source freeze receipt snapshot ID nesedí."
[[ "$(sed -n 's/^snapshot_id=//p' "${restore_receipt}")" == "${snapshot_id}" ]] || \
  die "Target restore receipt snapshot ID nesedí."
[[ "$(sed -n 's/^target_project_ref=//p' "${restore_receipt}")" == "${EXPECTED_TARGET_REF}" ]] || \
  die "Target restore receipt project ref nesedí."
[[ "$(sed -n 's/^outcome=//p' "${restore_receipt}")" == committed_client_confirmed ]] || \
  die "Target restore receipt nepotvrdzuje úspešný commit."
manifest_freeze_hash="$(sed -n 's/^source_freeze_receipt_sha256=//p' "${manifest_file}")"
[[ -n "${manifest_freeze_hash}" ]] || die "DB manifest nemá source freeze hash."
[[ "$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')" == "${manifest_freeze_hash}" ]] || \
  die "Source freeze receipt sa od exportu zmenil."

trap libpq_cleanup_credentials EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_state="$(
    management_api_source_freeze_state \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Source freeze kontrola cez read-only Management API zlyhala."
  source_inventory_json="$(
    print -r -- "${live_continuity_query}" | management_api_readonly_json \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Source Auth continuity inventár cez read-only Management API zlyhal."
  source_inventory="$(
    print -r -- "${source_inventory_json}" | jq -ce 'if length == 1 and (.[0].continuity | type) == "object" then .[0].continuity else error("invalid Auth continuity response") end'
  )" || die "Source Auth continuity inventár má neplatný agregovaný formát."
  unset source_inventory_json
else
  prepare_side source "${SOURCE_DB_URL}"
  source_state="$(
    print -- "select pg_catalog.current_setting('default_transaction_read_only')
      || '|' || case
        when pg_catalog.to_regclass('cron.job') is null then '0'
        else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')))[1]::text
      end;" | run_sql | tr -d '[:space:]'
  )" || die "Source freeze kontrola zlyhala."
  source_inventory="$(print -r -- "${live_continuity_query}" | run_sql)" || die "Source Auth continuity inventár zlyhal."
  libpq_cleanup_credentials
fi
[[ "${source_state}" == "on|0" ]] || die "Source nie je frozen on|0."

prepare_side target "${TARGET_DB_URL}"
target_job_state="$(
  print -- "select
    case when pg_catalog.to_regclass('cron.job') is null then '0' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')))[1]::text
    end
    || '|' || case when pg_catalog.to_regclass('public.motorist_job_controls') is null then '0' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_controls where enabled', false, true, '')))[1]::text
    end;" |
    run_sql | tr -d '[:space:]'
)" || die "Target job-state kontrola zlyhala."
[[ "${target_job_state}" == "0|0" ]] || die "Target má aktívny cron alebo worker job."
target_inventory="$(print -r -- "${live_continuity_query}" | run_sql)" || die "Target Auth continuity inventár zlyhal."
previous_target_inventory="$(print -r -- "${previous_continuity_query}" | run_sql)" || \
  die "Target bounded Auth continuity inventár zlyhal."
libpq_cleanup_credentials
trap - EXIT INT TERM

mkdir -p "${REPORT_ROOT}"
chmod 700 "${REPORT_ROOT}"
source_continuity_file="$(mktemp "${REPORT_ROOT}/.auth-source-${snapshot_id}.XXXXXX")"
target_continuity_file="$(mktemp "${REPORT_ROOT}/.auth-target-${snapshot_id}.XXXXXX")"
previous_target_continuity_file="$(mktemp "${REPORT_ROOT}/.auth-previous-target-${snapshot_id}.XXXXXX")"
chmod 600 "${source_continuity_file}" "${target_continuity_file}" "${previous_target_continuity_file}"
cleanup_continuity_files() {
  rm -f -- "${source_continuity_file}" "${target_continuity_file}" "${previous_target_continuity_file}"
}
trap cleanup_continuity_files EXIT INT TERM
source_continuity_json="$(print -r -- "${source_inventory}" | jq -ce 'if type == "object" then . else error("invalid source Auth continuity response") end')" || \
  die "Source Auth continuity odpoveď má neplatný formát."
target_continuity_json="$(print -r -- "${target_inventory}" | jq -ce 'if type == "object" then . else error("invalid target Auth continuity response") end')" || \
  die "Target Auth continuity odpoveď má neplatný formát."
previous_target_continuity_json="$(print -r -- "${previous_target_inventory}" | jq -ce 'if type == "object" then . else error("invalid previous target Auth continuity response") end')" || \
  die "Target bounded Auth continuity odpoveď má neplatný formát."
source_continuity_sha256="$(print -r -- "${source_continuity_json}" | shasum -a 256 | awk '{print $1}')"
target_continuity_sha256="$(print -r -- "${target_continuity_json}" | shasum -a 256 | awk '{print $1}')"
previous_target_continuity_sha256="$(print -r -- "${previous_target_continuity_json}" | shasum -a 256 | awk '{print $1}')"
print -r -- "${source_continuity_json}" > "${source_continuity_file}"
print -r -- "${target_continuity_json}" > "${target_continuity_file}"
print -r -- "${previous_target_continuity_json}" > "${previous_target_continuity_file}"
unset source_continuity_json target_continuity_json previous_target_continuity_json
unset source_inventory target_inventory previous_target_inventory \
  live_continuity_query previous_continuity_query
continuity_summary="$(node "${CONTINUITY_VALIDATOR}" auth-live \
  "${source_continuity_file}" \
  "${target_continuity_file}" \
  "${previous_target_continuity_file}" \
  "${CONTINUITY_POLICY}" \
  "${watermark_anchor}" \
  "${source_continuity_sha256}" \
  "${target_continuity_sha256}" \
  "${previous_target_continuity_sha256}" \
  "${continuity_policy_sha256}" \
  "${watermark_anchor_sha256}")" || die "Auth continuity zlyhala; cutover je zakázaný."
validation_watermark_utc="$(jq -er '.validationWatermarkUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' <<< "${continuity_summary}")" || \
  die "Auth continuity summary nemá platný transakčný checkpoint."
cleanup_continuity_files
trap - EXIT INT TERM

report_file="${REPORT_ROOT}/auth-${snapshot_id}.json"
report_temp="$(mktemp "${REPORT_ROOT}/.auth-${snapshot_id}.XXXXXX")"
jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg validated_at_utc "${validation_watermark_utc}" \
  --arg report_completed_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_validation_mode "${source_validation_mode}" \
  --argjson auth_schema_tables_verified "${EXPECTED_AUTH_SCHEMA_TABLE_COUNT}" \
  --arg continuity_policy_sha256 "${continuity_policy_sha256}" \
  --arg continuity_anchor_sha256 "${continuity_anchor_sha256}" \
  --arg live_watermark_anchor_sha256 "${watermark_anchor_sha256}" \
  --argjson continuity_summary "${continuity_summary}" \
  '{
    snapshot_id: $snapshot_id,
    source_project_ref: $source_project_ref,
    target_project_ref: $target_project_ref,
    validated_at_utc: $validated_at_utc,
    report_completed_at_utc: $report_completed_at_utc,
    source_validation_mode: $source_validation_mode,
    privacy: "Boolean parity only; no PII, rows, password hashes, tokens, digests, or credentials emitted.",
    auth_credential_and_session_status: "pass_continuity",
    continuity_status: $continuity_summary.status,
    validation_watermark_utc: $validated_at_utc,
    continuity_summary: $continuity_summary,
    continuity_policy_sha256: $continuity_policy_sha256,
    continuity_anchor_sha256: $continuity_anchor_sha256,
    live_watermark_anchor_sha256: $live_watermark_anchor_sha256,
    auth_schema_tables_verified: $auth_schema_tables_verified,
    source_write_freeze_active: true,
    target_jobs_active: false,
    source_deleted: false,
    cutover_status: "blocked_pending_application_and_operational_gate"
  }' > "${report_temp}"
chmod 600 "${report_temp}"
mv "${report_temp}" "${report_file}"

unset SOURCE_DB_URL TARGET_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN
print -- "Auth baseline continuity prešla; živé sessions/tokeny ostali povolenou prevádzkovou churn vrstvou."
print -- "Report: .context/migration/validation/${report_file:t}"
