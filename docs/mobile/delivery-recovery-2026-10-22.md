# Pristavenia: obnova nepotvrdeného kroku – 22. 10. 2026

Pokračovanie [auditu spoľahlivosti](reliability-audit-2026-10-22.md) na pokyn
majiteľa „pokračuj ešte ďalej“. Ide o ďalšie vydanie zdrojov cez `dev` na
stabilný TEST, nie o schválenie produkcie.

## Zistenia a vykonaná oprava

| Zistenie | Výsledné správanie |
| --- | --- |
| Pri strate odpovede mobil zahodil identitu odoslaného kroku. | Pred POST sa uloží presná požiadavka. Ďalší krok na tom istom pristavení čaká na vyriešenie výsledku. „Overiť rovnaký krok“ opakuje tú istú požiadavku vrátane dôvodu, ETA a revízií. |
| Odchod z detailu alebo nový vstup do účtu odstránil miestny kontext požiadavky. | Čakajúce kroky sú v zozname Pristavenia; po návrate do toho istého účtu sa obnovia a samy sa neodosielajú. |
| Nesúvisiaca potvrdená revízia mohla vyzerať ako úspech. | Mobil aj server vyžadujú `committedRevision = expectedRevision + 1` a aktuálnu revíziu aspoň takú vysokú ako potvrdenú. |
| Staršie GET mohlo po úspešnom kroku vrátiť obrazovku späť. | Detail ani zápis do cache neprepíše vyššiu revíziu nižšou. Rovnaká revízia stále obnovuje napr. GPS. |
| Potvrdenie starého dialógu alebo rozpracovaného dôvodu pracovalo so starou kartou. | Pred odoslaním sa znovu kontroluje otvorený detail, popredie a revízia aj publikovaná verzia. Zmenenú kartu treba skontrolovať a potvrdiť znova. |
| Cache identity prežila odmietnutý zoznam alebo vypnutie modulu. | Odmietnutie alebo neoveriteľná odpoveď skryje celý terénny pracovný priestor a ukončí používanie starého zdieľania polohy. Bežný výpadok stále umožní čítať posledný známy stav. Odmietnutie príkazu, detailu alebo sledovania sa prenesie do celej relácie hneď; staršie rozpracované čítanie ho nemôže zrušiť. |
| Počas prípravy odhlásenia bolo možné začať ďalší krok. | Zápisy aj ručné spustenie polohy sú zablokované hneď pri začatí odhlásenia. Neskorá odpoveď sa po zmene účtu nepoužije. Pri zlyhaní odhlásenia zostáva neistý krok obnoviteľný. |

## Ukladanie a hranice

- iOS používa samostatnú službu Keychain, iba na tomto zariadení a po
  odomknutí. Údaje sú rozdelené existujúcim atómovým úložiskom relácií;
  potvrdenie miestneho zápisu predchádza sieťovej požiadavke.
- Android potrebuje existujúcu kontrolu potvrdeného zápisu SecureStore.
  Staršia binárka bez nej požiadavku neodošle. Web používa iba pamäť a
  upozorňuje, že zatvorenie stránky záznam nezachová.
- Rozsah obsahuje prostredie, konkrétny Supabase projekt, účet a člena.
  Neukladá kartu zákazníka, GPS ani prihlasovacie či sledovacie tokeny;
  zachováva len identitu pristavenia, akciu, čas a potrebný dôvod/ETA.
- Nečitateľný záznam sa automaticky neprepíše. Chyba miestneho uloženia
  zastaví odoslanie. Výsledok timeoutu, 5xx alebo neplatnej odpovede zostane
  neistý; nový identifikátor ho nenahradí.
- Výslovné odmietnutie 400/404/409/422 umožňuje uzavrieť miestne upozornenie
  až po novom načítaní aktuálneho stavu alebo jeho výslovnom 404. Uzavretie
  upozornenia neruší zápis na serveri.
- SQL, produkcia, poskytovatelia a plánovanie sa týmto vydaním nemenia.
  Používa sa existujúca idempotencia `motorist_member_handoff`.

## Overenie

Pred opravou päť nových mobilných a dva serverové prípady reprodukovali
konkrétne chyby. Ďalšie testy pokrývajú prípravu pred transportom, dvojité
ťuknutie, reštart kontroléra, presné opakovanie, oddelenie účtov, nečitateľné
úložisko, zlyhanie zápisu/uzavretia, stratu prístupu a prerušené odhlásenie.
Pridaných je 40 mobilných a dva serverové regresné prípady. Celé existujúce
balíky prešli: 1 287 mobilných, 8 425 serverových Vitest a 76 kontrol Node;
typy, mobilný lint, iOS/Android export a `expo install --check` prešli.
Nasadený `dev` SHA zaznamenáva handoff konkrétneho PR.

Skutočný vstup aplikácie prešiel 20 scenármi v prehliadači na šírkach 390 a 320 b so
syntetickým API, autentifikáciou a natívnymi portmi. Zahŕňa zápis s následne
stratenou odpoveďou, návrat zo zoznamu, obnovu účtu bez automatického POST,
chybu úložiska, starý dialóg, oneskorené GET, 409 s novou kontrolou, odobratie
prístupu, vypnutý modul a pomalé odhlásenie. Nenahrádza fyzické skúšky Keychain,
reštartu iOS, zvuku, push alebo pohybu telefónu.

Serverový Preview a stabilný TEST musia prejsť existujúcou build bránou;
nasadenie sa identifikuje cez `/api/health/live` aj Git SHA vo Verceli.
HTTP smoke dokladá zdravie a autentifikačné hranice, nie fyzický mobilný krok.

## Natívne vydanie a postup skúšky

TestFlight **0.1.0 (19), zdroj `ecbe6d1a`, tieto nové mobilné opravy neobsahuje**.
OTA je vypnuté. Samotné nasadenie TEST servera JavaScript v iPhone nezmení.

Blokovanie kapacitou z 22. 10. je vyriešené [lokálnym Xcode buildom](local-ios-build.md).
Majiteľ nainštaloval a spustil Xcode; 23. 10. sa na Macu zostavil build
**0.1.0 (21)** z `dev` `0cc412c649a15a9071fd3c42d525884fe3b07e4d`.
Podpísaná IPA prešla 32 nezávislými kontrolami vrátane vložených nových
opráv a TEST identity. Apple potvrdil `VALID`, `IN_BETA_TESTING`
a prístup existujúcej internej skupiny „Team (Expo)“; build je dostupný
cez TestFlight. Free iOS cloud kvóta Expo zostáva 15/15;
platený plán ani nový Expo projekt neboli potrebné. Build 19 sa nemení.

Po doručení nového buildu na TEST účte:

1. Otvoriť pridelené pristavenie a potvrdiť krok pri slabom signále.
2. Pri nepotvrdenom výsledku prejsť späť do zoznamu. Otvoriť „Nepotvrdené
   kroky“ a „Overiť rovnaký krok“; história smie mať len jeden príslušný zápis.
3. S neistým výsledkom aplikáciu ukončiť a znova spustiť. Prihlásiť ten istý
   účet; krok sa má obnoviť bez automatického odoslania. Iný účet ho nevidí.
4. Pri konflikte načítať aktuálny stav, skontrolovať ho a až potom uzavrieť
   odmietnutý krok. Počas neistého výsledku sa ďalší krok nevytvára.
5. Overiť prijatie, polohu, dokončenie a odhlásenie v oboch pohľadoch;
   pokračovať [fyzickou akceptáciou](release-readiness.md).
