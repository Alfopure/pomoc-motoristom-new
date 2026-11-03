# Odovzdanie pristavenia z webu do aplikácie

Prvá implementačná časť mobilného plánu z 23. 10. 2026. Vychádza z `dev`
`e9448ca66085e1f89b22c329a03c411b3e1b53cf`; produkčné vydanie nie je súčasťou
tejto zmeny.

## Výsledné správanie

V uloženom prípade otvorte **Odovzdať prípad**. Ak sú v tomto prostredí
pristavenia zapnuté a existuje dostupný člen, v **Príjemca odovzdania** vyberte
pristavovača, skontrolujte telefón a náhľad údajov a stlačte **Odovzdať do
aplikácie**. Existujúce čakajúce odovzdanie možno poslať tlačidlom **Poslať do
aplikácie pristavovača**. Druhé odovzdanie sa pritom nezakladá.

Značka **V aplikácii** znamená potvrdené pridelenie do pracovného zoznamu
príjemcu. Nepotvrdzuje zobrazenie push na telefóne ani prijatie práce. Stav
**Prijaté** a ďalší priebeh naďalej vychádzajú z úkonov pristavovača.

Pri aktívnom prevzatom pristavení web zobrazuje poslednú polohu, jej čas, vek,
presnosť a odkaz na mapu. Chýbajúca poloha je označená. Po skončení platnosti
alebo dokončení sa GPS odkaz nezobrazuje; miestna expirácia nečaká na polling.
Existujúci odkaz a výslovné odoslanie SMS fungujú aj pre kolegu bez aplikácie.

## Použité existujúce časti

- Rovnaké členstvá, `motorist_case_handoff_app`, handoff identita a mobilný
  push ako pri odovzdaní z mobilného dispečingu.
- Webové cookie prihlásenie, organizačné oprávnenia a kontrola Origin/CSRF.
- Existujúci `MOBILE_DELIVERY_ENABLED` a izolácia dedikovaného TEST; pracovný
  Preview nepovoľuje živé pristavenia. Pri skutočne vypnutom module zostáva
  pôvodný postup cez odkaz. Pri zapnutom module a chybe čítania web zobrazí
  chybu namiesto predstierania neprideleného odovzdania.
- Nevzniká migrácia, nová tabuľka, worker, listener, cron ani mobilná binárka.
  Zmena používa už pripravený mobilný modul a TEST schému.

## Výsledky a obnova

Uloženie odovzdania, pridelenie do aplikácie a prevzatie práce sú samostatné
výsledky. Ak sa odovzdanie uložilo, ale pridelenie nie je potvrdené, web
zachová jeho ID aj identitu pôvodnej požiadavky a ponúkne **Overiť výsledok
tej istej požiadavky**. Opakuje sa pridelenie, nie vytvorenie nového odkazu.
Pri strate odpovede po pridelení sa zopakuje rovnaký príkaz; opakované
pridelenie tomu istému členovi nevytvára ďalší push.

Zlyhanie získania odkazu neruší uloženie ani úspešné pridelenie. V odpovedi
zostane `linkWarning: link_unavailable` a web ukáže upozornenie. Odkaz, ktorý
nebol získaný, sa neponúka na kopírovanie ani SMS.

## Overenie

- Serverové regresie pokrývajú prihlásenie, CSRF, prostredie, oprávnenia,
  neplatného člena a revízie, opakovanie, čiastočný výsledok, nečitateľný
  odkaz a neúplný kontext pridelení.
- Nových 10 browser scenárov nad skutočným komponentom a pôvodných 32
  handoff scenárov prešlo. Sieť je v týchto testoch syntetická.
- Existujúcich 663 cielených mobilných kontrol, mobilný typecheck a lint
  prešli. Zdroj v `mobile/` sa týmto vydaním nemení.
- Celkový lint repozitára má mimo zmeny existujúcich šesť chýb:
  `IncomingFlowMonitor.tsx` a CommonJS fixture
  `tests/mobile/telnyx-patch-install-fixture.cjs`. Upravené súbory prešli.

Stabilný TEST treba po merge identifikovať cez `/api/health/live` aj Git SHA
príslušného Vercel deploymentu a prejsť prihlásený postup dvoch rolí.
Pripravené sú aj automatizované skúšky opakovania a dátových hraníc;
nenahrádzajú fyzické prijatie push, audio ani GPS pri pohybe.

## Otvorené podmienky mobilného pilotu

Mac je dostupný, ale pri tomto overovaní nebol pripojený fyzický iPhone.
Skutočne nainštalovaný build, živé audio, doručenie push a pohyb na pozadí
preto nie sú potvrdené. Východiskový záznam TestFlight uvádza build 22;
úspešný zamknutý hovor bol potvrdený pri skoršom builde. Presné ďalšie
skúšky zostávajú v [pripravenosti mobilu](../mobile/release-readiness.md).

Pri príprave sa overilo, že dedikovaný TEST má oba existujúce prepínače
`MOBILE_DELIVERY_ENABLED` a `MOBILE_PUSH_ENABLED` nastavené na `true` len
v jeho Production targete. Čítanie databázového katalógu cez pripojený
Supabase MCP bolo odmietnuté pre chýbajúce oprávnenie; žiadne SQL ani seed
sa nevykonali. To nie je potvrdenie živého databázového postupu.

Final CD, skupinové ponúkanie práce a rozšírenie na celú odťahovú zákazku
zostávajú ďalšími samostatnými časťami. Produkcia sa vydá až po overení
konkrétneho rozsahu a súhlase podľa `AGENTS.md`.
