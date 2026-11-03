# RALPLAN-DR / ADR: spoločná aplikácia

Dátum 26. 10. 2026. Deliberate režim: PII/práva, budúce migrácie, súbežné prideľovanie a finančná proveniencia. Stav sekvenčného review: `spolocna-aplikacia-20261026.md` a lifecycle. Tento verzovaný kontrakt sám neudeľuje povolenie vykonávania. PRD a test-spec majú rovnaký suffix `spolocna-aplikacia-20261026`.

## Päť princípov

1. Jedna pracovná aplikácia a identita používateľa; oprávnenia sa rozhodujú na serveri pre každý zdroj.
2. Jeden výkon má jednu identitu a jedného vlastníka stavu; konzultácia, asistencia, prenájmový zdroj a financie sa nezlievajú.
3. Práca a návrat prežijú prípad aj dočasný prístup; token nie je pracovný záznam.
4. Neistota zostáva viditeľná: neznámy interval/obsadenosť/odozva nie je úspech alebo voľná kapacita; queued pridelenie zodpovednosti nie je potvrdená kapacita.
5. Existujúce moduly, viac pridelení vo fronte a mobilný kontrakt sa rozšíria najmenším potrebným krokom; priebežné TEST dôkazy namiesto prepisu či novej infraštruktúry.

## Tri hlavné rozhodovacie faktory

- Preukázateľne oddelené partner/field dáta a účtovanie pri spoločnom UI.
- Súbežný odťah/pristavenie a neskorší návrat bez duplicitného výkonu či straty práce.
- Doručiteľný Eros pilot a Final CD tok nad existujúcim kódom, bez nového natívneho buildu; januárový cieľ potvrdiť, nie odvodiť termín implementácie.

## Férové alternatívy

| Možnosť | Výhody | Náklady / nevýhody | Hodnotenie |
| --- | --- | --- | --- |
| A — spoločný shell a federované existujúce moduly, minimum spoločných väzieb | Najmenší počiatočný zásah; towing a handoff zostanú úplne samostatné; jednoduchší skorý Eros rollout. Prístupové hranice možno zachovať bez centrálneho execution modelu. | Každý modul musí osobitne riešiť cyklus, konflikty a dedupe. Návrat odťahovkou potrebuje explicitnú dvojicu a dôsledné report rules. Jedna karta na prípad stále vyžaduje handoff migráciu. Vyššie riziko dvoch assignment autorít. | Životaschopná pri dôsledných cross-module transakčných adaptéroch; menší prvý PR, viac opakovanej integračnej práce v celom požadovanom rozsahu. |
| B — spoločná operation identity a lokálny use-cycle, typovaní existujúci vlastníci vykonania | Jedno miesto pre scope, väzby a konflikt zdrojov; towing si ponechá financie/doklady; handoff sa stane prístupovým adaptérom. Podporuje paralelné úkony a dlhý návrat bez prepisu fakturácie. | Potrebuje explicitný migračný/backfill/index/RPC prechod a kompatibilitu legacy mobilu. Hrozí vytvorenie druhej autority, ak implementácia neudrží owner-only zápisy. | **Vybraná.** Vyhovuje celému ucelenému zadaniu, ale zavedie iba identitu/väzby a logistické doplnenie, nie všeobecný workflow engine. |
| C — úplne jednotná nová zákazka pre towing aj logistiku | Jednotné state machine a budúce reporting/plánovanie; menej adaptérov v cieľovej podobe. | Presun existujúcich finančných/prístupových/mobile kontraktov a vyššie regresné riziko; dlhší kritický reťazec pred pilotom. | Technicky možná, nevhodná pre súčasný brownfield rozsah a princíp 5; ponechať iba ako budúcu voľbu pri preukázanej potrebe. |

