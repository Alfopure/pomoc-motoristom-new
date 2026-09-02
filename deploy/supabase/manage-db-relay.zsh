#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly RELAY_HOST="195.201.36.90"
readonly RELAY_USER="deploy"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SOCKET_FILE="${HOME}/.ssh/harare-supabase-relay.sock"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

relay_check() {
  [[ -S "${SOCKET_FILE}" ]] || return 1
  ssh -S "${SOCKET_FILE}" -O check "${RELAY_USER}@${RELAY_HOST}" >/dev/null 2>&1
}

start_relay() {
  if relay_check; then
    print -- "Supabase DB relay už beží."
    return
  fi
  rm -f -- "${SOCKET_FILE}"

  ssh -M -S "${SOCKET_FILE}" -fN \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="${HOME}/.ssh/known_hosts" \
    -o IdentitiesOnly=yes \
    -o IdentityFile="${HOME}/.ssh/id_ed25519" \
    -o ForwardAgent=no \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 \
    -L "127.0.0.1:15432:db.${EXPECTED_SOURCE_REF}.supabase.co:5432" \
    -L "127.0.0.1:25432:db.${EXPECTED_TARGET_REF}.supabase.co:5432" \
    "${RELAY_USER}@${RELAY_HOST}"
  chmod 600 "${SOCKET_FILE}"
  relay_check || die "SSH relay sa po spustení nepotvrdil."
  print -- "Supabase DB relay beží na dvoch lokálnych loopback portoch."
}

preflight_database() {
  local label="$1"
  local project_ref="$2"
  local database_url="$3"
  local capability_sql="$4"

  libpq_url_matches_project "${database_url}" "${project_ref}" 0 || \
    die "${label} DB URL neprešiel relay identitou a TLS kontrolou."
  libpq_prepare_credentials \
    "${database_url}" \
    "${ROOT_DIR}/.context/secrets" \
    "relay-${label:l}" || die "${label} DB credential príprava zlyhala."

  local preflight_result
  preflight_result="$(print -r -- "${capability_sql}" | \
    migration_docker_run --rm -i \
      --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
      --env PGPASSFILE=/run/secrets/pgpass \
      "${POSTGRES_IMAGE}" \
      psql --no-psqlrc --no-align --tuples-only --quiet \
        --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}" | tr -d '[:space:]')" || {
    libpq_cleanup_credentials
    die "${label} databáza nie je cez relay dostupná."
  }
  [[ "${preflight_result}" == "${label}_relay=ok" ]] || {
    libpq_cleanup_credentials
    die "${label} relay nemá všetky potrebné admin oprávnenia."
  }
  print -- "${preflight_result}"
  libpq_cleanup_credentials
}

