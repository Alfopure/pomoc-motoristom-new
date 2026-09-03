# Bezpečnostný audit & plán opravy — motorist-app

> **Zdroj:** audit repozitára (júl 2026). Obsahuje manažérske zhrnutie + **FINÁLNY plán opravy schválený konsenzom**
> (ralplan: Planner → Architect → 2× Critic, **3 iterácie, verdikt APPROVE**). Všetky faktické tvrdenia v pláne sú
> **overené proti aktuálnemu kódu** (čísla routes, riadky, guard vzory).
> **Dôležité:** audit aj plán boli iba analýza — pri nich sa žiaden aplikačný kód nemenil. Tento dokument je deliverable
> vetvy `manazersky-vystup-slovensky` a slúži ako podklad pre exekúciu opráv.
> Súvisiace: [`security-model.md`](./security-model.md).
> **Poznámka (september 2026):** audit vznikol nad kódom s predchádzajúcim telefónnym providerom. Jeho routes a moduly (probe routes, `webphone/*`, `queues/*`, `calls/active`, `call/create`, `recordings/sync`) boli pri prechode na Telnyx odstránené; zmienky o nich nižšie sú historické a zoznamy routes treba pred exekúciou znovu overiť proti `src/server/route-auth-registry.ts`.

---

## 1. Manažérske zhrnutie

**Celkové hodnotenie: C+** — aplikácia funguje, aktívne sa vyvíja a beží v produkcii, ale má jednu vážnu bezpečnostnú dieru, ktorú treba riešiť hneď.

### Čo je dobré
Základy sú lepšie ako pri väčšine podobných projektov: čistý kód bez chýb, 131 prechádzajúcich testov, poriadna dokumentácia a bezpečne uložené heslá a kľúče (nič citlivé nie je v repozitári).

### Najväčší problém (riešiť ihneď)
**Asi 11 API rozhraní nemá žiadnu kontrolu prihlásenia.** Ktokoľvek, kto pozná adresu, dokáže bez prihlásenia:
- **spustiť reálny telefonát** cez ústredňu (stojí to peniaze, dá sa zneužiť na obťažovanie),
- **vytiahnuť osobné údaje klientov** (meno, telefón, história prípadov) podľa telefónneho čísla — problém z pohľadu GDPR,
- odhlásiť operátorov z hovorovej fronty, meniť výsledky hovorov, posielať SMS.

Keďže celá appka pristupuje k databáze cez servisný kľúč (ktorý obchádza databázovú ochranu), tieto chýbajúce kontroly sú jediná obrana — nič za nimi už nechytá.

### Ďalšie slabiny
- **Najrizikovejší kód nemá testy** — najväčší súbor (3 682 riadkov) nemá ani jeden test, takže sa ťažko bezpečne upravuje.
- **Chýba automatická kontrola pri každej zmene** (CI) — nič nezachytí chybu pred nasadením.
- **Žiadny monitoring** — keď zlyhá hovor alebo SMS, nikto sa to nedozvie.
- **Chýba ochrana proti CSRF na väčšine mutačných rozhraní** (podrobná analýza v pláne našla ~28 mutačných rozhraní bez tejto ochrany).
- Trochu duplicitného a mŕtveho kódu, ktorý mätie.

### Odporúčaný postup
1. **Hneď:** doplniť kontrolu prihlásenia na tých ~11 rozhraní (rieši kritickú dieru), pridať automatickú CI kontrolu, zmazať mŕtvy kód.
2. **Potom:** napísať testy na kľúčové časti, zaviesť monitoring hovorov/SMS.
3. **Neskôr:** rozdeliť príliš veľké súbory a zoptimalizovať výkon.

**Dobrá správa:** správny vzor zabezpečenia už v projekte existuje (jedno rozhranie ho má správne) — stačí ho rozšíriť na ostatné, nemusí sa nič vymýšľať. Ide o lacnú opravu s veľkým dopadom.

---

## 2. Plán opravy (FINÁLNY — konsenzus, verdikt APPROVE)

> Konsenzus verzia po 3 iteráciách (Architect + 2× Critic). Všetky faktické tvrdenia sú **OVERENÉ čítaním kódu** (nie odhad). Táto verzia definitívne zatvára **4 Critic blockery (A–D)** — presná špecifikácia v sekcii „Ako sme uzavreli Critic blockery" nižšie. Mode: **DELIBERATE**. Kľúčové korekcie oproti pôvodnému draftu = `⚠ KOREKCIA`.

### RALPLAN-DR summary (DELIBERATE)

#### Princípy (5)
1. **Zastav krvácanie skôr, než prestavuješ** — najprv per-route hotfix guardy, až potom centrálny mechanizmus. Žiadny NOVÝ globálny runtime mechanizmus v hotfix fáze.
2. **Bezpečnosť je default, nie opt-in** — pridať route bez guardu má byť takmer nemožné; **fail-closed behaviorálny enumeračný test to zachytí v CI čase, s nulovým prod rizikom**. Primárna sieť = default-secure test s **verným mock-harnessom**, NIE edge middleware.
3. **Rozšír existujúci vzor, nevymýšľaj nový** — session guardy (`requireDefaultMotoristOrgMember/OrgRole/Actor`), bearer guardy (`authorizeRecordingsSync` + `timingSafeEqual`, resp. inline `authorize()` + `safeEquals` v commander routes) a CSRF (`assertSameOriginRequest`) UŽ fungujú a sú overené.
4. **Safety net pred zmenou správania** — žiadne pridanie throwing-auth do workflow kódu bez charakterizačných testov; žiaden refaktor god-files bez nich.
5. **Rozumná miera, nie enterprise** — single-tenant realita; RLS ostáva defense-in-depth backstop, admin-client architektúra sa neprepisuje. Držíme **PRÁVE TRI** reprezentácie jednej auth-pravdy (register 0.4 = konfig, behaviorálny test 0.2 = nezávislá brána, wrapper 2.1 = runtime), NIE štvrtú (edge middleware ZMAZANÝ — viď ADR).

