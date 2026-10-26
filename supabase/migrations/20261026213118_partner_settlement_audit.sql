begin;

-- Context writes already own the authenticated actor and revision. Record their
-- settlement snapshot inside that same transaction, without a second command.
create function public.motorist_audit_partner_settlement()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare previous jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.settlement is not distinct from old.settlement then return new; end if;
    previous := jsonb_build_object('caseId', old.case_id, 'partnerId', old.partner_id,
      'revision', old.revision, 'approvedCents', old.settlement->'approvedCents',
      'settlement', old.settlement, 'updatedBy', old.updated_by, 'updatedAt', old.updated_at);
  end if;
  insert into public.motorist_audit_log(
    organization_id, actor_profile_id, action, entity_type, entity_id, source,
    before_payload, after_payload, created_at
  ) values (
    new.organization_id, new.updated_by,
    case when tg_op = 'INSERT' then 'partner.settlement.create' else 'partner.settlement.update' end,
    'motorist_partner_case_contexts', new.case_id, 'partner_workspace', previous,
    jsonb_build_object('caseId', new.case_id, 'partnerId', new.partner_id,
      'revision', new.revision, 'approvedCents', new.settlement->'approvedCents',
      'settlement', new.settlement, 'updatedBy', new.updated_by, 'updatedAt', new.updated_at),
    clock_timestamp()
  );
  return new;
end;
$$;
create trigger motorist_partner_settlement_audit
after insert or update of settlement on public.motorist_partner_case_contexts
for each row execute function public.motorist_audit_partner_settlement();

-- Protect these new historical snapshots without changing other audit writers.
create function public.motorist_preserve_partner_settlement_audit()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Partner settlement audit is append-only' using errcode = '42501';
end;
$$;
create trigger motorist_partner_settlement_audit_immutable
before update or delete on public.motorist_audit_log
for each row when (old.entity_type = 'motorist_partner_case_contexts'
  and old.action in ('partner.settlement.create', 'partner.settlement.update'))
execute function public.motorist_preserve_partner_settlement_audit();

revoke all on function public.motorist_audit_partner_settlement() from public, anon, authenticated;
revoke all on function public.motorist_preserve_partner_settlement_audit() from public, anon, authenticated;
grant execute on function public.motorist_audit_partner_settlement() to service_role;
grant execute on function public.motorist_preserve_partner_settlement_audit() to service_role;
commit;
