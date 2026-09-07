# Stabilita hovorov, pauzy a spätné volania

Táto zmena patrí výhradne samostatnej Telnyx kópii: Supabase `ifpaeegaesdmljfkdvcn` a Vercel `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, región Frankfurt. Rozširuje existujúce smerovanie, webhooky, callback requests a päťminútový cron. Nepridáva listener, worker ani ďalší plánovač.

## Správanie

- Pauza vylučuje automatické ponuky na webový telefón aj osobný mobil, vrátane posledného prihláseného operátora. Už odoslaná ponuka sa ruší podľa svojho tokenu; ak odpoveď poskytovateľa dorazí neskôr, jej identita sa pripojí k rovnakému zrušeniu. Samostatné záložné číslo pokračuje podľa plánu.
- Rozhodnutie pauza verzus prijatie je jedna databázová transakcia. Ak vyhrá prijatie, zmena pauzy nesmie predstierať, že rozhovor neexistuje. Ak vyhrá pauza, oneskorená odpoveď nemôže spojiť zákazníka s operátorom.
- Operátor na pauze môže výslovne prevziať konkrétny čakajúci hovor. Ukladá sa vlastník prevzatia a pôvodná pauza vrátane dôvodu. Po hovore a dokončení zápisu sa obnoví tá istá pauza. Obnova funguje aj bez otvorenej konzoly.
- Zápis zmeny hovoru a zoznam jej nedokončených účinkov vznikajú spolu. Existujúci cron dokončí zápisy a zopakuje príkazy so stabilnou identitou aj pri ukončených reláciách. Ukončenie a súhlas s vypnutím nahrávania majú prednosť pred chybným historickým zápisom.
- Callback vybaví až dôkaz spojenia správneho zákazníka s oprávneným účastníkom. Samotné `answered`, stav `talking`, IVR ani interná konzultácia nestačia. Prípad, linka, číslo, čas a explicitná väzba bránia uzavretiu cudzej alebo novšej požiadavky.
- Pri konferencii sa overuje správna dvojica v jednej odpovedi poskytovateľa: pripojení účastníci s presnými identitami, bez podržania, stlmenia alebo súkromného šepkania. Samostatné udalosti príchodu do konferencie nestačia. Neúspešné overenie sa uloží na obnovu; už zachytený dôkaz sa dokončí aj po ukončení hovoru. [Zoznam účastníkov konferencie](https://developers.telnyx.com/api-reference/conference-commands/list-conference-participants).
- Ak cieľ prepojenia prejde na pauzu pred povolením vytáčania, pôvodný rozhovor a jeho operátor zostanú pripojení. Po odmietnutí sa obnoví povolené nahrávanie; prípadná medzera zostane označená.
- Fronta používa existujúce callback requests. História zmeškaných hovorov ostáva pravdivá; staršie samostatné úlohy zostávajú v prehľade úloh. Ručné naplánovanie má vlastnú identitu akcie, termín a ochranu pred dvojklikom.
- Ak sa rozhovor spojí pred potvrdením nahrávania, metadáta a audit zachovajú `coverageUnconfirmed`. Neskorší úspešný START túto neistotu nezmaže. Detail označí dostupný záznam ako čiastočný a automatické číselné hodnotenie nemôže predpokladať úplný rozhovor.

`TELEPHONY_STABILITY_V1_ENABLED=true` povoľuje vznik nových rozšírených tokov. Chýbajúca hodnota znamená vypnutie. Už existujúce `effects_v1`, pending účinky, prevzatia a návratové kontexty sa musia dokončovať aj po vypnutí. Zákaz automatického pauza → osobný mobil zostáva aj pri vypnutej tvorbe nových tokov.

## Databázové zmeny

Aplikovanie migrácií do spoločného projektu vyžaduje osobitný výslovný pokyn podľa `AGENTS.md`. Súčasťou implementácie sú tieto súbory v poradí:

| Migrácia | Účel |
| --- | --- |
| `20260928100000_atomic_presence_contract.sql` | Revízie prezencie, tokeny ponúk, trvalý návrat na pauzu, zrušené ponuky, atómové RPC |
| `20260928110000_durable_transition_effects.sql` | Atómový zápis rozhodnutia s nedokončenými účinkami, indexovaný termín obnovy |
| `20260928120000_callback_contact_fulfillment.sql` | Transakčné vytvorenie a vybavenie záväzku s úlohou/auditom, presná väzba, zámok spoločný s ručným plánovaním |
| `20260928130000_personal_mobile_ownership.sql` | Vlastník osobného mobilu, spôsob doručenia a kompatibilné uloženie skupiny |

RPC kontrolujú organizáciu a povolenia; vykonáva ich serverová rola. Obnova vyberá ohraničené dávky cez termíny a čiastočné indexy. Chybná relácia dostane odklad ďalšieho pokusu, aby najstaršia dávka neblokovala ostatné hovory. Historický callback sa nevyhľadáva načítaním celej histórie do aplikácie.

Pred migráciami porovnať aplikovanú schému a indexy tejto kópie s repozitárom. Overiť konfiguráciu vlastníctva mobilov; nejednoznačné osobné číslo nesmie dostať automatickú ponuku. [Inventár starších callback úloh](callback-legacy-inventory.sql) je iba čítací podklad. Hromadný prevod starých úloh sa automaticky nevykonáva.

## Overenie pred aktiváciou

Lokálne brány:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
python3 tests/postgres/presence-contract.py
python3 tests/postgres/mobile-contract.py
python3 tests/telephony/callback-contract.py
E2E_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test e2e/paused-webphone.spec.ts e2e/paused-pickup-tabs.spec.ts e2e/callback-unified.spec.ts e2e/callback-queue.spec.ts e2e/mobile-calling-preflight.spec.ts
```

