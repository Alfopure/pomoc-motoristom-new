# Test-spec: spoločná webová aplikácia

Review/handoff stav: `spolocna-aplikacia-20261026.md` a lifecycle. Plán testovania pre PRD `prd-spolocna-aplikacia-20261026.md`, nie vykonané testy. Každý výsledok má PASS/FAIL/NEOVERENÉ, Git SHA, prostredie, scenár a dôkaz. Zelený mocked browser test nie je live integrácia. Kritériá A01–A24 sú zachované z `docs/plans/spolocna-aplikacia-2026-10-26.md`.

## Jednotkové a serverové testy

| Skupina / PR | Povinné scenáre a očakávanie | Existujúci základ / nové testy |
| --- | --- | --- |
| Partner a prípady P0/P4 | Známa line ID → partner ID v rovnakej organizácii; voľné meno bez mapovania neautorizuje. Predvoľba sa dá opraviť. Parent/child platitelia ostanú oddelení; retry nezaloží druhé dieťa; nový vedomý zámer je dovolený. A01/A03. | `src/server/directory-service.test.ts`, `src/server/case-atomic-save.test.ts`, `src/server/case-mutation-replay.test.ts`; nové `src/server/partners/cases.test.ts`. |
| Membership P1/P4 | Cookie user + aktuálne členstvo/version/scope; disabled, iný partner/org/branch/assignee, podvrhnuté user_metadata a user header. Overiť list, detail, mutation, export a private file. Žiadny dispatch dataset/telephony pre deliver-only/partnera. A05/A08. | `src/components/auth/login-destination.test.ts`, `src/server/towing/routes.test.ts`, `src/server/towing/memberships.test.ts`; nové `src/server/workspace-auth.test.ts`, partner route tests. |
| Operation owner P2/P3 | Towing work state sa číta z order; žiadny druhý generic complete. Dve rôzne operácie na rovnakom prípade sa nemenia navzájom; prepojené towing vyzdvihnutie sa počíta raz. A10/A14/A17. | `src/server/web-case-handoff.test.ts`, `src/server/towing/workspace.test.ts`; nové `src/server/operations/service.test.ts`. |
| Mobilný kontrakt P2 | Snapshot presného legacy DTO a enumov; assign → accept → en_route → arrived → complete funguje cez staré routes, viditeľný ten istý výkon na webe. Nový web collection/transfer neunikne do starého parsera. Otestovať počet kariet na limite/nad limitom bez neplatného payloadu. Existujúce limity sa nesmú potichu zvýšiť. A22. | `src/server/mobile/{delivery,case-handoff}.ts` a existujúci `case-handoff.test.ts`; existujúci `src/server/mobile/delivery.test.ts`, relevantné `mobile/src/handoff/*.test.ts`. |
| Intervaly a cyklus P2/P5 | [od,do) susedné úkony nie sú konflikt; prekrytie potvrdenej kapacity auta/vodiča je konflikt; päť queued úloh bez vymyslených časov je dovolených. Neznámy koniec fyzickej práce blokuje sľub ďalšej kapacity, nie ďalšie queued pridelenie. UTC/Bratislava vrátane prechodu letného času. Closed case/expired grant nezruší cycle/return. Predĺženie mení rovnaký návrat. A09/A15. | Nové `src/domain/operations.test.ts`, `src/server/operations/cycles.test.ts`. |
| Readiness a odovzdanie P5 | Rented/stale/unknown SWHouse, nesprávne pairing, interný blok alebo nevykonaná kontrola → nie ready na nové použitie. Collection rented auta v overenom cykle prejde; nové vydanie toho istého auta nie. Vykonávacia odťahovka a klientovo poškodené auto nepodliehajú rental free gate. `rentTo` voľného auta neplánuje automaticky nový nájom. Missing km/fuel ≠ 0; telemetria potrebuje zdroj/čas/potvrdenie; damage nie je incident report. A16/A18/A23. | `src/lib/fleet-live.test.ts`, `src/server/mobile/tools-fleet-read.test.ts`; nové operations inspection tests. |
| Eros a peniaze P3 | Minimum pri draft/vyslaní, povinné doplnenie pri submit. AWP record-only nedáva assignment ani push. Cena, dokument snapshot, externá faktúra, čiastočná úhrada, korekcia a odovzdanie hotovosti majú oddelené udalosti. A11–A13. | `src/domain/towing/money.test.ts`, `src/server/towing/{routes,delivery}.test.ts`, `src/components/towing/offline/offline.test.ts`. |
| Partnerský výstup P4 | Preview hash sa zhoduje s publikovanou verziou/príjemcom. Provider accepted ≠ inbox delivery, unknown sa neprezlečie na failed/retry success. Jeden partner/tri hovory/dva výkony → 1 konzultácia, 3 hovory, 2 výkony. Referral/sent ≠ service arrival. Žiadna implicitná sadzba. A02/A04/A21. | Nové `src/server/partners/{documents,settlement,reports}.test.ts`; email outcome existujúci serverový vzor. |
| Incident P6 | Form token iba pre jeden incident report; zlá/expired/revoked verzia odmietnutá, duplicate submit vracia pôvodný výsledok. Povinné polia a PDF podľa schváleného vzoru. Žiadne case/internal či fleet-damage dáta cez token. A06. | Nové `src/server/incident-reports/*.test.ts`, vzor `src/server/case-pdf.test.ts`. |

