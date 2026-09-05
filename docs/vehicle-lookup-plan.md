# Dohľadanie slovenského vozidla — realizačný plán

Revízia 2, 5. 9. 2026. Používateľ autorizoval implementáciu, testovanie aj produkčný release. Nadväzuje na výskumný RALPLAN; toto je konkrétny rozsah prvého nasadenia, nie prísľub všetkých údajov pre každé auto.

## Rozhodnutie a hranice

Princípy: správna identita pred množstvom polí; zdroj a dátum pri údajoch; technická chyba nikdy neznamená negatívny stav; návrh nemení uložený formulár; organizácie a súbežný vývoj zostávajú oddelené.

Porovnané možnosti: (A) zmluvné technické API, zatiaľ bez skúšobného účtu a živých výsledkov; (B) už overený SKP formulár, doplnený HAKA a podmieneným VIN dekódovaním. Pre prvý release volíme B. A má lepší integračný kontrakt, ale dnes by výsledkom bola nefunkčná integrácia. Platené služby, solvery a nová VPS infraštruktúra sa nezapínajú.

- SKP: natívny formulár cez prehliadač spustený v jednom autorizovanom Vercel requeste. EČV alebo VIN, dátum overenia v Europe/Bratislava. VIN, značka, model a farba iba ak ich zdroj uvádza; poisťovňa a PZP výslovne ku dňu overenia. Bez odvodzovania konca PZP.
- HAKA: priamy HTTP GET verejného vyhľadávania, presné overenie identifikátora v článku. Záznam je hlásenie HAKA, nie potvrdenie aktuálneho policajného pátrania. Prázdny výsledok znamená iba nenájdené hlásenie. Kontakty osôb sa nespracúvajú do výsledku.
- STKonline: 4/4 reálne priame HTTP GET bez cookies s bežnými HTML hlavičkami. VIN/EČV, značka/model, farba, palivo, vykonanie a termín TK/EK, iba voľne dostupné polia. Vyžadovať presnú identitu a vykonanú kontrolu pred prevzatím jej termínu; Ford vrátil termín bez vykonanej kontroly, ten sa nepoužije. Údaje nemajú garantovanú okamžitú aktualizáciu. Paywall, prvá registrácia a platené reporty sa nečítajú.
- NHTSA vPIC: VIN dekódovanie; čiastočné výsledky ostávajú označené. Modelový rok sa nikdy nemapuje na rok výroby, hmotnostná trieda na presné kg a SuggestedVIN na VIN.
- S-EKA alebo ďalší zdroj sa doplní len po získaní skutočného výsledku a teste identity/schémy.
- eZnamka a overenie.digital: overený formulár, ale nedokončené CAPTCHA. Ponúknuť otvorenie zdroja na ručné overenie. Nezobrazovať falošnú platnosť, prvú registráciu ani technické parametre.

Výskum preukázal SKP na Tesle, Škode, Forde a následne BMW a MAN. Testovacie EČV/VIN používateľa ani kontakty z verejných článkov nepatria do git fixtures.

## Implementácia

1. Samostatná worktree a vetva z aktuálneho `origin/dev`; zachovať rozrobenú fleet vetvu. Komunikovať dotyky spoločných súborov, pred merge načítať nový dev a vyriešiť kolízie.
2. Zdieľaný typovaný model, normalizácia EČV/VIN, úspech/čiastočné dáta/viac kandidátov/challenge/nedostupnosť. Kontrolovať aj druhý už vyplnený identifikátor. Nezlučovať dva VIN podľa rovnakej EČV.
3. `POST /api/vehicles/lookup`: session + explicitné dispečerské roly + same-origin, obmedzený vstup, žiadny klientom zvolený host/URL/organizácia. Provider requesty majú timeout a neprebiehajú po ukončení odpovede. Cieľ do 15 s pri bežnom výsledku; browser hard timeout 25 s, celkový limit 50 s a Vercel maxDuration 60 s, aby aj cold start skončil kontrolovanou chybou.
4. Nová aditívna migrácia len v Supabase tejto kópie: organizačná cache a transakčná koordinácia, najviac jeden externý lookup naraz na organizáciu, 5/min na používateľa a 30/min na organizáciu. Lease 55 s, kontrola vlastníka pri dokončení, žiadne platené retry. DB nedostupná → žiadne nekontrolované externé odoslanie. RLS; koordináciu smie volať iba service role, profil sa znova overuje v organizácii. Zdieľané zapnutie zdrojov a 15-minútový circuit po troch technických zlyhaniach SKP.
5. Cache úspechu najviac 15 minút, neúspechu najviac minútu; kľúč obsahuje organizáciu, kind, country, identifikátor a bratislavský deň. Vypršaná cache sa nikdy nevydáva ako aktuálny stav. Pri dopyte obmedzené čistenie starých cache riadkov; prevádzkový runbook obsahuje manuálne čistenie neaktívnych organizácií. Nevymýšľať garantovanú retenčnú lehotu bez povoleného scheduleru. Nepridávať cron. Nejde o centrálny register ani kanonický globálny profil vozidla.
6. Výsledok obsahuje serverom podpísaný snapshot viazaný na organizáciu. Pri prijatí ho server overí a uloží k existujúcim `vehicle_details` zásahu alebo fleet `metadata`, oddelene od aktuálnej cache. Podpis nepreukazuje absolútnu pravdivosť zdroja; zabraňuje podvrhnutiu jeho proveniencie klientom. Identifikátory musia stále súhlasiť. Manuálne polia zostávajú používateľskými hodnotami.
7. Jeden zdieľaný ovládač pri EČV/VIN vo flotile, novej aj existujúcej karte. Pred prijatím iba návrh. Doplnenie prázdnych polí až tlačidlom; existujúce hodnoty sa neprepisujú. Modelový rok a ostatné doplnkové zistenia viditeľné v prehľade. Poisťovňa PZP nemení platcu ani asistenčku. Fleet dátumy sa vyplnia len z explicitných overených dátumov zdroja.
8. Pri zmene identity alebo zatvorení zahodiť návrh a ignorovať oneskorené odpovede; tlačidlá nespúšťajú autosave, až prijatie mení draft. Pôvodné Commander predvyplnenie musí kontrolovať všetkých kandidátov a známy VIN; nejasná krajina/identita nesmie automaticky prideliť prvé vozidlo.

