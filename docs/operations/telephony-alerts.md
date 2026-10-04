# Ako čítať upozornenia telefónie

Tento dokument opisuje význam e-mailových upozornení a kontrolné scenáre pre ich úpravu. Sám osebe nepotvrdzuje nasadenie ani úspešné vykonanie testov. Konkrétny overený commit, nasadenie a výsledky patria do odovzdania zmeny a release PR.

## Najprv výsledok konkrétneho hovoru

E-mail má oddeliť dve otázky: **„Spojil sa volajúci s operátorom?“** a **„Aký problém teraz zistil monitoring?“** Chyba spracovania udalosti nemusí znamenať neúspešný hovor. Potvrdený rozhovor zase nevylučuje neskorší problém pri prepojení alebo ukončení.

| Čo vieme | Ako tomu rozumieť | Čo urobiť |
|---|---|---|
| Existuje potvrdenie spojenia oboch strán | Hovor bol spojený v uvedenom čase. | Prečítať si osobitne zistený problém; iba kvôli technickému upozorneniu nevolať zákazníkovi znovu. |
| Existuje potvrdenie spojenia a následne ukončenie | Hovor sa spojil a potom skončil. | Samotné ukončenie neznamená chybu. Záznam nehovorí, či bol zákazník spokojný ani či bol zvuk bezchybný. |
| Hovor je prijatý, ale spojenie oboch strán nie je potvrdené | Zdvihnutie jednej strany ešte nepreukazuje rozhovor. | Overiť hovor v aplikácii; pri aktuálnom probléme overiť situáciu s operátorom. |
| Hovor skončil bez dostupného potvrdenia spojenia | Výsledok rozhovoru sa zo záznamov nedá potvrdiť. | Nepovažovať ho automaticky za úspešný ani za technicky pokazený; skontrolovať históriu. |
| Chýbajú údaje alebo ich nemožno načítať | Výsledok nie je známy. | Riadiť sa uvedeným dôvodom a odovzdať technickú časť na kontrolu. |
| Upozornenie sa týka limitu, nastavenia alebo celej služby | Správa nehodnotí jeden konkrétny hovor. | Postupovať podľa popisu prevádzkového problému. |

Príjemca má dostať pri každom dotknutom hovore jeho čas, identifikátor, dostupné dôkazy a výsledok. Pri viacerých hovoroch sa výsledky nemajú zlievať do jednej vety „hovory fungujú“ alebo „hovory zlyhali“. Čiastočný zoznam musí byť označený ako čiastočný.

## Situácie pri spojení a ukončení

| Situácia | Očakávaná interpretácia |
|---|---|
| Rozhovor trvá viac ako 5 alebo 15 minút bez novej udalosti | Samotné ticho nie je porucha. Rozhovor, podržanie, konzultácia a konferencia nepotrebujú neustály prúd webhookov. |
| Stav aplikácie už je `talking`, ale ešte čaká príkaz na spojenie alebo jeho potvrdenie | Nespoliehať sa iba na názov stavu. Nedokončené spojenie sa má posúdiť samostatne. |
| Zazvonil aj záložný mobil, operátor prijal v prehliadači a mobil bol zrušený | Ukončenie záložnej vetvy nie je dôkazom ukončenia rozhovoru zákazníka s operátorom. Rozhodujú dôkazy pre správne strany hovoru. |
| Volajúci položil počas vyzváňania | Ukončenie bez potvrdeného rozhovoru môže byť bežné zavesenie volajúceho. Samotné `call.hangup` neznamená výpadok ústredne. |
| Operátor alebo externé číslo bolo obsadené či nezdvihlo | Výsledok jednej ponuky nehovorí, či neskôr hovor prijal niekto iný. Posúdiť celý hovor a ostatné vetvy. |
| Hovor bol pôvodne spojený a potom sa prepojuje | Pôvodné potvrdenie preukazuje skorší rozhovor. Nepotvrdzuje úspech nového prepojenia. |
| Chybný príkaz sa neskôr podarilo zopakovať | Úspešné vykonanie príkazu je údaj o oprave príkazu. Potvrdenie spojenia je samostatný dôkaz. |
| Neskoršia udalosť patrí inému príkazu alebo inému hovoru | Nesmie sa použiť ako potvrdenie opravy pôvodného problému. |
| Prišiel oneskorený alebo duplicitný webhook | Samotná duplicita alebo oneskorenie nepreukazuje zlyhanie hovoru. Rozhoduje výsledok spracovania a stav správneho hovoru. |
| Hovor sa ukončil, ale webhook o zavesení sa stratil | Existujúci cron overí stav u Telnyxu. Jednoznačne potvrdené ukončenie sa spracuje bežným mechanizmom ukončenia, aby sa zosúladila evidencia a dostupnosť operátora. |
| Telnyx potvrdil koniec, ale zosúladenie aplikácie zlyhalo | E-mail musí oddeliť koniec u poskytovateľa od chyby evidencie; problém ešte nie je vyriešený. |
| Počas overovania prišla nová udalosť alebo hovor spracúva iný proces | Dočasná kolízia nie je dôkazom prerušenia rozhovoru. Neprezentovať nevykonanú opravu ako dokončenú. |

