# AI demo „Veronika"

Jeden autorizovaný odchádzajúci hovor, v ktorom hovorí OpenAI `gpt-live-1` po slovensky. Telnyx vytočí SIP vetvu k OpenAI, potom mobil zákazníka a obe vetvy premostí. Zvuk nikdy neprechádza cez túto aplikáciu.

**Stav: hovor zatiaľ neprebehol.** Kód je overený offline (testy s mockmi a migrácia proti skutočnému PostgreSQL). Že OpenAI projekt má povolený SIP, že sa Veronika ozve po zdvihnutí a aká je jej slovenčina — nič z toho zatiaľ overené nie je.

## Čo je predvolene vypnuté

Bez `AI_DEMO_ENABLED=true` je celá funkcia inertná:

| Miesto | Správanie pri vypnutom prepínači |
|---|---|
| Záložka „AI" v nastaveniach telefónie | Neexistuje (ani pre admina). |
| `/api/telephony/ai-demo/*` | 403 `ai_demo_disabled`, žiadny zápis, žiadne volanie poskytovateľa. |
| `/api/telephony/webhooks/openai` | 200 `disabled` — bez overenia podpisu, bez čítania z databázy. |
| Cron `runAiDemoCleanup` | `disabled`. |
| Webhook Telnyxu | Odbočka sa týka iba vetvy s `client_state.intent = "ai_demo:*"`, ktorý nastavujeme výhradne my. Ľudské hovory sa do nej nedostanú. |
| Migrácia | Pridáva jednu novú tabuľku. Nemení žiadnu existujúcu. |

Bez aplikovanej migrácie vracajú routy 503 `ai_demo_migration_missing`.

## Ako to otestovať bez nasadenia

Tri úrovne, od najlacnejšej. Prvé dve nepotrebujú účet, nasadenie ani telefón.

### 1. Offline skúška celého toku (žiadny účet, žiadne náklady)

```bash
pnpm exec vitest run src/server/telephony/ai-demo src/app/api/telephony/webhooks/openai
```

`rehearsal.test.ts` prejde celý hovor cez tie isté vstupné body ako produkcia — službu štartovacej routy, handler OpenAI webhooku a `processTelnyxEvent` — s falošnými poskytovateľmi. Overuje aj to, čo sa pri živom teste kontroluje ťažko: že mobil sa vytočí **práve raz** a že sa uvoľnia obe vetvy aj OpenAI relácia.

### 2. Migrácia proti skutočnému PostgreSQL (žiadny účet, žiadne náklady)

```bash
sudo dnf install -y postgresql16-server postgresql16-contrib   # alebo: brew install postgresql@16
bash tests/postgres/ai-demo-attempts.sh
```

Založí jednorazový klaster, aplikuje presne tento migračný súbor a overí: idempotenciu opakovaného behu, „jedno demo naraz", idempotenciu `request_id`, vlastníctvo `call_control_id`, `check` na stave, trigger `updated_at`, zapnuté RLS a nulové práva pre `anon`/`authenticated`. Zdieľanej databázy sa nedotkne.

### 3. Izolovaná kópia pre živý hovor

Živý hovor potrebuje verejnú URL pre dva webhooky. Aby sa nedotkol rozrobenej práce na `dev` a na produkcii, používa sa **samostatná kópia** — vlastný Vercel projekt a vlastná Supabase databáza.

Väčšinu spraví skript:

```bash
cp scripts/ai-demo-copy.secrets.example .context/ai-demo-copy.secrets   # vyplň tokeny (súbor je gitignorovaný)
bash scripts/setup-ai-demo-copy.sh
```

Založí novú Supabase databázu, aplikuje do nej migrácie a seed, založí nový Vercel projekt a prenesie doňho premenné z Preview existujúceho projektu — okrem Supabase hodnôt, `CRON_SECRET` (aby kópia nespustila druhý scheduler) a kľúčov na e-mail. Vercel projekt **nie je napojený na Git**: nasadzuje sa ručne z pracovného stromu, takže ho nikoho push neprenasadí. Opakované spustenie existujúce zdroje iba použije.

