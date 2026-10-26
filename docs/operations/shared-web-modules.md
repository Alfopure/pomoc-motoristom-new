# Spoločný web: výjazdy, odvozy a partneri

Zmena patrí do existujúceho dispečingu. TEST je `https://test.dispecing.linkapomoci.sk`, databáza `nzpnqdstvkfncflgqlny`. Tento rozsah neoprávňuje nasadenie na produkciu.

## Používanie

- V ponuke modulov sú **Výjazdy a odvozy** a **Partneri a konzultácie**. V detaile prípadu sú súvisiace logistické jazdy, partner a odťahové zákazky. Prepnutie rešpektuje existujúcu ochranu rozpracovanej karty a ponechá telefonický host aplikácie.
- Logistická jazda môže čakať bez termínu. Pridelenie vodičovi nevytvorí skutočný začiatok ani rezerváciu času. Potvrdenie termínu a fyzický štart kontrolujú kolízie vodiča a vozidla. Nové použitie náhradného auta vyžaduje potvrdené aktuálne údaje o dostupnosti; odvoz už používaného auta túto podmienku nemá.
- Návrat patrí ku konkrétnemu miestnemu cyklu používania vozidla. Voľba odvozu vytvorí alebo preplánuje jednu existujúcu návratovú jazdu. Zákazník môže vozidlo vrátiť sám. Prehľad **Návraty** ukazuje otvorené návraty a čakajúce kontroly aj po dokončení pristavenia. Po skutočnom návrate nasleduje kontrola; uzavretie prípadu ani expirácia pôvodného odkazu návrat neodstránia.
- Dokončená jazda môže mať stav **Dôkazy čakajú**. Kancelária doplní skutočný zdroj, čas a autora údajov; nepotvrdzuje prevzatie za vodiča. Fotografie/PDF sú súkromné a každý prenos znovu overuje oprávnenie.
- Pristavovač s oprávnením `deliver` používa web **Moje jazdy** na `/moje-jazdy`. Partnerský účet používa `/partner`; nezískava tým profil dispečera. Existujúci mobilný kontrakt zostáva samostatný: nové webové jazdy sa vykonávajú cez web, pôvodné mobilné pristavenia majú spoločnú identitu a zachované potvrdenky.
- K novej logistickej jazde sa dá po pridelení konkrétnemu aktívnemu pristavovačovi zverejniť obmedzený webový odkaz. Náhľad sa potvrdzuje pred vytvorením odkazu. Expirácia, odvolanie, prepridelenie alebo zrušenie členstva odoberú prístup; nevymažú samotnú jazdu ani jej návratový záväzok. Tieto nové odkazy neposielajú collection/transfer údaje do pôvodného mobilného rozhrania a samy neodosielajú SMS ani email.
- Poškodenie má vlastný zachovaný popis, autora, čas a fotografiu alebo odôvodnenie jej nedostupnosti. Kancelária mení riešiteľa a stav. Hlásenia sa dajú otvoriť aj z detailu auta. Otvorené poškodenie blokuje nové vydanie vozidla. Jeho vyriešenie samo nepotvrdí kontrolu; pripravenosť potrebuje kontrolu a odovzdávacie dôkazy alebo zaznamenanú výnimku spolu s aktuálnymi údajmi o dostupnosti.
- **Odťahové zákazky** otvárajú existujúci pracovný a finančný proces. Z prípadu možno vedome založiť viac zákaziek; opakovanie nepotvrdeného príkazu zachová pôvodnú identitu. AWP evidencia vyžaduje externú referenciu a neprideľuje vodiča. Na lokálny výkon sa prevedie výslovne, s dôvodom.
- Pri odvoze náhradného auta odťahom sa v existujúcej zákazke vyberie konkrétny otvorený cyklus auta. Vznikne jeden spoločný zámer návratu, ktorý vylučuje súbežný logistický odvoz. Dokončenie odťahu zaeviduje návrat; následná evidencia a kontrola auta sú dostupné vo Výjazdoch a odvozoch. Priebeh a financie naďalej upravuje odťahová zákazka.
- Pôvod od partnera je nezávislý od klienta a platiteľa. Konzultácia a nová prepojená asistencia majú samostatný platobný podklad. Zmeny zúčtovania majú audit autora, času a pôvodného aj nového podkladu. Zverejnenie partnerovi uloží nemennú obmedzenú verziu. PDF a odoslanie emailu sú samostatné kroky s potvrdeným príjemcom; prijatie poskytovateľom ešte nepotvrdzuje doručenie.
- Nový webový prípad a jeho partnerský pôvod sa ukladajú v jednej transakcii. Neistý výsledok sa overí rovnakým príkazom. Partnerské rozpracované formuláre a nepotvrdené príkazy ostávajú v pamäti prihlásenej session pri prepnutí modulu alebo prípadu; odchod rešpektuje ochranu rozpracovaných údajov.

## Nasadenie a overenie

Nové migrácie sú súčasťou tejto zmeny, neposielať automaticky všetky staršie čakajúce migrácie ani seed. Pred produkčným vydaním treba samostatne schváliť presnú SQL zmenu pre produkčný projekt. Súkromné buckety sú `motorist-operation-evidence` a `motorist-partner-documents`; neposkytovať k nim verejnú politiku.

Lokálne overenie pokrýva databázové transakcie a súbežný konflikt kapacity, zachovanie pôvodných mobilných potvrdeniek, pozvania a revokácie, oddelené zúčtovanie a prístup k súborom. Existujúci Vercel build ostáva povinnou bránou. Po merge do `dev` treba porovnať skutočný TEST commit a overiť správanie na kanonickej doméne. Použiť iba vlastné označené syntetické údaje, bez kontaktovania skopírovaných zákazníkov.

## Otvorené produktové vstupy

Schválený vzor a povinné polia správy o nehode chýbajú. P6 preto ostáva blokované; celý Final CD rozsah nemožno označiť za prijatý. Potrebný vstup a integračný kontrakt sú v [podklade pre správu o nehode](incident-report-template-input.md). Konkrétni príjemcovia, kontakty a ceny sa nastavujú výslovne, bez automatického prevzatia historických údajov alebo odhadovanej ceny. Doručenie skutočných pozvaní/emailov a fyzický mobilný pilot vyžadujú vlastné prevádzkové overenie.

Rozšírená evidencia opráv, kalendár prenájmov, SWHouse zápisy a automatické pripomienky sú podľa schváleného plánu neskoršia etapa. Nové odkazy na jazdy sa viažu na existujúceho prideleného člena; vytváranie ad-hoc externých vodičov nie je súčasťou tohto webového doplnenia.
