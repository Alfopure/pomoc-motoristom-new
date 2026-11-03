# Android a Google Play — príprava

Cieľ: TEST aplikácia `sk.linkapomoci.dispecing.test` v Google Play **internom testovaní**, neskôr produkčná `sk.linkapomoci.dispecing`. Rozsah prvého Android buildu: prihlásenie, prípady, úlohy, Moja práca, Pobočka a push. Telefonovanie na Androide (Telnyx/FCM hovory) je samostatná neskoršia etapa.

## Stav k 29. 10. 2026

Majiteľ potvrdil zaplatený Google Play účet a uviedol číslo
`8888848449240049336`. Zodpovedá formátu Developer ID; samo osebe neposkytuje
prístup. Majiteľ následne potvrdil vytvorenie aplikácie Dispatching TEST.
Prístup k TEST aplikácii bol 29. 10. overený cez Google Play API; samotné
overenie vývojárskeho účtu a podmienky publikovania sa tým nepotvrdzujú.

Používa sa existujúci Google Cloud projekt **PomocMotoristom**, ID
`pomocmotoristom`, podľa pokynu majiteľa. Servisný účet pre Play je
`linka-play-submit@pomocmotoristom.iam.gserviceaccount.com`.
Jeho JSON kľúč 29. 10. úspešne prešiel Google OAuth overením a bol nahratý
do existujúceho Expo projektu a priradený výhradne k
`sk.linkapomoci.dispecing.test` pre EAS Submit. Následné čítanie EAS
Credentials potvrdilo priradenie. Kľúč nie je v Gite.
Po pozvaní účtu majiteľom bolo overené vytvorenie dočasnej editácie,
čítanie detailov (`defaultLanguage: sk`) a všetkých štyroch kanálov vrátane
`internal` (HTTP 200). Pri tomto prvotnom overení boli kanály prázdne. Dočasná
editácia bola odstránená (HTTP 204) bez publikovania; neskoršie úspešné
nahratie interného návrhu verzie 7 je uvedené nižšie.
Podrobný záznam bez tajomstiev je v ignorovanom
`.context/android-play/access-check.json`.

Prístup do existujúceho Expo projektu `@linkapomoci/linka-pomoci-dispecing`
je funkčný. Zdroj `07429b8` prešiel 28. 10. `npm run typecheck` a
`npm run export:android`. Pred touto prípravou bolo v EAS dostupné staršie
TEST APK **0.1.0 (6)** zo zdroja `133dce63348b245ae9b5e97a72496b384ce5d13f`
(12. 10.); nový overený AAB 0.1.0 (7) je uvedený nižšie.
FCM V1 kľúč je od 29. 10. priradený v EAS výhradne k TEST Android aplikácii;
následné čítanie EAS Credentials potvrdilo priradenie. Ten istý servisný účet
má pre Google projekt overené `cloudmessaging.messages.create`.
FCM HTTP v1 kontrola s `validate_only: true` prešla (HTTP 200), bez odoslania
notifikácie. Skutočné doručenie na zariadenie ešte nie je overené.
Súbor `GOOGLE_SERVICES_JSON` je v EAS prostredí `preview` nastavený ako
projektová premenná typu `file` s viditeľnosťou `secret`.

Čerstvé mobilné kontroly 29. 10.: typecheck a lint prešli; **85 testovacích
súborov, 1 342 testov prešlo**. Mobilný zdroj v pracovnom commite `07429b8`
sa zhoduje s aktuálnym `dev` `964779118e085148fc51d9da25a0237a69248f7c`;
ten istý `dev` commit potvrdzuje kanonický TEST health endpoint.

Firebase bol pridaný do existujúceho projektu `pomocmotoristom`
(číslo `141279245375`) a je `ACTIVE`. Bola registrovaná iba TEST Android
aplikácia `1:141279245375:android:346b65ffa93b38f123f48a`,
`sk.linkapomoci.dispecing.test`, s existujúcim upload certifikátom EAS.
API pre Firebase Management, FCM, Firebase Installations, API Keys,
Cloud Resource Manager a Maps SDK for Android boli úspešne zapnuté.
Google Analytics sa kvôli tejto príprave neprepájal.

