# Hovor a prípad v mobile

V **Histórii** otvorte **Detail hovoru**. V **Ústredni** detail otvorí riadok hovoru na vašom účte; počas aktuálneho mobilného hovoru sa môže zobraziť ako **Detail aktuálneho hovoru**.

Detail ukazuje smer, číslo, stav, linku, dispečera, dostupné časy a dĺžku hovoru. Chýbajúca dĺžka sa nedopočítava. Pri priradenom prípade sa zobrazí jeho číslo, stav a stručné údaje; tlačidlo **Otvoriť prípad hovoru** načíta aktuálny detail prípadu. Telefónne ovládanie ostáva nad obrazovkou a dolné menu zostáva dostupné.

Zobrazuje sa iba výslovné uložené priradenie. Rovnaké telefónne číslo samo nepotvrdzuje súvislosť. Ak hovor nemá uložené priradenie, zobrazí sa ako nepriradený. Ak chýba odkazovaný prípad alebo relácia, odkaz je poškodený alebo sa projekcie hovoru a relácie nezhodujú, aplikácia oznámi, že priradenie nie je overené. Taký stav nezobrazuje ako nepriradený hovor.

## Použitie čísla

- **Vybrať číslo na volanie** prenesie číslo do ústredne; samotné vytáčanie vyžaduje stlačenie **Zavolať**.
- **Použiť číslo v novom prípade** otvorí existujúci formulár a zobrazí ponuku **Číslo z hovoru**. Vloženie vyžaduje potvrdenie; ak je telefón už vyplnený, ukáže sa pôvodné aj nové číslo a voľba nahradiť iba telefón. Ostatné rozpracované údaje zostanú zachované.
- **Pokračovať bez prenosu čísla** ponechá formulár bez zmeny. Prípad sa vytvorí až bežným uložením formulára; jeho vytvorenie samo nepriradí tento hovor. Hovor priradíte v časti [Po hovore](call-wrap-up.md).

Prenos je zablokovaný počas ukladania, pri neoverenom výsledku pôvodného uloženia, neplatnom koncepte alebo neuložených miestnych zmenách. Uložené potvrdenie prípadu sa musí najskôr bezpečne uchovať, až potom možno pripraviť nový koncept. Interná linka, skryté číslo a SIP adresa sa nepoužívajú ako telefón zákazníka. Medzinárodné predvoľby sa zachovávajú; národnému číslu sa nehádá krajina.

## Prístup a overenie

História používa existujúci prístup k hovorom organizácie. Detail relácie z ústredne vyžaduje vlastné priradenie alebo aktuálny vlastný leg či ponuku zvonenia; toto oprávnenie sa kontroluje aj po načítaní údajov. Identifikátory z histórie a ústredne majú výslovný typ a nikdy sa nezamieňajú.

API vyžaduje používateľské Bearer prihlásenie a očakávanú organizáciu. Všetky čítania sú obmedzené na organizáciu a vracajú úzky súbor údajov s `private, no-store`; neposielajú nahrávky, poznámky, udalosti ani identifikátory poskytovateľa. Detail nemá zápisové operácie ani živé volania poskytovateľa. Zmena účtu, organizácie, výberu alebo skrytie obrazovky vyradí staré výsledky; návrat na popredie načíta nové údaje.

Automatické testy a kontrolovaný náhľad skutočného rozhrania overujú oddelenie účtov, relácií a hovorov, prepojenia a zachovanie konceptov. Nenahrádzajú skúšku s prihláseným dispečerom a fyzickým iPhonom. Systémové zvonenie a zvuk sú samostatné natívne akceptačné kroky.
