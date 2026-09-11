-- Expand-only webhook retry contract. Existing fresh legacy claims may drain;
-- adoption occurs only after their claim expires. Legacy writers are fenced
-- from status/ownership changes once a row has been adopted by contract 2.
begin;
alter table public.motorist_telnyx_webhook_events
  add column contract_version integer not null default 1 check (contract_version in (1,2)),
  add column delivery_count integer not null default 0 check (delivery_count >= 0),
  add column deferral_count integer not null default 0 check (deferral_count >= 0),
  add column effect_failure_count integer not null default 0 check (effect_failure_count >= 0),
  add column retry_state text not null default 'ready' check (retry_state in ('ready','deferred','awaiting_correlation','dead_letter')),
  add column next_attempt_at timestamptz,
  add column terminal_reason text;

create index telnyx_webhook_retry_due_idx on public.motorist_telnyx_webhook_events(organization_id,next_attempt_at,received_at)
  where status in ('queued','failed') and retry_state <> 'dead_letter';
create index telnyx_webhook_correlation_idx on public.motorist_telnyx_webhook_events(organization_id,call_control_id,received_at)
  where retry_state='awaiting_correlation';

create function public.motorist_webhook_writer_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if old.contract_version=2 and
     (new.status,new.claimed_at,new.attempts,new.processed_at,new.error,new.contract_version,new.delivery_count,new.deferral_count,new.effect_failure_count,new.retry_state,new.next_attempt_at,new.terminal_reason)
       is distinct from
     (old.status,old.claimed_at,old.attempts,old.processed_at,old.error,old.contract_version,old.delivery_count,old.deferral_count,old.effect_failure_count,old.retry_state,old.next_attempt_at,old.terminal_reason)
     and current_setting('app.webhook_writer_contract',true) is distinct from '2' then
    raise exception 'Webhook writer contract 2 required' using errcode='PT409';
  end if;
  if old.contract_version=2 and (new.contract_version<>2 or (old.status='processed' and new.status<>'processed')
      or (old.retry_state='dead_letter' and new.retry_state<>'dead_letter')) then
    raise exception 'Webhook terminal state is immutable' using errcode='PT409';
  end if;
  return new;
end;
$$;
create trigger motorist_webhook_writer_guard before update on public.motorist_telnyx_webhook_events
  for each row execute function public.motorist_webhook_writer_guard();

create function public.motorist_telnyx_claim_webhook_event_v2(
  p_event_id text,p_event_type text,p_payload jsonb,p_organization_id uuid,
  p_call_session_id text default null,p_call_leg_id text default null,p_call_control_id text default null,
  p_connection_id text default null,p_occurred_at timestamptz default null,p_stale_after_ms integer default 30000,
  p_delivery boolean default true,p_correlation boolean default false
) returns table(outcome text,event_status text,event_attempts integer,event_claimed_at timestamptz,
  event_received_at timestamptz,event_retry_state text,event_terminal_reason text)
