# Spoločný web: výjazdy, odvozy a partneri

Zmena patrí do existujúceho dispečingu. TEST je `https://test.dispecing.linkapomoci.sk`, databáza `nzpnqdstvkfncflgqlny`. Tento rozsah neoprávňuje nasadenie na produkciu.

## Používanie

- V ponuke modulov sú **Výjazdy a odvozy** a **Partneri a konzultácie**. V detaile prípadu sú súvisiace logistické jazdy, partner a odťahové zákazky. Prepnutie rešpektuje existujúcu ochranu rozpracovanej karty a ponechá telefonický host aplikácie.
- Logistická jazda môže čakať bez termínu. Pridelenie vodičovi nevytvorí skutočný začiatok ani rezerváciu času. Potvrdenie termínu a fyzický štart kontrolujú kolízie vodiča a vozidla. Nové použitie náhradného auta vyžaduje potvrdené aktuálne údaje o dostupnosti; odvoz už používaného auta túto podmienku nemá.
- Návrat patrí ku konkrétnemu miestnemu cyklu používania vozidla. Voľba odvozu vytvorí alebo preplánuje jednu existujúcu návratovú jazdu. Zákazník môže vozidlo vrátiť sám. Po skutočnom návrate nasleduje kontrola; uzavretie prípadu ani expirácia pôvodného odkazu návrat neodstránia.
- Dokončená jazda môže mať stav **Dôkazy čakajú**. Kancelária doplní skutočný zdroj, čas a autora údajov; nepotvrdzuje prevzatie za vodiča. Fotografie/PDF sú súkromné a každý prenos znovu overuje oprávnenie.
- Pristavovač s oprávnením `deliver` používa web **Moje jazdy** na `/moje-jazdy`. Partnerský účet používa `/partner`; nezískava tým profil dispečera. Existujúci mobilný kontrakt zostáva samostatný: nové webové jazdy sa vykonávajú cez web, pôvodné mobilné pristavenia majú spoločnú identitu a zachované potvrdenky.
- **Odťahové zákazky** otvárajú existujúci pracovný a finančný proces. Z prípadu možno vedome založiť viac zákaziek; opakovanie nepotvrdeného príkazu zachová pôvodnú identitu. AWP evidencia vyžaduje externú referenciu a neprideľuje vodiča. Na lokálny výkon sa prevedie výslovne, s dôvodom.
- Pri odvoze náhradného auta odťahom sa v existujúcej zákazke vyberie konkrétny otvorený cyklus auta. Vznikne jeden spoločný zámer návratu, ktorý vylučuje súbežný logistický odvoz. Dokončenie odťahu zaeviduje návrat; následná evidencia a kontrola auta sú dostupné vo Výjazdoch a odvozoch. Priebeh a financie naďalej upravuje odťahová zákazka.
- Pôvod od partnera je nezávislý od klienta a platiteľa. Konzultácia a nová prepojená asistencia majú samostatný platobný podklad. Zverejnenie partnerovi uloží nemennú obmedzenú verziu. PDF a odoslanie emailu sú samostatné kroky s potvrdeným príjemcom; prijatie poskytovateľom ešte nepotvrdzuje doručenie.

## Nasadenie a overenie

Nové migrácie sú súčasťou tejto zmeny, neposielať automaticky všetky staršie čakajúce migrácie ani seed. Pred produkčným vydaním treba samostatne schváliť presnú SQL zmenu pre produkčný projekt. Súkromné buckety sú `motorist-operation-evidence` a `motorist-partner-documents`; neposkytovať k nim verejnú politiku.

Lokálne overenie pokrýva databázové transakcie a súbežný konflikt kapacity, zachovanie pôvodných mobilných potvrdeniek, pozvania a revokácie, oddelené zúčtovanie a prístup k súborom. Existujúci Vercel build ostáva povinnou bránou. Po merge do `dev` treba porovnať skutočný TEST commit a overiť správanie na kanonickej doméne. Použiť iba vlastné označené syntetické údaje, bez kontaktovania skopírovaných zákazníkov.

## Otvorené produktové vstupy

Schválený vzor a povinné polia správy o nehode chýbajú. P6 preto ostáva blokované; celý Final CD rozsah nemožno označiť za prijatý. Konkrétni príjemcovia, kontakty a ceny sa nastavujú výslovne, bez automatického prevzatia historických údajov alebo odhadovanej ceny. Doručenie skutočných pozvaní/emailov a fyzický mobilný pilot vyžadujú vlastné prevádzkové overenie.

Rozšírená evidencia opráv, kalendár prenájmov, SWHouse zápisy a automatické pripomienky sú podľa schváleného plánu neskoršia etapa. Uložený partnerský pôvod sa pri založení prípadu dopĺňa druhým príkazom; prípadná chyba sa zobrazí a pôvod sa dokončí v detaile prípadu.
