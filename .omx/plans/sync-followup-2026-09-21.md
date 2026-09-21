# Plán v2: dokončenie aktualizácií a presný stav spolupráce

Stav: schválený východiskový plán v2 (RALPLAN: Architect APPROVE → Critic APPROVE), realizácia S1–S4 povolená používateľom 21. 9. 2026. Výsledok a overenie implementácie sú v `docs/rollout/sync-followup-2026-09-21.md`; tento dokument zachováva pôvodné akceptačné kritériá.

## 1. Východisko a rozsah

Používateľ chce opätovne skontrolovať, čo skutočne chýba, odstrániť text „Aktualizácie sa overujú na pozadí“ a navrhnúť nenápadnú ikonu s vysvetlením. Prijímanie, rušenie a rýchlosť hovorov sa práve ladia inde; tento projekt ich nesmie prepracúvať.

Audit používa aktuálny `origin/main@3cf96163b5d541eff7272b345517b961f111b41d`, ktorý zodpovedá READY produkcii Telnyx kópie, nie starší lokálny HEAD. `origin/dev@604e62b29e191283c5ee46cbabd8b94435c57162` má rovnaký obsah stromu. Pred realizáciou sa tieto údaje opäť porovnajú s čerstvým dev; ak už niektorý bod opravila iná vetva, vynechá sa.

### Overený stav a rozhodnutie

Odkazy na riadky sú vo vyššie uvedenom main commite.

| Obrazovka / vec | Skutočný stav | Rozhodnutie |
|---|---|---|
| Globálne hlásenie spolupráce | Textový banner je stále v `CaseCollaborationProvider.tsx:73–80`, vložený cez `DispatchConsole.tsx:2345`. Úspešné načítanie ponechá `stale = !connected` (`case-collaboration-store.ts:106–107`). | Nahradiť ikonou; oddeliť prebiehajúce čítanie, posledné úspešné overenie, chybu a platnosť prístupu. |
| Karta prípadu – „Upravuje“ | `CaseDetail.tsx:1280` volá presence bez argumentu aktivity. Dashboard sa pri prepnutí len skryje (`DispatchConsole.tsx:2388–2396`), heartbeat sleduje browser tab, nie obrazovku (`CaseCollaborationProvider.tsx:107–120`). | Opraviť prítomnosť podľa viditeľného editora; zachovať namontovaný draft. |
| Návrh nového prípadu | `NewCaseDrawer.tsx:126` oznamuje existenciu otvoreného návrhu; návrh pri skrytí skutočne nezaniká. Nie je to dôkaz falošného rozpracovaného prípadu. | Zachovať správanie; text spresniť na „má otvorený návrh prípadu“, nesľubovať priebežné písanie. |
| Odovzdanie prípadu | `CaseHandoffPanel.tsx:19–37` načíta pri rozbalení a po vlastnom príkaze, nie pri cudzej zmene. `HandoffRecipient.tsx:28–41` načíta pri otvorení, interval len overuje expiráciu. | Doplniť automatické čítanie v oboch otvorených pohľadoch. |
| Nastavenia → Adresár | `settings/DirectoryPanel.tsx:25–40,111` má úvodné a ručné načítanie, vlastné uloženie aktualizuje lokálny zoznam. Pri návrate do sekcie ho rodičia znovu namontujú a údaje sa načítajú (`DispatchConsole.tsx:2591`, `IntegrationSettings.tsx:72`). Cudzia zmena počas nepretržitého otvorenia sa sama neprenesie. | Doplniť iba priebežné čítanie, bez prepracovania adresára či jeho vytáčania. |
| Prípady a komentáre | Automatický case store + broadcast a 25 s poistka už existujú (`case-collaboration-store.ts:48–50,83–114`; migrácia `20261006120000_case_collaboration.sql:128,147`). | Nepísať znova. Regresne overiť uložené zmeny a zachovanie draftu. |
| Úlohy a otvorený chat | Broadcast + 25 s poistka (`TaskWorkspaceProvider.tsx:26–37,49`). | Hotové; overiť bez zmeny architektúry. |
| Súkromné/zdieľané poznámky | Cielený kanál + 20 s poistka (`NotebookPanel.tsx:39–49,65–68`). | Hotové; tlačidlo pri konflikte či chybe nie je chýbajúca automatizácia. |
| Nastavenia → mazanie používateľov | Read-only kontrola DB stále nenašla RPC z `20261006140000_access_profile_task_history.sql`. `access-management.ts:455–462` pri chýbaní funkcie konzervatívne zachová históriu anonymizáciou. | Oddelená aktivácia, nie súčasť PR o synchronizácii. Pôvodné tri migrácie Ústredne už boli aktivované. |
| Priame prepojenie čakajúceho, širšia výpomoc mimo radu | Samostatná telefonická funkcionalita; nie chyba synchronizačnej ikony. | Teraz bez implementácie. |
| Mobil, živé súbežné prijímanie a 8–10 volajúcich | Chýba doložené praktické overenie; automatické fixture testy nedokazujú fungovanie fyzického telefónu. | Oddelený prevádzkový test, bez zmeny logiky telefonovania. |

