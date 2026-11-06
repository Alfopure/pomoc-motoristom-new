# Spoločný realizačný plán: požiadavky klienta, Eros a použiteľnosť aplikácie

Stav: **návrh implementácie**, 5. 11. 2026, lokálny základ `4a38099`. Toto je **jeden spoločný plán pre klientské požiadavky zo stretnutia, Erosov dokument aj následné zadanie použiteľnosti**. [Pôvodné spracovanie prepisu](stretnutie-2026-11-05-navrh-uprav.md) je zdrojový rozbor; na vykonanie celého dohodnutého rozsahu slúži tento dokument. Názov súboru zostáva zachovaný kvôli existujúcim odkazom. Aplikačný kód sa v tejto etape nemení. **Napojenie na Braňov systém je odložené a nie je závislosťou tohto vydania.**

## 1. Výsledok pre používateľa

- Dispečer zadá z jedného prípadu pristavenie aj odťah rôznym príjemcom, každému samostatné pokyny.
- Pobočka prevezme zadanie a pridelí ho človeku; centrála vidí prevzatie a priebeh každej súvisiacej práce.
- Pristavovač má úplnú praktickú kartu vrátane čísla prípadu asistenčky, kratší primeraný postup a vysvetlenie prípadného blokovania s cestou k rozpracovanej práci.
- Notifikácie a zdieľanie polohy majú overený priebeh a pravdivo zobrazené obmedzenia. Neúspešné automatické overenie PZP má použiteľnú náhradnú cestu.
- Kniha odťahových zásahov sa vizuálne priblíži Erosovej tabuľke: úzke farebné riadky, objednávateľské štítky, ikony, kompaktné výbery, užitočné filtre a čitateľné sumy.
- Vodič vidí vlastné zadania, doplní chýbajúce realizačné údaje, podklady a potvrdenú úhradu. Po serverom potvrdenom odovzdaní sa zásah presunie ku kancelárii.
- Kontrola, nacenenie, evidencia faktúry, úhrady a držba hotovosti zostanú jasne rozlíšené.
- Formuláre a akcie majú logické poradie a primeranú šírku. Výbery ani dôvody storna nezaberajú náhodnú polovicu širokej obrazovky.

Vizuálne rozhodnutia určuje [DESIGN.md](../../DESIGN.md). Z prílohy preberáme informačnú hierarchiu a funkčné potreby, nie firemnú značku cudzej asistenčnej aplikácie. Mobil zachováva [existujúcu kostru a tokeny](../mobile/design-standard.md).

### 1.1 Pokrytie klientského stretnutia v tomto pláne

Časy odkazujú na dodaný prepis končiaci v 35:48. Každý bod má konkrétnu dodávku a akceptačný scenár; jeho implementácia sa nestratí medzi úpravami Erosovej knihy.

| ID | Požiadavka klienta / podklad | Rozpracovanie | Dodávka / prijatie |
|---|---|---|---|
| K01 | Viac príjemcov jedného prípadu, odťah aj pristavenie, každý vlastná správa a termín; 15:28–18:27. | 7.1: samostatné zadania a potvrdené odoslanie, predvyplnenie služieb prípadu. | C; H1–H3. |
| K02 | Centrála → pobočka → miestny dispečer → vykonávateľ, prijatie a spoločné sledovanie; 00:00–01:15, 18:27–19:57. | 7.1 a 7.4: pobočkový tok, obmedzený súhrn súvisiacej práce a notifikácie. | C/J; H4, N1, N3. |
| K03 | Číslo prípadu asistenčky potrebuje aj pristavovač; 20:02–20:44. | 7.2: doplnenie novšej logistickej API projekcie a karty, nie iba odťahovej karty. | G; K3. |
| K04 | Povedať, prečo nemožno začať ďalšiu prácu; 25:58–26:19. | 7.3: presný dôvod, blokujúca práca a možnosť ju otvoriť. | G; K4. |
| K05 | Primerane skrátiť pristavenie a rozlíšiť ho od odťahu; 32:02–32:31. | 7.5: samostatný návrh krokov a zachovanie údajov potrebných na dokončenie. | H; K5. |
| K06 | Viditeľný priebeh a poloha vykonávateľa, vrátane správania na pozadí; 01:15–01:59. | 7.4–7.5: overenie oznámení, začiatok/koniec polohy a platformové limity. | H/J; N1–N3, K6. |
| K07 | Potvrdiť odovzdanie auta príjemcovi v servise; klient nemusí byť pri nakládke; 26:52–28:49. | 6.3: papierový a následný digitálny protokol, meno/čas/podpis alebo dôvod výnimky. | F; F2–F3. |
| K08 | Upratať prácu/jazdy, úlohy, poznámky/aktivitu a názvy „výjazdy/odvozy“; 14:55–15:28, 32:47–33:28; následné zadanie layoutu. | 7.6 a časti 4–5: rovnaký princíp aj mimo knihy odťahov, primerané šírky a radenie úkonov. | A/B/C/G; L2, L5–L6. |
| K09 | Nespoľahlivé overovanie PZP; 11:17–13:59. | 7.7: samostatne dodaný použiteľný stav neoverenia, ručná náhrada a posúdenie podporovaného prístupu. | I; V1–V2. |
| K10 | Otvoriť hlavný nájomný systém/preniesť údaje; 33:55–35:13. | Majiteľ v novšom zadaní výslovne odložil Braňa. Existujúci náhľad ostáva bez prenosu. | Odložené; neblokuje žiadny z bodov K01–K09. |

Erosov dokument dopĺňa rovnaký produkt o knihu zásahov, číselníky, vozidlové a vlastnícke údaje, realizačné položky, platby, hotovosť, nacenenie a doklady v častiach 3–6. Tieto body nenahrádzajú klientské požiadavky K01–K09.

## 2. Podklady a hranice dôkazov

Prečítaný bol celý dodaný prepis stretnutia aj DOCX a prezreté všetky obrázky: mobilný zoznam, papierový zákazkový list a kancelárska Excelová tabuľka. Obrázky sú pracovné podklady v `.context/eros-document-images/`. Následné pokyny majiteľa dopĺňajú kompaktné rozloženie celej dotknutej obsluhy a odklad Braňa. Názvy a výbery sú návrhom prevádzkovej konfigurácie; ich aktuálny obsah v TEST/produkcii nebol zisťovaný.

Zdrojový kód a posledné relevantné lokálne definície migrácií sú overené. Syntetický browserový náhľad skutočných komponentov nečíta živú databázu a neposiela poskytovateľom žiadne dáta. Nenahrádza aktuálne nasadenie, fyzický mobil ani prevádzkové prijatie.

## 3. Čo už máme a čo treba doplniť

