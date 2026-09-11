# Oneskorenia telefonovania — zistenia a oprava z 11. 9. 2026

## Záver

Používateľom hlásené čakanie 15–20 sekúnd je doložené. Problém nie je iba v zobrazení: pri prichádzajúcich hovoroch je v dátach rozdiel medzi zdvihnutím operátora a potvrdeným spojením 10,04–21,68 s. Odchádzajúce volanie sa oneskoruje hlavne pred vytvorením zákazníckej vetvy; keď už zákazník zdvihol, šesť doložených automatických spojení trvalo 0–0,42 s.

Audit pokrýva všetkých 31 dnes evidovaných session tejto kópie: 22 odchádzajúcich, 9 prichádzajúcich, 67 vetiev, 340 unikátnych prijatých webhookov a 421 aplikačných udalostí. Z webhookov bolo 311 označených processed, 15 failed a 14 queued. Neúspešné/nedokončené udalosti zasiahli 14 session. To sú stavy v čase exportu, nie tvrdenie, že všetkých 14 hovorov bolo úplne bez zvuku.

Prvá sada opráv je pripravená v pracovnej vetve. Nejde o tvrdenie, že latencia po zmene už bola zmeraná na živom hovore. Databázové dáta, migrácie a nastavenia Telnyxu sa počas auditu nemenili.

## Príčiny, istota a zmena

| Priorita | Doloženie / mechanizmus | Pripravená zmena |
|---|---|---|
| P0 | 10 udalostí call.answered a 1 gather boli odmietnuté kvôli nahrávaciemu zámku, ďalšie 4 udalosti kvôli session zámku. Spracovanie zlyhalo, ale webhook dostal HTTP 200. Claim sa dal prevziať až po 30 s od jeho získania; záložný replay je v päťminútovom crone. | Nevykonaná udalosť pri nedostupnom zámku dostane 500 a jej vlastný claim sa uvoľní pre okamžité opakované doručenie. Rovnako sa riešia zlyhania úvodného čítania snapshotu/smerovania. CAS chráni claim novšieho spracovateľa. Hotový duplikát zostáva 200; súbežne spracúvaná control udalosť dostane 500. |
| P0 | Hold a transfer najprv čakali na hlášku a ďalší webhook. Doložený transfer effect začal +15,881 s po serverovej požiadavke, hold effect +29,457 s. Aj pri vypnutých úvodných hláškach sa tieto prevádzkové hlášky vynucovali. | Pri nenahrávaných hovoroch hold, pokračovanie, parkovanie, presmerovanie, konzultácia a pridanie účastníka pokračujú v pôvodnej požiadavke bez voliteľnej hlášky. TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED=true umožňuje pôvodné správanie. Rozbehnutá hláška a ochrany existujúceho nahrávania zostávajú dokončené. |
| P1 | Pred prvým answer sa načítavalo IVR, ring plány a dostupnosť operátorov; tieto dáta využíva až nasledujúce call.answered. Na poslednom hovore začal answer effect až 9,671 s po udalosti príchodu. | call.initiated vynechá čítania potrebné iba na výber smerovania. Nasledujúce call.answered naďalej overuje pracovný čas, menu, smerovanie a kapacitu. Udalosti s rozbehnutou obnovou zachovajú úplný kontext. |
| P1 | Bridge/hold/hangup vyvolávali čítania a zápisy účastníckych intervalov pre nahrávky, aj keď session mala nahrávanie trvalo vypnuté. Tieto operácie predlžovali obsadenie zámku a spracovanie nasledujúcich udalostí. | Evidencia nahrávania sa preskočí iba pri explicitne vypnutej zmrazenej politike bez jediného recorderu alebo rozbehnutej ochrany. Existujúce aj neisté nahrávky naďalej uzatvárajú účastnícke intervaly. |
| P1 | Päťsekundový Telnyx timeout sa zrušil po prijatí HTTP hlavičiek; čítanie tela odpovede už nemalo deadline. Toto je chyba v kóde, jej konkrétny výskyt počas dneška nie je doložený. | Deadline teraz pokrýva hlavičky aj celé telo odpovede vrátane 429. Existujúci jeden retry zostáva; celá požiadavka vrátane retry môže trvať dlhšie než 5 s. |
| P1 | Po strate realtime spojenia zostal bežať pôvodný pomalý časovač pollingu až 10/30 s. Chýbala okamžitá spätná väzba pri čakaní na mikrofón pred odpoveďou. Dnešné browser spany nie sú k dispozícii. | Zmena realtime spojenia okamžite obnoví snapshot a nahradí časovač. Tlačidlo ukazuje Prijímam… už počas kontroly mikrofónu, potláča dvojité kliknutie a viaže prijatie na konkrétny hovor. |
| P1 | Vercel logy mali effect_ms vrátane databázovej práce, ale existujúci Telnyx HTTP logger nebol zapojený. | Bez blokovania hovoru sa logujú method, anonymizovaná path, commandId, ms, status, retried, errorCode pod scope telnyx-http. Bez tiel, identifikátorov ovládania hovoru, čísel, tokenov a surových chýb. |

