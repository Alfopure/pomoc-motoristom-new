# Mobilný dizajnový štandard

Platí pre každú obrazovku mobilnej appky Linka pomoci. Režim: iba svetlý
(tmavý a režim „Rukavice“ pre terén prídu neskôr). Majiteľ 18. 10. 2026
schválil prestavbu navigácie a variant lišty **A · Dock** z klikacieho
prototypu: Prehľad, tri vlastné moduly a žltá ikona Moduly.

Cieľ: jedna appka pre celú firmu s mnohými modulmi a rolami, ktorá pôsobí ako
natívna iPhone appka (Liquid Glass), ukáže veľa údajov prehľadne a každý nový
modul do nej zapadne bez nového dizajnu.

## 1. Princípy

1. Čo treba teraz, je navrchu: prebiehajúci hovor, oneskorené termíny, moje veci.
2. Hustota cez typografiu a rozostupy, nie cez malé ťukacie plochy (≥ 44 b).
3. Minimalizmus: jedna farba = jeden význam, žltá pre hlavnú akciu a „moje“.
4. Stav vždy farbou aj textom, nikdy iba farbou.
5. Sklo len pre navigáciu a ovládače; obsah je nepriehľadný.
6. **Každá akcia má viditeľné tlačidlo s popisom.** Podržanie a potiahnutie sú
   iba skratky k niečomu, čo sa dá ťuknúť. Žiadna navigácia schovaná za ikonou bez textu.
7. Rovnaký vzor všade: kto pozná jeden modul, ovláda všetky.
8. Dynamika s účelom: plynulé prechody, žiadne samoúčelné animácie; rešpektuje
   „Obmedziť pohyb“ a „Znížiť priehľadnosť“.

## 2. Kostra appky

**Horná lišta** (`mobile/src/shell/top-bar.tsx`): vľavo stav operátora
(Dostupný / Pauza / Na hovore…, ťuk otvorí Ústredňu) alebo šípka Späť s názvom
cieľa (‹ Prípady, ‹ Prípad, ‹ Hovory, ‹ Moduly); vpravo **☆ Do lišty** pri
module otvorenom z Modulov, štítok TEST a žltý avatar (Účet). Podstránky modulov
(detail, formulár, prílohy, úlohy…) nemajú vlastné tlačidlo Späť v obsahu –
zaregistrujú ho cez `useShellBack(active, "Prípady", back, ukladanie)`.

**Spodná lišta** (`mobile/src/shell/tab-bar.tsx`): `Prehľad · 3 vlastné moduly · Moduly`.

- Všetky položky majú ikonu aj text. Vybraná je na sivom podklade (šošovka sa presúva).
- **Moduly** majú žltý štvorec: všetky povolené moduly ako plocha iPhonu.
- Voľné miesto po odobratí modulu je položka **+ Pridať** (otvorí úpravu lišty).
- Odznak iba pre to, čo čaká na človeka (napr. čakajúce spätné volania).
- Lupa v lište nie je. Hľadanie je pole na obrazovke (Moduly, História, Prípady, Úlohy).
- Pri písaní sa lišta skryje; zväčšené písmo zväčší lištu najviac 1,3×.

**Moduly** (`modules-screen.tsx`): hľadanie modulu, karta **Moja lišta** s náhľadom
lišty a žltým tlačidlom **Upraviť lištu**, mriežka modulov (★ = v lište, odznak počtu)
a riadok **Účet a koncepty**. Pri najviac ôsmich moduloch je jedna mriežka,
pri viacerých sa zobrazia skupiny (Komunikácia, Zásahy, Vozový park, Kancelária…).

**Prispôsobenie lišty** (všetky cesty sú viditeľné):

| Cesta | Čo urobí |
| --- | --- |
| Moduly → Moja lišta → **Upraviť lištu** | červené – odoberie, zelené + pridá, šípky ▲▼ menia poradie; pri plnej lište sa vyberie, čo nový modul nahradí |
| Modul otvorený z Modulov → **☆ Do lišty** | pridá modul; pri plnej lište sa opýta, ktorý nahradiť |
| Podržanie ikony v Moduloch (skratka) | Otvoriť · Pridať do lišty / Odobrať z lišty · Upraviť lištu |
| Účet → Spodná lišta | Upraviť lištu, Obnoviť lištu podľa roly |

