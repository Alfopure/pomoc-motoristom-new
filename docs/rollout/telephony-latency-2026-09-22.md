# Opravy latencie hovorov — 22. 9. 2026

Zmeny sa overujú na Preview s testovacím Supabase `nzpnqdstvkfncflgqlny`.
Živé hovory zostávajú v teste vypnuté. Produkčný release ide cez `dev` → `main`.
Testy s falošným providerom dokazujú správanie pri súbehu; nenahrádzajú meranie
skutočného zvonenia a zvuku po nasadení.

## E3–E4: zavesenie a ochrana čakárne

- Ukončovanie preskočí vetvu, pre ktorú už existuje prijatý provider `call.hangup`
  alebo úspešný príkaz hangup v journale. Syntetické `ended_at` samo nestačí.
- Ďalší kompenzačný pokus beží až vtedy, keď je podľa databázy splatný.
  Neznámy výsledok vytáčania zostáva povinnosťou pre ďalšiu obnovu.
- `call_hangup` z prehrávania/gatheru overenej zákazníckej vetvy uloží
  `metadata.customer_gone_at`. Sweep ani ručné prevzatie už nevytáčajú operátora.
  Skutočný hangup naďalej uzavrie vetvu a vytvorí prípadné spätné volanie.
- Sweep ustúpi nespracovanému hangupu presnej zákazníckej vetvy. Cron a webhook
  ho môžu v rámci rozpočtu spracovať; poll `calls/active` ho iba preskočí.
- Neskorý presný hangup opraví syntetický čas ukončenia bez opakovania príkazov.
  Koniec relácie zohľadňuje najneskorší koniec jej vetiev.

| Invariant | Mechanizmus | Dôkaz |
| --- | --- | --- |
| Každý príkaz patrí aktuálnemu držiteľovi lease | existujúci fenced journal a checkpoint | `termination-priority`, `projection-ownership` |
| Známy odchod zákazníka zastaví ponuky | marker, kontrola ledgera, odmietnutie pickup | `transitions`, `session-contention`, `ring-plan` |
| Neznámy dial sa nestratí | termination checkpoint a neskoršia obnova | `termination` |
| Presný koniec nemení obsluhu hovoru druhýkrát | korekcia iba bez pending effects | `transitions`, `terminal-hangup` |

Nové diagnostické kódy: `termination_legs_provider_ended` (preskočené ukončené
vetvy) a `termination_evidence_unavailable` (čítanie dôkazu zlyhalo, použila sa
pôvodná kompenzácia).

Obmedzenie: bez samostatne schválenej SQL zmeny zostáva krátke okno medzi
posledným rozhodnutím o vytáčaní a novým hangupom, ktorý ešte aplikácia neprijala.
Tieto opravy nesľubujú nulové vytáčanie po provider timestamp pri oneskorenom
doručení. Merajú sa zvlášť čas prijatia webhooku a čas jeho udalosti.

Rollback: revert príslušnej PR cez rovnaký dev-first postup. Marker v JSON
starší kód ignoruje; schéma, seed, rozvrh cronu a externé nastavenia sa nemenia.

## E5–E8: kratšia práca pod zámkom

- Snapshot relácie, vetiev, pokusov a pending provider príkazov sa načíta
  súbežne. Rovnaký snapshot pending príkazov slúži na koreláciu webhooku.
- Už uložené `call.initiated` nezákazníckej vetvy nepotrebuje plnú konfiguráciu.
  Pri totožnom stave nevytvára nový checkpoint. Podmienkou je zmrazená vypnutá
  recording politika a absencia pokračovania; skorá udalosť ide plnou cestou.
- Zápisy nezávislých výsledkov fanoutu bežia súbežne. Čas pôvodnej ponuky
  `offered_at` sa pri úspešnom diali neposúva. Ak všetky dials zlyhajú, tá istá
  relácia pokračuje do ďalšieho kroku/čakárne v ohraničenom leased cykle.
- Úspešný webhook dokončí inbox claim až po uvoľnení session lease; audit
  a povinné efekty sú v tom čase už uložené. Zlyhania zachovávajú obnovu.
- Čerstvý odchádzajúci hovor vynechá nadbytočný ownership probe a recovery
  lookup iba pri nezmenenom novom riadku. **Prvý snapshot pod lease zostáva**:
  identický POST mohol prevziať lease medzi insertom a acquire. Povinný audit
  initial dialu zostáva súčasťou durable checkpointu, nie nepovinnej údržby.
- Pickup načíta budget, session, presence a device v jednom `allSettled`
  **pod lease** a vyhodnotí chyby v pôvodnom poradí. Lean inbound pickup stále
  načíta skutočný počet aktívnych vetiev celej organizácie. Skorá outbound
  odpoveď s nezmrazenou politikou a všetky recording continuations idú plne.
