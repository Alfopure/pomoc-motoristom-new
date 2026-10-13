-- Additive towing module. No seed, no legacy role/profile grant, no case state mutation.
-- Bootstrap is a separate operator-reviewed INSERT into memberships for one explicitly
-- authorized auth user/org with roles ARRAY['manager']; capabilities must use the helper.
create schema if not exists app_private;
create table public.motorist_towing_memberships (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 auth_user_id uuid not null references auth.users(id), display_name text not null, email text,
 roles text[] not null check(roles <@ array['driver','dispatch','billing','manager']::text[] and cardinality(roles)>0),
 capabilities text[] not null, active boolean not null default true, membership_version bigint not null default 1,
 office_profile_id uuid references public.motorist_profiles(id), password_set_at timestamptz,
 unique(organization_id,auth_user_id), unique(organization_id,id)
);
create table public.motorist_towing_parking_sites (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id),
 name text not null, address text not null, active boolean not null default true, revision bigint not null default 1,
 unique(organization_id,id)
);
create table public.motorist_towing_tax_config (
 organization_id uuid primary key references public.motorist_organizations(id), rates jsonb not null,
 valid_from date not null, valid_until date, label text not null, revision bigint not null default 1
);
create sequence public.motorist_towing_order_number;
create table public.motorist_towing_orders (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id),
 number text not null default ('Z-'||lpad(nextval('public.motorist_towing_order_number')::text,8,'0')),
 source_case_id uuid references public.motorist_cases(id), source_snapshot jsonb, source_copied_at timestamptz, fields jsonb not null default '{}', office_notes text not null default '',
 revision bigint not null default 1, assignment_generation bigint not null default 0,
 driver_id uuid, work_status text not null default 'draft' check(work_status in ('draft','assigned','in_progress','submitted','needs_changes','cancelled')),
 billing_status text not null default 'not_ready' check(billing_status in ('not_ready','ready','invoiced','not_required')),
 lines jsonb not null default '[]', tax_date date, approved_cents bigint, authorized_collection_cents bigint check(authorized_collection_cents>=0),
 reconciliation_required boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,number), foreign key(organization_id,driver_id) references public.motorist_towing_memberships(organization_id,id)
);
create index motorist_towing_orders_list on public.motorist_towing_orders(organization_id,work_status,updated_at desc);
create table public.motorist_towing_assignments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null, driver_id uuid not null,
 generation bigint not null, assigned_at timestamptz not null default now(), ended_at timestamptz,
 unique(organization_id,order_id,generation), foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id),
 foreign key(organization_id,driver_id) references public.motorist_towing_memberships(organization_id,id)
);
create unique index motorist_towing_assignment_current on public.motorist_towing_assignments(order_id) where ended_at is null;
create index motorist_towing_driver_assignments on public.motorist_towing_assignments(organization_id,driver_id) where ended_at is null;
create table public.motorist_towing_attachments (
 id uuid primary key, organization_id uuid not null, order_id uuid not null, actor_id uuid not null,
 assignment_generation bigint not null, kind text not null check(kind in ('work','handover','scan')), name text not null,
 mime_type text not null check(mime_type in ('image/jpeg','image/png','application/pdf')), size bigint not null check(size between 1 and 10485760),
 status text not null default 'pending' check(status in ('pending','ready','abandoned')), sha256 text, path text not null unique,
 created_at timestamptz not null default now(), foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id)
);
create table public.motorist_towing_document_versions (
 id uuid primary key, organization_id uuid not null, order_id uuid not null, version integer not null, kind text not null check(kind in ('work','priced')),
 snapshot jsonb not null, snapshot_hash text not null, status text not null default 'generating' check(status in ('generating','ready','failed')),
 path text not null unique, sha256 text, error text, created_at timestamptz not null default now(),
 unique(organization_id,order_id,version), foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id)
);
create table public.motorist_towing_invoice_records (
 id uuid primary key, organization_id uuid not null, order_id uuid not null, number text not null, invoice_date date not null,
 amount_cents bigint not null check(amount_cents>=0), supersedes_id uuid unique references public.motorist_towing_invoice_records(id), reason text,
 created_at timestamptz not null default now(), foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id)
);
create table public.motorist_towing_payments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null, receipt_id uuid not null,
 amount_cents bigint not null check(amount_cents<>0), method text not null check(method in ('cash','card','bank','other')),
 driver_id uuid, actor_id uuid not null, reversal_of uuid unique references public.motorist_towing_payments(id), refund_of uuid references public.motorist_towing_payments(id), reason text, evidence text,
 captured_at timestamptz not null default now(), created_at timestamptz not null default now(),
 unique(organization_id,receipt_id), foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id),
 foreign key(organization_id,driver_id) references public.motorist_towing_memberships(organization_id,id)
);
create table public.motorist_towing_cash_accounts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id), driver_id uuid,
 revision bigint not null default 1, unique(organization_id,id), foreign key(organization_id,driver_id) references public.motorist_towing_memberships(organization_id,id)
);
create unique index motorist_towing_cash_owner on public.motorist_towing_cash_accounts(organization_id,coalesce(driver_id,'00000000-0000-0000-0000-000000000000'::uuid));
create table public.motorist_towing_cash_handovers (
 id uuid primary key, organization_id uuid not null, driver_id uuid not null, account_id uuid not null, amount_cents bigint not null check(amount_cents>0),
 status text not null default 'pending' check(status in ('pending','accepted','rejected','cancelled')), revision bigint not null default 1,
 reason text, created_at timestamptz not null default now(), foreign key(organization_id,account_id) references public.motorist_towing_cash_accounts(organization_id,id),
 foreign key(organization_id,driver_id) references public.motorist_towing_memberships(organization_id,id)
);
create table public.motorist_towing_cash_movements (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, account_id uuid not null, delta_cents bigint not null check(delta_cents<>0),
 payment_id uuid references public.motorist_towing_payments(id), handover_id uuid references public.motorist_towing_cash_handovers(id),
 command_id uuid not null, created_at timestamptz not null default now(), foreign key(organization_id,account_id) references public.motorist_towing_cash_accounts(organization_id,id),
 check(num_nonnulls(payment_id,handover_id)=1)
);
create table public.motorist_towing_reconciliations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null, receipt_id uuid,
 actor_id uuid not null, status text not null check(status in ('open','resolved')), reason text not null, evidence text,
 payment_id uuid references public.motorist_towing_payments(id), resolves_id uuid unique references public.motorist_towing_reconciliations(id), created_at timestamptz not null default now(),
 foreign key(organization_id,order_id) references public.motorist_towing_orders(organization_id,id)
);
create table public.motorist_towing_commands (
 organization_id uuid not null, command_id uuid not null, actor_id uuid not null, action text not null, target_id uuid not null,
 fingerprint text not null, required_capability text not null, result jsonb not null, assignment_generation bigint, created_at timestamptz not null default now(), primary key(organization_id,command_id)
);
create table public.motorist_towing_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, target_id uuid not null, actor_id uuid not null,
 action text not null, command_id uuid not null, payload jsonb not null, created_at timestamptz not null default now()
);
create table public.motorist_towing_email_deliveries (
 id uuid primary key, organization_id uuid not null, document_id uuid not null references public.motorist_towing_document_versions(id),
 recipient text not null, status text not null default 'pending' check(status in ('pending','accepted','failed','unknown')),
 provider_message_id text, created_at timestamptz not null default now()
);

create or replace function app_private.towing_capabilities(p_roles text[]) returns text[] language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct c),'{}'::text[]) from unnest(p_roles) r cross join lateral unnest(case r
 when 'driver' then array['drive'] when 'dispatch' then array['operate','price','documents']
 when 'billing' then array['price','bill','cash','documents','report']
 when 'manager' then array['operate','price','bill','cash','correct','members','documents','report'] else '{}'::text[] end) c
$$;
create or replace function app_private.towing_member_json(m public.motorist_towing_memberships) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',m.id,'userId',m.auth_user_id,'organizationId',m.organization_id,'displayName',m.display_name,'roles',m.roles,'capabilities',m.capabilities,'active',m.active,'version',m.membership_version,'email',m.email,'passwordCompleted',m.password_set_at is not null)
$$;
create or replace function app_private.towing_authorize(u uuid,o uuid,v bigint) returns public.motorist_towing_memberships language plpgsql set search_path='' as $$
 declare m public.motorist_towing_memberships; begin
 select * into m from public.motorist_towing_memberships where auth_user_id=u and organization_id=o for share;
 if not found or not m.active or m.membership_version<>v then raise exception 'Towing access denied' using errcode='42501'; end if;
 if m.office_profile_id is not null and not exists(select 1 from public.motorist_profiles p where p.id=m.office_profile_id and p.user_id=u and p.organization_id=o and p.active and coalesce(to_jsonb(p)->>'access_status','active')<>'disabled') then raise exception 'Towing access denied' using errcode='42501';end if;
 if not exists(select 1 from public.motorist_organizations where id=o and active) then raise exception 'Towing access denied' using errcode='42501';end if;
 return m; end $$;
