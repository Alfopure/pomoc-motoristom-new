#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly RECEIPT_ROOT="${ROOT_DIR}/.context/migration/db-credential-receipts"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

run_target_sql() {
  local sql="$1"
  libpq_prepare_credentials "${TARGET_DB_URL}" "${ROOT_DIR}/.context/secrets" extend-target-only || \
    die "Target DB URL sa nepodarilo bezpečne pripraviť."
  local result
  result="$(print -r -- "${sql}" | migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}" | tr -d '[:space:]')" || {
    libpq_cleanup_credentials
    return 1
  }
  libpq_cleanup_credentials
  [[ "${result}" == target_extended_role=ok ]]
}

[[ "$#" -eq 1 && "$1" == "--extend-target-to-eight-hours" ]] || \
  die "Použitie: ${0:t} --extend-target-to-eight-hours"
[[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
(( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) == 0 )) || \
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_DB_VALIDATION_MODE:?SOURCE_DB_VALIDATION_MODE chýba}"
: "${TARGET_DB_URL:?TARGET_DB_URL chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
[[ "${SOURCE_DB_VALIDATION_MODE}" == management_api_read_only ]] || die "Source validácia nie je read-only Management API."
[[ "${MIGRATION_DB_CREDENTIAL_MODE:-}" == target_temporary_cli_source_management_api ]] || \
  die "Target DB credential režim nie je čerstvý temporary CLI."
libpq_url_matches_project "${TARGET_DB_URL}" "${EXPECTED_TARGET_REF}" 0 || die "Target DB URL nesedí."
[[ "$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" == on\|0 ]] || \
  die "Source už nie je potvrdene frozen on|0."

export TARGET_DB_URL
target_role="$(node -e '
  const role = decodeURIComponent(new URL(process.env.TARGET_DB_URL).username);
  if (!/^cli_login_[a-z0-9_]+$/.test(role)) process.exit(1);
  process.stdout.write(role);
')" || die "Target dočasnú rolu sa nepodarilo overiť."
expires_at="$(node -e 'process.stdout.write(new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString())')"
[[ "${expires_at}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' ]] || \
  die "Neplatný čas expirácie."

mkdir -p "${RECEIPT_ROOT}"
chmod 700 "${RECEIPT_ROOT}"
receipt_file="${RECEIPT_ROOT}/$(date -u +%Y%m%d%H%M%S)-target-only.env"
[[ ! -e "${receipt_file}" ]] || die "Credential receipt už existuje."
{
  print -- "state=preparing_target_extension_source_management_api"
  print -- "target_role=${target_role}"
  print -- "expires_at_utc=${expires_at}"
  print -- "cleanup_state=pending_control_plane_delete"
} > "${receipt_file}"
chmod 600 "${receipt_file}"

target_sql="alter role ${target_role} valid until '${expires_at}';
select case when session_user = '${target_role}'
  and current_user = 'postgres'
  and pg_catalog.pg_has_role(session_user, 'postgres', 'MEMBER')
  and (select rolvaliduntil from pg_catalog.pg_roles where rolname = session_user)
    > pg_catalog.clock_timestamp() + interval '7 hours 55 minutes'
then 'target_extended_role=ok' else 'target_extended_role=invalid' end;"
if ! run_target_sql "${target_sql}"; then
  {
    print -- "state=failed_target_extension"
    print -- "cleanup_state=control_plane_delete_recommended"
  } >> "${receipt_file}"
  die "Target CLI rolu sa nepodarilo predĺžiť."
fi

temporary_file="$(mktemp "${ROOT_DIR}/.context/secrets/.supabase-dispatch-migration.XXXXXX")"
trap 'rm -f -- "${temporary_file}"' EXIT INT TERM
{
  printf 'SOURCE_PROJECT_REF=%q\n' "${SOURCE_PROJECT_REF}"
  printf 'TARGET_PROJECT_REF=%q\n' "${TARGET_PROJECT_REF}"
  print -- 'SOURCE_DB_VALIDATION_MODE=management_api_read_only'
  printf 'TARGET_DB_URL=%q\n' "${TARGET_DB_URL}"
  printf 'MIGRATION_ARCHIVE_PASSPHRASE=%q\n' "${MIGRATION_ARCHIVE_PASSPHRASE}"
  print -- 'MIGRATION_DOCKER_SSH_RELAY=1'
  print -- 'MIGRATION_DB_CREDENTIAL_MODE=target_extended_cli_source_management_api'
  printf 'MIGRATION_DB_CREDENTIAL_EXPIRES_AT=%q\n' "${expires_at}"
  printf 'MIGRATION_TARGET_DB_ROLE=%q\n' "${target_role}"
  printf 'MIGRATION_DB_CREDENTIAL_RECEIPT=%q\n' "${receipt_file}"
  printf 'SOURCE_SUPABASE_ACCESS_TOKEN=%q\n' "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  printf 'TARGET_SUPABASE_ACCESS_TOKEN=%q\n' "${TARGET_SUPABASE_ACCESS_TOKEN}"
  printf 'SOURCE_STORAGE_ENDPOINT=%q\n' "${SOURCE_STORAGE_ENDPOINT}"
  printf 'SOURCE_STORAGE_REGION=%q\n' "${SOURCE_STORAGE_REGION}"
  printf 'SOURCE_STORAGE_ACCESS_KEY_ID=%q\n' "${SOURCE_STORAGE_ACCESS_KEY_ID}"
  printf 'SOURCE_STORAGE_SECRET_ACCESS_KEY=%q\n' "${SOURCE_STORAGE_SECRET_ACCESS_KEY}"
  printf 'TARGET_STORAGE_ENDPOINT=%q\n' "${TARGET_STORAGE_ENDPOINT}"
  printf 'TARGET_STORAGE_REGION=%q\n' "${TARGET_STORAGE_REGION}"
  printf 'TARGET_STORAGE_ACCESS_KEY_ID=%q\n' "${TARGET_STORAGE_ACCESS_KEY_ID}"
  printf 'TARGET_STORAGE_SECRET_ACCESS_KEY=%q\n' "${TARGET_STORAGE_SECRET_ACCESS_KEY}"
  printf 'TARGET_STORAGE_AUTH_MODE=%q\n' "${TARGET_STORAGE_AUTH_MODE}"
  [[ -z "${TARGET_STORAGE_SESSION_TOKEN:-}" ]] || \
    printf 'TARGET_STORAGE_SESSION_TOKEN=%q\n' "${TARGET_STORAGE_SESSION_TOKEN}"
} > "${temporary_file}"
chmod 600 "${temporary_file}"
mv -f "${temporary_file}" "${SECRET_FILE}"
trap - EXIT INT TERM

{
  print -- "state=active_extended_target_cli_source_management_api"
  print -- "target_role=${target_role}"
  print -- "extended_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "expires_at_utc=${expires_at}"
  print -- "cleanup_state=pending_control_plane_delete"
} > "${receipt_file}"
chmod 600 "${receipt_file}"

unset TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE
print -- "Target odvolateľná CLI rola má overenú osemhodinovú platnosť; source zostal read-only."
print -- "Credential receipt: .context/migration/db-credential-receipts/${receipt_file:t}"
