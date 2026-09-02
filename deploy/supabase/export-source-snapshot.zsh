#!/bin/zsh

set -euo pipefail
umask 077

readonly SUPABASE_CLI_VERSION="2.109.1"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly INVENTORY_SQL="${ROOT_DIR}/deploy/supabase/snapshot-inventory.sql"
readonly VAULT_REPLAY_SQL="${ROOT_DIR}/deploy/supabase/export-vault-replay.sql"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

if [[ ! -r "${SECRET_FILE}" ]]; then
  print -u2 -- "Chýba ${SECRET_FILE}. Najprv spusti capture-migration-credentials.zsh."
  exit 1
fi

if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  print -u2 -- "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
  exit 1
fi

source "${SECRET_FILE}"

: "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
export MIGRATION_ARCHIVE_PASSPHRASE

if [[ "${SOURCE_PROJECT_REF}" != "${EXPECTED_SOURCE_REF}" ]] ||
   ! libpq_url_matches_project \
     "${SOURCE_DB_URL}" \
     "${EXPECTED_SOURCE_REF}" \
     "${MIGRATION_LOCAL_REHEARSAL:-0}"; then
  print -u2 -- "Source identita nesedí; export bol zastavený."
  exit 1
fi

if [[ "$#" -ne 2 || "$2" != "--require-source-write-freeze" ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --require-source-write-freeze"
fi
snapshot_id="$1"
if [[ ! "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]]; then
  print -u2 -- "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."
  exit 1
fi

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || \
  die "Chýba source freeze receipt pre ${snapshot_id}. Najprv spusti freeze-source-for-cutover.zsh."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt nie je v stave frozen."
[[ "$(sed -n 's/^snapshot_id=//p' "${freeze_receipt}")" == "${snapshot_id}" ]] || \
  die "Source freeze receipt snapshot ID nesedí."
[[ "$(sed -n 's/^source_project_ref=//p' "${freeze_receipt}")" == "${EXPECTED_SOURCE_REF}" ]] || \
  die "Source freeze receipt project ref nesedí."
[[ "$(sed -n 's/^external_writers_attested_stopped=//p' "${freeze_receipt}")" == true ]] || \
  die "Source freeze receipt nepotvrdzuje zastavenie externých writerov."
source_frozen_at="$(sed -n 's/^frozen_at_utc=//p' "${freeze_receipt}")"
[[ "${source_frozen_at}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' ]] || \
  die "Source freeze receipt nemá platný čas."
freeze_receipt_sha256="$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')"

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
if [[ -e "${snapshot_dir}" ]]; then
  if [[ -d "${snapshot_dir}" && ! -e "${snapshot_dir}/MANIFEST" ]]; then
    # SIGKILL cannot be trapped. An incomplete directory may therefore still
    # contain plaintext database rows or decrypted Vault values. Never archive
    # it: discard the whole attempt before reusing the immutable snapshot ID.
    rm -rf -- "${snapshot_dir}"
    print -- "Neúplný predchádzajúci export bez manifestu bol bezpečne zahodený; snapshot sa vytvorí znova."
  else
    print -u2 -- "Dokončený snapshot ${snapshot_id} už existuje; nič nebolo prepísané."
    exit 1
  fi
fi

mkdir -p "${snapshot_dir}"
chmod 700 "${SNAPSHOT_ROOT}" "${snapshot_dir}"

typeset -a plaintext_files
plaintext_files=(
  "${snapshot_dir}/roles.sql"
  "${snapshot_dir}/schema.sql"
  "${snapshot_dir}/data.sql"
  "${snapshot_dir}/history-schema.sql"
  "${snapshot_dir}/history-data.sql"
  "${snapshot_dir}/inventory.tsv"
  "${snapshot_dir}/vault.sql"
)

cleanup_plaintext() {
  rm -f -- "${plaintext_files[@]}"
  rm -f -- "${dump_script_files[@]:-}"
  libpq_cleanup_credentials
}
trap cleanup_plaintext EXIT INT TERM

typeset -a cli
cli=(pnpm dlx "supabase@${SUPABASE_CLI_VERSION}")

if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi

run_source_sql() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

typeset -a dump_script_files
run_safe_cli_dump() {
  local output_file="$1"
  shift
  local dump_script
  dump_script="$(mktemp "${ROOT_DIR}/.context/secrets/.supabase-dump.XXXXXX")"
  dump_script_files+=("${dump_script}")
  chmod 600 "${dump_script}"

  # The pinned CLI remains the source of truth for Supabase's platform-schema
  # exclusions. Its dry-run receives only a password-free URL. We remove its
  # empty PGPASSWORD export and execute the generated pg_dump pipeline with a
  # protected pgpass file mounted into the pinned Postgres image.
  if ! "${cli[@]}" db dump --dry-run --db-url "${LIBPQ_SAFE_URL}" "$@" |
    sed -n '/^#!\/usr\/bin\/env bash/,$p' |
    sed '/^export PGPASSWORD=/d' > "${dump_script}"; then
    die "Supabase CLI nevygenerovalo bezpečný dump plán."
  fi
  grep -Eq '^pg_dump(all)? ' "${dump_script}" || \
    die "Dump plán neobsahuje pg_dump ani pg_dumpall."
  grep -q 'PGPASSWORD' "${dump_script}" && die "Dump plán stále obsahuje PGPASSWORD."

  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" bash -s < "${dump_script}" > "${output_file}"
  rm -f -- "${dump_script}"
}

freeze_state="$(
  print -- "select pg_catalog.current_setting('default_transaction_read_only')
    || '|' || case
      when pg_catalog.to_regclass('cron.job') is null then '0'
      else (pg_catalog.xpath(
        '/row/count/text()',
        pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
      ))[1]::text
    end;" | run_source_sql | tr -d '[:space:]'
)" || die "Source write-freeze sa nepodarilo overiť."
[[ "${freeze_state}" == "on|0" ]] || \
  die "Source už nie je read-only alebo má aktívny cron; snapshot bol zastavený."

print -- "Exportujem role, schému, dáta a migračnú históriu source projektu..."

run_source_sql < "${INVENTORY_SQL}" > "${snapshot_dir}/inventory.tsv"

{
  print -- '-- Encrypted Vault replay; values must never be logged or printed.'
  run_source_sql < "${VAULT_REPLAY_SQL}"
} > "${snapshot_dir}/vault.sql"

run_safe_cli_dump "${snapshot_dir}/roles.sql" --role-only

run_safe_cli_dump "${snapshot_dir}/schema.sql"

run_safe_cli_dump "${snapshot_dir}/data.sql" \
  --data-only \
  --use-copy \
  --exclude "storage.buckets_vectors" \
  --exclude "storage.vector_indexes" \
  --exclude "cron.job" \
  --exclude "cron.job_run_details" \
  --exclude "cron.jobid_seq" \
  --exclude "cron.runid_seq" \
  --exclude "net._http_response" \
  --exclude "net.http_request_queue" \
  --exclude "net.http_request_queue_id_seq"

run_safe_cli_dump "${snapshot_dir}/history-schema.sql" \
  --schema "supabase_migrations"

run_safe_cli_dump "${snapshot_dir}/history-data.sql" \
  --schema "supabase_migrations" \
  --data-only \
  --use-copy

typeset -a plain_hash_lines
typeset -a encrypted_hash_lines

for plaintext_file in "${plaintext_files[@]}"; do
  if [[ ! -s "${plaintext_file}" ]]; then
    print -u2 -- "Export vytvoril prázdny súbor: ${plaintext_file:t}"
    exit 1
  fi

  plain_hash="$(shasum -a 256 "${plaintext_file}" | awk '{print $1}')"
  encrypted_file="${plaintext_file}.enc"

  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -in "${plaintext_file}" \
    -out "${encrypted_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE

  decrypted_hash="$(
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -in "${encrypted_file}" \
      -pass env:MIGRATION_ARCHIVE_PASSPHRASE |
      shasum -a 256 |
      awk '{print $1}'
  )"

  if [[ "${plain_hash}" != "${decrypted_hash}" ]]; then
    print -u2 -- "Kontrola šifrovania zlyhala pre ${plaintext_file:t}."
    exit 1
  fi

  encrypted_hash="$(shasum -a 256 "${encrypted_file}" | awk '{print $1}')"
  plain_hash_lines+=("${plain_hash}  ${plaintext_file:t}")
  encrypted_hash_lines+=("${encrypted_hash}  ${encrypted_file:t}")
  chmod 600 "${encrypted_file}"
  rm -f -- "${plaintext_file}"
done

{
  print -- "source_project_ref=${SOURCE_PROJECT_REF}"
  print -- "snapshot_id=${snapshot_id}"
  print -- "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "source_write_frozen_at_utc=${source_frozen_at}"
  print -- "source_freeze_receipt_sha256=${freeze_receipt_sha256}"
  print -- "encryption=AES-256-CBC/PBKDF2-SHA256/200000"
  print -- "excluded_dump_schemas=cron,net,vault"
  print -- "included_encrypted_vault_replay=true"
  print -- "plaintext_sha256:"
  printf '%s\n' "${plain_hash_lines[@]}"
  print -- "encrypted_sha256:"
  printf '%s\n' "${encrypted_hash_lines[@]}"
} > "${snapshot_dir}/MANIFEST"

chmod 600 "${snapshot_dir}/MANIFEST"
cleanup_plaintext
trap - EXIT INT TERM

unset SOURCE_DB_URL TARGET_DB_URL MIGRATION_ARCHIVE_PASSPHRASE
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset SOURCE_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_SECRET_ACCESS_KEY

print -- "Šifrovaný source snapshot je pripravený: .context/migration/snapshots/${snapshot_id}"
