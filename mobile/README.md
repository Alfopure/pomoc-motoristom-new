# Mobilný dispečing

Samostatná natívna aplikácia Expo 57 / React Native 0.86 pre iPhone a Android.
Web a jeho telefonovanie zostávajú v koreňovom Next.js projekte. Mobil má vlastný
`package-lock.json`, Node 24 a TypeScript 6; nie je súčasťou pnpm workspace.
Z webu importuje TypeScript typy a čisté spoločné definície stavov a filtrov
prípadov; serverové služby sa do mobilného balíka nezahŕňajú.

## Rozsah tejto verzie

- Prihlásenie existujúcim e-mailom a heslom cez Supabase Auth; obnova session.
- Na iOS/Androide session v Keychain/Keystore, vrátane väčších tokenov;
  v prehliadačovom náhľade iba pamäť. Heslo sa osobitne neukladá.
- **Kostra appky:** horná lišta so stavom operátora, prostredím a účtom;
  spodná lišta Prehľad · tri vlastné moduly · Moduly. Lištu si používateľ
  upraví cez Moduly → Upraviť lištu alebo „☆ Do lišty“ v module; voľba sa
  uloží v telefóne pre účet a profil. Podrobnosti sú v
  [dizajnovom štandarde](../docs/mobile/design-standard.md).
- **Prehľad:** hľadanie, hovory na účte, spätné volania, prípady, moje úlohy, stav telefónu
  a sekcia Treba riešiť s najnaliehavejšími upozorneniami.
- **Upozornenia:** spätné volania po termíne alebo s termínom do 15 minút, vaše úlohy
  po termíne alebo na dnes a horiace prípady organizácie, zoradené podľa naliehavosti;
  každá sekcia vedie na celý zoznam (Spätné, Moje úlohy, Prípady s filtrom Horí).
  Číta existujúce autorizované zoznamy, server ani push notifikácie nemení.
- **Lišta hovoru:** kým beží hovor v telefóne alebo na účte dispečera, nad spodnou
  lištou je zelený pás s menom, stavom a dĺžkou; ťuk vráti k hovoru.
- **Hľadať:** prípady celej organizácie (číslo, meno, EČV, telefón), hovory a moduly
  v jednom poli; výsledok otvorí detail prípadu, detail hovoru alebo modul.
- **Hovory → Ústredňa:** skutočný serverový stav operátora, jeho aktívne hovory,
  obnova potiahnutím a každých 30 sekúnd v popredí, pole pre číslo.
- **Hovory → História:** existujúce autorizované serverové vyhľadávanie, filtre,
  stránkovanie a výber čísla do ústredne. Výber nevytvorí hovor.
- **Prípady:** moje alebo všetky prípady organizácie, otvorené alebo všetky stavy,
  filter podľa dispečera aj nepridelené prípady, vyhľadávanie, stránkovanie, detail, založenie a úpravy prípadu,
  hlavná poznámka, historické poznámky, zmeny stavu a otvorenie navigácie.
  Súčasťou sú fotografie/dokumenty, úlohy prípadu a jeho odovzdanie.
  Predvolene sa zobrazia všetky otvorené. Používajú
  rovnaké záznamy a pravidlá ako web; fungujú aj v Expo Go.
  Nový rozsah pridáva potvrdené priradenie aktívnemu kolegovi aj pre bežného
  dispečera a WebView mapu s výberom adresy alebo bodu do formulára.
  Priradenie potrebuje schválenú atomickú databázovú funkciu; bez nej sa
  zobrazí ako nedostupné. Mapový výber sa uloží až spolu s prípadom.
  Pri novom aj upravovanom mieste možno vedome získať polohu telefónu,
  skontrolovať presnosť a zobraziť bod na mape pred potvrdením do formulára.
  Ide o polohu dispečerovho telefónu; [podrobnosti a skúšky](../docs/mobile/device-location.md).
- **Spätné volania:** v Histórii a v súhrne Ústredne; rovnaká fronta ako web,
  prevzatie, vybavenie/zrušenie s poznámkou a volanie späť v natívnej aplikácii.
  Volanie aj bežné vytáčanie potvrdzuje overené náhradné číslo kontaktu
  ([podrobnosti](../docs/mobile/callbacks.md)).
