#!/bin/zsh

management_api_readonly_json() {
  local project_ref="$1"
  local access_token="$2"
  [[ "${project_ref}" =~ '^[a-z0-9]{20}$' && -n "${access_token}" ]] || return 2

  MANAGEMENT_API_PROJECT_REF="${project_ref}" \
  MANAGEMENT_API_ACCESS_TOKEN="${access_token}" \
    node --input-type=module -e '
      let query = "";
      for await (const chunk of process.stdin) query += chunk;
      if (!query.trim()) throw new Error("Management API read-only query is empty.");
      const response = await fetch(
        `https://api.supabase.com/v1/projects/${process.env.MANAGEMENT_API_PROJECT_REF}/database/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MANAGEMENT_API_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, read_only: true }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      const rows = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rows)) {
        throw new Error(`Management API read-only query failed (HTTP ${response.status}).`);
      }
      process.stdout.write(JSON.stringify(rows));
    '
}

management_api_source_freeze_state() {
  local project_ref="$1"
  local access_token="$2"
  local rows
  rows="$(print -r -- "select
      case when exists (
        select 1
        from pg_catalog.pg_db_role_setting as settings
        join pg_catalog.pg_database as databases
          on databases.oid = settings.setdatabase
        where databases.datname = pg_catalog.current_database()
          and settings.setrole = 0
          and \$database_setting\$default_transaction_read_only=on\$database_setting\$
            = any(settings.setconfig)
      ) then 'on' else 'off' end as read_only,
      case when pg_catalog.to_regclass('cron.job') is null then -1
        else (select pg_catalog.count(*) from cron.job where active)
      end as active_cron_jobs;" | management_api_readonly_json "${project_ref}" "${access_token}")" || return 1
  print -r -- "${rows}" | jq -er '
    if length == 1
      and .[0].read_only == "on"
      and (.[0].active_cron_jobs | tonumber) == 0
    then "on|0" else error("source freeze state mismatch") end
  '
}
