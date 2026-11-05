begin;
-- Optional observed handover facts. Historical drafts without them remain valid.
do $patch$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 anchor:=$a$'realizedItems','odometer','paymentIntent'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected office handover fields' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'realizedItems','odometer','paymentIntent','handoverRecipientName','handedOverAt','handoverException'$r$);
 anchor:=$a$'odometer','realizedItems','paymentIntent','owner'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver handover fields' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'odometer','realizedItems','paymentIntent','handoverRecipientName','handedOverAt','handoverException','owner'$r$);
 anchor:=$a$f:=jsonb_strip_nulls(f);$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected handover validation location' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 if length(coalesce(f->>'handoverRecipientName',''))>300 or length(coalesce(f->>'handoverException',''))>2000 then raise exception 'Handover fields too long' using errcode='22023'; end if;
 if nullif(f->>'handedOverAt','') is not null then
  if f->>'handedOverAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Handover requires a zoned timestamp' using errcode='22023'; end if;
  perform (f->>'handedOverAt')::timestamptz;
 end if;$r$);
 execute definition;
 definition:=pg_get_functiondef('app_private.towing_driver_fields(jsonb)'::regprocedure);
 anchor:=$a$'odometer','realizedItems','paymentIntent'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected handover read projection' using errcode='55000'; end if;
 execute replace(definition,anchor,$r$'odometer','realizedItems','paymentIntent','handoverRecipientName','handedOverAt','handoverException'$r$);
 definition:=pg_get_functiondef('app_private.towing_assert_complete(public.motorist_towing_orders)'::regprocedure);
 anchor:=$a$begin$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected handover completion guard' using errcode='55000'; end if;
 execute replace(definition,anchor,anchor||$r$
 if (nullif(btrim(o.fields->>'handoverRecipientName'),'') is not null or nullif(o.fields->>'handedOverAt','') is not null)
 and (nullif(btrim(o.fields->>'handoverRecipientName'),'') is null or nullif(o.fields->>'handedOverAt','') is null)
 and nullif(btrim(o.fields->>'handoverException'),'') is null then raise exception 'Handover requires recipient and time or an explicit exception' using errcode='22023'; end if;$r$);
end $patch$;
notify pgrst,'reload schema';
commit;
