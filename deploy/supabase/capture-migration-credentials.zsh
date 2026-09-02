#!/bin/zsh

set -euo pipefail
umask 077

readonly SOURCE_PROJECT_REF="jcwbiulwuwyrnmzjjbgr"
readonly TARGET_PROJECT_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_DIR="${ROOT_DIR}/.context/secrets"
readonly SECRET_FILE="${SECRET_DIR}/supabase-dispatch-migration.env"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

mkdir -p "${SECRET_DIR}"
chmod 700 "${SECRET_DIR}"

prompt_secret() {
  local variable_name="$1"
  local prompt="$2"
  read -rs "${variable_name}?${prompt}"
  print
}

require_project_ref() {
  local label="$1"
  local value="$2"
  local project_ref="$3"

  if ! libpq_url_matches_project \
    "${value}" \
    "${project_ref}" \
    "${MIGRATION_LOCAL_REHEARSAL:-0}"; then
    print -u2 -- "${label} musí byť úplný Session pooler alebo direct Postgres URL pre projekt ${project_ref}."
    exit 1
  fi
}

prompt_secret SOURCE_DB_URL "Source DB URL z Connect dialógu (heslo sa nezobrazí): "
prompt_secret TARGET_DB_URL "Target DB URL z Connect dialógu (heslo sa nezobrazí): "

require_project_ref "SOURCE_DB_URL" "${SOURCE_DB_URL}" "${SOURCE_PROJECT_REF}"
require_project_ref "TARGET_DB_URL" "${TARGET_DB_URL}" "${TARGET_PROJECT_REF}"

prompt_secret MIGRATION_ARCHIVE_PASSPHRASE "Heslo na šifrovanie dumpu (min. 20 znakov): "
prompt_secret MIGRATION_ARCHIVE_PASSPHRASE_CONFIRM "Zopakuj heslo na šifrovanie dumpu: "

if (( ${#MIGRATION_ARCHIVE_PASSPHRASE} < 20 )) ||
   [[ "${MIGRATION_ARCHIVE_PASSPHRASE}" != "${MIGRATION_ARCHIVE_PASSPHRASE_CONFIRM}" ]]; then
  print -u2 -- "Heslá sa nezhodujú alebo majú menej než 20 znakov. Súbor nebol zmenený."
  exit 1
fi

prompt_secret SOURCE_SUPABASE_ACCESS_TOKEN "Source PAT pre config audit (Enter = zatiaľ preskočiť): "
prompt_secret TARGET_SUPABASE_ACCESS_TOKEN "Target PAT pre config sync (Enter = zatiaľ preskočiť): "

prompt_secret SOURCE_STORAGE_ACCESS_KEY_ID "Source S3 access key (Enter = Storage zatiaľ preskočiť): "

SOURCE_STORAGE_SECRET_ACCESS_KEY=""
SOURCE_STORAGE_REGION=""
TARGET_STORAGE_ACCESS_KEY_ID=""
TARGET_STORAGE_SECRET_ACCESS_KEY=""
TARGET_STORAGE_AUTH_MODE=""
TARGET_STORAGE_SESSION_TOKEN=""
TARGET_STORAGE_REGION="eu-central-1"

if [[ -n "${SOURCE_STORAGE_ACCESS_KEY_ID}" ]]; then
  prompt_secret SOURCE_STORAGE_SECRET_ACCESS_KEY "Source S3 secret key: "
  prompt_secret SOURCE_STORAGE_REGION "Source S3 region: "
  read "TARGET_STORAGE_AUTH_MODE?Target Storage auth (generated_pair/session_token): "
  case "${TARGET_STORAGE_AUTH_MODE}" in
    generated_pair)
      prompt_secret TARGET_STORAGE_ACCESS_KEY_ID "Target S3 access key: "
      prompt_secret TARGET_STORAGE_SECRET_ACCESS_KEY "Target S3 secret key: "
      ;;
    session_token)
      TARGET_STORAGE_ACCESS_KEY_ID="${TARGET_PROJECT_REF}"
      prompt_secret TARGET_STORAGE_SECRET_ACCESS_KEY "Target legacy anon key: "
      prompt_secret TARGET_STORAGE_SESSION_TOKEN "Target service-role session token: "
      ;;
    *)
      print -u2 -- "Target Storage auth musí byť generated_pair alebo session_token."
      exit 1
      ;;
  esac
  prompt_secret TARGET_STORAGE_REGION_INPUT "Target S3 region (Enter = eu-central-1): "
  TARGET_STORAGE_REGION="${TARGET_STORAGE_REGION_INPUT:-eu-central-1}"

  if [[ -z "${SOURCE_STORAGE_SECRET_ACCESS_KEY}" ||
        -z "${SOURCE_STORAGE_REGION}" ||
        -z "${TARGET_STORAGE_ACCESS_KEY_ID}" ||
        -z "${TARGET_STORAGE_SECRET_ACCESS_KEY}" ||
        ( "${TARGET_STORAGE_AUTH_MODE}" == session_token && -z "${TARGET_STORAGE_SESSION_TOKEN}" ) ]]; then
    print -u2 -- "Storage údaje sú neúplné. Súbor nebol zmenený."
    exit 1
  fi
