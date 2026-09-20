# Dostupné filtre a stĺpce histórie hovorov

Ústredňa zobrazuje kategórie Všetky, Volané, Prijaté a Zmeškané priamo v hlavičke histórie. Na mobile sú všetky štyri voľby v samostatnom riadku s dotykovou plochou najmenej 44 px. Prepnutie zachová vyhľadávanie, obdobie, operátora a linku; vynuluje stránku a konfliktný rozšírený smer/výsledok. Explicitná zmena smeru či výsledku prepne kategóriu na Všetky.

Predvolené nové stĺpce sú dĺžka rozhovoru a odkaz na dostupnú nahrávku. Vo výbere Stĺpce sa dá zapnúť čas čakania, skutočný stav spätného volania a poznámka. Voľby sa ukladajú pre aktuálnu organizáciu a používateľa. Rozšírená tabuľka sa posúva iba vo vnútri prehľadu. Na mobile sa vybrané údaje zobrazujú pri jednotlivom hovore. Výsledok sa už neopakuje pod číslom, poznámka sa dá celá otvoriť v detaile.

## Význam údajov

- Volané sú odchádzajúce hovory vrátane neúspešných pokusov.
- Prijaté sú prichádzajúce hovory s potvrdeným časom prijatia. Samotný stav Ukončený nie je dôkazom spojenia.
- Zmeškané zahŕňajú ukončené neprijaté prichádzajúce hovory so stavom missed alebo abandoned_queue. Výslovná požiadavka na callback, after_hours a ivr_message sa vylúčia; all_busy zostáva neprevzatým hovorom. Technické zlyhania sú samostatný rozšírený filter.
- Rozšírené Spojené filtruje answered_at vo všetkých smeroch. Označené na spätné volanie je existujúci ručný výsledok; nesľubuje prehľad všetkých IVR požiadaviek.
- Čakanie zahŕňa čas od začiatku hovoru po spojenie alebo zloženie vrátane hlasového menu. Neznámy čas sa nezobrazuje ako nula.
- Callback stav pochádza z najnovšej skutočnej požiadavky spojenej s organizáciou a session_id, nie zo zhody telefónneho čísla. Zlyhanie alebo prekročenie limitu načítania nepredstiera neprítomnosť požiadavky.
- Nahrávka sa otvára cez existujúci samostatne autorizovaný detail. História neobsahuje URL audia a nezobrazuje odstránené, obmedzené ani expirované záznamy.

## Stránkovanie a nasadenie

Nie je potrebná nová databázová migrácia. Kategória Zmeškané spája dva usporiadané prúdy existujúcej autorizovanej RPC pred výberom stránky. Zachováva aj mikrosekundy, zhodné časy a null časové značky. Pri dosiahnutí limitu ôsmich čítaní pokračuje cursor iba za skutočne preskúmaným prefixom; UI vysvetlí prípadnú krátku/prázdnu stránku a umožní pokračovať. Nejde o lokálne filtrovanie aktuálne načítaných hovorov.

Overené: 4 226 Vitest testov a 43 Node kontrol, typecheck, produkčný build a lint bez chýb (štyri existujúce upozornenia mimo zmeny). Chromium: 16/16 úspešných kontrol. Browser QA overuje prepínače, kombinované filtre, reset stránkovania, stĺpce, ovládanie klávesnicou, zobrazenie v malom výreze, pokračovanie scanLimited a existujúce autorizačné lehoty. Testy používajú izolované API/provider dáta, bez živých hovorov či zápisov do zdieľanej databázy.

Nasadenie: pracovná vetva → overené Vercel Preview → PR do dev → overený dev alias → PR dev do main → overenie produkcie Telnyx kópie. Konkrétne výsledky a deploymenty sú v `.context/history-release-evidence.json` a PR.
