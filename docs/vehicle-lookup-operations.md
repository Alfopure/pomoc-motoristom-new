# Prevádzka dohľadania vozidiel

Táto funkcia patrí výlučne projektu `pomoc-motoristom-new`, Supabase `ifpaeegaesdmljfkdvcn` vo Frankfurte. Nevyužíva starý VPS ani pôvodnú produkčnú databázu. Nasadzuje sa cez work branch → Preview → PR do `dev` → overenie dev aliasu → PR `dev` do `main`. Produkčný alias kópie je `https://dispecing-test.vercel.app`.

## Používanie a význam údajov

Pri EČV aj VIN vo flotile, novej karte a úprave zásahu je tlačidlo vyhľadávania. Podporované sú slovenské vozidlá. Výsledok je najprv návrh: až prijatie doplní prázdne polia a uloží prehľad k vozidlu alebo zásahu. Existujúce ručné hodnoty zostávajú zachované. Návrh sa zahodí pri zmene identifikátora; nesúhlas EČV/VIN blokuje prijatie.

Vecne rozdielne hodnoty toho istého poľa sa zobrazia spolu so zdrojmi. Prázdne konfliktné pole sa doplní až po výbere zdroja; bez výberu ostane prázdne. Uložený prehľad obsahuje pôvodné pozorovania všetkých zdrojov. Nie je potvrdením pravdivosti ručne upravených polí.

