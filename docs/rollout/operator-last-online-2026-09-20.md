# Posledné pripojenie operátorov

Karty operátorov v Ústredni namiesto počtu „dnes“ zobrazujú „Online teraz“ alebo „Naposledy pred 12 min / 2 h“. Počty a čas prijatých hovorov zostávajú v detaile. Ručne nastavená dostupnosť a jej dátum sú oddelené od pripojenia telefónu; vek `status_since` sa už nevydáva za nepretržitú online prítomnosť.

## Význam údajov

- Online znamená živý registrovaný webový alebo mobilný telefón v aktuálnom prostredí podľa existujúceho 120-sekundového limitu. Neznamená to evidenciu pracovného času.
- Posledné overené pripojenie sa zachováva v existujúcom serverom spravovanom `metadata.last_online_at`. Odhlásenie, prevzatie relácie či zmena prihlasovacích údajov ho nezmažú. Samotné vydanie tokenu nikdy nepredstavuje nové pripojenie.
- Chýbajúci historický údaj sa označí „Bez záznamu pripojenia“. Čas, ktorý staršia aplikácia pri odhlásení vymazala, sa spätne nevymýšľa; začne sa evidovať pri ďalšom potvrdenom pripojení.
- Dátový prehľad sa obnovuje každých 25 sekúnd; po 30 sekundách bez overenia zmizne tvrdenie o aktuálnom online stave. Pri riadnom odhlásení sa liveness zruší hneď, pri náhlom výpadku platí existujúce časové okno.
- Metadata a poverenia zariadenia zostávajú na serveri. Prenáša sa iba online stav a časy; údaje iného prostredia sa nezapočítajú.

## Kontroly

- Nové regresie pokrývajú web/mobil, odhlásenie, prevzatie a starú reláciu, obnovu tokenu, regeneráciu údajov, pomalé odpojenie a súbežné heartbeat zápisy. Porovnanie a opakované načítanie chránia novšiu reláciu aj ostatné metadata.
- Celý Vitest: 4 184 úspešných, 2 preskočené. Node: 43 úspešných, 1 preskočený. Typecheck a build prešli; lint bez chýb, štyri existujúce upozornenia.
- Chromium: 13/13 úspešných kontrol. Nové karty s ôsmimi operátormi, všetky detaily pri 1440/1280/390/640 px vrátane výšky 300 px, vypršanie údajov a regresie celej Ústredne. Názvy sa neskracujú, detail zostáva v obrazovke. Pri 1280×800 s ôsmimi operátormi a tromi lištami zostáva päť úplných riadkov histórie.
- Nezávislá architektonická kontrola schválila časové, prístupové a súbežné kontrakty. Testy používajú izolované zariadenia a provider mocky; nevykonávali sa živé telefonáty ani umelé heartbeat zápisy na produkcii.

Úprava nevyžaduje migráciu, seed ani zmenu smerovania. Nasadenie prechádza pracovným Preview, dev a PR dev→main; konkrétne SHA/deploymenty a výsledky sú v PR a `.context/operator-release-evidence.json`.
