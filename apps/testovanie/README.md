# Testovanie dispečingu

Samostatná Next.js aplikácia s 92 scenármi (35 základných, 57 rozšírených) v 16 oblastiach. Beží v samostatnom Vercel projekte `dispecing-testovanie`, región `fra1`. V dispečingu ju otvára odkaz **Testovanie** v menu používateľského účtu.

## Používanie

1. Zadajte meno. Nie je potrebné heslo, registrácia ani účet v dispečingu.
2. Vytvorte interné alebo klientské kolo. Zadajte testovaný build/commit, URL, zariadenie a prípadné podmienky (linky, zapnuté funkcie, roly).
3. Vyberte rýchly test, základnú alebo kompletnú sadu, oblasť a scenár. **Rýchly test dispečingu** má 11 existujúcich scenárov v poradí od prihlásenia cez hovory, pauzy, callbacky a bežnú prácu po odhlásenie. Každý scenár má v danom kole spoločný výsledok a históriu vo všetkých sadách. Klientské kolá vynechávajú interné technické skúšky.
4. Prejdite kroky a vyhodnoťte očakávaný výsledok. Výhrada, chyba, blokovanie a vyradenie z rozsahu vyžadujú vysvetlenie. Výhrada je iba drobná a má riešiteľa; pri vyradení sa zaznamená meno koordinátora.
5. Uložte výsledok, prípadne pokračujte ďalším neotestovaným scenárom. Zmeny kolegov sa načítajú pri návrate do okna a každých 25 sekúnd, kým je okno aktívne.

Prvé uložené hodnotenie uzamkne podmienky kola. Pre iný build, zariadenie alebo rozsah založte nové kolo. Historické výsledky sa nepreberajú ako nové úspechy. Archivácia zachová výsledky aj históriu a zabráni ďalšiemu hodnoteniu; kolo možno obnoviť.

CSV exportuje aktuálne zobrazené scenáre vrátane výsledkov, poznámok, autora, verzie a zariadenia. História má samostatný JSON export s pôvodnými a novými hodnotami i definíciami scenárov. Podklady možno pripojiť HTTPS odkazom; prvá verzia neprijíma súborové uploady.

Rýchly výber používa `AUTH-01`, `CALL-01`, `CALL-05`, `CALL-02`, `CALL-03`, `CB-01`, `CB-03`, `CB-02`, `CALL-08`, `CASE-03`, `AUTH-02`. Zahŕňa aj vybrané bežné situácie z druhej úrovne. Výber pracuje s definíciami uloženými v konkrétnom kole, funguje aj v existujúcich kolách a nemení ich katalóg. Počítadlá, oblasti, export aj prechod na ďalší test rešpektujú zvolenú sadu; prepnutie sady zruší predchádzajúce filtre.

## Meno a audit

Meno je **samostatne zadaný údaj, nie overená identita**. Každý, kto pozná URL, môže zadať meno a vstúpiť. Neexistujú účty ani technicky vynucovaná rola koordinátora. Používajte rozlíšiteľné stabilné mená; do poznámok nepatria prihlasovacie údaje alebo skutočné citlivé zákaznícke podklady.

Server vytvorí vstup so stabilným ID a podpíše cookie `HttpOnly`, `SameSite=Strict` (na HTTPS aj `Secure`). Podpis chráni pred prepísaním mena priamo v cookie; nemení samostatne zadané meno na overenú osobu. Zmena mena vytvorí nový vstup a nezmení staršie zápisy. Požiadavka obsahuje očakávané ID vstupu, aby zmena mena v druhej karte nepripísala nevedomky zápis inej osobe.

Audit eviduje vstupy, vytvorenie/úpravu/archiváciu/obnovu kola a každé uloženie výsledku. Záznam obsahuje serverový čas UTC, meno a ID vstupu, pôvodnú i novú hodnotu, kolo, scenár a ID požiadavky. Rozhranie históriu nemaže. Správca úložiska naďalej má technický prístup k dátam; nejde o nezávislý právny dôkaz identity alebo úložisko WORM.

Ukazovatele aktivity merajú mená so zápisom, počet uložených hodnotení a vstupov. Vstup ani otvorenie scenára sa nepočíta ako vykonaný test. Vykonané testy = akceptované + s výhradou + neakceptované. Blokované ostávajú v menovateli; položky mimo rozsahu sú zobrazené osobitne.

## Ukladanie

Používa vlastný **private Vercel Blob store**, nie Supabase ani tabuľky dispečingu. Token je iba na serveri. Aplikácia nijako nespúšťa telefóniu, integračné joby ani cron.