## 2. RALPLAN-DR rozhodnutie

Princípy:

1. Telefonický runtime a ovládanie majú prednosť; nová synchronizácia na ne nesmie čakať ani ich spúšťať.
2. Stav musí hovoriť pravdu: živé spojenie, úspešné načítanie a uloženie formulára sú rozdielne veci.
3. Opraviť konkrétne medzery a použiť existujúce rozhrania; neprepisovať už hotové stores.
4. Zachovať rozpracovaný text, identitu session a prístupové obmedzenia pri každom oneskorení či prepnutí.
5. Žiadne plošné zrýchľovanie pollingu ani globálny reload stránky.

Hlavné dôvody rozhodnutia: ochrana telefonovania; správne a zrozumiteľné stavy; malý kontrolovateľný zásah s merateľnou záťažou.

| Možnosť | Prínos | Cena / nevýhoda |
|---|---|---|
| A – cielené opravy + čítanie iba otvorených chýbajúcich panelov, stav z existujúceho case store | Bez novej DB migrácie alebo realtime autorizácie; malý izolovateľný diff. | Cudzie zmeny odovzdania a adresára majú časovo ohraničené oneskorenie. |
| B – nové broadcast kanály/SQL triggery aj pre odovzdania a adresár, spoločný indikátor celej aplikácie | Rýchlejšie doručenie zmien a širší prehľad všetkých modulov. | Nové schémy, oprávnenia aj autorizácia externého príjemcu; väčší zásah do zdieľanej DB a viac stavových kombinácií. |

Odporúčanie A. B je použiteľná ďalšia etapa, ak meranie preukáže potrebu okamžitých aktualizácií; nie je vhodná do súčasnej obmedzenej opravy. Samotné skrytie banneru nestačí: ponechalo by nepravdivé stavy a nevyriešené odovzdania.

## 3. Návrh ikony a presný význam

**Desktop:** samostatný drobný ovládač pri účte/názve aplikácie v ľavom rohu hlavičky, mimo pravého bloku telefónu, callbackov a prijatia hovoru. Žiadne nové plnošírkové hlásenie ani nový riadok.

**Mobil:** v existujúcom riadku názvu obrazovky, aby ďalší ovládač nezmenšoval dostupnosť ani Hovory. Konečné osadenie musí prejsť skutočnou hlavičkou pri 320/390 px, nie iba konceptom. V Úlohách je spoločný riadok skrytý (`DispatchConsole.tsx:2277`): doplniť voliteľný stavový slot pri existujúcom nadpise v `TaskWorkspacePanel.tsx:183–186`, iba hlavný variant `page`, nie sidebar/embedded kópie. Nevytvárať nový riadok. Ikona aj tu výslovne označuje prípady a upozornenia, nie stav Úloh. Na obrazovke je vždy jeden viditeľný ovládač a jeden otvoriteľný detail, bez duplikovaných ID.

