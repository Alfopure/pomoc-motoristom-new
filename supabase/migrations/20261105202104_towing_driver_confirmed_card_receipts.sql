begin;
-- A confirmed terminal payment is an observed receipt, not cash held by the
-- driver. Existing receipt identity, assignment generation and authorization
-- remain unchanged; only the method allowlist is widened.
do $patch$
declare definition text; anchor text:=$a$(driver_op and p->>'method'<>'cash')$a$;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected driver payment guard' using errcode='55000'; end if;
 -- Fail closed if the distinct physical-cash ledger branch changed upstream.
 if position($a$if p->>'method'='cash' or action='reconcile_receipt' then$a$ in definition)=0 then raise exception 'Unexpected towing cash ledger branch' using errcode='55000'; end if;
 execute replace(definition,anchor,$r$(driver_op and coalesce(p->>'method','') not in ('cash','card'))$r$);
end $patch$;
notify pgrst,'reload schema';
commit;
