# Zadanie: pracovná plocha dispečingu, poznámky, úlohy a karta prípadu

Dátum: 10. 9. 2026. Podklad kódu: commit `539a276`. Stav: v3 schválená — pôvodný plán aj mobilný/PWA dodatok majú Architect APPROVE a následne nezávislý Critic APPROVE. Výstupom tejto úlohy je plán, nie implementácia ani nasadenie.

Následné poverenie: používateľ po schválení návrhu výslovne zadal implementáciu. Stav implementácie, overenia a zostávajúce aktivačné podmienky sú v [implementation-progress.md](../implementation-progress.md) a [rollout dokumente](../../docs/rollout/dispatch-workspace-v3.md). Vyššie uvedený zákaz implementácie opisuje iba pôvodnú plánovaciu fázu.

## 1. Cieľ a interpretácia rozhovoru

Dispečer má vybaviť hovor s otvoreným prípadom, úlohami, poznámkami a pomocnými nástrojmi bez zbytočného prepínania a rolovania. Zachovať existujúce údaje a pracovné postupy; opravovať konkrétne nedostatky a rozširovať existujúce služby.

Zdroj: `.context/attachments/assets/56f7d851-2f67-4630-b4f2-e0ed8aac61b1/pasted_text_2026-09-10_16-10-23.txt`. Časy v tabuľke sú dohľadateľné v transkripcii. Osobný rozhovor o poistnej udalosti 29:25–31:52 nepatrí do zadania.

| ID | Požiadavka a zdroj | Rozsah a výsledok |
| --- | --- | --- |
| R01 | Osobné/zdieľané poznámky, 00:00; 27:53 | Samostatný upraviteľný poznámkový blok; predvolene súkromný, vlastník vyberá kolegov s právom čítať. |
| R02 | Stredná plocha, 00:26–01:43 | Prepínač Mapa / Úlohy / Poznámky; otvorený prípad ostáva dostupný dole. Existujúci tabuľkový režim zachovať vo voľbách zobrazenia. |
| R03 | Mapa miesta incidentu, 01:55–04:05 | Predvolene zbalená, otvára sa na vyžiadanie; koliesko prirodzene posúva kartu. Textová adresa a GPS fungujú aj bez otvorenej mapy. |
| R04 | Voliteľné widgety, 04:13–07:12 | Zapnúť/vypnúť, presunúť poradie a zbaliť nástroje vpravo; nastavenie pre používateľa. Poznámky, kalkulačka, trasa, vyhľadávanie, flotila, rýchle volanie, úlohy. |
| R05 | Trasa a kalkulačka, 08:16–11:14 | Trasa odkiaľ/kam, medzibody a km aj bez mapy; nezávislá ručná kalkulačka. Žiadne uložené sadzby poisťovní ani automatické cenové ponuky. |
| R06 | Vyhľadávanie a vozidlá, 06:09–07:58 | Vlastné prípady/kontakty/flotila podľa čísla prípadu, mena, telefónu, EČV; samostatný režim hľadania miesta. Využiť existujúci lookup vozidla. |
| R07 | Cudzie čísla bez spätného volania, 15:47–17:11 | Pri kontakte evidovať prijaté čísla a overené číslo na spätné volanie; upozorniť na rozdiel, ponechať pôvodnú identitu v histórii. |
| R08 | Návrat na firemnú linku, 17:20–22:49 | Spätný hovor na odchádzajúce firemné číslo smeruje na hlavnú linku/frontu s hláškou; nedovoláva sa priamo konkrétnemu dispečerovi. Štatistiky ostávajú podľa operátora. |
| R09 | Zaúčanie počúvaním, 24:22–25:28 | Využiť existujúce počúvanie/šepkanie; doplniť výslovne pozvaného poslucháča bez možnosti hovoriť. Samostatná etapa telephony. |
| R10 | Karta prípadu, 32:26–35:53 | Hlavička → kompaktný prehľad → zbaliteľné úlohy → editovacie sekcie → poznámky/aktivita → jediná história SMS úplne dole. |
| R11 | Stav a priorita, 35:53–36:29 | Klikateľný stav/priorita v hlavičke, vybavenie a opätovné otvorenie cez existujúce akcie. |
| R12 | PDF, 36:29–37:22 | Skutočne stiahnuteľné PDF uložených údajov prípadu, čitateľné A4, diakritika a stránkovanie. |
| R13 | Bočné panely, 37:22–38:24 | Úplné zbalenie oboch strán s úchytom obnovenia; zachovať poslednú šírku a existujúce maximá. |
| R14 | Ovládanie mapy, 38:59–40:07 | Zrozumiteľne odlíšiť plánovač od trasy prípadu; pobočky a menej používané ovládanie do Viac. |
| R15 | Úlohy/notifikácie/chat/väzby, 40:26–42:09 | Jeden systém tímových úloh, komentáre ako chat, pripomenutie, napojenie na nula/jeden/viac prípadov, funkčný zvonček a otvorenie konkrétnej úlohy. |
| R16 | Upresnenie používateľa: celý plán má rozumne fungovať aj na mobile a v PWA | Mobilná dostupnosť všetkých nových nástrojov, dotykové ovládanie, ochrana draftov/hovoru a PWA integračné skúšky podľa 4.1a a AC21–AC25. Platí naprieč všetkými etapami. |

Rozporné diktovanie poradia v 33:34–34:48 riešim poradím R10: stručný prehľad ostáva hneď pod hlavičkou, úlohy nad podrobným formulárom. Je to explicitný návrh na overenie s klientom pri ukážke. Poznámkový blok a poznámky prípadu sú dve odlišné veci. Jedna úloha má jedného zodpovedného operátora a tímový prístup podľa dnešných oprávnení. Zdieľaná poznámka je v prvej verzii pre príjemcu iba na čítanie. „Pripomenúť znovu“ znamená ďalšiu pripomienku/odloženie, nie automaticky opakované úlohy.

Mimo nového vývoja: tarify a automatická fakturácia, nový externý register vozidiel, prepis dochádzky/reportov, výpočet presného času jazdy naloženej odťahovky. Alfo ERP je možná inšpirácia, nie závislosť: miestny systém úloh už existuje; jeho kód nebol otváraný ani kopírovaný.

## 2. Overený existujúci základ a duplicity

Nasledujúce sú zistenia zo zdrojového kódu tejto kópie, nie dôkaz stavu nasadenej databázy.

