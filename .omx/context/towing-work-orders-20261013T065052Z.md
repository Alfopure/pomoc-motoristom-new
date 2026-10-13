**Kontext pre ralplan: zákazky odťahovej služby**

Úloha: pripraviť konkrétny implementačný plán podľa klientovho e-mailu a používateľových doplnení. Používateľ výslovne požiadal skill `ralplan` (opravil pôvodný preklep `raw plan`). Teraz je autorizované plánovanie, nie implementácia, migrácie, odosielanie správ či deployment.

Požadovaný výsledok: plán samostatného modulu zákaziek v existujúcom repozitári, jednoduchého mobilného rozhrania šoféra a kancelárskeho spracovania až po úhradu, s testovateľnými kritériami a bezpečným TEST/production postupom.

Podklady: `.context/posudenie-appky-odtahovka.md`; celý e-mail `.context/attachments/assets/f08173d3-b55a-4d89-aa83-ec423eca6c5c/appka - odťahovka (1).eml`; rozbalené Word/text prílohy a tri obrázky v `.context/email-review/`. Kód bol preskúmaný na lokálnom `7ff4247`. V aktuálnom workspace nie sú `node_modules/next/dist/docs`; pred implementáciou je potrebné nainštalovať zamknuté závislosti a prečítať príslušné dodané Next návody.

Aktuálne usmernenie používateľa:
- Faktúry zrejme vystavujú v externom systéme; názov ani integrácia nie sú určené. Plánovací default: položky, zákazkový PDF, číslo/stav externej faktúry, evidencia úhrad, bez automatického vystavovania.
- Podpis nie je teraz zásadný; návrh jednoduchého dočasného postupu je delegovaný. Navrhnúť prázdne podpisové polia v PDF a voliteľnú fotografiu podpísaného papiera, žiadne vymyslené podpisy ani tvrdenie o právnej sile elektronického podpisu. Plnohodnotné podpisovanie môže nasledovať neskôr.
- Bežný zásah by mal ísť spracovať offline v PWA aspoň v základnom rozsahu; ide o nižšiu prioritu a môže byť doručená po online jadre. Konkrétny rozsah navrhnúť: už načítaná pridelená zákazka, zmeny polí, fotky, lokálne čakajúce dokončenie a synchronizácia po návrate siete. Nesľubovať offline nové pridelenia či garantovaný beh na pozadí.
- Návrh hotovosti je delegovaný: príjmy po zákazkách, odovzdania do kancelárie, potvrdenia/opravné pohyby, zostatok konkrétneho vodiča.
- Používateľ chce zatiaľ dokončiť plán; ďalší rozhovor nie je nutný pre tieto plánovacie defaulty.

Overené fakty: `src/domain/types.ts:68` má iba štyri kancelárske roly; `:249` má len metódu/stav úhrady; `:638` základ prípadu. `src/server/motorist-mutations.ts:618` prideľuje techniku, nie overenú identitu vodiča; `:1031` rieši prílohy. `src/data/dispatch-repository.ts:177` načítava dispečing. `src/app/page.tsx` posiela oprávneného člena do dispečerského loadera; dnešné rozhranie nie je bezpečný vodičský vstup. `src/server/case-pdf.ts` má engine pre jednostranový prehľad, nie zákazkový list. `src/server/email-delivery.ts` má e-mailovú infraštruktúru. `public/sw.js` necachuje API a autentifikované stránky; pracovné offline dáta neexistujú. Existujúce RLS je nutné posúdiť v aktuálnom súbore migrácií, nie len vo foundation schéme.

Hranice: prípad dispečingu nemusí byť vlastný odťah; vlastná zákazka má samostatný životný cyklus a väzbu na prípad. Práca/fakturácia/platba sú odlišné stavy. Historické doklady a platby sa neprepisujú. Povoľovať viac pridelení jednému šoférovi. Číselníky klienta spárovať so súčasnými, nevkladať automaticky seed do skopírovanej DB.

Prevádzka: zachovať aktuálnu vetvu `Alfopure/towing-service-app`, nič neprejmenovať. Budúca realizácia vychádza z aktuálneho `dev` podľa AGENTS.md. Preview → PR do dev → stabilný TEST `https://test.dispecing.linkapomoci.sk`, Supabase `nzpnqdstvkfncflgqlny`. Produkcia `ifpaeegaesdmljfkdvcn` až po osobnom schválení identifikovaného otestovaného rozsahu. SQL pripraviť cielene a vyžiadať projektovo konkrétnu autorizáciu, pokiaľ nebola dodaná v budúcej realizačnej úlohe. Žiadne cudzie/retired projekty, nové workery/listenery/cron ani kontakty s historickými zákazníkmi.

Otvorené veci riešiteľné defaultom v pláne: externý účtovný systém neznámy; podpis dočasný papierový; offline dodanie nižšej priority; konkrétne účtovné/právne texty a sadzby má dodať vlastník, nevymýšľať ich. Pred živou realizáciou overiť aktuálny dev a migrácie. Aktuálna schéma/produkčné readiness sa pri plánovaní nemení ani nevyhlasuje za overené.

Postup: používam skutočný skill prečítaný cez Conductor RunLocalCommand z `/Users/michalmichalek/.codex/skills/ralplan/SKILL.md` a jeho nadväzujúci `/Users/michalmichalek/.codex/skills/plan/SKILL.md`. Konsenzus bez --interactive; dôkladný režim pre nové oprávnenia, PII, offline dáta a finančné zápisy. Planner → Architect → Critic postupne, najviac 5 cyklov; výstup `.omx/plans/towing-work-orders-20261013.md`, nevykonávať automaticky. Výskumník nezávisle preverí oficiálne zdroje a obmedzenia PWA.
