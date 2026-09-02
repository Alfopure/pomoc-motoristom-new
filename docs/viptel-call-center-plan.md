# VIPTel Call Center Foundation Plan

## Phase 3 implementation status

Durable call history is implemented without a new migration:

- the listener stores each raw WebSocket event before applying the normalized call update;
- queue parent and agent-leg IDs are correlated through the existing append-only event rows;
- CDR reconciliation is authoritative for terminal status and persists the original received number separately from the final destination;
- calls are correlated to configured lines, queues, extensions and operator profiles;
- call history refreshes through an authenticated internal poll, including an immediate retry when a live call disappears;
- call and queue commands are inserted before the provider request and always carry the authenticated profile.

Production activation remains an explicit Hetzner operation. See `docs/operations/viptel-phase-3-activation.md`.

## Goal

Postaviť call-center základ tak, aby sme z VIPTel nebrali iba minimum, ale kompletne všetko použiteľné pre dispečing: živé hovory, rady, klapky, históriu hovorov, nahrávky, click-to-call, presmerovanie, stav agentov, SMS a surové payloady pre dohľadateľnosť.

UI nesmie byť napojené priamo na VIPTel. VIPTel ide cez serverový bridge, ktorý normalizuje dáta do Supabase. Prehliadač číta naše tabuľky a volá iba naše interné API.

## Official VIPTel Capabilities Verified

### REST API

Oficiálny dokument: `https://www.viptel.sk/images/pdfs/VIPTel_PBX_REST.pdf`

- Base URL: `https://pbxmanager.viptel.sk/`
- Auth: HTTP Basic Auth s API používateľom a heslom. VIPTel potvrdil, že API credentials sú nezávislé od PBX Manager loginu.
- Aktivácia: službu musí aktivovať VIPTel.
- Sieť: treba nahlásiť povolené IP adresy.
- Limit: 20 požiadaviek za 5 sekúnd; po prekročení 403 blok na 30 minút.

REST endpointy, ktoré chceme pokryť:

| Oblasť | Endpoint | Účel |
| --- | --- | --- |
| Click-to-call | `GET /api/call/create` | Vytvorenie hovoru z klapky na číslo/klapku. |
| Pokročilý click-to-call | `POST /api/call/advanced/{profil}` | Dohodnuté vlastné profily volania. |
| Aktívne hovory | `GET /api/call/statistics` | Aktuálne prebiehajúce a zvoniace hovory. |
| História hovorov | `GET /api/cdr/` | CDR zoznam, max 3000 záznamov, filtre `limit`, `offset`, `date_from`, `date_to`. |
| Detail hovoru | `GET /api/cdr/{id}` | Detail podľa ID alebo `unique_id`. |
| Hovory s nahrávkou | `GET /api/cdr/recordings` | Zoznam CDR, ktoré majú nahrávku. |
| Download nahrávky | `GET /api/cdr/download/{id}` | Stiahnutie súboru podľa ID alebo `unique_id`. |
| Delete nahrávky | `GET /api/cdr/delete/{id}` | Zmazanie nahrávky. V UI držať len pre admin/legal režim. |
| Zoznam radov | `GET /api/queue/` | Konfigurácia čakacích radov. |
| Agent do radu | `GET /api/queue/add` | Pridať klapku do radu. |
| Agent z radu | `GET /api/queue/remove` | Odobrať klapku z radu. |
| Pause agenta | `GET /api/queue/pause` | Pozastaviť prijímanie hovorov v rade. |
| Unpause agenta | `GET /api/queue/unpause` | Povoliť agenta v rade. |
| Stav radu | `GET /api/queue/status` | Čakajúci, členovia, pause, in-use, počty prijatých hovorov. |
| Zoznam klapiek | `GET /api/extension` | Klapky, meno, outbound CID, registrácia, presmerovanie. |
| Detail klapky | `GET /api/extension/{id}` | Detail jednej klapky. |
| VIPTel Phone aktivácia | `POST /api/viptel-phone/activate/{id}` | Aktivovať VIPTel Phone pre klapku. |
| VIPTel Phone deaktivácia | `POST /api/viptel-phone/deactivate/{id}` | Deaktivovať VIPTel Phone pre klapku. |
| Úprava klapky | `POST /api/extension/update/{id}` | Meno, presmerovanie, outbound CID. |
| Povolené outbound čísla | `GET /api/extension/outbounds` | Zoznam povolených caller ID. |
| Zákaznícke dáta | `POST /api/data`, `POST /api/data/{key}`, `GET /api/data/list`, delete/flush | Key-value dáta vo VIPTel. Použiť opatrne, nie ako hlavný CRM store. |

