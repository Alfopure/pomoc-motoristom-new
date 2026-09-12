# Dispečing V2 — funkčný pracovný návrh

Dátum: 12. 9. 2026. Tento plán nahrádza vecné obmedzenia dokumentu live-layout-preview.md. Predchádzajúci plán a nasadenie zostávajú dostupné na porovnanie.

## Oprava očakávania

Používateľ schválil výtvarný smer pôvodného prototypu, nie obmedzenie na kozmetický obal starej aplikácie. Zachovať funkcie znamená zachovať údaje, vyhľadávanie, filtrovanie, triedenie, formuláre, oprávnenia, rozpracovanú prácu, meniteľné panely a všetky pracovné akcie. Rozloženie, hierarchia, podoba ovládania a widgetov sa môžu zmeniť podstatne. Úlohy so stavmi a kontrolórom boli dohodnutá funkcia; odloženie v poslednom parity pláne bolo nesprávne.

Východiská: pôvodný prepis 10. 9., prepis stretnutia 11. 9., všetky následné používateľské spresnenia, .context/design-preview-2026-09-12/plan-final.md a jeho klikateľný prototyp; terajší live Preview commit3c47c6e. Aktuálny origin/dev je stále6cbd23e. Pokračujeme na samostatnej vetve feat/live-layout-preview založenej na tomto dev, v PR167 do dev. Pôvodný commit a jeho immutable Preview slúžia na návrat/porovnanie. Žiadne vydanie do produkcie.

## Rozhodnutie a postup Ralplan

