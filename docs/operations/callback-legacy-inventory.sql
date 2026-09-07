-- Read-only inventory before enabling TELEPHONY_STABILITY_V1_ENABLED.
-- Run only on the separate Telnyx copy. No backfill on page load and no
-- inference that an old missed call creates a new outstanding obligation.
-- Legacy task-only rows remain visible in the ordinary task inbox. A task
-- cannot be linked safely just because another request has the same case.
select t.id as task_id, t.case_id, t.title, t.due_at, t.assigned_to,
       count(r.id) filter (where r.status in ('open','scheduled')) as linked_live_requests,
       case when count(r.id)=0 then 'unsynchronized_manual_obligation' else 'explicitly_linked' end as callback_link_state
from public.motorist_case_tasks t
left join public.motorist_callback_requests r
  on r.organization_id=t.organization_id and r.metadata->>'task_id'=t.id::text
where t.organization_id = current_setting('motorist.callback_inventory_organization_id')::uuid
  and t.status in ('open','overdue')
  and (t.kind='callback' or t.title ilike 'Zavolať späť%')
group by t.id,t.case_id,t.title,t.due_at,t.assigned_to
order by t.due_at nulls last,t.id;
