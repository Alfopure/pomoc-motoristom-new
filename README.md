# Linka pomoci motoristom - dispečing

Produkčný dispečing Pomoc Motoristom: Next.js App Router, React, TypeScript a Tailwind; Supabase Auth/Postgres, telefónia Telnyx (Call Control, WebRTC, Messaging) a samostatná mobilná aplikácia Expo v `mobile/`.

Tento repozitár je **produkčný dispečing** od presunu domény 21. 9. 2026. Má oddelené produkčné a TEST projekty Supabase (Frankfurt) aj Vercel (región `fra1`). Vyradený VIPTel dispečing a jeho infraštruktúra sa nemenia; jeho pôvodný Supabase naďalej obsahuje inú živú aplikáciu.

## Spustenie

Začni [lokálnym vývojovým postupom](docs/development.md): pripnutý pnpm, TEST konfigurácia, prihlásenie a hranice databázového bootstrapu. Samotné `pnpm dev` nevytvorí databázu ani používateľa. Aplikácia beží na [http://localhost:3000](http://localhost:3000).

## Overenie

```bash
pnpm lint
pnpm typecheck
pnpm exec vitest run
node --test tests/*.test.mjs
pnpm build
```

## Vetvy a deployment

Trvalá vývojová vetva je `dev`. Každá bežná zmena začína z aktuálneho `dev`, pokračuje samostatnou pracovnou vetvou, Vercel Preview a pull requestom späť do `dev`. Aplikácia vyžaduje Supabase prihlásenie; pracovný Preview môže navyše podliehať Vercel ochrane.

| | Stabilný TEST | Produkcia |
|---|---|---|
| Doména | https://test.dispecing.linkapomoci.sk | https://dispecing.linkapomoci.sk |
| Vetva / Vercel projekt | `dev` / `pomoc-motoristom-test` | `main` / `pomoc-motoristom-dispatching` |
| Supabase | `nzpnqdstvkfncflgqlny` | `ifpaeegaesdmljfkdvcn` |

Oba dedikované projekty používajú Vercel Production target; prostredie aplikácie a databázu určuje príslušný projekt. Po merge do `dev` overiť zmenené správanie na kanonickom TESTE a odovzdať jeho commit majiteľovi. Bežný produkčný release nasleduje až po jeho výslovnom schválení. Výnimky pre vybranú zmenu a priamu produkčnú opravu opisuje [release workflow](docs/operations/release-workflow.md). Preview, TEST aj produkcia spúšťajú rovnakú build gate z `vercel.json`: `pnpm test` (Vitest aj Node testy), TypeScript, kontrolu diagnostiky prehliadača a diagnostický build wrapper, ktorý spustí Next.js build. Obe vetvy vyžadujú PR a úspešný povinný Vercel check.

Pracovný Preview zdieľa TEST Supabase, preto jeho zápisy ovplyvňujú stabilný TEST. Live integrácie zostávajú v Preview vypnuté; stabilný TEST smie používať iba overené samostatné TEST zdroje podľa [TEST runbooku](docs/operations/full-test-environment.md). `dispecing-test.vercel.app` je napriek názvu produkčný alias. Generovaný `dev` Preview alias nenahrádza stabilný TEST.

Telefónne migrácie a seed sa spúšťajú iba na výslovnú žiadosť pre presný SQL rozsah a konkrétny Supabase projekt. Jediný povolený Vercel cron je `*/5 * * * *` na `/api/telephony/cron`, nezávisle v oboch dedikovaných projektoch. Podrobný postup je v [CONTRIBUTING.md](CONTRIBUTING.md) a [Vercel runbooku](docs/deployment-vercel.md).

## Demo dáta

Demo seed je samostatná operácia po výslovnom schválení cieľového projektu. Pred spustením over efektívny Supabase projekt z `.env.local`; lokálny Development automaticky nepoužíva TEST. Seed neaplikuj na skopírovaný snapshot ani ako súčasť bežného nasadenia:

```bash
pnpm seed:demo
```

Seed pridá konkrétne pobočky v Bratislave, Žiline, Liptovskom Mikuláši a Košiciach, odťahovky, náhradné vozidlá, prípady, úlohy, päť telefónnych liniek s partnerskými štítkami a mock hovory (`provider = 'telnyx'`). Používa stabilné ID a `upsert`; opakované spustenie môže prepísať existujúce záznamy s rovnakým ID.

## Aktuálny stav

Aplikácia používa Supabase ako hlavný zdroj dát, Google Maps/Places v prehliadači a Google Routes API cez server route. Testovacie fixtures a lokálne demo cesty nenahrádzajú Supabase prihlásenie ani overenie reálnej prevádzky; pri výpadku služby sa riaď konkrétnym stavom UI.

Telefónia beží na Telnyxe (Call Control pre hovory, WebRTC pre prehliadačový telefón, Messaging pre odchádzajúce SMS). Fáza 2 priniesla podpísané webhooky s claim ledgerom, stavový automat hovoru (relácie a legy), ring plány a skupiny, pracovný čas, IVR vstup, prezenciu a zariadenia operátorov, PhoneBar s čakárňou, hold/prepojenie/park, SMS transport a Supabase Realtime broadcast. Telnyx sa nikdy nevolá priamo z prehliadača: webhooky a REST príkazy spracúva server, prehliadač číta normalizované dáta a telefonuje cez WebRTC s krátkodobým tokenom vydaným serverom.

Bez `TELNYX_API_KEY` aplikácia naďalej beží v režime **„Telefónia nie je nakonfigurovaná"**: log hovorov, spätné volania, adresár, výsledky hovorov a prepojenie hovoru s prípadom fungujú, ale telefónne routy vracajú 503 a UI zobrazí upozornenie. Oba kill switche (`TELNYX_LIVE_CALLS_ENABLED`, `TELNYX_SMS_LIVE_SENDS`) sú predvolene vypnuté a kombinujú sa s databázovými prepínačmi v `motorist_telephony_settings`. Zakazujú vytváranie nových odchádzajúcich vetiev/SMS; ovládanie a ukončenie existujúcich hovorov zostáva povolené pri zachovaní TEST provenance. Kontrakt je v [docs/telnyx-data-contract.md](docs/telnyx-data-contract.md), prevádzkové postupy v [docs/operations/telnyx-runbook.md](docs/operations/telnyx-runbook.md).

Dispečerská konzola používa Supabase Auth s prihlásením heslom a mapovaním na aktívne `motorist_profiles`. Všetky aplikačné tabuľky používajú prefix `motorist_`.

## Dokumentácia

- [Bezpečnostná údržba a odovzdanie](docs/operations/security-maintenance.md) — aktuálne opravy, zostávajúce závislosti a prevádzkové dôkazy.
- [Klientsky HTML návod](docs/client-guide.md) — `/navod` v aplikácii, samostatné HTML vydanie, screenshoty a spoločný zdroj pre budúceho AI pomocníka.
- `docs/source/MOTORIST_ASSISTANCE_KNOWLEDGE_BASE.md` - importovaný zdrojový discovery dokument.
- `docs/product-brief.md` - produktový rámec v1 demo.
- `docs/domain-model.md` - doménové entity, statusy a traceability mock dát.
- `docs/demo-flow.md` - klikateľný demo scenár a map fallback.
- `docs/architecture.md` - aktuálne hranice webu, mobilu a serverových integrácií.
- `docs/data-model.md` - Supabase dátový model a hranice domény.
- `docs/security-model.md` - role, RLS, audit, secrets a GDPR poznámky.
- `docs/integration-strategy.md` - telefónia, SMS, mapy, fleet a AI cez provider adaptéry.
- `docs/client-configuration.md` - single-client first, multi-client-ready nastavenia.
- `docs/telnyx-data-contract.md` - dátový kontrakt telefónie na Telnyxe (webhooky, stavový automat, ring plány, retencia).
- `docs/operations/telnyx-runbook.md` - prevádzkové postupy telefónie (spiky, zaseknutý hovor, rotácia prístupov, kill switche).
- `docs/operations/telnyx-setup.md` - identifikátory Telnyx zdrojov (bez tajomstiev).
- `docs/deployment-vercel.md` - Vercel prostredia, build gate a produkčná/TEST doména.

## Konfigurácia

`.env.example` obsahuje názvy premenných, lokálne predvolené hodnoty a zástupné hodnoty; nie je hotovou konfiguráciou TESTU. Reálne Supabase, Telnyx, Google alebo SMS credentials nepatria do repozitára.
