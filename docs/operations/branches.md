# Pobočky: odovzdanie práce centrála → pobočka → vykonávateľ

Modul **Pobočky** je súčasť spoločnej aplikácie. Centrála ho nájde v dispečingu (Menu → Prevádzka → **Pobočky**) a v detaile prípadu v časti **Pobočky – odovzdaná práca**. Pobočkový dispečer sa prihlási tým istým prihlásením a otvorí sa mu `/pobocka`.

## Kto čo vidí

- **Centrála** (aktívny dispečerský profil): všetky pobočky, odosiela prácu, presúva nepridelenú prácu medzi pobočkami, vidí reporty všetkých pobočiek. Správca alebo administrátor navyše nastavuje pobočky a ich ľudí (karta **Tím a nastavenie**).
- **Miestny dispečer** (účet s rolou *Pobočkový dispečer* a miestom „Miestny dispečer“ v pobočke): iba práca a reporty svojich pobočiek. Prevezme požiadavku a pridelí ju človeku z pobočky alebo sebe (ak má aj rolu Pristavovač).
- **Vykonávateľ** (člen pobočky s rolou Pristavovač, pri odťahu Vodič): pridelenú prácu vidí v **Moje jazdy**, prípadne odťahovú zákazku v **Moje zákazky**. Celý pobočkový zoznam ani reporty nevidí.

Prístup kontroluje server pri každom čítaní aj príkaze. Odobratie z pobočky alebo deaktivácia účtu odoberie prístup okamžite. Pobočka vidí iba údaje potrebné na vykonanie (číslo prípadu, kontakt, vozidlo, miesta, termín, pokyny), nie celý spis, poznámky, prílohy ani financie. Pri viacerých prácach v jednom prípade vidí druh, stav a zodpovednú pobočku tej druhej.

## Priebeh

1. Centrála odošle požiadavku pobočke. Auto môže byť zatiaľ neurčené; odvoz potrebuje vybrané vozidlo u zákazníka.
2. Požiadavka čaká vo fronte pobočky. Prevziať ju môže iba jeden miestny dispečer; súbežné prevzatie skončí jedným vlastníkom.
3. Miestny dispečer pridelí prácu. Pri pristavení, odvoze a presune vznikne logistická jazda pridelená vykonávateľovi. Pri odťahu vznikne odťahová zákazka s väzbou na prípad a kontaktom; založí ju miestny dispečer, ktorý má oprávnenie odťahovej kancelárie (to je celofiremné, preto ho dostáva iba odťahová kancelária, nie bežná pobočka). Vodiča, priebeh a vyúčtovanie vedie zákazka. Stav jazdy vidí miestny dispečer aj centrála na webe aj v appke: **Pridelené vykonávateľovi** → **Prijaté vykonávateľom** (vykonávateľ jazdu prijal, ešte nevyrazil) → **Prebieha** (po Začať jazdu). Prijatá jazda sa počíta medzi pridelenú prácu a do „po termíne“, kým nezačne.
4. Miestny dispečer môže pred štartom zmeniť vykonávateľa, termín, potvrdiť termín alebo jazdu zrušiť; po štarte to môže iba centrála. Požiadavku so zrušenou jazdou možno vrátiť do frontu. Ak miestneho dispečera odoberú z pobočky, jeho prevzaté požiadavky sa vrátia do frontu. Priebeh, doklady, návrat a kontrolu vozidla vedú existujúce Moje jazdy a Výjazdy a odvozy.

Opakovanie nepotvrdeného príkazu s tým istým identifikátorom nevytvorí druhú jazdu. Prvý pilot používa sledovaný webový front (obnova každých 30 s); systémové mobilné upozornenia prídu s ďalšou verziou aplikácie.

## Reporty

Obdobie, pobočka a druh práce. **Prijaté** počíta každé odovzdanie do pobočky; presunutá požiadavka zostane započítaná aj pôvodnej pobočke. Jedinečné požiadavky a prípady sú zobrazené samostatne. **Reakcia** je čas od príchodu do pobočky po prvé prevzatie v tej istej pobočke; **do pridelenia** po vytvorenie konkrétnej jazdy. Chýbajúce časy zostávajú „neznáme“, nie nula. Vykonané sa pripisuje pobočke, ktorá prácu pridelila. Zaťaženie ukazuje otvorenú pridelenú prácu podľa vykonávateľa. Financie v reportoch pobočiek nie sú.

## Nasadenie

Migrácie `20261028100000_branch_work_groups.sql` a `20261028110000_branch_work_groups_review.sql` (opravy po revízii) pridávajú tabuľky pobočiek, členstiev, požiadaviek, udalostí a potvrdeniek príkazov, rolu `branch` pre účty a obmedzené rozšírenie `app_private.operations_actor`: miestny dispečer získa kancelárske oprávnenie k jazdám iba počas jedného príkazu pobočky nad svojou prevzatou požiadavkou alebo jej jazdou. Kontraktný test: `python3 tests/postgres/branch-work-groups.py` (lokálny dočasný PostgreSQL). Na produkciu sa migrácia aplikuje až s výslovným schválením produkčného vydania.