| Oblasť | Dôkaz | Dôsledok pre vývoj |
| --- | --- | --- |
| Stred a pravý panel | `src/components/dispatch/MapWorkspace.tsx:17`, `src/components/dispatch/DispatchConsole.tsx:2164` | Rozšíriť existujúcu kompozíciu, spoločný TaskPanel už slúži stránke aj sidebaru. |
| Šírky panelov | `src/components/dispatch/DispatchConsole.tsx:154`, `src/components/dispatch/MapWorkspace.tsx:184` | Už existuje resize, klávesnica spodného panelu a osobné localStorage; bočné minimá 260/280 px, maximá 480 px. Doplniť collapsed stav. |
| Mapa incidentu | `src/components/dispatch/LocationPicker.tsx:77`, `src/components/dispatch/LocationPicker.tsx:171` | Geocoder sa vytvára spolu s mapou; oddeliť inicializáciu, aby zbalenie nevyplo zadávanie adresy. |
| Dvojitá SMS história | `src/components/dispatch/CaseDetail.tsx:1082`, `src/components/dispatch/CaseCockpitPanel.tsx:499`, `src/components/dispatch/CaseDrawer.tsx:64` | Potvrdená duplicita v kokpite; určiť jediného vlastníka renderovania a zachovať históriu v samostatnom draweri. |
| Hlavička a automatické ukladanie | `src/components/dispatch/CaseCockpitPanel.tsx:280`, `src/components/dispatch/CaseDetail.tsx:1338`, `src/components/dispatch/CaseDetail.tsx:1478` | Status/priorita sú teraz span; formulár vždy posiela prioritu a môže prepísať oddelenú zmenu hlavičky. |
| PDF je len zástupná akcia | `src/components/dispatch/CaseDetail.tsx:1070`, `src/server/motorist-mutations.ts:3909` | `create_pdf` iba zapíše pripravenosť na neskorší export; treba dokončiť reálne generovanie. |
| Trasa a mapové ovládanie | `src/components/dispatch/map/RoutePlanner.tsx:85`, `src/components/dispatch/map/MapControlBar.tsx:60`, `src/components/dispatch/DispatchMapGoogle.tsx:334` | API `/api/maps/route` už funguje v kóde; plánovač, vrstva trasy prípadu a editovanie návrhu adries nie sú tá istá funkcia. |
| Flotila/lookup | `src/components/dispatch/FleetModule.tsx:139`, `src/components/dispatch/FleetModule.tsx:393` | Využiť existujúce filtrovanie, overovanie obsadenosti a lookup; nevytvárať paralelnú integráciu. |
| Úlohy | `src/components/dispatch/TaskPanel.tsx:139`, `src/domain/tasks.ts:39`, `src/domain/types.ts:541` | Dnes CRUD, pridelenie, termín, priorita a filtre; zoznam vzniká cez cases[].tasks a vyžaduje jeden prípad. |
| Poznámky prípadu | `src/server/motorist-mutations.ts:351`, `supabase/migrations/20260520192000_foundation_schema.sql:216` | Sú udalosti prípadu; nemožno ich použiť ako súkromný upraviteľný notebook. |
| Pripomienky | `src/server/task-notifications.ts:18`, `src/server/task-notifications.ts:267`, `src/app/api/telephony/cron/route.ts:64` | Existujú deduplikácia, push/email, retry a povolený cron; rozšíriť task-first kontext. |
| Súkromie notifikácií | `src/data/dispatch-repository.ts:188`, `src/data/dispatch-repository.ts:271`, `src/data/dispatch-repository.ts:494`, `src/server/motorist-mutations.ts:880` | Admin klient číta podľa organizácie; read/archive nekontroluje príjemcu. Nutná serverová ochrana, samotné Moje v UI nestačí. |
| Callback/SMS väzby | `src/server/sms-workflow.ts:84`, `src/server/motorist-mutations.ts:2986`, `supabase/migrations/20260928120000_callback_contact_fulfillment.sql:50` | Zachovať pôvodný prípad systémovej úlohy a jej ID; splnenie jednej úlohy nesmie splniť cudzie povinnosti. |
| Telephony | `src/lib/telephony/supervisor-mode.ts:11`, `src/server/telephony/call-actions.ts:705`, `src/server/telephony/stats.ts:108`, `src/components/dispatch/settings/ring-plan-model.ts:334` | Monitor/whisper existujú pre manager/admin; štatistiky podľa operátora existujú. Prázdny ring plán vedie na callback, nie automaticky na nakonfigurovaný fallback. |

## 3. RALPLAN-DR: rozhodnutie pred kontrolou

Režim: konsenzus bez interaktívneho schvaľovania, rozšírená kontrola kvôli súkromiu a dátovej migrácii.

Princípy: (1) jedna identita každej úlohy, jedna SMS história a jeden zdroj pravidiel; (2) osobné údaje chráni server aj databáza; (3) prepínanie pohľadov nestráca rozpracovanú prácu; (4) postupné kompatibilné zmeny; (5) klientovi nechávame kontrolu nad cenou a rozložením.

Tri rozhodujúce dôvody: menej krokov pri hovore; nevytvoriť duplicity nad hotovým základom; neohroziť ukladanie prípadu, callbacky a prístup k súkromným dátam.

| Možnosť | Výhody | Nevýhody |
| --- | --- | --- |
| A — postupne rozšíriť súčasnú konzolu a dátové služby (odporúčané) | Zachová ID, oprávnenia, volania a existujúce regresné testy; menšie PR. | Treba rozpojiť veľké komponenty a navrhnúť prechod task 1:N. |
| B — nová pracovná plocha za prepínačom, spoločný backend | Čistejšie navrhnuté UX, možnosť porovnať obe plochy s klientom a rýchlo prepnúť späť. | Dočasne dve UI, viac synchronizácie rozpracovaných formulárov a dvojnásobné vizuálne testovanie. |

Voľba A s postupným zapínaním nových častí a oddelenými view komponentmi. B ostáva reálna alternatíva, ak pilot ukáže, že existujúca kompozícia bráni požadovanému rozloženiu. Nová nezávislá databáza úloh alebo kopírovanie celého ERP sú zamietnuté: duplikovali by ID, termíny, notifikácie a SMS/callback kontrakty bez potrebného úžitku.

## 4. Konkrétny návrh správania a dát

### 4.1 Pracovná plocha a widgety

Rozšíriť `MapWorkspace`, kompozíciu v `DispatchConsole` a zdieľaný `TaskPanel`. Aktívny prípad, editor a telefonický stav majú žiť nad prepínanými pohľadmi. Mapa si zachová polohu a route draft, ale skrytá nespúšťa nové platené dotazy. Trasa/widget používajú jeden model a jedno API; odpoveď na starý dotaz nesmie prepísať nový.

Register vstavaných widgetov bez nového plugin frameworku. Na prvé otvorenie zachovať známe nástroje, nové si používateľ pridá. Uložiť poradie, viditeľnosť, zbalenie, bočné šírky a center view do verziovaných preferencií kľúčovaných organizáciou aj používateľom; prvá verzia v tomto prehliadači podľa existujúceho localStorage vzoru. Prístupný presun tlačidlami hore/dole aj drag, obnova predvoleného rozloženia. Plný zoznam úloh sa pri úlohách v strede predvolene neopakuje vpravo; môže tam ostať stručný počet. Skrytie widgetu nemení termíny ani doručovanie upozornení.

Oba bočné panely sa potiahnutím cez prah alebo tlačidlom zbalia na úchyt; obnovenie vráti poslednú platnú šírku. Maximum 480 px ponechať, pri úzkej obrazovke rešpektovať aktuálne responzívne režimy. Testovať 1440×900, 1024×768 a 390×844, klávesnicu a 200 % zoom bez nedostupných akcií.

Kalkulačka podporí +, −, ×, ÷, zátvorky, desatinnú čiarku aj bodku, vymazanie a kopírovanie výsledku; bezpečný parser bez eval. `140 × 0,75 = 105`, `(70 − 50) × 2 × 0,75 = 30`; chybnú aritmetiku z príkladov transkripcie nepreberať. Delenie nulou je čitateľná chyba. Výsledok trasy ukazuje km, čas je sekundárny; ručné kopírovanie km, žiadne predvyplnené poistné sadzby.

Vyhľadávanie má rozlíšené výsledky prípady/kontakty/flotila a režim miesto; otvorenie výsledku zachová rozpracovaný prípad alebo použije existujúcu ochranu pred odchodom. EČV normalizovať pre lokálne hľadanie. Verejný lookup spustiť len explicitnou akciou. Vo flotile odlíšiť voľné/obsadené/neoverené a neaktuálne GPS; neoverené vozidlo nevydávať za voľné. Pobočky a focus ovládanie presunúť do Viac; nezmazať funkciu úpravy incident adresy, iba ju premenovať a zoskupiť.

### 4.1a Mobil, tablet a nainštalovaná PWA — platí pre celé zadanie

Mobil je povinná súčasť každej novej funkcie. Súčasný kód už má mobilnú navigáciu a samostatný pohľad prípad/mapa (`src/components/dispatch/DispatchConsole.tsx:296`, `src/components/dispatch/MapWorkspace.tsx:123`), safe-area a dynamickú výšku (`src/app/globals.css:46`); tieto základy rozšíriť. Dostupnosť nástroja sa riadi rovnakým oprávnením ako na desktope, nikdy samotnou šírkou obrazovky.

