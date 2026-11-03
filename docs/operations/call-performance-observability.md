# Technická odozva dispečingu

Meranie technickej odozvy neobsahuje čas zvonenia, čakania na operátora, zákazníka ani dĺžku rozhovoru. Prijatie HTTP požiadavky, dokončenie serverovej operácie a nadviazanie zvuku sú samostatné výsledky.

## Zber bez databázovej tabuľky

- Existujúci `request-performance` log má schému 2: aplikačné prostredie (`test`, `production`, `development`), verziu nasadenia, presnú operáciu (`call.park`, `call.unhold`, `call.hangup`…), status, výsledok, čas a súhrn krokov. Generické merané route zahŕňajú aj prípady, SMS, dokumenty, integrácie a obnovovanie dispečingu/vozidiel. Každé dokončenie meraného handlera sa loguje bez vzorkovania. Pád procesu pred `finally` môže log vynechať.
- `phase=response` meria serverový handler. `phase=after` je následná práca a nesmie sa pripočítať k odozve ani počítať ako druhá požiadavka. Server nevidí celú cestu cez sieť ani vykreslenie stránky.
- `call-request-performance` zaznamenáva všetky podporované požiadavky ovládania hovoru v prehliadači od odoslania po načítanie tela odpovede. Má vlastné výsledky `ok`, `accepted`, `failed`, `timeout`, `cancelled`. Neobsahuje mikrofónový dialóg ani predchádzajúcu reakciu človeka.
- Prehliadač používa obmedzenú pamäťovú frontu (64 položiek, 10 minút, dávka 16), existujúce odosielanie telefónnej diagnostiky, potvrdenia ID a odstup pri zlyhaní. Neregistruje nový timer, worker ani cron a ovládanie hovoru naň nečaká. Backend použije existujúce overenie používateľa, iba zapíše JSON do runtime logov a nevytvára databázové merania. Overenie používateľa môže využiť existujúce databázové čítanie; nejde o tvrdenie, že celý HTTP endpoint nikdy nečíta DB.
- `browser_call_timing` dopĺňa `appEnvironment` a `serverBuild`. Pôvodné `environment` je identita telefónnych prostriedkov; TEST používa historickú hodnotu `development`. Na vyhodnotenie aplikácie používať `appEnvironment`.
- Browserové `answer_requested -> sdk_active` sa páruje iba v rovnakej stránke a na rovnakej telefónnej vetve s monotónnymi hodinami. `sdk_invite -> answer_requested` obsahuje reakciu človeka a nepatrí do technického času.
- Každý nový pokus o prijatie sa zachová aj na tej istej vetve. Viac pokusov je v reporte nejednoznačná vzorka, nie údaj o rýchlosti; starší klient opakované pokusy zlučoval. `sdk_active` dokazuje stav operátorského klienta, nie dokončené prepojenie so zákazníkom ani počuteľný zvuk.
- Bez telefónnych čísel, mien, obsahu hovorov, URL, tokenov či databázových dotazov v nových meraniach. ID sú určené na koreláciu a deduplikáciu. Browserové tvrdenia zostávajú pozorovaním, nie dôkazom stavu poskytovateľa.

## Vyhodnotenie

Exportovať runtime logy pre určené prostredie, nasadenie a časové okno a spustiť:

```sh
node scripts/call-performance-report.mjs runtime-export.jsonl > performance-report.json
```

Skript pracuje lokálne, bez siete a bez databázy. Podporuje JSONL z stdout, JSON pole, obálky s `message` aj export runtime logov MCP. Možno pridať viac súborov; duplicitné identifikátory zahodí. Pri exporte cez nástroj s limitom 100 riadkov rozdeliť okno a overiť úplnosť; jeho prvých 100 riadkov nie je celý deň.

Výsledok obsahuje počet vzoriek, priemer, p50/p95/p99, maximum a počty výsledkov po prostredí, nasadení, operácii a druhu merania. Úspešné HTTP odpovede a prijaté `202` majú samostatné distribúcie; `ok` neznamená potvrdený účinok na zvuk hovoru. Chyby a timeouty sa uvádzajú aj v celkových pozorovaných časoch a v samostatných `byOutcome` distribúciách; zrušenie je počítané, no nepredstiera dokončenie. Chýbajúce, záporné a nečíselné časy nie sú nula. **Známy výsledok sa počíta aj bez platného času**; `invalidDuration` vysvetľuje rozdiel oproti počtu časových vzoriek. Dlhé reálne časy sa nevyhadzujú ako odľahlé hodnoty. Pri malom počte vzoriek je p95 prakticky maximum a nepreukazuje stabilitu.

`202` nie je dôkazom zloženého hovoru. Timeout znamená dolnú hranicu čakania, nie dôkaz, že operácia neprebehla. Providerové potvrdenie príkazu tiež nie je meranie zvuku u zákazníka. Súčty DB, provider a vnorených krokov sa prekrývajú; nesčítavať ich ani ich sumu neodpočítavať od celkového času.

