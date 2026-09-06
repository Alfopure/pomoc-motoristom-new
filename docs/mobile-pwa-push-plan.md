# Mobilný dispečing a push upozornenia

## Zistenia a návrh

Pôvodná mobilná nástenka skladala telefón, zoznam prípadov a mapu pod seba. Zoznam mal obmedzenú výšku, kým karta prípadu bola pevne umiestnená nad spodnou navigáciou. Úlohy boli schované v menu; formulár novej úlohy odsunul pracovný zoznam nadol. Kombinácia drobných ovládacích prvkov, vnoreného posúvania a rozdielnych breakpointov sťažovala orientáciu.

Nové rozloženie pod 1024 px používa štyri stále dostupné ciele: Prípady, Úlohy, Mapa, Menu. Zobrazuje jeden hlavný obsah, detail s jasným návratom a výraznú akciu Nový prípad. Desktop ponecháva súbežný prehľad prípadov, mapy a úloh. Mobilné formuláre majú čitateľné vstupy a rešpektujú bezpečnú oblasť displeja. Pokročilé filtre a tvorba úlohy sú dostupné na požiadanie.

Mobilné rozhranie používa kompaktné karty, menšie nadpisy a krátke riadky metadát. Číslo prípadu je iba v jednej hlavičke, Web/Mobil/SMS majú spoločný riadok. Potvrdenie úspešného uloženia sa zobrazí na dve sekundy po uložení a neprekrýva formulár. Úlohy majú operátorský filter na požiadanie; história hovorov ukazuje základné údaje priamo a technické podrobnosti cez Detail. Editovateľné vstupy ostávajú 16 px kvôli priblíženiu pri písaní na iPhone.

Mapa na mobile zaberá celú pracovnú plochu alebo je skrytá pri otvorenom prípade. Ikona v hlavičke prepína tieto dva stavy cez ochranu neuložených zmien; mobilný úchyt a čiastočne vysunutý panel sú odstránené. Desktop si zachováva meniteľnú výšku panelu. Pri zúžení desktopu zostane rozpracovaný formulár viditeľný.

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

## Aktualizácia otvorenej PWA

Nové nasadenie samo nenahradí JavaScript a rozhranie už otvorenej PWA. Worker načítava navigačné HTML zo siete, ale pri kompaktnom vydaní sa jeho skript nezmenil; samotné `registration.update()` preto toto vydanie neodhalilo. Manifest používa relatívny štart `/`, takže inštalácia z nemennej Preview adresy navyše zostane na danej adrese.

Prihlásená konzola si teraz uchová verziu načítaného dokumentu. Pri štarte, návrate do viditeľného okna, obnovení siete a každých päť minút počas používania ju porovná s necachovaným `/api/health/live`. Identifikátor pochádza z `VERCEL_DEPLOYMENT_ID`, potom explicitného `DEPLOYMENT_VERSION` alebo `VERCEL_GIT_COMMIT_SHA`. Lokálna neznáma verzia nevyvolá upozornenie. Výpadok siete nezablokuje prácu ani nespustí obnovenie.

Pri rozdiele sa zobrazí krátka ponuka „Nová verzia je pripravená — Obnoviť“. Ručné „Obnoviť aplikáciu“ je dostupné aj v účte. Obnovenie rešpektuje uloženie alebo zahodenie rozpracovaného prípadu a je blokované počas hovoru, ponuky hovoru, supervízie, pripájania a telefónnych operácií. Stav hovoru sa kontroluje znovu po dialógu ukladania. Aktualizácia nevymazáva cache, prihlásenie ani push odber a nikdy sama nereštartuje dokument.

Už otvorená verzia bez tejto kontroly potrebuje jedno obnovenie po uložení práce a skončení hovoru. Na fyzickom zariadení treba overiť aj adresu, z ktorej bola PWA nainštalovaná; browser simulácia nepotvrdzuje konkrétny stav používateľovho telefónu.

## Spodný okraj mobilnej PWA

Mobilná navigácia tvorí posledný nezmenšujúci sa riadok flex layoutu aplikácie. Obsah nad ňou sa posúva samostatne; kontajner už nepotrebuje rezervné spodné odsadenie pre pevnú lištu. Základná výška je 52 CSS px: tlačidlo 44 px, horný odstup 3 px, spodný 4 px a okraj 1 px. Popisy majú 11 px. Ide o naše kompaktné rozmery odvodené z odporúčaní pre ovládanie, nie o univerzálnu výšku natívnej navigácie. [Apple — tlačidlá](https://developer.apple.com/design/human-interface-guidelines/buttons/), [Apple — prístupnosť](https://developer.apple.com/design/human-interface-guidelines/accessibility/).

K výške lišty sa pridáva skutočný `env(safe-area-inset-bottom, 0px)` iba v jej vlastnom riadku. Pri insete 34 px má spolu 86 px; pri nulovom 52 px. Hodnota nie je pevne obmedzená na 34 px. Na šírku sa rešpektujú bočné výrezy bez dvojitého započítania odsadenia kontajnera. [WebKit — bezpečné oblasti](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).

PWA používa nepriesvitný čierny stavový riadok namiesto `black-translucent`. Kombinácia priesvitného režimu s `viewport-fit=cover` má zdokumentované problémy s polohou dolného okraja; flex riadok zároveň odstraňuje samostatné ukotvenie navigácie cez `position: fixed`. [Apple — metadata](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html), [WebKit 236445](https://bugs.webkit.org/show_bug.cgi?id=236445#c9).

Kontrolujeme aj nenulové bezpečné okraje, otočenie displeja, dostupnosť posledného ovládania po posunutí a zarovnanie detailu prípadu s navigáciou. Emulácia overuje layout, nie konkrétne správanie systémovej oblasti fyzického iPhonu; [novší problém WebKitu s PWA viewportom](https://bugs.webkit.org/show_bug.cgi?id=301994) zostáva otvorený.