Zachovať zdedený systémový font Nástenky (`globals.css:44–48`, `live-layout-preview.css:12–16`), svetlé pozadie `#fcfcfd`, text `#242833`, tlmený text `#69717e`, okraje `#e0e3ea`, zelenú `#17613d` a jantárovú `#79500b`. Existujúca žltá ostáva pre primárne akcie. Lucide ikona 16 px, stabilná šírka, na mobile dotyková plocha aspoň 44×44 px. Žiadna nová fontová závislosť.

| Stav | Ikona / vysvetlenie po hover, focus alebo tap |
|---|---|
| Prebieha skutočné autorizované načítanie | Krúžiaca šípka: „Aktualizujem prípady a upozornenia…“. Pri veľmi krátkom načítaní možno oneskoriť zobrazenie o 200 ms; bez umelého predlžovania animácie. |
| Úspešne overené, platný prístup, bez ďalších strán snapshotu | Jemná fajfka: „Prípady a upozornenia sú aktuálne.“ + „Posledné overenie o HH:MM“. |
| Funguje HTTP poistka, websocket nie | Po úspešnom čítaní fajfka. V detaile: „Zmeny sa kontrolujú automaticky, približne každých 25 sekúnd.“ Bez večnej animácie alebo žltého varovania len pre absenciu websocketu. |
| Chyba / offline / vypršané overenie | Výstražná alebo odpojená ikona: „Údaje sa nepodarilo overiť. Posledné overenie o HH:MM.“ Žiadna zelená fajfka. Pri opakovanom čítaní po chybe zostáva chyba zrejmá až do úspechu. |
| Prístup zamietnutý | Zámok: „Prístup k prípadom nie je dostupný.“ Existujúce skrytie údajov a zrozumiteľné vysvetlenie v karte zostávajú. |
| Ešte neoverené / funkcionalita nedostupná | Neutrálna ikona a presné vysvetlenie; žiadny úspech z úvodných serverových props. Demo bez store nepredstiera overenie. |

Indikátor v tejto etape meria **prípady a upozornenia**. Neoznamuje zdravie telefónu, uloženie formulára ani overenie celého adresára, úloh či poznámok. Rozšírenie na celý systém vyžaduje skutočné zdrojové stavy každého modulu a patrí do možnosti B.

Priorita zobrazenia: zamietnutý/expirovaný prístup → posledná nevyriešená chyba → prebiehajúce/neúplné načítanie → platné úplné overenie. Reconnect sám chybu nemaže. Pri `more:true` pretrváva stav neúplného načítania aj v 500 ms medzere medzi stranami; šípka sa však točí iba počas requestu. Čas úspechu sa posunie až po poslednej úspešnej strane série, bez ohľadu na poradie transportných udalostí. Prvé načítanie má neutrálny stav, nie chybu len preto, že ešte nikdy nebol získaný prístup.

Hover/focus ukáže krátke vysvetlenie, klik/tap otvorí malý detail; Escape a klik mimo zatvoria. Ovládač je samostatné tlačidlo, nie tlačidlo v tlačidle účtu. `aria-label` obsahuje stav, význam nespolieha len na farbu. Reduced motion ukazuje statický symbol aktualizácie. Obnovy každých 25 s sa neoznamujú čítačke zakaždým; ohlásiť zmenu dostupnosti/chyby a návrat spojenia. Len chybový detail môže ponúknuť „Skúsiť znova“, ktoré volá existujúce `store.resume()`, nikdy reload aplikácie.

Detail nesmie prekryť ovládanie hovoru. Jeho bezpečná horná hranica je spodný okraj existujúceho `topBarsRef`, ktorý zahŕňa aj PhoneBar (`DispatchConsole.tsx:635–648,2143–2363`). Zobraziť ho portálom/fixed mimo flow, pod touto hranicou a v rámci viditeľnej plochy; meranie iba pri otvorení a ResizeObserver počas otvorenia, bez nového odberu telefonického stavu. Ak príchod hovorov alebo zmena veľkosti nenechá priestor, detail zavrieť. Žiadny backdrop, focus trap či presúvanie telefónnej lišty. Klik mimo nesmie volať preventDefault/stopPropagation ani vracať fokus, aby klik na Prijať/Ukončiť doputoval pôvodnému ovládaču; Escape môže vrátiť fokus na ikonu. Koncept bez hovoru ilustruje vzhľad, nie tento integračný dôkaz.