| Rozloženie | Prístup k nástrojom a prípadu |
| --- | --- |
| Od 1280 px | Widgety v pravom stĺpci; súbežne pracovná plocha a karta podľa 4.1. Po zbalení stĺpca ostáva viditeľný úchyt/tlačidlo Nástroje. |
| 1024–1279 px | Zachovať existujúcu kompozíciu bez pevného pravého stĺpca; viditeľné tlačidlo Nástroje otvorí dočasný panel s rovnakými widgetmi. Panel sa zavrie späť do rovnakého prípadu. |
| Pod 1024 px vrátane tabletov na výšku | Jeden hlavný pohľad na celú dostupnú šírku. Nástroje a Poznámky dostupné z existujúceho Menu, prípadne ako používateľská skratka v súčasnej spodnej navigácii. Žiadna funkcia nezmizne spolu so skrytým pravým stĺpcom. |

Mobilný pohľad Nástroje zobrazí vybrané widgety pod sebou. Kalkulačka/trasa sú použiteľné na celú šírku, dlhšie poznámky a detail úlohy/chatu sa otvoria v hlavnom pohľade s návratom. Jedna úloha, poznámka, trasa a rozpracovaný obsah majú rovnakú identitu pri otvorení zo všetkých miest; nevytvárať mobilné kópie dát. Otvorený prípad zostáva v spoločnom stave, návrat obnoví jeho draft a pozíciu. Mobilná obrazovka nesľubuje súčasné zobrazenie celého prípadu aj všetkých widgetov — funkcie ostávajú dostupné prepnutím. Desktopový stav zbalenia panelu nesmie blokovať mobilný vstup do Nástrojov; poradie/viditeľnosť widgetov ostávajú osobnou voľbou.

Rozšíriť rovnaký register mobilných skratiek a zachovať limit tri skratky + Menu (`src/components/dispatch/navigation-preferences.ts:17`); nové položky sú vždy dostupné z Menu aj bez pripnutia. Aktívna skratka a názov hlavičky musia odrážať skutočný pohľad, nie označiť notebook alebo nástroje ako Mapu (`src/components/dispatch/DispatchConsole.tsx:734`, `src/components/dispatch/DispatchConsole.tsx:1417`).

Dotykové ovládanie: hlavné akcie a presuny widgetov majú plochu aspoň 44×44 CSS px, bežné vstupy aspoň 16 px; žiadna akcia nevyžaduje hover alebo presný drag. Presun hore/dole ostáva dostupný aj bez ťahania. Zohľadniť safe-area, spodnú navigáciu, lištu hovoru, zmenu orientácie a otvorenú klávesnicu. Aktívne pole a tlačidlo Odoslať/Uložiť musia ísť posunúť nad prekrytie. Karta prípadu sa skladá pod seba; klikateľný stav, priorita, úlohy, SMS aj PDF ostávajú dostupné. Oprávnenia na telefonické a administratívne akcie sa týmto nemenia.

Spodná navigácia dnes tvorí posledný flex riadok shellu, nie fixed overlay (`src/app/globals.css:151`); nerezervovať jej výšku/safe-area druhýkrát v nových paneloch. Dialógy widgetov a editorov koordinujú vrstvy/fokus aj zatvorenie s telefonickou lištou. Prekrytie nástroja nesmie odstrániť dosiahnuteľnú cestu k prijatiu/ukončeniu prebiehajúceho hovoru.

PWA zachová existujúci service worker a update mechanizmus. `public/sw.js:44` zámerne necacheuje autentifikované stránky; ani nové notebook/task/chat API či PDF nedávať do offline cache. Offline stav musí odlíšiť neuložený text a nedostupné aktuálne dáta od úspešne uložených údajov. Pri výpadku siete držať draft v pamäti otvorenej aplikácie, zobraziť chybu/retry a po obnovení znovu overiť session/práva pred zápisom; odoslanie chatu používa existujúci plán idempotencie. Prežitie vynúteného ukončenia aplikácie systémom ani plnohodnotná offline synchronizácia nie sú súčasťou tejto verzie. Súkromné poznámky sa kvôli tomu nezačnú ukladať do localStorage alebo service-worker cache.

Rozšíriť existujúcu ochranu pred refreshom/navigáciou aj na notebook/task/chat drafty (`e2e/pwa-update.spec.ts:74`). Nová verzia aplikácie sa sama neaktivuje reloadom počas práce; zachovať blokovanie obnovy pri hovore/zvonení/pripájaní (`src/components/pwa/app-refresh-policy.ts:4`). Otvorenie nástroja nesmie odmontovať telefonický provider ani zakryť nevyhnutné ovládanie prebiehajúceho hovoru. Responzívny breakpoint nie je detekcia mobilnej PWA: zachovať rozlíšenie inštalácie/platformy v `src/lib/telephony/phone-platform.ts:2`, zúženie desktopového okna nesmie prepnúť telefonický režim.

Dnešný navigation guard sleduje iba case draft (`src/components/dispatch/DispatchConsole.tsx:848`); zaviesť spoločnú registráciu dirty/saving editorov pre prípad, úlohu, chat a notebook. Zvoliť správne uloženie alebo návrat do konkrétneho neuloženého editora, nespoliehať sa na jediný saveCaseDraftRef. Pri push správe potvrdiť service workeru jej prijatie ešte pred prípadným dialógom o drafte (`src/components/dispatch/DispatchConsole.tsx:1013`), aby čakanie na používateľa neotváralo druhé okno. Task-first otvorenie nahradí dnešné vyhľadávanie v cases[].tasks.

Opraviť aj worker fallback: `public/sw.js:140` dnes pri task push po timeoute bez ACK naviguje existujúce okno. Chýbajúce ACK však neznamená odhláseného používateľa ani bezpečný stav — mobilná PWA môže byť pozastavená s draftom/hovorom. Pri task aj call push sa existujúce okno nikdy nenaviguje len na základe timeoutu; bezpečnú navigáciu umožní iba výslovná odpoveď klienta po kontrole guardov. Pri neznámom stave iba fokusovať existujúce okno a ponechať cieľ na spracovanie po obnovení (minimálny navigačný intent s jedinečným ID, bez obsahu poznámok/chatu, overenie session/ACL pri spracovaní); neotvárať druhé okno kvôli oneskorenému ACK. Nové okno možno otvoriť pri preukázanej neprítomnosti existujúceho klienta. Prijatie aj oneskorená odpoveď sú idempotentné podľa intent ID; prihlásenie zachová cieľ úlohy. Zmeniť doterajší timeout test `src/components/pwa/service-worker.test.ts:156`, ktorý automatickú navigáciu očakáva, a preveriť oneskorený client resume.

Klik na push otvorí oprávnenú úlohu podľa task ID aj bez prípadu; funguje návrat z pozadia, už otvorené okno aj prihlásenie po vypršaní session. Zachovať kontrolu cieľových URL a potvrdenie spracovania pri otvorenom klientovi (`src/components/pwa/notification-target.ts:5`, `src/components/pwa/service-worker.test.ts:143`); notifikácia nie je príkaz automaticky vytočiť číslo. PDF musí byť použiteľné aj v mobilnom prehliadači a standalone PWA: autorizovaný súbor možno otvoriť/stiahnuť cez podporovaný tok zariadenia, bez straty formulára pri návrate. Konkrétne správanie otvorenia PDF a push overiť na skutočných cieľových zariadeniach, nie iba zmenou viewportu.

Mobilné brány: automatické fixtures pre 360, 390, 768, 1024, 1279 a 1280 px, výšku 844/900 px podľa zariadenia, 200 % zoom a prepnutie orientácie; bez horizontálneho posuvu dokumentu. Osobitný riadený test na iPhone/iPad a Android v prehliadači aj nainštalovanej PWA, kde je daný režim dostupný: softvérová klávesnica, safe-area, pozadie/návrat, push, PDF a ovládanie hovoru. Screenshot pri 390 px nie je dôkaz správnosti celého PWA životného cyklu. Použiť izolované dáta/provider fixtures; skutočné hovory až podľa samostatnej telephony aktivačnej brány.

### 4.2 Karta prípadu a PDF

