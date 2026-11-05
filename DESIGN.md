# Design

## Source of truth

Status: **Draft**, 2026-11-05. Tento doplnok pokrýva klientské odovzdávanie práce, pobočkový tok, logistické a odťahové mobilné karty, knihu zásahov `/zakazky` a použiteľnosť súvisiacich obrazoviek. Funkčný rozsah vrátane kratšieho pristavenia, blokovania, oznámení, polohy a PZP určuje [spoločný realizačný plán](docs/plans/eros-kniha-zasahov-2026-11-05.md). Braňovo napojenie je odložené. Nejde o redizajn celej aplikácie.

Podklady: majiteľom priložený DOCX „Appka pre odťahovku – Eros (1)“, všetky tri vložené obrázky, prepis stretnutia, [mobilný štandard](docs/mobile/design-standard.md), existujúce komponenty a syntetické browserové zobrazenie skutočného `TowingWorkspace`. Excelový obrázok určuje hustotu, obsah a farby riadkov. Mobilný obrázok určuje hierarchiu karty, nie značku Allianz alebo novú navigáciu.

**Rozsah aktualizácie:** nasledujúci podklad z 26. 10. zostáva zachovaný pre širšiu logistiku, návraty, flotilu a väzby partnerov. Jeho tvrdenia o vtedajšej implementácii sú historické. Pri klientskych požiadavkách, knihe zásahov a nových terénnych doplneniach platia označené doplnky z 5. 11. a spoločný realizačný plán; neprepisujú ostatné schválené hranice.

### Historický východiskový návrh — 26. 10. 2026

**Status: Draft · 26. 10. 2026.** Návrh webového modulu **Pristavenia a odvozy** v existujúcom dispečingu. Dokument pokrýva tento modul a jeho väzby; neurčuje nový dizajn celej aplikácie. Ide o produktový návrh, nie hotovú implementáciu ani overenie živého nasadenia.

Technický realizačný kontrakt bol dopracovaný cez [RALPLAN a sekvenčne schválený architektom aj kritikom](docs/plans/spolocna-aplikacia-20261026.md). Určuje aj dve spresnenia UX: pridelený front jázd sa odlišuje od potvrdenej časovej kapacity; po fyzickom dokončení starším mobilom môže rovnaký úkon na webe zobrazovať „Vykonané · dôkazy čakajú“, kým sa oprávnene doplní evidencia. Prenajaté auto možno plánovať na vyzdvihnutie; voľnosť SWHouse je podmienkou až nového použitia a pripravenosti.

Po opätovnom prečítaní oboch mítingov a workspace **Náhradné vozidlo plán vývoja** určuje širšie poradie, zdrojové požiadavky a akceptáciu [spoločný realizačný plán](docs/plans/spolocna-aplikacia-2026-10-26.md). Zachováva tri piliere: Final CD; odťahy/pristavovanie; vozový park/poškodenia/kalendár. Tento dokument je podrobnejší návrh logistiky v druhom pilieri. Detail návratu auta je odporúčaný návrh na požiadavku majiteľa; míting potvrdzuje pristavenie aj odstavenie, neurčuje všetky kroky návratu.

Final CD, odťahy a pristavenia/odvozy sa podľa aktualizovaného plánu navrhujú a realizujú ako jeden ucelený webový rozsah. Spoločné sú prihlásenie, prípady, klienti, partneri a prepojený priebeh; partnerský výsledok, vykonanie odťahu, odovzdanie náhradného auta a ich financie majú vlastné pravidlá. Menšie TEST vydania sa priebežne spájajú do spoločného scenára A24 v realizačnom pláne.

Podkladom je lokálny checkout `f62ea2a` a tieto existujúce časti:

- [Navigácia dispečingu](src/components/dispatch/DispatchConsole.tsx), [webové prihlásenie a smerovanie rolí](src/app/page.tsx).
- [Odovzdanie z webu pristavovačovi](src/components/dispatch/CaseHandoffPanel.tsx), [existujúce stavy a zverejnená karta](src/domain/case-handoff.ts), [záznam webového rozšírenia](docs/rollout/web-delivery-handoff-2026-10-23.md).
- [Pracovné zákazky odťahovej služby](docs/operations/towing-work-orders.md), [ich typy](src/domain/towing/types.ts) a [existujúci prehľad](src/components/towing/TowingWorkspace.tsx).
- [Flotila](src/components/dispatch/FleetModule.tsx), [dátové typy](src/domain/types.ts), [význam zdrojov a čerstvosti](docs/live-fleet.md).
- [Webové štýly](src/app/globals.css), [architektúra](docs/architecture.md), [pravidlá prostredí a vydávania](AGENTS.md).

**Zistené v kóde:** dispečer už môže odovzdať pristavenie konkrétnemu členovi, sledovať prijatie, priebeh a dostupnú polohu v detaile prípadu. Pristavovač bez dispečerského profilu dnes nemá vlastný webový pracovný priestor. Odťahové zákazky sú súčasťou rovnakého projektu, ale majú vlastný shell. Náhradné autá majú oddelenú obsadenosť Software House a GPS Commander.

**Navrhované:** spoločný prehľad logistickej práce, samostatné odvozy, plán vodičov, webový pohľad pristavovača a dlhodobejšia väzba medzi pristavením a návratom. Ich existencia sa z existujúceho odovzdania neodvodzuje.

