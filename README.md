# Linka pomoci motoristom - dispečing

Next.js + TypeScript + Tailwind základ pre pracovný dispečing Pomoc Motoristom. UI beží proti Supabase (s deterministickým mock fallbackom) a repozitár smeruje na produkčný foundation stack: Supabase, telefónia cez Telnyx (Call Control, WebRTC, Messaging), provider adaptéry a organizáciou konfigurovateľný model.

Tento repozitár je **produkčný dispečing** od presunu domény 21. 9. 2026. Má oddelené produkčné a TEST projekty Supabase (Frankfurt) aj Vercel (región `fra1`). Vyradený VIPTel dispečing a jeho infraštruktúra sa nemenia; jeho pôvodný Supabase naďalej obsahuje inú živú aplikáciu.

## Spustenie

```bash
pnpm install
pnpm dev
```

Aplikácia beží na [http://localhost:3000](http://localhost:3000).

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

Oba dedikované projekty používajú Vercel Production target; prostredie aplikácie a databázu určuje príslušný projekt. Po merge do `dev` overiť zmenené správanie na kanonickom TESTE a odovzdať jeho commit majiteľovi. Bežný produkčný release nasleduje až po jeho výslovnom schválení. Výnimky pre vybranú zmenu a priamu produkčnú opravu opisuje [release workflow](docs/operations/release-workflow.md). Preview, TEST aj produkcia spúšťajú rovnakú build gate: Vitest, TypeScript check a Next.js build. Obe vetvy vyžadujú PR a úspešný povinný Vercel check.

Pracovný Preview zdieľa TEST Supabase, preto jeho zápisy ovplyvňujú stabilný TEST. Live integrácie zostávajú v Preview vypnuté; stabilný TEST smie používať iba overené samostatné TEST zdroje podľa [TEST runbooku](docs/operations/full-test-environment.md). `dispecing-test.vercel.app` je napriek názvu produkčný alias. Generovaný `dev` Preview alias nenahrádza stabilný TEST.

Telefónne migrácie a seed sa spúšťajú iba na výslovnú žiadosť pre presný SQL rozsah a konkrétny Supabase projekt. Jediný povolený Vercel cron je `*/5 * * * *` na `/api/telephony/cron`, nezávisle v oboch dedikovaných projektoch. Podrobný postup je v [CONTRIBUTING.md](CONTRIBUTING.md) a [Vercel runbooku](docs/deployment-vercel.md).

## Demo dáta

Demo seed je samostatná operácia po výslovnom schválení cieľového projektu. Pred spustením over efektívny Supabase projekt z `.env.local`; lokálny Development automaticky nepoužíva TEST. Seed neaplikuj na skopírovaný snapshot ani ako súčasť bežného nasadenia:

```bash
pnpm seed:demo
```

Seed pridá konkrétne pobočky v Bratislave, Žiline, Liptovskom Mikuláši a Košiciach, odťahovky, náhradné vozidlá, prípady, úlohy, päť telefónnych liniek s partnerskými štítkami a mock hovory (`provider = 'telnyx'`). Používa stabilné ID a `upsert`; opakované spustenie môže prepísať existujúce záznamy s rovnakým ID.

## Aktuálny stav

Aplikácia používa Supabase ako hlavný zdroj dát, Google Maps/Places v prehliadači a Google Routes API cez server route. UI stále obsahuje mock fallback, aby ostalo použiteľné bez Supabase alebo pri výpadku mapových služieb.

Telefónia beží na Telnyxe (Call Control pre hovory, WebRTC pre prehliadačový telefón, Messaging pre odchádzajúce SMS). Fáza 2 priniesla podpísané webhooky s claim ledgerom, stavový automat hovoru (relácie a legy), ring plány a skupiny, pracovný čas, IVR vstup, prezenciu a zariadenia operátorov, PhoneBar s čakárňou, hold/prepojenie/park, SMS transport a Supabase Realtime broadcast. Telnyx sa nikdy nevolá priamo z prehliadača: webhooky a REST príkazy spracúva server, prehliadač číta normalizované dáta a telefonuje cez WebRTC s krátkodobým tokenom vydaným serverom.

Bez `TELNYX_API_KEY` aplikácia naďalej beží v režime **„Telefónia nie je nakonfigurovaná"**: log hovorov, spätné volania, adresár, výsledky hovorov a prepojenie hovoru s prípadom fungujú, ale telefónne routy vracajú 503 a UI zobrazí upozornenie. Oba kill switche (`TELNYX_LIVE_CALLS_ENABLED`, `TELNYX_SMS_LIVE_SENDS`) sú predvolene vypnuté a kombinujú sa s databázovými prepínačmi v `motorist_telephony_settings`. Zakazujú vytváranie nových odchádzajúcich vetiev/SMS; ovládanie a ukončenie existujúcich hovorov zostáva povolené pri zachovaní TEST provenance. Kontrakt je v [docs/telnyx-data-contract.md](docs/telnyx-data-contract.md), prevádzkové postupy v [docs/operations/telnyx-runbook.md](docs/operations/telnyx-runbook.md).

Dispečerská konzola používa Supabase Auth s prihlásením heslom a mapovaním na aktívne `motorist_profiles`. Všetky aplikačné tabuľky používajú prefix `motorist_`.

## Dokumentácia

- [Klientsky HTML návod](docs/client-guide.md) — `/navod` v aplikácii, samostatné HTML vydanie, screenshoty a spoločný zdroj pre budúceho AI pomocníka.
- `docs/source/MOTORIST_ASSISTANCE_KNOWLEDGE_BASE.md` - importovaný zdrojový discovery dokument.
- `docs/product-brief.md` - produktový rámec v1 demo.
- `docs/domain-model.md` - doménové entity, statusy a traceability mock dát.
- `docs/demo-flow.md` - klikateľný demo scenár a map fallback.
- `docs/architecture.md` - produkčný foundation návrh.
- `docs/data-model.md` - Supabase dátový model a hranice domény.
- `docs/security-model.md` - role, RLS, audit, secrets a GDPR poznámky.
- `docs/integration-strategy.md` - telefónia, SMS, mapy, fleet a AI cez provider adaptéry.
- `docs/client-configuration.md` - single-client first, multi-client-ready nastavenia.
- `docs/telnyx-data-contract.md` - dátový kontrakt telefónie na Telnyxe (webhooky, stavový automat, ring plány, retencia).
- `docs/operations/telnyx-runbook.md` - prevádzkové postupy telefónie (spiky, zaseknutý hovor, rotácia prístupov, kill switche).
- `docs/operations/telnyx-setup.md` - identifikátory Telnyx zdrojov (bez tajomstiev).
- `docs/deployment-vercel.md` - Vercel prostredia, build gate a produkčná/TEST doména.

## Foundation konfigurácia

`.env.example` obsahuje iba názvy premenných. Reálne Supabase, Telnyx, Google alebo SMS credentials nepatria do repozitára.