Spresnenia po Architect/Critic: STKonline úspech zostane v odpovedi aj pri SKP challenge/timeout. Celý čiastočný výsledok používa konzervatívnu 1-minútovú cache, aby 15-minútový úspešný technický záznam neodložil obnovenie PZP. Každá odpoveď vrátane cache hitu kontroluje `knownIdentity`; kľúč cache zámerne nie je viazaný na konkrétny formulár. HMAC podpisuje celý normalizovaný výsledok a organizáciu v kanonickom poradí kľúčov (Postgres JSONB ich môže preusporiadať). Pri uložení sa kopíruje celý podpísaný snapshot, nie odkaz na expirované cache ID. Snapshot sa môže znova uložiť po vypršaní cache bez zmeny údajov alebo času pôvodného pozorovania. Deadline sa počíta od začatia dohľadania vrátane cold startu; nové externé volania sa po jeho uplynutí neposielajú a všetky provider I/O sa skončia pred uvoľnením lease. Finish RPC je viazané na token vlastníka, takže starý request neuvoľní cudziu rezerváciu.

## Testy a release

- Unit/fixtures: sentinely, normalizácia, viac VIN, nezhodný druhý identifikátor, malformed JSON/HTML, explicitný negatívny výsledok vs timeout/challenge, čiastočný VIN decode, modelYear a kg, HAKA presný pozitívny aj negatívny výsledok, odmietnutie falošného podpisu.
- Integrácia: auth/role/CSRF, DB org isolation, transakčné súbežné rezervácie, limity/cache expiry/circuit, všetky provider failures. Testovacie dáta syntetické a čistené, externé služby sa nevolajú z CI.
- UI: flotila + nová karta + úprava; lookup bez prijatia nespôsobí autosave; prijatie zachová ručné hodnoty a snapshot; zmena A→B a zatvorenie ignoruje oneskorený výsledok; dostupné klávesnicou.
- Live: používať používateľove dva automobily a publikované referenčné reporty viacerých značiek. Zaznamenať reálny čas a ktoré polia prišli. Overiť presný produkčný browser balík a Preview egress, nie iba lokálny Chrome. Malá vzorka nie je 100 % garancia slovenského trhu.
- Povinné gate: Vitest, typecheck, build; relevantné Node a Playwright testy. Architect posúdi finálny diff; Critic plán až po Architect. PR do dev, READY Preview, po merge overiť dev alias, následne PR dev→main a READY production + živé dohľadanie. Žiadny priamy production deploy.

## Riziká a prevádzka

Zmena SKP formulára alebo CAPTCHA → časovo obmedzená chyba a ručná cesta, cache/circuit/flag. Recyklovaná EČV alebo oneskorená odpoveď → kontrola VIN a request identity, žiadny tichý merge. Súbežné Vercel procesy → transakčný lease v DB, žiadny in-memory globálny sľub. Súbežný fleet release → izolované vetvy a kontrola presných SHA pred každým merge.

Oproti výskumnému plánu je runtime konkretizovaný na request-scoped Vercel Chromium; 15 s nie je tvrdý limit cold startu. Samostatné kanonické profily a časový register EČV sú odložené: prvý release ukladá org-scoped pozorovania a potvrdené snapshoty. Nie je potrebný nový VPS, platené kredity, worker ani telephony migrácia. Nové skúšky po deploymente rozširujú dôkazy; nedávajú záruku externého webu.
