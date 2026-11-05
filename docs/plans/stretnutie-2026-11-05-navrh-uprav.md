# Návrh úprav z priloženého prepisu — 5. 11. 2026

Stav: návrh na základe prepisu a lokálneho kódu `4a38099`. Dátum označuje spracovanie podkladu; presný dátum stretnutia nie je overený. Aplikácia ani vzdialené prostredia sa týmto dokumentom nemenia.

Novšie zadanie majiteľa spája tento prepis s Erosovým DOCX, kompaktnou farebnou knihou a usporiadaním výberov. **Jeden vykonávací plán pre všetky tieto požiadavky** je [spoločný realizačný plán](eros-kniha-zasahov-2026-11-05.md), najmä mapa K01–K10, podrobná časť 7 a dodávky C/G/H/I/J. Tento dokument zostáva zdrojovým rozborom. [DESIGN.md](../../DESIGN.md) zachováva spoločné vizuálne pravidlá. Majiteľ výslovne odložil napojenie na Braňa; jeho nižšie uvedené pôvodné body sú výhľad, nie súčasná dodávka.

## Záver

Najbližšia dodávka má zjednodušiť odovzdanie práce: **jeden prípad → viac samostatných zadaní → každý príjemca dostane svoj pokyn a vlastný stav**. Súčasne treba zjednotiť údaje na mobilných kartách a vysvetliť blokovanie ďalšej jazdy. Pobočky a existujúce pracovné toky už poskytujú základ; netreba ich stavať znova.

Po podrobnejšej kontrole servera a lokálnych migrácií: **notifikácie aj vysvetlenia konfliktov už existujú**. Pri notifikáciách treba overiť nasadený tok; pri konfliktoch doplniť konkrétnu blokujúcu prácu a priamy prechod. Starší text o budúcom mobilnom push je voči súčasnému kódu zastaraný.

Prepis obsahuje približne 36 minút, končí uprostred výpovede v 35:48. Telefonáty, rozhovory o kryptomenách, notebookoch a Watchdogu nevytvárajú zadania pre túto aplikáciu. Ukážka funkcie a veta „už to funguje“ nie sú dôkazom jej dnešného nasadenia ani fyzického overenia mobilu.

## Top úlohy podľa súčasného stavu

1. **Spoločné zadávanie viacerých prác z prípadu.** Máme pobočkový front, samostatné logistické jazdy, odťahové zákazky, priame pridelenie odťahového vodiča v kancelárii aj spoločný model výkonov. Chýba jeden vstup s viacerými zadaniami: druh práce → pobočka/človek → vlastný pokyn → termín. Využiť existujúce služby a riešiť výsledok i opakovanie každej položky. Nový výber vodiča zachová kancelárske oprávnenie odťahov. Neodstrániť iba ochranu jedného aktívneho starého odovzdania.
2. **Dotiahnuť údaje a pokyny až ku konkrétnemu vykonávateľovi.** Referenciu asistenčky už ukazujú staršie pristavenia a odťahy, nová logistická karta ju nemá v API ani zobrazení. Pokyn pobočky už dostáva logistický vykonávateľ; pri vytváraní odťahovej zákazky sa poznámka pobočky do jej polí nekopíruje. Doplniť chýbajúce projekcie, oddeliť interné a asistenčné číslo a overiť, že každý príjemca vidí svoj konkrétny pokyn pred prijatím práce.
3. **Vylepšiť existujúce vysvetlenie blokovania ďalšej jazdy.** Server už rozlišuje fyzicky zaneprázdneného vodiča, konflikt potvrdeného termínu, vozidlo a zmenu stavu; mobil má slovenské hlášky. Chýba identifikácia blokujúcej práce a akcia na jej otvorenie. Text „najprv dokončite“ nepoužívať ako jediné vysvetlenie aj pri konflikte budúceho termínu; tam pomôže kontaktovať dispečera a zmeniť plán.
4. **Overiť existujúce notifikácie v celom toku na TEST.** Pobočkoví vedúci už majú oznámenia novej práce, vykonávatelia pridelenia, prepridelenia a zrušenia; existuje pripomenutie aj eskalácia. Overiť konkrétne účty, registráciu zariadenia, povolené kategórie, doručenie na telefóne a otvorenie správnej karty. Zjednotiť zastarané texty. Úspech push poskytovateľa nie je prijatie práce človekom.
5. **Zjednodušiť pristavenie a presne určiť zdieľanie polohy.** Máme samostatné kroky logistiky a odťahu, priebeh aj mechanizmus polohy. Skracovať iba pristavenie, po overení dôsledkov pre časové údaje a doklady. Dnes sa logistická poloha povoľuje od prijatia; prepis hovorí od vyrazenia. Rozdiel vyriešiť vedome spolu s tokom, nie skrytou zmenou. Na iOS je pripravená poloha na pozadí; Android ju má v konfigurácii vypnutú. Fyzické správanie overiť pre každú podporovanú platformu.
6. **Doplniť protokol odovzdania odťahu podľa reálnej prevádzky.** Máme účastníkov zákazky, fotky výkonu/odovzdania, sken podpísaného papiera a PDF s prázdnymi podpisovými miestami. Chýba digitálne zachytenie skutočne preberajúcej osoby a jej podpisu na mieste. Spresniť situáciu bez klienta, podpis príjemcu v servise a dôvody výnimiek; existujúci papierový tok môže pokračovať. Pečiatka ani uložený podpis dopravcu nenahrádzajú potvrdenie príjemcu.
7. **Nájomný systém — odložené na neskôr.** Máme mapovanie asistenčky, referencie, pobočky, klienta a telefónu do náhľadu. Chýba externé vytvorenie draftu, jeho ID a cieľová URL pre mobil. Podľa novšieho zadania majiteľa sa dohoda ani napojenie na Braňa teraz nerozpracúvajú; neblokujú knihu ani ostatné mobilné doplnenia.
8. **Upratať existujúce obrazovky a názvoslovie pri úlohách vyššie.** Máme prehľady práce aj súvisiacej práce v prípade. Chýba jednotné pomenovanie a pohodlná cesta medzi odovzdaním, pobočkou a konkrétnou jazdou/zákazkou. Zladiť „Výjazdy a odvozy“, „Moje jazdy“, „Pristavenia“ a „Moja práca“ podľa významu. Nevytvárať ďalší paralelný zoznam alebo nový navigačný systém.