## 4. Kroky realizácie

### S0 – zopakovať východisko pri začatí

Fetch dev/main, porovnať aktuálne dotknuté súbory a otvorené PR, vytvoriť novú pracovnú vetvu z aktuálneho dev (existujúcu vetvu nepremenovať). Zaznamenať referenčné počty dátových/telefónnych požiadaviek a správanie prijatia/odmietnutia vo fixture. Vývojové pokusy nesmú používať živé zákaznícke dáta.

### S1 – presná ikona namiesto banneru

- `case-collaboration-store.ts`: doplniť pozorovateľné metadáta načítania (`inFlight`, posledné úspešné úplné overenie, príčina problému) v tej istej inštancii. Použiť samostatný odber malého stavového snapshotu; nezaťažovať všetkých odberateľov kariet pri štarte/konci spinnera. Nezakladať druhý network store ani nový interval.
- Metadáta meniť v existujúcej ceste `read`, pri revoke, lease expiry a ukončení. Zachovať pôvodné ACL 30 s, polling 25 s, deduplikáciu, 500 ms coalescing, generácie a aborty. Žiadna stará odpoveď po odhlásení nesmie vrátiť fajfku ani dáta. Pri `more:true` ešte neukazovať úplné overenie; pri chybe ďalšej stránky tiež nie.
- Nový izolovaný `CaseSyncIndicator.tsx` (+ lokálne CSS/test), ktorý číta iba malý snapshot. Nepresúvať tento stav do `DispatchConsole` a nevyvolávať rodičovský render pre každú animáciu.
- `CaseCollaborationProvider.tsx`: sprístupniť existujúci store novému indikátoru; odstrániť iba rutinný banner. `CaseAccessBoundary`, maskovanie údajov, chybové/revokačné stavy nezrušiť.
- `DispatchConsole.tsx`: iba osadenie komponentu a odstránenie banneru, prípadne scoped wrapper účtu. Nemení sa umiestnenie/identita providerov, PhoneBar ani ich callbacky. CSS nesmie používať všeobecné selektory, ktoré zasiahnu pravý telefónny blok; pozor existujúce mobilné `header > div:last-child` pravidlá.

### S2 – pravdivá prítomnosť editora

- Aktivitu odvodiť od viditeľnosti konkrétneho editora, nie od existencie vybraného prípadu. Zohľadniť `activeView`, mobilný pane, režim collapsed/split/expanded a to, či editor naozaj zostáva viditeľný vedľa mapy/úloh. Samotné `centerView !== map` neznamená vždy skrytý editor.
- Odovzdať explicitnú aktivitu cez úzky prop/context existujúcemu detailu; použiť už existujúci parameter `useCaseEditorPresence(caseId, active)` (`CaseCollaborationProvider.tsx:95`). Rodičia: `DispatchConsole`, `MapWorkspace`, `ExpandedCasePanel` / `CaseCockpitPanel`, `CaseDetail`. Nezamieňať mapové `active` so skutočnou viditeľnosťou editora.
- Pri skrytí zastaviť heartbeat a poslať `leave`; pri návrate začať novú session. Zachovať draft, kurzor, DOM a existujúce ukladanie. Nezmeniť počet ani TTL zápisov pri aktívnom editore (15/60 s). Ošetriť oneskorený heartbeat, aby neobnovil ukončenú session.
- Serverová ochrana oneskoreného heartbeat už existuje (`20261006120000_case_collaboration.sql:97–113`, `ended_at` tombstones). Iba regresne overiť jej využitie; nevytvárať druhú SQL ochranu ani migráciu.
- Nový draft má inú sémantiku: existuje aj po skrytí. `NewCaseDrawer` preto naďalej oznamuje jeho existenciu do uloženia/zrušenia/odchodu/TTL; nepripájať ho automaticky na visibility flag existujúceho editora ani dirty bit. V `CaseDraftActivity` spresniť text na „má otvorený návrh prípadu“. Zachovať súčasný stop po vytvorení (`NewCaseDrawer.tsx:562`), žiadne neuložené údaje v payload. Aktívny existujúci editor naďalej znamená otvorenú viditeľnú úpravu, nie detekciu každého stlačenia klávesu.

