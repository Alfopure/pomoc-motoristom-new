#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/config-snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly RECEIPT_ROOT="${ROOT_DIR}/.context/migration/config-application"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

decrypt_config() {
  local encrypted_file="$1"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${encrypted_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE
}

verify_and_decrypt() {
  local artifact_name="$1"
  local output_file="$2"
  local encrypted_name="${artifact_name}.enc"
  local encrypted_file="${snapshot_dir}/${encrypted_name}"
  local expected_encrypted_hash expected_plaintext_hash

  [[ -s "${encrypted_file}" ]] || die "Chýba ${encrypted_name}."
  expected_encrypted_hash="$(awk -v file="${encrypted_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
  expected_plaintext_hash="$(awk -v file="${artifact_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
  [[ -n "${expected_encrypted_hash}" && -n "${expected_plaintext_hash}" ]] || \
    die "Config manifest nemá kontrolné súčty pre ${artifact_name}."
  [[ "$(shasum -a 256 "${encrypted_file}" | awk '{print $1}')" == "${expected_encrypted_hash}" ]] || \
    die "Šifrovaný kontrolný súčet nesedí pre ${encrypted_name}."
  decrypt_config "${encrypted_file}" > "${output_file}"
  chmod 600 "${output_file}"
  [[ "$(shasum -a 256 "${output_file}" | awk '{print $1}')" == "${expected_plaintext_hash}" ]] || \
    die "Dešifrovaný kontrolný súčet nesedí pre ${artifact_name}."
  jq -e 'type == "object"' "${output_file}" >/dev/null || \
    die "Neplatný JSON objekt v ${artifact_name}."
}

management_request() {
  local method="$1"
  local project_ref="$2"
  local access_token="$3"
  local request_path="$4"
  local output_file="$5"
  local payload_file="${6:-}"
  local curl_config http_code

  curl_config="$(mktemp "${ROOT_DIR}/.context/secrets/.curl-config-apply.XXXXXX")"
  temporary_files+=("${curl_config}")
  {
    print -- 'silent'
    print -- 'show-error'
    print -- "request = \"${method}\""
    printf 'url = "https://api.supabase.com%s"\n' "$(printf "${request_path}" "${project_ref}")"
    printf 'header = "Authorization: Bearer %s"\n' "${access_token}"
    print -- 'header = "Accept: application/json"'
    if [[ -n "${payload_file}" ]]; then
      print -- 'header = "Content-Type: application/json"'
      printf 'data = "@%s"\n' "${payload_file}"
    fi
    printf 'output = "%s"\n' "${output_file}"
    print -- 'write-out = "%{http_code}"'
  } > "${curl_config}"
  chmod 600 "${curl_config}"

  http_code="$(curl --config "${curl_config}")" || \
    die "Management API ${method} zlyhal; cutover ostáva zakázaný."
  [[ "${http_code}" == 2<-> ]] || \
    die "Management API ${method} vrátil HTTP ${http_code}; cutover ostáva zakázaný."
  chmod 600 "${output_file}"
}

project_config_get() {
  local side="$1"
  local service="$2"
  local output_file="$3"
  local project_ref access_token

  if [[ "${side}" == source ]]; then
    project_ref="${SOURCE_PROJECT_REF}"
    access_token="${SOURCE_SUPABASE_ACCESS_TOKEN}"
  else
    project_ref="${TARGET_PROJECT_REF}"
    access_token="${TARGET_SUPABASE_ACCESS_TOKEN}"
  fi
  management_request GET "${project_ref}" "${access_token}" "${service_paths[$service]}" "${output_file}"
  jq -e 'type == "object"' "${output_file}" >/dev/null || \
    die "Management API vrátil neplatný JSON pre ${side}/${service}."
}

project_config_write() {
  local service="$1"
  local payload_file="$2"
  local output_file="${work_dir}/target-write-${service}.json"

  temporary_files+=("${output_file}")
  management_request \
    "${service_methods[$service]}" \
    "${TARGET_PROJECT_REF}" \
    "${TARGET_SUPABASE_ACCESS_TOKEN}" \
    "${service_paths[$service]}" \
    "${output_file}" \
    "${payload_file}"
  applied_services+=("${service}")
}

project_fields() {
  local input_file="$1"
  local fields_json="$2"
  jq -cS --argjson fields "${fields_json}" \
    'with_entries(select(.key as $key | $fields | index($key)))' \
    "${input_file}"
}

normalize_non_secret_config() {
  local service="$1"
  local input_file="$2"

  case "${service}" in
    auth)
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
      ' "${input_file}"
      ;;
    postgrest)
      jq -cS 'del(.jwt_secret)' "${input_file}"
      ;;
    storage)
      jq -cS 'del(.migrationVersion)' "${input_file}"
      ;;
    realtime)
      jq -cS '.' "${input_file}"
      ;;
    *) die "Neznámy config service: ${service}" ;;
  esac
}

