#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly INVENTORY_SQL="${ROOT_DIR}/deploy/supabase/snapshot-inventory.sql"
readonly REPORT_ROOT="${ROOT_DIR}/.context/migration/validation"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly CONTINUITY_SQL="${ROOT_DIR}/deploy/supabase/public-live-continuity-readonly.sql"
readonly CONTINUITY_POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_VALIDATOR="${ROOT_DIR}/deploy/bin/validate-live-target-continuity.mjs"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"
readonly FREEZE_BINDING_HELPER="${ROOT_DIR}/deploy/bin/validate-freeze-anchor-binding.mjs"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

inventory_value() {
  local inventory="$1"
  local key="$2"
  print -r -- "${inventory}" | sed -n "s/^${key}=//p"
}

run_target_inventory() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}" < "${INVENTORY_SQL}"
}

run_database_query() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

run_source_freeze_check() {
  print -- "select pg_catalog.current_setting('default_transaction_read_only')
    || '|' || case
      when pg_catalog.to_regclass('cron.job') is null then '0'
      else (pg_catalog.xpath(
        '/row/count/text()',
        pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
      ))[1]::text
    end;" | migration_docker_run --rm -i \
      --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
      --env PGPASSFILE=/run/secrets/pgpass \
      "${POSTGRES_IMAGE}" \
      psql --no-psqlrc --no-align --tuples-only --quiet \
        --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

add_failure() {
  failures+=("$1")
}

if [[ "$#" -ne 1 ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ"
fi

snapshot_id="$1"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."

[[ -r "${CONTINUITY_SQL}" && -r "${CONTINUITY_POLICY}" && -r "${CONTINUITY_VALIDATOR}" ]] || \
  die "Chýba live-target continuity policy, SQL alebo validátor."
[[ "$(jq -r '.snapshotId' "${CONTINUITY_POLICY}")" == "${snapshot_id}" ]] || \
  die "Continuity policy nepatrí tomuto snapshotu."
snapshot_cutoff="$(jq -er '.snapshotCutoffUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${CONTINUITY_POLICY}")" || \
  die "Continuity policy nemá platný UTC cutoff."
snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
inventory_file="${snapshot_dir}/inventory.tsv.enc"
freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -s "${inventory_file}" ]] || die "Snapshot nemá šifrovaný inventár."

