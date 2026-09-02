# Domain Model

## Core entities

- `DispatchCase`: interné číslo prípadu, stav, priorita, zdroj, typ služby, vlastník, kontakt, vozidlo, pickup, cieľ, odporúčaná/priradená technika, poznámka, ďalší krok, úlohy a timeline.
- `DispatchCall`: prichádzajúci/odchádzajúci hovor, číslo volajúceho, volaná linka, stav hovoru a krátka história čísla.
- `Vehicle`: EČV, značka, model, kategória, pojazdnosť, problém a špecifiká ako garáž, 4x4 alebo blokované kolesá.
- `DispatchLocation`: pickup, destination, branch, tow alebo replacement-car bod s adresou a GPS súradnicami.
- `FleetAsset`: odťahovka alebo náhradné vozidlo so stavom, EČV, VIN, značkou/modelom, kategóriou, hmotnosťou, pobočkou, poslednou polohou, dokladmi, obsadením a operačnou poznámkou.
- `PriceRule`: demo cenníkový režim pre samoplatcu, AVP alebo Europe Assistance.

## Statusy

Statusy prípadu vychádzajú z KB: `new`, `triage`, `open`, `waiting_for_client`, `scheduled`, `assigned`, `dispatched`, `in_progress`, `waiting_for_docs`, `completed_assisted`, `completed_no_assistance`, `rejected`, `cancelled`, `futile_trip`.

Statusy hovorov vo v1: `incoming`, `ringing_agent`, `answered`, `missed`, `outbound`, `ended`.

Statusy operátorov vo v1: `available`, `ringing`, `on_call`, `after_call_work`, `working_case`, `paused`, `offline`.

Statusy flotily vo v1: `available`, `reserved`, `rented`, `assigned`, `busy`, `service`, `offline`.

Kategórie odťahoviek vo v1: osobné vozidlá, dodávky, špecializované a kamiónové/ťažké. Schopnosti sa ukladajú ako štítky, napríklad navijak, nízka garáž, dodávky, kamióny, nepojazdné alebo havarované vozidlá.

Náhradné vozidlá podporujú iba jednoduché obsadenie: od, do, typ obsadenia a poznámku/prípad. Odovzdávacie protokoly, batéria, palivo, poškodenia, fotky a podpisy sú mimo scope tejto aplikácie.

## Mock data traceability

- `PM-2026-0517`: klientsky hovor na `0850 005 006`, nehoda, odťah + náhradné vozidlo, Bratislava ako najbližšia pobočka podľa pickup bodu a Žilina 01 ako dostupná odťahová kapacita.
- `PM-2026-0516`: asistenčný prípad Europe Assistance s problémom garáže `-2`, podľa rizík a príkladov v KB.
- `PM-2026-0514`: partnerské dealerstvo a náhradná mobilita, podľa budúceho dealer/servis kanála v KB.
- Cenníky `Samoplatca`, `Europe Assistance`, `AVP` sú demo pravidlá odvodené zo sekcie mapy/routing/kalkulácie.
- SMS template je iba preview a používa lokalizačný link, ETA a upozornenie, že ide o demo bez odpovede.

## Write workflow v1

- `POST /api/cases` vytvorí kontakt, vozidlo, pickup/cieľ location, prípad, prvý timeline event a úlohu `Potvrdiť ETA klientovi`.
- `PATCH /api/cases/:id/assign` nastaví prípad na `assigned`, uloží `selected_asset_id`, prepne fleet asset na `assigned`, zapíše timeline event a pripraví úlohu `Poslať lokalizačnú SMS`.
- `POST /api/fleet-assets` vytvorí odťahovku alebo náhradné vozidlo vrátane dokladov, kategórie, schopností a pobočky.
- `PATCH /api/fleet-assets/:id` upraví stav, doklady, obsadenie, pobočku, aktuálnu polohu a praktické identifikačné údaje vozidla.
- Browser nepíše priamo do Supabase; všetky mutácie idú cez server route handlery so server-only Supabase kľúčom.
