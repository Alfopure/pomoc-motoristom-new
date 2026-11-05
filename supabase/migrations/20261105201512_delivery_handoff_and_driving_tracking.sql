begin;
set local lock_timeout = '3s';

-- Keep the installed command's authorization, locking, replay, capacity and
-- evidence validation. A delivery may finish directly from driving; no synthetic
-- arrival event or intermediate revision is written. Older arrive clients remain valid.
do $migration$
declare
 definition text := pg_get_functiondef('app_private.motorist_operations_command_base(uuid,uuid,jsonb)'::regprocedure);
 old_transition text := $old$elsif action='complete' and ((op.kind='collection' and ex.status='collected') or (op.kind<>'collection' and ex.status='arrived')) then$old$;
 new_transition text := $new$elsif action='complete' and ((op.kind='collection' and ex.status='collected') or (op.kind='delivery' and ex.status in ('en_route','arrived')) or (op.kind='transfer' and ex.status='arrived')) then
   if op.kind='delivery' and not exists(select 1 from public.motorist_operation_evidence ev where ev.operation_id=op.id and ev.stage='handover') then
    raise exception 'Handover evidence required' using errcode='22023';
   end if;$new$;
begin
 if (length(definition)-length(replace(definition,old_transition,'')))/length(old_transition) <> 1 then
  raise exception 'Unexpected delivery completion transition; review before applying';
 end if;
 execute replace(definition,old_transition,new_transition);
end $migration$;

-- New operations share GPS only once driving starts. Legacy handoff functions
-- deliberately retain their older acceptance-based behavior.
do $migration$
declare
 signature text; definition text;
 old_states text := $old$ex.status not in ('accepted','en_route','arrived','collected')$old$;
 new_states text := $new$ex.status not in ('en_route','arrived','collected') or ex.started_at is null or ex.started_at < coalesce((select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),'-infinity'::timestamptz)$new$;
 anchor text; replacement text;
begin
 foreach signature in array array[
  'public.motorist_operation_position(uuid,uuid,uuid,jsonb)',
  'public.motorist_operation_tracker(uuid,uuid,uuid,text,text)',
  'app_private.motorist_operation_record_positions(uuid,uuid,uuid,jsonb)'
 ] loop
  definition := pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,old_states,'')))/length(old_states) <> 1 then
   raise exception 'Unexpected operation tracking state guard: %', signature;
  end if;
  definition := replace(definition,old_states,new_states);
  -- Departure belongs to the execution, regardless of whether its own driver
  -- or dispatch started it. No buffered point from before departure is accepted.
  if position('record_positions' in signature)>0 then
   anchor:=$old$select coalesce(
   (select min(ev.created_at) from public.motorist_operation_events ev
     where ev.operation_id=p_operation_id and ev.actor_user_id=m.auth_user_id and ev.action in ('accept','start','arrive','collect')
      and ev.created_at>=coalesce((select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),'-infinity'::timestamptz)),
   (select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),
   '-infinity'::timestamptz) into v_from;
 v_from:=greatest(clock_timestamp()-interval '12 hours',v_from-interval '1 minute');$old$;
   replacement:=$new$v_from:=greatest(clock_timestamp()-interval '12 hours',ex.started_at);$new$;
  elsif position('operation_position(' in signature)>0 then
   anchor:=$old$select min(ev.created_at) into v_since from public.motorist_operation_events ev
  where ev.operation_id=p_operation_id and ev.actor_user_id=p_user_id and ev.action in ('accept','start','arrive','collect')
   and ev.created_at>=coalesce((select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),'-infinity'::timestamptz);$old$;
   replacement:=$new$v_since:=ex.started_at;$new$;
  else anchor:=null;
  end if;
  if anchor is not null then
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected departure provenance: %',signature; end if;
   definition:=replace(definition,anchor,replacement);
  end if;
  if position('operation_position(' in signature)>0 then
   anchor:=$old$coalesce(v_since,'-infinity'::timestamptz)-interval '1 minute'$old$;
   if position(anchor in definition)=0 then raise exception 'Unexpected foreground departure tolerance'; end if;
   definition:=replace(definition,anchor,'v_since');
  end if;
  execute definition;
 end loop;
end $migration$;

commit;