Prvé štyri body tvoria najbližšiu ucelenú dodávku. Malé doplnenia údajov a hlášok možno pripraviť popri spoločnom zadávaní. Návrh kratšieho toku a podpisov má vlastné prijatie; napojenie nájmu má externú závislosť. PZP zostáva samostatnou integračnou témou s existujúcim ručným overením.

## Čo zo stretnutia skutočne vyplýva

| Čas | Podstatný obsah | Ako s tým pracovať |
|---|---|---|
| 15:28–18:27 | Pristavenie pobočke, odťah inému príjemcovi; príjemcov môže byť viac a každý má inú správu. | Jednoznačná požiadavka. Počet „štyri alebo osem“ znamená možnosť pridávať zadania, nie dohodnutý limit osem. |
| 17:34–17:56 | Pri zakladaní prípadu boli vybrané odťah aj náhradné auto. | Predvyplniť návrhy zadaní podľa služieb prípadu; príjemcov a odoslanie naďalej potvrdiť. |
| 18:27–19:57 | Pobočka prevezme prácu a pridelí človeka; človek ju prijme v mobile. | Zachovať existujúcu zodpovednosť a overiť oznámenia v celom toku. Samotné založenie prípadu nestačí na výber príjemcu. |
| 20:02–20:44 | Pristavovač potrebuje číslo prípadu asistenčky, pretože zadáva nájom. | Jednoznačná požiadavka na údaje a ich viditeľnosť, nie dôvod sprístupniť celý spis. |
| 25:58–26:19 | Pri rozbehnutej práci má aplikácia povedať, prečo nemožno začať ďalšiu. | Jednoznačná požiadavka na vysvetlenie a cestu k blokujúcej práci. |
| 26:52–28:49 | Pri odťahu je dôležité zdokumentovať odovzdanie tomu, kto auto preberá v servise; klient nemusí byť pri prevzatí. | Samostatná úprava protokolu. Presné pravidlá výnimiek ešte nie sú uzavreté. |
| 32:02–32:31 | Pristavovač zrejme nepotrebuje všetky kroky odťahu. | Otvorený návrh. Zo stretnutia nevznikol definitívny zoznam stavov. |
| 32:47–32:55 | „Výjazdy a odvozy“ nezodpovedajú používaným výrazom. | Potvrdený problém názvoslovia; presný názov zostal otvorený. |
| 33:55–35:13 | Z mobilu otvoriť hlavný nájomný systém, ideálne konkrétny rozpracovaný prípad. | Oddeliť otvorenie systému od skutočného prenosu údajov. Druhé potrebuje dohodnuté napojenie. |
| 11:17–13:59 | Automatické overovanie PZP je nespoľahlivé. | Evidovať ako samostatný integračný problém. Úvahy o IP adresách, CAPTCHA a cene nie sú overeným návrhom riešenia ani dohodnutým rozpočtom. |