Posledná už nasadená oprava d139925 pomohla s predčasným ukončením funkcií a časťou zámkov. Po nej však nové dva prichádzajúce hovory stále mali zdvihnutie operátora → bridge 19,20 s a 10,04 s. Všetky štyri nové session mali nahrávanie vypnuté cez start_announcements_disabled. Samotné vypnutie nahrávania alebo predĺženie timeoutu preto nie je kompletné riešenie.

## Ako má ústredňa reagovať

Kliknutie má mať okamžitú viditeľnú odozvu. Po potvrdení zdvihnutia má mať prioritu spojenie hlasových vetiev; po zavesení ukončenie hovoru. Pridanie účastníka má ihneď začať prípravu/vytáčanie, stav sa má potvrdiť skutočnou udalosťou od providera. Informácie do histórie, notifikácie a voliteľné hlášky nemajú vytvárať ďalšie povinné kolá spracovania pred týmito úkonmi.

Telnyx dokumentuje neusporiadané a opakované doručovanie; idempotencia musí pokrývať event_id aj command_id. Pri outbound podporuje bridge_on_answer + link_to, takže spojenie nemusí čakať na ďalší roundtrip cez našu aplikáciu. Odporúča rýchle potvrdenie webhooku a samostatné spracovanie. Potvrdiť 200 a potom stratiť udalosť bez spoľahlivej obnovy tento cieľ nespĺňa. Prvá oprava preto zachováva existujúcu architektúru a obnovuje pravdivé retry správanie pri známych deferraloch; nesľubuje úplnú asynchrónnu frontu.

