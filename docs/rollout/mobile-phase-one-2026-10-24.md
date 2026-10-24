# Mobilná fáza 1 — príprava spoločného TESTu

Rozsah: funkčný základ hovor → uložený prípad → odovzdanie jednému pristavovačovi → priebeh a poloha → dokončenie. Majiteľ 24. 10. zadal realizáciu a spresnil, že spoločné fyzické testovanie bude potom. Final CD a Erosove odťahové zákazky sú ďalšie etapy.

## Implementované zmeny

- **Flotila:** spoločný limit servera a mobilu je 1 000 vozidiel, stránky zostávajú po 25. Hľadanie a filtre pracujú nad úplným podporovaným zoznamom. Regresie zahŕňajú 298, 350 a 1 000 rôznych vozidiel a odmietnutie nad podporovaným limitom. GPS a overená obsadenosť zostávajú samostatné údaje.
- **Prístupy:** v časti Moduly je dostupné **Obnoviť prístupy**, aj keď účet ešte nevidí Pristavenia. Obnova overí dispečerský profil aj identitu pristavovača; domovské obnovenie zahŕňa rovnakú kontrolu. Odobratie prístupu sa neobchádza cache ani automatickým povolením administrátorom.
- **Uložiť a odovzdať:** web aj mobil najprv uložia jeden prípad a otvoria existujúci editor odovzdania. Výber jedného príjemcu, náhľad údajov a výslovné potvrdenie zostávajú povinné; uloženie samotné nevytvára odovzdanie ani push.
- **Obnova:** mobil si zámer pokračovať v odovzdaní uchová v chránenom koncepte vrátane reštartu a oneskoreného potvrdenia. Web pri neoverenom výsledku uloženia zablokuje ďalšie vytvorenie a vyzve na kontrolu prípadov. Zlyhanie prílohy po úspešnom uložení nevytvorí druhý prípad.

Na webe zostáva existujúce priradenie vytvoreného prípadu k rozpoznanému hovoru. Mobil pri prenose čísla z hovoru automatickú väzbu nevytvára; používa existujúce **Detail hovoru → Po hovore → Priradiť k prípadu**.

## Overenie a distribúcia

Pred nasadením sa používajú existujúce testy, typy, lint a build gate. Izolované browser regresie používajú skutočné komponenty formulára a odovzdania so zachytenou sieťou: obyčajné uloženie, otvorenie odovzdania bez automatického odoslania, odmietnutie, strata odpovede, potvrdený zápis s chybou, neúplná odpoveď, chyba prílohy a rýchle opakované kliknutia.

Nové mobilné správanie vyžaduje novú podpísanú TestFlight binárku; samotné nasadenie API nezmení starý build 22. Serverový commit, skutočné číslo buildu a dostupnosť Apple sa uvádzajú v konkrétnom release zázname. Neoznačovať bežiaci build alebo iba prijatý upload za dokončenú distribúciu.

Kanonický izolovaný TEST: **https://test.dispecing.linkapomoci.sk**. Táto zmena nepotrebuje novú migráciu, daňové nastavenia, provider zdroje ani produkčné nasadenie. Pred pilotom sa overí skutočný prístup dvoch odlišných TEST používateľov; nevytvárajú sa zbytočne účty ani pozvánky iba kvôli automatickým kontrolám.

## Neskoršia spoločná akceptácia

[Jednoduchý checklist](../mobile/phase-one-acceptance.md) obsahuje hlavný scenár a krátke hlasové, prístupové a obnovovacie kontroly. Do výsledkov sa zapisuje skutočný serverový SHA, build oboch iPhonov a ID skúšobného prípadu/odovzdania.

**Fyzický pilot je odložený podľa pokynu majiteľa.** Automatické kontroly a samotná dostupnosť TestFlightu nepotvrdzujú fyzický push, zvuk, GPS pri pohybe/zamknutí ani úplnú prevádzkovú akceptáciu. Úspešný TEST pilot a produkčné vydanie sú samostatné míľniky.
