# Plán klientskeho HTML návodu

Stav: schválený návrh; prvá verzia HTML príručky je implementovaná. Pôvodný plán vznikol 11. 9. 2026 podľa pracovnej verzie aplikácie `c29c445`. Aktuálny rozsah, spustenie a údržbu opisuje [Klientsky návod — implementácia](client-guide.md). Nasledujúci text zachováva návrh a požiadavky pre ďalšie etapy.

## 1. Zámer a výsledná podoba

Pripraviť slovenskú webovú príručku, podľa ktorej sa nový dispečer naučí obsluhovať aplikáciu a vedúci nastaví jej telefonovanie. Čitateľ nemusí poznať dispečerské systémy ani telefónne ústredne.

Odporúčaná podoba je **HTML príručka s viacerými krátkymi kapitolami**, obsahom, vyhľadávaním a skutočnými screenshotmi aplikácie. Bude navrhnutá pre dva spôsoby použitia:

- Samostatná webová príručka, na ktorú možno poslať odkaz klientovi.
- Sekcia **Návod** priamo v aplikácii, s rovnakým obsahom a odkazmi na konkrétne postupy.

Text, obrázky a identifikátory postupov budú mať jeden spoločný zdroj. Samostatná aj integrovaná podoba sa z neho vytvoria automaticky. Neskorší stručný návod bude vyberať rovnaké postupy a odkazovať na ich podrobné vysvetlenie. Tento zdroj bude pripravený aj pre budúceho AI pomocníka, ktorý dokáže vysvetľovať postupy a cez samostatný autorizovaný prístup čítať aktuálne nastavenia telefonovania.

Po schválení realizácie vznikol klientsky obsah, screenshoty, HTML príručka aj integrácia do aplikácie. Príprava pre AI zahŕňa spoločný export dokumentácie a tento návrh zdrojov a oprávnení. Chatbot zostáva ďalšou etapou; jeho budúci rozsah je vysvetľovanie a čítanie, bez vykonávania zmien.

## 2. Pre koho bude návod

| Čitateľ | Čo potrebuje vedieť |
| --- | --- |
| Nový dispečer | Prihlásiť sa, pripraviť telefón, prijať hovor, založiť a viesť prípad, vybaviť čakajúce a spätné hovory, odísť na pauzu a vrátiť sa. |
| Skúsený alebo senior dispečer | Prepojenie a konzultácia hovoru, odovzdanie práce, úlohy, história, vyhľadávanie a riešenie nezvyčajných situácií. |
| Vedúci / manažér | Skupiny, plány zvonenia, linky, otváracie hodiny, zastupovanie, hlášky, operátori, plánovanie smien a dohľad. |
| Administrátor | Používateľské oprávnenia a vyhradené prevádzkové nastavenia; rozpoznanie problémov, ktoré už patria technickej podpore. |

Každý postup dostane označenie potrebnej roly. Vysvetlenie základných pojmov bude spoločné. Viditeľnosť položky v menu sa nebude zamieňať s oprávnením uložiť zmenu. Napríklad Reporty sú podľa aktuálneho API dostupné aj dispečerom.

## 3. Navrhované členenie obsahu

### A. Začíname a pripravujeme pracovisko

1. **Prvý prístup a prihlásenie** — pridelenie účtu, nastavenie hesla z odkazu, prihlásenie, zabudnuté heslo, odhlásenie a rozdiel medzi používateľskými rolami.
2. **Orientácia v aplikácii** — Nástenka, Menu, pripnuté obrazovky, Prípady, Ústredňa, Úlohy, Poznámky, Nástroje a Nastavenia; rozdiel medzi počítačom a mobilom.
3. **Pripravenie na službu** — pripojenie telefónu, mikrofón a zvuk, stav Dostupný, upozornenia, kontrola pracoviska. Osobitne vysvetliť, že prihlásenie, naplánovaná smena a dostupnosť na telefonovanie sú odlišné veci.

### B. Telefonovanie počas služby

4. **Prijatie a začatie hovoru** — prichádzajúce okno, Prijať/Odmietnuť, odchádzajúca linka, volanie z prípadu a adresára, prepojenie hovoru s prípadom.
5. **Čo možno robiť počas hovoru** — mikrofón, Podržať/Pokračovať, Do čakárne, priame prepojenie, Konzultovať, Dokončiť prepojenie a Zrušiť konzultáciu; pokročilé konferenčné akcie len podľa potvrdenej dostupnosti.
6. **Čakáreň** — kto ešte čaká na linke, poradie a stav hovoru, automatické ponúkanie, ručné prevzatie, odložený hovor a správanie po vypršaní času.
7. **Neprijaté a spätné hovory** — rozdiel medzi výslovnou žiadosťou klienta a neprijatým hovorom; prevzatie zodpovednosti, zavolanie, vybavenie alebo zrušenie požiadavky, neznáme či nepoužiteľné číslo a prípadné potvrdenie overeného náhradného čísla.
8. **Pauza, zastupovanie a dopisovanie** — Bežná pauza, Zastúpi ma kolega, pripomienka konca pauzy, návrat cez Som dostupný a čas na dokončenie zápisu po hovore.

### C. Každodenná práca s prípadmi