Zvyšok — Telnyx aplikácia a OpenAI webhook — vypíše skript na konci. Ručný postup je nižšie.

**A. Kópia databázy**

1. Nový Supabase projekt (Frankfurt), napríklad `pomoc-motoristom-aidemo`. Nesmie to byť pôvodná produkcia `sjcsrygkkmersoczpunh` — `scripts/assert-target-project.mjs` ju odmietne.
2. Aplikovať doňho migrácie z `supabase/migrations/` a `supabase/seed.sql`. Tým vznikne prázdna kópia schémy s demo dátami; žiadne reálne prípady.

**B. Kópia aplikácie**

3. Nový Vercel projekt nad tým istým repozitárom, región `fra1`, produkčná vetva nastavená na pracovnú vetvu `feat/ai-demo-veronika`. Takto má vlastnú URL a vlastné env premenné a nezasahuje do `dev` ani do `test.dispecing.linkapomoci.sk`.
4. Premenné: Supabase kľúče z bodu 1, `TELNYX_*` (pozri nižšie), blok `AI_DEMO_*` a `OPENAI_LIVE_*` z `.env.example`. `EXPECTED_SUPABASE_PROJECT_REF` nastav na ref novej databázy.
5. **Cron:** nový projekt zdedí `vercel.json`, takže by bežal druhý `/api/telephony/cron`. Buď mu nenastav `CRON_SECRET` (cron potom vracia 401 a nič nerobí), alebo cron v projekte vypni. Čistenie dema si viem spustiť aj ručne.

**C. Telefónia**

6. Telnyx: vytvoriť **novú Call Control aplikáciu** pre túto kópiu a jej `webhook_event_url` nastaviť na URL nového Vercel projektu. Číslo `+421232408774` (`3043592669122004035`) dočasne prepnúť na túto aplikáciu a po teste vrátiť späť. Dovtedy hovory na toto číslo nevidí ani `dev`, ani produkcia — preto treba krátke okno a informovaných operátorov.
   - Pre **odchádzajúci** hovor stačí, aby číslo vedelo originovať. Ak prvý pokus vráti `10010`, číslo na danej aplikácii originovať nevie a prepnutie je nutné.
7. OpenAI: vyhradený projekt s povoleným GPT-Live SIP, webhook endpoint na `https://<nová-doména>/api/telephony/webhooks/openai`, odber iba `live.transport.incoming`, kredit ≥ 5 USD, usage tier ≥ 1.

**D. Test**

8. `AI_DEMO_ALLOWED_RECIPIENTS` = mobil majiteľa. `TELNYX_LIVE_CALLS_ENABLED=true`, `AI_DEMO_ENABLED=true`, redeploy.
9. V novej databáze zapnúť `live_calls_enabled`: `PATCH /api/telephony/config/settings` s telom `{ "liveCallsEnabled": true }` (alebo cez záložku Bezpečnosť).
10. Záložka „AI" → „Overiť u poskytovateľov" → `missing: []`, `gpt-live-1` dostupný, `did.onThisApp: true`, `webSocketGlobal: true`, `migrationApplied: true`.
11. Zavolať. Postup a merania nižšie.
12. Po teste: vypnúť oba prepínače, vrátiť číslo na pôvodnú aplikáciu, prípadne deaktivovať OpenAI endpoint.

Alternatíva bez Vercelu: `next dev` lokálne proti lokálnej Supabase (`supabase start`) a tunel (`cloudflared tunnel --url http://localhost:3000`) ako webhook URL. Rovnaká izolácia, ale tunel musí bežať celý čas testu.

## Priebeh hovoru

