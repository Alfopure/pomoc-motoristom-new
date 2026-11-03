# Čakáreň a podržanie — nový TEST hovor 15. 10. 2026

Rozsah opravy: stabilný TEST, `https://test.dispecing.linkapomoci.sk`. Žiadna migrácia, zmena providerových prostriedkov ani produkčné nasadenie. Toto je nový incident; nezamieňať ho s predchádzajúcim [auditom merania](call-measurement-review-20261015.md).

## Dôkazy

Session `61e32b7a-239f-42ba-871a-b6cdbd2fd3cf`, začiatok **15:06:23 UTC / 17:06:23 Europe/Bratislava**, TEST verzia `d8366ea5e04db61ab94ce352d9c778cf581198c7`. Server, provider ledger a databázové logy identifikujú jeden nový hovor v kontrolovanom okne. Verzia otvorenej používateľovej karty nebola nezávisle potvrdená.

| Hranica presunu do čakárne | UTC | Od vstupu požiadavky |
| --- | --- | --- |
| Server prijal požiadavku | 15:06:50.950 | 0 |
| Prvý providerový dispatch | 15:07:06.458 | 15,51 s |
| Zákazník opustil konferenciu — provider event | 15:07:06.667 | približne 15,72 s |
| Operátorská vetva ukončená — provider event | 15:07:07.367 | približne 16,42 s |
| Prehrávanie zákazníkovi začalo — provider event | 15:07:08.367 | približne 17,42 s |
| HTTP 200 | 15:07:09.561 | serverové monotónne meranie 18,61 s |

Request ID: `4ce32978-5faa-499e-8df7-9ecadb5d420b`. Nejde o čas úmyselného ponechania človeka v čakárni. Rozdiel providerových a serverových hodín je približný; provider event nedokazuje presný okamih počuteľného zvuku. Prvé podržanie malo serverovú odpoveď približne 4,15 s a providerový začiatok prehrávania približne 3,56 s od vstupu požiadavky.

Handler čakárne vykonal 45 databázových fetchov. Súčet ich trvaní 20,33 s sa prekrýva a **nesmie sa sčítať s 18,61 s handlera ani vydávať za čas SQL**. Samotné staging RPC trvalo 2,60 s. TEST PostgREST v rovnakom okne zaznamenal dva timeouty obsluhy o 15:06:57.608. To potvrdzuje spomalenú DB cestu, nie konkrétnu príčinu CPU, kapacity alebo kreditov.

Read-only porovnanie produkcie potvrdilo zhodu kontrolovaných telephony SQL funkcií a triggerov. Historické produkčné presuny z 4.–9. októbra mali prvý providerový dispatch približne po 0,47–0,99 s a dokončenie približne po 1,60–3,01 s. Ide o iné hovory, záťaž a nasadenia, nie kontrolované A/B meranie ani garantovaný štandard. Produkčná konfigurácia ani dáta sa nemenili.

## Zmena

- Presun už nečíta wrap-up nastavenia operátora a neuvoľňuje jeho dostupnosť pred odpojením a spustením čakacej hudby. Uvoľnenie je viazané na posledný trvalý príkaz vstupu do čakárne; zlyhanie ponechá obnoviteľnú povinnosť. Neúspešný povinný hangup ponechá operátora rezervovaného.
- Pri `hold`, `unhold` a `park` bez nahrávania sa už durably staged zámer vykoná u poskytovateľa pred projekciou samotných stavov existujúcich vetiev. Skratka platí iba pod aktuálnym contract-2 vlastníctvom a generáciou, bez nových vetiev, callbackov, pokusov či nahrávacích bariér. Journal, vlastník a každý providerový fence zostávajú. Ostatné cesty zachovávajú pôvodné poradie.
- Snapshot a telefónna lišta rozlišujú uložený zámer od dokončených príkazov. Zobrazujú „Presúvam do čakárne…“, „Podržiavam…“ alebo „Obnovujem hovor…“, ponechajú aktívnu kartu a zabránia konfliktnému ďalšiemu ovládaniu. Položenie zostáva dostupné. Pri chybe označia operáciu ako nepotvrdenú. Samotná obnova histórie už dokončené ovládanie neblokuje.
- Existujúce runtime meranie rozlišuje odloženú fázu `control.state_projection`. Nevzniká nový DB logger, tabuľka, worker ani cron.

Dokončenie príkazov znamená potvrdenie ich spracovania v aplikácii/providerovom journale, **nie akustický dôkaz**. Povinná autentifikácia, session lease, staging a journal stále potrebujú dostupnú databázu; oprava nezaručuje rýchlosť pri jej výpadku.

## Overenie a živá akceptácia

Desať regresných prípadov pokrýva pomalú projekciu, pomalé wrap-up čítanie, obnovenie stránky počas troch ovládacích operácií, chybu hangup a obnovu zlyhanej projekcie aj uvoľnenia operátora bez opakovania prijatých providerových príkazov. Pôvodných deväť prípadov bolo spustených aj proti presnej starej TEST verzii: všetkých deväť zlyhalo na očakávaných rozdieloch správania. Celá pôvodná sada s prvými deviatimi prípadmi: 7 825 Vitest testov a 76 Node testov úspešných; 4 + 1 preskočených. Dodatočný desiaty prípad a všetkých desať spolu tiež prešli. Typecheck, lint zmenených súborov a build prešli.

Po nasadení overiť aktuálny `dev` commit na canonical TEST a autentifikovaný snapshot. Majiteľ má obnoviť kartu a zopakovať prijatie → podržanie → obnovenie → čakáreň → prevzatie → ukončenie. Samostatne porovnať serverový vstup → prvý dispatch → providerové odpojenie/prehrávanie → HTTP odpoveď a skutočne počutý zvuk. Požadovať zmiznutie rozhovoru a začiatok hudby, nie iba zmenu tlačidla. Zaznamenať DB timeouty a oneskorené callbacky počas tej istej vzorky.

Syntetické testy ani úspešný deployment nepreukazujú odstránenie reálneho 17-sekundového oneskorenia. Nahrávanie a prepis sa týmto balíkom nezapínajú ani nevyhlasujú za funkčne overené.
