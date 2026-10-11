# Jednoduchý mobilný dispečing: stratégia a prvé vydanie

Stav auditu: **2026-10-11**. Majiteľ oznámil nasadenie novej produkčnej verzie
a následne vybral „Plán aj prvý základ v kóde“. Cieľ je natívna aplikácia pre
iPhone a Android s existujúcim prihlásením, ústredňou a telefonovaním.

## Overené východisko

| Oblasť | Overenie pred implementáciou |
| --- | --- |
| Produkcia | `1830bbebfb26096a52785d1fd775d3e745665dc4`; canonical live/ready 200; deployment `dpl_3BrzFASPozuuEGMBao7P7NcofwD3` |
| Stabilný TEST | `f338a4a1101bac18c3c96cba5cab5e5b7a118eb5`; canonical live/ready 200; deployment `dpl_2DvC8gqihjs4drvsc9sGxQJu6gQk` |
| Obsah | `main` a `dev` mali rovnaký git tree; release code `c7bf94e6fe46` |
| Prihlásenie | Supabase Auth, **e-mail a heslo**; organizačný profil a rola |
| Telefonovanie | Telnyx WebRTC na webe, serverové Call Control, routing, prezencia, história, mobile device namespace |
| Schéma | V oboch vlastných databázach read-only potvrdené mobile devices, applicationDevice ring offers, mobile call preference a history search RPC |
| Alfo | `Alfopure/alfo`, čítaný main `696209287937485b0ae3b61e277dea04522c7edd`; Expo 57/RN 0.86, secure login a postupné moduly; natívny voice/push stále ďalšia fáza |

Z Alfo preberáme spôsob oddelenia mobilu, auth a build varianty. Jeho
databáza, session-context protokol, Expo project ID a credentials sa nepreberajú.
Health dokazuje nasadenie aplikácie, nie úspešný hovor alebo push.

## Rozsah mobilnej verzie 1

Pôvodné tri záložky: **Ústredňa — História — Účet**. Pred nimi obyčajné prihlásenie
e-mailom a heslom. Zabudnuté heslo otvorí existujúcu obnovu na správnom webe.
Operátor používa svoj aktuálny účet a serverové oprávnenia.

Ústredňa vo výslednom telefonujúcom vydaní ponúkne stav Dostupný/Pauza,
telefónne číslo a Zavolať. Pri hovore zobrazí volajúceho, Prijať/Odmietnuť
a po spojení Ukončiť, stíšenie mikrofónu, audio výstup a DTMF. Rozlíši
vytáčanie, zvonenie, pripájanie audia a skutočne spojený hovor.

História použije existujúce výsledky hovorov, filtre Všetky/Zmeškané/Prijaté/
Odchádzajúce, vyhľadávanie a ďalšie stránky. Z čísla možno pripraviť spätné
volanie; hovor začne až po výslovnom stlačení Zavolať. Účet zobrazí vlastnú
identitu, prostredie a odhlásenie.

Pôvodné prvé vydanie zahŕňalo ústredňu, históriu a účet. Počas čakania na
Apple členstvo majiteľ 11. 10. 2026 požiadal aj o prehľad a zakladanie
prípadov. Tento modul možno vyvíjať a skúšať v Expo Go nezávisle od podpisu
a systémového telefonovania. SMS, konfigurácia ústredne, manažérsky dozor
a archív nahrávok ostávajú samostatnými budúcimi rozhodnutiami.

## Poradie realizácie

| Míľnik | Výsledok | Podmienka prijatia |
| --- | --- | --- |
| **M1 — základ, tento rozsah** | samostatný mobil, prihlásenie, read-only ústredňa, autorizovaná história, účet; backend API v1 | kontroly zdroja/DTO/auth, JS balíky oboch platforiem, TEST deployment; osobitne fyzický login a čítanie |
| **M2 — natívny telefón** | proof build Telnyx SDK, mikrofón/audio session, systémový call UI, tokenové prihlásenie | podpísaný iPhone a Android build, skutočný prijatý a odchádzajúci hovor s obojstranným audiom |
| **M3 — zvonenie spiaceho mobilu** | APNs VoIP/PushKit/CallKit a FCM/Android call integration; registrácia/revokácia zariadenia | web zavolá kolegovi a zamknutý mobil po nečinnosti reálne zvoní; expirovaná/zrušená ponuka sa neprijme |
| **M4 — bežná služba** | natívny endpoint v ring pláne, pauza/obsadenosť, jeden víťaz, fallback, caller ID a história | príjem zo zákazníckej linky a volanie z mobilu pri bežnej službe; web a mobil majú zhodný stav |
| **M5 — pilot a release** | identifikovaný TEST mobile build + backend commit; až potom schválený production rozsah | fyzické skúšky nižšie, odovzdanie majiteľovi, jeho explicitné schválenie; App Store/Play neskôr |

