# Priebeh hovoru a nastavenie čakárne

Prichádzajúce hovory majú v nastavení prepínač **Nastavenie / Sledovať hovory**.
Každý hovor je samostatný štítok pri svojom vykonávanom kroku. **Priebeh** v
ústredni, detaile histórie a fronte spätných volaní používa rovnaké zobrazenie.
Pridanie ďalšieho kroku je pred záverečnou akciou postupu.

## Zobrazené fakty

- Zobrazuje sa zmrazený postup konkrétneho hovoru. Rozpracovaný návrh ho nemení.
  Rozdielne verzie a staré hovory bez podpisu majú oddelené priebehy.
- Pokus o spojenie, čakanie a rozhovor majú odlišné časy. Čas ponuky nie je
  dôkazom fyzicky počuteľného zvonenia. Prijatie ukončí čas pokusu; súbežné
  zariadenia sa nesčítavajú do čakania volajúceho.
- Aplikácia zostáva jednou voľbou nastavenia. Podrobnosti odlíšia zaznamenané
  pokusy webu, mobilnej aplikácie a osobného čísla.
- Nové prechody krokmi sa ukladajú do existujúceho session JSON pod rovnakým
  transakčným zabezpečením ako stav hovoru. Staršia alebo orezaná história je
  výslovne označená ako neúplná. Mená sa načítavajú z aktuálnych profilov;
  identitu príjemcu, číslo a časy určujú záznamy príslušného hovoru.
- Záverečná akcia sa nepovažuje za vykonanú len preto, že klient požiadal
  o callback počas skoršieho čakania. Podržanie a prepájanie po prijatí sú
  odlíšené od úvodného smerovania.
- Pri neúspešnej alebo zastaranej obnove zostane posledný známy stav a čas.
  Lokálny časovač sám nespustí ďalší krok. Odmietnutie prístupu odstráni údaje.

Čítacie endpointy `GET /api/telephony/calls/journeys?lineId=…` a
`GET /api/telephony/calls/[id]/journey` vyžadujú existujúce oprávnenie dispečera
a organizáciu prihláseného používateľa. Detail podporuje aj `identity=session`.
Nevolajú poskytovateľa ani opravné spracovanie hovorov. Vracia sa obmedzená
projekcia, nie surové provider payloady alebo prihlasovacie údaje zariadení.
Podrobnosti sa načítavajú až pri otvorení; sledovanie sa obnovuje vo viditeľnom
okne s obmedzeným intervalom. Nevzniká nový worker ani plánovač.

## Čakáreň

Voliteľné pole kroku `policy` má tvar:

```json
{ "mode": "callback", "intervalSeconds": 30 }
```

Režimy sú `music`, `announcement` a `callback`; interval je 15, 30 alebo 60
sekúnd hudby medzi dokončenými hláškami. Hudba bez hlášky interval nezobrazuje.
Chýbajúce pole zachováva pôvodnú ponuku callbacku a minútový interval. Nové
nastavenie sa zmrazí pri začiatku hovoru spolu s celým postupom.

Režimy bez callbacku neprijímajú stlačenie 1 ako žiadosť, vrátane obnovy po
chybe prehrávania. Callback režim prijíma voľbu počas hlášky aj hudby; používa
existujúce idempotentné uloženie a potvrdenie. Skryté/neplatné číslo nedostane
ponuku spätného volania. Čakáreň zostáva miestom ručného prevzatia; po jej
limite pokračuje ďalší nakonfigurovaný krok.

Nové intervaly oddeľujú hlášku od hudby. Systémová nahrávka obsahujúca celú
minútu hudby sa pri explicitnej novej politike nahradí existujúcim lokalizovaným
textom cez hlasovú službu. Vlastné nahrávky zostávajú zachované a prehrajú sa
celé; interval označuje hudbu po dohraní. Celkový limit čakárne sa pri opakovaní
hlášky neobnovuje. Pri oneskorených udalostiach zostáva existujúca obnova cez
spracovanie hovorov a päťminútový cron; zobrazenie nesľubuje presnosť udalosti
na milisekundu.