## Izolovaný PostgreSQL a Storage kontrakt

Rozšíriť existujúce lokálne fixtures `tests/postgres/mobile-delivery-handoffs.py` a `tests/postgres/towing-work-orders.py`; nové `tests/postgres/shared-operations.py` a `tests/postgres/partner-workspace.py` používajú rovnako izolovaný test server. Nevytvárať novú infraštruktúru aplikácie. Ani jeden skript nesmie načítať remote DSN, aplikačné kľúče alebo pracovať s produkčným/test snapshotom.

1. **Atómové zmeny:** chyba medzi založením child/link, operation/owner, assignment/reservation a audit/intent nezanechá polovicu zápisu. Lost ACK po commite + rovnaký command ID vracia pôvodné ID/revíziu. Rovnaký ID s iným payloadom odmietnuť, aj pri súbehu.
2. **Dve sessions:** rovnaký úkon dvom vodičom; rovnaký vodič alebo vykonávacie auto pri potvrdení kapacity/štarte dvoch prekrývajúcich sa úkonov (dve queued pridelenia sú prípustné); dva návraty toho istého cyklu; dvojitá konverzia/logistický towing owner. Práve jeden prípustný výsledok, druhý doménový konflikt. Bez deadlocku pri opačnom poradí výberu zdrojov; po chybe možno bezpečne zopakovať rovnaký command.
3. **Migration matrix:** legacy aktívny/expired/closed handoff, existujúca towing order s/bez sourceCaseId, chýbajúca schema, čiastočný deploy starý frontend/nový backend. Backfill vytvorí najviac jednu mapu na owner, nemení pôvodné command receipts/tokeny. Index a RPC po prechode dovoľujú paralelné operations, ale legacy unscoped slot iba jeden. Web-only návraty sa neobjavia v starých odpovediach. Žiadna domnelá rental identity z historického obsadenia.
4. **Grants a RLS:** explicitná tabuľka callerov pre anon/authenticated/service_role, table SELECT/INSERT/UPDATE/DELETE a RPC EXECUTE. Bezprávny caller nevyvolá privilegovanú funkciu; serverový service-role caller s chybnou organizáciou/user/member/version/share je tiež odmietnutý. Fixed search_path, žiadne implicitné PUBLIC EXECUTE na nových privileged RPC. Prípadný view nesmie obísť scope. RLS a grants sú samostatné kontroly.
5. **Revokácia:** vyradenie membership, prepridelenie, odvolanie share, zmena publikovanej verzie a uzavretie field prístupu; ďalší read/write/download odmietnutý aj s pôvodným JWT. Obsah skoršieho emailu nemožno odvolať, UI to nesmie sľubovať. Súbory nepoužívajú dlhé signed URL ako náhradu revokácie.
6. **Súbory:** private upload intent → MIME/size/hash overenie → finalize; cudzie attachment ID/operation/org odmietnuté, nedokončený upload nie je povinná fotografia. Incident token nemôže prečítať inú prílohu. Žiadne verejné bucket policy. Podporované Storage API, žiadne vlastné tabuľky v managed schemas.
7. **Finančná proveniencia:** towing correction/reversal neprepisuje original receipt; partner settlement sa nemení towing platbou. AWP count bez double assignment. Dve spojené projekcie jedného operation ID sa vo výkone počítajú raz; konzultácie sa nepočítajú podľa počtu joins.
8. **Životnosť:** uzavretie/archivácia prípadu a expirácia grantu ponechajú návrat dostupný oprávnenej kancelárii; nepovolené hard-delete s otvorenou prácou odmietnuť. Po prevzatí klientského auta ešte nie je doručenie, po doručení ešte nie je readiness.

