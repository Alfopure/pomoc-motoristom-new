# Systémové iPhone hovory — TEST pilot

Cieľ: web zavolá kolegovi, iPhone zobrazí systémový hovor aj pri zamknutí,
Prijať spojí obojstranné audio, Odmietnuť/Ukončiť zastaví príslušný hovor.
Toto je odlišné od Expo Go náhľadu a bežnej vizuálnej notifikácie.

## Aktuálny stav

Majiteľ 11. 10. 2026 potvrdil, že spustil Expo náhľad na iPhone. Jeho Apple
Developer členstvo čaká na schválenie. Natívny Swift SDK/CallKit/PushKit,
JS ovládanie a JWT-auth TEST API sú pripravené v kóde. Cloudová kompilácia,
unit testy ani verejný bundle nie sú dôkazom audia/APNs na fyzickom telefóne.
Príjem zákazníckych hovorov vyžaduje existujúci incoming flow s application
endpointom a správnu prezenciu; samotné prihlásenie v mobile nemení ring plán.

## Zapojenie po schválení Apple

1. V správnom Apple tíme registrovať `sk.linkapomoci.dispecing.test`, zapnúť
   Push Notifications a pripraviť signing pre interný TEST build na iPhone.
   Neskorší produkčný App ID `sk.linkapomoci.dispecing` bude mať vlastnú
   konfiguráciu a vydanie. Existujúce Alfo identifikátory nemeníme.
2. Vytvoriť **VoIP Services** certifikát pre TEST App ID. Pripnúť ho cez
   samostatný TEST Telnyx iOS push credential na overenú TEST credential
   connection. Overiť bundle ID, platnosť certifikátu, production APNs režim
   zhodný s interným EAS buildom a provider resource provenance. Nemeniť
   produkčnú connection. Súkromný kľúč/certifikát nepatrí do Git, mobilného
   bundle, verejných EAS premenných ani bežného Preview.
3. Dokončiť `eas build --platform ios --profile voice-test` a nainštalovať
   podpísaný build. Overiť jeho source SHA, TEST API/Supabase, bundle ID,
   entitlement `aps-environment=production`, `audio`/`voip` background modes,
   natívny modul a vypnuté OTA. App Store publikovanie zatiaľ nie je potrebné.
4. Iba v **Production target dedikovaného TEST Vercel projektu** nastaviť
   `MOTORIST_NATIVE_VOICE_TEST_ENABLED=true`, nasadiť aktuálne `dev` afresh
   a overiť canonical health/SHA. Pripojiť TEST operátora v mobile; overiť
   foreground prijatý a odchádzajúci hovor, audio a cleanup. Toto povolenie
   nevytvára produkčné vydanie. Aktuálne opt-in zatiaľ nie je nastavený.
5. Po overení APNs resource a PushKit registrácie zapnúť tamtiež samostatné
   `MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED=true`. Neprenášať ho do Preview
   ani produkcie. Nový heartbeat vytvorí iba revokovateľnú `native_voip`
   dostupnosť, nie uložený push token. Dostupnosť je viazaná na aktuálnu
   device lease a platný credential, maximálne 7 dní. Po vypnutí prepínača
   okamžite prestáva oprávňovať routing. Provider push registration a cold
   refresh po expirácii JWT sa ešte musia fyzicky overiť.

[Apple PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)
vyžaduje okamžitý natívny CallKit report. Kroky pre provider certifikát sú v
[Telnyx iOS VoIP setup](https://support-v2.telnyx.com/en/articles/8268170-how-to-setup-ios-push-notifications).
[SDK 4.2.2](https://github.com/team-telnyx/telnyx-webrtc-ios/releases/tag/4.2.2)
sa pinne v lokálnom podspecu. Simulátor neoveruje APNs ani fyzické audio.

## Akceptácia na fyzickom iPhone

Každú skúšku zapísať so source SHA, build ID, TEST deployment SHA, anonymnou
call/session identitou a výsledkom; neukladať JWT, push payload ani telefónne
čísla do verejných PR komentárov.

| Scenár | Očakávaný výsledok |
| --- | --- |
| Web → pripojený TEST kolega | Systémový CallKit hovor, správny volajúci, jedno audio spojenie |
| Zamknutý iPhone po > 2 minútach | Reálne zvonenie aj bez JS heartbeat, Prijať/Odmietnuť funguje |
| Cold launch / app ukončená systémom | Report pred JS, obnova Auth/device lease, overenie ponuky, audio |
| Odpoveď pred dokončením JS/auth | CallKit answer čaká na presnú autorizáciu; timeout končí bezpečne |
| JWT po > 24 hodinách, dostupnosť pred jej expiráciou | VoIP push stále príde; cold refresh vydá nový JWT a spojí hovor |
| Web aj mobil odpovedia naraz | Jeden víťaz serverovej rezervácie, druhý leg ukončený |
| Volajúci ukončí / oneskorený alebo duplicitný push | Žiadny obnovený/zaseknutý hovor, ponuka sa neprijme |
| Vytáčanie, sieťový timeout, opakovanie | Jeden serverový pokus s rovnakým request UUID a presným operator leg |
| SDK operator leg ACTIVE, adresát stále zvoní | UI ešte neoznačí rozhovor za spojený |
| Mikrofón/reproduktor/DTMF/ukončenie | Obojstranné audio; serverové 202 ostáva pending do potvrdenia |
| Odhlásenie, odobratý prístup, prevzatie na inom mobile | Starý mobil sa neprihlási, credential je revokovaný; web ostáva oddelený |
| Wi-Fi ↔ mobilné dáta, výpadok siete, Bluetooth | Stav nevydáva neexistujúce spojenie za funkčný hovor |
| Vypnutie native/push flagov | Nové native provider operácie/routing sú blokované; TEST cleanup dostupný |

Ručné force-quit používateľom je samostatný fyzický scenár so správaním iOS;
nepredpokladať rovnaký wake-up ako pri systémovom ukončení procesu.

## Rollback a hranice

Vypnúť oba prepínače v dedikovanom TEST a nasadiť aktuálne `dev`. Tým sa
zastaví nové pripojenie a push dostupnosť; autorizované ukončenie/disconnect
sa nezablokujú vypnutím creation flagu. Cleanup musí prejsť existujúcou
TEST provider provenance kontrolou, aj keď sú nové provider operácie vypnuté.
Pri chybe provider revokácie zopakovať disconnect; úspech nepotvrdzuje len
lokálne zavretie CallKitu. Pracovné Preview nikdy neobsluhuje stabilné TEST
telefóny. Žiadna migrácia/seed, nový worker alebo listener sa týmto kódom
nenasadzuje; ostáva jediný existujúci päťminútový telephony cron.

Produkčné native zapnutie vyžaduje samostatný, konkrétny release scope,
produkčnú konfiguráciu a výslovné schválenie majiteľa po TEST akceptácii.
