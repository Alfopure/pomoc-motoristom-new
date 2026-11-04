# Mobilný redizajn · 4. 11. 2026

## Rozsah a cieľ

Majiteľ požiadal o podrobný audit, výskum moderného mobilného UI, plán a realizáciu vrátane TEST vydania. Cieľ: rýchlejšie rozpoznanie ďalšieho kroku, čitateľné slovenské texty, pohodlné dotykové plochy, pružné rozloženie a jednotný systém pre všetky roly. Zachovať svetlý režim, značku, existujúce oprávnenia, údaje, rozpracované formuláre a hovory.

Východisko je `dev` `e0015cc`. Pred úpravami prešlo všetkých 1 433 mobilných testov (89 súborov). Existujúce testy chránia navigáciu, piny, obnovu konceptov, nejasné zápisy, hovory a izoláciu účtov. Zmena nepridáva závislosti ani databázové či provider operácie.

## Zistenia pri čítaní kódu

| Priorita | Dôkaz | Dopad a rozhodnutie |
| --- | --- | --- |
| Vysoká | `shell/home.tsx`: pevné 47 % karty, 12 b popisy, zmenšovanie hodnoty, upozornenia pod metrikami | Živý hovor, potom Treba riešiť, potom prehľad práce. Responzívne karty, celé popisy, samostatný stav telefónu. |
| Vysoká | `design/detail.tsx`: štyri akcie v jednom rade a zmenšovanie textu; ikonové akcie 36 b | Zalamovanie akcií podľa priestoru/písma, čitateľné textové popisy a minimálne 44 b ovládače. |
| Vysoká | `shell/parts.tsx`: segmenty 32 b, horné tlačidlá 40 b; sheet s dvoma pevnými 96 b stranami | Skutočná 44 b plocha, pružný segment, sheet s viditeľným názvom a zatvorením. |
| Vysoká | `shell/modules-screen.tsx`: štyri stĺpce, 11,5 b krátke názvy, veľká úprava lišty pred modulmi | Modul je hlavný obsah; čitateľná adaptívna mriežka s názvom a popisom, úprava lišty až po moduloch. |
| Stredná | `ui/theme.ts`: lišta rastie len do 1,3×; `tab-bar.tsx` zmenšuje písmo | Čitateľná dvojriadková položka, bezpečný priestor a obmedzená šírka na tablete. |
| Stredná | `design/list.tsx`: dostupný názov riadku vynecháva podnadpis | Zahrnúť relevantný obsah do VoiceOver názvu; nestrácať dôvody a termíny. |
| Stredná | `design/tokens.ts`: svetlé prázdne hodnoty, červený odznak s bielym textom, drobné tab label | Kontrastné významové tokeny; čitateľnosť overiť výpočtom aj vizuálne. |
| Stredná | `cases/overview.tsx`: štyri pevné stĺpce a zmenšované popisy; `work/ui-shared.tsx`: jednoriadkové úlohy | Adaptívny počet stĺpcov, celé názvy, termín na ďalší riadok pri veľkom písme. |
| Stredná | `shell/parts.tsx`: pohyb pri stlačení a toast nezohľadňuje Reduce Motion | Krátka zmena priehľadnosti, redukcia pohybu aj pre pomocné prvky. |

Toto sú dôkazy zo zdrojov; skutočné zariadenie, VoiceOver a natívne sklo potrebujú osobitnú skúšku. Predchádzajúci audit z 28. 10. ostáva platný pre funkčné scenáre terénu.

## Poradie realizácie

1. Preštudovať a zaznamenať najmenej 24 primárnych zdrojov; aktualizovať `DESIGN.md` a mobilný štandard.
2. Zjednotiť typografiu, kontrast, dotykové plochy, formuláre, riadky, detail a adaptívne pravidlá. Existujúce správanie pokrývajú regresné testy; pridať testy nových pravidiel rozloženia a kontrastu.
3. Prepracovať Prehľad, Moduly, hornú/spodnú navigáciu, segmenty a okná. Zachovať verejné props a navigačné modely.
4. Prejsť prihlasovanie, prípady, úlohy, upozornenia a terénne obrazovky; opraviť konkrétne problémy dlhých textov a stavov.
5. Overiť 320, 390, 768 b a zväčšené písmo, chybové/prázdne stavy, navigáciu, klávesnicu a okná na skutočných komponentoch so syntetickými údajmi. Snímky ukladať do `.context/`.
6. Mobilné testy, typy, lint, Expo kompatibilita, iOS/Android/web export. PR do `dev`, požadované existujúce kontroly a stabilný TEST. Natívna appka potrebuje nový build (OTA je vypnuté); webové nasadenie samo mobilný build neaktualizuje.