## Doplnené regresné kontrakty R1–R3

- **Front/kapacita:** päť Erosových queued úloh na jedného vodiča bez planned/actual časov; vidí a prijme ich ako zodpovednosť. Dve DB sessions potvrdzujú prekrývajúcu kapacitu alebo fyzický štart: iba jeden úspech. Backfill `startedAt` s `startSource=assignment` nevytvorí actual interval. Collection aktívne prenajatého cyklu je dovolená, nové vydanie blokované. Rozlíšiť rovnakú odťahovku, klientsky subject a cycle car; gate overiť cez existujúci towing command aj nový operation adapter.
- **Onboarding:** nový partner bez `motorist_profiles`; existujúci field účet dostane partner membership a oba povolené moduly. Invite accept, expired/reinvite generation, password-completed, reset a callback smerujú podľa aktuálneho serverového scope. Podvrhnutý query modul nedá právo. Revoke pozvania/member počas callbacku a stará session po revoke neprejdú. Fault injection po Auth vytvorení pred membership commitom, po commite pred ACK a retry toho istého intentu nevytvoria duplicitný účet/členstvo ani neprisvoja neoverený účet. Overiť aj bezpečné zachovanie už existujúceho field účtu pri zlyhaní partner provisioningu. Rozšíriť `src/server/towing/memberships.test.ts`, `src/components/auth/login-destination.test.ts` `src/app/auth/callback/route.test.ts`, `src/app/api/auth/forgot-password/route.test.ts` a nové module-aware invite/reset/password-completed testy pri `src/server/access-management.ts`, `src/app/api/auth/password-completed/route.ts`, `src/components/auth/SetPasswordForm.tsx`.
- **Legacy dokončenie a dôkazy:** starý accept → en_route → arrived → complete bez nových polí vráti pôvodný receipt/DTO a zruší prístup ku kontaktnej karte podľa existujúceho kontraktu. Ten istý operation ID na webe hlási „Vykonané · dôkazy čakajú“. Oprávnené doplnenie s vlastným command/revision uloží skutočného autora/zdroj/čas; kancelária nedokáže podvrhnúť vodičovo potvrdenie. Null zostáva null, prípustná výnimka ostáva viditeľná. Doplnenie nevytvorí druhú completion udalosť/výkon, nezmení towing financie a neobnoví expired/revoked mobilný grant. Overiť denial starého vykonávateľa a samostatný readiness gate. Existujúce `src/server/mobile/delivery.test.ts`, web operations evidence testy a browser scenár A22 → A23.

## Browser a end-to-end

Existujúce synthetic harnessy: `e2e/web-delivery-handoff.spec.ts`, `e2e/towing-ui.spec.ts`, `e2e/towing-offline-ui.spec.ts`. Pridať bounded testy `e2e/shared-operations.spec.ts`, `e2e/partner-workspace.spec.ts`, `e2e/incident-report.spec.ts`. Rozšíriť existujúcu konfiguráciu s explicitným testMatch pre synthetic testy; nepridávať nový CI systém ani dependency.

| Test | Overenie |
| --- | --- |
| A01–A06/A21 | Final CD predvoľba, samostatný child prípad, immutable partner output, partner portal/IDOR, oddelený settlement a správny incident dokument. |
| A07–A09 | Prepínanie modulov počas syntetického hovoru a neuloženého draftu, reload deep-linku, samostatný deliver-only login, serverová denial odpoveď, intervalový konflikt. Sledovať network payload, nie iba skryté menu. |
| A10–A14 | Dvojklik/lost response pri Zadať odťah, AWP bez notifikácie, celý Eros tok, paralelný odťah/pristavenie rôznym vodičom, neovplyvnený starý towing offline retry. |
| A15–A18/A23 | Preplánovanie návratu, expirácie a zatvorený case; vlastné vrátenie bez jazdy; výmena dvoch áut; towing collection jedným výkonom; km/fuel unknown/confirmed, fotky a damage. |
| A22 | Starý mobilný parser/HTTP kontrakt pracuje bez nového buildu s kompatibilným pristavením; po complete samostatný evidenčný backlog A23 na rovnakom operation ID, bez druhého dokončenia. Physical iPhone GPS/lock-screen je samostatný otvorený pilot, nie nahradený webovým testom. |
| A24 | Jeden identifikovaný TEST SHA: partner call/context → konzultácia → asistencia → dva súbežné výkony → odovzdania → partner web → oddelené zúčtovanie/faktúra/platba → neskorší odvoz/kontrola. Zaznamenať všetky case/operation/order/cycle IDs a kontrolné počty. |