Natívna Android mapa má vlastný kľúč
`projects/141279245375/locations/global/keys/dispatching-test-android-maps`,
obmedzený na Maps SDK for Android, TEST package a dva overené certifikáty:
EAS upload `D7:DB:99:52:55:E8:A6:A7:4B:FD:C5:79:3C:F8:9B:07:19:C2:09:1E`
a Play App Signing `28:68:A9:AD:AB:F4:F6:2A:08:D1:BA:48:0F:C0:8C:69:87:B3:6A:E9`.
Jeho hodnota je iba v EAS `preview` premennej
`GOOGLE_MAPS_ANDROID_API_KEY` (`sensitive`) a ignorovanom pracovnom súbore.
Play certifikát bol získaný zo skutočného univerzálneho APK vytvoreného
Google Play pre verziu 7; `apksigner` overil jeho podpis a SHA-256 certifikátu
sa zhoduje s Google Play API. Oba certifikáty sú registrované aj pri TEST
Firebase aplikácii. Pri budúcej zmene podpisu treba aktualizovať obmedzenia.
Existujúce webové a serverové mapové kľúče sa nemenili.

Podmienený `react-native-maps` plugin pridáva kľúč do Android manifestu.
Kontrola bez kľúča, s prázdnym a syntetickým kľúčom prešla a zachovala
iOS Apple Maps konfiguráciu. Čerstvá natívna introspekcia so skutočným
TEST Firebase súborom aj skutočným mapovým kľúčom potvrdila TEST package,
Firebase konfiguráciu, mapové metadata, vypnuté OTA a neprítomnosť
blokovaných oprávnení. Záznam je v `.context/android-play/native-preflight.json`.

Prvý nový AAB **0.1.0 (7)** je dokončený v EAS:
[`e536d69c-5aab-4a60-af44-5cc9da7b8235`](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing/builds/e536d69c-5aab-4a60-af44-5cc9da7b8235).
Izolovaný zdroj je lokálny commit
`0742079ceb46537b26555277292c924595b865e4`, založený na `dev` `9647791`.
V EAS boli pred buildom overené TEST API origin, TEST Supabase URL aj
`EXPO_PUBLIC_APP_ENV=test`.

Dokončený AAB prešiel Google `bundletool validate`, overením JAR podpisu
a upload certifikátu, kontrolou package/verzie, `targetSdkVersion: 36`,
`minSdkVersion: 24`, skutočných Firebase a mapových zdrojov, TEST API
a Supabase v JavaScripte, vypnutých OTA a blokovaných oprávnení.
Google Play ho prijal cez
[EAS Submit `ddeec2fe-43de-4332-8970-70dd1983c09c`](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing/submissions/ddeec2fe-43de-4332-8970-70dd1983c09c).
Čerstvé čítanie Google Play API potvrdilo kanál `internal`, verziu 7,
stav **draft** a SHA-256 zhodný s lokálne overeným AAB:
`45545ba7986ba138598d8270a3fbc0d93c1f56cfead50fbe5b9f92c4586a1f0f`.
Overovacia editácia bola odstránená bez potvrdenia zmien.

Po nahratí návrhu bol cez existujúcu prihlásenú Play Console vytvorený
a priradený samostatný tímový zoznam. Google prijal **12 účtov**; štyri
ďalšie pracovné aliasy odmietol ako neexistujúce Google účty. Zoznam
neobsahuje AI ani technické skúšobné účty. Adresy zostávajú mimo Gitu.
Kráľovej Google e-mail majiteľ ešte neposkytol.

