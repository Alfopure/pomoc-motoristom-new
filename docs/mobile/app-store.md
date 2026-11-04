# Dispatching v App Store – podklady

## Stav podania 1.0 (4. 11. 2026)

- **Podané 4. 11. 2026**, verzia 1.0, build 3 z `main` `eebaa832`, stav Waiting for Review.
  App Store Connect `6830148973`, bundle `sk.linkapomoci.dispecing`, SKU `dispatching-prod`.
- **Vydanie je manuálne a nesmie sa spustiť, kým Apple neschváli Unlisted.** Žiadosť
  o Unlisted bola podaná 4. 11. hneď po podaní na kontrolu. Ak by sa appka vydala skôr,
  ostala by verejná natrvalo (spôsob distribúcie sa po schválení nedá zmeniť).
- Krajiny SK, CZ, HU, PL; zadarmo; DSA obchodník MICT, s. r. o. aktívny (27 krajín EÚ,
  verejný kontakt +421 910 988 882, info@alfopure.tech).
- Štítky App Privacy publikované (12 typov údajov, všetko „App Functionality“, prepojené
  s používateľom, bez sledovania), zhodné s privacy manifestom. Telnyx call reports sú
  v appke vypnuté (`enableCallReports: false`).
- Recenzentský účet „Apple Review“ (`michal.michalek+applereview@alfopure.tech`, heslo je
  len v App Store Connect → App Review Information): Dispečer + Pristavovač + Vodič +
  miestny dispečer pobočky „Kontrola Apple“. **Musí ostať aktívny** aj po schválení.
  Ukážkové dáta: pristavenie ponúknuté recenzentovi (platí do 6. 11. 2026, potom vydať
  nové), jazda v Moja práca (termín 10. 11.) a požiadavka pobočky. Recenzent volá len na
  testovaciu linku +421 2 3240 8774 (TEST). K podaniu je priložené video prichádzajúceho
  hovoru na zamknutom iPhone.
- Snímky 6,7"/6,9" (1290 × 2796) z produkčnej appky s recenzentským účtom; skutočné
  číslo spätného volania je rozmazané.

### Ďalšie kroky (stav 4. 11. 2026, pokračovať v novom chate)

1. **Čakať na Apple.** E-mail o kontrole 1.0 a o Unlisted. Po schválení kontroly
   **nevydávať, kým nepríde schválenie Unlisted.** Potom vydať manuálne a poslať odkaz.
2. **Demo dáta recenzenta:** pristavenie platí do 6. 11. 2026, potom vydať nové
   (recenzent `2d9d9ab5-…` v pobočke „Kontrola Apple“); demo jazda má termín 10. 11.
3. **Po vydaní 1.0:**
   - zapnúť mobilné latency flagy stage D v produkcii a urobiť skúšobný hovor,
   - obmedziť recenzentský účet, aby nevidel skutočné prípady (musí ostať aktívny),
   - produkcia `sip_domain: eu` (`EU_SIP_DOMAIN_PROVEN`).
4. **Verzia 1.1 s OTA aktualizáciami (rozhodnutie majiteľa 4. 11. 2026).** Majiteľ chce
   časté zmeny layoutu a menšie funkcie s nasadením do jedného dňa. Apple kontroluje
   50 % podaní do 24 h a 90 % do 48 h, čo to nezaručí. Preto:
   - zapnúť `expo-updates` (EAS Update) s `runtimeVersion` a **podpisovaním aktualizácií**
     (Expo code signing), kanály TEST a produkcia, najprv TEST a po súhlase majiteľa produkcia;
   - cez OTA iba JS, štýly, texty a layout v rámci existujúcich funkcií (pravidlo 2.5.2);
     nové povolenia, natívny kód, knižnice a SDK vždy novou verziou cez App Review;
   - 1.1 pôjde raz cez App Review, potom sú bežné zmeny u ľudí pri ďalšom spustení appky.
5. **Server, čaká na súhlas s produkciou:** PR #566, zrozumiteľná chyba „Máte rozbehnutú
   inú prácu“ v Pristaveniach. Je na TEST (`dev` `942f5374`), do `main` až po súhlase majiteľa.
6. **Otvorené z volaní:** vyzváňací tón počas zvonenia zákazníka (SDK 31006, falošné
   `call_interruption`); konzultácia a prepojenie na `eu` overiť naživo.

Overené na zariadení 4. 11. 2026: produkčné hovory (odchádzajúce aj prichádzajúce na
zamknutom iPhone), produkčné notifikácie (Expo receipt `ok`) a poloha na pozadí pri
zamknutom telefóne s povolením „Pri používaní“ (TEST, 7 polôh za 3 minúty počas pohybu).


