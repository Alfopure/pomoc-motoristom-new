# DatabázaVozidiel.sk — podklady pre integráciu

## Stav

Samotný poskytovateľ zatiaľ nie je zapojený. [Dokumentácia API](https://www.databazavozidiel.sk/admin/api-info) presmeruje neprihláseného používateľa na `/admin/auth/login`; ani dodaný API kľúč v hlavičke Bearer nesprístupnil túto stránku. Chýba overený endpoint, spôsob autentifikácie a kontrakt odpovede. Tieto hodnoty sa nesmú nahrádzať odhadom.

Pripravený je spoločný dátový model pre zdroj `databazavozidiel`, technické údaje a podpisované historické prehľady. Detail vozidla tieto údaje dokáže zobraziť, ale ich prítomnosť v modeli neznamená, že ich dnešné zdroje poskytujú. Prevádzkový postup existujúcich zdrojov je v [vehicle-lookup-operations.md](./vehicle-lookup-operations.md).

## Verejne deklarovaný rozsah

[Verejná stránka poskytovateľa](https://www.databazavozidiel.sk/) uvádza slovenské EČV/VIN a údaje technického preukazu okrem vlastníka a držiteľa. Pre dispečing sú užitočné najmä:

- identifikácia: značka, obchodný názov, kategória, typ/variant/verzia, farba, prvá evidencia a prvá evidencia v SR;
- motor: palivo, objem, výkon, výrobca/číslo motora, otáčky, prevodovka a počet stupňov;
- podvozok: karoséria, počet a pohon náprav, rázvor, pneumatiky a ráfiky;
- preprava: prevádzková hmotnosť, najväčšia prípustná hmotnosť vozidla/súpravy/náprav/prívesu, rozmery a spájacie zariadenie.

Ide o zoznam ponúkaných údajov, nie o overené názvy JSON polí ani záruku ich dostupnosti pre konkrétne vozidlo. Existujúce verejné zdroje nevracajú kompletný technický preukaz. PZP naďalej overuje SKP; samotné údaje registra sa nepovažujú za potvrdenie poistenia.

## Čo treba z prihlásenej dokumentácie

1. Presná HTTPS adresa, HTTP metóda a parametre pre EČV a VIN.
2. Umiestnenie API kľúča (hlavička, telo alebo parameter) a povolené formáty.
3. Ukážka úspešnej odpovede vrátane názvov polí, typov, jednotiek a dátumov.
4. Odpovede pri nenájdenom vozidle, neplatnom kľúči, vyčerpanom balíku a limite.
5. Spôsob rozlíšenia viacerých záznamov a aktuálneho/staršieho EČV.

Po získaní kontraktu doplniť serverový adaptér s pevnou adresou poskytovateľa, časovým limitom, limitom veľkosti odpovede a povoleným zoznamom technických polí. Kľúč patrí do serverovej premennej `DATABAZA_VOZIDIEL_API_KEY`, bez prefixu `NEXT_PUBLIC_`, iba v projekte `pomoc-motoristom-new`. Kľúč, celé živé odpovede ani referenčné EČV/VIN nepatria do repozitára ani logov.

## Zamýšľané poradie

EČV → DatabázaVozidiel.sk a STKonline → kontrola zhody identity → SKP podľa VIN → prípadné doplnkové dekódovanie vPIC. Pri chýbajúcom VIN zostáva overenie SKP cez EČV. Všetky zdroje zachovávajú svoje stavy a pôvod údajov; rozdielne hodnoty sa neprepisujú potichu.

Nasadenie až po overení skutočného kontraktu a testoch: pracovná vetva → Preview → PR do `dev` → overenie dev aliasu → PR `dev` do `main`. Bez databázovej migrácie, nového workera alebo cronu.