| Zdroj | Dostupné pozorovania | Obmedzenie |
| --- | --- | --- |
| [SKP](https://www.skp.sk/) | EČV/VIN, značka, model, farba, poisťovňa, pozitívny stav PZP | Iba hodnoty, ktoré zdroj uvádza; PZP ku zobrazenému dňu overenia, nie ku dňu staršieho zásahu. Bez dátumu konca poistky. |
| [STKonline](https://www.stkonline.sk/) | EČV/VIN, značka, model, farba, palivo, vykonanie a platnosť TK/EK | Presná identita; termín sa nepreberie bez dátumu vykonania. Poskytovateľ uvádza kvartálnu aktualizáciu TK/EK. Čas získania nie je aktualizácia evidencie. Platené polia sa nečítajú. |
| [HAKA](https://www.hakasystem.eu/) | Verejné hlásenie, jeho EČV/VIN a odkaz | Rozlišuje sa zhoda VIN, samotnej EČV, konflikt a neoverená identita staršieho prehľadu. Hlásenie neurčuje identitu dopĺňaného vozidla. Nenájdené hlásenie neznamená, že vozidlo nie je kradnuté. Kontakty ľudí sa neukladajú. |
| [NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/) | Dostupné dekódované technické polia a modelový rok | Čiastočný decode je návrh a vyžaduje samostatný súhlas s doplnením. Modelový rok nie je rok výroby. |

Diaľničná známka, prvá registrácia, presný dátum výroby ani všetky technické údaje nie sú sľúbeným automatickým výsledkom. Známka má odkaz na ručné overenie. Výpadok, CAPTCHA, limit a nenájdený záznam majú odlišné stavy; výpadok sa nikdy nezobrazí ako nepoistené vozidlo. Verejné weby neposkytujú tejto integrácii garantovanú dostupnosť.

## Konfigurácia, časové limity a uloženie

- Funkcia používa existujúce serverové Supabase premenné tejto kópie. Nový platený token netreba. Browser aj jeho runtime assets sú pribalené iba k `/api/vehicles/lookup`; Playwright `browsers.json` musí byť súčasťou Vercel artefaktu.
- Voliteľný serverový `VEHICLE_LOOKUP_SIGNING_KEY` je stabilné tajomstvo na podpisovanie. Bez neho sa používa existujúci Supabase service-role kľúč. Pri plánovanej rotácii nastavte pôvodné podpisové tajomstvo do `VEHICLE_LOOKUP_PREVIOUS_SIGNING_KEY` a nové do `VEHICLE_LOOKUP_SIGNING_KEY` v tom istom nasadení. Nové výsledky sa podpisujú novým kľúčom, staré zostávajú čitateľné cez predchádzajúci. Pred odstránením predchádzajúceho kľúča treba uložené prehľady kontrolovane prepodpísať; automatická migrácia podpisov nie je súčasťou funkcie. Kompromitovaný kľúč sa takto nesmie zachovávať iba kvôli dostupnosti histórie. Toto vydanie žiadne produkčné tajomstvo nemení.
- `VEHICLE_LOOKUP_CHROME_PATH` slúži iba na lokálny test nainštalovaného Chrome. Vo Vercel sa nenastavuje. Browser dostane najviac 25 s vrátane prípravy, celá operácia do 50 s, route `maxDuration=60`. Žiadny nový worker ani cron.
- Najviac jedna externá operácia naraz na organizáciu, 5/min na profil a 30/min na organizáciu. Limit a rezervácia sa koordinujú transakčne v databáze naprieč Vercel procesmi. Súbežný lookup vráti 409 s `Retry-After`; klient automaticky čaká najviac 30 s v najviac šiestich prestávkach. Opakovaný rovnaký dopyt po dokončení prvého dostane jeho cache. Celý klientsky pokus vrátane čakania má limit 90 s a zmena identity ho zruší. HTTP 429 ani 5xx sa automaticky neopakujú. Toto zlepšuje obsluhu čakania, nezvyšuje povolený súbeh externých zdrojov. API vyžaduje aktívnu dispečerskú alebo vyššiu rolu.
- Úspešný SKP + STKonline výsledok bez technických chýb má cache najviac 15 minút. Čiastočný alebo neúspešný výsledok najviac minútu. Kľúč zahŕňa organizáciu, identifikátor, typ dopytu, krajinu a bratislavský deň; cache nikdy nepredstiera nové overenie.
- Prijatý, podpísaný výsledok sa ukladá oddelene do `motorist_cases.vehicle_details.vehicleLookup` alebo `motorist_fleet_assets.metadata.vehicleLookup`. Zostáva historickým pozorovaním aj po expirácii cache. Podpis a identita sa kontrolujú pri uložení aj načítaní. Hodnota ručne vyplneného poľa nie je týmto podpisom potvrdená.
- Uloženie flotily zlúči prijatie/zrušenie prehľadu a potvrdenie dostupnosti naraz; zachová ostatné integračné metadata. Verzia kľúča dočasnej cache je 2, aby sa nové dohľadania parsovali už s identitou hlásení HAKA. Uložené historické podpisy v1 zostávajú podporované.
- Telemetria `vehicle_lookup_source` obsahuje iba zdroj, stav, trvanie a počet polí. Neloguje EČV/VIN, cookies, CAPTCHA tokeny ani celý výsledok. Testovacie EČV/VIN a živé odpovede sa nedávajú do repozitára.

## Vypnutie, incident a čistenie

Použiť iba SQL editor/service role Supabase tejto kópie a konkrétne overené `organization_id`. Nasledujúce SQL vyžaduje doplnenie UUID; nemení iné organizácie:

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

Po troch technických zlyhaniach SKP sa tento zdroj pozastaví na 15 minút; STKonline/HAKA naďalej vracajú vlastné výsledky. Skontrolovať stav zdroja, runtime log a reálny natívny formulár. Nerobiť automatické nekonečné retry ani neobchádzať interaktívnu výzvu. Po overení opravy zapnúť príslušný flag. Globálne vypnutie je aj prvý krok rollbacku; aditívnu migráciu a uložené historické výsledky netreba mazať.

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

CI používa syntetické identifikátory a lokálne HTML fixtures, bez kontaktovania externých zdrojov. Relevantné sú Vitest provider/snapshot/service/route testy, API auth/CSRF testy a `e2e/vehicle-lookup.spec.ts`. `tests/vehicle-lookup-db.sql` overuje izoláciu, rezervácie, expiráciu, starého vlastníka, circuit a limity v transakcii s rollbackom na kópii databázy.

Po READY Preview musí nasledovať prihlásený živý lookup z Vercel na schválenom referenčnom vozidle, nie iba lokálny Chrome alebo build. Skontrolovať reálne VIN a stav každého zdroja, PZP dátum, cache, 401 bez session a 403 s cudzím Origin. Zopakovať kontrolu na overenom dev a produkčnom SHA. Dočasný testovací účet musí byť po skúške odstránený; test nesmie odosielať e-maily ani vytvárať produkčné zásahy.
