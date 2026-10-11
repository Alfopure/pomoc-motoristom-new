# Mobilný dispečing

Samostatná natívna aplikácia Expo 57 / React Native 0.86 pre iPhone a Android.
Web a jeho telefonovanie zostávajú v koreňovom Next.js projekte. Mobil má vlastný
`package-lock.json`, Node 24 a TypeScript 6; nie je súčasťou pnpm workspace.
Z webu importuje iba vymazateľné TypeScript typy z `src/lib/mobile-api.ts`.

## Rozsah tejto verzie

- Prihlásenie existujúcim e-mailom a heslom cez Supabase Auth; obnova session.
- Na iOS/Androide session v Keychain/Keystore, vrátane väčších tokenov;
  v prehliadačovom náhľade iba pamäť. Heslo sa osobitne neukladá.
- **Ústredňa:** skutočný serverový stav operátora, jeho aktívne hovory,
  obnova potiahnutím a každých 30 sekúnd v popredí, pole pre číslo.
- **História:** existujúce autorizované serverové vyhľadávanie, filtre,
  stránkovanie a výber čísla do ústredne. Výber nevytvorí hovor.
- **Prípady:** moje alebo všetky prípady organizácie, otvorené alebo všetky stavy,
  filter podľa dispečera, vyhľadávanie, stránkovanie, detail a založenie prípadu.
  Predvolene sa zobrazia všetky otvorené. Používajú
  rovnaké záznamy a pravidlá ako web; fungujú aj v Expo Go.
- **Účet:** meno, e-mail, rola, prostredie a odhlásenie z tohto zariadenia.
- Odobratý prístup alebo neoveriteľná odpoveď skryje obsah; rôzne účty nemajú
  spoločnú cache. Dočasná chyba siete pri obnove už overeného profilu ponechá
  ovládanie hovoru s upozornením. Periodický polling sa zastaví v pozadí;
  prvé overenie identity sa dokončí aj po PushKit prebudení.

Aktuálny Expo Go náhľad zahŕňa aj prípady; pôvodný M1 build ostáva pri
prihlasovaní, ústredni a histórii.
**iPhone voice TEST** pridáva lokálny Expo modul `modules/linka-voice` s natívnym
Telnyx iOS SDK 4.2.2, CallKit a PushKit. Apple Developer členstvo majiteľa čaká
na schválenie; majiteľ potvrdil spustenie Expo náhľadu na fyzickom iPhone.
Skutočné audio, APNs a systémové zvonenie na zamknutom zariadení zatiaľ
nie sú prijaté ako funkčné. Android hlas/FCM nasleduje po iPhone pilote.

Rozhranie používa žltú `#FCD703`, čierne tlačidlá a zinc/sivé plochy webu.
Natívny telefón má pripojenie, vytáčanie, prijatie/odmietnutie, ukončenie,
mikrofón, reproduktor, DTMF a Dostupný/Pauza. Aktívny hovor zostáva viditeľný
pri zmene záložky. Prebiehajúci hovor sa zobrazí až po potvrdení spojenia
ústredňou; HTTP 202 ukončenie sa sleduje do potvrdenia serverom.

Read-only kontrakt v1 nemení capabilities (`voice: false`, `presenceWrite:
false`), aby starší M1 nedostal prísľub chýbajúceho native enginu. Hlas má
samostatné POST routy pod `/api/mobile/v1/voice`. V Expo Go sa nepoužijú.
Prípady majú samostatné routy `/api/mobile/v1/cases`; zápis neaktivuje telefón.
Rozsah a overenie sú v [postupe pre mobilné prípady](../docs/mobile/cases.md).

Nasledujúci krok a merateľná akceptácia sú v [stratégii](../docs/mobile/strategy.md).

## Lokálne spustenie

```sh
cd mobile
npm ci
cp .env.example .env.local
# V .env.local doplňte iba publishable/anon kľúč TEST projektu.
npm run start:go
```

Vlastný development build sa spúšťa cez `npm start`. Expo Go postačí na
prihlásenie, čítanie a zakladanie prípadov; systémové telefonovanie vyžaduje
vlastný natívny build. Použite existujúci **TEST** účet, nie produkčné heslo.
API `/api/mobile/v1/*` musí byť nasadené na kanonickom TEST.

## Prostredia

| Variant / EAS profil | Aplikácia | API | Supabase |
| --- | --- | --- | --- |
| development | `sk.linkapomoci.dispecing.dev` | `https://test.dispecing.linkapomoci.sk` | `nzpnqdstvkfncflgqlny` |
| test / test-simulator | `sk.linkapomoci.dispecing.test` | rovnaký TEST | rovnaký TEST |
| production | `sk.linkapomoci.dispecing` | `https://dispecing.linkapomoci.sk` | `ifpaeegaesdmljfkdvcn` |

