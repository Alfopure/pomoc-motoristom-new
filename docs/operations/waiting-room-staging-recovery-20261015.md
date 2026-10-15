# Neúspešná čakáreň po opakovanom teste — 15. 10. 2026

## Potvrdený incident

TEST session `1fdfdce7-d279-4e73-83f4-c4c2cadb780d`, začiatok **17:59:23 UTC / 19:59:23 Bratislava**, nasadený `dev` `5b6dd51db4fbc7a676a3d5fb5218d0a3cb91a560`. Používateľ potvrdil počuteľný zvuk a fungujúce podržanie, ale presun do čakárne sa nedokončil. Nie je to nový výsledok starého hovoru ani dôkaz funkčnosti predchádzajúcej opravy.

- PARK request `e092ef81-77f7-41c4-aeb0-46cea49d5800`: vstup **17:59:56.183**, odpoveď **18:00:12.670**, **16 487 ms, HTTP 503**.
- Získanie lease: 2 344 ms, jeden pokus; následné držanie 11 541 ms. Staging RPC prekročilo vlastný 4 000 ms limit. Pôvodná požiadavka neodoslala žiadny providerový príkaz.
- Zámer sa napriek stratenej odpovedi uložil. Obnovil sa až v následnej požiadavke na zavesenie o **18:00:16.036**. Neskorý audit `app.park` preto obsahuje časovanie a request ID tohto zavesenia: nesmie sa interpretovať ako úspešne dokončený pôvodný PARK.
- Provider journal potvrdzuje, že PARK `conference_leave` bol prvýkrát odoslaný až o **18:00:21.356**, po zavesení; provider ho odmietol, pretože konferencia už nebola aktívna. Čakacia hudba z tohto presunu sa nespustila. Odmietnutie zaniknutej konferencie je následok, nie prvotná príčina zlyhania.
- Sentry udalosť `a1bc5528fab84d069e201d7f36d4cd00` patrí tej istej TEST verzii a request ID. Presnú príčinu zachoval runtime stack: `transition_staging_unavailable` / `owned database request exceeded 4000 ms`.
- Spomalenie zasiahlo aj súbežné active-calls a webhook požiadavky. Jednotlivé DB fetch časy dosahovali približne 1–4 sekundy. Súčet 23,66 s za 15 DB fetchov PARK sa prekrýva; nie je to čas SQL ani dodatočný interval k 16,49 s handlera. Dostupné PostgreSQL/PostgREST logy v tomto okne nepotvrdili konkrétny CPU, zámkový ani kapacitný incident. Príčina infraštruktúrneho spomalenia zostáva nepreukázaná.

## Oprava

1. Pri stratenej odpovedi staging RPC pre `hold`, `unhold`, `park` sa vykoná **jedno čítanie s rozpočtom 1 s**. Neopakuje sa zápis ani zámer používateľa. Pokračovať možno iba pri zhodnom kontrakte 2, organizácii, session, token/generácii vlastníka, nevypršanom lease, presnom event ID, akcii, aktérovi a generácii uloženého zámeru. Ukončenie hovoru pokračovanie zakáže. Provider journal a všetky existujúce kontroly nahrávania zostávajú autoritou pre samotný príkaz.
2. Neúspešné alebo nejednoznačné čítanie sa nevydáva za úspech. SQL odmietnutie, strata vlastníctva a chýbajúci záväzok zachovajú chybu a pôvodnú obnoviteľnú prácu. Nový runtime údaj `control.staging_reconcile` a `staging_response_recovered` rozlišujú úspešnú obnovu.
3. **Iba `conference.floor.changed`** z presne povolenej connection po overení podpisu prechádza do runtime logu namiesto databázového claim/correlation/audit/finish a sweep. V tomto hovore bolo 15 takých udalostí; aplikácia nimi nemení hovor, nahrávanie ani účtovanie. Log zachová event ID, čas a technické identifikátory, bez telefónnych čísel a payloadu. Session hint je označený ako neoverený. Nie je to nový trvalý audit: platí retencia runtime logov a opakované doručenia sa rozlišujú podľa event ID. Udalosti nahrávania, prehrávania, pripojenia a odpojenia ostávajú v trvalom ledgeri. Staré floor udalosti už uložené v ledgeri sa ďalej normálne dospracujú.

Nepribúda tabuľka, SQL migrácia, worker, scheduler ani providerový prostriedok. Nahrávanie/prepis sa nezapínajú. Rozsah nasadenia je `dev` a stabilný TEST; produkcia sa nemení.

## Overenie a hranice

Nových 16 testov pokrýva tri ovládania po stratenej odpovedi, skutočný PostgREST transport, neuložený zámer, zámenu eventu, generácie a vlastníka, vypršanie lease, ukončenie, nedostupné čítanie, permanentnú SQL chybu a floor oznámenia vrátane izolácie/replay/zlyhania logovania. Proti presnej predchádzajúcej TEST verzii zlyhalo šesť pozitívnych regresných prípadov; desať ochranných prípadov prešlo. Na oprave prešlo všetkých 16 aj pôvodné súvisiace testy (78 spolu).

Tieto testy dokazujú konkrétnu obnovu a odstránenie opakovanej databázovej práce, **nie čas reálneho zvuku na novom nasadení**. Staging, vlastníctvo a journal musia naďalej bezpečne fungovať; dostupnosť DB nemožno nahradiť slepým odoslaním telefonického príkazu. Po nasadení overiť canonical TEST SHA/health a zopakovať skutočný PARK. Porovnať pôvodný request ID, providerový journal a začiatok hudby, bez započítania ľudského čakania alebo časov neskoršej obnovy inou požiadavkou.