## Priorita spätných volaní

Vyžiadané volajúcim sú prvé už v databázovom výbere pred limitom stránky.
Existujúci `callbackOrigin` rozlišuje dôkaz potvrdenia od bežného zmeškaného
hovoru. Číslica, kontext a čas sú viditeľné aj bez tooltipu. Prevzatie žiadosti
operátorom zostáva oddelené od toho, kto ju vyžiadal.

Migrácia `20261011110000_callback_queue_priority.sql` pridáva dve čítacie
funkcie dostupné iba `service_role`. Každý výber obmedzuje organizácia; staré
potvrdenie sa spája len so session rovnakej organizácie. Stránkovací kurzor
zachováva mikrosekundy a revíziu poradia. Pri novej alebo povýšenej žiadosti
sa stará stránka nahradí aktuálnou prvou stránkou. Počty podľa pôvodu sú
globálne; ďalšie filtre a voľby poradia v skupine pracujú s načítanými riadkami.
Poškodený čas nespôsobí výpadok fronty a nezobrazí sa ako vymyslené potvrdenie.

SQL nemení existujúce riadky, uložené smerovanie, granty tabuliek ani provider
nastavenia. Pred nasadením aplikácie musí byť migrácia aplikovaná na príslušnú,
výslovne schválenú databázu. Na TEST `nzpnqdstvkfncflgqlny` bola na základe
súhlasu vlastníka aplikovaná ako verzia `20261004174631`. Produkčná databáza
týmto súhlasom autorizovaná nebola. Rollback na starý reader po uložení novej
politiky čakárne vyžaduje zohľadniť jeho prísnu validáciu neznámych polí.

## Overenie

Unit/harness testy pokrývajú súbeh prijatia, DTMF, timeoutu a zavesenia; zmrazené
nastavenie; opakovanie; čiastočnú históriu; izoláciu organizácií a stránkovanie.
`tests/postgres/callback-queue-priority.py` aplikuje presný SQL v dočasnej
lokálnej databáze a kontroluje aj oprávnenia, mikrosekundy, neplatné časové
pásmo a frontu s viac než jednou stranou.

`e2e/call-journey.spec.ts` používa skutočné komponenty s modelovými údajmi:
tri hovory, potvrdený prechod, zachovaný návrh, zastarané údaje, odobratý
prístup, klávesnica a úzky mobil. Tieto testy nepreukazujú živé prehrávanie
hlášky ani fyzické zvonenie; to treba rozlíšiť od overenia nasadenej obrazovky.

Dodatočné integračné overenie spája spracovanie telefonickej udalosti,
transakčný zápis a nové načítanie priebehu. Pokrýva aj okamžité ručné prijatie
v rovnakej milisekunde ako vznik operátorskej vetvy: do čakárne sa priradí
iba preukázateľne prijatá vetva, nie oneskorené prevzatie po jej limite.

`state/incoming-wait-wire.test.ts` používa skutočný Telnyx HTTP adaptér
s nahradeným sieťovým transportom. Overuje odosielané polia, dlhé čakárne,
intervaly hlášok a obnovu po chybe. Pri preukázanom zlyhaní hudby sa ďalší
pokus uskutoční najskôr po minúte počas bežného spracovania čakárne.
Celkový limit sa neposúva; stará udalosť neobnoví hudbu po zmene fázy hovoru.
Nejednoznačný sieťový timeout sám nespúšťa ďalšie prehrávanie.

`tests/postgres/call-journey-persistence.py` overuje presné existujúce SQL
funkcie v dočasnej lokálnej databáze: uloženie histórie, atómový rollback,
kontrolu verzie a odmietnutie zastaraného zapisovateľa. Vzdialenú databázu
nemení. Ani tieto integračné skúšky nenahrádzajú telefonát so skutočným
zvukom a klávesnicou volajúceho.