Živé prostredia ani samostatná poľská aplikácia odovzdávania vozidiel sa pri príprave návrhu nečítali a nemenili. Staršie dokumenty opisujúce demo alebo historické prostredia neprepisujú aktuálne pravidlá v `AGENTS.md`.

## Brand

Pracovný nástroj Pomoc motoristom: vecný, úsporný, čitateľný pri telefonovaní. Dôveru vytvára jasný zodpovedný človek, čas poslednej zmeny, overiteľný priebeh a poctivé označenie neznámych údajov. Zachovať vizuálny jazyk dispečingu.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Praktická, prehľadná pracovná aplikácia. Zachovať existujúcu žltú `#FCD703`, tmavú navigáciu, svetlé plochy a ikony Lucide. Dôveru vytvára správny kontakt, jednoznačný stav, jasne pomenované peniaze a potvrdený výsledok úkonu. Vyhnúť sa veľkým prázdnym kartám, mnohým sýtym farbám v jednej bunke a nelícujúcim formulárom.

## Product goals

- Dispečer na jednej obrazovke zistí, čo treba pristaviť alebo odviezť, kedy, odkiaľ, kam a kto to vykoná.
- Údaje prípadu, klienta a flotily sa využijú bez opakovaného prepisovania. Všetky pohľady otvárajú ten istý úkon.
- Partnerský konzultačný prípad Final CD zostane merateľný aj vtedy, keď z neho vznikne nový prepojený asistenčný prípad s iným platiteľom a viacerými realizačnými úkonmi.
- Každé odovzdané auto má viditeľný ďalší postup: dohodnutý odvoz, klient vráti sám, prenájom pokračuje alebo termín treba dohodnúť.
- Pristavovač vybaví vlastnú pridelenú prácu aj vo webovom rozhraní tej istej aplikácie.
- Dispečer vidí konflikty vodiča a auta pred pridelením.

Úspech: neexistujú dve aktívne pridelenia toho istého úkonu, dokončenie pristavenia nestratí budúci návrat, zmena termínu nevytvorí druhý odvoz a web nepotrebuje nové prihlásenie či ďalšiu doménu.

Prvá verzia pokrýva web. Nové mobilné funkcie, automatické optimalizovanie trás, automatické posielanie SMS, úplné riadenie prenájmov, digitálne podpisy a sťahovanie dát inej aplikácie sú ďalšie samostatné rozsahy.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Na notebooku vidieť približne 12–14 celých zásahov pri 1440 × 900 bez zmenšenia písma na úroveň Excelového obrázka. Z jedného prípadu pohodlne zadať viac prác. Vodič má v mobile rýchlo rozlíšiť svoje 1–5 zadaní a doplniť potrebné údaje.

Klientsky prevádzkový základ sa prijíma samostatne: pobočka/človek dostane vlastnú prácu a pokyn, pristavovač vidí asistenčku a jej referenciu, blokovaná jazda má zrozumiteľnú cestu k riešeniu a centrála vidí potvrdený priebeh. Kratší postup, poloha a náhradná cesta PZP majú vlastné kritériá v spoločnom pláne; dokončenie samotnej knihy neuzavrie tieto úlohy.

Mimo rozsahu: Braňovo napojenie, nový účtovný systém, integrácia terminálu, nová hlavná navigácia, nový cron. Samotná farebná zmena neukladá stav platby ani fakturácie.

## Personas and jobs

| Používateľ | Potrebuje |
| --- | --- |
| Dispečer | Založiť úkon z prípadu, nájsť auto, dohodnúť čas, prideliť človeka, riešiť zmeny a problémy. |
| Koordinátor pobočky | Naplánovať dennú prácu, návraty a presuny; vidieť kapacitu a kontrolu vrátených áut. |
| Pristavovač | Vidieť vlastné úkony, potrebné kontakty, trasu a pokyny; potvrdiť prijatie, priebeh a výsledok. |
| Vedúci | Vidieť meškania, nevyriešené návraty a časové vyťaženie; otvoriť konkrétny problém. |

Rozsah pobočiek a práv sa overuje na serveri. Právo pristavovať (`deliver`) a viesť odťahovku (`drive`) zostáva odlíšené. Používateľ môže mať obe.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

- Dispečer: rýchlo založiť aj neúplný zásah, prideliť človeka a techniku, sledovať priebeh.
- Vodič: vidieť vlastnú prácu, kontaktovať klienta, navigovať, doplniť údaje a podklady, potvrdiť skutočné prijatie platby a odovzdať zásah.
- Kontrolór/naceňujúci: preveriť podklady, upraviť položky výkonu a schváliť cenu.
- Fakturácia: vybrať pripravené zákazky, evidovať externú faktúru, získať zákazkový list.
- Konateľ: filtrovať zásahy a vidieť oddelene výkony, faktúry, platby a hotovosť vodičov.

## Information architecture

Do prevádzkovej skupiny spoločnej navigácie pri **Flotile** pridať **Pristavenia a odvozy**. Použiť rovnakú hlavičku, účet, telefóniu podľa oprávnenia a návrat na prípad. Pri prepnutí modulu sa zachová rozpracovaný hovor a stav prípadu. Konkrétnu URL určí implementácia podľa navigácie dispečingu; hlboký odkaz musí otvoriť rovnaký úkon po obnovení stránky.

