# Opravy po testovaní 9. 9. 2026

Realizácia vychádza z kritického auditu prepisu a skutočných aplikačných/provider logov. Používateľ schválil implementáciu aj nasadenie. Pracovná vetva vznikla z `dev` na `d675d66`; existujúce zmeny plánovača trás zostali zachované.

**Stavy:** „Hotové“ znamená implementované a automatizovane overené. „Čiastočne“ znamená hotovú softvérovú časť s uvedeným zostávajúcim overením. Automatizované provider modely ani potvrdené členstvo konferencie nepreukazujú fyzickú počuteľnosť.

| Úloha | Priorita | Stav | Realizácia a dôkaz | Čo ešte overiť |
|---|---|---|---|---|
| T01a – súbežný polling/nahrávanie | P0 | Hotové | Sweep bez zámku zachová policy, epochu a pending audio; provider udalosti vyžadujúce vlastníctvo zostávajú opakovateľné. Súbežné regresie. | Reálny hovor pri dvoch otvorených klientoch. |
| T01b – pokračovanie spojenia | P0 | Hotové | Kontrola identity operácie, vlastníka a topológie povoľuje neškodné zmeny verzie. JSONB porovnávanie nezávisí od poradia kľúčov. CAS checkpoint neopakuje úspešný START/STOP. | Fyzický zvuk; testy zavesenia, námietky a zmeny vlastníka prešli. |
| T02 – pravdivý stav spojenia | P0 | Hotové | „Pripája sa zvuk“, potvrdené členstvo oboch účastníkov, upozornenie po 30 s. Zavesiť zostáva dostupné; pokročilé operácie čakajú na spojenie. | Overiť počuteľnosť oboch účastníkov, nie iba stav UI. |
| T03 – prvá dostupnosť | P1 | Hotové | Výzva novému účtu a explicitné „Som dostupný“ cez existujúci zápis; viditeľná chyba. Bez automatického zapnutia dostupnosti pri prihlásení. | Prvý nový živý účet a prichádzajúca ponuka. |
| T04a – token rezervácie | P0 | Hotové | Prenos vlastníctva pickup/answer/transfer/release aj pri vypnutom príznaku. Stará udalosť neuvoľní novší token. | Ďalší živý hovor a následná dostupnosť. |
| T04b – uviaznutá prezencia | P0 | Hotové | Obnova v existujúcom päťminútovom crone: terminálna relácia, všetky vetvy skončené, token/revízia/session CAS; zachovaný návrat do pauzy. | Po vydaní skontrolovať výsledok cronu a historické uviaznuté riadky. |
| T04c – skutočný SQL kontrakt | P1 | Hotové | Lokálny PostgreSQL 15: 23 skupín SQL kontrol a 7 skupín skutočných aplikačných workflow. Matica off/off, on/on, on/off. | Nejde o plný test Supabase RLS/PostgREST. |
| T05 – dočasná 503 | P0 | Hotové | Explicitný `not_configured`; ostatné 503 zachovajú ovládanie/polling. Obnova tokenu 200→503→200 zachová existujúci registrovaný SDK klient a hovor. Browser aj controller regresia. | — |
| T06 – podržanie/obnovenie | P1 | Čiastočne | Riadenie hold/unhold, súbehy a chyby pokryté automatizovane; 503 už neskryje ovládanie. | Reálna hudba pri podržaní a obojstranný zvuk po obnovení. Pôvodný presný dôvod dvoch 503 zostáva nedoložený. |
| T07 – dôvod blokovania Prevziať | P1 | Hotové | Viditeľný text a akcia dostupnosti. Browser overenie 360/390/768/1280 px. | — |
| T08 – parkovanie/transfer | P1 | Čiastočne | Regresie pickup, park, interný aj externý attended transfer, zavesenie počas settle, uvoľnenie tokenov. | Živé interné/externé prepojenie a zvuk po každom kroku. |
| T09 – neutrálna linka | P1 | Čaká na identifikáciu | Presné volané číslo nie je doložené. Z dostupných dát nemožno bezpečne určiť miesto odklonu; smerovanie sa naslepo nemenilo. | Presné číslo + čas + provider call ID; potom korelácia výlučne v tejto kópii. |
| T10 – meranie latencie | P1 | Čiastočne | Audit doplnený o identitu príkazu, fázu, začiatok a trvanie efektu, čakanie na lease a celkové spracovanie. | Porovnateľný živý test pred/po, osobitne skutočné zvonenie zariadenia. |
| T11 – účinné časy | P2 | Hotové | Pri konkrétnom kroku all/ordered vidno vlastný alebo dedený čas; zmiešané použitie skupiny zachované. Modelové regresie. | Nový živý hovor po uložení upraveného plánu. |
| T12 – plynulý úvod | P2 | Čiastočne | 8 zložených predvolených MP3: 4 jazyky × 2 účely, pôvodný hlas/text, manifest/hash. Jeden potvrdený completion; fallback zachová celý oznam. | Vlastné texty/hlasy/nahrávky zostávajú dvojfázové. Nevykonaná zmena právneho textu ani meranie reálnej úspory. |
| T13 – minimalizácia ponuky | P2 | Hotové | Minimalizovanie a znovuotvorenie bez odmietnutia hovoru; nová ponuka sa znovu zobrazí. Browser regresia. | — |
| T14 – mobilné skratky | P2 | Hotové | Tri voliteľné skratky + trvalé Menu, samostatná Mapa, oprávnenia a ochrana rozpracovaného formulára. Reload/persistencia overené. | Nastavenie je viazané na profil v danom prehliadači, nesynchronizuje sa medzi zariadeniami. |
| T15 – odstránenie skupiny | P2 | Hotové | Odobratie nepoužívanej skupiny z draftu cez existujúce verzované uloženie; použité skupiny chránené. | Živé nastavenia sa počas vývoja nemenili. |
| T16 – posledný člen/väzby | P2 | Hotové | Priamy prechod, posun a zvýraznenie konkrétneho blokujúceho plánu; aktívne aj neaktívne väzby. | — |
| T17 – odstránenie plánu | P2 | Hotové | Existujúci replace tok, zobrazené blokujúce linky/IVR voľby, navigácia na ich úpravu. Bez nového endpointu/migrácie. | Živé nastavenia sa počas vývoja nemenili. |
| T18 – test zvuku iPhone | P1 | Čiastočne | Test čaká na výsledok AudioContext.resume s časovým limitom; nereportuje fyzickú počuteľnosť. Testované suspend/interrupted/zlyhanie. | Skutočný Safari a nainštalovaná PWA na iPhone, výstup zvuku a stav po návrate z pozadia. |
| T19a – matica zariadení | P1 | Čiastočne | Chrome: responzívne šírky, prevzatie okna, prichádzajúca ponuka, pauza, background heartbeat a ochrana formulára. | Fyzický Android/iPhone, web/PWA, zámok obrazovky, spánok, dve zariadenia. |
| T19b – dozor/šepkanie/vstup | P1 | Čiastočne | Serverové regresie topológie, nahrávania, prepínania režimov a uvoľnenia prešli. | Tri oddelení účastníci musia potvrdiť, kto koho skutočne počuje. |
| T20a – telefónna regresia | P1 | Čiastočne | Kompletná automatizovaná sada + browser pauza/pickup/callback/nahrávacie nastavenia. | Živé call ID, zvuk nahrávok, nezdvihnutie a ďalšie scenáre s testermi. |
| T20b – roly/prípady/úlohy/SMS | P1 | Čiastočne | Celá existujúca unit sada + browser callback/SMS a mobilná navigácia/rozpracovaný prípad. | Používateľské akceptačné testy všetkých rolí; žiadne skutočné SMS sa pri overovaní neposielali. |
| T21a – výsledok replay | P1 | Hotové | Rozlíšené processed/ignored/duplicate/busy/unknown_session/rejected/failed. HTTP 200 s outcome failed nezostane úspechom. Regresie. | — |
| T21b – výsledok spojenia | P1 | Hotové | Health sleduje neobnovené zlyhania aj po processed ledgeri. Presná identita príkazu; úspešný príkaz oddelený od potvrdenia konferencie. Historická neistota sa nezamieňa so zrušením. | Historické dáta bez command ID nemožno spätne doplniť ani z nich odvodiť počuteľnosť. |

