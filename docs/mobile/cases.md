# Mobilné prípady

Rozsah požadovaný majiteľom 11. 10. 2026 počas čakania na Apple členstvo.
Funguje v Expo Go a používa rovnaké uložené prípady ako webový dispečing.
Fyzické iPhone telefonovanie zostáva samostatným neovereným míľnikom.

## Mobilný pracovný postup

Záložka **Prípady** obsahuje moje/všetky prípady organizácie, filter otvorených
alebo všetkých stavov vrátane uzavretých, vyhľadávanie, ďalšie stránky,
obnovu a detail. Detail
ukáže číslo, stav, prioritu, dispečera, kontakt, vozidlo, vyzdvihnutie,
cieľ, problém, poznámku a nedávnu históriu. Výber telefónu pripraví číslo
v ústredni; nezačne sám hovor.

Predvolene sa zobrazia **všetky otvorené prípady** podľa výberu majiteľa.
Prehľad pridáva [počty a filtre podľa stavu a priority](case-filter-overview.md).
Počty sa vzťahujú na otvorené prípady celej organizácie; aktuálny textový
alebo dispečerský filter ich nemení. Výslovný výber konkrétneho stavu
umožní vyhľadať aj uzavreté prípady bez zmeny predvoleného pohľadu.
Zoznam možno filtrovať podľa konkrétneho dispečera alebo rýchlo prepnúť na
moje prípady. Výber obsahuje aj neaktívnych ľudských dispečerov organizácie,
aby sa dali nájsť staršie priradené prípady; označí ich ako neaktívnych.

Nové [priradenie a mapa](case-owner-map.md) pridávajú filter nepridelených
prípadov, prevzatie voľného otvoreného prípadu, potvrdené preradenie
aktívnemu kolegovi aj pre bežného dispečera a výber adresy alebo bodu
do formulára. Dostupnosť priradenia závisí od schválenej databázovej funkcie.

Výber miesta v novom aj upravovanom prípade ponúkne
[polohu tohto telefónu](device-location.md). Zistí ju až po stlačení,
ukáže približnú presnosť a umožní zobraziť bod na mape. Pozícia telefónu
sa nepovažuje za pozíciu zákazníka. Prípad sa nemení pred existujúcim
potvrdením mapy a uložením formulára; ručná adresa zostáva dostupná.

**Nový prípad** je krátky formulár pre meno a telefón kontaktu, EČV,
značku/model, miesto vyzdvihnutia, cieľ, popis problému, typ zákazky,
prioritu a poznámku. Neúplný prípad možno založiť a doplniť neskôr rovnako
ako na webe. Vlastníkom je overený prihlásený dispečer. Uložený prípad je
následne dostupný aj vo webovej ústredni.

Formulár a vybraný detail sa zachovajú pri zmene záložky. Čítanie sa
neobnovuje na skrytej obrazovke alebo v pozadí. Nové prípady sa neposielajú
automaticky ani cez offline frontu. Po neistom výsledku zápisu treba najprv
skontrolovať obnovený zoznam, aby sa ten istý prípad nezaložil dvakrát.
Úspešne potvrdený zápis nezávisí od následného načítania detailu.

**Upraviť prípad** doplní kontakt, vozidlo, adresy, popis, typ zákazky,
prioritu a hlavnú poznámku. Posiela iba zmenené polia a presnú serverovú
revíziu. Súbežná zmena kolegu zachová koncept a zobrazí porovnanie; používateľ
vedome vyberie zachovanie svojich úprav alebo načítanie údajov kolegu.
Zmena ručnej adresy nahradí pôvodne vybrané mapové miesto. Hlavný kontakt
zostane zhodný s webom aj pri viacerých kontaktoch; ostatné kontakty sa zachovajú.

Mobil používa rovnakých šesť ručne nastaviteľných stavov ako webový editor:
otvorený, vybavený, bez asistencie, čaká na doklady, zrušený a marný výjazd.
Ostatné existujúce stavy vie zobraziť a pri úprave iného poľa ich zachová.

