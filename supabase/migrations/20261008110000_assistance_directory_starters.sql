-- Common assistance services for the dispatch organization's editable address book.
-- Existing entries, including archived or manually edited ones, take precedence.
with requested_services(name, known_names) as (
  values
    ('Allianz Assistance', array['allianz assistance']),
    ('Autoklub Slovakia Assistance', array['autoklub slovakia assistance', 'autoklub slovakia assistance s.r.o', 'autoklub slovakia assistance s.r.o.']),
    ('AXA Assistance CZ', array['axa assistance cz', 'axa assistance cz s.r.o', 'axa assistance cz s.r.o.']),
    ('Eurocross Assistance Czech Republic', array['eurocross assistance czech republic', 'eurocross assistance czech republic s.r.o', 'eurocross assistance czech republic s.r.o.']),
    ('Europ Assistance', array['europ assistance']),
    ('LeasePlan Slovakia', array['leaseplan slovakia', 'leaseplan slovakia s.r.o', 'leaseplan slovakia s.r.o.'])
)
insert into public.motorist_partner_directory (organization_id, kind, name)
select organization.id, 'assistance', requested_services.name
from public.motorist_organizations as organization
cross join requested_services
where organization.slug = 'pomoc-motoristom'
  and not exists (
    select 1
    from public.motorist_partner_directory as existing
    where existing.organization_id = organization.id
      and existing.kind = 'assistance'
      and lower(btrim(existing.name)) = any(requested_services.known_names)
  )
on conflict do nothing;
