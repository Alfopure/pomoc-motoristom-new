# Produkčné vydanie — plán (návrh, nevykonané)

Zdroj na TEST: `dev` `02b5538` (28. 10. 2026, overené `/api/health/live`).

Stav 28. 10. 2026. Produkcia `main` = `7ff4247` (12. 10.), produkčná DB `ifpaeegaesdmljfkdvcn` končí migráciou `line_workspace`. `dev` = TEST. Nič z tohto plánu sa nevykoná bez výslovného schválenia majiteľa vrátane presného SQL.

## Schválené poradie (majiteľ 28. 10. 2026)

Samotné telefonické opravy sa nedajú bezpečne oddeliť (nadväzujú na iné zmeny v `dev`), preto majiteľ zvolil: **vydať naraz presne to, čo beží na TEST, po jeho teste** (web + iPhone build 26 podľa návodu). Schválené sú aj migrácie (bod 3) a zapnutie modulov (bod 4); nahrávanie a AI ostávajú vypnuté (bod 5); App Store 1.0 hneď potom (bod 6).

**Telnyx webhooky sú už presmerované** na `dispecing.linkapomoci.sk` (28. 10. 17:59 UTC), záloha `dispecing-test.vercel.app`.

## Migrácie (v tomto poradí) (v tomto poradí, každá v transakcii, zápis do `schema_migrations`)

1. `20261012183000_case_owner_assignment`
2. `20261013120000_towing_work_orders`
3. `20261020210000_mobile_push_devices`
4. `20261022100000_mobile_delivery_handoffs`
5. `20261022180000_mobile_delivery_background`
6. `20261026190404_partner_consultations_and_portal`
7. `20261026190600_shared_dispatch_operations`
8. `20261026192423_operations_workspace_customer_contact`
9. `20261026192813_towing_cycle_return_owner`
10. `20261026195725_operations_actor_locking_auth`
11. `20261026201554_partner_report_scoped_execution`
12. `20261026211724_operation_access_links`
13. `20261026211731_operations_returns_damage_evidence`
14. `20261026211759_atomic_case_partner_origin`
15. `20261026213118_partner_settlement_audit`
16. `20261028100000_branch_work_groups`
17. `20261028110000_branch_work_groups_review`
18. `20261028120000_partner_case_followups`
19. `20261028130000_mobile_work_push`
20. `20261028140000_operation_positions`
21. `20261028150000_operation_background_tracking`
22. `20261028170000_rental_draft_source`

Pred aplikovaním: záloha / PITR bod, porovnanie definícií funkcií, ktoré migrácie nahrádzajú (`create or replace`), so stavom produkcie; skúška celej sady na kópii schémy (lokálny PostgreSQL so všetkými migráciami už prechádza).

## Produkčné premenné (Vercel `pomoc-motoristom-dispatching`, iba Production)

Na TEST sú, na produkcii chýbajú (rozhodnúť a nastaviť vedome):
- moduly: `MOTORIST_TOWING_ENABLED`, `MOBILE_DELIVERY_ENABLED`, `MOBILE_PUSH_ENABLED`
- push web: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (nové produkčné kľúče, nie z TEST)
- integrácie: `SWHOUSE_*` (produkčný SWHouse, nie TEST), `COMMANDER_*`, `WEBDISPECINK_*`, `DATABAZA_VOZIDIEL_API_KEY` — overiť, či ich produkcia nemá cez zdieľané premenné tímu
- nahrávanie/AI: `RECORDING_PROCESSING_ENABLED`, `RECORDINGS_SYNC_SECRET`, `TELNYX_RECORDING_DOWNLOAD_HOSTS`, `OPENAI_*`, `AI_*` — iba ak majiteľ chce tieto funkcie na produkcii
- ostatné TEST-only (`MOTORIST_TEST_*`, `MOTORIST_NATIVE_*_TEST_*`, `DIAGNOSTICS_TEST_*`) na produkciu **nedávať**

## Konfigurácia providera

- Telnyx webhooky: hotové (pozri vyššie). `TELNYX_MEDIA_BASE_URL` na produkcii presunúť na `https://dispecing.linkapomoci.sk/telephony` pri vydaní.

## Vrátenie

- Kód: nový deploy predchádzajúceho `main` commitu cez revert PR (nie `vercel redeploy`).
- Databáza: migrácie sú pridávajúce; pri vrátení kódu ostávajú. Nové prepínače vypnúť.

## Overenie po vydaní

Health live/ready so správnym SHA; cron bez chýb; prihlásenie dispečera; prípad, hovor; Pobočky/Partneri/Výjazdy načítanie bez 5xx; push zariadenie sa registruje (po App Store 1.0).