9. **Prípad od prvého kontaktu po uzavretie** — nový prípad ručne/z hovoru, zákazník a kontakty, vozidlo a incident, miesto a cieľ, služby, zodpovedný dispečer, technika, priorita, stav a ukončenie.
10. **Mapa, poloha a komunikácia** — výber miesta, vyžiadanie polohy SMS, prijatá poloha a jej použitie, trasa, odhad príchodu, SMS a história komunikácie.
11. **Úlohy, poznámky a odovzdanie práce** — zodpovedná osoba, termín a pripomenutie, správy pri úlohe, prepojenie na prípady, osobná poznámka a jej zdieľanie, upozornenia.
12. **Vyhľadávanie a administratívne dokončenie** — Aktívne/História, filtre, prílohy, export prípadu do PDF, príprava fakturácie a riešenie neuložených alebo konfliktných zmien.

### D. Ako je nastavené telefonovanie

13. **Ako sa hovor dostane k operátorovi** — jednoduchý slovník a schéma: telefónne číslo → pravidlá otváracích hodín a prípadné IVR → plán zvonenia → skupina → dostupný operátor → ďalší krok alebo náhradné riešenie.
14. **Môj telefón a operátori** — prijímanie cez aplikáciu alebo osobný mobil, odchádzajúca linka, zvukové zariadenie a nastavenia zvuku, dopisovanie, telefón v inom okne a nastavenia kolegov podľa oprávnení. Ovládanie hlasitosti opísať až po overení jeho účinku; samotná uložená hodnota nemusí ovládať zvonenie prehliadača.
15. **Skupiny zvonenia** — čo skupina určuje, členovia, operátor verzus externé číslo, poradie, aktívnosť a čas jednotlivého člena.
16. **Plány a kroky zvonenia** — pridanie skupiny do kroku, poradie krokov, čas, všetkým naraz/postupne, správanie pri nedostupnosti a čo sa stane, keď nikto nezdvihne.
17. **Čísla, otváracie hodiny a IVR** — priradenie plánu k číslu, vetvenie podľa tlačidiel volajúceho, pracovný čas, sviatky a výnimky; kontrola výslednej cesty hovoru.
18. **Hlášky, jazyk a nahrávanie** — text, náhľad, uloženie a účinnosť hlášky; rozdiel medzi hláškou o nahrávaní a samotnou politikou nahrávania; nastavenia kvality podľa roly.

### E. Organizácia prevádzky

19. **Dochádzka a odovzdanie služby** — moja dochádzka, plánovanie a publikovanie smien, neprítomnosť a žiadosti; dostupnosť telefónu zostáva samostatný stav.
20. **Flotila a adresár** — dostupné vozidlá, priradenie a obsadenie, aktuálnosť polohy, kontakty, firmy, pobočky a asistencia.
21. **Reporty, dohľad a používatelia** — výber obdobia, zmysel ukazovateľov, história a kvalita hovorov, wallboard a správa účtov podľa oprávnení.

### F. Keď niečo nefunguje

22. **Rýchle riešenie problémov** — neviem sa prihlásiť, nezvoní mi telefón, nepočujem klienta, klient nepočuje mňa, telefón je v inom okne, sivé tlačidlo, neviem prevziať hovor, neprišlo upozornenie, zmena sa neuložila, údaje zmenil kolega.
23. **Slovník a kontrolné zoznamy** — pred službou, pred pauzou, po návrate, pri odovzdaní prípadu a po zmene plánu zvonenia.

Poradie pre nového dispečera bude A → B → C → relevantné problémy z F. Vedúci po základnej orientácii prejde na D a E. Navigácia umožní obidve cesty bez prechádzania nepotrebných kapitol.

## 4. Telefonovanie: čo musí návod vysvetliť presne

Nasledujúce body sú požiadavky na budúci obsah, odvodené z aktuálneho kódu. Nie sú potvrdením uložených nastavení klienta.

| Téma | Požadované vysvetlenie a overenie |
| --- | --- |
| Skupina verzus plán | Skupina určuje komu sa ponúka hovor. Plán určuje postup a následné riešenie. Vytvorenie plánu ho samo nepriradí k číslu. |
| Súčasné a postupné zvonenie | Pri súčasnom zvonení platí spoločný čas kroku. Pri postupnom sa uplatňuje čas jednotlivého člena; prázdny čas člena preberá čas z kroku. Použiť časovú os, nie iba screenshot formulára. |
| Dĺžka zvonenia | Ukážkových 20 sekúnd pri troch členoch postupne môže znamenať až 60 sekúnd; nejde o univerzálny celkový limit kroku. Dostupnosť a prijatie hovoru ovplyvnia skutočné trvanie. |
| Dostupnosť a kapacita | Dostupný operátor potrebuje zodpovedajúce zariadenie/režim. Pauza, iný hovor, dopisovanie alebo odpojenie môžu zabrániť ponuke. Pri súčasnom zvonení existujú kapacitné limity organizácie. |
| Účinnosť nastavení | Zmeny skupín a plánov platia pre nové hovory; rozbehnutý hovor si ponecháva svoj plán. Ukázať uloženie, väzbu na číslo a následnú kontrolu novým skúšobným hovorom. |
| Čakáreň verzus spätné volanie | V čakárni je klient stále na linke. Požiadavka na spätný hovor je záznam práce na neskôr. Tlačidlo Prevziať má v týchto dvoch kontextoch odlišný význam. |
| Ponúkanie z čakárne | Dostupný operátor dostáva ponuku, hovor sa tým automaticky nezdvihne. Opakované ponuky automatickej fronty nesmú byť opísané ako opakované vytáčanie všetkých externých záloh. |
| Koniec čakania | Vysvetliť limit čakárne a ponuku spätného volania. Voľbu klienta počas čakárne odlíšiť od číslice nastavenej v úvodnom IVR. Overiť súlad hlášky a reálnej akcie. |
| Pauza a osobný mobil | Pauza blokuje automatické pracovné hovory aj na osobnom mobile. Režim prijímania na mobile sa nastavuje osobitne. Bežná pauza a zastupovanie kolegom sú aktuálne možnosti dialógu pauzy. |
| Návrat z pauzy | Odporúčaná dĺžka ani pripomienka neznamenajú automatický návrat do dostupnosti. Osobitne vysvetliť dopisovanie, ktoré má vlastný čas a možnosť skoršieho ukončenia. |
| Aktívny hovor | Stlmiť mikrofón, podržať hovor, odložiť ho do čakárne a prepojiť ho sú rozdielne kroky. Pri každom uviesť pohľad dispečera, kolegu a volajúceho. |
| Podmienené funkcie | Prevzatie počas pauzy, konferencia, dohľad a mobilné správanie sa zahrnú ako dostupný postup až po potvrdení v cieľovom nasadení. |
| Spôsoby používania mobilu | Rozlíšiť web/PWA v mobile, prijímanie na osobnom telefónnom čísle a prípadnú samostatnú SIP aplikáciu. Názov „mobilné volanie“ ich nesmie zamieňať; podporované možnosti overiť pre konkrétne zariadenie. |

