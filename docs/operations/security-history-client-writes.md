# B2 — priame zápisy do histórie prípadov a hovorov

**Aplikované iba na TEST 6. 10. 2026 o 09:31 UTC; produkcia nezmenená.**
Táto oprava je samostatná od už aplikovanej B1 ochrany flotily a partnerov.

## Presný aplikovaný rozsah

[SQL](../../supabase/migrations/20261006093143_restrict_history_client_writes.sql)
mení iba granty a dve existujúce členské RLS politiky tabuliek
`public.motorist_case_events` a `public.motorist_call_events`:

- rolám `public`, `anon`, `authenticated` odoberie tabuľkové práva a rolám
  `anon`, `authenticated` ponechá `SELECT`;
- obe politiky `FOR ALL TO public` zmení na `FOR SELECT TO authenticated`
  s rovnakou podmienkou aktívneho členstva v organizácii;
- zachová existujúce práva `service_role`, dáta, štruktúru tabuliek, indexy,
  cudzie kľúče, triggery, funkcie a Realtime publikácie/politiky.

SQL je jedna transakcia s `lock_timeout=5s` a `statement_timeout=60s`.
SHA-256 presného schváleného a aplikovaného SQL:
`4566acbe4a4abdcabc3a092ccadff3d6c4804b96fae51e3a07d854069a8519e6`.
Vlastník v tejto konverzácii výslovne schválil tento rozsah odpoveďou
„Áno, aplikuj tento SQL iba na TEST“. Aplikácia cez `apply_migration` cielila
iba **TEST `nzpnqdstvkfncflgqlny`** a skončila `success: true`. TEST ledger
eviduje verziu `20261006093143`, názov `restrict_history_client_writes`.
Súbor pôvodne schválený pod názvom `20261006093000_restrict_history_client_writes.sql`
bol následne iba premenovaný podľa ledgeru; obsah a SHA-256 ostali rovnaké.
Produkcia
`ifpaeegaesdmljfkdvcn` vyžaduje osobitné schválenie presného SQL.
Súhlas s prípravou alebo nasadením kódu sám o sebe nepovoľuje vzdialené SQL.

## Prečo práve tieto dve tabuľky

TEST katalóg pred aplikáciou potvrdil na oboch tabuľkách zapnuté RLS, plné tabuľkové
granty pre `anon`/`authenticated`, jednu členskú `ALL` politiku a žiadne
explicitné stĺpcové granty (`pg_attribute.attacl`). Prihlásený člen tak môže
obísť aplikačné operácie a priamo falšovať, meniť alebo mazať históriu svojej
organizácie. Nejde o opravu prístupu medzi organizáciami.

| Cesta | Oprávnený zapisovač |
|---|---|
| Vytvorenie prípadu, poznámka, akcia/úloha a priradenie vozidla | `motorist-mutations.ts`, `createSupabaseAdminClient()` |
| Atómové uloženie karty a automatické udalosti | service-only `motorist_save_case_atomic`, existujúci SECURITY DEFINER |
| Priradenie hovoru k prípadu a výsledok hovoru | `telephony-workflow.ts`, admin klient |
| Prijatie polohy zákazníka | `location-share-links.ts`, serverový admin klient za tokenovou kontrolou |
| História spracovanej SMS | `sms-workflow.ts`, admin klient |
| Telnyx/webhook/app udalosti a opakované doručenie | `state/effects.ts::recordCallEvent`, admin dependency |
| História/PDF/priebeh hovoru/diagnostika | serverové čítanie; klientské SELECT ostáva |

Vyhľadanie všetkých odkazov nenašlo browserový DML zapisovač týchto tabuliek.
Súčasná autorizácia operácie, actor, idempotencia, provider provenance a
session lease zostávajú na existujúcich serverových cestách. Zvyšných 12
širokých členských tabuliek nie je súčasťou tejto migrácie.

## Realtime a podmienky overenia

TEST katalóg nemá tieto dve tabuľky v `pg_publication_tables`. Aktualizácia
prípadu používa existujúci `app_private.motorist_case_live_change` trigger:
zvýši revision a odošle prázdny privátny broadcast `cases:<organization>`.
Klient `CaseCollaborationProvider` potom číta autorizovaný snapshot.
SQL tento trigger, jeho SECURITY DEFINER práva ani broadcast politiku nemení.
Call events nemajú vlastný trigger. Telefonické realtime triggery na ostatných
tabuľkách tiež zostávajú nezmenené.

