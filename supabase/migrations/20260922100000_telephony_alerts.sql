-- Phase 5 (hardening): the notification ledger behind `telephony.alerts`.
--
-- Until now nothing in this copy could tell anybody that the exchange is in
-- trouble. `recordTelephonyIncident` writes a row, `/api/telephony/health`
-- answers when asked — but a stuck session at 03:00 waits for somebody to look.
-- The alert job closes that gap by e-mailing `ALERT_EMAIL_TO`, and this table
-- is what stops it from sending the same message every five minutes: one row
-- per organisation and alert key, written when the mail goes out.
--
-- The key carries the local day and the failing check (e.g.
-- `2026-09-22:sessions:fail`), so a genuinely new problem is always a new row
-- and therefore a new e-mail, while the same problem on the same day is sent
-- once. `sends` and `last_seen_at` keep counting after the first mail, which is
-- how the runbook tells "it happened once" from "it has been failing all day".
--
-- Service role only: the job runs behind the cron secret and no browser ever
-- reads this.

create table if not exists public.motorist_telephony_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  alert_key text not null,
  status text not null check (status in ('warn', 'fail')),
  detail jsonb not null default '{}'::jsonb,
  sends integer not null default 1 check (sends >= 0),
  first_sent_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, alert_key)
);

create index if not exists telephony_alerts_org_sent_idx
  on public.motorist_telephony_alerts (organization_id, last_sent_at desc);

drop trigger if exists set_updated_at on public.motorist_telephony_alerts;
create trigger set_updated_at
  before update on public.motorist_telephony_alerts
  for each row
  execute function public.motorist_set_updated_at();

alter table public.motorist_telephony_alerts enable row level security;
revoke all on table public.motorist_telephony_alerts from public, anon, authenticated;
grant select, insert, update, delete on table public.motorist_telephony_alerts to service_role;
