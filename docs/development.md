# Lokálny vývoj

Web používa Node.js 22 (najmenej 22.12) alebo podporovanú vetvu Node.js 24 a **pnpm 10.34.9**. Mobil má vlastný npm lockfile a Node.js 24; nemiešaj jeho inštaláciu s webovým pnpm lockfile.

Z aktuálneho `dev` vytvor pracovnú vetvu podľa [CONTRIBUTING.md](../CONTRIBUTING.md). V koreňovom adresári:

```bash
corepack pnpm@10.34.9 install --frozen-lockfile
corepack pnpm@10.34.9 test
corepack pnpm@10.34.9 typecheck
corepack pnpm@10.34.9 lint
```

Tieto kontroly nepotrebujú živé provider credentials. Vitest neutralizuje zdedené integračné premenné; testovacie fixtures nie sú pripravenou databázou pre interaktívny vývoj.

## Prihlásená aplikácia

Použi schválený prístup do existujúceho TESTU (`nzpnqdstvkfncflgqlny`) a vlastného testovacieho používateľa s aktívnym aplikačným profilom. Potrebné hodnoty dodá správca cez bezpečný kanál. `.env.example` je inventár a obsahuje aj lokálne zástupné hodnoty; samotné skopírovanie nevytvorí funkčnú databázu.

Do gitignorovaného `.env.local` nastav TEST URL, zodpovedajúci verejný a serverový Supabase kľúč, `SUPABASE_PROJECT_REF` a `EXPECTED_SUPABASE_PROJECT_REF` na TEST ref a príslušnú organizáciu. Serverové kľúče nikdy neoznačuj `NEXT_PUBLIC_`. Ponechaj `MOTORIST_DEV_AUTH_BYPASS=false`, `TELNYX_LIVE_CALLS_ENABLED=false`, `TELNYX_SMS_LIVE_SENDS=false` a `MOTORIST_TEST_LIVE_INTEGRATIONS=false`; nekopíruj provider secrets. Lokálne URL aplikácie smerujú na `http://localhost:3000`.

Pred spustením skontroluj efektívne hodnoty aj v shelli, ktoré môžu prepísať `.env.local`. Všetky Supabase URL a referencie musia patriť TEST projektu. Potom spusti `corepack pnpm@10.34.9 dev` a prihlás sa na `http://localhost:3000`. Zápisy idú do spoločného TESTU, preto používaj vlastné syntetické záznamy. Chýbajúce prihlásenie či konfiguráciu neopravuj prepnutím na produkciu alebo vypnutím autorizácie.

## Hranica databázového bootstrapu

Repozitár zatiaľ nemá overený postup, ktorý z prázdnej lokálnej databázy prehrá všetky historické migrácie a vytvorí kompletnú použiteľnú aplikáciu. `supabase start`, plošný `db push` ani seed preto nie sú súčasťou onboarding postupu. Dnes je použiteľnou cestou existujúci TEST alebo offline testy. Migračná oprava/bootstrap je samostatná práca; migrácie a seed do zdieľaného projektu vyžadujú presný autorizovaný SQL rozsah. Pri pozastavenom TESTE postupuj podľa [runbooku](operations/test-environment.md).

## Kontroly a odovzdanie

`pnpm test` zahŕňa Vitest aj `node --test tests/*.test.mjs`. Pred PR pridaj `pnpm build`; Vercel navyše spúšťa diagnostickú kontrolu a build wrapper podľa `vercel.json`. Webový lint je lokálna kontrola a súčasť **Full CI (manual)**, nie Vercel gate. **Mobile checks** automaticky overuje mobil pri zmenách jeho kódu alebo zdieľaných/backendových kontraktov; mobilné príkazy spúšťaj z `mobile/` po `npm ci`.

PR smeruje do `dev`; po merge over zmenené správanie na [stabilnom TESTE](https://test.dispecing.linkapomoci.sk) a jeho commit. Produkčný release podlieha schváleniu podľa [release workflow](operations/release-workflow.md).