### Obrazovky modulu

| Pohľad | Hlavný obsah |
| --- | --- |
| **Prehľad** | Predvolene dnešné úkony a staršie nevyriešené. Počítadlá Bez vodiča, Mešká, Nahlásený problém a Návraty bez dohody. Tabuľka s detailom vedľa nej. |
| **Plán vodičov** | Deň/týždeň, riadky vodičov, časové bloky úkonov, odhad presunu a viditeľné kolízie. Pridelenie aj cez bežný formulár. |
| **Návraty** | Autá u klientov, známy plánovaný koniec prenájmu, dohoda o vrátení, vytvorený odvoz, vrátenie na pobočku a kontrola pripravenosti. |
| **História** | Dokončené a zrušené úkony; hľadanie podľa EČV, prípadu, vodiča a dátumu. |

Filtre: dátum/obdobie, pobočka, typ úkonu, stav, vodič, nepridelené, problém; vyhľadávanie EČV, čísla prípadu a klienta. Mapa je voliteľný pohľad nad rovnakým výberom, nie povinná polovica obrazovky.

### Čo má jeden riadok zobrazovať

| Pole | Význam |
| --- | --- |
| Termín | Dohodnutý čas alebo interval; zvlášť označený odhad a chýbajúca dohoda. |
| Typ | Pristavenie, Vyzdvihnutie od klienta alebo Presun medzi pobočkami. |
| Auto | EČV, značka/model, pobočka; pri neurčenom aute požadovaná kategória. |
| Trasa | Samostatné odkiaľ → kam; miesto pristavenia sa nezamieňa s cieľom odťahu. |
| Klient a prípad | Meno podľa oprávnenia, číslo prípadu a otvorenie súvisiaceho záznamu. Telefón až v detaile. |
| Vodič | Pridelený človek a či prácu prijal; nepridelené je zreteľné. |
| Priebeh | Aktuálny stav, ETA, posledná aktualizácia a nahlásený problém. |

Pre plánovanie evidovať plánovaný začiatok a koniec práce vrátane potrebného presunu. Prekrytie potvrdených intervalov toho istého vodiča alebo auta je konflikt. Neznámy koniec zobrazí upozornenie **Kapacita nie je potvrdená**, nie prísľub voľného termínu. Odhad trvania môže koordinátor doplniť ručne; nejde o už existujúcu schopnosť dnešného odovzdania.

Kliknutie otvorí bočný detail: úkon, súvisiaci prípad, overené auto a obsadenosť, trasa, kontakt pri odovzdaní/prevzatí, dohodnutý čas, vodič, pokyny, priebeh a ďalší krok. Akcie: Prideliť, Zmeniť termín, Zavolať, Otvoriť SMS, Nahlásiť problém a Zrušiť s dôvodom. Obsah a dostupnosť akcií vyplývajú z práv a aktuálneho stavu.

### Väzba na prípad a flotilu

**Jeden prípad môže mať viac úkonov**, každý s vlastnou identitou, typom, termínom, pridelením a históriou. Môžu ísť súbežne alebo nadväzovať: odťah poškodeného auta, pristavenie náhradného auta, neskoršie vyzdvihnutie a presun na pobočku.

Pred týmto reťazcom môže byť **partnerský prípad → nový nadväzujúci asistenčný prípad**. Ak sa mení služba, objednávateľ alebo asistenčná referencia, pôvodný Final CD prípad sa neprepíše; vytvorenie následného prípadu je vedomá akcia. Oba sa navzájom otvoria a ich realizačné úkony sa v partnerskom reporte nepočítajú ako nové konzultácie. Samostatný úkon bez zmeny prípadového kontextu nevyžaduje automaticky ďalší prípad.

- V prípade zobrazovať kartu **Pristavenia a odvozy** so všetkými súvisiacimi úkonmi a tlačidlami Naplánovať pristavenie / Naplánovať odvoz.
- Vo Flotile pri aute zobrazovať aktuálny a nasledujúci logistický úkon. Nepridávať druhý katalóg vozidiel.
- Z modulu otvárať pôvodný prípad, detail auta alebo už existujúcu odťahovú zákazku. Odťahy majú v spoločnej navigácii vlastný modul; ich cenové, fakturačné a hotovostné kroky zostávajú v ich existujúcom detaile.
- Samostatný presun auta môže vzniknúť z Flotily bez vytvárania fiktívnej nehody. Vyzdvihnutie prepojiť na konkrétny cyklus používania auta a pôvodné pristavenie; samotná EČV ani číslo prípadu nestačí pri opakovaných výmenách.
- Výmena je prepojená dvojica: doviesť nové auto a prevziať pôvodné. Každý úkon možno prideliť inému človeku a dokončiť samostatne.

### Odvoz náhradného vozidla

Pri plánovaní pristavenia ponúknuť ďalší postup: **Vyzdvihneme / Klient vráti sám / Zatiaľ nedohodnuté**. Známy dátum konca prenájmu predvyplní iba návrh; potvrdený termín odvozu je samostatná dohoda. Bez dostupného údaja sa zobrazí **Termín treba dohodnúť**.

