# Externé odovzdanie prípadu — implementácia V2

Stav k 12. 9. 2026: implementované v samostatnej V2 Preview vetve. Tento dokument nahrádza pôvodný návrh; pôvodná verzia zostáva v histórii Git. Produkčné vydanie nie je súčasťou tejto zmeny.

## Práca dispečera

Panel **Odovzdať prípad** je súčasťou existujúceho detailu. Otvorenie iba načíta oprávnený prehľad; nevytvorí grant ani neodošle správu. Dispečer vyplní kolegu/stredisko, jeho telefón, osobitné pokyny, voliteľný dohodnutý čas a platnosť 12/24/48/72 hodín (predvolene 24). Vedľa vidí presný výber údajov pred vydaním odkazu.

Odkaz môže skopírovať alebo otvoriť existujúci SMS editor. **SMS pre kolegu používa samostatnú vlastnú správu bez väzby caseId**, pretože pôvodný SMS tok prípadu vždy vyberá kontakt klienta. Číslo prípadu zostáva v texte; prehľad odoslania je v celkovej histórii SMS. V tomto editore sa nedá omylom prepnúť na klientsky prípad či inú šablónu. Telefón, náhľad, finálne potvrdenie, podpis pripraveného konceptu, idempotencia odoslania a kill switche zostávajú pôvodné. Nič sa automaticky neodosiela. Nový odkaz sa k existujúcemu rozpracovanému textu pridá iba po výslovnom kliknutí; neoverené odoslanie sa nemení.

Panel ukazuje príjemcu, stav, prvé otvorenie, platnosť, zverejnenú verziu a priebeh. Dispečer môže potvrdiť nové zverejnenie vybraných údajov, obnoviť odkaz alebo odovzdanie zrušiť s dôvodom. Obnovenie zruší starý token a jeho sessions. Zmena príjemcu znamená výslovné zrušenie pôvodného odovzdania a vydanie nového. Uložené pokyny/čas sa pri otvorení načítajú; obnovenie prehľadu neprepíše rozpracované úpravy.

## Práca príjemcu

Príjemca otvorí mobilnú kartu bez plného účtu dispečingu. Vidí referenciu a druh úkonu, kontakt klienta, vozidlo, miesto/cieľ, čas a pokyny. Telefón otvorí volanie; adresa alebo súradnice otvoria navigáciu. Ručne vyplnené adresy fungujú aj bez súradníc.

Úkon výslovne prijme alebo odmietne s neprázdnym dôvodom. Po prijatí vie potvrdiť **Na ceste → Na mieste → Dokončené**, pridať odhad príchodu, poznámku alebo nahlásiť problém s dôvodom. Samotná poznámka nezmaže už uložený odhad príchodu. V tejto verzii je postup lineárny; neposkytuje plnú partnerskú aplikáciu ani ľubovoľnú editáciu prípadu. Dokončenie externého úkonu samo neuzavrie interný prípad.

Dispečer dostane do vlastných notifikácií upozornenie v tej istej transakcii ako rozhodnutie. Otvorenie odkazu nie je prijatie. Pri zmene zverejnených údajov alebo súbežnom rozhodnutí server odmietne starú revíziu a príjemca načíta aktuálnu kartu. Po dokončení/odmietnutí zostane potvrdenie bez klientskych údajov. Vypršaný alebo zrušený odkaz údaje neposkytuje.

## Hranica zdieľaných údajov

Server skladá výber z pevného zoznamu:

- Číslo prípadu a druh úkonu.
- Jeden hlavný kontakt klienta: meno a telefón.
- Vozidlo: značka, model a EČV.
- Miesto a cieľ: adresa a dostupné súradnice; pri chýbajúcom mapovom bode iba presné polia manualPickupAddress/manualDestinationAddress.
- Osobitné pokyny pre kolegu a voliteľný dohodnutý čas.
- Stav a vlastný priebeh tohto odovzdania.

Neposiela sa celý prípad/DispatchData, interné poznámky, VIN, ceny, poistné údaje, úlohy, telefónne záznamy/prepisy, prílohy, interná časová os ani iné prípady. Zmena interného prípadu sama nezmení už zverejnený výber. Opätovné zverejnenie je výslovná akcia a vyžaduje zhodu aktuálneho serverového náhľadu.

## Token, session a transakcie

Odkaz používa `/handoff#token=...` s 32 kryptograficky náhodnými bajtmi. V databáze je iba SHA-256 tokenu. Klient odstráni fragment a vymení token cez same-origin JSON POST za `HttpOnly`, `Secure`, `SameSite=Strict` cookie obmedzenú na `/api/public/handoffs`. Session má najviac 12 hodín a nepredĺži platnosť grantu. Pri vypršaní session príjemca znovu otvorí pôvodný odkaz; pri vypršaní grantu požiada dispečera o obnovenie.

