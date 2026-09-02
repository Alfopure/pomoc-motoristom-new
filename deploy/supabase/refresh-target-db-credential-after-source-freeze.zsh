#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

[[ "$#" -eq 1 && "$1" == "--refresh-target-with-source-readonly-api" ]] || \
  die "Použitie: ${0:t} --refresh-target-with-source-readonly-api"
[[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
(( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) == 0 )) || \
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
: "${SOURCE_STORAGE_ENDPOINT:?SOURCE_STORAGE_ENDPOINT chýba}"
: "${SOURCE_STORAGE_REGION:?SOURCE_STORAGE_REGION chýba}"
: "${SOURCE_STORAGE_ACCESS_KEY_ID:?SOURCE_STORAGE_ACCESS_KEY_ID chýba}"
: "${SOURCE_STORAGE_SECRET_ACCESS_KEY:?SOURCE_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_ENDPOINT:?TARGET_STORAGE_ENDPOINT chýba}"
: "${TARGET_STORAGE_REGION:?TARGET_STORAGE_REGION chýba}"
: "${TARGET_STORAGE_ACCESS_KEY_ID:?TARGET_STORAGE_ACCESS_KEY_ID chýba}"
: "${TARGET_STORAGE_SECRET_ACCESS_KEY:?TARGET_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_AUTH_MODE:?TARGET_STORAGE_AUTH_MODE chýba}"

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
[[ "$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" == "on|0" ]] || \
  die "Source nie je cez Management API potvrdene frozen on|0."

old_receipt="${MIGRATION_DB_CREDENTIAL_RECEIPT:-}"
: "${MIGRATION_DB_CREDENTIAL_MODE:?MIGRATION_DB_CREDENTIAL_MODE chýba}"
: "${MIGRATION_DB_CREDENTIAL_EXPIRES_AT:?Expirácia predĺženej DB roly chýba}"
: "${MIGRATION_TARGET_DB_ROLE:?Target DB rola chýba}"
: "${old_receipt:?Predchádzajúci credential receipt chýba}"
[[ "${old_receipt}" == "${ROOT_DIR}/.context/migration/db-credential-receipts/"*.env && -r "${old_receipt}" ]] || \
  die "Predchádzajúci credential receipt nie je povolený."
(( (8#$(stat -f '%Lp' "${old_receipt}") & 8#077) == 0 )) || \
  die "Predchádzajúci credential receipt musí byť súkromný."
node -e '
  const expiresAt = Date.parse(process.argv[1]);
  if (!Number.isFinite(expiresAt) || expiresAt >= Date.now()) process.exit(1);
' "${MIGRATION_DB_CREDENTIAL_EXPIRES_AT}" || \
  die "Stále platnú alebo neplatne datovanú target CLI rolu nemožno prepísať."

receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${old_receipt}" | tail -n 1
}
case "${MIGRATION_DB_CREDENTIAL_MODE}" in
  extended_cli_role)
    [[ "$(receipt_value state)" == active_extended_cli_roles ]] || \
      die "Predchádzajúci receipt nepotvrdzuje expirované roly na oboch projektoch."
    ;;
  target_extended_cli_source_management_api)
    [[ "$(receipt_value state)" == active_extended_target_cli_source_management_api ]] || \
      die "Predchádzajúci receipt nepotvrdzuje expirovanú target rolu."
    ;;
  *) die "Target refresh nepodporuje aktuálny credential režim." ;;
esac
[[ "$(receipt_value target_role)" == "${MIGRATION_TARGET_DB_ROLE}" ]] || \
  die "Target rola nesedí s predchádzajúcim receiptom."

typeset -a pgpass_files
pgpass_files=("${ROOT_DIR}/.context/secrets"/.pgpass-*(N))
if (( ${#pgpass_files[@]} > 0 )) && lsof -t -- "${pgpass_files[@]}" >/dev/null 2>&1; then
  die "Aspoň jeden proces stále používa dočasný pgpass; target rola nebola zmenená."
fi

export TARGET_SUPABASE_ACCESS_TOKEN
encoded_target_url="$(node --input-type=module -e '
  const endpoint = "https://api.supabase.com/v1/projects/sjcsrygkkmersoczpunh/cli/login-role";
  await fetch(endpoint, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.TARGET_SUPABASE_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TARGET_SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ read_only: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !/^cli_login_[a-z0-9_]+$/.test(String(body.role ?? "")) ||
      !body.password || /[\r\n]/.test(body.password)) {
    throw new Error(`Target temporary DB role request failed (HTTP ${response.status}).`);
  }
  const url = new URL("postgresql://db.sjcsrygkkmersoczpunh.supabase.co:25432/postgres");
  url.username = body.role;
  url.password = body.password;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "/run/secrets/supabase-ca.crt");
  url.searchParams.set("connect_timeout", "10");
  process.stdout.write(Buffer.from(url.toString()).toString("base64"));
')" || die "Target dočasná DB rola sa nepodarila vytvoriť."
TARGET_DB_URL="$(print -rn -- "${encoded_target_url}" | openssl base64 -d -A)"
unset encoded_target_url
libpq_url_matches_project "${TARGET_DB_URL}" "${EXPECTED_TARGET_REF}" 0 || \
  die "Target DB URL neprešlo relay identitou a TLS kontrolou."

temporary_file="$(mktemp "${ROOT_DIR}/.context/secrets/.supabase-dispatch-migration.XXXXXX")"
trap 'rm -f -- "${temporary_file}"' EXIT INT TERM
{
  printf 'SOURCE_PROJECT_REF=%q\n' "${SOURCE_PROJECT_REF}"
  printf 'TARGET_PROJECT_REF=%q\n' "${TARGET_PROJECT_REF}"
  print -- 'SOURCE_DB_VALIDATION_MODE=management_api_read_only'
  printf 'TARGET_DB_URL=%q\n' "${TARGET_DB_URL}"
  printf 'MIGRATION_ARCHIVE_PASSPHRASE=%q\n' "${MIGRATION_ARCHIVE_PASSPHRASE}"
  print -- 'MIGRATION_DOCKER_SSH_RELAY=1'
  print -- 'MIGRATION_DB_CREDENTIAL_MODE=target_temporary_cli_source_management_api'
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

if [[ -n "${old_receipt}" ]]; then
  {
    print -- "state=expired_source_role_replaced_by_management_api_target_refreshed"
    print -- "replaced_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "cleanup_state=expired_roles_replaced_or_deleted"
  } >> "${old_receipt}"
  chmod 600 "${old_receipt}"
fi

unset TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset SOURCE_STORAGE_ACCESS_KEY_ID SOURCE_STORAGE_SECRET_ACCESS_KEY
unset TARGET_STORAGE_ACCESS_KEY_ID TARGET_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_SESSION_TOKEN
print -- "Source freeze bol potvrdený read-only Management API a target DB rola bola bezpečne obnovená."
