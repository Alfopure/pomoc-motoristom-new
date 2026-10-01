# Rozšírené odovzdanie prípadu — implementačný a nasadzovací plán

Pôvodný stav k 1. 10. 2026: **plán, nie vykonané nasadenie**. Pôvodná požiadavka povoľovala iba dokumentáciu. Následne majiteľ výslovne schválil implementáciu a vydanie výhradne do TEST na vlastné prebratie; produkcia čaká na jeho ďalšie výslovné schválenie. Kroky nižšie sú plánovaný postup, nie dôkaz dokončeného nasadenia; nezaškrtávajú sa bez konkrétneho dôkazu. Živé SMS nie sú súčasťou tohto vydania.

Plán nadväzuje na [existujúce externé odovzdanie V2](external-case-handoff.md) a [runbook samostatného TEST prostredia](../operations/full-test-environment.md). Historické výsledky v týchto dokumentoch nie sú overením tohto rozšírenia ani aktuálneho vzdialeného nasadenia.

## 1. Cieľ a rozsah prvého vydania

Príjemca dostane prehľadnú mobilnú kartu zásahu bez účtu dispečingu. Dispečer dokáže rovnaký odkaz opäť získať, skopírovať a pripraviť na odoslanie aj po zatvorení detailu alebo obnovení stránky. Karta obsahuje identifikáciu prípadu a asistenčky, odstavené aj dostupné náhradné vozidlo, trasu, kontakty, praktické pokyny a jasne pomenované časové údaje.

Prvé vydanie zachová:

- Jeden aktívny grant pre konkrétny prípad; nejde o univerzálny odkaz na všetky prípady ani o novú partnerskú aplikáciu.
- Predvolenú platnosť 24 hodín a voľby 12/24/48/72 hodín. Predĺženie je výslovné, najviac na 72 hodín od vykonania akcie; nevzniká trvalý verejný prístup.
- Existujúci priebeh Prijaté → Na ceste → Na mieste → Dokončené, odmietnutie s dôvodom, ETA a hlásenie problému.
- Explicitné zverejňovanie údajov a presný náhľad pre dispečera. Úprava interného prípadu sama nezmení zdieľanú kartu.
- Samostatný SMS editor pre kolegu, potvrdenie príjemcu aj odoslania a existujúce integračné guards. Žiadne automatické odoslanie.

Mimo rozsahu sú OTP, prílohy a protokoly na verejnej karte, plná editácia prípadu príjemcom, nové fleet integrácie, nové kalendárové úlohy, workers, listeners alebo cron. Dokončenie externého úkonu samo neuzavrie interný prípad.

## 2. Východiskový stav a čo treba zmeniť

Zistenia z lokálneho kódu, nie zo vzdialenej databázy:

- URL sa dnes uloží iba do React stavu `CaseHandoffPanel`. Po zatvorení panela alebo reloade ju dispečer stráca.
- Verejný token nie je jednorazový; pôvodný odkaz možno počas platnosti opakovane vymeniť za session.
- Databáza uchováva iba SHA-256 tokenu. Z tohto hashu sa pôvodný odkaz nedá obnoviť; nestačí doplniť tlačidlo alebo `localStorage`.
- Dnešné Obnoviť odkaz rotuje token a zneplatní staré sessions. Treba oddeliť znovuzískanie odkazu, predĺženie platnosti a bezpečnostnú rotáciu.
- Existujúci snapshot má základné vozidlo, kontakt, miesto/cieľ, pokyny a termín, nie náhradné auto, asistenčnú referenciu ani nové metadáta.
- `selectedAssetId` môže označovať odťahové aj náhradné vozidlo. Bez overenia typu a priradenia ho nemožno prezentovať ako náhradné auto.

Pred implementáciou porovnať aktuálny `dev`, túto pracovnú vetvu a skutočne aplikované handoff migrácie. Starý runbook nesmie slúžiť ako dôkaz, že konkrétna verzia je už v TEST alebo produkcii.

## 3. Práca dispečera a životný cyklus odkazu