**Pridať poznámku** pridá samostatný záznam do histórie s autorom a časom.
Nenahrádza hlavnú poznámku. Úprava aj nový záznam používajú stabilnú identitu
požiadavky: pri neistom výsledku je možné iba výslovné overenie tej istej
operácie. Samotné načítanie podobných hodnôt nie je potvrdením zápisu.
Potvrdená poznámka zostane uložená aj pri neskoršej chybe auditu, ktorú
odpoveď označí upozornením; nevkladá sa druhýkrát. Tlačidlo **Overiť audit
poznámky** zopakuje tú istú požiadavku. Aj pri neúspešnom overení zostane
poznámka označená ako uložená.

**Navigovať** z detailu otvorí mapy pre zobrazené miesto zásahu alebo cieľ.
Ide o výslovnú akciu; aplikácia si nežiada oprávnenie na polohu.

**Prílohy** zobrazia súbory prípadu a na výslovnú akciu otvoria krátkodobý
odkaz na stiahnutie. Pridať možno fotografiu z knižnice alebo fotoaparátu
a dokument JPEG, PNG alebo PDF do 3 MiB. Fotografie sa lokálne prevedú na
JPEG, zmenšia najviac na 2048 px a overia podľa skutočných bajtov.
Podpora HEIC a pamäťové nároky veľkých fotografií vyžadujú skúšku na iPhone.
Fotoaparát aj knižnica si pýtajú oprávnenie až pri výbere používateľa.
Staršie vlastné natívne zostavenie potrebuje novú binárnu verziu s pickermi;
Expo Go má vlastné natívne moduly a oprávnenia.

Upload zachová pôvodné bajty, metadáta, revíziu a UUID aj po strate odpovede.
Platí to počas otvorenej aplikácie. Po reštarte ostane iba chránený záznam
príkazu a metadát; súbor sa neuchováva a pôvodný upload sa nedá zopakovať.
Mobil vyžiada čerstvý zoznam príloh a vedomé potvrdenie pred novým výberom.
Zhoda názvu súboru nepotvrdzuje pôvodné uloženie.
Overenie neistého výsledku odošle tú istú požiadavku; nikdy znovu nenačíta
meniteľný pôvodný súbor. Súbor sa neprepisuje ani automaticky nemaže.
Pripojenie metadát, história a audit používajú existujúcu atomickú mutáciu.
Nepotvrdený súbor môže zostať v privátnom úložisku bez väzby na prípad;
táto verzia nevytvára automatické čistenie úložiska.

**Úlohy** v detaile prípadu ukážu pripojené úlohy, ich riešiteľov, termín
a pracovný stav. Možno založiť úlohu priamo pre tento prípad, otvoriť detail,
začať prácu, odovzdať výsledok kolegovi na kontrolu, schváliť alebo vrátiť
prácu a pridať správu. Dostupnosť a oprávnenie na zmenu určuje existujúca
aktivácia pracovných úloh a serverové pravidlá webu. Výber riešiteľov
obsahuje iba aktívnych kolegov s prístupom; historické mená zostanú viditeľné.

Samostatná záložka **Moje úlohy** zobrazí úlohy priradené aktuálnemu
operátorovi naprieč prípadmi. Predvolene obsahuje otvorené aj oneskorené,
možno zahrnúť dokončené alebo prepnúť na úlohy, kde je operátor kontrolórom.
Výber „Na kontrolu“ zahŕňa aj úlohy ešte neodovzdané na kontrolu.
Vyhľadávanie používa doslovný názov, najviac 200 znakov; hviezdička sa
výslovne odmietne, aby PostgREST nezmenil doslovné hľadanie na wildcard.
Detail a správy používajú ten istý formulár ako úlohy prípadu.

Textové koncepty sa obnovujú podľa [kontraktu miestneho úložiska](drafts.md).

Nová úloha používa existujúci zápis bez identity pre opakovanie: po neistom
výsledku treba výslovne obnoviť a skontrolovať zoznam pred ďalším pokusom.
Pracovné zmeny a správy majú stabilné identity a overujú tú istú operáciu.
Neskoršie vypnutie dostupnosti alebo konflikt nezruší už neistú požiadavku.
Samotný obnovený detail nepotvrdzuje jej uloženie. Zmeny nepridávajú
nového pracovníka, pripomienkový cron ani nové kanály doručovania.