Architect i1 potvrdil silnú antitézu: A vie spoločné transakčné pravidlá zabezpečiť aj bez centrálnej operation entity a towing už má stabilnú identitu. Syntéza ponecháva B striktne tenkou identitou nad federovanými ownermi; nepridáva editovateľné kópie assignment/workStatus/financií. A sa nezamieta pre neschopnosť splniť zadanie; prehráva na počte duplicitných cross-module pravidiel a riziku zachovania dvoch assignment autorít. B neznamená prepis všetkých domén. Ak Architect preukáže, že B zavádza viac stavov než eliminuje, preferovať úpravu B na striktne identity-only index pred prechodom na C.

## ADR-01: identita, stav a kompatibilita

**Rozhodnutie:** B. Každá operation je unikátny vykázateľný zámer s konkrétnym ownerom. Towing order je autorita towing vykonania a všetkých towing financií; logistický owner je autorita pristavenia/návratu/presunu. Zoznam a partner report čítajú odvodené projekcie. Collection odťahovkou je jedna operation s towing ownerom a cycle kontextom. Nedovoliť generic complete pre towing owner.

**Rozhrania:** cookie scope resolver → autorizovaný modulový server → transakčný command/owner adapter → audit/receipt; existujúci mobile handoff command používa kompatibilný adapter na ten istý logistický owner. Nové web-only stavy majú oddelené DTO. `vehicle_use_cycle` má lokálnu identitu, explicitné auto a iba voliteľný potvrdený externý rental ID. Partner parent/child prípady a settlement sú samostatné väzby, nie premenované towing ceny.

**Migrácia:** existujúci unique active case index (`20261001110000_external_case_handoff.sql:15`) aj issue guard (`20261009100000_external_case_handoff_expansion.sql:115`) sa musia meniť spolu s dátami a RPC. Nové aktívne granty sú operation-scoped, starý unscoped issue má samostatný legacy slot. Zachovať staré tokeny/receipts a wire DTO; nové typy filtrovať mimo starého API. Legacy revoke/expire nesmie po pripojení k operation znamenať zrušenie práce. Atomic rollout preverí starý aj nový caller počas spoločnej TEST DB prevádzky. Neopravovať históriu spätným odhadom nájmov.

**Dôsledky:** vznikne nový identity/cycle kontrakt a lokálne race/security fixtures; potrebné additive DB zmeny. Zostanú dva doménové state machines, čo je zámerné, ale nie dva vlastníci jedného výkonu. Nie všetka nová logistika bude v starom mobile; existujúce kompatibilné pristavenie bude. Legacy complete zachová fyzické dokončenie a strict receipt; nový evidence-completeness výsledok na rovnakom ownerovi ukáže „vykonané, dôkazy čakajú“. Dôkazy doplní oprávnený webový aktér so skutočnou provenance, nie druhým complete ani oživením starého grantu. Kancelária nesmie vydávať svoje doplnenie za vodičovo potvrdenie; unknown zostáva unknown. Toto rieši napätie A22/A23 bez zmeny starého command payloadu (`src/lib/mobile-api.ts:453`, `src/server/mobile/delivery.ts:44`). Webová práca pokračuje bez fyzického iPhone pilotu. Rollback zastaví nové zápisy/feature, nedropuje históriu ani nevracia starý unique index nad nekompatibilné dáta.

## ADR-02: partner a terénne prístupy

Partneri používajú existujúci auth účet s novým partner-scoped membership a explicitnými case shares; nevytvárať im dispečerský profil. Deliver-only použije existujúce field membership/capability cez cookie resolver. Vlastné webové priestory neťahajú dispatch dataset. Správa člena, invited → active → disabled, membership version a revokácia share sa kontrolujú pri každom route/export/file čítaní. Partner je minimálne read-only, servisné prijatie potvrdzuje kancelária dôkazom. Dokumenty cez autentifikovaný proxy; signed URL nedáva okamžitú revokáciu. Odoslaný email zostáva mimo možnosti odvolania. P1/P4 výslovne rozšíria invite/accept/expiry/reinvite, password-completed/reset, callback/destination a deactivate vetvy; dnešné `src/app/api/auth/password-completed/route.ts:9`, `src/server/access-management.ts:643`, `:675` a `src/components/auth/SetPasswordForm.tsx:141` poznajú dispatch/towing. Nový alebo existujúci field účet môže mať partner membership bez fake profilu; query parameter nedáva práva. Čiastočný Auth provisioning sa obnovuje podľa invitation intent provenance podľa bezpečného towing vzoru (`src/server/towing/memberships.ts:25`), nie slepým pripojením podľa emailu alebo novým účtom.

