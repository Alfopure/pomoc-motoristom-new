begin;
-- One ledger and complete receipt history. Existing money is deliberately not
-- inferred from today's mutable order payment intent. Historical immutable
-- rows stay untouched; NULL metadata projects as unclassified below.
alter table public.motorist_towing_payments add column cash_category text
  check (cash_category in ('regular','other','unclassified'));
alter table public.motorist_towing_cash_handovers add column cash_breakdown jsonb;
alter table public.motorist_towing_cash_movements add column cash_breakdown jsonb;
create index motorist_towing_cash_category_account on public.motorist_towing_cash_movements(account_id);
create index motorist_towing_cash_category_pending on public.motorist_towing_cash_handovers(account_id) where status='pending';

create function app_private.towing_cash_categories(p_account uuid,p_exclude_handover uuid default null)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_object_agg(k,jsonb_build_object(
  'balanceCents',(select coalesce(sum(coalesce((c.cash_breakdown->>k)::bigint,case when k='unclassified' then c.delta_cents else 0 end)),0) from public.motorist_towing_cash_movements c where c.account_id=p_account),
  'reservedCents',(select coalesce(sum(coalesce((h.cash_breakdown->>k)::bigint,case when k='unclassified' then h.amount_cents else 0 end)),0) from public.motorist_towing_cash_handovers h where h.account_id=p_account and h.status='pending' and h.id is distinct from p_exclude_handover)))
 from unnest(array['regular','other','unclassified']) k
$$;

create function app_private.towing_cash_payment_category() returns trigger
language plpgsql set search_path='' as $$
declare original public.motorist_towing_payments;
begin
 if TG_OP='UPDATE' then
  if new.cash_category is distinct from old.cash_category then raise exception 'Receipt category is immutable' using errcode='42501';end if;
  return new;
 end if;
 if new.method<>'cash' then
  if new.cash_category is not null then raise exception 'Cash category requires cash receipt' using errcode='22023';end if;
  return new;
 end if;
 if new.reversal_of is not null or new.refund_of is not null then
  select * into original from public.motorist_towing_payments where id=coalesce(new.reversal_of,new.refund_of) and organization_id=new.organization_id and order_id=new.order_id;
  if not found or original.method<>'cash' then raise exception 'Invalid category provenance' using errcode='22023';end if;
  if new.cash_category is not null and new.cash_category<>coalesce(original.cash_category,'unclassified') then raise exception 'Receipt category conflict' using errcode='22023';end if;
  new.cash_category:=coalesce(original.cash_category,'unclassified');
 else new.cash_category:=coalesce(new.cash_category,'unclassified');end if;
 return new;
end $$;
create trigger motorist_towing_receipt_category before insert or update of cash_category
on public.motorist_towing_payments for each row execute function app_private.towing_cash_payment_category();

create function app_private.towing_cash_handover_breakdown() returns trigger
language plpgsql set search_path='' as $$
declare categories jsonb; k text; available bigint; remaining bigint:=new.amount_cents; n bigint; result jsonb:='{}';
begin
 categories:=app_private.towing_cash_categories(new.account_id);
 if new.cash_breakdown is null then
  -- Older clients can still propose a total. Allocate existing unknown money
  -- first, then ordinary cash, then Other; the resulting split is persisted.
  foreach k in array array['unclassified','regular','other'] loop
   available:=greatest(0,(categories->k->>'balanceCents')::bigint-(categories->k->>'reservedCents')::bigint);
   n:=least(remaining,available);result:=result||jsonb_build_object(k,n);remaining:=remaining-n;
  end loop;
  if remaining<>0 then raise exception 'Insufficient available cash' using errcode='22023';end if;
  new.cash_breakdown:=result;
 else
  if jsonb_typeof(new.cash_breakdown)<>'object' or (new.cash_breakdown-array['regular','other','unclassified'])<>'{}'::jsonb then raise exception 'Invalid cash breakdown' using errcode='22023';end if;
  remaining:=0;
  foreach k in array array['regular','other','unclassified'] loop
   if jsonb_typeof(new.cash_breakdown->k) is distinct from 'number' or coalesce(new.cash_breakdown->>k,'') !~ '^[0-9]{1,16}$' then raise exception 'Invalid cash breakdown' using errcode='22023';end if;
   n:=(new.cash_breakdown->>k)::bigint;
   if n>9007199254740991 then raise exception 'Invalid cash breakdown' using errcode='22023';end if;
   available:=(categories->k->>'balanceCents')::bigint-(categories->k->>'reservedCents')::bigint;
   if n>available then raise exception 'Insufficient category cash' using errcode='22023';end if;
   remaining:=remaining+n;
  end loop;
  if remaining<>new.amount_cents then raise exception 'Cash breakdown total mismatch' using errcode='22023';end if;
 end if;
 return new;
