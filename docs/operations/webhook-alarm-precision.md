# Presnosť alarmov webhookov

Úspešný hovor môže mať dočasne odloženú udalosť, keď iný proces práve
upravuje ten istý hovor. Samotné `lease_busy` nepotvrdzuje výpadok volania.

## Kedy sa okamžitý alarm odloží

Webhook ostáva v evidencii a varovnom logu. Sentry sa pri prijatí nevolá iba
vtedy, keď procesor preukázal všetky podmienky:

- presný `SessionLeaseBusyError` nastal pred začatím spracovania;
- zápis odkladu do evidencie bol úspešný;
- pôvodný záznam je bez terminálneho dôvodu a má podporovaný stav obnovy;
- pôvodný čas prijatia je platný, nie v budúcnosti a mladší ako 10 minút.

Čas sa počíta od pôvodného prijatia. Opakované doručenie ho neposúva.
Neúspešný zápis, chýbajúci dôkaz, expirovaný alebo terminálny záznam sa
neskrýva. Ostatné chyby vrátane `lease_lost`, skutočného zlyhania spracovania,
kompenzovaného zlyhania a nevyriešenej udalosti ostávajú alarmované.
Skutočná chyba sa hlási aj pri druhom a ďalšom pokuse; opakovania obmedzuje
existujúci transport a deduplikácia Sentry.

## Konečný výsledok

Existujúci päťminútový cron najprv obnovuje udalosti a potom číta prevádzkový
health report. Už spracovaná udalosť nevytvorí alarm. Trvajúci odklad dosiahne
hranice existujúcej 10-minútovej lehoty a stane sa závažnou chybou.

Ten istý health výsledok sa používa aj pre Sentry: ak evidencia obsahuje
nevyriešené závažné zlyhania, odošle sa bezpečný kód
`webhook_recovery_failed`. Existujúce e-mailové upozornenia sa nemenia.
Nový dotaz, plánovač ani pravidlá volania nepribudli. Health kontroluje
existujúce 24-hodinové okno; nie je to audit celej histórie evidencie.

Regresné testy pokrývajú úspešnú obnovu, presnú hranicu 10 minút, terminálne
udalosti, chýbajúci dôkaz, neskoršiu skutočnú chybu, zlyhanie zápisu aj
výnimku v diagnostickom pozorovateli.