## ADR-03: konflikty, nezistený stav a doručovanie

Queued assignment je zodpovednosť/viditeľnosť; päť úloh bez fiktívnych intervalov je prípustných (S4:112–114,186–194). Atómové konflikty vznikajú pri potvrdení kapacity alebo fyzickom štarte, nie pri samotnom zaradení do frontu. Neznámy koniec fyzickej práce nesľubuje ďalšiu kapacitu. Historické startedAt source=assignment nie je actual start (`supabase/migrations/20261013120000_towing_work_orders.sql:321`). Zamykajú sa relevantné zdroje v stabilnom poradí: vodič/vykonávacie vozidlo, odlišné od prepravovaného subject a cycle car. Čerstvé voľné SWHouse je gate nového použitia náhradného auta/readiness; collection existujúceho prenajatého cyklu je dovolená. Nejde o externú rezerváciu ani write-back. Stará/chýbajúca obsadenosť zostáva unknown. Migračný manifest pokryje dispatcher handoff, public token, member handoff, app assignment aj towing command, nielen nové API.

Case/link, operation/assignment, audit a send intent sa zapíšu atómovo, email/PDF sieťové kroky mimo transakcie. Retry ID je stabilné a viazané na obsah. Provider unknown sa automaticky nevydáva za neodoslané; opätovný send vyžaduje overenie alebo nový vedomý auditovaný intent. Nové workers, listenery, scheduler ani CI nie sú potrebné. Existujúci jediný `/api/telephony/cron` sa týmto jadrom nemení.

## Pre-mortem: tri konkrétne zlyhania

| Scenár po nasadení | Príčina a prevencia | Skorý signál / test / release stop |
| --- | --- | --- |
| Final CD otvorí internú poznámku iného partnera cez ID PDF; vyradený vodič číta staré kontakty. | Zdieľaný shell načítal dispatch DTO alebo service-role download obišiel scope. Min DTO, explicitné share/member checks v serveri/RPC, private file proxy, no-store; nevychádzať z JWT-only role. | Negatívne IDOR testy pre list/detail/export/file, starý JWT po revokácii. Akýkoľvek únik = stop P1/P4/P7; vypnúť vstup a opraviť oprávnenia, neprehlásiť hide-menu za fix. |
| Pondelkové pristavenie vyprší a piatkový návrat zmizne; dve dispečerky pridelia to isté auto. | Expirácia zrušila pracovnú entitu alebo konflikty zostali iba v UI. Trvalý cycle/operation, owner adapter, unknown interval policy, atomic assignment a resource locks. | A15 + dve DB sessions + legacy migration fixture; unresolved_return a conflict audit. Strata návratu alebo dvojitá kolidujúca confirmed kapacita/štart = stop P2/P5/P7. |
| Eros má dvakrát tržbu za jeden odvoz a Final CD dostane dve PDF alebo nesprávne fakturovateľnú konzultáciu. | Dvojitý towing/logistics výkon, email retry po timeout a zamenený payer/settlement. Distinct operation ID, jeden execution owner, oddelená partner dohoda, immutable document/send intent a outcome unknown. | A02/A04/A10/A13/A17/A21, replay before/after commit, duplicate joins report test. Rozpor vykázanej sumy/doručenia = stop príslušného finančného/exportného vydania. |

## Rozšírená validácia a poradie

- Unit: scope/type/state mapping, owner routing, normalizácia intervalov, snapshot/price provenance, unknown výsledky a strict mobile DTO.
- Integration: skutočný izolovaný PostgreSQL, súbežné sessions, grants/RLS/EXECUTE, data/index/RPC transition, starý klient, audit/intent atomicita a privátne súbory.
- E2E: samostatný dispatcher/deliver-only/driver/billing/partner účet, široký/úzky web, celý A24, a samostatne A06; mocked scenáre sa nedeklarujú ako live provider dôkaz.
- Observability: PII-free eventy s command/revision a resource ID, auth/conflict/replay/provider_unknown/stale_occupancy/unresolved_return; dôkaz presného TEST SHA a integrácie.