Pre výklad pripraviť jeden spoločný tréningový scenár: ukážková hlavná skupina, záložná skupina, dva kroky zvonenia a čakáreň alebo ponuka spätného volania. Na rovnakých menách a nastaveniach ukázať výsledok pri prijatí, neprijatí a pauze operátora. Hodnoty v scenári budú výslovne označené ako príklad.

## 5. Šablóna jednej kapitoly alebo postupu

Každý postup bude mať stabilný identifikátor a rovnakú základnú stavbu:

1. **Čo chcete urobiť a kedy sa to používa.** Krátke vysvetlenie bez technických skratiek.
2. **Čo potrebujete.** Rola, potrebný stav telefónu/prípadu a prípadné predchádzajúce nastavenie.
3. **Kde to nájdete.** Presná cesta a názvy prvkov podľa rozhrania.
4. **Jednotlivé kroky.** Jedna činnosť na krok; číslovanie zhodné so značkami na obrázku.
5. **Čo uvidíte po dokončení.** Potvrdenie uloženia alebo zmena stavu. Pri telefonovaní aj čo sa deje volajúcemu a kolegovi.
6. **Najčastejšia odchýlka.** Napríklad kolega na pauze, chýbajúce oprávnenie alebo neuložená zmena.
7. **Súvisiace postupy.** Odkazy na predpoklady, nadväzujúce kroky a stručnú verziu.

Screenshot doplní text. Žiadny zásadný pokyn nesmie byť dostupný iba na obrázku alebo po prejdení myšou. Technické témy ako nastavenie Telnyx účtu, serverové kľúče alebo migrácie budú prípadne samostatnou prílohou pre správcu, nie súčasťou zaškolenia dispečera.

## 6. HTML rozhranie a začlenenie do aplikácie

### Čítanie a navigácia

- Úvodná stránka s voľbami **Začínam**, **Telefonovanie**, **Práca s prípadmi**, **Nastavenia pre vedúceho** a **Riešenie problémov**.
- Na počítači obsah vľavo, kapitola v strede a obsah aktuálnej kapitoly podľa priestoru. Na mobile vysúvateľný obsah a plne čitateľný text bez vodorovného posúvania.
- Vyhľadávanie v nadpisoch aj texte, bez závislosti od externého vyhľadávacieho účtu. Počítať so synonymami „pauza/prestávka“, „čakáreň/fronta“, „spätné volanie/callback“ a hľadaním bez diakritiky.
- Stabilné adresy kapitol a krokov, napríklad `/navod/telefonovanie/plany-zvonenia#poradie-krokov`; možnosť skopírovať odkaz.
- Zväčšenie screenshotu po kliknutí, popis a alternatívny text. Základný postup zostáva čitateľný bez otvárania obrázkov.
- Jednoduchá schéma cesty hovoru a časové osi. Voliteľný prepínač „všetkým naraz/postupne“ môže neskôr ukazovať rozdiel na rovnakom príklade; nebude podmienkou prvého vydania.
- Označenie roly, dátumu overenia a verzie aplikácie. Zobrazenie stručnej/podrobnej pomoci sa pridá neskôr nad tým istým obsahom.
- Tlačové štýly sú užitočný doplnok. PDF nebude primárny výstup ani podmienka realizácie.

### Integrácia

Odporúčanie: samostatná sekcia `/navod`, položka **Návod** v existujúcom menu účtu a neskôr kontextové odkazy pri zložitejších nastaveniach.

Hlavná aplikácia dnes drží rozpracovaný obsah a telefón vo vnútri `DispatchConsole` na adrese `/`. Odkaz na návod preto na počítači otvorí novú kartu. Návod nebude pripájať ďalší telefón ani inicializovať dispečerskú konzolu. Na mobile/PWA treba osobitne overiť návrat do hovoru a správanie pri presune aplikácie do pozadia; nová karta sama osebe toto nezaručuje.

Obsah sa má vykresľovať vlastnou stránkou alebo komponentmi. Existujúce nastavenie `X-Frame-Options: DENY` nie je vhodným základom pre vloženie cez iframe; plán s iframe nepočíta.

Pracovný návrh prístupu: plný interný návod pre prihlásených používateľov, krátka pomoc s prihlásením a obnovou hesla dostupná aj pred prihlásením. Samostatné klientské vydanie môže používať rovnaký všeobecný obsah s ukážkovými dátami. Rozsah prípadného verejného sprístupnenia sa rozhodne pred publikovaním; implementácia nemá automaticky zverejniť prevádzkové údaje.

