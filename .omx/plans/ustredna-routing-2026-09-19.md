# Plán: Ústredňa, prichádzajúce hovory a automatické aktualizácie

Verzia 2.1 — vizuálne spresnenie podľa aktuálnej snímky Nástenky od používateľa. **Funkčný a architektonický plán v2: Architect APPROVE, následne nezávislý Critic APPROVE.** Táto následná vizuálna oprava nemení funkcionalitu ani nasadzovací postup a nepredstiera nové úplné kolo RALPLAN. Podklad auditu: kód `7627d35`, meeting a upresnenia používateľa do 19. 9. 2026; autoritou pre požadovaný vzhľad je nová používateľova snímka, nie starý obrázok návodu. **Výstup je plán; implementácia a nasadenie čakajú na neskoršie poverenie.** Konkrétna živá konfigurácia ani stav migrácií nie sú overené.

## 1. Odporúčanie a presný rozsah

Prepracovať pracovné rozloženie **Ústredne v štýle existujúcej Nástenky**. Skupiny a Plány zvonenia spojiť do jednej oblasti **Prichádzajúce hovory**, kde sa pri každom kroku nastavuje kto, ako a ako dlho zvoní. Nad tým zobrazovať jednoduchý slovný opis účinných pravidiel. Automatické aktualizácie a prítomnosť v karte realizovať ako ďalšie samostatné etapy, aby neblokovali prioritnú čakáreň.

**Hranica, na ktorej používateľ trvá:** zmenšenie vytáčania a odstránenie duplicitnej dostupnosti/pauzy sa týkajú iba obsahu Ústredne. Ovládanie dostupnosti v globálnej hlavičke a telefónny widget Nástenky sa tým nemenia. Globálne sú iba výslovne označené nové lišty hovorov a indikátory frontov.

| ID / priorita | Obrazovka / presné miesto | Zadanie | Stav v kóde | Pridaná hodnota návrhu |
|---|---|---|---|---|
| U1 / prvá | Ústredňa → Živé hovory / čakáreň; globálny dropdown Hovory | Čas čakania, zostávajúci limit, nikto dostupný, eskalácia | Výpočet hotový; prenos do používaného modelu a zobrazenie chýbajú [K1] | Rovnaká informácia všade; rozlišovať prvú ponuku callbacku a konečný limit čakárne. |
| U2 / prvá | Globálny panel hovorov pod hlavičkou | Čierne lišty namiesto popupu, najviac 3 spolu, ďalšie posunom | Jedna lišta + popup, identita hovoru a akcie existujú [K2] | Vlastný hovor pripnutý v rámci troch, stabilné poradie, ďalšie N, bezpečné prijatie konkrétneho hovoru. |
| U3 / prvá | Čakáreň + akcie konkrétneho hovoru | Zreteľný počet a dostupné prevzatie; Zrušiť vedľajšie | Prevzatie aj obmedzenia existujú; výpomoc z pauzy za prepínačom [K3] | Vysvetlený dôvod nedostupnosti; managerovo ukončenie pod Viac s potvrdením. |
| U4 / ďalšia | **IBA Ústredňa → Ovládanie ústredne** | Odstrániť duplicitnú dostupnosť; kompaktné Volať/adresár | Duplicita potvrdená [K4] | Viac priestoru pre históriu; bez zásahu do widgetov Nástenky. |
| U5 / ďalšia | **IBA Ústredňa → Operátori** | Všetci kolegovia, stav a jeho trvanie, s kým hovoria, prijaté dnes | Časť dát hotová v reportoch; nie všetky dostupné dispečerovi [K5] | Jeden nízky pás, podrobnosti na vyžiadanie; žiadne nevysvetlené skóre. |
| U6 / ďalšia | **IBA Ústredňa → Prehľad hovorov** | Nižšie riadky, meno/zákazník/číslo, dátum a koniec hovoru, čitateľný prípad | História/filter/detail hotové; serverové vyhľadávanie chýba [K6] | Hľadanie v celej histórii, číslo prípadu/EČV, obdobie, stabilné stránkovanie. |
| U7 / ďalšia | Ústredňa → Spätné volania + **globálna hlavička** | Výrazný pracovný panel a trvalý počet s dropdownom | Lifecycle hotový, počet lokálny [K7] | Jeden zdroj počtu, viditeľný vlastník a vek; neúspešný pokus sa nestratí. |
| R1 / ďalšia | **IBA Ústredňa → Pravidlá pre nové hovory** | Veta, kto/kedy/ako dlho zvoní a čo potom; presný preklik | Opis plánu existuje len v nastaveniach; celý účinný súhrn/preklik chýba [K8–K10] | Vybraná linka, návratová linka, hodiny, IVR vetva; uložené pravidlá oddelené od živého priebehu. |
| R2 / ďalšia | Nastavenia → Telefonovanie → **Prichádzajúce hovory** | Spojiť Skupiny a Plány zvonenia | Oba editory hotové oddelene [K8–K9] | Lineárne kroky s členmi priamo pri kroku, vysvetlené časy, spoločný draft a jedno uloženie. |
| A1 / samostatná etapa | Zoznamy a detaily prípadov, úloh, komentárov, notifikácie | Automaticky zobrazovať uložené zmeny | Úlohy/poznámky/telefonovanie čiastočne hotové [K11] | Spoločné doručovanie zmien, návrat po výpadku, zachovanie rozpracovaného textu. |
| A2 / po A1 | Nástenka → nový formulár/detail; zoznamy Nástenka/Prípady | Kolega vidí vytváranie/úpravu karty | Autosave a konflikty hotové; prítomnosť a draft položka chýbajú [K12] | Meno autora a krátko platná aktivita; uloženie/zrušenie/odchod upracú indikátor. |

„Hotové“ tu znamená nájdené v zdrojoch. Nie je to tvrdenie o nasadení, funkčnom prepínači alebo úspechu reálnych telefonátov. Presný pôvod poznatkov: [audit meetingu](../../.context/meeting-backlog-2026-09-19.md), [upresnený koncept](../../.context/meeting-koncept-v2.md), [audit nastavení](../../.context/routing-settings-audit.md).

### Odložené a hranice

| Vec | Rozhodnutie |
|---|---|
| Zmena času ponuky callbacku „asi 30 s“ | Teraz nemeníme. Existujúcu logiku iba správne vysvetľujeme; neoverené prevádzkové časovanie nevydávame za presných 30 s. |
| Mobil mimo počítača, poradie/rýchlosť/kapacita telefonovania | Zvláštny praktický test neskôr. Regresia zmenených akcií patrí do tohto plánu, veľký kapacitný projekt nie. |
| Štatistiky bez IVR, meno firmy pri callbacku | Neskôr. |
| Prepojenie priamo z čakárne | Samostatný námet: poslať čakajúceho Petrovi bez vlastného prijatia. Dnes transfer vyžaduje talking/held [K13]; automaticky ho nezahŕňame do grafických zmien. |
| Posledné prihlásenie / odchod od počítača | Heartbeat to nedokazuje. Použiť označenie „Posledný kontakt zariadenia“; dochádzkové sledovanie nie je súčasťou. |
| Spoločné písanie každého písmena, AI dispečer, natívna aplikácia | Mimo rozsahu. Prítomnosť kolegu nie je nový zdieľaný textový editor. |

## 2. RALPLAN-DR: rozhodnutie pred kontrolou

Režim **deliberate**, neinteraktívne plánovanie. Dôvod: telefonovanie, práva, súbežné uloženie konfigurácie a možné dátové zmeny. Planner pripraví návrh, Architect posúdi architektúru, až potom Critic posúdi úplnosť; pri ITERATE sa návrh opraví a oba kroky zopakujú.

**Princípy:** (1) používateľ vždy vie, na ktorej obrazovke sa čo mení; (2) rozhranie hovorí pravdu podľa skutočného stavu a jednej autority dát; (3) jednoduché bežné ovládanie zachová všetky pokročilé možnosti; (4) zmeny nestratia hovor, draft ani cudziu úpravu; (5) malé overiteľné etapy v existujúcom štýle.

**Tri rozhodujúce dôvody:** viditeľnosť neobslúženého volajúceho; zrozumiteľnosť pre bežného správcu bez straty funkcií; zvládnuteľné riziko implementácie a nasadenia.

| Možnosť | Výhody | Nevýhody / kedy je vhodná |
|---|---|---|
| A — postupné rozšírenie existujúcej aplikácie, jeden editor skupín+plánov, samostatný operatívny súhrn **(odporúčané)** | Využije modely, validácie, styling a regresie; jedno pravdivé uloženie; rozumná cesta po PR. | Potrebuje spoločný draft, API transakciu a úzky read model; viac práce než presun tabov. |
| B — najprv iba preusporiadať existujúce panely; skupiny a plány v jednej oblasti so samostatným ukladaním | Najmenšia úvodná serverová zmena; použiteľné pri veľmi krátkom termíne; nezavádza nové RPC, ak je nasadenie nejasné. | Dve uloženia a medzistav sa musia používateľovi vysvetliť; draft sa musí aj tak ochrániť; dlhšie zachová zložité mentálne rozdelenie. |

