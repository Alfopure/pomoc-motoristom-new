# Interný hovor medzi operátormi — 28. 9. 2026

Operátor zavolá kolegovi z **Ústredňa → Operátori**: tlačidlo telefónu pri
kolegovi alebo **Zavolať – interný hovor** v jeho detaile. Hovor ide z telefónu
volajúceho v aplikácii do telefónu kolegu v aplikácii (jeho vlastný SIP účet).
Nikdy nejde na firemnú linku ani na súkromné číslo, preto nevadí, keď majú dvaja
operátori pridelené rovnaké firemné číslo.

## Rozhodnutia vlastníka

- Kolegovi zazvoní aj na **pauze**; pauza mu ostane. Rovnako môže volať operátor na pauze.
- Žiadne klapky ani krátke čísla — volá sa osobe, nie číslu.
- Volaný vidí **meno** („Volá kolega …“), nie firemnú linku ani SIP adresu.
- **Zákazníci majú prednosť**: interný hovor nechá voľné aspoň 3 linky z „Súčasných liniek spolu“.
- Bez prepínača; vydanie bežnou cestou `dev` → `main`.

## Správanie

| Kolega | Výsledok |
|---|---|
| Dostupný, telefón v aplikácii pripojený | Zazvoní v prehliadači; mobilná aplikácia dostane upozornenie a môže prijať tam. |
| Na pauze | Zazvoní; stav zostáva „Pauza“ počas hovoru aj po ňom. Pri prijatí v mobilnej aplikácii sa po hovore pauza obnoví s pôvodným dôvodom. |
| Telefonuje / dokončuje hovor / odhlásený / bez telefónu v aplikácii | Nezazvoní; tlačidlo aj server povedia prečo. |
| Prijíma na osobnom mobile | Zatiaľ nie („Interný hovor mu zatiaľ nie je možné spojiť“). |

- Keď zloží ktorýkoľvek z dvoch, hovor sa ukončí obom. Odmietnutie ukončí aj vetvu volajúceho.
- Po internom hovore nie je čas na dopísanie; dostupný operátor je hneď dostupný.
- Interné hovory sa nenahrávajú a nedajú sa odpočúvať; nemajú „Nový prípad“, prepojenie ani čakáreň.
- História: „Volajúci“ a „Volaný kolega“ menom; riadok nemá „Volať“ (to by vytočilo firemnú linku).

## Opravené v doteraz nepoužitej ceste

Backend interného hovoru existoval od fázy 2, ale nemal tlačidlo. Pred sprístupnením:

- zloženie volajúceho posielalo kolegu do čakárne ako zákazníka;
- zloženie alebo odmietnutie kolegom nechávalo volajúceho spojeného s ničím;
- prijatie v mobilnej aplikácii by pravidelná kontrola (sweep) po vypršaní 60 s rezervácie zrušila;
- prehliadač počas pauzy potichu zrušil každé pozvanie — interné je označené hlavičkou `X-PM-Colleague-Call` a nikdy sa neprijme automaticky.

## Dôkazy (lokálne, pred vydaním)

- **Zákaznícke hovory bez zmeny:** normalizovaný záznam všetkých DB operácií a príkazov
  Telnyxu pre 7 scenárov (prichádzajúci, pauza, odchádzajúci, prepojenie, konzultácia,
  podržanie, čakáreň + prevzatie) × 3 režimy (bez stability, stabilita, contract 2):
  **21/21 zhodných** pred a po zmene.
- **Studený štart webhooku bez zmeny:** rovnakých 54 modulov (`webhook-import-graph`).
- `vitest` 5 116 passed; `typecheck`, `lint` (0 chýb), `build` OK.
- Playwright Ústredňa 41/43; 2 zlyhania (`callback-shared`, `eight operators … history space`)
  zlyhávajú rovnako na nezmenenom `dev`.
- Nové testy: `src/server/telephony/colleague-call.test.ts` (31, všetky tri režimy),
  model lišty, panel Operátori, prehliadačový telefón.

Bez migrácie a bez zmeny databázových funkcií.

## Živé overenie po nasadení (vlastník)

1. A (dostupný) volá B (dostupný): zazvoní B s menom A, prijať, počuť sa, B zloží → skončí obom.
2. B na pauze: zazvoní, prijať, po hovore je B stále na pauze.
3. B odmietne: volajúcemu hovor skončí.
4. B telefonuje so zákazníkom: tlačidlo je sivé s dôvodom.
5. Počas interného hovoru zavolá zákazník: zvoní ostatným, hovor sa nespomalí.

## Návrat späť

Revert PR bežnou cestou `dev` → `main` (nový deploy aktuálneho `main`, nikdy redeploy
staršieho). Dáta ani schéma sa nemenia; staré záznamy s `metadata.internal` ostávajú čitateľné.