Oficiálne zdroje: [Voice API webhooks](https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks), [prijímanie webhookov](https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks), [Dial / bridge_on_answer](https://developers.telnyx.com/api-reference/call-commands/dial), [Bridge a životnosť vetiev](https://developers.telnyx.com/api-reference/call-commands/bridge-calls), [WebRTC call options / localStream](https://developers.telnyx.com/docs/voice/webrtc/js-sdk/interfaces/icalloptions).

## Čo ešte vyžaduje meranie alebo ďalšiu úpravu

1. **Sériové databázové kroky pred provider príkazom.** Persistencia session, vetvy, ring attemptu, presence a histórie má viac HTTP roundtripov. Na poslednom hovore je answer operátora o 17:13:28.495, bridge effect až o 17:13:38.355. Výsledky pg_stat_statements sú celoživotné, priemer lease SQL približne 1–2 ms; nejde o dôkaz dnešnej latencie databázovej siete. Nové HTTP meranie umožní určiť zvyšok. Následná optimalizácia má zlúčiť potrebné atomické zápisy a odložiť nepotrebnú evidenciu za kritickú akciu; bez oslabenia vlastníctva hovoru. Ak bude vyžadovať SQL/RPC migráciu, ide o samostatné výslovne vyžiadané nasadenie.
2. **Prijatie odchádzajúcej operátorskej vetvy čaká na celú odpoveď POST.** Zákaznícka vetva vznikala 8,83–25,01 s po uložení session. Udržať overenú koreláciu konkrétnej vetvy, zmenšiť prácu po dial pred odpoveďou; neprijímať náhodný invite podľa čísla alebo časového okna.
3. **Sériové vytáčanie ring skupiny a cleanup pred bridge.** Ďalší operátor môže odpovedať, kým predchádzajúca požiadavka ešte drží zámok pri vytáčaní zvyšných členov. Playback/gather stop sú stále pred bridge. Zmena ich poradia musí mať overenú Telnyx media semantiku a regresný test; nebola urobená naslepo.
4. **Rýchle zavesenie počas rozbehnutej inej operácie.** PhoneBar blokuje zavesenie počas inej busyAction. Jednoduché odomknutie tlačidla môže súbežne spustiť zavesenie a pridanie účastníka. Potrebná je explicitná prednosť ukončenia a zrušenie staršej operácie na serveri aj v prehliadači.
5. **Prehliadač a mobil.** Pred answer sa mikrofón kontroluje, uvoľní a SDK ho znovu otvára; mobil môže po nečinnosti obnovovať registráciu. Je to potenciálna ďalšia latencia, nie dôkaz dnešnej konkrétnej chyby. Doplniť neblokujúce spany click → microphone → HTTP → invite → answer → active → audio playing.
6. **Doručenie a obnova u providera.** Priamy Telnyx CDR, webhook-deliveries export a paketový/WebRTC trace neboli v dostupných prístupoch. Account konfigurácia v repozitári nie je živé overenie portálu. Ledger s attempts=1 nehovorí, koľkokrát Telnyx skutočne doručoval; počíta získané claims. Stav päťminútového replayu treba overiť na jeho per-job výsledku, nie iba HTTP 200 cronu. Nebol spustený mutujúci cron ani prehrané historické webhooky proti živým dátam.

## Overenie a postup nasadenia

Automatické overenie pokrýva opakovanie rovnakého eventu po zámku/prechodnom čítacom zlyhaní, ochranu novšieho claimu, okamžité nenahrávané ovládanie, nahrávacie STOP bariéry, timeout streamovaného tela a reálny hook/PhoneBar v izolovanom prehliadači. Prešli všetky aplikačné testy, doplnková Node test sada, TypeScript, Next.js build a 25 izolovaných browser scenárov. Build a testy neuskutočňujú živé hovory.

Pracovná vetva má rovnaký východiskový obsah ako aktuálny dev; pridelený názov zostáva zachovaný. Nasadenie opravy ide cez work-branch Preview a PR do dev, následne samostatný release dev → main. Tento audit neupravuje Supabase schému, seed ani live konfiguráciu a nenasadzuje worker/listener.

Pred produkčným potvrdením treba vykonať riadené testy na vlastných testovacích číslach: inbound answer, outbound, dve súčasné odpovede, pickup čakajúceho hovoru, hold/unhold, konzultácia/transfer, pridanie účastníka, zavesenie počas oneskoreného POST a strata/obnova realtime. Overiť obojstranný zvuk a neprítomnosť osirelých vetiev. Návrh akceptačných cieľov: viditeľná reakcia na kliknutie do 100 ms; p95 od potvrdeného zdvihnutia po bridge do 2 s; od prijatia akcie serverom po odoslanie kľúčového provider príkazu do 2 s. Ide o ciele pre test, nie už dosiahnuté čísla. Ľudské zvonenie, prvé udelenie mikrofónu a mobilné znovupripojenie sa vykazujú samostatne.

---

# Príloha: všetkých 31 hovorov — 11. 9. 2026

Rozsah: výhradne Telnyx kópia aplikácie. Deň Europe/Bratislava začína 10. 9. 22:00 UTC. Vercel súhrny majú pevný koniec 11. 9. 16:45 UTC (18:45 CEST); databázové exporty boli získané počas rovnakého auditu. Všetky časy nižšie sú miestne CEST, UTC+2.

Zistenia potvrdzujú výrazné oneskorenia vo vlastnom spracovaní hovorov. Posledná oprava d139925 sa dostala do produkcie v nasadení 94c7ad5, READY o 16:49:37.850 CEST. Aj po nej zostali prichádzajúce hovory s oneskorením zdvihnutie operátora → potvrdený bridge 19.20 s a 10.04 s. Nulový počet neskorších 504 preto neznamená rýchle hovory.

## Ako čítať merania

- `wait_seconds` obsahuje zvonenie, ľudské čakanie a frontu; nie je to samostatné meranie chyby aplikácie.
- Operátor → bridge používa `answered_at` a `bridged_at` tej istej operátorskej vetvy. Pri odchádzajúcom hovore zahŕňa aj čakanie, kým zdvihne zákazník. Pri prichádzajúcom hovore ide o podstatne užitočnejší ukazovateľ pripojenia po zdvihnutí operátora.
- Zákazník → bridge uvádzame iba pre odchádzajúce hovory: existujúce merania 0.00–0.42 s ukazujú, že samotné automatické spojenie Telnyxu vie byť rýchle.
- Štart → zákaznícka vetva je rozdiel uloženého začiatku session a prvého `initiated_at` zákazníckej vetvy. Nie je to presný čas kliknutia v prehliadači; zahŕňa prípravu a zdvihnutie operátorskej vetvy.
- `processed_at − received_at` je oneskorenie spracovania webhooku, nie zvukového spojenia. `processing_ms` je čas aplikačného runnera; `effect_ms` obsahuje aj databázové operácie a nemožno ho označiť za samostatnú latenciu Telnyxu.
- Chýbajúci `bridged_at` znamená chýbajúce potvrdenie v týchto dátach; sám osebe nedokazuje, že hovor nemal zvuk. Stav `ended` znamená ukončenie session, nie úspešný rozhovor.
- F/Q = udalosti stále označené `failed` / `queued` v exporte webhook ledgeru. Nejde o počet všetkých chybných pokusov ani o počet používateľských kliknutí.

## Všetky hovory

| Začiatok | Session | Smer | Koncový dôvod | DB wait s | Štart → zákaznícka vetva s | Operátor → bridge s | Zákazník → bridge s | F/Q |
|---|---|---|---|---:|---:|---:|---:|---:|
| 08:53:58 | `59740c24` | odch. | failed: operator_busy | 1 | vetva nevznikla | — | — | 0/0 |
| 08:54:15 | `24397a8b` | odch. | caller_hangup | 16 | 10.48 | nepotvrdené | — | 0/0 |
| 08:56:16 | `b6954e40` | odch. | neuvedený | 15 | 9.97 | nepotvrdené | — | 0/0 |
| 09:24:46 | `e46f5e3c` | odch. | caller_hangup | 13 | 8.83 | nepotvrdené | — | 0/0 |
| 09:50:53 | `5f33abfb` | odch. | operator_hangup | 34 | vetva nevznikla | — | — | 1/0 |
| 09:51:49 | `de5a55c2` | odch. | abandoned_in_queue | 19 | 14.78 | 14.52 | 0.22 | 0/0 |
| 13:56:25 | `85500ad5` | prích. | operator_hangup | 309 | — | — | — | 3/1 |
| 14:08:02 | `4492cc3f` | prích. | caller_hangup | 35 | — | — | — | 0/0 |
| 14:10:26 | `515e0994` | prích. | caller_hangup | 91 | — | — | — | 0/2 |
| 14:13:30 | `4969ede3` | odch. | failed: operator_busy | 1 | vetva nevznikla | — | — | 0/0 |
| 14:16:56 | `b9230b96` | prích. | operator_hangup | 19 | — | — | — | 0/0 |
| 15:12:07 | `15e284db` | odch. | caller_hangup | 20 | 9.29 | 16.96 | 0.42 | 0/0 |
| 15:31:50 | `9b07a709` | odch. | operator_hangup | 49 | vetva nevznikla | — | — | 1/0 |
| 15:33:46 | `97f4549a` | odch. | operator_hangup | 46 | vetva nevznikla | — | — | 1/0 |
| 15:34:43 | `04d96e8f` | odch. | busy | 30 | 11.69 | nepotvrdené | — | 0/0 |
| 15:42:45 | `d8bde40a` | prích. | caller_hangup | 49 | — | nepotvrdené | — | 1/1 |
| 15:44:33 | `760d6bb6` | odch. | operator_hangup | 107 | vetva nevznikla | — | — | 1/0 |
| 15:50:08 | `86d358dc` | odch. | operator_hangup | 14 | vetva nevznikla | — | — | 1/0 |
| 16:04:19 | `b10ec2f7` | odch. | caller_hangup | 19 | 10.04 | 15.68 | 0.18 | 0/0 |
| 16:05:43 | `0749a8e2` | odch. | operator_hangup | 51 | vetva nevznikla | — | — | 1/0 |
| 16:05:49 | `6d62dab3` | odch. | operator_hangup | 60 | vetva nevznikla | — | — | 1/0 |
| 16:07:39 | `a79f318f` | odch. | caller_hangup | 18 | 12.86 | 12.54 | 0.18 | 0/0 |
| 16:11:47 | `2a8a6444` | prích. | caller_hangup | 191 | — | nepotvrdené | — | 4/4 |
| 16:17:32 | `0bc8ac41` | prích. | neuvedený | 53 | — | 21.68 | — | 0/1 |
| 16:23:22 | `5a6a4202` | odch. | operator_hangup | 29 | 25.01 | 23.82 | 0.00 | 0/2 |
| 16:28:07 | `6dec6e23` | odch. | neuvedený | 26 | 18.39 | 19.76 | 0.08 | 0/3 |
| 16:31:08 | `ba99632f` | odch. | operator_hangup | 48 | 19.63 | nepotvrdené | — | 0/0 |
| 16:51:07 | `a2b42959` | odch. | operator_hangup | 26 | 14.85 | nepotvrdené | — | 0/0 |
| 16:53:42 | `7dbe83b8` | odch. | operator_hangup | 16 | 16.25 | nepotvrdené | — | 0/0 |
| 16:57:34 | `4da0bea6` | prích. | caller_hangup | 56 | — | 19.20 | — | 0/0 |
| 17:12:46 | `71bc0e5f` | prích. | caller_hangup | 42 | — | 10.04 | — | 0/0 |

## Súhrny pred posledným nasadením a po ňom

Kohorty delíme podľa začiatku session voči 16:49:37.850 CEST. Ide o malé a rozdielne vzorky; nepredstavujú kontrolovaný výkonnostný experiment.

| Ukazovateľ | Pred nasadením | Po nasadení |
|---|---:|---:|
| Počet session | 27 | 4 |
| Session s failed/queued webhookom | 14 | 0 |
| Failed udalosti | 15 | 0 |
| Queued udalosti | 14 | 0 |
| Odchádzajúce session bez zákazníckej vetvy | 9 | 0 |
| Štart odchádzajúceho hovoru → zákaznícka vetva | n=11; medián 11.69 s; p95 22.32 s; max 25.01 s | n=2; medián 15.55 s; p95 16.18 s; max 16.25 s |
| Prichádzajúci: operátor zdvihol → bridge | n=1; medián 21.68 s; p95 21.68 s; max 21.68 s | n=2; medián 14.62 s; p95 18.74 s; max 19.20 s |
| Odchádzajúci: zákazník zdvihol → bridge | n=6; medián 0.18 s; p95 0.37 s; max 0.42 s | n=0 |
| Runner udalostí poskytovateľa | n=211; medián 8.61 s; p95 24.98 s; max 42.76 s | n=49; medián 11.56 s; p95 25.23 s; max 29.68 s |
| Čakanie na session lease | n=211; medián 2.80 s; p95 4.15 s; max 5.55 s | n=49; medián 3.11 s; p95 3.74 s; max 4.08 s |

## Konkrétne zlyhania a pomalé operácie

- Session `2a8a6444` (16:11:47): 4 failed a 4 queued webhooky. Vercel zaznamenal prevzatie `/pickup` s HTTP 503 o 16:13:53 a 16:14:27. Následné spracovanie `call.initiated`, `call.playback.ended`, `call.gather.ended` a `call.hangup` zlyhalo na zámku session; doby 17.532 / 22.858 / 25.466 / 10.491 s. Všetky štyri chybné spracovania boli odpovedané HTTP 200. To sa musí hodnotiť podľa ledgeru a správania hovoru, nie iba HTTP úspešnosti.
- V 11 udalostiach sa objavila chyba „Prebieha zmena nahrávania“; zasiahla aj samotné `call.answered`. Ide o konkrétny dôkaz, že vedľajší mechanizmus nahrávania blokoval základnú prácu s hovorom. Ďalšie 4 chyby boli „Prebieha zmena hovoru“.
- Session `0bc8ac41`: aplikačné zavesenie o 16:19:09.527 začalo prvý `hangup` effect až o 16:19:32.882, teda o 23.355 s neskôr. Samotný prvý effect trval 248 ms. Týchto 23.355 s vzniklo pred spustením príslušného hangup effectu.
- Session `4da0bea6`, už po poslednej oprave: prichádzajúce `call.initiated`/answer spracovanie 21.268 s; `call.answered`/ring_fanout 24.029 s; operátorovo `call.answered`/bridge 28.054 s. Uložená operátorská vetva má zdvihnutie → bridge 19.20 s.
- V tej istej session požiadavka na presmerovanie o 17:05:20.255 najprv spustila hlášku. Skutočný `transfer` effect začal až o 17:05:36.136: +15.881 s; jeho effect trval 520 ms.
- V tej istej session požiadavka na hold o 17:06:48.721 najprv spustila hlášku. Následný `conference_create` začal po 24.051 s, `conference_join` po 25.786 s a `conference_hold` po 29.457 s. Celý následný webhook spracúval 27.209 s podľa Vercel logu. Tieto intervaly majú odlišný začiatok a nemožno ich sčítať.
- Session `71bc0e5f`, už po poslednej oprave: operátor zdvihol → bridge 10.04 s; neskoršie hangup webhooky trvali 22.150 / 27.184 / 31.221 s a stále odpovedali HTTP 200.
- Všetky štyri session po poslednom nasadení mali podľa uložených snapshotov vypnuté nahrávanie a úvodné hlášky (`start_announcements_disabled`). Zostávajúce pomalé hovory preto nemožno vysvetliť iba zapnutým nahrávaním; hold/transfer hlášky zostali samostatnou prekážkou.

## Vercel: overenie nasadení a chýb

Posledná produkcia `dpl_3oFQVeuk8G9a8G79zH8udAn9P6xU` / commit `94c7ad5` bola vytvorená 16:46:58.810 a READY 16:49:37.850 CEST v regióne `fra1`. Obsahuje opravu `d139925`. Predchádzajúca produkcia `abb6ec7` vznikla 16:00:37.732. Čas vytvorenia deploymentu sa nesmie zameniť s časom READY.

Za auditovaný deň do 18:45 CEST: 551 runtime záznamov webhook endpointu; 29 HTTP 504 (25 webhook, 2 reconcile, 2 active). Všetkých 29 má dohľadateľné individuálne záznamy: 1 o 04:20, 6 medzi 13:57–14:11, 2 o 15:43 a 20 medzi 16:11–16:29. Okrem toho 3 prevzatia a 2 supervise požiadavky s HTTP 503; 11 hangup požiadaviek s HTTP 409. Stav 409 sám osebe môže znamenať očakávaný konflikt, nie automaticky chybu.

Polling má veľký objem: 13 509 `/calls/active`, 7 473 `/calls/history`, 4 614 monitor-invitations a 4 472 heartbeat záznamov. Objem podporuje preverenie zbytočných serverových databázových roundtripov; sám osebe nedokazuje príčinu latencie.

## Limity dôkazov

Vercel neoznámil retenčné odrezanie dňa a individuálny záznam z 04:20 CEST bol dostupný. Opakovane však vypršal časový limit širokého logového dotazu, preto boli použité súhrnné počty a užšie okná. Export jednotlivých webhookov je vzorka, nie všetkých 551 záznamov. Pri limite 100 konektor vrátil aj úplne identické opakované riadky; eventové súhrny sa preto musia deduplikovať podľa event ID. Súhrn error clusters uvádza pri timeout chybe count=45 s prvým výskytom 3. 9.; to nie je počet dnešných timeoutov.

Tabuľka všetkých hovorov vychádza z úplného exportu 31 session, 67 vetiev, 421 aplikačných udalostí a 29 neukončených ledger položiek. Žiadny z týchto zdrojov nemeria presne čas od fyzického kliknutia po prvý počuteľný zvuk. Chýbajúce časy a výsledky nie sú nahradené odhadmi.

Dostupné `pg_stat_statements` sú celoživotné agregáty, nie profil dnešného testu. Nízke priemerné časy SQL lease operácií (približne 1–2 ms) nevyvracajú zdržanie na HTTP roundtripoch, čakanie na lease ani sériové aplikačné kroky. Prázdny export job_runs nedokazuje vypnutý cron, pretože cron používa priamu cestu. Samostatný kontrolný dotaz koreňového agenta do 18:50 CEST vrátil pre `/api/telephony/cron` 29 záznamov HTTP 200 a 8 HTTP 401; dotaz pre posledné nasadenie do 18:55 žiadny záznam. Táto dostupnosť/indexácia logov nestačí na záver, že cron bol vypnutý. Existujúcich 29 neukončených webhookov s jedným pokusom zároveň nepreukazuje fungujúce zotavenie.

Reprodukovateľné agregáty: `call-day-metrics.json`. Vstupy: `sessions.json`, `legs.json`, `events.json`, `fault_sessions.json`, `webhook_latency.json`, `latest_policy.json`. Vercel dôkazy: `vercel-evidence-2026-09-11.json`, `vercel-counts-2026-09-11.json`, `vercel-deployments-2026-09-11.json`, `vercel-error-groups-2026-09-11.json`, `vercel-outbound-duration-2026-09-11.json`. Exporty neobsahujú telefónne čísla ani mená používateľov.
