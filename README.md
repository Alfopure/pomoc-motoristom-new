# Linka pomoci motoristom - dispečing

Next.js + TypeScript + Tailwind základ pre pracovný dispečing Pomoc Motoristom. Aktuálne UI beží ako klikateľné demo s deterministickými mock dátami, ale repozitár už smeruje na produkčný foundation stack: Supabase, VIPTel bridge, provider adaptéry a organizáciou konfigurovateľný model.

## Spustenie

```bash
pnpm install
pnpm dev
```

Demo beží na [http://localhost:3000](http://localhost:3000).

## Overenie

```bash
pnpm lint
pnpm exec vitest run
pnpm typecheck
pnpm build
```

## Vetvy a deployment

Trvalá vývojová vetva je `dev`. Každá bežná zmena začína z aktuálneho `dev`, pokračuje samostatnou pracovnou vetvou a pull requestom späť do `dev`. Push pracovnej vetvy automaticky vytvorí verejne dostupný Vercel Preview; aplikácia na ňom naďalej vyžaduje Supabase prihlásenie.

Po merge sa `dev` automaticky nasadí na [dev.dispecing.linkapomoci.sk](https://dev.dispecing.linkapomoci.sk). Produkcia [dispecing.linkapomoci.sk](https://dispecing.linkapomoci.sk) sa vydáva iba pull requestom `dev -> main`. Preview a `dev` spúšťajú iba Next.js build. Produkcia pred nasadením spustí Vitest aplikačné testy, TypeScript check a Next.js build.

Preview aj `dev` používajú živé produkčné dáta z Frankfurt Supabase projektu, preto sú všetky zápisy reálne. Frontend workflow nespúšťa migrácie, workery, listenery, schedulery, živé integrácie ani Hetzner aktiváciu. Podrobný postup je v [CONTRIBUTING.md](CONTRIBUTING.md) a [docs/deployment-vercel.md](docs/deployment-vercel.md).

## Demo dáta

Demo Supabase dáta vieš opakovateľne doplniť cez service key z `.env.local`:

```bash
pnpm seed:demo
```

Seed pridá konkrétne pobočky v Bratislave, Žiline, Liptovskom Mikuláši a Košiciach, odťahovky, náhradné vozidlá, prípady, úlohy a VIPTel mock hovory. Používa stabilné ID a `upsert`, takže ho môžeš spustiť znova bez zmazania ručne vytvorených prípadov.

## Aktuálny stav

Demo používa Supabase ako hlavný zdroj dát, Google Maps/Places v prehliadači a Google Routes API cez server route. UI stále obsahuje mock fallback, aby ostalo použiteľné bez Supabase alebo pri výpadku mapových služieb.

Živý VIPTel WebSocket a reálne SMS odosielanie ešte nie sú zapojené. Dispečerská konzola používa Supabase Auth s prihlásením heslom a mapovaním na aktívne `motorist_profiles`. VIPTel sa nebude volať priamo z prehliadača; telefónne eventy pôjdu cez server-side bridge do Supabase a UI bude čítať normalizované dáta.

Online Supabase projekt už obsahoval cudzie tabuľky, preto foundation migrácia používa bezpečný prefix `motorist_` pre všetky nové tabuľky.

## Dokumentácia

- `docs/source/MOTORIST_ASSISTANCE_KNOWLEDGE_BASE.md` - importovaný zdrojový discovery dokument.
- `docs/product-brief.md` - produktový rámec v1 demo.
- `docs/domain-model.md` - doménové entity, statusy a traceability mock dát.
- `docs/demo-flow.md` - klikateľný demo scenár a map fallback.
- `docs/architecture.md` - produkčný foundation návrh.
- `docs/data-model.md` - Supabase dátový model a hranice domény.
- `docs/security-model.md` - role, RLS, audit, secrets a GDPR poznámky.
- `docs/integration-strategy.md` - VIPTel, SMS, mapy, fleet a AI cez provider adaptéry.
- `docs/client-configuration.md` - single-client first, multi-client-ready nastavenia.
- `docs/viptel-data-contract.md` - mapovanie VIPTel udalostí, REST backfill a nahrávky.

## Foundation konfigurácia

`.env.example` obsahuje iba názvy premenných. Reálne Supabase, VIPTel, Google alebo SMS credentials nepatria do repozitára.
