# Zákazky odťahovej služby

Modul je súčasťou existujúcej aplikácie: kancelária `/zakazky`, vodič `/vodic`, verejný offline shell `/vodic/offline`. Používa samostatné členstvá nad Supabase Auth; vodič ani samostatný fakturant nepotrebuje dispečerský profil. Zdrojový prípad sa kopíruje do zákazky ako snapshot, nemení sa.

## TEST a aktivácia

- Kanonická adresa: https://test.dispecing.linkapomoci.sk/zakazky.
- TEST Supabase: `nzpnqdstvkfncflgqlny`.
- Vercel TEST: `pomoc-motoristom-test`, Production target vetvy `dev`.
- `MOTORIST_TOWING_ENABLED=true` sa nastavuje len po aplikovaní schémy. Predvolene je modul vypnutý.
- Vlastník 13. 10. 2026 výslovne schválil iba TEST migráciu `20261013120000_towing_work_orders.sql` a prvého správcu zo svojho existujúceho TEST účtu. Migrácia a jedno členstvo boli aplikované; bez seed dát a bez e-mailu.
- Schválený SHA-256 migrácie: `1479a73f821580e4d5da93636fe5a371605706ed62d6be55879f1c800cbdd5df`.
- Overených 17 tabuliek má RLS; `anon` a `authenticated` nemajú priame tabuľkové/RPC oprávnenia. Bucket `towing-documents` je privátny.

Pracovný Preview môže používať flag výlučne pre svoju vetvu a TEST databázu. Flag na produkčnom projekte v Production targete ani produkčná migrácia nie sú týmto rolloutom autorizované. Pred produkciou platí [release workflow](release-workflow.md), schválenie overeného rozsahu a osobitná autorizácia konkrétneho produkčného SQL.

## Prvé použitie

1. Správca sa prihlási svojím existujúcim TEST účtom na `/zakazky`.
2. V správe doplní potvrdené daňové sadzby, parkoviská a členov s rolami správca, dispečer, fakturant alebo vodič. Daňové sadzby nie sú predvyplnené domnienkou. Pozvanie je samostatná akcia odosielajúca prístupový e-mail.
3. Založí zákazku samostatne alebo zo zdrojového prípadu, doplní výkon a pridelí vodiča. Vodič vidí vlastné aktívne zákazky, povolenú sumu na výber a vlastné prijaté platby.
4. Vodič doplní priebeh, fotografie a odovzdá na kontrolu. Kancelária nacení položky, potvrdí cenu, vydá PDF a zaeviduje externú faktúru/úhradu. Výkon, fakturácia a úhrada majú samostatné stavy.
5. Hotovosť vodiča sa odovzdáva návrhom a potvrdením kancelárie. Opravy vyžadujú dôvod a zachovávajú pôvodný záznam. Nejasný offline príjem sa rieši v správe podľa pôvodného receipt UUID; bez dôkazu sa prípad ponechá otvorený.

PDF zachováva nemennú vydanú verziu. Podpisové miesta sú prázdne; digitálny podpis nie je súčasťou tejto verzie. Faktúry sa evidujú podľa externého systému, automatická integrácia s konkrétnym účtovným programom ešte nie je pripravená. Pred klientskym pilotom treba potvrdiť firemné údaje a texty dokumentov.

## Offline práca

Vodič online otvorí vlastnú zákazku a zvolí prípravu pre toto zariadenie. Po výslovnom súhlase sa uloží obmedzený snapshot. Offline môže upraviť realizačné údaje, pridať JPEG/PNG fotografie, zaznamenať skutočne prijatú hotovosť a zaradiť dokončenie. HEIC treba najprv exportovať do podporovaného formátu. Offline nevznikajú pridelenia, ceny, PDF, e-maily, refundácie ani odovzdania hotovosti.

Synchronizácia beží v otvorenej aplikácii po opätovnom overení účtu a pridelenia. Čakajúci príjem nemení potvrdený zostatok. Opakované požiadavky používajú rovnaké identity, konflikty nezapisujú cez novšiu verziu. Prístup je obmedzený 12-hodinovým serverovým povolením a platným prihlásením; po expirácii sa neodoslaná práca zamkne, automaticky sa nezmaže. Overené odobratie prístupu odstráni pracovné osobné údaje a ponechá minimálny dôkaz o čakajúcom príjme pre oprávnené riešenie.

Limity sú 50 MB na zákazku a 200 MB na účet. Odhlásenie s neodoslanou prácou ponúka synchronizáciu, zrušenie odhlásenia alebo výslovné zahodenie. Vymazanie browser dát či strata zariadenia môže odstrániť neodoslanú prácu. Aplikácia nesľubuje synchronizáciu na pozadí ani okamžité vzdialené odobratie offline kópie. Jeden existujúci service worker cachuje iba verejný shell a statické súbory; API, súkromné HTML a RSC sa necachujú.

## Overovanie a obmedzenia

```sh
pnpm test
pnpm typecheck
pnpm build
python3 tests/postgres/towing-work-orders.py
```

PostgreSQL fixture vyžaduje lokálne `initdb`, `pg_ctl`, `psql`. Spúšťa vlastný dočasný cluster bez TCP, ignoruje vzdialené PG premenné a neaplikuje SQL do Supabase. Obsahuje 142 kontrol oprávnení, súbehu, finančných invariantov a opakovania požiadaviek. PDF má aj opt-in test skutočného Chromium renderera. Browser scenáre sú v `e2e/towing-ui.spec.ts` a `e2e/towing-offline-ui.spec.ts`; používajú syntetické dáta, simulovanú sieť a skutočné IndexedDB.

Automatizovaný Chromium test nenahrádza terénne overenie na Android/iPhone. Stav e-mailu `accepted` znamená prijatie poskytovateľom, nie doručenie do schránky. Skúšky nesmú automaticky kontaktovať skopírovaných zákazníkov. Živé doručenie, používanie na telefónoch a klientom potvrdené PDF texty sa overujú samostatne.

Ak vytvorenie Auth účtu uspeje, ale zápis členstva zlyhá, zopakovanie pôvodného pozvania obnoví prípravu rovnakého účtu. Overuje deterministický identifikátor, e-mail a serverom uloženú identitu organizácie, správcu, príkazu a presného obsahu pozvania. Samotná zhoda e-mailu neoprávňuje pripojiť existujúci účet. Po nejasnej odpovedi zachovajte pôvodný formulár a zopakujte rovnaký pokus. Historické účty bez tejto servisnej identity vyžadujú manuálne overenie; priamy opravný SQL potrebuje konkrétnu autorizáciu cieľového projektu. Strata odpovede po úspešnom zápise členstva používa existujúci idempotentný výsledok.

Pri opätovnom nacenení sa používa uložený dátum konkrétnej zákazky. Zmenený dátum treba uložiť pred schválením ceny. Súbežná zmena nacenenia na serveri zachová rozpracované položky aj dátum a pred uložením vyžiada ich porovnanie. História externých faktúr sa vyhodnocuje podľa väzieb nahradenia dokladov, nie podľa poradia odpovede. Operačné úpravy odosielajú iba zmenené polia; samotná poznámka vodiča nemení pôvod času začiatku, rovnako online aj pri offline synchronizácii.
