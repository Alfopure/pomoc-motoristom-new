# TestFlight — Dispatching TEST

Cieľ: TEST aplikácia v iPhone cez interný TestFlight, bez App Review. Je to TEST
variant (TEST server, TEST databáza, telefonovanie zapnuté v aplikácii, OTA vypnuté).
Produkčná aplikácia je samostatné vydanie so schválením majiteľa.

## Stav prípravy (22. 10. 2026)

| Položka | Stav |
| --- | --- |
| Apple Developer Program, MICT s. r. o., tím `792TJPXTL3` | aktívne |
| App ID `sk.linkapomoci.dispecing.test` so schopnosťou Push Notifications | zaregistrované |
| Karta v App Store Connect „Dispatching TEST“, ID `6825741096`, SKU `dispatching-test` | vytvorená |
| Distribučný certifikát a App Store profil (push v režime production, platné do 22. 10. 2027) | pripravené mimo Gitu |
| Tímový App Store Connect API kľúč | pripravený mimo Gitu |
| EAS build a submit profil `testflight` | `mobile/eas.json` |
| APNs kľúč pre bežné notifikácie cez Expo | chýba |
| VoIP Services certifikát a TEST Telnyx push credential | chýba |

Build ani nahratie od APNs kľúča a VoIP certifikátu nezávisia; oba sa dajú
doplniť neskôr bez nového buildu.

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
22. 10. 2026 zostávali 3; ráta sa aj neúspešný build.

```sh
cd mobile
npx eas-cli@24.12.1 build --platform ios --profile testflight --non-interactive --no-wait
```

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

- **Notifikácie:** APNs kľúč (.p8 a Key ID) nahrať do Expo pre
  `sk.linkapomoci.dispecing.test`. TEST server ich posiela už teraz
  (`MOBILE_PUSH_ENABLED`), ale bez kľúča ich Expo do iPhonu nedoručí.
- **Telefonovanie:** VoIP Services certifikát, TEST Telnyx iOS push credential
  a prepínače v dedikovanom TEST projekte podľa
  [iPhone TEST postupu](iphone-voice-test.md#zapojenie-po-schválení-apple).
- **Akceptácia:** [hovory](iphone-voice-test.md#akceptácia-na-fyzickom-iphone)
  a pristavovač: prijatie, povolenie polohy „Vždy“, poloha na pozadí a pri
  zamknutom telefóne (modrý ukazovateľ), u dispečera „pred X min“, zastavenie
  po skončení pristavenia a pri odhlásení.

## Hranice

Iba TEST: TEST App ID, TEST server, TEST databáza. Produkčný build
(`sk.linkapomoci.dispecing`), jeho karta v App Store Connect, App Review
a telefonovanie v produkcii sú samostatné vydanie so schválením majiteľa.
