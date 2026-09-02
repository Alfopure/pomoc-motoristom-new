# Linka pomoci motoristom - dispečing

Next.js + TypeScript + Tailwind základ pre pracovný dispečing Pomoc Motoristom. UI beží proti Supabase (s deterministickým mock fallbackom) a repozitár smeruje na produkčný foundation stack: Supabase, telefónia cez Telnyx (vo výstavbe), provider adaptéry a organizáciou konfigurovateľný model.

Tento repozitár je **samostatná kópia** dispečingu určená pre prechod na Telnyx. Má vlastný Supabase projekt (Frankfurt) aj vlastný Vercel projekt (región `fra1`) a nikdy sa nedotýka pôvodného produkčného projektu ani predchádzajúceho telefónneho providera.

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

Trvalá vývojová vetva je `dev`. Každá bežná zmena začína z aktuálneho `dev`, pokračuje samostatnou pracovnou vetvou a pull requestom späť do `dev`. Push pracovnej vetvy automaticky vytvorí verejne dostupný Vercel Preview; aplikácia na ňom naďalej vyžaduje Supabase prihlásenie.

Po merge sa `dev` automaticky nasadí na branch alias vetvy `dev` v tomto Vercel projekte. Produkcia tejto kópie je `test.dispecing.linkapomoci.sk` na vetve `main` (kým neexistuje CNAME, slúži produkčný `*.vercel.app` alias projektu) a vydáva sa iba pull requestom `dev -> main`. Preview, `dev` aj `main` spúšťajú rovnakú build gate: Vitest aplikačné testy, TypeScript check a Next.js build.

Preview aj `dev` používajú Supabase projekt tejto kópie, nie pôvodné produkčné dáta; zápisy sú napriek tomu reálne pre každého, kto na nich testuje. Telefónne migrácie a seed tejto kópie sú v rozsahu, spúšťajú sa však iba na výslovnú žiadosť a iba proti Supabase projektu tejto kópie. Jediný povolený Vercel cron je `*/5 * * * *` na `/api/telephony/cron`. Podrobný postup je v [CONTRIBUTING.md](CONTRIBUTING.md) a [docs/deployment-vercel.md](docs/deployment-vercel.md).

## Demo dáta

Demo Supabase dáta vieš opakovateľne doplniť cez service key z `.env.local`:

```bash
pnpm seed:demo
```

Seed pridá konkrétne pobočky v Bratislave, Žiline, Liptovskom Mikuláši a Košiciach, odťahovky, náhradné vozidlá, prípady, úlohy, päť telefónnych liniek s partnerskými štítkami a mock hovory (`provider = 'telnyx'`). Používa stabilné ID a `upsert`, takže ho môžeš spustiť znova bez zmazania ručne vytvorených prípadov.

## Aktuálny stav

Aplikácia používa Supabase ako hlavný zdroj dát, Google Maps/Places v prehliadači a Google Routes API cez server route. UI stále obsahuje mock fallback, aby ostalo použiteľné bez Supabase alebo pri výpadku mapových služieb.

Telefónia je po odstránení predchádzajúceho providera v režime **„Telefónia nie je nakonfigurovaná"**: log hovorov, spätné volania, adresár, výsledky hovorov a prepojenie hovoru s prípadom fungujú, ale vytáčanie, prezencia a SMS odosielanie hlásia nenakonfigurovaný stav, kým nepribudne Telnyx (plán v [docs/telnyx-data-contract.md](docs/telnyx-data-contract.md)). Telnyx sa nebude volať priamo z prehliadača: webhooky a REST príkazy spracúva server, prehliadač číta normalizované dáta zo Supabase a telefonuje cez WebRTC s krátkodobým tokenom vydaným serverom.

Dispečerská konzola používa Supabase Auth s prihlásením heslom a mapovaním na aktívne `motorist_profiles`. Všetky aplikačné tabuľky používajú prefix `motorist_`.

## Dokumentácia

- `docs/source/MOTORIST_ASSISTANCE_KNOWLEDGE_BASE.md` - importovaný zdrojový discovery dokument.
- `docs/product-brief.md` - produktový rámec v1 demo.
- `docs/domain-model.md` - doménové entity, statusy a traceability mock dát.
- `docs/demo-flow.md` - klikateľný demo scenár a map fallback.
- `docs/architecture.md` - produkčný foundation návrh.
- `docs/data-model.md` - Supabase dátový model a hranice domény.
- `docs/security-model.md` - role, RLS, audit, secrets a GDPR poznámky.
- `docs/integration-strategy.md` - telefónia, SMS, mapy, fleet a AI cez provider adaptéry.
- `docs/client-configuration.md` - single-client first, multi-client-ready nastavenia.
- `docs/telnyx-data-contract.md` - dátový kontrakt telefónie na Telnyxe (odkaz na návrh).
- `docs/operations/telnyx-setup.md` - identifikátory Telnyx zdrojov (bez tajomstiev).
- `docs/deployment-vercel.md` - Vercel prostredia, build gate a domény tejto kópie.

## Foundation konfigurácia

`.env.example` obsahuje iba názvy premenných. Reálne Supabase, Telnyx, Google alebo SMS credentials nepatria do repozitára.