Použiť poradie R10. Kompaktný prehľad sa odvodzuje z existujúcich uložených dát: číslo/stav/priorita/operátor; klient a telefón; EČV/značka/model; miesto a cieľ; pridelené vozidlo/služba; podstatné finančné a časové informácie, ak sú vyplnené. Prázdne fakty nevytvárajú veľké bloky. Dlhé popisy majú zobrazenie viac, plný text zostáva dostupný. Detailné editovacie sekcie a všetky existujúce polia zachovať, úlohy majú zbalenie s počtom otvorených/po termíne.

Jeden spoločný controller editora pre hlavičku aj formulár: stav/priorita používajú existujúce serverové akcie a úspešná zmena aktualizuje draft aj uložený snapshot. Serializovať vlastné uloženia, odosielať zmenené polia; status ostáva explicitná akcia. Pri súbehu ďalšieho používateľa overiť serverovú revíziu a ponúknuť načítanie konfliktu, nepísať starý celý snapshot. Dnešné `updateCase` zapisuje súvisiace entity pred prípadom (`src/server/motorist-mutations.ts:198`), preto nestačí CAS filter na poslednom update: kontrola očakávanej revízie, zápisy kontaktu/vozidla/adries/prípadu a aktivity musia prebehnúť v jednej DB transakcii. Konflikt alebo chyba neuloží nič. Serverová odpoveď aktualizuje iba potvrdené polia tejto revízie draftu, zachová editácie napísané počas requestu. Zlyhanie neschová prípad ani nestratí rozpracované údaje. Vyriešenie vyberie prípad z aktívneho zoznamu až po potvrdení serverom; z archívu ho možno znovu otvoriť. Vizuálne E1a možno dodať skôr; hlavičkové editovanie E1b vyžaduje tento serverový kontrakt a jeho lokálne overenú migráciu.

Históriu SMS vlastní zdieľaná finálna sekcia: kokpit a drawer ju zobrazia práve raz; zbalený kokpit neobsahuje ešte jednu samostatnú históriu. Mapa incidentu je zbalená, geocoding oddelený od vykreslenia; scroll bez úmyselnej mapovej interakcie nezoomuje.

PDF v hlavičke: najprv úspešne uložiť pending zmeny alebo zastaviť export s jasným stavom; potom vytvoriť exportný DTO v jednej databázovej snapshot transakcii vrátane súvisiacich úloh, udalostí a SMS. Renderer už číta iba tento DTO, takže súbežné úpravy nevytvoria zmes revízií. Uviesť čas/revíziu exportu. Obsah: prehľad, vyplnené podrobnosti prípadu, úlohy patriace k prípadu, poznámky/aktivita prípadu a SMS raz. Osobný notebook ani interný chat úloh sa automaticky neexportujú; prílohy iba ako zoznam, nie sťahovanie ľubovoľných externých URL. Text escapovať, lokálny font s diakritikou, bez načítania externých zdrojov.

Pridať autentifikovaný Node route handler pre download, nie vedľajší zápis create_pdf. Využiť existujúce `playwright-core`/Chromium po overení krátkym runtime prototypom v tejto Vercel kópii (`src/server/vehicle-lookup/providers/skp-browser.ts:18` je príklad životného cyklu, nie zdieľaná bežiaca session). `next.config.ts:16` dnes balí potrebné assets len pre vehicle lookup; doplniť tracing pre nový PDF endpoint, runtime limit a preveriť veľkosť balíka na Preview. Odpoveď application/pdf, attachment, private/no-store, vždy zavrieť browser. Release kritérium: 30-stranový fixture s dlhými textami sa stiahne bez orezania a v nastavenom limite funkcie; do review priložiť nastavený limit, skutočný čas, pamäť a vizuálne skontrolovaný PDF. Pri zlyhaní merania upraviť renderer pred pokračovaním; tlačové okno nie je náhrada sľúbeného súboru.

### 4.3 Notebook a serverové súkromie

Nové navrhované tabuľky `motorist_notes` (id, organization_id, owner_profile_id, title, body, revision, timestamps) a `motorist_note_shares` (note_id, recipient_profile_id, organization_id; unique príjemca/poznámka). Vlastník číta/upravuje/maže/zdieľa, vybraný aktívny kolega v tej istej organizácii iba číta. Prázdny zoznam zdieľania = súkromné; rola admin sama osebe nedáva produktový prístup k notebooku iného používateľa. Mazanie s možnosťou zrušiť potvrdenie; odobratie zdieľania nezmaže poznámku.

API aj RLS kontrolujú aktívneho používateľa, organizáciu, vlastníka/príjemcu. Na administrátorskom DB klientovi RLS nestačí; explicitné overenie aj pri každom read/write/search/share/delete. Telo, názov a príjemcovia notebooku nesmú vojsť do celofiremného dispatch snapshotu, logov, udalostí prípadu ani PDF. Samostatný actor-scoped DTO; obsah notebooku sa neukladá do localStorage. Automatické uloženie s viditeľným stavom, chybou a retry; revision zabráni tichému prepísaniu druhou kartou. Prepnutie widgetu zachová dirty draft.

Realtime posiela iba obsahovo prázdne invalidácie používateľovi; nasleduje nové oprávnené načítanie. Po odobratí zdieľania už žiadny nový request nevráti obsah; otvorená karta ho vyčistí po invalidácii, pri opätovnom focus/refetch a najneskôr pri 30-sekundovej aktívnej kontrole v online aplikácii s úspešnou autorizačnou odpoveďou. Pri revokácii, odhlásení a zmene používateľa vyčistiť všetky príslušné view/cache a zvýšiť generáciu načítania: oneskorená odpoveď starej generácie nesmie obsah obnoviť. Offline už zobrazený obsah nemožno spätne odvolať; pri chýbajúcom potvrdení oprávnenia po návrate online obsah najprv skryť. Neopierať revokáciu len o Broadcast ACL, ktoré sa môže držať do nového JWT/pripojenia. Prvá verzia nepotrebuje push/email z notebooku, čo znižuje únikové cesty.

Pred touto časťou opraviť aj súvisiace notifikácie: privátne čítanie/read/archive podľa skutočného recipienta v serveri, nie cez klientské Moje; pri snooze zachovať existujúcu kontrolu recipienta (`src/server/motorist-mutations.ts:847`). Aj `motorist_task_reminders` potrebuje SQL hranicu recipient/team: dnešná RLS povoľuje všetky operácie členovi organizácie (`supabase/migrations/20260609110000_task_reminders_notifications.sql:68`). Priame čítanie cudzej privátnej pripomienky zakázať aj produktovému adminovi; zmeny recipient/visibility a lifecycle vykonáva iba autorizovaná serverová transakcia s overením aktuálneho task/actor, nie ľubovoľný klientsky update. Poznámkový obsah do reminder payloadu nikdy nevkladať.

Konkrétne uloženie nového osobného stavu: samostatný riadok `motorist_notifications` pre každého príjemcu, visibility=private; dedupe identita zahŕňa zdrojovú udalosť/task, reminder generáciu a recipienta. Read/archive/snooze preto prirodzene mení len jeho riadok. Tímová udalosť môže vytvoriť osobné doručenia aktuálnym oprávneným členom, ale text sa nezobrazí neautorizovanému používateľovi. Historické tímové záznamy počas prechodu ostanú výslovne spoločné, neinterpretovať ich dodatočne ako osobné. SQL testy overia nemožnosť zmeniť recipienta/visibility tak, aby si používateľ sprístupnil cudzí riadok; serverový materializer má iba potrebnú dôveryhodnú cestu.

### 4.4 Úlohy, chat a prechod z jedného na viac prípadov

Zachovať `motorist_case_tasks` a všetky task IDs. Pridať `motorist_task_case_links` s unikátnou väzbou task/case v organizácii a transakčným overením organizácie oboch strán. Dnešný case_id sa stane nullable kompatibilným pôvodným prípadom; už nepoužívať ho ako úplný zoznam väzieb. Backfill vloží presne jednu väzbu za existujúcu úlohu. Autoritatívny zoznam pripojených prípadov je links; globálny zoznam úloh je samostatný a deduplikuje task ID, jednotlivé karty sú projekcie cez links. Nula väzieb je platná tímová úloha.

