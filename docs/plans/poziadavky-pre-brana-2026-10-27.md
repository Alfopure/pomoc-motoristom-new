# Požiadavky na prepojenie dispečingu s nájomným systémom

**Podklad pre Braňa — pripravený na odoslanie, 27.10.2026.** Tento dokument navrhuje integračný kontrakt; uvedené operácie/polia nepredstierajú, že už existujú v tvojom API. Prosíme potvrdiť konkrétny systém, podporované TEST rozhranie a možnosti nižšie. Nejde o požiadavku na priamy prístup do databázy.

## Cieľ

Dispečer uloží prípad a pristavovač ho prevezme v našej aplikácii. Z dostupných údajov chceme vytvoriť **rozpracovaný nájom** v existujúcom nájomnom systéme. Pristavovač ho otvorí a doplní chýbajúce údaje; nemá znova prepisovať klienta, asistenčnú službu, referenciu a pobočku. Potrebujeme potvrdenie vzniku a odkaz na konkrétny draft.

## Minimum potrebných operácií

1. Vytvorenie alebo idempotentné získanie draftu podľa **našej stabilnej externej referencie nájomného zámeru**. Jeden prípad môže mať viac legitímnych nájmov/výmien áut; samotné číslo prípadu preto nie je unikátny kľúč draftu.
2. Vyhľadanie existujúceho draftu/nájmu podľa tej istej referencie po výpadku odpovede. Rovnaký zámer nesmie po opakovaní vytvoriť druhý nájom.
3. Čítanie potvrdenej identity/stavu: interné ID nájmu, naša referencia, stav draftu, čo chýba a URL na otvorenie s normálnym oprávnením používateľa. URL nesmie niesť trvalé heslo ani široký prístupový token.
4. Číselníky alebo potvrdené mapovanie pobočky, asistenčnej služby, firmy/prenajímateľa a vozidla. Potvrdiť, ktoré existujúce read API môžeme použiť a či rovnaké ID platia pre tento cieľ.

Konkrétne endpointy/HTTP metódy prispôsobíme podporovanému API; nevymýšľame názvy už existujúcich ciest.

## Prenášané údaje a autorita

| Údaj | Naša strana dodá | Čo potrebujeme potvrdiť |
|---|---|---|
| Zdroj | Identifikátor dispečingového prípadu, jeho referencia, rental-intent ID, command ID a revízia/hash odoslaných údajov. | Unikátny externý kľúč, limity a význam opakovaného requestu. |
| Objednávateľ/asistencia | Známa asistenčná služba a jej číslo prípadu; druh služby podľa dohodnutého číselníka. | Povinnosť a mapovanie partnera/kontraktu. |
| Pobočka | Zodpovedná pobočka/skupina, ak už je známa. | Či má cieľ skutočné branch ID a ako odlíšiť routovaciu skupinu od fyzickej pobočky. |
| Klient/nájomca | Meno alebo názov firmy, potrebný kontakt; údaje už známe z prípadu. | Minimum pre fyzickú/právnickú osobu, validácie a ktoré údaje možno doplniť neskôr. |
| Preberajúci vodič | Samostatná osoba, ak nie je totožná s nájomcom. | Oddelené polia a označenie zhody; neprenášať vodiča naslepo ako nájomcu. |
| Vozidlo | Ak je vybrané: potvrdené externé ID, EČV/VIN ako kontrolná informácia. | **Draft musí vedieť vzniknúť aj bez vybraného auta**, prípadne prosíme navrhnúť podporovaný ekvivalent rezervácie/zámeru. |
| Prenajímateľ | Len potvrdený podľa kontraktu; na začiatku môže byť neznámy. | Nevypočítavať ho automaticky z vlastníka vozidla; povoliť neskoršie doplnenie alebo vrátiť konkrétnu požiadavku. |
| Plán | Známy termín/miesto pristavenia a poznámka potrebná na odovzdanie. | Formát, timezone Europe/Bratislava oproti UTC, ktoré časy sú len plán. |
| Nájom/stav | Na začiatku žiadame draft, nie automaticky aktívny nájom. | Tvoje skutočné statusy a kedy nájom vzniká/aktivuje sa. |

Posielame iba dohodnuté potrebné polia. Rodné čísla, doklady, nahrávky a fotografie nie sú súčasťou prvej integrácie, pokiaľ na ne nie je samostatný konkrétny účel a kontrakt. Cieľový systém vlastní samotný nájom a jeho finálne doplnenie; dispečing eviduje prenos a väzbu.

## Potvrdenie, chyby a opakovanie

- Úspešná odpoveď obsahuje našu referenciu, externé ID, stav draftu a odkaz. Prijatie HTTP requestu bez trvalého ID nie je dostatočný dôkaz vytvorenia.
- Rovnaký kľúč a obsah vráti pôvodný výsledok; iný obsah pod už použitým kľúčom sa odmietne alebo rieši výslovne dohodnutou revíziou. Tichý prepis ručne doplneného nájmu nechceme.
- Po timeoute overíme našu referenciu, až potom rozhodneme o ďalšom create. Ak také overenie nie je podporované, označíme výsledok ako nejasný a druhý create automaticky neposielame.
- Prosíme čitateľné validačné chyby po poliach, rozdiel medzi oprávnením, chýbajúcim číselníkom a dočasnou nedostupnosťou. Potrebujeme vedieť timeout/rate limity a retenčnú platnosť idempotencie.
- Prvú etapu stačí aktivovať zo používateľskej akcie a overiť stav na požiadanie. Webhooky a kompletný obojsmerný sync nie sú podmienka.

## TEST a prístupy

Potrebujeme izolovaný TEST base URL, autentifikačný postup a účet/kľúč s oprávnením iba na potrebné drafty a číselníky. Produkčné kľúče ani priame DB heslá neposielať v dokumente. Potvrdiť oddelenie TEST/produkcie, vzor úspešnej/chybovej odpovede, postup zrušenia skúšobného draftu a technický kontakt. Nie je požiadavka migrovať cudzie existujúce databázy do nášho dispečingu.

## Jedna spoločná akceptačná ukážka

1. Z nášho označeného skúšobného prípadu vznikne draft bez vozidla a bez prenajímateľa; obsahuje známu asistenciu, referenciu a klientsky kontakt.
2. Cieľ vráti externé ID a draft sa otvorí používateľovi, ktorý ho môže doplniť.
3. Rovnaký request zopakujeme, vrátane simulovaného výpadku odpovede: zostane jeden draft.
4. Pristavovač v cieľovom systéme doplní auto a ďalšie povinné údaje. V našej aplikácii je potvrdená väzba a správny stav; nepotvrdzujeme aktívny nájom iba z existencie draftu.
5. Skúsime legitímny druhý nájomný zámer/výmenu v rovnakom prípade: neblokuje ho kľúč prvého nájmu.

**Prosíme odpoveď:** ktoré body už podporuje existujúce API, ktoré treba doplniť, presné TEST rozhranie/dokumentácia a kedy môžeme spraviť túto ukážku. Ak neúplný nájomný draft dnes nie je podporovaný, navrhni najmenší podporovaný záznam so stabilnou externou referenciou.
