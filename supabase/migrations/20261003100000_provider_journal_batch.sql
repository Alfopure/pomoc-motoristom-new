-- ---------------------------------------------------------------------------
-- The provider journal, for a group of commands at once
-- ---------------------------------------------------------------------------
-- Every voice command costs two round trips of its own: `prepare_v2` before it
-- and `result_v2` after. A ring step that calls five operators pays ten, and
-- the teardown behind a bridge pays six more — all of them to a database that
-- serialises them on one session row anyway.
--
-- These are the same functions over an array. One fence, one lock, one
-- statement per command inside a single transaction, and a decision per
-- command back. Nothing about the per-command semantics changes: the singles
-- stay, and this is what a caller that already has the whole group reaches for.

create or replace function public.motorist_provider_command_prepare_batch_v2(
  p_session_id uuid,
  p_commands jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s public.motorist_call_sessions%rowtype;
  c public.motorist_provider_commands%rowtype;
  item jsonb;
  decisions jsonb := '[]'::jsonb;
  dispatch boolean;
begin
  -- Once, for the group: the fence takes the session lock the singles each
  -- take in turn.
  perform public.motorist_telephony_fence(p_session_id);
  select * into s from public.motorist_call_sessions where id = p_session_id for update;
  if s.writer_contract <> 2 then
    raise sqlstate 'PT409' using message = 'provider journal requires writer contract 2';
  end if;

  for item in select * from jsonb_array_elements(p_commands) loop
    dispatch := true;
    select * into c from public.motorist_provider_commands
      where session_id = p_session_id and command_id = item->>'command_id';
    if found then
      if c.fingerprint <> (item->>'fingerprint')
        or c.method <> (item->>'method')
        or c.path <> (item->>'path')
        or c.correlation_state is distinct from (item->>'correlation_state')
        or c.request_payload is distinct from coalesce(item->'payload', '{}'::jsonb) then
        raise sqlstate 'PT409' using message = 'provider command payload identity conflict';
      end if;
      if c.outcome <> 'rate_limited' or c.next_attempt_at > clock_timestamp() then
        decisions := decisions || jsonb_build_array(to_jsonb(c) || jsonb_build_object('dispatch', false));
        dispatch := false;
      end if;
    end if;

    if dispatch then
      -- The refusal is raised, not returned: a committed termination means no
      -- member of this group may dispatch, and aborting the transaction is
      -- what guarantees none of them was prepared.
      if (s.termination_requested_at is not null or s.ended_at is not null or s.state::text in ('ended','failed'))
        and (item->>'path') !~ '/actions/(hangup|record_stop|leave|stop)$' then
        raise sqlstate 'PT409' using message = 'telephony termination blocks new provider command';
      end if;
      insert into public.motorist_provider_commands(session_id, command_id, fingerprint, method, path,
          correlation_state, request_payload, dispatch_generation, dispatch_token)
        values (p_session_id, item->>'command_id', item->>'fingerprint', item->>'method', item->>'path',
          item->>'correlation_state', coalesce(item->'payload', '{}'::jsonb), s.ownership_generation, s.lease_token)
        on conflict (session_id, command_id) do update set outcome = 'unknown',
          dispatch_generation = s.ownership_generation, dispatch_token = s.lease_token, next_attempt_at = null;
      decisions := decisions || jsonb_build_array(jsonb_build_object('dispatch', true));
    end if;
  end loop;

  return decisions;
end $function$;

create or replace function public.motorist_provider_command_result_batch_v2(
  p_session_id uuid,
  p_generation bigint,
  p_token text,
  p_results jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  item jsonb;
  changed integer;
  applied jsonb := '[]'::jsonb;
  status integer;
begin
  -- Same lock order as preparation, and the same tolerance of old-owner
  -- evidence: a response already received stays evidence after lease loss.
  perform 1 from public.motorist_call_sessions where id = p_session_id for update;

  for item in select * from jsonb_array_elements(p_results) loop
    status := (item->>'status')::integer;
    update public.motorist_provider_commands set
      http_status = status,
      result = item->'result',
      outcome = case
        when status between 200 and 299 then 'accepted'
        when status = 429 then 'rate_limited'
        when status between 400 and 499 and status <> 408 then 'rejected'
        else 'unknown' end,
      next_attempt_at = case when status = 429
        then clock_timestamp() + make_interval(secs => greatest(0, coalesce((item->>'retry_after_ms')::integer, 500)) / 1000.0)
        else null end
      where session_id = p_session_id and command_id = item->>'command_id'
        and fingerprint = item->>'fingerprint'
        and dispatch_generation = p_generation and dispatch_token = p_token
        and outcome = 'unknown';
    get diagnostics changed = row_count;

    -- An accepted `/calls` re-arms an existing termination obligation; it never
    -- authorizes a new dial.
    if changed = 1 and status between 200 and 299 and exists(
      select 1 from public.motorist_provider_commands where session_id = p_session_id
        and command_id = item->>'command_id' and path = '/calls' and termination_cleanup_at is null) then
      perform set_config('motorist.telephony_internal', '1', true);
      update public.motorist_call_sessions set termination_next_attempt_at = clock_timestamp()
        where id = p_session_id and termination_requested_at is not null;
      perform set_config('motorist.telephony_internal', '', true);
    end if;

    applied := applied || jsonb_build_array(changed = 1);
  end loop;

  return applied;
end $function$;

revoke execute on function public.motorist_provider_command_prepare_batch_v2(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.motorist_provider_command_result_batch_v2(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.motorist_provider_command_prepare_batch_v2(uuid, jsonb) to service_role;
grant execute on function public.motorist_provider_command_result_batch_v2(uuid, bigint, text, jsonb) to service_role;
