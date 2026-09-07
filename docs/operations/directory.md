# Spoločný adresár

V **Nastavenia → Adresár** sú firmy, asistenčné spoločnosti, pobočky a kontaktné osoby. Vyhľadávanie rozumie názvom bez diakritiky aj telefónnym číslam s rôznym formátovaním. Záznamy možno filtrovať podľa typu a stavu.

Dispečeri môžu adresár prezerať a volať na uložené čísla. Manažér a administrátor môžu pridávať a upravovať záznamy. Detail sa otvára v bočnom paneli; na mobile zaberá celú šírku.

## Správa záznamov

- **Firma a asistencia:** názov, telefón, e-mail, IČO, zameranie, adresa, web a interná poznámka. K záznamu možno priradiť existujúce kontaktné osoby alebo vytvoriť novú osobu priamo z detailu. Tlačidlo **Prevziať z prípadov** zachováva existujúci import používaných asistenčných spoločností.
- **Pobočka:** adresa a poloha na mape, telefón, e-mail, kontaktné osoby a voliteľná materská firma alebo asistencia. Adresu možno vyhľadať alebo zadať ručne spolu so súradnicami. Počet náhradných vozidiel z integrácie má prednosť pred ručnou dostupnosťou.
- **Kontaktná osoba:** meno, telefón alebo e-mail, zaradenie a poznámka. Ide o tie isté kontakty, ktoré aplikácia používa pri prípadoch a telefonovaní.

Firmy a asistencie možno archivovať a obnoviť. Kontakty a pobočky sa v tomto rozhraní nemažú: kontakty sú súčasťou histórie a vyradenie pobočky vyžaduje vyriešiť jej vozidlá a prípady.

Ak kolega záznam medzičasom upraví, uloženie oznámi konflikt a ponechá rozpísané údaje otvorené. Obnovenie zoznamu samo neprepíše rozpracovaný formulár. Escape a zatvorenie panela upozornia na neuložené zmeny.

Nová osoba vytvorená z detailu firmy sa najprv uloží ako kontakt a potom priradí k firme. Ak druhý krok zlyhá, adresár potvrdí uloženie kontaktu a vysvetlí, že ho treba priradiť cez **Priradiť existujúcu osobu**. Nevytvárajte ho znova.

## Dáta a rozhranie

Používajú sa existujúce tabuľky vlastného Supabase projektu: `motorist_partner_directory`, `motorist_branches`, `motorist_contacts` a `motorist_locations`. Prepojenia a doplnkové údaje firiem a pobočiek sú v `metadata.directory`; poznámka zachováva existujúce `metadata.note`. Nie je potrebná migrácia ani zmena prostredia. Staršie formuláre pri úprave partnera zachovávajú tieto metadáta.

`GET /api/directory` vracia záznamy organizácie prihláseného používateľa. `POST /api/directory` vytvára záznam a `PATCH /api/directory/[kind]/[id]` ho aktualizuje s povinným `expectedUpdatedAt`. Server kontroluje rolu, organizáciu, pôvod požiadavky, vstupy aj prepojené záznamy. Konflikt verzie vracia HTTP 409. Obnova celej konzoly po úspešnom uložení je oddelená od výsledku samotného zápisu.

Pred uložením sa kontrolujú existujúce duplicity. Databáza však nemá jedinečný index pre identické kontakty a pobočky: dva súbežné nové zápisy z rôznych klientov môžu vytvoriť duplicitu. Aktualizácie existujúcich záznamov používajú atómovú kontrolu verzie.

Zmena polohy pobočky vytvorí nový bod, aby nemenila historické záznamy používajúce pôvodnú polohu. Bežná úprava telefónu alebo dostupnosti polohu nekopíruje.

## Overenie

Serverové a modelové testy pokrývajú oprávnenia, izoláciu organizácií, neplatné vstupy, konflikty, prepojenia a zachovanie metadát. `e2e/directory.spec.ts` spúšťa skutočné komponenty s lokálnymi dátami a blokovanými externými požiadavkami: vytvorenie, úpravu, archív, kontakty, pobočky, chyby ukladania, volanie a zobrazenie pri šírkach 390 a 1440 px. Testy nezapisujú do spoločnej databázy a neuskutočňujú telefónne hovory.
