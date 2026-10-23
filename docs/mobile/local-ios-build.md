# Lokálny iOS build na Macu

Dispatching TEST sa dá zostaviť cez Xcode bez cloudovej build kvóty Expo.
Používa rovnaký profil `testflight`, Expo projekt, Apple App ID a podpis ako
cloudový build. Nahratie do TestFlightu je ďalší krok; samotná IPA ešte
neznamená dostupný build na iPhone.

Pri Xcode 27 musí konfigurácia SDK 57 zapnúť `enableSceneSupport` cez
`expo-build-properties` (v tejto aplikácii 57.0.22). Samotná úspešná
kompilácia, podpis a Apple `VALID` nezaručujú štart: majiteľ nahlásil pád
buildu 21 na iOS 27 a crash log potvrdil chýbajúci scene lifecycle.
Pred ďalším odovzdaním overiť scenár spustenia zo skutočného Release
simulátorového buildu alebo na fyzickom iPhone. Manifest bez presunutia
React Native štartu do scene delegate nestačí; oficiálny plugin robí oboje.

Aktuálny lokálny build je **0.1.0 (22)** zo zdroja `dev` `988a5890`.
Apple potvrdil `VALID`, `IN_BETA_TESTING` a prístup existujúcej internej
skupiny. Prešlo 34 kontrol IPA aj štyri skutočné scenáre štartu v Release
simulátore iOS 27; pôvodná kontrolná verzia zopakovala nahlásený pád.
Build 21 sa pre tento pád nepoužíva. Časovanie, SHA-256 a rozsah skúšky
sú v [zázname vydania](testflight.md#build-22--oprava-pádu-pri-štarte-na-ios-27).

Pri Release skúške v simulátore ponechať `CODE_SIGNING_ALLOWED=YES` a
`CODE_SIGN_IDENTITY=-`, cieľ `generic/platform=iOS Simulator`. Xcode vloží
oprávnenia aj do Mach-O sekcie `__TEXT,__entitlements` alebo `__ents_der`;
overiť cez `otool -l <app>/DispatchingTEST`. Vypnuté podpisovanie môže
spôsobiť chybu SecureStore pri načítaní prihlásenia. Dodatočný `codesign`
tieto linkovacie sekcie nedoplní. Ide iba o simulátor; distribučná IPA
naďalej používa existujúci App Store certifikát a profil.

V overenej inštalácii Xcode 27.1 je grafické rozhranie simulátora v
`/Applications/Xcode.app/Contents/Applications/DeviceHub.app`; otvoriť cez
`open -a /Applications/Xcode.app/Contents/Applications/DeviceHub.app`.
Staršia cesta k `Simulator.app` v tejto inštalácii neexistuje. Dostupné
runtimy a konkrétne zariadenie overiť cez `xcrun simctl list -j`.

## Nástroje a identita

Na Macu treba plný Xcode s iOS SDK, dokončené prvé spustenie, Node 24,
CocoaPods a Fastlane. Pri príprave 23. 10. 2026 bol dostupný Xcode 27.1
(`27A9275`, SDK iOS 27.1). Nástroje sú nainštalované cez Homebrew:

```sh
brew install cocoapods fastlane node@24
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcodebuild -checkFirstLaunchStatus
pod --version
fastlane --version
```

Tento PATH platí pre Apple Silicon a nemení globálne prepojenie Node.
Lokálne EAS ignoruje verzie `node`, `image`, `cocoapods` a `fastlane`
z `eas.json`; použije skutočne nainštalované nástroje.

| Položka | Povinná hodnota pre TEST |
| --- | --- |
| Profil | `testflight`, platforma `ios`, `--local` |
| Expo vlastník / projekt | `linkapomoci` / `c7363382-9b12-4e12-9f62-31ec7b8c5623` |
| Apple tím / App Store Connect | `792TJPXTL3` / `6825741096` |
| Bundle ID | `sk.linkapomoci.dispecing.test` |
| Názov | `Dispatching TEST` |
| Prostredie | `APP_VARIANT=test`, `EXPO_PUBLIC_APP_ENV=test`, `EXPO_PUBLIC_VOICE_PROOF=1` |
| API / Supabase | `https://test.dispecing.linkapomoci.sk` / `nzpnqdstvkfncflgqlny` |
| OTA | vypnuté |

Expo autentifikácia je potrebná aj pri lokálnom EAS. Token musí mať prístup
k tomuto existujúcemu projektu. Nový robot na účte `alfopure_1` ho pri
kontrole 23. 10. nemal; iný voľný účet preto sám neodblokuje tento projekt.
Kvôli buildu nemeníme project ID ani push identitu a nevytvárame kópiu appky.
Cloudový platený plán nebol objednaný.

## Zdroj, podpis a build

1. Na kanonickom TEST overiť `/api/health/live`, deployment a Git commit.
   Použiť čistý klon konkrétneho overeného `dev` commitu. Pred buildom
   zaznamenať celý SHA a `git rev-parse HEAD^{tree}`; nekopírovať pracovnú
   kópiu s neidentifikovanými zmenami.
2. V `mobile` spustiť `npm ci`. Profil už vyberá EAS prostredie `preview`
   a TEST premenné. Na Macu nenechávať produkčné `.env` ako náhradný zdroj.
   EAS premenné s viditeľnosťou `Secret` nie sú pri lokálnom builde dostupné;
   prípadné potrebné hodnoty musia byť dodané lokálne chráneným spôsobom.
3. Pripraviť gitignorovaný `mobile/credentials.json` s cestou na existujúci
   TEST App Store profil a distribučný p12. Heslo, Expo token a Apple API
   kľúč sú iba v súkromnom adresári, nie v Gite, argumentoch vložených do
   histórie terminálu ani vo výpise diagnostiky. Súkromný adresár má práva
   `700`, súbory `600`; prenos medzi cloudom a Macom je šifrovaný.
4. Spustiť lokálny EAS, uložiť log a IPA mimo zdrojov. `EXPO_TOKEN` sa
   načíta zo súkromného súboru alebo správcu tajomstiev bez jeho vypísania.

```sh
cd mobile
npx eas-cli@24.12.1 build --platform ios --profile testflight \
  --local --non-interactive --output /absolutna/sukromna/cesta/dispatching-test.ipa
```

`appVersionSource: remote` a `autoIncrement: true` platia aj lokálne:
číslo buildu rezervuje EAS. Aj neúspešný pokus môže posunúť číslo; pri
opakovaní ho nevracať naspäť. Lokálne EAS neobnovuje build cache.

Pre diagnostiku možno nastaviť `EAS_LOCAL_BUILD_WORKINGDIR` a
`EAS_LOCAL_BUILD_SKIP_CLEANUP=1`. Pracovný priečinok aj úplný log môžu
obsahovať podpisové údaje; nezdieľať ich verejne. Po overení odstrániť
dočasný `credentials.json` a už nepotrebné pracovné artefakty. Zachovať
finálnu IPA, jej SHA-256, zdrojový SHA, verzie nástrojov a výsledok Apple.

Na Macu majiteľa je oddelený adresár
`$HOME/conductor/builds/dispatching-test/`: čisté zdroje `source-<sha7>`,
súkromné podpisovanie `private/signing`, nástroje `tooling` a jednotlivé
behy `runs`. Operátorský `tooling/local-mac-build.mjs <dev-sha>` overí čistý
zdroj aj zhodu s načítaným `origin/dev`, vytvorí súkromný log a receipt,
spustí EAS a po skončení odstráni dočasný `credentials.json`. Pred ďalším
commitom treba pripraviť jeho vlastný čistý klon a znovu overiť TEST;
helper sám nemení ani nenasadzuje server.

## Kontrola IPA a nahratie

Pred uploadom overiť striktne `codesign`, vložený provisioning profil,
App ID, tím, verziu/build, `aps-environment=production`, `get-task-allow=false`,
režimy audio/voip/location, texty oprávnení a privacy manifest. V zabalenom
JavaScripte overiť TEST API a Supabase, prítomnosť vydávaných opráv a
vypnuté OTA. Zaznamenať SHA-256 a veľkosť presne tejto IPA.

Na Macu je na tieto kontroly `tooling/verify-local-ipa.py`:

```sh
python3 -I tooling/verify-local-ipa.py <run-directory> <dev-sha> <build-number>
```

Nahrávať iba overenú IPA do existujúcej TEST aplikácie. Možnosti sú EAS
Submit s `--path` alebo Apple `xcrun altool --upload-package`; syntax overiť
cez `xcrun altool --help` z konkrétneho Xcode. Apple API kľúč má vlastný
súkromný adresár (`API_PRIVATE_KEYS_DIR`), nikdy nepatrí do zdrojov.

Na pripravenom Macu `tooling/local-mac-upload.mjs <run-directory> <dev-sha>
<build-number> <startup-smoke.json>` vyžaduje úspešný verification receipt
**aj natívny startup receipt**: kontrolná verzia s pôvodným lifecycle, štyri
úspešné scenáre a mobilný zdroj zhodný s nahrávaným commitom. Pri zmene
mobilného zdroja treba zostaviť a spustiť nový Release simulátor; starý
receipt sa nesmie vydávať za skúšku novej binárky. Helper znovu overí
SHA-256 IPA a cez Apple API TEST appku aj neprítomnosť rovnakého čísla.
Potom spustí Apple `altool` a uchová samostatný upload receipt. Po
prerušenom uploade najprv zistiť stav konkrétneho Apple uploadu; helper
nedovolí bez preverenia prepísať záznam ani nahrať rovnaký build druhýkrát.

Po prijatí uploadu počkať na Apple processing a cez App Store Connect
overiť konkrétne číslo, `processingState=VALID`, interný stav
`IN_BETA_TESTING` a prístup existujúcej skupiny „Team (Expo)“. Nepridávať
ďalších testerov ani pozvánky. Výsledok uploadu bez týchto kontrol ešte
nedokladá dostupnosť cez TestFlight.

## Chyba podpisu pri prvom builde

Prvý lokálny pokus 23. 10. zastal na
`Distribution certificate ... hasn't been imported successfully`.
Na čerstvom Macu chýbal medziľahlý certifikát Apple WWDR G3, ktorý vydal
existujúci distribučný certifikát. Importoval sa verejný G3 z Apple do
prihlasovacej kľúčenky, bez prepisovania dôvery a bez nového App ID:

```sh
curl --fail --location https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer \
  -o AppleWWDRCAG3.cer
openssl x509 -inform DER -in AppleWWDRCAG3.cer -noout -subject -issuer -dates
security import AppleWWDRCAG3.cer -k "$HOME/Library/Keychains/login.keychain-db"
```

Overený G3 končí 20. 2. 2030; SHA-256 je
`dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f`.
Pri podobnej chybe najprv odlíšiť chýbajúci reťazec od poškodeného p12
alebo chyby hesla; samotná hláška nedokazuje nesprávne heslo.

Zdroje: [Expo lokálne buildy](https://docs.expo.dev/build-reference/local-builds/),
[Expo scene support](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/#pluginconfigtypeios),
[Apple scene lifecycle](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle),
[Apple WWDR](https://developer.apple.com/support/expiration/),
[Apple certifikáty](https://www.apple.com/certificateauthority/),
[Apple upload](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