### Udržateľný zdroj

Budúca realizácia oddelí obsah kapitol, obrázky s popismi a HTML zobrazenie. Vhodný východiskový návrh je Markdown s metadátami a malou sadou spoločných komponentov pre kroky, upozornenia, obrázky a schémy. MDX použiť iba tam, kde sa potvrdí potreba interaktívnych príkladov.

Z rovnakého zdroja sa zostaví navigácia, vyhľadávací index, samostatné aj integrované vydanie a strojovo čitateľný obsah pre budúceho AI pomocníka. Obrázok bude naviazaný na konkrétny postup, scénu a verziu rozhrania, aby sa po zmene aplikácie dal cielene obnoviť. Knižnicu na spracovanie obsahu vybrať až pri realizácii; samotný plán nepotrebuje zaviesť nový dokumentačný systém.

Pri tvorbe obsahu už počítať s identifikátormi kapitol, postupov, krokov, obrázkov a zvýraznení. AI tak môže odkázať priamo na správny krok a označený prvok. Aktuálne nastavenia organizácie sa nebudú zapisovať do statického návodu ani miešať s ukážkovými hodnotami.

## 7. Plán screenshotov a overenia postupov

### Metóda

Použiť skutočné komponenty a štýly aplikácie otvorené v prehliadači. Rozhranie klikať, prepínať jeho záložky a pripravovať potrebné stavy. Obrázky nevytvárať kreslením napodobeniny aplikácie.

Pre stavy ako viac čakajúcich hovorov, pauza, konflikt uloženia alebo konkrétne nastavenie plánu použiť izolované tréningové údaje a zachytené API odpovede. V repozitári už existujú takéto prehliadačové scenáre. Tie umožnia pripraviť konzistentné screenshoty bez zmien v zdieľaných dátach.

Samostatne porovnať obrazovky s určenou verziou nasadenej aplikácie a overiť skutočné roly a dostupné funkcie. Overenie zvuku, zvonenia, prepojenia a mobilného prijímania potrebuje kontrolované skutočné hovory; samotný izolovaný screenshot ho nenahrádza.

### Rozsah záberov

Pracovný odhad je približne **30–45 účelných záberov a detailov**. Počet sa upraví podľa čitateľnosti a opakovaného využitia, nie podľa potreby odfotiť každé tlačidlo.

| Sada | Čo zachytiť |
| --- | --- |
| Prvý prístup | Prihlásenie a obnova hesla, desktopová Nástenka, Menu, mobilná navigácia. |
| Pripravený telefón | Dostupnosť a pripojenie, Môj telefón, zvuk/mikrofón, telefón v inom okne. |
| Obsluha hovorov | Prichádzajúci hovor, aktívna lišta, konzultácia/prepojenie, dopisovanie. |
| Čakáreň a návrat k zákazníkovi | Viac čakajúcich a odložený hovor, ručné prevzatie, žiadosť o spätný hovor, neprijatý hovor a vybavená požiadavka. |
| Pauza | Bežná pauza, výber zastupujúceho kolegu, pripomienka a návrat do dostupnosti. |
| Nastavenie smerovania | Členovia skupiny, poradie, dva kroky plánu, časy, náhradné riešenie, priradenie k číslu, hodiny/výnimky, IVR a hlášky. |
| Práca s prípadom | Zoznam a filtre, nový prípad, existujúca karta a uloženie, poloha/SMS, úloha a poznámka. |
| Ďalšia prevádzka | Upozornenia, dochádzka, flotila, adresár, reporty a relevantné oprávnenia. |

### Pravidlá kvality obrázkov

- Jednotné rozlíšenie desktopu, napríklad 1440 × 1000; dôležité mobilné postupy aj pri šírke približne 390 px.
- Jeden orientačný záber a potom čitateľné detaily. Dlhý formulár nerozmenšiť na nečitateľnú celostránkovú fotografiu.
- Najviac 1–3 číslované zvýraznenia v jednom zábere, rovnaké číslovanie v texte. Značky môžu vzniknúť ako dočasná vrstva nad skutočným rozhraním pred vytvorením screenshotu.
- Jednotné fiktívne mená, čísla a prípady. Jasne rozlíšiť ilustračné údaje od reálnych nastavení klienta.
- Pred snímaním počkať na načítanie údajov a ustálenie rozhrania; finálne zábery skontrolovať aj vizuálne, vrátane správnej typografie.
- Evidovať ID obrázka, kapitolu, rolu, scenár, rozmery, verziu aplikácie a spôsob zopakovania záberu.

### Moderné zvýrazňovanie a prepojenie s textom

Vizuálny štýl: čistý screenshot, tenký zaoblený rámček okolo cieľa, malá číslovaná značka a krátky popis na bielej ploche s jemným tieňom. Vysvetľujúce značky môžu používať modrý akcent, aby sa odlíšili od žltého označenia aktívnych prvkov aplikácie. Vyhnúť sa veľkým šípkam cez formulár a textu zakrývajúcemu ovládanie.

Podľa účelu zvoliť jeden z troch spôsobov:

- **Orientácia:** najviac tri značky v celkovom pohľade, s vysvetlením pod obrázkom.
- **Konkrétny krok:** jeden zvýraznený prvok a prípadné jemné stmavenie okolia. Kontext a názvy susedných prvkov musia zostať čitateľné.
- **Malý alebo hustý formulár:** samostatný zväčšený detail pri celkovom pohľade. Na mobile sa popis presunie pod obrázok.

