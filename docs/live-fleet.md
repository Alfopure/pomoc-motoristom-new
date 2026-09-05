# Živá flotila v Telnyx kópii

## Zdroje a význam dát

- Software House: výhradne produkčný `https://app.pomocmotoristom.sk/rest`. Autoritatívny roster je `carOccupancy/getCarsOccupancyAll`; `getCarsOccupancy` obsahuje iba voľné vozidlá. Generický `car/getCars` sa na roster nesmie používať, pretože zahŕňa zákaznícke vozidlá.
- Obsadenosť vzniká porovnaním oboch živých odpovedí podľa `carId`, nie zo starého lokálneho rosteru alebo z pohybu auta. Filtrujú sa vlastníctva 3/4. Duplicitné identifikátory, konfliktné ŠPZ alebo nedostupný zdroj neprepíšu posledný overený snapshot.
- Commander: katalóg a všetky stránky posledných polôh; GPS sa pripája iba cez potvrdenú väzbu. Automatika vyžaduje jednoznačnú ŠPZ/VIN na oboch stranách, odmieta konflikty a rešpektuje ručné párovania/odmietnutia. Úplný 17-znakový VIN sa rozpozná aj v poli EČV; čiastočný VIN sa neodhaduje.
- WebDispečink: SOAP katalóg a GPS odťahoviek. GPS neznamená dostupnosť. Novo importované vozidlo má neoverený interný stav, kým ho operátor vedome neurčí; chýbajúca pobočka zostáva nepriradená.

## Čerstvosť a obnova

Otvorená, viditeľná Nástenka / Flotila / Prípady požaduje obnovu približne každú minútu. `POST /api/integrations/fleet/refresh` vyžaduje člena organizácie a same-origin kontrolu. Ručné párovanie zostáva manager/admin. Obnova vracia stav všetkých troch zdrojov a varovania za jednotlivé zdroje.

V `motorist_organization_integrations.config.fleetRefresh` je spoločný compare-and-swap lease: najviac jeden beh naprieč inštanciami a prostrediami, minimálne 60 sekúnd medzi pokusmi, expirácia lease 330 sekúnd. Funkcia má limit 300 sekúnd. Nepridáva sa migrácia, worker, listener ani cron. Ak aplikáciu nikto nemá otvorenú, údaje sa automaticky neobnovujú a sú označené ako staré.

Po 10 minútach je obsadenosť/GPS neaktuálna. Čas GPS merania je oddelený od času prijatia; staršia, neplatná alebo budúca poloha nenahradí poslednú platnú. Chýbajúca poloha sa nenahrádza bodom pobočky, nezobrazí sa na mape a nepoužíva sa na výpočet vzdialenosti či odporúčania.

Software House neposkytuje začiatok obsadenosti. `observedSince` označuje iba prvé súvislé pozorovanie rovnakého stavu v tejto aplikácii. Po zmene stavu alebo výpadku dlhšom ako 10 minút začína nové pozorovanie. `rentTo` môže pri voľnom aute patriť poslednému prenájmu; UI ho tak aj označuje.

Zdrojové detaily a pozorovania sú v existujúcom `latest_payload_snapshot` JSON. UI sprístupňuje údaje vozidla, pobočku, prenájom, poistné/servisné polia a dostupnú GPS/CAN telemetriu. Neznáme jednotky zostávajú označené ako hodnoty API. Autentifikačné polia sa neprenášajú do prehliadača.

## Párovanie a audit

Flotila → Párovanie vozidiel rozlišuje nepriradené SWHouse vozidlá, napárované bez GPS a Commander záznamy bez zhody. CSV obsahuje aj ešte neimportované Commander záznamy. Chýbajúca zhoda nie je dôkaz predaja; automatika vozidlá nemaže.

Prvá živá kontrola 2026-09-05: 277 vozidiel Software House (125 voľných / 152 obsadených), 237 Commander záznamov / 194 GPS polôh, 174 jednoznačných párovaní, z nich 173 s polohou. Z pôvodných 166 aktívnych potvrdených väzieb bolo 165 stále prítomných v oboch aktuálnych katalógoch a všetky už boli spárované; jedna nemala aktuálny zdrojový záznam. Žiadna historická väzba sa nekopírovala naslepo.

Aktuálny WebDispečink účet vracia jediné vozidlo BT583EV. Jeho typ odťahovky je overený; pôvodná pobočka v tejto kópii neexistuje, preto zostáva bez lokálneho priradenia. Väčší rozsah vozidiel vyžaduje prístup k nim na strane poskytovateľa, nie fiktívny import starých GPS.

Prístupy patria výhradne do serverových env novej kópie. Nekopírujú sa pôvodné Supabase/Vercel identifikátory, telephony nastavenia ani sync tokeny. Development a Preview zapisujú do tej istej reálnej databázy tejto kópie.
