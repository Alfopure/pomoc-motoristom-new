# Výkon aplikácie: Supabase a Vercel, 11. 9. 2026

Projekt: `ifpaeegaesdmljfkdvcn`, `pomoc-motoristom-telnyx`, Frankfurt (`eu-central-1`).
Čas živých meraní: približne 17:56–18:02 UTC / 19:56–20:02 Europe/Bratislava.
Rozsah: výhradne čítanie katalógov, štatistík a existujúcich definícií funkcií tejto kópie, kontrola zdrojového kódu a oficiálnej dokumentácie.
Nebola vykonaná migrácia, zápis používateľských dát, testovací hovor, záťažový test, reset štatistík, ukončenie DB procesu ani reštart.

## Záver, ktorý mení poradie opráv

**Databáza počas kontroly aktívne vykonáva približne 1 400 rollbackov za sekundu.** Opakované snímky ukazujú súbežné volania `motorist_save_case_atomic` a čakanie na riadkové/transakčné zámky. Živá definícia tejto funkcie vyvoláva `40001` pri bežnom konflikte revízie prípadu, hoci opakovanie s rovnakou očakávanou revíziou nemôže uspieť.

Toto je zásadnejší problém než odporúčania na indexy a pravdepodobný spoločný prispievateľ k pomalému ukladaniu, načítaniu aj telefónii používajúcej ten istý PostgREST. **Nie je dokázané, koľko sekúnd každého dnešného hovoru spôsobil.** Túto časť pôvodný audit neodhalil; samotný telephony PR ju neopravuje.