Bundle/package IDs sú návrh pre túto aplikáciu; nie sú registrované u Apple
ani v Google Play. Variant bez konfigurácie používa development. Produkcia
vyžaduje výslovne production variant aj kompletnú production konfiguráciu.
URL, projekt a prostredie musia zodpovedať tabuľke; nemajú fallback ani prepínač.
Mobil posiela `X-PM-App-Environment` a overuje prostredie, verziu aj profil
každej odpovede. Service-role a `sb_secret_*` kľúče sú odmietnuté.

Mobil je prepojený na vlastnú Expo organizáciu **Linka pomoci**, kde má účet
`alfopure` rolu Owner, a projekt
[`@linkapomoci/linka-pomoci-dispecing`](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing).
Project ID `c7363382-9b12-4e12-9f62-31ec7b8c5623` a owner sú verejné metadata
uložené v `app.config.ts`. Voliteľné `EAS_PROJECT_ID` musí zodpovedať tomuto
projektu; ERP/Alfo project ID sa odmietne.

EAS prostredia `development` a `preview` majú iba TEST API origin, TEST
Supabase URL a TEST publishable key. EAS production konfigurácia sa zatiaľ
nenapĺňa. Žiadny Telnyx account kľúč ani Supabase serverový kľúč nepatrí do mobilu.

Profil `test` vytvára samostatné podpísané APK s pribúdajúcim versionCode,
Node 24.14.1 a Android image `sdk-57`. Nepotrebuje Metro ani Expo Go. Build
spustiť z `mobile/` s bezpečne dostupným Expo prístupom:

```sh
npx eas-cli@24.12.1 build --platform android --profile test
```

Pred odovzdaním skontrolovať dokončený build, source commit, package
`sk.linkapomoci.dispecing.test`, podpis a TEST konfiguráciu. APK testuje M1;
úspešný build nedokazuje fyzické prihlásenie, audio ani zvonenie.

## iPhone TEST náhľad

Majiteľ má na fyzické skúšky iPhone. Aktuálny náhľad možno otvoriť v **Expo Go**
pre SDK 57 a prihlásiť sa TEST operátorským účtom. Expo Go musí byť prihlásené
do Expo účtu `alfopure`, ktorý vlastní organizáciu `linkapomoci`; tento Expo
login je odlišný od následného operátorského prihlásenia v aplikácii.

Publikovanie používa iba EAS `preview` a samostatnú vetvu `iphone-m1-test`:

```sh
APP_VARIANT=test EXPO_PUBLIC_APP_ENV=test MOBILE_EXPO_GO_PREVIEW=1 \
  npx eas-cli@24.12.1 update --branch iphone-m1-test --platform ios \
  --environment preview --message "iPhone M1 TEST"
```

`MOBILE_EXPO_GO_PREVIEW=1` nastavuje update URL a runtime iba pre tento TEST
náhľad. Produkcia tento režim odmieta. Natívne buildy majú OTA aktualizácie
vypnuté a tento náhľad neaktivuje telefonovanie v pôvodnom Android APK.
Expo Go slúži na prihlásenie, ústredňu, históriu a prípady. CallKit/PushKit
a telefonovanie cez vlastné native moduly vyžadujú samostatný natívny build.

## Natívny iPhone telefón

Profil `voice-proof-simulator` kompiluje Swift TelnyxRTC 4.2.2 a jeho WebRTC
150 cez CocoaPods. Boot probe overí modul `LinkaVoice`; nevydáva provider
hovor. Cloudová kompilácia nepreukazuje štart, audio, CallKit UI ani push.
Profil `voice-test` je pre podpísaný fyzický iPhone po schválení Apple,
registrácii TEST App ID/zariadenia a nastavení príslušného APNs VoIP certifikátu.

```sh
npx eas-cli@24.12.1 build --platform ios --profile voice-proof-simulator
# Manuálna kompilácia a skutočný štart v cloudovom simulátore:
npx eas-cli@24.12.1 build --platform ios --profile voice-smoke-simulator --non-interactive
# Až s Apple podpisom:
npx eas-cli@24.12.1 build --platform ios --profile voice-test
```

Natívny `ExpoAppDelegateSubscriber` spustí CallKit/PushKit pred JS. Každý
VoIP push hlási systémový hovor bez čakania na JS alebo server a potom ukončí
neplatnú/zrušenú ponuku. Prijatie čaká na JWT-auth overenie presnej mobilnej
SIP identity, aktuálnej rezervácie a ponuky. CallKit aktivuje/deaktivuje audio.
Vytáčanie prebieha cez existujúci serverový call service; klient len prijme
**presný operator leg potvrdený serverom pre HTTP session**. iOS SDK poskytne
call-control ID až po odpovedi, preto sa prvý INVITE autorizuje podľa jeho
leg UUID. Nepoužíva priame SDK dial.

