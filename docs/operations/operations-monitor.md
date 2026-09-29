# Monitor prevádzky

Manažér alebo administrátor otvorí **Monitor prevádzky** v používateľskom menu dispečingu. Cesta je `/monitor`, otvára sa v novej karte a nevlastní browser telefón. V detaile hovoru je samostatne načítaná diagnostická časová os. Tlačidlo **Nahlásiť problém** potvrdí prijatie až po trvalom uložení konkrétneho ID.

Monitor ukazuje lokálne kontroly aplikácie/databázy, incidenty, odozvy dôležitých úkonov a počty/trvania hovorov. Odkazy na Vercel a Supabase rešpektujú produkčný alebo TEST projekt. Technické stacky patria do Sentry; nezávislý externý uptime je osobitná služba. Nenakonfigurované integrácie sú takto označené. Existujúci Healthchecks.io v BI je pasívny heartbeat a nie je kontrolou tohto webu.

## Význam údajov

- Lokálne health kontroly bežia iba pri viditeľnom monitore: live najviac raz za minútu, ready raz za päť minút. Po 2/10 minútach je výsledok zastaraný. Ich úspech nepotvrdzuje fungovanie prihlásenia ani zvuku.
- Časovanie meria výslovné používateľské úkony. API merania zahŕňajú sieť a načítanie odpovede; uloženie formulára zahŕňa aj obnovu dát. Nie je to meranie zvuku alebo vykreslenia každého pixelu. Úspešné HTTP 200 s neúplným potvrdením zápisu má neznámy výsledok; konflikt, validácia a uloženie so zlyhaným refreshom sú oddelené.
- Výber 5 % vzorky pre odozvy prebehne pred výsledkom. Percentily sa zobrazia až od 100 vzoriek rovnakého typu a sample rate; pri preukázanej strate/kvóte sú skryté. Nevzorkované chyby/pomalé udalosti nevstupujú do tohto menovateľa. Neznáme pokrytie nie je záruka úplnosti.
- Počty hovorov pochádzajú z existujúcich session bez vzorkovania. Trvanie od prijatia po koniec obsahuje podržanie a konzultácie. Neznáme a aktívne trvania nie sú nula. Smery sú oddelené.
- Zákazník na linke po strate operátora dokazuje prerušenie operátorskej účasti, nie príčinu. Classifier kontroluje konkrétnu vetvu/profil a časové dôkazy úmyselného ukončenia. Historický dozor nie je dôvod na potlačenie neskoršieho incidentu. Neskoré dôkazy sa prehodnocujú počas 24 hodín. Príčina zostáva neznáma.
- Monotónne časy možno porovnávať iba v rámci rovnakého page ID. Pri unmount sa posledné UUID kontextu hovoru držia najviac 5 sekúnd pre následnú React boundary; ide o časovú súvislosť, nie dokázanú príčinu. Normálne ukončenie alebo zmena účtu tento kontext zmaže.

## Limity a súkromie

Žiadne telefónne čísla, mená, správy, poznámky, request/response body, URL query, provider payload, SDP/ICE, zvuk alebo replay. Povolené sú iba enumy, UUID, verzie, časy a počítadlá. Interné API overí prihláseného aktéra, organizáciu, origin a väzby; odlišný účet nemôže odoslať starú frontu pod svojou identitou. Neoveriteľné historické zariadenie stratí väzbu, nie základnú chybovú udalosť.

Fronta: 200 udalostí / najviac 128 KiB, TTL 24 h, asynchrónny IndexedDB zápis, dávka 16 udalostí / 16 KiB / 1 KiB na udalosť. Bežný flush 30 s, kritický najviac 5 s, spolu so Sentry najviac 12 pokusov/min/stránka. Retry 5/15/60/300 s s jitterom a Retry-After. Prázdna fronta neposiela request. Diagnostika nečaká v kritickej ceste obchodného úkonu.

Databázová transakcia serializuje admission a ACK: 20 dávok/min/profil, 300/min/org, 20 000 udalostí/deň (15 000 bežných + 5 000 kritická rezerva). Účtovaný strop 128 MiB/org zahŕňa rezervu indexov: 4 KiB/event, 8 KiB/incident, 1 KiB/counter, samostatné časti 112/12/4 MiB. Detail sa drží 14 dní, incident 90 dní; skutočné pokrytie môže byť kratšie. Neprítomnosť udalostí nedokazuje bezchybnú prevádzku.

Fyzický budget sa nastavuje osobitne pre projekt podľa voľnej kapacity a rezervy. Stráž kontroluje diagnostické tabuľky/indexy každých päť minút; po desiatich minútach bez kontroly zastaví ingest. Nie je to okamžitá garancia veľkosti a DELETE nemusí uvoľniť fyzický disk bez vacuum. Sledujte bloat a retention backlog. Classifier má cursor, jeho časový sklz sa zatiaľ nemeria osobitným počítadlom.

## Konfigurácia a nasadenie