| Oblasť | Už implementované | Chýbajúca práca | Dôkaz |
|---|---|---|---|
| Pobočky a prideľovanie | Front, prevzatie vedúcim, priradenie logistického vykonávateľa; odťahová kancelária prideľuje vodiča. | Spoločný vstup na viac samostatných zadaní a ich výsledkov. | [Pobočkový tok](../../src/components/branches/BranchWorkspace.tsx:126), [odťahový vlastník](../../supabase/migrations/20261028110000_branch_work_groups_review.sql:136). |
| Viac prác na prípad | Samostatné pracovné požiadavky a výkony na rovnaký prípad. | Staré odovzdanie má jednu aktívnu legacy pozíciu; nový formulár musí používať konkrétne výkony. | [Indexy](../../supabase/migrations/20261026190600_shared_dispatch_operations.sql:233), [starý panel](../../src/components/dispatch/CaseHandoffPanel.tsx:115). |
| Logistická mobilná karta | Interné číslo prípadu, kontakt, trasa a pobočkový pokyn. Referencia asistenčky je v iných tokoch. | Pridať asistenčku a jej referenciu aj do novšieho logistického API a zobrazenia; doplniť je nezávisle od nových odťahových platieb. | [Karta jazdy](../../mobile/src/field-work/module.tsx:181), [logistický typ](../../src/lib/mobile-api.ts:487). |
| Konflikt ďalšej práce | Server už prekladá kapacitné konflikty do slovenských hlášok. | Doplniť identitu dostupnej blokujúcej práce a otvorenie; odlíšiť rozbehnutú prácu od plánovanej kolízie. | [Logistické hlášky](../../src/server/mobile/field-work.ts:62), [odťahové hlášky](../../src/server/mobile/field-work.ts:303). |
| PZP | Zobrazenie neúspešného zdroja a ručná náhradná cesta na webe. | Zjednotiť dokončenie ručného overenia a posúdiť spoľahlivejší podporovaný prístup; chybné overenie neblokuje založenie prípadu. | [Ručná náhrada](../../src/components/dispatch/SkpManualFallback.tsx:26), [mobilný nástroj](../../mobile/src/tools/lookup.tsx). |
| Kancelárska kniha | Skutočná tabuľka, serverové filtre, stránkovanie, finančné súčty. | Hustota, objednávateľ/referencia a technika v riadku, fáza podľa farby celého riadka, ovládateľné radenie. | [Prehľad](../../src/components/towing/TowingWorkspace.tsx:77), [štýly](../../src/components/towing/towing.module.css:32). |
| Logistický prehľad | Pristavenia, vyzdvihnutia, presuny, návraty, väzby na odťahy. | Kompaktnejší vzhľad a hľadanie/filtrovanie na serveri; dnešné hľadanie prehľadáva iba načítanú stranu. | [Načítanie a lokálny filter](../../src/components/operations/OperationsModule.tsx:38). |
| Objednávateľ | Výber „Asistenčná služba / partner“, referencia, účastníci zákazky. | Výslovne rozlíšiť asistenciu a samoplatcu vrátane pravidelného partnera; hľadateľné výbery a filter. | [Výbery](../../src/components/towing/OrderFields.tsx:18), [typy](../../src/domain/towing/types.ts:11). |
| Pobočka, technika, parkovisko | Výbery zo skutočných číselníkov, adresa konkrétneho parkoviska. | Porovnať s Erosovým zoznamom, upraviť zoskupenie a šírky; nie vytvoriť druhý číselník. | [Formulár](../../src/components/towing/OrderFields.tsx:21), [parkoviská](../../src/components/towing/administration.tsx:33). |
| Mobilná karta | Vlastné zákazky, kontakt/trasa, časy, poznámka, množstvo, fotografie a sken. | Objednávateľ/referencia v zozname, doplnenie povolených údajov vozidla/majiteľa, forma úhrady a príjem platby. | [Natívna karta](../../mobile/src/field-work/module.tsx:96), [mobilné kontrakty](../../src/lib/mobile-api.ts:513). |
| Stav výkonu a kancelária | Odovzdanie na kontrolu, vrátenie, schválenie ceny, fakturácia a úhrady ako nezávislé stavy. | Prehľadná spoločná zobrazovaná fáza a rýchle pohľady nad tými istými stavmi. | [Stavy](../../src/domain/towing/types.ts:6), [detail](../../src/components/towing/OrderDetail.tsx:56). |
| Výkonové položky | Päť typov služieb a viac upraviteľných cenových položiek. | Predvoľby realizovaných úkonov; dnes „Pridať položku“ vytvorí prázdny riadok. Výber vodiča nie je schválená cena. | [Služby](../../src/components/towing/model.ts:8), [nacenenie](../../src/components/towing/OrderDetail.tsx:119). |
| Peniaze a DPH | Výpočet netto/daň/brutto, overená sadzba k dátumu nacenenia, potvrdené prijaté platby. | Jasne zobraziť všetky tri súčty a samostatný plánovaný spôsob úhrady; nerozšíriť typ platby iba názvom. | [Výpočty](../../src/domain/towing/money.ts), [platby](../../src/components/towing/OrderDetail.tsx:151). |
| Hotovosť vodiča | Webový príjem hotovosti, zostatok, rezervácia a potvrdené odovzdanie kancelárii. | Rovnocenná úzka natívna mobilná obsluha; natívny príkaz dnes príjem úhrady odmieta. | [Hotovosť](../../src/components/towing/TowingWorkspace.tsx:115), [explicitné odmietnutie](../../mobile/src/field-work/commands.test.ts:58). |
| Faktúra a PDF | Evidencia externej faktúry; verzované zákazkové PDF a odoslanie vybranej verzie na potvrdený e-mail. | Uľahčiť kancelársky postup a doplniť nové povolené polia. Automatické vytvorenie faktúry ani automatické odoslanie servisu nie sú hotové. | [Faktúry](../../src/components/towing/OrderDetail.tsx:170), [odoslanie](../../src/components/towing/OrderDetail.tsx:217). |
| Podpisy | Fotky odovzdania, sken papiera, tri prázdne podpisové miesta PDF. | Potvrdenie konkrétneho príjemcu; digitálny podpis na displeji je samostatné rozšírenie. | [PDF](../../src/server/towing/pdf-template.ts:29), [prílohy](../../src/components/towing/OrderDetail.tsx:114). |
| Notifikácie/poloha | Push na prácu a pobočky, eskalácie, mobilné otvorenie karty; logistická poloha vrátane mechanizmu iOS na pozadí. | Živé TEST overenie, odstránenie zastaraných textov, vedomé rozhodnutie začiatku polohy; Android má pozadie vypnuté. | [Push](../../supabase/migrations/20261028130000_mobile_work_push.sql), [konfigurácia](../../mobile/app.config.ts:90). |

## 4. Kniha podľa Erosovej tabuľky

### 4.1 Rozloženie a hustota

Zachovať tabuľku, vymeniť jej prezentáciu. Hlavička knihy s jednou hlavnou akciou **Nový zásah**, doplnkové Obnoviť, Hotovosť a Výkazy menšie. Súčty ako nízke spoločné bloky, nie veľké vysoké karty. Hlavné filtre a rýchle stavy nemajú pri 1440 × 900 odsunúť prvý riadok pod približne 280–320 px.

Desktopový cieľ: bežný riadok 40–44 px, pri dlhšom obsahu maximálne dva stručné riadky. Nadpis tabuľky, filtre a súčty zostávajú čitateľné. Nezmenšovať všetko na 10 px a neukrývať význam iba za ikony. Aktuálny nameraný baseline na fixture pri 1440 × 900: prvý riadok 116,5 px, začiatok tela tabuľky v 696,5 px; bez posunu bol celý viditeľný iba jeden riadok.

Navrhované predvolené stĺpce zoskupia pôvodný Excel bez zbytočnej šírky:

| Stĺpec | Obsah | Orientačná šírka |
|---|---|---|
| Dátum/čas | Dátum zásahu; označenie plánovaného času | 88–104 px |
| Vozidlo / náklad | Model/predmet, EČV; číslo zákazky dostupné pri otvorení | 140–180 px |
| Objednávateľ | Farebný názov, referencia asistenčky alebo samoplatca | 140–180 px |
| Vodič / technika | Vodič a názov zásahového vozidla | 140–175 px |
| Nakládka → vykládka | Dva krátke riadky, úplná adresa v detaile | pružný, približne 200–260 px |
| Spôsob úhrady | Ikona + krátky text; nie potvrdenie prijatia | 110–145 px |
| Stav zásahu | Jedna dominantná fáza + prípadná výnimka | 140–175 px |
| Bez DPH / s DPH | Vpravo, pevné číslice; dva stĺpce na širokej obrazovke | 90–105 px každý |
| Otvoriť | Jedno označené otvorenie detailu | 32–40 px |

Pobočku a stručné info možno zobraziť ako voliteľný stĺpec alebo doplnok; nestratia sa z detailu a filtrov. V užšom zobrazení sa sumy spoja a sekundárne stĺpce schovajú, nie všetko natlačí do 12 úzkych kolóniek. Vodorovný posuv smie mať iba tabuľka. Hlavička je pri posuve tabuľky pevná.

### 4.2 Fáza riadka a farby

Zachovať samostatný pracovný, fakturačný a platobný stav; pridať iba jedno testovateľné odvodenie zobrazovanej fázy. Erosove farby a texty:

1. Nepridelený návrh: biely.
2. Pridelené alebo Prebieha: jemná oranžová.
3. Odovzdané vodičom, ešte neschválené: sivá, **Na kontrolu**.
4. Schválená cena, pripravené na fakturáciu: modrá.
5. Evidovaná faktúra: svetlozelená.
6. Dokončený výkon s uzavretým fakturačným postupom a potvrdenou úhradou: výraznejšia svetlozelená, **Zaplatené**.