### WebSocket API

Oficiálny dokument: `https://www.viptel.sk/images/pdfs/VIPTel_PBX_WebSocket.pdf`

- WebSocket URL podľa živého overenia z tejto siete: `wss://pbxwssv1.viptel.sk:8088/`
- VIPTel v odpovedi skrátene uviedol `wss://pbxwssv1.viptel.sk/`, ale aktuálny probe bez portu zlyhal a port `8088` úspešne vrátil nonce aj `202 Login successfull`.
- Staršie PDF uvádza `wss://pbxmanager.viptel.sk:8088`; v pilotnej konfigurácii používať potvrdené `pbxwssv1`.
- Aktivácia: musí povoliť VIPTel.
- Sieť: treba nahlásiť povolené IP adresy.
- Login: server po spojení pošle `nonce`; klient posiela `user.login`.
- Hash: `SHA1(SHA1(<username>:<password>):<nonce>)`.
- Treba automatický reconnect a relogin.

WebSocket akcie, ktoré chceme podporiť:

- `user.login`
- `user.logout`
- `call.create`
- `call.hangup`
- `call.redirect`

WebSocket udalosti, ktoré chceme ukladať celé:

- `call.begin`
- `call.end`
- `call.pickup`
- `call.create_response`
- `queue.add`
- `queue.remove`
- `queue.pause`
- `queue.unpause`
- `queue.join`
- `queue.left`

Kľúč pre koreláciu je `unique_id`. Ten musí byť všade: normalizovaný hovor, eventy, nahrávky, transcript, case väzba.

### SIP.js / Browser Phone

Pre vlastný browser phone nepoužívame produkčnú klapku `10 / Miso`. PBXManager k 2026-06-11 ukazuje test klapky `11`, `12`, `13`; username je číslo klapky a heslo je v stĺpci `Heslo`.

VIPTel potvrdil pre WebRTC/PJSIP browser phone:

- SIP/WebRTC WebSocket URL pre SIP.js: `wss://pbxwssv1.viptel.sk/`,
- SIP registrar server podľa PBXManagera: `pomocmotor.cloud.viptel.sk`,
- SIP domain/realm: `pomocmotor.cloud.viptel.sk`,
- SIP registrar port v PBXManageri: `5060`; tento port je pre klasické SIP zariadenia, browser SIP.js stále potrebuje presný `wss://` endpoint,
- outbound caller ID: `0412289133`,
- outbound proxy netreba, pokiaľ nechceme samostatne riešiť SIP cez TLS a podpísaný certifikát,
- STUN/TURN netreba,
- kodeky v poradí: `opus`, `G722`, `PCMU`, `PCMA`, `GSM`,
- DTMF: RFC/RTP alebo SIP INFO,
- registrácia nie je geograficky obmedzovaná,
- browser phone predstavuje koncové zariadenie a má vytáčať zákazníka priamo cez SIP `INVITE`.
- VIPTel potvrdil, že pre webPhone treba použiť meno a heslo pri klapke zo stĺpca `Heslo`; screenshot s klapkou `10` berieme iba ako ukážku, pilotné testovanie ostáva na klapkách `11`, `12`, `13`.

Konfigurácia je runtime env, nie `NEXT_PUBLIC_*`, aby sa dala meniť bez rebuildnutia staticky inlinovaných hodnôt:

- `VIPTEL_SIP_WS_URL`, `VIPTEL_SIP_DOMAIN`, `VIPTEL_SIP_REALM`, `VIPTEL_SIP_OUTBOUND_PROXY`,
- `VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED`, `VIPTEL_SIP_ALLOWED_ORIGINS`,
- `VIPTEL_SIP_STUN_URLS`, `VIPTEL_SIP_TURN_URLS`, `VIPTEL_SIP_TURN_USERNAME`, `VIPTEL_SIP_TURN_CREDENTIAL`,
- `VIPTEL_SIP_CODECS`, `VIPTEL_SIP_DTMF_MODE`,
- `VIPTEL_WEBPHONE_DIAL_MODE=rest_first_leg|sip_invite`,
- `VIPTEL_WEBPHONE_EXTENSIONS` plus per-extension `VIPTEL_WEBPHONE_<EXT>_*`, alebo `VIPTEL_WEBPHONE_EXTENSIONS_JSON`.

Default vytáčania je `sip_invite`: po registrácii vybranej browser klapky volá SIP.js zákazníka priamo cez SIP `INVITE`. VIPTel potvrdil, že CRM môže aj naďalej vytvoriť hovor cez API tak, že najprv vyzvoní browser/PJSIP klapku; režim `rest_first_leg` preto nechávame ako univerzálny fallback, ktorý nie je viazaný na integrovaný browser phone.

SIP credentials pre browser phone sú citlivé. API `/api/telephony/webphone/config` ostáva redacted; heslo vracia iba auth-gated `POST /api/telephony/webphone/session` pre jednu vybranú test klapku a iba pri explicitnom `VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS=true`.

### SMS

Oficiálna stránka: `https://www.viptel.sk/sms-brana-hromadne-sms-cez-internet`

Lokálna príloha `SMS_API_dokumentacia_v1.8 2.pdf` doplnila presné SMS API detaily:

- Base URL: `https://smsapi.viptel.sk/api/`
- Auth: HTTP Basic Auth s menom a heslom zo SMS API bezpečnostného protokolu.
- Formát: GET parametre v URL, POST ako `form-data`, odpovede JSON.
- Odosielateľské identity:
  - `GET /identities/`
  - `GET /identities/{identity_id}/`
- Odosielanie:
  - `POST /messages/` s `from_identity`, `body`, `dest_msisdn`
  - `POST /messages/mass/` s opakovanými `identity[]`, `body[]`, `dest_msisdn[]`
- História a doručenie:
  - `GET /messages/`
  - `GET /messages/{hash_id}/`
- Kredit:
  - `GET /credits/`
- Inbound SMS:
  - VIPTel nastavuje webhook na aktivovanú linku.
  - Podporuje GET alebo POST s `json`/`form`, voliteľný Basic Auth alebo Bearer token.
  - Štandardné polia sú `id`/`message_uuid`, `content`, `received_at`, `direction`, `sender`, `recipient`.
  - Pri non-2xx odpovedi retry prebieha počas 24 hodín, maximálne 32-krát.

Na reálne testovanie nám stále chýba potvrdená aktivácia SMS API, SMS API credentials, povolená `from_identity`, kredit/fakturačný režim, testovacie číslo, SMS-specific limity, sandbox/live režim a presné pravidlá textu pre diakritiku/interpunkciu/segmenty.

Pripravené overenie po doplnení credentials:

- server klient: `src/lib/integrations/viptel/sms-client.ts`,
- API probe bez odoslania SMS: `GET /api/telephony/viptel/sms/probe`,
- lokálny CLI probe bez odoslania SMS: `pnpm viptel:sms-probe -- --json`,
- reálny test send je zamknutý cez `VIPTEL_SMS_LIVE_SENDS=true`, `VIPTEL_SMS_TEST_MSISDN` a `--send-test`.
- `VIPTEL_SMS_FROM_IDENTITY` má byť leading-zero hodnota z `GET /identities/`, napr. `00421412289133` alebo `0018365`; bare ID bez leading zeros, napr. `421412289133`, VIPTel odmieta.
- Verejná VIPTel SMS Gate stránka uvádza SMS API ako platenú mesačnú službu a odosielanie SMS ako účtované cez kredit/fakturáciu; ak `POST /messages/` vracia `Sending SMS message forbidden`, treba u VIPTel overiť povolenie outbound odosielania a platobný stav pre konkrétny účet.