## Akceptácia

- Viditeľné, čitateľné názvy a aktuálna voľba v navigácii, žiadne stratené oprávnenia alebo koncepty.
- Bežné ovládače aspoň 44 × 44 b; obsah rastie s písmom a šírkou.
- Obsah nepriehľadný; Liquid Glass iba navigácia a ovládače, s existujúcou bezpečnou náhradou.
- Načítanie, prázdny výsledok, chyba, neistý zápis a zakázaná akcia zostávajú rozlíšené.
- Verejné zdroje a presné overenia sú doložené; simulované údaje sa nevydávajú za overenie živých integrácií.
- Produkčné vydanie nie je súčasťou tejto požiadavky; TEST vydanie používa existujúcu TEST aplikáciu a projekt.

## Realizované úpravy

Spoločná typografia a významové tóny sú čitateľnejšie; nové testy overujú kontrast deviatich rolí a adaptívne stĺpce. Detail má pomenované akcie a celé údaje, navigácia väčšie popisy, pružné rozloženie a zachovaný natívny sklenený renderer. Zjednotené sú aj hľadania, segmenty, filtre, úprava lišty a tlačidlá konceptov.

Prehľad uprednostňuje naliehavé veci, Moduly plné názvy a popisy. História vysvetľuje Zavolať/Vybrať číslo; prípady, úlohy a terén zalamujú dlhé názvy, stavy a termíny. Prihlásenie má kontrolu zobrazenia hesla. Súradnice majú stále viditeľné popisy. Terénne formuláre zohľadnia klávesnicu a mapa ustúpi počas písania dôvodu.

Opravený je aj falošný prázdny stav terénu/pobočky pri načítavaní alebo chybe. Obnova číta iba zdroje povolené danej role; vodič bez `deliver` nesmie vynútiť dopyt na pristavenia. Zachované sú existujúce modely hovorov, neistých zápisov a konceptov. Kódovou kontrolou prešlo ďalších 17 UI súborov a následne celý mobilný diff; opravená bola aj poloha docku v krajine.

## Reprodukovateľná vizuálna skúška

V samostatnom termináli spustiť z `mobile/`:

```sh
APP_VARIANT=test EXPO_PUBLIC_APP_ENV=test \
EXPO_PUBLIC_API_URL=https://test.dispecing.linkapomoci.sk \
EXPO_PUBLIC_SUPABASE_URL=https://nzpnqdstvkfncflgqlny.supabase.co \
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_visual_fixture \
npx expo start --web --port 8081 --host localhost
```

Z koreňa repozitára potom `node tests/mobile/ui-redesign-smoke.mjs`. Potrebuje nainštalovaný `agent-browser` a Chrome. Test používa skutočnú aplikáciu a komponenty, transport nahradí iba v izolovanom prehliadači syntetickými odpoveďami. Zakazuje všetky vzdialené zápisy a nevolá TEST databázu ani providerov. Overuje 320/390/768 b, skutočné rozmery ovládačov, navigáciu, hľadanie, detail, úlohy, chybu zdroja aj obnovu účtu vodiča bez oprávnenia na pristavenia. Výsledok a snímky sú v `.context/mobile-ui-qa/`.

Táto skúška nedokazuje natívne sklo, systémovú klávesnicu, VoiceOver/TalkBack, živý zvuk, doručenie pushov ani používateľskú akceptáciu. Na systémové písmo sa navyše vzťahujú adaptívne testy 1,5× a 2× a samostatná natívna skúška. Automatický webový audit zachytil aj existujúce nedostatky landmarkov v Expo web obálke; nejde o potvrdenie úplnej WCAG zhody.

## Lokálne výsledky · 4. 11. 2026

- 90 súborov / **1 444 testov prešlo**; pred úpravami 1 433.
- TypeScript, ESLint a `expo install --check` prešli bez zmeny závislostí.
- Exporty iOS a Android prešli; syntetické verejné hodnoty sa nepoužívajú na publikovanie.
- Vizuálny smoke test dokončený o **21:35:37 UTC: 45 kontrol prešlo**, vrátane rozmerov ovládačov, 320/390/768 b a regresie obnovy terénneho účtu.
- Snímky používajú syntetické údaje; nevydávajú sa za overenie živých klientskych dát alebo audio integrácie.

Stav vydania sa doplní po identifikovanom `dev` nasadení a overení konkrétneho natívneho TEST buildu. Produkcia nie je schválená týmto plánom.

## TEST odovzdanie · 4. 11. 2026

