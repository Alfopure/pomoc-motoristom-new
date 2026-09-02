# Manuálny bootstrap VIPTel pracovísk 20–23

Tento postup pripraví existujúce VIPTel klapky `20`, `21`, `22` a `23` ako
rovnocenné dynamické pracovné miesta. SQL súbory sú zámerne mimo
`supabase/migrations`: deploy, `supabase db push` ani štart aplikácie ich nikdy
nespustí. Bootstrap nemení členstvo ani poradie radov `601`–`603`, 30-sekundové
časovače, SIP heslá ani VIPTel konfiguráciu.

## Poradie nasadenia a schema precondition

Najprv musia byť štandardným release postupom aplikované additive migrácie
`20260807102059_dynamic_hotdesk_workplaces.sql` a
`20260807102355_workplace_bootstrap_receipts.sql`; následne musí byť nasadený
zhodný web a listener commit. Až potom možno samostatne, ručne spustiť
preflight a data-only apply.
Všetky SQL artefakty fail-fast kontrolujú marker column, lease/resource tabuľky
a begin RPC; nesmú sa spúšťať proti čiastočne migrovanej schéme.

Receipt tabuľka je zámerná server-only schema stopa; sama nevytvára pracovné
miesto ani nemení živé dáta. Má forced RLS, žiadnu browser policy a práva iba
pre `service_role`. Riadky vzniknú až pri explicitnom data-only apply, ktorý v
tej istej serializable transakcii uloží presný before/after stav. Po rollbacku
sa nemažú: zostávajú nemennou prevádzkovou stopou. Pred release musí izolovaný
PG test potvrdiť RLS/privilege kontrakt aj apply → replay → rollback → replay.

## Čo bootstrap vytvorí

- Každá klapka dostane stabilné `workplace_seat_generation` a nemenný audit
  lifecycle s režimom `workplace_claim`.
- Voľné miesto má canonical stav `unassigned` a nemá lease.
- Miesto so súčasným vlastníkom má canonical stav `assigned` a jednu zámerne
  expirovanú lease. Lease má náhodný, nikomu nevydaný resume hash a náhodnú
  identitu browsera. Nepripája telefón ani nikoho neoprávňuje volať; iba
  bezpečne reprezentuje starého offline vlastníka, ktorého môže následný
  dynamický flow obnoviť alebo prevziať.
- Server-only receipt uloží presný stav pred/po, bootstrap lease, head audit,
  DB guardy a nezmenený routing snapshot. Receipt nie je čitateľný browserom.

## Povinné vstupy

| Premenná | Hodnota |
| --- | --- |
| `organization_id` | UUID presne jednej organizácie. |
| `actor_profile_id` | UUID aktívneho profilu s rolou `manager` alebo `admin`; táto identita bude v audite. |
| `bootstrap_batch_id` | Nové náhodné UUID pre tento pokus. Pri nejasnom výsledku zopakovať s tým istým UUID, nikdy nevymýšľať ďalšie. |
| `provider_evidence_not_before` | ISO čas čerstvého, úspešne potvrdeného VIPTel refreshu; najviac 5 minút starý. |
| `seat20_profile_id` … `seat23_profile_id` | Aktuálny vlastník danej klapky alebo prázdny reťazec, ak je klapka voľná. Nie je to želaný nový vlastník. |

Vlastníka nezisťovať podľa mena. Použiť presný UUID a pred apply potvrdiť túto
projekciu:

```sql
select e.extension, e.id as extension_id, e.profile_id, p.display_name,
       p.active, p.role, p.phone_extension, e.is_registered,
       e.is_viptel_phone_active, e.last_synced_at,
       e.workplace_seat_generation
from public.motorist_telephony_extensions e
left join public.motorist_profiles p
  on p.organization_id = e.organization_id and p.id = e.profile_id
where e.organization_id = '<organization_id>'::uuid
  and e.provider = 'viptel' and e.extension in ('20','21','22','23')
order by e.extension;
```

## Údržbové okno a provider preconditions

SQL nedokáže zastaviť browser, listener ani SIP registráciu mimo databázy.
Pred preflightom preto musia byť splnené všetky body:

1. Vypnúť vytváranie nových hot-desk/workplace a live telephony mutácií v appke.
2. Odpojiť browser telefóny `20`–`23`; na žiadnom nesmie zvoniť ani prebiehať hovor.
3. Nesmie prebiehať zmena poradia, queue príkaz ani recovery operácia.
4. Prihlásený admin v Ústredni vykoná nový provider refresh (POST presence cez
   bežné tlačidlo obnovy). Hetzner listener musí vrátiť práve jednu odregistrovanú
   klapku pre `20`–`23`, úplné rady `601`–`603`, nulový aktívny hovor a
   `inUse=false`.
