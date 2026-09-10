-- R09 is inactive until an explicitly authorized physical three-party audio test.
-- Invitations share the existing call-session lease/version transaction; never
-- store a second authorization row that could race acceptance/revocation/end.
alter table public.motorist_telephony_settings
  add column if not exists monitor_invites_enabled boolean not null default false;
create index if not exists motorist_call_monitor_inbox_idx
  on public.motorist_call_sessions using gin(metadata jsonb_path_ops)
  where ended_at is null;

-- Fail-closed audit in the SAME transaction as invitation acceptance/revocation.
-- Names, phone numbers, SIP credentials and invitation bodies are not logged.
create or replace function public.motorist_audit_monitor_invitation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare item record; before_item jsonb; action_name text; actor_id uuid;
begin
  for item in select key, value from jsonb_each(coalesce(new.metadata->'monitorInvitations', '{}'::jsonb)) loop
    before_item := old.metadata->'monitorInvitations'->item.key;
    action_name := null;
    if before_item is null then
      action_name := 'telephony.monitor.invite'; actor_id := (item.value->>'inviterProfileId')::uuid;
    elsif item.value->>'revokedAt' is distinct from before_item->>'revokedAt' then
      action_name := 'telephony.monitor.revoke'; actor_id := (item.value->>'inviterProfileId')::uuid;
    elsif item.value->>'acceptedAt' is distinct from before_item->>'acceptedAt' then
      action_name := 'telephony.monitor.accept'; actor_id := (item.value->>'recipientProfileId')::uuid;
    elsif old.ended_at is null and new.ended_at is not null and item.value->>'acceptedAt' is not null and item.value->>'revokedAt' is null then
      action_name := 'telephony.monitor.call_ended'; actor_id := null;
    end if;
    if action_name is not null then
      insert into public.motorist_audit_log(organization_id, actor_profile_id, action, entity_type, entity_id, source, after_payload)
      values (new.organization_id, actor_id, action_name, 'telephony_call', new.id, 'telephony',
        jsonb_build_object('invitationId', item.key, 'recipientProfileId', item.value->>'recipientProfileId',
          'inviterProfileId', item.value->>'inviterProfileId', 'mode', 'monitor', 'expiresAt', item.value->>'expiresAt'));
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.motorist_audit_monitor_invitation() from public, anon, authenticated;
drop trigger if exists motorist_audit_monitor_invitation on public.motorist_call_sessions;
create trigger motorist_audit_monitor_invitation after update of metadata, ended_at on public.motorist_call_sessions
  for each row execute function public.motorist_audit_monitor_invitation();