## Čo už existuje a kde je medzera

Zistenia nižšie sú z lokálneho zdrojového kódu. Nepotvrdzujú aktuálne vzdialené nasadenie.

- **Pobočky a viac prác pod jedným prípadom existujú.** Model obsahuje samostatné požiadavky a súvisiacu prácu. Vytvárací formulár však odosiela jednu pobočku a jeden druh práce. [Model](../../src/domain/work-groups.ts), [formulár `CreateRequest`](../../src/components/branches/BranchWorkspace.tsx).
- **Odovzdanie pristavovačovi alebo odkazom je iná cesta.** `CaseHandoffPanel` pri aktívnom odovzdaní skryje výber nového príjemcu. Pri starej ceste aj databázový index vynucuje jeden aktívny `legacy_slot` na prípad; opakované pridelenie tomu istému človeku možno potvrdiť znova, inému sa odmietne. Novšie požiadavky a výkony už umožňujú viac prác na prípad. [Panel](../../src/components/dispatch/CaseHandoffPanel.tsx), [indexy a adaptér](../../supabase/migrations/20261026190600_shared_dispatch_operations.sql), [pridelenie starého pristavenia](../../supabase/migrations/20261022100000_mobile_delivery_handoffs.sql).
- **Priame pridelenie odťahu už existuje v odťahovej kancelárii.** Pobočkový odťah najprv vytvorí zákazku, vodič sa prideľuje samostatne cez jej oprávneného správcu. Logistické príkazy odťah neriadia. Nový spoločný vstup musí tieto cesty poskladať a zachovať oprávnenia. [Pobočkové vytvorenie zákazky](../../supabase/migrations/20261028110000_branch_work_groups_review.sql), [odťahové pridelenie a kapacita](../../supabase/migrations/20261026190600_shared_dispatch_operations.sql).
- **Číslo asistenčky už niektoré karty zobrazujú.** Je v staršom pristavení, odťahovej karte a súhrne odovzdania. Novšia logistická karta zobrazuje interné číslo prípadu a jej prenosový typ nemá referenciu asistenčky. Ide o zjednotenie tokov. [Logistická karta](../../mobile/src/field-work/module.tsx), [prenosové typy](../../src/lib/mobile-api.ts), [súhrn odovzdania](../../mobile/src/handoff/summary-rows.ts).
- **Pokyn pobočky už putuje logistickému vykonávateľovi.** Mobilný kontext číta poznámku z pracovnej požiadavky. Pobočkové vytvorenie odťahovej zákazky však kopíruje trasu, kontakt a vozidlo, nie poznámku požiadavky; mobilná odťahová karta samostatný pokyn pobočky nenačítava. [Logistický kontext](../../supabase/migrations/20261028140000_operation_positions.sql), [odťahová vetva vytvorenia](../../supabase/migrations/20261028110000_branch_work_groups_review.sql), [mobilná projekcia](../../src/server/mobile/field-work.ts).
- **Vysvetlenia konfliktov už existujú.** `operationRefusals` a `towingRefusals` prekladajú kapacitné konflikty do slovenských hlášok. Samotný fyzický súbeh a termín chráni databáza. Chýba konkrétna identifikácia blokujúceho výkonu a prechod naň, nie základné vysvetlenie. [Serverové hlášky](../../src/server/mobile/field-work.ts), [spracovanie príkazov](../../mobile/src/field-work/commands.ts), [obnova po chybe](../../mobile/src/field-work/parts.tsx).
- **Push pre prácu a pobočky už existuje.** Databázový front, výber príjemcov, okamžité odoslanie po príkazoch, dočerpanie existujúcim cronom, pripomenutia a ciele mobilného otvorenia sú implementované. Text o budúcej verzii vo webovom fronte je zastaraný. Odoslanie závisí od nasadenia, prepínača, zariadenia a kategórií; výsledok `sent` znamená úspešný ticket Expo, nie fyzické zobrazenie či prevzatie práce. [Udalosti a front](../../supabase/migrations/20261028130000_mobile_work_push.sql), [odosielanie](../../src/server/mobile/push-outbox.ts), [príkaz pobočky](../../src/server/branches/service.ts), [mobilné ciele](../../mobile/src/notifications/taps.ts).
- **Zdieľanie polohy sa líši od opisu na stretnutí.** Novší logistický tok ho povoľuje už od prijatia práce, kým prepis opisuje začiatok pri vyrazení. Mechanizmus iOS polohy na pozadí existuje; konfigurácia Androidu má polohu na pozadí aj foreground service vypnutú. [Model a `sharesOperationPosition`](../../mobile/src/field-work/model.ts), [natívna konfigurácia](../../mobile/app.config.ts).
- **Papierové podklady odťahu možno priložiť.** Existujú fotky, sken aj PDF s tromi prázdnymi podpisovými miestami. V preverenej mobilnej karte sa nenašlo zachytenie podpisu preberajúcej osoby priamo na obrazovke. Sken podpísaného papiera a digitálny podpis sú odlišné dodávky. [Odťahová karta a prílohy](../../mobile/src/field-work/module.tsx), [PDF](../../src/server/towing/pdf-template.ts).
- **Prenos nájmu je zatiaľ náhľad.** Kód explicitne vracia `not_connected` a oznamuje, že nič neodosiela. [Príprava nájmu](../../src/domain/rental-draft.ts), [webový náhľad](../../src/components/operations/RentalDraftPanel.tsx).
- **PZP má manuálnu náhradnú cestu.** Pri neúspechu sa vysvetlí výsledok a ponúkne ručné overenie na SKP. Neúspech sa neprezentuje ako nepoistené vozidlo. [Rozhranie](../../src/components/dispatch/SkpManualFallback.tsx).

