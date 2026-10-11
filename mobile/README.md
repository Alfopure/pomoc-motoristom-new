# Mobilný dispečing — prvý základ

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
- **Účet:** meno, e-mail, rola, prostredie a odhlásenie z tohto zariadenia.
- Odobratý prístup alebo chyba čítania skryje obsah; rôzne účty nemajú
  spoločnú cache. Obnova a polling sa zastavia v pozadí.

**Táto verzia ešte netelefonuje ani nezvoní.** Neobsahuje Telnyx native SDK,
PushKit/CallKit, FCM ani Android call service. Tlačidlo Zavolať je neaktívne,
capabilities sú pevne `voice: false`, `presenceWrite: false`. Stav Dostupný
opisuje účet v existujúcej ústredni, nie pripojenie tohto mobilného telefónu.
Mobil nevydáva SIP token, nerobí heartbeat ani nemení prezenciu/ring plán.
Read-only kontrakt v1 ponechať dostupný starším buildom aj po pridaní hlasu;
natívny hlas má dostať nový kontrakt pre build so skutočným voice enginom.

Nasledujúci krok a merateľná akceptácia sú v [stratégii](../docs/mobile/strategy.md).

## Lokálne spustenie

```sh
cd mobile
npm ci
cp .env.example .env.local
# V .env.local doplňte iba publishable/anon kľúč TEST projektu.
npm run start:go
```

Vlastný development build sa spúšťa cez `npm start`. Expo Go postačí na tento
základ s prihlasovaním a čítaním; neskoršie systémové telefonovanie vyžaduje
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

Majiteľ má na fyzické skúšky iPhone. M1 možno otvoriť v aktuálnom **Expo Go**
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
Expo Go slúži na prihlásenie, ústredňu a históriu; CallKit/PushKit ani skutočné
telefonovanie cez vlastné native moduly v ňom nie sú dostupné.

## Natívny iOS proof pre telefonovanie

Profil `voice-proof-simulator` pridáva WebRTC plugin a pri štarte overí importy
nižšieho Telnyx SDK 1.1.0 a WebRTC 124.0.8. Nevytvára klienta, socket ani
provider hovor a neprijíma SIP credentials. Používa TEST backend a SDK 57
image; simulator build nepotrebuje Apple podpis. Na fyzickom iPhone použiť
profil `voice-test` až po príprave Apple Developer podpisovania a zariadenia.

```sh
npx eas-cli@24.12.1 build --platform ios --profile voice-proof-simulator
```

SDK má nevyhlásené runtime imports `rxjs` a AsyncStorage, preto sú explicitne
pridané. Supabase session zostáva v SecureStore. Pred prvým skutočným SIP
loginom treba preveriť/opraviť transport `react-native-websocket-self-signed`,
vynútené debug logovanie SDK v development a ukladanie push payloadov. Proof
nepoužíva tento transport ani jeho persistenciu. CallKit, PushKit, native cold
start, secure SIP lifecycle a serverové call actions sú nasledujúca fáza;
kompilácia ani import proof nedokazujú obojstranné audio alebo zvonenie.

EAS/Vercel sú odlišné vydania: Vercel nasadí mobilné API, nie inštalovateľnú
appku. Expo Go náhľad má vlastnú identitu; automatické store vydanie sa nenastavuje.

## Mobilné API v1

Všetky tri GET routy vyžadujú **overený Supabase user JWT** v `Authorization:
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
