# Plán dokončenia a prvé App Store vydanie

**27.10.2026 — aktualizovaný návrh dokončenia.** Novší rozsah zdôrazňuje moduly Pobočky a Partneri, základné pobočkové reporty a menšiu novú správu flotily. Ide o plán a pripravené briefy; produktové zmeny ani produkčné odoslanie sa týmto nevykonali.

Dodatok prešiel sekvenčnou kontrolou [Architect — APPROVE](../../.omx/plans/reviews/pobocky-partneri-20261027/architect-review.md) a [Critic — APPROVE](../../.omx/plans/reviews/pobocky-partneri-20261027/critic-review.md). Ide o kontrolu návrhu, nie produkčné schválenie.

Tento dokument spresňuje [predošlý plán zo stretnutia](upravy-po-stretnuti-2026-10-27.md) podľa najnovších rozhodnutí majiteľa. Aktuálne platí [dodatok PRD Pobočky/Partneri](../../.omx/plans/prd-pobocky-partneri-20261027.md), jeho [overovacie kritériá](../../.omx/plans/test-spec-pobocky-partneri-20261027.md) a [rozhodnutia/alternatívy](../../.omx/plans/ralplan-dr-pobocky-partneri-20261027.md). [Predošlý PRD a Apple R5](../../.omx/plans/prd-dokoncenie-a-appstore-20261027.md) zostávajú podkladom tam, kde ich dodatok nemení.

## Čo už neblokuje vývoj

- **Ľudia a emaily prídu neskôr.** Skupiny, roly a odovzdávanie vyvinieme na malej označenej TEST zostave; skutočných ľudí potom doplníme cez správu členov.
- **Erosov postup použijeme.** Založenie → pridelenie → práca/fotografie → kontrola/nacenenie → PDF/faktúra → úhrady/hotovosť. Nové všeobecné zadanie od Erosa sa nežiada; riešia sa iba konkrétne rozdiely z pilotu.
- **Braňovo API je teraz iba predpríprava.** [Konkrétne požiadavky](../../.omx/plans/poziadavky-pre-brana-20261027.md) sú podklad pre majiteľa, ktorý si dohodne ďalší postup neskôr. Pripravíme mapovanie/rozhranie; živé napojenie ani potvrdený prenos nie sú podmienkou tohto vydania. Brief sa automaticky neodoslal.
- **Partneri je všeobecný modul.** Final CD bude prvý partner s jedným všeobecným účtom. Ďalší partneri majú svoje identity a oddelený prístup k vlastným prípadom, poistným udalostiam, poznámkam a povoleným prehľadom. Audit zachytí spoločný účet; natívny partnerský modul zatiaľ nie je súčasťou iPhone1.0.

## Dodávky

| Celok | Výsledok | Závislosť |
|---|---|---|
| **R1 — modul Pobočky** | Vlastný pracovný prehľad, prípady/práca a základné reporty. Centrála → skupina → lokálny dispečer → človek alebo on sám. Serverové scope, jedno prevzatie a trvalý front/oznámenie. | Bez rosteru a bez vybraného auta pri prvom príjme; prvý pilot môže byť sledovaný webový front. |
| **R2 — mobil a odťahy** | Potrebné kroky konkrétnych pridelených jázd/odvozov, vodičská odťahová karta, doklady a správni príjemcovia push. Existujúci Erosov proces a kontextové návraty ostávajú. | R1 pre nový lokálny front; pôvodné mobilné pristavenia zostanú kompatibilné. Nový široký fleet/inspection modul sa odkladá. |
| **R3 — modul Partneri** | Interný prehľad partnerov, prípadov, konzultácií, výkonov a zúčtovania podľa práv. Partner vidí iba svoje povolené prípady/poistné udalosti, následný kontakt a prehľady. Potom poznámky/dokumenty a P6 podľa SKP. | Final CD ako prvá konfigurácia so všeobecným účtom; ďalší partneri rovnakým modelom. Nečaká na R2 alebo Braňa. |
| **R4 — predpríprava nájmu** | Mapovanie údajov, pripravený brief/rozhranie a pravdivý stav nedohodnutého napojenia. | Reálny adaptér a živý prenos až v samostatnej dodávke po dohode majiteľa s Braňom; neblokuje tento release. |
| **R5 — App Store1.0** | Funkčný dispečerský/pristavovací základ v unlisted produkčnej aplikácii; neskoršie moduly ďalšími verziami. | Samostatný produkčný kandidát, backend/podpis/hlas, krátky fyzický dôkaz a Apple review. Nečaká na dokončenie R1–R4. |

Pri odťahu s náhradným autom sú dva prepojené výkony, ktoré môže dostať rovnaký oprávnený človek. Koordinačný pohľad neotvára cudzie prílohy/financie. Návrat auta odťahovkou sa nevykazuje ako druhý logistický výkon.

## Pobočkový pohľad a reporty