typeset -a continuity_anchors watermark_anchors
continuity_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
(( ${#continuity_anchors[@]} == 1 )) || \
  die "Očakáva sa práve jeden nemenný continuity anchor pre tento snapshot."
continuity_anchor="${continuity_anchors[1]}"
freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${CONTINUITY_POLICY}" \
    "${continuity_anchor}" \
    "${freeze_receipt}" \
    "${manifest_file}"
)" || die "Source freeze evidence nie je naviazané na immutable continuity anchor."
jq -e '
  select(.status == "pass_freeze_anchor_binding")
  | .operationalBaselineUtc
  | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' <<< "${freeze_binding_json}" >/dev/null || die "Freeze binding helper nevrátil platný operational baseline."
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."
(( (8#$(stat -f '%Lp' "${continuity_anchor}") & 8#077) == 0 )) || \
  die "Continuity anchor musí byť private."
(( (8#$(stat -f '%Lp' "${watermark_anchor}") & 8#077) == 0 )) || \
  die "Live watermark anchor musí byť private."
continuity_policy_sha256="$(jq -er '.policySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil current policy hash."
root_policy_sha256="$(jq -er '.rootPolicySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil root policy hash."
continuity_anchor_sha256="$(shasum -a 256 "${continuity_anchor}" | awk '{print $1}')"
watermark_anchor_sha256="$(jq -er '.currentSha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil current anchor hash."
watermark_utc="$(jq -er '.watermarkUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "${watermark_anchor}")" || \
  die "Live watermark anchor nemá platný UTC čas."
live_continuity_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e 's/__LIVE_WATERMARK__/pg_catalog.transaction_timestamp()/g' -e 's/__LIVE_VALIDATION_MODE__/full/g' "${CONTINUITY_SQL}")"
previous_continuity_query="$(sed -e "s/__SNAPSHOT_CUTOFF__/${snapshot_cutoff}/g" -e "s/__LIVE_WATERMARK__/timestamptz '${watermark_utc}'/g" -e 's/__LIVE_VALIDATION_MODE__/bounded/g' "${CONTINUITY_SQL}")"
jq -e \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${root_policy_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .sourceFrozen == true
  and .sourceDeletionForbidden == true
  and .targetRewindForbidden == true
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

[[ -r "${SECRET_FILE}" ]] || \
  die "Chýba ${SECRET_FILE}. Najprv spusti capture-migration-credentials.zsh."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${TARGET_DB_URL:?TARGET_DB_URL chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
export MIGRATION_ARCHIVE_PASSPHRASE

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

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || \
  die "Target project ref nesedí."
if [[ "${source_validation_mode}" == database_url ]]; then
  libpq_url_matches_project \
    "${SOURCE_DB_URL}" \
    "${EXPECTED_SOURCE_REF}" \
    "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
    die "Source DB URL nepatrí očakávanému source projektu."
fi
libpq_url_matches_project \
  "${TARGET_DB_URL}" \
  "${EXPECTED_TARGET_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Target DB URL nepatrí očakávanému target projektu."

if ! libpq_prepare_credentials \
  "${TARGET_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  target-validation; then
  die "Target DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM

expected_encrypted_hash="$(awk -v file='inventory.tsv.enc' '$2 == file { print $1; exit }' "${manifest_file}")"
expected_plaintext_hash="$(awk -v file='inventory.tsv' '$2 == file { print $1; exit }' "${manifest_file}")"
actual_encrypted_hash="$(shasum -a 256 "${inventory_file}" | awk '{print $1}')"
[[ -n "${expected_encrypted_hash}" && "${actual_encrypted_hash}" == "${expected_encrypted_hash}" ]] || \
  die "Šifrovaný inventár má neplatný kontrolný súčet."

source_inventory="$(
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${inventory_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE
)"
actual_plaintext_hash="$(print -rn -- "${source_inventory}" | shasum -a 256 | awk '{print $1}')"

# Command substitution strips the final newline. Hash the same logical content
# with one newline, which is how psql wrote the baseline file.
if [[ "${actual_plaintext_hash}" != "${expected_plaintext_hash}" ]]; then
  actual_plaintext_hash="$(print -r -- "${source_inventory}" | shasum -a 256 | awk '{print $1}')"
fi
[[ "${actual_plaintext_hash}" == "${expected_plaintext_hash}" ]] || \
  die "Dešifrovaný inventár má neplatný kontrolný súčet."

print -- "Čítam iba agregované metriky targetu; žiadne riadky ani secrety sa nevypisujú..."
target_inventory="$(run_target_inventory)" || die "Target inventár zlyhal."
target_continuity_raw="$(print -r -- "${live_continuity_query}" | run_database_query)" || \
  die "Target continuity inventár zlyhal."
previous_target_continuity_raw="$(print -r -- "${previous_continuity_query}" | run_database_query)" || \
  die "Target bounded continuity inventár zlyhal."
libpq_cleanup_credentials
trap - EXIT INT TERM

if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_freeze_state="$(
    management_api_source_freeze_state \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Source write-freeze sa nepodarilo cez read-only Management API overiť; cutover je zakázaný."
  source_continuity_raw="$(print -r -- "${live_continuity_query}" | management_api_readonly_json "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" || \
    die "Source continuity inventár cez read-only Management API zlyhal."
else
  if ! libpq_prepare_credentials \
    "${SOURCE_DB_URL}" \
    "${ROOT_DIR}/.context/secrets" \
    source-freeze-validation; then
    die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
  fi
  trap libpq_cleanup_credentials EXIT INT TERM
  source_freeze_state="$(run_source_freeze_check | tr -d '[:space:]')" || \
    die "Source write-freeze sa nepodarilo znovu overiť; cutover je zakázaný."
  source_continuity_raw="$(print -r -- "${live_continuity_query}" | run_database_query)" || \
    die "Source continuity inventár zlyhal."
  libpq_cleanup_credentials
  trap - EXIT INT TERM
fi
source_freeze_active=false
[[ "${source_freeze_state}" == "on|0" ]] && source_freeze_active=true

mkdir -p "${REPORT_ROOT}"
chmod 700 "${REPORT_ROOT}"
source_continuity_file="$(mktemp "${REPORT_ROOT}/.public-source-${snapshot_id}.XXXXXX")"
target_continuity_file="$(mktemp "${REPORT_ROOT}/.public-target-${snapshot_id}.XXXXXX")"
previous_target_continuity_file="$(mktemp "${REPORT_ROOT}/.public-previous-target-${snapshot_id}.XXXXXX")"
chmod 600 "${source_continuity_file}" "${target_continuity_file}" "${previous_target_continuity_file}"
cleanup_continuity_files() {
  rm -f -- "${source_continuity_file}" "${target_continuity_file}" "${previous_target_continuity_file}"
}
trap cleanup_continuity_files EXIT INT TERM
if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_continuity_json="$(print -r -- "${source_continuity_raw}" | jq -ce 'if length == 1 and (.[0].continuity | type) == "object" then .[0].continuity else error("invalid source continuity response") end')" || \
    die "Source continuity odpoveď má neplatný formát."
else
  source_continuity_json="$(print -r -- "${source_continuity_raw}" | jq -ce 'if type == "object" then . else error("invalid source continuity response") end')" || \
    die "Source continuity odpoveď má neplatný formát."
fi
target_continuity_json="$(print -r -- "${target_continuity_raw}" | jq -ce 'if type == "object" then . else error("invalid target continuity response") end')" || \
  die "Target continuity odpoveď má neplatný formát."
previous_target_continuity_json="$(print -r -- "${previous_target_continuity_raw}" | jq -ce 'if type == "object" then . else error("invalid previous target continuity response") end')" || \
  die "Target bounded continuity odpoveď má neplatný formát."
source_continuity_sha256="$(print -r -- "${source_continuity_json}" | shasum -a 256 | awk '{print $1}')"
target_continuity_sha256="$(print -r -- "${target_continuity_json}" | shasum -a 256 | awk '{print $1}')"
previous_target_continuity_sha256="$(print -r -- "${previous_target_continuity_json}" | shasum -a 256 | awk '{print $1}')"
print -r -- "${source_continuity_json}" > "${source_continuity_file}"
print -r -- "${target_continuity_json}" > "${target_continuity_file}"
print -r -- "${previous_target_continuity_json}" > "${previous_target_continuity_file}"
unset source_continuity_json target_continuity_json previous_target_continuity_json
unset source_continuity_raw target_continuity_raw previous_target_continuity_raw \
  live_continuity_query previous_continuity_query
continuity_summary="$(node "${CONTINUITY_VALIDATOR}" public-live \
  "${source_continuity_file}" \
  "${target_continuity_file}" \
  "${previous_target_continuity_file}" \
  "${CONTINUITY_POLICY}" \
  "${watermark_anchor}" \
  "${source_continuity_sha256}" \
  "${target_continuity_sha256}" \
  "${previous_target_continuity_sha256}" \
  "${continuity_policy_sha256}" \
  "${watermark_anchor_sha256}")" || die "Live DB/Storage-metadata continuity zlyhala; cutover je zakázaný."
validation_watermark_utc="$(jq -er '.validationWatermarkUtc | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' <<< "${continuity_summary}")" || \
  die "Live DB continuity summary nemá platný transakčný checkpoint."
cleanup_continuity_files
trap - EXIT INT TERM

closing_freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${CONTINUITY_POLICY}" \
    "${continuity_anchor}" \
    "${freeze_receipt}" \
    "${manifest_file}"
)" || die "Source freeze evidence sa počas DB validácie prestalo viazať na immutable continuity anchor."
[[ "${closing_freeze_binding_json}" == "${freeze_binding_json}" ]] || \
  die "Source freeze evidence sa počas DB validácie zmenilo."

typeset -a failures
[[ "${source_freeze_active}" == true ]] || add_failure "source_write_freeze_not_active"
[[ "$(jq -r '.status' <<< "${continuity_summary}")" == pass_continuity ]] || \
  add_failure "public_live_continuity_not_passed"

source_auth="$(inventory_value "${source_inventory}" auth_counts)"
target_auth="$(inventory_value "${target_inventory}" auth_counts)"

source_storage="$(inventory_value "${source_inventory}" storage_buckets)"
target_storage="$(inventory_value "${target_inventory}" storage_buckets)"

target_rls_missing="$(inventory_value "${target_inventory}" public_tables_without_rls)"
[[ "${target_rls_missing}" == "0" ]] || add_failure "public_table_without_rls"

target_storage_policies="$(inventory_value "${target_inventory}" storage_policy_count)"
[[ "${target_storage_policies}" == "10" ]] || add_failure "storage_policy_count_not_10"

target_auth_triggers="$(inventory_value "${target_inventory}" auth_user_trigger_count)"
[[ "${target_auth_triggers}" == "1" ]] || add_failure "auth_user_trigger_count_not_1"

typeset -a expected_migration_versions
for migration_file in "${ROOT_DIR}"/supabase/migrations/*.sql(N); do
  migration_base="${migration_file:t:r}"
  [[ "${migration_base}" =~ '^[0-9]{14}_[a-z0-9_]+$' ]] || \
    die "Neplatný názov lokálnej migrácie: ${migration_base}"
  expected_migration_versions+=("${migration_base%%_*}")
done
(( ${#expected_migration_versions[@]} > 0 )) || die "Nenašli sa lokálne migrácie."
expected_migration_count="${#expected_migration_versions[@]}"
expected_migration_versions_csv="$(IFS=,; print -r -- "${expected_migration_versions[*]}")"
target_migration_count="$(inventory_value "${target_inventory}" migration_history_count)"
[[ "${target_migration_count}" == "${expected_migration_count}" ]] || \
  add_failure "migration_history_count_mismatch"
target_migration_versions_csv="$(inventory_value "${target_inventory}" migration_versions)"
[[ "${target_migration_versions_csv}" == "${expected_migration_versions_csv}" ]] || \
  add_failure "migration_history_versions_mismatch"

source_extensions="$(inventory_value "${source_inventory}" installed_extensions)"
target_extensions="$(inventory_value "${target_inventory}" installed_extensions)"
if ! jq -e -n --arg source "${source_extensions}" --arg target "${target_extensions}" \
  '($source | split(",") | map(select(length > 0))) as $required |
   ($target | split(",") | map(select(length > 0))) as $actual |
   ($required - $actual | length) == 0' >/dev/null; then
  add_failure "source_extension_missing"
fi

source_realtime="$(inventory_value "${source_inventory}" realtime_publication_tables)"
target_realtime="$(inventory_value "${target_inventory}" realtime_publication_tables)"
[[ "${target_realtime}" == "${source_realtime}" ]] || \
  add_failure "realtime_publication_mismatch"

target_cron="$(inventory_value "${target_inventory}" cron_job_counts)"
if ! jq -e -n --argjson cron "${target_cron}" '$cron.total == 0 and $cron.active == 0' >/dev/null; then
  add_failure "cron_jobs_present"
fi

target_net_queue="$(inventory_value "${target_inventory}" net_queue_count)"
[[ "${target_net_queue}" == "0" ]] || add_failure "net_queue_not_empty"

target_enabled_workers="$(inventory_value "${target_inventory}" enabled_worker_jobs)"
[[ "${target_enabled_workers}" == "0" ]] || add_failure "worker_job_enabled"

source_vault="$(inventory_value "${source_inventory}" vault_secret_count)"
target_vault="$(inventory_value "${target_inventory}" vault_secret_count)"
vault_matches=false
[[ "${source_vault}" == "${target_vault}" ]] && vault_matches=true
[[ "${vault_matches}" == true ]] || add_failure "vault_secret_count_mismatch"

database_status="pass"
(( ${#failures[@]} == 0 )) || database_status="fail"

typeset -a cutover_blockers
cutover_blockers=(
  "storage_payload_not_validated"
  "project_auth_api_database_pooler_ssl_network_config_not_validated"
  "application_smoke_tests_not_run"
)
[[ "${source_freeze_active}" == true ]] || cutover_blockers+=("source_write_freeze_not_active")
[[ "${database_status}" == pass ]] || cutover_blockers+=("database_validation_failed")

failure_text="$(printf '%s\n' "${failures[@]:-}")"
blocker_text="$(printf '%s\n' "${cutover_blockers[@]}")"

report_file="${REPORT_ROOT}/target-${snapshot_id}.json"

jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg validated_at_utc "${validation_watermark_utc}" \
  --arg report_completed_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_validation_mode "${source_validation_mode}" \
  --arg database_status "${database_status}" \
  --arg failures "${failure_text}" \
  --arg blockers "${blocker_text}" \
  --argjson vault_matches "${vault_matches}" \
  --argjson source_freeze_active "${source_freeze_active}" \
  --argjson source_auth "${source_auth}" \
  --argjson target_auth "${target_auth}" \
  --argjson source_storage_metadata "${source_storage}" \
  --argjson target_storage_metadata "${target_storage}" \
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
    privacy: "Aggregate counts and object metadata only; no PII, object names, tokens, passwords, or secret values.",
    database_status: $database_status,
    database_failures: ($failures | split("\n") | map(select(length > 0))),
    continuity_status: $continuity_summary.status,
    validation_watermark_utc: $validated_at_utc,
    continuity_summary: $continuity_summary,
    continuity_policy_sha256: $continuity_policy_sha256,
    continuity_anchor_sha256: $continuity_anchor_sha256,
    live_watermark_anchor_sha256: $live_watermark_anchor_sha256,
    auth_counts: {source: $source_auth, target: $target_auth},
    storage_metadata: {source: $source_storage_metadata, target: $target_storage_metadata},
    vault_count_matches: $vault_matches,
    source_write_freeze_active: $source_freeze_active,
    cutover_status: "blocked",
    cutover_blockers: ($blockers | split("\n") | map(select(length > 0)))
  }' > "${report_file}"

chmod 600 "${report_file}"
unset SOURCE_DB_URL TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE SOURCE_SUPABASE_ACCESS_TOKEN

if [[ "${database_status}" == fail ]]; then
  print -u2 -- "Databázová validácia zlyhala; cutover je zakázaný. Report: .context/migration/validation/${report_file:t}"
  exit 1
fi

print -- "Databázový restore prešiel agregovanou validáciou. Cutover ostáva blokovaný Storage/config/smoke bránami."
print -- "Report: .context/migration/validation/${report_file:t}"
