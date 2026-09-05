**Platené údaje slovenských vozidiel — overené verejné ponuky k 5. 9. 2026**

Platené API môže priniesť stabilný formát, ďalšie technické polia a podporu poskytovateľa. Pokrytie, aktualizácia a oprávnenie ukladať údaje sa musia overiť pri konkrétnom produkte. V tomto prieskume nebol zakúpený balík, vytvorený externý účet ani odoslaný obchodný dopyt. Žiadny nový poskytovateľ nie je zapojený do produkcie.

| Poskytovateľ | Verejná cena | Zmysel pre aplikáciu | Čo chýba pred rozhodnutím |
| --- | --- | --- | --- |
| [DatabázaVozidiel.sk](https://www.databazavozidiel.sk/) | 2 500 úspešných volaní: **19 €/mesiac**; 5 000: **29 €**; 10 000: **39 €**. Cenník sumy označuje „s DPH“. | Výslovne slovenské EČV/VIN, technické údaje, farba a dátumy prvej evidencie. | Skúšobné odpovede, vek záznamov a obchodné použitie. |
| [One Auto API — Slovensko](https://www.oneautoapi.com/pricing/sk/) | PrePay: úvodný kredit **29 €**, bez mesačného paušálu. VIN dekodér **0,18 €/volanie**, OE VIN Lookup Europe **0,36 €**; ceny bez príslušných daní. Business **29 €/mesiac + volania**, Enterprise **119 €/mesiac + volania**. | Kandidát na technické a výrobné údaje podľa VIN. | Slovenský cenník neuvádza EČV→VIN ani slovenské PZP/známku. Rozsah závisí od endpointu a značky. Sandbox nepreukazuje pokrytie skutočného VIN. |
| [SENTIA](https://www.sentia.sk/sk/sluzby/online-databaza-udajov-vozidiel) | Verejná cena API sa na stránke neuvádza; individuálny dopyt. | EČV/VIN a údaje z technického preukazu bez vlastníka/držiteľa. | Cena, skúšobný prístup, aktualizácia a podmienky ukladania. |
| [Cebia VINonline](https://www.cebianet.cz/pub/web/cs/Sluzby/Detail/vinonline) | Verejná cena VINonline API sa neuvádza; individuálny dopyt. | Technické údaje, prvá registrácia a ďalšie dáta podľa VIN. | Pokrytie slovenských vozidiel, skutočné polia a cena. |
| [STKonline](https://www.stkonline.sk/informacny-servis/faq) | API je uvedené vo FAQ, verejnú cenu API sa nepodarilo nájsť. | Priamy dátový prístup k poskytovateľovi, ktorého verejné údaje už aplikácia používa. | Dokumentácia, testovací kľúč, aktualizačný interval API a cena. |

DatabázaVozidiel.sk uvádza 100 bezplatných skúšobných vyhľadaní v systémovom rozhraní. [Registrácia](https://www.databazavozidiel.sk/register) vyžaduje firemné údaje a následné manuálne schválenie účtu. Verejný prieskum preto neoveril reálnu API odpoveď na referenčných vozidlách.

Pri tejto ponuke existuje konkrétny rozpor: propaguje firemné API pre weby, ale čl. III bod 8 [podmienok](https://www.databazavozidiel.sk/vseobecne-obchodne-podmienky) uvádza, že získané údaje nemôžu byť použité na komerčné účely. Pred nákupom treba písomne potvrdiť použitie v dispečingu, predvyplnenie formulárov a dlhodobé uloženie pri zásahoch/flotile. Podmienky navyše hovoria o neplatiteľovi DPH, zatiaľ čo cenník uvádza ceny s DPH; fakturačný režim treba potvrdiť. Cena ani počet záznamov nepreukazujú ich aktuálnosť.

Spotrebiteľské výpisy sa nemajú zamieňať za API cenník: [STKonline](https://www.stkonline.sk/cennik) uvádza webové balíky 7,90/12,90 € za vozidlo; [Cebia pre podnikateľov](https://sk.cebia.com/business) uvádza základné preverenie histórie od 10 € bez DPH. Ani jedno číslo nie je cenou ich identifikačného API.

Výpočet spotreby One Auto API: 100 VIN dekódovaní = 18 € kreditu, úvodná platba aspoň 29 €. Pri 1 000 dekódovaniach: PrePay 180 €, Business 29 + 110 = 139 €, bez daní. Ďalší endpoint sa účtuje osobitne.

**Odporúčaný pilot:** ako prvú lacnú možnosť preveriť DatabázaVozidiel.sk po vyjasnení obchodného použitia; paralelnou alternatívou je cenová ponuka SENTIA. Ak pokrytie alebo aktuálnosť nevyhovuje, porovnať STKonline a Cebia. One Auto API skúsiť pre konkrétne chýbajúce údaje podľa VIN, ktoré potvrdí ich dokumentácia a skúšobná odpoveď. Žiadna preskúmaná ponuka zatiaľ nepreukázala kompletné slovenské PZP, TK/EK a diaľničnú známku v jednom overenom rozhraní.

Pred zapojením požadovať reprezentatívnu vzorku vozidiel s nezávisle známymi údajmi. Overiť EČV→VIN aj opačný smer, zmenu EČV, nové vozidlo, EV/hybrid, dovoz a nákladné vozidlo; aktuálnosť po jednotlivých poliach; účtovanie prázdneho výsledku; limity; dostupnosť; možnosti uchovať historický výstup. Uloženie technických údajov musí zachovať zdroj a pôvodný dátum pozorovania.