Pred aplikáciou znova preveriť presné názvy politík, ich jedinečnosť,
`pg_attribute.attacl`, service-role práva, triggery a publikácie. Pri drifte
zastaviť a posúdiť rozdiel. Nepoužiť hromadné `supabase db push`.

[Lokálny PostgreSQL kontrakt](../../tests/postgres/history-client-writes.py)
prešiel **25/25 testami** na dočasnom PostgreSQL 16.14, vrátane 11 existujúcich
atómových case-save scenárov. Testuje skutočné INSERT/UPDATE/DELETE/TRUNCATE,
SELECT pre všetky štyri roly, cudziu organizáciu, neaktívneho/neznámeho/anon
používateľa, skutočné service-role CRUD, unikátny fingerprint pri retry,
atómové case-save, CAS súbeh a rollback po chybe auditu. Presný existujúci
case-live trigger zvýši revision a vytvorí prázdny broadcast; druhé nezávislé
DB spojenie vidí povolený commit. Realtime transport je lokálny záznamník
volania `realtime.send`, nie pripojenie k hostovanému websocketu.

Test tiež reprodukuje pôvodný priamy zápis, dokazuje nezmenené existujúce
udalosti a katalóg funkcií, triggerov, indexov, publikácií a service-role grantov
po migrácii. Simulovaný neskorší DML regrant neobnoví členský zápis vďaka SELECT
RLS. Prešlo ďalších **140 existujúcich aplikačných testov** pre case linking,
polohu, SMS, úlohy, webhook spracovanie/recovery, priebeh hovoru a čítanie karty.

Spustenie: `python3 tests/postgres/history-client-writes.py`; používa iba
`127.0.0.1:55432`, nevie načítať aplikačné prístupy ani vzdialenú DSN.
[Hosted postflight](../../supabase/verification/history-client-writes.sql) beží
v `BEGIN READ ONLY`, overí granty/politiky a reálne roľové čítanie bez údajov
udalostí. Samotný postflight prešiel lokálnym kontraktom s 18 výsledkami.
Na hostovanom TEST prešiel po aplikácii **16/16 kontrol**: granty oboch tabuliek,
čítanie existujúcich aktívnych admin/dispatcher/senior_dispatcher profilov,
izolácia cudzej organizácie a nulový prístup neznámeho používateľa aj anon.
Aktívny manager profil na TEST nie je; jeho správanie pokrýva lokálny kontrakt.
Pred aplikáciou aj po nej bolo presne **200 case events a 875 call events**.
Potvrdené boli rovnaké service-role granty, zapnuté RLS, žiadne stĺpcové granty,
nezmenené publikácie a rovnaké definície členského helpera aj case-live triggera.
Obe existujúce politiky sú teraz iba `SELECT TO authenticated`.
Hosted UI, transport Realtime a hlasové overenie ostávajú samostatné kroky
aplikačného TEST handoffu; read-only DB kontroly ich nenahrádzajú.

Oprava uzatvára priame DML do dvoch histórií. Nemení oprávnenia nadradených
prípadov/hovorov ani ich existujúce cudzie kľúče s kaskádovým mazaním; úplná
revízia zostávajúcich členských tabuliek ostáva samostatná auditná položka.

## Návrat pri regresii

Najprv určiť konkrétnu zlyhávajúcu serverovú cestu. Preferovať opravu tejto
cesty pri zachovaní zákazu klientského falšovania histórie. SQL nevyžaduje
návrat aplikačného kódu, providerov alebo dát.

Presný návrat práv by v jednej autorizovanej transakcii obnovil `GRANT ALL`
pre `anon, authenticated` na týchto dvoch tabuľkách a pôvodné politiky
`FOR ALL TO public USING (app_private.motorist_is_org_member(organization_id))
WITH CHECK (app_private.motorist_is_org_member(organization_id))` s rovnakými
názvami. Tým sa **znovu otvorí pôvodný problém**; tento dokument jeho
vykonanie neautorizuje. Rollback nesmie meniť dáta alebo triggery.

```sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
grant all privileges on table public.motorist_case_events,
  public.motorist_call_events to anon, authenticated;
drop policy motorist_case_events_organization_access on public.motorist_case_events;
create policy motorist_case_events_organization_access
  on public.motorist_case_events for all to public
  using (app_private.motorist_is_org_member(organization_id))
  with check (app_private.motorist_is_org_member(organization_id));
drop policy motorist_call_events_organization_access on public.motorist_call_events;
create policy motorist_call_events_organization_access
  on public.motorist_call_events for all to public
  using (app_private.motorist_is_org_member(organization_id))
  with check (app_private.motorist_is_org_member(organization_id));
commit;
```