Zmeny platia hneď. Uložia sa v telefóne pre daný účet, prostredie a profil
(`pm-shell-v1.<prostredie>.<user>.<profil>` v samostatnej službe Keychain,
čitateľnej po prvom odomknutí ako prihlásenie). Ak sa uloženú lištu nepodarí
prečítať (napr. zamknutý telefón), zobrazí sa lišta podľa roly, nič sa cez
uloženú hodnotu nezapíše a čítanie sa zopakuje po návrate do appky.
Synchronizácia medzi zariadeniami príde s API preferencií na serveri.

**Navigácia** (`navigation.ts`): modul v lište má vlastnú záložku; modul mimo
lišty sa otvorí vo vnútri Modulov so šípkou Späť. Moduly si pamätajú otvorený
modul aj po prechode na inú záložku; opätovný ťuk na Moduly sa vráti na
mriežku. Zmena lišty nepreskočí obrazovku: odobratý modul ostane otvorený
v Moduloch, pridaný sa presunie do svojej záložky. Android Späť: podstránka
modulu (detail prípadu, detail hovoru) → späť v module; účet → zatvorí sa;
modul v Moduloch → Moduly; iná záložka vrátane všetkých častí Hovorov → Prehľad;
Prehľad → systém. Hľadať a Upozornenia sú vrstvy nad záložkou (účet > hľadanie >
upozornenia); Späť ich zatvorí a vráti záložku, z ktorej boli otvorené.

**Hľadať** (`search.tsx`): pole na Prehľade otvorí obrazovku Hľadať. Od dvoch
znakov hľadá v prípadoch celej organizácie (číslo, meno, EČV, telefón),
v hovoroch a v moduloch; ťuk otvorí detail prípadu, detail hovoru alebo modul.

**Prehľad** (`home.tsx`): hľadanie, hovory na účte (ak sú), dlaždice Spätné volania,
Prípady, Moje úlohy a Telefón; ťuk otvorí príslušný modul. Pod nimi sekcia
**Treba riešiť**: najviac štyri najnaliehavejšie položky a riadok **Všetky
upozornenia**. Jednorazový tip ukáže, kde sú Moduly; zmizne po ťuknutí na OK
alebo po prvej návšteve Modulov.

**Upozornenia** (`mobile/src/alerts/`): jedna schránka toho, čo čaká na človeka,
zoradená podľa naliehavosti – spätné volania po termíne, vaše úlohy po termíne,
horiaci prípad bez dispečera, spätné volania s termínom do 15 minút, vaše úlohy
na dnes, ostatné horiace prípady. Každá sekcia (Spätné volania, Moje úlohy,
Horiace prípady) končí odkazom na celý zoznam: Spätné, zoznam Moje úlohy
alebo Prípady s filtrom priorita Horí. V rámci rovnakej naliehavosti ide
navrch najstarší termín; úloha v stave po termíne sa počíta ako na webe.
Číta prvú stránku každého zdroja („3+“ aj „0+“ znamená, že ďalšie stránky sa
nečítali), obnovuje sa každú minútu, hneď po návrate do appky a potiahnutím
nadol. Zdroj s chybou ukáže chybu s tlačidlom Skúsiť znova; „Všetko je
vybavené“ sa zobrazí iba vtedy, keď všetky zdroje odpovedali celé. Server ani
notifikácie nemení – push upozornenia sú samostatná etapa.

**Účet** (avatar): profil, Prostredie, Spodná lišta (Upraviť lištu, Obnoviť podľa
roly), Odhlásiť sa ako červený riadok a Koncepty v tomto zariadení – každý koncept
s tlačidlami Pokračovať a Zahodiť. Počas hovoru je odhlásenie nedostupné.

