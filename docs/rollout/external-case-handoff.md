# Odovzdanie prípadu externému stredisku alebo pristavovačovi

Stav k 12. 9. 2026: **návrh nasledujúcej serverovej funkcionality, nie hotová súčasť živého vizuálneho náhľadu**. Tento dokument nemení backend, schému, oprávnenia, konfiguráciu SMS ani dáta. Pred implementáciou treba návrh previesť na samostatný plán, testy a výslovne objednané migrácie výhradne v Supabase projekte tejto kópie.

## Výsledok pre používateľa

Dispečer pri konkrétnom prípade vyberie stredisko alebo kolegu, skontroluje zdieľané informácie a vytvorí obmedzený odkaz. Môže ho skopírovať alebo vložiť do existujúceho SMS editora s výslovne vybraným telefónom kolegu. Kolega otvorí jednoduchú mobilnú kartu, prípad prijme alebo odmietne s dôvodom a po prijatí dopĺňa dovolené prevádzkové informácie. Nepotrebuje plný účet dispečingu a nevidí ostatné prípady.

Dispečer vidí oddelene: odkaz vytvorený, karta otvorená, prijaté/odmietnuté, posledný postup a zrušené/vypršané oprávnenie. Otvorenie ani SMS doručenie nemení rozhodnutie. Odovzdanie nezmaže prípad, interné poznámky ani históriu a samo nemení jeho interný stav na vybavený.

## Čo dnes existuje a čo chýba

V repozitári je verejný tok na získanie GPS: `src/app/l/[token]/page.tsx`, `src/app/api/public/location-links/[token]/route.ts`, `src/server/location-share-links.ts` a `src/lib/sms/location-share.ts`. Ukladá hash náhodného tokenu v `motorist_location_share_links`, má scope `pickup_location`, expiráciu a spracovanie odoslaných súradníc. Jeho verejná odpoveď na čítanie poskytuje iba stav a expiráciu. Existujúci GPS GET môže pri zistení vypršania aktualizovať stav odkazu; nemožno ho považovať za čisto nemenný endpoint pri živých testoch.

Tento GPS tok neposkytuje externú session na čítanie kontaktu/vozidla, prijatie alebo odmietnutie prípadu ani riadenie postupu. Demo `?handoff=demo-001` používalo vymyslené dáta a localStorage. Ani jedno nie je oprávnením na odovzdanie reálneho prípadu. Nový grant, session, minimálny DTO a rozhodovací tok sa musia implementovať oddelene; existujúcim GPS tokenom sa nesmú dodatočne rozšíriť práva.

## Rozsah a identita

Jedno oprávnenie patrí presne jednej vydávajúcej organizácii, jednému prípadu, jednému vybranému externému príjemcovi a jednému vydaniu ponuky. V prvej verzii môže mať prípad iba jedno aktívne externé odovzdanie. Zmena príjemcu vydá novú generáciu a zruší predchádzajúci grant. Prijaté odovzdanie sa pred zmenou príjemcu musí výslovne zrušiť s dôvodom.

Odkaz je bearer oprávnenie: osoba, ktorej sa celý odkaz prepošle, môže v jeho rozsahu konať. Názov strediska na grante nie je dôkaz identity konkrétneho zamestnanca. Audit preto uvádza „držiteľ odkazu pre stredisko X“, nie overenú osobu. Ak bude potrebný dôkaz identity, treba doplniť samostatne navrhnuté overenie prideleného kontaktu alebo obmedzený partnerský účet. Prvá verzia nesmie túto vlastnosť skryť pod označenie „overený kolega“.

