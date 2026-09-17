# Plán opravy odozvy hovorov v2 — 16. 9. 2026

Stav: návrh na schválenie. Postup `ralplan`, dôkladný režim. **Nič sa nezmenilo**: žiadny kód, konfigurácia, databáza ani Telnyx. Odkazy na kód sú `cesta:riadok` na `origin/main` = `f8cb0717c592b8e60492b809c021de82ce77d0b6` (pracovná kópia `Alfopure/kampala` je o 39 commitov staršia, preto sa neanalyzovala). Podklady: [kontextový snapshot s overenými dôkazmi](../context/call-latency-review-20260916T143145Z.md), [read-only SQL na merania](../context/call-latency-measurement-queries-2026-09-16.md), [plán OpenAI z 11. 9.](call-and-app-performance-repair.md).

Poznámka k procesu: konsenzus cez nezávislých agentov (Planner → Architect → Critic) sa nepodarilo spustiť — všetkých 10 subagentov skončilo na limite relácie (reset 19:10 UTC). Tri roly som vykonal sám, sekvenčne, so záznamom v Prílohe B. Odporúčam po 19:10 UTC spustiť nezávislý Architect/Critic pas nad týmto dokumentom; do schválenia je to návrh jedného autora.

## 1. Rozhodnutie a cieľ

**Najprv obnoviť cron bez závislosti od nasadenia, potom skrátiť kritickú cestu hovoru na jednotky databázových round tripov pred hlasovým príkazom, až potom ladiť klienta, mobil a polling.** Cieľ zadania ostáva: prijatie, spojenie, pridanie účastníka, presmerovanie a ukončenie hovoru rýchlo a správne; nahrávanie a hlášky nie sú priorita, ich existujúce ochrany však ostávajú. Mimo rozsah: worker/fronta, plošné navýšenie kapacity, prepis domény.

Podstata nálezu: na hlavnej ceste `call.answered → bridge` vykoná aplikácia dnes približne **55–60 sekvenčných PostgREST round tripov a 4 sekvenčné Telnyx príkazy** (Príloha A), pričom Telnyx si sám vie spojiť vetvy za 0–0,42 s (outbound). Pri pozorovanej cene ~150–250 ms na round trip (OpenAI, 13. 9.: 44–72 operácií za 7–13 s) je to mechanizmus 10–20 s. Cieľ po etape 2: **≤ 8 sekvenčných round tripov pred odoslaním `bridge`**.

## 2. Overenie nálezov OpenAI 1–5

