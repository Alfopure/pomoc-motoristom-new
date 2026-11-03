# Produkčné vydanie 2026-11: plán (návrh, nič nevykonané)

Stav 3. 11. 2026. Produkcia `main` = `7ff4247c` (12. 10., PR #438). `dev` = `8ae9c52f` + PR `release-prep/prod-unlock-1103` (odomknutie S5 pre produkciu). Produkčná DB `ifpaeegaesdmljfkdvcn` končí v ledgeri migráciou `20261012205526 line_workspace`.

Tento plán nahrádza [návrh z 28. 10.](production-release-2026-10-28.md). Súhlas z 28. 10. sa týkal `dev` `02b5538` a 22 migrácií. Odvtedy pribudli zrýchlenie hovorov (S0 až S8), štyri telefonické migrácie a odomknutie EU API. Podľa [AGENTS.md](../../AGENTS.md) treba schváliť rozšírený rozsah nanovo. Kým majiteľ výslovne neschváli tento rozsah, presné SQL a produkčný projekt, nič z plánu sa nevykoná. Platí to pre migrácie, premenné, prepínače aj Telnyx.

## Zhrnutie pre majiteľa

**Čo prinesie vydanie.** Na produkciu sa dostanú asi tri týždne práce, ktorú máš na TESTe:
- **Pobočky:** odovzdanie práce pobočke, pracovné skupiny, reporty.
- **Partneri:** prípady a poistné udalosti pre partnerov, partnerský portál, konzultácie, vyúčtovanie s auditom.
- **Výjazdy, odvozy a odťahy:** spoločný prehľad, návraty vozidiel, poškodenia s fotkami, odťahové zákazky s PDF.
- **Mobilná aplikácia:** serverová časť pre iPhone a Android, teda prípady, úlohy, pristavovač s polohou a push upozornenia.
- **Hovory:** stabilnejšie ukončenie a obnova hovorov. Navyše zrýchlenie: na TESTe klesol čas od ťuknutia po zvonenie kolegovi z 5,6 s na 3,3 s. Server posiela príkazy Telnyxu do Európy, každý príkaz je o 150 až 200 ms rýchlejší.

**Čo musíš rozhodnúť alebo urobiť ty.**
1. Otestovať TEST s touto verziou a napísať „test OK, vydaj“ pre presne určený `dev` commit.
2. Schváliť 26 produkčných migrácií v poradí nižšie. **Ďalších 7 migrácií sa nespúšťa**: v produkcii už sú a tri z nich by po opätovnom spustení niečo pokazili (pozri časť 2).
3. Rozhodnúť o **7 starých odovzdaniach** v produkcii. Sú po termíne, ale stále otvorené. Migrácia ich zmení na otvorené výjazdy. Môžeš ich po vydaní zavrieť v aplikácii, alebo ich pred migráciou zavrieť samostatným schváleným krokom.
4. Rozhodnúť o premenných: zapnúť modul odťahov (`MOTORIST_TOWING_ENABLED`), pristavenia (`MOBILE_DELIVERY_ENABLED`) a mobilné push (`MOBILE_PUSH_ENABLED`). Ďalej:
   - potvrdiť, že `TELNYX_API_BASE_URL` je `https://api.telnyx.com/v2`, alebo ho zmazať; je uložená ako tajná a nedá sa prečítať;
   - presunúť `TELNYX_MEDIA_BASE_URL` na vlastnú doménu.
5. Schváliť nastavenie produkčných prepínačov rýchlosti hovorov (časť 3). Zapínajú sa po etapách, každá sa dá do 5 s vypnúť.
6. Schváliť bezpečnostnú zmenu v Telnyxe (časť 5). Webové a iPhone telefóny dostanú vlastný vypnutý odchádzajúci profil, aby sa z nich nedalo volať von mimo aplikácie.
7. Byť k dispozícii v tichom okne (návrh: večer po 20:30) na skúšobné hovory.

**Čo zostáva mimo tohto vydania.** Hovory na iPhone v produkcii potrebujú produkčnú iOS aplikáciu. Je to samostatná cesta cez App Store: produkčné App ID, VoIP certifikát, produkčný Telnyx iOS push a TestFlight s reálnym hovorom. Testovacia appka s produkciou nevolá. Nahrávanie hovorov zostáva vypnuté. Súbežné vytáčanie (S6), európska SIP doména a ďalšie neoverené zrýchlenia zostávajú vypnuté.

**Riziká jednoducho.**
- Migrácie sú prevažne pridávajúce. Jediná mení živé dáta: zmení 8 odovzdaní na výjazdy.
- Krátke zámky tabuliek sú pri hovoroch. Preto tiché okno: v produkcii za posledných 30 dní nebol medzi 23:00 a 7:00 ani jeden hovor.
- Kód sa vracia revert PR. Databáza sa nevracia, migrácie zostávajú. Pred vrátením kódu treba prepnúť hovory späť na `us` a počkať, kým skončia európske hovory.

---

## 1. Scope (`git log --oneline origin/main..origin/dev --merges`)

154 merge commits, PRs #420–#557 plus this PR. #437 and #439 are `main` → `dev` syncs. #421 and #422 already reached production in another form through #438. Grouped by area:

| Area | What changes, in plain words | PRs |
|---|---|---|
| Branches (Pobočky) | Handing work to branches, branch work groups with review, branch reports, branch module in the app | #514, #519 |
| Partners (Partneri) | Partner cases and insurance claims, partner portal and documents, consultations, scoped partner report, settlement audit, case follow-ups | #509, #511, #512, #515 |
| Operations, returns, towing (Výjazdy, odvozy, odťahy) | One operations view for deliveries, returns and tows; vehicle returns with damage evidence; towing work orders, offline driver workflow and Slovak PDFs; operation access links and positions | #445–#447, #509, #510, #512, #513 |
| Cases and web dispatch | Case search across statuses with vehicle/PZP fill, web handoff to the delivery driver, rental draft preview, login renewal, "accepted by executor" status, attachment integrity, Outlook error e-mails, transient load errors | #441, #442, #444, #448, #449, #498, #518, #521, #526, #531 |
| Notifications | Notices to the right person, mobile identity, mobile push (Expo/APNs) | #480, #481, #517 |
| Mobile app (iPhone/Android, server side and app) | Native dispatch app: cases, tasks, maps, fleet, callbacks, after-call work, delivery driver with background location and privacy, modules, Android/Play prep, TestFlight builds, native iPhone calling behind its own production switches (off) | #420, #423–#434, #440, #443, #451, #455, #457, #459, #461, #462, #464, #465, #467–#479, #482–#497, #507, #508, #519, #520, #523, #528–#530, #532, #533, #535–#537 |
| Calls: stability | Call recovery and incident diagnostics, caller loopback, unified web/iPhone calls, waiting-room controls, ended calls, duplicate events, realtime auth, polling | #450, #452–#454, #456, #458, #460, #522, #536 |
| Calls: speed (call-speed S0–S8) | Switches and metrics (S0), lean internal path (S1), faster start (S2), early own-leg accept (S3, plus the Realtime/session privacy fixes), keep-alive (S4, off), EU API (S5, unlocked by this PR for unrecorded calls), browser EU region (S5a), concurrent dial (S6, off), faster hold (S7), iPhone tuning (S8), EU SIP domain (TEST only) | #538–#557 |
| Docs, QA, TEST-only | Live-delivery QA harness, TEST Supabase on Pro, build records, plans | #466, #474, #483, #485–#488, #493, #495, #497, #499–#506, #516, #524, #525, #527, #533, #534 |

## 2. Database migrations

### 2.1 Findings (read-only, 3 Nov 2026)

Source: `supabase_migrations.schema_migrations` and catalog/count selects on production, through `.context/brano/prod_ro.py` only.

- **The version numbers in the ledger don't match.** By name, 33 repo migrations are missing from production. Another 27 are recorded under different version numbers than the repo files, and production has `20261001071403` with no repo file. **Never run `supabase db push` or "all pending migrations"**: apply each file on its own, in the order below.
- **7 of the 33 are already applied** (outside the ledger). They also belong to `main`, which uses their objects today. **Do not run them:**

| Migration | Production state | If re-run |
|---|---|---|
| `20260926100000_assistance_line_labels` | 7 lines exist; labels/partner names edited since | **Breaks data.** It overwrites the labels of the lines ending 718/732/770/771 and **reactivates the inactive lines 770 and 774**. |
| `20261002100000_queue_escalation_setting` | column, default 120 and check present | harmless |
| `20261003100000_provider_journal_batch` | functions and grants identical | harmless |
| `20261004100000_apply_critical_rows` | identical | harmless |
| `20261006100000_call_history_search` | superseded by prod `20261006130000 call_history_search_variable_scope` | **Breaks history search.** It restores the version whose `phone` variable collides with a column. |
| `20261006110000_incoming_routing_workspace` | superseded by prod `20261005195034` and `20261012205526` | **Breaks routing.** It rolls back `motorist_save_incoming_routing` and `motorist_routing_snapshot`, which `main`'s editor needs. |
| `20261008110000_assistance_directory_starters` | all 6 entries present | inserts 0 rows |

  Recording them in the ledger is optional; the release does not need it. Recording them writes to production, so it needs its own authorization.
- **No TEST-specific SQL.** The TEST project ref and "TEST only" wording appear only in comments (`20261012183000`, `20261020210000`, `20261022100000`, `20261022180000`, `20261028150000`). Hardcoded IDs appear only in the 7 skipped migrations.
- **`motorist_telephony_start_privacy_v1()` would return `false` in production today.** It returns `true` after `20261031100000` and `20261031100100`, as on TEST:
  - today `anon` and `authenticated` can `SELECT` `motorist_call_sessions`: RLS is on with one member policy;
  - the broadcast function still sends full rows;
  - none of the four telephony tables is in a Realtime publication.

  These two migrations also close a real production exposure: today any organisation member can read call sessions. `true` only *allows* S3; a flag still has to switch it on.
- **`20261031090000_telephony_latency_flags` seeds nothing.** It adds the column with default `{}` on 1 row, so behaviour is unchanged.
- **Compatibility with the running `main`.** Migrations go first, so `main` runs on the new schema for a short time. Everything is additive or keeps `main`'s paths:
  - `main` reads `motorist_call_sessions` only through the service role (after #32);
  - its browser ignores the Realtime payload (after #31);
  - the patched `motorist_case_handoff` keeps its signature (#14).
- **No object clashes** for the 26 to apply. The one existing index (`motorist_profiles_organization_id_id_push_idx`) is created `if not exists`. Three existing functions get replaced:
  - `app_private.motorist_handoff_dto`;
  - `public.motorist_case_handoff`;
  - `app_private.motorist_broadcast_telephony_change`.
- **No transaction wrapper in the file** for `20261013120000`, `20261020210000`, `20261026190404`, `20261031100000`, `20261031100100` and `20261031100200`. Wrap each one in `begin; … commit;`. The others carry their own.

Production row counts (3 Nov):

| Table | Rows |
|---|---|
| `motorist_telephony_settings` | 1 |
| `motorist_case_handoffs` | 8 |
| `motorist_handoff_events` | 25 |
| `motorist_audit_log` | 545 |
| `motorist_cases` | 33 |
| `motorist_call_sessions` | 715 |
| `motorist_call_legs` | 1947 |
| `motorist_operator_presence` | 6 |
| `motorist_profiles` | 12 |
| `motorist_organizations` | 1 |
| `auth.users` | 9 |

### 2.2 The 26 to apply, in this order

Timestamp order. Every migration's prerequisites exist in production or in an earlier row.

| # | Migration | What it does | Additive / alters existing | Backfill / seed | Rollback stance | Risk |
|---|---|---|---|---|---|---|
| 1 | `20261012183000_case_owner_assignment` | Two service-role functions to assign a case owner | additive | none | drop both functions | low |
| 2 | `20261013120000_towing_work_orders` | Towing module: 17 `motorist_towing_*` tables, ~25 functions, private bucket `towing-documents`; FKs to organizations, profiles, cases, `auth.users` | additive; brief FK locks on small tables | none (first membership is a separate reviewed insert) | drop new objects while empty | low–med |
| 3 | `20261020210000_mobile_push_devices` | Mobile push device table (its index already exists from `20260906081818`) | additive | none | drop table | low |
| 4 | `20261022100000_mobile_delivery_handoffs` | Delivery role on handoffs: `recipient_member_id` with FK and index on `motorist_case_handoffs` (8 rows), `actor_member_id` on `motorist_handoff_events` (25); replaces `motorist_handoff_dto` (adds the "Pristavovač" label); new `motorist_case_handoff_app` | **alters 2 existing tables**, nullable columns | none | manual: drop columns, restore the dto from `20261009100000` | low–med |
| 5 | `20261022180000_mobile_delivery_background` | Background trackers for the delivery driver | additive | none | drop new objects | low |
| 6 | `20261026190404_partner_consultations_and_portal` | 9 partner tables, private bucket `motorist-partner-documents`, append-only grants | additive | none | drop new objects | low |
| 7 | `20261026190600_shared_dispatch_operations` | Shared operations model (cycles, operations, executions, evidence, commands, events); bucket `motorist-operation-evidence`; patches `motorist_case_handoff` by `replace()`; sync trigger on handoffs; swaps the handoff unique index for two partial ones | **alters `motorist_case_handoffs`** (column, index swap, BEFORE trigger) and a live function | **Backfill: 8 handoffs → 8 operations + 8 executions.** All 8 are past `expires_at`: 3 accepted, 1 arrived, 1 completed, 3 offered. They become 3 accepted, 1 arrived, 3 draft open operations and 1 completed. Owner decision (summary item 3) | in practice forward-only (manual down: drop triggers/tables, restore the function from `20261009100000`) | **med** |
| 8 | `20261026192423_operations_workspace_customer_contact` | Patches a #7 function (guarded by anchor checks) | new objects only | none | re-apply previous body | low |
| 9 | `20261026192813_towing_cycle_return_owner` | Return owner on cycles | new objects only | backfill from a new table, 0 rows | drop | low |
| 10 | `20261026195725_operations_actor_locking_auth` | Locking and definer fixes on new functions | new objects only | none | re-apply | low |
| 11 | `20261026201554_partner_report_scoped_execution` | Partner report function | new objects only | none | re-apply | low |
| 12 | `20261026211724_operation_access_links` | 3 grant tables and a BEFORE trigger on `motorist_case_handoffs`; it raises only when an active operation handoff collides with a grant | adds a trigger on an existing table | none | drop trigger/tables | low–med |
| 13 | `20261026211731_operations_returns_damage_evidence` | Damage evidence for returns | new tables only | update on a new table, 0 rows | drop | low |
| 14 | `20261026211759_atomic_case_partner_origin` | Atomic case creation with partner origin | additive | none | drop | low |
| 15 | `20261026213118_partner_settlement_audit` | Audit trigger on `motorist_audit_log` (545 rows, no triggers today), partner-settlement entries only | adds a trigger on an existing table | none | drop trigger | low |
| 16 | `20261028100000_branch_work_groups` | Branches and work groups | additive | none | drop | low |
| 17 | `20261028110000_branch_work_groups_review` | Branch review fixes | additive | none | drop | low |
| 18 | `20261028120000_partner_case_followups` | Partner case follow-ups | additive | none | drop | low |
| 19 | `20261028130000_mobile_work_push` | Push outbox for the app; drained by the existing 5-minute cron, no pg_cron or worker | alters new tables only | update on a new table, 0 rows | drop | low |
| 20 | `20261028140000_operation_positions` | Operation positions | additive | none | drop | low |
| 21 | `20261028150000_operation_background_tracking` | Background tracking for operations | additive | none | drop | low |
| 22 | `20261028170000_rental_draft_source` | Rental draft function | additive | none | drop | low |
| 23 | `20261031090000_telephony_latency_flags` | `latency_flags jsonb not null default '{}'` on `motorist_telephony_settings` (1 row) | adds a column to an existing table | **no seed**; `{}` is today's behaviour | drop column (the app then reads env) | low |
| 24 | `20261031100000_telephony_realtime_doorbell` | Broadcast function behind 4 triggers on sessions, legs and presence sends a content-free doorbell instead of full rows | replaces a function on hot triggers | none | re-apply the `20260915100000` body (not recommended: privacy) | low |
| 25 | `20261031100100_call_sessions_service_only` | Drops `motorist_call_sessions_member_select`, revokes all from `anon` and `authenticated` | **revokes access and drops a policy** on the hot `motorist_call_sessions` (715 rows); brief exclusive lock | none | re-grant and recreate the policy (not recommended: privacy) | low–med |
| 26 | `20261031100200_telephony_start_privacy_check` | Read-only `motorist_telephony_start_privacy_v1()`, service role only | additive | none | drop | low |

Realtime messages that the old broadcast stored before #24 hold full rows and can be replayed for up to 3 days (see [release workflow](release-workflow.md)). Deleting them is a data change and needs separate authorization.

### 2.3 How to apply (technical checklist)

- Target `ifpaeegaesdmljfkdvcn` only, after the owner approves this list and project. Do not touch TEST or `sjcsrygkkmersoczpunh`.
- One file per request, in the order above. Prefix each request with `set lock_timeout = '5s'; set statement_timeout = '120s';`. Wrap the six files without `begin`/`commit` in a transaction. Record each one in `supabase_migrations.schema_migrations` with its repo version and name.
- Before #1, check for live calls: `select count(*) from public.motorist_call_sessions where ended_at is null and started_at > now() - interval '2 hours'` must be 0. Repeat before #24 and #25.
- After each file, check its main object with `to_regclass` or `pg_proc`. After #26, `select public.motorist_telephony_start_privacy_v1()` must return `true`.
- If a statement hits the lock timeout, the transaction rolls back. Retry after the call ends; never raise the timeout during calls.

## 3. Production latency flags (after migration #23)

Current TEST value (`nzpnqdstvkfncflgqlny`, read-only, `updated_at` 2026-11-03 06:25 UTC):

```json
{"api_region":"eu","sip_domain":"eu","hold_fast_web":true,"start_fast_path":true,"fresh_after_write":true,
 "hold_lean_context":true,"http_keepalive_ms":60000,"hold_mobile_dedupe":true,"internal_lean_path":true,
 "claim_holding_drain":true,"start_early_response":true,"own_leg_request_header":true,"bridged_observation_fast":true,
 "mobile_rotate_on_takeover":true,"start_test_proof_prefetch":true,"test_conference_self_proof":true,
 "mobile_rotate_on_deactivation":true,"concurrent_dial":{"internal":{"web":false}},
 "client":{"webRtcRegion":"eu","webEarlyAccept":true,"mobileRtcRegion":"eu","mobileTokenCache":true,"mobileTrickleIce":true,
  "mobileEarlyAccept":true,"mobileParallelOffers":true,"mobileRealtimeStatus":true}}
```

**Proposed final production value** (web and server; the stages below). The production organisation is `00000000-0000-4000-8000-000000000001`:

```json
{
  "internal_lean_path": true,
  "bridged_observation_fast": true,
  "claim_holding_drain": true,
  "fresh_after_write": true,
  "start_fast_path": true,
  "start_early_response": true,
  "hold_fast_web": true,
  "hold_lean_context": true,
  "api_region": "eu",
  "own_leg_request_header": true,
  "client": { "webRtcRegion": "eu", "webEarlyAccept": true }
}
```

Each stage writes the **whole object**. `||` would replace the nested `client` object, so don't use it. Each stage reaches new calls within the 5 s cache, and each is followed by a web test call:

```sql
update public.motorist_telephony_settings set latency_flags = '<stage JSON>'::jsonb
where organization_id = '00000000-0000-4000-8000-000000000001';
```

| Stage | Adds | Key | Why |
|---|---|---|---|
| A | S1, S2, S7a, S5a | `internal_lean_path` | S1.1: colleague calls skip recording bookkeeping (they never record) |
| | | `bridged_observation_fast` | S1: cheap `call.bridged` handling |
| | | `claim_holding_drain` | S1: the webhook claim is held while draining |
| | | `fresh_after_write` | S1: fresh read after own write |
| | | `start_fast_path` | S2.1: guard reads in one wave |
| | | `start_early_response` | S2.3: the start answers once the own leg is dialled |
| | | `hold_fast_web` | S7a.5: the web hold answers on confirmation |
| | | `hold_lean_context` | S7a.4: lean routing context for hold/unhold |
| | | `client.webRtcRegion: "eu"` | S5a: browsers register on the EU RTC edge |
| B | S5 (this PR) | `api_region: "eu"` | Outbound, callback and colleague calls that will not be recorded are created and controlled through `api.telnyx.eu`; inbound stays `us`. Production recording env switches are all `true` and the policy is off, so each outbound start reads one policy row in parallel; calls stay `eu` while recording is off. |
| C | S3 | `own_leg_request_header` | Server-side only while `motorist_telephony_start_privacy_v1()` is `true` (after #24–#26) |
| | | `client.webEarlyAccept` | The browser accepts its own leg early |

Prerequisite for stage C: the read-only check from the [release workflow](release-workflow.md). `GET /v2/credential_connections/<prod credential connection>` must return `sip_uri_calling_preference: "internal"`. A read-only note of 2 Nov recorded `internal` for `pomoc-motoristom-webrtc`; re-read it on release day.

**Stage D, only with the production iPhone build and after its own smoke test.** Add `hold_mobile_dedupe`, `mobile_rotate_on_takeover`, `mobile_rotate_on_deactivation` and the client keys:
- `mobileRtcRegion: "eu"`;
- `mobileTokenCache`, which is honoured only while both rotations are on;
- `mobileTrickleIce`, `mobileRealtimeStatus`, `mobileEarlyAccept` and `mobileParallelOffers`.

All were tested on TEST builds. They do nothing in production until native voice is switched on.

**Excluded, with reason:**
- `start_test_proof_prefetch` and `test_conference_self_proof`: TEST provider guards. Production runs no guard.
- `sip_domain`: `EU_SIP_DOMAIN_PROVEN` is false. Production ignores the key, and it waits for the owner's iPhone test.
- `concurrent_dial`, `internal_auto_bridge`, `own_leg_timeout_secs_concurrent` and `concurrent_far_link_to`: S6 is gated by `CONCURRENT_START_PROVEN`. On TEST it measured no net gain: the caller hears the colleague later.
- `hold_join_with_hold`: S7b is gated by `JOIN_WITH_HOLD_PROVEN`, and spike S7.0 has not been run.
- `client.targetLocalFirst`: gated by `TARGET_LOCAL_FIRST_PROVEN`. There is no far-party audio signal.
- `http_keepalive_ms`: the S4 runbook result is "not yet run". It stays `0` until S4.2 passes on TEST.
- `client.webPrefetchIce`: not on in TEST either.

**Rollback.** `latency_flags = '{}'::jsonb` reaches new calls within 5 s. Calls already started keep their frozen mode.

**Check after stage B.** After a web call to a mobile and a colleague call:

```sql
select direction, metadata->'start_mode' from public.motorist_call_sessions order by started_at desc limit 3
```

The outbound and internal calls must show `apiRegion: "eu"` and an inbound call `"us"`.

## 4. Environment checks (Vercel API, read-only, values not printed)

Production project `pomoc-motoristom-dispatching` (`prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`), Production target, read 3 Nov.

| Check | Result | Action |
|---|---|---|
| `TELNYX_API_BASE_URL` | **set, type `sensitive`: the value cannot be read** | Owner confirms it is `https://api.telnyx.com/v2`, or deletes it. Production with S5 ignores a different value and pins `api.telnyx.com`; after deploy, look for `api_base_url_override_ignored` in the runtime logs. |
| `TELNYX_EU_API_BASE_URL` | unset | OK |
| `TELEPHONY_LATENCY_FLAGS` | unset | Keep unset; use the database flags. |
| `MOTORIST_APP_ENV`, `APP_BASE_URL`, `SUPABASE_URL` | match `production`, `https://dispecing.linkapomoci.sk`, the production ref | OK (`euApiRegionAllowed` and `isProductionLiveDeployment` need them) |
| `TELNYX_RECORDING_ENABLED`, `TELNYX_RECORDING_CONTRACT_VERIFIED`, `RECORDING_PROCESSING_ENABLED` | all `true` | The S5 start reads the recording policy row, which is off (`recording_enabled = false`), so calls stay unrecorded and `eu`. Enabling recording later moves outbound calls back to `us`. |
| `TELNYX_MEDIA_BASE_URL` | differs from `https://dispecing.linkapomoci.sk/telephony` | Move it with this release (planned in [telnyx-setup](telnyx-setup.md)). |
| `NEXT_PUBLIC_APP_URL` | differs from `https://dispecing.linkapomoci.sk` | Owner checks it in the dashboard. |

**Env names that `dev` code reads and `main` does not, missing in production:**

| Name | On TEST | Proposal |
|---|---|---|
| `MOTORIST_TOWING_ENABLED` | yes | `true` if towing goes live. Without it the towing pages and links are off. |
| `MOBILE_DELIVERY_ENABLED` | yes | `true` when the delivery driver app goes live. |
| `MOBILE_PUSH_ENABLED` | yes | `true` when mobile push goes live (production stays off until approved). |
| `EXPO_ACCESS_TOKEN` | no | optional; only if Expo push security is enabled |
| `MOBILE_MINIMUM_APP_VERSION`, `MOBILE_UPDATE_URL` | no | optional; forced-update screen |
| `MOBILE_VOICE_DIAGNOSTICS_ENABLED` | no | optional; iPhone call diagnostics in production |
| `MOTORIST_NATIVE_VOICE_ENABLED`, `MOTORIST_NATIVE_VOIP_PUSH_ENABLED` | no | Only with the production iOS build (App Store track). |
| `MOTORIST_NATIVE_VOICE_TEST_ENABLED`, `MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED` | yes | **Never in production** (TEST-only switches). |

The `dev` code also reads `ACK`, but that is a false match on a comment. Older gaps that `main` already has are unchanged, e.g. `VAPID_*` for web push; see the 28 Oct plan. Env changes take effect only with a fresh build, so set them **before** merging the release PR.

## 5. Telnyx security step: blocked outbound profile for the phones (not executed)

**Finding (read-only, 2 Nov).** The production credential connection `pomoc-motoristom-webrtc` (`3040092094321394986`) uses the shared, enabled outbound voice profile `pomoc-motoristom-test`. A logged-in web or iPhone client could therefore originate PSTN calls through the SDK, bypassing the application. On TEST, the connection has its own disabled profile: `dispatch-isolated-test-browser-blocked-20260930`.

The owner's production authorization covers exactly these steps. Use the production `TELNYX_API_KEY` (`H='Authorization: Bearer …'`, base `https://api.telnyx.com/v2`). The Portal equivalent is noted after each step.

0. **Read-only pre-checks; stop if any differs.**
   - `GET /credential_connections/3040092094321394986`. Save the whole response as `before-credential-connection.json`. Check that `active` is `true` and `sip_uri_calling_preference` is `"internal"`. Note `outbound.outbound_voice_profile_id` as `OVP_SHARED`.
   - `GET /outbound_voice_profiles/$OVP_SHARED`. Expect `name` `pomoc-motoristom-test` and `enabled: true`.
   - `GET /call_control_applications/3040091293100279025`. Note `outbound.outbound_voice_profile_id`; expected `OVP_SHARED`, because the server dials PSTN through this app. **If it is empty, stop.** A 2 Nov note recorded "CCA shows no OVP", so first establish how production authorizes the server's PSTN legs; otherwise moving the phones' connection could be confused with the server's path.
   - `GET /outbound_voice_profiles?filter[name][contains]=dispatch-isolated-test-browser-blocked`. Use the TEST template's settings for step 1.
1. **Create the blocked profile.** `POST /outbound_voice_profiles` with `{"name":"pomoc-motoristom-webrtc-blocked","enabled":false,"traffic_type":"conversational","service_plan":"global","whitelisted_destinations":["SK"],"daily_spend_limit_enabled":true,"daily_spend_limit":"1.00"}`. Mirror the TEST template's other non-identifying fields; `enabled: false` is the part that matters. Note `data.id` as `OVP_BLOCKED`, then `GET` it and confirm `enabled: false`. (Portal: Voice → Outbound Voice Profiles → Add.)
2. **Assign it to the phones' connection only.** `PATCH /credential_connections/3040092094321394986` with `{"outbound": <the saved outbound object, with outbound_voice_profile_id = OVP_BLOCKED>}`. Send the full saved `outbound` object, because a partial nested object may reset other outbound settings. Then `GET` and diff against the saved file: only `outbound_voice_profile_id` may differ, `sip_uri_calling_preference` stays `"internal"`, and `active` stays `true`. Re-read the call control app: it must still have `OVP_SHARED`. (Portal: SIP Connections → `pomoc-motoristom-webrtc` → Outbound → Outbound Voice Profile.)
3. **Verify server outbound still works.**
   - **Outbound:** from the production web console, call the owner's mobile, check two-way audio and hangup. The operator's own leg is a server dial *to* the credential; the PSTN leg goes through the call control app.
   - **Inbound:** an inbound call to a production line rings the web phone.
   - **Colleague call:** web to web.
   - Check the runtime logs: `telnyx-http` `POST /calls` must be 2xx.
   - **Optional negative check:** a direct SDK call to a PSTN number with a production login is refused. Run it only with the owner's explicit approval, and only to his own mobile.
4. **Rollback.** `PATCH /credential_connections/3040092094321394986` with the saved `before` `outbound` object, which puts back `OVP_SHARED`, then `GET` to confirm. Keep `OVP_BLOCKED`, disabled and unused, until a later explicit cleanup (`DELETE /outbound_voice_profiles/$OVP_BLOCKED`).

This step is independent of the code release. Do it after the release smoke test passes, in the same quiet window or a separate one.

## 6. Release procedure

**Quiet window.** In the last 30 days production had 279 call sessions, none between 00:00 and 06:59 Europe/Bratislava, 2 at 23:00, and about 1 per day between 18:00 and 22:59. Proposal: start at 20:30 so the owner can make test calls. Migrations run only with 0 live calls.

**Order.**
1. **Approval.** Merge this PR into `dev` and verify TEST. Recording is off on TEST, so behaviour there is unchanged: `eu` keeps applying to unrecorded calls. The owner tests TEST and gives explicit approval for the identified `dev` SHA, the 26 migrations (with the handoff decision), the env changes, flag stages A–C and, separately, the Telnyx step.
2. **Pre-checks, T−1 day, read-only.**
   - Re-run the production ledger query: no new rows since `20261012205526`.
   - Run the env checks from part 4.
   - Run the Telnyx pre-checks from part 5, step 0, and the `sip_uri_calling_preference` read.
   - Compare the release head with the tested `dev` SHA and review the full `dev → main` diff.
3. **Backup / PITR check (Supabase Pro).** In the Dashboard → Database → Backups, confirm that the latest daily backup is from today, and whether PITR is enabled. Note the exact UTC time just before migration #1 as the restore point. If PITR is not enabled, the restore point is the last daily backup; say so to the owner before starting.
4. **Env.** Set the approved variables: towing, delivery and push switches, `TELNYX_MEDIA_BASE_URL`, and `TELNYX_API_BASE_URL` confirmed or deleted.
5. **Migrations.** Apply the 26 per part 2.3. Then quickly smoke-test the still-running `main`: open a case, an inbound or outbound call.
6. **Merge the release PR `dev → main`** (body in part 7). The required `Vercel – pomoc-motoristom-dispatching` check must pass. Never use `vercel redeploy` of an older deployment.
7. **Deploy verification.**
   - `https://dispecing.linkapomoci.sk/api/health/live` returns 200, with the deployment version whose Git SHA in the Vercel metadata is the merge commit.
   - `/api/health/ready` returns 200.
   - Run the runbook post-deploy gate: `/api/telephony/cron` on the immutable host returns 401, and the next cron run is seen within 10 minutes.
   - The runtime logs show no `api_base_url_override_ignored`.
8. **Flags**, stage A, then B, then C (part 3). Make a test call after each stage.
9. **Smoke tests.**
   - **Web:** a call to the owner's mobile (talk, hold and unhold twice, hangup), an inbound call answered on the web, a colleague call, then the `start_mode` query.
   - **Branches:** open Pobočky, hand over a test case, check the report.
   - **Partners:** the partner list and a partner case. The portal login only uses a test partner account if one exists; never contact real partners.
   - **Towing:** if enabled, the order list and a draft. The first membership is a separate reviewed insert.
   - **Operations:** open Výjazdy; check the 8 backfilled handoffs and close the stale ones if the owner chose to.
   - Check Sentry and the Vercel errors for 30 minutes.
   - **iPhone: native calling in production depends on the production iOS build** (App Store track: production App ID, VoIP certificate, Telnyx production iOS push credential, `MOTORIST_NATIVE_VOICE_ENABLED` and `MOTORIST_NATIVE_VOIP_PUSH_ENABLED`, TestFlight with a real call). It is not part of this release; the TEST app cannot call production.
10. **Telnyx security step** (part 5), if approved.
11. **TEST sync check.** `main` and `dev` point at the same content, and the release handoff names both commits.

**Rollback.**
- **Flags:** `latency_flags = '{}'`.
- **Code:** revert PR on `main`, which makes a fresh deploy. **S5 rule:** before deploying a build without S5, set `api_region: "us"` and wait until `select count(*) from public.motorist_call_sessions where ended_at is null and metadata->'start_mode'->>'apiRegion' = 'eu'` returns 0. An older build would control an EU conference through `.com`. Never redeploy an old deployment.
- **Database: forward-only.** All 26 stay. They are compatible with `main`; the manual downs in part 2.2 are for emergencies only and each needs its own authorization.
- **Telnyx:** step 4 of part 5.

**What the owner must do:** see "Čo musíš rozhodnúť alebo urobiť ty" above. In addition:
- read `TELNYX_API_BASE_URL` in the Vercel dashboard, or allow deleting it;
- confirm the PITR / backup status;
- be available for the test calls in the window;
- start the App Store track separately.

## 7. Draft body of the release PR (`dev` → `main`); do not open before approval

```markdown
## Release: dev → main (2026-11)

Owner approval: <quote the owner's message, date and time; tested dev SHA>
Tested on TEST: https://test.dispecing.linkapomoci.sk, dev <SHA>, /api/health/live <version>
Scope: PRs #420–#557 and #<this PR> (see docs/operations/release-plan-2026-11.md, part 1)

### Database (production ifpaeegaesdmljfkdvcn, applied before merge)
- 26 migrations in the order of part 2.2: <applied at UTC, by whom>
- Skipped (already present): the 7 listed in part 2.1
- motorist_telephony_start_privacy_v1() = true: <checked at>
- Restore point (PITR/backup): <UTC>

### Environment (production target)
- Set: <names only>
- TELNYX_API_BASE_URL: <confirmed default | deleted>; TELNYX_EU_API_BASE_URL unset

### After deploy
- /api/health/live: <version>, Git SHA <merge SHA>; /api/health/ready 200; cron gate 401
- latency_flags stages A/B/C: <times>; start_mode check: outbound eu, inbound us
- Smoke: web call, hold×2, inbound, colleague, Pobočky, Partneri, Výjazdy, odťahy
- Not in scope: native iPhone calling (production iOS build, App Store track); recording; S4, S6, S7b, sip_domain

### Rollback
latency_flags '{}' → revert PR (after api_region us and no live eu sessions); DB forward-only.
```
