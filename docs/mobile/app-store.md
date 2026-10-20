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
>
> Aplikácia neobsahuje reklamu ani sledovanie.

Popis smie sľubovať iba to, čo odoslaný build vie (Guideline 2.3). Telefonovanie
z aplikácie (prijatie, volanie, podržanie, prepojenie, zastavenie nahrávania) sa do
popisu doplní až s buildom, ktorý ho má zapnuté v produkcii.

**Kľúčové slová** (do 100 znakov): dispečing,asistencia,odťah,prípady,úlohy,hovory,spätné volanie,ústredňa

## Štítky súkromia (App Privacy)

Zhodné s `ios.privacyManifests` v `mobile/app.config.ts`. Všetko je **spojené
s používateľom**, **nepoužíva sa na sledovanie**, účel **funkčnosť aplikácie**:

- Kontaktné údaje: meno, e-mail, telefónne číslo, adresa (miesto zásahu).
- Poloha: presná (iba na pokyn pri výbere miesta).
- Obsah používateľa: fotografie, zvuk (hovory), iný obsah (poznámky).
- Identifikátory: ID používateľa, ID zariadenia (pripojenie k ústredni).
- Diagnostika: údaje o pádoch (maskované hlásenia chýb).

## Ďalšie odpovede

- **Šifrovanie:** `ITSAppUsesNonExemptEncryption = false` – HTTPS a pri hovoroch
  štandardné šifrovanie WebRTC (DTLS-SRTP knižnice Telnyx), teda bežne dostupné
  šifrovanie bez vlastného algoritmu. Odpovede na exportné otázky (vrátane
  francúzskeho vyhlásenia) potvrdí majiteľ v App Store Connect.
- **Prihlásenie pre kontrolu Apple (Guideline 2.1):** treba demo účet. Odporúčanie:
  samostatná demo organizácia v produkcii s vymyslenými údajmi, aby kontrolór
  nevidel skutočných zákazníkov. Vytvorenie vyžaduje výslovný súhlas majiteľa
  so zmenou produkčnej databázy.
- **Zrušenie účtu (5.1.1(v)):** aplikácia nedovoľuje registráciu; účty zakladá
  a ruší organizácia. Postup je na stránke Ochrana súkromia.
- **Poznámka pre kontrolu:** „Interná aplikácia pre dispečerov asistenčnej
  služby Linka pomoci. Prístup len pre zamestnancov, distribúcia ako unlisted.
  Demo účet: … Telefonovanie vyžaduje pripojenie k ústredni v module Hovory.“

## Obrázky

- Ikona 1024 × 1024 bez priehľadnosti: `mobile/assets/icon.png`; TEST a DEV majú
  vlastnú s pásom (`icon-test.png`, `icon-development.png`).
- Úvodná obrazovka: `mobile/assets/splash-icon.png` na pozadí `#F2F2F7`.
- Snímky pre 6,9" iPhone (1290 × 2796): vytvoriť z TEST so vzorovými údajmi,
  nie zo skutočných prípadov.