| # | Čo sa deje | Stav |
|---|---|---|
| 0 | Admin klikne „Zavolať" | `requested` → `sip_dialing` |
| 1 | Telnyx vytáča SIP k OpenAI (TLS + SRTP, `send_silence_when_idle`) | `sip_dialing` |
| 2 | OpenAI pošle `live.transport.incoming`, prijmeme reláciu a v tele accept-u odovzdáme celý prompt | `ai_offered` → `ai_accepted` |
| 3 | SIP vetva zdvihne → vytáčame mobil s `link_to` + `bridge_on_answer` | `mobile_dialing` |
| 4 | Zákazník zdvihne, Telnyx premostí | `bridged` |
| 5 | Po odpovedi na webhook otvoríme sideband, pošleme pozdrav a spúšťač | `talking` |
| 6 | Rozhovor, max. 300 s (strop drží Telnyx, nie aplikácia) | `talking` |
| 7 | Zloženie / „Ukončiť" / deadline | `ending` → `ended` \| `failed` |

Vetva k AI sa vytáča **prvá**. Preto sa zlyhania (nepovolený SIP, odmietnutý accept, zlé caller ID) stanú skôr, než niekomu zazvoní telefón.

`failed` nastáva práve vtedy, keď je vyplnený `error_code`. Nezodvihnutý telefón ani zloženie zákazníkom nie sú chyba.

## Latencia

Jediné, čo počuje volaný: ako dlho po zdvihnutí Veronika prehovorí. Merajú sa tri veci a sú v záložke „AI" aj v histórii:

| Merané | Odkiaľ |
|---|---|
| `first_word_ms` | Od premostenia po prvý `session.output_transcript.delta`. Toto je „prvé slovo po zdvihnutí". |
| `greeting_appended_ms` | Kedy OpenAI potvrdil pokyn na pozdrav. Potvrdenie **nie je** dôkaz, že to volaný počul. |
| `response_gaps_ms` | Medzery medzi tým, ako volajúci dohovorí a Veronika začne — za úvodných ~18 s hovoru. |

Čo je pre to spravené:

- Celá osobnosť, scenár aj kontext idú do tela `accept` — teda **kým telefón ešte zvoní**. Po zdvihnutí zostáva na kritickej ceste jeden webhook, jedno otvorenie WebSocketu a dva príkazy.
- Tie dva príkazy sa posielajú **naraz**, bez čakania na potvrdenie medzi nimi. WebSocket zachováva poradie, takže server ich uvidí správne; čakanie by pridalo celý round trip presne vtedy, keď niekto drží telefón pri uchu a nič nepočuje.
- Delegovaný backend má `reasoning.effort: "none"` a `service_tier: "ultrafast"`, lebo uvažovanie je v telefóne ticho. Ak projekt `service_tier` nepozná, accept sa raz zopakuje bez týchto polí — demo nesmie padnúť na ladení rýchlosti.
- Prompt na troch miestach opakuje „krátke vety, jedna otázka naraz, pri prerušení okamžite prestaň hovoriť". Kratšia replika = kratšia odozva.

Sideband sa po úvodných sekundách zatvára. Odozvu v druhej polovici hovoru preto treba posúdiť uchom a stopkami — dlhší odposluch by znamenal proces bežiaci celý hovor, čo toto nasadenie nedovoľuje.

## Ako znie — a čo sa s tým dá robiť

Namerané na živých hovoroch. API nemá parameter na rýchlosť ani štýl reči — jediné dve páky sú **hlas** a **prompt**.

| Hovor | Hlas | Prvé slovo po zdvihnutí |
|---|---|---|
| 17. 9., pôvodný prompt | `marin` | 2 215 ms |
| 18. 9., skrátený prompt | `gleam` | 1 021 ms |
| 18. 9. | `gleam` | 1 018 ms |
| 18. 9. | `gleam` | 978 ms |

Skrátenie hlasového promptu z ~5 500 na ~1 500 znakov **znížilo čas do prvého slova na polovicu**: model má pri inicializácii relácie o 4 000 znakov menej na spracovanie, než môže prehovoriť. Prirodzenosť a rýchlosť tu ťahajú za ten istý povraz.

