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

if [[ "$#" -ne 2 || "$2" != "--freeze-source-for-cutover" ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --freeze-source-for-cutover"
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
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
libpq_url_matches_project \
  "${SOURCE_DB_URL}" \
  "${EXPECTED_SOURCE_REF}" \
  "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
  die "Source DB URL nepatrí očakávanému source projektu."

print -- "Toto začne produkčné write-freeze okno a riadený source DB restart na ${EXPECTED_SOURCE_REF}."
print -- "Pred potvrdením zapni aplikačný maintenance režim a zastav všetky externé writery."
read "confirmation?Napíš presne FREEZE ${EXPECTED_SOURCE_REF}: "
[[ "${confirmation}" == "FREEZE ${EXPECTED_SOURCE_REF}" ]] || \
  die "Potvrdenie nesedí; source nebol zmenený."

mkdir -p "${FREEZE_ROOT}" "${LOG_ROOT}"
chmod 700 "${FREEZE_ROOT}" "${LOG_ROOT}"
receipt_file="${FREEZE_ROOT}/${snapshot_id}.env"
[[ ! -e "${receipt_file}" ]] || die "Freeze receipt pre ${snapshot_id} už existuje."

if ! libpq_prepare_credentials \
  "${SOURCE_DB_URL}" \
  "${ROOT_DIR}/.context/secrets" \
  source-freeze; then
  die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
fi
trap libpq_cleanup_credentials EXIT INT TERM

freeze_preflight="$(
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
)" || die "Source cron inventár zlyhal; source nebol zmrazený."
[[ "${freeze_preflight}" == off\|* ]] || \
  die "Source už má default_transaction_read_only zapnuté; nič nebolo zmenené."
active_cron_ids="${freeze_preflight#*|}"
[[ "${active_cron_ids}" =~ '^([0-9]+(,[0-9]+)*)?$' ]] || \
  die "Source cron inventár mal neočakávaný formát."

temporary_receipt="$(mktemp "${FREEZE_ROOT}/.freeze-${snapshot_id}.XXXXXX")"
trap 'rm -f -- "${temporary_receipt}"; libpq_cleanup_credentials' EXIT INT TERM
{
  print -- "state=preparing"
  print -- "snapshot_id=${snapshot_id}"
  print -- "source_project_ref=${EXPECTED_SOURCE_REF}"
  print -- "target_project_ref=${EXPECTED_TARGET_REF}"
  print -- "active_cron_job_ids=${active_cron_ids}"
} > "${temporary_receipt}"
chmod 600 "${temporary_receipt}"
mv "${temporary_receipt}" "${receipt_file}"
chmod 600 "${receipt_file}"

freeze_log="${LOG_ROOT}/source-freeze-${snapshot_id}.log"
: > "${freeze_log}"
chmod 600 "${freeze_log}"

freeze_sql="alter database postgres set default_transaction_read_only = on;
create temporary table freeze_cutoff (cutoff_at timestamptz not null) on commit preserve rows;
insert into freeze_cutoff values (pg_catalog.clock_timestamp());
do \$freeze_cron\$
declare
  active_job record;
begin
  if pg_catalog.to_regclass('cron.job') is not null then
    for active_job in select jobid from cron.job where active loop
      perform cron.alter_job(active_job.jobid, active => false);
    end loop;
  end if;
end;
\$freeze_cron\$;
do \$terminate_old_sessions\$
declare
  termination_attempt integer;
  old_session record;
begin
  for termination_attempt in 1..20 loop
    for old_session in
      select activity.pid
      from pg_catalog.pg_stat_activity as activity
      join pg_catalog.pg_roles as role on role.rolname = activity.usename
      where activity.datname = pg_catalog.current_database()
        and activity.pid <> pg_catalog.pg_backend_pid()
        and activity.backend_type = 'client backend'
        and not role.rolsuper
        and activity.backend_start <= (select cutoff_at from freeze_cutoff)
    loop
      perform pg_catalog.pg_terminate_backend(old_session.pid);
    end loop;
    exit when not exists (
      select 1
      from pg_catalog.pg_stat_activity as activity
      join pg_catalog.pg_roles as role on role.rolname = activity.usename
      where activity.datname = pg_catalog.current_database()
        and activity.pid <> pg_catalog.pg_backend_pid()
        and activity.backend_type = 'client backend'
        and not role.rolsuper
        and activity.backend_start <= (select cutoff_at from freeze_cutoff)
    );
    perform pg_catalog.pg_sleep(0.25);
  end loop;
end;
\$terminate_old_sessions\$;
select (
  select count(*)
  from pg_catalog.pg_stat_activity as activity
  join pg_catalog.pg_roles as role on role.rolname = activity.usename
  where activity.datname = pg_catalog.current_database()
    and activity.pid <> pg_catalog.pg_backend_pid()
    and activity.backend_type = 'client backend'
    and not role.rolsuper
    and activity.backend_start <= (select cutoff_at from freeze_cutoff)
)::text || '|' || (
  select count(*) from pg_catalog.pg_prepared_xacts
)::text || '|' || pg_catalog.to_char(
  (select cutoff_at from freeze_cutoff) at time zone 'UTC',
  'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'
  ) || '|' || pg_catalog.to_char(
  pg_catalog.pg_postmaster_start_time() at time zone 'UTC',
  'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'
);"

freeze_mutation_state="$(
  print -r -- "${freeze_sql}" | run_source_sql 2>> "${freeze_log}" | tr -d '[:space:]'
)" || \
  die "Source freeze nedokončil všetky kroky. Source môže byť už read-only; cutover je zakázaný. Receipt a chránený log ponechaj na bezpečné obnovenie."
