# Zjednotený TEST balík — 6. 10. 2026

Cieľom je jeden overiteľný TEST pre bezpečnostné opravy, obnovu telefónie a diagnostiku. Produkcia čaká na samostatné schválenie po hlasovej skúške. Východisko: `main` 85769fd2, `dev` be4348f0; kanonický TEST je https://test.dispecing.linkapomoci.sk.

## Zaradené a už hotové práce

| Práca | Rozhodnutie |
| --- | --- |
| Telnyx Telephony Error; Nahrávanie overenie pripravenosti | Existujúce opravy sú na `dev`. Zachovať nahrávaciu cestu a overiť ju novým živým hovorom. Historický neúspešný hold nie je akceptačným testom aktuálnej verzie. |
| PR #406 a #407 | Na `dev` už sú zdieľané pollingy histórie hovoru a optimalizované čítanie TEST pôvodu. Sú súčasťou následného spoločného prebratia. |
| PR #391 | Prevzatá aktualizácia Next/Vitest a kompatibilných závislostí; navyše source-map-js 1.2.2. Telefónne SDK zostáva 2.27.10. |
| PR #301 | Zámer opravy prenesený do aktuálneho kódu: oba replay výbery vylúčia cudzie connections pred limitom. Zachované TEST vlastníctvo, prázdne/null ID, poradie a časové limity. |
| Bezpečnosť histórie B2 | Výhradne TEST, dve tabuľky histórie: klientské zápisy zakázané; org-scoped čítanie a autorizované serverové zápisy zachované. Presný SQL majiteľ výslovne schválil v tejto konverzácii 6. 10. 2026. Podrobnosti a rollback: [databázové overenie](security-history-client-writes.md). |
| Google Maps v Preview | Serverová cesta aj browser build blokujú živé Maps v pracovnom Preview. Zo scope dvoch existujúcich Maps premenných dispatch projektu odstránený iba `preview`; `production` a hodnoty zachované. Samostatné TEST premenné zostali na svojom mieste. Staré už vytvorené deploymenty si ponechávajú pôvodnú konfiguráciu. |
| Sonda a cron | Výsledok zahŕňa všetky podúlohy; zistený zdravotný problém zostáva degraded aj pri potlačenom opakovanom emaile. Log rozlišuje vykonanie, zdravie, diagnostiku a trvanie úloh. Timeout metriky zachytia aj RPC caller deadline; nemenia retry ani limity. UI odlišuje oneskorenú údržbu od kvóty. |
| PR #374 / #397 | Prihlásenie a fleet permissions už zahrnuté; B1 aj task-history RPC v oboch DB overené. Neaplikovať znovu. |
| PR #297 / #287 | Zastaraný zákaz dnešnej TEST domény nepreberať; prevádzkové dokumenty opravené podľa aktuálneho stavu. Staré AI práce a retired DB nie sú súčasťou tohto balíka. |

## Zistenia auditu a hranice dôkazov

- TEST mal pri historickej skúške hold/hangup/snapshot/webhook časové limity. V príslušných runtime logoch dominovalo čakanie na DB; neskorší pokojný snapshot nevylučuje špičku. Nie je doložené všeobecné zlyhávanie hold na produkcii ani trvalé preťaženie CPU.
- Vo vzorke produkčných HTTP požiadaviek tvorili aktívne hovory, živé prípady a heartbeat približne 81 %. Upload diagnostiky približne 0,12 %. Sonda nebola dominantným zdrojom počtu požiadaviek; tieto počty nie sú meraním CPU alebo ceny.
- TEST dead-letter backlog a alerty vyžadujú triáž; historické kopírované provider ID sa nesmú hromadne replayovať. Tento balík ich nemaže ani automaticky neuzatvára incidenty.
- `/api/health/ready` overuje dostupnosť aplikácie a ľahký DB dotaz. Neoveruje audio, nahrávku ani plný priebeh cronu. Trvalý externý alarm chýbajúceho celého cronu a dnešná konfigurácia Sentry zostávajú samostatným overením; aktuálny Sentry readback nebol prístupný. Existujúci päťminútový cron zostáva jediný.
- Otvorené závislosti: vývojový `braces` high a SDK `uuid` moderate. Dosiahnuteľný útok na aplikačnej ceste nebol preukázaný; nálezy nie sú ignorované.

## Overenie a spoločná akceptácia

Výsledný PR a nasadený `dev` SHA sa zaznamenajú po úspešnom build gate a overení kanonickej domény. Lokálne overenie: produkčné zostavenie oboch aplikácií, typová kontrola a cielený ESLint prešli; 59 Node testov prešlo (1 skipped), samostatné testovanie 17/17, browser regresie 29/29, PostgreSQL kontrakty 25/25 a hosted B2 read-only kontroly 16/16. Verejné výstupy lokálneho Preview buildu neobsahujú skúšobný zdedený Maps kľúč (83 súborov); úvodná stránka, manifest, live a tri PNG ikony vracajú HTTP 200. Vitest celý balík sa opakuje na zmrazenom strome a znova tvorí povinný Vercel gate. Syntetické browser testy nenahrádzajú živý mediálny tok.

Počas dohodnutej skúšky nemeníme TEST verziu. Na TEST doméne preveríme:

1. Prihlásenie, konzolu a monitor; potom prichádzajúci aj odchádzajúci skúšobný hovor a obojstranný zvuk.
2. Podržanie a návrat aspoň trikrát, prepnutie karty/pozadie, prepojenie a korektné zavesenie.
3. Hovor bez nahrávania aj s nahrávaním; dokončenie, dostupnosť a prehratie novej nahrávky.
4. Zhodu UI s históriou a serverovými/webhook logmi vrátane časov operácií a zaťaženia počas skúšky.

Až potom majiteľ schváli presne identifikovaný produkčný rozsah. Produkčná B2 migrácia vyžaduje vlastné výslovné schválenie pre `ifpaeegaesdmljfkdvcn`; TEST súhlas ho nenahrádza.