PostgreSQL skripty používajú iba lokálny port `55432` a vlastné zahoditeľné databázy. Potrebujú bežiaci lokálny PostgreSQL a `psycopg`. [Rozsah databázových testov](../../tests/postgres/README.md) výslovne rozlišuje presné migrácie nad redukovanou schémou od úplného Supabase resetu; pôvodné ukladanie konfigurácie je v mobilnom teste stub. Tieto testy nenahrádzajú kontrolu celej aktuálnej schémy.

Vybrané Playwright testy interceptujú všetku sieť a používajú syntetické účty. Topológia falošného poskytovateľa testuje poradie a spojenie vetiev, nie obojsmerný zvuk v Telnyx sieti. Telnyx dokumentuje opakovanie rovnakého `command_id`, no lokálny fake nedokazuje neobmedzenú dobu deduplikácie ani obsah odpovede pri opakovaní. [Opakovanie príkazov](https://developers.telnyx.com/docs/voice/programmable-voice/command-retries), [bridge](https://developers.telnyx.com/api-reference/call-commands/bridge-calls).

## Postup nasadenia

1. Pracovná vetva vzniká z aktuálneho `dev`. Po zelených bránach overiť jej Vercel Preview s tvorbou nových tokov vypnutou a vytvoriť PR do `dev`. Preview používa spoločnú databázu, preto na ňom nespúšťať syntetické zápisy bez určených testovacích účtov.
2. Po výslovnom pokyne aplikovať štyri preskúmané migrácie iba do tejto kópie. Overiť RPC, organizáciu, indexy a kompatibilitu aktuálnych dát. Zostaviť nemenný zoznam verzií aplikácie, ktoré vedia nové záznamy nielen čítať, ale aj dokončiť.
3. Pred zapnutím zabrániť vykonaniu starých nekompatibilných verzií. Zmena aliasu alebo premenných nového buildu nezablokuje staré Preview URL, staršie produkčné URL ani klienta pripnutého na starý deployment.
4. Konkrétnou navrhnutou hranicou je projektové WAF Deny pre nepovolené hosty spolu s prahom Skew Protection na kompatibilnú verziu. Preskúmať výnimky, poradie bypass pravidiel a všetky prostredia. Testovať aj staré ID cez `?dpl=`, `x-deployment-id` a `__vdpl` na povolenom aliase. Toto nastavenie nie je súčasťou zmeny kódu a jeho účinnosť treba doložiť. [WAF pravidlá](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration), [Skew Protection](https://vercel.com/docs/skew-protection).
5. Negatívny test starej verzie musí použiť inak platnú autentifikáciu alebo podpis a kontrolovať absenciu databázových/provider účinkov. Obyčajná anonymná 401 nestačí. Zahrnúť prezenciu, GET aktívnych hovorov vykonávajúci sweep, akcie, webhook/failover aj cron. Vstup a testovacie dáta musia byť bezpečné aj pri chybnej izolácii. Súčasne overiť pozitívny priechod cez kompatibilné aliasy.
6. Proti najstaršej povolenej kompatibilnej verzii overiť webhook, cron a console sweep nad novým paused pickup, callback proof a pending auditom. Vypnúť tvorbu počas aktívneho hovoru a potvrdiť dokončenie po návrate na kompatibilný baseline. Starší nekompatibilný build nesmie zostať možnosťou rollbacku.
7. Po merge overiť alias `dev`. Produkčná zmena ide výhradne PR `dev` → `main`, potom overenie produkčného aliasu tejto kópie. Zachovať jediný cron `*/5 * * * *` → `/api/telephony/cron`, chránený `CRON_SECRET`.
8. Až po splnení izolácie, kompatibility a testov zariadení zapnúť tvorbu v určenom prostredí. Nezapínať ju všeobecne pre všetky Preview vetvy.

Test zariadení vyžaduje dvoch určených operátorov a testovaciu linku: pauza pred/počas zvonenia aj posledný online; výslovné prevzatie s návratom na pauzu; rozhovor → hold/park → pickup → konzultácia/prepojenie → koniec; missed → úspešný inbound/outbound → nový missed; štyri súčasné hovory pri dvoch operátoroch. Zaznamenať obojsmerný zvuk, stav oboch zariadení, aktuálny commit/deployment a anonymizované identity relácií. Overiť aj koreláciu skutočných bridge/konferenčných webhookov pri zapnutom aj vypnutom nahrávaní.

## Rollback a obnova

Najprv vypnúť tvorbu nových tokov. Ponechať kompatibilný kód, schému, historické dôkazy, návratové kontexty a dokončovanie pending účinkov. Nevracať schému späť a nevyprázdňovať journal. Existujúce hovory sa nemajú násilne ukončiť kvôli nasadeniu. Povolený rollback musí vedieť dokončiť rovnaký kontrakt a musí zostať za overenou hranicou vylúčenia starých zapisovačov.

Pri neúspešnej obnove skontrolovať `effects_next_attempt_at`, `pending_effects.entries[].lastError`, termíny zrušení a vlastnícke tokeny. Nespúšťať ručne starý dial/bridge z historického snapshotu. Príkazy vytvárajúce zvuk musí stále povoliť aktuálna topológia; historické databázové účinky sa môžu dokončiť aj po konci hovoru.

Aktiváciu nemožno považovať za overenú iba na základe lokálnych testov. Dôkazy o platformovej izolácii, migráciách a skutočných zariadeniach sa zapisujú samostatne pre konkrétny nasadzovaný commit.
