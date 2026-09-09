# Plán prípravy testovania dispečingu

Návrh z 9. septembra 2026. Cieľom je pripraviť zrozumiteľné testovanie celej aplikácie: najprv s interným tímom, následne s klientom. Tento dokument navrhuje rozsah, postup tvorby scenárov a spôsob evidencie. Kompletné scenáre ani testovacia webová aplikácia ešte nevznikajú.

Podkladom je aktuálny `origin/dev` na commite `b02ee1996f391b19400c75eca65040c91117afec`, overený oproti vzdialenej vetve, existujúce testy, prevádzková dokumentácia a zápisky zo stretnutia 4. septembra. Zdrojový kód obsahuje osem hlavných navigačných pohľadov a 133 API route súborov; tieto počty sú pomôckou pri kontrole inventára, nie počtom budúcich používateľských testov. Staršie dokumenty o deme nebudú určovať aktuálny rozsah. Kontrola kódu sama nepotvrdzuje, že je funkcia zapnutá a prevádzkovo overená.

Základom bude **jeden spoločný katalóg scenárov, dve úrovne rozsahu a samostatné výsledky interného a klientského testovania**. Interné testovanie a klientská akceptácia sú dve etapy. Základná a kompletná sada sa používajú v oboch etapách.

| Úroveň | Čo má overiť | Navrhovaný rozsah |
| --- | --- | --- |
| **1 – Základ** | Dá sa spoľahlivo zvládnuť bežný pracovný deň a nedôjde pri základných činnostiach ku kritickej chybe? | Približne 30–40 krátkych scenárov ako pracovný odhad. Hlavné používateľské postupy, uloženie dát, základné oprávnenia, mobil a najdôležitejšie chybové situácie. |
| **2 – Kompletné** | Je pokrytá každá funkcia dohodnutého vydania a jej podstatné varianty? | Celá úroveň 1 plus ostatné funkcie, stavy, roly, konfigurácie, súbeh, výpadky a technické overenie. Počet určí inventár, nie vopred zvolené číslo. |

Úroveň 2 zahŕňa úroveň 1 odkazom na rovnaké scenáre. Nevytvoríme druhú kópiu rovnakých testov. Úroveň 1 nebude iba skúšaním ideálneho priebehu: neuložený prípad, neoprávnený prístup alebo automatické zvonenie počas pauzy patria medzi základné riziká.

| Kto testuje | Základ | Kompletné |
| --- | --- | --- |
| **Interný tím** | Vývojári a kolegovia prejdú bežnú prácu v rolách dispečera, kolegu a volajúceho. | Celý dohodnutý funkčný rozsah; navyše databáza, oprávnenia, výpadky, súbežné akcie, integrácie a návrat nasadenia. |
| **Klient** | Dispečeri a vedúci overia, že zvládnu svoju každodennú prácu bez vedenia vývojárom. | Všetky dohodnuté používateľské funkcie podľa príslušných rolí a miestnej konfigurácie. Interné technické testy budú doloženým podkladom; klient ich nemusí technicky vykonávať znova. |

Odporúčané poradie je **interný základ → opravy a opakovanie → interné kompletné testovanie → klientský základ → klientské kompletné overenie → akceptácia vydania**. Chyby sa opravujú a overujú priebežne. Výsledky interného kola sa automaticky neprekopírujú ako klientovo schválenie.

Scenáre budeme stavať okolo skutočnej práce. Príklad väzby, ktorú musí katalóg pokryť: dispečer začne prácu, prijme hovor, založí a doplní prípad, získa miesto incidentu, vyberie kapacitu, pridelí úlohu kolegovi, kolega dostane upozornenie a zásah sa po vybavení správne uzavrie. Zhodovať sa musia karta prípadu, úlohy, história komunikácie, flotila a report. Samostatné overenie tlačidiel túto väzbu nenahradí.

Nasledujúce celky sú mapa budúceho katalógu. Stĺpce pomenúvajú oblasti pokrytia, nejde ešte o hotové scenáre s krokmi.

