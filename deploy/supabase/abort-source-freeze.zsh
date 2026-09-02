#!/bin/zsh

set -euo pipefail
umask 077

readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly LOG_ROOT="${ROOT_DIR}/.context/migration/logs"
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

if [[ "$#" -ne 2 || "$2" != "--abort-migration-and-unfreeze-source" ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --abort-migration-and-unfreeze-source"
fi
snapshot_id="$1"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."

receipt_file="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${receipt_file}" ]] || die "Freeze receipt pre ${snapshot_id} neexistuje."
if (( (8#$(stat -f '%Lp' "${receipt_file}") & 8#077) != 0 )); then
  die "Freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi

receipt_state="$(sed -n 's/^state=//p' "${receipt_file}")"
receipt_snapshot_id="$(sed -n 's/^snapshot_id=//p' "${receipt_file}")"
receipt_source_ref="$(sed -n 's/^source_project_ref=//p' "${receipt_file}")"
receipt_target_ref="$(sed -n 's/^target_project_ref=//p' "${receipt_file}")"
active_cron_ids="$(sed -n 's/^active_cron_job_ids=//p' "${receipt_file}")"
[[ "${receipt_state}" == frozen || "${receipt_state}" == preparing || "${receipt_state}" == restart_requested ]] || \
  die "Freeze receipt nie je v stave frozen/preparing/restart_requested."
[[ "${receipt_snapshot_id}" == "${snapshot_id}" ]] || die "Freeze receipt snapshot ID nesedí."
[[ "${receipt_source_ref}" == "${EXPECTED_SOURCE_REF}" ]] || die "Freeze receipt source ref nesedí."
[[ "${receipt_target_ref}" == "${EXPECTED_TARGET_REF}" ]] || die "Freeze receipt target ref nesedí."
[[ "${active_cron_ids}" =~ '^([0-9]+(,[0-9]+)*)?$' ]] || die "Freeze receipt má neplatné cron ID."

[[ -r "${SECRET_FILE}" ]] || die "Chýba ${SECRET_FILE}."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi
source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
libpq_url_matches_project \
  "${SOURCE_DB_URL}" \
  "${EXPECTED_SOURCE_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Source DB URL nepatrí očakávanému source projektu."

print -- "Toto zruší migračné freeze okno a znovu povolí source zápisy."
read "confirmation?Napíš presne ABORT ${EXPECTED_SOURCE_REF}: "
[[ "${confirmation}" == "ABORT ${EXPECTED_SOURCE_REF}" ]] || \
  die "Potvrdenie nesedí; source nebol zmenený."

if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source-unfreeze; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM

mkdir -p "${LOG_ROOT}"
chmod 700 "${LOG_ROOT}"
unfreeze_log="${LOG_ROOT}/source-unfreeze-${snapshot_id}.log"
: > "${unfreeze_log}"
chmod 600 "${unfreeze_log}"

if [[ -n "${active_cron_ids}" ]]; then
  reactivate_cron_sql="do \$unfreeze_cron\$
  begin
    if pg_catalog.to_regclass('cron.job') is null then
      raise exception 'CRON_TABLE_MISSING';
    end if;
    if exists (
      select 1 from cron.job
      where jobid = any (array[${active_cron_ids}]::bigint[]) and not active
    ) then
      perform cron.alter_job(jobid, active => true)
      from cron.job
      where jobid = any (array[${active_cron_ids}]::bigint[]) and not active;
    end if;
  end;
  \$unfreeze_cron\$;"
else
  reactivate_cron_sql="select true;"
fi

unfreeze_sql="set default_transaction_read_only = off;
alter database postgres reset default_transaction_read_only;
${reactivate_cron_sql}"
if ! print -r -- "${unfreeze_sql}" | run_source_sql >> "${unfreeze_log}" 2>&1; then
  die "Source unfreeze zlyhal; cutover aj aplikačné zápisy nechaj zastavené a skontroluj chránený log."
fi

unfreeze_state="$(
  print -- "select pg_catalog.current_setting('default_transaction_read_only')
    || '|' || case
      when pg_catalog.to_regclass('cron.job') is null then ''
      else coalesce((pg_catalog.xpath(
        '/row/value/text()',
        pg_catalog.query_to_xml(
          'select coalesce(string_agg(jobid::text, '','' order by jobid), '''') as value from cron.job where active',
          false,
          true,
          ''
        )
      ))[1]::text, '')
    end;" | run_source_sql | tr -d '[:space:]'
)" || die "Source unfreeze verifikácia zlyhala."
[[ "${unfreeze_state}" == "off|${active_cron_ids}" ]] || \
  die "Source unfreeze sa nepotvrdil alebo aktívny cron inventár nie je presne pôvodný."

temporary_receipt="$(mktemp "${FREEZE_ROOT}/.unfreeze-${snapshot_id}.XXXXXX")"
trap 'rm -f -- "${temporary_receipt}"; libpq_cleanup_credentials' EXIT INT TERM
{
  print -- "state=unfrozen_after_abort"
  print -- "snapshot_id=${snapshot_id}"
  print -- "source_project_ref=${EXPECTED_SOURCE_REF}"
  print -- "target_project_ref=${EXPECTED_TARGET_REF}"
  print -- "unfrozen_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "reactivated_cron_job_ids=${active_cron_ids}"
} > "${temporary_receipt}"
chmod 600 "${temporary_receipt}"
mv "${temporary_receipt}" "${receipt_file}"

libpq_cleanup_credentials
trap - EXIT INT TERM
unset SOURCE_DB_URL TARGET_DB_URL confirmation
print -- "Migračné freeze okno bolo zrušené a pôvodné source cron joby boli obnovené."