Pre finálne HTML preferovať pôvodný screenshot a samostatnú vrstvu zvýraznení v HTML/SVG. Uložiť relatívnu polohu prvku voči obrázku, jeho textový názov a väzbu na krok. Súradnice sa získajú zo skutočného rozhrania pri snímaní; desktopový a mobilný záber budú mať vlastné záznamy. Vrstva sa škáluje spolu s obrázkom. Textové popisy zostanú dostupné aj bez interakcie a farba nebude jediným nositeľom významu.

Kliknutie na krok môže neskôr zvýrazniť jeho značku v obrázku. Odkaz od chatbota môže otvoriť ten istý krok a zvýraznenie; nebude potrebné, aby AI odhadovala polohu tlačidla z pixelov. Pre zdieľanie možno z rovnakých anotácií vytvoriť aj bežný obrázok so značkami. Základné číslované zvýraznenie je už technicky overené; uvedený finálny vizuálny systém zostáva návrhom.

## 8. Čo sa už technicky overilo

V tomto pracovnom prostredí sa podarilo v Google Chrome cez Playwright:

1. Otvoriť skutočný `DispatchConsole` s existujúcimi lokálnymi ukážkovými dátami.
2. Kliknúť **Menu → Nastavenia → Telefonovanie → Skupiny**.
3. Otvoriť **Plány zvonenia** s ukážkovou skupinou a krokom.
4. Pridať číslované zvýraznenie do zobrazeného rozhrania a vytvoriť screenshot.
5. Vytvoriť aj mobilný záber pri šírke 390 px.

Pri úspešnom behu nevznikla JavaScript chyba ani požiadavka na zmenu údajov. Všetky HTTP požiadavky prehliadača boli zachytávané lokálnym overovacím skriptom. Nevytáčal sa telefón, neodosielala SMS a nečítala ani nemenila vzdialená databáza. Boli nainštalované závislosti projektu; aplikačný kód ani konfigurácia sa nemenili.

Pracovné dôkazy sú gitignorované, nie sú súčasťou budúceho klientskeho návodu:

- Overovací skript: `../.context/guide-feasibility.mjs`.
- Výsledok: `../.context/guide-feasibility/report.json`.
- Nástenka: `../.context/guide-feasibility/01-console.png`.
- Skupiny: `../.context/guide-feasibility/02-groups.png`.
- Plán so zvýraznením: `../.context/guide-feasibility/03-ring-plan-highlight.png`.
- Mobilný záber: `../.context/guide-feasibility/04-mobile.png`.

**Zatiaľ sa neoverilo:** prihlásenie do nasadenej aplikácie, uložené nastavenia klienta, skutočný zvuk a smerovanie cez Telnyx, všetky roly ani mobilný hovor na fyzickom zariadení. Prehliadačové overenie použilo skutočné komponenty s ukážkovými odpoveďami, nie prihlásenú živú aplikáciu. Je dôkazom použiteľnosti postupu na výrobu screenshotov.

## 9. Etapy budúcej realizácie

| Etapa | Konkrétny výstup | Podmienka dokončenia |
| --- | --- | --- |
| 1. Potvrdenie referenčnej verzie | Zoznam dostupných funkcií, rolí a skutočných názvov obrazoviek; určené tréningové prípady a telefónne čísla. | Odlišnosti medzi kódom, nasadením a návrhovými dokumentmi sú zaznamenané. |
| 2. Obsahová mapa | Kapitoly, slovník, identifikátory postupov/krokov/anotácií, screenshotový zoznam a jeden spoločný telefonický scenár; metadata pre vyhľadávanie a AI. | Všetky základné činnosti majú miesto v obsahu a každý postup sa dá samostatne nájsť a citovať. |
| 3. Overenie telefonovania | Matica: prijatý/neprijatý hovor, ďalší krok, všetci obsadení, pauza, zástup, čakáreň, spätné volanie, prepojenie a návrat do služby. | Je známe, čo vidí operátor, čo počuje volajúci a ako situácia skončí; neoverené možnosti sa neoznačujú za potvrdené. |
| 4. Obsah a obrázky | Postupy podľa jednotnej šablóny a hotové anotované screenshoty. Najprv A, B a D, potom C, E a F. | Každý postup má predpoklady, presné kroky, očakávaný výsledok a použitý zdroj overenia. |
| 5. HTML príručka | Responzívne kapitoly, obsah, odkazy, vyhľadávanie, anotované obrázky a spoločný obsah pre samostatné aj aplikačné vydanie; export znalostí pre budúceho pomocníka. | Funguje klávesnica, mobil, odkazy na kroky a hľadanie slovenských pojmov; HTML aj export používajú rovnaké znenie a verziu. |
| 6. Integrácia a skúška s používateľom | Položka Návod a kontextové odkazy; skúška niekoľkých úloh človekom, ktorý aplikáciu nepozná. | Otvorenie pomoci neodpojí aktívny telefón ani nezahodí zmeny; používateľ dokončí úlohy bez vysvetľovania autora. |
| 7. Stručný návod | Krátka cesta „prvá služba“ a prehľad najčastejších úkonov zo spoločného zdroja. | Skrátenie nevytvorí druhú, nezávisle udržiavanú verziu pravidiel. |

Budúce rozšírenie o AI bude mať vlastné etapy: najprv odpovede nad dokumentáciou, potom čítanie uložených nastavení a až následne vysvetľovanie prevádzkového stavu. Prvé vydanie návodu na dokončenie chatbota nečaká. Podrobnosti sú v časti 12.

Pri budúcom nasadzovaní dodržať postup tohto repozitára: aktuálny `dev` → pracovná vetva → Preview a build gate → PR do `dev` → kontrola aliasu `dev`; produkčné vydanie cez PR `dev` → `main`. Aktuálna plánovacia úloha nič nenasadzuje a nevyžaduje meniť meno existujúcej vetvy.