**Lišta hovoru** (`call-bar.tsx`): kým beží hovor, nad spodnou lištou je zelený
pás s menom alebo číslom, stavom a dĺžkou hovoru. Hovor v tomto telefóne má
prednosť pred hovormi, ktoré server eviduje na účte (napr. na stolovom telefóne).
Ťuk otvorí detail hovoru, pri hovore v telefóne alebo viacerých hovoroch Ústredňu.
Na Ústredni a v detaile toho istého hovoru sa nezobrazuje; pri písaní sa skryje
spolu s lištou a obsah končí nad ním.

**Okná (sheet)**: jedno spoločné okno zdola pre úpravu lišty, výber náhrady
a menu modulu; každé má viditeľné Hotovo, Zrušiť alebo Zavrieť. Pri začiatku
hovoru alebo prechode do pozadia sa zatvorí (`usePhoneOverlay`), aby ovládanie
hovoru ostalo v popredí.

## 3. Moduly, roly a prístupy

Moduly a ich poradie určuje register `mobile/src/shell/modules.ts`
(ID, názov, krátky názov do lišty, skupina, farba ikony, popis). Lišta,
Moduly, Prehľad a úprava lišty sa z neho poskladajú samy.

| Modul | Obsah | Predvolene v lište |
| --- | --- | --- |
| Hovory | Ústredňa · História · Spätné (segment hore) | áno |
| Prípady | zoznam, detail, založenie, poznámky, prílohy, úlohy, odovzdanie | áno |
| Moje úlohy | úlohy naprieč prípadmi | áno |
| Nástroje | vozidlo podľa EČV/VIN, trasa, mapa, flotila | nie (v Moduloch) |

Roly mobilu dnes: dispečer, vedúci dispečer, manažér, administrátor – všetky
vidia tieto štyri moduly. Viditeľnosť v appke je iba prezentácia; **o prístupe
rozhoduje server pri každej požiadavke**. Neskôr server pošle zoznam modulov
s úrovňou prístupu (bez prístupu / čítanie / úpravy / správa); modul bez
prístupu sa nikde nezobrazí. Plánované moduly a roly (výjazdy a pristavenia,
kniha odťahov, partneri, vozidlá, tabuľa vozidiel, kniha poškodení,
kalendár, fakturácia, adresár, reporty, upozornenia; vodič, pristavovač,
fakturácia, správca vozového parku, predajca) pribudnú do registra.
Rola s najviac štyrmi modulmi (napr. vodič) dostane pevnú lištu iba so svojimi modulmi.

## 4. Vizuálny jazyk (kompaktná hustota)

Hodnoty sú v `mobile/src/design/tokens.ts`; obrazovky nepoužívajú vlastné.

| Rola textu | Veľkosť / riadok | Rez |
| --- | --- | --- |
| Nadpis obrazovky | 28 / 34 | bold |
| Názov objektu v detaile | 22 / 28 | bold |
| Číslo v dlaždici | 24 / 29 | bold, pevná šírka číslic |
| Nadpis listu, sekcie karty | 17 / 22 | semibold |
| Názov v riadku | 15 / 20 | semibold |
| Telo, podnadpis | 13–15 / 18–20 | regular |
| Atribúty, čas, čipy | 12 / 16 | medium |
| Štítky | 11 / 14 | bold – nikdy menej |

- Rozostupy 4 · 8 · 12 · 16 (okraj obrazovky) · 24 · 32.
- Skupiny riadkov a dlaždice: biele na `#F2F2F7`, zaoblenie 16, bez rámčekov.
- Tlačidlá: kapsula výšky 44; hlavná akcia čierna alebo žltá (najviac jedna žltá na obrazovku).
- Čipy filtrov: biele kapsuly 36 b (ťuková plocha 44), vybraný čierny; výber
  zo zoznamu má šípku ▾.
- Farby: žltá `#FCD703` (hlavná akcia, „moje“, avatar), jantárová `#7D6300`
  pre žltý text, stavové tóny červený/oranžový/zelený/modrý/sivý v plnej aj jemnej podobe.