Priorita výnimiek: storno má vlastný text a utlmený riadok; vrátenie vodičovi má **Na doplnenie**. Finančná výnimka, čiastočná úhrada a preplatok ostávajú osobitné malé štítky. Záloha/platba prijatá počas aktívneho zásahu nesfarbí rozbehnutú prácu na hotovú zelenú. „Bez fakturácie“ je výslovne potvrdený existujúci stav, nie dôsledok výberu „Iné“.

V riadku nemať tri široké stavové pásy pod sebou. Úplné tri stavy ostanú v detaile. Objednávateľské čipy a malé ikony pre odťah, opravu, parkovanie, vozidlo, kartu/hotovosť/doklad dopĺňajú text, nemenia finančné údaje.

### 4.3 Filtre, dátumy, radenie a súčty

- Hlavný riadok: hľadanie podľa čísla, EČV, VIN, kontaktu a predmetu; obdobie; pobočka; vodič. Na menšej šírke obdobie presunúť do označeného filtra, nie nechať osamelé polia.
- Rozšírené filtre: zásahové vozidlo, typ objednávateľa, konkrétny objednávateľ, typ úkonu, fáza, platobný zámer a skutočný platobný stav, fakturácia, parkovisko, potrebné doplnenie. Filter objednávateľa v API je dnes iba textový vstup; identifikovaný výber je doplnenie, nie údajne hotová funkcia.
- Aktívne filtre ukázať ako odoberateľné čipy a jedným krokom vymazať. Po zmene sa resetuje stránkovanie. Rýchle pohľady: Všetko, Nepridelené, V teréne, Na kontrolu, Na fakturáciu, Vyfakturované, Zaplatené.
- Viditeľne určiť **Podľa dátumu zásahu / Podľa založenia**. Dátum zásahu používa potvrdený skutočný začiatok, inak plánovaný termín, inak vznik zadania; pri náhradnej hodnote sa ukáže jej pôvod. Dnešné „Založené od/do“ sa nepremenuje bez zmeny dotazu.
- Prevádzkové radenie: nepridelené → pridelené/prebiehajúce/vrátené na doplnenie → ostatné podľa dátumu. Budúce plánované zadania nestratia svoj termín. Evidenčný externý AWP výkon nesmie vystupovať ako čakajúce vyslanie nášho vodiča.
- Ďalšie radenie: dátum zásahu vzostupne/zostupne, vodič, schválená suma. Server má povolený zoznam sort kľúčov a konečný stabilný kľúč ID; radenie platí pred stránkovaním. Chýbajúca cena sa nepovažuje za 0 €.
- Rovnaká oprávnená filtrovaná množina určuje riadky, celkový počet a súčty **Schválené výkony**, **Vyfakturované**, **Prijaté platby**. Súčet vodiča za obdobie neznamená ich sčítanie do jedného čísla „tržba“.
- Hodnoty bez DPH/DPH/s DPH sa odvodia existujúcimi presnými výpočtami a schváleným pravidlom k uloženému dátumu. Nepridávať hardcoded zákonnú sadzbu.
- V knihe používať miestne dátumy Bratislavy s prevodom hraníc na UTC. Existujúci finančný report dnes deklaruje UTC a iný dátum pre každý druh udalosti: buď to zachovať jasne označené, alebo samostatne zmeniť a otestovať; kniha a report sa nesmú nenápadne tváriť ako rovnaké obdobie.
- Logistiku opraviť tak, aby hľadanie a filtre platili na celú oprávnenú množinu, nie iba na aktuálnych 50 záznamov. Nevytvárať druhý nezávislý odťahový report nad jej projekciou.

## 5. Výbery a formuláre

### 5.1 Poradie a šírky

Základná časť: **Objednávateľ → kontakt → nakládka/vykládka → pobočka/vodič/technika → termín → vozidlo/predmet → úkony → spôsob úhrady**. Doplňujúce údaje majiteľa, odberateľa a príjemcu pod označenými rozbaľovacími sekciami. Pri návrhu možno uložiť minimum; pre pridelenie a dokončenie platia pomenované podmienky.

Detail oddelí prezeranie, úpravu údajov, pridelenie a kancelárske schválenie. Jedno hlavné **Uložiť údaje** v rámci formulára. Pridelenie má krátky výber a vlastné tlačidlo; dôvod vrátenia/storna sa zobrazí až pri konkrétnom úkone. Storno ostane zreteľne oddelené a vyžiada dôvod.

Desktopové šírky podľa významu: krátke výbery približne 160–240 px, EČV 140–180 px, čas 180–220 px, kontakt 200–280 px, VIN 240–300 px, adresa a pokyn pružné cez potrebnú šírku. Grid 12 stĺpcov alebo zodpovedajúci existujúci CSS grid, rovnaké medzery a výšky. V mobile jeden stĺpec a dotykové plochy aspoň 44 px.

Dlhé zoznamy vodičov, techniky a partnerov musia byť hľadateľné, s celým názvom vo výsledku. Neaktívna historická hodnota ostane čitateľná; nový výber ju neponúka ako aktívnu. Otvorenie menu nemá meniť hodnotu, dropdown sa neoreže okrajom tabuľky/panelu, Escape ho zavrie a fokus sa vráti. Klávesnicové ovládanie a ikony nevyžadujú myš.

### 5.2 Konkrétne výbery z Erosovho dokumentu

| Číselník | Požadované možnosti | Postup |
|---|---|---|
| Typ objednávateľa | Asistenčná služba / Samoplatca; samoplatca môže byť pravidelný partner alebo jednorazový klient. | Výslovný typ, nie odhad podľa neprítomnosti partnera. |
| Asistenčné služby | Europ Assistance, AWP, Axa Assistance, Eurocross Assistance, ASA, Global Assistance. | Použiť existujúce kontakty/partnerov podľa ID; pri asistencii samostatná referencia. |
| Pravidelní samoplatcovia | Zeppelin, Ramirent, Mateco, Bestrent, Hedin Automotive Prešov, Hedin Automotive Bratislava, Motorr Žilina, Tatring s.r.o.; Iný klient. | Nezamieňať „partner“ za asistenčku; jednorazové meno možno doplniť bez vytvárania globálneho partnera. |
| Pobočky | Bratislava, Žilina, Považská Bystrica, Prešov, Zvolen. | Porovnať s aktívnymi pobočkami; nezakladať duplicity. |
| Zásahové vozidlá | Iveco Daily žlté; Iveco Daily červené; Renault Master dvojkabína; MB Atego; MAN 16t starý; MAN s rukou 18t nový; MAN 12t malý; Iveco špeciál; MB Actros 26t; Fuso čierne; Citroen Jumper; Fuso žlté dvojkabína; DAF XB; Audi Q7; VW Touareg; SUV + vozík. | Mapovanie na existujúcu flotilu a oprávnenú techniku; nevymýšľať EČV ani kopírovať vozidlá z iného systému. |
| Parkoviská pri uložení | Prešov, Zvolen, Žilina, Bratislava Dúbravka, Bratislava Zlaté piesky. | Potrebná overená konkrétna adresa, nie iba mesto. Podmienka existuje už dnes. |
| Predvoľby úkonov | Odťah; Cestná služba – oprava na mieste; Preprava stroja/materiálu; Uloženie vozidla; Preťah vozidla. | Viac realizovaných položiek, parkovisko pri uložení a cieľ pri preťahu. Kancelária upraví fakturačný text a cenu každej položky. |

AWP ako objednávateľ a AWP **iba evidencia externého výkonu** sú odlišné údaje. Výber AWP nesmie automaticky meniť pôvod výkonu. Zachovať dnešnú ochranu pred druhým vyslaním vodiča pre evidenčný záznam.

### 5.3 Viac realizovaných úkonov bez finančných oprávnení vodiča

Dnešné `serviceType` ostane hlavným druhom zákazky. Viac vybraných úkonov potrebuje samostatné perzistentné **realizačné položky**: vlastné ID, druh úkonu, množstvo/jednotka, praktický opis a podľa druhu konkrétne parkovisko alebo cieľ. Položky neobsahujú cenu, daň ani schválenie fakturácie. Dispečer ich predvyplní; pridelený vodič doplní vykonané úkony a množstvá počas vlastného otvoreného zásahu.

Kancelária z potvrdených realizačných položiek pripraví návrhy existujúcich cenových `lines`, upraví fakturačný text, cenu a DPH a samostatne ich schváli. Opakované prevzatie rovnakého realizačného ID nepridá duplicitný cenový riadok; manuálne kancelárske riadky sa automaticky neprepisujú. Cenové riadky zostávajú mimo vodičovho zápisového oprávnenia.

