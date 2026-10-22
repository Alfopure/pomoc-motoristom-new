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
