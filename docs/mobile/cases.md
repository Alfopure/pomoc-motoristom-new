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
Zoznam možno filtrovať podľa konkrétneho dispečera alebo rýchlo prepnúť na
moje prípady. Výber obsahuje aj neaktívnych ľudských dispečerov organizácie,
aby sa dali nájsť staršie priradené prípady; označí ich ako neaktívnych.

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

Nová úloha používa existujúci zápis bez identity pre opakovanie: po neistom
výsledku treba výslovne obnoviť a skontrolovať zoznam pred ďalším pokusom.
Pracovné zmeny a správy majú stabilné identity a overujú tú istú operáciu.
Neskoršie vypnutie dostupnosti alebo konflikt nezruší už neistú požiadavku.
Samotný obnovený detail nepotvrdzuje jej uloženie. Zmeny nepridávajú
nového pracovníka, pripomienkový cron ani nové kanály doručovania.

## API a prístup

| Route | Výsledok |
| --- | --- |
| `GET /api/mobile/v1/cases` | Stránka najviac 25 prípadov; `ownership=mine\|all`, `ownerId`, `category=open\|all`, `q` a `cursor` |
| `GET /api/mobile/v1/cases/dispatchers` | Najviac 200 ľudských dispečerov tej istej organizácie; iba ID, meno a aktívnosť |
| `GET /api/mobile/v1/cases/[id]` | Detail jedného prípadu organizácie |
| `POST /api/mobile/v1/cases` | Založenie cez existujúcu mutáciu, ID/číslo potvrdeného prípadu a prípadné upozornenia |
| `PATCH /api/mobile/v1/cases/[id]` | Zmenené jednoduché polia, `expectedUpdatedAt` a `mutationId`; potvrdená revízia a upozornenia |
| `POST /api/mobile/v1/cases/[id]/notes` | Nový historický záznam; iba `note` a `mutationId`, potvrdené ID udalosti a upozornenia |
| `GET/POST /api/mobile/v1/cases/[id]/attachments` | Zoznam do 200 príloh; ohraničený upload jednej prílohy |
| `GET /api/mobile/v1/cases/[id]/attachments/[attachmentId]/download` | Dočasný odkaz na presnú prílohu prípadu |
| `GET/POST /api/mobile/v1/cases/[id]/tasks` | Stránka do 25 pripojených úloh; vytvorenie iba pre prípad v ceste |
| `GET /api/mobile/v1/tasks/[id]` | Minimálny detail úlohy a pripojených prípadov |
| `GET /api/mobile/v1/tasks/colleagues` | Do 200 aktívnych ľudských kolegov s prístupom |
| `POST /api/mobile/v1/tasks/[id]/workflow` | Existujúci pracovný command/revision zápis, minimálne potvrdenie |
| `GET/POST /api/mobile/v1/tasks/[id]/messages` | Stránka do 50 správ; potvrdenie presnej správy autora |

Mobil posiela Supabase user JWT a `X-PM-App-Environment`. Server overí
podpis, projekt, platnosť tokenu, aktívny ľudský profil a rolu
dispatcher/senior_dispatcher/manager/admin. Actor ani organizácia sa
nepreberajú z formulára. Úspešné odpovede majú scope s profilom, prostredím,
verziou a časom; klient ho overí pred zobrazením.

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

Nevzniká nová schéma, worker, cron, provider integrácia ani automatická SMS
či e-mail. TEST používa iba `nzpnqdstvkfncflgqlny` a
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

Automatické kontraktové/UI testy, HTTP health/negative-auth checks a JS
exporty nepreukazujú fyzické prihlásenie, skutočnú databázovú mutáciu ani
live audio. Odovzdanie musí pomenovať konkrétnu vykonanú úroveň overenia.