**Zdroj UI:** `dev` **`21d9b44847891a247bd447fc053be06937871bc3`**, zlúčený cez [PR #574](https://github.com/Alfopure/pomoc-motoristom-new/pull/574). Všetky kontroly PR prešli, vrátane mobilnej CI a požadovanej Vercel brány. Mobilný strom je `f9b1b9f2883f0ad9b26f54caf3795cdfc9c03501`.

**Stabilný TEST:** [test.dispecing.linkapomoci.sk](https://test.dispecing.linkapomoci.sk), projekt `pomoc-motoristom-test`, deployment `dpl_2KpXKPV2gYxLCNw8ZGv6zJTvbWBm`, `fra1`. Dňa 4. 11. o 21:48–21:49 UTC: `/api/health/live` 200 so správnym commitom a prostredím `test`, `/api/health/ready` 200, mobilné `/app-status` 200 s `environment=test`. Webový deployment nepotvrdzuje aktualizáciu existujúcej natívnej binárky.

**Publikovaný iPhone náhľad:** [EAS Update skupina](https://expo.dev/accounts/linkapomoci/projects/linka-pomoci-dispecing/updates/675052cd-0834-466e-a9ff-43c6039d7c92), existujúca vetva `iphone-m1-test`, SDK 57, runtime `1.0.0`, iOS update `01a1a893-fb33-7b0c-8f92-b5c312eb4e69`, publikované **22:00:32 UTC**. Otvoriť v kompatibilnom **Expo Go SDK 57**, prihlásenom do existujúceho Expo účtu s prístupom k projektu, a potom použiť TEST aplikačný účet. Overené je publikovanie, manifest 200 aj stiahnutie jeho spustiteľného balíka protokolovými hlavičkami Expo: **6 340 337 bajtov**, SHA-256 `9b9a98d309625b69c39905be7eddfad77f4490f813ab0a48b5f48d35be794568`, zhodný s lokálnym exportom. Spustenie tejto skupiny na fyzickom iPhone zatiaľ overené nie je.

Go náhľad má vlastné balenie bez natívneho telefónu. Existujúce EAS `preview` obsahuje hlasový prepínač pre natívne TEST buildy; pre Go bol preto z rovnakého pôvodného `app.config.ts` s explicitným `EXPO_PUBLIC_VOICE_PROOF=0` vytvorený a overený verejný konfiguračný snapshot. Predexportovaný balík sa publikoval cez podporované `--skip-bundler --environment preview`; vzdialené premenné sa nemenili. Samostatný lokálny baliaci commit `1e995d2e8b83e08766b084b90b28d0c66d6b69c9` mení iba dynamickú konfiguráciu na tento Go snapshot, nie zdroj UI. Nie je určený na zlúčenie do aplikácie. Natívny zdroj, hlasové brány a vypnuté OTA zostávajú zachované. [Expo SDK 57 Updates](https://docs.expo.dev/versions/v57.0.0/sdk/updates/), [premenné EAS](https://docs.expo.dev/eas/environment-variables/).

**TestFlight zostáva nedokončený:** na Macu bol spustený jediný lokálny TEST build zo zdroja `21d9b44`; EAS potvrdzuje rezervované číslo **1.0.0 (34)**. Nahratie sa nevykonalo. Nástroj `RunLocalCommand` pri následnej kontrole skončil `Timed out waiting for client`, takže stav výslednej IPA nie je potvrdený. Pred opakovaním zistiť existujúci stav; nespúšťať druhý build ani upload naslepo. Zdroj na Macu je `~/conductor/builds/dispatching-test/source-21d9b44`, vlastný pomocný skript `tooling/local-mac-build-redesign.mjs`, spúšťací log `tooling/build-launch-redesign.log`, supervisor PID 91441, výsledky pod `runs/21d9b448-*/`. Pomocný skript používa vlastný dočasný adresár a nemení zdieľanú cache ani ukazovateľ iných buildov.

Po obnovení spojenia pokračovať overením konkrétnej IPA, čerstvým Release simulátorom a existujúcim TEST upload postupom; až potom overiť Apple `VALID`, `IN_BETA_TESTING` a prístup existujúcej internej skupiny. Nepoužiť upload bez simulátorovej kontroly ani ďalších testerov. [Natívny postup](local-ios-build.md).

**Ako skúsiť dizajn:** Prehľad → Treba riešiť; Moduly → celý názov, popis a Možnosti; Prípady → detail a pomenované akcie; Moje úlohy → dlhý názov a termín. Overiť aj väčšie systémové písmo, klávesnicu vo formulári a poslednú akciu nad lištou. Natívne sklo, VoiceOver/TalkBack a živé audio potrebujú samostatnú fyzickú skúšku. Produkcia ostala bez zmeny.
