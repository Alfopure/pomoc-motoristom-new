# Plán: oddeliť testovacie prostredie od produkcie

Stav: **pripravený na spustenie**. Písané tak, aby to odbehol agent v novom workspace bez znalosti predchádzajúcej konverzácie. Čítaj celé, než spustíš prvý príkaz.

**Cieľ:** vetva `dev` a všetky Preview nasadenia prestanú písať do produkčnej databázy a dostanú vlastnú, bezplatnú.

---

## 0. Čo musíš vedieť skôr, než sa čohokoľvek dotkneš

Tri fakty, ktoré rozhodujú o tom, či to dopadne dobre.

**Dnes je to nerozdelené.** `SUPABASE_PROJECT_REF` má na Verceli rovnakú hodnotu pre cieľ Production aj Preview. Čiže produkcia, vetva `dev` aj každý pull request píšu do jednej databázy. Toto ideš zmeniť.

**Existuje tretí, cudzí projekt, ktorého sa nesmieš dotknúť.** Supabase `sjcsrygkkmersoczpunh` („Pomoc motoristom old + odovzdavanie vozidiel (PL)"). Okrem odstaveného dispečingu v ňom býva **živá aplikácia na odovzdávanie vozidiel** — 1 385 odovzdaní, 10 320 fotiek, denne sa do nej píše. Nie je to stará kópia. Nemaž ju, nemeň ju, nečítaj z nej.

**Produkcia sa počas celého plánu nemení.** Menia sa výhradne premenné cieľa **Preview**. Ak sa niečo pokazí, produkcia o tom nevie.

---

## 1. Čo potrebuješ pred spustením

| Čo | Odkiaľ | Overenie |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | osobný token z `supabase.com/dashboard/account/tokens` | `curl -s https://api.supabase.com/v1/organizations -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"` vráti zoznam |
| Prihlásený Vercel CLI | `vercel login` | `vercel whoami` vypíše účet |
| Repozitár | `Alfopure/pomoc-motoristom-new`, vetva `dev` | — |

Ak ktorékoľvek overenie zlyhá, **skonči a povedz to**. Polovičné prostredie je horšie než žiadne.

---

## 2. Súčasný stav, ktorý plán predpokladá

| | Identifikátor |
|---|---|
| Supabase produkcia | `ifpaeegaesdmljfkdvcn` — „Pomoc motoristom dispatching" |
| Supabase organizácia (platená, Pro) | `reqzkjhaquxbbhhalcmm` — AlfoPure |
| Supabase organizácia (bezplatná) | `rwhghkvusmdnaexjvrum` — AlfoSystems |
| Vercel projekt | `pomoc-motoristom-dispatching`, `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, tím `team_56GjBnBw6zGSG83LJAnQCB8T` |
| Produkčná doména | `dispecing.linkapomoci.sk` |

Produkcia má **129 MB**, 112 tabuliek, 17 prípadov, 15 kontaktov, 263 hovorov a 45 súborov v úložisku. Bezplatný plán dáva 500 MB, takže sa to zmestí aj s dátami.

**Overenie na začiatku:** ak sa niektorý z týchto identifikátorov nezhoduje so skutočnosťou, niekto medzitým niečo premenoval. Zisti čo, než budeš pokračovať.

---

## 3. Rozhodnutia, ktoré sú už spravené

Aby si ich nerobil znova.

**Testovacia databáza ide do bezplatnej organizácie `AlfoSystems`, nie vedľa produkcie.** Na Pro pláne by každý ďalší projekt stál compute navyše. Bezplatná organizácia má miesto — je v nej jeden pozastavený projekt a limit sú dva.

**Cena za to je jedna nepríjemnosť:** bezplatný projekt sa po **7 dňoch nečinnosti pozastaví** a musí sa ručne obnoviť kliknutím v dashboarde. Nezobudí sa sám. Toto napíš do runbooku, nech to niekoho neprekvapí.

**Schéma sa vyrobí migráciami, nie dumpom.** V repozitári je 83 migračných súborov a tie sú zdrojom pravdy. Dump by zaniesol aj to, čo do schémy nepatrí, a nedal by sa zopakovať.

**Dáta sa kopírujú cez Management API, nie cez `pg_dump`.** Heslo k produkčnej databáze nikto nemá a **nesmieš ho resetovať** — reset hesla produkcie kvôli testovaciemu prostrediu je presne ten druh rizika, ktorý sa neoplatí. Objem je malý, takže sa to prenesie dopytmi.

---

## 4. Postup

### Krok 1 — Založiť projekt

```
POST https://api.supabase.com/v1/projects
{
  "name": "Pomoc motoristom dispatching TEST",
  "organization_id": "rwhghkvusmdnaexjvrum",
  "region": "eu-central-1",
  "db_pass": "<vygeneruj 32 náhodných znakov a ulož si ho>"
}
```

Rovnaký región ako produkcia. Heslo si **ulož** — bez neho sa k databáze priamo nedostaneš.

Počkaj, kým `GET /v1/projects/{ref}` vráti `status: "ACTIVE_HEALTHY"`. Trvá to typicky dve minúty.

**Brána:** ak sa projekt nezaloží do piatich minút, skonči. Nezakladaj druhý.

### Krok 2 — Pustiť migrácie

V poradí podľa názvu súboru, každú ako jeden dopyt:

```
POST https://api.supabase.com/v1/projects/{NOVY_REF}/database/query
{"query": "<obsah migračného súboru>"}
```

Po každej zapíš do histórie:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('<verzia>', '<nazov>') on conflict (version) do nothing;
```

**Brána:** pri prvej chybe sa zastav a vypíš, ktorá migrácia a prečo. Nepokračuj ďalšou — schéma by bola nekonzistentná a to sa ťažko dohľadáva.

**Pozor na známu pascu:** niektoré migrácie zdieľali verziu s inou a `supabase db push` by jednu z každej dvojice ticho preskočil. Preto sa púšťajú **podľa súborov, nie cez `db push`**. Na konci over, že počet riadkov v histórii sa rovná počtu súborov.

### Krok 3 — Overiť schému

```sql
select count(*) from information_schema.tables where table_schema = 'public';
```

Musí sedieť s produkciou (**112**). Ak nie, chýba migrácia — nájdi ktorá, než pôjdeš ďalej.

### Krok 4 — Nakopírovať dáta

Tabuľky v tomto poradí, aby cudzie kľúče sedeli:

```
motorist_organizations
motorist_profiles
motorist_telephony_lines
motorist_contacts
motorist_vehicles
motorist_locations
motorist_cases
motorist_call_sessions
motorist_call_legs
motorist_ring_groups
motorist_ring_group_members
motorist_ring_plans
motorist_ring_plan_steps
motorist_business_hours
motorist_ivr_menus
motorist_ivr_options
motorist_telephony_settings
motorist_operator_telephony_settings
motorist_operator_presence
```

Pre každú: prečítaj z produkcie `select * from <tabulka>`, zapíš do novej cez `insert ... on conflict do nothing`. Hodnoty escapuj ako JSON, nie reťazcovým skladaním.

**Čo nekopíruj:** `motorist_job_runs`, `motorist_telnyx_webhook_events`, `motorist_call_events`, `motorist_audit_log`, `motorist_ai_demo_attempts`, `motorist_provider_commands`. Sú to logy a história. Zaberajú väčšinu miesta a na testovanie netreba ani jeden riadok.

**Úložisko nekopíruj vôbec.** 44 nahrávok hovorov a jedna hláška — na testovanie nepotrebné a je to zvuk reálnych ľudí.

**Brána:** po kopírovaní over `select count(*) from motorist_cases` — musí byť 17. Ak je 0, kopírovanie zlyhalo ticho.

### Krok 5 — Vypnúť všetko, čo volá von

Toto je najdôležitejší krok celého plánu. Testovacia databáza nesmie vedieť telefonovať.

```sql
update public.motorist_telephony_settings set live_calls_enabled = false;
```

Over dopytom, že hodnota je naozaj `false`. **Pri nezhode skonči** — testovacie prostredie, ktoré vie zdvihnúť reálny telefón, je horšie než žiadne.

### Krok 6 — Prepnúť premenné pre Preview

Iba cieľ **Preview**. Produkcie sa nedotýkaj.

| Premenná | Hodnota |
|---|---|
| `SUPABASE_URL` | `https://<NOVY_REF>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_URL` | to isté |
| `SUPABASE_PROJECT_REF` | `<NOVY_REF>` |
| `EXPECTED_SUPABASE_PROJECT_REF` | `<NOVY_REF>` |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | z `GET /v1/projects/{ref}/api-keys` |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` | tamtiež |
| `TELNYX_LIVE_CALLS_ENABLED` | `false` |
| `AI_DEMO_ENABLED` | nenastavovať |

**`EXPECTED_SUPABASE_PROJECT_REF` sa nesmie zabudnúť.** `scripts/assert-target-project.mjs` porovnáva tieto dve hodnoty a pri nezhode **zhodí build**. Ak ho nastavíš len na jednom mieste, Preview prestane stavať a bude to vyzerať ako nesúvisiaca chyba.

Kľúče existujúce na Preview **prepíš**, nie pridaj — dve hodnoty tej istej premennej na tom istom cieli sa nedajú.

### Krok 7 — Overiť, že to funguje

1. Otvor pull request s drobnou zmenou v dokumentácii.
2. Počkaj na Preview build. **Musí prejsť.** Ak spadne na `assert-target-project`, vráť sa ku kroku 6.
3. Na Preview URL over `/api/health/ready` = `200`.
4. **Skúška oddelenia:** zmeň niečo cez Preview (napríklad meno kontaktu) a over dopytom, že sa to **nezapísalo do produkcie**. Toto je jediný dôkaz, že celý plán vyšiel.
5. Over, že produkcia beží: `https://dispecing.linkapomoci.sk/api/health/ready` = `200`.

### Krok 8 — Zapísať to

Do `AGENTS.md` nahraď bod 8 dvoma vetami: Preview a `dev` píšu do testovacej databázy `<NOVY_REF>`; produkcia do `ifpaeegaesdmljfkdvcn`. Doplň aj tú vec so 7-dňovým pozastavením.

Do `docs/operations/` runbook: ako testovaciu databázu obnoviť po pozastavení a ako do nej doliať dáta znova.

---

## 5. Keď sa to pokazí

Návrat je lacný, lebo produkcia sa nemenila.

| Kde to spadne | Čo spraviť |
|---|---|
| Krok 1–4 | Zmaž nový projekt. Nič iné sa nestalo. |
| Krok 6 a Preview nestavia | Vráť premenným Preview pôvodné hodnoty (produkčný ref). Preview bude znova písať do produkcie, čo je dnešný stav. |
| Krok 7 a oddelenie nefunguje | To isté. Radšej dnešný stav než prostredie, o ktorom si myslíš, že je oddelené, a nie je. |

**Čo nikdy:** nezasahuj do premenných cieľa Production. Nezakladaj druhý projekt „pre istotu". Nepúšťaj `supabase db push` proti produkcii.

---

## 6. Čo tento plán vedome nerieši

| Čo | Prečo |
|---|---|
| Kópia nahrávok hovorov | Zvuk reálnych ľudí; na testovanie netreba |
| Pravidelná synchronizácia dát | Jednorazová kópia stačí; priebežná by bola ďalší systém na údržbu |
| Automatické prebúdzanie po pozastavení | Vyžadovalo by vonkajší budík; ručné obnovenie je raz za čas |
| Oddelenie Telnyx účtu | Telefónia sa na teste vypína prepínačom, samostatný účet netreba |

---

## 7. Poznámka o dátach, ktorá bude raz dôležitá

Dnes sa smie kopírovať produkcia bez obáv, lebo v nej sú **testovacie dáta** — 17 prípadov a 15 kontaktov, väčšinou vlastné čísla tímu.

**Keď do produkcie pribudnú reálni zákazníci, tento plán prestane platiť.** Kopírovať zákaznícke údaje do bezplatnej databázy v inej organizácii vtedy nebude v poriadku a schéma sa bude musieť napĺňať vyrobenými dátami. Kto bude tento dokument čítať neskôr: najprv si over, koľko je v produkcii reálnych kontaktov.
