# Zákazky odťahovej služby — implementačný plán

**Dátum:** 13. 10. 2026 · **Režim:** RALPLAN, dôkladný konsenzus · **Verzia:** v1.0 · **Stav:** finálny plán po dvoch kolách Planner → Architect → Critic; architekt aj nezávislý kritik schválili upravený návrh. Ide o posúdenie plánu, nie schválenie implementácie, SQL ani nasadenia vlastníkom.

**Výsledok:** samostatný modul zákaziek v súčasnom repozitári, kancelárske rozhranie `/zakazky` a jednoduché rozhranie šoféra `/vodic`. Najprv úplný online tok až po evidenciu úhrady; základný offline režim ako samostatný, menej prioritný míľnik. Nevytvárať druhú kópiu dispečingu.

## 1. Východiská, rozsah a rozhodnuté defaulty

Klientove požiadavky vychádzajú z oboch Word príloh, troch vložených obrázkov a e-mailu; ich rozbor je v `.context/posudenie-appky-odtahovka.md:1`. Používateľove doplnenia a autorizácia iba plánovania sú zaznamenané v `.omx/context/towing-work-orders-20261013T065052Z.md:1`. Nižšie uvedené voľby sú **navrhované rozhodnutia**, nie tvrdenia o existujúcich funkciách.

| Požiadavka | Konkrétne rozhodnutie pre realizáciu |
|---|---|
| Dispečer založí aj neúplný zásah | Návrh zákazky možno uložiť bez kompletných údajov. Pridelenie vyžaduje kontakt alebo výslovný dôvod jeho absencie, miesto nakládky, pobočku a aktívneho šoféra. Vykládka a technika môžu byť zatiaľ neznáme; chýbajúce údaje sú viditeľné. |
| Jeden šofér má viac zásahov | Žiadny tvrdý limit 3–5; ide o opis prevádzky. Jeden aktuálny zodpovedný šofér na zákazku, ľubovoľne viac zákaziek na šoféra. História prepriradení sa zachová. Spolupracujúci ďalší vodiči nie sú v prvom rozsahu. |
| Samostatné aj nadväzujúce zákazky | Zákazka vznikne ručne alebo vedomou akciou z prípadu. Jeden prípad môže mať 0..N zákaziek; zákazka má najviac jeden zdrojový prípad. Externé odovzdanie prípadu nevytvorí vlastnú zákazku automaticky. |
| Vozidlo, stroj aj materiál | Typ predmetu určuje polia: EČV/VIN nie sú povinné pre materiál ani stroj bez identifikátora. Objednávateľ, majiteľ, fakturačný odberateľ a príjemca sú oddelené kontaktné roly. Rodné číslo v prvej verzii neukladať. |
| Termíny a dokončenie | Samostatný plánovaný termín, čas pridelenia, skutočný začiatok a koniec. Začiatok predvyplniť časom pridelenia s označením pôvodu; vodič/kancelária ho môže opraviť s auditom. Plánovaný zásah automaticky netvrdí, že práca začala. |
| Kancelárske spracovanie | Kontrola, položkové nacenenie, pripravenosť na fakturáciu, externá faktúra a platby. Oprávnená kancelária môže vrátiť na doplnenie, prepriradiť a stornovať s dôvodom. |
| Faktúry | Iba podklady, číslo/dátum/suma externej faktúry a evidencia platieb. Bez vystavovania faktúr, účtovného API či bankového párovania. Neznámy účtovný systém neblokuje tento rozsah. |
| Podpisy | PDF má prázdne podpisové polia; možno priložiť skutočnú fotografiu alebo scan podpísaného papiera/pečiatky. Bez syntetického podpisu, podpisovania na displeji či tvrdenia o právnej účinnosti. |
| Fotografie | Vodič pridá fotografie a môže dokončiť až po potvrdení ich uloženia. Predvolená kontrola: aspoň jedna fotografia predmetu/výkonu; pri odťahu/preprave aj odovzdania, alebo povinný vysvetlený dôvod výnimky. Výnimku vidí kontrolór. |
| Hotovosť | Každý príjem má pohyb priradený šoférovi a zákazke. Odovzdanie zníži jeho zostatok až po potvrdení kanceláriou. Opravy sú nové reverzné pohyby. „Iné“ neznamená príjem mimo evidencie. |
| Offline — až druhá etapa | Už načítaná vlastná zákazka, jej povolené polia, fotky, čakajúci záznam prijatej hotovosti a dokončenie. Offline príjem ešte nemení potvrdený ledger ani zostatok. Bez nových pridelení, cien, odovzdaní/refundácií, PDF a e-mailu offline. Synchronizácia v otvorenej aplikácii, nie sľubovaný beh na pozadí. |
| Číselníky | Spravovateľné asistenčné služby/partneri/pobočky/technika/výkony/parkoviská. Zoznamy z príloh najprv spárovať so súčasnými ID; žiadne automatické seedovanie skopírovanej DB. |

Mimo rozsahu: import pošty/SMS, portály poisťovní, nové telefonické/GPS funkcie, eKasa/terminálové API, automatické vystavovanie faktúr, podpisová služba, viac organizácií ako komerčný produkt. Upozornenia push nie sú podmienkou prvého vydania. Právne formulácie starého zákazkového listu a reálne daňové sadzby sa nepreberajú bez podkladov vlastníka.

## 2. Overené technické východiská

Referencie vychádzajú z checkoutu `7ff4247`; pred realizáciou sa obnovia voči aktuálnemu `dev`. Nové navrhované súbory v ďalších častiach sú výslovne označené. Tento plán nepotvrdzuje stav živých databáz ani pripravenosť poskytovateľov.

| ID | Fakt a zdroj |
|---|---|
| E1 | Dispečerské stavy a štyri kancelárske roly: `src/domain/types.ts:1`, `src/domain/types.ts:68`; základ prípadu `src/domain/types.ts:638`. |
| E2 | Platby majú len metódu/stav; pobočky, partneri, technika a jednoduchý cenník existujú: `src/domain/types.ts:249`, `src/domain/types.ts:445`, `src/domain/types.ts:460`, `src/domain/types.ts:474`, `src/domain/types.ts:537`. |
| E3 | Priradenie dnes vyberá techniku, vyžaduje nakládku/cieľ a zapisuje jeden `occupancy_case_id`: `src/server/motorist-mutations.ts:618`. Meno šoféra na technike je text: `supabase/migrations/20260522121500_fleet_staff_fields.sql:1`. |
| E4 | Členstvo organizácie vychádza z aktívneho `motorist_profiles.user_id`: `supabase/migrations/20260520192000_foundation_schema.sql:471`; pôvodné politiky vrátane prípadov sú organizačné `:517`. Presun helperov do `app_private`: `supabase/migrations/20260608124451_harden_motorist_rls_helpers.sql:5`. Novšia spolupráca na prípadoch navyše menovite povoľuje štyri kancelárske roly: `supabase/migrations/20261006120000_case_collaboration.sql:33`. Preto treba hodnotiť celý migračný reťazec, nie iba foundation. |
| E5 | Všeobecný guard povoľuje člena, keď nie sú uvedené roly: `src/server/api-auth.ts:53`. Domovská stránka používa dispečerský loader: `src/app/page.tsx:11`; ten číta prípady organizácie: `src/data/dispatch-repository.ts:177`, `src/data/dispatch-repository.ts:284`. |
| E6 | Existujúci upload používa organizačné oprávnenie a vracia celý `dispatchData`: `src/app/api/cases/[id]/attachments/route.ts:8`. Upload vkladaný do JSON prípadu: `src/server/motorist-mutations.ts:1031`. Limity 10 MB a podporované typy: `src/lib/case-attachments.ts:6`; storage politika: `supabase/migrations/20260604110500_case_card_directory_and_attachments.sql:76`. |
| E7 | PDF renderer používa snapshot a Chromium, ale skracuje text na jednostranový prehľad: `src/server/case-pdf.ts:11`, `src/server/case-pdf.ts:47`. Preto zdieľať techniku renderovania, nie tento formát dokladu. |
| E8 | EmailMessage zatiaľ nemá prílohy; Resend, idempotencyKey a obmedzenie TEST príjemcov existujú: `src/server/email-delivery.ts:12`, `src/server/email-delivery.ts:25`, `src/server/email-delivery.ts:71`. |
| E9 | PWA registruje globálny worker so scope `/`: `src/components/pwa/ServiceWorkerRegistration.tsx:22`, `src/app/layout.tsx:55`. Aktivácia zmaže všetky cache okrem vlastnej: `public/sw.js:16`; API a autentifikované HTML sa necachujú: `public/sw.js:32`, `public/sw.js:49`. `src/app/offline/page.tsx:17` označuje offline klientské dáta za nedostupné. |
| E10 | Prihlasovací cieľ je dnes sprievodca, úloha alebo `/`: `src/components/auth/login-destination.ts:1`. Callback prijíma bezpečnú internú URL: `src/app/auth/callback/route.ts:29`. Odhlásenie zatiaľ rieši push, session a diagnostickú identitu: `src/components/auth/sign-out.ts:11`. |
| E11 | Registry rozlišuje session routes so súčasnými kancelárskymi rolami: `src/server/route-auth-registry.ts:20`. Test/build príkazy aj IndexedDB testovacia závislosť: `package.json:5`, `package.json:57`. |
| E12 | Povinné lokálne Next návody: `AGENTS.md:3`. TEST-first, PR gate, konkrétna autorizácia SQL a zákaz nových workerov: `AGENTS.md:58`, `AGENTS.md:70`, `AGENTS.md:79`. |
| E13 | Existujúce založenie účtu zapisuje motorist_profiles: `src/server/access-management.ts:47`, `src/server/access-management.ts:85`; reset vyhľadáva starý profil `src/server/access-management.ts:629`, `src/server/access-management.ts:646`; dokončenie hesla ho aktualizuje `src/server/access-management.ts:675`, `src/server/access-management.ts:690`. Samotné zdieľanie login formulára teda nepokrýva nový životný cyklus účtu. |