Potvrdenie spojenia pochádza z konkrétnych záznamov o premostení strán alebo potvrdenej účasti v konferencii. Údaj Telnyxu „táto vetva je aktívna“ potvrdzuje iba existenciu danej vetvy. Ani jeden z týchto údajov nepreukazuje počuteľný obojsmerný zvuk, jeho kvalitu alebo úspešné vybavenie požiadavky.

## Keď sa stav nepodarí overiť

| Výsledok overovania | Čo smie správa tvrdiť |
|---|---|
| Telnyx vracia aktívnu vetvu | Táto konkrétna vetva bola pri kontrole aktívna. |
| Telnyx jednoznačne vracia `is_alive: false` pre známu vetvu | Táto vetva skončila; možno spracovať jej chýbajúce ukončenie. |
| Telnyx ID nepozná, odpovie 404/422 alebo chýba platná hodnota stavu | Stav sa nepodarilo potvrdiť. Nepovažovať to samo osebe za povolenie ukončiť hovor. |
| Timeout, výpadok siete, odmietnutý prístup, limit API alebo chyba poskytovateľa | Zlyhalo overovanie; nie je potvrdené zlyhanie hovoru. |
| TEST ochrana odmietne prístup k zdroju bez TEST pôvodu | Zdroj sa neoveril. Ochrana sa nesmie obchádzať ani nahrádzať produkčnými údajmi. |
| Chýba identifikátor vetvy alebo databázové čítanie zlyhalo | Chýbajú dôkazy; nesmie vzniknúť zelený výsledok „všetko funguje“. |
| Do jedného behu sa nezmestia všetky hovory alebo vetvy | Uviesť obmedzený rozsah. Overené vetvy nepreukazujú stav neoverených vetiev. |
| Samostatná health kontrola nemá výsledok overenia z cronu | Poskytovateľ sa v tejto požiadavke neoveroval. `not_checked` nie je dôkaz výpadku ani úspešného hovoru. |

Provider overovanie používa existujúci päťminútový cron. Má obmedzený rozsah a čas; neúplný výsledok sa nesmie vydávať za úplnú kontrolu. Pravidelná údržba ani nový webhook iného zákazníka nesmú „omladiť“ dôkaz, že sa konkrétny hovor zasekol pri očakávanom kroku.

Prevádzkové hranice: po troch minútach sa hovor môže dostať do výberu na provider overenie; jeden beh vyberá najviac desať hovorov a šesť vetiev každého hovoru. Výber hovorov sa medzi behmi strieda. Časový rozpočet sa kontroluje pred ďalšou operáciou, práve vykonávaná operácia sa svojvoľne nepreruší. Dlhšie čakanie na odpoveď alebo väčší počet vetiev preto môže zanechať neoverenú časť, ktorá musí byť priznaná.

## Prevádzkové upozornenia