language plpgsql security definer set search_path='' as $$
declare r public.motorist_telnyx_webhook_events; t timestamptz:=clock_timestamp();
begin
  if p_organization_id is null or nullif(trim(p_event_id),'') is null then raise exception 'Invalid webhook scope' using errcode='22023'; end if;
  perform set_config('app.webhook_writer_contract','2',true);
  insert into public.motorist_telnyx_webhook_events(event_id,organization_id,event_type,call_session_id,call_leg_id,call_control_id,connection_id,payload,occurred_at,received_at,contract_version)
    values(p_event_id,p_organization_id,p_event_type,p_call_session_id,p_call_leg_id,p_call_control_id,p_connection_id,p_payload,p_occurred_at,t,2)
    on conflict(event_id) do nothing;
  select * into r from public.motorist_telnyx_webhook_events where event_id=p_event_id for update;
  if r.organization_id is not null and r.organization_id<>p_organization_id then raise exception 'Webhook organization mismatch' using errcode='42501'; end if;
  if r.event_type<>p_event_type or (r.call_control_id is not null and r.call_control_id is distinct from p_call_control_id)
     or (r.connection_id is not null and r.connection_id is distinct from p_connection_id) then
    raise exception 'Webhook identity mismatch' using errcode='PT409';
  end if;
  update public.motorist_telnyx_webhook_events set delivery_count=delivery_count+case when p_delivery then 1 else 0 end
    where event_id=p_event_id returning * into r;
  if r.status='processed' then outcome:='duplicate';
  elsif r.retry_state='dead_letter' then outcome:='terminal';
  elsif r.claimed_at is not null and r.claimed_at>t-make_interval(secs=>greatest(1000,p_stale_after_ms)/1000.0) then outcome:='busy';
  elsif r.retry_state='awaiting_correlation' and r.received_at<=t-interval '60 seconds' then
    update public.motorist_telnyx_webhook_events set contract_version=2,status='failed',retry_state='dead_letter',terminal_reason='awaiting_correlation_expired',claimed_at=null,next_attempt_at=null
      where event_id=p_event_id returning * into r;
    outcome:='terminal';
  elsif r.next_attempt_at>t and not (p_correlation and r.retry_state='awaiting_correlation') then outcome:='busy';
  else
    update public.motorist_telnyx_webhook_events set contract_version=2,organization_id=coalesce(organization_id,p_organization_id),
      claimed_at=greatest(t,coalesce(r.claimed_at,t-interval '1 microsecond')+interval '1 microsecond'),attempts=attempts+1,
      payload=coalesce(payload,p_payload),next_attempt_at=null
      where event_id=p_event_id returning * into r;
    outcome:='claimed';
  end if;
  event_status:=r.status;event_attempts:=r.attempts;event_claimed_at:=r.claimed_at;
  event_received_at:=r.received_at;event_retry_state:=r.retry_state;event_terminal_reason:=r.terminal_reason;
  return next;
end;
$$;

create function public.motorist_telnyx_finish_webhook_event_v2(p_event_id text,p_claimed_at timestamptz,p_result text,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.motorist_telnyx_webhook_events; t timestamptz:=clock_timestamp(); delay_ms integer; terminal text;
begin
  if p_claimed_at is null then return false; end if;
  if p_result is null or p_result not in ('processed','deferred','awaiting_correlation','failed') then raise exception 'Invalid webhook result' using errcode='22023'; end if;
  perform set_config('app.webhook_writer_contract','2',true);
  select * into r from public.motorist_telnyx_webhook_events where event_id=p_event_id and claimed_at=p_claimed_at and contract_version=2 for update;
  if not found or r.status='processed' or r.retry_state='dead_letter' then return false; end if;
  if p_result='awaiting_correlation' and r.received_at<=t-interval '60 seconds' then terminal:='awaiting_correlation_expired';
  elsif p_result='failed' and r.effect_failure_count+1>=5 then terminal:='effect_failure_limit';
  elsif p_result='deferred' and r.received_at<=t-interval '24 hours' then terminal:='deferral_age_limit'; end if;
  delay_ms:=case when p_result='failed' then least(120000,30000*power(2,least(r.effect_failure_count,2))::integer)
    else least(5000,500*power(2,least(r.deferral_count,4))::integer) end;
  update public.motorist_telnyx_webhook_events set
    status=case when p_result='processed' then 'processed' else 'failed' end,
    processed_at=case when p_result='processed' then t else null end,
    claimed_at=null,error=case when p_result='processed' then null else left(p_error,2000) end,
    deferral_count=deferral_count+case when p_result in ('deferred','awaiting_correlation') then 1 else 0 end,
    effect_failure_count=effect_failure_count+case when p_result='failed' then 1 else 0 end,
    retry_state=case when terminal is not null then 'dead_letter' when p_result in ('processed','failed') then 'ready' else p_result end,
    terminal_reason=terminal,
    next_attempt_at=case when terminal is not null or p_result='processed' then null else t+make_interval(secs=>delay_ms/1000.0) end
    where event_id=p_event_id;
  return true;
end;
$$;
revoke all on function public.motorist_telnyx_claim_webhook_event_v2(text,text,jsonb,uuid,text,text,text,text,timestamptz,integer,boolean,boolean) from public,anon,authenticated;
revoke all on function public.motorist_telnyx_finish_webhook_event_v2(text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.motorist_telnyx_claim_webhook_event_v2(text,text,jsonb,uuid,text,text,text,text,timestamptz,integer,boolean,boolean) to service_role;
grant execute on function public.motorist_telnyx_finish_webhook_event_v2(text,timestamptz,text,text) to service_role;
commit;