5. Z DB zobrať najstaršie `last_synced_at` zo štyroch klapiek a ich relevantných
   queue memberships. Tento čas je `provider_evidence_not_before`. Ak je starší
   než 5 minút, refresh zopakovať. Samotný ručne napísaný čas nie je dôkaz.
6. Uchovať export aktuálnej VIPTel registrácie/aktívnych hovorov/radov a výstup
   read-only preflightu ako change evidence.

Ak je niektorý stav `NULL`, neúplný alebo nejednoznačný, postup sa zastaví. Ani
expirovaný DB claim sa nesmie ručne ukradnúť; najprv sa musí dokončiť recovery.

### Recovery osirelého webphone claimu

Ak preflight nájde na jednej klapke starý `assignmentActionClaim` s presnou
akciou `webphone.session.issue`, nepoužívať ručný `UPDATE`. Po zatvorení všetkých
webphone okien vytvoriť cez produkčný snapshot bridge nový confirmed
`provider.snapshot`. Musí byť najviac päť minút starý, obsahovať presne unikátne
klapky `20`–`23` ako odregistrované/neaktívne, nulový aktívny hovor a presne
unikátne rady `601`–`603` bez čakania a bez člena `inUse`.

Z databázy uložiť presné `extension.updated_at`, UUID claimu, UUID snapshot
commandu a jeho `snapshot.capturedAt`. Potom možno samostatne spustiť iba:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v actor_profile_id="$MOTORIST_ACTOR_PROFILE_ID" \
  -v extension="$MOTORIST_ORPHAN_EXTENSION" \
  -v expected_profile_id="$MOTORIST_ORPHAN_OWNER_PROFILE_ID" \
  -v expected_claim_id="$MOTORIST_ORPHAN_CLAIM_ID" \
  -v expected_extension_updated_at="$MOTORIST_ORPHAN_EXTENSION_UPDATED_AT" \
  -v provider_snapshot_command_id="$MOTORIST_PROVIDER_SNAPSHOT_COMMAND_ID" \
  -v provider_evidence_captured_at="$MOTORIST_PROVIDER_EVIDENCE" \
  -v recovery_audit_id="$MOTORIST_ORPHAN_RECOVERY_AUDIT_ID" \
  -v recovery_reference="$MOTORIST_ORPHAN_RECOVERY_REFERENCE" \
  -f deploy/supabase/viptel-workplace-orphan-webphone-claim-recover.sql
```

Artefakt používa exact CAS a odstráni iba konkrétny osirelý webphone claim.
Z rovnakého potvrdeného snapshotu zároveň premietne pre všetky štyri klapky iba
`is_registered`, `is_viptel_phone_active` a `last_synced_at`; nemení vlastníka,
lifecycle, assignment generation ani rady. Pred/po projekciu, provider command,
čas dôkazu a claim uloží v nemennom audite
`telephony.extension.assignment_claim.recovered`. Rovnaký audit ID a rovnaké
vstupy sú idempotentný replay. Iný typ claimu, nový claim, aktívny hovor,
neúplný snapshot alebo zmena ktoréhokoľvek uzamknutého riadku postup zastavia.
Po recovery okamžite spustiť štandardný read-only preflight s rovnakým
`provider_evidence_not_before`; pri oneskorení nad päť minút vytvoriť nový
snapshot cez štandardné obnovenie prítomnosti, ktoré znovu materializuje
projekciu klapiek, a recovery už neopakovať s novým audit ID.

## Spustenie

Pracovať z presného release commitu, s databázovým owner/service pripojením zo
schváleného secret managera. URL ani SIP údaje nevkladať do logu alebo ticketu.
Príklad používa lokálne shell premenné len na znázornenie:

```bash
export MOTORIST_DATABASE_URL='postgresql://...'
export MOTORIST_ORGANIZATION_ID='...'
export MOTORIST_ACTOR_PROFILE_ID='...'
export MOTORIST_BOOTSTRAP_BATCH_ID='...'
export MOTORIST_PROVIDER_EVIDENCE='2026-08-07T12:34:56.789Z'
export MOTORIST_SEAT20_PROFILE_ID='...'
export MOTORIST_SEAT21_PROFILE_ID=''
export MOTORIST_SEAT22_PROFILE_ID='...'
export MOTORIST_SEAT23_PROFILE_ID=''
```

Najprv povinný read-only preflight:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v actor_profile_id="$MOTORIST_ACTOR_PROFILE_ID" \
  -v bootstrap_batch_id="$MOTORIST_BOOTSTRAP_BATCH_ID" \
  -v provider_evidence_not_before="$MOTORIST_PROVIDER_EVIDENCE" \
  -v seat20_profile_id="$MOTORIST_SEAT20_PROFILE_ID" \
  -v seat21_profile_id="$MOTORIST_SEAT21_PROFILE_ID" \
  -v seat22_profile_id="$MOTORIST_SEAT22_PROFILE_ID" \
  -v seat23_profile_id="$MOTORIST_SEAT23_PROFILE_ID" \
  -f deploy/supabase/viptel-workplace-bootstrap-preflight.sql
```

