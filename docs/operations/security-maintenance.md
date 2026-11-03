# Bezpečnostná údržba a technické odovzdanie

Aktualizované 2026-10-30. Tento dokument opisuje overiteľné kontroly a otvorené
prevádzkové úlohy. Kontrola kódu nie je certifikát ani úplný penetračný test.

## Kde začať

Nový vývojár potrebuje [lokálny postup](../development.md),
[architektúru](../architecture.md), [bezpečnostný model](../security-model.md)
a [release workflow](release-workflow.md). Prístup prideľ cez vlastný účet
s potrebnou rolou. Provider secrets a prístupy do produkcie nepatria do balíka
na zoznámenie s repozitárom. Produkčný a TEST projekt zostávajú oddelené.

## Opravy pripravené po kontrole

- Ukladanie webových príloh používa existujúcu databázovú transakciu s kontrolou
  verzie prípadu a skutočným používateľom. Konflikt vracia 409; používateľ načíta
  aktuálny stav a zopakuje upload. Pri nepotvrdenom výsledku sa najprv overí,
  či sa príloha uložila. Staré metadáta sa nevracajú cez novšiu zmenu kolegu.
- Čítanie nahrávok/prepisov má trvalý audit používateľa a zdroja; intervaly,
  minimalizáciu obsahu a správanie pri chybe opisuje bezpečnostný model.
- Vyradený skript `setup-ai-demo-copy.sh` skončí pred čítaním credentials alebo
  volaním nástrojov. Lokálny Supabase Auth smeruje iba na localhost.
- Mobilné CI zachytáva zmeny zdieľaných doménových/API kontraktov; aktuálny
  onboarding odlišuje offline testy od prihlásenej aplikácie na TESTE.

Ochrana verejnej obnovy hesla vyžaduje samostatnú databázovú migráciu a nasadenie
zodpovedajúcich serverových volaní. Nepovažuj ju za zapnutú iba na základe
existencie vetvy alebo pull requestu; skontroluj SQL aj nasadený commit.

## Závislosti

Kompatibilné opravy zahŕňajú Next/eslint-config-next 16.4.1, Vitest 4.1.12,
opravené Vite/Undici/Zod 4 a mobilný node-forge 1.4.2. Lockfiles sú súčasťou
zmeny. Audit z 2026-10-30 po aktualizácii stále uvádza:

| Oblasť | Zostávajúce hlásenie | Rozhodnutie |
| --- | --- | --- |
| Web, Telnyx SDK | UUID 7/8, moderate | Nevnucovať SDK nekompatibilnú hlavnú verziu. Sledovať upstream a konkrétne použitie postihnutých API. |
| Mobilné Expo nástroje | Zod 3, high | Expo deklaruje Zod 3 aj v aktuálnom upstream CLI. Nezameniť ho plošne za Zod 4. |
| Mobilné Expo nástroje | deepmerge, low | Publikovaná opravená verzia zatiaľ chýba. Build konfigurácia má pochádzať z dôveryhodného zdroja. |

Počet hlásení vrátane závislých balíkov: web 2 moderate; mobil 3 high a 5 low.
Tieto počty nepreukazujú dosiahnuteľný útok v aplikácii. Zároveň nejde o čistý
audit bez nálezov. Zdroje: [UUID](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq),
[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).

Opakuj `corepack pnpm@10.34.9 audit` v koreni a `npm audit` v `mobile/` pri
aktualizáciách a pred významným odovzdaním. Výsledok posudzuj spolu s cestou
závislosti a reálnym použitím; automatické major upgrady nie sú náhrada revízie.

## Čo musí doložiť prevádzkovateľ

| Kontrola | Potrebný dôkaz |
| --- | --- |
| Obnova dát | Úspešná skúška obnovy databázy aj privátnych súborov do izolovaného prostredia, čas obnovy a dátum. Samotná zapnutá záloha nestačí. |
| Administrátorské účty | MFA a aktuálni členovia GitHub/Vercel/Supabase; účty odídených spolupracovníkov odobraté. |
| Auth politika | Efektívne nastavenie hesiel a ochrany pred uniknutými heslami v každom projekte. |
| Prístup k repozitáru | Vedomé rozhodnutie o public/private viditeľnosti; kontrola histórie pred širším zdieľaním. |
| Uchovávanie dát | Schválené lehoty pre nahrávky, prepisy, prílohy a audit, vrátane overenia mazania. |
| Nasadenie | Commit a projekt z `/api/health/live`, pripravenosť a overenie zmeneného správania na kanonickom TESTE. |

Tieto cloudové a prevádzkové kontroly nemožno odvodiť z úspešného buildu.
Kompletný bootstrap prázdnej databázy zostáva samostatnou otvorenou úlohou;
historické migrácie neupravuj ani neaplikuj plošne v rámci onboardingu.