Serverová validácia vyhodnotí **všetky** realizačné položky, nie iba hlavné `serviceType`: uloženie vyžaduje konkrétne parkovisko; preťah/preprava potrebujú cieľ a príslušné podklady. Neznáme údaje majú existujúcu zdôvodnenú výnimku tam, kde ju prevádzkový kontrakt povoľuje. Testovať najmä odťah + uloženie a odťah + preťah; voľba vedľajšieho úkonu nesmie obísť jeho podmienky.

V tejto etape sa číselníky iba špecifikujú. Implementácia najprv pripraví porovnanie existujúcich záznamov a úzku konfiguráciu; plán nepovoľuje seed nad kopírovaným snapshotom ani vzdialené SQL.

### 5.4 Vozidlo, majiteľ a mobilné dopĺňanie

Zachovať značku/model, EČV a VIN; doplniť **najazdené kilometre** a prípadný praktický opis predmetu. Stroj/materiál nevyžaduje fiktívnu EČV alebo VIN. Rozlíšiť objednávateľa, majiteľa, fakturačného odberateľa a príjemcu auta bez štvornásobného prepisovania rovnakého kontaktu.

Natívna karta dostane presne potrebnú projekciu a príkazy pre doplnenie povolených údajov. Dnešný allowlist zámerne povoľuje iba časy, cieľ, množstvo a poznámku; doplniť formulár bez serverovej zmeny by nefungovalo. Majiteľove adresné a identifikačné údaje sú obmedzené aj v serverovej projekcii ([projekcia vodiča](../../src/server/towing/service.ts:76)); zmeniť čítanie a zápis spoločne pre vlastné aktívne pridelenie, nie sprístupniť celý spis.

IČO sa viaže na firmu. Dokument žiada aj rodné číslo fyzickej osoby: pred touto časťou treba potvrdiť presný formulár a oprávnený prístup. Toto neblokuje ostatné vozidlové, kontaktné a prevádzkové polia; identifikátor sa nezobrazí v knihe ani notifikáciách.

## 6. Platby, hotovosť a kancelárske dokončenie

### 6.1 Plánovaný spôsob úhrady je samostatný údaj

Navrhnúť typovaný `paymentIntent` oddelene od skutočných prijatých platieb:

| Požiadavka | Voľba v rozhraní | Čo samotný výber urobí |
|---|---|---|
| Faktúra – partneri | Faktúra partnerovi | Uloží dohodu; nevytvorí faktúru ani úhradu. |
| Poslať faktúru – potom zaplatia | Faktúra s neskoršou úhradou | Označí ďalší postup kancelárie. |
| Uhradené kartou – terminál | Karta cez terminál | Úhrada vznikne až samostatným potvrdením skutočného príjmu. |
| Uhradené v hotovosti – terminál | Hotovosť s terminálovým dokladom | Rovnaké oddelenie; potvrdená hotovosť sa priradí vodičovi. |
| Iné – hotovosť | Iná hotovosť + poznámka | Potvrdená hotovosť ide do existujúceho účtu vodiča; nemení automaticky fakturáciu na „bez fakturácie“. |

Dnešné druhy prijatej platby `cash/card/bank/other` zostanú základom účtovnej evidencie. Platobná dohoda a jej označenie nie sú dôkazom prijatej sumy. Nepripája sa nový terminál ani účtovný poskytovateľ. Význam „bez dokladu“ sa pred dokončením tejto jednej voľby spresní.

### 6.2 Natívny príjem a hotovosť

Na natívnom mobile doplniť samostatnú operáciu skutočného príjmu s čiastkou, spôsobom, potvrdením a stabilným identifikátorom potvrdenky. Webový vodič dnes môže prijímať hotovosť; natívny mobil nesmie zostať iba pri výbere zámeru. Prípadný zápis kartovej úhrady vodičom vyžaduje cielené rozšírenie dnešného serverového oprávnenia; karta sa nikdy nepripíše ako držaná hotovosť.

Zachovať vlastné pridelenie, jeho generáciu, limity prijímania, opakovanie po stratenej odpovedi a audit. Potvrdený príjem sa započíta raz. Neistý/offline príjem má stav čakania a po obnove sa overí ten istý zápis. Pre odovzdanie zásahu vyriešiť jeho nepotvrdené platby a prílohy; zákazka nezmizne iba na základe lokálneho kliknutia.

Prehľad vodiča ukáže potvrdenú hotovosť, rezervované a dostupné prostriedky. Odovzdanie kancelárii ostáva návrh → potvrdenie/odmietnutie; presun držby nie je druhá zákaznícka úhrada. Opravy a refundácie využijú existujúce odôvodnené operácie.

### 6.3 Ceny, doklady, podpisy

V nacenení zobraziť riadky s upraviteľným názvom, množstvom, jednotkou a jednotkovou cenou; vedľa seba **bez DPH · DPH · s DPH**. Predvoľba úkonu vloží text, nie náhodnú cenu. Použiť existujúci výpočet a schválenú daňovú konfiguráciu podľa uloženého dátumu.

Po odovzdaní vodičom je zákazka na kontrolu. Kancelária doplní údaje, schváli položky a cenu, potom eviduje externú faktúru. Tento plán nevytvára nový fakturačný systém. Zákazkový list sa dá stiahnuť a poslať potvrdenému príjemcovi existujúcou cestou. Automatický e-mail servisu po podpise zostáva odložený, kým nebude dohodnutý spúšťač, adresa, verzia dokumentu a ochrana proti opakovaniu.

Papierový podpísaný protokol ostáva použiteľný. Digitálny variant má zachytiť skutočného príjemcu, miesto, čas a podpis alebo dôvod výnimky; nevyžaduje podpis neprítomného klienta pri každej nakládke. Automatická firemná pečiatka sa nesmie prezentovať ako potvrdenie príjemcu.

## 7. Klientské požiadavky: odovzdanie práce, mobil a každodenná obsluha

### 7.1 Jeden prípad, viac príjemcov a pobočkový tok

V detaile prípadu vytvoriť spoločný vstup **Odovzdať prácu**. Zvolený odťah a náhradné vozidlo navrhnú samostatné karty zadaní. Každá obsahuje druh práce, cieľ pobočka/človek, vlastný pokyn, požadovaný termín a potrebné miesta. **Pridať ďalšiu prácu** nesmie byť obmedzené na presne dve karty; čísla štyri/osem z prepisu nie sú dohodnutým tvrdým limitom. Vytvorenie prípadu iba pripraví návrh, samo nerozpošle prácu.

Pred odoslaním ukázať súhrn všetkých príjemcov. Každá karta má stabilné vlastné ID príkazu a výsledok **odoslané / odmietnuté / výsledok nepotvrdený**. Pri čiastočnom úspechu zachovať potvrdené zadania a opakovať iba ten istý nepotvrdený zápis. Pridať ďalšie zadanie musí ísť aj pri už aktívnej práci, bez prepisovania jej príjemcu. Staré legacy odovzdanie a jeho limit sa neobchádzajú vypnutím ochrany; použiť existujúce samostatné pracovné požiadavky a výkony.

Pobočkovú cestu zachovať: čaká vo fronte → prevzal miestny dispečer → pridelené človeku → prijaté vykonávateľom → prebieha → dokončené. Vedúci môže použiť existujúci presun na inú oprávnenú pobočku. Pri pristavení môže byť konkrétne auto zatiaľ neurčené. Pri odťahu zákazku a vodiča riadi oprávnená odťahová kancelária; nový spoločný formulár tieto existujúce príkazy poskladá a nezvýši práva bežnému vedúcemu.

V prípade ukázať všetky jeho práce, príjemcu, pobočku, termín a aktuálny stav. Pobočka dostane iba potrebný koordinačný súhrn druhej práce, nie jej cudzie prílohy alebo financie. Prijatie/dokončenie jedného zadania neuzavrie druhé ani automaticky celý prípad. Zjednotenie vychádza z dnešných [samostatných panelov prípadu](../../src/components/dispatch/CaseDetail.tsx:744) a [pobočkového modelu](../../src/domain/work-groups.ts:8).

### 7.2 Praktická karta pristavovača aj odťahovkára