**Hlas.** Dokumentácia označuje pri každom hlase zdroj: *Natural* (nahrávaný človek) alebo *Generated* (syntetizovaný). Predvolený `marin` v tej tabuľke nie je, takže jeho zdroj je nezdokumentovaný. Predvolený hlas dema je preto `gleam` — ženský, nahrávaný. V záložke „AI" sa dá hlas prepnúť pre jednotlivý hovor (nahrávané sú v zozname prvé), takže sa dajú porovnať bez redeploy. Hlas sa počas hovoru už zmeniť nedá; ukladá sa k pokusu, takže história hovorí, ktorý hlas bol naozaj počuť.

**Prompt.** Prvá verzia porušovala dve výslovné odporúčania z prompting guide:

| Odporúčanie | Čo bolo zle | Ako je to teraz |
|---|---|---|
| „Only add a rule if you need to change a specific behavior." | ~5 500 znakov pravidiel. Model pravidlá *predvádzal*. | Hlasový prompt má ~1 500 znakov. |
| „Keep long business procedures in the backend prompt." | Číslovaný postup bol v hlasovom prompte. | Postup je v `delegation.responses.instructions`; hlasový prompt vie iba **prečo** volá. |
| „Use moderate backchannels… do not add a blanket 'never speak while the user is speaking' rule." | Prompt hovoril „po otázke prestaň hovoriť a počúvaj" — potláčalo to prirodzené „hm". | Prikyvovacie zvuky sú výslovne povolené; prerušenie je formulované ako v šablóne. |
| — | „Krátko: jedna až dve vety" + „žiadne dlhé úvody" robili reč sekanou. | „Vrelo a prirodzene, nezhonným tempom", vety raz kratšie, raz dlhšie. |
| — | Pozdrav znel „povedz presne toto a nič viac" — návod na čítanie textu. | „Povedz to prirodzene a vrelo, nie ako čítaný text." |

Ponechané zostali pravidlá, ktoré samy osebe slúžia prirodzenosti — napríklad že časy sa hovoria „o pol tretej", nie „14:30".

**Meranie odozvy.** Prvá verzia merala od okamihu, keď volajúci *začal* hovoriť, takže do odozvy počítala aj jeho vlastnú vetu; teraz sa meria od chvíle, keď dohovoril. A keďže prompt o prikyvovanie priamo žiada, krátke prehodenie (pod 700 ms) sa označí ako `backchannel` a do odozvy sa nepočíta — inak by demo vyzeralo rýchlejšie, než je. Okno odposluchu je 40 s (webhook má rozpočet 60 s), takže zachytí úvodných niekoľko výmen, nie jednu.

## Bezpečnostné hranice

- **Brány pred vytočením:** `AI_DEMO_ENABLED`, `destination_allowlist` organizácie, voliteľný užší zoznam `AI_DEMO_ALLOWED_RECIPIENTS` a voliteľný denný limit. Ani jednu nevie ovplyvniť telo požiadavky. Posledné dve sa dajú vypnúť (prázdna hodnota, resp. `0`) — vtedy platí to isté pravidlo ako pre bežný odchádzajúci hovor dispečera a záložka to napíše.
- **Model nikdy nevidí telefónne číslo** a nemá nástroj, ktorým by hovor vytvoril, prepojil alebo ukončil.
- **Caller ID je fail-closed:** iba neutrálna linka (alebo `+421232408718` na výslovný pokyn) a iba ak je v tejto organizácii aktívna. Záznam `…8700` je zakázaný v oboch tvaroch, ktoré Telnyx ukladá.
- **Podpis webhooku nie je oprávnenie.** Platný podpis dokazuje, že udalosť je od OpenAI — nie že za ňou stojí náš hovor. Autoritou je riadok, ktorý vznikol kliknutím admina. Nespárovanú reláciu potvrdíme a ignorujeme; SIP 603 by znamenal rozhodovať za cudzí hovor.
- **Zlyhanie nikdy nevytáča.** Neistý výsledok (timeout, 5xx) nechá pokus otvorený pre cron; nikdy sa neopakuje spoplatnené vytáčanie.
- **„Ukončiť" funguje aj pri vypnutých prepínačoch.** Vypnutie nových hovorov nesmie byť dôvod, prečo sa bežiaci hovor nedá zložiť.
- **Logy a databáza neobsahujú obsah rozhovoru.** `latency_probe` drží iba milisekundy a smer (`in`/`out`). Nahrávanie ani prepis nie sú súčasťou dema.