1. Koordinátor dohodne miesto a čas, určí cieľovú pobočku a spôsob prepravy: po vlastnej osi alebo na odťahovke. Pri jazde po vlastnej osi zaznamená aj dopravu vodiča na miesto a jeho ďalší presun.
2. Potvrdí alebo vytvorí jeden úkon vyzdvihnutia. Pri predĺžení prenájmu upraví návrh/termín existujúceho úkonu s históriou; rozbehnuté vyzdvihnutie najprv vyžaduje vyriešiť zmenu s vodičom.
3. Vodič potvrdí prevzatie auta od klienta. Tým sa ešte nepotvrdzuje doručenie na pobočku. Následne potvrdí odovzdanie v cieľovej pobočke.
4. Vozidlo je **Vrátené · čaká na kontrolu**. Koordinátor overí pripravenosť: stav vozidla, kľúče/doklady a prípadnú potrebu čistenia alebo servisu.
5. **Pripravené na ďalší výjazd** sa smie ponúknuť až pri potvrdenej kontrole, čerstvej voľnej obsadenosti zdroja a bez interného obmedzenia alebo konfliktnej rezervácie. Rozpor sa zobrazí na vyriešenie.

Klientovo samostatné vrátenie sa eviduje bez pridelenej jazdy vodiča. Nedorozumenie s klientom, neprítomnosť, chýbajúce kľúče, nepojazdnosť alebo škoda zostanú otvoreným problémom s vlastníkom a ďalším krokom.

**Odťah poškodeného auta** sa zobrazí ako prepojená existujúca odťahová zákazka. Ak treba náhradné auto odviezť odťahovkou, logistický úkon sa previaže s realizačnou zákazkou. Jeden výkon sa v počtoch práce nezapočíta dvakrát.

### Príklad celého toku

Ilustračný prípad: v pondelok ide poškodené auto do servisu a pristavovač doručí klientovi náhradné auto. Odťah aj pristavenie sú samostatné súvisiace výkony. V Návratoch je viditeľné dohodnúť piatkové vyzdvihnutie. Klient vo štvrtok predĺži prenájom: upraví sa ten istý návrat a vodič dostane viditeľnú zmenu. Po vyzdvihnutí sa osobitne potvrdí doručenie a kontrola auta. Pôvodný asistenčný prípad môže byť medzičasom uzavretý; otvorená logistika zostáva dostupná.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Zachovať existujúce `/zakazky`, `/vodic`, `/moje-jazdy`, pobočkový front a mobilnú kostru. „Kniha zásahov“ je prehľad odťahových zákaziek. Logistika preberá hustotu a ovládanie, zachováva vlastný model pristavení/návratov/presunov. Odťah a jeho logistická projekcia nie sú dva účtovateľné výkony.

Kniha: kompaktná hlavička → malé súčty → rýchle pohľady podľa fázy → hlavné filtre → tabuľka → stránkovanie. Detail: identita/stav → kontakt/trasa → Údaje · Fotografie · Nacenenie · Úhrady · Doklady · História. Založenie a zadávanie práce používajú rovnaké poradie základných údajov.

## Design principles

- Prípad je spoločný kontext; úkon je samostatne vykonateľná práca. Pridelenie, prijatie a vykonanie sú rôzne udalosti.
- Prevádzkový stav, stav prenájmu, dostupnosť vozidla a finančné vyrovnanie sa zobrazujú oddelene.
- Software House zostáva zdrojom obsadenosti; Commander a poloha telefónu pomáhajú s polohou. GPS nedokazuje voľné auto ani dokončenú jazdu.
- Miestny plán rezervácií chráni pred kolíziami; samotná externá informácia „voľné“ nepotvrdzuje voľný budúci termín.
- Zmenu relevantnú pre už pridelenú prácu musí vodič vidieť s označením zmeny. Zachovať náhľad toho, čo je mu sprístupnené.
- Najprv termín, zodpovednosť a problém, až potom doplnkové metriky a mapa.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

1. Hustota cez menšie medzery a spojenie príbuzných údajov, nie cez nečitateľné písmo.
2. Jedna dominantná farba riadka vyjadruje fázu; text a ikona vysvetľujú význam.
3. Ikona dopĺňa viditeľný názov akcie. Stavový čip nevyzerá ako výber, ak hodnotu nemožno meniť.
4. Jedna hlavná akcia v aktuálnom kontexte; pridelenie, uloženie, vrátenie a storno sú oddelené úkony.
5. Výbery majú šírku podľa obsahu. Kontakty, adresy a pokyny nie sú natlačené do úzkych stĺpcov.
6. Zachovať rozpracovaný vstup, filtre a pozíciu zoznamu pri otvorení detailu aj po konflikte.

## Visual language

Použiť existujúci `dispatch-app-shell`: systémové písmo a kompaktnú hustotu, neutrálny svetlý podklad, dnešné vstupy, tlačidlá a ikony Lucide. Návrh nepridáva vlastnú paletu ani paralelný systém tokenov. Farba dopĺňa text stavu; červená označuje problém alebo meškanie, nie bežnú rozpracovanosť. Minimálna animácia, stabilné riadky počas obnovy.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Desktop: telo 12–13 px/16–18 px, sekundárny text 11–12 px/14–16 px, nadpis 24–26 px; čísla súm tabulárne. Škála medzier 4/8/12/16/24 px. Tabuľkové riadky 40–44 px pri bežnom obsahu, najviac dva stručné riadky údajov; dlhé údaje sú celé dostupné v detaile a cez klávesnicu. Filtre 32–36 px, hlavné formulárové polia 36–40 px. Dotykový režim a mobil zachovávajú plochy aspoň 44 px a mobilné tokeny.