Prechod expand → bridge/backfill → kompatibilné čítanie → zapnutie 0..N: staré case-akcie aj nové task-akcie musia volať spoločnú transakčnú mutačnú službu; DB most zachytí legacy insert s case_id v tej istej transakcii. Pôvod systémových callback/SMS úloh sa ukladá osobitne ako nemenná provenance (typ zdrojového workflow + jeho stabilné ID + pôvodný prípad), nie podľa editovateľného kind či názvu. Backfill použije len dokázané väzby z existujúcich callback/SMS záznamov; nejednoznačné položky majú do vyjasnenia zablokované prelinkovanie pôvodu. Pôvodný prípad systémových úloh nemožno zameniť za iný; dodatočné links sú iba kontext. Pri bežnej úlohe odstránenie origin väzby v novej službe nastaví case_id na null, nemení zostávajúce links.

Legacy matica: INSERT s case_id atomicky doplní link; UPDATE bežných polí zachová links/provenance, zmenu origin mimo novej služby odmietne; DELETE je výslovné zmazanie celej úlohy, nie unlink. Nové UI ponúkne odpojenie od prípadu oddelene od zmazania úlohy s dopadom na všetky odkazy/chat/reminders. Starý delete dnes mení reminders/notifikácie ešte pred DELETE (`src/server/motorist-mutations.ts:576`, `src/server/motorist-mutations.ts:3042`), takže ochrana len posledného DELETE nestačí. Pred aktiváciou 0..N/chat musí byť celý legacy workflow presmerovaný na novú transakciu alebo zablokovaný pred prvým vedľajším zápisom. Zvolená rollout brána: inventár všetkých zapisujúcich dev/Preview/production deploymentov tejto kópie, kompatibilná verzia na každom povolenom writeri; starým deploymentom zamedziť zápisy. Ak niektorý writer nemožno vyradiť, aktiváciu zastaviť, kým SQL compatibility guard nedokáže odmietnuť všetky jeho predbežné zmeny aj DELETE bez čiastočných efektov. Nevyhlasovať túto bránu za splnenú iba úspešným insert triggerom. Presné kompatibilné SQL a migráciu overiť lokálnym Postgres testom pred aplikovaním.

Zmena FK: odstránenie prípadu maže iba link a nastaví kompatibilný case_id na null; nemaže zdieľanú úlohu, jej chat ani reminder. Historická callback/SMS povinnosť má samostatnú nemennú identitu a pri zmazaní prípadu sa riadene zruší, nie automaticky presunie alebo splní. Nevytvárať úlohu za každý link. Jedno dokončenie úlohy a jedna sada reminderov podľa task ID; nezatvárať ostatné úlohy či prípady.

Nové task API je identifikované task ID nezávisle od case; staré case endpoints ostanú adaptéry. Presunúť čítanie z cases[].tasks na samostatný task model aj v snapshot typoch, prehľadoch a počítadlách. Pri úlohe pre viac prípadov ukázať všetky oprávnené odkazy, nevyberať náhodný prípad; dokončený prípad možno prepojiť bez jeho znovuotvorenia. Nové správanie sa nezapne pred kompatibilnou schémou a overenými starými zápismi.

Chat: `motorist_task_messages` s task ID, organizáciou, autorom zo session, textom, created_at a client_message_id na idempotentné odoslanie. Jednoduché chronologické komentáre, stránkovanie 50 správ, limit 10 000 znakov; žiadne prílohy/zmienky/privátne úlohy v prvom rozsahu. Práva podľa existujúceho tímového prístupu k úlohám, cross-org zakázané; chat patrí úlohe, nezapisuje sa opakovane do aktivít všetkých prípadov. Zachovať neodoslaný text pri prepínaní, retry nevytvorí duplikát. Zobrazenie správ sa obnovuje spoločným invalidovaním/refetch, nie ďalšou paralelnou databázou chatu.

### 4.5 Pripomienky a notifikácie

Použiť existujúci materializer, dedupe, push/email voľby, toast a zvonček. Rozlíšiť termín úlohy, voliteľné „pripomenúť o“ a odklad už doručeného upozornenia. Reminder.case_id musí byť nullable; obsah a deep link sa odvodzujú primárne od task ID. Dokončenie/preradenie/posun termínu zruší staré pending pripomienky. Znovuotvorenie s rovnakým termínom musí vytvoriť novú platnú generáciu pripomienky alebo atomicky reaktivovať zrušenú, bez starého blokujúceho dedupe kľúča. Retry tej istej generácie nevytvorí druhý toast/push.

Klik zo zvončeka otvorí konkrétnu úlohu v strede a zachová kontext prípadu; funguje aj pre úlohu bez prípadu. Zvonček, widget a stránka zdieľajú jeden stav a count. Päťminútový cron zostáva jediný background spúšťač; aktívna konzola môže využiť existujúci materialize endpoint. Pri zatvorenej aplikácii očakávame doručenie pri najbližšom úspešnom cykle po termíne, nie presnosť na sekundy; monitorovať omeškanie a chyby doručenia.

### 4.6 Telephony ako oddelená etapa

R07–R09 sú súčasť úplného zadania, ale nesmú blokovať prvý UI balík a nesmú sa aktivovať počas plánovania. Najprv auditovať existujúce adresárové telefónne polia, routing a oprávnenia tejto kópie; doplniť iba chýbajúce správanie.

R07: oddeliť identitu prijatého čísla od overeného dial čísla kontaktu; všetky callback tlačidlá používajú spoločné rozhodnutie. Neznáme číslo ponechať nezmenené, nikdy neodhadovať infolinku. U známeho non-callback čísla ukázať hlavný kontakt a potvrdené cieľové číslo; história pôvodného volajúceho sa neprepisuje. Zachovať callbackRequestId a auditovanú väzbu pôvodnej povinnosti na explicitne schválený dial cieľ: dnešný proof používa vytáčané číslo (`src/server/telephony/contact-proof.ts:98`) a SQL kontroluje pôvodné číslo requestu (`supabase/migrations/20260928120000_callback_contact_fulfillment.sql:91`). Upraviť proof kontrakt tak, aby oprávnený alternatívny cieľ vedel splniť presne danú povinnosť, nie ďalšie requesty s podobným kontaktom. Bez preukázanej väzby žiadne automatické splnenie.

R08: použiť existujúce firemné čísla a hlavný ring plán; preferovať interné nasmerovanie na tú istú frontu bez opakovaného PSTN vytáčania hlavného čísla a bez slučky. Hláška nesmie odovzdať neoverené číslo. Prázdny ring plán nie je riešenie — súčasný engine vtedy ponúkne callback. Konkrétne DID, cieľová linka/fronta a text hlášky sa určia pred aktiváciou, z dovolených nastavení tejto kópie. Nepridávať druhý callback engine. Operátorské štatistiky sa overia pre dvoch používateľov zdieľajúcich caller ID.

R09: existujúci manager/admin monitor/whisper zachovať. Pre bežného zaúčaného dispečera treba explicitnú, auditovanú pozvánku od účastníka vlastného hovoru do monitor režimu: iba daný hovor/príjemca, jednorazové prijatie, zánik pri ukončení/odvolaní. Na serveri aj u providera zakázať zmenu na whisper/barge bez existujúceho vyššieho oprávnenia; samotný mute v UI nie je ochrana. Pozývateľ môže poslucháča odpojiť, odpojenie neukončí klientsky hovor. Detaily implementovať cez existujúci conference/reducer tok po overení jeho testov, nevytvárať novú telefonickú službu. Zachovať dôkaz počuteľnej dvojice klient/operátor a ochranu pred zmenou topológie: `src/server/telephony/contact-proof.ts:242` vyberá túto dvojicu z konferencie, preto tretí monitor sám osebe neznamená neplatný proof. Testovať pripojenie/odpojenie počas vyhodnocovania bez nesprávneho callback completion. Fyzický trojstranný audio test zostáva podmienkou aktivácie, nie je nahradený unit testom.

