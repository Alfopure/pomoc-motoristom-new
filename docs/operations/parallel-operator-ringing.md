# Súčasné vyzváňanie webu a mobilu operátora

Majiteľ 2026-10-01 po lokálnom overení autorizoval nasadenie aplikácie a potrebnej migrácie najprv do samostatného TEST prostredia. Produkčné nasadenie ani produkčná migrácia nie sú súčasťou tejto autorizácie. Výsledok živého hlasového testu sa musí overiť samostatne; lokálne testy ho nenahrádzajú.

## Správanie

Skupina so stratégiou `all` môže obsahovať webového operátora aj jeho vlastné mobilné číslo ako samostatného člena. Mobil musí mať explicitného vlastníka alebo sa jednoznačne zhodovať s osobným číslom operátora. Takto nastavené dostupné zariadenia zvonia súčasne, s jednou spoločnou rezerváciou operátora. Samotné uloženie osobného mobilu nepridáva nové volanie; rešpektuje sa nastavenie členov skupiny a existujúci režim doručenia.

- Každé zariadenie má vlastný pokus a stabilný identifikátor provider príkazu.
- Prvé úspešne prijaté zdvihnutie vyberie konkrétnu vetvu hovoru. Ostatné zvonenia sa ukončia; oneskorená odpoveď ani zavesenie druhého zariadenia nesmie odpojiť víťaza.
- Odmietnutie alebo nedostupnosť jedného zariadenia ponechá ostatné dostupné zariadenia zvoniť. Neznámy výsledok odoslania sa nesmie naslepo zopakovať.
- Rezervácia sa uvoľní až po skončení všetkých príslušných ponúk. Iný volajúci nemôže súčasne obsadiť druhé zariadenie toho istého operátora.
- Pauza a ukončenie zákazníckeho hovoru rušia obe zariadenia. Operátor sa v zozname zvoniacich zobrazuje raz.
- Limity počtu vetiev a fanoutu počítajú každé zariadenie samostatne. Skupiny `ordered` zostávajú postupné podľa poradia jednotlivých cieľov.

## Databáza a kompatibilita

Pripravená migrácia: `supabase/migrations/20261008130300_parallel_operator_ring_endpoints.sql`.

Migrácia nahrádza unikátny pokus podľa profilu samostatnými unikátnymi cieľmi a GiST exclusion obmedzením. Viaceré zariadenia jedného profilu smú mať otvorenú ponuku pre tú istú reláciu; ponuky pre rôzne relácie sa navzájom vylučujú aj pri súbežných transakciách. Používa rozšírenie `btree_gist`; zmena indexov prebehne v jednej transakcii a neprepisuje existujúce riadky.

Kompatibilný nový kód pred aplikovaním migrácie bezpečne prijme iba jeden cieľ podľa existujúcich obmedzení. Po migrácii už starší kód s aktualizáciami pokusov iba podľa profilu nie je bezpečný pre súčasné ponuky. Staré buildy sa nesmú použiť na rollback ani ako aktívne alternatívne webhook/cron vstupy.

Staré uložené fanouty s kolidujúcimi identifikátormi sa opravujú iba po kontrole journalu. Preukázaná absencia pôvodného príkazu umožní oddeliť ešte neodoslané ciele a uložiť ich pred odoslaním. Ak už journal obsahuje pôvodný príkaz, zachová sa jeho presný cieľ a nemenný payload. Prípadný neodoslaný konfliktný pokus možno ukončiť iba bez pripojenej vetvy a bez dial intentu pre jeho cieľ.

## Nasadenie a overenie

1. Dodržať workflow pracovná vetva → Preview → PR do `dev` → overenie stabilného TEST. Produkcia iba cez PR `dev` → `main`.
2. Najprv nasadiť kompatibilný aplikačný kód. Pred migráciou dokončiť aktívne hovory a preveriť, že žiadny starší build už nespracúva hovory, webhooky alebo cron.
3. V tejto úlohe je autorizovaný iba TEST `nzpnqdstvkfncflgqlny`. Produkcia `ifpaeegaesdmljfkdvcn` vyžaduje samostatný explicitný pokyn na migráciu.
   Po overení schémy musí samostatný TEST build používať `TELEPHONY_STABILITY_V1_ENABLED=true`, aby konfigurácia dovolila explicitné priradenie osobného mobilu. Verziu zápisového kontraktu nových relácií riadi databázový `motorist_telephony_writer_rollout.new_session_contract=2`; premenná `TELEPHONY_FENCING_V2_ENABLED` sa v aktuálnom kóde nepoužíva. Zapnutie stability samo nepovoľuje živé volania; aktivácia TEST linky a provider ochrany sa overujú osobitne. Unit testy musia mať vlastný základný režim a zapínať tieto funkcie explicitne, nezávisle od premenných nasadenia.
4. Pri schválenom živom overení použiť iba povolené testovacie čísla. Overiť skutočné zvonenie oboch zariadení, zvuk pri zdvihnutí na každom z nich a zastavenie druhého zariadenia. Lokálna simulácia nepreukazuje živé audio ani dostupnosť mobilnej siete.
5. Pri probléme zostať na kompatibilnom kóde; pozastaviť nové duálne ponuky úpravou autorizovaného routingu. Neobnovovať starý build s rozpracovanými duálnymi ponukami a nerepublikovať historický deployment.

## Lokálne overenie

Workflow testy pokrývajú obe víťazné zariadenia, súbežné odpovede, neskoré udalosti porazeného zariadenia, odmietnutie, pauzu, zákaznícke zavesenie, spoločný token, neznáme výsledky a opakovanie uloženého fanoutu bez duplicitných volaní. Samostatný test používa reálny HTTP adaptér s falošným transportom a kontroluje atomické odmietnutie kolidujúceho batchu pred HTTP.

`python3 tests/postgres/parallel-ring-endpoints.py` overuje presnú migráciu v izolovanej lokálnej PostgreSQL databáze vrátane skutočných súbežných transakcií, čakania na zámok, commitu/rollbacku, spoločného tokenu a zrušenia oboch ponúk. Nevstupuje do hostovaných databáz.
