-- Supabase's default table grants include service_role writes. Keep direct
-- diagnostic access read-only; the postgres-owned SECURITY DEFINER RPCs write.
set local lock_timeout = '250ms';
set local statement_timeout = '5s';

revoke all privileges on table
 public.motorist_diagnostic_guard,
 public.motorist_diagnostic_counters,
 public.motorist_diagnostic_events,
 public.motorist_diagnostic_incidents
from service_role;

grant select on table
 public.motorist_diagnostic_guard,
 public.motorist_diagnostic_counters,
 public.motorist_diagnostic_events,
 public.motorist_diagnostic_incidents
to service_role;