## Postup živého testu

Predpoklady: kroky A–C vyššie hotové, mobil po ruke, stopky, okno ≤ 20 minút.

1. Preflight bez jediného `false` (okrem `did.onThisApp`, ak testuješ len odchádzajúci hovor a prvý dial nevráti `10010`).
2. Zadaj číslo, účel „Auto je opravené…", kontext napr. „Pán Novák, Škoda Octavia, náhradné vozidlo Fabia", zaškrtni potvrdenie, **Zavolať**.
3. **NO-GO:** ak sa do 35 s neobjaví „AI prijala hovor" ani „Vytáčam zákazníka", alebo skôr „Zlyhalo" — zapíš `error_code` a skonči:
   - `sip_rejected` → SIP nie je na projekte povolený (najpravdepodobnejšie pri prvom pokuse)
   - `sip_no_answer` → INVITE odišiel, ale nikto neodpovedal
   - `sip_dial_rejected` + `10010` → číslo z tejto aplikácie neoriginuje
   - `accept_failed` / `openai_auth` → kľúč nepatrí projektu alebo nemá práva
4. Telefón zazvoní → zdvihni a **mlč**. Zapíš čas od zdvihnutia po prvé slovo. Ak do 5 s ticho, povedz „Haló?".
5. Do 3 minút: potvrď, že máš chvíľku → dohodni deň → **prerušte ju** („vlastne radšej v stredu") → spresni čas a miesto → nechaj si zopakovať zhrnutie → skús „chcem hovoriť s človekom" → rozlúč sa a **zlož**.
6. Časová os do 60 s ukáže „Ukončené". Ak nie, stlač **Ukončiť**.

Zapíš: zobrazené číslo volajúceho, `first_word_ms` z UI aj podľa stopiek, odozvu po prerušení, zrozumiteľnosť slovenčiny 1–5, či zhrnutie sedelo, `end_reason`, `greeting_status`.

## Keď treba hovor zastaviť

1. **Ukončiť** v záložke „AI" (idempotentné).
2. Núdzovo `PATCH /api/telephony/config/settings` `{ "liveCallsEnabled": false }` — nové hovory dostanú 423, čistenie tým blokované nie je.
3. Ak zlyhá aj routa: Telnyx portál → Active calls → zložiť obe `call_control_id` (sú v `GET /api/telephony/ai-demo/<id>`). OpenAI relácia zanikne cez SIP BYE.
4. Aj bez akéhokoľvek zásahu ukončí hovor `time_limit_secs` na strane Telnyxu (300 s mobil, 350 s SIP).

## Rollback

Vypnúť `AI_DEMO_ENABLED` a `TELNYX_LIVE_CALLS_ENABLED`, vrátiť číslo na pôvodnú Call Control aplikáciu. Pri vypnutých prepínačoch je kód inertný, takže revert PR nie je potrebný. Migrácia sa neodstraňuje — pridáva iba jednu tabuľku, ktorú nič iné nepoužíva.

## Čo zostáva neoverené

- Či má OpenAI projekt povolený SIP (nedá sa zistiť API dopytom, iba pokusom alebo z dashboardu).
- Či Veronika po zatvorení sidebandu naozaj prehovorí, a ako dlho to trvá.
- Kvalita slovenčiny modelu `gpt-live-1` — dokumentácia slovenčinu vôbec nespomína a hlasy sú popísané ako anglické/portugalské.
- Či `from_display_name` prežije do hlavičky `From`, ktorú OpenAI pošle späť (korelácia sa naň preto nespolieha).
- Či je `service_tier: "ultrafast"` na projekte dostupný (accept má fallback).
- Presný tvar `session.commentary.append` — odvodený z referencie, nie z príkladu.
