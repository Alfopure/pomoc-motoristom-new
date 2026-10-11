# Mobilné prípady

Rozsah požadovaný majiteľom 11. 10. 2026 počas čakania na Apple členstvo.
Funguje v Expo Go a používa rovnaké uložené prípady ako webový dispečing.
Fyzické iPhone telefonovanie zostáva samostatným neovereným míľnikom.

## Prvá verzia

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

Úpravy, zmeny stavu, ďalšie poznámky, fotografie, mapy, priraďovanie vozidiel
a úlohy sú ďalšie navrhnuté kroky.

## API a prístup

| Route | Výsledok |
| --- | --- |
| `GET /api/mobile/v1/cases` | Stránka najviac 25 prípadov; `ownership=mine\|all`, `ownerId`, `category=open\|all`, `q` a `cursor` |
| `GET /api/mobile/v1/cases/dispatchers` | Najviac 200 ľudských dispečerov tej istej organizácie; iba ID, meno a aktívnosť |
| `GET /api/mobile/v1/cases/[id]` | Detail jedného prípadu organizácie |
| `POST /api/mobile/v1/cases` | Založenie cez existujúcu mutáciu, ID/číslo potvrdeného prípadu a prípadné upozornenia |

Mobil posiela Supabase user JWT a `X-PM-App-Environment`. Server overí
podpis, projekt, platnosť tokenu, aktívny ľudský profil a rolu
dispatcher/senior_dispatcher/manager/admin. Actor ani organizácia sa
nepreberajú z formulára. Úspešné odpovede majú scope s profilom, prostredím,
verziou a časom; klient ho overí pred zobrazením.

Čítanie vracia iba polia potrebné pre obrazovku. Súvisiace záznamy aj
vyhľadávanie sa obmedzia na organizáciu actor-a. API nevracia provider ID,
interný event payload ani odkazy/prístupové údaje príloh. Odpovede sú
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

Automatické kontraktové/UI testy, HTTP health/negative-auth checks a JS
exporty nepreukazujú fyzické prihlásenie, skutočnú databázovú mutáciu ani
live audio. Odovzdanie musí pomenovať konkrétnu vykonanú úroveň overenia.