| Fáza | Podklad riadka | Text/ikona |
|---|---|---|
| Vytvorené | biely | Nepridelené · kruh |
| Pridelené/prebieha | jemná oranžová `#FFF3DF` | Pridelené/Prebieha · vodič/hodiny |
| Dokončené vodičom | sivá `#F0F2F4` | Na kontrolu · kontrolný zoznam |
| Schválené | modrá `#EAF3FF` | Na fakturáciu · doklad |
| Vyfakturované | svetlozelená `#EFF8E8` | Vyfakturované · doklad |
| Uzavreté a uhradené | výraznejšia svetlozelená `#DDF1DD` | Zaplatené · potvrdenie |

Odtiene sú návrh; kontrast sa overí pri implementácii. Vrátenie na doplnenie, finančná výnimka, čiastočná platba, preplatok a storno majú samostatný textový štítok. Žiadne falošné zelené „hotovo“ pri platbe vopred a stále rozbehnutej práci. Pravidlá odvodenia fázy sú v pláne.

Objednávateľ dostane malý farebný štítok, napr. AWP modrý, Europ Assistance červený, Samoplatca jantárový; svetlý podklad neprebíja farbu riadka. Platba má malú ikonu aj text. Ikony 14–16 px v tabuľke a 16–20 px pri akciách; nevkladať ikonu ku každému slovu.

## Components

- Opätovne použiť spôsob navigácie dispečingu, jeho tabuľky, filtre, formuláre adries, dialóg SMS, otvorenie prípadu a detail auta. Zdieľanú logiku vyčleniť podľa potreby, nekopírovať celý `DispatchConsole`.
- Existujúce `CaseHandoffPanel` a `HandoffSummary` sú východisko pre pridelenie, náhľad a históriu; nepredstierajú hotové plánovanie odvozov.
- Nové časti: prehľad úkonov, detail úkonu, plán vodičov, prehľad návratov a kontrola pripravenosti auta.
- Pri aute a úkone ponúknuť **Nahlásiť poškodenie**: fotografia, popis, autor a zodpovedný riešiteľ. Základné hlásenie nečaká na celý fotoprotokol alebo kompletnú knihu poškodení; budúca správa opráv rozšíri ten istý záznam.
- Pre pristavovača rovnaká webová aplikácia zobrazí **Moje jazdy**: iba vlastné úkony, kontakty a povolené kroky. Otvorenie nenačíta celý dispečerský dataset ani telefóniu.
- Denné počítadlá vychádzajú z rovnakého filtrovaného zdroja ako zoznam. Dôvod nepripravenosti auta je dostupný aj textom.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Použiť existujúce `Button`, `Field`, `Select`, `TextArea`, `Panel` v `src/components/towing/primitives.tsx`, CSS Modules v `towing.module.css`, existujúce ikony a peniaze z `src/domain/towing/money.ts`. Rozšíriť iba potrebné kompaktné varianty. Návrhové desktopové hodnoty vlastnia tieto existujúce štýly, nie ďalšia paralelná tokenová knižnica.

Tabuľka: pevná hlavička, názvy a šípky radenia, sumy vpravo, sémantické `table/th/td`, jeden dominantný stav, voliteľné sekundárne stĺpce. Nové odvodenie fázy a pravidlá filtrov majú čistý typovaný model. Výber z dlhého katalógu je vyhľadateľný combobox; malé voľby ostávajú natívnym selectom alebo segmentom. Najprv vyhodnotiť existujúce prvky, bez novej závislosti.

Mobil používa výlučne `mobile/src/design/`, jeho tokeny a `mobile/src/shell/`. Karta: dátum/termín + stav → vozidlo/EČV → objednávateľ/referencia → trasa → označená akcia. Vlastná spodná lišta podľa cudzieho screenshotu sa nepridáva.

## Accessibility

Návrhový cieľ je WCAG 2.2 AA; splnenie sa preverí pri implementácii. Tabuľka má hlavičky, stavové štítky text a ovládacie prvky dostupné názvy. Celý postup pridelenia a zmeny termínu funguje klávesnicou. Detail spravuje fokus a po zatvorení ho vráti na pôvodný riadok. Presúvanie v pláne má alternatívu cez tlačidlo a formulár. Zmeny stavu sa oznámia bez odoberania fokusu; rešpektovať obmedzený pohyb.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Cieľ WCAG 2.2 AA pre web. Farbu vždy dopĺňa text; ikony majú názov alebo dostupný popis. Radenie oznamuje `aria-sort`; výber funguje cez klávesnicu, Escape a návrat fokusu. Výber v tabuľke nesmie omylom spustiť otvorenie riadka. Mobilný štandard je prísnejší pre dotyk: aspoň 44 px.

