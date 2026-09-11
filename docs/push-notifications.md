# Push upozornenia

## Používanie

V aplikácii otvor **Menu → Nastavenia → Upozornenia**. Zapni **Push upozornenia na tomto zariadení** a potvrď povolenie prehliadača. Na iPhone/iPade najprv pridaj aplikáciu na plochu cez Zdieľať a otvor ju z jej ikony; vyžaduje sa iOS/iPadOS 16.4 alebo novší.

Prepínač platí pre aktuálny prehliadač alebo nainštalovanú PWA. Telefón a PC zapínaj samostatne. Vypnutie jedného zariadenia nemení ostatné. Odhlásenie zruší odber aktuálneho zariadenia. Po novom prihlásení ho možno znova zapnúť.

V časti **Typy upozornení** sa nezávisle zapínajú:

- **Úlohy a pripomienky** – pridelenie úlohy a jej pripomienky.
- **Prichádzajúce hovory** – hovor práve ponúkaný tomuto operátorovi, vrátane interného volania, transferu alebo konzultácie.
- **Hovory na prevzatie** – neprevzatý prichádzajúci, čakajúci alebo zaparkovaný hovor určený dostupným operátorom príslušného uloženého ring plánu. Patrí sem aj prichádzajúci hovor, ktorý práve zvoní na externej zálohe.

Samostatný účtový prepínač **Upozornenie pred koncom pauzy** ovláda naraz notifikáciu v aplikácii aj Web Push na všetky zapnuté zariadenia. Pri zapnutí príde upozornenie presne jednu minútu pred tým, ako pauza dosiahne maximálny čas nastavený pri jej dôvode, a druhé („Plánovaný čas pauzy uplynul“) hneď po tomto čase, ak je operátor stále na pauze. Pauza bez nastavenej dĺžky upozornenie nevytvorí. Upozornenie pauzu automaticky neukončí; operátor sa prepína na dostupného ručne — konzola mu prekročený plánovaný koniec ukazuje v hlavičke a v Môj telefón.

Vypnutie kategórie nemení ostatné kategórie ani odbery na inom zariadení. Hlavný prepínač vypne všetky push na aktuálnom zariadení. Testovacie upozornenie overuje samotný odber bez ohľadu na výber kategórií.

**Zvuk upozornení** ovláda požiadavku na systémový zvuk push aj zvuk v otvorenej aplikácii. **Vyskúšať zvuk** preverí zvuk v aplikácii; **Poslať testovacie upozornenie** odošle skutočný Web Push iba na aktuálne zariadenie (najviac raz za 30 sekúnd). Pri vypnutom push sa upozornenia naďalej zobrazujú v zozname úloh a v aplikácii.

Zvuk na pozadí riadi operačný systém. Aplikácia nedokáže obísť režim Nerušiť, stíšenie systému, zamietnuté povolenie ani obmedzenie prehliadača. Vlastný krátky tón úloh v otvorenej aplikácii sa aktivuje po prvej interakcii; pri zapnutom push pre úlohy sa neprehráva duplicitne.

## Doručovanie

