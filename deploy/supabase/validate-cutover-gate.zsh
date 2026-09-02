#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly EXPECTED_TARGET_URL="https://${EXPECTED_TARGET_REF}.supabase.co"
readonly EXPECTED_APP_DOMAIN="dispecing.linkapomoci.sk"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly RELAY_HELPER="${ROOT_DIR}/deploy/supabase/manage-db-relay.zsh"
readonly VALIDATION_ROOT="${ROOT_DIR}/.context/migration/validation"
readonly TARGET_VALIDATOR="${ROOT_DIR}/deploy/supabase/validate-target-snapshot.zsh"
readonly AUTH_VALIDATOR="${ROOT_DIR}/deploy/supabase/validate-auth-snapshot.zsh"
readonly STORAGE_VALIDATOR="${ROOT_DIR}/deploy/supabase/validate-storage-rest.zsh"
readonly CONFIG_VALIDATOR="${ROOT_DIR}/deploy/supabase/validate-project-config-snapshot.zsh"
readonly APPLICATION_VALIDATOR="${ROOT_DIR}/deploy/supabase/validate-application-release.mjs"
readonly RUNTIME_CONTRACT="${ROOT_DIR}/deploy/bin/runtime-env-contract.mjs"
readonly BUILD_CONTEXT_HELPER="${ROOT_DIR}/deploy/bin/compute-build-context-sha256.py"
readonly BUILD_INPUT_HELPER="${ROOT_DIR}/deploy/bin/build-input-contract.mjs"
readonly EVIDENCE_WINDOW_HELPER="${ROOT_DIR}/deploy/bin/validate-gate-evidence-window.py"
readonly CAPTURE_EVIDENCE_HELPER="${ROOT_DIR}/deploy/bin/capture-private-evidence.py"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly CONTINUITY_POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly CONFIG_APPLICATION_ROOT="${ROOT_DIR}/.context/migration/config-application"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"
readonly FREEZE_BINDING_HELPER="${ROOT_DIR}/deploy/bin/validate-freeze-anchor-binding.mjs"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