| Premenná | Predvolené správanie |
| --- | --- |
| `DIAGNOSTICS_ENABLED` | Zber vypnutý, pokiaľ nie je `true`; žiadne diagnostické RPC. |
| `DIAGNOSTICS_PHYSICAL_BUDGET_BYTES` | `0`, ingest blokovaný. Nastaviť až po overení kapacity. |
| `DIAGNOSTICS_PANEL_ENABLED` | Panel zapnutý; `false` vypne autorizovanú stránku aj read/status API. |
| `DIAGNOSTICS_CLASSIFIER_ENABLED` | Vypnutý; `true` povolí internú klasifikáciu. |
| `NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN` | Neprítomný: žiadny externý error SDK transport. Samostatný TEST projekt. |
| `DIAGNOSTICS_SENTRY_DASHBOARD_URL` | Voliteľný HTTPS dashboard na `sentry.io`, bez query/tokenov. |
| `DIAGNOSTICS_UPTIME_DASHBOARD_URL` | Voliteľný HTTPS dashboard Better Stack/UptimeRobot, bez query/tokenov. |

1. Pracovná vetva z aktuálneho `dev`, kompletná test/typecheck/build brána a Vercel Preview. Overiť efektívny Supabase projekt. Migrácia `20261008130000_operations_diagnostics.sql` sa aplikuje iba na výslovne autorizovaný cieľ; žiadny seed ani zmena existujúcich hovorov.
2. TEST je `nzpnqdstvkfncflgqlny`, produkcia `ifpaeegaesdmljfkdvcn`. Pre každý cieľ znovu zmerať kapacitu vrátane rezervy. Nový fyzický budget musí byť ≤ min(128 MiB, 20 % zostávajúcej kapacity po rezerve). Nenastavovať podľa samotnej veľkosti JSON.
3. Po migrácii zapnúť zber a stanovený budget. Existujúci cron inicializuje stráž; dovtedy ingest odpovedá 503 bez ACK. Overiť hosted PostgREST funkčné statement timeouty, manager/dispatcher/cross-org oprávnenia, durable ACK a poruchu zberača. Čítacie SQL má 1 s statement timeout, RPC transport 1,5 s, API odpoveď 2 s; už rozbehnutý auth request sa race timeoutom automaticky neruší. Upload body má vlastný 1 s timeout/cancel.
4. Vercel spúšťa cron iba v produkcii. TEST Preview preto vyžaduje počas autorizovaného testovacieho okna manuálny beh existujúcej diagnostickej údržby; po 10 min bez neho sa zber správne zablokuje. Neinštalovať ďalší scheduler a nespúšťať celý telephony cron na TESTe len kvôli diagnostike. [Vercel Cron](https://vercel.com/docs/cron-jobs).
5. PR do `dev`, overenie `https://test.dispecing.linkapomoci.sk` a jeho generovaného branch aliasu. Potom samostatný release PR `dev` → `main` a čerstvý build produkcie `https://dispecing.linkapomoci.sk`. Nikdy redeploy staršieho deploymentu.
6. Externý uptime: nezávislé HTTP kontroly produkčnej custom domény `/api/health/live` každých 60 s a `/api/health/ready` každých 5 min; dve zlyhania, jeden alarm a jedno obnovenie, konkrétny schválený príjemca. Žiadna nová služba ani upozornenie sa týmto dokumentom neaktivuje.
7. Sentry: [privátne source maps](diagnostics-source-maps.md). Overiť skutočný minifikovaný stack presného deploynutého buildu, privátnosť `.map` súborov a sanitizovaný wire payload. Pripravený adaptér sám neznamená funkčnú technickú diagnostiku.

Heuristické upozornenia zostávajú počas sedemdňového pilotu vypnuté; nový automatický email/SMS sender nie je súčasťou tejto implementácie. Existujúce prevádzkové alerty sa nemenia. Po pilote skontrolovať objem, straty, p95, falošné incidenty a DB bloat, až potom rozhodnúť o aktivácii upozornení a príjemcovi.

## Vypnutie pri problémoch

Zastaviť nové zápisy pomocou `DIAGNOSTICS_ENABLED=false`, samostatne panel alebo classifier ich prepínačmi; použiť čerstvý build správnej vetvy. Fyzický budget `0` je ďalšia serverová poistka pri najbližšej údržbe. Neodstraňovať pôvodné call/session/leg údaje. Samotné vypnutie monitoringu nerieši existujúcu závislosť životnosti telefónu od React stromu.

## Reprodukovateľné overenie

`pnpm exec vitest run`, `pnpm typecheck`, `pnpm build`; UI fixture `E2E_BASE_URL=https://monitor.test pnpm exec playwright test e2e/operations-monitor.spec.ts`. Fixture mockuje všetky API a nikdy nevytvára reálny hovor.

`tests/postgres/diagnostics-contract.py` používa výhradne lokálny syntetický PostgreSQL a voliteľný lokálny PostgREST. Pred spustením prečítať jeho nastavenie; nikdy nezameniť spojenie za hosted databázu. Pokrýva concurrency, kvóty, RLS, retenciu, indexy, call klasifikáciu a timeout/rollback cez HTTP. Merania fake API a lokálneho prehliadača nie sú dôkazom výkonu živého zvuku alebo hosted databázy.
