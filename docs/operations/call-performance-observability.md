# Technická odozva dispečingu

Meranie technickej odozvy neobsahuje čas zvonenia, čakania na operátora, zákazníka ani dĺžku rozhovoru. Prijatie HTTP požiadavky, dokončenie serverovej operácie a nadviazanie zvuku sú samostatné výsledky.

## Zber bez databázovej tabuľky

- Existujúci `request-performance` log má schému 2: aplikačné prostredie (`test`, `production`, `development`), verziu nasadenia, presnú operáciu (`call.park`, `call.unhold`, `call.hangup`…), status, výsledok, čas a súhrn krokov. Generické merané route zahŕňajú aj prípady, SMS, dokumenty, integrácie a obnovovanie dispečingu/vozidiel. Každé dokončenie meraného handlera sa loguje bez vzorkovania. Pád procesu pred `finally` môže log vynechať.
- `phase=response` meria serverový handler. `phase=after` je následná práca a nesmie sa pripočítať k odozve ani počítať ako druhá požiadavka. Server nevidí celú cestu cez sieť ani vykreslenie stránky.
- `call-request-performance` zaznamenáva všetky podporované požiadavky ovládania hovoru v prehliadači od odoslania po načítanie tela odpovede. Má vlastné výsledky `ok`, `accepted`, `failed`, `timeout`, `cancelled`. Neobsahuje mikrofónový dialóg ani predchádzajúcu reakciu človeka.
- Prehliadač používa obmedzenú pamäťovú frontu (64 položiek, 10 minút, dávka 16), existujúce odosielanie telefónnej diagnostiky, potvrdenia ID a odstup pri zlyhaní. Neregistruje nový timer, worker ani cron a ovládanie hovoru naň nečaká. Backend použije existujúce overenie používateľa, iba zapíše JSON do runtime logov a nevytvára databázové merania. Overenie používateľa môže využiť existujúce databázové čítanie; nejde o tvrdenie, že celý HTTP endpoint nikdy nečíta DB.
- `browser_call_timing` dopĺňa `appEnvironment` a `serverBuild`. Pôvodné `environment` je identita telefónnych prostriedkov; TEST používa historickú hodnotu `development`. Na vyhodnotenie aplikácie používať `appEnvironment`.
- Browserové `answer_requested -> sdk_active` sa páruje iba v rovnakej stránke a na rovnakej telefónnej vetve s monotónnymi hodinami. `sdk_invite -> answer_requested` obsahuje reakciu človeka a nepatrí do technického času.
- Bez telefónnych čísel, mien, obsahu hovorov, URL, tokenov či databázových dotazov v nových meraniach. ID sú určené na koreláciu a deduplikáciu. Browserové tvrdenia zostávajú pozorovaním, nie dôkazom stavu poskytovateľa.

## Vyhodnotenie

Exportovať runtime logy pre určené prostredie, nasadenie a časové okno a spustiť:

```sh
node scripts/call-performance-report.mjs runtime-export.jsonl > performance-report.json
```

Skript pracuje lokálne, bez siete a bez databázy. Podporuje JSONL z stdout, JSON pole, obálky s `message` aj export runtime logov MCP. Možno pridať viac súborov; duplicitné identifikátory zahodí. Pri exporte cez nástroj s limitom 100 riadkov rozdeliť okno a overiť úplnosť; jeho prvých 100 riadkov nie je celý deň.

Výsledok obsahuje počet vzoriek, priemer, p50/p95/p99, maximum a počty výsledkov po prostredí, nasadení, operácii a druhu merania. Úspešné operácie a prijaté `202` majú samostatné distribúcie. Chyby a timeouty sa uvádzajú aj v celkových pozorovaných časoch; zrušenie je počítané, no nepredstiera dokončenie. Chýbajúce, záporné a nečíselné časy nie sú nula. Dlhé reálne časy sa nevyhadzujú ako odľahlé hodnoty. Pri malom počte vzoriek je p95 prakticky maximum a nepreukazuje stabilitu.

`202` nie je dôkazom zloženého hovoru. Timeout znamená dolnú hranicu čakania, nie dôkaz, že operácia neprebehla. Providerové potvrdenie príkazu tiež nie je meranie zvuku u zákazníka. Súčty DB, provider a vnorených krokov sa prekrývajú; nesčítavať ich ani ich sumu neodpočítavať od celkového času.