Používame plánovací a sekvenčný nezávislý recenzný postup podľa upstream [Ralplan](https://github.com/Yeachan-Heo/oh-my-codex/blob/main/skills/ralplan/SKILL.md). V tomto prostredí nejde o natívny OMX consensus runtime ani jeho host authority. Lokálne recenzie sú podklad kvality, oprávnenie vykonať prácu vyplýva zo zadania používateľa. Po dokončení plánovania sa uloží digest a recenzie; potom sa samostatne pokračuje implementáciou.

Zásady: (1) reálny pracovný výsledok pred počtom vizuálnych úprav; (2) jedna evidencia, existujúce providery a autorizácia; (3) kompaktný a zreteľne nový dizajn prispôsobiteľný človeku; (4) pravdivé uložené stavy a súbežná práca; (5) vratný samostatný náhľad.

Rozhodujúce kritériá: splniť pôvodné nové pracovné toky; zachovať úplnosť starej aplikácie; výraznejšia vizuálna hierarchia na notebooku a mobile.

Možnosť A: ďalšie scoped CSS nad tým istým UI. Malé riziko, ale zopakuje práve odmietnutý výsledok a nevyrieši tok úloh. Zamietnuté.
Možnosť B: prestavať pracovnú kompozíciu a widgety nad existujúcimi providermi, doplniť chýbajúce serverové príkazy aditívne. Vybrané. Vyžaduje migrácie a integračné testy, ale výsledok bude skutočne funkčný.
Možnosť C: nový nezávislý frontend/stores alebo ďalší iba statický prototyp. Najväčšia voľnosť, ale znovu by stratila funkcie a pravdivú synchronizáciu. Zamietnuté.

## Vizuálne a navigačné zmeny

- Hlavná hlavička dostane jasný identifikačný bod aplikácie, usporiadanú hlavnu navigáciu a oddelené obslužné akcie. Osobné pripnuté obrazovky, účet, notifikácie a telefonické stavy ostanú dostupné.
- Ľavý zoznam bude skutočne navrhnutý ako čitateľné karty s výraznou vybranou položkou, prioritou a jasnou hierarchiou čísla, klienta/vozidla, miesta, asistenčky, času a operátora. Zachovať všetky už zobrazované údaje, päť filtrov a tri radenia; dlhé hodnoty zostávajú dostupné.
- Stred ostáva flexibilná plocha Mapa/Úlohy/Poznámky/Tabuľka s kartou prípadu pod ňou. Lokálna voľba nemení hlavnú obrazovku, hlavné Úlohy otvoria celú tabuľu. Nové členenie prehľadu prípadu vyzdvihne kontakt, vozidlo, miesto/cieľ a jasné akcie; úplný editor, prílohy, ceny, história a ostatné polia zostanú dosiahnuteľné bez straty draftov.
- Zachovať resize/kolaps bočných panelov, vertikálne delenie a maximalizáciu spodnej karty. Nie je nutný identický DOM každej prezentácie; stabilné providery a formuláre musia udržať stav. Moderný/pôvodný vzhľad nesmie zrušiť hovor ani automaticky ukladať koncept.
- Poznámky ako pastelové papiere s obsahom, stavom zdieľania a editáciou. Kalkulačka s integrovaným displejom nad klávesnicou, použiteľným mazaním/výberom/kopírovaním. Kalendár s dátumom a agendou oprávnených úloh. Nástroje dostanú galériu s ikonami, viditeľnosťou, poradím a zbalením. Reset widgetov nepresúva mapu ani bočné panely.
- Vizuálny jazyk: neutrálne sivé pracovné pozadie, biele obsahové plochy, jemné hrany/tiene, pastelové nástroje, žltý akcent značky, stavová modrá/fialová/zelená. Kompaktné medzery; žiadne dekoratívne plochy, ktoré uberajú priestor údajom.

## Skutočný workflow úloh — povinný výsledok tejto iterácie

Jedna spoločná tabuľa v hlavnom aj lokálnom pohľade: Na vybavenie → Rozpracované → Na kontrolu → Vybavené. Presun zmení workflow, nikdy termín alebo pripomienku. Dnes/Po termíne zostávajú filtre, stav termínu sa zobrazuje na karte. Zachovať vyhľadávanie, operátora, priority, chat a nula/jeden/viac pripojených prípadov.

Pri odovzdaní na kontrolu používateľ vyberie aktívneho oprávneného kolegu odlišného od zodpovednej osoby, doplní stručný výsledok/pokyn a potvrdí akciu. Kontrolór dostane súkromnú notifikáciu s otvorením úlohy, vidí filter Na moju kontrolu a jasné akcie Schváliť / Vrátiť na dopracovanie. Vrátenie vyžaduje dôvod a vráti stav Rozpracované. Schválenie úlohu vybaví. Jednoduchú úlohu bez odovzdania môže oprávnený operátor vybaviť priamo. Odovzdanie sa nedá obísť obyčajným klikom na Vybavené.

Persistence: aditívny nullable workflow_state a údaje kontrolóra/cyklu nad existujúcimi úlohami; pôvodné status open/done/overdue zostávajú kompatibilné. Staré riadky sa neprepisujú bulk update; DTO odvádza východiskový stav. Nové autentifikované command RPC uplatní oprávnenie, aktuálny revision, konkrétny prechod, idempotency a zápis auditu/notifikácie v jednej transakcii. Existujúci update/source-completion tok nesmie obísť čakajúcu kontrolu ani zlyhať pri obvyklej zdrojovej udalosti. Treba otestovať oba staré aj nové vstupy, nie iba nový endpoint.

Kontrakt, UI a migrácia sa implementujú v tejto etape, neostanú iba v dokumente. Lokálne SQL testy prebehnú pred aplikáciou na povolenú testovaciu kópiu. Nesiahnuť na telephony migrácie, iné projekty alebo seed. Pred sprístupnením UI overiť schopnosť backendu; pri nedostupnej migrácii vypísať konkrétny stav, nie predstierať uloženie.

## Ďalšie pôvodne dohodnuté pracovné prvky

- SMS: hlavne napísať správu v prípade alebo samostatne, šablóny a odoslaná história. Neinvestovať do novej schránky prijatých správ. Existujúci editor, náhľad, oprávnenia a vypínače odoslania zachovať.
- Textové podklady: zviditeľniť dostupné spracovanie textu; pri novej pomôcke vždy ponechať originál a ponúknuť potvrdenie vybraných navrhnutých polí do rozpracovaného prípadu. Žiadne automatické prepísanie alebo predstieraná AI. Otestovať konflikt a neznámy text.
- Plánovanie trasy: zachovať aktuálne routovanie/bodové údaje, doplniť poradie potiahnutím aj ovládanie bez myši. Presun upravuje poradie, nie text či uložené miesta.
- Externé odovzdanie: samostatný implementačný celok podľa docs/rollout/external-case-handoff.md. Cieľom je reálny obmedzený odkaz na jeden prípad s vybranými údajmi, prijatím/odmietnutím s dôvodom a priebehom bez plného účtu. Nezamieňať ho za GPS odkaz ani obyčajný odkaz do interného detailu. Zachovať serverovú autorizáciu, expiráciu/revokáciu, token hash, minimálny DTO, no-store a atomické rozhodnutie. Existujúci SMS composer otvorí adresáta kolegu explicitne, bez automatického odoslania. Nie je to telephony zmena.

Tieto položky sa neoznačia hotové iba preto, že existujú v statickom prototype. Overenie musí oddeliť implementované funkcie, dostupné serverové schopnosti a prípadné skutočné prekážky.

## Riziká a overenie

1. Starý klient alebo automatický zdroj preskočí kontrolu alebo rozhádže revision. Prevencia: samostatný serverový prechod a ochrana existujúcich writerov, izolované PostgreSQL integračné testy pre starý/new zápis, konflikt, opakovaný command, zmenu reviewer/source completion. Notifikácia presne raz a iba konkrétnemu adresátovi.
2. Nové rozloženie skryje údaje alebo zničí draft pri prepnutí. Prevencia: porovnanie s paritnou maticou a skutočné browser scenáre filtrov, editorov, kolapsu/resize, dlhých textov a prepnutia; ručne prezrieť snímky 1280×720,1366×768 a390×844. Zachovať providery, obmedziť presuny živého editora.
3. Náhľad alebo test sprístupní citlivé údaje externému držiteľovi alebo spraví neúmyselný reálny zápis. Prevencia: presné DTO/ACL testy, odvolanie a expirácia, izolované fixture/SQL dáta. Žiadne testovacie živé SMS/hovory, žiadna nová databáza, žiadne seed. Preview naďalej jasne označí skutočné spoločné dáta.

Akceptačné kontroly:

- Vizuálne rozpoznateľná nová kompozícia prípadov, prehľadu a nástrojov oproti3c47c6e; nepostačuje zmena farieb/hrán. Schválený prototyp je referenciou, úplná aplikácia určuje funkčný rozsah.
- Všetky štyri workflow stĺpce, funkčný drag aj explicitné akcie; termín a reminder sa nemenia. Reviewer výber, jedno upozornenie, vlastný zoznam kontrol, schválenie/vrátenie a dôvod viditeľný aj po reload.
- Neoprávnený/nesprávny reviewer, cudzie org/úlohy, staré revision, dvojklik a stratená odpoveď nemenia stav nesprávne. Staré dátumové filtre a chat/väzby fungujú.
- Pôvodné filtre/údaje/formuláre zostávajú; osobné widgety a ich skrytie nezmažú obsah. Mobil bez horizontálneho pretekania celej stránky, tabuľa smie mať vlastný horizontálny posun.
- Externý prístup prejde iba zverejnené polia vlastného prípadu a povolené príkazy. Otvorenie odkazu nie je prijatie. Token/session sa nedajú použiť na bežné case API.
- Unit a SQL integračné testy, typecheck, lint zmenených súborov, Next build, relevantné pôvodné regresie a nové browser scenáre. Presne uviesť hranice testov a súčasť reálne nasadenú v Preview.
- Nová Vercel verzia pre presný commit, obmedzené povolenie iba jej hostov/pinu ak potrebné, login/health/401 kontrola, PR167 aktualizovaný podľa výsledného rozsahu. Žiadny merge/main release.

## Rozdelenie práce

Root: plán, hlavné rozhranie/karta, integrácia, migračné a release overenie. Task backend agent: doména/API/RPC, kompatibilita, SQL testy. Task UI agent: tabuľa, editor, reviewer akcie, store command a browser kontroly. Widget agent: osobné nástroje, poznámky/kalkulačka/kalendár, príslušné testy. Po hlavnom workflow samostatný agent pre externé odovzdanie podľa pripraveného kontraktu. Ochrana údajov nesmie byť dôvod na tiché vypustenie požadovanej funkcionality; prípadné blokery sa musia presne zdokumentovať a riešiť.
