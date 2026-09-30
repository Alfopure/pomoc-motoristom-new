# Samostatné plne testovateľné prostredie

Stav k 2026-09-30: **TEST aplikácia je nasadená a základné funkcie sú overené** na `https://test.dispecing.linkapomoci.sk`. [PR #332](https://github.com/Alfopure/pomoc-motoristom-new/pull/332) je zlúčená do `dev` (`9c7565c3`); samostatný projekt `pomoc-motoristom-test` používa iba TEST Supabase. Živé integrácie zostávajú vypnuté: Telnyx prístup je už overený, ale nie je zapojený do aplikácie; objednané slovenské TEST číslo čaká na regulačné overenie a aktiváciu. Zvuk, SMS, doručenie emailu, AI a ostatné externé služby ešte nie sú funkčne prebraté.

### Príprava Telnyx — 2026-09-30, 09:12 UTC

Kľúč existujúceho účtu bol overený čítaním API a zostáva v súkromnom úložisku mimo repozitára. Vzniklo päť nových TEST konfigurácií s potvrdeným spätným čítaním: dva outbound voice profily, Call Control aplikácia, credential connection a messaging profile. Call Control aplikácia, oba voice profily a messaging sú vypnuté; aktívna credential connection má interné SIP pravidlo a vlastný vypnutý outbound profile. Callbacky sú nastavené na kanonickú TEST doménu. Tieto credentials/resource ID ešte nie sú vo Vercel env; aplikačné live prepínače zostávajú vypnuté, nebol vykonaný hovor či SMS a produkčné resources sa nemenili.

Používateľ následne vybral slovenské číslo s overením a vznikla objednávka jedného bratislavského hlasového čísla pre novú TEST aplikáciu: 1 USD/mesiac + 1 USD zriadenie, bez SMS. Objednávka má stav `pending` / `requirement-info-pending`; všetkých päť požiadaviek čaká na hodnotu a číslo nie je potvrdené ako aktívne. V účte existujú schválené podklady z predošlých objednávok, ale k novej sa automaticky nepripojili. Majiteľ musí potvrdiť alebo pripojiť požadované overenie v Telnyx portáli; žiadne doklady identity sa pri tejto príprave neodosielali. Po schválení zostáva aktivácia čísla, schválené testovacie destinácie, pripojenie TEST konfigurácie a reálne integračné testy. SMS a doručenie emailu vyžadujú osobitne overené zdroje a adresátov.

### Preberací záznam aplikácie

| Overenie | Výsledok z 2026-09-30 |
| --- | --- |
| Prvé overené nasadenie | `dpl_6WfCvnxmosxEFeGXg4hRVW8CDuLh`, READY, `dev` / Production samostatného TEST projektu, `fra1`; hosted gate: 5 265 testov, typecheck a build prešli. |
| Doména a TLS | Presunutá na TEST projekt, `gitBranch: null`, Vercel `misconfigured=false`; oba autoritatívne Websupport NS potvrdili CNAME `f9c23ecf19e30b83.vercel-dns-016.com`. TLS platný do 2026-12-21. |
| Verejná aplikácia | HTTPS `/api/health/live` a `/api/health/ready` → 200, rovnaká verzia; login v browseri bez JS/console/chunk chýb, viditeľný TEST štítok; v 12 načítaných JS súboroch sa našiel iba TEST Supabase host. |
| Prihlásené HTTP funkcie | O 08:47 UTC prešlo 19 kontrol: dočasný TEST manager, login, dashboard/adresár, vytvorenie/úprava prípadu, kontaktu a úlohy, upload/download prílohy a platný PDF export. Päť kontrol potvrdilo odstránenie vlastných testovacích záznamov, súboru a identity. |
| Plánovaný cron | Prirodzený Vercel beh o 08:45:18 UTC → 200, `telephony-cron-runtime`, `status=ok`, 1 495 ms; nebol spustený ručne. Neautorizovaný prístup o 08:48 UTC → 401. |

Tabuľka je preberací záznam prvého overeného nasadenia; aktuálnu verziu po ďalších releasoch vráti `/api/health/live`.

HTTP smoke overil totožný 68 B súbor a platný 26 563 B PDF; nebol to test obsluhy prihláseného browsera ani providerov. Legitímny audit, nemenné potvrdenia uloženia prípadu a spotrebovaná hodnota číselného radu zostali. Produkčné mapovanie aj verzia `dpl_A57dUzyA7dFE5HA7CVwoDA7fUS34` sa nezmenili. TEST má 43 premenných iba v Production target, vlastné signing/cron/push kľúče a vypnutý auth bypass. TEST migrácia `20260930080415` bola overená bez seed dát: update trigger vynecháva deväť interných stĺpcov, insert/delete trigger zostal zachovaný.

## Hranice a nasadenie

| Účel | Vercel | Vetva / cieľ | Aplikačné prostredie | Supabase |
| --- | --- | --- | --- | --- |
| Ostrá prevádzka | `pomoc-motoristom-dispatching` | `main` / Production | `production` | `ifpaeegaesdmljfkdvcn` |
| Stabilná TEST aplikácia | `pomoc-motoristom-test`, `prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk` | `dev` / Production **tohto TEST projektu** | `MOTORIST_APP_ENV=test` | `nzpnqdstvkfncflgqlny` |
| Pracovné Preview | existujúci projekt | pracovná vetva / Preview | `test`, bez živých integrácií | `nzpnqdstvkfncflgqlny` |

Ostrá doména je `https://dispecing.linkapomoci.sk`. `dispecing-test.vercel.app` je tiež ostrý alias. Kanonická TEST doména už smeruje na samostatný TEST projekt. Doterajší alias `pomoc-motoristom-dispatching-git-dev-alfopures-projects.vercel.app` ostáva iba obmedzeným Preview fallbackom (`ready=200`, `dpl_BopL7WC9n4pTt964K8SHcs47HwCb`); jeho úspech nepreukazuje telefón ani cron stabilného TEST projektu.

TEST nemení produkčné kľúče, čísla, webhooky, databázu ani doménu. Úplne mimo rozsahu ostávajú Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispatching-old`, `dev.dispecing.linkapomoci.sk` a pôvodný VIPTel listener. TEST autorizácia nepovoľuje produkčné migrácie ani obnovu dát zo zdroja bez osobitného zadania. Historická kópia v TEST obsahuje skutočné kontakty a provider identifikátory; nie je dovolením volať ich alebo znovu vykonať staré príkazy.

**Samostatný Telnyx účet nie je podmienkou.** Bežné TEST hovory môžu používať existujúci účet a spoločný kredit, ale majú vlastné číslo, Call Control aplikáciu, credential connection, outbound voice a messaging profiles. Účet aj jeho API oprávnenia môžu siahať na produkčné zdroje; nový názov kľúča alebo iné resource ID automaticky nevytvára account sandbox. Ochranu poskytujú presné TEST resource guards, allowlist testerov a overenie pôvodu každého ovládaného hovoru. Samostatný účet je voliteľná silnejšia izolácia, nie prekážka tohto postupu.

Vercel `production` je technický cieľ projektu, nie identita aplikačných dát. Kód rozlišuje identitu v [app-environment.ts](../../src/lib/app-environment.ts). Stabilný TEST musí súčasne mať `MOTORIST_APP_ENV=test`, `VERCEL_ENV=production`, `VERCEL_GIT_COMMIT_REF=dev`, systémové `VERCEL_PROJECT_ID=prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, presný kanonický `APP_BASE_URL` a správny TEST Supabase URL. Chýbajúce alebo cudzie project ID nepovolí živé TEST integrácie ani pri ostatných správnych hodnotách. Zadané verejné aj serverové URL/ref sa nesmú rozchádzať. `main` sa nesmie označiť za TEST. Pracovné Preview nesmú získavať operátorské provider credentials, meniť routing ani vykonávať sweep stabilného TEST telefónu; bežné aplikačné CRUD však naďalej zdieľa TEST databázu.

## Vercel: postup zriadenia

Pracuje sa výhradne v tíme `alfopures-projects` (`team_56GjBnBw6zGSG83LJAnQCB8T`). Existujúci ostrý projekt má ID `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`; toto ID nesmie byť cieľom pridávania TEST secrets. Všetky mutácie adresovať novým overeným TEST project ID, nie nejednoznačným lokálnym `.vercel/project.json`.

1. Vytvoriť samostatný projekt pre repo `alfopure/pomoc-motoristom-new`, framework Next.js, región `fra1`, vypnuté Preview tohto nového projektu. [Create project API](https://vercel.com/docs/rest-api/projects/create-a-new-project) je `POST /v11/projects?teamId=…`; návrh nesekretnej časti tela:

   ```json
   {
     "name": "pomoc-motoristom-test",
     "framework": "nextjs",
     "gitRepository": { "type": "github", "repo": "alfopure/pomoc-motoristom-new" },
     "previewDeploymentsDisabled": true,
     "resourceConfig": { "functionDefaultRegions": ["fra1"] }
   }
   ```

2. Nastaviť **Production Branch = `dev`**, pred aktiváciou živých TEST credentials. Ak bol projekt vytvorený bez Git prepojenia, použiť `POST /v9/projects/{TEST_PROJECT_ID}/link?teamId=…` s `{"type":"github","repo":"alfopure/pomoc-motoristom-new"}`, potom **`PATCH /v9/projects/{TEST_PROJECT_ID}/branch?teamId=…` s `{"branch":"dev"}`**. Tento oddelený endpoint používa [oficiálny Vercel Terraform provider](https://github.com/vercel/terraform-provider-vercel/blob/main/client/project.go#L409); branch nie je poľom všeobecného create/update project requestu v [OpenAPI](https://openapi.vercel.sh). GET projektu musí potvrdiť `link.productionBranch === "dev"` a správne repo. Alternatíva je [Settings → Environments → Production Branch](https://vercel.com/kb/guide/can-i-use-a-non-default-branch-for-production).
3. Ponechať build gate z `vercel.json`: `pnpm exec vitest run && pnpm typecheck && pnpm build`. Zapnúť system envs potrebné na kontrolu vetvy a deployment identity. Automatický prvý build bez konfigurácie nie je pripravenosť; pred jeho úspešným overením nepriraďovať kanonickú doménu.
4. Vkladať potrebné TEST premenné iba do nového projektu s `target: ["production"]`; serverové secrets ako `sensitive`/`encrypted`, verejnú konfiguráciu ako `plain`. [Environment API](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables): `POST /v10/projects/{TEST_PROJECT_ID}/env?teamId=…`. Pre tento cieľ sa nepoužíva `gitBranch`; branch-scoped env je vlastnosť Preview. Nekopírovať všetky premenné starého projektu ani neinjektovať TEST provider keys do širokého Preview/Development scope.
5. Nasadiť aktuálny schválený commit `dev` do Production nového TEST projektu. Overiť commit, projekt, cieľ, verejnú aj serverovú DB identitu a funkčnosť na jeho dočasnej URL. Nepoužívať `vercel redeploy` starého nasadenia ako náhradu aktuálneho zdroja.
6. Po overení náhrady presunúť **iba** `test.dispecing.linkapomoci.sk`. [Move domain API](https://vercel.com/docs/rest-api/projects/move-a-project-domain) je `POST /v1/projects/{SOURCE_PROJECT_ID}/domains/test.dispecing.linkapomoci.sk/move?teamId=…` s cieľovým `projectId` a `gitBranch: null` pre Production nového projektu. Nehýbať ostatnými doménami ani redirectmi. Následne potvrdiť nové mapovanie, DNS odporúčanie Vercelu, platný TLS a nasadený commit.
7. Až potom aktivovať schválené TEST provider webhooky na kanonickej doméne a jednotlivé integration gates. Webhook route musí byť prístupná providerovi bez Vercel login obrazovky a zachovať vlastnú kontrolu podpisu; dashboardové nastavenie Deployment Protection nesmie zameniť prístup k webhooku za autentifikáciu používateľa aplikácie.

API odpovede s env values nikdy nevypisovať celé. Do evidencia patria iba názvy, typy a target premenných, ID projektov/deploymentov, vetva, commit, počet a stav overení. Token patrí do pamäte procesu alebo schváleného úložiska secrets, nie do argumentov CLI, dokumentácie či logov.

## Cron a spoločná databáza

Jediný povolený Vercel cron ostáva `*/5 * * * *` → `/api/telephony/cron`, s novým TEST `CRON_SECRET`. Nie je potrebný ďalší worker ani listener. Vercel volá cron na Production URL projektu; preto stabilný TEST používa tento cieľ. Päťminútový interval vyžaduje Pro/Enterprise, Hobby ho nepodporuje. [Cron mechanizmus](https://vercel.com/docs/cron-jobs), [limity](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Vercel posiela secret v hlavičke `Authorization: Bearer …`; neukladať ho do URL. [Oficiálna ochrana cronu](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs). Pred prvým behom preveriť, že všetky podúlohy pracujú iba s TEST zdrojmi a že staré Preview nedokážu meniť nové operátorské zariadenia či routing. Samotné verejné `ready=200` nepreukazuje vykonanie cronu. Zachytiť aspoň jeden skutočný plánovaný beh a jeho výsledky; nechýbajúcu integráciu neoznačiť úspechom len preto, že ju cron preskočil.

Základné premenné nového projektu: `MOTORIST_APP_ENV=test`, `EXPECTED_SUPABASE_PROJECT_REF=nzpnqdstvkfncflgqlny`, `SUPABASE_PROJECT_REF=nzpnqdstvkfncflgqlny`, `NEXT_PUBLIC_SUPABASE_URL=https://nzpnqdstvkfncflgqlny.supabase.co`, zodpovedajúci verejný a serverový TEST kľúč, `APP_BASE_URL=https://test.dispecing.linkapomoci.sk`, `MOTORIST_DEV_AUTH_BYPASS=false`, samostatný `CRON_SECRET`. Ak je zadané `SUPABASE_URL`, musí ukazovať na ten istý TEST projekt. `MOTORIST_TEST_LIVE_INTEGRATIONS=true` je osobitný integračný gate; nevypína individuálne guards a nie je určený pre pracovné Preview.

Schválené telefónne destinácie sú presné E.164 hodnoty v `MOTORIST_TEST_ALLOWED_NUMBERS`, vlastné TEST čísla v `MOTORIST_TEST_FROM_NUMBERS`. Oba zoznamy sú oddelené čiarkou, majú najviac 50 položiek a nepovoľujú wildcard, krajinu ani prefix. Email používa nezávislý `MOTORIST_TEST_ALLOWED_EMAILS`: najviac 50 presných jednoduchých emailových adries, porovnanie bez rozlíšenia veľkosti písmen; žiadne doménové wildcardy. Jediný adresát mimo zoznamu zablokuje celú správu ešte pred Resend požiadavkou. Bez stabilnej TEST identity, live gate alebo platného zoznamu zostáva TEST email vypnutý.

Pred každým vydaním TEST browser JWT klient číta provider credential (`resource_id=connection:<TEST connection>`), aktívnu credential connection s `sip_uri_calling_preference=internal` a jej vlastný outbound profile s `enabled=false`. Tento SIP outbound profile musí byť odlišný od `TELNYX_OUTBOUND_VOICE_PROFILE_ID` serverovej Call Control aplikácie. Kontroly nemajú cache a zdieľajú najviac 12-sekundový deadline. Tým sa kontroluje zákaz priameho PSTN vytáčania z browsera; reálny príjem a serverom riadené TEST hovory treba ešte overiť. `internal` je podľa [oficiálneho SDK](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/credential-connections/credential-connections.ts#L274) inbound SIP pravidlo pre spojenia v tom istom účte, nie samostatný TEST sandbox ani outbound allowlist.

Pri spoločnom účte aj hangup, bridge, konferencie, `link_to` a supervise akcie overujú pôvod všetkých provider ID. Historický riadok skopírovaný do TEST DB ani globálny Telnyx podpis nepreukazuje TEST vlastníctvo. Samotné [GET call status](https://developers.telnyx.com/api-reference/call-information/retrieve-a-call-status) nevracia connection ID. Implementovaný dôkaz hovoru používa service-only záznam nového TEST dial ACK alebo overeného `call.initiated` webhooku s presnou TEST connection; tieto tabuľky sa nekopírujú z produkcie. Konferencia vyžaduje presnú TEST connection v provider metadata. Rovnaká kontrola prebehne pred spracovaním callbacku bez connection ID. Nested dial `conference_config` a nepreverené dial fields sa v TEST odmietnu. Vypnutý creation gate dovoľuje upratanie preukázaných TEST hovorov.

Nahrávky majú samostatnú kontrolu aj pri automatickom mazaní: [recording-provider-safety.ts](../../src/server/telephony/recording-provider-safety.ts) načíta iba provider metadata a overí presný recording ID, TEST connection a prípadné session ID pred importom zvuku alebo DELETE. Pri cudzom alebo chýbajúcom dôkaze sa zvuk nesťahuje a provider záznam sa nemaže; `404` dovolí iba lokálne upratanie bez DELETE. Import vyžaduje zapnutý TEST live gate, upratanie preukázaného TEST záznamu funguje aj po jeho vypnutí. Táto kontrola nezávisí od 30-dňovej retencie webhook ledgeru, pretože recording policy môže uchovávať audio až 365 dní. Existujúca produkčná cesta nemá dodatočný metadata lookup.

## Integrácie: čo treba pripojiť a čo test dokazuje

Nasledujúce požiadavky vychádzajú z aktuálneho kódu. Dostupnosť credentials a skutočný úspech sa dopĺňajú až po zriadení; kľúč prítomný v prostredí sám osebe nepreukazuje funkčnú službu.

| Funkcia | Izolovaný TEST zdroj / konfigurácia | Overenie a otvorená závislosť |
| --- | --- | --- |
| Telnyx hovory a SMS | Vlastné TEST číslo, Call Control aplikácia, credential connection, outbound voice a messaging profile; zodpovedajúce `TELNYX_*` ID a key; env aj DB kill switches; presný allowlist testerov | Incoming, pickup, obojsmerný zvuk, hold/transfer/conference/hangup a SMS tam/späť na určených číslach. Potrebné potvrdené číslo testera, provider provisioning a podpisované callbacky. Produkčné resource ID nie sú náhrada. |
| Aplikačný email, pozvánky, reset hesla | Vlastný Resend sending key, ideálne obmedzený na TEST doménu; `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_APP_NAME`, `RESEND_API_KEY`; `MOTORIST_TEST_ALLOWED_EMAILS` | App pozvánky/reset používajú [access-management.ts](../../src/server/access-management.ts) a [email-delivery.ts](../../src/server/email-delivery.ts), nie iba Supabase SMTP. `sent` znamená prijatie Resend API, nie doručenie do inboxu. Na reálne overenie treba schválený tester email, doručený odkaz a úspešnú akciu len v TEST. |
| Emailové chybové stavy | Resend test adresy `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev` | Umožňujú preveriť provider udalosti; nenahrádzajú skutočný tester inbox. `RESEND_WEBHOOK_SECRET` v príklade env sám nezapája callback — aplikačná route pre Resend delivery status v pôvodnom kóde nebola. |
| AI telefonát | Samostatný OpenAI TEST projekt a jeho scoped key; `OPENAI_API_KEY`, `OPENAI_LIVE_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, explicitný `AI_DEMO_FROM_NUMBER` zo zoznamu vlastných TEST čísel; `AI_DEMO_ENABLED`, presný `AI_DEMO_ALLOWED_RECIPIENTS`; vlastný podpisovaný OpenAI webhook | `getAiDemoConfig()` overuje lokálnu konfiguráciu; model list nepreukazuje SIP/audio oprávnenie. Potrebný reálny obmedzený TEST hovor. `aiDemoFromNumber()` v TEST odmieta pôvodné produkčné caller ID aj implicitný fallback; nový caller ID musí byť výslovne schválený. |
| Nahrávka → prepis → AI analýza | TEST storage a recording policy, TEST Telnyx recording; `ELEVENLABS_API_KEY`, vlastný `ELEVENLABS_SCRIBE_WEBHOOK_ID/SECRET`; OpenAI TEST key; `RECORDING_PROCESSING_ENABLED`, `TRANSCRIPTS_ENABLED`, `AI_TRANSCRIPT_ENABLED` | Vyžaduje schválenú org policy a samostatne overený recording contract/channels/transfer/conference. Nastavenie `*_VERIFIED=true` bez mediálneho testu nie je dôkaz. Overiť nový TEST audio súbor, prepis, podpis callbacku a analýzu; staré odkazy na nekopírované recording súbory nemusia fungovať. |
| Hlasové oznámenia | Bundled `public/telephony/*.mp3`; na generovanie samostatný ElevenLabs key s potrebným oprávnením | Prehrávanie bundled audio nepotrebuje generovanie. Generovanie nového textu a playback sú dve samostatné kontroly. |
| Vozidlo: SKP, STKonline, HAKA, vPIC | Verejné zdroje zapínané provider flags v TEST DB; syntetický alebo schválený VIN/EČV; vlastný signing key pre uložený snapshot | [execute.ts](../../src/server/vehicle-lookup/execute.ts) používa verejné endpointy, SKP cez serverový browser. Chýbajúci nález, challenge či rate limit sú platné odlišné výsledky; ručné doplnenie musí zostať dostupné. Toto nie je sandbox poskytovateľa. |
| DatabázaVozidiel | Oddelený TEST API key/kvóta, `DATABAZA_VOZIDIEL_API_KEY` | Bez kľúča zdroj vracia `unsupported`/nenakonfigurované. V kóde nie je prepínač provider sandbox endpointu; treba povolený testovací záznam a samostatný účet/kľúč alebo označiť túto časť ako neoverenú. |
| SWHouse vozidlá/obsadenosť | Explicitný `SWHOUSE_API_BASE_URL`, `SWHOUSE_BASIC_USERNAME/PASSWORD`, `SWHOUSE_LOGIN_USERNAME/PASSWORD`; oddelený TEST dataset, branch mapping | Kód nemá implicitný fallback endpoint. Potrebný provider TEST účet alebo schválený izolovaný dataset; skopírované prod credentials nemožno použiť ako náhradu. |
| WebDispečink a Commander GPS | TEST vozidlá/účet; `WEBDISPECINK_COMPANY_CODE/USERNAME/PASSWORD`, URL a sync flags; `COMMANDER_API_USERNAME/PASSWORD`, URL; vlastné sync secrets | Samostatne overiť lookup/sync a zmeny len v TEST DB. Kopírované posledné polohy môžu zobraziť UI, ale nedokazujú živú synchronizáciu. Bez provider TEST prístupu sa uvádza nenakonfigurované. |
| Web Push a mobilný telefón | TEST VAPID/Vault secret a nové TEST subscriptions/device credentials | Staré production subscriptions a operátorské credentials nekopírovať. Overiť na testovacom zariadení; UI prihlásenie samotné nedokazuje zvonenie na pozadí. |

[Resend](https://resend.com/docs/dashboard/api-keys/introduction) podporuje samostatné kľúče a obmedzenie sending domény. [Test emaily](https://resend.com/docs/dashboard/emails/send-test-emails) simulujú výsledky doručovania a spotrebúvajú kvótu. Pre OpenAI sa používa projektová identita a minimálne oprávnenia; service-account key patrí iba TEST projektu, administrátorský kľúč nepatrí do aplikácie. [OpenAI RBAC](https://developers.openai.com/api/docs/guides/rbac), [service accounts](https://developers.openai.com/api/docs/guides/terraform/service-accounts). Aktuálne oprávnenia konkrétnych účtov tieto dokumenty nepotvrdzujú.

## Preberací protokol a prevádzka

### Kde vidieť výsledky

- V [TEST aplikácii](https://test.dispecing.linkapomoci.sk) otvor **Hovory → detail hovoru**: história, stav a dostupné trvania. Skopírovaná história nie je dôkazom nového TEST hovoru.
- V [samostatnom TEST projekte Vercel](https://vercel.com/alfopures-projects/pomoc-motoristom-test) otvor **Logs**: webhooky, cron a chyby konkrétneho deploymentu; už je dostupný overený plánovaný beh cronu.
- V [TEST Supabase](https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny/logs/explorer) sú databázové a Auth logy; vždy skontrolovať tento TEST ref.

Nová obrazovka `/monitor` patrí do stále draft PR #329; nie je zlúčená ani aktivovaná. Tieto výsledky sa zatiaľ sledujú na existujúcich miestach vyššie.

Pred označením **plne funkčný TEST** zapísať presný TEST project ID, deployment ID, commit, čas a výsledok každej kontroly:

1. DNS/TLS, Vercel mapping na nový TEST projekt a `dev`/Production, verejný aj serverový Supabase ref `nzpnqdstvkfncflgqlny`; produkčné mapovanie nezmenené.
2. `GET /api/health/live`, `GET /api/health/ready`, prihlásenie reálneho TEST účtu, trvalé označenie TEST a pravdivé capability stavy. `ready=200` nie je súhrnná garancia externých providerov.
3. Vratné vytvorenie/úprava TEST prípadu, kontaktu, úlohy a prílohy; overiť scope, oprávnenia a následné upratanie syntetických záznamov. Nekopírovať produkčné relácie a secrets.
4. Každý riadok integračnej tabuľky: buď konkrétny úspešný E2E dôkaz, alebo názov chýbajúceho zdroja/credential/oprávnenia. Callback smerujúci na správnu doménu bez overeného podpisu a spracovania nestačí.
5. Jeden plánovaný cron, odmietnutie neoprávnenej požiadavky, zákaz telephony operácií z pracovného Preview a odmietnutie kontaktu mimo TEST allowlistu. Auth bypass ostáva vypnutý.

Počas prípravy nevolať celý cron ako neškodný health endpoint: vykonáva údržbu a provider akcie. Verejné read-only HTTP kontroly možno zopakovať napríklad:

```sh
curl --fail --silent --show-error https://test.dispecing.linkapomoci.sk/api/health/live
curl --fail --silent --show-error https://test.dispecing.linkapomoci.sk/api/health/ready
```

Po zmene env je potrebné nové nasadenie správneho zdroja. Núdzovo vypnúť konkrétne TEST integration gates a prípadne TEST cron; nerušiť produkčné zdroje. Pred prípadným návratom domény na pôvodné Preview vypnúť odchádzajúce TEST integrácie a callbacky, aby provider neposielal udalosti do obmedzeného nasadenia. Obnova dát/pozastavenej Free DB naďalej používa [pôvodný runbook](test-environment.md); jeho zákaz živých integrácií platí pre obyčajné Preview, tento dokument dáva úzku výnimku iba samostatnému overenému TEST projektu.

Lokálne overenie email/AI guardov: 109 testov v štyroch súboroch prešlo, samostatný TypeScript a ESLint dotknutých súborov prešli. Testy používali syntetické hodnoty a fake fetch, bez provider požiadaviek; nie sú dôkazom reálnej dodávky emailu ani zvuku:

```sh
./node_modules/.bin/vitest run src/server/email-delivery.test.ts src/server/telephony/ai-demo/config.test.ts src/server/access-management.test.ts src/server/task-notifications.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src/server/email-delivery.ts src/server/email-delivery.test.ts src/server/telephony/ai-demo/config.ts src/server/telephony/ai-demo/config.test.ts
```

Nezávislé lokálne review spoločného Telnyx účtu uzavrelo tri nájdené medzery: cudzie ID v lifecycle akciách, callback bez preukázanej TEST connection a import/mazanie kopírovaných recording ID. Po opravách prešlo **148 testov v siedmich súboroch**; všetky provider odpovede boli fake, bez sieťových požiadaviek k poskytovateľom:

```sh
./node_modules/.bin/vitest run src/server/telephony/telnyx/test-safety.test.ts src/server/telephony/telnyx/test-sip-credential.test.ts src/server/telephony/telnyx/event-processor.test.ts src/server/telephony/telnyx/webhook-import-graph.test.ts src/server/telephony/recording-provider-safety.test.ts src/server/telephony/recording-processing.test.ts src/server/telephony/recording-storage.test.ts
```

Nezávisle schválený limit statického import graphu webhooku je 56 modulov (predtým 54): pribudli iba čisté env/TEST policy helpers, zakázané ťažké závislosti zostávajú zakázané. Päť čerstvých lokálnych Node importov zostaveného Next webhooku s vypnutým `fetch` malo production medián 154,19 ms. Toto meranie nepreukazuje hosted cold-start ani rýchlosť pripojenia hovoru. Hosted test/build gate je overený vyššie; prebratie živých integrácií ostáva otvorené.
