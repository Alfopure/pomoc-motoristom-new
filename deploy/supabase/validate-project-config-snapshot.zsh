#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly EXPECTED_TARGET_REGION="eu-central-1"
readonly EXPECTED_RENTALS_SITE_URL="https://pomoc-motoristom-lovat.vercel.app"
readonly EXPECTED_DISPATCH_PROD_CALLBACK="https://dispecing.linkapomoci.sk/auth/callback"
readonly EXPECTED_DISPATCH_DEV_CALLBACK="https://dev.dispecing.linkapomoci.sk/auth/callback"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/config-snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly REPORT_ROOT="${ROOT_DIR}/.context/migration/validation"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly CONTINUITY_POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly CONFIG_RECEIPT_ROOT="${ROOT_DIR}/.context/migration/config-application"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

run_source_sql() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

decrypt_config() {
  local encrypted_file="$1"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${encrypted_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE
}

normalize_config() {
  local service="$1"
  local json="$2"

  case "${service}" in
    project)
      jq -cS '{
        database: {
          major_version: ((.database.version // "") | tostring | capture("^(?<major>[0-9]+)").major),
          postgres_engine: .database.postgres_engine
        }
      }' <<< "${json}"
      ;;
    postgrest)
      jq -cS 'del(.jwt_secret)' <<< "${json}"
      ;;
    pooler)
      jq -cS '
        (if type == "array" then . else [.] end)
        | map(del(
            .identifier,
            .db_user,
            .db_host,
            .db_port,
            .db_name,
            .connection_string,
            .connectionString
          ))
      ' <<< "${json}"
      ;;
    ssl)
      jq -cS '{currentConfig}' <<< "${json}"
      ;;
    network)
      jq -cS '{config}' <<< "${json}"
      ;;
    readonly)
      jq -cS '{enabled}' <<< "${json}"
      ;;
    storage)
      jq -cS 'del(.migrationVersion)' <<< "${json}"
      ;;
    auth|realtime|postgres)
      # Management APIs may mask or omit secret fields differently per
      # project. Exclude them from automatic equality; the report always keeps
      # a separate manual secret/callback gate blocked.
      jq -cS '
        del(
          .custom_oauth_max_providers,
          .mailer_subjects_custom_contents,
          .mailer_templates_custom_contents
        )
        | with_entries(select(
            .key != "smtp_pass" and
            .key != "security_captcha_secret" and
            .key != "sms_messagebird_access_key" and
            .key != "sms_test_otp" and
            .key != "sms_textlocal_api_key" and
            .key != "sms_twilio_auth_token" and
            .key != "sms_twilio_verify_auth_token" and
            .key != "sms_vonage_api_key" and
            .key != "sms_vonage_api_secret" and
            .key != "nimbus_oauth_client_secret" and
            (.key | test("^hook_.*_secrets$") | not) and
            (.key | test("^external_.*_secret$") | not)
          ))
      ' <<< "${json}"
      ;;
    *)
      die "Neznámy config service: ${service}"
      ;;
  esac
}

