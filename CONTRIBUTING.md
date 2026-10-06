# Prispievanie

Tento repozitár používa dev-first workflow. Trvalá vývojová vetva je `dev`; `main` je produkčný release branch aplikácie na `dispecing.linkapomoci.sk`. Stabilný TEST má samostatný Vercel projekt `pomoc-motoristom-test` a adresu `https://test.dispecing.linkapomoci.sk`. Vyradený VIPTel projekt a jeho Supabase sa nemenia.

## Bežná zmena

1. Aktualizuj lokálnu vetvu `dev` bez prepisovania histórie:

   ```bash
   git fetch origin
   git switch dev
   git pull --ff-only origin dev
   ```

2. Vytvor samostatnú pracovnú vetvu z `dev`, urob zmenu a pushni ju.
3. Počkaj na automatický Vercel Preview deployment a otvor jeho URL. Aplikácia musí vyžadovať Supabase prihlásenie; zachovaj aj existujúcu Vercel ochranu Preview.
4. Otvor pull request pracovnej vetvy do `dev`.
5. Po merge počkaj na nový deployment `dev` v dedikovanom TEST projekte (Production target). Na `https://test.dispecing.linkapomoci.sk` over live/ready health, zhodu deployment ID a Git commitu a zmenené správanie. Generovaný `dev` Preview alias je iba obmedzený fallback.
6. Majiteľovi odovzdaj TEST URL, nasadený commit, zmenu, postup skúšky a overený/neoverený rozsah. Počkaj na výslovné schválenie produkčného rozsahu.

Preview, `dev` aj `main` spúšťajú rovnakú Vercel build gate (`pnpm exec vitest run && pnpm run typecheck && pnpm run build`). Automatické GitHub CI na push ani PR nepoužívame. Rozšírenú sadu lint, typecheck, test a build možno podľa potreby spustiť ručne cez GitHub Actions workflow **Full CI (manual)**.

## Produkčný release

Bežná produkcia sa vydáva pull requestom `dev -> main` po overení na stabilnom TESTE a výslovnom schválení majiteľa. Pred merge porovnaj celý release diff s odovzdaným TEST commitom; novšie neoverené zmeny nie sú súčasťou pôvodného súhlasu. Merge do `main` spustí tú istú gate:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Vercel priradí produkčnú doménu `https://dispecing.linkapomoci.sk` úspešnému deploymentu projektu `pomoc-motoristom-dispatching`; pri zlyhaní ostáva aktívny predchádzajúci deployment. `main` aj `dev` vyžadujú PR, aktuálnu vetvu a úspešný check `Vercel – pomoc-motoristom-dispatching`, aj pre administrátorov. Ochrany zachovaj. Over canonical health, nasadený commit a dotknutú funkciu; nepublikuj redeployom historického deploymentu.

Majiteľ môže schváliť iba identifikovanú podmnožinu alebo výslovne žiadať priamu produkčnú opravu. Vtedy použi izolovaný PR z aktuálneho `main` iba s týmto rozsahom a následný PR na sync do `dev`, podľa [release workflow](docs/operations/release-workflow.md). Pokyn na implementáciu ani „pokračuj“ sám osebe neautorizuje produkciu.

## Dátová a integračná bezpečnosť

- Work-branch Preview aj stabilný TEST (`dev`) používajú iba Supabase `nzpnqdstvkfncflgqlny`; ich dáta sú spoločné a zápisy reálne. Produkcia (`main`) používa `ifpaeegaesdmljfkdvcn`. Lokálny Development musí TEST credentials a efektívny projekt overiť osobitne.
- `MOTORIST_DEV_AUTH_BYPASS` musí byť `false` v general Preview, na vetve `dev` aj v Production.
- Produkčné credentials nekopíruj do TESTU/Preview a nepoužívaj secrets vyradeného projektu ani predchádzajúceho telefónneho providera.
- Live Telnyx smie bežať iba v produkcii alebo v overenom dedikovanom TEST projekte, ktorý má `MOTORIST_APP_ENV=test` a systémový `VERCEL_PROJECT_ID=prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`. TEST používa svoje čísla a provider resources; aj ukončenie existujúceho hovoru overuje TEST pôvod. Bežné TEST volania majú [autorizovanú telefónnu politiku](docs/operations/test-phone-number-policy.md). Pracovný Preview má live integrácie vypnuté a nesmie prevádzkovať stabilné TEST zariadenia či routing.
- Supabase migrácie a seed spúšťaj iba na výslovnú žiadosť s presným SQL a cieľovým projektom; TEST súhlas neplatí pre produkciu. Nespúšťaj všetky pending migrácie ani seed na snapshot. Nespúšťaj ďalšie workery, schedulery ani listeners.
- Jediný povolený Vercel cron je `*/5 * * * *` na `/api/telephony/cron` (bearer `CRON_SECRET`); iné cron definície nepridávaj.
- Google Maps credentials majú byť oddelené podľa prostredia a obmedzené na potrebné API/domény. Produkčný serverový kľúč nepatrí do Preview. Obmedzenia kľúčov neoslabuj.

## Lokálne overenie produkčnej gate

Pred produkčným PR spusti:

```bash
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Úplnú sadu vrátane lint a `node --test tests/*.test.mjs` spúšťaj zámerne cez **Full CI (manual)** alebo lokálne.
