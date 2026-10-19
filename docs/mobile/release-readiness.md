# Pripravenosť mobilnej aplikácie na nasadenie (iPhone)

Stav k 19. 10. 2026, zdroj `dev` `aa68c9e` (TEST, Expo Go). Dokument spisuje,
čo aplikácia vie, čo chýba na každodenné používanie, čo vyžaduje Apple, čo
potrebujeme pripraviť my a v akom poradí. Postup natívneho telefonovania po
schválení Apple je osobitne v [iPhone TEST postupe](iphone-voice-test.md).

## 1. Zhrnutie

- **Dnes:** aplikácia funguje v Expo Go proti TEST serveru. Dispečer v nej
  vie pracovať s prípadmi, úlohami a spätnými volaniami; telefonovať z nej
  zatiaľ nevie a dostáva iba upozornenia viditeľné pri otvorenej aplikácii.
- **Hneď po licencii (asi 1 deň):** podpísaný TEST build na konkrétne iPhony
  (Ad Hoc) alebo cez interný TestFlight, bez App Review. Vhodné na pilot
  a na prvé fyzické skúšky telefonovania.
- **Ostrá prevádzka bez telefonovania:** treba vydať server s mobilným API na
  produkciu, doplniť povinné náležitosti pre Apple a prejsť App Review.
- **Ostrá prevádzka s telefonovaním:** naviac fyzicky overiť hovory na iPhone
  (zvonenie pri zamknutí, zvuk, VoIP push) a až potom ich povoliť pre
  produkciu; dnes sú zámerne iba v TEST variante.

## 2. Čo aplikácia má

| Oblasť | Obsah | Overené |
| --- | --- | --- |
| Prihlásenie | e-mail a heslo, zabudnuté heslo cez web, relácia v Keychain, odhlásenie, prostredie TEST/produkcia bez prepínača | Expo Go, TEST |
| Kostra | Prehľad, spodná lišta s vlastnými modulmi, Moduly, Účet, Hľadať, Upozornenia, lišta hovoru, Späť v hornej lište | prehliadačový náhľad, Expo Go |
| Hovory | Ústredňa (stav, hovory na účte, nové číslo), História s filtrami, Spätné volania (prevziať, vybaviť, zrušiť), detail hovoru a záznam po hovore | náhľad, TEST API |
| Prípady | zoznam a filtre, detail, nový prípad a úpravy, poznámky, dispečer prípadu, prílohy, úlohy prípadu, odovzdanie, mapa, navigácia, poloha telefónu | náhľad, TEST API |
| Moje úlohy | zoznam, detail, zmena stavu, kontrola, správy | náhľad, TEST API |
| Nástroje | vozidlo podľa EČV/VIN, trasa, mapa, flotila | náhľad, TEST API |
| Koncepty | rozpísané formuláre v chránenom úložisku, obnovenie a zahodenie | náhľad |
| Telefonovanie | natívny modul `linka-voice` (Telnyx iOS SDK 4.2.2, CallKit, PushKit) | iba kompilácia a simulátor; **fyzicky neoverené** |
| Android | TEST APK z predchádzajúcich fáz | bez telefonovania |

## 3. Čo chýba na každodenné používanie

### Blokuje ostrú prevádzku

1. **Mobilné API na produkčnom serveri.** Všetky `/api/mobile/v1/*` sú iba
   v `dev`. Produkcia (`main`) je na vydaní #438; od neho je v `dev` 51 PR,
   aj inej práce (telefónia, Sentry, infraštruktúra). Vydanie musí mať
   presný rozsah, overenie na TEST a výslovné schválenie.
2. **Produkčné migrácie.** Podľa porovnania názvov chýba na produkcii 9
   migrácií z repozitára: `assistance_line_labels`, `queue_escalation_setting`,
   `provider_journal_batch`, `apply_critical_rows`, `call_history_search`,
   `incoming_routing_workspace`, `assistance_directory_starters`,
   `case_owner_assignment` (priradenie dispečera z mobilu) a
   `towing_work_orders` (zákazky odťahu za prepínačom). Časť môžu byť dáta
   alebo zmeny už aplikované pod iným názvom; každú treba pred vydaním prejsť
   a výslovne schváliť pre produkčný projekt.
3. **Produkčný build aplikácie** ešte nikdy nevznikol. Chýba ikona aplikácie
   (1024 × 1024 bez priehľadnosti), spúšťacia obrazovka a skutočná verzia
   v Účte (dnes napevno „0.1.0“).
4. **Odkaz na zásady ochrany súkromia v aplikácii** a verejná stránka zásad
   pre mobil (Apple 5.1.1(i)). Existuje iba stránka o nahrávaní hovorov.
   Treba aj verejnú stránku podpory s kontaktom; návod na webe je za prihlásením.
5. **Demo účet pre App Review** (Apple 2.1): samostatná demo organizácia
   s vymyslenými údajmi na produkcii, aby recenzent nevidel zákazníkov.

