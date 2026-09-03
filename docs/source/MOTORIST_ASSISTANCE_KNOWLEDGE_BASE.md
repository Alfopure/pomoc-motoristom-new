# Linka pomoci motoristom - znalostná báza pre CRM / dispečing

Verzia: pracovný discovery dokument
Dátum: 2026-05-20
Určené pre: GitHub repozitár, Codex/iConductor build, návrh dashboardu, neskorší vývoj produkčnej aplikácie
Stack predpoklad: Supabase, Vercel, moderný webový frontend

## 1. Účel dokumentu

Tento dokument je zdrojová znalostná báza pre návrh a implementáciu webovej aplikácie pre centrálny komunikačný a dispečerský systém služby Pomoc motoristom.

Cieľom nie je vytvoriť iba pekný dashboard. Cieľom je postaviť pracovný nástroj pre operátorov, ktorí prijímajú telefonáty, zakladajú prípady, koordinujú odťahy, náhradné vozidlá, komunikáciu s asistenčnými spoločnosťami, pobočkami, vodičmi, odťahovkami a klientmi.

Prvý výstup má byť klikateľná, moderná, svetlá a prehľadná ukážka pre klienta. Musí však vychádzať z reálnej prevádzky, aby sa z nej neskôr dala rozvinúť produkčná aplikácia.

## 2. Kontext firmy a služby

PomocMotoristom.sk komunikuje verejne ako služba zabezpečujúca náhradnú mobilitu. Web uvádza hlavné oblasti:

- pomoc pri nehode,
- pomoc s odťahom,
- náhradné vozidlo.

Služba rieši napríklad:

- rýchle odtiahnutie poškodeného vozidla do servisu,
- poskytnutie náhradného vozidla,
- pomoc pri škodových udalostiach,
- označenie prekážky v cestnej premávke,
- pomoc s vypísaním správy o nehode,
- odťah v rámci Slovenska aj zahraničia,
- odťah osobných, úžitkových, nákladných vozidiel, pracovných strojov a materiálu.

Verejne komunikované kontakty:

- nonstop linka: `0850 005 006`,
- odťah/cenová ponuka: `0910 541 622`,
- adresa: Tolstého 1201/20, 010 01 Žilina,
- email: `kancelaria@pomocmotoristom.sk`.

Brand pozorovaný z webu:

- svetlý základ,
- čierna/biela s výraznou žltou akcent farbou `#FCD703`,
- font Poppins,
- tón komunikácie: pomoc, zodpovedný partner, rýchlosť, praktickosť.

Pre aplikáciu nepoužívať marketingový landing-page štýl. Má ísť o pracovný dispečerský nástroj: hustý, čitateľný, pokojný, bez zbytočnej dekorácie.

## 3. Prevádzková realita z meetingu

Aktuálny problém nie je iba telefónna linka. Firma potrebuje procesný systém, ktorý odstráni chaos okolo hovorov, objednávok, odťahov, náhradných vozidiel, dostupnosti ľudí a odovzdávania informácií.

Z meetingu vyplýva:

- denne môže prísť okolo 30 nových prípadov,
- celkový počet telefonátov môže byť v silné dni 200 až 300,
- každý reálny prípad môže mať minimálne 4 telefonáty,
- veľká časť hovorov nie sú nové prípady, ale doplnenia, overenia, otázky, zbytočné hovory, spätné volania, interná koordinácia,
- prvý ostrý krok má byť menší pilot, nie verejne masívne propagovaná linka,
- existujú už rôzne kanály: náhradné vozidlá, odťahy, asistenčné služby, samoplatci, partneri, budúce dealerstvá,
- cieľom je časom poskytovať "firemnú asistenciu" pre partnerské dealerstvá/servisy,
- operátori musia byť schopní riešiť viac typov služieb, nielen svoju pôvodnú špecializáciu.

Ľudský model:

- začať pravdepodobne s 2 až 3 operátormi,
- fyzická práca na firme cez deň, home office pre noci/víkendy/sviatky,
- časom treba plánovať dochádzku, služby, dostupnosť a zástupy,
- operátor musí byť telefonicky silný, procesne disciplinovaný a technicky primerane zdatný,
- systém musí pomáhať, aby sa nezabúdali úlohy a nepadali informácie medzi ľuďmi.

## 4. Základná produktová vízia

Aplikácia je CRM + call-center konzola + dispečerská mapa + úlohový systém.

Operátor má v jednom okne vidieť:

- kto volá,
- či už dané číslo alebo ŠPZ existuje v histórii,
- či ide o nový alebo existujúci prípad,
- aké aktívne prípady horia,
- kde je klient,
- kam má ísť odťah,
- kde sú odťahovky,
- kde sú dostupné náhradné vozidlá,
- komu treba volať,
- čo treba urobiť ďalej,
- čo už bolo poslané, vybavené, priložené a ukončené.

Systém má byť human-first. Na začiatku nechceme IVR typu "stlačte 1, 2, 3" ako hlavnú skúsenosť klienta. Priorita je rýchla dovolateľnosť na človeka.