without_project_fields() {
  local normalized_json="$1"
  local fields_json="$2"
  jq -cS --argjson fields "${fields_json}" \
    'with_entries(select(.key as $key | $fields | index($key) | not))' \
    <<< "${normalized_json}"
}

auth_secret_features_disabled() {
  local input_file="$1"
  jq -e '
    ([to_entries[]
      | select(.key | test("^external_.*_enabled$"))
      | select(.key != "external_email_enabled")
      | select(.key != "external_anonymous_users_enabled")
      | select(.key != "external_web3_solana_enabled")
      | select(.key != "external_web3_ethereum_enabled")
      | select(.value == true)] | length) == 0 and
    ([to_entries[] | select(.key | test("^hook_.*_enabled$")) | select(.value == true)] | length) == 0 and
    ((.smtp_host // "") == "") and
    ((.smtp_user // "") == "") and
    ((.smtp_pass // "") == "") and
    ((.security_captcha_enabled // false) == false) and
    ((.saml_enabled // false) == false) and
    ((.external_phone_enabled // false) == false) and
    ([
      .sms_messagebird_access_key,
      .sms_messagebird_originator,
      .sms_test_otp,
      .sms_test_otp_valid_until,
      .sms_textlocal_api_key,
      .sms_textlocal_sender,
      .sms_twilio_account_sid,
      .sms_twilio_auth_token,
      .sms_twilio_content_sid,
      .sms_twilio_message_service_sid,
      .sms_twilio_verify_account_sid,
      .sms_twilio_verify_auth_token,
      .sms_twilio_verify_message_service_sid,
      .sms_vonage_api_key,
      .sms_vonage_api_secret,
      .sms_vonage_from
    ] | all(. == null or . == ""))
  ' "${input_file}" >/dev/null
}

if [[ "$#" -ne 2 || ! "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' || "$2" != "--apply-non-secret-config" ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --apply-non-secret-config"
fi
snapshot_id="$1"

[[ -r "${SECRET_FILE}" ]] || die "Chýba bezpečný migračný secret súbor."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi
source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
export MIGRATION_ARCHIVE_PASSPHRASE

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
libpq_url_matches_project \
  "${SOURCE_DB_URL}" \
  "${EXPECTED_SOURCE_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Source DB URL nepatrí očakávanému source projektu."

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
[[ -r "${manifest_file}" ]] || die "Config snapshot manifest neexistuje."
[[ "$(sed -n 's/^source_project_ref=//p' "${manifest_file}")" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Config snapshot source ref nesedí."
[[ "$(sed -n 's/^target_project_ref=//p' "${manifest_file}")" == "${EXPECTED_TARGET_REF}" ]] || \
  die "Config snapshot target ref nesedí."
[[ "$(sed -n 's/^snapshot_id=//p' "${manifest_file}")" == "${snapshot_id}" ]] || \
  die "Config manifest snapshot ID nesedí."
[[ -z "$(sed -n 's/^target_refresh_completed_at_utc=//p' "${manifest_file}")" ]] || \
  die "Finálny target config už bol zachytený; apply sa neopakuje."

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || die "Chýba source freeze receipt."
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

if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source-config-application; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť."
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
    end;" | migration_docker_run --rm -i \
      --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
      --env PGPASSFILE=/run/secrets/pgpass \
      "${POSTGRES_IMAGE}" \
      psql --no-psqlrc --no-align --tuples-only --quiet \
        --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}" | tr -d '[:space:]'
)" || die "Živá source freeze kontrola zlyhala."
[[ "${source_freeze_state}" == "on|0" ]] || \
  die "Source už nie je read-only alebo má aktívny cron; config apply je zakázaný."
libpq_cleanup_credentials
trap - EXIT INT TERM

mkdir -p "${RECEIPT_ROOT}"
chmod 700 "${RECEIPT_ROOT}"
success_receipt="${RECEIPT_ROOT}/${snapshot_id}.env"
[[ ! -e "${success_receipt}" ]] || die "Nesekretný config už bol pre tento snapshot aplikovaný."

work_dir="$(mktemp -d "${ROOT_DIR}/.context/secrets/.config-apply.XXXXXX")"
chmod 700 "${work_dir}"
typeset -a temporary_files applied_services
temporary_files=()
applied_services=()
attempt_id="$(date -u +%Y%m%dT%H%M%SZ)"
attempt_receipt="${RECEIPT_ROOT}/${snapshot_id}-${attempt_id}.env"
completed=false
cleanup() {
  local exit_status="${1:-1}"
  trap - EXIT INT TERM
  rm -f -- "${temporary_files[@]:-}"
  rm -rf -- "${work_dir}"
  if [[ "${completed}" != true ]]; then
    {
      print -- "state=failed"
      print -- "snapshot_id=${snapshot_id}"
      print -- "attempt_id=${attempt_id}"
      print -- "applied_services=${(j:,:)applied_services}"
      print -- "cutover_status=blocked"
      print -- "source_unfrozen=false"
    } > "${attempt_receipt}"
    chmod 600 "${attempt_receipt}"
    (( exit_status != 0 )) || exit_status=1
  fi
  exit "${exit_status}"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

typeset -A service_paths service_methods service_fields
service_paths=(
  auth '/v1/projects/%s/config/auth'
  postgrest '/v1/projects/%s/postgrest'
  storage '/v1/projects/%s/config/storage'
  realtime '/v1/projects/%s/config/realtime'
)
service_methods=(auth PATCH postgrest PATCH storage PATCH realtime PATCH)

# Curated from the current official Management API schema. Only fields that
# differ in this immutable snapshot and do not carry credentials are eligible.
service_fields[auth]='[
  "disable_signup",
  "mailer_autoconfirm",
  "mailer_otp_length",
  "mailer_subjects_confirmation",
  "mailer_subjects_email_change",
  "mailer_subjects_email_changed_notification",
  "mailer_subjects_identity_linked_notification",
  "mailer_subjects_identity_unlinked_notification",
  "mailer_subjects_invite",
  "mailer_subjects_magic_link",
  "mailer_subjects_mfa_factor_enrolled_notification",
  "mailer_subjects_mfa_factor_unenrolled_notification",
  "mailer_subjects_password_changed_notification",
  "mailer_subjects_phone_changed_notification",
  "mailer_subjects_reauthentication",
  "mailer_subjects_recovery",
  "mailer_templates_confirmation_content",
  "mailer_templates_email_change_content",
  "mailer_templates_email_changed_notification_content",
  "mailer_templates_identity_linked_notification_content",
  "mailer_templates_identity_unlinked_notification_content",
  "mailer_templates_invite_content",
  "mailer_templates_magic_link_content",
  "mailer_templates_mfa_factor_enrolled_notification_content",
  "mailer_templates_mfa_factor_unenrolled_notification_content",
  "mailer_templates_password_changed_notification_content",
  "mailer_templates_phone_changed_notification_content",
  "mailer_templates_reauthentication_content",
  "mailer_templates_recovery_content",
  "mfa_totp_enroll_enabled",
  "mfa_totp_verify_enabled",
  "password_required_characters",
  "site_url",
  "smtp_max_frequency",
  "uri_allow_list"
]'
service_fields[postgrest]='["db_extra_search_path", "db_schema"]'
service_fields[storage]='["features"]'
service_fields[realtime]='["connection_pool"]'

print -- "Kontrolujem immutable baseline a live drift bez výpisu config hodnôt..."
for service in auth postgrest storage realtime; do
  baseline_source="${work_dir}/baseline-source-${service}.json"
  baseline_target="${work_dir}/baseline-target-${service}.json"
  live_source="${work_dir}/live-source-${service}.json"
  live_target="${work_dir}/live-target-${service}.json"
  temporary_files+=("${baseline_source}" "${baseline_target}" "${live_source}" "${live_target}")

  verify_and_decrypt "source-${service}.json" "${baseline_source}"
  verify_and_decrypt "target-${service}.json" "${baseline_target}"
  project_config_get source "${service}" "${live_source}"
  project_config_get target "${service}" "${live_target}"

  baseline_source_projection="$(project_fields "${baseline_source}" "${service_fields[$service]}")"
  live_source_projection="$(project_fields "${live_source}" "${service_fields[$service]}")"
  baseline_target_projection="$(project_fields "${baseline_target}" "${service_fields[$service]}")"
  live_target_projection="$(project_fields "${live_target}" "${service_fields[$service]}")"
  baseline_source_normalized="$(normalize_non_secret_config "${service}" "${baseline_source}")"
  live_source_normalized="$(normalize_non_secret_config "${service}" "${live_source}")"
  baseline_target_normalized="$(normalize_non_secret_config "${service}" "${baseline_target}")"
  live_target_normalized="$(normalize_non_secret_config "${service}" "${live_target}")"
  [[ "${live_source_normalized}" == "${baseline_source_normalized}" ]] || \
    die "Source ${service} config sa od snapshotu zmenil; apply bol zastavený."
  if [[ "${live_target_projection}" != "${baseline_target_projection}" && \
        "${live_target_projection}" != "${baseline_source_projection}" ]]; then
    die "Target ${service} config má neočakávaný drift; apply bol zastavený."
  fi
  baseline_target_remainder="$(without_project_fields "${baseline_target_normalized}" "${service_fields[$service]}")"
  live_target_remainder="$(without_project_fields "${live_target_normalized}" "${service_fields[$service]}")"
  [[ "${live_target_remainder}" == "${baseline_target_remainder}" ]] || \
    die "Target ${service} config má drift mimo schváleného allowlistu; apply bol zastavený."

  if [[ "${service}" == auth ]]; then
    auth_secret_features_disabled "${baseline_source}" || \
      die "Source Auth baseline používa skrytú provider/SMTP/SMS/captcha/hook konfiguráciu."
    auth_secret_features_disabled "${live_source}" || \
      die "Source Auth používa skrytú provider/SMTP/SMS/captcha/hook konfiguráciu; automatický apply je zakázaný."
  fi

  payload_json="$(jq -cS 'with_entries(select(.value != null))' <<< "${baseline_source_projection}")"
  target_payload_projection="$(jq -cS --argjson payload "${payload_json}" \
    'with_entries(select(.key as $key | $payload | has($key)))' \
    <<< "${live_target_projection}")"
  payload_file="${work_dir}/payload-${service}.json"
  temporary_files+=("${payload_file}")
  print -r -- "${payload_json}" > "${payload_file}"
  chmod 600 "${payload_file}"
  if [[ "${payload_json}" != "${target_payload_projection}" ]]; then
    project_config_write "${service}" "${payload_file}"
  fi
done

success_receipt_temp="$(mktemp "${RECEIPT_ROOT}/.${snapshot_id}.XXXXXX")"
temporary_files+=("${success_receipt_temp}")
{
  print -- "state=applied"
  print -- "snapshot_id=${snapshot_id}"
  print -- "attempt_id=${attempt_id}"
  print -- "applied_services=${(j:,:)applied_services}"
  print -- "source_config_drift=false"
  print -- "target_config_drift=false"
  print -- "secret_bearing_auth_features_detected=false"
  print -- "cutover_status=blocked_pending_final_config_and_application_validation"
  print -- "source_unfrozen=false"
} > "${success_receipt_temp}"
chmod 600 "${success_receipt_temp}"
mv "${success_receipt_temp}" "${success_receipt}"

completed=true
rm -f -- "${temporary_files[@]:-}"
rm -rf -- "${work_dir}"
trap - EXIT INT TERM
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN MIGRATION_ARCHIVE_PASSPHRASE

print -- "Nesekretný target config bol aplikovaný bez prenosu hesiel, tokenov alebo JWT."
print -- "Cutover ostáva blokovaný finálnym config capture a aplikačnými smoke testami."