if [[ "$#" -ne 1 || ! "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ"
fi
snapshot_id="$1"

[[ -r "${CONTINUITY_POLICY}" && "$(jq -r '.snapshotId' "${CONTINUITY_POLICY}")" == "${snapshot_id}" ]] || \
  die "Chýba platná live-target continuity policy."
typeset -a continuity_anchors watermark_anchors redirect_receipts rentals_env_receipts
continuity_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
redirect_receipts=("${CONFIG_RECEIPT_ROOT}"/auth-redirect-*.json(N))
rentals_env_receipts=("${CONFIG_RECEIPT_ROOT}"/rentals-vercel-env-*.json(N))
(( ${#continuity_anchors[@]} == 1 )) || die "Očakáva sa práve jeden continuity anchor."
(( ${#redirect_receipts[@]} >= 1 )) || die "Chýba Auth redirect receipt."
(( ${#rentals_env_receipts[@]} == 1 )) || die "Očakáva sa práve jeden Rentals Vercel env receipt."
continuity_anchor="${continuity_anchors[1]}"
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."
redirect_receipt="${redirect_receipts[-1]}"
rentals_env_receipt="${rentals_env_receipts[1]}"
for private_evidence in "${continuity_anchor}" "${watermark_anchor}" "${redirect_receipt}" "${rentals_env_receipt}"; do
  (( (8#$(stat -f '%Lp' "${private_evidence}") & 8#077) == 0 )) || die "Continuity/config receipt musí byť private."
done
continuity_policy_sha256="$(shasum -a 256 "${CONTINUITY_POLICY}" | awk '{print $1}')"
root_policy_sha256="$(jq -er '.rootPolicySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil root policy hash."
continuity_anchor_sha256="$(shasum -a 256 "${continuity_anchor}" | awk '{print $1}')"
watermark_anchor_sha256="$(shasum -a 256 "${watermark_anchor}" | awk '{print $1}')"
redirect_receipt_sha256="$(shasum -a 256 "${redirect_receipt}" | awk '{print $1}')"
rentals_env_receipt_sha256="$(shasum -a 256 "${rentals_env_receipt}" | awk '{print $1}')"
jq -e --arg snapshot_id "${snapshot_id}" --arg policy_sha256 "${root_policy_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceFrozen == true
  and .targetJobsMustRemainDisabled == true
  and .evidence.continuityPolicySha256 == $policy_sha256
' "${continuity_anchor}" >/dev/null || die "Continuity anchor nesedí s policy."
jq -e --arg snapshot_id "${snapshot_id}" --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${continuity_policy_sha256}" --arg base_sha256 "${continuity_anchor_sha256}" '
  .snapshotId == $snapshot_id
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
' "${watermark_anchor}" >/dev/null || die "Live watermark anchor nesedí s continuity trust root."
jq -e --arg target_ref "${EXPECTED_TARGET_REF}" '
  .schemaVersion == 2
  and .targetProjectRef == $target_ref
  and .siteUrlPreserved == true
  and .existingRedirectsPreserved == true
  and .dispatchCallbackPresent == true
  and .dispatchCallbacksPresent == true
  and .dispatchCallbackCount == 2
  and .sourceProjectUrlPresent == false
' "${redirect_receipt}" >/dev/null || die "Auth redirect receipt nie je platný."
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
' "${rentals_env_receipt}" >/dev/null || die "Rentals Vercel env receipt nie je platný."

[[ -r "${SECRET_FILE}" ]] || \
  die "Chýba ${SECRET_FILE}. Najprv bezpečne zachyť migračné údaje."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
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

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
if [[ "${source_validation_mode}" == database_url ]]; then
  libpq_url_matches_project \
    "${SOURCE_DB_URL}" \
    "${EXPECTED_SOURCE_REF}" \
    "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
    die "Source DB URL nepatrí očakávanému source projektu."
fi

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
[[ -r "${manifest_file}" ]] || die "Config snapshot manifest neexistuje."
[[ "$(sed -n 's/^source_project_ref=//p' "${manifest_file}")" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Config snapshot source ref nesedí."
[[ "$(sed -n 's/^target_project_ref=//p' "${manifest_file}")" == "${EXPECTED_TARGET_REF}" ]] || \
  die "Config snapshot target ref nesedí."
[[ "$(sed -n 's/^snapshot_id=//p' "${manifest_file}")" == "${snapshot_id}" ]] || \
  die "Config manifest snapshot ID nesedí."

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || die "Chýba source freeze receipt pre tento snapshot."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt už nie je v stave frozen."
[[ "$(sed -n 's/^snapshot_id=//p' "${freeze_receipt}")" == "${snapshot_id}" ]] || \
  die "Source freeze receipt snapshot ID nesedí."
manifest_freeze_hash="$(sed -n 's/^source_freeze_receipt_sha256=//p' "${manifest_file}")"
[[ -n "${manifest_freeze_hash}" ]] || die "Config manifest nemá source freeze hash."
[[ "$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')" == "${manifest_freeze_hash}" ]] || \
  die "Source freeze receipt sa od config snapshotu zmenil."
[[ -n "$(sed -n 's/^target_refresh_completed_at_utc=//p' "${manifest_file}")" ]] || \
  die "Chýba finálny target config zachytený po aplikovaní nastavení."

if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_freeze_state="$(
    management_api_source_freeze_state \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Živá kontrola source write-freeze cez read-only Management API zlyhala."
else
  if ! libpq_prepare_credentials \
    "${SOURCE_DB_URL}" \
    "${ROOT_DIR}/.context/secrets" \
    source-config-validation; then
    die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
  fi
  trap libpq_cleanup_credentials EXIT INT TERM
  source_freeze_state="$(
    print -- "select pg_catalog.current_setting('default_transaction_read_only')
      || '|' || case
        when pg_catalog.to_regclass('cron.job') is null then '0'
        else (pg_catalog.xpath(
          '/row/count/text()',
          pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
        ))[1]::text
      end;" | run_source_sql | tr -d '[:space:]'
  )" || die "Živá kontrola source write-freeze zlyhala."
  libpq_cleanup_credentials
  trap - EXIT INT TERM
fi
[[ "${source_freeze_state}" == "on|0" ]] || \
  die "Source už nie je potvrdene read-only alebo má aktívny cron; config validácia je zakázaná."

typeset -a services failures
services=(project auth postgrest storage realtime postgres pooler ssl network readonly)
service_results='{}'
target_region_ok=false
target_auth_url_contract=false
source_s3_protocol_disabled=false
target_s3_protocol_disabled=false
typeset -A service_paths
service_paths=(
  project '/v1/projects/%s'
  auth '/v1/projects/%s/config/auth'
  postgrest '/v1/projects/%s/postgrest'
  storage '/v1/projects/%s/config/storage'
  realtime '/v1/projects/%s/config/realtime'
  postgres '/v1/projects/%s/config/database/postgres'
  pooler '/v1/projects/%s/config/database/pooler'
  ssl '/v1/projects/%s/ssl-enforcement'
  network '/v1/projects/%s/network-restrictions'
  readonly '/v1/projects/%s/readonly'
)
typeset -a live_config_files curl_config_files
cleanup_live_config() {
  rm -f -- "${live_config_files[@]:-}" "${curl_config_files[@]:-}"
}
trap cleanup_live_config EXIT INT TERM

print -- "Overujem šifrovaný source config a porovnávam ho s live read-only target Management API..."
for service in "${services[@]}"; do
  typeset -A side_json
  for side in source target; do
    artifact_side="${side}"
    [[ "${side}" == target ]] && artifact_side="target-final"
    plaintext_name="${artifact_side}-${service}.json"
    encrypted_name="${plaintext_name}.enc"
    encrypted_file="${snapshot_dir}/${encrypted_name}"
    [[ -s "${encrypted_file}" ]] || die "Chýba ${encrypted_name}."

    expected_encrypted_hash="$(awk -v file="${encrypted_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
    expected_plaintext_hash="$(awk -v file="${plaintext_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
    [[ -n "${expected_encrypted_hash}" && -n "${expected_plaintext_hash}" ]] || \
      die "Manifest nemá kontrolné súčty pre ${plaintext_name}."
    [[ "$(shasum -a 256 "${encrypted_file}" | awk '{print $1}')" == "${expected_encrypted_hash}" ]] || \
      die "Šifrovaný kontrolný súčet nesedí pre ${encrypted_name}."
    [[ "$(decrypt_config "${encrypted_file}" | shasum -a 256 | awk '{print $1}')" == "${expected_plaintext_hash}" ]] || \
      die "Dešifrovaný kontrolný súčet nesedí pre ${plaintext_name}."

    side_json[${side}]="$(decrypt_config "${encrypted_file}")"
    jq -e 'type == "object" or type == "array"' <<< "${side_json[${side}]}" >/dev/null || \
      die "Neplatný JSON v ${plaintext_name}."
  done

  source_snapshot_json="${side_json[source]}"
  for live_side in source target; do
    if [[ "${live_side}" == source ]]; then
      live_ref="${EXPECTED_SOURCE_REF}"
      live_token="${SOURCE_SUPABASE_ACCESS_TOKEN}"
    else
      live_ref="${EXPECTED_TARGET_REF}"
      live_token="${TARGET_SUPABASE_ACCESS_TOKEN}"
    fi
    live_config_file="$(mktemp "${ROOT_DIR}/.context/secrets/.${live_side}-live-${service}.XXXXXX")"
    curl_config="$(mktemp "${ROOT_DIR}/.context/secrets/.curl-${live_side}-live-${service}.XXXXXX")"
    live_config_files+=("${live_config_file}")
    curl_config_files+=("${curl_config}")
    request_path="$(printf "${service_paths[$service]}" "${live_ref}")"
    {
      print -- 'silent'
      print -- 'show-error'
      print -- 'fail-with-body'
      print -- 'request = "GET"'
      printf 'url = "https://api.supabase.com%s"\n' "${request_path}"
      printf 'header = "Authorization: Bearer %s"\n' "${live_token}"
      print -- 'header = "Accept: application/json"'
      printf 'output = "%s"\n' "${live_config_file}"
    } > "${curl_config}"
    chmod 600 "${live_config_file}" "${curl_config}"
    curl --config "${curl_config}" || \
      die "Live read-only ${live_side} Management API config zlyhal pre ${service}."
    jq -e 'type == "object" or type == "array"' "${live_config_file}" >/dev/null || \
      die "Live ${live_side} Management API vrátilo neplatný JSON pre ${service}."
    side_json[${live_side}]="$(<"${live_config_file}")"
    rm -f -- "${live_config_file}" "${curl_config}"
  done

  if [[ "${service}" == project ]]; then
    [[ "$(jq -r '.ref // empty' <<< "${side_json[source]}")" == "${EXPECTED_SOURCE_REF}" ]] || \
      failures+=("source_project_identity_mismatch")
    [[ "$(jq -r '.ref // empty' <<< "${side_json[target]}")" == "${EXPECTED_TARGET_REF}" ]] || \
      failures+=("target_project_identity_mismatch")
    [[ "$(jq -r '.region // empty' <<< "${side_json[target]}")" == "${EXPECTED_TARGET_REGION}" ]] && \
      target_region_ok=true
    [[ "${target_region_ok}" == true ]] || failures+=("target_region_not_frankfurt")
  fi

  source_snapshot_normalized="$(normalize_config "${service}" "${source_snapshot_json}")"
  source_normalized="$(normalize_config "${service}" "${side_json[source]}")"
  target_normalized="$(normalize_config "${service}" "${side_json[target]}")"
  source_config_matches_snapshot=false
  if [[ "${service}" == storage ]]; then
    # S3 protocol credentials were deliberately revoked after the immutable
    # migration snapshot. Accept only that security-reducing transition while
    # keeping every other Storage setting bound to the snapshot.
    source_snapshot_without_s3="$(jq -cS 'del(.features.s3Protocol.enabled)' <<< "${source_snapshot_normalized}")"
    source_without_s3="$(jq -cS 'del(.features.s3Protocol.enabled)' <<< "${source_normalized}")"
    if [[ "${source_snapshot_without_s3}" == "${source_without_s3}" && \
          "$(jq -r '.features.s3Protocol.enabled == true' <<< "${source_snapshot_normalized}")" == true && \
          "$(jq -r '.features.s3Protocol.enabled == false' <<< "${source_normalized}")" == true ]]; then
      source_config_matches_snapshot=true
      source_s3_protocol_disabled=true
    fi
  elif [[ "${source_snapshot_normalized}" == "${source_normalized}" ]]; then
    source_config_matches_snapshot=true
  fi
  [[ "${source_config_matches_snapshot}" == true ]] || failures+=("source_${service}_config_drift")
  matches=false
  comparison_mode="equal_non_secret_settings"
  if [[ "${service}" == readonly ]]; then
    # Source readonly is the temporary migration freeze. The isolated target
    # stays writable for smoke tests while reconciliation keeps every job off.
    comparison_mode="source_frozen_target_writable"
    [[ "$(jq -r '.enabled' <<< "${side_json[source]}")" == true && \
       "$(jq -r '.enabled' <<< "${side_json[target]}")" == false ]] && matches=true
  elif [[ "${service}" == realtime ]]; then
    # A null source value means the setting was never explicitly configured.
    # A new project may materialize its compute-tier default as a number.
    if [[ "$(jq -r 'has("connection_pool") and .connection_pool != null' <<< "${source_normalized}")" == true ]]; then
      [[ "${source_normalized}" == "${target_normalized}" ]] && matches=true
    else
      source_without_default="$(jq -cS 'del(.connection_pool)' <<< "${source_normalized}")"
      target_without_default="$(jq -cS 'del(.connection_pool)' <<< "${target_normalized}")"
      comparison_mode="equal_except_unset_connection_pool_default"
      [[ "${source_without_default}" == "${target_without_default}" ]] && matches=true
    fi
  elif [[ "${service}" == auth ]]; then
    comparison_mode="equal_non_secret_settings_except_live_app_urls"
    source_without_urls="$(jq -cS 'del(.site_url, .uri_allow_list)' <<< "${source_normalized}")"
    target_without_urls="$(jq -cS 'del(.site_url, .uri_allow_list)' <<< "${target_normalized}")"
    auth_urls_valid="$(jq -n \
      --argjson auth "${side_json[target]}" \
      --arg rentals_site "${EXPECTED_RENTALS_SITE_URL}" \
      --arg dispatch_prod_callback "${EXPECTED_DISPATCH_PROD_CALLBACK}" \
      --arg dispatch_dev_callback "${EXPECTED_DISPATCH_DEV_CALLBACK}" \
      --arg source_ref "${EXPECTED_SOURCE_REF}" '
      ($auth.uri_allow_list // "" | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $redirects
      | ($auth.site_url == $rentals_site)
        and ($redirects | index($rentals_site) != null)
        and ($redirects | index($rentals_site + "/**") != null)
        and ($redirects | index($dispatch_prod_callback) != null)
        and ($redirects | index($dispatch_dev_callback) != null)
        and (($auth.site_url | contains($source_ref)) | not)
        and (all($redirects[]; (contains($source_ref) | not)))
    ')"
    if [[ "${source_without_urls}" == "${target_without_urls}" && "${auth_urls_valid}" == true ]]; then
      matches=true
      target_auth_url_contract=true
    fi
  elif [[ "${service}" == storage ]]; then
    comparison_mode="equal_non_secret_settings_with_s3_protocol_disabled"
    source_without_s3="$(jq -cS 'del(.features.s3Protocol.enabled)' <<< "${source_normalized}")"
    target_without_s3="$(jq -cS 'del(.features.s3Protocol.enabled)' <<< "${target_normalized}")"
    if [[ "${source_without_s3}" == "${target_without_s3}" && \
          "$(jq -r '.features.s3Protocol.enabled == false' <<< "${source_normalized}")" == true && \
          "$(jq -r '.features.s3Protocol.enabled == false' <<< "${target_normalized}")" == true ]]; then
      matches=true
      target_s3_protocol_disabled=true
    fi
  else
    [[ "${source_normalized}" == "${target_normalized}" ]] && matches=true
  fi
  [[ "${matches}" == true ]] || failures+=("${service}_config_mismatch")
  service_results="$(jq -cn \
    --argjson results "${service_results}" \
    --arg service "${service}" \
    --arg comparison_mode "${comparison_mode}" \
    --argjson matches "${matches}" \
    '$results + {($service): {
      non_secret_settings_match: $matches,
      comparison_mode: $comparison_mode
    }}')"
  unset side_json
done

automatic_status=pass
(( ${#failures[@]} == 0 )) || automatic_status=fail
failure_text="$(printf '%s\n' "${failures[@]:-}")"

mkdir -p "${REPORT_ROOT}"
chmod 700 "${REPORT_ROOT}"
report_file="${REPORT_ROOT}/config-${snapshot_id}.json"
jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg validated_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_validation_mode "${source_validation_mode}" \
  --arg target_validation_mode "live_management_api_read_only" \
  --arg config_validation_mode "live_source_and_target_management_api_read_only" \
  --arg automatic_status "${automatic_status}" \
  --arg failures "${failure_text}" \
  --argjson target_region_ok "${target_region_ok}" \
  --argjson services "${service_results}" \
  --argjson target_auth_url_contract "${target_auth_url_contract}" \
  --argjson source_s3_protocol_disabled "${source_s3_protocol_disabled}" \
  --argjson target_s3_protocol_disabled "${target_s3_protocol_disabled}" \
  --arg continuity_policy_sha256 "${continuity_policy_sha256}" \
  --arg continuity_anchor_sha256 "${continuity_anchor_sha256}" \
  --arg live_watermark_anchor_sha256 "${watermark_anchor_sha256}" \
  --arg redirect_receipt_sha256 "${redirect_receipt_sha256}" \
  --arg rentals_env_receipt_sha256 "${rentals_env_receipt_sha256}" \
  '{
    snapshot_id: $snapshot_id,
    source_project_ref: $source_project_ref,
    target_project_ref: $target_project_ref,
    validated_at_utc: $validated_at_utc,
    source_validation_mode: $source_validation_mode,
    target_validation_mode: $target_validation_mode,
    config_validation_mode: $config_validation_mode,
    privacy: "Boolean comparison results only; no config values, CIDRs, hosts, tokens, passwords, or secrets.",
    automatic_config_status: $automatic_status,
    automatic_failures: ($failures | split("\n") | map(select(length > 0))),
    target_frankfurt_region: $target_region_ok,
    source_write_freeze_receipt_valid: true,
    source_write_freeze_active: true,
    continuity_status: (if $automatic_status == "pass" then "pass_continuity" else "fail" end),
    continuity_policy_sha256: $continuity_policy_sha256,
    continuity_anchor_sha256: $continuity_anchor_sha256,
    live_watermark_anchor_sha256: $live_watermark_anchor_sha256,
    auth_redirect_receipt_sha256: $redirect_receipt_sha256,
    rentals_vercel_env_receipt_sha256: $rentals_env_receipt_sha256,
    rentals_vercel_env_continuity: true,
    target_auth_url_contract: $target_auth_url_contract,
    source_s3_protocol_disabled: $source_s3_protocol_disabled,
    target_s3_protocol_disabled: $target_s3_protocol_disabled,
    services: $services,
    cutover_status: "blocked",
    cutover_blockers: [
      "application_and_operational_smoke_tests_not_run"
    ]
  }' > "${report_file}"
chmod 600 "${report_file}"

cleanup_live_config
trap - EXIT INT TERM
unset MIGRATION_ARCHIVE_PASSPHRASE SOURCE_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset source_freeze_state source_normalized target_normalized
if [[ "${automatic_status}" != pass ]]; then
  die "Nesekretná config validačná brána zlyhala; cutover je zakázaný. Report: .context/migration/validation/${report_file:t}"
fi

print -- "Config continuity aj Auth URL kontrakt pre Rentals a dispečing prešli. Cutover ostáva blokovaný application/smoke bránou."
print -- "Report: .context/migration/validation/${report_file:t}"
