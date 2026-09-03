# Client Configuration

## Direction

The first implementation targets one concrete client, but the system should be configurable enough for another client later. This is not a full SaaS build yet; it is a single-client product with multi-client-ready foundations.

## Configurable Areas

- organization name, slug, locale, timezone, branding,
- enabled modules such as calls, cases, maps, fleet, SMS, AI,
- public lines (telephone numbers) with partner labels,
- ring groups, ring plans, business hours, IVR menus and pause reasons,
- SMS sender, templates, and opt-out language,
- branches and service standpoints,
- fleet asset categories,
- case sources and priority labels,
- pricing profiles and billing modes,
- map/routing provider,
- retention defaults for call payloads, recordings and transcripts.

## Non-Configurable Core

These remain product-level concepts:

- a call can be logged independently from a case,
- a case has contact, vehicle, locations, tasks, timeline, status, and owner,
- external events are normalized before UI use,
- audit is mandatory for operational and security-sensitive changes,
- provider credentials stay server-side.

## First Client Defaults

Seed data can include one organization named `Pomoc Motoristom`, the line `0850 005 006`, and the current demo pobočky/assets. These defaults should live in seed/config data, not as hard-coded assumptions in components.
