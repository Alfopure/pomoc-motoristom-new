# Klientsky HTML návod

Slovenská príručka obsahuje 23 kapitol: prvý prístup, obsluhu telefonovania, prácu s prípadmi, nastavenia ústredne, organizáciu prevádzky a riešenie problémov. Obsah v aplikácii aj samostatnom vydaní pochádza z jedného zdroja. Pôvodný návrh a ďalšie etapy sú v [pláne](client-guide-plan.md).

## Otvorenie a distribúcia

V aplikácii otvorte používateľský účet → **Návod**. Príručka sa otvorí na `/navod` v novej karte, aby zostalo zachované telefonovanie a rozpracovaný prípad. Záložky nastavení telefonovania majú aj odkaz **Návod k tejto časti**. Prihlásenie má verejnú pomoc na `/navod/prihlasenie`; ostatné kapitoly aj export API vyžadujú prihlásenie do aplikácie. Prihlásenie z odkazu na kapitolu zachová jej adresu aj kotvu postupu.

Samostatné vydanie vytvorí:

```bash
pnpm guide:export
# Voliteľne iný samostatný cieľový priečinok:
pnpm guide:export .context/navod-pre-klienta
```

Výsledkom je 24 HTML stránok, spoločné CSS/JavaScript, obrázky a `knowledge.json` v `.context/guide-standalone`. Otvorte `index.html` priamo v prehliadači alebo celý priečinok umiestnite na statický hosting. Pri odovzdaní ZIP archívu musí klient najskôr rozbaliť celý priečinok. Vyhľadávanie, navigácia a zväčšenie obrázkov fungujú aj bez internetu. Export obsahuje iba príručku s ukážkovými údajmi; nemá prihlásenie ani spojenie s klientskou databázou.

## Úprava textu a obrázkov

| Súbor | Úloha |
| --- | --- |
| `src/content/guide/chapters.ts` | Kategórie, základné kapitoly, telefonovanie, dátum, verzia obsahu a revízia overeného zdroja `GUIDE_SOURCE_REVISION`. |
| `src/content/guide/operations.ts` | Prevádzka, riešenie problémov, slovník a kontrolné zoznamy. |
| `src/content/guide/types.ts` | Spoločná štruktúra kapitol, krokov a obrázkov. |
| `src/content/guide/screenshots.json` | Popisy obrázkov, percentuálne súradnice zvýraznení a pôvod snímok. |
| `public/guide-assets/` | Skutočné snímky rozhrania vo WebP. |
| `src/components/guide/` | Spoločné rozhranie, vyhľadávanie, anotácie a responzívny vzhľad. |
| `scripts/guide/` a `scripts/export-guide.mjs` | Statické vykreslenie a interaktivita samostatného vydania. |

Pri doplnení postupu zachovajte existujúce `slug` a identifikátory sekcií/krokov: používajú ich priame odkazy a budúce citácie AI. Nová kapitola potrebuje opis, publikum, kľúčové slová, predpoklady, súvisiace kapitoly a odkazy na overený zdroj aplikácie. Presné názvy tlačidiel overte v rozhraní. Príklad nastavenia vždy označte ako príklad. Po vecnej aktualizácii zmeňte verziu/dátum a revíziu overených zdrojov v exporte.

Snímky vznikajú z reálnych React komponentov a aplikačného CSS s tréningovými údajmi:

```bash
pnpm guide:capture
# Obnovenie vybraných snímok:
pnpm guide:capture groups ring-plans
```

Zachytávanie používa lokálny Chrome na `/usr/bin/google-chrome`; inú cestu nastavte cez `GUIDE_CHROME_PATH`. Scenáre a kliknutia sú v `scripts/capture-guide-screenshots.mjs`, údaje v `e2e/fixtures/guide-application.tsx`. Skript nepotrebuje server aplikácie ani prihlasovacie údaje. Zachytáva všetky požiadavky, odmieta zápisy, blokuje externé HTTP aj WebSockety a kontroluje chyby. Report ostáva v `.context/guide-capture`.

Všetkých 28 snímok používa ukážkové mená, čísla, prípady a stavy. Číslované zvýraznenia sú samostatné HTML/CSS vrstvy nad obrázkom, takže ostávajú ostré pri zväčšení. Polohu určujú percentá, legendu možno ovládať klávesnicou a obrázok má textový opis. Úprava zvýraznenia nevyžaduje prekresľovať snímku. Po aktualizácii skontrolujte aj obrázok na mobile a zväčšený náhľad.

Obsah bol overený podľa zdrojového kódu a izolovaného rozhrania. Výroba príručky neoveruje živé hovory, zvuk v konkrétnom prehliadači ani uložené nastavenia organizácie. Klientske kontrolné zoznamy opisujú, čo má oprávnený človek následne v prevádzke overiť.

## Príprava pre AI pomocníka

`buildGuideKnowledge` v `src/content/guide/knowledge.ts` vytvára 123 záznamov po sekciách z presne toho istého obsahu, ktorý čitateľ vidí. Každý záznam obsahuje stabilné ID, odkaz na sekciu, kroky s odkazmi, publikum, predpoklady, text, kľúčové slová a význam screenshotov. Celý dokument má verziu schémy a obsahu, dátum, revíziu overeného zdroja a `dataKind: documentation`.

V aplikácii poskytuje tieto údaje autentifikované `GET /api/guide/knowledge` s `Cache-Control: private, no-store`. Samostatné vydanie obsahuje rovnaký export v `knowledge.json`. Hodnota `audience` pomáha vysvetľovať potrebné roly; nie je náhradou serverovej autorizácie akcie. Tento export neobsahuje aktuálne nastavenia ani stav používateľov.

Budúci chatbot môže nad dokumentáciou vyhľadávať a odpovedať s odkazmi. Aktuálne uložené nastavenia a prevádzkový stav budú samostatné, autorizované čítacie zdroje s časom overenia. Už existujúci `GET /api/telephony/calls/active` nie je vhodný čítací nástroj pre AI: spúšťa aj údržbu stavu. Budúci adaptér musí byť bez vedľajších účinkov a dodržať rolu aj organizáciu prihláseného používateľa. Podrobnosti a akceptačné scenáre sú v [pláne AI](client-guide-plan.md#12-príprava-pre-budúceho-ai-pomocníka).

Chatbot ani prístup AI k živým údajom nie sú súčasťou tejto verzie. Neskorší skrátený návod môže vyberať existujúce stabilné ID krokov bez druhej kópie textu.

## Overenie zmeny

```bash
pnpm exec vitest run
pnpm typecheck
pnpm build
pnpm exec playwright test e2e/client-guide.spec.ts e2e/guide-entry.spec.ts
pnpm guide:export
```

Playwright používa lokálnu testovaciu aplikáciu s vývojovým prístupom podľa existujúceho `playwright.config.ts`; testy návodu nespúšťajte proti nasadeniu so živými údajmi. Test vstupu do návodu používa úplne izolovanú konzolu. Testy kontrolujú integritu odkazov a obrázkov, textový export, ochranu prístupu, návrat po prihlásení, vyhľadávanie, všetky kapitoly, mobilné zobrazenie a zachovanie rozpracovaného prípadu pri otvorení návodu.

Pred odovzdaním otvorte aj export cez `file://`, vyskúšajte vyhľadanie „prestavka“, odkaz na krok, zväčšenie screenshotu a návrat cez Escape. Nasadenie príručky používa rovnaký [dev-first postup](../CONTRIBUTING.md) ako aplikácia.
