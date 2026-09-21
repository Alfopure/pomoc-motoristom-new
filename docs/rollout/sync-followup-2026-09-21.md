# Aktualizácie a spolupráca — S1–S4

Schválený rozsah: `.omx/plans/sync-followup-2026-09-21.md`. Východisko: dev `604e62b29e191283c5ee46cbabd8b94435c57162`, rovnaký strom ako main `3cf96163b5d541eff7272b345517b961f111b41d`.

- Stav prípadov a upozornení je kompaktná ikona v existujúcej hlavičke. Úspech znamená kompletné autorizované načítanie; chyba, neúplné údaje a expirovaný prístup sa nezobrazujú ako aktuálne. Detail neprekrýva telefónnu lištu a nespotrebúva kliknutia na hovor.
- Prítomnosť existujúceho editora sleduje skutočnú viditeľnosť obrazovky aj browser tabu. Skrytie ukončí jeho session, návrat vytvorí novú. Rozpracovaný formulár zostáva namontovaný. Nový návrh naďalej oznamuje svoju existenciu aj mimo aktuálnej obrazovky.
- Otvorené odovzdania čítajú zmeny po 30–33 sekundách od dokončenia požiadavky; pri chybách spomaľujú na 60/120 sekúnd. Skryté pohľady nečítajú. Príkazy, ich potvrdenia a neisté výsledky zostávajú oddelené od priebežného čítania.
- Otvorený adresár sa overuje po 60 sekundách a po návrate. Zachováva filtre, posun a drafty. Strata prístupu skryje aj natívny dialóg; po obnovení prístupu pokračuje používateľ výslovným kliknutím.

## Overenie

Ralph implementácia, nezávislé architect APPROVE a UltraQA cyklus. Lokálne: 4 719 Vitest + 43 Node kontrol prešlo (2 Vitest a 1 Node test sú pôvodne preskočené), typecheck a build prešli; lint 0 chýb a 5 existujúcich upozornení mimo zmenených súborov.

Prehliadačové scenáre zahŕňajú 29 odovzdania, 16 adresár, 17 celá konzola/spolupráca a existujúce telefonické regresie. Osobitné 4 scenáre používajú skutočný `useTelephonyConsole` a náhradné SDK/API: nezmenená registrácia, identita pozvánky/DOM/audio, rovnaký rozpočet telefónnych požiadaviek a funkčné prijatie/ukončenie cez otvorený detail stavu. Meranie má 30 vzoriek pred a 30 po, limit p95 zhoršenia max(20 ms,10 %); výsledok je uložený v `.context/case-sync-phone-performance.json`. Meria odozvu UI, nie sieť alebo zvuk poskytovateľa.

Skutočná kompozícia konzoly bola overená pri 1440/1280/1024/390/320 CSS px, pri zmenšenom pohybe a 200 % prepočte layoutu (1440 fyzických/720 CSS px). Izolované screenshoty a logy sú v `.context/sync-followup/`. Mapa je vo fixture zámerne bez externého prístupu. Skóre internej vizuálnej kontroly: 95/100.

## Vydanie a hranice

S1–S4 tvoria jeden kontrolovaný UI balík s vlastným Preview a spoločným release gate; nahrádza odporúčané rozdelenie do štyroch PR. Vydanie vedie cez pracovnú vetvu → dev → main. Revert balíka rovnakým postupom nevyžaduje zmeny dát.

Žiadna zmena telefonického runtime, ovládačov hovoru, migrácií, workerov ani konfigurácie nasadenia. Nevzniká globálny refresh aplikácie. Reálne volania, zvuk, mobilný push, záťaž 8–10 volajúcich a živé doručovanie medzi dvomi účtami nie sú týmito izolovanými testami potvrdené. Samostatná migrácia správy používateľov nie je súčasťou vydania.