**Odovzdať prípad** ukáže úplný náhľad údajov určených príjemcovi, príjemcu,
pokyny, termín a platnosť odkazu. Možno vytvoriť odovzdanie, výslovne
publikovať aktuálne údaje, obnoviť odkaz, predĺžiť platnosť alebo odovzdanie
zrušiť s dôvodom. História obsahuje stav, zverejnenú verziu aj udalosti.
Pokročilé akcie závisia od existujúcej aktivácie odovzdávania na serveri.
Obnovenie odkazu mení prístupový odkaz, nepublikuje samo nové údaje prípadu.

Rozpracované vytvorenie a publikovanie zachovajú presný náhľad a jeho verziu.
Zmena prípadu na webe ich nenahradí bez vedomého rozhodnutia používateľa.
Neistý zápis overuje iba pôvodnú operáciu. Potvrdené uloženie zostane
potvrdené aj vtedy, keď sa odkaz nepodarí získať alebo sa nepodarí obnoviť
históriu. Získanie aktuálneho odkazu je samostatná akcia; starý odkaz po
obnovení nemusí byť možné znovu získať.

**Zdieľať odkaz** otvorí systémové zdieľanie až po stlačení používateľom.
Nevzniká automatická SMS ani e-mail. Odkaz sa drží iba v pamäti aktuálneho
účtu a po známej zmene odovzdania, skončení platnosti alebo odhlásení sa
prestane ponúkať. Výsledok systémového dialógu nepotvrdzuje doručenie.

## API a prístup

| Route | Výsledok |
| --- | --- |
| `GET /api/mobile/v1/drafts/scope` | Minimálna overená organizácia a profil pred otvorením chránených konceptov; bez zapisovania |
| `GET /api/mobile/v1/cases` | Stránka najviac 25 prípadov; `ownership=mine\|all\|unassigned`, `ownerId`, `category=open\|all`, `q` a `cursor` |
| `GET /api/mobile/v1/cases/dispatchers` | Najviac 200 ľudských dispečerov tej istej organizácie; iba ID, meno a aktívnosť |
| `GET /api/mobile/v1/cases/[id]` | Detail jedného prípadu organizácie |
| `GET/POST /api/mobile/v1/cases/[id]/owner` | Čerstvá revízia, aktívni kolegovia a oprávnenia; samostatné atomické priradenie s presným potvrdením |
| `GET /api/mobile/v1/maps/picker` | Privátna Google browser mapa, režim/cieľ/nonce v hlavičkách; výber potvrdí iba do miestneho formulára |
| `POST /api/mobile/v1/cases` | Založenie cez existujúcu mutáciu, ID/číslo potvrdeného prípadu a prípadné upozornenia |
| `PATCH /api/mobile/v1/cases/[id]` | Zmenené jednoduché polia, `expectedUpdatedAt` a `mutationId`; potvrdená revízia a upozornenia |
| `POST /api/mobile/v1/cases/[id]/notes` | Nový historický záznam; iba `note` a `mutationId`, potvrdené ID udalosti a upozornenia |
| `GET/POST /api/mobile/v1/cases/[id]/handoffs` | Úplný náhľad a existujúce odovzdania; pôvodné atomické príkazy alebo samostatné získanie aktuálneho odkazu |
| `GET/POST /api/mobile/v1/cases/[id]/attachments` | Zoznam do 200 príloh; ohraničený upload jednej prílohy |
| `GET /api/mobile/v1/cases/[id]/attachments/[attachmentId]/download` | Dočasný odkaz na presnú prílohu prípadu |
| `GET/POST /api/mobile/v1/cases/[id]/tasks` | Stránka do 25 pripojených úloh; vytvorenie iba pre prípad v ceste |
| `GET /api/mobile/v1/tasks` | Do 25 vlastných úloh; `view=assigned\|review`, `category=open\|all`, doslovný `q` a scope-bound cursor |
| `GET /api/mobile/v1/tasks/[id]` | Minimálny detail úlohy a pripojených prípadov |
| `GET /api/mobile/v1/tasks/colleagues` | Do 200 aktívnych ľudských kolegov s prístupom |
| `POST /api/mobile/v1/tasks/[id]/workflow` | Existujúci pracovný command/revision zápis, minimálne potvrdenie |
| `GET/POST /api/mobile/v1/tasks/[id]/messages` | Stránka do 50 správ; potvrdenie presnej správy autora |

