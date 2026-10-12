# Kontrola chybových e-mailov, 12. 10. 2026

Rozsah: oprava príčin nájdených hlásení a zbytočnej naliehavosti upozornení,
nasadenie cez pracovný PR do `dev` a stabilného TESTu. Produkčné vydanie
vyžaduje osobitný súhlas majiteľa. Žiadna SQL migrácia ani zmena externých
pravidiel Sentry nie je súčasťou tejto opravy.

## Zistenia

| Hlásenie | Overená príčina a riešenie |
| --- | --- |
| `DISPECING-TEST-A`, Telnyx WebRTC `TypeError` zo 6. 10. | Pri vyčerpaní pokusov o spojenie knižnica vyvolá vnorenú chybu počas prechádzania svojho zoznamu poslucháčov. Synchrónne odhlásenie poslucháčov tento zoznam odstránilo. Odpojenie teraz okamžite zneplatní starého klienta a médiá, ale odhlási poslucháčov až po dokončení aktuálneho spracovania udalosti. |
| Ledger upozornenie 12. 10. o 16:55 UTC | Udalosť prijatá o 16:54:54 mala jeden neúspešný pokus; obnovená bola o 17:00:27. Session bola už o 16:55:10 v stave `talking`. Hlásenie prišlo skôr než existujúci cron dostal príležitosť zopakovať spracovanie. Samotný stav session nepreukazuje počuteľnosť. |
| Dve ledger udalosti 10. 10. o 19:25 UTC | Obe udalosti ukončenia boli spracované pri ďalšom behu o 19:30:27, s jediným evidovaným zlyhaním. Nová obmedzená lehota obnovy zabraňuje predčasnému incidentnému e-mailu. |
| Ojedinelé čítacie timeouty monitoringu 11.–12. 10. | Edge a aplikačné merania ukazujú dlhé čakanie pred databázovou odpoveďou pri krátkom čase upstream spracovania. Ide o indíciu prechodnej transportnej latencie, nie dôkaz pomalého SQL. Pribudlo jedno krátke overovacie čítanie; trvalá chyba sa naďalej hlási. |
| Provider overenie po úspešnej obnove alebo pri striedaní strán výberu hovorov | Takéto výsledky zostávajú v diagnostike. Samy už nevytvárajú incidentný e-mail; neúspešná obnova, neurčitý stav a skutočná chyba áno. |
| Staršie `DIAGNOSTIC_TEST_CANARY` a plánované výpadky TEST monitoru | Sú to záznamy skúšok opísaných v [akceptačnom protokole](monitoring-release-20261006.md). Nepovažovať ich automaticky za aktuálny výpadok. |

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