## 10. Čo bude potrebné pri realizácii

- Určiť verziu a adresu povolenej Telnyx kópie, podľa ktorej sa návod definitívne overí.
- Mať dostupný prístup dispečera a vedúceho/admina bezpečným spôsobom, nie heslá uložené v návode.
- Dohodnúť kontrolované účty, prípady a telefónne čísla pre reálne skúšky hovorov a prípadné SMS.
- Pred začiatkom klientskeho vydania potvrdiť aktuálne skupiny, časy, linky a používané funkcie. Predvolené hodnoty a staršie návrhy nenahrádzajú kontrolu živej konfigurácie.
- Pred publikovaním rozhodnúť, či samostatná príručka bude verejná alebo prístupná len klientovi. Konkrétne kroky v aplikácii môžu závisieť od roly, aj keď ich vysvetlenie bude spoločné.

Preview aj Development tejto kópie používajú zdieľanú databázu a zápisy sú reálne. Budúce fotografovanie bude preto primárne využívať izolované scény. Živé zápisy a hovory sa vykonajú iba v rámci dohodnutého overovacieho scenára. Tento plán nezahŕňa migrácie, seed ani nasadenie workerov alebo listenerov.

## 11. Kontrola úplnosti pred odovzdaním

- Začiatočník podľa návodu pripraví telefón, prijme hovor, založí prípad, nájde čakajúci hovor, vybaví spätné volanie a správne použije pauzu a návrat.
- Vedúci vie vysvetliť aj nastaviť vzťah číslo–plán–skupina–operátor a overiť výsledok po uložení.
- Pri postupnom zvonení, čakárni a pauze text neobsahuje neoverené časové sľuby.
- Návod rozlišuje automatické uloženie existujúceho prípadu od výslovného uloženia novej karty, úlohy a osobnej poznámky. Prípravu fakturácie nezamieňa za vystavenie faktúry.
- Screenshoty zodpovedajú označenej verzii, majú čitateľné detaily a neobsahujú reálne osobné údaje či prístupy.
- Vyhľadávanie a odkazy na konkrétne kroky fungujú v samostatnom aj integrovanom vydaní.
- Otvorenie návodu počas práce a návrat z neho sú overené na počítači aj v mobilnom/PWA scenári.
- Je určené, kto pri zmene aplikácie aktualizuje dotknutú kapitolu, screenshot a dátum overenia.
- Obsah má samostatne zrozumiteľné postupy s trvalými identifikátormi a textovými popismi obrázkov; príklady sú označené. Budúci chatbot môže citovať rovnaký zdroj ako HTML návod.

## 12. Príprava pre budúceho AI pomocníka

### Čo má vedieť používateľovi pomôcť zistiť

Pomocník bude viesť bežný rozhovor po slovensky, vysvetľovať pojmy, klásť krátke doplňujúce otázky a odkazovať na správne postupy. Pri viacerých linkách sa napríklad najprv opýta, ktorú používateľ myslí. Vie vysvetliť aj odporučiť ručný postup; nastavenia, dostupnosť ani hovory sám nezmení.

| Príklad otázky | Potrebný zdroj a spôsob odpovede |
| --- | --- |
| „Ako vytvorím ďalší krok zvonenia?“ | Návod: stručné kroky, odkaz do kapitoly a screenshot so správnym zvýraznením. |
| „Komu dnes zvoní hlavná linka a ako dlho?“ | Aktuálne uložené nastavenia zvolenej linky, jej plán/skupiny, pracovný čas a pravidlá. Rozlíšiť nastavené poradie od toho, kto je práve dostupný. |
| „Čo sa stane, keď nikto nezdvihne?“ | Konkrétny plán a jeho nadväzujúce riešenie; vysvetlenie čakárne alebo spätného volania s odkazom na príslušný postup. |
| „Čo sa stane, keď si teraz dám pauzu?“ | Nastavenie zastupovania a relevantné pravidlá. Ak chýba stav kolegu, povedať, že jeho aktuálnu dostupnosť nepozná. |
| „Prečo mi práve teraz nezvoní telefón?“ | Okrem dokumentácie aj autorizovaný stav vlastnej dostupnosti a pripojenia. Pri nedostatku údajov navrhnúť kontrolu a nepovažovať možnú príčinu za potvrdenú. |
| „Nastav mi druhý krok na 30 sekúnd.“ | Vysvetliť, kde používateľ zmenu vykoná a čo ovplyvní. Odpoveď nesmie tvrdiť, že chatbot hodnotu uložil. |

### Tri druhy informácií

1. **Dokumentácia:** ako aplikácia funguje a aké sú postupy. Spoločný obsah s HTML príručkou, s verziou, dátumom overenia a odkazmi na kapitoly.
2. **Uložené nastavenia organizácie:** čo má konkrétna linka, plán, skupina a operátor nastavené. Načítajú sa podľa potreby cez server; hodnoty sa neodhadujú z textu návodu, screenshotu ani minulého rozhovoru.
3. **Prevádzkový stav:** kto je teraz dostupný, na pauze či na hovore a čo je známe o jeho pripojení. Je to samostatný, rýchlo sa meniaci zdroj. Nové načítanie starého záznamu neznamená čerstvé pozorovanie.

Odpoveď má zrozumiteľne rozlíšiť „podľa návodu“, „podľa uložených nastavení načítaných o …“ a „podľa stavu pozorovaného o …“. Aktuálnosť sa označí v čase zrozumiteľnom používateľovi. Bez dostupného oprávneného čítania sa poskytne všeobecný postup a pomenuje sa, čo sa nedalo overiť.