create or replace function public.motorist_towing_actor(p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships;begin
 select * into m from public.motorist_towing_memberships where auth_user_id=p_user_id and active order by id limit 1;
 if not found then return null;end if;
 m:=app_private.towing_authorize(p_user_id,m.organization_id,m.membership_version);return app_private.towing_member_json(m);
 end $$;
create or replace function public.motorist_towing_password_completed(p_user_id uuid) returns void language sql security definer set search_path='' as $$
 update public.motorist_towing_memberships set password_set_at=now() where auth_user_id=p_user_id and active
$$;
create or replace function app_private.towing_immutable() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Immutable towing record' using errcode='42501';end$$;
create or replace function app_private.towing_document_guard() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or (to_jsonb(new)-array['status','sha256','error'])<>(to_jsonb(old)-array['status','sha256','error']) or old.status='ready' then raise exception 'Immutable towing document' using errcode='42501';end if;return new;end$$;
create trigger motorist_towing_document_immutable before update or delete on public.motorist_towing_document_versions for each row execute function app_private.towing_document_guard();
do $$declare t text;begin foreach t in array array['payments','cash_movements','invoice_records','commands','events','reconciliations'] loop execute format('create trigger towing_immutable before update or delete on public.motorist_towing_%I for each row execute function app_private.towing_immutable()',t);end loop;end$$;
create or replace function app_private.towing_attachment_guard() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or old.status<>'pending' or (to_jsonb(new)-array['status','sha256'])<>(to_jsonb(old)-array['status','sha256']) then raise exception 'Immutable attachment metadata' using errcode='42501';end if;return new;end$$;
create trigger motorist_towing_attachment_immutable before update or delete on public.motorist_towing_attachments for each row execute function app_private.towing_attachment_guard();
create or replace function app_private.towing_balance(a uuid) returns bigint language sql stable set search_path='' as $$select coalesce(sum(delta_cents),0)::bigint from public.motorist_towing_cash_movements where account_id=a$$;
create or replace function app_private.towing_reserved(a uuid,except_id uuid default null) returns bigint language sql stable set search_path='' as $$select coalesce(sum(amount_cents),0)::bigint from public.motorist_towing_cash_handovers where account_id=a and status='pending' and id is distinct from except_id$$;
create or replace function app_private.towing_account(o uuid,d uuid) returns public.motorist_towing_cash_accounts language plpgsql set search_path='' as $$declare a public.motorist_towing_cash_accounts;begin
 insert into public.motorist_towing_cash_accounts(organization_id,driver_id) values(o,d) on conflict do nothing;
 select * into a from public.motorist_towing_cash_accounts where organization_id=o and driver_id is not distinct from d for update;return a;end$$;
create or replace function app_private.towing_due(o uuid) returns bigint language sql stable set search_path='' as $$
 select coalesce((select i.amount_cents from public.motorist_towing_invoice_records i where i.order_id=o and not exists(select 1 from public.motorist_towing_invoice_records n where n.supersedes_id=i.id) order by i.created_at desc limit 1),(select approved_cents from public.motorist_towing_orders where id=o))
$$;
create or replace function app_private.towing_driver_fields(f jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce((select jsonb_object_agg(key,value) from jsonb_each(f) where key=any(array['serviceType','subjectType','subjectDescription','plate','vin','pickup','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','startSource','driverNotes','performedQuantity','photoException','parkingId','parkingName','parkingAddress'])),'{}'::jsonb)
 || jsonb_strip_nulls(jsonb_build_object('requester',case when jsonb_typeof(f->'requester')='object' then jsonb_build_object('name',f->'requester'->>'name','phone',f->'requester'->>'phone') end,'owner',case when jsonb_typeof(f->'owner')='object' then jsonb_build_object('name',f->'owner'->>'name','phone',f->'owner'->>'phone') end,'recipient',case when jsonb_typeof(f->'recipient')='object' then jsonb_build_object('name',f->'recipient'->>'name','phone',f->'recipient'->>'phone') end))
$$;
create or replace function app_private.towing_order_json(o public.motorist_towing_orders,driver_view boolean,m uuid) returns jsonb language plpgsql stable set search_path='' as $$
 declare j jsonb; received bigint;due bigint;begin
 select coalesce(sum(amount_cents),0) into received from public.motorist_towing_payments where order_id=o.id;due:=app_private.towing_due(o.id);
 j:=jsonb_build_object('id',o.id,'number',o.number,'sourceCaseId',case when driver_view then null else o.source_case_id end,'revision',o.revision,'assignmentGeneration',o.assignment_generation,'driverId',o.driver_id,'workStatus',o.work_status,'billingStatus',o.billing_status,'fields',case when driver_view then app_private.towing_driver_fields(o.fields) else o.fields end,'authorizedCollectionCents',o.authorized_collection_cents,'receivedCents',case when driver_view then (select coalesce(sum(amount_cents),0) from public.motorist_towing_payments where order_id=o.id and driver_id=m) else received end,'dueCents',case when driver_view then o.authorized_collection_cents else due end,'paymentStatus',case when due is null then 'unpriced' when received=0 and due>0 then 'unpaid' when received<due then 'partial' when received=due then 'paid' else 'overpaid' end,'reconciliationRequired',o.reconciliation_required,'createdAt',o.created_at,'updatedAt',o.updated_at,'attachments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'name',a.name,'mimeType',a.mime_type,'size',a.size,'status',a.status,'createdAt',a.created_at)) from public.motorist_towing_attachments a where a.order_id=o.id and a.status<>'abandoned' and (not driver_view or a.kind<>'scan')),'[]'::jsonb));
 if driver_view then j:=j||jsonb_build_object('payments',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'receiptId',p.receipt_id,'amountCents',p.amount_cents,'method',p.method,'driverId',p.driver_id,'createdAt',p.created_at,'reversalOf',p.reversal_of)) from public.motorist_towing_payments p where p.order_id=o.id and p.driver_id=m),'[]'::jsonb));end if;
 if not driver_view then j:=j||jsonb_build_object('officeNotes',o.office_notes,'lines',o.lines,
 'documents',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'version',d.version,'kind',d.kind,'status',d.status,'snapshot',d.snapshot,'snapshotHash',d.snapshot_hash,'createdAt',d.created_at)) from public.motorist_towing_document_versions d where d.order_id=o.id),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'receiptId',p.receipt_id,'amountCents',p.amount_cents,'method',p.method,'driverId',p.driver_id,'createdAt',p.created_at,'reversalOf',p.reversal_of)) from public.motorist_towing_payments p where p.order_id=o.id),'[]'::jsonb),
 'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'number',i.number,'date',i.invoice_date,'amountCents',i.amount_cents,'supersedesId',i.supersedes_id,'reason',i.reason)) from public.motorist_towing_invoice_records i where i.order_id=o.id),'[]'::jsonb),
 'reconciliations',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'receiptId',r.receipt_id,'status',r.status,'reason',r.reason,'evidence',r.evidence,'paymentId',r.payment_id,'resolvesId',r.resolves_id,'createdAt',r.created_at) order by r.created_at) from public.motorist_towing_reconciliations r where r.order_id=o.id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'actorId',e.actor_id,'createdAt',e.created_at,'payload',e.payload) order by e.created_at) from public.motorist_towing_events e where e.target_id=o.id),'[]'::jsonb));end if;return j;end$$;
