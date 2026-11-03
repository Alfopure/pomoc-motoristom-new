# Jednoduchý test prvej fázy: hovor → prípad → pristavovač → poloha → dokončenie

Stav: **checklist na budúce testovanie; výsledky zatiaľ nie sú vyplnené**. Realizačný rozsah je v [prehľade prvej fázy](../rollout/mobile-phase-one-2026-10-24.md). Majiteľ spoločné fyzické testovanie výslovne odložil na neskôr.

Cieľ skúšky: potvrdiť, že dvaja ľudia dokážu cez mobil a web prijať a odovzdať prácu, sledovať jej priebeh a polohu a korektne ju dokončiť. Ide o základný dispečerský cyklus. Fotoprotokol auta, nájom, Final CD, účtovníctvo a Erosove odťahy majú vlastnú ďalšiu akceptáciu.

## Pred začiatkom

- Použijeme **https://test.dispecing.linkapomoci.sk** a aplikáciu **Dispatching TEST** na dvoch fyzických iPhonoch.
- Dvaja ľudia sa prihlásia pod **dvoma rozdielnymi TEST účtami**: D = dispečer, P = pristavovač. D má otvorený aj web; P má samostatný prístup k pristaveniam. Rovnaký účet na oboch telefónoch nestačí na overenie odovzdania a práv.
- Na doplnkovú skúšku prepojenia pripravíme ešte druhého dostupného TEST dispečera K na webe. Nepotrebujeme tretí iPhone. Volanie hlavného scenára sa môže uskutočniť z telefónu P cez bežný telefónny číselník; pred prácou P v appke ho ukončíme.
- Zaznamenáme skutočný serverový commit a číslo buildu **z Účtu na každom iPhone**. Pilotná verzia musí obsahovať dohodnuté opravy flotily, obnovy prístupov a skratky odovzdania. Historický build 22 ani zdravý server nie sú potvrdením novej verzie.
- D má pripravenú TEST linku na príjem. P má zapnuté notifikácie Pristavenia a povolenú presnú polohu na pozadí. Použijeme vlastné skúšobné kontakty, dohodnutý TEST telefonický cieľ, známe auto a dve nezameniteľné miesta: kde ho vyzdvihnúť a kam ho pristaviť.
- Pred testom sú hotové automatické kontroly a opravený build je na stabilnom TESTe. Do záznamu ani snímok nepatria heslá, tokeny či skopírované údaje zákazníkov.

Hlavný scenár orientačne 30–45 minút po príprave. Každý bod sa zapisuje ako **PASS / FAIL / NEOVERENÉ**. NEOVERENÉ sa nepočíta ako úspech.

## Hlavný scenár

| ID | Čo urobíme | Kedy bod prešiel |
| --- | --- | --- |
| T01 | D a P otvoria appku. D načíta flotilu, prejde na poslednú stránku a vyhľadá známe auto mimo prvých 200. P otvorí Moduly → Pristavenia. | Obaja vidia správne moduly; flotila sa nestratí nad 200 vozidlami, stránkovanie aj hľadanie ukážu očakávané auto. Zoznam P môže byť zatiaľ prázdny. |
| T02 | Zavoláme na TEST linku pri zamknutom iPhone D. D prijme a obe strany si navzájom povedia kontrolnú vetu. Hovor necháme otvorený pre vytvorenie prípadu v T03. | Hovor skutočne zazvoní a obe strany počujú správnu vetu. Ak súčasne zvoní web, po prijatí na iPhone už neponúka druhé prijatie toho istého hovoru. |
| T03 | D z kontextu hovoru vytvorí označený skúšobný prípad: kontakt, auto, miesto vyzdvihnutia/pristavenia, čas a pokyny. Použije Uložiť a odovzdať, vyberie P a skontroluje náhľad. Po uložení ukončíme hovor. D cez Detail hovoru → Po hovore → Priradiť k prípadu potvrdí práve uložený prípad a vráti sa k tomu istému odovzdaniu. P pripraví appku do pozadia a až potom D potvrdí odoslanie. | Existuje jeden uložený prípad a jedno odovzdanie pre P. Výslovné priradenie spojí hovor so správnym prípadom; samotný prenos telefónu do formulára nestačí. Uložené údaje sú zhodné na webe aj mobile. Pred výslovným potvrdením P nič nedostane. Po ukončení nezostane falošne aktívny hovor. |
| T04 | P má appku na pozadí. Pošleme pridelenie z T03 a P otvorí skutočnú push notifikáciu. | Notifikácia príde na fyzický iPhone a otvorí práve pridelenú kartu. P vidí správne auto, klienta, miesta, čas a pokyny. Samotná značka „V aplikácii“ ani ručné nájdenie karty nepotvrdzujú úspešné doručenie push. |
| T05 | P zvolí Prijať a Vyrážam. D sleduje ten istý záznam na webe aj v mobile. | Prevzatie a cesta sa potvrdia a zobrazia aj dispečerovi pri ďalšej bežnej obnove. „Odoslané“, „prevzaté“ a „na ceste“ zostávajú rozlíšené. |
| T06 | P zamkne iPhone a počas približne 5 minút prejde pešo niekoľko stoviek metrov. D sleduje polohu. | D uvidí aspoň **dve nové polohy telefónu P zaznamenané až po zamknutí**, s odlišnými časmi a zodpovedajúcim posunom, časom merania a presnosťou. Commander poloha auta alebo posledný bod pred zamknutím nestačia. Ak potrebný dôkaz nevznikne, bod neprešiel. |
| T07 | P zvolí Som na mieste a Auto odovzdané. Potom sa ešte krátko presunie. | D vidí dokončenie, P už nemá výkon v aktívnom zozname a dočasné klientské údaje sa skryjú. Pre tento výkon je zdieľanie vypnuté; počas ďalších 2 minút pohybu sa nepotvrdia nové body a stará poloha sa neukazuje ako aktívne sledovanie. Dokončenie pristavenia samo neuzatvára dispečerský prípad. |

