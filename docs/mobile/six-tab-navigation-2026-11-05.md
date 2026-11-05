# Šesť položiek spodnej lišty · 5. 11. 2026

Majiteľ požiadal o **štyri vlastné moduly a dve pevné položky**. Lišta preto obsahuje `Prehľad · 4 vybrané moduly · Moduly`. Nové predvolené nastavenie dispečingu je Hovory, Prípady, Úlohy a Nástroje. Cez **Moduly → Upraviť lištu** sa vlastné položky pridávajú, vymieňajú a presúvajú; Prehľad a Moduly zostávajú na krajoch.

Skôr uložené tri moduly zostávajú v rovnakom poradí. Štvrtý sa pridá cez **Pridať** alebo úpravu lišty; vlastný výber sa neprepisuje. Piaty vlastný modul ponúkne výmenu existujúceho. Účet s menším počtom povolených modulov vidí iba svoju dostupnú kapacitu. Úprava navigácie nepridáva oprávnenia; každý modul a jeho API naďalej kontrolujú aktuálny serverový prístup.

Šesť skutočných dotykových plôch má pri šírke 320 b približne 47,7 b. Nulové vnútorné horizontálne odsadenie ponechá názvy čitateľné bez zmenšovania písma. Nad 1,1× sa viac ako tri položky usporiadajú do dvoch radov; šesť položiek má pri 2× výšku 190 b. Názvy tak nemusia lámať slová na jednotlivé písmená. Pri piatich položkách zostáva prázdne neinteraktívne miesto pred Modulmi, aby pevná položka ostala vpravo. Obsah, pás hovoru a toast používajú rovnakú skutočnú výšku lišty. Náhľad v karte Moja lišta využije širšiu vnútornú plochu.

## Overenie

- Všetkých **1 451 testov / 90 súborov** prešlo. Nové regresie chránia štyri vlastné položky, odmietnutie piatej, pevné kraje, poradie, uložené staršie voľby a geometriu pri väčšom písme.
- TypeScript, ESLint a iOS/Android exporty prešli bez zmeny závislostí.
- Existujúca vizuálna skúška redizajnu: **45 kontrol prešlo**.
- Nová skúška: **35 kontrol prešlo**. `node tests/mobile/ui-six-tabs-smoke.mjs` skúša skutočnú aplikáciu na 320/390/768 b, šesť dotykových plôch, pridanie, výmenu a poradie. Používa iba syntetický účet a blokuje vzdialené zápisy. Výstup je v `.context/mobile-six-tabs-qa/`.
- Browserová emulácia väčšieho písma nenahrádza natívny Dynamic Type, VoiceOver ani fyzické overenie iPhone.

## TEST odovzdanie

Zdroj UI je `dev` **`34af98b5f89774afa28c2cf6e182118a243d055f`**, zlúčený cez [PR #577](https://github.com/Alfopure/pomoc-motoristom-new/pull/577). Mobilný strom je `450ff0372be71ba1d1d4fab2daee84f50fecebfc`. Povinná Vercel brána aj mobilná CI prešli.

Stabilný [TEST](https://test.dispecing.linkapomoci.sk) používa tento zdroj v deploymente `dpl_EiCqTbNnBbumJyw4QJQwKHk9BjLA`, projekt `pomoc-motoristom-test`, región `fra1`. Dňa 5. 11. o **08:15:37 UTC** boli `/api/health/live` aj `/api/health/ready` dostupné s HTTP 200; live potvrdilo správny commit a prostredie `test`. Webové nasadenie samo neaktualizuje existujúcu natívnu aplikáciu.

**Nový iPhone náhľad:** [QR pre Expo Go](https://qr.expo.dev/eas-update?slug=exp&projectId=c7363382-9b12-4e12-9f62-31ec7b8c5623&groupId=fbe3719d-802e-45ff-a817-42f6230ce729) · [EAS Update skupina](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing/updates/fbe3719d-802e-45ff-a817-42f6230ce729), existujúca vetva `iphone-m1-test`, SDK 57, runtime `1.0.0`. Update `01a1aac8-09aa-7161-a5f7-3a64d96b5178` bol publikovaný o **08:16:38 UTC**. Otvoriť v kompatibilnom Expo Go SDK 57 s existujúcim Expo prístupom k projektu a prihlásiť sa TEST aplikačným účtom. Manifest aj spustiteľný balík boli overené cez HTTP 200; balík má **6 341 930 bajtov**, SHA-256 `83dc5573bd04fcdf487a44a33fa84ef67faf3eefc88f44945e7cb05f39887b1d`, zhodný s lokálnym exportom. Fyzický štart na iPhone zatiaľ overený nie je.

Go má samostatné balenie bez natívneho telefónu. Lokálny baliaci commit `e82653f9f5785ebfeb440528f48c00a3de985f60` mení iba dynamickú konfiguráciu na overený Go snapshot z rovnakého zdroja UI a nie je určený na zlúčenie. Natívna konfigurácia, hlasové brány, vzdialené premenné a vypnuté OTA zostávajú zachované.

**Natívny TEST 1.0.0 (35)** bol zostavený z rovnakého zdroja cez Xcode/SDK `iphoneos27.2` o **08:21:33 UTC**. Dňa 5. 11. o **08:32:18 UTC** prešlo všetkých **36 kontrol IPA** vrátane podpisu, TEST identity, scene lifecycle, zabudovaných TEST adries a vypnutých OTA. IPA má **21 475 969 bajtov**, SHA-256 `c03c91f02134c353a804fad4e6a200f154bda08b0cc32c0fe03b9195c41a2b08`. Zatiaľ nebola nahraná do TestFlightu. Natívny štart zostáva neoverený: iOS simulátor bol zablokovaný už pri štarte samotného systému. [Všeobecná startup brána](local-ios-build.md) zostáva zachovaná a výslovná výnimka pre build 34 sa automaticky neprenáša na build 35.

**Ako skúsiť:** Moduly → Upraviť lištu → pridať štvrtý vlastný modul; overiť poradie a prístup k poslednému ovládaču na obrazovke. Zväčšiť systémové písmo a porovnať usporiadanie. Existujúce tri voľby ostávajú zachované. Prístup ku všetkým modulom vyžaduje aktuálne oprávnenia konkrétneho TEST účtu; samotná nová lišta ich neudeľuje. Produkčné vydanie táto zmena neautorizuje.
