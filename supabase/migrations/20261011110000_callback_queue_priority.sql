-- Read-only priority projection. No saved routing or callback rows are changed.
-- Callers must be authorized by the server for p_organization_id.
create or replace function public.motorist_callback_queue_time_v1(p_value text, p_fallback timestamptz)
returns timestamptz language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    return p_fallback;
  end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
  return p_fallback;
end;
$$;

create or replace function public.motorist_callback_queue_page_v1(
  p_organization_id uuid, p_cursor jsonb default null, p_limit integer default 100
) returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_result jsonb;
begin
  if p_organization_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_callback_queue_page' using errcode = '22023';
  end if;
  if p_cursor is not null and (
    jsonb_typeof(p_cursor) <> 'object' or coalesce(p_cursor->>'version','') <> '2'
    or coalesce(p_cursor->>'revision','') !~ '^[a-f0-9]{32}$'
    or coalesce(p_cursor->>'rank','') not in ('0','1')
    or coalesce(p_cursor->>'id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    or public.motorist_callback_queue_time_v1(p_cursor->>'sortAt', null) is null
  ) then
    raise exception 'invalid_callback_queue_cursor' using errcode = '22023';
  end if;

  with evidence as materialized (
    select c.id, c.created_at, to_jsonb(c) as request,
      jsonb_build_object('callback',s.metadata->'callback','ivr',jsonb_build_object('chosen',s.metadata #> '{ivr,chosen}')) as session_metadata,
      case
        when c.metadata #>> '{request,kind}' = 'requested'
          and jsonb_typeof(c.metadata #> '{request,requested_at}') = 'string'
          and coalesce(c.metadata #>> '{request,requested_at}','') <> ''
          and jsonb_typeof(c.metadata #> '{request,digit}') = 'string'
          and coalesce(c.metadata #>> '{request,digit}','') <> ''
          then c.metadata #>> '{request,requested_at}'
        when s.metadata #> '{callback,confirmed}' = 'true'::jsonb
          and jsonb_typeof(s.metadata #> '{callback,requested_at}') = 'string'
          and coalesce(s.metadata #>> '{callback,requested_at}','') <> ''
          then s.metadata #>> '{callback,requested_at}'
        else null
      end as requested_at
    from public.motorist_callback_requests c
    left join public.motorist_call_sessions s on s.id = c.session_id and s.organization_id = c.organization_id
    where c.organization_id = p_organization_id and c.status in ('open','scheduled')
  ), ranked as materialized (
    select *, case when requested_at is not null then 0 else 1 end as rank,
      case when requested_at is null then created_at
        else public.motorist_callback_queue_time_v1(requested_at, '9999-12-31T23:59:59.999999Z'::timestamptz) end as sort_at,
      case when requested_at is not null then 'requested'
        when request->>'source' = 'manual' then 'manual'
        when request->>'source' = 'missed' then 'missed' else 'unknown' end as origin_kind
    from evidence
  ), summary as (
    select count(*) as total,
      md5(coalesce(string_agg(id::text || ':' || rank::text || ':' || sort_at::text, ',' order by id),'')) as revision,
      jsonb_build_object('requested',count(*) filter(where origin_kind='requested'),
        'missed',count(*) filter(where origin_kind='missed'),
        'manual',count(*) filter(where origin_kind='manual'),
        'unknown',count(*) filter(where origin_kind='unknown')) as totals
    from ranked
  ), page as (
    select r.* from ranked r cross join summary s
    where p_cursor is null or s.revision is distinct from p_cursor->>'revision'
      or (r.rank, r.sort_at, r.id) > ((p_cursor->>'rank')::integer, (p_cursor->>'sortAt')::timestamptz, (p_cursor->>'id')::uuid)
    order by r.rank, r.sort_at, r.id limit p_limit + 1
  )
  select jsonb_build_object('entries', coalesce((select jsonb_agg(jsonb_build_object(
      'request',p.request,'sessionMetadata',p.session_metadata,'rank',p.rank,'sortAt',to_char(p.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      order by p.rank,p.sort_at,p.id) from page p),'[]'::jsonb),
    'openTotal',s.total,'totalsByOrigin',s.totals,'revision',s.revision,
    'reset',p_cursor is not null and s.revision is distinct from p_cursor->>'revision')
  into v_result from summary s;
  return v_result;
end;
$$;

revoke all on function public.motorist_callback_queue_time_v1(text,timestamptz) from public, anon, authenticated;
revoke all on function public.motorist_callback_queue_page_v1(uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.motorist_callback_queue_time_v1(text,timestamptz) to service_role;
grant execute on function public.motorist_callback_queue_page_v1(uuid,jsonb,integer) to service_role;
comment on function public.motorist_callback_queue_page_v1(uuid,jsonb,integer) is
  'Authorized server-only, organization-scoped read. Confirmed caller requests precede missed calls before pagination. Reset changed queue cursors without rewriting evidence.';