| Celok | Úroveň 1 – základ | Úroveň 2 – doplnenie úplného rozsahu |
| --- | --- | --- |
| **1. Prihlásenie, účty a roly** | Prihlásenie, chybné údaje, odhlásenie, návrat na chránenú stránku; bežný používateľ sa nedostane k správe účtov. | Pozvánky, prvé heslo, obnova hesla, expirované odkazy, deaktivácia, zmena roly, viac zariadení a relácií; serverové oprávnenia a oddelenie organizácií. |
| **2. Pracovisko a ovládanie** | Nástenka, zoznam a detail prípadu, prepínanie modulov, vyhľadávanie, základné filtre, ochrana rozpísaných údajov. | Pripnutá navigácia, šírky panelov, malé okná, klávesnica, dialógy, stránkovanie, prázdne/chybové stavy, obnova stránky, prechod z notifikácie počas editácie. |
| **3. Prípady a ukončenie zásahu** | Ručný prípad aj prípad z hovoru; vytvorenie, uloženie, úprava, zodpovedný operátor, poznámka, zmena stavu, dohľadanie a uzavretie. | Všetky typy zákazníkov/služieb, kontaktné roly, vozidlo a incident, náhradné vozidlo, prílohy, platobná evidencia, fakturačný podklad, história zmien, zrušený/odmietnutý/marný výjazd; dohoda o PDF/exporte. |
| **4. Úlohy a odovzdanie práce** | Úloha s prípadom aj bez prípadu, priradenie kolegovi, termín, úprava a dokončenie; vlastné a tímové zobrazenie. | Priorita, poznámky, prepriradenie, zmazanie, zmena stavu, po termíne, odovzdanie, hromadenie úloh, filtre a stránkovanie; súbeh zmien a väzba na callback. |
| **5. Upozornenia** | Upozornenie správnemu riešiteľovi, otvorenie správnej úlohy/prípadu, označenie ako prečítané; mobilné doručenie v schválenom režime. | Pripomienky, odloženie, archív, súkromné/tímové zobrazenie, jednotlivé push kategórie, zvuk, zamietnuté povolenie, vypnutie na jednom zariadení, odhlásenie a zmena účtu; e-mailový kanál, ak je v rozsahu vydania. |
| **6. Hovory, čakáreň a pauzy** | Prijať aj uskutočniť hovor, obojsmerný zvuk, ukončiť, vidieť pravdivú čakáreň; pauza pred/počas zvonenia aj posledného online operátora; vedomé prevzatie a návrat na pauzu. | Podržanie, parkovanie, konzultácia, priame/dohodnuté prepojenie, interný hovor, konferencia, odchod/odobratie účastníka, stlmenie, dozor podľa roly; smerovanie, osobný mobil verzus nezávislá záloha, štyri súčasné hovory a obnova po výpadku. |
| **7. Callbacky a história komunikácie** | Zmeškaný hovor vytvorí požiadavku; úspešný kontakt ju vybaví; ďalší nový zmeškaný hovor je nová požiadavka. | Ručné naplánovanie, claim, zrušenie, ručné vybavenie, dve zobrazenia tej istej fronty; rovnaké číslo na inej linke/prípade, neúspešný kontakt, oneskorené dôkazy, súbeh operátorov a staršie úlohy. |
| **8. SMS a poloha zákazníka** | Napísať SMS, skontrolovať príjemcu a text, odoslať, vidieť výsledok; zákazník otvorí lokalizačný odkaz a dispečer vedome použije jeho polohu. | Všetky šablóny, správa bez prípadu, úprava textu, diakritika/dĺžka, zmena kontaktu po náhľade, dvojklik a neisté odoslanie; história/doručenky, expirácia a opakovanie odkazu, zamietnutá GPS; príjem a priradenie SMS podľa dostupnosti tejto schopnosti. |
| **9. Mapy a plánovanie výjazdu** | Miesto zásahu, cieľ, vyhľadanie adresy, zobrazenie trasy, km/ETA a výber vhodnej kapacity. | Ručná poloha, prepočet pri zmene údajov, zdroje vozidiel, vrstvy/filtre, zastaraná GPS, nedostupná mapa alebo trasa, náhradný výpočet a označenie odhadu/cenového kontextu. |
| **10. Vozidlo zákazníka a dohľadanie údajov** | Ručné EČV/VIN a údaje vozidla sa správne uložia; dohľadanie nenahradí nesprávne ručné údaje. | Slovenské/zahraničné/neúplné/neznáme údaje, jednotlivé zdroje, poistné a technické údaje podľa dostupnosti, čas čakania, chyba zdroja, čiastočný výsledok a potvrdenie prevzatia do prípadu. |
| **11. Flotila a kapacity** | Dohľadať odťahovku/náhradné vozidlo, rozlíšiť dostupnosť a obsadenosť, priradiť techniku k správnemu prípadu. | Vytvorenie/úprava, pobočka, vodič, doklady, kategórie a schopnosti, rezervácia/prenájom/servis/offline, obsadenosť v čase; zdroj údajov, párovanie, zastarané alebo neoverené údaje a konflikt dvoch priradení. |
| **12. Adresár, asistencie a pobočky** | Vyhľadať firmu/asistenciu/osobu/pobočku, použiť správny kontakt a číslo; dispečer a správca majú primerané možnosti. | Vytvorenie/úprava, prepojenie kontaktov, archivácia/obnova tam, kde existuje, import asistencií, podobné záznamy, súbežná editácia, čiastočne úspešné uloženie a zachovanie histórie polohy. |
| **13. Nahrávky, prepisy a kvalita** | Ak sú súčasťou vydania: oznámenie, pravdivý stav nahrávania, zastavenie a prístup iba oprávnenej osobe. | Segmenty/medzery, prehrávanie, prepis a jeho oprava, AI návrh a ľudská kontrola, schválené vlastné hodnotenie a námietka; súkromná konzultácia, oprávnenia, retencia, odstránenie, neúplný zdroj a zlyhané spracovanie. |
| **14. Dochádzka a smeny** | Vlastná dochádzka, začiatok/koniec evidovanej práce a zobrazenie pridelenej smeny; odlíšiť dochádzku od telefónnej dostupnosti. | Koncept/publikovanie/potvrdenie/odmietnutie smien, kopírovanie a hromadný plán, žiadosti a schvaľovanie, konflikty, víkend, nočná smena, prelom dátumu a letný/zimný čas. |
| **15. Reporty a wallboard** | Súhrn hovorov, prípadov a úloh zodpovedá malému známemu súboru testovacích dát; zobrazenie rešpektuje rolu. | Dnes/7/30 dní, všetky dostupné pohľady a filtre, operátori a kvalita, časové hranice, prázdne/čiastočné údaje, obnova a aktualizácia nástenného prehľadu. |
| **16. Nastavenia, mobil a prevádzka** | Základná práca na dohodnutom PC a fyzickom mobile/PWA; mikrofón a potrebné povolenia, použiteľné formuláre; linky majú známu testovaciu konfiguráciu. | Čísla, IVR, hlášky/jazyky, pracovný čas, skupiny/plány, dôvody pauzy, osobné nastavenia a oprávnenia; PWA aktualizácia, pozadie/zámok obrazovky, viac kariet, prepnutie siete; interné overenie integrácií, výkonu, databázy a nasadenia. |

