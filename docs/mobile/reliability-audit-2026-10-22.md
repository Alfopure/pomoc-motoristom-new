# Spoľahlivosť mobilnej aplikácie – 22. 10. 2026

## Východiskový stav

Majiteľ 22. 10. potvrdil, že sa pri ďalších skúškach dovolal aj cez zamknutý
mobil. Je to fyzický dôkaz úspešného hovoru pri zamknutí, nie automatické
potvrdenie všetkých kombinácií zvuku, sietí, prepojenia a polohy.

- TestFlight: Dispatching TEST 0.1.0 (18), zdroj `47882b1a`, OTA vypnuté.
- Stabilný TEST pri začiatku auditu: `dev` `0ef3445d`, deployment
  `dpl_NRTHNcMpBhfVivDv2QyqTGaRGJiz`, správny dedikovaný projekt vo Frankfurte.
- Serverové opravy #489–#491 podporujú identifikátory iOS SDK a párujú ponuku
  podľa skutočnej vetvy hovoru doručenej do telefónu. Logy po #491 obsahujú
  úspešné autorizácie; staršie opakované `native_offer_pending` patria
  predchádzajúcemu nasadeniu.
- Východiskové mobilné testy: 77 súborov, 1 228 úspešných testov.
- Produkcia a jej konfigurácia nie sú súčasťou tohto vydania. Audit nevyžaduje
  migráciu, nový plánovač ani zásah do poskytovateľa telefonovania.

## Plán a kritériá dokončenia

| Priorita | Zistenie | Oprava a overenie |
| --- | --- | --- |
| 1 | Prvé obnovenie telefónu pri výpadku servera nemá token; automatická obnova preto nemá z čoho pokračovať. | Pamätať zámer pripojiť telefón; obmedzené opakovania iba pri obnoviteľnej chybe, bez prevzatia cudzieho zariadenia, bez zásahu do hovoru a bez opätovného zapnutia odpojeného telefónu. |
| 1 | Notifikácie ukazujú staré systémové povolenie počas šesťhodinového intervalu registrácie. | Overovať povolenie pri každom návrate, registráciu naďalej obnovovať zriedka. Test povolenia zmeneného v Nastaveniach. |
| 1 | Odhlásenie počas čakania na push token môže dovoliť odoslanie novej registrácie po odhlásení. | Zastaviť ešte neodoslanú registráciu po odhlásení alebo zániku relácie. Test oneskoreného tokenu. |
| 1 | Nové polohy a potvrdené časti veľkej dávky sa ukladajú až po sieťových operáciách. | Najprv uložiť čakajúce polohy, po každom potvrdení uložiť zvyšok; výpadok alebo prerušenie nesmie zahodiť nové polohy. |
| 1 | Pri prechode na iné pristavenie môže po zlyhaní vydania kľúča pokračovať staré sledovanie. | Ukončiť predchádzajúce sledovanie pred zmenou rozsahu; overiť člena, prostredie a server aj pri obnove. |
| 2 | Rozpracované spustenie polohy môže dobehnúť po zániku obrazovky alebo zmene člena. | Zrušiť iba rozpracovaný štart; už bežiace zdieľanie musí ďalej fungovať na pozadí. |
| 2 | Dokument pripravenosti mieša historické a aktuálne stavy. | Označiť aktuálny stav a fyzické potvrdenie majiteľa; zachovať otvorené akceptačné body. |
| 1 | Pri chybe obnovy mohol detail/zoznam pristavení ďalej zobrazovať zákaznícke údaje z cache aj po strate prístupu alebo vypršaní. | Pri odmietnutí skryť cache, pri výpadku ukázať posledný stav s chybou; vypršanie lokálne odstráni zákazníka aj GPS bez čakania na sieť. |

Každá oprava musí mať regresný dôkaz konkrétneho zlyhania. Potom úplné mobilné
testy, typy, lint a export, existujúca serverová brána cez Preview PR do `dev`,
kontrola stabilného TEST nasadenia a nový identifikovaný TestFlight build,
pokiaľ je dostupná build kapacita.

## Implementované a overené

Všetky opravy z tabuľky sú v tomto vydaní implementované. Pridaných je 19
regresných prípadov; pri prvom spustení pred opravami 11 z nich preukázalo
zlyhanie, ostatné chránia hranice opravy. Celý mobilný balík má 1 247
úspešných testov, kontrola typov a lint prešli. Serverový balík prešiel
8 423 testami Vitest a 76 kontrolami Node (zámerne vynechané testy zostávajú
vynechané). iOS export skompiloval skutočný vstup aplikácie.

