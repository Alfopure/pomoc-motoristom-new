#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly VALIDATOR="${ROOT_DIR}/deploy/bin/validate-storage-rest.mjs"

die() {
  print -u2 -- "$1"
  exit 1
}

[[ ( "$#" -eq 1 || ( "$#" -eq 2 && "$2" == --capture-transition ) ) \
  && "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ [--capture-transition]"
[[ -r "${SECRET_FILE}" && -f "${SECRET_FILE}" && ! -L "${SECRET_FILE}" && -f "${VALIDATOR}" ]] || \
  die "Chýba bezpečný migračný secret súbor alebo Storage REST validátor."
(( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) == 0 )) || \
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."
[[ "$(stat -f '%l' "${SECRET_FILE}")" == 1 ]] || die "Migračný secret súbor nesmie mať hardlinky."
[[ "$(stat -f '%u' "${SECRET_FILE}")" == "$(id -u)" ]] || die "Migračný secret súbor musí vlastniť aktuálny používateľ."

# Never source credentials while shell tracing or verbose input echo is active.
[[ -o xtrace ]] && set +x
[[ -o verbose ]] && set +v
source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
[[ "${SOURCE_DB_VALIDATION_MODE:-database_url}" == management_api_read_only ]] || \
  die "Source Storage sa smie validovať iba cez read-only Management API režim."

cleanup() {
  unset STORAGE_VALIDATOR_SOURCE_REF STORAGE_VALIDATOR_TARGET_REF
  unset STORAGE_VALIDATOR_SOURCE_PAT STORAGE_VALIDATOR_TARGET_PAT
  unset MIGRATION_ARCHIVE_PASSPHRASE SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export STORAGE_VALIDATOR_SOURCE_REF="${SOURCE_PROJECT_REF}"
export STORAGE_VALIDATOR_TARGET_REF="${TARGET_PROJECT_REF}"
export STORAGE_VALIDATOR_SOURCE_PAT="${SOURCE_SUPABASE_ACCESS_TOKEN}"
export STORAGE_VALIDATOR_TARGET_PAT="${TARGET_SUPABASE_ACCESS_TOKEN}"
export MIGRATION_ARCHIVE_PASSPHRASE

node "${VALIDATOR}" "$@"
