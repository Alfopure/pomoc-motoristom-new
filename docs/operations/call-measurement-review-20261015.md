# Kritická kontrola merania a opráv — 15. 10. 2026

Pôvodné vyhodnotenie nebolo dostatočne presné na vyhlásenie, že celý hovor spĺňa požadovanú rýchlosť. Čas HTTP požiadavky bol zmeraný, ale skrátený opis „presun do čakárne 12,48 s“ mu pripísal širší význam. Ani úspešné automatické testy, health alebo syntetická odpoveď 404 neoverujú zvuk, živé nahrávanie ani celý proces prijatia.

## Čo nezávislá opätovná kontrola podkladov potvrdila

Kontrola bola vykonaná znovu tým istým agentom; nie je to nezávislý ľudský alebo druhý agentský posudok. Nezávislé boli zdroje: monotónne browserové meranie, serverové runtime logy, presné zákaznícke/providerové vetvy z read-only TEST databázy a priame čítanie troch udalostí Sentry. Overené hovory sú TEST `30318685-aaf4-4083-90fa-1f3d6bf94aef` (10:51 UTC, staršia verzia) a `a02622ee-41aa-40b4-8a96-08b4031ee629` (12:29 UTC, `7648b0c`). Nesmú sa zamieňať s dnešnou novšou nasadenou verziou.

| Záver | Kritické hodnotenie |
| --- | --- |
| Parkovanie trvalo 12,48 s | Potvrdený čas serverovej odpovede; browser 12,59 s. Provider začal prehrávanie už približne po 2,93 s. Pôvodný skrátený opis bol nesprávne široký. |
| Prijatie bolo hotové za 486 ms | Potvrdená aktivácia operátorského SDK. Nejde o dôkaz obojsmerného zvuku zákazníka; providerový bridge je ďalší krok. |
| Prevzatie z čakárne bolo hotové za 4,23 s | Potvrdená odpoveď API. Providerový bridge nastal približne 7,42 s po vstupe požiadavky. |
| Podržania 3,88 / 4,85 s | Časy API. Provider spustil podržanie/prehrávanie približne 3,17 / 3,75 s po serverovom vstupe. Meranie neobsahuje dobu zámerného ponechania na podržaní. |
| Položenie 352,5 ms | Iba prijatie HTTP 202. Zákaznícky hangup provider zaznamenal približne 1,55 s po vstupe požiadavky; ďalšie spracovanie udalostí trvalo dlhšie. |
| Tri Sentry chyby znamenajú tri výpadky hovoru | Nie. Všetky tri eventy patria tomu istému hovoru/verzii a korelujú s obsadeným zámkom pri konferenčných callbackoch. Neskoré spracovanie je potvrdené; samotný počet chýb nedokazuje počet prerušených rozhovorov. |
| DB je dokázaná jediná príčina | Nie. Transportné čakanie a súbeh zámkov sú potvrdené, presná infraštruktúrna príčina ani efekt zvýšenia kapacity dokázané nie sú. DB/provider/vnorené časy sa nesčítavajú. |
| Staršia oprava zaručene zrýchlila hovory | Nie. Regresné testy dokazujú konkrétne obmedzenie čakania a obnovu bez opakovania príkazov. Jeden telefonát pred a jeden po zmene pri odlišnom stave DB nie sú porovnávací experiment. |
| Nahrávanie je funkčne overené | Nie. Overená bola konfigurácia a izolovaný formulár s reálnym TEST API, bez uloženia. Skúšaný hovor nahrávku nevytvoril. Prepis, súhrn a hodnotenie sa tým neotestovali. |
| Historické priemery sú úplné SLA | Nie. DB diagnostika zvýhodňuje pomalé/chybné udalosti, TEST obsahuje kópiu starších produkčných dát a audity runnera nemajú hranice HTTP ani zvuku. |

Providerové a serverové nástenné hodiny nie sú spoločné monotónne hodiny. Uvedené rozdiely sú približné a nie sú meraním akustického doručenia. Čas medzi začiatkom čakárne a ďalším kliknutím je obchodný pobyt/reakcia, nie technická latencia. API môže dobiehať počas už spusteného prehrávania; tieto intervaly sa prekrývajú.

## Nájdené chyby a zmeny v meraní