P0 → P1 → P2 → súbežne P3(Eros) a P4(Final CD); P5 po P2/P3, P6 po P4 a dodanom vzore; P7 po všetkých core častiach. Rovnaké spoločné DTO/migrácie má jeden executor; root vlastní integráciu, test-engineer test contract, verifier čerstvý TEST dôkaz. Žiadne generické worker roly/terminal Team. Budúce explicitne zadané `$ultragoal` je možná realizačná lane po požadovanom handoffe, týmto plánom sa nespúšťa.

## Oficiálna opora a obmedzenia

Root pri tejto úlohe úspešne obnovil Supabase skills na upstream `c9be0e931b7930f7d02126d04774d904c381e7d7`; Planner prečítal tri aktuálne SKILL.md. Researcher preveril Next 16.3.8, React 19.2.4, supabase-js 2.106.1 a @supabase/ssr 0.10.3. Detailná evidencia je `.omx/context/spolocna-aplikacia-official-evidence-20261026.md`.

- Service role obchádza RLS; current membership/resource checks a projekcie treba na každom serverovom vstupe. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Next data security](https://nextjs.org/docs/app/guides/data-security); lokálny Next guide `node_modules/next/dist/docs/01-app/02-guides/data-security.md`.
- Grants, RLS a RPC EXECUTE sú rozdielne hranice. Preferovať invoker; existujúci server-only privileged vzor musí mať obmedzené execute, fixný search_path a aktuálne explicitné scope checks. Nové app objekty patria do application-owned schema, nie auth/storage/realtime. [Securing Data API](https://supabase.com/docs/guides/api/securing-your-api), [Database functions](https://supabase.com/docs/guides/database/functions), [Managed schema restrictions](https://supabase.com/changelog/34270-restricting-access-on-auth-storage-and-realtime-schemas-on-april-21-2025).
- Private buckets a signed URL majú odlišnú revokáciu; proxy je vybraná aplikačná záruka next-request revoke. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Downloads](https://supabase.com/docs/guides/storage/serving/downloads).
- Krátka atómová transakcia a stabilná unikátna identita sú podklad návrhu, nie dôkaz exactly-once emailu. [Transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html), [Explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html), [ON CONFLICT](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT).

[Changelog](https://supabase.com/changelog.md) bol skontrolovaný. Live PostgreSQL verzie neboli zistené; [15.19/17.11 notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes) ani [TLS notice](https://supabase.com/changelog/cbc-tls-ciphers-deprecated) neoprávňujú upgrade/infraštruktúrnu zmenu. Pri RLS sa nepoužíva nepresné tvrdenie, že vynechané WITH CHECK automaticky dovoľuje reassignment: dokumentácia uvádza dedenie USING. Nové policies majú explicitné testované podmienky.

## Kontrola a ďalší handoff

Architect má napadnúť najmä operation-owner hranicu, kompatibilný legacy prechod, partner scope lifecycle a životnosť návratu; uviesť najsilnejšiu obhajobu A, reálny tradeoff a syntézu. Critic až následne overí principles/options, acceptance, tri pre-mortems a reálnosť testov/release gate. Nevybavené pripomienky sa vracajú Plannerovi, nie implementátorovi. Lokálne review artefakty sú lifecycle dôkaz, nie host-issued security authority. Chýbajúci OMX runtime nemení pravdivosť tohto rozlíšenia.

Stop plánovania po sekvenčných review výsledkoch a zapísaní artefaktov; pri neschválení iterovať najviac podľa ralplan pravidiel. Produkcia, SQL, provideri a goal execution zostávajú nevykonané. Testovaciu alebo produkčnú úspešnosť tento dokument netvrdí.
