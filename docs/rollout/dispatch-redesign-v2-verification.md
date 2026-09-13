# Dispečing V2 — výsledok a overenie

Tento dokument opisuje realizáciu [plánu V2](dispatch-redesign-v2.md). Predchádzajúci `live-layout-preview.md` je historický plán prvej ukážky; jeho odloženie kontroly úloh a externého odovzdania už neplatí.

## Výsledná aplikácia

- Nová navigácia a hierarchia kariet, kontakt/vozidlo/miesto/cieľ v prehľade, rýchle prechody do častí prípadu a tri predvoľby rozdelenia pracovnej plochy. Zachované filtre, radenie, tabuľkové stĺpce, formuláre a vlastné rozmery panelov.
- Skutočné spoločné stavy úloh Na vybavenie, Rozpracované, Na kontrolu, Vybavené. Termín zostáva samostatný údaj. Výber kontrolóra, súkromné upozornenie, vlastná fronta kontrol, schválenie alebo vrátenie s dôvodom a ďalšie odovzdanie. Vrátenú kontrolu nemožno obísť obyčajným dokončením. Lokálna tabuľa a widget majú kompaktné filtre, hlavná obrazovka väčší priestor.
- Prepracované pastelové poznámky, kalkulačka s displejom a mazaním, kalendár s agendou a galéria osobných nástrojov. Rýchle otvorenie poznámok/kalkulačky/kalendára nemení poradie ostatných widgetov.
- Presúvanie všetkých bodov trasy myšou, klávesnicou aj šípkami zachová vybrané miesta. Zmena poradia zruší zastaraný výpočet; nový výpočet sa spúšťa explicitne.
- Pomôcka pre označené textové podklady ukáže návrhy, konfliktné hodnoty a pôvodné hodnoty formulára. Používateľ vyberie konkrétne polia. Používa existujúce automatické ukladanie a pri ručnej adrese odstráni staré súradnice. Nejde o AI interpretáciu voľného textu. Originál zostáva počas otvorenia karty a dá sa stiahnuť ako presný textový súbor; automaticky sa nearchivuje do databázy.
- Externé odovzdanie má vlastný obmedzený odkaz a mobilnú kartu, náhľad zverejnených údajov, prijatie/odmietnutie, priebeh, odhad príchodu a dokončenie. Zverejnenie nových údajov, obnovenie a zrušenie odkazu sú explicitné akcie. Prijatie odkazu neznamená prihlásenie do aplikácie a dokončenie úkonu samo neuzavrie interný prípad.

## Izolácia a návrat

Vetva `feat/live-layout-preview` vychádza z `dev` a ostáva v draft PR167 do `dev`. Produkčné vydanie nie je súčasťou tohto náhľadu. Predošlý frontend je zachovaný v commite `3c47c6e2b6b634a1897a26d20c40589c0002ecc1` a jeho samostatnom immutable Preview.

Používa sa existujúci projekt `pomoc-motoristom-telnyx` (`ifpaeegaesdmljfkdvcn`, Frankfurt). Nevytvorila sa nová spoločná databáza ani seed. Dve aditívne migrácie zavádzajú iba úlohy/kontrolu a obmedzené externé odovzdanie. Testy PostgreSQL pracujú s dočasnými lokálnymi databázami na loopback rozhraní a po sebe ich odstránia.

Prepínač vzhľadu zachová otvorenú prácu. Nevracia uložené údaje ani pracovný tok: kontrolór a história musia zostať zachované aj pri použití staršieho frontendu. Staré task zápisy sú chránené pred obídením kontroly. Návrat nesmie odstraňovať nové stĺpce alebo rušiť kontrolórov.

Náhľad používa skutočné spoločné údaje testovacej kópie. Browser testy používajú izolované odpovede a syntetické dáta; neposielajú živé SMS ani hovory. Pri správe pre externého kolegu sa používa existujúca samostatná SMS s explicitným telefónom kolegu, nie automatický klientsky príjemca prípadu. Vypínače odosielania sa nemenia.

## Kontroly

- Plán prešiel sekvenčnou nezávislou architektonickou a kritickou recenziou; schválený SHA-256 `2d93dc7cbf73366dc51d782c002296aa65f3eb6bbd73f1e213191fdc4cb3fcc5`. Ide o poradný postup podľa Ralplan, nie predstierané natívne OMX oprávnenie.
- 162 spoločných browser scenárov pre konzolu, widgety, trasy, pôvodné aj nové úlohy, SMS, formuláre a životný cyklus providerov prešlo; samostatný nový test presného stiahnutia pôvodného textu tiež prešiel.
- Nová kompaktná tabuľa bola overená aj pri výške 300 px, celý dispečing na šírkach 360, 390, 768, 1024, 1280, 1366 a 1440 px. Notebookové a mobilné snímky boli vizuálne skontrolované.
- 26 integračných testov úloh na skutočnom lokálnom PostgreSQL prešlo: práva, súbeh, opakovanie, súkromné upozornenia, staré zápisy a transakčný rollback.
- 29 nezávislých PostgreSQL testov externého odovzdania prešlo. Opravená zámena prípadu pri dvoch otvorených kartách, kontrola expirácie po čakaní na zámok, uchovanie ETA a správny príjemca SMS. Bezpečnostná recenzia: APPROVE.
- Kompletná sada: 3 691 Vitest testov prešlo (2 už existujúce preskočené), 43 Node testov prešlo (1 už existujúci preskočený). TypeScript a ESLint zmenených súborov prešli.
- Obe migrácie sú aplikované iba na povolenej testovacej kópii. Overená evidencia migrácií, dostupnosť funkcií, RLS a oprávnenia. Pri overení bolo 0 nových workflow zápisov a 0 externých odovzdaní; nevytvárali sa živé testovacie prípady.
- Všetkých 12 browser testov externého odovzdania prešlo. Spolu je overených 175 jedinečných browser scenárov (162 spoločných + 1 stiahnutie originálu + 12 odovzdaní); ďalších 15 dotknutých scenárov prešlo po oprave zarovnania widgetov a do súčtu sa nezapočítava druhýkrát. Finálny Next build prešiel. Overenie nasadeného náhľadu zostáva otvorené do kontroly presného commitu a nasadenia.

Živé kontroly nasadenia sú čítacie: presný commit a úspešný build, prihlásenie, verejná karta bez tokenu, hlavičky a blokovanie neoprávneného API. Nejde o tvrdenie o odoslaní skutočnej SMS, reálnom telefonáte alebo fyzickom teste nainštalovanej iOS PWA.
