# Časovo obmedzené schválenie testu radu

Tento postup vytvorí nemenný audit, ktorý `trusted_test` potrebuje pred
uvoľnením alebo výmenou pracovného miesta zaradeného v rade. Je určený iba pre
jedného menovaného operátora, jednu zdrojovú klapku, presný root radu `601`,
maximálne 12-hodinové okno a vopred schválený nezávislý fallback.

SQL súbory sú zámerne mimo migrácií a samy nemenia VIPTel, rady, Vercel env ani
feature gate. Development a Preview používajú produkčné dáta; žiadny krok sa
nesmie skúšať bez kontrolovaného okna a bez istoty, že neodsunie reálny hovor.

## Povinné dôkazy a vstupy

- `organization_id`: presná organizácia.
- `approving_actor_profile_id`: aktívny `manager` alebo `admin`, ktorý okno
  schválil.
- `evidence_id`: nové UUID. Po vložení je to presná hodnota
  `VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID`.
- `root_queue_id`: UUID jedinej aktívnej VIPTel queue `601` s `line_id IS NULL`.
- `probe_profile_id`: aktívny testovací profil, ktorý práve vlastní zdroj.
- `source_extension`: jeho canonical `workplace_claim` miesto `20`–`23`, ktoré
  je presne raz v aktuálnom pláne `601`–`603`.
- `starts_at`, `ends_at`: canonical UTC ISO s milisekundami, napríklad
  `2026-08-07T10:00:00.000Z`; trvanie najviac 12 hodín.
- `fallback_reference`: 6–160 znakov, referencia na datovaný dôkaz, že
  nezávislý registrovaný a nepozastavený fallback zostane dostupný. Nie SIP
  heslo ani telefónne tajomstvo.
- `provider_evidence_not_before`: čas začiatku nového Hetzner provider snapshotu,
  nie ručne vymyslený aktuálny čas.

Pred schválením musí čerstvý snapshot obsahovať kompletné `601`–`603` a nula
čakajúcich hovorov vo všetkých troch radoch. Root nesmie mať routing operáciu.
Zdroj musí mať zhodný profil, lifecycle, profilovú rezerváciu a najnovší
nemenný assignment audit. Skutočný live pokus tieto podmienky overí znova a
navyše blokuje registráciu/hovor/`inUse`/pending command podľa konkrétnej
operácie.

## Vytvorenie schválenia

Najprv s vypnutými hot-desk claims spustiť manuálny SQL:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v approving_actor_profile_id="$MOTORIST_APPROVER_PROFILE_ID" \
  -v evidence_id="$MOTORIST_QUEUE_PROBE_EVIDENCE_ID" \
  -v root_queue_id="$MOTORIST_QUEUE_601_ID" \
  -v probe_profile_id="$MOTORIST_PROBE_PROFILE_ID" \
  -v source_extension="$MOTORIST_PROBE_SOURCE_EXTENSION" \
  -v starts_at="$MOTORIST_PROBE_STARTS_AT" \
  -v ends_at="$MOTORIST_PROBE_ENDS_AT" \
  -v fallback_reference="$MOTORIST_PROBE_FALLBACK_REFERENCE" \
  -v provider_evidence_not_before="$MOTORIST_PROVIDER_EVIDENCE" \
  -f deploy/supabase/viptel-workplace-queue-probe-approve.sql
```

Rovnaké `evidence_id` a rovnaké vstupy sú idempotentný replay. Konfliktné
znovupoužitie ID alebo prekrývajúce sa neodvolané okno je odmietnuté.

Skontrolovať presný audit:

```sql
select id, actor_profile_id, action, entity_type, entity_id, after_payload
from public.motorist_audit_log
where organization_id = '<organization_id>'::uuid
  and id = '<evidence_id>'::uuid;
```

`after_payload` musí presne obsahovať `schemaVersion=1`,
`capability=controlled_probe`, organization/profile/source/root, oba časy a
fallback reference. Až potom nastaviť v jednom kontrolovanom runtime:

```text
VIPTEL_WORKPLACE_QUEUE_CAPABILITY=controlled_probe
VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID=<evidence_id>
VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID=<probe_profile_id>
VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION=<source_extension>
VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT=<starts_at>
VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT=<ends_at>
VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE=<fallback_reference>
```

Všetky hodnoty musia byť byte-for-byte zhodné s auditom. `trusted_test` nesmie
bežať vo Vercel production a jeho pilot profile musí byť aj v hot-desk
allowliste. Výslovne schválený `production_static_pilot` tento dôkaz ani
`VIPTEL_WORKPLACE_QUEUE_*` env nepoužíva; ide o samostatnú vedomú výnimku
popísanú v
[produkčnom pilot runbooku](./viptel-workplace-production-static-pilot.md).
Claims gate zapnúť až tesne pred testom a po každom kroku overiť nula čakajúcich
hovorov, živý fallback a aktuálny provider snapshot.

## Stav, expiry a rollback

Read-only kontrola:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v approval_evidence_id="$MOTORIST_QUEUE_PROBE_EVIDENCE_ID" \
  -f deploy/supabase/viptel-workplace-queue-probe-status.sql
```

Runtime porovnáva čas čerstvého provider snapshotu s oknom. Pred začiatkom a po
`ends_at` je pokus automaticky odmietnutý. Expiry však nevypína env ani iné
feature gates, preto po teste vždy urobiť explicitný rollback:

1. Nastaviť `VIPTEL_WORKPLACE_HOTDESK_ENABLED=false` a nasadiť konfiguráciu.
2. Overiť drain kontrakt: nový claim, takeover a switch vracajú bezpečný
   neúspech, zatiaľ čo existujúce leave, heartbeat, resume a recovery zostávajú
   povolené, aby sa aktívne pracoviská vedeli korektne vyprázdniť a zotaviť.
3. Odstrániť všetkých päť `VIPTEL_WORKPLACE_QUEUE_PROBE_*` hodnôt, evidence ID a
   vrátiť queue capability na `unverified`.
4. Až potom zapísať nemenný revocation/closure audit:

```bash
psql "$MOTORIST_DATABASE_URL" \
  -v organization_id="$MOTORIST_ORGANIZATION_ID" \
  -v revoking_actor_profile_id="$MOTORIST_APPROVER_PROFILE_ID" \
  -v approval_evidence_id="$MOTORIST_QUEUE_PROBE_EVIDENCE_ID" \
  -v revocation_audit_id="$MOTORIST_QUEUE_PROBE_REVOCATION_ID" \
  -v reason_reference="$MOTORIST_PROBE_ROLLBACK_REFERENCE" \
  -v gate_disabled_confirmation=HOTDESK_DISABLED_AND_PROBE_ENV_REMOVED \
  -f deploy/supabase/viptel-workplace-queue-probe-revoke.sql
```

Revocation audit je prevádzkový dôkaz, nie kill switch: schválený audit je
nemenný a nemaže sa. Ak nie je možné bezpečne nasadiť vypnutý gate, nevykonávať
ďalšiu telephony operáciu a počkať na prirodzené `ends_at`; SQL audit sám osebe
predčasne nezruší runtime oprávnenie.

Po rollbacku status musí byť `revoked`, serverové env nesmú obsahovať scope a
kontrolný request musí zostať zablokovaný. Výsledok testu zapísať samostatným
auditom/change evidence; úspešný probe nie je automaticky dôkaz
`verified_skip` ani `verified_fallback` pre produkciu.
