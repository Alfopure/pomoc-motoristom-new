# Správa o nehode: vstup pre dokončenie P6

Stav k 27. 10. 2026: **všeobecný vzor identifikovaný a overený; implementácia P6 zostáva otvorená**. Majiteľ spresnil, že sa má použiť bežne používaný verejný formulár. Samostatný firemný vzor už nie je požadovaný vstup.

Požiadavka vychádza z prepisu stretnutia z 23. 10., čas 25:42–26:31: klient má dostať odkaz, vyplniť správu o nehode a odovzdať ju k správnemu prípadu. Dostupné prílohy obsahujú prepis a obrázok správy používateľov, nie vzor výslednej správy. Partnerský výstup a evidencia poškodenia náhradného auta sú samostatné dokumenty.

## Zvolený zdroj

Základom je slovenský európsky formulár **Správa o nehode**, ktorý Slovenská kancelária poisťovateľov aktuálne odkazuje vo svojich [tlačivách na stiahnutie](https://www.skp.sk/tlaciva-na-stiahnutie/):

- [Originálne PDF SKP](https://www.skp.sk/wp-content/uploads/2023/09/sprava_o_nehode.pdf), jedna strana, overené stiahnutím a vizuálnou kontrolou 27. 10. 2026.
- SHA-256 zdroja: `7d0f634a2a18e006c67e65b1d8516bbe46bb9c845627cfde3f6cf00cc5948615`.
- [Kooperativa potvrdzuje použiteľnosť tlačiva inej poisťovne aj podpis oboch účastníkov](https://kooperativa.sk/faq/poistenie-auta/sprava-o-nehode-potrebujem-ju-mat-v-aute). Jej vlastný balík obsahuje ďalšie poisťovňové strany, preto všeobecný základ berieme z SKP.

## Obsah a hranica dokončenia

| Časti vzoru | Zachovaný obsah |
| --- | --- |
| 1–5 | Čas a poloha udalosti, zranenia, škody mimo vozidiel A/B, osoby schopné dosvedčiť priebeh. |
| 6–9 pre A aj B | Identifikácia poistených, motorových a prípojných vozidiel, poistných zmlúv a vodičov vrátane dokladov. |
| 10–11 | Miesto nárazu na každom vozidle a jeho zjavné poškodenie. |
| 12 | Rovnakých 17 možností priebehu pre každú stranu; súčet označení. |
| 13–15 | Kresba situácie, vyjadrenia strán a podpis každého vodiča. |

Vzor obsahuje aj podmienené údaje: napríklad príves, svedkov alebo poistného sprostredkovateľa. Existencia kolónky sama neurčuje univerzálne povinnú hodnotu. Pri návrhu validácie sa rozlišuje rozpracovaný podklad, neznámy údaj a obojstranne podpísaná správa; vyplnenie alebo potvrdenie iba jedným klientom sa neoznačí za podpis oboch.

Označenie A/B neurčuje vinníka. Prevzatie štruktúry tlačiva samo nepotvrdzuje právny účinok budúceho elektronického podpisovania. Konkrétny partnerský prístup a odoslanie dokumentu zostávajú výslovnými krokmi, bez automatického zdieľania interných poznámok. Text o automatickom nároku na náhradu sa do všeobecného tlačiva nepridáva.

## Pripravený integračný kontrakt

| Oblasť | Kontrakt pre implementáciu po potvrdení vzoru |
| --- | --- |
| Identita | Samostatný report ID, organization ID, case ID a nemenná verzia schváleného vzoru. Nie fleet damage ID ani partnerský output ID. |
| Odkaz | Náhodný token uložený iba ako hash; samostatná expirácia a revokácia. Prístup iba k jednému formuláru a jeho povoleným prílohám. |
| Klientsky web | Formulár podľa zvoleného vzoru v tejto aplikácii, bez dispatch session alebo všeobecného case API. Token z fragmentu URL sa vymení za úzko obmedzenú httpOnly session. |
| Zápis | Command ID, hash obsahu, expected revision a transakčné odovzdanie. Opakovanie rovnakého príkazu vráti pôvodné potvrdenie; iný obsah pod rovnakým ID sa odmietne. |
| Dokument | PDF zo schválenej verzie a odovzdaných údajov cez existujúci renderer. Výsledok má hash, súkromné uloženie a kontrolu oprávnenia pri každom stiahnutí. |
| Zdieľanie | Samostatné vedomé zverejnenie partnerovi. Vytvorenie reportu samo nesprístupní interné prílohy, kontakty ďalších osôb ani zúčtovanie. |
| SMS/email | Samostatný potvrdený príjemca a existujúci odosielací proces. Vytvorenie odkazu nič automaticky neodosiela. |
| Akceptácia | Nesprávny, expirovaný alebo odvolaný token je odmietnutý; retry nevytvorí druhý dokument; povinné polia a PDF sa porovnajú so schváleným vzorom. |

Blok chýbajúceho vzoru je vyriešený týmto zdrojom a spresnením majiteľa. P6/A06 zostáva implementačne otvorené; samotný výber tlačiva neznamená hotový klientsky formulár, PDF alebo akceptáciu celého rozsahu Final CD. Odťahy, návraty, konzultácie a partnerský portál už majú samostatné TEST overenie.
