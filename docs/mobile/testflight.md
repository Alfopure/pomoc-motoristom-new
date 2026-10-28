# TestFlight — Dispatching TEST

Cieľ: TEST aplikácia v iPhone cez interný TestFlight, bez App Review. Je to TEST
variant (TEST server, TEST databáza, telefonovanie zapnuté v aplikácii, OTA vypnuté).
Produkčná aplikácia je samostatné vydanie so schválením majiteľa.

**Externé testovanie, 27. 10. 2026:** na výslovný pokyn majiteľa bol existujúci
build **0.1.0 (23)** odoslaný na Beta App Review. Apple ho schválil a o
**07:07 UTC** bolo priamym čítaním API overené `APPROVED`, `VALID` a externé
`IN_BETA_TESTING`. Build je priradený existujúcej skupine **Externí testeri TEST**;
verejný pozývací odkaz zostáva vypnutý. Review prihlásenie aj mobilné TEST API
boli overené, doplnený bol text Čo testovať. Nová binárka sa nezostavovala,
nepridávali sa noví testeri a produkčný App Store release sa neodosielal.
Pridanie ďalšieho testera do už schválenej beta verzie nepotrebuje nové
schvaľovanie buildu; tester prijme pozvánku a jeho aplikačný účet musí mať
požadované oprávnenia.

**Hlásený problém buildu 21 (23. 10. 2026):** na iOS 27 padá pri štarte,
pred načítaním JavaScriptu. TestFlight crash feedback ukazuje
`___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`.
Apple processing a kontrola podpisu tento runtime problém neodhalili.
Oprava v **builde 22** zapína oficiálne `expo-build-properties` 57.0.22
s `ios.enableSceneSupport=true`. Release simulátor iOS 27 už overil
viditeľné prihlásenie pri studenom štarte, návrate z pozadia a dvoch
reštartoch. Pôvodný lifecycle v kontrolnej verzii zopakoval presný pád.
Build 21 nepoužívať; OTA sú vypnuté, treba aktualizáciu cez TestFlight.