### Ako pripravovať obsah už pri tvorbe návodu

Každý postup bude samostatne pochopiteľná jednotka. Výklad nesmie závisieť od toho, že čitateľ alebo AI videli tri predchádzajúce kapitoly. Potrebné predpoklady sa stručne uvedú a odkážu.

| Údaj pri postupe | Na čo poslúži |
| --- | --- |
| ID, názov, stručný účel a URL | Vyhľadanie odpovede a presná citácia. |
| Oblasť, súvisiace pojmy a synonymá | Nájdenie podľa prirodzenej otázky: „pauza“, „prestávka“, „zastupovanie“. |
| Cieľová rola, predpoklady a závislé funkcie | Vysvetlenie, prečo používateľ niečo nevidí alebo nemôže vykonať. |
| Kroky, očakávaný výsledok, výnimky a súvisiace postupy | Konzistentná odpoveď aj pri doplňujúcich otázkach. |
| Verzia aplikácie, revízia obsahu a dátum overenia | Výber správnej verzie a upozornenie na prípadný nesúlad s nasadením. |
| ID obrázka, ID zvýraznenia a textový popis prvku | Odkaz priamo na vysvetlený ovládací prvok, bez potreby čítať text iba z obrázka. |
| Označenie ukážkových hodnôt | Tréningový čas alebo fiktívna skupina sa nesmú vydávať za skutočné nastavenie klienta. |

Pri zostavení príručky sa vytvorí aj export týchto jednotiek a vyhľadávací index. Konkrétny spôsob AI vyhľadávania sa vyberie podľa veľkosti obsahu pri realizácii; teraz netreba zavádzať vektorovú databázu ani vyberať poskytovateľa modelu. Živé nastavenia a stav používateľov nepatria do verejného exportu ani do statického indexu dokumentácie.

### Čítanie údajov cez aplikáciu

Návrh toku: otázka → serverové overenie používateľa → výber relevantného postupu a potrebných údajov → vysvetlenie s odkazmi a časom overenia. Rozhovor môže poznať otvorenú kapitolu alebo vybranú linku, ale identifikátory z prehliadača sa na serveri vždy overia.

Budúci chatbot dostane len úzko určené čítacie možnosti: vyhľadať postup, načítať povolený výrez nastavení linky a prípadne načítať povolený prevádzkový stav. Nedostane všeobecný SQL prístup, ľubovoľné URL ani nástroje na ukladanie konfigurácie, vytáčanie, SMS, generovanie hlášok alebo zmenu dostupnosti. Obmedzenie bude v serverovom rozhraní, nielen v pokyne pre model. Čítací nástroj nesmie pri odpovedi spúšťať obnovu spojenia alebo opravovať stav.

Konkrétny nález v aktuálnej aplikácii: `GET /api/telephony/calls/active` okrem čítania volá `maybeSweep`, ktoré môže posunúť stav hovoru a vyvolať ďalšie telefónne akcie. Preto samotné povolenie metódy GET nie je zárukou čítania bez zmien. Pre chat sa navrhne samostatný overený čítací adaptér nad potrebnými službami; existujúci prevádzkový endpoint sa mu priamo nesprístupní.

Existujúce čítanie konfigurácie už rozlišuje role. Budúca vrstva pre AI má použiť rovnaké pravidlá a pripraviť menší výrez potrebný pre otázku. Aj z údajov viditeľných administrátorovi vynechá prístupové údaje, identifikátory prihlasovania telefónu a iné nepotrebné technické polia. Na vysvetlenie poradia zvyčajne stačí názov linky, skupiny, člen a čas; celé osobné telefónne číslo sa poskytne len vtedy, keď je potrebné a používateľ ho smie vidieť.

Základnú konfiguráciu dnes čítajú všetky štyri aplikačné roly. Podrobné nastavenia a zariadenia iných operátorov aj organizačné limity patria manažérovi/adminovi; vyhradené organizačné prepínače adminovi. Dispečer číta podrobnosti vlastného telefónu. AI nesmie z obmedzeného výrezu usudzovať, že skryté nastavenie neexistuje alebo je vypnuté.

Organizácia a oprávnenia sa odvodia z prihlásenej relácie a skontrolujú pri každom čítaní. Staršia odpoveď, zdieľaná vyrovnávacia pamäť ani zmena roly nesmú sprístupniť údaje iného používateľa alebo organizácie. Rozhovor sa po odhlásení nesprístupní ďalšiemu používateľovi. Do modelu a technických záznamov sa posiela len potrebný obsah; pravidlá uchovania rozhovoru sa určia pred zapojením živých údajov.

Názvy skupín, texty hlášok, vyhľadané dokumenty a správy používateľa sa berú ako obsah na vysvetlenie, nie ako oprávnenie meniť pravidlá prístupu či spúšťať ďalšie akcie. Výber konkrétneho poskytovateľa AI a jeho nastavení je samostatnou implementačnou voľbou.

### Vysvetlenie skutočného smerovania

Z uloženého plánu sa dá vysvetliť nastavené poradie, nie s istotou sľúbiť, ktorý telefón zazvoní práve teraz. Účinný výsledok môže závisieť od otváracích hodín a časového pásma, sviatkov, voľby v IVR, aktívnosti skupiny, dostupnosti a zariadenia operátora, zastupovania, kapacity a prevádzkových prepínačov.