M2/M3 zostávajú otvorené pre fyzické skúšky po získaní Apple podpisu a push
konfigurácie. Popri nich vzniká na pokyn majiteľa modul prípadov uvedený
nižšie. Tlačidlo Zavolať v Expo Go zostáva neaktívne a rozhranie to
vysvetľuje. Čítanie prípadov, mock ani JS export nepreukazujú telefonovanie.

## Prípady počas čakania na Apple

Poradie vychádza z bežnej práce mobilného dispečera:

1. **Prehľad, detail a založenie:** nová záložka Prípady,
   predvolene všetky otvorené prípady, filter podľa dispečera a všetky stavy,
   vyhľadávanie a detail.
   Krátky formulár uloží kontakt, vozidlo, miesto, popis, typ zákazky,
   prioritu a poznámku do toho istého systému ako web.
2. **Doplnenie a spolupráca:** úpravy prípadu, ďalšie poznámky a zmeny stavu
   s kontrolou aktuálnej serverovej revízie, aby mobil neprepísal zmenu kolegu.
3. **Práca v teréne:** fotografie, prílohy, poloha a otvorenie navigácie.
4. **Organizácia služby:** úlohy, termíny a prevzatie/odovzdanie prípadu
   podľa existujúcich oprávnení a pravidiel webu.

Aktuálny rozsah je prvý bod. Ostatné body opisujú ďalšie rozšírenia.
Zakladanie je výslovná online operácia; výpadok nesmie spustiť automatické
opakované odoslanie. Úspešný zápis sa oddelí od následného načítania detailu.
Podrobný kontrakt a TEST skúšky sú v [mobilných prípadoch](cases.md).

## Architektúra a rozhodnutia pred M2/M3

```mermaid
flowchart LR
  W[Webový dispečing] --> B[Existujúci backend a pravidlá hovorov]
  M[Native mobil: login / ústredňa / história] -->|Overený user JWT| B
  B --> S[Správna Supabase: TEST alebo production]
  B --> T[Telnyx: serverové Call Control]
  T --> P[APNs VoIP / FCM]
  P --> N[CallKit / Android call service]
  N --> M
  M <-->|Natívny SDK a audio| T
```

**Server riadi hovory.** Mobilné vytáčanie musí ísť cez existujúci
`startOutboundCall`: overenie čísla/linky, caller ID, kill switch, limit
a idempotentný request ID. Najprv vznikne operátorská vetva; automaticky
prijať možno iba presnú vlastnú vetvu z výslovného odchádzajúceho pokusu.
Priame SDK vytáčanie externého čísla by tento tok obišlo.

**Rovnaký actor, nový transport.** M1 má výhradne overené Bearer user JWT
a serverový lookup aktívneho ľudského profilu. Existujúce cookie/CSRF routy
sa nemenia. Mutujúce mobilné routy sa pridajú až spolu s natívnym telefónom
a znovu použijú rovnaké serverové call-actions a kontroly vlastníctva.
Každé prijatie/odmietnutie/ukončenie sa viaže na presnú ponuku, session,
device lease a prostredie; teleso requestu nevyberá actor-a.

**Spiaci mobil potrebuje vlastnú dostupnosť.** Dnešná živá registrácia
s heartbeat do 120 s nemôže rozhodovať o prebudení natívneho zariadenia.
Oddeliť pripojený SIP endpoint od zariadenia oprávneného dostať VoIP push.
Platný push token nie je dôkaz doručenia. Ponuka ostáva krátka, s aktuálnym
ownerom a existujúcim timeout/fallbackom. Nerobiť nekonečný background socket,
falošný heartbeat ani nový worker/listener/cron.