- Čakáreň zdieľa plánovanie ponuky medzi advisory filtrom a reducerom.
  Nezmenený recheck bez dostupného operátora neberie lease ani neposúva
  `next_offer_at`. Filter pustí ďalej zmenu idle hodín, eskaláciu, expiráciu,
  stale audio, cancellation a pending effects. Zlyhanie advisory čítania
  zachová bežnú autoritatívnu cestu.
- Po hangup/bridge ide v retained údržbe najprv drain vlastného inboxu, potom
  sweep s prioritou najstaršej čakajúcej relácie. Inline budget je 8 s,
  kontrolovaný pred začatím ďalšej relácie; `calls/active` ostáva na 2 s.

Nevkladá sa paralelný MOH/dial pre nahrávané hovory. Táto voliteľná optimalizácia
z plánu neplatí pre aktuálnu recording politiku. Nepribúda UI grace ani marker
pre dvojité MOH ticky bez dôkazu, že sú potrebné.

## E9: časovanie a merací kit

`motorist_call_events.normalized_payload.timing` dopĺňa `request_id`,
`ingress_at`, `claimed_at`, `lease_acquired_at`, `first_command_at`,
`meta.attempt`, `meta.delivered_to`, `guard_ms` a `guard_stage_ms`.
Posledné dve metriky rozlišujú samostatnú rezerváciu od atomického
guard+stage RPC. Prvý príkaz je čas skutočného provider send; cache hit
journalu ani provider GET ho nenastavia. Bez odoslania zostáva `null`.
`received_at` si ponecháva pôvodný význam. Inbox replay je označený
`source: ledger_replay`; jeho pôvodné delivery meta nie sú spätne známe.

Runtime logy dopĺňajú:

- `webhook-delivery` aj pre busy/duplicate, s číslom pokusu a cieľom bez
  credentials, query alebo fragmentu;
- triedu deferral `lease_busy`, `snapshot_unavailable`, `routing_context`,
  skutočné čakanie, počet pollov a korelačné časovanie;
- `lease-timing` acquired/finished, event type, request, generation a trvanie.
  Potvrdené span logy umožnia dohľadať držiteľa pri súbehu medzi inštanciami.
  Acquire RPC naďalej vracia null-on-busy; chýbajúci log nie je dôkaz držiteľa;
- samostatný `request-performance` pre každý retained `after()` callback
  s rovnakým request ID a čerstvými počítadlami; notifikácie navyše zahodia
  lease context zachytený Nextom pri registrácii, aby nepoužili skončený zámok;
- `dbFirstMs` (prvý spustený dopyt), `dbMaxMs`, `dbAborts` (transportný timeout
  počas fetchu), `dbConnects` a `instanceEventLoopUtilization`;
- verziu Node/undici raz za úspešne dokončenú cron invokáciu.

Sockety Undici sú zdieľané. `dbConnectsScope: instance-window` preto znamená
nové DB spojenia pozorované v inštancii počas meraného okna, nie preukázané
spojenia jedného requestu. Aj ELU je procesová metrika. Kontrakty:
[Undici diagnostics](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md),
[Node performance](https://nodejs.org/api/perf_hooks.html#performanceeventlooputilizationutilization1-utilization2).
`steps.db.ms` je súčet trvaní fetchov vrátane prekrytia, nie wall time celého
handlera; `steps.db.ms / steps.db.count` je priemer jedného fetchu.

Offline meranie z exportu auditných udalostí (JSON array) a voliteľných runtime
logov (JSON array alebo NDJSON, vrátane Vercel `message` wrapperu):

```sh
node scripts/measure-telephony-latency.mjs \
  .context/call-events.json .context/runtime-logs.ndjson \
  > .context/latency-report.json
```

Kit nečíta sieť, nespúšťa hovory a vypíše p50/p95/max po type udalosti,
claim→lease→dispatch a pozorované prekrytia držiteľov lease. Chýbajúce alebo
obrátené pečiatky vylúči, nedosadí nulu. Na tvrdenie o p95 treba aspoň
20 vzoriek rovnakého scenára; meranie počuteľného zvonenia vyžaduje aj klienta.

Pred produkčným release treba prejsť Preview → `dev` → TEST → PR do `main`.
Po release odmerať prichádzajúci hovor, dve súbežné volania, pickup, outbound,
zavesenie počas zvonenia a dlhšiu čakáreň. Testovanie skutočných hovorov sa
v tomto balíku nevykonáva. Variant B zvonenia vyžaduje určenie rezervného
operátora; bez tejto voľby sa produkčný ring plán nemení.

Lokálna brána E5–E9: 4 963 Vitest testov a 45 Node testov prešlo (2 + 1
preskočené), typecheck a production build prešli. Lint bez chýb, 5 existujúcich
varovaní v nezmenených súboroch. Webhook import budget zostáva 54 modulov.