- Ikony modulov majú vlastnú farbu ako Nastavenia iPhonu (Hovory zelená,
  Prípady žltá, Úlohy modrá, Nástroje sivá).

## 5. Komponenty

`mobile/src/design/list.tsx` (skupina, riadok, hlavička sekcie), `mobile/src/design/detail.tsx`
(hlavička detailu, rad akcií, riadok údaj–hodnota, ikonové tlačidlo, štítok),
`mobile/src/design/form.tsx` (sekcia formulára, pole, výber, voľba so ✓)
a `mobile/src/shell/parts.tsx` (prvky kostry):

- **Riadok (object cell)** – 1–3 riadky textu, voliteľný farebný pruh (priorita)
  alebo ikona 28 b, čas/suma vpravo, celý riadok je ťuková plocha; najviac jedna
  akcia vpravo (napr. „Vybrať číslo“ v Histórii).
- **Skupina** s odsadenými deliacimi čiarami, **hlavička sekcie**, **segment**
  (2–5 častí, s odznakom), **sklenené tlačidlo** hornej lišty, **okno zdola**,
  **potvrdenie** nad lištou (aj pre VoiceOver), **ikona modulu**, **náhľad lišty**.
- **Štítok stavu** – 11 b bold v jemnom podklade, vždy na jednom riadku (v riadku
  sa skráti text vedľa neho); stav vždy aj textom.
- **Tlačidlo** – čierne; jediná hlavná akcia formulára (Uložiť, Vytvoriť,
  Potvrdiť) je žltá (`primary`), doplnkové sivé (`secondary`), nedostupné svetlosivé.
- **Formulár** – sekcie s nadpisom; v riadku popis (12 b) nad poľom (16 b), ťuk
  kamkoľvek do riadku presunie kurzor do poľa; pomocná akcia v riadku je malé
  žlté tlačidlo s textom („Na mape“); výber hodnoty je riadok s hodnotou a ›,
  voľba zo zoznamu riadok so ✓, krátke voľby čipy. Hlavná akcia je pod sekciami.
  Chyba uloženia, neistý zápis a konflikt sú viditeľné hneď po ťuknutí – pri
  tlačidle alebo navrchu, kam sa obrazovka posunie.

## 6. Šablóny obrazoviek

Prehľad · Moduly · Zoznam · Kniha · Detail objektu · Tabuľa · Kalendár ·
Mapa + list · Výjazd (krokovanie) · Nahlásenie s fotkami · Formulár v liste ·
Hovor. Zoznam používajú Hovory/História, Prípady, Moje úlohy, úlohy prípadu
(spoločný kompaktný riadok úlohy) a Nástroje (jedna skupina riadkov s ikonou). **Detail** (hlavička so štítkami, rad 2–4 akcií
s popisom, skupiny riadkov údaj–hodnota s ikonami Kopírovať/Mapa/Navigovať,
Súvisiace, Udalosti) používa detail prípadu, hovoru a úlohy. **Formulár** používa
nový prípad a jeho úpravu (Kontakt, Vozidlo, Miesto, Problém, Služba a priorita),
poznámku, dispečera prípadu a novú úlohu. Ostatné šablóny vzniknú s modulmi
pilierov 2 a 3.

## 7. Technické rozhodnutia

- Lišta je komponent appky na systémovom skle (`GlassSurface` → `expo-glass-effect`
  na iOS 26, rozmazanie na staršom iOS, nepriehľadný povrch inde). Funguje rovnako
  v Expo Go, vo vlastnom builde aj v prehliadačovej skúške. Natívny `UITabBarController`
  (react-native-screens 4.26 v Expo SDK 57) zvážime po overení na zariadení:
  nepodporuje podržanie položky a výnimky ako „+ Pridať“ rieši cez `preventNativeSelection`.
