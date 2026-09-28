# Ralplan: výber prichádzajúceho hovoru a upozornenie čakárne

## Výsledok a hranice

Východzí režim zostáva `ring_first`. Správca môže zvoliť `queue_first`: po existujúcej úvodnej hláške, hodinách a IVR ide prichádzajúci hovor priamo do čakárne, kde ho oprávnený dostupný operátor ručne prevezme. Pri `ring_first` môže operátor počas vlastnej aktívnej ponuky stlačiť **Do čakárne**; aktuálne ponuky sa ukončia, zákazník zostane v čakárni. Obe ručne riadené vetvy dostanú osobitné krátke upozornenie na nový čakajúci hovor a prehľadný počet čakajúcich. Tieto hovory sa samy z čakárne znovu neponúkajú.

## RALPLAN-DR

- **Princípy:** zachovať existujúci tok mimo dvoch zmien; hovory meniť iba cez súčasný stavový automat; zákazník nesmie zostať bez čakacieho audia či ukončenia; upozornenie musí jasne odlíšiť čakajúci hovor od skutočnej ponuky; nasadzovať cez izolovaný test.
- **Rozhodujúce faktory:** možnosť výberu pri súbehu; malé riziko zásahu do produkčného smerovania; zrozumiteľnosť operátorovi pri nízkom objeme hovorov.
- **Možnosť A, zvolená:** predvolené zvonenie + voliteľný manuálny režim čakárne, per-call `manual_only`, oddelený jednorazový signál. Výhoda: minimálny zásah a jasná semantika. Nevýhoda: operátor musí ručne prevziať hovor; vyvažuje ho výstraha a existujúci callback limit.
- **Možnosť B:** každý hovor v čakárni opakovane ponúkať a púšťať plné vyzváňanie. Výhoda: malé riziko prehliadnutia. Nevýhoda: hovor sa nedá slobodne vyberať a platená eskalácia môže obísť úmysel operátora; preto ju nepoužiť pre ručný režim.
- **Možnosť C:** všetky hovory vždy ukladať do čakárne. Výhoda: jednotný tok. Nevýhoda: mení doterajšie správanie bez potreby; preto ponechať prepínač s bezpečným defaultom.

## Kritériá prijatia

1. Nová organizácia aj existujúca databáza majú `ring_first`; správca uloží `queue_first` v nastaveniach a čítanie API vracia uloženú hodnotu. Iný vstup je odmietnutý. (`src/server/telephony/config-service.ts:212,338,669,2103`; `src/components/dispatch/settings/TelephonySettingsPanel.tsx`)
2. Pri `queue_first` sa po doterajšej hláške/hodinách/IVR nevytočí ponuka operátorovi; hovor sa zobrazí v čakárni, hrá jeho bežné čakacie audio a je prevzateľný dostupným oprávneným operátorom organizácie podľa súčasných pravidiel pickup, aj keď nie je členom pôvodného ring plánu. Platí aj pri dvoch súčasných hovoroch alebo chýbajúcom/prázdnom pláne; bez dostupného operátora dôjde bezpečne k doterajšiemu callback limitu. `ring_first` s prázdnym plánom si zachová okamžitý callback. (`src/server/telephony/state/transitions.ts:906,1150`; `src/server/telephony/call-actions.ts:736`)
3. Stlačenie **Do čakárne** odošle povinné presné `callControlId` vlastnej, stále zvoniacej ponuky. Pod session lease musí reducer overiť aktéra, otvorený neprevzatý operator leg, neterminálny attempt a `ringing`/`plan` stav; potom ukončí otvorené ponuky a presunie iba tento hovor do čakárne. Po prijatí, po ukončení, pri cudzej ponuke alebo pri oneskorenom kliknutí na už nahradenú ponuku API odmietne akciu 409. (`src/components/dispatch/PhoneBar.tsx:100`; `src/server/telephony/call-actions.ts:651`; `src/server/telephony/state/transitions.ts:2306`)
4. Ručne riadené čakajúce hovory sa automaticky znovu neponúkajú ani neeskalujú na záložné číslo. Doterajšia fallback čakáreň sa správa ako predtým; pri limite čakania sa ponúkne callback. (`src/server/telephony/state/transitions.ts:1150,1203,2162`)
5. Dostupný oprávnený operátor uvidí nový čakajúci hovor so zreteľným počtom a aplikácia sa pokúsi prehrať jeden krátky odlišný zvuk, ak je zvuk povolený a prehliadač ho po používateľskom geste dovoľuje. Pri blokovanom audiu zostane trvalý viditeľný stav a voliteľný push. Obnovenie stránky, ďalší polling alebo druhá otvorená karta ten istý hovor neprehrá znovu; pri aktívnom skutočnom vyzváňaní sa signál neprekrýva. Krátke zvýraznenie potom ostane statické, bez nekonečného blikania. (`src/components/dispatch/LiveCallOverview.tsx:170`; `src/server/telephony/call-notifications.ts:55,150`)

