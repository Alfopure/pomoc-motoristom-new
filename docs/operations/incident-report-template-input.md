# Správa o nehode: vstup pre dokončenie P6

Stav: **čaká na schválený vzor a povinné polia**. Toto je technický podklad, nie schválená správa o nehode ani hotový dokument Final CD.

Požiadavka vychádza z prepisu stretnutia z 23. 10., čas 25:42–26:31: klient má dostať odkaz, vyplniť správu o nehode a odovzdať ju k správnemu prípadu. Dostupné prílohy obsahujú prepis a obrázok správy používateľov, nie vzor výslednej správy. Partnerský výstup a evidencia poškodenia náhradného auta sú samostatné dokumenty.

## Potrebný produktový vstup

Majiteľ alebo Final CD poskytne aktuálny vzor a určí:

- ktoré polia vyplňuje klient, ktoré kancelária a ktoré musia zostať povinné aj pri neznámej hodnote;
- podobu výsledného PDF vrátane strán, podpisov, príloh a schváleného záverečného textu;
- či sa odovzdáva spoločná správa účastníkov, samostatné podklady jedného klienta alebo oboje;
- konkrétny partnerský prístup a príjemcu dokumentu, bez automatického zdieľania interných poznámok prípadu.

Podpis, zodpovednosť za nehodu, právny účinok ani text o náhrade sa nedopĺňajú odhadom. Pole „neznáme“ sa nepremení na potvrdenie klienta.

## Pripravený integračný kontrakt

| Oblasť | Kontrakt pre implementáciu po potvrdení vzoru |
| --- | --- |
| Identita | Samostatný report ID, organization ID, case ID a nemenná verzia schváleného vzoru. Nie fleet damage ID ani partnerský output ID. |
| Odkaz | Náhodný token uložený iba ako hash; samostatná expirácia a revokácia. Prístup iba k jednému formuláru a jeho povoleným prílohám. |
| Klientsky web | Formulár v tejto aplikácii, bez dispatch session alebo všeobecného case API. Token z fragmentu URL sa vymení za úzko obmedzenú httpOnly session. |
| Zápis | Command ID, hash obsahu, expected revision a transakčné odovzdanie. Opakovanie rovnakého príkazu vráti pôvodné potvrdenie; iný obsah pod rovnakým ID sa odmietne. |
| Dokument | PDF zo schválenej verzie a odovzdaných údajov cez existujúci renderer. Výsledok má hash, súkromné uloženie a kontrolu oprávnenia pri každom stiahnutí. |
| Zdieľanie | Samostatné vedomé zverejnenie partnerovi. Vytvorenie reportu samo nesprístupní interné prílohy, kontakty ďalších osôb ani zúčtovanie. |
| SMS/email | Samostatný potvrdený príjemca a existujúci odosielací proces. Vytvorenie odkazu nič automaticky neodosiela. |
| Akceptácia | Nesprávny, expirovaný alebo odvolaný token je odmietnutý; retry nevytvorí druhý dokument; povinné polia a PDF sa porovnajú so schváleným vzorom. |

Bez tohto vstupu zostáva P6/A06 a úplná akceptácia Final CD otvorená. Odťahy, návraty, konzultácie a partnerský portál sa dajú overovať a používať samostatne na TEST.
