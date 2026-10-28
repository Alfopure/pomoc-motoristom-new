# Android a Google Play — príprava

Cieľ: TEST aplikácia `sk.linkapomoci.dispecing.test` v Google Play **internom testovaní**, neskôr produkčná `sk.linkapomoci.dispecing`. Rozsah prvého Android buildu: prihlásenie, prípady, úlohy, Moja práca, Pobočka a push. Telefonovanie na Androide (Telnyx/FCM hovory) je samostatná neskoršia etapa.

## Čo je pripravené v kóde

- `mobile/app.config.ts`: Android package pre každý variant; `googleServicesFile` sa načíta z EAS premennej `GOOGLE_SERVICES_JSON` (typ *file*), lokálne a v CI chýba.
- `mobile/eas.json`: build profil `play-internal` (TEST, Android App Bundle) a submit profil `play-internal` (stopa *internal*, stav *draft*, kľúč servisného účtu z `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH`).
- Poloha na pozadí je na Androide blokovaná (`blockedPermissions`); poloha jazdy sa posiela iba pri otvorenej appke.

## Kroky majiteľa

1. **Google Play Console** — organizačný účet MICT, s.r.o. (D-U-N-S, 25 USD, overenie). Po schválení pozvať správcu vývoja (napr. `info@alfopure.tech`) cez *Používatelia a povolenia* s právom spravovať aplikácie a vydania.
2. **Firebase** — projekt (napr. „Dispatching“) s Android aplikáciou `sk.linkapomoci.dispecing.test`; stiahnuť `google-services.json`. Pre produkciu neskôr druhá Android aplikácia `sk.linkapomoci.dispecing`.
3. **Servisný účet Google Cloud** s prístupom do Play Console (vydania) — JSON kľúč pre `eas submit`.

## Kroky vývoja (po bodoch 1–3)

1. EAS: súborová premenná `GOOGLE_SERVICES_JSON` pre prostredie *preview* (TEST) a FCM V1 kľúč v Expo credentials (Android push).
2. `eas build --platform android --profile play-internal` (cloud alebo lokálne), kontrola package, verzie, API originu a TEST Supabase v balíku.
3. Prvé nahratie AAB do Play Console **ručne** (Google vyžaduje prvý upload cez konzolu), vytvoriť internú testovaciu stopu a zoznam testerov.
4. Ďalšie buildy: `eas submit --platform android --profile play-internal`.
5. Play Console: *Obsah aplikácie* — zásady ochrany súkromia `https://test.dispecing.linkapomoci.sk/aplikacia/sukromie` (produkcia vlastná URL), formulár *Bezpečnosť údajov* podľa privacy manifestu (meno, kontakt, poloha počas jazdy, fotky, identifikátory zariadenia; bez reklamy a sledovania), prístup pre kontrolu (testovací účet).

Cieľová úroveň API: nové aplikácie od 31. 8. 2026 musia cieliť na Android 16 (API 36); Expo SDK 57 to spĺňa, overí sa pri prvom builde. Organizačný účet nemá povinné 14-dňové uzavreté testovanie s 12 testermi.