| Nález OpenAI (16. 9.) | Verdikt | Dôkaz | Čo dopĺňame |
| --- | --- | --- | --- |
| 1. Cron aktuálneho deploymentu vracia 403 | **Overené naživo** (14:41 UTC): oba dnešné produkčné hosty (`…-7ua6n9kj1`, 09:13 UTC; `…-patko0u0g`, 08:43 UTC) vracajú na `/api/telephony/cron` aj `/api/health/live` `403` s `x-vercel-mitigated: deny`; kanonický alias vracia `401`/`200`. | Vercel API: `crons.definitions[0].host` = nemenný host aktuálneho deploymentu; WAF verzia 44 (`updatedAt` 15. 9. 11:08 UTC) = allowlist hostov/ID; skew boundary 1789156793438. | Príčina je štrukturálna: allowlist sa musí ručne meniť pri každom produkčnom nasadení; dnes prebehli dve (PR #184, #186) bez zmeny. Návrh riešenia nezávislého od nasadenia + post-deploy gate (etapa 0). |
| 2. Sekvenčné vytáčanie pri „všetkým“, veľa DB zápisov pred príkazmi | **Overené** | `src/server/telephony/state/effects.ts:1147–1156` (sériové INSERT pokusov), `:1173–1211` (sériové `executeDial`), `:996–1062` + `:1064–1102` (8–10 round tripov + 1 HTTP na člena) | Presný rozpis round tripov (Príloha A), dizajn ohraničeného paralelného fanoutu so zachovaním journalu a guardov, a alternatíva Telnyx-native auto-bridge ako experiment. |
| 3. `playback_stop`/`gather_stop` pred `bridge`, až ~10 s | **Overené** | `src/server/telephony/state/transitions.ts:1212–1218` (poradie), `:974–980` (`stopMoh`, bestEffort), `src/server/telephony/state/effects.ts:1358–1394` (prísne sekvenčné vykonanie), `src/server/telephony/telnyx/client.ts:42–43` (5 s pokus, 12 s operácia) | Každý z týchto príkazov stojí navyše ~5 DB round tripov: fresh SELECT (`effects.ts:1365`), renew + prepare journalu (`src/server/telephony/provider-journal.ts:31–36`, `client.ts:488`), result (`client.ts:501`), checkpoint (`effects.ts:1480`). Návrh: `bridge` prvý, `stop` príkazy paralelne/po ňom; hypotéza o zastavení MOH pri bridge sa overí na vlastných číslach. |
| 4a. Mobil po skrytí / 2 min uvoľní spojenie | **Overené** | `src/lib/telephony/coordinated-webphone.ts:9, 293–311` (standby, hidden → `stopLocal`), `:272–290` (opätovná registrácia s 20 s timeoutom) | Doplnené: osobné PSTN členy ring plánu sú pre kontrakt 2 povolené (`src/server/telephony/state/transitions.ts:852` odovzdáva `hasStabilityContract`, `ring-plan.ts:264–266`), takže mobilného operátora možno zastihnúť aj cez osobné číslo — ak je ako člen ring skupiny nakonfigurovaný (konfigurácia, nie kód; platené PSTN vetvy). |
| 4b. Presmerovanie na kolegu iba cez webový telefón | **Overené** | `src/server/telephony/call-actions.ts:266` (`deviceKind: "web"`), `:902–916` (`listTransferTargets` číta len web zariadenia) | Cesta cez `default_mobile_number` s overením vlastníka už existuje (`call-actions.ts:273–285`); chýba len ponuka v UI. |
| 4c. Výber účastníka zatvorí dialóg pred potvrdením | **Overené** | `src/components/dispatch/PhoneBar.tsx:446–449` | Priebežný stav existuje len ako `busyAction` a oneskorená hláška (`useTelephonyConsole.ts:562–664`). |
| 5. Chýba 30 reprezentatívnych meraní; 12 hovorov bez konzultácie/presmerovania | **Neoveriteľné z tejto relácie** (bez prístupu do DB; Vercel runtime-logs API odmietlo token CLI) | Timing polia existujú: `motorist_call_events.normalized_payload.timing`, `commands[].effect_ms` (`effects.ts:578–605, 140–143`), hlavičky `server-timing` (`src/server/request-metrics.ts`) | Pripravené read-only SQL (A–J) na distribúcie bez nových živých hovorov. |

Databázový incident (40001/PT409) OpenAI vyriešil; dnešné pozorovanie OpenAI ani moje čítanie kódu nenaznačujú jeho návrat. Ďalej sa naň neodvolávam.

## 3. Čo OpenAI nenašlo alebo nedotiahlo

| ID | Zistenie | Dôkaz | Istota | Vplyv |
| --- | --- | --- | --- | --- |
| N1 | **WAF je allowlist, cron cieli na nemenný host** → každé nasadenie ticho vypne obnovu. Chýba post-deploy gate. | Vercel API (`rules[0]`: `host ninc […]` → deny; `crons.definitions[0].host`), `vercel ls` (dva dnešné deploymenty) | overené | Obnova (`runPendingEffectRecovery`, `replayStalledWebhookEvents`, `reconcileWithTelnyx`, termination retry, `initial:` materializácia, pripomienky, spracovanie nahrávok; `src/server/telephony/cron-jobs.ts:114–442`, `src/app/api/telephony/cron/route.ts:40–62`) stojí od 09:13 UTC. |
| N2 | **Anatómia kritickej cesty**: ~55–60 sekvenčných round tripov na `call.answered` (3 operátori). Najväčšie položky: checkpoint UPDATE po **každom** DB efekte (`effects.ts:211–222`, `continuation.ts:110–136`), 5 DB round tripov na **každý** provider príkaz (`effects.ts:1365`, `provider-journal.ts:31–36`, `client.ts:488–502`, `effects.ts:1480`), plný routing kontext pre answered (`session-runner.ts:238–344`), 6 round tripov admisie pred lease (`runtime.ts:60–77`, `event-processor.ts:236, 261, 288`, `session-runner.ts:442, 452`). | Príloha A | overené (počty), pravdepodobné (cena round tripu) | Hlavný mechanizmus 10–20 s. |
| N3 | `call.answered` ponukovej vetvy načítava celý routing kontext (line, settings, recording policy, personal settings, presence, devices, otvorené ponuky, počet vetiev), hoci prechod potrebuje len snapshot + `settings.parkMaxMinutes` a `mediaAvailable` pre kompenzačný fork. Lean kontext existuje len pre hangup/known bridge/pasívne médiá (`session-runner.ts:209–237`). | `transitions.ts:1169–1257` (použité `b.ctx.settings`, `b.ctx.mediaAvailable`, `b.ringPlan()` z meta) | overené | ~2 sekvenčné kolá (6 dotazov) navyše pred reducerom. |
| N4 | **Amplifikácia webhookov**: webhooky nečakajú na lease vôbec (`event-processor.ts:288` `leaseWaitMs: 0` → `session-runner.ts:454–455` → `SessionLeaseBusyError` → HTTP 500), Telnyx opakuje na 5xx a po `webhook_timeout_secs 10` (`docs/operations/telnyx-setup.md:26`) posiela na failover URL, kým náš handler trvá 10–30 s. Každé opakovanie stojí ~6 round tripov admisie a zaťaží ten istý PostgREST pool. OpenAI to zmerala (148 doručení / 59 udalostí), ale neriešila. | Telnyx docs (retry na 408/429/5xx; failover; „Return 2xx immediately“) | overené (mechanizmus), pravdepodobné (miera) | Sekundárna záťaž a oneskorenie answered/hangup faktov o čas držania lease. |
| N5 | **Polling zdieľa pool s hovormi**: `/api/telephony/calls/active` každých 750 ms na aktívny tab = auth (`auth.getUser()` sieťové volanie + profil + organizácia, `src/server/api-auth.ts:152–210`, `src/server/default-organization.ts:8–22`) + settings + presence recovery (`presence-recovery.ts:29–59`) + `loadActiveCalls` (`active-calls.ts:162–185`) ≈ 8–9 round tripov. Komentár o 3 s cache (`poll-schedule.ts:33`) nemá v `active-calls.ts` žiadnu implementáciu (cache má len `stats.ts:60,72,335`). | kód | overené | 11. 9.: 13 509 `/calls/active` za deň. Pri 5 taboch ~60 DB požiadaviek/s počas hovorov. |
| N6 | **Cena jedného round tripu je nezmeraná**; SQL čas lease RPC je 1–2 ms, no pozorovaný priemer je ~150–250 ms. Rozdiel je gateway/PostgREST/TLS/pool/čakanie na lease — nie SQL. `request-performance` logy už majú `steps.db.count/ms`. | `src/server/request-metrics.ts:59–75` | pravdepodobné | Bez toho nemožno rozhodnúť o kapacite. |
| N7 | **Hold/consult/add-party = lazy conference promotion**: `conference_create → conference_join → conference_hold (+ dial)` sekvenčne (závislé) a každý príkaz 5 DB round tripov (`transitions.ts:2095–2135, 2143–2151, 2318–2346, 2385–2417`). | kód | overené | 3–4 HTTP + 15–20 DB na podržanie/konzultáciu. |
| N8 | **Hangup**: hangup každej vetvy sekvenčne (`transitions.ts:2671–2675` → `effects.ts:1358`), 5 DB na vetvu; zákaznícka vetva ide prvá (správne); browser BYE je okamžitý (`useTelephonyConsole.ts:582–591`). | kód | overené | 2–3 HTTP + 10–15 DB pred potvrdením konca. |
| N9 | **Telnyx-native spojenie pre inbound** (`bridge_on_answer` + `prevent_double_bridge` + `link_to`) by presunulo first-answer-wins a bridge do Telnyxu (outbound to už robí: `transitions.ts:1126–1130`, merané 0–0,42 s). Stráca sa guard `reserveAnsweredOperator` pred bridge (`effects.ts:1266–1321`) a ochrana zákazníckej vetvy `park_after_unbridge: self`, ktorú dnes dáva `bridge` vydaný na zákazníckej vetve (`transitions.ts:1216–1218`, komentár `:2081–2094`); hold/consult/park/transfer sa na ňu spoliehajú. | Telnyx docs (dial `bridge_on_answer`, `prevent_double_bridge`: „hangs up the call if the target is already bridged“) | hypotéza — overiť na vlastných číslach | Potenciálne 0 round tripov medzi answer a bridge; vyžaduje prepracovanie hold. |

## 4. RALPLAN-DR

**Princípy**
1. Hlasový príkaz (bridge, dial, hangup) ide pred akoukoľvek nekritickou evidenciou; projekcie sú trvalá povinnosť, nie prerekvizita zvuku.
2. Optimalizuje sa **počet sekvenčných round tripov**, nie výkon servera; každá etapa má cieľové číslo a meria ho `server-timing`/`request-performance`.
3. Invarianty kontraktu 2 sa nemenia: fence tokenu/generácie (`supabase/migrations/20260929200000_fenced_telephony_commands.sql:23–37`), provider journal a 60 s dedupe (`src/server/telephony/provider-journal.ts`, `client.ts:469–543`), neznámy výsledok ≠ úspech, kompenzácie z reduceru, STOP bariéry nahrávania. Zmeny sú zlúčenie a preusporiadanie pod tým istým vlastníctvom.
4. Prevádzková zmena (WAF, Vercel, Telnyx, migrácia) je samostatný, výslovne schválený krok; kód ide dev-first (AGENTS.md).
5. Hypotézy o správaní Telnyxu (bridge vs. bežiaci playback, auto-bridge) sa overia na vlastných číslach skôr, než sa o ne oprie dizajn.

**Rozhodujúce kritériá**: (1) p95 „operátor zdvihol → `call.bridged`“ a „klik → prvý provider command“; (2) bezpečnosť súbehu — žiadna duplicitná vetva, žiadne 200 bez vykonania; (3) realizovateľnosť v povolenej architektúre (Vercel funkcie, jeden cron, zdieľaná DB).

**Alternatívy**

| Alternatíva | Výhody | Náklady / riziká | Rozhodnutie |
| --- | --- | --- | --- |
| A. Zoštíhliť app-side cestu: lean kontext, bridge-first, paralelné nezávislé príkazy, paralelný fanout, potom atomické RPC pre admisiu a kritický zápis, dávkový journal | Zachová všetky invarianty a dnešný dizajn hold/consult; merateľné po etapách; kód bez migrácie prinesie prvé zrýchlenie | Refaktor `persistTransition`/`executeReduceResult`; etapa 2 potrebuje 2 migrácie (výslovný súhlas) | **Základ plánu** |
| B. Telnyx-native auto-bridge pre inbound ponuky | 0 round tripov medzi answer a bridge; first-answer-wins v providerovi | Stráca guard pred bridge a ochranu zákazníckej vetvy; hold/consult/park/transfer treba prerobiť; nepodložené správanie MOH | Experiment v etape 3 na vlastných číslach; nie základ |
| C. Minimálny zásah: WAF + bridge-first + meranie, ďalej nič | Najmenšie riziko | Ponechá ~40–50 round tripov; podľa meraní 13. 9. odozva 5–10 s ostane | Použité ako etapy 0–1 s gate; ak meranie po E1 splní ciele, E2 sa nespustí |
| D. Worker/fronta a okamžité 2xx | Najlepšie oddelenie | Zakázané obmedzeniami repozitára | Neplatné v tomto rozsahu |

## 5. Etapy opravy

Každá etapa: dev → pracovná vetva → Preview → PR do dev → overenie dev aliasu → PR dev → main. Preview zdieľa živú DB; žiadne záťažové testy na Preview.

### Etapa 0 — cron a firewall nezávislé od nasadenia (dnes, vyžaduje súhlas)

- **Cieľ**: cron beží po každom produkčnom nasadení bez ručnej úpravy allowlistu; každé nasadenie to overí.
- **Okamžitý hotfix** (Vercel Firewall, súhlas používateľa): pridať host `pomoc-motoristom-7ua6n9kj1-alfopures-projects.vercel.app` a `dpl_AaeS5AtrznEY5YLz7cpftZXo1SnV` do allowlistu, overiť cron beh v logoch do 10 min.
- **Trvalé riešenie** (jedna z možností, súhlas používateľa):
  - O1 (odporúčané, vratné): invertovať pravidlá na **denylist** konečnej množiny nekompatibilných deploymentov (všetky produkčné/preview hosty a ID vytvorené pred skew boundary 2026-09-11T20:39:53Z, zoznam z `vercel ls`), allowlist zrušiť; skew boundary + maxAge ostávajú. Nové nasadenia nič nevyžadujú.
  - O2: výnimka v deny pravidle pre `path = /api/telephony/cron` a `user-agent = vercel-cron/1.0` — endpoint aj tak vyžaduje `CRON_SECRET` (`cron/route.ts:27–44`); overiť správanie akcií Vercel WAF (bypass vs. poradie pravidiel) pred zapnutím.
  - O3 (nevratné, samostatný súhlas): odstrániť staré nekompatibilné deploymenty, hosty budú 404; potom možno host pravidlá zrušiť úplne.
- **Post-deploy gate** (do release checklistu a `docs/operations`): po každom produkčnom/dev nasadení `GET https://<nemenný host>/api/telephony/cron` musí vrátiť **401** (nie 403), `crons.definitions[0].host` = aktuálny host, prvý plánovaný beh do 10 min s HTTP 200 v logoch; kanonický alias `/api/health/live` 200.
- **Rollback**: návrat na verziu 44 pravidiel; **stop**: ak by denylist nepokryl nekompatibilný build, doplniť ID pred ďalším nasadením.
- Bez kódu; bez migrácie; bez živých hovorov.

### Etapa 1 — kritická cesta bez migrácie (kód)

- **Cieľ**: `call.answered → bridge` ≤ 20 sekvenčných round tripov (z ~55–60), fanout paralelný, menej 500 na webhookoch.
- **Zmeny**:
  1. **Lean kontext pre answered ponuky**: v `loadRoutingContext` (`session-runner.ts:205–237`) pridať vetvu pre `call.answered`/`call.bridged` vetvy s `client_state.intent ∈ {ring, pickup, transfer*, internal}` v stave `ringing`/čakania: načítať iba `settings` (+ frozen recording policy z meta); presence/devices/ponuky/počet vetiev vynechať. Invariant: kompenzačný fork `enterWaiting` dostane `settings.parkMaxMinutes`; `requiresRecordingLease` číta frozen policy.
  2. **Bridge prvý**: v `onOfferAnswered` (`transitions.ts:1212–1218`) presunúť `bridge` pred `stopMoh`/`gather_stop`; obidva stop príkazy ostanú bestEffort. Invariant: kompenzácia `bridgeId` nezmenená (`:1219–1225`). Gate: test na vlastných číslach (10 hovorov s MOH) — ak MOH po bridge znie do hovoru, variant „bridge ∥ stop“ (bod 3) namiesto „bridge → stop“.
  3. **Paralelné nezávislé príkazy**: v `executeReduceResult` (`effects.ts:1358–1480`) vykonať skupinu nezávislých príkazov toho istého prechodu súbežne (`bridge` ∥ loser `hangup` ∥ `playback_stop`), závislé (conference_create → join → hold) ostávajú sekvenčné. Jeden `renew` na skupinu (TTL 15 s ≥ 12 s operačný budget, `ownership.ts:7–9`, `client.ts:43`), journal `prepare`/`result` per príkaz ostáva, checkpoint po skupine. Invariant: `completedCommands` doplniť až po úspechu každého príkazu; neznámy výsledok jedného príkazu neblokuje ostatné (dnes `break` na `:1552` — pri paralelnej skupine uplatniť rovnakú politiku per príkaz).
  4. **Kritické DB efekty pred bridge len pre víťaza**: v `persistTransition` s `phase: "critical"` zapísať pred príkazmi iba guard-rezerváciu + víťazovu vetvu (identita/`client_state`) + víťazov pokus; pokusy a presence porazených, member touches, call row a audit presunúť do projekčnej fázy (`effects.ts:1326, 1628–1668`), ktorá beží po odoslaní príkazov ešte v tej istej invokácii (pred 200). Jeden checkpoint po kritickej dávke namiesto po každom efekte; podmienka: všetky efekty v dávke idempotentné (leg/attempt UPDATE, presence RPC s tokenom/revíziou); `createCallbackRequest` (INSERT) ostáva s vlastným checkpointom.
  5. **Paralelný fanout**: `executeRingFanout` (`effects.ts:1147–1211`) — jedna dávková `insert` pokusov, jeden presence UPDATE, potom `Promise.allSettled` cez `executeDial` s limitom `maxRingFanout`; per-dial journal `prepare/result` a `upsertDialedLeg` ostávajú; `retryPending` sémantika a incidenty per člen zachované; jeden `renewLease` pred skupinou.
  6. **Ohraničené čakanie webhookov na lease**: `event-processor.ts:288` (a `:187`) z `leaseWaitMs: 0` na ≤ 1 200 ms s backoffom 150/300/600 ms; sweepy ostávajú 0. Odpoveď ostáva pravdivá (500 pri neprevzatí). Meria sa pomer doručení/udalostí (SQL F).
  7. **Admisia bez migrácie**: cache `resolveDefaultOrganizationId` per inštancia (statická), live-gate settings cache 1–5 s v `createTelephonyDeps` (`runtime.ts:69–77`).
- **Cieľové počty (3 operátori)**: answered → bridge HTTP ≈ 18–20 round tripov; fanout wall-clock ≈ 10 round tripov + 1 HTTP (namiesto 3×10); hangup ≈ 15.
- **Testy**: vitest reducer (poradie príkazov, fork), effects (paralelná skupina: úspech/neznámy/odmietnutý per príkaz, checkpoint po dávke, crash medzi dávkou a checkpointom → replay idempotentný), fanout (súbeh, guard `advanceRingStep`, 429/5xx per člen), `tests/postgres/telephony-fencing.py` bez zmeny výsledku; e2e prijatie/bridge.
- **Gate**: plný `vitest run`, Node testy, typecheck, build; Preview; dev alias smoke; potom **okno na vlastných číslach**: 10× inbound (3 operátori), 5× outbound, 5× hangup — SQL A/D/I pred a po.
- **Stop**: duplicitná vetva, 200 bez vykonania, MOH v hovore, zhoršenie p95. **Rollback**: revert vetvy, bez schémy.

### Etapa 2 — atomická admisia a kritický zápis (migrácie, súhlas)

- **Cieľ**: ≤ 8 sekvenčných round tripov pred `bridge` HTTP; fanout ≤ 6 + N paralelných HTTP.
- **Zmeny** (nové explicitné migrácie, `service_role` only, rovnaké fence hlavičky `x-telephony-*`, `ownership.ts:25–39`):
  1. `motorist_session_event_admit_v2(event…)`: v jednej transakcii claim webhooku (`motorist_telnyx_claim_webhook_event_v2`), `lease_acquire_v2`, `provider_observe_dial_v2`, návrat session + legs + attempts (+ settings). Nahrádza `event-processor.ts:236, 261`, `session-runner.ts:442, 452, 151–162, 538–543` (6–7 → 1).
  2. `motorist_apply_critical_v2(session, transition, guard)`: rozšírenie `motorist_stage_transition_v1` (`supabase/migrations/20260928110000_durable_transition_effects.sql:17–66`) o guard-rezerváciu a kritické leg/attempt zápisy s nastavením `databaseCursor` v tej istej transakcii (stage + fresh + guard + 3–6 zápisov → 1).
  3. `motorist_provider_commands_prepare_batch_v2` / `…result_batch_v2`: journal pre skupinu príkazov v 1+1 RPC (dnes 2+1 per príkaz).
  4. Projekcie (call row, audit, member touches, ledger finish) v jednom RPC alebo v `after()` — pending_effects vstup je už trvalý pred príkazmi (`effects.ts:1800–1816`), cron/ďalšia udalosť ich dokončí; podmienené funkčným cronom (etapa 0).
- **Invarianty**: triggery `motorist_telephony_session_write_guard`/`child_write_guard` bežia aj vnútri RPC (rovnaký request scope) — mixed-writer matica z `tests/postgres/telephony-fencing.py` sa rozšíri o nové RPC; kontrakt 1 vetvy nezmenené.
- **Gate**: izolovaný PostgreSQL + PostgREST (`tests/postgres/*`), 20 súbežných udalostí, pád v každom bode; migrácie aplikovať na kópiu len na výslovný pokyn a pred nasadením závislého kódu (expand → deploy → contract nie je potrebný, RPC sú aditívne). **Podmienka spustenia**: ak meranie po E1 dosiahne p95 ≤ 2 s answer→bridge, E2 sa odloží.

### Etapa 3 — ovládanie, mobil, presmerovanie (kód + experiment)

- Hold/consult/add-party: závislé príkazy ostávajú sekvenčné, ale journal dávkovo a jeden checkpoint (E1/E2 mechanizmy) → 3 HTTP + ~4 DB namiesto 3 HTTP + 15 DB. Hypotéza na overenie na vlastných číslach: podržanie bez zrušenia bridge (`bridge` s `hold_after_unbridge`/SDK hold) — až po meraní, nie súčasť základu.
- Presmerovanie/konzultácia/pridanie na **mobil kolegu**: v `CallTransferPicker` ponúknuť „mobil“ pri kolegoch s `default_mobile_number` (server už cestu s vlastníkom má, `call-actions.ts:273–285`; pre kontrakt 2 ide `controlledTransfer` cez `dial` + `link_to`, `transitions.ts:2259–2269`). Overiť konfiguráciu ring skupín: či majú mobilní operátori osobné číslo ako člena (`member.kind = external_number` s vlastníkom); kód to pre kontrakt 2 už podporuje (`transitions.ts:852`) — doplnenie je **rozhodnutie používateľa**, lebo osobné PSTN vetvy sú platené.
- Picker: ostať otvorený s priebehom (odoslané → potvrdené/odmietnuté) alebo zatvoriť až po `busyAction` skončení; chyba sa zobrazí v pickeri. Rozhodnutie UX s používateľom.
- Mobil standby: predĺžiť foreground standby počas stavu „dostupný“ (návrh 10 min) a zmerať push-to-wake → registrácia → prijatie (`call-notifications.ts`); pri skrytej appke ostáva push. Kompromis batéria/duplicitné registrácie — rozhodnutie používateľa.
- **Experiment B** (auto-bridge inbound, vlastné čísla, mimo produkčných liniek): 3 operátori s `bridge_on_answer`+`prevent_double_bridge`+`link_to`, overiť: kto vyhrá pri dvoch zdvihnutiach, čo sa stane so zákazníckou vetvou pri `conference_create` bez `park_after_unbridge`, MOH. Bez pozitívneho výsledku sa B nezavádza.

### Etapa 4 — polling a auth záťaž (kód)

- Per-inštanciová snapshot cache 1 s v `loadActiveCalls` (vzor `stats.ts:72, 335`); `recoverOwnEndedSessionPresence` len keď snapshot ukáže vlastnú presence so session; pri pripojenom Realtime interval 3 s je už floor (`poll-schedule.ts:51–56`).
- Auth: zmerať podiel `auth` kroku; vyhodnotiť lokálne overenie JWT (`getClaims`) namiesto sieťového `getUser()` — vyžaduje overenie nastavenia kľúčov projektu (hypotéza).
- Cieľ: ≥ 50 % menej DB požiadaviek z pollingu v rovnakom 10 min scenári.

### Etapa 5 — meranie a rozhodnutie o kapacite

- SQL A–J pred E1, po E1, po E2 (rovnaké scenáre, ≥ 30 vzoriek na cestu). `request-performance` logy: priemer `db.ms/db.count` per route → cena round tripu; ak > 100 ms pri nízkej záťaži, samostatná analýza gateway/pool (Supabase support), nie navyšovanie compute naslepo.

## 6. Pre-mortem

| Scenár | Prevencia | Overenie |
| --- | --- | --- |
| Paralelný fanout alebo paralelná skupina príkazov vytvorí po timeoute druhú vetvu | Journal per príkaz s nemenným `command_id`/fingerprintom; neznámy výsledok ostáva `unknown`, žiadny slepý redial mimo 60 s; `retryPending` per člen | Fault injection: 2. dial timeout, replay po 5 s a po 61 s; 0 duplicitných `POST /calls`; SQL H bez nárastu `unknown` |
| `bridge` pred `playback_stop` nechá MOH znieť v hovore alebo bridge zlyhá pri bežiacom playbacku | Test na vlastných číslach pred merge; pripravený variant „bridge ∥ stop“; `playback_stop` ostáva bestEffort s kompenzáciou len pre bridge | 10 hovorov s MOH: `call.playback.ended` do 1 s po `call.bridged`, subjektívne bez MOH v hovore |
| Zmena WAF sprístupní starý nekompatibilný build alebo znovu zablokuje cron | Denylist starých ID + skew boundary; post-deploy gate 401 na nemennom hoste; žiadny rollback na build spred boundary | Sonda: starý host 403, aktuálny host cron 401, plánovaný beh 200 v logoch do 10 min |

## 7. Rozšírený test plán

- **Unit/model (vitest)**: poradie príkazov v `onOfferAnswered`; paralelná skupina (úspech, 5xx/timeout = unknown, 4xx = rejected, lease loss); checkpoint po dávke a idempotentný replay; lean kontext nevyužíva presence; fanout súbeh (guard, kapacita, 429); webhook bounded wait (počet RPC ≤ 3, 500 pri neúspechu); picker stavy.
- **Integrácia (izolovaný PostgreSQL + PostgREST, `tests/postgres/`)**: nové RPC vs. fence triggery (stará generácia odmietnutá), 20 súbežných answered na jednu session (1 víťaz), pád pred/po dispatch, mixed writer matica, `webhook-retry-contract.py` bez regresie.
- **E2E (Chrome, fixtures)**: prijatie → bridge zobrazený z SDK udalosti bez čakania na poll; presmerovanie na mobil; picker priebeh; mobil standby/push.
- **Observabilita**: `server-timing` na každom volaní (`request-metrics.ts`), `telnyx-http` ms, SQL A–J; dashboard: p50/p95 answer→bridge, request→dispatch, deliveries/events, cron posledný beh.
- **Živé overenie**: iba vlastné čísla, dohodnuté okno, 3 operátori: inbound×10, outbound×5, hold/unhold×5, consult+complete×5, add-party×5, hangup počas pomalého POST×5; obojsmerný zvuk; 0 osirelých vetiev.

## 8. Merateľné kritériá prijatia (návrhy, nie sľuby)

| Oblasť | Kritérium | Vzorka |
| --- | --- | --- |
| Cron | 401 na nemennom hoste po každom nasadení; beh každých 5 min s HTTP 200 | každé nasadenie + 24 h logov |
| Answer → bridge (inbound) | p95 ≤ 2 s po E1, ≤ 1 s po E2; 0 nepotvrdených bridge | ≥ 30 |
| Round tripy | `steps.db.count` v `request-performance` pre `call.webhook` (answered) ≤ 30 po E1, ≤ 15 po E2; čas od začiatku requestu po `telnyx-http` bridge ≤ 20 round tripov po E1, ≤ 8 po E2 (odvodené z `server-timing` a `telnyx-http` časov) | ≥ 30 |
| Fanout | posledný člen ponúknutý ≤ 1 s po prvom (SQL I) | ≥ 20 krokov |
| Ovládanie | klik → prvý provider command p95 ≤ 1,5 s (SQL E) | ≥ 30 na akciu |
| Hangup | intent → zákaznícka vetva ukončená p95 ≤ 2 s (SQL G) | ≥ 30 |
| Webhooky | deliveries/events ≤ 1,3; 0 dead letters mimo neúplných nahrávok (SQL F) | 24 h |
| Polling | ≥ 50 % menej DB požiadaviek z `/calls/active` pri rovnakom scenári | 10 min × 2 |
| Bezpečnosť | 0 duplicitných vetiev, 0 „200 bez vykonania“ vo failpoint testoch | všetky testy |

## 9. ADR

- **Decision**: cron nezávislý od nasadenia; app-side bridge zachovaný, ale kritická cesta zúžená na guard + víťaz + bridge, s nezávislými príkazmi súbežne, paralelným fanoutom a neskôr atomickými RPC; Telnyx auto-bridge len ako experiment.
- **Drivers**: 55–60 sekvenčných round tripov pri ~150–250 ms; 5 s timeouty pred bridge; zablokovaná obnova; obmedzenia architektúry.
- **Alternatives**: iba minimálny zásah (nedostatočné podľa meraní), auto-bridge (nepodložené, prepis hold), worker (zakázané).
- **Why**: prvé zrýchlenie bez migrácie a bez zmeny invariantov; ďalšie kroky podmienené meraním.
- **Consequences**: dve aditívne migrácie v E2 (súhlas); WAF zmena (súhlas); testovacie okno na vlastných číslach pre 2 hypotézy.
- **Follow-ups**: cena round tripu (gateway/pool), Telnyx `webhook_timeout_secs` 10 → 30 kým handler p95 > 5 s (portál, súhlas), rozhodnutia o mobile (standby, PSTN členy).

## 10. Realizácia

- **Dostupné typy agentov**: `claude` (všeobecný), `general-purpose`, `Explore` (read-only vyhľadávanie), `Plan` (architektúra).
- **$ralph** (jeden vlastník, sekvenčne): E0 → E1 → meranie → E2 (ak treba) → E3 → E4; reasoning: E1/E2 vysoké (súbeh, SQL), E3/E4 stredné.
- **$team** (paralelné línie): (1) SQL/RPC kontrakty + `tests/postgres` — vysoké; (2) effects/runner/transitions (lean kontext, bridge-first, paralelné skupiny, fanout) — vysoké; (3) klient (picker, mobil target, standby, poll cache) — stredné; (4) ops (WAF návrh, gate, dashboard, SQL A–J) — stredné. Spustenie: `omx team "Implementuj .omx/plans/call-latency-repair-v2-2026-09-16.md; migrácie a WAF len na výslovný súhlas"` alebo `$team …`. Verifikačná cesta tímu: každá línia priloží testy + `server-timing` počty; integrátor spustí plný gate, Preview, dev alias, potom okno na vlastných číslach.
- **Goal-mode**: odporúčam `$performance-goal` (merateľné ciele z §8 ako evaluátory); `$ultragoal` pre trvalé sledovanie celej dodávky; `$autoresearch-goal` len pre výskum ceny round tripu.

## 11. Zmeny oproti plánu OpenAI

- **Zachovávame**: kontrakt 2 (fence, journal, termination intent), webhook retry kontrakt, pravdivú 200/500 politiku, dev-first rollout, oddelenie dôkazov a hypotéz, ich rozšírené testy.
- **Opravujeme**: nález 1 nie je jednorazový — príčinou je allowlist WAF; namiesto ručnej údržby denylist/výnimka + gate. „Fanout ostáva sériový“ (release doc 11. 9.) rušíme: sériový fanout a 5 DB round tripov na príkaz sú dnes najväčšia zostávajúca položka.
- **Dopĺňame**: presnú anatómiu round tripov (Príloha A) s cieľovými číslami, lean kontext pre answered, bridge-first, paralelné nezávislé príkazy a fanout, atomickú admisiu/apply RPC, ohraničené čakanie webhookov proti 500 búrke, pollingovú záťaž (chýbajúca cache, sieťový `getUser`), mobil target v UI, experiment auto-bridge s presne pomenovanými stratami, a read-only SQL na 30-vzorkové merania bez nových hovorov.

## Príloha A — anatómia round tripov `call.answered` (inbound, 3 operátori, kontrakt 2, nahrávanie vypnuté)

| # | Krok | Kód | Round tripy |
| --- | --- | --- | --- |
| 1 | `createTelephonyDeps`: organizácia + live gate settings | `runtime.ts:60–77`, `default-organization.ts:8–22` | 2 |
| 2 | claim webhooku (RPC) | `event-processor.ts:236–248` | 1 |
| 3 | `findSession` podľa `sid` | `event-processor.ts:81–86` | 1 |
| 4 | `ownedSessionWork`: probe + `lease_acquire_v2` (0 čakania) | `session-runner.ts:442, 452` | 2 |
| 5 | snapshot session/legs/attempts (paralelne) | `session-runner.ts:151–162` | 1 |
| 6 | `reconcileProviderEvent` + `provider_observe_dial_v2` | `session-runner.ts:538–543` | 2 |
| 7 | routing kontext: line+settings+policy ∥, personal settings, presence/devices/ponuky/počet ∥, incident recover | `session-runner.ts:238–344` | 3–4 |
| 8 | kontrola pending effects / cancellations | `session-runner.ts:574–595` | 1 |
| 9 | `stageEffects` RPC + fresh SELECT | `continuation.ts:91–104`, `effects.ts:1723` | 2 |
| 10 | guard `reserveAnsweredOperator` | `effects.ts:1266–1321` | 1 |
| 11 | kritické efekty s checkpointom po každom: víťazova vetva (SELECT+UPDATE+ckpt), 3 pokusy (UPDATE+ckpt), 2 presence porazených (SELECT+RPC+ckpt) | `effects.ts:186–259, 261–296, 308–345` | ≈15 |
| 12 | príkazy sekvenčne: `playback_stop`, `bridge`, 2× `hangup` — každý fresh SELECT + renew + prepare + HTTP + result + ckpt | `effects.ts:1365–1480`, `client.ts:488–502` | ≈20 + 4 HTTP |
| 13 | `observeParticipants` po bridge | `effects.ts:1473–1478` | 3–4 |
| 14 | projekcie: member touches, call row (2 čítania + zápis), audit (čítanie + insert), finálny checkpoint | `effects.ts:1628–1668, 465–520, 552–607` | ≈8 |
| 15 | ledger finish | `event-processor.ts:332` | 1 |
| | **Spolu** | | **≈ 60 + 4 HTTP**, `bridge` HTTP až po ≈ 38 |

Cieľ E1: `bridge` po ≈ 18–20; cieľ E2: ≤ 8.

## Príloha B — záznam Architect/Critic (self-review, sekvenčne, nie nezávislí agenti)

**Architect — antitéza**: „Stačí E0 + bridge-first + ohraničené čakanie webhookov + meranie; RPC redizajn je predčasný.“ **Napätie**: trvanlivosť/checkpoint po každom efekte vs. počet round tripov; ochrana zákazníckej vetvy vs. auto-bridge; pravdivé 200 vs. „2xx okamžite“. **Syntéza**: E1 bez migrácie a bez zmeny invariantov prinesie prvé zrýchlenie; E2 je podmienená meraním (§5 E2 podmienka spustenia); B ostáva experiment. Vyžadované zmeny zapracované: (1) checkpoint po dávke len pre idempotentné efekty, `createCallbackRequest` s vlastným checkpointom; (2) per-príkazová politika neznámeho výsledku pri paralelnej skupine; (3) `webhook_timeout_secs` zmena označená ako prevádzková, so súhlasom; (4) pôvodný nález N9 (nekonzistentné gating flagov) vyvrátený vlastnou kontrolou — `transitions.ts:852` odovzdáva `hasStabilityContract` do `planRingStep` — a odstránený. Verdikt po zapracovaní: APPROVE (s výhradou, že ide o self-review).

**Critic**: princípy ↔ alternatíva A konzistentné; alternatívy B/C/D férovo posúdené; pre-mortem presne 3 scenáre s prevenciou a overením; testy unit/integrácia/e2e/observabilita; kritériá s veľkosťou vzorky; obmedzenia AGENTS.md dodržané (migrácie a WAF len na súhlas, jeden cron, žiadny worker); hypotézy označené (MOH pri bridge, auto-bridge, `getClaims`, cena round tripu). Kontrola odkazov: 14 referencií overených čítaním (`transitions.ts:1212–1218, 974–980, 2095–2135, 2259`; `effects.ts:211–222, 1147–1211, 1365, 1480, 1800–1816`; `session-runner.ts:209–237, 288/442/452/454`; `event-processor.ts:288`; `client.ts:42–43`; `coordinated-webphone.ts:293–311`; `ring-plan.ts:264–266`, `transitions.ts:852`; `PhoneBar.tsx:446–449`). Nedostatky: čísla round tripov sú odvodené z kódu, nie zmerané na produkcii (poznačené); nezávislé review chýba (poznačené). Verdikt: APPROVE ako návrh na nezávislé preskúmanie.