Overiť kontrast textu, viditeľný focus, 200 % priblíženie a zväčšené mobilné písmo. Kompaktné webové tlačidlá majú aspoň 24 × 24 px aj s odstupmi, dôležité akcie väčšie. Pravidlá: [veľkosť cieľov](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [použitie farby](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

## Responsive behavior

Priorita je desktopový web: od približne 1280 px tabuľka a detail vedľa seba; na menšom okne detail prekryje pracovnú plochu. Pod existujúcou hranicou 1024 px použiť jednu plochu a kompaktné karty s rovnakým obsahom. Telefón pristavovača používa responzívny web, nejde o zmenu natívnej aplikácie. Hlavné kroky majú viditeľný text a dostatočné dotykové plochy.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

- Od 1280 px: kompaktná kancelárska tabuľka, približne 9–10 zoskupených stĺpcov, filtre na najviac dvoch riadkoch. Bez vodorovného posuvu celej stránky.
- 1024–1279 px: schovať voliteľné sekundárne stĺpce; ak treba, posúva sa iba tabuľka. Dátum, vozidlo, objednávateľ, trasa a stav ostávajú dostupné.
- 768–1023 px: redukovaná tabuľka alebo kompaktné karty podľa overenia obsahu; detail na celú dostupnú šírku. Nepoužiť 600 px ako jedinú hranicu.
- 320–767 px a natívny mobil: karty, jeden stĺpec formulára, tlačidlá s textom, žiadny miniatúrny Excel. Telefón/trasa a hlavný krok sú pred rozsiahlymi doplnkami.
- Rýchla úprava používa panel najviac 620 px podľa overeného prototypu; úplný detail s financiami a prílohami má obsah približne 880–1040 px a zachová existujúce funkcie. Polia sa neroztiahnu na 1400 px. Na úzkej obrazovke sa panel rozšíri na dostupnú šírku a plný detail je samostatná čitateľná plocha.

## Interaction states

- **Nové / Naplánované → Pridelené · čaká na prijatie → Prijaté → Na ceste → Na mieste → Dokončené.** Pri pristavení posledná akcia znie **Auto odovzdané klientovi**. Pri vyzdvihnutí sa medzi príchodom ku klientovi a dokončením eviduje **Auto prevzaté → Doručené do cieľa**. Krok kontroly auta je samostatný.
- **Problém** je viditeľné upozornenie s dôvodom, vlastníkom a ďalším krokom; nestratí sa informácia, v akej fáze problém vznikol. Odmietnutie pridelenia ponechá samotný úkon otvorený na nové pridelenie.
- **Zrušené / Neuskutočnené** majú dôvod a históriu. Uzavretie či expirácia odkazu sa nevydáva za dokončenie alebo zánik logistickej práce.
- Pri načítaní zobraziť stav načítania; prázdny zoznam odlíšiť od neúspešného načítania a od filtra bez výsledkov. Pri obnove zachovať filtre, rozpracovaný text a polohu v zozname.
- Pri neistej odpovedi zápisu zobraziť **Výsledok nepotvrdený · overiť rovnaký krok**. Nevytvárať druhé pristavenie či odvoz. Pri súbežnej zmene žiadať načítať aktuálny stav a znovu posúdiť konkrétnu zmenu.
- Chýbajúcu a starú GPS/obsadenosť označiť. Pri poruche zdroja nepovažovať prázdnu odpoveď za voľné vozidlá. Odhadovaný koniec jazdy nie je potvrdená dostupnosť vodiča.
- Prvá webová verzia nevykonáva offline zápisy. Chyba pripojenia jasne ukáže, čo je posledný známy stav a čo sa nepodarilo potvrdiť.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Pri načítaní zachovať posledný potvrdený zoznam s označením obnovy. Prázdny filter ukáže „Žiadne zásahy“ a vymazanie filtrov. Neistý zápis sa overuje rovnakým identifikátorom. Konflikt zachová koncept; zmena filtra nesmie prepisovať rozpracovaný detail.

Rozlišovať „výsledok uložený“, „platba potvrdená serverom“, „e-mail prijatý poskytovateľom“ a „doručené príjemcovi“. Pri offline platebnom zápise zobraziť čakanie; nepočítať nepotvrdený príjem do potvrdenej držby hotovosti. Neaktívne historické možnosti ostávajú pomenované, no neponúkajú sa ako nové aktívne voľby.

## Content voice

Používať slovenské prevádzkové názvy: **Pristavenie**, **Vyzdvihnutie od klienta**, **Presun medzi pobočkami**, **Odťah poškodeného vozidla**. V detaile byť presnejší než všeobecné „odvoz“. Rozlíšiť **Dohodnuté**, **Odhad**, **Zatiaľ neurčené**. Časy zobrazovať v `Europe/Bratislava`. Žiadne technické názvy databázových tabuliek alebo interné prepínače v používateľskom postupe.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Slovenčina, krátke konkrétne pomenovania. „Objednávateľ“, „Asistenčná služba“, „Číslo prípadu asistenčky“, „Nákladka/Nakládka“ zjednotiť na **Nakládka**, „Vykládka“, „Zásahové vozidlo“, „Plánovaný termín“, „Skutočný začiatok“, „Na kontrolu“, „Na fakturáciu“.

„Spôsob úhrady“ opisuje dohodu; „Prijatá platba“ skutočný príjem. „Schválené výkony“, „Vyfakturované“ a „Prijaté platby“ sú tri odlišné súčty. Neznáma suma je „—“, nie 0 €. V aplikácii sa nezobrazujú implementačné názvy RPC ani interné technické príčiny.

## Implementation constraints

### Rozsah a kompatibilita

Historický podklad bol vytvorený pre Next.js 16.3.8 / React 19.2.4; aktuálny `package.json` k 5. 11. obsahuje Next.js 16.4.1 / React 19.2.4. Pred kódovaním treba prečítať relevantné lokálne návody Next.js a oficiálne skills pre príslušný framework. Tento návrh nepridáva závislosti, migrácie, provider zápisy, worker, listener ani cron. Prípadná implementácia prejde bežným postupom cez stabilný TEST; produkcia zostáva samostatne schvaľovaná podľa `AGENTS.md`.

### Dátové hranice, ktoré treba pri implementácii zachovať

- Nový prehľad potrebuje samostatné načítanie naprieč povolenými úkonmi. Dnešný per-case handoff a zoznam jedného pristavovača nie sú hotové organizačné plánovacie API. Neobchádzať to načítaním všetkých detailov všetkých prípadov.
- Dnešné odovzdanie je viazané na prípad a má expiráciu; podporu viacerých súbežných samostatných úkonov treba navrhnúť explicitne. Dlhodobý záznam návratu auta nemá závisieť od životnosti odkazu ani od otvorenosti asistenčného prípadu. Zachovať kompatibilitu existujúceho mobilného klienta.
- Náhradné auto sa pripája overeným interným identifikátorom a konkrétnou väzbou. Všeobecné `selectedAssetId` môže patriť odťahovke; meno, samotná EČV ani zhodná poloha nie sú náhradou jednoznačného priradenia auta a cyklu prenájmu.
- Software House neposkytuje skutočný začiatok obsadenosti; `observedSince` je iba pozorovanie. `rentTo` pri voľnom aute môže patriť minulému prenájmu. Bez potvrdeného aktívneho cyklu nevytvárať automatický odvoz z tohto údaja.
- Interné dokončenie odvozu neukončí prenájom v Software House a neprepíše jeho obsadenosť. Pri rozpore ukázať overenie namiesto falošnej dostupnosti. Nepočítať s novým zápisovým API poskytovateľa.
- Prístup pristavovača na webe potrebuje vlastnú autorizovanú plochu nad jeho existujúcim členstvom; nemá sa mu automaticky vytvoriť dispečerský profil. Server overuje identitu, organizáciu, pridelenie a konkrétnu akciu.
- Rovnaký úkon v prípade, logistike, flotile a prípadne odťahovej zákazke musí mať jednu hlavnú realizačnú identitu. Väzby a audit zabránia dvojitému vykázaniu alebo dvojitému prideleniu.
- Poloha telefónu a poloha vozidla sú odlišné zdroje. Existujúce sledovanie telefónu sprístupňovať len počas povolenej práce, s časom a presnosťou; web nesľubuje nepretržité sledovanie na pozadí.

### Poradie realizácie

Ide o lokálne etapy logistického modulu; ich zaradenie medzi Final CD, Erosove zákazky a správu flotily určuje [spoločný plán M0–M4](docs/plans/spolocna-aplikacia-2026-10-26.md). Nejde o odloženie už existujúceho pristavovania alebo o podmienku najprv dokončiť celú správu flotily.

1. **Spoločný webový modul:** organizačný prehľad pristavení aj vyzdvihnutí, detail, explicitná väzba na auto a prípad, ručné termíny a pridelenie, história, základné konflikty, Moje jazdy a návraty bez dohody. Návrat a kontrola sú zaznamenané ako samostatné výsledky. Pri odovzdaní sa uložia odovzdávajúci/preberajúci, základné fotografie a vodičom potvrdené dostupné km/palivo so zdrojom a časom; nezistené údaje sa nevymýšľajú. Pri práci s autom pribudne základné hlásenie poškodenia s fotografiou a riešiteľom. Otvorené body o identite a plánovaní sa vyriešia pred zápisovou implementáciou.
2. **Plánovanie kapacity:** denná/týždenná časová os, nadväzné presuny vodičov a áut, výmeny a informácie o overenej budúcej pripravenosti. Pri akceptácii výmeny overiť oddelenie pôvodného a nového auta aj oboch výkonov. Plánovač nesľubuje automatickú optimalizáciu.
3. **Rozšírené odovzdanie a reporting nad minimum prvej etapy:** systematický fotoprotokol pred/po, porovnanie poškodení a údajov odovzdania s prevzatím, batéria, výsledný dokument a prípadný podpis po samostatnom určení rozsahu. Základné fotografie, potvrdené dostupné km/palivo a hlásenie poškodenia už patria do prvej etapy; toto je ich rozšírenie. Nevstupuje sa do dát poľskej aplikácie. Neskôr počty úkonov, časy, meškania, neúspešné výjazdy a prázdne presuny; sumy iba zo skutočne schválených finančných záznamov.

### Akceptácia prvej verzie

- Z prípadu vznikne jedno pristavenie, zobrazí sa v module aj pri správnom aute; opakovanie požiadavky nevytvorí duplikát.
- Vodič bez dispečerskej roly na webe uvidí iba svoje jazdy. Dispečer má rovnaký potvrdený priebeh; odoslanie sa nezamieňa s prijatím práce.
- Samostatné pristavenie a odťah v jednom prípade môžu mať rôznych vodičov a termíny. Prevzatie jedného nezmení druhý.
- Neskorší odvoz je dohľadateľný aj po dokončení pristavenia, expirácii jeho odkazu a uzavretí prípadu.
- Zmena termínu prenájmu aktualizuje jeden návrat.
- Prevzatie od klienta, doručenie na pobočku a kontrola pripravenosti sú odlišné výsledky. Stará/neoverená obsadenosť ani chýbajúca GPS sa nevydáva za voľné vozidlo.
- Hlásenie poškodenia z úkonu je dohľadateľné pri správnom aute a má popis, fotografiu, autora a zodpovedného riešiteľa; následná správa opravy zachová pôvodné hlásenie.
- Odovzdanie má odovzdávajúceho/preberajúceho, základné fotografie a vedomé potvrdenie dostupných km/paliva so zdrojom a časom. Chýbajúce meranie sa zobrazuje ako nezistené, nie ako nula alebo automaticky potvrdená hodnota.
- Súbeh pridelení, chyby siete, nepovolený prístup a zrušenie majú overiteľný výsledok a históriu. Filtre a rozpracovaný hovor prežijú prepnutie modulu.
- Overiť desktop aj úzky web, ovládanie klávesnicou a autentifikovaný tok oboch rolí na identifikovanom stabilnom TEST commite. Existujúce testy a build brána sa použijú primerane zmenenému správaniu.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

Repo používa Next 16.4.1, React 19.2.4, CSS Modules a Lucide; [lokálne Next návody](node_modules/next/dist/docs/01-app/01-getting-started/11-css.md) sú prvý zdroj. Zachovať komponentové hranice a nezavádzať tabuľkovú knižnicu. Filtrovanie, radenie a súčty sa vyhodnocujú na serveri nad rovnakou oprávnenou množinou, nie iba nad načítanými 50 riadkami.

Rešpektovať samostatné stavy výkonu/fakturácie/platby, existujúce oprávnenia, identitu príkazov a verzie dokladov. AWP evidenčný výkon sa nesmie zmeniť na nové vyslanie vodiča. Výbery čítajú existujúce katalogy; názvy z dokumentu sa pred konfiguráciou porovnajú s existujúcimi záznamami.

Snímky: 1440/1280/1024/768 a 390/320 px; navyše husté dáta, dlhé názvy, otvorené výbery, finančné výnimky, prázdne filtre a detail. Rozlíšiť koncept, syntetické overenie skutočného komponentu a živé TEST prijatie.

## Open questions

Nejasnosti neblokujú tento produktový návrh; pred implementáciou sa uzavrú len tie, ktoré menia daný rozsah.

- [ ] **Majiteľ / koordinátor:** kto potvrdzuje koniec prenájmu, kde sa dohodne vyzdvihnutie a kto zodpovedá za návrat bez termínu? Predpoklad: návrh zo známych údajov, záväzná dohoda dispečerom alebo koordinátorom.
- [ ] **Majiteľ / implementátor:** aký overený identifikátor spája prípad, konkrétne náhradné auto a aktuálny cyklus používania? Predpoklad: explicitná väzba, nie odhad podľa EČV alebo `rentTo`.
- [ ] **Koordinátor:** kto potvrdí kontrolu pripravenosti auta a ktoré tri až päť bodov sú povinné? Predpoklad: pobočka potvrdí vrátenie a následnú pripravenosť samostatne.
- [ ] **Majiteľ:** má prvá verzia zahŕňať aj presuny áut nesúvisiace s asistenčným prípadom? Návrh ich podporuje ako samostatnú logistickú prácu; príprava dokumentu ich neimplementuje.
- [ ] **Majiteľ:** aké práva majú jednotlivé pobočky a externí pristavovači? Predpoklad: pristavovač len vlastné úkony, koordinátor iba výslovne povolený rozsah.
- [ ] **Majiteľ:** patria do ďalšej etapy aj nájomné protokoly a podpisy, alebo iba záznam vykonania a kontroly? Existujúca samostatná poľská aplikácia zostáva mimo rozsahu.

### Doplnenie 5. 11. 2026 — kniha zásahov a terén

- [ ] Majiteľ/Eros: význam „Iné – hotovosť bez dokladu“. Návrh zatiaľ eviduje skutočnú hotovosť a samostatný zámer fakturácie; výber sám nezruší povinnosti existujúceho toku.
- [ ] Majiteľ/Eros: presná identifikácia fyzickej osoby na zákazkovom liste. Rodné číslo z dokumentu nepatrí do zoznamu, push ani všeobecných projekcií; formulár a povolený prístup treba určiť pred touto časťou implementácie.
- [ ] Prevádzka: ktoré adresy parkovísk, kontakty a technika už sú nakonfigurované. Neznáme položky neblokujú redizajn ani vývoj na fixture dátach.
- [ ] Majiteľ: finálny názov logistického prehľadu a začiatok zdieľania polohy pri prijatí vs. vyrazení. Súčasné pravidlá sa nemenia iba podľa nejednoznačného prepisu.
