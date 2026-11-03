# Nástroje mobilného dispečera

V ústredni otvorte **Nástroje**. Pôvodných päť položiek dolného menu aj priebežné ovládanie hovoru zostáva dostupných. Kalkulačka nie je súčasťou tejto zmeny.

- **Dohľadať vozidlo:** Slovensko alebo Česko, EČV alebo VIN, explicitné overenie. Zobrazujú sa jednotlivé zdroje, čas, čiastočné údaje a rozpory. Nedostupný zdroj nie je dôkazom nepoisteného vozidla. Overenie môže na serveri pokračovať aj po prerušení spojenia; aplikácia ho sama neopakuje a rešpektuje oneskorenie ďalšieho pokusu.
- **Vypočítať trasu:** štart, cieľ a najviac 25 bodov prejazdu. Miesto treba potvrdiť na mape alebo presnými súradnicami. Úprava adresy zruší jej bod aj starý výpočet. Výsledkom je cestná vzdialenosť a odhad času pri odchode teraz, mapa vypočítanej cesty a jednotlivé úseky.
- **Mapa:** vyhľadanie adresy alebo ručný bod, potvrdenie miesta, navigácia a explicitné kopírovanie. Poloha telefónu sa zisťuje iba po stlačení tlačidla a systémovom povolení.
- **Flotila:** vyhľadávanie, typ a stav, po 25 vozidiel. Číta uložený stav organizácie, nespúšťa synchronizáciu poskytovateľa. Obsadenosť, interný stav a aktuálnosť GPS sú samostatné údaje. Mapa ukazuje vozidlá zobrazenej strany a označuje staršie alebo neoverené polohy.

Počas hovoru môžete ďalej pracovať s údajmi nástrojov. Otvorená mapa sa pri hovore zavrie, aby nezakrývala ovládanie telefónu; body trasy zostanú zachované. Nástroje neukladajú prípady a nemenia flotilu.

## Hranice a overenie

API používa existujúce prihlásenie a vyžaduje očakávanú organizáciu; úspešná odpoveď musí zodpovedať prostrediu, profilu, organizácii aj zadanému dotazu. Výsledky a chyby sú `private, no-store`. Zmena účtu zatvára stav nástrojov. Zmena vstupu, skrytie obrazovky alebo prechod na pozadie zruší čakanie na výsledok a vyradí oneskorené odpovede. Zrušenie klienta neznamená zrušenie externého dohľadávania na serveri.

Mapy používajú existujúci chránený WebView na vlastnej doméne. Token sa neposiela v URL, HTML ani mostíku mapy či požiadavkách Googlu. Každé otvorenie má nové ID a overený kontext. Náhľad flotily alebo trasy je povolený len pre samostatnú mapu bez prípadu; prijíma najviac 100 označených bodov a úplne overenú kódovanú čiaru cesty. Cesta sa nenahrádza vzdušnou čiarou.

Externá navigácia používa pevný HTTPS odkaz a súradnice. Kvôli [limitom Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started#directions) otvorí najviac tri body prejazdu a odkaz do 2 048 znakov; ďalšie body nevynecháva potichu. Kompletná vypočítaná trasa zostáva v mape aplikácie.

Flotila má hranicu 200 vozidiel; prekročenie alebo neúplné zdrojové dáta sa hlási ako nedostupný prehľad, nie ako úplný zoznam. Dohľadávanie a Google Maps rešpektujú existujúce prostredie a povolenie živých integrácií. Bežný Preview nesmie volať poskytovateľov; kanonický TEST je `https://test.dispecing.linkapomoci.sk`.

Automatizované overenie pokrýva autorizáciu, projekciu dát, limity, zdrojové rozpory, prerušené požiadavky, poradie trasy, GPS a skutočne serializovaný mapový skript. Kontrolovaný náhľad skutočného React rozhrania nenahrádza fyzické overenie iPhone WebView, povolení polohy, poskytovateľov ani systémového telefonovania.
