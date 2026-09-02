update public.motorist_profiles
set role = 'admin',
    updated_at = now()
where id = (
  select id
  from public.motorist_profiles
  where role = 'manager'
    and active = true
    and access_status <> 'disabled'
  order by created_at
  limit 1
)
and not exists (
  select 1
  from public.motorist_profiles
  where role = 'admin'
    and active = true
    and access_status <> 'disabled'
);