end $$;
create trigger motorist_towing_handover_breakdown before insert on public.motorist_towing_cash_handovers
for each row execute function app_private.towing_cash_handover_breakdown();

create function app_private.towing_cash_movement_breakdown() returns trigger
language plpgsql set search_path='' as $$
declare payment public.motorist_towing_payments; handover public.motorist_towing_cash_handovers;
 categories jsonb; k text; n bigint; direction bigint; result jsonb:='{}';
begin
 if new.payment_id is not null then
  select * into payment from public.motorist_towing_payments where id=new.payment_id and organization_id=new.organization_id and method='cash';
  if not found then raise exception 'Invalid cash movement receipt' using errcode='22023';end if;
  new.cash_breakdown:=jsonb_build_object('regular',0,'other',0,'unclassified',0)||jsonb_build_object(coalesce(payment.cash_category,'unclassified'),new.delta_cents);
 else
  select * into handover from public.motorist_towing_cash_handovers where id=new.handover_id and organization_id=new.organization_id;
  if not found or abs(new.delta_cents)<>handover.amount_cents then raise exception 'Invalid cash movement handover' using errcode='22023';end if;
  direction:=case when new.delta_cents<0 then -1 else 1 end;
  foreach k in array array['regular','other','unclassified'] loop result:=result||jsonb_build_object(k,coalesce((handover.cash_breakdown->>k)::bigint,case when k='unclassified' then handover.amount_cents else 0 end)*direction);end loop;
  new.cash_breakdown:=result;
 end if;
 if new.delta_cents<0 then
  categories:=app_private.towing_cash_categories(new.account_id,new.handover_id);
  foreach k in array array['regular','other','unclassified'] loop
   n:=(new.cash_breakdown->>k)::bigint;
   if n<0 and -n>(categories->k->>'balanceCents')::bigint-(categories->k->>'reservedCents')::bigint then raise exception 'Insufficient category cash' using errcode='PT409';end if;
  end loop;
 end if;
 return new;
end $$;
create trigger motorist_towing_movement_breakdown before insert on public.motorist_towing_cash_movements
for each row execute function app_private.towing_cash_movement_breakdown();