### Telefonovanie z aplikácie

6. **Fyzické overenie na iPhone** podľa [akceptácie](iphone-voice-test.md#akceptácia-na-fyzickom-iphone):
   zvonenie pri zamknutí, obojstranný zvuk, VoIP push, súbeh webu a mobilu.
7. **Povolenie pre produkciu:** kód hlasu je zámerne iba v TEST variante a
   server ho púšťa iba v dedikovanom TEST projekte. Pre produkciu treba
   úpravu kódu, produkčný Telnyx prístup a push credential (APNs) a
   prepínače, všetko so schválením. Do vtedy hovory ostávajú na webe a
   stolových telefónoch; mobil ich iba ukazuje (lišta hovoru, detail).

### Dôležité pre pohodlné používanie

8. **Push notifikácie** (nová úloha, spätné volanie po termíne, priradený
   prípad). Dnes sa upozornenia ukážu iba v otvorenej aplikácii. Treba
   registráciu zariadení, odosielanie zo servera cez APNs a nastavenie v Účte;
   ukladanie tokenov vyžaduje migráciu.
9. **Hlásenie pádov** (napr. Sentry pre React Native), aby sme o chybe
   vedeli skôr než od používateľa.
10. **Aktualizácie:** natívny build dnes nepreberá OTA aktualizácie, každá
    oprava je nový build a review. Rozhodnúť, či zapnúť EAS Update pre
    opravy JavaScriptu, a doplniť serverovú kontrolu minimálnej verzie
    (stará verzia dostane výzvu na aktualizáciu).
11. **Stav Dostupný/Pauza z mobilu** je dnes dostupný iba s pripojeným
    natívnym telefónom; bez hlasu sa mení na webe.

### Neskôr alebo kozmetika

12. Odovzdanie prípadu v novom vzhľade (náhľad preň potrebuje náhradné API).
13. Moduly ďalších rolí (vodič, zákazky odťahu, pristavenie, fakturácia…);
    vodič má dnes webovú stránku `/vodic`.
14. Android a Google Play (FCM, Telnyx Android) po iPhone pilote.

## 4. Čo vyžaduje Apple

### 4.1 Účet a zmluvy

- **Apple Developer Program** 99 USD ročne. Pre firmu členstvo
  **organizácie**: D-U-N-S číslo právnickej osoby, verejný web na doméne
  firmy, firemný e-mail a osoba oprávnená zaväzovať firmu. Meno predajcu
  v App Store je potom názov firmy.
- Pre bezplatnú aplikáciu stačí základná zmluva; bankové a daňové údaje netreba.
- **EÚ DSA status obchodníka:** pri distribúcii cez App Store v EÚ (aj
  nezaradenej) treba v App Store Connect vyplniť status obchodníka a kontakt.

### 4.2 Technické požiadavky

- Od 28. 4. 2026 build z **Xcode 26 a iOS 26 SDK**; aktuálne EAS obrazy
  pre Expo SDK 54+ to spĺňajú, overí sa pri prvom nahraní.
- Registrácia App ID `sk.linkapomoci.dispecing` (a `.test`) so schopnosťou
  Push Notifications; certifikáty a provisioning profily spravuje EAS.
- **APNs kľúč (.p8)** a pre Telnyx VoIP Services certifikát podľa
  [postupu](iphone-voice-test.md#zapojenie-po-schválení-apple).
- **Pozadie iba na určený účel** (2.5.4): `voip` a `audio` len pre hovory;
  každý PushKit push hlási hovor do CallKit (máme).
- **Popisy oprávnení** v Info.plist: fotoaparát, fotky, poloha (máme),
  mikrofón (zatiaľ iba v TEST voice variante).
- **Privacy manifest** (dôvody pre UserDefaults, časy súborov, čas od štartu,
  voľné miesto): doplniť do `app.config.ts`; chýbajúce dôvody Apple vráti
  e-mailom po nahratí.
- **Šifrovanie (export compliance):** aplikácia používa HTTPS a WebRTC
  (štandardné algoritmy); odpoveď treba potvrdiť pri prvom nahraní.
- iPad netreba (`supportsTablet: false`), takže netreba ani iPad snímky.

### 4.3 App Review a obsah

- **2.1:** finálna verzia bez zástupných textov a pádov, **demo účet**
  a bežiaci backend.
- **3.2:** aplikáciu pre jednu firmu a jej zamestnancov Apple vo verejnom
  App Store zamieta; použiť nezaradenú distribúciu alebo Custom app
  (tabuľka nižšie).
- **4.8:** Prihlásenie cez Apple netreba (firemné účty).
- **5.1.1(i):** odkaz na zásady ochrany súkromia v App Store Connect **aj
  v aplikácii**. Zásady musia uviesť, aké údaje, prečo, komu a ako dlho,
  a ako požiadať o vymazanie.
- **5.1.1(v):** mazanie účtu v aplikácii je povinné iba vtedy, keď sa v nej
  dá účet založiť. U nás účty zakladá administrátor; uvedie sa to
  v poznámkach pre review.
- **App Privacy (štítky):** kontaktné údaje (meno, e-mail), presná poloha
  iba na pokyn, fotografie a dokumenty, obsah (poznámky, prípady),
  identifikátory používateľa a zariadenia; pri telefonovaní zvuk hovoru,
  pri hlásení pádov diagnostika.
- **Veková kategória:** nový dotazník (4+/9+/13+/16+/18+).
- **Metadáta:** jedinečný názov (do 30 znakov), podnázov, popis, kľúčové
  slová, kategória Business, URL podpory a súkromia, snímky iPhone 6,9"
  (napr. 1320 × 2868, 1–10 kusov), kontakt a poznámky pre review.
- **CallKit v Číne:** čínsky App Store CallKit nepovoľuje; územie obmedziť
  (napr. iba Slovensko).

### 4.4 Spôsob distribúcie

| Cesta | Review | Pre koho | Obmedzenia | Na čo |
| --- | --- | --- | --- | --- |
| TestFlight interný | nie | do 100 členov tímu v App Store Connect | build platí 90 dní | pilot |
| TestFlight externý | áno (beta) | do 10 000 cez pozvánku alebo odkaz | build platí 90 dní | širší pilot |
| Ad Hoc | nie | registrované iPhony (UDID) | do 100 zariadení ročne | skúšky hovorov |
| Nezaradená v App Store | áno + žiadosť | ktokoľvek s odkazom, prístup riadi prihlásenie | žiadosť podáva držiteľ účtu po odoslaní na review | **ostrá prevádzka** |
| Custom app (Apple Business Manager) | áno | organizácie v ABM, cez MDM alebo kódy | jedna krajina, kódy sa nedajú odobrať | ak firma používa MDM |

Odporúčanie: pilot cez Ad Hoc alebo interný TestFlight hneď po licencii,
ostrá prevádzka cez **nezaradenú distribúciu** v App Store, obmedzenú na
Slovensko.

## 5. Čo potrebujeme pripraviť my

| Položka | Kto | Stav |
| --- | --- | --- |
| Schválené Apple členstvo (typ: organizácia / jednotlivec) | majiteľ | čaká |
| Vydavateľ a názov v App Store („Linka pomoci“ vs. „Pomoc Motoristom“) | majiteľ | rozhodnúť |
| Zásady ochrany súkromia pre mobil a stránka podpory (text, prevádzkovateľ) | majiteľ + vývoj | chýba |
| Ikona a spúšťacia obrazovka (z existujúcej značky) | vývoj, schválenie majiteľ | chýba |
| Vydanie servera s mobilným API na produkciu | vývoj, schválenie majiteľ | čaká |
| Produkčné migrácie (zoznam v časti 3) | vývoj, schválenie majiteľ | čaká |
| Demo organizácia s vymyslenými údajmi na produkcii | vývoj, schválenie majiteľ | chýba |
| Telnyx a APNs pre produkčný hlas | vývoj, schválenie majiteľ | po TEST akceptácii |
| Push notifikácie, hlásenie pádov, kontrola verzie | vývoj | chýba |
| Texty do App Store, poznámky pre review, snímky | vývoj, schválenie majiteľ | chýba |

## 6. Poradie

**Teraz, bez licencie a bez zásahu do produkcie**

1. Ikona a spúšťacia obrazovka, verzia a build v Účte.
2. Odkazy v Účte: Zásady ochrany súkromia a Podpora (po schválení textov).
3. Privacy manifest a príprava odpovedí pre App Store Connect.
4. Serverová kontrola minimálnej verzie aplikácie.
5. Hlásenie pádov pripravené tak, aby sa zaplo nastavením.
6. Push notifikácie: návrh, kód a migrácia na schválenie.
7. Odovzdanie prípadu v novom vzhľade.
8. Texty do App Store v slovenčine a plán snímok.

**V deň licencie (asi 1 deň)**

1. App ID, push, APNs kľúč, Telnyx TEST push credential.
2. Podpísaný TEST build na registrované iPhony a interný TestFlight.
3. Začiatok fyzickej akceptácie telefonovania.

**Ostrá prevádzka**

1. Vydanie servera a schválené migrácie na produkciu.
2. Demo organizácia, produkčný build, snímky, metadáta, review.
3. Žiadosť o nezaradenú distribúciu, odkaz pre dispečerov.
4. Po prijatí hovorov na TEST ich povolenie pre produkciu ako samostatné vydanie.

## Zdroje

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [SDK minimum requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution/)
- [Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods)
- [Expo: Apple privacy manifest](https://docs.expo.dev/guides/apple-privacy/)
- [Expo: App Store Connect minimum SDK 26](https://expo.dev/blog/app-store-connect-minimum-sdk-26)
- [Expo: TestFlight](https://docs.expo.dev/submit/testflight/)
- [Apple fórum: Guideline 3.2 Business](https://developer.apple.com/forums/thread/704518)
