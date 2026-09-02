# Vercel deployment runbook

## Cieľ a hranice

Frontend dispečingu sa nasadzuje cez existujúci Vercel projekt `alfopures-projects/pomoc-motoristom-dispecing` a jeho GitHub integráciu. Trvalá vývojová vetva je `dev`; `main` je výhradne produkčný release branch.

Tento frontend workflow neoprávňuje ani nevykonáva Supabase migrácie, seed, databázové vetvy, workery, schedulery, VIPTel listenery, živé integračné joby ani Hetzner aktiváciu. Budúci Hetzner cutover je samostatná operácia a jej zdrojom pravdy ostáva `docs/operations/dispecing-hetzner-handoff.md`.

## Deployment shape

- Vercel project: `pomoc-motoristom-dispecing` (`prj_xoPuceCAcyZFOXohbRbA1XQT2cjf`).
- Framework preset: `Next.js`; install command sa deteguje podľa `pnpm-lock.yaml`.
- Production branch: `main`.
- Produkcia: [https://dispecing.linkapomoci.sk](https://dispecing.linkapomoci.sk).
- Trvalý vývoj: vetva `dev` na [https://dev.dispecing.linkapomoci.sk](https://dev.dispecing.linkapomoci.sk).
- Work branch: automatický Vercel Preview s branch aliasom a immutable deployment URL.
- Záložná produkčná URL: [https://pomoc-motoristom-dispecing.vercel.app](https://pomoc-motoristom-dispecing.vercel.app).
- Vercel Preview Authentication je vypnutá, aby Preview URL vedela otvoriť aj kolegyňa alebo kolega bez Vercel účtu. Supabase autentifikácia aplikácie zostáva povinná.
- Projekt nemá Vercel cron definície a frontend workflow ich nepridáva.

Preview aj `dev` používajú živý Frankfurt Supabase projekt. Všetky zápisy cez tieto deploymenty sú reálne produkčné zápisy.

## Vetvový workflow

1. Aktualizuj lokálny `dev` a vytvor z neho samostatnú pracovnú vetvu.
2. Pushni pracovnú vetvu. Existujúca Vercel Git integrácia automaticky vytvorí Preview.
3. Skontroluj Preview URL: nesmie zobraziť Vercel SSO, musí však zobraziť aplikačné Supabase prihlásenie.
4. Otvor pull request pracovnej vetvy do `dev`.
5. Po merge over [dev.dispecing.linkapomoci.sk](https://dev.dispecing.linkapomoci.sk), `/api/health/live`, prihlasovaciu stránku a bezpečný read-only deep link.
6. Produkciu vydaj iba pull requestom `dev -> main`.
7. Po úspešnej produkčnej gate over produkčnú doménu rovnakými read-only kontrolami.

Aplikačnú prácu neposielaj priamo do `main` a nerob manuálny `vercel deploy --prod`. Ak niekto omylom pushne priamo do `main`, Vercel produkčná gate sa napriek tomu spustí.

## Vercel-native build gate

V nastavení projektu je Build Command presne:

```sh
if [ "$VERCEL_ENV" = "production" ]; then pnpm exec vitest run && pnpm run typecheck && pnpm run build; else pnpm run build; fi
```

- Work-branch Preview a `dev` majú `VERCEL_ENV=preview` a spustia iba `pnpm run build`.
- `main` má `VERCEL_ENV=production` a spustí Vitest aplikačné testy, TypeScript check a potom Next.js build.
- Gate zámerne neobsahuje lint, Playwright, kompletné `pnpm test`, Docker build, deployment-contract testy, Supabase reset, migrácie ani dependency audit.
- Vercel priradí produkčnú doménu až READY deploymentu. Ak test, typecheck alebo build zlyhá, predchádzajúci produkčný deployment ostane aktívny.

GitHub workflow **Full CI (manual)** slúži iba na občasné ručné spustenie plnej lint/typecheck/test/build sady. Push ani pull request automatický GitHub runner nespúšťa; produkčné nasadenie riadi existujúca Vercel Git integrácia.

## Environment scopes

### General Preview

General Preview obsahuje iba aplikačnú konfiguráciu potrebnú pre beh proti aktívnemu Frankfurt Supabase projektu a:

```env
MOTORIST_DEV_AUTH_BYPASS=false
```

Do general Preview ani work branches nekopíruj produkčné VIPTel, SMS live-send, Commander, SWHouse, WebDispecink, Resend/email, Anthropic, recording-sync, listener, scheduler alebo cron secrets.

### Vetva `dev`

Branch-specific Preview overrides musia zostať:

```env
APP_BASE_URL=https://dev.dispecing.linkapomoci.sk
PUBLIC_APP_URL=https://dev.dispecing.linkapomoci.sk
NEXT_PUBLIC_APP_URL=https://dev.dispecing.linkapomoci.sk
VIPTEL_SIP_ALLOWED_ORIGINS=https://dev.dispecing.linkapomoci.sk
MOTORIST_DEV_AUTH_BYPASS=false
```

Tieto overrides majú prednosť pred general Preview iba na vetve `dev`. Supabase credentials sa dedia z general Preview a musia naďalej smerovať na `sjcsrygkkmersoczpunh`.

### Production

Production používa produkčné URL, Frankfurt Supabase credentials a:

```env
MOTORIST_DEV_AUTH_BYPASS=false
```

Existujúce produkčné integračné secrets nepresúvaj do Preview. `SUPABASE_DB_URL` nepatrí do Vercel runtime; je určená iba pre samostatnú, výslovne autorizovanú migračnú operáciu.

Premenné s prefixom `NEXT_PUBLIC_` Next.js vloží do klientského bundle počas build-u. Ich scope preto musí byť správny už pred vytvorením daného deploymentu.

## Supabase Auth redirects

Používa sa iba aktívny Frankfurt projekt `sjcsrygkkmersoczpunh`. Jeho existujúci `site_url` sa nemení a všetky existujúce redirect URL sa zachovávajú. Auth allow list musí navyše obsahovať:

```text
https://dispecing.linkapomoci.sk/**
https://dev.dispecing.linkapomoci.sk/**
https://pomoc-motoristom-dispecing-*-alfopures-projects.vercel.app/**
```

Zmrazený source projekt `jcwbiulwuwyrnmzjjbgr` sa pri tomto workflow nečíta ani nemení.

## Google Maps bezpečnosť

- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` smie byť pridaný iba pre vetvu `dev`, ak jeho website/referrer restrictions už obsahujú `dev.dispecing.linkapomoci.sk` a API restrictions povoľujú iba potrebné Maps JavaScript/Places API.
- Server-side `GOOGLE_MAPS_API_KEY` nesprístupňuj klientovi a jeho API restrictions neoslabuj.
- Ak obmedzenia dev doménu neobsahujú, mapový kľúč v tomto workflow nepridávaj.

## DNS a domény

DNS nemeníme. Produkčná aj dev doména už majú správne CNAME záznamy s TTL 600, platné TLS a overenie vo Verceli.

- `dispecing.linkapomoci.sk` zostáva produkčným aliasom `main`.
- `dev.dispecing.linkapomoci.sk` zostáva branch domain pre `dev`.
- DNS sa nesmeruje na Hetzner `195.201.36.90` bez samostatne autorizovaného cutoveru podľa Hetzner handoff dokumentu.

## Bezpečné overenie deploymentu

Pre work branch, `dev` a production zbieraj iba read-only dôkazy:

1. Vercel deployment je READY a jeho Git SHA a branch zodpovedajú očakávaniu.
2. Build log obsahuje iba očakávané príkazy pre dané prostredie.
3. HTTPS prejde s platným certifikátom.
4. `GET /api/health/live` vráti `200` a stav `live`.
5. Anonymné `GET /` zobrazí aplikačné prihlásenie, nie Vercel SSO.
6. `GET /auth/forgot-password` sa načíta ako bezpečný deep link bez odoslania formulára.
7. `MOTORIST_DEV_AUTH_BYPASS=false` je efektívne pre general Preview, `dev` aj Production.
8. Vercel stále hlási nula cronov a nebol aktivovaný worker, listener, scheduler ani živá integrácia.

Počas smoke testu nevytváraj prípady, neupravuj vozidlá, nespúšťaj sync endpointy a neposielaj SMS, hovory ani emaily.

## Oficiálne referencie

- Vercel Git deployments: https://vercel.com/docs/git
- Vercel environment variables: https://vercel.com/docs/environment-variables
- Vercel Deployment Protection: https://vercel.com/docs/deployment-protection
- Vercel custom domains: https://vercel.com/docs/domains/working-with-domains/add-a-domain
- Supabase Auth redirect URLs: https://supabase.com/docs/guides/auth/redirect-urls
