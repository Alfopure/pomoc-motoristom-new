# Plán ďalšej práce na AI demo „Veronika"

Stav: **návrh**. Nadväzuje na `.context/ralplan-v2/drafts/plan-v4.md` (pôvodný plán) a na to, čo z neho reálne vzniklo — opísané v [`ai-demo-veronika.md`](./ai-demo-veronika.md).

Formát je rovnaký ako pri pôvodnom pláne. Skill `ralplan` v tomto prostredí nainštalovaný nie je; aj pôvodný plán vznikol ručne.

---

## 1. Princípy

Prvý je tvrdý a je dôvodom, prečo je tento dokument taký konkrétny pri číslach.

**P1 — Nič na kritickej ceste.** Kritická cesta sú dva úseky a nič iné:

| Úsek | Namerané dnes | Strop |
|---|---|---|
| zdvihnutie → jej prvé slovo | ~1,0 s | **nesmie stúpnuť** |
| volajúci dohovorí → ona začne | 0,2–1,1 s | **nesmie stúpnuť** |

Každá položka nižšie má napísané, či sa kritickej cesty dotýka. Ak áno, nerobí sa.

**P2 — Hlasový prompt sa nesmie predĺžiť.** Skrátenie z 5 500 na 1 500 znakov znížilo čas do prvého slova **na polovicu** a odstránilo robotické čítanie. Test drží strop 2 000 znakov; ten strop sa nedvíha, obchádza ani nevypína. Čokoľvek, čo pridáva pravidlá, musí iné odobrať.

**P3 — Ľudské hovory zostávajú nedotknuté.** Žiadna zmena rozpočtu webhooku Telnyxu, žiadny druhý scheduler, žiadny zásah do reducera ani do `motorist_call_sessions`.

**P4 — Nikdy sa nestratí to, čo už bolo zaznamenané.** Zápis priebežne, stav až na konci. Toto pravidlo vzniklo z chyby, ktorá stála dva celé hovory.

**P5 — Nič sa nezapína samo.** Nové schopnosti majú vlastný prepínač a predvolene sú vypnuté.

---

## 2. Čo je hotové (východisko)

Odchádzajúci hovor kompletne a overený naživo: vytáčanie, prijatie relácie, premostenie, pozdrav, meranie latencie, prepis celého hovoru, rozbor rozhovoru, vyhodnotenie modelom, výber hlasu, zadanie ako pokyn, čistenie v crone, izolovaná testovacia kópia.

Z pôvodných jedenástich otvorených otázok je päť uzavretých živými hovormi (SIP povolený, WebSocket dostupný, číslo originuje, pozdrav po sidebande funguje, `from_display_name` prežije).

---

## 3. Fáza 0 — Dlh (pred čímkoľvek novým)

Nič z toho nie je vidieť, ale všetko ostatné na tom stojí.

| # | Čo | Prečo | Kritická cesta |
|---|---|---|---|
| 0.1 | Test `aiDemoPollDelayMs` (AK 31) | Poll je jediná vec, ktorá môže zaťažiť server pri dlhom hovore. Nemá test. | nie |
| 0.2 | Test, že v logoch nie sú kľúče ani čísla (AK 19) | Tvrdím to v dokumentácii a nič to nestráži. | nie |
| 0.3 | Test stratenej odpovede pri vytáčaní (AK 12) | Kód to rieši, test to nepokrýva — a je to cesta k dvojitému hovoru. | nie |
| 0.4 | Test, že `sipUri`/`webhookUrl` v tele požiadavky sa ignorujú (AK 4) | Dnes to platí náhodou, nie preukázateľne. | nie |
| 0.5 | AK 5: pri vypnutí prepínača medzi zápisom a vytočením zapísať `live_calls_disabled` | Dnes sa zapíše `sip_dial_rejected`, čo zavádza pri čítaní histórie. | nie |
| 0.6 | PR do `dev` | Vetva má trinásť commitov mimo produktu a v `dev` databáze sú tri migrácie bez kódu. | nie |
| 0.7 | Zneplatniť OpenAI kľúče | Sú v histórii chatu. | nie |

**Odhad: pol dňa.** Bod 0.6 je najdôležitejší — čím dlhšie to visí, tým drahšie sa to zlieva.

---

## 4. Fáza 1 — Ako to vyzerá (rýchle zlepšenia)

### 1.1 Prepis naživo počas hovoru

Prepis sa **už teraz** zapisuje každých 10 sekúnd aj počas hovoru. Panel sa obnovuje každé 2 sekundy. Chýba len vykreslenie.

**Rozhodnutie:** prepis sa **nesmie** pribaliť do bežného načítavania stavu — desať riadkov histórie × 2 000 útržkov by bola zbytočná záťaž. Namiesto toho prírastkovo: `GET /ai-demo/<id>?transcript=1&since=<ms>` vracia iba útržky novšie než kurzor, a volá sa iba pri bežiacom hovore.