Mobil posiela Supabase user JWT a `X-PM-App-Environment`. Server overí
podpis, projekt, platnosť tokenu, aktívny ľudský profil a rolu
dispatcher/senior_dispatcher/manager/admin. Actor ani organizácia sa
nepreberajú z formulára. Úspešné odpovede majú scope s profilom, prostredím,
verziou a časom; klient ho overí pred zobrazením.
Po overení konceptov mobil posiela aj `X-PM-Expected-Organization` s UUID.
Server porovná túto hodnotu s aktuálnou autorizovanou organizáciou, nikdy
ju nepoužije ako výber organizácie. Zmena vráti `409
expected_organization_mismatch` pred čítaním/zápisom prípadu alebo úlohy.

Čítanie vracia iba polia potrebné pre obrazovku. Súvisiace záznamy aj
vyhľadávanie sa obmedzia na organizáciu actor-a. API nevracia provider ID,
interný event payload ani cesty/údaje úložiska príloh. Samostatná požiadavka
na otvorenie prílohy vráti overený krátkodobý odkaz. Odpovede sú
`private, no-store` s `Vary: Authorization, X-PM-App-Environment`.

Konkrétny `ownerId` sa používa s `ownership=all`, server overí jeho členstvo
v organizácii a oprávnenú ľudskú rolu. Filter sa viaže na cursor aj cache;
neplatný alebo cudzí dispečer sa nesmie potichu nahradiť všetkými prípadmi.
Zoznam dispečerov nevracia e-mail ani prihlasovacie údaje.

POST povoľuje iba jednoduché polia `MobileCaseCreateInput` z
`src/lib/mobile-api.ts`, kontroluje typy a dĺžky a používa warning pravidlá
webového vytvárania. Potvrdený prípad sa nesmie vydávať za neúspešný nový
zápis len pre následnú chybu histórie alebo auditu; taká situácia sa musí
výslovne označiť upozornením. Neznámy výsledok sa neoznačuje ako úspech.

PATCH používa existujúci atomický zápis prípadu, súvisiacich údajov, histórie
a auditu. Zachová databázové mikrosekundy revízie a pri opakovaní overí
pôvodnú identitu a obsah. Záznam poznámky má vlastné UUID udalosti a marker;
opakovaný request musí mať rovnaký prípad, autora a text. Audit s rovnakou
identitou sa overí alebo doplní, jeho porucha sa nikdy nezamení za neuloženú
poznámku. Úspešné odpovede nevyžadujú úspech následného GET detailu.

Multipart obsahuje presne binárne pole `file` s pevným ASCII názvom
`attachment.bin` a JSON pole `command` s pôvodným UTF-8 názvom súboru,
kategóriou, poznámkou, revíziou a UUID. Server pred dekódovaním ohraničí
celú požiadavku a overí MIME aj podpis skutočných bajtov. Privátny bucket
je `motorist-case-attachments`; cesta vždy obsahuje organizáciu a prípad.
Opätovné použitie súboru overí úplné metadáta príkazu aj hash jeho obsahu.
Chýbajúce alebo neočakávané metadáta úložiska nepredstierajú úspech.

Úlohy používajú overený používateľský Supabase klient s verejným kľúčom
a presným Bearer tokenom, takže existujúce RPC vidia `auth.uid()`.
Samostatné serverové čítanie dostupnosti je potrebné preto, že tabuľka
konfigurácie povoľuje SELECT iba serverovej role. Toto čítanie nedáva
oprávnenie na úlohy ani ich zmeny. Stránkovanie vychádza z časov väzieb
na prípad, zachová mikrosekundy a viaže cursor na účet, organizáciu a prípad.

Odovzdanie používa ten istý overený používateľský klient a existujúce RPC
s `auth.uid()`. Mobil rozlišuje pôvodné potvrdenie mutácie od následného
získania odkazu. URL overí proti kanonickému prostrediu; nevracia tokenové
obálky, hashe ani interné generácie. Existujúce RPC zhromažďuje všetky
odovzdania a udalosti jedného prípadu bez databázového stránkovania.
Mobilný adaptér ohraničí dekódovanú odpoveď na 2 MiB, do 50 odovzdaní
a 200 udalostí na odovzdanie. Prekročenie vráti výslovnú chybu; nejde o
ohraničenie databázovej práce. Údaje náhľadu sa neskracujú: neznáma verzia,
pole alebo nadmerný obsah nemôžu viesť k publikovaniu neviditeľných údajov.