## Data Principles

- Uložiť každý hovor, aj keď z neho nevznikne prípad.
- Nikdy nestratiť raw payload: každý WebSocket event a REST odpoveď uložiť do append-only logu.
- Normalizované tabuľky sú pre UI, raw tabuľky sú pre audit/debug/backfill.
- Každá mutácia smerom do VIPTel ide cez našu tabuľku príkazov a audit.
- Realtime UI má čítať Supabase Realtime, nie VIPTel WebSocket.
- Nahrávky a transcript sú citlivé: súkromný storage, audit prístupu, retencia.

## Proposed Supabase Tables

### Existing tables to keep and expand

`motorist_telephony_lines`
- pridať/overiť: `provider`, `external_id`, `phone_number`, `label`, `active`, `metadata`
- používať na verejné čísla: napr. `0850 005 006`, špecifické linky pre asistenčky/partnerov.

`motorist_telephony_queues`
- pridať/overiť: `provider`, `external_id`, `queue_number`, `label`, `line_id`, `active`, `metadata`
- mapuje VIPTel queue na náš názov v UI.

`motorist_calls`
- aktuálny stav hovoru.
- doplniť polia:
  - `provider_call_id` / VIPTel `id` z CDR,
  - `viptel_unique_id`,
  - `direction`,
  - `type`,
  - `application`,
  - `status`,
  - `end_reason`,
  - `caller_number`, `caller_name`,
  - `called_number`, `received_number`, `destination_number`,
  - `caller_extension`, `received_extension`, `destination_extension`,
  - `queue_id`, `queue_number`, `from_queue_unique_id`,
  - `operator_id`, `extension_id`,
  - `case_id`,
  - `started_at`, `answered_at`, `ended_at`,
  - `wait_seconds`, `ring_seconds`, `duration_seconds`, `complete_duration_seconds`,
  - `recording_status`, `recording_file`,
  - `transcript_status`, `summary`,
  - `raw_latest_payload`.

`motorist_call_events`
- append-only event stream.
- doplniť:
  - `event_fingerprint` unique,
  - `provider_timestamp`,
  - `received_at`,
  - `event_type`,
  - `viptel_unique_id`,
  - `call_id`,
  - `queue_number`, `extension_number`,
  - `raw_payload`,
  - `normalized_payload`,
  - `handled_status`: `processed`, `ignored`, `failed`, `unknown`.

`motorist_call_recordings`
- nahrávky.
- polia:
  - `call_id`, `viptel_unique_id`, `cdr_id`,
  - `recording_file`,
  - `provider_download_url` alebo len provider reference,
  - `storage_bucket`, `storage_path`,
  - `mime_type`, `size_bytes`, `checksum`,
  - `duration_seconds`,
  - `status`: `pending`, `available`, `failed`, `deleted`, `restricted`,
  - `fetched_at`, `deleted_at`,
  - `retention_until`,
  - `metadata`.

### New tables

`motorist_telephony_extensions`
- `organization_id`
- `provider`
- `external_id`
- `extension_number`
- `display_name`
- `profile_id`
- `outbound_cid`
- `call_forwarding`
- `is_registered`
- `is_viptel_phone_active`
- `allowed_changes`
- `active`
- `last_synced_at`
- `raw_payload`

`motorist_queue_memberships`
- `queue_id`
- `extension_id`
- `extension_number`
- `member_name`
- `paused`
- `in_use`
- `calls_taken`
- `last_call_taken_ago`
- `joined_at`
- `last_synced_at`
- `raw_payload`

