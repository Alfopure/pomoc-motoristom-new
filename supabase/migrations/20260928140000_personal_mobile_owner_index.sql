begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Cover owner lookups and referential checks when a profile is changed or removed.
create index if not exists motorist_ring_group_members_owner_profile_id_idx
  on public.motorist_ring_group_members (owner_profile_id);

commit;
