# Prevádzka dohľadania vozidiel

Táto funkcia patrí dispečerskej aplikácii. Produkcia (`main`) beží vo Vercel projekte `pomoc-motoristom-dispatching` so Supabase `ifpaeegaesdmljfkdvcn` na `https://dispecing.linkapomoci.sk`. Stabilný TEST beží v samostatnom Vercel projekte `pomoc-motoristom-test` z vetvy `dev` (Vercel Production target), používa Supabase `nzpnqdstvkfncflgqlny` a adresu `https://test.dispecing.linkapomoci.sk`. Pracovné Preview používa testovaciu databázu, ale nie je stabilným TEST prostredím. Alias `https://dispecing-test.vercel.app` smeruje na produkciu a neslúži na testovanie. Odstavený VIPTel projekt a jeho databáza sa nepoužívajú. Podrobnosti a bezpečné hranice sú v [AGENTS.md](../AGENTS.md) a [úplnom návode k TEST prostrediu](./operations/full-test-environment.md).

## Používanie a význam údajov

Pri EČV aj VIN vo flotile, novej karte a úprave zásahu je tlačidlo vyhľadávania. Slovenské vozidlá používajú doterajšie zdroje; pre české vozidlá je určený samostatný postup nižšie. Po dohľadaní sa otvorí detail vozidla s dostupnými údajmi o poistení a zoskupenými technickými údajmi pre zásah: palivo, karoséria, poháňané nápravy, prevádzková a najväčšia prípustná hmotnosť, farba, prevodovka a motor. Nezistené hodnoty sú označené; hmotnostná trieda nenahrádza presnú hmotnosť. Ďalšie dostupné údaje, kontroly a pôvodné hodnoty jednotlivých zdrojov sú nižšie v detaile. Zatvorenie okna ponechá návrh na opätovné otvorenie, Escape zatvorí iba detail vozidla.

Vo Flotile je samostatné pole **EČV alebo VIN** nad zoznamom. Nezávisí od filtra existujúcich vozidiel a vracia stručný prehľad s tlačidlom **Celý detail vozidla**. Toto vyhľadávanie nič neukladá. Pri každom vozidle a v hlavičke jeho detailu je **Overiť vozidlo**: otvorí editor a spustí jedno overenie konkrétneho záznamu. Opakované overenie vybraného vozidla zachová rozpracované hodnoty. Párovanie GPS ponúka rovnakú akciu; samostatné Commander záznamy sa overia bez vytvárania vozidla alebo zmeny párovania.

V paneli **Nástroje → Overenie vozidla** je kompaktná verzia s jedným poľom pre EČV/VIN. Zobrazuje identitu, značku/model, PZP s dátumom a základné technické údaje; ostatné údaje sú v detaile. Typ identifikátora sa rozpozná automaticky, vyhľadávanie spustí Enter alebo **Overiť**. Nástroj sa zapína rýchlou skratkou alebo v nastavení widgetov. Pri zbalení si pamätá zadanie a výsledok v aktuálnom pracovisku, pri zmene identifikátora zahodí starý výsledok. Vyhľadávanie ani otvorenie detailu nezapisuje do prípadu či flotily. Údaje vozidla sa neukladajú do lokálnych preferencií rozloženia.

Výsledok je najprv návrh: až prijatie doplní prázdne polia a uloží prehľad k vozidlu alebo zásahu. Existujúce ručné hodnoty zostávajú zachované. Návrh sa zahodí pri zmene identifikátora; nesúhlas EČV/VIN blokuje prijatie. Vyhľadávanie sa spúšťa tlačidlom, nie pri každom napísanom znaku.

Nasledujúci postup a tabuľka zdrojov platia pre **slovenské** vozidlá. Pri zadaní EČV sa najprv zisťuje jednoznačné VIN súbežne cez DatabázaVozidiel.sk a STKonline a až potom sa odošle overenie SKP podľa VIN. Ak VIN nie je dostupné alebo zdroje nesúhlasia, SKP sa osloví podľa zadanej EČV. Ak SKP podľa VIN výslovne nenájde zmluvu, nasleduje jeden pokus cez pôvodnú EČV v zostávajúcom časovom limite. Chyba, CAPTCHA, limit ani nejednoznačný výsledok nespúšťajú ďalší pokus. Pri zdroji SKP sa uvádza, podľa ktorého identifikátora bolo overenie vykonané. VIN ručne zadané vedľa EČV slúži na kontrolu konfliktu, samo nevytvára overenú väzbu EČV → VIN.