## Postup

1. Pridať malú aditívnu migráciu `inbound_call_mode` s predvolenou hodnotou `ring_first`, typ v DB a validačné čítanie/zápis nastavenia. Zistiť stav migrácií testu/produkcie pred akýmkoľvek SQL pushom.
2. Rozšíriť reducer o `queue_first` na začiatku plánu a o akciu `defer` viazanú na povinné konkrétne `callControlId`. `metadata.queue.manual_only` vypína auto-offer a platenú eskaláciu, no necháva bežné audio/timeout. Push pre túto vetvu cielený na oprávnených dostupných operátorov organizácie; bežná čakáreň zostáva bez zmeny. Prepínač platí od vstupu hovoru do plánu zvonenia po IVR; rozbehnutý plán/čakáreň zostávajú zmrazené.
3. Pridať jeden endpoint akcie a dve malé ovládania: **Do čakárne** pri zvoniacej ponuke a prepínač v nastaveniach. Čakáreň zvýrazniť viditeľným počtom, prípadne jemným krátkym pulzom; žiadne intenzívne blikanie.
4. Pridať jednorazový odlišný chime pre nový waiting session ID, baseline pri prvom načítaní, deduplikáciu medzi kartami a rešpektovanie zvukových nastavení. Zamedziť dvojitému zvuku s push alebo priamym vyzváňaním. Krátke vizuálne zvýraznenie prejde do statického výstražného stavu.
5. Overiť stavové scenáre v harness testoch, API bezpečnosť, UI model testy, `pnpm test`, `pnpm typecheck`, `pnpm build`. Potom test DB migrácia, work branch Preview, PR do `dev`, test hostname, aditívna produkčná migrácia, PR `dev`→`main` a smoke test domény. Schéma musí predbehnúť produkčný kód. Nikdy nenasadzovať starší Vercel build.

## Riziká a ochrana

- **Závod medzi prijatím/odložením:** API overuje konkrétne `callControlId` aktuálnej ponuky pod existujúcim session lease; reducer odmietne neplatný prechod. Test pokryje aj oneskorený klik po novej ponuke tomu istému operátorovi.
- **Strata hovoru v čakárni:** čakacie audio, viditeľný počet, opt-in push, callback po limite; žiadny automatický dial v ručnom režime.
- **Dvojité signály:** zvuk viazať na nový identifikátor volania a koordinovať karty cez Web Locks; rešpektovať nastavenie zvuku a stav priamych hovorov. V starom prehliadači bez Web Locks je lokálne úložisko len best-effort deduplikácia, takže dve karty môžu výnimočne prehrať dva krátke tóny.
- **Blokované audio v prehliadači:** netvrdiť, že zvuk je garantovaný bez používateľského gesta; hlavička zostane viditeľná a v skrytom okne môže fungovať už existujúci opt-in push.
- **Migrácie sa líšia:** pred aplikáciou porovnať skutočnú schému a históriu; použiť iba cielenú migráciu na autorizovanom projekte, nie plošný `db push`, ak drift pretrváva.

## Overenie po nasadení

Na test doméne overiť build, pripojenie k test Supabase a nastavenie oboch režimov bez skutočných provider hovorov. Na produkčnej doméne overiť release SHA, čítanie nastavenia a pripravenosť endpointov bez spustenia živých hovorov. Hovorové toky preukázať testami stavového automatu; živé volania len v koordinovanom prevádzkovom teste s klientom.