- Priradenie novej otvorenej úlohy alebo zmena jej riešiteľa vytvorí súkromnú notifikáciu a odošle push aktívnemu riešiteľovi na jeho odbery.
- Splatné pripomienky využívajú už existujúce spracovanie v jedinom povolenom päťminútovom crone. Nový scheduler ani worker sa nenasadzuje.
- Upozornenie na koniec pauzy vytvorí otvorená konzola v presnom minútovom okne a upozornenie na prekročenie hneď po plánovanom konci; časy dostane od servera (`POST /api/push/pause-ending` odpovie `early` s `warningAt`/`plannedEndAt`), takže platí dĺžka dôvodu uložená v nastaveniach, nie kópia načítaná pri štarte konzoly. Server vždy znovu overí rovnakú aktívnu pauzu, jej dĺžku a účtový prepínač. Existujúci päťminútový cron je iba záloha pre pozastavenú konzolu: varovanie nikdy neposiela skôr ani po plánovanom konci, upozornenie na prekročenie posiela kedykoľvek po ňom (najviac 12 hodín). Unikátny kľúč pauzy a fázy (`pause-ending:` / `pause-overdue:`) zabráni opakovaniu z viacerých kariet, zariadení alebo cron ticku.
- Duplicitný zápis notifikácie znovu push neodošle. Krátkodobé sieťové/5xx chyby majú najviac jeden okamžitý opakovaný pokus; rovnaký collapse topic obmedzuje duplicity. 429 sa opakuje iba pri krátkom `Retry-After`. Trvalá fronta opakovaného odosielania nie je súčasťou zmeny.
- Neplatné odbery (404/410) sa odstránia. Chyba push nezruší uloženú úlohu ani upozornenie v aplikácii. V logu zostáva iba identifikátor notifikácie a počet neúspechov, nie kľúče alebo telá odpovedí push služieb.
- Kliknutie otvorí konkrétnu úlohu. Existujúca otvorená aplikácia rešpektuje ochranu rozpracovaných zmien; pri starej lokálnej snímke sa po vyriešení rozpracovaných zmien načíta aktuálny stav. Prihlásenie zachová odkaz na úlohu.

## Upozornenia na hovory

Po úspešnom uložení zmeny hovoru sa cez Next.js `after()` skontroluje aktuálny stav a odošle push. Odosielanie nezdržiava odpoveď Telnyxu ani nedrží zámok hovoru. Príjemca musí byť aktívny operátor v tej istej organizácii a prostredí, dostupný bez iného hovoru či ponuky. Pri prichádzajúcom hovore sa vyžaduje skutočná neprevzatá ponuka pre daného operátora; pri hovore na prevzatie členstvo v uloženom ring pláne hovoru. Bez uloženého plánu sa hromadné upozornenie neposiela. Operátor s vlastnou ponukou dostane len kategóriu prichádzajúceho hovoru, aby rovnaký hovor neposlal obe upozornenia naraz.

Pre upozornenie na hovor dostupný na prevzatie sa nevyžaduje čerstvá SIP registrácia: zatvorená PWA sa môže otvoriť až po push. Prevzatie potom vyžaduje pripojený a neobsadený telefón v aplikácii bez ďalšej pripájanej vetvy. Operátor musí byť dostupný alebo mať zvoniacu ponuku práve tohto hovoru. Ak sa ponuka v tomto okne neobjaví, môže neprevzatý prichádzajúci hovor výslovne prevziať; rezervácia na serveri zaručuje jedného víťaza. Push sám nemení telefonické smerovanie ani neudržiava WebRTC na pozadí.

Platnosť správy je najviac **30 sekúnd**, pri končiacej ponuke kratšia. Stav príjemcov sa pred dávkou znovu načíta. Duplicitné webhooky a routing tick neposielajú opakovane rovnakú kategóriu pre rovnaký hovor a operátora; deduplikačný záznam je súkromný a archivovaný v existujúcej tabuľke notifikácií. Nepatrí medzi neprečítané upozornenia. Nastavenie kategórie a zvuku sa kontroluje pri doručovaní na jednotlivé zariadenia.

Kliknutie otvorí ústredňu s kartou **Hovor z upozornenia** a adresou `/?call=<session-id>`. Aplikácia načíta čerstvý stav; stará lokálna snímka nestačí na prijatie. Používateľ musí hovor výslovne prijať alebo prevziať. Tlačidlo prijatia sa sprístupní len pre presne zodpovedajúcu ponuku v tomto browser telefóne. Už prevzatý alebo ukončený hovor ukáže aktuálny stav. Otvorené rozpracované zmeny zostávajú chránené. Toto nie je natívne CallKit rozhranie na zamknutej obrazovke.

## Konfigurácia tejto kópie