fi

temporary_file="$(mktemp "${SECRET_DIR}/.supabase-dispatch-migration.XXXXXX")"
trap 'rm -f "${temporary_file}"' EXIT

{
  printf 'SOURCE_PROJECT_REF=%q\n' "${SOURCE_PROJECT_REF}"
  printf 'TARGET_PROJECT_REF=%q\n' "${TARGET_PROJECT_REF}"
  printf 'SOURCE_DB_URL=%q\n' "${SOURCE_DB_URL}"
  printf 'TARGET_DB_URL=%q\n' "${TARGET_DB_URL}"
  printf 'MIGRATION_ARCHIVE_PASSPHRASE=%q\n' "${MIGRATION_ARCHIVE_PASSPHRASE}"
  if [[ "${MIGRATION_LOCAL_REHEARSAL:-0}" == 1 ]]; then
    print -- 'MIGRATION_LOCAL_REHEARSAL=1'
  fi

  if [[ -n "${SOURCE_SUPABASE_ACCESS_TOKEN}" ]]; then
    printf 'SOURCE_SUPABASE_ACCESS_TOKEN=%q\n' "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  fi
  if [[ -n "${TARGET_SUPABASE_ACCESS_TOKEN}" ]]; then
    printf 'TARGET_SUPABASE_ACCESS_TOKEN=%q\n' "${TARGET_SUPABASE_ACCESS_TOKEN}"
  fi

  if [[ -n "${SOURCE_STORAGE_ACCESS_KEY_ID}" ]]; then
    printf 'SOURCE_STORAGE_ENDPOINT=%q\n' "https://${SOURCE_PROJECT_REF}.storage.supabase.co/storage/v1/s3"
    printf 'SOURCE_STORAGE_REGION=%q\n' "${SOURCE_STORAGE_REGION}"
    printf 'SOURCE_STORAGE_ACCESS_KEY_ID=%q\n' "${SOURCE_STORAGE_ACCESS_KEY_ID}"
    printf 'SOURCE_STORAGE_SECRET_ACCESS_KEY=%q\n' "${SOURCE_STORAGE_SECRET_ACCESS_KEY}"
    printf 'TARGET_STORAGE_ENDPOINT=%q\n' "https://${TARGET_PROJECT_REF}.storage.supabase.co/storage/v1/s3"
    printf 'TARGET_STORAGE_REGION=%q\n' "${TARGET_STORAGE_REGION}"
    printf 'TARGET_STORAGE_ACCESS_KEY_ID=%q\n' "${TARGET_STORAGE_ACCESS_KEY_ID}"
    printf 'TARGET_STORAGE_SECRET_ACCESS_KEY=%q\n' "${TARGET_STORAGE_SECRET_ACCESS_KEY}"
    printf 'TARGET_STORAGE_AUTH_MODE=%q\n' "${TARGET_STORAGE_AUTH_MODE}"
    if [[ -n "${TARGET_STORAGE_SESSION_TOKEN}" ]]; then
      printf 'TARGET_STORAGE_SESSION_TOKEN=%q\n' "${TARGET_STORAGE_SESSION_TOKEN}"
    fi
  fi
} > "${temporary_file}"

chmod 600 "${temporary_file}"
mv -f "${temporary_file}" "${SECRET_FILE}"
trap - EXIT

unset SOURCE_DB_URL TARGET_DB_URL
unset MIGRATION_ARCHIVE_PASSPHRASE MIGRATION_ARCHIVE_PASSPHRASE_CONFIRM
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset SOURCE_STORAGE_ACCESS_KEY_ID SOURCE_STORAGE_SECRET_ACCESS_KEY SOURCE_STORAGE_REGION
unset TARGET_STORAGE_ACCESS_KEY_ID TARGET_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_REGION TARGET_STORAGE_REGION_INPUT
unset TARGET_STORAGE_AUTH_MODE TARGET_STORAGE_SESSION_TOKEN

print -- "Migračné údaje boli bezpečne a atomicky uložené do .context/secrets/supabase-dispatch-migration.env (600)."
