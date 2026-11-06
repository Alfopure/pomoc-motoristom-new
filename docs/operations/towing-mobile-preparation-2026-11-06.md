# Príprava vlastných odťahov, mobilnej kancelárie a Inej hotovosti

**Aktualizácia nasadenia 6. 11. 2026:** majiteľ následne určil poradie web/databáza TEST → testovacia mobilná aplikácia → produkčné vydanie. Automatické release kontroly preto už prebehli: 11 433 webových Vitest kontrol, 93 Node kontrol, 101 prehliadačových kontrol, 1 482 mobilných kontrol a 29 izolovaných PostgreSQL kontrol prešli. Závislosti Expo 57 sa zosúladili jedenástimi odporúčanými patch aktualizáciami bez nového SDK alebo nových priamych závislostí; online kontrola kompatibility a exporty prešli.

Obe nižšie uvedené migrácie sa aplikovali **iba na TEST `nzpnqdstvkfncflgqlny`**. Evidované verzie: `20261106074613` (`towing_self_creation_and_mobile_office`) a `20261106074624` (`towing_cash_category_custody`). Odlišujú sa od časových prefixov súborov, preto ich neaplikovať znova podľa samotného timestampu. Následná kontrola potvrdila service-role-only RPC a nulové rozdiely medzi celkovým a kategorizovaným zostatkom/rezerváciami na všetkých troch existujúcich hotovostných účtoch. Bezpečnostné odporúčania sa nezmenili; výkonový advisor pridal iba informačný záznam zatiaľ nepoužitého nového indexu autora zákazky. Konkrétny deploy commit a mobilný build sa evidujú v odovzdaní release PR. Produkčná databáza sa nemenila.

Táto dodávka je príprava podľa zadania majiteľa z 6. 11. 2026. Funkčné testy a skúšky telefónov sú výslovne odložené. Lokálna kontrola typov, lint a zostavenie sa uvádzajú osobitne; nenahrádzajú prijatie funkcie ani aplikovanie databázových zmien.

## Výsledné používanie

- Odťahovkár má v **Mojej práci / Mojich odťahoch** akciu **Nový odťah**. Založí iba vlastnú zákazku, vyplní objednávateľa, kontakt, vozidlo, trasu, pobočku, techniku, úkony a dohodnutú úhradu. Po vytvorení používa existujúce realizačné údaje, fotky, platby a odovzdanie kancelárii.
- Pristavovač bez odťahovej roly vlastný odťah nevytvorí. Kombinované roly získajú jednotlivé možnosti podľa overených oprávnení.
- Odťahový dispečer má samostatnú **Knihu odťahov** vo webovej aj mobilnej aplikácii, bez potreby hlavného dispečerského profilu. Môže založiť a prideliť zákazku alebo doplniť už vykonaný zásah so skutočnými časmi. Historický záznam sa nepovažuje za novú jazdu.
- **B peniaze = Iná hotovosť (bez faktúry)** podľa výslovného vysvetlenia majiteľa. Je to skutočný evidovaný príjem držaný vodičom do prevzatia Erosom alebo oprávnenou kanceláriou. Kategória sa uloží na potvrdenku; neskoršia úprava dohody zákazky ju neprepíše.
- Majiteľ vidí hotovosť podľa vodičov, z toho Inú hotovosť, rezervované odovzdania a dostupné sumy. Potvrdí návrh vodiča alebo zapíše skutočné priame prevzatie. Prevzatie je presun držby v existujúcom denníku, nie ďalšia zákaznícka platba. Staré nerozlíšené peniaze zostanú označené ako historicky nerozlíšené.

Kancelárske ceny, faktúry a správa peňazí zostávajú viazané na konkrétne oprávnenia. Odťahový dispečer s `operate` automaticky nezískava `cash` alebo `bill`; majiteľova rola `manager` ich už obsahuje. Automatické PZP, Braňo, digitálny podpis a automatický e-mail servisu sa nemenia.

## Presný databázový rozsah pripravený na následné nasadenie

Cieľ následnej TEST dodávky: **Supabase `nzpnqdstvkfncflgqlny`**, web **https://test.dispecing.linkapomoci.sk**. Táto príprava nevykonáva vzdialené SQL ani publikáciu.

1. `20261106070058_towing_self_creation_and_mobile_office.sql` — pôvod vytvorenia existujúcej zákazky, úzke atómové vytvorenie pre seba/kanceláriu, vlastné pridelenie, historické zadanie, prevádzkové polia a katalógy.
2. `20261106070113_towing_cash_category_custody.sql` — kategória potvrdenky, rozpis hotovostných pohybov/odovzdaní, kategorizované zostatky a priame prevzatie v existujúcom finančnom toku.

Príkazy overujú členstvo, organizáciu, oprávnenie, revízie a identitu pokusu. Nové privilegované RPC nemá prístup pre `anon`/`authenticated`. Nové metadáta neprepisujú pôvodné finančné sumy. Staré NULL metadáta sa interpretujú ako nerozlíšené; stará história zostáva nemenná.

