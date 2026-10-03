# Spoločné zvonenie a dôkazy v sonde

## Očakávané správanie

Krok s voľbou **všetci naraz** vyhodnotí dostupnosť členov na začiatku a ponúkne hovor všetkým vybraným zariadeniam naraz, najviac na nastavený čas kroku. Pri 20 sekundách po skončení poslednej ponuky pokračuje ďalší krok alebo záložné číslo. Operátor, ktorý sa pripojí počas zvonenia, nezačne ďalšie celé 20-sekundové kolo v tom istom kroku. To isté platí pre člena vynechaného pre limit súčasných volaní.

Ak ešte nevznikla žiadna ponuka a chýba kapacita, existujúce ohraničené čakanie na kapacitu zostáva zachované. **Postupné** zvonenie stále poskytuje každému členovi jeho vlastný čas. Ak všetci odmietnu skôr, systém pokračuje skôr; timeout je maximum. Ak chýba koncový webhook poskytovateľa, ostáva existujúca päťsekundová tolerancia a obnova cez sweep. Čas úvodnej hlášky ani doručenia provider príkazu nie je súčasťou 20-sekundového okna.

Pre jednu osobu môžu súčasne existovať samostatné ponuky do webového SIP telefónu a na výslovne nakonfigurované vlastné mobilné číslo. Kým zvoní niektoré zariadenie, rezervácia operátora zostáva zachovaná. Toto nie je potvrdenie zvuku Web Push na zamknutom mobile. Pred aktivovaním viacerých zariadení treba [kompatibilnú databázovú schému](parallel-operator-ringing.md).

## Sonda

Nové hovory ukladajú `normalized_payload.routing` do existujúceho auditu `motorist_call_events`. Rozhodnutie cestuje aj s odolnou rozpracovanou operáciou, takže obnova používa pôvodný výber. Nevzniká nový worker, cron ani ďalší sieťový zápis pred vytočením.

Záznam obsahuje čas výberu, krok a stratégiu, čas zvonenia a obnovovací deadline, vybraných aj vynechaných členov, dôvod vynechania, stav dostupnosti, registráciu, vek heartbeat a kapacitné limity. Ukončenie spoločného kola a prechod na zálohu majú vlastný záznam. Neobsahuje telefónne čísla, SIP mená ani prihlasovacie údaje. Jeden záznam má najviac 64 členov; počet vynechaných detailov je uvedený. Jeden prechod uchováva posledných 32 rozhodnutí.

Manager/admin ich nájde v časovej osi hovoru v Monitore prevádzky. Panel číta iba audit vlastnej organizácie a konkrétneho hovoru, s obmedzeným rozsahom a časovým rozpočtom. Neúplné alebo nedostupné údaje označí. Audit bez priradeného `call_id` nemusí byť v paneli dostupný. Historický hovor bez nového záznamu sa spätne nedopĺňa odhadom.

**Výber na zvonenie nie je dôkaz, že mobil vydal zvuk.** Rozhodnutie treba porovnať s výsledkom provider príkazu, udalosťami konkrétnej vetvy a fyzickou skúškou telefónu. Ani vytvorený záznam push notifikácie sám nedokazuje jej doručenie alebo zvuk.

## Preberacia skúška na TESTe

Použiť iba [kanonický TEST](https://test.dispecing.linkapomoci.sk), pripravené TEST provider zdroje a schválené vlastné čísla. Zapnutie hlasových gates bez overeného čísla a callbackov nie je skúška. Stav `live_calls_enabled=false` bol zistený pri príprave 3. októbra 2026; pred skúškou overiť aktuálny stav.

1. Dvaja dostupní členovia, spoločný timeout 20 s, záložné číslo: oba dostupné telefóny zvonia v jednom kole, záloha nasleduje po jeho konci. Overiť obojsmerný zvuk po prijatí.
2. Jeden webový telefón nepripojený pri začiatku, pripojený počas kola: sonda ukáže pôvodné vynechanie a nespustí druhé kolo. Záloha nesmie čakať ďalších 20 s.
3. Vlastný web + mobil jedného operátora: skúsiť prijatie na oboch zariadeniach v samostatných hovoroch, ukončenie prehrávajúcej vetvy a rezerváciu do konca poslednej ponuky.
4. Refresh nastavení notifikácií: počas načítania neukazovať vymyslené zapnutie/vypnutie; po načítaní overiť uložený stav.
5. SMS na schválené vlastné číslo: porovnať aplikačný výsledok, provider doručenie a skutočne prijatú správu. Pri definitívnom odmietnutí vznikne opraviteľná chyba; pri neurčitom výsledku nevytvárať duplicitné odoslanie. Výnimka príjemcov ostáva výlučne v TESTe.

Zapísať commit a deployment z `/api/health/live`, ID nových TEST hovorov/správy, čas a výsledok každej skúšky. Automatické testy s falošným providerom ani zdravý deployment nenahrádzajú živé audio.

## Pripravenie produkcie bez odstavenia aplikácie

Produkcia čaká na výslovný pokyn majiteľa po TESTe. Pred vydaním znovu porovnať celý `dev → main` diff s otestovaným commitom. Pripravený PR a úspešný build gate skracujú vydanie, nezaručujú okamžité dokončenie Vercel deploymentu.

Najprv nasadiť kompatibilný kód. Pre aktiváciu viacerých zariadení je na produkčnom projekte **`ifpaeegaesdmljfkdvcn`** potrebná výlučne migrácia **`20261008130300_parallel_operator_ring_endpoints.sql`**; TEST ju už má. Táto presná produkčná SQL zmena musí byť súčasťou schválenia. Nespúšťať ostatné čakajúce migrácie ani seed.

Pred migráciou overiť ukončenie aktívnych hovorov, otvorených ponúk a rozpracovaných efektov, nový produkčný commit a absenciu starých writerov na webhookoch. V transakcii nastaviť `lock_timeout = '1s'` a `statement_timeout = '5s'`, potom vykonať presný obsah migrácie. Pri obsadenom zámku alebo prekročení času transakcia skončí bez aktivácie schémy; kompatibilná aplikácia môže ďalej pracovať s pôvodnou schémou. Overiť aj zápis do registra migrácií a všetky nové indexy/constrainty.

Migrácia vyžaduje krátky výlučný zámok tabuľky, preto nemožno sľúbiť absolútne nulové blokovanie. Nevykonávať ju cez aktívny hovor a nečakať neobmedzene na zámok. Po migrácii nevracať starý binárny kód, ktorý nerozlišuje konkrétne zariadenia; opraviť dopredu s kompatibilnou implementáciou. Overiť kanonickú produkčnú verziu, zdravie a schválenú funkčnú skúšku.