AI má byť pomocník v pozadí: prepis, sumarizácia, návrh ďalších krokov, QA scoring, reporting. Nemá nahradiť urgentnú ľudskú asistenciu.

## 5. Používatelia a roly

### Operátor / dispečer

Primárny používateľ. Prijíma a vytáča hovory, zakladá a aktualizuje prípady, posiela SMS, pracuje s mapou, zadáva úlohy, komunikuje s pobočkami, odťahovkami a klientmi.

### Senior dispečer / koordinátor

Vidí širší prehľad, kapacity, dostupnosť operátorov, otvorené prípady, štatistiky, odmietnuté prípady, marné výjazdy, reporty a kvalitu práce.

### Manažér

Sleduje výkon služby, dovolateľnosť, dôvody odmietnutia, využitie odťahoviek a náhradných vozidiel, potenciál na nákup techniky alebo posilnenie ľudí.

### Vodič odťahovky / pobočka / človek pri vozidle

Nie je nutne plný používateľ CRM v MVP. Časom môže mať mobilné zobrazenie alebo aspoň link/SMS workflow na potvrdenie polohy, fotky, dokumenty, stav výjazdu.

### Externý partner

Asistenčná spoločnosť, dealerstvo, servis alebo flotilový klient. V MVP iba zdroj prípadu. Neskôr môže mať portál alebo jednoduchý formulár.

## 6. Typy vstupov do systému

### Telefonát od klienta

Klient volá, že mal nehodu, poruchu, defekt, vybitú batériu, zamknuté kľúče, potrebuje odťah alebo náhradné vozidlo.

### Telefonát od asistenčnej spoločnosti

Asistenčka volá s objednávkou alebo doplnením. Môže ísť o odťah, náhradné vozidlo, termín, zmenu, storno alebo otázku k existujúcemu prípadu.

### Objednávka bez hovoru

Niektoré asistenčné služby môžu posielať objednávku bez predchádzajúceho hovoru. Systém musí umožniť založiť prípad aj manuálne bez prichádzajúceho hovoru.

### Samoplatca

Človek z ulice potrebuje pomoc, často cenu, lokalizáciu a rýchle rozhodnutie.

### Partnerské dealerstvo / servis

Budúci kanál: napríklad dealer/servis pošle klienta na asistenciu. Cieľom môže byť dostať klienta po nehode do partnerského servisu, zabezpečiť odťah, náhradné auto a administráciu.

### Interný hovor alebo nadväzujúca komunikácia

Operátor volá odťahovkárovi, pobočke, kolegovi, klientovi, asistenčke. Tieto hovory majú byť priradené ku konkrétnemu prípadu, ak súvisia s prípadom.

## 7. Typy prípadov

Minimálne kategórie:

- odťah,
- náhradné vozidlo,
- odťah + náhradné vozidlo,
- nehoda,
- technická porucha,
- chyba vodiča: defekt, palivo, vybité batérie, zamknuté kľúče,
- informačný hovor,
- samoplatca,
- asistenčný prípad,
- partnerský/dealerský prípad,
- interné doplnenie existujúceho prípadu.

Ukončenia:

- asistované / úspešne vyriešené,
- bez asistencie,
- odmietnuté,
- zrušené klientom,
- marný výjazd,
- nedostupná technika,
- nedostupné vozidlo,
- mimo kapacity,
- mimo rozsahu služby,
- duplicitný alebo informačný prípad.

Dôvody odmietnutia treba ukladať štruktúrovane, lebo z nich vyjde manažérsky insight. Príklad: ak sa často odmietajú garáže `-3`, môže dávať zmysel kúpiť inú techniku.

## 8. Hlavná obrazovka aplikácie

Hlavná obrazovka má byť pracovný dispečerský dashboard. Žiadny hero, žiadna marketingová stránka.

Odporúčané rozloženie:

- horná call lišta,
- ľavý panel aktívnych prípadov,
- pravý panel mapa,
- spodný alebo bočný panel úloh / fronty / alertov,
- možnosť prepnúť na režim jedného monitora alebo dvoch monitorov.

### Horná call lišta

Musí ukazovať:

- aktuálny prichádzajúci hovor,
- volané číslo/linku, napríklad linka pomoci, asistenčný kanál, samoplatca,
- číslo volajúceho,
- meno kontaktu, ak je známe,
- poslednú históriu podľa čísla,
- stav hovoru: zvoní, v rade, prijaté, zmeškané, ukončené,
- tlačidlá: prijať, vytáčať, zavesiť, presmerovať, priradiť ku prípadu,
- pole na ručné vytáčanie čísla,
- rýchle akcie: `Nový prípad`, `Pripojiť ku prípadu`, `Informačný hovor`.

### Panel aktívnych prípadov

Každý prípad v zozname má ukázať:

- interné číslo prípadu,
- čas založenia a čas poslednej aktivity,
- stav,
- prioritu,
- typ prípadu,
- ŠPZ/EČV,
- vozidlo,
- kontakt,
- miesto vyzdvihnutia,
- cieľ,
- zodpovedného operátora,
- najbližšiu úlohu,
- indikáciu nepriradených hovorov alebo chýbajúcich údajov.

Zoznam musí mať silný filter:

- full-text cez telefón, ŠPZ, meno, interné číslo, číslo asistenčného prípadu, vozidlo, operátora, pobočku, odťahovku,
- stav,
- typ,
- partner/asistenčka,
- dátum,
- otvorené/ukončené,
- horí/po termíne,
- moje prípady.

### Mapa

Mapa je primárny pracovný nástroj. Má zobrazovať:

- pickup pin,
- destination pin,
- trasu,
- vzdialenosť,
- ETA,
- pobočky,
- stanoviská odťahoviek,
- aktívne odťahovky,
- náhradné vozidlá podľa pobočky alebo reálnej polohy, ak bude dostupná,
- vrstvy a filtre.

Operátor musí vedieť adresu zadať textom aj kliknúť do mapy. Výsledok sa má uložiť do karty prípadu.

Mapa má pomáhať pri otázkach typu:

- kde sú Vestenice,
- ktorá pobočka je najbližšie,
- ktorý odťah je najbližšie,
- koľko kilometrov je pickup -> cieľ,
- koľko by stál samoplatca,
- či má zmysel poslať Bratislavu, Žilinu alebo inú pobočku.

### Úlohy a pripomienky

Každý prípad musí umožniť:

- vytvoriť úlohu,
- odložiť spätný hovor o 15/30/60 minút alebo konkrétny čas,
- priradiť úlohu operátorovi,
- označiť úlohu ako vybavenú,
- upozorniť, keď úloha horí,
- zobraziť otvorené úlohy naprieč prípadmi.

Toto je kritické, pretože v súčasnosti sa zabúda, že klient mal volať neskôr, niečo sa malo poslať alebo niekto mal niečo potvrdiť.

## 9. Karta prípadu

Karta prípadu má byť prehľadná a procesná. Nemá to byť dlhý formulár bez orientácie.

### Hlavička

- interné číslo prípadu,
- stav,
- priorita,
- typ prípadu,
- zdroj,
- zodpovedný operátor,
- dátum a čas založenia,
- posledná aktivita,
- SLA alebo cieľový čas, ak bude definovaný.

### Kontakt

- meno a priezvisko kontaktnej osoby,
- telefón,
- email, ak existuje,
- osoba na mieste,
- osoba oprávnená riešiť vozidlo, ak je iná,
- jazyk alebo poznámka ku komunikácii.

### Vozidlo klienta

- ŠPZ/EČV,
- VIN, ak bude dostupné,
- značka,
- model,
- kategória,
- automat/manuál,
- pojazdné/nepojazdné,
- problém: nehoda, porucha, defekt, batéria, palivo, kľúče, iné,
- špecifiká: garáž, výška, `-3` podlažie, hydraulická ruka, 4x4, blokované kolesá, váha.

Možný neskorší lookup:

- STK/technické dáta podľa EČV,
- SKP/poistné údaje,
- interné dáta existujúceho systému.

Tieto lookupy treba technicky a právne overiť.

### Lokality

- miesto vyzdvihnutia,
- cieľové miesto,
- preferovaný servis,
- najbližšia pobočka,
- vzdialenosť a ETA,
- manuálna poznámka k lokalite.

### Služby

- odťah: áno/nie,
- náhradné vozidlo: áno/nie,
- typ náhradného vozidla,
- požadovaná kategória,
- dostupné vozidlá,
- vybrané vozidlo,
- vodič/odťahovka,
- plánovaný čas príchodu,
- klient chce teraz / neskôr / zajtra / konkrétny čas.

### Poznámky

Jedno hlavné poznámkové pole musí byť stále dostupné. Okrem toho by mal systém ukladať časovanú timeline, aby bolo jasné, kto čo dopísal.

### Prílohy

Karta má podporovať súbory:

- fotky vozidla,
- fotky poškodenia,
- objednávky asistenčných služieb,
- zakázkové listy,
- vodičský preukaz, ak je právne a procesne povolené,
- fakturačné podklady,
- dokumenty k náhradnému vozidlu,
- iné prílohy.

Prílohy ukladať cez Supabase Storage, ale metadáta držať v tabuľkách.

### Timeline

Každý prípad potrebuje auditnú históriu:

- založenie,
- zmena stavu,
- hovor prijatý/odchádzajúci/zmeškaný,
- SMS odoslaná,
- úloha vytvorená/splnená,
- príloha pridaná,
- operátor zmenený,
- poznámka doplnená,
- ukončenie s dôvodom.

## 10. Stavové modely

### Stav prípadu

Odporúčané interné stavy:

- `new` - nový, ešte netriedený,
- `triage` - operátor zisťuje údaje,
- `open` - otvorený prípad,
- `waiting_for_client` - čaká sa na klienta,
- `scheduled` - naplánované na neskôr,
- `assigned` - priradená odťahovka/pobočka/vozidlo,
- `dispatched` - vyslané,
- `in_progress` - prebieha,
- `waiting_for_docs` - čaká sa na dokumenty alebo objednávku,
- `completed_assisted` - asistované a vybavené,
- `completed_no_assistance` - ukončené bez asistencie,
- `rejected` - odmietnuté,
- `cancelled` - zrušené,
- `futile_trip` - marný výjazd.

### Stav hovoru

- `incoming`,
- `in_ivr`,
- `in_queue`,
- `ringing_agent`,
- `answered`,
- `outbound`,
- `missed`,
- `abandoned_ivr`,
- `abandoned_queue`,
- `transferred`,
- `ended`,
- `recording_available`,
- `transcribed`.

### Stav operátora

- `available`,
- `ringing`,
- `on_call`,
- `after_call_work`,
- `working_case`,
- `paused`,
- `offline`.

Poznámka: Nepoužiť jednoduché tlačidlo "odísť" bez kontroly. Ak operátor nie je dostupný, musí existovať auditovateľný stav, dôvod a čas.

## 11. Telefónna ústredňa (integrácia)

Poznámka (september 2026): pôvodná verzia tejto sekcie opisovala REST, WebSocket a SMS API predchádzajúceho telefónneho providera. Projekt prešiel na Telnyx (Call Control, WebRTC, Messaging); dodávateľské detaily sú v `docs/telnyx-data-contract.md` a `docs/operations/telnyx-setup.md`. Tu ostávajú iba požiadavky nezávislé od providera.

### Čo potrebujeme od ústredne

- vytvorenie odchádzajúceho hovoru z aplikácie (click-to-call),
- prehľad aktívnych hovorov a história hovorov s trvaním a výsledkom,
- jednoznačný identifikátor hovoru naprieč všetkými udalosťami (začiatok, prijatie, prepojenie, koniec),
- smerovanie prichádzajúcich hovorov na skupiny operátorov s nastaviteľným poradím a časom zvonenia,
- podržanie, slepé aj asistované prepojenie, čakáreň s prevzatím,
- stav operátora (dostupný, pauza, hovor) riadený aplikáciou,
- podpísané udalosti (webhooky) namiesto trvalého WebSocket pripojenia,
- SMS odosielanie z aplikácie.

Praktický návrh:

- API ústredne nevolať priamo z klienta; príkazy posiela server, prehliadač telefonuje cez WebRTC s krátkodobým tokenom vydaným serverom,
- ku každému hovoru ukladať `provider_session_id` v Supabase a používať ho ako väzbu na udalosti, prípad a prípadný prepis,
- udalosti ústredne prijímať na serveri (webhook), deduplikovať ich a zapisovať do Supabase,
- frontend číta normalizované dáta zo Supabase (polling, neskôr Realtime), nie priamo z ústredne,
- pri prichádzajúcom hovore frontend otvorí call popover s históriou čísla,
- pri zvonení založiť alebo aktualizovať záznam v `calls`, pri ukončení vyhodnotiť, či ide o missed/abandoned/redirected.

### SMS

Pre tento projekt sú potrebné najmä:

- SMS s lokalizačným linkom pre klienta,
- SMS s potvrdením prijatia prípadu,
- SMS s ETA alebo informáciou, že vozidlo/odťah je na ceste,
- SMS šablóny s jasným textom "neodpovedajte", ak sa použije jednosmerný kanál,
- do budúcna 2-way SMS, ak bude potrebné prijímať odpovede (slovenské pevné linky príjem SMS nepodporujú).

Otvorené pre reálne testovanie: povolená odosielateľská identita, kredit/fakturačný režim, bezpečné testovacie číslo, limity a potvrdenie pravidiel textu pre diakritiku/interpunkciu/segmenty.

## 12. Webdispečink a Commander integrácia

### Webdispečink

Webdispečink je systém pre GPS sledovanie a riadenie vozového parku. Verejný web uvádza:

- sledovanie vozidiel v reálnom čase na mape,
- podrobné štatistiky o vozidlách a vodičoch,
- elektronickú knihu jázd,
- reporty,
- optimalizáciu trás,
- API rozhranie.

Stránka k API uvádza, že cez API je možné získať napríklad:

- aktuálnu pozíciu vozidiel,
- knihy jázd,
- stazky,
- stavy paliva,
- teploty,
- fotografie dokladov zhotovené vodičom,
- záznamy o tankovaní,
- synchronizáciu vozidiel, vodičov a používateľov.

Pre projekt je najdôležitejšia aktuálna poloha odťahoviek a ich stav.

### Commander

Commander je GPS monitoring vozidiel. Verejný web uvádza:

- dáta o vozidlách v reálnom čase,
- zobrazenie celého vozového parku na mape,
- filtrovanie,
- pohyb a históriu jázd,
- základné údaje o vozidle,
- integráciu dát do systémov.

