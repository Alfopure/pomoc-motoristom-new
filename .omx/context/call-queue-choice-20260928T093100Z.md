# Kontext: výber hovoru a upozornenie čakárne

## Zadanie

Operátor môže presunúť práve zvoniaci prichádzajúci hovor do čakárne a následne si vybrať čakajúci hovor. Správca môže prepnúť prichádzajúce hovory z predvoleného priameho zvonenia na režim najprv do čakárne. Nový čakajúci hovor má byť zreteľne signalizovaný iným krátkym zvukom a vizuálnym upozornením.

## Overené fakty

- Predvolený tok ukladá plán zvonenia a spúšťa ponuky operátorom v `src/server/telephony/state/transitions.ts:906`.
- Súčasná čakáreň po vstúpení automaticky znovu ponúka hovory a môže eskalovať v `src/server/telephony/state/transitions.ts:1150`, `:1203` a `:2162`.
- Práve ponúkaný hovor je zobrazený v `src/components/dispatch/PhoneBar.tsx:100`; čakajúci hovor a možnosť prevzatia v `src/components/dispatch/LiveCallOverview.tsx:170`.
- Súčasný zoznam dostupných push adresátov vychádza z uloženého plánu zvonenia v `src/server/telephony/call-notifications.ts:55`, `:150`.
- Nastavenia organizácie sú uložené v `motorist_telephony_settings` a spracované v `src/server/telephony/config-service.ts:2103`.
- Nasadenie musí ísť z `dev` cez Preview a PR do `main` podľa `AGENTS.md`; test a produkcia sú rozdielne Supabase projekty.

## Hranice

- Dve malé produktové zmeny. Zachovať hlášku, pracovné hodiny, IVR, callback pri limite čakania a doterajší režim ako predvolený.
- Čakáreň s ručným výberom nesmie v pozadí automaticky znova ponúkať hovor ani vytáčať platenú eskaláciu.
- Bez intenzívneho blikania. Zvuk iba pre nový hovor, bez falošného tónu po obnovení stránky a bez súbehu so skutočným vyzváňaním.
- Migráciu aplikovať len na autorizované projekty test `nzpnqdstvkfncflgqlny` a produkcia `ifpaeegaesdmljfkdvcn`; nikdy nie na starý VIPTel projekt.

## Otvorené technické body

- Pred migráciou zistiť skutočný stav migrácií v oboch projektoch; staršie záznamy sa v minulosti líšili od repozitára.
- Živý poskytovateľ hovorov nie je zapojený v testovacom prostredí; funkčné scenáre musia pokryť reducer/harness a Preview UI, produkčný smoke test má zostať nedestruktívny.