Pri **novšej logistickej jazde** doplniť do serverovej projekcie, prenosového typu aj obrazovky názov asistenčky a jej referenciu. Sú to údaje, ktoré odťahová a staršia handoff karta už poznajú; rozšírenie iba odťahovej karty nesplní požiadavku zo stretnutia. Zobraziť samostatne **Interné číslo prípadu** a **Číslo prípadu asistenčky**; chýbajúcu referenciu označiť ako nevyplnenú.

Karta vykonávateľa má poradie: stav a termín → vozidlo/EČV → asistenčka/objednávateľ a referencia → kontakt + Zavolať/Navigovať → vlastný pokyn → hlavný krok → doplňujúce údaje/doklady. Dostupná je iba pridelená práca a potrebné údaje. Doplniť pokyn aj v pobočkovej odťahovej ceste, kde sa dnes nekopíruje do vytváranej zákazky. Nové polia majú nullable kontrakt a zachovajú starších klientov.

Tento bod sa dodá samostatne v G; nečaká na D1 ani nové hotovostné funkcie E. Dôkaz medzery je [logistická projekcia](../../src/server/mobile/field-work.ts:95) a [mobilný typ](../../src/lib/mobile-api.ts:487).

### 7.3 Blokovaná ďalšia jazda: vysvetlenie a cesta k riešeniu

Existujúce slovenské hlášky rozšíriť o typ konfliktu a podľa oprávnenia identitu blokujúceho výkonu: druh, ID, číslo a možnosť otvorenia. Na mobile aj webe zobraziť **Otvoriť rozpracovanú prácu**. Pri kolízii plánovaného termínu alebo vozidla namiesto výzvy dokončiť budúcu jazdu ponúknuť spojenie s dispečerom a zmenu plánu. Ak používateľ blokujúci výkon nesmie čítať, ukázať dôvod a kontakt na dispečera bez sprístupnenia cudzieho spisu.

Viac pridelených úloh je dovolený front; zachovať serverové obmedzenie fyzicky súbežnej práce. Nesprístupniť dve rozbehnuté práce ako riešenie chýbajúcej navigácie. Základ hlášok už obsahuje [server mobilnej práce](../../src/server/mobile/field-work.ts:62); nové vysvetlenie musí fungovať aj po odmietnutí príkazu a opätovnom načítaní, so zachovaním konceptu.

### 7.4 Notifikácie a viditeľný priebeh

Použiť existujúci push pre novú pobočkovú prácu, pridelenie človeku, prepridelenie, vrátenie, zrušenie, pripomenutie a eskaláciu. Overiť konkrétnych príjemcov: oprávnení vedúci danej pobočky s odberom novej práce; následne konkrétny vykonávateľ. Pri prepridelení starý človek stratí prístup a nový dostane správne zadanie. Skontrolovať kategórie upozornení, registráciu zariadenia a otvorenie správnej karty v správnom účte/prostredí.

Centrála musí vidieť, že pobočka prácu prevzala, človek ju prijal a začal vykonávať. Tieto udalosti sa čítajú zo skutočného pracovného toku; odoslaný Expo ticket ich nenahrádza. Aktuálny push automaticky neoznamuje každú zmenu stavu centrálnej skupine; nepridávať plošné zvonenie všetkým. Prípadnú medzeru najprv doložiť konkrétnym scenárom.

Opraviť zastaraný webový text, že mobilné upozornenia ešte len prídu. Pri vypnutom push je práca naďalej v zozname s možnosťou obnovy; neodoslanie oznámenia nesmie zrušiť už potvrdené zadanie. Overenie má vlastnú dodávku J a používa [existujúci front](../../src/server/mobile/push-outbox.ts) a [mobilné ciele](../../mobile/src/notifications/taps.ts).

### 7.5 Kratšie pristavenie, časové údaje a poloha

Cieľový návrh pre **pristavenie** je **Prijať → Vyrážam → Auto odovzdané**. Vykonanie odťahu aj vyzdvihnutie auta si ponechajú svoje potrebné kroky a kancelársku kontrolu. Pred zmenou spísať mapovanie dnešných stavov a príkazov; samotné skrytie tlačidla „Som na mieste“ nesmie zablokovať následné dokončenie. Nezaznamenať fiktívny príchod alebo čas odvodený iba z GPS; prípadný chýbajúci čas zostane neznámy alebo sa označí podľa výslovného potvrdenia.

Dnes sa logistická poloha povoľuje už od prijatia, prepis opisuje začiatok pri vyrazení. Výslovne určiť jeden výsledný kontrakt a zhodne upraviť texty, klientský tracker, serverový príjem, ukončenie a prípadné granty. Súčasné pravidlo sa nezmení iba premenovaním tlačidla. Zdieľanie po dokončení, zrušení, odhlásení alebo odobratí pridelenia skončí; starý bod má čas/aktuálnosť a netvári sa ako živá poloha.

Mechanizmus iOS na pozadí existuje; Android má pozadie vypnuté. Overenie iPhonu pri zamknutí, pozadí, odobratom povolení a znovuotvorení je samostatné. Android sa označí podľa skutočne podporovaného režimu; tento plán nepredstiera, že pozadie funguje rovnako všade. Existujúce východiská: [kroky a tracker](../../mobile/src/field-work/model.ts:39), [konfigurácia](../../mobile/app.config.ts:90).

Plánovaný termín, pridelenie a skutočný začiatok/koniec zostanú oddelené. Starý Erosov dokument opisuje automatický začiatok pri pridelení, dnešný kód už vyžaduje skutočný čas; priradenie sa nesmie znovu vydávať za odpracovaný čas ([validácia](../../src/domain/towing/validation.ts:30)).

### 7.6 Usporiadanie prípadu a názvoslovie aj mimo knihy

V detaile prípadu prepojiť **Práca a jazdy**, **Úlohy**, **Poznámky a aktivita** cez existujúcu navigáciu sekcií alebo jej zjednodušenie. V časti práce spojiť prehľad odovzdaní, pobočkových zadaní, logistiky a odťahov tak, aby sa jeden výkon neukazoval ako viac nesúvisiacich kariet a dispečer nemusel hľadať jeho stav na rôznych miestach. Zachovať pôvodné identity, oprávnenia a dostupné detaily; nejde o nový paralelný evidenčný systém.

Pomenovania zjednotiť na **Pristavenie náhradného vozidla**, **Vyzdvihnutie náhradného vozidla**, **Presun vozidla** a **Odťah**; návrh názvu logistického modulu je **Pristavenia a návraty**. Výraz „odstavenie“ sa v prepise neuzavrel, preto ním automaticky nepremenovať odťah ani návrat. Finálny názov je drobný otvorený bod, nie dôvod odkladať funkčné doplnenia.

Kompaktné šírky, zarovnanie polí, rozbalenie len potrebných doplnkov, poradie akcií a zachovanie konceptu aplikovať aj na odovzdávanie práce, pobočkové pridelenie a mobilnú logistickú kartu. Platí rovnaká vizuálna akceptácia L2/L5 ako pri knihe. Konkrétne východiská: [sekcie prípadu](../../src/components/dispatch/CaseDetail.tsx:744), [logistický prehľad](../../src/components/operations/OperationsModule.tsx:99).

### 7.7 PZP: použiteľné neoverenie a samostatné posúdenie automatizácie

Téma zostáva súčasťou spoločného plánu ako samostatná úloha I. Má dve konkrétne časti:

1. **Dokončiť používateľský postup pri neúspechu zdroja.** Zobraziť zdroj, čas a rozdiel medzi overením, nenájdením jednoznačného záznamu, nedostupnosťou, ochrannou kontrolou a limitom. Ručné overenie musí mať dostupnú cestu zo situácie, kde automatika zlyhala; umožniť doplniť overenú poisťovňu bez straty rozpracovaného prípadu. Neúspech nie je dôkazom nepoistenia a neblokuje samotné založenie prípadu. Použiť existujúci [manuálny fallback](../../src/components/dispatch/SkpManualFallback.tsx:26).
2. **Posúdiť spoľahlivejší podporovaný prístup.** Preveriť dostupné oficiálne možnosti, vstupy, limity a potrebu dohody poskytovateľa; výstupom je konkrétny návrh alebo doložená externá závislosť. Rotácia IP, maskovanie robota, obchádzanie CAPTCHA ani suma spomenutá na stretnutí nie sú dohodnutou implementáciou. Do získania podporovaného prístupu ostáva ručná cesta plnohodnotnou náhradou.

