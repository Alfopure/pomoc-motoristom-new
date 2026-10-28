# Ďalší postup po stretnutí s klientom — 27. 10. 2026

**Novšie spresnenie majiteľa a ralplan dokončenia:** [plán dokončenia a App Store1.0](dokoncenie-a-appstore-2026-10-27.md). Zoznam ľudí sa dodá neskôr, Erosov postup už slúži ako baseline, Braňovi sú pripravené požiadavky a Final CD používa jeden všeobecný účet; tieto body už nie sú všeobecné blokátory vývoja.

Stav: dokončený návrh po architektonickej a nezávislej kontrole. Toto je produktový plán, nie vykonané nasadenie. [Detail dodávok, rozhodnutí a rizík](../../.omx/plans/upravy-po-stretnuti-20261027.md) a [kritériá prijatia](../../.omx/plans/test-spec-upravy-po-stretnuti-20261027.md).

## Použiteľnosť podkladov

Nový prepis má 1 000 časovo označených výpovedí a končí v 107:49. Je celý čitateľný, bez poškodenia kódovania a bez spätných skokov času. Druhý súbor má 317 výpovedí do 43:29 a je úplne totožný s prepisom z 23. októbra, ktorý už bol podkladom predchádzajúceho plánu. Nejde o druhú novú požiadavkovú sadu.

Bez pôvodného audia nemožno potvrdiť, že nič nechýba. V novom texte sú dlhšie časové odstupy a odkazy na nakreslené schémy a screenshoty, ktoré priložené nie sú. Na návrh ďalších etáp je text dostatočne použiteľný. Konkrétne názvy/spojenia regiónov a detaily externého nájomného systému z neho nemožno bezpečne domyslieť. [Audit súborov](../../.omx/context/stretnutie-klient-20261027-transcript-audit.json).

## Čo mení nové stretnutie

1. **Práca sa najprv odovzdáva skupine, až potom človeku.** Centrála → pobočkový front → lokálny dispečer → pristavovač/odťahovkár. Dnes existuje priame pridelenie človeku; pobočkové prijímanie a miestne oprávnenia treba doplniť. Požiadavku musí byť možné odovzdať aj bez konkrétneho auta.
2. **Final CD potrebuje pracovný zoznam prípadov.** Dnešná konzultácia, zúčtovanie a publikované PDF sú základ. Nové zadanie pridáva povolený priebežný zoznam, zvýraznené poistné udalosti, kontaktovanie klienta, poznámky a štatistiky. Údaje partnera sa nesprístupnia ako celý interný spis.
3. **Pristavovač nemá prepisovať údaje do nájomného systému.** Prenos do rozpracovaného nájmu je samostatná chýbajúca integrácia s Braňom. Čítanie dostupnosti áut neznamená možnosť vytvoriť nájom. Potrebujeme jeho podporované API a potvrdenie externého draftu.
4. **Notifikácie majú oznamovať dôležitú prácu.** Príchod do skupiny, pridelenie človeku a problém majú určeného príjemcu; každý priebežný stav nemusí všetkým zvoniť. Stav práce a jeho potvrdenie sú oddelené od doručenia push.

## Odporúčané dodávky