Provider JWT, push token a payload zostávajú v natívnej/JS pamäti. V Keychain
sa ukladá Supabase Auth session a revokovateľné UUID relácie zariadenia;
nie SIP heslo či Telnyx account key. SDK logovanie aj odosielanie call reports
sú vypnuté. Pôvodný React Native SDK proof a jeho self-signed transport sa
odstránili; iPhone používa natívny SDK. Natívny modul je zapnutý len pre TEST
bundle ID a explicitný voice profil. Produkčný variant ho nemôže aktivovať.

Server vyžaduje presnú identitu dedikovaného TEST deploymentu a
`MOTORIST_NATIVE_VOICE_TEST_ENABLED=true`; Preview ani produkcia mobilný
pilot nespustia. APNs routing má ďalší samostatný prepínač
`MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED=true`. **Oba zostávajú vypnuté**, kým
sa neoverí podpis a provider konfigurácia. JWT auth platí aj pri vypnutej
funkcii. Cleanup aktuálnej vlastnej TEST relácie ostáva možný po jej vypnutí;
produkčné alebo cudzie zdroje sa neovládajú.

Mobil má samostatný device row a provider credential, neprevezme webový
telefón. Opačný mobil možno prevziať len explicitným potvrdením a bez
prebiehajúceho hovoru. Logout najprv vypne native klienta a revokuje provider
credential; provider chyba ponechá uloženú reláciu pre bezpečné opakovanie.

Pozadie nemá JS keepalive. Po overenej APNs konfigurácii server uchová iba
revokovateľnú dostupnosť zariadenia v existujúcom `metadata.native_voip`,
s platnosťou najviac 7 dní a po dobu platnosti provider credential. Ide o
pilotnú, ohraničenú dostupnosť, nie potvrdenie doručenia push. Registrácia
sa obnovuje v popredí; cold start obnoví JWT zo zabezpečenej Auth session.
Webový interný hovor zvolí pripojený natívny TEST telefón kolegu; zákaznícke
hovory používajú existujúce application/mobile endpointy incoming flow.
Žiadna migrácia, nový listener alebo cron sa kvôli tomu nezavádza.

Pred zapnutím oboch prepínačov dokončiť [iPhone runbook](../docs/mobile/iphone-voice-test.md).
EAS/Vercel sú odlišné vydania: Vercel nasadí mobilné API, nie inštalovateľnú
appku. Expo Go náhľad má vlastnú identitu; automatické store vydanie sa nenastavuje.

## Mobilné API v1

Mobilné routy vyžadujú **overený Supabase user JWT** v `Authorization:
Bearer …`, správne prostredie a aktívny ľudský profil v serverom odvodenej
organizácii. Cookies, cron secret a dev bypass sa neprijímajú. JWT podpis,
issuer, audience, rola authenticated a expirácia sa kontrolujú na serveri;
organizačná rola sa číta z profilu. Bez prihlásenia je odpoveď 401, bez prístupu
403, nesprávne prostredie 409, nedostupný backend 503. Odpovede sú `no-store`.

| Route | Údaje |
| --- | --- |
| `/api/mobile/v1/me` | profil a capabilities tohto prvého vydania |
| `/api/mobile/v1/console` | vlastná prezencia a vlastné aktívne hovory; iba čítanie |
| `/api/mobile/v1/calls/history` | `category`, `q`, `cursor`, `limit`; existujúca autorizovaná história |
| `/api/mobile/v1/cases` | GET prehľad/filtre/stránky, POST nový prípad |
| `/api/mobile/v1/cases/[id]` | GET detail prípadu organizácie |
| `/api/mobile/v1/cases/dispatchers` | GET obmedzený organizačný výber dispečerov |

História nevracia provider identifikátory, nahrávky, prepisy, interné udalosti
ani poznámky prípadov. Pri chýbajúcom autorizovanom search RPC je 503 namiesto
neoznačeného zoznamu bez filtra. TEST používa historicky pomenovaný telephony
namespace `development`; application environment v DTO zostáva `test`.
Routy nevykonávajú provider operácie ani recovery/sweep aktívnych hovorov.

Prehliadačový export slúži na test rozhrania s mockovaným transportom;
verejné cross-origin CORS ani cookie transport sa kvôli nemu nezapínajú.

## Kontroly

```sh
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo-doctor
npm run export:ios
npm run export:android
```

Workflow Mobile checks overuje zdroj a oba JS balíky bez živých kľúčov.
Serverové auth/route testy sú v `src/server/mobile/`; zahŕňajú skutočné ES256
podpisy s lokálnym syntetickým JWKS, expiráciu, cudzie prostredie, deaktiváciu
profilu a minimalizáciu DTO. Nenahrádzajú fyzickú skúšku prihlásenia,
Keychain/Keystore ani budúceho obojstranného audia.

Pri zlyhaní siete odhlásenie ukáže chybu a vyžaduje zopakovanie, kým Supabase
potvrdí lokálne odhlásenie. V tejto fáze sa neimplementuje vlastná offline
revokácia. Fyzické prijatie základnej appky aj živého telefonovania sa
zaznamenáva samostatne od úspešného exportu.