Overiť správanie pre SK aj CZ podľa podporovaných zdrojov; nepridávať tvrdenia o poistení tam, kde zdroj výsledok neposkytol. Vývoj používa fixture odpovede, rešpektuje obmedzenie opakovaných pokusov a integračné hranice prostredia.

### 7.8 Vodič a prevádzkové dokončenie

V zozname 1–5 bežných zadaní ukázať stav, dátum pridelenia/termín, vozidlo/EČV, objednávateľa a referenciu. Nie je to nový pevný limit päť. Dokončenie až po uložení požadovaných údajov, potvrdení príloh a vyriešení nepotvrdených finančných pokusov. Po potvrdení serverom zmizne zákazka z aktívnych zadaní vodiča a ostane kancelárii; vrátenie na doplnenie ju správne obnoví.

Distribučné tvrdenia zo stretnutia o App Store, termíne schválenia a OTA nie sú preukázané dnešným stavom. Pri odovzdaní konkrétnej mobilnej verzie sa overí jej dostupnosť pre TEST používateľov. Braňova integrácia je naďalej odložená.

## 8. Implementačné dodávky a konkrétne súbory

| Dodávka | Obsah a výstup | Súbory/hraničné body | Závislosti |
|---|---|---|---|
| **A — kniha a detail** | Kompaktná tabuľka, fázy/farby/ikony a šírky; usporiadané úkony a výbery; príprava rýchlych pohľadov. | `TowingWorkspace.tsx`, `model.ts`, `towing.module.css`, `OrderDetail.tsx`, `OrderFields.tsx`, `primitives.tsx`; nový malý čistý model iba pre odvodenú fázu podľa potreby. | Najprv vizuálny náhľad na fixture alebo zmena vzhľadu existujúceho zoznamu. Nové funkčné rýchle pohľady/počty sa vydajú až s B; nikdy sa nepočítajú len z 50 načítaných riadkov. |
| **D0 — minimálny čitateľný kontrakt** | Identifikovaný typ objednávateľa a partnera, dovolený neznámy typ pre staré dáta, pomenovaný dátum zásahu; podklady pre nové filtre. | `src/domain/towing/types.ts`, `src/server/towing/service.ts`, úzke serverové projekcie a podľa potreby lokálna migrácia. | Pred B. Nerozširuje zatiaľ mobilné finančné zápisy ani hotovosť. |
| **B — filtre a serverové čítanie** | Dátum zásahu, objednávateľ podľa ID/typu, radenie, rýchle pohľady so zodpovedajúcimi počtami/súčtami; oprava hľadania logistiky. | `src/server/towing/service.ts`, `src/domain/towing/types.ts`, relevantné RPC/projekcie; `src/server/operations/index.ts`, `OperationsModule.tsx`, `operations.module.css`. | D0 a vizuálny základ A. Úzka lokálna migrácia len na potrebné čítanie; TEST SQL až podľa presného projektového schválenia. |
| **C — klientské odovzdanie a pobočky** | K01/K02: opakovateľné zadania, predvyplnenie služieb, termín, pobočka/človek, výsledok každej položky a bezpečný retry; pokyny aj pre odťah, spoločný priebeh prípadu. | `CaseHandoffPanel.tsx`, `BranchWorkspace.tsx`, `CaseDetail.tsx`, `src/server/branches/service.ts`, `src/server/web-case-handoff.ts`, odťahová služba a úzke kontrakty. | Použiť existujúce owners; C nečaká na finančné D1/E ani na hotový redizajn knihy. |
| **G — klientské mobilné údaje a blokovanie** | K03/K04: asistenčka/referencia v novšej logistike, vlastný pokyn a praktické poradie karty; typ konfliktu, blokujúca práca a otvorenie, ak je oprávnené. | `src/lib/mobile-api.ts`, `src/server/mobile/field-work.ts`, `mobile/src/field-work/api.ts`, `module.tsx`, `parts.tsx`, existujúce chyby a pobočková projekcia. | Samostatná skorá dodávka; nepotrebuje nové peňažné kontrakty D1/E. Zmeny mobilu aj servera musia byť kompatibilné so staršími klientmi. |
| **H — jednoduchšie pristavenie a poloha** | K05/K06: presné mapovanie skrátených krokov, správne časové údaje, jednotný začiatok/koniec polohy a označenie obmedzení platformy. | `mobile/src/field-work/model.ts`, `module.tsx`, `session.ts`, existujúci tracker v `mobile/src/delivery/`, serverové operation commands/tracking a staršie delivery kontrakty. | Najprv uzavrieť konkrétny stavový kontrakt z 7.5; zachovať odťahové/vyzdvihovacie kroky a spätnú kompatibilitu. |
| **D1 — Erosove údaje a číselníky** | Kilometre, samostatné realizačné položky bez cien, ich predvoľby a preberanie do nacenenia, platobný zámer, identifikované výbery. | `src/domain/towing/`, `OrderFields.tsx`, `OrderDetail.tsx`, serverové validačné allowlisty a úzke migrácie. | Nadväzuje na D0; realizované úkony nie sú vodičom editované cenové riadky. Nerobiť hromadnú rekategorizáciu podľa názvu. |
| **E — Erosove mobilné doplnenie a úhrady** | Povolená editácia vozidla/majiteľa a realizačných položiek, vlastné potvrdenky a hotovostný prehľad. | `mobile/src/field-work/`, `src/lib/mobile-api.ts`, `src/server/mobile/field-work.ts`, `src/server/towing/service.ts`, mobilné API routes; existujúci vault/outbox. | Nadväzuje na D1 a skoré G; regresie pre oprávnenia, prepridelenie a offline. |
| **F — protokol klienta aj Erosa** | K07: papierový tok, potvrdenie príjemcu v servise, nové povolené údaje PDF, prípadne samostatný digitálny podpis. | `src/server/towing/pdf-template.ts`, document pipeline, existujúce prílohy a mobilné uploady. | Vydané PDF nemeníme spätne. Podpis možno oddeliť od prvého nasadenia knihy; klientsky proces odovzdania sa tým nestratí. |
| **I — PZP a náhradná cesta** | K09: rozlíšenie stavov zdroja, dokončenie ručného overenia na dotknutých obrazovkách, posúdenie podporovaného automatického prístupu. | `SkpManualFallback.tsx`, `VehicleLookupControl.tsx`, `VehicleLookupDetails.tsx`, `mobile/src/tools/lookup.tsx`, existujúce vehicle-lookup kontrakty/fixture testy. | Nečaká na Erosa; automatický prístup môže mať externú závislosť, používateľský fallback sa dodá samostatne. |
| **J — notifikácie a spoločné TEST prijatie** | K02/K06: správni príjemcovia, otvorenie karty, potvrdený stav práce v centrále, odstránenie zastaraných textov; spoločný scenár klient + Eros. | Existujúce `src/server/mobile/push*.ts`, `mobile/src/notifications/`, pobočky a integračné TEST scenáre. | Overuje každú uvoľňovanú dodávku; finálne prijatie zahŕňa obidva zdrojové podklady, nie iba kompaktnú tabuľku. |

**Spoločné poradie a závislosti:**

1. **Klientsky prevádzkový základ C + G:** viac zadaní, pobočková zodpovednosť, chýbajúce logistické údaje, pokyny a vysvetlenia. S každou pripravenou časťou priebežné J. Táto vetva sa nezačne až po celej Erosovej knihe.
2. **Vizuálna vetva A a dátový základ D0 → B:** kompaktná kniha, usporiadanie všetkých dotknutých formulárov, serverové filtre/radenie/súčty. A/D0 možno pripravovať súbežne s klientskym základom; nové funkčné rýchle pohľady čakajú na B.
3. **Klientske zjednodušenie H a používateľská časť I:** uzavretý stavový kontrakt pristavenia/polohy, pravdivé obmedzenia a použiteľné PZP. I je nezávislá od platieb aj podpisov.
4. **Erosove doplnenia D1 → E:** realizačné položky, platobný zámer, potrebné údaje a natívna obsluha skutočných úhrad/hotovosti. Skoré G zostáva samostatne vydané aj pri dlhšom vývoji E.
5. **F a spoločné prijatie J:** odovzdanie auta príjemcovi a doklady; test od založenia prípadu cez rôznych príjemcov až po kancelársku kontrolu. Rozšírený podpis na displeji možno oddeliť, nie ním blokovať predchádzajúce dodávky.

