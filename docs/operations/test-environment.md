# Oddelené testovacie prostredie

Konfigurácia od 2026-09-21 oddeľuje nové Preview nasadenia vrátane vetvy `dev` od produkčnej databázy. Produkčný projekt, jeho heslá, Auth konfigurácia, Vercel Production premenné a produkčná doména sa pri vytvorení testu nemenia.

## Projekty a adresy

| Prostredie | Supabase | Organizácia | Aplikácia |
| --- | --- | --- | --- |
| Production, vetva `main` | `ifpaeegaesdmljfkdvcn` | AlfoPure, `reqzkjhaquxbbhhalcmm` | `https://dispecing.linkapomoci.sk` |
| Preview, vetva `dev` a pracovné vetvy | `nzpnqdstvkfncflgqlny` | AlfoSystems, `rwhghkvusmdnaexjvrum`, Free | `https://test.dispecing.linkapomoci.sk` (čaká na DNS), zatiaľ [generovaný dev alias](https://pomoc-motoristom-dispatching-git-dev-alfopures-projects.vercel.app) a nové Preview URL pracovných vetiev |

Obe databázy sú vo Frankfurte (`eu-central-1`). Vercel projekt je `pomoc-motoristom-dispatching` (`prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, tím `team_56GjBnBw6zGSG83LJAnQCB8T`, región `fra1`).

Kanonická adresa testu je `https://test.dispecing.linkapomoci.sk`, určená výhradne pre Preview vetvy `dev`. [Generovaný dev alias](https://pomoc-motoristom-dispatching-git-dev-alfopures-projects.vercel.app) zostáva záložnou adresou. `dispecing-test.vercel.app` je napriek názvu produkčný alias. `dev.dispecing.linkapomoci.sk` patrí odstavenému VIPTel projektu a nesmie sa použiť. Rovnako sa nesmie čítať ani meniť Supabase `sjcsrygkkmersoczpunh`: obsahuje inú živú aplikáciu.

Vercel cieľ **Development** sa pri oddelení nemenil. Lokálny `.env.local` musí vývojár výslovne naplniť testovacími URL a kľúčmi; staré súbory ani `vercel env pull` bez správneho cieľa nedokazujú izoláciu. Všetky Preview zdieľajú jednu testovaciu databázu, takže ich zápisy vidia ostatní testujúci.

## Doména testovacieho `dev`

Stav k 2026-09-22: Vercel už priraďuje `test.dispecing.linkapomoci.sk` k aktuálnemu Preview deploymentu vetvy `dev` a doména je pridaná do testovacieho Auth redirect allowlistu. Autoritatívne DNS ešte vracia `NXDOMAIN`; aktivácia čaká na DNS CNAME vo Websupporte. Testovacia Auth Site URL preto zostáva na generovanom dev aliase a verejná dostupnosť novej domény cez DNS a HTTPS zatiaľ nie je potvrdená. Dovtedy používaj generovaný dev alias. DNS záznam pre `test.dispecing` nastav podľa aktuálneho odporúčania Vercelu pre túto doménu. Produkčné záznamy `dispecing.linkapomoci.sk` ani cudzí `dev.dispecing.linkapomoci.sk` sa nemenia.

Pri príprave domény Vercel odporučil v zóne `linkapomoci.sk` nový záznam `test.dispecing` typu `CNAME` s cieľom `f9c23ecf19e30b83.vercel-dns-016.com.`; použi TTL 600. Pred budúcou zmenou tento cieľ znova over vo Verceli.

Aplikácia používa origin aktuálnej požiadavky. Kvôli pridaniu domény nepridávaj branch overrides `APP_BASE_URL` ani `NEXT_PUBLIC_APP_URL`; nie sú nastavené a samotné mapovanie domény nevyžaduje rebuild. Pracovné vetvy naďalej používajú svoje Preview URL.

V testovacom Supabase `nzpnqdstvkfncflgqlny` zachovaj fungujúcu Auth Site URL generovaného dev aliasu, kým sa nepotvrdí DNS a platné HTTPS novej domény. Až potom nastav Site URL na `https://test.dispecing.linkapomoci.sk`; v testovacom allowliste povoľ `https://test.dispecing.linkapomoci.sk/**` a zachovaj potrebné redirecty generovaného dev aliasu, pracovných Preview a lokálneho vývoja. Produkčná Auth konfigurácia sa nemení.

Pred označením domény za pripravenú over DNS, platný HTTPS certifikát, mapovanie na správny READY deployment vetvy `dev`, `GET /api/health/ready`, prihlásenie a použitie testovacieho Supabase ref v aplikácii. Samotný názov hosta izoláciu nedokazuje. Telefónia a externé integrácie zostávajú vypnuté; nová doména nie je dôvod registrovať reálne provider webhooky.

## Obnova po pozastavení

Supabase môže Free projekt pozastaviť po siedmich dňoch nízkej aktivity. Obnova je ručná cez Dashboard; načítanie aplikácie ju nenahrádza. Aktuálne podmienky obnovy uvádza [Supabase Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

1. Otvor [Dashboard testovacieho projektu](https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny) a over názov `Pomoc motoristom dispatching TEST`, ref a organizáciu AlfoSystems.
2. Vyber **Restore project** a počkaj na zdravý stav projektu (`ACTIVE_HEALTHY`). Nevytváraj náhradný projekt, kým prebieha obnova.
3. Over testovaciu databázu a `https://test.dispecing.linkapomoci.sk/api/health/ready`, prípadne aj generovaný dev alias. Produkciu kontroluj iba čítaním `https://dispecing.linkapomoci.sk/api/health/ready`.
4. Over vypnutú telefóniu a ostatné odchádzajúce integrácie podľa kontrol nižšie. Ak sa pri obnove nezmenili URL ani kľúče, samotná obnova nevyžaduje nový build.

Ak Dashboard už priamu obnovu neponúka, postupuj podľa aktuálnej dokumentácie Supabase a dostupnej zálohy. Preview nechaj nedostupné, kým nie je test obnovený; neprepínaj ho späť na produkčnú databázu. Nepridávaj cron ani službu na umelé udržiavanie aktivity.

## Obsah kópie a bezpečnostné hranice

Test je jednorazová kópia aplikačnej schémy a vybraných dát zo zdroja, nie priebežná synchronizácia. Prvý import z 2026-09-21 zahŕňa 84 migrácií a 5 007 záznamov: okrem iného 17 prípadov, 15 kontaktov, 263 call sessions a 15 používateľských účtov. Aplikačná schéma má 111 tabuliek a dva pohľady; Auth používatelia a identity sa prenášajú osobitne. Overenie našlo zhodných 107 existujúcich funkcií, 90 RLS politík, 122 triggerov a 315 indexov. Test navyše obsahuje pomocnú funkciu `motorist_access_profile_has_task_workflow_history` z repozitárovej migrácie `20261006140000`, ktorá v produkcii chýbala; produkcia sa kvôli tomu nemenila. Schému vytvárajú migrácie z repozitára. Pri ďalšej obnove porovnávaj skutočný stav zdroja a cieľa; počty v pôvodnom pláne sú historický odhad.

Kópia zachováva väzby organizácií, profilov, oprávnení a aplikačných dát. Pri prenose Auth používateľov sa zachovávajú ID a existujúce hashe hesiel, aby fungovali profilové väzby a prihlásenie; produkčné heslá sa neresetujú. Auth relácie, refresh tokeny a aktívne prihlásenia sa neprenášajú. Auth a úložisko sú súčasťou samostatného testovacieho projektu.

Aktuálne vozidlá a ich posledné polohy sa zachovávajú; historické GPS vzorky a logy synchronizácie sa vynechávajú. Nekopírujú sa prevádzkové logy a auditné udalosti, nahrávky a súbory zo Storage, aktívne fronty a príkazy poskytovateľom, push subscriptions ani živé prihlasovacie údaje operátorských telefónov. Historický záznam hovoru nie je povolením znovu vykonať jeho príkazy. Odkazy na neprenesené nahrávky preto v teste nemusia prehrávať zvuk.

Presný zoznam 17 vylúčených aplikačných tabuliek udržiava `EXCLUSIONS` v [scripts/copy-test-data.py](../../scripts/copy-test-data.py):

```text
motorist_job_runs
motorist_telnyx_webhook_events
motorist_call_events
motorist_audit_log
motorist_ai_demo_attempts
motorist_provider_commands
motorist_push_subscriptions
motorist_operator_devices
motorist_operator_mobile_devices
motorist_call_processing_jobs
motorist_worker_status
motorist_handoff_sessions
motorist_case_editor_sessions
motorist_case_draft_previews
motorist_fleet_position_samples
motorist_fleet_sync_runs
motorist_integration_raw_events
```

Zo schémy `auth` sa prenášajú iba `users` a `identities`. Súbory Storage sa neprenášajú. Skript spočíta vylúčené tabuľky bez stiahnutia ich obsahu. Pri existujúcich MFA faktoroch sa zastaví: ich prenos a zachovanie prihlasovania vyžaduje samostatne posúdený postup.

Test musí mať vypnuté živé hovory, SMS, odosielanie emailov, AI a externé integrácie. Samotné vypnutie `live_calls_enabled` nechráni ostatné kanály: do Preview nepatria funkčné produkčné Telnyx, emailové, OpenAI ani integračné secrets a nesmú sa kopírovať do testovacej databázy. V teste sa nastavuje `TELNYX_LIVE_CALLS_ENABLED=false`, `TELNYX_SMS_LIVE_SENDS=false` a `AI_DEMO_ENABLED` zostáva vypnuté alebo chýba. Auth emailové toky v teste musia zostať bez produkčného SMTP; používaj existujúci účet a heslo, neodosielaj reset ani pozvánku skutočným adresátom.

Kopírovanie zákazníckych údajov nie je trvalé povolenie: pred každým ďalším refreshom over, či zdroj stále obsahuje iba dáta povolené na testovanie. Po nástupe reálnej prevádzky používaj schválenú anonymizáciu alebo syntetické dáta. Tokeny, API kľúče, heslá, exporty a Auth hashe nepatria do Git repozitára ani build logov.

Prístupy k novému projektu sú odovzdané v súkromnom súbore `dispatch-test-secrets.env` na pracovnom počítači vlastníka. Presná lokálna cesta ani obsah nepatria do verejného runbooku. Pre nástroj nižšie načítaj `SUPABASE_ACCESS_TOKEN` bezpečne do prostredia procesu; token nevkladaj do argumentov príkazu ani do verziovaného súboru.

## Opätovné doplnenie dát

Refresh je výslovne vyžiadaná operácia **iba proti testovaciemu cieľu**. Zápisy sa netýkajú produkcie a jej heslo sa kvôli exportu nikdy neresetuje. Import nahradí existujúce testovacie aplikačné dáta a účty vrátane zneplatnenia testovacích prihlásení. Zálohuj testovacie dáta, ktoré ešte potrebuješ, a počas importu nepoužívaj Preview. Zaznamenaj commit migrácií a skontroluj report rozsahu a bezpečnostných úprav pred importom.

### 1. Over cieľ a migrácie

Použi Supabase Management API s osobným tokenom uloženým mimo repozitára. Pred zápisom over cez `GET /v1/projects/nzpnqdstvkfncflgqlny` ref, organizáciu `rwhghkvusmdnaexjvrum`, región a stav `ACTIVE_HEALTHY`. Cieľ zápisu musí byť pevne obmedzený na tento ref. Produkciu čítaj cez `POST /v1/projects/ifpaeegaesdmljfkdvcn/database/query` s `read_only: true`; alternatívou pre podporované dotazy je samostatný endpoint `/database/query/read-only`. Kontrakt over v [oficiálnej referencii Management API](https://supabase.com/docs/reference/api/introduction).

1. Zostav zoradený zoznam `supabase/migrations/*.sql` z aktuálneho schváleného `dev` a porovnaj ho so `supabase_migrations.schema_migrations` v teste.
2. Skontroluj jedinečnosť verzií ešte pred aplikáciou. Pri duplicitách nepouži `ON CONFLICT DO NOTHING`: zakrylo by preskočený súbor. Rozpor sa musí vyriešiť skôr, než sa pokračuje.
3. Aplikuj len chýbajúce migrácie v poradí, každý súbor a jeho zápis do histórie atomicky. Použi `POST /v1/projects/nzpnqdstvkfncflgqlny/database/query`. Pri prvej chybe skonči, neopakuj naslepo už vykonané súbory a nepokračuj ďalšou migráciou.
4. Porovnaj tabuľky, stĺpce, väzby a očakávané funkcie so zdrojom a migračným stavom. Samotný rovnaký počet tabuliek nestačí. Migrácie nemenia produkciu a refresh nesmie vyžadovať `supabase db push` proti nej.

Pri obnove úplne prázdnej databázy má migrácia `20260926100000_assistance_line_labels.sql` dátový predpoklad: odkazuje na existujúcu organizáciu, ring plan, business hours a IVR menu. Pred jej vykonaním treba read-only exportom zo zdroja a parametrizovaným importom **do testu** doplniť potrebné aktuálne riadky z `motorist_organizations`, `motorist_ring_plans`, `motorist_business_hours` a `motorist_ivr_menus`. Prvotné vytvorenie testu 2026-09-21 odhalilo tento predpoklad pri prvej chybe; pokračovalo sa až po doplnení závislostí a úspešnom zopakovaní tej istej migrácie. Nasledujúci úplný import tieto pomocné dáta nahradí aktuálnou kópiou. Nespúšťaj kvôli tomu celý demo seed. Kopírovací skript nižšie migrácie neaplikuje.

Pri použití Supabase CLI si výslovne over jeho linked project; na kontrolu cieľa nespoliehaj na dávno vytvorený lokálny link. Nespúšťaj `db reset`, automatický seed ani všeobecný migračný príkaz bez overenia testovacieho ref.

### 2. Prenes vybrané dáta

Použi [scripts/copy-test-data.py](../../scripts/copy-test-data.py), ktorý potrebuje Python 3 a štandardnú knižnicu. Zdroj `ifpaeegaesdmljfkdvcn`, cieľ `nzpnqdstvkfncflgqlny` a organizácie sú pevne určené v skripte; premenná prostredia ich nemôže presmerovať. Skript pred zápisom kontroluje identitu a zdravý stav testovacieho projektu. Zo zdroja vykonáva iba API čítanie s `read_only: true` a SQL transakciou `READ ONLY`.

Spúšťaj tieto kroky z koreňa repozitára, vždy až po úspechu predchádzajúceho kroku. Pred tretím príkazom skontroluj pripravený report:

```sh
python3 scripts/copy-test-data.py snapshot
python3 scripts/copy-test-data.py prepare
python3 scripts/copy-test-data.py import --replace-existing-test-data
python3 scripts/copy-test-data.py verify
```

`snapshot` číta tabuľky postupne, po stranách najviac 100 riadkov zoradených podľa primárneho kľúča. Každý dotaz má SQL timeout 5 sekúnd a `jit=off`; pri zmene počtu riadkov počas čítania sa export zastaví. Report zaznamenáva začiatok a koniec exportu aj časové okná jednotlivých tabuliek. **Nie je to jeden konzistentný databázový snapshot ani záruka rovnakého okamihu naprieč databázami**: zdroj sa môže medzi dopytmi meniť aj bez zmeny počtu riadkov. Pri nekonzistencii zastav import a vytvor nový ohraničený export v pokojnom čase.

`prepare` porovná aktuálnu schému testu so schémou exportu, pripraví bezpečnostné transformácie a zapíše `database-copy-report.json`. Zakáže hovory, SMS, úlohy na pozadí, integrácie a spracovanie nahrávok; ukončí skopírované aktívne hovory, zruší čakajúce odchádzajúce akcie a zneplatní verejné bearer odkazy. Auth ID a hashe hesiel zachová, rozpracované resetovacie a overovacie tokeny vyčistí. Skontroluj počty, výnimky a rozdiely v reporte pred nahradením existujúcich dát.

`import --replace-existing-test-data` vedome nahradí existujúci obsah testu v jednej transakcii. Je to úplná obnova vybraných dát s bezpečnostnými úpravami, nie synchronizácia ani upsert. Skript znovu skontroluje schému, dočasne upraví cieľové triggery a cudzie kľúče, vloží dáta a pred commitom obnoví a overí všetky cudzie kľúče, stavy triggerov, počty aj bezpečnostné prepínače. Na import používa `jsonb_populate_recordset` s korektne escapovaným JSON literálom; nevytváraj vlastné SQL dosadzovaním surových dátových hodnôt. Pri chybe transakcia nepotvrdí čiastočnú obnovu. Pri transportnom timeoute over stav a súkromný výsledok, neopakuj zápis automaticky.

`verify` porovná počty a hodnoty importovaných stĺpcov s pripraveným bezpečným exportom a skontroluje cudzie kľúče a triggery. Import túto kontrolu spustí aj sám; samostatný príkaz umožňuje opakované overenie pred otvorením Preview. Po prihlásení alebo úprave záznamov aplikáciou už nemusia hodnoty presne zodpovedať exportu.

Súkromné exporty a SQL sú predvolene v gitignorovanom `.context/isolation/` s oprávneniami iba pre vlastníka; inú pracovnú cestu určuje `TEST_COPY_WORKSPACE`. Zdieľateľné overenie je v `database-verification.json`, rozsah a úpravy v `database-copy-report.json`, časové okná v `database-snapshot-summary.json`. Ani celé exporty, ani SQL obsahujúce Auth hashe necommituj. Po importe nespúšťaj seed.

**Prevádzková poznámka z 2026-09-21:** prvý pokus o read-only export jedným veľkým JSON agregátom zo všetkých tabuliek viedol k reštartu zdrojovej databázy a dočasnému `503` readiness približne 20:42–20:46 UTC. Zdroj sa obnovil bez zmien produkčných dát či konfigurácie. Export bol preto zmenený na vyššie uvedené postupné strany so stropom 100 riadkov, päťsekundovým SQL timeoutom a vypnutým JIT. Veľký agregát cez celú databázu neopakuj; aj čítanie môže preťažiť malú databázu.

Pri importe väčšom než 4 MiB nástroj najprv uloží dávky do súkromnej schémy `test_copy_stage` výhradne v teste. Každá dávka má najviac 100 riadkov a 512 KiB; verejné roly k nej nemajú prístup. Záverečná transakcia prenesie dáta, overí väzby a odstráni vlastnú dočasnú dávku. Pri chybe sa aplikačné tabuľky neprepíšu; prípadné zvyšky stagingu obsahujú súkromné dáta a patria iba do testovacieho projektu.

SQL s dátovými zmenami spúšťaj výhradne na teste; napríklad tento základný test musí vrátiť nulu:

```sql
select count(*) as live_call_settings
from public.motorist_telephony_settings
where live_calls_enabled is distinct from false;
```

### 3. Skontroluj Preview konfiguráciu a nový build

Všetky nasledujúce hodnoty patria do Vercel cieľa **Preview**, vrátane prípadných overrides pre vetvu `dev`. Production sa nemení.

| Premenné | Hodnota |
| --- | --- |
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | `https://nzpnqdstvkfncflgqlny.supabase.co` |
| `SUPABASE_PROJECT_REF`, `EXPECTED_SUPABASE_PROJECT_REF` | `nzpnqdstvkfncflgqlny` |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | príslušné verejné kľúče testovacieho projektu |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` | príslušné serverové kľúče testovacieho projektu |
| `TELNYX_LIVE_CALLS_ENABLED`, `TELNYX_SMS_LIVE_SENDS` | `false` |
| `WEBDISPECINK_SYNC_ENABLED` | `false`; platí aj pre obnovu vozidiel vyvolanú používateľským rozhraním |
| `AI_DEMO_ENABLED` | vypnuté alebo nenastavené |
| `MOTORIST_DEV_AUTH_BYPASS` | `false` |

Pri zmene URL alebo kľúčov vytvor nový Preview deployment z aktuálneho commitu. `NEXT_PUBLIC_*` sú vložené do klientského bundle počas buildu; samotná úprava env už existujúci deployment neopraví. Staré immutable Preview URL môžu stále obsahovať pôvodné produkčné credentials — na testovanie používaj iba nový overený deployment. Nové branch overrides nesmú vrátiť produkčný ref ani produkčné secrets.

Po overení nového dev deploymentu treba odstaviť staré neprodukčné deploymenty s pôvodnou konfiguráciou. Pri inventarizácii a odstraňovaní zachovaj aktuálny dev a nové overené Preview, všetky produkčné deploymenty aj produkčné aliasy. Počet skutočne odstránených deploymentov a výsledok overenia starých URL zaznamenaj až po dokončení operácie.

Pri Auth redirectoch upravuj iba testovací Supabase projekt. Povolené musia byť `test.dispecing.linkapomoci.sk`, aktuálne testovacie Preview hosty a prípadne lokálny vývoj; nezapisuj ich do produkčného Auth nastavenia a nepoužívaj doménu odstaveného projektu. Zmena názvu Vercel projektu môže zmeniť generovaný alias; vlastná testovacia doména zostáva kanonickou adresou, aktualizovať treba záložný alias a jeho testovacie redirecty.

### 4. Dôkaz oddelenia

1. Nový Preview build musí prejsť rovnakými bránami ako produkcia: Vitest, typecheck a build vrátane `scripts/assert-target-project.mjs`. Over Git SHA, vetvu a stav READY.
2. `GET /api/health/ready` na novom Preview, `https://test.dispecing.linkapomoci.sk` aj generovanom dev aliase musí vrátiť `200`; následne over prihlásenie a čítanie skopírovaných dát.
3. Zaznamenaj pôvodnú hodnotu jedného dohodnutého testovacieho záznamu v oboch databázach. Cez prihlásenú Preview aplikáciu vykonaj jedinečnú vratnú zmenu. Read-only dotazmi potvrď zmenu iba v teste a nezmenenú produkčnú hodnotu; potom testovaciu hodnotu vráť. Zápis priamo do testovacej DB sám osebe nedokazuje správne smerovanie aplikácie.
4. Skontroluj vypnuté odchádzajúce kanály bez odoslania skutočného hovoru, SMS, emailu či požiadavky na platenú integráciu. Neprenášaj produkčné sessions na overenie prihlásenia.
5. Produkčný `https://dispecing.linkapomoci.sk/api/health/ready` musí zostať `200`. Porovnaj ref a konfiguráciu Production s hodnotami pred zásahom; produkčný deployment sa pri samotnom oddelení nevydáva znova.

Pri chybe test oprav alebo ho nechaj nedostupný. Produkčný ref, heslá, Vercel Production premenné, hostname a externé webhooky zostávajú nedotknuté.
