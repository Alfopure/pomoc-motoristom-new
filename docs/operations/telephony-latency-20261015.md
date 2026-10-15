# Spomalený TEST hovor 15. 10. 2026

Majiteľ po teste požiadal o opravu prijatia, podržania a čakárne. Rozsah je stabilný TEST (`test.dispecing.linkapomoci.sk`); produkčná akceptácia ani databázová migrácia nie sú súčasťou tejto opravy.

## Potvrdený priebeh

Hovor `30318685-aaf4-4083-90fa-1f3d6bf94aef`, začiatok **10:51:29 UTC**, nasadený `dev` **80ee310255e5aac3fa9c666004504e5da00f5770**. Podklady: Vercel runtime logy, read-only TEST Supabase ledger, provider journal, PostgreSQL/PostgREST/edge logy a Sentry udalosti z 10:50–10:56 UTC.

| Operácia | Pozorovanie |
| --- | --- |
| Prevzatie | HTTP požiadavka približne 7,5 s. |
| Potvrdenie prijatia operátorom | Webhook trval 49,4 s, z toho držanie session lease 24,5 s. Bridge bol poskytovateľom prijatý už o 10:52:04.961. Následný zápis výsledku webhooku trval 22,8 s. |
| Podržanie | 503 po chybe získania session lease; nejde iba o pomalú animáciu. |
| Čakáreň | HTTP požiadavka 26,6 s, prvý provider príkaz až po približne 22,7 s; 43 databázových požiadaviek. |
| Poskytovateľ | Pozorované relevantné HTTP príkazy Telnyx približne 0,2–0,6 s. To nemeria kvalitu zvuku. |
| Obnova udalostí | Časť callbackov sa spracovala až v existujúcom crone okolo 10:55. |

Databáza bola pomalá aj mimo telefonovania: úlohy, callback queue a zariadenia mali požiadavky s trvaním približne 20–23 s. PostgREST tesne pred hovorom hlásil timeouty a opätovnú inicializáciu poolu/cache. PostgreSQL zaznamenal čakanie na zámky session riadku. Presná príčina spomalenia infraštruktúry, napríklad CPU alebo dostupné kredity, **nie je týmito logmi dokázaná**. Sentry obsahuje aj chybu načítania callback queue z tej istej nasadenej verzie; názov `CallActionError` sám neidentifikuje konkrétny stlačený ovládací prvok.

Automatická osobná PSTN ponuka smerovala na rovnaké číslo ako prichádzajúci zákazník. Je to samostatná chyba smerovania. Používateľom hlásená ozvena nie je týmto dôkazom vysvetlená: treba odlíšiť spätné zvonenie od akustickej spätnej väzby medzi dvoma zariadeniami.

## Oprava

- Callback s čerstvo zistenou obsadenou session a dostupným retained maintenance nevykonáva opakované pokusy o ten istý zámok. Najprv sa musí bezpečne uložiť odložená udalosť. Novovytvorená session sa z tejto skratky vylučuje, pretože vrátený riadok môže obsahovať vlastný už uvoľnený lease.
- Súbežné odložené callbacky tej istej session na jednej inštancii zdieľajú čítanie a dospracovanie. Každá HTTP požiadavka drží spoločný promise. Medzi inštanciami zostávajú autoritou databázové claims a fences; nevzniká nový worker ani cron.
- Už oddeliteľná projekcia histórie a audit po potvrdených príkazoch majú pri ovládaní spoločný rozpočet jednej sekundy. Nedokončená práca ostáva v durable continuation, ďalšie ovládanie ju môže preskočiť a existujúca obnova ju dokončí s rozpočtom štyroch sekúnd. Kritický stav, journal, nahrávacie bariéry a finálny checkpoint sa týmto rozpočtom nevynechávajú.
- Claim/finish webhook RPC majú limit 4 s. Timeout sa transportom zachová ako abort, aby knižnica nespustila ďalšie skryté pokusy o čítanie.
- Strata vlastníctva serializovaná PostgRESTom sa nerozbalí na obyčajnú definitívnu chybu. Udalosť ostáva opakovateľná a prijatý bridge sa pri obnove znovu nevykoná.
- Automatické PSTN zvonenie a opakované ponuky nevytáčajú číslo prichádzajúceho volajúceho. Jeho aplikácia môže zvoniť ďalej; ostatné čísla ostávajú dostupné.

## Overenie a akceptácia

Regresné testy pokrývajú skutočný PostgREST transport so zaseknutým zápisom, následný UNHOLD, obnovu histórie/auditu, neopakovanie mutácií poskytovateľa a nahrávania, desať súbežných retained drains s neskorým pripojením a obnovu po strate lease za už prijatým bridge. Test desaťčlennej čakajúcej skupiny potrebuje dve spoločné čítania ledgeru a žiadne acquire RPC počas obsadenia. Testy smerovania overujú normalizované čísla a opakovanú aplikačnú ponuku bez volania na vlastné číslo zákazníka.

Po nasadení treba porovnať live release SHA s novým `dev`, overiť pripravenosť TEST databázy a zopakovať **reálny** telefonát: prijatie → podržanie → obnovenie → čakáreň → prevzatie → ukončenie, s nahrávaním aj bez neho. Pri ozvene použiť slúchadlá alebo fyzicky oddelené zariadenia a zaznamenať, na ktorej strane ju počuť. Súčasne porovnať HTTP latenciu, čas prvého príkazu, DB timeouty a oneskorené udalosti.

Tieto zmeny znižujú aplikáciou zosilnené čakanie; nezaručujú rýchlu telefonickú službu počas výpadku databázy. Ak široké 20-sekundové DB spomalenia pretrvajú aj po oprave, ďalší krok je kontrola metriky a udalostí TEST Supabase infraštruktúry, prípadne rozhodnutie majiteľa o kapacite. Bez tohto merania nemožno označiť platený upgrade za dokázanú opravu.
