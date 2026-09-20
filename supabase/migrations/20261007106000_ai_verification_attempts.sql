-- How many times a case has been guessed at today.
--
-- The counter used to live on the call. That made it useless: hang up, dial
-- again, and the three tries reset — an unlimited oracle for anyone willing to
-- redial. It cannot key on the caller's number either, because the caller
-- chooses that number and can change it between attempts.
--
-- So it keys on the thing being protected. Whoever is asking, a case answers
-- the plate question three times a day and then stops answering it.

begin;

create table if not exists public.motorist_ai_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  attempts integer not null default 0 check (attempts >= 0),
  succeeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, day)
);

comment on table public.motorist_ai_verification_attempts is
  'Plate attempts per case per day. Keyed on the case because the caller controls their own number and can change it between tries.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.motorist_ai_verification_attempts'::regclass
      and tgname = 'motorist_ai_verification_attempts_touch'
  ) then
    create trigger motorist_ai_verification_attempts_touch
      before update on public.motorist_ai_verification_attempts
      for each row execute function public.motorist_set_updated_at();
  end if;
end $$;

alter table public.motorist_ai_verification_attempts enable row level security;

commit;