#### Decision drivers (top 3)
1. **Kritická expozícia teraz** — citlivé routes vie zavolať ktokoľvek bez prihlásenia: `telephony/call/create` (reálny PBX hovor = peniaze), `telephony/calls/match` → `findCallerMatches` (PII/GDPR lookup podľa tel. čísla), `telephony/queues`/`calls/active` (PBX topológia/fronta), `cases/[id]/sms` (odoslanie SMS). Čas do opravy > elegancia.
2. **Nulová sieť testov na najrizikovejšom kóde** — `motorist-mutations.ts` má 3682 riadkov a 0 charakterizačných testov; každý väčší zásah je slepý. `telephony/sms/dispatch` workflow tiež.
3. **Deploy priamo do produkcie + Vercel preview bez auth** — „otestujem na preview" NEEXISTUJE. Load-bearing overenie musí byť deploy-safe vitest s **verným Supabase mock-harnessom** (`NODE_ENV=test`, mimo 6 dev-bypassov), nie reálny prod-hovor a nie preview.

#### Viable options pre CENTRÁLNE vynútenie auth
- **A — Per-route guardy manuálne (hotfix).** *Pros:* najrýchlejšie, najnižšie riziko, zachová nodejs runtime + presné role/org gating. *Cons:* sám osebe nebráni budúcemu zabudnutiu → kryje ho C-test (0.2). → **prijaté ako Milestone 1**.
- **B — Next.js `middleware.ts` ako PRIMÁRNY mechanizmus (aj role/org).** *Pros:* jedno miesto, globálne. *Cons:* routes bežia na `nodejs` runtime + Supabase SSR cookies; role/org gating v edge middleware = krkolomná per-route mapa rolí; `motorist_profiles` lookup na edge je neprirodzený. → **ZAMIETNUTÉ ako primárne**.
- **C — `withMotoristAuth()` wrapper + fail-closed behaviorálny enumeračný test (cieľ).** *Pros:* centrálne vynútené cez test, zachová nodejs runtime aj presné role gating, žiaden per-request DB call navyše, nová route guarded-by-default. *Cons:* vyžaduje migráciu ~50 routes + disciplínu + verný mock-harness. → **cieľový stav Milestone 2**.
- **B' — TENKÝ auth-only edge middleware ako druhý riadok.** *Pros:* deny-by-default na `/api/**`. *Cons:* NOVÝ globálny mechanizmus (`src/middleware.ts` OVERENE NEEXISTUJE → porušuje Princíp 1/3/5), fatálny blast-radius (zlý allowlist = celá appka 401) BEZ preview siete (parita dokázateľná iba v prode), a hodnotu „nová route default-secure" UŽ dodáva 0.2 v CI čase. → ⚠ **KOREKCIA (Blocker C-improvement + Architect): ÚPLNE ZMAZANÝ, nie „voliteľné za flagom".** Odôvodnenie v ADR.

**Zvolené: A hneď (M1: 1.1–1.4) → C wrapper pre role/org (2.1), vynútený verným behaviorálnym harnessom 0.2. RLS ostáva backstop. Edge middleware VYPUSTENÝ.**

#### ⚠ Jeden zdroj pravdy o auth-fakte route (Blocker C / anti-drift)
Predošlé drafty držali viac drift-náchylných zoznamov tej istej skutočnosti. Nová architektúra:
- **Task 0.4 — jeden exportovaný register** `src/server/route-auth-registry.ts`: `route → { public | bearer | dual | session(role?) }`. JEDINÝ konfiguračný zdroj.
- **Konzumenti derivujú svoj pohľad PROGRAMATICKY z registra:** CSRF logika (1.4: aplikuj len na `session` mutačné metódy POST/PATCH/DELETE; vylúč `bearer`; pri `dual` len session sub-vetva), wrapper (2.1: číta rolu).
- **Enumeračný test 0.2 je NEZÁVISLÝ behaviorálny cross-check** — NEČÍTA register pre svoje pass/fail rozhodnutie (aby stale register nemohol vyrobiť false-pass); má vlastný 2-položkový hardcoded public allowlist + **parity assert** `registry.public === 0.2.allowlist`.

#### ⚠ Registry 0.4 — OVERENÁ klasifikácia (výňatok pre správne pochopenie 1.1/1.4/2.1)
| Trieda | Routes (OVERENÉ) | Poznámka |
|---|---|---|
| **public (2)** | `auth/forgot-password`, `public/location-links/[token]` | jediné 2 na 0.2 allowliste |
| **bearer (7 po 1.2)** | `integrations/commander/sync`, `integrations/commander/import-all` (⚠ **inline `authorize()`+`safeEquals`**, NIE `authorizeRecordingsSync`), `telephony/recordings/sync`, `telephony/transcripts/process`, CDR probe predchádzajúceho providera (`authorizeRecordingsSync`), + po 1.2: probe a SMS probe predchádzajúceho providera | anon bez tokenu → **401** (nie na allowliste) |
| **dual (2)** | `integrations/fleet/webdispecink/sync` (GET cron-bearer / POST session+CSRF), `notifications/materialize` (bearer secret / session) | CSRF LEN v session sub-vetve |
| **session (~50)** | všetko ostatné vrátane 11 novo-guardovaných v 1.1 | anon → **401/403** |

> ⚠ KOREKCIA (Blocker B): `commander/sync` + `commander/import-all` sú UŽ bearer-guarded (inline `authorize()`). Registrujeme ich ako `bearer`, aby ich 1.1/2.1 nikdy nepovažoval za nechránené.

