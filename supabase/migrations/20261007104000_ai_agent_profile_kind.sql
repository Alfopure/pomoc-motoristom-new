-- An account that cannot log in.
--
-- The AI answers calls, owns cases and signs its own audit rows, so it needs a
-- profile like anyone else. What it must never have is a way in: no auth user,
-- no password, no session. `motorist_profiles.user_id` is already nullable, so
-- the row costs nothing — but nothing in the schema says *why* it is null, and
-- a null there otherwise means "invited, not yet accepted".
--
-- This column is that distinction, and every listing that offers a human to a
-- human filters on it.

begin;

alter table public.motorist_profiles
  add column if not exists kind text not null default 'human';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.motorist_profiles'::regclass and conname = 'motorist_profiles_kind_check'
  ) then
    alter table public.motorist_profiles
      add constraint motorist_profiles_kind_check check (kind in ('human', 'ai'));
  end if;
end $$;

comment on column public.motorist_profiles.kind is
  'human = a person who signs in; ai = the assistant, which has no auth user and must be excluded from anything that offers a colleague.';

-- Reads are always "the humans of this organisation", never a scan by kind.
create index if not exists motorist_profiles_org_kind_idx
  on public.motorist_profiles (organization_id, kind);

commit;