B je funkčná lacnejšia alternatíva, ale horšie plní požiadavku jednoduchého nastavovania. Voľný grafický editor s kreslením spojníc nepridáva potrebnú hodnotu: komplikoval by klávesnicu, mobil aj výklad; preto nie je odporúčaný tretí projekt.

## 3. Vzhľad a usporiadanie podľa Nástenky

**Autoritatívna vizuálna referencia:** [aktuálna Nástenka zo snímky používateľa](../../.context/attachments/assets/a5ed044f-b7e9-4b0a-b865-591acecb0f65/image.png). Bola priamo prehliadnutá. Má **svetlú hlavičku**, chladné svetlosivé až modrosivé pracovné pozadie, navigáciu zoskupenú do zaobleného pásu, biele panely s jemnými okrajmi a žlté akcenty. Žltá značka PM a identita pracoviska sú vľavo, navigácia v strede, registrácia/dostupnosť a pracovné akcie vpravo. Tieto rozpoznateľné prvky treba zachovať pri priblížení Ústredne aktuálnej Nástenke.

Skorší prototyp nesprávne vychádzal z čiernej hlavičky na `public/guide-assets/overview.webp`. Tento obrázok z návodu ani starší snapshot komponentu **nie sú autoritou pre aktuálny požadovaný vzhľad**. Snímka používateľa túto časť referencie nahrádza; mapa, nástroje a rozloženie samotnej Nástenky sa tým neprepracúvajú.

**Návrhové tokeny:** biele panely a svetlá hlavička približne `#FFFFFF`/`#FAFBFF`, pracovná plocha približne `#EFF2F7`, jemné modrosivé okraje približne `#DFE3EC`, tmavý text `#292D38`, sekundárny text `#687186`, hlavná žltá `#FCD703`. Sú to aproximácie vizuálnej referencie, nie tvrdenie o odčítaných produkčných CSS hodnotách. **Čierna patrí skutočnej lište prebiehajúceho/prichádzajúceho hovoru; nepatrí celému vrchu aplikácie.** V stave bez hovoru sa panel líšt nezobrazuje a nezaberá prázdne miesto. Menšie tmavé akcie môžu zostať tam, kde ich má existujúce rozhranie.

Používateľ doplnil **fonty a jemný „Apple vibe“**. Preto ponechať platformové systémové písmo s poradím `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`, kompaktný základ 13 px, hlavné údaje 13–14 px, doplnkové 12 px a nadpisy panelov 14–16 px. Na Macu sa použije príslušné systémové písmo; linuxový screenshot nesmieme vydávať za renderovanie nainštalovaného San Francisca. Auditovaný `src/app/globals.css:44` už používa systémový sans-serif stack; názov písma sa zo snímky samotnej nedá spoľahlivo určiť a E0 overí aktuálne štýly. Nepridávať externé fonty ani meniť typografiu ostatných obrazoviek iba kvôli tejto ukážke.

Jemný Apple dojem má znamenať čistú typografickú hierarchiu, presné zarovnanie, zaoblenú skupinovú navigáciu, mäkké biele panely a veľmi jemný tieň. Okraje 1 px, radius panelov približne 12 px a kompaktných ovládaní 6–8 px, odstupy prevažne 8/12/16 px. Zachovať žltú identitu aplikácie; nepridávať novú modrú značku, výraznú priehľadnosť, rozmazané sklá ani dramatické animácie. Bez hrubých čiernych rámov, dekoratívnych štatistických kariet či veľkých čísel okrem užitočných počtov frontov.

```text
Svetlá globálna hlavička: pracovisko | zoskupená navigácia | môj stav | fronty
Iba pri hovore: čierna lišta; max3 spolu, môj pripnutý, ďalšie posunom
Bez hovoru: žiadna čierna plocha ani prázdny priestor po lište
──────────────────── obsah Ústredne ────────────────────
Ústredňa                                  Adresár  Volať
Pravidlá pre nové hovory: linka, krátka veta, Upraviť
Operátori: meno, stav, čas, prijaté dnes; podrobnosti
História + vyhľadávanie (približne 2/3) | Spätné volania (1/3)
kompaktná tabuľka                     | vek, vlastník, akcia
```

Alternatíva s trvalým tretím stĺpcom adresára by ubrala miesto prípadu/telefónu v histórii. Preto je adresár dostupný cez kompaktný ovládací prvok. Toto preusporiadanie sa netýka mapy a nástrojov Nástenky.

**Rozmerové ciele návrhu:** desktop riadok histórie približne 44–52 px pri bežnom obsahu; dlhé mená sa môžu rozbaliť. Pri 1280×800, troch kompaktných lištách a zbalených podrobnostiach má byť viditeľné vyhľadávanie a aspoň päť riadkov. Ide o akceptačný cieľ, nie tvrdenie o dnešnej aplikácii. Pri 390 px sa plochy zložia, callbacky a čakáreň ostanú dostupné z hlavičky; celá stránka nesmie vodorovne pretekať. Mobil nemusí naraz ukazovať tri rozbalené lišty, maximum troch však stále platí.

Dôležité tlačidlá cieľovo 36 px desktop / 44 px dotyk; nikdy nezmenšovať ovládateľnosť iba kvôli hustote tabuľky. Focus viditeľný, poradie klávesnice logické, farba nie je jediný nosič stavu, pulz čakárne vypnutý pri `prefers-reduced-motion`. Časovač nečítať čítačkou každú sekundu; oznámiť zmenu stavu a prírastok čakajúceho bez presunu focusu. Dropdown sa otvorí používateľom, zatvorí Escape a vráti focus.

| Screen návrhu v2.1 | Čo na ňom posudzovať | Snímka / podklad |
|---|---|---|
| Ústredňa bez hovoru | Svetlá hlavička, žiadna čierna plocha líšt, pravidlá, tím, história a callbacky | [Ústredňa bez hovoru, 1440 px](../../.context/ustredna-light-idle-1440.png) |
| Ústredňa počas hovoru | Rovnaký svetlý obal; čierna patrí iba jednej skutočnej lište hovoru | [Ústredňa s hovorom, 1440 px](../../.context/ustredna-light-active-1440.png) |
| Nastavenia → Prichádzajúce hovory | Zjednotené kroky a tímy v rovnakom svetlom štýle; ostatné nastavenia zachované | [Nastavenia bez hovoru, 1440 px](../../.context/routing-light-idle-1440.png) |
| Aktuálna Nástenka — referencia používateľa | Autorita pre vizuálny jazyk; samotnú Nástenku tento návrh nepreusporadúva | [Používateľova snímka](../../.context/attachments/assets/a5ed044f-b7e9-4b0a-b865-591acecb0f65/image.png) |

Aktuálny samostatný prototyp: [svetlý návrh v2.1](../../.context/dispatch-plan-prototype-light/index.html). Snímky v tabuľke patria novej vizuálnej revízii; výsledok jej skutočne vykonaných kontrol je v §13. Predchádzajúce súbory `dispatch-plan-prototype/`, `ustredna-prototype-*`, `routing-prototype-*` a `waiting-prototype-*` zostávajú historickým dokladom interakcií a geometrie; **nie sú aktuálnou vizuálnou špecifikáciou**. Globálna navigácia a používateľom pripnuté položky (napríklad Úlohy) zostávajú zachované; prototypový výber položiek je reprezentatívny.

Ukážkové údaje a zjednodušené interakcie musia zostať výslovne označené. Skutočné role, vyhľadávanie na serveri a celý routing engine sa tu nesimulujú. Pravidlá max3 líšt a mobilné akceptačné ciele ostávajú v §4 a §8; vizuálna ukážka jedného hovoru ich nenahrádza.

## 4. Funkčný návrh pre Ústredňu

### 4.1 Hovory a čakáreň