`motorist_queue_snapshots`
- časový snapshot pre reporty a SLA.
- `queue_id`
- `queue_number`
- `current_calls_count`
- `waiting_calls`
- `members`
- `captured_at`
- `source`: `rest_poll`, `websocket_event`, `manual_refresh`

`motorist_integration_accounts`
- konfigurácia providerov bez tajomstiev.
- `organization_id`
- `provider`: `viptel`
- `display_name`
- `base_url`
- `websocket_url`
- `enabled_features`: `rest`, `websocket`, `sms`, `recordings`, `click_to_call`, `queue_control`
- `status`: `not_configured`, `configured`, `live`, `degraded`, `disabled`
- `last_success_at`, `last_error_at`, `last_error`
- `metadata`

`motorist_integration_secrets`
- odporúčanie: radšej nepoužiť, ak vieme mať secrets iba vo Vercel/Supabase Vault.
- ak bude nutné ukladať v DB, tak iba šifrovane a nikdy nezobrazovať späť v UI.

`motorist_integration_raw_events`
- univerzálny raw log pre VIPTel REST/WebSocket.
- `provider`
- `channel`: `rest`, `websocket`, `sms`
- `direction`: `inbound`, `outbound`
- `event_type`
- `correlation_id`
- `request_id`
- `status_code`
- `payload`
- `headers_safe`
- `received_at`
- `processed_at`
- `error`

`motorist_telephony_commands`
- auditovateľné akcie do VIPTel.
- `command_type`: `call.create`, `call.hangup`, `call.redirect`, `queue.add`, `queue.remove`, `queue.pause`, `queue.unpause`, `extension.update`, `recording.delete`
- `requested_by`
- `request_payload`
- `provider_response`
- `status`: `queued`, `sent`, `accepted`, `failed`, `confirmed_by_event`
- `idempotency_key`
- `created_at`, `sent_at`, `confirmed_at`

`motorist_sms_messages`
- pripravené na VIPTel SMS.
- `direction`, `to_number`, `from_identity`, `body`, `template_key`
- `case_id`, `call_id`
- `provider_message_id`
- `idempotency_key`, `request_fingerprint`
- `status`: `draft`, `queued`, `sent`, `delivered`, `failed`, `received`
- `price`, `segments`, `raw_payload`
- `queued_at`, `next_attempt_at`, `last_attempt_at`, `retry_count`, `locked_at`, `locked_by`

`motorist_sms_attempts`
- jeden riadok pre každý pokus odoslania SMS cez provider.
- `sms_message_id`, `attempt_number`, `claim_id`
- `idempotency_key`, `request_fingerprint`
- `status`: `queued`, `sending`, `accepted`, `failed`, `skipped`
- `provider_status_code`, `provider_message_id`
- `request_payload_safe`, `provider_response_safe`
- `error_class`, `error`, `started_at`, `finished_at`

`motorist_call_transcripts`
- `call_id`, `recording_id`
- `status`
- `language`
- `transcript_text`
- `speaker_segments`
- `summary`
- `extracted_fields`
- `qa_score`
- `model`
- `created_at`

## Bridge Architecture

1. `viptel-rest-client`
   - server-only TypeScript client,
   - Basic Auth,
   - request throttle pod 20/5s,
   - retries/backoff,
   - structured logging.

2. `viptel-websocket-worker`
   - long-running worker mimo Vercel serverless, ideálne Fly.io/Render/Railway alebo Supabase Edge až po overení WebSocket limitov,
   - stabilná outbound IP na allowlist vo VIPTel,
   - reconnect/relogin,
   - health endpoint,
   - zapisuje raw eventy a normalizované projekcie do Supabase.

3. `reconciliation job`
   - každých pár minút `call/statistics`, `queue/status`, `extension`,
   - nočný backfill `cdr` a `cdr/recordings`,
   - po `call.end` naplánovať fetch nahrávky.