Desktop + 360px web, klávesnica/focus návrat, čitateľné štítky, žiadne gesture-only akcie. Chyba načítania sa líši od prázdneho zoznamu; sieťový timeout zachová draft a command ID. Fotky/prílohy neverejné aj pri priamom otvorení URL. Overiť návrat history/back/forward a nezrušenie aktívneho dispatch hostu.

## Príkazy a predpoklady pri implementácii

Príkazy nižšie sa v tomto planning turne nespúšťajú. Overiť aktuálny package manager/lockfile a lokálne návody Next pred editovaním. `pnpm build:production` je mimo tohto web scope, pretože zahŕňa worker build.

```sh
pnpm exec vitest run src/server/web-case-handoff.test.ts src/server/mobile/case-handoff.test.ts src/server/towing/routes.test.ts src/server/towing/workspace.test.ts src/components/auth/login-destination.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright test --config playwright.towing.config.ts
pnpm exec playwright test e2e/web-delivery-handoff.spec.ts
python3 tests/postgres/towing-work-orders.py
python3 tests/postgres/mobile-delivery-handoffs.py
```

K cielenému vitestu pridať nové testy z príslušného PR. Nové PostgreSQL skripty spustiť po ich vzniku rovnakým `python3 tests/postgres/<name>.py`. Towing fixture potrebuje lokálne `initdb`, `pg_ctl`, `psql` a oprávnenie na dočasný server; handoff fixture potrebuje `psycopg` a izolovaný loopback PostgreSQL na 127.0.0.1:55432 (viď hlavičky skriptov). Ak chýbajú, použiť existujúce repo prostredie na ich spustenie; nikdy nahradiť remote DB ani ohlásiť PASS. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` možno použiť v towing config podľa existujúceho README. Pred synthetic browser behom build pre CSS. Default `playwright.config.ts` môže štartovať lokálny dev server s bypassom; toto **nie je** dôkaz auth bezpečnosti. Real auth/negative testy sa robia bez bypassu na identifikovanom TEST deployi so syntetickými účtami a schválenými fixture dátami.

## Observability a prevádzkový dôkaz

Audit každého relevantného write: actor/member version, organization, case/operation/cycle ID, command ID, from/to revision, typ udalosti, outcome. Do logov nepatria kontakty, tokeny, obsah PDF, fotografie ani provider tajomstvá. Použiť existujúci logging/Sentry vzor, nie nového collectora.

Pri fault-injection overiť, že sú rozlíšiteľné authorization_denied, revision_conflict, resource_conflict, command_replay, unconfirmed_write, provider_unknown, stale_occupancy a unresolved_return. Denné UI počítadlá a export musia používať tie isté scoped filtre ako zoznam. TEST checkpoint zachytí počet nevyriešených návratov, dedupe replay, delivery status a prípadné owner-reference orphan zistenia. Žiadna citlivá vysokokardinalitná metrika s menom/telefónom; korelačné ID len v oprávnenom audite.

Po každom dev merge: overiť deployment Git SHA, `/api/health/live` a readiness na canonical TEST; následne zmenené správanie. Feature flag rollback skúsiť s otvoreným návratom: nové vytváranie vypnuté, existujúce údaje a oprávnená história zachované. Email acceptance sa overuje oddelene od skutočného inbox receipt; telefónia iba cez oprávnené TEST resources. Disabled integration = NEOVERENÉ, nie PASS. Žiadny automatický kontakt kopírovaných zákazníkov.

## Acceptance a stop

Core: A01–A18 a A21–A24 PASS. A19/rozšírený A20 zostávajú neskoršia etapa; ich základné bezpečnostné hranice (práva, oddelená SWHouse pravda, konflikty) sú testované už teraz. Chýbajúci vzor nehody blokuje A06 a plný Final CD acceptance, nie samostatne označený Eros pilot. Omega export nie je PASS bez importu vzorky v potvrdenej verzii, ručná fakturácia môže byť prijatá samostatne.

Stop release: akýkoľvek cudzí partner/field prístup, neoverené migračné prekrytie starého klienta, dvojité financie/výkon, strata návratu, nepravdivá voľná kapacita alebo chýbajúca projektová SQL/produkčná autorizácia. Odovzdanie obsahuje TEST URL, dev SHA, kroky majiteľa a presné otvorené body. Úspešný planning review nie je vykonanie týchto testov.