### S3 – automatické odovzdania, len v otvorenom pohľade

- `CaseHandoffPanel.tsx`: čítanie pri otvorení, potom najskôr 30 s po dokončení posledného čítania; zoskupiť focus/online/visibility návrat do jedného čítania. Iba keď je panel rozbalený, jeho obrazovka aktívna a browser viditeľný. Zdieľať odvodenú viditeľnosť zo S2.
- `HandoffRecipient.tsx`: po existujúcom jednorazovom vytvorení session automaticky čítať iba `/api/public/handoffs/current`; neopakovať session POST ani mutačný príkaz na pozadí. Expirácia či 401/403/404/410 skryje dáta a zastaví pokusy do nového platného vstupu.
- Jeden request naraz, abort a generácia pri zmene prípadu/unmount/identity. Odporúčaný interval 30–33 s (malý jednosmerný jitter), postupný backoff 60/120 s pri opakovaných chybách. Žiadny poll skrytého okna. Pri focus po návrate jedno bezprostredné čítanie.
- Background read nesmie nastavovať formulár do plného `busy`, blokovať bežné akcie ani prepísať rozpísané pokyny, ETA, dôvod alebo komentár. Pri mutácii zrušiť/potlačiť zastarané čítanie; platí novší potvrdený receipt. Zachovať `commandId`, `expectedRevision`, potvrdenie neistého príkazu a 409 konflikt. Autopoll nesmie vyriešiť neistý zápis vytvorením druhého príkazu.
- Bežné „Obnoviť odovzdania/kartu“ nahradiť automatickým čítaním až po testoch. Zachovať explicitné „Obnoviť odkaz“ (rotuje odkaz) a „Overiť výsledok tej istej požiadavky“ (idempotencia); ide o iné operácie.
- Existujúci public read získava row lock (`20261001110000_external_case_handoff.sql:137,152`); nie je bezplatný. Zmerať záťaž, nemení sa jeho SQL/autorizácia ani rate limit (`case-handoff.ts:89`).
- Držať oddelene `readError` a chybu/neurčitý výsledok príkazu. Úspešný background GET nesmie zmazať upozornenie na pending command ani zmeniť jeho potvrdenie na úspech. Výsledok neistého zápisu stále overuje jeho pôvodný command/receipt.

### S4 – automatický adresár v samostatnom PR

- `settings/DirectoryPanel.tsx` a prípadne úzky spoločný hook so S3: existujúce GET načítanie najskôr každých 60 s iba pri otvorenom viditeľnom adresári + jedno čítanie pri návrate. Vyšší interval je zámerný, endpoint vracia celý adresár (`directory-client.ts:18`).
- Zachovať dotaz, typ, stránku, posun a otvorený draft. Zoznam aktualizovať; otvorený editor s vlastnými zmenami neprepísať. Zachovať existujúci konflikt `expectedUpdatedAt`/409 (`directory-client.ts:23–24`). V prezeranom detaile bez editácie dorovnať položku podľa stabilného ID.
- Oddeliť počiatočné načítanie od background fetch; nerobiť loading skeleton pri každom obnovení. Zachovať sequence ochranu vlastného uloženia (`DirectoryPanel.tsx:53–55`). Pri chybe ponechať zrozumiteľnú cestu opakovania; nepridávať celý refresh aplikácie.
- Rozlíšiť transient chybu/timeout/5xx od 401/403. Pri transient chybe zostane posledný zoznam a draft označený ako neoverený. Pri strate oprávnenia skryť zoznam aj otvorený detail a zablokovať edit/dial z daného panelu; neukazovať starý zoznam ako aktuálny. Pri autorizovanom návrate znovu overiť dáta pred odkrytím, zachovať lokálny draft bezpečne skrytý. Toto nemení telefónny handler, iba prístupnosť zdroja údajov v adresári.
- Tento krok neopravuje adresáre v iných widgetoch ani nemení ich vytáčanie. Ak má byť aktualizovaný aj konkrétny ďalší zoznam, najprv overiť jeho samostatný zdroj dát.