- Pretiahnuť `waitingSince`, `waitingMaxMinutes`, `waitingReason`, `queueIdleSince`, `queueEscalatedAt` cez `PhoneBarCall` a `toPhoneBarCall`; používať spoločný `waitingRoomPark()`, bez druhej implementácie časov [K1]. Rozlíšiť neprijatého čakajúceho od už prijatého zaparkovaného hovoru.
- Zobraziť „Čaká 02:14“, „Do limitu čakárne 7 min“, prípadne „Nikto dostupný 4 min“ a stav eskalácie. Neoznačiť konečný limit ako prvú ponuku callbacku; tá môže zaznieť skôr. Pri chýbajúcej hodnote ukázať neznámy limit, nikdy vymyslených 30 sekúnd.
- Tray zdieľa identitu session/leg s existujúcim modelom. Obsahuje vlastný aktívny/outgoing a skutočne ponúkané neprijaté hovory; greeting/IVR nie je predstierané zvonenie. Hovor prijatý kolegom odíde z osobnej lišty a zostane viditeľný pri kolegovi; čakajúci odíde do čakárne. Vo fronte neponechať duplicitnú reprezentáciu tej istej session.
- Najviac tri viditeľné lišty **spolu**, vlastná zaberá jednu. Zvyšok v posuvnej oblasti s počtom; vlastný hovor sa neposunie mimo dohľadu. Poradie stabilné podľa začiatku ponuky+ID, bez preskakovania pri každom timer ticku.
- „Prijať“ iba presná vlastná browser invite; „Prevziať“ serverová akcia konkrétnej session. Zdieľaný bezparametrový answer handler nekopírovať do každej lišty. Pre obsadeného/offline/nedostupné audio ukázať vysvetlenie; nevypínať existujúce serverové kontroly [K2–K3].
- Výpomoc z pauzy preveriť a sprístupniť iba v kontrakte existujúceho feature gate; jednorazové prevzatie nemá meniť trvalú dostupnosť. „Mimo radu“ nie je automaticky schopný offline telefón. Ak treba najprv pripraviť telefón, viesť k tejto akcii; samostatné rozšírenie pravidiel vykonať v osobitnom PR s regresiami.
- Managerove „Ukončiť čakajúci hovor“ do sekundárneho menu, zachovať potvrdenie a existujúce práva. Nezameniť so zrušením callback požiadavky.

### 4.2 História, callbacky a tím

**História:** serverový kontrakt `q`, dátum od/do, výsledok, smer, operátor/linka, obmedzená veľkosť stránky a cursor. Text hľadá caller name, zákazníka priradeného prípadu, normalizovaný telefón; pridaná hodnota aj číslo prípadu/EČV. Presné zdroje mien a čísiel zdokumentovať pri E0; dnešný endpoint berie posledných 50 ešte pred dohľadaním väzieb [K6], preto filtrovanie až v prehliadači nestačí. Bez prípadu zostáva hovor vyhľadateľný číslom/identitou hovoru. Vyhľadávanie mena bez citlivosti na diakritiku, telefónu bez medzier; nemiešať pôvodného volajúceho a overený callback cieľ.

Pri implementácii uprednostniť serverový SQL read model/RPC nad autoritatívnymi tabuľkami s organization filtrom a overeným prístupom k prípadom; indexy len na skutočne používané query. Schema/index PR, ak potrebný, je samostatný a bez povolenia sa neaplikuje. Stránky radiť `(started_at DESC NULLS LAST, id DESC)`, explicitne riešiť null čas a rovnaké timestampy. UI zachová hľadaný text, vybrané filtre a pozíciu; nové hovory pri prezeraní staršej stránky oznámi „Nové hovory N“, nevloží riadky pod kurzor. Debounce cieľ 250–350 ms, zrušenie zastaraného requestu, prázdny/chybový/loading stav. Dátumy zobrazovať Europe/Bratislava s korektným UTC rozsahom a prechodom letného času. Stĺpce: začiatok, volajúci/číslo, výsledok, operátor, trvanie, prípad; koniec a detaily po rozbalení alebo vo voliteľnom stĺpci. Trvanie vždy pomenovať podľa zdrojového významu.

**Callbacky:** spoločný store/read model pre panel a hlavičku; počet = otvorené nevyriešené požiadavky podľa existujúceho lifecycle, nie len aktuálna stránka alebo filter. Duplicitné komponenty nesmú vytvoriť vlastné pollery. Predvolené existujúce poradie zachovať. Vidieť vek, prioritu ak existuje, vlastníka a stav riešenia. Akcia „Prevziať“ → jasný vlastník; „Zavolať“ sama o sebe neznamená vybavené. Zachovať alternatívny overený cieľ, históriu pokusov, ručné vybavenie/storno a serverovú reconciliáciu [K7].

**Tím:** úzky operatívny endpoint pre oprávnených dispečerov, nie otvorenie celého reportového API. V základnom páse meno, available/ringing/talking/paused/offline, čas v stave, Prijaté dnes; hovoriaci kolega má povolenú identitu hovoru/odkaz. V detaile čas hovoru/dostupnosti/pauzy a kontakt zariadenia s jeho skutočným významom. Ponechať offline, pri mnohých členoch rozbaliteľný úplný zoznam a vyhľadanie. Odchádzajúce doplniť samostatne až s presnou definíciou, nie zameniť za už existujúce inbound count. Nezverejňovať identifikátory zariadení ani súkromné telefónne nastavenia ostatných [K5, K10].

## 5. Jednoduché nastavenie prichádzajúcich hovorov

### 5.1 Čo používateľ uvidí

1. **Linka a situácia:** vybrať číslo/linku, prípadne „Voľba 1 v hlasovom menu“. Ukázať účinnú návratovú linku a či sú teraz otváracie hodiny. IVR, hodiny a priradenie čísla zostanú vo vlastných existujúcich editoroch s priamymi odkazmi.
2. **Jedna jednoduchá veta:** napríklad „Pri voľbe Asistencia systém skúsi dostupných členov Dispečingu naraz najviac 20 s, potom Zálohu po jednom, každého najviac 20 s. Ak nikto nezdvihne, hovor prejde do čakárne.“ Ide o modelový text, nie opis dnešnej inštalácie.
3. **Kroky 1, 2…:** viditeľní členovia/tím, Naraz alebo Postupne, presne pomenovaný čas. Pri Postupne ukázať „20 s na každého“, pri Naraz „20 s na celý krok“. Členov upravovať priamo pri kroku. Individuálne časy a poradie v rozbalení.
4. **Keď nikto nezdvihne:** všetky dnešné konce plánu a ich dôsledok; žiadny povinný zložitý diagram.
5. **Podrobnosti a uloženie:** ďalšie použitia skupiny/plánu, validácie, rozdiel proti uloženému stavu. Jedno Uložiť zmeny a Zahodiť zmeny. Automatické ukladanie smerovania sa nezavádza.

Knižnica tímov a nepoužité/IVR-only plány zostávajú dostupné v rovnakej oblasti. Vypnutie pokročilého rozbalenia nesmie zahodiť hodnotu. Tab je „Prichádzajúce hovory“, pôvodné termíny skupina/plán sú vysvetlené v pomocnom texte. Ďalšie taby (Môj telefón, IVR, hlášky, hodiny, čísla, operátori, bezpečnosť, nahrávanie) zostávajú funkčné; nevytvárať jeden gigantický formulár.

### 5.2 Matica zachovania funkcií

| Dnešná funkcia | Miesto v novom návrhu | Povinná kontrola |
|---|---|---|
| Viac skupín a plánov, názvy, poznámky, active, CRUD | Knižnica + vybraný plán | Nepoužité aj IVR-only objekty zostanú dostupné. |
| Operátor, externé číslo, osobné číslo s vlastníkom | Členovia pri kroku | Zachovať ownerProfileId, E.164, povolené ciele aj feature gate. |
| Poradie krokov a členov | Očíslované kroky a zoznam členov | Myš aj klávesnica/tlačidlá posunu; stabilné ID a história ponúk. |
| Naraz/postupne, 5–120 s, individuálne časy | Základ + rozbalené časy členov | Pri naraz override zostáva uložený, ale nepoužíva sa. |
| Callback / čakáreň / externé číslo / hláška a koniec | Keď nikto nezdvihne | Zachovať všetky štyri výsledky aj súvisiace hlášky. |
| Zdieľanie skupín/plánov | Používa sa tiež v… | Úprava oznámi dopad; nevytvorí potichu kópiu. |
| Zákaz zmazania používanej skupiny/plánu | Pri akcii s vysvetlením | Kontrola aj na serveri; neaktívna referencia sa tiež počíta. |
| Validácia, práva, verzia, audit | Pri poli + súhrn chýb + save | Žiadny zápis pri samotnej zmene vstupu; konflikt nevymaže draft. |
| Účinný náhľad a výnimky | Veta + podrobný rozpis | Zhodný význam s runtime, nie druhý nezávislý výklad. |

Zdroj inventára a riadkov jednotlivých schopností: [routing audit, Inventár funkcií](../../.context/routing-settings-audit.md). Tento inventár slúži ako regresný checklist, nie ako zoznam už implementovaných noviniek.

### 5.3 Autoritatívny súhrn a skutočný priebeh