- `BLOB_READ_WRITE_TOKEN`: prístup iba k samostatnému úložisku testovania.
- `TRACKER_SESSION_SECRET`: náhodný kľúč s aspoň 32 znakmi; stabilný medzi nasadeniami.
- `TRACKER_STORAGE_PREFIX`: `production` pre produkciu evidencie, `preview` pre Preview/dev. Zápisy z overovania stránky sa tým nemiešajú s používaním nasadenej evidencie.

Malá tímová evidencia je uložená v jednom JSON dokumente. Výsledok a audit sa zapisujú **spoločne**, pomocou podmieneného zápisu ETag (`ifMatch`) a konzistentného čítania (`useCache: false`). Čítanie výslovne požaduje `Accept-Encoding: identity`: kompresia väčšieho dokumentu inak zmení ETag na slabý `W/`, ktorý nemožno použiť pre podmienený zápis. Súbeh v inom riadku sa bezpečne zopakuje. Zastaraná revízia rovnakého výsledku vráti 409; rozpracovaný text zostane v dialógu a tester výslovne zvolí ďalší postup. Idempotency ID a odtlačok obsahu chránia opakovanie po strate odpovede.

Pri chybe sa nezobrazuje falošné potvrdenie uloženia a server na Verceli nikdy neprejde na dočasný súbor alebo `localStorage`. Pre túto malú evidenciu je stanovený limit 12 MB na dokument; prekročenie zastaví nový zápis, nikdy neodstráni históriu. Pri raste počtu kôl/udalostí treba úložisko rozdeliť alebo migrovať do databázy. Export JSON zachová celý obsah potrebný na migráciu; pravidelné zálohovanie môže správca vykonávať mimo tejto aplikácie.

## Lokálne spustenie a kontrola

Zo základného adresára repozitára:

```bash
pnpm install --frozen-lockfile
TRACKER_LOCAL_FILE=/tmp/motorist-testovanie-local.json TRACKER_SESSION_SECRET=local-only-secret-at-least-32-characters pnpm --filter @motorist/testovanie dev
pnpm --filter @motorist/testovanie check
pnpm --filter @motorist/testovanie test:e2e
```

Lokálny súbor je určený len pre jeden lokálny server a automatické skúšky. Na Verceli je odmietnutý. Playwright spustí lokálny server, prípadne použije existujúci na porte 3100; na Linuxe používa preinštalovaný Chrome. Testuje oddelené prehliadače, súbeh, históriu pred/po, výpadok uloženia, zmenu mena, export a mobilné rozloženie. Tieto skúšky overujú evidenciu; nepotvrdzujú výsledky funkcií dispečingu.

Vercel Root Directory: `apps/testovanie`; build gate: `pnpm check` (Vitest → TypeScript → Next build). Root projekt má vlastnú nezmenenú gate; vnorenú aplikáciu vylučuje zo svojho TypeScript/Vitest/ESLint rozsahu. Spoločný pnpm workspace a lockfile držia závislosti oboch aplikácií.

Nasadenie postupuje pracovnou vetvou z aktuálneho `dev`, Preview kontrolou, PR do `dev`, kontrolou dev aliasu a produkčným PR `dev → main`. Build odmietne produkčné nasadenie z inej vetvy vrátane automatického prvého nasadenia Vercelu. Netreba žiadne Supabase migrácie, seed ani nový plánovač.

## Rozsah katalógu

`src/lib/catalog.ts` uchováva prvú pripravenú sadu podľa plánu z 9. 9. 2026, aktuálneho kódu a zápiskov 4. 9. Nové kolo dostane nemennú kópiu definícií. Úprava katalógu sa týka až ďalších kôl; pri zmene scenárov zvýšte `catalogVersion`.

Počet 92 neznamená každú kombináciu všetkých možností. Prvých 8–10 scenárov má tím použiť na pilot zrozumiteľnosti; následne doplniť konkrétne klientove pravidlá a varianty zariadení. Požadovaná, ale nedostupná funkcia sa neoznačuje ako úspešná ani automaticky mimo rozsahu. PDF, príjem SMS, rozšírené telefonovanie a nahrávky majú v scenároch výslovné podmienky. Existujúce PA/PU/RC/CB/MG/QA testy sa používajú ako podklady bez tvrdenia, že tým už prebehla živá akceptácia.

Technické podklady: [Next.js lokálna dokumentácia](../../node_modules/next/dist/docs/), [Vercel Blob – konzistentné čítanie a podmienené zápisy](https://vercel.com/docs/vercel-blob/using-blob-sdk), [plán tvorby testovania](../../docs/testing-preparation-plan.md).