### S5 – oddelené prevádzkové položky

- Migrácia mazania používateľov: evidovať ako chýbajúcu aktiváciu samostatného modulu. Pri budúcej aktivácii overiť konkrétny súhlas, presnú Telnyx DB, service-only oprávnenia a read-only výsledok existencie RPC. Toto UI vydanie nie je na nej závislé; žiadne testovacie vymazanie skutočného účtu.
- Dva oprávnené testovacie účty: reálne websocket doručenie uloženého prípadu/komentára/úlohy/poznámky, odovzdania, sleep/reconnect; použiť dohodnuté testovacie dáta.
- Živý mobil a súbežné hovory patria majiteľovi telefonického testu. Bez takého testu netvrdiť overený zvuk, push ani kapacitu. Štatistiky bez IVR a firemné caller ID zostávajú odložené.

## 5. Pevná hranica telefonovania

Bez zmien v `src/server/telephony/**`, `src/lib/telephony/**`, `src/app/api/telephony/**`, telefonických hookoch/provideri, browser SDK/audio integrácii, worker/cron/webhook implementáciách, telephony migráciách, Vercel konfigurácii či env. Bez zmien `PhoneBar`, `HeaderPhoneStatusMenu`, `HeaderLiveCallsMenu`, prevzatia/odmietnutia/ukončenia, callback akcií alebo časovačov.

`DispatchConsole.tsx` je zdieľaný súbor a smie mať iba úzky UI diff (osadenie ikony a odvodenie viditeľnosti editorov). Každý dotyk telefónnych props, keys, conditional mount alebo callbackov je dôvod zastaviť tento krok a oddeliť ho od plánu. Nové odbery nevolajú `handleTelephonyChanged`, `requestAppRefresh`, `telephony.refresh`, `router.refresh`, `window.location.reload`, telephony command ani znovuvytvorenie Supabase/WebRTC klienta. Neposielajú syntetické globálne `focus`/`online`/`visibilitychange` udalosti: na tie už reaguje telefón. Skutočné udalosti návratu aplikácie len čítajú; ich pôvodné telefonické následky sa porovnávajú s nezmeneným baseline.

Žiadny nový worker, scheduler, listener, cron alebo migrácia v S1–S4. Nové pollery len pre otvorené odovzdanie/adresár; existujúce telefonické frekvencie ani priority sa nemenia.

## 6. Riziká a pre-mortem

| Scenár zlyhania | Ochrana | Dôkaz pred vydaním |
|---|---|---|
| Ikona ukáže fajfku pri expirovanom prístupe alebo oneskorená odpoveď po odhlásení obnoví stav | Stavy vychádzajú z platného ACL a generácie; úspech až po úplnom čítaní. | Fake-clock test lease 30 s, 403, abort, stará odpoveď, čiastočné stránky. |
| Automatické čítanie prepisuje rozpracovaný text alebo znásobuje príkaz | Oddelené read/mutation stavy, sequence, nemenný idempotency key, ochrana dirty fields. | Dva klienty, oneskorená odpoveď, 409, stratené potvrdenie, zachovaný kurzor a text. |
| Nové stavové renderovanie alebo pollery zhoršia reakciu na hovor | Izolovaný odber metadát, žiadne globálne hodiny, hidden stop, bounded requests, no-touch telefonovania. | Rovnaké telephony requesty a mount count, meranie click→mock command pred/po, záťažová fixture bez reálnej siete. |

## 7. Akceptačné kritériá a testy