Z existujúceho `ring-plan-model` vyčleniť opakovane použiteľné čisté funkcie do doménovej knižnice; UI a server potom zdieľajú výklad. Doplniť serverový **operatívny súhrn**: organization, identita konzistentného snapshotu, pôvodná/účinná linka, checkedAt, hodiny/timezone/ďalšia relevantná zmena, IVR vetvy, kroky a účinné limity, upozornenia a oprávnený navigation target. Do bežného klienta neposielať celý admin dokument [K8–K10]. Neznámy údaj nevyplniť predvoleným nastavením.

**Konzistentné čítanie:** dnešný `getRoutingDocument` skladá nezávislé čítania a `routingVersion` nepokrýva zápis linky ani settings [K15]. Pre combined editor aj súhrn preto použiť úzky read RPC s jedným SQL statementom nad jedným databázovým snapshotom; výsledok sa rediguje podľa role. `routingVersion` zostáva CAS verzia replace sekcií, nie univerzálna verzia celej telefónie. Snapshot má samostatný identifikátor/fingerprint z relevantných uložených údajov; dostupnosť operátorov ostáva oddelený živý stav. Nepoužiť kontrolu samotného routingVersion pred/po dnešných paralelných GET ako dôkaz konzistencie. Ak read RPC chýba, závislú novú funkciu neaktivovať pred povolenou migráciou; staré funkčné UI ostáva dostupné.

Súhrn invalidovať po zmenách groups/plans, IVR, hours, priradenia/return-line linky, relevantných settings/limitov a feature/capability stavu; obnovovať aj po reconnecte/návrate a časovom prechode hodín. Pomalá poistná kontrola, nie config fetch každú sekundu. Ak by sa nový Broadcast konfigurácie zdržal, prvá verzia môže použiť obnovenie po save a obmedzený interval so stale indikátorom. Tento fallback nemení požiadavku na koherentné čítanie a nesmie ignorovať zmenu iba linky alebo fanout limitu.

Povinne pokryť návratovú linku, chýbajúci/vypnutý plán/skupinu, IVR fallback na predvolený plán, vypnutý rozvrh = nonstop, sviatky a časové hranice, fanout/capacity, nedostupných členov. Postupné časy sa sčítajú; predstavujú nastavené maximum, nie sľúbený čas do prijatia. Eskalácia čakárne meria nepretržitú nedostupnosť, nie vek hovoru, a nesľubuje obvolanie všetkých záloh. Presné hraničné správanie je v audite, sekcia „Účinné smerovanie“.

**„Teraz“** používa session/attempt/presence a zmrazený plán konkrétneho hovoru. Ak presný ďalší pokus nie je známy, text je „Ďalší pokus závisí od dostupnosti“, nie vymyslené meno alebo presný countdown. Úprava plánov/skupín platí pre nové smerovanie; netvrdiť paušálne, že všetky runtime settings sú zmrazené.

V detaile konkrétneho hovoru ukázať „Zvoní teraz“ s oprávnenými menami a počtom ponúk; pri nezaradených členoch skutočný dôvod (obsadený, pauza, offline alebo neznáma pripravenosť), ak ho autoritatívne dáta poskytujú. Označenie „Systém ponúka hovor“ nezamieňať za overený zvuk na zariadení. Toto napĺňa otázku, komu zvoní a prečo ďalšiemu nezvoní, bez sľubu budúceho prijatia.

### 5.4 Spoločné uloženie a navigácia

Jeden vlastník draftu `groups + plans`, jedna `expectedVersion`, spoločná serverová validácia a jedna transakcia cez existujúce `motorist_replace_ring_plan`. SQL v repozitári obidve sekcie podporuje, dnešné TypeScript služby ich zapisujú samostatne [K9]. Nová spoločná route/service má explicitný allowlist polí, existujúcu CSRF/role/organization ochranu, revalidáciu referencií a serverový audit oboch sekcií. Zachovať správanie „uložené, audit sa nepodarilo zapísať“; chybu auditu nepovažovať za rollback už úspešného uloženia.

Nová skupina a krok odkazujúci na ňu v jednom save potrebujú stabilné klientské UUID overené serverom alebo jednoznačnú mapu dočasných ID pred validáciou; odporúčané stabilné UUID pre nové objekty so serverovým overením vlastníctva existujúcich ID. Neprestavovať existujúce ID členov a ich historické časové značky. Konflikt 409 zachová celý draft a zobrazí porovnanie s aktuálnou verziou; žiadne automatické prepísanie. Po úspechu aktualizovať vlastný draft bez remountu, ktorý by zmazal iné rozpracované oblasti. Odchod/prepnutie vyžaduje rozhodnutie uložiť/zahodiť/zostať iba ak sú skutočne neuložené zmeny.

Audit/diff musí patriť potvrdenému commitu daného správcu. Odporúčané je vrátiť potvrdenú verziu a normalizovaný rozdiel z transakčnej cesty; neskorší read aktuálneho dokumentu môže obsahovať ďalší commit a nesmie sa celý pripísať prvému autorovi. Rozšírenie návratového kontraktu RPC, ak potrebné, je additive migrácia s osobitným povolením. Pri timeout po možnom commite zachovať draft, označiť neistý výsledok a najprv porovnať autoritatívne uloženú verziu/obsah; neponúknuť slepé opakovanie ako nové uloženie.

Preklik nesmie smerovať len na domovskú obrazovku Nastavenia: preniesť `view=settings`, sekciu telefónie, nový tab, lineId + planId/IVR vetvu, prípadne groupId; validačne ignorovať cudzie/neexistujúce ID a vysvetliť nenájdený cieľ. Zapracovať do existujúcej navigácie aj browser back; návrat do Ústredne zachová query/filtre/scroll. Read-only používateľ má „Zobraziť nastavenie“, manažér „Upraviť“. Zmena vstupu do nastavení neukončí globálny hovor.

**Medziverzia E4a → E4b:** E4a zavedie stabilný navigation target a adapter. Pokiaľ nový editor nie je zapnutý, adapter otvorí existujúci Plány zvonenia s vybraným planId (alebo Čísla/IVR, ak tam patrí úprava); kontext linky/voľby ostáva zobrazený. Až E4b prepne ten istý target do Prichádzajúcich hovorov. Rollback prepínača použije starý adapter; žiadny odkaz nesmie smerovať na neexistujúci tab. Overiť aj otvorenú staršiu kartu klienta počas prechodu verzií.

## 6. Automatické aktualizácie a spolupráca

**A1:** nadviazať na existujúce súkromné Broadcast kanály a autoritatívne HTTP čítanie [K11]. Jedna zdieľaná subscription/store na doménu **a autorizované publikum** v karte prehliadača; nepúšťať kanál/poller pri každom badge. Notebook/notifikácie ostávajú podľa príjemcu, presence podľa prístupu ku konkrétnemu prípadu; org-wide kanál nesmie oznamovať identity súkromných zdrojov. Správy majú minimálny invalidation payload, nie text komentára alebo celý prípad. Zmeny slučovať, requesty deduplikovať, po reconnecte/focuse dorovnať snapshot. Pomalá poistná kontrola je súčasť spoľahlivosti, používateľ ju neobsluhuje.

Zoznam zdrojov zmien pri E5 zahŕňa prípady, ich udalosti/komentáre, tasks/chat, notifikácie a existujúci notebook, vrátane mazania/archivácie/zmeny práv. Všetci relevantní zapisovatelia musia invalidovať až po úspešnom commite; preferovať autorizované databázové broadcast triggery, kde môže zapisovať viac ciest. Privátne dáta musí stále filtrovať autoritatívny endpoint/RLS; oprávnenie na kanál samo nestačí. Odhlásenie, zmena organizácie alebo odobratie práv odpojí kanály, zruší requesty a vyprázdni príslušné cache; oneskorená odpoveď sa nesmie vrátiť inému používateľovi.

Čítaný detail môže aktualizovať nedotknuté polia; dirty polia zostávajú lokálne. Existujúci revision/CAS a konflikt ostávajú autoritatívne [K12]. Pri kolízii ukázať kto/čo sa zmenilo, zachovať vlastný vstup a dať možnosť porovnať; nesľubovať automatický merge každého typu dát. Vymazanie otvoreného prípadu vysvetliť a ponechať možnosť skopírovať vlastný text podľa práv. Automatická invalidácia nesmie prekresliť celý formulár alebo posunúť zoznam pod rukou.

Rutinné „Obnoviť dáta“ odstrániť až po doručení zmien + reconnect + fallback pre danú obrazovku. „Načítať staršie“ a obnova verzie aplikácie sú iné akcie; existujúca ochrana rozpracovaného textu a hovoru pri update zostáva [K11]. Pri chybe môže byť „Skúsiť znova“.

