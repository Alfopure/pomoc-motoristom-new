# Miestne mobilné koncepty

Rozšírenie z 12. 10. 2026 pridáva obnovu nového prípadu, jeho úprav,
poznámky, novej úlohy, správy/pracovného príkazu a odovzdania. Koncept
nemá offline frontu a po obnove sa nič samo neodosiela.

Priradenie dispečera má vlastný záznam `case.owner` pre konkrétny prípad.
Úprava prípadu a priradenie sa obnovujú oddelene; neisté priradenie zachová
pôvodné UUID, cieľového kolegu a presnú revíziu. Nové mapové miesto je
vnorená hodnota formulára s vlastnou verziou kodeku. Starší presný príkaz
bez mapových polí sa pri obnove nedopĺňa novými predvolenými hodnotami.
Prihlasovacie hlavičky mapy a WebView sa do konceptov neukladajú.

## Obnova a neisté uloženie

V účte je zoznam záznamov podľa druhu a času. „Pokračovať“ otvorí príslušný
formulár; pri úprave prípadu najprv načíta aktuálny detail. Zachová iba
rozpracované polia a pôvodnú revíziu. Zmena kolegu vyžiada porovnanie.

Pred odoslaním sa znovu overí účet/organizácia a miestne uloží presný
príkaz. Až potvrdenie úložiska dovolí sieťovú požiadavku. Pád počas
odosielania sa obnoví ako neistý výsledok, s pôvodným UUID, telom,
termínom alebo úplným náhľadom odovzdania. Výslovné overenie znovu používa
ten istý príkaz. Neskoršia chyba oprávnenia nezruší pôvodnú neistotu.
Samotný detail, podobný text ani názov súboru nie sú potvrdením mutácie.

Založenie prípadu a novej úlohy nemá serverovú identitu pre opakovanie.
Po obnove preto vyžaduje čerstvý príslušný zoznam a vedomé rozhodnutie
pred ďalším pokusom. Potvrdený serverový výsledok zostáva potvrdený aj
pri chybe miestneho uloženia; nový formulár sa uvoľní až po potvrdenom
uložení výsledku alebo vedomom zahodení záznamu.

Fotografia ani dokument sa miestne nepersistujú. Po reštarte ostanú len
metadáta a pôvodný príkaz. Neistý upload bez bajtov sa nedá zopakovať;
mobil vyžiada čerstvý zoznam príloh a výslovné potvrdenie pred novým
výberom. Používateľ musí skontrolovať, či pôvodná príloha už existuje.

## Úložisko a oddelenie účtov

Autoritatívny kľúč zahŕňa prostredie, Supabase projekt, používateľa,
profil a organizáciu. Overený endpoint `/api/mobile/v1/drafts/scope`
predchádza prvému načítaniu. Odobratie oprávnenia, neplatný kontrakt,
zmena organizácie či skutočný prechod účtu zneplatní staré formuláre.
Obyčajná obnova tokenu rovnakého účtu ich zachová. Staršia odpoveď
nemôže zrušiť novšie overenie alebo zamietnutie.

Na iOS používa samostatnú Keychain službu a
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`; prihlasovanie má svoju existujúcu
službu/queue a dostupnosť pre natívne prebudenie hovoru. Všetky časti
väčšieho konceptu zostávajú v Keychain/Keystore. Autoritatívny manifest
sa zmení až po potvrdení každej časti, takže neúspešný zápis neprepíše
poslednú verziu pred pokusom o publikovanie manifestu. Zlyhanie samotného
publikovania môže zanechať neúplný alebo neoveriteľný stav; obnova vtedy
zostane zablokovaná a súbor sa automaticky nenahradí prázdnym konceptom.

Android vyžaduje natívnu kontrolu potvrdenia zápisu SecureStore.
Priložený build plugin pre presnú verziu 57.0.4 opravuje `commit() ==
false`, zapína kompiláciu tohto modulu zo zdroja a registruje natívnu
capability. Starší Android build/Expo Go a web používajú iba pamäť,
ktorú rozhranie výslovne označí. Nepodporovaný Android nesmie existujúci
chránený manifest potichu nahradiť pamäťou; obnova zostane zablokovaná
do použitia podporovaného buildu alebo vedomého zahodenia.

Ukladajú sa iba ohraničené polia formulárov a potvrdenia. Nie heslá,
auth/provider tokeny, dočasné odkazy, celé query cache, lokálne URI
ani bajty súborov. Limit je 32 záznamov, 90 000 Unicode znakov na účet
a 64 000 na záznam. Neisté záznamy sa automaticky nevyhadzujú.

Bežné odhlásenie čaká na uloženie všetkých otvorených miestnych záznamov
tohto účtu, aj z predchádzajúcej organizácie. Pri chybe zostane prihlásené
a ponúkne opravu. Výslovná voľba „Odhlásiť bez neuložených zmien“ má
potvrdzovací dialóg, ktorý upozorní na možnú stratu novších údajov.
Staršie chránené záznamy sa nemažú a serverové zápisy sa tým nerušia.
Samostatné „Zahodiť“ ruší iba miestny záznam, nie existujúci serverový údaj.

## Akceptácia

Automatické testy overujú poradie zápisov, obnovenie presných príkazov,
oneskorené odpovede po zavretí obrazovky, zmenu účtu/organizácie,
chyby úložiska a neobnovenie vedome zmazaného záznamu. Montované MOCK
skúšky používajú skutočné obrazovky a ovládače so syntetickou sieťou,
auth a úložiskom. To nepreukazuje natívne šifrovanie ani fyzickú obnovu.

Na legitímnom TEST účte na iPhone a podporovanom Android builde treba:

1. Rozpísať každý textový formulár, počkať na miestne uloženie, ukončiť
   aplikáciu a znovu prihlásiť rovnaký účet. Obnoviť rovnaké hodnoty.
2. Skúsiť prerušenie počas zápisu; overiť neistý stav a rovnaký príkaz,
   bez automatického druhého zápisu alebo kontaktovania príjemcu.
3. Prepnúť účet, organizáciu a oprávnenia; cudzie koncepty sa neotvoria.
4. Pridať prílohu a prerušiť odozvu; po reštarte preveriť chýbajúci súbor,
   čerstvú kontrolu zoznamu a vedomé povolenie nového výberu.
5. Overiť nedostatok miesta/zamknuté úložisko a oba postupy odhlásenia.

Native build, DEX kontrola, simulator startup a MOCK skúšky ostávajú
samostatnými dôkazmi. Skutočný operátorský zápis, disk-full správanie,
voice/audio a zamknuté systémové zvonenie sa prijímajú osobitne.