preflight_relay() {
  relay_check || die "SSH relay nebeží."
  [[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
  if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
    die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."
  fi
  source "${SECRET_FILE}"
  : "${TARGET_DB_URL:?TARGET_DB_URL chýba}"
  [[ "${MIGRATION_DOCKER_SSH_RELAY:-0}" == 1 ]] || \
    die "Migračný secret súbor nemá zapnutý SSH relay režim."
  mixed_readonly_mode=false
  case "${MIGRATION_DB_CREDENTIAL_MODE:-}" in
    target_extended_cli_source_management_api|target_temporary_cli_source_management_api)
      : "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
      [[ "${SOURCE_DB_VALIDATION_MODE:-}" == management_api_read_only ]] || \
        die "Source Management API read-only režim nie je potvrdený."
      mixed_readonly_mode=true
      ;;
    extended_cli_role)
      : "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
      ;;
    *) die "Migračný secret súbor nemá podporovaný DB credential režim." ;;
  esac

  trap libpq_cleanup_credentials EXIT INT TERM
  [[ "${SOURCE_PROJECT_REF:-}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
  [[ "${TARGET_PROJECT_REF:-}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
  source_capability_sql="select case when
    current_database() = 'postgres'
    and current_setting('server_version_num')::int >= 170000
    and session_user ~ '^cli_login_[a-z0-9_]+$'
    and current_user = 'postgres'
    and pg_catalog.pg_has_role(session_user, 'postgres', 'MEMBER')
    and (select rolvaliduntil from pg_catalog.pg_roles where rolname = session_user)
      > pg_catalog.clock_timestamp() + interval '4 hours'
    and pg_catalog.pg_has_role(
      current_user,
      pg_catalog.pg_get_userbyid((select datdba from pg_catalog.pg_database where datname = current_database())),
      'MEMBER'
    )
    and (
      (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
      or pg_catalog.pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')
    )
    and pg_catalog.to_regclass('cron.job') is not null
    and pg_catalog.has_schema_privilege(current_user, 'cron', 'USAGE')
    and pg_catalog.has_table_privilege(current_user, 'cron.job', 'SELECT')
    and exists (
      select 1
      from pg_catalog.pg_proc as proc
      join pg_catalog.pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'cron'
        and proc.proname = 'alter_job'
        and pg_catalog.pg_get_function_identity_arguments(proc.oid)
          = 'job_id bigint, schedule text, command text, database text, username text, active boolean'
        and pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE')
    )
    and pg_catalog.to_regclass('vault.decrypted_secrets') is not null
    and pg_catalog.has_schema_privilege(current_user, 'vault', 'USAGE')
    and pg_catalog.has_table_privilege(current_user, 'vault.decrypted_secrets', 'SELECT')
    and exists (
      select 1
      from pg_catalog.pg_proc as proc
      join pg_catalog.pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'vault'
        and proc.proname = 'create_secret'
        and proc.pronargs >= 3
        and pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE')
    )
  then 'source_relay=ok' else 'source_relay=invalid' end;"
  target_capability_sql="select case when
    current_database() = 'postgres'
    and current_setting('server_version_num')::int >= 170000
    and session_user ~ '^cli_login_[a-z0-9_]+$'
    and current_user = 'postgres'
    and pg_catalog.pg_has_role(session_user, 'postgres', 'MEMBER')
    and (select rolvaliduntil from pg_catalog.pg_roles where rolname = session_user)
      > pg_catalog.clock_timestamp() + interval '4 hours'
    and (select rolcreaterole from pg_catalog.pg_roles where rolname = current_user)
    and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
    and pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
    and pg_catalog.has_schema_privilege(current_user, 'auth', 'USAGE')
    and pg_catalog.has_schema_privilege(current_user, 'storage', 'USAGE')
    and (
      select pg_catalog.bool_and(
        pg_catalog.has_table_privilege(current_user, class.oid, privilege_name)
      )
      from pg_catalog.unnest(array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]) as required(privilege_name)
      cross join pg_catalog.pg_class as class
      join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname in ('auth', 'storage')
        and class.relkind in ('r', 'p')
        and (namespace.nspname, class.relname) not in (
          ('auth', 'schema_migrations'),
          ('storage', 'buckets_vectors'),
          ('storage', 'migrations'),
          ('storage', 'vector_indexes')
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_proc as proc
      join pg_catalog.pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'vault'
        and proc.proname = 'create_secret'
        and proc.pronargs >= 3
        and pg_catalog.has_function_privilege(current_user, proc.oid, 'EXECUTE')
    )
  then 'target_relay=ok' else 'target_relay=invalid' end;"
  if [[ "${mixed_readonly_mode}" == true ]]; then
    [[ "$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" == on\|0 ]] || \
      die "Source Management API nepotvrdilo frozen on|0."
    print -- "source_management_api_readonly=ok"
  else
    preflight_database source "${EXPECTED_SOURCE_REF}" "${SOURCE_DB_URL}" "${source_capability_sql}"
  fi
  preflight_database target "${EXPECTED_TARGET_REF}" "${TARGET_DB_URL}" "${target_capability_sql}"
  trap - EXIT INT TERM
  unset SOURCE_DB_URL TARGET_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN
  print -- "Source read-only a target TLS admin prešli autentizovaným preflightom."
}

stop_relay() {
  local force="${1:-}"
  typeset -a active_receipts
  active_receipts=("${FREEZE_ROOT}"/*.env(N))
  if (( ${#active_receipts[@]} > 0 )) && \
     grep -Eq '^state=(preparing|restart_requested|frozen)$' "${active_receipts[@]}" && \
     [[ "${force}" != "--force-after-cutover-or-abort" ]]; then
    die "Source freeze je preparing/restart_requested/frozen; relay nemožno vypnúť bez explicitného recovery rozhodnutia."
  fi
  if relay_check; then
    ssh -S "${SOCKET_FILE}" -O exit "${RELAY_USER}@${RELAY_HOST}" >/dev/null
  fi
  rm -f -- "${SOCKET_FILE}"
  print -- "Supabase DB relay je vypnutý."
}

case "${1:-}" in
  start) [[ "$#" -eq 1 ]] || die "Použitie: ${0:t} start"; start_relay ;;
  check) [[ "$#" -eq 1 ]] || die "Použitie: ${0:t} check"; relay_check && print -- "Supabase DB relay beží." || die "Supabase DB relay nebeží." ;;
  preflight) [[ "$#" -eq 1 ]] || die "Použitie: ${0:t} preflight"; preflight_relay ;;
  stop) [[ "$#" -le 2 ]] || die "Použitie: ${0:t} stop [--force-after-cutover-or-abort]"; stop_relay "${2:-}" ;;
  *) die "Použitie: ${0:t} start|check|preflight|stop" ;;
esac
