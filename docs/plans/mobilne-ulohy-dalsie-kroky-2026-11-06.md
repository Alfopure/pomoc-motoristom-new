# Mobilné úlohy — ďalšie kroky

Plán z 6. 11. 2026, na pokyn majiteľa „ok, napíš si plán na to“.
Stav: **realizácia spustená** na pokyn majiteľa „poď na to“ v tomto rozhovore.
Hotové etapy a výsledky sa označia až po príslušnom overení.

## Cieľ a rozsah

Dokončiť doručenie jednoduchých mobilných úloh a postupne pridať upozornenia,
výbery Dnes / Po termíne, fotky, checklist a opakovanie. Každý aktívny zamestnanec
môže zadať úlohu kolegovi alebo pobočke; jej aktuálny vedúci ju prevezme alebo
pridelí. Základný formulár ostane krátky: názov, príjemca, voliteľný termín.
Checklist a opakovanie budú pod **Ďalšie možnosti**, fotka bude voliteľná akcia.

Poradie dodania: **TestFlight → upozornenia → filtre → fotky → checklist → opakovanie**.
Každá etapa má vlastné overenie a môže byť doručená samostatne. Nedržať hotové
upozornenia kvôli neskoršiemu opakovaniu úloh.

## Overený východiskový stav

- Základ úloh je v PR [#591](https://github.com/Alfopure/pomoc-motoristom-new/pull/591),
  zlúčenom do `dev` ako `1a261b23c3a32d0246e45d543fb7705de512bcf1`.
  Podľa odovzdania v tomto rozhovore bol tento commit overený na stabilnom TESTe
  vrátane vytvorenia, prevzatia, pridelenia a dokončenia cez skutočné API.
  Toto je historický záznam, nie nové overenie aktuálneho nasadenia.
- Nový natívny build s týmito úlohami zatiaľ nebol nahratý. Posledný v rozhovore
  overený dostupný TEST build bol 36; kontrolu ďalšieho buildu zablokoval Mac
  a simulátor. Pred pokračovaním znovu zistiť aktuálny stav, nevychádzať zo starých
  čísel buildov. Postup: [natívny build](../mobile/local-ios-build.md#L112).
- Mobilné zoznamy, formulár a detail už existujú v
  [ui.tsx](../../mobile/src/tasks/ui.tsx#L86); termín aj označenie omeškania v
  [presentation.ts](../../mobile/src/tasks/presentation.ts#L10).
  Pribudnú skutočné filtre, nie len ďalšie farebné označenie.
- Serverový vstup a overovanie aktuálnej identity sú v
  [employee-tasks.ts](../../src/server/mobile/employee-tasks.ts#L113),
  spoločný dátový kontrakt v [mobile-task-workspace.ts](../../src/lib/mobile-task-workspace.ts#L16).
  Zachovať existujúcu históriu, kontrolu úloh, revízie a bezpečné opakovanie zápisov.
- Existujúce push udalosti úloh používajú kancelársku identitu príjemcu:
  [push-events.ts](../../src/server/mobile/push-events.ts#L23).
  Nová etapa musí pokryť aj terénneho používateľa a aktuálnych vedúcich pobočky.
  Využiť existujúci [outbox](../../src/server/mobile/push-outbox.ts) a jediný
  [päťminútový cron](../../src/app/api/telephony/cron/route.ts#L25).
- Otvorenie push správy rozlišuje terénne moduly v
  [taps.ts](../../mobile/src/notifications/taps.ts#L1); ponuka typov upozornení je v
  [kinds.ts](../../mobile/src/notifications/kinds.ts#L5).
  Samotné doručenie preto nebude dôkazom správneho otvorenia úlohy.

## 1. Dokončiť TestFlight so základnými úlohami

**Práca:** obnoviť dostupnosť Macu, overiť aktuálne `dev` a stabilný TEST, pripraviť
čistý zdroj a zostaviť podpísanú TEST aplikáciu. Zachovať predchádzajúce IPA,
archívy a symboly. Overiť podpis, TEST server/databázu, vložené nové rozhranie
a štart podľa [existujúceho postupu](../mobile/local-ios-build.md#L112).
Výnimky pre staršie konkrétne buildy sa neprenášajú automaticky.
Po nahratí overiť Apple processing a dostupnosť konkrétneho buildu aj Martinovi.

**Hotovo, keď:**

- [ ] Je zaznamenaný zdrojový commit, číslo buildu, kontrola IPA a výsledky štartu.
- [ ] Apple potvrdí dostupnosť správneho buildu testerom; bežiaci upload nestačí.
- [ ] Na iPhone sa otvorí modul Úlohy, vytvorí úloha kolegovi aj pobočke a vedúci
  vykoná prevzatie/pridelenie; výsledok sa potvrdí aj v druhom prihlásení.
- [ ] Zostáva overené oddelenie TESTu a produkcie.

## 2. Upozornenia na pridelenie, komentár a termín

**Práca:** rozšíriť existujúci tok udalostí a outbox na kanonickú identitu
zamestnanca. Priradenie oznámiť riešiteľovi; nepridelenú pobočkovú úlohu aktuálnym
oprávneným vedúcim. Komentár oznámiť oprávneným účastníkom úlohy okrem autora;
pri prevzatej úlohe už nerozosielať správy všetkým vedúcim. Doplniť nastavenia
a registráciu zariadenia pre účet, ktorý má iba úlohy, bez udelenia prístupu
k prípadom. Upozornenie otvorí nový detail úlohy v oboch typoch účtu.

Navrhovaný jednoduchý predvolený režim termínu: jedna pripomienka **30 minút
pred termínom**; ak úloha vznikne neskôr, pripomenúť pri termíne. Nepridávať sériu
opakovaných výziev. Presný režim potvrdiť v návrhu danej etapy a zachovať už uložené
pripomienky starých úloh. Využiť existujúce spracovanie; nezakladať ďalší cron.

Miesta zmien: [push-events.ts](../../src/server/mobile/push-events.ts#L23),
[task-notifications.ts](../../src/server/task-notifications.ts),
[push-outbox.ts](../../src/server/mobile/push-outbox.ts),
[taps.ts](../../mobile/src/notifications/taps.ts#L1),
[kinds.ts](../../mobile/src/notifications/kinds.ts#L5),
[registrácia zariadení](../../src/server/mobile/push.ts).
Potrebné zmeny uloženia a autorizácie navrhnúť až po kontrole aktuálnej schémy.

**Hotovo, keď:**

- [ ] Pridelenie, komentár a pripomienka sa overia pre dispečera aj vodiča bez
  dispečerského profilu; nepridelená pobočková úloha upozorní iba svojich vedúcich.
- [ ] Odobraté členstvo, zmena riešiteľa, dokončenie a zmena termínu potlačia
  neaktuálne čakajúce doručenie. Opakovanie zápisu ani behu cronu neposiela duplicity.
- [ ] Vypnuté upozornenia sa rešpektujú; zamknutá obrazovka nezobrazuje citlivý
  obsah úlohy. Autor nedostane upozornenie na vlastnú akciu.
- [ ] Ťuknutie funguje pri otvorenej, uspanej aj ukončenej aplikácii; po odobratí
  oprávnenia sa obsah nesprístupní. Výpadok siete zachová bezpečné opakovanie.
- [ ] Je oddelene doložené prijatie poskytovateľom a skutočné doručenie/otvorenie
  na iPhone. Pri termínoch sa počíta s päťminútovým intervalom spracovania;
  presný čas zobrazenia operačným systémom sa nesľubuje.

## 3. Rýchle výbery Dnes / Po termíne

**Práca:** pridať výbery do existujúcej obrazovky zoznamu bez ďalšej navigácie.
Kombinovať ich s Moje / Pobočka / Zadané mnou, hľadaním a existujúcou kontrolou
úloh. Filter vykonať na serveri pred stránkovaním; nevylučovať úlohy iba z práve
načítanej stránky. Použiť časové pásmo organizácie; overiť jeho aktuálne nastavenie.

Miesta zmien: [zoznam](../../mobile/src/tasks/ui.tsx#L86),
[prezentácia termínu](../../mobile/src/tasks/presentation.ts#L10),
[mobilný klient](../../mobile/src/tasks/api.ts),
[serverový vstup](../../src/server/mobile/employee-tasks.ts),
[kontrakt](../../src/lib/mobile-task-workspace.ts#L30).

**Hotovo, keď:**

- [ ] Dnes obsahuje otvorené úlohy s termínom v danom miestnom dni, Po termíne
  otvorené úlohy s uplynutým termínom. Úlohy bez termínu sa do nich nedostanú.
- [ ] Dokončené úlohy zostávajú pod Hotové; existujúca kontrola zostáva dostupná.
- [ ] Výsledky sú správne aj na ďalších stránkach, o polnoci a pri zmene letného
  času. Prepnutie filtra zahodí starý kurzor a neukáže odpoveď predchádzajúceho výberu.
- [ ] Výbery sú čitateľné a ovládateľné na 320/390 bodoch aj so zväčšeným písmom.

## 4. Fotka k úlohe a výsledku

**Práca:** pridať voliteľné **Pridať fotku** z fotoaparátu alebo galérie do zadania
a detailu. Umožniť popis výsledku s fotkou pri dokončení bez povinného fotografovania.
Preskúmať opätovné využitie existujúcich
[uploadov](../../mobile/src/field-work/upload-files.ts#L11), ale neprebrať oprávnenia
iného modulu. Navrhnúť súkromné uloženie príloh viazané na organizáciu a úlohu,
limity veľkosti/počtu, kompresiu a čistenie nedokončených uploadov.

**Hotovo, keď:**

- [ ] Fotka sa pridá z oboch zdrojov, zobrazí sa náhľad a úspešný upload sa potvrdí.
  Zamietnuté povolenie alebo veľký súbor majú zrozumiteľný stav.
- [ ] Prerušený prenos možno bezpečne zopakovať bez duplicitnej prílohy; pôvodný
  koncept ostane zachovaný. Neúspešný upload sa neoznačí ako uložená fotografia.
- [ ] Úlohu možno vytvoriť/dokončiť aj bez fotky. Cudzia organizácia ani používateľ
  bez prístupu nezískajú prístup k prílohe; odkazy nie sú verejné.
- [ ] Odstránenie prílohy a upratanie opustených uploadov sú overené s aktuálnou
  autorizáciou a ohraničeným spracovaním cez existujúcu infraštruktúru.

## 5. Checklist pod Ďalšie možnosti

**Práca:** jednoduché pridanie, úprava, odstránenie a odškrtnutie bodov; v detaile
ukázať napríklad **2 z 5 hotové**. Body sú súčasťou jednej úlohy a nemajú vlastného
riešiteľa, termín ani ďalšie vnáranie. Navrhované správanie: nedokončené body pri
dokončení úlohy vyžiadajú jasné potvrdenie, neodškrtnú sa potichu.

Miesta zmien: [formulár/detail](../../mobile/src/tasks/ui.tsx#L139),
[uloženie rozpracovanej práce](../../mobile/src/tasks/store.ts),
[príkazy](../../src/server/mobile/employee-tasks.ts),
[kontrakt](../../src/lib/mobile-task-workspace.ts#L45).

**Hotovo, keď:**

- [ ] Funguje vytvorenie aj úprava bodov, počítadlo a potvrdenie nedokončených bodov.
- [ ] Úloha bez checklistu má rovnaký krátky formulár a bežné dokončenie ako doteraz.
- [ ] Súbežná úprava alebo opakovaný zápis nestratí cudzie zmeny ani nevytvorí
  duplicitné body; koncept sa obnoví po zatvorení aplikácie podľa existujúcich pravidiel.

## 6. Opakované úlohy pod Ďalšie možnosti

**Práca:** v prvej verzii ponúknuť iba **Neopakovať / Denne / Týždenne** s časom
a pri týždni dňom. Jedna séria má príjemcu alebo pobočku, časové pásmo a možnosť
pozastavenia. Každý výskyt je samostatná úloha s vlastnou históriou a stavom.
Zmena série ovplyvní budúce výskyty, neprepíše vyriešenú históriu.

Použiť existujúci [cron](../../src/app/api/telephony/cron/route.ts#L25) s časovým
rozpočtom a limitom práce; nevytvárať ďalší scheduler ani worker. Pred implementáciou
navrhnúť jednoznačnú identitu výskytu a transakčné vytvorenie. Navrhovaný režim
po výpadku: najviac jeden aktuálny výskyt, nie hromadná tvorba historických úloh.

**Hotovo, keď:**

- [ ] Denná/týždenná séria vytvorí správny výskyt aj pri zmene letného času;
  súbežné a opakované behy vytvoria práve jednu úlohu daného výskytu.
- [ ] Pozastavenie zastaví budúcu tvorbu a zachová históriu. Neplatný príjemca
  nevytvorí úlohu bez zodpovednosti; séria zrozumiteľne ukáže potrebu úpravy.
- [ ] Dokončenie minulého výskytu nemení ostatné. Úprava série je odlíšená od
  úpravy jednej úlohy; po výpadku nevznikne lavína úloh a upozornení.
- [ ] Existujúce cron úlohy sa nevyhladujú a zachová sa jediný povolený cron.

## Spoločné overenie a vydanie

1. Pred každou etapou prečítať aktuálne `dev`, schému a relevantné oficiálne
   dokumenty/changelog; aktualizovať používané Supabase skills. Konkrétne API,
   SQL, limity a migrácie tento plán nepredpisuje bez overenia.
2. Zachovať existujúce dizajnové tokeny a
   [mobilný štandard](../mobile/design-standard.md). Prístup k modulom zostáva
   prezentácia; každé čítanie/zápis/príloha musí prejsť serverovým oprávnením.
3. Cielené testy správania, autorizačné a súbehové scenáre, potom typy/lint,
   existujúce build brány a skúšky UI na 320/390 bodoch. Kontrolovať aj staré úlohy
   na webe a staršiu mobilnú verziu; nová funkcia nesmie zrušiť kompatibilitu.
4. Pracovná vetva → PR do `dev` → stabilný
   [TEST](https://test.dispecing.linkapomoci.sk) → overenie commitu a zmeneného
   správania. Natívne zmeny doručiť novým TEST buildom podľa existujúcej brány.
5. Výsledok každej etapy zapísať s commitom, buildom, dôkazmi a neoverenými bodmi.
   Pred produkciou vyžiadať súhlas majiteľa s konkrétnym overeným rozsahom podľa
   [release workflow](../operations/release-workflow.md).

Databázové/storage zmeny sa najprv pripravia lokálne. Pred každým vzdialeným
zápisom pomenovať presný projekt a overiť autorizovaný rozsah: TEST
`nzpnqdstvkfncflgqlny`, produkcia `ifpaeegaesdmljfkdvcn`. Tento plán sám nespúšťa
migrácie, konfiguráciu providerov ani produkčný release. Existujúce oprávnenia
a už dané súhlasy zostávajú platné pre svoj konkrétny rozsah.

## Riziká a riešenia

| Riziko | Riešenie |
| --- | --- |
| Mac/simulátor stále nie je dostupný | Najprv obnoviť a overiť build prostredie; reportovať natívnu medzeru, nezamieňať webový test za štart iPhone aplikácie. |
| Rozosielanie celej kancelárii alebo bývalému riešiteľovi | Kanonický príjemca, aktuálne členstvo a oprávnenia overené aj tesne pred odoslaním. |
| Duplicity po výpadku | Stabilné identity príkazov, udalostí, uploadov a výskytov; testy opakovania a súbehu. |
| Únik fotiek alebo údajov z push správy | Súkromné prílohy, serverová autorizácia a obmedzené odkazy; stručný push bez obsahu úlohy. |
| Nesprávny deň alebo lavína opakovaných úloh | Časové pásmo, testy hraníc dní/DST, ohraničené dobehnutie a cron rozpočet. |
| Preplnený mobilný formulár | Základ ostane názov/príjemca/termín; rozšírenia sú voliteľné a rozbaliteľné. |

## Priebeh realizácie

| Etapa | Stav |
| --- | --- |
| 1. TestFlight | Základný build 38 podpísaný/overený; natívny štart zablokoval systémový simulátor a spojenie s Macom. Rozšírený build zatiaľ nie je zostavený. |
| 2. Upozornenia | Implementované a overené databázovo/API; fyzické doručenie a otvorenie pushu ešte čaká na iPhone. |
| 3. Dnes / Po termíne | Overené na TESTe a v Expo UI vrátane časového pásma, stránkovania a DST testov. |
| 4. Fotky | Živý TEST upload/čítanie/odstránenie aj zákazy prístupu prešli; kamera na iPhone zostáva neoverená. |
| 5. Checklist | Overené API/UI a súbehovými testami; zachované aj overené automatické zdrojové dokončenie. |
| 6. Opakovanie | Implementované; TEST API a lokálne SQL overenie opakovania, CAS a ohraničeného spracovania prešli. |

Priebežné pracovné dôkazy a checkpointy sú v `.context/task-extensions/`.
Implementácia a výsledky sú v [odovzdaní](../mobile/task-extensions-2026-11-06.md). Tabuľka nenahrádza chýbajúcu natívnu/fyzickú akceptáciu.