Každá dodávka má vlastný overiteľný diff, akceptačné body a TEST handoff. K08 (názvoslovie a usporiadanie) sa rieši pri A/B/C/G naprieč obrazovkami. Body K01–K09 sú evidované v tomto pláne aj pri postupnom vydávaní; dokončenie samotnej Erosovej knihy neuzavrie celý rozsah. Braňov adaptér sa nepridáva do žiadnej dodávky.

## 9. Akceptačné scenáre

| ID | Čo musí byť overiteľné |
|---|---|
| L1 | Pri 1440 × 900 má kniha na reprezentatívnej fixture aspoň 12 plných riadkov; bežná výška 40–44 px, čitateľný text a viditeľná hlavička. |
| L2 | Pri 1280/1024/768/390/320 px stránka nepresahuje viewport; prípadný posuv je iba v tabuľke. Detail, filtre a tlačidlo uloženia zostávajú dostupné. |
| L3 | Každá zo šiestich Erosových fáz je na fixture odlíšená farbou, textom a ikonou. Pridelené a už zaplatené auto zostáva aktívnou prácou, nie zeleným hotovým riadkom. |
| L4 | Dlhá asistenčka, dlhá adresa, VIN, mena vodiča a 999 999,99 € nevytlačia akcie ani neprekryjú susedný stĺpec. Úplné hodnoty sú dostupné bez hover-only závislosti. |
| L5 | Výbery/overlay fungujú cez klávesnicu, Escape, návrat fokusu aj dotyk; menu sa neoreže panelom. Pri 200 % priblížení nie sú kľúčové akcie skryté. |
| L6 | V detaile prípadu možno prejsť medzi prácou/jazdami, úlohami a poznámkami/aktivitou bez straty konceptu. Pobočkové zadanie aj súvisiaci odťah/logistika sú dohľadateľné z rovnakého kontextu; pomenovania a šírky polí sú zhodné na zodpovedajúcich obrazovkách. |
| Q1 | Záznam mimo prvých 50 položiek sa nájde textom aj filtrom; číslo, VIN/EČV a objednávateľ fungujú v knihe aj príslušnej logistickej ceste. |
| Q2 | Kombinácia pobočka + vodič + objednávateľ + obdobie má rovnakú množinu pre počet, riadky a súčty, aj cez viac strán. |
| Q3 | Zmena radenia platí na celý výsledok; zhodné dátumy/sumy majú stabilné poradie podľa ID. Opakované čítanie rovnakého stavu nemení rozdelenie strán. |
| Q4 | Založenie, plánovaný budúci termín a skutočný zásah v rozdielnych dňoch sa správne nájdu podľa zvoleného dátumu. Overiť hranice miestneho dňa a prechodu času. |
| Q5 | Vodič/obdobie zobrazí výkony, faktúry a príjmy oddelene; neznáme ceny sú „—“, nepotvrdený príjem a hotovostné odovzdanie sa nesčítajú ako tržba. |
| H1 | Jeden prípad: pristavenie pobočke, odťah vodičovi a tretie zadanie; každý má iný pokyn/termín a vlastný stav. Druhé zadanie neprepíše prvé. |
| H2 | Prerušenie po uložení iba časti dávky: opakovanie potvrdí existujúce položky, nevytvorí duplicity. Zmena príjemcu nevystaví cudzie pokyny. |
| H3 | Prípad s odťahom a náhradným vozidlom predvyplní dva odlišné návrhy zadaní, nič sám neodošle. Používateľ pridá ďalšie karty aj popri už aktívnom zadaní. |
| H4 | Nové zadanie pobočke vidia dvaja oprávnení vedúci; súbežné prevzatie má jedného vlastníka. Ten pridelí človeka alebo povolene presunie požiadavku. Centrála vidí skutočný priebeh; iná pobočka nečíta cudzie prílohy a financie. |
| K3 | Pristavenie z novšieho pobočkového/logistického toku ukáže v API aj mobile asistenčku a jej referenciu oddelene od interného čísla. Chýbajúca referencia je nevyplnená. Vlastný pokyn dostane aj príjemca odťahového zadania. |
| K4 | Pri súbežnej práci ukáže web aj mobil presný dôvod a otvorí dostupnú blokujúcu jazdu/zákazku. Pri kolízii budúceho termínu/vozidla sa nezobrazí nesprávna výzva dokončiť budúcu prácu; neprístupný výkon neodhalí cudzie údaje. |
| K5 | Pristavenie možno dokončiť podľa schváleného kratšieho sledu aj po opakovaní príkazu; nevyžaduje skryté staré tlačidlo ani fiktívny čas príchodu. Starší klient a tok vyzdvihnutia/odťahu naďalej fungujú. |
| K6 | Po dokončení, zrušení, odhlásení alebo odobratí pridelenia sa zdieľanie polohy ukončí a starý token neobnoví zrušenú prácu. Posledná poloha má čas/aktuálnosť; nepodporovaný režim na platforme sa jasne oznámi. |
| D1 | Neúplný návrh sa uloží; pridelenie hlási konkrétne chýbajúce minimum; materiál nevyžaduje EČV, uloženie vyžaduje konkrétne parkovisko. |
| D2 | Samoplatca môže mať pravidelného partnera; zvolená asistenčka má oddelenú referenciu. Výber AWP nemení sám pôvod výkonu ani nevysiela evidenčný záznam. |
| D3 | Vodič uloží viac realizačných položiek a množstvá bez cien. Pri kombinácii odťah + uloženie je vyžadované parkovisko aj pri hlavnom type odťah. Kancelária prevezme položky bez duplicít, upraví ich text/cenu; vodič nemôže meniť cenové riadky. Netto + daň = brutto podľa existujúceho presného výpočtu a uloženého dátumu. |
| M1 | Vodič vidí iba vlastné aktívne zadania, termín, vozidlo a objednávateľa/referenciu; doplní povolené údaje a neuvidí cudzie financie ani celý spis. |
| M2 | Vodič má naraz aspoň päť pridelených fixture zákaziek, no fyzicky rozbehnutý konflikt ukáže vysvetlenie a dostupnú blokujúcu prácu. |
| M3 | Po serverom potvrdenom odovzdaní zákazka zmizne z aktívneho zoznamu; pri chybe uloženia/uploadu/platby nezmizne. Vrátenie z kancelárie ju vráti správnemu vodičovi. |
| P1 | Výber každého z piatich platobných zámerov nemení `receivedCents`, stav faktúry ani hotovostný účet. |
| P2 | Skutočný príjem hotovosti zvýši vlastný účet raz; opakovanie po strate odpovede nevytvorí druhý príjem. Karta nezvýši držanú hotovosť. |
| P3 | Vodič po prepridelení nedokončí starý príjem ani neupraví bývalú zákazku. Offline/neistý stav sa nevydáva za potvrdenú úhradu. |
| P4 | Návrh odovzdania hotovosti rezervuje sumu, potvrdenie zmení držbu a nevytvorí novú zákaznícku platbu. Oprava vyžaduje dôvod a zachová históriu. |
| F1 | Kancelária skontroluje a schváli cenu, zaeviduje externú faktúru a vydá zákazkové PDF; stav „Vyfakturované“ neznamená „Zaplatené“. |
| F2 | Papierový protokol sa nahrá a sprístupní oprávnenému používateľovi. Nová verzia PDF zachová starú vydanú verziu; odoslanie uvádza skutočný výsledok poskytovateľa. |
| F3 | Pri vyzdvihnutí bez klienta možno evidovať oprávnený dôvod jeho neprítomnosti; pri odovzdaní servisu je zaznamenaná skutočná preberajúca osoba, čas a papierový/digitálny podklad alebo povolená výnimka. Firemná pečiatka sa nevydáva za podpis príjemcu. |
| N1 | Fyzický telefón: správna pobočka dostane nové zadanie, vodič pridelenie, po prepridelení sa zmení prístup. Ťuk otvorí správnu kartu; vypnutý push nezmaže prácu. |
| N2 | Pri úprave krokov/polohy fyzicky overiť začiatok, ukončenie, zamknutie, návrat appky, odhlásenie a odobraté pridelenie na každej podporovanej platforme. |
| N3 | Prijatie pobočkou, prijatie vykonávateľom a štart sa prejavia v centrálnom stave práce. Samotné úspešné odoslanie pushu ich nevytvorí. Pri vypnutom push ostane zadanie v správnom zozname a stale notifikácia neotvorí nesprávny účet alebo bývalé pridelenie. |
| V1 | Fixture ochranná kontrola/limit/nedostupnosť/nejednoznačný výsledok PZP majú rozdielne pravdivé vysvetlenia. Žiadna z týchto odpovedí sa neprezentuje ako nepoistené vozidlo. |
| V2 | Po neúspešnom automatickom overení možno prejsť na ručné overenie a doplniť overenú poisťovňu bez straty konceptu; prípad možno uložiť aj s neovereným PZP. Opakované pokusy rešpektujú existujúce obmedzenia. |