**A2:** ľahká editor presence s heartbeat napr. 15 s a TTL 60 s (návrhové hodnoty, overiť pri pilote), meno/typ aktivity/opaque draftId a minimum oprávnených metadát. Nový draft je dočasný záznam „Jana pripravuje nový prípad“, bez zavádzajúceho čísla prípadu a bez neuložených osobných údajov. Uloženie ho nahradí jedným skutočným prípadom; zrušenie, odchod, strata práv alebo TTL ho odstránia. Pre existujúci prípad viac editorov viditeľných naraz; presence nie je zámok ani dôkaz každej klávesy. Dve karty jedného používateľa deduplikovať vo vizuálnom počte, ale samostatne ukončiť sessions.

**Konkrétny mechanizmus:** serverový endpoint vytvorí/obnoví krátko žijúci lease s opaque editorSessionId; pri každom heartbeat overí actor, organization a prístup k zdroju. Meno/profileId odvodí zo session, klient ich nemôže vydávať za kolegu. Praktický základ je malá samostatná tabuľka lease (nie prípady), `expires_at` a RLS, ak túto potrebu nepokryje už existujúca služba. Čítanie ignoruje expirované položky, klient odstráni podľa expiry; obmedzené oportunistické upratanie pri bežnom zápise, žiadny nový cron. Migrácia až po výslovnom poverení. Nový draft sa oznamuje iba publiku oprávnenému na spoločný zoznam draftov/prípadov; pri zamýšľanom súkromnom prípade sa placeholder neposiela širšiemu tímu. Väzbu draftId → caseId pri uložení potvrdí autorizovaný server.

**Revokačná zmluva:** server po odobratí práv neposkytne nový obsah. Klient pri 401/403 alebo autorizačnom signále okamžite vyčistí/odpojí dotknuté dáta a zneplatní pending request generation. Privátne cache/presence majú najviac 30 s od poslednej úspešnej autorizácie; včas reautorizovať a pri uplynutí lehoty chránený obsah skryť až do úspešnej kontroly, aj pri výpadku siete. Kratšie existujúce notebook pravidlo nezhoršiť [K16]. Pri návrate z uspatej karty kontrola pred zobrazením expirovanej cache. TTL 60 s rieši opustený editor, nenahrádza túto ACL platnosť. Už raz prečítaný obsah nemožno spätne odobrať človeku; nejde o tvrdenie okamžitej detekcie revokácie bez signálu.

Nejde o dramatické spomalenie z princípu: aplikácia už polluje; cielené načítanie môže počet requestov znížiť. Konkrétny výkon je však **podmienka merania**, nie sľub. Zaviesť meranie requestov/klienta, dátového objemu, renderov, časov aktualizácie a reconnectov pred a po; nezavádzať druhú paralelnú sieťovú vrstvu k hotovým úlohám/poznámkam.

## 7. Etapy a závislosti budúcej implementácie

| Etapa / PR | Konkrétny výstup | Dotknuté oblasti | Podmienka dokončenia |
|---|---|---|---|
| E0 — vstupné overenie | Rebase návrhu na aktuálny dev v novej vetve; inventár capability/schema, zdrojov histórie, existujúcich writerov; baseline desktop/mobile a requestov. | AGENTS; K1–K14; lokálne Next docs | Presne známy rozdiel oproti auditu; neznámy schema stav sa nepovažuje za hotový. Žiadne živé zápisy v audite. |
| E1 — prioritná čakáreň | Prenos metadát a jednotný výklad čakania; viditeľný počet, dôvody prevzatia, menej dominantné ukončenie. | active-calls-model, LiveCallOverview, HeaderLiveCallsMenu, K1/K3 | AC01–03, regresia izolácie session. Môže sa dodať bez celého redesignu. |
| E2 — globálne lišty + callback store | Max3 tray a prechody; jeden callback count/panel, hlavička. Výpomoc feature gate ako samostatný malý commit/PR, ak je potrebná. | PhoneBar, useTelephony/DispatchConsole, callbacks K2/K7 | AC04–07, existujúce prijatie/hold/transfer/mute/DTMF/supervision nezhoršené. |
| E3a — údaje Ústredne | História query/paging a minimálny tímový read model; prípadné indexy/migrácia oddelene. | call-history, calls/history route, stats-derived DTO, mapCallCenterCall | AC08–10 a API/SQL isolation; funguje aj hovor bez prípadu. |
| E3b — layout Ústredne | Nástenke podobné panely, kompaktná história/tím, callback panel, adresár/Volať. | CallCenterModule + CSS, príslušné panely | AC11–12 a obrazové porovnanie, bez úpravy ostatných obsahových screenov. |
| E4a — pravdivé pravidlá | Spoločný model vysvetlenia, oprávnený summary DTO, Ústredňa + presná navigácia. | ring-plan-model, routing helpers, summary API, IntegrationSettings/DispatchConsole | AC13–15, permission matrix, všetky kontextové vetvy. |
| E4b — jeden editor | Shared draft skupiny/plány, combined validate/save service/API, jednoduché kroky+pokročilé možnosti. | TelephonyConfigPanel, RingGroupsEditor/RingPlanEditor modely, config-client/service/routes | AC16–19, reálna lokálna DB transakcia/konflikty; úplnosť zachovaných funkcií. |
| E5 — automatické aktualizácie | Doménové subscriptions, autoritatívne resync, writer coverage, odstránenie rutinného refresh postupne. | DispatchConsole, CaseDetail, task/notebook stores, príslušné API, prípadné triggery/RLS | AC20–23, dvojklientové testy a výkonové porovnanie; nezasiahnuť telephony cadence. |
| E6 — prítomnosť editora | Draft placeholder a mená editorov, uloženie/zrušenie/TTL/revokácia. | NewCaseDrawer/NewCaseForm, CaseDetail, zoznamy Nástenka/Prípady | AC24–25, žiadne duplicitné prípady ani únik neuloženého obsahu. |
| E7 — integračné prijatie | Overenie úplných tokov, krátky test s dispečermi, návod a rollout záznam. | Celok | AC26–28, všetky podmienky nasadenia splnené; otvorené limity výslovne uvedené. |

Závislosti: E0 → E1 → E2; E3a → E3b; E4a → E4b. E3a a audit E4 môžu bežať paralelne po E0; E5 až po ustálení store kontraktov, E6 po E5. Integráciu `DispatchConsole` a navigácie vlastní jeden agent, aby nezlučoval konkurenčné refaktory. Návrh nezavádza povinný nový štátny manažér ani UI knižnicu.

## 8. Akceptácia a testy

Každý riadok je požadovaný dôkaz pre implementáciu. Nie je to záznam už vykonaných testov. Fixture dáta a provider mocky sa používajú lokálne; reálne volania sa nesmú spustiť náhodou v Preview.

