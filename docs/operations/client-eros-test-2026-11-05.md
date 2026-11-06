# Klient + Eros: overenie spoločnej úpravy

Rozsah určuje [spoločný plán](../plans/eros-kniha-zasahov-2026-11-05.md). Braňovo napojenie je odložené. Digitálny podpis na displeji nie je súčasťou tejto dodávky; zostáva papierový protokol alebo jeho príloha a evidovaný príjemca/čas/výnimka.

## Čo skúsiť

1. V prípade s odťahom aj náhradným vozidlom otvorte **Odovzdať prípad**. Každej práci vyberte pobočku alebo konkrétneho človeka, vlastné pokyny a termín. Pobočka dostane rad, človek vlastnú prácu. Pri chybe druhej položky sa prvá neopakuje. Pri nejasnej odpovedi použite overenie pôvodného zadania.
2. V **Knihe odťahov** skúste fázu, objednávateľa, vodiča, pobočku, ďalšie filtre a radenie. Dátum výkonu rozlišuje skutočný začiatok, plán a dátum založenia. Platba sama nepresunie rozpracovanú zákazku medzi dokončené.
3. V detaile uložte odťah a samostatný úkon uloženia s parkoviskom. Doplňte kilometre, majiteľa a dohodnutú formu úhrady. Kancelária prevezme úkony do nacenenia raz; ceny a daň dopĺňa osobitne.
4. Vodič v aktuálnej mobilnej aplikácii skontroluje asistenčku, jej referenciu a vlastné pokyny. Pri blokovaní otvorí dostupnú vlastnú rozpracovanú prácu. Budúca kolízia termínu ho odkáže na dispečera.
5. Nové logistické pristavenie má kroky **Prijať → Vyraziť → Odovzdané**. Pred dokončením musí existovať potvrdenie odovzdania alebo zapísaná výnimka. Zber polohy nového toku začína odjazdom; po ukončení alebo odobratí pridelenia skončí. Staršie pristavenia cez externé odovzdanie si ponechávajú svoj kompatibilný priebeh.
6. Plánovaná úhrada nie je príjem. Skutočnú hotovosť alebo kartu potvrďte samostatne. Karta nemení držanú hotovosť; opakovanie potvrdenky nepridá ďalší príjem. Hotovostný prehľad a návrh odovzdania patria len aktuálnemu vodičovi.
7. Pri odovzdaní auta doplňte príjemcu a čas alebo dôvod výnimky. Vydajte nový realizačný list: obsahuje prevádzkové údaje a podpisové miesta. Už vydané verzie sa neprepisujú.
8. Pri neúspešnom PZP použite **Overiť PZP ručne na SKP**. Výpadok, ochranná kontrola ani chýbajúci nález sa neoznačujú ako nepoistenie. Poisťovňa sa do webového prípadu dopĺňa ručne.

## Podklady automatického overenia

Používateľská náhrada odkazuje na [oficiálne vyhľadávanie SKP](https://www.skp.sk/vyhladat-poistovatela-vozidla-a-overit-platnost-pzp/) s EČV/VIN a dátumom. Pri posúdení verejných zdrojov sa nepotvrdil dokumentovaný verejný API kontrakt pre tento projekt. Podporovaný automatický prístup preto zostáva závislý od dohody so zdrojom; táto dodávka nepridáva obchádzanie ochrannej kontroly ani IP blokovania.

## Prostredie a hranice overenia

Kanonický TEST je **https://test.dispecing.linkapomoci.sk**, databáza **nzpnqdstvkfncflgqlny**. Produkčné nasadenie vyžaduje samostatné prijatie identifikovaného TEST rozsahu.

Lokálne overenie používa syntetické záznamy a izolované PostgreSQL clustre. Webové screenshoty dokazujú rozloženie a syntetické prehliadačové scenáre, nie doručenie push na fyzický telefón. Natívne zmeny vyžadujú nový build aplikácie; webové nasadenie samo nezmení už nainštalovaný binárny klient. Fyzický iOS/Android, upozornenia po ukončení aplikácie a iOS poloha na pozadí zostávajú samostatnými zariadeniovými kontrolami. Android režim pozadia sa touto dodávkou nezapína.

Konkrétny TEST commit a výsledky nasadenia uvádza predávacia správa v príslušnom PR.

## Overené v tejto dodávke

- Kniha: 43 px riadky a 12 celých riadkov pri 1440 × 900; šírky 1280/1024/768/390/320 bez pretečenia stránky. 19 prehliadačových scenárov.
- Odovzdávanie: samostatné potvrdenia a pokyny; opakované odoslanie po strate odpovede, zmiešané nejasné/staré a odmietnuté/nové zadanie, oprava termínu aj zachovanie draftov. Šesť nových prehliadačových regresií; pôvodné odovzdania zostávajú pokryté.
- Databáza: 86 kontrol knihy/realizačných údajov/financií/vyhľadávania, 63 pobočkových a viacnásobných zadaní, 48 polohy, 55 pozadia a 43 upozornení na izolovaných skutočných PostgreSQL clustroch. Nové helpery nie sú prístupné anon/authenticated rolám.
- PDF: tri explicitné kontroly skutočným Chromium rendererom; nevydávajú sa spätne nové verzie starých dokumentov.
- PZP: desať webových scenárov vrátane sieťového výpadku a ručného uloženia.
- Mobil: celá sada 1 482 testov; osobitné regresie oneskoreného finančného čítania, potvrdenia pred uvoľnením outboxu a zrušenia odchodu z neuložených údajov. Typecheck a cielený lint prešli. Export JS nie je fyzická skúška telefónu.
- Nezávislá kontrola kódu uzavrela zistené chyby; potvrdená platba sa chráni aj pri rovnakej prevádzkovej revízii zákazky.

Do TEST databázy `nzpnqdstvkfncflgqlny` sa aplikovalo iba sedem nových migrácií tejto dodávky (súbory `20261105200753` až `20261105202702` podľa mien v PR). Bez seedovania, hromadného pushu starých migrácií, ďalšieho cronu alebo produkčných zápisov. Metadáta nasadenia a presný TEST commit sú v odovzdaní príslušného PR.

MCP eviduje čas aplikovania odlišne od času vytvorenia lokálneho súboru. Pred budúcim SQL rolloutom porovnajte **meno a obsah**, nie iba rozdielne časové prefixy; tieto migrácie na TEST neopakujte hromadným `db push`.

| Lokálny súbor – prefix | Evidencia TEST – verzia |
| --- | --- |
| 20261105200753 | 20261105204451 |
| 20261105200834 | 20261105204507 |
| 20261105201217 | 20261105204511 |
| 20261105201512 | 20261105204514 |
| 20261105201848 | 20261105204517 |
| 20261105202104 | 20261105204521 |
| 20261105202702 | 20261105204524 |

Po aplikovaní nevzniklo oproti východiskovému stavu žiadne nové bezpečnostné ani výkonnostné odporúčanie Supabase advisora. Nové prípadové RPC má `EXECUTE` iba pre service_role, nie pre anon/authenticated.

### Poznámka k mobilnému CI

Online `expo install --check` v CI 2026-11-05 začal odporúčať novšie patch verzie Expo 57 a desiatich balíkov. Tento krok zlyhal; predchádzajúce typy, lint a testy prešli. Zamknuté závislosti sa v tejto dodávke neaktualizujú. JS exporty existujúcich verzií pre web, iOS aj Android lokálne prešli. Offline porovnanie nie je náhradou za online kontrolu kompatibility. Pred zostavením nového inštalačného klienta treba rozhodnúť o týchto aktualizáciách a vykonať zariadeniové prijatie.