## Odporúčaná prvá dodávka

### 1. Jedno miesto na odovzdanie viacerých prác

V detaile prípadu jeden zrozumiteľný vstup **Odovzdať prácu**. Vnútri pridávateľné karty:

| Práca | Komu | Pokyn |
|---|---|---|
| Pristavenie náhradného vozidla | Pobočka Bratislava | Pristaviť náhradné vozidlo na dohodnuté miesto. |
| Odťah | Oprávnený odťahovkár alebo odťahová pobočka | Odviezť poškodené vozidlo do určeného servisu. |
| Ďalšia práca | Ďalší vhodný príjemca | Vlastný pokyn a termín. |

Tlačidlo **Pridať ďalšiu prácu**, následne spoločná kontrola a **Odoslať zadania**. Typy sa navrhnú zo služieb prípadu, no nič sa nerozpošle automaticky pri jeho vytvorení. Pri pristavení možno ponechať konkrétne auto neurčené, ako už umožňuje pobočkový tok.

Použiť existujúce mechanizmy pobočky, logistiky a odťahových zákaziek. Výber človeka rešpektuje jeho oprávnenia; odťah sa neposiela cez kartu určenú iba pristavovačovi. Externý kolega bez účtu zostáva osobitnou možnosťou s náhľadom zdieľaných údajov.

Každé zadanie má vlastný stav, pokyny a výsledok odoslania. Ak uspeje iba časť, obrazovka presne ukáže ktorú a dovolí zopakovať iba nepotvrdené zadania bez duplicít. Dokončenie pristavenia neukončí odťah ani celý prípad. Existujúce aktívne zadania zostanú viditeľné pri pridávaní ďalších.

### 2. Rovnaké dôležité údaje vo všetkých mobilných kartách

Pri logistike doplniť **Asistenčná služba** a **Číslo prípadu asistenčky**, oddelene od interného čísla. Zobraziť aj kontakt, odkiaľ/kam, termín a pokyn určený konkrétnemu príjemcovi. Chýbajúcu referenciu označiť ako nevyplnenú; nedosadzovať za ňu interné číslo.

Pri blokovaní ponúknuť napríklad: „Máte rozbehnutú jazdu [číslo]. Pred začatím ďalšej otvorte túto jazdu.“ a akciu **Otvoriť rozbehnutú jazdu**. Text musí vychádzať zo skutočného dôvodu servera; všeobecné odmietnutie sa nesmie automaticky označiť za konflikt jazdy.

### 3. Jasný spoločný prehľad a názvy

V prípade zobraziť jednotlivé práce, príjemcu a stav. Rozlíšiť **odoslané zadanie**, **prijatú prácu** a **prebiehajúcu prácu**. Doručená notifikácia sama nepotvrdzuje prevzatie práce.

Navrhovaný názov logistického modulu: **Pristavenia a návraty**; názvy úkonov **Pristavenie náhradného vozidla**, **Vyzdvihnutie náhradného vozidla**, **Presun vozidla**. „Odstavenie“ je v prepise nejednoznačné, preto ho nepremeniť automaticky na názov odťahu alebo návratu.