1. Na žiadnej obrazovke sa nevykreslí pôvodná veta ani jej prázdny banner. Stav zostáva dostupný cez klávesnicu, myš a dotyk.
2. Každý stav tabuľky ikony má jednotkový test; socket down + úspešný HTTP read neukazuje chybu. Žiadna fajfka pri chybe, incomplete snapshot, revokácii či expirovanom prístupe.
3. Indikátor nezvyšuje počet requestov `/api/cases/live`; samotné otvorenie detailu stavu neposiela žiadny request. Pri zavretom popovere nevzniká nový interval na prepočítavanie času.
4. Metadáta spinnera nemenia referenciu case dát ani nespúšťajú callback `onCasesChange`; existujúce záťažové/dedup testy `case-collaboration-store.test.ts:29,63` zostanú platné.
5. Pri odchode zo skutočne viditeľného editora nevznikne ďalší heartbeat; po úspešnom leave prestane editor byť aktívny pri najbližšej existujúcej synchronizácii. Pri nedostupnej sieti platí existujúce TTL ≤60 s. Návrat zachová obsah a vytvorí nanajvýš jednu aktívnu session.
6. Existujúci editor prejde maticou desktop/mobile, split/collapsed/expanded, Nástenka/Úlohy/Poznámky/Ústredňa, visible/hidden browser. Viditeľný editor vedľa úloh sa nesmie nesprávne odhlásiť. Nový zachovaný draft naďalej oznamuje existenciu aj mimo aktuálneho pohľadu; jeho vytvorenie/zrušenie/TTL funguje ako predtým a nový text netvrdí aktívne písanie.
7. Dvaja fixture klienti: zmena odovzdania sa bez kliknutia zobrazí do 35 s pri zdravej odpovedi ≤1 s; adresár do 65 s. Počas jednej minúty bez návratov/zmien nanajvýš 3 handoff reads vrátane úvodného, 2 directory reads. Žiadne paralelné čítania a žiadny poll skrytých panelov.
8. Pri zrušení/expirácii externého odkazu sa údaje skryjú pri najbližšom autorizovanom čítaní; automatika nevytvorí novú session ani príkaz. Dirty text, commandId a podmienky konfliktu zostanú zachované.
9. Pri 20 zoskupených invalidáciách/reconnect udalostiach nevznikne request per event; návraty sa deduplikujú a staré odpovede ignorujú. Pri chybách sa frekvencia znižuje.
10. Celá konzola: spinner, fajfka, otvorenie/zatvorenie detailu stavu a background refresh spôsobia **0 nových telefonických commandov, 0 zmien registrácie a 0 remountov telefónneho providera**. Prijatie/odmietnutie použije rovnakú identitu pozvánky ako pred úpravou, vrátane dvoch súbežných ponúk.
11. Meranie fixture click→vstup do telefonického callbacku / mock requestu: 30 opakovaní pred a po pri rovnakom zaťažení. Uložiť surové vzorky, presný baseline commit a podmienky fixture. Zhoršenie p95 > max(20 ms, 10 % baseline) je blokácia a musí sa vysvetliť/opraviť. Toto meria reakciu UI, nie provider zvuk či reálnu sieť.
12. Skutočná kompozícia hlavičky pri 1440,1280,390,320 px, 200 % zoom a reduced motion: žiadny horizontal overflow, prekrytie telefonických tlačidiel ani posun riadkov pri zmene stavu; fokus a aktívny hovor zostanú zachované. Koncept screenshot sám toto kritérium nesplní.

Rozšírený testovací plán:

- Unit: snapshot metadáta/generácie/stránkovanie; matica viditeľnosti; scheduler/backoff a abort; dirty merge/idempotencia.
- Integration: existujúci case store + ukončenie presence; oba handoff read endpointy s fixture stavmi; ochrana ACL a adresárového 409. PostgreSQL testy iba pri skutočnej zmene SQL; táto etapa ju nenavrhuje.
- E2E: rozšíriť `e2e/case-collaboration.spec.ts`, `case-handoff.spec.ts`, `directory.spec.ts`, `workspace-provider-lifecycle.spec.ts`; regressie `call-tray.spec.ts`, `incoming-call-overview.spec.ts`, `mobile-call-bar.spec.ts`, `background-webphone.spec.ts`, `call-notification-focus.spec.ts`. Existujúci full-console fixture má noop telefónny hook, preto sám nedokazuje nulový dopad. Doplniť spies vo full-console a samostatný integračný fixture so skutočným telefonickým hookom a fake SDK/API: počty mount/connect/disconnect, session/leg identity, identita DOM lišty, rovnaké virtual-clock timery a request delta oproti baseline. Žiadne spojenie so skutočným providerom.
- Observability: priložiť request/mount počty, baseline/po meranie a screenshoty; neodosielať PII, tokeny ani telefónne čísla do nových logov. Žiadne nové produkčné heartbeat endpointy.
- Kompletný existujúci gate: Vitest + Node testy, typecheck, lint, build; zaznamenať existujúce warnings zvlášť od regresií. Nepovažovať starší úspešný beh za validáciu nového commitu.

