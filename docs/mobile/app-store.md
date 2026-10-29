# Dispatching v App Store – podklady

Podklady pre App Store Connect pripravené 20. 10. 2026. Vypĺňa ich vydavateľ
**MICT, s. r. o.** po schválení Apple Developer Program. Texty a právne
formulácie má pred odoslaním skontrolovať majiteľ.

## Základné údaje

| Pole | Hodnota |
|---|---|
| Názov | **Dispatching** (musí byť v App Store jedinečný; náhradne „Dispatching – Linka pomoci“) |
| Podnadpis (do 30 znakov) | Mobilný dispečing asistencie |
| Bundle ID | `sk.linkapomoci.dispecing` (produkcia), `.test` pre TEST |
| Kategória | Business; vedľajšia Productivity |
| Vek | 4+ |
| Distribúcia | nezaradená (unlisted) – žiadosť cez formulár Apple po prvom schválení |
| Podpora | https://dispecing.linkapomoci.sk/aplikacia/podpora |
| Ochrana súkromia | https://dispecing.linkapomoci.sk/aplikacia/sukromie |
| Verzia | pred prvým buildom pre App Store nastaviť `version` na `1.0.0`; build čísluje EAS |

## Texty

**Propagačný text** (do 170 znakov): Prípady, úlohy, hovory a spätné volania
dispečingu Linky pomoci v telefóne – pre dispečerov, ktorí sú práve mimo
pracoviska.

**Popis:**

> Dispatching je aplikácia pre dispečerov Linky pomoci motoristom. Je určená
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
- Diagnostika: údaje o pádoch (maskované hlásenia chýb).

## Ďalšie odpovede

- **Šifrovanie:** `ITSAppUsesNonExemptEncryption = false` – HTTPS a pri hovoroch
  štandardné šifrovanie WebRTC (DTLS-SRTP knižnice Telnyx), teda bežne dostupné
  šifrovanie bez vlastného algoritmu. Odpovede na exportné otázky (vrátane
  francúzskeho vyhlásenia) potvrdí majiteľ v App Store Connect.
- **Prihlásenie pre kontrolu Apple (Guideline 2.1):** rozhodnutie majiteľa
  z 20. 10. 2026: žiadna demo organizácia; kontrolór dostane účet v organizácii
  majiteľa (jeho firma je organizátor, s firmou klienta). Pred odoslaním: samostatný
  účet len pre kontrolu (nie osobný účet dispečera) s rolou Dispečer, ktorý sa po
  schválení deaktivuje. Kontrolór uvidí to, čo dispečer tejto organizácie.
- **Poloha na pozadí (2.5.4, 5.1.1):** iba pre rolu pristavovač a iba počas
  pristavenia náhradného vozidla, ktoré prijal; účel je v texte povolenia,
  iOS ukazuje modrý ukazovateľ a posielanie končí so skončením pristavenia
  alebo odhlásením. Do poznámky pre kontrolu: „Background location is used only
  by replacement-car drivers during a delivery they accepted, so the dispatcher
  sees where the car is; it stops when the delivery ends or the driver logs out.“
- **Zrušenie účtu (5.1.1(v)):** aplikácia nedovoľuje registráciu; účty zakladá
  a ruší organizácia. Postup je na stránke Ochrana súkromia.
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
