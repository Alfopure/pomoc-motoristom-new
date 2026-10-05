# Verzia aplikácie a obnovenie

Na mobile aj na počítači je pod hornou lištou viditeľné prostredie **TEST / PRODUKCIA**, dátum zostavenia a 12-znakový kód verzie. Rovnaký štítok je aj na hlavnej prihlasovacej obrazovke. Kliknutie alebo ťuknutie otvorí detail verzie načítanej v tomto zariadení a skrátený Git commit zostavy.

## Ako porovnať TEST s produkciou

Porovnáva sa **kód verzie**, nie dátum ani Git SHA. Vzniká automaticky pri zostavení ako skrátený SHA-256 z obsahu a názvov aplikačných súborov (`src`, `public`, `scripts`, hlavné build konfigurácie a dependency lockfile). Testy, dokumentácia, ostatné aplikácie v `apps`, Git história a hodnoty premenných prostredia sa doň nezapočítavajú. Nie je potrebné ručne zvyšovať číslo vydania.

- Rovnaký kód na TESTe a v produkcii znamená rovnaké započítané aplikačné súbory aj po merge alebo cherry-picku pod iným Git SHA.
- Rozdielny kód znamená rozdiel v aplikačných súboroch. TEST môže obsahovať ďalšie nevydané funkcie; neporovnávať len počty commitov.
- Dátum je dátum konkrétneho zostavenia v časovom pásme Europe/Bratislava. Neskoršie produkčné zostavenie toho istého kódu môže mať iný dátum.
- Rovnaký kód nezaručuje rovnaké nastavenia, databázovú schému, dáta ani dostupnosť externých integrácií. Každé prostredie ostáva samostatné.

V handoffe uviesť TEST URL, overený `dev` commit, kód verzie a konkrétny rozsah zmeny. Po schválenom produkčnom vydaní uviesť tiež produkčný commit a kód. Kód pomáha orientácii; nenahrádza kontrolu celého release diffu ani majiteľov súhlas podľa [release workflow](release-workflow.md).

`GET /api/health/live` bez cache vracia pôvodné `version` (identifikátor nasadenia) a navyše `release` s `environment`, `code`, `builtAt`, `commit` a `deployment`. Nasadenie sa naďalej dohľadáva vo Verceli podľa `version`. Zdrojový kód verzie je v build-time `NEXT_PUBLIC_APP_RELEASE_CODE`, čas zostavenia v `NEXT_PUBLIC_APP_BUILT_AT`; netreba pre ne nastavovať Vercel secrets.

## Nová verzia v otvorenej aplikácii

Mobilný prehliadač, nainštalovaná PWA aj desktop používajú rovnakú kontrolu. Pri otvorení, návrate do aplikácie (`visibilitychange`, `focus`, `pageshow`), obnovení internetu a každých päť minút vo viditeľnej aplikácii sa porovnáva načítané **nasadenie** s aktuálnym `/api/health/live`. Kontroly návratu majú 15-sekundové obmedzenie proti súbežným udalostiam. Kontrola identifikátora nasadenia odhalí aj nový build rovnakého kódu alebo návrat na staršie vydanie.

Pri rozdiele sa na mobile aj desktope zobrazí „Nová verzia je pripravená — Obnoviť“. Štítok sa neprepíše verziou nového servera, kým používateľ neobnoví celý dokument. Rozpracované prípady, poznámky a úlohy používajú existujúcu ochranu uloženia/zahodenia; obnovenie sa blokuje počas hovoru, ponuky, supervízie, pripájania a telefónnych operácií. Automatické obnovenie nie je zapnuté.

Je to upozornenie **v otvorenej aplikácii**, nie systémová push notifikácia pri vypnutej aplikácii. Mobilný OS môže aplikáciu na pozadí pozastaviť; kontrola preto prebehne po návrate. [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) popisuje viditeľnosť aj obmedzovanie časovačov na pozadí.

Fyzický iPhone/Android treba skontrolovať priamo: po uložení práce a skončení hovoru otvoriť kanonickú adresu prostredia, porovnať štítok, po novom nasadení aplikáciu opustiť a vrátiť sa, skúsiť „Obnoviť“. PWA nainštalovaná z nemennej Preview URL sleduje danú adresu, nie kanonický TEST alebo produkciu. Emulácia mobilného viewportu sama nepotvrdzuje stav konkrétnej používateľovej inštalácie.
