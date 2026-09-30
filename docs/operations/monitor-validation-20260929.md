# Monitor prevádzky — validačný záznam 29. 9. 2026

Snapshot pre **draft PR**, nie potvrdenie pripravenosti na produkciu. Posledné lokálne výsledky sú nižšie; čerstvý celkový Vitest, Node testy a lint už prešli. Finálny Next build aj samostatný `pnpm typecheck` prešli s exit 0. Migrácia ani konfigurácia monitoringu nebola aplikovaná vzdialene. Osobitné povolenie databázových zmien pre konkrétny TEST/produkčný projekt zostáva otvorené. Postup aktivácie: [prevádzkový runbook](operations-monitor.md).

| Overenie | Dokončený výsledok a presný rozsah |
| --- | --- |
| Celý Vitest po finálnom cleanup | **5 217 passed, 2 skipped**, 399 súborov passed a 1 skipped; čerstvý `vitest-release-candidate.log`. |
| Node testy / lint | **46 passed, 1 skipped**; lint 82 zmenených súborov bez chýb. |
| Finálny build / typecheck | **Oba exit 0**, vrátane TypeScript kontroly pri Next build aj samostatného `pnpm typecheck`. |
| UI po zmenšení kódu | **12/12 Playwright, 9/9 unit**, lint úspešný. Syntetické API: lazy detail, filtre/status, ACK/nepotvrdenie, viditeľnosť, zastaranie, obmedzenie ručných health kontrol, percentily pri strate/kvóte, desktop/mobil bez pretečenia. |
| SQL/PostgREST | **12/12** na lokálnom PostgreSQL 15.18 a PostgREST 14. Dedupe/ACK, RLS a oprávnenia, tri súbežné procesy, kvóty, retencia, indexy a HTTP statement timeout/rollback. Aj 1 500 normálnych hovorov + 1 prerušenie → jediný incident; cudzí hangup neukryje stratu operátora; neplatný historický dátum nezruší údržbu. |
| Skutočný Next 16.2.6 smoke pred UI cleanup | **6 kontrol úspešných**: `/monitor` server render/hydratácia, render/effect chyba cez skutočné `app/error.tsx`, syntetický cleanup, zachovaný kontext, report po ACK a `unstable_retry`. Lokálny auth bypass, bez DB/telefónneho SDK. Produkčný build bez konfigurácie/bypass zobrazil login s chybou konfigurácie; **neoveruje to reálne cookies ani role**. Dočasná route odstránená, servery zastavené. |
| Nezávislý backend review | Tri nálezy opravené a znovu prečítané: normálne hovory míňali rezervu incidentov, cudzí hangup potláčal incident, neplatný dátum rušil classifier. Backend code review schválený; hosted aktivácia zostáva osobitná brána. |

Screenshot 1440 px bol po poslednom zjednodušení vizuálne skontrolovaný. Screenshoty 1440/390 px a detailné lokálne dôkazy sú v gitignorovanom `.context/ralph-monitor/`; nie sú súčasťou publikovaného repozitára.

Posledný browser benchmark je z **20:24:40 UTC**, Chrome 152.0.7977.75, Linux cloud sandbox. Reálny collector, IndexedDB, skorá instrumentácia a `diagnosticJson` bežia nad localhost mock odpoveďami s 2 ms plánovaným oneskorením. Tri striedané OFF/ON cykly, 100 warmup + 500 vzoriek na úkon/cyklus: 1 500 vzoriek každého úkonu/režimu. Bootstrap 2 000 opakovaní stratifikovaných podľa cyklu:

| Úkon | OFF p95 | ON p95 | Horná 95 % hranica rozdielu | Limit vo fixture |
| --- | ---: | ---: | ---: | ---: |
| save | 5,5 ms | 5,7 ms | +0,7 ms | 5 ms |
| pickup | 6,2 ms | 5,3 ms | −0,3 ms | 5 ms |
| hangup | 5,4 ms | 4,8 ms | −0,1 ms | 5 ms |

Všetky tri prešli **iba lokálnou mock numerickou bránou**. Záporné rozdiely nie sú tvrdením o zrýchlení produkcie. Nevykonáva sa celý dispatch/telephony adaptér, hosted DB ani WebRTC zvuk.

- 10 000 enqueue: p95 **0,20 ms**, maximum **14,4 ms**; fronta **200 udalostí / 61 633 B**, zaznamenaných 9 800 zahodení. Počas meraných úkonov žiadne pozorované long tasks.
- Desať browser kariet × 1 000 opakovaných chýb za 60 virtuálnych sekúnd: maximum **12 pokusov v kĺzavom 60s okne** na kartu. Spolu 130 requestov zahŕňa oba krajné okamihy t=0/t=60, ktoré nie sú v rovnakom okne; 61 430 B POST body.
- Osem virtuálnych hodín pri jednom explicitnom úkone/min: 480 úkonov, **25 uploadov / 12 657 B body**; s konzervatívnymi 2 KiB/request navyše **63 857 B**, pod 2 MiB. Heap po GC +155 108 B. Virtuálny čas nepreukazuje osemhodinový reálny memory-leak ani ľubovoľnú záťaž. Desať kariet zberača tiež nie je hosted DB záťaž desiatich Monitor panelov.
- Skutočný `@sentry/browser` 10.53.1 proti **lokálnemu falošnému DSN**: 2 000 výnimiek → 2 obálky / 1 452 B; PII/message/token/function/query canary ani Referer sa neodoslali, súradnice chunku a release zostali. Hosted Sentry ingest, účet, retencia a source-map mapovanie tým nie sú overené.