T04 je pokračovaním jediného odoslania z T03: pred jeho finálnym potvrdením pripravíme telefón P do pozadia. Nezakladáme kvôli T04 druhé odovzdanie.

Vytvorenie prípadu z čísla hovoru ho automaticky nepriraďuje k histórii hovoru. T03 preto výslovne používa dnešnú akciu [Po hovore](call-wrap-up.md); nový prípad kvôli priradeniu nevytvárame. Ak návrat do rozpracovaného odovzdania stratí jeho údaje, je to chyba R3 na opravu.

## Krátke kontroly pred uzavretím fázy

| ID | Kontrola | Kedy prešla |
| --- | --- | --- |
| K1 | Dokončíme hlasové skúšky: príjem s otvorenou appkou, príjem na pozadí, podržanie/obnovenie, prepojenie na TEST dispečera K a zastavenie nahrávania na hovore, kde je zapnuté. | Každý úkon má vlastný potvrdený výsledok: obnoví sa obojsmerný zvuk, prepojenie skončí u správneho kolegu a zastavenie nahrávania je potvrdené serverom. Stav „nahrávanie nebolo zapnuté“ nie je PASS pre jeho zastavenie. Použijeme existujúcu [hlasovú akceptáciu](iphone-voice-test.md). |
| K2 | Na ďalšom označenom skúšobnom pristavení P pri aktívnom sledovaní krátko stratí pripojenie, prejde aspoň 100 metrov, zaznamená krok a potom pripojenie obnoví. Ak krok ostal nepotvrdený, zavrie/otvorí appku a overí ten istý krok existujúcou obnovou. | Po návrate siete sa **potvrdí pôvodný krok bez duplicity a úspešne sa odošlú čakajúce GPS body s časmi z obdobia výpadku**. Nevznikne druhé odovzdanie ani duplicitné prevzatie. Zrozumiteľná chyba je správna počas výpadku, ale nevyriešená obnova nie je PASS. Ak počas výpadku nevznikol GPS bod, táto časť zostáva NEOVERENÁ. Samostatne sa použijú automatické regresie straty odpovede; obyčajné vypnutie siete ju samo nedokazuje. |
| K3 | Na samostatnom skúšobnom odovzdaní overíme druhý smer (vytvorenie na webe → P), odmietnutie/problém s dôvodom a nepridelený účet. Overíme tiež obnovenie dostupných modulov po novom pridelení prístupu. | P dostane správne webové odovzdanie a D vidí dôvod odmietnutia/problému. Nepridelený používateľ kartu neprečíta cez zoznam ani priamy odkaz/API. Po obnovení oprávnení je nový modul dostupný bez reštartu; odobratie prístupu stará cache neobíde. Časť prístupových hraníc môže doložiť existujúci automatický test; zaznamená sa presný zdroj dôkazu. |

## Záznam výsledku

| Údaj | Vyplniť pri skúške |
| --- | --- |
| Dátum, testujúci | — |
| Serverový commit a deployment TESTu | — |
| iPhone D: verzia/build, iOS | — |
| iPhone P: verzia/build, iOS | — |
| Účty/roly D, P, K bez prihlasovacích tajomstiev | — |
| ID skúšobného prípadu a hlavného odovzdania | — |
| T01 / T02 / T03 / T04 / T05 / T06 / T07 | — |
| K1: jednotlivé hlasové úkony / K2 / K3 | — |
| Čas zamknutia a časy dvoch nových GPS bodov | — |
| Čas dokončenia a výsledok kontroly zastavenia GPS | — |
| Chyby a rozsah opakovanej skúšky po oprave | — |
| Ukončenie ostatných skúšobných výkonov a overenie stop GPS | — |
| Verdikt: OVERENÉ NA TESTE / NEUZAVRETÉ | — |

**Fázu označíme za overenú na TESTe, keď T01–T07 aj K1–K3 prešli, oba buildy a server sú identifikované a nezostala chyba brániaca tomuto postupu.** Pri chýbajúcom push, obojsmernom zvuku, nových GPS bodoch na pozadí, potvrdenom dokončení alebo zastavení sledovania sa fáza neuzavrie iba na základe úspešného buildu/API.

Výrok po úspešnej skúške: „Na testovaných iPhonoch a identifikovanej verzii vieme prijať hovor, uložiť prípad, odovzdať ho konkrétnemu človeku, prijať upozornenie, sledovať realizáciu a polohu aj pri zamknutí a výkon dokončiť so zastavením zdieľania.“

Potom nadväzuje Final CD a následne Erosova etapa. Produkčné vydanie a Android majú vlastné podmienky; tento TEST výsledok ich nenahrádza. Návrat k plnému fotoprotokolu a nájmu nie je podmienkou uvedeného základného cyklu.