Prehliadačová skúška skutočnej aplikácie so syntetickým API na šírkach 390
a 320 b overila šesť scenárov: dočasný výpadok s posledným stavom a chybou,
odobratie prístupu v detaile/zozname/Prehľade a lokálne vypršanie bez
úspešného obnovenia. Nejde o dôkaz natívneho zvuku ani Apple Maps.

Serverový kód, SQL a konfigurácia poskytovateľov sa nemenia. Pri
vydaní treba identifikovať nový `dev` commit a samostatne TestFlight build;
build 18 tieto opravy JavaScriptu ešte neobsahuje.

Kontrola CI zachytila aj novú požiadavku Expo z 22. 10.:
`expo-notifications` 57.0.23 už nevyhovoval odporúčanej verzii 57.0.24.
Balík aj lockfile sú zosúladené; `expo install --check` opäť prechádza.
Táto oprava zachováva Expo SDK 57 a existujúci spôsob doručovania.

## Ďalšie kroky pred každodennou prevádzkou

1. Na novom TestFlight builde zopakovať zamknutý príjem, obojsmerný zvuk,
   prechod Wi-Fi/mobilné dáta, návrat po výpadku, odmietnutie a zavesenie,
   podržanie/obnovenie, prepojenie na kolegu a zastavenie nahrávania.
2. Overiť reálne doručenie bežnej push notifikácie a otvorenie jej cieľa,
   následne odhlásenie a prihlásenie iného účtu na tom istom zariadení.
3. Pristavenie: prijatie, pohyb so zamknutým mobilom, návrat signálu,
   dokončenie alebo zrušenie a zastavenie polohy. Overiť obidva pohľady.
4. Pred produkčným vydaním pripraviť presný rozdiel `main`/`dev`, katalógovo
   porovnať potrebné SQL objekty a získať schválenie konkrétneho vydania a SQL.
   Starý počet PR alebo rozdiel názvov migrácií nie je spoľahlivý zoznam.
5. Dokončiť produkčný build, účet pre Apple review a distribúciu podľa
   [podkladov App Store](app-store.md). Android hlas zostáva osobitná etapa.

Fyzické skúšky, ktoré agent nevykonal a majiteľ nepotvrdil, zostávajú otvorené.
Build, testy a zdravý server samy nepreukazujú funkčný zvuk ani pohyb telefónu.

## Zdrojový stav budúceho produkčného vydania

Read-only porovnanie 22. 10.: `main` `7ff4247c` oproti funkčnému TEST zdroju
`ecbe6d1a`. Na `main` nie je adresár `mobile` ani `/api/mobile/v1`; v TEST
zdroji majú spolu 311 súborov. Celý rozdiel vetiev zahŕňa 695 súborov, teda
aj ďalšie zmeny mimo dnešných opráv. Vydanie mobilu nemožno zameniť za
samostatné vydanie PR #492.

Voči `main` sú v Gite navyše tieto SQL súbory:

- `20261012183000_case_owner_assignment.sql`
- `20261013120000_towing_work_orders.sql`
- `20261020210000_mobile_push_devices.sql`
- `20261022100000_mobile_delivery_handoffs.sql`
- `20261022180000_mobile_delivery_background.sql`

Toto **nie je zoznam SQL na aplikovanie**. Stav produkčného katalógu sa v tomto
audite neporovnával; súbory môžu mať už aplikovaný ekvivalent a nie každá
pripravovaná funkcia musí byť súčasťou prvého produkčného vydania. Pred
schválením presného projektu a SQL porovnať konkrétne objekty aj ledger.
Žiadne produkčné SQL sa nevykonalo.

## Vydanie na TEST

- Opravy: PR #492, `dev` `ecbe6d1ac876156e01f92697f47da96c2bdd3685`.
- Stabilný TEST: https://test.dispecing.linkapomoci.sk, nasadenie
  `dpl_EBPqVgr53rZ6RsUWiwug35UWYDMz`; zdravie, Git SHA aj 115 HTTP kontrol prešli.
- iPhone: 0.1.0 (19), EAS `a0e05eed-cd26-4245-a635-d071fb262ebc`, ten istý
  zdroj; podpísaná IPA prešla kontrolou vrátane nových opráv v JavaScripte.
  Stav nahratia a spracovania v Apple sa overuje oddelene od výsledku buildu.
- Produkcia sa týmto vydaním nemenila. Nasledujúca úprava dokumentácie nemení
  mobilný kód ani zdroj nainštalovaného buildu.
