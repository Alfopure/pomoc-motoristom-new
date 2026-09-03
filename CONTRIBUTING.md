# Prispievanie

Tento repozitár používa dev-first workflow. Trvalá vývojová vetva je `dev`; `main` je iba produkčný release branch. Ide o samostatnú kópiu dispečingu s vlastným Supabase a Vercel projektom; pôvodný produkčný projekt sa v tomto repozitári nikdy nepoužíva.

## Bežná zmena

1. Aktualizuj lokálnu vetvu `dev` bez prepisovania histórie:

   ```bash
   git fetch origin
   git switch dev
   git pull --ff-only origin dev
   ```

2. Vytvor samostatnú pracovnú vetvu z `dev`, urob zmenu a pushni ju.
3. Počkaj na automatický Vercel Preview deployment a otvor jeho URL. Preview musí byť dostupný bez Vercel účtu, ale samotná aplikácia musí stále vyžadovať Supabase prihlásenie.
4. Otvor pull request pracovnej vetvy do `dev`.
5. Po merge skontroluj branch alias vetvy `dev`, health endpoint a bezpečný read-only deep link.

Preview, `dev` aj `main` spúšťajú rovnakú Vercel build gate (`pnpm exec vitest run && pnpm run typecheck && pnpm run build`). Automatické GitHub CI na push ani PR nepoužívame. Rozšírenú sadu lint, typecheck, test a build možno podľa potreby spustiť ručne cez GitHub Actions workflow **Full CI (manual)**.

## Produkčný release

Produkcia sa vydáva iba pull requestom `dev -> main`. Pred jeho otvorením musí byť aktuálny stav overený na dev aliase. Merge do `main` spustí tú istú gate:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Vercel priradí produkčnú doménu tejto kópie (`test.dispecing.linkapomoci.sk`, prípadne produkčný `*.vercel.app` alias) až úspešnému produkčnému deploymentu; pri zlyhaní ostáva aktívny predchádzajúci deployment. Aplikačnú prácu neposielaj priamo do `main`. Ak sa však direct push stane omylom, rovnaká produkčná gate sa spustí aj preň.

## Dátová a integračná bezpečnosť

- Work-branch Preview aj `dev` používajú Supabase projekt tejto kópie. Nie sú to pôvodné produkčné dáta, ale zápisy sú reálne pre každého, kto na nich testuje.
- `MOTORIST_DEV_AUTH_BYPASS` musí byť `false` v general Preview, na vetve `dev` aj v Production.
- Do tohto projektu nikdy nekopíruj secrets pôvodného produkčného projektu ani predchádzajúceho telefónneho providera.
- Telnyx zdroje sú oddelené podľa prostredia: Preview a `dev` používajú dev Call Control app, credential connection, voice profile s nízkym limitom a dev messaging profile; `main` používa produkčné zdroje. Kill switche `TELNYX_LIVE_CALLS_ENABLED` a `TELNYX_SMS_LIVE_SENDS` ostávajú v Preview `false`.
- Supabase migrácie a seed spúšťaj iba na výslovnú žiadosť a iba proti Supabase projektu tejto kópie. Nespúšťaj workery, schedulery ani integračné joby ako súčasť frontend workflow.
- Jediný povolený Vercel cron je `*/5 * * * *` na `/api/telephony/cron` (bearer `CRON_SECRET`); iné cron definície nepridávaj.
- Google Maps credentials možno pridať iba na vetvu `dev`, ak ich referrer restrictions už povoľujú dev doménu. Obmedzenia kľúčov neoslabuj.

## Lokálne overenie produkčnej gate

Pred produkčným PR spusti:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Úplnú sadu vrátane lint a `node --test tests/*.test.mjs` spúšťaj zámerne cez **Full CI (manual)** alebo lokálne.
