# Archivované telefónne linky

Pri vyradení alebo presune linky do iného prostredia sa zachová pôvodný riadok `motorist_telephony_lines`. Fyzické vymazanie cez existujúce foreign keys nastavuje `line_id` historických hovorov na NULL a stráca ich pôvodné priradenie.

Archiváciu označuje neprázdny string `metadata.archived_at`; `metadata.archive_reason` uchováva dôvod. Archivovaný riadok má zároveň `active=false`. Ostatné metadata, ID, číslo a historický názov zostávajú zachované. Bežná neaktívna linka bez archivačného označenia sa správa ako doteraz.

Operatívny konfiguračný dokument a hlásenia archivované linky vynechávajú. Priame zápisy, aktivácia a použitie archivovanej identity pre nové hovory sa odmietajú aj pri starom klientovi. Zápis konfigurácie aj hlásení podmieňuje výsledok porovnaním pôvodnej revízie a metadata, aby súbežná požiadavka nezmazala archivačné označenie. História a štatistiky pôvodnú linku naďalej načítavajú.

AI demo vyžaduje explicitný `AI_DEMO_FROM_NUMBER`; bez neho je nenakonfigurované. Už implicitne nevyberá Neutrálnu linku 2. Pred začatím AI hovoru musí byť jeho linka aktívna a nearchivovaná. Samotná archivácia neprepína AI na iné zákaznícke číslo.

## Prevádzkový presun

1. Overiť prostredie, konkrétne číslo a provider ID. Uložiť pôvodnú konfiguráciu a preveriť aktívne hovory, ponuky, čakajúce príkazy, operátorské defaulty, návratové smerovanie a AI použitie.
2. Vydať podporu archivácie štandardným TEST/release postupom. Zmena kódu sama žiadnu linku nearchivuje.
3. V rámci výslovne schváleného projektu vykonať úzku auditovanú transakciu: archivovať a deaktivovať vybraný riadok, vyriešiť jeho odkazy. Pred nulovaním operátorského defaultu preveriť skutočné fallback caller ID. Odstrániť aj konfiguráciu prostredia odkazujúcu na presúvané číslo.
4. Prečítať výsledok a overiť, že neskorá požiadavka neobnovila operátorský default. Počas prechodu nesmú prebiehať konfiguračné zápisy pre túto linku. Odchádzajúci guard zabráni používaniu archivovaného čísla aj pri zastaranom odkaze.
5. Presunúť iba konkrétne číslo na overenú cieľovú provider aplikáciu; nemení sa spoločná produkčná connection ani jej webhook. V cieľovej DB použiť existujúci riadok rovnakého čísla, ak tam je, a odstrániť kopírované produkčné smerovanie. TEST vlastníctvo potvrdiť novým provider priradením, nie historickým provider ID zo snapshotu.
6. Až po kontrole správneho projektu, nasadenia, allowlistov a provider zdrojov zapnúť cieľové volania. Pri presune do TESTu zostávajú všetky kontroly TEST pôvodu a povolených príjemcov v platnosti.

Existujúce číslo sa pri presune nereleasuje ani znovu nekupuje. Prípadný návrat mení iba konkrétne priradenie a uloženú konfiguráciu; pôvodne neaktívnu linku automaticky neaktivuje.

Pre presun `+421232408774` do izolovaného TESTu je rozsahom ľudský operátor web + mobil. TEST AI naďalej odmieta historické produkčné caller ID; jeho zapojenie vyžaduje samostatnú zmenu a overenie. Ukončenie objednávky `+421232408016` a presun čísla `8774` sú dva odlišné provider úkony.