Mobil, oprávnenia a zlyhanie uloženia sa pritom overia naprieč príslušnými celkami; neostanú iba v poslednom riadku. Funkcia sa bude v inventári evidovať raz a scenáre na ňu budú odkazovať aj pri spoločnom pracovnom postupe.

Pri tvorbe katalógu použijeme tieto pravidlá pokrytia:

- **Inventár bude mať zdroj.** Každá funkcia bude priradená k obrazovke/akcii, požiadavke zo stretnutia alebo dohodnutému procesu. Kontrola API, dátových entít a existujúcich testov pomôže odhaliť funkcie mimo hlavnej navigácie. Existencia endpointu sama nie je používateľská požiadavka.
- **Očakávanie nebude iba opis dnešného kódu.** Zapíšeme, čo má používateľ dosiahnuť. Rozpor medzi požiadavkou a implementáciou ostane viditeľnou medzerou.
- **Varianty budú systematické.** Pre každý relevantný celok preveríme bežný priebeh, neplatný/neúplný vstup, hranicu hodnoty alebo času, zrušenie a opakovanie akcie, oprávnenia, súbeh a zlyhanie závislosti.
- **Stavy budú mať prechody.** Pri prípadoch, úlohách, hovoroch, pauzách, smenách a správach určíme prípustné aj neprípustné zmeny; nezostaneme pri teste ich zobrazenia.
- **Existujúce overenie využijeme.** Už pripravené PA/PU/RC/CB/MG/QA scenáre, automatické testy a PostgreSQL dôkazy pripojíme k príslušným funkciám. Rovnaký technický test nebudeme znova vymýšľať; reálnu skúsenosť používateľa ani zvuk nenahradíme simuláciou.