## 10. Overenie a riziká

Použiť existujúce kontraktné a unit testy, najmä `src/domain/towing/money.test.ts`, `src/server/towing/workspace.test.ts`, `src/server/mobile/field-work.test.ts`, `mobile/src/field-work/commands.test.ts`, `model.test.ts`, uploady a `tests/postgres/towing-work-orders.py`. Dopísať regresie pre nové chovanie, nie testy kopírujúce CSS.

Klientsku vetvu overiť aj cez existujúce `src/server/web-case-handoff.test.ts`, `src/server/mobile/field-branch.test.ts`, `tests/postgres/branch-work-groups.py`, `tests/postgres/mobile-work-push.py`, mobilné notification tap a tracker testy. Pri PZP využiť existujúce zdrojové fixture testy a explicitne otestovať pokračovanie v rozpracovanom prípade; samotný screenshot knihy nepreukazuje splnenie klientskych bodov.

Vizuálne overenie stojí na dnešnom [towing harness](../../e2e/towing-ui.spec.ts:18) a [operations layout harness](../../e2e/operations-layout.spec.ts:13). Rozšíriť reprezentatívne fixture dáta na 50+ záznamov a kombinácie stavov; overiť veľkosti, počet viditeľných riadkov, otvorené menu, dlhý detail a reálne dostupné akcie. Na samotnú browserovú kontrolu používať `agent-browser` s vlastnou session.

Po implementácii cielené testy → typecheck/lint → existujúca build brána → syntetické browserové scenáre → stabilný TEST s konkrétnym `dev` commitom. Nespúšťať plošný release iba pre zmenu vzhľadu. V tejto plánovacej etape sa testuje koncept a čítajú zdroje; žiadne živé integračné overenie nie je deklarované.

| Riziko | Konkrétne opatrenie |
|---|---|
| Príliš veľa údajov v úzkom riadku | Zoskupené stĺpce, najviac dva riadky, voliteľné stĺpce, celý detail a testy viacerých šírok. |
| Zelená fáza skryje rozbehnutú prácu alebo dlh | Čistý model fázy s regresiami pre predplatbu, čiastočnú platbu, storno a výnimky. |
| Nové mobilné polia obídu dnešné obmedzenia | Typovaná projekcia a allowlist pre vlastné aktívne pridelenie; testy cudzej a odobratej zákazky. |
| Duplicitná platba alebo práca po výpadku | Existujúci príkaz/receipt ID a generácia pridelenia; výsledok každej dávkovej položky. |
| Filtre ukazujú inú sumu než report | Rovnaký serverový predikát, pomenovaný druh súčtu a presná dátumová báza/časové pásmo. |
| Dokument predpokladá inú konfiguráciu než dnešné prostredie | Porovnať katalógy a migračný stav, nič neseedovať naslepo. |

TEST odovzdanie: **https://test.dispecing.linkapomoci.sk**, otestovaný commit, návod pre dispečera/vodiča/fakturáciu, výsledky a limity. Produkcia čaká na výslovné schválenie konkrétneho rozsahu. Každá budúca SQL zmena vyžaduje presný schválený cieľ a SQL podľa pravidiel repozitára; TEST `nzpnqdstvkfncflgqlny`, produkcia `ifpaeegaesdmljfkdvcn`. Plán nič neaplikuje.

## 11. Otvorené body, ktoré neblokujú prvý redizajn

1. Význam „Iné/bez dokladu“ a finálne označenie tejto jednej platobnej voľby.
2. Presný osobný identifikátor majiteľa a oprávnenia k nemu.
3. Skutočné aktívne položky a adresy číselníkov; v dokumente nie sú všetky adresy ani EČV techniky.
4. Finálny názov logistiky a pravidlo začiatku zdieľania polohy.
5. Podpis priamo na displeji a automatická kópia servisu sú nad rámec už fungujúceho papierového toku; prvá kompaktná kniha na ne nečaká.

Braňo je zámerne odložený. Zachovať existujúci pravdivý náhľad `not_connected`; nerozširovať ho v tomto pláne.

## 12. Vizuálny návrh a vykonaná kontrola

Pripravený je samostatný [klikací HTML návrh](../../.context/eros-kniha-navrh.html), [desktopová snímka](../../.context/eros-concept-1440.png), [detail s usporiadanými výbermi](../../.context/eros-concept-detail-1440.png) a [úzky webový náhľad](../../.context/eros-concept-390.png). Ide o prototyp s 24 ukážkovými záznamami, nie zmenu aplikačného komponentu alebo hotový natívny mobil.

| Overenie prototypu | Výsledok |
|---|---|
| 1440 × 900 | Riadok 43 px, 13 celých riadkov vo viditeľnej ploche tabuľky, začiatok tela približne 285 px. |
| 1280 a 1024 × 900 | Riadok 43 px, 13 celých riadkov; žiadny vodorovný posuv celej stránky. |
| 768 × 900 | 12 celých riadkov; širšia tabuľka sa posúva iba vo vlastnom kontajneri. |
| 390 a 320 px | Prechod na karty; dokument sa nerozťahuje do šírky. Polia detailu zostávajú vo viewporte. |
| Detail | Panel 620 px na desktope; polia približne 271 px. Pri 390 px má panel šírku obrazovky a hlavná akcia plochu 44 px. |
| Hľadanie | `TEST24` vrátil jediný zásah; nenájdený výraz zobrazuje prázdny výsledok s možnosťou zrušiť filtre. |
| Filtre/radenie | Pobočka Žilina vrátila päť ukážkových zásahov; zostupné radenie sumy správne začalo položkami 24, 23, 22. |
| Výbery/formulár | Výber Uloženie sprístupnil parkovisko; nový lokálny návrh zvýšil počet z 24 na 25 a pravdivo oznámil uloženie iba v prototype. |

Podrobné meranie: [JSON dôkaz](../../.context/eros-layout-evidence.json). Východiskové snímky sú [súčasná kniha](../../.context/eros-current-1440.png) a [súčasný detail](../../.context/eros-current-detail-1440.png), vykreslené zo skutočného komponentu so syntetickými dátami. Počet celých riadkov v návrhu zohľadňuje aj orezanie vlastným kontajnerom tabuľky.

Prototyp overuje rozloženie, nie serverové oprávnenia, daňové nastavenie, peňažný ledger, živé SMS/e-maily, push alebo natívnu polohu. Jeho ilustračné sumy nie sú predvolenou sadzbou aplikácie. Dlhé vyhľadateľné katalógy, finančné príkazy a celý pracovný tok sa overia až pri konkrétnej implementácii podľa scenárov vyššie. Existujúce unit testy ani celá build brána sa pre túto dokumentačnú etapu nespúšťali.

## 13. Realizácia spoločnej dodávky

Vetvy A/B/C/D0/D1/E/F/G/H/I/J sú implementované v spoločnej pracovnej vetve. Detaily skúšania a hranice dôkazov sú v [TEST postupe](../operations/client-eros-test-2026-11-05.md). Sekcia 12 zachytáva skorší návrhový prototyp pred implementáciou; dôkazom aktuálneho UI sú testy a screenshoty skutočných komponentov.

Zostáva samostatné zariadeniové prijatie nového natívneho buildu a push/polohy na fyzických telefónoch. Podporovaná automatizácia SKP závisí od prístupu poskytovateľa. Braňo a voliteľný podpis na displeji zostávajú odložené podľa rozsahu plánu. Produkčná publikácia čaká na prijatie identifikovaného TEST rozsahu.