| Akcia | Výsledok | Token a existujúce sessions |
|---|---|---|
| Otvoriť panel | Načítať prehľad a náhľad; nevytvárať grant ani neposielať správu | Bez zmeny |
| Kopírovať odkaz | Oprávnený server znovu vydá rovnakú URL aktuálneho platného grantu | Bez zmeny |
| Poslať znova cez SMS | Otvoriť vlastnú správu pre uloženého príjemcu s rovnakou URL; odoslať až po potvrdení | Bez zmeny |
| Predĺžiť platnosť | Explicitne posunúť expiráciu; ukázať nový dátum platnosti | Rovnaký token a generácia; už expirovaná session sa sama neobnoví |
| Aktualizovať údaje v odkaze | Zverejniť presne schválený aktuálny náhľad a zvýšiť jeho verziu | Rovnaký token; stará revízia rozhodnutia sa odmietne |
| Zneplatniť odkaz a vytvoriť nový | Potvrdená bezpečnostná rotácia pre toho istého príjemcu | Nový token/generácia; starý odkaz aj sessions prestanú fungovať |
| Zrušiť odovzdanie | Zaznamenať dôvod a zablokovať prístup | Všetky jeho prístupy neplatné |

Predĺženie nesmie meniť príjemcu, zverejnené údaje, ETA ani prijatý stav. Pri expirovanom, ale inak rozpracovanom grante je obnovenie platnosti samostatné potvrdenie s upozornením, že znovu sprístupní pôvodný bearer odkaz. Zrušené, dokončené a odmietnuté odovzdanie sa takto neotvára; nový úkon vyžaduje nový grant.

Zmena príjemcu znamená zrušiť pôvodné odovzdanie a vytvoriť nové, nie prepísať meno pri existujúcom tajomstve. Meno príjemcu je označenie zamýšľaného držiteľa, nie overená identita; celý odkaz môže byť preposlaný ďalšej osobe.

Rozpracované pokyny alebo SMS sa nesmú prepísať obnovením prehľadu. Po rotácii sa nový odkaz vloží do otvoreného SMS konceptu až po výslovnom kliknutí. Kopírovanie ani otvorenie editora nesmie vytvoriť udalosť SMS odoslaná alebo doručená.

## 4. Obsah mobilnej karty a pravidlá zdrojov

| Časť | Zverejnené údaje | Pravidlo zdroja a chýbajúcich údajov |
|---|---|---|
| Identifikácia | Interné číslo prípadu, typ úkonu, názov asistenčnej služby, Číslo prípadu asistenčky | Použiť `caseNumber`, `customerDetails.assistanceServiceName` a `assistanceReference`. Pre legacy dáta preveriť fallback na `assistance_reference`. Neoznačiť nepoužívané `external_reference` za ďalšie známe číslo bez overenia významu. |
| Odstavené vozidlo | Značka, model, EČV, farba, známa pojazdnosť a relevantné obmedzenia naloženia | Zachovať základné existujúce polia a pridať pevne povolené technické údaje. Neznámy stav nesmie znamenať pojazdné. Neprenášať celé poznámky k vozidlu. |
| Náhradné vozidlo | Potreba, požadovaná kategória a praktické preferencie, stav poskytnutia; značka/model/EČV konkrétneho priradeného auta | Konkrétne auto iba pri overenom priradení k tomuto prípadu, rovnakej organizácii a type `replacement_car`. Požiadavka na auto nie je pridelené auto. Rozlíšiť Nepotrebuje, Zatiaľ nepriradené a Neposkytnuté. Pri nejednoznačnosti nepriradenie neprikrášľovať odhadom. |
| Trasa zásahu | Miesto vyzdvihnutia → cieľ odťahu, adresa a dostupné súradnice | Existujúce mapové body alebo presné `manualPickupAddress`/`manualDestinationAddress`. Chýbajúci cieľ označiť Cieľ zatiaľ neurčený, nie vymyslieť adresu. |
| Pristavenie náhradného auta | Samostatné miesto doručenia, ak je potrebné alebo odlišné | Použiť `replacementVehicle.deliveryPlace`; nesplýva automaticky s cieľom odťahu. Textová adresa má navigáciu aj bez súradníc; netreba novú geokódovaciu integráciu. |
| Kontakty | Hlavná kontaktná osoba pri vozidle a klikateľný telefón; oficiálny kontakt dispečingu, ak je nakonfigurovaný | Jeden vhodný klientsky kontakt. Kontakt dispečingu z overenej konfigurácie organizácie, nie z osobného emailu, náhodného profilu alebo neoverenej klapky. |
| Praktické informácie | Stručný opis poruchy, počet osôb na prepravu, povolené komplikácie prístupu, dohodnutý čas a osobitné pokyny | Dispečer musí mať viditeľný náhľad každého zverejneného textu; zdieľať iba vybrané polia relevantné pre realizáciu. |
| Časové údaje | Vytvorenie prípadu, prvý súvisiaci prichádzajúci hovor, vytvorenie odovzdania, posledné zverejnenie a platnosť | Čas hovoru iba z hovoru prepojeného na tento prípad v rovnakej organizácii; pri viacerých použiť prvý podľa `started_at`. Označiť ho Prvý súvisiaci hovor, nie automaticky čas nahlásenia. Bez hovoru položku vynechať. |
| Pôvod odovzdania | Odovzdanie vytvoril: zobrazované meno dispečera, prípadne názov organizácie | Vychádzať zo skutočného `created_by` grantu, nie z vlastníka prípadu. Zachovať pôvodného autora; ďalšie zverejnenia majú vlastného aktéra a čas. |

