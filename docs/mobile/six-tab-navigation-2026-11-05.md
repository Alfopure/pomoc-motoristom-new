# Šesť položiek spodnej lišty · 5. 11. 2026

Majiteľ požiadal o **štyri vlastné moduly a dve pevné položky**. Lišta preto obsahuje `Prehľad · 4 vybrané moduly · Moduly`. Nové predvolené nastavenie dispečingu je Hovory, Prípady, Úlohy a Nástroje. Cez **Moduly → Upraviť lištu** sa vlastné položky pridávajú, vymieňajú a presúvajú; Prehľad a Moduly zostávajú na krajoch.

Skôr uložené tri moduly zostávajú v rovnakom poradí. Štvrtý sa pridá cez **Pridať** alebo úpravu lišty; vlastný výber sa neprepisuje. Piaty vlastný modul ponúkne výmenu existujúceho. Účet s menším počtom povolených modulov vidí iba svoju dostupnú kapacitu. Úprava navigácie nepridáva oprávnenia; každý modul a jeho API naďalej kontrolujú aktuálny serverový prístup.

Šesť skutočných dotykových plôch má pri šírke 320 b približne 47,7 b. Nulové vnútorné horizontálne odsadenie ponechá názvy čitateľné bez zmenšovania písma. Nad 1,1× sa viac ako tri položky usporiadajú do dvoch radov; šesť položiek má pri 2× výšku 190 b. Názvy tak nemusia lámať slová na jednotlivé písmená. Pri piatich položkách zostáva prázdne neinteraktívne miesto pred Modulmi, aby pevná položka ostala vpravo. Obsah, pás hovoru a toast používajú rovnakú skutočnú výšku lišty. Náhľad v karte Moja lišta využije širšiu vnútornú plochu.

## Overenie

- Všetkých **1 451 testov / 90 súborov** prešlo. Nové regresie chránia štyri vlastné položky, odmietnutie piatej, pevné kraje, poradie, uložené staršie voľby a geometriu pri väčšom písme.
- TypeScript, ESLint a iOS/Android exporty prešli bez zmeny závislostí.
- Existujúca vizuálna skúška redizajnu: **45 kontrol prešlo**.
- Nová skúška: **35 kontrol prešlo**. `node tests/mobile/ui-six-tabs-smoke.mjs` skúša skutočnú aplikáciu na 320/390/768 b, šesť dotykových plôch, pridanie, výmenu a poradie. Používa iba syntetický účet a blokuje vzdialené zápisy. Výstup je v `.context/mobile-six-tabs-qa/`.
- Browserová emulácia väčšieho písma nenahrádza natívny Dynamic Type, VoiceOver ani fyzické overenie iPhone.

Nový natívny TEST build je potrebný, pretože OTA sú vypnuté. Výnimka zo simulátorovej kontroly udelená pre build **1.0.0 (34)** sa automaticky neprenáša na túto ďalšiu verziu. Konkrétny vydaný zdroj, číslo buildu a výsledok TEST nasadenia sa zaznamenajú po overení.
