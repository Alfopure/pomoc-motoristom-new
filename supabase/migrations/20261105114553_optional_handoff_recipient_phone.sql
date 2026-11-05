begin;
set local lock_timeout = '3s';

-- A handoff can be delivered in the app or copied as a link without knowing the
-- recipient's phone. SMS preparation/sending still validates its own recipient.
alter table public.motorist_case_handoffs
  drop constraint motorist_case_handoffs_recipient_phone_check,
  add constraint motorist_case_handoffs_recipient_phone_check
    check (recipient_phone = '' or length(recipient_phone) between 5 and 30);

-- Keep the installed handoff implementation (including later operation patches,
-- authorization, idempotency and secret handling); change only its phone boundary.
do $migration$
declare
  definition text := pg_get_functiondef('public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb)'::regprocedure);
  old_validation text := $old$coalesce(p_input->>'recipientPhone','')!~'^\+?[0-9 ()-]{5,30}$'$old$;
  new_validation text := $new$(btrim(coalesce(p_input->>'recipientPhone',''))<>'' and btrim(p_input->>'recipientPhone')!~'^\+?[0-9 ()-]{5,30}$')$new$;
  old_value text := $old$btrim(p_input->>'recipientName'),p_input->>'recipientPhone',snapshot$old$;
  new_value text := $new$btrim(p_input->>'recipientName'),btrim(coalesce(p_input->>'recipientPhone','')),snapshot$new$;
begin
  if (length(definition)-length(replace(definition,old_validation,'')))/length(old_validation) <> 1
     or (length(definition)-length(replace(definition,old_value,'')))/length(old_value) <> 1 then
    raise exception 'Unexpected motorist_case_handoff phone validation; review before applying optional phone migration';
  end if;
  definition := replace(definition,old_validation,new_validation);
  definition := replace(definition,old_value,new_value);
  execute definition;
end
$migration$;

notify pgrst, 'reload schema';
commit;
