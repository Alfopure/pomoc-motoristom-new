# RALPLAN: Final CD, odťahy, pristavenia a odvozy

**Stav: finálny plán po sekvenčnej kontrole Planner → Architect → Critic · 26. 10. 2026.** Architekt po zapracovaní troch pripomienok schválil iteráciu i2; následne nezávislý kritik schválil presne tú istú verziu. Ide o ukončené plánovanie, nie vykonanú implementáciu, testovanie produktu alebo nasadenie.

Výsledkom bude **jedna webová aplikácia** so spoločnými prípadmi, používateľmi a navigáciou. Final CD, odťahy a pristavenia/odvozy tvoria jeden ucelený rozsah dodávaný cez menšie PR a priebežné TEST vydania.

## Ktoré dokumenty riadia realizáciu

- [Hlavný realizačný plán — PRD](prd-spolocna-aplikacia-20261026.md): rozsah, autority údajov, konkrétne súbory a závislosti, prístupy, migrácia a podmienky vydania.
- [Testovacia špecifikácia](test-spec-spolocna-aplikacia-20261026.md): kritériá A01–A24, súbehy a výpadky, prístupové hranice, mobilná kompatibilita a kompletný TEST scenár.
- [Rozhodnutia a porovnanie možností — RALPLAN-DR / ADR](ralplan-dr-spolocna-aplikacia-20261026.md): päť princípov, tri rozhodovacie faktory, tri možnosti, tri ADR a tri konkrétne scenáre možného zlyhania s prevenciou.

Tieto tri súbory sú obsahovo aj bajtovo totožné so schválenými pracovnými artefaktmi v `.omx/plans/`. Aktuálny realizačný kontrakt určujú ony; [skorší produktový návrh a jeho zdroje](../../docs/plans/spolocna-aplikacia-2026-10-26.md) a [DESIGN.md](../../DESIGN.md) zostávajú podkladom požiadaviek a UX.

## Kroky P0–P7

| Krok | Konkrétny výsledok | Nadväznosť |
| --- | --- | --- |
| **P0 — dátové a prístupové pravidlá** | Partner, väzby prípadov, identita úkonu a lokálny cyklus používania auta; pripravené lokálne migračné a prístupové testy. | Začiatok realizácie. |
| **P1 — spoločná aplikácia a účty** | Spoločná navigácia, Moje jazdy, partnerský vstup, pozvanie/aktivácia/obnova prístupu podľa modulov. | P0. |
| **P2 — úkony a kompatibilný prechod** | Viac úkonov na prípad, front pridelenej práce, potvrdenie kapacity a zachovanie dnešných mobilných odovzdaní. | P0/P1. |
| **P3 — Erosove odťahy** | Zadať odťah z prípadu, práca vodiča, dôkazy odovzdania, kontrola a nacenenie, evidencia faktúry, úhrad a hotovosti; AWP bez druhého prideľovania. | P2; pilot môže prebehnúť pred dokončením partnerského webu a dokumentu nehody. |
| **P4 — Final CD** | Partner podľa linky, konzultácia a prepojená asistencia, výstup pre servis, jednoduchý partnerský web a samostatný zúčtovací podklad. | P0/P1 a P2 pre výkonové väzby; súbežne s P3 pri oddelenom vlastníctve súborov. |
| **P5 — pristavenia a odvozy** | Prehľad, vlastné jazdy, odovzdanie auta, budúci návrat, prevzatie a doručenie, kontrola pripravenosti, základné poškodenia a merania. | P2; P3 pre odvoz odťahovkou. |
| **P6 — správa o nehode** | Klientsky formulár cez obmedzený odkaz, odovzdanie k správnemu prípadu a výsledný dokument. | P0/P4 a potvrdený vzor. |
| **P7 — spoločná akceptácia** | Na jednom identifikovanom TEST vydaní celý tok od Final CD hovoru po odťah, pristavenie, partnerský výsledok, odvoz a kontrolu auta. | Dokončené P3–P6 a testy jadra. |

Širšia správa flotily, podrobná kniha opráv a poisťovní, prenájmový kalendár, zápisy do SWHouse a automatické pripomienky nadväzujú. Základné hlásenie poškodenia a evidencia odovzdania už patria do P5. Cieľ knihy odťahov z mítingu je prvý január, interpretovaný ako 1. 1. 2027; termín a zostávajúci rozsah treba potvrdiť pri Erosovom rolloute, nejde o odhad trvania vývoja.

## Rozhodnutia, ktoré uzavrela revízia

1. **Jeden úkon má jedného vlastníka vykonania.** Spoločná identita prepája prehľady a súvislosti; existujúca odťahová zákazka naďalej vlastní svoje stavy, vodiča a financie. Nevzniká druhá editovateľná kópia tej istej práce.
2. **Pridelenie do frontu nie je potvrdená kapacita.** Vodič môže dostať viac jázd bez vymyslených časov. Súbeh sa kontroluje pri potvrdení termínu alebo začatí práce.
3. **Vyzdvihnutie prenajatého auta musí fungovať.** Voľná obsadenosť SWHouse je podmienkou nového použitia a pripravenosti náhradného auta, nie podmienkou jeho návratu od klienta.
4. **Starší mobil môže potvrdiť svoj pôvodný pracovný krok.** Web pri rovnakom úkone odlíši „Vykonané · dôkazy čakajú“. Doplnenie fotografií a meraní nepredstiera druhé dokončenie ani vodičovo potvrdenie a neobnoví zrušený prístup.
5. **Final CD a následná asistencia majú oddelené zúčtovanie.** Konzultácia môže viesť k novému prepojenému prípadu s iným platiteľom. Odporučený servis nie je potvrdené prijatie vozidla servisom.

## Výsledok review a hranice

- [Architekt i1: ITERATE — tri požadované doplnenia](../../.omx/plans/reviews/spolocna-aplikacia-20261026/i1/architect-review.md).
- [Architekt i2: APPROVE](../../.omx/plans/reviews/spolocna-aplikacia-20261026/i2/architect-review.md).
- [Následný kritik i2: APPROVE / OKAY](../../.omx/plans/reviews/spolocna-aplikacia-20261026/i2/critic-review.md).
- [Presná história, hashe a ukončenie plánovania](../../.omx/plans/ralplan-spolocna-aplikacia-20261026-lifecycle.json).

CLI bootstrap OMX nemohol bežať pre chýbajúcu binárku `omx-runtime`. Sekvenčné role preto prebehli cez natívnych agentov Conductor; uložené výsledky sú lokálny dôkaz revízie, nie hostiteľské bezpečnostné oprávnenie. Plánovanie sa uzatvára bez implementačného handoffu. Žiadne SQL, provider operácie, nové účty, produktové testy ani nasadenia sa týmto nevykonali.

Pri budúcej realizácii platí existujúci postup cez **https://test.dispecing.linkapomoci.sk**, osobitná autorizácia konkrétneho SQL/cieľového projektu a schválenie identifikovaného produkčného rozsahu podľa `AGENTS.md`.
