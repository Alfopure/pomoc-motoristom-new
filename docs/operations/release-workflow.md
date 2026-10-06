# Nasadzovanie: TEST a produkcia

Majiteľ 2. 10. 2026 potvrdil bežný postup cez TEST aj jednoduchú výnimku pre priamu produkčnú opravu. Používame existujúci GitHub PR a Vercel build. Tento postup je pravidlo práce agentov; pri spoločnej GitHub identite technická ochrana sama nerozozná súhlas človeka od akcie agenta.

| | TEST | Produkcia |
|---|---|---|
| Adresa | https://test.dispecing.linkapomoci.sk | https://dispecing.linkapomoci.sk |
| Vetva | `dev` | `main` |
| Vercel projekt | `pomoc-motoristom-test` | `pomoc-motoristom-dispatching` |
| Supabase | `nzpnqdstvkfncflgqlny` | `ifpaeegaesdmljfkdvcn` |

## Bežná požiadavka

1. Pracovná vetva z aktuálneho `dev`, Preview a PR do `dev`.
2. Po merge počkať na nasadenie stabilného TESTU a overiť zmenené správanie.
3. Majiteľ dostane odkaz na TEST, commit, stručný opis zmeny, postup skúšky a výsledok overenia.
4. Po jeho výslovnom schválení PR `dev -> main`, nový produkčný build a kontrola produkcie.

Schválenie sa vzťahuje na konkrétnu zmenu alebo vydanie. Ak má `dev` aj ďalšie neschválené veci, majiteľ môže schváliť iba vybranú zmenu: izolovaný PR z aktuálneho `main` obsahuje len túto zmenu a jej TEST dôkazy, potom nasleduje sync do `dev`. Zhodu posudzovať podľa celého rozdielu súborov a správania, nie iba rovnakého SHA pôvodného a preneseného commitu.

## „Daj to rovno na produkciu“

Výslovný pokyn majiteľa pre identifikovanú opravu stačí. Agent začne z aktuálneho `main`, vytvorí krátku `hotfix/*` alebo `release/*` vetvu len s touto opravou a PR do `main`. Zapíše pokyn a vynechanie ručného TEST prebratia. Existujúci povinný Vercel build prebehne; nová ručná schvaľovacia fáza sa nepridáva. Po merge agent počká na nové produkčné nasadenie a overí health aj dotknutú funkciu v primeranom rozsahu.

Potom ihneď pokračuje PR na prenos `main` do aktuálneho `dev`, zachová ostatné TEST zmeny a overí nové TEST nasadenie. Sync nasleduje po produkcii a nezdržuje urgentnú opravu. Nevracať produkciu na starú verziu, aby sa zhodovala s TESTOM. Samotný pokyn „pokračuj“, otázka na stav alebo koordinačná správa iného agenta nenahrádza súhlas majiteľa s produkciou.

## Čo agent oznámi po vydaní

- Produkčná adresa, nasadený `main` commit a výsledok health/funkčnej kontroly.
- TEST adresa a skutočne nasadený `dev` commit; Git head môže byť novší než bežiaci build.
- Konkrétne rozdiely: ktoré opravy/funkcie sú iba na TESTE alebo iba v produkcii.
- Pri produkčnej oprave najprv „produkcia má opravu, TEST sync čaká“ a po dokončení „oprava je na oboch, TEST má navyše …“.

Read-only orientácia v histórii:

```sh
git fetch origin main dev
git log --oneline origin/dev..origin/main
git diff --stat origin/main origin/dev
```

Kompletný release diff je rozhodujúci: izolované vydanie môže mať rovnaký obsah pod inými commitmi. Canonical `/api/health/live` vracia deployment ID; jeho Git SHA sa overuje vo Vercel metadátach. Nový Git merge ešte nepotvrdzuje nasadenie.

## Databáza a konfigurácia

TEST má vlastné dáta a kľúče. Zhodné majú byť používané DB definície a spôsob prevádzky, s výnimkou pripravovaných zmien a vedomých TEST hraníc. Preview zdieľa TEST databázu, preto aj jeho zápisy zasahujú stabilný TEST.