- **Po hovore:** v detaile hovoru výsledok s poznámkou, naplánovanie spätného
  volania a priradenie hovoru k prípadu s návrhmi podľa čísla
  ([podrobnosti](../docs/mobile/call-wrap-up.md)).
- **Moje úlohy:** všetky vlastné otvorené úlohy, výber úloh na kontrolu,
  aj dokončené, vyhľadávanie podľa názvu a prechod na prípad.
- **Účet** (avatar vpravo hore alebo Moduly → Účet a koncepty): meno, e-mail,
  rola, prostredie, úprava lišty, miestne koncepty a odhlásenie.
- **Nástroje:** samostatný modul v Moduloch (vozidlo, trasa, mapa, flotila).
- Rozpísané textové formuláre a pôvodné neisté príkazy sa na iPhone ukladajú
  do samostatného chráneného úložiska. Android potrebuje nový natívny build
  s kontrolou potvrdenia zápisu; starší Android/Expo Go a web používajú iba
  pamäť a rozhranie to označí. Obnova nikdy sama neodošle požiadavku.
- Odobratý prístup alebo neoveriteľná odpoveď skryje obsah; rôzne účty nemajú
  spoločnú cache. Dočasná chyba siete pri obnove už overeného profilu ponechá
  ovládanie hovoru s upozornením. Periodický polling sa zastaví v pozadí;
  prvé overenie identity sa dokončí aj po PushKit prebudení.

Aktuálny zdroj zahŕňa prípady, Moje úlohy, koncepty, priradenie a mapu. Konkrétne publikované
Expo Go a natívne buildy treba overiť podľa ich zdrojového commitu;
starší M1 build obsahuje iba prihlasovanie, ústredňu a históriu.
**iPhone voice TEST** pridáva lokálny Expo modul `modules/linka-voice` s natívnym
Telnyx iOS SDK 4.2.2, CallKit a PushKit. Apple Developer členstvo majiteľa čaká
na schválenie; majiteľ potvrdil spustenie Expo náhľadu na fyzickom iPhone.
Skutočné audio, APNs a systémové zvonenie na zamknutom zariadení zatiaľ
nie sú prijaté ako funkčné. Android hlas/FCM nasleduje po iPhone pilote.

Rozhranie používa žltú `#FCD703` (hlavná akcia formulára, „moje“), čierne a sivé
tlačidlá a zinc/sivé plochy webu.
Plávajúca spodná lišta má päť položiek s popisom (Prehľad, tri vlastné
moduly, žlté Moduly) a používa natívny Liquid Glass na podporovanom iOS 26+.
Dostupnosť modulu aj systémového API sa overí pred importom natívneho pohľadu.
Starší iPhone s dostupným BlurView má rozmazaný povrch; Android, web a zostava
bez týchto modulov čitateľný nepriehľadný povrch. Nastavenie **Znížiť
priehľadnosť** má prednosť; **Znížiť pohyb** vypne interaktívny sklenený efekt
aj pohyb výberu v lište. Zväčšené písmo zväčší lištu najviac 1,3×; obsah
rezervuje priestor aj pre spodný bezpečný okraj. Klávesnica dočasne skryje
lištu a po zatvorení ju obnoví. Farby, písmo a rozostupy sú v
`src/design/tokens.ts`.