| Položka | ID | Platí do | Dôsledok |
|---|---|---|---|
| VoIP Services certifikát (produkcia) | `7VXUH8LBC6`, Telnyx push credential `421c315e…` | **3. 12. 2027** | prestane zvoniť pri zamknutom telefóne |
| Apple Distribution certifikát | `54NCTXKNLT` | 22. 10. 2027 | nedá sa podpísať build |
| App Store profil produkcie | `YNMG98U25U` | 22. 10. 2027 | nedá sa podpísať build |
| APNs kľúč (Expo, iba téma produkcie) | `NVGAUGKD6Q` | neexpiruje | — |

Súkromné kľúče sú iba na Macu majiteľa v `~/conductor/builds/dispatching-test/private/signing/`.
Pred obnovou VoIP certifikátu vytvoriť nový Telnyx iOS push credential a pripojiť ho
na `pomoc-motoristom-webrtc`.


Podklady pre App Store Connect pripravené 20. 10. 2026, doplnené rozhodnutiami
majiteľa z 3. 11. 2026 (App Store Connect `6830148973`, SKU `dispatching-prod`). Vypĺňa ich vydavateľ
**MICT, s. r. o.** po schválení Apple Developer Program. Texty a právne
formulácie má pred odoslaním skontrolovať majiteľ.

## Základné údaje

| Pole | Hodnota |
|---|---|
| Názov | **Dispečing – Linka pomoci** v obchode; na ploche „Dispečing“ (`CFBundleDisplayName`; `name` ostáva „Dispatching“ ako ASCII názov Xcode projektu) |
| Podnadpis (do 30 znakov) | Mobilný dispečing asistencie |
| Bundle ID | `sk.linkapomoci.dispecing` (produkcia), `.test` pre TEST |
| Kategória | Business; vedľajšia Productivity |
| Vek | 4+ |
| Distribúcia | nezaradená (Unlisted) – žiadosť hneď pri prvom podaní, manuálne vydanie; Apple Business (Custom App) len ako záloha |
| Krajiny | Slovensko, Česko, Maďarsko, Poľsko (nie Čína kvôli CallKit, nie Francúzsko kvôli šifrovaciemu vyhláseniu) |
| Jazyk | slovenčina (`CFBundleDevelopmentRegion = sk`) |
| Podpora | https://dispecing.linkapomoci.sk/aplikacia/podpora |
| Ochrana súkromia | https://dispecing.linkapomoci.sk/aplikacia/sukromie |
| Verzia | `1.0.0` (`app.config.ts`); build čísluje EAS |

## Texty

**Propagačný text** (do 170 znakov): Prípady, úlohy, hovory a spätné volania
dispečingu Linky pomoci v telefóne – pre dispečerov, ktorí sú práve mimo
pracoviska.

**Popis:**

> Dispečing je aplikácia pre dispečerov Linky pomoci motoristom. Je určená
> výhradne pracovníkom dispečingu; účet zakladá organizácia.
>
> • Prehľad: hovory na vašom účte, spätné volania, prípady a úlohy na jednom mieste.
> • Hovory: aktívne hovory, história a spätné volania.
> • Prípady: hľadanie, detail, poznámky, prílohy, priradenie dispečera a odovzdanie.
> • Úlohy a spätné volania: čo treba vybaviť a do kedy.
> • Notifikácie: pridelená úloha alebo prípad, termín úlohy a spätné volanie po
>   termíne, aj pri zamknutom telefóne.
>
> Aplikácia neobsahuje reklamu ani sledovanie.

Popis smie sľubovať iba to, čo odoslaný build vie (Guideline 2.3). Telefonovanie
z aplikácie (prijatie, volanie, podržanie, prepojenie, zastavenie nahrávania) sa do
popisu doplní až s buildom, ktorý ho má zapnuté v produkcii. Riadok o notifikáciách
platí, až keď má produkcia zapnuté `MOBILE_PUSH_ENABLED` a tabuľku zariadení;
inak ho pred odoslaním vynechať.

**Kľúčové slová** (do 100 znakov): dispečing,asistencia,odťah,prípady,úlohy,hovory,spätné volanie,ústredňa

## Štítky súkromia (App Privacy)

Zhodné s `ios.privacyManifests` v `mobile/app.config.ts`. Všetko je **spojené
s používateľom**, **nepoužíva sa na sledovanie**, účel **funkčnosť aplikácie**:

- Kontaktné údaje: meno, e-mail, telefónne číslo, adresa (miesto zásahu).
- Poloha: presná (dispečer na pokyn pri výbere miesta; pristavovač počas
  prijatého pristavenia, aj na pozadí).
