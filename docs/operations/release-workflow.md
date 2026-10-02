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

Pre telefonickú zmenu je funkčným dôkazom reálny hovor cez overené samostatné TEST zdroje a schválené destinácie. Vypnutý hlasový TEST ani úspešný build ho nenahradí. Ak majiteľ aj tak výslovne žiada produkciu ako prvú, agent pravdivo zaznamená tento neoverený rozsah a vykoná primeranú kontrolu po nasadení.

## Dokončenie pôvodného auditu

1. Zaviesť tieto pravidlá do `dev` a pripraviť samostatné dokumentačné vydanie pre `main`; aplikačný kód sa tým nemení.
2. Doplniť chýbajúci produkčný RPC `motorist_access_profile_has_task_workflow_history` z existujúcej migrácie `20261006140000_access_profile_task_history.sql`, po autorizácii presného SQL pre `ifpaeegaesdmljfkdvcn`. TEST už má správnu definíciu a execute len pre service_role. Produkcia dnes bezpečne anonymizuje profil pri nedostupnom RPC. Táto oprava neaplikuje telefonickú endpointovú migráciu.
3. Dokončiť pripravenosť bežného hlasového TESTU. Posledný provider runbook uvádza objednávku slovenského TEST čísla v regulačnom čakaní; treba overiť aktuálny stav čísla, TEST-only resource identity a povolené destinácie. Až potom aktivovať autorizovanú TEST konfiguráciu a overiť bežný príjem/odchádzajúci hovor, zvuk oboma smermi a ukončenie. Regulačné údaje patria majiteľovi, nie do repozitára.
4. Uzavrieť stav konkrétnym prehľadom nasadení, DB odchýlok a použitelných/neoverených integrácií. Nezlučovať ďalšie funkcie len preto, aby sa SHA TESTU a produkcie zhodovali.

Podrobné integračné dôkazy: [full TEST runbook](full-test-environment.md). Obnova TEST databázy: [test environment](test-environment.md). Referencie: [Vercel Git deployments](https://vercel.com/docs/git), [hotfix a prenos do vývojovej vetvy](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow/).
