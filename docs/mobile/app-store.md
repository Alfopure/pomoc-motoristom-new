# Dispatching v App Store – podklady

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
  v aplikácii (DTLS-SRTP, BoringSSL). Produkčný build preto má
  `ITSAppUsesNonExemptEncryption = true` (TEST ostáva `false`) a App Store Connect
  sa pri builde spýta na šifrovanie: šifrovanie **áno**, typ „štandardné
  algoritmy namiesto alebo popri šifrovaní systému Apple“, nie vlastné;
  Francúzsko je z krajín vynechané. Ak App Store Connect vydá kód, pribudne
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