4. `internal app API`
   - `/api/telephony/call/create`
   - `/api/telephony/call/:id/hangup`
   - `/api/telephony/call/:id/redirect`
   - `/api/telephony/queues/:id/pause`
   - `/api/telephony/queues/:id/unpause`
   - `/api/telephony/sync`
   - `/api/telephony/recordings/:id/fetch`

## Settings Screen Layout Later

`Integrácie -> VIPTel`

1. Stav integrácie
   - REST: live/degraded/off
   - WebSocket worker: connected/reconnecting/off
   - posledný event, posledný CDR sync, posledná chyba

2. Prístup
   - username uložený v secrets,
   - password iba write-only,
   - allowed IP checklist,
   - test REST login,
   - test WebSocket login.

3. Linky a rady
   - verejné čísla,
   - čakacie rady,
   - priradenie rad -> názov v aplikácii,
   - ktoré rady zobrazovať v dispečingu.

4. Klapky a operátori
   - VIPTel extension,
   - meno z VIPTel,
   - priradený používateľ/profil,
   - stav registrácie,
   - outbound CID,
   - queue membership.

5. Pravidlá hovoru
   - čo sa stane pri prichádzajúcom hovore,
   - auto-create contact áno/nie,
   - auto-create callback task pre missed/abandoned,
   - call-to-case pravidlá.

6. Nahrávky a retencia
   - fetch recordings on/off,
   - private storage bucket,
   - transcript on/off,
   - retention days,
   - role access.

7. SMS
   - stav aktivácie,
   - odosielateľ,
   - šablóny,
   - 2-way inbox neskôr.

## Operator Screen Later

1. Horná call lišta ostane všade.
2. Nový `Call Center` modul:
   - live hovory,
   - čakajúci v radoch,
   - operátori/klapky,
   - missed/abandoned callback inbox,
   - CDR log,
   - nahrávky/transcripty podľa oprávnení.
3. V dispečingu:
   - call popover pri prichádzajúcom hovore,
   - nájdený klient/vozidlo podľa čísla,
   - akcie `Nový prípad`, `Priradiť ku prípadu`, `Informačný hovor`, `Callback`.

## What We Need From Client/VIPTel

- REST API username/password.
- WebSocket username/password.
- Aktivované REST API.
- Aktivované WebSocket API.
- Povolená outbound IP workeru.
- Zoznam čísel, radov a klapiek v pilote.
- Či má byť povolené mazanie nahrávok cez API.
- Retencia nahrávok a právne pravidlá.
- Aktivované SMS API.
- SMS API username/password.
- Povolená SMS `from_identity` z `GET /identities/` alebo povolené VIPTel číslo v tvare `00421...`.
- Kredit alebo potvrdený fakturačný režim bez kreditu.
- Testovacie telefónne číslo na bezpečný live send.
- SMS-specific limity, sandbox/live režim a pravidlá textu pre diakritiku/interpunkciu/segmenty.
- Webhook nastavenie a auth token/Basic Auth údaje, ak chceme testovať 2-way SMS.

## Live Verification 2026-06-05

Overené z vývojovej siete bez spustenia reálneho hovoru:

- REST `https://pbxmanager.viptel.sk/api/extension` vracia `200`.
- REST `https://pbxmanager.viptel.sk/api/extension/outbounds` vracia `200`.
- Klapka `10` existuje ako `Miso`, je registrovaná a má outbound CID `0412289133`.
- Povolené outbound čísla sú vo VIPTel normalizované do medzinárodného tvaru, napr. `0412289133` sa porovnáva ako `421412289133`.
- WebSocket `wss://pbxwssv1.viptel.sk:8088/` vráti nonce a login odpovie `202 Login successfull`.
- WebSocket `wss://pbxwssv1.viptel.sk/` bez portu z tejto siete zlyhal.
- WebSocket `wss://pbxmanager.viptel.sk:8088/` z tejto siete zlyhal.
- Po úspešnom WebSocket login smoke listener prijal `503 Unable to connect to PBX` a následne `110 Closing connection, bye`; toto treba preveriť u VIPTel, lebo autentifikácia už prešla.