## Ďalšie dodávky a otvorené rozhodnutia

1. **Kratší postup pristavovača.** Ako pracovný návrh preveriť Prijať → Vyrážam → Auto odovzdané; samostatné „Som na mieste“ by pri pristavení mohlo odpadnúť. Pred zmenou overiť význam časov, dokladov a existujúcich nadväzujúcich krokov. Odťah ani vyzdvihnutie auta sa tým automaticky neskracujú. Začiatok polohy pri prijatí oproti vyrazeniu zostáva otvoreným rozhodnutím; prepis sám neprepisuje súčasné pravidlo.
2. **Protokol odťahu.** Oddeliť prevzatie auta od klienta a odovzdanie príjemcovi v servise. Zachytiť meno preberajúceho, miesto, čas a podpis alebo zdôvodnenú výnimku. Nevyžadovať prítomnosť klienta pri každom vyzdvihnutí. Najprv možno využiť existujúci sken papiera; podpis na displeji je samostatné rozšírenie. Predvolená firemná pečiatka sa nesmie vydávať za skutočný podpis príjemcu.
3. **Braňov nájomný systém — odložené.** Zachovať pravdivý náhľad bez odosielania. Dohodu, vytvorenie externého draftu a mobilné otvorenie konkrétneho nájmu riešiť až v neskoršom zadaní majiteľa.
4. **PZP.** Zachovať ručné overenie a zrozumiteľné stavy. Spoľahlivejšiu automatizáciu riešiť samostatne cez podporovaný prístup poskytovateľa. Rotácia IP adries a maskovanie robota z prepisu nie sú súčasťou navrhovanej dodávky.

Vyjadrenia o termíne Apple schválenia, distribúcii a možnostiach OTA sú kontext stretnutia. Nie sú potvrdeným aktuálnym stavom ani podkladom na sľub termínu vydania.

Konkrétne natívne OTA aktualizácie sú v súčasnej [konfigurácii](../../mobile/app.config.ts) vypnuté; iba výslovný Expo Go TEST preview má odlišné nastavenie. Sľub zo stretnutia o úpravách bez nového vydania preto nemožno preniesť na dnešné natívne binárky.

## Overenie a poradie práce

Poradie celého rozsahu určuje spoločný realizačný plán: klientsky základ C/G s priebežným overením J; súbežne kompaktná kniha A/D0 a následne serverové filtre B; potom kratšie pristavenie/poloha H, náhradná cesta PZP I a Erosove doplnenia D1/E/F. Každá pripravená časť má vlastné overenie na stabilnom TEST; podpisy možno oddeliť. Nájomný systém je výslovne odložený.

Prvá dodávka je prijateľná, keď na jednom TEST prípade:

- Dispečer odošle pristavenie pobočke a odťah inému oprávnenému príjemcovi, každému s vlastným pokynom; vie pridať aj ďalšie zadanie.
- Príjemca vidí iba pridelenú prácu a potrebné údaje vrátane oboch odlíšených čísel prípadu. Pobočka vie prácu prevziať a prideliť vykonávateľovi.
- Čiastočný neúspech a opakované odoslanie nevytvoria duplicitnú prácu. Zmena alebo dokončenie jednej práce nepokazí druhú.
- Pri blokovaní ďalšej jazdy sa zobrazí pravdivý dôvod a dostupná cesta k blokujúcej práci.
- Na fyzickom telefóne sa overí oznámenie správnemu príjemcovi, otvorenie správnej karty a správanie pri zamietnutých notifikáciách. Pri úprave polohy sa zvlášť overí začiatok, koniec a správanie na pozadí; nejde o predpoklad podľa prepisu.

Pri implementácii použiť cielené regresné testy a existujúcu CI bránu. Odovzdať na **https://test.dispecing.linkapomoci.sk** s konkrétnym `dev` commitom a krátkym návodom na skúšku. Produkcia nasleduje až po schválení identifikovaného otestovaného rozsahu podľa pravidiel repozitára.

Pôvodné spracovanie overilo zdrojové súbory, posledné relevantné definície lokálnych migrácií a obsah existujúcich testov. Kontrakty sú v `tests/postgres/external-case-handoff.py`, `tests/postgres/mobile-work-push.py` a `src/server/mobile/field-work.test.ts`. Vtedy sa testy ani živé integrácie nespúšťali; neskoršie vizuálne overenie opisuje spoločný realizačný plán. Stav aplikovaných migrácií, vzdialených prepínačov a konkrétnej mobilnej verzie zostáva neoverený.