Konkrétne náhradné auto je pred implementáciou povinný bod dátového preverenia. Ak jediný `selectedAssetId` označuje odťahovku a v existujúcich dátach nie je spoľahlivá samostatná väzba na náhradné auto, prvé vydanie zobrazí iba požiadavku a jasný stav. Nezavádza sa skryté vyhľadávanie v provider dátach ani odhad podľa EČV; prípadná nová väzba je samostatne odhadnutá a schválená zmena rozsahu.

Časy ukladať v UTC, zobrazovať jednotne s dátumom a časovým pásmom `Europe/Bratislava`. Vytvorenie prípadu, hovor, vytvorenie odkazu a odoslanie SMS sú rôzne udalosti. Čas skutočného odoslania/doručenia pridať iba s dôveryhodnou väzbou na záznam SMS; bez nej ho nenahrádzať časom vytvorenia grantu. V prvom vydaní na to stačí existujúca oprávnená SMS história.

### Vizuálne usporiadanie

Na mobile: čísla a stav zásahu → odstavené/náhradné vozidlo → odkiaľ/kam/pristavenie → Zavolať a Navigovať → pokyny → termín a doplnkové časové údaje. Dlhé adresy a referencie sa zalamujú; žiadne vodorovné posúvanie. Chýbajúce doplnkové polia skryť, kritické neznáme údaje pomenovať. Zachovať prístupné popisy tlačidiel, čitateľné stavové hlášky a spätnú väzbu po kopírovaní.

## 5. Bezpečnosť, snapshot a obnoviteľné tajomstvo

### Obnoviteľný odkaz

Navrhované riešenie: náhodný token zostáva bearer oprávnením overovaným SHA-256 hashom. Pre nové granty sa popri hashi uloží **serverom šifrovaná obnoviteľná reprezentácia**; nie plaintext a nie odkaz v bežnom DTO, browser storage či logoch.