Pre projekt je najdôležitejšia poloha a dostupnosť náhradných vozidiel alebo vozidiel používaných pri pristavení.

### Praktický integračný návrh

V MVP prototypovať s mock dátami:

- odťahovky ako živé body na mape,
- náhradné vozidlá ako dostupnosť podľa pobočky,
- pobočky ako statické body.

Produkčne:

- napojiť Webdispečink API pre odťahovky,
- napojiť Commander API alebo existujúci interný systém pre náhradné vozidlá,
- pravidelne synchronizovať stav do Supabase,
- neťahať mapové dáta priamo cez klienta, ak sú za API kľúčom,
- definovať normalizovaný model `fleet_assets`, aby frontend nemusel vedieť, či dáta prišli z Webdispečinku, Commandera alebo interného systému.

## 13. Mapy, routing a kalkulácie

Odporúčané mapové možnosti:

- Google Maps API pre geocoding, mapu, Directions API, Distance Matrix,
- alebo alternatívne Mapbox/Here podľa ceny a licencií.

Funkcie:

- textové hľadanie adresy,
- uloženie pickup a destination bodu,
- výpočet vzdialenosti,
- výpočet ETA,
- vizualizácia trasy,
- najbližšie pobočky,
- najbližšie aktívne odťahovky,
- predkalkulácia ceny.

Predkalkulácia:

- operátor vyberie cenníkový režim: samoplatca, AVP, Europe, iná asistenčka,
- systém vypočíta kilometre,
- aplikuje fix, sadzbu/km, minimálnu cenu, príplatky,
- zobrazí cenu bez DPH a s DPH,
- v MVP stačí ukázať demo logiku s falošnými cenníkmi.

## 14. AI vrstva

AI je veľká pridaná hodnota, ale nie blokér MVP.

### Transcript

Po ukončení hovoru:

- stiahnuť recording,
- prehnať cez speech-to-text,
- uložiť transcript ku hovoru,
- priradiť transcript ku prípadu,
- vygenerovať krátky summary.

### Extrakcia údajov

AI môže navrhnúť:

- meno,
- telefón,
- ŠPZ,
- miesto,
- cieľ,
- typ udalosti,
- či klient chcel náhradné auto,
- ďalší krok,
- deadline alebo čas spätného volania.

Operátor musí návrh potvrdiť, nie slepo uložiť.

### QA scoring operátorov

AI môže hodnotiť hovory podľa šablóny:

- pozdrav a identifikácia služby,
- zistenie bezpečnosti a urgentnosti,
- zistenie kontaktnej osoby,
- zistenie ŠPZ/vozidla,
- zistenie pickup miesta,
- zistenie cieľa,
- zistenie typu problému,
- ponuka náhradného vozidla, ak dáva zmysel,
- potvrdenie ďalšieho kroku,
- profesionálny tón.

Výsledok:

- skóre,
- chýbajúce body,
- odporúčania pre školenie,
- trend operátora v čase.

### Denné súhrny

Po polnoci generovať:

- počet hovorov,
- dovolateľnosť,
- zmeškané hovory,
- nové prípady,
- typy prípadov,
- úspešné/neúspešné ukončenia,
- marné výjazdy,
- dôvody odmietnutia,
- otvorené prípady,
- otvorené úlohy,
- výkon operátorov,
- AI komentár "čo si všimnúť".

## 15. Reporting

Real-time dashboard:

- čakajúce hovory,
- obsadení operátori,
- dostupní operátori,
- dnešné prípady,
- prípady po termíne,
- nepriradené hovory,
- zmeškané hovory bez callbacku,
- aktívne odťahy,
- dostupné náhradné vozidlá.

Denný report:

- odoslať emailom alebo zobraziť v aplikácii,
- export XLSX/CSV/PDF neskôr,
- automatické odoslanie po polnoci,
- možnosť filtrovať podľa linky, zdroja, operátora, typu prípadu.

Metriky:

- total calls,
- answered calls,
- missed calls,
- abandoned in IVR,
- abandoned in queue,
- outbound calls,
- average wait time,
- average call duration,
- answer rate,
- service level,
- new cases,
- cases by type,
- cases by source,
- completed cases,
- rejected cases,
- rejection reasons,
- futile trips,
- callback tasks completed/overdue,
- recordings/transcripts processed.

## 16. Supabase návrh dátového modelu

Toto nie je finálna SQL schéma, ale vývojový mentálny model.

### `profiles`

- `id`
- `user_id`
- `display_name`
- `role`
- `phone_extension`
- `active`

### `operator_statuses`

- `id`
- `operator_id`
- `status`
- `reason`
- `started_at`
- `ended_at`
- `source`

### `calls`

- `id`
- `provider_session_id`
- `direction`
- `status`
- `caller_number`
- `caller_name`
- `called_number`
- `queue_id`
- `extension`
- `operator_id`
- `case_id`
- `started_at`
- `answered_at`
- `ended_at`
- `wait_seconds`
- `duration_seconds`
- `recording_url`
- `transcript_status`
- `summary`
- `raw_payload`