#### Pre-mortem (3 scenáre zlyhania + mitigácie)
1. **Guard rozbije legitímneho volajúceho (dispatchera).** ⚠ OVERENÉ: `requireDefaultMotoristActor()` má default `["manager","admin"]` (`api-auth.ts:43`) → VYLUČUJE dispatchera. OVERENÍ UI calleri pod dispatcher rolou: `call/create` ← `CallCenterModule.tsx` + `DispatchConsole.tsx` + `CaseDetail.tsx`; `queues/agent` ← `DispatchConsole.tsx`; `calls/match` ← `DispatchConsole.tsx`. Role-gatovanie týchto by rozbilo call-center. **Mitigácia:** guardovať `requireDefaultMotoristOrgMember()` (member-level, NIE Actor/role). Peniaze/PBX chránime CSRF (1.4) + rate-limit, NIE role gatingom.
2. **Guard „funguje lokálne" ale nedokazuje nič.** OVERENÉ: `NODE_ENV=development` má 6 bypassov (`api-auth.ts:27,35,49,75,97,221`) → dev e2e NEVIE odlíšiť „guard OK" od „guard preskočený"; Vercel preview nemá auth. **Mitigácia:** load-bearing overenie beží v `NODE_ENV=test` (vitest, mimo bypassu) s **verným mock-harnessom** (0.2). Tento harness je predpokladom, nie samozrejmosťou — viď Blocker A fix.
3. **Migrácia na wrapper (2.1) potichu vypustí jeden guard.** **Mitigácia:** behaviorálny enumeračný test 0.2 je fail-closed gate + **canary** (dôkaz, že brána vie dieru detegovať); musí prejsť pred merge; migrovať inkrementálne po skupinách.

#### Rozšírený test plán (DELIBERATE)
- **Unit:** access-policy matica rolí (existuje); org-resolution helper (fallback keď org chýba / neaktívna / prvá aktívna); register-parity (`registry.public` == 0.2 allowlist).
- **Integration (LOAD-BEARING, deploy-safe):**
  - (a) **0.2 behaviorálny fail-closed test s verným harnessom** — viď presná špecifikácia v tasku 0.2. Globálne mockuje `@/lib/supabase/server` + `@/lib/supabase/admin` tak, aby NECHRÁNENÁ route SKUTOČNE prešla do logiky a vrátila **200 (=RED)**, guarded → **401/403**. Striktný assert `401/403`, nikdy `>=400`. Canary + parity assert.
  - (b) **1.1 pozitívne role testy** — naseedovaná session + stubnutý telephony/sms workflow: `anon → 401/403`, `dispatcher-role → povolené`, BEZ reálneho PBX hovoru/SMS.
- **CSRF regresia/boundary (1.4):** cookie POST bez `Origin` → **403** (po sprísnení `:227`); `webdispecink/sync` **GET cron (bearer, bez `Origin`) → 200** (dual-mode nesmie dostať 403); `notifications/materialize` bearer bez `Origin` → 200. Test, že žiaden `bearer`/`dual`-cron handler NIE JE CSRF-obalený.
- **PII scrub (2.4):** error event zo zlyhaného hovoru/SMS NEOBSAHUJE tel. číslo ani meno klienta.
- **Org-resolution (2.3):** charakterizačný test rozdielov medzi 8 kópiami PRED zlúčením.
- **E2e (happy path, deploy-safe/prod-like, NIE preview):** dispatcher login → vytvor prípad → prihlás do fronty → UI-toky fungujú po guardoch. Reálny hovor/SMS = samostatná finálna MANUÁLNA brána, nie automatické acceptance.
- **Observability:** zlyhaný hovor/SMS vyprodukuje zachytený (scrubbed) error event.

---

### Quick wins (S, sprav hneď — nekonfliktné s M0)
- **QW1 — CI gate na PR** — `.github/workflows/ci.yml`: `eslint` + `tsc --noEmit` + `npm test` (`vitest run && node --test tests/*.test.mjs`) + `next build`. (Skripty OVERENÉ v `package.json`; OVERENÉ, že `ci.yml` NEEXISTUJE — sú len 4 data-sync crony: `commander-import.yml`, `commander-sync.yml`, `recordings-sync.yml`, `webdispecink-sync.yml`.)
- **QW2 — README fix** magic-link → password.
- **QW3 — Zmaž mŕtvy kód** — kandidáti `src/providers/{contracts,index,mock}.ts` + `src/domain/foundation.ts`. **HARD gate:** executor NAJPRV potvrdí 0 externých importérov (grep) — až potom mazať.
- **QW4 — Dependency patch bumps** (Next, React, supabase-js) — až po zelenom CI (QW1 prvé).

### Milestone 0 — Safety net (paralelne s Quick wins)
| # | Task | Súbory | Testovateľné acceptance | Effort | Riziko | Deps |
|---|---|---|---|---|---|---|
| 0.1 | CI gate na PR | `.github/workflows/ci.yml` | PR padne, ak zlyhá `lint`/`typecheck`/`test`/`build`. Beží na `NODE_ENV=test` | S | žiadne | — |
| **0.2** | **Behaviorálny enumeračný auth test s VERNÝM mock-harnessom (RED-first, fail-closed, LOAD-BEARING)** | nový `src/app/api/route-auth.test.ts` | **Presná špecifikácia nižšie.** Acceptance = **behaviorálne pravidlo (NIE počet):** „každá route mimo 2-položkového public allowlistu vráti anonymovi (s neutralizovaným CSRF) **striktne 401 alebo 403**". Teraz RED (11 citlivých session dier vráti 200). Zahŕňa **canary** + **parity assert** s `registry.public` | **L** | Med | **0.4 (parity)** |
| 0.3 | Charakterizačné testy rizikových vstupov | test súbory pre `motorist-mutations`, `sms-workflow`, `telephony-workflow`, `dispatch-repository` | `createCase`, `sendCaseSms`, `setCallOutcome`, **`call/create` happy-path**, **`findCallerMatches`** + org-resolution fallbacky všetkých 8 kópií. ⚠ **`call/create` + `findCallerMatches` charakterizácia je HARD predpoklad PRED 1.1** (Princíp 4); zvyšok HARD pred 2.3 | **L** | žiadne | — |
| **0.4** | **Jeden route-auth register** | nový `src/server/route-auth-registry.ts` | Exportovaná mapa `route → {public\|bearer\|dual\|session(role?)}` — JEDINÝ konfig zdroj pre 1.4, 2.1. 0.2 ho NEČÍTA (len parity-asserts `public`). Test: register pokrýva všetkých 61 routes; `commander/sync`+`commander/import-all` = `bearer` (OVERENÉ inline `authorize()`) | S | Nízke | — |

#### ⚠ 0.2 — PRESNÁ ŠPECIFIKÁCIA HARNESSU (Blocker A — load-bearing brána celého plánu)

