# Práca po hovore v mobile

V **Detaile hovoru** z Histórie je časť **Po hovore**. Rovnaké údaje používa web: poznámku vidí v detaile a histórii hovoru, pri priradenom prípade aj v jeho časovej osi.

## Výsledok hovoru

**Zapísať výsledok** ponúkne Dovolané, Nedovolané, Zavolať naspäť, Informačný hovor, Nesprávny kontakt a Prípad vytvorený, plus nepovinnú poznámku do 500 znakov. Výsledok sa uloží až po stlačení **Uložiť výsledok**; neskôr ho možno zmeniť.

Pri **Zavolať naspäť** zvolíte 15 min, 30 min, 1 h alebo 2 h. Ak je zapnutá fronta spätných volaní, požiadavka sa zaradí do **Spätných volaní** a pridelí sa vám. Inak sa k priradenému prípadu vytvorí úloha „Zavolať späť“ s termínom. Bez fronty aj bez prípadu by sa nič nenaplánovalo, preto aplikácia takéto uloženie nepovolí a vyzve na priradenie prípadu.

Každé uloženie má vlastnú identitu. Ak sa spojenie preruší, aplikácia zobrazí, že výsledok overuje, a načíta ho znova; opätovné uloženie rovnakého výsledku server nezapíše dvakrát. Úprava po neistom pokuse je novým zápisom.

## Priradenie k prípadu

**Priradiť k prípadu** ukáže návrhy podľa čísla volajúceho: prípady jeho kontaktu z adresára a prípady, ku ktorým bol priradený skorší hovor z rovnakého čísla. Otvorené sú prvé, uzavreté sivé. Ďalší otvorený prípad nájdete podľa čísla prípadu, mena alebo EČV. Priradenie vyžaduje potvrdenie a zapíše sa do časovej osi prípadu.

**Zmeniť priradený prípad** presunie hovor k inému prípadu. Server zmenu prijme iba vtedy, ak hovor stále patrí prípadu, ktorý ste videli; ak ho medzitým priradil kolega, zmenu odmietne a detail sa obnoví. Opakované priradenie k rovnakému prípadu nič nezmení.

Výsledok a priradenie sa týkajú záznamu v histórii hovorov. Pri vlastnom prebiehajúcom hovore z Ústredne sa časť zobrazí, keď sa hovor zapíše do histórie.

## Prístup a overenie

API vyžaduje používateľské Bearer prihlásenie a hlavičku očakávanej organizácie. Hovory aj prípady sú obmedzené na organizáciu prihláseného dispečera, rovnako ako webová história. Zápis používa existujúce serverové funkcie webu (výsledok, plánovanie spätného volania, priradenie, časová os, audit) s identitou skutočného dispečera a zdrojom `mobile_app`. Odpovede sú `private, no-store` bez nahrávok, poskytovateľských údajov a identifikátorov kontaktov.

Automatické testy pokrývajú autorizáciu, projekciu, opakovanie zápisu, plánovanie cez frontu aj úlohou, odmietnutie neplánovateľného spätného volania, podmienené presunutie priradenia a cudziu organizáciu. Kontrolovaný náhľad skutočného rozhrania s náhradnou sieťou overil hlavné postupy na šírke 390 a 320 bodov. Skúška s prihláseným dispečerom a skutočnými údajmi na iPhone zostáva.
