# B1 — práva flotily a partnerského adresára

**Aplikované v TEST aj produkčnej databáze; zhodné oprávnenia potvrdené read-only kontrolou 6. 10. 2026.** Pôvodný TEST návrh `.context/security-audit/b1-proposed-test-migration.sql` majiteľ schválil odpoveďou „Áno, aplikuj iba na TEST“; bol vykonaný 5. 10. o 07:12 UTC. Následný osobitný produkčný súhlas a aplikáciu eviduje [release #404](https://github.com/Alfopure/pomoc-motoristom-new/pull/404). TEST súhlas sám produkciu neautorizoval.

| Projekt | Záznam migrácie `restrict_fleet_partner_client_writes` |
|---|---|
| TEST `nzpnqdstvkfncflgqlny` | `20261005071209` |
| Produkcia `ifpaeegaesdmljfkdvcn` | `20261005195110` |

Zdrojové súbory z pôvodného [#397](https://github.com/Alfopure/pomoc-motoristom-new/pull/397) už prevzal [#403](https://github.com/Alfopure/pomoc-motoristom-new/pull/403) a vydal #404. Otvorená pôvodná evidencia ani rozdiel timestampov neznamenajú chýbajúce SQL; migráciu neopakovať.

## Problém a výsledok

Pôvodné tabuľkové granty a členské `FOR ALL` politiky umožňovali členovi organizácie priamy zápis do `motorist_fleet_assets` a `motorist_partner_directory`. Dispečer tak mohol obísť kontrolu oprávnení konkrétnej operácie na serveri.

[Migrácia `20261005071209_restrict_fleet_partner_client_writes`](../../supabase/migrations/20261005071209_restrict_fleet_partner_client_writes.sql) ponecháva klientom iba `SELECT`. Obe RLS politiky povoľujú iba čítanie prihlásenému aktívnemu členovi príslušnej organizácie. Rola `service_role` si zachováva existujúce práva vrátane zápisov. Politiky zablokujú členský zápis aj pri prípadnom neskoršom nechcenom obnovení DML grantov.

Serverové operácie naďalej používajú admin klienta a svoje kontroly rolí: správa flotily/adresára pre manager/admin, oprávnené dispečerské priradenie vozidla k prípadu a zámerne povolené rýchle pridanie asistencie členom organizácie. Serverové integračné zápisy zostávajú na rovnakej ceste.

Transakcia presne zodpovedá schválenému TEST návrhu; repozitárová verzia zodpovedá TEST ledgeri. Pri pôvodnej TEST operácii sa neaplikovali ďalšie pending migrácie ani seed. Tento SQL nemení dáta, pomocné funkcie, telefonické tabuľky, SDK, smerovanie alebo konfiguráciu providerov. Zmena databázových oprávnení je účinná bez nového nasadenia aplikácie.

## Aktuálna kontrola oboch projektov — 6. 10. 2026

Na oboch tabuľkách oboch projektov je RLS zapnuté. `anon` a `authenticated` majú SELECT, ale nemajú INSERT/UPDATE/DELETE/TRUNCATE. Jediná členská politika je SELECT pre `authenticated` cez `app_private.motorist_is_org_member(organization_id)`. `service_role` má zachované SELECT/INSERT/UPDATE/DELETE/TRUNCATE. Ide o katalógovú kontrolu bez zápisov; nie o novú ručnú UI akceptáciu.

## Pôvodné TEST overenie — 5. 10. 2026

- Bezprostredný preflight potvrdil zhodu tabuliek, grantov, politík, absencie stĺpcových grantov, membership helperov a triggerov s posúdeným návrhom.
- Po zmene majú `anon` a `authenticated` na oboch tabuľkách efektívne iba `SELECT`; nemajú INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ani MAINTAIN. Serverové práva zostali zachované.
- [Databázová skúška](../../supabase/verification/fleet-partner-permissions.sql) prešla priamo v TESTE: 14 výsledkov pre čítanie pod rolami admin, manager, senior_dispatcher a dispatcher, neznámeho/neprihláseného používateľa, zákaz priamych zápisov a povolené serverové zápisy. Čítanie pod jednotlivými rolami vrátilo očakávaných 290 vozidiel a žiadny cudzí záznam. Adresár bol pri skúške prázdny.
- Hosted DML skúšky používali výhradne `WHERE FALSE` a skončili `ROLLBACK`; nezmenili žiadny záznam. Overujú efektívne oprávnenia, nie úspešné uloženie konkrétneho nového objektu cez celé UI. Skúška odmietne pokračovať, ak nájde nový statement trigger, ktorý by mohol reagovať aj na nulový počet riadkov.
- Predchádzajúca lokálna skúška na syntetickej databáze PostgreSQL 15 overila skutočný serverový INSERT/UPDATE/DELETE oboch tabuliek, čítanie naprieč organizáciami, neaktívne účty, všetky štyri aplikačné roly a ochranu RLS aj po simulovanom nechcenom DML grante.
- Porovnanie katalógu pred/po potvrdilo rovnaký odtlačok grantov a RLS tabuliek `motorist_call*`, `motorist_operator_*` a `motorist_telephony_*`.
- Prešlo 412 existujúcich testov auth/CSRF, adresára, priradenia vozidla a súvisiacich mutácií; 24 kontrol telefonických migrácií tiež prešlo.
- Na kanonickom [TESTE](https://test.dispecing.linkapomoci.sk) prešlo 12 HTTP kontrol vrátane live/ready health, callback presmerovaní a ochrany token/heartbeat endpointov. V tom čase bol nasadený `dev` commit `2a6bfe031c08017974e800a8c4a35b05c04e14bd`, deployment `dpl_CDLH85zW434PnXeR9SMhh6zST93U`; zhodu potvrdili live health aj Vercel metadáta.

Prístup cez prihlásené hosted UI, úprava/uloženie flotily a partnera, priradenie vozidla k prípadu a aktualizácia druhého klienta cez Realtime neboli pri tejto SQL operácii ručne odskúšané. Živý zvuk zostáva samostatnou nepotvrdenou skúškou; úspešné databázové a HTTP kontroly ho nenahrádzajú.

## Ďalšia kontrola a prípadný návrat

V TESTE má manager/admin vedieť upraviť vozidlo a partnera; dispečer má vedieť priradiť vozidlo k prípadu a použiť povolené rýchle pridanie asistencie. Druhý prihlásený klient má zmenu vidieť. Priamy zápis bežného klienta cez databázové API má byť odmietnutý.

Pred návratom pri regresii overiť konkrétny chybný aplikačný tok. Pôvodný stav oboch tabuliek tvorili `ALL` granty pre anon/authenticated a dve permisívne `FOR ALL TO public` politiky s rovnakým `USING` aj `WITH CHECK`: `app_private.motorist_is_org_member(organization_id)`. Jeho obnova by znovu otvorila auditovaný problém. Presný TEST rollback bol pripravený ako `.context/security-audit/b1-proposed-test-rollback.sql`, ale nebol vykonaný.

Ak by bola potrebná nová SQL zmena alebo rollback, treba aktuálny preflight a osobitné schválenie presného projektu/rozsahu podľa [AGENTS.md](../../AGENTS.md). Nepoužiť hromadné `supabase db push` a neopakovať B1 migráciu v žiadnom z týchto projektov.