| Poradie | Čo odovzdáme | Čo má klient vedieť vyskúšať |
|---|---|---|
| **1. Prevádzkový základ** | Pilotní používatelia a skupiny, pobočkový front, bezpečné miestne pridelenie a trvalá evidencia oznámenia s explicitným opakovaním. Cielené preverenie hlásených problémov bez zvuku. | Dvaja príjemcovia pobočky vidia novú prácu, jeden ju prevezme a pridelí vodičovi alebo sebe; iná skupina nemá prístup. Prvý pilot je sledovaný webový front, systémový mobilný push až v mobilnej dodávke. |
| **2. Final CD pilot — súbežne** | Najprv partnerský zoznam, poistné udalosti a následný kontakt. Potom poznámky/štatistiky a dokončenie formulára Správy o nehode ako samostatná časť. | Partner vidí svoje schválené údaje a prevezme poistnú udalosť. Prvú ukážku neblokuje dokončenie mobilu, nájmov ani všetkých štatistík; celé prijatie naďalej zahŕňa dohodnutý rozsah. |
| **3. Mobilný pracovný tok** | Nové jazdy/odvozy/návraty, základ vodičskej odťahovej karty, doklady a zrozumiteľné oznámenia. Následne obmedzené volanie kolegom z terénu. | Skutočný iPhone dostane správnu kartu, vodič vykoná prácu a odovzdá podklady. Kancelárske nacenenie zostáva na webe. |
| **4. Nájom bez opakovaného prepisovania** | Prenos do externého draftu, externé ID a stav, čo ešte treba doplniť. Kontrakt s Braňom sa rieši hneď, implementácia podľa dostupnosti API. | Opakovaný pokus nevytvorí druhý nájom. Nejasný výsledok sa neoznačí za úspešný prenos. |
| **5. Erosova prevádzková akceptácia** | Ukážka existujúcej odťahovej knihy hneď; potom iba potvrdené úpravy a celý pilot vrátane prepojenia s pristavením/návratom. | Založenie → pridelenie → fotografie/papier → kontrola/cena → PDF → evidencia faktúry a úhrad. AWP evidencia zostáva bez druhého vyslania vodiča. |
| **Neskôr** | Board flotily ako Trello, cenníkové triedy, širšie opravy/kalendár, AI návrh prípadu a ďalšie integračné projekty. | Rozšírenia neodsunú prvé použiteľné odovzdávanie práce ani Final CD. |

Odťahovkár, ktorý má aj pristavovať, dostane obe vykonávateľské oprávnenia. Samotný pristavovač nedostane odťahy ani účtovníctvo. Pri odťahu s náhradným autom zostávajú dva súvisiace výkony pod jedným prípadom. Ich dispečeri vidia len potrebný koordinačný súhrn druhej práce, nie jej cudzie prílohy alebo financie. Návrat náhradného auta odťahovkou sa nevykazuje druhýkrát.

## Čo treba získať od klienta a dodávateľov

- **Mango + Alenka, so vstupom Erosa:** pilotný zoznam ľudí, overené emaily, príslušnosť ku skupinám a kto prijíma novú prácu. Netreba čakať na všetkých zamestnancov, ak máme potvrdenú malú pilotnú zostavu.
- **Eros + Mango:** kto spracuje klienta pred vyslaním odťahu a ako funguje priamy vstup odťahového dispečingu. Stretnutie toto pravidlo ešte neuzavrelo.
- **Braňo:** presný TEST endpoint a oprávnenie na vytvorenie draftu, minimum polí, statusy, externá referencia a bezpečné overenie po výpadku odpovede.
- **Final CD + majiteľ:** povolené polia, kto dostáva poistné udalosti, kto vidí poznámky a čo presne počítame v štatistikách.

Vzor Správy o nehode už máme overený zo SKP; nežiada sa znova. Príjem SMS má softvérový základ, ale aktuálnu podporu konkrétneho čísla a živé doručenie treba samostatne preveriť. Nové verejné čísla zamestnancom ani čas Apple schválenia zo stretnutia nevyplývajú.

## Ako to odovzdávať a overovať

Menšie vydania na **https://test.dispecing.linkapomoci.sk**, pri každom konkrétny commit a jedna ukážka zmeneného toku. Cielené testy oprávnení/súbehov, existujúca CI brána a fyzický mobilný pilot tam, kde záleží na zvuku, notifikáciách alebo polohe. Zelený build ani health nepotvrdzujú živú integráciu. Prvý webový pilot sa označí ako webový; mobilný push a nový natívny modul sa neprezentujú ako hotové skôr, než majú vlastný dôkaz.

Produkčné vydanie, SQL a provider zmeny majú svoje existujúce pravidlá. Tento plán nemení produkciu, nespúšťa nahrávanie ani nezasahuje do samostatného Watchdogu alebo poľskej databázy. Výhľad jednej aplikácie môže neskôr zahŕňať podporované integrácie; nejde o povolenie spájať cudzie databázy v tejto etape.
