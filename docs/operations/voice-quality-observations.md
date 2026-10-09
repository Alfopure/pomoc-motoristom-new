# Pozorovania kvality zvuku z prehliadača

Monitor používa existujúce udalosti `telnyx.warning` SDK **2.27.10**. Príslušný kontrakt je overený v nainštalovaných `SDK_WARNINGS`, `ITelnyxWarningEvent` a callbacku `CallReportCollector.onWarning`. Nepridáva sa merací interval, sieťový polling ani nastavenie nahrávania SDK. Udalosti používa existujúci diagnostický zberač s jeho frontou, retenciou, limitmi a dávkovaním.

| Kód SDK | Ukladaný dôvod | Význam |
|---|---|---|
| 31001 | `sdk_high_rtt` | Vyššie oneskorenie siete |
| 31002 | `sdk_high_jitter` | Kolísanie oneskorenia siete |
| 31003 | `sdk_high_packet_loss` | Strata zvukových paketov |
| 31004 | `sdk_low_mos` | Nižší odhad kvality spojenia |
| 31005 | `sdk_low_local_audio` | Nízka úroveň mikrofónu |
| 31006 | `sdk_low_inbound_audio` | Nízka úroveň prijímaného zvuku |
| 32001 | `sdk_low_bytes_received` | Chýbajúce prijímané zvukové dáta |
| 32002 | `sdk_low_bytes_sent` | Chýbajúce odosielané zvukové dáta |

Ukladá sa iba povolený číselný kód a zodpovedajúci dôvod v udalosti `phone_lifecycle`, spolu s overenou aplikačnou reláciou hovoru. Výsledok je **`unknown`**: pozorovanie samo nepotvrdzuje výpadok, jeho príčinu ani skutočnú počuteľnosť. Monitor zobrazuje slovenský opis aj kód; pôvodná správa SDK, RTP štatistiky, SDP, IP adresy, telefónne čísla a tokeny sa do udalosti neposielajú. Schéma odmieta neznáme kódy, nesúlad kódu/dôvodu a nepovolené polia. Existujúci JSON úložný formát nevyžaduje migráciu.

## Priradenie a obmedzenie objemu

- Udalosť musí patriť aktuálnemu klientovi SDK a jeho aktívnemu/podržanému hovoru. Chýbajúce alebo cudzie SDK `callId`, starý klient, ukončovaný hovor a odlišná signaling session sa odmietnu.
- Konzola spojí presný SDK hovor a jeho Call Control ID s jedinou zodpovedajúcou vetvou v existujúcom serverovom prehľade. Aplikačné session ID musí súhlasiť; nevyberá sa prvý ani posledný hovor v zozname. Bez tejto zhody sa detail kvality neuloží.
- SDK pri Attach môže nahradiť objekt hovoru a ponechať rovnaké ID. Warning neobsahuje identitu ani generáciu peeru. V takom prípade sa záznamy kvality konzervatívne potlačia do ďalšieho odlišného hovoru, aby sa oneskorený starý peer nepriradil novému. Ovládanie a obnova samotného hovoru sa nemenia.
- Rovnaký kód sa zaznamená najviac raz za minútu pre aktuálny hovor; pamäť obsahuje najviac osem časov. Nepridáva sa timer ani HTTP požiadavka. Po zmene hovoru sa toto obmedzenie začne odznova.

## Podržanie, stlmenie a ručné overenie

Štyri pozorovania ticha/chýbajúcich dát sa potlačia pri SDK podržaní aj pri serverovom stave `held`, `parked`, `consulting` alebo `waiting`. Serverové podržanie totiž môže ponechať WebRTC v stave `active`. Lokálne pozorovania mikrofónu a odosielaných dát sa potlačia aj pri stlmení v SDK alebo na danej serverovej vetve. Sieťové pozorovania sa môžu uložiť ako `unknown`; nevypínajú registráciu ani nezavesujú hovor.

Stav serverového prehľadu môže krátko zaostávať a vzdialený účastník môže prirodzene mlčať. Preto ani nízke prijímané audio bez lokálneho podržania nie je automaticky potvrdenou poruchou. Chýbajúce upozornenie zasa nedokazuje, že je zvuk v poriadku; straty zberača a nejednoznačné peer obnovy obmedzujú pokrytie.

Pri spoločnej skúške zaznamenať commit a čas, overiť počuteľnosť v oboch smeroch, podržanie/obnovenie, stlmenie a ukončenie. Časová os Monitora pomáha porovnať pozorovania s logmi. Syntetické SDK testy potvrdzujú priradenie, sanitizáciu a limity, **nenahrádzajú reálny hlasový test**.
