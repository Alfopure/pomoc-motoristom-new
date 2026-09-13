# Živý náhľad rozhrania so zachovaním funkcií

Stav: návrh na nezávislú architektonickú a následnú kritickú kontrolu. Dátum 12. 9. 2026.
Základ: aktuálny origin/dev 6cbd23eb1769cfa99a5b694f2f5c4e2af1fe6b70; samostatná vetva feat/live-layout-preview. Pôvodný checkout fix/case-header-pdf ostáva zachovaný.

## Zámer a zásady

Používateľ schválil grafický smer syntetického prototypu, ale žiada reálnu aplikáciu so všetkými existujúcimi údajmi a funkciami, najmä filtrami, radením, úplným vstupom údajov, úpravou panelov a použiteľnosťou na notebooku. Nový náhľad má pracovať s dátami tejto testovacej kópie a umožniť okamžitý návrat vzhľadu. Produkčná verzia sa v tejto etape nemení.

1. Jeden existujúci komponentový strom, existujúce providery a API. Žiadna druhá kópia prípadov, SMS, úloh ani databázy.
2. Úplnosť údajov má prednosť pred dekoráciou. Neschovať informácie kariet, filtre ani akcie pre dosiahnutie čistej snímky.
3. Spätný prepínač mení iba vzhľad, nie route, React key, mount, draft alebo workflow. Zachovať existujúce osobné šírky, kolapsy a poradie widgetov.
4. Každá živá funkcia používa existujúcu autorizáciu/capability a pravdivé stavy. Nové backendové workflow nesimulovať ako uložené pri skutočných údajoch.
5. Preview je samostatné nasadenie tejto kópie, ale jeho zápisy sú skutočné pre všetkých jej používateľov.

## Rozhodnutie (prispôsobený postup Ralplan)

Kritériá: zachovanie funkcií, bezpečný návrat a plnohodnotný notebookový pracovný priestor.

A. Nový oddelený klient nad rovnakou databázou: veľká voľnosť vzhľadu, ale duplicita formulárov, oprávnení, modelov, draftov a regresií. Nadväzuje na chybu prvej zjednodušenej ukážky; odmietnuté pre túto etapu.
B. Voliteľná vizuálna vrstva existujúceho DispatchConsole: obmedzená sloboda zásadných presunov, ale zachová celé správanie a umožní návrat bez remountu. Vybrané.
C. Plošné nahradenie existujúceho dizajnu: jednoduchšie CSS, ale bez priebežného porovnania a nezávislého návratu. Odmietnuté.

Využívame metodiku upstream Ralplan (návrh, samostatný architektonický recenzent, následne iný kritický recenzent). OMX runtime ani host-issued oprávnenia v tomto prostredí nevytvárame; lokálne recenzie sú poradným dôkazom kvality. Aktuálna správa používateľa explicitne objednáva prípravu živého náhľadu.

## Konkrétne zmeny

- Preview/development má prepínač Nový vzhľad / Pôvodný vzhľad; na produkcii ovládanie ani nový predvolený vzhľad nie sú aktivované. Moderný stav je data-layout-preview na existujúcom koreni. Voľba sa ukladá oddelene podľa organizácie a profilu; chybný alebo nedostupný localStorage nesmie prerušiť prácu. UI jasne odlišuje reálne spoločné dáta od mock testu.
- Kompaktné jemné plochy, zaoblenie pracovných panelov, čitateľné filtre a formuláre, rozumnejšie členenie karty a riadkov. Zachovať žltú značku a stavové farby. Všetky štýly nového vzhľadu sú scoped; pôvodný vzhľad ostáva použiteľný.
- Zachované ľavé filtre Stav/Priorita/Operátor/Zdroj/Asistenčná služba, vyhľadávanie a všetky druhy radenia; čísla prípadov, kontakty, vozidlá, miesta, upozornenia, časové údaje a kontext na kartách.
- Zachované obidva horizontálne resize prvky, klávesnica, dvojklik reset, kolaps a obnovenie; zachovaný spodný vertikálny resize karty, maximalizácia a minimalizácia. Na notebooku 1280×720 a 1366×768 sa hlavné ovládanie nesmie stratiť pod obrazovkou. Nepoužiť výplňové min-height, ktoré vyrába prázdny priestor; dlhý obsah má vlastné scrollovanie.
- Zachované lokálne Mapa/Úlohy/Poznámky/Tabuľka a samostatné hlavné obrazovky. Nástroje otvoria nástroje; prispôsobenie widgetov ostáva samostatnou akciou.
- Widgety používajú aktuálne modely: poznámky vrátane editácie, autosave, ACL a zdieľania; kalkulačka vrátane textového výrazu, zátvoriek, čiarky, kopírovania plus mazanie jedného znaku v novom vzhľade; voliteľný skrytý kalendár ukazuje termíny existujúcich oprávnených úloh. Poradie, viditeľnosť a zbalenie každého widgetu zachované. Telefón, úlohy, hľadanie, flotila a plánovač trasy sa nevytratia.
- Hovory: existujúce operátorské akcie, dostupnosť, záznamy, nahrávky, prepisy a oprávnenia bez nových live telephony vedľajších účinkov. Zmena vzhľadu nesmie znovu mountnúť telephony hook/provider.

## SMS a odovzdanie prípadu – posledné spresnenie