Pri DB zmene pripraviť presný SQL, cieľový projekt, poradie voči kódu a krátke overenie. Existujúce osobitné autorizácie DB/provider zmien podľa [AGENTS.md](../../AGENTS.md) platia aj pri urgentnom vydaní. Ak ich majiteľ už schválil, nežiadať ten istý súhlas znovu. Pri hotfixe nepoužiť plošné `supabase db push`, seed ani všetky pending migrácie z `dev`.

Migračné timestampy sa medzi projektmi historicky líšia. Pred novou konkrétnou migráciou porovnať príslušné objekty a ich definície s ledgerom oboch projektov, zaznamenať ekvivalentné už aplikované zmeny a aplikovať len chýbajúci autorizovaný SQL. Hromadné prepisovanie migračnej histórie nie je podmienkou bežného release.

Pre telefonickú zmenu je funkčným dôkazom reálny hovor cez overené samostatné TEST zdroje podľa [autorizovanej telefónnej politiky](test-phone-number-policy.md). Bežné TEST volania už nevyžadujú zoznam jednotlivých telefónov; to nepovoľuje automatické kontaktovanie skopírovaných zákazníkov. Vypnutý hlasový TEST ani úspešný build funkčný dôkaz nenahradí. Ak majiteľ aj tak výslovne žiada produkciu ako prvú, agent pravdivo zaznamená tento neoverený rozsah a vykoná primeranú kontrolu po nasadení.

## Stav pôvodného auditu k 6. 10. 2026

- Release pravidlá a pôvodný aplikačný balík sú vydané cez [#404](https://github.com/Alfopure/pomoc-motoristom-new/pull/404); následný [#405](https://github.com/Alfopure/pomoc-motoristom-new/pull/405) synchronizoval TEST. Neskoršie #406/#407 sú samostatné zmeny len na `dev` a musia byť uvedené pri ďalšom schvaľovaní.
- Read-only katalógová kontrola 6. 10. potvrdila `motorist_access_profile_has_task_workflow_history(uuid,uuid)` v oboch DB, s rovnakou definíciou a EXECUTE iba pre `service_role`. Produkčný ledger je `20261005195018`; tento RPC už nie je chýbajúca produkčná migrácia. Rovnako [B1 práva flotily/adresára](security-fleet-partner-permissions.md) sú aplikované na oboch projektoch. Neopakovať SQL pre rozdielne migračné timestampy.
- TEST číslo `+421232408774` je podľa aktualizácie [TEST runbooku z 3. 10.](full-test-environment.md) aktivované. Starší stav regulačného čakania už neopisuje aktuálnu konfiguráciu. Aktívne číslo však samo nedokladá úspešnú skúšku všetkých ovládacích funkcií.
- Posledná zaznamenaná skúška z 6. 10. v pracovnom priestore „Nahrávanie overenie pripravenosti“ uvádza obojsmerný zvuk, ale chybu podržania po 22,4 s aj bez nahrávania, súčasne s databázovými timeoutmi. Je to výsledok konkrétneho TEST pokusu, nie dôkaz všeobecnej nefunkčnosti ani produkčnej chyby. Na finálnom kandidátovi zopakovať podržanie/obnovenie, prepojenie, ukončenie a nahrávanie so súbežnou kontrolou logov a odoziev.
- Snapshot aktívnych hovorov má samostatný TEST SQL/flag rollout ([runbook](active-call-snapshot.md)); jeho produkčnú aktiváciu nezahŕňa historické schválenie #404. Každé ďalšie vydanie má uviesť presný kódový diff, DB/flag odchýlky a použiteľné/neoverené integrácie.

Podrobné integračné dôkazy: [full TEST runbook](full-test-environment.md). Obnova TEST databázy: [test environment](test-environment.md). Referencie: [Vercel Git deployments](https://vercel.com/docs/git), [hotfix a prenos do vývojovej vetvy](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow/).