-- Extend the existing command, including its original authorization, receipt
-- identity and replay checks. Exact anchors fail closed if upstream changed.
do $patch$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 anchor:=$a$if existing.order_id<>target or existing.amount_cents<>n or existing.driver_id is distinct from driver or existing.method<>(case when action='reconcile_receipt' then 'cash' else p->>'method' end) then$a$;
 replacement:=$r$if existing.order_id<>target or existing.amount_cents<>n or existing.driver_id is distinct from driver or existing.method<>(case when action='reconcile_receipt' then 'cash' else p->>'method' end) or (existing.method='cash' and p?'cashCategory' and coalesce(existing.cash_category,'unclassified') is distinct from p->>'cashCategory') then$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing receipt replay guard' using errcode='55000';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,captured_at,reason,evidence) values(p_organization_id,target,(p->>'receiptId')::uuid,n,case when action='reconcile_receipt' then 'cash' else p->>'method' end,driver,m.id,coalesce((p->>'capturedAt')::timestamptz,now()),p->>'reason',p->>'evidence')$a$;
 replacement:=$r$insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,captured_at,reason,evidence,cash_category) values(p_organization_id,target,(p->>'receiptId')::uuid,n,case when action='reconcile_receipt' then 'cash' else p->>'method' end,driver,m.id,coalesce((p->>'capturedAt')::timestamptz,now()),p->>'reason',p->>'evidence',case when p->>'method'='cash' or action='reconcile_receipt' then coalesce(p->>'cashCategory',case when action='reconcile_receipt' then 'unclassified' when o.fields->>'paymentIntent'='cash_other' then 'other' else 'regular' end) else null end)$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing receipt insertion' using errcode='55000';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$insert into public.motorist_towing_cash_handovers(id,organization_id,driver_id,account_id,amount_cents) values(target,p_organization_id,m.id,a.id,n);$a$;
 replacement:=$r$insert into public.motorist_towing_cash_handovers(id,organization_id,driver_id,account_id,amount_cents,cash_breakdown) values(target,p_organization_id,m.id,a.id,n,p->'cashBreakdown');$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing handover insertion' using errcode='55000';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reason,evidence) values(p_organization_id,target,(p->>'replacementReceiptId')::uuid,n,pay.method,pay.driver_id,m.id,p->>'reason',p->>'evidence');$a$;
 replacement:=$r$insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reason,evidence,cash_category) values(p_organization_id,target,(p->>'replacementReceiptId')::uuid,n,pay.method,pay.driver_id,m.id,p->>'reason',p->>'evidence',pay.cash_category);$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing correction insertion' using errcode='55000';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$when 'propose_handover' then 'drive'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing collection capability' using errcode='55000';end if;
 definition:=replace(definition,anchor,$r$when 'collect_cash' then 'cash' when 'propose_handover' then 'drive'$r$);
 anchor:=$a$'set_parking','propose_handover','accept_handover'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing collection target guard' using errcode='55000';end if;
 definition:=replace(definition,anchor,$r$'set_parking','propose_handover','collect_cash','accept_handover'$r$);
 anchor:=$a$elsif action='propose_handover' then$a$;
 replacement:=$r$elsif action='collect_cash' then
 if o.id is not null or exists(select 1 from public.motorist_towing_cash_handovers where id=target) then raise exception 'Collection identity conflict' using errcode='PT409';end if;
 driver:=(p->>'driverId')::uuid;n:=(p->>'amountCents')::bigint;
 if driver is null or not exists(select 1 from public.motorist_towing_memberships where id=driver and organization_id=p_organization_id and active and 'drive'=any(capabilities)) then raise exception 'Invalid custodian' using errcode='22023';end if;
 a:=app_private.towing_account(p_organization_id,driver);office:=app_private.towing_account(p_organization_id,null);
 if a.revision is distinct from (p->>'accountRevision')::bigint or office.revision is distinct from (p->>'officeRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if n is null or n<=0 or n>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id) then raise exception 'Insufficient available cash' using errcode='22023';end if;
 if app_private.towing_balance(office.id)+n>9007199254740991 then raise exception 'Cash account limit' using errcode='22023';end if;
 insert into public.motorist_towing_cash_handovers(id,organization_id,driver_id,account_id,amount_cents,cash_breakdown) values(target,p_organization_id,driver,a.id,n,p->'cashBreakdown');
 insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,handover_id,command_id) values(p_organization_id,a.id,-n,target,cid),(p_organization_id,office.id,n,target,cid);
 update public.motorist_towing_cash_handovers set status='accepted',revision=2,reason='Potvrdené prevzatie hotovosti kanceláriou' where id=target;
 update public.motorist_towing_cash_accounts set revision=revision+1 where id in (a.id,office.id);
 result:=jsonb_build_object('handoverId',target);
 elsif action='propose_handover' then$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing collection branch' using errcode='55000';end if;
 execute replace(definition,anchor,replacement);
end $patch$;

-- Project the immutable receipt category, category balances and recorded split.
do $patch$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('app_private.towing_order_json(public.motorist_towing_orders,boolean,uuid)'::regprocedure);
 anchor:=$a$'method',p.method,'driverId'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing payment projection' using errcode='55000';end if;
 execute replace(definition,anchor,$r$'method',p.method,'cashCategory',case when p.method='cash' then coalesce(p.cash_category,'unclassified') end,'driverId'$r$);
 definition:=pg_get_functiondef('public.motorist_towing_workspace(uuid,uuid,bigint,text,jsonb)'::regprocedure);
 anchor:=$a$'reservedCents',app_private.towing_reserved(x.id),'revision',x.revision$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing account projection' using errcode='55000';end if;
 definition:=replace(definition,anchor,$r$'reservedCents',app_private.towing_reserved(x.id),'revision',x.revision,'categories',app_private.towing_cash_categories(x.id)$r$);
 anchor:=$a$'amountCents',h.amount_cents,'status',h.status$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing handover projection' using errcode='55000';end if;
 execute replace(definition,anchor,$r$'amountCents',h.amount_cents,'cashBreakdown',coalesce(h.cash_breakdown,jsonb_build_object('regular',0,'other',0,'unclassified',h.amount_cents)),'status',h.status$r$);
end $patch$;

revoke all on function app_private.towing_cash_categories(uuid,uuid) from public,anon,authenticated;
revoke all on function app_private.towing_cash_payment_category() from public,anon,authenticated;
revoke all on function app_private.towing_cash_handover_breakdown() from public,anon,authenticated;
revoke all on function app_private.towing_cash_movement_breakdown() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