- Použiť autentifikované šifrovanie, napríklad AES-256-GCM s náhodným IV, tagom a identifikátorom verzie kľúča. Kontext šifrovania naviazať na organizáciu, grant a generáciu. Konkrétny formát obálky overiť proti oficiálnej dokumentácii Node.js Crypto pred implementáciou.
- Kľúče zostávajú v serverových secrets, nie v repozitári, `NEXT_PUBLIC_*`, SQL migrácii, verejnej konfigurácii alebo údajoch grantu. TEST a produkcia majú nezávislé kľúče; Preview nesmie dostať produkčný kľúč ani stabilné TEST provider secrets.
- Hash, šifrovanú obálku, príslušnosť odkazu a receipt uložiť v jednej transakcii pri vydaní/rotácii. Pri strate odpovede musí retry toho istého `commandId` obnoviť pôvodný výsledok, nie vygenerovať ďalší grant alebo pripojiť nesúvisiaci token.
- Pri dešifrovaní overiť hash a aktuálnu generáciu; poškodená alebo nesúvisiaca obálka nesmie vrátiť URL. Retry starej rotácie nesmie znovu vydať medzičasom zneplatnené tajomstvo.
- Na explicitné Kopírovať/Poslať znova načíta token iba oprávnený server po overení používateľa, aktívnej roly, organizácie, konkrétneho prípadu, grantu a platnosti. Rozšírené RPC a tabuľky zachovajú úzke oprávnenia, RLS a bezpečný `search_path`.
- Pri chýbajúcom alebo nesprávnom kľúči zlyhá nové vydanie/obnova bezpečne a zrozumiteľne; existujúce verejné odkazy overované hashom tým neprestanú fungovať. Nikdy nepoužiť produkčné secrets ako fallback.
- Produkčné a stabilné TEST URL skladať z overenej kanonickej konfigurácie. Uchovať pôvod odkazu, aby znovuzískanie v inom nasadení zdieľajúcom TEST DB nenahradilo správnu doménu adresou aktuálneho requestu. Nekontrolovaný `Host` nie je dôkaz správneho cieľa.
- Kľúčová rotácia nie je rotácia odkazu. Uchovať potrebné staré verzie kľúčov, kým sú príslušné granty platné alebo obnoviteľné; ich vyradenie či prešifrovanie má vlastný kontrolovaný postup.

Historické granty majú iba hash, preto ich pôvodnú URL nemožno spätne dopočítať ani hromadne doplniť. Existujúce odkazy musia ďalej fungovať do platnosti. Panel jasne ponúkne výslovnú rotáciu na obnoviteľný odkaz s upozornením na zneplatnenie pôvodného. Žiadna automatická rotácia pri otvorení detailu ani hromadný prepis historických zákazníkov.

### Hranica zverejnenia

- Nové údaje sú verzovaný snapshot z pevného serverového allowlistu, nie celý prípad, asset, profil, call alebo JSON podstrom. Všetky nové joins overujú organizáciu a väzbu na tento prípad.
- Rozšírenie náhľadu, fingerprintu, publikovaného DTO a jeho validácie musí byť jednotné. Zmena vozidla, referencie, kontaktu, hovoru alebo iného zobrazeného zdroja medzi náhľadom a potvrdením vyžaduje nový náhľad; nesmie sa publikovať nevidený obsah.
- Už vydaný snapshot sa doplní až po potvrdení Aktualizovať údaje v odkaze. Staré snapshoty sa zobrazia bez nových polí; verejné čítanie nesmie doplniť nové živé údaje obídením publikovania.
- Zdieľané pokyny zostávajú oddelené od interných poznámok. VIN, ceny, poistné krytie/nároky, portálové URL, prílohy, prepisy, nahrávky, GPS história flotily, interné úlohy a časová os zostávajú nezverejnené. Výnimkou z pôvodného vylúčenia poistných údajov je explicitne schválený názov asistenčky a referencia jej prípadu.
- Po dokončení/odmietnutí zostane potvrdenie bez klientskych údajov; zrušený či expirovaný grant údaje neposkytne. Predĺženie/rotácia nemení toto pravidlo pre terminálne stavy.
- Zachovať fragment tokenu, jeho výmenu cez same-origin JSON POST, odstránenie fragmentu, HttpOnly/Secure/SameSite cookie, explicitné ID grantu pri čítaní/rozhodnutí, revízie, limity, no-store/no-referrer/noindex a zákaz cachovania cez service worker.
- Audit zaznamená aktéra, grant, akciu, čas a výsledok, nie URL/token/obálku. Existujúca SMS história obsahujúca odkaz zostáva citlivá. Snímky a release dôkazy nesmú obsahovať skutočné tokeny alebo klientské údaje.

## 6. Implementačné balíky a poradie

### Fáza A — baseline a kontrakt