Používa sa Supabase `ifpaeegaesdmljfkdvcn` a Vercel `pomoc-motoristom-new`. Migrácie `20260906081818_web_push_subscriptions.sql` a `20260906081822_web_push_vault_config.sql` pridávajú odbery a obmedzené čítanie konfigurácie.

Kategórie vyžadujú aditívnu migráciu `20260925110000_push_notification_categories.sql`: tri boolean stĺpce odberu s predvolenou hodnotou `true`. Existujúce povolené odbery tak získajú aj upozornenia na hovory; každý typ možno vypnúť osobitne. Migrácia nemení VAPID, RLS, smerovanie ani odbery. Aplikuje sa samostatne iba do tejto kópie po výslovnom súhlase podľa `AGENTS.md`. Pred jej aplikovaním zostáva staré doručovanie úloh funkčné; nové kategórie sa nezapnú a ich ovládanie je nedostupné.

Účtový prepínač konca pauzy vyžaduje aditívnu migráciu `20260927100000_pause_ending_notifications.sql`, ktorá do existujúcej tabuľky účtových preferencií pridá boolean `pause_ending_enabled` s predvolenou hodnotou `true`. Nepridáva cron, worker ani listener a nemení telefonické smerovanie.

Odbery nemajú priame oprávnenia pre `anon` ani `authenticated`; autentifikované API vždy odvodí profil a organizáciu zo session. RPC `motorist_get_web_push_config()` smie zavolať iba `service_role` a číta výhradne jeden šifrovaný Vault secret `motorist_web_push_vapid`. Ten obsahuje JSON `{publicKey, privateKey, subject}`. Kľúče sa negenerujú ani nemenia počas požiadaviek; verejný kľúč sa poskytuje cez autentifikovaný stav odberu. Privátny kľúč nepatrí do Git-u, verejných premenných, klienta ani logov.

Alternatívou sú serverové Vercel premenné `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Ak je zadaná čo len jedna z nich, všetky musia tvoriť platnú konfiguráciu: neplatné/čiastočné env hodnoty zámerne nezapnú iný pár kľúčov z Vaultu. Všetky prostredia tejto kópie používajú rovnakú stabilnú identitu. Kľúče bez plánovanej obnovy odberov nerotuj.

## Overenie na zariadení

1. Zapni odber na telefóne/PC a odošli test z nastavení. Skontroluj systémové centrum upozornení aj zvuk.
2. Presuň aplikáciu na pozadie alebo zamkni telefón. Z iného prihláseného zariadenia priraď skúšobnú úlohu danému používateľovi.
3. Skontroluj doručenie a otvorenie správnej úlohy. Pri testovaní používaj výslovne určený skúšobný prípad, pretože všetky zápisy v Preview aj dev sú reálne.
4. Vypni push na jednom zariadení; ďalšia pridelená úloha má prísť len na ostatné zapnuté zariadenia. Vypnutý zvuk nesmie byť vyžiadaný pri ďalšom push.
5. Na výslovne určených skúšobných číslach over ponuku hovoru konkrétnemu operátorovi a potom čakajúci hovor pre dostupného člena ring plánu. Skontroluj zamknutý telefón aj PC, otvorenie správneho hovoru a výslovné prijatie v aplikácii.
6. Vypni iba **Prichádzajúce hovory**, potom samostatne **Hovory na prevzatie**. Over, že príslušná kategória na tomto zariadení nepríde, ostatné zostanú aktívne. Skontroluj aj staré upozornenie po prevzatí hovoru kolegom; nesmie prijať iný hovor.

Automatické testy overujú autorizačné hranice, šifrované odosielanie cez knižnicu, stav odberov, prepínače, chyby, service worker a navigáciu. Prijatie push službou alebo simulácia browser API samy nepotvrdzujú zobrazenie či počuteľnosť na fyzickom telefóne.

Referencie: [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Supabase Vault](https://supabase.com/docs/guides/database/vault), [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).