### `call_events`

- `id`
- `call_id`
- `provider_session_id`
- `event_type`
- `payload`
- `created_at`

### `cases`

- `id`
- `case_number`
- `status`
- `priority`
- `source_type`
- `case_type`
- `partner_id`
- `owner_id`
- `contact_id`
- `vehicle_id`
- `pickup_location_id`
- `destination_location_id`
- `assistance_reference`
- `external_reference`
- `summary`
- `main_note`
- `created_at`
- `updated_at`
- `closed_at`
- `close_reason`

### `contacts`

- `id`
- `name`
- `phone`
- `email`
- `role`
- `notes`

### `vehicles`

- `id`
- `license_plate`
- `vin`
- `make`
- `model`
- `category`
- `transmission`
- `weight_kg`
- `is_driveable`
- `notes`

### `locations`

- `id`
- `label`
- `address`
- `lat`
- `lng`
- `place_id`
- `type`
- `notes`

### `case_tasks`

- `id`
- `case_id`
- `title`
- `description`
- `assigned_to`
- `status`
- `due_at`
- `completed_at`
- `created_by`

### `case_timeline`

- `id`
- `case_id`
- `event_type`
- `actor_id`
- `title`
- `body`
- `metadata`
- `created_at`

### `attachments`

- `id`
- `case_id`
- `uploaded_by`
- `storage_path`
- `file_name`
- `mime_type`
- `category`
- `created_at`

### `fleet_assets`

- `id`
- `source_system`
- `external_id`
- `asset_type`
- `label`
- `license_plate`
- `branch_id`
- `status`
- `lat`
- `lng`
- `heading`
- `last_seen_at`
- `metadata`

### `branches`

- `id`
- `name`
- `type`
- `address`
- `lat`
- `lng`
- `phone`
- `responsible_person`
- `active`

### `price_rules`

- `id`
- `name`
- `source_type`
- `base_fee`
- `price_per_km`
- `minimum_price`
- `vat_rate`
- `metadata`
- `active`

### `daily_reports`

- `id`
- `report_date`
- `metrics`
- `ai_summary`
- `created_at`
- `sent_at`

## 17. Architektúra

Odporúčaný stack:

- frontend: Next.js alebo React aplikácia na Vercel,
- backend/server routes: Vercel serverless alebo Supabase Edge Functions,
- databáza: Supabase Postgres,
- auth: Supabase Auth,
- storage: Supabase Storage,
- realtime: Supabase Realtime,
- scheduled jobs: Supabase cron/edge alebo externý scheduler,
- AI pipeline: server-side jobs po sprístupnení nahrávky.

Kľúčové pravidlá:

- všetky API kľúče držať server-side,
- udalosti telefónnej ústredne prijímať na serveri (webhook), nie v prehliadači,
- normalizovať externé eventy do vlastných tabuliek,
- frontend má byť odpojený od detailov dodávateľov,
- demo môže používať mocky, ale dátový model nech sedí na produkčný smer.

## 18. MVP prototyp pre klienta

MVP demo má ukázať reálny deň operátora. Nemusí byť napojené na živé API.

Scenár demo flow:

1. Prichádza hovor z čísla.
2. Call lišta ukáže číslo, volanú linku a históriu.
3. Operátor vidí, že číslo už volalo, alebo že je nové.
4. Operátor klikne `Nový prípad`.
5. Vyberie typ: odťah + náhradné vozidlo.
6. Zadá ŠPZ, kontakt, pickup a cieľ.
7. Mapa ukáže trasu, kilometre a ETA.
8. Systém navrhne najbližšiu pobočku/odťahovku.
9. Operátor vyberie cenníkový režim `Samoplatca` alebo `Europe`.
10. Systém ukáže predbežnú cenu.
11. Operátor odošle SMS s lokalizačným linkom.
12. Operátor vytvorí úlohu `Zavolať klientovi o 19:00`.
13. Priloží fotku alebo objednávku.
14. Prípad sa presunie do `assigned` alebo `scheduled`.
15. Denný reporting ukáže nové prípady, hovory, dovolateľnosť a otvorené úlohy.

MVP obrazovky:

- Dashboard / Dispečing,
- Karta prípadu,
- Hovory,
- Mapa,
- Reporty,
- Nastavenia / Integrácie ako statická obrazovka pre ukážku.

## 19. UI a dizajn princípy

Štýl:

- moderný svetlý dispečing,
- čistá biela a jemné sivé plochy,
- žltý akcent podľa PomocMotoristom `#FCD703`,
- čierna/antracit pre text,
- stavové farby: zelená úspech, oranžová čaká, červená horí, modrá info,
- Poppins alebo podobný moderný sans-serif,
- husté, ale vzdušné rozloženie.

Vyhnúť sa:

- marketingovému hero layoutu,
- dekoratívnym kartám bez funkcie,
- veľkým farebným gradientom,
- jednoliatej tmavej appke,
- prehnaným animáciám,
- vysvetľovacím textom v UI,
- zbytočným "AI" efektom.