Vecne rozdielne hodnoty toho istého poľa sa zobrazia spolu so zdrojmi. Prázdne konfliktné pole sa doplní až po výbere zdroja; bez výberu ostane prázdne. Uložený prehľad obsahuje pôvodné pozorovania všetkých zdrojov. Nie je potvrdením pravdivosti ručne upravených polí.

| Zdroj | Dostupné pozorovania | Obmedzenie |
| --- | --- | --- |
| [DatabázaVozidiel.sk](https://www.databazavozidiel.sk/api-dokumentacia/v3) | Oficiálne API v3: EČV/VIN a dostupné technické údaje registra, evidencia, TK/EK | Serverový kľúč a voľná kvóta; rozsah podľa vozidla. TK/EK zo záznamu, bez živého obnovenia. PZP neposkytuje. |
| [SKP](https://www.skp.sk/) | EČV/VIN, značka, model, farba, poisťovňa, pozitívny stav PZP | Iba hodnoty, ktoré zdroj uvádza; PZP ku zobrazenému dňu overenia, nie ku dňu staršieho zásahu. Bez dátumu konca poistky. |
| [STKonline](https://www.stkonline.sk/) | EČV/VIN, značka, model, farba, palivo, vykonanie a platnosť TK/EK | Presná identita; termín sa nepreberie bez dátumu vykonania. Poskytovateľ uvádza kvartálnu aktualizáciu TK/EK. Čas získania nie je aktualizácia evidencie. Platené polia sa nečítajú. |
| [HAKA](https://www.hakasystem.eu/) | Verejné hlásenie, jeho EČV/VIN a odkaz | Rozlišuje sa zhoda VIN, samotnej EČV, konflikt a neoverená identita staršieho prehľadu. Hlásenie neurčuje identitu dopĺňaného vozidla. Nenájdené hlásenie neznamená, že vozidlo nie je kradnuté. Kontakty ľudí sa neukladajú. |
| [NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/) | Dostupné dekódované technické polia a modelový rok | Čiastočný decode je návrh a vyžaduje samostatný súhlas s doplnením. Modelový rok nie je rok výroby. |

Diaľničná známka, presný dátum výroby ani všetky technické údaje nie sú sľúbeným automatickým výsledkom. Známka má odkaz na ručné overenie. Výpadok, CAPTCHA, limit a nenájdený záznam majú odlišné stavy; výpadok sa nikdy nezobrazí ako nepoistené vozidlo. Verejné weby neposkytujú tejto integrácii garantovanú dostupnosť.

## České vozidlá

Pri dopyte s krajinou **CZ** sa má z českej EČV získať VIN a dostupné základné parametre vozidla; potom sa VIN použije na doplnenie technických údajov zo štátneho registra. [Autokuk API](https://autokuk.cz/api) je komerčný zdroj pre EČV → VIN, kategóriu, hmotnosti a podľa tarify aj diaľničnú známku. [Verejné API českého registra RSV](https://dataovozidlech.cz/wwwroot/data/RSV_Verejna_API_DK_v1_0.pdf) vracia technické údaje podľa VIN s prideleným API kľúčom; samotnú EČV neprijíma. Ak služba nevráti VIN alebo istú väzbu EČV → VIN, technické údaje iného auta sa nedoplnia. Nedostupný zdroj ani nesúlad identity nesmú zmeniť ručne zadané údaje.

[MyCarPlate](https://mycarplate.online/api) je obmedzená vývojová záloha pre českú EČV, keď Autokuk nevráti VIN. Prístup bez kľúča povoľuje aplikácia lokálne iba v režime development bez Vercel prostredia **a zároveň** s efektívnou Supabase URL oddeleného testovacieho projektu `nzpnqdstvkfncflgqlny` alebo s lokálnym hostom `localhost`/`127.0.0.1`. Na Vercel ho povoľuje iba v samostatnom stabilnom TEST projekte (`VERCEL_PROJECT_ID=prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, `VERCEL_ENV=production`, vetva `dev`, `MOTORIST_APP_ENV=test`, kanonická `APP_BASE_URL` a presná URL testovacieho Supabase). Pracovné Preview tento zdroj nepoužíva ani s kľúčom; lokálny režim pripojený k produkčnému Supabase prístup bez kľúča nepovolí. Produkcia môže tento zdroj zapnúť iba pri **oboch** nastaveniach `CZ_MYCARPLATE_LICENSED=true` a neprázdnom `CZ_MYCARPLATE_API_KEY`; tieto premenné samy osebe nenahrádzajú získanie komerčnej licencie, ktorá výslovne povoľuje požadované zobrazenie, uloženie a ďalšie poskytovanie dát podľa [podmienok poskytovateľa](https://mycarplate.online/terms). Bez nej sa MyCarPlate v produkcii nepoužíva a výpadok Autokuku nespúšťa produkčný fallback. Výsledok pilotnej skúšky nie je potvrdením produkčnej dostupnosti.

Aktuálnu českú poisťovňu ani stav povinného ručenia doteraz automaticky neoverujeme. ČKP zatiaľ neposkytla technický prístup a jej verejný formulár z nášho cloudu vracia BotDefense. Stav preto zobrazovať ako **neoverené**, nikdy ako **nepoistené**. Pri poruche možno poisťovňu zistiť cez českú asistenčnú linku **1224**; automatické napojenie ČKP je samostatný následný krok po pridelení prístupu. Staršie údaje o poistnej udalosti alebo poisťovni od iných dodávateľov sa nesmú označiť za aktuálne poistenie.

Ak Autokuk neposkytne overiteľný stav českej diaľničnej známky, používateľ má otvoriť [oficiálne ručné overenie eDalnice](https://edalnice.gov.cz/cs). Interné požiadavky webového formulára nie sú zdokumentované verejné integračné API; nepoužívajú sa ako produkčný konektor bez súhlasu prevádzkovateľa. Známka ostáva samostatný údaj s vlastným časom overenia, nie súčasť technického preukazu.

## Konfigurácia, časové limity a uloženie

- Funkcia používa serverové Supabase premenné tejto aplikácie. DatabázaVozidiel.sk sa zapína neprázdnym serverovým `DATABAZA_VOZIDIEL_API_KEY`; bez neho sa nevolá a ostatné zdroje ostávajú dostupné. Kontrakt a mapovanie sú v [databazavozidiel-integration.md](./databazavozidiel-integration.md). Browser aj jeho runtime assets sú pribalené iba k `/api/vehicles/lookup`; Playwright `browsers.json` musí byť súčasťou Vercel artefaktu.
- České zdroje používajú iba serverové premenné `CZ_AUTOKUK_API_KEY` (komerčný účet Autokuk), `CZ_RSV_API_KEY` (kľúč českého štátneho registra) a pri licencovanom MyCarPlate `CZ_MYCARPLATE_LICENSED` spolu s `CZ_MYCARPLATE_API_KEY`. Nepridávať predponu `NEXT_PUBLIC_`, kľúče do klienta ani do logov. Chýbajúci kľúč Autokuk alebo RSV vypína príslušný zdroj; nevytvára falošný údaj o poistení alebo známke. Výnimkou je len obmedzený vývojový prístup MyCarPlate podľa pravidla vyššie. Pracovné Preview českých externých poskytovateľov nevolá ani pri omylom nastavenom kľúči. V stabilnom TEST použiť iba schválené testovacie limity/prístup pre čítanie českých vozidiel. Produkčné kľúče nastaviť až pre samostatné vydanie `dev` → `main` a po získaní príslušných licencií.
- Voliteľný serverový `VEHICLE_LOOKUP_SIGNING_KEY` je stabilné tajomstvo na podpisovanie. Bez neho sa používa existujúci Supabase service-role kľúč. Pri plánovanej rotácii nastavte pôvodné podpisové tajomstvo do `VEHICLE_LOOKUP_PREVIOUS_SIGNING_KEY` a nové do `VEHICLE_LOOKUP_SIGNING_KEY` v tom istom nasadení. Nové výsledky sa podpisujú novým kľúčom, staré zostávajú čitateľné cez predchádzajúci. Pred odstránením predchádzajúceho kľúča treba uložené prehľady kontrolovane prepodpísať; automatická migrácia podpisov nie je súčasťou funkcie. Kompromitovaný kľúč sa takto nesmie zachovávať iba kvôli dostupnosti histórie. Toto vydanie nemení podpisové tajomstvo.
- `VEHICLE_LOOKUP_CHROME_PATH` slúži iba na lokálny test nainštalovaného Chrome. Vo Vercel sa nenastavuje. Browser dostane najviac 25 s vrátane prípravy, celá operácia do 50 s, route `maxDuration=60`. Žiadny nový worker ani cron.
- Najviac jedna externá operácia naraz na organizáciu, 5/min na profil a 30/min na organizáciu. Limit a rezervácia sa koordinujú transakčne v databáze naprieč Vercel procesmi. Súbežný lookup vráti 409 s `Retry-After`; klient automaticky čaká najviac 30 s v najviac šiestich prestávkach. Opakovaný rovnaký dopyt po dokončení prvého dostane jeho cache. Celý klientsky pokus vrátane čakania má limit 90 s a zmena identity ho zruší. HTTP 429 ani 5xx sa automaticky neopakujú. Toto zlepšuje obsluhu čakania, nezvyšuje povolený súbeh externých zdrojov. API vyžaduje aktívnu dispečerskú alebo vyššiu rolu.
- Úspešný výsledok bez konfliktov identity a technických chýb zdrojov má cache najviac 15 minút; čiastočný alebo neúspešný najviac minútu. Pre SK sa za úspech považuje nájdený SKP a primárny technický zdroj. Pre CZ sa úspech hodnotí podľa zapnutého primárneho zdroja: Autokuk, inak pri dopyte EČV povolený MyCarPlate, inak RSV. Nájdený záložný zdroj pri zlyhaní zapnutého primárneho zdroja preto dostane iba krátku cache; výpadok doplnkového dekodéra vPIC sám osebe český úspech neskracuje. Kľúč zahŕňa organizáciu, identifikátor, typ dopytu, krajinu a bratislavský deň; český kľúč zahŕňa aj dostupnosť jednotlivých poskytovateľov, takže zmena konfigurácie nepoužije starý výsledok. Cache nikdy nepredstiera nové overenie.
- Prijatý, podpísaný výsledok sa ukladá oddelene do `motorist_cases.vehicle_details.vehicleLookup` alebo `motorist_fleet_assets.metadata.vehicleLookup`. Zostáva historickým pozorovaním aj po expirácii cache. Podpis a identita sa kontrolujú pri uložení aj načítaní. Hodnota ručne vyplneného poľa nie je týmto podpisom potvrdená.
- Uloženie flotily zlúči prijatie/zrušenie prehľadu a potvrdenie dostupnosti naraz; zachová ostatné integračné metadata. Verzia kľúča dočasnej cache je **4 pre SK** a **5 pre CZ**. Uložené historické podpisy v1 zostávajú podporované.
- Telemetria `vehicle_lookup_source` obsahuje iba zdroj, stav, trvanie a počet polí. Neloguje EČV/VIN, cookies, CAPTCHA tokeny ani celý výsledok. Testovacie EČV/VIN a živé odpovede sa nedávajú do repozitára.

## Vypnutie, incident a čistenie

Použiť iba SQL editor/service role výslovne zvoleného projektu Supabase: TEST `nzpnqdstvkfncflgqlny` alebo produkcia `ifpaeegaesdmljfkdvcn`, a konkrétne overené `organization_id`. Nasledujúce SQL vyžaduje doplnenie UUID; nemení iné organizácie:

```sql
-- Okamžite zakázať ďalšie dohľadávanie (aj vydanie cache); existujúci request dobehne do limitu.
insert into public.motorist_vehicle_lookup_controls (organization_id, enabled)
values ('<organization-uuid>'::uuid, false)
on conflict (organization_id) do update set enabled = false;

-- Alebo vypnúť iba problémový zdroj. Vzor pre SKP:
update public.motorist_vehicle_lookup_controls
set skp_enabled = false
where organization_id = '<organization-uuid>'::uuid;
-- Zrušiť starú cache po zmene flagov, ak má byť zmena viditeľná okamžite.
delete from public.motorist_vehicle_lookup_cache
where organization_id = '<organization-uuid>'::uuid;
```

Po troch technických zlyhaniach SKP sa tento zdroj pozastaví na 15 minút; DatabázaVozidiel.sk/STKonline/HAKA naďalej vracajú vlastné výsledky. Skontrolovať stav zdroja, runtime log a reálny natívny formulár. Nerobiť automatické nekonečné retry ani neobchádzať interaktívnu výzvu. Po overení opravy zapnúť príslušný flag. Globálne vypnutie je aj prvý krok rollbacku; aditívnu migráciu a uložené historické výsledky netreba mazať.

Pri aktívnom dopyte sa vymaže najviac 50 riadkov cache expirovaných viac než deň. Pre neaktívne organizácie nie je bez schedulera garantovaná retenčná lehota; prevádzkovateľ môže spustiť obmedzené manuálne čistenie:

```sql
delete from public.motorist_vehicle_lookup_cache
where (organization_id, query_hash) in (
  select organization_id, query_hash
  from public.motorist_vehicle_lookup_cache
  where organization_id = '<organization-uuid>'::uuid
    and valid_until < now() - interval '1 day'
  limit 500
);
```

## Overenie vydania

Pre české dohľadanie: vychádzať z aktuálnej vetvy `dev`, vytvoriť samostatnú pracovnú vetvu, spustiť syntetické testy a Vercel build (`vitest run`, `typecheck`, `build`). Po pushi skontrolovať nový Preview deployment a jeho Supabase ref `nzpnqdstvkfncflgqlny`; až potom otvoriť PR do `dev`. Preview neslúži na živý test českých poskytovateľov. Po zlúčení overiť aktuálny SHA, prihlásenie a lookup na `https://test.dispecing.linkapomoci.sk` v samostatnom TEST projekte. Starý generovaný alias vetvy `dev` je iba obmedzená záloha Preview, nie ekvivalent stabilného TEST. Živé referenčné EČV a odpovede uchovávať iba v gitignorovanom `.context/`, nie v dokumentácii ani testovacích fixtures. Zaznamenať zvlášť VIN a technické údaje, poisťovňu ako neoverenú a známku iba ak ju zdroj skutočne potvrdil. Produkciu vydať až následným PR z `dev` do `main`; overiť produkčný SHA a `https://dispecing.linkapomoci.sk`. Nikdy neobnovovať starší Vercel deployment kvôli zmene premenných.

CI používa syntetické identifikátory a lokálne HTML fixtures, bez kontaktovania externých zdrojov. Relevantné sú Vitest provider/snapshot/service/route testy, API auth/CSRF testy a `e2e/vehicle-lookup.spec.ts`. `tests/vehicle-lookup-db.sql` overuje izoláciu, rezervácie, expiráciu, starého vlastníka, circuit a limity v transakcii s rollbackom na kópii databázy.

Lokálny server pre tento E2E súbor spustiť s `SUPABASE_URL=` a `NEXT_PUBLIC_SUPABASE_URL=` explicitne prázdnymi a s `MOTORIST_DEV_AUTH_BYPASS=true`. Tým počiatočné serverové vykreslenie použije rovnaké syntetické vozidlá ako browser API fixtures. Samotné zachytenie `/api/**` v prehliadači neizoluje serverové načítanie stránky. Toto nastavenie patrí iba lokálnemu testu, nikdy Preview alebo produkcii.

Po READY stabilného TEST nasadenia musí nasledovať prihlásený živý lookup z Vercel na schválenom referenčnom vozidle, nie iba lokálny Chrome alebo build. Skontrolovať reálne VIN a stav každého zdroja, cache, 401 bez session a 403 s cudzím Origin. Pri slovenskom vozidle skontrolovať aj dátum PZP; pri českom musí poistenie zostať neoverené, pokiaľ nie je napojená a overená ČKP. Zopakovať kontrolu neskôr na produkčnom SHA. Dočasný testovací účet musí byť po skúške odstránený; test nesmie odosielať e-maily ani vytvárať produkčné zásahy.