Pred budúcou odpoveďou typu „takto by sa smeroval nový hovor“ má server zostaviť overiteľný výklad z existujúcich pravidiel aplikácie, bez založenia hovoru a bez vedľajších účinkov. AI tento výsledok preloží do bežnej reči. Nebude nezávisle napodobňovať telefónny systém iba podľa voľného textu návodu. Ak časť podmienok chýba, odpoveď bude podmienená. Už prebiehajúci hovor môže používať staršiu konfiguráciu než nový hovor.

Výrez nastavení dostane identifikáciu prostredia/linky, čas načítania a príslušné revízie zdrojov; pri spojení viacerých čítaní sa musí zistiť, či sa nastavenia medzičasom nezmenili. Existujúce `routingVersion` nie je spoločnou revíziou všetkých telefónnych údajov a dnešný konfiguračný dokument nie je transakčnou snímkou celej prevádzky. Prevádzkový stav dostane aj čas posledného pozorovania. Pri nedostupnosti alebo neaktuálnych dátach sa nesmie tvrdiť, že všetko je v poriadku. Pri otázke na aktuálny stav sa údaje obnovia, nepreberú sa automaticky zo staršej odpovede.

Pri konkrétnom zistení pomocník zobrazí odkaz alebo navigačnú cestu do príslušného nastavenia a súvisiaci krok návodu. Potvrdené údaje a odvodený záver sa v odpovedi odlíšia. Napríklad uložené povolenie volania samo osebe nepotvrdzuje funkčné volanie, keďže účinné povolenie závisí aj od konfigurácie nasadenia.

### Umiestnenie a postupné sprístupnenie

- V HTML návode neskôr ponúknuť **Opýtať sa k tomuto postupu**. Otvorená kapitola pomôže nadviazať rozhovor a odpoveď odkáže späť na konkrétny krok.
- V aplikácii môže pomocník fungovať v bočnom paneli nad existujúcou pracovnou obrazovkou. Jeho otvorenie nesmie odmontovať telefón ani rozpracovaný prípad. Panel nesmie automaticky aktivovať mikrofón.
- Samostatná príručka bez prihlásenia vysvetľuje dokumentáciu. Prístup k aktuálnemu stavu organizácie vyžaduje autorizované spojenie s aplikáciou.
- **Prvá etapa AI:** otázky nad návodom, doplňujúce otázky a overiteľné odkazy na text a screenshoty.
- **Druhá etapa AI:** čítanie aktuálne uložených nastavení pre oprávneného používateľa, s označením zdroja a aktuálnosti.
- **Tretia etapa AI:** vysvetľovanie dostupnosti a ďalšieho prevádzkového stavu cez overené čítacie rozhrania. Zostáva bez vykonávania zmien.

### Podmienky budúceho odovzdania AI funkcie

Overiť otázky na konkrétnu aj neurčenú linku, rozdiel dokumentácie a živých hodnôt, zmenu nastavení počas rozhovoru, starý stav zariadenia, chýbajúci prístup a výpadok zdroja. Skontrolovať oddelenie rolí a organizácií, odhlásenie aj odobratie oprávnení. Skúsiť požiadavku na zmenu nastavenia a zavádzajúci pokyn vložený do názvu skupiny: nesmie sa vykonať žiadna prevádzková zmena ani sprístupniť ďalší údaj. Odpovede musia odkazovať na skutočne použité zdroje; ak odpoveď nemožno podložiť, pomocník sa dopýta alebo prizná chýbajúce informácie.

Tieto kritériá patria k budúcemu chatbotu. Prvá implementácia dodáva príručku a export dokumentácie, bez pripojenia AI modelu a bez čítania živých nastavení pre AI.

## Podklady v repozitári

- [Navigácia, účet a pracovná konzola](../src/components/dispatch/DispatchConsole.tsx).
- [Prihlásenie a načítanie aplikácie](../src/app/page.tsx).
- [Nastavenia a ich sekcie](../src/components/dispatch/IntegrationSettings.tsx).
- [Záložky telefonovania a obmedzenia podľa roly](../src/components/dispatch/settings/TelephonyConfigPanel.tsx).
- [Výklad časov skupín](../src/components/dispatch/settings/ring-groups-model.ts) a [výklad plánov](../src/components/dispatch/settings/ring-plan-model.ts).
- [Smerovanie plánu](../src/server/telephony/routing/ring-plan.ts) a [dostupnosť operátora](../src/server/telephony/routing/eligibility.ts).
- [Dialóg pauzy](../src/components/dispatch/PauseRoutingDialog.tsx), [Môj telefón](../src/components/dispatch/MyPhonePanel.tsx) a [pripomienka pauzy](../src/lib/telephony/pause-ending.ts).
- [Čakáreň](../src/components/dispatch/CallQueuePanel.tsx) a [spätné hovory](../src/components/dispatch/CallbackQueuePanel.tsx).
- [Existujúce izolované scény konzoly](../e2e/workspace-v3.spec.ts), [prichádzajúcich hovorov](../e2e/incoming-call-overview.spec.ts) a [spätných hovorov](../e2e/callback-queue.spec.ts).
- [HTTP nastavenia a obmedzenie iframe](../next.config.ts).
- [Čítanie konfigurácie podľa roly](../src/server/telephony/config-route.ts), [tvar konfiguračného dokumentu](../src/server/telephony/config-service.ts) a [overenie používateľa](../src/server/api-auth.ts).
- [Prevádzkové načítanie hovorov s údržbou stavu](../src/app/api/telephony/calls/active/route.ts) a [účinné prevádzkové nastavenia telefonovania](../src/server/telephony/runtime.ts).

Pri posúdení integrácie boli prečítané aj lokálne príručky dodanej verzie Next.js v `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` a `05-server-and-client-components.md`.