- Pri neskoršej autorizovanej implementácii začať z aktuálneho `dev` v samostatnej pracovnej vetve; v tejto dokumentačnej úlohe vetvu nemeniť.
- Overiť aktuálny handoff SQL, aplikované závislosti, zdroje údajov, priradenie náhradného auta a konfiguráciu oficiálneho kontaktu dispečingu. Oddeliť zistenia zo zdrojov od vzdialených dôkazov.
- Po inštalácii závislostí prečítať relevantné guide v `node_modules/next/dist/docs/` ešte pred písaním Next.js kódu. Pri príprave tohto plánu neboli lokálne guides nainštalované.
- Spísať presný verzovaný allowlist, normalizáciu a fallbacky; navrhnúť názvy nových akcií aj kryptografickej obálky. Navrhovaný serverový gate `MOTORIST_HANDOFF_V3_ENABLED` má bezpečný default false; ešte nejde o existujúcu implementovanú premennú.

**Výstup:** schválený kontrakt, dátové obmedzenia a presný zoznam migrácií/závislostí bez vzdialených zápisov.

### Fáza B — databáza a server

- Pripraviť novú aditívnu migráciu; neprepisovať už vydanú `20261001110000_external_case_handoff.sql`. Žiadne seedovanie kopírovaného snapshotu ani backfill plaintext tokenov.
- Oddeliť operácie znovuzískania, predĺženia, publikovania, rotácie a zrušenia; zachovať zamykanie, očakávané revízie, idempotenciu, terminálne stavy a existujúce notifikácie.
- Doplniť šifrované tajomstvo, origin, publikovaný kontrakt, metadáta autora/časov a capability pre klienta. Bežný kontext načíta len metadáta, nie tajomstvo.
- Nové schéma/RPC musia podporovať starú aplikáciu aj nové voliteľné polia počas prechodu. Nový server musí čítať legacy granty; nový gate vypína rozšírené operácie/UI, nie ochrany alebo platnosť už vydaných odkazov.
- Vygenerované typy aktualizovať až podľa schválenej schémy. Nový snapshot a fingerprint musia pokryť všetky nové zdroje.

**Výstup:** lokálne overená migrácia a API vrátane kompatibility, replay a bezpečnostných testov.

### Fáza C — dispečer, príjemca a SMS

- Panel sprístupní pôvodnú URL po reloade, oddelí tlačidlá a potvrdzovacie dialógy, zobrazí autora/expiráciu/verziu a spoľahlivo zachová draft.
- Mobilná karta a dispečerský náhľad používajú rovnaké pomenovanie a schválené polia. Prázdne, legacy a nejednoznačné údaje majú definovaný stav.
- SMS ide iba na zamýšľaného príjemcu cez samostatný koncept bez `caseId`; zachovať ochrany pôvodného prepare/send toku, podpis konceptu a idempotenciu. Nevytvárať druhý odosielací mechanizmus.
- Zrušenie interného oprávnenia alebo konflikt načítania nesmie ponechať použiteľnú uloženú URL v otvorenom paneli. Verejný príjemca nemá prístup k internému API.

**Výstup:** funkčný workflow overený na fixture bez reálnych SMS alebo provider volaní.

### Dotknuté miesta pri implementácii

- [Kontrakt](../../src/domain/case-handoff.ts), [HTTP/server](../../src/server/case-handoff.ts), existujúce `/api/cases/[id]/handoffs` a `/api/public/handoffs/*`.
- [Panel](../../src/components/dispatch/CaseHandoffPanel.tsx), [súhrn](../../src/components/dispatch/HandoffSummary.tsx), [príjemca](../../src/components/dispatch/HandoffRecipient.tsx), [štýly](../../src/components/dispatch/case-handoff.css), [read koordinácia](../../src/components/dispatch/use-handoff-read.ts) a existujúci SMS editor podľa potreby.
- Nová migrácia, [databázové typy](../../src/lib/supabase/database.types.ts), [serverové testy](../../src/server/case-handoff.test.ts), [PostgreSQL scenáre](../../tests/postgres/external-case-handoff.py), [browser testy](../../e2e/case-handoff.spec.ts) a [fixture](../../e2e/fixtures/case-handoff.tsx).
- Existujúci runbook doplniť o skutočne zavedené správanie a release dôkazy až po overení; plán nesmie spätne prepísať historické výsledky na aktuálny úspech.