**Web → kolega dnes vyberá webové zariadenie.** Rozšíriť
`resolveColleagueTarget` na natívny mobile endpoint a zachovať obsadenosť,
pravidlá interného volania počas pauzy a pravidlá zákazníckeho ring plánu.
PWA `mobile_app` je dnes len nainštalovaný web; native registrácia bude
jednoznačne odlíšená od jeho Web Push tokenov.

**SDK sa musí overiť buildom.** Prvý kandidát je oficiálny
[Telnyx React Native SDK/Voice Commons](https://github.com/team-telnyx/react-native-voice-commons).
Pri prvom audite má Commons 1.1.1 vlastnú Expo 53 závislosť a demo RN 0.79,
kým náš základ je Expo 57/RN 0.86. Neznamená to dokázanú kompatibilitu.
Overiť wrapper a nižší SDK na oboch platformách; podľa výsledku použiť
nižšiu natívnu integráciu alebo Swift/Kotlin SDK. Auth tokeny nech zostanú
v chránenom úložisku; neprebrať demo persistenciu do AsyncStorage.

**Jeden vlastník push doručenia.** Preferovať podporovaný Telnyx push tok.
Push cold start už môže spustiť native login: JS boot nesmie urobiť druhý
login a zrušiť hovor. Overiť dlhý spánok a obnovu expirovaného SIP JWT,
presný CallKit/Android answer callback a serverovú rezerváciu jedného víťaza.
Zrušený hovor, prevzatá ponuka alebo odhlásený účet ukončia systémovú ponuku.
HTTP 202 pri hangup znamená čakajúce ukončenie, nie potvrdený koniec hovoru.

Na iOS treba okamžitý natívny report skutočného VoIP hovoru do CallKitu,
na Androide call notifikáciu a správne vedenie call/audio služby. Vývojový
build umožňuje vlastné native knižnice;
[Expo Go nenahrádza native build](https://docs.expo.dev/develop/development-builds/introduction/).
Systémové postupy: [Apple PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit),
[Android Telecom](https://developer.android.com/develop/connectivity/telecom/voip-app/telecom).

## Čo pripraviť pre natívny pilot

- Samostatný Expo/EAS projekt dispečingu; bezpečne dostupný Expo prístup.
- Apple Developer prístup, App ID, signing a podporované APNs VoIP credentials
  pre TEST variant; iPhone na fyzické testy.
- Firebase app pre vlastný Android TEST package a providerom podporované
  FCM credentials; Android na fyzické testy.
- Overené Telnyx TEST connection/device resources a push mapping; M1 ich nemení.
- TEST účet operátora a konkrétne vzájomné hovory. Potvrdiť názov a IDs pred
  ich vonkajšou registráciou; konfiguračné IDs v M1 sú pracovný návrh.

Majiteľ potvrdil zatiaľ iba Expo účet z Alfo a následne výslovne požiadal
o nastavenie cez dostupné Conductor API. Cez ním dodaný Expo prístup je
vytvorená organizácia **Linka pomoci** (`linkapomoci`), kde má používateľ
`alfopure` rolu Owner, a samostatný projekt
[`@linkapomoci/linka-pomoci-dispecing`](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing),
ID `c7363382-9b12-4e12-9f62-31ec7b8c5623`. Alfo projekt sa nepreberá.
EAS development/preview majú iba TEST konfiguráciu; EAS production zatiaľ
nemá konfigurované premenné. Credentials sa neukladajú do zdroja.

Podpísané Android TEST APK M1 0.1.0 (versionCode 2) je dokončené a overené.
Majiteľ následne spresnil, že má iba **iPhone**. Priorita pilotu je preto
iPhone: M1 náhľad v Expo Go cez samostatnú EAS vetvu `iphone-m1-test`, potom
vlastný podpísaný iOS TEST s natívnym telefonovaním. Oba varianty zostávajú
v rozsahu vývoja. Expo Go náhľad neaktivuje OTA v natívnych ani produkčných
buildoch a nemení živé provider resources.

Majiteľ potvrdil otvorenie Expo Go náhľadu na fyzickom iPhone a oznámil,
že **Apple Developer členstvo čaká na schválenie**. Na Macu aktuálne nie je
Xcode ani pripravený podpis; cloudový simulator build nepotrebuje Apple
podpis. Vlastný build na fyzický iPhone a VoIP push vyžadujú signing aj pred
verejným App Store vydaním. Nepýtame sa opakovane na už oznámené členstvo.

Prvý RN SDK/WebRTC import proof sa nahrádza natívnym iOS SDK **4.2.2** cez
lokálny Expo modul. CallKit/PushKit vznikajú pred JS; audio aktivuje systém.
JWT, token PushKit a payload zostávajú v pamäti, SDK logs/call reports sú
vypnuté. Bez JS bootstrapu sa nový provider token neprijíma; zabezpečená
Supabase session a UUID device lease dovolia cold-start overenie operátora.

JWT-auth serverové voice routy zdieľajú existujúce vytáčanie, rezerváciu,
hangup a provider provenance guardy. Povolené sú iba v dedikovanom TEST
pod samostatnými opt-in prepínačmi. Background dostupnosť je revokovateľná
7-dňová pilotná lease v existujúcom mobile device metadata, bez falošného
heartbeat. Zoznam potrebných krokov, prepínače, rollback a fyzické skúšky
sú v [iPhone TEST runbooku](iphone-voice-test.md). Kompilácia nenahrádza
obojstranné audio ani zvonenie zamknutého iPhone. Android voice/FCM zostáva
nasledujúcim implementačným krokom po iPhone pilote.

## Akceptácia telefonujúcej verzie

| Skúška na fyzickom iPhone aj Androide | Dôkaz |
| --- | --- |
| Popredie, pozadie a zamknutý displej | skutočné zvonenie podľa systémových nastavení a obojstranné audio |
| Aspoň 10 min a potom viac než 24 h nečinnosti | nezávislosť na web heartbeat, obnova expirovaného tokenu |
| Odmietnutie, volajúci zloží, timeout | ukončenie call UI, žiadna nová vetva z neskorého pushu, správna história |
| Web a mobil prijmú súčasne | jeden víťaz a zrušenie ostatných ponúk |
| Mobil → externé číslo a web → mobil | existujúci caller ID, serverové pravidlá, správne automatické prijatie len vlastnej outbound vetvy |
| Pauza, obsadenosť, ring plán | zhodné pravidlá s webom a existujúci fallback |
| Wi-Fi ↔ dáta, Bluetooth, zamknutie počas hovoru | stabilný mikrofón/audio výstup a konzistentné ukončenie |
| Odhlásenie, deaktivácia, výmena zariadenia | revokácia push/device identity; stará aplikácia neprijme hovor |
| Nerušiť, zakázané povolenie, úspory, force stop | zaznamenané správanie OS/výrobcu, bez tvrdenia bezpodmienečného doručenia |
| Súčasne TEST a production | správny backend, podpisový variant a provider provenance |

Merať čas od požiadavky po systémovú ponuku a po začiatok obojstranného
audia. Toleranciu dohodnúť podľa merania pred širšou službou.

## Hranice nasadzovania

Zdroj prvého základu: [mobile/README.md](../../mobile/README.md).
Bežný postup: pracovná vetva → Preview/PR do dev → stabilný
[TEST](https://test.dispecing.linkapomoci.sk) → overený scope a odovzdanie
majiteľovi → až jeho explicitné schválenie produkčného vydania.
Vercel deployment nedistribuuje mobilnú appku; EAS build má vlastnú identitu.

M1 nepotrebuje SQL migráciu, zmenu provider nastavení ani produkcie.
M2/M3 pripravia konkrétny SQL/provider rozsah; aplikácia SQL vyžaduje
výslovnú autorizáciu presného projektu a zmien podľa AGENTS.md. Neaplikovať
všetky pending migrácie. Zachovať samostatné TEST resources, povolené bežné
TEST volanie a jediný existujúci päťminútový cron. Preview nesmie obsluhovať
živé TEST devices. Retired VIPTel/Watchdog resources sú mimo tohto projektu.
