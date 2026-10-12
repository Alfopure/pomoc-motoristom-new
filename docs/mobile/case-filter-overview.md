# Mobilný prehľad a filtre prípadov

Prípady sa stále otvárajú ako **všetky otvorené prípady**. Prehľad zobrazuje
počty otvorených, mojich, nepriradených a urgentných otvorených prípadov
celej organizácie. Výber počtu otvorí príslušný zoznam a odstráni predchádzajúci
text, dispečera a konkrétny stav/prioritu. Urgentné znamená prioritu `urgent`.
Tieto skupiny sa prekrývajú; ich súčet nie je počet všetkých prípadov.

Samostatný výber stavu ponúka všetky otvorené, všetky stavy alebo konkrétny
stav podľa webu. Priorita sa dá kombinovať s textom a dispečerom. Zmena
filtra začne prvou stránkou; cursor z iného filtra server odmietne. Pri
oneskorenej odpovedi sa nezobrazí stránka z predchádzajúceho výberu.

Počty používa `GET /api/mobile/v1/cases/overview` s rovnakým overeným
ľudským používateľom a organizačným rozsahom ako zoznam. Neprijíma parametre,
cookies, výber inej organizácie ani iného operátora. Štyri samostatné
databázové dotazy vracajú presné počty, nie súčet načítanej stránky.
Majú spoločný časový limit osem sekúnd; chyba alebo chýbajúci počet vedie
k výslovnej chybe. Nula sa zobrazí iba po úspešnom výsledku. Počty sa môžu
pri súbežnej práci dispečerov na okamih rozchádzať, pretože nejde o spoločný
databázový snapshot. Rozhranie uvádza čas posledného overenia.

Zoznam prijíma voliteľné `status` a `priority`; aktívne hodnoty sa overia,
vrátia vo výbere a zahrnú do väzby cursora. Nezvolené hodnoty zachovávajú
pôvodný význam a cursor. Konkrétny uzavretý stav vyžaduje `category=all`.
Mobil odmietne odpoveď, ktorá zvolený filter nepotvrdí. Starší server môže
vynechať nové polia len pre výber bez týchto filtrov.

Neisté založenie prípadu vždy otvorí celý zoznam bez dispečera, textu,
stavu a priority. Obmedzený výber ani počet z prehľadu nepredstavujú kontrolu
pôvodného zápisu a nepovolia automatické opakovanie založenia. Potvrdené
zmeny stavu, priority alebo priradenia obnovia aj prehľad počtov.

## Skúška v TEST

1. Otvoriť príslušnú overenú aktualizáciu v Expo Go a prihlásiť sa TEST účtom.
2. V Prípadoch porovnať štyri počty s otvorenými prípadmi na TEST webe.
   Výber urgentných má ukázať iba otvorené prípady s touto prioritou.
3. Skombinovať konkrétny stav, prioritu, text a dispečera. Prepnúť filter
   počas načítania ďalšej stránky; nesmú sa primiešať predchádzajúce výsledky.
4. Na vlastnom označenom TEST prípade zmeniť prioritu, stav alebo dispečera;
   po návrate porovnať obnovené počty. Skúška nikoho automaticky nekontaktuje.
5. Pri chybe prehľadu musí zostať dostupný zoznam a opakovanie načítania;
   chyba nesmie zobrazovať vymyslené nulové počty. Odhlásenie odstráni
   výsledky predchádzajúceho účtu.

Tento rozsah nepridáva SQL, natívne závislosti, provider konfiguráciu ani
automatické odosielanie. Overenie zdroja, MOCK rozhrania, publikovaného
balíka a zamietnutých API požiadaviek nenahrádza prihláseného operátora,
fyzické úložisko alebo systémové telefonovanie. Produkčné vydanie stále
vyžaduje samostatné schválenie identifikovaného TEST rozsahu.