**Oprava doručená 23. 10. 2026 o 09:49 UTC:** TestFlight **0.1.0 (22)**
z `dev` `988a58901b28003201fac7ed166c7e4454594067`. Apple potvrdil
`COMPLETE`, `VALID`, `IN_BETA_TESTING` a dostupnosť v skupine Team (Expo).
Podpis, natívne scenáre, artefakty a neoverené skúšky sú v
[zázname buildu 22](#build-22--oprava-pádu-pri-štarte-na-ios-27).
Žiadosť o externé beta schválenie sa týmto neodoslala.

**Mobilná fáza 1, 24. 10. 2026:** build **0.1.0 (23)** zo zdroja
`f3926dc4` je podpísaný, prešiel 34 kontrolami IPA aj vizuálnym overením
štyroch scenárov štartu. Apple o **18:18 UTC** potvrdil `VALID`,
`IN_BETA_TESTING` a dostupnosť v existujúcej skupine Team (Expo).
Rozsah a dôkazy sú v
[zázname buildu 23](#build-23--mobilná-fáza-1).

## Stav prípravy (24. 10. 2026)

| Položka | Stav |
| --- | --- |
| Apple Developer Program, MICT s. r. o., tím `792TJPXTL3` | aktívne |
| App ID `sk.linkapomoci.dispecing.test` so schopnosťou Push Notifications | zaregistrované |
| Karta v App Store Connect „Dispatching TEST“, ID `6825741096`, SKU `dispatching-test` | vytvorená |
| Distribučný certifikát a App Store profil (push v režime production, platné do 22. 10. 2027) | pripravené mimo Gitu |
| Tímový App Store Connect API kľúč | pripravený mimo Gitu |
| EAS build a submit profil `testflight` | `mobile/eas.json` |
| APNs kľúč pre bežné notifikácie cez Expo (`QHWZM8VN44`, production, iba téma TEST aplikácie) | nahratý v Expo |
| VoIP Services certifikát `35S4MJY4Z3` (do 21. 11. 2027) a TEST Telnyx iOS push credential | pripojené na TEST credential connection |
| Prepínače `MOTORIST_NATIVE_VOICE_TEST_ENABLED` a `MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED` | zapnuté iba v dedikovanom TEST projekte (cieľ Production) |
| Prvý TestFlight build | 0.1.0 (17) z `dev` `03389c58` Apple odmietol (ITMS-90683: chýbal text pre pohyb) |
| Prvý úspešný TestFlight build | 0.1.0 (18) z `dev` `47882b1a`: interné testovanie od 22. 10. 2026 |
| Najnovší TestFlight build | **0.1.0 (23)** z `dev` `f3926dc4` (PR #507), lokálne cez Xcode 27.1: flotila do 1 000 vozidiel, Obnoviť prístupy a Uložiť a odovzdať. 34 kontrol IPA a čerstvé vizuálne overenie štyroch scenárov štartu prešli. Apple potvrdil `VALID`, `IN_BETA_TESTING` a prístup existujúcej internej skupiny. |
| Ďalšie opravy pristavení | [Obnova nepotvrdených krokov](delivery-recovery-2026-10-22.md) je zachovaná aj v builde 23. Build 19 ich neobsahuje; OTA je vypnuté. |
| Kapacita zostavenia | Free iOS cloud kapacita Expo je vyčerpaná (15/15). Plný Xcode aj potrebné nástroje sú na Macu pripravené; [lokálny postup](local-ios-build.md) kvótu cloudových buildov nepotrebuje. Platený plán nebol objednaný. |
| Interní testeri | skupina „Team (Expo)“ s prístupom ku všetkým buildom; držiteľ účtu pozvaný 22. 10. 2026 |

APNs kľúč, Telnyx push credential a prepínače sú mimo buildu; menia sa bez
nového buildu. Majiteľ 22. 10. potvrdil úspešné dovolanie aj pri zamknutom
mobile. Ostatné body fyzickej akceptácie ostávajú otvorené, kým ich samostatne
neoverí (pozri [aktuálny audit a plán](reliability-audit-2026-10-22.md)).

## Build

Profil `testflight` je `voice-test` s distribúciou `store` a podpisom
`credentialsSource: local`. Podpis číta EAS z `mobile/credentials.json`
(v `.gitignore`), ktorý odkazuje na App Store profil a distribučný certifikát
uložené mimo Gitu. Certifikát je v p12 so šifrovaním 3DES a MAC SHA-1, teda
v rovnakom formáte, aký vytvára EAS; novší formát OpenSSL 3 kľúčenka macOS
na build serveri nemusí prijať.

Build sa spúšťa iba z identifikovaného commitu `dev` v čistom klone; zapíše sa
build ID, commit a číslo buildu. Číslo zvyšuje EAS (vzdialené číslo pred prvým
buildom pre TestFlight bolo 16). Free plán Expo má 15 iOS buildov mesačne,
pred buildom 19 zostával 22. 10. 2026 jeden; ráta sa aj neúspešný build. Pred ďalším buildom znovu overiť limit v Expo.

```sh
cd mobile
npx eas-cli@24.12.1 build --platform ios --profile testflight --non-interactive --no-wait
```

Pred nahratím skontrolovať texty povolení. App Store Connect odmietne binárku,
ktorej pripojený kód siaha na citlivé rozhranie bez textu v Info.plist, aj keď ho
aplikácia nikdy nevyžiada (ITMS-90683). `expo-location` obsahuje Core Motion,
`expo-secure-store` Face ID a hlasový modul s WebRTC mikrofón. Test
`mobile/src/lib/ios-store-config.test.ts` ich vyžaduje vo všetkých buildoch. Stav
nahratia aj s chybami ukazuje App Store Connect API `GET /v1/apps/{id}/buildUploads`;
odmietnutý build sa v zozname buildov neobjaví.

Od 23. 10. je pripravený aj [lokálny build cez Xcode](local-ios-build.md).
Príkaz má rovnaký profil a pridáva `--local`; verzovanie zostáva vzdialené
v EAS. Pokus 20 zastal na chýbajúcom Apple WWDR G3 na čerstvom Macu,
po doplnení oficiálneho medziľahlého certifikátu prešiel build 21.

## Nahratie do TestFlightu

```sh
EXPO_ASC_API_KEY_PATH=… EXPO_ASC_KEY_ID=… EXPO_ASC_ISSUER_ID=… EXPO_APPLE_TEAM_ID=792TJPXTL3 \
  npx eas-cli@24.12.1 submit --platform ios --profile testflight --id <build-id> --non-interactive
```

- Cestu ku kľúču, jeho ID a Issuer ID dáva iba prostredie; nepatria do Gitu ani do logov.
- Pri prvom nahratí EAS vytvorí internú skupinu „Team (Expo)“ s prístupom ku
  všetkým buildom a pridá do nej administrátorov účtu (dnes držiteľ účtu).
- Apple build spracuje zvyčajne do pol hodiny; interný build platí 90 dní.
- Šifrovanie je vyriešené v builde (`ITSAppUsesNonExemptEncryption = false`).

## Inštalácia

1. V iPhone nainštalovať aplikáciu TestFlight a prihlásiť sa Apple ID, ktoré je
   v App Store Connect (držiteľ účtu).
2. Prijať pozvánku z e-mailu alebo otvoriť TestFlight a nainštalovať Dispatching TEST.
3. Prihlásiť sa TEST účtom, nie produkčným.

## Po inštalácii

- **Notifikácie:** TEST server ich posiela (`MOBILE_PUSH_ENABLED`) cez Expo,
  ktoré má APNs kľúč TEST aplikácie. Po prvom spustení aplikácia požiada
  o povolenie notifikácií; druhy sa zapínajú v Účte.
- **Telefonovanie:** v module Hovory pripojiť telefón (povolenie mikrofónu).
  Zvonenie pri zamknutom telefóne ide cez Telnyx VoIP push (certifikát
  `35S4MJY4Z3`, push credential na TEST spojení). Vypnutie a rollback sú
  v [iPhone TEST postupe](iphone-voice-test.md#rollback-a-hranice).
- **Akceptácia:** [hovory](iphone-voice-test.md#akceptácia-na-fyzickom-iphone)
  a pristavovač: prijatie, povolenie polohy „Vždy“, poloha na pozadí a pri
  zamknutom telefóne (modrý ukazovateľ), u dispečera „pred X min“, zastavenie
  po skončení pristavenia a pri odhlásení.

## Build 19 – opravy spoľahlivosti

Historické vydanie; aktuálny build 23 obsahuje aj tieto opravy.

Zdroj `ecbe6d1ac876156e01f92697f47da96c2bdd3685` (PR #492). Nový build
obsahuje obnovu prvého pripojenia po výpadku, kontrolu povolenia notifikácií
po návrate z Nastavení, zrušenie oneskorenej push registrácie po odhlásení,
uchovanie čakajúcich polôh a bezpečné prepínanie pristavení. Strata prístupu
skryje zákaznícke údaje z cache a vypršanie odstráni klienta aj GPS bez siete.
`expo-notifications` je na opravnej verzii 57.0.24 vyžadovanej Expo SDK 57.

Overené: 1 247 mobilných testov, typy/lint, CI vrátane iOS a Android exportu,
šesť prehliadačových scenárov na 390/320 b a 115 kontrol stabilného TEST.
Podpísaná IPA má správny TEST App ID, server, databázu, podpis, hlasové
režimy a popisy oprávnení; zabalený JavaScript obsahuje nové opravy.

Tieto opravy boli doručené v builde 19 a zostávajú aj v aktuálnom builde 22.
Build 18 si ich nestiahne, pretože OTA sú vypnuté. Skúsiť návrat po výpadku
siete, zmenu notifikácií v Nastaveniach a pristavenie pri slabom signále.
Reálne audio, podržanie/prepojenie, push doručenie a pohyb telefónu zostávajú
podľa [akceptačného plánu](reliability-audit-2026-10-22.md) samostatné skúšky.

Krátka skúška nového buildu (iba TEST účty a vlastné skúšobné pristavenie):

| Skúška | Očakávaný výsledok |
| --- | --- |
| Pred prvým pripojením vypnúť internet, skúsiť Pripojiť telefón, potom obnoviť internet a vrátiť sa do aplikácie. | Telefón zopakuje pripojenie; nezačne sám nový hovor a neprevezme iný iPhone. |
| V nastaveniach iPhone vypnúť notifikácie a vrátiť sa do Účtu; potom ich opäť povoliť. | Zobrazené povolenie sa zmení pri návrate, bez šesťhodinového čakania. |
| Po pripojení zopakovať úspešný hovor pri zamknutom telefóne. | Prijatie, obojstranný zvuk a zavesenie; samotné zvonenie neoznačiť za celý úspešný hovor. |
| Prijať skúšobné pristavenie, povoliť polohu, chvíľu ísť bez signálu a potom obnoviť spojenie. | Dispečer dostane čakajúce polohy; čerstvosť polohy na jeho obrazovke sa obnoví. |
| Dokončiť alebo zrušiť pristavenie a overiť obidva pohľady. | Údaje klienta sa skryjú a telefón prestane zdieľať polohu tohto pristavenia. |

## Build 21 – obnova nepotvrdeného kroku

Zdroj `0cc412c649a15a9071fd3c42d525884fe3b07e4d` (PR #494). Obsahuje
[presnú obnovu nepotvrdených krokov](delivery-recovery-2026-10-22.md),
ochranu pred starými odpoveďami a dialógmi, okamžitú stratu prístupu
a zastavenie nových krokov počas odhlásenia. Zachováva opravy buildu 19.

Lokálny EAS build cez Xcode 27.1, SDK iOS 27.1, Node 24.22.1,
CocoaPods 1.17.0 a Fastlane 2.241.1 prešiel 23. 10. 2026 od 06:05:07
do 06:12:31 UTC (7 min 24 s vrátane prípravy natívnych závislostí).
IPA má 21 274 649 bajtov; SHA-256
`5589d4fc918fe6412eef09ba417b2c1a664a6718bfe7df6277e4495e91176bb2`.

Nezávislá kontrola IPA overila 32 podmienok vrátane striktného podpisu
a frameworkov, existujúceho profilu, App ID, tímu, push entitlementu,
TEST API a Supabase, vypnutých OTA a vloženého JavaScriptu s obnovou
pripojenia aj novým uložením kroku a tlačidlom „Overiť rovnaký krok“.
Čistý Git zdroj bol overený pred aj po zostavení. Upload ide cez Apple
`altool` priamo z Macu; Expo cloud build ani nový Expo projekt netreba.

Apple upload `ffb7ed24-81e5-412e-bc89-e4a5a9935364` prijal bez chyby
23. 10. o 06:15:17 UTC. O 06:18:35 UTC bolo overené `COMPLETE`,
`VALID`, `IN_BETA_TESTING`, bez chýb či upozornení a s konkrétnym buildom
v existujúcej skupine „Team (Expo)“. Slovenské „What to Test“ je uložené
pri tomto builde. IPA, symboly dSYM a záznamy kontrol sú uchované súkromne.

V TestFlighte aktualizovať na **0.1.0 (22)** a prejsť
[postup skúšky pristavení](delivery-recovery-2026-10-22.md#natívne-vydanie-a-postup-skúšky).
Kompilácia a kontrola podpisu nenahrádzajú fyzické skúšky Keychain,
reštartu iPhone, živého zvuku, push a pohybu telefónu.

## Build 22 – oprava pádu pri štarte na iOS 27

Zdroj `988a58901b28003201fac7ed166c7e4454594067` (PR #496). Crash feedback
buildu 21 z iPhone 15 Pro Max, iOS 27.0, ukázal ukončenie hlavného vlákna
približne 0,18 s po štarte v
`___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`.
Nový SDK 27 vyžaduje UIKit scenes; pôvodná Expo šablóna stále vytvárala
okno a React Native v AppDelegate. Oficiálny plugin teraz pridá scene
manifest aj presunie tento štart do `EXExpoAppSceneDelegate`; zachová
`super.application`, teda aj natívnu inicializáciu PushKit a CallKit.

Lokálny podpísaný build cez Xcode 27.1 prešiel 23. 10. od 06:59:38
do 07:03:49 UTC. IPA má 21 274 747 bajtov; SHA-256
`8ed30f82678ac85b82baf9b4d7809a431d7c23509967bfde5785cc455ab4756c`.
Nezávislá kontrola overila 34 podmienok. Dve nové vyžadujú scene manifest
a skutočný vygenerovaný AppDelegate bez starého vytvárania okna a štartu RN.
Táto sprísnená kontrola odmietla pôvodnú IPA 21.
Archív aj komprimované dSYM sú zachované mimo dočasných súborov; UUID
`133A9C29-1D85-3BB2-AD0B-6AB5A45329DB` (`arm64`) sa zhoduje v odoslanej
IPA, archíve aj dSYM. Štyri konfiguračné testy kontrolujú reálne Expo
modifikátory a šablónu; 1 288 mobilných testov, typy/lint, export pre
iOS/Android a existujúce CI brány prešli.

Skutočný **Release** simulátor: iPhone 15 Pro Max, iOS 27.0
(`24A434`). Kontrolná verzia s pôvodným lifecycle spadla
s rovnakou UIKit signatúrou v samostatnom kontrolnom behu; zhodu binárky
a reportu overujú UUID a SHA-256. Pozitívne skúšky bežali na oddelenom
čistom profile. Opravená verzia zobrazila slovenské prihlásenie
vrátane TEST, e-mailu a hesla v štyroch scenároch:

1. Studený štart.
2. Návrat z Nastavení do tej istej bežiacej aplikácie.
3. Ukončenie a nové otvorenie.
4. Druhé ukončenie a nové otvorenie.

Otvorenie cez `linkapomoci-test://` zostáva neoverené: iOS zobrazil
potvrdzovací dialóg pred otvorením aplikácie. Opakovanie po reštarte
simulátorového zariadenia zastavil timeout nástroja `simctl`; táto
skúška sa nepovažuje za úspešnú.

Zdroj simulátora `96afa6f6` má identický celý Git strom ako `dev` `988a5890`.
Skúška sa dokončila `2026-10-23T09:35:23Z`; nezahŕňala prihlásenie ani hovory.
Studené prebudenie cez VoIP push bez pripojenej UI scény musí overiť fyzický
iPhone; tieto scenáre ho nesimulujú.
Snímky obrazovky, OCR, crash kontrolnej verzie a záznamy kontrol zostávajú
súkromne pri artefaktoch. Upload helper pred odoslaním vyžaduje úspešný
natívny záznam a zhodu mobilného zdroja s nahrávanou binárkou.

Apple upload `b44e9994-b5fb-40e0-97e1-e6ac79d8e5f9` prijal bez chýb
23. 10. o 09:46:04 UTC. Následne potvrdil `COMPLETE`, `VALID`,
`IN_BETA_TESTING`; konkrétny build je v existujúcej internej skupine „Team (Expo)“.
Slovenské „What to Test“ je uložené a spätne overené pri tomto builde.
Aktualizovať v TestFlighte na **0.1.0 (22)**. Fyzický iPhone má ešte
potvrdiť otvorenie po aktualizácii a opakovať hovory pri zamknutí, push
a polohu podľa akceptačného postupu. Simulátor tieto integrácie nepotvrdzuje.

## Build 23 – mobilná fáza 1

Zdroj `f3926dc4e04909df1d823036e2c713dd05d5316a`,
[PR #507](https://github.com/Alfopure/pomoc-motoristom-new/pull/507).
Web a API s týmto rozsahom sú na https://test.dispecing.linkapomoci.sk.
Build 23 obsahuje [prvú fázu](../rollout/mobile-phase-one-2026-10-24.md):
flotilu do 1 000 vozidiel, **Obnoviť prístupy** dostupné aj pri skrytom
module Pristavenia a **Uložiť a odovzdať** s výslovným potvrdením príjemcu.
Obnova konceptu po reštarte aj ochrana pred duplicitným uložením sú zachované.
Mobilné priradenie hovoru zostáva cez existujúce **Po hovore**.

Podpísaná IPA má **21 276 682 bajtov**, SHA-256
`cf611b3b81ac8aca8404a7c762fe271d8c1bc4b110eeeaaaaa8872df7611e5a1`.
Všetkých 34 kontrol podpisu, konfigurácie a obsahu prešlo. V skutočnom
zabalenom JavaScripte sú overené aj texty nových akcií. TEST App ID,
server, databáza, podpis a vypnuté OTA zostávajú rovnaké.

Čerstvý Release simulátor zo zdroja `f3926dc4` overil viditeľné prihlásenie
pri studenom štarte, návrate z pozadia a dvoch reštartoch. Hashe
nainštalovanej binárky, Info.plist aj JavaScriptu sa zhodujú so zostaveným
simulátorovým artefaktom. Štyri snímky boli prenesené s kontrolou hashov
a samostatne vizuálne skontrolované; nejde o potvrdenie iba podľa živého procesu.
Jedna pôvodná snímka reštartu ukázala ešte obnovovanie prihlásenia a nebola
označená ako PASS. Opakovaný reštart doložil prihlásenie po 20 aj 60 sekundách;
pôvodné snímky a výsledky zostali zachované. Overenie sa uzavrelo
24. 10. o **18:14 UTC**. Predtým bolo potrebné obnoviť neaktívnu službu
CoreSimulator po zaseknutých systémových príkazoch.

Historická negatívna kontrola zo zdroja `96afa6f6` zostáva identifikovaná
ako starší beh. Jej binárka, Info.plist a crash report boli overené podľa
hashov a relevantné natívne vstupy sú nezmenené; nejde o nový negatívny beh.

Apple upload skončil bez chyby **24. 10. o 18:16:02 UTC**.
O **18:18:41 UTC** Apple potvrdil build
`f81bc730-ebeb-4d96-8a97-8b5941537ae7`, `VALID`, `IN_BETA_TESTING`
a dostupnosť v existujúcej internej skupine **Team (Expo)**.
Aktuálna verzia na aktualizáciu cez TestFlight je **0.1.0 (23)**;
samotné nasadenie servera staršiu nainštalovanú binárku nezmení.

Spoločný fyzický test majiteľ odložil pokynom „test bude potom“.
[Jednoduchý checklist](phase-one-acceptance.md) preto zostáva nevyplnený.
Simulátor nepotvrdzuje skutočný push, obojsmerný zvuk, GPS pri pohybe
a zamknutí ani zastavenie sledovania. Produkcia nebola vydaná.

## Hranice

Iba TEST: TEST App ID, TEST server, TEST databáza. Produkčný build
(`sk.linkapomoci.dispecing`), jeho karta v App Store Connect, App Review
a telefonovanie v produkcii sú samostatné vydanie so schválením majiteľa.
