# Dispečing V2 — vydanie na testovací produkčný odkaz

Používateľ 13. 9. 2026 schválil vydanie celej novej verzie na `https://dispecing-test.vercel.app/`. Overená doména patrí samostatnému projektu `pomoc-motoristom-new` (`prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, runtime `fra1`). Používa existujúcu databázu tejto kópie `ifpaeegaesdmljfkdvcn` vo Frankfurte. Toto schválenie nahrádza predchádzajúce obmedzenie na ukážku; história návrhu zostáva v [pláne V2](dispatch-redesign-v2.md).

## Kontrola stretnutí a výsledný rozsah

Opätovne boli prečítané celé prepisy z 10. a 11. septembra a porovnané s neskoršími priamymi spresneniami používateľa. Prioritou sú každodenná práca, stavové úlohy, odosielanie SMS, textové podklady a odovzdanie kolegovi. Vedľajšie rozhovory a budúce námety nie sú automaticky súčasťou vydania.

| Oblasť | Výsledok |
| --- | --- |
| Pracovisko | Nová navigácia, prehľadné karty prípadov a kompaktné zhrnutie kontaktu, vozidla a miest. Pôvodné filtre, triedenie, podrobné polia, PDF, prílohy a jedna história SMS zostávajú. |
| Prispôsobenie | Meniteľné šírky a skladanie strán, výška/maximalizácia karty prípadu, lokálne Mapa/Úlohy/Poznámky/Tabuľka a hlavné Úlohy na celú plochu. Prepnutie vzhľadu nemení otvorené editory ani ich providery. |
| Úlohy | Na vybavenie → Rozpracované → Na kontrolu → Vybavené. Výber kontrolóra a výsledku, súkromná notifikácia, vlastný zoznam kontrol, schválenie alebo návrat s dôvodom. Termín a pripomienka zostávajú samostatné; chat a väzby na 0..N prípadov ostávajú. |
| Widgety | Pastelové osobné/zdieľané poznámky, kalkulačka s mazaním znaku/výberu aj celého výpočtu, kalendár s agendou úloh, výber/poradie/viditeľnosť/zbalenie nástrojov. |
| Trasy | Viac bodov, ich presúvanie myšou, klávesnicou aj šípkami pri zachovaní vybraných miest. Zmena bodov zneplatní starý výpočet; nový výpočet je výslovný. |
| Textové podklady | Návrhy polí z označených riadkov s výberom pred vložením a kontrolou konfliktov. Originál možno stiahnuť. Ručná adresa odstráni staré GPS. |
| SMS | Prípadové aj samostatné odosielanie, šablóny, náhľad a história odoslaných. Prijaté správy ostávajú sekundárne; príjem sa týmto neaktivuje. |
| Odovzdanie | Obmedzený časovo platný odkaz s vybranými údajmi pre kolegu bez plného účtu: prijatie/odmietnutie, ETA a priebeh. Explicitné kopírovanie/SMS, obnova a zrušenie. Otvorenie odkazu neprijme úkon ani neuzavrie interný prípad. |

Niektoré zachované funkcie, napríklad PDF, vyhľadávanie, skladacia mapa incidentu či viacprípadové úlohy, boli hotové už pred V2. Nie sú vykazované ako nová implementácia.

## Opravy pred vydaním

- Serverová politika povoľuje schválené rozhranie aj na produkčnom cieli Vercelu. Bez tejto zmeny by zlúčenie ponechalo starý vzhľad a skrylo kalendár. Predvolený je nový vzhľad; osobná voľba pôvodného vzhľadu ostáva dostupná.
- Audit odhalil mazanie SMS konceptu pri zmene šablóny alebo novom otvorení z iného prípadu. Teraz človek výslovne zvolí zachovanie konceptu alebo jeho zahodenie a potvrdenie zmeny. Dovtedy zostávajú text aj príjemca; nemožno odoslať nerozhodnutý kontext. Potvrdenie zneplatní starý náhľad a vytvorí novú identitu požiadavky. Neisté odoslanie sa stále overuje tou istou požiadavkou.
- Text pri dokončovaní úlohy cez SMS vysvetľuje, že povinnú kontrolu kolegu nepreskočí automatická udalosť.

## Kontrola telefonovania

Porovnané boli V1, V2 aj výsledná pracovná oprava s `dev` a `main`. Východiskové stromy `dev` (`6cbd23e`) a `main` (`f870d22`) sú totožné, takže sa nepribaľuje ďalšia telefonická zmena z inej vetvy.

Telnyx integrácia, serverové príkazy a ovládanie hovorov, webhooky, IVR, obnovovanie spojenia, nahrávky/prepisy, SMS transport a serverové odosielanie, nastavenia telefónie, závislosti a cron zostali bez zmeny. Telefón ostáva v stabilne pripojenom provideri aj pri zmene vzhľadu a skladaní widgetov. Mení sa prezentácia telefónneho panelu a otvorenie SMS priamo do odosielania.

Nové odovzdanie používa samostatnú SMS na výslovne uvedené číslo kolegu, nie prípadovú SMS smerovanú na klienta. Úloha odovzdaná na kontrolu zostane pre kontrolóra aj po splnení súvisiacej SMS/polohovej alebo callback udalosti. Ide o úmyselnú zmenu dokončovania úloh, nie zmenu telefónneho smerovania.

## Overenie a hranice

Predchádzajúce V2 overenie obsahuje 175 jedinečných prehliadačových scenárov a 55 scenárov na izolovanom PostgreSQL. Pred vydaním bolo zopakovaných 690 telefonických/SMS service testov, dotknuté testy po oprave SMS a 30 scenárov rozhrania/widgetov vrátane produkčnej dostupnosti. Štyri nové scenáre chránia SMS koncepty. Opakované behy sa nepripočítavajú ako nové jedinečné testy. Celkový test, TypeScript a ESLint sa kontrolujú pred pushom; každý Vercel cieľ musí prejsť `vitest run`, `typecheck` a `build`.

Databázové funkcie oboch už aplikovaných aditívnych migrácií, RLS a oprávnenia boli znovu overené čítaním. Nová databáza, seed, telefónna migrácia ani worker/listener sa kvôli vydaniu nezavádza.

Vedomé hranice: parser nie je AI ľubovoľného rozhovoru a originál nearchivuje automaticky do databázy. Odkaz zverejňuje pevný výber údajov; obnovenie jeho prehľadu je ručné. Farba poznámky je automatická. Kalendár používa lokálny deň zariadenia. Mýto/nákladné profily trás, úplné rozšírenie externého lookupu vozidiel, čistenie flotily a natívna partnerská aplikácia sú ďalšie témy. Fyzický iPhone/Android, nainštalovaná PWA a skutočné audio/doručenie SMS sa nezamieňajú s automatizovanými testami; zákaznícke hovory ani správy sa pri tomto overení nevytvárajú.

## Vydanie a návrat

Postup je PR pracovnej vetvy do `dev`, overenie jeho Vercel aliasu, potom samostatný PR `dev` do `main`. Každé konkrétne nasadenie musí mať zhodný commit, správny projekt, stav READY a región `fra1`. Existujúce pravidlá firewallu sa zachovajú; povoľujú sa iba jeho presná adresa a identifikátor. Po každom kroku sa kontrolujú alias aj nemenná adresa, načítanie JS, povolené/odmietnuté identifikátory, login, verejná karta, anonymné oprávnenia a zobrazenie na notebooku/mobile. Náhodný neexistujúci token navyše overí zamietnutie v nasadenom databázovom RPC bez založenia záznamu.

Pôvodný produkčný frontend je zaznamenaný ako `dpl_Hp32m5nJP7sB7aBDgXCbYirm1123`. Prvý návrat pre používateľa je prepínač vzhľadu; prípadná kódová oprava alebo revert ide znovu cez `dev` do `main`. Návrat vzhľadu ani frontendu nevracia uložené údaje a nesmie odstrániť kontrolórov či históriu.

Konkrétne výsledné commity, deployment ID a konečné živé kontroly patria do release PR po dokončení nasadenia. Tento dokument opisuje rozsah a podmienky vydania, nie predčasné potvrdenie nasadenia.