Úplné pokrytie funkcií neznamená prejsť každú možnú kombináciu všetkých nastavení. Riziká a testovacie techniky pomáhajú vybrať podstatné prípady; tento postup zodpovedá princípom [ISTQB Foundation Level, v4.0.1](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf). Kritické kombinácie otestujeme výslovne. Pri menej rizikových kombináciách roly, zariadenia a vstupov použijeme vyvážený výber dvojíc faktorov; nie každá kombinácia vyžaduje nový plný scenár. Kombinatorický prístup opisuje [NIST](https://www.nist.gov/publications/combinatorial-testing); nie je zárukou odhalenia každej chyby.

Pred písaním očakávaných výsledkov musíme spracovať aj otvorené rozhodnutia:

| Téma | Ako sa premietne do prípravy |
| --- | --- |
| **PDF a fakturácia** | Aktuálny `create_pdf` zaznamenáva prípravu na neskorší export; fakturačná akcia eviduje požiadavku a úlohu. Dohodnúť, či má vydanie obsahovať aj skutočný dokument/export alebo účtovnú integráciu. Ak je dokument požadovaný, samotný zápis udalosti sa nesmie akceptovať ako hotový export. |
| **Príjem SMS** | Dokumentovaný stav zo 7. septembra uvádza hotové rozhranie a backend, ale neaktívny reálny príjem bez vhodného čísla. Pred kolom overiť skutočnú konfiguráciu; odosielanie, lokalizačný odkaz a prijatie odpovede sú samostatné schopnosti. |
| **Nové rozšírenia telefonovania** | Posledný rollout z 8. septembra nechal tvorbu nových rozšírených tokov vypnutú. Pre konkrétne interné kolo treba určiť presnú verziu, nastavenia a riadený postup skúšky/aktivácie. Vypnutá potrebná funkcia nie je úspešne vykonaný test. |
| **Linky a prevádzkové pravidlá** | Potvrdiť zoznam liniek vrátane požiadavky Europe Assistance, menu, pracovné hodiny, externú zálohu, dôvody pauzy a správanie pri nedostupných operátoroch. Dohodnutú pauzu nepreklopiť automaticky na dostupnosť. |
| **Nahrávanie a roly** | Potvrdiť klientovu maticu oprávnení, oznámenia a zapnuté schopnosti. Zdroj obsahuje štyri roly a aj osobitné oprávnenia k nahrávkam; názov roly sám nemusí určovať každú akciu. |
| **Vozidlá a ďalšie témy zo stretnutia** | Dohľadanie údajov vozidiel a jeho obmedzenia patria do rozsahu dispečingu. Registrácia do ALFO ERP a samostatné obchodné témy patria do výslovného zoznamu tém mimo tejto aplikácie. Budúce návrhy, napríklad OCR tachometra, sa nezmenia bez dohody na hotové funkcie vydania. |

Žiadnu dohodnutú, ale nedokončenú funkciu neschováme označením „nevzťahuje sa“. Inventár bude rozlišovať funkciu určenú do vydania, zámerne odloženú požiadavku s rozhodnutím vlastníka a otázku, ktorú treba ešte uzavrieť. Nevyriešené očakávanie nepovažujeme za automatické povolenie aktuálneho správania.

Samotné scenáre navrhujem pripraviť v tomto poradí:

1. **Zostaviť a preveriť inventár.** Zlúčiť funkcie zo zdrojov, odstrániť duplicitné názvy, priradiť vlastníka očakávaného správania a väzbu na dohodu. Výstup: každá relevantná funkcia má miesto v niektorom celku; otázky a odložené veci sú priznané.
2. **Dohodnúť rozsah vydania a testovacie podmienky.** Určiť pracovné postupy, roly, podporované zariadenia, potrebné integrácie, testovacie dáta a konfiguráciu. Výstup: vieme rozlíšiť chybu aplikácie od nepripraveného prostredia alebo nedohodnutej požiadavky.
3. **Napísať základnú sadu.** Začať vytvorením/úpravou prípadu, úlohou a notifikáciou, celým hovorom, pauzou/callbackom, SMS/polohou a mobilným ovládaním. Doplniť zostávajúce základné celky a kritické negatívne prípady. Výstup: malá sada preverujúca bežnú prácu od začiatku do konca.
4. **Urobiť pilot zrozumiteľnosti.** Neskôr nechať jedného vývojára a jedného kolegu, ktorý scenáre nepísal, skúsiť približne 8–10 reprezentatívnych položiek. Merať skutočný čas, zaznamenať nejasné kroky a upraviť šablónu aj hodnotenie skôr, než vznikne veľký katalóg.
5. **Doplniť kompletnú sadu a maticu variantov.** Prejsť celý inventár po funkciách, stavoch a rizikách; pripojiť existujúcu automatizáciu. Výstup: ku každej funkcii dohodnutého vydania existuje overenie, vrátane funkcií nedostupných bežnému dispečerovi.
6. **Pripraviť jednoduchú evidenciu a rozdelenie práce.** Najskôr potvrdiť, že rovnaké stĺpce fungujú v malej tabuľke; následne vytvoriť webový pohľad nad katalógom a kolami. Výstup: interný tím vie začať, neskôr klient dostane vlastné kolo bez straty histórie.

Počet kompletných scenárov a čas celého testovania odhadneme po inventári a pilote. Pôvodný približne hodinový blok sa týkal úzkej telefónnej skúšky; nie je odhadom overenia celej aplikácie. Testeri dostanú menšie pracovné bloky približne na 30–45 minút, pričom koordinované hovory budú mať spoločný čas.

Každý budúci scenár musí obsahovať iba to, čo tester potrebuje: stabilné ID, zrozumiteľný názov/cieľ, celok a úroveň, rolu, predpoklady a testovacie dáta, krátke očíslované kroky, pozorovateľný očakávaný výsledok a prípadné upratanie. Väzba na požiadavku či automatický test môže zostať v rozbalenom detaile. Typicky pôjde o 3–7 krátkych krokov; dlhší postup rozdelíme tam, kde sa dá výsledok vyhodnotiť samostatne. Požiadavky na merateľné akceptačné kritériá a väzbu testu na požiadavku opisuje [ISTQB Acceptance Testing](https://istqb.org/wp-content/uploads/2024/11/ISTQB-CT-AcT_Syllabus_v1.0_2019.pdf).

Tester nemá pri bežnom výsledku vypĺňať technický protokol. V evidencii stačí výsledok a voliteľná poznámka. Pri probléme doplní, čo sa stalo oproti očakávaniu, a podľa potreby snímku alebo odkaz na chybu. Tester, čas, verzia aplikácie a história opakovaní sa doplnia automaticky. Rovnaká chyba môže mať jeden odkaz z viacerých scenárov; nevytvárame hlásenie pre každý jej prejav.

| Výsledok | Jednoduché pravidlo |
| --- | --- |
| **Neotestované** | Scenár ešte nebol vykonaný. Toto je východiskový stav. |
| **Akceptované** | Očakávaný výsledok bol overený a splnený. |
| **Akceptované s výhradou** | Funkčný cieľ je splnený, ale existuje drobný nedostatok; poznámka je povinná a výhrada má vlastníka. |
| **Neakceptované** | Očakávaný výsledok nie je splnený; zapísať pozorované správanie a chybu. |
| **Blokované** | Skúšku sa nepodarilo vykonať, napríklad chýba konto, zapnutá schopnosť alebo dostupná testovacia služba; uviesť dôvod. |
| **Nevzťahuje sa** | Položka nepatrí do schváleného rozsahu daného kola; koordinátor potvrdí dôvod. Nie je to náhrada za chýbajúcu funkciu. |

Príklad rozlíšenia: ak test overuje správnu hlášku pri zamietnutom mikrofóne a aplikácia ju zobrazí, výsledok je „Akceptované“. „Blokované“ znamená prekážku vykonania samotnej skúšky. Testovacie stavy sú naša praktická dohoda, nie tvrdenie o jednom povinnom priemyselnom názvosloví.

Pri chybe postačia tri závažnosti: **kritická** (strata dát, cudzí prístup, zásadné zlyhanie obsluhy alebo hovoru), **závažná** (funkcia neplní dohodnutý účel) a **drobná** (text, vzhľad či drobná obsluha pri splnenom cieli). Prvé dve kategórie nemožno prekryť prijatím s výhradou. Koordinátor priradí riešiteľa a termín opravy; tester po oprave zopakuje príslušnú skúšku.

Na prehľade budú stačiť štyri informácie:

- **Vykonané / plánované relevantné scenáre.** Vykonané = akceptované + s výhradou + neakceptované. Blokované a neotestované zostávajú v plánovanom počte. Koordinátorom potvrdené „nevzťahuje sa“ sa ukáže samostatne a z relevantného menovateľa sa vyradí.
- **Rozdelenie výsledkov.** Akceptované, s výhradou, neakceptované a blokované osobitne; nevyrábať spoločné zelené percento skrytím výhrad.
- **Otvorené kritické a závažné chyby.** Samostatný počet a zoznam, aby sa medzi drobnosťami nestratila prekážka nasadenia.
- **Pokrytie funkcií po celkoch.** Funkcie s pripraveným scenárom a funkcie reálne overené sú odlišné údaje. Prázdny celok nesmie vyzerať hotový preto, že zatiaľ nemá pridelené testy.

Pred začiatkom každého kola koordinátor zaznamená jeho účel, presný build/commit a URL, verziu katalógu, zapnuté funkcie, testovaciu konfiguráciu a zariadenia. Skontroluje prihlásenie, potrebné dáta, linky a prevádzku služby. Pri tejto aplikácii musí rátať s tým, že Preview a dev používajú spoločnú databázu Telnyx kópie. Bežné testy preto dostanú určené syntetické prípady/čísla; databázové poruchy, deštruktívne a objemové testy patria do izolovaného prostredia. Testovaciu tabuľku oddelíme od dát dispečingu.

Do interného kompletného overenia zaradíme aj pravdivosť uloženia po výpadku, idempotenciu opakovanej akcie, konflikty dvoch používateľov, správnosť väzieb/histórie, oprávnenia priamo na serveri, rýchlosť na reprezentatívnych objemoch, stránkovanie a databázové dotazy/indexy. Pre merania dohodneme dopredu objem, súbeh a prijateľnú odozvu; štyri telefónne hovory sú konkrétny scenár zo stretnutia, nie deklarovaná celková kapacita aplikácie. Existujúci nedokončený MG-02 s platnými vstupmi, nasadený MG-03 a telefónne QA-01 až QA-05 zostanú v pláne zachované.

Interná sada účtov bude predstavovať dvoch dispečerov, seniora, manažéra a administrátora; na oprávnenia aj neprihláseného a deaktivovaného používateľa. Ľudia môžu niektoré roly pri nekonfliktných skúškach striedať. Príprava dát bude obsahovať samoplatcu, asistenčný a firemný prípad, rôzne stavy prípadu/úlohy, rovnaké číslo v rôznych súvislostiach, viac pobočiek a kapacít, zahraničné/neznáme vozidlo a malé známe súhrny pre reporty. Súčasťou dát bude plán upratania a oddelenie podkladov jednotlivých testerov. Účty, seed ani hovory sa v tejto plánovacej úlohe nevytvárajú.

Zariadenia navrhujem pokryť pracovným Windows + Chrome/Edge, používaným Mac + Safari/Chrome, fyzickým iPhonom v Safari aj nainštalovanej PWA a fyzickým Androidom v Chrome/PWA. Konečnú podporovanú zostavu potvrdíme podľa tímu a klienta. Hlavné mobilné postupy overíme na skutočných zariadeniach vrátane klávesnice, otočenia, pozadia, zamknutia, povolení a návratu zo siete. Emulátor pokrýva časť rozloženia, nie skutočné zvonenie a systémové správanie.

Odhlásenie sa bude posudzovať aj podľa prístupu po ňom a správania uložených relácií, nie iba zmiznutia obrazovky; metodický podklad poskytuje [OWASP – Testing for Logout Functionality](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/06-Session_Management_Testing/06-Testing_for_Logout_Functionality/). Očakávanie miestneho odhlásenia verzus odhlásenia všetkých zariadení treba formulovať podľa dohodnutého produktu. Pri použiteľnosti pridáme ovládanie klávesnicou, viditeľný fokus, popisy polí, zrozumiteľné chyby a zväčšenie textu podľa úvodných kontrol [W3C WAI](https://www.w3.org/WAI/test-evaluate/preliminary/); tieto kontroly samy nie sú úplným auditom prístupnosti.

**Prechod ku klientovi** navrhujem podmieniť vykonaním všetkých relevantných interných základných testov, overením funkcií určených klientovi v kompletnej sade a odstránením kritických/závažných prekážok daného rozsahu. Potrebné bezpečnostné a prevádzkové skúšky nesmú zostať blokované. Drobné výhrady budú viditeľné s vlastníkom a termínom. Ak sa časť funkcií zámerne presunie do neskoršieho vydania, musí to byť výslovne zapísané pred klientskou akceptáciou.

**Uzavretie klientského kola** znamená vykonané dohodnuté používateľské scenáre, vyriešené kritické/závažné chyby a výslovne prijaté drobné výhrady. Koordinátor za tím a určený zástupca klienta zaznamenajú prijatie konkrétnej verzie a zostávajúce dohody. Zaškrtnutá tabuľka bez určeného rozsahu/verzie nie je potvrdenie celého produktu.

Po oprave zopakujeme chybný scenár a dotknuté väzby. Pri zmene spoločného základu, napríklad prihlasovania, uloženia prípadu či telefonovania, aj základnú sadu. Nový build nebude automaticky zelený podľa starého kola; starý výsledok ostane históriou a použiteľným podkladom. Kompletnú sadu netreba mechanicky opakovať po každej drobnej úprave, rozsah opakovania určí dosah zmeny.

Pre evidenciu odporúčam **jednoduchú súkromnú webovú tabuľku so spoločným ukladaním a exportom do CSV/Excelu**. Samostatná stránka na Verceli zodpovedá navrhnutému použitiu. Zdieľané výsledky potrebujú trvalé centrálne úložisko; ukladanie iba v jednom prehliadači neumožní spoľahlivú spoluprácu. Vercel podporuje pripojenie databáz cez svoje integrácie, takže frontend a úložisko môžu zostať oddelené. [Vercel – úložiská](https://vercel.com/docs/marketplace-storage). Konkrétnu službu a realizáciu vyberieme pri návrhu stránky, bez objednávania infraštruktúry v tomto kroku.

Na jednej stránke má tester vybrať **kolo → Základ/Kompletné → svoj celok alebo Moje testy**. Hore uvidí postup a filtre podľa výsledku, oblasti a testera. Hlavná tabuľka bude mať iba názov testu, oblasť, výsledok, poznámku/problém a testera. Klik otvorí podmienky, kroky a očakávaný výsledok. „Akceptované“ bude rýchla akcia, problém otvorí krátke doplnenie. Na mobile sa rovnaké položky zobrazia ako čitateľné karty s možnosťou prejsť na ďalší test. Stav bude mať text aj farbu.

Pre prvú verziu evidencie potrebujeme spoločné uloženie, viditeľné potvrdenie uloženia/chyby, ochranu pred tichým prepísaním kolegovej zmeny, históriu výsledkov, jednoduché prílohy/odkazy a export. Definícia scenára bude oddelená od výsledku konkrétneho kola a variantu, aby sa úpravou textu nestratilo, čo bolo v minulosti testované. Interné a klientské kolá budú oddelené. Stačia oprávnenia testera a koordinátora; klientský prístup sa obmedzí na jeho kolo a určené podklady. Testovacia stránka bude evidovať výsledky, nebude sama spúšťať operácie v dispečingu.

Rozsiahle dashboardy, vlastný projektový manažment a automatické integrácie s ďalšími nástrojmi môžu počkať, kým pilot ukáže ich potrebu. Dôležitejšie je, aby kolega bez vysvetľovania našiel test, vykonal ho, zaznamenal výsledok a ďalší človek ho videl.

Konkrétnym nasledujúcim výstupom má byť preveriteľný inventár a pilotná časť základnej sady. Až po overení ich zrozumiteľnosti sa rozpracuje kompletný katalóg a webová evidencia. Číselné odhady, navrhnuté stavy, prechodové podmienky a podoba stránky v tomto dokumente sú návrhom pre tento projekt; citované metodiky sú podkladom, nie tvrdením, že vyžadujú práve tieto voľby.

Aktualizácia realizácie: používateľ 9. 9. 2026 schválil samostatnú webovú evidenciu a výslovne zvolil vstup iba cez meno, bez prihlasovania a rolí. Preto identita ani oprávnenie koordinátora nie sú overované; mená, časy a zmeny sú tímovou históriou. Prvá verzia je popísaná v [README testovacej stránky](../apps/testovanie/README.md).