create or replace function public.motorist_towing_workspace(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_view text,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships; d boolean; j jsonb; a public.motorist_towing_cash_accounts;begin
 p_filters:=p_filters||jsonb_strip_nulls(jsonb_build_object('query',coalesce(p_filters->>'query',p_filters->>'search'),'status',coalesce(p_filters->>'status',p_filters->>'workStatus'),'from',coalesce(p_filters->>'from',p_filters->>'dateFrom'),'to',coalesce(p_filters->>'to',p_filters->>'dateTo')));
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);d:=p_view='driver';
 if p_view not in ('driver','office') or (d and not 'drive'=any(m.capabilities)) or (not d and not m.capabilities&&array['operate','price','bill','report','members']) then raise exception 'Towing access denied' using errcode='42501';end if;
 if d then a:=app_private.towing_account(p_organization_id,m.id);else a:=app_private.towing_account(p_organization_id,null);end if;
 with filtered as (select o.* from public.motorist_towing_orders o where o.organization_id=p_organization_id
 and (not d or (o.driver_id=m.id and o.work_status in ('assigned','in_progress','needs_changes')))
 and (d or 'operate'=any(m.capabilities) or o.work_status in ('submitted','cancelled'))
 and (nullif(p_filters->>'orderId','') is null or o.id=(p_filters->>'orderId')::uuid)
 and (nullif(p_filters->>'billingStatus','') is null or o.billing_status=p_filters->>'billingStatus')
 and (nullif(p_filters->>'paymentStatus','') is null or app_private.towing_order_json(o,false,m.id)->>'paymentStatus'=p_filters->>'paymentStatus')
 and (nullif(p_filters->>'fleetAssetId','') is null or o.fields->>'fleetAssetId'=p_filters->>'fleetAssetId')
 and (nullif(p_filters->>'vehicle','') is null or (coalesce(o.fields->>'plate','')||' '||coalesce(o.fields->>'subjectDescription','')) ilike '%'||(p_filters->>'vehicle')||'%')
 and (nullif(p_filters->>'requester','') is null or coalesce(o.fields->'requester'->>'name','') ilike '%'||(p_filters->>'requester')||'%')
 and (nullif(p_filters->>'status','') is null or o.work_status=p_filters->>'status')
 and (nullif(p_filters->>'driverId','') is null or o.driver_id=(p_filters->>'driverId')::uuid)
 and (nullif(p_filters->>'branchId','') is null or o.fields->>'branchId'=p_filters->>'branchId')
 and (nullif(p_filters->>'sourceCaseId','') is null or o.source_case_id=(p_filters->>'sourceCaseId')::uuid)
 and (nullif(p_filters->>'query','') is null or (o.number||' '||o.fields::text) ilike '%'||(p_filters->>'query')||'%')
 and (nullif(p_filters->>'from','') is null or o.created_at>=(p_filters->>'from')::timestamptz)
 and (nullif(p_filters->>'to','') is null or o.created_at<(p_filters->>'to')::timestamptz)),
 paged as(select * from filtered order by case work_status when 'draft' then 0 when 'assigned' then 1 when 'in_progress' then 2 when 'needs_changes' then 3 else 4 end,updated_at desc limit least(greatest(coalesce((p_filters->>'limit')::int,50),1),100) offset greatest(coalesce((p_filters->>'offset')::int,0),0))
 select jsonb_build_object('orders',coalesce((select jsonb_agg(app_private.towing_order_json(p,d,m.id)) from paged p),'[]'::jsonb),'totalCount',(select count(*) from filtered),'summary',case when d then '{}'::jsonb else jsonb_build_object('approvedCents',(select coalesce(sum(approved_cents),0) from filtered),'invoicedCents',(select coalesce(sum(i.amount_cents),0) from public.motorist_towing_invoice_records i join filtered f on f.id=i.order_id where not exists(select 1 from public.motorist_towing_invoice_records newer where newer.supersedes_id=i.id)),'receivedCents',(select coalesce(sum(x.amount_cents),0) from public.motorist_towing_payments x join filtered f on f.id=x.order_id),'dueCents',(select coalesce(sum(app_private.towing_due(f.id)),0) from filtered f)) end) into j;
 return j||jsonb_build_object('actor',app_private.towing_member_json(m),'view',p_view,
 'members',case when d then '[]'::jsonb else coalesce((select jsonb_agg(app_private.towing_member_json(x)) from public.motorist_towing_memberships x where organization_id=p_organization_id),'[]'::jsonb) end,
 'branches',case when d then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name)) from public.motorist_branches where organization_id=p_organization_id and active),'[]'::jsonb) end,
 'fleet',case when d then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',label)) from public.motorist_fleet_assets where organization_id=p_organization_id),'[]'::jsonb) end,
 'cashAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'driverId',x.driver_id,'balanceCents',app_private.towing_balance(x.id),'reservedCents',app_private.towing_reserved(x.id),'revision',x.revision)) from public.motorist_towing_cash_accounts x where x.organization_id=p_organization_id and ((d and x.driver_id=m.id) or (not d and m.capabilities&&array['cash','correct','report']))),'[]'::jsonb),
 'handovers',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'driverId',h.driver_id,'amountCents',h.amount_cents,'status',h.status,'revision',h.revision,'reason',h.reason,'createdAt',h.created_at) order by h.created_at desc) from public.motorist_towing_cash_handovers h where h.organization_id=p_organization_id and ((d and h.driver_id=m.id) or (not d and m.capabilities&&array['cash','correct','report']))),'[]'::jsonb),
 'parking',case when d then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'address',x.address,'active',x.active,'revision',x.revision) order by x.name) from public.motorist_towing_parking_sites x where x.organization_id=p_organization_id),'[]'::jsonb) end,
 'partners',case when d then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by x.name) from public.motorist_contacts x where x.organization_id=p_organization_id and x.role in ('partner','assistance')),'[]'::jsonb) end,
 'taxConfigured',exists(select 1 from public.motorist_towing_tax_config where organization_id=p_organization_id),
 'taxRates',case when d then '[]'::jsonb else coalesce((select rates from public.motorist_towing_tax_config where organization_id=p_organization_id),'[]'::jsonb) end,'taxDate',current_date);
 end $$;