| ID | Testovateľný výsledok | Overenie |
|---|---|---|
| AC01 | Všetkých 5 waiting polí prejde mapperom; null, prekročený limit aj idle/escalated dávajú správny text. | Unit active-calls-model; hodiny riadené testom. |
| AC02 | Čakáreň ukazuje počet, najstaršie čakanie a detail; vek hovoru ≠ nedostupnosť; limit konkrétnej session sa nezmení úpravou globálneho limitu. | Model + 2-klient E2E fixture. |
| AC03 | Dostupný, pauza s gate on/off, offline, obsadený a nepripravené audio majú konzistentnú akciu/dôvod; managerovo ukončenie vyžaduje potvrdenie. | Permission/action matrix unit + API + E2E. |
| AC04 | Scenáre 0/1/3/4/10 ponúk: max3 viditeľné vrátane vlastného hovoru; ďalšie dosiahnuteľné klávesnicou/posunom; vlastný pripnutý. | Playwright geometria + keyboard. |
| AC05 | Klik na A nesmie prijať B; pri súbežnom prijatí dvoch dispečerov iba jeden získa hovor, druhý dostane aktualizovaný stav. | Reducer/API race + dva klienty, presná session/leg. |
| AC06 | Prijatie kolegom odstráni ponuku, vlastné prijatie ponechá lištu, čakáreň presunie session bez duplikácie/straty; greeting/IVR nie je zvonenie. | E2E sekvencia snapshotov + reducer. |
| AC07 | Header/panel callback count sa zhodujú pri claim, pokuse bez spojenia, dokončení, storne a reconnecte, nezávisle od filtra aj pri viac otvorených požiadavkách než limit jednej stránky. | Store unit + 2-klient E2E; fixture nad page limit; už existujúci contact proof. |
| AC08 | Hovor starší než posledných 100 je nájdený menom/zákazníkom/číslom/prípadom/EČV; bez prípadu číslom; phone formáty a diakritika fungujú. | Lokálna DB fixture ≥1 000 hovorov, negatívna organizácia/práva. |
| AC09 | Rovnaký timestamp/null čas nespôsobí duplicitu/vynechanie pri prechode strán; nové hovory nemenia rozčítanú stránku; range zahŕňa deň v Bratislave aj DST. | Query integration + browser back/filter race. |
| AC10 | Operátori vrátane offline, trvanie stavu, inbound count a povolená identita hovoru sú presné; dispatcher nedostane report/admin/device payload. | Role/DTO tests + denné hranice/timezone. |
| AC11 | Len Ústredňa stratí duplicitnú dostupnosť; hlavička a DashboardPhone Nástenky fungujú ako predtým. | Screen-scope E2E regression. |
| AC12 | 1440×900, 1280×800, 390×844 a 200% zoom: žiadne prekrytie hlavnej akcie; pri 1280×800 cieľ ≥5 history rows; mobile bez page overflow. | Screenshot + bounds + klávesnica + reduced motion + kontrast. |
| AC13 | Summary zodpovedá runtime pre return-line, hours off/exception/boundary, IVR/default, plan/group off, empty steps, fanout a ordered overrides. | Table-driven tests proti spoločným pure funkciám a runtime fixture, nie snapshot textu bez významu. |
| AC14 | Počas aktívneho hovoru zmenený plán aktualizuje nové pravidlá, nie frozen cestu session; nedostupný člen nie je garantované budúce prijatie. | Runtime/model integration. |
| AC15 | Preklik vyberie presnú linku/plán/IVR, read-only je read-only; back vráti filtre/scroll. Funguje v E4a so starým editorom, E4b s novým aj po rollbacku. Cudzie ID ani query parameter neobíde práva. | Navigation/role E2E vrátane kombinácií capability a staršej otvorenej karty. |
| AC16 | Skupina+nový člen+nový plán/krok sa uložia v jednej transakcii; chyba druhej sekcie nezanechá prvú; owner a historické timestamps ostanú. | Skutočná disposable PostgreSQL transakcia; API validácie. |
| AC17 | Dvaja manažéri s rovnakou verziou: prvý uloží, druhý 409 a nestratí draft. Uloženie ani realtime nezhodí iný otvorený editor. | SQL race + UI draft preservation. |
| AC18 | Každá schopnosť z matice §5.2 je dostupná; shared group dopad viditeľný; všetky 4 fallbacky a 5/120 s hranice fungujú. | Model/API a manuálny checklist, keyboard reorder. |
| AC19 | Žiadne PUT počas editácie; iba explicitné save; zakázaný role/CSRF/cross-org request neuloží nič. Audit warning nespôsobí falošné „neuložené“. | Route/transaction/error E2E. |
| AC20 | Uložený komentár/úloha/prípad/notifikácia príde oprávnenému druhému klientovi bez Refresh; presná deletion/archive/reassignment cesta. | Dvojklient E2E pre každého writera. Cieľ p95 ≤2 s pri zdravom spojení na kontrolnom datasete. |
| AC21 | Duplicitné/oneskorené/missing eventy, offline/reconnect a uspatie obnovia správny snapshot; viditeľný stale stav, resync do 5 s po obnove siete v testovom prostredí. | Fault injection; fallback catch-up najneskôr do intervalu+request timeout. |
| AC22 | Cudzí save nezmení dirty field/cursor ani neprepíše nový draft; konflikt aj delete majú zrozumiteľný výsledok. | Revízne testy + E2E rýchleho písania/late responses. |
| AC23 | Po logout/org switch/revokácii sa nepoužije stará odpoveď ani neodhalí súkromný text; jeden store/kanál domény a oprávneného publika na tab. Po 401/403/signále okamžité čistenie; bez signálu platnosť najviac 30 s od úspešnej autorizácie, potom skrytie aj offline. | ACL matica, fake clock, revokácia bez focusu/reconnectu, oneskorené response + network counters; zachovať notebook publikum. |
| AC24 | Nový draft vytvorí jednu placeholder položku; save ju nahradí presne jedným prípadom; cancel/leave/TTL ≤60 s ju odstráni pri navrhnutej konfigurácii. | Fake clocks + dvojklient E2E. |
| AC25 | Dvaja editori/2 karty jedného používateľa/revokácia: správne mená a expirácie, bez obsahu neuložených osobných údajov. Falošné meno/profileId server ignoruje/odmietne; cudzia organizácia/neprístupný prípad nemôžu vytvoriť ani čítať presence. | Presence/session/privacy tests vrátane autorizácie každého heartbeat a draft→case. |
| AC26 | Pod kontrolnou záťažou 20 klientov, 10k history rows, burst 20 zmien/2 s: počty read requestov v idle nie vyššie než baseline, žiadny neobmedzený fanout, history API p95 cieľ ≤800 ms. | Lokálne/instrumentované syntetické meranie; záznam stroja/datasetu. Pri nesplnení upraviť návrh pred rollout. Nejde o certifikáciu produkčnej kapacity. |
| AC27 | 2–3 reprezentatívni dispečeri bez vysvetľovania nájdu najdlhšie čakajúceho, zavolajú callback, nájdu starý hovor, prečítajú ďalší krok; správca upraví čas+členov a pochopí dopad. | Moderovaný test: 5 úloh, cieľ aspoň 4/5 dokončené samostatne, žiadna kritická zámena pravidiel a live stavu. |
| AC28 | Preview/dev/produkčné brány, rollback a PWA ochrana hovoru/draftu majú zapísaný výsledok; schema zodpovedá kódu. | Rollout checklist §10, skutočný výsledok každej brány. |
| AC29 | Pri preložených reads/commitoch summary aj editor dostanú úplný starý alebo nový DB snapshot, nikdy zmiešané skupiny/kroky; samotná zmena return-line aj fanout obnoví súhrn bez závislosti na routingVersion. | DB read-snapshot test + invalidation writer matrix + časové vetvy. |
| AC30 | Dva následné save majú správneho autora a vlastný potvrdený diff; pri timeout po commite draft ostane, read ukáže skutočný výsledok pred retry. | Transakčný audit test + fault injection do odpovede po commite. |

### Rozšírený testovací plán

- **Unit:** rozšíriť existujúce `active-calls-model`, `call-pickup`, `ring-plan-model`, `ring-groups-model`, routing/business-hours/return-line testy. Nové testy sa sústredia na chybné prechody, výnimky a identity; nepísať testy pre každý CSS detail.
- **Integrácia:** autorizácia všetkých DTO a route, spoločné config uloženie v disposable lokálnej PostgreSQL, search paging/izolácia, audit chyba, broadcast po commite, CAS konflikty a odobratie práv. Migrácie iba proti lokálnej jednorazovej DB, pokiaľ nie je explicitne povolený iný cieľ.
- **E2E:** dve samostatné browser sessions, call/queue/callback flow so stub Telnyx, navigácia a drafty; responsive, keyboard, reduced motion; oddeliť mock test a následný malý povolený telephony smoke v tejto kópii.
- **Pozorovateľnosť:** meranie summary checkedAt, p95 doručenia/refetch, počet reconnectov a resync, počet aktívnych subscriptions/requestov, 409 konflikty a route error codes. Logy bez čísel/textov klientov; korelácia nepriamo ID oprávnenými serverovými logmi. Nepridávať nový scheduler.

Pred PR: relevantné testy, `pnpm exec vitest run`, `pnpm typecheck`, `pnpm build`; `pnpm test` pridáva Node testy a `pnpm lint` podľa repozitára. E2E so syntetickými API, bez zdedených reálnych endpointov. CI je v repozitári manuálny workflow [K14], preto výsledok Preview nemožno predpokladať len z existencie YAML. Po úspechu nerozširovať opakovane testy bez novej zmeny alebo rizika.

## 9. Pre-mortem: tri scenáre zlyhania

| Scenár | Príčina | Prevencia | Ako ho odhalíme / návrat |
|---|---|---|---|
| 1. Dispečer prijme nesprávneho volajúceho alebo nevie o čakajúcom | Viac líšt používa ten istý answer callback; rozdielne zdroje frontov; prechod odstráni session predčasne. | Session+leg väzba, server pickup, jeden model, deterministické prechody a stále viditeľný počet. | AC01–07 vrátane race; pri pilot chybe vypnúť nový tray a vrátiť pôvodné zobrazenie, zachovať dátové opravy. |
| 2. Správca uloží polovičný plán a nikomu nezvoní | Dva PUT, zmazaný draft, shared group dopad alebo mylná veta bez IVR/limitov. | Spoločná transakcia+version, zachované identity, validácie, pravdivý súhrn, explicitné save a diff. | AC13–19, SQL rollback test; UI rollback nemá obnovovať starú konfiguráciu. Prípadnú opravu konfigurácie uložiť ako novú kontrolovanú verziu s oprávneným správcom. |
| 3. Automatické zmeny prepisujú prácu, odhaľujú obsah alebo zahlcujú klienta | Remount na každý event, nedostatočná ACL/revokácia, viac subscriptions, celé snapshoty pri každom ticku. | Dirty/CAS ochrana, minimálne udalosti+autorizovaný read, dedupe/coalesce, session-bound cache, fallback a limity. | AC20–26; rollback novej realtime cesty na existujúce polling+viditeľný stav, zachovať draft a dostupnosť čítania. |

