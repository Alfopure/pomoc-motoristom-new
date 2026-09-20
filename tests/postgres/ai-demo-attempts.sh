#!/usr/bin/env bash
# Applies `20261007100000_ai_demo.sql` to a disposable PostgreSQL cluster and
# checks the guarantees the application relies on.
#
# The fixture contains only what this one migration references — the two
# referenced tables, the `updated_at` trigger function and the `service_role`
# role. It is not a Supabase reset and proves nothing about the hosted project;
# it proves that the DDL applies and that the partial unique indexes enforce
# "one demo at a time", request idempotency and per-leg ownership.
#
# Usage: bash tests/postgres/ai-demo-attempts.sh
set -euo pipefail

PORT="${PGPORT_OVERRIDE:-55433}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$(mktemp -d)/ai-demo-pg"
SOCK="$(mktemp -d)"
export PGHOST="$SOCK"
export PGPORT="$PORT"
export PGDATABASE=ai_demo_contract

cleanup() {
  pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA" "$SOCK"
}
trap cleanup EXIT

initdb -D "$DATA" -U postgres --auth=trust >/dev/null
# `logging_collector` is on in the distribution config and would fight `-l`.
pg_ctl -D "$DATA" -o "-k $SOCK -p $PORT -c listen_addresses='' -c logging_collector=off" -l "$DATA/server.log" -w start >/dev/null
createdb -U postgres "$PGDATABASE"

run() { psql -U postgres -v ON_ERROR_STOP=1 -qtAX "$@"; }

run <<'SQL'
create role service_role;
create role anon;
create role authenticated;
create extension if not exists pgcrypto;

create table public.motorist_organizations (id uuid primary key);
create table public.motorist_profiles (id uuid primary key);

create function public.motorist_set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

insert into public.motorist_organizations (id) values ('00000000-0000-4000-8000-000000000001');
insert into public.motorist_profiles (id) values ('00000000-0000-4000-8000-000000000005');
SQL

run -f "$ROOT/supabase/migrations/20261007100000_ai_demo.sql" >/dev/null
echo "migration applied"

# Applying it twice must be a no-op: a preview redeploy must not break a push.
run -f "$ROOT/supabase/migrations/20261007100000_ai_demo.sql" >/dev/null
echo "migration is idempotent"

insert_attempt() {
  run <<SQL
insert into public.motorist_ai_demo_attempts
  (organization_id, actor_profile_id, environment, target_number, from_number, correlation_token, sip_dial_command_id, deadline_at, state, request_id, telnyx_sip_call_control_id)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'development',
   '+421910988882', '+421232408774', 'PM-AI-DEMO-$1', 'cmd-$1', now() + interval '7 minutes', '$2', $3, $4);
SQL
}

insert_attempt aaaaaaaa requested null null >/dev/null
echo "first attempt inserted"

if insert_attempt bbbbbbbb requested null null >/dev/null 2>&1; then
  echo "FAIL: a second open attempt was allowed" >&2
  exit 1
fi
echo "one open attempt per organisation is enforced"

run -c "update public.motorist_ai_demo_attempts set state = 'ended' where state = 'requested';" >/dev/null
insert_attempt cccccccc requested "'11111111-2222-4333-8444-555555555555'" null >/dev/null
echo "a new attempt is allowed once the previous one is terminal"

if insert_attempt dddddddd ended "'11111111-2222-4333-8444-555555555555'" null >/dev/null 2>&1; then
  echo "FAIL: a replayed request_id created a second attempt" >&2
  exit 1
fi
echo "request_id idempotency is enforced"

run -c "update public.motorist_ai_demo_attempts set state = 'ended', telnyx_sip_call_control_id = 'cc-shared' where telnyx_sip_call_control_id is null and state <> 'ended';" >/dev/null
if insert_attempt eeeeeeee ended null "'cc-shared'" >/dev/null 2>&1; then
  echo "FAIL: two attempts claimed the same call_control_id" >&2
  exit 1
fi
echo "a call_control_id belongs to exactly one attempt"

if run -c "insert into public.motorist_ai_demo_attempts (organization_id, environment, target_number, from_number, correlation_token, sip_dial_command_id, deadline_at, state) values ('00000000-0000-4000-8000-000000000001','development','+421910988882','+421232408774','t','c', now(), 'talking_to_veronika');" >/dev/null 2>&1; then
  echo "FAIL: an unknown state was accepted" >&2
  exit 1
fi
echo "the state check constraint rejects an unknown state"

TOUCHED=$(run -c "update public.motorist_ai_demo_attempts set state = 'failed', error_code = 'x' where true returning (updated_at > created_at);" | head -1)
if [ "$TOUCHED" != "t" ]; then
  echo "FAIL: the updated_at trigger did not fire (got '$TOUCHED')" >&2
  exit 1
fi
echo "the updated_at trigger fires"

for ROLE in anon authenticated; do
  GRANTS=$(run -c "select count(*) from information_schema.role_table_grants where table_name = 'motorist_ai_demo_attempts' and grantee = '$ROLE';")
  if [ "$GRANTS" != "0" ]; then
    echo "FAIL: $ROLE holds $GRANTS grants on the demo table" >&2
    exit 1
  fi
done
echo "no session role can reach the table"

RLS=$(run -c "select relrowsecurity from pg_class where relname = 'motorist_ai_demo_attempts';")
[ "$RLS" = "t" ] || { echo "FAIL: row level security is not enabled" >&2; exit 1; }
echo "row level security is enabled"

echo "ai-demo-attempts: ok"