Použiť:

- ikony v tlačidlách,
- tabuľky a zoznamy pre prípady,
- mapu ako primárny vizuál,
- chips pre statusy a cenníky,
- drawer/modal na rýchle založenie prípadu,
- timeline v karte prípadu,
- tooltips na ikony,
- stabilné rozmery prvkov, aby sa dashboard nehýbal.

## 20. Prompt pre vytvorenie klikateľného dashboard demo

Tento prompt môže byť použitý v ďalšom Codex/iConductor kroku:

```text
Vytvor modernú svetlú webovú aplikáciu ako klikateľný prototyp dispečerského CRM pre "Linku pomoci motoristom". Nejde o landing page. Prvá obrazovka je pracovný dispečing pre operátora call centra.

Doména:
Firma rieši pomoc motoristom: nehody, odťahy, náhradné vozidlá, poruchy, samoplatcov, asistenčné spoločnosti a partnerské dealerstvá. Operátor prijíma hovory cez telefónnu ústredňu, zakladá prípady, pracuje s mapou, posiela SMS, plánuje úlohy a sleduje dostupnosť odťahoviek a náhradných vozidiel.

Vizuál:
Svetlý, prehľadný, profesionálny dispečing. Použi bielu, jemnú sivú, čierny text a žltý akcent #FCD703 podľa PomocMotoristom.sk. Font Poppins alebo podobný sans-serif. Nepoužívaj marketingový hero, gradientové dekorácie ani zbytočné ilustrácie. Primárny vizuál je mapa a pracovné dáta.

Hlavná obrazovka:
- horná call lišta s aktívnym prichádzajúcim hovorom, číslom volajúceho, volanou linkou, stavom hovoru, históriou čísla, dial inputom a akciami Nový prípad / Priradiť ku prípadu / Informačný hovor,
- ľavý panel aktívnych prípadov s filtrom a zoznamom prípadov,
- pravý panel veľká mapa s pickup/destination pinmi, pobočkami, odťahovkami a náhradnými vozidlami,
- spodný alebo bočný panel úloh a alertov.

Interakcie pre demo:
1. Prichádzajúci hovor zobraz call popover.
2. Klik na "Nový prípad" otvorí drawer/formulár.
3. Formulár obsahuje typ prípadu, zdroj, kontakt, telefón, ŠPZ, vozidlo, pickup, cieľ, poznámku.
4. Po vyplnení sa prípad pridá do zoznamu a na mapu.
5. Klik na prípad otvorí detail karty prípadu.
6. V detaile ukáž timeline, hovory, úlohy, prílohy, mapu, SMS akcie a stav.
7. Ukáž tlačidlo "Odoslať lokalizačnú SMS".
8. Ukáž úlohu "Zavolať klientovi o 19:00" a možnosť označiť ju ako vybavenú.
9. Ukáž reportovú obrazovku s dennými metrikami: hovory, prijaté, zmeškané, nové prípady, marné výjazdy, dovolateľnosť, výkon operátorov.

Mock dáta:
Použi reálne pôsobiace slovenské dáta:
- linka 0850 005 006,
- mestá Žilina, Bratislava, Prešov, Bardejov, Nitra,
- typy: odťah, náhradné vozidlo, nehoda, porucha, samoplatca, Europe Assistance, AVP,
- vozidlá: Škoda Fabia, Opel Zafira, BMW X3, Porsche Cayenne,
- operátori: Natália, Mango, Mišo.

Stavy:
Prípady majú statusy new, triage, assigned, dispatched, scheduled, in_progress, completed, rejected, futile_trip. Hovory majú statusy incoming, answered, missed, abandoned_queue, outbound, ended. Operátori majú statusy available, on_call, after_call_work, paused, offline.

Technické poznámky:
Ak tvoríš frontend, priprav štruktúru tak, aby neskôr šla napojiť na Supabase. API dáta zatiaľ mockuj v lokálnych objektoch. Komponenty navrhni doménovo: CallBar, CaseList, CaseDetail, DispatchMap, TaskPanel, ReportDashboard.

Cieľ:
Klient má po otvorení aplikácie okamžite pochopiť, že toto je ich budúce dispečerské pracovisko: prichádzajú hovory, vznikajú prípady, operátor pracuje s mapou, všetko sa zapisuje a nič sa nestratí.
```

## 21. Produkčný roadmap návrh

### Fáza 0 - Klikateľný demo prototyp

- mock dáta,
- hlavná obrazovka,
- karta prípadu,
- mapa,
- reporty,
- žiadne živé API.

### Fáza 1 - Interné MVP

- Supabase auth,
- prípady,
- kontakty,
- vozidlá,
- lokality,
- úlohy,
- prílohy,
- základné reporty,
- manuálne založenie prípadu,
- call log import alebo mock eventy ústredne.

### Fáza 2 - integrácia telefónnej ústredne

- webhook pipeline,
- REST import histórie hovorov,
- prichádzajúce hovory v UI,
- click-to-call,
- queue/agent status,
- nahrávky,
- základný transcript.

