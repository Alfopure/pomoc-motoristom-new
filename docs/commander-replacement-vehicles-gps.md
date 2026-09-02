# Commander GPS Pre Náhradné Vozidlá

## Rozdelenie Zdrojov

- WebDispečink je GPS zdroj pre odťahové vozidlá.
- Commander je GPS a katalógový zdroj pre náhradné vozidlá.
- Commander záznamy sa neimportujú automaticky do `motorist_fleet_assets`.
- Hlavná mapa pracuje iba s našimi business vozidlami v `motorist_fleet_assets`.

## DB Model

- `motorist_external_vehicle_records`: externý katalóg vozidiel zo zdrojov ako Commander. Pri Commanderi drží `source_provider = 'commander'`, externé ID, EČV/VIN, label, make/model a posledný raw snapshot.
- `motorist_fleet_asset_links`: manuálne rozhodnutie medzi externým vozidlom a naším fleet assetom. Commander link na mapu platí iba pri `link_status = 'confirmed'`.
- `motorist_fleet_current_positions`: posledná GPS poloha z externého zdroja. GPS freshness sa berie z `gps_time`, nie z business stavu assetu.

## Pravidlá Párovania

- Commander vozidlo sa páruje iba v module Flotila/Stav vozidiel v sekcii `Napojenia GPS`.
- Ručné párovanie vytvorí alebo upraví `motorist_fleet_asset_links`:
  - `source_provider = 'commander'`
  - `link_status = 'confirmed'`
  - `match_method = 'manual'`
- Import z Commanderu vytvorí nové `motorist_fleet_assets` s:
  - `kind = 'replacement_car'`
  - `status = 'available'`
  - základnými údajmi z Commanderu
  - GPS zdrojom riešeným cez Commander current position
- Zamietnutie nespárovaného Commander záznamu sa zapisuje ako rejected link bez `fleet_asset_id`.

## Pravidlá Mapy

- Mapa zobrazuje iba `motorist_fleet_assets`.
- Odťahové vozidlá používajú WebDispečink GPS.
- Náhradné vozidlá používajú Commander GPS iba po potvrdenom Commander linku alebo po importe.
- Nespárované Commander vozidlá sa nezobrazujú na hlavnej mape.
- Marker detail obsahuje typ vozidla, business stav, GPS zdroj, GPS čas, rýchlosť a freshness.
- Mapové filtre podporujú typ vozidla, status, GPS zdroj a freshness: live, stale, bez GPS.

## Commander Nesmie Prepísať

Commander synchronizácia a párovanie nesmie prepísať:

- business status
- obsadenosť
- prenájom
- rezerváciu
- doklady
- servisný stav

Commander môže meniť iba externý katalóg, linky a GPS polohu v `motorist_fleet_current_positions`.

## Refresh A Retencia

- Commander sync sa má spúšťať približne každých 5 minút.
- UI freshness prah je 10 minút.
- `motorist_fleet_current_positions` drží iba poslednú polohu na externé vozidlo.
- `motorist_fleet_position_samples` je história vzoriek na audit, reporty a neskoršiu knihu jázd.
- Retencia vzoriek má byť minimálne 90 dní; pre vlastnú knihu jázd a daňové/reporting účely odporúčame 24 mesiacov alebo klientsky nastaviteľnú retenciu.

## Kniha Jázd

Základ pre vlastnú knihu jázd je `motorist_fleet_position_samples` a neskôr `motorist_fleet_trips`.

- Najprv zbierame vzorky a aktuálne polohy.
- Následne môžeme odvodiť jazdy podľa pohybu, ignition/odometra a časových medzier.
- Ručné párovanie určuje, ku ktorému náhradnému vozidlu sa jazda priradí.
- Business stav prenájmu alebo rezervácie zostáva mimo Commander syncu a iba sa nad dátami koreluje.
