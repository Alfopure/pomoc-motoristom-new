# Priradenie dispečera a mapa prípadu

Rozsah z 12. 10. 2026 rozširuje mobilné prípady. Majiteľ výslovne vybral,
že už pridelený prípad môže preradiť kolegovi aj bežný dispečer.
Platí existujúce oprávnenie upravovať prípady: aktívny ľudský profil
v organizácii a rola dispatcher, senior_dispatcher, manager alebo admin.

## Priradenie

Detail ponúkne prevzatie otvoreného neprideleného prípadu a výber aktívneho
kolegu. Preradenie prideleného prípadu vyžaduje výber a výslovné potvrdenie.
Historický filter dispečerov obsahuje aj neaktívne osoby; tieto osoby sa
neponúkajú na nové priradenie. Prázdny vlastník znamená nepridelený prípad,
nie neaktívneho historického vlastníka. Zoznam má samostatný filter
**Nepriradené**; predvolené všetky otvorené prípady ostávajú zachované.

Server porovná presnú revíziu prípadu a znovu overí prístup autora aj cieľa.
Nové priradenie, historická udalosť, audit a potvrdenie príkazu patria do
jednej transakcie. Rovnaké UUID s rovnakým obsahom vráti pôvodné potvrdenie;
iné telo s tým istým UUID sa odmietne. Neistý výsledok zachová pôvodný
príkaz. Podobný obnovený vlastník nie je dôkaz uloženia. Potvrdený zápis
zostáva potvrdený aj pri chybe následného načítania alebo miestneho úložiska.

Prevzatie je iba pre otvorený voľný prípad. Už pridelený uzavretý prípad
možno opraviť podľa existujúcich oprávnení na úpravu, ale uzavretý voľný
prípad sa týmto postupom neprideľuje. Priradenie nepresúva úlohy a samo
nespúšťa hovor ani doručenie správy. Rozpracovaná bežná úprava ostáva
samostatným konceptom; prípadná zmena revízie vyžiada porovnanie pri uložení.

Táto operácia používa samostatnú databázovú funkciu. Migrácia a transakčné
pravidlá sú overené lokálne. Aplikovanie na konkrétny TEST projekt
`nzpnqdstvkfncflgqlny` vyžaduje výslovné schválenie podľa
[AGENTS.md](../../AGENTS.md). Chýbajúca funkcia sa zobrazí ako nedostupná
operácia; iná databázová chyba sa nesmie zameniť za vypnutú funkciu.
Produkčné SQL ani produkčné vydanie nie sú týmto rozsahom schválené.

Majiteľ schválil „Áno, aplikuj tieto dve funkcie iba na TEST“.
Migrácia `20261012183000_case_owner_assignment.sql` bola 12. 10. 2026
aplikovaná iba na `nzpnqdstvkfncflgqlny`. Overené sú telá oboch funkcií,
verzia 1 a vykonávanie výhradne serverovou rolou; prihlásený používateľ ani
anonymný klient nemajú priame SQL oprávnenie. Overenie katalógu nenahrádza
skúšku priradenia oprávneným operátorom cez nasadenú aplikáciu.

## Miesto zásahu a cieľ

Mapa používa existujúcu browser integráciu Google Maps/Places na správnom
aplikačnom hoste. Vlastná mobilná obrazovka zobrazí mapu cez WebView.
Nezavádza ďalší provider účet alebo kľúč. V bežnom pracovnom Preview
ostáva existujúci zákaz živých integrácií; dedikovaný TEST používa iba
svoje existujúce overené nastavenia.

Výber adresy alebo bodu najprv vytvorí miestny výber. Používateľ ho potvrdí
do formulára a prípad uloží samostatne. Samotný pohyb mapy alebo návrat
výsledku vyhľadávania nie je zápis. Zmena vstupu, cieľa, účtu alebo
zatvorenie mapy zneplatní oneskorené výsledky. Pri chybe mapy zostáva
ručné zadanie adresy použiteľné.

Detail dostane samostatnú mapovú projekciu: miesto zásahu, cieľ a prípadne
už prijatú polohu klienta. Uchová zdroj miesta a overené súradnice.
Chýbajúce, neúplné alebo neplatné súradnice sa nemenia na nulový bod;
skutočný bod `0,0` zostáva platný. Projekcia nevracia privátne tokeny
zdieľania ani surové metadáta. Nežiada polohu zariadenia a nezavádza
sledovanie na pozadí.

Zvolený bod a ručná adresa rovnakého cieľa sú vzájomne výlučné.
Ručná náhrada odstráni staré mapové miesto; nový bod odstráni zastaranú
ručnú náhradu. Zdroj Google, ručne zadaný bod a približná poloha sa
nezamieňajú. Súvisiace miesto používa existujúcu atomickú úpravu prípadu,
bez novej lokalizačnej schémy.

Prihlasovací token je iba v úvodnej HTTP hlavičke. Nie v URL, HTML,
konceptoch alebo požiadavkách na Google. Stránka používa privátne no-store
odpovede, obmedzenú navigáciu a bridge s jednorazovým identifikátorom,
režimom, cieľom a aktuálnym rozsahom účtu. Webový export zachová ručné
adresy; natívna WebView mapa potrebuje podporovaný Expo Go alebo nový
vlastný binárny balík.

Výslovná akcia kopírovania môže uložiť číslo prípadu, kontakt, EČV,
adresu alebo súradnice do systémovej schránky. Úspech sa zobrazí až po
potvrdení zápisu. Aplikácia obsah schránky sama nečíta ani nesleduje.

## Overenie na TESTE

1. Porovnať aktuálny canonical TEST commit s mobilným publikovaným zdrojom.
2. Dvoma oprávnenými TEST účtami preveriť prevzatie voľného prípadu,
   preradenie kolegovi, súbeh a jediný historický záznam po opakovaní.
3. Preveriť neaktívneho alebo cudzieho kolegu, neplatnú revíziu a odobranie
   oprávnenia. Zamietnutie nesmie vytvoriť čiastočný zápis.
4. Vo vlastnom označenom TEST prípade vybrať adresu aj bod pre oba ciele,
   potvrdiť ich do formulára, uložiť a porovnať súradnice/zdroj s webom.
5. Overiť starú ručnú adresu, prázdne/čiastočné súradnice, bod `0,0`,
   oneskorené vyhľadávanie, zatvorenie mapy a zmenu účtu.
6. Na fyzickom iPhone preveriť Google key/referrer, mapové ovládanie,
   natívny bridge a schránku. Nové vlastné Android/iOS balíky preveriť
   podľa ich zdroja a prítomných WebView/Clipboard modulov.

Lokálna SQL skúška, automatické serverové/mobilné testy a montované MOCK
obrazovky sú samostatné dôkazy. Neoprávnené HTTP kontroly nepreukazujú
priradenie oprávneným dispečerom; simulovaný mapový provider nepreukazuje
reálne výsledky Google ani fyzickú WebView. Systémové zvonenie a audio
zostávajú samostatným telefónnym míľnikom.