GlassEffect 57.0.4 a BlurView 57.0.3 sú súčasťou Expo Go SDK 57.
Vlastná natívna zostava ich potrebuje zahrnúť pri novom buildovaní;
staršia zostava má bezpečný nepriehľadný povrch.
Podmienky natívneho efektu popisuje [dokumentácia Expo](https://docs.expo.dev/versions/latest/sdk/glass-effect/).

Jednorazové získanie polohy používa `expo-location` 57.0.21, súčasť Expo Go
SDK 57. Žiadosť vznikne iba po stlačení používateľom a používa oprávnenie
počas používania aplikácie. Pozadie, geofencing, motion ani lokalizačná
foreground služba sa neaktivujú. Konfigurácia vlastnej zostavy výslovne
vypína ich oprávnenia a nepotrebné iOS Always/motion popisy.
Zmena natívnych oprávnení/modulov vyžaduje nový vlastný build; publikovanie
Expo Go ho nenahrádza a staršie vlastné binárky nový dizajn/funkciu touto
aktualizáciou nedostanú. Natívne OTA zostávajú vypnuté.

Kontrakt úložiska, obnova a fyzické skúšky sú v [konceptoch](../docs/mobile/drafts.md).
Priradenie, mapové hranice a TEST akceptácia sú v
[samostatnom postupe](../docs/mobile/case-owner-map.md). WebView 13.16.1
a Clipboard 57.0.2 zodpovedajú SDK 57; vlastné staršie natívne balíky
potrebujú nové zostavenie. Expo Go má svoje dostupné natívne moduly.
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
`sk.linkapomoci.dispecing.test`, podpis a TEST konfiguráciu aj obsah konkrétneho zdroja;
úspešný build nedokazuje fyzické prihlásenie, audio ani zvonenie.

## iPhone TEST náhľad

Majiteľ má na fyzické skúšky iPhone. Aktuálny náhľad možno otvoriť v **Expo Go**
pre SDK 57 a prihlásiť sa TEST operátorským účtom. Expo Go musí byť prihlásené
do Expo účtu `alfopure`, ktorý vlastní organizáciu `linkapomoci`; tento Expo
login je odlišný od následného operátorského prihlásenia v aplikácii.

Odovzdaný QR smeruje na **publikovanú skupinu EAS Update**. Jej balík
poskytuje Expo, takže ostáva dostupný aj po vypnutí tohto workspace
a vývojového servera. Pri opätovnom otvorení použite uložený QR alebo
záznam v Expo Go. Odkaz skupiny označuje konkrétnu aktualizáciu; ďalšia
vydaná verzia dostane nový overený QR. Stav backendu a kompatibilita
nainštalovaného Expo Go so SDK 57 sa overujú samostatne. Dočasný lokálny
Metro server slúži iba na vývoj.

iOS riadi vykonávanie aplikácie na pozadí. Pri uspanej aplikácii sa
periodické čítanie zastaví a po návrate sa obnoví. Systémové prichádzajúce
hovory na zamknutom iPhone ostávajú samostatnou natívnou funkciou.

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
| `/api/mobile/v1/cases/overview` | GET počty otvorených, mojich, nepriradených a urgentných prípadov organizácie |
| `/api/mobile/v1/cases/[id]` | GET detail prípadu organizácie, PATCH s presnou revíziou a identitou uloženia |
| `/api/mobile/v1/cases/[id]/notes` | POST historická poznámka s identitou proti duplicitnému zápisu |
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

Pred odhlásením sa odpojí mobilný telefón. Ak sa odpojenie nepodarí, prihlásenie
zostane zachované a možno zopakovať odhlásenie. Supabase môže odstrániť lokálnu
reláciu aj pri chybe serverového odhlásenia. Aplikácia vtedy na prihlasovacej
obrazovke oznámi dokončené miestne odhlásenie a nepotvrdený serverový výsledok;
miestne odstránenie musí potvrdiť auth udalosť, nie samotná chyba. Nové
prihlásenie zruší starú spätnú väzbu. Vlastná offline revokácia sa
neimplementuje. Fyzické prijatie základnej appky aj živého telefonovania sa
zaznamenáva samostatne od úspešného exportu.

Androidové systémové tlačidlo Späť používa návrat z aktuálnej obrazovky.
Počas ukladania sa návrat spotrebuje bez opustenia formulára; pri neistom
výsledku ostáva pôvodný príkaz v pamäti. Z prvej obrazovky modulu sa
používateľ vráti do Prehľadu, z modulu otvoreného v Moduloch do Modulov;
účet sa zatvorí. Z Prehľadu rozhoduje systém. Fyzická skúška tlačidla aj gesta
na Androide zostáva samostatnou akceptáciou.

Prvé jednoznačné odmietnutie editora pre neprihlásenie, prístup alebo chýbajúci
prípad možno obnoviť až po úspešnom načítaní aktuálneho detailu a vedomom
porovnaní/prebázovaní alebo zahodení konceptu. Neskoršia chyba neistého zápisu
ani nesúlad identity príkazu nepovolia novú operáciu. Výber príloh odstraňuje
overené pracovné kópie z cache po zachytení bajtov, aj pri odmietnutí súboru;
pôvodné súbory mimo cache neodstraňuje a opakovanie používa zachytené bajty.
