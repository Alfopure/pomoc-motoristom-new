-- Keep favorite lookups and cascading contact deletions efficient, and evaluate
-- auth.uid() once per statement rather than once for every candidate row.
create index if not exists motorist_contact_favorites_contact_idx
  on public.motorist_contact_favorites (contact_id);

drop policy if exists motorist_contact_favorites_select_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_select_own
  on public.motorist_contact_favorites
  for select
  using (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
  );

drop policy if exists motorist_contact_favorites_insert_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_insert_own
  on public.motorist_contact_favorites
  for insert
  with check (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
    and exists (
      select 1
      from public.motorist_contacts contacts
      where contacts.id = motorist_contact_favorites.contact_id
        and contacts.organization_id = motorist_contact_favorites.organization_id
    )
  );

drop policy if exists motorist_contact_favorites_delete_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_delete_own
  on public.motorist_contact_favorites
  for delete
  using (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
  );