## 10. Nasadenie a návrat späť

Plán nič nenasadzuje. Po neskoršom poverení začať z **aktuálneho dev**, vytvoriť vyhradenú vetvu; aktuálnu `Alfopure/quito` nepremenovávať. Väčšie etapy môžu mať samostatné PR do dev; každá musí byť kompatibilná so stavom predchádzajúcej.

1. **Preflight E0:** potvrdiť target tejto Telnyx kópie, env/capability a potrebné schema verzie read-only. Žiadny kontakt s pôvodnou produkciou. Aktuálny kód neznamená nasadené SQL; staršie rollout prerequisite v `docs/rollout/dispatch-workspace-v3.md` znovu overiť, nereimplementovať už hotové veci.
2. **Lokálne overenie:** syntetické dáta a izolovaná DB/provider mock; žiadne demo seedy do zdieľaného projektu. Additive API/UI zmeny pripraviť kompatibilne; samostatné jednoduché prepínače pre nový tray/layout/editor/realtime len tam, kde potrebujeme nezávislý rollback.
3. **Schema, iba ak treba:** najprv pripraviť reviewovateľnú migráciu, rollback/kompatibilitu a lokálne dôkazy. Aplikácia musí pred explicitne povolenou migráciou fungovať so starým schema alebo držať závislú funkciu vypnutú s jasným stavom. Samotné všeobecné poverenie UI nasadiť nie je poverenie aplikovať telephony migráciu/seed. Nepoužiť destructive down migráciu ako rutinný rollback.
4. **Push pracovnej vetvy a Preview tejto kópie:** overiť build gate `vitest run`, typecheck, build z reálnych deployment logov; v repozitári target guard a región `fra1` [K14]. Preview/dev používajú spoločnú reálnu DB, takže prehliadanie a testy predvolene read-only; skúšobné volania/uloženia iba v explicitne povolenom scenári s určenými účastníkmi.
5. **PR do dev:** rozsah obrazoviek, screenshoty, zmena dátových kontraktov, zachované funkcie, testové dôkazy, potrebné schema a aktivácia, známe obmedzenia a návrat. Po merge overiť skutočný dev alias tohto Vercel projektu a health/read-only toky; telefónny smoke oddelene, kontrolovane.
6. **Pilot a postupná aktivácia:** najprv P1, potom layout/história, potom konfigurácia; realtime a presence osobitne. Otestovať správcu aj obyčajného dispečera, návrat PWA po update, otvorený hovor a rozpracovaný formulár. Nemigrovať globálny routing počas testu vzhľadu.
7. **Produkcia:** iba PR **dev → main**; doména tejto kópie `https://test.dispecing.linkapomoci.sk`, prípadne overený produkčný `*.vercel.app` alias tohto projektu do pripravenia CNAME. Žiadne work-branch → main a žiadne workers/listeners/schedulers. Zachovať jediný cron `*/5 * * * *` → `/api/telephony/cron` s `CRON_SECRET`.
8. **Rollback:** vypnúť príslušný feature alebo vrátiť kompatibilný aplikačný commit štandardnou PR cestou; nezmazávať nové prípady/callbacky/konfiguráciu. Pri live klientovi nevynútiť reload uprostred hovoru/draftu. Config zmeny majú vlastný audit/verziu; vrátenie UI nemení routing. Po návrate overiť counts, čítanie histórie, draft a znovupripojenie.

Brána vydania neprejde pri nesprávnom session answer, strate draftu, ACL úniku, neatomickom config save, nesprávnom summary alebo rozbitom základnom ovládaní na úzkej obrazovke. Menšie vizuálne rozdiely zapísať s prioritou; nevydávať ich za splnenie chýbajúceho funkčného testu.

## 11. ADR

- **Rozhodnutie:** možnosť A; lineárne nastavenie Prichádzajúce hovory, shared draft+atomic save; kontextový serverový summary, existujúci vizuálny štýl a oddelené etapy realtime/presence.
- **Dôvody:** orientácia pri živom hovore, jednoduché správne nastavenie, zachovanie fungujúcich schopností a overiteľná postupnosť.
- **Alternatívy:** B so samostatnými saves je lacnejší funkčný prvý krok; nebol zvolený pre pretrvávajúcu kognitívnu a dátovú medzeru. Vizuálny canvas nie je potrebný.
- **Prečo táto voľba:** odstraňuje skákanie medzi skupinou a plánom bez skrývania ich skutočného vzťahu; nevymýšľa druhý routing engine ani kompletný nový dispatch frontend.
- **Dôsledky:** treba combined API, výslovný summary DTO, presnú navigáciu a transakčné testy. Niektoré etapy môžu potrebovať vopred povolené migrácie. Prototyp je vzor rozloženia, nie úplný engine simulátor.
- **Nadväzujúce kroky:** po poverení E0 overí živé prerequisite a baseline; pri nesúlade aktualizovať príslušnú časť plánu pred implementáciou. Praktické mobilné/kapacitné testy a odložené témy majú vlastné zadania.

## 12. Dôkazy zo zdrojov

| Kľúč | Overená existujúca implementácia |
|---|---|
| K1 | `src/lib/telephony/active-calls-model.ts:219`, `:353`, `:518`; `src/server/telephony/active-calls.ts:391`; `src/components/dispatch/CallQueuePanel.tsx:69`. |
| K2 | `src/components/dispatch/PhoneBar.tsx:367`, `:376`, `:504`; `src/components/dispatch/LiveCallOverview.tsx:247`; `src/components/dispatch/DispatchConsole.tsx:2237`. |
| K3 | `src/lib/telephony/call-pickup-presence.ts:4`; `src/server/telephony/call-actions.ts:700`; `src/components/dispatch/LiveCallOverview.tsx:254`, `:272`, `:316`; `src/server/telephony/stability.ts:2`. |
| K4 | `src/components/dispatch/CallCenterModule.tsx:370`, `:512`, `:526`, `:533`; `src/components/dispatch/DispatchConsole.tsx:2039`, `:2116`, `:2452`. |
| K5 | `src/lib/telephony/wallboard.ts:76`; `src/server/telephony/stats.ts:276`; `src/app/api/telephony/stats/route.ts:9`; `src/lib/telephony/presence.ts:66`. |
| K6 | `src/server/telephony/call-history.ts:10`, `:22`, `:34`; `src/app/api/telephony/calls/history/route.ts:7`; `src/components/dispatch/CallCenterModule.tsx:605`, `:799`, `:833`; `src/data/dispatch-repository.ts:856`. |
| K7 | `src/components/dispatch/CallbackQueuePanel.tsx:91`, `:178`, `:226`, `:397`; `src/components/dispatch/CallCenterModule.tsx:204`, `:439`; `src/server/telephony/callbacks.ts:368`; `src/server/telephony/callback-reconciliation.ts:9`. |
| K8 | `src/components/dispatch/settings/ring-plan-model.ts:248`, `:292`, `:334`, `:377`; `src/components/dispatch/settings/RingPlanEditor.tsx:192`; `src/server/telephony/routing/ring-plan.ts:126`, `:257`. |
| K9 | `src/components/dispatch/settings/TelephonyConfigPanel.tsx:40`, `:57`, `:68`; `src/components/dispatch/IntegrationSettings.tsx:33`; `src/server/telephony/config-service.ts:1640`, `:1662`, `:1781`; `supabase/migrations/20260920100000_ivr_menu_config.sql:24`. |
| K10 | `src/server/telephony/config-route.ts:24`, `:65`, `:87`, `:142`; `src/server/telephony/return-line.ts:6`; `src/server/telephony/state/transitions.ts:791`, `:1070`; `src/server/telephony/routing/ivr.ts:148`. |
| K11 | `src/components/dispatch/TaskWorkspaceProvider.tsx:23`; `src/components/dispatch/NotebookPanel.tsx:37`; `src/lib/telephony/realtime-client.ts:1`; `src/components/dispatch/DispatchConsole.tsx:742`, `:967`, `:1275`; `src/app/api/cases/location-updates/route.ts:23`. |
| K12 | `src/components/dispatch/CaseDetail.tsx:1860`, `:2004`; `src/server/case-atomic-save.ts:20`; `src/components/dispatch/NewCaseDrawer.tsx:547`; `src/components/dispatch/ExpandedCasePanel.tsx:103`. |
| K13 | `src/server/telephony/state/transitions.ts:2507`; `src/components/dispatch/CallTransferPicker.tsx:124`. |
| K14 | `AGENTS.md:1`; `vercel.json:1`; `package.json:5`; `.github/workflows/ci.yml:3`, `:39`; `docs/rollout/dispatch-workspace-v3.md:1`. |
| K15 | `src/server/telephony/config-service.ts:1344`, `:1419`, `:1943`, `:2076`; `supabase/migrations/20260928130000_personal_mobile_ownership.sql:33`. |
| K16 | `src/components/dispatch/NotebookPanel.tsx:54`; `src/domain/notes.ts:1`; `supabase/migrations/20260929120000_task_workspace.sql:448`. |

