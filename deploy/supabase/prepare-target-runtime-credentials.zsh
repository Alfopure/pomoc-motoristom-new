#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_DIR="${ROOT_DIR}/.context/secrets"
readonly MIGRATION_SECRET_FILE="${SECRET_DIR}/supabase-dispatch-migration.env"
readonly OUTPUT_FILE="${SECRET_DIR}/runtime-overrides.env"

die() {
  print -u2 -- "$1"
  exit 1
}

[[ "$#" -eq 1 && "$1" == "--prepare-frankfurt-runtime" ]] || \
  die "Použitie: ${0:t} --prepare-frankfurt-runtime"
[[ -r "${MIGRATION_SECRET_FILE}" ]] || die "Chýba bezpečný migračný secret súbor."
if (( (8#$(stat -f '%Lp' "${MIGRATION_SECRET_FILE}") & 8#077) != 0 )); then
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${MIGRATION_SECRET_FILE}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."

mkdir -p "${SECRET_DIR}"
chmod 700 "${SECRET_DIR}"
response_file="$(mktemp "${SECRET_DIR}/.target-api-keys.XXXXXX")"
curl_config="$(mktemp "${SECRET_DIR}/.target-api-keys-curl.XXXXXX")"
output_temp="$(mktemp "${SECRET_DIR}/.runtime-overrides.XXXXXX")"
cleanup() {
  rm -f -- "${response_file}" "${curl_config}" "${output_temp}"
  unset TARGET_SUPABASE_ACCESS_TOKEN publishable_key secret_key
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

{
  print -- 'silent'
  print -- 'show-error'
  print -- 'fail-with-body'
  print -- 'proto = "=https"'
  print -- 'connect-timeout = 10'
  print -- 'max-time = 30'
  print -- 'request = "GET"'
  printf 'url = "https://api.supabase.com/v1/projects/%s/api-keys?reveal=true"\n' "${EXPECTED_TARGET_REF}"
  printf 'header = "Authorization: Bearer %s"\n' "${TARGET_SUPABASE_ACCESS_TOKEN}"
  print -- 'header = "Accept: application/json"'
  printf 'output = "%s"\n' "${response_file}"
} > "${curl_config}"
chmod 600 "${response_file}" "${curl_config}" "${output_temp}"

curl -q --config "${curl_config}" || die "Target API keys sa nepodarilo bezpečne načítať."
jq -e 'type == "array"' "${response_file}" >/dev/null || die "Management API vrátilo neplatný zoznam API keys."

publishable_key="$(jq -er '
  [.[] | select(
    .type == "publishable" and
    .name == "default" and
    ((.api_key | type) == "string") and
    (.api_key | test("^sb_publishable_[A-Za-z0-9_-]+$"))
  )]
  | if length == 1 then .[0].api_key else error("expected one default publishable key") end
' "${response_file}")" || die "Target nemá práve jeden odhalený default publishable key."
secret_key="$(jq -er '
  [.[] | select(
    .type == "secret" and
    .name == "default" and
    ((.api_key | type) == "string") and
    (.api_key | test("^sb_secret_[A-Za-z0-9_-]+$"))
  )]
  | if length == 1 then .[0].api_key else error("expected one default secret key") end
' "${response_file}")" || die "Target nemá práve jeden odhalený default secret key."

target_url="https://${EXPECTED_TARGET_REF}.supabase.co"
{
  printf 'SUPABASE_URL=%q\n' "${target_url}"
  printf 'NEXT_PUBLIC_SUPABASE_URL=%q\n' "${target_url}"
  printf 'SUPABASE_PUBLISHABLE_KEY=%q\n' "${publishable_key}"
  printf 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=%q\n' "${publishable_key}"
  printf 'SUPABASE_ANON_KEY=%q\n' "${publishable_key}"
  printf 'NEXT_PUBLIC_SUPABASE_ANON_KEY=%q\n' "${publishable_key}"
  printf 'SUPABASE_SECRET_KEY=%q\n' "${secret_key}"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%q\n' "${secret_key}"
  printf 'SUPABASE_PROJECT_REF=%q\n' "${EXPECTED_TARGET_REF}"
  print -- 'SUPABASE_JWT_SECRET='
} > "${output_temp}"
chmod 600 "${output_temp}"
mv -f "${output_temp}" "${OUTPUT_FILE}"

trap - EXIT INT TERM
cleanup
print -- "Frankfurt runtime credentials sú bezpečne uložené v .context/secrets/runtime-overrides.env (600); hodnoty neboli vypísané."