Reprodukovateľné príkazy:

```bash
VIPTEL_REST_BASE_URL=https://pbxmanager.viptel.sk/ \
VIPTEL_WEBSOCKET_URLS=wss://pbxwssv1.viptel.sk/,wss://pbxwssv1.viptel.sk:8088/,wss://pbxmanager.viptel.sk:8088/ \
VIPTEL_DEFAULT_EXTENSION=10 \
VIPTEL_CALLER_ID=0412289133 \
pnpm viptel:probe -- --json
```

```bash
VIPTEL_WEBSOCKET_URL=wss://pbxwssv1.viptel.sk:8088/ \
VIPTEL_DEFAULT_EXTENSION=10 \
VIPTEL_CALLER_ID=0412289133 \
VIPTEL_LISTEN_MS=30000 \
pnpm viptel:listen
```

Credentials patria iba do serverového prostredia alebo lokálnych env premenných, nikdy nie do browser kódu ani repozitára.

## SMS Verification

Bezpečný smoke test po doplnení iba SMS mena a hesla:

```bash
VIPTEL_SMS_USERNAME=... VIPTEL_SMS_PASSWORD=... pnpm viptel:sms-probe -- --json
```

Toto overí Basic Auth, `GET /identities/` a `GET /credits/`. Neodošle žiadnu SMS.

Ručný live send spúšťať až po potvrdení kreditu, test čísla a odosielateľskej identity:

```bash
VIPTEL_SMS_USERNAME=... VIPTEL_SMS_PASSWORD=... \
VIPTEL_SMS_FROM_IDENTITY=... VIPTEL_SMS_TEST_MSISDN=00421... \
VIPTEL_SMS_LIVE_SENDS=true pnpm viptel:sms-probe -- --send-test
```

### Live SMS Verification 2026-06-11

Overené s reálnymi SMS API credentials bez uloženia secretov do repozitára:

- `GET /identities/` -> `200`, vrátených 6 identít.
- `GET /credits/` -> `200`, `credit=false`.
- `GET /messages/?limit=5` -> `200`, prázdna história `[]`.
- `POST /messages/` s bare ID `421412289133` -> `400 Validation failed`, detail `numeric identity has to be international format with leading zeros`.
- `POST /messages/` s každou vrátenou leading-zero identitou (`0018365`, `00421650951146`, `00421412289119`, `00421650951359`, `00421412289133`, `00421650951150`) -> `500 Error when creating objects`, detail `Sending SMS message forbidden`.
- Rovnaký forbidden výsledok bol cez Node `fetch` multipart form-data, URL-encoded form aj nízkoúrovňový `curl -F`, takže nejde o chybu nášho FormData klienta.
- `POST /messages/mass/` s jednou SMS neprešiel ako obchádzka; endpoint vrátil, že testované identity neexistujú.

Záver: autentifikácia a read endpointy sú funkčné, ale outbound SMS send je na strane VIPTel účtu/identity blokovaný alebo neaktivovaný. Potrebné je od VIPTel potvrdiť, že SMS API účet má povolené `POST /messages/` a ktorá `from_identity` je povolená pre outbound.

### Live SMS Verification 2026-06-12

Po spracovaní aktivácie na strane VIPTel prešiel live send:

- `GET /identities/` -> `200`, vrátených 6 identít.
- `GET /credits/` -> `200`, `credit=false`.
- `POST /messages/` s `from_identity=00421412289133`, `dest_msisdn=00421910988882` a test body `Test SMS Pomoc Motoristom 12.06.2026.` -> `201 Created`.
- Provider vrátil `hash_id=2fe50e846a8387f740bdb0cdea0e0ca9`, `transaction_key=b68a33039cc22b4cfbd1d386be7721ce`, `price=null`.
- `GET /messages/{hash_id}/` bezprostredne po odoslaní aj po krátkom opakovanom pollingu vrátil `status_code=203`, teda správa je prijatá/odovzdaná providerovi; nie je to ešte finálne doručenie `200`.