create or replace function public.motorist_towing_sources(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_query text default '',p_source_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships;begin
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'operate'=any(m.capabilities) or not exists(select 1 from public.motorist_profiles p where p.user_id=p_user_id and p.organization_id=p_organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin') and coalesce(to_jsonb(p)->>'access_status','active')<>'disabled') then raise exception 'Towing access denied' using errcode='42501';end if;
 return jsonb_build_object('sources',coalesce((select jsonb_agg(x) from (
 select c.id,c.case_number as number,jsonb_strip_nulls(jsonb_build_object('serviceType','tow','subjectType','vehicle',
 'subjectDescription',coalesce(nullif(concat_ws(' ',v.make,v.model),''),c.summary,''),'plate',v.license_plate,'vin',v.vin,
 'contact',nullif(concat_ws(' ',ct.name,ct.phone),''),'pickup',coalesce(lp.address,to_jsonb(c)->'location_details'->>'pickupAddress',''),
 'destination',coalesce(ld.address,to_jsonb(c)->'location_details'->>'destinationAddress',''),
 'requester',case when ct.id is not null then jsonb_strip_nulls(jsonb_build_object('name',ct.name,'phone',ct.phone,'email',ct.email)) else null end,
 'assistanceReference',c.assistance_reference)) as fields
 from public.motorist_cases c left join public.motorist_contacts ct on ct.id=c.contact_id and ct.organization_id=p_organization_id
 left join public.motorist_vehicles v on v.id=c.vehicle_id and v.organization_id=p_organization_id
 left join public.motorist_locations lp on lp.id=c.pickup_location_id and lp.organization_id=p_organization_id
 left join public.motorist_locations ld on ld.id=c.destination_location_id and ld.organization_id=p_organization_id
 where c.organization_id=p_organization_id and (p_source_id is null or c.id=p_source_id)
 and (coalesce(p_query,'')='' or c.case_number ilike '%'||p_query||'%' or v.license_plate ilike '%'||p_query||'%') order by c.updated_at desc limit 20
 ) x),'[]'::jsonb));end$$;


create or replace function app_private.towing_assert_complete(o public.motorist_towing_orders) returns void language plpgsql set search_path='' as $$begin
 if o.fields->>'serviceType'='storage' and (nullif(o.fields->>'parkingId','') is null or not exists(select 1 from public.motorist_towing_parking_sites where id=(o.fields->>'parkingId')::uuid and organization_id=o.organization_id)) then raise exception 'Storage requires an identified parking site' using errcode='22023';end if;
 if nullif(btrim(o.fields->>'pickup'),'') is null or nullif(o.fields->>'branchId','') is null or (nullif(btrim(o.fields->>'contact'),'') is null and nullif(btrim(o.fields->>'noContactReason'),'') is null) then raise exception 'Completion incomplete' using errcode='22023';end if;
 if nullif(o.fields->>'subjectDescription','') is null or nullif(o.fields->>'startedAt','') is null or nullif(o.fields->>'finishedAt','') is null or (o.fields->>'finishedAt')::timestamptz<(o.fields->>'startedAt')::timestamptz or (o.fields->>'serviceType' in ('tow','transport','relocation') and nullif(o.fields->>'destination','') is null) then raise exception 'Completion incomplete' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_attachments where order_id=o.id and status='pending') then raise exception 'Uploads pending' using errcode='22023';end if;
 if nullif(btrim(o.fields->>'photoException'),'') is null and (not exists(select 1 from public.motorist_towing_attachments where order_id=o.id and status='ready' and kind='work' and mime_type like 'image/%') or (o.fields->>'serviceType' in ('tow','transport','relocation') and not exists(select 1 from public.motorist_towing_attachments where order_id=o.id and status='ready' and kind='handover' and mime_type like 'image/%'))) then raise exception 'Photographs required' using errcode='22023';end if;
end$$;
create or replace function public.motorist_towing_command(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$

 #variable_conflict use_variable
 declare m public.motorist_towing_memberships; o public.motorist_towing_orders; old public.motorist_towing_commands; p jsonb:=p_command->'payload';
 action text:=p_command->>'type'; target uuid:=(p_command->>'targetId')::uuid; cid uuid:=(p_command->>'commandId')::uuid;
 fp text:=encode(sha256(convert_to(p_command::text,'UTF8')),'hex'); cap text; driver_op boolean:=false; result jsonb:='{}'; n bigint; total bigint; net bigint; tax bigint; l jsonb; lines jsonb:='[]'; f jsonb; required_revision boolean;
 driver uuid; a public.motorist_towing_cash_accounts; office public.motorist_towing_cash_accounts; h public.motorist_towing_cash_handovers;
 pay public.motorist_towing_payments; existing public.motorist_towing_payments; payment_uuid uuid; dr bigint; off bigint; delta bigint;
 member public.motorist_towing_memberships; doc public.motorist_towing_document_versions; taxconfig public.motorist_towing_tax_config; inv public.motorist_towing_invoice_records;
 begin
 -- One organization lock orders all financial/assignment/command mutations. This is
 -- deliberately simple at current dispatch volume; reads do not expose dirty writes.
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if cid is null or target is null or jsonb_typeof(p)<>'object' then raise exception 'Invalid command' using errcode='22023';end if;
 if exists(select 1 from jsonb_each_text(p) x where x.key in ('amountCents','authorizedCollectionCents','driverReductionCents','officeReductionCents') and (x.value !~ '^[0-9]{1,16}$' or x.value::numeric>9007199254740991)) then raise exception 'Invalid exact cents' using errcode='22023';end if;
 cap:=case action when 'create_order' then 'operate' when 'refresh_source' then 'operate' when 'assign' then 'operate' when 'return' then 'operate' when 'cancel' then 'operate'
 when 'set_lines' then 'price' when 'approve_price' then 'price' when 'set_invoice' then 'bill' when 'not_required' then 'bill'
 when 'accept_handover' then 'cash' when 'reject_handover' then 'cash' when 'cancel_handover' then 'correct'
 when 'correct_payment' then 'correct' when 'refund_payment' then 'correct' when 'reconcile_receipt' then 'correct'
 when 'set_member' then 'members' when 'set_tax_config' then 'members' when 'set_parking' then 'members'
 when 'issue_document' then 'documents' when 'document_result' then 'documents' when 'email_intent' then 'documents' when 'email_result' then 'documents'
 when 'propose_handover' then 'drive'
 when 'receive_payment' then case when p_command?'assignmentGeneration' then 'drive' when 'bill'=any(m.capabilities) then 'bill' else 'drive' end
 when 'update_order' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'start' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'submit' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'attachment_intent' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'abandon_attachment' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'attachment_finalize' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end else null end;
 if cap is null or not cap=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501';end if;
 driver_op:=cap='drive' and action<>'propose_handover';
 select * into o from public.motorist_towing_orders where id=target and organization_id=p_organization_id for update;
 if o.id is not null and not driver_op and not 'operate'=any(m.capabilities) and o.work_status not in ('submitted','cancelled') then raise exception 'Towing access denied' using errcode='42501';end if;
 if driver_op and (o.id is null or o.driver_id is distinct from m.id or o.assignment_generation is distinct from (p_command->>'assignmentGeneration')::bigint) then raise exception 'Towing access denied' using errcode='42501';end if;
 -- Reauthorization precedes replay, including original assignment generation. An
 -- acknowledged submit may replay after leaving driver list, but never after reassignment.
 select * into old from public.motorist_towing_commands where organization_id=p_organization_id and command_id=cid;
 if found then
 if not old.required_capability=any(m.capabilities) or (old.assignment_generation is not null and (o.driver_id is distinct from m.id or o.assignment_generation is distinct from old.assignment_generation)) then raise exception 'Towing access denied' using errcode='42501';end if;
 if old.actor_id<>m.id or old.action<>action or old.target_id<>target or old.fingerprint<>fp then raise exception 'Command identity conflict' using errcode='PT409';end if;
 if action='email_intent' then
 select jsonb_build_object('delivery',jsonb_build_object('id',e.id,'documentId',e.document_id,'recipient',e.recipient,'status',e.status,'providerMessageId',e.provider_message_id,'attemptStartedAt',e.created_at),'shouldSend',false) into result from public.motorist_towing_email_deliveries e where e.id=(p->>'id')::uuid and e.organization_id=p_organization_id;
 return jsonb_set(old.result,'{result}',result);end if;
 return old.result;end if;
 if driver_op and o.work_status not in ('assigned','in_progress','needs_changes') then raise exception 'Towing access denied' using errcode='42501';end if;
 required_revision:=action in ('update_order','refresh_source','assign','start','submit','return','cancel','set_lines','approve_price','set_invoice','not_required','issue_document');
 if required_revision and (o.id is null or o.revision is distinct from (p_command->>'expectedRevision')::bigint) then raise exception 'Order revision conflict' using errcode='PT409';end if;
 if action not in ('create_order','set_member','set_tax_config','set_parking','propose_handover','accept_handover','reject_handover','cancel_handover') and o.id is null then raise exception 'Not found' using errcode='P0002';end if;
 if action='refresh_source' then
 if o.source_case_id is null then raise exception 'No linked source' using errcode='22023';end if;
 f:=public.motorist_towing_sources(p_user_id,p_organization_id,p_membership_version,'',o.source_case_id)->'sources'->0->'fields';
 if f is null then raise exception 'Source unavailable' using errcode='P0002';end if;
 update public.motorist_towing_orders set fields=fields||f,source_snapshot=f,source_copied_at=now(),approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;
 elsif action in ('create_order','update_order') then
 f:=coalesce(p->'fields','{}'::jsonb);
 if jsonb_typeof(f)<>'object' then raise exception 'Invalid fields' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(f) x where x.key not in ('requester','owner','customer','recipient') and ((jsonb_typeof(x.value) not in ('string','null')) or (jsonb_typeof(x.value)='null' and x.key in ('serviceType','subjectType','subjectDescription','pickup')) or length(x.value#>>'{}')>10000)) then raise exception 'Fields must be bounded text' using errcode='22023';end if;
 for l in select x.value from jsonb_each(f) x where x.key in ('requester','owner','customer','recipient') and jsonb_typeof(x.value)<>'null' loop
 if jsonb_typeof(l)<>'object' or (l-array['name','phone','email','address','companyId','taxId'])<>'{}'::jsonb or coalesce(jsonb_typeof(l->'name'),'null')<>'string' or exists(select 1 from jsonb_each(l) x where jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>2000) then raise exception 'Invalid party fields' using errcode='22023';end if;
 end loop;

 if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;
 if driver_op and (p-array['fields'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;
 if not driver_op and (f-array['serviceType','subjectType','subjectDescription','plate','vin','pickup','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','startSource','driverNotes','performedQuantity','photoException','requester','owner','customer','recipient','assistanceReference','assistancePartnerId','assistancePartnerName','parkingId','parkingName','parkingAddress'])<>'{}'::jsonb then raise exception 'Unknown fields' using errcode='22023';end if;
 f:=case when action='create_order' then jsonb_build_object('serviceType','tow','subjectType','vehicle','subjectDescription','','pickup','')||f else o.fields||f end;
 f:=jsonb_strip_nulls(f);
 if (f?'startedAt' and nullif(f->>'startedAt','') is not null) then perform (f->>'startedAt')::timestamptz;end if;
 if (f?'finishedAt' and nullif(f->>'finishedAt','') is not null) then perform (f->>'finishedAt')::timestamptz;end if;
 if nullif(f->>'startedAt','') is not null and nullif(f->>'finishedAt','') is not null and (f->>'finishedAt')::timestamptz<(f->>'startedAt')::timestamptz then raise exception 'End precedes start' using errcode='22023';end if;
 if p->'fields'?'startedAt' then f:=f||jsonb_build_object('startSource','manual');end if;

 if coalesce(f->>'serviceType','') not in ('tow','repair','transport','storage','relocation') or coalesce(f->>'subjectType','') not in ('vehicle','machine','material') then raise exception 'Invalid service' using errcode='22023';end if;
 if nullif(f->>'branchId','') is not null and not exists(select 1 from public.motorist_branches where id=(f->>'branchId')::uuid and organization_id=p_organization_id and active) then raise exception 'Invalid branch' using errcode='22023';end if;
 if nullif(f->>'fleetAssetId','') is not null and not exists(select 1 from public.motorist_fleet_assets where id=(f->>'fleetAssetId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid fleet' using errcode='22023';end if;
 if nullif(f->>'parkingId','') is not null then
 if not exists(select 1 from public.motorist_towing_parking_sites where id=(f->>'parkingId')::uuid and organization_id=p_organization_id and (active or o.fields->>'parkingId'=f->>'parkingId')) then raise exception 'Invalid parking site' using errcode='22023';end if;
 if (p->'fields'?'parkingId') or action='create_order' then select f||jsonb_build_object('parkingName',name,'parkingAddress',address) into f from public.motorist_towing_parking_sites where id=(f->>'parkingId')::uuid and organization_id=p_organization_id;end if;
 else f:=f-array['parkingName','parkingAddress'];end if;
 if nullif(f->>'assistancePartnerId','') is not null then
 if not exists(select 1 from public.motorist_contacts where id=(f->>'assistancePartnerId')::uuid and organization_id=p_organization_id and role in ('assistance','partner')) then raise exception 'Invalid assistance partner' using errcode='22023';end if;
 select f||jsonb_build_object('assistancePartnerName',name) into f from public.motorist_contacts where id=(f->>'assistancePartnerId')::uuid and organization_id=p_organization_id;
 else f:=f-'assistancePartnerName';end if;
 if action='create_order' then
 if p->>'sourceCaseId' is not null and not exists(select 1 from public.motorist_cases where id=(p->>'sourceCaseId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid source' using errcode='22023';end if;
 if p->>'sourceCaseId' is not null then
 result:=public.motorist_towing_sources(p_user_id,p_organization_id,p_membership_version,'',(p->>'sourceCaseId')::uuid)->'sources'->0->'fields';
 if result is null then raise exception 'Source unavailable' using errcode='P0002';end if;
 f:=f||result||coalesce(p->'fields','{}'::jsonb);
 end if;
 insert into public.motorist_towing_orders(id,organization_id,source_case_id,source_snapshot,source_copied_at,fields,office_notes,authorized_collection_cents) values(target,p_organization_id,(p->>'sourceCaseId')::uuid,case when p->>'sourceCaseId' is not null then result else null end,case when p->>'sourceCaseId' is not null then now() else null end,f,coalesce(p->>'officeNotes',''),(p->>'authorizedCollectionCents')::bigint);
 else
 if o.work_status='cancelled' then raise exception 'Cancelled order' using errcode='22023';end if;
 update public.motorist_towing_orders set fields=f,office_notes=case when p?'officeNotes' then p->>'officeNotes' else office_notes end,authorized_collection_cents=case when p?'authorizedCollectionCents' then (p->>'authorizedCollectionCents')::bigint else authorized_collection_cents end,
 approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;end if;
 elsif action='assign' then
 if o.work_status='cancelled' or nullif(o.fields->>'pickup','') is null or nullif(o.fields->>'branchId','') is null or (nullif(o.fields->>'contact','') is null and nullif(o.fields->>'noContactReason','') is null) then raise exception 'Assignment incomplete' using errcode='22023';end if;
 select * into member from public.motorist_towing_memberships where id=(p->>'driverId')::uuid and organization_id=p_organization_id for share;
 if not found or not member.active or not 'drive'=any(member.capabilities) then raise exception 'Invalid driver' using errcode='22023';end if;
 perform app_private.towing_authorize(member.auth_user_id,p_organization_id,member.membership_version);
 update public.motorist_towing_assignments set ended_at=now() where order_id=target and ended_at is null;
 insert into public.motorist_towing_assignments(organization_id,order_id,driver_id,generation) values(p_organization_id,target,member.id,o.assignment_generation+1);
 update public.motorist_towing_orders set driver_id=member.id,assignment_generation=assignment_generation+1,work_status='assigned',revision=revision+1,updated_at=now(),approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',fields=fields||jsonb_build_object('startedAt',coalesce(fields->>'startedAt',now()::text),'startSource',coalesce(fields->>'startSource','assignment')) where id=target;
 elsif action='start' then
 if o.work_status not in ('assigned','needs_changes') then raise exception 'Invalid transition' using errcode='22023';end if;
 update public.motorist_towing_orders set work_status='in_progress',revision=revision+1,updated_at=now() where id=target;
 elsif action='submit' then
 if o.work_status not in ('assigned','in_progress','needs_changes') then raise exception 'Invalid transition' using errcode='22023';end if;
 perform app_private.towing_assert_complete(o);
 if exists(select 1 from jsonb_array_elements_text(coalesce(p->'receiptIds','[]')) r where not exists(select 1 from public.motorist_towing_payments x where x.organization_id=p_organization_id and x.order_id=target and x.receipt_id=r::uuid)) then raise exception 'Receipt confirmation required' using errcode='22023';end if;
 update public.motorist_towing_orders set work_status='submitted',revision=revision+1,updated_at=now() where id=target;
 elsif action in ('return','cancel','not_required') then
 if nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 if action='return' and (o.work_status<>'submitted' or o.driver_id is null) then raise exception 'Invalid return' using errcode='22023';end if;
 if action='cancel' then update public.motorist_towing_assignments set ended_at=now() where order_id=target and ended_at is null;end if;
 update public.motorist_towing_orders set work_status=case action when 'return' then 'needs_changes' when 'cancel' then 'cancelled' else work_status end,
 billing_status=case when billing_status='invoiced' then billing_status when action='not_required' then 'not_required' else 'not_ready' end,
 approved_cents=case when action='not_required' then approved_cents else null end,
 reconciliation_required=reconciliation_required or billing_status='invoiced' or (action='cancel' and exists(select 1 from public.motorist_towing_payments where order_id=target)),revision=revision+1,updated_at=now() where id=target;
 elsif action='set_lines' then
 if coalesce(jsonb_typeof(p->'lines'),'null')<>'array' or jsonb_array_length(p->'lines')>200 then raise exception 'Invalid lines' using errcode='22023';end if;
 for l in select * from jsonb_array_elements(p->'lines') loop
 if (l->>'id') is null or nullif(l->>'unit','') is null or nullif(btrim(l->>'description'),'') is null or l->>'quantity' is null or l->>'unitPrice' is null or l->>'taxRate' is null or (l->>'quantity') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' or (l->>'unitPrice') !~ '^[0-9]{1,9}(\.[0-9]{1,4})?$' or (l->>'taxRate') !~ '^[0-9]{1,3}(\.[0-9]{1,4})?$' or (l->>'quantity')::numeric<=0 or (l->>'taxRate')::numeric>100 then raise exception 'Invalid line' using errcode='22023';end if;
 net:=round((l->>'quantity')::numeric*(l->>'unitPrice')::numeric*100);tax:=round(net*(l->>'taxRate')::numeric/100);
 if net+tax>9007199254740991 then raise exception 'Amount limit' using errcode='22023';end if;
 lines:=lines||jsonb_build_array((l-array['netCents','taxCents','totalCents'])||jsonb_build_object('netCents',net,'taxCents',tax,'totalCents',net+tax));end loop;
 update public.motorist_towing_orders set lines=lines,tax_date=(p->>'taxDate')::date,approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;
 elsif action='approve_price' then
 perform app_private.towing_assert_complete(o);
 select * into taxconfig from public.motorist_towing_tax_config where organization_id=p_organization_id;
 if o.work_status<>'submitted' or jsonb_array_length(o.lines)=0 or taxconfig.organization_id is null or o.tax_date is null or o.tax_date<taxconfig.valid_from or (taxconfig.valid_until is not null and o.tax_date>taxconfig.valid_until) or exists(select 1 from jsonb_array_elements(o.lines) x where not exists(select 1 from jsonb_array_elements_text(taxconfig.rates) r where r::numeric=(x->>'taxRate')::numeric)) then raise exception 'Price configuration or review incomplete' using errcode='22023';end if;
 select sum((x->>'totalCents')::bigint) into total from jsonb_array_elements(o.lines) x;
 if total>9007199254740991 then raise exception 'Price total limit' using errcode='22023';end if;
 update public.motorist_towing_orders set approved_cents=total,billing_status=case when billing_status='invoiced' then billing_status else 'ready' end,revision=revision+1,updated_at=now() where id=target;
 elsif action='set_invoice' then
 if o.work_status<>'submitted' or o.approved_cents is null or nullif(p->>'number','') is null or (p->>'amountCents')::bigint<>o.approved_cents then raise exception 'Invoice needs approved matching price' using errcode='22023';end if;
 select * into inv from public.motorist_towing_invoice_records i where i.order_id=target and not exists(select 1 from public.motorist_towing_invoice_records x where x.supersedes_id=i.id);
 if inv.id is not null and ((p->>'supersedesId')::uuid is distinct from inv.id or nullif(p->>'reason','') is null) then raise exception 'Explicit replacement invoice required' using errcode='22023';end if;
 if inv.id is null and p->>'supersedesId' is not null then raise exception 'Invalid predecessor' using errcode='22023';end if;
 insert into public.motorist_towing_invoice_records(id,organization_id,order_id,number,invoice_date,amount_cents,supersedes_id,reason) values((p->>'id')::uuid,p_organization_id,target,p->>'number',(p->>'date')::date,(p->>'amountCents')::bigint,inv.id,p->>'reason');
 update public.motorist_towing_orders set billing_status='invoiced',reconciliation_required=exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations resolved where resolved.resolves_id=r.id)),revision=revision+1,updated_at=now() where id=target;
 elsif action in ('receive_payment','reconcile_receipt') then
 n:=(p->>'amountCents')::bigint;driver:=case when driver_op then m.id else (p->>'driverId')::uuid end;
 if action='reconcile_receipt' and (nullif(p->>'receiptId','') is null or nullif(p->>'evidence','') is null) then
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence) values(p_organization_id,target,m.id,'open',coalesce(nullif(p->>'reason',''),'Unresolved receipt identity'),p->>'evidence');
 update public.motorist_towing_orders set reconciliation_required=true where id=target;result:=jsonb_build_object('reconciliationStatus','open');
 else
 if n is null or n<=0 or n>9007199254740991 or (action='receive_payment' and coalesce(p->>'method','') not in ('cash','card','bank','other')) or (driver_op and p->>'method'<>'cash') then raise exception 'Invalid payment' using errcode='22023';end if;
 if action='reconcile_receipt' and (driver is null or nullif(p->>'reason','') is null or not exists(select 1 from public.motorist_towing_assignments where organization_id=p_organization_id and order_id=target and driver_id=driver and generation=(p->>'assignmentGeneration')::bigint)) then raise exception 'Receipt provenance required' using errcode='22023';end if;
 select * into existing from public.motorist_towing_payments where organization_id=p_organization_id and receipt_id=(p->>'receiptId')::uuid;
 if existing.id is not null then
 if existing.order_id<>target or existing.amount_cents<>n or existing.driver_id is distinct from driver or existing.method<>(case when action='reconcile_receipt' then 'cash' else p->>'method' end) then raise exception 'Receipt identity conflict' using errcode='PT409';end if;
 payment_uuid:=existing.id;
 else
 if (p->>'method'='cash' or action='reconcile_receipt') and driver is null then raise exception 'Cash custodian required' using errcode='22023';end if;
 if driver is not null and not exists(select 1 from public.motorist_towing_memberships where id=driver and organization_id=p_organization_id) then raise exception 'Invalid custodian' using errcode='22023';end if;
 if p->>'method'='cash' or action='reconcile_receipt' then
 a:=app_private.towing_account(p_organization_id,driver);
 if action='receive_payment' and a.revision is distinct from (p->>'accountRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;end if;
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,captured_at,reason,evidence) values(p_organization_id,target,(p->>'receiptId')::uuid,n,case when action='reconcile_receipt' then 'cash' else p->>'method' end,driver,m.id,coalesce((p->>'capturedAt')::timestamptz,now()),p->>'reason',p->>'evidence') returning id into payment_uuid;
 if p->>'method'='cash' or action='reconcile_receipt' then
 if app_private.towing_balance(a.id)+n>9007199254740991 then raise exception 'Cash account limit' using errcode='22023';end if;
 insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,a.id,n,payment_uuid,cid);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;end if;end if;
 if action='reconcile_receipt' then
 if p->>'reconciliationId' is not null and not exists(select 1 from public.motorist_towing_reconciliations where id=(p->>'reconciliationId')::uuid and organization_id=p_organization_id and order_id=target and status='open') then raise exception 'Invalid reconciliation' using errcode='22023';end if;
 insert into public.motorist_towing_reconciliations(organization_id,order_id,receipt_id,actor_id,status,reason,evidence,payment_id,resolves_id) values(p_organization_id,target,(p->>'receiptId')::uuid,m.id,'resolved',p->>'reason',p->>'evidence',payment_uuid,(p->>'reconciliationId')::uuid);
 update public.motorist_towing_orders set reconciliation_required=(work_status='cancelled') or (billing_status='invoiced' and approved_cents is distinct from app_private.towing_due(target)) or exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id)) where id=target;
 end if;
 if o.work_status='cancelled' then update public.motorist_towing_orders set reconciliation_required=true where id=target;end if;
 result:=jsonb_build_object('paymentId',payment_uuid,'receiptId',p->>'receiptId','reconciliationStatus',case when action='reconcile_receipt' then 'resolved' else null end);
 end if;
 elsif action='propose_handover' then
 a:=app_private.towing_account(p_organization_id,m.id);n:=(p->>'amountCents')::bigint;
 if a.revision is distinct from (p->>'accountRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if n is null or n<=0 or n>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id) then raise exception 'Insufficient available cash' using errcode='22023';end if;
 insert into public.motorist_towing_cash_handovers(id,organization_id,driver_id,account_id,amount_cents) values(target,p_organization_id,m.id,a.id,n);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;result:=jsonb_build_object('handoverId',target);
 elsif action in ('accept_handover','reject_handover','cancel_handover') then
 select * into h from public.motorist_towing_cash_handovers where id=target and organization_id=p_organization_id for update;
 if not found then raise exception 'Not found' using errcode='P0002';end if;
 if h.status<>'pending' or h.revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Handover revision conflict' using errcode='PT409';end if;
 a:=app_private.towing_account(p_organization_id,h.driver_id);
 if action='accept_handover' then
 office:=app_private.towing_account(p_organization_id,null);
 if a.revision is distinct from (p->>'accountRevision')::bigint or office.revision is distinct from (p->>'officeRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if app_private.towing_balance(office.id)+h.amount_cents>9007199254740991 then raise exception 'Cash account limit' using errcode='22023';end if;
 if h.amount_cents>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id,h.id) then raise exception 'Insufficient available cash' using errcode='22023';end if;
 insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,handover_id,command_id) values(p_organization_id,a.id,-h.amount_cents,h.id,cid),(p_organization_id,office.id,h.amount_cents,h.id,cid);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=office.id;
 elsif nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;
 update public.motorist_towing_cash_handovers set status=case action when 'accept_handover' then 'accepted' when 'reject_handover' then 'rejected' else 'cancelled' end,revision=revision+1,reason=p->>'reason' where id=target;
 result:=jsonb_build_object('handoverId',target);
 elsif action in ('correct_payment','refund_payment') then
 select * into pay from public.motorist_towing_payments where id=(p->>'paymentId')::uuid and organization_id=p_organization_id and order_id=target;
 n:=(p->>'amountCents')::bigint;
 if pay.id is null or pay.amount_cents<=0 or pay.reversal_of is not null or n is null or n<0 or (action='refund_payment' and n=0) or nullif(btrim(p->>'reason'),'') is null then raise exception 'Invalid financial correction' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_payments where reversal_of=pay.id) or (action='correct_payment' and exists(select 1 from public.motorist_towing_payments where refund_of=pay.id)) then raise exception 'Already corrected' using errcode='PT409';end if;
 delta:=case when action='correct_payment' then pay.amount_cents-n else n end;
 dr:=coalesce((p->>'driverReductionCents')::bigint,0);off:=coalesce((p->>'officeReductionCents')::bigint,0);
 if nullif(btrim(p->>'evidence'),'') is null or (pay.method='cash' and (delta<0 or dr<0 or off<0 or dr+off<>delta)) then
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence,payment_id) values(p_organization_id,target,m.id,'open',p->>'reason',p->>'evidence',pay.id);
 update public.motorist_towing_orders set reconciliation_required=true where id=target;
 result:=jsonb_build_object('reconciliationStatus','open','reason','Verified custody allocation required');
 else
 if action='refund_payment' and n>pay.amount_cents+(select coalesce(sum(amount_cents),0) from public.motorist_towing_payments where refund_of=pay.id) then raise exception 'Refund exceeds receipt' using errcode='22023';end if;
 if pay.method='cash' then
 a:=app_private.towing_account(p_organization_id,pay.driver_id);office:=app_private.towing_account(p_organization_id,null);
 if a.revision is distinct from (p->>'driverRevision')::bigint or office.revision is distinct from (p->>'officeRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if dr>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id) or off>app_private.towing_balance(office.id)-app_private.towing_reserved(office.id) then raise exception 'Custody allocation unavailable' using errcode='PT409';end if;end if;
 -- Full reverse+replacement preserves the original receipt. Custody entries record
 -- only the evidenced net correction; they never invent transfers between holders.
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reversal_of,refund_of,reason,evidence) values(p_organization_id,target,case when action='refund_payment' then (p->>'receiptId')::uuid else gen_random_uuid() end,case when action='correct_payment' then -pay.amount_cents else -n end,pay.method,pay.driver_id,m.id,case when action='correct_payment' then pay.id else null end,case when action='refund_payment' then pay.id else null end,p->>'reason',p->>'evidence') returning id into payment_uuid;
 if action='correct_payment' and n>0 then
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reason,evidence) values(p_organization_id,target,(p->>'replacementReceiptId')::uuid,n,pay.method,pay.driver_id,m.id,p->>'reason',p->>'evidence');end if;
 if pay.method='cash' then
 if dr>0 then insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,a.id,-dr,payment_uuid,cid);end if;
 if off>0 then insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,office.id,-off,payment_uuid,cid);end if;
 update public.motorist_towing_cash_accounts set revision=revision+1 where id in (a.id,office.id);end if;
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence,payment_id,resolves_id)
 select p_organization_id,target,m.id,'resolved',p->>'reason',p->>'evidence',payment_uuid,r.id from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and r.payment_id=pay.id and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id);
 update public.motorist_towing_orders set reconciliation_required=(work_status='cancelled' and exists(select 1 from public.motorist_towing_payments where order_id=target having sum(amount_cents)<>0)) or (billing_status='invoiced' and approved_cents is distinct from app_private.towing_due(target)) or exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id)) where id=target;
 result:=jsonb_build_object('paymentId',payment_uuid,'reconciliationStatus','resolved');end if;
 elsif action='attachment_intent' then
 if (select count(*) from public.motorist_towing_attachments where order_id=target and status<>'abandoned')>=50 then raise exception 'Attachment limit' using errcode='22023';end if;
 if driver_op and p->>'kind'='scan' then raise exception 'Towing access denied' using errcode='42501';end if;
 insert into public.motorist_towing_attachments(id,organization_id,order_id,actor_id,assignment_generation,kind,name,mime_type,size,path) values((p->>'id')::uuid,p_organization_id,target,m.id,o.assignment_generation,p->>'kind',p->>'name',p->>'mimeType',(p->>'size')::bigint,p_organization_id::text||'/'||target::text||'/'||(p->>'id'));
 select jsonb_build_object('attachment',jsonb_build_object('id',id,'orderId',order_id,'kind',kind,'name',name,'mimeType',mime_type,'size',size,'status',status,'path',path,'createdAt',created_at)) into result from public.motorist_towing_attachments where id=(p->>'id')::uuid;
 elsif action='abandon_attachment' then
 if nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 update public.motorist_towing_attachments set status='abandoned' where id=(p->>'id')::uuid and organization_id=p_organization_id and order_id=target and status='pending' and (not driver_op or (actor_id=m.id and assignment_generation=o.assignment_generation));
 if not found then raise exception 'Attachment unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('attachmentId',p->>'id','status','abandoned');
 elsif action='attachment_finalize' then
 if coalesce(p->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid attachment hash' using errcode='22023';end if;
 update public.motorist_towing_attachments set status='ready',sha256=p->>'sha256' where id=(p->>'id')::uuid and order_id=target and organization_id=p_organization_id and status='pending' and (not driver_op or (actor_id=m.id and assignment_generation=o.assignment_generation));
 if not found then raise exception 'Attachment unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('attachmentId',p->>'id');
 elsif action='issue_document' then
 if coalesce(p->>'kind','') not in ('work','priced') or (p->>'kind'='priced' and (o.approved_cents is null or o.billing_status not in ('ready','invoiced') or o.reconciliation_required)) then raise exception 'Document not ready' using errcode='22023';end if;
 f:=jsonb_build_object('number',o.number,'fields',o.fields,'kind',p->>'kind','createdAt',now(),'orderRevision',o.revision,'taxDate',o.tax_date,'rounding','line-half-up','lines',case when p->>'kind'='priced' then o.lines else '[]'::jsonb end,'totalCents',case when p->>'kind'='priced' then o.approved_cents else null end);
 select coalesce(max(version),0)+1 into n from public.motorist_towing_document_versions where order_id=target;
 insert into public.motorist_towing_document_versions(id,organization_id,order_id,version,kind,snapshot,snapshot_hash,path) values((p->>'id')::uuid,p_organization_id,target,n,p->>'kind',f,encode(sha256(convert_to(f::text,'UTF8')),'hex'),p_organization_id::text||'/'||target::text||'/'||(p->>'id')||'.pdf') returning * into doc;
 result:=jsonb_build_object('document',jsonb_build_object('id',doc.id,'orderId',doc.order_id,'version',doc.version,'kind',doc.kind,'snapshot',doc.snapshot,'snapshotHash',doc.snapshot_hash,'status',doc.status,'path',doc.path,'createdAt',doc.created_at));
 elsif action='document_result' then
 if coalesce(p->>'status','') not in ('ready','failed') or (p->>'status'='ready' and coalesce(p->>'sha256','') !~ '^[a-f0-9]{64}$') then raise exception 'Invalid render result' using errcode='22023';end if;
 update public.motorist_towing_document_versions set status=p->>'status',sha256=p->>'sha256',error=left(p->>'error',250) where id=(p->>'id')::uuid and order_id=target and organization_id=p_organization_id and status<>'ready';
 if not found then raise exception 'Document unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('documentId',p->>'id');
 elsif action='email_intent' then
 select * into doc from public.motorist_towing_document_versions where id=(p->>'documentId')::uuid and order_id=target and organization_id=p_organization_id and status='ready';
 if doc.id is null or coalesce((p->>'confirmed')::boolean,false)=false or coalesce(p->>'recipient','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Confirmed recipient and document required' using errcode='22023';end if;
 insert into public.motorist_towing_email_deliveries(id,organization_id,document_id,recipient) values((p->>'id')::uuid,p_organization_id,doc.id,p->>'recipient');
 result:=jsonb_build_object('delivery',jsonb_build_object('id',p->>'id','documentId',doc.id,'recipient',p->>'recipient','status','pending','attemptStartedAt',now()),'shouldSend',true);
 elsif action='email_result' then
 update public.motorist_towing_email_deliveries e set status=p->>'status',provider_message_id=p->>'providerMessageId' where e.id=(p->>'id')::uuid and e.organization_id=p_organization_id and e.status='pending' and exists(select 1 from public.motorist_towing_document_versions d where d.id=e.document_id and d.order_id=target);
 if not found then raise exception 'Delivery unavailable' using errcode='P0002';end if;result:=jsonb_build_object('deliveryId',p->>'id','status',p->>'status','providerMessageId',p->>'providerMessageId');
 elsif action='set_member' then
 if exists(select 1 from public.motorist_towing_memberships where id=target and organization_id<>p_organization_id) then raise exception 'Towing access denied' using errcode='42501';end if;
 if nullif(btrim(p->>'email'),'') is null or not exists(select 1 from auth.users where id=(p->>'userId')::uuid and lower(email)=lower(btrim(p->>'email'))) then raise exception 'Membership email must match verified auth identity' using errcode='22023';end if;
 select * into member from public.motorist_towing_memberships where id=target and organization_id=p_organization_id for update;
 if member.id is not null and member.membership_version is distinct from (p->>'expectedVersion')::bigint then raise exception 'Member revision conflict' using errcode='PT409';end if;
 if member.id is not null and member.auth_user_id<>(p->>'userId')::uuid then raise exception 'Identity immutable' using errcode='22023';end if;
 if coalesce(jsonb_typeof(p->'roles'),'null')<>'array' or jsonb_array_length(p->'roles')=0 or nullif(btrim(p->>'displayName'),'') is null then raise exception 'Invalid member' using errcode='22023';end if;
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,email,roles,capabilities,active,office_profile_id) values(target,p_organization_id,(p->>'userId')::uuid,p->>'displayName',lower(btrim(p->>'email')),array(select jsonb_array_elements_text(p->'roles')),app_private.towing_capabilities(array(select jsonb_array_elements_text(p->'roles'))),coalesce((p->>'active')::boolean,true),(select id from public.motorist_profiles where user_id=(p->>'userId')::uuid and organization_id=p_organization_id limit 1))
 on conflict(id) do update set display_name=excluded.display_name,email=excluded.email,roles=excluded.roles,capabilities=excluded.capabilities,active=excluded.active,office_profile_id=coalesce(public.motorist_towing_memberships.office_profile_id,excluded.office_profile_id),membership_version=public.motorist_towing_memberships.membership_version+1 where public.motorist_towing_memberships.organization_id=p_organization_id;
 if not found then raise exception 'Towing access denied' using errcode='42501';end if;
 result:=jsonb_build_object('membershipId',target);
 elsif action='set_parking' then
 if exists(select 1 from public.motorist_towing_parking_sites where id=target and organization_id<>p_organization_id) then raise exception 'Towing access denied' using errcode='42501';end if;
 if jsonb_typeof(p->'name') is distinct from 'string' or jsonb_typeof(p->'address') is distinct from 'string' or nullif(btrim(p->>'name'),'') is null or nullif(btrim(p->>'address'),'') is null or length(p->>'name')>300 or length(p->>'address')>2000 then raise exception 'Invalid parking site' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_parking_sites where id=target and revision is distinct from (p->>'expectedRevision')::bigint) then raise exception 'Parking revision conflict' using errcode='PT409';end if;
 if not exists(select 1 from public.motorist_towing_parking_sites where id=target) and (select count(*) from public.motorist_towing_parking_sites where organization_id=p_organization_id)>=200 then raise exception 'Parking site limit' using errcode='22023';end if;
 insert into public.motorist_towing_parking_sites(id,organization_id,name,address,active) values(target,p_organization_id,btrim(p->>'name'),btrim(p->>'address'),coalesce((p->>'active')::boolean,true)) on conflict(id) do update set name=excluded.name,address=excluded.address,active=excluded.active,revision=public.motorist_towing_parking_sites.revision+1 where public.motorist_towing_parking_sites.organization_id=p_organization_id;
 if not found then raise exception 'Towing access denied' using errcode='42501';end if;
 result:=jsonb_build_object('parkingId',target);
 elsif action='set_tax_config' then
 if coalesce(jsonb_typeof(p->'rates'),'null')<>'array' or jsonb_array_length(p->'rates')=0 or exists(select 1 from jsonb_array_elements_text(p->'rates') r where r !~ '^[0-9]{1,3}(\.[0-9]{1,4})?$' or r::numeric>100) or nullif(p->>'label','') is null then raise exception 'Invalid tax configuration' using errcode='22023';end if;
 insert into public.motorist_towing_tax_config(organization_id,rates,valid_from,valid_until,label) values(p_organization_id,p->'rates',(p->>'validFrom')::date,(p->>'validUntil')::date,p->>'label') on conflict(organization_id) do update set rates=excluded.rates,valid_from=excluded.valid_from,valid_until=excluded.valid_until,label=excluded.label,revision=public.motorist_towing_tax_config.revision+1;
 else raise exception 'Unsupported command' using errcode='22023';end if;
 select revision into n from public.motorist_towing_orders where id=target;
 if n is null then select revision into n from public.motorist_towing_cash_handovers where id=target;end if;
 result:=jsonb_build_object('commandId',cid,'targetId',target,'revision',coalesce(n,1),'result',result);
 insert into public.motorist_towing_events(organization_id,target_id,actor_id,action,command_id,payload) values(p_organization_id,target,m.id,action,cid,p);
 insert into public.motorist_towing_commands(organization_id,command_id,actor_id,action,target_id,fingerprint,required_capability,result,assignment_generation) values(p_organization_id,cid,m.id,action,target,fp,cap,result,case when driver_op then o.assignment_generation else null end);
 return result;
 end $$;
