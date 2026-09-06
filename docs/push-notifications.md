# Push upozornenia

## Používanie

V aplikácii otvor **Menu → Nastavenia → Upozornenia**. Zapni **Push upozornenia na tomto zariadení** a potvrď povolenie prehliadača. Na iPhone/iPade najprv pridaj aplikáciu na plochu cez Zdieľať a otvor ju z jej ikony; vyžaduje sa iOS/iPadOS 16.4 alebo novší.

Prepínač platí pre aktuálny prehliadač alebo nainštalovanú PWA. Telefón a PC zapínaj samostatne. Vypnutie jedného zariadenia nemení ostatné. Odhlásenie zruší odber aktuálneho zariadenia. Po novom prihlásení ho možno znova zapnúť.

**Zvuk upozornení** ovláda požiadavku na systémový zvuk push aj zvuk v otvorenej aplikácii. **Vyskúšať zvuk** preverí zvuk v aplikácii; **Poslať testovacie upozornenie** odošle skutočný Web Push iba na aktuálne zariadenie (najviac raz za 30 sekúnd). Pri vypnutom push sa upozornenia naďalej zobrazujú v zozname úloh a v aplikácii.

Zvuk na pozadí riadi operačný systém. Aplikácia nedokáže obísť režim Nerušiť, stíšenie systému, zamietnuté povolenie ani obmedzenie prehliadača. Vlastný krátky tón v otvorenej aplikácii sa aktivuje po prvej interakcii; pri zapnutom push sa neprehráva duplicitne.

## Doručovanie

- Priradenie novej otvorenej úlohy alebo zmena jej riešiteľa vytvorí súkromnú notifikáciu a odošle push aktívnemu riešiteľovi na jeho odbery.
- Splatné pripomienky využívajú už existujúce spracovanie v jedinom povolenom päťminútovom crone. Nový scheduler ani worker sa nenasadzuje.
- Duplicitný zápis notifikácie znovu push neodošle. Krátkodobé sieťové/5xx chyby majú najviac jeden okamžitý opakovaný pokus; rovnaký collapse topic obmedzuje duplicity. 429 sa opakuje iba pri krátkom `Retry-After`. Trvalá fronta opakovaného odosielania nie je súčasťou zmeny.
- Neplatné odbery (404/410) sa odstránia. Chyba push nezruší uloženú úlohu ani upozornenie v aplikácii. V logu zostáva iba identifikátor notifikácie a počet neúspechov, nie kľúče alebo telá odpovedí push služieb.
- Kliknutie otvorí konkrétnu úlohu. Existujúca otvorená aplikácia rešpektuje ochranu rozpracovaných zmien; pri starej lokálnej snímke sa po vyriešení rozpracovaných zmien načíta aktuálny stav. Prihlásenie zachová odkaz na úlohu.

## Konfigurácia tejto kópie

Používa sa Supabase `ifpaeegaesdmljfkdvcn` a Vercel `pomoc-motoristom-new`. Migrácie `20260906081818_web_push_subscriptions.sql` a `20260906081822_web_push_vault_config.sql` pridávajú odbery a obmedzené čítanie konfigurácie.

Odbery nemajú priame oprávnenia pre `anon` ani `authenticated`; autentifikované API vždy odvodí profil a organizáciu zo session. RPC `motorist_get_web_push_config()` smie zavolať iba `service_role` a číta výhradne jeden šifrovaný Vault secret `motorist_web_push_vapid`. Ten obsahuje JSON `{publicKey, privateKey, subject}`. Kľúče sa negenerujú ani nemenia počas požiadaviek; verejný kľúč sa poskytuje cez autentifikovaný stav odberu. Privátny kľúč nepatrí do Git-u, verejných premenných, klienta ani logov.

Alternatívou sú serverové Vercel premenné `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Ak je zadaná čo len jedna z nich, všetky musia tvoriť platnú konfiguráciu: neplatné/čiastočné env hodnoty zámerne nezapnú iný pár kľúčov z Vaultu. Všetky prostredia tejto kópie používajú rovnakú stabilnú identitu. Kľúče bez plánovanej obnovy odberov nerotuj.

## Overenie na zariadení

1. Zapni odber na telefóne/PC a odošli test z nastavení. Skontroluj systémové centrum upozornení aj zvuk.
2. Presuň aplikáciu na pozadie alebo zamkni telefón. Z iného prihláseného zariadenia priraď skúšobnú úlohu danému používateľovi.
3. Skontroluj doručenie a otvorenie správnej úlohy. Pri testovaní používaj výslovne určený skúšobný prípad, pretože všetky zápisy v Preview aj dev sú reálne.
4. Vypni push na jednom zariadení; ďalšia pridelená úloha má prísť len na ostatné zapnuté zariadenia. Vypnutý zvuk nesmie byť vyžiadaný pri ďalšom push.

Automatické testy overujú autorizačné hranice, šifrované odosielanie cez knižnicu, stav odberov, prepínače, chyby, service worker a navigáciu. Prijatie push službou alebo simulácia browser API samy nepotvrdzujú zobrazenie či počuteľnosť na fyzickom telefóne.

Referencie: [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Supabase Vault](https://supabase.com/docs/guides/database/vault), [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).