**Veľkostná brána vlastného klienta 15 KiB zostáva nesplnená.** Finálny standalone bundle s reálnymi runtime exportmi má **15 756 B gzip > 15 360 B** (+396 B); široký namespace-export horný odhad má **16 342 B** (pred zjednodušením UI 17 597 B). Zahŕňa nové diagnostické klientské moduly, monitor/report/call UI a early/error kód; existujúci React/Next/lucide a Sentry vendor sú external. Staršie integračné súbory pridávajú **2 031 B** v izolovanom transform/gzip porovnaní; táto hodnota nie je presne pripočítateľná ku komprimovanému bundlu, ale nesmie sa ignorovať. Kolektor-only číslo sa nesmie použiť ako splnenie celej brány.

**Finálny Next all-routes limit 60 KiB prešiel:** 26 → 32 JavaScript súborov, súčet gzip po súboroch **822 032 → 871 448 B**, rozdiel **49 416 B** (48,26 KiB), vrátane Sentry vendor chunku 17 463 B. Je to rozdiel celého build výstupu, nie množstvo kódu načítané pri jednej návšteve stránky; nenahrádza osobitný limit vlastného kódu.

Reprodukcia zo základného adresára s nainštalovanými závislosťami a Chrome `/usr/bin/google-chrome`:

```sh
pnpm exec vitest run
pnpm typecheck
pnpm build
E2E_BASE_URL=https://monitor.test pnpm exec playwright test e2e/operations-monitor.spec.ts --workers=2
node scripts/diagnostics-benchmark/run.mjs
node scripts/diagnostics-benchmark/summarize.mjs
node scripts/diagnostics-benchmark/sentry-wire.mjs
```

Browser skripty vytvárajú len localhost syntetické služby; podrobnosti v [benchmark README](../../scripts/diagnostics-benchmark/README.md). SQL test potrebuje `psycopg`, výhradne jednorazový lokálny PostgreSQL na `127.0.0.1:55432` s fixture účtom uvedeným v skripte a lokálny PostgREST 14. **Maže a znovu vytvára syntetickú databázu `diagnostics_contract`**; nepoužívať vzdialený DB účet. Chýbajúci PostgREST preskočí timeout test, preto taký beh nie je ekvivalentom 12/12:

```sh
POSTGREST_BIN=/tmp/postgrest python3 tests/postgres/diagnostics-contract.py
```

Rovnaké široké meranie vlastných klientských modulov, bez zmeny definície gzip:

```sh
node --input-type=module <<'JS'
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const files = ['src/lib/diagnostics', 'src/components/monitor'].flatMap(dir =>
  readdirSync(dir).filter(f => /\.tsx?$/.test(f) && !f.includes('.test.')).map(f => `${dir}/${f}`)
).concat(['src/lib/telephony/diagnostics.ts', 'src/app/error.tsx', 'src/app/global-error.tsx']);
const contents = files.map((f,i) => `import * as module${i} from './${f}'; export {module${i}};`).join('\n') + "\nimport './src/instrumentation-client';";
const result = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, minify: true, platform: 'browser', format: 'esm', write: false,
  external: ['react', 'react/*', 'lucide-react', 'next', 'next/*', '@sentry/browser'],
  define: { 'process.env.NODE_ENV': '"production"' } });
console.log({ raw: result.outputFiles[0].contents.length, gzip: gzipSync(result.outputFiles[0].contents).length, budget: 15360 });
JS
```

Otvorené podmienky vydania: veľkostná brána vlastného klienta, hosted TEST DB/latencia/pool záťaž a statement-timeout konfigurácia, reálne audio/lifecycle správanie, privátne source maps presného deploynutého release, Sentry účet/projekt a nezávislé aktívne HTTP uptime live/60s + ready/5min s overeným alarmom/obnovením. Aktívny uptime ani Sentry neboli dostupnými podkladmi potvrdené. Objavený [BI Healthchecks dashboard](https://healthchecks.io/projects/4cabfe11-c44a-4797-aa28-f5cb33363dcc/checks/) je **cudzí existujúci pasívny heartbeat**, nie monitor tejto aplikácie; jeho checky/scheduler sa nemenili. Žiadny tajný ping URL ani kľúč tento dokument neobsahuje.
