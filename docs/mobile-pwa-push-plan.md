# Mobilný dispečing a push upozornenia

## Zistenia a návrh

Pôvodná mobilná nástenka skladala telefón, zoznam prípadov a mapu pod seba. Zoznam mal obmedzenú výšku, kým karta prípadu bola pevne umiestnená nad spodnou navigáciou. Úlohy boli schované v menu; formulár novej úlohy odsunul pracovný zoznam nadol. Kombinácia drobných ovládacích prvkov, vnoreného posúvania a rozdielnych breakpointov sťažovala orientáciu.

Nové rozloženie pod 1024 px používa štyri stále dostupné ciele: Prípady, Úlohy, Mapa, Menu. Zobrazuje jeden hlavný obsah, detail s jasným návratom a výraznú akciu Nový prípad. Desktop ponecháva súbežný prehľad prípadov, mapy a úloh. Mobilné formuláre majú čitateľné vstupy a rešpektujú bezpečnú oblasť displeja. Pokročilé filtre a tvorba úlohy sú dostupné na požiadanie.

Inšpirácia: [Linear Mobile, január 2026](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile) — priame vstupy do každodennej práce; [Material 3](https://m3.material.io/components/navigation-bar/guidelines) — krátka označená spodná navigácia a adaptívne rozloženie. Žlto-sivá identita aplikácie zostáva zachovaná.

## Push

Existujúca implementácia ukladá notifikácie do databázy a zobrazuje ich v otvorenej aplikácii. Chýba odber zariadenia, odosielanie Web Push a obsluha push udalostí v service workeri. Dopĺňame autentifikovaný odber viazaný na používateľa, organizáciu a zariadenie; doručenie pri priradení úlohy a existujúcom spracovaní pripomienok; čistenie neplatných odberov; bezpečné otvorenie úlohy z upozornenia.

Nastavenia obsahujú zapnutie/vypnutie push na tomto zariadení, zvuk a odoslanie skúšobného upozornenia. Povolenie prehliadača sa žiada iba po kliknutí. Odhlásenie zruší odber na zdieľanom zariadení. Chyba push nesmie zmeniť úspešne uloženú úlohu na zdanlivo neúspešný zápis.

Na iOS/iPadOS 16.4+ vyžaduje push aplikáciu pridanú na plochu. Zvuk v pozadí riadi operačný systém; web môže požiadať o zvuk, ale nemôže obísť režim Nerušiť alebo vynútiť vlastný zvuk po zatvorení. [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).

## Realizácia a overenie

1. Samostatná vetva z aktuálneho `dev`; oddelená implementácia mobilného obsahu, navigácie, push servera a klienta.
2. Testy autorizácie, registrácie/odhlásenia, neplatných endpointov, deduplikácie, chýb poskytovateľa a service workera.
3. Izolované browser testy mobilnej navigácie, úloh, nastavení a formulárov pri 360/390/768/1280 px. Žiadne testovacie zápisy do zdieľaných prípadov.
4. Kontrola diffu, Vitest/Node testy, lint, typecheck, build.
5. Preview a jeho kontrola → PR do `dev` → kontrola dev aliasu → release PR `dev` do `main` → kontrola produkcie tejto kópie.
6. Skutočné doručenie na fyzickom telefóne a počuteľnosť zvuku vyžadujú opt-in zariadenie. Prijatie push poskytovateľom ani browser simulácia samy nepotvrdzujú, že používateľ upozornenie uvidel alebo počul.

Úprava nevyžaduje nový cron, worker ani listener. Úložisko push a jeho kľúče patria iba projektu tejto kópie.