Oficiálny Supabase troubleshooting opisuje presne tento mechanizmus: vlastné `40001` môže v PostgREST 14 vyvolať nekonečné opakovanie; oprava je v PostgREST 16. Odporúča štandardnú výnimku alebo `PT409` pre HTTP 409 a osobitné ukončenie potvrdených existujúcich slučiek. **Konkrétnu živú verziu PostgREST sme nezískali**; známa je iba verzia PostgreSQL 17.6. Vysokú istotu diagnózy podporuje kombinácia kódu, aktuálnych rollbackov a opakovanej aktivity, nie údaj o nasadenej verzii. [Oficiálny incident a oprava](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b), [upstream problém](https://github.com/PostgREST/postgrest/issues/3673).

## Presné nové merania

| Snímka UTC | Commit celkovo | Rollback celkovo | DB connections |
| --- | ---: | ---: | ---: |
| 17:57:16.236503 | 4 421 811 | 107 899 905 | 25 |
| 17:57:57.649204 | 4 422 139 | 107 957 928 | 26 |
| 17:59:19.664988 | 4 422 651 | 108 074 079 | 26 |

- Prvý interval 41,412701 s: **58 023 rollbackov = 1 401,09/s**, iba 328 commitov = 7,92/s.
- Druhý interval 82,015784 s: **116 151 rollbackov = 1 416,20/s**, iba 512 commitov = 6,24/s.
- Rozdiely sú aktuálne merania dnešného večera; obsahujú aj malý príspevok auditných SELECTov medzi commitmi. Nejde o používateľské HTTP požiadavky: jeden visiaci HTTP request sa môže rozpadnúť na množstvo DB transakcií.
- 17:57:56: šesť `motorist_save_case_atomic` čaká na tuple lock, jeden na transactionid lock a jeden už je v aborted stave.
- 17:58:26: sedem backendov s týmto RPC, všetky active, päť práve čaká na zámok.
- 17:59:18: znovu rovnaká rodina RPC, dva tuple waits a štyri aborted stavy. Pool connections vzniknuté už 10. 9. samy osebe **nedokazujú**, odkedy konkrétna slučka beží.
- `motorist_cases`: približne 14 živých riadkov, ale 107 877 523 kumulatívnych index scans. To korešponduje s opakovaným `SELECT … FOR UPDATE` v save RPC.
- Bežné evidované úspešné vykonania save RPC: 38 volaní, mean 26,871 ms, max 98,06 ms. Tento údaj nesmie prekryť nespočetné neúspešné/opakované vykonania; `pg_stat_statements` nie je zoznam HTTP requestov ani end-to-end latencií.
- Historické celky `pg_stat_database` majú `stats_reset=2026-08-25`, teda ešte pred vytvorením projektu 2. 9. Neinterpretovať 108 miliónov ako „dnes“.
- `pg_stat_statements_info.stats_reset=2026-09-02 17:38:01 UTC`; všetky priemery/maximá SQL v tejto správe sú kumulatívne od tohto resetu.

Snímky sa medzi jednotlivými view môžu meniť v milisekundách. Preto napríklad prvý spoločný dotaz zachytil lock waits v `pg_stat_activity`, ale o chvíľu nulové `pg_locks`/blocked counts. Neznamená to neprítomnosť opakovanej krátkej kontencie.

## Bezpečný návrh opravy P0

1. Pripraviť kompatibilitu aplikácie: rozlišovať deterministický konflikt `PT409` a počas prechodu akceptovať starý `40001` tam, kde už existujúce funkcie vracali business konflikt. Zachovať HTTP 409, používateľovu rozpracovanú zmenu a požiadavku načítať aktuálnu revíziu. Automaticky neopakovať stale payload.
2. Pripraviť **novú explicitnú migráciu** existujúcich funkcií. Nemeniť iba historické migration súbory; už nasadené funkcie by ostali nezmenené. Každý deterministický revision/business konflikt zmeniť na `PT409`, zachovať atómovosť, revíziu, row lock a autorizačné kontroly. Nevypínať optimistic concurrency.
3. Lokálne overiť súčasné/conflicting zápisy cez skutočný PostgreSQL + PostgREST, nie iba mock RPC: jeden úspech, druhý jeden HTTP 409 v ohraničenom čase, bez slučky, bez čiastočných related writes. Skontrolovať opakované volania s rovnakou stale revíziou a mapping všetkých dotknutých aplikácií.
4. Migráciu na živú kópiu aplikovať až po výslovnom povolení používateľa podľa pravidla repozitára. Pred vykonaním overiť ID projektu a verzie funkcií.
5. Podľa čerstvých Postgres logov identifikovať presné `process_id` s opakovaným `40001`; skontrolovať ich v `pg_stat_activity` a až po povolení ukončiť **len potvrdené** slučky. Nevykonať plošné `terminate where usename=authenticator`. Reštart projektu nie je predvolená oprava a má širší dopad.
6. Oprava definície nepostačuje pre už bežiace slučky. Po cielenej náprave zmerať rollback rate, pool waits, latencie read/save/telephony znovu. Chýbajúce grafy CPU/RAM doplniť cez Supabase Reports, nezamieňať ACTIVE_HEALTHY za nulovú záťaž.
7. Až potom stanovovať prínos telephony optimalizácie a prípadnú potrebu zvýšenia compute.

`PT409` je zdokumentované mapovanie aplikovaného HTTP konfliktu, kým `40001` znamená serialization failure. [PostgREST error mapping](https://postgrest.org/en/stable/references/errors.html#raise-errors-with-http-status-codes).

### Živá inventúra nebezpečných vlastných 40001

| Existujúca živá funkcia | Počet výskytov 40001 |
| --- | ---: |
| motorist_approve_callback_target | 1 |
| motorist_call_quality_approve | 2 |
| motorist_call_transcript_correct | 1 |
| motorist_contact_callback_policy | 1 |
| motorist_notebook | 1 |
| motorist_recording_delete_call | 2 |
| motorist_recording_policy_save | 1 |
| motorist_recording_retry_call | 2 |
| motorist_save_case_atomic | 2 |
| motorist_task_workspace | 2 |
| **Spolu** | **15** |

To je inventúra živých definícií, nie iba súborov v repozitári. V repozitári sú aj ďalšie historické výskyty, napríklad pri task reminderoch; pri migrácii treba skontrolovať ich aktuálnu náhradu. Kontrolované aktívne slučky smerovali do save-case RPC; nejde o dôkaz, že všetkých desať funkcií práve generuje záťaž.

## Kapacita: čo vieme a čo nevieme

| Ukazovateľ | Zistenie | Význam |
| --- | --- | --- |
| Projekt / región | ACTIVE_HEALTHY / eu-central-1 | Služba dostupná, vhodná blízkosť Vercel fra1; nehovorí o CPU |
| PostgreSQL max_connections | 60 | Globálny limit, nie limit použiteľný celý jednou službou |
| Snímky pripojení | 25–26 | Globálny limit nie je naplnený; PostgREST pool môže byť blokovaný skôr |
| Počet authenticator connections | 16 v poslednej podrobnej snímke | Zahŕňa idle/listener aj problémové transakcie |
| Veľkosť DB | 87 633 043 B ≈ 83,57 MiB | Malá DB; nie dôvod na plošné škálovanie |
| Cache hit rate | 99,9997 % kumulatívne | Nie signál diskového cache problému |
| Deadlocks / conflicts | 0 / 0 kumulatívne | Nevylučuje krátke lock waits ani retry loop |
| Temporary bytes | ~7,31 GB kumulatívne | Významný historický údaj bez priradenia k dnešným používateľským akciám |
| track_io_timing | off | Nulové blk_read_time/write_time neznamenajú nulovú IO latenciu |
| Autovacuum | Beží; väčšie tabuľky naposledy dnes | Bez dôkazu plošne zanedbaného vacuum |
| CPU/RAM/IO util., pool queue, compute tier | Nedostupné cez dostupné read-only konektory | Neuvádzať percentá, vyčerpanie CPU ani „server nie je vyťažený“ |

Rozdiel `active_time` sumarizuje čas viacerých session vrátane čakania, **nie CPU time**. Ani podiel 26/60 nepotvrdzuje voľný PostgREST pool. Klient používa `supabase-js` HTTP API; pridanie Supavisor URL namiesto Supabase API URL by nebola platná oprava tohto existujúceho klienta. [Supabase performance](https://supabase.com/docs/guides/platform/performance), [connection pools a limity](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits).

## Ďalší problém návrhu: drahý refresh po uložení

`src/data/dispatch-repository.ts:175` načítava celú dispatch konzolu. Hlavný blok má **34 súbežných databázových dotazov** (po samostatnom vyhľadaní organizácie), vrátane dochádzky, fleet dát, kontaktných zoznamov, histórie a integračných nastavení. Potom sú ďalšie sekvenčné čítania: fleet links, external records, occupancy snapshot, Auth admin `listUsers`, capabilities a tasks.

- `loadAuthUsersById` načítava stránku až 1 000 Auth používateľov cez admin API, v krajnom prípade až 10 stránok, kvôli údajom access-management používateľov. Nejde o jeden request na každého používateľa. Tento krok prebieha aj pri načítaní bežnej konzoly.
- `src/app/api/cases/[id]/route.ts` po úspešnom uložení čaká na `loadDispatchData`; používateľ preto vidí čas write + kompletný refresh. Mnohé ďalšie mutation routy majú rovnaký vzor.
- `src/server/motorist-mutations.ts:updateCase` pred atómovým RPC vykoná sekvenčne organization → existing case → prípadne default owner → actor profile → contact → vehicle. Tieto sú prevažne read-only a časť môže ísť paralelne po splnení autorizačných závislostí.
- Vytvorenie prípadu navyše zapisuje súvisiace entity postupne; atómové save RPC je dobrá vlastnosť existujúceho update návrhu a nesmie sa kvôli rýchlosti rozbiť.
- Štrukturálna oprava: mutation vracia potvrdenú zmenenú entitu a revíziu; klient aktualizuje dotknutý stav. Nezávislé panely obnovovať cielene/coalesced. Nastavenia, dochádzku a správu prístupov načítať pri otvorení príslušnej sekcie. Každý nový response musí zachovať práva, konzistenciu a existujúce konfliktné správanie.
- Pred stanovením prínosu pridať server timing po krokoch: auth, mutation pre-read, atomic RPC, refresh. Stale-write konflikt má skončiť čitateľným HTTP 409 bez opakovania.

Tieto sekvenčné HTTP kroky + široký refresh sú **dokázané vlastnosti kódu**, ale nemáme browser→Vercel→Supabase trace ani percentily po odstránení incidentu. Nedeklarujeme, že každý krok trvá konkrétny počet sekúnd.

## SQL a advisors: nižšia priorita po odstránení incidentu

Najdrahší bežný aplikačný SELECT podľa celkového SQL času:
`motorist_call_events` podľa `organization_id`, `call_id IN (...)`, zoradený `received_at ASC`, vyberá `*`.
46 536 vykonaní, mean 42,281 ms, max 549,38 ms; dlhodobý kumulatívny profil, nie dnešný p95. Existujúci index má `(organization_id, call_id, created_at DESC)`, teda iné sort pole. Najprv obmedziť payload/stĺpce a načítanú históriu, potom zmerať plán a zvážiť index podľa reálnych filtrov/poradia. Žiadny index nebol vytvorený.

Ďalšie kumulatívne SQL priemery: call list 3,355 ms; task RPC 25,028 ms; notebook RPC 9,478 ms; lease acquire 1,219 ms a release 1,729 ms. Nezahŕňajú HTTP/pool/network/end-to-end náklady a nedokazujú rýchlu ústredňu.

Performance Advisor vrátil:

| Kategória | Počet | Priorita a obmedzenie |
| --- | ---: | --- |
| Unindexed foreign keys | 150 INFO | Posúdiť podľa dotazov/FK zmien a veľkosti tabuliek, nevytvárať všetky automaticky |
| auth_rls_initplan | 10 WARN | Dochádzka, notifications, realtime messages, task reminders; row-independent auth funkcie obaliť SELECT až po kontrole sémantiky |
| Multiple permissive policies | 25 WARN | Päť kombinácií policy/action opakovaných pre päť rolí; nie 25 samostatných kritických tabuliek |
| Unused indexes | 31 INFO | Nemažú sa na základe krátkej histórie; môžu chrániť vzácne dôležité operácie |
| Auth connection allocation | 1 INFO | Fixný limit 10; pri scale sa automaticky nezväčší. Nie dôkaz jeho aktuálneho vyčerpania |

RLS námietky nevysvetľujú priamo service-role admin čítania, ktoré RLS obchádzajú; nevypínať RLS kvôli výkonu. Remediation: [FK indexes](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys), [auth initPlan](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan), [permissive policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies), [unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index), [production Auth allocation](https://supabase.com/docs/guides/deployment/going-into-prod).

## Čo zostáva nezistené

- Historické CPU/RAM/IO a PostgREST pool utilisation grafy a presné `40001` error logy so spojením na backend PID.
- Živá PostgREST verzia; project detail uvádza PostgreSQL 17, čo je iný produkt.
- Ktoré konkrétne HTTP požiadavky spustili jednotlivé slučky a odkedy ich requesty bežia.
- Čas jednotlivých dnešných telefónnych/webových akcií po odstránení incidentu.
- Či by migrácia sama zastavila nejaké konkrétne staré requesty; podľa dodávateľa sa na to nesmie spoliehať.

Dôkazy a presné reprodukovateľné read-only SQL sú v `.context/telephony-audit/supabase-performance-evidence-2026-09-11.json`. Výstupy obsahujú katalógy, agregáty a definície funkcií, žiadne telefónne čísla, obsah prípadov, tokeny ani osobné údaje.


## Samostatne: Vercel a odozva webovej aplikácie

Vercel projekt `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, tím `alfopures-projects`. Pevné logové okno: 10. 9. 22:00 až 11. 9. 17:30 UTC (dnešok do 19:30 CEST). Dotazy sú projektové agregáty; nejde o export všetkých HTTP transakcií. Konektor počíta runtime záznamy a pri individuálnych výsledkoch vie vracať duplicitné riadky. Preto ich neoznačujeme ako presný počet unikátnych kliknutí alebo používateľov.

| Často volaná cesta | Runtime záznamy v okne |
| --- | ---: |
| /api/telephony/calls/active | 13 909 |
| /api/telephony/calls/history | 7 792 |
| /api/sms/inbox | 6 939 |
| /api/cases/location-updates | 5 353 |
| /api/telephony/monitor-invitations | 4 618 |
| /api/telephony/devices/heartbeat | 4 516 |
| /api/notes | 1 900 |
| /api/notifications | 1 836 |
| /api/tasks | 1 686 |
| /api/integrations/fleet/refresh | 509 |

V statuse je 53 613 záznamov HTTP 200, 30 HTTP 503, 29 HTTP 504 a 3 HTTP 500. Dotaz HTTP 429 v tomto okne nevrátil záznam. To **nepreukazuje voľnú CPU/RAM kapacitu** ani neprítomnosť oneskorení: aplikácia vie čakať na databázu a potom úspešne odpovedať.

Z 29 timeoutov bolo 25 na telephony webhooku, dva na reconcile a dva na active calls. Samostatne flotila: 485 HTTP 200 a **24 HTTP 503**. Päť konkrétnych vzoriek o 14:23:40, 14:24:44, 14:28:44, 14:29:39 a 14:29:44 UTC obsahuje `Supabase read timed out after 10000ms`. Toto dokazuje aj nehlasové pomalé načítanie. Týchto päť vzoriek nepreukazuje rovnakú príčinu všetkých 24 odpovedí 503.

Pri case cestách je aj jeden HTTP 500; väčšinu výsledkov však tvorí location polling. Nepodarilo sa získať úplný súbor časovaní konkrétnych PATCH/POST ukladaní. Široké individuálne dotazy a niektoré textové agregáty vypršali; táto neprítomnosť výsledku nie je nula chýb. Konektor neposkytol trvanie úspešných save requestov, active CPU, využitie RAM, cold-start čas ani históriu súbežnosti. Preto nemožno poctivo uviesť dnešný save p95 či percento preťaženia Vercelu.

### Čo je nastavené správne

`vercel.json:3` určuje `fra1`; databáza je v `eu-central-1`, teda Frankfurt. Už v prvom audite bolo fra1 potvrdené aj na deploymentoch. Umiestnenie funkcií blízko databázy zodpovedá [odporúčaniu Vercelu](https://vercel.com/docs/functions/configuring-functions/region). Nový Preview commitu `9c32383` je READY; produkčný commit v čase kontroly zostával `94c7ad5`.

Preview HTTP smoke v predchádzajúcom kole blokoval Vercel edge odpoveďou 403 s `x-vercel-mitigated: deny`, aj cez autorizovaný konektor. To je obmedzenie overenia prístupu, nie dôkaz, že aplikácia vracia chybu alebo že bežní používatelia vidia rovnaký blok. Ochrana sa nemenila ani neobchádzala.

### Čo treba opraviť v návrhu aplikácie

- **Jeden save načítava celý dispečing.** PATCH po atomickom commite znovu volá `loadDispatchData`; GET konkrétnej karty tiež načíta celý snapshot. Zdroj: `src/app/api/cases/[id]/route.ts:8–50`. Oddeliť potvrdenie zápisu od obnovy vedľajších panelov a vracať úzku kanonickú kartu s revíziou.
- **Fleet refresh znovu načíta celý dispečing aj pri preskočenej synchronizácii.** Zdroj: `src/app/api/integrations/fleet/refresh/route.ts:14–16`, `src/components/dispatch/useFleetRefresh.ts:33–48`. Vracať iba fleet DTO; klient aj dnes z odpovede preberá len fleet údaje.
- **Rovnaké oprávnenie sa overuje opakovane v jednej požiadavke.** Napríklad location-updates volá guard a potom znovu requireActor (`src/app/api/cases/location-updates/route.ts:18–25`). Opätovne použiť overený actor v rámci požiadavky, neukladať oprávnenia do globálnej neobmedzenej cache.
- **Polling rôznych panelov sa sčíta.** `DispatchConsole.tsx:1286–1327` každých 10 s načíta zmeny bez visibility guardu na intervale, hoci komentár route tvrdí, že beží len pri viditeľnej karte. Iné panely majú svoje intervaly. Zlučovať reads, používať interval až po dokončení, jitter a viditeľnosť podľa zdroja. Heartbeat a aktívne WebRTC musia zostať funkčné aj na pozadí.
- **Timeout načítania nezruší samotné požiadavky.** `dispatch-repository.ts:1910–1928` po 10 s odmietne obalový Promise, ale nezaistí zrušenie podkladových čítaní. To predlžuje nepotrebnú prácu po zlyhaní. Zaviesť reálne deadline/abort tam, kde sú podporované; zrušenie HTTP samo nepotvrdzuje zrušenie databázovej transakcie.

### Verdikt o infraštruktúre

**Zistený je aktívny databázový problém a nehospodárny návrh niektorých čítaní. Preťaženie CPU/RAM Vercelu ani potreba drahšieho plánu potvrdené nie sú.** Vercel a Supabase nemožno označiť za zdravo fungujúce iba podľa READY/ACTIVE_HEALTHY; rovnako nemožno tvrdiť, že kapacita je vyčerpaná bez systémových grafov.

Najprv odstrániť retry slučku a zmerať nové baseline, potom zmenšiť save/refresh, následne rozhodovať o kapacite. Doplniť [Vercel monitoring](https://vercel.com/docs/query/reference): duration, CPU time, memory a concurrency; na Supabase CPU/RAM/IO, PostgREST pool a lock waits. Návrh konkrétnych etáp a testov je v [ralplan pláne](../../.omx/plans/call-and-app-performance-repair.md).

Vercel evidence: `.context/telephony-audit/review-vercel-evidence.json`. Read-only kontrola neukončovala databázové procesy, nespúšťala fleet refresh, neotvárala živé hovory a nemenila žiadny deployment ani nastavenie služby.