1. Report vyradil celý riadok pri chýbajúcom/neplatnom čase, čím sa stratila aj známa chyba z počtu výsledkov. Teraz zachová výsledok a samostatne počíta chýbajúcu latenciu; nevkladá nulu.
2. SDK párovanie obsahovalo verziu prijímajúceho servera. Nasadenie medzi doručeniami rozdelilo ten istý monotónny pár. Teraz rozhoduje stránka a vetva; odlišné klientské verzie alebo nejednoznačný životný cyklus sa nepovažujú za platný pár.
3. Opakované manuálne prijatie tej istej vetvy sa v pamäťovej fronte zlučovalo. Po chybe prvého pokusu mohol report zahrnúť ľudské čakanie pred druhým pokusom. Teraz každý pokus ostane a viac pokusov sa vykáže ako nejednoznačné meranie. SDK notifikácie zostávajú deduplikované.
4. Browserový limit 120 s ticho vyraďoval dlhšie konečné pozorovania, napríklad po oneskorení časovača. Teraz sa dlhé konečné hodnoty zachovajú a neplatné lokálne vzorky zvýšia počet strát. Timeout má vlastnú distribúciu a stále znamená iba dolnú hranicu čakania.
5. Verzia servera prijímajúceho diagnostiku neidentifikovala pôvodnú kartu ani server meranej požiadavky. Zber teraz prenáša `clientBuild`, `requestBuild` a pomocné nástenné časy. Chýbajúca historická identita ostane neznáma. Pri timeoute tela sa zachová už prijaté request ID a verzia odpovede.
6. Staré SDK pole `environment=development` sa nesprávne interpretovalo ako prostredie aplikácie, hoci označovalo aj TEST telefónne prostriedky. Bez `appEnvironment` už report neháda.

Nové regresné prípady zahŕňajú konkrétne chybné vstupy: 503 bez času, zrušenie bez času, telo odpovede po hlavičkách, timeout po hlavičkách, dlhé meranie, dva pokusy o prijatie oddelené ľudským čakaním, doručenie cez dve nasadenia a starý TEST identifikátor. Súčasťou kontroly sú aj pôvodné testy vlastníctva, checkpointov, obnovy projekcie a webhookov.

Zber nepridáva DB tabuľku, zapisované merania, nový časovač, worker ani cron. Využíva existujúci obmedzený transport. Autentifikácia endpointu a korelácia SDK udalostí však majú DB čítania; tvrdenie „nulová databázová záťaž“ by bolo nesprávne. Zatvorená karta, preplnená fronta alebo ukončená funkcia stále môžu stratiť merania. Dlhodobé úplné pokrytie nie je týmto release zabezpečené.

## Ako sa majú rozhodovať ďalšie opravy

1. Pred zásahom zmraziť verziu, prostredie, presnú akciu a hranice: klik/odoslanie → HTTP odpoveď; klik prijatia → aktívne SDK; odoslanie → presne korelovaná providerová udalosť; samostatne prvý obojsmerný zvuk. Nevydávať jednu metriku za druhú.
2. Uchovať počty pokusov, neúspechov, timeoutov, nejednoznačných párov a strát spolu s distribúciami. Uviesť pôvod a úplnosť exportného okna. Syntetické akceptačné požiadavky označiť konkrétnymi ID a vylúčiť z reálnych hovorov.
3. Rýchlejšiu obnovu konferenčných callbackov overovať na aktuálnej aj starej konferencii, presnej vetve, duplicitách, zmenenom poradí a súbežnom hangup. Samotné doplnenie názvov udalostí do zoznamu ani potlačenie Sentry nie sú postačujúca oprava.
4. DB optimalizovať až podľa jednotlivých sekvenčných krokov pred účinkom príkazu a po ňom. Nevynechávať vlastníctvo, trvalý journal, nahrávacie bariéry alebo ochranu pred opakovaním providerovej mutácie. Jednosekundový rozpočet projekcie rieši iba jej časť, nie celý parkovací handler.
5. Na rovnakom kandidátovi zopakovať živé prijatie, podržanie/obnovenie, čakáreň/prevzatie a položenie, s nahrávaním aj bez neho. Vyhodnotiť zhodné metriky pred/po pri bežnej aj zhoršenej dostupnosti DB. Malá séria pomôže odhaliť chyby, ale nepotvrdzuje p95/p99 ani SLA.
6. Funkčné nahrávanie, prepis a AI vyhodnotiť na skutočne vytvorenej nahrávke oboch strán s overeným uložením, dokončeným prepisom a príslušnými výsledkami. Pripravený checkbox alebo health nenahrádza tento dôkaz.

Tento opravný balík mení pozorovanie a vyhodnotenie, nie providerové riadenie hovoru. Zostávajúce oneskorenia konferenčných udalostí a úplné funkčné overenie nahrávania tým nie sú vyhlásené za opravené. Produkčný release vyžaduje samostatné schválenie identifikovaného rozsahu podľa AGENTS.md.