freeze_external_sessions="${freeze_mutation_state%%|*}"
freeze_remainder="${freeze_mutation_state#*|}"
freeze_prepared_xacts="${freeze_remainder%%|*}"
freeze_timestamps="${freeze_remainder#*|}"
freeze_cutoff_utc="${freeze_timestamps%%|*}"
postmaster_before_restart="${freeze_timestamps#*|}"
[[ "${freeze_external_sessions}" == 0 && "${freeze_prepared_xacts}" == 0 ]] || \
  die "Source má starú externú session alebo prepared transaction. Cutover je zakázaný; použi abort/unfreeze postup."
[[ "${freeze_cutoff_utc}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' ]] || \
  die "Source freeze cutoff má neočakávaný formát; použi abort/unfreeze postup."
[[ "${postmaster_before_restart}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' ]] || \
  die "Source pôvodný postmaster timestamp má neočakávaný formát; použi abort/unfreeze postup."

restart_requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
temporary_receipt="$(mktemp "${FREEZE_ROOT}/.freeze-${snapshot_id}.XXXXXX")"
{
  print -- "state=restart_requested"
  print -- "snapshot_id=${snapshot_id}"
  print -- "source_project_ref=${EXPECTED_SOURCE_REF}"
  print -- "target_project_ref=${EXPECTED_TARGET_REF}"
  print -- "freeze_cutoff_utc=${freeze_cutoff_utc}"
  print -- "postmaster_before_restart_utc=${postmaster_before_restart}"
  print -- "restart_requested_at_utc=${restart_requested_at}"
  print -- "active_cron_job_ids=${active_cron_ids}"
} > "${temporary_receipt}"
chmod 600 "${temporary_receipt}"
mv "${temporary_receipt}" "${receipt_file}"

export SOURCE_SUPABASE_ACCESS_TOKEN
if ! node --input-type=module -e '
  const response = await fetch(
    "https://api.supabase.com/v1/projects/jcwbiulwuwyrnmzjjbgr/restart",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SOURCE_SUPABASE_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  process.exit(response.ok ? 0 : 1);
'; then
  die "Source control-plane restart sa nepodarilo vyžiadať. Source ostáva frozen/preparing; použi recovery abort."
fi
unset SOURCE_SUPABASE_ACCESS_TOKEN

restart_state=""
postmaster_after_restart=""
for attempt in {1..72}; do
  restart_state="$(
    print -- "select pg_catalog.current_setting('default_transaction_read_only')
      || '|' || case
        when pg_catalog.to_regclass('cron.job') is null then '0'
        else (pg_catalog.xpath(
          '/row/count/text()',
          pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
        ))[1]::text
      end
      || '|' || case
        when pg_catalog.pg_postmaster_start_time() > '${postmaster_before_restart}'::timestamptz
          then pg_catalog.to_char(
            pg_catalog.pg_postmaster_start_time() at time zone 'UTC',
            'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'
          )
        else 'not_restarted'
      end
      || '|' || (
        select count(*) from pg_catalog.pg_stat_activity as activity
        where activity.datname = pg_catalog.current_database()
          and activity.pid <> pg_catalog.pg_backend_pid()
          and activity.backend_type = 'client backend'
          and activity.backend_start <= '${freeze_cutoff_utc}'::timestamptz
      )::text
      || '|' || (select count(*) from pg_catalog.pg_prepared_xacts)::text;" |
      run_source_sql 2>> "${freeze_log}" | tr -d '[:space:]'
  )" || true
  restart_readonly="${restart_state%%|*}"
  restart_remainder="${restart_state#*|}"
  restart_active_cron="${restart_remainder%%|*}"
  restart_remainder="${restart_remainder#*|}"
  postmaster_after_restart="${restart_remainder%%|*}"
  restart_remainder="${restart_remainder#*|}"
  restart_old_sessions="${restart_remainder%%|*}"
  restart_prepared_xacts="${restart_remainder#*|}"
  if [[ "${restart_readonly}" == on && "${restart_active_cron}" == 0 && \
        "${postmaster_after_restart}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' && \
        "${restart_old_sessions}" == 0 && "${restart_prepared_xacts}" == 0 ]]; then
    break
  fi
  sleep 5
done
[[ "${restart_readonly:-}" == on && "${restart_active_cron:-}" == 0 && \
   "${postmaster_after_restart:-}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' && \
   "${restart_old_sessions:-}" == 0 && "${restart_prepared_xacts:-}" == 0 ]] || \
  die "Source restart/freeze verifikácia sa nepotvrdila v limite. Cutover je zakázaný; použi recovery abort."

temporary_receipt="$(mktemp "${FREEZE_ROOT}/.freeze-${snapshot_id}.XXXXXX")"
{
  print -- "state=frozen"
  print -- "snapshot_id=${snapshot_id}"
  print -- "source_project_ref=${EXPECTED_SOURCE_REF}"
  print -- "target_project_ref=${EXPECTED_TARGET_REF}"
  print -- "frozen_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "freeze_cutoff_utc=${freeze_cutoff_utc}"
  print -- "restart_requested_at_utc=${restart_requested_at}"
  print -- "postmaster_before_restart_utc=${postmaster_before_restart}"
  print -- "postmaster_after_restart_utc=${postmaster_after_restart}"
  print -- "source_restart_verified=true"
  print -- "active_cron_job_ids=${active_cron_ids}"
  print -- "external_writers_attested_stopped=true"
} > "${temporary_receipt}"
chmod 600 "${temporary_receipt}"
mv "${temporary_receipt}" "${receipt_file}"

libpq_cleanup_credentials
trap - EXIT INT TERM
unset SOURCE_DB_URL TARGET_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN confirmation

print -- "Source write-freeze je aktívny a cron je vypnutý. Freeze musí zostať aktívny až do cutoveru alebo explicitného abort rollbacku."
print -- "Receipt: .context/migration/source-freeze/${receipt_file:t}"