## 5. Etapy implementácie a závislosti

| Etapa | Konkrétna práca | Podmienka hotovo |
| --- | --- | --- |
| E0 — aktuálny základ | Overiť aktuálny dev tejto kópie, prečítať relevantné nainštalované Next návody; znovu porovnať dotyky s týmto auditom. Pracovnú vetvu nepremenovávať. | Žiadny cudzí projekt, známy baseline a kompatibilita; pri posune dev upravené odkazy/rozdiely. |
| E1 — opravy karty a máp | E1a: R03/R10, jedna SMS sekcia, rozloženie; E1b: R11, spoločný editor + atómová serverová transakcia. Dotyky CaseCockpitPanel/CaseDetail/CaseDrawer/LocationPicker a motorist-mutations/SQL. | AC01–AC04 a existujúce responsive testy; E1b až po overení transakcie. |
| E2 — pracovná plocha | R02/R04/R05/R06/R13/R14; extrakcia RoutePlanner modelu, widget host, osobné rozloženie. | AC05–AC08, bez nových externých lookupov. |
| E3 — ochrana a schéma | Actor filter notifikácií a reminder RLS; notebook ACL; task links/provenance, nullable FK/reminders, compatibility bridge a rollback; typy/repository/mutations. | AC09–AC12 na izolovanom Postgrese aj API, overená matica starých writerov vrátane delete. Nové UI zatiaľ vypnuté. |
| E4 — notebook a úlohy | R01/R15 UI, chat, task-first navigácia, reminder lifecycle, zdieľaný zvonček. | AC09–AC15; po E3, používa host E2. |
| E5 — PDF | Autorizovaný endpoint, exportný DTO, print šablóna a runtime meranie. | AC16; po stabilizovaní karty E1. |
| E6 — telefonické požiadavky | R07–R09 samostatné PR a nastavenia, existujúce routing/conference/adresár služby. | AC17–AC19, presné firemné ciele a audio skúška pred aktiváciou. |
| E7 — pilot a release | Integračná kontrola, klientský scenár, Preview, PR dev, dev alias; neskôr release PR dev→main. | AC20 a všetky brány príslušného balíka. |

E1/E2 zdieľajú DispatchConsole/CaseDetail, preto majú jedného integračného vlastníka. E3 môže bežať súbežne s E1/E2 na dohodnutom DTO; E5 paralelne po E1. Pri E3 sa migračný SQL pripraví a otestuje lokálne; každé vzdialené použitie migrácie vyžaduje explicitný pokyn podľa pravidiel tejto kópie.

R16 nie je neskoršia samostatná úprava: E1 zahŕňa mobilnú kartu/klávesnicu, E2 dostupnosť widgetov v každom breakpointe, E4 mobilné drafty/push/deep links, E5 PDF na zariadení a E6 mobilnú call-bar regresiu. E7 neuzavrie príslušný balík bez relevantných AC21–AC25 a záznamu zariadenie/OS/prehliadač/režim/výsledok.

## 6. Akceptačné kritériá a testy

| ID | Overiteľné kritérium | Overenie |
| --- | --- | --- |
| AC01 | V kokpite, draweri aj po zbalení/obnovení je najviac jedna história SMS; pri otvorenom detaile jedna úplne na konci. | Playwright podľa počtu sekcií a poradia. |
| AC02 | Hlavička → prehľad → úlohy → formulár → aktivita → SMS; úlohy možno zbaliť, dlhý text je celý dostupný, žiadne stratené pole. | Fixture prázdneho a maximálne vyplneného prípadu, 3 viewporty, 200 % zoom. |
| AC03 | Zmena priority v hlavičke + následný autosave zachová novú prioritu; súbežný cudzí zápis vyvolá konflikt; chyba/konflikt nemení ani kontakt/vozidlo/adresu/aktivitu; odpoveď neprepíše novšie písanie; neúspešné vyriešenie neskryje prípad. | SQL transakčný rollback + API so zámerným oneskorením, E2E dirty editor, archív→reopen. |
| AC04 | So zbalenou mapou funguje adresa/GPS; koliesko nemení zoom, rozbalenie zachová polohu. | E2E so stub geocoderom a kontrolou scroll/zoom. |
| AC05 | Mapa/Úlohy/Poznámky/tabuľka sa prepnú bez straty aktívneho prípadu, case/task/chat/notebook draftu alebo hovoru. | E2E prázdny/vyplnený workspace a simulovaný aktívny hovor. |
| AC06 | Oba panely úplne zbaliť aj obnoviť myšou/klávesnicou; widgety premiestniť a obnoviť po reload; používateľ B nezdedí preferencie A. | E2E vrátane resetu a chybných/starých localStorage dát. |
| AC07 | Kalkulačka dá výsledky 105/30 z príkladov, podporí čiarku/bodku a odmietne delenie nulou; route stale odpoveď neprepíše novšiu. | Unit parsera a existujúci route E2E rozšírený o widget bez mapy. |
| AC08 | Vyhľadávanie otvorí správny typ výsledku; neoverená/obsadená flotila nie je voľná; externý lookup sa nespúšťa pri každom stlačení klávesu. | Fixtures typov/obsadenosti, kontrola počtu provider požiadaviek. |
| AC09 | Notebook A vidí A a explicitný príjemca B, C/inej org/neaktívny používateľ nemajú prístup ani priamym API/SQL; B nesmie editovať/zdieľať. | API + reálny lokálny Postgres RLS role matrix. |
| AC10 | Po odobratí share API okamžite zamietne nové čítanie; aktívna online karta s úspešnou autorizačnou odpoveďou vyčistí obsah do 30 s; oneskorený request zo starej generácie ho neobnoví; texty nie sú v snapshot/search/log/PDF. | Dve browser sessions, odhlásenie/zmena actor, negatívne payloady, oneskorená odpoveď po revokácii a výpadok invalidácie. |
| AC11 | Migrácia zachová ID, autora/pridelenie, termíny, stavy, callback/SMS provenance; nový link nemení origin povinnosti. Starý insert vytvorí link; starý update ani delete obchádzajúci nový workflow nepoškodí links/chat/reminders/notifikácie. | Migračný kontrakt pred/po; celá sekvencia starého writera vrátane predbežných side effects a nové RPC súbežne; rollout inventár. |
| AC12 | Úloha s 0/1/3 prípadmi sa v globálnom zozname/počte objaví raz, v každom pripojenom prípade raz. Unlink/case deletion nezmaže ostatnú úlohu/chat/reminder. | SQL + API + E2E vrátane dokončeného prípadu a rollback čítania. |
| AC13 | Chat retry vytvorí jednu správu, autor je zo session, 51 správ sa stránkuje v stabilnom poradí, cudzie task ID je zamietnuté. | API idempotencia/ACL, E2E dvoch používateľov a draftu. |
| AC14 | Zmena termínu/pridelenia/dokončenie/reopen rovnakého termínu dávajú správnu novú pripomienku; retry negeneruje ďalšie upozornenie. | Fake clock a provider unit/integration, existujúce reminder testy. |
| AC15 | Bell otvorí task bez case aj s 3 cases; privátny notification/reminder A nemôže čítať/meniť B ani produktový admin; recipient/visibility nemožno zmeniť na obídenie prístupu; count vo všetkých pohľadoch sa zhoduje. | API + SQL RLS negatívna matica vrátane status/snooze/recipient; per-recipient dedupe; tímové notice podľa explicitnej politiky. |
| AC16 | Export vráti platný PDF po uložení s diakritikou a jedinou SMS sekciou, bez notebook/chat; súbežný zápis nevytvorí zmes revízií; neoprávnený export je zamietnutý. | Snapshot transakčný test, PDF metadata/text extraction + vizuálna kontrola strán, 30-stranový Preview fixture vrátane balenia Chromium. |
| AC17 | Non-callback kontakt vytáča iba overený cieľ; neznámy zachová pôvodné číslo; história sa nemení. Oprávnený alternatívny cieľ splní presne spojený callbackRequestId; nepreukázaný cieľ a ostatné requesty sa nesplnia. | Dialer/callback fixtures vrátane pozitívneho a negatívneho proof/SQL completion testu. |
| AC18 | Spätný hovor na nastavené firemné DID ide na hlavnú frontu bez slučky; dva operátorské hovory s rovnakým caller ID sú štatisticky oddelené. | Fake telephony/reducer + neskorší riadený telefonický test tejto kópie. |
| AC19 | Pozvaný poslucháč počuje obe strany, nikto nepočuje jeho mikrofón; prechod do whisper/barge je zamietnutý; odpojenie zachová hovor aj správnu identitu dôkazu klient/operátor. | API/reducer/contact-proof vrátane súbehu zmeny topológie a neskorší fyzický audio test s 3 účastníkmi. |
| AC20 | Pilotný tok: prijať simulovaný hovor → prípad → úloha s 2 prípadmi → poznámka → trasa/km/výpočet → reminder/chat → stav → PDF, bez dvojitého zápisu alebo straty draftu. | E2E fixture + klientská ukážka a zoznam pripomienok. |
| AC21 | Na 360/390/768/1024/1279/1280 px sa dá otvoriť každý oprávnený widget, upraviť poradie aj bez drag a vrátiť do prípadu bez zmeny draftu; žiadny nástroj nie je dostupný iba v skrytom sidebar. | Playwright viewport/breakpoint fixture; kontrola poradia a zhodnej identity dát, bez horizontálneho overflow. |
| AC22 | Klávesnica, safe-area, spodná navigácia ani call bar nezakryjú nedosiahnuteľne vstup/Odoslať/Uložiť; stav/priorita/PDF a chat fungujú dotykom; otočenie zachová draft. | Automatická geometria a min. 44×44 ovládanie; manuálna skúška soft klávesnice/orientácie na cieľových iOS/Android zariadeniach a 200 % zoom. |
| AC23 | Prepínanie nástrojov, push navigácia a ponuka PWA aktualizácie nezahodia case/task/chat/notebook draft; počas hovoru či pripájania nevykonajú reload ani zmenu telefonického režimu; timeout bez ACK nenaviguje pozastaveného klienta. | Rozšíriť pwa-update/mobile-call-bar/mobile-calling-preflight aj worker testy; foreground/background s draftom/hovorom a ACK oneskoreným nad timeout, zúženie desktopového okna. |
| AC24 | Nové privátne API/PDF nie sú v offline cache; neúspešné uloženie sa netvári ako úspešné; reconnect overí session/ACL, chat retry nevytvorí druhú správu. | Service-worker unit/integračné kontroly cache a API, E2E offline→online/expired session s otvoreným draftom. |
| AC25 | Push otvorí správnu úlohu s 0/1/3 prípadmi v otvorenej aj znovuspustenej PWA; neskoré ACK nevytvorí druhé okno/otvorenie; prihlásenie zachová task cieľ a neautorizovaný task sa nezobrazí; PDF možno otvoriť/stiahnuť a vrátiť sa do prípadu. | Stubovaný worker/deep-link test vrátane oneskorenia/absencie ACK a riadený reálny iOS/Android browser/standalone test; zaznamenať podporovaný tok a výsledok. |

