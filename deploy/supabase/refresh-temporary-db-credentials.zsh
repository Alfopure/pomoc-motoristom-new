#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

[[ "$#" -eq 1 && "$1" == "--refresh-both-projects" ]] || \
  die "Použitie: ${0:t} --refresh-both-projects"
[[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

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
replacing_expired_extended=0
if [[ "${MIGRATION_DB_CREDENTIAL_MODE:-temporary_cli}" == extended_cli_role ]]; then
  : "${MIGRATION_DB_CREDENTIAL_EXPIRES_AT:?Expirácia predĺžených DB rolí chýba.}"
  : "${MIGRATION_SOURCE_DB_ROLE:?Source DB rola chýba.}"
  : "${MIGRATION_TARGET_DB_ROLE:?Target DB rola chýba.}"
  : "${MIGRATION_DB_CREDENTIAL_RECEIPT:?Credential receipt chýba.}"
  [[ "${MIGRATION_DB_CREDENTIAL_RECEIPT}" == \
    "${ROOT_DIR}/.context/migration/db-credential-receipts/"*.env ]] || \
    die "Credential receipt cesta nie je povolená."
  [[ -r "${MIGRATION_DB_CREDENTIAL_RECEIPT}" ]] || die "Credential receipt nie je čitateľný."
  node -e '
    const expiresAt = Date.parse(process.argv[1]);
    if (!Number.isFinite(expiresAt) || expiresAt >= Date.now()) process.exit(1);
  ' "${MIGRATION_DB_CREDENTIAL_EXPIRES_AT}" || \
    die "Aktívne alebo neplatne datované predĺžené DB roly nemožno prepísať."

  receipt_value() {
    local key="$1"
    sed -n "s/^${key}=//p" "${MIGRATION_DB_CREDENTIAL_RECEIPT}" | tail -n 1
  }
  [[ "$(receipt_value state)" == active_extended_cli_roles ]] || \
    die "Credential receipt nemá očakávaný aktívny stav."
  [[ "$(receipt_value source_role)" == "${MIGRATION_SOURCE_DB_ROLE}" ]] || \
    die "Source rola nesedí s credential receiptom."
  [[ "$(receipt_value target_role)" == "${MIGRATION_TARGET_DB_ROLE}" ]] || \
    die "Target rola nesedí s credential receiptom."
  replacing_expired_extended=1
elif [[ "${MIGRATION_DB_CREDENTIAL_MODE:-temporary_cli}" != temporary_cli ]]; then
  die "Neznámy režim DB credentials."
fi
MIGRATION_DOCKER_SSH_RELAY=1

export SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
typeset -a encoded_urls
encoded_urls=("${(@f)$(node --input-type=module -e '
  const projects = [
    { ref: "jcwbiulwuwyrnmzjjbgr", port: "15432", token: process.env.SOURCE_SUPABASE_ACCESS_TOKEN },
    { ref: "sjcsrygkkmersoczpunh", port: "25432", token: process.env.TARGET_SUPABASE_ACCESS_TOKEN },
  ];
  const requestRole = async ({ ref, port, token }) => {
    const endpoint = `https://api.supabase.com/v1/projects/${ref}/cli/login-role`;
    await fetch(endpoint, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ read_only: false }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !/^cli_login_[a-z0-9_]+$/.test(String(body.role ?? "")) ||
        !body.password || /[\r\n]/.test(body.password)) {
      throw new Error(`Temporary DB role request failed (${ref}, HTTP ${response.status}).`);
    }
    const url = new URL(`postgresql://db.${ref}.supabase.co:${port}/postgres`);
    url.username = body.role;
    url.password = body.password;
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.set("sslrootcert", "/run/secrets/supabase-ca.crt");
    url.searchParams.set("connect_timeout", "10");
    return Buffer.from(url.toString()).toString("base64");
  };
  for (const project of projects) console.log(await requestRole(project));
')}" )
(( ${#encoded_urls[@]} == 2 )) || die "Management API nevrátilo obe dočasné DB URL."

decode_base64() {
  print -rn -- "$1" | openssl base64 -d -A
}

SOURCE_DB_URL="$(decode_base64 "${encoded_urls[1]}")"
TARGET_DB_URL="$(decode_base64 "${encoded_urls[2]}")"
unset encoded_urls

libpq_url_matches_project "${SOURCE_DB_URL}" "${EXPECTED_SOURCE_REF}" 0 || \
  die "Obnovené source DB URL neprešlo kontrolou."
libpq_url_matches_project "${TARGET_DB_URL}" "${EXPECTED_TARGET_REF}" 0 || \
  die "Obnovené target DB URL neprešlo kontrolou."

temporary_file="$(mktemp "${ROOT_DIR}/.context/secrets/.supabase-dispatch-migration.XXXXXX")"
trap 'rm -f -- "${temporary_file}"' EXIT INT TERM
{
  printf 'SOURCE_PROJECT_REF=%q\n' "${SOURCE_PROJECT_REF}"
  printf 'TARGET_PROJECT_REF=%q\n' "${TARGET_PROJECT_REF}"
  printf 'SOURCE_DB_URL=%q\n' "${SOURCE_DB_URL}"
  printf 'TARGET_DB_URL=%q\n' "${TARGET_DB_URL}"
  printf 'MIGRATION_ARCHIVE_PASSPHRASE=%q\n' "${MIGRATION_ARCHIVE_PASSPHRASE}"
  print -- 'MIGRATION_DOCKER_SSH_RELAY=1'
  print -- 'MIGRATION_DB_CREDENTIAL_MODE=temporary_cli'
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
  if [[ -n "${TARGET_STORAGE_SESSION_TOKEN:-}" ]]; then
    printf 'TARGET_STORAGE_SESSION_TOKEN=%q\n' "${TARGET_STORAGE_SESSION_TOKEN}"
  fi
} > "${temporary_file}"
chmod 600 "${temporary_file}"
mv -f "${temporary_file}" "${SECRET_FILE}"
trap - EXIT INT TERM

if [[ "${replacing_expired_extended}" == 1 ]]; then
  {
    print -- "state=expired_replaced_by_fresh_temporary_cli"
    print -- "replaced_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "cleanup_state=complete_control_plane_replaced"
  } >> "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
  chmod 600 "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
fi

unset SOURCE_DB_URL TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset SOURCE_STORAGE_ACCESS_KEY_ID SOURCE_STORAGE_SECRET_ACCESS_KEY
unset TARGET_STORAGE_ACCESS_KEY_ID TARGET_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_SESSION_TOKEN
print -- "Dočasné DB prístupy pre source aj target boli atomicky obnovené."