Prioritou SMS je odoslať správu v kontexte prípadu a vidieť odoslanú históriu/doručenie. Zachovať samostatné odoslanie, kde ho dnešná aplikácia podporuje; príjemca aj prípad musia byť zjavné pred potvrdením. Prijaté SMS/konverzácie nie sú hlavnou navigačnou investíciou, keďže príjem nie je zapnutý. Existujúcu históriu ani kód schopností nevymazať. Nevytvárať nový SMS provider ani automatické odosielanie. V náhľade rešpektovať existujúce vypínače odosielania; nové povolenie skutočných SMS nie je súčasťou zmeny dizajnu.

Odovzdanie inému stredisku je samostatný doménový tok: obmedzený odkaz na konkrétny prípad, vybraný kontakt/vozidlo/miesto/cieľ/pokyny, prijatie/odmietnutie s dôvodom a následné stavové aktualizácie. Existujúci verejný GPS odkaz ani demo ?handoff ID neposkytuje vhodnú autorizáciu. Pred reálnym sprístupnením treba účelový náhodný token uložený hashom, expiráciu/revokáciu, minimálny DTO, kontrolu oprávnení vydania, audit a atomické/idempotentné prechody. Odovzdanie nesmie sprístupniť interné poznámky/ceny/prepisy, ostatné prípady ani priame editovanie celého prípadu. Otvorenie URL nie je prijatie. Navrhované riešenie a presné existujúce možnosti sa uvedú v paritnej matici; živý náhľad nebude vydávať nezabezpečený verejný odkaz.

Nový reviewer workflow úloh a externé odovzdanie zo syntetického návrhu nie sú existujúce serverové funkcie. Tento parity náhľad ukáže pravdivé aktuálne funkcie, nie falošné schválenia v localStorage nad živými údajmi. Ich serverová implementácia je nasledujúca oddelená zmena po kontrole vizuálu; existujúce task stavy/dátumové skupiny/pripomienky sa pri tejto zmene nedestruktívne zachovávajú.

## Návrat a nasadenie

1. Lokálny prepínač okamžite vráti pôvodný vzhľad v tom istom strome; neuložené formuláre, filtrovanie a hovory pokračujú. Návrat vzhľadu nevracia uložené údaje databázy.
2. Aktuálna produkcia a dev ostávajú bez merge. Zmena sa pushne na samostatnú vetvu a otvorí sa draft PR do dev. Žiadny PR do main ani produkčné nasadenie.
3. Vercel Preview musí mať splnený rovnaký gate vitest run, typecheck, build. Overiť presnú SHA, READY a ochranu prihlásením. Použiť trvalejší deployment/branch odkaz, nie tunel závislý od VM.
4. Bez DB migrácií, seedov, vypínačov SMS/volaní, workerov/listenerov/schedulerov. Konfigurácia existujúceho povoleného cronu zostáva.
5. Ak bude problém, používateľ môže prepnúť vzhľad alebo používať nezmenenú aktuálnu aplikáciu. Vetva sa dá opraviť samostatným commitom; rollback nemá robiť restore databázy.

## Riziká vopred a overenie

R1: vizuálne skryjeme dôležité údaje/akcie. Mitigácia: písomná paritná matica + screenshoty oboch režimov, rovnaké počty a obsahy kariet a funkčné filtre, dlhé reálne reprezentatívne mock texty.
R2: prepínač remountne formulár/telefón alebo prepíše osobné nastavenie. Mitigácia: rovnaký strom a key; test neuloženého EČV, poznámky a kalkulačky pred/po prepnutí, zachovanie rozmerov/kolapsu a existujúcich storage kľúčov.
R3: preview zamieňame za sandbox a test pošle SMS alebo prepíše dáta. Mitigácia: viditeľné označenie spoločných dát, všetky interaktívne browser regresie na existujúcom fixture s úplne zachytenými requestmi; živé nasadenie sa kontroluje anonymne cez login/status/build a API auth, bez volania alebo zápisov. Pri chýbajúcej oprávnenej session netvrdiť test živých formulárov po prihlásení.

Akceptácia:
- A01: Moderný/pôvodný vzhľad je dostupný iba v Preview/development. Produkčná vetva renderuje dnešné UI.
- A02: Prepnutie vzhľadu zachová DOM inštanciu a obsah neuloženého editora, filtre, sort, vybraný prípad, lokálny panel a widgety. Žiadne save ani remount pri prepnutí.
- A03: Vľavo všetkých päť filtrov, reset, sorty a všetky pôvodné informačné polia; lokalne taby nemenia hlavnú obrazovku a hlavné Úlohy používajú rovnaký store.
- A04: Resizing/kolaps/obnova oboch strán, vertikálne delenie a maximalizácia karty fungujú myšou aj existujúcou klávesnicou. Sidebar nastavenia zostanú po prepnutí aj reload.
- A05: Žiadne horizontálne pretekanie pri 360/390/768/1024/1280/1366/1440; notebookové výšky 720/768; hlavné akcie sa neprekrývajú. Screenshoty pre ručnú kontrolu; klávesnicové ovládanie a dialógy ostávajú.
- A06: Kalkulačka zachová parser/funkcie/výraz a pridá znakové mazanie; kalendár zobrazuje iba povolené existujúce úlohy a otvorí ich existujúcim mechanizmom. Skrývanie widgetov nemaže obsah.
- A07: Všetky existujúce unit testy, strict typecheck a build; relevantné e2e compact-workspace, workspace-provider-lifecycle, case-cockpit a nové parity testy.
- A08: Preview READY pre presnú testovanú SHA; login a neprihlásený citlivý API prístup blokované; žiadne produkčné/env/DB zmeny. Presne vypísať, čo bolo overené cez mock a čo živým deployom.

Plánovanie a paritná matica v docs/rollout; test logy a snímky v gitignored .context. Nezávislé recenzie a odovzdanie sa uložia s SHA plánu.
