# Vyhľadávanie, linky a adresár

Rozsah požiadavky majiteľa z 12. 10. 2026: odstrániť delenie prípadov na aktívne/históriu, lepšie filtrovať stavy, pridať presmerovanie medzi našimi linkami, spojiť nastavenie čísla a zvonenia, opraviť detail overenia auta podľa fotky a zobrazovať meno aj číslo kontaktu pri prichádzajúcom i odchádzajúcom hovore.

## Správanie

- Zoznam prípadov predvolene ukazuje aktívne stavy. Bežné hľadanie zahŕňa všetky stavy; výslovne zvolený stav alebo výber viacerých stavov sa rešpektuje. Záznamy sa nemažú ani nepresúvajú do osobitného archívu.
- Linky a smerovanie poskytujú zoznam liniek a jeden detail s názvom, partnerom, aktivitou, pokročilými voľbami a postupom zvonenia. Rozpracované úpravy sa zachovajú pri prepínaní. Všetky vybrané zmeny sa ukladajú v jednej transakcii s kontrolou verzie a snímky.
- Posledný krok „Presmerovať na našu linku“ pokračuje v tom istom zákazníckom hovore. Nevytvára PSTN volanie na vlastné DID. Celý cieľový postup sa zmrazí pri štarte hovoru, indexy ponúk ostávajú jedinečné, cieľové otváracie hodiny sa vyhodnotia pri prechode. Ciele musia patriť do rovnakej organizácie a prostredia; kruhy, príliš dlhé reťazce a archivované/neaktívne ciele sa odmietnu. Hlasové menu nie je v tejto verzii cieľom vnútorného presmerovania; jeho existujúce samostatné nastavenie zostáva dostupné.
- Detail overenia vozidla má určenú výšku a posúvateľný obsah. Skutočný nesúlad EČV/VIN sa zachová ako upozornenie a nedovolí prevziať údaje. Pôvodné ručne vyplnené hodnoty ostávajú chránené.
- Meno kontaktu sa dohľadáva podľa celého normalizovaného čísla, v rámci organizácie. Telefónny panel, čakáreň a história zobrazujú meno i číslo aj pri volaní operátorom. Kontaktné meno neurčuje oprávnenie na hovor ani príslušnosť k prípadu.

## Konkrétna TEST migrácia

Iba po výslovnom schválení projektu **nzpnqdstvkfncflgqlny** aplikovať [20261012190000_line_workspace.sql](../../supabase/migrations/20261012190000_line_workspace.sql).

Pridáva `motorist_save_line_workspace(uuid,jsonb,integer,text)` , read-only `motorist_resolve_call_contacts(uuid,text[])` a schopnosť `lineWorkspace` v konzistentnom čítaní konfigurácie. Starý save RPC ostáva zachovaný. Migrácia neprepíše nastavenia existujúcich liniek, nepridá čísla, provider resources, seed, cron ani worker. Vyžaduje už existujúce migrácie jednotného postupu a mobilných ponúk; ostatné pending migrácie nie sú súčasťou tohto nasadenia.

Na tomto projekte boli pred prípravou read-only porovnané definície `motorist_routing_snapshot` a `motorist_save_incoming_flow`; zodpovedali súboru `20261010110000_unified_incoming_flow.sql`. Pred aplikáciou konkrétnej migrácie opätovne preveriť ledger a definície. Produkčný projekt **ifpaeegaesdmljfkdvcn** sa týmto krokom nemení.

## Overenie a odovzdanie

Lokálne SQL kontroly: `python3 tests/postgres/unified-incoming-flow.py` na jednorazovej loopback DB; kontrolujú zachovanie dát, spoločný commit, konflikty verzií, kruhy, cudzí cieľ a oprávnenia. Simulované provider testy: `src/server/telephony/state/line-transfer.test.ts`. Prehliadačové kontroly: `e2e/case-status-search.spec.ts`, `e2e/incoming-flow.spec.ts`, pôvodné `e2e/incoming-routing.spec.ts` a `e2e/vehicle-lookup.spec.ts`.

Výsledok treba odovzdať na **https://test.dispecing.linkapomoci.sk** s aktuálnym `dev` SHA a zhodou `/api/health/live` / Vercel metadát. Lokálne simulácie ani build nepotvrdzujú reálny zvuk. Fyzický Safari na Macu a live transfer cez overené samostatné TEST zdroje sú samostatné integračné kontroly. Produkcia čaká na osobné schválenie majiteľa identifikovaného vydania.