### Fáza 3 - Mapy a flotila

- Google Maps routing,
- Webdispečink odťahovky,
- Commander/náhradné vozidlá,
- pobočky,
- dostupnosť,
- predkalkulácie.

### Fáza 4 - AI a kvalita

- transcript pipeline,
- sumarizácie,
- návrh údajov do prípadu,
- QA scoring,
- denné AI reporty.

### Fáza 5 - Partneri a mobilné workflow

- partner/dealer vstup,
- mobilné potvrdenie polohy,
- vodičské fotky,
- klient tracking link,
- interné API pre existujúci systém.

## 22. Otvorené otázky

Tieto otázky sú potrebné, nie kozmetické:

1. Doplniť presné PDF `SMS_API_dokumentacia_v1.8.pdf` a `CRM_PBX_navrh_2025-2.pdf` do repozitára alebo ich poslať znovu. Lokálne pasteboard cesty v tomto prostredí neexistovali.
2. Ktoré telefónne čísla/linky budú v pilote aktívne: iba `0850 005 006`, alebo aj samostatné linky pre asistenčky, samoplatcov a partnerov?
3. Má mať každý hovor samostatný záznam aj keď je "zbytočný", alebo sa z každého hovoru ukladá call log automaticky a iba niektoré hovory sa menia na prípad? Odporúčanie: ukladať každý hovor ako call log, nie každý hovor ako case.
4. Aké existujúce interné systémy má Braňo sprístupniť: databáza náhradných vozidiel, nájmy, fotky, fakturácia, dostupnosť, pobočky?
5. Má existujúci systém API, prístup do databázy alebo iba export/import?
6. Ktorý systém bude zdroj pravdy pre dostupnosť náhradných vozidiel: interná databáza, Commander, alebo kombinácia?
7. Ktorý systém bude zdroj pravdy pre odťahovky: Webdispečink alebo interný dispečing?
8. Aké presné cenníky treba použiť pre samoplatcov a asistenčky?
9. Aké sú povinné údaje pri odťahu, náhradnom vozidle a nehode?
10. Ako dlho sa majú držať nahrávky a transcript hovoru? Treba právne overiť GDPR, informačnú hlášku a retenčné pravidlá.
11. Môže systém ukladať fotku vodičského preukazu? Ak áno, za akých právnych podmienok a s akou retenciou?
12. Kto bude mať prístup k nahrávkam, transcriptom, QA scoringu a reportom?
13. Aké sú pracovné hodiny pilotu a aký je nočný/víkendový režim?
14. Aká má byť definícia "dovolateľnosti" a cieľový service level?
15. Má sa do MVP riešiť dochádzka/služby operátorov, alebo len dostupnosť v call centre?

## 23. Riziká a odporúčania

### Príliš široký záber

Projekt môže rýchlo narásť na CRM, call centrum, fleet tracking, booking, AI, reporting a partner portal. Preto treba MVP držať na operátorskom workflow.

### Integrácie ako blokér

Telefónna ústredňa, Webdispečink, Commander a interné systémy nemusia mať rovnakú kvalitu API alebo dostupnosť. Demo musí fungovať s mockmi a architektúra musí mať integračné adaptéry.

### Právne veci

Nahrávky, transcript, AI scoring, doklady a lokalizačné linky sú citlivé. Produkcia potrebuje právnu kontrolu GDPR, retencie a oprávnení.

### Operátorská zneužiteľnosť stavov

Stavy typu pauza/working case musia byť auditované. Inak sa nedá rozumne merať dostupnosť.

### Kvalita dát

Ak operátor nezadá ŠPZ alebo číslo prípadu, neskôr sa veci zle hľadajú. UI musí tlačiť na minimum povinných údajov, ale nebrzdiť urgentné riešenie.

## 24. Zdroje

- PomocMotoristom.sk: https://www.pomocmotoristom.sk/
- Telnyx Call Control: https://developers.telnyx.com/docs/voice/programmable-voice
- Telnyx Messaging: https://developers.telnyx.com/docs/messaging
- Webdispečink: https://www.webdispecink.sk/sk/
- Webdispečink API info: https://www.webdispecink.sk/sk/webdispecing-krok-za-krokom/prenos-udajov-z-webdispecingu/
- Webdispečink developers: https://developers.webdispecink.cz/
- Commander monitoring vozidiel: https://commander.sk/monitoring-vozidiel/

## 25. Poznámka o lokálnych prílohách

Pôvodné lokálne prílohy (SMS API, PBX REST API a PBX WebSocket API predchádzajúceho telefónneho providera) už nie sú pre projekt relevantné. Aktuálny provider je Telnyx; dátový kontrakt a identifikátory zdrojov sú v `docs/telnyx-data-contract.md` a `docs/operations/telnyx-setup.md`.

Reálne SMS testovanie stále čaká na potvrdenú odosielateľskú identitu, kredit/fakturačný režim a bezpečné testovacie číslo.