## 7. Overenie a akceptačné kritériá

| Oblasť | Povinný scenár a očakávaný výsledok |
|---|---|
| Opakované použitie | Vytvoriť grant → zavrieť detail → reload → znovu skopírovať: identická URL, rovnaký grant, žiadna nová SMS. Príjemca ju otvorí opakovane aj po skončení session, kým grant platí. |
| Replay a súbeh | Strata prvej odpovede aj odpovede rotácie: retry obnoví presne ten istý platný výsledok. Rovnaký UUID s iným obsahom, stará generácia, súbežná rotácia/predĺženie a expirácia počas DB zámku sa bezpečne vyriešia. |
| Platnosť | Predĺženie zachová URL, generáciu, údaje a stav; expirovaný grant sa reaktivuje len potvrdením. Terminálne granty sa neotvoria. Session sa nepredĺži nad vlastný limit ani nad platnosť grantu. |
| Rotácia a zrušenie | Starý token aj staré cookies prestanú fungovať; nový link je obnoviteľný. Žiadne rozhodnutie nesmie smerovať na iný grant po zmene cookie v ďalšej karte. |
| Legacy a kľúče | Hash-only grant ďalej funguje, panel ho automaticky nerotuje. Chýbajúci, cudzí alebo poškodený kľúč/obálka zlyhá bez úniku. Overiť aj prechod medzi verziami kľúčov a zákaz TEST/produkčného fallbacku. |
| Údaje | Interné aj asistenčné číslo, ručné adresy, odstavené auto, konkrétne/pridelené/nepridelené/nepotrebné náhradné auto, iná adresa pristavenia, chýbajúci kontakt, dlhý text a neznáma pojazdnosť majú správny náhľad aj kartu. Odťahovka sa nikdy neukáže ako náhradné auto. |
| Metadáta | Správny autor grantu aj pri inom vlastníkovi prípadu; žiadny nesúvisiaci hovor podľa telefónneho čísla; viac prepojených hovorov; bez hovoru; UTC a prechod zimného/letného času. Nevymyslené odoslanie/doručenie. |
| Publikovanie | Interná zmena sa bez potvrdenia verejne neobjaví. Zmena zdroja medzi náhľadom a potvrdením odmietne zastaraný výber. Staré snapshoty sa zobrazia, nové polia sa doplnia len publikovaním. |
| Oprávnenia a súkromie | Cudzia organizácia/prípad/rola, neaktívny profil, priame table/RPC práva, manipulovaný origin, unauthenticated retrieval a canary tajomstvá v každom novom JSON zdroji. Verejný DTO ani chyby neobsahujú zakázané polia, tokeny alebo obálku. |
| SMS | Presný príjemca kolegu, nie klient prípadu; žiadny send pri otvorení panela/editoru/kopírovaní; zachovaný draft a správny odkaz po rotácii; duplicitné potvrdenie nevytvorí duplicitné odoslanie. |
| Mobil a koniec úkonu | Šírky 360/390/768/1366 px, tel/navigácia s adresou aj súradnicami, prístupnosť a chybové hlášky. Dokončenie/odmietnutie skryje klientské údaje, expirácia/zrušenie zablokuje kartu. |
| Prechod verzií | Nová schéma + stará aplikácia, nová aplikácia + legacy grant, gate off/on, starý a nový deployment nad zdieľanou TEST DB. Znovuzískanie nesmie zmeniť doménu ani siahnuť na cudzie tajomstvo. |

Najprv cielené overenie, potom celý existujúci gate. Nasledujúce príkazy sú **plánované, v tejto úlohe sa nespúšťajú**:

```bash
pnpm exec vitest run src/server/case-handoff.test.ts
python3 tests/postgres/external-case-handoff.py
env -u E2E_BASE_URL pnpm exec playwright test e2e/case-handoff.spec.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

PostgreSQL scenáre vyžadujú jednorazovú lokálnu fixture a `psycopg`, existujúci runner používa loopback `127.0.0.1:55432`. Test upraviť na aplikovanie novej migrácie po pôvodnej. Nikdy jeho cieľ nezmeniť na vzdialený TEST/produkčný Supabase. Browser fixture zachytáva HTTP requesty; nesmie sa zmeniť na živé integračné odosielanie. Lint spustiť podľa existujúcej konfigurácie na dotknuté súbory. Lokálny build má explicitné TEST credentials/identity guards, bez produkčného fallbacku. Vercel Preview musí prejsť existujúcim `vitest run` → typecheck → build gate; konfiguráciu buildu ani cron kvôli tejto funkcii nemeníme.

## 8. Budúce nasadenie — oddelené schvaľovacie brány

### Brána 1: pracovná Preview a TEST migrácia

1. Po autorizácii implementácie pripraviť pracovnú vetvu z aktuálneho `dev`, vykonať lokálne testy a pushnúť ju. Skontrolovať nový Vercel Preview build; staré URL nie sú dôkazom aktuálnej izolácie.
2. Preview používa iba Supabase `nzpnqdstvkfncflgqlny`, syntetické testovacie prípady, bez živých SMS/provider operácií. Zdieľa DB so stabilným TEST, preto migrácia ovplyvní aj staré Preview; kompatibilita je podmienka, nie dodatočná oprava.
3. **Získať explicitné schválenie presného SQL a cieľa TEST `nzpnqdstvkfncflgqlny` ešte pred aplikovaním migrácie.** Pripraviť zoznam iba potrebných handoff závislostí; nepúšťať nesúvisiace migrácie ani seed nad kopírovanými dátami.
4. Do schválenia vzdialenej schémy overovať nové DB správanie len lokálne/fixture. Preview vyžadujúce novú schému nesmie byť označené za prebraté; nasadená aplikácia so zatiaľ vypnutými rozšíreniami je iba overenie baseline.
5. Po schválenej migrácii a oddelených serverových TEST secrets overiť Preview na syntetickom prípade, zaznamenať commit/build/migráciu a výstupy. Chýbajúce secrets nikdy nekopírovať z produkcie.

### Brána 2: PR do `dev` a stabilný TEST

1. Otvoriť PR pracovná vetva → `dev` s kontraktom, výsledkami, bezpečnostnými rizikami a kompatibilitou; zlúčiť až po review a zelenom gate.
2. Overiť nové nasadenie projektu `pomoc-motoristom-test`, `prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, vetva `dev`, Vercel cieľ Production, región `fra1`. Nie produkčnú aplikáciu, nie generovaný `dev` Preview fallback.
3. Použiť výhradne kanonickú adresu `https://test.dispecing.linkapomoci.sk`, `MOTORIST_APP_ENV=test`, správne systémové `VERCEL_PROJECT_ID` a `APP_BASE_URL`, Supabase `nzpnqdstvkfncflgqlny`. Overiť `/api/health/live`, `/api/health/ready`, aktuálny commit a efektívnu DB identitu.
4. V prihlásenom TEST overiť celý workflow vrátane opakovaného získania, publikovania, expirácie, rotácie a zrušenia. Použiť nový syntetický prípad, nie historický skopírovaný zákaznícky kontakt alebo provider ID.
5. Reálnu SMS overovať len po overení dedicated TEST resources, aktuálnych guards a explicitne schváleného testerovho čísla. Bez tejto podmienky preveriť iba prípravu správy a označiť doručenie ako neoverené; zastaví to prebratie živého SMS scenára, nie lokálnu prácu.
6. Výsledok TEST zdokumentovať a bezpečne upratať iba vlastné fixture dáta po ukončení testov. TEST nedostupný/pozastavený znamená zastaviť preberanie, nie prepojiť ho na produkciu alebo obnoviť dáta bez schválenia.

### Brána 3: produkčná migrácia a PR `dev` → `main`