Rozšírený testovací plán: **unit** parser kalkulačky, normalizácia EČV, task/count/deep-link pravidlá, reminder generácie; **integration** skutočný izolovaný PostgreSQL pre RLS a FK/migračný most, actor-scoped API, idempotencia chatu, case concurrency, fake telephony; **E2E** vyššie uvedené pohľady, chyby siete a dva používatelia, PDF a regresné callback/SMS scenáre; **observability** merať chyby/latenciu uloženia, konflikty, nepovolené API odpovede, oneskorenie reminderov a runtime PDF s ID udalosti bez citlivého obsahu. Doručenie push/email a fyzické audio overiť osobitne pred aktiváciou, nie iba mockom.

Relevantné existujúce testy: `e2e/dispatch-responsive.spec.ts:379`, `e2e/dispatch-responsive.spec.ts:585`, `e2e/route-planner.spec.ts:54`, `e2e/callback-legacy-task.spec.ts`, `e2e/call-notification-focus.spec.ts`, `src/server/motorist-mutations.task-actions.test.ts:164`, `src/server/task-notifications.test.ts:30`, `src/domain/notifications.test.ts:57`.

Mobilný/PWA základ pre rozšírenie: `e2e/mobile-pwa.spec.ts:62`, `e2e/mobile-bottom-navigation.spec.ts`, `e2e/mobile-call-bar.spec.ts`, `e2e/mobile-calling-preflight.spec.ts`, `e2e/pwa-update.spec.ts`, `src/components/pwa/service-worker.test.ts`, `src/components/pwa/notification-target.test.ts`, `src/components/pwa/app-refresh-policy.test.ts`. Ich existencia nie je dôkazom splnenia nových AC21–AC25; nové scenáre ešte len treba implementovať a spustiť.

Pri dodatku v3 boli spustené štyri existujúce izolované suite: `pnpm exec vitest run src/components/pwa/service-worker.test.ts src/components/pwa/notification-target.test.ts src/components/pwa/app-refresh-policy.test.ts src/components/pwa/useAppUpdate.test.ts` — **4 súbory, 69 testov prešlo**. Potvrdzuje to aktuálny základ; doterajší worker timeout test výslovne očakáva správanie, ktoré AC23 mení, preto úspech týchto testov nie je dôkazom budúcej bezpečnej navigácie. Mobilné E2E, skutočné zariadenia a nové AC21–AC25 sa počas plánovania nespúšťali.

## 7. Pre-mortem: tri možné zlyhania a prevencia

1. **Po prerobení plochy sa stratí rozpracovaný prípad alebo priorita.** Príčina: remount editora alebo starý autosave snapshot. Prevencia: spoločný controller, serializácia vlastných zápisov a serverová revízia, AC03/AC05; pri chybe vypnúť nový layout bez zahodenia draftu.
2. **Viac prípadov spôsobí duplicitné reminder/callback alebo zmiznuté úlohy.** Príčina: flatten podľa prípadov, cascade delete, legacy writer mimo novej služby. Prevencia: stabilné task ID, kanonická kolekcia, transactional bridge, upravené FK, AC11/AC12/AC14 a callback/SMS regresie. Rollback UI používa kompatibilné čítanie; žiadny rollback DROP tabuliek s novými dátami.
3. **Súkromná poznámka alebo upozornenie unikne kolegovi.** Príčina: admin klient s org-only filtrom, org snapshot alebo obsah v realtime. Prevencia: actor-specific DTO/ACL + RLS, žiadny obsah v broadcast, overenie revokácie a negatívnych payloadov AC09/AC10/AC15. Nové súkromné UI nepustiť pred úspešnou kontrolou serverovej hranice.

## 8. Overenie tohto plánu, build brány a release

Už vykonané pri plánovaní: prečítaná celá transkripcia a oba skilly ralplan/plan; nezávislý audit UI a dát; rešerš relevantných nainštalovaných Next 16.2.6 návodov a primárnych dokumentácií. `pnpm install --frozen-lockfile --ignore-scripts` nainštaloval závislosti bez zmeny manifestu/lockfile. Cielený príkaz:

```sh
pnpm exec vitest run src/domain/tasks.test.ts src/domain/notifications.test.ts src/server/task-notifications.test.ts src/server/motorist-mutations.task-actions.test.ts src/server/telephony/conference-actions.test.ts src/server/telephony/stats.test.ts src/components/dispatch/settings/ring-plan-model.test.ts
```

Výsledok: **7 súborov, 114 testov prešlo**, 10. 9. 2026. Ide o existujúci izolovaný základ s fake DB/providerom, nie test budúcich funkcionalít. Počas plánovania nebol spustený build, celý suite, E2E ani živé hovory, nevykonali sa DB zápisy alebo nasadenie. Automatická kontrola overila 59 odkazov na zdrojové súbory a platnosť čísel riadkov; R01–R15 a AC01–AC20 sú prítomné. Architect po zapracovaní šiestich pripomienok schválil v2; až potom nezávislý Critic porovnal celý plán s transkripciou a bodovo s kódom a vrátil APPROVE bez materiálnych výhrad. Výsledky kontroly sú aj v `.context/dispatch-plan-validation.json`.