- Kritická cesta: **nie.** Zvuk ide mimo aplikácie; toto je čítanie z databázy.
- Záťaž: jedno čítanie za 2 s počas hovoru, prírastkové. Pri 5-minútovom hovore ~150 dopytov, rovnako ako dnešný poll.

### 1.2 Striedať úvodné vety

3–4 varianty na účel, vyberie sa jeden. Dnes povie pri každom hovore presne tú istú vetu a pri druhom deme za sebou to počuť.

- Kritická cesta: **nie** — mení sa text, nie dĺžka promptu (P2 platí, varianty sa neposielajú všetky).

### 1.3 Meno aj v priebehu hovoru

Dnes osloví menom iba na začiatku. Jedna veta v zadaní.

- Kritická cesta: **nie.**

**Odhad fázy: ~1 hodina.**

---

## 5. Fáza 2 — Aby sama ukončila hovor

Pôvodný plán to označil za nemožné a mal pravdu: vyžaduje niečo, čo počúva celý hovor. Odvtedy to máme.

**Rozhodnutie — ako sa pozná koniec:** dvojitá podmienka, obe musia platiť.
1. V jej poslednej reči je rozlúčka (krátky zoznam slovenských fráz — „dovidenia", „pekný deň", „ďakujem za váš čas").
2. Potom **4 sekundy ticha na oboch stranách**.

Až potom `POST /v1/live/sessions/{id}/hangup` a zloženie vetiev.

**Zamietnuté alternatívy:**
- *Nechať to posúdiť model* — to je ďalšie volanie a čakanie počas hovoru. Porušuje P1.
- *Iba rozlúčka bez ticha* — zloží uprostred vety, keď povie „ďakujem za váš čas, ešte sa spýtam".
- *Iba ticho* — zloží, keď sa človek na chvíľu zamyslí.

- Kritická cesta: **nie.** Vyhodnocuje sa text, ktorý už prišiel, a rozhoduje sa až po štyroch sekundách ticha — teda v čase, keď sa aj tak nič nedeje.
- Prepínač: `AI_DEMO_AUTO_HANGUP`, predvolene **zapnutý** až po jednom overenom hovore; do vtedy vypnutý (P5).

**Odhad: ~1 hodina + jeden overovací hovor.**

---

## 6. Fáza 3 — Učenie zo záznamov

### 3.1 Uložené pravidlá

Vyhodnotenie už píše konkrétne návrhy na zmenu pokynov. Dnes ich musí niekto prečítať a povedať mne.

**Rozhodnutie:** pole „stále pravidlá" v nastaveniach dema, ktoré sa pripája k hlasovému promptu. **Strop 600 znakov, tvrdo.** Test na 2 000 znakov celého promptu zostáva v platnosti a je to poistka, nie odporúčanie: presne takto sa prompt minule rozrástol na päť a pol tisíca znakov a demo začalo čítať manuál.

Z rozboru sa dá návrh pridať jedným kliknutím, ale **nie automaticky** — pravidlo, ktoré si nikto neprečítal, je pravidlo, ktoré nikto nevie odstrániť.

- Kritická cesta: **áno, nepriamo** — každý znak promptu predlžuje inicializáciu relácie. Preto ten strop a preto test.

### 3.2 Porovnanie hovorov

Jednoduchý prehľad nad uloženými rozbormi: priemerný čas do prvého slova, ktoré problémy sa opakujú, ktoré návrhy prišli viackrát. Opakovaný problém je signál, jednorazový je šum.

- Kritická cesta: **nie** — číta sa po hovore.

**Odhad: ~3 hodiny.**

---

## 7. Fáza 4 — Hovoriť do toho počas hovoru

Najsilnejšia ukážka („a teraz jej niečo poviem") a zároveň najviac práce.

**Rozhodnutie — ako sa pokyn dostane k tomu, kto počúva:** cez databázu. Panel zapíše pokyn k pokusu, funkcia, ktorá drží spojenie, ho vyzdvihne a pošle ako `session.instructions.append`.

- **Čítanie každé 2 sekundy, zápis stavu zostáva každých 10.** Čítania sú lacné, zápisy nie.
- Kritická cesta: **nie.** Je to dopyt do databázy v tej istej funkcii, ktorá už beží a väčšinu času čaká na socket. Zvuku sa nedotýka.
- Strop 200 znakov na pokyn, najviac 5 pokynov na hovor — aby sa z toho nestal druhý prompt.

**Odhad: ~3 hodiny.**

---

## 8. Fáza 5 — Prichádzajúce hovory

Druhá polovica pôvodného plánu. Návrh je hotový v `plan-v4.md` §6.3 a nič v ňom sa medzitým neukázalo ako zlé — preberá sa, nie prepisuje.

Zhrnutie: odbočka v `processTelnyxEvent` pred `createInboundSession`, sekvencia „zdvihni → povedz vetu → vytoč SIP s premostením", prepínač v novej tabuľke, `PATCH /ai-demo/inbound`.

**Čo sa oproti pôvodnému plánu zmenilo k lepšiemu:** vtedy sa počítalo s tým, že prepis nebude. Teraz bude, rovnako ako pri odchádzajúcich, vrátane vyhodnotenia.

**Čo to stojí navyše:** číslo `+421 232 408 774` treba dočasne prepnúť na aplikáciu testovacej kópie a po teste vrátiť. Kým je prepnuté, hovory naň nevidí ani `dev`, ani produkcia — teda krátke okno a informovaní operátori.

- Kritická cesta: **vlastná.** Pri prichádzajúcom hovore volajúci čaká od prijatia po jej prvé slovo; pôvodný plán tam dal cieľ 8 s a prah 15 s. Meria sa rovnako ako pri odchádzajúcich.

**Odhad: 1,5–2 dni.** Z toho polovica sú testy izolácie — dôkaz, že ostatné čísla a vypnutý prepínač idú dnešnou cestou (AK 21).

---

## 9. Fáza 6 — Testy rozhrania

Vedome až sem: pri fáze 5 sa panel mení a testy písané teraz by sa prepisovali dvakrát.

- `AiDemoPanel.test.tsx` — statické vykreslenie (AK 29)
- `e2e/ai-demo-settings.spec.ts` — klikací test so stubmi, 390 aj 1440 px (AK 30)

**Odhad: ~4 hodiny.**

---

## 10. Čo sa robiť nebude

Nie je to zabudnuté, je to rozhodnuté.

| Čo | Prečo nie |
|---|---|
| Nahrávanie zvuku | Nedá sa počúvať v rozumnom čase; text a rozbor sú na vyhodnotenie lepšie. Výslovné rozhodnutie majiteľa. |
| Model, ktorý počas hovoru posudzuje, či má zložiť | Ďalšie volanie počas hovoru. Porušuje P1. |
| Prompt zvlášť pre každý hlas | Rozmnožuje to, čo sa má držať krátke (P2). |
| Automatické pridávanie pravidiel z rozborov | Pravidlo, ktoré si nikto neprečítal, nikto nevie ani odstrániť. |
| Veronika ako člen plánov zvonenia | Vyžaduje nový druh člena alebo falošný profil, presence, validáciu skupín. Samostatná práca s vlastným plánom. |
| Dvíhať na iných linkách než `…8774` | Dotklo by sa to ľudských hovorov (P3). |

---

## 11. Riziká

| Riziko | Čo ho drží |
|---|---|
| Prompt sa postupne rozrastie a demo začne znieť ako manuál | Test na 2 000 znakov, strop 600 znakov na uložené pravidlá, a vedomie, že sa to už raz stalo |
| Automatické zloženie skončí hovor uprostred vety | Rozlúčka **aj** 4 s ticha; predvolene vypnuté, kým to neprejde živým hovorom |
| Priebežné zápisy zaťažia databázu | Zápis 10 s, čítanie 2 s; pri 5-minútovom hovore ~30 zápisov |
| Prichádzajúce hovory zasiahnu ľudský tok | AK 21: izolačná matica — päť brán × dve čísla, plus existujúce testy `event-processor` bez zmeny |
| Prepnuté číslo zostane prepnuté | Krok „vrátiť" je súčasťou postupu testu, nie poznámka na konci |

---

## 12. Poradie a odhady

| Fáza | Obsah | Odhad |
|---|---|---|
| 0 | Dlh: štyri testy, AK 5, PR do `dev`, kľúče | pol dňa |
| 1 | Prepis naživo, striedanie úvodov, meno v hovore | 1 hodina |
| 2 | Automatické ukončenie | 1 hodina + hovor |
| 3 | Uložené pravidlá, porovnanie hovorov | 3 hodiny |
| 4 | Pokyny počas hovoru | 3 hodiny |
| 5 | Prichádzajúce hovory | 1,5–2 dni |
| 6 | Testy rozhrania | 4 hodiny |

**Spolu ≈ 4 dni.**

Odporúčané poradie: **0 → 1 → 2**, potom rozhodnutie. Ak sa má demo predvádzať pravidelne, nasleduje **5** (prichádzajúce) a **4** (pokyny počas hovoru). Ak to bude jednorazová ukážka, stačí **3** a koniec.

---

## 13. Otvorené otázky

| # | Otázka | Kto odpovie |
|---|---|---|
| A | Má to ísť do `dev` teraz, alebo počkať na prichádzajúce hovory? | majiteľ |
| B | Pri automatickom ukončení: má zložiť aj keď volajúci mlčí dlho bez rozlúčky? | majiteľ |
| C | Kedy sa dá prepnúť číslo pre test prichádzajúcich hovorov? | majiteľ |
| D | Má sa demo naďalej volať z neutrálnej linky, alebo z partnerskej podľa účelu? | majiteľ |
| E | Majú zostať kópia a jej prepínače po skončení testov, alebo sa zmaže? | majiteľ |