private_file() {
  local file_path="$1"
  [[ -f "${file_path}" && -r "${file_path}" ]] || return 1
  (( (8#$(stat -f '%Lp' "${file_path}") & 8#077) == 0 ))
}

env_value() {
  local file_path="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "${file_path}"
}

add_failure() {
  failures+=("$1")
}

report_identity_matches() {
  local file_path="$1"
  jq -e \
    --arg snapshot_id "${snapshot_id}" \
    --arg source_ref "${EXPECTED_SOURCE_REF}" \
    --arg target_ref "${EXPECTED_TARGET_REF}" \
    '.snapshot_id == $snapshot_id
      and .source_project_ref == $source_ref
      and .target_project_ref == $target_ref' \
    "${file_path}" >/dev/null
}

run_sql() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

prepare_database() {
  local label="$1"
  local database_url="$2"
  libpq_prepare_credentials \
    "${database_url}" \
    "${ROOT_DIR}/.context/secrets" \
    "cutover-gate-${label}" || die "${label} DB credential príprava zlyhala."
}

if [[ "$#" -ne 2 ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ RELEASE_VERSION"
fi

snapshot_id="$1"
release_version="$2"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."
[[ "${release_version}" =~ '^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' ]] || \
  die "Release version má neplatný tvar."
[[ "${release_version}" != *'..'* ]] || die "Release version nesmie obsahovať '..'."
[[ -f "${BUILD_CONTEXT_HELPER}" ]] || die "Chýba helper pre hash build kontextu."
[[ -f "${BUILD_INPUT_HELPER}" ]] || die "Chýba helper pre build-input contract."
[[ -f "${EVIDENCE_WINDOW_HELPER}" ]] || die "Chýba helper pre časové okno gate evidence."
[[ -f "${CAPTURE_EVIDENCE_HELPER}" ]] || die "Chýba helper pre immutable gate evidence."

readonly snapshot_id release_version
readonly generated_database_report="${VALIDATION_ROOT}/target-${snapshot_id}.json"
readonly generated_storage_report="${VALIDATION_ROOT}/storage-${snapshot_id}.json"
readonly generated_config_report="${VALIDATION_ROOT}/config-${snapshot_id}.json"
readonly generated_auth_report="${VALIDATION_ROOT}/auth-${snapshot_id}.json"
readonly generated_application_report="${VALIDATION_ROOT}/application-${snapshot_id}.json"
readonly freeze_receipt="${ROOT_DIR}/.context/migration/source-freeze/${snapshot_id}.env"
readonly restore_receipt="${ROOT_DIR}/.context/migration/restore-receipts/${snapshot_id}.env"
readonly config_receipt="${ROOT_DIR}/.context/migration/config-application/${snapshot_id}.env"
readonly snapshot_manifest="${ROOT_DIR}/.context/migration/snapshots/${snapshot_id}/MANIFEST"
readonly config_manifest="${ROOT_DIR}/.context/migration/config-snapshots/${snapshot_id}/MANIFEST"
readonly release_dir="${ROOT_DIR}/deploy/releases/${release_version}"
readonly release_manifest="${release_dir}/manifest.json"
readonly build_input_contract="${ROOT_DIR}/.context/migration/build-input-contracts/${release_version}.json"
readonly web_env="${ROOT_DIR}/deploy/env/web.env"
readonly worker_env="${ROOT_DIR}/deploy/env/worker.env"
readonly listener_env="${ROOT_DIR}/deploy/env/viptel-listener.env"
readonly caddy_env="${ROOT_DIR}/deploy/env/caddy.env"

typeset -a continuity_anchors watermark_anchors storage_anchor_dirs storage_transition_dirs auth_redirect_receipts rentals_env_receipts
continuity_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
storage_anchor_dirs=("${CONTINUITY_ROOT}"/live-storage-${snapshot_id}-*(N/))
storage_transition_dirs=("${CONTINUITY_ROOT}"/live-storage-transition-${snapshot_id}-*(N/))
auth_redirect_receipts=("${CONFIG_APPLICATION_ROOT}"/auth-redirect-*.json(N))
rentals_env_receipts=("${CONFIG_APPLICATION_ROOT}"/rentals-vercel-env-*.json(N))
(( ${#continuity_anchors[@]} == 1 )) || die "Očakáva sa práve jeden continuity anchor."
(( ${#storage_anchor_dirs[@]} == 1 )) || die "Očakáva sa práve jeden live Storage anchor."
(( ${#storage_transition_dirs[@]} == 1 )) || die "Očakáva sa práve jedna append-only Storage transition."
(( ${#auth_redirect_receipts[@]} >= 1 )) || die "Chýba Auth redirect receipt."
(( ${#rentals_env_receipts[@]} == 1 )) || die "Očakáva sa práve jeden Rentals env receipt."
readonly continuity_anchor="${continuity_anchors[1]}"
freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${CONTINUITY_POLICY}" \
    "${continuity_anchor}" \
    "${freeze_receipt}" \
    "${snapshot_manifest}" \
    "${config_manifest}"
)" || die "Source freeze evidence nie je naviazané na immutable continuity anchor."
operational_baseline_utc="$(jq -er '
  select(.status == "pass_freeze_anchor_binding")
  | .operationalBaselineUtc
  | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' <<< "${freeze_binding_json}")" || die "Freeze binding helper nevrátil platný operational baseline."
readonly freeze_binding_json operational_baseline_utc
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."
readonly watermark_anchor
readonly root_policy_sha256="$(jq -er '.rootPolicySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")"
readonly root_watermark_sha256="$(jq -er '.rootSha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")"
readonly transition_receipt_sha256="$(jq -er '.transitionReceiptSha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")"
readonly storage_anchor_dir="${storage_anchor_dirs[1]%/}"
readonly storage_anchor_manifest="${storage_anchor_dir}/manifest.json"
readonly storage_anchor_names="${storage_anchor_dir}/target-only.txt"
readonly storage_anchor_content="${storage_anchor_dir}/target-only.sha256"
readonly storage_transition_dir="${storage_transition_dirs[1]%/}"
readonly storage_transition_manifest="${storage_transition_dir}/manifest.json"
readonly storage_transition_catalog="${storage_transition_dir}/catalog.jsonl"
readonly auth_redirect_receipt="${auth_redirect_receipts[-1]}"
readonly rentals_env_receipt="${rentals_env_receipts[1]}"
readonly continuity_policy_sha256="$(shasum -a 256 "${CONTINUITY_POLICY}" | awk '{print $1}')"
readonly continuity_anchor_sha256="$(shasum -a 256 "${continuity_anchor}" | awk '{print $1}')"
readonly watermark_anchor_sha256="$(shasum -a 256 "${watermark_anchor}" | awk '{print $1}')"
readonly storage_anchor_sha256="$(shasum -a 256 "${storage_anchor_manifest}" | awk '{print $1}')"
readonly storage_transition_manifest_sha256="$(shasum -a 256 "${storage_transition_manifest}" | awk '{print $1}')"
readonly auth_redirect_receipt_sha256="$(shasum -a 256 "${auth_redirect_receipt}" | awk '{print $1}')"
readonly rentals_env_receipt_sha256="$(shasum -a 256 "${rentals_env_receipt}" | awk '{print $1}')"

typeset -a failures
failures=()
typeset -a component_report_times
component_report_times=()
validation_session_started_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gate_run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
[[ "${gate_run_id}" =~ '^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$' ]] || die "Gate run ID má neplatný tvar."

mkdir -p "${VALIDATION_ROOT}"
chmod 700 "${VALIDATION_ROOT}"
readonly gate_runs_root="${VALIDATION_ROOT}/gate-runs/${snapshot_id}"
mkdir -p "${gate_runs_root}"
chmod 700 "${VALIDATION_ROOT}/gate-runs" "${gate_runs_root}"
readonly gate_run_root="${gate_runs_root}/${gate_run_id}"
mkdir "${gate_run_root}" || die "Gate run adresár už existuje."
chmod 700 "${gate_run_root}"
readonly database_report="${gate_run_root}/database.json"
readonly storage_report="${gate_run_root}/storage.json"
readonly config_report="${gate_run_root}/config.json"
readonly auth_report="${gate_run_root}/auth.json"
readonly application_report="${gate_run_root}/application.json"
readonly report_file="${gate_run_root}/cutover-gate-${snapshot_id}-${gate_run_id}.json"
readonly incomplete_report="${gate_run_root}/incomplete.json"
report_temp="$(mktemp "${gate_run_root}/.incomplete.XXXXXX")"
jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg release_version "${release_version}" \
  --arg validated_at_utc "${validation_session_started_at_utc}" \
  '{
    snapshot_id: $snapshot_id,
    source_project_ref: $source_project_ref,
    target_project_ref: $target_project_ref,
    release_version: $release_version,
    validated_at_utc: $validated_at_utc,
    privacy: "Fail-closed validation state only; no PII, rows, object names, tokens, passwords, hashes, or secret values.",
    gate_status: "fail",
    failures: ["fresh_validation_incomplete"],
    source_write_freeze_active: false,
    source_deleted: false,
    target_jobs_active: true,
    scheduler_enabled: false,
    production_cutover_performed: false
  }' > "${report_temp}"
chmod 600 "${report_temp}"
ln "${report_temp}" "${incomplete_report}" || die "Incomplete gate evidence sa nepodarilo vytvoriť bezpečne."
rm "${report_temp}"

print -- "Obnovujem live read-only DB, Auth, config a exact-image application evidence..."
"${STORAGE_VALIDATOR}" "${snapshot_id}" || die "Fresh read-only Storage validácia zlyhala."
python3 "${CAPTURE_EVIDENCE_HELPER}" "${generated_storage_report}" "${storage_report}" || \
  die "Storage evidence sa nepodarilo immutable zachytiť."
gate_started_at_utc="$(jq -er '.validated_at_utc' "${storage_report}")" || \
  die "Storage evidence nemá platný gate timestamp."
"${TARGET_VALIDATOR}" "${snapshot_id}" || die "Fresh target DB validácia zlyhala."
python3 "${CAPTURE_EVIDENCE_HELPER}" "${generated_database_report}" "${database_report}" || \
  die "Database evidence sa nepodarilo immutable zachytiť."
"${AUTH_VALIDATOR}" "${snapshot_id}" || die "Fresh Auth validácia zlyhala."
python3 "${CAPTURE_EVIDENCE_HELPER}" "${generated_auth_report}" "${auth_report}" || \
  die "Auth evidence sa nepodarilo immutable zachytiť."
"${CONFIG_VALIDATOR}" "${snapshot_id}" || die "Fresh config validácia zlyhala."
python3 "${CAPTURE_EVIDENCE_HELPER}" "${generated_config_report}" "${config_report}" || \
  die "Config evidence sa nepodarilo immutable zachytiť."
node "${APPLICATION_VALIDATOR}" \
  --snapshot "${snapshot_id}" \
  --release "${release_version}" \
  --env-dir "${ROOT_DIR}/deploy/env" \
  --release-root "${ROOT_DIR}/deploy/releases" \
  --report-root "${VALIDATION_ROOT}" || die "Fresh exact-image application validácia zlyhala."
python3 "${CAPTURE_EVIDENCE_HELPER}" "${generated_application_report}" "${application_report}" || \
  die "Application evidence sa nepodarilo immutable zachytiť."

for protected_file in \
  "${SECRET_FILE}" \
  "${database_report}" \
  "${storage_report}" \
  "${config_report}" \
  "${auth_report}" \
  "${application_report}" \
  "${build_input_contract}" \
  "${freeze_receipt}" \
  "${restore_receipt}" \
  "${config_receipt}" \
  "${snapshot_manifest}" \
  "${config_manifest}" \
  "${web_env}" \
  "${worker_env}" \
  "${listener_env}" \
  "${caddy_env}"; do
  private_file "${protected_file}" || add_failure "missing_or_unprotected_file:${protected_file:t}"
done

for continuity_file in \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchor}" \
  "${storage_anchor_manifest}" \
  "${storage_anchor_names}" \
  "${storage_anchor_content}" \
  "${storage_transition_manifest}" \
  "${storage_transition_catalog}" \
  "${auth_redirect_receipt}" \
  "${rentals_env_receipt}"; do
  private_file "${continuity_file}" || {
    [[ "${continuity_file}" == "${CONTINUITY_POLICY}" && -f "${continuity_file}" ]] || \
      add_failure "missing_or_unprotected_continuity_evidence:${continuity_file:t}"
  }
done

for report in \
  "${database_report}" \
  "${storage_report}" \
  "${config_report}" \
  "${auth_report}" \
  "${application_report}"; do
  report_identity_matches "${report}" || add_failure "report_identity_mismatch:${report:t}"
  report_timestamp="$(jq -r '.validated_at_utc // empty' "${report}" 2>/dev/null || true)"
  if [[ -n "${report_timestamp}" ]]; then
    component_report_times+=("${report_timestamp}")
  else
    add_failure "report_timestamp_missing:${report:t}"
  fi
  node --input-type=module - "${report}" "${gate_started_at_utc}" <<'NODE' || \
    add_failure "report_not_fresh_for_current_gate:${report:t}"
import { readFileSync } from "node:fs";

const [reportPath, gateStartedAt] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const reportTime = Date.parse(report.validated_at_utc);
const startedTime = Date.parse(gateStartedAt);
if (!Number.isFinite(reportTime) || !Number.isFinite(startedTime) || reportTime < startedTime || reportTime > Date.now() + 5_000) {
  process.exit(1);
}
NODE
done

jq -e '
  .database_status == "pass"
  and .database_failures == []
  and .continuity_status == "pass_continuity"
  and .validated_at_utc == .validation_watermark_utc
  and .validated_at_utc == .continuity_summary.validationWatermarkUtc
  and .source_write_freeze_active == true
  and .vault_count_matches == true
  and .continuity_summary.activeJobControls == 0
' "${database_report}" >/dev/null || add_failure "database_validation_not_passed"

jq -e '
  .storage_payload_status == "pass"
  and .continuity_status == "pass_continuity"
  and .source_write_freeze_active == true
  and .storage_operation == "validate"
  and .target_only_keyset_matches_database == true
  and .anchored_live_content_matches == true
  and .transition_anchored_content_matches == true
  and .recording_metadata_contract_matches == true
  and .live_storage_transition_status == "pass_append_only_transition"
  and (.live_storage_transition_manifest_sha256 | test("^[0-9a-f]{64}$"))
  and .root_anchor_bucket == "rental-photos"
  and .live_growth_buckets == ["motorist-call-recordings", "rental-photos"]
  and .target_only_payload_count == (
    .buckets["motorist-call-recordings"].target_extra_count
    + .buckets["rental-photos"].target_extra_count
  )
  and .buckets["rental-photos"].target_only_keyset_matches_database == true
  and .buckets["rental-photos"].anchored_live_content_matches == true
  and .buckets["motorist-call-recordings"].target_only_keyset_matches_database == true
  and .buckets["motorist-call-recordings"].anchored_live_content_matches == true
  and .buckets["motorist-call-recordings"].recording_metadata_contract_matches == true
  and (.buckets | keys) == [
    "motorist-call-recordings",
    "motorist-case-attachments",
    "rental-photos",
    "signatures",
    "vehicle-damage-photos",
    "vehicle-photos"
  ]
  and all(.buckets[];
    .matches == true
    and .baseline == .source
    and (if .live_growth_allowed then
      .target.count >= .source.count and .target.bytes >= .source.bytes and .target_extra_count >= 0
    else
      .source == .target and .target_extra_count == 0 and .target_extra_bytes == 0
    end)
  )
' "${storage_report}" >/dev/null || add_failure "storage_validation_not_passed"

jq -e -n \
  --slurpfile database "${database_report}" \
  --slurpfile storage "${storage_report}" '
  $database[0].continuity_summary.storageLiveGrowth
    == $storage[0].buckets["rental-photos"].target_extra_count
' >/dev/null || add_failure "database_storage_live_growth_mismatch"

jq -e '
  .automatic_config_status == "pass"
  and .automatic_failures == []
  and .continuity_status == "pass_continuity"
  and .target_validation_mode == "live_management_api_read_only"
  and .config_validation_mode == "live_source_and_target_management_api_read_only"
  and .target_frankfurt_region == true
  and .source_write_freeze_receipt_valid == true
  and .source_write_freeze_active == true
  and .target_auth_url_contract == true
  and .source_s3_protocol_disabled == true
  and .target_s3_protocol_disabled == true
  and .rentals_vercel_env_continuity == true
  and (.services | keys) == [
    "auth",
    "network",
    "pooler",
    "postgres",
    "postgrest",
    "project",
    "readonly",
    "realtime",
    "ssl",
    "storage"
  ]
  and all(.services[]; .non_secret_settings_match == true)
' "${config_report}" >/dev/null || add_failure "config_validation_not_passed"

jq -e '
  .auth_credential_and_session_status == "pass_continuity"
  and .continuity_status == "pass_continuity"
  and .validated_at_utc == .validation_watermark_utc
  and .validated_at_utc == .continuity_summary.validationWatermarkUtc
  and .auth_schema_tables_verified == 23
  and .source_write_freeze_active == true
  and .target_jobs_active == false
  and .source_deleted == false
' "${auth_report}" >/dev/null || add_failure "auth_validation_not_passed"

for continuity_report in "${database_report}" "${storage_report}" "${config_report}" "${auth_report}"; do
  jq -e \
    --arg policy_sha256 "${continuity_policy_sha256}" \
    --arg anchor_sha256 "${continuity_anchor_sha256}" \
    --arg watermark_anchor_sha256 "${watermark_anchor_sha256}" '
    .continuity_policy_sha256 == $policy_sha256
    and .continuity_anchor_sha256 == $anchor_sha256
    and .live_watermark_anchor_sha256 == $watermark_anchor_sha256
  ' "${continuity_report}" >/dev/null || \
    add_failure "continuity_binding_mismatch:${continuity_report:t}"
done
jq -e \
  --arg storage_anchor_sha256 "${storage_anchor_sha256}" \
  --arg storage_transition_sha256 "${storage_transition_manifest_sha256}" '
  .live_storage_anchor_sha256 == $storage_anchor_sha256
  and .live_storage_transition_manifest_sha256 == $storage_transition_sha256
' "${storage_report}" >/dev/null || add_failure "live_storage_anchor_binding_mismatch"
jq -e \
  --arg auth_redirect_sha256 "${auth_redirect_receipt_sha256}" \
  --arg rentals_env_sha256 "${rentals_env_receipt_sha256}" '
  .auth_redirect_receipt_sha256 == $auth_redirect_sha256
  and .rentals_vercel_env_receipt_sha256 == $rentals_env_sha256
' "${config_report}" >/dev/null || add_failure "live_app_config_receipt_binding_mismatch"

jq -e '
  .application_smoke_status == "pass"
  and .production_build_with_target_public_config == "pass"
  and .release_version == $release_version
  and .image_id == $image_id
  and .build_context_sha256 == $build_context_sha256
  and .build_args_sha256 == $build_args_sha256
  and .sha256sums_sha256 == $sha256sums_sha256
  and .scheduler_enabled == false
  and .worker_started == false
  and .source_deleted == false
  and (.checks | keys) == [
    "app_live_http_200",
    "app_ready_database_consecutive_passes",
    "app_ready_database_http_200",
    "app_root_auth_boundary_http_200",
    "client_assets_source_ref_absent",
    "client_assets_target_ref_present",
    "supabase_auth_settings_http_200",
    "supabase_rest_admin_range_http_206",
    "supabase_storage_admin_http_200",
    "unauthenticated_job_route_http_401"
  ]
  and .checks.app_ready_database_consecutive_passes >= 5
  and .checks.app_live_http_200 == true
  and .checks.app_ready_database_http_200 == true
  and .checks.app_root_auth_boundary_http_200 == true
  and .checks.client_assets_source_ref_absent == true
  and .checks.client_assets_target_ref_present == true
  and .checks.supabase_auth_settings_http_200 == true
  and .checks.supabase_rest_admin_range_http_206 == true
  and .checks.supabase_storage_admin_http_200 == true
  and .checks.unauthenticated_job_route_http_401 == true
' \
  --arg release_version "${release_version}" \
  --arg image_id "$(jq -r '.imageId // empty' "${release_manifest}")" \
  --arg build_context_sha256 "$(jq -r '.buildContextSha256 // empty' "${release_manifest}")" \
  --arg build_args_sha256 "$(jq -r '.buildArgsSha256 // empty' "${release_manifest}")" \
  --arg sha256sums_sha256 "$(shasum -a 256 "${release_dir}/SHA256SUMS" | awk '{print $1}')" \
  "${application_report}" >/dev/null || add_failure "application_validation_not_passed"

[[ "$(env_value "${freeze_receipt}" state)" == frozen ]] || add_failure "freeze_receipt_not_frozen"
[[ "$(env_value "${freeze_receipt}" snapshot_id)" == "${snapshot_id}" ]] || add_failure "freeze_receipt_snapshot_mismatch"
[[ "$(env_value "${freeze_receipt}" source_project_ref)" == "${EXPECTED_SOURCE_REF}" ]] || add_failure "freeze_receipt_source_mismatch"
[[ "$(env_value "${freeze_receipt}" target_project_ref)" == "${EXPECTED_TARGET_REF}" ]] || add_failure "freeze_receipt_target_mismatch"
[[ "$(env_value "${freeze_receipt}" frozen_at_utc)" == "${operational_baseline_utc}" ]] || add_failure "operational_baseline_not_bound_to_freeze"
[[ "$(env_value "${freeze_receipt}" source_restart_verified)" == true ]] || add_failure "source_restart_not_verified"
[[ "$(env_value "${freeze_receipt}" external_writers_attested_stopped)" == true ]] || add_failure "external_writers_not_attested_stopped"

[[ "$(env_value "${restore_receipt}" snapshot_id)" == "${snapshot_id}" ]] || add_failure "restore_receipt_snapshot_mismatch"
[[ "$(env_value "${restore_receipt}" target_project_ref)" == "${EXPECTED_TARGET_REF}" ]] || add_failure "restore_receipt_target_mismatch"
[[ "$(env_value "${restore_receipt}" outcome)" == committed_client_confirmed ]] || add_failure "restore_not_committed"

[[ "$(env_value "${config_receipt}" state)" == applied ]] || add_failure "config_not_applied"
[[ "$(env_value "${config_receipt}" snapshot_id)" == "${snapshot_id}" ]] || add_failure "config_receipt_snapshot_mismatch"
[[ "$(env_value "${config_receipt}" source_config_drift)" == false ]] || add_failure "source_config_drift_detected"
[[ "$(env_value "${config_receipt}" target_config_drift)" == false ]] || add_failure "target_config_drift_detected"
[[ "$(env_value "${config_receipt}" secret_bearing_auth_features_detected)" == false ]] || add_failure "secret_bearing_auth_feature_requires_review"
[[ "$(env_value "${config_receipt}" source_unfrozen)" == false ]] || add_failure "source_was_unfrozen"

snapshot_freeze_hash="$(env_value "${snapshot_manifest}" source_freeze_receipt_sha256)"
config_freeze_hash="$(env_value "${config_manifest}" source_freeze_receipt_sha256)"
actual_freeze_hash="$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')"
[[ -n "${snapshot_freeze_hash}" && "${snapshot_freeze_hash}" == "${actual_freeze_hash}" ]] || add_failure "snapshot_freeze_hash_mismatch"
[[ -n "${config_freeze_hash}" && "${config_freeze_hash}" == "${actual_freeze_hash}" ]] || add_failure "config_freeze_hash_mismatch"
[[ "$(env_value "${snapshot_manifest}" snapshot_id)" == "${snapshot_id}" ]] || add_failure "snapshot_manifest_id_mismatch"
[[ "$(env_value "${snapshot_manifest}" source_project_ref)" == "${EXPECTED_SOURCE_REF}" ]] || add_failure "snapshot_manifest_source_mismatch"
[[ "$(env_value "${config_manifest}" target_project_ref)" == "${EXPECTED_TARGET_REF}" ]] || add_failure "config_manifest_target_mismatch"
[[ -n "$(env_value "${config_manifest}" target_refresh_completed_at_utc)" ]] || add_failure "target_config_refresh_missing"

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
  and .historicalGateUsedAsTrustRoot == false
  and .evidence.continuityPolicySha256 == $policy_sha256
' "${continuity_anchor}" >/dev/null || add_failure "continuity_anchor_invalid"
jq -e \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${continuity_policy_sha256}" \
  --arg base_sha256 "${continuity_anchor_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
  and (.watermarkUtc | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' "${watermark_anchor}" >/dev/null || add_failure "live_watermark_anchor_invalid"
jq -e \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${root_policy_sha256}" \
  --arg base_sha256 "${continuity_anchor_sha256}" \
  --arg watermark_sha256 "${root_watermark_sha256}" \
  --arg names_sha256 "$(shasum -a 256 "${storage_anchor_names}" | awk '{print $1}')" \
  --arg content_sha256 "$(shasum -a 256 "${storage_anchor_content}" | awk '{print $1}')" '
  .schemaVersion == 1
  and .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
  and .liveWatermarkAnchorSha256 == $watermark_sha256
  and .targetOnlyNamesSha256 == $names_sha256
  and .targetOnlyContentCatalogSha256 == $content_sha256
  and .targetOnlyPayloadCount >= 156
  and .sourceBaselineContentVerified == true
' "${storage_anchor_manifest}" >/dev/null || add_failure "live_storage_anchor_invalid"
jq -e \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${continuity_policy_sha256}" \
  --arg watermark_sha256 "${watermark_anchor_sha256}" \
  --arg root_storage_sha256 "${storage_anchor_sha256}" \
  --arg catalog_sha256 "$(shasum -a 256 "${storage_transition_catalog}" | awk '{print $1}')" '
  .schemaVersion == 2
  and .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .currentPolicySha256 == $policy_sha256
  and .currentWatermarkSha256 == $watermark_sha256
  and .rootStorageManifestSha256 == $root_storage_sha256
  and .allowedBuckets == ["motorist-call-recordings", "rental-photos"]
  and .catalog.sha256 == $catalog_sha256
  and .catalog.count >= 1
  and .catalog.byBucket["motorist-call-recordings"].count >= 1
  and .sourceExactSubset == true
  and .recordingContractVerified == true
' "${storage_transition_manifest}" >/dev/null || add_failure "live_storage_transition_invalid"
jq -e --arg target_ref "${EXPECTED_TARGET_REF}" '
  .schemaVersion == 2
  and .targetProjectRef == $target_ref
  and .siteUrlPreserved == true
  and .existingRedirectsPreserved == true
  and .dispatchCallbackPresent == true
  and .dispatchCallbacksPresent == true
  and .dispatchCallbackCount == 2
  and .sourceProjectUrlPresent == false
' "${auth_redirect_receipt}" >/dev/null || add_failure "auth_redirect_receipt_invalid"
jq -e --arg target_ref "${EXPECTED_TARGET_REF}" '
  .schemaVersion == 2
  and .status == "verified"
  and .projectName == "pomoc-motoristom"
  and .supabaseProjectRef == $target_ref
  and .environment == "production"
  and .targetCredentialProbesPassed == true
  and .valuesDisplayed == false
  and .redeployTriggered == false
  and .allRecordsSensitive == true
  and .requiresReconciliation == false
  and .updatedKeys == ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]
' "${rentals_env_receipt}" >/dev/null || add_failure "rentals_env_receipt_invalid"

[[ -d "${release_dir}" && -f "${release_manifest}" && -f "${release_dir}/SHA256SUMS" ]] || \
  add_failure "release_bundle_missing"
if [[ -d "${release_dir}" ]]; then
  (cd "${release_dir}" && shasum -a 256 -c SHA256SUMS >/dev/null) || add_failure "release_checksum_mismatch"
fi
jq -e \
  --arg version "${release_version}" \
  '.version == $version
    and .image == ("motorist-app:" + $version)
    and .platform == "linux/amd64"
    and .schedulerEnabled == false
    and (.imageId | test("^sha256:[0-9a-f]{64}$"))
    and (.buildContextSha256 | test("^[0-9a-f]{64}$"))
    and (.buildArgsSha256 | test("^[0-9a-f]{64}$"))' \
  "${release_manifest}" >/dev/null || add_failure "release_manifest_invalid"

current_build_context_sha256="$(python3 "${BUILD_CONTEXT_HELPER}" "${ROOT_DIR}")" || \
  die "Aktuálny build context sa nepodarilo bezpečne spočítať."
manifest_build_context_sha256="$(jq -r '.buildContextSha256 // empty' "${release_manifest}")"
[[ "${current_build_context_sha256}" == "${manifest_build_context_sha256}" ]] || \
  add_failure "build_inputs_changed_after_release"
validated_build_args_sha256="$(
  node "${BUILD_INPUT_HELPER}" validate \
    "${build_input_contract}" \
    "${release_version}" \
    "${EXPECTED_TARGET_REF}" \
    "${EXPECTED_APP_DOMAIN}" \
    "${web_env}"
)" || die "Protected build-input contract je neplatný."
manifest_build_args_sha256="$(jq -r '.buildArgsSha256 // empty' "${release_manifest}")"
[[ "${validated_build_args_sha256}" == "${manifest_build_args_sha256}" ]] || \
  add_failure "build_argument_contract_mismatch"

release_image="$(jq -r '.image // empty' "${release_manifest}")"
expected_image_id="$(jq -r '.imageId // empty' "${release_manifest}")"
actual_image_id="$(docker image inspect --format '{{.Id}}' "${release_image}" 2>/dev/null || true)"
[[ -n "${actual_image_id}" && "${actual_image_id}" == "${expected_image_id}" ]] || add_failure "local_release_image_identity_mismatch"
if docker image inspect "${release_image}" >/dev/null 2>&1; then
  if docker image inspect "${release_image}" | grep -Fq "${EXPECTED_SOURCE_REF}"; then
    add_failure "source_ref_present_in_image_config"
  fi
  if docker image inspect "${release_image}" | grep -Fq 'SUPABASE_JWT_SECRET='; then
    add_failure "legacy_jwt_secret_present_in_image_config"
  fi
  if docker history --no-trunc "${release_image}" | grep -Fq "${EXPECTED_SOURCE_REF}"; then
    add_failure "source_ref_present_in_image_history"
  fi
fi

for runtime_file in "${web_env}" "${worker_env}" "${caddy_env}"; do
  if grep -Fq "${EXPECTED_SOURCE_REF}" "${runtime_file}"; then
    add_failure "source_ref_present_in_runtime_env:${runtime_file:t}"
  fi
  if grep -Eq '^NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=' "${runtime_file}"; then
    add_failure "server_actions_key_present_in_runtime_env:${runtime_file:t}"
  fi
done
node "${RUNTIME_CONTRACT}" \
  --env-dir "${ROOT_DIR}/deploy/env" \
  --version "${release_version}" \
  --source-ref "${EXPECTED_SOURCE_REF}" \
  --target-ref "${EXPECTED_TARGET_REF}" \
  --app-domain "${EXPECTED_APP_DOMAIN}" >/dev/null || \
  add_failure "runtime_env_identity_or_job_guard_invalid"

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
[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || add_failure "secret_source_ref_mismatch"
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || add_failure "secret_target_ref_mismatch"
if [[ "${source_validation_mode}" == database_url ]]; then
  libpq_url_matches_project "${SOURCE_DB_URL}" "${EXPECTED_SOURCE_REF}" "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
    add_failure "source_database_url_identity_invalid"
fi
libpq_url_matches_project "${TARGET_DB_URL}" "${EXPECTED_TARGET_REF}" "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  add_failure "target_database_url_identity_invalid"
"${RELAY_HELPER}" check >/dev/null || die "Supabase DB relay nebeží."

trap libpq_cleanup_credentials EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_live_state="$(
    management_api_source_freeze_state \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Live source freeze kontrola cez read-only Management API zlyhala."
  expected_source_live_state="on|0"
else
  prepare_database source "${SOURCE_DB_URL}"
  source_live_state="$(
    print -- "select pg_catalog.current_setting('default_transaction_read_only')
      || '|' || case when pg_catalog.to_regclass('cron.job') is null then '0' else '1' end
      || '|' || case
        when pg_catalog.to_regclass('cron.job') is null then '-1'
        else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')))[1]::text
      end;" | run_sql | tr -d '[:space:]'
  )" || die "Live source freeze kontrola zlyhala."
  libpq_cleanup_credentials
  expected_source_live_state="on|1|0"
fi
[[ "${source_live_state}" == "${expected_source_live_state}" ]] || add_failure "live_source_not_frozen_or_cron_invalid"

prepare_database target "${TARGET_DB_URL}"
target_job_state="$(
  print -- "select
    pg_catalog.current_setting('default_transaction_read_only')
    || '|' || case when pg_catalog.to_regclass('cron.job') is null then '0' else '1' end
    || '|' || case when pg_catalog.to_regclass('cron.job') is null then '-1' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')))[1]::text
    end
    || '|' || case when pg_catalog.to_regclass('public.motorist_job_controls') is null then '0' else '1' end
    || '|' || case when pg_catalog.to_regclass('public.motorist_job_controls') is null then '-1' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_controls', false, true, '')))[1]::text
    end
    || '|' || case when pg_catalog.to_regclass('public.motorist_job_controls') is null then '-1' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_controls where enabled', false, true, '')))[1]::text
    end
    || '|' || case when pg_catalog.to_regclass('net.http_request_queue') is null then '0' else '1' end
    || '|' || case when pg_catalog.to_regclass('net.http_request_queue') is null then '-1' else
      (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from net.http_request_queue', false, true, '')))[1]::text
    end
    || '|' || (
      (select count(*) from public.vehicle_photos where public_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%')
      + (select count(*) from public.vehicles where photo_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%')
    )::text;" | run_sql | tr -d '[:space:]'
)" || die "Live target job kontrola zlyhala."
libpq_cleanup_credentials
trap - EXIT INT TERM
expected_target_job_state="off|1|0|1|11|0|1|0|0"
[[ "${target_job_state}" == "${expected_target_job_state}" ]] || add_failure "live_target_writable_job_schema_state_or_storage_url_invalid"
target_state_fields=("${(@s:|:)target_job_state}")
target_writable=false
target_jobs_active=true
[[ "${target_state_fields[1]:-}" == off ]] && target_writable=true
if [[ "${target_state_fields[3]:-}" == 0 && "${target_state_fields[6]:-}" == 0 && \
      "${target_state_fields[8]:-}" == 0 ]]; then
  target_jobs_active=false
fi
operational_state_validated_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
component_report_times+=("${operational_state_validated_at_utc}")

closing_freeze_binding_json="$(
  node "${FREEZE_BINDING_HELPER}" \
    "${ROOT_DIR}" \
    "${CONTINUITY_POLICY}" \
    "${continuity_anchor}" \
    "${freeze_receipt}" \
    "${snapshot_manifest}" \
    "${config_manifest}"
)" || die "Source freeze evidence sa počas cutover gate prestalo viazať na immutable continuity anchor."
[[ "${closing_freeze_binding_json}" == "${freeze_binding_json}" ]] || \
  die "Source freeze evidence sa počas cutover gate zmenilo."

evidence_window_json=""
if ! evidence_window_json="$(
  python3 "${EVIDENCE_WINDOW_HELPER}" \
    "${gate_started_at_utc}" \
    "${component_report_times[@]}"
)"; then
  add_failure "gate_evidence_window_invalid_or_expired"
fi
if [[ -n "${evidence_window_json}" ]]; then
  gate_completed_at_utc="$(jq -r '.completed_at_utc' <<< "${evidence_window_json}")"
  gate_validated_at_utc="$(jq -r '.validated_at_utc' <<< "${evidence_window_json}")"
  gate_run_duration_seconds="$(jq -r '.gate_run_duration_seconds' <<< "${evidence_window_json}")"
  maximum_component_age_seconds="$(jq -r '.maximum_component_age_seconds' <<< "${evidence_window_json}")"
  component_evidence_count="$(jq -r '.component_count' <<< "${evidence_window_json}")"
else
  gate_completed_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gate_validated_at_utc="${gate_started_at_utc}"
  gate_run_duration_seconds=1801
  maximum_component_age_seconds=1801
  component_evidence_count="${#component_report_times[@]}"
fi

report_temp="$(mktemp "${gate_run_root}/.cutover-gate.XXXXXX")"

gate_status="pass_predeployment"
(( ${#failures[@]} == 0 )) || gate_status="fail"
release_image_id="$(jq -r '.imageId // empty' "${release_manifest}")"
release_build_context_sha256="$(jq -r '.buildContextSha256 // empty' "${release_manifest}")"
release_build_args_sha256="$(jq -r '.buildArgsSha256 // empty' "${release_manifest}")"
release_checksums_sha256="$(shasum -a 256 "${release_dir}/SHA256SUMS" | awk '{print $1}')"
database_report_sha256="$(shasum -a 256 "${database_report}" | awk '{print $1}')"
storage_report_sha256="$(shasum -a 256 "${storage_report}" | awk '{print $1}')"
config_report_sha256="$(shasum -a 256 "${config_report}" | awk '{print $1}')"
auth_report_sha256="$(shasum -a 256 "${auth_report}" | awk '{print $1}')"
application_report_sha256="$(shasum -a 256 "${application_report}" | awk '{print $1}')"
jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg gate_run_id "${gate_run_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg release_version "${release_version}" \
  --arg validation_session_started_at_utc "${validation_session_started_at_utc}" \
  --arg gate_started_at_utc "${gate_started_at_utc}" \
  --arg completed_at_utc "${gate_completed_at_utc}" \
  --arg validated_at_utc "${gate_validated_at_utc}" \
  --arg operational_state_validated_at_utc "${operational_state_validated_at_utc}" \
  --argjson gate_run_duration_seconds "${gate_run_duration_seconds}" \
  --argjson maximum_component_age_seconds "${maximum_component_age_seconds}" \
  --argjson component_evidence_count "${component_evidence_count}" \
  --arg gate_status "${gate_status}" \
  --arg image_id "${release_image_id}" \
  --arg build_context_sha256 "${release_build_context_sha256}" \
  --arg build_args_sha256 "${release_build_args_sha256}" \
  --arg sha256sums_sha256 "${release_checksums_sha256}" \
  --arg continuity_policy_sha256 "${continuity_policy_sha256}" \
  --arg continuity_anchor_sha256 "${continuity_anchor_sha256}" \
  --arg live_watermark_anchor_sha256 "${watermark_anchor_sha256}" \
  --arg live_storage_anchor_sha256 "${storage_anchor_sha256}" \
  --arg live_storage_transition_manifest_sha256 "${storage_transition_manifest_sha256}" \
  --arg auth_redirect_receipt_sha256 "${auth_redirect_receipt_sha256}" \
  --arg rentals_env_receipt_sha256 "${rentals_env_receipt_sha256}" \
  --arg database_report_sha256 "${database_report_sha256}" \
  --arg storage_report_sha256 "${storage_report_sha256}" \
  --arg config_report_sha256 "${config_report_sha256}" \
  --arg auth_report_sha256 "${auth_report_sha256}" \
  --arg application_report_sha256 "${application_report_sha256}" \
  --arg source_validation_mode "${source_validation_mode}" \
  --arg source_live_state "${source_live_state}" \
  --arg expected_source_live_state "${expected_source_live_state}" \
  --arg target_job_state "${target_job_state}" \
  --arg expected_target_job_state "${expected_target_job_state}" \
  --argjson target_writable "${target_writable}" \
  --argjson target_jobs_active "${target_jobs_active}" \
  --argjson failures "$(printf '%s\n' "${failures[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
  '{
    snapshot_id: $snapshot_id,
    gate_run_id: $gate_run_id,
    source_project_ref: $source_project_ref,
    target_project_ref: $target_project_ref,
    release_version: $release_version,
    image_id: $image_id,
    build_context_sha256: $build_context_sha256,
    build_args_sha256: $build_args_sha256,
    sha256sums_sha256: $sha256sums_sha256,
    continuity_policy_sha256: $continuity_policy_sha256,
    continuity_anchor_sha256: $continuity_anchor_sha256,
    live_watermark_anchor_sha256: $live_watermark_anchor_sha256,
    live_storage_anchor_sha256: $live_storage_anchor_sha256,
    live_storage_transition_manifest_sha256: $live_storage_transition_manifest_sha256,
    auth_redirect_receipt_sha256: $auth_redirect_receipt_sha256,
    rentals_vercel_env_receipt_sha256: $rentals_env_receipt_sha256,
    component_report_sha256: {
      database: $database_report_sha256,
      storage: $storage_report_sha256,
      config: $config_report_sha256,
      auth: $auth_report_sha256,
      application: $application_report_sha256
    },
    validation_session_started_at_utc: $validation_session_started_at_utc,
    gate_started_at_utc: $gate_started_at_utc,
    completed_at_utc: $completed_at_utc,
    validated_at_utc: $validated_at_utc,
    operational_state_validated_at_utc: $operational_state_validated_at_utc,
    gate_run_duration_seconds: $gate_run_duration_seconds,
    maximum_component_age_seconds: $maximum_component_age_seconds,
    component_evidence_count: $component_evidence_count,
    privacy: "Boolean/status evidence plus immutable image/checksum identity only; no PII, rows, object names, tokens, passwords, secret-derived hashes, or secret values.",
    gate_status: $gate_status,
    failures: $failures,
    source_validation_mode: $source_validation_mode,
    source_write_freeze_active: ($source_live_state == $expected_source_live_state),
    source_deleted: false,
    target_writable: $target_writable,
    target_jobs_active: $target_jobs_active,
    scheduler_enabled: false,
    production_cutover_performed: false
  }' > "${report_temp}"
chmod 600 "${report_temp}"
ln "${report_temp}" "${report_file}" || die "Finálny gate report sa nepodarilo vytvoriť bez prepísania."
rm "${report_temp}"

unset SOURCE_DB_URL TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE SOURCE_SUPABASE_ACCESS_TOKEN

if [[ "${gate_status}" != pass_predeployment ]]; then
  print -u2 -- "Pre-cutover brána zlyhala (${#failures[@]} kontrol)."
  print -u2 -- "Report: ${report_file#${ROOT_DIR}/}"
  exit 1
fi

print -- "Pre-cutover brána prešla; produkčné prepnutie ešte nebolo vykonané."
print -- "Report: ${report_file#${ROOT_DIR}/}"
