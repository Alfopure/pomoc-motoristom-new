# Obnova nejasného ukončenia prichádzajúceho hovoru

Táto oprava rieši zákaznícku vetvu prichádzajúceho hovoru s `writer_contract = 2`, uloženým zámerom ukončenia a nedokončeným príkazom `app.hangup`. Ak sa odpoveď Telnyxu stratí, úloha zostáva uložená aj vtedy, keď neskôr príde pôvodné HTTP 2xx. Bežné prvé úspešné ukončenie nepridáva overovací GET.

## Postup a hranice

1. Každé ďalšie spracovanie tejto relácie pod platným vlastníctvom znovu vyhodnotí uloženú úlohu a pôvodný provider journal. Zablokuje iba jej dokončenie bez dôkazu; ukončenie ostatných vetiev môže pokračovať.
2. Overí presnú zákaznícku vetvu u poskytovateľa. V TESTe ešte pred GET vyžaduje preukázaný pôvod v samostatných TEST zdrojoch; samotný skopírovaný identifikátor nestačí. Overené upratanie funguje aj po vypnutí vytvárania nových TEST hovorov.
3. Ak vetva stále žije, povolí najviac **dva dodatočné pokusy** na obnovovanú pôvodnú úlohu. Každý má vlastný deterministický interný journal záznam, ale odošle pôvodnú cestu, telo a pôvodné `command_id`. Pôvodný záznam sa neprepisuje na nový pokus.
4. Medzi pripravenými pokusmi je najmenej **30 sekúnd**. Pri 429 sa rešpektuje aj uložený `Retry-After`; tento opravný request má vypnuté okamžité opakovanie v HTTP klientovi. Jednoznačné odmietnutie vrátane chýb oprávnenia ďalší POST nepovolí. Stratená odpoveď z prípravy pokusu nesmie vytvoriť tretí slot.
5. Po vyčerpaní pokusov zostáva overovanie a incident otvorený. Bez platného dôkazu sa stav neoznačí ako obnovený. Všetky operácie zostávajú ohraničené existujúcim vlastníctvom a časovým rozpočtom požiadavky.

Telnyx opisuje idempotentný `command_id` pri [Hangup call](https://developers.telnyx.com/api-reference/call-commands/hangup-call) a odporúča pri nejasnej odpovedi opakovať totožný príkaz v [Command Retries](https://developers.telnyx.com/docs/voice/programmable-voice/command-retries). Našich 30 sekúnd a dva sloty sú vlastné konzervatívne limity aplikácie. Dokumentácia [Receiving Webhooks](https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks) uvádza duplicity, zmenené poradie udalostí a 60-sekundové okno potláčania duplicitných príkazov; preto sa nespoliehame na neobmedzenú deduplikáciu poskytovateľa.

## Dôkaz ukončenia

Dokončenie vyžaduje presný overený `call.hangup` po odoslaní príkazu alebo úspešný GET s rovnakým `call_control_id` a skutočnou boolean hodnotou `is_alive: false`. Vrátené identifikátory vetvy a relácie nesmú odporovať uloženým identifikátorom. Čas udalosti sa porovnáva aj s mikrosekundami databázového záznamu.

HTTP 2xx príkazu, 404/422 zo stavového GET, chýbajúce či neúplné dáta, lokálne `ended_at` ani syntetická udalosť bez overeného pôvodu takým dôkazom nie sú. Pri stavovom dôkaze runner najprv uloží terminálny fakt vetvy a až potom dokončí pôvodnú úlohu. Pád medzi týmito krokmi ponechá obnoviteľnú povinnosť. `false` z journal result RPC sa nepovažuje za úspešný zápis bez opätovného overenia aktuálneho záznamu.

Obnova môže prebehnúť pri ďalšej udalosti alebo existujúcom priechode relácie. Záloha je existujúci päťminútový `/api/telephony/cron`; nejde o záruku okamžitého ukončenia ani pevnej päťminútovej lehoty pri výpadku či vyčerpaní rozpočtu. Oprava nepridáva SQL migráciu, worker, listener ani ďalší plánovač.

## Monitoring a zásah

- `inbound_hangup_*` loguje kategóriu výsledku, počet opravných pokusov a vek povinnosti. `backoff`, `provider_unknown`, `retry_pending`, `retry_exhausted`, `rejected` a `unavailable` znamenajú nedokončenú obnovu.
- Úspech iného hovoru neuzavrie globálny incident `telephony.telnyx.commands`, kým existuje nedokončený explicitný hangup v ukončovanej relácii. Kontrola beží iba pri otvorenom incidente, s existujúcim 60-sekundovým obmedzením na jednu bežiacu inštanciu; nová chyba môže toto obmedzenie zrušiť.
- Načíta sa najviac 101 kandidátov. Viac než 100 kandidátov, chyba čítania alebo nerozpoznaný formát povinnosti zachová incident otvorený. Uzavretie porovná identitu, stav, čas a počet chýb incidentu, aby nevymazalo súbežne zaznamenanú chybu. Nejde o atomický snapshot všetkých hovorov.
- Pri opakovanom `retry_exhausted` alebo `rejected` skontrolovať presnú reláciu, provider stav, journal a oprávnenia; nemať vyriešenie založené len na zelenom health alebo manuálnom zmazaní pending úlohy. Pre nezávislé problémy Sentry či všeobecné timeouty táto oprava nedokazuje odstránenie príčiny.

## Overenie a prebratie

Lokálne testy s riadenými chybami sú v `src/server/telephony/inbound-hangup-recovery.test.ts`, `inbound-hangup-monitoring.test.ts`, `state/inbound-hangup-deferred-effects.test.ts` a súvisiacich journal/incident testoch. Rozlišujú nevykonaný príkaz od vykonaného príkazu so stratenou odpoveďou, neskoré 2xx, dva sloty, 429, odmietnutie, stratenú odpoveď prípravy, cudzie TEST zdroje a uloženie terminálneho faktu pred dokončením.

Toto sú lokálne simulované poruchy. Nepotvrdzujú živý zvuk, skutočnú odozvu tlačidla ani doručenie externého e-mailu. **Čerstvé manuálne prebratie finálneho kandidáta na [stabilnom TESTe](https://test.dispecing.linkapomoci.sk) zostáva otvorené.** Pri odovzdaní doplniť skutočne nasadený `dev` SHA a deployment ID. Overiť prichádzajúci hovor, prijatie, podržanie/obnovenie a ukončenie z oboch strán; porovnať čas kliknutia, skutočné odpojenie a príslušné udalosti/logy. Umelé výpadky sa nevyvolávajú na produkcii.

Produkčné schválenie ani autorizáciu SQL tento dokument neposkytuje. Nasadenie sa riadi [release postupom](release-workflow.md).