Majiteľom požadované interné TEST vydanie bolo následne sprístupnené.
Čerstvé Google Play API čítanie potvrdilo verziu 7 so stavom **completed**
v kanáli `internal`; `production`, `beta` a `alpha` zostali prázdne.
Konzola potvrdila aktívny kanál, dostupnosť pre interných testerov a uložený
zoznam 12 účtov. [Pripojenie k internému testu](https://play.google.com/apps/internaltest/4701680730012522487)
vyžaduje prihlásenie jedným z prijatých Google účtov. Kým aplikácia
neprejde nastavením a kontrolou obchodu, Play zobrazuje dočasný názov
`sk.linkapomoci.dispecing.test (unreviewed)`.

Jednotlivé e-mailové zoznamy nemožno spravovať cez verejné
[Play Testers API](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers),
ktoré podporuje iba Google Groups. Ďalšie úpravy zoznamu sa robia v konzole;
pre túto úlohu nebola potrebná nová skupina ani ďalšie oprávnenia.

Skutočné Play APK bolo nainštalované do softvérového Android 35 AOSP
emulátora a jeho hash sa zhodoval s overeným artefaktom. Ochrana pridaná
Google Play však bez Google Play služieb v emulátore zobrazila požiadavku
na Google Play; nejde o potvrdenie úspešného štartu aplikácie.
Z toho istého overeného EAS AAB bol cez `bundletool` vytvorený samostatný
offline testovací APK s lokálnym testovacím podpisom. V emulátore úspešne
zobrazil prihlasovaciu obrazovku po studenom štarte aj návrate z pozadia;
nebol zaznamenaný pád procesu aplikácie. Tento APK sa nenahráva do Play.
Offline skúška nepotvrdzuje štart Play verzie nainštalovanej cez Google Play,
úspešné prihlásenie, fyzické doručenie push ani živú mapu na zariadení.
Aktuálne doplňujúce skúšky a stav konfigurácie sú v [PR #528](https://github.com/Alfopure/pomoc-motoristom-new/pull/528).

## Čo je pripravené v kóde

- `mobile/app.config.ts`: Android package pre každý variant; `googleServicesFile` sa načíta z EAS premennej `GOOGLE_SERVICES_JSON` (typ *file*), lokálne a v CI chýba.
- Natívny Android mapový kľúč sa načíta z `GOOGLE_MAPS_ANDROID_API_KEY`; je potrebný osobitný kľúč obmedzený na TEST package, podpisový certifikát a Maps SDK for Android. Webový ani serverový mapový kľúč sa na tento účel nepreberá.
- `mobile/eas.json`: build profil `play-internal` (TEST, Android App Bundle, `distribution: store`) a submit profil `play-internal` (stopa *internal*, stav *draft*, kľúč servisného účtu uložený v EAS Credentials pre TEST aplikáciu). Expo `distribution: store` určuje formát distribúcie binárky, nie produkčné aplikačné prostredie; profil stále dedí výhradne TEST prostredie.
- Poloha na pozadí je na Androide blokovaná (`blockedPermissions`); poloha jazdy sa posiela iba pri otvorenej appke.

## Jednorazový prístup pre automatizáciu

1. **Play Console:** dokončiť požadované overenia účtu a vytvoriť aplikáciu
   **Dispatching TEST**, ak ešte neexistuje. Použiť TEST package
   `sk.linkapomoci.dispecing.test`; produkčná aplikácia je samostatná.
2. **Google Cloud:** vybrať existujúci projekt `pomocmotoristom` a zapnúť
   **Google Play Android Developer API** (`androidpublisher.googleapis.com`).
3. **IAM & Admin → Service Accounts:** vytvoriť napríklad `linka-play-submit`.
   Na samotné nahrávanie do Play nepotrebuje Cloud rolu Owner ani Editor.
   Pre automatickú prípravu Firebase a mapového kľúča sú samostatne potrebné
   Firebase Admin, Service Usage Admin a **Service Usage → API Keys Admin**
   (`roles/serviceusage.apiKeysAdmin`). Podobne pomenovaná
   `roles/edgecontainer.apiKeyAdmin` tieto mapové kľúče nespravuje.
4. V servisnom účte otvoriť **Keys → Add key → Create new key → JSON**.
   Kľúč uchovávať mimo Gitu; jeho obsah nevkladať do správ ani logov.
5. **Play Console → Users and permissions → Invite new users:** pozvať
   e-mail vytvoreného servisného účtu, končiaci na `iam.gserviceaccount.com`.
   Prístup obmedziť v **App permissions** na Dispatching TEST:
   - **View app information (read-only)**,
   - **Release apps to testing tracks**,
   - **Manage testing tracks and edit tester lists**, ak má automatizácia
     spravovať aj testerov.
   Úpravu draftu či záznamu obchodu pridať podľa konkrétnej úlohy.
   Produkčné vydávanie, administrátor ani finančné údaje pre tento krok netreba.
6. JSON nahrať priamo do **Expo → projekt Linka pomoci → Credentials →
   Android → Google Service Account Key** pre TEST aplikáciu.
   Submit profil používa kľúč uložený v EAS; do chatu ani repozitára ho netreba.
   Alternatívne ho možno nastaviť cez
   `eas credentials --platform android` → **Google Service Account** →
   **Manage your Google Service Account Key for Play Store Submissions**.
   Pre automatizáciu s lokálnym súborom možno neskôr nastaviť
   `serviceAccountKeyPath`; cesta podporuje aj premennú prostredia.

Samotné Developer ID ani bežný API key nenahradia tento prístup. Google už
nevyžaduje staré prepojenie Play účtu s Cloud projektom cez menu *API access*.
Overenie totožnosti a prípadné prvotné potvrdenia Play App Signing vykoná
majiteľ v konzole, ak ich Google vyžiada.

Oficiálne postupy: [Google Play API — Getting started](https://developers.google.com/android-publisher/getting_started),
[rozsah oprávnení](https://support.google.com/googleplay/android-developer/answer/9844686?hl=en),
[vytvorenie servisného účtu pre EAS](https://github.com/expo/fyi/blob/main/creating-google-service-account.md),
[EAS konfigurácia kľúča](https://docs.expo.dev/eas/json/#serviceaccountkeypath).

## Firebase pre Android push

Firebase je ďalšie samostatné nastavenie; Play publishing oprávnenia ho
nenahrádzajú. V projekte pre túto aplikáciu registrovať Android aplikáciu
`sk.linkapomoci.dispecing.test` a stiahnuť jej `google-services.json`.
Pre produkciu neskôr registrovať druhú aplikáciu `sk.linkapomoci.dispecing`.
Klientsky `google-services.json`, FCM V1 servisný kľúč a Play publishing kľúč
majú rozdielne účely.

## Kroky vývoja (po bodoch 1–3)

1. EAS: súborová premenná `GOOGLE_SERVICES_JSON` pre prostredie *preview* (TEST) a FCM V1 kľúč v Expo credentials (Android push).
2. `eas build --platform android --profile play-internal` (cloud alebo lokálne), kontrola package, verzie, API originu a TEST Supabase v balíku.
3. Po vytvorení aplikácie v Play Console nahrať konkrétny dokončený AAB cez
   `eas submit --platform android --profile play-internal --id <build-id>`.
   Aktuálny [Android Submit návod](https://docs.expo.dev/submit/android/)
   umožňuje vytvoriť aj prvé interné vydanie cez EAS; prvý ručný upload už
   neoznačujeme za povinný. [Ručné nahratie](https://docs.expo.dev/submit/android-manual/)
   zostáva alternatívou. Staršia Expo Security dokumentácia uvádza opačný
   postup; pri konkrétnom odmietnutí rešpektovať požiadavku Google Console.
4. Submit profil ponecháva vydanie v stave **draft**. Následne dokončiť
   internú testovaciu stopu a zoznam testerov; samotné nahratie nezaručuje
   dostupnosť pre testerov ani funkčné notifikácie.
5. Play Console: *Obsah aplikácie* — zásady ochrany súkromia `https://test.dispecing.linkapomoci.sk/aplikacia/sukromie` (produkcia vlastná URL), formulár *Bezpečnosť údajov* podľa privacy manifestu (meno, kontakt, poloha počas jazdy, fotky, identifikátory zariadenia; bez reklamy a sledovania), prístup pre kontrolu (testovací účet).

Cieľová úroveň API: nové aplikácie od 31. 8. 2026 musia cieliť na Android 16
(API 36); hodnotu overiť v konkrétnom AAB.
[Požiadavky Google Play](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).
Organizačný účet nemá povinné 14-dňové uzavreté testovanie s 12 testermi;
pri novom osobnom účte môže byť pred produkciou vyžadované.
[Pravidlá osobných účtov](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).