### 2a. Oficiálne podklady k PWA a autorizácii

- [Next.js PWA guide, tag v16.3.8](https://raw.githubusercontent.com/vercel/next.js/v16.3.8/docs/01-app/02-guides/progressive-web-apps.mdx) a [authentication guide, rovnaký tag](https://raw.githubusercontent.com/vercel/next.js/v16.3.8/docs/01-app/02-guides/authentication.mdx): plán vychádza z verzie uvedenej v `package.json:35`; pred kódom sa aj tak prečítajú dodané lokálne návody podľa AGENTS.
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology): transakčné štruktúrované lokálne dáta vrátane blobs; podporuje návrh fields/photo/outbox, nie sľub nezmazateľnosti.
- [MDN Browser Compatibility Data — SyncManager](https://github.com/mdn/browser-compat-data/blob/main/api/SyncManager.json): Safari ho nepodporuje; preto je povinný foreground sync a Background Sync nie je akceptačná závislosť.
- [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/): limity/eviction a žiadosť o persistent storage nie sú univerzálna garancia uchovania. Automatické mazanie pending dát aplikáciou sa nepridáva k tomuto riziku.
- [MDN service worker register](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register): scope určuje kontrolované stránky; vlastný driver manifest nie je izolovaný origin ani storage. Vybrané limity lease/budget v §4.6 sú návrh produktu, nie odvodená požiadavka týchto zdrojov.

## 3. RALPLAN-DR

**Princípy**

1. Jeden repozitár a spoločná identita, ale vlastná hranica oprávnení a dát zákaziek.
2. Dokončená práca, vyfakturovaná zákazka a prijatá platba sú odlišné skutočnosti.
3. Každé finančné potvrdenie a vydaný dokument musí mať nemennú stopu; retry nesmie vytvoriť druhý účinok.
4. Rozpracované údaje a výpadky sa používateľovi zobrazujú pravdivo; úspech nastane až po serverovom potvrdení.
5. Rozsah doručiť po použiteľných etapách a zachovať dnešný dispečing aj prevádzkové hranice TEST/production.

**Tri hlavné rozhodovacie faktory**

1. Izolácia šoféra a fakturanta od organizačne dostupných dát existujúceho dispečingu (E4–E6).
2. Kontinuita práce s prípadmi, pobočkami a flotilou bez druhého zdroja prevádzkových údajov (E1–E3).
3. Spoľahlivá evidencia peňazí, dokladov a neskorších offline zmien, ktorá znesie súbežné úpravy a opakované požiadavky.

**Architektonické možnosti**

| Možnosť | Výhody | Nevýhody / podmienky |
|---|---|---|
| A. Modul v súčasnej Next aplikácii, samostatné členstvá a tabuľky zákaziek — vybrané | Priame prepojenie s dispečingom, jeden release postup a spoločné auth identity; zdieľanie PDF/email pomocníkov. | Spoločný origin, build a worker; dôsledne oddeliť nové API, dátové projekcie, cache a navigáciu. Výpadok release zasahuje obe rozhrania. |
| B. Samostatná Next aplikácia v rovnakom repozitári, spoločný backend s rovnakou bezpečnostnou hranicou | Nezávislé nasadzovanie a service worker, jednoduchšia izolácia offline klienta; rozumná alternatíva pri raste mobilnej časti. | Druhý Vercel projekt, callbacky/auth relácie, build konfigurácia a zdieľané balíky; izolácia databázy stále vyžaduje rovnaké RLS/API pravidlá. Pre prvý rozsah vyššia prevádzková práca. |
| C. Samostatné repo a vlastný backend | Najväčšia nezávislosť tímu/produktu a porúch. | Duplicitné číselníky a identity alebo integračné API; párovanie prípadov, synchronizácia a riešenie chýb. Vhodné až pre odlišný produkt či organizáciu. |

**Alternatíva identity v možnosti A:** rozšíriť `motorist_profiles` o roly driver/billing je realizovateľné len s kompletnou reštrukturalizáciou starých organizačných RLS a všetkých member API (E4–E6). To je širší a rizikovejší zásah ako samostatné `motorist_towing_memberships`. Vybraný variant nepridáva tieto roly do `AppRole` ani nevytvára vodičom a samostatným fakturantom staré profily.

## 4. Vybraný návrh a kontrakty

### 4.1 Identity a prístup

Nová tabuľka `motorist_towing_memberships`: ID, organization_id, auth_user_id → `auth.users`, role_presets[] a explicitný capability set, active, membership_version, prípadne office_profile_id. Jedinečné členstvo používateľa v organizácii podporuje kombináciu rolí kancelárie a vodiča; nejde o jeden výlučný role stĺpec. Efektívne capabilities sú auditovaným zjednotením schválených predvolieb, pričom driver API vždy uplatní vlastnú úzku projekciu. Roly/predvoľby:

| Rola | Povolenia |
|---|---|
| `driver` | Vlastné aktívne pridelené zákazky a nevyhnutné kontakty, editácia realizačných polí, foto, dokončenie, príjem vlastnej hotovosti online alebo pending záznam offline, vlastný zostatok a návrh odovzdania online. Žiadne kancelárske poznámky, cenníky ani cudzie dokumenty. |
| `dispatch` | Založenie, operatívne úpravy, pridelenie/prepriradenie, plánovanie, vrátenie, kontrola a položkové nacenenie až po ready, náhľad/vydanie zákazkového listu. Tým pokrýva klientom požadovanú kancelársku prácu dispečera. Bez opráv finančných zápisov; externá fakturácia/prijatie odovzdania cez capability billing. |
| `billing` | Kontrola dokončených zákaziek, položky, dokumenty, externá faktúra, evidencia platieb, prijatie hotovosti. Nemôže vytvárať účty ani prepriraďovať výkon. |
| `manager` | Vyššie uvedené kancelárske operácie, reporty, schvaľovanie opráv peňazí/storna a správa modulu. Samostatný capability na správu prístupov. |

Existujúci kancelársky účet sa opätovne použije cez rovnaké auth_user_id; towing oprávnenie dostane explicitne. Existujúca deaktivácia naviazaného office_profile zablokuje aj odvodený kancelársky prístup. Vodičský alebo fakturačný účet bez dispečerských práv **nesmie** dostať `motorist_profiles` len kvôli prihláseniu. Ak má osoba vedome schválené obe členstvá, môže prepínať rozhrania; vodičské API stále vracia iba vodičskú projekciu. Nie je možné tvrdiť, že takáto osoba stratila už schválené kancelárske oprávnenia.

Nové `requireTowingActor` a per-operation capability checks odvodia user/org z overenej session a aktívneho členstva. **Priame čítanie aj zápis citlivých towing tabuliek pre anon/authenticated zakázať cez grants aj RLS; jediná aplikačná cesta je explicitne autorizované úzke API/serverové RPC.** RPC nie sú execute-granted anon/authenticated a nepovoľujú klientovi zvoliť arbitrary actor. Server odvodí actor zo session; service-role RPC v transakcii znovu overí jeho aktívne členstvo, capability a relevantné revízie, pri driver operácii aj aktuálne pridelenie/generáciu. RLS nedá implicitný prístup členom `motorist_profiles`. Úzke serverové DTO a autorizované file proxy sú povinné, nie preferencia. Udalosti/návratové chyby neodhaľujú existenciu cudzej zákazky.

Samostatný onboarding spravuje iba towing členstvo a reužiť môže Supabase Auth primitíva; nesmie zavolať staré createAccessUser, ktoré vytvára motorist_profiles. Nové pozvanie, reset hesla a mark-password-completed musia vyhľadávať/aktivovať motorist_towing_memberships a pri odpovediach neodhaľovať existenciu účtu. Aktívne towing členstvo je rozhodujúce pre modul aj po resetovaní hesla (E13). `loginDestination` doplniť o serverom vybraný `/vodic` alebo `/zakazky`, bez ľubovoľných presmerovaní. Root `/` pre towing-only účet ukáže/presmeruje na príslušný modul až po načítaní jeho členstva; nikdy nespustí `loadDispatchData`. Pre existujúce office účty zachovať dnešný vstup. Testovať pozvanie, obnovu hesla, deaktiváciu aj prepnutie identity (touchpoints E5, E10, E11).

### 4.2 Dáta a prepojenie na dispečing

Nový namespace kódu `src/domain/towing/*`, `src/server/towing/*`, `src/components/towing/*`; navrhované nové routy `src/app/zakazky/*`, `src/app/vodic/*`, `src/app/api/towing/*`. Číselníky dostupné vodičovi len cez úzku projekciu, nie cez starý dispečerský loader.

Nové tabuľky: `motorist_towing_orders`, `motorist_towing_assignments`, `motorist_towing_order_parties`, `motorist_towing_service_lines`, `motorist_towing_attachments`, `motorist_towing_document_versions`, `motorist_towing_invoice_records`, `motorist_towing_payments`, `motorist_towing_cash_accounts`, `motorist_towing_cash_movements`, `motorist_towing_cash_handovers`, `motorist_towing_commands`, `motorist_towing_events`, `motorist_towing_email_deliveries`, `motorist_towing_memberships`, `motorist_towing_reconciliations`. Konkrétne DDL pripraviť v M1; nejde o povolenie aplikovať migráciu.

Každý prevádzkový riadok má organization_id; všetky väzby vrátane pobočky/techniky/prípadu overujú rovnakú organizáciu, ideálne zloženým FK. Zákazka má interné UUID a serverom jedinečne prideľované číslo. Source_case_id je voliteľný. Prenesené kontakty/vozidlo/miesta tvoria východiskovú kópiu údajov zákazky s evidenciou pôvodu; neskoršia úprava prípadu zákazku potichu neprepíše. Aktualizácia zo zdroja je vedomá kancelárska akcia s revíziou. Odkaz spätne umožní z prípadu otvoriť súvisiace zákazky bez zmeny jeho stavov.

Aktuálne priradenie má driver_membership_id, fleet_asset_id?, assigned_at, generation a ended_at. Unikátny aktívny assignment na order, žiadna unikátnosť na driver. Pobočka/technika majú ID aj historický zobrazovací snapshot pre doklady. Nový modul neprepisuje starý jediný `occupancy_case_id`; obsadenosť zákazkami vyhodnotí samostatne nad prideleniami a upozorní na konflikt termínov. Existujúce priradenie prípadu sa automaticky nemení (E3).

### 4.3 Životný cyklus, revízie a dokončenie

- **Výkon:** `draft → assigned → in_progress → submitted`; `needs_changes` vráti aktívnu zákazku šoférovi, `cancelled` je auditované storno. Pridelená naplánovaná zákazka môže zostať assigned do skutočného začiatku.
- **Fakturácia:** `not_ready → ready → invoiced`; voľba `not_required` iba s dôvodom a oprávnením kancelárie, nie na zakrytie platby. Do ready prejde len submitted, kompletné povinné údaje a platné položky. Externé faktúry majú nemenný historický záznam; oprava cez nahrádzajúci/rušiaci záznam.
- **Úhrada:** `unpriced`, `unpaid`, `partial`, `paid`, `overpaid`; záväzná suma na úhradu vychádza z aktívneho záznamu externej faktúry, ak existuje, inak z aktuálnej schválenej cenovej verzie. Príjem bez schválenej ceny/faktúry je záloha. Samostatný príznak `reconciliation_required` blokuje finančné uzavretie pri nevyriešenom nesúlade, aj keby výpočet ukázal paid. Storno výkonu nevymaže platbu ani povinnosť jej vyrovnania.

**Pravidlá medzi stavmi a verziami:**

| Udalosť | Výkon / fakturácia | Cena, doklady a platby |
|---|---|---|
| Vrátenie na doplnenie alebo materiálna zmena výkonu, strán či položiek | needs_changes alebo príslušný pracovný stav; pred faktúrou ready → not_ready. | Predchádzajúce schválenie ceny prestane byť aktuálne; issued PDF zostáva nemenný. Ďalší ready vyžaduje kontrolu a novú schválenú verziu. |
| Zmena po vydaní PDF, pred externou faktúrou | Opätovná kontrola, bez tichého zachovania ready. | Vydanie novej verzie, bez prepísania starého snapshotu. Úhrada sa odvodí od novej schválenej ceny, prijaté peniaze sa nemenia. |
| Zmena/nacenenie po zaevidovaní externej faktúry | Historické invoiced ostáva; reconciliation_required, žiadne predstieranie zmeny vydanej faktúry. | Zachovať fakturovanú sumu ako payment due. Porovnať novú cenu; rozdiel viditeľný a blokuje finančné uzavretie do explicitne zaevidovaného opravného/nahrádzajúceho externého dokladu. |
| Storno s prijatou platbou | cancelled, finančná výnimka otvorená. | Zachovať liability/prijaté peniaze; oprávnená kancelária vyrieši refund, preúčtovanie alebo externý opravný doklad s dôkazom. Žiadne automatické vymazanie alebo fiktívna refundácia. |

Zoznam má dominantnú farbu/slovný stav výkonu/fakturácie a samostatný odznak úhrady. Nepridelené navrchu, pridelené/rozpracované potom, ostatné podľa času; filtre pobočka, vodič, vozidlo, objednávateľ, stav, obdobie. Reporty odlišujú nacenené výkony, externé faktúry a prijaté platby; sumy rešpektujú filter a dátum konkrétnej udalosti, nepočítajú transfer hotovosti druhýkrát ako tržbu.

Každý príkaz nesie command_id UUID a payload hash; create má vopred UUID nového objektu a idempotenciu, nie revíziu neexistujúceho riadku. Ďalšie príkazy nesú relevantné aggregate revisions: order revision pri úprave zákazky, cash-account/handover revisions pri pohybe peňazí; assignment_generation len pri príkazoch viazaných na oprávnenie šoféra. Transakcia získa príslušné zámky, autorizuje, overí verzie a uloží zmenu, audit aj výsledok príkazu. Rovnaký kľúč/payload po opätovnej autorizácii vráti rovnaký výsledok; iný payload pod tým istým kľúčom je konflikt. Revízny konflikt vracia 409 s povoleným aktuálnym stavom; žiadne slepé last-write-wins. Dokončenie kontroluje správne údaje podľa výkonu, ukončené uploady, výnimky z fotiek, potvrdenie/reconciliáciu všetkých nahlásených receipt UUID a čas konca ≥ začiatku. Zákazka zmizne šoférovi až po ack servera. Timeout znamená „overujem uloženie“, nie úspech ani automatické založenie nového príkazu.

### 4.4 Ceny, platby a hotovosť

Mena prvej verzie EUR. Peniaze prenášať ako reťazce desatinných hodnôt alebo celé centy, v DB presné `numeric`/`bigint`; nikdy finančný výsledok nepočítať cez neobmedzené JS float. Množstvo a jednotková cena majú zvolenú presnosť 3 a 4 desatinné miesta; riadok bez dane sa zaokrúhli na cent metódou half-up, daň na riadku rovnako, výsledok je súčet riadkov. Daňová sadzba a režim majú platnosť od/do a tax_date zákazky; finálna verzia zamrazí sadzbu, dátum aj pravidlo zaokrúhlenia. Syntetické testovacie sadzby sa označia ako testovacie. Bez vlastníkom určenej konfigurácie možno uložiť návrh, nie vydať nacenený finálny doklad. Reálnu zákonnú sadzbu plán neurčuje.

Výkony: odťah, oprava na mieste, preprava stroja/materiálu, uloženie na konkrétnom parkovisku, preťah s voľným cieľom. Vodič určí realizovaný výkon/množstvo; kancelária upraví finálny fakturačný text a jednotkovú cenu. Vodič vidí autorizovanú sumu na výber a vlastný prijatý príjem, nie interné cenové pravidlá. Čiastočné úhrady a viac metód na zákazku sú podporované.

**Peňažný kontrakt:** append-only platba + pohyb peňazí vznikajú v jednej DB transakcii. Pre hotovosť ledger eviduje prevod external → driver; karta/bankový prevod vytvorí platbu bez hotovostného zostatku vodiča. Klientsky receipt_id a command_id sú jedinečné v organizácii. Potvrdený pohyb nemožno UPDATE/DELETE ani cez bežnú kancelársku rolu.

Šofér navrhne odovzdanie konkrétnej sumy, kancelária ju samostatnou akciou prijme alebo odmietne. Pending odovzdanie zostatok nemení a sumu rezervuje proti ďalším návrhom. Prijatie pod zámkom handover a oboch účtov vytvorí driver → office prevod práve raz; dostupnosť sa počíta ako zostatok mínus **ostatné** rezervácie, teda vlastnú rezerváciu práve prijímaného handover odpočítať nesmie. Príklad: zostatok 100, vlastná rezervácia 60 → prijatie 60 → vodič 40, kancelária 60. Odmietnutie alebo managerom odôvodnené zrušenie uvoľní rezerváciu práve raz. Zostatok je súčet pohybov, nie ručné pole; všetky cesty rešpektujú ostatné rezervácie a nezápornú potvrdenú držbu.

Oprava nesprávneho príjmu má odkaz na originál, jedinečný reversal_of a náhradný záznam v jednej transakcii; reálna refundácia je samostatný doložený výdaj, nie vymazanie príjmu. Po odovzdaní manager dodá **overené rozdelenie korekcie podľa skutočnej držby peňazí**, nie len výber jedného účtu. Príklad: receipt 100, z neho už odovzdaných 60, oprava receipt na 20 vyžaduje zníženie o 80; nemožno odrátať 80 od vodiča so 40 ani od kancelárie so 60. Rozdelenie 40 vodič + 40 kancelária je prípustné iba ak overená realita potvrdzuje, že práve tieto evidované peniaze neexistovali/nepatrili k príjmu. Platobná korekcia aj zodpovedajúce custody adjustments sa zapíšu atómovo pod zámkami, nezáporne a s rešpektovaním rezervácií. Ak reálne rozdelenie nie je doložené alebo súvisiaci handover beží súbežne, najprv vyriešiť revízny konflikt/rezerváciu; inak zachovať originál a explicitnú reconciliation exception. Nevymyslieť transfer ani refund len na aritmetické vyrovnanie. Audit obsahuje autora, dôvod, originál, dôkaz a rozdelenie držby.

### 4.5 Fotky, zákazkový list a odoslanie

Vlastný privátny bucket `towing-documents`; cesty organization/order/attachment_id, žiadne pôvodné osobné meno v storage path. Vodičské uploady **nepoužijú** starý endpoint vracajúci dispatchData (E6). Upload zámer → súbor → finalizácia metadata; opakované zaslanie rovnakého attachment_id je bezpečné. Finalizácia kontroluje typ/veľkosť/skutočný formát, vlastníctvo a aktuálne pridelenie. JPEG/PNG/PDF; kamera pre mobil a kompresia fotiek pred odoslaním, cieľ ≤2 MB, tvrdý limit 10 MB na súbor. Nepodporovaný HEIC musí byť jasne odmietnutý alebo klientom konvertovaný, nikdy ticho zahodený. Maximálne 50 príloh na zákazku, kancelária môže limit vedome zvýšiť; nesfinalizované prílohy neumožnia dokončenie. Orphan súbory majú stav a administrátorský kontrolovaný cleanup, bez nového scheduleru.

Download/proxy endpoint znovu overí oprávnenie ku konkrétnej prílohe; odpoveď private/no-store. Pre vodiča nepoužívať dlhodobé podpísané URL, ktoré by ostali použiteľné po prepriradení. Papierová podpísaná príloha sa jasne označí ako scan a nezamieňa s generovaným PDF.

Dokument má dva účely: realizačný list bez ceny, ak ešte nie je nacenené, a finálny nacenený zákazkový list. Pri vydaní sa transakčne uloží nemenný obsahový snapshot a verzia; renderer vyrobí úplný viacstranový PDF so snapshot hashom a uloženým výsledným súborom. Stav `generating/ready/failed`; zlyhaný render nemení obchodný stav na úspech, retry renderuje rovnaký snapshot. Po neskoršej oprave vznikne v2, v1 aj scan zostanú. Bez skracovania položiek/textu (E7). Prázdne podpisové bloky majú objednávateľ, príjemca s menom, dopravca; bez nepodložených právnych vyhlásení.

Email na výslovne potvrdeného príjemcu: kancelária „vytvoriť a poslať kópiu“, prípadne uložená voľba pri vydaní konkrétnej verzie. Neodosielať automaticky na každú zmenu ani na historické kontakty. Uložiť document_version_id, recipient, dedupe kľúč, stav a provider_message_id. `sent` znamená prijatie poskytovateľom, nie doručenie do inboxu. Timeout = `unknown`, nie automatické opätovné odoslanie po neobmedzenom čase. Retry s rovnakým kľúčom iba v overenom idempotency okne poskytovateľa; mimo neho najprv overiť stav alebo ručne potvrdiť nový pokus. Bez nového background workeru: request-bounded odoslanie a viditeľné kancelárske retry. Rozšíriť zdieľaný email typ o prílohu bez oslabenia TEST recipient guardu (E8).

### 4.6 Offline — samostatný míľnik po online jadre

Zachovať **jeden existujúci root worker**. Pridať iba verejný offline shell pre vodiča bez zákazníckych dát, autorizačných údajov či serverom vloženého osobného HTML. Offline navigácia pod `/vodic` použije tento shell; ostatné cesty si zachovajú dnešný offline postup. Cache cleanup obmedziť na vlastné prefixy a podporované verzie, aby aktivácia nemazala cudzie cache. API, autentifikované HTML a RSC payloady sa naďalej nedostanú do Cache Storage (E9). Driver manifest dostane vlastné id/start_url/scope `/vodic/`; nejde o druhý worker ani nový deployment.

IndexedDB oddelená podľa org + auth_user + prostredie/schema verzie: minimálna projekcia už načítaných vlastných zákaziek, blobs pripravených fotiek, outbox príkazov s base revision/generation, lokálny stav `pending/syncing/conflict/failed/acknowledged`. Oddeliť zahoditeľné read-only snapshots od neodoslaných polí/fotiek/receipt intentov. Žiadna celá organizačná databáza, kancelárske poznámky, cenníky alebo tokeny v outboxe. Offline povoľovať výslovne „Toto je moje pracovné zariadenie“; pri zdieľanom zariadení online-only. Toto delenie je pravidlom aplikácie, nie silnejšou bezpečnostnou hranicou alebo šifrovaním než poskytuje browser storage.

Navrhovaný limit čítania/úprav: serverom vydaná offline lease na 12 hodín od posledného úspešného overenia. Po jej uplynutí alebo obyčajnej expirácii session aplikácia pracovný obsah zamkne a vyžiada reautorizáciu toho istého používateľa; **pending polia, fotky a receipt intents sa automaticky nezmažú ani po 24 hodinách**. Read-only snapshots môžu expirovať po 24 hodinách, prípadné minimum base údajov potrebné na riešenie pending konfliktu ostáva súčasťou zamknutého outboxu. UI upozorní hodinu pred expiry. Pri návrate tej istej identity najprv online overiť členstvo/pridelenie, až potom obnoviť obsah a sync. Pri obyčajnej chybe siete či všeobecnom 403 nič deštruktívne nemažte; 403 sám nepotvrdzuje revokáciu. Vypnutý browser nevykoná časovaný výmaz; okamžitá vzdialená revokácia offline kópie sa nesľubuje.

Dobrovoľný logout/switch s pending dátami **pred odhlásením** ponúkne synchronizovať, zrušiť odhlásenie alebo výslovne potvrdiť zahodenie s počtom zmien/fotiek a upozornením na finančné záznamy. Bez pending sa lokálne PII vymažú. Neočakávaný login iného účtu starý outbox zamkne; iná identita ho nesmie vidieť, odoslať ani automaticky vymazať. Pri potvrdenom zahodení sa odstránia pracovné PII/fotky, ale nepotvrdené receipt dôkazy sa nezamlčia: zostanú v minimálnej karanténe na kancelárske vyrovnanie, ktoré UI výslovne vysvetlí.

Autoritatívna revokácia znamená odpoveď overeného towing access endpointu s konkrétnym machine kódom `membership_revoked` alebo `assignment_revoked` po overení identity, nie všeobecný HTTP 403. Po nej sa zakáže sync a vymažú lokálne pracovné PII/fotky príslušného rozsahu; stále sa zachová minimálny nepotvrdený receipt dôkaz: opaque order/receipt/assignment UUID, suma/metóda/čas, bez kontaktov, mien, adresy, poznámok a fotiek, stav `requires_office_reconciliation`. Tieto technické identifikátory sa ďalej nezverejňujú. Existencia fyzicky prevzatej hotovosti sa deaktiváciou účtu nevymaže a revoked vodič z karantény nemôže vytvoriť serverovú platbu.

**Kancelárske vyrovnanie karantény:** pôvodný používateľ môže v obmedzenom obnovení tej istej identity zobraziť iba minimálny receipt dôkaz; ak autentifikácia už nie je možná, hotovosť a receipt UUID oznámi kancelárii manuálne, nie cez verejný API. Iná prihlásená identita starú karanténu neuvidí. Autentifikovaný manager vo vlastnom rozhraní ručne zaeviduje opaque receipt UUID, sumu a overenú okolnosť; server cez jeho aktuálne oprávnenie skontroluje pôvodné priradenie/audit a vytvorí `motorist_towing_reconciliations`. Rovnaký organizačne unikátny receipt UUID je spoločný dedupe kľúč normálneho sync aj reconciliácie: už existujúcu platbu iba prepojí, neexistujúcu zaeviduje až po overení fyzického príjmu/držby, inak ponechá otvorenú výnimku. Prijatá evidencia aj jej finančné účinky sa potvrdia atómovo; žiadny public reconciliation endpoint ani obídenie práv odobratého vodiča.

Ak sa pôvodné receipt UUID nedá obnoviť, kancelária zachová otvorenú výnimku a overuje príjem podľa dostupnej histórie. Nevymyslí náhradné receipt UUID ani novú potvrdenú platbu, ktorá by sa neskôr zdvojila s pôvodným outboxom. Súčasť M6/AC28 je skúška nedostupného UUID a neskoršieho nájdenia pôvodného pending záznamu: bez preukázaného spárovania výnimka ostáva otvorená, pri spárovaní vznikne najviac jeden finančný účinok.

**Offline príjem hotovosti:** vodič uloží stable receipt UUID, order UUID, assignment/generation, presnú sumu, metódu cash a captured_at ako `pending`, oddelene od potvrdenej platby. Reload ani retry nevytvoria nové receipt UUID. UI ukáže „Hotovosť zaznamenaná v zariadení — čaká na potvrdenie“; potvrdené serverové/global cash totals ostávajú nezmenené. Offline nevzniká potvrdený zostatok, handover, refund ani oprava. Kým receipt nemá serverový ack alebo explicitnú manager reconciliáciu, zostáva viditeľná pending/výnimková úloha aj keď bola zákazka medzičasom prepriradená.

Synchronizácia beží pri otvorení, návrate do popredia, online evente a ručnom „Synchronizovať“. Poradie: reautorizovať → polia s kontrolou revízie → upload/finalizácia fotiek → receipt ack → dokončenie. Jeden leader na účet v otvorených kartách; serverová idempotencia chráni aj pri poruche klientského zámku. 409 neprepisuje novšie údaje: používateľ uvidí konfliktné polia a zvolí opravu. Nevybavený receipt alebo konflikt blokuje potvrdené dokončenie, nie jeho lokálnu prípravu. Lokálne dokončenie je „Čaká na odoslanie“ a karta nezmizne do serverového ack; pri odobratom pridelení nahradí kartu obmedzená pending receipt úloha bez zákazníckych údajov.

Celkový navrhovaný lokálny budget 200 MB/účtu a 50 MB/zákazku; pred zápisom kontrolovať dostupné miesto, nezamieňať zlyhanie IndexedDB za uloženie. Po ack ihneď odstrániť odoslaný blob; po serverovom submitted odstrániť lokálnu zákazku iba ak nemá nevybavený príkaz/receipt. Limity 12 h/24 h/200 MB/50 MB sú produktové defaulty, nie garancie prehliadača. Žiadna závislosť od Background Sync alebo garantovanej perzistencie browser storage (oficiálne zdroje v §2a). Android Chrome a iPhone PWA sa overia na reálnych zariadeniach; emulácia je doplnok.

## 5. Pre-mortem: tri scenáre zlyhania

| Scenár | Ako by vznikol | Prevencia / signál / skúška |
|---|---|---|
| Šofér dostane cudzie klientské údaje | Nová rola v starom profile, reuse uploadu/loadera, starý storage link alebo zmiešané offline identity. | Oddelené členstvo/API/bucket, negatívna access matica, test celého payloadu, revokácia a purge. Metrika zamietnutí podľa operation code bez PII. Pred pilotom manuálne pokusy driver A → order B aj priamym REST/RPC/storage. |
| Pokladňa ukazuje dvojnásobné alebo záporné peniaze | Retry po timeoute, dve prijatia odovzdania, oprava po odovzdaní alebo súbežný refund. | Transakcie, receipt/command/reversal uniqueness, účtové zámky, rezervácie odovzdania, immutable ledger. Invarianty automaticky overované nad syntetickým ledgrom; nezrovnalosť blokuje finančný rollout. |
| Vodič si myslí, že zásah odovzdal, ale fotky sa stratili | Offline „success“, kvóta, nová verzia workera vymaže cache, reassignment počas sync alebo pád renderu/emailu. | Oddeliť lokálne/serverové stavy, dokončenie až po upload ack, izolovaný verejný shell, schema upgrade test a TTL upozornenie. Telemetria veku pending a chýb uploadu; e2e preruší každý krok siete. |

## 6. Implementačné kroky, závislosti a výstupy

Každý míľnik má reviewovateľnú PR veľkosť; hranice možno rozdeliť na menšie PR, ale bezpečnostná brána M1 predchádza sprístupneniu UI. Kód sa nezačína písať týmto plánom.

| Míľnik | Práca a touchpoints | Závisí od / výstup |
|---|---|---|
| M0 — znovuoverenie | Načítať aktuálny dev, diff/migrácie a AGENTS. Nainštalovať zamknuté závislosti a prečítať relevantné dodané Next návody pred kódom (E12). Inventár všetkých auth triggerov, RLS/grantov, storage politík a signup callbackov; overiť, že nový auth user automaticky nedostane starý profil. Overiť číselníky a termíny z príloh. | Konkrétna matica účtov/tabuliek/API a návrh minimálneho SQL; žiadne automatické seedovanie. |
| M1 — bezpečnostný a dátový základ | Nové `src/server/towing/auth.ts`, `commands.ts`, `repository.ts`, doména a aditívne migrácie. Členstvá, objednávky/priradenia, revízie/commands/events, RLS/FK/constraints, privátny bucket. Registry E11 rozšíriť o guard/capability novej domény, nevkladať vodiča do MotoristRole. Testy priameho REST/RPC/storage aj service-role cesty. | M0; izolovaný syntetický fixture a úspešná access matica. TEST SQL až po autorizácii presného projektu a SQL. Feature flag default off. |
| M2 — kancelária a online vodič | Nové routy a DTO; vytvorenie, assignment, doplnenie, fotky, submission, vrátenie, audit. Vstupná navigácia/login/odhlásenie v E5/E10, nové tlačidlo z prípadu s explicitnou väzbou. Nerecyklovať starý assignment ani upload (E3/E6). | M1; online e2e od minima údajov po potvrdené dokončenie, viac zákaziek jedného vodiča. |
| M3 — ceny a peniaze | Nové money/state validators a transakčné RPC cien/platieb/ledger/handovers; kancelárske kontroly, externé faktúry, filtre a tri odlíšené reporty. E2 je iba zdroj existujúcich číselníkov, nie cieľ prepísania pôvodnej paymentDetails. | M1 + M2; finančné invarianty a race tests, žiadna závislosť od účtovného API. |
| M4 — doklady a email | Nová úplná PDF šablóna a snapshot pipeline, súkromné verzie/scany, email prílohy a stav retry. Refaktorovať všeobecný renderer len s regresným testom existujúceho PDF (E7); zachovať email guards (E8). | M2 + M3; úplný online tok, PDF vizuálna kontrola aj dlhé údaje, TEST email len schválený príjemca. |
| M5 — online TEST odovzdanie | Feature smoke, access testy, peniaze, PDF, audit a existujúci dispečing; schválený TEST dataset a zariadenia. | M1–M4; prvý samostatne použiteľný release, handoff podľa §9. Offline ešte explicitne nie je doručené. |
| M6 — terénny offline režim | Nové `src/components/towing/offline/*`, IndexedDB/outbox/lease/purge; verejný shell, driver manifest, cielené zmeny E9 a sign-out E10. Upgrade/downgrade worker/schema testy; žiadny druhý globálny worker ani nový serverový worker. | M5, stabilné serverové command kontrakty; samostatná TEST akceptácia na Android/iPhone. M6 neblokuje online vydanie. |

## 7. Akceptačné kritériá

Všetky kritériá majú pozorovateľný výsledok; AC01–AC25 sú online brána, AC26–AC32 samostatná offline brána. Označenia U/I/E/O znamenajú unit/integration/end-to-end/observability; konkrétne postupy sú v §8.

| ID | Overiteľný výsledok | Overenie |
|---|---|---|
| AC01 | Nový driver-only a billing-only účet nemá `motorist_profiles`; `/`, legacy API, priame REST/RPC a storage neposkytnú dispečerské prípady. Povolený login/recovery funguje. | I, E |
| AC02 | Driver A neprečíta/neprepíše order B, prílohu B, finančné poznámky ani zoznam cudzích zákaziek z odpovede; test kontroluje celé JSON/HTML. Priame anon/authenticated SELECT aj mutations na citlivých towing tabuľkách a RPC s ľubovoľným actor sú odmietnuté aj pre office účet; povolené úzke API funguje. | I, E |
| AC03 | Deaktivácia/prepriradenie pred serverovým príkazom zamietne príkaz aj download; starý assignment_generation nezapíše zmenu. | I |
| AC04 | Office účet s explicitným towing členstvom použije tú istú identitu; dispatch preset skontroluje/nacení a posunie do ready. Kombinovaný dispatch+driver účet funguje bez druhého členstva, driver DTO ostáva úzke. Fakturant bez office profilu spracuje fakturáciu a nedostane ústredňu/assignment oprávnenie. | I, E |
| AC05 | Návrh možno uložiť s minimom údajov, prideliť aj s neznámou vykládkou/technikou; chýbajúce údaje sú zobrazené a kontrolované pri submission podľa typu výkonu. | U, E |
| AC06 | Z jedného prípadu možno založiť dva explicitné odťahy; samostatná zákazka funguje bez prípadu; externý handoff automaticky nevytvorí žiadnu. | I, E |
| AC07 | Jeden vodič má súčasne 5 zákaziek, každá jedného aktívneho zodpovedného; výmena vodiča zachová históriu. | I, E |
| AC08 | Plánovaný čas, pridelenie a skutočný výkon sú odlíšené; koniec pred začiatkom sa odmietne; oprava času má autora/dôvod. | U, I |
| AC09 | Materiál bez VIN prejde validáciou; vozidlo/preprava majú vlastné požadované polia, fotografie alebo vysvetlenú výnimku. | U, E |
| AC10 | Neúspešný/pending upload nedovolí potvrdené submission; retry prílohy a dokončenia vytvorí práve jeden účinok. Po ack karta zmizne vodičovi, kancelárii ostane. | I, E |
| AC11 | Cash paid pred invoice funguje, nenacenený príjem je deposit. Vrátenie/materiálna úprava invaliduje ready. Po invoice 120 a novej cene 150 zostane payment due 120, objaví sa reconciliation_required a finančné uzavretie je blokované do explicitného externého opravného záznamu. Storno s príjmom zachová platbu aj otvorenú liability/refund povinnosť. | U, I |
| AC12 | Ceny na hraničných decimal hodnotách s dávkami položiek dávajú presný centový výsledok; tax_date/sadzba sú vo verzii zamrazené; chýbajúca daňová konfigurácia blokuje finálny cenový PDF. | U, I |
| AC13 | Výber 100 EUR cash, 30 EUR card a 20 EUR bank vytvorí platby 150 EUR, ale zostatok vodiča len 100 EUR. Opakovaný receipt to nezvýši. | I |
| AC14 | Pri zostatku 100 a vlastnej handover rezervácii 60 sa prijatie 60 nezablokuje vlastnou rezerváciou; dve súbežné prijatia vytvoria jediný transfer: driver40/office60. Druhý návrh rešpektuje ostatné rezervácie; reject/cancel ich uvoľní práve raz. | I |
| AC15 | UPDATE/DELETE potvrdenej platby/pohybu je odmietnuté. Receipt100 → handover60 → oprava receipt20 nesmie automaticky odrátať80 jednému účtu. Overené rozdelenie driver40+office40 vytvorí atómový nezáporný výsledok driver0/office20; bez dôkazu alebo dostupnosti vznikne exception bez finančnej mutácie. Súbeh handover/korekcie sa serializuje alebo vracia konflikt. | I |
| AC16 | Dve úpravy s rovnakou base revision neprepíšu údaje potichu; neskoršia dostane 409. Rovnaký command_id s iným payloadom sa odmietne. Create retry nevyžaduje revíziu neexistujúceho riadku; cash/handover používajú vlastné aggregate revisions, office operácia nevyžaduje neexistujúce driver priradenie. | I |
| AC17 | List priorizuje nepridelené a rozpracované; kombinované filtre vrátia očakávané ID a súčty. Transfer hotovosti sa v prijatých platbách nezapočíta druhýkrát. | U, I, E |
| AC18 | PDF s 50 položkami a dlhými slovenskými textami obsahuje celý obsah cez viac strán; podpisové bloky sú prázdne; scan papiera je samostatný skutočný súbor. | U, E |
| AC19 | Po zmene ceny/kontaktu v2 nemení snapshot/hash/bytes v1; materiálna zmena potrebuje nové schválenie ceny, issued externá faktúra sa potichu nemení. Email odkazuje na presnú verziu. Zlyhaný render ostane failed a retry renderuje rovnaký snapshot. | I |
| AC20 | Email smeruje iba na potvrdenú adresu, TEST guard odmietne neautorizovanú; timeout ukáže unknown, provider acceptance sa nenazýva inbox delivery. | I, E |
| AC21 | Šofér na šírke 360 px dokončí celý online tok bez horizontálneho scrollu; ovládače majú dotykový cieľ ≥44 px a stav nie je vyjadrený len farbou. | E |
| AC22 | Žiadna nová mutácia nie je anonymná ani cross-origin; registry/testy rozpoznajú towing guard. Logy neobsahujú kontakty, fotky, auth tokeny ani telá formulárov. | I, O |
| AC23 | Po vypnutí flagu je modul nedostupný, pôvodné prípady/assignment/PDF/telefón fungujú; jeho tabuľky a potvrdené peniaze sa nemažú. | I, E |
| AC24 | Existujúci build gate prejde, TEST health/deployment SHA sa zhoduje s testovaným dev commitom a existujú konkrétne dôkazy zmeneného správania. | E, O |
| AC25 | Záznam obsahuje presné schválené TEST SQL, cielené fixture ID, testované účty a prípadné neoverené externé kroky; nie je aplikovaná neautorizovaná produkčná migrácia. | I, O |
| AC26 | Po online preload vlastnej zákazky možno v režime lietadla znovu otvoriť PWA, upraviť polia, pridať fotky a pending cash receipt so stable UUID; serverové cash totals sa nemenia. Cudzie a nenačítané zákazky dostupné nie sú. | E |
| AC27 | Po reconnect polia → fotky → receipt ack → dokončenie prebehnú práve raz aj po reloade/dvoch kartách/retry. Receipt vytvorí jedinú platbu a custody pohyb. Pred ack/reconciliáciou zostáva viditeľný pending problém a potvrdené dokončenie je blokované. | I, E |
| AC28 | 409 zachová novšie serverové dáta, generic403 iba zamkne/reoverí prístup. Potvrdená membership/assignment revokácia zablokuje sync a odstráni pracovné PII/fotky, zachová iba minimálny receipt dôkaz v karanténe. Manager môže ručne overiť ten istý UUID a zaevidovať ho práve raz; revoked driver ani verejný endpoint platbu nevytvoria. | I, E |
| AC29 | Pri 12h/session expiry a po 24h zostanú pending fields/photos/receipts zamknuté a obnoviteľné tou istou reautorizovanou identitou. Read-only cache expirovať môže. Logout/switch s pending najprv ponúkne sync/cancel/explicit discard; iný účet starý outbox nevidí ani neodošle. Discard nezahladí minimálny nepotvrdený cash receipt dôkaz. | U, E |
| AC30 | Plná kvóta/nepovolené IndexedDB jasne odmietnu lokálne uloženie; používateľ nedostane success a už uložené zmeny neprepisuje poškodený záznam. | I, E |
| AC31 | Aktualizácia root workera zachová vlastný platný offline shell a outbox; Cache Storage neobsahuje authenticated HTML/API/RSC. Offline driver navigácia nemení fallback dispečingu. | I, E |
| AC32 | AC26–AC31 prejdú na reálnom Android Chrome a iPhone nainštalovanej PWA s evidenciou modelu/OS/verzie; absencia Background Sync neblokuje foreground sync. | E, O |

## 8. Rozšírená testovacia a pozorovacia špecifikácia

**Unit (Vitest):** čisté validačné schémy výkonov a povinných polí, capability projekcie, všetky povolené/zakázané prechody, odvodený payment status, presná aritmetika/half-up/tax_date, zoznamové radenie/filtre a význam reportových dátumov. Property/invariant testy súčtov cien, rezervácií a idempotency hashov; nepoužiť testy, ktoré iba kopírujú implementáciu. Offline neskôr cez fake-indexeddb (dostupné podľa E11): transakčné enqueue, upgrade schémy, quota errors, lease clock/expiry, account partition/purge a poradie sync. AC05, 08, 09, 11, 12, 17, 29–31.

**Integrácia (reálna izolovaná testovacia schéma/databáza):** plný migračný reťazec a RLS, nie iba fake Supabase. Fixture organizácie A/B, driver A/B, fakturant, dispečer, manager, dual-role a revoked účet. Testovať povolené úzke API a zakázané priame anon/authenticated SELECT/mutations/actor RPC; service-role RPC musí odmietnuť nedostatočné aktuálne oprávnenie aj pri platnom serverovom kľúči. Pokryť neplatné org/order/attachment ID, vymenené identity, priradenie, CSRF. Súbežné command/receipt/reversal/handover transakcie vrátane vlastnej rezervácie 60 zo 100, jej cancel/reject a opravy receipt100→20 po handover60 proti prijímaniu ďalšieho handover; výsledok musí byť doložený/nezáporný/atómový alebo nezmenený s exception. Normal sync a manager reconciliation rovnakého receipt UUID vytvoria spolu najviac jeden finančný účinok. Injektovať výpadok pred commitom, po commite pred odpoveďou a počas finalizácie uploadu. Overiť cross-state maticu, invoice120 verzus nová price150, immutable PDF a superseding externý doklad. Kontrolovať celý returned payload, DB invarianty a absenciu osirelých účinkov; email stub accepted/failed/unknown a TEST allowlist. AC01–AC20, 22, 23, 25, 27–31. Použiť len syntetické fixture v rozsahu explicitnej TEST SQL autorizácie.

**E2E (Playwright + zariadenia):** tri online scenáre: (a) samoplatca s čiastočnou hotovosťou a doplatkom, (b) asistencia s referenciou a externou faktúrou, (c) stroj bez EČV/VIN, plánovaný zásah, prepriradenie a vrátenie. Každý obsahuje fotky, kontrolu, verziu dokladu a audit. Samostatne 5 kariet vodiča, mobilná dostupnosť, nový/recovery/dual-role účet a plná dispatch kontrola/nacenenie. PDF overiť vizuálne aj úplnosťou textu. Offline M6: preload → airplane → fotky + cash receipt → reload → pending → reconnect; overiť jeden receipt účinok a až potom completion. Variant s prepriradením/deaktiváciou vedie do minimálnej karantény a manager reconciliácie, nie k platbe vodiča. Variant s generic403/12h/24h/session expiry zachová pending; odhlásenie vyskúšať sync, cancel aj informed discard, iný účet nesmie čítať/odoslať cudzí outbox. Injektovať kvótu, crash a update SW. PWA testovať aj produkčným lokálnym buildom, pretože development layout odregistruje workery (`src/app/layout.tsx:69`). Live email len autorizovaná syntetická adresa; inbox delivery doložiť osobitne alebo označiť neoverené.

**Observability:** reužiť request metrics/diagnostiku, bez nového systému/workeru. Nové operation codes pre create/assign/submit/upload_finalize/price/payment/cash_transfer/pdf/email/sync; recording len opaque order/command ID, fáza, trvanie, výsledok, revision conflict a retry count, nikdy obsah zákazky. Countery: rejected access, duplicate replay, 409, upload/render/email failures, unknown email, počet/vek pending sync. Finančné invarianty kontroluje read-only kontrola pri TEST handoff a oprávnený kancelársky „overiť evidenciu“, nie nový cron. Alarmujúci stav v UI: nepotvrdený príjem, nevysvetlený rozdiel ledgera, submission s chýbajúcou prílohou; release pri takomto dôkaze zastaviť. Vodičská telemetria má vlastný obmedzený guard, nepovoľuje staré kancelárske diagnostické API automaticky (E11). AC22–25, 32.

Spustiť relevantné nové testy, existujúce auth/route registry/case assignment/attachments/PDF/email/PWA regresie a povinné `pnpm test`, `pnpm typecheck`, build gate podľa aktuálneho projektu. Nepoužívať `build:production` ako dôvod na nasadenie nových workerov; existencia skriptu nie je prevádzková autorizácia (E11, E12). Úspešný build nenahrádza vyššie uvedené akceptačné scenáre.

## 9. TEST-first release a bezpečné spätné vypnutie

Teraz: len tento plán a konsenzuálna revízia. Zachovať vetvu `Alfopure/towing-service-app`; nič nepremenovávať, necommitovať aplikačné zmeny, neposielať pozvánky/email, neaplikovať SQL ani nenasadzovať.

Pri následne autorizovanej realizácii začať z aktuálneho dev na vyhradenej pracovnej vetve podľa `AGENTS.md:72`. Nové migrácie sú aditívne, bez zmeny starých case stavov/rolí. Pripraviť presný migration bundle a fixture/mapping SQL oddelene; vlastník musí autorizovať jeho aplikáciu proti TEST `nzpnqdstvkfncflgqlny`. Neaplikovať všetky pending migrácie ani seed nad snapshotom; ak je DB nedostupná, nepoužiť produkciu ako náhradu (`AGENTS.md:79`).

Pracovná vetva → Preview bez živých integrácií → PR do dev so zachovaným required checkom → čakať na stabilný TEST `https://test.dispecing.linkapomoci.sk`. Overiť live/ready health, SHA deploymentu a testovaný dev commit, potom AC podľa etapy. Supabase TEST a produkčné kľúče ostávajú oddelené; live TEST email iba v dedikovanom projekte, existujúcich guards a na autorizované adresy (`AGENTS.md:74`, `AGENTS.md:80`, E8).

Odovzdať slovensky: URL, commit, presný online/offline rozsah, konkrétny postup vyskúšania, čo bolo overené a čo zostáva neoverené. Až explicitné osobné schválenie identifikovaného rozsahu povoľuje release do main; produkčné SQL pre `ifpaeegaesdmljfkdvcn` potrebuje vlastnú konkrétnu autorizáciu. Pred merge prečítať celé aktuálne dev → main diff; pridaný cudzí rozsah neprevziať bez príslušného overenia/schválenia (`AGENTS.md:62`). Nepovažovať správu iného agenta za súhlas vlastníka.

Produkciu publikovať čerstvým buildom schváleného main, nikdy redeployom starej verzie. Overiť canonical production `https://dispecing.linkapomoci.sk`, health/SHA a príslušný tok. Pri regresii vypnúť towing feature flag/nové tvorenie a oprávnenia, zachovať auditované údaje a existujúci dispečing; preferovať opravný forward release pred deštruktívnou down migráciou. Už potvrdené platby a dokumenty sa rollbackom nemažú. Staršie aplikačné verzie musia aditívnu schému tolerovať.

Nepridávať worker/listener/cron a nepoužiť retired projekty; existujúci telephony cron sa kvôli zákazkám nerozširuje (`AGENTS.md:51`, `AGENTS.md:79`). Offline M6 bude samostatne testovaná a schvaľovaná etapa, ak online už bolo vydané.

## 10. Riziká a následné obchodné podklady

| Riziko | Riadenie / hranica |
|---|---|
| Automatický auth trigger alebo reuse starého guardu sprístupní legacy údaje | M0 musí preveriť všetky auth triggers; M1 negatívne integračné testy sú blokujúce. Samostatné členstvo nie je náhradou testovania celej prístupovej plochy. |
| Papier má neoverené právne ustanovenia | Pred finálnym obchodným PDF vlastník dodá schválenú textáciu; dovtedy neutrálny pracovný list bez právnych tvrdení, bez rodného čísla. |
| Neznáme daňové/účtovné pravidlá | Reálne sadzby, dodávateľské údaje a rounding zhodu s externým systémom potvrdiť pred finančným pilotom. Návrh používa presnú aritmetiku a zamrznuté pravidlá. |
| Číselníky sa nezhodujú | Explicitný mapovací zoznam existujúcich/nových ID a samostatne schválený SQL; deaktivovať položku namiesto mazania historických väzieb. |
| Strata/zamknutie browser dát alebo telefónu | Jasné pending stavy, online fallback, bounded offline prístup a oddelené uchovanie outboxu; automatický TTL nezmaže neodoslanú prácu. Eviction browsera a stratené zariadenie stále bránia sľubu bezstratovej prevádzky. |
| Nesúlad inkasovanej sumy a dodatočnej ceny | Záloha/partial/overpaid stavy, nemenné platby a explicitný opravný/refund tok; bez automatického vynulovania rozdielu. |
| Rýchly rast príloh/reportov | Limity fotiek, kompresia, indexy podľa org/driver/state/date, paginácia 50 riadkov a serverový aggregate; merať na reprezentatívnom fixture pred pilotom. |

Nevyriešené obchodné vstupy už neblokujú dokončenie plánu. Pred živým pilotom sú potrebné konkrétne používateľské účty a pobočky, potvrdené párovanie techniky, daňové nastavenie, firemné údaje/texty PDF a TEST príjemca emailu. Názov fakturačného programu je len informácia pre budúcu integráciu.

## 11. ADR-001

**Decision:** vybudovať modul v súčasnej aplikácii/repozitári, vlastné motorist_towing_orders s voliteľným case odkazom, explicitné členstvá nad auth.users, izolované API/storage a samostatné výkonové/fakturačné/platobné stavy. Online jadro pred offline etapou; hotovosť append-only, doklady snapshotované, externé faktúry iba evidované.

**Drivers:** (1) least-privilege voči dnešným organizačným právam, (2) prevádzková kontinuita so spoločnými číselníkmi, (3) preukázateľné a opakovateľné finančné/dokumentové operácie.

**Alternatives considered:** A so starými rozšírenými rolami; B samostatná aplikácia v monorepe; C samostatný systém. Ich najlepšie prínosy a náklady sú uvedené v §3, nie odmietnuté ako technicky nemožné.

**Why chosen:** vyhovuje tomu istému firemnému procesu pri najmenšom nevyhnutnom rozšírení prevádzky. Nové členstvo minimalizuje zásah do starých RLS, zatiaľ čo podmienka testovať legacy úniky zostáva. Druhý deployment sa oplatí až pri preukázanej potrebe nezávislého mobilného releasu alebo silnejšej origin izolácie.

**Consequences a najsilnejší protiargument:** samostatná aplikácia na inom origin by lepšie oddelila browser storage, XSS dosah a service worker aktualizácie. Vybrané samostatné členstvo poskytuje **serverovú autorizáciu, nie origin izoláciu**; spoločný origin/worker ostáva vedomým kompromisom. Uchovať extraction seams: samostatné towing DTO/API, doménu/komponenty, prefixy storage a vlastný manifest, bez importu dispečerského loadera. Druhý deployment je tak neskôr možný bez zmeny finančných kontraktov. Nový onboarding a spoločný release vyžadujú regresné testy; dokumenty sa neprepisujú. Lease obmedzuje offline prístup, nie životnosť neodoslanej práce; okamžitá vzdialená revokácia sa nesľubuje.

**Follow-ups:** M0 aktuálna auditovaná schéma a auth triggers; M1 potvrdená matica identity; pred M3 finančné nastavenie; pred M4 textácia PDF/email; pred M6 reálne zariadenia a overený storage budget. O B znova rozhodnúť len pri konkrétnom nezávislom release alebo origin probléme, nie preventívne rozdeľovať systém.

## 12. Organizácia následnej práce a changelog

V tomto procese sú dostupní natívni všeobecní agenti, ktorým sa pridelia roly: planner pripraví plán, researcher overí zdroje, architect posúdi hranice a critic kontroluje vykonateľnosť/testovateľnosť. Ich schopnosti netvrdia, že v cloud workspace existuje osobitný skill runtime. Po schválení realizácie môže executor implementovať izolovaný míľnik a verifier nezávisle preveriť diff, akceptačné dôkazy a release stav; architekt a kritik majú kontrolovať postupne, nie navzájom neprečítané návrhy. Plánovanie nespúšťa implementáciu.

Prípadné neskoršie výslovné použitie `$ralph`, `$team` alebo `$ultragoal` vyžaduje vtedy dostupný/overený skill; tento dokument ich nespúšťa ani netvrdí dostupnosť osobitného cloud runtime. `$ralph` môže viesť sekvenčnú realizáciu s nezávislým verifierom. Po ustálení a commitnutí autorizácie/dátových kontraktov možno `$team` rozdeliť do troch vetiev: backend s vysokou úrovňou uvažovania, UI so strednou a verifier s vysokou; koordinátor root zostáva vlastníkom úlohy, najviac štyria súčasní agenti vrátane root. Ide o zadanie rolí natívnym všeobecným agentom, nie zmenu modelov alebo spustenie tímu teraz. `$ultragoal` spolu s `$team` je voliteľná neskoršia organizácia viacerých míľnikov.

Textový príklad až pre neskoršie výslovné zadanie, nie príkaz omx CLI: `$team "Realizuj zákazky odťahovej služby podľa .omx/plans/towing-work-orders-20261013.md po míľnikoch, iba po stabilný TEST; produkciu ani projektové SQL bez príslušnej autorizácie nevykonávaj."` Hranice AGENTS a verifier dôkazy ostávajú platné v každom režime. Tento plán nežiada schválenie implementácie.

Pre dlhšie doručovanie viacerých míľnikov je odporúčaným voliteľným pokračovaním `$ultragoal` spolu s `$team`: koordinátor drží spoločný stav cieľa a tím odovzdáva dôkazy za uzavreté etapy. Pred ukončením tím odovzdá commit/diff každej vetvy, vykonané testy s výsledkami, pokryté AC a zoznam neoverených krokov. Nezávislý verifier následne overí integrovaný výsledok, regresie a podľa oprávnenia aj aktuálny TEST commit/health a zmenené správanie. `$ralph` má zmysel ako neskorší sekvenčný vlastník zostávajúcich opráv a verifikácie; nenahrádza dôkazy tímu ani súhlas vlastníka s produkciou. Teraz sa žiadny z týchto režimov nespúšťa.

**Changelog**

- 2026-10-13 v0.1 — návrh plánovača: zohľadnené prílohy a používateľove defaulty; vybrané oddelené towing členstvo, vlastné zákazky, transakčný ledger, snapshoty dokladov, offline ako neskoršia etapa; 32 testovateľných AC, pre-mortem a TEST-first hranice. Čaká na sekvenčnú architektonickú a kritickú revíziu.
- 2026-10-13 v0.2 — zapracované REVISE/ITERATE: pending offline dáta sa pri TTL neničia; cash receipt intent, revocation karanténa a autorizovaná kancelárska reconciliácia; opravená vlastná rezervácia handover a dôkazmi podložená korekcia po čiastočnom odovzdaní; cross-state/version pravidlá, relevantné revízie a fail-closed priame čítanie/zápis; motorist_towing_* názvy, kombinované capabilities a dispatch pricing; oficiálne PWA zdroje, ADR origin kompromis, spresnené AC a voliteľné role tímu. Čaká na sekvenčnú opätovnú revíziu architektom a kritikom.
- 2026-10-13 v1.0 — druhá architektonická revízia APPROVE, potom nezávislá kritická revízia APPROVE. Zapracované odsúhlasené neblokujúce spresnenie nedostupného receipt UUID a odovzdania tímových dôkazov. Overená existencia všetkých 57 lokálnych odkazov súbor:riadok a 32 jedinečných AC; ide o kontrolu dokumentu, akceptačné testy aplikácie sa ešte nevykonávali. Zmenené iba plánovacie podklady, žiadny aplikačný kód, DB ani deployment.
