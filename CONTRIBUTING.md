# Prispievanie

Tento repozitár používa dev-first workflow. Trvalá vývojová vetva je `dev`; `main` je iba produkčný release branch.

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
5. Po merge skontroluj [dev.dispecing.linkapomoci.sk](https://dev.dispecing.linkapomoci.sk), health endpoint a bezpečný read-only deep link.

Preview a `dev` spúšťajú iba povinný Next.js build (`pnpm run build`). Automatické GitHub CI na push ani PR nepoužívame. Rozšírenú sadu lint, typecheck, test a build možno podľa potreby spustiť ručne cez GitHub Actions workflow **Full CI (manual)**.

## Produkčný release

Produkcia sa vydáva iba pull requestom `dev -> main`. Pred jeho otvorením musí byť aktuálny stav overený na dev doméne. Merge do `main` spustí Vercel-native gate v tomto poradí:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Vercel priradí [dispecing.linkapomoci.sk](https://dispecing.linkapomoci.sk) až úspešnému produkčnému deploymentu; pri zlyhaní ostáva aktívny predchádzajúci deployment. Aplikačnú prácu neposielaj priamo do `main`. Ak sa však direct push stane omylom, rovnaká produkčná gate sa spustí aj preň.

## Dátová a integračná bezpečnosť

- Work-branch Preview aj `dev` používajú živý Frankfurt Supabase projekt. Zápisy sú reálne produkčné dáta.
- `MOTORIST_DEV_AUTH_BYPASS` musí byť `false` v general Preview, na vetve `dev` aj v Production.
- Do Preview nekopíruj produkčné VIPTel, SMS, Commander, SWHouse, WebDispecink, email/Resend, Anthropic, recording-sync, listener ani scheduler secrets.
- Nespúšťaj migrácie, seed, živé SMS/hovory/emaily, workery, listenery, schedulery ani integračné joby ako súčasť frontend workflow.
- Nepridávaj Vercel cron definície.
- Google Maps credentials možno pridať iba na vetvu `dev`, ak ich referrer restrictions už povoľujú dev doménu. Obmedzenia kľúčov neoslabuj.
- Tento workflow neoprávňuje ani nevykonáva Hetzner aktiváciu. Budúci cutover sa riadi výhradne `docs/operations/dispecing-hetzner-handoff.md`.

## Lokálne overenie produkčnej gate

Pred produkčným PR spusti:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Úplnú manuálnu sadu vrátane lint a infraštruktúrnych contract testov spúšťaj iba zámerne cez **Full CI (manual)** alebo lokálne v prostredí so všetkými potrebnými host tools.
