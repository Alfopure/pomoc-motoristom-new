# Mobilné úlohy — upozornenia, fotky, checklist a opakovanie

Rozsah podľa [plánu majiteľa](../plans/mobilne-ulohy-dalsie-kroky-2026-11-06.md),
realizácia autorizovaná pokynom „poď na to“ v rozhovore Conductor 6. 11. 2026.
Nadväzuje na [základné úlohy](simple-tasks-2026-11-06.md). Vydanie najprv do TESTu;
produkcia sa týmto dokumentom neschvaľuje.

## Ovládanie

- **Moje · Pobočka · Zadané mnou** ostávajú hlavné výbery. **Dnes** a
  **Po termíne** vyberajú údaje na serveri pred stránkovaním; dokončené sú pod
  **Hotové**, existujúca kontrola úloh zostáva dostupná.
- **Nová úloha** má názov, príjemcu a voliteľný termín. Voliteľné **Pridať fotku**
  otvorí fotoaparát alebo galériu. Fotografiu možno pridať aj do existujúcej úlohy.
- **Ďalšie možnosti** obsahujú popis/prioritu, checklist a denné/týždenné
  opakovanie. Každý bod checklistu má text a odškrtnutie; nejde o ďalšiu úlohu.
- Detail ukazuje postup checklistu. **Dokončiť s výsledkom alebo fotkou** umožní
  pridať výsledok; bežné dokončenie funguje aj bez neho. Nedokončené body sa
  neodškrtnú automaticky a vyžadujú výslovné potvrdenie aj pri schválení kontroly.
- Sériu možno pozastaviť, obnoviť a zmeniť jej čas/frekvenciu. Zmena platí pre
  budúce výskyty; história zostáva. Pôvodný názov, príjemca, popis, priorita a
  checklist série sa pri tejto úprave nemenia. Zmena jedného výskytu nemení sériu;
  nový obsah alebo príjemca sa nastaví vytvorením novej série.
- Ak autor alebo príjemca už nie je aktívny, séria sa zastaví s vysvetlením.
  Nevydáva sa za obnovenú a nemení sa potichu identita autora.

## Upozornenia

Pridelenie smeruje riešiteľovi, nepridelená pobočková úloha jej aktuálnym vedúcim.
Komentár sa oznamuje oprávneným účastníkom okrem autora; po prevzatí sa front
vedúcich nepoužíva ako hromadný príjemca. Kontrola/vrátenie/schválenie má vlastnú
udalosť a overenie aktuálneho kontrolóra alebo riešiteľa vrátane terénneho účtu.
Staršie kancelárske súkromné oznámenia zostávajú zachované bez dvojitého pushu
a bez náhradného doručenia kancelárii za terénneho riešiteľa.

Nové úlohy majú jednu pripomienku 30 minút pred termínom; pri vytvorení neskôr
sa pripomenú pri termíne. Staré uložené pripomienky sa neprepisujú. Odoslanie
znovu overuje členstvo, príjemcu, generáciu a stav úlohy. Vypnuté push nastavenia
sa rešpektujú. Zamknutá obrazovka nemá obsah úlohy. Nový typ otvorí spoločný
detail cez identitu používateľa, bez udelenia prístupu k prípadom.

## Spoľahlivosť a hranice

- Úloha, checklist, séria, správy a prílohy používajú stabilné identity príkazov
  a revízie. Séria má aj spoločnú revíziu pre úpravy z rôznych výskytov.
  Neistý výsledok opakuje pôvodný príkaz; potvrdený konflikt vyžaduje vedomú
  aktualizáciu rozpracovaného obsahu.
- Fotky sú JPEG/PNG, najviac 8 MiB a 10 živých príloh na úlohu. Metadáta sa
  zobrazia až po overení skutočného súboru. Čítanie vyžaduje oprávnenie k úlohe
  a má 60-sekundový odkaz. Priame klientské Storage operácie blokuje aj
  reštriktívna politika chrániaca pred širokými staršími politikami.
- Vybraný súbor zostáva v cache konkrétneho účtu, do zabezpečeného konceptu
  vstupujú iba identifikátory a metadáta. URL ani podpisové tokeny sa neukladajú.
  Po vytvorení sa čakajúca fotka presunie k svojej úlohe a neovplyvní nový formulár.
  Výpadok, odhlásenie, odobratie prístupu a odstránenie cache majú samostatné stavy.
- Uložená rezerva platnosti uploadu chráni upratanie pred neskorým použitím
  starého podpisového tokenu. Odstránené a expirované uploady sa znovu nepodpisujú.
