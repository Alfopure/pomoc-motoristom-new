# Audit diagnostiky a rozpracovanosti — 4. november 2026

Majiteľ schválil diagnostické úpravy v TEST aj produkcii. Tento rozsah nemení
pravidlá volania, reconnect, smerovanie ani databázovú schému.

## Overené východiská

- Produkcia: `main` **eebaa832**, TEST: `dev` **ef6d85c6**. Oba kanonické
  hosty vracali live/ready 200 pri kontrole 4. 11. o 18:30 UTC.
- Sentry má oddelené projekty `sentry-beige-horizon` a `dispecing-test`.
  Oba majú aktívne upozornenia na nové chyby, regresie a existujúce chyby
  s vysokou prioritou, s e-mailovou akciou pre majiteľa.
- Produkčný HTTP monitor `2335291` kontroluje kanonické ready každých
  60 sekúnd; hlási dva neúspechy a zotavenie. TEST HTTP monitor `2335292`
  je vypnutý. Jeho odkaz nepredstavuje aktívne sledovanie dostupnosti.
- TEST cron monitor `dispatch-test-telephony-cron` je aktívny, prostredie
  `test`, plán päť minút, tolerancia dve minúty, maximálne trvanie tri minúty.
  Kontroly 18:15–18:30 UTC boli čerstvé a úspešné. Cron nenahrádza externú
  HTTP kontrolu. Tento audit nezapína ďalšiu platenú službu.

## Zistené medzery a oprava

1. Viaceré terminálne SDK zlyhania sa označovali ako `recovery_timeout`;
   každý heartbeat so stavom `error` ako `auth_failure`. Nové záznamy
   rozlišujú skutočný timeout, vyčerpanie/vypnutie obnovy, neplatné prihlasovanie
   a fatálnu SDK chybu. Uzavretý kontrakt pridáva bezpečný SDK kód a skutočný
   RTC edge aktuálneho klienta aj po prvom pripojení.
2. Uložená chyba telefónu sama nevytvárala incident ani alarm. Čerstvé,
   prijaté a spätne overené browser pozorovania s preukázaným zariadením sa
   odosielajú do existujúceho Sentry. Ide o pozorovanie klienta, nie dôkaz
   výpadku zvuku. Opakované udalosti sú obmedzené deduplikáciou a kvótou.
   Webhook chyby dostávajú uzavretú klasifikáciu príčiny a typu udalosti.
3. Verejné ready neoveruje pripojenie jednotlivých telefónov. Monitor preto
   číta samostatný stav zariadení s čerstvosťou, obmedzeniami a oddelením
   browser/native dostupnosti. Nula zariadení nie je dôkaz poruchy aplikácie.

Historické `recovery_timeout` záznamy neumožňujú spätne určiť presnú SDK
príčinu. Chýbajúci incident nevylučuje problém. Nové voliteľné polia prijíma
nový server aj pri starých klientoch; pri návrate na starší server sa nové
udalosti môžu odmietnuť, preto treba vracať klienta aj server spolu.

## Git

- Na začiatku auditu bol otvorený iba historický dokumentačný
  [PR #287](https://github.com/Alfopure/pomoc-motoristom-new/pull/287).
  Ochrana živej databázy odovzdávania vozidiel už je v aktuálnom `AGENTS.md`.
  Jeho AI prehľad je snímka z 24. septembra. Pôvodný obsah a nezlúčená vetva
  ostávajú zachované; PR bol uzavretý ako nahradený historický návrh.
- Z 153 pracovných vzdialených vetiev je 90 tipov predkom **main aj dev**.
  Ich mená a obnoviteľné SHA sú v
  [archíve zlúčených vetiev](2026-11-04-merged-branches.json).
  Po opätovnom overení tipov a otvorených PR bolo všetkých 90 názvov
  odstránených jedným atómovým pushom s kontrolou pôvodného SHA každej
  vetvy. Výsledok bol spätne overený. `main`, `dev`, aktuálna pracovná
  vetva a nezlúčená práca zostali zachované.
- Tri ďalšie vetvy sú iba v TESTe: #565/#567 dokumentácia App Store
  a #566 hláška obsadeného vodiča. Produkčný PR diagnostiky ich nezahŕňa.
- Zvyšných 60 historických vetiev bolo skontrolovaných aj podľa patchov
  a PR: 40 má všetky patche už v `dev`; pri ďalších 10 sa presný tip zhoduje
  s hlavou už zlúčeného PR. Deväť uzavretých návrhov bolo nahradených alebo
  zámerne neprevzatých a jedna vetva obsahuje historický plán. Nenašla sa
  zabudnutá dôležitá runtime oprava. Tieto historické vetvy ostali zachované.
  Odkaz na septembrový plán v `call-latency-status.md` bol opravený na
  nemenný archívny commit a dokument jasne označený ako historický.

## Overenie vydania

Povinné testy, typecheck a build ostávajú zachované. Najprv sa overí
kanonický TEST, presný commit a existujúci časovo obmedzený canary
(Sentry prijatie oddelene od doručenia e-mailu). Produkčný PR obsahuje
iba túto schválenú diagnostiku; po ňom nasleduje synchronizácia main do dev.
Konkrétne nasadené SHA a výsledky živého overenia patria do odovzdania vydania.