## 13. Použité postupy, UX zdroje a výsledky kontroly

- RALPLAN a plan z publikovanej verzie [oh-my-codex v0.8.0](https://github.com/Yeachan-Heo/oh-my-codex/blob/v0.8.0/skills/ralplan/SKILL.md), lokálne `/home/vercel-sandbox/.codex/skills/ralplan/SKILL.md` a `plan/SKILL.md`. Použitý fallback rolových agentov, ktorý táto verzia opisuje; netvrdíme spustenie OMX CLI alebo novších runtime attestation mechanizmov.
- [frontend-design od Anthropic](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md): tokeny → porovnanie usporiadania → kontrola briefu → prototyp → vizuálna kritika. Používateľov štýl Nástenky má prednosť pred experimentálnou estetikou.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md): focus, sémantika, pohyb, stabilný layout a formuláre. Lokálny skill `/home/vercel-sandbox/.codex/skills/web-design-guidelines/SKILL.md`.
- [Carbon Data table](https://carbondesignsystem.com/components/data-table/usage/): vyhľadávanie pri tabuľke, oddelené triedenie, detail na vyžiadanie. Návrh nepreberá vizuálnu identitu IBM.
- [NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): bežné úkony vpredu, pokročilé voľby dostupné po rozbalení; skrytie nesmie zneprístupniť schopnosť.
- [W3C Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): 24×24 CSS px alebo splnená výnimka sú minimum AA; plán cieli na väčšie pracovné ovládanie.
- [Supabase Broadcast](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) a [Realtime performance](https://supabase.com/docs/guides/realtime/benchmarks): podklad pre autorizované udalosti a meranie, nie dôkaz výkonu našej aplikácie.

### Stav overenia tohto plánovacieho výstupu

Historické overenie pri tvorbe funkčného plánu v2 a pôvodného prototypu:

- Lokálny audit zdrojov a zachovaných funkcií; automatická kontrola existencie odkazovaných súborov a riadkov, doplnená vecnou kontrolou Architect/Critic. Aplikácia sa nemenila a nebol kontaktovaný živý projekt.
- Pôvodný návrh → screenshot → kritika → oprava: znížená výška horných blokov, odstránený mobilný presah, zachované ostatné nastavenia, čitateľná dostupnosť a návrat k filtru. Mobilné hlavné akcie zväčšené na 44 px. Jeho čierna globálna hlavička vychádzala zo zastaranej referencie a bola používateľom oprávnene korigovaná; nový vzhľad rieši v2.1.
- **31/31 kontrol pôvodného samostatného prototypu v2** v Playwright/Chrome: 1440, 1280, 640 a 390 px, max3 lišty, posun so zachovaním vlastného hovoru, reduced motion, hľadanie, filter, hlboký preklik/návrat, mock save a chybný čas, callback claim, prijatie kolegom, dropdown/Escape. [Presný protokol](../../.context/prototype-checks.json), [reprodukovateľný skript](../../.context/check-ustredna-prototype.cjs). Žiadne externé requesty ani JS chyby v tomto behu.
- V pôvodnom prototype v2 namerané: riadok histórie približne 44,5 px; pri 1280×800 **5** celých riadkov, pri 1440×900 **7**, pri troch lištách; žiadny vodorovný presah celej stránky v testovaných šírkach. Mobil má väčšie lišty a vyžaduje zvislé posúvanie. Test 640 px je reflow kontrola, nie plná skúška skutočného 200% browser zoomu.
- **84/84 existujúcich testov pri audite v2** v štyroch suite: `ring-plan-model`, `ring-groups-model`, server `routing/ring-plan`, `return-line`. Overujú dnešný základ, nie budúce API alebo novú aplikáciu. Predchádzajúcich 80 telephony modelových testov patrí k skoršiemu auditu a nie je započítaných do 84.
- [Historické heuristické hodnotenie pôvodného návrhu 8,5/10](../../.context/dispatch-plan-prototype/review.md) vzniklo pred novou snímkou používateľa. Jeho udelené 2/2 za súlad so štýlom boli založené na nesprávnej referencii, preto skóre **neplatí ako potvrdenie zhody s aktuálnou Nástenkou a neprenáša sa na v2.1**. Pôvodné hodnotenie zostáva iba v revíznom zázname. Chýba pilot s dispečermi, úplný audit čítačkou/kontrastov a produkčné integračné testy.

Vizuálna revízia v2.1 má samostatnú [kontrolu oproti používateľovej snímke](../../.context/ralplan-reviews/light-style-correction.md). Doterajších 31 prototypových kontrol a 84 existujúcich unit testov nepreukazuje overenie nového svetlého prototypu; jeho nové výsledky sa zapisujú oddelene. Architektonický konsenzus v2 sa vzťahuje na funkčný plán, nie na novú vizuálnu zhodu.

**Nové overenie v2.1: 70/70 kontrol samostatného svetlého prototypu.** [Protokol](../../.context/light-prototype-checks.json), [skript](../../.context/check-light-prototype.cjs). Rozlíšenia 1440×900, 1280×800 a 390×844; stavy bez hovoru, zvonenie, jeden hovor, viac hovorov aj svetlé nastavenia. Overené: svetlá hlavička vo všetkých stavoch, nulová výška čierneho panelu bez hovoru, jedna lišta pri jednom hovore/ponuke, najviac tri viditeľné spolu, žiadny vodorovný presah stránky, päť celých riadkov histórie pri troch lištách na 1280×800, vycentrovaná lupa, nezmenený avatar pri zmene dostupnosti, identita ukážkového prijatia, návrat k vyhľadávaniu a reduced motion. Žiadne JS chyby alebo externé requesty v kontrolovanom behu. Po prvom behu upravené odstupy, aby zostal splnený priestor pre päť riadkov; posledný beh vyšiel bez chyby. Ide o vizuálnu a interakčnú skúšku prototypu, nie novú implementáciu aplikácie alebo meranie jej výkonu.

Prototyp nemeria výkon appky a neoveruje živé telefonovanie, role, transakcie, skutočnú synchronizáciu alebo celú sadu pokročilých nastavení. Tieto dôkazy ostávajú explicitnými bránami implementácie v §8–10.

### Revízny záznam

- v1: zlúčené zadania, presné obrazovky, hotové/nové/odložené, návrh spoločného save, pravdivý summary, rollout, akceptácia a pre-mortem.
- v2 vizuálny podklad: požiadavka nadviazať na Nástenku bola pôvodne vyhodnotená zo starých snímok návodu a auditovaného shellu. Nová snímka od používateľa tento podklad pre vzhľad nahrádza.
- Architect v1: ITERATE, dve konkrétne medzery; následne nezávislý Critic v1: ITERATE, potvrdené M1/M2 a doplnený prechod E4a→E4b. [Architect](../../.context/ralplan-reviews/architect-v1.md), [Critic](../../.context/ralplan-reviews/critic-v1.md).
- v2: M1 koherentný DB snapshot, scoped CAS verzia, úplné invalidácie a audit potvrdeného commitu; M2 autorizované publikum, serverový lease/heartbeat a 30 s ACL platnosť; M3 kompatibilný navigačný adapter pri medziverzii aj rollbacku. Doplnené save timeout a callback počet nad stránkou, AC29–30, skutočné prototypové/testové dôkazy a hranice hodnotenia.
- Záverečné sekvenčné kolo: [Architect v2 — APPROVE](../../.context/ralplan-reviews/architect-v2.md), až po jeho dokončení [Critic v2 — APPROVE](../../.context/ralplan-reviews/critic-v2.md). Bez zostávajúcich povinných pripomienok. V čase uzavretia v2 posledná úprava iba zapísala výsledok a odkaz na snímku čakárne. Nasledujúca v2.1 koriguje vizuálnu referenciu, bez zmeny schváleného funkčného rozsahu. Konsenzus schvaľuje kvalitu plánu, nenahrádza používateľovo poverenie realizovať ho.

- **v2.1 — oprava podľa aktuálnej Nástenky:** autoritatívna používateľova snímka nahradila starý návod. Svetlá hlavička, modrosivé plochy, zoskupená navigácia, systémové písmo a mäkšie panely s jemným Apple dojmom podľa dodatočného želania používateľa; čierne iba skutočné lišty hovorov, idle bez nich. Nový svetlý prototyp a nové screenshoty sú oddelené od historických výsledkov v2. Žiadne zmeny aplikácie alebo nasadenia, žiadna zmena funkčnej architektúry, žiadne predstierané nové úplné kolo RALPLAN.