Čistá URL ponechá iba nepriehľadné `?handoff=<id>` pre obnovenie stránky. Každé čítanie aj rozhodnutie vyžaduje toto ID zobrazeného odovzdania. Cookie z inej karty tak nemôže prijať nesprávny prípad. Server po získaní databázového zámku znovu overí skutočný čas, generáciu, session aj grant. Starý token či session po obnove/zrušení nefunguje.

Verejné mutácie vyžadujú presný Origin a JSON, telo je obmedzené pri čítaní streamu. Existuje aplikačný limit požiadaviek na IP a databázový limit nových sessions na grant. Aplikačný limit je lokálny pre proces; nie je distribuovanou ochranou proti DDoS. Stránka/API majú no-store, no-referrer, noindex a zákaz vloženia do cudzieho rámca. Stránka nepridáva analytiku; existujúci service worker neukladá navigačné HTML ani API a inštalačná ponuka sa tu neukazuje.

Interné RPC kontroluje auth.uid, aktívnu oprávnenú rolu, profil/organizáciu aj konkrétny prípad. Verejné RPC je dostupné iba serverovému service_role a pozná výhradne obmedzený token/session. Priamy prístup anon/authenticated/service_role k štyrom novým tabuľkám je odobratý; RLS je zapnuté. Handoff cookie nikdy nenahrádza Supabase session pre bežné case API.

Príkazy uzamknú grant, overia očakávanú revíziu a publikovanú verziu a atomicky zapíšu stav, udalosť, receipt a príslušnú notifikáciu. Identita receipt zahŕňa aktéra/session, command UUID, grant/prípad a normalizovaný obsah. Rovnaká požiadavka sa nezduplikuje; rovnaké UUID s iným obsahom vráti konflikt. Pri strate odpovede klient zachová rovnaký príkaz aj text. Ak sa stratí prvá odpoveď obsahujúca tajný odkaz, retry vráti uložené metadáta bez tokenu a UI vyžaduje výslovné obnovenie odkazu.

Odkaz je bearer oprávnenie: držiteľ celého odkazu môže konať v jeho rozsahu. Názov príjemcu nie je overená osobná identita; udalosti používajú označenie Držiteľ odkazu. SMS obsahuje vlastnú kópiu tajomstva v existujúcej oprávnenej histórii správ. Nezavádza sa dôkaz identity cez OTP ani offline úložisko klientskych údajov.

## Súbory a overenie

- Kontrakt: src/domain/case-handoff.ts; validácia/HTTP: src/server/case-handoff.ts.
- Interné GET/POST: /api/cases/[id]/handoffs.
- Verejné session/current/commands: /api/public/handoffs/*; mobilná stránka /handoff.
- SQL: supabase/migrations/20261001110000_external_case_handoff.sql.
- Príslušné komponenty: CaseHandoffPanel, HandoffRecipient, HandoffSummary; existujúci SmsComposerDialog.

Nezávislá recenzia backendu schválila SQL SHA-256 `fc9b7ce7de7a2d22e52b76e3835d72e35153d49d3399181b2b5858f98e557738`. **29 PostgreSQL scenárov prešlo** na jednorazovej lokálnej fixture: cudzie identity/organizácie, priame RPC/table práva, presný DTO s vnorenými canary dátami, ručné adresy, revízie/publikovanie, retry/kolízie, súbežné rozhodnutia, zrušenie/obnova, session z inej karty, expirácia počas čakania na zámok, rollback notifikácie a zachovanie ETA.

**12 browser scenárov prešlo** nad skutočnými komponentmi s úplne zachytenými HTTP requestmi: mobilné rozhodnutie/priebeh/reload, strata odpovede, nesprávna session, presný príjemca samostatnej SMS bez send, reálne obnovenie strateného issue odkazu, publikované polia/draft, príprava SMS po obnove, serializácia read/write, zrušený interný prístup a 360/390/768/1366 px bez pretekania stránky. HTTP validačné testy, existujúci skutočný SMS prepare service, registre autentifikácie, typecheck a ESLint prešli. Snímky mobilnej karty a dispečerského náhľadu boli ručne skontrolované.

Presné celkové výsledky buildu, nasadenia a migrácie iba povolenej kópie sú v spoločnom zázname V2. Nevytvárali sa živé testovacie granty, neposielali reálne SMS a nemenili pôvodné projekty. Testy nepredstierajú overenie fyzického iOS ani skutočnej doručenej správy.