- Séria vytvára najviac jeden aktuálny výskyt po výpadku, s jedinečnosťou lokálneho
  dňa. Denné a týždenné časy aj filtre používajú časové pásmo organizácie.
  Presety, ručné termíny a zobrazenie ho rešpektujú aj na telefóne v inom pásme;
  neexistujúci čas pri zmene letného času sa odmietne.
- Spracovanie využíva iba existujúci päťminútový cron, po jeho existujúcej práci
  s vlastným ohraničeným rozpočtom. Tvorba úloh/čistenie nezávisí od zapnutia
  pushu alebo pristavení. Nevzniká ďalší scheduler, worker, SMS ani e-mailová séria.

## Databáza TEST

Na **`nzpnqdstvkfncflgqlny`** je aplikovaná jediná nová migrácia
`20261106173407_employee_task_extensions.sql`, SHA-256
`03128d687767db584a366d250e9c26097100adaa4419846c51e6eaa2eee8ad29`.
Lokálny názov súhlasí s migračnou históriou. Pôvodných 18 úloh ostalo zachovaných;
neprebehol seed ani prepis historických úloh. Nové RPC vykonáva iba `service_role`,
tabuľky sú súkromné s RLS a bucket nie je verejný. Bezpečnostní advisori potvrdili
nezmenené WARN nálezy; tri nové INFO RLS bez politík patria úmyselne súkromným tabuľkám.
Produkčná migrácia nebola aplikovaná.

Doplnok `20261106180708_employee_task_source_checklist_completion.sql`, SHA-256
`b2f56f9bc4fc90396f925cac819c491012dc65c81b8116412083b44066aa563c`,
bol aplikovaný iba na ten istý TEST. Zachováva automatické dokončenie po overenej
SMS/polohe alebo spätnom volaní aj pri nehotovom checkliste. Výnimka je ohraničená
existujúcimi vstupmi iba pre `service_role`; pôvodné overenie zdroja, dôkazu,
organizácie, claimu aj kontroly úlohy zostalo. Ručné dokončenie sa tým neobchádza.

## Overenie a stav vydania

Lokálne overenie pred vydaním:

- 83 testov na skutočnom PostgreSQL, vrátane zdedených oprávnení/kontroly úloh,
  starého webu, súbehu sérií, doručenia aj po viac než 500 neplatných čakajúcich
  udalostiach, RLS, expirácií a opakovaných príkazov.
- Celková serverová sada a cielené opravy pushu prešli; mobilná sada má 1 551
  úspešných testov. Typy, lint a nezávislá revízia prešli. Časové testy prešli
  aj pri nastavení zariadenia na UTC a Los Angeles.
- 51 regresných a 36 rozširujúcich kontrol skutočného Expo UI pri 320/390 bodoch:
  dispečer aj terén, filtre, checklist, potvrdenie, séria, výber skutočného
  súboru, výpadok uploadu a opakovanie/odstránenie. Transport je syntetický;
  tieto kontroly nie sú dôkazom živého Storage ani fyzického pushu.

Dôkazy a snímky sú v `.context/task-extensions/`. Stabilný TEST commit
`de65fa928eff90a20526c20687d345415a923d9e` prešiel 30 živými kontrolami API a Storage:
oddelené kancelárske/terénne identity, pobočka, termíny a stránkovanie, checklist,
konflikt série, súkromný upload/čítanie/odstránenie, priame Storage operácie,
cudzí účet a odobratý prístup. Test nevytváral zákazníkov, prípady ani push zariadenia.
Skúšobné úlohy, skupina, profily a štyri Auth účty boli odstránené a úložisko bolo
prázdne; technický záznam odstráneného uploadu zostáva do bezpečnej expirácie tokenu.
Dočasný súbor s prihlasovacími údajmi je odstránený. Doplňujúci SQL-only release má
samostatný PR/commit uvedený v odovzdaní; nemení mobilný kód.

Natívny build s celým rozšírením ešte nebol zostavený ani nahratý. Mac po novom
štarte systémového simulátora prestal odpovedať aj na bežné príkazy; čaká sa na
obnovenie spojenia. Fyzické push doručenie a kamera zostávajú neoverené.

Samostatný základný TEST build **1.0.0 (38)** zo zdroja `1a261b23` prešiel
kontrolou podpisu a obsahu; SHA-256
`80e5b2510c2c6365e5454180e36bb4d0588d387f6b40a3debd05add14428d8e0`.
Nie je týmto rozšíreným vydaním a nebol nahratý. Jeho prvú natívnu kontrolu
zastavil timeout systémového bootovania simulátora pred spustením aplikácie;
štart sa neoznačuje za overený. Staršie výnimky majiteľa boli viazané na svoje
konkrétne buildy. Fyzické doručenie pushu a použitie fotoaparátu musí mať vlastný
výsledok zo zariadenia; build ani browserový náhľad ich nepotvrdzujú.
