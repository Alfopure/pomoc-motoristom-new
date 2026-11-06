# Jednoduché mobilné úlohy

Návrh a implementačný kontrakt · 6. 11. 2026. Rozsah zadal majiteľ v Conductor
rozhovore: každý zamestnanec vytvorí úlohu, pridelí ju kolegovi alebo pobočke;
vedúci pobočky ju pridelí ďalej alebo vyrieši sám. Dodanie najprv do TESTu.

## Používanie

- **Úlohy**: jasné **+ Nová úloha**, hľadanie, prepínač **Moje · Pobočka · Zadané mnou**.
  Dokončené úlohy sú dostupné cez viditeľný filter. Existujúca kontrola úloh má
  vlastný výber a nezaniká.
- **Nová úloha**: „Čo treba urobiť?“, „Komu“ (Kolega / Pobočka), voliteľný
  termín. Predvolene som príjemcom ja; výber sa otvorí jedným ťuknutím.
  Popis, priorita a prípad sú druhotné. Na bežné vytvorenie netreba prípad.
- **Pobočka**: zadanie čaká na vedúceho príslušnej existujúcej pracovnej skupiny.
  Má dve pomenované akcie: **Prevezmem** a **Prideliť kolegovi**. Prvý potvrdený
  zápis určí riešiteľa; súbežný pokus sa nestratí ani neprepíše aktuálny stav.
- **Detail**: názov, stav, riešiteľ/pobočka, termín a stručný popis. Nasleduje
  jedna hlavná ďalšia akcia a komunikácia. Jednoduché stavy **Na vybavenie ·
  Rozpracované · Hotovo**; existujúce úlohy vyžadujúce kontrolu si zachovajú
  **Na kontrolu**, určeného kontrolóra aj dôvod vrátenia.

## Vzhľad

Použiť existujúci svetlý shell, `mobile/src/design/tokens.ts`, spoločné formuláre,
zoznamy, tlačidlá a `useShellBack`. Žiadne nové farby ani druhá navigácia.
Kompaktný riadok má názov, riešiteľa a termín; stav je pomenovaný, nielen farebný.
Žltá patrí hlavnej akcii. Dotykové plochy aspoň 44 bodov, zalamovanie dlhých mien,
ovládanie pri 320 bodoch a zväčšenom písme. Drag-and-drop nie je podmienka práce.

## Inšpirácia a hranice

Preštudované oficiálne návody a ich mobilné screenshoty:

- [Asana: vytváranie úloh v iOS](https://help.asana.com/s/article/creating-tasks-and-projects-on-ios)
  — rýchle vytvorenie, riešiteľ, termín a rozbaliteľné podrobnosti.
- [Asana: mobilná aplikácia](https://help.asana.com/s/article/getting-started-with-asana-s-mobile-app)
  — osobné úlohy, jasné filtre a práca v detaile.
- [Trello: pridávanie kariet](https://support.atlassian.com/trello/docs/adding-cards)
  — viditeľné rýchle pridanie.
- [Trello Inbox](https://support.atlassian.com/trello/docs/trello-inbox/)
  — rýchlo zachytiť a neskôr usporiadať. Pobočkový front je naše pravidlo;
  osobný Trello Inbox sám nemá priraďovanie členov.

Nejde o kópiu značky ani celých produktov. Nepribúda všeobecný projektový manažér,
ďalší scheduler, nové SMS alebo automatické kontaktovanie zákazníkov.

## Údaje a oprávnenia

Zachovať `motorist_case_tasks`, identity úloh, históriu, správy, pripomienky,
kontrolu aj zamknutý systémový pôvod. Samostatné úlohy už databáza podporuje.
Rozšíri sa priradenie o Auth používateľa a existujúcu pracovnú skupinu.
Zamestnanec je aktívny človek s dispečerským profilom alebo aktívnym terénnym
členstvom tej istej organizácie. Terénny účet nedostane dispečerský profil ani
právo čítať cudzie prípady. Adresár je spoločný a deduplikovaný podľa používateľa.

Každý zápis znovu overí aktuálne členstvo, príjemcu, skupinu a verziu úlohy.
Pobočkové prevzatie/pridelenie patrí jej aktuálnym vedúcim. Vytvorenie a príkazy
uchovávajú identitu aj pri opakovaní po výpadku; nevzniknú duplicitné úlohy.
Existujúce webové a mobilné zapisujúce verzie zostanú kompatibilné.

## Akceptácia

1. Úlohu vytvorí dispečer aj vodič bez dispečerského profilu, bez prípadu.
2. Príjemcom môže byť ktorýkoľvek aktívny kolega tej istej organizácie.
3. Úloha pobočky sa zobrazí jej vedúcim, ktorí ju môžu prevziať alebo prideliť.
4. Neaktívny člen, cudzia organizácia a neoprávnený kolega zápis neuskutočnia.
5. Dva súbežné pokusy o prevzatie majú jediného víťaza; opakovanie pôvodného
   vytvorenia nevytvorí druhú úlohu.
6. Staré úlohy, kontrola, správy a zamknuté systémové väzby ostanú funkčné.
7. Čitateľný skutočný UI náhľad pri 320/390 bodoch; funkčné prázdne, chybové,
   čakajúce a konfliktné stavy. Natívny build musí prejsť existujúcou bránou.

## Stav

Implementácia a lokálne overenie sú hotové: serverové a mobilné testy,
45 kontrol na skutočnom PostgreSQL vrátane pôvodnej kontroly úloh,
51 browserových kontrol skutočného Expo UI pri 320/390 bodoch (dispečer aj
terénny zamestnanec), lint, typy a iOS export. Dôkazy a screenshoty sú v
`.context/simple-tasks-qa/`. Zmena webového editora zachová priradenie terénnemu
zamestnancovi/pobočke pri úprave názvu; zámerné odobratie zostáva samostatnou voľbou.

Do TEST `nzpnqdstvkfncflgqlny` bola aplikovaná jediná migrácia
`20261106135621_employee_task_workspace.sql`, SHA-256
`2721115c95e81244d47d53cb5239dc3a25f2a50ed30010dbd895c666a9eec342`.
Jej verzia súhlasí so serverovou migračnou históriou. Počet pôvodných úloh zostal
18; aktivácia nastavení sa nemenila. Nové tabuľky majú RLS bez priameho prístupu,
nové RPC vykonáva iba `service_role`. Dve nové INFO od advisorov o RLS bez politík
zodpovedajú tomuto úmyselnému súkromnému prístupu; bez nového bezpečnostného WARN.

Termíny nových úloh terénnych zamestnancov a pobočiek sa ukladajú a zobrazujú
v zozname. Nové push/e-mailové pripomienky pre tieto cieľové skupiny táto verzia
nepridáva; existujúce kancelárske pripomienky a súkromné oznámenia kontroly ostali
zachované. Nevzniká nový scheduler ani doručovanie celej kancelárii za pobočku.

Nasadenie stabilného TEST servera a nový natívny build ešte čakajú na dokončenie.
Produkčná migrácia ani produkčné natívne vydanie neboli vykonané.