**Prečo je harness povinný (OVERENÉ v kóde):** `telephony/calls/match/route.ts` je genuinely bez auth — GET len zavolá `findCallerMatches(number)` a chytá non-`TelephonyWorkflowError` ako **status 500** (`:17`). V `NODE_ENV=test` **bez harnessu** táto (a väčšina) unguarded route NEvráti 200, ale **500** — lebo `createSupabaseAdminClient()`→`requireSupabaseServiceEnv()` (OVERENÉ `env.ts:53`) hodí `Error` na chýbajúcom service-role env, a `createSupabaseServerClient()`→`requireSupabasePublicEnv()` tiež. Dôsledok bez harnessu:
- Ak by 0.2 asertoval voľne `>=400`/`nie-2xx` → **500 z chýbajúceho env PREJDE ako „secure"**, ale v prode (env existuje) tá istá anon route vráti **200** → diera by sa nasadila označená ako zatvorená (bezpečnostný **false-pass**).
- Ak by asertoval striktne `401/403` bez harnessu → padne na **500 z iného dôvodu než auth** (šum, nie signál).

**Harness (globálne, cez `vi.mock`, hoisted na začiatku súboru):**

```ts
const SEED_ORG_ID = "00000000-0000-0000-0000-000000000001";
// chainable stub: .select().eq().in().order().limit().maybeSingle()/.single() → seed/prázdne
function makeQueryStub(result: unknown) { /* vráti thenable + chainable, maybeSingle → {data: result ?? null, error: null} */ }

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) }, // anon
    from: () => makeQueryStub(null),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) =>
      table === "motorist_organizations"
        ? makeQueryStub({ id: SEED_ORG_ID }) // resolveDefaultOrganizationId() USPEJE
        : makeQueryStub(null),               // všetko ostatné prázdne
  }),
}));
```

**Efekt harnessu:**
- **Unguarded route** (napr. `calls/match`): `findCallerMatches` beží proti seedovanej org + prázdnym dátam → vráti **200** (RED signál — diera je reálne detegovaná).
- **Guarded session route**: `getUser` → `null` → `requireDefaultMotorist*` hodí `MutationError(401/403)` → route vráti **401/403**.
- **Bearer route** (commander/recordings/probe): anon bez tokenu → `authorize()`/`authorizeRecordingsSync()` → **401** (tiež spĺňa 401/403; NIE na allowliste).

**Enumerácia a asercia:**
1. Fs-walk (alebo `import.meta.glob`) všetkých `src/app/api/**/route.ts`; dynamický import každého.
2. Pre každú exportovanú metódu z `{GET,POST,PATCH,PUT,DELETE}`: postav anon `Request` **s same-origin hlavičkami** (`origin: https://app.local`, `x-forwarded-host: app.local`, `x-forwarded-proto: https`) — tým **neutralizuješ CSRF** (`assertSameOriginRequest` prejde), takže o výsledku rozhoduje **AUTH vrstva**, nie CSRF (dôležité: po 1.4 by inak no-Origin request skončil na 403 z CSRF a 0.2 by prestal testovať auth). Zavolaj `handler(request, { params: Promise.resolve(stubParams) })`.
3. **Assert STRIKTNE `status === 401 || status === 403`**, NIKDY `>=400` ani „nie-2xx", pokiaľ route NIE JE na `PUBLIC_ALLOWLIST` (hardcoded 2 položky: `auth/forgot-password`, `public/location-links/[token]`).
4. **CANARY (test testu proti false-pass):** definuj in-test fixture handler `async () => Response.json({ ok: true })` (vráti 200) a prežeň ho tou istou asertačnou funkciou; **assert, že asertácia ZLYHÁ/vyhodí** — dôkaz, že brána vie unguarded dieru (200) detegovať. (Fixture je iba v teste, nešipuje sa ako reálna route.)
5. **PARITY assert:** `PUBLIC_ALLOWLIST` (hardcoded 2) === `registry.public` (0.4). 0.2 nečíta register pre pass/fail, len pre parity.

**Vzor per-route mockovania (OVERENÝ):** `src/app/api/auth/forgot-password/route.test.ts` (mockuje `@/server/access-management` per-route). 0.2 robí to isté, ale **globálne pre supabase vrstvu** naprieč všetkými 61 routes.

