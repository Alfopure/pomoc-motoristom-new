# Kontrola chybových e-mailov, 12. 10. 2026

Rozsah: oprava príčin nájdených hlásení a zbytočnej naliehavosti upozornení,
nasadenie cez pracovný PR do `dev` a stabilného TESTu. Produkčné vydanie
vyžaduje osobitný súhlas majiteľa. Žiadna SQL migrácia ani zmena externých
pravidiel Sentry nie je súčasťou tejto opravy.

## Zistenia

Po potvrdení zdieľanej schránky sa 13. 10. skontrolovalo 24 chybových a
následných obnovovacích správ z obdobia od 8. 10. Desať z nich boli aplikačné
upozornenia: šesť správ o siedmich ledger udalostiach, dve o timeoutoch čítania
monitoringu a dve o otvorenom technickom incidente. Všetkých sedem ledger udalostí sa neskôr
úspešne spracovalo. Správy obsahovali potvrdenie spojenia účastníkov, ktoré
samo nepreukazuje kvalitu ani obojstrannú počuteľnosť zvuku.

| Hlásenie | Overená príčina a riešenie |
| --- | --- |
| `DISPECING-TEST-A`, Telnyx WebRTC `TypeError` zo 6. 10. | Pri vyčerpaní pokusov o spojenie knižnica vyvolá vnorenú chybu počas prechádzania svojho zoznamu poslucháčov. Synchrónne odhlásenie poslucháčov tento zoznam odstránilo. Odpojenie teraz okamžite zneplatní starého klienta a médiá, ale odhlási poslucháčov až po dokončení aktuálneho spracovania udalosti. |
| Ledger upozornenie 12. 10. o 16:55 UTC | Udalosť prijatá o 16:54:54 mala jeden neúspešný pokus; obnovená bola o 17:00:27. Session bola už o 16:55:10 v stave `talking`. Hlásenie prišlo skôr než existujúci cron dostal príležitosť zopakovať spracovanie. Samotný stav session nepreukazuje počuteľnosť. |
| Dve ledger udalosti 10. 10. o 19:25 UTC | Obe udalosti ukončenia boli spracované pri ďalšom behu o 19:30:27, s jediným evidovaným zlyhaním. Nová obmedzená lehota obnovy zabraňuje predčasnému incidentnému e-mailu. |
| Štyri staršie ledger udalosti 8.–9. 10. | Udalosť skončenia prehrávania z 8. 10. sa po jednom odložení spracovala približne za tri sekundy. Tri udalosti ukončenia hovoru z 9. 10. sa po jednom zlyhaní spracovali pri ďalšom crone. Ani jedna neostala v definitívnej chybe; ide o ďalšie doložené prípady pre obmedzenú lehotu obnovy. |
| Ojedinelé čítacie timeouty monitoringu 11.–12. 10. | Edge a aplikačné merania ukazujú dlhé čakanie pred databázovou odpoveďou pri krátkom čase upstream spracovania. Ide o indíciu prechodnej transportnej latencie, nie dôkaz pomalého SQL. Pribudlo jedno krátke overovacie čítanie; trvalá chyba sa naďalej hlási. |
| `DISPECING-TEST-B`, `SENTRY-BEIGE-HORIZON-D/A/9/8`, aktívne hovory 8.–12. 10. | Presné request ID sa zhodujú s runtime timeoutmi čítania: RPC snapshot, presence, devices a lines. Skrátené Sentry hlásenie `Error: Error` a posunutý zdrojový riadok samy nedokazujú chybný formát dát. Načítanie má jedno spoločné krátke overovacie čítanie; pretrvávajúca chyba aj neplatný snapshot naďalej zlyhajú. Súbežné poll požiadavky zdieľajú rovnaký pokus. |
| `DISPECING-TEST-C`, 11. 10. o 18:55 UTC | Úvodné čítanie organizácie zlyhalo po približne desiatich sekundách, ešte pred spustením úloh cronu. Nasledujúci beh o 19:00 uspel. Aj tento úvodný SELECT má teraz jeden krátky overovací pokus; chýbajúca či neaktívna organizácia alebo chyba oprávnení sa neopakuje a neukladá do cache. |
| TEST timeout `overdue session scan failed` 12. 10. o 23:50 UTC | Kontrola nasledujúcich behov o 23:55 a 00:00 UTC už uspela, ale otvorený incident zostal evidovaný. Úspešná kompletná kontrola teraz uzavrie presne rozpoznaný jednorazový timeout tohto čítania. Zdieľané incidenty príkazov ani chyby konkrétnych hovorov týmto pravidlom neuzatvára. |
| Produkčný timeout `orphan leg scan failed` 9. 10. o 15:20 UTC | Jediný timeout čítania z `telephony.ring.sweep` sa historicky uzavrel až pri ďalšej aktivite o 15:30 UTC. Rovnaké pravidlo bezpečnej obnovy teraz zahŕňa aj tento presný typ čítania; kompletný úspešný sweep ho dokáže uzavrieť aj bez nového hovoru. Chyba následného zápisu ukončenia vetvy do tejto výnimky nepatrí. |
| Provider overenie po úspešnej obnove alebo pri striedaní strán výberu hovorov | Preventívna oprava nájdená pri kontrole kódu; medzi desiatimi preverovanými aplikačnými správami takýto e-mail nebol. Takéto výsledky zostávajú v diagnostike. Samy už nevytvárajú incidentný e-mail; neúspešná obnova, neurčitý stav a skutočná chyba áno. |
| Staršie `DIAGNOSTIC_TEST_CANARY` a plánované výpadky TEST monitoru | Sú to záznamy skúšok opísaných v [akceptačnom protokole](monitoring-release-20261006.md). Nepovažovať ich automaticky za aktuálny výpadok. |
| Vynechaný TEST check-in 12. 10. o 22:55 UTC | V danom okne nebol dostupný runtime záznam spustenia; behy o 22:50 a 23:00 uspeli. Príčina vynechania nie je preukázaná a táto oprava netvrdí nápravu plánovania Vercelu. Nastavenie externého Sentry monitoru sa nemení. |

Desaťminútová lehota obnovy vychádza z pôvodného času prijatia udalosti a platí
iba pri doloženom nevyčerpanom v2 opakovaní. Definitívne chyby a neúplné údaje
ostávajú bez odkladu oznamované. Podrobné pravidlá a diagnostické polia sú v
[runbooku upozornení](telephony-alerts.md).

## Overenie

Regresná skúška používa skutočnú nainštalovanú knižnicu Telnyx 2.27.10.
V prehliadači reprodukovala pôvodné rámce `Tt` na `bundle.mjs:1:47693` a
`e.onerror` na `bundle.mjs:1:53022`, zhodné s e-mailom. Opravený variant pri
chybe aj zatvorení socketu zachová správny neúspešný stav spojenia bez ďalšej
výnimky. Sieť v tejto skúške je simulovaná; nejde o skúšku živého zvuku.

Automatizované scenáre pokrývajú čerstvú obnoviteľnú udalosť, úspešnú obnovu,
prekročenie lehoty, vyčerpané pokusy, neúplné údaje, zmiešané výsledky,
jednorazový a pretrvávajúci timeout aj zachovanie vážnych upozornení. Finálny
commit, výsledok build gate a kontrola prirodzeného TEST cronu patria do
odovzdania príslušného PR. Nevytvárať zámernú produkčnú chybu ani testovací
e-mail spustením celého cronu.
