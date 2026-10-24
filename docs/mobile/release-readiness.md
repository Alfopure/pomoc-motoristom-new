# Pripravenosť mobilnej aplikácie na nasadenie (iPhone)

Aktualizované 24. 10. 2026 po internom vydaní mobilnej fázy 1. Aktuálny
[audit spoľahlivosti a plán](reliability-audit-2026-10-22.md) obsahuje zistenia,
rozsah opráv a otvorené skúšky. Podrobná história F1–F6 je nižšie.

Pokračovanie auditu: [nepotvrdené kroky pristavení a strata prístupu](delivery-recovery-2026-10-22.md).
Nový mobilný zdroj sa nesmie zamieňať so staršou nainštalovanou binárkou.
[Lokálny Xcode build](local-ios-build.md) **0.1.0 (23)** obsahuje opravy
PR #494, opravu pádu pri štarte z PR #496 aj prvú fázu z PR #507.
Apple potvrdil dostupnosť
v internom TestFlighte (`VALID`, `IN_BETA_TESTING`). Release simulátor
iOS 27 overil skutočne viditeľné prihlásenie v štyroch scenároch.
Historická kontrolná verzia s pôvodným lifecycle má zachovaný crash
s presnou UIKit chybou; jej hashe a nezmenené natívne vstupy boli overené.
Build 21 sa pre pád pri štarte nepoužíva. Fyzická akceptácia aktualizácie
a živých integrácií je samostatná.