### Milestone 1 — Kritická bezpečnosť (hotfix, PORADIE ZÁLEŽÍ)
> Neformálny odhad rozsahu (NIE acceptance): z 61 routes je ~13 bez auth-referencie a citlivých — ~11 na session guard (1.1), ~2 probe na bearer (1.2). **Acceptance je vždy behaviorálne pravidlo z 0.2** („anon → 401/403 mimo 2-položkového allowlistu"), nie tieto čísla.

| # | Task | Súbory | Testovateľné acceptance | Effort | Riziko | Deps |
|---|---|---|---|---|---|---|
| **1.3** | **Dev-bypass = env flag, nie `NODE_ENV`** (dev-ergonómia, NIE critical-path security) | `src/server/api-auth.ts` | Nahradiť 6 `NODE_ENV==="development"` short-circuitov (OVERENÉ riadky **27, 35, 49, 75, 97, 221**) za `MOTORIST_DEV_AUTH_BYPASS==="true"`. Acceptance: `grep 'NODE_ENV.*development' api-auth.ts` = 0. V prode nikdy nefíruje; vitest (`NODE_ENV=test`) už dnes beží mimo bypassu → **1.1 NEZÁVISÍ tvrdo na 1.3** | S | Nízke | — |
| 1.1 | Guard 11 citlivých session routes | viď rozpis nižšie | `requireDefaultMotoristOrgMember()` / (len `extensions`) `requireDefaultMotoristActor(["manager","admin"])`. **LOAD-BEARING dôkaz = mocked integračný test** (naseedovaná session + stubnutý workflow → `anon → 401/403`, `dispatcher-role → povolené`). **Reálny `call/create`/`send SMS` = samostatná finálna MANUÁLNA brána, NIE primárne acceptance** | **M** | Med | ⚠ **HARD: hotový 0.2 harness** + ⚠ **HARD: 0.3 charakterizácia `call/create`+`findCallerMatches`**; soft: 1.3 skôr |
| 1.2 | Guard probe routes (bearer) | probe a SMS probe routes predchádzajúceho providera | Bearer secret (vzor `authorizeRecordingsSync` + `timingSafeEqual`); bez tokenu → 401. Zaregistrovať v 0.4 ako `bearer` | S | Nízke | 0.4 |
| 1.4 | CSRF na cookie-authed mutácie (PROGRAMATICKY z registra) | `assertSameOriginRequest` (`api-auth.ts:220`) + `session`-mutačné routes z registra (0.4) | Rozšíriť CSRF z 7 OVERENÝCH use-sites na **VŠETKY `session` POST/PATCH/DELETE derivované z registra**. Sprísniť `if(!origin)return` (`:227`) na **403**. Presný audit + gates nižšie | **M** | Med | 0.4, 1.1 (soft: 1.3 skôr) |

**⚠ Rozpis 1.1 (11 routes, OVERENÉ metódy/calleri/role):**
- **`requireDefaultMotoristOrgMember()` — 10 routes:**
  - GET: `telephony/queues`, `telephony/calls/active`, `telephony/calls/match` (PII; OVERENÝ caller `DispatchConsole.tsx`), `integrations/swhouse/replacement-vehicles` (OVERENÍ calleri `useReplacementVehicleAvailability.ts`, `FleetModule.tsx`, `IntegrationSettings.tsx`)
  - POST: `cases/[id]/sms`, `telephony/call/create` (⚠ OVERENÍ UI calleri `CallCenterModule.tsx`/`DispatchConsole.tsx`/`CaseDetail.tsx` — peniaze cez CSRF+rate-limit, NIE rolou), `telephony/calls/[id]/link-case`, `telephony/calls/[id]/outcome`, `telephony/queues/agent` (⚠ OVERENÝ UI caller `DispatchConsole.tsx`), `integrations/commander/vehicles/[id]` (OVERENÝ caller `FleetModule.tsx`)
- **`requireDefaultMotoristActor(["manager","admin"])` — 1 route:** `telephony/extensions` (⚠ OVERENÉ **0 in-repo callerov**). Improvement: pri exekúcii ZNOVA over; ak server-only konzument → preferuj bearer (vzor `authorizeRecordingsSync`).

**⚠ Rozpis 1.4 — CSRF audit (Blocker C, OVERENÉ):**

Reálny rozsah CSRF diery: derivácia `session ∩ {POST,PATCH,DELETE}` z registra dáva **~35 session-mutačných routes**, ale dnes je CSRF len na **7 use-sites** (`auth/password-completed`, `webdispecink/sync` POST-vetva, `webdispecink/vehicles/[id]`, `users`, `users/[id]`, `users/[id]/access/reset-password`, `users/[id]/access/send`) → **~28 session-mutačných routes je dnes CSRF-NECHRÁNENÝCH**. Preto CSRF množina MUSÍ byť odvodená programaticky, nie z hardcoded zoznamu.

- **(a) Programatická derivácia (HARD):** CSRF sa aplikuje na každý handler, kde `registry[route] === "session"` a metóda ∈ `{POST,PATCH,DELETE}`. Žiaden hardcoded zoznam.
- **(b) Explicitný audit chýbajúcich session-mutačných routes — OVERENÉ ako session-mutačné a dnes bez CSRF** (potvrdené čítaním kódu, boli by nechránené):
  - `notifications/[id]/read` (PATCH, `requireDefaultMotoristOrgMember`) — ✅ potvrdené session-mutačné
  - `notifications/[id]` (PATCH, `requireDefaultMotoristOrgMember`) — ✅ potvrdené
  - `webphone/session` (POST, `requireDefaultMotoristOrgMember`, vytvára webphone session) — ✅ potvrdené session-mutačné
  - Attendance mutačné (všetky POST/PATCH, `requireDefaultMotoristOrgRole`/`OrgMember`): `attendance/copy`, `attendance/planning/bulk-shifts`, `attendance/requests` (POST), `attendance/requests/[id]` (PATCH), `attendance/requests/[id]/approve`, `attendance/requests/[id]/decline`, `attendance/requests/[id]/cancel`, `attendance/schedule-batches/[id]/publish`, `attendance/sessions/start`, `attendance/sessions/[id]/end`, `attendance/shifts` (POST), `attendance/shifts/[id]` (PATCH), `attendance/shifts/[id]/confirm`, `attendance/shifts/[id]/decline`, `attendance/shifts/[id]/publish` — ✅ všetky potvrdené session-mutačné
  - Ďalšie potvrdené session-mutačné bez CSRF: `branches` (POST), `cases` (POST), `cases/[id]` (PATCH), `cases/[id]/assign` (PATCH), `cases/[id]/actions` (POST), `cases/[id]/attachments` (POST), `fleet-assets` (POST), `fleet-assets/[id]` (PATCH), `maps/route` (POST), `partner-directory` (POST), `partner-directory/[id]` (PATCH+DELETE) + 6 novo-guardovaných z 1.1 (`cases/[id]/sms`, `commander/vehicles/[id]`, `call/create`, `calls/[id]/link-case`, `calls/[id]/outcome`, `queues/agent`)
  - ⚠ **VYLÚČENÉ z CSRF (OVERENÉ, NIE session-mutácia):** `webphone/config` je **GET-only** (podmienený guard len pri zapnutom flagu na vystavenie SIP credentials predchádzajúceho providera do prehliadača), teda read-only → **nie CSRF kandidát**. (Koriguje Criticov zoznam kandidátov.)
- **(c) `dual`/`bearer` handler NIE JE CSRF-obalený — test (HARD):**
  - OVERENÉ `dual`: `webdispecink/sync` — `assertSameOriginRequest` sa volá LEN v `authorizeWebdispecinkSync` (session vetva POST), cron GET (`authorizeWebdispecinkCron`) ju NEVOLÁ → cron bez `Origin` ostáva 200.
  - OVERENÉ `dual`: `notifications/materialize` — `authorizeMaterializer` má bearer vetvu (`Bearer ${secret}`) ALEBO fallback `requireDefaultMotoristOrgMember()`. ⚠ CSRF sa pridá **len do session fallback vetvy** (za bearer-checkom), aby cron bearer bez `Origin` neskončil na 403.
  - OVERENÉ `bearer`: `commander/sync`, `commander/import-all` (inline `authorize()`), `recordings/sync`, `transcripts/process`, CDR probe predchádzajúceho providera (`authorizeRecordingsSync`) — žiadny CSRF.
  - Test: pre každý `bearer`/`dual`-cron handler assert, že request bez `Origin` s platným bearer tokenom → NIE 403.
- **(d) Grep interných server-side cookie-POST fetchov = HARD gate (nie poznámka):** pred flipnutím `:227` (`!origin → 403`) executor MUSÍ grepnúť RSC/server-actions/interné server-side `fetch` na vlastné `/api/**` s cookie ale bez `Origin` hlavičky; ktorýkoľvek taký fetch by po flipe dostal 403. Buď doplniť `Origin`/same-origin hlavičku volajúcemu, alebo route ponechať mimo CSRF. Toto je **blokujúca podmienka** merge 1.4, nie odporúčanie.
- **Boundary testy (HARD pred flipom):** cookie-POST bez `Origin` → 403; `webdispecink/sync` GET cron bez `Origin` → 200; `notifications/materialize` bearer bez `Origin` → 200.

### Milestone 2 — Centrálne vynútenie + hardening
| # | Task | Súbory / rozsah | Testovateľné acceptance | Effort | Riziko | Deps |
|---|---|---|---|---|---|---|
| 2.1 | `withMotoristAuth()` wrapper + migrácia | nový helper v `api-auth.ts` + `route.ts`×~50, číta rolu z registra (0.4) | Behaviorálny 0.2 flipne na „vyžaduj guard"; nová route guarded-by-default. Migrácia pokryje aj 3 routes na `requireMotoristOrgMember` (`partner-directory`, `partner-directory/[id]`, `cases/[id]/attachments`) a `dual` routes (zachovať bearer-OR-session vetvu) | L | Med | 1.1, 0.2, 0.4 |
| 2.2 | zod schémy na hranici routes | pridať `zod` dep + schémy | Zlý body → 400; nahradiť `(await request.json()) as Type` casty (~20 routes). ⚠ OVERENÉ: `zod` NIE JE v `package.json` → pridať runtime dep AŽ po zelenom CI (mimo hotfix fázy, aby sa nerozširoval supply-chain povrch počas security opravy) | L | Nízke | QW1 |
| 2.3 | Jeden org-resolution helper | viď 8 kópií nižšie | ⚠ 8 kópií → 1 zdroj pravdy. **Charakterizačný test (0.3) HARD najprv** zachytí rozdielne fallbacky, potom zlúčiť. Vedomé rozhodnutie o cron/bearer doméne (kópie 7,8) | M | Med | **0.3 (HARD)** |
| 2.4 | Observability pre calls/SMS | telephony/sms workflow + logger | Zlyhania zachytené (Sentry/scrubbed log) + PII-scrub test (žiadne tel. číslo/meno v evente) | M | Nízke | — |

> ⚠ **2.5 (edge middleware) ODSTRÁNENÝ** — pôvodne „voliteľný za flagom", teraz ZMAZANÝ. Odôvodnenie v ADR (Princíp 5, žiadna bezpečná cesta k zapnutiu bez preview auth, 0.2 kryje tú istú hrozbu v CI čase).

**⚠ 8 org-resolution kópií (OVERENÉ definície + fallback riadky):**
1. `src/server/api-auth.ts:113` `resolveDefaultOrganizationId()` — slug + `active=true`, throw (KANONICKÝ; reused `access-management`, `webdispecink-sync`, `notifications/materialize`)
2. `src/app/api/telephony/call/create/route.ts:175` (def) — first-active fallback `:186` (`.eq("active",true)`), iná signatúra `(supabase)` ⚠ risk
3. `src/data/dispatch-repository.ts:458` (def) — first-active fallback `:475`, vracia nullable ⚠ risk
4. `src/server/telephony-workflow.ts:348` — throw
5. `src/server/motorist-mutations.ts:1922` — throw
6. `src/server/sms-workflow.ts:278` — throw
7. `src/server/integrations/commander/sync.ts:791` — bearer/cron doména
8. `src/server/telephony/recordings-sync.ts:385` — bearer/cron doména (exportovaný; reused `transcripts-process` a CDR probe predchádzajúceho providera)

> 2 kópie (call/create `:186`, dispatch-repository `:475`) ticho vyberú „prvú aktívnu org", zvyšok hodí chybu. Zlúčenie musí vedome rozhodnúť o cron/bearer doméne (7, 8).

### Milestone 3 — Kvalita & výkon (opportunisticky, po M1/M2)
| # | Task | Effort | Riziko |
|---|---|---|---|
| 3.1 | Nahradiť 60s full-blob poll + full re-read → delta/Realtime | L | Med |
| 3.2 | Rozdeliť god-files (`motorist-mutations.ts` 3682 r. po doménach; veľké UI) — LEN po 0.3 | XL | High |
| 3.3 | Audit query bounds (unbounded scans) | M | Nízke |

### Poradie / logika (čo prvé a prečo)
1. **Quick wins + M0 (0.1–0.4) paralelne.** 0.4 (register) je predpoklad pre 1.4/2.1 aj pre parity-assert 0.2. **0.2 harness sa musí postaviť skoro — je HARD predpoklad dôkazu ktorejkoľvek 1.1 route** (preto effort L, nie S). 0.2 je RED a dokumentuje citlivé diery behaviorálne.
2. **1.3 (env flag) prvé v M1 kvôli DEV-ERGONÓMII** — NIE critical-path (v prode nikdy nefíruje). **1.1 tvrdo závisí od hotového 0.2 harnessu a 0.3 charakterizácie `call/create`+`findCallerMatches`, NIE od 1.3.**
3. **0.3 charakterizácia `call/create`+`findCallerMatches` PRED 1.1** (Princíp 4: safety-net pred vložením throwing-auth do workflow s 0 testami).
4. **1.1 (session guardy) → 1.4 (CSRF)** — 1.4 derivuje CSRF množinu z registra + robí HARD audit (a–d) + boundary testy pred flipom `:227`.
5. **1.2 (bearer probe)** nezávislé, kedykoľvek po 0.4.
6. Keď 1.1–1.4 zavrú diery → 0.2 zozelenie.
7. **M2** stavia na M1 + 0.3 (2.3 HARD na 0.3). **Žiadny edge middleware.**
8. **M3** opportunisticky; god-file split (3.2) LEN po 0.3.

### Explicitne NEROBIŤ teraz
- Neprepisovať admin-client/RLS na RLS-primary (veľký risk, single-tenant). RLS ostáva backstop.
- Nerobiť middleware ako PRIMÁRNE role/org gating (krkolomné role mapovanie na nodejs).
- ⚠ **Nezavádzať edge middleware vôbec** (ani „voliteľné za flagom") — `src/middleware.ts` OVERENE neexistuje, je to nový globálny mechanizmus s fatálnym blast-radius bez preview siete; 0.2 kryje „nová route default-secure" bezpečnejšie v CI čase.
- ⚠ Nepísať 0.2 s voľnou aserciou `>=400`/`nie-2xx` — MUSÍ byť striktné `401/403` + verný harness, inak 500 z chýbajúceho env vyrobí false-pass.
- ⚠ Nederivovať CSRF/auth množiny z hardcoded zoznamov — všetko programaticky z registra (0.4); 0.2 je nezávislý behaviorálny cross-check s parity assertom.
- ⚠ Nerole-gatovať `call/create` ani `queues/agent` ani `calls/match` na manager/admin — rozbilo by to dispatcherov (OVERENÉ default rolí `:43` + OVERENÍ UI calleri).
- ⚠ Nezabaliť CSRF okolo `bearer`/`dual`-cron vetiev (OVERENÉ dual: `webdispecink/sync` cron GET, `notifications/materialize` bearer) — crony by dostali 403.
- ⚠ Neflipnúť `:227` na 403 pred HARD grepom interných server-side cookie-POST fetchov bez `Origin`.
- Nespúšťať reálny PBX hovor / SMS ako automatické acceptance — load-bearing overenie je mocked vitest; reálny hovor je len finálna manuálna brána.
- Pridať `zod` runtime dep počas hotfix fázy — až po zelenom CI (2.2).
- Nerozbíjať veľké UI komponenty / god-files pred 0.3.
- Nestavať distribuovaný rate-limiter (in-memory speed bump stačí).
- Nahrávanie hovorov / transkript / AI QA — UŽ EXISTUJE (guarded), MIMO scope.

### ADR
- **Decision:** Per-route hotfix guardy (1.1–1.4) + **behaviorálny fail-closed enumeračný test s verným Supabase mock-harnessom (0.2)** ako primárna default-secure sieť → centrálny `withMotoristAuth()` wrapper (2.1), riadený jedným route registrom (0.4). RLS ostáva defense-in-depth backstop. **Edge middleware ZMAZANÝ (žiadne 2.5).**
- **Drivers:** kritická expozícia teraz (~11 nechránených citlivých session routes + ~28 CSRF-nechránených session-mutácií); nulové testy na najrizikovejšom kóde (`motorist-mutations.ts` 3682 r.); deploy-to-prod + Vercel preview bez auth (load-bearing overenie = mocked vitest v `NODE_ENV=test`, mimo 6 dev-bypassov).
- **Alternatives considered:**
  - Middleware ako PRIMÁRNE role gating — zamietnuté (role mapovanie na nodejs edge, `motorist_profiles` lookup na edge neprirodzený).
  - RLS-primary rewrite — zamietnuté (risk/scope, single-tenant).
  - **Edge middleware ako druhý riadok (voliteľné za flagom, pôvodné 2.5)** — ⚠ **ZAMIETNUTÉ a ZMAZANÉ:** (1) `src/middleware.ts` neexistuje → nový globálny mechanizmus proti Princípom 1/3; (2) pri deploy-to-prod + preview bez auth NEEXISTUJE bezpečná cesta ho zapnúť — allowlist-parita je dokázateľná iba v prode, kde zlý allowlist = 401 celej appky (fatálny blast-radius); (3) bol by **štvrtou** reprezentáciou jednej auth-pravdy na single-tenant appke = presne „belt-and-suspenders-and-parachute", pred ktorým varuje Princíp 5; (4) hodnotu „nová route default-secure" UŽ dodáva 0.2 v CI čase s nulovým prod rizikom. Ponechať ho „na neskôr za flagom" = scope-rot bez pridanej istoty.
  - Voľná asercia 0.2 (`>=400`) — zamietnuté (false-pass: 500 z chýbajúceho env prejde ako „secure", v prode 200).
- **Why chosen:** najkratšia cesta k zavretiu diery + trvalá prevencia (verný harness 0.2 + wrapper 2.1) bez prestavby architektúry a bez runtime chokepointu s fatálnym failure mode; jeden register (0.4) + programatická derivácia eliminujú drift; member-level guard na operátorské routes zachová call-center workflow; harness robí load-bearing bránu skutočne testovateľnou (Blocker A), čím sa mitigácia pre-mortem scenára 2 stáva reálnou, nie deklaratívnou.
- **Consequences:** krátkodobo viac boilerplate na routes; strednodobo test-vynútená bezpečnosť (CI-time, 0 prod risk). **0.2 nie je effort S — je L** (globálny verný mock-harness + canary + enumerácia 61 routes s neutralizáciou CSRF), a je HARD predpokladom dôkazu 1.1. 0.3 charakterizácia `call/create`+`findCallerMatches` je HARD PRED 1.1. Load-bearing overenie MUSÍ bežať mimo dev-bypassu (`NODE_ENV=test`/mocked), nie na preview, nie dev e2e, nie reálny hovor. CSRF sa derivuje programaticky (dnes ~28 session-mutácií nechránených); dual-cron vetvy sú z CSRF vylúčené.
- **Follow-ups:** M3 výkon (poll→delta), god-file dekompozícia po 0.3, vedomé zlúčenie cron/bearer org-resolution domény (kópie 7,8), re-verifikácia `telephony/extensions` (0 in-repo callerov → zvážiť bearer namiesto Actor pri exekúcii).

---

### Ako sme uzavreli Critic blockery (A–D)

**A — 0.2 harness presne špecifikovaný (bola najkritickejšia diera).** Do tasku 0.2 pridaná úplná špecifikácia harnessu: globálny `vi.mock` pre `@/lib/supabase/server` (`auth.getUser → {data:{user:null}}`) AJ `@/lib/supabase/admin` (`createSupabaseAdminClient` vráti seedovanú org id pre `motorist_organizations` + prázdne result-sety inde), aby nechránená route (OVERENÉ `calls/match` → `findCallerMatches`) SKUTOČNE prešla do logiky a vrátila **200 (RED)**, guarded → **401/403**. Asercia sprísnená na **striktne `401/403`, nikdy `>=400`** (odôvodnené: bez harnessu `createSupabaseAdminClient`→`requireSupabaseServiceEnv` hodí Error → 500, čo by pri voľnej asercii prešlo ako „secure", kým v prode je 200 = false-pass). Pridaný **canary** (in-test fixture vracajúci 200 musí spôsobiť pád asertácie) a **parity assert** s `registry.public`. Odkázaný OVERENÝ vzor `forgot-password/route.test.ts` (per-route mock; 0.2 to robí globálne). Harness rieši neutralizáciu CSRF same-origin hlavičkami, aby 0.2 testoval AUTH aj po 1.4. Effort 0.2 prehodnotený na **L**.

**B — fixné počty zahodené, nahradené behaviorálnym zdrojom pravdy.** Z acceptance odstránené všetky drift-náchylné čísla („16 unguarded", „11 sensitive", „7 CSRF sites"); acceptance je teraz **„každá route mimo 2-položkového public allowlistu vráti anonymovi 401/403"**. Čísla ostali len ako neformálny odhad rozsahu. OVERENÉ a správne zaregistrované: `integrations/commander/sync` a `integrations/commander/import-all` sú **bearer** cez INLINE `authorize()` + `safeEquals` (`COMMANDER_SYNC_SECRET` + `timingSafeEqual`), NIE `authorizeRecordingsSync` — zapísané do registra 0.4 ako `bearer`, aby ich 1.1/2.1 nepovažoval za nechránené.

**C — CSRF audit doplnený, programatická derivácia, dual/bearer vylúčenie, HARD grep.** CSRF množina sa derivuje **programaticky z registra** (`session ∩ {POST,PATCH,DELETE}`). Doplnený explicitný audit — OVERENÉ ako session-mutačné a dnes bez CSRF: `notifications/[id]/read`, `notifications/[id]`, `webphone/session`, všetky attendance mutácie (copy, bulk-shifts, requests±[id]/approve/decline/cancel, schedule-batches/publish, sessions/start±end, shifts±[id]/confirm/decline/publish) + branches/cases/fleet-assets/maps/partner-directory mutácie. ⚠ `webphone/config` je **GET-only → NIE session-mutácia** (vylúčené z CSRF, koriguje kandidátny zoznam). Zistený reálny rozsah: ~35 session-mutačných vs. 7 pokrytých → ~28 nechránených (validuje blocker). Pridaný test, že žiaden `dual`/`bearer` handler nie je CSRF-obalený (OVERENÉ dual: `webdispecink/sync` cron GET, `notifications/materialize` bearer vetva). Grep interných server-side cookie-POST fetchov bez `Origin` povýšený na **HARD gate** merge 1.4.

**D — effort + deps pre 1.1 prehodnotené.** Hotový **0.2 harness** (nie 1.3) je teraz **HARD predpoklad** dôkazu každej 1.1 route; effort 0.2 povýšený na **L** (globálny harness + canary + enumerácia). Effort 1.1 = **M** (dôkaz závisí od harnessu + mocked pozitívnych testov). Charakterizácia happy-path **`call/create` + `findCallerMatches` (0.3)** povýšená zo „soft" na **HARD predpoklad PRED 1.1** (Princíp 4: safety-net pred vložením throwing-auth do `motorist-mutations.ts` 3682 r. s 0 testami).

---

### Non-blocking doplnky z finálnej Critic pass (verdikt APPROVE)
> Plán je schválený. Toto sú 3 implementačné poznámky (OVERENÉ proti kódu), ktoré NIE SÚ blokujúce — všetky by ich zachytila samotná fail-closed brána 0.2 v CI čase, takže nemôžu vzniknúť ako tichý security false-pass. Sú to pokyny pre executora, aby 1.1 „zozelenilo" na prvý pokus.

1. **Pri guardovaní `calls/match`, `queues`, `calls/active` ZÁROVEŇ oprav catch-blok.** OVERENÉ: `telephony/calls/match/route.ts:17` chytá len `TelephonyWorkflowError` (inak 500); `telephony/queues/route.ts:14` + `telephony/calls/active` používajú error serializer predchádzajúceho providera. Ak sa `await requireDefaultMotoristOrgMember()` vloží DOVNÚTRA existujúceho `try`, vyhodený `MutationError(401)` sa v týchto 3 routes skonvertuje na **500**, nie 401/403 → 0.2 by na nich ostal RED. Fix: guard buď PRED `try`, alebo v catch-bloku mapovať `MutationError.status` (vzor `mutationErrorResponse` z `cases/route.ts:21`).
2. **`telephony/webphone/config` má PODMIENENÝ guard** (GET-only; `requireDefaultMotoristOrgMember()` len keď je zapnutý flag na vystavenie SIP credentials predchádzajúceho providera). V `NODE_ENV=test` s flagom OFF → anon GET vráti 200 → 0.2 by na nej ostal RED, hoci nie je v zozname 11 (1.1). Rozhodni pri exekúcii: buď guardovať bezpodmienečne, alebo pridať `webphone/config` na 0.2 allowlist s dokumentovaným dôvodom (non-secret vetva pri flagu OFF). Nízka citlivosť (bez tajomstiev pri OFF), ale treba to explicitne uzavrieť, aby platilo „1.1–1.4 → 0.2 zozelenie".
3. **`telephony/extensions` (0 in-repo callerov)** — pri exekúcii ZNOVA over; ak je konzument len server-side, preferuj bearer (vzor `authorizeRecordingsSync`) namiesto `Actor`-role guardu.
