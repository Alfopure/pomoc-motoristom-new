# TestFlight — Dispatching TEST

Cieľ: TEST aplikácia v iPhone cez interný TestFlight, bez App Review. Je to TEST
variant (TEST server, TEST databáza, telefonovanie zapnuté v aplikácii, OTA vypnuté).
Produkčná aplikácia je samostatné vydanie so schválením majiteľa.

**Hlásený problém buildu 21 (23. 10. 2026):** na iOS 27 padá pri štarte,
pred načítaním JavaScriptu. TestFlight crash feedback ukazuje
`___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`.
Apple processing a kontrola podpisu tento runtime problém neodhalili.
Oprava zapína oficiálne `expo-build-properties` 57.0.22 s
`ios.enableSceneSupport=true`; nový natívny build a spustenie na iOS 27
sú potrebné pred označením opravy za doručenú. OTA sú vypnuté.

## Stav prípravy (23. 10. 2026)

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
| Najnovší TestFlight build | **0.1.0 (21)** z `dev` `0cc412c6`, lokálne cez Xcode 27.1; podpísaná IPA prešla 32 kontrolami. Apple 23. 10. 2026 potvrdil `VALID`, `IN_BETA_TESTING` a prístup existujúcej internej skupiny. |
| Ďalšie opravy pristavení | [Obnova nepotvrdených krokov](delivery-recovery-2026-10-22.md) je zabalená v builde 21. Build 19 ich neobsahuje; OTA je vypnuté. |
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

Historické vydanie; nasledujúci build 21 obsahuje aj tieto opravy.

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

Tieto opravy boli doručené v builde 19 a zostávajú aj v aktuálnom builde 21.
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

V TestFlighte aktualizovať na **0.1.0 (21)** a prejsť
[postup skúšky pristavení](delivery-recovery-2026-10-22.md#natívne-vydanie-a-postup-skúšky).
Kompilácia a kontrola podpisu nenahrádzajú fyzické skúšky Keychain,
reštartu iPhone, živého zvuku, push a pohybu telefónu.

## Hranice

Iba TEST: TEST App ID, TEST server, TEST databáza. Produkčný build
(`sk.linkapomoci.dispecing`), jeho karta v App Store Connect, App Review
a telefonovanie v produkcii sú samostatné vydanie so schválením majiteľa.