- Prípady, Moje úlohy a Nástroje ostávajú pripojené a len sa skrývajú, takže
  rozpísaný stav sa zmenou záložky nestratí. Ústredňa, História, Spätné,
  Prehľad a Moduly sa pri návrate načítajú znova. Skryté moduly rušia svoje
  čítania podľa prefixu kľúča, preto Prehľad používa vlastné kľúče (`…, "home", …`).
- Stav operátora v hornej lište sa číta každých 30 s na každej obrazovke
  (jeden spoločný dopyt s Ústredňou).
- Moduly dostávajú pôvodné identifikátory obrazoviek (`console`, `history`,
  `callbacks`, `cases`, `tasks`, `tools`, `account`); kostra ich odvodí zo stavu navigácie.

## 8. Pravidlá pre ďalší vývoj

1. Nový modul = záznam v registri modulov + obrazovky zo šablón a komponentov.
2. Žiadne vlastné farby, veľkosti písma, hlavičky ani spodné menu mimo tokenov a kostry.
3. Každá akcia má viditeľné tlačidlo s textom; gesto je len skratka.
4. Ťukacie plochy ≥ 44 b, kontrast textu ≥ 4,5 : 1, VoiceOver popisy ikon.
5. Overlay (okno, výber) používa `usePhoneOverlay`, aby ho zatvoril hovor.
6. Podstránka modulu nemá tlačidlo Späť v obsahu; volá `useShellBack` s názvom cieľa
   a počas ukladania ho vypne. Android Späť ostáva v `useAndroidBack` tej istej obrazovky.
7. Pri PR: snímky 390 a 320 b, kontrola zoznamu Expo „native slop“, existujúce testy prejdú.

## 9. Kritériá prijatia

Nepovolené moduly sa nikde nezobrazia; dynamické písmo bez orezania kľúčových
údajov; „Obmedziť pohyb“ a „Znížiť priehľadnosť“ funkčné; stav nikdy iba farbou;
lišta a jej úprava fungujú ťuknutím bez gest.

## 10. Plán

| Etapa | Obsah | Stav |
| --- | --- | --- |
| 0 | štandard v repozitári, tokeny | hotové |
| 1–2 | kostra: horná a spodná lišta, Prehľad, Moduly, úprava lišty, register modulov | hotové (TEST) |
| 3 | Hovory, Prípady, Úlohy, Nástroje, Účet v novej kostre; kompaktné zoznamy; detail prípadu, hovoru a úlohy; formuláre; Späť v hornej lište | hotové (odovzdanie prípadu a prílohy ešte v pôvodnom vzhľade) |
| 4 | šablóny Kniha, Tabuľa, Kalendár, Mapa + list, Výjazd, Nahlásenie | plán |
| 5 | globálne hľadanie, Upozornenia a lišta hovoru nad lištou (hotové); serverový zoznam modulov a preferencie, push upozornenia, doladenie | čiastočne |

## 11. Zdroje

- Apple HIG – Tab bars: https://developer.apple.com/design/human-interface-guidelines/tab-bars
- Apple – Liquid Glass / Adopting Liquid Glass: https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
- Apple HIG – Typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Apple HIG – Searching: https://developer.apple.com/design/human-interface-guidelines/searching
- Apple – TabViewCustomization: https://developer.apple.com/documentation/swiftui/tabviewcustomization
- Donny Wals – Tab bars on iOS 26: https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/
- NN/g – Hamburger menus and hidden navigation: https://www.nngroup.com/articles/hamburger-menus/
- NN/g – Customization vs. personalization: https://www.nngroup.com/articles/customization-personalization/
- NN/g – Bottom sheets: https://www.nngroup.com/articles/bottom-sheet/
- SAP Fiori for iOS – Object Cell: https://experience.sap.com/fiori-design-ios/article/object-cell/
- SAP Fiori – Content density: https://experience.sap.com/fiori-design-web/cozy-compact/
- Expo SDK 57 – Glass effect: https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/
- React Navigation – Native bottom tabs: https://reactnavigation.org/docs/native-bottom-tab-navigator
- WCAG 2.2 – Target size (minimum): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WCAG 2.2 – Use of color: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