Pri implementácii: `pnpm exec vitest run`, `pnpm typecheck`, `pnpm build` ako povinná Preview brána, ďalej relevantné node testy cez `pnpm test` a cielené Playwright scenáre. Lokálne fixtures musia zastaviť externé zápisy; automatické E2E nespúšťať slepo proti dev/Preview, keďže ich databáza je zdieľaná a každý zápis je reálny. RLS/migračné testy vykonať na izolovanom Postgrese, nie na zdieľanej Supabase databáze.

Deployment riadi konkrétne `AGENTS.md`: vychádzať z aktuálneho dev, dedicated pracovná vetva bez premenovania tejto vetvy, push → skontrolovať Preview a build → PR do dev → po merge overiť dev alias → release len PR dev do main. Všeobecný Conductor target origin/main nie je skratka okolo tohto release postupu. Pôvodný produkčný projekt sa nečíta ani nemení. Vzdialené migrácie/seed iba na výslovný pokyn a proti tejto kópii; nevytvárať workery/listenery/schedulery, jediný cron ostáva `*/5 * * * *` na `/api/telephony/cron` s CRON_SECRET. V tomto kroku sa nerobí PR ani push.

Nové 0..N úlohy a notebook sa zapnú až po schéme a serverovej ochrane; návrat k starému UI ponechá nové údaje, kompatibilný reader a ochrany. Pred aktiváciou telephony treba konkrétne firemné DID/cieľovú frontu/text hlášky a audio dôkaz. Tieto hodnoty nie sú potrebné na vytvorenie plánu alebo realizáciu UI etáp.

## 9. ADR a pripravenosť

**Rozhodnutie:** inkrementálne rozšíriť existujúcu konzolu, task model, notifikácie a route službu; notebook je nová samostatne chránená entita. Telefonické rozšírenia tvoria oddelenú etapu.

**Dôvody:** rýchlejšia práca pri hovore, minimum duplicít, bezpečná kompatibilita. **Alternatívy:** nová plocha so spoločným backendom je možná, ale pridáva paralelné UI a testovaciu záťaž; druhý task backend nie je odôvodnený. **Prečo táto voľba:** audit potvrdil väčšinu základných služieb aj konkrétne lokálne chyby, ktoré sa dajú opraviť bez celkového prepisu. **Dôsledky:** task 0..N a notebook vyžadujú migráciu/ACL, PDF reálny renderer, existujúce monolitické UI treba rozčleniť. **Nadväzujúce kroky:** pilot poradia karty a widgetov, verifikácia schémy na aktuálnom dev, runtime PDF a telefónne nastavenia pred aktiváciou.

Pripravenosť: základ pre implementáciu je dostatočne konkrétny; nejde o náhodný redesign ani duplikát. Najrizikovejšie časti sú serverové súkromie, task migrácia a súbeh ukladania. Ich overenie je výslovná podmienka releasu. Funkčnosť nového vývoja možno potvrdiť až implementáciou a uvedenými testami, nie týmto plánom.

## 10. Realizačné možnosti podľa skillu

V tomto runtime sú dostupní rovnocenní natívni spolupracujúci agenti; Planner, Architect, Critic, researcher, UI/data auditor, implementer a verifier sú im pridelené úlohy, nie tvrdenie o dostupnosti osobitných bináriek/modelov. Súbežne najviac vedúci + 3 agenti. Plánovanie: vedúci Planner, Architect až po drafte, Critic až po Architect; bez modelových override.

Pre `$ralph`: jeden vlastník E0→E7, deleguje audit a overenie, pre dátové migrácie a ACL odporúčaná vysoká úroveň uvažovania. Pre `$team`: vedúci integrácie + UI agent (E1/E2, stredná až vysoká), data/ACL agent (E3/E4, vysoká), PDF/test agent (E5 a nezávislé kontroly, vysoká pri ACL). Rovnaký súbor má vždy jedného editujúceho vlastníka. Po dátovej etape možno slot použiť na telephony (vysoká). Dostupnosť a presné rozhranie `$ralph`/`$team`/OMX treba pri budúcom spustení overiť prečítaním príslušných skillov; teraz sa nespúšťajú.

Námety na budúce spustenie, nie vykonané príkazy:

```text
$ralph implementuj .omx/plans/dispatch-client-plan.md po etapách a over AC01–AC20
$team implementuj .omx/plans/dispatch-client-plan.md: UI; data/ACL; PDF/testy; vedúci integruje
```

Tím pred ukončením odovzdá zmeny, test logy, migračnú kompatibilitu, ACL negatívne testy a E2E/PDF dôkazy. Vedúci overí spoločný build a integrovaný pracovný tok. Následný Ralph je vhodný na sústavné opravy a finálne sekvenčné overenie, ak zostanú chyby. Ak používateľ chce dlhšie sledovaný cieľ, predvolený návrh je `$ultragoal` + `$team`: vedúci vlastní kontrolné body a tím dodáva dôkazy. Výskumné a výkonové goal workflow nie sú hlavný účel tohto zadania. Žiadny goal sa týmto plánom nezakladá.

## 11. Zdroje a revízny záznam

Nainštalované návody Next 16.2.6: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md:19`, `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md:197`, `node_modules/next/dist/docs/01-app/02-guides/data-security.md:55`, `node_modules/next/dist/docs/01-app/02-guides/authentication.md:1446`.

Návrh oddelenia server/client a oprávnených DTO vychádza z [Next data security](https://nextjs.org/docs/app/guides/data-security) a [route handlers](https://nextjs.org/docs/app/getting-started/route-handlers). Service role obchádza RLS, preto treba serverové kontroly; pozri [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security). Obmedzenia revokácie realtime oprávnení dokumentuje [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization). Možnosť generovania PDF dokladá [Playwright page.pdf](https://playwright.dev/docs/api/class-page#page-pdf); vhodnosť v tejto aplikácii ešte podlieha runtime testu.

- v1: pokrytie R01–R15; potvrdené duplicity SMS a nedokončený PDF; doplnený risk autosave, súkromie serverových notifikácií, nullable task/reminder väzby a kompatibilita callback/SMS; 114 základných testov prešlo.
- v2: Architect požiadal ITERATE; doplnená transakcia celého case zápisu, legacy DELETE a nemenná provenance, reminder RLS a per-recipient uloženie, ochrana pred oneskorenou odpoveďou po revokácii, snapshot/tracing PDF a kompatibilita alternatívneho callback cieľa s contact proof.
- Architect: **APPROVE v2**; všetkých šesť pripomienok zapracovaných, bez zostávajúcej materiálnej námietky.
- Critic: **APPROVE v2**, spustený až po ukončení Architect kontroly v samostatnom kontexte. Overil úplnosť transkripcie, princípy/alternatívy, riziká, akceptačné kritériá a konkrétne hraničné kontrakty proti kódu.
- Finálna administratívna úprava: zapísané výsledky kontrol; implementačný rozsah po schválení nezmenený.
- v3: na upresnenie používateľa doplnené R16, 4.1a a AC21–AC25 pre mobil/tablet/PWA naprieč etapami; dostupnosť widgetov aj pri skrytom sidebare, dotyk/klávesnica, update/draft/call ochrany, offline/ACL, push a PDF na zariadeniach. Na pripomienku Architect doplnená ochrana pred navigáciou existujúceho klienta pri ACK timeoute.
- Architect v3: **APPROVE** po doplnení bezpečného worker fallbacku; následne nezávislý Critic v3: **APPROVE**, bez materiálnych pripomienok. Posudzovali mobilný dodatok; v2 ostáva vecne zachovaná.
- Mobilné overenie podkladu: 4 existujúce PWA suite / 69 testov prešlo; nové mobilné funkcie a skúšky na zariadeniach zostávajú implementačnými podmienkami.