create or replace function public.motorist_towing_file(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_id uuid,p_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships; o public.motorist_towing_orders; a public.motorist_towing_attachments; d public.motorist_towing_document_versions;begin
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if p_kind='attachment' then
 select * into a from public.motorist_towing_attachments where id=p_id and organization_id=p_organization_id;
 select * into o from public.motorist_towing_orders where id=a.order_id and organization_id=p_organization_id;
 if a.id is null or a.status='abandoned' or not (('operate'=any(m.capabilities)) or (m.capabilities&&array['price','documents'] and o.work_status in ('submitted','cancelled')) or ('drive'=any(m.capabilities) and o.driver_id=m.id and o.work_status in ('assigned','in_progress','needs_changes') and a.kind<>'scan')) then raise exception 'Not found' using errcode='P0002';end if;
 return jsonb_build_object('id',a.id,'orderId',a.order_id,'path',a.path,'mimeType',a.mime_type,'size',a.size,'name',a.name,'status',a.status,'sha256',a.sha256);
 elsif p_kind='document' then
 if not 'documents'=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501';end if;
 select * into d from public.motorist_towing_document_versions where id=p_id and organization_id=p_organization_id;
 if d.id is null or (not 'operate'=any(m.capabilities) and not exists(select 1 from public.motorist_towing_orders x where x.id=d.order_id and x.work_status in ('submitted','cancelled'))) then raise exception 'Not found' using errcode='P0002';end if;
 return jsonb_build_object('id',d.id,'orderId',d.order_id,'path',d.path,'mimeType','application/pdf','name','zakazkovy-list-'||d.version||'.pdf','status',d.status,'sha256',d.sha256,'snapshot',d.snapshot,'snapshotHash',d.snapshot_hash,'version',d.version,'kind',d.kind);
 else raise exception 'Not found' using errcode='P0002';end if;end$$;
create table public.motorist_towing_access_emails (
 id uuid primary key, organization_id uuid not null, member_id uuid not null,
 purpose text not null check(purpose in ('invite','reset','forgot')), recipient text not null,
 status text not null default 'pending' check(status in ('pending','accepted','failed','unknown')),
 provider_message_id text, created_at timestamptz not null default now(),
 foreign key(organization_id,member_id) references public.motorist_towing_memberships(organization_id,id)
);
create or replace function public.motorist_towing_access_email_claim(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_id uuid,p_member_id uuid,p_purpose text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships;t public.motorist_towing_memberships;e public.motorist_towing_access_emails;begin
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 if p_user_id is null then
 if p_purpose<>'forgot' then raise exception 'Access denied' using errcode='42501';end if;
 else
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'members'=any(m.capabilities) then raise exception 'Access denied' using errcode='42501';end if;
 end if;
 select * into t from public.motorist_towing_memberships where id=p_member_id and organization_id=p_organization_id and active for share;
 if t.id is null or t.email is null or not exists(select 1 from auth.users where id=t.auth_user_id and lower(email)=lower(t.email)) then raise exception 'Not found' using errcode='P0002';end if;
 perform app_private.towing_authorize(t.auth_user_id,t.organization_id,t.membership_version);
 select * into e from public.motorist_towing_access_emails where id=p_id;
 if e.id is not null then
 if e.organization_id<>p_organization_id or e.member_id<>p_member_id or e.purpose<>p_purpose then raise exception 'Claim conflict' using errcode='PT409';end if;
 return jsonb_build_object('id',e.id,'shouldSend',false,'status',e.status,'recipient',e.recipient,'displayName',t.display_name,'userId',t.auth_user_id);end if;
 insert into public.motorist_towing_access_emails(id,organization_id,member_id,purpose,recipient) values(p_id,p_organization_id,p_member_id,p_purpose,t.email);
 return jsonb_build_object('id',p_id,'shouldSend',true,'status','pending','recipient',t.email,'displayName',t.display_name,'userId',t.auth_user_id);end$$;
create or replace function public.motorist_towing_access_email_result(p_id uuid,p_status text,p_provider_message_id text default null) returns void language plpgsql security definer set search_path='' as $$begin
 if coalesce(p_status,'') not in ('accepted','failed','unknown') then raise exception 'Invalid status' using errcode='22023';end if;
 update public.motorist_towing_access_emails set status=p_status,provider_message_id=p_provider_message_id where id=p_id and status='pending';
 if not found then raise exception 'Claim unavailable' using errcode='P0002';end if;end$$;
create or replace function public.motorist_towing_access(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_order_id uuid,p_assignment_generation bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships;o public.motorist_towing_orders;a public.motorist_towing_cash_accounts;begin
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'drive'=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501';end if;
 select * into o from public.motorist_towing_orders where id=p_order_id and organization_id=p_organization_id;
 if o.id is null or o.driver_id is distinct from m.id or o.work_status='cancelled' or (p_assignment_generation is not null and o.assignment_generation<>p_assignment_generation) then
 if p_assignment_generation is not null and exists(select 1 from public.motorist_towing_assignments where organization_id=p_organization_id and order_id=p_order_id and driver_id=m.id and generation=p_assignment_generation) then raise exception 'assignment_revoked' using errcode='PT403';end if;
 raise exception 'Towing access denied' using errcode='42501';end if;
 a:=app_private.towing_account(p_organization_id,m.id);
 return jsonb_build_object('order',app_private.towing_order_json(o,true,m.id),'cashAccount',jsonb_build_object('id',a.id,'driverId',a.driver_id,'revision',a.revision,'balanceCents',app_private.towing_balance(a.id),'reservedCents',app_private.towing_reserved(a.id)));
 end$$;

create or replace function public.motorist_towing_report(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_from date,p_to date,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
 declare m public.motorist_towing_memberships;j jsonb;begin
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'report'=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>365 or jsonb_typeof(p_filters)<>'object' or (p_filters-array['branchId','driverId','fleetAssetId'])<>'{}'::jsonb then raise exception 'Invalid report period or filters' using errcode='22023';end if;
 with filtered as (
 select o.* from public.motorist_towing_orders o where o.organization_id=p_organization_id
 and ('operate'=any(m.capabilities) or o.work_status in ('submitted','cancelled'))
 and (nullif(p_filters->>'branchId','') is null or o.fields->>'branchId'=p_filters->>'branchId')
 and (nullif(p_filters->>'driverId','') is null or o.driver_id=(p_filters->>'driverId')::uuid)
 and (nullif(p_filters->>'fleetAssetId','') is null or o.fields->>'fleetAssetId'=p_filters->>'fleetAssetId')),
 performance as (
 select ((o.fields->>'finishedAt')::timestamptz at time zone 'UTC')::date as date,o.approved_cents as cents
 from filtered o where o.work_status='submitted' and o.approved_cents is not null and nullif(o.fields->>'finishedAt','') is not null
 and ((o.fields->>'finishedAt')::timestamptz at time zone 'UTC')::date between p_from and p_to),
 invoices as (
 select i.invoice_date as date,i.amount_cents as cents from public.motorist_towing_invoice_records i join filtered o on o.id=i.order_id
 where i.invoice_date between p_from and p_to and not exists(select 1 from public.motorist_towing_invoice_records newer where newer.supersedes_id=i.id)),
 receipts as (
 select (p.captured_at at time zone 'UTC')::date as date,p.amount_cents as cents from public.motorist_towing_payments p join filtered o on o.id=p.order_id
 where (p.captured_at at time zone 'UTC')::date between p_from and p_to),
 days as (select generate_series(p_from::timestamp,p_to::timestamp,interval '1 day')::date as date)
 select jsonb_build_object('from',p_from,'to',p_to,
 'performance',jsonb_build_object('count',(select count(*) from performance),'amountCents',(select coalesce(sum(cents),0) from performance)),
 'invoices',jsonb_build_object('count',(select count(*) from invoices),'amountCents',(select coalesce(sum(cents),0) from invoices)),
 'receipts',jsonb_build_object('count',(select count(*) from receipts),'amountCents',(select coalesce(sum(cents),0) from receipts)),
 'daily',coalesce((select jsonb_agg(jsonb_build_object('date',d.date,
 'performanceCents',(select coalesce(sum(p.cents),0) from performance p where p.date=d.date),
 'invoicedCents',(select coalesce(sum(i.cents),0) from invoices i where i.date=d.date),
 'receivedCents',(select coalesce(sum(r.cents),0) from receipts r where r.date=d.date)) order by d.date) from days d),'[]'::jsonb)) into j;
 if exists(select 1 from jsonb_each(j) x where x.key in ('performance','invoices','receipts') and abs((x.value->>'amountCents')::numeric)>9007199254740991) or exists(select 1 from jsonb_array_elements(j->'daily') d where abs((d->>'performanceCents')::numeric)>9007199254740991 or abs((d->>'invoicedCents')::numeric)>9007199254740991 or abs((d->>'receivedCents')::numeric)>9007199254740991) then raise exception 'Report amount exceeds exact client range' using errcode='22023';end if;
 return j;end$$;

-- Defense in depth: sensitive tables have no client policies and no client grants.
do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='public' and tablename like 'motorist_towing_%' loop
 execute format('alter table public.%I enable row level security',r.tablename);
 execute format('revoke all on public.%I from public, anon, authenticated',r.tablename);
 execute format('grant all on public.%I to service_role',r.tablename);
 end loop;
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname like 'motorist_towing_%') or (n.nspname='app_private' and p.proname like 'towing_%') loop
 execute format('revoke all on function %s from public, anon, authenticated',r.sig);
 if r.sig::text like 'motorist_towing_%' or r.sig::text like 'public.motorist_towing_%' then execute format('grant execute on function %s to service_role',r.sig);end if;
 end loop;
 end$$;
revoke all on sequence public.motorist_towing_order_number from public,anon,authenticated;
-- Private bucket has no authenticated storage policies; access is the file proxy.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('towing-documents','towing-documents',false,10485760,array['image/jpeg','image/png','application/pdf']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- Restrictive deny survives unrelated broad permissive policies on shared storage.
create policy towing_documents_proxy_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id <> 'towing-documents') with check(bucket_id <> 'towing-documents');