Musí vrátiť práve štyri riadky `ready_unassigned` alebo
`ready_offline_owner`. Bez ručných opráv a bez zmeny vstupov bez nového
preflightu potom spustiť apply:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v actor_profile_id="$MOTORIST_ACTOR_PROFILE_ID" \
  -v bootstrap_batch_id="$MOTORIST_BOOTSTRAP_BATCH_ID" \
  -v provider_evidence_not_before="$MOTORIST_PROVIDER_EVIDENCE" \
  -v seat20_profile_id="$MOTORIST_SEAT20_PROFILE_ID" \
  -v seat21_profile_id="$MOTORIST_SEAT21_PROFILE_ID" \
  -v seat22_profile_id="$MOTORIST_SEAT22_PROFILE_ID" \
  -v seat23_profile_id="$MOTORIST_SEAT23_PROFILE_ID" \
  -f deploy/supabase/viptel-workplace-bootstrap-apply.sql
```

Apply používa serializable transakciu a všetky štyri miesta sa zapíšu spolu,
alebo ani jedno. Pri strate spojenia sa najprv skontroluje receipt; ten istý
príkaz sa môže zopakovať iba s rovnakým `bootstrap_batch_id` a rovnakými
vstupmi. Výstup `already_applied=true` je bezpečný replay. Nové batch UUID po
nejasnom výsledku je zakázané.

## Dôkaz po apply

Ešte so zakázanými mutáciami overiť:

```sql
select e.extension, e.profile_id, e.workplace_seat_generation,
       e.metadata->>'assignmentGeneration' as assignment_generation,
       e.metadata#>>'{assignmentLifecycle,state}' as lifecycle_state,
       e.metadata#>>'{assignmentLifecycle,assignmentMode}' as lifecycle_mode,
       l.id as lease_id, l.state as lease_state, l.expires_at, now() > l.expires_at as lease_expired,
       r.bootstrap_batch_id, r.terminal_audit_id
from public.motorist_telephony_extensions e
join public.motorist_workplace_bootstrap_receipts r
  on r.organization_id = e.organization_id and r.extension_id = e.id and r.rolled_back_at is null
left join public.motorist_workplace_leases l
  on l.organization_id = r.organization_id and l.id = r.bootstrap_lease_id
where e.organization_id = '<organization_id>'::uuid
order by e.extension;
```

Očakávanie: štyri rôzne stabilné seat generations, vždy
`lifecycle_mode=workplace_claim`; voľné miesto bez lease, obsadené miesto s
`lease_state=active` a `lease_expired=true`. Najnovší terminal audit musí mať
ID z receiptu. Urobiť ešte jeden čerstvý provider snapshot a potvrdiť, že SQL
nič nezaregistrovalo a routing `601 → 602 → 603` sa nezmenil. Až potom zapnúť
aplikáciu pre kontrolovaný test jedného operátora.

## Guarded rollback

Najbezpečnejší rollback pred prvým runtime použitím je vypnúť feature gate a
nechať receipt na kontrolu. SQL rollback použiť iba ak je nutné obnoviť presné
predchádzajúce extension polia a od bootstrapu neprebehla žiadna operácia,
heartbeat, zmena poradia, príkaz, hovor ani provider registrácia.

Znova splniť celé údržbové okno, spraviť nový provider refresh a spustiť:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v actor_profile_id="$MOTORIST_ACTOR_PROFILE_ID" \
  -v bootstrap_batch_id="$MOTORIST_BOOTSTRAP_BATCH_ID" \
  -v provider_evidence_not_before="$MOTORIST_PROVIDER_EVIDENCE" \
  -f deploy/supabase/viptel-workplace-bootstrap-rollback.sql
```

Rollback vymaže iba presne zhodnú bootstrap lease, obnoví extension polia a
pridá audit; nikdy nemaže nemennú históriu. Ak pred bootstrapom existoval
platný lifecycle, pridá sa zodpovedajúci terminal kompenzačný audit. Ak predtým
neexistoval žiadny lifecycle, presné polia sa síce obnovia, ale historický
bootstrap audit zámerne ostáva. Také miesto potom bezpečne zlyhá pri pokuse o
opätovné „initial provisioning“ a pred ďalším pridelením vyžaduje skutočnú SIP
rotáciu/reprovisioning. Toto je nezvratný auditný dôsledok, nie chyba rollbacku.

Chybu `...STATE_CHANGED`, `...GUARD_CHANGED`, `...ROUTING_CHANGED` alebo
`...LIVE_ACTIVITY_PRESENT` neobchádzať ručným UPDATE/DELETE. Znamená, že stav už
nie je nedotknutý a treba samostatný recovery plán podľa aktuálneho vlastníka,
lease, provider snapshotu a routing auditu.
