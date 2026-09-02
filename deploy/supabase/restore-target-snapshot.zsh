#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly LOG_ROOT="${ROOT_DIR}/.context/migration/logs"
readonly RESTORE_RECEIPT_ROOT="${ROOT_DIR}/.context/migration/restore-receipts"
readonly EMPTY_GUARD="${ROOT_DIR}/deploy/supabase/target-empty-guard.sql"
readonly WORKER_MIGRATION="${ROOT_DIR}/supabase/migrations/20260714124204_worker_job_runtime.sql"
readonly RECONCILIATION="${ROOT_DIR}/deploy/supabase/post-restore-reconciliation.sql"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

decrypt_snapshot_file() {
  local encrypted_file="$1"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${encrypted_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE
}

run_database_query() {
  local sql="$1"

  print -r -- "${sql}" | migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

print_migration_history_sql() {
  local migration_file migration_base migration_version migration_name
  typeset -a migration_files
  migration_files=("${ROOT_DIR}"/supabase/migrations/*.sql(N))
  (( ${#migration_files[@]} > 0 )) || die "Nenašli sa lokálne migrácie."

  print -- "do \$history_table\$ begin"
  print -- "  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then"
  print -- "    raise exception 'MIGRATION_HISTORY_TABLE_MISSING';"
  print -- "  end if;"
  print -- "end \$history_table\$;"
  print -- "lock table supabase_migrations.schema_migrations in access exclusive mode;"
  print -- "delete from supabase_migrations.schema_migrations;"

  for migration_file in "${migration_files[@]}"; do
    migration_base="${migration_file:t:r}"
    [[ "${migration_base}" =~ '^[0-9]{14}_[a-z0-9_]+$' ]] || \
      die "Neplatný názov migrácie: ${migration_base}"
    migration_version="${migration_base%%_*}"
    migration_name="${migration_base#*_}"
    printf "insert into supabase_migrations.schema_migrations (version, name) values ('%s', '%s');\n" \
      "${migration_version}" "${migration_name}"
  done
}

run_restore_stream() {
  {
    print -- 'begin isolation level serializable;'
    print -- "set local lock_timeout = '30s';"
    command cat "${EMPTY_GUARD}"
    decrypt_snapshot_file "${snapshot_dir}/roles.sql.enc"
    decrypt_snapshot_file "${snapshot_dir}/history-schema.sql.enc"
    decrypt_snapshot_file "${snapshot_dir}/schema.sql.enc"
    decrypt_snapshot_file "${snapshot_dir}/data.sql.enc"
    decrypt_snapshot_file "${snapshot_dir}/vault.sql.enc"
    command cat "${WORKER_MIGRATION}"
    command cat "${RECONCILIATION}"
    print_migration_history_sql
    print -- 'commit;'
  } | migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

if [[ "$#" -ne 2 || "$2" != "--restore-empty-target" ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --restore-empty-target"
fi

snapshot_id="$1"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."

[[ -r "${SECRET_FILE}" ]] || \
  die "Chýba ${SECRET_FILE}. Najprv spusti capture-migration-credentials.zsh."

if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${SECRET_FILE}"

: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
: "${TARGET_DB_URL:?TARGET_DB_URL chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
export MIGRATION_ARCHIVE_PASSPHRASE

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Source project ref nesedí; restore bol zastavený."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || \
  die "Target project ref nesedí; restore bol zastavený."
libpq_url_matches_project \
  "${SOURCE_DB_URL}" \
  "${EXPECTED_SOURCE_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Source DB URL nepatrí očakávanému source projektu."
libpq_url_matches_project \
  "${TARGET_DB_URL}" \
  "${EXPECTED_TARGET_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Target DB URL nepatrí očakávanému target projektu."
[[ "${SOURCE_DB_URL}" != "${TARGET_DB_URL}" ]] || \
  die "Source a target DB URL nesmú byť rovnaké."

if ! libpq_prepare_credentials \
  "${TARGET_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  target; then
  die "Target DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
[[ -r "${manifest_file}" ]] || die "Snapshot manifest neexistuje."

manifest_source_ref="$(sed -n 's/^source_project_ref=//p' "${manifest_file}")"
manifest_snapshot_id="$(sed -n 's/^snapshot_id=//p' "${manifest_file}")"
manifest_encryption="$(sed -n 's/^encryption=//p' "${manifest_file}")"

[[ "${manifest_source_ref}" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Snapshot nepatrí očakávanému source projektu."
[[ "${manifest_snapshot_id}" == "${snapshot_id}" ]] || \
  die "Snapshot ID a manifest sa nezhodujú."
[[ "${manifest_encryption}" == "AES-256-CBC/PBKDF2-SHA256/200000" ]] || \
  die "Nepodporovaný formát šifrovania snapshotu."

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || die "Chýba source freeze receipt pre tento snapshot."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt nie je v stave frozen."
[[ "$(sed -n 's/^snapshot_id=//p' "${freeze_receipt}")" == "${snapshot_id}" ]] || \
  die "Source freeze receipt snapshot ID nesedí."
manifest_freeze_hash="$(sed -n 's/^source_freeze_receipt_sha256=//p' "${manifest_file}")"
[[ -n "${manifest_freeze_hash}" ]] || die "Snapshot manifest nemá source freeze hash."
[[ "$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')" == "${manifest_freeze_hash}" ]] || \
  die "Source freeze receipt sa od exportu zmenil."

typeset -a plaintext_names
plaintext_names=(roles.sql schema.sql data.sql history-schema.sql history-data.sql inventory.tsv vault.sql)

print -- "Overujem šifrovaný snapshot bez zápisu do targetu..."
for plaintext_name in "${plaintext_names[@]}"; do
  encrypted_name="${plaintext_name}.enc"
  encrypted_file="${snapshot_dir}/${encrypted_name}"
  [[ -s "${encrypted_file}" ]] || die "Chýba ${encrypted_name}."

  expected_encrypted_hash="$(awk -v file="${encrypted_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
  expected_plaintext_hash="$(awk -v file="${plaintext_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
  [[ -n "${expected_encrypted_hash}" && -n "${expected_plaintext_hash}" ]] || \
    die "Manifest nemá kontrolné súčty pre ${plaintext_name}."

  actual_encrypted_hash="$(shasum -a 256 "${encrypted_file}" | awk '{print $1}')"
  [[ "${actual_encrypted_hash}" == "${expected_encrypted_hash}" ]] || \
    die "Šifrovaný kontrolný súčet nesedí pre ${encrypted_name}."

  actual_plaintext_hash="$(decrypt_snapshot_file "${encrypted_file}" | shasum -a 256 | awk '{print $1}')"
  [[ "${actual_plaintext_hash}" == "${expected_plaintext_hash}" ]] || \
    die "Dešifrovaný kontrolný súčet nesedí pre ${plaintext_name}."
done

libpq_cleanup_credentials
trap - EXIT INT TERM
if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source-freeze-restore; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM
source_freeze_sql="select pg_catalog.current_setting('default_transaction_read_only')
  || '|' || case
    when pg_catalog.to_regclass('cron.job') is null then '0'
    else (pg_catalog.xpath(
      '/row/count/text()',
      pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
    ))[1]::text
  end;"
source_freeze_state="$(run_database_query "${source_freeze_sql}" | tr -d '[:space:]')" || \
  die "Source write-freeze sa nepodarilo overiť; target nebol zmenený."
[[ "${source_freeze_state}" == "on|0" ]] || \
  die "Source už nie je read-only alebo má aktívny cron; target nebol zmenený."

libpq_cleanup_credentials
trap - EXIT INT TERM
if ! libpq_prepare_credentials \
  "${TARGET_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  target; then
  die "Target DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM

preflight_sql="select
  (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p'))::text
  || '|' || (select count(*) from auth.users)::text
  || '|' || (select count(*) from storage.buckets)::text
  || '|' || case
    when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then '0'
    else (pg_catalog.xpath(
      '/row/count/text()',
      pg_catalog.query_to_xml(
        'select count(*) as count from supabase_migrations.schema_migrations',
        false,
        true,
        ''
      )
    ))[1]::text
  end
  || '|' || case
    when pg_catalog.to_regclass('vault.secrets') is null then '0'
    else (pg_catalog.xpath(
      '/row/count/text()',
      pg_catalog.query_to_xml('select count(*) as count from vault.secrets', false, true, '')
    ))[1]::text
  end;"

print -- "Kontrolujem prázdnosť targetu ${EXPECTED_TARGET_REF}..."
preflight_result="$(run_database_query "${preflight_sql}" | tr -d '[:space:]')" || \
  die "Target preflight zlyhal; target nebol zmenený."
[[ "${preflight_result}" == "0|0|0|0|0" ]] || \
  die "Target nie je prázdny (public|auth|storage|migrations|vault=${preflight_result}); nič nebolo obnovené."

mkdir -p "${LOG_ROOT}"
chmod 700 "${LOG_ROOT}"
restore_log="${LOG_ROOT}/restore-${snapshot_id}.log"
: > "${restore_log}"
chmod 600 "${restore_log}"

print -- "Obnovujem DB, bezpečnostnú rekonciliáciu a presnú migračnú históriu v jednej transakcii..."
if ! run_restore_stream >> "${restore_log}" 2>&1; then
  mkdir -p "${RESTORE_RECEIPT_ROOT}"
  chmod 700 "${RESTORE_RECEIPT_ROOT}"
  restore_outcome="connection_unavailable"
  observed_target_state="unavailable"
  if observed_target_state="$(run_database_query "${preflight_sql}" 2>> "${restore_log}" | tr -d '[:space:]')"; then
    if [[ "${observed_target_state}" == "0|0|0|0|0" ]]; then
      restore_outcome="failed_confirmed_empty"
    else
      restore_outcome="indeterminate_nonempty"
    fi
  fi
  {
    print -- "snapshot_id=${snapshot_id}"
    print -- "target_project_ref=${EXPECTED_TARGET_REF}"
    print -- "checked_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "outcome=${restore_outcome}"
    print -- "observed_target_state=${observed_target_state}"
  } > "${RESTORE_RECEIPT_ROOT}/${snapshot_id}.env"
  chmod 600 "${RESTORE_RECEIPT_ROOT}/${snapshot_id}.env"

  if [[ "${restore_outcome}" == failed_confirmed_empty ]]; then
    die "Restore zlyhal, ale target je potvrdene prázdny. Po obnove relay/prístupov je bezpečný opakovaný pokus. Chránený log: .context/migration/logs/${restore_log:t}."
  fi
  die "Výsledok restore je neurčitý; automatický retry je zakázaný. Najprv znovu pripoj relay a read-only over target. Receipt: .context/migration/restore-receipts/${snapshot_id}.env."
fi

mkdir -p "${RESTORE_RECEIPT_ROOT}"
chmod 700 "${RESTORE_RECEIPT_ROOT}"
{
  print -- "snapshot_id=${snapshot_id}"
  print -- "target_project_ref=${EXPECTED_TARGET_REF}"
  print -- "checked_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "outcome=committed_client_confirmed"
} > "${RESTORE_RECEIPT_ROOT}/${snapshot_id}.env"
chmod 600 "${RESTORE_RECEIPT_ROOT}/${snapshot_id}.env"

libpq_cleanup_credentials
trap - EXIT INT TERM
unset SOURCE_DB_URL TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset SOURCE_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_SECRET_ACCESS_KEY

print -- "Target DB bola obnovená bez cutoveru. Storage bajty a projektový config ešte nie sú migrované; všetky joby ostávajú vypnuté."