1. Produkcia je samostatná autorizácia. Pred akýmkoľvek zápisom mať **explicitne schválené presné SQL a Supabase `ifpaeegaesdmljfkdvcn`**, nezávisle od predchádzajúceho schválenia TEST; pred živým vydaním mať aj autorizáciu release.
2. Overiť migrácie a nasadený baseline, pripraviť nezávislý produkčný šifrovací kľúč a postup návratu. Aditívnu schému nasadiť pred aplikáciou, pri zachovanej funkčnosti starej aplikácie; nezapínať nové capabilities, kým nesedia všetky predpoklady.
3. Release iba PR `dev` → `main`. Produkčný projekt `pomoc-motoristom-dispatching`, vetva `main`, región `fra1`, Supabase `ifpaeegaesdmljfkdvcn`, doména `https://dispecing.linkapomoci.sk`.
4. Nové premenné aplikovať čerstvým nasadením aktuálneho `main`. **Nepoužiť `vercel redeploy <stará-url>` ani promovať starú Preview ako skratku.** Nijako nemeníme mapovanie produkčnej/TEST domény ani produkčnú vetvu projektov.
5. Overiť health, commit, efektívnu identitu DB, pôvod odkazu, staré aj nové DTO a autorizovaný smoke scenár. Existujúce zákaznícke granty hromadne nerotovať ani neprepublikovať a nikomu bez požiadavky neposielať správu.
6. Rozšírenia uvoľniť cez nový serverový gate až po úspešnom preflight/smoke; ide o budúcu implementáciu gate, nie dnes existujúcu ovládaciu možnosť. Reálne produkčné odoslanie iba na explicitne schválený cieľ.

Vo všetkých bránach zostáva nedotknutý retired VIPTel projekt, Supabase `sjcsrygkkmersoczpunh` vrátane Watchdog dát, Vercel `pomoc-motoristom-dispatching-old`, jeho hostnames aj listener. Nepribudne scheduler; jediný existujúci `/api/telephony/cron` a jeho guards sa týmto plánom nemenia. `dispecing-test.vercel.app` sa nesmie použiť ako izolovaný TEST — patrí produkcii.

## 9. Prevádzka, zastavenie a návrat

Zastaviť vydanie pri nesprávnej DB/project/domain identite, neprejdenom gate, úniku polí/tajomstva, nekompatibilite starej aplikácie, chybe rotácie/replay alebo chýbajúcej autorizácii migrácie či živého odoslania. Neprehliadnuť zlyhanie tým, že sa príslušný test preskočí.

Sledovať bez tokenov: úspech/chybu získania URL, dešifrovania, publikovania, predĺženia/rotácie a konflikty; verejné 404 pre expirovaný odkaz nie sú automaticky incident. Použiť existujúce logovanie/monitor, bez nového workeru alebo plošného zbierania osobných údajov.

Pri probléme najprv vypnúť nové capabilities navrhovaným serverovým gate a podľa existujúcich pravidiel zastaviť problematické odosielanie; zachovať platné odkazy, hash overenie, zrušenia, sessions a redakciu terminálnych stavov. Potom pripraviť opravnú/revert PR cez `dev` → `main` a čerstvý build. Nevracať produkciu redeployom historickej URL. Aditívne DB dáta a kľúče nedestruktívne ponechať; spätné SQL, mazanie tajomstiev alebo prešifrovanie vyžaduje vlastnú autorizáciu a kontrolu dôsledkov.

### Doklady potrebné na označenie za hotové

- [ ] Implementovaný a schválený kontrakt, známe dátové obmedzenia náhradného auta.
- [ ] Zelené lokálne unit/DB/browser testy, typecheck a build; výsledky bez tvrdenia o fyzickom zariadení či SMS doručení bez dôkazu.
- [ ] Schválená a kompatibilná migrácia TEST, nový Preview gate a review.
- [ ] PR do `dev` a úspešné prebratie kanonického stabilného TEST s commitom, časom, DB identitou a výsledkami scenárov.
- [ ] Explicitná autorizácia produkčnej migrácie aj release, PR `dev` → `main`, čerstvé produkčné nasadenie a smoke.
- [ ] Zaznamenané identifikátory migrácií/deploymentov, vlastníci schválení, anonymizované dôkazy a overiteľný postup návratu; aktualizovaný runbook.

Pri aktuálnej dokumentačnej úlohe zostávajú všetky implementačné a nasadzovacie položky otvorené.