## 8. Vydanie a návrat

Odporúčané oddelené PR: (1) ikona + metadáta; (2) presence viditeľnosť; (3) odovzdania; (4) adresár. Každý vychádza z aktuálneho dev, má vlastný Preview a dôkaz rozsahu. Zlúčiť až po úspešnom gate, overiť dev alias, produkciu uvoľniť iba PR dev→main podľa AGENTS.md. Ponechať nedokončené kroky mimo produkčného vydania.

Preview/dev zdieľajú reálnu Telnyx DB: automatické testy sú lokálne/izolované, žiadne náhodné produkčné writes alebo skúšobné hovory. Pri opätovnom aktuálnom dev pred release zopakovať no-touch diff a telefonické regresie, aby plán neprepísal paralelné ladenie.

Rollback je revert konkrétneho UI PR cez dev→main; nemení schému, dáta, telephony parametre ani identitu hovorov. Bez vynúteného reloadu používateľa uprostred hovoru alebo formulára. Existujúce upozornenie na novú verziu a jeho blokácia počas hovoru (`DispatchConsole.tsx:2260–2270`) zostávajú.

## 9. ADR

- Rozhodnutie: opraviť prítomnosť a konkrétne chýbajúce načítania, rutinný banner nahradiť presnou izolovanou ikonou pre prípady/upozornenia.
- Dôvody: ochrana telefonovania, pravdivé UX, minimum závislostí a obmedzená záťaž.
- Alternatívy: celosystémový synchronizačný agregátor s novými broadcast kanálmi (B); samotné skrytie banneru (nedostatočné).
- Prečo A: nevyžaduje zmeny SQL, realtime ACL ani audio/provider kódu; každá oprava má samostatnú kontrolu a rollback.
- Dôsledky: chýbajúce moduly sa obnovujú v definovanom intervale; globálna ikona nesľubuje stav modulov, ktoré nemeria. Stav neuloženého formulára zostáva oddelený.
- Nadväzujúce práce: skutočný dvojklientový test a praktické telefonické overenie, samostatná aktivácia mazania používateľov; prípadné rozšírenie na B podľa merania a potreby.

## 10. Záznam kontroly

- Opätovný audit používa aktuálny main aj dev; doplnené presné rozlíšenie už hotových automatických aktualizácií od otvorených panelov.
- Architekt: **APPROVE**; zapracované poradie sync stavov a neúplné stránky, oddelenie read/command chýb, revokácia adresára, existencia nového draftu a bezpečný detail pod telefonickou lištou. Formálny výsledok je v `.context/sync-plan-architect-review.md`.
- Kritik: **APPROVE**, sekvenčne po architektovi; 12/12 kritérií posúdených ako testovateľné, bez blokujúcich pripomienok. Záznam `.context/sync-plan-critic-review.md`; neblokujúca požiadavka na surové vzorky/baseline doplnená do AC11. Konsenzus schvaľuje plán, nie implementáciu alebo nasadenie.
- Lokálny koncept ikony: `.context/sync-status-concept/index.html`, `.context/sync-status-concept.png`, `.context/sync-status-concept-mobile.png`. Prešlo 12 izolovaných Playwright kontrol konceptu s nulovými sieťovými requestmi; nejde o dôkaz integrácie skutočnej konzoly ani telefonovania.
- Podrobné dôkazy: `.context/sync-plan-evidence-collaboration.md`, `.context/sync-plan-evidence-telephony.md`. Po opätovnom audite opravené príliš široké tvrdenie o adresári, oddelený nový návrh od aktívneho existujúceho editora a doplnené rozlíšenie desktop centerView vs skrytá obrazovka.