## Overenie vydania

- Celá lokálna sada: **2 901 Vitest testov prešlo, 1 existujúci test preskočený**; typecheck a produkčný `pnpm build` prešli.
- Skripty: **40 testov prešlo, 1 existujúci test preskočený**.
- Browser: **61 scenárov prešlo** (28 telefón/ponuky, 8 mobilná navigácia, 25 širšia telefónna/callback/SMS regresia). Lokálne reálne komponenty v Chrome, syntetické odpovede/provider, bez živých odoslaní.
- Cielený ESLint všetkých zmenených TS/TSX/MJS súborov a `git diff --check` prešli.
- PostgreSQL kontroly sú reprodukovateľné podľa `tests/postgres/README.md`; izolované loopback databázy, skutočné SQL migrácie a aplikačné funkcie, syntetický provider.
- Povinné vydanie: work branch Preview s `vitest run → typecheck → build`, kontrola URL, PR do `dev`, kontrola dev aliasu, release PR `dev → main`, kontrola produkcie. Konkrétne SHA/URL a výsledky sú zaznamenané v PR vydania.

Používa sa iba Supabase `ifpaeegaesdmljfkdvcn` a Vercel `pomoc-motoristom-new` v `fra1`. Žiadne živé migrácie/seed ani nové workery/listenery/schedulery. Rozšírená je len obnova a reportovanie existujúceho cronu; jeho plán a ochrana zostávajú existujúce.

## Ako čítať nové meranie

`command_id` a `skipped` umožňujú korelovať presný príkaz. `started_at`, `phase`, `effect_ms` merajú celý efekt vrátane provider požiadavky, kontroly členstva a checkpointu, nie čistý RTT. `runner_started_at`, `lease_wait_ms`, `effects_started_at`, `completed_at`, `processing_ms` rozdeľujú aplikačné spracovanie. Existujúci `provider_timestamp` a prvé prijatie webhooku v ledgeri sú samostatné údaje. Čas vytvorenia auditového riadka nie je začiatok udalosti ani dôkaz príčiny zrušenia.

Kontrola `connections` je obmedzená na 200 nedávnych zlyhaní a 500 súvisiacich úspešných auditov; pri orezaní alebo neúplnom dôkaze hlási neistotu. `command_recovered` znamená potvrdený úspech rovnakého príkazu, `confirmed_after_failure` potvrdené členstvo oboch vetiev rovnakého bridge. Ani jedno nie je fyzický zvukový test.