Oprávnenia sa kontrolujú na serveri pri každom čítaní aj zmene, vrátane aktuálnej generácie a platnosti; klientské skrytie tlačidla nestačí. Východiskom je zamietnutie všetkých akcií mimo výslovného zoznamu. Ide o použitie zásad [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## Údaje, ktoré sa môžu zdieľať

Dispečer pred vydaním vidí presný náhľad. Server zostaví DTO z pevného zoznamu polí, nikdy zo serializovaného `DispatchData`, plného prípadu alebo klientom dodaného ľubovoľného JSON:

| Pole | Pravidlo |
| --- | --- |
| Referencia prípadu a druh úkonu | Čitateľné číslo prípadu, napr. pristavenie náhradného vozidla; bez interných identifikátorov organizácie. |
| Kontakt | Jeden vybraný pracovný kontakt klienta: meno a telefón potrebný na úkon. Ostatní volajúci/kontakty zostanú interní. |
| Vozidlo | Značka, model, EČV a prípadne samostatne vybrané pristavované vozidlo; VIN iba pri výslovnej potrebe úkonu a samostatnom poli náhľadu. |
| Miesto, cieľ a čas | Zvolená adresa/súradnice, cieľ, objednaný čas, prípadne orientačný bod. Označiť neoverenú polohu. |
| Pokyny | Osobitné pole „Pokyny pre kolegu“ s limitom dĺžky; nepreberať automaticky voľný text interných poznámok. |
| Vlastný postup príjemcu | Rozhodnutie, jeho dôvod, ETA a udalosti tohto odovzdania. |

Interné ceny, poisťovacie/politikové identifikátory, záznamy hovorov, nahrávky/prepisy, súkromné a zdieľané poznámky, interné úlohy, adresár, prílohy, ďalšie prípady a plná časová os sa neposielajú. Prílohy nie sú vo verzii 1. Neskoršie prílohy potrebujú vlastný zoznam povolených položiek a krátku kontrolovanú autorizáciu sťahovania.

Zdieľané údaje tvoria verziovaný výber potvrdený dispečerom. Zmena interného prípadu sama nezverejní ďalšie polia. Ak dispečer zmení zdieľané miesto/kontakt/pokyny, musí publikovať novú verziu tohto výberu; príjemca uvidí oznámenie o zmene. Prijatie obsahuje číslo zobrazenej verzie. Pri súbežnej zmene server vráti konflikt a vyžiada opätovné prečítanie, aby kolega nepotvrdil inú adresu, než videl.

## Token a obmedzená session

Navrhnuté hodnoty pre prvú implementáciu sú 32 kryptograficky náhodných bajtov, hash tokenu na serveri a platnosť 24 hodín, nastaviteľná oprávneným dispečerom najviac na 72 hodín. Ide o návrhové hodnoty; zvolené operačné limity sa musia potvrdiť pred implementáciou. Prijatie automaticky nepredlžuje platnosť. Zrušenie oprávnenia účinkuje pri najbližšom requeste; nevyžaduje cron. Pri vypršaní uprostred práce stredisko telefonicky kontaktuje dispečera, ktorý môže výslovne vydať nové oprávnenie bez vymazania histórie.

Odporúčaný odkaz je `/handoff#token=...`: fragment sa neposiela v HTTP requeste stránky. Po otvorení sa token cez HTTPS a JSON telo vymení na osobitnom endpoint-e za krátku `HttpOnly`, `Secure`, `SameSite=Strict` session obmedzenú na tento grant. Klient potom odstráni fragment cez `history.replaceState`. Token ani session sa neukladajú do localStorage, analytiky, error reportov či aplikačných logov. Zneužiteľné tajomstvo sa neposiela v URL API. Nepridávať tretie analytické skripty; stránka a odpovede majú `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, zamedzenie vloženiu do cudzieho rámca a zákaz indexovania. Existujúci service worker nesmie kartu ani jej API cachovať. Zásady pre náhodnosť, bezpečné uloženie a expiráciu odkazových tokenov opisuje [OWASP token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html); HTTP hranice dopĺňa [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

Samotný GET verejnej stránky neprijíma prípad ani nespotrebuje token. Link-scanner v SMS nesmie rozhodnúť za človeka. Session je nástroj prístupu ku grantu, nie plná Supabase používateľská session. Každý request znovu overí grant/expiráciu/generáciu; dlhšia cookie nemôže predĺžiť platnosť. Chrániť mutácie proti CSRF, obmedziť frekvenciu pokusov a maximálnu dĺžku tela. Neplatný, vypršaný a odvolaný prístup vracia všeobecnú stránku bez údajov prípadu.

Token sa poskytne vydávajúcemu klientovi iba pri vzniku/obnove odkazu; v tabuľke grantov je iba hash. Znovunačítanie zoznamu grantov nesmie odhaliť raw token. Pri strate prvej odpovede idempotentné opakovanie vydania vráti existujúce metadáta s informáciou, že URL treba obnoviť; nesmie potichu vytvoriť druhé aktívne oprávnenie. Obnova tokenu je výslovná atomická operácia a zruší starý token aj jeho sessions. Uloženie do existujúcej SMS histórie je samostatná kópia tajomstva v tele správy: nezobrazovať ho neoprávneným rolám, neredistribuovať ho cez logy/exporty a nesľubovať, že sa nevyskytuje mimo tabuľky grantov.

## Práva a stavové prechody

Vydanie, zmena publikovaných údajov, predĺženie/obnova a zrušenie vyžadujú prihláseného dispečera s oprávnením pracovať s konkrétnym prípadom. Server odvodí organizáciu z overeného aktéra; neprijíma ju ako dôveryhodné pole klienta. Samotná rola bez prístupu k prípadu nestačí. Oprávnenie na tvorbu odkazu a na odoslanie SMS sú oddelené.

| Aktér / akcia | Povolený prechod a výsledok |
| --- | --- |
| Dispečer: vydať | Nové `offered`, pridelí príjemcu, publikovanú verziu, generáciu a expiráciu. |
| Príjemca: prijať | `offered -> accepted`, iba pre aktuálnu publikovanú verziu. Meno vykonávajúcej osoby môže byť samodeklarované; nepredstiera overenú identitu. |
| Príjemca: odmietnuť | `offered -> rejected`, vyžaduje kategóriu a neprázdny dôvod, najviac 1 000 znakov. |
| Príjemca: ETA/pokyn | Po `accepted`, iba ETA alebo vlastná poznámka k realizácii; nikdy ľubovoľný PATCH prípadu. |
| Príjemca: postup | `accepted -> en_route -> arrived -> completed`; pre úkon bez jazdy môže vynechanie kroku povoliť konkrétny serverový typ úkonu, nie klient. |
| Príjemca: problém po prijatí | Samostatná udalosť `blocked` s dôvodom pri zachovaní posledného postupu; nejde o spätné odmietnutie ponuky. Dispečer musí rozhodnúť o zmene príjemcu/zrušení. |
| Dispečer: zrušiť | `offered/accepted/en_route/arrived -> cancelled`, vyžaduje dôvod; zruší sessions, história zostane. |

Príjemca nemôže meniť klienta, vozidlo, publikované miesto, ceny, priradenie interného operátora, úlohy alebo oprávnenia. `completed` znamená vykonanie externého úkonu; interné uzavretie prípadu zostáva explicitnou akciou dispečera. Po dokončení sa grant zavrie pre zápisy; krátka potvrdzovacia odpoveď môže zostať dostupná bez opätovného vydania osobných údajov. Neobnovovať terminálne stavy obyčajným opakovaním starého requestu.

## Navrhovaný serverový kontrakt

Mená nižšie sú návrhom novej implementácie, nie existujúcimi endpointmi:

- Interné `POST /api/cases/:id/handoffs` vydá ponuku; `GET` zobrazí iba oprávnenému dispečerovi metadáta/históriu. Samostatné command endpointy publikujú aktualizáciu, obnovia token alebo odovzdanie zrušia.
- Verejný `POST /api/public/handoffs/session` overí token a vytvorí iba obmedzenú session. `GET /api/public/handoffs/current` vráti aktuálny minimálny DTO. `POST /api/public/handoffs/commands` prijíma iba jeden zo schválených príkazov, idempotency key, očakávanú revíziu a platný payload.
- Perzistencia: grant a publikované polia; hashované session tokeny; append-only udalosti; command receipts; unikátny aktívny slot `(organization_id, case_id)` s generáciou. Server používa jeden transakčný command kontrakt, nie reťaz nezávislých update/insert volaní.

Každý príkaz má stabilné UUID a otlačok normalizovaného payloadu. Unikátnosť `(grant_id, command_id)` zaistí opakovanie toho istého výsledku pri strate odpovede. Rovnaké UUID s iným obsahom vráti konflikt. Server kontroluje oprávnenie, aktuálnu generáciu, očakávanú revíziu, stav a zdieľanú verziu v tej istej transakcii, ktorá uloží rozhodnutie, audit a záväzok vytvoriť upozornenie. Súbežné prijať/odmietnuť alebo prijať/zrušiť má presne jedného víťaza. Nepoužívať SQLSTATE pre automatický serializačný retry na očakávaný doménový konflikt; riadiť sa existujúcim kontraktom `PT409` tejto aplikácie.

Audit zahŕňa grant/generáciu, pôvodného vydavateľa, zvoleného príjemcu, typ a čas operácie, pred/po revíziu, publikovanú verziu, command ID a rozhodovací dôvod. Rozlišuje interného autentifikovaného aktéra a externého držiteľa obmedzenej session. Raw token, celé telefónne číslo a celý text klienta sa do technických logov nepridávajú. Upozornenia majú jednoznačný dedupe kľúč udalosti; výpadok upozornenia nesmie vrátiť prijatie do `offered` ani vytvoriť druhú akceptáciu. Využiť existujúci mechanizmus obnovy, nepridávať samostatný worker alebo cron bez samostatného zadania.

## SMS, dispečerská karta a mobil

Tlačidlo „Poslať odkaz SMS“ otvorí existujúci composer. Ukáže prípad, meno/telefón externého príjemcu, text a expiráciu. Existujúci koncept sa nesmie prepísať bez potvrdenia; odkaz možno pripojiť. Nezdediť automaticky telefón klienta z bežnej SMS prípadu. Odoslanie je explicitné a rešpektuje existujúce kill switche, oprávnenia a neistý výsledok odoslania. Znova otvorený composer nesmie vytvoriť ďalší grant ani druhú SMS.

Mobilná karta má čitateľný kontakt, vozidlo, miesto/cieľ, pokyny a zreteľné prijatie/odmietnutie. Dôvod odmietnutia sa vypĺňa až po výbere tejto akcie. Pred potvrdením je viditeľné, pre koho a ktorý úkon sa rozhoduje. Pri strate siete zostane rozpracovaný dôvod v pamäti stránky; výsledok sa označí ako neoverený a zopakuje sa ten istý command ID. Bezpečný offline cache osobných údajov ani všeobecnú partnerskú aplikáciu táto verzia nezavádza.

## Akceptácia pred sprístupnením

1. Anonymný alebo cudzí interný používateľ nevydá grant; organizácia/prípad sa nedajú podvrhnúť. Externý token/session nečíta iný grant, case ID, prílohu ani bežné API.
2. DTO má presne povolené polia a žiadne rozšírenie cez vnorený objekt, chybu, serverové HTML, Next payload, mapový request, cache alebo log.
3. Vypršaný/zrušený/obnovený token a jeho staré sessions okamžite stratia prístup. Otvorenie/scanner nič neprijme. GPS token nikdy nezíska nové právo.
4. Reálne izolované transakčné testy pokrývajú dvojklik, prijať proti odmietnuť, zrušenie proti prijať, starú revíziu, zmenu publikovanej adresy, timeout po commite a rovnaké UUID s iným payloadom.
5. Stav, audit a záväzok upozornenia sa uložia spolu. Opakovanie nezduplikuje rozhodnutie ani upozornenie. Zmena príjemcu nezachová aktívny starý grant.
6. SMS test potvrdí adresáta kolegu, zachovanie konceptu, náhľad, jediný send a žiadne odoslanie pri vypnutom switche. Používať izolované mocky, nie živé čísla.
7. Chrome/mobile viewporty 360–1440 px, klávesnica, dlhý dôvod, chybný/expirujúci link, zmena údajov počas potvrdenia a sieťový výpadok. Názvy stavov v UI zodpovedajú uloženému serverovému stavu.
8. Až po samostatnom schválení implementácie a migrácií: work branch z `dev`, plná gate, Preview s cieleným testovacím grantom a konkrétnymi autorizovanými príjemcami, PR do `dev`. Produkcia je osobitný PR `dev -> main`.

Aktuálny živý náhľad preto zachováva dnešné úplné funkcie a aktualizovaný vzhľad, ale nevytvára nezabezpečený zdieľací odkaz ani nepripisuje demo potvrdenia reálnym prípadom.
