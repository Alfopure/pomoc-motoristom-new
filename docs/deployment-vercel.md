# Vercel deployment runbook

## Cieľ a hranice

Táto kópia dispečingu sa nasadzuje cez vlastný Vercel projekt `pomoc-motoristom-new` (tím `alfopures-projects`, región funkcií `fra1`, Fluid Compute) napojený na GitHub repozitár `alfopure/pomoc-motoristom-new`. Beží proti vlastnému Supabase projektu `pomoc-motoristom-telnyx` (ref `ifpaeegaesdmljfkdvcn`, región `eu-central-1`, Frankfurt). Trvalá vývojová vetva je `dev`; `main` je výhradne produkčný release branch.

Pôvodný produkčný projekt (Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispecing`, doména `dispecing.linkapomoci.sk`) sa z tohto repozitára nikdy nečíta ani nemení. Vercel projekt bol založený nový, nie importom cez pôvodný projekt. Vo Fáze 1 pribudne `scripts/assert-target-project.mjs`, ktorý v pre-hookoch aj vo Vercel builde zlyhá, ak env obsahuje pôvodný project ref.

Frontend workflow nespúšťa workery, schedulery ani samostatné listener procesy. Supabase migrácie a seed sú pre túto kópiu v rozsahu, ale sú to samostatné, výslovne vyžiadané operácie proti Supabase projektu tejto kópie.

## Deployment shape

- Vercel project: `pomoc-motoristom-new` (`prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`).
- Framework preset: `Next.js`; install command sa deteguje podľa `pnpm-lock.yaml`.
- Production branch: `main`.
- Produkčná doména: `https://test.dispecing.linkapomoci.sk` (CNAME vo Websupporte na `cname.vercel-dns.com`; kým neexistuje, produkciu obsluhuje alias `https://dispecing-test.vercel.app`).
- Predvolená URL projektu: `https://pomoc-motoristom-new.vercel.app` (slúži aj ako failover URL pre Telnyx webhooky).
- Trvalý vývoj: vetva `dev` na branch aliase `https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app`.
- Work branch: automatický Vercel Preview s branch aliasom a immutable deployment URL.
- Vercel Preview Authentication je vypnutá, aby Preview URL vedela otvoriť aj kolegyňa alebo kolega bez Vercel účtu. Supabase autentifikácia aplikácie zostáva povinná.
- Jediný povolený cron: `*/5 * * * *` na `/api/telephony/cron` (bearer `CRON_SECRET`), definovaný vo `vercel.json` spolu s `regions: ["fra1"]`. Pribudne s Telnyx fázami 1 až 2; iné cron definície sa nepridávajú.

Preview aj `dev` používajú Supabase projekt tejto kópie. Nejde o pôvodné produkčné dáta, ale všetky zápisy sú reálne pre každého, kto na týchto deploymentoch testuje.

## Vetvový workflow

1. Aktualizuj lokálny `dev` a vytvor z neho samostatnú pracovnú vetvu.
2. Pushni pracovnú vetvu. Vercel Git integrácia automaticky vytvorí Preview.
3. Skontroluj Preview URL: nesmie zobraziť Vercel SSO, musí však zobraziť aplikačné Supabase prihlásenie.
4. Otvor pull request pracovnej vetvy do `dev`.
5. Po merge over dev alias, `/api/health/live`, prihlasovaciu stránku a bezpečný read-only deep link.
6. Produkciu vydaj iba pull requestom `dev -> main`.
7. Po úspešnej produkčnej gate over produkčnú doménu rovnakými read-only kontrolami.

Aplikačnú prácu neposielaj priamo do `main` a nerob manuálny `vercel deploy --prod`. Ak niekto omylom pushne priamo do `main`, Vercel produkčná gate sa napriek tomu spustí.

## Vercel-native build gate

V nastavení projektu je Build Command pre všetky prostredia rovnaký:

```sh
pnpm exec vitest run && pnpm run typecheck && pnpm run build
```

- Work-branch Preview, `dev` aj `main` spustia Vitest aplikačné testy, TypeScript check a potom Next.js build. Preview už nemá zjednodušenú gate.
- Gate zámerne neobsahuje lint, Playwright, `node --test tests/*.test.mjs`, Supabase reset, migrácie ani dependency audit.
- Vercel priradí doménu až READY deploymentu. Ak test, typecheck alebo build zlyhá, predchádzajúci deployment ostane aktívny.

GitHub workflow **Full CI (manual)** slúži iba na občasné ručné spustenie plnej lint/typecheck/test/build sady. Push ani pull request automatický GitHub runner nespúšťa; nasadenie riadi Vercel Git integrácia.

## Environment scopes

### General Preview

General Preview obsahuje aplikačnú konfiguráciu pre beh proti Supabase projektu tejto kópie, dev Telnyx zdroje a kill switche vypnuté:

```env
MOTORIST_DEV_AUTH_BYPASS=false
TELNYX_LIVE_CALLS_ENABLED=false
TELNYX_SMS_LIVE_SENDS=false
```

`TELNYX_CALL_CONTROL_APP_ID`, `TELNYX_CREDENTIAL_CONNECTION_ID`, `TELNYX_OUTBOUND_VOICE_PROFILE_ID` a `TELNYX_MESSAGING_PROFILE_ID` ukazujú v Preview na dev zdroje z [`docs/operations/telnyx-setup.md`](./operations/telnyx-setup.md), nikdy na produkčné. Do Preview nepatria secrets pôvodného produkčného projektu ani predchádzajúceho telefónneho providera.

### Vetva `dev`

Branch-specific Preview overrides musia zostať:

```env
APP_BASE_URL=https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app
NEXT_PUBLIC_APP_URL=https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app
MOTORIST_DEV_AUTH_BYPASS=false
```

Tieto overrides majú prednosť pred general Preview iba na vetve `dev`. Supabase credentials sa dedia z general Preview.

### Production

Production používa produkčnú URL, Supabase credentials tejto kópie, produkčné Telnyx zdroje, `TELNYX_MEDIA_BASE_URL` a:

```env
MOTORIST_DEV_AUTH_BYPASS=false
```

`SUPABASE_DB_URL` nepatrí do Vercel runtime; je určená iba pre samostatnú, výslovne vyžiadanú migračnú operáciu.

Premenné s prefixom `NEXT_PUBLIC_` Next.js vloží do klientského bundle počas build-u. Ich scope preto musí byť správny už pred vytvorením daného deploymentu.

## Supabase Auth redirects

Používa sa iba Supabase projekt tejto kópie. Registrácie sú vypnuté, SMTP ide cez Resend. Auth allow list musí obsahovať:

```text
https://test.dispecing.linkapomoci.sk/**
https://dispecing-test.vercel.app/**
https://pomoc-motoristom-new.vercel.app/**
https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app/**
https://pomoc-motoristom-new-*-alfopures-projects.vercel.app/**
http://localhost:3000/**
```

## Google Maps bezpečnosť

- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` smie byť pridaný iba pre vetvu `dev` a produkciu, ak jeho website/referrer restrictions už obsahujú príslušnú doménu a API restrictions povoľujú iba potrebné Maps JavaScript/Places API.
- Server-side `GOOGLE_MAPS_API_KEY` nesprístupňuj klientovi a jeho API restrictions neoslabuj.
- Ak obmedzenia doménu neobsahujú, mapový kľúč v tomto workflow nepridávaj.

## DNS a domény

`linkapomoci.sk` beží na nameserveroch Websupportu, nie na Vercel DNS. Pre produkciu tejto kópie treba vo Websupporte záznam `test.dispecing` CNAME `cname.vercel-dns.com` s TTL 600 a následné overenie domény vo Verceli. Iné záznamy (najmä produkčný `dispecing.linkapomoci.sk`) sa nemenia.

## Telnyx webhooky

Call Control aplikácie a messaging profily posielajú webhooky na `/api/telephony/telnyx/webhook` a `/api/sms/telnyx/webhook` (Fáza 2). Produkčná aplikácia mieri na produkčnú doménu s failoverom na `*.vercel.app` alias; dev aplikácia mieri na dev branch alias. Podpis webhooku sa overuje cez `TELNYX_PUBLIC_KEY`.

## Bezpečné overenie deploymentu

Pre work branch, `dev` a production zbieraj iba read-only dôkazy:

1. Vercel deployment je READY a jeho Git SHA a branch zodpovedajú očakávaniu.
2. Build log obsahuje Vitest, typecheck aj build.
3. HTTPS prejde s platným certifikátom.
4. `GET /api/health/live` vráti `200` a stav `live`.
5. Anonymné `GET /` zobrazí aplikačné prihlásenie, nie Vercel SSO.
6. `GET /auth/forgot-password` sa načíta ako bezpečný deep link bez odoslania formulára.
7. `MOTORIST_DEV_AUTH_BYPASS=false` je efektívne pre general Preview, `dev` aj Production.
8. Vercel hlási najviac jeden cron (`/api/telephony/cron`) a env neobsahuje pôvodný project ref.

Počas smoke testu nevytváraj prípady, neupravuj vozidlá, nespúšťaj sync endpointy a neposielaj SMS, hovory ani emaily.

## Oficiálne referencie

- Vercel Git deployments: https://vercel.com/docs/git
- Vercel environment variables: https://vercel.com/docs/environment-variables
- Vercel cron jobs: https://vercel.com/docs/cron-jobs
- Vercel Deployment Protection: https://vercel.com/docs/deployment-protection
- Vercel custom domains: https://vercel.com/docs/domains/working-with-domains/add-a-domain
- Supabase Auth redirect URLs: https://supabase.com/docs/guides/auth/redirect-urls