Jedno prihlásenie do spoločnej aplikácie; miestny používateľ otvorí vlastný modul **Pobočky** s názvom pobočky, prehľadom a svojimi povolenými prípadmi. Centrála môže porovnávať povolené pobočky, človek s viacerými pobočkami prepína iba medzi vlastnými kontextmi. Jednotliví vykonávatelia dostanú vlastnú prácu, nie automaticky celý pobočkový spis.

Základné reporty sú súčasťou prvého modulu: prijaté požiadavky a jedinečné prípady, čakajúce/nepridelené práce, prebiehajúce/dokončené výkony, čas reakcie a zaťaženie vykonávateľov. Filtre obdobie/pobočka/druh práce/človek podľa práv. Presun prípadu nemení historickú zásluhu pobočky; chýbajúci čas alebo pobočkové mapovanie ukážeme ako neznáme. Financie len z overených podkladov a s oprávnením.

## Minimum auta, ktoré ponecháme

Rozsiahly nový životný cyklus auta, fleet časovú os, prenájmový kalendár a nové natívne kontrolné/poškodeniové obrazovky odkladáme. Už existujúce väzby na konkrétne použitie auta, odvoz, jediný návrat, doklady a bezpečnú pripravenosť zostávajú, spolu s potrebnými dnešnými webovými úkonmi. Sú naviazané na logistiku a návrat odťahovkou; ich odstránenie by pridalo riziko a prácu. Pobočky, Partneri ani bežný odťah na nový fleet modul nečakajú.

## Apple — odporúčanie a presný postup

**Áno: vydať hotový základ1.0 cez unlisted App Store a nové moduly pridávať aktualizáciami.** Aplikácia sa nenachádza vo vyhľadávaní; stiahnuť ju môže držiteľ odkazu, k údajom sa dostane iba s povoleným účtom. Takéto použitie pre pracovnú skupinu Apple podporuje. [Oficiálne unlisted pravidlá](https://developer.apple.com/support/unlisted-app-distribution/).

Prísne obmedzenie samotného stiahnutia na konkrétne organizácie patrí do Custom Apps/Apple Business distribúcie. Aktuálny zvolený zámer je unlisted+login.

Aktuálne overený Apple inventár obsahuje TEST kartu; schválený TEST build23 nie je ostrým App Store schválením. Produkčný build potrebuje vlastnú identitu `sk.linkapomoci.dispecing`, podpis, správny server a funkčný produkčný hlas/push. Dnešný TEST proof flag sa nesmie iba prepnúť na produkciu.

1. Vybrať a overiť presný hotový základ1.0 a jeho potrebný produkčný backend; nevydávať všetok dev spolu s Apple.
2. Pripraviť produkčnú kartu/binárku, review konto, skutočné snímky, privacy a metadata zodpovedajúce tomuto rozsahu. [Pripravený submission brief](../../.omx/plans/appstore-v1-submission-brief-20261027.md).
3. Pred odoslaním nastaviť **Manually release this version**. Odoslať na App Review a následne požiadať o unlisted; na podanie tejto žiadosti netreba čakať na prvé schválenie.
4. Udržať manual hold až do potvrdenia review aj Unlisted distribúcie; potom vykonať autorizované uvoľnenie identifikovaného releasu. Žiadne nechcené verejné automatické publikovanie.
5. Ďalšie verzie idú cez review tej istej produkčnej karty a ostávajú unlisted. Nový účet podporovanej funkcie nepotrebuje nový build; nový natívny modul áno.

[Apple manual release](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/) a [požiadavky App Review](https://developer.apple.com/app-store/review/guidelines/) určujú podmienky; dobu schvaľovania negarantujeme.

**Budú aktualizácie po zalistovaní rýchlejšie?** Menšie úpravy a bugfixy podľa Apple zvyčajne postupujú rýchlejšie. Prvé schválenie však nedáva zaručenú prioritu a každá nová natívna verzia ide do review. Apple aktuálne uvádza celkový cieľ aspoň50% podaní skontrolovať do24h a90% do48h; nejde o garantované schválenie. Zmeny dát/účtov/nastavení už podporovanej funkcie nepotrebujú nový natívny build. Nový natívny modul áno; vypnuté OTA nemeníme na obchádzku review. [Aktuálny review status a lehoty](https://developer.apple.com/help/app-review/after-submitting-for-review/review-status), [review každej verzie](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review/).

## Ako dokončenie overíme

Cielené testy zmenených oprávnení/súbehov, existujúci povinný CI gate a jedna ukážka príslušného toku na konkrétnom TEST SHA. Nová produkčná IPA má vlastnú kontrolu konfigurácie a krátky fyzický pilot zvuku/push/polohy podľa podporovaného rozsahu. Hotové nezmenené časti sa netestujú opakovane bez dôvodu. Všetko živé má PASS/FAIL/NEOVERENÉ; zdravý server ani simulátor nezastupujú fyzický dôkaz.

Presné produkčné SQL a provider zmeny patria k konkrétnemu releasu podľa AGENTS. Toto plánovanie nič neaplikovalo, nezakladalo účty a nezasiahlo cudzí Watchdog ani poľskú databázu.