- Obsah používateľa: fotografie, zvuk (hovory), iný obsah (poznámky).
- Identifikátory: ID používateľa, ID zariadenia (pripojenie k ústredni,
  identifikátor pre notifikácie a inštalácie).
- Diagnostika: údaje o pádoch a iné diagnostické údaje (maskované hlásenia chýb
  aplikácie, ktoré nie sú pádom).

## Ďalšie odpovede

- **Šifrovanie:** HTTPS ide cez systém, hovory však šifruje knižnica WebRTC
  v aplikácii (DTLS-SRTP, BoringSSL), štandardnými algoritmami, nie vlastnými.
  Apple vyžaduje exportnú dokumentáciu iba pri vlastnej kryptografii alebo pri
  štandardnej kryptografii v predaji vo Francúzsku. Francúzsko je z krajín
  vynechané, preto dokumentácia netreba a `ITSAppUsesNonExemptEncryption = false`.
  Overené 3. 11. 2026: upload s `true` bez kódu Apple odmietol (ITMS-90592) a
  App Store Connect API vyhlásenie pre túto kombináciu odmietlo vytvoriť.
  Ak by sa raz pridalo Francúzsko, treba vyhlásenie s dokumentmi a kód
  `ITSEncryptionExportComplianceCode`.
- **Prihlásenie pre kontrolu Apple (Guideline 2.1):** rozhodnutie majiteľa
  z 3. 11. 2026: samostatný účet len pre kontrolu, **natrvalo aktívny** (Apple
  ho vyžaduje aj pri ďalších verziách), bez MFA, iba v testovacej pobočke
  „Kontrola Apple“ (miestny dispečer + pristavovač) s ukážkovými dátami, aby
  nevidel skutočných zákazníkov.
- **Poloha na pozadí (2.5.4, 5.1.1):** iba pre pristavovača a vykonávateľa
  jazdy a iba počas práce, ktorú prijal. Od 3. 11. 2026 aplikácia žiada **iba
  „Pri používaní“**, nikdy „Vždy“: sledovanie sa spustí pri otvorenej aplikácii
  a pokračuje na pozadí s modrým ukazovateľom. Ak iOS aplikáciu ukončí, poloha
  sa obnoví po jej otvorení. Text pre „Vždy“ v Info.plist ostáva iba preto, že
  ho vyžaduje prilinkovaný kód expo-location (ITMS-90683). Do poznámky pre
  kontrolu: „Location is requested only as While Using, after the driver accepts
  a job. It keeps updating in the background with the blue indicator so the
  dispatcher sees the driver on the way; it stops when the job ends or the
  driver logs out. The app never asks for Always.“
- **Zrušenie účtu (5.1.1(v)):** aplikácia nedovoľuje registráciu; účty zakladá
  a ruší organizácia. V Účte je pre každú rolu riadok **Zrušenie účtu**, ktorý
  otvorí postup na stránke Ochrana súkromia (`#rights`).
- **Poznámka pre kontrolu:** „Interná aplikácia pre dispečerov asistenčnej
  služby Linka pomoci. Prístup len pre zamestnancov, distribúcia ako unlisted.
  Účet pre kontrolu: … Telefonovanie vyžaduje pripojenie k ústredni v module Hovory.“
- **Telefonovanie v produkčnom builde (2.5.4):** od 29. 10. 2026 má build
  z profilu `production` natívne telefonovanie (CallKit, PushKit, background
  režimy `audio` a `voip`); na serveri je vypnuté
  ([stav](iphone-voice-test.md#produkčné-telefonovanie-pripravené-vypnuté)).
  Taký build odoslať na kontrolu až vtedy, keď si kontrolór môže hovor
  vyskúšať, inak hrozí zamietnutie pre nevyužitý `voip` režim.
- **Notifikácie v produkčnom builde:** Push Notifications na App ID a APNs kľúč
  (.p8) nahratý do Expo (`eas credentials`); plugin `expo-notifications` je
  v `app.config.ts`. Ak má projekt Expo zapnuté zabezpečené posielanie, server
  potrebuje `EXPO_ACCESS_TOKEN`.

## Obrázky

- Ikona 1024 × 1024 bez priehľadnosti: `mobile/assets/icon.png`; TEST a DEV majú
  vlastnú s pásom (`icon-test.png`, `icon-development.png`).
- Úvodná obrazovka: `mobile/assets/splash-icon.png` na pozadí `#F2F2F7`.
- Snímky pre 6,9" iPhone (1290 × 2796): vytvoriť z TEST so vzorovými údajmi,
  nie zo skutočných prípadov.