Priradenie pridáva samostatnú atomickú funkciu so schvaľovaním konkrétneho
SQL cieľa; ostatné časti používajú existujúcu schému. TEST používa iba
`nzpnqdstvkfncflgqlny` a
https://test.dispecing.linkapomoci.sk. Produkcia potrebuje osobitné
explicitné schválenie identifikovaného TEST rozsahu.

## TEST akceptácia

1. Overiť nasadený `dev` commit cez canonical `/api/health/live` a zhodu
   mobilného Expo Go zdroja s týmto obsahom.
2. Prihlásiť sa existujúcim TEST účtom. Otvoriť Prípady; skontrolovať
   predvolený filter, prepnutie vlastníka/stavov, vyhľadávanie a ďalšiu stránku.
3. Otvoriť detail a vybrať kontakt do ústredne. Nevznikne automatický hovor.
4. Založiť jednoznačne označený skúšobný prípad s neúplnými údajmi. Potvrdiť
   uložené číslo, vlastníka a rovnaké údaje v mobile aj na webe.
5. Prepnúť záložky počas rozpracovaného formulára a vrátiť sa; hodnoty ostanú.
6. Pri výpadku siete/strate odpovede zostane formulár a neistý stav. Opakovaný
   tap nespustí druhý POST; potvrdený prípad ostane potvrdený pri chybe GET.
7. Odhlásiť/prepnúť účet a odobrať prístup; cudzie alebo zamietnuté dáta
   sa nezobrazia. Neautorizované a neplatné požiadavky nemôžu zapisovať.
8. Upraviť skúšobný prípad, hlavnú poznámku a stav; skontrolovať rovnaké
   hodnoty na webe. Pri viacerých kontaktoch overiť primárny aj zachovanie ostatných.
9. Zmeniť prípad súčasne na webe: mobil zachová koncept a vyžiada vedomé
   rozhodnutie. Pri strate odpovede overovať iba pôvodnú požiadavku.
10. Pridať poznámku, prepnúť záložky počas konceptu a overiť jeden historický
    záznam aj po opakovanom overení neistého výsledku.
11. Otvoriť navigáciu k zobrazenému miestu. Po úprave adresy overiť nový cieľ.
12. Zobraziť a otvoriť skúšobnú prílohu; pridať fotografiu HEIC z iPhonu
    aj PDF. Overiť jeden uložený súbor a zhodu s webom, prekročenie limitu,
    zamietnuté oprávnenie, výpadok siete a súbežnú zmenu prípadu.
13. Pri aktivovaných úlohách založiť skúšobnú úlohu prípadu a overiť
    riešiteľa na webe. Dvoma TEST účtami prejsť odovzdanie na kontrolu,
    vrátenie a schválenie. Pri strate odpovede overiť tú istú operáciu.
14. Pridať správu a overiť jednu správu aj po opakovaní. Prepnúť záložky
    s rozpracovanou prílohou, úlohou alebo správou; koncept ostane.
15. Pri aktivovanom odovzdávaní otvoriť vlastný skúšobný prípad, skontrolovať
    všetky údaje náhľadu, vytvoriť odovzdanie a až potom vedome otvoriť
    systémové zdieľanie. Overiť stav a údaje na webe aj u skúšobného príjemcu.
16. Zmeniť prípad počas rozpracovaného náhľadu. Obnoviť a vedome potvrdiť
    nový náhľad; pri strate odpovede overiť pôvodnú identitu príkazu.
    Potvrdené uloženie musí zostať potvrdené aj bez dostupného odkazu.
17. Overiť samostatné získanie odkazu, obnovu, predĺženie a zrušenie.
    Zmeniť odovzdanie na webe, vypršať platnosť a prepnúť účet; mobil nesmie
    ponúknuť už známy neplatný odkaz ani zdieľať bez stlačenia používateľa.

Automatické kontraktové/UI testy, HTTP health/negative-auth checks a JS
exporty nepreukazujú fyzické prihlásenie, skutočnú databázovú mutáciu ani
live audio. Odovzdanie musí pomenovať konkrétnu vykonanú úroveň overenia.