| Kontrola / situácia | Význam pre majiteľa |
|---|---|
| Pozdrav, IVR, vyzváňanie alebo iný krok sa neposunul po očakávanej lehote | Konkrétny krok mešká; skontrolovať dotknutý hovor. Neodvodzovať problém z posledného webhooku celej organizácie. |
| Čakanie alebo parkovanie prekročilo očakávanú obnovu či limit | Problém sa týka čakania daného zákazníka. Predchádzajúci rozhovor môže byť potvrdený aj vtedy, keď neskoršie čakanie zlyhá. |
| Udalosť je vo fronte (`queued`) | Bežné čakanie nie je samo osebe chyba. Dlho nedokončené spracovanie je upozornenie na oneskorenie a existujúce opakovanie spracovania. |
| Udalosť má `failed` | Zlyhalo spracovanie udalosti. Neznamená to automaticky zlyhanie rozhovoru ani vyčerpanie všetkých možností opakovania. Rozhoduje aj stav obnovy a dôkazy konkrétneho hovoru. |
| Otvorený incident spracovania webhooku, príkazu alebo používateľskej akcie | Aplikácia eviduje technickú chybu danej časti. Bez dôkazov hovoru nemožno tvrdiť, že zákazník nebol spojený. |
| Nedá sa načítať konfigurácia, hovory, udalosti, incidenty, využitie alebo zariadenia | Ide o chybu kontroly alebo nedostupné údaje. Nulový počet z neúspešného čítania neznamená „žiadne problémy“. |
| Približuje sa denný limit vetiev (od 80 %) | Preventívne upozornenie na kapacitu; nehodnotí výsledok už uskutočnených hovorov. Jedno volanie môže vytvoriť viacero vetiev. |
| Denný limit vetiev bol dosiahnutý | Ďalšie vytváranie vetiev môže byť odmietnuté. Nie je to dôkaz ukončenia práve prebiehajúcich rozhovorov. |
| Žiadny prehliadačový telefón nie je dostupný | Samotný počet je informatívny; napríklad mimo pracovného času môže byť bežný. Smerovanie môže mať záložné možnosti. Chyba načítania zariadení je odlišný prípad. |
| Telefónia v obmedzenom Preview nie je nakonfigurovaná | Provider kontrola je `skipped`; nejde o potvrdenie zdravého provider spojenia. Samotné zámerne chýbajúce nastavenie nemá spúšťať poplach. |
| Nakonfigurovaná ústredňa je pokojná a bez zistených problémov | Žiadny e-mail iba kvôli tomu, že dlho neprišiel hovor alebo webhook. |
| Pribudne neznámy typ kontroly | Správa má zrozumiteľný všeobecný popis a technický identifikátor. Nesmie si domyslieť výsledok hovoru. |

Úrovne `warn` a `fail` vyjadrujú závažnosť zistenej kontroly. Neznamenajú automaticky „hovor prebehol“ a „hovor neprebehol“. Podmienky odosielania jednotlivých upozornení sú v [alerts.ts](../../src/server/telephony/alerts.ts); samotný health report môže obsahovať aj údaje bez samostatného e-mailu.

Odosielajú sa zlyhania kontrol a výstrahy na denný limit, chýbajúci krok hovoru, neisté výsledky spojenia a neúplné provider overenie. Výstraha s chybou načítania údajov sa oznamuje aj pri ostatných kontrolách. Už napravené historické spojenia ani providerom potvrdené aktívne vetvy sa samy nepridávajú medzi dotknuté incidenty iba preto, že iný hovor mal problém.

Pri čakaní na konkrétny ďalší krok sa päťminútová výstražná a pätnásťminútová vážnejšia lehota počítajú od očakávaného termínu daného kroku. Nie sú maximálnou povolenou dĺžkou rozhovoru. Bežná výstraha na nedokončenú udalosť vo fronte zostáva viditeľná v health reporte; nevytvára sama osebe nový e-mail pri každom opakovaní.

## Technická časť na skopírovanie

Za ľudským vysvetlením má byť samostatná diagnostická časť, ktorú možno skopírovať celú pre podporu. Obsahuje identifikátory kontrol, dotknutých hovorov a udalostí, čas kontroly, dostupné dôkazy, dôvody zistení a informáciu o neúplných údajoch. Heslá, kľúče, prístupové tokeny, cookies, autorizácie, celé provider payloady a citlivé URL do nej nepatria. Voľné texty výnimiek a odpovedí poskytovateľov sa vynechávajú, pretože môžu obsahovať prihlasovacie údaje; pôvodnú chybu možno dohľadať podľa zachovaných identifikátorov. Telefónne čísla v bežnom prehľade sú maskované.