Pred aplikovaním porovnať konkrétne definície a migračnú evidenciu TEST; neaplikovať plošne staré migrácie a neopakovať sedem predchádzajúcich migrácií uvedených v [predošlom odovzdaní](client-eros-test-2026-11-05.md). Žiadne produkčné SQL, seed, ďalší cron ani provider zmeny nepatria do tejto prípravy.

## Chýbajúce skutočné katalógové údaje

Posledná read-only kontrola TEST pre Pomoc Motoristom našla **3 odťahové vozidlá**, **2 aktívne pobočky** a **0 parkovísk**. Katalóg obsahuje tiež 304 náhradných áut; tie sa vo výbere odťahovej techniky neponúkajú. Existujúce názvy techniky: `BT583EV`, `Odťah Bratislava 02`, `Odťah Žilina 01`. Existujúce pobočky: `Žilina - Tolstého`, `Bratislava - západ`. Tieto zistenia nie sú tvrdením o produkčnej databáze.

Eros požaduje nasledujúce pomenované položky; názov sám ešte nepotvrdzuje zhodu s existujúcim ID:

| Technika | Stav prípravy |
| --- | --- |
| Iveco Daily žlté | Porovnať existujúce ID/EČV. |
| Iveco Daily červené | Porovnať existujúce ID/EČV. |
| Renault Master dvojkabína | Porovnať existujúce ID/EČV. |
| MB Atego | Porovnať existujúce ID/EČV. |
| MAN 16 t starý | Porovnať existujúce ID/EČV. |
| MAN s rukou 18 t nový | Porovnať existujúce ID/EČV. |
| MAN 12 t malý | Porovnať existujúce ID/EČV. |
| Iveco špeciál | Porovnať existujúce ID/EČV. |
| MB Actros 26 t | Porovnať existujúce ID/EČV. |
| Fuso čierne | Porovnať existujúce ID/EČV. |
| Citroën Jumper | Porovnať existujúce ID/EČV. |
| Fuso žlté dvojkabína | Porovnať existujúce ID/EČV. |
| DAF XB | Porovnať existujúce ID/EČV. |
| Audi Q7 | Porovnať existujúce ID/EČV. |
| VW Touareg | Porovnať existujúce ID/EČV. |
| SUV + vozík | Určiť konkrétnu evidovanú súpravu. |

Pobočky zo zadania: Bratislava, Žilina, Považská Bystrica, Prešov, Zvolen. Parkovanie: Prešov, Zvolen, Žilina, Bratislava Dúbravka, Bratislava Zlaté piesky. Celé adresy, EČV a jednoznačné priradenie sa z podkladu nedajú spoľahlivo doplniť. Existujúce položky sa nesmú zdvojiť len pre odlišný názov. Na prípravu poslúži dnešná administrácia; nie druhá databáza techniky.

## Mobilný build a následné odovzdanie

Použiť existujúci EAS profil `test`, prípadne `test-simulator` pre simulátor. API musí pred používaním nových akcií obsahovať vyššie uvedený kód a migrácie. Natívne OTA sú vypnuté; webové nasadenie nezmení nainštalovanú binárku. Príprava JavaScriptového exportu neznamená vydaný inštalačný klient.

Pred fyzickým prijatím nadviazať na zdokumentovaný online Expo compatibility krok v [predošlej dodávke](client-eros-test-2026-11-05.md). Závislosti sa touto funkciou nepridávajú ani neaktualizujú. Použiť existujúce PR/build ochrany; odloženie funkčného skúšania nepovoľuje ich obchádzanie alebo označenie neoverenej funkcie za prijatú.

Následné prijatie zahŕňa vlastný odťah vodiča, samostatný odťahový dispečerský účet, spätný zápis, opakovanie vytvorenia/platby, fotografie, presný rozpis držby hotovosti a fyzické prevzatie od vodiča. Výsledky sa zaznamenajú až po skutočnom vykonaní.

## Vykonané statické kontroly tejto prípravy

- Webový aj mobilný TypeScript prešli.
- ESLint všetkých zmenených webových zdrojov a mobilnej pracovnej časti/shellu prešiel bez chýb; vo webovom dispečingu zostávajú dve pôvodné upozornenia na internú navigáciu cez `location.assign`.
- Produkčné zostavenie webu `pnpm build` prešlo.
- Expo export existujúcich zamknutých závislostí pre iOS, Android a web prešiel v TEST variante. Ide o JavaScript/Hermes balíky, nie podpísaný APK/IPA alebo vydaný inštalačný klient.
- Nezávislá kontrola kódu uzavrela nálezy vrátane obnovy poškodeného/neistého konceptu, opakovaného kliknutia pri vytváraní, parkoviska hlavného uloženia, spätných príjmov a presného rozdelenia hotovosti.
- `git diff --check` je čistý. Funkčné testy, vykonanie migrácií, nasadený tok a fyzické zariadenia sa v tejto etape neoverovali.

Natívna kancelária pri fotografiách/PDF ponúka označený prechod do existujúcej webovej kancelárie na konkrétnu zákazku; nevytvára sa nový natívny kancelársky upload. Prehliadač môže vyžadovať prihlásenie; overený identifikátor zákazky sa pri ňom zachová. Odťahovkár naďalej nahráva fotografie vo svojej existujúcej natívnej karte.