Mobilná fáza 1 je na TESTe v `f3926dc4` (PR #507): úplná podporovaná
flotila do 1 000 vozidiel, obnova prístupov a Uložiť a odovzdať na webe
aj mobile. Podpísaný build **23** prešiel 34 kontrolami IPA aj čerstvým
vizuálnym overením štartu. Apple potvrdil dostupnosť v TestFlighte
24. 10. o 18:18 UTC. Spoločný fyzický test je odložený podľa pokynu majiteľa;
[checklist prvej fázy](phase-one-acceptance.md) je pripravený.

## Aktuálny stav

| Oblasť | Stav |
| --- | --- |
| Distribúcia TEST | **Dispatching TEST 0.1.0 (23)**, zdroj `f3926dc4`: lokálny build, 34 kontrol IPA a štyri čerstvo vizuálne overené natívne scenáre štartu; Apple `VALID`, `IN_BETA_TESTING`, existujúca interná skupina má build. OTA vypnuté. |
| Server TEST s prvou fázou | Funkčný rozsah `dev` `f3926dc4`, https://test.dispecing.linkapomoci.sk; overené health a metadáta dedikovaného nasadenia. Aktuálny deployment/commit čítať z `/api/health/live`; následná aktualizácia dokumentácie aplikačný zdroj nemení. |
| Telefonovanie | Natívny Telnyx/CallKit/PushKit, TEST hlas a VoIP push zapnuté; serverové opravy #489–#491 sú na TEST a fungujú aj s buildom 18. |
| Fyzická skúška | Majiteľ potvrdil úspešné dovolanie aj pri zamknutom mobile. Ostatné kombinácie sa neoznačujú za overené bez samostatnej skúšky. |
| Apple | Aktívny účet MICT s. r. o.; TEST App ID, App Store Connect, podpis, Expo APNs a Telnyx TEST VoIP credential pripravené. |
| Základ aplikácie | Prihlásenie, kostra a moduly, prípady, úlohy, spätné volania, koncepty, kontext hovoru a odovzdanie sú na TEST. |
| Úkony hovoru | Prijať/odmietnuť, ukončiť, stíšiť, reproduktor, klávesnica, podržať, prepojiť na kolegu a zastaviť nahrávanie sú v kóde. Fyzická akceptácia každého úkonu je samostatná. |
| Pristavenia | Modul roly pristavovača, odovzdanie z dispečingu, kroky a poloha na pozadí sú na TEST vrátane SQL a prepínača. Pohyb a zastavenie na iPhone ešte treba doložiť. |
| Bežné push upozornenia | Kód, TEST SQL a prepínač aj Expo APNs sú pripravené; reálne doručenie a otvorenie cieľa treba doložiť. |
| Podklady vydania | Ikona, spúšťacia obrazovka, skutočná verzia/build v Účte, zásady súkromia, podpora, privacy manifest, hlásenie chýb JavaScriptu a minimálna verzia sú implementované. |
| Produkcia | Mobilné vydanie nie je schválené ani nasadené; produkčné API, SQL, poskytovateľ a binárka potrebujú konkrétny release. |
| Android | Základná TEST aplikácia bez natívneho hlasu; produkčná distribúcia je ďalšia etapa. |

## Čo zostáva pred každodennou prevádzkou

1. Pri spoločnom teste použiť novú verziu: prvá fáza je na stabilnom TEST v `f3926dc4`,
   podpísaný build 23 prešiel aj natívnym overením štartu a aktualizuje sa
   cez TestFlight podľa [postupu](testflight.md). Serverový deploy nezmení JavaScript v
   nainštalovanom builde, keďže OTA sú vypnuté. [Checklist prvej fázy](phase-one-acceptance.md)
   zostáva odložený a nevyplnený podľa pokynu majiteľa.
2. Na fyzickom iPhone prejsť [akceptáciu hovorov](iphone-voice-test.md#akceptácia-na-fyzickom-iphone):
   príjem v popredí, na pozadí a pri zamknutí, obojsmerný zvuk, výpadok siete,
   súbeh web/mobil, podržanie, prepojenie, zastavenie nahrávania a ukončenie.
   Úspešný zamknutý hovor je prvý potvrdený výsledok.
3. Doložiť doručenie bežných push notifikácií a polohu pristavovača počas
   pohybu, aj po návrate signálu a po ukončení pristavenia.
4. Pripraviť presný produkčný release diff. Porovnať potrebné DB objekty
   čítaním katalógu; starý počet PR a zoznam názvov migrácií z 19. 10. nie je
   aktuálny plán SQL. Produkčný projekt a presný SQL musia byť schválené.
5. Produkčný hlas je stále samostatne vypnutý. Pripraviť presné produkčné
   APNs/Telnyx zdroje a kódový rozsah až v schválenom vydaní.
6. Dokončiť produkčnú binárku, účet pre kontrolu Apple, metadata, snímky,
   review a nezaradenú distribúciu podľa [podkladov App Store](app-store.md).

## Rozhodnutia a hranice

Vydavateľ **MICT, s. r. o.**, názov **Dispatching**, jedna aplikácia s modulmi
podľa roly; nezaradená distribúcia App Store. Push notifikácie a hlásenie
chýb sú schválené. TEST má vlastnú databázu a poskytovateľské zdroje.
Produkčný release vyžaduje výslovné schválenie konkrétneho rozsahu podľa
[release postupu](../operations/release-workflow.md).

[Postup TestFlightu](testflight.md) uvádza build, podpis a nahratie;
[iPhone TEST postup](iphone-voice-test.md) uvádza technické hranice a rollback.
Kompilácia, simulátor ani zdravý server nenahrádzajú fyzickú akceptáciu.

## História rozsahu verzie 1 (F1–F6)

Rozhodnutia majiteľa z 19. 10. 2026: vydavateľ **MICT, s. r. o.** (IČO 53 167 422,
Žilina), pracovný názov **Dispatching**, **nezaradená distribúcia** v App Store,
text zásad ochrany súkromia pripraví vývoj, **push notifikácie schválené**.
Dňa 20. 10. 2026 doplnil: **hlásenie pádov áno**, z úkonov v hovore stačí
**prepojenie**, zoznam push notifikácií v F3 platí.
Cieľ: dokončiť hovory a dispečerský základ, potom aplikáciu zmraziť; po
príchode licencie už iba overovať a opravovať, nie pridávať funkcie.

### Čo do verzie 1 patrí

**F1 – Hovor v aplikácii** (hotové na TEST po zlúčení PR #475)
- Obrazovka hovoru v štandarde: zbalený pás hore s menom, stavom a časom,
  po ťuknutí celá obrazovka s veľkými tlačidlami (Stíšiť, Klávesnica,
  Nahlas, Podržať, Ukončiť).
- Kontext volajúceho priamo v hovore: linka a jej partner, známy kontakt;
  tlačidlá Nový prípad a Detail hovoru (z detailu aj Prípad hovoru).
- Zavolať jedným ťuknutím z prípadu, detailu hovoru a histórie (aj z detailu
  otvoreného cez Hľadať), keď je telefón pripravený (s potvrdením a overeným
  číslom); hovor z prípadu sa k prípadu priradí.

**F2 – Úkony v hovore, ktoré mobil nemá a web áno** (hotové v aplikácii, čaká na TEST)
- **Prepojiť hovor na kolegu** (výber z dostupných kolegov aj na mobile).
- **Zastaviť nahrávanie** – zákazníkom sľubujeme, že na požiadanie ho
  dispečer zastaví; bez toho mobil nemôže ostro prijímať zákaznícke hovory.

**F3 – Push notifikácie** (na TEST zapnuté 22. 10. 2026; APNs kľúč v Expo, doručenie overí TestFlight)
- Nová úloha pre mňa, vrátená alebo na kontrolu; termín úlohy.
- Spätné volanie po termíne (moje prevzaté, nepridelené).
- Prípad priradený mne.
- Text bez údajov zákazníka; ťuk otvorí správnu obrazovku.
- Zapínanie podľa druhu v Účte.
- Doručenie cez službu Expo (pod ňou Apple APNs); každý príjemca dostane
  udalosť raz (záznam v archivovaných upozorneniach), odinštalovaná aplikácia
  sa vyradí, telefón nepoužitý 30 dní sa vynechá. Spätné volania po termíne
  posiela existujúci päťminútový cron ako pomocnú úlohu (bez nového workera).
- Zapnutie v prostredí: tabuľka `motorist_mobile_push_devices` (migrácia
  `20261020210000_mobile_push_devices.sql`, schválená iba pre TEST) a
  `MOBILE_PUSH_ENABLED=true` v projekte Vercel; bez nich server nič neposiela
  a Účet to povie. Na Preview vetiev ostávajú vypnuté vždy.
- Známe obmedzenia: pri výpadku služby Expo dlhšom ako jedno zopakovanie sa
  notifikácia o úlohe alebo prípade stratí (spätné volania skúsi cron znova);
  telefón, ktorému vypršalo prihlásenie bez odhlásenia, dostáva notifikácie
  účtu do ďalšieho prihlásenia na ňom, najviac 30 dní; pri neskorej odpovedi
  Expo môže výnimočne prísť tá istá notifikácia dvakrát.

**F4 – Pripravenosť na vydanie** (v aplikácii hotové okrem produkčnej cesty hlasu;
podklady pre App Store v `docs/mobile/app-store.md`)
- Názov Dispatching, ikona a spúšťacia obrazovka, verzia a build v Účte.
- Zásady ochrany súkromia a Podpora (verejné stránky) a odkazy v Účte.
- Privacy manifest, odpovede pre App Store Connect, texty do App Store.
- Kontrola minimálnej verzie (vynútenie aktualizácie).
- Hlásenie pádov (schválené).
- Produkčná cesta hlasu pripravená v kóde, ale vypnutá prepínačmi na
  serveri, kým neprejde akceptácia na TEST.

**F5 – Dokončenie** (hotové na TEST: PR #478 a opravy po kontrole)
- Odovzdanie prípadu v novom vzhľade; posledná kontrola všetkých obrazoviek
  na 390 a 320 b (prehliadačový náhľad, 234 krokov na šírku); zmrazenie.
- Známe obmedzenia v1:
  - Brána minimálnej verzie sa rozhoduje pri štarte v popredí; aplikácia
    spustená prichádzajúcim hovorom na pozadí ju uplatní až pri ďalšom štarte.
  - Chyba v samotnom ráme aplikácie (mimo obrazoviek a hovoru) stále odpojí
    telefón; obrazovky, moduly a obrazovka hovoru majú vlastné hranice.
  - Telefonovanie z produkčnej aplikácie je vypnuté (natívny hlas funguje len
    pod TEST identifikátorom aplikácie); zapnutie je samostatné rozhodnutie.

**F6 – Pristavovač v aplikácii** (na TEST od 22. 10. 2026: PR #482 a #484, migrácie aplikované)
- Požiadavka majiteľa z 22. 10. 2026: dispečer odovzdá prípad pristavovačovi
  aj priamo v aplikácii (nielen odkazom v SMS), pristavovač v nej vidí prípad,
  kam ísť a ktoré auto zobrať – popis hore, mapa dole – a dispečer vidí, kde je.
- Dispečer: pri novom odovzdaní vyberie v časti Komu pristavovača alebo iného
  príjemcu iba s odkazom; odovzdanie, ktoré čaká na prijatie, vie poslať do
  aplikácie aj dodatočne. Odkaz cez SMS alebo zdieľanie funguje ďalej. Pri
  odovzdaní vidí značku V aplikácii, stav, polohu pristavovača („pred 3 min“,
  presnosť) a Ukázať pristavovača na mape; kým je pristavovač na ceste,
  obrazovka sa obnovuje každých 30 s.
- Pristavovač: člen odťahovej služby s rolou **Pristavovač** (web, Zákazky →
  Prístupy a vodiči), bez dispečerského profilu, takže na dispečerské údaje
  nemá prístup. Prihlási sa do tej istej aplikácie a vidí iba Pristavenia:
  zoznam (na vybavenie, dokončené za deň), detail s náhradným autom (EČV, GPS),
  miestom, časom, pokynmi a klientom hore a mapou (Apple Maps) dole; kroky
  Prijať → Vyrážam → Som na mieste → Auto odovzdané, čas príchodu, Odmietnuť
  alebo Problém s dôvodom; Zavolať, navigácia k autu a na miesto. Po skončení
  telefón údaje klienta nezobrazuje. Notifikácia Nové pristavenie (vypínač
  Pristavenia v Účte).
- **Jedna aplikácia s modulmi** (majiteľ 22. 10. 2026): Dispečing sú moduly
  dispečerskej roly (Hovory, Prípady, Úlohy, Nástroje), Pristavenia samostatný
  modul roly pristavovač. Pristavovač má rovnakú kostru (Prehľad · Pristavenia ·
  Moduly, Účet, stav polohy vľavo hore); kto má obe roly, vidí oboje.
- **Poloha aj na pozadí** (majiteľ 22. 10. 2026): v zostavenej aplikácii pre
  iPhone pokračuje na pozadí, pri zamknutom telefóne a po zatvorení aplikácie
  systémom; iOS ju obnoví aj po vynútenom zatvorení, ale iba pri väčšom presune
  a nie spoľahlivo (pozri zdroje). Posiela sa kľúčom jedného pristavenia, nie
  prihlásením; bez signálu čaká v telefóne najviac 12 h. Expo Go polohu na
  pozadí nepodporuje: tam sa posiela, kým je aplikácia otvorená.
- Poloha: o povolenie aplikácia požiada až po prijatí (alebo inom vlastnom
  kroku pristavovača v aplikácii; neskôr aj tlačidlom Zdieľať polohu
  s dispečerom) a potom o „Vždy“; posiela ju najviac raz za 20 s.
  Server ju prijme iba od pristavovača, ktorý v aplikácii urobil krok, a iba
  počas otvoreného pristavenia; potom telefónu povie, aby prestal. Maže ju po
  30 dňoch (pomocná úloha existujúceho cronu, aj pri vypnutom prepínači).
- Po skončení, zrušení alebo vypršaní pristavenia telefón nedostane údaje
  klienta ani polohu auta; po dni pristavenie zo zoznamu zmizne a nedá sa otvoriť.
- V časti Komu sú iba pristavovači, ktorí sa môžu prihlásiť do aplikácie:
  zapnutý prístup s rolou Pristavovač v aktívnej organizácii; kto má aj
  dispečerský profil, musí ho mať aktívny (vidí potom oba moduly).
- Staršia verzia servera s touto migráciou funguje ďalej (údaje odovzdania sa
  pre ňu nemenia), nová verzia bez migrácie výber pristavovača neukáže.
- Zapnutie v prostredí: migrácie `20261022100000_mobile_delivery_handoffs.sql`
  a `20261022180000_mobile_delivery_background.sql` (v tomto poradí, až po
  migrácii push tabuľky; na TEST aplikované 22. 10. 2026) a
  `MOBILE_DELIVERY_ENABLED=true` v projekte Vercel (dedikovaný TEST projekt ho má
  od 22. 10. 2026, iba cieľ Production); na Preview vetiev vypnuté vždy.
- Známe obmedzenia: poloha na pozadí sa dá overiť až v zostavenej aplikácii
  (build z TestFlightu); Android má zatiaľ iba polohu s otvorenou aplikáciou;
  mapa ukáže iba miesta so súradnicami; odťahy dostanú obdobnú, samostatnú
  časť neskôr.

### Čo do verzie 1 nepatrí (neskôr)

Konzultácia pred prepojením a konferencia, čakáreň, dozor vedúceho, SMS,
režim bez pripojenia, zámok Face ID, tmavý režim a režim Rukavice, moduly
vodiča a zákaziek odťahu, serverový zoznam modulov a synchronizácia lišty,
Android vydanie.

### Potom

1. Upratanie vydania: súpis 51 PR, kontrola produkčnej databázy čítaním,
   schválené migrácie, jedno pripravené vydanie na produkciu.
2. TestFlight: TEST build, APNs, akceptácia hovorov a pristavovača ([postup](testflight.md)).
3. Ostrá prevádzka: účet pre kontrolu Apple, produkčný build, review, nezaradená distribúcia.

## Zdroje

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [SDK minimum requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution/)
- [Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods)
- [Expo: Apple privacy manifest](https://docs.expo.dev/guides/apple-privacy/)
- [Expo: App Store Connect minimum SDK 26](https://expo.dev/blog/app-store-connect-minimum-sdk-26)
- [Expo: TestFlight](https://docs.expo.dev/submit/testflight/)
- [Apple fórum: Guideline 3.2 Business](https://developer.apple.com/forums/thread/704518)
- [Expo: Location (poloha na pozadí, Expo Go)](https://docs.expo.dev/versions/latest/sdk/location/)
- [Apple fórum: obnovenie po vynútenom zatvorení (iOS 26)](https://developer.apple.com/forums/thread/826964)
