# Pomalé hovory 25. 9. 2026 — príčina, opravy, kapacita

Ráno boli hovory v poriadku, okolo obeda extrémne pomalé. Operátori čakali na spojenie
až 45 s, klik „Prijať" trval 12–23 s alebo skončil chybou 503.
Všetky časy sú SELČ; zdroj dát je produkcia (`ifpaeegaesdmljfkdvcn`, Vercel `fra1`).

## Hlavná príčina: typ API kľúča

Server pristupoval do Supabase kľúčom `sb_secret_…`. Na tomto projekte je každá
takáto požiadavka drahá: gateway pre ňu vyrába nový JWT a PostgREST ho tak nikdy nemá
v cache. Merané priamo na produkcii, rovnaký mix čítaní ako `calls/active`:

| | CPU inštancie / požiadavka | latencia gateway p50 / p95 | saturácia (Medium) |
|---|---|---|---|
| `sb_secret_` | ~36 ms | 66 / 294 ms pri 20 req/s | ~30–40 req/s (p50 1–9 s) |
| legacy `service_role` JWT | < 1–4 ms | 28 / 37 ms | pri 142 req/s p50 30 ms, CPU 28 % |

Počas testov 3–4 konzoly vytvárali 30–50 req/s, takže DB bola zahltená. Každý krok
hovoru robí 25–76 postupných dopytov pod zámkom hovoru. Preto sa z ~100 ms na dopyt
stalo 300–700 ms a z 3–5 s na krok 20–30 s. Webhooky, ktoré nezískali zámok do 2 s,
vracali 500 (74 % doručení) a Telnyx ich posielal znova, čo záťaž ešte zvýšilo.

Vercel nebol príčinou: cold starty 0–1 %, event loop 7–13 %, pamäť ~350 MB/2 GB,
jediný timeout za deň. Telnyx doručoval webhooky do 1 s.

Okolo obeda naviac 12:12–12:26 bežal na produkcii „production case reset" cez
Management API (zámok `motorist_case_editor_sessions` 12:23–12:24) a o 12:26
bol reštart DB pri navýšení výkonu (~3 min výpadok).

## Nasadené opravy (priamo do `main` na pokyn vlastníka)

| PR | zmena | efekt |
|---|---|---|
| #305 | server preferuje legacy `SUPABASE_SERVICE_ROLE_KEY` (JWT); `getClaims()` namiesto GoTrue; profil v cache 30 s | REST p50 54–62 → 12 ms, dopyt z aplikácie 118 → 38 ms (pri nízkej záťaži) |
| #306 | zvonček obnovuje `calls/active` max. 1×/s (skrytá karta 3 s), frontu spätných volaní max. 1×/10 s; hovor kolegu nezapína 750 ms polling; cache prepínača živých hovorov 5 s; pozvánky 30 s, nahrávanie 15 s | menej požiadaviek na konzolu, najmä počas hovorov |
| #307 | webhook bez zámku po uložení do ledgera odpovie 200 a dobehne na tom istom hoste (`drainDeferredDelivery`, okno 30 s) | žiadne opakované doručenia Telnyxu; poradie podľa priority (zavesenie > prijatie > …) |
| #308 | migrácia `20261008100000_quiet_internal_session_writes`: zvonček ignoruje `ownership_generation`, `pending_effects` a retry kurzory | prevzatie zámku a kontrolné body už nezvonia všetkým konzolám |

Návrat bez zmeny kódu: `SUPABASE_PREFER_SECRET_KEY=true` vo Vercel env (a nový deploy
`main`, nie redeploy starého). Migrácia #308 je aplikovaná len na produkcii.

## Kapacita po opravách

- Medium (2 zdieľané vCPU) s legacy JWT: ≥ 140 req/s pri p50 ~30 ms, CPU ~28 %.
- Odhad záťaže: nečinná konzola ~1–1,5 req/s. Konzola počas zmien v hovore najviac
  ~5 req/s. Jeden hovor v priebehu nastavovania ~5–10 req/s.
- 20 konzol + 5 súbežných hovorov ≈ 50–130 req/s, čo Medium zvládne.
- Väčší výkon DB teraz nepomôže nič podstatné. Pri raste nad ~30–50 operátorov
  alebo pre predvídateľnosť: Large (dedikované vCPU).

## Ďalšie kroky (nerobené, podľa prínosu)

1. `call.initiated` operátorskej vetvy bez zámku. Stav `ringing` treba zapisovať
   už v `upsertDialedLeg`. Ide o N udalostí na hovor, ktoré dnes berú zámok.
2. Jedno „admit" RPC (claim + session + lease + snapshot) a jedno „complete" RPC
   na webhook, čím sa ušetrí ~8 kôl na udalosť.
3. Skladanie kontrolných bodov do RPC, ktoré už zamyká riadok (`apply_critical_v2`,
   `result_batch_v2`). Začiatok a koniec kroku zvonenia ako RPC ušetrí ~10N−2 dopytov.
4. Jeden poller na operátora naprieč kartami (Web Locks + BroadcastChannel ako
   pri webphone).

## Meranie po ďalšom teste

`scripts/telephony-logs/` obsahuje:
- `fetch-request-logs.mjs` sťahuje Vercel request logy priamo cez API, lebo
  `vercel logs` (CLI 51.8) pri stránkovaní vracia stále tú istú stránku;
- `summarize-request-logs.mjs` robí prehľad po intervaloch: požiadavky, 500 webhookov,
  čas dopytu do DB, auth, lease;
- `webhook-cost-by-window.mjs` ukazuje čas a počet DB dopytov podľa typu udalosti a okna.

Časovanie udalostí je v `motorist_call_events.normalized_payload.timing` (E9);
výstup spracúva `scripts/measure-telephony-latency.mjs`.