Staré logy bez explicitného prostredia/operácie zostávajú `unknown` alebo `call.action`; nemiešať ich so správne označenými novými meraniami. Pri `browser_call_timing` určuje aplikáciu iba `appEnvironment`; staré `environment=development` označovalo aj TEST telefónne prostriedky.

Browserový `serverBuild` je verzia prijímajúceho servera. Nové `clientBuild` pochádza z otvorenej karty, `requestBuild` z hlavičky odpovede meranej požiadavky. Report schémy 2 rozlišuje tieto verzie a neprepisuje staré/oneskorené vzorky verziou prijímača; chýbajúca verzia ostáva `unknown`. `startedAt`/`completedAt` sú pomocné browserové nástenné časy, nie základ pre výpočet latencie. Monotónne SDK udalosti sa párujú podľa stránky a vetvy aj cez nasadenie servera, ale odlišné verzie klienta sú nejednoznačné. Timeout po prijatí hlavičiek zachová už známe request ID a verziu odpovedajúceho servera.

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

Najskôr získať aspoň 30 reálnych operácií každého druhu v rozličných denných časoch ako diagnostický začiatok. Toto číslo **nie je štatistické potvrdenie p95/p99 ani SLA**; uviesť počet pokusov, straty a neúspechy a pre chvost distribúcie rozšíriť vzorku. Každú >5 s operáciu a každý timeout preskúmať aj pri dobrom priemere. Limity upraviť podľa overenej základnej úrovne; nie podľa chýbajúcich alebo selektívnych vzoriek.

## Zistenia testu 2026-10-15 12:29 UTC

Hovor na TEST release `7648b0c` skončil, bez zostávajúcich efektov; callbacky sa nakoniec spracovali. Aktivácia operátorského SDK po kliknutí bola 486 ms, automatická aktivácia ďalšej vetvy 352 ms. Serverové odpovede na podržania: 3 881,5 a 4 854,5 ms; na čakáreň 12 475,1 ms; na prevzatie 4 229,7 ms; prijatie požiadavky na zloženie 352,5 ms (`202`). Tieto hranice nezodpovedajú okamihu počutia zvuku ani dokončenia všetkých účinkov hovoru.

Opakovaná read-only kontrola presnej zákazníckej vetvy potvrdila: požiadavka parkovania vstúpila na server o 12:29:52,497 UTC, provider spustil prehrávanie o 12:29:55,427, HTTP odpoveď dobehla o 12:30:04,973 a požiadavka na prevzatie prišla o 12:30:06,404. **Začiatok prehrávania čakárne bol približne po 2,93 s, nie po 12,48 s.** Interval približne 10,98 s do prevzatia sa nepočíta ako technická latencia. Provider potvrdil opätovný bridge až o 12:30:13,827, približne 7,42 s po požiadavke na prevzatie. Rozdiely hodín servera a providera sú približné; samotné počutie na vzdialenom telefóne nebolo merané.

Požiadavka na čakáreň vykonala 45 DB transportných požiadaviek (súčet 10 723,6 ms, maximum 2 118 ms) a 7 providerových požiadaviek (súčet 1 898,4 ms). Prvý providerový príkaz začal približne 1 061 ms od vstupu do handlera. Odozva API zostala dlhá; tento čas sa prekrýva s už spusteným prehrávaním. DB metrika obaľuje `fetch` do návratu hlavičiek, nie samostatné SQL vykonávanie ani celé čítanie/parsing odpovede. Súčet nie je príspevok na kritickej ceste. Jedna neskoršia skúška bez 20-sekundovej blokácie nedokazuje, že staršia oprava odstránila jej príčinu.

Tri Sentry chyby pri tomto hovore korelujú s `lease_busy` konferenčných callbackov. Konferenčné udalosti nie sú v zozname `DEFERRED_EVENT_RANK` pre okamžité dobehnutie; niektoré dobehli až cez existujúci cron, maximum 333,6 s od prijatia. Samotný úspešný HTTP build/health ani neskorší stav `processed` tento problém nevylučuje. Oprava musí zachovať identitu konferencie, presnú telefónnu vetvu, poradie udalostí a ochranu pred duplicitnými príkazmi; nezvyšovať počet workerov ani iba potláčať Sentry.

Ďalší výkonový zásah: rozšíriť bezpečné dobehnutie konferenčných udalostí, znížiť sekvenčné DB čítania/zápisy na kritickej ceste pri parkovaní a podržaní, znovu otestovať živé ovládanie a skonfrontovať request/provider/SDK časy. Zmeny RPC alebo migrácie pripraviť ako konkrétny rozsah na schválenie pre presnú databázu.

Výsledok kritickej kontroly procesu, opravené chyby merania a podmienky ďalšieho výkonového zásahu: [kontrola merania 15. 10.](call-measurement-review-20261015.md).
