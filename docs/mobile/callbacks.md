# Spätné volania v mobile

V **Histórii** prepnite na **Spätné volania**. Rovnaký zoznam otvorí aj karta **Spätné volania** v **Ústredni**, ktorá ukazuje počet čakajúcich požiadaviek, nepridelené, vlastné, vyžiadané klientom a požiadavky po termíne.

Zoznam používa rovnakú frontu ako web. Najprv sú požiadavky, pri ktorých volajúci výslovne požiadal o spätné volanie, potom zmeškané hovory a ručne zadané požiadavky. Každá požiadavka je kompaktný riadok s menom alebo číslom, termínom sľúbeným volajúcemu (štandardne 30 minút), pôvodom, prevzatím a čakaním. Ťuk na riadok ho rozbalí: ukáže číslo, linku, posledné volanie, poznámku a tlačidlá úkonov. Naraz je rozbalený jeden riadok; počas úkonu alebo písania poznámky ostáva otvorený. Farba upozorní 15 minút pred termínom a po ňom. Filtre **Nepridelené**, **Moje** a **Vyžiadané** pôsobia na načítanú stranu; celkové počty počíta server. Uzavreté požiadavky za posledných 24 hodín možno zobraziť pod zoznamom.

## Úkony

- **Prevziať** pridelí voľnú požiadavku vám. Ak ju má kolega, bežný dispečer ju nemôže riešiť; senior dispečer, vedúci a administrátor ju môžu po potvrdení **Prevziať od kolegu**.
- **Vybavené** a **Zrušiť** otvoria nepovinnú poznámku (najviac 500 znakov). Požiadavka sa uzavrie až po stlačení **Potvrdiť vybavenie** alebo **Potvrdiť zrušenie**. Vybavenie zavrie aj súvisiacu úlohu „Zavolať späť“ rovnako ako na webe.
- **Zavolať späť** najprv overí číslo v adresári. Ak kontakt nechce spätné volania, hovor sa nezačne. Ak má overené náhradné číslo, aplikácia ho ukáže a vytočí ho až po potvrdení. Hovor ide cez existujúcu serverovú cestu spätného volania: požiadavku prevezme, prepojí s hovorom a ponechá ju otvorenú, kým ju neuzavriete.
- **Otvoriť prípad** otvorí prípad uložený pri požiadavke.

Zavolať späť je dostupné iba v natívnej aplikácii s pripojeným telefónom. V Expo Go môžete požiadavky prehliadať, prevziať a uzavrieť; tlačidlo volania zostáva neaktívne s vysvetlením.

Pri prerušenom spojení aplikácia úkon neopakuje. Zobrazí, že výsledok overuje, a načíta zoznam znova. Nepotvrdené spätné volanie sa v Ústredni dá zopakovať s rovnakou identitou alebo ukončiť, rovnako ako bežné volanie.

## Overené číslo pri bežnom volaní

Rovnaké overenie platí aj pre **Nový hovor** v Ústredni. Číslo bez obmedzenia sa vytočí hneď. Pri náhradnom čísle aplikácia vyžiada potvrdenie, pri zakázanom čísle hovor nezačne. Server rovnaké rozhodnutie overuje znova pri vytáčaní. Doteraz by sa také volanie z mobilu skončilo chybou bez možnosti potvrdenia.

V **Histórii hovorov** má zmeškaný hovor riadok so stavom jeho spätného volania, napríklad *Čaká na prevzatie* alebo *Prevzaté · meno dispečera*.

## Prístup a overenie

API vyžaduje používateľské Bearer prihlásenie. Zoznam, prevzatie a uzavretie vyžadujú aj hlavičku očakávanej organizácie; súhrnné počty sú obmedzené na organizáciu prihláseného dispečera. Odpovede sú `private, no-store` a neobsahujú metadáta relácie, poskytovateľa ani interné identifikátory kontaktov. Oprávnenia pre každú požiadavku počíta server rovnakými pravidlami ako web a mobil ich iba zobrazuje.

Volanie späť používa dedikovaný TEST natívny telefón s platnou reláciou zariadenia a existujúce kontroly vytáčania (limit, povolené čísla, overený cieľ, rezervácia). Prevzatie a uzavretie sú databázové úkony a fungujú aj bez živého poskytovateľa.

Automatické testy pokrývajú autorizáciu, projekciu, prevzatie, prevzatie od kolegu, uzavretie s poznámkou, počty, overenie cieľa, natívne spätné volanie a jeho zrušenie. Kontrolovaný náhľad skutočného rozhrania s náhradnou sieťou overil hlavné postupy na šírke 390 a 320 bodov. Skúška s prihláseným dispečerom, skutočnou frontou a fyzickým iPhonom zostáva samostatná; systémové volanie potrebuje podpísanú natívnu aplikáciu.
