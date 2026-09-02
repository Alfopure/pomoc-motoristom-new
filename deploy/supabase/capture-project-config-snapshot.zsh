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
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"

source "${LIBPQ_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

run_source_sql() {
  migration_docker_run --rm -i \
    --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/pgpass \
    "${POSTGRES_IMAGE}" \
    psql --no-psqlrc --no-align --tuples-only --quiet \
      --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}"
}

refresh_target=false
if [[ "$#" -eq 1 && "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' ]]; then
  :
elif [[ "$#" -eq 2 && "$1" =~ '^[0-9]{8}T[0-9]{6}Z$' && "$2" == "--refresh-target-after-application" ]]; then
  refresh_target=true
else
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ [--refresh-target-after-application]"
fi
snapshot_id="$1"

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || die "Chýba source freeze receipt pre tento snapshot."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt nie je v stave frozen."
[[ "$(sed -n 's/^snapshot_id=//p' "${freeze_receipt}")" == "${snapshot_id}" ]] || \
  die "Source freeze receipt snapshot ID nesedí."
freeze_receipt_sha256="$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')"

[[ -r "${SECRET_FILE}" ]] || \
  die "Chýba ${SECRET_FILE}. Najprv bezpečne zachyť PAT cez capture-migration-credentials.zsh."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
if [[ "${refresh_target}" != true ]]; then
  : "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
fi
export MIGRATION_ARCHIVE_PASSPHRASE

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
libpq_url_matches_project \
  "${SOURCE_DB_URL}" \
  "${EXPECTED_SOURCE_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Source DB URL nepatrí očakávanému source projektu."

if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source-config-capture; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
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
    end;" | run_source_sql | tr -d '[:space:]'
)" || die "Živá kontrola source write-freeze zlyhala."
[[ "${source_freeze_state}" == "on|0" ]] || \
  die "Source už nie je potvrdene read-only alebo má aktívny cron; config snapshot je zakázaný."
libpq_cleanup_credentials
trap - EXIT INT TERM

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
created_snapshot_dir=false
if [[ "${refresh_target}" == true ]]; then
  [[ -r "${manifest_file}" ]] || die "Počiatočný config snapshot ${snapshot_id} neexistuje."
  [[ "$(sed -n 's/^source_project_ref=//p' "${manifest_file}")" == "${EXPECTED_SOURCE_REF}" ]] || \
    die "Config snapshot source ref nesedí."
  [[ "$(sed -n 's/^target_project_ref=//p' "${manifest_file}")" == "${EXPECTED_TARGET_REF}" ]] || \
    die "Config snapshot target ref nesedí."
  [[ "$(sed -n 's/^snapshot_id=//p' "${manifest_file}")" == "${snapshot_id}" ]] || \
    die "Config snapshot ID nesedí."
  [[ "$(sed -n 's/^source_freeze_receipt_sha256=//p' "${manifest_file}")" == "${freeze_receipt_sha256}" ]] || \
    die "Source freeze receipt sa od počiatočného config snapshotu zmenil."
  [[ -z "$(sed -n 's/^target_refresh_completed_at_utc=//p' "${manifest_file}")" ]] || \
    die "Finálny target config už bol pre tento snapshot zachytený; nič nebolo prepísané."
else
  [[ ! -e "${snapshot_dir}" ]] || die "Config snapshot ${snapshot_id} už existuje; nič nebolo prepísané."
  mkdir -p "${snapshot_dir}"
  created_snapshot_dir=true
fi
chmod 700 "${SNAPSHOT_ROOT}" "${snapshot_dir}"

typeset -a plaintext_files curl_config_files encrypted_files
temporary_manifest=""
snapshot_complete=false
cleanup() {
  rm -f -- "${plaintext_files[@]:-}" "${curl_config_files[@]:-}" "${temporary_manifest:-}"
  if [[ "${snapshot_complete}" != true ]]; then
    rm -f -- "${encrypted_files[@]:-}"
    [[ "${created_snapshot_dir}" != true ]] || rmdir "${snapshot_dir}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

typeset -A service_paths
service_paths=(
  project '/v1/projects/%s'
  auth '/v1/projects/%s/config/auth'
  postgrest '/v1/projects/%s/postgrest'
  storage '/v1/projects/%s/config/storage'
  realtime '/v1/projects/%s/config/realtime'
  postgres '/v1/projects/%s/config/database/postgres'
  pooler '/v1/projects/%s/config/database/pooler'
  ssl '/v1/projects/%s/ssl-enforcement'
  network '/v1/projects/%s/network-restrictions'
  readonly '/v1/projects/%s/readonly'
)

typeset -a services
services=(project auth postgrest storage realtime postgres pooler ssl network readonly)

if [[ "${refresh_target}" == true ]]; then
  for service in "${services[@]}"; do
    for baseline_side in source target; do
      baseline_name="${baseline_side}-${service}.json.enc"
      baseline_file="${snapshot_dir}/${baseline_name}"
      expected_baseline_hash="$(awk -v file="${baseline_name}" '$2 == file { print $1; exit }' "${manifest_file}")"
      [[ -s "${baseline_file}" && -n "${expected_baseline_hash}" ]] || \
        die "Počiatočný config baseline je neúplný pre ${baseline_name}."
      [[ "$(shasum -a 256 "${baseline_file}" | awk '{print $1}')" == "${expected_baseline_hash}" ]] || \
        die "Počiatočný config baseline bol zmenený pre ${baseline_name}."
    done
    [[ ! -e "${snapshot_dir}/target-final-${service}.json" && ! -e "${snapshot_dir}/target-final-${service}.json.enc" ]] || \
      die "Existuje neukončený target-final artefakt pre ${service}; nič nebolo prepísané."
  done
fi

typeset -a plain_hash_lines encrypted_hash_lines

print -- "Sťahujem source/target service config priamo do šifrovaných artefaktov..."
typeset -a sides
if [[ "${refresh_target}" == true ]]; then
  sides=(target)
else
  sides=(source target)
fi
for side in "${sides[@]}"; do
  if [[ "${side}" == source ]]; then
    project_ref="${SOURCE_PROJECT_REF}"
    access_token="${SOURCE_SUPABASE_ACCESS_TOKEN}"
  else
    project_ref="${TARGET_PROJECT_REF}"
    access_token="${TARGET_SUPABASE_ACCESS_TOKEN}"
  fi

  for service in "${services[@]}"; do
    artifact_side="${side}"
    [[ "${refresh_target}" == true ]] && artifact_side="target-final"
    plaintext_file="${snapshot_dir}/${artifact_side}-${service}.json"
    encrypted_file="${plaintext_file}.enc"
    curl_config="$(mktemp "${ROOT_DIR}/.context/secrets/.curl-supabase-config.XXXXXX")"
    plaintext_files+=("${plaintext_file}")
    curl_config_files+=("${curl_config}")
    encrypted_files+=("${encrypted_file}")

    request_path="$(printf "${service_paths[$service]}" "${project_ref}")"
    {
      print -- 'silent'
      print -- 'show-error'
      print -- 'fail-with-body'
      print -- 'request = "GET"'
      printf 'url = "https://api.supabase.com%s"\n' "${request_path}"
      printf 'header = "Authorization: Bearer %s"\n' "${access_token}"
      print -- 'header = "Accept: application/json"'
      printf 'output = "%s"\n' "${plaintext_file}"
    } > "${curl_config}"
    chmod 600 "${curl_config}"

    if ! curl --config "${curl_config}"; then
      die "Management API read zlyhal pre ${side}/${service}; žiadna konfigurácia nebola zmenená."
    fi
    chmod 600 "${plaintext_file}"
    jq -e 'type == "object" or type == "array"' "${plaintext_file}" >/dev/null || \
      die "Management API vrátilo neplatný JSON pre ${side}/${service}."

    plain_hash="$(shasum -a 256 "${plaintext_file}" | awk '{print $1}')"
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
    [[ "${decrypted_hash}" == "${plain_hash}" ]] || \
      die "Kontrola šifrovania zlyhala pre ${side}/${service}."
    encrypted_hash="$(shasum -a 256 "${encrypted_file}" | awk '{print $1}')"
    chmod 600 "${encrypted_file}"
    plain_hash_lines+=("${plain_hash}  ${plaintext_file:t}")
    encrypted_hash_lines+=("${encrypted_hash}  ${encrypted_file:t}")

    rm -f -- "${plaintext_file}" "${curl_config}"
  done
done

temporary_manifest="$(mktemp "${snapshot_dir}/.MANIFEST.XXXXXX")"
if [[ "${refresh_target}" == true ]]; then
  {
    cat -- "${manifest_file}"
    print -- "target_refresh_completed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "target_refresh_plaintext_sha256:"
    printf '%s\n' "${plain_hash_lines[@]}"
    print -- "target_refresh_encrypted_sha256:"
    printf '%s\n' "${encrypted_hash_lines[@]}"
  } > "${temporary_manifest}"
else
  {
    print -- "source_project_ref=${SOURCE_PROJECT_REF}"
    print -- "target_project_ref=${TARGET_PROJECT_REF}"
    print -- "snapshot_id=${snapshot_id}"
    print -- "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "source_freeze_receipt_sha256=${freeze_receipt_sha256}"
    print -- "services=${(j:,:)services}"
    print -- "encryption=AES-256-CBC/PBKDF2-SHA256/200000"
    print -- "plaintext_sha256:"
    printf '%s\n' "${plain_hash_lines[@]}"
    print -- "encrypted_sha256:"
    printf '%s\n' "${encrypted_hash_lines[@]}"
  } > "${temporary_manifest}"
fi
chmod 600 "${temporary_manifest}"
mv "${temporary_manifest}" "${manifest_file}"
temporary_manifest=""

snapshot_complete=true
cleanup
trap - EXIT INT TERM
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
unset MIGRATION_ARCHIVE_PASSPHRASE SOURCE_DB_URL access_token source_freeze_state

if [[ "${refresh_target}" == true ]]; then
  print -- "Finálny target config bol zachytený bez prepísania source baseline: .context/migration/config-snapshots/${snapshot_id}"
else
  print -- "Šifrovaný source/počiatočný-target config baseline je pripravený bez výpisu hodnôt: .context/migration/config-snapshots/${snapshot_id}"
fi
