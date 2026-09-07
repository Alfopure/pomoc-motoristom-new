# Prichádzajúce hovory: malý tím a spätné volanie

Prevádzkový návrh z 7. septembra 2026 pre samostatnú Telnyx kópiu, 2–3 dispečerov a jeden záložný telefón.

| Fáza | Nastavenie |
| --- | --- |
| Hlavná skupina | Všetci dostupní dispečeri súčasne, 20 sekúnd |
| Záloha | Jeden pokus na existujúci záložný telefón, 30 sekúnd |
| Po neúspešnej zálohe | Čakáreň, maximálne 30 minút od vstupu |
| Počas čakania | Výzva zostať na linke alebo stlačiť 1; potom minúta hudby |
| Uvoľnenie operátora | Automatická ponuka jednému dostupnému dispečerovi; bez automatického prijatia |
| Opakovaná ponuka | Najskôr 60 sekúnd od posledného ponúknutia tomu istému dispečerovi |
| Zápis po skončení rozhovoru | 20 sekúnd pred ďalšou automatickou ponukou, namiesto pôvodných 5 |
| Koniec čakárne | Posledná ponuka spätného volania; bez voľby sa hovor ukončí |
| Spojený rozhovor | Samostatný limit jednej vetvy je 4 hodiny, takže rozhovor môže trvať aj pol hodiny |

Pôvodný plán zvonil hlavnej skupine len 10 sekúnd, zálohe 20 sekúnd a následne vytáčal rovnakú zálohu znova na 30 sekúnd. Hodnota `park_max_minutes=30` existovala, ale plán do čakárne nesmeroval. Samotná čakáreň pred zmenou automaticky neopakovala ponuky operátorom a ignorovala voľbu spätného volania počas čakania.

Opakované ponuky používajú existujúce webhooky, kontrolu aktívnych hovorov a povolený päťminútový cron. Pri otvorenej konzole sa kontroluje dostupnosť priebežne; bez nej je ďalšou príležitosťou koniec približne minútového zvukového cyklu. Nepribúda worker, listener ani plánovač. Pri kontrole čakárne dostáva prednosť najstarší čakajúci hovor. Rezervácie a existujúci limit súbežných vetiev chránia pred dvojitým pridelením operátora.

Do opakovaných ponúk vstupujú iba operátori s dostupnou prítomnosťou a platnou registráciou telefónu. Externé a mobilné čísla sa počas čakárne znova nevytáčajú. Operátor vracajúci sa z pauzy sa môže zapojiť aj vtedy, keď jeho pôvodná ponuka smerovala na mobil. Parkovanie už spojeného rozhovoru zostáva samostatnou funkciou. Opakované ponuky neresetujú pôvodný tridsaťminútový limit.

## Čo znamená záznam spätného volania

Pole `source` historicky pomenúvalo miesto v smerovaní, nie súhlas klienta. Preto aj výslovná žiadosť po neúspešnom zvonení mala `source=missed`.

Nová žiadosť v existujúcom JSON `metadata.request` uchováva `kind=requested`, `digit`, `requested_at`, `context` a `event_id`. Požiadavka musí byť uložená pred prehratím potvrdenia. Opakovanie udalosti nesmie vytvoriť druhú požiadavku ani znovu otvoriť uzavretú. Oneskorený koniec hudby alebo zvonenia nesmie zmazať potvrdenú voľbu ani predčasne ukončiť potvrdzovaciu hlášku.

Panel rozdeľuje položky na **Vyžiadané klientom** a **Neprijatý hovor · bez žiadosti**. Ručné a neoveriteľné staršie záznamy majú vlastné označenie. Pri nových žiadostiach ukazuje konkrétne tlačidlo a čas v pásme Europe/Bratislava. Pri starších záznamoch číta potvrdenie z pôvodnej relácie: zobrazuje potvrdenú žiadosť, ale nevymýšľa tlačidlo, ktoré stará verzia neuložila.

V existujúcom úvodnom menu neutrálnej linky je **1 dispečing, 2 spätné volanie**. V čakárni, po zvonení a mimo otváracích hodín je spätné volanie **1**. Evidencia vždy ukazuje skutočnú voľbu daného menu. Interný termín na spracovanie spätného volania ostáva 30 minút; nie je to sľub vyslovený klientovi ani limit jeho čakania na linke.

## Podklady

- [Microsoft Teams: nastavenie fronty](https://learn.microsoft.com/en-us/microsoftteams/aa-cq-setup-call-queue) odporúča zvonenie operátora aspoň 20 sekúnd a smerovanie podľa dostupnosti. Súčasné zvonenie hlavnej skupiny je náš návrh pre tento malý tím.
- [3CX: call queues](https://www.3cx.com/docs/manual/call-center-queues/) dokumentuje spoločné aj postupné zvonenie a používa 20 sekúnd ako predvolené zvonenie skupiny.
- [Amazon Connect: queued callbacks](https://docs.aws.amazon.com/connect/latest/adminguide/setup-queued-cb.html) rozlišuje živú frontu od zákazníkom zvoleného spätného volania a opisuje nadviazanie spätného hovoru cez operátora.
- [Aircall: wrap-up time](https://support.aircall.io/en-gb/articles/10375354632477) opisuje čas po hovore na doplnenie poznámok; 20 sekúnd je náš úvodný návrh pre tento tím, nie univerzálna norma.
- [Telnyx: gather using audio](https://developers.telnyx.com/api-reference/call-commands/gather-using-audio) prijíma DTMF aj počas zvuku; časový limit vstupu začína po dohraní súboru. Preto zvuk čakárne obsahuje aj minútu hudby.
- [Telnyx: dial](https://developers.telnyx.com/api-reference/call-commands/dial) oddeľuje čas zvonenia od maximálnej dĺžky spojenej vetvy.

## Overenie a nasadenie

Izolované testy prechádzajú skutočným reducerom, persistenciou a API službou nad testovacou databázou/providerom: 30 minút bez vstupu, neplatná voľba, uvoľnenie operátora, návrat z pauzy, súbeh dvoch čakajúcich, opakované odmietnutie, callback počas zvonenia, oneskorená odpoveď, zlyhanie zápisu a obnova. Playwright overuje skutočný panel, filtre, tlačidlo Zavolať a uzavretú históriu. Zvuky sa skladajú z existujúcich nahrávok pomocou `scripts/build-queue-announcements.py`; manifest obsahuje kontrolné súčty.

Kód prechádza Preview → PR do dev → overenie dev aliasu → PR dev do main → overenie produkcie. Až potom sa existujúci plán zmení na 20/30 sekúnd a `waiting_room`, pod kontrolou verzie konfigurácie. Nevyžaduje sa databázová migrácia. Nastavenia nahrávania, ASR a AI sa týmto postupom nemenia.