Čitateľné časy sa zobrazujú v zóne `Europe/Bratislava`, vrátane správneho letného alebo zimného času. Technická časť môže ponechať pôvodné ISO časy. Čas kontroly, začiatok hovoru, potvrdenie spojenia a ukončenie sú rôzne údaje. Ak chýba čas alebo dôkaz, správa ho nesmie nahradiť odhadom bez označenia.

Prostredie vychádza z identity aplikácie, nie iba z Vercel targetu. **TEST** je `https://test.dispecing.linkapomoci.sk`; technický Vercel target tohto samostatného projektu je tiež Production. Produkcia aplikácie je `https://dispecing.linkapomoci.sk`. E-mail z TESTu preto nesmie vyzerať ako produkčný incident.

## Opakovanie správ a zlyhanie doručenia

Pravidlo je najviac jedna správa o tej istej identifikovanej kombinácii problému a závažnosti za deň. Nový dotknutý hovor alebo nová konkrétna udalosť sa nesmú skryť za skoršie upozornenie rovnakého typu. Zhoršenie z `warn` na `fail` alebo nový dôvod problému môže vytvoriť ďalšie upozornenie. Pri celkových kontrolách bez identity hovoru zostáva deduplikácia podľa typu kontroly, závažnosti a dňa. Samotná zmena veku problému alebo poradia výsledkov nesmie vytvárať novú správu pri každom päťminútovom behu.

Ak príjemca nie je nastavený, odosielanie je vypnuté alebo provider odoslanie odmietne, správa sa nesmie uložiť ako úspešne odoslaná. Ďalší beh má možnosť pokusu po odstránení príčiny. Prijatie správy e-mailovým providerom ešte nepreukazuje doručenie do schránky. Chyba zápisu evidencie po prijatí správy providerom sa musí hlásiť; opakovanie využíva stabilný idempotency key, jeho účinok však závisí aj od poskytovateľa.

## Overenie a hranice nasadenia

Zmena používa existujúci `/api/telephony/cron` s rozvrhom `*/5 * * * *`. Nepridáva ďalší cron, worker, listener ani SQL migráciu. Nemá meniť smerovanie fungujúcich hovorov alebo povoľovať produkčné zdroje v TESTe.

Bezpečné overenie na stabilnom TESTe:

1. Priradiť čerstvé nasadenie k očakávanému `dev` commitu a overiť `/api/health/live` aj `/api/health/ready`.
2. Existujúci autentifikovaný `GET /api/telephony/health` overí nasadenú diagnostiku bez zámerného volania či odoslania správy. Bearer token patrí iba TEST projektu a nesmie sa vypísať do výstupu. Táto cesta nepredstavuje nový provider test.
3. Na syntetických dátach skontrolovať textový aj HTML náhľad e-mailu, viacero výsledkov naraz, neúplné dôkazy, maskovanie a technickú časť. Regresné testy majú pokrývať prípady z tabuliek vyššie.
4. Rozlíšiť, čo overili automatizované testy, čo sa vykonalo na hostovanom TESTe a čo nebolo overené reálnym hovorom alebo schránkou. Samotný úspešný build nie je prebratie funkcie.

Ak TEST `CRON_SECRET` nie je dostupný na čítanie, možno overiť verejné health endpointy, odmietnutie neautorizovaného prístupu a dostupné záznamy prirodzeného plánovaného behu. To však nenahrádza obsah autentifikovanej telephony kontroly ani doručenie e-mailu. Túto medzeru uviesť v odovzdaní; kvôli skúške nemeniť tajný kľúč, nevypínať autorizáciu a nepridávať verejný testovací endpoint.

Pri overovaní e-mailového formátu **nespúšťať ručne celý cron**: obsahuje aj skutočné opravy stavu, ďalšie úlohy a odosielanie. Nepoužívať skutočný pokazený hovor alebo úmyselný zásah do databázy iba na vytvorenie ukážkového e-mailu. Reálne testovacie volanie či doručenie do schránky sú osobitné integračné kontroly s príslušným oprávnením a TEST ochranami.

Produkčné schválenie a prebratie sa riadi [release workflow](release-workflow.md), hranice prostredia [TEST runbookom](full-test-environment.md).
