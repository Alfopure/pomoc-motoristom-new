-- Private storage bucket for VIPTel call recordings (plan: call recordings Phase 1).
-- Objects live under {organization_id}/{call_id}/{cdr_id}.{ext}; access mirrors the
-- motorist_call_recordings table RLS (senior_dispatcher/manager/admin), which is
-- stricter than case attachments because recordings are sensitive personal data.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'motorist-call-recordings',
  'motorist-call-recordings',
  false,
  31457280, -- 30 MB, slightly above the 25 MB per-file cap enforced by the sync route
  array[
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
declare
  role_helper text;
begin
  if to_regprocedure('app_private.motorist_has_org_role(uuid, text[])') is not null then
    role_helper := 'app_private.motorist_has_org_role';
  elsif to_regprocedure('public.motorist_has_org_role(uuid, text[])') is not null then
    role_helper := 'public.motorist_has_org_role';
  else
    raise exception 'Required organization role helper motorist_has_org_role(uuid, text[]) was not found.';
  end if;

  execute 'drop policy if exists call_recordings_select_restricted on storage.objects';
  execute format(
    $policy$
      create policy call_recordings_select_restricted
        on storage.objects
        for select
        using (
          bucket_id = 'motorist-call-recordings'
          and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and %s(
            ((storage.foldername(name))[1])::uuid,
            array['senior_dispatcher', 'manager', 'admin']
          )
        )
    $policy$,
    role_helper
  );
end $$;

-- Uploads and deletes happen exclusively through the service-role sync/cleanup routes,
-- so no insert/update/delete policies are granted to authenticated users.
drop policy if exists call_recordings_insert_restricted on storage.objects;
drop policy if exists call_recordings_update_restricted on storage.objects;
drop policy if exists call_recordings_delete_restricted on storage.objects;