Staré logy bez explicitného prostredia/operácie zostávajú `unknown` alebo `call.action`; nemiešať ich so správne označenými novými meraniami. Browserový `serverBuild` je verzia prijímajúceho servera, nie zaručená verzia otvorenej karty.

## Uchovanie a spoľahlivosť

Runtime log je existujúce úložisko Vercelu, nie trvalý archív. Tento release nevytvára externý účet, log drain, nový scheduler ani nepredlžuje retenciu. Na týždenné/mesačné porovnanie treba export pred uplynutím dostupnej retencie alebo schválený externý log drain s oddeleným TEST/production a nastavenou retenciou. Exportér môže agregovať do objektového úložiska; aplikačná Supabase na to nie je potrebná.

Vydané/uložené/odmietnuté logy, prevádzkové HTTP počty a kvóty sinku treba sledovať spolu. `sampleRate=1` znamená bez úmyselného vzorkovania, nie garantované 100 % doručenie. Zatvorená karta, offline stav a ukončená funkcia môžu vzorky stratiť. Počet nahlásených zahodení fronty nie je úplný a pri strate ACK môže opakované doručenie jeho súčet zvýšiť. Sentry chybové udalosti ani stará DB diagnostika s preferenciou pomalých udalostí nie sú nezaujatou distribúciou odozvy.

## Navrhované kontrolné ciele — zatiaľ nie schválené SLA

| Meranie | Kandidát na p95 | Podmienka |
|---|---:|---|
| Manuálne/automatické prijatie -> aktívne SDK | 1 s | Každý režim samostatne, bez čakania na človeka |
| Odpoveď servera na jednoduchú operáciu | 2 s | Chyby aj prijatia 202 osobitne |
| Odozva požiadavky v prehliadači | 2,5 s | Vrátane siete a tela odpovede |
| Ukončenie hovoru | Samostatné meranie | 202 nesmie byť zamieňané s ukončením média |

Vyhodnotiť minimálne 30 reálnych operácií každého druhu pred prijatím cieľa, ideálne v rozličných denných časoch. Každú >5 s operáciu a každý timeout preskúmať aj pri dobrom priemere. Limity upraviť podľa overenej základnej úrovne; nie podľa chýbajúcich alebo selektívnych vzoriek.

## Zistenia testu 2026-10-15 12:29 UTC

Hovor na TEST release `7648b0c` skončil, bez zostávajúcich efektov; callbacky sa nakoniec spracovali. SDK prijatie po kliknutí bolo 486 ms, automatické prijatie ďalšej vetvy 352 ms. Serverové podržania: 3 881,5 a 4 854,5 ms; čakáreň 12 475,1 ms; prevzatie 4 229,7 ms; prijatie požiadavky na zloženie 352,5 ms (`202`). To nepotvrdzuje splnenie navrhovaného štandardu.

Čakáreň vykonala 45 DB požiadaviek (súčet 10 723,6 ms, maximum 2 118 ms) a 7 providerových požiadaviek (súčet 1 898,4 ms). Prvý providerový príkaz začal približne 1 061 ms od vstupu do handlera. Reálna odozva je stále príliš dlhá aj po odstránení starších 20-sekundových blokácií. Nejde o čakanie na človeka.

Tri Sentry chyby pri tomto hovore korelujú s `lease_busy` konferenčných callbackov. Konferenčné udalosti nie sú v zozname `DEFERRED_EVENT_RANK` pre okamžité dobehnutie; niektoré dobehli až cez existujúci cron, maximum 333,6 s od prijatia. Samotný úspešný HTTP build/health ani neskorší stav `processed` tento problém nevylučuje. Oprava musí zachovať identitu konferencie, presnú telefónnu vetvu, poradie udalostí a ochranu pred duplicitnými príkazmi; nezvyšovať počet workerov ani iba potláčať Sentry.

Ďalší výkonový zásah: rozšíriť bezpečné dobehnutie konferenčných udalostí, znížiť sekvenčné DB čítania/zápisy na kritickej ceste pri parkovaní a podržaní, znovu otestovať živé ovládanie a skonfrontovať request/provider/SDK časy. Zmeny RPC alebo migrácie pripraviť ako konkrétny rozsah na schválenie pre presnú databázu.
